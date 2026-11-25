import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import { createChannel } from "../src/modules/channels/service";
import { createUserMessage } from "../src/modules/messages/service";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { channelConversation, createDmChannelForTest, seedConversation } from "./helpers/seed";

describe("GET /api/v1/messages/:id — 메시지 링크", () => {
  let app: App;
  let headers: { authorization: string };

  beforeAll(async () => {
    app = await bootTestApp({}, { adapters: [new FakeAdapter()] });
    ({ headers } = await login(app));
  });
  afterAll(async () => {
    await app.close();
  });

  let n = 0;
  const post = (conversationId: string, bodyMd: string, authorId = app.ownerUserId, threadRootId?: string) =>
    createUserMessage(app.db, app.bus, {
      conversationId,
      authorId,
      bodyMd,
      clientMsgId: `link-${++n}`,
      ...(threadRootId ? { threadRootId } : {}),
    });
  const get = (id: string, auth = headers) =>
    app.fastify.inject({ method: "GET", url: `/api/v1/messages/${id}`, headers: auth });

  it("읽을 수 있는 메시지면 200 과 메시지·채널 이름·세션 제목", async () => {
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "dodok-dev",
    });
    const conversationId = channelConversation(app.db, channel.id);
    const root = post(conversationId, "루트");
    const reply = post(conversationId, "답글", app.ownerUserId, root.id);
    const res = await get(reply.id);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      channelKind: "channel",
      channelName: "dodok-dev",
      conversationTitle: expect.any(String),
      message: { id: reply.id, seq: reply.seq, threadRootId: root.id, conversationId, bodyMd: "답글" },
    });
  });

  it("남의 DM 메시지·없는 id·꼴이 틀린 id 는 404", async () => {
    const agent = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: "link-dm",
      handle: "linkdm",
      name: "linkdm",
    });
    const mia = await userWithRole(app, "mia-link", "member");
    const dm = createDmChannelForTest(app.db, {
      workspaceId: app.workspaceId,
      ownerId: mia.id,
      agentId: agent.id,
    });
    const conversationId = seedConversation(app.db, dm.id, { createdBy: mia.id });
    const secret = post(conversationId, "비밀", mia.id);

    const miaHeaders = { authorization: `Bearer ${mia.token}` };
    expect((await get(secret.id, miaHeaders)).statusCode).toBe(200);
    expect((await get(secret.id, miaHeaders)).json()).toMatchObject({ channelKind: "dm", channelName: "DM" });
    expect((await get(secret.id)).statusCode).toBe(404);
    expect((await get(uuid())).statusCode).toBe(404);
    expect((await get("nope")).statusCode).not.toBe(200);
  });
});
