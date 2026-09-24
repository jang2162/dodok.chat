import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { InboundDeliver, OutboundMessage } from "@dodok/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachBridge, type BridgeHandle } from "../src/bridge/server";

const TOKEN = "bridge-test-token";
const OTHER_TOKEN = "bridge-other-token";
// 검증 함수가 아는 토큰 → 토큰 id
const TOKEN_IDS: Record<string, string> = { [TOKEN]: "t1", [OTHER_TOKEN]: "t2" };
const BUNDLE_SHA = "a".repeat(64);
const CH = "01a09fc9-d204-7551-89d6-38544d07a102";

const hello = {
  pluginId: "dodok",
  version: "0.0.0",
  sdkVersion: "2026.9.4",
  capabilities: ["run_id_in_outbound"],
};

let app: FastifyInstance;
let ioServer: Server;
let bridge: BridgeHandle;
let url: string;
let received: OutboundMessage[];
let storeDelayMs: number;
let rejected: string[];
let nowMs: number;
// 검증 함수가 던지는 경우(저장소 오류)를 재는 테스트만 켠다
let verifyThrows: boolean;
const clients: Socket[] = [];

function client(token: string): Socket {
  const socket = connect(url, { transports: ["websocket"], auth: { token }, reconnection: false });
  clients.push(socket);
  return socket;
}

function waitFor(socket: Socket, event: "connect" | "connect_error"): Promise<unknown> {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function readyClient(): Promise<Socket> {
  const socket = client(TOKEN);
  await waitFor(socket, "connect");
  await socket.emitWithAck("hello", hello);
  return socket;
}

function outbound(outboundId: string) {
  return {
    outboundId,
    channelId: CH,
    agentId: "main",
    sessionKey: `agent:main:dodok:channel:${CH}`,
    text: "PONG",
    ts: new Date().toISOString(),
  };
}

beforeEach(async () => {
  received = [];
  storeDelayMs = 0;
  rejected = [];
  nowMs = 0;
  verifyThrows = false;
  app = Fastify({ logger: false });
  ioServer = new Server(app.server, { transports: ["websocket"] });
  bridge = attachBridge(ioServer, {
    verifyToken: (presented) => {
      if (verifyThrows) throw new Error("SqliteError: no such table: bridge_tokens");
      const tokenId = typeof presented === "string" ? TOKEN_IDS[presented] : undefined;
      return tokenId ? { tokenId } : null;
    },
    serverVersion: "test",
    now: () => nowMs,
    onRejected: (reason) => rejected.push(reason),
    onOutboundMessage: async (_session, message) => {
      received.push(message);
      if (storeDelayMs > 0) await new Promise((done) => setTimeout(done, storeDelayMs));
      return { messageId: randomUUID() };
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/bridge`;
});

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.disconnect();
  bridge.close();
  ioServer.close();
  await app.close();
});

describe("attachBridge (실제 Socket.IO)", () => {
  it("토큰이 다르면 핸드셰이크에서 UNAUTHORIZED 로 거부한다", async () => {
    const socket = client("wrong");
    const error = (await waitFor(socket, "connect_error")) as Error;
    expect(error.message).toBe("UNAUTHORIZED");
  });

  it("검증 함수가 준 토큰 id 를 세션에 싣고, hello 의 bundleSha256 도 세션에 남는다", async () => {
    const socket = client(OTHER_TOKEN);
    await waitFor(socket, "connect");
    await socket.emitWithAck("hello", { ...hello, bundleSha256: BUNDLE_SHA });
    expect(bridge.current()?.tokenId).toBe("t2");
    expect(bridge.current()?.hello?.bundleSha256).toBe(BUNDLE_SHA);
  });

  it("검증 함수가 던지면 통과가 아니라 UNAUTHORIZED 로 거절하고, 거절 로그에는 토큰이 없다", async () => {
    verifyThrows = true;
    const socket = client(TOKEN);
    const error = (await waitFor(socket, "connect_error")) as Error;
    expect(error.message).toBe("UNAUTHORIZED");
    expect(socket.connected).toBe(false);
    expect(bridge.current()).toBeUndefined();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatch(/^token mismatch from \S+$/);
    expect(rejected.join("\n")).not.toContain(TOKEN);
  });

  it("같은 주소에서 거절이 10번 와도 onRejected 는 1분에 한 번이고, 1분 뒤 한 번 더 — 눌러 둔 수를 싣는다", async () => {
    for (let i = 0; i < 10; i += 1) {
      nowMs = i * 1_000;
      await waitFor(client("revoked-token"), "connect_error");
    }
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatch(/^token mismatch from \S+$/);
    // 거절 로그에 제시된 토큰은 싣지 않는다
    expect(rejected.join("\n")).not.toContain("revoked-token");

    nowMs = 60_000;
    await waitFor(client("revoked-token"), "connect_error");
    expect(rejected).toHaveLength(2);
    expect(rejected[1]).toMatch(/\(9 more suppressed\)$/);
  });

  it("revokeSessions(tokenId) 는 그 토큰의 소켓만 끊고 끊은 수를 돌려준다", async () => {
    const revoked = client(TOKEN);
    await waitFor(revoked, "connect");
    const kept = client(OTHER_TOKEN);
    await waitFor(kept, "connect");
    await kept.emitWithAck("hello", hello);
    const disconnected = new Promise((resolve) => revoked.once("disconnect", resolve));

    expect(bridge.revokeSessions("t1")).toBe(1);
    await disconnected;
    expect(kept.connected).toBe(true);
    expect(bridge.current()?.tokenId).toBe("t2");
    expect(bridge.revokeSessions("unknown")).toBe(0);

    expect(bridge.revokeSessions("t2")).toBe(1);
    await new Promise((resolve) => kept.once("disconnect", resolve));
    expect(bridge.current()).toBeUndefined();
  });

  it("hello → ready, 같은 outboundId 재전송은 한 번만 저장하고 같은 messageId 를 돌려준다", async () => {
    const socket = client(TOKEN);
    await waitFor(socket, "connect");
    const helloAck = await socket.emitWithAck("hello", hello);
    expect(helloAck).toEqual({ ok: true, data: { serverVersion: "test", protocol: 1 } });
    expect(bridge.current()?.hello?.pluginId).toBe("dodok");

    const message = {
      outboundId: "o-1",
      channelId: CH,
      agentId: "main",
      sessionKey: `agent:main:dodok:channel:${CH}`,
      text: "PONG",
      ts: new Date().toISOString(),
    };
    const first = await socket.emitWithAck("outbound.message", message);
    const second = await socket.emitWithAck("outbound.message", message);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(received).toHaveLength(1);
  });

  it("재연결 뒤 같은 outboundId 를 다시 보내면 onOutboundMessage 는 한 번만 불리고 두 번째도 같은 ack 를 받는다", async () => {
    const before = await readyClient();
    const first = await before.emitWithAck("outbound.message", outbound("o-reconnect"));
    expect(first.ok).toBe(true);
    before.disconnect();

    const after = await readyClient();
    const second = await after.emitWithAck("outbound.message", outbound("o-reconnect"));
    expect(second).toEqual(first);
    expect(received).toHaveLength(1);
  });

  it("처리 중인 outboundId 가 다른 연결로 다시 오면 기다렸다가 같은 결과를 받는다 (저장 한 번)", async () => {
    storeDelayMs = 100;
    const before = await readyClient();
    // 새 연결의 hello 가 이전 연결을 교체해 끊으므로 이 ack 는 클라이언트에서 reject 된다
    const abandoned = before.emitWithAck("outbound.message", outbound("o-inflight")).catch((e: Error) => e);
    await new Promise((done) => setTimeout(done, 20));

    // 플러그인이 ack 타임아웃으로 끊고 재연결해 head 를 다시 보낸 모양
    const after = await readyClient();
    const retried = await after.emitWithAck("outbound.message", outbound("o-inflight"));
    expect(retried.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(await abandoned).toBeInstanceOf(Error);
  });

  it("hello 전 outbound 는 PROTOCOL_MISMATCH", async () => {
    const socket = client(TOKEN);
    await waitFor(socket, "connect");
    const res = await socket.emitWithAck("outbound.message", {
      outboundId: "o-2",
      channelId: CH,
      agentId: "main",
      sessionKey: `agent:main:dodok:channel:${CH}`,
      text: "x",
      ts: new Date().toISOString(),
    });
    expect(res).toMatchObject({ ok: false, error: { code: "PROTOCOL_MISMATCH" } });
  });

  it("deliverInbound 는 플러그인 ack 를 돌려주고, 연결이 없으면 ADAPTER_UNAVAILABLE", async () => {
    const delivery = { deliveryId: randomUUID() } as InboundDeliver;
    expect(await bridge.deliverInbound(delivery, 1_000)).toMatchObject({
      ok: false,
      error: { code: "ADAPTER_UNAVAILABLE" },
    });

    const socket = client(TOKEN);
    socket.on("inbound.deliver", (payload: InboundDeliver, ack: (res: unknown) => void) => {
      ack({ ok: true, data: { admission: "dispatch", providerRunId: payload.deliveryId } });
    });
    await waitFor(socket, "connect");
    await socket.emitWithAck("hello", hello);
    expect(await bridge.deliverInbound(delivery, 1_000)).toEqual({
      ok: true,
      data: { admission: "dispatch", providerRunId: delivery.deliveryId },
    });
  });

  it.each([
    ["data 가 InboundDeliverResult 가 아님(옛 번들의 {})", { ok: true, data: {} }],
    ["Result 봉투가 아님", {}],
    ["ok:false 인데 error 코드가 ErrorCode 가 아님", { ok: false, error: { code: "WEIRD", message: "x" } }],
  ])("플러그인 ack 를 경계에서 파싱한다 — %s → INTERNAL ADAPTER_PROTOCOL", async (_name, raw) => {
    const socket = client(TOKEN);
    socket.on("inbound.deliver", (_payload: InboundDeliver, ack: (res: unknown) => void) => ack(raw));
    await waitFor(socket, "connect");
    await socket.emitWithAck("hello", hello);

    const res = await bridge.deliverInbound({ deliveryId: randomUUID() } as InboundDeliver, 1_000);
    expect(res).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(res.ok ? "" : res.error.message).toMatch(/^ADAPTER_PROTOCOL: /);
  });

  it("플러그인 ok:false 는 코드·메시지 그대로, config.set·agents.list ack 도 파싱한다", async () => {
    const socket = client(TOKEN);
    socket.on("inbound.deliver", (_payload: InboundDeliver, ack: (res: unknown) => void) =>
      ack({ ok: false, error: { code: "VALIDATION", message: "bad" } }),
    );
    socket.on("config.set", (_payload: unknown, ack: (res: unknown) => void) =>
      ack({ ok: true, data: { applied: "sometimes" } }),
    );
    socket.on("agents.list", (_payload: unknown, ack: (res: unknown) => void) =>
      ack({ ok: true, data: { agents: [{ agentId: "dev", name: "Dev" }] } }),
    );
    await waitFor(socket, "connect");
    await socket.emitWithAck("hello", hello);

    expect(await bridge.deliverInbound({ deliveryId: randomUUID() } as InboundDeliver, 1_000)).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "bad" },
    });
    const config = await bridge.setConfig({ channelId: CH, config: { requireMention: true } }, 1_000);
    expect(config).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(await bridge.listAgents(1_000)).toEqual({
      ok: true,
      data: { agents: [{ agentId: "dev", name: "Dev" }] },
    });
  });
});

describe("attachBridge — 거절 로그 주소(clientAddress)", () => {
  it("clientAddress 가 준 주소로 거절 로그를 남기고 그 주소별로 줄인다", async () => {
    const own = Fastify({ logger: false });
    const ownIo = new Server(own.server, { transports: ["websocket"] });
    const logged: string[] = [];
    const ownBridge = attachBridge(ownIo, {
      verifyToken: () => null,
      serverVersion: "test",
      now: () => 0,
      clientAddress: (handshake) => String(handshake.headers["x-test-client"] ?? "none"),
      onRejected: (reason) => logged.push(reason),
      onOutboundMessage: async () => ({ messageId: randomUUID() }),
    });
    await own.listen({ host: "127.0.0.1", port: 0 });
    const ownUrl = `ws://127.0.0.1:${(own.server.address() as AddressInfo).port}/bridge`;
    const open = (client: string) => {
      const socket = connect(ownUrl, {
        transports: ["websocket"],
        auth: { token: "x" },
        reconnection: false,
        extraHeaders: { "x-test-client": client },
      });
      clients.push(socket);
      return socket;
    };
    try {
      await waitFor(open("203.0.113.7"), "connect_error");
      await waitFor(open("203.0.113.7"), "connect_error");
      await waitFor(open("198.51.100.9"), "connect_error");
      expect(logged).toEqual(["token mismatch from 203.0.113.7", "token mismatch from 198.51.100.9"]);
    } finally {
      ownBridge.close();
      ownIo.close();
      await own.close();
    }
  });

  it("clientAddress 가 던지면 handshake.address 로 남기고 거절은 그대로다", async () => {
    const own = Fastify({ logger: false });
    const ownIo = new Server(own.server, { transports: ["websocket"] });
    const logged: string[] = [];
    const ownBridge = attachBridge(ownIo, {
      verifyToken: () => null,
      serverVersion: "test",
      clientAddress: () => {
        throw new Error("boom");
      },
      onRejected: (reason) => logged.push(reason),
      onOutboundMessage: async () => ({ messageId: randomUUID() }),
    });
    await own.listen({ host: "127.0.0.1", port: 0 });
    const ownUrl = `ws://127.0.0.1:${(own.server.address() as AddressInfo).port}/bridge`;
    try {
      const socket = connect(ownUrl, {
        transports: ["websocket"],
        auth: { token: "x" },
        reconnection: false,
      });
      clients.push(socket);
      expect(((await waitFor(socket, "connect_error")) as Error).message).toBe("UNAUTHORIZED");
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(/^token mismatch from \S*127\.0\.0\.1$/);
    } finally {
      ownBridge.close();
      ownIo.close();
      await own.close();
    }
  });
});
