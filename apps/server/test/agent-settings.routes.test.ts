/**
 * 러너 에이전트의 세션 설정 REST·wire(세션 설정 스펙 5.2·5.3) — 권한(S2)·러너 상한·남의 DM·OpenClaw·wire 알림·컨텍스트 %(S7·S9),
 * 그리고 새 세션 첫 글의 agentSettings(S11, Review Focus 1·2). 역할 매트릭스의 전수는 roles.matrix.test.ts
 */
import type {
  AgentSettingsEntry,
  ConversationAgentSettings,
  Conversation,
  RunnerPermissionMode,
} from "@dodok/shared";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { conversationAgentSettings, conversations, runs } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage } from "../src/modules/messages/service";
import { issueRunnerToken } from "../src/modules/runners/tokens";
import { insertRun } from "../src/modules/runs/store";
import { FAKE_CLAUDE_PROGRAM, type FakeRunner, startFakeRunner } from "./fakes/fake-runner";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { createDmChannelForTest, createRunnerAgentForTest, seedConversation } from "./helpers/seed";
import { connectWire, waitFor, type WireClient } from "./helpers/wire";

describe("세션 설정 REST·첫 글 [세션 설정 스펙 5.2·5.3]", () => {
  let app: App;
  let owner: string;
  const admin = { id: "", token: "" };
  const mia = { id: "", token: "" };
  const noah = { id: "", token: "" };
  const fakeRunners: FakeRunner[] = [];
  const sockets: WireClient[] = [];
  /** 주인 없는 러너(상한 acceptEdits), mia 의 러너(상한 acceptEdits), 상한 default 인 러너 */
  const runner = { open: "", mine: "", low: "" };
  let n = 0;

  beforeAll(async () => {
    app = await bootTestApp({}, { adapters: [new FakeAdapter()], runnerAdapter: true });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    owner = (await login(app)).token;
    Object.assign(admin, await userWithRole(app, "ada", "admin"));
    Object.assign(mia, await userWithRole(app, "mia", "member"));
    Object.assign(noah, await userWithRole(app, "noah", "member"));
    const connect = async (label: string, ownerId: string | null, max: RunnerPermissionMode) => {
      const issued = issueRunnerToken(app.db, app.workspaceId, label, ownerId);
      fakeRunners.push(
        await startFakeRunner({
          url: app.url,
          token: issued.token,
          hello: {
            programs: [
              { ...FAKE_CLAUDE_PROGRAM, ceiling: { maxPermissionMode: max, allowedToolsCeiling: null } },
            ],
          },
        }),
      );
      return issued.record.id;
    };
    runner.open = await connect("open", null, "acceptEdits");
    runner.mine = await connect("mine", mia.id, "acceptEdits");
    runner.low = await connect("low", null, "default");
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    for (const r of fakeRunners.splice(0)) r.close();
    await app.close();
  });

  const call = (token: string, method: "GET" | "PATCH", url: string, payload?: object) =>
    app.fastify.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
  /** 러너 에이전트 하나가 든 새 채널과 그 대화 */
  const setup = (runnerTokenId = runner.open) => {
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: `as${++n}`,
    });
    const { agent } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: `rn${n}`,
      runnerTokenId,
    });
    addMember(app.db, channel.id, { memberType: "agent", memberId: agent.id }, app.logger);
    const conversationId = seedConversation(app.db, channel.id);
    return { channel, agent, conversationId };
  };
  const patch = (token: string, conversationId: string, agentId: string, body: object) =>
    call(token, "PATCH", `/api/v1/conversations/${conversationId}/agent-settings/${agentId}`, body);
  const settingsOf = async (token: string, conversationId: string, query = "") => {
    const res = await call(token, "GET", `/api/v1/conversations/${conversationId}/agent-settings${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { settings: ConversationAgentSettings[] }).settings;
  };

  describe("PATCH 권한 [S2]", () => {
    it.each([
      [{ permissionMode: "plan" }],
      [{ permissionMode: "dontAsk" }],
      [{ permissionMode: "default" }],
      [{ permissionMode: null }],
      [{ model: "opus" }],
      [{ effort: "max" }],
      [{ model: null, effort: null }],
    ])("member 가 %j 를 저장한다 — 200", async (body) => {
      const { conversationId, agent } = setup();
      const res = await patch(mia.token, conversationId, agent.id, body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ agentId: agent.id, ...body, contextPercent: null });
    });

    it("member 의 acceptEdits 는 403 — 러너 주인 member·admin·owner 는 200", async () => {
      const open = setup();
      const refused = await patch(mia.token, open.conversationId, open.agent.id, {
        permissionMode: "acceptEdits",
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "FORBIDDEN" });
      expect((await settingsOf(mia.token, open.conversationId))[0]?.permissionMode).toBeNull();
      const mine = setup(runner.mine);
      expect(
        (await patch(mia.token, mine.conversationId, mine.agent.id, { permissionMode: "acceptEdits" }))
          .statusCode,
      ).toBe(200);
      expect(
        (await patch(admin.token, open.conversationId, open.agent.id, { permissionMode: "acceptEdits" }))
          .statusCode,
      ).toBe(200);
      expect(
        (await patch(owner, open.conversationId, open.agent.id, { permissionMode: "acceptEdits" }))
          .statusCode,
      ).toBe(200);
    });

    it("지금 값이 acceptEdits 여도 member 는 default 이하로 내린다 — 비교 기준은 default", async () => {
      const { conversationId, agent } = setup();
      expect(
        (await patch(admin.token, conversationId, agent.id, { permissionMode: "acceptEdits" })).statusCode,
      ).toBe(200);
      expect((await patch(mia.token, conversationId, agent.id, { permissionMode: "plan" })).statusCode).toBe(
        200,
      );
    });

    it("러너 상한(default) 위는 admin 도 400(VALIDATION permissionMode)", async () => {
      const { conversationId, agent } = setup(runner.low);
      const res = await patch(admin.token, conversationId, agent.id, { permissionMode: "acceptEdits" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION", details: { field: "permissionMode" } });
    });

    it("빈 본문·bypassPermissions 는 400", async () => {
      const { conversationId, agent } = setup();
      expect((await patch(owner, conversationId, agent.id, {})).statusCode).toBe(400);
      expect(
        (await patch(owner, conversationId, agent.id, { permissionMode: "bypassPermissions" })).statusCode,
      ).toBe(400);
    });

    it("OpenClaw 에이전트·채널 밖 러너 에이전트는 404, GET 목록에도 없다", async () => {
      const { channel, conversationId } = setup();
      const oc = createAgent(app.db, {
        gatewayId: FAKE_GATEWAY_ID,
        workspaceId: app.workspaceId,
        providerAgentId: `oc${++n}`,
        handle: `oc${n}`,
        name: "oc",
      });
      addMember(app.db, channel.id, { memberType: "agent", memberId: oc.id }, app.logger);
      const outside = setup().agent;
      expect((await patch(owner, conversationId, oc.id, { model: "opus" })).statusCode).toBe(404);
      expect((await patch(owner, conversationId, outside.id, { model: "opus" })).statusCode).toBe(404);
      expect((await settingsOf(owner, conversationId)).map((s) => s.agentId)).not.toContain(oc.id);
    });

    it("남의 DM 의 대화는 GET·PATCH 모두 404 — 주인은 읽고 바꾼다", async () => {
      const { agent } = createRunnerAgentForTest(app.db, {
        workspaceId: app.workspaceId,
        handle: `dm${++n}`,
        runnerTokenId: runner.mine,
      });
      const dm = createDmChannelForTest(app.db, {
        workspaceId: app.workspaceId,
        ownerId: mia.id,
        agentId: agent.id,
      });
      const conversationId = seedConversation(app.db, dm.id, { createdBy: mia.id });
      for (const token of [noah.token, owner]) {
        expect(
          (await call(token, "GET", `/api/v1/conversations/${conversationId}/agent-settings`)).statusCode,
        ).toBe(404);
        expect((await patch(token, conversationId, agent.id, { model: "opus" })).statusCode).toBe(404);
      }
      expect((await settingsOf(mia.token, conversationId)).map((s) => s.agentId)).toEqual([agent.id]);
      expect((await patch(mia.token, conversationId, agent.id, { model: "opus" })).statusCode).toBe(200);
    });
  });

  it("저장하면 그 채널 룸에 conversation.agent_settings 하나", async () => {
    const { channel, conversationId, agent } = setup();
    const socket = await connectWire(app, owner);
    sockets.push(socket);
    expect((await socket.emitWithAck("channel.subscribe", { channelId: channel.id })).ok).toBe(true);
    const seen: unknown[] = [];
    socket.on("conversation.agent_settings", (p) => seen.push(p));
    const got = waitFor(socket, "conversation.agent_settings");
    expect((await patch(mia.token, conversationId, agent.id, { model: "opus" })).statusCode).toBe(200);
    expect(await got).toEqual({
      channelId: channel.id,
      conversationId,
      settings: {
        agentId: agent.id,
        model: "opus",
        effort: null,
        permissionMode: null,
        contextPercent: null,
      },
    });
    // 같은 틱의 덤 이벤트가 없는지 — 응답 뒤에 한 번 더 기다려 본다
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(1);
  });

  describe("컨텍스트 % [S7·S9]", () => {
    const run = (
      fx: ReturnType<typeof setup>,
      usage: object | null,
      createdAt: Date,
      threadRootId?: string,
    ) => {
      const root = createUserMessage(app.db, app.bus, {
        conversationId: fx.conversationId,
        authorId: app.ownerUserId,
        bodyMd: "질문",
        clientMsgId: `cx-${++n}`,
      });
      const row = insertRun(app.db, {
        channelId: fx.channel.id,
        conversationId: fx.conversationId,
        agentId: fx.agent.id,
        triggerKind: "mention",
        triggerMessageId: root.id,
        rootMessageId: root.id,
        relayDepth: 0,
        sessionKey: `k-${n}`,
        connectionId: runner.open,
        createdAt,
        ...(threadRootId === undefined ? {} : { threadRootId }),
      });
      if (usage !== null) app.db.update(runs).set({ usage }).where(eq(runs.id, row.id)).run();
      return root;
    };

    it("실행이 없으면 null, 마지막 실행의 contextTokens/contextWindow 로 반올림 — 스레드 질의는 그 스레드 런만 [Review Focus 5]", async () => {
      const fx = setup();
      expect((await settingsOf(owner, fx.conversationId))[0]?.contextPercent).toBeNull();
      const t = Date.parse("2026-11-11T00:00:00Z");
      const root = run(fx, { contextTokens: 10_000, contextWindow: 100_000 }, new Date(t));
      run(fx, { contextTokens: 42_000, contextWindow: 100_000 }, new Date(t + 1000));
      expect((await settingsOf(owner, fx.conversationId))[0]?.contextPercent).toBe(42);
      // 스레드에 실행이 없으면 「—」(null) — 대화 런의 값을 빌리지 않는다
      expect(
        (await settingsOf(owner, fx.conversationId, `?threadRootId=${root.id}`))[0]?.contextPercent,
      ).toBeNull();
      run(fx, { contextTokens: 155_555, contextWindow: 200_000 }, new Date(t + 2000), root.id);
      expect(
        (await settingsOf(owner, fx.conversationId, `?threadRootId=${root.id}`))[0]?.contextPercent,
      ).toBe(78);
      // 스레드 런은 대화 세션 값에 섞이지 않는다
      expect((await settingsOf(owner, fx.conversationId))[0]?.contextPercent).toBe(42);
    });
  });

  describe("새 세션 첫 글의 agentSettings [S11]", () => {
    const wire = async (token: string, channelId: string) => {
      const socket = await connectWire(app, token);
      sockets.push(socket);
      expect((await socket.emitWithAck("channel.subscribe", { channelId })).ok).toBe(true);
      return socket;
    };
    const first = (
      socket: WireClient,
      channelId: string,
      agentSettings: AgentSettingsEntry[],
      clientMsgId = `f-${++n}`,
    ) =>
      socket.emitWithAck("message.send", {
        channelId,
        clientMsgId,
        bodyMd: "새 세션",
        newConversation: {},
        agentSettings,
      });
    const rowsOf = (agentId: string) =>
      app.db
        .select()
        .from(conversationAgentSettings)
        .where(eq(conversationAgentSettings.agentId, agentId))
        .all();
    const conversationsOf = (channelId: string) =>
      app.db.select().from(conversations).where(eq(conversations.channelId, channelId)).all();

    it("대화와 설정 행이 같이 생긴다 — 응답 세션의 GET 이 그 값", async () => {
      const { channel, agent } = setup();
      const socket = await wire(mia.token, channel.id);
      const res = await first(socket, channel.id, [
        { agentId: agent.id, model: "opus", permissionMode: "plan" },
      ]);
      if (!res.ok) throw new Error(res.error.code);
      const conversation = res.data.conversation as Conversation;
      expect(rowsOf(agent.id)).toMatchObject([
        {
          conversationId: conversation.id,
          model: "opus",
          effort: null,
          permissionMode: "plan",
          updatedBy: mia.id,
        },
      ]);
      expect((await settingsOf(mia.token, conversation.id))[0]).toMatchObject({
        model: "opus",
        permissionMode: "plan",
      });
    });

    it("member 의 acceptEdits 는 글 전체를 거절한다 — 대화도 메시지도 설정 행도 없다 [Review Focus 1]", async () => {
      const { channel, agent } = setup();
      const socket = await wire(mia.token, channel.id);
      const before = conversationsOf(channel.id).length;
      const res = await first(socket, channel.id, [{ agentId: agent.id, permissionMode: "acceptEdits" }]);
      expect(res).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(conversationsOf(channel.id)).toHaveLength(before);
      expect(rowsOf(agent.id)).toEqual([]);
    });

    it("둘째 항목만 어겨도(상한 위) 첫째도 남지 않는다", async () => {
      const { channel, agent } = setup();
      const { agent: low } = createRunnerAgentForTest(app.db, {
        workspaceId: app.workspaceId,
        handle: `low${++n}`,
        runnerTokenId: runner.low,
      });
      addMember(app.db, channel.id, { memberType: "agent", memberId: low.id }, app.logger);
      const socket = await wire(admin.token, channel.id);
      const res = await first(socket, channel.id, [
        { agentId: agent.id, model: "opus" },
        { agentId: low.id, permissionMode: "acceptEdits" },
      ]);
      expect(res).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      expect(rowsOf(agent.id)).toEqual([]);
      expect(rowsOf(low.id)).toEqual([]);
    });

    it("같은 clientMsgId 재전송에 다른 값을 실어도 첫 전송의 값이 남는다 [Review Focus 2]", async () => {
      const { channel, agent } = setup();
      const socket = await wire(mia.token, channel.id);
      const a = await first(socket, channel.id, [{ agentId: agent.id, model: "opus" }], `re-${++n}`);
      const b = await first(
        socket,
        channel.id,
        [{ agentId: agent.id, model: "haiku", effort: "max" }],
        `re-${n}`,
      );
      if (!a.ok || !b.ok) throw new Error("ack 실패");
      expect(b.data.conversation?.id).toBe(a.data.conversation?.id);
      expect(rowsOf(agent.id)).toMatchObject([{ model: "opus", effort: null }]);
    });

    it("채널 멤버가 아닌 에이전트 id 는 VALIDATION — 대화가 생기지 않는다", async () => {
      const { channel } = setup();
      const outside = setup().agent;
      const socket = await wire(mia.token, channel.id);
      const before = conversationsOf(channel.id).length;
      const res = await first(socket, channel.id, [{ agentId: outside.id, model: "opus" }]);
      expect(res).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      expect(conversationsOf(channel.id)).toHaveLength(before);
      expect(
        app.db
          .select()
          .from(conversationAgentSettings)
          .where(and(eq(conversationAgentSettings.agentId, outside.id)))
          .all(),
      ).toEqual([]);
    });

    it("conversationId 와 함께 오면 계약이 거절한다(VALIDATION)", async () => {
      const { channel, agent, conversationId } = setup();
      const socket = await wire(mia.token, channel.id);
      const res = await socket.emitWithAck("message.send", {
        channelId: channel.id,
        clientMsgId: `c-${++n}`,
        bodyMd: "x",
        conversationId,
        agentSettings: [{ agentId: agent.id, model: "opus" }],
      });
      expect(res).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    });
  });
});
