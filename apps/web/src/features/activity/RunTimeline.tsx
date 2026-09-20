import type { RunEvent } from "@dodok/shared";
import { BotIcon, LayersIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useRunEvents } from "@/api/queries";
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
import { ToolCallRow } from "./ToolCallRow";
import { useLiveRunEvents } from "./useLiveRunEvents";

/** 아래에서 이만큼 안이면 「끝에 붙어 있다」 — 새 행을 따라간다(메시지 목록과 같은 규칙) */
const STICK_PX = 40;

/**
 * 고른 런의 툴 타임라인(설계 5.2). REST 바탕(`GET /runs/:id/events`)에 실시간 `run.event` 를 합쳐 그린다.
 * 진행 중이면 끝에 붙어 따라간다 — 스스로 위로 올린 사람은 끌어내리지 않는다
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
      /* 짧은 창에서도 몇 행은 읽을 수 있어야 한다(브라우저 검증 D10) — 자리가 모자라면 위 런 목록이 먼저 줄어든다 */
      className="min-h-32 flex-1 overflow-y-auto"
    >
      {rows.length === 0 ? (
        <Notice>{running ? "아직 도구를 쓰지 않았습니다." : "도구 기록이 없습니다."}</Notice>
      ) : (
        <ol aria-label="활동 기록" className="divide-y text-sm">
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
  }
}

function StepLine({ row }: { row: StepRow }) {
  return (
    <p className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
      <LayersIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{row.name}</span>
      {row.state === "started" && <span className="shrink-0 text-xs">진행 중</span>}
    </p>
  );
}

function SubagentLine({ row }: { row: SubagentRow }) {
  return (
    <p className="flex items-start gap-2 px-3 py-2">
      <BotIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
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
 * 승인 행. 카드(버튼·카운트다운)는 태스크 8 이 패널 위쪽 `data-slot="approval-card"` 자리에 넣는다 —
 * 여기는 기록 한 줄이다. 툴 이름은 승인 레코드의 `toolCallId` 로 잇는다(Ruling 2)
 */
function ApprovalLine({ row, toolNames }: { row: ApprovalRow; toolNames: Map<string, string> }) {
  const tool = row.toolCallId === undefined ? undefined : toolNames.get(row.toolCallId);
  const outcome = approvalOutcomeLabel(row);
  return (
    <p
      data-slot="approval-row"
      data-approval-id={row.approvalId}
      className="flex items-start gap-2 px-3 py-2"
    >
      <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{row.title}</span>
        {tool && <span className="block text-xs text-muted-foreground">{tool}</span>}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{outcome ?? "대기 중"}</span>
    </p>
  );
}

function ErrorLine({ row }: { row: ErrorRow }) {
  return (
    <p className="flex items-start gap-2 px-3 py-2 text-destructive">
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{row.message}</span>
    </p>
  );
}
