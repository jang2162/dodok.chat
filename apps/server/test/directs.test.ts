/**
 * 사람 DM·그룹 DM(direct) 열기·목록·쓰기(사람 간 DM 계획 태스크 3) — 실제 서버(FakeAdapter)에 사람 여럿을 붙여 REST·wire 로 본다. 참여하지
 * 않은 사람의 404 는 roles.matrix 「남의 direct — DIRECT_CASES」, 팬아웃은 realtime.dm-fanout 이 본다 — 여기는 참여자 쪽 동작이다.
 * direct_key 는 유일이라 테스트마다 새 사람으로 묶음을 만든다
 */
import type { ProviderApproval } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import {
  type Agent,
  type Approval,
  type Channel,
  type DirectList,
  type DmAccess,
  type Message,
  PushPayload,
  type UnreadSnapshot,
} from "@dodok/shared";
import { and, eq, sql } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App, AppDeps } from "../src/app";
import {
  channelMembers,
  channels,
  conversations,
  memberships,
  messages,
  runs,
  users,
} from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import * as approvalStore from "../src/modules/approvals/store";
import { channelParticipants, listMembers } from "../src/modules/channels/service";
import { directKey } from "../src/modules/directs/service";
import { createAgentMessage, createSystemMessage } from "../src/modules/messages/service";
import { josa } from "../src/util/josa";
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
  const adapter = new FakeAdapter();
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
    app = await bootTestApp({}, { adapters: [adapter], pushSend });
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

  it("GET /directs 의 sessions — 에이전트가 든 그룹은 참, 그 에이전트를 보관해 agents 가 비어도 참이고 새 세션도 된다, 사람만이면 거짓", async () => {
    const mia = await person();
    const jun = await person();
    const kai = await person();
    const dev = await agentWith("everyone");
    const one = await open(mia, { userIds: [jun.id] });
    const people = await open(mia, { userIds: [jun.id, kai.id] });
    const group = await open(mia, { userIds: [jun.id], agentIds: [dev.id] });
    const listed = async () =>
      new Map(
        ((await rest(mia, "GET", "/api/v1/directs")).json() as DirectList).directs.map((d) => [
          d.channel.id,
          d,
        ]),
      );
    const before = await listed();
    expect(before.get(group.id)?.sessions).toBe(true);
    expect(before.get(one.id)?.sessions).toBe(false);
    expect(before.get(people.id)?.sessions).toBe(false);

    expect((await rest(owner, "DELETE", `/api/v1/agents/${dev.id}`)).statusCode).toBe(200);
    const after = await listed();
    // 보관한 에이전트는 agents 에서 빠져 1:1 줄과 users·agents 가 같아진다 — sessions 만이 둘을 가른다
    expect(after.get(group.id)).toMatchObject({ agents: [], sessions: true });
    expect(after.get(group.id)?.users.map((u) => u.id)).toEqual([jun.id]);
    expect(after.get(one.id)).toMatchObject({ agents: [], sessions: false });
    expect((await send(await wire(mia), { channelId: group.id, newConversation: {} })).ok).toBe(true);
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
    // 제목은 표시 이름이다 — 도우미는 표시 이름을 핸들과 같게 만들어 둘을 가르지 못하므로 여기서 다르게 바꾼다
    const miaName = `미아 ${mia.handle}`;
    app.db.update(users).set({ displayName: miaName }).where(eq(users.id, mia.id)).run();
    const socket = await wire(mia);
    sent = [];
    const root = await sentOk(socket, { channelId: group.id, conversationId, bodyMd: "본문은 싣지 않는다" });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.endpoint).sort()).toEqual([endpointOf(jun), endpointOf(kai)].sort());
    for (const { payload } of sent) {
      expect(payload).toEqual({
        kind: "mention",
        channelId: group.id,
        title: `${miaName} 님의 메시지`,
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

  // ── 그룹 DM 의 에이전트 런(태스크 4) ─────────────────────────────

  const runsOf = (channelId: string) =>
    app.db.select().from(runs).where(eq(runs.channelId, channelId)).orderBy(runs.createdAt, runs.id).all();
  const systemOf = (conversationId: string) =>
    app.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.kind, "system")))
      .all();
  const setRole = (who: Person, role: "admin" | "member") =>
    app.db
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.workspaceId, app.workspaceId), eq(memberships.userId, who.id)))
      .run();
  const blockedBody = (handle: string, why: "dm" | "none") =>
    `@${handle} 는 이 요청에 답하지 않았습니다 — ${why === "dm" ? "시킨 사람이 이 에이전트의 DM 허용 범위 밖입니다" : "시킨 사람이 없습니다"}`;
  /** 에이전트가 있는 그룹 DM 의 첫 세션 — 첫 글을 보내 세션을 만든다 */
  async function groupSession(
    who: Person,
    group: Channel,
    bodyMd = "세션을 엽니다",
  ): Promise<{ socket: WireClient; conversationId: string; first: Message }> {
    const socket = await wire(who);
    const res = await send(socket, { channelId: group.id, newConversation: {}, bodyMd });
    if (!res.ok) throw new Error(JSON.stringify(res));
    return { socket, conversationId: res.data.message.conversationId, first: res.data.message };
  }

  it("에이전트는 멘션받을 때만 — 멘션 없는 글은 런 0, @dev 는 dev 런(시킨 사람 mia), 정본의 @fin 은 fin 런(물려받음), 턴 4 를 넘으면 relay_limit", async () => {
    const mia = await person();
    const jun = await person();
    const dev = await agentWith("everyone");
    const fin = await agentWith("everyone");
    const group = await open(mia, { userIds: [jun.id], agentIds: [dev.id, fin.id] });
    const { socket, conversationId } = await groupSession(mia, group);
    await sentOk(socket, { channelId: group.id, conversationId, bodyMd: "그냥 하는 말" });
    await new Promise((r) => setTimeout(r, 30));
    expect(runsOf(group.id)).toEqual([]);

    await sentOk(socket, { channelId: group.id, conversationId, bodyMd: `@${dev.handle} 해 주세요` });
    await vi.waitFor(() => expect(runsOf(group.id)).toHaveLength(1));
    const devRun = runsOf(group.id)[0];
    if (!devRun) throw new Error("런이 없다");
    expect(devRun).toMatchObject({
      agentId: dev.id,
      triggerKind: "mention",
      requestedBy: mia.id,
      relayDepth: 0,
      sessionKey: adapter.sessionKeyFor(dev.providerAgentId, conversationId),
    });

    // 릴레이 — dev ↔ fin 이 서로 멘션한다. 사슬 전체가 처음 시킨 사람 mia 를 지닌다
    let source = devRun;
    let [speaker, other] = [dev, fin];
    for (let turn = 1; turn <= 5; turn++) {
      const answer = createAgentMessage(app.db, app.bus, {
        conversationId,
        agentId: speaker.id,
        runId: source.id,
        bodyMd: `@${other.handle} 이어서 ${turn}`,
        externalId: `dx-relay-${++n}`,
      });
      await app.services.router.routeMessage(answer);
      const next = runsOf(group.id).find((r) => r.triggerKind === "relay" && r.relayDepth === turn);
      if (turn > 4) {
        expect(next).toBeUndefined();
        break;
      }
      expect(next).toMatchObject({
        agentId: other.id,
        triggerKind: "relay",
        requestedBy: mia.id,
        relayDepth: turn,
      });
      if (!next) throw new Error("릴레이 런이 없다");
      source = next;
      [speaker, other] = [other, speaker];
    }
    expect(runsOf(group.id)).toHaveLength(5);
    expect(systemOf(conversationId)).toHaveLength(1);
    expect(systemOf(conversationId)[0]?.bodyMd).toContain("릴레이 한도(4턴)");

    // 세션 키는 대화마다 다르다
    const second = await groupSession(mia, group, `@${dev.handle} 다른 세션`);
    await vi.waitFor(() =>
      expect(runsOf(group.id).filter((r) => r.conversationId === second.conversationId)).toHaveLength(1),
    );
    const secondRun = runsOf(group.id).find((r) => r.conversationId === second.conversationId);
    expect(secondRun?.sessionKey).toBe(adapter.sessionKeyFor(dev.providerAgentId, second.conversationId));
    expect(secondRun?.sessionKey).not.toBe(devRun.sessionKey);
  });

  it("시킨 사람 관문 — dmAccess 밖의 시킨 사람이면 런 없이 그 자리(스레드면 스레드)에 시스템 메시지 하나, 대화는 계속 쓴다", async () => {
    const mia = await person("admin");
    const jun = await person();
    const dev = await agentWith("everyone");
    const group = await open(mia, { userIds: [jun.id], agentIds: [dev.id] });
    const narrowed = await rest(owner, "PATCH", `/api/v1/agents/${dev.id}`, { dmAccess: "admins" });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const {
      socket: junSocket,
      conversationId,
      first,
    } = await groupSession(jun, group, `@${dev.handle} 해 주세요`);
    await vi.waitFor(() => expect(systemOf(conversationId)).toHaveLength(1));
    expect(runsOf(group.id)).toEqual([]);
    expect(systemOf(conversationId)[0]).toMatchObject({
      bodyMd: blockedBody(dev.handle, "dm"),
      threadRootId: null,
      systemMeta: { kind: "info" },
    });
    // 스레드 안에서 막히면 그 스레드에
    await sentOk(junSocket, {
      channelId: group.id,
      conversationId,
      threadRootId: first.id,
      bodyMd: `@${dev.handle} 스레드에서도`,
    });
    await vi.waitFor(() => expect(systemOf(conversationId)).toHaveLength(2));
    expect(systemOf(conversationId).find((m) => m.threadRootId === first.id)?.bodyMd).toBe(
      blockedBody(dev.handle, "dm"),
    );
    // 대화는 계속 — 사람의 글은 그대로 저장되고, 허용 범위 안의 mia(admin)가 시키면 런이 된다
    await sentOk(junSocket, { channelId: group.id, conversationId, bodyMd: "그래도 씁니다" });
    const miaSocket = await wire(mia);
    await sentOk(miaSocket, { channelId: group.id, conversationId, bodyMd: `@${dev.handle} 제가 시킵니다` });
    await vi.waitFor(() => expect(runsOf(group.id)).toHaveLength(1));
    expect(runsOf(group.id)[0]).toMatchObject({ agentId: dev.id, requestedBy: mia.id });
    expect(systemOf(conversationId)).toHaveLength(2);
  });

  it("줄 선 런의 시킨 사람이 강등되면 차례가 왔을 때 보내지 않고 aborted — 시스템 메시지 없음, 이미 간 런은 그대로", async () => {
    const mia = await person("admin");
    const jun = await person();
    const dev = await agentWith("everyone");
    const group = await open(mia, { userIds: [jun.id], agentIds: [dev.id] });
    await rest(owner, "PATCH", `/api/v1/agents/${dev.id}`, { dmAccess: "admins" });
    const { socket, conversationId } = await groupSession(mia, group, `@${dev.handle} 첫째`);
    await vi.waitFor(() => expect(runsOf(group.id)).toHaveLength(1));
    const running = runsOf(group.id)[0];
    if (!running) throw new Error("런이 없다");
    await vi.waitFor(() => expect(adapter.calls.send.some((c) => c.runId === running.id)).toBe(true));
    await sentOk(socket, { channelId: group.id, conversationId, bodyMd: `@${dev.handle} 둘째` });
    await vi.waitFor(() => expect(runsOf(group.id)).toHaveLength(2));
    const queued = runsOf(group.id).find((r) => r.id !== running.id);
    if (!queued) throw new Error("줄 선 런이 없다");
    expect(queued.status).toBe("queued");
    try {
      setRole(mia, "member");
      const statusOf = (id: string) => runsOf(group.id).find((r) => r.id === id)?.status;
      expect(statusOf(running.id)).toBe("queued");
      adapter.emit({ kind: "run_signal", runId: running.id, signal: { kind: "gateway_aborted" } });
      await vi.waitFor(() => expect(statusOf(queued.id)).toBe("aborted"));
      expect(adapter.calls.send.some((c) => c.runId === queued.id)).toBe(false);
      expect(systemOf(conversationId)).toEqual([]);
    } finally {
      setRole(mia, "admin");
    }
  });

  it("시킨 사람이 없는 릴레이(앞 런이 끝난 뒤 저장된 정본) — 런 없이 「시킨 사람이 없습니다」", async () => {
    const mia = await person();
    const jun = await person();
    const dev = await agentWith("everyone");
    const fin = await agentWith("everyone");
    const group = await open(mia, { userIds: [jun.id], agentIds: [dev.id, fin.id] });
    const { conversationId } = await groupSession(mia, group, `@${dev.handle} 해 주세요`);
    await vi.waitFor(() => expect(runsOf(group.id)).toHaveLength(1));
    const devRun = runsOf(group.id)[0];
    if (!devRun) throw new Error("런이 없다");
    app.db
      .update(runs)
      .set({ status: "done", endedAt: new Date(Date.now() - 60_000) })
      .where(eq(runs.id, devRun.id))
      .run();
    const late = createAgentMessage(app.db, app.bus, {
      conversationId,
      agentId: dev.id,
      runId: devRun.id,
      bodyMd: `@${fin.handle} 늦게 넘깁니다`,
      externalId: `dx-late-${++n}`,
    });
    await app.services.router.routeMessage(late);
    expect(runsOf(group.id).filter((r) => r.agentId === fin.id)).toEqual([]);
    expect(systemOf(conversationId).map((m) => m.bodyMd)).toEqual([blockedBody(fin.handle, "none")]);
  });

  it("카드를 누른 사람이 dmAccess 밖이면 저장·소비 전에 FORBIDDEN — 버튼은 살아 있고 런 없음", async () => {
    const mia = await person("admin");
    const jun = await person();
    const dev = await agentWith("everyone");
    const group = await open(mia, { userIds: [jun.id], agentIds: [dev.id] });
    const { conversationId } = await groupSession(mia, group);
    const card = createAgentMessage(app.db, app.bus, {
      conversationId,
      agentId: dev.id,
      bodyMd: "골라 주세요",
      externalId: `dx-card-${++n}`,
      components: {
        blocks: [{ type: "actions", id: "row", items: [{ type: "button", id: "go", label: "진행" }] }],
      },
    });
    await rest(owner, "PATCH", `/api/v1/agents/${dev.id}`, { dmAccess: "admins" });
    const junSocket = await wire(jun);
    const press = () =>
      junSocket.emitWithAck("component.interact", {
        messageId: card.id,
        componentId: card.components?.id ?? "",
        itemId: "go",
        values: {},
      });
    expect(await press()).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(runsOf(group.id)).toEqual([]);
    await rest(owner, "PATCH", `/api/v1/agents/${dev.id}`, { dmAccess: "everyone" });
    expect(await press()).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(runsOf(group.id)).toHaveLength(1));
    expect(runsOf(group.id)[0]).toMatchObject({ triggerKind: "interaction", requestedBy: jun.id });
  });

  /** 그룹 DM 에서 jun(member)이 시킨 dev 런의 승인 — 참여한 mia 는 admin, owner 는 참여하지 않는다 */
  async function groupApproval(kind: "plugin" | "exec" | "dodok_control") {
    const mia = await person("admin");
    const jun = await person();
    const dev = await agentWith("everyone");
    const group = await open(mia, { userIds: [jun.id], agentIds: [dev.id] });
    const { conversationId } = await groupSession(jun, group, `@${dev.handle} 파일을 써 주세요`);
    await vi.waitFor(() => expect(runsOf(group.id)).toHaveLength(1));
    const run = runsOf(group.id)[0];
    if (!run) throw new Error("런이 없다");
    let approval: Approval | undefined;
    if (kind === "dodok_control") {
      approval = app.services.approvals.openControl({
        runId: run.id,
        channelId: group.id,
        conversationId,
        agentId: dev.id,
        requestedBy: jun.id,
        toolName: "update_channel",
        title: "채널 바꾸기",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
      });
    } else {
      const frame: ProviderApproval = {
        providerApprovalId: `${kind}:${uuid()}`,
        kind,
        sessionKey: adapter.sessionKeyFor(dev.providerAgentId, conversationId),
        providerAgentId: dev.providerAgentId,
        conversationId,
        toolCallId: `toolu_${++n}`,
        toolName: kind === "exec" ? "exec" : "Write",
        ...(kind === "plugin" ? { pluginId: "fs" } : {}),
        title: "실행",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      };
      adapter.emitApproval(frame);
      await vi.waitFor(() =>
        expect(approvalStore.getApprovalByProviderId(app.db, frame.providerApprovalId)?.status).toBe(
          "pending",
        ),
      );
      approval = approvalStore.getApprovalByProviderId(app.db, frame.providerApprovalId);
    }
    if (!approval) throw new Error("승인이 저장되지 않았다");
    return { approval, mia, jun, dev, group, conversationId, run };
  }

  it.each(["plugin", "exec", "dodok_control"] as const)(
    "그룹 DM 의 %s 승인은 그 런을 시킨 jun(member)만 — 참여한 admin mia 는 FORBIDDEN(wire·서비스 둘 다), 참여하지 않은 owner 는 NOT_FOUND",
    async (kind) => {
      const { approval, mia, jun } = await groupApproval(kind);
      expect(approval.requestedBy).toBe(jun.id);
      const resolve = async (who: Person) =>
        (await wire(who)).emitWithAck("approval.resolve", { approvalId: approval.id, decision: "deny" });
      const sentBefore = adapter.calls.resolveApproval.length;
      expect(await resolve(owner)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      // wire 가 먼저 막는다 — 승인 서비스까지 가지 않는다(서비스의 같은 판정은 아래에서 따로 본다)
      const service = vi.spyOn(app.services.approvals, "resolve");
      try {
        expect(await resolve(mia)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        expect(service).not.toHaveBeenCalled();
      } finally {
        service.mockRestore();
      }
      // wire 앞단을 거치지 않는 호출도 같은 결과(태스크 1 리뷰 L1)
      await expect(
        app.services.approvals.resolve({ approvalId: approval.id, decision: "deny", userId: mia.id }),
      ).rejects.toMatchObject({ body: { code: "FORBIDDEN" } });
      expect(adapter.calls.resolveApproval.length).toBe(sentBefore);
      expect(approvalStore.getApproval(app.db, approval.id)?.status).toBe("pending");
      expect(await resolve(jun)).toMatchObject({ ok: true });
      expect(approvalStore.getApproval(app.db, approval.id)).toMatchObject({
        status: "denied",
        decidedBy: jun.id,
      });
      if (kind !== "dodok_control") expect(adapter.calls.resolveApproval.length).toBe(sentBefore + 1);
    },
  );

  it("승인 서비스 — 시킨 사람이 비어 있는 direct 승인은 아무도 결정하지 못한다(FORBIDDEN)", async () => {
    const { approval, jun } = await groupApproval("plugin");
    app.db.run(sql`UPDATE approvals SET requested_by = NULL WHERE id = ${approval.id}`);
    await expect(
      app.services.approvals.resolve({ approvalId: approval.id, decision: "deny", userId: jun.id }),
    ).rejects.toMatchObject({ body: { code: "FORBIDDEN" } });
  });

  it("그룹 DM 의 에이전트 정본은 사람 참여자 전원에게, run_error·승인 요청 푸시는 시킨 사람에게만", async () => {
    const { approval, mia, jun, dev, group, conversationId, run } = await groupApproval("plugin");
    // 승인 요청 — 승인을 만든 그 자리에서 이미 발송됐다
    await vi.waitFor(() => expect(sentTo(jun).some((s) => s.payload.kind === "approval")).toBe(true));
    expect(sentTo(mia).filter((s) => s.payload.kind === "approval")).toEqual([]);
    expect(sentTo(owner).filter((s) => s.payload.tag === `approval:${approval.id}`)).toEqual([]);
    sent = [];
    createSystemMessage(app.db, app.bus, {
      conversationId,
      kind: "run_error",
      bodyMd: "실패",
      systemMeta: { kind: "run_error", runId: run.id },
    });
    await vi.waitFor(() => expect(sentTo(jun)).toHaveLength(1));
    expect(sentTo(jun)[0]?.payload).toMatchObject({
      kind: "mention",
      channelId: group.id,
      title: `@${dev.handle}${josa(dev.handle, "이", "가")} 답했습니다`,
      body: "DM",
      tag: `direct:${conversationId}`,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(sentTo(mia)).toEqual([]);
    sent = [];
    createAgentMessage(app.db, app.bus, {
      conversationId,
      agentId: dev.id,
      runId: run.id,
      bodyMd: "답입니다",
      externalId: `dx-answer-${++n}`,
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.endpoint).sort()).toEqual([endpointOf(mia), endpointOf(jun)].sort());
    for (const { payload } of sent)
      expect(payload.title).toBe(`@${dev.handle}${josa(dev.handle, "이", "가")} 답했습니다`);
  });

  it("에이전트가 받는 것 — groupDm 표시, 참여자는 활성 참여자 전부, 채널 지시 없음", async () => {
    const mia = await person();
    const jun = await person();
    const kai = await person();
    const dev = await agentWith("everyone");
    const group = await open(mia, { userIds: [jun.id, kai.id], agentIds: [dev.id] });
    setDeactivated(kai, true);
    try {
      const { conversationId } = await groupSession(mia, group, `@${dev.handle} 안녕`);
      await vi.waitFor(() =>
        expect(adapter.calls.send.some((c) => c.conversationId === conversationId)).toBe(true),
      );
      const deliver = adapter.calls.send.find((c) => c.conversationId === conversationId);
      expect(deliver?.groupDm).toBe(true);
      expect(deliver?.dm).toBeUndefined();
      expect(deliver?.context.channelPrompt).toBeUndefined();
      expect(deliver?.context.participants.map((p) => p.handle).sort()).toEqual(
        [mia.handle, jun.handle, dev.handle].sort(),
      );
    } finally {
      setDeactivated(kai, false);
    }
  });
});
