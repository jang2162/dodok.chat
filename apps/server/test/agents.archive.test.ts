/**
 * 에이전트 보관·되살리기(설정·에이전트 보관 스펙 「에이전트 보관」 절, 계획 판정 PS1~PS4, Review Focus 1·2). 보관은 행·핸들·채널 참여·
 * 세션을 남기고 런만 막는다 — 되살리면 같은 세션으로 이어 답한다.
 */
import { AdapterError, type ProviderApproval } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import type { Agent, ChannelMember, Message, OutboundMessage } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, AppDeps } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage, runErrorMessages } from "../src/modules/messages/service";
import { createRunGate } from "../src/modules/ops/budget";
import { RETRY_RUN_ITEM } from "../src/modules/router/service";
import { getRun } from "../src/modules/runs/store";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID, insertGateway } from "./helpers/gateways";
import { connectWire, waitFor } from "./helpers/wire";
import { type FakeRunner, startFakeRunner } from "./fakes/fake-runner";
import { channelConversation, createRunnerAgentForTest } from "./helpers/seed";

const apps: App[] = [];
const runners: FakeRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) runner.close();
  for (const app of apps.splice(0)) await app.close();
});

/** dev·fin 을 둔 채널 하나 + owner 세션 + 멘션·런 도우미 */
async function setup(deps: Pick<AppDeps, "runnerAdapter" | "pushSend"> = {}) {
  const adapter = new FakeAdapter();
  const app = await bootTestApp({}, { adapters: [adapter], ...deps });
  apps.push(app);
  const { token, headers } = await login(app);
  const inject = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
    h: Record<string, string> = headers,
  ) => app.fastify.inject({ method, url, headers: h, ...(payload === undefined ? {} : { payload }) });
  const agent = (providerAgentId: string) =>
    createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId,
      handle: providerAgentId,
      name: providerAgentId,
      gatewayId: FAKE_GATEWAY_ID,
    });
  const dev = agent("dev");
  const fin = agent("fin");
  const channel = createChannel(app.db, {
    workspaceId: app.workspaceId,
    createdBy: app.ownerUserId,
    name: "archive",
  });
  for (const a of [dev, fin])
    addMember(app.db, channel.id, { memberType: "agent", memberId: a.id }, app.logger);
  let n = 0;
  const say = async (bodyMd: string) => {
    const message = createUserMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      authorId: app.ownerUserId,
      bodyMd,
      clientMsgId: `archive-${++n}`,
    });
    await app.services.router.routeMessage(message);
    return message;
  };
  const runs = () =>
    app.db.$client
      .prepare("SELECT id FROM runs WHERE channel_id = ? ORDER BY created_at, id")
      .all(channel.id)
      .map((r) => getRun(app.db, (r as { id: string }).id));
  const openRuns = () => runs().filter((r) => r && !["done", "error", "aborted"].includes(r.status));
  const archive = (id: string, h: Record<string, string> = headers) =>
    inject("DELETE", `/api/v1/agents/${id}`, undefined, h);
  const restore = (id: string, h: Record<string, string> = headers) =>
    inject("POST", `/api/v1/agents/${id}/restore`, undefined, h);
  return { app, adapter, token, headers, inject, dev, fin, channel, say, runs, openRuns, archive, restore };
}

describe("보관·되살리기 REST", () => {
  it("admin 이 보관하면 200·archivedAt 이 시각, 다시 해도 200(멱등), member 403, 없는 id 404", async () => {
    const { app, dev, archive } = await setup();
    const admin = { authorization: `Bearer ${(await userWithRole(app, "ada", "admin")).token}` };
    const member = { authorization: `Bearer ${(await userWithRole(app, "bee", "member")).token}` };

    expect((await archive(dev.id, member)).statusCode).toBe(403);
    const first = await archive(dev.id, admin);
    expect(first.statusCode).toBe(200);
    const archivedAt = (first.json().agent as Agent).archivedAt;
    expect(archivedAt).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(archivedAt ?? ""))).toBe(false);
    const again = await archive(dev.id, admin);
    expect(again.statusCode).toBe(200);
    expect((again.json().agent as Agent).archivedAt).toBe(archivedAt);
    expect((await archive(uuid(), admin)).statusCode).toBe(404);
  });

  it("목록은 보관한 에이전트도 archivedAt 과 함께 준다", async () => {
    const { dev, fin, inject, archive } = await setup();
    await archive(dev.id);
    const listed = (await inject("GET", "/api/v1/agents")).json().agents as Agent[];
    expect(listed.map((a) => [a.handle, a.archivedAt === null])).toEqual([
      ["dev", false],
      ["fin", true],
    ]);
    expect(listed.find((a) => a.id === fin.id)?.archivedAt).toBeNull();
  });

  it("되살리면 200·archivedAt null, 살아 있는 것을 되살려도 200, member 403, 없는 id 404", async () => {
    const { app, dev, fin, archive, restore } = await setup();
    const member = { authorization: `Bearer ${(await userWithRole(app, "bee", "member")).token}` };
    await archive(dev.id);
    expect((await restore(dev.id, member)).statusCode).toBe(403);
    const back = await restore(dev.id);
    expect(back.statusCode).toBe(200);
    expect((back.json().agent as Agent).archivedAt).toBeNull();
    expect((await restore(fin.id)).statusCode).toBe(200);
    expect((await restore(uuid())).statusCode).toBe(404);
  });

  it("discover 는 같은 Gateway·id 의 보관한 에이전트에 archivedAgentId 를 싣고, 같은 자리 등록은 409 AGENT_ARCHIVED", async () => {
    const { dev, inject, archive } = await setup();
    await archive(dev.id);
    const found = (
      await inject("GET", `/api/v1/agents/discover?provider=openclaw&gatewayId=${FAKE_GATEWAY_ID}`)
    ).json().agents as Array<{ providerAgentId: string; archivedAgentId?: string }>;
    expect(found.find((a) => a.providerAgentId === "dev")?.archivedAgentId).toBe(dev.id);
    expect(found.filter((a) => a.archivedAgentId !== undefined)).toHaveLength(1);

    // 핸들을 바꿔도 같은 자리면 새로 만들지 않는다
    const res = await inject("POST", "/api/v1/agents", {
      providerAgentId: "dev",
      handle: "dev-2",
      name: "dev",
      gatewayId: FAKE_GATEWAY_ID,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "AGENT_ARCHIVED", details: { agentId: dev.id } });
  });

  it("보관한 에이전트는 채널에 다시 넣을 수 없다(409 AGENT_ARCHIVED)", async () => {
    const { app, dev, inject, archive } = await setup();
    await archive(dev.id);
    const other = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "other",
    });
    const res = await inject("POST", `/api/v1/channels/${other.id}/members`, {
      memberType: "agent",
      memberId: dev.id,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "AGENT_ARCHIVED" });
  });

  it("등록·수정·옮기기·보관·되살리기마다 workspace 룸에 agents.changed 한 번", async () => {
    const { app, token, dev, inject, archive, restore } = await setup();
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const seen: unknown[] = [];
    app.bus.on("agents.changed", (p) => seen.push(p));
    // 채널을 구독하지 않은 소켓에도 간다 — 워크스페이스 방
    const socket = await connectWire(app, token);
    try {
      const arrived = waitFor(socket, "agents.changed");
      const created = await inject("POST", "/api/v1/agents", {
        providerAgentId: "ops",
        handle: "ops",
        name: "ops",
        gatewayId: FAKE_GATEWAY_ID,
      });
      expect(created.statusCode).toBe(201);
      expect(await arrived).toEqual({});
      expect(seen).toHaveLength(1);
      expect((await inject("PATCH", `/api/v1/agents/${dev.id}`, { name: "Dev" })).statusCode).toBe(200);
      expect(seen).toHaveLength(2);
      expect(
        (await inject("PUT", `/api/v1/agents/${dev.id}/gateway`, { gatewayId: FAKE_GATEWAY_ID })).statusCode,
      ).toBe(200);
      expect(seen).toHaveLength(3);
      await archive(dev.id);
      expect(seen).toHaveLength(4);
      await restore(dev.id);
      expect(seen).toHaveLength(5);
      expect(seen.every((p) => JSON.stringify(p) === "{}")).toBe(true);
    } finally {
      socket.close();
    }
  });
});

describe("에이전트를 바꾸는 다른 동작의 agents.changed", () => {
  it("러너 「이 러너로 묶기」와 에이전트가 묶인 Gateway 삭제도 한 번씩 보낸다 — 에이전트가 없는 Gateway 삭제는 보내지 않는다", async () => {
    const { app, inject } = await setup();
    const seen: unknown[] = [];
    app.bus.on("agents.changed", (p) => seen.push(p));

    const { agent: coder } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: "coder",
    });
    const issued = await inject("POST", "/api/v1/setup/runner-tokens", { label: "laptop" });
    expect(issued.statusCode).toBe(201);
    const tokenId = issued.json().record.id as string;
    expect(
      (await inject("PUT", `/api/v1/setup/runner-tokens/${tokenId}/agents/${coder.providerAgentId}`))
        .statusCode,
    ).toBe(200);
    expect(seen).toEqual([{}]);

    const home = insertGateway(app.db, app.workspaceId, { id: uuid(), name: "집" });
    createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: "main",
      handle: "main",
      name: "main",
      gatewayId: home.id,
    });
    const deleted = await inject("DELETE", `/api/v1/gateways/${home.id}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ unboundAgents: 1 });
    expect(seen).toEqual([{}, {}]);

    const empty = insertGateway(app.db, app.workspaceId, { id: uuid(), name: "빈" });
    expect((await inject("DELETE", `/api/v1/gateways/${empty.id}`)).json()).toMatchObject({
      unboundAgents: 0,
    });
    expect(seen).toEqual([{}, {}]);
  });
});

describe("보관과 런", () => {
  it("보관 뒤 멘션은 런을 만들지 않는다 — 손으로 친 @핸들 은 글자로 남는다", async () => {
    const { dev, say, runs, archive } = await setup();
    await archive(dev.id);
    const message = await say("@dev 안녕");
    expect(message.mentions.agents).toEqual([]);
    expect(runs()).toHaveLength(0);
  });

  it("런 관문이 보관한 에이전트를 막는다 — 라우터 판정을 지난 계획이 늦게 와도 런 행이 생기지 않는다(Review Focus 1)", async () => {
    const { app, dev, channel, runs, archive } = await setup();
    await archive(dev.id);
    const gate = createRunGate({
      db: app.db,
      bus: app.bus,
      ops: app.services.ops,
      workspaceId: app.workspaceId,
      enqueue: (plan, trigger) => app.services.orchestrator.enqueueRun(plan, trigger),
    });
    const enqueued = await gate.enqueue(
      {
        agentId: dev.id,
        channelId: channel.id,
        conversationId: channelConversation(app.db, channel.id),
        triggerKind: "mention",
        rootMessageId: uuid(),
        relayDepth: 0,
      },
      {},
    );
    expect(enqueued).toBeNull();
    expect(runs()).toHaveLength(0);
  });

  it("[Review Focus 1] 대기열에 선 런 둘(진행 하나·대기 하나)이 있는 채로 보관하면 둘 다 닫히고 열린 런 0, 대기 런은 보내지 않는다", async () => {
    const { adapter, dev, say, runs, openRuns, archive } = await setup();
    await say("@dev 하나");
    await say("@dev 둘");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    expect(openRuns()).toHaveLength(2);
    const [inflight, queued] = runs();

    expect((await archive(dev.id)).statusCode).toBe(200);
    await vi.waitFor(() => expect(openRuns()).toHaveLength(0));
    expect(runs().map((r) => r?.status)).toEqual(["aborted", "aborted"]);
    // 진행 런만 어댑터에 중단을 보냈고, 대기 런은 끝내 보내지 않았다
    expect(adapter.calls.abort.map((a) => a.runId)).toEqual([inflight?.id]);
    expect(adapter.calls.send.map((s) => s.runId)).toEqual([inflight?.id]);
    expect(queued?.id).toBeDefined();
    expect(runs()).toHaveLength(2);
  });

  it("훑기 전에 대기 런이 디스패치 차례를 받아도 보관한 에이전트면 보내지 않고 「중지」로 닫는다", async () => {
    const { app, adapter, dev, say, runs, openRuns } = await setup();
    await say("@dev 하나");
    await say("@dev 둘");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    // 보관 쓰기만 하고 훑기 전 — 진행 런이 끝나 pump 가 대기 런을 꺼내는 순간
    app.db.$client.prepare("UPDATE agents SET archived_at = ? WHERE id = ?").run(Date.now(), dev.id);
    const [inflight] = runs();
    await app.services.orchestrator.signal(inflight?.id ?? "", {
      kind: "gateway_error",
      code: "X",
      message: "x",
    });
    await vi.waitFor(() => expect(openRuns()).toHaveLength(0));
    expect(runs()[1]?.status).toBe("aborted");
    expect(adapter.calls.send).toHaveLength(1);
  });

  it("걸린 승인이 있는 런을 보관하면 승인은 cancelled 로 닫힌다(계획 판정 PS1)", async () => {
    const { app, adapter, dev, channel, say, runs, archive } = await setup();
    await say("@dev 파일 써줘");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    const createdAt = new Date();
    const approval: ProviderApproval = {
      providerApprovalId: `plugin:${uuid()}`,
      kind: "plugin",
      sessionKey: adapter.sessionKeyFor("dev", channelConversation(app.db, channel.id)),
      providerAgentId: "dev",
      conversationId: channelConversation(app.db, channel.id),
      toolCallId: "toolu_archive",
      toolName: "Write",
      pluginId: "fs",
      title: "Write 실행",
      description: "{}",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      status: "pending",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 120_000).toISOString(),
    };
    adapter.emitApproval(approval);
    await vi.waitFor(() => expect(runs()[0]?.status).toBe("awaiting_approval"));

    await archive(dev.id);
    await vi.waitFor(() => expect(runs()[0]?.status).toBe("aborted"));
    const rows = app.db.$client
      .prepare("SELECT status FROM approvals WHERE run_id = ?")
      .all(runs()[0]?.id) as Array<{
      status: string;
    }>;
    expect(rows).toEqual([{ status: "cancelled" }]);
  });

  it("보관한 에이전트의 run_error 「다시 실행」은 「삭제된 에이전트입니다」로 거절되고 카드는 소비되지 않는다", async () => {
    const { app, adapter, dev, channel, say, runs, archive, restore } = await setup();
    adapter.script(() => {
      throw new AdapterError("ADAPTER_UNAVAILABLE", "plugin is not connected");
    });
    await say("@dev 안녕");
    await vi.waitFor(() => expect(runs()[0]?.status).toBe("error"));
    const [card] = runErrorMessages(app.db, channel.id, runs()[0]?.id ?? "");
    expect(card?.components?.id).toBeDefined();

    await archive(dev.id);
    const press = () =>
      app.services.runs.interact({
        messageId: card?.id as string,
        componentId: card?.components?.id as string,
        itemId: RETRY_RUN_ITEM,
        values: {},
        userId: app.ownerUserId,
      });
    await expect(press()).rejects.toMatchObject({
      status: 409,
      body: { code: "AGENT_ARCHIVED", message: "삭제된 에이전트입니다", details: { agentId: dev.id } },
    });
    const consumed = app.db.$client
      .prepare("SELECT count(*) AS n FROM component_interactions WHERE message_id = ?")
      .get(card?.id) as { n: number };
    expect(consumed.n).toBe(0);
    expect(runs()).toHaveLength(1);

    // 되살리면 같은 카드를 다시 누를 수 있다
    adapter.script((input) => ({ admission: "dispatch", providerRunId: input.runId }));
    await restore(dev.id);
    await press();
    await vi.waitFor(() => expect(runs()).toHaveLength(2));
    expect(runs()[1]?.parentRunId).toBe(runs()[0]?.id);
  });

  it("보관한 에이전트의 늦은 정본은 저장만 한다 — 릴레이·푸시 없음, 되살린 뒤에 온 정본은 지금처럼 릴레이·푸시", async () => {
    const pushes: unknown[] = [];
    const { app, adapter, headers, inject, dev, channel, say, runs, archive, restore } = await setup({
      pushSend: async (sub) => {
        pushes.push(sub);
        return { statusCode: 201 };
      },
    });
    const subscribed = await inject(
      "POST",
      "/api/v1/push/subscriptions",
      {
        endpoint: "https://push.invalid/archive",
        keys: {
          p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
          auth: "tBHItJI5svbpez7KI4CCXg",
        },
      },
      headers,
    );
    expect(subscribed.statusCode).toBe(204);
    await say("@dev 정리해 줘");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    const [run] = runs();
    await archive(dev.id);
    await vi.waitFor(() => expect(runs()[0]?.status).toBe("aborted"));
    const created: Array<{ message: Message; silent?: true }> = [];
    app.bus.on("message.created", (p) => created.push(p));
    const late = (outboundId: string): OutboundMessage => ({
      outboundId,
      conversationId: channelConversation(app.db, channel.id),
      agentId: "dev",
      sessionKey: run?.sessionKey ?? "",
      runId: run?.id ?? "",
      // 릴레이(@fin)와 푸시(@owner)가 날 수 있는 본문
      text: "@fin @owner 늦었지만 정리했습니다",
      attachmentIds: [],
      ts: new Date().toISOString(),
    });

    const ack = await app.orchestrator.onCanonical(late("late-archived"), "openclaw", FAKE_GATEWAY_ID);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ack.messageId).toBeDefined();
    expect(created).toEqual([expect.objectContaining({ silent: true })]);
    expect(created[0]?.message).toMatchObject({ runId: run?.id, authorType: "agent" });
    expect(runs()).toHaveLength(1);
    expect(adapter.calls.send).toHaveLength(1);
    expect(pushes).toEqual([]);

    // 가르는 것은 에이전트의 보관 상태다 — 같은 런이라도 되살린 뒤면 지금처럼 릴레이·푸시한다
    await restore(dev.id);
    await app.orchestrator.onCanonical(late("late-restored"), "openclaw", FAKE_GATEWAY_ID);
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(2));
    await vi.waitFor(() => expect(pushes).toHaveLength(1));
    expect(adapter.calls.send[1]?.sessionKey).toBe(
      adapter.sessionKeyFor("fin", channelConversation(app.db, channel.id)),
    );
  });

  it("[Review Focus 2] 보관 → 되살리기 → 멘션은 같은 agent_sessions 행·세션 키로 런을 만든다", async () => {
    const { app, adapter, dev, channel, say, runs, archive, restore } = await setup();
    await say("@dev 처음");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    const sessionRows = () =>
      app.db.$client
        .prepare(
          "SELECT id, session_key AS sessionKey FROM agent_sessions WHERE channel_id = ? AND agent_id = ?",
        )
        .all(channel.id, dev.id);
    const before = sessionRows();
    expect(before).toHaveLength(1);

    await archive(dev.id);
    await vi.waitFor(() => expect(runs()[0]?.status).toBe("aborted"));
    expect(sessionRows()).toEqual(before);
    expect((await restore(dev.id)).statusCode).toBe(200);

    await say("@dev 다시");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(2));
    expect(sessionRows()).toEqual(before);
    const { sessionKey } = (before as Array<{ sessionKey: string }>)[0] ?? { sessionKey: "" };
    expect(runs()[1]?.sessionKey).toBe(sessionKey);
    expect(adapter.calls.send[1]?.sessionKey).toBe(sessionKey);
  });
});

describe("보관과 채널 멤버(계획 판정 PS3)", () => {
  it("멤버 응답·channel.member.changed·에이전트 헤더 「참여자:」에서 빠지고 channel_members 행은 남는다", async () => {
    const { app, adapter, dev, fin, channel, inject, say, archive } = await setup();
    await archive(dev.id);

    const members = (await inject("GET", `/api/v1/channels/${channel.id}/members`)).json()
      .members as ChannelMember[];
    expect(members.filter((m) => m.memberType === "agent").map((m) => m.memberId)).toEqual([fin.id]);

    const changed: ChannelMember[][] = [];
    app.bus.on("channel.member.changed", (p) => changed.push(p.members));
    const ops = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: "ops",
      handle: "ops",
      name: "ops",
      gatewayId: FAKE_GATEWAY_ID,
    });
    const added = await inject("POST", `/api/v1/channels/${channel.id}/members`, {
      memberType: "agent",
      memberId: ops.id,
    });
    expect(added.statusCode).toBe(201);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.some((m) => m.memberId === dev.id)).toBe(false);
    expect(changed[0]?.some((m) => m.memberId === ops.id)).toBe(true);

    await say("@fin 누가 있어?");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    const handles = adapter.calls.send[0]?.context.participants.map((p) => p.handle);
    expect(handles).toContain("fin");
    expect(handles).not.toContain("dev");

    const rows = app.db.$client
      .prepare("SELECT count(*) AS n FROM channel_members WHERE channel_id = ? AND member_id = ?")
      .get(channel.id, dev.id) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("다른 에이전트가 받는 옛 메시지 속 멘션은 보관한 에이전트도 그 핸들로 풀린다 — 「참여자:」에서만 빠진다", async () => {
    const { adapter, dev, say, archive } = await setup();
    const before = await say("@dev 이거 맡아 줘");
    expect(before.mentions.agents).toEqual([dev.id]);
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    await archive(dev.id);

    await say("@fin dev 가 뭘 맡았지?");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(2));
    const context = adapter.calls.send[1]?.context;
    expect(context?.recentMessages.map((m) => m.text)).toContain("@dev 이거 맡아 줘");
    expect(context?.participants.map((p) => p.handle)).not.toContain("dev");
  });

  it("자동 응답 에이전트를 보관하면 멘션 없는 메시지에 런이 없다", async () => {
    const { app, dev, channel, inject, say, runs, archive } = await setup();
    const patched = await inject("PATCH", `/api/v1/channels/${channel.id}/members/${dev.id}`, {
      autoRespond: true,
    });
    expect(patched.statusCode).toBe(200);
    await archive(dev.id);
    await say("누구든 답해 줘");
    expect(runs()).toHaveLength(0);
    expect(
      app.db.$client.prepare("SELECT auto_respond AS a FROM channel_members WHERE member_id = ?").get(dev.id),
    ).toEqual({
      a: 1,
    });
  });

  it("되살릴 때 같은 채널에 다른 살아 있는 에이전트의 자동 응답이 켜져 있으면 되살린 쪽을 끄고 channel.member.changed 를 낸다", async () => {
    const { app, adapter, dev, fin, channel, inject, say, runs, archive, restore } = await setup();
    const autoRespond = (agentId: string) =>
      inject("PATCH", `/api/v1/channels/${channel.id}/members/${agentId}`, { autoRespond: true });
    expect((await autoRespond(dev.id)).statusCode).toBe(200);
    await archive(dev.id);
    // 보관한 dev 는 멤버 응답에 없어 웹이 fin 을 켤 때 dev 를 끌 수 없다
    expect((await autoRespond(fin.id)).statusCode).toBe(200);

    const changed: { channelId: string; members: ChannelMember[] }[] = [];
    app.bus.on("channel.member.changed", (p) => changed.push(p));
    expect((await restore(dev.id)).statusCode).toBe(200);

    const members = (await inject("GET", `/api/v1/channels/${channel.id}/members`)).json()
      .members as ChannelMember[];
    const auto = (id: string) => members.find((m) => m.memberId === id)?.autoRespond;
    expect([auto(dev.id), auto(fin.id)]).toEqual([false, true]);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.channelId).toBe(channel.id);
    expect(changed[0]?.members.find((m) => m.memberId === dev.id)?.autoRespond).toBe(false);

    await say("누구든 답해 줘");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    expect(runs().map((r) => r?.agentId)).toEqual([fin.id]);
  });

  it("되살릴 때 같은 채널에 다른 자동 응답이 없으면 되살린 쪽 자동 응답이 그대로 켜진다 — channel.member.changed 없음", async () => {
    const { app, adapter, dev, channel, inject, say, runs, archive, restore } = await setup();
    await inject("PATCH", `/api/v1/channels/${channel.id}/members/${dev.id}`, { autoRespond: true });
    await archive(dev.id);

    const changed: unknown[] = [];
    app.bus.on("channel.member.changed", (p) => changed.push(p));
    await restore(dev.id);

    const members = (await inject("GET", `/api/v1/channels/${channel.id}/members`)).json()
      .members as ChannelMember[];
    expect(members.find((m) => m.memberId === dev.id)?.autoRespond).toBe(true);
    expect(changed).toHaveLength(0);
    await say("누구든 답해 줘");
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(1));
    expect(runs().map((r) => r?.agentId)).toEqual([dev.id]);
  });

  it("다른 에이전트의 자동 응답도 보관된 채로면 되살린 쪽을 끄지 않는다", async () => {
    const { dev, fin, channel, inject, archive, restore } = await setup();
    await inject("PATCH", `/api/v1/channels/${channel.id}/members/${dev.id}`, { autoRespond: true });
    await archive(dev.id);
    await inject("PATCH", `/api/v1/channels/${channel.id}/members/${fin.id}`, { autoRespond: true });
    await archive(fin.id);
    await restore(dev.id);

    const members = (await inject("GET", `/api/v1/channels/${channel.id}/members`)).json()
      .members as ChannelMember[];
    expect(members.find((m) => m.memberId === dev.id)?.autoRespond).toBe(true);
  });

  it("채널이 여럿이면 다른 자동 응답이 겹친 채널에서만 되살린 쪽을 끄고 그 채널에만 changed 를 낸다", async () => {
    const { app, dev, fin, channel, inject, archive, restore } = await setup();
    const other = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "archive-other",
    });
    addMember(app.db, other.id, { memberType: "agent", memberId: dev.id }, app.logger);
    const autoRespond = (channelId: string, agentId: string) =>
      inject("PATCH", `/api/v1/channels/${channelId}/members/${agentId}`, { autoRespond: true });
    expect((await autoRespond(channel.id, dev.id)).statusCode).toBe(200);
    expect((await autoRespond(other.id, dev.id)).statusCode).toBe(200);
    await archive(dev.id);
    // fin 은 첫 채널에서만 켠다 — 겹침은 그 채널 하나
    expect((await autoRespond(channel.id, fin.id)).statusCode).toBe(200);

    const changed: string[] = [];
    app.bus.on("channel.member.changed", (p) => changed.push(p.channelId));
    expect((await restore(dev.id)).statusCode).toBe(200);

    const devAuto = async (channelId: string) =>
      ((await inject("GET", `/api/v1/channels/${channelId}/members`)).json().members as ChannelMember[]).find(
        (m) => m.memberId === dev.id,
      )?.autoRespond;
    expect(await devAuto(channel.id)).toBe(false);
    expect(await devAuto(other.id)).toBe(true);
    expect(changed).toEqual([channel.id]);
  });

  it("이미 살아 있는 에이전트를 되살리기해도 겹친 자동 응답을 건드리지 않고 changed 도 없다", async () => {
    const { app, dev, fin, channel, inject, restore } = await setup();
    for (const a of [dev, fin])
      await inject("PATCH", `/api/v1/channels/${channel.id}/members/${a.id}`, { autoRespond: true });

    const changed: unknown[] = [];
    app.bus.on("channel.member.changed", (p) => changed.push(p));
    expect((await restore(dev.id)).statusCode).toBe(200);

    const members = (await inject("GET", `/api/v1/channels/${channel.id}/members`)).json()
      .members as ChannelMember[];
    expect(
      members
        .filter((m) => m.autoRespond)
        .map((m) => m.memberId)
        .sort(),
    ).toEqual([dev.id, fin.id].sort());
    expect(changed).toHaveLength(0);
  });
});

describe("보관과 러너", () => {
  it("러너 에이전트를 보관하면 그 러너가 붙어 있어도 런을 보내지 않는다 — 되살리면 다시 받는다", async () => {
    const { app, archive, restore, headers, inject } = await setup({ runnerAdapter: true });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const issued = await inject("POST", "/api/v1/setup/runner-tokens", { label: "laptop" }, headers);
    expect(issued.statusCode).toBe(201);
    const { agent: coder } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: "coder",
      runnerTokenId: issued.json().record.id as string,
    });
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "runner",
    });
    addMember(app.db, channel.id, { memberType: "agent", memberId: coder.id }, app.logger);
    await archive(coder.id);

    const runner = await startFakeRunner({ url: app.url, token: issued.json().token as string });
    runners.push(runner);
    await vi.waitFor(() => expect(runner.helloResult).toBeDefined());

    const message = createUserMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      authorId: app.ownerUserId,
      bodyMd: "@coder 해 줘",
      clientMsgId: "runner-1",
    });
    await app.services.router.routeMessage(message);
    expect(app.db.$client.prepare("SELECT count(*) AS n FROM runs WHERE agent_id = ?").get(coder.id)).toEqual(
      { n: 0 },
    );
    expect(runner.runStarts).toHaveLength(0);

    await restore(coder.id);
    const again = createUserMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      authorId: app.ownerUserId,
      bodyMd: "@coder 이제 해 줘",
      clientMsgId: "runner-2",
    });
    await app.services.router.routeMessage(again);
    await vi.waitFor(() => expect(runner.runStarts).toHaveLength(1));
  });
});
