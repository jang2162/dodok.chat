import type { BackgroundTask } from "@dodok/shared";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CH, CH2, RUN, RUN2, uid } from "../../../test/fixtures";
import { groupByOriginRun, useBackgroundTasks, useBackgroundTaskStore } from "./useBackgroundTasks";

const CONV_A = uid(201);
const CONV_B = uid(202);
const task = (taskId: string, originRunId: string, over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  taskId,
  kind: "shell",
  description: `cmd ${taskId}`,
  startedAt: "2027-01-15T08:00:00.000Z",
  originRunId,
  ...over,
});

afterEach(() => useBackgroundTaskStore.getState().reset());

describe("useBackgroundTasks", () => {
  it("replaces tasks per conversation — 대화마다 바꿔 끼우고, 다른 대화·다른 채널은 건드리지 않는다", () => {
    const store = useBackgroundTaskStore.getState();
    store.apply(CH, {
      conversationId: CONV_A,
      runnerConnected: true,
      tasks: [task("a1", RUN), task("a2", RUN)],
    });
    store.apply(CH, { conversationId: CONV_B, runnerConnected: true, tasks: [task("b1", RUN2)] });
    store.apply(CH2, { conversationId: uid(203), runnerConnected: true, tasks: [task("c1", uid(301))] });
    // 같은 대화의 새 값은 더하는 것이 아니라 바꾼다 — a1 은 끝났다
    useBackgroundTaskStore
      .getState()
      .apply(CH, { conversationId: CONV_A, runnerConnected: true, tasks: [task("a2", RUN)] });
    const ch = useBackgroundTaskStore.getState().byChannel[CH]!;
    expect(ch[CONV_A]?.tasks.map((t) => t.taskId)).toEqual(["a2"]);
    expect(ch[CONV_B]?.tasks.map((t) => t.taskId)).toEqual(["b1"]);
    expect(useBackgroundTaskStore.getState().byChannel[CH2]).toBeDefined();

    // 비고 러너가 붙어 있으면 그 대화 자리를 지운다. 끊긴 채 비었으면 남긴다
    useBackgroundTaskStore.getState().apply(CH, { conversationId: CONV_A, runnerConnected: true, tasks: [] });
    expect(useBackgroundTaskStore.getState().byChannel[CH]).not.toHaveProperty(CONV_A);

    // 구독 결과는 그 채널의 정본 — 실리지 않은 대화는 지운다
    useBackgroundTaskStore
      .getState()
      .sync(CH, [{ conversationId: CONV_A, runnerConnected: false, tasks: [task("a3", RUN)] }]);
    expect(Object.keys(useBackgroundTaskStore.getState().byChannel[CH]!)).toEqual([CONV_A]);
    expect(useBackgroundTaskStore.getState().byChannel[CH2]).toBeDefined();
  });

  it("groups tasks by originRunId — 런 카드에 붙일 작업과 러너 연결, 작업이 남은 런 id", () => {
    const grouped = groupByOriginRun([
      { conversationId: CONV_A, runnerConnected: true, tasks: [task("a1", RUN), task("a2", RUN2)] },
      { conversationId: CONV_B, runnerConnected: false, tasks: [task("b1", RUN)] },
    ]);
    expect(grouped.get(RUN)?.tasks.map((t) => t.taskId)).toEqual(["a1", "b1"]);
    expect(grouped.get(RUN)?.runnerConnected).toBe(false);
    expect(grouped.get(RUN2)).toEqual({ tasks: [task("a2", RUN2)], runnerConnected: true });

    const { result } = renderHook(() => useBackgroundTasks(CH));
    expect(result.current.byRun(RUN)).toEqual({ tasks: [], runnerConnected: true });
    expect(result.current.activeRunIds.size).toBe(0);
    act(() =>
      useBackgroundTaskStore
        .getState()
        .apply(CH, { conversationId: CONV_A, runnerConnected: false, tasks: [task("a1", RUN)] }),
    );
    expect(result.current.byRun(RUN)).toEqual({ tasks: [task("a1", RUN)], runnerConnected: false });
    expect([...result.current.activeRunIds]).toEqual([RUN]);
  });

  it("drops one task — NOT_FOUND 로 지운 작업만 빼고, 비고 러너가 붙어 있으면 대화 자리도 지운다(리뷰 N1)", () => {
    const store = useBackgroundTaskStore.getState();
    store.apply(CH, {
      conversationId: CONV_A,
      runnerConnected: true,
      tasks: [task("a1", RUN), task("a2", RUN)],
    });
    store.apply(CH, { conversationId: CONV_B, runnerConnected: false, tasks: [task("b1", RUN2)] });
    const { result } = renderHook(() => useBackgroundTasks(CH));
    act(() => useBackgroundTaskStore.getState().drop(CH, "a1"));
    expect(result.current.byRun(RUN).tasks.map((t) => t.taskId)).toEqual(["a2"]);
    act(() => useBackgroundTaskStore.getState().drop(CH, "a2"));
    expect(useBackgroundTaskStore.getState().byChannel[CH]).not.toHaveProperty(CONV_A);
    expect([...result.current.activeRunIds]).toEqual([RUN2]);
    // 끊긴 채 비면 자리를 남긴다(「러너 연결 끊김」을 계속 보인다)
    act(() => useBackgroundTaskStore.getState().drop(CH, "b1"));
    expect(useBackgroundTaskStore.getState().byChannel[CH]?.[CONV_B]?.tasks).toEqual([]);
    // 모르는 작업·채널은 그대로
    const before = useBackgroundTaskStore.getState().byChannel;
    useBackgroundTaskStore.getState().drop(CH, "nope");
    useBackgroundTaskStore.getState().drop(CH2, "a1");
    expect(useBackgroundTaskStore.getState().byChannel).toBe(before);
  });
});
