/**
 * Phase 4 ③ 계획 태스크 4 — Claude 러너 통합 시나리오 1~10. 실제 서버(실제 OpenClawAdapter + 실제 러너 어댑터) + 가짜 Gateway·플러그인
 * + 가짜 러너(`/runner` 에 붙는 socket.io-client) + wire 클라이언트. 모델 런 0, 실제 시계 — 승인 기한·끊김 임계만 줄인다.
 * 기다림은 wire 이벤트(WireLog.until)와 vi.waitFor 로 한다
 */
import {
  type Agent,
  type Channel,
  dodokSessionKey,
  IssueRunnerTokenResult,
  type Message,
  OpsRunsSummary,
  type Result,
  SetupStatus,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opsEvents, runs } from "../../src/db/schema.sqlite";
import { createScenario } from "../fakes/scenario";
import { type FakeRunner, type FakeRunnerScript, startFakeRunner } from "../fakes/fake-runner";
import { bootLiveApp, type LiveApp, type LiveAppOptions } from "../helpers/live-app";
import { openChannelWire, rest, sendMessage, type WireLog } from "../helpers/scenario-steps";
import type { WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });

const RETRY_COMPONENTS = {
  blocks: [
    { type: "actions", items: [{ type: "button", id: "retry_run", label: "다시 실행", style: "primary" }] },
  ],
};

describe("Claude 러너 통합 시나리오", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  const runners: FakeRunner[] = [];

  afterEach(async () => {
    for (const runner of runners.splice(0)) runner.close();
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  function ok<T>(what: string, res: { status: number; body: T }): T {
    if (res.status >= 300) throw new Error(`${what} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async function issueToken(label: string) {
    return IssueRunnerTokenResult.parse(
      ok("POST runner-tokens", await rest(live, "POST", "/setup/runner-tokens", { label })),
    );
  }

  async function connectRunner(token: string, script?: FakeRunnerScript) {
    const runner = await startFakeRunner({ url: live.app.url, token, ...(script ? { script } : {}) });
    runners.push(runner);
    return runner;
  }

  /** 채널을 만들고 에이전트들을 멤버로 넣는다 */
  async function channelWith(agents: Agent[], name = "runner") {
    const { channel } = ok(
      "POST /channels",
      await rest<{ channel: Channel }>(live, "POST", "/channels", { name }),
    );
    for (const agent of agents)
      ok(
        "POST members",
        await rest(live, "POST", `/channels/${channel.id}/members`, {
          memberType: "agent",
          memberId: agent.id,
        }),
      );
    return channel;
  }

  /** 러너 토큰 발급 → 가짜 러너 접속 → discover?provider=claude 에서 coder 를 골라 등록 → 채널 */
  async function start(script?: FakeRunnerScript, opts: LiveAppOptions = {}) {
    live = await bootLiveApp(opts);
    const issued = await issueToken("macbook");
    const runner = await connectRunner(issued.token, script);
    const discovered = ok(
      "discover",
      await rest<{ agents: Array<{ providerAgentId: string; name?: string; hint?: string }> }>(
        live,
        "GET",
        "/agents/discover?provider=claude",
      ),
    );
    expect(discovered.agents).toEqual([
      { providerAgentId: "coder", name: "Coder", hint: "macbook · dodok · sonnet" },
    ]);
    const { agent: coder } = ok(
      "POST /agents coder",
      await rest<{ agent: Agent }>(live, "POST", "/agents", {
        provider: "claude",
        providerAgentId: "coder",
        handle: "coder",
        name: "Coder",
      }),
    );
    const channel = await channelWith([coder]);
    const log = await openChannelWire(live, channel.id, sockets);
    return { issued, runner, coder, channel, log };
  }

  const runOf = (log: WireLog, agentId: string, n = 0) =>
    log.until(
      () =>
        log.states
          .filter((s) => s.agentId === agentId)
          .filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i)[n],
      `에이전트 ${agentId} 런 ${n}`,
    );

  const agentMessage = (log: WireLog, runId: string) =>
    log.until(
      () => log.created.find((m) => m.authorType === "agent" && m.runId === runId),
      `런 ${runId} 의 에이전트 메시지`,
    );

  const runErrorNotice = (log: WireLog, runId: string) =>
    log.until(
      () => log.created.find((m) => m.systemMeta?.kind === "run_error" && m.systemMeta.runId === runId),
      `런 ${runId} 의 run_error 카드`,
    );

  function pressRetry(socket: WireClient, notice: Message) {
    const componentId = notice.components?.id;
    if (componentId === undefined) throw new Error("run_error 메시지에 버튼이 없다");
    return socket.emitWithAck("component.interact", {
      messageId: notice.id,
      componentId,
      itemId: "retry_run",
      values: {},
    }) as Promise<Result<{ interactionId: string }>>;
  }

  const setupStatus = async () =>
    SetupStatus.parse(ok("GET setup/status", await rest(live, "GET", "/setup/status")));

  it("시나리오 1 — claude 에이전트 멘션 → 스트리밍 → 최종 답 메시지, 활동 탭에 도구 타임라인, run.start 에 세션 UUID·채널 규칙", async () => {
    const { runner, coder, channel, log } = await start((run) => {
      run.text("살펴보");
      run.tool("Read", { file_path: "README.md" }, "# dodok");
      run.text("았습니다");
      run.final("살펴보았습니다", { usage: { inputTokens: 100, outputTokens: 20 }, costUsd: 0.25 });
    });
    const human = await sendMessage(log.socket, channel.id, "@coder README 봐줘");

    const run = await runOf(log, coder.id);
    expect((await log.terminal(run.id)).status).toBe("done");
    const answer = await agentMessage(log, run.id);
    expect(answer).toMatchObject({ bodyMd: "살펴보았습니다", authorId: coder.id });
    expect(log.statesOf(run.id).map((s) => s.status)).toContain("streaming");

    const types = log.eventsOf(run.id).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "TEXT_MESSAGE_CONTENT",
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_CALL_RESULT",
      ]),
    );
    expect(types.indexOf("TOOL_CALL_START")).toBeLessThan(types.indexOf("TOOL_CALL_RESULT"));

    const [startFrame] = runner.runStarts;
    expect(startFrame?.deliver).toMatchObject({
      runId: run.id,
      channelId: channel.id,
      agentId: "coder",
      sessionKey: dodokSessionKey("coder", channel.id),
      message: { id: human.id },
    });
    expect(startFrame?.providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(startFrame?.channelRulesAppend).toContain("runner");
    expect(startFrame?.sessionTitle).toBe("runner · Coder");
    const stored = live.app.db.select().from(runs).where(eq(runs.id, run.id)).get();
    expect(stored?.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.25,
      costKind: "api",
    });
  });

  it("시나리오 2 — 스레드 안 멘션 → run.start.deliver.sessionKey 가 스레드 하위 키, 답은 스레드에", async () => {
    const { runner, coder, channel, log } = await start();
    const root = await sendMessage(log.socket, channel.id, "루트 질문");
    await sendMessage(log.socket, channel.id, "@coder 스레드에서 봐줘", { threadRootId: root.id });
    const run = await runOf(log, coder.id);
    expect((await log.terminal(run.id)).status).toBe("done");
    expect(runner.runStarts[0]?.deliver).toMatchObject({
      sessionKey: dodokSessionKey("coder", channel.id, root.id),
      threadId: root.id,
    });
    const answer = await agentMessage(log, run.id);
    expect(answer.threadRootId).toBe(root.id);
    expect(answer.bodyMd).toMatch(/^받았습니다: .* 스레드에서 봐줘$/);
  });

  it("시나리오 3 — 승인 허용·항상 허용·거절·만료: 카드 상태와 러너가 받은 결정", async () => {
    const { runner, coder, channel, log } = await start(
      async (run) => {
        const decided = await run.approval({ toolName: "Bash", summary: "rm -rf build" });
        run.final(`결정 ${decided?.decision ?? "없음"}${decided?.reason ? ` ${decided.reason}` : ""}`);
      },
      { deps: { runnerApprovalTtlMs: 1_500 } },
    );

    const cardFor = async (runId: string) =>
      log.until(() => log.approvals.find((a) => a.runId === runId), `런 ${runId} 승인 카드`);
    const resolvedFor = (id: string) =>
      log.until(() => log.resolvedApprovals.find((a) => a.id === id), `승인 ${id} 해결`);
    const resolve = async (approvalId: string, decision: "allow-once" | "allow-always" | "deny") => {
      const res = await log.socket.emitWithAck("approval.resolve", { approvalId, decision });
      if (!res.ok) throw new Error(`approval.resolve 실패: ${res.error.code} ${res.error.message}`);
    };

    const cases = [
      { decision: "allow-once", status: "allowed" },
      { decision: "allow-always", status: "allowed" },
      { decision: "deny", status: "denied" },
    ] as const;
    for (const [i, c] of cases.entries()) {
      await sendMessage(log.socket, channel.id, `@coder 빌드 지워 ${i}`);
      const run = await runOf(log, coder.id, i);
      const card = await cardFor(run.id);
      expect(card).toMatchObject({ kind: "tool", toolName: "Bash", status: "pending" });
      expect(card.allowedDecisions).toEqual(["allow-once", "allow-always", "deny"]);
      await log.until(
        () => log.statesOf(run.id).some((s) => s.status === "awaiting_approval"),
        "awaiting_approval",
      );
      await resolve(card.id, c.decision);
      expect(await resolvedFor(card.id)).toMatchObject({
        status: c.status,
        decision: c.decision,
        decidedBy: live.app.ownerUserId,
      });
      expect((await log.terminal(run.id)).status).toBe("done");
      expect((await agentMessage(log, run.id)).bodyMd).toBe(`결정 ${c.decision}`);
    }

    // 아무도 안 누르면 기한에 거절로 닫히고, 러너는 reason expired 의 deny 를 받아 런이 끝까지 간다(Review Focus 4)
    await sendMessage(log.socket, channel.id, "@coder 빌드 지워 만료");
    const run = await runOf(log, coder.id, 3);
    const card = await cardFor(run.id);
    expect(await resolvedFor(card.id)).toMatchObject({
      status: "expired",
      decision: "deny",
      reason: "timeout",
    });
    expect((await log.terminal(run.id)).status).toBe("done");
    expect((await agentMessage(log, run.id)).bodyMd).toBe("결정 deny expired");
    expect(runner.resolves.map((r) => [r.decision, r.reason])).toEqual([
      ["allow-once", undefined],
      ["allow-always", undefined],
      ["deny", undefined],
      ["deny", "expired"],
    ]);
  });

  it("시나리오 4 — 런 도중 러너 끊김 → 승인 카드 철회·ADAPTER_UNAVAILABLE run_error 카드 → 다시 붙은 러너에 「다시 실행」, 같은 providerSessionId [Review Focus 1]", async () => {
    let first = true;
    const { issued, runner, coder, channel, log } = await start(async (run) => {
      if (first) {
        first = false;
        await run.approval({ toolName: "Write", summary: "notes.md" });
        return; // 끊겨서 결정도 final 도 없다
      }
      run.final("이어서 했습니다");
    });
    await sendMessage(log.socket, channel.id, "@coder 노트 써줘");
    const run = await runOf(log, coder.id);
    const card = await log.until(() => log.approvals.find((a) => a.runId === run.id), "승인 카드");

    runner.disconnect();
    const final = await log.terminal(run.id);
    expect(final).toMatchObject({ status: "error", error: { code: "ADAPTER_UNAVAILABLE" } });
    expect(
      await log.until(() => log.resolvedApprovals.find((a) => a.id === card.id), "승인 철회"),
    ).toMatchObject({ status: "cancelled" });
    const notice = await runErrorNotice(log, run.id);
    expect(notice.components).toMatchObject(RETRY_COMPONENTS);

    const again = await runner.reconnect({ token: issued.token });
    expect(again).toMatchObject({ ok: true, conflicts: [] });
    const retried = await pressRetry(log.socket, notice);
    if (!retried.ok) throw new Error(`다시 실행 실패: ${retried.error.code}`);
    const second = await runOf(log, coder.id, 1);
    expect((await log.terminal(second.id)).status).toBe("done");
    expect((await agentMessage(log, second.id)).bodyMd).toBe("이어서 했습니다");
    const [a, b] = runner.runStarts;
    expect(b?.deliver.runId).toBe(second.id);
    expect(b?.providerSessionId).toBe(a?.providerSessionId);
  });

  it("시나리오 5 — 토큰 폐기 → 러너가 곧바로 끊기고, 다음 멘션은 run_error 카드", async () => {
    const { issued, runner, coder, channel, log } = await start();
    const res = await live.app.fastify.inject({
      method: "DELETE",
      url: `/api/v1/setup/runner-tokens/${issued.record.id}`,
      headers: live.auth.headers,
    });
    expect(res.statusCode).toBe(204);
    await vi.waitFor(() => expect(runner.connected).toBe(false));

    await sendMessage(log.socket, channel.id, "@coder 아직 있어?");
    const run = await runOf(log, coder.id);
    expect(await log.terminal(run.id)).toMatchObject({
      status: "error",
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
    expect((await runErrorNotice(log, run.id)).components).toMatchObject(RETRY_COMPONENTS);
    await expect(runner.reconnect()).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("시나리오 6 — 두 러너가 coder 를 알림 → 뒤 러너의 coder 만 충돌로 표시, 런은 먼저 붙은 러너로", async () => {
    const { runner, coder, channel, log } = await start();
    const second = await issueToken("desktop");
    const other = await connectRunner(second.token);
    expect(other.helloResult).toMatchObject({ ok: true, conflicts: ["coder"] });

    const status = await setupStatus();
    expect(status.runners.list.map((r) => [r.label, r.agents.map((a) => [a.id, a.conflict])])).toEqual([
      ["macbook", [["coder", false]]],
      ["desktop", [["coder", true]]],
    ]);

    await sendMessage(log.socket, channel.id, "@coder 누구야");
    const run = await runOf(log, coder.id);
    expect((await log.terminal(run.id)).status).toBe("done");
    expect(runner.runStarts).toHaveLength(1);
    expect(other.runStarts).toHaveLength(0);
  });

  it("시나리오 7 — OpenClaw dev 와 Claude coder 가 한 채널에서 서로 @멘션 릴레이, 깊이 한도에서 멈춤", async () => {
    const { coder } = await start((run) => {
      run.final("@dev 확인했습니다");
    });
    const { agent: dev } = ok(
      "POST /agents dev",
      await rest<{ agent: Agent }>(live, "POST", "/agents", {
        providerAgentId: "dev",
        handle: "dev",
        name: "Dev",
      }),
    );
    const channel = await channelWith([dev, coder], "relay");
    ok(
      "PATCH relayPolicy",
      await rest(live, "PATCH", `/channels/${channel.id}`, {
        relayPolicy: { maxRelayTurns: 2, allowPairs: "all" },
      }),
    );
    const log = await openChannelWire(live, channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: ({ index }) => ({ reply: index === 0 ? "@coder 부탁해" : "@coder 다시" }) },
    });

    await sendMessage(log.socket, channel.id, "@dev 시작");
    const devFirst = await log.until(
      () => log.states.find((s) => s.agentId === dev.id && s.relayDepth === 0),
      "dev 첫 런",
    );
    const coderRun = await log.until(
      () => log.states.find((s) => s.agentId === coder.id && s.relayDepth === 1),
      "coder 릴레이 런(relayDepth 1)",
    );
    const devSecond = await log.until(
      () => log.states.find((s) => s.agentId === dev.id && s.relayDepth === 2),
      "dev 릴레이 런(relayDepth 2)",
    );
    await log.until(
      () => log.created.find((m) => m.kind === "system" && m.systemMeta?.kind === "relay_limit"),
      "relay_limit 시스템 메시지",
    );
    for (const run of [devFirst, coderRun, devSecond])
      expect((await log.terminal(run.id)).status).toBe("done");
    // 본문의 @dev 는 저장 때 멘션 토큰으로 바뀐다 — 멘션으로 읽혔는지를 본다
    expect((await agentMessage(log, coderRun.id)).mentions.agents).toEqual([dev.id]);
    // 한도 뒤에는 coder 런이 더 없다
    expect(new Set(log.states.filter((s) => s.agentId === coder.id).map((s) => s.id)).size).toBe(1);
    expect(scenario.errors).toEqual([]);
  });

  it("시나리오 8 — outbound.post 카드 → 채널에 카드 메시지, ack 의 messageId 가 그 메시지", async () => {
    const acks: Array<{ ok: boolean; messageId?: string }> = [];
    const { coder, channel, log } = await start(async (run) => {
      const ack = await run.post({
        text: "배포할까요?",
        components: {
          blocks: [
            {
              type: "actions",
              items: [{ type: "button", id: "deploy", label: "배포", style: "primary" }],
            },
          ],
        },
      });
      acks.push(ack as { ok: boolean; messageId?: string });
      run.final("");
    });
    await sendMessage(log.socket, channel.id, "@coder 배포 준비");
    const run = await runOf(log, coder.id);
    expect((await log.terminal(run.id)).status).toBe("done");
    const card = await agentMessage(log, run.id);
    expect(card).toMatchObject({ bodyMd: "배포할까요?", components: { blocks: [{ type: "actions" }] } });
    expect(acks).toEqual([{ ok: true, messageId: card.id }]);
    // 빈 최종 답은 메시지를 만들지 않는다 — 카드 하나뿐
    expect(log.created.filter((m) => m.authorType === "agent")).toHaveLength(1);
  });

  it("시나리오 9 — 러너가 임계 넘게 끊기면 runner_down(key 토큰 id), 다시 붙으면 닫힌다", async () => {
    const { issued, runner } = await start(undefined, { deps: { disconnectEventMs: 300 } });
    const rowsOf = () =>
      live.app.db
        .select()
        .from(opsEvents)
        .where(and(eq(opsEvents.kind, "runner_down"), eq(opsEvents.key, issued.record.id)))
        .all();
    runner.disconnect();
    await vi.waitFor(() => expect(rowsOf()).toEqual([expect.objectContaining({ resolvedAt: null })]), {
      timeout: 5_000,
    });
    await runner.reconnect();
    await vi.waitFor(() => expect(rowsOf()[0]?.resolvedAt).not.toBeNull());
    expect(rowsOf()[0]?.detail).toMatchObject({ thresholdMs: 300, downMs: expect.any(Number) });
  });

  it("서버 종료 → 러너는 transport close 로 받는다(다시 붙는 사유), 토큰 폐기는 io server disconnect(종료하는 사유) [R4]", async () => {
    const { runner } = await start();
    const other = await connectRunner((await issueToken("desktop")).token);
    const second = await issueToken("revoked");
    const revoked = await connectRunner(second.token);
    const res = await live.app.fastify.inject({
      method: "DELETE",
      url: `/api/v1/setup/runner-tokens/${second.record.id}`,
      headers: live.auth.headers,
    });
    expect(res.statusCode).toBe(204);
    await vi.waitFor(() => expect(revoked.disconnectReasons).toEqual(["io server disconnect"]));

    // 종료 순서: 어댑터 close(전송만 닫음) → io.close
    await live.app.close();
    await vi.waitFor(() => {
      expect(runner.disconnectReasons).toEqual(["transport close"]);
      expect(other.disconnectReasons).toEqual(["transport close"]);
    });
  });

  it("시나리오 10 — 운영 요약에 러너 런 비용이 합쳐진다(usageTrustedProviders claude)", async () => {
    const { coder, channel, log } = await start();
    await sendMessage(log.socket, channel.id, "@coder 하나");
    const run = await runOf(log, coder.id);
    expect((await log.terminal(run.id)).status).toBe("done");
    const summary = OpsRunsSummary.parse(ok("GET /ops/runs", await rest(live, "GET", "/ops/runs?days=1")));
    expect(summary.usageTrustedProviders).toEqual(["claude"]);
    expect(summary.byAgent.find((r) => r.id === coder.id)).toMatchObject({
      runs: 1,
      tokens: 15,
      costUsd: 0.01,
    });
    expect(summary.byChannel.find((r) => r.id === channel.id)).toMatchObject({ tokens: 15, costUsd: 0.01 });
  });
});
