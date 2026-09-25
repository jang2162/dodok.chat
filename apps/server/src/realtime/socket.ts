import {
  type ApiError,
  ApprovalResolve,
  ChannelSubscribe,
  ComponentInteract,
  Id,
  type Message,
  MessageSend,
  PresenceUpdate,
  type Result,
  RunAbort,
  RunEventsReplay,
  Typing,
  WIRE_PROTOCOL,
} from "@dodok/shared";
import { z } from "zod";
import { type Auth, verifySessionToken } from "../auth";
import type { Db } from "../db/client";
import { apiError, HttpError } from "../http/errors";
import { parsePayload } from "../http/validate";
import type { Logger } from "../logger";
import { getChannel } from "../modules/channels/service";
import { ipPrefix } from "../modules/ops/ip";
import { LIMITS, type Limits } from "../modules/ops/limits";
import { monotonicNow, TokenBucket } from "../modules/ops/ratelimit";
import type { OpsService } from "../modules/ops/service";
import type { Presence } from "../modules/push/presence";
import {
  createUserMessage,
  findUserMessage,
  listMessages,
  MESSAGE_PAGE_MAX,
  threadRootsOf,
} from "../modules/messages/service";
import type { ServerBus } from "./bus";
import { cookieSessionToken } from "./cookie-auth";
import type { RunsFacade, WireServer } from "./types";

export type WireContext = {
  auth: Auth;
  db: Db;
  bus: ServerBus;
  logger: Logger;
  workspaceId: string;
  /** 새로 저장한 사람 메시지를 라우터로 넘긴다 — ack 뒤에 부르고 예외는 로그만 남긴다 */
  route: (message: Message) => Promise<void>;
  /** 없으면 런 핸들러는 ADAPTER_UNAVAILABLE */
  runs: RunsFacade | null;
  /** 쿠키 인증을 받을 출처(APP_ORIGIN). 핸드셰이크 Origin 이 같을 때만 쿠키를 읽는다 */
  appOrigin: string;
  /** 푸시 거르기(스펙 5.3) — 소켓별 「보이는가·보는 채널」. 없으면 presence.update 를 버린다 */
  presence?: Pick<Presence, "set" | "drop">;
  /** wire 레이트리밋(운영 보강 스펙 4.2). 없으면 LIMITS */
  limits?: Pick<Limits, "wire" | "socketsPerUser">;
  /** 버킷의 시계(ms) — 테스트 주입. 기본 단조 시계(monotonicNow) */
  now?: () => number;
  /** 레이트리밋에 걸리면 ratelimit 사건을 남긴다 */
  ops?: Pick<OpsService, "record">;
  /** 사건 detail.ipPrefix 의 주소. 기본 handshake.address — 프록시 뒤면 app.ts 가 TRUST_PROXY 를 따르는 함수를 준다 */
  clientAddress?: (handshake: {
    address: string;
    headers: Record<string, string | string[] | undefined>;
  }) => string;
};

/** wire 이벤트 → 소켓 버킷(스펙 4.2 표, run.events.replay 만 자기 버킷 — limits.ts). 여기 없는 이벤트(구독·구독 해제)는 상한이 없다 */
export const WIRE_BUCKET = {
  "message.send": "heavy",
  "component.interact": "heavy",
  "run.abort": "heavy",
  "run.events.replay": "replay",
  "approval.resolve": "approval",
  typing: "chatter",
  "presence.update": "chatter",
} as const satisfies Record<string, keyof Limits["wire"]>;

const RATE_LIMITED: Result<never> = {
  ok: false,
  error: { code: "RATE_LIMITED", message: "too many requests" },
};

const ChannelUnsubscribe = z.object({ channelId: Id });

export const channelRoom = (channelId: string): string => `channel:${channelId}`;
export const userRoom = (userId: string): string => `user:${userId}`;
/** 채널 룸에 아직 아무도 없는 워크스페이스 단위 통지(channel.created)용 */
export const workspaceRoom = (workspaceId: string): string => `workspace:${workspaceId}`;

/** 기본 네임스페이스에 인증 미들웨어와 클라이언트 → 서버 핸들러를 붙인다(계약 스펙 7장). 팬아웃은 events.ts. */
export function attachWire(io: WireServer, ctx: WireContext): void {
  const limits = ctx.limits ?? LIMITS;
  const now = ctx.now ?? monotonicNow;
  const addressOf = (handshake: Parameters<NonNullable<WireContext["clientAddress"]>>[0]): string => {
    if (!ctx.clientAddress) return handshake.address;
    try {
      return ctx.clientAddress(handshake);
    } catch {
      return handshake.address;
    }
  };
  // key 는 이벤트 이름만 — 채널 id 같은 값을 넣으면 줄이 폭증한다. 폭주는 OpsService 가 묶는다
  const recordLimited = (event: string, handshake: Parameters<typeof addressOf>[0]) =>
    ctx.ops?.record({
      kind: "ratelimit",
      key: `wire:${event}`,
      severity: "info",
      detail: { ipPrefix: ipPrefix(addressOf(handshake)) },
    });

  io.use(async (socket, next) => {
    const { token, protocol } = (socket.handshake.auth ?? {}) as { token?: unknown; protocol?: unknown };
    // 프로토콜 → 토큰 순서. 토큰 값은 로그에 싣지 않는다
    if (protocol !== WIRE_PROTOCOL) {
      return next(connectError("PROTOCOL_MISMATCH", `wire protocol ${String(protocol)} != ${WIRE_PROTOCOL}`));
    }
    // 토큰이 오면 토큰(wire-cli·테스트), 없으면 같은 출처 쿠키(브라우저 — 토큰을 보관하지 않는다)
    const sessionToken =
      typeof token === "string" ? token : cookieSessionToken(socket.handshake.headers, ctx.appOrigin);
    const user = sessionToken ? await verifySessionToken(ctx.auth, sessionToken) : null;
    if (!user) return next(connectError("UNAUTHORIZED", "invalid session"));
    // 방에는 connection 에서 들어간다 — 동시에 도착한 핸드셰이크는 서로를 못 봐 상한을 조금 넘길 수 있다(느슨한 상한)
    const open = await io.in(userRoom(user.userId)).fetchSockets();
    if (open.length >= limits.socketsPerUser) {
      recordLimited("connect", socket.handshake);
      return next(connectError("RATE_LIMITED", "too many connections"));
    }
    socket.data.userId = user.userId;
    next();
  });

  io.on("connection", (socket) => {
    const { userId } = socket.data;
    void socket.join(userRoom(userId));
    // 서버는 워크스페이스 하나만 섬긴다 — 접속한 소켓은 모두 그 워크스페이스 소속이다
    void socket.join(workspaceRoom(ctx.workspaceId));

    const buckets: Record<keyof Limits["wire"], TokenBucket> = {
      heavy: new TokenBucket({ ...limits.wire.heavy, now }),
      replay: new TokenBucket({ ...limits.wire.replay, now }),
      approval: new TokenBucket({ ...limits.wire.approval, now }),
      chatter: new TokenBucket({ ...limits.wire.chatter, now }),
    };
    /** 핸들러 맨 앞에서 부른다 — true 면 그 이벤트를 처리하지 않는다(ack 있는 이벤트는 RATE_LIMITED 로 답한다) */
    const limited = (event: keyof typeof WIRE_BUCKET): boolean => {
      if (buckets[WIRE_BUCKET[event]].take()) return false;
      recordLimited(event, socket.handshake);
      return true;
    };

    const runs = (): RunsFacade => {
      if (!ctx.runs) throw apiError("ADAPTER_UNAVAILABLE", "runs are not available");
      return ctx.runs;
    };

    socket.on("channel.subscribe", async (raw: unknown, ack: unknown) => {
      const res = await settle(ctx.logger, "channel.subscribe", async () => {
        const { channelId, lastSeq } = parsePayload(ChannelSubscribe, raw);
        // workspaceId 를 꼭 넘긴다 — 빠뜨리면 다른 워크스페이스 채널도 구독된다
        const channel = getChannel(ctx.db, channelId, ctx.workspaceId);
        if (!channel) throw apiError("NOT_FOUND", "channel not found");
        // 룸에 먼저 들어간 뒤 읽는다 — 그 사이 메시지는 페이지와 이벤트에 겹칠 수는 있어도 빠지지 않는다
        await socket.join(channelRoom(channel.id));
        // 처음 구독은 타임라인(루트만), lastSeq 재동기화는 끊긴 사이 답글까지 — 웹이 threadRootId 로 스레드 캐시에 나눈다
        const page = listMessages(
          ctx.db,
          channel.id,
          lastSeq === undefined
            ? { limit: MESSAGE_PAGE_MAX, scope: "roots" }
            : { afterSeq: lastSeq, limit: MESSAGE_PAGE_MAX, scope: "all" },
        );
        return {
          messages: page.messages,
          hasMore: page.hasMore,
          activeRuns: ctx.runs?.activeRuns(channel.id) ?? [],
          pendingApprovals: ctx.runs?.pendingApprovals(channel.id) ?? [],
          // 끊긴 사이 옛 루트에 붙은 답글이면 그 루트의 새 요약 — 루트 message.updated 를 못 받았다
          ...(lastSeq === undefined ? {} : { threadRoots: threadRootsOf(ctx.db, channel.id, page.messages) }),
        };
      });
      reply(ack, res);
    });

    socket.on("channel.unsubscribe", async (raw: unknown, ack: unknown) => {
      const res = await settle(ctx.logger, "channel.unsubscribe", async () => {
        const { channelId } = parsePayload(ChannelUnsubscribe, raw);
        await socket.leave(channelRoom(channelId));
        return null;
      });
      reply(ack, res);
    });

    socket.on("message.send", async (raw: unknown, ack: unknown) => {
      // 저장·라우팅 전에 막는다 — 같은 clientMsgId 로 다시 보내면 그때 한 번 저장된다
      if (limited("message.send")) return reply(ack, RATE_LIMITED);
      const res = await settle(ctx.logger, "message.send", () => sendMessage(ctx, userId, raw));
      reply(ack, res.ok ? { ok: true, data: { message: res.data.message } } : res);
      // 멱등 재전송은 다시 라우팅하지 않는다(에이전트 런이 두 번 뜬다)
      if (!res.ok || !res.data.created) return;
      try {
        await ctx.route(res.data.message);
      } catch (err) {
        ctx.logger.error({ err, messageId: res.data.message.id }, "route failed");
      }
    });

    socket.on("typing", (raw: unknown) => {
      if (limited("typing")) return;
      const parsed = Typing.safeParse(raw);
      if (!parsed.success) return;
      const room = channelRoom(parsed.data.channelId);
      // 구독(워크스페이스 확인을 거친 룸 참가)한 채널로만 중계한다
      if (!socket.rooms.has(room)) return;
      socket
        .to(room)
        .emit("typing", { channelId: parsed.data.channelId, actorType: "user", actorId: userId });
    });

    // 채널 id 가 이 워크스페이스 채널인지는 보지 않는다 — 거르기에만 쓰여 틀린 값은 「안 보고 있음」이 될 뿐이다
    socket.on("presence.update", (raw: unknown) => {
      if (limited("presence.update")) return;
      const parsed = PresenceUpdate.safeParse(raw);
      if (parsed.success) ctx.presence?.set(socket.id, userId, parsed.data);
    });
    socket.on("disconnect", () => ctx.presence?.drop(socket.id));

    socket.on("run.abort", async (raw: unknown, ack: unknown) => {
      if (limited("run.abort")) return reply(ack, RATE_LIMITED);
      const res = await settle(ctx.logger, "run.abort", async () => {
        const { runId } = parsePayload(RunAbort, raw);
        await runs().abort(runId, userId);
        return null;
      });
      reply(ack, res);
    });

    socket.on("run.events.replay", async (raw: unknown, ack: unknown) => {
      if (limited("run.events.replay")) return reply(ack, RATE_LIMITED);
      const res = await settle(ctx.logger, "run.events.replay", () => {
        const { runId, afterSeq } = parsePayload(RunEventsReplay, raw);
        return runs().replay(runId, afterSeq);
      });
      reply(ack, res);
    });

    socket.on("component.interact", async (raw: unknown, ack: unknown) => {
      if (limited("component.interact")) return reply(ack, RATE_LIMITED);
      const res = await settle(ctx.logger, "component.interact", () => {
        const input = parsePayload(ComponentInteract, raw);
        return runs().interact({ ...input, userId });
      });
      reply(ack, res);
    });

    socket.on("approval.resolve", async (raw: unknown, ack: unknown) => {
      if (limited("approval.resolve")) return reply(ack, RATE_LIMITED);
      const res = await settle(ctx.logger, "approval.resolve", async () => {
        const { approvalId, decision } = parsePayload(ApprovalResolve, raw);
        await runs().resolveApproval({ approvalId, decision, userId });
        return null;
      });
      reply(ack, res);
    });
  });
}

function sendMessage(ctx: WireContext, userId: string, raw: unknown): { message: Message; created: boolean } {
  const input = parsePayload(MessageSend, raw);
  if (!getChannel(ctx.db, input.channelId, ctx.workspaceId)) throw apiError("NOT_FOUND", "channel not found");
  const existing = findUserMessage(ctx.db, userId, input.clientMsgId);
  if (existing) return { message: existing, created: false };
  // 첨부는 서비스가 같은 트랜잭션에서 검사하고 묶는다(스펙 4.4) — 버리고 저장하면 「본문 없음 + 첨부」가 빈 메시지로 남는다
  const message = createUserMessage(ctx.db, ctx.bus, {
    channelId: input.channelId,
    authorId: userId,
    bodyMd: input.bodyMd,
    clientMsgId: input.clientMsgId,
    attachments: input.attachments,
    replyTo: input.replyTo,
    threadRootId: input.threadRootId,
  });
  return { message, created: true };
}

function connectError(code: ApiError["code"], message: string): Error & { data: ApiError } {
  return Object.assign(new Error(code), { data: { code, message } });
}

/** 핸들러 결과를 Result 로. HttpError 는 그 본문, 그 밖의 예외는 INTERNAL(원인은 로그에만). */
async function settle<T>(logger: Logger, event: string, work: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    if (err instanceof HttpError) {
      // 저장값 계약 위반 같은 INTERNAL HttpError 는 서버 버그다 — REST 에러 핸들러와 같은 기준으로 남긴다
      if (err.body.code === "INTERNAL") logger.error({ err, cause: err.cause, event }, "wire handler failed");
      return { ok: false, error: err.body };
    }
    logger.error({ err, event }, "wire handler failed");
    return { ok: false, error: { code: "INTERNAL", message: "internal error" } };
  }
}

/** 클라이언트는 ack 없이 보낼 수 있다 — 함수가 아니면 버린다(부르다 던지면 unhandled rejection) */
function reply<T>(ack: unknown, res: Result<T>): void {
  if (typeof ack === "function") (ack as (res: Result<T>) => void)(res);
}
