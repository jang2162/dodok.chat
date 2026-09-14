import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { InboundDeliver, OutboundMessage } from "@dodok/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachBridge, type BridgeHandle } from "../src/bridge/server";

const TOKEN = "bridge-test-token";
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
const clients: Socket[] = [];

function client(token: string): Socket {
  const socket = connect(url, { transports: ["websocket"], auth: { token }, reconnection: false });
  clients.push(socket);
  return socket;
}

function waitFor(socket: Socket, event: "connect" | "connect_error"): Promise<unknown> {
  return new Promise((resolve) => socket.once(event, resolve));
}

beforeEach(async () => {
  received = [];
  app = Fastify({ logger: false });
  ioServer = new Server(app.server, { transports: ["websocket"] });
  bridge = attachBridge(ioServer, {
    token: TOKEN,
    serverVersion: "test",
    onOutboundMessage: async (_session, message) => {
      received.push(message);
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
      ack({ ok: true, data: { providerRunId: payload.deliveryId } });
    });
    await waitFor(socket, "connect");
    await socket.emitWithAck("hello", hello);
    expect(await bridge.deliverInbound(delivery, 1_000)).toEqual({
      ok: true,
      data: { providerRunId: delivery.deliveryId },
    });
  });
});
