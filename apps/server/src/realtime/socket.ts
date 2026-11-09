import {
  type ApiError,
  ApprovalResolve,
  type Conversation,
  ConversationRead,
  ChannelSubscribe,
  ComponentInteract,
  Id,
  type Message,
  MessageSend,
  type PresenceEntry,
  PresenceUpdate,
  ReactionSet,
  type Result,
  RunAbort,
  RunEventsReplay,
  roleAtLeast,
  Typing,
  WIRE_PROTOCOL,
} from "@dodok/shared";
import { and, eq, gt, lte } from "drizzle-orm";
import { z } from "zod";
import { type Auth, verifySessionToken } from "../auth";
import { roleOf } from "../auth/roles";
import { session as authSession } from "../db/auth-schema";
import type { Db } from "../db/client";
import { apiError, HttpError } from "../http/errors";
import { parsePayload } from "../http/validate";
import type { Logger } from "../logger";
import { getApproval } from "../modules/approvals/store";
import { canReadChannel } from "../auth/channel-access";
import { assertChannelWritable, getChannel, loadReadableChannel } from "../modules/channels/service";
import { assertDmWritable } from "../modules/dms/service";
import { resolveSendConversation } from "../modules/conversations/service";
import { getConversation } from "../modules/conversations/store";
import { ipPrefix } from "../modules/ops/ip";
import { LIMITS, type Limits } from "../modules/ops/limits";
import { monotonicNow, TokenBucket } from "../modules/ops/ratelimit";
import type { OpsService } from "../modules/ops/service";
import type { Presence } from "../modules/push/presence";
import { setReaction } from "../modules/reactions/service";
import { channelLastSeq } from "../modules/messages/seq";
import { markRead } from "../modules/reads/store";
import {
  findUserMessage,
  listMessages,
  MESSAGE_PAGE_MAX,
  sendUserMessage,
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
  /** 접속 점 전체(프로필 스펙 3.3) — 연결 직후 그 소켓에 presence.snapshot 으로 보낸다. 없으면 보내지 않는다 */
  presenceSnapshot?: () => PresenceEntry[];
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
  "conversation.read": "chatter",
  "reaction.set": "chatter",
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
/** 세션 단위 끊기용 — Better Auth session 행의 id */
export const sessionRoom = (sessionId: string): string => `session:${sessionId}`;

/**
 * 그 사용자의 열린 wire 소켓을 서버가 끊는다(비활성화·재설정 수락). 클라이언트는 「io server disconnect」를 받는다. 세션 행을 지우거나
 * membership 을 비활성으로 쓴 뒤에 부른다 — 핸드셰이크를 지나던 소켓은 connection 에서 membership·세션을 다시 본다
 */
export function disconnectUser(io: WireServer, userId: string): void {
  io.in(userRoom(userId)).disconnectSockets(true);
}

/** 그 세션들의 열린 wire 소켓만 끊는다(me/password — 이 세션을 뺀 본인 세션, 팀 스펙 3.5). 세션 행을 지운 뒤에 부른다 */
export function disconnectSessions(io: WireServer, sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return;
  io.in(sessionIds.map(sessionRoom)).disconnectSockets(true);
}

/** 세션 행이 아직 있고 만료 전인가 — 동기(better-sqlite3). connection 에서 방 참가와 같은 구간에 본다 */
export function sessionAlive(db: Db, sessionId: string, now: Date = new Date()): boolean {
  return !!db
    .select({ id: authSession.id })
    .from(authSession)
    .where(and(eq(authSession.id, sessionId), gt(authSession.expiresAt, now)))
    .get();
}

/**
 * 만료된 세션 행을 지우고 그 세션들의 열린 wire 소켓을 끊는다 — 소켓은 핸드셰이크·connection 에서만 세션을 보므로, REST 없이 wire 만
 * 쓰는 탭은 이것이 없으면 만료 뒤에도 산다. 지우기와 끊기를 한 동기 구간에 둔다(connection 의 sessionAlive 와 엇갈리지 않게).
 * REST 호출로 늘어난 세션은 expires_at 이 이미 뒤로 가 있어 걸리지 않는다. 앱이 SESSION_SWEEP_INTERVAL_MS 마다 부른다
 */
export function sweepExpiredSessions(io: WireServer, db: Db, now: Date = new Date()): string[] {
  const ids = db
    .delete(authSession)
    .where(lte(authSession.expiresAt, now))
    .returning({ id: authSession.id })
    .all()
    .map((r) => r.id);
  disconnectSessions(io, ids);
  return ids;
}

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
    // membership 이 없거나 비활성인 세션은 REST 처럼 401 이다(roleOf)
    if (!roleOf(ctx.db, ctx.workspaceId, user.userId))
      return next(connectError("UNAUTHORIZED", "not a member"));
    // 방에는 connection 에서 들어간다 — 동시에 도착한 핸드셰이크는 서로를 못 봐 상한을 조금 넘길 수 있다(느슨한 상한)
    const open = await io.in(userRoom(user.userId)).fetchSockets();
    if (open.length >= limits.socketsPerUser) {
      recordLimited("connect", socket.handshake);
      return next(connectError("RATE_LIMITED", "too many connections"));
    }
    socket.data.userId = user.userId;
    socket.data.sessionId = user.sessionId;
    next();
  });

  io.on("connection", (socket) => {
    const { userId, sessionId } = socket.data;
    // 미들웨어의 membership·세션 확인과 여기 사이에 await 가 있다 — 그 사이 비활성화됐거나 세션이 지워졌으면(재설정·비밀번호 변경)
    // disconnectUser·disconnectSessions 가 아직 방에 없는 이 소켓을 못 본다. 확인과 방 참가를 같은 동기 구간에 둔다
    // (members/service.ts deactivateMember·accept.ts resetPassword 도 쓰기 뒤 끊기를 한 구간에)
    if (!roleOf(ctx.db, ctx.workspaceId, userId) || !sessionAlive(ctx.db, sessionId)) {
      socket.disconnect(true);
      return;
    }
    void socket.join(userRoom(userId));
    void socket.join(sessionRoom(sessionId));
    // 서버는 워크스페이스 하나만 섬긴다 — 접속한 소켓은 모두 그 워크스페이스 소속이다
    void socket.join(workspaceRoom(ctx.workspaceId));
    // 재접속 포함 — 웹은 통째로 바꾼다. 끊긴 동안 놓친 presence.changed 를 이것으로 맞춘다
    if (ctx.presenceSnapshot) socket.emit("presence.snapshot", { entries: ctx.presenceSnapshot() });

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
        // workspaceId 를 꼭 넘긴다 — 빠뜨리면 다른 워크스페이스 채널도 구독된다. 남의 DM 은 룸에 들이지 않는다 — 채널 룸 팬아웃
        // (메시지·런·세션)은 이 판정 하나가 지킨다(auth/channel-access.ts)
        const channel = loadReadableChannel(ctx.db, channelId, ctx.workspaceId, userId);
        // 룸에 먼저 들어간 뒤 읽는다 — 그 사이 메시지는 페이지와 이벤트에 겹칠 수는 있어도 빠지지 않는다
        await socket.join(channelRoom(channel.id));
        // 처음 구독은 이벤트만 — 세션의 첫 페이지는 대화 REST 로 받는다(채널 세션 계획 판정 PS5). lastSeq 재동기화는 끊긴 사이의
        // 채널 전체(모든 세션·스레드 답글) — 웹이 conversationId·threadRootId 로 캐시를 나눈다
        const page =
          lastSeq === undefined
            ? { messages: [], hasMore: false }
            : listMessages(ctx.db, channel.id, { afterSeq: lastSeq, limit: MESSAGE_PAGE_MAX, scope: "all" });
        return {
          messages: page.messages,
          hasMore: page.hasMore,
          latestSeq: channelLastSeq(ctx.db, channel.id),
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
      reply(
        ack,
        res.ok
          ? {
              ok: true,
              data: {
                message: res.data.message,
                ...(res.data.conversation ? { conversation: res.data.conversation } : {}),
              },
            }
          : res,
      );
      // 멱등 재전송은 다시 라우팅하지 않는다(에이전트 런이 두 번 뜬다)
      if (!res.ok || !res.data.created) return;
      // 최상위를 보내면 작성자 읽음이 그 세션에서 그 seq 까지 오른다 — 스레드 답글은 세션 끝을 보지 않고도 쓸 수 있어 올리지 않는다
      if (res.data.message.threadRootId === undefined) {
        try {
          const { channelId, conversationId, seq } = res.data.message;
          const lastReadSeq = markRead(ctx.db, ctx.workspaceId, userId, conversationId, seq, new Date());
          ctx.bus.emit("conversation.read", { userId, conversationId, channelId, lastReadSeq });
        } catch (err) {
          ctx.logger.warn({ err, messageId: res.data.message.id }, "author read mark failed");
        }
      }
      try {
        await ctx.route(res.data.message);
      } catch (err) {
        ctx.logger.error({ err, messageId: res.data.message.id }, "route failed");
      }
    });

    // 보관한 채널·닫힌 세션도 받는다 — 읽기는 막지 않으므로 assertChannelWritable·assertConversationWritable 을 쓰지 않는다
    socket.on("conversation.read", async (raw: unknown, ack: unknown) => {
      if (limited("conversation.read")) return reply(ack, RATE_LIMITED);
      const res = await settle(ctx.logger, "conversation.read", async () => {
        const { conversationId, seq } = parsePayload(ConversationRead, raw);
        const lastReadSeq = markRead(ctx.db, ctx.workspaceId, userId, conversationId, seq, new Date());
        const channelId = getConversation(ctx.db, conversationId, ctx.workspaceId)?.channelId;
        if (channelId) ctx.bus.emit("conversation.read", { userId, conversationId, channelId, lastReadSeq });
        return { lastReadSeq };
      });
      reply(ack, res);
    });

    // 보관한 채널·시스템 메시지·다른 워크스페이스 거절은 서비스가 한다(리액션 스펙 「오류 처리」 절). 상태가 바뀌었을 때만 message.updated
    socket.on("reaction.set", async (raw: unknown, ack: unknown) => {
      if (limited("reaction.set")) return reply(ack, RATE_LIMITED);
      const res = await settle(ctx.logger, "reaction.set", async () => {
        setReaction(ctx.db, ctx.bus, ctx.workspaceId, userId, parsePayload(ReactionSet, raw), new Date());
        return null;
      });
      reply(ack, res);
    });

    socket.on("typing", (raw: unknown) => {
      if (limited("typing")) return;
      const parsed = Typing.safeParse(raw);
      if (!parsed.success) return;
      const room = channelRoom(parsed.data.channelId);
      // 구독(워크스페이스 확인을 거친 룸 참가)한 채널로만 중계한다
      if (!socket.rooms.has(room)) return;
      // 대화가 이 채널 것인지는 보지 않는다 — 같은 채널 룸 안의 표시일 뿐이고, 틀린 값은 아무 세션에도 보이지 않는다
      const { channelId, conversationId } = parsed.data;
      socket.to(room).emit("typing", { channelId, conversationId, actorType: "user", actorId: userId });
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
        return runs().replay(runId, afterSeq, userId);
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
        // 없는 승인과 남의 DM 의 승인은 역할 판정(403)보다 먼저 같은 404(승인 서비스와 같은 문구) — member 가 403·404 로 둘을 가르지
        // 못하게(auth/channel-access.ts). 다른 워크스페이스의 승인은 승인 서비스가 지금처럼 거절한다
        const approval = getApproval(ctx.db, approvalId);
        const approvalChannel = approval && getChannel(ctx.db, approval.channelId, ctx.workspaceId);
        if (!approval || (approvalChannel && !canReadChannel(ctx.db, { userId }, approvalChannel)))
          throw apiError("NOT_FOUND", "approval not found");
        // wire 에서 역할을 보는 이벤트는 이것 하나다(팀 스펙 「역할과 권한」). 역할은 이벤트마다 다시 읽는다.
        // 확인 카드(dodok_control)는 그 일을 시킨 사람 본인이 결정한다 — 역할은 보지 않고, 본인인지는 승인 서비스가 본다(계획 판정 PC4).
        // DM 의 승인은 종류와 무관하게 주인이 결정한다 — 볼 수 있는 사람이 주인뿐이라 member 주인도(에이전트 DM 계획 판정 PD7). 주인인지는
        // 위 접근 판정이 이미 봤다(남은 NOT_FOUND). admin 이상이 결정하는 것은 일반 채널의 승인뿐이다 — 모르는 kind(아직 결정자 규칙이
        // 없는 direct 포함)는 아무도 결정하지 못한다(기본이 닫힘, 사람 간 DM 스펙 4.2)
        const role = roleOf(ctx.db, ctx.workspaceId, userId);
        if (approval.kind === "dodok_control" || approvalChannel?.kind === "dm") {
          if (!role) throw apiError("FORBIDDEN", "워크스페이스 멤버가 아니다");
        } else if (approvalChannel !== undefined && approvalChannel.kind !== "channel") {
          throw apiError("FORBIDDEN", "이 승인은 결정할 수 없다");
        } else if (!roleAtLeast(role, "admin"))
          throw apiError("FORBIDDEN", "승인·거절은 admin 이상만 할 수 있다");
        await runs().resolveApproval({ approvalId, decision, userId });
        return null;
      });
      reply(ack, res);
    });
  });
}

/**
 * 사람 보내기 — 재전송(같은 clientMsgId)은 대화를 고르기 전에 그 메시지로 답한다(채널 세션 계획 판정 PS9 — 새 세션 첫 메시지의 재전송이
 * 세션을 또 만들지 않는다). newConversation 보내기는 서버가 만든 그 메시지의 세션을 ack 에 함께 싣는다 — 재전송이면 처음 만든 세션이라
 * ack 를 잃은 탭도 같은 세션으로 옮겨 간다
 */
function sendMessage(
  ctx: WireContext,
  userId: string,
  raw: unknown,
): { message: Message; created: boolean; conversation?: Conversation } {
  const input = parsePayload(MessageSend, raw);
  // 남의 DM 은 재전송 갈래·보관 검사보다 먼저 없는 채널과 같은 404(auth/channel-access.ts)
  loadReadableChannel(ctx.db, input.channelId, ctx.workspaceId, userId);
  const existing = findUserMessage(ctx.db, userId, input.clientMsgId);
  // 보관 전에 이미 저장된 메시지의 재전송(ack 를 잃은 탭)은 그 메시지로 답한다 — 새로 쓰는 것만 막는다(계획 판정 PC1)
  if (existing) {
    const conversation =
      input.newConversation === undefined ? undefined : getConversation(ctx.db, existing.conversationId);
    return { message: existing, created: false, ...(conversation ? { conversation } : {}) };
  }
  const channel = assertChannelWritable(ctx.db, input.channelId, ctx.workspaceId);
  const role = roleOf(ctx.db, ctx.workspaceId, userId);
  // 읽기 전용 DM(에이전트 보관·꺼짐·허용 철회)이면 409 DM_READ_ONLY — 주인은 보낸 사람 자신이다(접근 판정이 주인만 들인다)
  assertDmWritable(ctx.db, channel, role);
  const now = new Date();
  // 첨부는 서비스가 같은 트랜잭션에서 검사하고 묶는다(스펙 4.4) — 버리고 저장하면 「본문 없음 + 첨부」가 빈 메시지로 남는다
  const sent = sendUserMessage(ctx.db, ctx.bus, {
    conversationId: (tx) =>
      resolveSendConversation(
        tx,
        {
          channelId: input.channelId,
          userId,
          role,
          bodyMd: input.bodyMd,
          conversationId: input.conversationId,
          newConversation: input.newConversation,
          threadRootId: input.threadRootId,
        },
        now,
      ),
    authorId: userId,
    bodyMd: input.bodyMd,
    clientMsgId: input.clientMsgId,
    attachments: input.attachments,
    replyTo: input.replyTo,
    threadRootId: input.threadRootId,
  });
  const conversation =
    sent.conversation ??
    (input.newConversation === undefined ? undefined : getConversation(ctx.db, sent.message.conversationId));
  return { message: sent.message, created: sent.created, ...(conversation ? { conversation } : {}) };
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
