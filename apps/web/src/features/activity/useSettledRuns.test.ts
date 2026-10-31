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
