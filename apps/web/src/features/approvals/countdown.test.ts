import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { iso } from "../../../test/fixtures";
import { remainingLabel, remainingMs, useRemaining } from "./countdown";

const NOW = Date.parse("2027-01-15T08:00:00.000Z");
const at = (ms: number) => iso(NOW + ms);

describe("remainingLabel", () => {
  it.each([
    [600_000, "10분 0초"],
    [120_000, "2분 0초"],
    [118_000, "1분 58초"],
    [60_000, "1분 0초"],
    [59_999, "59초"],
    [12_000, "12초"],
    [999, "0초"],
    [0, "만료됨"],
    [-5_000, "만료됨"],
  ])("남은 시간 %i ms → %s", (ms, label) => {
    expect(remainingLabel(at(ms), NOW)).toBe(label);
  });

  it("읽을 수 없는 만료 시각은 만료로 보지 않는다 — 카운트다운만 감춘다", () => {
    expect(remainingLabel("", NOW)).toBe("");
    expect(remainingLabel("어제", NOW)).toBe("");
  });
});

describe("remainingMs", () => {
  it("남은 밀리초를 그대로 — 지났으면 음수", () => {
    expect(remainingMs(at(3_000), NOW)).toBe(3_000);
    expect(remainingMs(at(-3_000), NOW)).toBe(-3_000);
  });
});

/**
 * 브라우저 검증 D6 — 같은 승인의 카드 둘(메시지 흐름·활동 탭)이 저마다 `setInterval` 을 돌려 패널 쪽이 늦게 틱했고,
 * 그 틈에 남은 초가 1초 어긋났다. 카드는 공용 틱(`useNowTick`) 하나를 본다.
 * 타이머 수는 여기(훅 단위)에서 센다 — 카드 테스트에는 react-query 타이머가 섞인다
 */
describe("useRemaining", () => {
  afterEach(() => vi.useRealTimers());

  it("늦게 뜬 카드도 먼저 뜬 카드와 같은 초를 보인다(D6)", () => {
    vi.useFakeTimers({ now: NOW });
    const expiresAt = at(10_500);
    const flow = renderHook(() => useRemaining(expiresAt, true));
    // 패널 카드는 600ms 뒤에 뜬다 — 제 시각으로 따로 세면 「9초」, 흐름 카드는 아직 「10초」
    act(() => void vi.advanceTimersByTime(600));
    const panel = renderHook(() => useRemaining(expiresAt, true));
    expect(flow.result.current.label).toBe("10초");
    expect(panel.result.current.label).toBe(flow.result.current.label);

    // 틱마다 둘이 함께 넘어간다 — 따로 돌면 패널 쪽이 600ms 늦게 넘어가 1초 어긋난다
    for (const step of [400, 300, 700, 300]) {
      act(() => void vi.advanceTimersByTime(step));
      expect(panel.result.current.label).toBe(flow.result.current.label);
    }
    expect(flow.result.current.label).toBe("8초");
  });

  it("카드가 여럿이어도 1초 타이머는 하나다(D6)", () => {
    vi.useFakeTimers({ now: NOW });
    renderHook(() => useRemaining(at(60_000), true));
    renderHook(() => useRemaining(at(60_000), true));
    renderHook(() => useRemaining(at(120_000), true));
    expect(vi.getTimerCount()).toBe(1);
  });

  it("확정된 카드(active 거짓)는 틱을 걸지 않고, 확정되면 거둔다", () => {
    vi.useFakeTimers({ now: NOW });
    renderHook(() => useRemaining(at(60_000), false));
    expect(vi.getTimerCount()).toBe(0);

    const card = renderHook(({ active }) => useRemaining(at(60_000), active), {
      initialProps: { active: true },
    });
    expect(vi.getTimerCount()).toBe(1);
    card.rerender({ active: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("다 세면 틱이 멈춘다 — 만료 표시는 그대로 남는다", () => {
    vi.useFakeTimers({ now: NOW });
    const card = renderHook(() => useRemaining(at(2_000), true));
    expect(vi.getTimerCount()).toBe(1);

    act(() => void vi.advanceTimersByTime(2_000));
    expect(card.result.current).toEqual({ label: "만료됨", expired: true });
    expect(vi.getTimerCount()).toBe(0);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(card.result.current).toEqual({ label: "만료됨", expired: true });
  });

  it("한 카드가 다 세도 아직 세는 카드의 틱은 이어진다", () => {
    vi.useFakeTimers({ now: NOW });
    const short = renderHook(() => useRemaining(at(1_000), true));
    const long = renderHook(() => useRemaining(at(5_000), true));

    act(() => void vi.advanceTimersByTime(1_000));
    expect(short.result.current.expired).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(long.result.current.label).toBe("3초");
  });
});
