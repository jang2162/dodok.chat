/**
 * Gateway 연결 하나를 살려 두는 루프 — 서버 코어 스펙 6.2·8장.
 *
 * `connectGateway` 는 첫 실패를 그대로 올리므로 재시도는 여기서 한다: 페어링 요구는 짧은 고정 간격(ADR 0001 3.2 — 자동 승인이
 * 수 초 뒤 끝난다), 그 밖은 지수 백오프 + 지터. 붙을 때마다 재접속 복구(구독 + `chat.history`)를 돌리고, `hello` 뒤 끊기면
 * 이전 연결을 버리고 루프를 다시 돈다. 요청 오류는 `AdapterError` 로 바꾼다.
 */
import type { GatewayClientRequestOptions } from "@openclaw/gateway-client";
import type { EventFrame } from "@openclaw/gateway-protocol";
import { AdapterError, type AdapterLogger } from "../adapter-types";
import {
  DEFAULT_GATEWAY_CAPS,
  DEFAULT_GATEWAY_SCOPES,
  GatewayPairingRequiredError,
  type GatewayConnectOptions,
} from "./client";
import { parseChatHistory } from "./sessions";

/** 연결에서 우리가 쓰는 표면. `GatewayConnection` 이 그대로 만족한다(테스트는 대역을 준다). */
export type GatewayLink = {
  request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    options?: GatewayClientRequestOptions,
  ): Promise<T>;
  stop(): Promise<void>;
};

export type GatewayConnector = (options: GatewayConnectOptions) => Promise<GatewayLink>;

export type GatewayState = "down" | "reconnecting" | "connected";

export type RecoverTarget = { sessionKey: string; agentId: string; cursor?: string };

export type ConnectionManagerOptions = {
  gateway: { url: string; token: string; deviceIdentityPath: string; deviceTokenStorePath?: string };
  connector: GatewayConnector;
  logger: AdapterLogger;
  onEvent: (frame: EventFrame) => void;
  onState: (state: GatewayState) => void;
  sessionKeysToRecover?: () => RecoverTarget[];
  historyCursors?: Map<string, string>;
  backoff?: { initialMs?: number; maxMs?: number; pairingRetryMs?: number };
  /** 지터용 [0,1) 난수 — 테스트 주입 */
  random?: () => number;
};

export type ConnectionManager = {
  /** 세션 키 → 마지막으로 받은 `chat.history` deltaCursor */
  readonly historyCursors: Map<string, string>;
  /** 루프를 시작한다. 기다리지 않는다 — 결과는 onState 로 온다. */
  start(): void;
  stop(): Promise<void>;
  state(): GatewayState;
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const HISTORY_LIMIT = 50;

export function createConnectionManager(opts: ConnectionManagerOptions): ConnectionManager {
  const initialMs = opts.backoff?.initialMs ?? 1_000;
  const maxMs = opts.backoff?.maxMs ?? 30_000;
  const pairingRetryMs = opts.backoff?.pairingRetryMs ?? 5_000;
  const random = opts.random ?? Math.random;
  const historyCursors = opts.historyCursors ?? new Map<string, string>();
  const { logger } = opts;

  let state: GatewayState = "down";
  let running = false;
  // 시도·연결마다 올린다. 옛 시도의 늦은 결과·옛 연결의 종료 알림을 거르는 데 쓴다.
  let generation = 0;
  let failures = 0;
  let link: GatewayLink | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function setState(next: GatewayState) {
    if (state === next) return;
    state = next;
    opts.onState(next);
  }

  function backoffDelay(): number {
    const base = Math.min(initialMs * 2 ** failures, maxMs);
    failures += 1;
    return Math.round(Math.min(maxMs, base * (0.8 + 0.4 * random())));
  }

  function schedule(delayMs: number) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void attempt();
    }, delayMs);
  }

  async function attempt(): Promise<void> {
    if (!running) return;
    const gen = ++generation;
    let next: GatewayLink;
    try {
      next = await opts.connector({
        url: opts.gateway.url,
        token: opts.gateway.token,
        deviceIdentityPath: opts.gateway.deviceIdentityPath,
        ...(opts.gateway.deviceTokenStorePath
          ? { deviceTokenStorePath: opts.gateway.deviceTokenStorePath }
          : {}),
        scopes: DEFAULT_GATEWAY_SCOPES,
        caps: DEFAULT_GATEWAY_CAPS,
        clientDisplayName: "dodok-server",
        onEvent: (frame) => opts.onEvent(frame),
        onClose: (info) => onClose(gen, info),
      });
    } catch (error) {
      if (!running || gen !== generation) return;
      setState("reconnecting");
      if (error instanceof GatewayPairingRequiredError) {
        logger.warn(
          { requestId: error.requestId, reason: error.reason, delayMs: pairingRetryMs },
          "gateway pairing required; retrying",
        );
        schedule(pairingRetryMs);
      } else {
        const delayMs = backoffDelay();
        logger.warn({ err: error, attempt: failures, delayMs }, "gateway connect failed; retrying");
        schedule(delayMs);
      }
      return;
    }
    if (!running || gen !== generation) {
      // 기다리는 사이 stop 됐거나 hello 직후 끊겨 이미 다음 시도로 넘어갔다
      await next.stop().catch(() => undefined);
      return;
    }
    link = next;
    failures = 0;
    logger.info({ scopes: DEFAULT_GATEWAY_SCOPES }, "gateway connected");
    setState("connected");
    await recover(next, gen);
  }

  function onClose(gen: number, info: { code: number; reason: string }) {
    if (!running || gen !== generation) return;
    generation += 1;
    const closed = link;
    link = undefined;
    logger.warn({ code: info.code, reason: info.reason }, "gateway connection closed; reconnecting");
    setState("reconnecting");
    void closed?.stop().catch(() => undefined);
    schedule(backoffDelay());
  }

  async function recover(current: GatewayLink, gen: number) {
    const call = <T>(method: string, params: unknown) =>
      current.request<T>(method, params, { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS });
    try {
      await call("sessions.subscribe", {});
    } catch (error) {
      logger.warn({ err: toAdapterError("sessions.subscribe", error) }, "gateway sessions.subscribe failed");
    }
    let targets: RecoverTarget[];
    try {
      targets = opts.sessionKeysToRecover?.() ?? [];
    } catch (error) {
      logger.warn({ err: error }, "gateway recovery targets unavailable");
      return;
    }
    for (const target of targets) {
      if (!running || gen !== generation) return;
      const { sessionKey, agentId } = target;
      try {
        await call("sessions.messages.subscribe", { key: sessionKey, agentId });
        const cursor = target.cursor ?? historyCursors.get(sessionKey);
        const base = { sessionKey, agentId, limit: HISTORY_LIMIT };
        let history = parseChatHistory(await call("chat.history", cursor ? { ...base, cursor } : base));
        if (history.reset) {
          // 커서가 끊겼다(claude-cli 세션·compaction 등, ADR 0003 5장) — 커서 없이 꼬리 페이지를 다시 받는다
          history = parseChatHistory(await call("chat.history", base));
        }
        if (history.deltaCursor) historyCursors.set(sessionKey, history.deltaCursor);
        else historyCursors.delete(sessionKey);
        // 본문으로 메시지를 만들지 않는다 — 정본은 플러그인 경로·서버 DB 다
        logger.debug({ sessionKey, messages: history.messageCount }, "gateway session recovered");
      } catch (error) {
        logger.warn(
          { sessionKey, err: toAdapterError("session recovery", error) },
          "gateway session recovery failed",
        );
      }
    }
  }

  return {
    historyCursors,
    start() {
      if (running) return;
      running = true;
      void attempt();
    },
    async stop() {
      running = false;
      generation += 1;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      const current = link;
      link = undefined;
      setState("down");
      if (current) await current.stop();
    },
    state: () => state,
    async request<T = unknown>(
      method: string,
      params: unknown,
      timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ): Promise<T> {
      const current = link;
      if (!current) throw new AdapterError("ADAPTER_UNAVAILABLE", `${method}: gateway not connected`);
      try {
        return await current.request<T>(method, params, { timeoutMs });
      } catch (error) {
        throw toAdapterError(method, error);
      }
    },
  };
}

/** Gateway 오류 모양(`GatewayClientRequestError`·`…TimeoutError`)을 덕 타이핑으로 읽어 AdapterError 로. */
export function toAdapterError(method: string, error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  const shape = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    gatewayCode?: unknown;
    details?: unknown;
  };
  const detailCode =
    typeof shape.details === "object" && shape.details !== null
      ? (shape.details as { code?: unknown }).code
      : undefined;
  const message = `${method}: ${error instanceof Error ? error.message : String(error)}`;
  if (detailCode === "MISSING_SCOPE" || shape.code === "FORBIDDEN" || shape.gatewayCode === "FORBIDDEN") {
    return new AdapterError("FORBIDDEN", message, { cause: error });
  }
  if (shape.code === "CLIENT_TIMEOUT") return new AdapterError("TIMEOUT", message, { cause: error });
  return new AdapterError("INTERNAL", message, { cause: error });
}
