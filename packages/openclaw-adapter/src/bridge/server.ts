/**
 * 플러그인이 아웃바운드로 붙는 브리지 엔드포인트 — Socket.IO 네임스페이스 `/bridge`.
 *
 * 최소 표면: 토큰 인증(handshake `auth.token` 을 검증 함수에 넘긴다 — 통과한 토큰 id 와 그 토큰의 Gateway 를 세션이 기억한다), 플러그인 → 서버 이벤트
 * (`hello`·`outbound.message`·`outbound.typing`·`status`) 수신, 서버 → 플러그인 요청
 * (`inbound.deliver`·`config.set`·`agents.list`) 송신. 저장·라우팅 같은 런타임 로직은 콜백으로 밖에 둔다.
 * 네임스페이스는 하나이고 Gateway 마다 자리(`forGateway`)를 따로 둔다 — 「활성 플러그인 하나」·중복 흡수·ready 대기는 그 자리 안에서만
 * 오간다(멀티 Gateway 스펙 5.2).
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
import type { BridgeAuthGuard } from "./guard";
import { BridgeSessionState, OutboundDedupe, parseBridgeClientEvent, RejectLogThrottle } from "./session";

export const BRIDGE_NAMESPACE = "/bridge";

export type BridgeSocket = Socket<BridgeClientToServerEvents, BridgeServerToClientEvents>;

export type BridgeServerCallbacks = {
  onHello?: (session: BridgeSessionState, hello: BridgeHello) => void;
  /**
   * 저장하고 서버 메시지 id 를 돌려준다. 같은 `outboundId` 는 그 Gateway 자리가 기억하는 최근 1,000개 안에서
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

/** 핸드셰이크 `auth.token`(외부 입력 그대로)을 보고 통과면 그 토큰의 id 와 그 토큰이 묶인 Gateway, 아니면 null */
export type BridgeTokenVerifier = (presented: unknown) => { tokenId: string; gatewayId: string } | null;

export type BridgeServerOptions = BridgeServerCallbacks & {
  verifyToken: BridgeTokenVerifier;
  /**
   * 그 Gateway 의 플러그인을 받는가 — 켜진 Gateway 만 참. 거짓이면 핸드셰이크·hello 를 토큰 틀림과 같은 경로로 거절한다
   * (멀티 Gateway 스펙 8장). 실패 카운터는 세지 않는다 — 꺼진 Gateway 의 플러그인은 자기 백오프로 계속 다시 붙는데, 그걸 세면
   * 같은 호스트의 다른 Gateway 플러그인까지 주소째 막힌다
   */
  acceptGateway: (gatewayId: string) => boolean;
  serverVersion: string;
  ackTimeoutMs?: number;
  /** 거절 로그 스로틀의 시계(ms) — 테스트 주입. 기본 `Date.now` */
  now?: () => number;
  /**
   * 거절 로그·스로틀의 원격 주소. 기본 `handshake.address`. 리버스 프록시 뒤면 서버가 믿을 수 있는 경우에만
   * 전달 헤더를 읽어 준다(믿지 않는 헤더를 읽으면 위조로 스로틀·귀속을 우회한다). 던지면 기본값을 쓴다
   */
  clientAddress?: (handshake: BridgeSocket["handshake"]) => string;
  /**
   * 거절 로그(`onRejected`)에 싣는 주소 꼴 — 서버가 IP 를 가려 준다. 기본은 주소 그대로. 스로틀·실패 카운터는 원래 주소를 쓴다
   */
  logAddress?: (address: string) => string;
  /**
   * 인증 실패 카운터(`clientAddress` 주소별, 시계는 `now`). 막힌 주소는 토큰을 보지 않고 거절하고, 검증 실패만 센다 —
   * 성공은 카운터를 건드리지 않는다. 서버의 첨부 HTTP 인증도 같은 인스턴스를 받는다
   */
  authGuard?: BridgeAuthGuard;
  /** 이번 실패로 그 주소가 막히기 시작했을 때 한 번 */
  onBlocked?: (address: string) => void;
};

/** Gateway 하나의 브리지 자리. `forGateway` 가 같은 id 에 늘 같은 객체를 준다(테스트가 메서드를 감시할 수 있게) */
export type GatewayBridge = {
  readonly gatewayId: string;
  /** 그 Gateway 의 ready 인 플러그인 연결 (가장 최근 1개) */
  current(): BridgeSessionState | undefined;
  waitForReady(timeoutMs: number): Promise<BridgeSessionState>;
  deliverInbound(payload: InboundDeliver, timeoutMs?: number): Promise<Result<InboundDeliverResult>>;
  /**
   * 그 전송(`deliveryId`)의 ack 대기를 곧바로 ADAPTER_UNAVAILABLE 로 끝낸다 — 연결을 닫으며 그 런을 닫을 때. 플러그인에 이미 간
   * 프레임은 되돌리지 못한다(그 런은 부르는 쪽이 chat.abort 로 멈춘다)
   */
  abandonDelivery(deliveryId: string): void;
  setConfig(payload: ConfigSet, timeoutMs?: number): Promise<Result<ConfigSetResult>>;
  listAgents(timeoutMs?: number): Promise<Result<{ agents: Array<{ agentId: string; name?: string }> }>>;
};

export type BridgeHandle = {
  readonly namespace: Namespace<BridgeClientToServerEvents, BridgeServerToClientEvents>;
  forGateway(gatewayId: string): GatewayBridge;
  /** 그 토큰으로 통과한 연결(hello 전 포함)을 모두 끊고 끊은 수를 돌려준다 — 토큰 폐기 때 */
  revokeSessions(tokenId: string): number;
  /**
   * 그 Gateway 의 연결(hello 전 포함)을 모두 끊고 ready 대기·ack 를 기다리는 inbound.deliver 를 끝낸다 — Gateway 끄기·삭제 때. `forget` 이면 자리(중복 흡수 기억)도
   * 버린다(삭제). 끊은 수를 돌려준다
   */
  disconnectGateway(gatewayId: string, opts?: { forget?: boolean }): number;
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

type Live = { socket: BridgeSocket; session: BridgeSessionState };

/** Gateway 하나의 자리 — 활성 플러그인·ready 대기·중복 흡수·처리 중인 정본 */
type Slot = {
  view: GatewayBridge;
  active: Live | undefined;
  // close() 가 끊을 수 있도록 resolve 와 reject 를 함께 둔다(둘 다 자기 타이머를 지운다)
  readyWaiters: Set<{ resolve: (session: BridgeSessionState) => void; reject: (error: Error) => void }>;
  // 중복 흡수는 연결이 아니라 Gateway(플러그인 id) 단위 — 플러그인은 ack 를 못 받은 head 를 재연결 뒤 같은 outboundId 로 다시 보낸다
  dedupe: OutboundDedupe;
  inflight: Map<string, Promise<{ messageId: string }>>;
  // ack 를 기다리는 inbound.deliver(`deliveryId` → 끝내기). 소켓을 끊어도 socket.io 의 ack 대기는 제한시간까지 남는다
  deliveries: Map<string, (result: Result<never>) => void>;
};

export function attachBridge(io: Server, opts: BridgeServerOptions): BridgeHandle {
  const namespace = io.of(BRIDGE_NAMESPACE) as unknown as Namespace<
    BridgeClientToServerEvents,
    BridgeServerToClientEvents
  >;
  const ackTimeoutMs = opts.ackTimeoutMs ?? 15_000;
  const slots = new Map<string, Slot>();
  // hello 전 연결까지 — 폐기는 hello 여부와 무관하게 그 토큰의 연결을 전부 끊는다
  const connections = new Map<string, Live>();
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

  const requireActive = (slot: Slot): Live | undefined =>
    slot.active && slot.active.session.phase === "ready" ? slot.active : undefined;

  function slotOf(gatewayId: string): Slot {
    const existing = slots.get(gatewayId);
    if (existing) return existing;
    const slot: Slot = {
      view: undefined as unknown as GatewayBridge,
      active: undefined,
      readyWaiters: new Set(),
      dedupe: new OutboundDedupe(),
      inflight: new Map(),
      deliveries: new Map(),
    };
    slot.view = gatewayView(gatewayId, slot);
    slots.set(gatewayId, slot);
    return slot;
  }

  function rejectWaiters(slot: Slot, message: string) {
    for (const waiter of slot.readyWaiters) waiter.reject(new Error(message));
    slot.readyWaiters.clear();
    for (const end of slot.deliveries.values()) end(errorResult("ADAPTER_UNAVAILABLE", message));
    slot.deliveries.clear();
  }

  namespace.use((socket, next) => {
    const address = remoteAddress(socket.handshake);
    const at = now();
    const reject = (reason: string) => {
      // 폐기된 토큰으로 재접속을 되풀이하는 플러그인이 로그를 채우지 않게 주소별로 줄인다(Review Focus 2)
      const logged = rejectLog.take(address, at);
      if (logged) {
        const suppressed = logged.suppressed > 0 ? ` (${logged.suppressed} more suppressed)` : "";
        const shown = opts.logAddress ? opts.logAddress(address) : address;
        opts.onRejected?.(`${reason} from ${shown}${suppressed}`);
      }
      next(new Error("UNAUTHORIZED"));
    };
    if (opts.authGuard?.isBlocked(address, at)) return reject("blocked after repeated failures");
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    let verified: { tokenId: string; gatewayId: string } | null;
    try {
      verified = opts.verifyToken(token);
    } catch {
      // 검증 함수 오류(저장소 등)는 거절로 본다 — 거절 로그 한 줄이 남는다. 플러그인 잘못이 아니라 실패로 세지 않는다
      return reject("token mismatch");
    }
    if (verified) {
      if (!opts.acceptGateway(verified.gatewayId)) return reject("token mismatch");
      const data = socket.data as { tokenId?: string; gatewayId?: string };
      data.tokenId = verified.tokenId;
      data.gatewayId = verified.gatewayId;
      return next();
    }
    if (opts.authGuard?.fail(address, at)) opts.onBlocked?.(address);
    reject("token mismatch");
  });

  namespace.on("connection", (socket) => {
    const { tokenId, gatewayId } = socket.data as { tokenId?: string; gatewayId?: string };
    if (gatewayId === undefined) {
      // 미들웨어를 지난 소켓에는 늘 있다 — 없으면 받을 자리가 없다
      socket.disconnect(true);
      return;
    }
    const slot = slotOf(gatewayId);
    const session = new BridgeSessionState(randomUUID(), {
      dedupe: slot.dedupe,
      gatewayId,
      ...(tokenId === undefined ? {} : { tokenId }),
    });
    connections.set(socket.id, { socket, session });

    socket.on("hello", (payload, ack) => {
      const parsed = parseBridgeClientEvent("hello", payload);
      if (!parsed.ok) return ack(parsed);
      // 핸드셰이크와 hello 사이에 그 Gateway 가 꺼졌을 수 있다
      if (!opts.acceptGateway(gatewayId)) {
        ack({ ok: false, error: { code: "UNAUTHORIZED", message: "gateway is not enabled" } });
        socket.disconnect(true);
        return;
      }
      try {
        session.onHello(parsed.data);
      } catch (error) {
        return ack({ ok: false, error: { code: "CONFLICT", message: String(error) } });
      }
      // 플러그인 연결은 Gateway 마다 하나만 유지한다 — 새 연결이 이기고 이전 연결에는 알린다. 다른 Gateway 의 연결은 건드리지 않는다
      const previous = slot.active;
      if (previous && previous.socket.id !== socket.id) {
        previous.session.close("replaced");
        previous.socket.emit("system.notice", { reason: "replaced", message: "newer plugin connection" });
        previous.socket.disconnect(true);
      }
      slot.active = { socket, session };
      ack({ ok: true, data: { serverVersion: opts.serverVersion, protocol: BRIDGE_PROTOCOL } });
      opts.onHello?.(session, parsed.data);
      for (const waiter of slot.readyWaiters) waiter.resolve(session);
      slot.readyWaiters.clear();
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
      let pending = slot.inflight.get(outboundId);
      if (!pending) {
        pending = opts
          .onOutboundMessage(session, parsed.data)
          .then((data) => {
            session.recordOutbound(outboundId, data.messageId);
            return data;
          })
          .finally(() => slot.inflight.delete(outboundId));
        slot.inflight.set(outboundId, pending);
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
      if (slot.active?.socket.id === socket.id) slot.active = undefined;
      opts.onClose?.(session);
    });
  });

  async function request<T>(
    slot: Slot,
    schema: z.ZodType<T>,
    emit: (socket: BridgeSocket, timeoutMs: number) => Promise<unknown>,
    timeoutMs: number,
  ): Promise<Result<T>> {
    const target = requireActive(slot);
    if (!target) return errorResult("ADAPTER_UNAVAILABLE", "plugin not connected");
    let raw: unknown;
    try {
      raw = await emit(target.socket, timeoutMs);
    } catch (error) {
      return errorResult("TIMEOUT", String(error));
    }
    return parseAck(schema, raw);
  }

  function gatewayView(gatewayId: string, slot: Slot): GatewayBridge {
    return {
      gatewayId,
      current: () => requireActive(slot)?.session,
      waitForReady(timeoutMs) {
        const existing = requireActive(slot);
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
            slot.readyWaiters.delete(waiter);
            reject(new Error(`plugin hello not received within ${timeoutMs}ms`));
          }, timeoutMs);
          slot.readyWaiters.add(waiter);
        });
      },
      deliverInbound(payload, timeoutMs = ackTimeoutMs) {
        let end!: (result: Result<never>) => void;
        const ended = new Promise<Result<never>>((resolve) => {
          end = resolve;
        });
        slot.deliveries.set(payload.deliveryId, end);
        const acked = request(
          slot,
          InboundDeliverResult,
          (socket, ms) => socket.timeout(ms).emitWithAck("inbound.deliver", payload),
          timeoutMs,
        );
        return Promise.race([acked, ended]).finally(() => {
          if (slot.deliveries.get(payload.deliveryId) === end) slot.deliveries.delete(payload.deliveryId);
        });
      },
      abandonDelivery(deliveryId) {
        slot.deliveries.get(deliveryId)?.(errorResult("ADAPTER_UNAVAILABLE", "delivery abandoned"));
        slot.deliveries.delete(deliveryId);
      },
      setConfig: (payload, timeoutMs = ackTimeoutMs) =>
        request(
          slot,
          ConfigSetResult,
          (socket, ms) => socket.timeout(ms).emitWithAck("config.set", payload),
          timeoutMs,
        ),
      listAgents: (timeoutMs = ackTimeoutMs) =>
        request(
          slot,
          AgentsListAck,
          (socket, ms) => socket.timeout(ms).emitWithAck("agents.list", {}),
          timeoutMs,
        ),
    };
  }

  return {
    namespace,
    forGateway: (gatewayId) => slotOf(gatewayId).view,
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
    disconnectGateway(gatewayId, { forget = false } = {}) {
      let count = 0;
      for (const { socket, session } of connections.values()) {
        if (session.gatewayId !== gatewayId) continue;
        count += 1;
        session.close("gateway_off");
        socket.disconnect(true);
      }
      const slot = slots.get(gatewayId);
      if (slot) {
        rejectWaiters(slot, "gateway disconnected");
        if (forget) slots.delete(gatewayId);
      }
      return count;
    },
    close() {
      for (const slot of slots.values()) {
        rejectWaiters(slot, "bridge closed");
        if (slot.active) {
          slot.active.session.close("shutdown");
          slot.active.socket.emit("system.notice", { reason: "shutdown", message: "server shutting down" });
        }
      }
      namespace.disconnectSockets(true);
    },
  };
}
