/**
 * 멀티 Gateway 스펙 「테스트·검증」 절 서버 통합 — 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway·플러그인 둘(「사무실」·「집」) + wire 클라이언트.
 * 두 Gateway 에 같은 id `main` 을 두고 핸들 main-office·main-home 으로 같은 채널에서 부른다(세션 키가 글자까지 같다).
 * 실제 시계. 기다림은 전부 wire 이벤트(WireLog.until)로 한다.
 */
import type { Agent, Channel, Message } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvals, runs } from "../src/db/schema.sqlite";
import { createScenario, type ScenarioAgent } from "./fakes/scenario";
import { bootLiveApp, type LiveApp, type LiveGateway } from "./helpers/live-app";
import { PDF_BYTES } from "./helpers/png";
import { openChannelWire, resolveApproval, sendMessage, type WireLog } from "./helpers/scenario-steps";
import type { WireClient } from "./helpers/wire";
import { channelConversation } from "./helpers/seed";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const OFFICE_AGENTS = [{ id: "main", name: "main" }, { id: "dev" }];
const HOME_AGENTS = [{ id: "main", name: "main" }, { id: "dev" }];
/** 두 Gateway 가 우연히 같은 승인 id 를 낸다 */
const SAME_APPROVAL_ID = "plugin:same-on-both";
const APPROVAL_TTL_MS = 60_000;
const RETRY_ITEM = "retry_run";

describe("멀티 Gateway 통합 — 가짜 Gateway·플러그인 둘", () => {
  let live: LiveApp;
  let office: LiveGateway;
  let home: LiveGateway;
  const sockets: WireClient[] = [];

  beforeEach(async () => {
    live = await bootLiveApp({
      gatewayName: "사무실",
      agents: OFFICE_AGENTS,
      extraGateways: [{ name: "집", agents: HOME_AGENTS }],
    });
    [office, home] = live.gateways as [LiveGateway, LiveGateway];
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  async function api<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: object,
  ): Promise<{ status: number; body: T }> {
    const res = await live.app.fastify.inject({
      method,
      url: `/api/v1${url}`,
      headers: live.auth.headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: res.statusCode, body: res.json() as T };
  }

  async function ok<T>(what: string, res: Promise<{ status: number; body: T }>): Promise<T> {
    const { status, body } = await res;
    if (status >= 300) throw new Error(`${what} → ${status} ${JSON.stringify(body)}`);
    return body;
  }

  async function registerAgent(
    gateway: LiveGateway,
    providerAgentId: string,
    handle: string,
  ): Promise<Agent> {
    const { agent } = await ok(
      `POST /agents ${handle}`,
      api<{ agent: Agent }>("POST", "/agents", {
        providerAgentId,
        handle,
        name: handle,
        gatewayId: gateway.gatewayId,
      }),
    );
    return agent;
  }

  async function addMember(channelId: string, agent: Agent): Promise<void> {
    await ok(
      `POST members ${agent.handle}`,
      api("POST", `/channels/${channelId}/members`, { memberType: "agent", memberId: agent.id }),
    );
  }

  /** 채널 하나에 main-office·main-home 을 넣고 wire 를 연다 */
  async function twoMains(opts: { relay?: boolean } = {}) {
    const { channel } = await ok(
      "POST /channels",
      api<{ channel: Channel }>("POST", "/channels", { name: "two-mains" }),
    );
    const mainOffice = await registerAgent(office, "main", "main-office");
    const mainHome = await registerAgent(home, "main", "main-home");
    await addMember(channel.id, mainOffice);
    await addMember(channel.id, mainHome);
    if (opts.relay) {
      await ok(
        "PATCH relayPolicy",
        api("PATCH", `/channels/${channel.id}`, { relayPolicy: { maxRelayTurns: 2, allowPairs: "all" } }),
      );
    }
    const log = await openChannelWire(live, channel.id, sockets);
    return { channel, mainOffice, mainHome, log };
  }

  function scenarios(agents: { office: Record<string, ScenarioAgent>; home: Record<string, ScenarioAgent> }) {
    return {
      office: createScenario({ gateway: office.gateway, plugin: office.plugin, agents: agents.office }),
      home: createScenario({ gateway: home.gateway, plugin: home.plugin, agents: agents.home }),
    };
  }

  /** 그 에이전트의 아직 안 본 런(queued 로 처음 보인 것) */
  function runOf(log: WireLog, agentId: string, seen: ReadonlySet<string> = new Set()) {
    return log.until(
      () => log.states.find((s) => s.agentId === agentId && !seen.has(s.id)),
      `에이전트 ${agentId} 의 런`,
    );
  }

  const runRow = (runId: string) => live.app.db.select().from(runs).where(eq(runs.id, runId)).get();
  const agentReply = (log: WireLog, agentId: string, body: string) =>
    log.until(
      () => log.created.find((m) => m.authorType === "agent" && m.authorId === agentId && m.bodyMd === body),
      `${agentId} 의 답 「${body}」`,
    );
  const approvalResolves = (gateway: LiveGateway) =>
    gateway.gateway.requests.filter((r) => r.method === "approval.resolve").map((r) => r.params);

  it("두 main 에 각각 멘션 — 같은 세션 키·같은 승인 id 여도 승인·답·런이 맞는 에이전트와 Gateway 로, 대기열이 서로 막지 않는다", async () => {
    const { channel, mainOffice, mainHome, log } = await twoMains();
    const approval = { approvalId: SAME_APPROVAL_ID, ttlMs: APPROVAL_TTL_MS };
    const sc = scenarios({
      office: { main: () => ({ reply: "사무실 답", deltas: ["사무실 ", "답"], approval }) },
      home: { main: () => ({ reply: "집 답", deltas: ["집 ", "답"], approval }) },
    });

    await sendMessage(log.socket, channel.id, "@main-office 해 주세요");
    const officeRun = await runOf(log, mainOffice.id);
    const officeApproval = await log.until(
      () => log.approvals.find((a) => a.runId === officeRun.id),
      "사무실 승인 요청",
    );
    // 사무실 런은 승인을 기다리는 채 — 같은 세션 키의 집 런이 그 뒤에 줄 서지 않는다
    await sendMessage(log.socket, channel.id, "@main-home 해 주세요");
    const homeRun = await runOf(log, mainHome.id);
    const homeApproval = await log.until(
      () => log.approvals.find((a) => a.runId === homeRun.id),
      "집 승인 요청",
    );
    expect(officeApproval.id).not.toBe(homeApproval.id);
    expect([officeApproval.agentId, homeApproval.agentId]).toEqual([mainOffice.id, mainHome.id]);
    const approvalRows = live.app.db
      .select()
      .from(approvals)
      .where(eq(approvals.providerApprovalId, SAME_APPROVAL_ID))
      .all();
    expect(approvalRows.map((r) => [r.connectionId, r.runId]).sort()).toEqual(
      [
        [office.gatewayId, officeRun.id],
        [home.gatewayId, homeRun.id],
      ].sort(),
    );

    // 집만 허용 → 집 런이 끝까지 간다. 사무실 런은 그대로 기다린다
    await resolveApproval(log.socket, homeApproval.id, "allow-once");
    expect((await log.terminal(homeRun.id)).status).toBe("done");
    await agentReply(log, mainHome.id, "집 답");
    expect(log.statesOf(officeRun.id).at(-1)?.status).not.toBe("done");
    expect(approvalResolves(home)).toEqual([
      expect.objectContaining({ id: SAME_APPROVAL_ID, decision: "allow-once" }),
    ]);
    expect(approvalResolves(office)).toEqual([]);

    await resolveApproval(log.socket, officeApproval.id, "deny");
    expect((await log.terminal(officeRun.id)).status).toBe("done");
    await agentReply(log, mainOffice.id, "사무실 답");
    expect(approvalResolves(office)).toEqual([
      expect.objectContaining({ id: SAME_APPROVAL_ID, decision: "deny" }),
    ]);

    // 각 플러그인은 자기 런 하나만 받았고, 런은 자기 연결에 남는다
    expect(office.plugin.received.map((d) => [d.agentId, d.runId])).toEqual([["main", officeRun.id]]);
    expect(home.plugin.received.map((d) => [d.agentId, d.runId])).toEqual([["main", homeRun.id]]);
    expect(office.plugin.received[0]?.sessionKey).toBe(home.plugin.received[0]?.sessionKey);
    expect(runRow(officeRun.id)?.connectionId).toBe(office.gatewayId);
    expect(runRow(homeRun.id)?.connectionId).toBe(home.gatewayId);
    // 런 이벤트(델타)도 자기 런으로 — 상대 Gateway 의 델타가 섞이지 않는다
    const deltas = (runId: string) =>
      log
        .eventsOf(runId)
        .flatMap((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? [e.delta] : []))
        .join("");
    expect(deltas(officeRun.id)).toBe("사무실 답");
    expect(deltas(homeRun.id)).toBe("집 답");
    expect(sc.office.errors).toEqual([]);
    expect(sc.home.errors).toEqual([]);
  });

  it("main-office 의 답에 @main-home → 릴레이 런이 집 Gateway 로 간다(Review Focus 2)", async () => {
    const { channel, mainOffice, mainHome, log } = await twoMains({ relay: true });
    const sc = scenarios({
      office: { main: () => ({ reply: "@main-home 이어서 부탁해요" }) },
      home: { main: () => ({ reply: "이어서 했습니다" }) },
    });

    await sendMessage(log.socket, channel.id, "@main-office 시작해 주세요");
    const officeRun = await runOf(log, mainOffice.id);
    expect((await log.terminal(officeRun.id)).status).toBe("done");
    const relay = await log.until(
      () => log.states.find((s) => s.agentId === mainHome.id && s.relayDepth === 1),
      "main-home 릴레이 런",
    );
    expect((await log.terminal(relay.id)).status).toBe("done");
    await agentReply(log, mainHome.id, "이어서 했습니다");

    expect(home.plugin.received).toHaveLength(1);
    expect(home.plugin.received[0]).toMatchObject({
      agentId: "main",
      runId: relay.id,
      message: { author: { type: "agent", handle: "main-office" } },
    });
    expect(office.plugin.received.map((d) => d.runId)).toEqual([officeRun.id]);
    expect(runRow(relay.id)?.connectionId).toBe(home.gatewayId);
    expect(sc.office.errors).toEqual([]);
    expect(sc.home.errors).toEqual([]);
  });

  it("Gateway 삭제 → 열린 런 ADAPTER_UNAVAILABLE·에이전트 연결 비움, 같은 id 가 있는 곳으로는 못 옮기고, 옮긴 뒤 「다시 실행」이 새 Gateway 에서 돈다(Review Focus 4)", async () => {
    const { channel, mainOffice, mainHome, log } = await twoMains();
    const devOffice = await registerAgent(office, "dev", "dev");
    await addMember(channel.id, devOffice);
    scenarios({
      // 사무실 dev 는 끝나지 않는 런 — 지우는 순간 열려 있다
      office: { dev: () => ({ reply: "안 끝남", holdFinal: true }) },
      home: { dev: () => ({ reply: "집에서 다시 했어요" }), main: () => ({ reply: "집 main" }) },
    });

    const trigger = await sendMessage(log.socket, channel.id, "@dev 오래 걸리는 일");
    const devRun = await runOf(log, devOffice.id);
    await log.until(() => log.statesOf(devRun.id).find((s) => s.status === "streaming"), "dev 런 streaming");

    const removed = await ok(
      "DELETE /gateways office",
      api<{ unboundAgents: number; deletedTokens: number }>("DELETE", `/gateways/${office.gatewayId}`),
    );
    expect(removed).toEqual({ unboundAgents: 2, deletedTokens: 1 });
    expect(await log.terminal(devRun.id)).toMatchObject({
      status: "error",
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
    const notice = await log.until(
      () => log.created.find((m) => m.systemMeta?.kind === "run_error" && m.systemMeta.runId === devRun.id),
      "run_error 카드",
    );
    expect(notice.components?.blocks).toContainEqual(
      expect.objectContaining({ type: "actions", items: [expect.objectContaining({ id: RETRY_ITEM })] }),
    );

    // 에이전트 행·멤버십은 남고 연결만 빈다
    const agentsNow = await ok("GET /agents", api<{ agents: Agent[] }>("GET", "/agents"));
    const byId = new Map(agentsNow.agents.map((a) => [a.id, a]));
    expect(byId.get(devOffice.id)?.gateway).toBeNull();
    expect(byId.get(mainOffice.id)?.gateway).toBeNull();
    expect(byId.get(mainHome.id)?.gateway).toEqual({ id: home.gatewayId, name: "집" });
    const members = await ok(
      "GET members",
      api<{ members: Array<{ memberId: string }> }>("GET", `/channels/${channel.id}/members`),
    );
    expect(members.members.map((m) => m.memberId)).toEqual(
      expect.arrayContaining([devOffice.id, mainOffice.id, mainHome.id]),
    );

    // 연결이 빈 에이전트를 멘션하면 서버가 죽지 않고 ADAPTER_UNAVAILABLE
    await sendMessage(log.socket, channel.id, "@main-office 거기 있나요");
    const orphanRun = await runOf(log, mainOffice.id);
    expect(await log.terminal(orphanRun.id)).toMatchObject({
      status: "error",
      error: { code: "ADAPTER_UNAVAILABLE" },
    });

    // 집에는 main 이 이미 있다 — 옮기지 못한다
    const conflict = await api<{ code: string }>("PUT", `/agents/${mainOffice.id}/gateway`, {
      gatewayId: home.gatewayId,
    });
    expect([conflict.status, conflict.body.code]).toEqual([409, "CONFLICT"]);

    const moved = await ok(
      "PUT /agents dev gateway",
      api<{ agent: Agent }>("PUT", `/agents/${devOffice.id}/gateway`, { gatewayId: home.gatewayId }),
    );
    expect(moved.agent.gateway).toEqual({ id: home.gatewayId, name: "집" });

    const pressed = await log.socket.emitWithAck("component.interact", {
      messageId: notice.id,
      componentId: notice.components?.id as string,
      itemId: RETRY_ITEM,
      values: {},
    });
    if (!pressed.ok) throw new Error(`다시 실행 실패: ${pressed.error.code} ${pressed.error.message}`);
    const reply = await agentReply(log, devOffice.id, "집에서 다시 했어요");
    const retried = runRow(reply.runId as string);
    expect(retried).toMatchObject({
      parentRunId: devRun.id,
      triggerMessageId: trigger.id,
      connectionId: home.gatewayId,
      status: "done",
    });
    expect(home.plugin.received.map((d) => d.agentId)).toEqual(["dev"]);
  });

  it("첨부 범위 — 집 플러그인이 올린 첨부는 사무실 토큰이 못 읽고, 사무실 정본에도 묶이지 않는다", async () => {
    const { channel, mainOffice, log } = await twoMains();
    const homeUpload = await home.plugin.uploadAttachment({
      conversationId: channelConversation(live.app.db, channel.id),
      bytes: PDF_BYTES,
      name: "home.pdf",
      mime: "application/pdf",
    });
    expect((await office.plugin.downloadAttachment(homeUpload.id)).status).toBe(404);
    expect((await home.plugin.downloadAttachment(homeUpload.id)).status).toBe(200);

    const sc = scenarios({
      office: {
        main: () => ({
          reply: "파일 둘",
          attachments: [{ name: "office.pdf", mime: "application/pdf", bytes: PDF_BYTES }],
          attachmentIds: [homeUpload.id],
        }),
      },
      home: {},
    });
    await sendMessage(log.socket, channel.id, "@main-office 파일 주세요");
    const reply: Message = await agentReply(log, mainOffice.id, "파일 둘");
    expect(reply.attachments.map((a) => a.name)).toEqual(["office.pdf"]);
    expect(sc.office.errors).toEqual([]);
  });

  it("채널 프롬프트는 그 채널에 에이전트를 둔 Gateway 에만 — 다른 Gateway 의 에이전트가 처음 들어오면 그 Gateway 에 한 번", async () => {
    const { channel } = await ok(
      "POST /channels",
      api<{ channel: Channel }>("POST", "/channels", { name: "prompt" }),
    );
    const mainOffice = await registerAgent(office, "main", "main-office");
    const devOffice = await registerAgent(office, "dev", "dev");
    const mainHome = await registerAgent(home, "main", "main-home");
    // 집 에이전트는 다른 채널에만 있다 — 집합은 채널마다다
    const { channel: other } = await ok(
      "POST /channels other",
      api<{ channel: Channel }>("POST", "/channels", { name: "other" }),
    );
    await addMember(other.id, mainHome);
    await addMember(channel.id, mainOffice);
    await addMember(channel.id, devOffice);
    const configsOf = (gateway: LiveGateway) =>
      gateway.plugin.configSets.filter((c) => c.channelId === channel.id).map((c) => c.config.systemPrompt);

    await ok("PATCH prompt", api("PATCH", `/channels/${channel.id}`, { prompt: "짧게 답하세요" }));
    await waitFor(() => configsOf(office).length === 2, "사무실 config.set 둘");
    // 사무실은 처음 들어올 때 한 번(dev 때는 이미 있어 없다) + 프롬프트 변경 한 번, 집은 0
    expect(configsOf(office)).toEqual(["", "짧게 답하세요"]);
    expect(configsOf(home)).toEqual([]);

    await addMember(channel.id, mainHome);
    await waitFor(() => configsOf(home).length === 1, "집 config.set 하나");
    expect(configsOf(home)).toEqual(["짧게 답하세요"]);
    expect(configsOf(office)).toHaveLength(2);
  });

  it("사무실을 끄고 켜는 동안 집 런은 끝까지 가고 집 플러그인은 끊기지 않는다 — 끈 사이 사무실 토큰은 거절(Review Focus 3)", async () => {
    const { channel, mainOffice, mainHome, log } = await twoMains();
    const sc = scenarios({
      office: {
        main: ({ index }) =>
          index === 0 ? { reply: "안 끝남", holdFinal: true } : { reply: "다시 켜진 사무실" },
      },
      home: { main: () => ({ reply: "집 끝", approval: { ttlMs: APPROVAL_TTL_MS } }) },
    });

    await sendMessage(log.socket, channel.id, "@main-office 오래 걸려요");
    const officeRun = await runOf(log, mainOffice.id);
    await log.until(
      () => log.statesOf(officeRun.id).find((s) => s.status === "streaming"),
      "사무실 런 streaming",
    );
    await sendMessage(log.socket, channel.id, "@main-home 해 주세요");
    const homeRun = await runOf(log, mainHome.id);
    const homeApproval = await log.until(
      () => log.approvals.find((a) => a.runId === homeRun.id),
      "집 승인 요청",
    );
    const homeHello = home.plugin.helloResult;
    const statusFrom = log.adapterStatus.length;

    await ok("PATCH office off", api("PATCH", `/gateways/${office.gatewayId}`, { enabled: false }));
    expect(await log.terminal(officeRun.id)).toMatchObject({
      status: "error",
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
    await log.until(
      () =>
        log.adapterStatus
          .slice(statusFrom)
          .find((s) => s.gatewayId === office.gatewayId && s.bridge !== "connected"),
      "사무실 브리지 끊김",
    );
    await expect(office.plugin.reconnect()).rejects.toThrow(/UNAUTHORIZED/);

    // 집 런은 사무실을 끈 뒤에 승인되어 끝까지 간다
    await resolveApproval(log.socket, homeApproval.id, "allow-once");
    expect((await log.terminal(homeRun.id)).status).toBe("done");
    await agentReply(log, mainHome.id, "집 끝");

    await ok("PATCH office on", api("PATCH", `/gateways/${office.gatewayId}`, { enabled: true }));
    await log.until(
      () =>
        log.adapterStatus
          .slice(statusFrom)
          .find((s) => s.gatewayId === office.gatewayId && s.gateway === "connected"),
      "사무실 Gateway 다시 connected",
    );
    // 실제 플러그인은 자기 백오프로 다시 붙는다 — 가짜는 손으로
    await office.plugin.reconnect();
    await sendMessage(log.socket, channel.id, "@main-office 다시 해 주세요");
    await agentReply(log, mainOffice.id, "다시 켜진 사무실");

    // 집은 그 내내 한 번도 끊기지 않았다
    const homeLines = log.adapterStatus.slice(statusFrom).filter((s) => s.gatewayId === home.gatewayId);
    expect(homeLines.length).toBeGreaterThan(0);
    expect(homeLines.every((s) => s.gateway === "connected" && s.bridge === "connected")).toBe(true);
    expect(home.plugin.helloResult).toBe(homeHello);
    expect(home.plugin.received.map((d) => d.runId)).toEqual([homeRun.id]);
    expect(sc.home.errors).toEqual([]);
  });
});

/** 조건이 참이 될 때까지 다음 틱마다 다시 본다(3초 상한) — wire 이벤트가 없는 브리지 쪽 기록을 기다릴 때 */
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
