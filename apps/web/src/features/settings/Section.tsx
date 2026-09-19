import { type ReactNode, useId } from "react";

/** 설정 패널의 한 섹션 — 제목(h3)이 이름인 region */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 px-4 py-5">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
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
