import type { BackgroundTask, ErrorCode, RunEventBody, RunnerFollowupRequest } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { createClaudeDriver } from "../src/drivers/claude";
import { HELD_SETTINGS_EVENT, type ClaudeRunSpec } from "../src/drivers/claude/run";
import type { BackgroundHooks } from "../src/drivers/claude/session-process";
import { createRunSink } from "../src/sink";
import { createFakeBridge, type FakeBridge } from "./helpers/fake-bridge";
import { createFakeSdk, type FakeSdk, type ScriptStep, script } from "./helpers/fake-query";
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
};

function hooksSpy(followup?: BackgroundHooks["requestFollowup"]): Hooks {
  const heldLog: Array<[string, boolean]> = [];
  const tasksLog: Array<[string, BackgroundTask[]]> = [];
  const followups: RunnerFollowupRequest[] = [];
  return {
    heldLog,
    tasksLog,
    followups,
    held: (key, holding) => void heldLog.push([key, holding]),
    tasksChanged: (key, tasks) => void tasksLog.push([key, tasks]),
    requestFollowup: async (req) => {
      followups.push(req);
      return followup ? followup(req) : { ok: false, reason: "unknown" };
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
        final: (final) => emitted.push({ kind: "final", final }),
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
const shellStopped = (id = "b1"): ScriptStep[] => [
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
});
