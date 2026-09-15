import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { InboundDeliver, OutboundMessage } from "@dodok/shared";
import type { EventFrame } from "@openclaw/gateway-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdapterEvent, AdapterError, createOpenClawAdapter, type OpenClawAdapter } from "../src";
import type { GatewayConnectOptions } from "../src/gateway/client";
import * as f from "./fixtures/gateway-events";

// 실제 attachBridge + socket.io-client 가짜 플러그인, Gateway 는 주입한 가짜 connector. 네트워크는 루프백뿐.

const TOKEN = "bridge-test-token";
const CH = f.CHANNEL_ID;
const STORED_MESSAGE_ID = "01a09fc9-d204-7551-89d6-38544d07a2aa";
const hello = { pluginId: "dodok", version: "0.0.0", sdkVersion: "2026.9.4", capabilities: ["config.set"] };

type Responder = (params: Record<string, unknown>) => unknown;
type Ack = (res: unknown) => void;

let app: FastifyInstance;
let ioServer: Server;
let adapter: OpenClawAdapter;
let url: string;
let events: AdapterEvent[];
let canonical: OutboundMessage[];
let canonicalResult: { messageId?: string };
let gatewayResponses: Record<string, Responder>;
let gatewayCalls: Array<{ method: string; params: unknown }>;
let connectOptions: GatewayConnectOptions | undefined;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const clients: Socket[] = [];

beforeEach(async () => {
  events = [];
  canonical = [];
  canonicalResult = { messageId: STORED_MESSAGE_ID };
  gatewayResponses = {};
  gatewayCalls = [];
  connectOptions = undefined;
  app = Fastify({ logger: false });
  ioServer = new Server(app.server, { transports: ["websocket"] });
  adapter = createOpenClawAdapter({
    gateway: {
      url: "wss://gateway.example.test",
      token: "gw-token",
      deviceIdentityPath: "/data/device.json",
    },
    bridge: { io: ioServer, token: TOKEN, serverVersion: "test" },
    logger,
    onCanonical: async (message) => {
      canonical.push(message);
      return canonicalResult;
    },
    connector: async (options) => {
      connectOptions = options;
      return {
        request: async (method: string, params?: unknown) => {
          gatewayCalls.push({ method, params });
          const respond = gatewayResponses[method];
          return (respond ? await respond(params as Record<string, unknown>) : {}) as never;
        },
        stop: async () => undefined,
      };
    },
  });
  adapter.onEvent((e) => events.push(e));
  await app.listen({ host: "127.0.0.1", port: 0 });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/bridge`;
});

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of clients.splice(0)) socket.disconnect();
  await adapter.close();
  ioServer.close();
  await app.close();
});

async function plugin(handlers: Record<string, (payload: never, ack: Ack) => void> = {}): Promise<Socket> {
  const socket = connect(url, { transports: ["websocket"], auth: { token: TOKEN }, reconnection: false });
  clients.push(socket);
  for (const [event, handler] of Object.entries(handlers))
    socket.on(event, handler as (...args: unknown[]) => void);
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  await socket.emitWithAck("hello", hello);
  return socket;
}

const dispatchAck = (payload: InboundDeliver, ack: Ack) =>
  ack({ ok: true, data: { admission: "dispatch", providerRunId: payload.runId } });

function delivery(runId: string = f.RUN_ID): InboundDeliver {
  return {
    deliveryId: randomUUID(),
    kind: "message",
    channelId: CH,
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

async function connectedGateway() {
  await adapter.connect();
  await until(() => adapter.status().gateway === "connected", "gateway connected");
}

function gatewayEvent(frame: EventFrame) {
  if (!connectOptions?.onEvent) throw new Error("gateway not connected");
  connectOptions.onEvent(frame);
}

const ofKind = <K extends AdapterEvent["kind"]>(kind: K) =>
  events.filter((e): e is Extract<AdapterEvent, { kind: K }> => e.kind === kind);

describe("createOpenClawAdapter — 상태", () => {
  it("connect() 는 Gateway 루프를 시작해 gateway connected 를 알리고, close() 는 down 으로 내린다", async () => {
    expect(adapter.status()).toEqual({ provider: "openclaw", gateway: "down", bridge: "down" });
    expect(adapter.capabilities()).toEqual({ sessionReset: true, agentsList: true, configSet: true });

    await connectedGateway();
    expect(ofKind("status").at(-1)).toEqual({
      kind: "status",
      status: { provider: "openclaw", gateway: "connected", bridge: "down" },
      capabilities: { sessionReset: true, agentsList: true, configSet: true },
    });

    await adapter.close();
    expect(adapter.status().gateway).toBe("down");
    expect(ofKind("status").at(-1)?.status.gateway).toBe("down");
  });

  it("플러그인 hello → bridge connected, 새 연결로 교체될 때는 down 을 거치지 않고, 마지막 연결이 끊기면 down", async () => {
    const first = await plugin();
    expect(adapter.status().bridge).toBe("connected");

    await plugin();
    await until(() => first.disconnected, "replaced socket closed");
    const second = clients.at(-1);
    second?.disconnect();
    await until(() => adapter.status().bridge === "down", "bridge down");

    expect(ofKind("status").map((e) => e.status.bridge)).toEqual(["connected", "down"]);
  });

  it("sessionKeyFor 는 원형 세션 키", () => {
    expect(adapter.sessionKeyFor("dev", CH)).toBe(`agent:dev:dodok:channel:${CH}`);
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

    await expect(adapter.send(input)).resolves.toEqual({ admission: "dispatch", providerRunId: input.runId });
    expect(received).toEqual([input]);
  });

  it("ack { ok: true, data: {} } 는 재시도 없이 AdapterError(INTERNAL, ADAPTER_PROTOCOL: …)", async () => {
    const deliver = vi.fn((_payload: InboundDeliver, ack: Ack) => ack({ ok: true, data: {} }));
    await plugin({ "inbound.deliver": deliver });

    const error = await adapter.send(delivery()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: "INTERNAL", message: expect.stringMatching(/^ADAPTER_PROTOCOL: /) });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("플러그인 ok:false(VALIDATION)는 재시도 없이 그 코드로 거부한다", async () => {
    const deliver = vi.fn((_payload: InboundDeliver, ack: Ack) =>
      ack({ ok: false, error: { code: "VALIDATION", message: "runId: Invalid UUID" } }),
    );
    await plugin({ "inbound.deliver": deliver });

    await expect(adapter.send(delivery())).rejects.toMatchObject({
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
    const spy = vi.spyOn(adapter.bridge, "deliverInbound");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const sending = adapter.send(delivery());
    await until(() => deliveries === 1, "first delivery");
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ runId: f.RUN_ID }), 10_000);

    await expect(sending).resolves.toEqual({ admission: "dispatch", providerRunId: f.RUN_ID });
    expect(deliveries).toBe(2);
  });

  it("ack 가 끝내 오지 않으면 1s·4s·16s 로 3회 재시도한 뒤 AdapterError(TIMEOUT)", async () => {
    await plugin({ "inbound.deliver": () => undefined });
    const spy = vi.spyOn(adapter.bridge, "deliverInbound");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const result = adapter.send(delivery()).catch((e: unknown) => e);
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
    const spy = vi.spyOn(adapter.bridge, "deliverInbound");
    const sending = adapter.send(delivery());
    await until(() => spy.mock.calls.length === 1, "first attempt");

    await plugin({ "inbound.deliver": dispatchAck });

    await expect(sending).resolves.toEqual({ admission: "dispatch", providerRunId: f.RUN_ID });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("플러그인이 120s 안에 붙지 않으면 AdapterError(ADAPTER_UNAVAILABLE)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = adapter.send(delivery()).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(119_999);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toMatchObject({ name: "AdapterError", code: "ADAPTER_UNAVAILABLE" });
  });
});

describe("createOpenClawAdapter — 정본 훅", () => {
  it("outbound.message → onCanonical 이 저장한 messageId 를 ack 로 돌려주고 canonical 을 알린다", async () => {
    const socket = await plugin();
    const message = {
      outboundId: "dodok-reply-1",
      channelId: CH,
      agentId: f.PROVIDER_AGENT_ID,
      sessionKey: f.SESSION_KEY,
      runId: f.RUN_ID,
      text: "PONG",
      ts: new Date().toISOString(),
    };

    const ack = await socket.emitWithAck("outbound.message", message);

    expect(ack).toEqual({ ok: true, data: { messageId: STORED_MESSAGE_ID } });
    expect(canonical).toEqual([{ ...message, attachments: [] }]);
    expect(ofKind("canonical")).toEqual([{ kind: "canonical", message: { ...message, attachments: [] } }]);
  });

  it("onCanonical 이 messageId 를 주지 않으면 outboundId 로 ack 한다", async () => {
    canonicalResult = {};
    const socket = await plugin();

    const ack = await socket.emitWithAck("outbound.message", {
      outboundId: "dodok-reply-2",
      channelId: CH,
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
    return adapter.send(delivery());
  }

  it("우리 런의 프레임은 run_signal·run_event 로 내보내고, 모르는 runId 는 무시한다", async () => {
    await sentRun();
    events = [];

    gatewayEvent(f.lifecycleStart());
    gatewayEvent(f.chatDelta("P"));
    gatewayEvent(f.chatDelta("X", { runId: "01a09fc9-d204-7551-89d6-38544d07a2ee" }));

    expect(events).toEqual([
      { kind: "run_signal", runId: f.RUN_ID, signal: { kind: "gateway_started" } },
      {
        kind: "run_event",
        runId: f.RUN_ID,
        event: { type: "TEXT_MESSAGE_START", runId: f.RUN_ID, messageId: f.RUN_ID, role: "assistant" },
      },
      {
        kind: "run_event",
        runId: f.RUN_ID,
        event: { type: "TEXT_MESSAGE_CONTENT", runId: f.RUN_ID, messageId: f.RUN_ID, delta: "P" },
      },
      { kind: "run_signal", runId: f.RUN_ID, signal: { kind: "text_delta" } },
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

    await adapter.send(delivery());

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
      { kind: "run_signal", runId: f.RUN_ID, signal: { kind: "gateway_final" }, snapshotText: "PONG" },
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

  it("핸들러 하나가 던져도 다른 핸들러는 받고 오류는 로그로 남긴다", async () => {
    await sentRun();
    adapter.onEvent(() => {
      throw new Error("handler bug");
    });
    const second: AdapterEvent[] = [];
    adapter.onEvent((e) => second.push(e));

    gatewayEvent(f.lifecycleStart());

    expect(second).toEqual([{ kind: "run_signal", runId: f.RUN_ID, signal: { kind: "gateway_started" } }]);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("createOpenClawAdapter — Gateway 요청·브리지 설정", () => {
  it("resetSession: sessions.reset → sessionStartedAt(ISO)·lifecycleRevision", async () => {
    await connectedGateway();
    gatewayResponses["sessions.reset"] = () => ({
      ok: true,
      key: f.SESSION_KEY,
      entry: { sessionStartedAt: 1_789_399_629_480, lifecycleRevision: "rev-2" },
    });

    await expect(adapter.resetSession(f.SESSION_KEY)).resolves.toEqual({
      sessionStartedAt: new Date(1_789_399_629_480).toISOString(),
      lifecycleRevision: "rev-2",
    });
    expect(gatewayCalls.at(-1)).toEqual({ method: "sessions.reset", params: { key: f.SESSION_KEY } });
  });

  it("resetSession 이 MISSING_SCOPE 면 AdapterError(FORBIDDEN), sessionReset=false 로 내리고 status 를 알린다", async () => {
    await connectedGateway();
    gatewayResponses["sessions.reset"] = () => {
      throw Object.assign(new Error("missing scope: operator.admin"), {
        code: "FORBIDDEN",
        details: { code: "MISSING_SCOPE", missingScope: "operator.admin" },
      });
    };
    events = [];

    await expect(adapter.resetSession(f.SESSION_KEY)).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(adapter.capabilities().sessionReset).toBe(false);
    expect(ofKind("status")).toEqual([
      {
        kind: "status",
        status: { provider: "openclaw", gateway: "connected", bridge: "down" },
        capabilities: { sessionReset: false, agentsList: true, configSet: true },
      },
    ]);
  });

  it("Gateway 가 붙기 전 요청은 AdapterError(ADAPTER_UNAVAILABLE)", async () => {
    await expect(adapter.abort(f.RUN_ID, f.SESSION_KEY)).rejects.toMatchObject({
      code: "ADAPTER_UNAVAILABLE",
    });
  });

  it("abort → chat.abort({ sessionKey, runId })", async () => {
    await connectedGateway();

    await adapter.abort(f.RUN_ID, f.SESSION_KEY);

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

    await expect(adapter.listAgents()).resolves.toEqual([
      { providerAgentId: "dev", name: "Dev" },
      { providerAgentId: "fin" },
    ]);
    expect(gatewayCalls.at(-1)).toEqual({ method: "agents.list", params: {} });

    gatewayResponses["agents.list"] = () => ({ agents: "nope" });
    await expect(adapter.listAgents()).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringMatching(/^ADAPTER_PROTOCOL: /),
    });

    gatewayResponses["agents.list"] = () => {
      throw Object.assign(new Error("forbidden"), { code: "FORBIDDEN" });
    };
    await expect(adapter.listAgents()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(adapter.capabilities().agentsList).toBe(false);
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
      adapter.syncChannelConfig(CH, { systemPrompt: "be brief", requireMention: true }),
    ).resolves.toEqual({
      applied: "live",
    });
    expect(received).toEqual([{ channelId: CH, config: { systemPrompt: "be brief", requireMention: true } }]);

    reply = { ok: false, error: { code: "ADAPTER_UNAVAILABLE", message: "config.set 미지원" } };
    await expect(adapter.syncChannelConfig(CH, { requireMention: false })).rejects.toMatchObject({
      name: "AdapterError",
      code: "ADAPTER_UNAVAILABLE",
    });
  });

  it("syncChannelConfig 는 플러그인이 없으면 기다리지 않고 ADAPTER_UNAVAILABLE", async () => {
    await expect(adapter.syncChannelConfig(CH, { requireMention: true })).rejects.toMatchObject({
      code: "ADAPTER_UNAVAILABLE",
    });
  });
});
