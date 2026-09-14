/**
 * 플러그인이 아웃바운드로 붙는 브리지 엔드포인트 — Socket.IO 네임스페이스 `/bridge`.
 *
 * Phase 1 이 이어받을 최소 표면: 토큰 인증(handshake `auth.token`), 플러그인 → 서버 이벤트
 * (`hello`·`outbound.message`·`outbound.typing`·`status`) 수신, 서버 → 플러그인 요청
 * (`inbound.deliver`·`config.set`·`agents.list`) 송신. 저장·라우팅 같은 런타임 로직은 콜백으로 밖에 둔다.
 *
 * HTTP 경로는 Socket.IO 기본 `/socket.io/` 이고 `/bridge` 는 네임스페이스다 — 리버스 프록시는 `/socket.io` 를 넘기면 된다.
 */
import { randomUUID } from "node:crypto";
import {
  BRIDGE_PROTOCOL,
  type BridgeClientToServerEvents,
  type BridgeHello,
  type BridgeServerToClientEvents,
  type BridgeStatus,
  type ConfigSet,
  type ConfigSetResult,
  type InboundDeliver,
  type InboundDeliverResult,
  type OutboundMessage,
  type Result,
} from "@dodok/shared";
import type { Namespace, Server, Socket } from "socket.io";
import { BridgeSessionState, parseBridgeClientEvent, verifyBridgeToken } from "./session";

export const BRIDGE_NAMESPACE = "/bridge";

export type BridgeSocket = Socket<BridgeClientToServerEvents, BridgeServerToClientEvents>;

export type BridgeServerCallbacks = {
  onHello?: (session: BridgeSessionState, hello: BridgeHello) => void;
  /** 저장하고 서버 메시지 id 를 돌려준다. 같은 outboundId 재전송은 여기까지 오지 않는다 */
  onOutboundMessage: (
    session: BridgeSessionState,
    message: OutboundMessage,
  ) => Promise<{ messageId: string }>;
  onTyping?: (session: BridgeSessionState, payload: { channelId: string; agentId: string }) => void;
  onStatus?: (session: BridgeSessionState, status: BridgeStatus) => void;
  onClose?: (session: BridgeSessionState) => void;
  onRejected?: (reason: string) => void;
};

export type BridgeServerOptions = BridgeServerCallbacks & {
  token: string;
  serverVersion: string;
  ackTimeoutMs?: number;
};

export type BridgeHandle = {
  readonly namespace: Namespace<BridgeClientToServerEvents, BridgeServerToClientEvents>;
  /** 현재 ready 인 플러그인 연결 (가장 최근 1개) */
  current(): BridgeSessionState | undefined;
  waitForReady(timeoutMs: number): Promise<BridgeSessionState>;
  deliverInbound(payload: InboundDeliver, timeoutMs?: number): Promise<Result<InboundDeliverResult>>;
  setConfig(payload: ConfigSet, timeoutMs?: number): Promise<Result<ConfigSetResult>>;
  listAgents(timeoutMs?: number): Promise<Result<{ agents: Array<{ agentId: string; name?: string }> }>>;
  close(): void;
};

function errorResult(code: "TIMEOUT" | "ADAPTER_UNAVAILABLE", message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

export function attachBridge(io: Server, opts: BridgeServerOptions): BridgeHandle {
  const namespace = io.of(BRIDGE_NAMESPACE) as unknown as Namespace<
    BridgeClientToServerEvents,
    BridgeServerToClientEvents
  >;
  const ackTimeoutMs = opts.ackTimeoutMs ?? 15_000;
  let active: { socket: BridgeSocket; session: BridgeSessionState } | undefined;
  const readyWaiters = new Set<(session: BridgeSessionState) => void>();

  namespace.use((socket, next) => {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (verifyBridgeToken(opts.token, token)) return next();
    opts.onRejected?.(`token mismatch from ${socket.handshake.address}`);
    next(new Error("UNAUTHORIZED"));
  });

  namespace.on("connection", (socket) => {
    const session = new BridgeSessionState(randomUUID());

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
      for (const resolve of readyWaiters) resolve(session);
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
      opts.onOutboundMessage(session, parsed.data).then(
        (data) => {
          session.recordOutbound(parsed.data.outboundId, data.messageId);
          ack({ ok: true, data });
        },
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
      if (session.phase !== "closed") session.close("disconnect");
      if (active?.socket.id === socket.id) active = undefined;
      opts.onClose?.(session);
    });
  });

  function requireActive(): { socket: BridgeSocket; session: BridgeSessionState } | undefined {
    return active && active.session.phase === "ready" ? active : undefined;
  }

  async function request<T>(
    emit: (socket: BridgeSocket, timeoutMs: number) => Promise<Result<T>>,
    timeoutMs: number,
  ) {
    const target = requireActive();
    if (!target) return errorResult("ADAPTER_UNAVAILABLE", "plugin not connected");
    try {
      return await emit(target.socket, timeoutMs);
    } catch (error) {
      return errorResult("TIMEOUT", String(error));
    }
  }

  return {
    namespace,
    current: () => requireActive()?.session,
    waitForReady(timeoutMs) {
      const existing = requireActive();
      if (existing) return Promise.resolve(existing.session);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          readyWaiters.delete(onReady);
          reject(new Error(`plugin hello not received within ${timeoutMs}ms`));
        }, timeoutMs);
        const onReady = (session: BridgeSessionState) => {
          clearTimeout(timer);
          resolve(session);
        };
        readyWaiters.add(onReady);
      });
    },
    deliverInbound: (payload, timeoutMs = ackTimeoutMs) =>
      request(
        (socket, ms) =>
          socket.timeout(ms).emitWithAck("inbound.deliver", payload) as Promise<Result<InboundDeliverResult>>,
        timeoutMs,
      ),
    setConfig: (payload, timeoutMs = ackTimeoutMs) =>
      request(
        (socket, ms) =>
          socket.timeout(ms).emitWithAck("config.set", payload) as Promise<Result<ConfigSetResult>>,
        timeoutMs,
      ),
    listAgents: (timeoutMs = ackTimeoutMs) =>
      request(
        (socket, ms) =>
          socket.timeout(ms).emitWithAck("agents.list", {}) as Promise<
            Result<{ agents: Array<{ agentId: string; name?: string }> }>
          >,
        timeoutMs,
      ),
    close() {
      if (active) {
        active.session.close("shutdown");
        active.socket.emit("system.notice", { reason: "shutdown", message: "server shutting down" });
      }
      namespace.disconnectSockets(true);
    },
  };
}
