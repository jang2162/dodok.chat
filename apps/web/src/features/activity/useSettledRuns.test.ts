import type { RunState } from "@dodok/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { runState, uid } from "../../../test/fixtures";
import { SETTLED_RUNS_LIMIT, useSettledRuns } from "./useSettledRuns";

function setup(initial: readonly RunState[] = []) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(({ live }) => useSettledRuns(live), { wrapper, initialProps: { live: initial } });
  return { ...hook, invalidate };
}

const run = (n: number, status: RunState["status"] = "streaming") => runState({ id: uid(1000 + n), status });

it("종료를 본 런은 ended 에, 못 본 채 빠진 런은 vanished·stopped 에 적는다", () => {
  const { result, rerender, invalidate } = setup([run(1), run(2)]);
  rerender({ live: [run(1, "done"), run(2)] });
  // 버블 정리로 둘 다 빠진다 — 1 은 종료를 봤고 2 는 못 봤다
  rerender({ live: [] });
  expect([...result.current.ended.keys()]).toEqual([run(1).id]);
  expect([...result.current.vanished.keys()]).toEqual([run(2).id]);
  expect([...result.current.stopped.keys()]).toEqual([run(2).id]);
  expect(result.current.settledKey).toBe([run(1).id, run(2).id].sort().join(","));
  // 새로 빠진 런의 타임라인만 다시 받는다
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.runEvents(run(2).id) });
});

it("빠졌던 런이 다시 실시간으로 오면 stopped 에서 빠진다", () => {
  const { result, rerender } = setup([run(1)]);
  rerender({ live: [] });
  expect(result.current.stopped.has(run(1).id)).toBe(true);
  rerender({ live: [run(1)] });
  expect(result.current.stopped.has(run(1).id)).toBe(false);
});

it(`채널당 상한 ${SETTLED_RUNS_LIMIT} — 하나가 더 들어오면 가장 먼저 넣은 것이 빠진다`, () => {
  const all = Array.from({ length: SETTLED_RUNS_LIMIT + 1 }, (_, i) => run(i + 1, "done"));
  const { result, rerender } = setup(all.slice(0, SETTLED_RUNS_LIMIT));
  expect(result.current.ended.size).toBe(SETTLED_RUNS_LIMIT);
  expect(result.current.ended.has(all[0]!.id)).toBe(true);
  rerender({ live: all });
  expect(result.current.ended.size).toBe(SETTLED_RUNS_LIMIT);
  expect(result.current.ended.has(all[0]!.id)).toBe(false);
  expect(result.current.ended.has(all[SETTLED_RUNS_LIMIT]!.id)).toBe(true);
});

it("vanished 도 상한을 넘으면 첫째를 버리고 그 stopped 도 함께 지운다", () => {
  const all = Array.from({ length: SETTLED_RUNS_LIMIT + 1 }, (_, i) => run(i + 1));
  const { result, rerender } = setup(all.slice(0, SETTLED_RUNS_LIMIT));
  rerender({ live: [all[SETTLED_RUNS_LIMIT]!] });
  expect(result.current.vanished.size).toBe(SETTLED_RUNS_LIMIT);
  rerender({ live: [] });
  expect(result.current.vanished.size).toBe(SETTLED_RUNS_LIMIT);
  expect(result.current.vanished.has(all[0]!.id)).toBe(false);
  expect(result.current.stopped.has(all[0]!.id)).toBe(false);
  expect(result.current.stopped.size).toBe(SETTLED_RUNS_LIMIT);
});

it("빠졌다 돌아와 끝난 런을 ended 에서 201개 뒤로 밀면 seenVanished 에서도 빠진다 — 다음 빠짐 때 타임라인을 다시 받는다(짝 지우기)", () => {
  const { result, rerender, invalidate } = setup([run(1)]);
  // 1 이 종료를 못 본 채 빠진다 → vanished·stopped, 타임라인 무효화 1회
  rerender({ live: [] });
  expect(invalidate).toHaveBeenCalledTimes(1);
  // 돌아와 끝난다 → ended(stopped 는 실시간이라 빠진다), vanished 는 남는다
  rerender({ live: [run(1, "done")] });
  expect(result.current.ended.has(run(1).id)).toBe(true);
  expect(result.current.vanished.has(run(1).id)).toBe(true);
  // 끝난 런 상한만큼 더 들어오면 1 이 ended 에서 밀려난다
  const later = Array.from({ length: SETTLED_RUNS_LIMIT }, (_, i) => run(i + 2, "done"));
  rerender({ live: later });
  expect(result.current.ended.has(run(1).id)).toBe(false);
  // 같은 렌더에서 1 은 실시간에서도 빠져 다시 vanished·stopped 로 적힌다(ended 에서 밀린 뒤라 건너뛰지 않는다)
  expect(result.current.stopped.has(run(1).id)).toBe(true);
  // 새 런이 빠져 vanishedKey 가 바뀌면 — 1 은 seenVanished 에서 잊혔으니 한 번 더 무효화된다
  rerender({ live: [...later, run(500)] });
  rerender({ live: later });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.runEvents(run(500).id) });
  const forRun1 = invalidate.mock.calls.filter(
    ([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(qk.runEvents(run(1).id)),
  );
  expect(forRun1).toHaveLength(2);
});
