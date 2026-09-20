import { useEffect, useState } from "react";

/** 흐르는 값을 다시 그리는 간격 — 초 단위로 보이는 값이라 1초면 충분하다 */
export const TICK_MS = 1_000;

/**
 * 「지금」을 1초마다 새로 읽는 시계. `active` 가 거짓이면 타이머를 걸지 않는다 —
 * 흐르는 값이 하나도 없으면 다시 그릴 까닭도 없다(값은 마지막으로 읽은 시각 그대로).
 * 다시 켜질 때 한 번 읽는다 — 멈춰 있던 동안 흐른 시간이 남아 있으면 처음 한 칸이 엉뚱해진다
 */
export function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
