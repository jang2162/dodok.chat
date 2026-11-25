import { BackgroundTask } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { createTaskTracker } from "../src/drivers/claude/tasks";
import { createPathMasker } from "../src/mask";
import { script, sdkMsg } from "./helpers/fake-query";

const RUN_A = "0192f000-0000-7000-8000-00000000000a";
const RUN_B = "0192f000-0000-7000-8000-00000000000b";

function tracker(run: { id: string | undefined } = { id: RUN_A }, roots: string[] = ["/home/u/repo"]) {
  return createTaskTracker({
    now: () => Date.parse("2026-11-24T00:00:00.000Z"),
    mask: createPathMasker(roots),
    currentRunId: () => run.id,
  });
}

describe("createTaskTracker — SDK 작업 메시지를 작업 목록으로(백그라운드 작업 스펙 5.4)", () => {
  it("replaces the list on background_tasks_changed", () => {
    const t = tracker();
    // ADR 0007 5.11 시나리오 1 의 순서 — changed 가 started 보다 먼저 온다
    const steps = [
      script.init(),
      script.tasksChanged([{ task_id: "b1", task_type: "local_bash", description: "sleep 3 && echo done" }]),
      script.taskStarted("b1"),
      script.success("ok"),
    ];
    for (const m of steps) t.apply(m);
    expect(t.list()).toEqual([
      {
        taskId: "b1",
        kind: "shell",
        description: "sleep 3 && echo done",
        startedAt: "2026-11-24T00:00:00.000Z",
        originRunId: RUN_A,
      },
    ]);
    for (const task of t.list()) expect(BackgroundTask.safeParse(task).success).toBe(true);
    const tail = [
      script.taskUpdated("b1", { status: "completed" }),
      script.taskNotification("b1", "completed"),
      script.tasksChanged([]),
    ];
    const results = tail.map((m) => t.apply(m));
    expect(t.list()).toEqual([]);
    expect(t.size()).toBe(0);
    expect(results[2]?.changed).toBe(false); // 알림에서 이미 뺐다
  });

  it("drops ambient tasks", () => {
    const t = tracker();
    t.apply(
      script.tasksChanged([
        { task_id: "w1", task_type: "local_watch", description: "watcher", ambient: true },
        { task_id: "b1", task_type: "local_bash", description: "pnpm dev" },
      ]),
    );
    expect(t.list().map((x) => x.taskId)).toEqual(["b1"]);
    expect(t.has("w1")).toBe(false);
    expect(t.apply(script.taskNotification("w1", "completed", { ambient: true })).notifications).toEqual([]);
  });

  it("ignores foreground bash", () => {
    const t = tracker();
    const a = t.apply(script.taskStarted("f1", { is_backgrounded: false }));
    const b = t.apply(script.taskNotification("f1", "completed", { output_file: "" }));
    expect(t.list()).toEqual([]);
    expect(a.changed).toBe(false);
    expect(b).toEqual({ changed: false, notifications: [] });
  });

  it("a foreground task moved to the background joins the list", () => {
    const t = tracker();
    t.apply(script.taskStarted("f1", { is_backgrounded: false, description: "pnpm build" }));
    expect(t.apply(script.taskUpdated("f1", { is_backgrounded: true })).changed).toBe(true);
    expect(t.list()).toMatchObject([{ taskId: "f1", description: "pnpm build", originRunId: RUN_A }]);
  });

  it("marks originRunId from the run that started it", () => {
    const run = { id: RUN_A as string | undefined };
    const t = tracker(run);
    t.apply(script.taskStarted("b1"));
    t.apply(script.tasksChanged([{ task_id: "b1", task_type: "local_bash", description: "a" }]));
    run.id = undefined; // 런이 끝났다
    run.id = RUN_B;
    t.apply(
      script.taskStarted("a1", { task_type: "local_agent", subagent_type: "Explore", description: "찾기" }),
    );
    t.apply(
      script.tasksChanged([
        { task_id: "b1", task_type: "local_bash", description: "a" },
        { task_id: "a1", task_type: "local_agent", description: "찾기" },
      ]),
    );
    expect(t.list()).toMatchObject([
      { taskId: "b1", kind: "shell", originRunId: RUN_A },
      { taskId: "a1", kind: "subagent", subagentType: "Explore", originRunId: RUN_B },
    ]);
    // 메타를 모르는 id — 지금 런이 없으면 마지막으로 알려진 런
    run.id = undefined;
    t.apply(
      script.tasksChanged([
        { task_id: "b1", task_type: "local_bash", description: "a" },
        { task_id: "a1", task_type: "local_agent", description: "찾기" },
        { task_id: "x1", task_type: "remote_thing", description: "?" },
      ]),
    );
    expect(t.list()[2]).toMatchObject({ taskId: "x1", kind: "other", originRunId: RUN_B });
  });

  it("masks description and cuts to 200", () => {
    const t = tracker();
    t.apply(
      script.taskStarted("b1", { description: `cat /home/u/repo/src/a.ts /etc/passwd ${"x".repeat(400)}` }),
    );
    t.apply(script.tasksChanged([{ task_id: "b1", task_type: "local_bash", description: "ignored" }]));
    t.apply(
      script.taskProgress("b1", { summary: `/home/u/repo/notes ${"y".repeat(500)}`, last_tool_name: "Grep" }),
    );
    const [task] = t.list();
    expect(task?.description.startsWith("cat src/a.ts <작업 디렉터리 밖>")).toBe(true);
    expect(task?.description.length).toBeLessThanOrEqual(200);
    expect(task?.summary?.startsWith("notes ")).toBe(true);
    expect(task?.summary?.length).toBeLessThanOrEqual(300);
    expect(task?.lastToolName).toBe("Grep");
    expect(BackgroundTask.safeParse(task).success).toBe(true);
  });

  it("emits a stopped notice for a killed shell", () => {
    const t = tracker();
    t.apply(script.taskStarted("b1", { description: "sleep 999" }));
    t.apply(script.tasksChanged([{ task_id: "b1", task_type: "local_bash", description: "sleep 999" }]));
    t.apply(script.taskUpdated("b1", { status: "killed" }));
    const r = t.apply(script.taskNotification("b1", "stopped"));
    expect(r).toEqual({
      changed: true,
      notifications: [{ taskId: "b1", status: "stopped", kind: "shell", originRunId: RUN_A }],
    });
    expect(t.list()).toEqual([]);
  });

  it("reset forgets everything", () => {
    const t = tracker();
    t.apply(script.tasksChanged([{ task_id: "b1", task_type: "local_bash", description: "a" }]));
    t.reset();
    expect(t.size()).toBe(0);
    expect(t.apply(sdkMsg({ type: "system", subtype: "init" }))).toEqual({
      changed: false,
      notifications: [],
    });
  });
});
