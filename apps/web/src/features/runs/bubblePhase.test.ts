import type { RunState } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { RUN, RUN2, runState, uid } from "../../../test/fixtures";
import { bubblePhase, hiddenAt, planBubbles } from "./bubblePhase";
import type { RunView } from "./runStore";

const view = (status: RunState["status"], over: Partial<RunView> = {}): RunView => ({
  state: runState({ status }),
  text: "",
  lastEventSeq: 0,
  ...over,
});

it.each([
  ["queued", { visible: true, label: "대기 중", stoppable: true, textVisible: false }],
  ["streaming", { visible: true, label: null, stoppable: true, textVisible: true }],
  ["tool", { visible: true, label: "도구 사용 중", stoppable: true, textVisible: true }],
  [
    "awaiting_approval",
    { visible: true, label: "승인 대기 — Phase 2 에서 지원", stoppable: true, textVisible: true },
  ],
  ["finalizing", { visible: true, label: null, stoppable: false, textVisible: true }],
] as const)("%s", (status, expected) => {
  expect(bubblePhase(view(status), { hasMessage: false, now: 0 })).toEqual(expected);
});

it("done: 같은 runId 메시지가 있으면 곧바로 숨김, 없으면 5초까지 유지", () => {
  expect(bubblePhase(view("done", { terminalAt: 0 }), { hasMessage: true, now: 0 }).visible).toBe(false);
  expect(bubblePhase(view("done", { terminalAt: 0 }), { hasMessage: false, now: 4_999 }).visible).toBe(true);
  expect(bubblePhase(view("done", { terminalAt: 0 }), { hasMessage: false, now: 5_000 }).visible).toBe(false);
});

it("error·aborted: 한 줄 상태를 3초 보이고 숨김", () => {
  const err = view("error", {
    terminalAt: 0,
    state: runState({ status: "error", error: { code: "TIMEOUT", message: "" } }),
  });
  expect(bubblePhase(err, { hasMessage: false, now: 2_999 })).toMatchObject({
    visible: true,
    label: "실행 실패: TIMEOUT",
    stoppable: false,
  });
  expect(bubblePhase(err, { hasMessage: false, now: 3_000 }).visible).toBe(false);
  expect(bubblePhase(view("aborted", { terminalAt: 0 }), { hasMessage: false, now: 1 }).label).toBe("중지됨");
  expect(bubblePhase(view("aborted", { terminalAt: 0 }), { hasMessage: false, now: 3_000 }).visible).toBe(
    false,
  );
});

it("중지 뒤 늦은 정본: aborted 는 같은 runId 메시지가 와도 「중지됨」 한 줄 그대로(본문은 목록에만)", () => {
  expect(bubblePhase(view("aborted", { terminalAt: 0 }), { hasMessage: true, now: 1 })).toEqual({
    visible: true,
    label: "중지됨",
    stoppable: false,
    textVisible: false,
  });
});

it("hiddenAt: 종료 런이 숨겨질 시각(정리 타이머가 다시 계산할 때) — 진행 중이면 undefined", () => {
  expect(hiddenAt(view("streaming"))).toBeUndefined();
  expect(hiddenAt(view("finalizing"))).toBeUndefined();
  expect(hiddenAt(view("done", { terminalAt: 100 }))).toBe(5_100);
  expect(hiddenAt(view("error", { terminalAt: 100 }))).toBe(3_100);
  expect(hiddenAt(view("aborted", { terminalAt: 100 }))).toBe(3_100);
  // 표와 같은 경계: 그 시각이 되면 숨김
  for (const status of ["done", "error", "aborted"] as const) {
    const v = view(status, { terminalAt: 100 });
    const at = hiddenAt(v) as number;
    expect(bubblePhase(v, { hasMessage: false, now: at - 1 }).visible).toBe(true);
    expect(bubblePhase(v, { hasMessage: false, now: at }).visible).toBe(false);
  }
});

describe("planBubbles", () => {
  const at = (id: string, status: RunState["status"], over: Partial<RunView> = {}): RunView => ({
    ...view(status, over),
    state: runState({ id, status }),
  });

  it("보일 버블(순서 그대로)·지울 종료 런·다음에 다시 계산할 시각", () => {
    const views = [
      at(RUN, "streaming"),
      at(RUN2, "aborted", { terminalAt: 1_000 }), // 4_000 에 숨김
      at(uid(103), "done", { terminalAt: 0 }), // 같은 runId 메시지 있음 → 곧바로 숨김
      at(uid(104), "error", { terminalAt: 0 }), // 3_000 에 이미 숨김
      at(uid(105), "done", { terminalAt: 500 }), // 5_500 에 숨김
    ];
    expect(planBubbles(views, new Set([uid(103)]), 3_500)).toEqual({
      visible: [RUN, RUN2, uid(105)],
      stale: [uid(103), uid(104)],
      nextAt: 4_000,
    });
  });

  it("진행 중인 런은 메시지가 있어도(메시지 툴로 중간에 보낸 것) 보이고, 지우지 않는다", () => {
    expect(planBubbles([at(RUN, "streaming")], new Set([RUN]), 0)).toEqual({
      visible: [RUN],
      stale: [],
      nextAt: undefined,
    });
  });
});
