import type { ReactNode } from "react";
import { Button } from "@/ui/button";

/**
 * 패널 안 상태 문구(설계 6장). 조회 실패는 **패널 안에서만** 알린다 — 쿼리가 `meta.silent` 라
 * 전역 토스트와 이중으로 뜨지 않는다
 */
export function Notice({
  children,
  onRetry,
  retrying,
}: {
  children: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div role="status" className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
      <p>{children}</p>
      {onRetry && (
        <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
          다시 시도
        </Button>
      )}
    </div>
  );
}
