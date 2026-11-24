import type { RunnerProgram } from "@dodok/shared";
import { cn } from "@/lib/utils";
import { PROGRAM_META } from "./programMeta";

/** tone → 에이전트 색 토큰(theme/tokens.css). 바탕·테두리는 그 토큰을 옅게, 글자는 본문색 — 작은 글자 대비 때문 */
const TONE_CLASS = {
  clay: "border-agent-1/40 bg-agent-1/15",
  blue: "border-agent-6/40 bg-agent-6/15",
  violet: "border-agent-7/40 bg-agent-7/15",
} as const;

/** 러너 프로그램 배지 — 글자 둘(CC·CX·OC) + 옅은 바탕. 접근 이름·title 은 프로그램 이름 */
export function ProgramBadge({
  program,
  size = "sm",
  className,
}: {
  program: RunnerProgram;
  size?: "sm" | "md";
  className?: string;
}) {
  const meta = PROGRAM_META[program];
  return (
    <span
      role="img"
      aria-label={meta.name}
      title={meta.name}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded border font-mono font-semibold text-foreground",
        size === "sm" ? "h-4 min-w-5 px-0.5 text-[10px]" : "h-6 min-w-7 px-1 text-xs",
        TONE_CLASS[meta.tone],
        className,
      )}
    >
      {meta.short}
    </span>
  );
}
