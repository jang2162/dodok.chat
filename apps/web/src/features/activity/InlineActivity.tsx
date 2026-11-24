import { BrainIcon, ChevronRightIcon, LoaderIcon } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  type ActivityRow,
  type ActivitySummary,
  type ReasoningRow,
  activitySummaryLabel,
  approvalOutcomeLabel,
  summarizeActivity,
  toActivityRows,
} from "./timeline";
import { ToolCallRow } from "./ToolCallRow";
import { useRunActivity } from "./useRunActivity";

/** 잘린 추론 덩이 아래 한 줄(서버 상한 — 스펙 「데이터」) */
export const REASONING_TRUNCATED_NOTE = "추론이 길어 일부만 남겼습니다";

/**
 * 응답 안의 활동(스펙 「모양」) — 요약 줄 단추와 펼친 줄들. 버블(진행 중)과 확정 메시지가 같이 쓴다.
 * `rows` 가 undefined 면 아직 모른다(확정 메시지가 펼치기 전) — 요약은 「활동」만 적는다.
 * `notice` 는 행 대신 펼친 자리에 둘 것(불러오는 중·실패·기록 없음). 행도 notice 도 없으면 아무것도 그리지 않는다 —
 * 바로 답한 런에는 요약 줄이 없다.
 * 펼침은 `open` 을 주면 부르는 쪽이 쥐고(버블: 답 글이 오면 접힘), 안 주면 스스로 쥔다(`defaultOpen`)
 */
export function InlineActivity({
  rows,
  summary,
  live = false,
  open: controlled,
  defaultOpen = false,
  onOpenChange,
  notice,
}: {
  rows: readonly ActivityRow[] | undefined;
  summary: ActivitySummary | undefined;
  /** 런이 아직 도는가 — 요약 줄에 진행 표시 */
  live?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  notice?: ReactNode;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  const bodyId = useId();
  const approvedTools = useMemo(() => {
    const ids = new Set<string>();
    for (const row of rows ?? []) if (row.kind === "approval" && row.toolCallId) ids.add(row.toolCallId);
    return ids;
  }, [rows]);

  if (notice === undefined && (rows === undefined || rows.length === 0)) return null;
  const toggle = () => {
    setOwn(!open);
    onOpenChange?.(!open);
  };

  return (
    <div data-slot="inline-activity" className="my-1 text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
        className={cn(
          "inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground",
          "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        <span>{activitySummaryLabel(summary)}</span>
        {live && (
          <LoaderIcon aria-hidden className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
        )}
      </button>
      {open && (
        <div id={bodyId} className="mt-1 ml-1.5 border-l border-dashed pl-2">
          {notice ?? (
            <ol aria-label="응답 활동" className="flex flex-col">
              {rows?.map((row) => (
                <li key={row.key}>
                  <InlineRow row={row} approved={row.kind === "tool" && approvedTools.has(row.toolCallId)} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/** 펼친 줄 하나. 도구는 활동 탭의 행을 그대로 쓰고, 나머지는 한 줄로 */
function InlineRow({ row, approved }: { row: ActivityRow; approved: boolean }) {
  switch (row.kind) {
    case "reasoning":
      return <ReasoningLine row={row} />;
    case "tool":
      return <ToolCallRow row={row} approved={approved} />;
    case "approval":
      return (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          {row.title} · {approvalOutcomeLabel(row) ?? "대기 중"}
        </p>
      );
    case "step":
      return <p className="px-3 py-1 text-xs text-muted-foreground">{row.name}</p>;
    case "subagent":
      return (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          서브에이전트{row.label ? ` · ${row.label}` : ""}
          {row.state === "error" ? ` · ${row.message ?? "실패"}` : ""}
        </p>
      );
    case "error":
      return <p className="px-3 py-1 text-xs break-words text-destructive">{row.message}</p>;
  }
}

/**
 * 추론 한 덩이 — 흐린 글, 마크다운 해석 없이 그대로(줄바꿈만 살린다). 글이 없으면(START/END 만 온 모델) 「생각 중…」.
 * 긴 추론이 버블을 밀어내지 않게 높이를 묶고 안에서 스크롤한다. 활동 탭 타임라인도 이것을 쓴다
 */
export function ReasoningLine({ row }: { row: ReasoningRow }) {
  return (
    <div data-slot="reasoning-row" className="flex gap-2 px-3 py-1.5 text-muted-foreground">
      <BrainIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="max-h-48 overflow-y-auto text-xs break-words whitespace-pre-wrap italic">
          {row.text === "" ? (row.state === "running" ? "생각 중…" : "추론 내용이 없습니다.") : row.text}
        </p>
        {row.truncated && <p className="mt-1 text-[11px]">{REASONING_TRUNCATED_NOTE}</p>}
      </div>
    </div>
  );
}

/**
 * 확정된 에이전트 메시지의 활동(스펙 「모양」). 처음에는 요약 줄 「활동」만 — 펼칠 때 받는다(`useRunActivity`).
 * 그 탭이 처음부터 본 런이면 호출 없이 수가 바로 보이고, 활동이 없던 런이면 줄이 없다.
 * 받은 것이 비었으면(보존 정리·옛 런) 「활동 기록이 없습니다.」, 실패는 이 자리에서만 알린다(전역 토스트 없음)
 */
export function MessageActivity({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const activity = useRunActivity(runId, { enabled: open });
  const { events } = activity;
  const rows = useMemo(() => (events ? toActivityRows(events) : undefined), [events]);
  const summary = useMemo(
    () => (rows && events ? summarizeActivity(rows, events) : undefined),
    [rows, events],
  );

  let notice: ReactNode;
  if (activity.status === "error") {
    notice = (
      <InlineNotice onRetry={activity.refetch} retrying={activity.fetching}>
        활동을 불러오지 못했습니다
      </InlineNotice>
    );
  } else if (rows === undefined) {
    notice = <InlineNotice>불러오는 중…</InlineNotice>;
  } else if (rows.length === 0 && !activity.known) {
    notice = <InlineNotice>활동 기록이 없습니다.</InlineNotice>;
  }

  return <InlineActivity rows={rows} summary={summary} open={open} onOpenChange={setOpen} notice={notice} />;
}

function InlineNotice({
  children,
  onRetry,
  retrying,
}: {
  children: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 px-3 py-1 text-xs text-muted-foreground">
      <span>{children}</span>
      {onRetry && (
        <Button variant="outline" size="xs" disabled={retrying} onClick={onRetry}>
          다시 시도
        </Button>
      )}
    </div>
  );
}
