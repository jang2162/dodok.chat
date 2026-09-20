import { CheckIcon, LoaderIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { isTruncated, type ToolRow } from "./timeline";

/** 잘린 인자·결과에 붙는 한 줄(Gateway 가 380자 초과분을 잘라 준다 — 설계 5.2) */
export const TRUNCATED_NOTE = "잘렸습니다";

type Fold = "인자" | "결과";

/**
 * 툴 호출 한 행(설계 5.2). 인자·결과는 **접힘이 기본**이고 펼치면 `<pre>`.
 * 승인을 요구한 툴이면 「승인」 표시가 붙는다(Ruling 2 의 이음 — 열쇠는 승인 레코드의 `toolCallId`)
 */
export function ToolCallRow({ row, approved }: { row: ToolRow; approved?: boolean }) {
  const [open, setOpen] = useState<ReadonlySet<Fold>>(new Set());
  const toggle = (what: Fold) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(what)) next.add(what);
      return next;
    });
  const folds: Array<[Fold, string | undefined]> = [
    ["인자", row.args],
    ["결과", row.result],
  ];

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <div className="flex items-center gap-2">
        <StateIcon row={row} />
        <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
        {approved && (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
            승인
          </span>
        )}
        {row.durationMs !== undefined && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatDuration(row.durationMs)}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-muted-foreground">
        {folds.map(([what, text]) =>
          text === undefined ? null : (
            <span key={what} className="flex items-center gap-1">
              <button
                type="button"
                aria-expanded={open.has(what)}
                aria-label={`${row.name} ${what} ${open.has(what) ? "숨기기" : "보기"}`}
                onClick={() => toggle(what)}
                className={cn(
                  "rounded underline underline-offset-2 hover:text-foreground",
                  "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                )}
              >
                {what} {open.has(what) ? "숨기기" : "보기"}
              </button>
              {isTruncated(text) && <span>{TRUNCATED_NOTE}</span>}
            </span>
          ),
        )}
      </div>
      {folds.map(([what, text]) =>
        text === undefined || !open.has(what) ? null : (
          <pre
            key={what}
            className="ml-6 max-h-60 overflow-auto rounded bg-muted p-2 text-xs break-all whitespace-pre-wrap"
          >
            {text}
          </pre>
        ),
      )}
    </div>
  );
}

function StateIcon({ row }: { row: ToolRow }) {
  if (row.state === "running")
    return (
      <LoaderIcon
        role="img"
        aria-label="실행 중"
        className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
    );
  if (row.ok === false)
    return <XIcon role="img" aria-label="실패" className="size-3.5 shrink-0 text-destructive" />;
  return <CheckIcon role="img" aria-label="완료" className="size-3.5 shrink-0 text-muted-foreground" />;
}

/** 1초 미만은 ms, 그 위는 초 한 자리 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`;
}
