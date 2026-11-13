/**
 * 세션에 에이전트 초대 REST(세션 에이전트 초대 스펙 5.3·6장) — 초대·내보내기·검증, 내보내면 그 에이전트의 런이 멈추고 늦은 정본이 릴레이를
 * 만들지 않는 것(Review Focus 2), 세션 닫기·채널·에이전트 보관과의 겹침(I6·Review Focus 3), 채널 멤버로 넣으면 초대가 지워지는 것(I12·
 * Review Focus 4)
 */
import type { ProviderApproval } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Agent, dodokSessionKey, type InvitedAgent, type Message } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import * as approvalStore from "../src/modules/approvals/store";
import { addMember, createChannel } from "../src/modules/channels/service";
import { insertInvite, listInvited } from "../src/modules/conversations/invited-agents";
import { createUserMessage } from "../src/modules/messages/service";
import { getRun, listOpenRuns } from "../src/modules/runs/store";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { createDmChannelForTest, seedConversation } from "./helpers/seed";

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** 늦게 끝나는 일(릴레이 enqueue)이 있으면 닿을 만큼 기다린다 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

async function setup() {
  const adapter = new FakeAdapter();
  const app = await bootTestApp({}, { adapters: [adapter] });
  apps.push(app);
  let n = 0;
  const agent = (handle: string): Agent =>
    createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: handle,
      handle,
      name: handle,
    });
  const dev = agent("dev");
  const guest = agent("guest");
  const channel = createChannel(app.db, {
    workspaceId: app.workspaceId,
    createdBy: app.ownerUserId,
    name: "invite",
  });
  addMember(app.db, channel.id, { memberType: "agent", memberId: dev.id }, app.logger);
  const sessionA = seedConversation(app.db, channel.id, { title: "A" });
  const sessionB = seedConversation(app.db, channel.id, { title: "B" });
  const { headers } = await login(app);
  const inject = (method: "GET" | "POST" | "DELETE" | "PATCH", url: string, payload?: object) =>
    app.fastify.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
  const invite = (conversationId: string, agentId: string) =>
    inject("POST", `/api/v1/conversations/${conversationId}/agents`, { agentId });
  const kick = (conversationId: string, agentId: string) =>
    inject("DELETE", `/api/v1/conversations/${conversationId}/agents/${agentId}`);
  /** 그 세션에 사람 글 하나를 쓰고 라우터에 넘긴다 */
  const mention = async (conversationId: string, bodyMd: string): Promise<Message> => {
    const message = createUserMessage(app.db, app.bus, {
      conversationId,
      authorId: app.ownerUserId,
      bodyMd,
      clientMsgId: `inv-${++n}`,
    });
    await app.services.router.routeMessage(message);
    return message;
  };
  const allRunsOf = (agentId: string) => adapter.calls.send.filter((s) => s.agentId === agentId);
  const events: Array<{ channelId: string; conversationId: string; invited: InvitedAgent[] }> = [];
  app.bus.on("conversation.agents", (p) => events.push(p));
  return {
    app,
    adapter,
    headers,
    agent,
    dev,
    guest,
    channel,
    sessionA,
    sessionB,
    inject,
    invite,
    kick,
    mention,
    allRunsOf,
    events,
  };
}

/** 그 대화의 시스템 메시지 본문 */
async function systemLines(app: App, headers: { authorization: string }, conversationId: string) {
  const res = await app.fastify.inject({
    method: "GET",
    url: `/api/v1/conversations/${conversationId}/messages`,
    headers,
  });
  return (res.json().messages as Message[]).filter((m) => m.kind === "system").map((m) => m.bodyMd);
}

describe("POST·GET /conversations/:id/agents — 초대", () => {
  it("초대하면 200 { invited } · 채널 룸에 conversation.agents · 시스템 메시지 · GET 이 같은 목록", async () => {
    const t = await setup();
    const res = await t.invite(t.sessionA, t.guest.id);
    expect(res.statusCode).toBe(200);
    const invited = res.json().invited as InvitedAgent[];
    expect(invited).toEqual([
      { agentId: t.guest.id, invitedBy: t.app.ownerUserId, invitedAt: expect.any(String) },
    ]);
    expect(t.events).toEqual([{ channelId: t.channel.id, conversationId: t.sessionA, invited }]);
    expect(await systemLines(t.app, t.headers, t.sessionA)).toEqual([
      "@owner 가 @guest 를 이 세션에 초대했습니다",
    ]);
    const listed = await t.inject("GET", `/api/v1/conversations/${t.sessionA}/agents`);
    expect(listed.json()).toEqual({ invited });
    expect((await t.inject("GET", `/api/v1/conversations/${t.sessionB}/agents`)).json()).toEqual({
      invited: [],
    });
  });

  it("세션 하나에 8까지 — 9번째는 400", async () => {
    const t = await setup();
    for (let i = 0; i < 8; i++)
      expect((await t.invite(t.sessionA, t.agent(`g${i}`).id)).statusCode).toBe(200);
    const ninth = await t.invite(t.sessionA, t.agent("g9").id);
    expect(ninth.statusCode).toBe(400);
    expect(ninth.json().code).toBe("VALIDATION");
    // 다른 세션은 따로 센다
    expect((await t.invite(t.sessionB, t.agent("g10").id)).statusCode).toBe(200);
  });

  it("채널 멤버·보관한 에이전트·없는 에이전트·DM 대화는 400, 같은 에이전트 두 번은 409", async () => {
    const t = await setup();
    const archived = t.agent("old");
    expect((await t.inject("DELETE", `/api/v1/agents/${archived.id}`)).statusCode).toBe(200);
    for (const agentId of [t.dev.id, archived.id, uuid()]) {
      const res = await t.invite(t.sessionA, agentId);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("VALIDATION");
    }
    const dm = createDmChannelForTest(t.app.db, {
      workspaceId: t.app.workspaceId,
      ownerId: t.app.ownerUserId,
      agentId: t.dev.id,
    });
    const dmConversation = seedConversation(t.app.db, dm.id);
    expect((await t.invite(dmConversation, t.guest.id)).statusCode).toBe(400);
    expect((await t.invite(t.sessionA, t.guest.id)).statusCode).toBe(200);
    const again = await t.invite(t.sessionA, t.guest.id);
    expect(again.statusCode).toBe(409);
    expect(listInvited(t.app.db, t.sessionA)).toHaveLength(1);
  });

  it("닫힌 세션에는 초대·내보내기를 받지 않는다(CONVERSATION_CLOSED) — 다시 열면 초대가 그대로다(I6)", async () => {
    const t = await setup();
    expect((await t.invite(t.sessionA, t.guest.id)).statusCode).toBe(200);
    expect(
      (await t.inject("PATCH", `/api/v1/conversations/${t.sessionA}`, { closed: true })).statusCode,
    ).toBe(200);
    const other = t.agent("other");
    const invite = await t.invite(t.sessionA, other.id);
    expect(invite.statusCode).toBe(409);
    expect(invite.json()).toMatchObject({ code: "CONVERSATION_CLOSED", message: "닫힌 세션입니다" });
    expect((await t.kick(t.sessionA, t.guest.id)).json()).toMatchObject({ code: "CONVERSATION_CLOSED" });
    expect(
      (await t.inject("PATCH", `/api/v1/conversations/${t.sessionA}`, { closed: false })).statusCode,
    ).toBe(200);
    expect(listInvited(t.app.db, t.sessionA).map((r) => r.agentId)).toEqual([t.guest.id]);
    await t.mention(t.sessionA, "@guest 다시 열었어");
    await vi.waitFor(() => expect(t.allRunsOf("guest")).toHaveLength(1));
  });

  it("읽을 수 없는 대화(남의 DM)는 404 — 역할 판정보다 먼저", async () => {
    const t = await setup();
    const mia = await userWithRole(t.app, "mia", "member");
    const dm = createDmChannelForTest(t.app.db, {
      workspaceId: t.app.workspaceId,
      ownerId: t.app.ownerUserId,
      agentId: t.dev.id,
    });
    const dmConversation = seedConversation(t.app.db, dm.id);
    const asMia = { authorization: `Bearer ${mia.token}` };
    for (const [method, url, payload] of [
      ["GET", `/api/v1/conversations/${dmConversation}/agents`, undefined],
      ["POST", `/api/v1/conversations/${dmConversation}/agents`, { agentId: t.guest.id }],
      ["DELETE", `/api/v1/conversations/${dmConversation}/agents/${t.guest.id}`, undefined],
    ] as const) {
      const res = await t.app.fastify.inject({
        method,
        url,
        headers: asMia,
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

function approvalFor(sessionKey: string, conversationId: string): ProviderApproval {
  const createdAt = new Date();
  return {
    providerApprovalId: `plugin:${uuid()}`,
    kind: "plugin",
    sessionKey,
    providerAgentId: "guest",
    conversationId,
    toolCallId: "toolu_kick",
    toolName: "Write",
    pluginId: "fs",
    title: "Write 실행",
    description: '{"path":"a.ts"}',
    severity: "warning",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
    status: "pending",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 120_000).toISOString(),
  };
}

describe("DELETE /conversations/:id/agents/:agentId — 내보내기 [Review Focus 2]", () => {
  it("그 세션(스레드 포함)에서 그 에이전트의 열린 런만 멈추고 걸린 승인은 취소한다 — 다른 에이전트의 런은 그대로", async () => {
    const t = await setup();
    await t.invite(t.sessionA, t.guest.id);
    const top = await t.mention(t.sessionA, "@guest @dev 같이 봐 줘");
    const reply = createUserMessage(t.app.db, t.app.bus, {
      conversationId: t.sessionA,
      authorId: t.app.ownerUserId,
      bodyMd: "@guest 스레드에서도",
      clientMsgId: "thread-1",
      threadRootId: top.id,
    });
    await t.app.services.router.routeMessage(reply);
    await vi.waitFor(() => expect(t.adapter.calls.send).toHaveLength(3));
    const guestRuns = t.adapter.calls.send.filter((s) => s.agentId === "guest").map((s) => s.runId);
    const devRun = t.adapter.calls.send.find((s) => s.agentId === "dev")?.runId as string;
    expect(guestRuns).toHaveLength(2);
    const approval = approvalFor(dodokSessionKey("guest", t.sessionA), t.sessionA);
    t.adapter.emitApproval(approval);
    await vi.waitFor(() =>
      expect(approvalStore.getApprovalByProviderId(t.app.db, approval.providerApprovalId)).toMatchObject({
        status: "pending",
      }),
    );

    const res = await t.kick(t.sessionA, t.guest.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ invited: [] });
    await vi.waitFor(() =>
      expect(guestRuns.map((id) => getRun(t.app.db, id)?.status)).toEqual(["aborted", "aborted"]),
    );
    expect(approvalStore.getApprovalByProviderId(t.app.db, approval.providerApprovalId)).toMatchObject({
      status: "cancelled",
    });
    expect(getRun(t.app.db, devRun)?.status).not.toBe("aborted");
    expect(t.events.at(-1)).toEqual({ channelId: t.channel.id, conversationId: t.sessionA, invited: [] });
    expect(await systemLines(t.app, t.headers, t.sessionA)).toEqual([
      "@owner 가 @guest 를 이 세션에 초대했습니다",
      "@owner 가 @guest 를 이 세션에서 내보냈습니다",
    ]);
  });

  it("내보낸 뒤 그 에이전트 멘션은 실행 0 · 늦게 온 그 에이전트의 정본은 저장만 하고 릴레이를 만들지 않는다", async () => {
    const t = await setup();
    await t.invite(t.sessionA, t.guest.id);
    await t.mention(t.sessionA, "@guest 정리해 줘");
    await vi.waitFor(() => expect(t.allRunsOf("guest")).toHaveLength(1));
    const runId = t.allRunsOf("guest")[0]?.runId as string;
    expect((await t.kick(t.sessionA, t.guest.id)).statusCode).toBe(200);
    await vi.waitFor(() => expect(getRun(t.app.db, runId)?.status).toBe("aborted"));

    const sent = t.adapter.calls.send.length;
    const ack = await t.app.orchestrator.onCanonical(
      {
        outboundId: `late-${runId}`,
        conversationId: t.sessionA,
        agentId: "guest",
        sessionKey: dodokSessionKey("guest", t.sessionA),
        runId,
        text: "@dev 늦었지만 넘길게",
        attachmentIds: [],
        ts: new Date().toISOString(),
      },
      "openclaw",
      FAKE_GATEWAY_ID,
    );
    expect(ack.messageId).toBeDefined();
    await t.mention(t.sessionA, "@guest 아직 있어?");
    await settle();
    expect(t.adapter.calls.send).toHaveLength(sent);
    expect(listOpenRuns(t.app.db)).toEqual([]);
  });

  it("초대하지 않은 에이전트를 내보내면 404", async () => {
    const t = await setup();
    expect((await t.kick(t.sessionA, t.guest.id)).statusCode).toBe(404);
    expect((await t.kick(t.sessionA, t.dev.id)).statusCode).toBe(404);
  });
});

describe("세션 초대와 보관·채널 멤버의 겹침", () => {
  it("다른 세션에서 @guest 는 실행되지 않는다 — 초대한 세션에서만 [Review Focus 1]", async () => {
    const t = await setup();
    await t.invite(t.sessionA, t.guest.id);
    await t.mention(t.sessionB, "@guest 여기서는?");
    await settle();
    expect(t.allRunsOf("guest")).toEqual([]);
    await t.mention(t.sessionA, "@guest 여기서는");
    await vi.waitFor(() => expect(t.allRunsOf("guest")).toHaveLength(1));
  });

  it("채널을 보관하면 초대한 에이전트의 런이 멈추고 초대는 남는다 — 되살리면 다시 실행된다 [Review Focus 3]", async () => {
    const t = await setup();
    await t.invite(t.sessionA, t.guest.id);
    await t.mention(t.sessionA, "@guest 길게 해 줘");
    await vi.waitFor(() => expect(t.allRunsOf("guest")).toHaveLength(1));
    const runId = t.allRunsOf("guest")[0]?.runId as string;
    expect((await t.inject("POST", `/api/v1/channels/${t.channel.id}/archive`)).statusCode).toBe(200);
    await vi.waitFor(() => expect(getRun(t.app.db, runId)?.status).toBe("aborted"));
    expect(listInvited(t.app.db, t.sessionA).map((r) => r.agentId)).toEqual([t.guest.id]);
    expect((await t.invite(t.sessionA, t.agent("late").id)).json()).toMatchObject({
      code: "CHANNEL_ARCHIVED",
    });
    expect((await t.inject("POST", `/api/v1/channels/${t.channel.id}/unarchive`)).statusCode).toBe(200);
    await t.mention(t.sessionA, "@guest 다시");
    await vi.waitFor(() => expect(t.allRunsOf("guest")).toHaveLength(2));
  });

  it("초대한 에이전트를 보관하면 멘션해도 실행 0 · 되살리면 초대가 그대로라 다시 실행된다 [Review Focus 3]", async () => {
    const t = await setup();
    await t.invite(t.sessionA, t.guest.id);
    expect((await t.inject("DELETE", `/api/v1/agents/${t.guest.id}`)).statusCode).toBe(200);
    await t.mention(t.sessionA, "@guest 보관 중");
    await settle();
    expect(t.allRunsOf("guest")).toEqual([]);
    expect((await t.inject("POST", `/api/v1/agents/${t.guest.id}/restore`)).statusCode).toBe(200);
    expect(listInvited(t.app.db, t.sessionA).map((r) => r.agentId)).toEqual([t.guest.id]);
    await t.mention(t.sessionA, "@guest 돌아왔어");
    await vi.waitFor(() => expect(t.allRunsOf("guest")).toHaveLength(1));
  });

  it("초대한 뒤 채널 멤버로 넣으면 그 채널 모든 세션의 초대가 지워지고 대화마다 conversation.agents — 다시 빼면 그 세션에서도 불리지 않는다 [Review Focus 4]", async () => {
    const t = await setup();
    await t.invite(t.sessionA, t.guest.id);
    await t.invite(t.sessionB, t.guest.id);
    const elsewhere = createChannel(t.app.db, {
      workspaceId: t.app.workspaceId,
      createdBy: t.app.ownerUserId,
      name: "elsewhere",
    });
    const far = seedConversation(t.app.db, elsewhere.id);
    insertInvite(t.app.db, { conversationId: far, agentId: t.guest.id, invitedBy: t.app.ownerUserId });
    t.events.length = 0;
    const added = await t.inject("POST", `/api/v1/channels/${t.channel.id}/members`, {
      memberType: "agent",
      memberId: t.guest.id,
    });
    expect(added.statusCode).toBe(201);
    expect(listInvited(t.app.db, t.sessionA)).toEqual([]);
    expect(listInvited(t.app.db, t.sessionB)).toEqual([]);
    expect(listInvited(t.app.db, far).map((r) => r.agentId)).toEqual([t.guest.id]);
    expect(t.events.map((e) => [e.conversationId, e.invited]).sort()).toEqual(
      [
        [t.sessionA, []],
        [t.sessionB, []],
      ].sort(),
    );
    expect(
      (await t.inject("DELETE", `/api/v1/channels/${t.channel.id}/members/${t.guest.id}`)).statusCode,
    ).toBe(200);
    await t.mention(t.sessionA, "@guest 아직?");
    await settle();
    expect(t.allRunsOf("guest")).toEqual([]);
  });
});
