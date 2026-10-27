/**
 * 에이전트 DM 만들기·목록·런(에이전트 DM 계획 태스크 3) — 실제 서버(FakeAdapter)에 owner·admin·member 둘(mia·bob)을 붙여 REST·wire 로
 * 본다. 접근 판정(남의 DM 404)은 roles.matrix 「남의 DM — DM_CASES」, 팬아웃은 realtime.dm-fanout 이 본다 — 여기는 주인 쪽 동작이다
 */
import type { ProviderApproval } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import {
  type Agent,
  type Channel,
  type DmAccess,
  type DmSummary,
  type Message,
  PushPayload,
  type TeamRole,
  type UnreadSnapshot,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App, AppDeps } from "../src/app";
import {
  channelMembers,
  channels,
  conversations,
  memberships,
  messages,
  opsEvents,
  runs,
} from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import * as approvalStore from "../src/modules/approvals/store";
import { createAgentMessage, createSystemMessage } from "../src/modules/messages/service";
import { patchOpsSettings } from "../src/modules/ops/settings";
import { countRunsTodayInWorkspace, insertRun } from "../src/modules/runs/store";
import { josa } from "../src/util/josa";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { makePng } from "./helpers/png";
import { connectWire, recordEvents, type WireClient } from "./helpers/wire";

vi.setConfig({ testTimeout: 15_000 });

type Who = TeamRole | "mia" | "bob";
const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
type Ack<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

describe("에이전트 DM — 만들기·목록·런(서버)", () => {
  let app: App;
  let adapter: FakeAdapter;
  const tokens = {} as Record<Who, string>;
  const ids = {} as Record<Who, string>;
  const sockets: WireClient[] = [];
  let sent: Array<{ endpoint: string; payload: PushPayload }> = [];
  let n = 0;

  const pushSend: NonNullable<AppDeps["pushSend"]> = async (sub, body) => {
    sent.push({ endpoint: sub.endpoint, payload: PushPayload.parse(JSON.parse(body)) });
    return { statusCode: 201 };
  };
  const endpointOf = (who: Who) => `https://push.invalid/${who}`;

  beforeAll(async () => {
    adapter = new FakeAdapter();
    app = await bootTestApp({}, { adapters: [adapter], pushSend });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    tokens.owner = (await login(app)).token;
    ids.owner = app.ownerUserId;
    for (const [who, role] of [
      ["admin", "admin"],
      ["member", "member"],
      ["mia", "member"],
      ["bob", "member"],
    ] as const) {
      const user = await userWithRole(app, `dm-${who}`, role);
      tokens[who] = user.token;
      ids[who] = user.id;
    }
    for (const who of Object.keys(tokens) as Who[]) {
      const res = await rest(who, "POST", "/api/v1/push/subscriptions", {
        endpoint: endpointOf(who),
        keys: KEYS,
      });
      expect(res.statusCode, res.body).toBe(204);
    }
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
    patchOpsSettings(app.db, app.workspaceId, { dailyRunLimit: null });
  });
  afterAll(async () => {
    await app.close();
  });

  function rest(who: Who, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
    return app.fastify.inject({
      method,
      url,
      headers: { authorization: `Bearer ${tokens[who]}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  }
  async function wire(who: Who): Promise<WireClient> {
    const socket = await connectWire(app, tokens[who]);
    sockets.push(socket);
    return socket;
  }
  /** dmAccess 를 준 새 에이전트 — 바꾸기는 REST PATCH(admin 이상)로 */
  async function agentWith(dmAccess: DmAccess): Promise<Agent> {
    const agent = createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: `dmag${++n}`,
      handle: `dmag${n}`,
      name: `dmag${n}`,
    });
    if (dmAccess === "admins") return agent;
    const res = await rest("owner", "PATCH", `/api/v1/agents/${agent.id}`, { dmAccess });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { agent: Agent }).agent;
  }
  async function openDm(who: Who, agentId: string): Promise<Channel> {
    const res = await rest(who, "POST", "/api/v1/dms", { agentId });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { channel: Channel }).channel;
  }
  function send(
    socket: WireClient,
    body: { channelId: string; conversationId?: string; bodyMd?: string; threadRootId?: string },
  ) {
    return socket.emitWithAck("message.send", {
      clientMsgId: `dm-send-${++n}`,
      bodyMd: "안녕",
      ...(body.conversationId === undefined ? { newConversation: {} } : {}),
      ...body,
    }) as Promise<Ack<{ message: Message; conversation?: { id: string } }>>;
  }
  async function sent1(socket: WireClient, channelId: string, bodyMd = "안녕") {
    const res = await send(socket, { channelId, bodyMd });
    if (!res.ok) throw new Error(JSON.stringify(res));
    return res.data;
  }
  const runsOf = (channelId: string) => app.db.select().from(runs).where(eq(runs.channelId, channelId)).all();
  const membersOf = (channelId: string) =>
    app.db.select().from(channelMembers).where(eq(channelMembers.channelId, channelId)).all();
  const setRole = (who: Who, role: TeamRole) =>
    app.db
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.workspaceId, app.workspaceId), eq(memberships.userId, ids[who])))
      .run();

  // ── 만들기(Step 1·2) ──────────────────────────────────────────

  const ALLOW: Record<DmAccess, Record<TeamRole, number>> = {
    off: { owner: 403, admin: 403, member: 403 },
    admins: { owner: 200, admin: 200, member: 403 },
    everyone: { owner: 200, admin: 200, member: 200 },
  };
  it.each(
    (Object.keys(ALLOW) as DmAccess[]).flatMap((access) =>
      (["owner", "admin", "member"] as const).map((role) => [access, role, ALLOW[access][role]] as const),
    ),
  )("POST /dms — dmAccess %s 에 %s 는 %d", async (access, role, status) => {
    const agent = await agentWith(access);
    const res = await rest(role, "POST", "/api/v1/dms", { agentId: agent.id });
    expect(res.statusCode, res.body).toBe(status);
    if (status === 403) {
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
      expect(app.db.select().from(channels).where(eq(channels.dmAgentId, agent.id)).all()).toEqual([]);
    }
  });

  it("보관·꺼진 에이전트와는 dmAccess 와 무관하게 새 DM 을 열지 못한다(403), 없는 에이전트는 404", async () => {
    const archived = await agentWith("everyone");
    expect((await rest("owner", "DELETE", `/api/v1/agents/${archived.id}`)).statusCode).toBe(200);
    const disabled = await agentWith("everyone");
    expect(
      (await rest("owner", "PATCH", `/api/v1/agents/${disabled.id}`, { enabled: false })).statusCode,
    ).toBe(200);
    for (const agent of [archived, disabled]) {
      const res = await rest("owner", "POST", "/api/v1/dms", { agentId: agent.id });
      expect(res.statusCode, res.body).toBe(403);
    }
    const missing = await rest("owner", "POST", "/api/v1/dms", { agentId: uuid() });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("동시 두 POST /dms 는 채널 행 하나·같은 id, 다시 불러도 같은 채널 — 멤버는 주인·에이전트 둘뿐, 세션은 없다", async () => {
    const agent = await agentWith("everyone");
    const [a, b] = await Promise.all([
      rest("mia", "POST", "/api/v1/dms", { agentId: agent.id }),
      rest("mia", "POST", "/api/v1/dms", { agentId: agent.id }),
    ]);
    const first = (a.json() as { channel: Channel }).channel;
    expect((b.json() as { channel: Channel }).channel.id).toBe(first.id);
    expect((await openDm("mia", agent.id)).id).toBe(first.id);
    expect(app.db.select().from(channels).where(eq(channels.dmAgentId, agent.id)).all()).toHaveLength(1);
    expect(first).toMatchObject({
      kind: "dm",
      dmOwnerId: ids.mia,
      dmAgentId: agent.id,
      name: "dm",
      visibility: "private",
      createdBy: ids.mia,
      sessionPolicy: { create: "members" },
      relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
      archivedAt: null,
    });
    expect(
      membersOf(first.id)
        .map((m) => ({ type: m.memberType, id: m.memberId, role: m.role, autoRespond: m.autoRespond }))
        .sort((x, y) => x.type.localeCompare(y.type)),
    ).toEqual([
      { type: "agent", id: agent.id, role: null, autoRespond: true },
      { type: "user", id: ids.mia, role: "member", autoRespond: false },
    ]);
    expect(app.db.select().from(conversations).where(eq(conversations.channelId, first.id)).all()).toEqual(
      [],
    );
  });

  it("처음 만들 때만 channel.created — 주인에게만, 다시 열면 내지 않는다", async () => {
    const agent = await agentWith("everyone");
    const mia = recordEvents(await wire("mia"), ["channel.created"]);
    const owner = recordEvents(await wire("owner"), ["channel.created"]);
    const channel = await openDm("mia", agent.id);
    await vi.waitFor(() => expect(mia).toHaveLength(1));
    await openDm("mia", agent.id);
    // 다른 이벤트가 닿을 왕복 — 같은 연결의 ack 뒤에는 앞의 팬아웃이 와 있다
    await sockets[0]?.emitWithAck("channel.unsubscribe", { channelId: uuid() });
    await sockets[1]?.emitWithAck("channel.unsubscribe", { channelId: uuid() });
    expect(mia.map((e) => (e.payload as { channel: Channel }).channel.id)).toEqual([channel.id]);
    expect(owner).toEqual([]);
  });

  it("GET /dms — 내 DM 만, 최근 활동순(글이 없으면 연 시각), lastMessageAt·readOnlyReason", async () => {
    const a = await agentWith("everyone");
    const b = await agentWith("everyone");
    const dmA = await openDm("bob", a.id);
    const dmB = await openDm("bob", b.id);
    await openDm("mia", a.id); // 남의 DM — bob 의 목록에 없다
    const list = async () => {
      const res = await rest("bob", "GET", "/api/v1/dms");
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { dms: DmSummary[] }).dms;
    };
    // 글이 없으면 연 시각 — 나중에 연 B 가 앞
    let dms = await list();
    expect(dms.map((d) => d.channel.id)).toEqual([dmB.id, dmA.id]);
    expect(dms[0]).toMatchObject({ lastMessageAt: null, readOnlyReason: null, agent: { id: b.id } });
    const socket = await wire("bob");
    await sent1(socket, dmA.id);
    dms = await list();
    expect(dms.map((d) => d.channel.id)).toEqual([dmA.id, dmB.id]);
    expect(dms[0]?.lastMessageAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    await sent1(socket, dmB.id);
    expect((await list()).map((d) => d.channel.id)).toEqual([dmB.id, dmA.id]);
    expect((await list()).every((d) => d.channel.dmOwnerId === ids.bob)).toBe(true);
  });

  it("이미 있는 DM 은 에이전트를 보관한 뒤에도 POST /dms 가 그 채널을 준다 — 기록은 주인이 계속 읽는다", async () => {
    const agent = await agentWith("everyone");
    const dm = await openDm("bob", agent.id);
    expect((await rest("owner", "DELETE", `/api/v1/agents/${agent.id}`)).statusCode).toBe(200);
    expect((await openDm("bob", agent.id)).id).toBe(dm.id);
  });

  it("PATCH /agents/:id {dmAccess} 는 admin 이상 — member 는 403, 값이 응답·목록에 실린다", async () => {
    const agent = await agentWith("admins");
    expect(
      (await rest("member", "PATCH", `/api/v1/agents/${agent.id}`, { dmAccess: "everyone" })).statusCode,
    ).toBe(403);
    const res = await rest("admin", "PATCH", `/api/v1/agents/${agent.id}`, { dmAccess: "off" });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { agent: Agent }).agent.dmAccess).toBe("off");
    const listed = (await rest("member", "GET", "/api/v1/agents")).json() as { agents: Agent[] };
    expect(listed.agents.find((a) => a.id === agent.id)?.dmAccess).toBe("off");
    const bad = await rest("admin", "PATCH", `/api/v1/agents/${agent.id}`, { dmAccess: "all" });
    expect(bad.statusCode).toBe(400);
  });

  // ── 읽기 전용(Step 3·4 — Review Focus 3·4) ─────────────────────

  it("주인이 admin → member 로 강등되면(dmAccess admins) 읽기는 되고 쓰기는 409 DM_READ_ONLY dm_not_allowed, 되돌리면 이어 쓴다", async () => {
    const amy = await userWithRole(app, `dm-amy${++n}`, "admin");
    const agent = await agentWith("admins");
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/dms",
      headers: { authorization: `Bearer ${amy.token}` },
      payload: { agentId: agent.id },
    });
    const dm = (res.json() as { channel: Channel }).channel;
    const socket = await connectWire(app, amy.token);
    sockets.push(socket);
    const first = await sent1(socket, dm.id);
    const demote = (role: TeamRole) =>
      app.db
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.workspaceId, app.workspaceId), eq(memberships.userId, amy.id)))
        .run();
    demote("member");
    const get = (url: string) =>
      app.fastify.inject({ method: "GET", url, headers: { authorization: `Bearer ${amy.token}` } });
    expect((await get(`/api/v1/channels/${dm.id}`)).statusCode).toBe(200);
    expect((await get(`/api/v1/conversations/${first.message.conversationId}/messages`)).statusCode).toBe(
      200,
    );
    const blocked = await send(socket, {
      channelId: dm.id,
      conversationId: first.message.conversationId,
    });
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: "DM_READ_ONLY", details: { reason: "dm_not_allowed" } },
    });
    const listed = (await get("/api/v1/dms")).json() as { dms: DmSummary[] };
    expect(listed.dms.find((d) => d.channel.id === dm.id)?.readOnlyReason).toBe("dm_not_allowed");
    demote("admin");
    expect(
      await send(socket, { channelId: dm.id, conversationId: first.message.conversationId }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("보관 → agent_archived, 꺼짐 → agent_disabled(둘 다면 보관이 먼저) — GET /dms 도 같은 사유, 다시 켜면 이어 쓴다", async () => {
    const agent = await agentWith("everyone");
    const dm = await openDm("bob", agent.id);
    const socket = await wire("bob");
    const first = await sent1(socket, dm.id);
    const reasonOf = async () =>
      ((await rest("bob", "GET", "/api/v1/dms")).json() as { dms: DmSummary[] }).dms.find(
        (d) => d.channel.id === dm.id,
      )?.readOnlyReason;
    const trySend = () => send(socket, { channelId: dm.id, conversationId: first.message.conversationId });

    expect((await rest("owner", "PATCH", `/api/v1/agents/${agent.id}`, { enabled: false })).statusCode).toBe(
      200,
    );
    expect(await trySend()).toMatchObject({
      ok: false,
      error: {
        code: "DM_READ_ONLY",
        message: "꺼진 에이전트라 읽기만 할 수 있습니다",
        details: { reason: "agent_disabled" },
      },
    });
    expect(await reasonOf()).toBe("agent_disabled");
    expect((await rest("owner", "DELETE", `/api/v1/agents/${agent.id}`)).statusCode).toBe(200);
    expect(await trySend()).toMatchObject({ ok: false, error: { details: { reason: "agent_archived" } } });
    expect(await reasonOf()).toBe("agent_archived");
    expect((await rest("owner", "POST", `/api/v1/agents/${agent.id}/restore`)).statusCode).toBe(200);
    expect((await rest("owner", "PATCH", `/api/v1/agents/${agent.id}`, { enabled: true })).statusCode).toBe(
      200,
    );
    expect(await reasonOf()).toBeNull();
    expect(await trySend()).toMatchObject({ ok: true });
  });

  it.each([
    ["dmAccess 철회", "dm_not_allowed", { dmAccess: "admins" }],
    ["꺼짐", "agent_disabled", { enabled: false }],
    ["사유 없음", null, { name: "그대로" }],
  ] as const)(
    "읽기 전용 전에 줄 선 런 — %s 뒤 차례가 오면 사유가 있으면 어댑터로 가지 않고 중지로 닫힌다(돌던 런은 그대로)",
    async (_label, reason, patch) => {
      const agent = await agentWith("everyone");
      const dm = await openDm("mia", agent.id);
      const socket = await wire("mia");
      const first = await sent1(socket, dm.id);
      await vi.waitFor(() => expect(runsOf(dm.id)).toHaveLength(1));
      const running = runsOf(dm.id)[0];
      if (!running) throw new Error("런이 없다");
      await vi.waitFor(() => expect(adapter.calls.send.some((c) => c.runId === running.id)).toBe(true));
      const second = await send(socket, {
        channelId: dm.id,
        conversationId: first.message.conversationId,
        bodyMd: "하나 더",
      });
      expect(second).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(runsOf(dm.id)).toHaveLength(2));
      const queued = runsOf(dm.id).find((r) => r.id !== running.id);
      if (!queued) throw new Error("줄 선 런이 없다");
      expect(queued.status).toBe("queued");

      const res = await rest("owner", "PATCH", `/api/v1/agents/${agent.id}`, patch);
      expect(res.statusCode, res.body).toBe(200);
      const statusOf = (id: string) => runsOf(dm.id).find((r) => r.id === id)?.status;
      // 어댑터로 간 런은 끄기·철회로 멈추지 않는다(ack 전이라 아직 queued)
      expect(statusOf(running.id)).toBe("queued");
      adapter.emit({ kind: "run_signal", runId: running.id, signal: { kind: "gateway_aborted" } });
      if (reason === null) {
        await vi.waitFor(() => expect(adapter.calls.send.some((c) => c.runId === queued.id)).toBe(true));
        expect(statusOf(queued.id)).toBe("queued");
        return;
      }
      await vi.waitFor(() => expect(statusOf(queued.id)).toBe("aborted"));
      expect(adapter.calls.send.some((c) => c.runId === queued.id)).toBe(false);
      // 닫는 꼴은 보관한 에이전트·닫힌 세션과 같다 — 시스템 메시지(run_error)는 남기지 않는다
      expect(
        app.db
          .select()
          .from(messages)
          .where(and(eq(messages.channelId, dm.id), eq(messages.kind, "system")))
          .all(),
      ).toEqual([]);
    },
  );

  it("읽기 전용 DM 의 다른 쓰기 — 리액션·카드·첨부 올리기·지시 바꾸기도 409 DM_READ_ONLY", async () => {
    const agent = await agentWith("everyone");
    const dm = await openDm("bob", agent.id);
    const socket = await wire("bob");
    const { message } = await sent1(socket, dm.id);
    const run = insertRun(app.db, {
      channelId: dm.id,
      conversationId: message.conversationId,
      agentId: agent.id,
      triggerKind: "auto_respond",
      triggerMessageId: message.id,
      rootMessageId: message.id,
      relayDepth: 0,
      sessionKey: adapter.sessionKeyFor(agent.providerAgentId, message.conversationId),
      connectionId: FAKE_GATEWAY_ID,
      requestedBy: ids.bob,
      createdAt: new Date(),
    });
    const card = createAgentMessage(app.db, app.bus, {
      conversationId: message.conversationId,
      agentId: agent.id,
      runId: run.id,
      bodyMd: "골라 주세요",
      externalId: `dm-card-${++n}`,
      components: {
        blocks: [{ type: "actions", id: "row", items: [{ type: "button", id: "go", label: "진행" }] }],
      },
    });
    expect((await rest("owner", "PATCH", `/api/v1/agents/${agent.id}`, { dmAccess: "off" })).statusCode).toBe(
      200,
    );
    const readOnly = { ok: false, error: { code: "DM_READ_ONLY", details: { reason: "dm_not_allowed" } } };
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
      url: `/api/v1/attachments?channelId=${dm.id}`,
      headers: { authorization: `Bearer ${tokens.bob}`, "content-type": "image/png" },
      payload: makePng(2, 2),
    });
    expect(upload.statusCode, upload.body).toBe(409);
    expect(upload.json()).toMatchObject({ code: "DM_READ_ONLY", details: { reason: "dm_not_allowed" } });
    const prompt = await rest("bob", "PATCH", `/api/v1/channels/${dm.id}`, { prompt: "짧게" });
    expect(prompt.statusCode, prompt.body).toBe(409);
    expect(prompt.json()).toMatchObject({ code: "DM_READ_ONLY" });
  });

  // ── 런·멘션(Step 5·6 — PD6, Review Focus 5) ──────────────────────

  it("DM 의 사람 글은 멘션과 무관하게 그 에이전트 런 하나 — @에이전트·@사람·토큰 꼴은 평문, 멘션 사람은 참여·푸시 없음", async () => {
    const agent = await agentWith("everyone");
    const other = await agentWith("everyone");
    const dm = await openDm("mia", agent.id);
    const socket = await wire("mia");
    sent = [];
    const body = `@${agent.handle} @${other.handle} @dm-bob 보세요 <@u:${ids.bob}> <@a:${other.id}>`;
    const { message } = await sent1(socket, dm.id, body);
    expect(message.mentions).toEqual({ users: [], agents: [] });
    expect(message.bodyMd).toContain(`@${agent.handle} @${other.handle} @dm-bob 보세요`);
    expect(message.bodyMd).not.toMatch(/<@[au]:/);
    await vi.waitFor(() => expect(runsOf(dm.id)).toHaveLength(1));
    expect(runsOf(dm.id)[0]).toMatchObject({ agentId: agent.id, triggerKind: "auto_respond" });
    expect(
      membersOf(dm.id)
        .map((m) => m.memberId)
        .sort(),
    ).toEqual([agent.id, ids.mia].sort());
    expect(sent.filter((s) => s.endpoint === endpointOf("bob"))).toEqual([]);
  });

  it("DM 에이전트의 정본에 @사람·@에이전트 — 평문, 그 사람은 참여·멘션 푸시 없고 다른 에이전트로 릴레이도 없다", async () => {
    const agent = await agentWith("everyone");
    const other = await agentWith("everyone");
    const dm = await openDm("mia", agent.id);
    const socket = await wire("mia");
    const { message } = await sent1(socket, dm.id);
    await vi.waitFor(() => expect(runsOf(dm.id)).toHaveLength(1));
    const run = runsOf(dm.id)[0];
    if (!run) throw new Error("런이 없다");
    sent = [];
    const answer = createAgentMessage(app.db, app.bus, {
      conversationId: message.conversationId,
      agentId: agent.id,
      runId: run.id,
      bodyMd: `@dm-bob 님께 물어보고 @${other.handle} 에게 넘길게요 <@u:${ids.bob}>`,
      externalId: `dm-answer-${++n}`,
    });
    expect(answer.mentions).toEqual({ users: [], agents: [] });
    expect(answer.bodyMd).toContain("@dm-bob 님께");
    await app.services.router.routeMessage(answer);
    expect(runsOf(dm.id)).toHaveLength(1);
    expect(membersOf(dm.id)).toHaveLength(2);
    // 발송은 비동기다 — 같은 정본의 주인 푸시가 나간 뒤에 bob 몫을 센다
    await vi.waitFor(() => expect(sent.filter((s) => s.endpoint === endpointOf("mia"))).toHaveLength(1));
    expect(sent.filter((s) => s.endpoint === endpointOf("bob"))).toEqual([]);
  });

  it("DM 에 스레드 답글은 VALIDATION", async () => {
    const agent = await agentWith("everyone");
    const dm = await openDm("mia", agent.id);
    const socket = await wire("mia");
    const { message } = await sent1(socket, dm.id);
    expect(
      await send(socket, {
        channelId: dm.id,
        conversationId: message.conversationId,
        threadRootId: message.id,
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION", message: "DM 에는 스레드가 없다" } });
  });

  it("DM 에는 채널 dailyRunLimit 을 걸지 않는다 — DB 에 있어도 무시, 워크스페이스 상한만 세고 run_limit key 에 그 DM id 가 없다", async () => {
    const agent = await agentWith("everyone");
    const dm = await openDm("mia", agent.id);
    app.db
      .update(channels)
      .set({ relayPolicy: { maxRelayTurns: 4, allowPairs: "all", dailyRunLimit: 1 } })
      .where(eq(channels.id, dm.id))
      .run();
    const socket = await wire("mia");
    const { message } = await sent1(socket, dm.id);
    await send(socket, { channelId: dm.id, conversationId: message.conversationId, bodyMd: "둘째" });
    await vi.waitFor(() => expect(runsOf(dm.id)).toHaveLength(2));
    // 워크스페이스 상한 — 지금까지 센 수로 막는다
    patchOpsSettings(app.db, app.workspaceId, {
      dailyRunLimit: countRunsTodayInWorkspace(app.db, new Date()),
    });
    await send(socket, { channelId: dm.id, conversationId: message.conversationId, bodyMd: "셋째" });
    await vi.waitFor(() =>
      expect(
        app.db
          .select()
          .from(opsEvents)
          .all()
          .some((e) => e.kind === "run_limit" && e.key === "workspace"),
      ).toBe(true),
    );
    expect(runsOf(dm.id)).toHaveLength(2);
    expect(
      app.db
        .select()
        .from(opsEvents)
        .all()
        .filter((e) => e.key === `channel:${dm.id}`),
    ).toEqual([]);
  });

  // ── 관리 경로(Step 7·8 — PD9) ─────────────────────────────────

  it("DM 의 PATCH /channels/:id 는 {prompt} 만 — member 주인도 200·promptRevision +1, 다른 키가 섞이면 VALIDATION", async () => {
    const agent = await agentWith("everyone");
    const dm = await openDm("mia", agent.id);
    const before = (await rest("mia", "GET", `/api/v1/channels/${dm.id}`)).json() as {
      channel: Channel & { promptRevision: number };
    };
    const ok = await rest("mia", "PATCH", `/api/v1/channels/${dm.id}`, { prompt: "짧게 답해" });
    expect(ok.statusCode, ok.body).toBe(200);
    const after = (ok.json() as { channel: Channel & { promptRevision: number } }).channel;
    expect(after.prompt).toBe("짧게 답해");
    expect(after.promptRevision).toBe(before.channel.promptRevision + 1);
    for (const payload of [
      { prompt: "x", name: "새이름" },
      { name: "새이름" },
      { topic: "주제" },
      { sessionPolicy: { create: "managers" } },
      { relayPolicy: { maxRelayTurns: 4, allowPairs: "all", dailyRunLimit: 3 } },
      { visibility: "public" },
    ]) {
      const res = await rest("mia", "PATCH", `/api/v1/channels/${dm.id}`, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION" });
    }
    expect(
      ((await rest("mia", "GET", `/api/v1/channels/${dm.id}`)).json() as { channel: Channel }).channel,
    ).toMatchObject({
      name: "dm",
      prompt: "짧게 답해",
    });
  });

  it("DM 의 제어 쓰기는 VALIDATION 이고 운영 사건 control_change 가 생기지 않는다", async () => {
    const agent = await agentWith("everyone");
    const dm = await openDm("mia", agent.id);
    setRole("mia", "admin"); // 역할 정책을 넘어서도 VALIDATION 인지
    try {
      for (const [tool, args] of [
        ["update_channel", { channelId: dm.id, topic: "주제" }],
        ["set_channel_prompt", { channelId: dm.id, prompt: "몰래" }],
        ["set_channel_run_limit", { channelId: dm.id, dailyRunLimit: 3 }],
      ] as const) {
        expect(await app.control.call({ userId: ids.mia, via: "pat" }, tool, args)).toMatchObject({
          ok: false,
          error: { code: "VALIDATION" },
        });
      }
    } finally {
      setRole("mia", "member");
    }
    expect(
      app.db
        .select()
        .from(opsEvents)
        .all()
        .filter((e) => e.kind === "control_change" && e.key.endsWith(`:${ids.mia}`)),
    ).toEqual([]);
  });

  // ── 승인(Step 9·10 — PD7) ─────────────────────────────────────

  async function dmToolApproval() {
    const agent = await agentWith("everyone");
    const dm = await openDm("mia", agent.id);
    const socket = await wire("mia");
    const { message } = await sent1(socket, dm.id);
    const frame: ProviderApproval = {
      providerApprovalId: `plugin:${uuid()}`,
      kind: "plugin",
      sessionKey: adapter.sessionKeyFor(agent.providerAgentId, message.conversationId),
      providerAgentId: agent.providerAgentId,
      conversationId: message.conversationId,
      toolCallId: `toolu_${++n}`,
      toolName: "Write",
      pluginId: "fs",
      title: "Write 실행",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    };
    adapter.emitApproval(frame);
    await vi.waitFor(() =>
      expect(approvalStore.getApprovalByProviderId(app.db, frame.providerApprovalId)?.status).toBe("pending"),
    );
    const approval = approvalStore.getApprovalByProviderId(app.db, frame.providerApprovalId);
    if (!approval) throw new Error("승인이 저장되지 않았다");
    return { approval, socket };
  }

  it("승인 서비스도 DM 의 승인은 주인 말고는 없는 승인과 같다 — wire 앞단을 거치지 않는 호출에도(owner 여도)", async () => {
    const { approval } = await dmToolApproval();
    const sentBefore = adapter.calls.resolveApproval.length;
    await expect(
      app.services.approvals.resolve({ approvalId: approval.id, decision: "deny", userId: ids.owner }),
    ).rejects.toMatchObject({ body: { code: "NOT_FOUND", message: "approval not found" } });
    expect(adapter.calls.resolveApproval.length).toBe(sentBefore);
    expect(approvalStore.getApproval(app.db, approval.id)?.status).toBe("pending");
  });

  it("member 주인이 DM 런의 도구 승인을 결정한다 — decidedBy 가 주인, 어댑터로 결정이 간다", async () => {
    const { approval, socket } = await dmToolApproval();
    const sentBefore = adapter.calls.resolveApproval.length;
    expect(
      await socket.emitWithAck("approval.resolve", { approvalId: approval.id, decision: "deny" }),
    ).toMatchObject({
      ok: true,
    });
    expect(adapter.calls.resolveApproval.length).toBe(sentBefore + 1);
    expect(approvalStore.getApproval(app.db, approval.id)).toMatchObject({
      status: "denied",
      decidedBy: ids.mia,
    });
  });

  // ── 읽지 않음·푸시(Step 11·12 — PD10·PD11) ──────────────────────

  async function dmWithRun(who: Who) {
    const agent = await agentWith("everyone");
    const dm = await openDm(who, agent.id);
    const socket = await wire(who);
    const { message } = await sent1(socket, dm.id);
    await vi.waitFor(() => expect(runsOf(dm.id)).toHaveLength(1));
    const run = runsOf(dm.id)[0];
    if (!run) throw new Error("런이 없다");
    const answer = (bodyMd = "답") =>
      createAgentMessage(app.db, app.bus, {
        conversationId: message.conversationId,
        agentId: agent.id,
        runId: run.id,
        bodyMd,
        externalId: `dm-reply-${++n}`,
      });
    return { agent, dm, socket, conversationId: message.conversationId, run, answer };
  }

  it("DM 에이전트의 보통 메시지는 모두 주인의 「멘션」 배지로 센다", async () => {
    const d = await dmWithRun("mia");
    for (let i = 0; i < 3; i++) d.answer(`답 ${i}`);
    const snap = (await rest("mia", "GET", "/api/v1/me/unread")).json() as UnreadSnapshot;
    expect(snap.conversations.find((c) => c.conversationId === d.conversationId)).toMatchObject({
      unread: true,
      mentions: 3,
    });
  });

  it("DM 정본·run_error 는 주인 기기로만 푸시 — 제목 「@핸들이 답했습니다」, 본문 「DM」, tag dm:<세션>", async () => {
    const d = await dmWithRun("mia");
    sent = [];
    d.answer();
    createSystemMessage(app.db, app.bus, {
      conversationId: d.conversationId,
      kind: "run_error",
      bodyMd: "실패",
      systemMeta: { kind: "run_error", runId: d.run.id },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => s.endpoint)).toEqual([endpointOf("mia"), endpointOf("mia")]);
    for (const { payload } of sent) {
      expect(payload).toEqual({
        kind: "mention",
        channelId: d.dm.id,
        title: `@${d.agent.handle}${josa(d.agent.handle, "이", "가")} 답했습니다`,
        body: "DM",
        url: `/c/${d.dm.id}/s/${d.conversationId}`,
        tag: `dm:${d.conversationId}`,
      });
    }
    // 사람의 글·다른 시스템 메시지는 알리지 않는다
    sent = [];
    createSystemMessage(app.db, app.bus, {
      conversationId: d.conversationId,
      kind: "info",
      bodyMd: "알림",
      systemMeta: { kind: "info" },
    });
    await d.socket.emitWithAck("message.send", {
      channelId: d.dm.id,
      conversationId: d.conversationId,
      clientMsgId: `dm-more-${++n}`,
      bodyMd: "또",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toEqual([]);
  });

  it("주인이 그 세션을 보고 있으면 DM 푸시를 거른다(지금 규칙 — 세션 단위)", async () => {
    const d = await dmWithRun("mia");
    // presence.update 는 ack 가 없다 — 같은 연결의 ack 왕복으로 처리된 뒤를 기다린다
    const roundTrip = () => d.socket.emitWithAck("channel.unsubscribe", { channelId: uuid() });
    d.socket.emit("presence.update", { visible: true, channelId: d.dm.id, conversationId: d.conversationId });
    await roundTrip();
    sent = [];
    d.answer();
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toEqual([]);
    d.socket.emit("presence.update", { visible: false });
    await roundTrip();
    d.answer();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });
});
