import type { EventFrame } from "@openclaw/gateway-protocol";

// ADR 0001 6.2·6.3·6.5 의 실물 프레임 모양을 손으로 옮긴 것. 값은 가짜(토큰·워크스페이스 내용 없음).
// chat error·aborted 는 스파이크에서 관찰되지 않아 @openclaw/gateway-protocol ChatEventSchema 로 채웠다.

export const RUN_ID = "01a09fc9-d204-7551-89d6-38544d07a201";
export const CHANNEL_ID = "01a09fc9-d204-7551-89d6-38544d07a202";
export const PROVIDER_AGENT_ID = "dev";
export const SESSION_KEY = `agent:${PROVIDER_AGENT_ID}:dodok:channel:${CHANNEL_ID}`;
export const TOOL_CALL_ID = "toolu_01FixtureBash";

const TS = 1_789_399_759_910;

export type FrameOpts = { runId?: string; sessionKey?: string; agentId?: string; seq?: number };

function frame(event: string, payload: Record<string, unknown>, seq: number): EventFrame {
  return { type: "event", event, payload, seq };
}

function common(o: FrameOpts) {
  return {
    runId: o.runId ?? RUN_ID,
    sessionKey: o.sessionKey ?? SESSION_KEY,
    agentId: o.agentId ?? PROVIDER_AGENT_ID,
    seq: o.seq ?? 1,
  };
}

export type ContentPart = { type: string; text?: string; [key: string]: unknown };

export function assistantMessage(content: string | ContentPart[]) {
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
  return { role: "assistant", content: parts, timestamp: TS };
}

function chat(state: string, fields: Record<string, unknown>, o: FrameOpts): EventFrame {
  const c = common(o);
  return frame("chat", { ...c, state, ...fields }, c.seq);
}

export function chatStatus(phase = "starting_model", o: FrameOpts = {}): EventFrame {
  return chat("status", { phase }, o);
}

/** `snapshot` 은 누적 스냅샷(`message`). 생략하면 `deltaText` 와 같다. */
export function chatDelta(
  deltaText: string,
  o: FrameOpts & { snapshot?: string | ContentPart[]; replace?: boolean } = {},
): EventFrame {
  return chat(
    "delta",
    {
      deltaText,
      message: assistantMessage(o.snapshot ?? deltaText),
      ...(o.replace === undefined ? {} : { replace: o.replace }),
    },
    o,
  );
}

/** final 에는 usage·stopReason 이 없다(ADR 0001 6.3). `null` 이면 message 를 뺀다. */
export function chatFinal(content: string | ContentPart[] | null = "PONG", o: FrameOpts = {}): EventFrame {
  return chat("final", content === null ? {} : { message: assistantMessage(content) }, o);
}

export function chatError(
  o: FrameOpts & { errorMessage?: string; errorKind?: string; errorDetail?: Record<string, unknown> } = {},
): EventFrame {
  const { errorMessage, errorKind, errorDetail, ...rest } = o;
  return chat(
    "error",
    {
      ...(errorMessage === undefined ? {} : { errorMessage }),
      ...(errorKind === undefined ? {} : { errorKind }),
      ...(errorDetail === undefined ? {} : { errorDetail }),
    },
    rest,
  );
}

export function chatAborted(o: FrameOpts = {}): EventFrame {
  return chat("aborted", { stopReason: "aborted" }, o);
}

export function agentEvent(stream: string, data: Record<string, unknown>, o: FrameOpts = {}): EventFrame {
  const c = common(o);
  return frame("agent", { ...c, ts: TS, isHeartbeat: false, stream, data }, c.seq);
}

export function toolStart(
  toolCallId = TOOL_CALL_ID,
  o: FrameOpts & { name?: string; args?: Record<string, unknown> } = {},
): EventFrame {
  const args = "args" in o ? o.args : { command: "echo fixture", description: "print a line" };
  return agentEvent(
    "tool",
    { phase: "start", name: o.name ?? "Bash", toolCallId, ...(args ? { args } : {}) },
    o,
  );
}

export function toolResult(
  toolCallId = TOOL_CALL_ID,
  o: FrameOpts & { result?: unknown; isError?: boolean } = {},
): EventFrame {
  return agentEvent(
    "tool",
    {
      phase: "result",
      name: "Bash",
      toolCallId,
      isError: o.isError ?? false,
      result: "result" in o ? o.result : "fixture\n",
      args: { command: "echo fixture", description: "print a line" },
    },
    o,
  );
}

export function lifecycleStart(o: FrameOpts = {}): EventFrame {
  return agentEvent("lifecycle", { phase: "start", startedAt: TS - 1000 }, o);
}

export function lifecycleEnd(o: FrameOpts = {}): EventFrame {
  return agentEvent(
    "lifecycle",
    {
      phase: "end",
      startedAt: TS - 1000,
      endedAt: TS,
      terminalReply: { disposition: "reply", text: "PONG" },
      executionSettled: true,
    },
    o,
  );
}

/** usage·stopReason·model 은 session.message 의 message 안에 실린다(ADR 0001 6.3). */
export function sessionMessage(
  o: {
    runId?: string;
    role?: string;
    idempotencyKey?: string | null;
    usage?: Record<string, unknown> | null;
    payloadRunId?: string;
    /** `message.__openclaw.runId` — OpenClaw 가 전사 메시지에 붙이는 런 id */
    openclawRunId?: string;
    seq?: number;
  } = {},
): EventFrame {
  const runId = o.runId ?? RUN_ID;
  const idempotencyKey = o.idempotencyKey === undefined ? `cli-assistant:${runId}` : o.idempotencyKey;
  const usage =
    o.usage === undefined
      ? {
          input: 2,
          output: 181,
          totalTokens: 72_629,
          cacheRead: 71_662,
          cacheWrite: 784,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0123 },
        }
      : o.usage;
  const message = {
    role: o.role ?? "assistant",
    content: [{ type: "text", text: "PONG" }],
    stopReason: "stop",
    api: "fixture-api",
    provider: "claude-cli",
    model: "claude-opus-5",
    ...(usage === null ? {} : { usage }),
    timestamp: TS,
    ...(idempotencyKey === null ? {} : { idempotencyKey }),
    __openclaw: {
      id: "fixture-message-id",
      seq: 4,
      ...(o.openclawRunId === undefined ? {} : { runId: o.openclawRunId }),
    },
  };
  const seq = o.seq ?? 7;
  return frame(
    "session.message",
    {
      sessionKey: SESSION_KEY,
      messageId: "fixture-message-id",
      messageSeq: 4,
      sessionId: "01a09fc9-d204-7551-89d6-38544d07a2ff",
      ...(o.payloadRunId === undefined ? {} : { runId: o.payloadRunId }),
      message,
    },
    seq,
  );
}

export function sessionsChanged(): EventFrame {
  return frame(
    "sessions.changed",
    {
      reason: "participants",
      createdVia: "operator",
      kind: "direct",
      visibility: "shared",
      sessionId: "01a09fc9-d204-7551-89d6-38544d07a2ff",
      sessionKey: SESSION_KEY,
    },
    1,
  );
}

// ── 승인 (승인 스파이크 3.2·3.3·3.4 의 원본 프레임. 워크스페이스 절대경로만 줄였다) ──

export const APPROVAL_ID = "plugin:533fe246-fa79-4f86-bcd0-3c08b549cb20";
export const APPROVAL_TOOL_CALL_ID = "toolu_018ohZoiNMZwidAe7fWsWSam";
const APPROVAL_CREATED_MS = 1_789_897_787_988;
const APPROVAL_EXPIRES_MS = 1_789_897_907_988; // +120s — Gateway plugin 승인 기본 TTL
const APPROVAL_RESOLVED_MS = 1_789_897_790_009;
const APPROVAL_ARGS = '{"file_path":"/tmp/spike-approval.txt","content":"hello\\n"}';

/**
 * 값은 전부 선택이고 기본값이 스파이크 원본이다 — 생략하면 3.2·3.3·3.4 프레임 그대로다.
 * 실제 시계로 도는 하네스(서버 가짜 Gateway)는 시각·제목·툴을 자기 값으로 덮어 쓴다.
 */
type ApprovalOpts = FrameOpts & {
  id?: string;
  title?: string;
  toolName?: string;
  toolCallId?: string;
  allowedDecisions?: string[];
  createdAtMs?: number;
  expiresAtMs?: number;
  resolvedAtMs?: number;
};

/** `plugin.approval.requested`·`plugin.approval.resolved` 가 함께 싣는 `request` 블록(3.2). */
function approvalRequest(o: ApprovalOpts) {
  const c = common(o);
  return {
    pluginId: "claude-cli",
    title: o.title ?? "claude-cli native tool: Write",
    description: APPROVAL_ARGS,
    scope: null,
    detail: APPROVAL_ARGS,
    severity: "warning",
    toolName: o.toolName ?? "Write",
    toolCallId: o.toolCallId ?? APPROVAL_TOOL_CALL_ID,
    allowedDecisions: o.allowedDecisions ?? ["allow-once", "deny"],
    agentId: c.agentId,
    sessionKey: c.sessionKey,
    runId: null, // 승인 페이로드에 런 id 는 오지 않는다(3.2)
    turnSourceChannel: null,
    turnSourceTo: null,
    turnSourceAccountId: null,
    turnSourceThreadId: null,
  };
}

export function pluginApprovalRequested(o: ApprovalOpts = {}): EventFrame {
  return frame(
    "plugin.approval.requested",
    {
      approvalKind: "plugin",
      id: o.id ?? APPROVAL_ID,
      request: approvalRequest(o),
      createdAtMs: o.createdAtMs ?? APPROVAL_CREATED_MS,
      expiresAtMs: o.expiresAtMs ?? APPROVAL_EXPIRES_MS,
    },
    common(o).seq,
  );
}

/** 만료는 `decision:"deny"` + `resolvedBy:null` 로 온다(5.2). */
export function pluginApprovalResolved(
  o: ApprovalOpts & { decision?: string; resolvedBy?: string | null } = {},
): EventFrame {
  return frame(
    "plugin.approval.resolved",
    {
      id: o.id ?? APPROVAL_ID,
      decision: o.decision ?? "allow-once",
      resolvedBy: o.resolvedBy === undefined ? "dodok" : o.resolvedBy,
      ts: o.resolvedAtMs ?? APPROVAL_RESOLVED_MS,
      request: approvalRequest(o),
    },
    common(o).seq,
  );
}

/** `session.approval`·`approvalReplay` 가 함께 싣는 승인 스냅샷(3.3·5.3). `presentation` 에는 `toolCallId` 가 없다. */
function approvalSnapshot(
  o: ApprovalOpts & { phase?: "pending" | "terminal"; status?: string; decision?: string; reason?: string },
) {
  const c = common(o);
  const id = o.id ?? APPROVAL_ID;
  const terminal = (o.phase ?? "pending") === "terminal";
  return {
    id,
    status: o.status ?? (terminal ? "allowed" : "pending"),
    presentation: {
      kind: "plugin",
      title: o.title ?? "claude-cli native tool: Write",
      description: APPROVAL_ARGS,
      detail: APPROVAL_ARGS,
      severity: "warning",
      pluginId: "claude-cli",
      toolName: o.toolName ?? "Write",
      agentId: c.agentId,
      allowedDecisions: o.allowedDecisions ?? ["allow-once", "deny"],
    },
    urlPath: `/approve/${encodeURIComponent(id)}`,
    createdAtMs: o.createdAtMs ?? APPROVAL_CREATED_MS,
    expiresAtMs: o.expiresAtMs ?? APPROVAL_EXPIRES_MS,
    ...(terminal
      ? {
          resolvedAtMs: o.resolvedAtMs ?? APPROVAL_RESOLVED_MS,
          reason: o.reason ?? "user",
          decision: o.decision ?? "allow-once",
        }
      : {}),
  };
}

/** 세션 구독(`includeApprovals`)에만 온다(3.3). */
export function sessionApproval(
  o: ApprovalOpts & {
    phase?: "pending" | "terminal";
    status?: string;
    decision?: string;
    reason?: string;
  } = {},
): EventFrame {
  const c = common(o);
  return frame(
    "session.approval",
    {
      sessionKey: c.sessionKey,
      sourceSessionKey: c.sessionKey,
      updatedAtMs: (o.phase ?? "pending") === "terminal" ? APPROVAL_RESOLVED_MS : APPROVAL_CREATED_MS,
      phase: o.phase ?? "pending",
      approval: approvalSnapshot(o),
    },
    c.seq,
  );
}

/**
 * `sessions.messages.subscribe({ includeApprovals: true })` 응답(5.3). 미해결 승인만 담기고
 * 1000건을 넘으면 `truncated: true`. 각 항목은 `session.approval` 의 승인 스냅샷 + `sourceSessionKey`.
 */
export function approvalSubscribeResult(
  o: ApprovalOpts & { ids?: string[]; truncated?: boolean } = {},
): Record<string, unknown> {
  const c = common(o);
  const ids = o.ids ?? [o.id ?? APPROVAL_ID];
  return {
    subscribed: true,
    key: c.sessionKey,
    approvalReplay: {
      sessionKey: c.sessionKey,
      updatedAtMs: APPROVAL_CREATED_MS,
      approvals: ids.map((id) => ({ ...approvalSnapshot({ ...o, id }), sourceSessionKey: c.sessionKey })),
      truncated: o.truncated ?? false,
    },
  };
}

/** `approval.resolve` 응답(4.1). terminal 스냅샷에 `source`·`resolver` 가 더 붙는다. */
export function approvalResolveResult(
  o: ApprovalOpts & { applied?: boolean; status?: string; decision?: string; reason?: string } = {},
): Record<string, unknown> {
  const c = common(o);
  return {
    applied: o.applied ?? true,
    approval: {
      ...approvalSnapshot({ ...o, phase: "terminal" }),
      source: { agentId: c.agentId, sessionKey: c.sessionKey },
      resolver: { kind: "device", id: "fixture-device" },
    },
  };
}
