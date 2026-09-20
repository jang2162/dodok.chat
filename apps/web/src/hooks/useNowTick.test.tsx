import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TICK_MS, useNowTick } from "./useNowTick";

beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
afterEach(() => vi.useRealTimers());

it("켜져 있으면 1초마다 지금을 새로 읽는다", () => {
  const { result } = renderHook(() => useNowTick(true));
  const first = result.current;

  act(() => void vi.advanceTimersByTime(TICK_MS));
  expect(result.current).toBe(first + TICK_MS);
  act(() => void vi.advanceTimersByTime(TICK_MS));
  expect(result.current).toBe(first + 2 * TICK_MS);
});

it("꺼져 있으면 타이머를 걸지 않는다 — 값도 그대로다", () => {
  const { result } = renderHook(() => useNowTick(false));
  const first = result.current;

  expect(vi.getTimerCount()).toBe(0);
  act(() => void vi.advanceTimersByTime(10 * TICK_MS));
  expect(result.current).toBe(first);
});

it("꺼지면 타이머를 거두고, 다시 켜지면 그동안 흐른 시간을 곧바로 메운다", () => {
  const { result, rerender } = renderHook(({ active }) => useNowTick(active), {
    initialProps: { active: true },
  });
  expect(vi.getTimerCount()).toBe(1);

  rerender({ active: false });
  expect(vi.getTimerCount()).toBe(0);
  const stopped = result.current;
  act(() => void vi.advanceTimersByTime(60 * TICK_MS));
  expect(result.current).toBe(stopped);

  act(() => void rerender({ active: true }));
  expect(result.current).toBe(stopped + 60 * TICK_MS);
  expect(vi.getTimerCount()).toBe(1);
});

it("내려가면 타이머를 거둔다", () => {
  const { unmount } = renderHook(() => useNowTick(true));
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
