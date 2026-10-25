/**
 * GET /api/v1/me/unread(읽지 않음 스펙 「계약」 장) — 세션이 있어야 하고, 사용자 id 는 세션에서만 와서 자기 현황만 받는다.
 */
import { UnreadSnapshot } from "@dodok/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { createChannel } from "../src/modules/channels/service";
import { createUserMessage } from "../src/modules/messages/service";
import { markRead } from "../src/modules/reads/store";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { channelConversation } from "./helpers/seed";

describe("GET /api/v1/me/unread", () => {
  let app: App;
  let owner: string;
  let admin: { id: string; token: string };
  let member: { id: string; token: string };
  let channelId: string;
  let conversationId: string;

  beforeAll(async () => {
    app = await bootTestApp();
    owner = (await login(app)).token;
    admin = await userWithRole(app, "reads-admin", "admin");
    member = await userWithRole(app, "reads-member", "member");
    channelId = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "reads-routes",
    }).id;
    conversationId = channelConversation(app.db, channelId);
    for (const n of [1, 2]) {
      createUserMessage(app.db, app.bus, {
        conversationId,
        authorId: app.ownerUserId,
        bodyMd: `m${n}`,
        clientMsgId: `r-${n}`,
      });
    }
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (token?: string) =>
    app.fastify.inject({
      method: "GET",
      url: "/api/v1/me/unread",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  const mine = (body: unknown) =>
    UnreadSnapshot.parse(body).conversations.find((c) => c.conversationId === conversationId);

  it("로그인이 없으면 401", async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it("owner·admin·member 모두 자기 현황을 받고 UnreadSnapshot 으로 파싱된다", async () => {
    for (const token of [admin.token, member.token]) {
      const res = await get(token);
      expect(res.statusCode).toBe(200);
      expect(mine(res.json())).toEqual({
        conversationId,
        channelId,
        lastReadSeq: 0,
        latestSeq: 2,
        unread: true,
        mentions: 0,
      });
    }
    // 글쓴이(owner)는 자기 글이라 안 읽은 것이 없다
    const res = await get(owner);
    expect(res.statusCode).toBe(200);
    expect(mine(res.json())).toMatchObject({ unread: false });
  });

  it("다른 사용자의 읽음 위치가 섞이지 않는다 — admin 이 읽어도 member 의 응답은 그대로", async () => {
    markRead(app.db, app.workspaceId, admin.id, conversationId, 2, new Date());
    expect(mine((await get(admin.token)).json())).toMatchObject({ lastReadSeq: 2, unread: false });
    expect(mine((await get(member.token)).json())).toMatchObject({ lastReadSeq: 0, unread: true });
  });

  it("스냅숏의 channels 는 보관하지 않은 채널 — 대화가 없는 채널도 든다", async () => {
    const empty = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "reads-routes-empty",
    }).id;
    const snap = UnreadSnapshot.parse((await get(member.token)).json());
    expect(snap.channels).toEqual(expect.arrayContaining([channelId, empty]));
    expect(snap.conversations.some((c) => c.channelId === empty)).toBe(false);
  });
});
