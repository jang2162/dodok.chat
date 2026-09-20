/**
 * 활동·승인 계획 시나리오 9 — 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway + 가짜 플러그인 + wire 클라이언트.
 *
 * 승인이 **Gateway 프레임 → 어댑터 정규화 → 서버 저장·상관 → wire → `approval.resolve` RPC → 응답 정규화** 전 구간을
 * 처음으로 이어서 도는 자리다. 실제 시계로 돈다 — 기다림은 wire 이벤트(`WireLog.until`)로 하고, 만료만 TTL·감시 타이머를 실제로 기다린다.
 */
import type { Approval, RunEvent } from "@dodok/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScenario, type Scenario, type ScenarioApproval } from "../fakes/scenario";
import { bootLiveApp, type LiveApp, type LiveAppOptions } from "../helpers/live-app";
import {
  getRunRest,
  openChannelWire,
  type RelayChannel,
  resolveApproval,
  sendMessage,
  setupRelayChannel,
  type WireLog,
} from "../helpers/scenario-steps";
import type { WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };
/** 사람이 누를 틈이 충분한 TTL — 이 값으로는 만료되지 않는다 */
const LONG_TTL_MS = 20_000;
/** 서버 만료 감시(만료 시각 + 5초 여유)까지 기다리는 상한 */
const EXPIRY_WAIT_MS = 12_000;
/**
 * 9c′ 의 런 상한. 「런 시작 → 승인 대기」보다는 넉넉하고(안 그러면 대기에 들기 전에 죽는다)
 * 「만료(5.3초) → 이 값」이 `WireLog.until` 상한(5초) 안에 들 만큼 짧아야 한다
 */
const RESUMED_RUN_MS = 2_000;

const WRITE_APPROVAL: ScenarioApproval = {
  title: "claude-cli native tool: Write",
  toolName: "Write",
  allowedDecisions: ["allow-once", "deny"],
  ttlMs: LONG_TTL_MS,
  onDecision: "continue",
};

/** 같은 승인이 프레임 둘로 와 wire 에도 두 번 실린다 — 「카드」를 셀 때는 id 로 추린다(첫 도착 순서 유지) */
function distinctById(approvals: Approval[]): Approval[] {
  return [...new Map(approvals.map((a) => [a.id, a])).values()];
}

/** 그 승인의 **마지막** 중계 — 확정 짝의 뒤엣것이 빈 자리를 채우면 같은 승인이 두 번 실린다 */
function lastRow(log: WireLog, id: string): Approval | undefined {
  return log.resolvedApprovals.filter((a) => a.id === id).at(-1);
}

/** 두 경로가 같은 모양으로 모였는지 볼 때 쓰는 결말 셋 */
function outcomeOf(approval: Approval | undefined) {
  return { status: approval?.status, decision: approval?.decision, reason: approval?.reason };
}

describe("통합 시나리오 9 — 승인 허용·거절·만료·겹침", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];

  async function boot(opts: LiveAppOptions = {}) {
    live = await bootLiveApp(opts);
  }

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  /** 대본 재생 중 오류는 조용히 묻히지 않게 끝에서 비어 있음을 본다 */
  function expectNoScenarioErrors(scenario: Scenario) {
    expect(scenario.errors).toEqual([]);
  }

  /** dev 한 명짜리 채널 + 구독한 소켓 + 그 대본 */
  async function startTurn(
    script: Parameters<typeof scriptOf>[0],
  ): Promise<{ setup: RelayChannel; log: WireLog; scenario: Scenario }> {
    const setup = await setupRelayChannel(live, RELAY_POLICY);
    const log = await openChannelWire(live, setup.channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: () => scriptOf(script) },
    });
    return { setup, log, scenario };
  }

  const scriptOf = (script: { approval: ScenarioApproval | ScenarioApproval[]; holdFinal?: boolean }) => ({
    deltas: ["다", "했어요"],
    reply: "다했어요",
    ...script,
  });

  /** `@dev …` 를 보내고 그 런과 첫 승인 카드를 돌려준다 */
  async function askAndWaitForCard(log: WireLog, setup: RelayChannel) {
    await sendMessage(log.socket, setup.channel.id, "@dev 파일 써줘");
    const run = await log.until(() => log.states.find((s) => s.agentId === setup.dev.id), "dev 런");
    const card = await log.until(() => log.approvals.at(0), "approval.requested");
    return { run, card };
  }

  const approvalEvents = (log: WireLog, runId: string): RunEvent[] =>
    log.eventsOf(runId).filter((e) => e.type === "APPROVAL_REQUESTED" || e.type === "APPROVAL_RESOLVED");

  it("시나리오 9a — 승인을 허용하면 대기에서 풀려 런이 이어지고 정본이 온다", async () => {
    await boot();
    const { setup, log, scenario } = await startTurn({ approval: WRITE_APPROVAL });
    const { run, card } = await askAndWaitForCard(log, setup);

    // 어댑터가 정규화한 값이 그대로 카드가 된다 — 세션 키에서 푼 채널·에이전트, request 블록의 표시 값
    expect(card).toMatchObject({
      kind: "plugin",
      channelId: setup.channel.id,
      agentId: setup.dev.id,
      runId: run.id,
      status: "pending",
      title: "claude-cli native tool: Write",
      toolName: "Write",
      pluginId: "claude-cli",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(card.providerApprovalId).toMatch(/^plugin:/);
    // ⚠ 실측 — 정본 경로(`plugin.approval.requested`)에는 `urlPath` 가 없다. Gateway 의 `/approve/...` 링크는
    // 세션 경로(`session.approval`·되감기) 스냅샷에만 실린다 — 먼저 온 카드에는 아직 없다
    expect(card.urlPath).toBeUndefined();
    // …그리고 뒤따라온 스냅샷이 그 자리를 채워 같은 행에 병합된다(p2-t6 C). 두 경로의 값이 한 승인에 다 남는다
    const merged = await log.until(
      () => log.approvals.find((a) => a.id === card.id && a.urlPath !== undefined),
      "urlPath 가 채워진 같은 승인",
    );
    expect(merged).toMatchObject({
      id: card.id,
      status: "pending",
      toolCallId: card.toolCallId,
      urlPath: `/approve/${encodeURIComponent(card.providerApprovalId)}`,
    });
    // 값만 늦게 찬 것이므로 타임라인에는 카드가 하나뿐이다 — 런을 다시 깨우지도 않는다
    expect(approvalEvents(log, run.id).filter((e) => e.type === "APPROVAL_REQUESTED")).toHaveLength(1);
    expect(Date.parse(card.expiresAt) - Date.parse(card.createdAt)).toBe(LONG_TTL_MS);
    expect(Date.parse(card.expiresAt)).toBeGreaterThan(Date.now());
    expect(card.decision).toBeUndefined();
    // 승인을 요구한 툴 호출에 붙어 있다
    const toolStart = log.eventsOf(run.id).find((e) => e.type === "TOOL_CALL_START");
    expect(card.toolCallId).toBe(toolStart?.type === "TOOL_CALL_START" ? toolStart.toolCallId : undefined);

    // 구독 ack 의 미해결 승인에도 같은 카드가 실린다(다른 탭이 뒤늦게 열어도 보인다) — 병합한 값 그대로 저장돼 있다
    const late = await openChannelWire(live, setup.channel.id, sockets);
    const ack = await late.socket.emitWithAck("channel.subscribe", { channelId: setup.channel.id });
    expect(ack.ok && ack.data.pendingApprovals).toMatchObject([
      { id: card.id, toolCallId: card.toolCallId, urlPath: merged.urlPath },
    ]);

    await log.until(
      () => log.statesOf(run.id).some((s) => s.status === "awaiting_approval"),
      "awaiting_approval 런 상태",
    );

    await resolveApproval(log.socket, card.id, "allow-once");
    const resolved = await log.until(() => log.resolvedApprovals.at(0), "approval.resolved");
    expect(resolved).toMatchObject({
      id: card.id,
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      decidedBy: live.app.ownerUserId,
    });
    expect(resolved.decidedAt).toEqual(expect.any(String));

    expect((await log.terminal(run.id)).status).toBe("done");
    // 대기에서 나오면 승인 **직전** 상태(tool)로 돌아간다 — 배지가 「응답 중」으로 튀지 않는다
    const statuses = log.statesOf(run.id).map((s) => s.status);
    expect(statuses[statuses.indexOf("awaiting_approval") + 1]).toBe("tool");
    expect(statuses.at(-1)).toBe("done");

    // 활동 타임라인은 요구 → 해결 순서로 읽힌다
    expect(approvalEvents(log, run.id)).toMatchObject([
      {
        type: "APPROVAL_REQUESTED",
        approvalId: card.id,
        kind: "plugin",
        title: "claude-cli native tool: Write",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        toolCallId: card.toolCallId,
      },
      {
        type: "APPROVAL_RESOLVED",
        approvalId: card.id,
        decision: "allow-once",
        reason: "user",
        decidedBy: live.app.ownerUserId,
      },
    ]);
    // 허용했으므로 툴은 성공으로 끝났다
    const result = log.eventsOf(run.id).find((e) => e.type === "TOOL_CALL_RESULT");
    expect(result).toMatchObject({ ok: true });

    const agentMessage = await log.until(
      () => log.created.find((m) => m.authorType === "agent" && m.runId === run.id),
      "에이전트 정본",
    );
    expect(agentMessage.bodyMd).toBe("다했어요");
    expect(await getRunRest(live, run.id)).toMatchObject({ status: "done", finalSource: "plugin" });
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 9b — 거절하면 툴 오류로 이어지고 런은 그대로 끝난다", async () => {
    await boot();
    const { setup, log, scenario } = await startTurn({
      approval: { ...WRITE_APPROVAL, onDecision: "toolError" },
    });
    const { run, card } = await askAndWaitForCard(log, setup);

    await resolveApproval(log.socket, card.id, "deny");
    const resolved = await log.until(() => log.resolvedApprovals.at(0), "approval.resolved");
    expect(resolved).toMatchObject({
      id: card.id,
      status: "denied",
      decision: "deny",
      reason: "user",
      decidedBy: live.app.ownerUserId,
    });

    // 거절은 런을 죽이지 않는다(스파이크 4.3) — 툴만 오류로 끝나고 모델이 말을 잇는다
    expect((await log.terminal(run.id)).status).toBe("done");
    const result = log.eventsOf(run.id).find((e) => e.type === "TOOL_CALL_RESULT");
    expect(result).toMatchObject({ ok: false });
    expect(result?.type === "TOOL_CALL_RESULT" && result.content).toContain("denied native tool use");
    expect(log.eventsOf(run.id).map((e) => e.type)).not.toContain("RUN_ERROR");
    expect(approvalEvents(log, run.id).at(-1)).toMatchObject({
      type: "APPROVAL_RESOLVED",
      decision: "deny",
      reason: "user",
    });

    // 이미 확정된 승인은 다시 누를 수 없다
    const again = await log.socket.emitWithAck("approval.resolve", {
      approvalId: card.id,
      decision: "allow-once",
    });
    expect(again).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 9c — 아무도 응답하지 않으면 Gateway 가 만료로 확정하고(deny+timeout) 런은 이어진다", async () => {
    await boot();
    const { setup, log, scenario } = await startTurn({
      approval: { ...WRITE_APPROVAL, ttlMs: 300, onDecision: "toolError" },
    });
    const { run, card } = await askAndWaitForCard(log, setup);

    // ⚠ 실측 — 확정도 **짝**으로 온다(3.4·5.2). 먼저 오는 `session.approval(terminal)` 에는 `status:"expired"`·
    // `reason:"timeout"` 만 있고 `decision` 이 없다 — 첫 중계가 여기까지인 것은 실물 그대로다
    const expired = await log.until(() => log.resolvedApprovals.at(0), "만료된 approval.resolved");
    expect(expired).toMatchObject({ id: card.id, status: "expired", reason: "timeout" });
    expect(expired.decidedBy).toBeUndefined();
    // 런 이벤트에서만 계약이 요구하는 값으로 정규화된다(설계 3.2)
    expect(approvalEvents(log, run.id).at(-1)).toMatchObject({
      type: "APPROVAL_RESOLVED",
      approvalId: card.id,
      decision: "deny",
      reason: "timeout",
    });
    expect(approvalEvents(log, run.id).at(-1)).not.toHaveProperty("decidedBy");

    expect((await log.terminal(run.id)).status).toBe("done");
    const statuses = log.statesOf(run.id).map((s) => s.status);
    expect(statuses[statuses.indexOf("awaiting_approval") + 1]).toBe("tool");

    // 짝의 뒤엣것(`plugin.approval.resolved`)이 빈 `decision` 을 채운다 — 서버 감시가 닫은 만료(9c′)와 글자 그대로 같은 행(p2-t6 B)
    expect(lastRow(log, card.id)).toMatchObject({ status: "expired", decision: "deny", reason: "timeout" });
    // 값만 늦게 찬 것이라 타임라인에 `APPROVAL_RESOLVED` 를 또 쌓지 않는다
    expect(approvalEvents(log, run.id).filter((e) => e.type === "APPROVAL_RESOLVED")).toHaveLength(1);

    // 만료된 승인은 다시 누를 수 없다
    const late = await log.socket.emitWithAck("approval.resolve", {
      approvalId: card.id,
      decision: "allow-once",
    });
    expect(late).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 9c′ — Gateway 가 조용해도 서버 감시가 만료로 닫고, 대기 동안 멈췄던 런 시계가 다시 켜진다", async () => {
    // 승인 대기 중에는 런 상한이 멈춰 있어야 한다 — 멈추지 않았다면 대기 중에 TIMEOUT 으로 죽는다.
    // 만료 뒤에는 다시 켜져야 한다 — 켜지지 않았다면 이 런은 영원히 살아 종료 run.state 가 오지 않는다.
    await boot({ timeouts: { runMs: RESUMED_RUN_MS } });
    const { setup, log, scenario } = await startTurn({
      // 만료 프레임이 없다 → 서버의 만료 감시(만료 시각 + 5초)만이 이 승인을 닫을 수 있다
      approval: { ...WRITE_APPROVAL, ttlMs: 300, onTimeout: "silent" },
      // 만료 뒤에도 Gateway 가 조용하다 — 런은 다시 켜진 상한으로만 끝날 수 있다
      holdFinal: true,
    });
    const { run, card } = await askAndWaitForCard(log, setup);

    const expired = await log.until(
      () => log.resolvedApprovals.at(0),
      "서버 감시가 닫은 approval.resolved",
      EXPIRY_WAIT_MS,
    );
    // 같은 「만료」는 어느 경로로 닫혀도 같은 모양이다 — Gateway 경로(9c)와 글자 그대로 같은 값(p2-t6 B)
    expect(expired).toMatchObject({
      id: card.id,
      status: "expired",
      decision: "deny",
      reason: "timeout",
    });
    // 대기 중에는 런 상한이 멈춰 있었다 — 안 멈췄으면 만료(5.3초)보다 먼저 죽는다
    expect(log.statesOf(run.id).filter((s) => s.status === "error")).toEqual([]);

    const terminal = await log.terminal(run.id);
    expect(terminal).toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 9f — 확정 짝이 어느 순서로 와도 만료 행은 같다(실물 순서·뒤집은 순서)", async () => {
    // ⚠ 실물은 확정도 짝으로 준다(3.4·5.2): `session.approval(terminal)` 에는 `decision` 이 없고
    // `plugin.approval.resolved` 에만 `deny` 가 실린다. 어느 쪽이 먼저 닿든 저장된 행은 같아야 한다(리뷰 F2)
    await boot();
    const { setup, log, scenario } = await startTurn({
      approval: [
        // 실물 관측 순서 — 세션 스냅샷이 먼저
        { ...WRITE_APPROVAL, toolName: "Write", ttlMs: 300, onDecision: "toolError" },
        // 뒤집은 순서 — 정본이 먼저
        {
          ...WRITE_APPROVAL,
          title: "claude-cli native tool: Read",
          toolName: "Read",
          ttlMs: 300,
          onDecision: "toolError",
          settleFrameOrder: "plugin-first",
        },
      ],
    });
    const { run } = await askAndWaitForCard(log, setup);
    const [sessionFirst, pluginFirst] = await log.until(() => {
      const cards = distinctById(log.approvals);
      return cards.length === 2 ? cards : undefined;
    }, "승인 카드 둘");

    expect((await log.terminal(run.id)).status).toBe("done");
    // 같은 만료가 같은 행으로 남는다 — 순서에 따라 `decision` 이 비는 일이 없다
    const expired = { status: "expired", decision: "deny", reason: "timeout" };
    expect(outcomeOf(lastRow(log, sessionFirst?.id as string))).toEqual(expired);
    expect(outcomeOf(lastRow(log, pluginFirst?.id as string))).toEqual(expired);
    expect(lastRow(log, sessionFirst?.id as string)?.decidedBy).toBeUndefined();
    expect(lastRow(log, pluginFirst?.id as string)?.decidedBy).toBeUndefined();
    // 타임라인은 어느 순서에서도 승인당 요구 하나·해결 하나다(짝의 뒤엣것이 카드를 또 쌓지 않는다)
    expect(approvalEvents(log, run.id).map((e) => e.type)).toEqual([
      "APPROVAL_REQUESTED",
      "APPROVAL_REQUESTED",
      "APPROVAL_RESOLVED",
      "APPROVAL_RESOLVED",
    ]);
    for (const event of approvalEvents(log, run.id).filter((e) => e.type === "APPROVAL_RESOLVED")) {
      expect(event).toMatchObject({ decision: "deny", reason: "timeout" });
    }
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 9g — 사용자가 누른 뒤 늦게 오는 확정 짝은 어느 순서로 와도 그 결정을 덮지 않는다", async () => {
    await boot();
    const { setup, log, scenario } = await startTurn({
      approval: [
        { ...WRITE_APPROVAL, toolName: "Write" },
        {
          ...WRITE_APPROVAL,
          title: "claude-cli native tool: Read",
          toolName: "Read",
          onDecision: "toolError",
          settleFrameOrder: "plugin-first",
        },
      ],
    });
    const { run } = await askAndWaitForCard(log, setup);
    const [allowed, denied] = await log.until(() => {
      const cards = distinctById(log.approvals);
      return cards.length === 2 ? cards : undefined;
    }, "승인 카드 둘");

    await resolveApproval(log.socket, allowed?.id as string, "allow-once");
    await resolveApproval(log.socket, denied?.id as string, "deny");
    expect((await log.terminal(run.id)).status).toBe("done");

    // 런이 끝난 시점이면 두 승인의 확정 짝이 모두 도착해 처리됐다 — 그래도 행은 우리가 적은 그대로다
    expect(lastRow(log, allowed?.id as string)).toMatchObject({
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      decidedBy: live.app.ownerUserId,
    });
    expect(lastRow(log, denied?.id as string)).toMatchObject({
      status: "denied",
      decision: "deny",
      reason: "user",
      decidedBy: live.app.ownerUserId,
    });
    // 늦게 온 짝에는 채울 자리가 없다 — 승인마다 해결 중계도 한 번뿐이다
    expect(log.resolvedApprovals.filter((a) => a.id === allowed?.id)).toHaveLength(1);
    expect(log.resolvedApprovals.filter((a) => a.id === denied?.id)).toHaveLength(1);
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 9d — 한 런에 승인이 둘이면 만료된 것만 닫히고 살아 있는 것은 그대로 해결된다", async () => {
    await boot();
    const { setup, log, scenario } = await startTurn({
      approval: [
        // 먼저 만료될 승인. Gateway 가 조용하므로 서버 감시가 닫는다 — 이때 뒤엣것까지 쓸어 닫으면 안 된다
        { ...WRITE_APPROVAL, toolName: "Write", ttlMs: 300, onTimeout: "silent", onDecision: "toolError" },
        // 아직 살아 있는 승인 — 사용자가 뒤늦게 누른다
        { ...WRITE_APPROVAL, title: "claude-cli native tool: Read", toolName: "Read" },
      ],
    });
    const { run } = await askAndWaitForCard(log, setup);
    // `log.approvals` 는 도착 순서 그대로다 — 같은 승인이 두 프레임으로 와 두 번 실린다. 카드는 id 로 센다
    const [first, second] = await log.until(() => {
      const cards = distinctById(log.approvals);
      return cards.length === 2 ? cards : undefined;
    }, "승인 카드 둘");
    expect(first?.toolName).toBe("Write");
    expect(second?.toolName).toBe("Read");
    expect([first?.runId, second?.runId]).toEqual([run.id, run.id]);

    const expired = await log.until(
      () => log.resolvedApprovals.at(0),
      "먼저 만료된 approval.resolved",
      EXPIRY_WAIT_MS,
    );
    expect(expired).toMatchObject({ id: first?.id, status: "expired", reason: "timeout" });
    // 두 번째는 휩쓸리지 않았다 — 여전히 미해결이라 지금 눌러도 된다
    expect(log.resolvedApprovals).toHaveLength(1);
    const stillPending = await log.socket.emitWithAck("channel.subscribe", {
      channelId: setup.channel.id,
    });
    expect(stillPending.ok && stillPending.data.pendingApprovals.map((a: Approval) => a.id)).toEqual([
      second?.id,
    ]);

    await resolveApproval(log.socket, second?.id as string, "allow-once");
    const allowed = await log.until(() => log.resolvedApprovals.at(1), "두 번째 approval.resolved");
    expect(allowed).toMatchObject({
      id: second?.id,
      status: "allowed",
      decision: "allow-once",
      decidedBy: live.app.ownerUserId,
    });

    expect((await log.terminal(run.id)).status).toBe("done");
    expect(approvalEvents(log, run.id).map((e) => e.type)).toEqual([
      "APPROVAL_REQUESTED",
      "APPROVAL_REQUESTED",
      "APPROVAL_RESOLVED",
      "APPROVAL_RESOLVED",
    ]);
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 9e — 승인 대기 중 런을 중지하면 남은 승인이 cancelled 로 닫히고 카드가 사라진다", async () => {
    await boot();
    const { setup, log, scenario } = await startTurn({ approval: WRITE_APPROVAL });
    const { run, card } = await askAndWaitForCard(log, setup);
    await log.until(
      () => log.statesOf(run.id).some((s) => s.status === "awaiting_approval"),
      "awaiting_approval 런 상태",
    );

    const stop = await log.socket.emitWithAck("run.abort", { runId: run.id });
    expect(stop.ok).toBe(true);

    const cancelled = await log.until(() => log.resolvedApprovals.at(0), "취소된 approval.resolved");
    expect(cancelled).toMatchObject({ id: card.id, status: "cancelled", reason: "run-aborted" });
    expect((await log.terminal(run.id)).status).toBe("aborted");
    // ⚠ 실측 — 이 둘은 **어느 쪽이 먼저인지 보장되지 않는다**. 로컬 abort 신호(`orchestrator.abort` 가 스스로 적용)와
    // Gateway 의 `chat aborted` 프레임이 경주하고, 이긴 쪽에 따라 `RUN_ABORTED.by` 도 "user"/"gateway" 로 흔들린다
    // (리뷰 F1 재현: 가짜 Gateway 의 aborted 프레임을 30ms 늦추면 100% 뒤집힌다).
    // 그래서 여기서는 **둘 다 남는다**만 잰다 — 화면도 순서·`by` 가 아니라 「런이 aborted, 그 승인이 cancelled」만 써야 한다
    const types = log.eventsOf(run.id).map((e) => e.type);
    expect(types).toContain("RUN_ABORTED");
    expect(types).toContain("APPROVAL_RESOLVED");
    // 대기에서 aborted 로 한 번만 바뀐다(중간에 tool 로 되돌아가지 않는다)
    const statuses = log.statesOf(run.id).map((s) => s.status);
    expect(statuses[statuses.indexOf("awaiting_approval") + 1]).toBe("aborted");
    expectNoScenarioErrors(scenario);
  });
});
