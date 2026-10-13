import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  AdapterError,
  type BridgeControlCall,
  type ControlResult,
  type InboundDeliver,
  type OutboundMessage,
} from "@dodok/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeAuthGuard } from "../src/bridge/guard";
import { attachBridge, type BridgeHandle } from "../src/bridge/server";
import type { BridgeSessionState } from "../src/bridge/session";

const TOKEN = "bridge-test-token";
const OTHER_TOKEN = "bridge-other-token";
// 검증 함수가 아는 토큰 → 토큰 id
const TOKEN_IDS: Record<string, string> = { [TOKEN]: "t1", [OTHER_TOKEN]: "t2" };
// 두 토큰 모두 이 Gateway 에 묶였다 — Gateway 를 가르는 브리지 동작은 multi-gateway.test.ts
const GATEWAY = "gw-1";
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

/** 앱·Socket.IO·브리지를 띄운다 — extra 는 이 테스트 파일의 기본 옵션 위에 얹는다 */
async function start(extra: Partial<Parameters<typeof attachBridge>[1]> = {}) {
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
      return tokenId ? { tokenId, gatewayId: GATEWAY } : null;
    },
    acceptGateway: () => true,
    serverVersion: "test",
    now: () => nowMs,
    onRejected: (reason) => rejected.push(reason),
    onOutboundMessage: async (_session, message) => {
      received.push(message);
      if (storeDelayMs > 0) await new Promise((done) => setTimeout(done, storeDelayMs));
      return { messageId: randomUUID() };
    },
    ...extra,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/bridge`;
}

async function stop() {
  for (const socket of clients.splice(0)) socket.disconnect();
  bridge.close();
  ioServer.close();
  await app.close();
}

beforeEach(() => start());
afterEach(() => stop());

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
    expect(bridge.forGateway(GATEWAY).current()?.tokenId).toBe("t2");
    expect(bridge.forGateway(GATEWAY).current()?.hello?.bundleSha256).toBe(BUNDLE_SHA);
  });

  it("검증 함수가 던지면 통과가 아니라 UNAUTHORIZED 로 거절하고, 거절 로그에는 토큰이 없다", async () => {
    verifyThrows = true;
    const socket = client(TOKEN);
    const error = (await waitFor(socket, "connect_error")) as Error;
    expect(error.message).toBe("UNAUTHORIZED");
    expect(socket.connected).toBe(false);
    expect(bridge.forGateway(GATEWAY).current()).toBeUndefined();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatch(/^token mismatch from \S+$/);
    expect(rejected.join("\n")).not.toContain(TOKEN);
  });

  it("logAddress 를 주면 거절 로그의 주소는 그 값이고, 스로틀은 원래 주소로 센다", async () => {
    await stop();
    const seen: string[] = [];
    await start({
      logAddress: (address) => {
        seen.push(address);
        return "203.0.113.0/24";
      },
    });
    for (let i = 0; i < 3; i += 1) await waitFor(client("wrong"), "connect_error");
    expect(rejected).toEqual(["token mismatch from 203.0.113.0/24"]);
    // 가리는 함수는 원래 주소를 받는다 — 줄이 남을 때만 부른다
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/127\.0\.0\.1$/);
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
    expect(bridge.forGateway(GATEWAY).current()?.tokenId).toBe("t2");
    expect(bridge.revokeSessions("unknown")).toBe(0);

    expect(bridge.revokeSessions("t2")).toBe(1);
    await new Promise((resolve) => kept.once("disconnect", resolve));
    expect(bridge.forGateway(GATEWAY).current()).toBeUndefined();
  });

  it("hello → ready, 같은 outboundId 재전송은 한 번만 저장하고 같은 messageId 를 돌려준다", async () => {
    const socket = client(TOKEN);
    await waitFor(socket, "connect");
    const helloAck = await socket.emitWithAck("hello", hello);
    expect(helloAck).toEqual({ ok: true, data: { serverVersion: "test", protocol: 1 } });
    expect(bridge.forGateway(GATEWAY).current()?.hello?.pluginId).toBe("dodok");

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

  it("저장이 계약 오류 코드를 실어 던지면 그 코드로, 아니면 INTERNAL 로 거절하고 기록하지 않는다 — 재전송이 다시 저장을 부른다", async () => {
    await stop();
    let calls = 0;
    await start({
      onOutboundMessage: async (_session, message) => {
        calls += 1;
        if (message.outboundId === "o-archived")
          throw new AdapterError("CHANNEL_ARCHIVED", "channel is archived");
        if (message.outboundId === "o-busy")
          throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        throw new Error("disk full");
      },
    });
    const socket = await readyClient();
    const archived = await socket.emitWithAck("outbound.message", outbound("o-archived"));
    expect(archived).toEqual({
      ok: false,
      error: { code: "CHANNEL_ARCHIVED", message: "channel is archived" },
    });
    const failed = await socket.emitWithAck("outbound.message", outbound("o-broken"));
    expect(failed).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    // 계약 밖 문자열 code(SQLite·Node 시스템 오류)는 ack 에 싣지 않는다
    const busy = await socket.emitWithAck("outbound.message", outbound("o-busy"));
    expect(busy).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    await socket.emitWithAck("outbound.message", outbound("o-archived"));
    expect(calls).toBe(4);
  });

  it("deliverInbound 는 플러그인 ack 를 돌려주고, 연결이 없으면 ADAPTER_UNAVAILABLE", async () => {
    const delivery = { deliveryId: randomUUID() } as InboundDeliver;
    expect(await bridge.forGateway(GATEWAY).deliverInbound(delivery, 1_000)).toMatchObject({
      ok: false,
      error: { code: "ADAPTER_UNAVAILABLE" },
    });

    const socket = client(TOKEN);
    socket.on("inbound.deliver", (payload: InboundDeliver, ack: (res: unknown) => void) => {
      ack({ ok: true, data: { admission: "dispatch", providerRunId: payload.deliveryId } });
    });
    await waitFor(socket, "connect");
    await socket.emitWithAck("hello", hello);
    expect(await bridge.forGateway(GATEWAY).deliverInbound(delivery, 1_000)).toEqual({
      ok: true,
      data: { admission: "dispatch", providerRunId: delivery.deliveryId },
    });
  });

  it("핸드셰이크 뒤 hello 전에 그 Gateway 가 꺼지면 hello 를 UNAUTHORIZED 로 거절하고 끊는다", async () => {
    await stop();
    let accepting = true;
    await start({ acceptGateway: () => accepting });
    const socket = client(TOKEN);
    await waitFor(socket, "connect");
    accepting = false;

    expect(await socket.emitWithAck("hello", hello)).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED" },
    });
    while (socket.connected) await new Promise((resolve) => setImmediate(resolve));
    expect(bridge.forGateway(GATEWAY).current()).toBeUndefined();
  });

  /** 받기만 하고 ack 하지 않는 플러그인 — ack 함수는 받은 차례대로 모아 둔다 */
  async function silentPlugin(): Promise<Array<(res: unknown) => void>> {
    const acks: Array<(res: unknown) => void> = [];
    const socket = client(TOKEN);
    socket.on("inbound.deliver", (_payload: InboundDeliver, ack: (res: unknown) => void) => acks.push(ack));
    await waitFor(socket, "connect");
    await socket.emitWithAck("hello", hello);
    return acks;
  }

  async function settles<T>(promise: Promise<T>, withinMs: number): Promise<T | "pending"> {
    return Promise.race([
      promise,
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), withinMs)),
    ]);
  }

  it("disconnectGateway 는 ack 를 기다리던 deliverInbound 를 ack 제한시간을 기다리지 않고 ADAPTER_UNAVAILABLE 로 끝낸다", async () => {
    const acks = await silentPlugin();
    const pending = bridge
      .forGateway(GATEWAY)
      .deliverInbound({ deliveryId: randomUUID() } as InboundDeliver, 30_000);
    while (acks.length === 0) await new Promise((resolve) => setImmediate(resolve));

    bridge.disconnectGateway(GATEWAY);

    expect(await settles(pending, 1_000)).toMatchObject({
      ok: false,
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
  });

  it("abandonDelivery 는 그 전송의 ack 대기만 끝낸다 — 플러그인은 붙은 채, 다른 전송은 ack 를 받는다", async () => {
    const acks = await silentPlugin();
    const view = bridge.forGateway(GATEWAY);
    const a = { deliveryId: randomUUID() } as InboundDeliver;
    const b = { deliveryId: randomUUID() } as InboundDeliver;
    const pendingA = view.deliverInbound(a, 30_000);
    const pendingB = view.deliverInbound(b, 30_000);
    while (acks.length < 2) await new Promise((resolve) => setImmediate(resolve));

    view.abandonDelivery(a.deliveryId);

    expect(await settles(pendingA, 1_000)).toMatchObject({
      ok: false,
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
    expect(await settles(pendingB, 50)).toBe("pending");
    expect(view.current()).toBeDefined();
    acks[1]?.({ ok: true, data: { admission: "dispatch", providerRunId: "r-b" } });
    expect(await pendingB).toEqual({ ok: true, data: { admission: "dispatch", providerRunId: "r-b" } });
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

    const res = await bridge
      .forGateway(GATEWAY)
      .deliverInbound({ deliveryId: randomUUID() } as InboundDeliver, 1_000);
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

    expect(
      await bridge.forGateway(GATEWAY).deliverInbound({ deliveryId: randomUUID() } as InboundDeliver, 1_000),
    ).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "bad" },
    });
    const config = await bridge
      .forGateway(GATEWAY)
      .setConfig({ channelId: CH, config: { requireMention: true } }, 1_000);
    expect(config).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(await bridge.forGateway(GATEWAY).listAgents(1_000)).toEqual({
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
      acceptGateway: () => true,
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
      acceptGateway: () => true,
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

describe("attachBridge — 인증 실패 카운터(authGuard)", () => {
  async function guarded() {
    const own = Fastify({ logger: false });
    const ownIo = new Server(own.server, { transports: ["websocket"] });
    const state = {
      nowMs: 0,
      throws: false,
      verified: [] as unknown[],
      blocked: [] as string[],
      logged: [] as string[],
    };
    const guard = new BridgeAuthGuard();
    const ownBridge = attachBridge(ownIo, {
      verifyToken: (presented) => {
        state.verified.push(presented);
        if (state.throws) throw new Error("SqliteError: database is locked");
        return presented === TOKEN ? { tokenId: "t1", gatewayId: GATEWAY } : null;
      },
      acceptGateway: () => true,
      serverVersion: "test",
      now: () => state.nowMs,
      clientAddress: () => "203.0.113.7",
      authGuard: guard,
      onBlocked: (address) => state.blocked.push(address),
      onRejected: (reason) => state.logged.push(reason),
      onOutboundMessage: async () => ({ messageId: randomUUID() }),
    });
    await own.listen({ host: "127.0.0.1", port: 0 });
    const ownUrl = `ws://127.0.0.1:${(own.server.address() as AddressInfo).port}/bridge`;
    const open = (token: string) => {
      const socket = connect(ownUrl, { transports: ["websocket"], auth: { token }, reconnection: false });
      clients.push(socket);
      return socket;
    };
    const close = async () => {
      ownBridge.close();
      ownIo.close();
      await own.close();
    };
    return { state, guard, open, close };
  }

  it("10번 틀리면 onBlocked 한 번, 그 뒤 60초는 정상 토큰도 검사 없이 거절, 60초 뒤 저절로 통과", async () => {
    const { state, open, close } = await guarded();
    try {
      for (let i = 0; i < 10; i += 1) {
        state.nowMs = i * 1_000;
        await waitFor(open("wrong"), "connect_error");
      }
      expect(state.blocked).toEqual(["203.0.113.7"]);

      state.verified.length = 0;
      state.nowMs = 9_000 + 59_999;
      const error = (await waitFor(open(TOKEN), "connect_error")) as Error;
      expect(error.message).toBe("UNAUTHORIZED");
      expect(state.verified).toEqual([]); // 막힌 주소는 토큰을 보지 않는다
      expect(state.blocked).toHaveLength(1);

      state.nowMs = 9_000 + 60_000;
      await waitFor(open(TOKEN), "connect");
    } finally {
      await close();
    }
  });

  it("성공은 카운터를 건드리지 않는다 — 9번 틀리고 성공해도 한 번 더 틀리면 막힌다", async () => {
    const { state, guard, open, close } = await guarded();
    try {
      for (let i = 0; i < 9; i += 1) await waitFor(open("wrong"), "connect_error");
      await waitFor(open(TOKEN), "connect");
      await waitFor(open("wrong"), "connect_error");
      expect(state.blocked).toEqual(["203.0.113.7"]);
      expect(guard.isBlocked("203.0.113.7", state.nowMs)).toBe(true);
    } finally {
      await close();
    }
  });

  it("검증 함수가 던진 거절은 실패로 세지 않는다 — 저장소 오류가 정상 플러그인 주소를 막지 않게", async () => {
    const { state, guard, open, close } = await guarded();
    try {
      state.throws = true;
      for (let i = 0; i < 10; i += 1) await waitFor(open(TOKEN), "connect_error");
      expect(state.blocked).toEqual([]);
      expect(guard.isBlocked("203.0.113.7", state.nowMs)).toBe(false);
      state.throws = false;
      await waitFor(open(TOKEN), "connect");
    } finally {
      await close();
    }
  });
});

describe("attachBridge — control.call", () => {
  const RUN = "01a09fc9-d204-7551-89d6-38544d07a1ff";
  const call = (over: Record<string, unknown> = {}) => ({
    callId: randomUUID(),
    sessionKey: `agent:main:dodok:channel:${CH}`,
    runId: RUN,
    tool: "get_channel",
    args: { channelId: CH },
    ...over,
  });
  const controlHello = { ...hello, capabilities: [...hello.capabilities, "control"] };
  const emit = (socket: Socket, payload: unknown) =>
    socket.emitWithAck("control.call", payload) as Promise<ControlResult>;

  /** 이 묶음의 브리지 — onControlCall 이 받은 [세션, 호출] 을 모은다. handler 가 없으면 받은 호출을 data 로 돌려준다 */
  async function withControl(
    handler?: (call: BridgeControlCall) => Promise<ControlResult>,
  ): Promise<Array<[BridgeSessionState, BridgeControlCall]>> {
    const seen: Array<[BridgeSessionState, BridgeControlCall]> = [];
    await stop();
    await start({
      onControlCall: (session, c) => {
        seen.push([session, c]);
        return handler ? handler(c) : Promise.resolve({ ok: true, data: c });
      },
    });
    return seen;
  }

  async function ready(h = controlHello): Promise<Socket> {
    const socket = client(TOKEN);
    await waitFor(socket, "connect");
    expect(await socket.emitWithAck("hello", h)).toMatchObject({ ok: true });
    return socket;
  }

  it("control 을 알린 ready 연결의 호출은 콜백(세션의 Gateway)으로 가고 ack 가 그 결과다", async () => {
    const seen = await withControl();
    const socket = await ready();
    const payload = call();
    expect(await emit(socket, payload)).toEqual({ ok: true, data: payload });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0].gatewayId).toBe(GATEWAY);
    expect(seen[0]?.[1]).toEqual(payload);
  });

  it("control 을 알리지 않은 플러그인은 hello 는 그대로 받고, 호출은 콜백 없이 FORBIDDEN", async () => {
    const seen = await withControl();
    const socket = await ready(hello);
    expect(bridge.forGateway(GATEWAY).current()?.phase).toBe("ready");
    expect(await emit(socket, call())).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(seen).toEqual([]);
  });

  it("hello 전이면 PROTOCOL_MISMATCH, 모양이 틀리면(runId 없음) VALIDATION — 콜백을 부르지 않는다", async () => {
    const seen = await withControl();
    const early = client(TOKEN);
    await waitFor(early, "connect");
    expect(await emit(early, call())).toMatchObject({ ok: false, error: { code: "PROTOCOL_MISMATCH" } });
    const socket = await ready();
    const { runId: _runId, ...noRun } = call();
    expect(await emit(socket, noRun)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(seen).toEqual([]);
  });

  it("콜백이 늦게 끝나면(확인 카드 대기) ack 도 그때까지 미룬다", async () => {
    let finish!: (result: ControlResult) => void;
    const seen = await withControl(
      () =>
        new Promise<ControlResult>((resolve) => {
          finish = resolve;
        }),
    );
    const socket = await ready();
    let acked: ControlResult | undefined;
    const pending = emit(socket, call({ tool: "update_channel" })).then((result) => {
      acked = result;
      return result;
    });
    while (seen.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(acked).toBeUndefined();
    finish({ ok: true, data: { changed: true } });
    expect(await pending).toEqual({ ok: true, data: { changed: true } });
  });

  it("콜백이 계약 코드를 실어 던지면 그 코드로, 아니면 INTERNAL", async () => {
    let error: unknown;
    await withControl(async () => {
      throw error;
    });
    const socket = await ready();
    error = new AdapterError("ADAPTER_UNAVAILABLE", "gateway connection is gone");
    expect(await emit(socket, call())).toMatchObject({ ok: false, error: { code: "ADAPTER_UNAVAILABLE" } });
    error = new Error("db is locked");
    expect(await emit(socket, call())).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });

  it("onControlCall 이 없으면 ADAPTER_UNAVAILABLE", async () => {
    const socket = await ready();
    expect(await emit(socket, call())).toMatchObject({ ok: false, error: { code: "ADAPTER_UNAVAILABLE" } });
  });
});
