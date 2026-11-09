/** 푸시 구독 저장(스펙 5.1)·발송(5.4)·버스 배선 */
import type { PushCapabilities, PushSubscriptionInput } from "@dodok/shared";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { session } from "../../db/auth-schema";
import type { Db, DbOrTx } from "../../db/client";
import { agents, automations, channels, memberships, pushSubscriptions, users } from "../../db/schema.sqlite";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { channelParticipants, getChannel, isChannelArchived } from "../channels/service";
import type { OpsService } from "../ops/service";
import { deleteDeviceById, listDevices } from "./devices";
import type { Presence } from "./presence";
import type {
  DeviceTarget,
  PushNotification,
  PushTransports,
  TransportResult,
  WebTarget,
} from "./transports/types";
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

/** 푸시 서비스가 보관하는 시간(초). 한 시간 넘게 꺼져 있던 기기에는 지난 알림을 띄우지 않는다 — 통로마다 같은 값을 쓴다 */
export const PUSH_TTL_SECONDS = 3600;
/** 한 번의 발송 요청 상한 — 응답 없는 푸시 서비스가 소켓을 붙잡지 않게. 통로마다 같은 값을 쓴다 */
export const PUSH_SEND_TIMEOUT_MS = 10_000;
/** 로그에 싣는 사유 문자열 상한 */
const REASON_MAX = 200;

/**
 * 알림 tag → 접기 키(32자 이하 url-safe base64 — 웹 푸시 Topic 헤더, RFC 8030 5.4). 같은 tag 의 아직 안 간 알림을
 * 푸시 서비스가 바꿔 끼운다. 네이티브 통로의 접기 키(APNs collapse-id·FCM collapse_key)도 이 값이다
 */
export function pushTopic(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

/** 켜진 통로 → `GET /push/capabilities`. 꺼진 플랫폼의 기기 등록은 PUSH_UNAVAILABLE 이 된다 */
export function pushCapabilities(transports: PushTransports): PushCapabilities {
  return {
    webpush: transports.webpush !== undefined,
    ios: transports.apns !== undefined,
    android: transports.fcm !== undefined,
  };
}

export type PushDispatcher = {
  /** 던지지 않는다 — 실패는 로그로만 남긴다. 버스 처리기는 기다리지 않는다(void) */
  dispatch(targets: PushTarget[]): Promise<void>;
  /** 진행 중인 발송을 최대 timeoutMs 기다린다(앱 종료 — db 를 닫기 전에) */
  drain(timeoutMs: number): Promise<void>;
};

/** 기기 플랫폼 → 통로 */
const DEVICE_TRANSPORT = { ios: "apns", android: "fcm" } as const;

/**
 * 받는 사람마다: 그 채널을 보고 있으면 건너뛰고(스펙 5.3), 아니면 웹 구독과 기기마다 그 통로로 보낸다(사용자·대상 병렬, 재시도 없음).
 * 결과 처리는 TransportResult 주석. 그 플랫폼 통로가 꺼져 있는데 기기 행이 남아 있으면 건너뛰고 debug.
 * 거르면 debug 한 줄 — 실연이 「걸렀다·보냈다·보냈는데 안 왔다」를 서버 로그로 가르게(p4-c1, LOG_LEVEL=debug 일 때만).
 * 로그에는 userId·채널 id·구독 id 또는 기기 id·통로·kind·결과·짧은 사유만 싣는다 — endpoint·keys·기기 토큰·페이로드 본문·
 * 오류 객체는 싣지 않는다(리뷰 D6)
 */
export function createPushDispatcher(deps: {
  db: Db;
  logger: Pick<Logger, "debug" | "info" | "warn" | "error">;
  transports: PushTransports;
  presence: Pick<Presence, "isWatching">;
  /** 방해 금지(프로필 스펙 3.5) — 접속과 상관없다. 만료가 지났으면 active 가 아니다(profile/status.ts dndState) */
  dnd: (userId: string) => { active: boolean; allowApprovals: boolean };
  ops: Pick<OpsService, "record">;
}): PushDispatcher {
  const { db, logger, transports, presence, ops } = deps;
  const inflight = new Set<Promise<void>>();

  const sendOne = async (
    userId: string,
    target: WebTarget | DeviceTarget,
    n: PushNotification,
  ): Promise<void> => {
    const transport =
      target.kind === "web" ? transports.webpush : transports[DEVICE_TRANSPORT[target.platform]];
    const ctx =
      target.kind === "web"
        ? { userId, subscriptionId: target.id, kind: n.payload.kind }
        : { userId, deviceId: target.id, kind: n.payload.kind };
    if (transport === undefined) {
      logger.debug(ctx, "push skipped — transport off");
      return;
    }
    const at = { ...ctx, transport: transport.kind };
    let result: TransportResult;
    try {
      result = await transport.send(target, n);
    } catch (err) {
      logger.warn({ ...at, reason: shortReason(err) }, "push send failed");
      return;
    }
    switch (result) {
      case "ok":
        logger.debug({ ...at, result }, "push sent");
        return;
      case "gone":
        if (target.kind === "web") {
          deleteSubscriptionById(db, target.id);
          logger.info({ ...at, result }, "push subscription gone — removed");
        } else {
          deleteDeviceById(db, target.id);
          logger.info({ ...at, result }, "push device gone — removed");
        }
        return;
      case "rejected":
        logger.error({ ...at, result }, "push rejected");
        return;
      case "credentials":
        // 키가 폐기·만료된 것 — 기기 탓이 아니라 행은 둔다. 같은 통로의 사건은 운영 사건 묶기 규칙으로 한 줄이 된다
        logger.error({ ...at, result }, "push credentials rejected");
        ops.record({ kind: "push_credentials_invalid", key: `push:${transport.kind}`, severity: "error" });
        return;
      case "retry":
        logger.warn({ ...at, result }, "push send failed");
        return;
    }
  };

  const forUser = async (target: PushTarget): Promise<void> => {
    const { userId, conversationId, payload } = target;
    if (presence.isWatching(userId, conversationId)) {
      logger.debug(
        { userId, channelId: payload.channelId, conversationId, kind: payload.kind },
        "push skipped — watching",
      );
      return;
    }
    // 멈추는 것은 푸시뿐 — 배지·타임라인·앱 안 승인 알림은 그대로다. 승인은 옵션이 켜져 있으면 보낸다(놓치면 런이 멈춰 기다린다)
    const dnd = deps.dnd(userId);
    if (dnd.active && !(payload.kind === "approval" && dnd.allowApprovals)) {
      logger.debug(
        { userId, channelId: payload.channelId, conversationId, kind: payload.kind },
        "push skipped — dnd",
      );
      return;
    }
    const n: PushNotification = { payload, urgency: payload.kind === "approval" ? "high" : "normal" };
    const webTargets = listSubscriptions(db, userId).map((s): WebTarget => ({ kind: "web", ...s }));
    const deviceTargets = listDevices(db, userId).map((d): DeviceTarget => ({
      kind: "device",
      id: d.id,
      platform: d.platform,
      token: d.token,
      appId: d.appId,
      ...(d.environment === null ? {} : { environment: d.environment }),
    }));
    await Promise.all([...webTargets, ...deviceTargets].map((t) => sendOne(userId, t, n)));
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

/** 트리거가 부르는 풀기 + 발송 직전 거름(attachPushTriggers)만 쓰는 풀기 */
export type PushLookups = TriggerLookups & {
  /**
   * 참여자만 읽는 채널(direct)이면 비활성이 아닌 사람 참여자 id, 모르는 kind 면 [](아무도), 일반 채널·DM·없는 채널이면 null(그 판정은 다른
   * 거름이 한다) — 사람 간 DM 스펙 7.1 의 「발송 직전 거름」
   */
  directParticipants(channelId: string): string[] | null;
};

/** 트리거가 부르는 이름 풀기 — DB 에서 매번 읽는다(이벤트마다 몇 줄) */
export function createTriggerLookups(db: DbOrTx, workspaceId: string): PushLookups {
  return {
    channelName: (id) => getChannel(db, id, workspaceId)?.name,
    userHandle: (id) => db.select({ handle: users.handle }).from(users).where(eq(users.id, id)).get()?.handle,
    agentHandle: (id) =>
      db.select({ handle: agents.handle }).from(agents).where(eq(agents.id, id)).get()?.handle,
    automationName: (id) =>
      db
        .select({ name: automations.name })
        .from(automations)
        .where(and(eq(automations.id, id), eq(automations.workspaceId, workspaceId)))
        .get()?.name,
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
    channelArchived: (id) => isChannelArchived(db, id),
    dmOwner: (id) => {
      const channel = getChannel(db, id, workspaceId);
      return channel?.kind === "dm" ? (channel.dmOwnerId ?? "") : null;
    },
    dmAgent: (id) => {
      const channel = getChannel(db, id, workspaceId);
      return channel?.kind === "dm" ? channel.dmAgentId : null;
    },
    directParticipants: (id) => {
      // kind 는 행에서 바로 읽는다 — getChannel 은 모르는 kind 의 행에서 던진다
      const row = db
        .select({ kind: channels.kind })
        .from(channels)
        .where(and(eq(channels.id, id), eq(channels.workspaceId, workspaceId)))
        .get();
      if (row === undefined || row.kind === "channel" || row.kind === "dm") return null;
      if (row.kind !== "direct") return [];
      return channelParticipants(db, id)
        .filter((p) => p.type === "user")
        .map((p) => p.id);
    },
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
  lookups: PushLookups,
  logger: Pick<Logger, "error">,
): { close(): void } {
  const seenApprovals = new Set<string>();
  // 보관한 채널을 겨눈 알림은 트리거마다 따로 보지 않고 여기서 한 번 거른다 — 정본·승인이 보관과 엇갈려 와도 사람을 부르지 않게.
  // DM 을 겨눈 알림도 여기서 주인 말고는 모두 걷는다 — 어느 트리거 갈래가 받을 사람을 잘못 골라도 남에게 DM 이 드러나지 않게(PD7).
  // direct 는 사람 참여자 말고 모두, 모르는 kind 는 모두 걷는다(사람 간 DM 스펙 7.1)
  const reachable = (t: PushTarget) => {
    const owner = lookups.dmOwner(t.payload.channelId);
    if (owner !== null) return owner === t.userId;
    const participants = lookups.directParticipants(t.payload.channelId);
    return participants === null || participants.includes(t.userId);
  };
  const guard = (event: string, targets: () => PushTarget[]) => {
    try {
      void dispatcher.dispatch(
        targets().filter((t) => !lookups.channelArchived(t.payload.channelId) && reachable(t)),
      );
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
