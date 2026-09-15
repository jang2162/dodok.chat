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
    __openclaw: { id: "fixture-message-id", seq: 4 },
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
