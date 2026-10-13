import {
  BRIDGE_PROTOCOL,
  type BridgeControlCall,
  type BridgeHello,
  CONTROL_CALL_TIMEOUT_MS,
  type OutboundMessage,
} from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { createBridgeClient, type BridgeClientOptions } from "../src/bridge-client";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";

const hello: BridgeHello = {
  pluginId: "dodok",
  version: "0.0.0",
  sdkVersion: "2026.9.4",
  capabilities: ["run_id_in_outbound"],
};

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

function outbound(outboundId: string): OutboundMessage {
  return {
    outboundId,
    channelId: CH,
    agentId: "main",
    sessionKey: `agent:main:dodok:channel:${CH}`,
    text: outboundId,
    attachmentIds: [],
    ts: "2026-09-15T01:02:03.000Z",
  };
}

type Respond = (event: string, payload: unknown) => Promise<unknown>;

/** socket.io-client Socket 중 브리지 클라이언트가 쓰는 만큼만 흉내 낸다 — 실제 소켓 없이 연결·끊김·ack 를 스크립트로 준다 */
class FakeSocket {
  connected = false;
  connects = 0;
  disconnects = 0;
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  /** emitWithAck 마다 건 ack 제한시간 */
  readonly timeouts: Array<{ event: string; ms: number }> = [];
  readonly #handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(readonly respond: Respond) {}

  on(event: string, handler: (...args: unknown[]) => void): this {
    this.#handlers.set(event, [...(this.#handlers.get(event) ?? []), handler]);
    return this;
  }

  connect(): this {
    if (this.connected) return this;
    this.connected = true;
    this.connects += 1;
    setTimeout(() => this.#fire("connect"), 0);
    return this;
  }

  /** 실제 클라이언트처럼 연결돼 있을 때만 disconnect 이벤트를 동기로 낸다 */
  disconnect(): this {
    if (!this.connected) return this;
    this.connected = false;
    this.disconnects += 1;
    this.#fire("disconnect", "io client disconnect");
    return this;
  }

  timeout(ms: number) {
    return {
      emitWithAck: (event: string, payload: unknown) => {
        this.timeouts.push({ event, ms });
        this.emitted.push({ event, payload });
        return this.respond(event, payload);
      },
    };
  }

  emit(event: string, payload: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }

  outboundIds(): string[] {
    return this.emitted
      .filter((entry) => entry.event === "outbound.message")
      .map((entry) => (entry.payload as OutboundMessage).outboundId);
  }

  #fire(event: string, ...args: unknown[]): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(...args);
  }
}

function clientWith(socket: FakeSocket) {
  return createBridgeClient({
    url: "ws://bridge.test/bridge",
    token: "t0k",
    hello,
    handlers: { onInbound: async () => ({ admission: "dispatch" }) },
    logger: silent,
    backoff: { baseMs: 1, maxMs: 1, jitter: 0 },
    connectSocket: (() => socket) as unknown as BridgeClientOptions["connectSocket"],
  });
}

const helloOk = { ok: true, data: { serverVersion: "test", protocol: BRIDGE_PROTOCOL } };

describe("createBridgeClient 큐 flush (가짜 소켓)", () => {
  it("head 의 ack 가 타임아웃이면 끊고 재연결해 같은 head 부터 다시 보내고, 다음 항목도 보낸다", async () => {
    let outboundAttempts = 0;
    const socket = new FakeSocket(async (event, payload) => {
      if (event === "hello") return helloOk;
      if (event !== "outbound.message") throw new Error(`unexpected ${event}`);
      outboundAttempts += 1;
      if (outboundAttempts === 1) throw new Error("operation has timed out");
      return { ok: true, data: { messageId: `m-${(payload as OutboundMessage).outboundId}` } };
    });
    const client = clientWith(socket);

    // 연결 전이라 둘 다 큐에 쌓인다
    const first = client.sendOutbound(outbound("o-1"));
    const second = client.sendOutbound(outbound("o-2"));
    client.start();

    await expect(first).resolves.toEqual({ messageId: "m-o-1" });
    await expect(second).resolves.toEqual({ messageId: "m-o-2" });
    expect(socket.outboundIds()).toEqual(["o-1", "o-1", "o-2"]);
    expect(socket.disconnects).toBe(1);
    expect(socket.connects).toBe(2);
    expect(client.state).toBe("ready");
    expect(client.queueDepth).toBe(0);
    await client.stop();
  });

  it("ack 가 오류(ok:false)면 그 항목만 reject 하고 연결을 유지한 채 다음 항목을 보낸다", async () => {
    const socket = new FakeSocket(async (event, payload) => {
      if (event === "hello") return helloOk;
      const { outboundId } = payload as OutboundMessage;
      if (outboundId === "o-1") return { ok: false, error: { code: "INTERNAL", message: "store failed" } };
      return { ok: true, data: { messageId: `m-${outboundId}` } };
    });
    const client = clientWith(socket);

    const first = client.sendOutbound(outbound("o-1"));
    const second = client.sendOutbound(outbound("o-2"));
    client.start();

    await expect(first).rejects.toThrow("INTERNAL: store failed");
    await expect(second).resolves.toEqual({ messageId: "m-o-2" });
    expect(socket.outboundIds()).toEqual(["o-1", "o-2"]);
    expect(socket.disconnects).toBe(0);
    await client.stop();
  });
});

describe("createBridgeClient sendControl — 제어 도구 호출", () => {
  const SESSION = `agent:main:dodok:channel:${CH}`;
  const call: BridgeControlCall = {
    callId: "c1",
    sessionKey: SESSION,
    runId: "01a09fc9-d204-7551-89d6-38544d07a301",
    tool: "list_channels",
    args: {},
  };

  async function ready(respond: Respond) {
    let readyNow!: () => void;
    const isReady = new Promise<void>((resolve) => (readyNow = resolve));
    const socket = new FakeSocket(respond);
    const client = createBridgeClient({
      url: "ws://bridge.test/bridge",
      token: "t0k",
      hello,
      handlers: { onInbound: async () => ({ admission: "dispatch" }), onReady: () => readyNow() },
      logger: silent,
      backoff: { baseMs: 1, maxMs: 1, jitter: 0 },
      connectSocket: (() => socket) as unknown as BridgeClientOptions["connectSocket"],
    });
    client.start();
    await isReady;
    return { socket, client };
  }

  it("ready 면 control.call 을 보내고 ack 를 shared CONTROL_CALL_TIMEOUT_MS 까지 기다린다 — 짧은 기본값이 없다", async () => {
    const { socket, client } = await ready(async (event) =>
      event === "hello" ? helloOk : { ok: true, data: [{ name: "dev" }] },
    );
    expect(await client.sendControl(call)).toEqual({ ok: true, data: [{ name: "dev" }] });
    expect(socket.emitted.filter((e) => e.event === "control.call")).toEqual([
      { event: "control.call", payload: call },
    ]);
    expect(socket.timeouts.find((t) => t.event === "control.call")?.ms).toBe(CONTROL_CALL_TIMEOUT_MS);
    await client.stop();
  });

  it("ready 가 아니면 보내지도 큐에 넣지도 않고 ADAPTER_UNAVAILABLE — 다시 붙은 연결로 늦게 나가지 않는다", async () => {
    const socket = new FakeSocket(async (event) => (event === "hello" ? helloOk : { ok: true, data: null }));
    const client = clientWith(socket);
    expect(await client.sendControl(call)).toMatchObject({
      ok: false,
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
    client.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(socket.emitted.map((e) => e.event)).not.toContain("control.call");
    await client.stop();
  });

  it("보낸 뒤 끊김·시간 초과(socket.io-client 의 거절)는 unknown — 서버가 받았을 수 있다", async () => {
    for (const message of ["socket has been disconnected", "operation has timed out"]) {
      const { client } = await ready(async (event) => {
        if (event === "hello") return helloOk;
        throw new Error(message);
      });
      expect(await client.sendControl(call)).toEqual({ unknown: true });
      await client.stop();
    }
  });

  it("서버가 ok:false 면 그대로, 계약과 다른 ack 는 INTERNAL", async () => {
    const { client } = await ready(async (event) =>
      event === "hello"
        ? helloOk
        : { ok: false, error: { code: "NOT_FOUND", message: "열린 런이 없습니다" } },
    );
    expect(await client.sendControl(call)).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "열린 런이 없습니다" },
    });
    await client.stop();
    const bad = await ready(async (event) => (event === "hello" ? helloOk : { ok: "yes" }));
    expect(await bad.client.sendControl(call)).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    await bad.client.stop();
  });
});
