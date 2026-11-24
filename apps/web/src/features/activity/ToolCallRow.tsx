import { CheckIcon, ChevronRightIcon, LoaderIcon, XIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "@/lib/utils";
import { isTruncated, type ToolRow } from "./timeline";

/** 잘린 인자·결과에 붙는 한 줄(Gateway 가 380자 초과분을 잘라 준다 — 설계 5.2) */
export const TRUNCATED_NOTE = "잘렸습니다";

/**
 * 줄 앞의 상태 원 — 활동 탭 타임라인의 세로 선이 이 원들을 잇는다(재설계 스펙 목표 7). 바탕을 칠해 선이 원 뒤로 지나가게 한다.
 * 응답 안의 활동도 같은 줄을 쓴다(선은 없다)
 */
export function RowMarker({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "relative z-10 flex size-5 shrink-0 items-center justify-center rounded-full border bg-background",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * 인자 한 줄 요약 — JSON 객체면 `키=값` 을 띄어 잇고(문자열 값은 따옴표 없이), 아니면 공백을 접은 원문.
 * 줄에서는 고정폭으로 잘라 보인다 — 전체는 펼친 `<pre>` 에 있다
 */
export function toolArgsSummary(args: string | undefined): string | undefined {
  if (args === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts = Object.entries(parsed).map(
        ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
      );
      if (parts.length > 0) return parts.join(" ").replace(/\s+/g, " ");
    }
  } catch {
    // 아직 흐르는 인자(조각)나 JSON 이 아닌 인자 — 원문을 한 줄로
  }
  const flat = args.replace(/\s+/g, " ").trim();
  return flat === "" ? undefined : flat;
}

/**
 * 툴 호출 한 행(설계 5.2·재설계 스펙 목표 7): 상태 원 · 도구 이름 · 인자 한 줄 요약(고정폭) · 소요. **줄 전체가 펼침 단추**이고
 * 펼치면 인자·결과가 `<pre>` 로 보인다(접힘이 기본). 인자도 결과도 없으면 펼칠 것이 없어 단추가 아니다.
 * 승인을 요구한 툴이면 「승인」 표시가 붙는다(Ruling 2 의 이음 — 열쇠는 승인 레코드의 `toolCallId`).
 * 상태 원은 단추 밖이다 — 단추의 이름(「<도구> 자세히」)이 자식 그림을 덮어 상태가 안 읽히지 않게
 */
export function ToolCallRow({ row, approved }: { row: ToolRow; approved?: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const chipId = useId();
  const summary = toolArgsSummary(row.args);
  const truncated = isTruncated(row.args) || isTruncated(row.result);
  const foldable = row.args !== undefined || row.result !== undefined;

  const line = (
    <>
      <span className="shrink-0 font-medium">{row.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{summary}</span>
      {truncated && <span className="shrink-0 text-[11px] text-muted-foreground">{TRUNCATED_NOTE}</span>}
      {approved && (
        <span
          id={chipId}
          className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          승인
        </span>
      )}
      {row.durationMs !== undefined && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatDuration(row.durationMs)}
        </span>
      )}
    </>
  );

  return (
    <div data-slot="tool-row" className="flex flex-col gap-1 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <RowMarker>
          <StateIcon row={row} />
        </RowMarker>
        {foldable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={`${row.name} 자세히`}
            aria-describedby={approved ? chipId : undefined}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
            )}
          >
            {line}
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5">{line}</div>
        )}
      </div>
      {open && (
        <div id={bodyId} className="ml-7 flex flex-col gap-1">
          {(
            [
              ["인자", row.args],
              ["결과", row.result],
            ] as const
          ).map(([what, text]) =>
            text === undefined ? null : (
              <div key={what} className="flex flex-col gap-0.5">
                <span className="text-[11px] text-muted-foreground">{what}</span>
                <pre className="max-h-60 overflow-auto rounded bg-muted p-2 text-xs break-all whitespace-pre-wrap">
                  {text}
                </pre>
              </div>
            ),
          )}
        </div>
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
        className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
    );
  if (row.ok === false)
    return <XIcon role="img" aria-label="실패" className="size-3 shrink-0 text-destructive" />;
  return <CheckIcon role="img" aria-label="완료" className="size-3 shrink-0 text-success" />;
}

/** 1초 미만은 ms, 그 위는 초 한 자리 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`;
}
