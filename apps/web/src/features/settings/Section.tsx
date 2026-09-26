import { type ReactNode, useId } from "react";

/** 관리 항목이 잠겼을 때의 안내(팀 스펙 6장 — member 는 값을 보되 바꾸지 못한다) */
export const LOCKED_NOTICE = "관리자만 바꿀 수 있습니다";

export function LockedNotice() {
  return <p className="text-xs text-muted-foreground">{LOCKED_NOTICE}</p>;
}

/** 설정 패널의 한 섹션 — 제목(h3)이 이름인 region. `locked` 면 제목 아래에 「관리자만 바꿀 수 있습니다」 */
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
      <h3 id={id} className="text-sm font-semibold">
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
