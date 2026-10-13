/**
 * 서버 브리지로의 아웃바운드 Socket.IO 접속. 플러그인은 Gateway 호스트 안에서 돌고, 포트를 열지 않고 서버로 나간다.
 *
 * - URL 은 `<origin>/bridge` — 오리진 + 네임스페이스 `/bridge`. HTTP 경로는 Socket.IO 기본값 `/socket.io/` 다.
 * - 토큰은 handshake `auth.token`.
 * - 연결 → `hello` ack(`BridgeHelloResult`) → ready → 큐 flush. 재연결은 지수 백오프(`bridge-queue.ts`).
 *   flush 중 ack 타임아웃이면 끊고 같은 경로(재연결 → hello → flush)로 head 부터 다시 보낸다 — 서버는 `outboundId` 로 중복을 흡수한다.
 * - 경계 입력(서버가 보낸 이벤트)은 shared Zod 스키마로 파싱한다.
 *
 * `openclaw` 를 import 하지 않는다.
 */
import {
  BRIDGE_PROTOCOL,
  BridgeHelloResult,
  CONTROL_CALL_TIMEOUT_MS,
  ConfigSet,
  ControlResult,
  InboundDeliver,
  OutboundMessage,
  type ApiError,
  type BridgeClientToServerEvents,
  type BridgeControlCall,
  type BridgeHello,
  type BridgeServerToClientEvents,
  type ConfigSetResult,
  type ControlUnknownResult,
  type InboundDeliverResult,
  type Result,
} from "@dodok/shared";
import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import { DEFAULT_BACKOFF, OutboundQueue, backoffDelayMs, type BackoffOptions } from "./bridge-queue";

export type BridgeLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export type BridgeClientHandlers = {
  onInbound: (delivery: InboundDeliver) => Promise<InboundDeliverResult>;
  onConfigSet?: (payload: ConfigSet) => Promise<ConfigSetResult>;
  onAgentsList?: () => Promise<{ agents: Array<{ agentId: string; name?: string }> }>;
  onNotice?: (notice: { reason: "replaced" | "shutdown"; message: string }) => void;
  onReady?: (result: BridgeHelloResult) => void;
};

export type BridgeClientOptions = {
  url: string;
  token: string;
  hello: BridgeHello;
  handlers: BridgeClientHandlers;
  logger: BridgeLogger;
  ackTimeoutMs?: number;
  maxQueue?: number;
  backoff?: BackoffOptions;
  /** 테스트용 — 기본은 socket.io-client `io()` */
  connectSocket?: (url: string, options: Partial<ManagerOptions & SocketOptions>) => BridgeSocket;
};

export type BridgeClientState = "idle" | "connecting" | "ready" | "stopped";

type QueuedOutbound = {
  payload: OutboundMessage;
  resolve: (value: { messageId: string }) => void;
  reject: (error: Error) => void;
};

type BridgeSocket = Socket<BridgeServerToClientEvents, BridgeClientToServerEvents>;

export class BridgeRequestError extends Error {
  constructor(readonly apiError: ApiError) {
    super(`${apiError.code}: ${apiError.message}`);
  }
}

function validationError(message: string): Result<never> {
  return { ok: false, error: { code: "VALIDATION", message } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createBridgeClient(opts: BridgeClientOptions) {
  const ackTimeoutMs = opts.ackTimeoutMs ?? 15_000;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const queue = new OutboundQueue<QueuedOutbound>({ max: opts.maxQueue ?? 200 });
  let state: BridgeClientState = "idle";
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const socket: BridgeSocket = (opts.connectSocket ?? io)(opts.url, {
    autoConnect: false,
    reconnection: false, // 재연결은 아래에서 직접 — 미들웨어 거부(UNAUTHORIZED) 뒤에도 같은 백오프로 다시 시도한다
    transports: ["websocket"],
    auth: { token: opts.token },
  });

  function scheduleReconnect(reason: string): void {
    if (state === "stopped" || retryTimer) return;
    state = "connecting";
    const delay = backoffDelayMs(attempt, backoff);
    attempt += 1;
    opts.logger.warn(`dodok bridge: 재연결 ${delay}ms 후 (시도 ${attempt}, 원인 ${reason})`);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (state !== "stopped") socket.connect();
    }, delay);
  }

  async function emitOutbound(item: QueuedOutbound): Promise<void> {
    const res = (await socket.timeout(ackTimeoutMs).emitWithAck("outbound.message", item.payload)) as Result<{
      messageId: string;
    }>;
    if (res.ok) item.resolve(res.data);
    else item.reject(new BridgeRequestError(res.error));
  }

  /**
   * ack 가 안 온 head(타임아웃·끊김)에서 멈추면 연결을 끊는다. 재시도 경로는 재연결 → hello → flush 하나뿐이라
   * 같은 head 부터 순서대로 다시 나간다. 연결을 살려 두면 이후 전송이 모두 큐에만 쌓여 영구 정지한다.
   */
  async function flushQueue(): Promise<void> {
    try {
      await queue.flush(emitOutbound);
    } catch (error) {
      if (state === "stopped") return;
      opts.logger.warn(
        `dodok bridge: 큐 flush 중단 (${errorMessage(error)}), 남은 ${queue.depth}건 — 끊고 재연결 뒤 다시 보낸다`,
      );
      socket.disconnect(); // 연결돼 있으면 disconnect 핸들러가 재연결을 건다
      scheduleReconnect("flush"); // 이미 끊겨 있었다면 여기서 건다(이미 걸려 있으면 무시)
    }
  }

  function reportStatus(): void {
    if (state !== "ready") return;
    socket.emit("status", { gateway: "connected", queueDepth: queue.depth });
  }

  socket.on("connect", () => {
    void (async () => {
      try {
        const res = (await socket
          .timeout(ackTimeoutMs)
          .emitWithAck("hello", opts.hello)) as Result<BridgeHelloResult>;
        if (!res.ok) throw new BridgeRequestError(res.error);
        const result = BridgeHelloResult.parse(res.data);
        if (result.protocol !== BRIDGE_PROTOCOL) throw new Error(`protocol mismatch ${result.protocol}`);
        state = "ready";
        attempt = 0;
        opts.logger.info(`dodok bridge: ready (server ${result.serverVersion}, protocol ${result.protocol})`);
        opts.handlers.onReady?.(result);
        await flushQueue();
        reportStatus();
      } catch (error) {
        opts.logger.error(`dodok bridge: hello 실패 — ${errorMessage(error)}`);
        socket.disconnect();
        scheduleReconnect("hello");
      }
    })();
  });

  socket.on("connect_error", (error) => {
    scheduleReconnect(`connect_error ${error.message}`);
  });

  socket.on("disconnect", (reason) => {
    if (state === "stopped") return;
    state = "connecting";
    scheduleReconnect(`disconnect ${reason}`);
  });

  socket.on("inbound.deliver", (payload, ack) => {
    const parsed = InboundDeliver.safeParse(payload);
    if (!parsed.success) {
      ack(validationError(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")));
      return;
    }
    opts.handlers.onInbound(parsed.data).then(
      (data) => ack({ ok: true, data }),
      (error) => ack({ ok: false, error: { code: "INTERNAL", message: errorMessage(error) } }),
    );
  });

  socket.on("config.set", (payload, ack) => {
    const parsed = ConfigSet.safeParse(payload);
    if (!parsed.success) {
      ack(validationError(parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")));
      return;
    }
    if (!opts.handlers.onConfigSet) {
      ack({ ok: false, error: { code: "ADAPTER_UNAVAILABLE", message: "config.set 미지원" } });
      return;
    }
    opts.handlers.onConfigSet(parsed.data).then(
      (data) => ack({ ok: true, data }),
      (error) => ack({ ok: false, error: { code: "INTERNAL", message: errorMessage(error) } }),
    );
  });

  socket.on("agents.list", (_payload, ack) => {
    if (!opts.handlers.onAgentsList) {
      ack({ ok: false, error: { code: "ADAPTER_UNAVAILABLE", message: "agents.list 미지원" } });
      return;
    }
    opts.handlers.onAgentsList().then(
      (data) => ack({ ok: true, data }),
      (error) => ack({ ok: false, error: { code: "INTERNAL", message: errorMessage(error) } }),
    );
  });

  socket.on("system.notice", (notice) => {
    opts.logger.warn(`dodok bridge: system.notice ${notice.reason} — ${notice.message}`);
    opts.handlers.onNotice?.(notice);
  });

  return {
    get state(): BridgeClientState {
      return state;
    },
    get queueDepth(): number {
      return queue.depth;
    },
    start(): void {
      if (state !== "idle") return;
      state = "connecting";
      socket.connect();
    },
    async stop(): Promise<void> {
      state = "stopped";
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      socket.disconnect();
      for (const item of queue.drain()) item.reject(new Error("dodok bridge: stopped"));
    },
    /** 연결 전이면 큐에 넣고 ready 뒤에 보낸다. ack 가 오면 resolve */
    sendOutbound(message: OutboundMessage): Promise<{ messageId: string }> {
      const payload = OutboundMessage.parse(message);
      return new Promise((resolve, reject) => {
        const item: QueuedOutbound = { payload, resolve, reject };
        if (state === "ready" && queue.depth === 0) {
          emitOutbound(item).catch(reject);
          return;
        }
        const dropped = queue.push(item);
        dropped?.reject(new Error("dodok bridge: 큐 상한 초과로 버림"));
        reportStatus();
      });
    },
    /**
     * 제어 도구 호출(control.call). 큐에 넣지 않는다 — 다시 붙은 연결로 늦게 나가면 끝난 런의 이름으로 불린다. 던지지 않는다.
     * ready 가 아니면 보내지 않고 ADAPTER_UNAVAILABLE(서버에 닿지 않았다), 보낸 뒤 끊김·시간 초과는 unknown(서버가 받았을 수 있다 —
     * shared ControlUnknownResult)
     */
    async sendControl(call: BridgeControlCall): Promise<ControlResult | ControlUnknownResult> {
      if (state !== "ready") {
        return {
          ok: false,
          error: { code: "ADAPTER_UNAVAILABLE", message: "dodok 서버와 연결돼 있지 않아 보내지 않았습니다" },
        };
      }
      let raw: unknown;
      try {
        // 서버는 확인 카드를 기다리는 동안 ack 를 미룬다 — 짧은 ackTimeoutMs 가 아니라 shared CONTROL_CALL_TIMEOUT_MS
        raw = await socket.timeout(CONTROL_CALL_TIMEOUT_MS).emitWithAck("control.call", call);
      } catch {
        return { unknown: true };
      }
      const parsed = ControlResult.safeParse(raw);
      return parsed.success
        ? parsed.data
        : { ok: false, error: { code: "INTERNAL", message: "서버 응답이 계약과 다릅니다" } };
    },
    sendTyping(channelId: string, agentId: string): void {
      if (state === "ready") socket.emit("outbound.typing", { channelId, agentId });
    },
    reportStatus,
  };
}

export type BridgeClient = ReturnType<typeof createBridgeClient>;
