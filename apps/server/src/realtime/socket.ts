import {
  type ApiError,
  ApprovalResolve,
  ChannelSubscribe,
  ComponentInteract,
  Id,
  type Message,
  MessageSend,
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
import {
  createUserMessage,
  findUserMessage,
  listMessages,
  MESSAGE_PAGE_MAX,
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
};

const ChannelUnsubscribe = z.object({ channelId: Id });

export const channelRoom = (channelId: string): string => `channel:${channelId}`;
export const userRoom = (userId: string): string => `user:${userId}`;
/** 채널 룸에 아직 아무도 없는 워크스페이스 단위 통지(channel.created)용 */
export const workspaceRoom = (workspaceId: string): string => `workspace:${workspaceId}`;

/** 기본 네임스페이스에 인증 미들웨어와 클라이언트 → 서버 핸들러를 붙인다(계약 스펙 7장). 팬아웃은 events.ts. */
export function attachWire(io: WireServer, ctx: WireContext): void {
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
    socket.data.userId = user.userId;
    next();
  });

  io.on("connection", (socket) => {
    const { userId } = socket.data;
    void socket.join(userRoom(userId));
    // 서버는 워크스페이스 하나만 섬긴다 — 접속한 소켓은 모두 그 워크스페이스 소속이다
    void socket.join(workspaceRoom(ctx.workspaceId));

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
        const page = listMessages(
          ctx.db,
          channel.id,
          lastSeq === undefined
            ? { limit: MESSAGE_PAGE_MAX }
            : { afterSeq: lastSeq, limit: MESSAGE_PAGE_MAX },
        );
        return {
          messages: page.messages,
          hasMore: page.hasMore,
          activeRuns: ctx.runs?.activeRuns(channel.id) ?? [],
          pendingApprovals: ctx.runs?.pendingApprovals(channel.id) ?? [],
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
      const parsed = Typing.safeParse(raw);
      if (!parsed.success) return;
      const room = channelRoom(parsed.data.channelId);
      // 구독(워크스페이스 확인을 거친 룸 참가)한 채널로만 중계한다
      if (!socket.rooms.has(room)) return;
      socket
        .to(room)
        .emit("typing", { channelId: parsed.data.channelId, actorType: "user", actorId: userId });
    });

    socket.on("run.abort", async (raw: unknown, ack: unknown) => {
      const res = await settle(ctx.logger, "run.abort", async () => {
        const { runId } = parsePayload(RunAbort, raw);
        await runs().abort(runId, userId);
        return null;
      });
      reply(ack, res);
    });

    socket.on("run.events.replay", async (raw: unknown, ack: unknown) => {
      const res = await settle(ctx.logger, "run.events.replay", () => {
        const { runId, afterSeq } = parsePayload(RunEventsReplay, raw);
        return runs().replay(runId, afterSeq);
      });
      reply(ack, res);
    });

    socket.on("component.interact", async (raw: unknown, ack: unknown) => {
      const res = await settle(ctx.logger, "component.interact", () => {
        const input = parsePayload(ComponentInteract, raw);
        return runs().interact({ ...input, userId });
      });
      reply(ack, res);
    });

    socket.on("approval.resolve", async (raw: unknown, ack: unknown) => {
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
