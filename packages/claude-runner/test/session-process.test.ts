import type { BackgroundTask, ErrorCode, RunEventBody, RunnerFollowupRequest } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { createClaudeDriver } from "../src/drivers/claude";
import { HELD_SETTINGS_EVENT, type ClaudeRunSpec } from "../src/drivers/claude/run";
import type { BackgroundHooks } from "../src/drivers/claude/session-process";
import { createRunSink } from "../src/sink";
import { createFakeBridge, type FakeBridge } from "./helpers/fake-bridge";
import { createFakeSdk, type FakeSdk, type ScriptStep, script } from "./helpers/fake-query";
import type { SdkMessage, SdkQuery } from "../src/drivers/claude/sdk";
import { AGENT, runSpec } from "./helpers/fixtures";

const RUN_1 = "0192f000-0000-7000-8000-00000000a001";
const RUN_2 = "0192f000-0000-7000-8000-00000000a002";
const RUN_3 = "0192f000-0000-7000-8000-00000000a003";

type Emitted =
  | { kind: "event"; event: RunEventBody }
  | { kind: "final"; final: Record<string, unknown> }
  | { kind: "error"; code: ErrorCode; message: string };

type Hooks = BackgroundHooks & {
  heldLog: Array<[string, boolean]>;
  tasksLog: Array<[string, BackgroundTask[]]>;
  followups: RunnerFollowupRequest[];
  /** 추가 응답 런마다 낸 것 */
  followupRuns: Map<
    string,
    { emitted: Emitted[]; controller: AbortController; closed: boolean; bridge: FakeBridge }
  >;
  /** 모든 런의 final 차례 — [runId, text] */
  order: Array<[string, unknown]>;
};

function hooksSpy(followup?: BackgroundHooks["requestFollowup"]): Hooks {
  const heldLog: Array<[string, boolean]> = [];
  const tasksLog: Array<[string, BackgroundTask[]]> = [];
  const followups: RunnerFollowupRequest[] = [];
  const followupRuns: Hooks["followupRuns"] = new Map();
  const order: Hooks["order"] = [];
  return {
    heldLog,
    tasksLog,
    followups,
    followupRuns,
    order,
    held: (key, holding) => void heldLog.push([key, holding]),
    tasksChanged: (key, tasks) => void tasksLog.push([key, tasks]),
    requestFollowup: async (req) => {
      followups.push(req);
      return followup ? followup(req) : { ok: false, reason: "unknown" };
    },
    openFollowup: ({ runId, workdir }) => {
      const entry = {
        emitted: [] as Emitted[],
        controller: new AbortController(),
        closed: false,
        bridge: createFakeBridge(),
      };
      followupRuns.set(runId, entry);
      const sink = createRunSink({
        workdir,
        bridge: entry.bridge,
        emit: {
          event: (event) => entry.emitted.push({ kind: "event", event }),
          final: (final) => {
            order.push([runId, final.text]);
            entry.emitted.push({ kind: "final", final });
          },
          error: (code, message) => entry.emitted.push({ kind: "error", code, message }),
          session: () => {},
        },
      });
      return { sink, signal: entry.controller.signal, close: () => void (entry.closed = true) };
    },
  };
}

/** 런 하나 — 런마다 sink·bridge·signal 을 따로 */
function runner(fake: FakeSdk, hooks: Hooks | null = hooksSpy()) {
  const driver = createClaudeDriver({
    sdk: fake,
    claudeCodeVersion: "2.1.283",
    isExecutable: () => false,
    baseEnv: { PATH: "/usr/bin", HOME: "/home/u" },
    closeGraceMs: 30,
    selfTurnWaitMs: 200,
    ...(hooks ? { hooks } : {}),
  });
  function start(spec: ClaudeRunSpec, bridge: FakeBridge = createFakeBridge()) {
    const emitted: Emitted[] = [];
    const controller = new AbortController();
    const sink = createRunSink({
      workdir: AGENT.workdir,
      bridge,
      emit: {
        event: (event) => emitted.push({ kind: "event", event }),
        final: (final) => {
          hooks?.order.push([spec.start.deliver.runId, final.text]);
          emitted.push({ kind: "final", final });
        },
        error: (code, message) => emitted.push({ kind: "error", code, message }),
        session: () => {},
      },
    });
    const done = driver.startRun(spec, sink, controller.signal);
    return { done, emitted, controller, bridge };
  }
  return { driver, start, hooks: hooks as Hooks };
}

const finals = (e: Emitted[]) => e.filter((x) => x.kind === "final");
const shellStarted = (id = "b1"): ScriptStep[] => [
  script.tasksChanged([{ task_id: id, task_type: "local_bash", description: "pnpm dev" }]),
  script.taskStarted(id, { description: "pnpm dev" }),
];
const shellStopped = (id = "b1"): SdkMessage[] => [
  script.taskUpdated(id, { status: "killed" }),
  script.taskNotification(id, "stopped"),
  script.tasksChanged([]),
];

async function until(check: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

const spec2 = (over: Partial<ClaudeRunSpec> = {}) => ({ ...runSpec({ runId: RUN_2 }), ...over });

describe("세션 프로세스 — 붙들기·다음 런 이어 넣기(백그라운드 작업 스펙 5.2)", () => {
  it("holds the process when a background task survives the result", async () => {
    const fake = createFakeSdk();
    const { start, hooks, driver } = runner(fake);
    fake.script(script.init(), ...shellStarted(), ...script.textTurn("msg_1", ["띄웠어요"]), {
      waitInput: true,
    });
    const first = start(runSpec());
    await first.done;
    expect(finals(first.emitted)).toMatchObject([{ final: { text: "띄웠어요" } }]);
    const call = fake.calls[0]!;
    expect(call.closes).toBe(0);
    expect(call.inputClosed).toBe(false);
    expect(call.finished).toBe(false);
    expect(hooks.heldLog).toEqual([[runSpec().start.deliver.sessionKey, true]]);
    expect(driver.background?.held()).toMatchObject([
      { sessionKey: runSpec().start.deliver.sessionKey, tasks: [{ taskId: "b1", originRunId: RUN_1 }] },
    ]);
    driver.background?.release(runSpec().start.deliver.sessionKey);
    await until(() => call.finished);
  });

  it("closes the process when the task list empties", async () => {
    const fake = createFakeSdk();
    const { start, hooks, driver } = runner(fake);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...script.textTurn("msg_1", ["띄웠어요"]),
      { sleep: 10 },
      ...shellStopped(),
    );
    await start(runSpec()).done;
    const call = fake.calls[0]!;
    await until(() => call.finished);
    expect(call.inputClosed).toBe(true);
    const key = runSpec().start.deliver.sessionKey;
    expect(hooks.heldLog).toEqual([
      [key, true],
      [key, false],
    ]);
    expect(hooks.tasksLog.at(-1)).toEqual([key, []]);
    expect(driver.background?.held()).toEqual([]);
  });

  it("keeps the scheduler slot until the released process exits", async () => {
    const fake = createFakeSdk();
    const { start, hooks } = runner(fake);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...script.textTurn("msg_1", ["띄웠어요"]),
      { sleep: 10 },
      ...shellStopped(),
      // 입력이 닫혀도 CLI 는 close(유예 뒤)까지 산다
      { hang: true },
    );
    await start(runSpec()).done;
    const call = fake.calls[0]!;
    const key = runSpec().start.deliver.sessionKey;
    await until(() => hooks.tasksLog.some(([k, t]) => k === key && t.length === 0));
    // 놓았지만 CLI 는 아직 산다 — 자리는 그대로
    expect(call.finished).toBe(false);
    expect(hooks.heldLog).toEqual([[key, true]]);
    await until(() => call.finished);
    await until(() => hooks.heldLog.length === 2);
    expect(hooks.heldLog).toEqual([
      [key, true],
      [key, false],
    ]);
  });

  it("does not hold without hooks — closes on the first result as before", async () => {
    const fake = createFakeSdk();
    const { start } = runner(fake, null);
    fake.script(script.init(), ...shellStarted(), ...script.textTurn("msg_1", ["띄웠어요"]));
    await start(runSpec()).done;
    expect(fake.calls[0]!.inputClosed).toBe(true);
  });

  it("routes the next run of a held session into the same process", async () => {
    const fake = createFakeSdk();
    const { start } = runner(fake);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...script.textTurn("msg_1", ["띄웠어요"]),
      { waitInput: true },
      script.init(),
      ...script.textTurn("msg_2", ["둘째 답"]),
      { waitInput: true },
    );
    await start(runSpec()).done;
    const second = start(spec2());
    await second.done;
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.prompts).toHaveLength(2);
    expect(finals(second.emitted)).toMatchObject([{ final: { text: "둘째 답" } }]);
    // 둘째 런의 이벤트는 둘째 런 id 로
    expect(second.emitted.every((e) => e.kind !== "event" || e.event.runId === RUN_2)).toBe(true);
  });

  it("rebinds the poster to the current run", async () => {
    const fake = createFakeSdk();
    const { start } = runner(fake);
    fake.script(
      script.init(),
      ...shellStarted(),
      { callTool: { name: "post", input: { text: "첫째 글" } } },
      ...script.textTurn("msg_1", ["띄웠어요"]),
      { waitInput: true },
      script.init(),
      { callTool: { name: "post", input: { text: "둘째 글" } } },
      ...script.textTurn("msg_2", ["둘째 답"]),
      { waitInput: true },
    );
    const b1 = createFakeBridge();
    const b2 = createFakeBridge();
    await start(runSpec(), b1).done;
    await start(spec2(), b2).done;
    expect(b1.posts.map((p) => [p.text, p.runId])).toEqual([["첫째 글", RUN_1]]);
    expect(b2.posts.map((p) => [p.text, p.runId])).toEqual([["둘째 글", RUN_2]]);
  });

  it("sends control calls of a held run with that run's id", async () => {
    const fake = createFakeSdk();
    const { start } = runner(fake);
    const getChannel = { callTool: { name: "get_channel", input: { channelId: RUN_1 } } };
    fake.script(
      script.init(),
      ...shellStarted(),
      getChannel,
      ...script.textTurn("msg_1", ["띄웠어요"]),
      { waitInput: true },
      script.init(),
      getChannel,
      ...script.textTurn("msg_2", ["둘째 답"]),
      { waitInput: true },
    );
    const b1 = createFakeBridge();
    const b2 = createFakeBridge();
    await start(runSpec(), b1).done;
    await start(spec2(), b2).done;
    expect(b1.controls.map((c) => [c.tool, c.runId])).toEqual([["get_channel", RUN_1]]);
    expect(b2.controls.map((c) => [c.tool, c.runId])).toEqual([["get_channel", RUN_2]]);
  });

  it("keeps alwaysAllowed per run", async () => {
    const fake = createFakeSdk();
    const { start } = runner(fake);
    const ask = (id: string) => ({
      askPermission: { toolName: "Bash", input: { command: "npm test" }, toolUseID: id },
    });
    fake.script(
      script.init(),
      ...shellStarted(),
      ask("t1"),
      ask("t2"), // 같은 런 — 「항상 허용」으로 카드 없이
      ...script.textTurn("msg_1", ["첫째"]),
      { waitInput: true },
      script.init(),
      ask("t3"), // 다음 런 — 다시 묻는다
      ...script.textTurn("msg_2", ["둘째"]),
      { waitInput: true },
    );
    const b1 = createFakeBridge();
    const first = start(runSpec(), b1);
    await b1.decide("t1", { decision: "allow-always" });
    await first.done;
    expect(b1.requested.map((r) => r.providerApprovalId)).toEqual(["t1"]);
    const b2 = createFakeBridge();
    const second = start(spec2(), b2);
    await b2.decide("t3", { decision: "allow-once" });
    await second.done;
    expect(b2.requested.map((r) => [r.providerApprovalId, r.runId])).toEqual([["t3", RUN_2]]);
  });

  it("keeps an allow-always with CLI suggestions inside the run — no session rule reaches the CLI", async () => {
    const fake = createFakeSdk();
    const { start } = runner(fake);
    const suggestions = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ] as never;
    fake.script(
      script.init(),
      ...shellStarted(),
      { askPermission: { toolName: "Bash", input: { command: "npm test" }, toolUseID: "t1", suggestions } },
      ...script.textTurn("msg_1", ["첫째"]),
      { waitInput: true },
    );
    const b1 = createFakeBridge();
    const first = start(runSpec(), b1);
    await b1.decide("t1", { decision: "allow-always" });
    await first.done;
    expect(fake.calls[0]!.permissions[0]).toEqual({
      behavior: "allow",
      updatedInput: { command: "npm test" },
    });
  });

  it("interrupt on a held process stops only the turn", async () => {
    const fake = createFakeSdk();
    const { start, driver } = runner(fake);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...script.textTurn("msg_1", ["띄웠어요"]),
      { waitInput: true },
      script.init(),
      { waitInterrupt: [script.errorResult("error_during_execution", ["[ede_diagnostic] interrupted"])] },
      { waitInput: true },
    );
    await start(runSpec()).done;
    const second = start(spec2());
    await until(() => fake.calls[0]!.prompts.length === 2);
    second.controller.abort();
    await second.done;
    await new Promise((r) => setTimeout(r, 60)); // 닫는 유예(30ms)가 지나도
    const call = fake.calls[0]!;
    expect(call.interrupts).toBe(1);
    expect(call.closes).toBe(0);
    expect(finals(second.emitted)).toMatchObject([{ final: { text: "", stopReason: "aborted" } }]);
    expect(driver.background?.held()).toMatchObject([{ tasks: [{ taskId: "b1" }] }]);
    driver.background?.release(runSpec().start.deliver.sessionKey);
  });

  it("applies setModel and setPermissionMode before the next turn", async () => {
    const fake = createFakeSdk();
    const { start } = runner(fake);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...script.textTurn("msg_1", ["첫째"]),
      { waitInput: true },
      script.init(),
      ...script.textTurn("msg_2", ["둘째"]),
      { waitInput: true },
    );
    await start(runSpec()).done;
    const second = start(spec2({ model: "opus", permissionMode: "acceptEdits", effort: "high" }));
    await second.done;
    const call = fake.calls[0]!;
    expect(call.controls).toEqual([
      { method: "setModel", arg: "opus" },
      { method: "setPermissionMode", arg: "acceptEdits" },
      { method: "applyFlagSettings", arg: { effortLevel: "high" } },
    ]);
    expect(call.controlsAtPrompt).toEqual([0, 3]);
    // 바꿀 수 있는 것만 바뀌었으면 표시 이벤트가 없다
    expect(second.emitted.some((e) => e.kind === "event" && e.event.type === "CUSTOM")).toBe(false);
  });

  it("emits dodok.held_settings when channel rules differ", async () => {
    const fake = createFakeSdk();
    const { start } = runner(fake);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...script.textTurn("msg_1", ["첫째"]),
      { waitInput: true },
      script.init(),
      ...script.textTurn("msg_2", ["둘째"]),
      { waitInput: true },
    );
    await start(runSpec()).done;
    const base = spec2();
    const second = start({
      ...base,
      disallowedTools: ["WebFetch", "WebSearch"],
      start: { ...base.start, channelRulesAppend: "# dodok channel settings\n새 규칙" },
    });
    await second.done;
    expect(second.emitted.find((e) => e.kind === "event" && e.event.type === "CUSTOM")).toEqual({
      kind: "event",
      event: {
        type: "CUSTOM",
        runId: RUN_2,
        name: HELD_SETTINGS_EVENT,
        value: { fields: ["channelRulesAppend", "disallowedTools"] },
      },
    });
  });

  it("a reset session (new session id) releases the held process and opens a new one", async () => {
    const fake = createFakeSdk();
    const { start } = runner(fake);
    fake.script(script.init(), ...shellStarted(), ...script.textTurn("msg_1", ["첫째"]), { waitInput: true });
    fake.script(script.init(), ...script.textTurn("msg_3", ["새 세션"]));
    await start(runSpec()).done;
    const third = start(runSpec({ runId: RUN_3, sessionId: "0192f000-0000-4000-8000-00000000e002" }));
    await third.done;
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.finished).toBe(true);
    expect(finals(third.emitted)).toMatchObject([{ final: { text: "새 세션" } }]);
  });

  it("charges a held turn the difference of the process total", async () => {
    const fake = createFakeSdk();
    const { start } = runner(fake);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...script.textTurn("msg_1", ["첫째"], "첫째", { total_cost_usd: 0.5 }),
      { waitInput: true },
      script.init(),
      ...script.textTurn("msg_2", ["둘째"], "둘째", { total_cost_usd: 0.75 }),
      { waitInput: true },
    );
    const first = start(runSpec());
    await first.done;
    const second = start(spec2());
    await second.done;
    expect(finals(first.emitted)[0]).toMatchObject({ final: { costUsd: 0.5 } });
    expect(finals(second.emitted)[0]).toMatchObject({ final: { costUsd: 0.25 } });
  });

  it("a held run aborted while loading images gives the turn back to the next run", async () => {
    const fake = createFakeSdk();
    const { start } = runner(fake);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...script.textTurn("msg_1", ["첫째"]),
      { waitInput: true },
      script.init(),
      ...script.textTurn("msg_3", ["셋째 답"]),
      { waitInput: true },
    );
    await start(runSpec()).done;
    // 둘째 런 — 이미지를 받는 사이 중지된다(붙든 프로세스의 자리를 쥔 뒤)
    const imageId = "0192f000-0000-7000-8000-0000000000f1";
    const bridge = createFakeBridge();
    let downloading = false;
    bridge.http.download = (_id, opts) =>
      new Promise((_resolve, reject) => {
        downloading = true;
        opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const base = spec2();
    const withImage: ClaudeRunSpec = {
      ...base,
      start: {
        ...base.start,
        deliver: {
          ...base.start.deliver,
          message: {
            ...base.start.deliver.message,
            attachments: [
              {
                id: imageId,
                kind: "image",
                url: `artifact://${imageId}`,
                name: "a.png",
                mime: "image/png",
                size: 3,
              },
            ],
          },
        },
      },
    };
    const second = start(withImage, bridge);
    await until(() => downloading);
    second.controller.abort();
    await second.done;
    expect(finals(second.emitted)).toMatchObject([{ final: { stopReason: "aborted" } }]);
    // 셋째 런은 같은 프로세스의 다음 턴으로 끝난다 — 둘째 런이 자리를 놓지 않으면 whenIdle 에서 영영 기다린다
    const third = start(runSpec({ runId: RUN_3 }));
    let settled = false;
    void third.done.then(() => (settled = true));
    await until(() => settled, 1500);
    expect(fake.calls).toHaveLength(1);
    expect(finals(third.emitted)).toMatchObject([{ final: { text: "셋째 답" } }]);
  });
});

const FOLLOW = "0192f000-0000-7000-8000-00000000f001";
const FOLLOW_2 = "0192f000-0000-7000-8000-00000000f002";
const followupOk =
  (runId = FOLLOW): BackgroundHooks["requestFollowup"] =>
  async () => ({
    ok: true,
    runId,
    deliver: {
      ...runSpec().start.deliver,
      kind: "background",
      runId,
      threadId: "0192f000-0000-7000-8000-00000000b009",
    },
  });
const shellDone = (id = "b1"): ScriptStep[] => [
  script.taskUpdated(id, { status: "completed" }),
  script.taskNotification(id, "completed"),
  script.tasksChanged([]),
];

describe("세션 프로세스 — 스스로 연 턴·한 번에 한 턴·끄기(백그라운드 작업 스펙 5.3)", () => {
  it("opens a follow-up run when the cli opens a turn on its own", async () => {
    const fake = createFakeSdk();
    const hooks = hooksSpy(followupOk());
    const { start } = runner(fake, hooks);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...script.textTurn("msg_1", ["띄웠어요"]),
      { sleep: 10 },
      ...shellDone(),
      script.init(),
      ...script.textTurn("msg_f", ["다 끝났어요"]),
      { waitInput: true },
    );
    await start(runSpec()).done;
    const call = fake.calls[0]!;
    await until(() => call.finished);
    expect(hooks.followups).toEqual([
      { sessionKey: runSpec().start.deliver.sessionKey, originRunId: RUN_1, taskIds: ["b1"] },
    ]);
    const run = hooks.followupRuns.get(FOLLOW)!;
    expect(finals(run.emitted)).toMatchObject([{ final: { text: "다 끝났어요" } }]);
    expect(run.emitted.filter((e) => e.kind === "event").length).toBeGreaterThan(0);
    expect(run.emitted.every((e) => e.kind !== "event" || e.event.runId === FOLLOW)).toBe(true);
    expect(run.closed).toBe(true);
    // 작업이 비어 추가 응답 뒤 닫았다
    expect(call.inputClosed).toBe(true);
    expect(call.prompts).toHaveLength(1);
  });

  it("sends control calls of a follow-up turn with the follow-up run id", async () => {
    const fake = createFakeSdk();
    const hooks = hooksSpy(followupOk());
    const { start } = runner(fake, hooks);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...script.textTurn("msg_1", ["띄웠어요"]),
      { sleep: 10 },
      ...shellDone(),
      script.init(),
      // 모델이 도구를 부르기까지의 시간 — 그 사이 서버가 추가 응답 런을 받아 준다
      { sleep: 20 },
      { callTool: { name: "get_channel", input: { channelId: RUN_1 } } },
      ...script.textTurn("msg_f", ["다 끝났어요"]),
      { waitInput: true },
    );
    const b1 = createFakeBridge();
    await start(runSpec(), b1).done;
    await until(() => fake.calls[0]!.finished);
    expect(b1.controls).toEqual([]);
    const run = hooks.followupRuns.get(FOLLOW)!;
    expect(run.bridge.controls.map((c) => [c.tool, c.runId])).toEqual([["get_channel", FOLLOW]]);
  });

  it("interrupts a follow-up turn when the followup request fails", async () => {
    const fake = createFakeSdk();
    const hooks = hooksSpy(async () => ({ ok: false, reason: "closed" }));
    const { start } = runner(fake, hooks);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...script.textTurn("msg_1", ["띄웠어요"]),
      { sleep: 10 },
      ...shellDone(),
      script.init(),
      script.messageStart("msg_f"),
      { waitInterrupt: [script.errorResult("error_during_execution", ["[ede_diagnostic] interrupted"])] },
      { waitInput: true },
    );
    await start(runSpec()).done;
    const call = fake.calls[0]!;
    await until(() => call.finished);
    expect(call.interrupts).toBe(1);
    expect(hooks.followupRuns.size).toBe(0);
    expect(hooks.followups).toHaveLength(1);
  });

  it("queues a human prompt behind a self-opened turn", async () => {
    const fake = createFakeSdk();
    const hooks = hooksSpy(followupOk());
    const { start } = runner(fake, hooks);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...shellStarted("b2"),
      ...script.textTurn("msg_1", ["띄웠어요"]),
      { sleep: 10 },
      script.taskNotification("b1", "completed"),
      script.tasksChanged([{ task_id: "b2", task_type: "local_bash", description: "pnpm dev" }]),
      script.init(),
      { sleep: 60 },
      ...script.textTurn("msg_f", ["b1 끝"]),
      { waitInput: true },
      script.init(),
      ...script.textTurn("msg_2", ["둘째"]),
      { waitInput: true },
    );
    await start(runSpec()).done;
    await until(() => hooks.followups.length === 1);
    const second = start(spec2());
    await second.done;
    expect(finals(hooks.followupRuns.get(FOLLOW)!.emitted)).toMatchObject([{ final: { text: "b1 끝" } }]);
    expect(finals(second.emitted)).toMatchObject([{ final: { text: "둘째" } }]);
    expect(hooks.order).toEqual([
      [RUN_1, "띄웠어요"],
      [FOLLOW, "b1 끝"],
      [RUN_2, "둘째"],
    ]);
    expect(fake.calls).toHaveLength(1);
  });

  it("waits again when the cli opens a turn while the held run changes settings", async () => {
    const fake = createFakeSdk();
    const hooks = hooksSpy(followupOk());
    const { start } = runner(fake, hooks);
    // setModel 을 붙잡아 두고 그 사이 CLI 가 스스로 턴을 열게 한다. 턴을 여는 때는 시험이 stopTask("go") 로 고른다
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((r) => (releaseModel = r));
    let modelCalled = false;
    let q: SdkQuery | undefined;
    const query = fake.query;
    fake.query = (args) => {
      const made = query(args);
      const setModel = made.setModel.bind(made);
      made.setModel = async (model) => {
        modelCalled = true;
        await modelGate;
        return setModel(model);
      };
      q = made;
      return made;
    };
    fake.script(
      script.init(),
      ...shellStarted(),
      ...shellStarted("b2"),
      ...script.textTurn("msg_1", ["띄웠어요"]),
      {
        waitStopTask: "go",
        emit: [
          script.taskNotification("b1", "completed"),
          script.tasksChanged([{ task_id: "b2", task_type: "local_bash", description: "pnpm dev" }]),
          script.init(),
        ],
      },
      { sleep: 80 },
      ...script.textTurn("msg_f", ["b1 끝"]),
      { waitInput: true },
      script.init(),
      ...script.textTurn("msg_2", ["둘째"]),
      { waitInput: true },
    );
    await start(runSpec()).done;
    // 둘째 런은 모델이 달라 setModel 에서 멈춘다 — 그 사이 b1 이 끝나 CLI 가 스스로 턴을 연다
    const second = start(spec2({ model: "claude-other" }));
    await until(() => modelCalled);
    await q!.stopTask("go");
    await until(() => hooks.followups.length === 1);
    releaseModel();
    await second.done;
    expect(finals(hooks.followupRuns.get(FOLLOW)!.emitted)).toMatchObject([{ final: { text: "b1 끝" } }]);
    expect(finals(second.emitted)).toMatchObject([{ final: { text: "둘째" } }]);
    expect(hooks.order).toEqual([
      [RUN_1, "띄웠어요"],
      [FOLLOW, "b1 끝"],
      [RUN_2, "둘째"],
    ]);
  });

  it("a queued human run aborted while waiting closes without a prompt", async () => {
    const fake = createFakeSdk();
    const hooks = hooksSpy(followupOk());
    const { start, driver } = runner(fake, hooks);
    fake.script(
      script.init(),
      ...shellStarted(),
      ...shellStarted("b2"),
      ...script.textTurn("msg_1", ["띄웠어요"]),
      { sleep: 10 },
      script.taskNotification("b1", "completed"),
      script.tasksChanged([{ task_id: "b2", task_type: "local_bash", description: "pnpm dev" }]),
      script.init(),
      { sleep: 80 },
      ...script.textTurn("msg_f", ["b1 끝"]),
      { waitInput: true },
    );
    await start(runSpec()).done;
    await until(() => hooks.followups.length === 1);
    const second = start(spec2());
    await new Promise((r) => setTimeout(r, 10));
    second.controller.abort();
    await second.done;
    expect(finals(second.emitted)).toMatchObject([{ final: { text: "", stopReason: "aborted" } }]);
    await until(() => finals(hooks.followupRuns.get(FOLLOW)?.emitted ?? []).length === 1);
    expect(fake.calls[0]!.prompts).toHaveLength(1);
    driver.background?.release(runSpec().start.deliver.sessionKey);
  });

  it("stopTask on a shell removes it without a follow-up", async () => {
    const fake = createFakeSdk();
    const hooks = hooksSpy(followupOk());
    const { start, driver } = runner(fake, hooks);
    fake.script(script.init(), ...shellStarted(), ...script.textTurn("msg_1", ["띄웠어요"]), {
      waitStopTask: "b1",
      emit: shellStopped(),
    });
    await start(runSpec()).done;
    const key = runSpec().start.deliver.sessionKey;
    expect(await driver.background?.stopTask(key, "nope")).toBe(false);
    expect(await driver.background?.stopTask("agent:x:dodok:channel:y", "b1")).toBe(false);
    expect(await driver.background?.stopTask(key, "b1")).toBe(true);
    const call = fake.calls[0]!;
    await until(() => call.finished);
    expect(call.controls).toEqual([{ method: "stopTask", arg: "b1" }]);
    expect(hooks.followups).toEqual([]);
    expect(hooks.tasksLog.at(-1)).toEqual([key, []]);
    expect(driver.background?.held()).toEqual([]);
  });

  it("release closes the process and clears tasks", async () => {
    const fake = createFakeSdk();
    const hooks = hooksSpy(followupOk());
    const { start, driver } = runner(fake, hooks);
    fake.script(script.init(), ...shellStarted(), ...script.textTurn("msg_1", ["띄웠어요"]), {
      waitInput: true,
    });
    await start(runSpec()).done;
    const key = runSpec().start.deliver.sessionKey;
    driver.background?.release(key);
    const call = fake.calls[0]!;
    await until(() => call.finished);
    expect(call.inputClosed).toBe(true);
    expect(hooks.heldLog).toEqual([
      [key, true],
      [key, false],
    ]);
    expect(hooks.tasksLog.at(-1)).toEqual([key, []]);
    expect(driver.background?.held()).toEqual([]);
    expect(hooks.followups).toEqual([]);
  });

  it("uses the origin of the first notification when two runs finish together", async () => {
    const fake = createFakeSdk();
    const hooks = hooksSpy(followupOk(FOLLOW_2));
    const { start } = runner(fake, hooks);
    fake.script(
      script.init(),
      ...shellStarted("b1"),
      ...script.textTurn("msg_1", ["첫째"]),
      { waitInput: true },
      script.init(),
      script.tasksChanged([
        { task_id: "b1", task_type: "local_bash", description: "pnpm dev" },
        { task_id: "b2", task_type: "local_bash", description: "pnpm test" },
      ]),
      script.taskStarted("b2", { description: "pnpm test" }),
      ...script.textTurn("msg_2", ["둘째"]),
      { sleep: 10 },
      script.taskNotification("b1", "completed"),
      script.taskNotification("b2", "completed"),
      script.tasksChanged([]),
      script.init(),
      ...script.textTurn("msg_f", ["둘 다 끝"]),
      { waitInput: true },
    );
    await start(runSpec()).done;
    await start(spec2()).done;
    const call = fake.calls[0]!;
    await until(() => call.finished);
    expect(hooks.followups).toEqual([
      { sessionKey: runSpec().start.deliver.sessionKey, originRunId: RUN_1, taskIds: ["b1", "b2"] },
    ]);
    expect(finals(hooks.followupRuns.get(FOLLOW_2)!.emitted)).toMatchObject([
      { final: { text: "둘 다 끝" } },
    ]);
  });
});
