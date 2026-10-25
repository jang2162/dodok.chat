import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InboundDeliver } from "@dodok/shared";
import type { EventFrame } from "@openclaw/gateway-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeAuthGuard } from "../src/bridge/guard";
import {
  type AdapterEvent,
  createOpenClawAdapter,
  type GatewayConnectionConfig,
  type OpenClawAdapter,
} from "../src";
import { GatewayPairingRequiredError, type GatewayConnectOptions } from "../src/gateway/client";
import * as f from "./fixtures/gateway-events";

// 멀티 Gateway 스펙 「OpenClaw 어댑터·브리지」 절 — 어댑터 하나가 Gateway 연결 둘을 품는다. 실제 attachBridge + socket.io-client 가짜 플러그인 둘,
// Gateway 둘은 주소로 가르는 주입 connector(adapter.test.ts 와 같은 가짜). 네트워크는 루프백뿐.

const G1: GatewayConnectionConfig = {
  id: "g1",
  name: "사무실",
  url: "wss://office.example.test",
  token: "gw-1",
  enabled: true,
};
const G2: GatewayConnectionConfig = {
  id: "g2",
  name: "집",
  url: "wss://home.example.test",
  token: "gw-2",
  enabled: true,
};
// 브리지 토큰 → { 토큰 id, Gateway }
const BRIDGE_TOKENS: Record<string, { tokenId: string; gatewayId: string }> = {
  "bridge-g1": { tokenId: "t1", gatewayId: "g1" },
  "bridge-g1-b": { tokenId: "t1b", gatewayId: "g1" },
  "bridge-g2": { tokenId: "t2", gatewayId: "g2" },
  "bridge-gone": { tokenId: "t9", gatewayId: "g-unknown" },
};
const hello = { pluginId: "dodok", version: "0.0.0", sdkVersion: "2026.9.4", capabilities: ["config.set"] };

type Ack = (res: unknown) => void;

/** 주소 하나의 가짜 Gateway — up 이 거짓이면 접속이 실패하고, 붙어 있던 연결은 down() 이 닫는다 */
type FakeGateway = {
  up: boolean;
  connects: GatewayConnectOptions[];
  stops: number;
  calls: Array<{ method: string; params: unknown }>;
  responses: Record<string, (params: Record<string, unknown>) => unknown>;
  pairingFailures: Error[];
  current?: GatewayConnectOptions;
  /** 있으면 stop() 이 이것을 기다린다 — 지우는 사이를 벌린다 */
  stopGate?: Promise<void>;
};

let app: FastifyInstance;
let ioServer: Server;
let adapter: OpenClawAdapter;
let url: string;
let dataDir: string;
let events: AdapterEvent[];
let gateways: Map<string, FakeGateway>;
// 가짜 Gateway 요청·stop 과 PG5 신호의 차례 — `<주소> <메서드>`·`<주소> stop`·`signal <런 id>`
let order: string[];
// 참이면 가짜 Gateway 가 접속 때 디바이스 파일을 만든다(실물 클라이언트처럼)
let writeIdentityOnConnect: boolean;
// 실패 카운터 — 틀린 토큰 3번이면 그 주소가 막힌다
let authGuard: BridgeAuthGuard;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const clients: Socket[] = [];

function fakeGateway(gatewayUrl: string): FakeGateway {
  let gw = gateways.get(gatewayUrl);
  if (!gw) {
    gw = { up: true, connects: [], stops: 0, calls: [], responses: {}, pairingFailures: [] };
    gateways.set(gatewayUrl, gw);
  }
  return gw;
}

/** 붙어 있는 연결을 끊고(post-hello close) 다시 붙지 못하게 한다 */
function down(gw: FakeGateway) {
  gw.up = false;
  const current = gw.current;
  gw.current = undefined;
  current?.onClose?.({ code: 1006, reason: "gone" });
}

beforeEach(async () => {
  for (const log of Object.values(logger)) log.mockClear();
  events = [];
  gateways = new Map();
  order = [];
  writeIdentityOnConnect = false;
  authGuard = new BridgeAuthGuard({ maxFailures: 3 });
  dataDir = mkdtempSync(join(tmpdir(), "dodok-mgw-"));
  app = Fastify({ logger: false });
  ioServer = new Server(app.server, { transports: ["websocket"] });
  adapter = createOpenClawAdapter({
    dataDir,
    bridge: {
      io: ioServer,
      verifyToken: (presented) => (typeof presented === "string" ? (BRIDGE_TOKENS[presented] ?? null) : null),
      serverVersion: "test",
      authGuard,
    },
    logger,
    onCanonical: async () => ({}),
    backoff: { initialMs: 5, maxMs: 10, pairingRetryMs: 10 },
    connector: async (options) => {
      const gw = fakeGateway(options.url);
      gw.connects.push(options);
      const pairing = gw.pairingFailures.shift();
      if (pairing) throw pairing;
      if (!gw.up) throw new Error("ECONNREFUSED");
      if (writeIdentityOnConnect && options.deviceIdentityPath) {
        mkdirSync(dirname(options.deviceIdentityPath), { recursive: true });
        writeFileSync(options.deviceIdentityPath, "{}");
      }
      gw.current = options;
      return {
        request: async (method: string, params?: unknown) => {
          gw.calls.push({ method, params });
          order.push(`${options.url} ${method}`);
          const respond = gw.responses[method];
          return (respond ? await respond(params as Record<string, unknown>) : {}) as never;
        },
        stop: async () => {
          gw.stops += 1;
          order.push(`${options.url} stop`);
          await gw.stopGate;
          if (gw.current === options) gw.current = undefined;
        },
      };
    },
  });
  adapter.onEvent((e) => {
    events.push(e);
    if (e.kind === "run_signal" && e.signal.kind === "gateway_error") order.push(`signal ${e.runId}`);
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/bridge`;
});

afterEach(async () => {
  try {
    for (const socket of clients.splice(0)) socket.disconnect();
    await adapter.close();
  } finally {
    ioServer.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

async function until(condition: () => boolean, label = "condition"): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const dispatchAck = (payload: InboundDeliver, ack: Ack) =>
  ack({ ok: true, data: { admission: "dispatch", providerRunId: payload.runId } });

async function plugin(
  token: string,
  handlers: Record<string, (payload: never, ack: Ack) => void> = { "inbound.deliver": dispatchAck },
): Promise<Socket> {
  const socket = connect(url, { transports: ["websocket"], auth: { token }, reconnection: false });
  clients.push(socket);
  for (const [event, handler] of Object.entries(handlers))
    socket.on(event, handler as (...args: unknown[]) => void);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  await socket.emitWithAck("hello", hello);
  return socket;
}

async function rejectedHandshake(token: string): Promise<string> {
  const socket = connect(url, { transports: ["websocket"], auth: { token }, reconnection: false });
  clients.push(socket);
  const error = await new Promise<Error>((resolve, reject) => {
    socket.once("connect_error", resolve);
    socket.once("connect", () => reject(new Error("handshake accepted")));
  });
  return error.message;
}

function delivery(runId: string = randomUUID()): InboundDeliver {
  return {
    deliveryId: randomUUID(),
    kind: "message",
    channelId: f.CHANNEL_ID,
    conversationId: f.CHANNEL_ID,
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

const gatewayOf = (id: string) => adapter.gatewayStatuses().find((g) => g.id === id);
const setupOf = (id: string) => adapter.gatewaySetupDetails().find((g) => g.id === id);

async function bothConnected() {
  adapter.upsertGateway(G1);
  adapter.upsertGateway(G2);
  await adapter.connect();
  await until(
    () => gatewayOf("g1")?.gateway === "connected" && gatewayOf("g2")?.gateway === "connected",
    "both gateways connected",
  );
}

function gatewayEvent(gw: FakeGateway, frame: EventFrame) {
  if (!gw.current?.onEvent) throw new Error("gateway not connected");
  gw.current.onEvent(frame);
}

/** 그 런의 PG5 신호(ADAPTER_UNAVAILABLE RUN_ERROR + gateway_error) */
function closedRun(runId: string, connectionId: string) {
  return [
    {
      kind: "run_event",
      runId,
      connectionId,
      event: { type: "RUN_ERROR", runId, code: "ADAPTER_UNAVAILABLE", message: expect.any(String) },
    },
    {
      kind: "run_signal",
      runId,
      connectionId,
      signal: {
        kind: "gateway_error",
        code: "ADAPTER_UNAVAILABLE",
        message: expect.any(String),
        connectionClosed: true,
      },
    },
  ];
}

/** 그 가짜 Gateway 가 받은 chat.abort 의 인자 */
const abortsOf = (gw: FakeGateway) => gw.calls.filter((c) => c.method === "chat.abort").map((c) => c.params);

const eventsOfRun = (runId: string) =>
  events.filter((e) => (e.kind === "run_event" || e.kind === "run_signal") && e.runId === runId);

describe("멀티 Gateway — 연결 둘", () => {
  it("upsertGateway 둘 → 둘 다 connected, 각 플러그인이 자기 토큰으로 자기 Gateway 에 붙고 상태가 두 줄", async () => {
    await bothConnected();
    await plugin("bridge-g1");
    await plugin("bridge-g2");

    expect(adapter.gatewayStatuses()).toEqual([
      { id: "g1", name: "사무실", enabled: true, gateway: "connected", bridge: "connected" },
      { id: "g2", name: "집", enabled: true, gateway: "connected", bridge: "connected" },
    ]);
    expect(setupOf("g1")).toMatchObject({
      id: "g1",
      name: "사무실",
      url: G1.url,
      enabled: true,
      gateway: { state: "connected", host: "office.example.test:443", pairing: null },
      bridge: { state: "connected", plugin: { tokenId: "t1" } },
    });
    expect(setupOf("g2")?.bridge.plugin?.tokenId).toBe("t2");
    // Gateway 공유 토큰은 상세에 없다
    expect(JSON.stringify(adapter.gatewaySetupDetails())).not.toMatch(/gw-1|gw-2/);
    // 디바이스 아이덴티티는 DATA_DIR/gateways/<id>/
    expect(fakeGateway(G1.url).connects[0]).toMatchObject({
      url: G1.url,
      token: "gw-1",
      deviceIdentityPath: join(dataDir, "gateways", "g1", "device.json"),
      deviceTokenStorePath: join(dataDir, "gateways", "g1", "device-tokens.json"),
    });
    expect(fakeGateway(G2.url).connects[0]?.deviceIdentityPath).toBe(
      join(dataDir, "gateways", "g2", "device.json"),
    );
  });

  it("Gateway 1 이 내려가면 연결 1 만 재접속 루프, 연결 2 로 send 가 통하고 이벤트의 연결 id 가 g2", async () => {
    await bothConnected();
    await plugin("bridge-g1");
    await plugin("bridge-g2");
    const gw1 = fakeGateway(G1.url);
    const gw2 = fakeGateway(G2.url);

    down(gw1);
    await until(() => gatewayOf("g1")?.gateway === "reconnecting", "g1 reconnecting");
    await until(() => gw1.connects.length >= 3, "g1 retries");
    expect(gatewayOf("g2")?.gateway).toBe("connected");

    const input = delivery();
    await expect(adapter.send(input, { connectionId: "g2" })).resolves.toEqual({
      admission: "dispatch",
      providerRunId: input.runId,
      connectionId: "g2",
    });
    events = [];
    gatewayEvent(gw2, f.lifecycleStart({ runId: input.runId }));
    expect(events).toEqual([
      { kind: "run_signal", runId: input.runId, connectionId: "g2", signal: { kind: "gateway_started" } },
    ]);
    // g2 의 세션 구독은 g2 로만 갔다
    expect(gw2.calls.some((c) => c.method === "sessions.messages.subscribe")).toBe(true);
  });

  it("전달·플러그인 hello·브리지 상태 로그 줄은 그 Gateway 의 id 를 싣고, 공유 토큰·브리지 토큰은 싣지 않는다", async () => {
    await bothConnected();
    logger.info.mockClear();
    const socket = await plugin("bridge-g2");
    const input = delivery();
    await adapter.send(input, { connectionId: "g2" });
    socket.disconnect();
    await until(() => gatewayOf("g2")?.bridge === "down", "g2 plugin down");

    const linesOf = (msg: string) =>
      logger.info.mock.calls
        .filter((call) => call[1] === msg)
        .map((call) => call[0] as Record<string, unknown>);
    expect(linesOf("bridge plugin hello").map((l) => l.gatewayId)).toEqual(["g2"]);
    expect(linesOf("inbound delivered").map((l) => [l.gatewayId, l.runId])).toEqual([["g2", input.runId]]);
    expect(linesOf("bridge status changed").map((l) => [l.gatewayId, l.bridge])).toEqual([
      ["g2", "connected"],
      ["g2", "down"],
    ]);
    const text = JSON.stringify(logger.info.mock.calls);
    for (const secret of [G1.token, G2.token, "bridge-g2"]) expect(text).not.toContain(secret);
  });

  it("send·listAgents 는 연결을 가린다 — null·모르는 id 는 ADAPTER_UNAVAILABLE, listAgents 는 그 Gateway 의 agents.list", async () => {
    await bothConnected();
    fakeGateway(G1.url).responses["agents.list"] = () => ({ agents: [{ id: "dev" }, { id: "fin" }] });
    fakeGateway(G2.url).responses["agents.list"] = () => ({ agents: [{ id: "main" }] });

    await expect(adapter.send(delivery(), { connectionId: null })).rejects.toMatchObject({
      code: "ADAPTER_UNAVAILABLE",
    });
    await expect(adapter.send(delivery(), { connectionId: "nope" })).rejects.toMatchObject({
      code: "ADAPTER_UNAVAILABLE",
    });
    await expect(adapter.listAgents("g1")).resolves.toEqual([
      { providerAgentId: "dev" },
      { providerAgentId: "fin" },
    ]);
    await expect(adapter.listAgents("g2")).resolves.toEqual([{ providerAgentId: "main" }]);
    await expect(adapter.listAgents(null)).rejects.toMatchObject({ code: "ADAPTER_UNAVAILABLE" });
  });

  it("supports·syncChannelConfig 는 그 연결의 플러그인으로", async () => {
    await bothConnected();
    const configs: string[] = [];
    await plugin("bridge-g1", {
      "config.set": (_p: never, ack: Ack) => {
        configs.push("g1");
        ack({ ok: true, data: { applied: "live" } });
      },
    });
    const socket = connect(url, {
      transports: ["websocket"],
      auth: { token: "bridge-g2" },
      reconnection: false,
    });
    clients.push(socket);
    socket.on("config.set", (_p: unknown, ack: Ack) => {
      configs.push("g2");
      ack({ ok: true, data: { applied: "live" } });
    });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    await socket.emitWithAck("hello", { ...hello, capabilities: ["config.set", "threads"] });

    expect(adapter.supports("dev", "g1", "threads")).toBe(false);
    expect(adapter.supports("dev", "g2", "threads")).toBe(true);
    expect(adapter.supports("dev", null, "threads")).toBe(false);
    await adapter.syncChannelConfig(f.CHANNEL_ID, { requireMention: true }, "g2");
    expect(configs).toEqual(["g2"]);
  });

  it("두 Gateway 가 같은 승인 id 를 내도 연결마다 따로 낸다", async () => {
    await bothConnected();
    gatewayEvent(fakeGateway(G1.url), f.pluginApprovalRequested());
    gatewayEvent(fakeGateway(G2.url), f.pluginApprovalRequested());
    const approvals = events.filter((e) => e.kind === "approval");
    expect(approvals.map((e) => [e.connectionId, e.approval.providerApprovalId])).toEqual([
      ["g1", f.APPROVAL_ID],
      ["g2", f.APPROVAL_ID],
    ]);
  });
});

describe("멀티 Gateway — 브리지", () => {
  it("Gateway 1 토큰으로 플러그인이 하나 더 hello 하면 Gateway 1 의 앞 플러그인만 replaced, Gateway 2 플러그인은 그대로", async () => {
    await bothConnected();
    const first = await plugin("bridge-g1");
    const notices: unknown[] = [];
    first.on("system.notice", (n: unknown) => notices.push(n));
    const other = await plugin("bridge-g2");
    let otherDisconnects = 0;
    other.on("disconnect", () => {
      otherDisconnects += 1;
    });

    await plugin("bridge-g1-b");
    await until(() => first.disconnected, "g1 first plugin replaced");

    expect(notices).toEqual([{ reason: "replaced", message: "newer plugin connection" }]);
    expect(other.connected).toBe(true);
    expect(otherDisconnects).toBe(0);
    expect(setupOf("g1")?.bridge.plugin?.tokenId).toBe("t1b");
    expect(setupOf("g2")?.bridge.plugin?.tokenId).toBe("t2");
    expect(gatewayOf("g1")?.bridge).toBe("connected");
  });

  it("모르는 Gateway 의 토큰은 핸드셰이크에서 거절한다", async () => {
    await bothConnected();
    expect(await rejectedHandshake("bridge-gone")).toBe("UNAUTHORIZED");
  });

  it("revokeTokenSessions 는 그 토큰의 소켓만 끊는다", async () => {
    await bothConnected();
    const a = await plugin("bridge-g1");
    const b = await plugin("bridge-g2");
    expect(adapter.revokeTokenSessions("t1")).toBe(1);
    await until(() => a.disconnected, "revoked");
    expect(b.connected).toBe(true);
    await until(() => gatewayOf("g1")?.bridge === "down", "g1 bridge down");
    expect(gatewayOf("g2")?.bridge).toBe("connected");
  });
});

describe("멀티 Gateway — upsertGateway·removeGateway", () => {
  /** 두 Gateway 에 런을 하나씩 열어 둔다(플러그인 dispatch ack 까지) */
  async function openRuns() {
    await bothConnected();
    const p1 = await plugin("bridge-g1");
    const p2 = await plugin("bridge-g2");
    const r1 = randomUUID();
    const r2 = randomUUID();
    await adapter.send(delivery(r1), { connectionId: "g1" });
    await adapter.send(delivery(r2), { connectionId: "g2" });
    events = [];
    return { p1, p2, r1, r2 };
  }

  it("끄면 연결 1 과 플러그인 1 이 끊기고, 그 토큰 핸드셰이크는 거절되고, 그 연결의 열린 런만 PG5 신호로 닫힌다", async () => {
    const { p1, p2, r1, r2 } = await openRuns();
    const gw1 = fakeGateway(G1.url);

    adapter.upsertGateway({ ...G1, enabled: false });

    await until(() => p1.disconnected, "g1 plugin disconnected");
    await until(() => gw1.stops === 1, "g1 link stopped");
    expect(gatewayOf("g1")).toEqual({
      id: "g1",
      name: "사무실",
      enabled: false,
      gateway: "disabled",
      bridge: "down",
    });
    expect(setupOf("g1")?.gateway.state).toBe("disabled");
    await until(() => eventsOfRun(r1).length === 2, "r1 closed");
    expect(eventsOfRun(r1)).toEqual(closedRun(r1, "g1"));
    expect(eventsOfRun(r2)).toEqual([]);
    expect(p2.connected).toBe(true);
    expect(await rejectedHandshake("bridge-g1")).toBe("UNAUTHORIZED");
    await expect(adapter.send(delivery(), { connectionId: "g1" })).rejects.toMatchObject({
      code: "ADAPTER_UNAVAILABLE",
    });
    // 닫힌 런의 늦은 프레임은 버린다(그 런은 잊었다)
    expect(gatewayOf("g2")?.gateway).toBe("connected");
  });

  it("다시 켜면 Gateway 가 다시 붙고, 플러그인이 다시 붙으면 런이 돈다", async () => {
    await openRuns();
    const gw1 = fakeGateway(G1.url);
    adapter.upsertGateway({ ...G1, enabled: false });
    await until(() => gatewayOf("g1")?.bridge === "down", "g1 plugin gone");
    const connectsBefore = gw1.connects.length;

    adapter.upsertGateway(G1);
    await until(() => gatewayOf("g1")?.gateway === "connected", "g1 reconnected");
    expect(gw1.connects.length).toBe(connectsBefore + 1);
    await plugin("bridge-g1");
    const input = delivery();
    await expect(adapter.send(input, { connectionId: "g1" })).resolves.toMatchObject({
      admission: "dispatch",
      connectionId: "g1",
    });
  });

  it("이름만 바꾸면 다시 붙지 않는다 — 연결·플러그인 소켓·열린 런 그대로", async () => {
    const { p1, r1 } = await openRuns();
    const gw1 = fakeGateway(G1.url);
    const connectsBefore = gw1.connects.length;

    adapter.upsertGateway({ ...G1, name: "새 이름" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(gw1.connects.length).toBe(connectsBefore);
    expect(gw1.stops).toBe(0);
    expect(p1.connected).toBe(true);
    expect(gatewayOf("g1")).toMatchObject({ name: "새 이름", gateway: "connected", bridge: "connected" });
    expect(eventsOfRun(r1)).toEqual([]);
    // 런이 그대로 간다 — 그 런의 프레임이 아직 우리 런이다
    gatewayEvent(gw1, f.lifecycleStart({ runId: r1 }));
    expect(eventsOfRun(r1)).toEqual([
      { kind: "run_signal", runId: r1, connectionId: "g1", signal: { kind: "gateway_started" } },
    ]);
  });

  it("주소를 바꾸면 연결 1 만 다시 붙고 그 디바이스 토큰 파일이 지워지며, 연결 1 의 열린 런만 닫힌다", async () => {
    const dir1 = join(dataDir, "gateways", "g1");
    const dir2 = join(dataDir, "gateways", "g2");
    for (const dir of [dir1, dir2]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "device.json"), "{}");
      writeFileSync(join(dir, "device-tokens.json"), "{}");
    }
    const { p1, r1, r2 } = await openRuns();
    const gw2 = fakeGateway(G2.url);
    const g2Connects = gw2.connects.length;

    adapter.upsertGateway({ ...G1, url: "wss://office2.example.test" });
    await until(() => fakeGateway("wss://office2.example.test").connects.length === 1, "new url connect");
    await until(() => gatewayOf("g1")?.gateway === "connected", "g1 connected again");

    await until(() => fakeGateway(G1.url).stops === 1, "old g1 link stopped");
    expect(existsSync(join(dir1, "device-tokens.json"))).toBe(false);
    expect(existsSync(join(dir1, "device.json"))).toBe(true);
    expect(readFileSync(join(dir2, "device-tokens.json"), "utf8")).toBe("{}");
    expect(gw2.connects.length).toBe(g2Connects);
    expect(gw2.stops).toBe(0);
    expect(eventsOfRun(r1)).toEqual(closedRun(r1, "g1"));
    expect(eventsOfRun(r2)).toEqual([]);
    // 플러그인은 Gateway WS 와 따로 붙어 있다 — 주소가 바뀌어도 끊지 않는다
    expect(p1.connected).toBe(true);
    expect(setupOf("g1")).toMatchObject({ url: "wss://office2.example.test" });
  });

  it("토큰을 바꾸면 연결 1 만 다시 붙고 열린 런이 닫히지만 디바이스 토큰은 남는다", async () => {
    const dir1 = join(dataDir, "gateways", "g1");
    mkdirSync(dir1, { recursive: true });
    writeFileSync(join(dir1, "device-tokens.json"), "{}");
    const { r1, r2 } = await openRuns();
    const gw1 = fakeGateway(G1.url);

    adapter.upsertGateway({ ...G1, token: "gw-1-new" });
    await until(() => gw1.connects.length === 2, "g1 reconnect");
    await until(() => eventsOfRun(r1).length === 2, "r1 closed");

    expect(gw1.connects[1]?.token).toBe("gw-1-new");
    expect(existsSync(join(dir1, "device-tokens.json"))).toBe(true);
    expect(eventsOfRun(r1)).toEqual(closedRun(r1, "g1"));
    expect(eventsOfRun(r2)).toEqual([]);
  });

  it("removeGateway 는 디바이스 디렉터리를 지우고, 열린 런을 PG5 신호로 닫고, 상태에서 빼고, 그 토큰을 거절한다", async () => {
    const dir1 = join(dataDir, "gateways", "g1");
    mkdirSync(dir1, { recursive: true });
    writeFileSync(join(dir1, "device.json"), "{}");
    const { p1, p2, r1, r2 } = await openRuns();

    await adapter.removeGateway("g1");

    expect(existsSync(dir1)).toBe(false);
    expect(eventsOfRun(r1)).toEqual(closedRun(r1, "g1"));
    expect(eventsOfRun(r2)).toEqual([]);
    expect(adapter.gatewayStatuses().map((g) => g.id)).toEqual(["g2"]);
    await until(() => p1.disconnected, "g1 plugin disconnected");
    expect(p2.connected).toBe(true);
    expect(await rejectedHandshake("bridge-g1")).toBe("UNAUTHORIZED");
    await expect(adapter.send(delivery(), { connectionId: "g1" })).rejects.toMatchObject({
      code: "ADAPTER_UNAVAILABLE",
    });
    // 없는 id 는 조용히 지나간다
    await expect(adapter.removeGateway("g1")).resolves.toBeUndefined();
  });

  it("removeGateway 는 브리지 자리(중복 흡수 기억)도 버린다 — 같은 id 의 다음 자리는 새 것", async () => {
    await bothConnected();
    const before = adapter.bridge.forGateway("g1");
    const other = adapter.bridge.forGateway("g2");

    await adapter.removeGateway("g1");

    expect(adapter.bridge.forGateway("g1")).not.toBe(before);
    expect(adapter.bridge.forGateway("g2")).toBe(other);
  });

  it("플러그인을 기다리던 send 는 그 Gateway 를 끄면 곧바로 ADAPTER_UNAVAILABLE 로 끝난다", async () => {
    await bothConnected();
    const waiting = adapter.send(delivery(), { connectionId: "g1" }).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 20));

    adapter.upsertGateway({ ...G1, enabled: false });

    expect(await waiting).toMatchObject({ name: "AdapterError", code: "ADAPTER_UNAVAILABLE" });
  });

  it("플러그인 ack 를 기다리던 send 는 그 Gateway 의 주소를 바꾸면 ack 타임아웃(10s)을 기다리지 않고 곧바로 끝난다", async () => {
    await bothConnected();
    let received = 0;
    // 받기만 하고 ack 하지 않는다 — 플러그인은 붙은 채라 브리지 대기가 끝나지 않는다
    await plugin("bridge-g1", {
      "inbound.deliver": () => {
        received += 1;
      },
    });
    const view = adapter.bridge.forGateway("g1");
    const bridgeWaits: Array<Promise<unknown>> = [];
    const original = view.deliverInbound.bind(view);
    vi.spyOn(view, "deliverInbound").mockImplementation((payload, timeoutMs) => {
      const pending = original(payload, timeoutMs);
      bridgeWaits.push(pending);
      return pending;
    });
    const input = delivery();
    const waiting = adapter.send(input, { connectionId: "g1" }).catch((e: unknown) => e);
    await until(() => received === 1, "delivered to plugin");
    const startedAt = performance.now();

    adapter.upsertGateway({ ...G1, url: "wss://office2.example.test" });

    expect(await waiting).toMatchObject({ name: "AdapterError", code: "ADAPTER_UNAVAILABLE" });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    // 브리지의 ack 대기도 끝났다 — ack 제한시간까지 남지 않는다
    expect(bridgeWaits).toHaveLength(1);
    expect(
      await Promise.race([
        bridgeWaits[0],
        new Promise((resolve) => setTimeout(() => resolve("pending"), 500)),
      ]),
    ).toMatchObject({ ok: false, error: { code: "ADAPTER_UNAVAILABLE" } });
    // 플러그인이 ack 전에 이미 디스패치했을 수 있다 — 그 런도 옛 링크로 멈춘다
    await until(() => abortsOf(fakeGateway(G1.url)).length === 1, "abort for the pending send");
    expect(abortsOf(fakeGateway(G1.url))).toEqual([{ sessionKey: f.SESSION_KEY, runId: input.runId }]);
  });

  it("id 가 경로가 될 수 없는 꼴이면 upsertGateway 가 던진다", () => {
    for (const id of ["", "..", "a/b", "a\\b"]) {
      expect(() => adapter.upsertGateway({ ...G1, id })).toThrow();
    }
  });

  it("페어링 대기는 그 연결에만 남는다", async () => {
    fakeGateway(G1.url).pairingFailures.push(
      new GatewayPairingRequiredError({
        cause: new Error("NOT_PAIRED"),
        details: { code: "PAIRING_REQUIRED" },
        message: "device pairing required",
        requestId: "req-1",
      }),
    );
    adapter.upsertGateway(G1);
    adapter.upsertGateway(G2);
    await adapter.connect();
    await until(() => setupOf("g1")?.gateway.pairing !== null, "g1 pairing");
    expect(setupOf("g1")?.gateway.pairing).toMatchObject({ requestId: "req-1" });
    await until(() => gatewayOf("g2")?.gateway === "connected", "g2 connected");
    expect(setupOf("g2")?.gateway.pairing).toBeNull();
  });

  it("connect() 뒤에 더한 Gateway 는 곧바로 붙는다", async () => {
    await adapter.connect();
    adapter.upsertGateway(G2);
    await until(() => gatewayOf("g2")?.gateway === "connected", "g2 connected");
  });

  it("frameDumpPath 는 연결마다 <path>.<id> 파일", async () => {
    const dumpPath = join(dataDir, "frames.jsonl");
    const dumping = createOpenClawAdapter({
      dataDir,
      bridge: { io: ioServer, verifyToken: () => null, serverVersion: "test" },
      logger,
      onCanonical: async () => ({}),
      frameDumpPath: dumpPath,
      connector: async (options) => {
        const gw = fakeGateway(`dump:${options.url}`);
        gw.current = options;
        return { request: async () => ({}) as never, stop: async () => undefined };
      },
    });
    try {
      dumping.upsertGateway(G1);
      await dumping.connect();
      await until(() => fakeGateway(`dump:${G1.url}`).current !== undefined, "dump gateway connected");
      gatewayEvent(fakeGateway(`dump:${G1.url}`), f.chatDelta("P"));
    } finally {
      await dumping.close();
    }
    expect(readFileSync(`${dumpPath}.g1`, "utf8")).toContain('"event":"chat"');
    expect(existsSync(dumpPath)).toBe(false);
  });
});

describe("멀티 Gateway — 연결을 닫을 때 Gateway 안의 런 멈추기(리뷰 I1)", () => {
  const OTHER_URL = "wss://office2.example.test";

  /** g1 에 런 둘, g2 에 런 하나를 연다(플러그인 dispatch ack 까지) */
  async function openRunsOnBoth() {
    await bothConnected();
    await plugin("bridge-g1");
    await plugin("bridge-g2");
    const r1 = randomUUID();
    const r1b = randomUUID();
    const r2 = randomUUID();
    await adapter.send(delivery(r1), { connectionId: "g1" });
    await adapter.send(delivery(r1b), { connectionId: "g1" });
    await adapter.send(delivery(r2), { connectionId: "g2" });
    events = [];
    order = [];
    return { r1, r1b, r2 };
  }

  it.each<[string, () => unknown]>([
    ["끄기", () => adapter.upsertGateway({ ...G1, enabled: false })],
    ["주소 변경", () => adapter.upsertGateway({ ...G1, url: OTHER_URL })],
    ["토큰 변경", () => adapter.upsertGateway({ ...G1, token: "gw-1-new" })],
    ["삭제", () => adapter.removeGateway("g1")],
  ])(
    "%s — 옛 링크를 멈추기 전에 그 링크로 열린 런마다 chat.abort 를 한 번씩, 그 뒤 PG5 신호, 다른 Gateway 에는 0번",
    async (_name, act) => {
      const { r1, r1b, r2 } = await openRunsOnBoth();
      const gw1 = fakeGateway(G1.url);
      const gw2 = fakeGateway(G2.url);

      await act();
      await until(() => gw1.stops === 1, "old g1 link stopped");
      await until(() => eventsOfRun(r1).length === 2 && eventsOfRun(r1b).length === 2, "g1 runs closed");

      const aborts = abortsOf(gw1) as Array<{ sessionKey: string; runId: string }>;
      expect(aborts.map((a) => a.runId).sort()).toEqual([r1, r1b].sort());
      expect(aborts.every((a) => a.sessionKey === f.SESSION_KEY)).toBe(true);
      expect(abortsOf(gw2)).toEqual([]);
      expect(abortsOf(fakeGateway(OTHER_URL))).toEqual([]);
      expect(eventsOfRun(r1)).toEqual(closedRun(r1, "g1"));
      expect(eventsOfRun(r2)).toEqual([]);
      // 차례: chat.abort 둘 → PG5 신호 둘 → 옛 링크 stop
      const abortAt = order.lastIndexOf(`${G1.url} chat.abort`);
      const signalAt = Math.min(order.indexOf(`signal ${r1}`), order.indexOf(`signal ${r1b}`));
      const stopAt = order.indexOf(`${G1.url} stop`);
      expect(abortAt).toBeGreaterThanOrEqual(0);
      expect(abortAt).toBeLessThan(signalAt);
      expect(Math.max(order.indexOf(`signal ${r1}`), order.indexOf(`signal ${r1b}`))).toBeLessThan(stopAt);
    },
  );

  it("chat.abort 가 실패하거나 답이 없어도 PG5 신호는 나고 옛 링크는 멈춘다 — 실패는 warn, 기다림은 런마다 상한", async () => {
    const { r1, r1b } = await openRunsOnBoth();
    const gw1 = fakeGateway(G1.url);
    gw1.responses["chat.abort"] = (params) => {
      if (params.runId === r1) throw new Error("abort refused");
      return new Promise(() => undefined); // r1b 는 답이 없다
    };
    const startedAt = performance.now();

    adapter.upsertGateway({ ...G1, enabled: false });

    const deadline = startedAt + 5_000;
    while (gw1.stops === 0 || eventsOfRun(r1b).length < 2) {
      if (performance.now() > deadline) throw new Error("timed out waiting for close");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(performance.now() - startedAt).toBeLessThan(4_000);
    expect(eventsOfRun(r1)).toEqual(closedRun(r1, "g1"));
    expect(eventsOfRun(r1b)).toEqual(closedRun(r1b, "g1"));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "g1", runId: r1 }),
      "chat.abort on connection close failed",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "g1", runId: r1b }),
      "chat.abort on connection close failed",
    );
  }, 10_000);

  it("Gateway WS 가 끊겨 있으면 chat.abort 없이 곧바로 PG5 신호를 낸다", async () => {
    const { r1 } = await openRunsOnBoth();
    const gw1 = fakeGateway(G1.url);
    down(gw1);
    await until(() => gatewayOf("g1")?.gateway === "reconnecting", "g1 reconnecting");

    adapter.upsertGateway({ ...G1, enabled: false });

    await until(() => eventsOfRun(r1).length === 2, "r1 closed");
    expect(abortsOf(gw1)).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), "chat.abort on connection close failed");
  });

  it("ack 를 기다리던 send 의 Gateway 를 끄면 그 전송은 플러그인을 다시 기다리지 않는다", async () => {
    await bothConnected();
    let received = 0;
    await plugin("bridge-g1", {
      "inbound.deliver": () => {
        received += 1;
      },
    });
    const input = delivery();
    const waiting = adapter.send(input, { connectionId: "g1" }).catch((e: unknown) => e);
    await until(() => received === 1, "delivered to plugin");

    adapter.upsertGateway({ ...G1, enabled: false });

    expect(await waiting).toMatchObject({ code: "ADAPTER_UNAVAILABLE" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 닫힌 런은 120s 플러그인 대기에 들어가지 않는다
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: input.runId }),
      "plugin not connected; waiting",
    );
  });

  it("g1 을 끄는 사이 g2 에 ack 를 기다리던 전송은 그대로 — g2 플러그인이 받는 inbound.deliver 는 한 번(탐침 PE)", async () => {
    await bothConnected();
    await plugin("bridge-g1");
    const acks: Ack[] = [];
    // g2 플러그인은 받기만 하고 ack 를 미룬다 — 그 사이 g1 을 끈다
    await plugin("bridge-g2", {
      "inbound.deliver": (_payload: InboundDeliver, ack: Ack) => {
        acks.push(ack);
      },
    });
    const input = delivery();
    const waiting = adapter.send(input, { connectionId: "g2" });
    await until(() => acks.length === 1, "delivered to g2 plugin");

    adapter.upsertGateway({ ...G1, enabled: false });
    await until(() => fakeGateway(G1.url).stops === 1, "old g1 link stopped");
    await new Promise((resolve) => setTimeout(resolve, 100));

    // g1 끄기가 g2 의 ack 대기를 끝냈다면 플러그인 대기를 거쳐 같은 전달을 다시 보낸다
    expect(acks).toHaveLength(1);
    acks[0]?.({ ok: true, data: { admission: "dispatch", providerRunId: input.runId } });
    await expect(waiting).resolves.toMatchObject({ connectionId: "g2" });
    expect(acks).toHaveLength(1);
    expect(abortsOf(fakeGateway(G2.url))).toEqual([]);
  });

  it("어댑터 close() 는 옛 링크 정리(abort 상한 → stop)를 기다린다", async () => {
    const { r1 } = await openRunsOnBoth();
    const gw1 = fakeGateway(G1.url);
    gw1.responses["chat.abort"] = () => new Promise(() => undefined);

    adapter.upsertGateway({ ...G1, enabled: false });
    await adapter.close();

    expect(gw1.stops).toBe(1);
    expect(eventsOfRun(r1)).toEqual(closedRun(r1, "g1"));
  }, 10_000);

  it("끄고 곧바로 다시 켜도 링크는 새 것 하나만 붙고, 옛 링크는 abort 뒤 멈춘다", async () => {
    await openRunsOnBoth();
    const gw1 = fakeGateway(G1.url);
    const connectsBefore = gw1.connects.length;

    adapter.upsertGateway({ ...G1, enabled: false });
    adapter.upsertGateway(G1);

    await until(() => gatewayOf("g1")?.gateway === "connected", "g1 connected again");
    await until(() => gw1.stops === 1, "old g1 link stopped");
    expect(gw1.connects.length).toBe(connectsBefore + 1);
    expect(gw1.current).toBeDefined();
  });
});

describe("멀티 Gateway — 지우기·디바이스 파일 경합(리뷰 M1·M2·M3)", () => {
  it("주소를 바꿀 때 디바이스 토큰 파일을 못 지워도 warn 만 남기고 새 주소로 붙는다(탐침 P7)", async () => {
    const dir1 = join(dataDir, "gateways", "g1");
    // 파일 자리에 비지 않은 디렉터리 — rmSync(force) 도 던진다
    mkdirSync(join(dir1, "device-tokens.json", "x"), { recursive: true });
    await bothConnected();

    expect(() => adapter.upsertGateway({ ...G1, url: "wss://office2.example.test" })).not.toThrow();

    await until(() => fakeGateway("wss://office2.example.test").connects.length === 1, "new url connect");
    await until(() => gatewayOf("g1")?.gateway === "connected", "g1 connected again");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "g1" }),
      "gateway device token removal failed",
    );
  });

  it("removeGateway 가 디바이스 디렉터리를 못 지워도 끝까지 간다 — 목록에서 빠지고 warn", async () => {
    await bothConnected();
    const dir1 = join(dataDir, "gateways", "g1");
    mkdirSync(join(dir1, "sub"), { recursive: true });
    writeFileSync(join(dir1, "sub", "f"), "x");
    // sub 를 읽기·실행만으로 — 그 안의 파일을 지울 수 없어 rmSync 가 던진다
    chmodSync(join(dir1, "sub"), 0o500);
    try {
      await expect(adapter.removeGateway("g1")).resolves.toBeUndefined();
    } finally {
      chmodSync(join(dir1, "sub"), 0o700);
    }
    expect(existsSync(dir1)).toBe(true);
    expect(adapter.gatewayStatuses().map((g) => g.id)).toEqual(["g2"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: "g1" }),
      "gateway device directory removal failed",
    );
  });

  it("지우는 사이 같은 id 를 다시 더하면 지우기가 끝난 뒤에 만든다 — 새 연결의 디바이스 파일이 지워지지 않는다(탐침 P6)", async () => {
    writeIdentityOnConnect = true;
    await bothConnected();
    const gw1 = fakeGateway(G1.url);
    let release!: () => void;
    gw1.stopGate = new Promise((resolve) => {
      release = resolve;
    });
    const removing = adapter.removeGateway("g1");
    await until(() => gw1.stops === 1, "stop in progress");

    try {
      adapter.upsertGateway(G1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      // 지우는 동안은 아직 없다 — 옛 연결도 새 연결도 받지 않는다
      expect(gatewayOf("g1")).toBeUndefined();
    } finally {
      gw1.stopGate = undefined;
      release();
      await removing;
    }
    await until(() => gatewayOf("g1")?.gateway === "connected", "g1 added again after removal");
    expect(existsSync(join(dataDir, "gateways", "g1", "device.json"))).toBe(true);
  });

  it("지우는 사이 미뤄 둔 같은 id 의 upsert 는 어댑터 close() 뒤에 적용되지 않는다 — 닫힌 어댑터에 연결이 되살아나지 않는다(탐침 PF)", async () => {
    await bothConnected();
    const gw1 = fakeGateway(G1.url);
    const connectsBefore = gw1.connects.length;
    let release!: () => void;
    gw1.stopGate = new Promise((resolve) => {
      release = resolve;
    });
    const removing = adapter.removeGateway("g1");
    await until(() => gw1.stops === 1, "stop in progress");

    adapter.upsertGateway(G1);
    const closing = adapter.close();
    gw1.stopGate = undefined;
    release();
    await removing;
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(gw1.connects).toHaveLength(connectsBefore);
    expect(gatewayOf("g1")).toBeUndefined();
  });

  it("꺼진 Gateway 토큰의 거절은 실패 카운터에 세지 않는다 — 같은 주소의 다른 Gateway 토큰이 통한다(변이 Mb)", async () => {
    await bothConnected();
    adapter.upsertGateway({ ...G1, enabled: false });
    for (let i = 0; i < 4; i += 1) expect(await rejectedHandshake("bridge-g1")).toBe("UNAUTHORIZED");

    await expect(plugin("bridge-g2")).resolves.toBeDefined();

    // 대조 — 틀린 토큰 3번이면 같은 주소가 막혀 g2 토큰도 거절된다(카운터가 이 브리지에 붙어 있다)
    for (let i = 0; i < 3; i += 1) expect(await rejectedHandshake("nope")).toBe("UNAUTHORIZED");
    expect(await rejectedHandshake("bridge-g2")).toBe("UNAUTHORIZED");
  });

  it("removeGateway 가 WS stop 을 기다리는 사이 그 Gateway 토큰 핸드셰이크는 거절된다(변이 Me)", async () => {
    await bothConnected();
    const gw1 = fakeGateway(G1.url);
    let release!: () => void;
    gw1.stopGate = new Promise((resolve) => {
      release = resolve;
    });
    const removing = adapter.removeGateway("g1");
    await until(() => gw1.stops === 1, "stop in progress");

    try {
      expect(await rejectedHandshake("bridge-g1")).toBe("UNAUTHORIZED");
    } finally {
      release();
      await removing;
    }
  });
});

describe("멀티 Gateway — 상태 목록·단수 상세(계약 status()·setupDetail())", () => {
  it("Gateway 가 없으면 빈 목록, 상세는 빈 블록", () => {
    expect(adapter.status()).toEqual({ provider: "openclaw", gateways: [] });
    expect(adapter.setupDetail()).toEqual({
      provider: "openclaw",
      gateway: { state: "down", host: "", version: null, pairing: null },
      bridge: { state: "down", plugin: null },
    });
    expect(adapter.gatewayStatuses()).toEqual([]);
  });

  it("status() 는 Gateway 마다 한 줄(더한 차례) — 꺼진 Gateway 는 enabled false·disabled 이고, 지운 Gateway 는 빠진다", async () => {
    await bothConnected();
    await plugin("bridge-g1");
    const line = (g: typeof G1, gateway: string, bridge: string, enabled = true) => ({
      id: g.id,
      name: g.name,
      enabled,
      gateway,
      bridge,
    });
    expect(adapter.status()).toEqual({
      provider: "openclaw",
      gateways: [line(G1, "connected", "connected"), line(G2, "connected", "down")],
    });

    down(fakeGateway(G2.url));
    await until(() => adapter.status().gateways[1]?.gateway === "reconnecting", "g2 reconnecting");
    expect(adapter.status().gateways[0]?.gateway).toBe("connected");

    adapter.upsertGateway({ ...G2, enabled: false });
    expect(adapter.status().gateways[1]).toEqual(line(G2, "disabled", "down", false));

    await adapter.removeGateway(G2.id);
    expect(adapter.status()).toEqual({
      provider: "openclaw",
      gateways: [line(G1, "connected", "connected")],
    });
  });

  it("상세는 첫 켜진 Gateway 의 것", async () => {
    adapter.upsertGateway({ ...G1, enabled: false });
    adapter.upsertGateway(G2);
    expect(adapter.setupDetail().gateway.host).toBe("home.example.test:443");
  });

  it("다른 Gateway 의 상세가 바뀌어도 setup 이벤트를 낸다", async () => {
    await bothConnected();
    const before = events.filter((e) => e.kind === "setup").length;
    await plugin("bridge-g2");
    await until(() => events.filter((e) => e.kind === "setup").length > before, "setup event");
  });
});
