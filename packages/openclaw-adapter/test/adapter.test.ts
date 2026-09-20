import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
let gatewayStop: () => Promise<void>;
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
        stop: () => gatewayStop(),
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
    // 가짜 타이머를 버리기 전에 잰다 — close() 뒤에 어댑터·브리지가 건 대기 타이머가 남으면 안 된다
    if (vi.isFakeTimers()) await expectNoTimersLeft();
  } finally {
    vi.useRealTimers();
    ioServer.close();
    await app.close();
  }
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

/**
 * close() 뒤 가짜 타이머가 남지 않았는지 잰다. 가짜 시계는 멈춰 있으므로 어댑터·브리지의 대기 타이머(재시도·waitForReady)는
 * 스스로 사라지지 않는다. 브리지 소켓을 닫을 때 ws 가 거는 closeTimer(30s)만 TCP 가 닫히면서 지워지므로 그때까지 실제 I/O 를 돌린다.
 */
async function expectNoTimersLeft() {
  await until(() => vi.getTimerCount() === 0, "fake timers cleared").catch(() => undefined);
  expect(vi.getTimerCount(), "fake timers left after close()").toBe(0);
}

async function connectedGateway() {
  await adapter.connect();
  await until(() => adapter.status().gateway === "connected", "gateway connected");
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
      ["ackMs", "admission", "deliveryId", "retries", "runId", "waitedForPlugin"].sort(),
    );
    expect(JSON.stringify(line)).not.toContain(input.message.text);
  }
  return lines;
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
    expect(deliveredLines(input)).toEqual([
      {
        runId: input.runId,
        deliveryId: input.deliveryId,
        admission: "dispatch",
        ackMs: expect.any(Number),
        retries: 0,
        waitedForPlugin: false,
      },
    ]);
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });

    const input = delivery();
    const sending = adapter.send(input);
    await until(() => deliveries === 1, "first delivery");
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ runId: f.RUN_ID }), 10_000);

    await expect(sending).resolves.toEqual({ admission: "dispatch", providerRunId: f.RUN_ID });
    expect(deliveries).toBe(2);
    // ackMs 는 첫 전송 시도부터 — ack 타임아웃 10s + 재시도 대기 1s
    expect(deliveredLines(input)).toEqual([
      expect.objectContaining({ admission: "dispatch", ackMs: 11_000, retries: 1, waitedForPlugin: false }),
    ]);
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
    const input = delivery();
    const sending = adapter.send(input);
    await until(() => spy.mock.calls.length === 1, "first attempt");

    await plugin({ "inbound.deliver": dispatchAck });

    await expect(sending).resolves.toEqual({ admission: "dispatch", providerRunId: f.RUN_ID });
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
    await expect(adapter.send(dropped)).resolves.toMatchObject({ admission: "drop" });
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
    await expect(adapter.send(rejected)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(deliveredLines(rejected)).toEqual([]);
  });

  it("플러그인을 기다리는 동안 forgetRun 된 런은 플러그인이 붙어도 보내지 않고 ADAPTER_UNAVAILABLE 로 끝난다", async () => {
    const deliverSpy = vi.spyOn(adapter.bridge, "deliverInbound");
    const waitSpy = vi.spyOn(adapter.bridge, "waitForReady");
    const result = adapter.send(delivery()).catch((e: unknown) => e);
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
    const deliverSpy = vi.spyOn(adapter.bridge, "deliverInbound");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = adapter.send(delivery()).catch((e: unknown) => e);
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
    const result = adapter.send(delivery()).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(119_999);
    await vi.advanceTimersByTimeAsync(1);

    expect(await result).toMatchObject({ name: "AdapterError", code: "ADAPTER_UNAVAILABLE" });
  });

  it("플러그인을 기다리는 중 close() 하면 send 는 곧바로 ADAPTER_UNAVAILABLE(adapter closed)로 끝나고 타이머가 남지 않는다", async () => {
    const deliverSpy = vi.spyOn(adapter.bridge, "deliverInbound");
    const waitSpy = vi.spyOn(adapter.bridge, "waitForReady");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const result = adapter
      .send(delivery())
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
    await expect(adapter.send(delivery())).rejects.toMatchObject({
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
    const deliverSpy = vi.spyOn(adapter.bridge, "deliverInbound");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const result = adapter
      .send(delivery())
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
    expect(adapter.status()).toMatchObject({ gateway: "down" });
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
    await adapter.send(delivery());
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

describe("Gateway 프레임 덤프(frameDumpPath)", () => {
  it("받은 chat·agent·session.message 프레임을 JSONL 로 남기고 close() 에서 닫는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-adapter-dump-"));
    const path = join(dir, "frames.jsonl");
    // 공유 ioServer 에는 이미 기본 어댑터의 /bridge 가 붙어 있다 — 덤프 어댑터는 HTTP 에 붙지 않은 따로 된 서버를 쓴다
    const io = new Server();
    let onEvent: ((frame: EventFrame) => void) | undefined;
    const dumping = createOpenClawAdapter({
      gateway: {
        url: "wss://gateway.example.test",
        token: "gw-token",
        deviceIdentityPath: "/data/device.json",
      },
      bridge: { io, token: TOKEN, serverVersion: "test" },
      logger,
      onCanonical: async () => ({}),
      frameDumpPath: path,
      connector: async (options) => {
        onEvent = options.onEvent;
        return { request: async () => ({}) as never, stop: async () => undefined };
      },
    });
    try {
      await dumping.connect();
      await until(() => dumping.status().gateway === "connected", "dump adapter connected");
      onEvent?.(f.lifecycleStart());
      onEvent?.(f.sessionsChanged());
      onEvent?.(f.chatDelta("안"));
      onEvent?.(f.sessionMessage());
      await dumping.close();

      const events = readFileSync(path, "utf8")
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
    await until(() => adapter.status().gateway === "connected", "gateway connected");
    const subscribesAtDeliver: number[] = [];
    await plugin({
      "inbound.deliver": (payload: InboundDeliver, ack: Ack) => {
        subscribesAtDeliver.push(
          gatewayCalls.filter((c) => c.method === "sessions.messages.subscribe").length,
        );
        dispatchAck(payload, ack);
      },
    });

    await adapter.send(delivery());
    await adapter.send(delivery(randomUUID()));

    expect(gatewayCalls.filter((c) => c.method === "sessions.messages.subscribe")).toEqual([
      {
        method: "sessions.messages.subscribe",
        params: { key: f.SESSION_KEY, agentId: f.PROVIDER_AGENT_ID, includeApprovals: true },
      },
    ]);
    expect(subscribesAtDeliver).toEqual([1, 1]); // 구독이 전송보다 먼저다
  });

  it("Gateway 가 끊겨 있으면 구독 없이 전송한다(정본은 플러그인 경로) — 붙을 때 recover 가 agent_sessions 로 구독한다", async () => {
    await plugin({ "inbound.deliver": dispatchAck });
    await expect(adapter.send(delivery())).resolves.toMatchObject({ admission: "dispatch" });
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
      channelId: CH,
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
      { event: "plugin.approval.requested" },
      "gateway approval frame ignored",
    );
    // 토큰·본문·남의 세션 키를 남기지 않는다
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(other);
  });

  it("세션 구독에 includeApprovals 를 넣고 응답의 approvalReplay 를 승인 이벤트로 흘린다", async () => {
    gatewayResponses["sessions.messages.subscribe"] = () => f.approvalSubscribeResult();
    await connectedGateway();
    await plugin({ "inbound.deliver": dispatchAck });

    await adapter.send(delivery());

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

    await expect(adapter.resolveApproval(f.APPROVAL_ID, "plugin", "allow-once")).resolves.toMatchObject({
      providerApprovalId: f.APPROVAL_ID,
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      channelId: CH,
    });
    expect(gatewayCalls.filter((c) => c.method === "approval.resolve")).toEqual([
      { method: "approval.resolve", params: { id: f.APPROVAL_ID, kind: "plugin", decision: "allow-once" } },
    ]);
  });

  // `kind` 는 저장된 행에서만 오므로 어댑터가 한 값으로 굳히면 exec·system-agent 승인이 어긋난 kind 로 나간다.
  it("resolveApproval 은 받은 kind 를 그대로 인자에 싣는다 — plugin 으로 굳어 있지 않다", async () => {
    gatewayResponses["approval.resolve"] = () => f.approvalResolveResult();
    await connectedGateway();

    await adapter.resolveApproval(f.APPROVAL_ID, "exec", "allow-once");
    await adapter.resolveApproval(f.APPROVAL_ID, "system-agent", "deny");

    expect(gatewayCalls.filter((c) => c.method === "approval.resolve").map((c) => c.params)).toEqual([
      { id: f.APPROVAL_ID, kind: "exec", decision: "allow-once" },
      { id: f.APPROVAL_ID, kind: "system-agent", decision: "deny" },
    ]);
  });

  it("Gateway 가 끊겨 있으면 ADAPTER_UNAVAILABLE, 응답 모양이 다르면 ADAPTER_PROTOCOL", async () => {
    await expect(adapter.resolveApproval(f.APPROVAL_ID, "plugin", "deny")).rejects.toMatchObject({
      name: "AdapterError",
      code: "ADAPTER_UNAVAILABLE",
    });

    gatewayResponses["approval.resolve"] = () => ({ applied: true });
    await connectedGateway();

    await expect(adapter.resolveApproval(f.APPROVAL_ID, "plugin", "deny")).rejects.toMatchObject({
      code: "INTERNAL",
      message: expect.stringMatching(/^ADAPTER_PROTOCOL: approval\.resolve/),
    });
  });
});
