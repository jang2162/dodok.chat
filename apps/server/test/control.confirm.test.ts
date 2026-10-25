/**
 * 확인 카드(제어 MCP 스펙 「확인 카드」 장) — 채널 안 에이전트의 쓰기는 그 런을 시킨 사람 본인이 허용해야 실행된다. 결정은 본인만·
 * allow-once 만, 10분 만료, 런이 끝나면 cancelled, 허용 때 역할을 다시 읽는다(Review Focus 2). 결정은 실제 wire(approval.resolve)로 한다
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Approval, CONTROL_CONFIRM_TTL_BRIDGE_MS, type ControlResult } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { approvals, memberships, messages, opsEvents } from "../src/db/schema.sqlite";
import { getApprovalConnectionId } from "../src/modules/approvals/store";
import { addMember, getChannel } from "../src/modules/channels/service";
import { userHandle } from "../src/modules/control/confirm";
import { createAgentMessage, createUserMessage } from "../src/modules/messages/service";
import { getRun, insertRun, listRunEvents, updateRun } from "../src/modules/runs/store";
import { josa } from "../src/util/josa";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { errorOf, expectOk, newAgent, newChannel, openRun, pat } from "./helpers/control";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { connectWire, type WireClient } from "./helpers/wire";
import { channelConversation } from "./helpers/seed";

type Pending = { result: Promise<ControlResult>; settled(): boolean };

/** 부른 뒤 아직 끝나지 않았는지 볼 수 있게 감싼다 */
function track(result: Promise<ControlResult>): Pending {
  let done = false;
  void result.then(() => (done = true));
  return { result, settled: () => done };
}

/** 그 런의 확인 카드가 열릴 때까지 — 카드는 call 안에서 동기로 열리지만 마이크로태스크 뒤라 행을 기다린다 */
async function cardOf(app: App, runId: string): Promise<Approval> {
  let card: Approval | undefined;
  await vi.waitFor(() => {
    const row = app.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.runId, runId), eq(approvals.kind, "dodok_control")))
      .get();
    expect(row).toBeDefined();
    card = app.services.approvals
      .pendingForChannel(getRun(app.db, runId)?.channelId ?? "")
      .find((a) => a.id === row?.id);
    expect(card).toBeDefined();
  });
  return card as Approval;
}

describe("확인 카드", () => {
  let app: App;
  let owner: string;
  let ownerHandle: string;
  let ownerToken: string;
  let mia: { id: string; token: string };
  let ada: { id: string; token: string };
  const sockets: WireClient[] = [];
  let clock = 0;

  beforeAll(async () => {
    app = await bootTestApp({}, { adapters: [new FakeAdapter()], limitClock: () => clock });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    owner = app.ownerUserId;
    ownerHandle = userHandle(app.db, owner) ?? "";
    ({ token: ownerToken } = await login(app));
    mia = await userWithRole(app, "mia", "member");
    ada = await userWithRole(app, "ada", "admin");
  });
  beforeEach(() => {
    clock += 60_000;
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  const wire = async (token: string) => {
    const socket = await connectWire(app, token);
    sockets.push(socket);
    return socket;
  };
  const decide = async (token: string, approvalId: string, decision: string) =>
    (await wire(token)).emitWithAck("approval.resolve", { approvalId, decision } as never);

  it("에이전트 주체의 쓰기는 카드를 연다 — 시킨 사람·allow-once·deny 만, 연결 없음, 런은 awaiting_approval, 호출은 기다린다", async () => {
    const { channel, agent, run, principal } = openRun(app, owner);
    const requested = vi.fn();
    const off = app.bus.on("approval.requested", requested);
    const call = track(
      app.control.call(principal, "update_channel", { channelId: channel.id, name: "새이름" }),
    );
    const card = await cardOf(app, run.id);
    off();
    expect(card).toMatchObject({
      kind: "dodok_control",
      status: "pending",
      requestedBy: owner,
      runId: run.id,
      agentId: agent.id,
      channelId: channel.id,
      toolName: "update_channel",
      allowedDecisions: ["allow-once", "deny"],
      title: `@${agent.handle} ${josa(agent.handle, "이", "가")} #${channel.name} 의 이름·주제를 바꾸려 합니다`,
      description: "이름: 새이름",
    });
    expect(Date.parse(card.expiresAt) - Date.parse(card.createdAt)).toBe(600_000);
    expect(getApprovalConnectionId(app.db, card.id)).toBeNull();
    expect(requested).toHaveBeenCalledWith({ approval: card });
    await vi.waitFor(() => expect(getRun(app.db, run.id)?.status).toBe("awaiting_approval"));
    expect(call.settled()).toBe(false);
    expect(getChannel(app.db, channel.id)?.name).toBe(channel.name);

    // 본인이 허용 → 실행, 런은 대기 직전(tool)으로
    const ack = await decide(ownerToken, card.id, "allow-once");
    expect(ack).toMatchObject({ ok: true });
    expect(expectOk(await call.result)).toMatchObject({ channel: { id: channel.id, name: "새이름" } });
    expect(getRun(app.db, run.id)?.status).toBe("tool");
    expect(app.db.select().from(approvals).where(eq(approvals.id, card.id)).get()).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      decidedBy: owner,
    });
    const notice = app.db
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channel.id), eq(messages.kind, "system")))
      .all()
      .at(-1);
    expect(notice?.bodyMd).toMatch(
      new RegExp(
        `^@${ownerHandle} 의 요청으로 @${agent.handle} ${josa(agent.handle, "이", "가")} 채널 이름·주제를 바꿨습니다$`,
      ),
    );
    const event = app.db
      .select()
      .from(opsEvents)
      .where(and(eq(opsEvents.kind, "control_change"), eq(opsEvents.key, `control:update_channel:${owner}`)))
      .get();
    expect(event?.detail).toEqual({
      userId: owner,
      via: "agent",
      agentId: agent.id,
      tool: "update_channel",
      channelId: channel.id,
      targetAgentId: null,
    });
    expect(listRunEvents(app.db, run.id, 0).map((e) => e.type)).toEqual(
      expect.arrayContaining(["APPROVAL_REQUESTED", "APPROVAL_RESOLVED"]),
    );
  });

  it("카드 기한 — OpenClaw(브리지) 주체는 5분, 러너 주체는 10분", async () => {
    const bridge = openRun(app, owner);
    const runner = openRun(app, owner);
    const calls = [
      track(
        app.control.call({ ...bridge.principal, bridge: true }, "update_channel", {
          channelId: bridge.channel.id,
          name: "브리지기한",
        }),
      ),
      track(
        app.control.call(runner.principal, "update_channel", {
          channelId: runner.channel.id,
          name: "러너기한",
        }),
      ),
    ];
    const ttl = (c: Approval) => Date.parse(c.expiresAt) - Date.parse(c.createdAt);
    const bridgeCard = await cardOf(app, bridge.run.id);
    const runnerCard = await cardOf(app, runner.run.id);
    expect(ttl(bridgeCard)).toBe(CONTROL_CONFIRM_TTL_BRIDGE_MS);
    expect(ttl(bridgeCard)).toBe(300_000);
    expect(ttl(runnerCard)).toBe(600_000);
    // 카드를 닫아 호출이 매달리지 않게 한다
    await decide(ownerToken, bridgeCard.id, "deny");
    await decide(ownerToken, runnerCard.id, "deny");
    await Promise.all(calls.map((c) => c.result));
  });

  it("결정은 시킨 사람 본인만 — 남(admin)의 결정은 FORBIDDEN 이고 카드는 그대로, 「항상 허용」은 VALIDATION", async () => {
    const { channel, run, principal } = openRun(app, owner);
    const call = track(app.control.call(principal, "update_channel", { channelId: channel.id, name: "x" }));
    const card = await cardOf(app, run.id);
    expect(await decide(ada.token, card.id, "allow-once")).toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "이 확인은 그 일을 시킨 사람만 할 수 있다" },
    });
    expect(await decide(ownerToken, card.id, "allow-always")).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(app.db.select().from(approvals).where(eq(approvals.id, card.id)).get()?.status).toBe("pending");
    expect(call.settled()).toBe(false);

    // 본인의 거절 → 호출은 FORBIDDEN 「@owner 가 거절했습니다」, 아무것도 안 바뀐다
    expect(await decide(ownerToken, card.id, "deny")).toMatchObject({ ok: true });
    expect(errorOf(await call.result)).toEqual({
      code: "FORBIDDEN",
      message: `@${ownerHandle} ${josa(ownerHandle, "이", "가")} 거절했습니다`,
    });
    expect(getChannel(app.db, channel.id)?.name).toBe(channel.name);
    expect(app.db.select().from(approvals).where(eq(approvals.id, card.id)).get()).toMatchObject({
      status: "denied",
      decidedBy: owner,
    });
  });

  it("member 가 시킨 런의 카드는 그 member 가 결정한다 — wire 가 admin 을 요구하지 않는다", async () => {
    const { channel, run, principal } = openRun(app, mia.id, {
      channel: newChannel(app, { members: [mia.id] }),
    });
    const call = track(
      app.control.call(principal, "update_channel", { channelId: channel.id, topic: "mia 의 주제" }),
    );
    const card = await cardOf(app, run.id);
    expect(card.requestedBy).toBe(mia.id);
    expect(await decide(ownerToken, card.id, "allow-once")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(await decide(mia.token, card.id, "allow-once")).toMatchObject({ ok: true });
    expectOk(await call.result);
    expect(getChannel(app.db, channel.id)?.topic).toBe("mia 의 주제");
  });

  it("Review Focus 2 — 기다리는 사이 시킨 사람이 강등되면 허용해도 FORBIDDEN, 아무것도 안 바뀐다", async () => {
    const boss = await userWithRole(app, `boss${uuid().slice(0, 4)}`, "admin");
    const { channel, run, principal } = openRun(app, boss.id);
    const call = track(
      app.control.call(principal, "set_channel_prompt", { channelId: channel.id, prompt: "새 규칙" }),
    );
    const card = await cardOf(app, run.id);
    expect(card.description).toBe("새 채널 프롬프트: 새 규칙");
    app.db.update(memberships).set({ role: "member" }).where(eq(memberships.userId, boss.id)).run();
    expect(await decide(boss.token, card.id, "allow-once")).toMatchObject({ ok: true });
    expect(errorOf(await call.result)).toEqual({
      code: "FORBIDDEN",
      message: `이 일은 admin 이상만 할 수 있습니다(시킨 사람: @${userHandle(app.db, boss.id)}, member)`,
    });
    expect(getChannel(app.db, channel.id)?.prompt).toBeUndefined();
    const system = app.db
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channel.id), eq(messages.kind, "system")))
      .all();
    expect(system).toEqual([]);
  });

  it("Review Focus 2 — 기다리는 사이 런이 끝나면 카드는 cancelled, 호출은 EXPIRED(오케스트레이터 런 종료 배선)", async () => {
    const { channel, run, principal } = openRun(app, owner);
    const call = track(
      app.control.call(principal, "update_channel", { channelId: channel.id, name: "끝난런" }),
    );
    const card = await cardOf(app, run.id);
    await app.orchestrator.signal(run.id, { kind: "gateway_aborted" });
    expect(getRun(app.db, run.id)?.status).toBe("aborted");
    expect(errorOf(await call.result)).toEqual({
      code: "EXPIRED",
      message: "런이 끝나 확인 카드가 닫혔습니다",
    });
    expect(app.db.select().from(approvals).where(eq(approvals.id, card.id)).get()).toMatchObject({
      status: "cancelled",
      reason: "run-aborted",
    });
    // 종료 전에 닫아 타임라인에 남는다
    expect(listRunEvents(app.db, run.id, 0).map((e) => e.type)).toContain("APPROVAL_RESOLVED");
    expect(getChannel(app.db, channel.id)?.name).toBe(channel.name);
    // 끝난 런에는 새 카드를 열지 않는다
    expect(
      errorOf(await app.control.call(principal, "update_channel", { channelId: channel.id, name: "y" })).code,
    ).toBe("NOT_FOUND");
  });

  it("카드 출처 — 시킨 사람과 시작한 글, 끝난 런의 이름으로 온 릴레이 글이면 주의 줄", async () => {
    const channel = newChannel(app, { members: [mia.id] });
    const a = newAgent(app);
    const ops = newAgent(app);
    for (const agent of [a, ops])
      addMember(app.db, channel.id, { memberType: "agent", memberId: agent.id }, app.logger);
    const origin = createUserMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      authorId: mia.id,
      bodyMd: `@${a.handle} 채널 주제 좀 정리해 줘`,
      clientMsgId: `l2-${channel.id}`,
    });
    const runOf = (agentId: string, triggerMessageId: string, requestedBy: string) =>
      insertRun(app.db, {
        channelId: channel.id,
        conversationId: channelConversation(app.db, channel.id),
        agentId,
        triggerKind: "mention",
        triggerMessageId,
        rootMessageId: origin.id,
        relayDepth: 0,
        sessionKey: `agent:${agentId}:dodok:channel:${channelConversation(app.db, channel.id)}`,
        connectionId: FAKE_GATEWAY_ID,
        requestedBy,
        createdAt: new Date(),
      });
    // a 의 런은 끝났고, a 의 글은 그 뒤에 왔다
    const first = runOf(a.id, origin.id, mia.id);
    updateRun(app.db, first.id, { status: "done", endedAt: new Date(Date.now() - 60_000) });
    const relayed = createAgentMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      agentId: a.id,
      runId: first.id,
      externalId: `o-${first.id}`,
      bodyMd: `@${ops.handle} 주제 바꿔`,
    });
    const second = updateRun(app.db, runOf(ops.id, relayed.id, mia.id).id, { status: "tool" });
    const call = track(
      app.control.call(
        { userId: mia.id, via: "agent", agentId: ops.id, runId: second.id },
        "update_channel",
        { channelId: channel.id, topic: "정리" },
      ),
    );
    const card = await cardOf(app, second.id);
    expect(card.detail?.split("\n")).toEqual([
      "시킨 사람: @mia",
      `주의: @${a.handle} 의 글은 그 런이 끝난 뒤에 왔습니다 — 직접 시킨 일인지 확인하세요`,
      `시작한 글: @mia · #${channel.name} · ${origin.seq}번째 글 「@${a.handle} 채널 주제 좀 정리해 줘」`,
      `릴레이: @${a.handle}`,
    ]);
    expect(await decide(mia.token, card.id, "deny")).toMatchObject({ ok: true });
    expect(errorOf(await call.result).code).toBe("FORBIDDEN");
  });

  it("카드 출처 — 앞 런이 열린 채 쓴 릴레이 글이면 릴레이 줄만, 주의 줄 없음", async () => {
    const channel = newChannel(app, { members: [mia.id] });
    const a = newAgent(app);
    const ops = newAgent(app);
    for (const agent of [a, ops])
      addMember(app.db, channel.id, { memberType: "agent", memberId: agent.id }, app.logger);
    const origin = createUserMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      authorId: mia.id,
      bodyMd: `@${a.handle} 주제 정리 부탁`,
      clientMsgId: `relay-ok-${channel.id}`,
    });
    const runOf = (agentId: string, triggerMessageId: string) =>
      insertRun(app.db, {
        channelId: channel.id,
        conversationId: channelConversation(app.db, channel.id),
        agentId,
        triggerKind: "mention",
        triggerMessageId,
        rootMessageId: origin.id,
        relayDepth: 0,
        sessionKey: `agent:${agentId}:dodok:channel:${channelConversation(app.db, channel.id)}`,
        connectionId: FAKE_GATEWAY_ID,
        requestedBy: mia.id,
        createdAt: new Date(),
      });
    // a 의 런이 열려 있을 때 글을 쓰고, 그 뒤에 끝났다
    const first = updateRun(app.db, runOf(a.id, origin.id).id, { status: "tool" });
    const relayed = createAgentMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      agentId: a.id,
      runId: first.id,
      externalId: `o-${first.id}`,
      bodyMd: `@${ops.handle} 주제 바꿔`,
    });
    updateRun(app.db, first.id, {
      status: "done",
      endedAt: new Date(Date.parse(relayed.createdAt) + 1_000),
    });
    const second = updateRun(app.db, runOf(ops.id, relayed.id).id, { status: "tool" });
    const call = track(
      app.control.call(
        { userId: mia.id, via: "agent", agentId: ops.id, runId: second.id },
        "update_channel",
        { channelId: channel.id, topic: "정리" },
      ),
    );
    const card = await cardOf(app, second.id);
    expect(card.detail?.split("\n")).toEqual([
      "시킨 사람: @mia",
      `시작한 글: @mia · #${channel.name} · ${origin.seq}번째 글 「@${a.handle} 주제 정리 부탁」`,
      `릴레이: @${a.handle}`,
    ]);
    expect(await decide(mia.token, card.id, "deny")).toMatchObject({ ok: true });
    expect(errorOf(await call.result).code).toBe("FORBIDDEN");
  });

  it("허용 뒤 상태를 다시 본다 — 런은 채널 A, 도구는 채널 B, 기다리는 사이 B 가 보관되면 CHANNEL_ARCHIVED, 아무것도 안 바뀐다", async () => {
    const { channel: home, run, principal } = openRun(app, owner);
    const target = newChannel(app);
    const call = track(
      app.control.call(principal, "update_channel", { channelId: target.id, name: "보관뒤이름" }),
    );
    const card = await cardOf(app, run.id);
    // B 의 보관은 B 의 런만 멈춘다 — A 의 런과 카드는 산다
    const archived = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/channels/${target.id}/archive`,
      headers: { authorization: `Bearer ${ada.token}` },
    });
    expect(archived.statusCode).toBe(200);
    expect(app.db.select().from(approvals).where(eq(approvals.id, card.id)).get()?.status).toBe("pending");
    expect(await decide(ownerToken, card.id, "allow-once")).toMatchObject({ ok: true });
    expect(errorOf(await call.result)).toEqual({ code: "CHANNEL_ARCHIVED", message: "보관된 채널입니다" });
    expect(getChannel(app.db, target.id)?.name).toBe(target.name);
    for (const channelId of [home.id, target.id]) {
      const system = app.db
        .select()
        .from(messages)
        .where(and(eq(messages.channelId, channelId), eq(messages.kind, "system")))
        .all();
      expect(system).toEqual([]);
    }
  });

  it("wire 결정 — 소켓이 붙은 채 시킨 사람이 비활성화되면 FORBIDDEN, 카드는 그대로", async () => {
    const leaver = await userWithRole(app, `leaver${uuid().slice(0, 4)}`, "member");
    const { channel, run, principal } = openRun(app, leaver.id, {
      channel: newChannel(app, { members: [leaver.id] }),
    });
    const socket = await wire(leaver.token);
    const call = track(
      app.control.call(principal, "update_channel", { channelId: channel.id, topic: "떠남" }),
    );
    const card = await cardOf(app, run.id);
    app.db
      .update(memberships)
      .set({ deactivatedAt: new Date() })
      .where(eq(memberships.userId, leaver.id))
      .run();
    expect(
      await socket.emitWithAck("approval.resolve", { approvalId: card.id, decision: "allow-once" } as never),
    ).toEqual({ ok: false, error: { code: "FORBIDDEN", message: "워크스페이스 멤버가 아니다" } });
    expect(app.db.select().from(approvals).where(eq(approvals.id, card.id)).get()?.status).toBe("pending");
    expect(call.settled()).toBe(false);
    expect(getChannel(app.db, channel.id)?.topic).toBeUndefined();
    await app.orchestrator.signal(run.id, { kind: "gateway_aborted" });
    expect(errorOf(await call.result).code).toBe("EXPIRED");
  });

  it("사건은 같은 사람·같은 도구만 묶이고, 묶여도 앞 기록의 에이전트·채널이 남지 않는다", async () => {
    const eventsOf = (userId: string) =>
      app.db
        .select()
        .from(opsEvents)
        .where(
          and(eq(opsEvents.kind, "control_change"), eq(opsEvents.key, `control:update_channel:${userId}`)),
        )
        .all();
    const before = eventsOf(owner).at(0)?.count ?? 0;
    // 에이전트 주체(owner 가 시킨 런)가 채널 A 를 바꾼다
    const { channel: a, run, principal } = openRun(app, owner);
    const call = track(app.control.call(principal, "update_channel", { channelId: a.id, name: "r1-a" }));
    const card = await cardOf(app, run.id);
    expect(await decide(ownerToken, card.id, "allow-once")).toMatchObject({ ok: true });
    expectOk(await call.result);
    // 같은 사람이 개인 토큰으로 채널 B 를 바꾼다 — 같은 줄로 묶이되 agentId 는 남지 않는다
    const b = newChannel(app);
    expectOk(await app.control.call(pat(owner), "update_channel", { channelId: b.id, name: "r1-b" }));
    const ownerRows = eventsOf(owner);
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0]?.count).toBe(before + 2);
    expect(ownerRows[0]?.detail).toEqual({
      userId: owner,
      via: "pat",
      agentId: null,
      tool: "update_channel",
      channelId: b.id,
      targetAgentId: null,
    });
    // 다른 사람의 변경은 다른 줄 — owner 의 줄은 그대로
    const c = newChannel(app);
    expectOk(await app.control.call(pat(ada.id), "update_channel", { channelId: c.id, name: "r1-c" }));
    expect(eventsOf(owner)).toEqual(ownerRows);
    const adaRows = eventsOf(ada.id);
    expect(adaRows).toHaveLength(1);
    expect(adaRows[0]?.detail).toEqual({
      userId: ada.id,
      via: "pat",
      agentId: null,
      tool: "update_channel",
      channelId: c.id,
      targetAgentId: null,
    });
  });
});

describe("확인 카드 — 만료", () => {
  let app: App;

  beforeAll(async () => {
    app = await bootTestApp({}, { adapters: [new FakeAdapter()], controlConfirmTtlMs: 150 });
  });
  afterAll(async () => {
    await app.close();
  });

  it("기한이 지나면 카드는 expired, 호출은 EXPIRED, 런은 대기 직전 상태로", async () => {
    const { channel, run, principal } = openRun(app, app.ownerUserId);
    const result = await app.control.call(principal, "update_channel", {
      channelId: channel.id,
      name: "늦음",
    });
    expect(errorOf(result)).toEqual({ code: "EXPIRED", message: "확인 카드가 만료되었습니다" });
    const card = app.db.select().from(approvals).where(eq(approvals.runId, run.id)).get();
    expect(card).toMatchObject({ kind: "dodok_control", status: "expired", reason: "timeout" });
    expect(getRun(app.db, run.id)?.status).toBe("tool");
    expect(getChannel(app.db, channel.id)?.name).toBe(channel.name);
  });
});

describe("확인 카드 — 재시작", () => {
  let app: App;

  beforeAll(async () => {
    app = await bootTestApp({}, { adapters: [new FakeAdapter()] });
  });
  afterAll(async () => {
    await app.close();
  });

  it("이 프로세스가 기다리지 않는 카드(재시작 전에 연 것)도 recoverOnBoot 가 런을 닫을 때 cancelled", async () => {
    const { channel, agent, run } = openRun(app, app.ownerUserId);
    const createdAt = new Date();
    // 확인 서비스를 거치지 않고 행만 연다 — 재시작 전 프로세스가 열고 사라진 카드
    const card = app.services.approvals.openControl({
      runId: run.id,
      channelId: channel.id,
      conversationId: channelConversation(app.db, channel.id),
      agentId: agent.id,
      requestedBy: app.ownerUserId,
      toolName: "update_channel",
      title: "재시작 전 카드",
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 600_000),
    });
    expect(app.db.select().from(approvals).where(eq(approvals.id, card.id)).get()?.status).toBe("pending");
    await app.orchestrator.recoverOnBoot();
    expect(getRun(app.db, run.id)?.status).not.toBe("tool");
    expect(app.db.select().from(approvals).where(eq(approvals.id, card.id)).get()).toMatchObject({
      status: "cancelled",
      reason: "run-aborted",
    });
    expect(app.services.approvals.pendingForChannel(channel.id).map((a) => a.id)).not.toContain(card.id);
  });
});
