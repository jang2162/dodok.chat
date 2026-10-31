/**
 * Phase 4 ③ 계획 태스크 4 — Claude 러너 통합 시나리오 1~10. 실제 서버(실제 OpenClawAdapter + 실제 러너 어댑터) + 가짜 Gateway·플러그인
 * + 가짜 러너(`/runner` 에 붙는 socket.io-client) + wire 클라이언트. 모델 런 0, 실제 시계 — 승인 기한·끊김 임계만 줄인다.
 * 기다림은 wire 이벤트(WireLog.until)와 vi.waitFor 로 한다
 */
import {
  type Agent,
  BRIDGE_ATTACHMENTS_PATH,
  type Channel,
  dodokSessionKey,
  IssueRunnerTokenResult,
  type Message,
  OpsRunsSummary,
  type Result,
  RUNNER_ATTACHMENTS_PATH,
  SetupStatus,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { io } from "socket.io-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opsEvents, runs } from "../../src/db/schema.sqlite";
import { createScenario } from "../fakes/scenario";
import { type FakeRunner, type FakeRunnerScript, startFakeRunner } from "../fakes/fake-runner";
import { bootLiveApp, type LiveApp, type LiveAppOptions } from "../helpers/live-app";
import { makePng } from "../helpers/png";
import { openChannelWire, rest, sendMessage, uploadImage, type WireLog } from "../helpers/scenario-steps";
import type { WireClient } from "../helpers/wire";
import { channelConversation, createRunnerAgentForTest } from "../helpers/seed";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });

const RETRY_COMPONENTS = {
  blocks: [
    { type: "actions", items: [{ type: "button", id: "retry_run", label: "다시 실행", style: "primary" }] },
  ],
};

describe("러너 통합 시나리오", () => {
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

  /** 러너 토큰 발급 → 가짜 러너 접속 → 그 러너의 프로젝트 src/dodok 와 러너 에이전트 coder → 채널 */
  async function start(script?: FakeRunnerScript, opts: LiveAppOptions = {}) {
    live = await bootLiveApp(opts);
    const issued = await issueToken("macbook");
    const runner = await connectRunner(issued.token, script);
    const { agent: coder, projectId } = createRunnerAgentForTest(live.app.db, {
      workspaceId: live.app.workspaceId,
      handle: "coder",
      name: "Coder",
      runnerTokenId: issued.record.id,
      relPath: "dodok",
    });
    const channel = await channelWith([coder]);
    const log = await openChannelWire(live, channel.id, sockets);
    return { issued, runner, coder, projectId, channel, log };
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

  it("시나리오 1 — 러너 에이전트 멘션 → 스트리밍 → 최종 답 메시지, 활동 탭에 도구 타임라인, run.start 에 세션 UUID·채널 규칙", async () => {
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
      agentId: coder.providerAgentId,
      sessionKey: dodokSessionKey(coder.providerAgentId, channelConversation(live.app.db, channel.id)),
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
      sessionKey: dodokSessionKey(
        coder.providerAgentId,
        channelConversation(live.app.db, channel.id),
        root.id,
      ),
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
    expect(again).toEqual({ ok: true, serverVersion: expect.any(String) });
    const retried = await pressRetry(log.socket, notice);
    if (!retried.ok) throw new Error(`다시 실행 실패: ${retried.error.code}`);
    const second = await runOf(log, coder.id, 1);
    expect((await log.terminal(second.id)).status).toBe("done");
    expect((await agentMessage(log, second.id)).bodyMd).toBe("이어서 했습니다");
    const [a, b] = runner.runStarts;
    expect(b?.deliver.runId).toBe(second.id);
    expect(b?.providerSessionId).toBe(a?.providerSessionId);
  });

  it("러너를 끄느라 멈춘 런(final runner_shutdown) → 사람 중지가 아니라 ADAPTER_UNAVAILABLE run_error 카드와 「다시 실행」", async () => {
    const { runner, coder, channel, log } = await start((run) =>
      run.final("", { stopReason: "runner_shutdown", costKind: "subscription_estimate" }),
    );
    await sendMessage(log.socket, channel.id, "@coder 하나");
    const run = await runOf(log, coder.id);
    expect(await log.terminal(run.id)).toMatchObject({
      status: "error",
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
    const notice = await runErrorNotice(log, run.id);
    expect(notice.bodyMd).toBe("@coder 실행이 실패했습니다: ADAPTER_UNAVAILABLE");
    expect(notice.components).toMatchObject(RETRY_COMPONENTS);
    expect(runner.runStarts).toHaveLength(1);
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

  it("시나리오 6 — 러너가 둘 붙어 있어도 coder 의 런은 coder 가 묶인 러너로만 간다", async () => {
    const { runner, coder, channel, log } = await start();
    const second = await issueToken("desktop");
    const other = await connectRunner(second.token);
    expect(other.helloResult).toEqual({ ok: true, serverVersion: expect.any(String) });
    expect((await setupStatus()).runners.list.map((r) => r.label)).toEqual(["macbook", "desktop"]);

    await sendMessage(log.socket, channel.id, "@coder 누구야");
    const run = await runOf(log, coder.id);
    expect((await log.terminal(run.id)).status).toBe("done");
    expect(runner.runStarts).toHaveLength(1);
    expect(other.runStarts).toHaveLength(0);
  });

  it("시나리오 6′ — coder 의 러너가 끊기면 다른 토큰 러너가 붙어 있어도 맡지 않고, 프로젝트를 그 러너로 옮기면 그 러너가 맡는다 [PR8]", async () => {
    const { runner, coder, projectId, channel, log } = await start();
    const listed = async () =>
      ok("GET /agents", await rest<{ agents: Agent[] }>(live, "GET", "/agents")).agents.find(
        (a) => a.id === coder.id,
      );
    expect(coder.runner).toMatchObject({ label: "macbook", revoked: false });

    runner.close();
    const second = await issueToken("desktop");
    const other = await connectRunner(second.token);
    await sendMessage(log.socket, channel.id, "@coder 거기 있어?");
    const lost = await runOf(log, coder.id);
    expect(await log.terminal(lost.id)).toMatchObject({
      status: "error",
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
    expect(other.runStarts).toHaveLength(0);

    const res = await rest(live, "POST", `/runner-projects/${projectId}/move`, {
      runnerId: second.record.id,
    });
    expect(res.status).toBe(200);
    expect(other.fsRequests).toEqual([["project.check", { rootId: "src", relPath: "dodok" }]]);
    expect((await listed())?.runner).toMatchObject({ tokenId: second.record.id, label: "desktop" });
    await sendMessage(log.socket, channel.id, "@coder 이제는?");
    const moved = await runOf(log, coder.id, 1);
    expect((await log.terminal(moved.id)).status).toBe("done");
    expect(other.runStarts.map((s) => s.deliver.runId)).toEqual([moved.id]);
  });

  it("프로젝트를 옮겨도 도는 런은 옛 러너에서 끝까지 간다 — 옮긴 뒤 온 post·최종 답이 그 런의 글로 저장되고 런이 끝난다 [dm-t4 I1·PR8]", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acks: Array<{ ok: boolean; messageId?: string }> = [];
    const { coder, projectId, channel, log } = await start(async (run) => {
      await gate;
      acks.push((await run.post({ text: "카드" })) as { ok: boolean; messageId?: string });
      run.final("최종 답");
    });
    await sendMessage(log.socket, channel.id, "@coder 일해");
    const run = await runOf(log, coder.id);
    const second = await issueToken("desktop");
    const other = await connectRunner(second.token);
    const res = await rest(live, "POST", `/runner-projects/${projectId}/move`, {
      runnerId: second.record.id,
    });
    expect(res.status).toBe(200);
    release();

    expect((await log.terminal(run.id)).status).toBe("done");
    const mine = log.created.filter((m) => m.authorType === "agent" && m.runId === run.id);
    expect(mine.map((m) => m.bodyMd)).toEqual(["카드", "최종 답"]);
    expect(acks).toEqual([{ ok: true, messageId: mine[0]?.id }]);
    expect(other.runStarts).toHaveLength(0);
  });

  const ruleNotices = (log: WireLog) =>
    log.created.filter(
      (m) => m.systemMeta?.kind === "info" && m.bodyMd.startsWith("채널 규칙이나 에이전트 지시가 바뀌어"),
    );

  const patchPrompt = async (channelId: string, prompt: string) =>
    ok("PATCH prompt", await rest(live, "PATCH", `/channels/${channelId}`, { prompt }));

  it("채널 규칙이 바뀌면 러너 세션은 다음 런에서 새 세션 id — 알림 한 번, 그 다음 런은 같은 새 id [p4r-fix]", async () => {
    const { runner, coder, channel, log } = await start();
    await sendMessage(log.socket, channel.id, "@coder 하나");
    expect((await log.terminal((await runOf(log, coder.id, 0)).id)).status).toBe("done");

    await patchPrompt(channel.id, "답 첫 줄에 [NEW] 를 붙인다");
    await sendMessage(log.socket, channel.id, "@coder 둘");
    const second = await runOf(log, coder.id, 1);
    expect((await log.terminal(second.id)).status).toBe("done");
    await sendMessage(log.socket, channel.id, "@coder 셋");
    expect((await log.terminal((await runOf(log, coder.id, 2)).id)).status).toBe("done");

    const [a, b, c] = runner.runStarts;
    expect(b?.providerSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b?.providerSessionId).not.toBe(a?.providerSessionId);
    expect(c?.providerSessionId).toBe(b?.providerSessionId);
    expect(b?.deliver.sessionKey).toBe(a?.deliver.sessionKey);
    const notices = ruleNotices(log);
    expect(notices.map((m) => m.bodyMd)).toEqual([
      "채널 규칙이나 에이전트 지시가 바뀌어 @coder 이 앞 작업 맥락(도구 결과·긴 작업)을 이어 가지 않습니다 — 채널의 최근 글은 그대로 봅니다",
    ]);
    expect(notices[0]?.threadRootId).toBeUndefined();
  });

  it("스레드 하위 세션도 각각 — 규칙이 바뀌면 스레드 런은 그 스레드에, 채널 런은 채널에 알림 [p4r-fix]", async () => {
    const { runner, coder, channel, log } = await start();
    const root = await sendMessage(log.socket, channel.id, "루트");
    await sendMessage(log.socket, channel.id, "@coder 채널에서", {});
    expect((await log.terminal((await runOf(log, coder.id, 0)).id)).status).toBe("done");
    await sendMessage(log.socket, channel.id, "@coder 스레드에서", { threadRootId: root.id });
    expect((await log.terminal((await runOf(log, coder.id, 1)).id)).status).toBe("done");

    await patchPrompt(channel.id, "새 규칙");
    await sendMessage(log.socket, channel.id, "@coder 스레드 다시", { threadRootId: root.id });
    expect((await log.terminal((await runOf(log, coder.id, 2)).id)).status).toBe("done");
    expect(ruleNotices(log).map((m) => m.threadRootId)).toEqual([root.id]);
    await sendMessage(log.socket, channel.id, "@coder 채널 다시");
    expect((await log.terminal((await runOf(log, coder.id, 3)).id)).status).toBe("done");

    const [chan1, thread1, thread2, chan2] = runner.runStarts;
    expect(thread2?.deliver.sessionKey).toBe(
      dodokSessionKey(coder.providerAgentId, channelConversation(live.app.db, channel.id), root.id),
    );
    expect(thread2?.providerSessionId).not.toBe(thread1?.providerSessionId);
    expect(chan2?.providerSessionId).not.toBe(chan1?.providerSessionId);
    expect(chan2?.providerSessionId).not.toBe(thread2?.providerSessionId);
    expect(ruleNotices(log).map((m) => m.threadRootId)).toEqual([root.id, undefined]);
  });

  it("규칙이 바뀐 뒤 같은 세션에 멘션 둘이 겹쳐도 새 세션 id·알림은 한 번 [p4r-fix]", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let index = 0;
    const { runner, coder, channel, log } = await start(async (run) => {
      const mine = index++;
      if (mine === 1) await gate; // 규칙이 바뀐 뒤 첫 런이 도는 동안 둘째 멘션이 뒤에 선다
      run.final(`답 ${mine}`);
    });
    await sendMessage(log.socket, channel.id, "@coder 처음");
    expect((await log.terminal((await runOf(log, coder.id, 0)).id)).status).toBe("done");

    await patchPrompt(channel.id, "새 규칙");
    await sendMessage(log.socket, channel.id, "@coder 하나");
    await sendMessage(log.socket, channel.id, "@coder 둘");
    const second = await runOf(log, coder.id, 1);
    const third = await runOf(log, coder.id, 2);
    await vi.waitFor(() => expect(runner.runStarts).toHaveLength(2));
    release();
    expect((await log.terminal(second.id)).status).toBe("done");
    expect((await log.terminal(third.id)).status).toBe("done");

    const [a, b, c] = runner.runStarts;
    expect(b?.providerSessionId).not.toBe(a?.providerSessionId);
    expect(c?.providerSessionId).toBe(b?.providerSessionId);
    expect(ruleNotices(log)).toHaveLength(1);
  });

  it("OpenClaw 에이전트는 규칙이 바뀌어도 새 대화가 아니다 — 같은 세션 키, 다음 인바운드에 channelPrompt, 알림 없음 [p4r-fix]", async () => {
    const { coder } = await start();
    const { agent: dev } = ok(
      "POST /agents dev",
      await rest<{ agent: Agent }>(live, "POST", "/agents", {
        providerAgentId: "dev",
        handle: "dev",
        name: "Dev",
        gatewayId: live.gatewayId,
      }),
    );
    const channel = await channelWith([dev, coder], "mixed");
    const log = await openChannelWire(live, channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: () => ({ reply: "네" }) },
    });
    await sendMessage(log.socket, channel.id, "@dev 하나");
    expect((await log.terminal((await runOf(log, dev.id, 0)).id)).status).toBe("done");
    await patchPrompt(channel.id, "새 규칙");
    await sendMessage(log.socket, channel.id, "@dev 둘");
    expect((await log.terminal((await runOf(log, dev.id, 1)).id)).status).toBe("done");
    await sendMessage(log.socket, channel.id, "@dev 셋");
    expect((await log.terminal((await runOf(log, dev.id, 2)).id)).status).toBe("done");

    // 이어 간 OpenClaw 세션은 매 턴 새 프롬프트를 받는다(ADR 0003) — 리비전을 몰래 맞추면 셋째 턴에서 빠진다
    const delivered = live.plugin.received.filter((d) => d.channelId === channel.id);
    expect(delivered).toHaveLength(3);
    expect(new Set(delivered.map((d) => d.sessionKey)).size).toBe(1);
    expect(delivered[0]?.context.channelPrompt).toBeUndefined();
    expect(delivered.slice(1).map((d) => d.context.channelPrompt)).toEqual(["새 규칙", "새 규칙"]);
    expect(ruleNotices(log)).toEqual([]);
    expect(scenario.errors).toEqual([]);
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
        gatewayId: live.gatewayId,
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

  it("서버 재시작 → 러너는 transport close 로 받고 러너 규칙대로 다시 붙어 hello 까지, 토큰 폐기는 io server disconnect 라 돌아오지 않는다 [R4]", async () => {
    // 재시작 뒤에도 토큰이 살아 있게 파일 DB — live.dir 은 close() 가 지우므로 따로 둔다
    const dbDir = mkdtempSync(join(tmpdir(), "dodok-runner-restart-"));
    const env = { DB_PATH: join(dbDir, "dodok.sqlite") };
    const autoReconnect = { minMs: 50, maxMs: 200 };
    // 두 서버의 거절 줄을 모은다 — 폐기된 러너가 다시 붙으려 했는지를 서버 인증이 아니라 시도 자체로 본다(리뷰 N3)
    const lines: string[] = [];
    const logger = pino({ level: "warn" }, { write: (line: string) => void lines.push(line) });
    const rejectedHandshakes = () => lines.filter((l) => l.includes("runner connection rejected"));
    try {
      live = await bootLiveApp({ env, deps: { logger } });
      const port = Number(new URL(live.app.url).port);
      const connectAuto = async (label: string) => {
        const runner = await startFakeRunner({
          url: live.app.url,
          token: (await issueToken(label)).token,
          autoReconnect,
        });
        runners.push(runner);
        return runner;
      };
      const [macbook, desktop] = [await connectAuto("macbook"), await connectAuto("desktop")];
      const second = await issueToken("revoked");
      const revoked = await startFakeRunner({ url: live.app.url, token: second.token, autoReconnect });
      runners.push(revoked);
      const res = await live.app.fastify.inject({
        method: "DELETE",
        url: `/api/v1/setup/runner-tokens/${second.record.id}`,
        headers: live.auth.headers,
      });
      expect(res.statusCode).toBe(204);
      await vi.waitFor(() => expect(revoked.disconnectReasons).toEqual(["io server disconnect"]));

      // 종료 순서: 어댑터 close(전송만 닫음) → io.close
      await live.close();
      await vi.waitFor(() => {
        expect(macbook.disconnectReasons).toEqual(["transport close"]);
        expect(desktop.disconnectReasons).toEqual(["transport close"]);
      });
      expect(macbook.connected).toBe(false);

      // 같은 주소·같은 DB 로 다시 띄우면 러너가 스스로 돌아와 hello 가 통한다
      live = await bootLiveApp({ env, port, deps: { logger } });
      await vi.waitFor(
        () => {
          expect(macbook.helloCount).toBe(2);
          expect(desktop.helloCount).toBe(2);
        },
        { timeout: 10_000 },
      );
      expect(macbook.helloResult).toEqual({ ok: true, serverVersion: expect.any(String) });
      expect(macbook.connected).toBe(true);
      const status = await setupStatus();
      expect(status.runners.list.map((r) => r.label).sort()).toEqual(["desktop", "macbook"]);
      // 폐기된 러너는 규칙대로 멈춰 있다 — 다시 붙으려 하지도 않는다. helloCount 만 보면 서버 인증(폐기 토큰 UNAUTHORIZED)이
      // 막아 준 것과 가르지 못한다. 시도했다면 그 핸드셰이크가 거절 줄을 남긴다 — 돌아온 러너들보다 먼저 끊겼고, 백오프 상한의 두 배를
      // 더 기다리므로 다시 붙을 틈이 충분했다
      await new Promise((done) => setTimeout(done, autoReconnect.maxMs * 2));
      expect(rejectedHandshakes()).toEqual([]);
      expect(revoked.helloCount).toBe(1);
      expect(revoked.connected).toBe(false);
    } finally {
      await live.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("시나리오 10 — 운영 요약에 러너 런 비용이 합쳐진다(usageTrustedPrograms claude)", async () => {
    const { coder, channel, log } = await start();
    await sendMessage(log.socket, channel.id, "@coder 하나");
    const run = await runOf(log, coder.id);
    expect((await log.terminal(run.id)).status).toBe("done");
    const summary = OpsRunsSummary.parse(ok("GET /ops/runs", await rest(live, "GET", "/ops/runs?days=1")));
    expect(summary.usageTrustedPrograms).toEqual(["claude"]);
    expect(summary.byAgent.find((r) => r.id === coder.id)).toMatchObject({
      runs: 1,
      tokens: 15,
      costUsd: 0.01,
    });
    expect(summary.byChannel.find((r) => r.id === channel.id)).toMatchObject({ tokens: 15, costUsd: 0.01 });
  });

  it("러너 쪽에서 대기열째 중지된 런(비용·토큰 없음)은 API 키 러너 행에 「환산 포함」을 켜지 않는다 [최종 리뷰 M2]", async () => {
    const { runner, coder, channel, log } = await start();
    await sendMessage(log.socket, channel.id, "@coder 하나");
    const first = await runOf(log, coder.id);
    expect((await log.terminal(first.id)).status).toBe("done");

    // 러너 동시 상한에 걸려 기다리다 중지된다 — CLI 를 띄우지 않았으니 abortedFinal() 그대로(비용·토큰 없음,
    // costKind 기본값). 서버가 중지한 런이면 어댑터가 런을 먼저 놓아 이 final 은 버려진다
    runner.onRunStart = (s) => ({ runId: s.deliver.runId, admission: "dispatch", queuedPosition: 1 });
    runner.script = (run) => run.final("", { stopReason: "aborted", costKind: "subscription_estimate" });
    await sendMessage(log.socket, channel.id, "@coder 둘");
    const second = await runOf(log, coder.id, 1);
    expect((await log.terminal(second.id)).status).toBe("aborted");
    expect(live.app.db.select().from(runs).where(eq(runs.id, second.id)).get()?.usage ?? null).toBeNull();

    const summary = OpsRunsSummary.parse(ok("GET /ops/runs", await rest(live, "GET", "/ops/runs?days=1")));
    const row = summary.byAgent.find((r) => r.id === coder.id);
    expect(row).toMatchObject({ runs: 2, aborted: 1, costUsd: 0.01 });
    expect(row?.costEstimated).toBe(false);
  });

  it("러너 토큰의 첨부 GET — 열린 런의 deliver 첨부는 200, 런이 끝나면 404, 러너 없는 채널의 사람 첨부는 404 [R5]", async () => {
    const seen: number[] = [];
    let token = "";
    const fetchAttachment = async (id: string, path = RUNNER_ATTACHMENTS_PATH) =>
      (await fetch(`${live.app.url}${path}/${id}`, { headers: { authorization: `Bearer ${token}` } })).status;
    const { issued, runner, coder, channel, log } = await start(async (run) => {
      for (const a of run.start.deliver.message.attachments) seen.push(await fetchAttachment(a.id));
      run.final("봤습니다");
    });
    token = issued.token;
    const image = await uploadImage(live, channel.id, makePng(6, 6), "shot.png");
    await sendMessage(log.socket, channel.id, "@coder 이 그림 봐", { attachments: [image.id] });
    const run = await runOf(log, coder.id);
    expect((await log.terminal(run.id)).status).toBe("done");
    expect(runner.runStarts[0]?.deliver.message.attachments.map((a) => a.id)).toEqual([image.id]);
    expect(seen).toEqual([200]);
    expect(await fetchAttachment(image.id)).toBe(404);

    // 리뷰 I1 재현 — 에이전트가 없는 채널에 묶인 사람 첨부
    const secret = await channelWith([], "secret");
    const hidden = await uploadImage(live, secret.id, makePng(7, 7), "secret.png");
    await sendMessage(log.socket, secret.id, "비밀", { attachments: [hidden.id] });
    expect(await fetchAttachment(hidden.id)).toBe(404);
    // 러너 토큰은 브리지 경로에서 통하지 않는다(리뷰 M1)
    expect(await fetchAttachment(image.id, BRIDGE_ATTACHMENTS_PATH)).toBe(401);
  });

  it("러너 토큰으로 /bridge 핸드셰이크는 UNAUTHORIZED, 브리지는 그대로 붙어 있다 [리뷰 M1]", async () => {
    const { issued } = await start();
    const reason = await new Promise<string>((resolve) => {
      const socket = io(`${live.app.url}/bridge`, {
        auth: { token: issued.token },
        transports: ["websocket"],
        reconnection: false,
        forceNew: true,
      });
      socket.once("connect", () => {
        socket.close();
        resolve("connected");
      });
      socket.once("connect_error", (err) => {
        socket.close();
        resolve(err.message);
      });
    });
    expect(reason).toBe("UNAUTHORIZED");
    // 브리지 슬롯은 그대로 가짜 플러그인의 것이다 — 러너 토큰이 그 자리를 밀어내지 않았다
    expect((await setupStatus()).gateways[0]?.bridge.state).toBe("connected");
  });

  it("열린 runner_down 은 그 토큰을 폐기하면 닫힌다 — 폐기된 토큰은 다시 붙을 수 없다 [리뷰 M2]", async () => {
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
    const res = await live.app.fastify.inject({
      method: "DELETE",
      url: `/api/v1/setup/runner-tokens/${issued.record.id}`,
      headers: live.auth.headers,
    });
    expect(res.statusCode).toBe(204);
    expect(rowsOf()).toEqual([expect.objectContaining({ resolvedAt: expect.any(Date) })]);
  });

  it("러너 동시 상한(maxConcurrentRuns 1 흉내)에 걸려 러너 대기열에 선 런은 queuedMs 를 넘겨도 TIMEOUT 이 아니다 — 앞 런이 끝나면 돌아 답한다 [최종 리뷰 I1]", async () => {
    const QUEUED_MS = 300;
    const { runner, coder, channel, log } = await start(undefined, {
      timeouts: { queuedMs: QUEUED_MS, runMs: 10_000 },
    });
    // 실제 러너 scheduler 처럼 — 한 자리가 차 있으면 queuedPosition 으로 받고, 앞 런이 끝나면 차례로 돈다
    let admitted = 0;
    runner.onRunStart = (s) =>
      admitted++ === 0
        ? { runId: s.deliver.runId, admission: "dispatch" }
        : { runId: s.deliver.runId, admission: "dispatch", queuedPosition: admitted - 1 };
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    const waiting: Array<() => void> = [];
    let turns = 0;
    runner.script = async (run) => {
      const turn = turns++;
      if (turn > 0) await new Promise<void>((resolve) => waiting.push(resolve));
      run.text(`런 ${turn}`);
      if (turn === 0) await firstHeld;
      run.final(`답 ${turn}`);
      waiting.shift()?.();
    };
    const other = await channelWith([coder], "runner-2");
    const otherLog = await openChannelWire(live, other.id, sockets);

    await sendMessage(log.socket, channel.id, "@coder 첫째");
    const first = await runOf(log, coder.id);
    await log.until(() => log.statesOf(first.id).some((s) => s.status === "streaming"), "첫 런 streaming");
    await sendMessage(otherLog.socket, other.id, "@coder 둘째");
    const second = await runOf(otherLog, coder.id);
    await otherLog.until(
      () => otherLog.eventsOf(second.id).find((e) => e.type === "RUN_QUEUED"),
      "둘째 런 RUN_QUEUED",
    );

    await new Promise((resolve) => setTimeout(resolve, QUEUED_MS * 3));
    expect(otherLog.statesOf(second.id).map((s) => s.status)).not.toContain("error");
    expect(runner.aborts).toEqual([]);

    releaseFirst();
    expect((await log.terminal(first.id)).status).toBe("done");
    expect((await otherLog.terminal(second.id)).status).toBe("done");
    expect((await agentMessage(otherLog, second.id)).bodyMd).toBe("답 1");
    expect(
      otherLog.created.filter((m) => m.systemMeta?.kind === "run_error" && m.systemMeta.runId === second.id),
    ).toEqual([]);
  });
});
