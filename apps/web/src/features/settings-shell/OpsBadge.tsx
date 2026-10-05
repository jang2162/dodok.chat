import { useOpsStatus } from "@/features/ops/queries";

/** 배지에 그리는 수 — 그 위는 「99+」 */
const BADGE_MAX = 99;

/**
 * 확인 안 한 warn·error 수 배지(운영 보강 스펙 7장) — 사이드바 「설정」과 「운영」 탭이 단다. admin 이상인 자리에서만 그린다 —
 * 그래서 member 는 ops/status 를 부르지 않는다. 수는 상태 캐시의 `unacked` 이고 실시간 `ops.event` 가 그 칸을 덮는다(realtime/handlers).
 * 링크 안에 넣는다 — 숨긴 글이 링크 이름에 수를 싣는다
 */
export function OpsBadge() {
  const unacked = useOpsStatus().data?.unacked;
  const n = unacked ? unacked.warn + unacked.error : 0;
  if (n === 0) return null;
  return (
    <>
      <span
        data-ops-badge
        aria-hidden
        className="ml-auto rounded-full bg-destructive px-1.5 text-xs leading-5 font-medium text-white tabular-nums"
      >
        {n > BADGE_MAX ? `${BADGE_MAX}+` : n}
      </span>
      <span className="sr-only"> (확인 안 한 사건 {n}건)</span>
    </>
  );
}
