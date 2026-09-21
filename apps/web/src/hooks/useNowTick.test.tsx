import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TICK_MS, resetNowTick, useNowTick } from "./useNowTick";

// 구독자가 떠 있는 채로 가짜 시계로 바꾸지 마라 — 공용 시계는 첫 구독 때의 시계에 묶여, 뒤에 붙은 쪽도 그 시계를 탄다
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

/**
 * 멈춘 시계의 마지막 틱 값은 낡았다 — 구독자가 다 떠난 뒤 처음 붙는 쪽이 그 값을 그리면 한 프레임 과거가 보인다
 * (앱에서 처음 뜨는 카운트다운이면 `ticked = 0` 기준 「2900만 분」). 멈춰 있으면 새로 읽는다
 */
it("멈춰 있던 시계에 처음 붙는 쪽은 첫 그림부터 지금을 본다 — 마지막 틱의 낡은 값이 아니다", () => {
  const earlier = renderHook(() => useNowTick(true));
  act(() => void vi.advanceTimersByTime(3 * TICK_MS));
  earlier.unmount();
  expect(vi.getTimerCount()).toBe(0);
  act(() => void vi.advanceTimersByTime(60 * TICK_MS));

  const drawn: number[] = [];
  renderHook(() => {
    const now = useNowTick(true);
    drawn.push(now);
    return now;
  });
  expect(drawn[0]).toBe(Date.now());
  expect(drawn.every((now) => now === Date.now())).toBe(true);
});

it("내려가면 타이머를 거둔다", () => {
  const { unmount } = renderHook(() => useNowTick(true));
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

/**
 * 브라우저 검증 D6 — 같은 승인의 카드 둘이 저마다 `setInterval` 을 돌려 한쪽이 ~150ms 늦게 틱했고, 그 틈에 두 카드의
 * 남은 초가 1초 어긋났다. 시계는 **하나**다 — 구독자가 몇이든 타이머는 하나이고 모두 같은 틱에 같은 값을 받는다
 */
it("구독자가 여럿이어도 타이머는 하나이고, 늦게 붙은 쪽도 지금 도는 시계의 값을 본다(D6)", () => {
  const a = renderHook(() => useNowTick(true));
  act(() => void vi.advanceTimersByTime(600));
  // 그린 값을 모두 적는다 — 효과가 곧바로 공용 값으로 덮어도, 첫 그림이 제 시각이면 브라우저에서는 한 프레임 거꾸로 튄다
  const drawn: number[] = [];
  const b = renderHook(() => {
    const now = useNowTick(true);
    drawn.push(now);
    return now;
  });
  const c = renderHook(() => useNowTick(true));

  expect(vi.getTimerCount()).toBe(1);
  // 늦게 붙어도 제 시각(600ms 뒤)을 따로 읽지 않는다 — 첫 그림부터 앞선 구독자와 같은 틱의 값이다
  expect(drawn.every((now) => now === a.result.current)).toBe(true);
  expect(b.result.current).toBe(a.result.current);
  expect(c.result.current).toBe(a.result.current);

  // 따로 돌았다면 b·c 는 1600ms 에 틱했을 것이다 — 하나이므로 1000ms 에 함께 넘어간다
  act(() => void vi.advanceTimersByTime(400));
  expect(b.result.current).toBe(a.result.current);
  expect(c.result.current).toBe(a.result.current);
  act(() => void vi.advanceTimersByTime(700));
  expect(b.result.current).toBe(a.result.current);
});

it("하나가 꺼져도 남은 구독자의 시계는 흐르고, 마지막이 떠나야 타이머를 거둔다", () => {
  const a = renderHook(({ active }) => useNowTick(active), { initialProps: { active: true } });
  const b = renderHook(() => useNowTick(true));
  expect(vi.getTimerCount()).toBe(1);

  a.rerender({ active: false });
  const stopped = a.result.current;
  const before = b.result.current;
  expect(vi.getTimerCount()).toBe(1);
  act(() => void vi.advanceTimersByTime(3 * TICK_MS));
  expect(b.result.current).toBe(before + 3 * TICK_MS);
  // 꺼진 쪽은 멈춘 값 그대로다 — 남이 틱해도 따라 흐르지 않는다
  expect(a.result.current).toBe(stopped);

  b.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

/**
 * `test/setup.ts` 가 테스트마다 부르는 초기화 — 둘 중 하나라도 남으면 다음 테스트가 샌다. 타이머 id 가 남으면 새 구독자가
 * 시계를 못 걸고, 구독자가 남으면 새 시계의 틱을 받아 가고 마지막 구독자가 떠나도 타이머가 거둬지지 않는다
 */
it("resetNowTick 은 남은 구독자와 타이머를 모두 거둔다 — 다음 구독자가 새 시계를 걸고, 내려가면 다시 거둔다", () => {
  const left = renderHook(() => useNowTick(true)); // 내리지 않는다 — RTL 밖에 남은 구독자 대역
  resetNowTick();
  expect(vi.getTimerCount()).toBe(0);
  const stale = left.result.current;

  const next = renderHook(() => useNowTick(true));
  expect(vi.getTimerCount()).toBe(1);
  act(() => void vi.advanceTimersByTime(TICK_MS));
  expect(next.result.current).toBe(Date.now());
  // 구독자 집합도 비었다 — 남은 쪽은 새 시계의 틱을 받지 않는다
  expect(left.result.current).toBe(stale);

  next.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
