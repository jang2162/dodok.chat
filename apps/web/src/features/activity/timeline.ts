import type { ApprovalDecision, ApprovalReason, Run, RunEvent, RunState, RunStatus } from "@dodok/shared";

/**
 * 활동 타임라인의 순수 변환(설계 5.2). 런 이벤트를 화면 행으로 접고, REST 바탕과 실시간 값을 합친다.
 * 텍스트 델타는 행이 되지 않는다 — 대화가 이미 보여 준다(계획 태스크 7 판정 1)
 */

/** 시작(TOOL_CALL_START)을 못 본 툴 호출의 이름 — 인자·결과는 그래도 보인다 */
export const UNKNOWN_TOOL = "알 수 없는 도구";
/** 요구(APPROVAL_REQUESTED)를 못 보고 확정만 본 승인의 제목(레코드에 제목이 있으면 그쪽) */
export const UNKNOWN_APPROVAL = "승인";

/** Gateway 가 380자 초과분을 잘라 남기는 표시(설계 3.1) */
const TRUNCATION = /\[\+\d+ chars hidden\]/;
export const isTruncated = (text: string | undefined): boolean => text !== undefined && TRUNCATION.test(text);

export type ToolRow = {
  kind: "tool";
  key: string;
  toolCallId: string;
  name: string;
  args?: string;
  result?: string;
  ok?: boolean;
  durationMs?: number;
  state: "running" | "done";
};
export type StepRow = { kind: "step"; key: string; name: string; state: "started" | "finished" };
export type SubagentRow = {
  kind: "subagent";
  key: string;
  label?: string;
  state: "started" | "finished" | "error";
  message?: string;
};
export type ApprovalRow = {
  kind: "approval";
  key: string;
  approvalId: string;
  title: string;
  /** 툴 행과 잇는 열쇠 — 승인 레코드가 정본이다(Ruling 2). 레코드가 없으면 이벤트 페이로드 값 */
  toolCallId?: string;
  decision?: ApprovalDecision;
  reason?: ApprovalReason;
};
export type ErrorRow = { kind: "error"; key: string; message: string };
export type ActivityRow = ToolRow | StepRow | SubagentRow | ApprovalRow | ErrorRow;

/**
 * 승인 레코드에서 화면이 쓰는 값만. 타임라인 이벤트 `APPROVAL_REQUESTED` 의 `toolCallId` 는 실물 프레임 도착
 * 순서에 따라 비어 있을 수 있어(p2-t6 어긋남 C) 레코드 쪽을 정본으로 본다(Ruling 2).
 * `Approval` 이 그대로 들어맞는다 — 태스크 8 의 승인 스토어가 이 자리에 붙는다
 */
export type ApprovalLink = { toolCallId?: string; title?: string };
export type ApprovalLookup = (approvalId: string) => ApprovalLink | undefined;

/**
 * 타임라인 행이 되는 이벤트 종류. 텍스트 델타(한 런에 수천 개)는 여기 없다 — 걸러서 들고 있어야
 * 실시간 병합이 델타마다 전체를 다시 정렬하지 않는다
 */
const TIMELINE_TYPES: ReadonlySet<RunEvent["type"]> = new Set([
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_RESULT",
  "TOOL_CALL_END",
  "STEP_STARTED",
  "STEP_FINISHED",
  "SUBAGENT_STARTED",
  "SUBAGENT_FINISHED",
  "SUBAGENT_ERROR",
  "APPROVAL_REQUESTED",
  "APPROVAL_RESOLVED",
  "RUN_ERROR",
] satisfies ReadonlyArray<RunEvent["type"]>);

/** 이 이벤트가 타임라인 행에 쓰이는가 — `toActivityRows` 가 버릴 것을 미리 거른다 */
export const isTimelineEvent = (event: RunEvent): boolean => TIMELINE_TYPES.has(event.type);

/** 행이 되는 것만 남긴다. 버릴 것이 없으면 받은 배열을 그대로 돌려준다 */
export function keepTimelineEvents(events: readonly RunEvent[]): readonly RunEvent[] {
  const kept = events.filter(isTimelineEvent);
  return kept.length === events.length ? events : kept;
}

/**
 * 런 이벤트(seq 오름차순)를 화면 행으로 접는다. 한 대상(툴 호출·단계·서브에이전트·승인)의 여러 이벤트는
 * **첫 등장 자리**의 한 행으로 모인다 — 그래서 이벤트 도착 순서에 기대지 않는다(Ruling 3).
 */
export function toActivityRows(
  events: readonly RunEvent[],
  opts: { approval?: ApprovalLookup } = {},
): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const tools = new Map<string, ToolRow>();
  /** 아직 안 닫힌 단계만 — 같은 이름이 되풀이되면 뒤엣것이 열린 단계다 */
  const openSteps = new Map<string, StepRow>();
  const subagents = new Map<string, SubagentRow>();
  const approvals = new Map<string, ApprovalRow>();

  const add = <R extends ActivityRow>(row: R): R => {
    rows.push(row);
    return row;
  };
  const tool = (toolCallId: string): ToolRow => {
    const found = tools.get(toolCallId);
    if (found) return found;
    const row = add<ToolRow>({
      kind: "tool",
      key: `tool:${toolCallId}`,
      toolCallId,
      name: UNKNOWN_TOOL,
      state: "running",
    });
    tools.set(toolCallId, row);
    return row;
  };
  const subagent = (subagentRunId: string): SubagentRow => {
    const found = subagents.get(subagentRunId);
    if (found) return found;
    const row = add<SubagentRow>({
      kind: "subagent",
      key: `subagent:${subagentRunId}`,
      state: "started",
    });
    subagents.set(subagentRunId, row);
    return row;
  };
  const approval = (approvalId: string): ApprovalRow => {
    const found = approvals.get(approvalId);
    if (found) return found;
    const record = opts.approval?.(approvalId);
    const row = add<ApprovalRow>({
      kind: "approval",
      key: `approval:${approvalId}`,
      approvalId,
      title: record?.title ?? UNKNOWN_APPROVAL,
    });
    if (record?.toolCallId !== undefined) row.toolCallId = record.toolCallId;
    approvals.set(approvalId, row);
    return row;
  };

  for (const event of events) {
    switch (event.type) {
      case "TOOL_CALL_START": {
        const row = tool(event.toolCallId);
        if (row.name === UNKNOWN_TOOL) row.name = event.toolCallName;
        break;
      }
      case "TOOL_CALL_ARGS": {
        const row = tool(event.toolCallId);
        row.args = (row.args ?? "") + event.delta;
        break;
      }
      case "TOOL_CALL_RESULT": {
        // 결과가 오면 끝난 것이다 — TOOL_CALL_END 를 주지 않는 경로가 있다
        const row = tool(event.toolCallId);
        row.result = event.content;
        row.state = "done";
        if (event.ok !== undefined) row.ok = event.ok;
        if (event.durationMs !== undefined) row.durationMs = event.durationMs;
        break;
      }
      case "TOOL_CALL_END":
        tool(event.toolCallId).state = "done";
        break;
      case "STEP_STARTED":
        openSteps.set(
          event.stepName,
          add<StepRow>({ kind: "step", key: `step:${event.seq}`, name: event.stepName, state: "started" }),
        );
        break;
      case "STEP_FINISHED": {
        const open = openSteps.get(event.stepName);
        if (open) {
          open.state = "finished";
          openSteps.delete(event.stepName);
        } else {
          add<StepRow>({ kind: "step", key: `step:${event.seq}`, name: event.stepName, state: "finished" });
        }
        break;
      }
      case "SUBAGENT_STARTED": {
        const row = subagent(event.subagentRunId);
        if (event.label !== undefined) row.label = event.label;
        break;
      }
      case "SUBAGENT_FINISHED":
        subagent(event.subagentRunId).state = "finished";
        break;
      case "SUBAGENT_ERROR": {
        const row = subagent(event.subagentRunId);
        row.state = "error";
        row.message = event.message;
        break;
      }
      case "APPROVAL_REQUESTED": {
        const row = approval(event.approvalId);
        row.title = opts.approval?.(event.approvalId)?.title ?? event.title;
        // 레코드가 정본, 없을 때만 이벤트 값
        const linked = opts.approval?.(event.approvalId)?.toolCallId ?? event.toolCallId;
        if (linked !== undefined) row.toolCallId = linked;
        break;
      }
      case "APPROVAL_RESOLVED": {
        const row = approval(event.approvalId);
        row.decision = event.decision;
        row.reason = event.reason;
        break;
      }
      case "RUN_ERROR":
        add<ErrorRow>({ kind: "error", key: `error:${event.seq}`, message: event.message });
        break;
      default:
        // 텍스트 델타·런 수명(RUN_QUEUED·STARTED·FINISHED·ABORTED·STATE_SNAPSHOT)·CUSTOM 은 행이 아니다.
        // 런의 끝(중지·완료)은 목록·머리의 상태 배지가 보인다
        break;
    }
  }
  return rows;
}

/**
 * 승인 행의 결말 한 마디. 아직 확정 전이면 undefined. **만료·취소는 `reason` 으로 가른다** —
 * 같은 만료라도 경로마다 `decision` 이 다르다(Gateway 는 `deny`, 서버 감시는 빈 값 — p2-t6 실측 2)
 */
export function approvalOutcomeLabel(row: Pick<ApprovalRow, "decision" | "reason">): string | undefined {
  switch (row.reason) {
    case "timeout":
      return "만료됨";
    case "run-aborted":
    case "gateway-restart":
      return "취소됨";
    case "malformed-verdict":
    case "no-route":
    case "storage-corrupt":
      return "처리하지 못함";
    default:
      if (row.decision === undefined) return undefined;
      return row.decision === "deny" ? "거절됨" : "허용됨";
  }
}

/** 툴 호출 id → 툴 이름. 승인 행이 가리키는 툴을 찾는 데 쓴다(Ruling 2 의 이음) */
export function toolNameByCallId(rows: readonly ActivityRow[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) if (row.kind === "tool") names.set(row.toolCallId, row.name);
  return names;
}

/**
 * REST 바탕과 실시간 이벤트를 seq 로 합친다. 같은 seq 는 **먼저 온 쪽**(바탕)이 이긴다.
 * 보탤 것이 없으면 받은 배열을 그대로 돌려준다 — 참조가 그대로라 다시 그리지 않는다
 */
export function mergeRunEvents(
  base: readonly RunEvent[],
  incoming: readonly RunEvent[],
): readonly RunEvent[] {
  if (incoming.length === 0) return base;
  if (base.length === 0) return incoming;
  const bySeq = new Map<number, RunEvent>();
  for (const e of base) bySeq.set(e.seq, e);
  for (const e of incoming) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** 활동 목록의 런 한 줄 — REST 의 `Run` 위에 실시간 `run.state` 를 덮은 것 */
export type ActivityRun = RunState & { createdAt?: string };

/**
 * REST 런 목록(최근 50)에 실시간 런 상태를 덮는다. REST 에 아직 없는 런(방금 시작)도 목록에 든다.
 * 실시간 값이 싣지 않는 열(createdAt 등)은 REST 값이 남는다. 최신이 앞 — id 가 uuid v7 이라 생성 순이다
 */
export function mergeRuns(rest: readonly Run[], live: readonly RunState[]): ActivityRun[] {
  const byId = new Map<string, ActivityRun>();
  for (const run of rest) byId.set(run.id, run);
  for (const state of live) {
    const prev = byId.get(state.id);
    byId.set(state.id, prev ? { ...prev, ...state } : state);
  }
  return [...byId.values()].sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
}

/** 런 소요 시간(ms). 끝났으면 시작~끝, 진행 중이면 시작~지금. 시작 전이면 undefined */
export function runDurationMs(
  run: { startedAt?: string; endedAt?: string },
  now: number,
): number | undefined {
  if (run.startedAt === undefined) return undefined;
  return (run.endedAt === undefined ? now : Date.parse(run.endedAt)) - Date.parse(run.startedAt);
}

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: "대기 중",
  streaming: "응답 중",
  tool: "도구 사용 중",
  awaiting_approval: "승인 대기",
  finalizing: "마무리 중",
  done: "완료",
  error: "실패",
  aborted: "중지됨",
};
export const runStatusLabel = (status: RunStatus): string => STATUS_LABEL[status];

/** 끝난 런은 회색, 실패는 빨강, 진행 중은 강조 — Badge 의 variant 이름 */
export function runStatusVariant(status: RunStatus): "default" | "secondary" | "destructive" {
  if (status === "error") return "destructive";
  if (status === "done" || status === "aborted") return "secondary";
  return "default";
}
