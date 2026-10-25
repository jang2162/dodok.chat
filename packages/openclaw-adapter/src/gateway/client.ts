/**
 * `@openclaw/gateway-client` 최소 래퍼.
 *
 * 책임은 셋뿐이다.
 *  (a) `hostDeps` 구현 — 디바이스 아이덴티티·디바이스 토큰 보관, 챌린지 서명, PEM → raw base64url 공개키.
 *      라이브러리는 OpenClaw 의 로컬 자격 증명을 스스로 읽지 않으므로 전부 호스트가 준다.
 *  (b) 연결 — `hello-ok` 를 기다려 돌려준다. 페어링 미승인은 `GatewayPairingRequiredError` 로 올린다.
 *  (c) 이벤트 구독·요청 호출 통로.
 *
 * 재접속·세션 프로젝션·승인 처리는 여기서 하지 않는다 — 재접속 루프는 `connection-manager.ts`, 이벤트 매핑은 `events.ts`.
 */
import { GatewayClient } from "@openclaw/gateway-client";
import type {
  DeviceAuthTokenRecord,
  GatewayClientHostDeps,
  GatewayClientRequestOptions,
} from "@openclaw/gateway-client";
import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol";
import {
  readConnectErrorDetailCode,
  readPairingConnectErrorDetails,
} from "@openclaw/gateway-protocol/connect-error-details";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type DeviceIdentity,
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "./device-identity";

/** Gateway 가 페어링 승인을 요구할 때 던진다. `requestId` 가 사람이 승인할 대상이다. */
export class GatewayPairingRequiredError extends Error {
  readonly requestId: string | undefined;
  readonly reason: string | undefined;
  readonly deviceId: string | undefined;
  readonly details: unknown;

  constructor(params: {
    cause: unknown;
    deviceId?: string | undefined;
    details: unknown;
    message: string;
    reason?: string | undefined;
    requestId?: string | undefined;
  }) {
    super(params.message, { cause: params.cause });
    this.name = "GatewayPairingRequiredError";
    this.requestId = params.requestId;
    this.reason = params.reason;
    this.deviceId = params.deviceId;
    this.details = params.details;
  }
}

type StoredDeviceTokens = Record<string, { scopes: string[]; token: string }>;

function deviceTokenKey(deviceId: string, role: string): string {
  return `${deviceId}:${role}`;
}

/** 디바이스 토큰 저장소 — 아이덴티티 파일과 같은 디렉터리의 JSON 한 장. */
function createDeviceTokenStore(storePath: string) {
  const read = (): StoredDeviceTokens => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(storePath, "utf8"));
      return typeof parsed === "object" && parsed !== null ? (parsed as StoredDeviceTokens) : {};
    } catch {
      return {};
    }
  };
  const write = (value: StoredDeviceTokens): void => {
    const directory = dirname(storePath);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    const temporaryPath = join(directory, `.${Date.now()}-${process.pid}.tokens.tmp`);
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, storePath);
  };
  return { read, write };
}

/** 라이브러리가 요구하는 호스트 의존성 전체. 이름은 `GatewayClientHostDeps` 실물을 따른다. */
export function createGatewayHostDeps(params: {
  deviceIdentityPath: string;
  deviceTokenStorePath?: string;
  logDebug?: (message: string) => void;
  logError?: (message: string) => void;
}): GatewayClientHostDeps {
  const storePath =
    params.deviceTokenStorePath ?? join(dirname(params.deviceIdentityPath), "openclaw-device-tokens.json");
  const store = createDeviceTokenStore(storePath);
  return {
    clearDeviceAuthToken: ({ deviceId, role }) => {
      const tokens = store.read();
      delete tokens[deviceTokenKey(deviceId, role)];
      store.write(tokens);
    },
    loadDeviceAuthToken: ({ deviceId, role }): DeviceAuthTokenRecord | null =>
      store.read()[deviceTokenKey(deviceId, role)] ?? null,
    loadOrCreateDeviceIdentity: () => loadOrCreateDeviceIdentity(params.deviceIdentityPath),
    publicKeyRawBase64UrlFromPem,
    signDevicePayload,
    storeDeviceAuthToken: ({ deviceId, role, scopes, token }) => {
      const tokens = store.read();
      tokens[deviceTokenKey(deviceId, role)] = { scopes, token };
      store.write(tokens);
    },
    ...(params.logDebug ? { logDebug: params.logDebug } : {}),
    ...(params.logError ? { logError: params.logError } : {}),
  };
}

/**
 * 서버 코어 스펙 6.2(계획서 #15). 어댑터가 부르는 메서드 가운데 operator.admin 이 필요한 것은 확인되지 않았다(그 스코프를 쓰던
 * sessions.reset 은 부르지 않는다) — 빼기 전에 ADR 0003 의 `originating*` 거절 조건과 ADR 0001 의 스코프 표를 다시 잰다.
 */
export const DEFAULT_GATEWAY_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
];
/** `tool-events` 를 선언해야 agent tool 스트림이 온다(ADR 0001 5.4). */
export const DEFAULT_GATEWAY_CAPS = ["tool-events", "approvals", "session-scoped-events"];

export type GatewayConnectOptions = {
  caps?: string[];
  clientDisplayName?: string;
  clientVersion?: string;
  /** hello-ok 를 기다리는 상한. 넘으면 연결을 끊고 거절한다. */
  connectTimeoutMs?: number;
  deviceIdentityPath: string;
  deviceTokenStorePath?: string;
  instanceId?: string;
  /**
   * `hello-ok` 뒤 연결이 끊겼을 때 한 번. 라이브러리는 스스로 재접속하려 하지만 호출자가 `stop()` 하고 새로 붙는 것을 전제로 한다.
   * 우리가 `stop()` 한 뒤의 종료와 hello 전 종료(연결 실패는 `connectGateway` 의 reject 로 간다)는 전달하지 않는다.
   */
  onClose?: (info: { code: number; reason: string }) => void;
  onEvent?: (event: EventFrame) => void;
  role?: string;
  scopes?: string[];
  token?: string;
  url: string;
};

/** 연결된 Gateway 한 개. `hello` 가 그 Gateway 가 실제로 지원하는 것의 진실이다. */
export class GatewayConnection {
  readonly hello: HelloOk;
  readonly identity: DeviceIdentity;
  private readonly client: GatewayClient;
  private readonly listeners: Set<(event: EventFrame) => void>;
  private readonly onStop: (() => void) | undefined;

  constructor(params: {
    client: GatewayClient;
    hello: HelloOk;
    identity: DeviceIdentity;
    listeners: Set<(event: EventFrame) => void>;
    onStop?: () => void;
  }) {
    this.client = params.client;
    this.hello = params.hello;
    this.identity = params.identity;
    this.listeners = params.listeners;
    this.onStop = params.onStop;
  }

  /** hello-ok 이후에만 부른다. `timeoutMs: null` 이면 무기한. */
  request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    options?: GatewayClientRequestOptions,
  ): Promise<T> {
    return this.client.request<T>(method, params, options);
  }

  /** 반환된 함수를 부르면 구독이 끊긴다. */
  subscribe(listener: (event: EventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async stop(): Promise<void> {
    this.onStop?.();
    this.listeners.clear();
    await this.client.stopAndWait({ timeoutMs: 5_000 });
  }
}

function toPairingError(error: unknown): GatewayPairingRequiredError | null {
  const details = (error as { details?: unknown }).details;
  const pairing = readPairingConnectErrorDetails(details);
  if (!pairing && readConnectErrorDetailCode(details) !== "PAIRING_REQUIRED") return null;
  return new GatewayPairingRequiredError({
    cause: error,
    deviceId: pairing?.deviceId,
    details,
    message: error instanceof Error ? error.message : "pairing required",
    reason: pairing?.reason,
    requestId: pairing?.requestId,
  });
}

/**
 * 접속해서 `hello-ok` 를 받을 때까지 기다린다.
 *
 * 라이브러리는 실패해도 스스로 재접속하지만, 여기서는 첫 실패를 그대로 올리고 클라이언트를 닫는다 —
 * 페어링 승인 대기는 호출자가 눈에 보이는 주기로 다시 부르는 편이 진단하기 쉽다.
 */
export async function connectGateway(options: GatewayConnectOptions): Promise<GatewayConnection> {
  const listeners = new Set<(event: EventFrame) => void>();
  if (options.onEvent) listeners.add(options.onEvent);

  const hostDeps = createGatewayHostDeps({
    deviceIdentityPath: options.deviceIdentityPath,
    ...(options.deviceTokenStorePath ? { deviceTokenStorePath: options.deviceTokenStorePath } : {}),
  });
  const identity = loadOrCreateDeviceIdentity(options.deviceIdentityPath);
  let stopRequested = false;
  let resolveHello: (hello: HelloOk) => void = () => undefined;
  let rejectHello: (error: unknown) => void = () => undefined;
  // lib 은 ES2022 라 Promise.withResolvers 를 쓸 수 없다.
  const helloPromise = new Promise<HelloOk>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });

  const client = new GatewayClient({
    caps: options.caps ?? DEFAULT_GATEWAY_CAPS,
    clientDisplayName: options.clientDisplayName ?? "dodok",
    clientName: "gateway-client",
    clientVersion: options.clientVersion ?? "0.0.0",
    hostDeps,
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
    maxProtocol: PROTOCOL_VERSION,
    minProtocol: PROTOCOL_VERSION,
    mode: "backend",
    // notifyStoppedClose 라 우리가 stop 해도 불린다 — stopRequested 로 거른다.
    onClose: (code, reason, info) => {
      if (!stopRequested && info?.phase === "post-hello") options.onClose?.({ code, reason });
    },
    onConnectError: (error) => {
      rejectHello(toPairingError(error) ?? error);
    },
    onEvent: (event) => {
      for (const listener of listeners) listener(event);
    },
    onHelloOk: (hello) => {
      resolveHello(hello);
    },
    platform: process.platform,
    role: options.role ?? "operator",
    scopes: options.scopes ?? DEFAULT_GATEWAY_SCOPES,
    ...(options.token ? { token: options.token } : {}),
    url: options.url,
  });

  const timeoutMs = options.connectTimeoutMs ?? 30_000;
  const timer = setTimeout(() => {
    rejectHello(new Error(`gateway hello-ok timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  client.start();
  try {
    const hello = await helloPromise;
    return new GatewayConnection({
      client,
      hello,
      identity,
      listeners,
      onStop: () => {
        stopRequested = true;
      },
    });
  } catch (error) {
    stopRequested = true;
    await client.stopAndWait({ timeoutMs: 5_000 }).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
