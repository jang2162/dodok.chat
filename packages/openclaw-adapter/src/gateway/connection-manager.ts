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
import { parseApprovalReplay, type ProviderApproval } from "./approvals";
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
  /** 받은 `hello-ok` 중 로그에 싣는 것. `server.version` 은 프로토콜 스키마의 필수 필드다(ADR 0001) */
  readonly hello?: { readonly server: { readonly version: string; readonly buildId?: string } };
};

export type GatewayConnector = (options: GatewayConnectOptions) => Promise<GatewayLink>;

export type GatewayState = "down" | "reconnecting" | "connected";

/**
 * 설정 마법사가 보여 줄 연결 상세. `version` 은 마지막으로 붙은 Gateway 의 hello-ok `server.version`,
 * `pairing` 은 아직 승인되지 않은 페어링 요청(`since` 는 그 requestId 를 처음 본 시각) — 다음 성공 접속에서 지운다.
 * requestId 를 주지 않은 페어링 오류는 빈 문자열로 남긴다(요청이 있다는 사실은 보여야 한다).
 */
export type GatewayDetail = {
  version: string | null;
  pairing: { requestId: string; since: string } | null;
};

const UNKNOWN_HOST = "(알 수 없음)";
const DEFAULT_PORTS: Record<string, string> = { "ws:": "80", "wss:": "443", "http:": "80", "https:": "443" };

/**
 * Gateway URL 에서 화면·API 에 내도 되는 부분 — `호스트:포트` 만. 자격 증명·경로·쿼리는 버린다.
 * 파싱이 안 되면 고정값이다 — 원문에 자격 증명이 들 수 있어 그대로 싣지 않는다.
 */
export function gatewayHost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return UNKNOWN_HOST;
  }
  if (!parsed.hostname) return UNKNOWN_HOST;
  const port = parsed.port || DEFAULT_PORTS[parsed.protocol];
  return port ? `${parsed.hostname}:${port}` : parsed.hostname;
}

export type RecoverTarget = { sessionKey: string; agentId: string; cursor?: string };

export type ConnectionManagerOptions = {
  gateway: { url: string; token: string; deviceIdentityPath: string; deviceTokenStorePath?: string };
  connector: GatewayConnector;
  logger: AdapterLogger;
  onEvent: (frame: EventFrame) => void;
  onState: (state: GatewayState) => void;
  /** `detail()` 이 바뀔 때(페어링 시작·requestId 변경·해소, 새 버전) 한 번 */
  onDetail?: (detail: GatewayDetail) => void;
  sessionKeysToRecover?: () => RecoverTarget[];
  /** 세션 구독 응답의 `approvalReplay`(미해결 승인) — 재접속 되감기(스파이크 5.3). 없으면 부르지 않는다. */
  onApprovalReplay?: (approvals: ProviderApproval[]) => void;
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
  detail(): GatewayDetail;
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  /**
   * 현재 연결에서 아직 구독하지 않은 세션이면 `sessions.messages.subscribe { key, agentId, includeApprovals }` 를 보낸다(연결당 한 번).
   * 실물 Gateway 는 구독한 세션의 chat·agent·session.message 만 보낸다 — 접속 뒤 새로 생긴 세션은 recover() 가 모르므로 전송 전에 부른다.
   * 연결이 없으면 ADAPTER_UNAVAILABLE.
   */
  subscribeSession(sessionKey: string, agentId: string): Promise<void>;
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
  // 현재 연결에서 sessions.messages.subscribe 를 보낸 세션 키. 새 연결·stop 에서 비운다
  const subscribed = new Set<string>();
  let detail: GatewayDetail = { version: null, pairing: null };

  /** `includeApprovals` 를 켜야 그 세션의 `session.approval` 과 구독 응답의 되감기가 온다(스파이크 3.1·5.3). */
  function subscribeParams(sessionKey: string, agentId: string) {
    return { key: sessionKey, agentId, includeApprovals: true };
  }

  /** 구독 응답에 미해결 승인이 있으면 흘린다. 없으면 조용히 지나간다. */
  function replayApprovals(result: unknown) {
    if (!opts.onApprovalReplay) return;
    const approvals = parseApprovalReplay(result);
    if (approvals.length > 0) opts.onApprovalReplay(approvals);
  }

  function setState(next: GatewayState) {
    if (state === next) return;
    state = next;
    opts.onState(next);
  }

  function setDetail(next: GatewayDetail) {
    const same =
      next.version === detail.version &&
      next.pairing?.requestId === detail.pairing?.requestId &&
      next.pairing?.since === detail.pairing?.since;
    if (same) return;
    detail = next;
    opts.onDetail?.({ ...detail });
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
        const requestId = error.requestId ?? "";
        const since =
          detail.pairing?.requestId === requestId ? detail.pairing.since : new Date().toISOString();
        setDetail({ version: detail.version, pairing: { requestId, since } });
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
    // 원격 Gateway 의 실제 버전 — 플러그인이 보내는 sdkVersion(빌드 때 박힌 상수)과 다르다.
    // 같은 버전 문자열의 두 빌드(9.4 3a9d69d·9.5 f396007)를 가른 것은 buildId 다(스키마 선택 필드)
    logger.info(
      {
        scopes: DEFAULT_GATEWAY_SCOPES,
        gatewayVersion: next.hello?.server.version ?? null,
        gatewayBuildId: next.hello?.server.buildId ?? null,
      },
      "gateway connected",
    );
    setDetail({ version: next.hello?.server.version ?? null, pairing: null });
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
    subscribed.clear();
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
        replayApprovals(await call("sessions.messages.subscribe", subscribeParams(sessionKey, agentId)));
        subscribed.add(sessionKey);
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
      subscribed.clear();
      setState("down");
      if (current) await current.stop();
    },
    state: () => state,
    detail: () => ({ ...detail }),
    async subscribeSession(sessionKey, agentId) {
      const current = link;
      if (!current) {
        throw new AdapterError("ADAPTER_UNAVAILABLE", "sessions.messages.subscribe: gateway not connected");
      }
      if (subscribed.has(sessionKey)) return;
      let result: unknown;
      try {
        result = await current.request("sessions.messages.subscribe", subscribeParams(sessionKey, agentId), {
          timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        throw toAdapterError("sessions.messages.subscribe", error);
      }
      subscribed.add(sessionKey);
      replayApprovals(result);
    },
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
