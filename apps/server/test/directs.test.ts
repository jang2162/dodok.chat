/**
 * 사람 DM·그룹 DM(direct) 열기·목록·쓰기(사람 간 DM 계획 태스크 3) — 실제 서버(FakeAdapter)에 사람 여럿을 붙여 REST·wire 로 본다. 참여하지
 * 않은 사람의 404 는 roles.matrix 「남의 direct — DIRECT_CASES」, 팬아웃은 realtime.dm-fanout 이 본다 — 여기는 참여자 쪽 동작이다.
 * direct_key 는 유일이라 테스트마다 새 사람으로 묶음을 만든다
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import {
  type Agent,
  type Channel,
  type DirectList,
  type DmAccess,
  type Message,
  PushPayload,
  type UnreadSnapshot,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App, AppDeps } from "../src/app";
import { channelMembers, channels, conversations, memberships, runs } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { channelParticipants, listMembers } from "../src/modules/channels/service";
import { directKey } from "../src/modules/directs/service";
import { createAgentMessage } from "../src/modules/messages/service";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { makePng } from "./helpers/png";
import { connectWire, recordEvents, type WireClient } from "./helpers/wire";

vi.setConfig({ testTimeout: 15_000 });

const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
type Ack<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
type Person = { id: string; token: string; handle: string };

describe("사람 DM·그룹 DM — 열기·목록·쓰기(서버)", () => {
  let app: App;
  let owner: Person;
  const sockets: WireClient[] = [];
  let sent: Array<{ endpoint: string; payload: PushPayload }> = [];
  let n = 0;

  const pushSend: NonNullable<AppDeps["pushSend"]> = async (sub, body) => {
    sent.push({ endpoint: sub.endpoint, payload: PushPayload.parse(JSON.parse(body)) });
    return { statusCode: 201 };
  };
  const endpointOf = (p: Person) => `https://push.invalid/${p.id}`;
  const sentTo = (p: Person) => sent.filter((s) => s.endpoint === endpointOf(p));

  beforeAll(async () => {
    app = await bootTestApp({}, { adapters: [new FakeAdapter()], pushSend });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    owner = { id: app.ownerUserId, token: (await login(app)).token, handle: "owner" };
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  function rest(
    who: Person,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ) {
    return app.fastify.inject({
      method,
      url,
      headers: { authorization: `Bearer ${who.token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  /** 새 활성 멤버 — 푸시 구독까지 */
  async function person(role: "admin" | "member" = "member"): Promise<Person> {
    const handle = `dx${++n}`;
    const user = await userWithRole(app, handle, role);
    const p = { ...user, handle };
    const res = await rest(p, "POST", "/api/v1/push/subscriptions", { endpoint: endpointOf(p), keys: KEYS });
    expect(res.statusCode, res.body).toBe(204);
    return p;
  }
  async function agentWith(dmAccess: DmAccess): Promise<Agent> {
    const agent = createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: `dxag${++n}`,
      handle: `dxag${n}`,
      name: `dxag${n}`,
    });
    if (dmAccess === "admins") return agent;
    const res = await rest(owner, "PATCH", `/api/v1/agents/${agent.id}`, { dmAccess });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { agent: Agent }).agent;
  }
  async function wire(who: Person): Promise<WireClient> {
    const socket = await connectWire(app, who.token);
    sockets.push(socket);
    return socket;
  }
  const post = (who: Person, body: { userIds?: string[]; agentIds?: string[] }) =>
    rest(who, "POST", "/api/v1/directs", body);
  async function open(who: Person, body: { userIds?: string[]; agentIds?: string[] }): Promise<Channel> {
    const res = await post(who, body);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { channel: Channel }).channel;
  }
  const conversationsOf = (channelId: string) =>
    app.db.select().from(conversations).where(eq(conversations.channelId, channelId)).all();
  /** 한 줄기 direct 의 그 대화 */
  const lineOf = (channelId: string): string => {
    const [only, ...rest] = conversationsOf(channelId);
    if (!only || rest.length > 0) throw new Error(`한 줄기가 아니다: ${channelId}`);
    return only.id;
  };
  const membersOf = (channelId: string) =>
    app.db.select().from(channelMembers).where(eq(channelMembers.channelId, channelId)).all();
  const setDeactivated = (who: Person, on: boolean) =>
    app.db
      .update(memberships)
      .set({ deactivatedAt: on ? new Date() : null })
      .where(and(eq(memberships.workspaceId, app.workspaceId), eq(memberships.userId, who.id)))
      .run();
  function send(
    socket: WireClient,
    body: {
      channelId: string;
      conversationId?: string;
      newConversation?: object;
      bodyMd?: string;
      threadRootId?: string;
    },
  ) {
    return socket.emitWithAck("message.send", {
      clientMsgId: `dx-send-${++n}`,
      bodyMd: "안녕",
      ...body,
    }) as Promise<Ack<{ message: Message; conversation?: { id: string } }>>;
  }
  async function sentOk(socket: WireClient, body: Parameters<typeof send>[1]): Promise<Message> {
    const res = await send(socket, body);
    if (!res.ok) throw new Error(JSON.stringify(res));
    return res.data.message;
  }
  const validation = { ok: false, error: { code: "VALIDATION" } };

  // ── 열기(Step 1·2) ──────────────────────────────────────────

  it("꼴 오류는 VALIDATION — 상대 0명·나 포함 10명·중복 id·나 자신·에이전트 하나만", async () => {
    const mia = await person();
    const jun = await person();
    const agent = await agentWith("everyone");
    const nine = Array.from({ length: 9 }, () => uuid());
    for (const body of [
      {},
      { userIds: [], agentIds: [] },
      { userIds: nine },
      { userIds: nine.slice(0, 5), agentIds: nine.slice(5) },
      { userIds: [jun.id, jun.id] },
      { userIds: [jun.id], agentIds: [agent.id, agent.id] },
      { userIds: [mia.id] },
      { userIds: [mia.id, jun.id] },
      { agentIds: [agent.id] },
    ]) {
      const res = await post(mia, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION" });
    }
    expect(app.db.select().from(channels).where(eq(channels.createdBy, mia.id)).all()).toEqual([]);
  });

  it("나 포함 9명은 연다 — 사람 8", async () => {
    const mia = await person();
    const others = await Promise.all(Array.from({ length: 8 }, () => person()));
    const channel = await open(mia, { userIds: others.map((p) => p.id) });
    expect(membersOf(channel.id)).toHaveLength(9);
  });

  it("새로 열 때 비활성·없는 사람, 없는·보관된 에이전트는 404", async () => {
    const mia = await person();
    const jun = await person();
    const gone = await person();
    setDeactivated(gone, true);
    const archived = await agentWith("everyone");
    expect((await rest(owner, "DELETE", `/api/v1/agents/${archived.id}`)).statusCode).toBe(200);
    for (const body of [
      { userIds: [gone.id] },
      { userIds: [jun.id, gone.id] },
      { userIds: [uuid()] },
      { userIds: [jun.id], agentIds: [uuid()] },
      { userIds: [jun.id], agentIds: [archived.id] },
    ]) {
      const res = await post(mia, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(404);
      expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("꺼진 에이전트는 403 details.agentId — 사람 참여자 하나라도 dmAccess 밖이면 연 사람이 admin 이어도 403", async () => {
    const admin = await person("admin");
    const mia = await person();
    const jun = await person();
    const disabled = await agentWith("everyone");
    expect((await rest(owner, "PATCH", `/api/v1/agents/${disabled.id}`, { enabled: false })).statusCode).toBe(
      200,
    );
    const off = await post(admin, { userIds: [jun.id], agentIds: [disabled.id] });
    expect(off.statusCode, off.body).toBe(403);
    expect(off.json()).toMatchObject({ code: "FORBIDDEN", details: { agentId: disabled.id } });

    // admins 에이전트 — admin 은 들고 member jun 은 막힌다. 누가 막혔는지는 싣지 않는다
    const adminsOnly = await agentWith("admins");
    const open1 = await agentWith("everyone");
    for (const [who, body] of [
      [admin, { userIds: [jun.id], agentIds: [adminsOnly.id] }],
      [admin, { userIds: [jun.id], agentIds: [open1.id, adminsOnly.id] }],
      [mia, { userIds: [admin.id], agentIds: [adminsOnly.id] }],
    ] as Array<[Person, { userIds: string[]; agentIds: string[] }]>) {
      const res = await post(who, body);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json()).toEqual({
        code: "FORBIDDEN",
        message: expect.any(String),
        details: { agentId: adminsOnly.id },
      });
    }
    expect(app.db.select().from(channels).where(eq(channels.createdBy, admin.id)).all()).toEqual([]);
    // 사람 참여자가 모두 admin 이상이면 연다
    const admin2 = await person("admin");
    expect((await post(admin, { userIds: [admin2.id], agentIds: [adminsOnly.id] })).statusCode).toBe(200);
    expect((await post(mia, { userIds: [jun.id], agentIds: [open1.id] })).statusCode).toBe(200);
  });

  it("이미 있는 묶음은 허용 검사 없이 같은 채널 — 상대가 비활성이 되거나 에이전트 허용이 철회돼도", async () => {
    const mia = await person();
    const jun = await person();
    const kai = await person();
    const agent = await agentWith("everyone");
    const line = await open(mia, { userIds: [jun.id] });
    const group = await open(mia, { userIds: [kai.id], agentIds: [agent.id] });
    setDeactivated(jun, true);
    expect((await rest(owner, "PATCH", `/api/v1/agents/${agent.id}`, { dmAccess: "off" })).statusCode).toBe(
      200,
    );
    const again = await post(mia, { userIds: [jun.id] });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ channel: { id: line.id }, created: false });
    const againGroup = await post(kai, { userIds: [mia.id], agentIds: [agent.id] });
    expect(againGroup.json()).toMatchObject({ channel: { id: group.id }, created: false });
  });

  it("순서를 바꾼 두 요청(Review Focus 5) — 채널 행 하나·같은 id, 한 줄기면 대화도 하나", async () => {
    const mia = await person();
    const jun = await person();
    const kai = await person();
    const agent = await agentWith("everyone");
    // 한 줄기 셋 — 연 사람과 상대의 자리를 바꾼다
    const [a, b] = await Promise.all([
      post(mia, { userIds: [jun.id, kai.id] }),
      post(kai, { userIds: [jun.id, mia.id] }),
    ]);
    const first = (a.json() as { channel: Channel; created: boolean }).channel;
    expect((b.json() as { channel: Channel }).channel.id).toBe(first.id);
    expect([a.json().created, b.json().created].sort()).toEqual([false, true]);
    expect(conversationsOf(first.id)).toHaveLength(1);
    // 세션 그룹 — 사람과 에이전트의 순서도 바꾼다
    const [c, d] = await Promise.all([
      post(mia, { userIds: [jun.id], agentIds: [agent.id] }),
      post(jun, { agentIds: [agent.id], userIds: [mia.id] }),
    ]);
    const group = (c.json() as { channel: Channel }).channel;
    expect((d.json() as { channel: Channel }).channel.id).toBe(group.id);
    const key = directKey({ userIds: [mia.id, jun.id], agentIds: [agent.id] });
    expect(app.db.select().from(channels).where(eq(channels.directKey, key)).all()).toHaveLength(1);
    expect(directKey({ userIds: [jun.id, mia.id], agentIds: [agent.id] })).toBe(key);
    expect(conversationsOf(group.id)).toEqual([]);
  });

  it("채널 행 값·멤버는 참여자 그대로(에이전트 autoRespond false), 처음 만들 때만 사람 참여자에게 channel.created", async () => {
    const mia = await person();
    const jun = await person();
    const outsider = await person();
    const agent = await agentWith("everyone");
    const junEvents = recordEvents(await wire(jun), ["channel.created"]);
    const outsiderEvents = recordEvents(await wire(outsider), ["channel.created"]);
    const res = await post(mia, { userIds: [jun.id], agentIds: [agent.id] });
    expect(res.json()).toMatchObject({ created: true });
    const channel = (res.json() as { channel: Channel }).channel;
    expect(channel.topic ?? null).toBeNull();
    expect(channel.prompt ?? null).toBeNull();
    expect(channel).toMatchObject({
      kind: "direct",
      name: "direct",
      visibility: "private",
      dmOwnerId: null,
      dmAgentId: null,
      createdBy: mia.id,
      sessionPolicy: { create: "members" },
      relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
      archivedAt: null,
    });
    expect(
      membersOf(channel.id)
        .map((m) => ({ type: m.memberType, id: m.memberId, role: m.role, autoRespond: m.autoRespond }))
        .sort((x, y) => `${x.type}${x.id}`.localeCompare(`${y.type}${y.id}`)),
    ).toEqual(
      [
        { type: "agent", id: agent.id, role: null, autoRespond: false },
        { type: "user", id: mia.id, role: "member", autoRespond: false },
        { type: "user", id: jun.id, role: "member", autoRespond: false },
      ].sort((x, y) => `${x.type}${x.id}`.localeCompare(`${y.type}${y.id}`)),
    );
    await vi.waitFor(() => expect(junEvents).toHaveLength(1));
    await open(jun, { userIds: [mia.id], agentIds: [agent.id] });
    await rest(outsider, "GET", "/api/v1/directs");
    expect(junEvents).toHaveLength(1);
    expect(outsiderEvents).toEqual([]);
  });

  // ── 목록(Step 3·4) ──────────────────────────────────────────

  it("GET /directs — 내가 참여한 것만 최근 활동순, users 에 나 없음·비활성 포함, agents 에 보관 없음, 글 없으면 null", async () => {
    const mia = await person();
    const jun = await person();
    const kai = await person();
    const lee = await person();
    const keep = await agentWith("everyone");
    const gone = await agentWith("everyone");
    const a = await open(mia, { userIds: [jun.id] });
    await new Promise((r) => setTimeout(r, 5));
    const b = await open(mia, { userIds: [kai.id], agentIds: [keep.id, gone.id] });
    await new Promise((r) => setTimeout(r, 5));
    const c = await open(mia, { userIds: [jun.id, kai.id] });
    const notMine = await open(jun, { userIds: [kai.id] });
    await new Promise((r) => setTimeout(r, 5));
    await sentOk(await wire(jun), { channelId: a.id, conversationId: lineOf(a.id) });
    setDeactivated(jun, true);
    expect((await rest(owner, "DELETE", `/api/v1/agents/${gone.id}`)).statusCode).toBe(200);

    const res = await rest(mia, "GET", "/api/v1/directs");
    expect(res.statusCode, res.body).toBe(200);
    const { directs } = res.json() as DirectList;
    // a(글 있음, 가장 최근) → c(연 시각) → b(연 시각)
    expect(directs.map((d) => d.channel.id)).toEqual([a.id, c.id, b.id]);
    expect(directs.map((d) => d.channel.id)).not.toContain(notMine.id);
    const [da, dc, db] = directs;
    expect(da?.users.map((u) => u.id)).toEqual([jun.id]);
    expect(da?.users[0]?.deactivatedAt).not.toBeNull();
    expect(da?.lastMessageAt).not.toBeNull();
    expect(da?.agents).toEqual([]);
    expect(dc?.users.map((u) => u.id).sort()).toEqual([jun.id, kai.id].sort());
    expect(dc?.lastMessageAt).toBeNull();
    expect(db?.agents.map((x) => x.id)).toEqual([keep.id]);
    expect(db?.agents[0]?.runnerAgent).toBeUndefined();
    expect(db?.lastMessageAt).toBeNull();
    expect(directs.flatMap((d) => d.users.map((u) => u.id))).not.toContain(mia.id);
    // 참여하지 않은 lee 의 목록은 비었다
    expect(((await rest(lee, "GET", "/api/v1/directs")).json() as DirectList).directs).toEqual([]);
  });

  // ── 한 줄기·세션 권한(Step 5·6 — PH4·PH5) ─────────────────────────

  it("한 줄기(1:1·사람 그룹) — newConversation·PATCH /conversations 는 VALIDATION, 대화 id 로 보내기·스레드 답글은 된다", async () => {
    const mia = await person();
    const jun = await person();
    const kai = await person();
    for (const channel of [
      await open(mia, { userIds: [jun.id] }),
      await open(mia, { userIds: [jun.id, kai.id] }),
    ]) {
      const conversationId = lineOf(channel.id);
      const miaSocket = await wire(mia);
      const junSocket = await wire(jun);
      expect(await send(junSocket, { channelId: channel.id, newConversation: {} })).toMatchObject(validation);
      for (const who of [mia, jun]) {
        for (const patch of [{ title: "새 이름" }, { closed: true }]) {
          const res = await rest(who, "PATCH", `/api/v1/conversations/${conversationId}`, patch);
          expect(res.statusCode, res.body).toBe(400);
          expect(res.json()).toMatchObject({ code: "VALIDATION" });
        }
      }
      const root = await sentOk(miaSocket, { channelId: channel.id, conversationId });
      const reply = await sentOk(junSocket, { channelId: channel.id, conversationId, threadRootId: root.id });
      expect(reply.threadRootId).toBe(root.id);
      expect(conversationsOf(channel.id)).toHaveLength(1);
    }
  });

  it("세션 그룹 — member 참여자 누구나 새 세션·남이 만든 세션의 제목 바꾸기·닫기", async () => {
    const mia = await person();
    const jun = await person();
    const agent = await agentWith("everyone");
    const group = await open(mia, { userIds: [jun.id], agentIds: [agent.id] });
    const miaSocket = await wire(mia);
    const first = await send(miaSocket, { channelId: group.id, newConversation: {} });
    if (!first.ok) throw new Error(JSON.stringify(first));
    const conversationId = first.data.message.conversationId;
    const second = await send(await wire(jun), { channelId: group.id, newConversation: {} });
    expect(second.ok).toBe(true);
    const renamed = await rest(jun, "PATCH", `/api/v1/conversations/${conversationId}`, {
      title: "jun 이 바꿈",
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const closed = await rest(jun, "PATCH", `/api/v1/conversations/${conversationId}`, { closed: true });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({
      conversation: { title: "jun 이 바꿈", closedAt: expect.any(String) },
    });
  });

  it("direct 의 채널 관리는 모두 VALIDATION — 이름·주제·지시·정책·한도·멤버·autoRespond·보관·세션 관리자", async () => {
    const admin = await person("admin");
    const jun = await person();
    const agent = await agentWith("everyone");
    const group = await open(admin, { userIds: [jun.id], agentIds: [agent.id] });
    const base = `/api/v1/channels/${group.id}`;
    const cases: Array<[Parameters<typeof rest>[1], string, unknown?]> = [
      ["PATCH", base, { name: "새이름" }],
      ["PATCH", base, { topic: "주제" }],
      ["PATCH", base, { prompt: "지시" }],
      ["PATCH", base, { sessionPolicy: { create: "managers" } }],
      ["PATCH", base, { relayPolicy: { maxRelayTurns: 4, allowPairs: "all", dailyRunLimit: 3 } }],
      ["POST", `${base}/members`, { memberType: "user", memberId: owner.id }],
      ["DELETE", `${base}/members/${jun.id}`],
      ["PATCH", `${base}/members/${agent.id}`, { autoRespond: true }],
      ["POST", `${base}/archive`],
      ["POST", `${base}/unarchive`],
      ["PUT", `${base}/session-managers/${jun.id}`],
      ["DELETE", `${base}/session-managers/${jun.id}`],
    ];
    for (const who of [admin, jun]) {
      for (const [method, url, body] of cases) {
        const res = await rest(who, method, url, body);
        expect(res.statusCode, `${method} ${url} ${JSON.stringify(body)} ${res.body}`).toBe(400);
        expect(res.json()).toMatchObject({ code: "VALIDATION" });
      }
    }
    expect(membersOf(group.id)).toHaveLength(3);
  });

  // ── 멘션(Step 7·8 — PH6, Review Focus 3) ─────────────────────────

  it("참여자가 아닌 @사람·@에이전트·손으로 쓴 토큰은 글자로 — 참여자만 토큰, 멤버 불변, 푸시·배지·검색·런 없음", async () => {
    const mia = await person();
    const jun = await person();
    const kai = await person();
    const dev = await agentWith("everyone");
    const fin = await agentWith("everyone");
    const group = await open(mia, { userIds: [jun.id], agentIds: [dev.id] });
    const miaSocket = await wire(mia);
    const first = await send(miaSocket, { channelId: group.id, newConversation: {} });
    if (!first.ok) throw new Error(JSON.stringify(first));
    const conversationId = first.data.message.conversationId;
    sent = [];
    const message = await sentOk(miaSocket, {
      channelId: group.id,
      conversationId,
      bodyMd: `@${jun.handle} @${kai.handle} @${fin.handle} 봐 주세요 <@u:${kai.id}> <@a:${fin.id}>`,
    });
    expect(message.mentions).toEqual({ users: [jun.id], agents: [] });
    expect(message.bodyMd).toContain(`<@u:${jun.id}>`);
    expect(message.bodyMd).toContain(`@${kai.handle} @${fin.handle} 봐 주세요`);
    expect(message.bodyMd).not.toContain(`<@u:${kai.id}>`);
    expect(message.bodyMd).not.toContain(`<@a:${fin.id}>`);
    expect(
      membersOf(group.id)
        .map((m) => m.memberId)
        .sort(),
    ).toEqual([mia.id, jun.id, dev.id].sort());
    await vi.waitFor(() => expect(sentTo(jun)).toHaveLength(1));
    expect(sentTo(kai)).toEqual([]);
    const snap = (await rest(kai, "GET", "/api/v1/me/unread")).json() as UnreadSnapshot;
    expect(snap.conversations.some((c) => c.channelId === group.id)).toBe(false);
    const search = await rest(kai, "GET", `/api/v1/search?q=${encodeURIComponent("봐 주세요")}`);
    expect(search.statusCode, search.body).toBe(200);
    expect(search.body).not.toContain(message.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(app.db.select().from(runs).where(eq(runs.agentId, fin.id)).all()).toEqual([]);

    // 에이전트 정본도 같다 — 참여자 토큰만 남고 비참여 사람·에이전트는 중화
    const answer = createAgentMessage(app.db, app.bus, {
      conversationId,
      agentId: dev.id,
      bodyMd: `@${jun.handle} @${kai.handle} <@u:${kai.id}> <@a:${fin.id}> @${fin.handle}`,
      externalId: `dx-answer-${++n}`,
    });
    expect(answer.mentions).toEqual({ users: [jun.id], agents: [] });
    expect(answer.bodyMd).not.toContain(`<@u:${kai.id}>`);
    expect(answer.bodyMd).not.toContain(`<@a:${fin.id}>`);
  });

  // ── 읽기 전용(Step 9·10 — PH10, Review Focus 4) ──────────────────

  it("1:1 상대가 비활성이면 보내기·반응·카드·첨부가 409 peer_deactivated, 읽기는 되고 다시 활성화하면 보낸다", async () => {
    const mia = await person();
    const jun = await person();
    const agent = await agentWith("everyone");
    const line = await open(mia, { userIds: [jun.id] });
    const conversationId = lineOf(line.id);
    const socket = await wire(mia);
    const card = createAgentMessage(app.db, app.bus, {
      conversationId,
      agentId: agent.id,
      bodyMd: "골라 주세요",
      externalId: `dx-card-${++n}`,
      components: {
        blocks: [{ type: "actions", id: "row", items: [{ type: "button", id: "go", label: "진행" }] }],
      },
    });
    setDeactivated(jun, true);
    const readOnly = { ok: false, error: { code: "DM_READ_ONLY", details: { reason: "peer_deactivated" } } };
    expect(await send(socket, { channelId: line.id, conversationId })).toMatchObject(readOnly);
    expect(
      await socket.emitWithAck("reaction.set", { messageId: card.id, emoji: "👍", on: true }),
    ).toMatchObject(readOnly);
    expect(
      await socket.emitWithAck("component.interact", {
        messageId: card.id,
        componentId: card.components?.id ?? "",
        itemId: "go",
        values: {},
      }),
    ).toMatchObject(readOnly);
    const upload = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/attachments?channelId=${line.id}`,
      headers: { authorization: `Bearer ${mia.token}`, "content-type": "image/png" },
      payload: makePng(2, 2),
    });
    expect(upload.statusCode, upload.body).toBe(409);
    expect(upload.json()).toMatchObject({
      code: "DM_READ_ONLY",
      message: "상대가 비활성화되어 읽기만 할 수 있습니다",
      details: { reason: "peer_deactivated" },
    });
    const read = await rest(mia, "GET", `/api/v1/conversations/${conversationId}/messages`);
    expect(read.statusCode, read.body).toBe(200);
    const list = (await rest(mia, "GET", "/api/v1/directs")).json() as DirectList;
    expect(list.directs.find((d) => d.channel.id === line.id)?.readOnlyReason).toBe("peer_deactivated");

    setDeactivated(jun, false);
    expect((await send(socket, { channelId: line.id, conversationId })).ok).toBe(true);
    const after = (await rest(mia, "GET", "/api/v1/directs")).json() as DirectList;
    expect(after.directs.find((d) => d.channel.id === line.id)?.readOnlyReason).toBeNull();
  });

  it("그룹은 한 사람이 비활성이어도 계속 쓴다 — 참여자 목록에서 빠진다", async () => {
    const mia = await person();
    const jun = await person();
    const kai = await person();
    const group = await open(mia, { userIds: [jun.id, kai.id] });
    setDeactivated(jun, true);
    const socket = await wire(mia);
    expect((await send(socket, { channelId: group.id, conversationId: lineOf(group.id) })).ok).toBe(true);
    const list = (await rest(mia, "GET", "/api/v1/directs")).json() as DirectList;
    expect(list.directs.find((d) => d.channel.id === group.id)?.readOnlyReason).toBeNull();
    expect(channelParticipants(app.db, group.id).map((p) => p.id)).not.toContain(jun.id);
    expect(listMembers(app.db, group.id).map((m) => m.memberId)).not.toContain(jun.id);
  });

  // ── 읽지 않음·사람 글 푸시(Step 11·12 — PH13·PH14) ─────────────────

  it("1:1 의 남의 글은 모두 배지 — 스냅숏 mentions 와 channel.activity 의 mentionedUserIds 가 같다", async () => {
    const mia = await person();
    const jun = await person();
    const line = await open(mia, { userIds: [jun.id] });
    const conversationId = lineOf(line.id);
    const activity = recordEvents(await wire(mia), ["channel.activity"]);
    const junSocket = await wire(jun);
    for (let i = 0; i < 3; i++)
      await sentOk(junSocket, { channelId: line.id, conversationId, bodyMd: `글 ${i}` });
    const snap = (await rest(mia, "GET", "/api/v1/me/unread")).json() as UnreadSnapshot;
    expect(snap.conversations.find((c) => c.conversationId === conversationId)).toMatchObject({
      mentions: 3,
    });
    await vi.waitFor(() => expect(activity).toHaveLength(3));
    const fromJun = activity
      .map((e) => e.payload as { authorId: string; mentionedUserIds: string[] })
      .filter((p) => p.authorId === jun.id);
    expect(fromJun.map((p) => p.mentionedUserIds)).toEqual([[mia.id], [mia.id], [mia.id]]);
  });

  it("그룹의 사람 글(최상위·스레드)은 작성자 뺀 사람 참여자 전원에게 푸시 — 「<이름> 님의 메시지」·「DM」·direct:<세션>", async () => {
    const mia = await person();
    const jun = await person();
    const kai = await person();
    const outsider = await person();
    const group = await open(mia, { userIds: [jun.id, kai.id] });
    const conversationId = lineOf(group.id);
    const socket = await wire(mia);
    sent = [];
    const root = await sentOk(socket, { channelId: group.id, conversationId, bodyMd: "본문은 싣지 않는다" });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.endpoint).sort()).toEqual([endpointOf(jun), endpointOf(kai)].sort());
    for (const { payload } of sent) {
      expect(payload).toEqual({
        kind: "mention",
        channelId: group.id,
        title: `${mia.handle} 님의 메시지`,
        body: "DM",
        url: `/c/${group.id}/s/${conversationId}`,
        tag: `direct:${conversationId}`,
      });
    }
    sent = [];
    await sentOk(await wire(jun), { channelId: group.id, conversationId, threadRootId: root.id });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.endpoint).sort()).toEqual([endpointOf(mia), endpointOf(kai)].sort());
    expect(sent[0]?.payload).toMatchObject({
      title: `${jun.handle} 님의 메시지`,
      body: "DM",
      url: `/c/${group.id}/s/${conversationId}/t/${root.id}`,
      tag: `direct:${conversationId}`,
    });
    expect(sentTo(outsider)).toEqual([]);
  });

  it("그 대화를 보고 있으면 거르고, 방해 금지면 보내지 않는다", async () => {
    const mia = await person();
    const jun = await person();
    const line = await open(mia, { userIds: [jun.id] });
    const conversationId = lineOf(line.id);
    const junSocket = await wire(jun);
    const miaSocket = await wire(mia);
    const roundTrip = () => junSocket.emitWithAck("channel.unsubscribe", { channelId: uuid() });
    junSocket.emit("presence.update", { visible: true, channelId: line.id, conversationId });
    await roundTrip();
    sent = [];
    await sentOk(miaSocket, { channelId: line.id, conversationId });
    await new Promise((r) => setTimeout(r, 30));
    expect(sentTo(jun)).toEqual([]);
    junSocket.emit("presence.update", { visible: false });
    await roundTrip();
    const dnd = await rest(jun, "PUT", "/api/v1/me/status", { mode: "dnd", modeUntil: null });
    expect(dnd.statusCode, dnd.body).toBe(200);
    await sentOk(miaSocket, { channelId: line.id, conversationId });
    await new Promise((r) => setTimeout(r, 30));
    expect(sentTo(jun)).toEqual([]);
    await rest(jun, "PUT", "/api/v1/me/status", { mode: "auto" });
    await sentOk(miaSocket, { channelId: line.id, conversationId });
    await vi.waitFor(() => expect(sentTo(jun)).toHaveLength(1));
  });
});
