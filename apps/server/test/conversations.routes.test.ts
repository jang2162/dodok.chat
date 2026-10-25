import type { ChannelMember, Conversation, ConversationList, Message } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { createChannel } from "../src/modules/channels/service";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { seedConversation, seedWorkspace } from "./helpers/seed";
import { connectWire, waitFor, type WireClient } from "./helpers/wire";

// 세션 REST(채널 세션 스펙 「wire·REST」 장)와 wire message.send 의 세션 고르기. 역할별 허용·거부의 전수는 roles.matrix.test.ts

describe("세션 REST·wire", () => {
  let app: App;
  let owner: string;
  const member = { id: "", token: "" };
  const other = { id: "", token: "" };
  const sockets: WireClient[] = [];
  let n = 0;

  beforeAll(async () => {
    app = await bootTestApp();
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    owner = (await login(app)).token;
    Object.assign(member, await userWithRole(app, "mia", "member"));
    Object.assign(other, await userWithRole(app, "noah", "member"));
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (token: string, method: "GET" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.fastify.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
  const newChannel = () =>
    createChannel(app.db, { workspaceId: app.workspaceId, createdBy: app.ownerUserId, name: `s${++n}` });
  const wire = async (token: string, channelId: string) => {
    const socket = await connectWire(app, token);
    sockets.push(socket);
    const res = await socket.emitWithAck("channel.subscribe", { channelId });
    expect(res.ok).toBe(true);
    return socket;
  };
  const send = async (
    socket: WireClient,
    channelId: string,
    extra: {
      conversationId?: string;
      newConversation?: { title?: string };
      threadRootId?: string;
      clientMsgId?: string;
    } = {},
  ) =>
    socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: extra.clientMsgId ?? `m${++n}`,
      bodyMd: `글 ${n}`,
      ...extra,
    });
  const ok = <T>(res: { ok: true; data: T } | { ok: false; error: { code: string } }): T => {
    if (!res.ok) throw new Error(`ack 실패: ${res.error.code}`);
    return res.data;
  };
  /** member 가 새 세션을 연다 — 그 세션과 첫 메시지 */
  const open = async (channelId: string, token = member.token, title?: string) => {
    const socket = await wire(token, channelId);
    const data = ok(await send(socket, channelId, { newConversation: title === undefined ? {} : { title } }));
    return { socket, conversation: data.conversation as Conversation, message: data.message };
  };

  it("[Review Focus 1] wire newConversation — ack 에 세션, 채널 룸에 conversation.created. 같은 clientMsgId 재전송은 같은 메시지·같은 세션", async () => {
    const channel = newChannel();
    const watcher = await wire(owner, channel.id);
    const created = waitFor(watcher, "conversation.created");
    const socket = await wire(member.token, channel.id);
    const first = ok(
      await send(socket, channel.id, { newConversation: { title: "배포" }, clientMsgId: "dup" }),
    );
    expect(first.conversation).toMatchObject({ channelId: channel.id, title: "배포", titleSource: "user" });
    expect(first.message.conversationId).toBe(first.conversation?.id);
    expect((await created).conversation.id).toBe(first.conversation?.id);
    const retry = ok(
      await send(socket, channel.id, { newConversation: { title: "배포" }, clientMsgId: "dup" }),
    );
    expect(retry.message.id).toBe(first.message.id);
    expect(retry.conversation?.id).toBe(first.conversation?.id);
    const list = (
      await call(owner, "GET", `/api/v1/channels/${channel.id}/conversations?status=all`)
    ).json() as ConversationList;
    expect(list.conversations.map((c) => c.id)).toEqual([first.conversation?.id]);
    // conversationId 를 준 보내기의 ack 에는 세션이 없다
    const plain = ok(await send(socket, channel.id, { conversationId: first.message.conversationId }));
    expect(plain.conversation).toBeUndefined();
  });

  it("wire message.send — 세션을 안 주거나 둘 다 주면 VALIDATION(서버가 고르던 다리는 걷었다, 판정 PS4) — 세션도 메시지도 생기지 않는다", async () => {
    const channel = newChannel();
    const socket = await wire(member.token, channel.id);
    const existing = await open(channel.id);
    expect(await send(socket, channel.id)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(
      await send(socket, channel.id, { conversationId: existing.conversation.id, newConversation: {} }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    const list = (
      await call(owner, "GET", `/api/v1/channels/${channel.id}/conversations?status=all`)
    ).json() as ConversationList;
    expect(list.conversations.map((c) => c.id)).toEqual([existing.conversation.id]);
    const page = (
      await call(owner, "GET", `/api/v1/conversations/${existing.conversation.id}/messages`)
    ).json() as { messages: Message[] };
    expect(page.messages.map((m) => m.id)).toEqual([existing.message.id]);
  });

  it("[Review Focus 2] 한 탭이 닫는 사이 다른 탭이 보내면 CONVERSATION_CLOSED, 다른 탭은 conversation.updated 로 닫힘을 안다", async () => {
    const channel = newChannel();
    const { socket, conversation } = await open(channel.id);
    const otherTab = await wire(member.token, channel.id);
    const updated = waitFor(otherTab, "conversation.updated");
    const closed = await call(member.token, "PATCH", `/api/v1/conversations/${conversation.id}`, {
      closed: true,
    });
    expect(closed.statusCode).toBe(200);
    expect((await updated).conversation).toMatchObject({ id: conversation.id, closedBy: member.id });
    const refused = await send(socket, channel.id, { conversationId: conversation.id });
    expect(refused).toEqual({
      ok: false,
      error: { code: "CONVERSATION_CLOSED", message: "닫힌 세션입니다" },
    });
    // 다시 열면 보낸다
    expect(
      (await call(member.token, "PATCH", `/api/v1/conversations/${conversation.id}`, { closed: false }))
        .statusCode,
    ).toBe(200);
    expect((await send(socket, channel.id, { conversationId: conversation.id })).ok).toBe(true);
  });

  it("PATCH — 만든 member 는 제목·닫기, 남의 member 는 403, 세션 관리자·admin 은 남의 것도. 빈 본문 400, 남의 워크스페이스 404", async () => {
    const channel = newChannel();
    const { conversation } = await open(channel.id);
    const url = `/api/v1/conversations/${conversation.id}`;
    const renamed = await call(member.token, "PATCH", url, { title: "배포 회고", closed: true });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { conversation: Conversation }).conversation).toMatchObject({
      title: "배포 회고",
      titleSource: "user",
      closedBy: member.id,
    });
    const denied = await call(other.token, "PATCH", url, { closed: false });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(
      (await call(owner, "PUT", `/api/v1/channels/${channel.id}/session-managers/${other.id}`)).statusCode,
    ).toBe(200);
    expect((await call(other.token, "PATCH", url, { closed: false })).statusCode).toBe(200);
    expect((await call(owner, "PATCH", url, { title: "owner 가 바꿈" })).statusCode).toBe(200);
    expect((await call(member.token, "PATCH", url, {})).statusCode).toBe(400);
    expect(
      (await call(member.token, "PATCH", `/api/v1/conversations/${uuid()}`, { closed: true })).statusCode,
    ).toBe(404);
    const stranger = seedWorkspace(app.db, { userHandle: `stranger${++n}` });
    const foreign = createChannel(app.db, {
      workspaceId: stranger.workspaceId,
      createdBy: stranger.userId,
      name: "f",
    });
    const foreignConversation = seedConversation(app.db, foreign.id);
    expect(
      (await call(owner, "PATCH", `/api/v1/conversations/${foreignConversation}`, { closed: true }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(owner, "GET", `/api/v1/conversations/${foreignConversation}/messages`)).statusCode,
    ).toBe(404);
    expect((await call(owner, "GET", `/api/v1/channels/${foreign.id}/conversations`)).statusCode).toBe(404);
  });

  it("목록 — 기본은 열린 세션, status·q 를 받는다. 틀린 cursor 는 400", async () => {
    const channel = newChannel();
    const a = await open(channel.id, member.token, "Alpha 회의");
    const b = await open(channel.id, member.token, "베타");
    await call(member.token, "PATCH", `/api/v1/conversations/${a.conversation.id}`, { closed: true });
    const ids = async (query: string) =>
      (
        (
          await call(member.token, "GET", `/api/v1/channels/${channel.id}/conversations${query}`)
        ).json() as ConversationList
      ).conversations.map((c) => c.id);
    expect(await ids("")).toEqual([b.conversation.id]);
    expect(await ids("?status=closed")).toEqual([a.conversation.id]);
    expect(await ids("?status=all&q=alpha")).toEqual([a.conversation.id]);
    expect(
      (await call(member.token, "GET", `/api/v1/channels/${channel.id}/conversations?cursor=x`)).statusCode,
    ).toBe(400);
    expect(
      (await call(member.token, "GET", `/api/v1/channels/${channel.id}/conversations?status=x`)).statusCode,
    ).toBe(400);
  });

  it("세션 메시지 REST — 그 세션의 루트만, 스레드는 그 세션의 루트여야 한다(아니면 404). 닫힌 세션도 읽는다", async () => {
    const channel = newChannel();
    const a = await open(channel.id, member.token, "A");
    const b = await open(channel.id, member.token, "B");
    const reply = ok(
      await send(a.socket, channel.id, { conversationId: a.conversation.id, threadRootId: a.message.id }),
    );
    const page = (
      await call(member.token, "GET", `/api/v1/conversations/${a.conversation.id}/messages`)
    ).json() as {
      messages: Message[];
    };
    expect(page.messages.map((m) => m.id)).toEqual([a.message.id]);
    expect(page.messages[0]?.threadSummary?.count).toBe(1);
    const thread = await call(
      member.token,
      "GET",
      `/api/v1/conversations/${a.conversation.id}/threads/${a.message.id}/messages`,
    );
    expect(thread.statusCode).toBe(200);
    expect((thread.json() as { root: Message; messages: Message[] }).messages.map((m) => m.id)).toEqual([
      a.message.id,
      reply.message.id,
    ]);
    expect(
      (
        await call(
          member.token,
          "GET",
          `/api/v1/conversations/${b.conversation.id}/threads/${a.message.id}/messages`,
        )
      ).statusCode,
    ).toBe(404);
    await call(member.token, "PATCH", `/api/v1/conversations/${a.conversation.id}`, { closed: true });
    const closedPage = (
      await call(other.token, "GET", `/api/v1/conversations/${a.conversation.id}/messages`)
    ).json() as {
      messages: Message[];
    };
    expect(closedPage.messages.at(-1)?.kind).toBe("system");
    // 채널 경로 목록은 걷었다(계획 판정 PS5) — 타임라인은 세션마다다
    expect((await call(member.token, "GET", `/api/v1/channels/${channel.id}/messages`)).statusCode).toBe(404);
  });

  it("세션 관리자 PUT 은 채널에 없는 사람을 참여시키고 channel.member.changed, DELETE 는 역할만 member 로. member 는 403", async () => {
    const channel = newChannel();
    const watcher = await wire(owner, channel.id);
    const changed = waitFor(watcher, "channel.member.changed");
    const put = await call(owner, "PUT", `/api/v1/channels/${channel.id}/session-managers/${member.id}`);
    expect(put.statusCode).toBe(200);
    expect((put.json() as { member: ChannelMember }).member).toMatchObject({
      memberId: member.id,
      role: "manager",
    });
    expect((await changed).members.find((m) => m.memberId === member.id)?.role).toBe("manager");
    expect(
      (await call(member.token, "PUT", `/api/v1/channels/${channel.id}/session-managers/${other.id}`))
        .statusCode,
    ).toBe(403);
    const del = await call(owner, "DELETE", `/api/v1/channels/${channel.id}/session-managers/${member.id}`);
    expect((del.json() as { member: ChannelMember }).member.role).toBe("member");
    expect(
      (await call(owner, "DELETE", `/api/v1/channels/${channel.id}/session-managers/${other.id}`)).statusCode,
    ).toBe(404);
    expect(
      (await call(owner, "PUT", `/api/v1/channels/${channel.id}/session-managers/${uuid()}`)).statusCode,
    ).toBe(404);
  });

  it("세션 정책 — PATCH /channels/:id { sessionPolicy } 는 admin 이상, managers 면 member 의 newConversation 이 FORBIDDEN", async () => {
    const channel = newChannel();
    const url = `/api/v1/channels/${channel.id}`;
    expect(
      (await call(member.token, "PATCH", url, { sessionPolicy: { create: "managers" } })).statusCode,
    ).toBe(403);
    const patched = await call(owner, "PATCH", url, { sessionPolicy: { create: "managers" } });
    expect(patched.json()).toMatchObject({ channel: { sessionPolicy: { create: "managers" } } });
    const socket = await wire(member.token, channel.id);
    expect(await send(socket, channel.id, { newConversation: {} })).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });
});
