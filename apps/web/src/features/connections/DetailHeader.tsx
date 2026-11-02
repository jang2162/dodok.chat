import { type ReactNode, useEffect, useRef } from "react";
import { useConnections } from "./context";

/**
 * 상세 화면 넷(Gateway·러너·프로젝트·에이전트)과 연결 추가의 머리 — 제목(h1)·배지·동작 버튼, 그 아래 한 줄 메타.
 * 좁은 화면의 「← 연결」은 설정 셸의 머리가 「← 설정」 자리에 단다(뒤로 가기 단추가 둘이 되지 않게 — SettingsLayout `BackLink`).
 * 트리 줄을 눌러 왔으면 제목이 초점을 받는다 — 좁은 화면에서 트리가 사라져 초점이 body 로 떨어지지 않게
 */
export function DetailHeader({
  title,
  badge,
  actions,
  meta,
  headingRef,
}: {
  title: string;
  badge?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
}) {
  const { focusDetail } = useConnections();
  const own = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? own;
  useEffect(() => {
    if (!focusDetail.current) return;
    focusDetail.current = false;
    heading.current?.focus();
  }, [focusDetail, heading, title]);
  return (
    <header className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 ref={heading} tabIndex={-1} className="min-w-0 text-xl font-semibold break-all outline-none">
          {title}
        </h1>
        {badge}
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {meta && <div className="text-sm text-muted-foreground">{meta}</div>}
    </header>
  );
}
