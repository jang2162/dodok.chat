/** 푸시 구독 저장(스펙 5.1)·발송(5.4)·버스 배선 */
import type { PushSubscriptionInput } from "@dodok/shared";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import webpush from "web-push";
import { session } from "../../db/auth-schema";
import type { Db, DbOrTx } from "../../db/client";
import { agents, memberships, pushSubscriptions, users } from "../../db/schema.sqlite";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { channelParticipants, getChannel } from "../channels/service";
import type { Presence } from "./presence";
import { type PushTarget, type TriggerLookups, targetsForApproval, targetsForMessage } from "./triggers";

/**
 * endpoint 로 upsert. 이미 다른 사용자에게 묶여 있으면 지금 사용자로 옮긴다 — 같은 브라우저에서 사람이 바뀌면
 * 앞 사람에게 뒷사람의 알림이 가지 않게(Review Focus 1). 등록한 세션도 지금 세션으로 옮긴다 — 구독은 그 세션이 사는 동안만
 * 쓰인다(스키마 pushSubscriptions 주석). 행 id 는 처음 것을 그대로 둔다
 */
export function upsertSubscription(
  db: DbOrTx,
  owner: { userId: string; sessionId: string },
  input: PushSubscriptionInput,
  userAgent?: string,
): void {
  const { userId, sessionId } = owner;
  const now = new Date();
  const userAgentValue = userAgent ?? null;
  db.insert(pushSubscriptions)
    .values({
      id: uuidv7(),
      userId,
      sessionId,
      endpoint: input.endpoint,
      keys: input.keys,
      userAgent: userAgentValue,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, sessionId, keys: input.keys, userAgent: userAgentValue, createdAt: now },
    })
    .run();
}

/** 세션 사용자의 것만 지운다 — 남의 endpoint·없는 endpoint 는 아무 일도 없다(멱등) */
export function removeSubscription(db: DbOrTx, userId: string, endpoint: string): void {
  db.delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .run();
}

/**
 * 발송 대상 — 등록한 세션이 아직 만료 전인 구독만. 만료 세션 행은 청소(sweepExpiredSessions)가 지울 때 구독도 함께 지워지지만,
 * 청소 주기 사이에도 만료된 세션의 기기로는 보내지 않는다
 */
export function listSubscriptions(
  db: DbOrTx,
  userId: string,
  now: Date = new Date(),
): Array<{ id: string; endpoint: string; keys: { p256dh: string; auth: string } }> {
  return db
    .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, keys: pushSubscriptions.keys })
    .from(pushSubscriptions)
    .innerJoin(session, eq(session.id, pushSubscriptions.sessionId))
    .where(and(eq(pushSubscriptions.userId, userId), gt(session.expiresAt, now)))
    .all();
}

/** 발송이 404·410 을 받았을 때 그 구독 하나를 지운다 */
export function deleteSubscriptionById(db: DbOrTx, id: string): void {
  db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run();
}

/** 푸시 서비스가 보관하는 시간(초). 한 시간 넘게 꺼져 있던 기기에는 지난 알림을 띄우지 않는다 */
export const PUSH_TTL_SECONDS = 3600;
/** 한 번의 발송 요청 상한 — 응답 없는 푸시 서비스가 소켓을 붙잡지 않게 */
export const PUSH_SEND_TIMEOUT_MS = 10_000;
/** 로그에 싣는 사유 문자열 상한 */
const REASON_MAX = 200;

export type PushSend = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  body: string,
  opts: { TTL: number; urgency: "high" | "normal"; topic: string },
) => Promise<{ statusCode: number }>;

/** 알림 tag → Topic 헤더(32자 이하 url-safe base64, RFC 8030 5.4). 같은 tag 의 아직 안 간 알림을 푸시 서비스가 바꿔 끼운다 */
export function pushTopic(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

/** 실제 발송기 — `AppDeps.pushSend` 가 없을 때. 2xx 가 아닌 응답(WebPushError)은 statusCode 로 바꾸고, 그 밖(네트워크)은 던진다 */
export function webPushSender(vapid: { subject: string; publicKey: string; privateKey: string }): PushSend {
  return async (sub, body, opts) => {
    try {
      const r = await webpush.sendNotification(sub, body, {
        ...opts,
        vapidDetails: vapid,
        timeout: PUSH_SEND_TIMEOUT_MS,
      });
      return { statusCode: r.statusCode };
    } catch (err) {
      if (err instanceof webpush.WebPushError) return { statusCode: err.statusCode };
      throw err;
    }
  };
}

export type PushDispatcher = {
  /** 던지지 않는다 — 실패는 로그로만 남긴다. 버스 처리기는 기다리지 않는다(void) */
  dispatch(targets: PushTarget[]): Promise<void>;
  /** 진행 중인 발송을 최대 timeoutMs 기다린다(앱 종료 — db 를 닫기 전에) */
  drain(timeoutMs: number): Promise<void>;
};

/**
 * 받는 사람마다: 그 채널을 보고 있으면 건너뛰고(스펙 5.3), 아니면 구독마다 보낸다(사용자·구독 병렬, 재시도 없음).
 * 결과: 2xx → debug · 404·410 → 구독 삭제 · 400·403·413 → error(페이로드·VAPID 버그 — 구독은 그대로) · 그 밖·던짐 → warn.
 * 거르면 debug 한 줄 — 실연이 「걸렀다·보냈다·보냈는데 안 왔다」를 서버 로그로 가르게(p4-c1, LOG_LEVEL=debug 일 때만).
 * 로그에는 userId·채널 id·구독 id·kind·statusCode·짧은 사유만 싣는다 — endpoint·keys·페이로드 본문·오류 객체는 싣지 않는다(리뷰 D6)
 */
export function createPushDispatcher(deps: {
  db: Db;
  logger: Pick<Logger, "debug" | "info" | "warn" | "error">;
  send: PushSend;
  presence: Pick<Presence, "isWatching">;
}): PushDispatcher {
  const { db, logger, send, presence } = deps;
  const inflight = new Set<Promise<void>>();

  const sendOne = async (
    target: PushTarget,
    sub: { id: string; endpoint: string; keys: { p256dh: string; auth: string } },
    body: string,
  ): Promise<void> => {
    const { userId, payload } = target;
    const ctx = { userId, subscriptionId: sub.id, kind: payload.kind };
    let statusCode: number;
    try {
      ({ statusCode } = await send({ endpoint: sub.endpoint, keys: sub.keys }, body, {
        TTL: PUSH_TTL_SECONDS,
        urgency: payload.kind === "approval" ? "high" : "normal",
        topic: pushTopic(payload.tag),
      }));
    } catch (err) {
      logger.warn({ ...ctx, reason: shortReason(err) }, "push send failed");
      return;
    }
    if (statusCode >= 200 && statusCode < 300) {
      logger.debug({ ...ctx, statusCode }, "push sent");
      return;
    }
    if (statusCode === 404 || statusCode === 410) {
      deleteSubscriptionById(db, sub.id);
      logger.info({ ...ctx, statusCode }, "push subscription gone — removed");
    } else if (statusCode === 400 || statusCode === 403 || statusCode === 413) {
      // 403 은 VAPID 주체·키 문제(Apple 의 BadJwtToken 등) — 구독 탓이 아니라 지우지 않는다
      logger.error({ ...ctx, statusCode }, "push rejected");
    } else {
      logger.warn({ ...ctx, statusCode }, "push send failed");
    }
  };

  const forUser = async (target: PushTarget): Promise<void> => {
    if (presence.isWatching(target.userId, target.payload.channelId)) {
      const { channelId, kind } = target.payload;
      logger.debug({ userId: target.userId, channelId, kind }, "push skipped — watching");
      return;
    }
    const subs = listSubscriptions(db, target.userId);
    const body = JSON.stringify(target.payload);
    await Promise.all(subs.map((sub) => sendOne(target, sub, body)));
  };

  const run = async (targets: PushTarget[]): Promise<void> => {
    await Promise.all(
      targets.map((t) =>
        forUser(t).catch((err: unknown) =>
          logger.error(
            { userId: t.userId, kind: t.payload.kind, reason: shortReason(err) },
            "push dispatch failed",
          ),
        ),
      ),
    );
  };

  return {
    dispatch(targets) {
      if (targets.length === 0) return Promise.resolve();
      const work = run(targets).finally(() => inflight.delete(work));
      inflight.add(work);
      return work;
    },
    async drain(timeoutMs) {
      if (inflight.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      });
      await Promise.race([Promise.all(inflight), deadline]).finally(() => clearTimeout(timer));
    },
  };
}

/** 오류를 통째로 싣지 않는다 — 이름·메시지만, 상한까지 */
function shortReason(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}

/** 트리거가 부르는 이름 풀기 — DB 에서 매번 읽는다(이벤트마다 몇 줄) */
export function createTriggerLookups(db: DbOrTx, workspaceId: string): TriggerLookups {
  return {
    channelName: (id) => getChannel(db, id, workspaceId)?.name,
    userHandle: (id) => db.select({ handle: users.handle }).from(users).where(eq(users.id, id)).get()?.handle,
    agentHandle: (id) =>
      db.select({ handle: agents.handle }).from(agents).where(eq(agents.id, id)).get()?.handle,
    humanMembers: (channelId) =>
      channelParticipants(db, channelId)
        .filter((p) => p.type === "user")
        .map((p) => p.id),
    admins: () =>
      db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            inArray(memberships.role, ["owner", "admin"]),
            isNull(memberships.deactivatedAt),
          ),
        )
        .all()
        .map((row) => row.userId),
  };
}

/** 같은 승인이 버스에 두 번 실린다(두 프레임 병합, approvals/service `announce:false`) — 이만큼 최근 id 를 기억해 한 번만 보낸다 */
const SEEN_APPROVALS_MAX = 1000;

/**
 * 버스 → 트리거 → 발송. 발송은 기다리지 않는다(void) — 버스를 부른 쓰기 경로를 막지 않는다.
 * 트리거 계산이 던져도 버스로 번지지 않게 가둔다
 */
export function attachPushTriggers(
  bus: ServerBus,
  dispatcher: Pick<PushDispatcher, "dispatch">,
  lookups: TriggerLookups,
  logger: Pick<Logger, "error">,
): { close(): void } {
  const seenApprovals = new Set<string>();
  const guard = (event: string, targets: () => PushTarget[]) => {
    try {
      void dispatcher.dispatch(targets());
    } catch (err) {
      logger.error({ event, reason: shortReason(err) }, "push trigger failed");
    }
  };
  const offs = [
    bus.on("message.created", ({ message, silent }) => {
      if (silent) return;
      guard("message.created", () => targetsForMessage(message, lookups));
    }),
    bus.on("approval.requested", ({ approval }) => {
      if (seenApprovals.has(approval.id)) return;
      seenApprovals.add(approval.id);
      if (seenApprovals.size > SEEN_APPROVALS_MAX) {
        const oldest = seenApprovals.values().next().value;
        if (oldest !== undefined) seenApprovals.delete(oldest);
      }
      guard("approval.requested", () => targetsForApproval(approval, lookups));
    }),
  ];
  return {
    close() {
      for (const off of offs.splice(0)) off();
    },
  };
}
