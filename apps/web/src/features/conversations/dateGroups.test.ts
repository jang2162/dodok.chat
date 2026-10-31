import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dateGroupOf, msUntilNextDay, useToday } from "./dateGroups";

afterEach(() => {
  vi.useRealTimers();
});

describe("msUntilNextDay", () => {
  it("다음 자정(브라우저 시간대)까지 남은 ms", () => {
    expect(msUntilNextDay(new Date(2026, 9, 31, 23, 59, 0))).toBe(60_000);
    expect(msUntilNextDay(new Date(2026, 9, 31, 0, 0, 0))).toBe(86_400_000);
  });
});

describe("useToday", () => {
  it("자정을 넘기면 다시 그린다 — 「오늘」이던 세션이 「어제」로", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 31, 23, 59, 0) });
    const lastMessageAt = new Date(2026, 9, 31, 12, 0, 0).toISOString();
    const { result } = renderHook(() => useToday());
    expect(dateGroupOf(lastMessageAt, result.current)).toBe("today");

    act(() => vi.advanceTimersByTime(59_999));
    expect(dateGroupOf(lastMessageAt, result.current)).toBe("today");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.getDate()).toBe(1);
    expect(dateGroupOf(lastMessageAt, result.current)).toBe("yesterday");

    // 다음 자정에도 한 번 더 — 타이머는 늘 하나
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(86_400_000));
    expect(dateGroupOf(lastMessageAt, result.current)).toBe("week");
  });
});
