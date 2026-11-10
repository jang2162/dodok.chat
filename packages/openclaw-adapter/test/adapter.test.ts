import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactUrl, type InboundDeliver, type OutboundMessage } from "@dodok/shared";
import type { EventFrame } from "@openclaw/gateway-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdapterEvent, AdapterError, createOpenClawAdapter, type OpenClawAdapter } from "../src";
import { RECONNECT_RUN_GRACE_MS } from "../src/connection/gateway-connection";
import { GatewayPairingRequiredError, type GatewayConnectOptions } from "../src/gateway/client";
import * as f from "./fixtures/gateway-events";

// 실제 attachBridge + socket.io-client 가짜 플러그인, Gateway 는 주입한 가짜 connector. 네트워크는 루프백뿐.

const TOKEN = "bridge-test-token";
/** 어댑터가 이벤트·send 결과·정본 훅에 싣는 연결 id */
const CONNECTION_ID = "gw-1";
const OTHER_TOKEN = "bridge-other-token";
// 검증 함수가 아는 토큰 → 토큰 id
const TOKEN_IDS: Record<string, string> = { [TOKEN]: "t1", [OTHER_TOKEN]: "t2" };
const BUNDLE_SHA = "b".repeat(64);
const CH = f.CHANNEL_ID;
const STORED_MESSAGE_ID = "01a09fc9-d204-7551-89d6-38544d07a2aa";
const THREAD_ROOT = "01a09fc9-d204-7551-89d6-38544d07a2ab";
const hello = { pluginId: "dodok", version: "0.0.0", sdkVersion: "2026.9.4", capabilities: ["config.set"] };

type Responder = (params: Record<string, unknown>) => unknown;
type Ack = (res: unknown) => void;

let app: FastifyInstance;
let ioServer: Server;
let dataDir: string;
let adapter: OpenClawAdapter;
let url: string;
let events: AdapterEvent[];
let canonical: OutboundMessage[];
let canonicalResult: { messageId?: string };
let gatewayResponses: Record<string, Responder>;
let gatewayCalls: Array<{ method: string; params: unknown }>;
let connectOptions: GatewayConnectOptions | undefined;
let gatewayStop: () => Promise<void>;
/** 성공 전에 connector 가 던질 오류들(차례로) */
let connectFailures: Error[];
let gatewayHello: { server: { version: string } } | undefined;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const clients: Socket[] = [];

beforeEach(async () => {
  events = [];
  canonical = [];
  canonicalResult = { messageId: STORED_MESSAGE_ID };
  gatewayResponses = {};
  gatewayCalls = [];
  connectOptions = undefined;
  gatewayStop = async () => undefined;
  connectFailures = [];
  gatewayHello = undefined;
  app = Fastify({ logger: false });
  ioServer = new Server(app.server, { transports: ["websocket"] });
  dataDir = mkdtempSync(join(tmpdir(), "dodok-adapter-"));
  adapter = createOpenClawAdapter({
    dataDir,
    bridge: {
      io: ioServer,
      verifyToken: (presented) => {
        const tokenId = typeof presented === "string" ? TOKEN_IDS[presented] : undefined;
        return tokenId ? { tokenId, gatewayId: CONNECTION_ID } : null;
      },
      serverVersion: "test",
    },
    logger,
    onCanonical: async (message) => {
      canonical.push(message);
      return canonicalResult;
    },
    connector: async (options) => {
      const failure = connectFailures.shift();
      if (failure) throw failure;
      connectOptions = options;
      return {
        ...(gatewayHello ? { hello: gatewayHello } : {}),
        request: async (method: string, params?: unknown) => {
          gatewayCalls.push({ method, params });
          const respond = gatewayResponses[method];
          return (respond ? await respond(params as Record<string, unknown>) : {}) as never;
        },
        stop: () => gatewayStop(),
      };
    },
  });
  // 이 파일은 Gateway 하나 — 멀티 Gateway 는 multi-gateway.test.ts
  adapter.upsertGateway({
    id: CONNECTION_ID,
    name: "gateway",
    url: "wss://operator:pw@gateway.example.test/gw?t=1",
    token: "gw-token",
    enabled: true,
  });
  adapter.onEvent((e) => events.push(e));
  await app.listen({ host: "127.0.0.1", port: 0 });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/bridge`;
  // Gateway 를 더한 setup 이벤트(마이크로태스크로 모인다)는 준비 단계의 것이다 — 단언은 그 뒤 변화만 센다
  events = [];
});

afterEach(async () => {
  try {
    for (const socket of clients.splice(0)) socket.disconnect();
    await adapter.close();
    // 가짜 타이머를 버리기 전에 잰다 — close() 뒤에 어댑터·브리지가 건 대기 타이머가 남으면 안 된다
    if (vi.isFakeTimers()) await expectNoTimersLeft();
  } finally {
    vi.useRealTimers();
    ioServer.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

async function plugin(
  handlers: Record<string, (payload: never, ack: Ack) => void> = {},
  helloPayload: Record<string, unknown> = hello,
  token: string = TOKEN,
): Promise<Socket> {
  const socket = connect(url, { transports: ["websocket"], auth: { token }, reconnection: false });
  clients.push(socket);
  for (const [event, handler] of Object.entries(handlers))
    socket.on(event, handler as (...args: unknown[]) => void);
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  await socket.emitWithAck("hello", helloPayload);
  return socket;
}

const dispatchAck = (payload: InboundDeliver, ack: Ack) =>
  ack({ ok: true, data: { admission: "dispatch", providerRunId: payload.runId } });

function delivery(runId: string = f.RUN_ID): InboundDeliver {
  return {
    deliveryId: randomUUID(),
    kind: "message",
    channelId: CH,
    conversationId: CH,
    conversationTitle: "배포 점검",
    agentId: f.PROVIDER_AGENT_ID,
    sessionKey: f.SESSION_KEY,
    runId,
    message: {
      id: randomUUID(),
      author: { type: "user", handle: "me", displayName: "Me" },
      text: "ping",
      attachments: [],
      ts: new Date().toISOString(),
    },
    context: { recentMessages: [], participants: [], relayRules: "" },
    options: {},
  };
}

/** 실제 I/O 를 기다린다(가짜 타이머와 무관한 setImmediate 로 돈다). */
async function until(condition: () => boolean, label = "condition"): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * close() 뒤 가짜 타이머가 남지 않았는지 잰다. 가짜 시계는 멈춰 있으므로 어댑터·브리지의 대기 타이머(재시도·waitForReady)는
 * 스스로 사라지지 않는다. 브리지 소켓을 닫을 때 ws 가 거는 closeTimer(30s)만 TCP 가 닫히면서 지워지므로 그때까지 실제 I/O 를 돌린다.
 */
async function expectNoTimersLeft() {
  await until(() => vi.getTimerCount() === 0, "fake timers cleared").catch(() => undefined);
  expect(vi.getTimerCount(), "fake timers left after close()").toBe(0);
}

/** 이 파일의 Gateway 하나의 상태 줄 */
function gw(target: Pick<OpenClawAdapter, "status"> = adapter) {
  const [entry] = target.status().gateways;
  if (!entry) throw new Error("no gateway");
  return entry;
}

/** status 이벤트·status() 의 모양 — Gateway 하나 */
const oneGateway = (gateway: string, bridge: string) => ({
  provider: "openclaw",
  gateways: [{ id: CONNECTION_ID, name: "gateway", enabled: true, gateway, bridge }],
});

async function connectedGateway() {
  await adapter.connect();
  await until(() => gw().gateway === "connected", "gateway connected");
}

function gatewayEvent(frame: EventFrame) {
  if (!connectOptions?.onEvent) throw new Error("gateway not connected");
  connectOptions.onEvent(frame);
}

/** 그 전송의 「inbound delivered」 info 로그 — 키는 정확히 이것뿐이고 메시지 본문이 없어야 한다 */
function deliveredLines(input: InboundDeliver) {
  const lines = logger.info.mock.calls
    .filter((call) => call[1] === "inbound delivered")
    .map((call) => call[0] as Record<string, unknown>)
    .filter((line) => line.deliveryId === input.deliveryId);
  for (const line of lines) {
    expect(Object.keys(line).sort()).toEqual(
      ["ackMs", "admission", "deliveryId", "gatewayId", "retries", "runId", "waitedForPlugin"].sort(),
    );
    expect(JSON.stringify(line)).not.toContain(input.message.text);
  }
  return lines;
}

const ofKind = <K extends AdapterEvent["kind"]>(kind: K) =>
  events.filter((e): e is Extract<AdapterEvent, { kind: K }> => e.kind === kind);

describe("createOpenClawAdapter — 상태", () => {
  it("connect() 는 Gateway 루프를 시작해 gateway connected 를 알리고, close() 는 down 으로 내린다", async () => {
    expect(adapter.status()).toEqual(oneGateway("down", "down"));
    expect(adapter.capabilities()).toEqual({
      agentsList: true,
      configSet: true,
      promptEveryRun: false,
      serverSessionIds: false,
    });

    await connectedGateway();
    expect(ofKind("status").at(-1)).toEqual({
      kind: "status",
      status: oneGateway("connected", "down"),
      capabilities: {
        agentsList: true,
        configSet: true,
        promptEveryRun: false,
        serverSessionIds: false,
      },
    });

    await adapter.close();
    expect(gw().gateway).toBe("down");
    expect(ofKind("status").at(-1)?.status).toEqual(oneGateway("down", "down"));
  });

  it("플러그인 hello 로그에 gatewayVersion(runtime.version)과 빌드 때 박힌 SDK 버전을 다른 이름으로, 통과한 토큰 id 와 capabilities 를 함께 싣는다", async () => {
    await plugin({}, { ...hello, gatewayVersion: "2026.9.5" });
    await plugin({}, { ...hello, capabilities: ["config.set", "threads"] }, OTHER_TOKEN);
    const lines = logger.info.mock.calls
      .filter((call) => call[1] === "bridge plugin hello")
      .map((call) => call[0])
      .slice(-2);
    expect(lines).toEqual([
      {
        pluginVersion: "0.0.0",
        pluginBuiltWithSdk: "2026.9.4",
        gatewayVersion: "2026.9.5",
        tokenId: "t1",
        capabilities: ["config.set"],
        gatewayId: CONNECTION_ID,
      },
      {
        pluginVersion: "0.0.0",
        pluginBuiltWithSdk: "2026.9.4",
        gatewayVersion: null,
        tokenId: "t2",
        capabilities: ["config.set", "threads"],
        gatewayId: CONNECTION_ID,
      },
    ]);
  });

  it("플러그인 hello → bridge connected, 새 연결로 교체될 때는 down 을 거치지 않고, 마지막 연결이 끊기면 down", async () => {
    const first = await plugin();
    expect(gw().bridge).toBe("connected");

    await plugin();
    await until(() => first.disconnected, "replaced socket closed");
    const second = clients.at(-1);
    second?.disconnect();
    await until(() => gw().bridge === "down", "bridge down");

    expect(ofKind("status").map((e) => e.status)).toMatchObject([
      { gateways: [{ bridge: "connected" }] },
      { gateways: [{ bridge: "down" }] },
    ]);
  });

  it("sessionKeyFor 는 원형 세션 키, 스레드 루트를 주면 스레드 하위 세션 키", () => {
    expect(adapter.sessionKeyFor("dev", CH)).toBe(`agent:dev:dodok:channel:${CH}`);
    expect(adapter.sessionKeyFor("dev", CH, THREAD_ROOT)).toBe(
      `agent:dev:dodok:channel:${CH}:thread:${THREAD_ROOT}`,
    );
  });
});

describe("createOpenClawAdapter — supports", () => {
  it("붙은 플러그인이 없으면 false", () => {
    expect(adapter.supports("dev", CONNECTION_ID, "threads")).toBe(false);
  });

  it("마지막 hello 의 capabilities 를 따른다 — 옛 플러그인은 false, 새 플러그인은 true, 끊기면 false", async () => {
    const old = await plugin();
    expect(adapter.supports("dev", CONNECTION_ID, "threads")).toBe(false);

    await plugin({}, { ...hello, capabilities: ["config.set", "threads"] });
    await until(() => old.disconnected, "replaced socket closed");
    expect(adapter.supports("dev", CONNECTION_ID, "threads")).toBe(true);
    // 에이전트를 가리지 않는다 — 모든 에이전트가 붙은 플러그인 하나를 지난다
    expect(adapter.supports("fin", CONNECTION_ID, "threads")).toBe(true);

    clients.at(-1)?.disconnect();
    await until(() => gw().bridge === "down", "bridge down");
    expect(adapter.supports("dev", CONNECTION_ID, "threads")).toBe(false);
  });

  it("모르는 capability 가 섞인 hello 도 받는다(판정 R1)", async () => {
    await plugin({}, { ...hello, capabilities: ["future.cap", "threads"] });
    expect(gw().bridge).toBe("connected");
    expect(adapter.supports("dev", CONNECTION_ID, "threads")).toBe(true);
  });
});

describe("createOpenClawAdapter — 설정 상세(setupDetail)", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it("처음에는 둘 다 down, host 는 URL 의 호스트:포트만 — 자격 증명·경로·쿼리·Gateway 토큰이 없다", () => {
    const detail = adapter.setupDetail();
    expect(detail).toEqual({
      provider: "openclaw",
      gateway: { state: "down", host: "gateway.example.test:443", version: null, pairing: null },
      bridge: { state: "down", plugin: null },
    });
    const text = JSON.stringify(detail);
    for (const secret of ["operator", "pw", "gw-token", "/gw", "t=1"]) expect(text).not.toContain(secret);
  });

  it("플러그인 hello → plugin 요약(토큰 id·bundleSha256·gatewayVersion), 끊기면 null — 변화마다 setup 이벤트 1회", async () => {
    const socket = await plugin({}, { ...hello, gatewayVersion: "2026.9.5", bundleSha256: BUNDLE_SHA });
    expect(adapter.setupDetail().bridge).toEqual({
      state: "connected",
      plugin: {
        version: "0.0.0",
        sdkVersion: "2026.9.4",
        gatewayVersion: "2026.9.5",
        bundleSha256: BUNDLE_SHA,
        tokenId: "t1",
        connectedAt: expect.stringMatching(ISO),
      },
    });
    expect(ofKind("setup")).toHaveLength(1);

    socket.disconnect();
    await until(() => adapter.setupDetail().bridge.plugin === null, "plugin gone");
    expect(adapter.setupDetail().bridge.state).toBe("down");
    expect(ofKind("setup")).toHaveLength(2);
  });

  it("옛 플러그인(bundleSha256·gatewayVersion 없음)은 null 로 싣는다", async () => {
    await plugin();
    expect(adapter.setupDetail().bridge.plugin).toMatchObject({
      bundleSha256: null,
      gatewayVersion: null,
      tokenId: "t1",
    });
  });

  it("새 연결이 이전 연결을 교체하면 새 토큰 id 로 바뀌고 setup 이벤트는 교체마다 한 번", async () => {
    const first = await plugin();
    await plugin({}, hello, OTHER_TOKEN);
    await until(() => first.disconnected, "replaced socket closed");
    expect(adapter.setupDetail().bridge.plugin?.tokenId).toBe("t2");
    expect(ofKind("setup")).toHaveLength(2);
  });

  it("검증 함수가 null 이면 핸드셰이크에서 UNAUTHORIZED, 거절 warn 에 토큰이 없다", async () => {
    const socket = connect(url, {
      transports: ["websocket"],
      auth: { token: "dbt_revoked" },
      reconnection: false,
    });
    clients.push(socket);
    const error = await new Promise<Error>((resolve) => socket.once("connect_error", resolve));
    expect(error.message).toBe("UNAUTHORIZED");
    const warns = logger.warn.mock.calls.filter((call) => call[1] === "bridge connection rejected");
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).not.toContain("dbt_revoked");
    expect(ofKind("setup")).toHaveLength(0);
  });

  it("Gateway 접속 → state connected·version(hello-ok server.version) — setup 이벤트 1회", async () => {
    gatewayHello = { server: { version: "2026.9.5" } };
    await connectedGateway();
    expect(adapter.setupDetail().gateway).toEqual({
      state: "connected",
      host: "gateway.example.test:443",
      version: "2026.9.5",
      pairing: null,
    });
    expect(ofKind("setup")).toHaveLength(1);
  });

  it("페어링 요구 → pairing { requestId, since }, 다음 성공 접속 → pairing null·version", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    connectFailures = [
      new GatewayPairingRequiredError({
        cause: new Error("NOT_PAIRED"),
        details: { code: "PAIRING_REQUIRED" },
        message: "device pairing required",
        requestId: "req-1",
      }),
    ];
    gatewayHello = { server: { version: "2026.9.5" } };
    await adapter.connect();
    await until(() => adapter.setupDetail().gateway.pairing !== null, "pairing recorded");
    expect(adapter.setupDetail().gateway).toEqual({
      state: "reconnecting",
      host: "gateway.example.test:443",
      version: null,
      pairing: { requestId: "req-1", since: expect.stringMatching(ISO) },
    });
    // reconnecting 과 pairing 은 한 동기 구간에서 함께 바뀐다 — 이벤트는 한 번
    expect(ofKind("setup")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await until(() => adapter.setupDetail().gateway.state === "connected", "gateway connected");
    expect(adapter.setupDetail().gateway).toMatchObject({ version: "2026.9.5", pairing: null });
    expect(ofKind("setup")).toHaveLength(2);
  });

  it("hello 없이 붙었다 끊긴 연결은 상세를 바꾸지 않으므로 setup 이벤트가 없다", async () => {
    const socket = connect(url, { transports: ["websocket"], auth: { token: TOKEN }, reconnection: false });
    clients.push(socket);
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    expect(adapter.revokeTokenSessions("t1")).toBe(1);
    await until(() => socket.disconnected, "socket closed");
    await new Promise((resolve) => setImmediate(resolve));
    expect(ofKind("setup")).toHaveLength(0);
  });

  it("상세가 그대로인 상태 이벤트(능력 끄기 등)에는 setup 이벤트를 내지 않는다", async () => {
    await connectedGateway();
    const before = ofKind("setup").length;
    gatewayResponses["agents.list"] = () => {
      throw Object.assign(new Error("missing scope"), { details: { code: "MISSING_SCOPE" } });
    };
    await adapter.listAgents(CONNECTION_ID).catch(() => undefined);
    expect(adapter.capabilities().agentsList).toBe(false);
    expect(ofKind("setup")).toHaveLength(before);
  });
});

describe("createOpenClawAdapter — revokeTokenSessions", () => {
  it("그 토큰으로 붙은 소켓을 끊고 끊은 수를 돌려준다 — 다른 토큰 세션은 그대로, 사유 로그 한 줄", async () => {
    const waiting = connect(url, { transports: ["websocket"], auth: { token: TOKEN }, reconnection: false });
    clients.push(waiting);
    await new Promise<void>((resolve) => waiting.once("connect", () => resolve()));
    const kept = await plugin({}, hello, OTHER_TOKEN);

    expect(adapter.revokeTokenSessions("t1")).toBe(1);
    await until(() => waiting.disconnected, "revoked socket closed");
    expect(kept.connected).toBe(true);
    expect(adapter.setupDetail().bridge.plugin?.tokenId).toBe("t2");
    expect(logger.info).toHaveBeenCalledWith({ tokenId: "t1", sessions: 1 }, "bridge sessions revoked");
  });

  it("지금 붙은 플러그인의 토큰을 폐기하면 bridge down·plugin null", async () => {
    const socket = await plugin();
    const setupBefore = ofKind("setup").length;
    expect(adapter.revokeTokenSessions("t1")).toBe(1);
    await until(() => socket.disconnected, "revoked socket closed");
    await until(() => gw().bridge === "down", "bridge down");
    expect(adapter.setupDetail().bridge).toEqual({ state: "down", plugin: null });
    expect(ofKind("setup")).toHaveLength(setupBefore + 1);
    expect(adapter.revokeTokenSessions("t1")).toBe(0);
  });
});

describe("createOpenClawAdapter — bridge.clientAddress", () => {
  it("브리지 거절 warn 의 주소는 clientAddress 가 준 값이다", async () => {
    const ownApp = Fastify({ logger: false });
    const ownIo = new Server(ownApp.server, { transports: ["websocket"] });
    const ownLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const own = createOpenClawAdapter({
      dataDir,
      bridge: {
        io: ownIo,
        verifyToken: () => null,
        clientAddress: () => "203.0.113.7",
        serverVersion: "test",
      },
      logger: ownLogger,
      onCanonical: async () => ({}),
      connector: async () => {
        throw new Error("unused");
      },
    });
    await ownApp.listen({ host: "127.0.0.1", port: 0 });
    const ownUrl = `ws://127.0.0.1:${(ownApp.server.address() as AddressInfo).port}/bridge`;
    try {
      const wrong = connect(ownUrl, {
        transports: ["websocket"],
        auth: { token: TOKEN },
        reconnection: false,
      });
      clients.push(wrong);
      expect((await new Promise<Error>((resolve) => wrong.once("connect_error", resolve))).message).toBe(
        "UNAUTHORIZED",
      );
      const warns = ownLogger.warn.mock.calls.filter((call) => call[1] === "bridge connection rejected");
      expect(warns).toEqual([[{ reason: "token mismatch from 203.0.113.7" }, "bridge connection rejected"]]);
    } finally {
      for (const socket of clients.splice(0)) socket.disconnect();
      await own.close();
      ownIo.close();
      await ownApp.close();
    }
  });
});

describe("createOpenClawAdapter — send", () => {
  it("플러그인 ack 를 InboundDeliverResult 로 돌려준다", async () => {
    const received: InboundDeliver[] = [];
    await plugin({
      "inbound.deliver": (payload: InboundDeliver, ack) => {
        received.push(payload);
        dispatchAck(payload, ack);
      },
    });
    const input = delivery();

    await expect(adapter.send(input, { connectionId: CONNECTION_ID })).resolves.toEqual({
      admission: "dispatch",
      providerRunId: input.runId,
      connectionId: CONNECTION_ID,
    });
    expect(received).toEqual([input]);
    expect(deliveredLines(input)).toEqual([
      {
        runId: input.runId,
        deliveryId: input.deliveryId,
        admission: "dispatch",
        ackMs: expect.any(Number),
        retries: 0,
        waitedForPlugin: false,
        gatewayId: CONNECTION_ID,
      },
    ]);
  });

  it("ack { ok: true, data: {} } 는 재시도 없이 AdapterError(INTERNAL, ADAPTER_PROTOCOL: …)", async () => {
    const deliver = vi.fn((_payload: InboundDeliver, ack: Ack) => ack({ ok: true, data: {} }));
    await plugin({ "inbound.deliver": deliver });

    const error = await adapter.send(delivery(), { connectionId: CONNECTION_ID }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: "INTERNAL", message: expect.stringMatching(/^ADAPTER_PROTOCOL: /) });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("플러그인 ok:false(VALIDATION)는 재시도 없이 그 코드로 거부한다", async () => {
    const deliver = vi.fn((_payload: InboundDeliver, ack: Ack) =>
      ack({ ok: false, error: { code: "VALIDATION", message: "runId: Invalid UUID" } }),
    );
    await plugin({ "inbound.deliver": deliver });

    await expect(adapter.send(delivery(), { connectionId: CONNECTION_ID })).rejects.toMatchObject({
      code: "VALIDATION",
      message: "runId: Invalid UUID",
    });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("ack 가 10s 안에 오지 않으면 1s 뒤 다시 보낸다", async () => {
    let deliveries = 0;
    await plugin({
      "inbound.deliver": (payload: InboundDeliver, ack) => {
        deliveries += 1;
        if (deliveries >= 2) dispatchAck(payload, ack);
      },
    });
    const spy = vi.spyOn(adapter.bridge.forGateway(CONNECTION_ID), "deliverInbound");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

    const input = delivery();
    const sending = adapter.send(input, { connectionId: CONNECTION_ID });
    await until(() => deliveries === 1, "first delivery");
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ runId: f.RUN_ID }), 10_000);

    await expect(sending).resolves.toEqual({
      admission: "dispatch",
      providerRunId: f.RUN_ID,
      connectionId: CONNECTION_ID,
    });
    expect(deliveries).toBe(2);
    // ackMs 는 첫 전송 시도부터 — ack 타임아웃 10s + 재시도 대기 1s
    expect(deliveredLines(input)).toEqual([
      expect.objectContaining({ admission: "dispatch", ackMs: 11_000, retries: 1, waitedForPlugin: false }),
    ]);
  });

  it.each([
    [0, 10_000],
    [1, 40_000],
    [3, 100_000],
  ])(
    "이미지 %i장이면 ack 상한이 %ims — 플러그인이 이미지를 받은 뒤에야 ack 한다(파일 첨부는 세지 않는다)",
    async (images, ackMs) => {
      let deliveries = 0;
      await plugin({
        "inbound.deliver": (payload: InboundDeliver, ack) => {
          deliveries += 1;
          if (deliveries >= 2) dispatchAck(payload, ack);
        },
      });
      const spy = vi.spyOn(adapter.bridge.forGateway(CONNECTION_ID), "deliverInbound");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const input = delivery();
      const attachment = (kind: "image" | "file", i: number) => {
        const id = randomUUID();
        return kind === "image"
          ? {
              id,
              kind,
              url: artifactUrl(id),
              name: `${i}.png`,
              mime: "image/png",
              size: 10,
              width: 1,
              height: 1,
            }
          : { id, kind, url: artifactUrl(id), name: `${i}.pdf`, mime: "application/pdf", size: 10 };
      };
      input.message.attachments = [
        ...Array.from({ length: images }, (_, i) => attachment("image", i)),
        attachment("file", 99),
      ];

      const sending = adapter.send(input, { connectionId: CONNECTION_ID });
      await until(() => deliveries === 1, "first delivery");
      expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ runId: f.RUN_ID }), ackMs);
      // 상한 - 1ms 에는 아직 기다리고, 상한 + 재시도 대기 1s 에 두 번째를 보낸다
      await vi.advanceTimersByTimeAsync(ackMs + 999);
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ runId: f.RUN_ID }), ackMs);
      await expect(sending).resolves.toEqual({
        admission: "dispatch",
        providerRunId: f.RUN_ID,
        connectionId: CONNECTION_ID,
      });
    },
  );

  it("ack 가 끝내 오지 않으면 1s·4s·16s 로 3회 재시도한 뒤 AdapterError(TIMEOUT)", async () => {
    await plugin({ "inbound.deliver": () => undefined });
    const spy = vi.spyOn(adapter.bridge.forGateway(CONNECTION_ID), "deliverInbound");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const result = adapter.send(delivery(), { connectionId: CONNECTION_ID }).catch((e: unknown) => e);
    // [전진 ms, 그 뒤 전송 횟수] — ack 타임아웃 10s 뒤 각 대기(1s·4s·16s)가 끝나기 1ms 전과 끝난 순간을 잰다
    const script: Array<[number, number]> = [
      [10_000, 1],
      [999, 1],
      [1, 2],
      [10_000, 2],
      [3_999, 2],
      [1, 3],
      [10_000, 3],
      [15_999, 3],
      [1, 4],
      [10_000, 4],
    ];
    const observed: Array<[number, number]> = [];
    for (const [step] of script) {
      await vi.advanceTimersByTimeAsync(step);
      observed.push([step, spy.mock.calls.length]);
    }

    expect(observed).toEqual(script);
    expect(await result).toMatchObject({ name: "AdapterError", code: "TIMEOUT" });
  });

  it("플러그인이 없으면 waitForReady 로 기다렸다가 붙으면 보낸다", async () => {
    const spy = vi.spyOn(adapter.bridge.forGateway(CONNECTION_ID), "deliverInbound");
    const input = delivery();
    const sending = adapter.send(input, { connectionId: CONNECTION_ID });
    await until(() => spy.mock.calls.length === 1, "first attempt");

    await plugin({ "inbound.deliver": dispatchAck });

    await expect(sending).resolves.toEqual({
      admission: "dispatch",
      providerRunId: f.RUN_ID,
      connectionId: CONNECTION_ID,
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(deliveredLines(input)).toEqual([
      expect.objectContaining({ admission: "dispatch", retries: 0, waitedForPlugin: true }),
    ]);
  });

  it("drop ack 도 「inbound delivered」(admission drop) 한 줄, 거부·실패는 찍지 않는다", async () => {
    await plugin({
      "inbound.deliver": (_payload: InboundDeliver, ack) =>
        ack({ ok: true, data: { admission: "drop", reason: "bot-loop-protection" } }),
    });
    const dropped = delivery();
    await expect(adapter.send(dropped, { connectionId: CONNECTION_ID })).resolves.toMatchObject({
      admission: "drop",
    });
    expect(deliveredLines(dropped)).toEqual([
      expect.objectContaining({
        runId: dropped.runId,
        admission: "drop",
        retries: 0,
        waitedForPlugin: false,
      }),
    ]);

    for (const socket of clients.splice(0)) socket.disconnect();
    await plugin({
      "inbound.deliver": (_payload: InboundDeliver, ack) =>
        ack({ ok: false, error: { code: "VALIDATION", message: "bad" } }),
    });
    const rejected = delivery();
    await expect(adapter.send(rejected, { connectionId: CONNECTION_ID })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(deliveredLines(rejected)).toEqual([]);
  });

  it("플러그인을 기다리는 동안 forgetRun 된 런은 플러그인이 붙어도 보내지 않고 ADAPTER_UNAVAILABLE 로 끝난다", async () => {
    const deliverSpy = vi.spyOn(adapter.bridge.forGateway(CONNECTION_ID), "deliverInbound");
    const waitSpy = vi.spyOn(adapter.bridge.forGateway(CONNECTION_ID), "waitForReady");
    const result = adapter.send(delivery(), { connectionId: CONNECTION_ID }).catch((e: unknown) => e);
    await until(() => waitSpy.mock.calls.length === 1, "waitForReady");

    // 서버 오케스트레이터가 queued 상한으로 런을 닫았다
    adapter.forgetRun?.(f.RUN_ID);
    const received: InboundDeliver[] = [];
    await plugin({
      "inbound.deliver": (payload: InboundDeliver, ack) => {
        received.push(payload);
        dispatchAck(payload, ack);
      },
    });

    expect(await result).toMatchObject({ name: "AdapterError", code: "ADAPTER_UNAVAILABLE" });
    expect(deliverSpy).toHaveBeenCalledTimes(1); // 플러그인이 없던 첫 시도뿐
    expect(received).toEqual([]);
  });

  it("ack 타임아웃 재시도 대기 중 forgetRun 된 런은 다시 보내지 않는다", async () => {
    let received = 0;
    await plugin({
      "inbound.deliver": () => {
        received += 1;
      },
    });
    const deliverSpy = vi.spyOn(adapter.bridge.forGateway(CONNECTION_ID), "deliverInbound");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = adapter.send(delivery(), { connectionId: CONNECTION_ID }).catch((e: unknown) => e);
    await until(() => received === 1, "first delivery");
    await vi.advanceTimersByTimeAsync(10_000); // ack 타임아웃 → 1s 재시도 대기

    adapter.forgetRun?.(f.RUN_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await result).toMatchObject({ name: "AdapterError", code: "ADAPTER_UNAVAILABLE" });
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(received).toBe(1);
  });

  it("플러그인이 120s 안에 붙지 않으면 AdapterError(ADAPTER_UNAVAILABLE)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = adapter.send(delivery(), { connectionId: CONNECTION_ID }).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(119_999);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toMatchObject({ name: "AdapterError", code: "ADAPTER_UNAVAILABLE" });
  });

  it("플러그인을 기다리는 중 close() 하면 send 는 곧바로 ADAPTER_UNAVAILABLE(adapter closed)로 끝나고 타이머가 남지 않는다", async () => {
    const deliverSpy = vi.spyOn(adapter.bridge.forGateway(CONNECTION_ID), "deliverInbound");
    const waitSpy = vi.spyOn(adapter.bridge.forGateway(CONNECTION_ID), "waitForReady");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const result = adapter
      .send(delivery(), { connectionId: CONNECTION_ID })
      .catch((e: unknown) => e)
      .finally(() => {
        settled = true;
      });
    await until(() => waitSpy.mock.calls.length === 1, "waitForReady");
    expect(vi.getTimerCount()).toBe(1); // waitForReady 120s

    await adapter.close();
    await until(() => settled, "send settled after close");

    expect(await result).toMatchObject({
      name: "AdapterError",
      code: "ADAPTER_UNAVAILABLE",
      message: "adapter closed",
    });
    await expectNoTimersLeft();
    // 닫힌 어댑터의 새 send 는 브리지에 가지 않고 거부된다
    await expect(adapter.send(delivery(), { connectionId: CONNECTION_ID })).rejects.toMatchObject({
      code: "ADAPTER_UNAVAILABLE",
      message: "adapter closed",
    });
    expect(deliverSpy).toHaveBeenCalledTimes(1);
  });

  it("ack 타임아웃 뒤 1s 재시도 대기 중 close() 하면 send 는 곧바로 끝나고, 타이머가 남지 않고, 닫힌 브리지로 다시 보내지 않는다", async () => {
    let received = 0;
    await plugin({
      "inbound.deliver": () => {
        received += 1;
      },
    });
    const deliverSpy = vi.spyOn(adapter.bridge.forGateway(CONNECTION_ID), "deliverInbound");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const result = adapter
      .send(delivery(), { connectionId: CONNECTION_ID })
      .catch((e: unknown) => e)
      .finally(() => {
        settled = true;
      });
    await until(() => received === 1, "first delivery");
    await vi.advanceTimersByTimeAsync(10_000); // ack TIMEOUT → 1s 재시도 대기
    await vi.advanceTimersByTimeAsync(500);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1); // 재시도 대기 1s

    await adapter.close();
    await until(() => settled, "send settled after close");

    expect(await result).toMatchObject({
      name: "AdapterError",
      code: "ADAPTER_UNAVAILABLE",
      message: "adapter closed",
    });
    await expectNoTimersLeft();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(received).toBe(1);
  });
});

describe("createOpenClawAdapter — close", () => {
  it("브리지를 먼저 닫아(system.notice shutdown) 플러그인에 알린 뒤 Gateway 를 닫고, Gateway stop 이 실패해도 resolve 한다", async () => {
    const stopError = new Error("gateway stopAndWait timed out after 5000ms");
    const stop = vi.fn(async () => {
      throw stopError;
    });
    gatewayStop = stop;
    await connectedGateway();
    const socket = await plugin();
    const notices: unknown[] = [];
    socket.on("system.notice", (notice: unknown) => notices.push(notice));
    const bridgeClose = vi.spyOn(adapter.bridge, "close");

    await expect(adapter.close()).resolves.toBeUndefined();

    expect(bridgeClose).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(bridgeClose.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0] ?? 0);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: stopError }), expect.any(String));
    await until(() => notices.length === 1 && socket.disconnected, "shutdown notice and disconnect");
    expect(notices).toEqual([{ reason: "shutdown", message: "server shutting down" }]);
    expect(gw().gateway).toBe("down");
  });
});

describe("createOpenClawAdapter — 정본 훅", () => {
  it("outbound.message → onCanonical 이 저장한 messageId 를 ack 로 돌려주고 canonical 을 알린다", async () => {
    const socket = await plugin();
    const message = {
      outboundId: "dodok-reply-1",
      conversationId: CH,
      agentId: f.PROVIDER_AGENT_ID,
      sessionKey: f.SESSION_KEY,
      runId: f.RUN_ID,
      text: "PONG",
      ts: new Date().toISOString(),
    };

    const ack = await socket.emitWithAck("outbound.message", message);

    expect(ack).toEqual({ ok: true, data: { messageId: STORED_MESSAGE_ID } });
    expect(canonical).toEqual([{ ...message, attachmentIds: [] }]);
    expect(ofKind("canonical")).toEqual([
      { kind: "canonical", connectionId: CONNECTION_ID, message: { ...message, attachmentIds: [] } },
    ]);
  });

  it("onCanonical 이 messageId 를 주지 않으면 outboundId 로 ack 한다", async () => {
    canonicalResult = {};
    const socket = await plugin();

    const ack = await socket.emitWithAck("outbound.message", {
      outboundId: "dodok-reply-2",
      conversationId: CH,
      agentId: f.PROVIDER_AGENT_ID,
      sessionKey: f.SESSION_KEY,
      text: "PONG",
      ts: new Date().toISOString(),
    });

    expect(ack).toEqual({ ok: true, data: { messageId: "dodok-reply-2" } });
  });
});

describe("createOpenClawAdapter — Gateway 이벤트", () => {
  async function sentRun(ackWith: (payload: InboundDeliver, ack: Ack) => void = dispatchAck) {
    await connectedGateway();
    await plugin({ "inbound.deliver": ackWith });
    return adapter.send(delivery(), { connectionId: CONNECTION_ID });
  }

  it("우리 런의 프레임은 run_signal·run_event 로 내보내고, 모르는 runId 는 무시한다", async () => {
    await sentRun();
    events = [];

    gatewayEvent(f.lifecycleStart());
    gatewayEvent(f.chatDelta("P"));
    gatewayEvent(f.chatDelta("X", { runId: "01a09fc9-d204-7551-89d6-38544d07a2ee" }));

    expect(events).toEqual([
      {
        kind: "run_signal",
        runId: f.RUN_ID,
        connectionId: CONNECTION_ID,
        signal: { kind: "gateway_started" },
      },
      {
        kind: "run_event",
        runId: f.RUN_ID,
        connectionId: CONNECTION_ID,
        event: { type: "TEXT_MESSAGE_START", runId: f.RUN_ID, messageId: f.RUN_ID, role: "assistant" },
      },
      {
        kind: "run_event",
        runId: f.RUN_ID,
        connectionId: CONNECTION_ID,
        event: { type: "TEXT_MESSAGE_CONTENT", runId: f.RUN_ID, messageId: f.RUN_ID, delta: "P" },
      },
      { kind: "run_signal", runId: f.RUN_ID, connectionId: CONNECTION_ID, signal: { kind: "text_delta" } },
    ]);
  });

  it("플러그인 ack 보다 먼저 온 Gateway 이벤트도 우리 런으로 본다(send 가 전송 전에 runId 를 등록)", async () => {
    await connectedGateway();
    await plugin({
      "inbound.deliver": (payload: InboundDeliver, ack) => {
        // 플러그인은 onAgentRunStart 에서 ack 한다 — 그 사이 Gateway lifecycle start 가 먼저 도착한 모양
        gatewayEvent(f.lifecycleStart());
        setTimeout(() => dispatchAck(payload, ack), 20);
      },
    });

    await adapter.send(delivery(), { connectionId: CONNECTION_ID });

    expect(ofKind("run_signal").map((e) => e.signal.kind)).toEqual(["gateway_started"]);
  });

  it("admission drop 이면 런을 등록하지 않는다", async () => {
    await sentRun((_payload, ack) =>
      ack({ ok: true, data: { admission: "drop", reason: "bot-loop-protection" } }),
    );
    events = [];

    gatewayEvent(f.lifecycleStart());

    expect(events).toEqual([]);
  });

  it("gateway_final 에 snapshotText 를 싣고, 60s 뒤에야 런을 잊는다(그 사이 늦은 chat 은 무시, usage 는 통과)", async () => {
    await sentRun();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    gatewayEvent(f.chatDelta("PO"));
    events = [];

    gatewayEvent(f.chatFinal("PONG"));
    expect(ofKind("run_signal")).toEqual([
      {
        kind: "run_signal",
        runId: f.RUN_ID,
        connectionId: CONNECTION_ID,
        signal: { kind: "gateway_final" },
        snapshotText: "PONG",
      },
    ]);

    events = [];
    gatewayEvent(f.chatDelta("late"));
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(59_999);
    gatewayEvent(f.sessionMessage());
    expect(ofKind("run_event").map((e) => e.event.type)).toEqual(["CUSTOM"]);

    events = [];
    await vi.advanceTimersByTimeAsync(1);
    gatewayEvent(f.sessionMessage());
    gatewayEvent(f.chatDelta("after"));
    expect(events).toEqual([]);
  });

  it.each([
    ["error", () => f.chatError({ errorKind: "timeout" })],
    ["aborted", () => f.chatAborted()],
  ])("chat %s 는 종료 신호를 낸 뒤 곧바로 런을 잊는다", async (_state, terminal) => {
    await sentRun();

    gatewayEvent(terminal());
    events = [];
    gatewayEvent(f.sessionMessage());

    expect(events).toEqual([]);
  });

  it("forgetRun 뒤 그 런의 chat 프레임은 무시하고, final 뒤 걸린 60s 잊기 타이머도 지운다", async () => {
    await sentRun();
    gatewayEvent(f.lifecycleStart());
    expect(ofKind("run_signal").map((e) => e.signal.kind)).toEqual(["gateway_started"]);

    // 서버가 타임아웃으로 닫은 런 — 종료 신호가 끝내 오지 않았다
    events = [];
    adapter.forgetRun?.(f.RUN_ID);
    gatewayEvent(f.chatDelta("late"));
    gatewayEvent(f.sessionMessage());
    expect(events).toEqual([]);

    // final 로 잊기 타이머가 걸린 런도 곧바로 잊는다
    await adapter.send(delivery(), { connectionId: CONNECTION_ID });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    gatewayEvent(f.chatFinal("PONG"));
    expect(vi.getTimerCount()).toBe(1);
    adapter.forgetRun?.(f.RUN_ID);
    expect(vi.getTimerCount()).toBe(0);
    events = [];
    gatewayEvent(f.sessionMessage());
    expect(events).toEqual([]);
  });

  it("핸들러 하나가 던져도 다른 핸들러는 받고 오류는 로그로 남긴다", async () => {
    await sentRun();
    adapter.onEvent(() => {
      throw new Error("handler bug");
    });
    const second: AdapterEvent[] = [];
    adapter.onEvent((e) => second.push(e));

    gatewayEvent(f.lifecycleStart());

    expect(second).toEqual([
      {
        kind: "run_signal",
        runId: f.RUN_ID,
        connectionId: CONNECTION_ID,
        signal: { kind: "gateway_started" },
      },
    ]);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("createOpenClawAdapter — Gateway 요청·브리지 설정", () => {
  it("Gateway 가 붙기 전 요청은 AdapterError(ADAPTER_UNAVAILABLE)", async () => {
    await expect(adapter.abort(f.RUN_ID, f.SESSION_KEY, CONNECTION_ID)).rejects.toMatchObject({
      code: "ADAPTER_UNAVAILABLE",
    });
  });

  it("abort → chat.abort({ sessionKey, runId })", async () => {
    await connectedGateway();

    await adapter.abort(f.RUN_ID, f.SESSION_KEY, CONNECTION_ID);

    expect(gatewayCalls.at(-1)).toEqual({
      method: "chat.abort",
      params: { sessionKey: f.SESSION_KEY, runId: f.RUN_ID },
    });
  });

  it("listAgents: agents.list 의 agents[].id·name → providerAgentId·name, FORBIDDEN 이면 agentsList=false", async () => {
    await connectedGateway();
    gatewayResponses["agents.list"] = () => ({
      defaultId: "dev",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "dev", name: "Dev", workspace: "/w" }, { id: "fin" }],
    });

    await expect(adapter.listAgents(CONNECTION_ID)).resolves.toEqual([
      { providerAgentId: "dev", name: "Dev" },
      { providerAgentId: "fin" },
    ]);
    expect(gatewayCalls.at(-1)).toEqual({ method: "agents.list", params: {} });

    gatewayResponses["agents.list"] = () => ({ agents: "nope" });
    await expect(adapter.listAgents(CONNECTION_ID)).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringMatching(/^ADAPTER_PROTOCOL: /),
    });

    gatewayResponses["agents.list"] = () => {
      throw Object.assign(new Error("forbidden"), { code: "FORBIDDEN" });
    };
    events = [];
    await expect(adapter.listAgents(CONNECTION_ID)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(adapter.capabilities().agentsList).toBe(false);
    const dropped = {
      kind: "status",
      status: oneGateway("connected", "down"),
      capabilities: { agentsList: false, configSet: true, promptEveryRun: false, serverSessionIds: false },
    };
    expect(ofKind("status")).toEqual([dropped]);

    // 이미 내린 능력은 다시 알리지 않는다
    await expect(adapter.listAgents(CONNECTION_ID)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(ofKind("status")).toEqual([dropped]);
  });

  it("syncChannelConfig → 브리지 config.set, ok:false 는 AdapterError(code)", async () => {
    const received: unknown[] = [];
    let reply: unknown = { ok: true, data: { applied: "live" } };
    await plugin({
      "config.set": (payload: unknown, ack) => {
        received.push(payload);
        ack(reply);
      },
    });

    await expect(
      adapter.syncChannelConfig(CH, { systemPrompt: "be brief", requireMention: true }, CONNECTION_ID),
    ).resolves.toEqual({
      applied: "live",
    });
    expect(received).toEqual([{ channelId: CH, config: { systemPrompt: "be brief", requireMention: true } }]);

    reply = { ok: false, error: { code: "ADAPTER_UNAVAILABLE", message: "config.set 미지원" } };
    await expect(
      adapter.syncChannelConfig(CH, { requireMention: false }, CONNECTION_ID),
    ).rejects.toMatchObject({
      name: "AdapterError",
      code: "ADAPTER_UNAVAILABLE",
    });
  });

  it("syncChannelConfig 는 플러그인이 없으면 기다리지 않고 ADAPTER_UNAVAILABLE", async () => {
    await expect(
      adapter.syncChannelConfig(CH, { requireMention: true }, CONNECTION_ID),
    ).rejects.toMatchObject({
      code: "ADAPTER_UNAVAILABLE",
    });
  });
});

describe("Gateway 프레임 덤프(frameDumpPath)", () => {
  it("받은 chat·agent·session.message 프레임을 JSONL 로 남기고 close() 에서 닫는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-adapter-dump-"));
    const path = join(dir, "frames.jsonl");
    // 공유 ioServer 에는 이미 기본 어댑터의 /bridge 가 붙어 있다 — 덤프 어댑터는 HTTP 에 붙지 않은 따로 된 서버를 쓴다
    const io = new Server();
    let onEvent: ((frame: EventFrame) => void) | undefined;
    const dumping = createOpenClawAdapter({
      dataDir: dir,
      bridge: { io, verifyToken: () => ({ tokenId: "t1", gatewayId: CONNECTION_ID }), serverVersion: "test" },
      logger,
      onCanonical: async () => ({}),
      frameDumpPath: path,
      connector: async (options) => {
        onEvent = options.onEvent;
        return { request: async () => ({}) as never, stop: async () => undefined };
      },
    });
    dumping.upsertGateway({
      id: CONNECTION_ID,
      name: "gateway",
      url: "wss://gateway.example.test",
      token: "gw-token",
      enabled: true,
    });
    try {
      await dumping.connect();
      await until(() => gw(dumping).gateway === "connected", "dump adapter connected");
      onEvent?.(f.lifecycleStart());
      onEvent?.(f.sessionsChanged());
      onEvent?.(f.chatDelta("안"));
      onEvent?.(f.sessionMessage());
      await dumping.close();

      // 연결마다 <path>.<연결 id>
      const events = readFileSync(`${path}.${CONNECTION_ID}`, "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { frame: EventFrame }).frame.event);
      expect(events).toEqual(["agent", "chat", "session.message"]);
    } finally {
      await dumping.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("send 전 세션 구독", () => {
  it("접속 뒤 새로 생긴 세션은 전송 전에 sessions.messages.subscribe 한다 — 같은 키는 연결당 한 번", async () => {
    await adapter.connect();
    await until(() => gw().gateway === "connected", "gateway connected");
    const subscribesAtDeliver: number[] = [];
    await plugin({
      "inbound.deliver": (payload: InboundDeliver, ack: Ack) => {
        subscribesAtDeliver.push(
          gatewayCalls.filter((c) => c.method === "sessions.messages.subscribe").length,
        );
        dispatchAck(payload, ack);
      },
    });

    await adapter.send(delivery(), { connectionId: CONNECTION_ID });
    await adapter.send(delivery(randomUUID()), { connectionId: CONNECTION_ID });

    expect(gatewayCalls.filter((c) => c.method === "sessions.messages.subscribe")).toEqual([
      {
        method: "sessions.messages.subscribe",
        params: { key: f.SESSION_KEY, agentId: f.PROVIDER_AGENT_ID, includeApprovals: true },
      },
    ]);
    expect(subscribesAtDeliver).toEqual([1, 1]); // 구독이 전송보다 먼저다
  });

  it("스레드 키도 전송 전에 구독한다 — 채널 키 구독만으로는 스레드 세션 이벤트가 안 온다(ADR 0006)", async () => {
    await connectedGateway();
    const subscribedKeysAtDeliver: string[][] = [];
    await plugin({
      "inbound.deliver": (payload: InboundDeliver, ack: Ack) => {
        subscribedKeysAtDeliver.push(
          gatewayCalls
            .filter((c) => c.method === "sessions.messages.subscribe")
            .map((c) => (c.params as { key: string }).key),
        );
        dispatchAck(payload, ack);
      },
    });
    const threadKey = `${f.SESSION_KEY}:thread:${THREAD_ROOT}`;

    await adapter.send(delivery(), { connectionId: CONNECTION_ID });
    await adapter.send(
      { ...delivery(randomUUID()), sessionKey: threadKey, threadId: THREAD_ROOT },
      { connectionId: CONNECTION_ID },
    );

    expect(subscribedKeysAtDeliver).toEqual([[f.SESSION_KEY], [f.SESSION_KEY, threadKey]]);
  });

  it("Gateway 가 끊겨 있으면 구독 없이 전송한다(정본은 플러그인 경로) — 붙을 때 recover 가 agent_sessions 로 구독한다", async () => {
    await plugin({ "inbound.deliver": dispatchAck });
    await expect(adapter.send(delivery(), { connectionId: CONNECTION_ID })).resolves.toMatchObject({
      admission: "dispatch",
    });
    expect(gatewayCalls.filter((c) => c.method === "sessions.messages.subscribe")).toEqual([]);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: f.SESSION_KEY }),
      "gateway session subscribe before send failed",
    );
  });
});

describe("승인 — 수신·병합·해결 RPC", () => {
  const APPROVAL_URL_PATH = `/approve/${encodeURIComponent(f.APPROVAL_ID)}`;

  // ⚠ 실측(p2-t6) — 같은 승인이 필드가 다른 두 프레임으로 온다: 정본에는 `toolCallId` 가, 세션 스냅샷에는 `urlPath` 가 있다.
  // 뒤엣것을 버리면 어느 순서로 오느냐에 따라 값 하나가 통째로 사라진다.
  it("같은 승인의 두 프레임을 병합해서 낸다 — plugin → session 순서", async () => {
    await connectedGateway();

    // 요청: 정본(plugin.approval.requested) — `toolCallId` 는 있고 `urlPath` 는 없다
    gatewayEvent(f.pluginApprovalRequested());
    expect(ofKind("approval")).toHaveLength(1);
    expect(ofKind("approval")[0]?.approval).toMatchObject({
      providerApprovalId: f.APPROVAL_ID,
      kind: "plugin",
      status: "pending",
      toolCallId: f.APPROVAL_TOOL_CALL_ID,
      conversationId: CH,
    });
    expect(ofKind("approval")[0]?.approval.urlPath).toBeUndefined();

    // 보조: 세션 스냅샷(session.approval pending) — `urlPath` 를 채워 한 번 더 낸다(스파이크 3.1)
    gatewayEvent(f.sessionApproval());
    expect(ofKind("approval")).toHaveLength(2);
    expect(ofKind("approval")[1]?.approval).toMatchObject({
      status: "pending",
      toolCallId: f.APPROVAL_TOOL_CALL_ID,
      urlPath: APPROVAL_URL_PATH,
    });

    // 해결: 상태가 바뀌었으므로 한 번 더. 병합한 값은 그대로 남는다
    gatewayEvent(f.sessionApproval({ phase: "terminal" }));
    gatewayEvent(f.pluginApprovalResolved());
    expect(ofKind("approval").map((e) => e.approval.status)).toEqual(["pending", "pending", "allowed"]);
    expect(ofKind("approval").at(-1)?.approval).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      toolCallId: f.APPROVAL_TOOL_CALL_ID,
      urlPath: APPROVAL_URL_PATH,
    });
  });

  it("같은 승인의 두 프레임을 병합해서 낸다 — session → plugin 순서도 잃는 값이 없다", async () => {
    await connectedGateway();

    gatewayEvent(f.sessionApproval());
    expect(ofKind("approval")[0]?.approval).toMatchObject({ status: "pending", urlPath: APPROVAL_URL_PATH });
    expect(ofKind("approval")[0]?.approval.toolCallId).toBeUndefined();

    gatewayEvent(f.pluginApprovalRequested());
    expect(ofKind("approval")).toHaveLength(2);
    expect(ofKind("approval")[1]?.approval).toMatchObject({
      status: "pending",
      toolCallId: f.APPROVAL_TOOL_CALL_ID,
      urlPath: APPROVAL_URL_PATH,
    });
  });

  it("상태도 그대로고 새로 채운 필드도 없으면 다시 내지 않는다", async () => {
    await connectedGateway();

    gatewayEvent(f.pluginApprovalRequested());
    gatewayEvent(f.pluginApprovalRequested()); // 같은 프레임을 또 — 새 사실이 없다
    expect(ofKind("approval")).toHaveLength(1);

    gatewayEvent(f.sessionApproval());
    gatewayEvent(f.sessionApproval()); // 병합은 이미 끝났다 — 두 번째는 채울 자리가 없다
    expect(ofKind("approval")).toHaveLength(2);

    // 먼저 확정된 결말이 이긴다 — 뒤늦은 pending 되감기가 닫힌 승인을 되살리지 않는다
    gatewayEvent(f.pluginApprovalResolved());
    gatewayEvent(f.sessionApproval());
    expect(ofKind("approval").map((e) => e.approval.status)).toEqual(["pending", "pending", "allowed"]);
  });

  it("우리 세션 키가 아닌 전역 승인은 내지 않는다(다른 채널 플러그인·TUI)", async () => {
    await connectedGateway();
    const other = "agent:dev:discord:channel:01a09fc9-d204-7551-89d6-38544d07a2c1";

    gatewayEvent(f.pluginApprovalRequested({ sessionKey: other }));

    expect(ofKind("approval")).toHaveLength(0);
    expect(logger.debug).toHaveBeenCalledWith(
      { event: "plugin.approval.requested", gatewayId: CONNECTION_ID },
      "gateway approval frame ignored",
    );
    // 토큰·본문·남의 세션 키를 남기지 않는다
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(other);
  });

  it("세션 구독에 includeApprovals 를 넣고 응답의 approvalReplay 를 승인 이벤트로 흘린다", async () => {
    gatewayResponses["sessions.messages.subscribe"] = () => f.approvalSubscribeResult();
    await connectedGateway();
    await plugin({ "inbound.deliver": dispatchAck });

    await adapter.send(delivery(), { connectionId: CONNECTION_ID });

    expect(gatewayCalls.filter((c) => c.method === "sessions.messages.subscribe")).toEqual([
      {
        method: "sessions.messages.subscribe",
        params: { key: f.SESSION_KEY, agentId: f.PROVIDER_AGENT_ID, includeApprovals: true },
      },
    ]);
    expect(ofKind("approval").map((e) => e.approval.providerApprovalId)).toEqual([f.APPROVAL_ID]);
    // 되감기 스냅샷에도 `toolCallId` 가 없다 — 뒤따라온 정본이 그 자리를 채워 한 번 더 낸다
    expect(ofKind("approval")[0]?.approval.toolCallId).toBeUndefined();
    gatewayEvent(f.pluginApprovalRequested());
    expect(ofKind("approval")).toHaveLength(2);
    expect(ofKind("approval")[1]?.approval).toMatchObject({
      status: "pending",
      toolCallId: f.APPROVAL_TOOL_CALL_ID,
      urlPath: APPROVAL_URL_PATH,
    });
  });

  it("resolveApproval 은 approval.resolve { id, kind, decision } 을 보내고 terminal 스냅샷을 돌려준다", async () => {
    gatewayResponses["approval.resolve"] = () => f.approvalResolveResult();
    await connectedGateway();

    await expect(
      adapter.resolveApproval(f.APPROVAL_ID, "plugin", "allow-once", CONNECTION_ID),
    ).resolves.toMatchObject({
      providerApprovalId: f.APPROVAL_ID,
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      conversationId: CH,
    });
    expect(gatewayCalls.filter((c) => c.method === "approval.resolve")).toEqual([
      { method: "approval.resolve", params: { id: f.APPROVAL_ID, kind: "plugin", decision: "allow-once" } },
    ]);
  });

  // `kind` 는 저장된 행에서만 오므로 어댑터가 한 값으로 굳히면 exec·system-agent 승인이 어긋난 kind 로 나간다.
  it("resolveApproval 은 받은 kind 를 그대로 인자에 싣는다 — plugin 으로 굳어 있지 않다", async () => {
    gatewayResponses["approval.resolve"] = () => f.approvalResolveResult();
    await connectedGateway();

    await adapter.resolveApproval(f.APPROVAL_ID, "exec", "allow-once", CONNECTION_ID);
    await adapter.resolveApproval(f.APPROVAL_ID, "system-agent", "deny", CONNECTION_ID);

    expect(gatewayCalls.filter((c) => c.method === "approval.resolve").map((c) => c.params)).toEqual([
      { id: f.APPROVAL_ID, kind: "exec", decision: "allow-once" },
      { id: f.APPROVAL_ID, kind: "system-agent", decision: "deny" },
    ]);
  });

  it("resolveApproval 은 Gateway kind 가 아닌 tool 을 approval.resolve 로 보내지 않는다(Gateway 는 모르는 kind 를 거절로 확정한다)", async () => {
    gatewayResponses["approval.resolve"] = () => f.approvalResolveResult();
    await connectedGateway();

    await expect(
      adapter.resolveApproval(f.APPROVAL_ID, "tool", "allow-once", CONNECTION_ID),
    ).rejects.toMatchObject({
      name: "AdapterError",
      code: "INTERNAL",
    });
    expect(gatewayCalls.filter((c) => c.method === "approval.resolve")).toEqual([]);
  });

  it("재접속 중이면 approval.resolve 를 보내지 않고 ADAPTER_UNAVAILABLE(판정 P6)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    connectFailures = [new Error("connect ECONNREFUSED")];
    await adapter.connect();
    await until(() => gw().gateway === "reconnecting", "gateway reconnecting");

    await expect(
      adapter.resolveApproval(f.APPROVAL_ID, "plugin", "deny", CONNECTION_ID),
    ).rejects.toMatchObject({
      name: "AdapterError",
      code: "ADAPTER_UNAVAILABLE",
    });
    expect(gatewayCalls.filter((c) => c.method === "approval.resolve")).toEqual([]);
  });

  it("Gateway 가 끊겨 있으면 ADAPTER_UNAVAILABLE, 응답 모양이 다르면 ADAPTER_PROTOCOL", async () => {
    await expect(
      adapter.resolveApproval(f.APPROVAL_ID, "plugin", "deny", CONNECTION_ID),
    ).rejects.toMatchObject({
      name: "AdapterError",
      code: "ADAPTER_UNAVAILABLE",
    });

    gatewayResponses["approval.resolve"] = () => ({ applied: true });
    await connectedGateway();

    await expect(
      adapter.resolveApproval(f.APPROVAL_ID, "plugin", "deny", CONNECTION_ID),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringMatching(/^ADAPTER_PROTOCOL: approval\.resolve/),
    });
  });
});

describe("Gateway 재접속 뒤 열린 런 맞추기", () => {
  /** 디스패치된 런 하나를 두고, 그 뒤 Gateway WS 를 끊는다. 다시 붙는 것은 reconnect() 가 한다 */
  async function runThenDrop() {
    await connectedGateway();
    const socket = await plugin({ "inbound.deliver": dispatchAck });
    await adapter.send(delivery(), { connectionId: CONNECTION_ID });
    gatewayEvent(f.lifecycleStart());
    gatewayEvent(f.chatDelta("PO"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    drop();
    events = [];
    return socket;
  }

  /** Gateway WS 가 끊긴다(순단·Gateway 재시작) */
  function drop() {
    const closing = connectOptions;
    connectOptions = undefined;
    closing?.onClose?.({ code: 1006, reason: "" });
  }

  /** 백오프(1s ±20%) 뒤 다시 붙고 복구가 끝날 때까지 — 1ms 씩 밀어 유예 시계가 걸린 시각에 멈춘다 */
  async function reconnect() {
    for (let ms = 0; connectOptions === undefined; ms += 1) {
      if (ms > 2_000) throw new Error("gateway did not reconnect");
      await vi.advanceTimersByTimeAsync(1);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(gw().gateway).toBe("connected");
  }

  const closedSignals = () => ofKind("run_signal").filter((e) => e.runId === f.RUN_ID);

  it("끊긴 사이 정본이 왔으면 유예 뒤 gateway_final 로 닫는다 — 런 상한(600s)까지 기다리지 않는다", async () => {
    const socket = await runThenDrop();
    // 플러그인 브리지는 별개 연결이라 끊긴 동안에도 정본이 온다
    await socket.emitWithAck("outbound.message", {
      outboundId: "dodok-reply-reconnect",
      conversationId: CH,
      agentId: f.PROVIDER_AGENT_ID,
      sessionKey: f.SESSION_KEY,
      runId: f.RUN_ID,
      text: "PONG",
      ts: new Date().toISOString(),
    });
    await reconnect();
    events = [];

    await vi.advanceTimersByTimeAsync(RECONNECT_RUN_GRACE_MS - 1);
    expect(closedSignals()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(closedSignals()).toEqual([
      { kind: "run_signal", runId: f.RUN_ID, connectionId: CONNECTION_ID, signal: { kind: "gateway_final" } },
    ]);
    expect(ofKind("run_event")).toEqual([]);

    // 실물이 재구독 뒤 final 을 다시 보내면 그대로 넘긴다 — 서버 transition 이 종료된 런의 신호를 무시한다(겹치는 메시지 없음)
    events = [];
    gatewayEvent(f.chatFinal("PONG"));
    expect(closedSignals().map((e) => e.signal.kind)).toEqual(["gateway_final"]);
  });

  it("정본 없이 런이 사라졌으면(Gateway 재시작) 유예 뒤 연결 끊김과 같은 ADAPTER_UNAVAILABLE 로 닫고 잊는다", async () => {
    await runThenDrop();
    await reconnect();
    events = [];

    await vi.advanceTimersByTimeAsync(RECONNECT_RUN_GRACE_MS);
    expect(events).toEqual([
      {
        kind: "run_event",
        runId: f.RUN_ID,
        connectionId: CONNECTION_ID,
        event: {
          type: "RUN_ERROR",
          runId: f.RUN_ID,
          code: "ADAPTER_UNAVAILABLE",
          message: "gateway run lost across reconnect",
        },
      },
      {
        kind: "run_signal",
        runId: f.RUN_ID,
        connectionId: CONNECTION_ID,
        signal: {
          kind: "gateway_error",
          code: "ADAPTER_UNAVAILABLE",
          message: "gateway run lost across reconnect",
          connectionClosed: true,
        },
      },
    ]);

    events = [];
    gatewayEvent(f.chatDelta("late"));
    expect(events).toEqual([]);
  });

  it("재접속 뒤 이벤트가 이어지는 런은 닫지 않는다", async () => {
    await runThenDrop();
    await reconnect();

    await vi.advanceTimersByTimeAsync(RECONNECT_RUN_GRACE_MS - 1);
    gatewayEvent(f.chatDelta("NG"));
    events = [];
    await vi.advanceTimersByTimeAsync(RECONNECT_RUN_GRACE_MS * 5);
    expect(closedSignals()).toEqual([]);

    gatewayEvent(f.chatFinal("PONG"));
    expect(closedSignals().map((e) => e.signal.kind)).toEqual(["gateway_final"]);
  });

  it("툴이 열려 있거나 그 세션에 미해결 승인이 있는 런은 조용한 것이 정상이라 유예로 닫지 않는다", async () => {
    await connectedGateway();
    await plugin({ "inbound.deliver": dispatchAck });
    await adapter.send(delivery(), { connectionId: CONNECTION_ID });
    gatewayEvent(f.toolStart());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    drop();
    await reconnect();
    events = [];
    await vi.advanceTimersByTimeAsync(RECONNECT_RUN_GRACE_MS * 2);
    expect(closedSignals()).toEqual([]);

    // 툴이 끝났다 — 이제는 승인 대기다
    gatewayEvent(f.toolResult());
    gatewayEvent(f.pluginApprovalRequested());
    drop();
    await reconnect();
    events = [];
    await vi.advanceTimersByTimeAsync(RECONNECT_RUN_GRACE_MS * 2);
    expect(closedSignals()).toEqual([]);
  });

  it("유예 중 다시 끊기면 시계를 버리고 다음 복구 뒤에 다시 잰다", async () => {
    await runThenDrop();
    await reconnect();
    // 남은 유예(0.5s)가 재접속 백오프(1s 안팎)보다 짧다 — 끊긴 동안 시계가 울리면 프레임을 받을 수 없던 런을 닫는다
    await vi.advanceTimersByTimeAsync(RECONNECT_RUN_GRACE_MS - 500);
    drop();
    await reconnect();
    events = [];

    await vi.advanceTimersByTimeAsync(RECONNECT_RUN_GRACE_MS - 1);
    expect(closedSignals()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(closedSignals().map((e) => e.signal.kind)).toEqual(["gateway_error"]);
  });
});
