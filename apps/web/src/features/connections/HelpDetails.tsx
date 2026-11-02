import { CircleHelpIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * 「?」 펼침(연결 탭 통합 스펙 3.4) — 한 줄을 넘는 사정을 그 자리에 접어 둔다. 누르면 그 자리에 펼쳐진다. 접근성 이름은
 * 묶음이 「<섹션> 도움말」, 펼치는 단추가 「<섹션> 도움말 펼치기」. 위험 경고는 여기에 넣지 않는다 — 늘 보여야 한다
 */
export function HelpDetails({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details
      aria-label={`${label} 도움말`}
      className="group text-sm text-muted-foreground"
      open={defaultOpen || undefined}
    >
      <summary
        aria-label={`${label} 도움말 펼치기`}
        className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
      >
        <CircleHelpIcon aria-hidden className="size-3.5" />
        <span aria-hidden>?</span>
      </summary>
      <div className="mt-2 flex flex-col gap-1.5 rounded-md border bg-muted/40 p-3">{children}</div>
    </details>
  );
}
