import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { ApprovalKind, RunState, RunUsage } from "../domain";

const base = { runId: Id, seq: z.int().min(1), ts: IsoDateTime };

function ev<T extends string, S extends Record<string, z.ZodType>>(type: T, shape: S) {
  return z.object({ type: z.literal(type), ...base, ...shape });
}

export const RunEvent = z.discriminatedUnion("type", [
  // 런 수명
  ev("RUN_QUEUED", { position: z.int().optional() }), // dodok 확장
  ev("RUN_STARTED", {
    threadId: Id, // channelId
    agentId: Id,
    sessionKey: z.string(),
    providerRunId: z.string().optional(),
  }),
  ev("RUN_FINISHED", {
    messageIds: z.array(Id),
    usage: RunUsage.optional(),
    stopReason: z.string().optional(),
  }),
  ev("RUN_ERROR", {
    message: z.string(),
    code: z.string().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  }),
  ev("RUN_ABORTED", { by: z.enum(["user", "gateway"]) }), // dodok 확장 (타임아웃은 RUN_ERROR code TIMEOUT)
  ev("STATE_SNAPSHOT", { snapshot: RunState }), // 상태 전이마다
  // 텍스트
  ev("TEXT_MESSAGE_START", { messageId: z.string(), role: z.literal("assistant") }),
  ev("TEXT_MESSAGE_CONTENT", { messageId: z.string(), delta: z.string().min(1) }),
  ev("TEXT_MESSAGE_REPLACE", { messageId: z.string(), text: z.string() }), // dodok 확장
  ev("TEXT_MESSAGE_END", { messageId: z.string() }),
  // 툴
  ev("TOOL_CALL_START", {
    toolCallId: z.string(),
    toolCallName: z.string(),
    parentMessageId: z.string().optional(),
  }),
  ev("TOOL_CALL_ARGS", { toolCallId: z.string(), delta: z.string() }),
  ev("TOOL_CALL_END", { toolCallId: z.string() }),
  ev("TOOL_CALL_RESULT", {
    toolCallId: z.string(),
    content: z.string(),
    ok: z.boolean().optional(),
    durationMs: z.int().optional(),
  }),
  // 단계·서브에이전트
  ev("STEP_STARTED", { stepName: z.string() }),
  ev("STEP_FINISHED", { stepName: z.string() }),
  ev("SUBAGENT_STARTED", {
    subagentRunId: Id,
    providerRunId: z.string().optional(),
    label: z.string().optional(),
  }),
  ev("SUBAGENT_FINISHED", { subagentRunId: Id }),
  ev("SUBAGENT_ERROR", { subagentRunId: Id, message: z.string() }),
  // 승인 (dodok 확장)
  ev("APPROVAL_REQUESTED", {
    approvalId: Id,
    kind: ApprovalKind,
    summary: z.string(),
    expiresAt: IsoDateTime.optional(),
  }),
  ev("APPROVAL_RESOLVED", {
    approvalId: Id,
    decision: z.enum(["approved", "denied", "expired"]),
    decidedBy: Id.optional(),
  }),
  // 미분류
  ev("CUSTOM", { name: z.string(), value: z.unknown().optional() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;
export type RunEventType = RunEvent["type"];

export const RUN_EVENT_TYPES = RunEvent.options.map((o) => o.shape.type.value) as RunEventType[];

// 계약 스펙 5.1 — 런 상태머신 입력 신호. 서버 오케스트레이터(machine.ts)와 어댑터(AdapterEvent)가 함께 쓴다.
export type RunSignal =
  | { kind: "gateway_started" } // chat.send 응답 runStarted 또는 첫 agent 이벤트
  | { kind: "text_delta" }
  | { kind: "tool_start" }
  | { kind: "tool_end"; openTools: number }
  | { kind: "approval_requested" }
  | { kind: "approval_resolved" }
  | { kind: "gateway_final" } // chat state: final
  | { kind: "canonical_received" } // 브리지 outbound.message 도착
  | { kind: "final_timeout" } // finalizing 상한(기본 10s)
  | { kind: "gateway_error"; code: string; message: string }
  | { kind: "gateway_aborted" }
  | { kind: "abort_requested" }
  | { kind: "queue_timeout" }
  | { kind: "run_timeout" };
