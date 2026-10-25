import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import type { Person, Run } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import type { DbOrTx } from "../src/db/client";
import { channelMembers, memberships, users, workspaces } from "../src/db/schema.sqlite";
import { joinChannelIfAbsent } from "../src/modules/channels/service";
import { broadcastPeople, listPeople } from "../src/modules/members/people";
import { createAgentMessage, createUserMessage } from "../src/modules/messages/service";
import { buildInboundDeliver } from "../src/modules/runs/context";
import { ensureSession } from "../src/modules/sessions/service";
import { type BusEvents, ServerBus } from "../src/realtime/bus";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { newTestDb } from "./helpers/db";
import { channelConversation, seedChannelWithAgent } from "./helpers/seed";

// 사람 목록(GET /people·people.changed)과 채널 자동 참여(팀 스펙 「채널 참여·멘션·알림」 절)

describe("GET /people", () => {
  let app: App;
  let ownerToken: string;

  beforeAll(async () => {
    app = await bootTestApp();
    ownerToken = (await login(app)).token;
  });
  afterAll(async () => {
    await app.close();
  });

  it("member 도 받는다 — 비활성 멤버도 role 과 deactivatedAt 을 싣는다", async () => {
    const member = await userWithRole(app, "reader", "member");
    const gone = await userWithRole(app, "gone", "member");
    const deactivated = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/members/${gone.id}/deactivate`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(deactivated.statusCode).toBe(200);

    const res = await app.fastify.inject({
      method: "GET",
      url: "/api/v1/people",
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(res.statusCode).toBe(200);
    const people = (res.json() as { people: Person[] }).people;
    expect(people.find((p) => p.id === member.id)).toMatchObject({
      handle: "reader",
      role: "member",
      deactivatedAt: null,
    });
    expect(people.find((p) => p.id === app.ownerUserId)?.role).toBe("owner");
    const inactive = people.find((p) => p.id === gone.id);
    expect(inactive).toMatchObject({ handle: "gone", role: "member", deactivatedAt: expect.any(String) });
    // 이메일은 싣지 않는다 — 누구나 읽는 목록이다
    expect(JSON.stringify(people)).not.toContain("@dodok.local");
  });

  it("세션이 없으면 401", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/api/v1/people" });
    expect(res.statusCode).toBe(401);
  });

  it("채널에 사람 넣기·빼기는 누구나 — 비활성 멤버는 넣지 못한다(404)", async () => {
    const member = await userWithRole(app, "adder", "member");
    const friend = await userWithRole(app, "friend", "member");
    const gone = await userWithRole(app, "leaver", "member");
    const as = (token: string, method: "POST" | "DELETE", url: string, payload?: object) =>
      app.fastify.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload }),
      });
    const created = await as(member.token, "POST", "/api/v1/channels", { name: `people-${uuid()}` });
    expect(created.statusCode).toBe(201);
    const channelId = (created.json() as { channel: { id: string } }).channel.id;
    expect((await as(ownerToken, "POST", `/api/v1/members/${gone.id}/deactivate`)).statusCode).toBe(200);

    const left = await as(member.token, "POST", `/api/v1/channels/${channelId}/members`, {
      memberType: "user",
      memberId: gone.id,
    });
    expect(left.statusCode).toBe(404);
    expect(isChannelMember(app.db, channelId, gone.id)).toBe(false);

    const added = await as(member.token, "POST", `/api/v1/channels/${channelId}/members`, {
      memberType: "user",
      memberId: friend.id,
    });
    expect(added.statusCode).toBe(201);
    expect(
      (await as(member.token, "DELETE", `/api/v1/channels/${channelId}/members/${friend.id}`)).statusCode,
    ).toBe(200);
    expect(isChannelMember(app.db, channelId, friend.id)).toBe(false);
  });
});

/** seed 에는 memberships 가 없다 — 사람을 워크스페이스 멤버로 넣는다 */
function addPerson(db: DbOrTx, workspaceId: string, handle: string, role = "member"): string {
  const id = uuid();
  db.insert(users)
    .values({ id, workspaceId, handle, displayName: handle, authProvider: "local", createdAt: new Date() })
    .run();
  db.insert(memberships).values({ id: uuid(), workspaceId, userId: id, role }).run();
  return id;
}

function isChannelMember(db: DbOrTx, channelId: string, userId: string): boolean {
  return (
    db
      .select()
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.memberType, "user"),
          eq(channelMembers.memberId, userId),
        ),
      )
      .get() !== undefined
  );
}

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const seed = seedChannelWithAgent(db);
  const alice = addPerson(db, seed.workspaceId, "alice");
  const bob = addPerson(db, seed.workspaceId, "bob");
  const changes: BusEvents["channel.member.changed"][] = [];
  bus.on("channel.member.changed", (p) => changes.push(p));
  let n = 0;
  const say = (authorId: string, bodyMd: string, threadRootId?: string) =>
    createUserMessage(db, bus, {
      conversationId: seed.conversationId,
      authorId,
      bodyMd,
      clientMsgId: `c${++n}`,
      threadRootId,
    });
  return { db, bus, ...seed, alice, bob, changes, say };
}

describe("listPeople·broadcastPeople", () => {
  it("broadcastPeople 은 people.changed 를 한 번, 지금 목록으로", () => {
    const { db, bus, workspaceId, alice } = setup();
    const seen: BusEvents["people.changed"][] = [];
    bus.on("people.changed", (p) => seen.push(p));
    broadcastPeople(bus, db, workspaceId);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.people).toEqual(listPeople(db, workspaceId));
    expect(seen[0]?.people.find((p) => p.id === alice)).toMatchObject({ handle: "alice", role: "member" });
  });

  it("avatarUrl 은 저장값 그대로, 모르는 역할은 싣지 않는다", () => {
    const { db, workspaceId, alice, bob } = setup();
    db.update(users).set({ avatarUrl: "https://example.com/a.png" }).where(eq(users.id, alice)).run();
    db.update(memberships).set({ role: "guest" }).where(eq(memberships.userId, bob)).run();
    const people = listPeople(db, workspaceId);
    expect(people.find((p) => p.id === alice)?.avatarUrl).toBe("https://example.com/a.png");
    expect(people.find((p) => p.id === bob)?.role).toBeUndefined();
  });
});

describe("채널 자동 참여", () => {
  it("joinChannelIfAbsent — 없으면 넣고 true, 있으면 false", () => {
    const { db, channelId, alice } = setup();
    expect(joinChannelIfAbsent(db, channelId, alice, new Date())).toBe(true);
    expect(joinChannelIfAbsent(db, channelId, alice, new Date())).toBe(false);
    expect(isChannelMember(db, channelId, alice)).toBe(true);
  });

  it("첫 메시지면 참여하고 channel.member.changed 한 번, 두 번째는 변화 없음", () => {
    const { db, channelId, alice, changes, say } = setup();
    expect(isChannelMember(db, channelId, alice)).toBe(false);
    say(alice, "안녕");
    expect(isChannelMember(db, channelId, alice)).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.channelId).toBe(channelId);
    expect(changes[0]?.members.some((m) => m.memberType === "user" && m.memberId === alice)).toBe(true);
    say(alice, "또 안녕");
    expect(changes).toHaveLength(1);
  });

  it("이미 멤버인 사람(채널을 만든 사람)의 메시지는 아무것도 바꾸지 않는다", () => {
    const { userId, changes, say } = setup();
    say(userId, "나는 이미 있다");
    expect(changes).toHaveLength(0);
  });

  it("스레드 답글도 참여다", () => {
    const { db, channelId, userId, alice, changes, say } = setup();
    const root = say(userId, "루트");
    say(alice, "답글", root.id);
    expect(isChannelMember(db, channelId, alice)).toBe(true);
    expect(changes).toHaveLength(1);
  });

  it("멘션된 사람도 참여한다 — 채널에 없던 사람도 멘션으로 풀린다", () => {
    const { db, channelId, userId, bob, changes, say } = setup();
    const message = say(userId, "@bob 이것 좀 봐");
    expect(message.mentions.users).toEqual([bob]);
    expect(isChannelMember(db, channelId, bob)).toBe(true);
    expect(changes).toHaveLength(1);
  });

  it("쓴 사람과 멘션된 사람이 함께 들어오면 channel.member.changed 는 한 번", () => {
    const { db, channelId, alice, bob, changes, say } = setup();
    say(alice, "@bob 같이 하자");
    expect(isChannelMember(db, channelId, alice)).toBe(true);
    expect(isChannelMember(db, channelId, bob)).toBe(true);
    expect(changes).toHaveLength(1);
  });

  it("membership 이 없는 사람은 멘션으로 풀리지도 참여하지도 않는다", () => {
    const { db, channelId, userId, workspaceId, changes, say } = setup();
    const gone = addPerson(db, workspaceId, "gone");
    db.delete(memberships).where(eq(memberships.userId, gone)).run();
    const message = say(userId, "@gone 어디 갔어");
    expect(message.mentions.users).toEqual([]);
    expect(isChannelMember(db, channelId, gone)).toBe(false);
    expect(changes).toHaveLength(0);
  });

  it("비활성 멤버는 멘션으로 풀리지도 참여하지도 않는다", () => {
    const { db, channelId, userId, workspaceId, changes, say } = setup();
    const resting = addPerson(db, workspaceId, "resting");
    db.update(memberships).set({ deactivatedAt: new Date() }).where(eq(memberships.userId, resting)).run();
    const message = say(userId, "@resting 쉬는 중?");
    expect(message.mentions.users).toEqual([]);
    expect(isChannelMember(db, channelId, resting)).toBe(false);
    expect(changes).toHaveLength(0);
  });

  it("다른 워크스페이스의 사람·membership 은 멘션으로 풀리지도 참여하지도 않는다", () => {
    const { db, channelId, userId, workspaceId, changes, say } = setup();
    const other = uuid();
    db.insert(workspaces).values({ id: other, name: "other", createdAt: new Date() }).run();
    // 사람도 membership 도 다른 워크스페이스
    const stranger = addPerson(db, other, "stranger");
    // 사람은 이 워크스페이스인데 membership 은 다른 워크스페이스
    const drifter = uuid();
    db.insert(users)
      .values({
        id: drifter,
        workspaceId,
        handle: "drifter",
        displayName: "drifter",
        authProvider: "local",
        createdAt: new Date(),
      })
      .run();
    db.insert(memberships).values({ id: uuid(), workspaceId: other, userId: drifter, role: "member" }).run();
    // 사람은 다른 워크스페이스인데 membership 은 이 워크스페이스
    const visitor = addPerson(db, other, "visitor");
    db.insert(memberships).values({ id: uuid(), workspaceId, userId: visitor, role: "member" }).run();

    const message = say(userId, "@stranger @drifter @visitor 안녕");
    expect(message.mentions.users).toEqual([]);
    for (const id of [stranger, drifter, visitor]) expect(isChannelMember(db, channelId, id)).toBe(false);
    expect(changes).toHaveLength(0);
  });

  it("모르는 역할(guest 등)의 membership 은 멤버로 치지 않는다 — 멘션으로 풀리지 않는다", () => {
    const { db, channelId, userId, workspaceId, changes, say } = setup();
    const guest = addPerson(db, workspaceId, "guesty", "guest");
    const message = say(userId, "@guesty 들려?");
    expect(message.mentions.users).toEqual([]);
    expect(isChannelMember(db, channelId, guest)).toBe(false);
    expect(changes).toHaveLength(0);
  });

  it("사람과 에이전트 핸들이 겹친 옛 데이터면 에이전트로 풀린다", () => {
    const { db, workspaceId, agentId, userId, say } = setup();
    addPerson(db, workspaceId, "dev");
    const message = say(userId, "@dev 해 줘");
    expect(message.mentions).toEqual({ agents: [agentId], users: [] });
  });

  it("에이전트의 사람 멘션은 채널 참여자로만 풀고 참여시키지 않는다", () => {
    const { db, bus, channelId, agentId, bob, changes } = setup();
    const message = createAgentMessage(db, bus, {
      conversationId: channelConversation(db, channelId),
      agentId,
      externalId: "o1",
      bodyMd: "@bob 확인해 주세요",
    });
    expect(message.mentions.users).toEqual([]);
    expect(isChannelMember(db, channelId, bob)).toBe(false);
    expect(changes).toHaveLength(0);
  });

  it("에이전트 헤더 「참여자:」에는 실제로 온 사람만", () => {
    const { db, channelId, agentId, alice, say } = setup();
    const trigger = say(alice, "@dev 안녕");
    const { session } = ensureSession(db, new FakeAdapter(), {
      conversationId: channelConversation(db, channelId),
      agentId,
    });
    const run: Run = {
      id: uuid(),
      channelId,
      conversationId: channelConversation(db, channelId),
      agentId,
      triggerKind: "mention",
      triggerMessageId: trigger.id,
      rootMessageId: trigger.id,
      relayDepth: 0,
      sessionKey: session.sessionKey,
      status: "queued",
      hasCanonical: false,
      createdAt: new Date().toISOString(),
    };
    const inbound = buildInboundDeliver(db, {
      run,
      trigger: { message: trigger },
      session,
      needsPromptContext: false,
    });
    const humans = inbound.context.participants.filter((p) => p.type === "user").map((p) => p.handle);
    expect(humans.sort()).toEqual(["alice", "owner"]);
  });
});
