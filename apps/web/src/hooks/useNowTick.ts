import { useEffect, useState } from "react";

/** 흐르는 값을 다시 그리는 간격 — 초 단위로 보이는 값이라 1초면 충분하다 */
export const TICK_MS = 1_000;

/**
 * 앱 전체가 함께 쓰는 시계 **하나**(브라우저 검증 D6). 구독자마다 `setInterval` 을 따로 돌리면 같은 승인의 카드 둘이
 * 서로 다른 틱에 넘어가 남은 초가 1초 어긋났다 — 구독자가 몇이든 타이머는 하나이고 모두 같은 틱에 같은 값을 받는다.
 * 구독자가 있을 때만 돈다: 마지막이 떠나면 거둔다
 */
const listeners = new Set<(now: number) => void>();
let ticked = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  ticked = Date.now();
  for (const listener of listeners) listener(ticked);
}

/** 지금 도는 시계의 값 — 늦게 붙은 쪽이 제 시각을 따로 읽으면 다음 틱까지 앞선 구독자와 어긋난다. 멈춰 있으면 새로 읽는다 */
const readNow = () => (timer === undefined ? Date.now() : ticked);

function subscribe(listener: (now: number) => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    ticked = Date.now();
    timer = setInterval(tick, TICK_MS);
  }
  listener(ticked);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearInterval(timer);
    timer = undefined;
  };
}

/**
 * 테스트에서 처음 상태로 — 내리지 않고 남긴 구독자가 다음 테스트의 시계를 쥐지 않게(`test/setup.ts`).
 * 버려진 가짜 시계의 타이머 id 가 남으면 뒤 구독자가 새 타이머를 못 걸어 그 파일의 뒤 테스트가 줄줄이 무너진다
 */
export const resetNowTick = (): void => {
  listeners.clear();
  clearInterval(timer);
  timer = undefined;
};

/**
 * 「지금」을 1초마다 새로 읽는 시계. `active` 가 거짓이면 구독하지 않는다 —
 * 흐르는 값이 하나도 없으면 다시 그릴 까닭도 없다(값은 마지막으로 읽은 시각 그대로).
 * 다시 켜질 때 한 번 읽는다 — 멈춰 있던 동안 흐른 시간이 남아 있으면 처음 한 칸이 엉뚱해진다.
 * 그 읽기는 켜지는 **렌더 안에서** 한다: 효과(구독)에 맡기면 효과가 새 값을 넣기 전 한 프레임 동안 옛 시각을 그린다
 */
export function useNowTick(active: boolean): number {
  const [now, setNow] = useState(readNow);
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setNow(readNow());
  }
  useEffect(() => (active ? subscribe(setNow) : undefined), [active]);
  return now;
}
