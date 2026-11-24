import type { RunEvent } from "@dodok/shared";
import { BotIcon, LayersIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useRunEvents } from "@/api/queries";
import { cn } from "@/lib/utils";
import { ReasoningLine } from "./InlineActivity";
import { Notice } from "./Notice";
import {
  type ActivityRow,
  type ApprovalLookup,
  type ApprovalRow,
  type ErrorRow,
  type StepRow,
  type SubagentRow,
  approvalOutcomeLabel,
  keepTimelineEvents,
  mergeRunEvents,
  toActivityRows,
  toolNameByCallId,
} from "./timeline";
import { RowMarker, ToolCallRow } from "./ToolCallRow";
import { useLiveRunEvents } from "./useLiveRunEvents";

/** 아래에서 이만큼 안이면 「끝에 붙어 있다」 — 새 행을 따라간다(메시지 목록과 같은 규칙) */
const STICK_PX = 40;

/** 펼친 런 카드 안 타임라인의 승인 줄 — 답하는 카드는 패널 맨 위에 있다(재설계 스펙 「정한 것」) */
export const APPROVAL_PENDING_HINT = "승인 대기 — 위 카드에서 답하세요";

/**
 * 펼친 런 카드의 타임라인(설계 5.2·재설계 스펙 목표 7). REST 바탕(`GET /runs/:id/events`)에 실시간 `run.event` 를 합쳐 그린다 —
 * 펼친 카드에만 서므로 접힌 카드는 이벤트를 부르지 않는다. 줄 앞 상태 원을 세로 선이 잇는다(생각 · 도구 · 승인).
 * 높이를 묶고 제 안에서 스크롤한다 — 진행 중이면 끝에 붙어 따라가고, 스스로 위로 올린 사람은 끌어내리지 않는다
 */
export function RunTimeline({
  runId,
  running,
  approval,
}: {
  runId: string;
  /** 아직 끝나지 않은 런인가 — 진행 중이면 「아직 기록이 없습니다」 대신 기다리는 문구 */
  running: boolean;
  /** 승인 레코드 조회(Ruling 2). 태스크 8 의 승인 스토어가 이 자리에 붙는다 */
  approval?: ApprovalLookup;
}) {
  const rest = useRunEvents(runId);
  const live = useLiveRunEvents(runId);
  const base = useMemo(() => keepTimelineEvents(rest.data ?? []), [rest.data]);
  const events: readonly RunEvent[] = useMemo(() => mergeRunEvents(base, live), [base, live]);
  const rows = useMemo(() => toActivityRows(events, approval ? { approval } : {}), [events, approval]);
  const toolNames = useMemo(() => toolNameByCallId(rows), [rows]);
  const approvedTools = useMemo(() => {
    const ids = new Set<string>();
    for (const row of rows) if (row.kind === "approval" && row.toolCallId) ids.add(row.toolCallId);
    return ids;
  }, [rows]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  if (rest.isError) {
    return (
      <Notice onRetry={() => void rest.refetch()} retrying={rest.isFetching}>
        활동 기록을 불러오지 못했습니다.
      </Notice>
    );
  }
  if (rest.isPending) return <Notice>불러오는 중…</Notice>;

  return (
    <div
      ref={scrollRef}
      data-slot="run-timeline"
      onScroll={() => {
        const el = scrollRef.current;
        if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
      }}
      /* 카드 목록 전체가 한 스크롤이라 눌리지 않는다(D10) — 긴 런이 목록을 통째로 차지하지 않게 높이만 묶는다 */
      className="max-h-96 overflow-y-auto"
    >
      {rows.length === 0 ? (
        <Notice>{running ? "아직 도구를 쓰지 않았습니다." : "도구 기록이 없습니다."}</Notice>
      ) : (
        <ol
          aria-label="활동 기록"
          // 세로 선 — 상태 원(px-3 + 원 반지름 10px)의 가운데를 지난다. 원이 바탕을 칠해 선은 원 뒤로 지나간다
          className="relative py-1 text-sm before:absolute before:inset-y-3 before:left-[22px] before:w-px before:bg-border"
        >
          {rows.map((row) => (
            <li key={row.key}>
              <Row row={row} toolNames={toolNames} approvedTools={approvedTools} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Row({
  row,
  toolNames,
  approvedTools,
}: {
  row: ActivityRow;
  toolNames: Map<string, string>;
  approvedTools: ReadonlySet<string>;
}) {
  switch (row.kind) {
    case "tool":
      return <ToolCallRow row={row} approved={approvedTools.has(row.toolCallId)} />;
    case "step":
      return <StepLine row={row} />;
    case "subagent":
      return <SubagentLine row={row} />;
    case "approval":
      return <ApprovalLine row={row} toolNames={toolNames} />;
    case "error":
      return <ErrorLine row={row} />;
    case "reasoning":
      return <ReasoningLine row={row} />;
  }
}

function StepLine({ row }: { row: StepRow }) {
  return (
    <p className="flex items-center gap-2 px-3 py-1.5 text-muted-foreground">
      <RowMarker>
        <LayersIcon className="size-3 shrink-0" aria-hidden />
      </RowMarker>
      <span className="min-w-0 flex-1 truncate px-1">{row.name}</span>
      {row.state === "started" && <span className="shrink-0 text-xs">진행 중</span>}
    </p>
  );
}

function SubagentLine({ row }: { row: SubagentRow }) {
  return (
    <p className="flex items-start gap-2 px-3 py-1.5">
      <RowMarker>
        <BotIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      </RowMarker>
      <span className="min-w-0 flex-1 px-1 pt-0.5">
        <span className="font-medium">서브에이전트{row.label ? ` · ${row.label}` : ""}</span>
        {row.state === "error" && (
          <span className="block text-xs text-destructive">{row.message ?? "실패"}</span>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {row.state === "started" ? "진행 중" : row.state === "finished" ? "완료" : "실패"}
      </span>
    </p>
  );
}

/**
 * 승인 행. 답하는 카드(버튼·카운트다운)는 패널 맨 위 `data-slot="approval-card"` 자리에 있다 — 여기는 기록 한 줄이고,
 * 아직 답하지 않았으면 그 카드를 가리킨다. 툴 이름은 승인 레코드의 `toolCallId` 로 잇는다(Ruling 2)
 */
function ApprovalLine({ row, toolNames }: { row: ApprovalRow; toolNames: Map<string, string> }) {
  const tool = row.toolCallId === undefined ? undefined : toolNames.get(row.toolCallId);
  const outcome = approvalOutcomeLabel(row);
  return (
    <p
      data-slot="approval-row"
      data-approval-id={row.approvalId}
      className="flex items-start gap-2 px-3 py-1.5"
    >
      <RowMarker className={outcome === undefined ? "border-warning" : undefined}>
        <ShieldCheckIcon
          className={cn("size-3 shrink-0", outcome === undefined ? "text-warning" : "text-muted-foreground")}
          aria-hidden
        />
      </RowMarker>
      <span className="min-w-0 flex-1 px-1 pt-0.5">
        <span className="font-medium">{row.title}</span>
        {tool && <span className="block text-xs text-muted-foreground">{tool}</span>}
        {outcome === undefined && (
          <span className="block text-xs text-foreground">{APPROVAL_PENDING_HINT}</span>
        )}
      </span>
      {outcome !== undefined && (
        <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">{outcome}</span>
      )}
    </p>
  );
}

function ErrorLine({ row }: { row: ErrorRow }) {
  return (
    <p className="flex items-start gap-2 px-3 py-1.5 text-destructive">
      <RowMarker className="border-destructive/50">
        <TriangleAlertIcon className="size-3 shrink-0" aria-hidden />
      </RowMarker>
      <span className="min-w-0 flex-1 px-1 pt-0.5 break-words">{row.message}</span>
    </p>
  );
}
