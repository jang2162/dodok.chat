import { Link } from "@tanstack/react-router";
import { useIsNarrow } from "@/hooks/useIsNarrow";

/**
 * 없는 id·지워진 연결의 상세 주소(연결 탭 통합 계획 Review Focus 2) — 빈 화면·예외 대신 한 줄과 「← 연결」. 좁은 화면은 셸 머리가
 * 이미 「← 연결」을 달았으므로 여기서는 넓은 화면에만 단다
 */
export function NotFoundDetail({ message = "이 연결을 찾을 수 없습니다" }: { message?: string }) {
  const narrow = useIsNarrow();
  return (
    <div data-testid="connection-not-found" className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">{message}</p>
      {!narrow && (
        <Link to="/settings/connection" className="text-sm underline underline-offset-4">
          <span aria-hidden>←</span> 연결
        </Link>
      )}
    </div>
  );
}

/** 받기 전·받기 실패 — 상세가 기댈 목록이 아직 없다 */
export function DetailPending({ failed, retry }: { failed: boolean; retry: () => void }) {
  if (!failed)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">불러오지 못했습니다</p>
      <button type="button" className="text-sm underline underline-offset-4" onClick={retry}>
        다시 시도
      </button>
    </div>
  );
}
