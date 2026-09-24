/**
 * 플러그인이 아웃바운드로 붙는 브리지 엔드포인트 — Socket.IO 네임스페이스 `/bridge`.
 *
 * Phase 1 이 이어받을 최소 표면: 토큰 인증(handshake `auth.token` 을 검증 함수에 넘긴다 — 통과한 토큰 id 를 세션이 기억한다), 플러그인 → 서버 이벤트
 * (`hello`·`outbound.message`·`outbound.typing`·`status`) 수신, 서버 → 플러그인 요청
 * (`inbound.deliver`·`config.set`·`agents.list`) 송신. 저장·라우팅 같은 런타임 로직은 콜백으로 밖에 둔다.
 * 플러그인 ack 는 외부 입력이라 Result 봉투와 data 를 Zod 로 파싱한다 — 틀리면 `INTERNAL` + `ADAPTER_PROTOCOL: …`.
 *
 * HTTP 경로는 Socket.IO 기본 `/socket.io/` 이고 `/bridge` 는 네임스페이스다 — 리버스 프록시는 `/socket.io` 를 넘기면 된다.
 */
import { randomUUID } from "node:crypto";
import {
  ApiError,
  BRIDGE_PROTOCOL,
  type BridgeClientToServerEvents,
  type BridgeHello,
  type BridgeServerToClientEvents,
  type BridgeStatus,
  type ConfigSet,
  ConfigSetResult,
  type InboundDeliver,
  InboundDeliverResult,
  type OutboundMessage,
  type Result,
} from "@dodok/shared";
import type { Namespace, Server, Socket } from "socket.io";
import { z } from "zod";
import { BridgeSessionState, OutboundDedupe, parseBridgeClientEvent, RejectLogThrottle } from "./session";

export const BRIDGE_NAMESPACE = "/bridge";

export type BridgeSocket = Socket<BridgeClientToServerEvents, BridgeServerToClientEvents>;

export type BridgeServerCallbacks = {
  onHello?: (session: BridgeSessionState, hello: BridgeHello) => void;
  /**
   * 저장하고 서버 메시지 id 를 돌려준다. 같은 `outboundId` 는 이 `attachBridge` 가 기억하는 최근 1,000개 안에서
   * 연결이 바뀌어도 한 번만 온다 — 성공한 id 의 재전송은 기록한 messageId 로, 처리 중인 id 의 재전송은 그 결과를 기다려 ack 한다.
   * 실패(reject)한 id 는 기록하지 않아 재전송이 다시 온다. 창 밖으로 밀린 id·서버 재시작 전 id 는 다시 올 수 있으므로
   * 최종 방어선은 저장소 유니크(`messages.external_id`)다.
   */
  onOutboundMessage: (
    session: BridgeSessionState,
    message: OutboundMessage,
  ) => Promise<{ messageId: string }>;
  onTyping?: (session: BridgeSessionState, payload: { channelId: string; agentId: string }) => void;
  onStatus?: (session: BridgeSessionState, status: BridgeStatus) => void;
  onClose?: (session: BridgeSessionState) => void;
  /** 핸드셰이크 거절 — 원격 주소별 1분에 한 번만 온다(그 사이 눌러 둔 수를 싣는다). 제시된 토큰은 싣지 않는다 */
  onRejected?: (reason: string) => void;
};

/** 핸드셰이크 `auth.token`(외부 입력 그대로)을 보고 통과면 그 토큰의 id, 아니면 null */
export type BridgeTokenVerifier = (presented: unknown) => { tokenId: string } | null;

export type BridgeServerOptions = BridgeServerCallbacks & {
  verifyToken: BridgeTokenVerifier;
  serverVersion: string;
  ackTimeoutMs?: number;
  /** 거절 로그 스로틀의 시계(ms) — 테스트 주입. 기본 `Date.now` */
  now?: () => number;
  /**
   * 거절 로그·스로틀의 원격 주소. 기본 `handshake.address`. 리버스 프록시 뒤면 서버가 믿을 수 있는 경우에만
   * 전달 헤더를 읽어 준다(믿지 않는 헤더를 읽으면 위조로 스로틀·귀속을 우회한다). 던지면 기본값을 쓴다
   */
  clientAddress?: (handshake: BridgeSocket["handshake"]) => string;
};

export type BridgeHandle = {
  readonly namespace: Namespace<BridgeClientToServerEvents, BridgeServerToClientEvents>;
  /** 현재 ready 인 플러그인 연결 (가장 최근 1개) */
  current(): BridgeSessionState | undefined;
  /** 그 토큰으로 통과한 연결(hello 전 포함)을 모두 끊고 끊은 수를 돌려준다 — 토큰 폐기 때 */
  revokeSessions(tokenId: string): number;
  waitForReady(timeoutMs: number): Promise<BridgeSessionState>;
  deliverInbound(payload: InboundDeliver, timeoutMs?: number): Promise<Result<InboundDeliverResult>>;
  setConfig(payload: ConfigSet, timeoutMs?: number): Promise<Result<ConfigSetResult>>;
  listAgents(timeoutMs?: number): Promise<Result<{ agents: Array<{ agentId: string; name?: string }> }>>;
  close(): void;
};

function errorResult(code: "TIMEOUT" | "ADAPTER_UNAVAILABLE" | "INTERNAL", message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

const AckEnvelope = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: ApiError }),
]);
const AgentsListAck = z.object({
  agents: z.array(z.object({ agentId: z.string(), name: z.string().optional() })),
});

function protocolError(error: z.ZodError): Result<never> {
  const issues = error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
  return errorResult("INTERNAL", `ADAPTER_PROTOCOL: ${issues}`);
}

/** 플러그인 ack(unknown)를 Result<T> 로. 봉투·data 가 계약과 다르면 INTERNAL ADAPTER_PROTOCOL. */
function parseAck<T>(schema: z.ZodType<T>, raw: unknown): Result<T> {
  const envelope = AckEnvelope.safeParse(raw);
  if (!envelope.success) return protocolError(envelope.error);
  if (!envelope.data.ok) return { ok: false, error: envelope.data.error };
  const data = schema.safeParse(envelope.data.data);
  return data.success ? { ok: true, data: data.data } : protocolError(data.error);
}

export function attachBridge(io: Server, opts: BridgeServerOptions): BridgeHandle {
  const namespace = io.of(BRIDGE_NAMESPACE) as unknown as Namespace<
    BridgeClientToServerEvents,
    BridgeServerToClientEvents
  >;
  const ackTimeoutMs = opts.ackTimeoutMs ?? 15_000;
  let active: { socket: BridgeSocket; session: BridgeSessionState } | undefined;
  // close() 가 끊을 수 있도록 resolve 와 reject 를 함께 둔다(둘 다 자기 타이머를 지운다)
  const readyWaiters = new Set<{
    resolve: (session: BridgeSessionState) => void;
    reject: (error: Error) => void;
  }>();
  // 중복 흡수는 연결이 아니라 이 브리지(플러그인 id) 단위 — 플러그인은 ack 를 못 받은 head 를 재연결 뒤 같은 outboundId 로 다시 보낸다
  const dedupe = new OutboundDedupe();
  const inflight = new Map<string, Promise<{ messageId: string }>>();
  // hello 전 연결까지 — 폐기는 hello 여부와 무관하게 그 토큰의 연결을 전부 끊는다
  const connections = new Map<string, { socket: BridgeSocket; session: BridgeSessionState }>();
  const rejectLog = new RejectLogThrottle();
  const now = opts.now ?? Date.now;
  const remoteAddress = (handshake: BridgeSocket["handshake"]): string => {
    if (!opts.clientAddress) return handshake.address;
    try {
      return opts.clientAddress(handshake);
    } catch {
      return handshake.address;
    }
  };

  namespace.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    let verified: { tokenId: string } | null = null;
    try {
      verified = opts.verifyToken(token);
    } catch {
      // 검증 함수 오류(저장소 등)는 거절로 본다 — 아래 거절 로그 한 줄이 남는다
    }
    if (verified) {
      (socket.data as { tokenId?: string }).tokenId = verified.tokenId;
      return next();
    }
    // 폐기된 토큰으로 재접속을 되풀이하는 플러그인이 로그를 채우지 않게 주소별로 줄인다(Review Focus 2)
    const address = remoteAddress(socket.handshake);
    const logged = rejectLog.take(address, now());
    if (logged) {
      const suppressed = logged.suppressed > 0 ? ` (${logged.suppressed} more suppressed)` : "";
      opts.onRejected?.(`token mismatch from ${address}${suppressed}`);
    }
    next(new Error("UNAUTHORIZED"));
  });

  namespace.on("connection", (socket) => {
    const tokenId = (socket.data as { tokenId?: string }).tokenId;
    const session = new BridgeSessionState(randomUUID(), {
      dedupe,
      ...(tokenId === undefined ? {} : { tokenId }),
    });
    connections.set(socket.id, { socket, session });

    socket.on("hello", (payload, ack) => {
      const parsed = parseBridgeClientEvent("hello", payload);
      if (!parsed.ok) return ack(parsed);
      try {
        session.onHello(parsed.data);
      } catch (error) {
        return ack({ ok: false, error: { code: "CONFLICT", message: String(error) } });
      }
      // 플러그인 연결은 하나만 유지한다 — 새 연결이 이기고 이전 연결에는 알린다
      if (active && active.socket.id !== socket.id) {
        active.session.close("replaced");
        active.socket.emit("system.notice", { reason: "replaced", message: "newer plugin connection" });
        active.socket.disconnect(true);
      }
      active = { socket, session };
      ack({ ok: true, data: { serverVersion: opts.serverVersion, protocol: BRIDGE_PROTOCOL } });
      opts.onHello?.(session, parsed.data);
      for (const waiter of readyWaiters) waiter.resolve(session);
      readyWaiters.clear();
    });

    socket.on("outbound.message", (payload, ack) => {
      const parsed = parseBridgeClientEvent("outbound.message", payload);
      if (!parsed.ok) return ack(parsed);
      const acceptance = session.acceptOutbound(parsed.data.outboundId);
      if (acceptance.kind === "reject") {
        return ack({ ok: false, error: { code: acceptance.code, message: "hello first" } });
      }
      if (acceptance.kind === "duplicate")
        return ack({ ok: true, data: { messageId: acceptance.messageId } });
      const { outboundId } = parsed.data;
      let pending = inflight.get(outboundId);
      if (!pending) {
        pending = opts
          .onOutboundMessage(session, parsed.data)
          .then((data) => {
            session.recordOutbound(outboundId, data.messageId);
            return data;
          })
          .finally(() => inflight.delete(outboundId));
        inflight.set(outboundId, pending);
      }
      pending.then(
        (data) => ack({ ok: true, data }),
        (error: unknown) => ack({ ok: false, error: { code: "INTERNAL", message: String(error) } }),
      );
    });

    socket.on("outbound.typing", (payload) => {
      const parsed = parseBridgeClientEvent("outbound.typing", payload);
      if (parsed.ok && session.phase === "ready") opts.onTyping?.(session, parsed.data);
    });

    socket.on("status", (payload) => {
      const parsed = parseBridgeClientEvent("status", payload);
      if (!parsed.ok || session.phase !== "ready") return;
      session.lastStatus = parsed.data;
      opts.onStatus?.(session, parsed.data);
    });

    socket.on("disconnect", () => {
      connections.delete(socket.id);
      if (session.phase !== "closed") session.close("disconnect");
      if (active?.socket.id === socket.id) active = undefined;
      opts.onClose?.(session);
    });
  });

  function requireActive(): { socket: BridgeSocket; session: BridgeSessionState } | undefined {
    return active && active.session.phase === "ready" ? active : undefined;
  }

  async function request<T>(
    schema: z.ZodType<T>,
    emit: (socket: BridgeSocket, timeoutMs: number) => Promise<unknown>,
    timeoutMs: number,
  ): Promise<Result<T>> {
    const target = requireActive();
    if (!target) return errorResult("ADAPTER_UNAVAILABLE", "plugin not connected");
    let raw: unknown;
    try {
      raw = await emit(target.socket, timeoutMs);
    } catch (error) {
      return errorResult("TIMEOUT", String(error));
    }
    return parseAck(schema, raw);
  }

  return {
    namespace,
    current: () => requireActive()?.session,
    revokeSessions(tokenId) {
      let count = 0;
      // disconnect 가 동기로 지금 항목을 connections 에서 지운다 — Map 순회는 그래도 남은 항목을 이어 돈다
      for (const { socket, session } of connections.values()) {
        if (session.tokenId !== tokenId) continue;
        count += 1;
        session.close("revoked");
        socket.disconnect(true);
      }
      return count;
    },
    waitForReady(timeoutMs) {
      const existing = requireActive();
      if (existing) return Promise.resolve(existing.session);
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: (session: BridgeSessionState) => {
            clearTimeout(timer);
            resolve(session);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        const timer = setTimeout(() => {
          readyWaiters.delete(waiter);
          reject(new Error(`plugin hello not received within ${timeoutMs}ms`));
        }, timeoutMs);
        readyWaiters.add(waiter);
      });
    },
    deliverInbound: (payload, timeoutMs = ackTimeoutMs) =>
      request(
        InboundDeliverResult,
        (socket, ms) => socket.timeout(ms).emitWithAck("inbound.deliver", payload),
        timeoutMs,
      ),
    setConfig: (payload, timeoutMs = ackTimeoutMs) =>
      request(
        ConfigSetResult,
        (socket, ms) => socket.timeout(ms).emitWithAck("config.set", payload),
        timeoutMs,
      ),
    listAgents: (timeoutMs = ackTimeoutMs) =>
      request(AgentsListAck, (socket, ms) => socket.timeout(ms).emitWithAck("agents.list", {}), timeoutMs),
    close() {
      for (const waiter of readyWaiters) waiter.reject(new Error("bridge closed"));
      readyWaiters.clear();
      if (active) {
        active.session.close("shutdown");
        active.socket.emit("system.notice", { reason: "shutdown", message: "server shutting down" });
      }
      namespace.disconnectSockets(true);
    },
  };
}
