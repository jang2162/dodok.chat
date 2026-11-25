/**
 * 러너 백그라운드 작업의 서버 몫(백그라운드 작업 스펙 5.5, 계획 Task 7) — 실제 서버(실제 러너 어댑터) + 가짜 러너 + wire.
 * 추가 응답 런(run.followup)의 자리·관문·거절 알림, 작업 목록(tasks.update → tasks.updated·구독 스냅샷), 끄기(task.stop), 함께 끄기
 * (session.release), 러너가 다시 붙은 뒤 사라진 작업의 알림, 러너 상세의 작업 수, 그리고 러너 소유 대조. 모델 런 0
 */
import {
  type BackgroundTask,
  type Channel,
  type ConversationBackgroundTasks,
  IssueRunnerTokenResult,
  type Message,
  type RunnerCapability,
  type RunnerSummary,
  type RunState,
} from "@dodok/shared";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opsEvents } from "../src/db/schema.sqlite";
import { patchOpsSettings } from "../src/modules/ops/settings";
import { getRun } from "../src/modules/runs/store";
import { BACKGROUND_LOST_TEXT, followupRefusedText } from "../src/modules/runs/background";
import { type FakeRunner, type FakeRunnerScript, startFakeRunner } from "./fakes/fake-runner";
import { bootLiveApp, type LiveApp } from "./helpers/live-app";
import { openChannelWire, rest, sendMessage, type WireLog } from "./helpers/scenario-steps";
import { createRunnerAgentForTest } from "./helpers/seed";
import type { WireClient } from "./helpers/wire";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });

const BG_CAPABILITIES: RunnerCapability[] = [
  "threads",
  "interrupt",
  "approvals",
  "attachments",
  "backgroundTasks",
];
const RESYNC_MS = 300;

/** 답 하나를 남기는 대본 — 정본 메시지가 그 런의 첫 응답이 된다 */
const answer: FakeRunnerScript = (run) => {
  run.final("셸을 백그라운드로 띄웠습니다");
};

function task(originRunId: string, over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: `bash_${randomUUID().slice(0, 8)}`,
    kind: "shell",
    description: "npm test --watch",
    startedAt: new Date().toISOString(),
    originRunId,
    ...over,
  };
}

/** 조건이 참이 될 때까지 짧게 돌려 본다 — wire 밖 상태(DB·가짜 러너 기록)를 기다릴 때 */
async function poll<T>(pick: () => T | undefined | false, what: string, timeoutMs = 5_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = pick();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > until) throw new Error(`대기 ${timeoutMs}ms 초과: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("러너 백그라운드 작업 — 서버", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  const runners: FakeRunner[] = [];

  afterEach(async () => {
    for (const runner of runners.splice(0)) runner.close();
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  async function addRunner(handle: string) {
    const issued = IssueRunnerTokenResult.parse(
      (await rest(live, "POST", "/setup/runner-tokens", { label: handle })).body,
    );
    const runner = await startFakeRunner({
      url: live.app.url,
      token: issued.token,
      script: answer,
      hello: { capabilities: BG_CAPABILITIES },
    });
    runners.push(runner);
    const { agent } = createRunnerAgentForTest(live.app.db, {
      workspaceId: live.app.workspaceId,
      handle,
      runnerTokenId: issued.record.id,
      relPath: "dodok",
    });
    return { runner, agent, tokenId: issued.record.id };
  }

  async function start() {
    live = await bootLiveApp({ deps: { backgroundResyncMs: RESYNC_MS } });
    const { runner, agent: coder, tokenId } = await addRunner("coder");
    const { channel } = (await rest<{ channel: Channel }>(live, "POST", "/channels", { name: "bg" })).body;
    await rest(live, "POST", `/channels/${channel.id}/members`, { memberType: "agent", memberId: coder.id });
    const log = await openChannelWire(live, channel.id, sockets);
    const updates: Array<ConversationBackgroundTasks & { channelId: string }> = [];
    log.socket.on("tasks.updated", (p) => updates.push(p));
    return { runner, coder, tokenId, channel, log, updates };
  }

  const runOf = (log: WireLog, agentId: string, n = 0) =>
    log.until(
      () =>
        log.states
          .filter((s) => s.agentId === agentId)
          .filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i)[n],
      `에이전트 ${agentId} 런 ${n}`,
    );

  /** 멘션 하나로 끝난 원래 런과 그 첫 응답 */
  async function originRun(ctx: Awaited<ReturnType<typeof start>>, threadRootId?: string) {
    // 보내기 전에 센다 — 보낸 뒤에는 새 런의 run.state 가 이미 와 있을 수 있다
    const n = new Set(ctx.log.states.filter((s) => s.agentId === ctx.coder.id).map((s) => s.id)).size;
    const prompt = await sendMessage(
      ctx.log.socket,
      ctx.channel.id,
      "@coder 테스트 돌려줘",
      threadRootId === undefined ? {} : { threadRootId },
    );
    const state = await runOf(ctx.log, ctx.coder.id, n);
    expect((await ctx.log.terminal(state.id)).status).toBe("done");
    const run = getRun(live.app.db, state.id);
    if (!run) throw new Error("원래 런이 없다");
    const reply = await ctx.log.until(
      () => ctx.log.created.find((m) => m.runId === run.id),
      "원래 런의 응답",
    );
    return { run, prompt, reply };
  }

  const systemIn = (log: WireLog, threadRootId: string, text: string): Message[] =>
    log.created.filter((m) => m.kind === "system" && m.threadRootId === threadRootId && m.bodyMd === text);

  it("followup creates a running run in the origin reply thread", async () => {
    const ctx = await start();
    const { run, reply } = await originRun(ctx);
    const t = task(run.id);
    let followupState: RunState | undefined;
    const { result } = await ctx.runner.followup(
      { sessionKey: run.sessionKey, originRunId: run.id, taskIds: [t.taskId] },
      async (r) => {
        followupState = await ctx.log.until(() => ctx.log.statesOf(r.runId).at(-1), "추가 응답 run.state");
        r.final("테스트가 끝났습니다");
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deliver).toMatchObject({
      kind: "background",
      sessionKey: run.sessionKey,
      threadId: reply.id,
      conversationId: run.conversationId,
      runId: result.runId,
    });
    const adopted = getRun(live.app.db, result.runId);
    expect(adopted).toMatchObject({
      triggerKind: "background",
      backgroundOriginRunId: run.id,
      threadRootId: reply.id,
      sessionKey: run.sessionKey,
    });
    // 큐에 서지 않고 곧바로 도는 중 — RUN_QUEUED 없이 RUN_STARTED
    expect(adopted?.startedAt).toBeDefined();
    await poll(() => followupState, "추가 응답 상태");
    expect(followupState?.status).toBe("streaming");
    expect(ctx.log.eventsOf(result.runId).some((e) => e.type === "RUN_QUEUED")).toBe(false);
    expect(ctx.log.eventsOf(result.runId).some((e) => e.type === "RUN_STARTED")).toBe(true);
    expect((await ctx.log.terminal(result.runId)).status).toBe("done");
  });

  it("canonical of a background run is stored in the thread", async () => {
    const ctx = await start();
    const { run, reply } = await originRun(ctx);
    const { result } = await ctx.runner.followup(
      { sessionKey: run.sessionKey, originRunId: run.id, taskIds: ["bash_1"] },
      (r) => r.final("테스트 통과 — 12개"),
    );
    if (!result.ok) throw new Error("추가 응답이 거절됐다");
    expect((await ctx.log.terminal(result.runId)).status).toBe("done");
    const message = await ctx.log.until(
      () => ctx.log.created.find((m) => m.runId === result.runId),
      "추가 응답 메시지",
    );
    expect(message).toMatchObject({ threadRootId: reply.id, bodyMd: "테스트 통과 — 12개" });
  });

  it("followup uses the origin thread for a thread run", async () => {
    const ctx = await start();
    const root = await sendMessage(ctx.log.socket, ctx.channel.id, "스레드 루트");
    const { run } = await originRun(ctx, root.id);
    expect(run.threadRootId).toBe(root.id);
    const { result } = await ctx.runner.followup(
      { sessionKey: run.sessionKey, originRunId: run.id, taskIds: ["bash_1"] },
      (r) => r.final("스레드에 이어서"),
    );
    if (!result.ok) throw new Error("추가 응답이 거절됐다");
    expect(result.deliver).toMatchObject({ threadId: root.id, sessionKey: run.sessionKey });
    expect((await ctx.log.terminal(result.runId)).status).toBe("done");
    const message = await ctx.log.until(
      () => ctx.log.created.find((m) => m.runId === result.runId),
      "추가 응답 메시지",
    );
    expect(message.threadRootId).toBe(root.id);
  });

  it("followup falls back to the trigger message without a reply", async () => {
    const ctx = await start();
    ctx.runner.script = (r) => r.final(""); // 답 없이 끝난 런(도구만 썼다)
    const prompt = await sendMessage(ctx.log.socket, ctx.channel.id, "@coder 조용히 띄워");
    const state = await runOf(ctx.log, ctx.coder.id);
    // 빈 답은 정본 없이 finalizing 상한까지 기다린다 — 그 사이에도 원래 런은 이 러너의 런이다
    await ctx.log.until(
      () => ctx.log.statesOf(state.id).some((s) => s.status === "finalizing"),
      "원래 런 finalizing",
    );
    const run = getRun(live.app.db, state.id);
    if (!run) throw new Error("원래 런이 없다");
    const { result } = await ctx.runner.followup(
      { sessionKey: run.sessionKey, originRunId: run.id, taskIds: ["bash_1"] },
      (r) => r.final("끝났습니다"),
    );
    if (!result.ok) throw new Error("추가 응답이 거절됐다");
    expect(result.deliver.threadId).toBe(prompt.id);
    expect(getRun(live.app.db, result.runId)?.threadRootId).toBe(prompt.id);
  });

  it("rejects followup for a closed conversation", async () => {
    const ctx = await start();
    const { run, reply } = await originRun(ctx);
    expect((await rest(live, "PATCH", `/conversations/${run.conversationId}`, { closed: true })).status).toBe(
      200,
    );
    const before = ctx.log.states.length;
    const { result } = await ctx.runner.followup({
      sessionKey: run.sessionKey,
      originRunId: run.id,
      taskIds: ["bash_1"],
    });
    expect(result).toEqual({ ok: false, reason: "closed" });
    const text = followupRefusedText("세션이 닫혀");
    expect(text).toBe("백그라운드 작업이 끝났지만 세션이 닫혀 이어서 답하지 못했습니다");
    await ctx.log.until(() => systemIn(ctx.log, reply.id, text).length === 1, "거절 알림");
    // 런을 만들지 않았다
    expect(ctx.log.states.slice(before).filter((s) => s.agentId === ctx.coder.id)).toEqual([]);
  });

  it("rejects followup over the daily limit", async () => {
    const ctx = await start();
    const { run, reply } = await originRun(ctx);
    patchOpsSettings(live.app.db, live.app.workspaceId, { dailyRunLimit: 1 });
    const { result } = await ctx.runner.followup({
      sessionKey: run.sessionKey,
      originRunId: run.id,
      taskIds: ["bash_1"],
    });
    expect(result).toEqual({ ok: false, reason: "limit" });
    await ctx.log.until(
      () =>
        systemIn(ctx.log, reply.id, "백그라운드 작업이 끝났지만 오늘 런 한도로 이어서 답하지 못했습니다")
          .length === 1,
      "한도 거절 알림",
    );
    // 그 스레드의 시스템 글은 거절 글 하나 — 관문의 run_limit 알림이 따로 붙지 않는다(운영 사건은 남는다)
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.log.created.filter((m) => m.kind === "system" && m.threadRootId === reply.id)).toHaveLength(1);
    expect(live.app.db.select().from(opsEvents).where(eq(opsEvents.kind, "run_limit")).all()).toHaveLength(1);
  });

  it("rejects followup for a run of another runner", async () => {
    const ctx = await start();
    const { run } = await originRun(ctx);
    const other = await addRunner("other");
    const createdBefore = ctx.log.created.length;
    // 남의 런 id 와 그 세션 키를 그대로 대도 — 그 런을 맡은 러너가 아니다
    const { result } = await other.runner.followup({
      sessionKey: run.sessionKey,
      originRunId: run.id,
      taskIds: ["bash_1"],
    });
    expect(result).toEqual({ ok: false, reason: "unknown" });
    // 같은 러너라도 그 런의 세션 키가 아니면 거절
    const { result: wrongKey } = await ctx.runner.followup({
      sessionKey: `${run.sessionKey}:thread:${randomUUID()}`,
      originRunId: run.id,
      taskIds: ["bash_1"],
    });
    expect(wrongKey).toEqual({ ok: false, reason: "unknown" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.log.created.slice(createdBefore)).toEqual([]);
  });

  it("tasks.updated reaches channel subscribers only", async () => {
    const ctx = await start();
    const { run } = await originRun(ctx);
    const { channel: elsewhere } = (
      await rest<{ channel: Channel }>(live, "POST", "/channels", { name: "elsewhere" })
    ).body;
    const outsider = await openChannelWire(live, elsewhere.id, sockets);
    const outsiderUpdates: unknown[] = [];
    outsider.socket.on("tasks.updated", (p) => outsiderUpdates.push(p));
    const t = task(run.id);
    ctx.runner.tasks(run.sessionKey, [t]);
    const update = await poll(() => ctx.updates.at(-1), "tasks.updated");
    expect(update).toEqual({
      channelId: ctx.channel.id,
      conversationId: run.conversationId,
      runnerConnected: true,
      tasks: [t],
    });
    ctx.runner.tasks(run.sessionKey, []);
    await poll(() => ctx.updates.length === 2, "빈 목록");
    expect(ctx.updates[1]?.tasks).toEqual([]);
    expect(outsiderUpdates).toEqual([]);
  });

  it("ignores tasks for a session of another runner", async () => {
    const ctx = await start();
    const { run } = await originRun(ctx);
    const other = await addRunner("other");
    other.runner.tasks(run.sessionKey, [task(run.id)]);
    // 내 목록이 처리된 뒤에 본다 — 남의 목록은 버렸다
    ctx.runner.tasks(run.sessionKey, [task(run.id, { taskId: "bash_mine" })]);
    await poll(() => ctx.updates.length > 0, "내 목록");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.updates.map((u) => u.tasks.map((t) => t.taskId))).toEqual([["bash_mine"]]);
  });

  it("subscribe snapshot carries tasks", async () => {
    const ctx = await start();
    const { run } = await originRun(ctx);
    const t = task(run.id, { kind: "subagent", subagentType: "Explore", summary: "파일을 읽는 중" });
    ctx.runner.tasks(run.sessionKey, [t]);
    await poll(() => ctx.updates.length > 0, "tasks.updated");
    const again = await ctx.log.socket.emitWithAck("channel.subscribe", { channelId: ctx.channel.id });
    if (!again.ok) throw new Error("구독 실패");
    expect(again.data.tasks).toEqual([
      { conversationId: run.conversationId, runnerConnected: true, tasks: [t] },
    ]);
  });

  it("task.stop needs the same permission as run.abort", async () => {
    const ctx = await start();
    const { run } = await originRun(ctx);
    const t = task(run.id);
    ctx.runner.tasks(run.sessionKey, [t]);
    await poll(() => ctx.updates.length > 0, "tasks.updated");
    // 없는 런 — run.abort 와 같은 NOT_FOUND
    const missing = randomUUID();
    expect(await ctx.log.socket.emitWithAck("run.abort", { runId: missing })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await ctx.log.socket.emitWithAck("task.stop", { runId: missing, taskId: t.taskId })).toMatchObject(
      { ok: false, error: { code: "NOT_FOUND" } },
    );
    // 그 런을 볼 수 있으면 러너로 간다
    expect(await ctx.log.socket.emitWithAck("task.stop", { runId: run.id, taskId: t.taskId })).toEqual({
      ok: true,
      data: null,
    });
    expect(ctx.runner.taskStops).toEqual([{ sessionKey: run.sessionKey, taskId: t.taskId }]);
    // 러너가 끄지 못했으면 ADAPTER_UNAVAILABLE
    ctx.runner.onTaskStop = () => ({ ok: false });
    expect(await ctx.log.socket.emitWithAck("task.stop", { runId: run.id, taskId: t.taskId })).toMatchObject({
      ok: false,
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
    // 이미 끝난(목록에 없는) 작업은 아무것도 하지 않는다 — 끝난 런의 중지와 같다
    expect(await ctx.log.socket.emitWithAck("task.stop", { runId: run.id, taskId: "bash_gone" })).toEqual({
      ok: true,
      data: null,
    });
    expect(ctx.runner.taskStops).toHaveLength(2);
  });

  it("closing a session releases the runner session", async () => {
    const ctx = await start();
    const { run } = await originRun(ctx);
    ctx.runner.tasks(run.sessionKey, [task(run.id)]);
    await poll(() => ctx.updates.length > 0, "tasks.updated");
    expect((await rest(live, "PATCH", `/conversations/${run.conversationId}`, { closed: true })).status).toBe(
      200,
    );
    await poll(() => ctx.runner.releases.length > 0, "session.release");
    expect(ctx.runner.releases).toEqual([{ sessionKey: run.sessionKey }]);
    await poll(() => ctx.updates.at(-1)?.tasks.length === 0, "목록이 빈다");
  });

  it("lost tasks after reconnect leave one notice per thread", async () => {
    const ctx = await start();
    const first = await originRun(ctx);
    const second = await originRun(ctx);
    // 같은 세션의 작업 셋 — 둘은 첫 런, 하나는 둘째 런이 띄웠다
    ctx.runner.tasks(first.run.sessionKey, [
      task(first.run.id),
      task(first.run.id, { kind: "subagent", subagentType: "Explore" }),
      task(second.run.id),
    ]);
    await poll(() => ctx.updates.length > 0, "tasks.updated");
    ctx.runner.disconnect();
    await poll(() => ctx.updates.at(-1)?.runnerConnected === false, "끊김 표시");
    // 다시 붙었지만(러너 재시작) 그 세션의 목록을 보내지 않는다
    await ctx.runner.reconnect();
    await ctx.log.until(
      () =>
        systemIn(ctx.log, first.reply.id, BACKGROUND_LOST_TEXT).length === 1 &&
        systemIn(ctx.log, second.reply.id, BACKGROUND_LOST_TEXT).length === 1,
      "죽음 알림",
    );
    await poll(() => ctx.updates.at(-1)?.tasks.length === 0, "목록이 빈다");
    await new Promise((resolve) => setTimeout(resolve, RESYNC_MS));
    expect(systemIn(ctx.log, first.reply.id, BACKGROUND_LOST_TEXT)).toHaveLength(1);
  });

  it("an empty list after reconnect clears without a notice", async () => {
    const ctx = await start();
    const { run, reply } = await originRun(ctx);
    ctx.runner.tasks(run.sessionKey, [task(run.id)]);
    await poll(() => ctx.updates.length > 0, "tasks.updated");
    ctx.runner.disconnect();
    await poll(() => ctx.updates.at(-1)?.runnerConnected === false, "끊김 표시");
    await ctx.runner.reconnect();
    // 끊긴 사이 작업이 끝났다 — 러너가 빈 목록을 보낸다
    ctx.runner.tasks(run.sessionKey, []);
    await poll(() => ctx.updates.at(-1)?.tasks.length === 0, "목록이 빈다");
    await new Promise((resolve) => setTimeout(resolve, RESYNC_MS * 2));
    expect(systemIn(ctx.log, reply.id, BACKGROUND_LOST_TEXT)).toEqual([]);
  });

  it("a list resent after reconnect keeps the tasks", async () => {
    const ctx = await start();
    const { run, reply } = await originRun(ctx);
    const t = task(run.id);
    ctx.runner.tasks(run.sessionKey, [t]);
    await poll(() => ctx.updates.length > 0, "tasks.updated");
    ctx.runner.disconnect();
    await poll(() => ctx.updates.at(-1)?.runnerConnected === false, "끊김 표시");
    await ctx.runner.reconnect();
    ctx.runner.tasks(run.sessionKey, [t]);
    await poll(() => ctx.updates.at(-1)?.runnerConnected === true, "다시 붙음 표시");
    await new Promise((resolve) => setTimeout(resolve, RESYNC_MS * 2));
    expect(ctx.updates.at(-1)?.tasks).toEqual([t]);
    expect(systemIn(ctx.log, reply.id, BACKGROUND_LOST_TEXT)).toEqual([]);
  });

  it("runner detail counts background tasks", async () => {
    const ctx = await start();
    const { run } = await originRun(ctx);
    const detail = async () =>
      (await rest<{ runners: RunnerSummary[] }>(live, "GET", "/runners")).body.runners.find(
        (r) => r.id === ctx.tokenId,
      );
    expect((await detail())?.backgroundTasks).toBe(0);
    ctx.runner.tasks(run.sessionKey, [task(run.id), task(run.id)]);
    await poll(() => ctx.updates.length > 0, "tasks.updated");
    expect((await detail())?.backgroundTasks).toBe(2);
  });

  it("the server announces backgroundTasks in the hello result", async () => {
    const ctx = await start();
    expect(ctx.runner.helloResult).toMatchObject({ ok: true, features: ["backgroundTasks"] });
  });
});
