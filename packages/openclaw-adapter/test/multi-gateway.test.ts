import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundDeliver } from "@dodok/shared";
import type { EventFrame } from "@openclaw/gateway-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AdapterEvent,
  createOpenClawAdapter,
  type GatewayConnectionConfig,
  type OpenClawAdapter,
} from "../src";
import { GatewayPairingRequiredError, type GatewayConnectOptions } from "../src/gateway/client";
import * as f from "./fixtures/gateway-events";

// 멀티 Gateway 스펙 5장 — 어댑터 하나가 Gateway 연결 둘을 품는다. 실제 attachBridge + socket.io-client 가짜 플러그인 둘,
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
};

let app: FastifyInstance;
let ioServer: Server;
let adapter: OpenClawAdapter;
let url: string;
let dataDir: string;
let events: AdapterEvent[];
let gateways: Map<string, FakeGateway>;
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
  events = [];
  gateways = new Map();
  dataDir = mkdtempSync(join(tmpdir(), "dodok-mgw-"));
  app = Fastify({ logger: false });
  ioServer = new Server(app.server, { transports: ["websocket"] });
  adapter = createOpenClawAdapter({
    dataDir,
    bridge: {
      io: ioServer,
      verifyToken: (presented) => (typeof presented === "string" ? (BRIDGE_TOKENS[presented] ?? null) : null),
      serverVersion: "test",
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
      gw.current = options;
      return {
        request: async (method: string, params?: unknown) => {
          gw.calls.push({ method, params });
          const respond = gw.responses[method];
          return (respond ? await respond(params as Record<string, unknown>) : {}) as never;
        },
        stop: async () => {
          gw.stops += 1;
          if (gw.current === options) gw.current = undefined;
        },
      };
    },
  });
  adapter.onEvent((e) => events.push(e));
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
      signal: { kind: "gateway_error", code: "ADAPTER_UNAVAILABLE", message: expect.any(String) },
    },
  ];
}

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
    expect(gw1.stops).toBe(1);
    expect(gatewayOf("g1")).toEqual({
      id: "g1",
      name: "사무실",
      enabled: false,
      gateway: "disabled",
      bridge: "down",
    });
    expect(setupOf("g1")?.gateway.state).toBe("disabled");
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

    expect(fakeGateway(G1.url).stops).toBe(1);
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
    const waiting = adapter.send(delivery(), { connectionId: "g1" }).catch((e: unknown) => e);
    await until(() => received === 1, "delivered to plugin");
    const startedAt = performance.now();

    adapter.upsertGateway({ ...G1, url: "wss://office2.example.test" });

    expect(await waiting).toMatchObject({ name: "AdapterError", code: "ADAPTER_UNAVAILABLE" });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
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

describe("멀티 Gateway — 단수 상태·상세(계약 status()·setupDetail())", () => {
  it("Gateway 가 없으면 down/down, 상세는 빈 블록", () => {
    expect(adapter.status()).toEqual({ provider: "openclaw", gateway: "down", bridge: "down" });
    expect(adapter.setupDetail()).toEqual({
      provider: "openclaw",
      gateway: { state: "down", host: "", version: null, pairing: null },
      bridge: { state: "down", plugin: null },
    });
    expect(adapter.gatewayStatuses()).toEqual([]);
  });

  it("켜진 Gateway 가운데 가장 나쁜 상태를 모으고, 플러그인은 켜진 Gateway 모두에 붙어야 connected — 꺼진 Gateway 는 세지 않는다", async () => {
    await bothConnected();
    await plugin("bridge-g1");
    expect(adapter.status()).toEqual({ provider: "openclaw", gateway: "connected", bridge: "down" });
    await plugin("bridge-g2");
    expect(adapter.status()).toEqual({ provider: "openclaw", gateway: "connected", bridge: "connected" });

    down(fakeGateway(G2.url));
    await until(() => adapter.status().gateway === "reconnecting", "aggregate reconnecting");

    adapter.upsertGateway({ ...G2, enabled: false });
    await until(() => adapter.status().gateway === "connected", "disabled g2 not counted");
    expect(adapter.status().bridge).toBe("connected");
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
