import { BRIDGE_PROTOCOL, type BridgeHello, type InboundDeliver, type OutboundMessage } from "@dodok/shared";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachBridge, type BridgeHandle } from "../../../../packages/openclaw-adapter/src/bridge/server";
import { FAKE_PLUGIN_HELLO, type FakePlugin, startFakePlugin } from "./fake-plugin";

const TOKEN = "fake-bridge-token";
const CHANNEL_ID = "01a09fc9-d204-7551-89d6-38544d07c001";
const RUN_ID = "01a09fc9-d204-7551-89d6-38544d07c002";
const MESSAGE_ID = "01a09fc9-d204-7551-89d6-38544d07c003";
const DELIVERY_ID = "01a09fc9-d204-7551-89d6-38544d07c004";
const SESSION_KEY = `agent:dev:dodok:channel:${CHANNEL_ID}`;

function sampleDelivery(overrides: Partial<InboundDeliver> = {}): InboundDeliver {
  return {
    deliveryId: DELIVERY_ID,
    kind: "message",
    channelId: CHANNEL_ID,
    agentId: "dev",
    sessionKey: SESSION_KEY,
    runId: RUN_ID,
    message: {
      id: MESSAGE_ID,
      author: { type: "user", handle: "owner", displayName: "Owner" },
      text: "@dev 안녕",
      attachments: [],
      ts: new Date().toISOString(),
    },
    context: { recentMessages: [], participants: [], relayRules: "" },
    options: {},
    ...overrides,
  };
}

describe("가짜 플러그인 — 실제 attachBridge 에 붙는다", () => {
  let io: Server;
  let url: string;
  let bridge: BridgeHandle;
  const hellos: BridgeHello[] = [];
  const outbound: OutboundMessage[] = [];
  const plugins: FakePlugin[] = [];

  beforeEach(async () => {
    hellos.length = 0;
    outbound.length = 0;
    const http = createServer();
    io = new Server(http);
    bridge = attachBridge(io, {
      token: TOKEN,
      serverVersion: "9.9.9",
      onHello: (_session, hello) => hellos.push(hello),
      onOutboundMessage: async (_session, message) => {
        outbound.push(message);
        return { messageId: `stored-${outbound.length}` };
      },
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const plugin of plugins.splice(0)) plugin.close();
    bridge.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  async function start(onInbound?: (d: InboundDeliver) => Promise<{ admission: "dispatch" | "drop" }>) {
    const plugin = await startFakePlugin({
      bridgeUrl: url,
      token: TOKEN,
      ...(onInbound ? { onInbound } : {}),
    });
    plugins.push(plugin);
    return plugin;
  }

  it("접속하면 실제 플러그인과 같은 모양의 hello 를 보내고, ack 뒤에 resolve 한다", async () => {
    await start();
    expect(hellos).toEqual([FAKE_PLUGIN_HELLO]);
    expect(FAKE_PLUGIN_HELLO).toMatchObject({ pluginId: "dodok", sdkVersion: "2026.9.4" });
    expect(bridge.current()?.phase).toBe("ready");
  });

  it("토큰이 틀리면 startFakePlugin 이 reject 한다", async () => {
    await expect(startFakePlugin({ bridgeUrl: url, token: "wrong-token" })).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("inbound.deliver 를 onInbound 에 넘기고 그 결과로 ack 한다 — 기본은 dispatch(providerRunId = runId)", async () => {
    const plugin = await start();
    const delivery = sampleDelivery();
    await expect(bridge.deliverInbound(delivery, 2_000)).resolves.toEqual({
      ok: true,
      data: { admission: "dispatch", providerRunId: RUN_ID },
    });
    expect(plugin.received).toEqual([delivery]);
  });

  it("onInbound 를 나중에 바꿔 끼울 수 있고, 던지면 INTERNAL 로 ack 한다", async () => {
    const plugin = await start();
    plugin.onInbound = async () => ({ admission: "drop", reason: "bot-loop-protection" });
    await expect(bridge.deliverInbound(sampleDelivery(), 2_000)).resolves.toEqual({
      ok: true,
      data: { admission: "drop", reason: "bot-loop-protection" },
    });

    plugin.onInbound = async () => {
      throw new Error("대본 없음");
    };
    await expect(bridge.deliverInbound(sampleDelivery(), 2_000)).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "대본 없음" },
    });
    expect(plugin.received).toHaveLength(2);
  });

  it("계약에 맞지 않는 inbound.deliver 는 실제 플러그인처럼 VALIDATION 으로 ack 하고 onInbound 를 부르지 않는다", async () => {
    const onInbound = vi.fn(async () => ({ admission: "dispatch" as const }));
    const plugin = await start(onInbound);
    const res = await bridge.deliverInbound({ ...sampleDelivery(), runId: "not-a-uuid" }, 2_000);
    expect(res).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(onInbound).not.toHaveBeenCalled();
    expect(plugin.received).toEqual([]);
  });

  it("sendOutbound 는 outboundId(uuid)·ts 를 채워 outbound.message 를 보내고, onOutboundMessage 가 준 messageId 를 돌려준다", async () => {
    const plugin = await start();
    const before = Date.now();
    await expect(
      plugin.sendOutbound({
        channelId: CHANNEL_ID,
        agentId: "dev",
        sessionKey: SESSION_KEY,
        runId: RUN_ID,
        replyToInboundId: MESSAGE_ID,
        text: "안녕하세요",
        attachments: [],
      }),
    ).resolves.toEqual({ messageId: "stored-1" });

    expect(outbound).toEqual([
      {
        outboundId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        channelId: CHANNEL_ID,
        agentId: "dev",
        sessionKey: SESSION_KEY,
        runId: RUN_ID,
        replyToInboundId: MESSAGE_ID,
        text: "안녕하세요",
        attachments: [],
        ts: expect.any(String),
      },
    ]);
    expect(Date.parse(outbound[0]?.ts ?? "")).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("서버가 outbound.message 를 거절하면 sendOutbound 가 그 코드로 reject 한다", async () => {
    const plugin = await start();
    await expect(
      plugin.sendOutbound({
        channelId: "not-a-uuid",
        agentId: "dev",
        sessionKey: SESSION_KEY,
        text: "x",
        attachments: [],
      }),
    ).rejects.toThrow(/VALIDATION/);
    expect(outbound).toEqual([]);
  });

  it("config.set 은 applied live 로 ack 하고 configSets 에 기록한다, agents.list 는 dev·fin 을 준다", async () => {
    const plugin = await start();
    const payload = { channelId: CHANNEL_ID, config: { systemPrompt: "정중하게" } };
    await expect(bridge.setConfig(payload, 2_000)).resolves.toEqual({ ok: true, data: { applied: "live" } });
    expect(plugin.configSets).toEqual([payload]);

    await expect(bridge.listAgents(2_000)).resolves.toEqual({
      ok: true,
      data: { agents: [{ agentId: "dev", name: "dev" }, { agentId: "fin" }] },
    });
  });

  it("system.notice 를 notices 에 모은다(서버 bridge.close)", async () => {
    const plugin = await start();
    bridge.close();
    await vi.waitFor(() =>
      expect(plugin.notices).toEqual([{ reason: "shutdown", message: "server shutting down" }]),
    );
  });

  it("disconnect() 뒤 서버에서 사라지고, reconnect() 는 다시 hello 해서 ready 가 된다", async () => {
    const plugin = await start();
    plugin.disconnect();
    await vi.waitFor(() => expect(bridge.current()).toBeUndefined());

    await plugin.reconnect();
    expect(bridge.current()?.phase).toBe("ready");
    expect(hellos).toHaveLength(2);
    await expect(bridge.deliverInbound(sampleDelivery(), 2_000)).resolves.toMatchObject({ ok: true });
  });

  it("hello ack 의 protocol 을 확인한다", async () => {
    const plugin = await start();
    expect(plugin.helloResult).toEqual({ serverVersion: "9.9.9", protocol: BRIDGE_PROTOCOL });
  });
});
