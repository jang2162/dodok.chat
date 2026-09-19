import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { emptyTimeline, upsert } from "@/features/messages/timeline";
import { updateTimeline } from "@/realtime/timelineCache";
import { AGENT, CH, CH2, msg, RUN, RUN2, runState, textDelta } from "../../../test/fixtures";
import { authorsClient } from "../../../test/messages";
import { useRunStore } from "./runStore";
import { useChannelBubbles } from "./useChannelBubbles";

let qc: QueryClient;
beforeEach(() => {
  useRunStore.getState().reset();
  qc = authorsClient();
  // 쿼리 gc 타이머가 타이머 수 단언에 섞이지 않게
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, gcTime: Infinity } });
  qc.setQueryData(qk.timeline(CH), emptyTimeline());
});
afterEach(() => {
  vi.useRealTimers();
  useRunStore.getState().reset();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);
const run = (over: Parameters<typeof runState>[0]) =>
  act(() => useRunStore.getState().applyState(runState(over)));
/** 같은 runId 의 에이전트 메시지(확정 답)가 타임라인에 들어온다 */
const answer = (seq: number, runId = RUN) =>
  act(() =>
    updateTimeline(qc, CH, (t) =>
      upsert(t, msg(seq, { authorType: "agent", authorId: AGENT, runId, bodyMd: "답" })),
    ),
  );
/** 가짜 타이머에서 Query 알림(setTimeout 0)·효과를 흘린다 */
const flush = (ms = 0) => act(() => vi.advanceTimersByTime(ms));

function setup(channelId = CH) {
  let renders = 0;
  const hook = renderHook(
    ({ ch }) => {
      renders += 1;
      return useChannelBubbles(ch);
    },
    { wrapper, initialProps: { ch: channelId } },
  );
  return { ...hook, renders: () => renders };
}

it("진행 중인 런은 버블 — 다른 채널 런은 빼고, 델타가 와도 다시 그리지 않고 같은 배열", () => {
  run({ id: RUN, status: "streaming" });
  run({ id: RUN2, channelId: CH2, status: "streaming" });
  const { result, renders } = setup();
  expect(result.current).toEqual([RUN]);

  const first = result.current;
  const before = renders();
  act(() => useRunStore.getState().applyEvent(textDelta(1, "안녕")));
  act(() => useRunStore.getState().applyEvent(textDelta(2, "하세요")));
  run({ id: RUN, status: "tool" });
  expect(result.current).toBe(first);
  expect(renders()).toBe(before);
});

it("done: 같은 runId 의 에이전트 메시지가 오면 곧바로 빠지고 런 스토어에서도 지운다", async () => {
  run({ id: RUN, status: "streaming" });
  const { result } = setup();
  run({ id: RUN, status: "done" });
  expect(result.current).toEqual([RUN]); // 메시지를 기다린다

  answer(1);
  await vi.waitFor(() => expect(result.current).toEqual([]));
  expect(useRunStore.getState().runs[RUN]).toBeUndefined();
});

it("error·aborted 는 3초, 메시지 없는 done(빈 답)은 5초 뒤 빠지고 런 스토어에서 지운다", () => {
  vi.useFakeTimers();
  const { result } = setup();
  run({ id: RUN, status: "aborted" });
  run({ id: RUN2, status: "done" });
  expect(result.current).toEqual([RUN, RUN2]);

  flush(2_999);
  expect(result.current).toEqual([RUN, RUN2]);
  flush(1);
  expect(result.current).toEqual([RUN2]);
  expect(useRunStore.getState().runs[RUN]).toBeUndefined();

  flush(1_999);
  expect(result.current).toEqual([RUN2]);
  flush(1);
  expect(result.current).toEqual([]);
  expect(useRunStore.getState().runs).toEqual({});
});

it("중지 뒤 늦은 정본: 「중지됨」 버블은 메시지가 와도 3초 그대로, 지운 뒤 다시 살아나지 않는다", () => {
  vi.useFakeTimers();
  run({ id: RUN, status: "streaming" });
  const { result } = setup();
  run({ id: RUN, status: "aborted" });
  answer(1); // 서버는 중단된 런의 늦은 정본도 저장·라우팅한다
  flush();
  expect(result.current).toEqual([RUN]);

  flush(3_000);
  expect(result.current).toEqual([]);
  expect(useRunStore.getState().runs[RUN]).toBeUndefined();
  // 지운 런의 늦은 델타는 버려지고(모르는 런) 메시지가 더 와도 버블은 없다
  act(() => useRunStore.getState().applyEvent(textDelta(9, "늦은 델타")));
  answer(2);
  flush(10_000);
  expect(result.current).toEqual([]);
  expect(useRunStore.getState().runs[RUN]).toBeUndefined();
});

it("타이머가 조금 일찍 울려도(시계 어긋남) 다시 걸어 결국 숨긴다", () => {
  vi.useFakeTimers();
  const { result } = setup();
  run({ id: RUN, status: "aborted" });
  flush();
  // 타이머는 그대로 두고 벽시계만 10ms 늦춘다 — 울렸을 때 아직 3초가 안 된 것으로 보인다
  vi.setSystemTime(Date.now() - 10);
  flush(3_000);
  expect(result.current).toEqual([RUN]);
  flush(10);
  expect(result.current).toEqual([]);
});

it("정리 타이머는 채널을 옮기거나 화면이 내려가면 거둔다", () => {
  vi.useFakeTimers();
  run({ id: RUN, status: "aborted" });
  const { rerender, unmount } = setup();
  flush();
  expect(vi.getTimerCount()).toBe(1);

  rerender({ ch: CH2 });
  flush();
  expect(vi.getTimerCount()).toBe(0);

  rerender({ ch: CH });
  flush();
  expect(vi.getTimerCount()).toBe(1);

  unmount();
  flush();
  expect(vi.getTimerCount()).toBe(0);
  // 거둔 뒤에는 시간이 지나도 이 훅이 지우지 않는다(다시 들어오면 그때 정리)
  flush(10_000);
  expect(useRunStore.getState().runs[RUN]?.state.status).toBe("aborted");
});
