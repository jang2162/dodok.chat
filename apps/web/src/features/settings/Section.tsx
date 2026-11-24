import { type ReactNode, useId } from "react";

/** 관리 항목이 잠겼을 때의 안내(팀 스펙 6장 — member 는 값을 보되 바꾸지 못한다) */
export const LOCKED_NOTICE = "관리자만 바꿀 수 있습니다";

export function LockedNotice() {
  return <p className="text-xs text-muted-foreground">{LOCKED_NOTICE}</p>;
}

/** 저장 막대에 든 칸이 서버 값과 다를 때(`data-dirty`)의 강조 테두리 — 강조색은 선택·포커스와 같은 자리에만 쓴다(패널 재설계 스펙) */
export const DIRTY_FIELD = "data-dirty:border-primary";

/**
 * 설정 패널의 한 섹션 — 제목(h3)이 이름인 region. 제목은 작은 회색 글(패널 재설계 스펙 목표 6), 섹션 사이 선은 부르는 쪽(`divide-y`).
 * `locked` 면 제목 아래에 「관리자만 바꿀 수 있습니다」
 */
export function Section({
  title,
  locked = false,
  children,
}: {
  title: string;
  locked?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 px-4 py-5">
      <h3 id={id} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {locked && <LockedNotice />}
      {children}
    </section>
  );
}

/** 저장 성공 안내 — 다음에 고치기 시작하면 부르는 쪽이 내린다 */
export function Saved({ children = "저장했습니다" }: { children?: ReactNode }) {
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {children}
    </p>
  );
}
