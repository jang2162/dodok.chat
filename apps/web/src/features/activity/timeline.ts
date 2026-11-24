import type { ApprovalDecision, ApprovalReason, RunEvent, RunState, RunStatus } from "@dodok/shared";

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
/**
 * 추론 한 덩이(START~END). 글은 델타를 이은 것 — START/END 만 오는 모델(요약·빈 thinking)이면 빈 글이다.
 * `truncated` 는 서버가 런의 추론 저장 상한에 닿아 뒤를 버렸다는 표시(`CUSTOM reasoning_truncated`)
 */
export type ReasoningRow = {
  kind: "reasoning";
  key: string;
  text: string;
  state: "running" | "done";
  truncated?: boolean;
};
export type ActivityRow = ToolRow | StepRow | SubagentRow | ApprovalRow | ErrorRow | ReasoningRow;

/** 서버가 런의 추론 저장 상한에 닿았을 때 남기는 CUSTOM 이름(server orchestrator `REASONING_TRUNCATED_EVENT`) */
export const REASONING_TRUNCATED = "reasoning_truncated";

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
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
] satisfies ReadonlyArray<RunEvent["type"]>);

/** 이 이벤트가 타임라인 행에 쓰이는가 — `toActivityRows` 가 버릴 것을 미리 거른다. CUSTOM 은 추론 잘림 표시만 */
export const isTimelineEvent = (event: RunEvent): boolean =>
  TIMELINE_TYPES.has(event.type) || (event.type === "CUSTOM" && event.name === REASONING_TRUNCATED);

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
  /** 아직 안 닫힌 추론 — 같은 messageId 가 END 뒤에 다시 오면 새 덩이다(그 자리, 시간 순) */
  const openReasoning = new Map<string, ReasoningRow>();
  let lastReasoning: ReasoningRow | undefined;

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

  const reasoning = (messageId: string, seq: number): ReasoningRow => {
    const found = openReasoning.get(messageId);
    if (found) return found;
    const row = add<ReasoningRow>({ kind: "reasoning", key: `reasoning:${seq}`, text: "", state: "running" });
    openReasoning.set(messageId, row);
    lastReasoning = row;
    return row;
  };

  for (const event of events) {
    switch (event.type) {
      case "REASONING_MESSAGE_START":
        reasoning(event.messageId, event.seq);
        break;
      case "REASONING_MESSAGE_CONTENT": {
        const row = reasoning(event.messageId, event.seq);
        row.text += event.delta;
        break;
      }
      case "REASONING_MESSAGE_END": {
        reasoning(event.messageId, event.seq).state = "done";
        openReasoning.delete(event.messageId);
        break;
      }
      case "CUSTOM":
        // 상한에 닿은 덩이는 표시 바로 앞의 추론이다 — 서버가 잘린 글을 먼저 내보낸 뒤 표시를 남긴다
        if (event.name === REASONING_TRUNCATED && lastReasoning) lastReasoning.truncated = true;
        break;
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
        // 텍스트 델타·런 수명(RUN_QUEUED·STARTED·FINISHED·ABORTED·STATE_SNAPSHOT)은 행이 아니다.
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

/** 응답 안 활동의 요약 줄(스펙 「모양」) — 추론이 있었는가, 도구 수, 걸린 시간 */
export type ActivitySummary = { reasoning: boolean; tools: number; durationMs?: number };

/**
 * 행 → 요약. 걸린 시간은 활동 이벤트(행이 되는 것)의 첫 ts ~ 마지막 ts 다 — 답 글 사이에 도구가 끼어도 활동만 잰다.
 * 아직 도는 행이 있으면(흐르는 중) 시간은 빼고, 1초가 안 되면 뺀다
 */
export function summarizeActivity(
  rows: readonly ActivityRow[],
  events: readonly RunEvent[] = [],
): ActivitySummary {
  const summary: ActivitySummary = {
    reasoning: rows.some((r) => r.kind === "reasoning"),
    tools: rows.filter((r) => r.kind === "tool").length,
  };
  if (rows.some((r) => (r.kind === "tool" || r.kind === "reasoning") && r.state === "running"))
    return summary;
  let first: number | undefined;
  let last: number | undefined;
  for (const e of events) {
    if (!isTimelineEvent(e)) continue;
    const t = Date.parse(e.ts);
    if (first === undefined || t < first) first = t;
    if (last === undefined || t > last) last = t;
  }
  if (first !== undefined && last !== undefined && last - first >= 1000) summary.durationMs = last - first;
  return summary;
}

/** 요약 줄의 글 — `활동 · 추론 · 도구 4 · 12초`. 없는 것은 빠진다. `summary` 가 없으면(아직 안 받음) 「활동」만 */
export function activitySummaryLabel(summary: ActivitySummary | undefined): string {
  const parts = ["활동"];
  if (summary?.reasoning) parts.push("추론");
  if (summary && summary.tools > 0) parts.push(`도구 ${summary.tools}`);
  if (summary?.durationMs !== undefined) parts.push(`${Math.round(summary.durationMs / 1000)}초`);
  return parts.join(" · ");
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

/**
 * 활동 목록의 런 한 줄 — REST 의 `Run` 위에 실시간 `run.state` 를 덮은 것.
 * `frozenAt` 은 「더는 진행 중이 아니다」를 안 시각이다 — 끝난 시각을 모르는 채 남은 줄의 소요를 거기서 멈춘다(`freezeDurations`)
 */
export type ActivityRun = RunState & { createdAt?: string; frozenAt?: string };

/**
 * 바탕(REST 런 목록 최근 50, 그 밑에 깔린 자리값)에 실시간 런 상태를 덮는다. REST 에 아직 없는 런(방금 시작)도
 * 목록에 든다. 실시간 값이 싣지 않는 열(createdAt 등)은 바탕 값이 남는다. 바탕 안에서는 **뒤에 온 것이 이긴다** —
 * 부르는 쪽이 자리값을 앞에, 서버 사실을 뒤에 놓는다(D12). 최신이 앞 — id 가 uuid v7 이라 생성 순이다
 */
export function mergeRuns(base: readonly ActivityRun[], live: readonly RunState[]): ActivityRun[] {
  const byId = new Map<string, ActivityRun>();
  for (const run of base) byId.set(run.id, run);
  for (const state of live) {
    const prev = byId.get(state.id);
    byId.set(state.id, prev ? { ...prev, ...state } : state);
  }
  return [...byId.values()].sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? 1 : -1));
}

/**
 * 더는 진행 중이 아닌 줄 아는데 끝난 시각은 모르는 런에 멈춘 시각(`frozenAt`)을 단다(p2-t14 리뷰 §A.2).
 * `stopped` 는 런 id → 그 사실을 안 시각. 끊긴 사이 끝난 런의 자리값(D12)이 목록 조회가 실패하는 동안 「승인 대기 · 25 → 26초」로
 * 흘렀다 — 흐르는 소요는 지어낸 사실이다. 줄은 그대로 두고(상태 글자도 마지막으로 본 것) 소요만 멈춘다.
 * 끝난 시각을 아는 줄(서버 사실이 덮었다)은 그대로다
 */
export function freezeDurations(
  runs: readonly ActivityRun[],
  stopped: ReadonlyMap<string, string>,
): ActivityRun[] {
  return runs.map((run) => {
    const frozenAt = stopped.get(run.id);
    return frozenAt === undefined || run.endedAt !== undefined ? run : { ...run, frozenAt };
  });
}

/** 런 소요 시간(ms). 끝났으면 시작~끝, 멈췄으면 시작~멈춘 시각, 진행 중이면 시작~지금. 시작 전이면 undefined */
export function runDurationMs(
  run: { startedAt?: string; endedAt?: string; frozenAt?: string },
  now: number,
): number | undefined {
  if (run.startedAt === undefined) return undefined;
  const end = run.endedAt ?? run.frozenAt;
  return (end === undefined ? now : Date.parse(end)) - Date.parse(run.startedAt);
}

/**
 * 소요가 아직 흐르는 런이 있는가 — 목록은 이때만 1초 틱을 돌린다(브라우저 검증 D7).
 * 끝난 런은 `endedAt`, 멈춘 자리값은 `frozenAt` 으로 고정이라 다시 그려도 값이 같다: 그런 줄만 남으면 틱은 멈춰야 한다
 */
export const hasFlowingDuration = (
  runs: readonly { startedAt?: string; endedAt?: string; frozenAt?: string }[],
): boolean =>
  runs.some((r) => r.startedAt !== undefined && r.endedAt === undefined && r.frozenAt === undefined);

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

/** 상태 칩의 빛깔 — 진행 중 primary · 승인 대기 warning · 완료 success · 실패 destructive · 중지 muted(재설계 스펙 목표 7) */
export type RunStatusTone = "running" | "approval" | "done" | "error" | "aborted";
export function runStatusTone(status: RunStatus): RunStatusTone {
  switch (status) {
    case "awaiting_approval":
      return "approval";
    case "done":
      return "done";
    case "error":
      return "error";
    case "aborted":
      return "aborted";
    default:
      return "running";
  }
}

/** 접힌 런 카드의 요약 — 추론 덩이 수, 도구 호출 수와 이름들(처음 나온 순, 겹치면 한 번), 답 글 수 */
export type RunSummary = { reasoning: number; tools: number; toolNames: string[]; answers: number };

/**
 * 런의 **원본** 이벤트(REST `GET /runs/:id/events` 그대로 — 텍스트 이벤트가 있어야 답을 센다) → 요약.
 * 추론은 REASONING_MESSAGE_START, 답은 TEXT_MESSAGE_START 를 메시지 id 로 한 번씩, 도구는 toolCallId 로 한 번씩 센다
 */
export function summarizeRun(events: readonly RunEvent[]): RunSummary {
  const reasoning = new Set<string>();
  const answers = new Set<string>();
  const tools = new Map<string, string>();
  for (const e of events) {
    if (e.type === "REASONING_MESSAGE_START") reasoning.add(`${e.messageId}:${e.seq}`);
    else if (e.type === "TEXT_MESSAGE_START") answers.add(e.messageId);
    else if (e.type === "TOOL_CALL_START") tools.set(e.toolCallId, e.toolCallName);
    else if (e.type === "TOOL_CALL_RESULT" && !tools.has(e.toolCallId)) tools.set(e.toolCallId, UNKNOWN_TOOL);
  }
  return {
    reasoning: reasoning.size,
    tools: tools.size,
    toolNames: [...new Set(tools.values())],
    answers: answers.size,
  };
}

/** 요약 한 줄 — `생각 1 · 도구 2(Read, Bash) · 답 1`. 0 인 것은 빠지고, 다 0 이면 undefined(줄을 그리지 않는다) */
export function runSummaryLabel(summary: RunSummary): string | undefined {
  const parts: string[] = [];
  if (summary.reasoning > 0) parts.push(`생각 ${summary.reasoning}`);
  if (summary.tools > 0) parts.push(`도구 ${summary.tools}(${summary.toolNames.join(", ")})`);
  if (summary.answers > 0) parts.push(`답 ${summary.answers}`);
  return parts.length === 0 ? undefined : parts.join(" · ");
}
