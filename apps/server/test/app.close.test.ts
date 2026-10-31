import { ATTACHMENT_LIMITS, type Attachment } from "@dodok/shared";
import { Agent, request as httpRequest } from "node:http";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { markBound } from "../src/modules/attachments/service";
import { createUserMessage } from "../src/modules/messages/service";
import { issueBridgeToken } from "../src/modules/setup/tokens";
import { bootTestApp, login } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { channelConversation } from "./helpers/seed";

let app: App | undefined;
const agents: Agent[] = [];
afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const agent of agents.splice(0)) agent.destroy();
});

/**
 * close 의 상한 — 고치기 전에는 쉬는 keep-alive 연결이 close 를 이 상한(운영 10초)까지 붙잡아 「app close timed out」 이 남았다.
 * 판정은 걸린 시간이 아니라 상한에 걸렸는가다(부하에서는 20 MiB 를 받는 데만 2초 넘게 걸린다)
 */
const CLOSE_TIMEOUT_MS = 10_000;

describe("app.close() 와 keep-alive", () => {
  it("close 가 시작될 때 아직 보내던 응답이 그 뒤 끝나 쉬는 keep-alive 연결로 남아도 close 는 상한에 걸리지 않고 끝난다", async () => {
    const lines: Array<{ msg?: string }> = [];
    const logger = pino({ level: "warn" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    app = await bootTestApp({}, { closeTimeoutMs: CLOSE_TIMEOUT_MS, logger });
    const a = app;
    const bridgeToken = issueBridgeToken(a.db, a.workspaceId, FAKE_GATEWAY_ID, "gw").token;
    const { headers } = await login(a);
    const created = await a.fastify.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers,
      payload: { name: "close" },
    });
    const channelId = created.json().channel.id as string;
    const conversationId = channelConversation(a.db, channelId);
    // 소켓 버퍼(루프백 자동 조정 포함 수 MB)보다 훨씬 큰 본문 — 받는 쪽이 멈추면 서버의 응답은 끝나지 못한 채 남는다
    const bytes = Buffer.alloc(ATTACHMENT_LIMITS.agentFileMaxBytes, 7);
    const up = await a.fastify.inject({
      method: "POST",
      url: "/bridge/attachments",
      headers: {
        authorization: `Bearer ${bridgeToken}`,
        "x-dodok-conversation-id": conversationId,
        "content-type": "application/octet-stream",
      },
      payload: bytes,
    });
    expect(up.statusCode).toBe(200);
    const attachment = up.json() as Attachment;
    const message = createUserMessage(a.db, a.bus, {
      conversationId,
      authorId: a.ownerUserId,
      bodyMd: "첨부",
      clientMsgId: "close-keepalive",
    });
    markBound(a.db, [attachment.id], message.id);

    await a.fastify.listen({ host: "127.0.0.1", port: 0 });
    const { port } = a.fastify.server.address() as { port: number };
    const agent = new Agent({ keepAlive: true });
    agents.push(agent);

    // ① 첫 조각을 받고 멈춘다 — 서버의 응답은 아직 끝나지 않았다
    let res: import("node:http").IncomingMessage | undefined;
    let received = 0;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: `/bridge/attachments/${attachment.id}`,
          headers: { authorization: `Bearer ${bridgeToken}` },
          agent,
        },
        (r) => {
          res = r;
          r.once("data", (chunk: Buffer) => {
            received += chunk.length;
            r.pause();
            resolve();
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res?.headers.connection).toBe("keep-alive");

    // ② 응답이 도는 중에 close 를 시작하고, ③ 나머지를 다 받는다 — 연결은 쉬는 keep-alive 로 돌아간다
    const closing = a.close();
    await new Promise<void>((resolve, reject) => {
      res?.on("data", (chunk: Buffer) => (received += chunk.length));
      res?.on("end", resolve);
      res?.on("error", reject);
      res?.resume();
    });
    await closing;
    app = undefined;
    // 도는 중이던 내려받기는 끊지 않는다
    expect(received).toBe(bytes.length);
    // 쉬는 연결이 상한까지 붙잡지 않았다
    expect(lines.filter((l) => l.msg === "app close timed out")).toEqual([]);
  }, 30_000);
});
