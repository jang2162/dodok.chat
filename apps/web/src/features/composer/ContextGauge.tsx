import type { RunnerContextBreakdown } from "@dodok/shared";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/tooltip";

/** 창 밖(불러올 때만 창에 드는) 줄의 머리 — deferred 도구 스키마 */
export const DEFERRED_HEADING = "불러올 때만";
export const OVER_WINDOW = "창 초과";

/** 토큰 수 — 248.5k·800k·1.2M·1M. 1,000 아래는 그대로 */
export function formatTokens(n: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(n);
}

const R = 6;
const C = 2 * Math.PI * R;

/** 게이지 주의 구간의 시작 — 알약 순서(70% 이상이 앞, 작성기 도구 줄 스펙 T4)도 이 값을 쓴다 */
export const CONTEXT_WARN_PERCENT = 70;
/** 게이지 경고 구간의 시작 */
export const CONTEXT_DANGER_PERCENT = 90;

/** 게이지 색 구간 — 주의(70%)·경고(90%) */
const tone = (percent: number) =>
  percent >= CONTEXT_DANGER_PERCENT
    ? "text-destructive"
    : percent >= CONTEXT_WARN_PERCENT
      ? "text-amber-600"
      : "text-primary";

/** 게이지의 원(지름 16px, 색 구간 포함)만 — 알약 안에서는 세부 팝오버 없이 이것만 쓴다(작성기 도구 줄 스펙 5.3) */
export function GaugeRing({ percent, className }: { percent: number | null; className?: string }) {
  const filled = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("size-4 shrink-0 -rotate-90", tone(filled), className)}
      aria-hidden
    >
      <circle cx="8" cy="8" r={R} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      {percent !== null && (
        <circle
          cx="8"
          cy="8"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeDasharray={`${(C * filled) / 100} ${C}`}
        />
      )}
    </svg>
  );
}

/**
 * 컨텍스트 게이지(작성기 칩 스펙 5.4) — 원(지름 16px)과 퍼센트, 실행이 없으면 「—」. 호버·키보드 초점에 세부: `사용/창` 토큰,
 * 창 안 줄(used·free·buffer)은 창 비율, 창 밖(deferred)은 「불러올 때만」 아래 토큰 수, 0 토큰 줄은 숨김. 세부가 없으면(옛 러너)
 * 퍼센트 한 줄. 옛 러너 런은 서버가 항목 없는 세부(그 런의 사용·창)를 채워 `사용/창` 한 줄만(C4). 퍼센트는 서버가 세부의
 * percentage 로 낸 값이라 팝오버의 합계와 같은 수다. `label` 이면 보이는 글 앞에 「컨텍스트」(러너 에이전트 1명일 때 — 작성기 도구 줄 스펙 T2)
 */
export function ContextGauge({
  percent,
  context,
  label = false,
}: {
  percent: number | null;
  context: RunnerContextBreakdown | null;
  label?: boolean;
}) {
  const shown = percent === null ? "—" : `${percent}%`;
  const inWindow = context?.categories.filter((c) => c.kind !== "deferred" && c.tokens > 0) ?? [];
  const deferred = context?.categories.filter((c) => c.kind === "deferred" && c.tokens > 0) ?? [];
  const share = (tokens: number) => `${((tokens / (context?.maxTokens ?? 1)) * 100).toFixed(1)}%`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label={`컨텍스트 ${shown}`}
          >
            <GaugeRing percent={percent} />
            {label && (
              <>
                <span className="text-muted-foreground">컨텍스트</span>{" "}
              </>
            )}
            <span className="tabular-nums">{shown}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="end"
          className="min-w-52 border bg-popover px-3 py-2 text-popover-foreground shadow-md [&>span>svg]:hidden!"
        >
          {context === null ? (
            <p>컨텍스트 {shown}</p>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="font-medium tabular-nums">
                {formatTokens(context.totalTokens)} / {formatTokens(context.maxTokens)}
              </p>
              {context.percentage > 100 && <p className="text-destructive">{OVER_WINDOW}</p>}
              {inWindow.length > 0 && (
                <ul className="flex flex-col">
                  {inWindow.map((c, i) => (
                    <li key={`${c.kind}:${i}`} className="flex justify-between gap-4 tabular-nums">
                      <span>{c.name}</span>
                      <span>{share(c.tokens)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {deferred.length > 0 && (
                <>
                  <p className="mt-1 border-t pt-1 text-muted-foreground">{DEFERRED_HEADING}</p>
                  <ul className="flex flex-col" aria-label={DEFERRED_HEADING}>
                    {deferred.map((c, i) => (
                      <li key={`${c.kind}:${i}`} className="flex justify-between gap-4 tabular-nums">
                        <span>{c.name}</span>
                        <span>{formatTokens(c.tokens)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
