import { useEffect, useState } from "react";

/** 이미 지난 승인의 남은 시간 문구 */
export const EXPIRED_LABEL = "만료됨";
/** 카운트다운 간격(설계 5.3) */
export const TICK_MS = 1_000;

/** 남은 밀리초. 음수면 이미 지났다 */
export function remainingMs(expiresAt: string, now: number): number {
  return Date.parse(expiresAt) - now;
}

/**
 * 남은 시간 문구 — 「1분 58초」·「12초」·「만료됨」. 1분이 넘으면 분·초를 함께 보인다(TTL 은 최대 600초라 시는 없다).
 * 만료 시각을 읽을 수 없으면(형식 오류) 만료로 보지 않고 빈 문구를 돌려준다 — 카드가 카운트다운만 감춘다
 */
export function remainingLabel(expiresAt: string, now: number): string {
  const ms = remainingMs(expiresAt, now);
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return EXPIRED_LABEL;
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}분 ${total % 60}초` : `${total}초`;
}

/**
 * 1초마다 다시 세는 남은 시간(설계 5.3·5.5). 클라이언트 시계는 **표시용**이다 — 0 이 되면 「만료됨」으로 보이지만
 * 카드가 사라지지는 않고, 서버 사실(`approval.resolved`)이 오면 그쪽이 이긴다.
 * `active` 가 거짓이면(확정된 카드) 타이머를 걸지 않는다
 */
export function useRemaining(expiresAt: string, active: boolean): { label: string; expired: boolean } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    // 다 센 뒤에는 멈춘다 — 서버가 만료 사실을 보낼 때까지 1초마다 헛되이 다시 그리지 않게
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (remainingMs(expiresAt, at) <= 0) clearInterval(timer);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [active, expiresAt]);
  const label = remainingLabel(expiresAt, now);
  return { label, expired: label === EXPIRED_LABEL };
}
