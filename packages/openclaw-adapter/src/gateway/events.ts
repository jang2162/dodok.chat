import type { RunSignal } from "@dodok/shared";
import type { EventFrame } from "@openclaw/gateway-protocol";
import { z } from "zod";
import type { RunEventBody } from "../adapter-types";

// 계약 스펙 6.1 / 서버 코어 스펙 6.2 — Gateway EventFrame 하나를 RunEvent 본문·RunSignal 로 바꾸는 순수 매퍼.
// 실물 모양은 ADR 0001 6.3·6.5. 네트워크 없음. RUN_STARTED 는 오케스트레이터가 gateway_started 전이 때
// 런 행으로 만든다(Gateway agentId 는 providerAgentId 라 RunEvent 의 Id 가 아니다).

/** 항목마다 event 나 signal 중 하나만 싣는다. snapshotText 는 gateway_final 항목에만 있다. */
export type MappedEvent = { runId: string; event?: RunEventBody; signal?: RunSignal; snapshotText?: string };

export type GatewayEventMapper = {
  map(frame: EventFrame): MappedEvent[];
  /** 런 상태와 종료 표시를 지운다. 어댑터가 런을 잊을 때(`knownRunIds` 에서 뺄 때) 함께 부른다. */
  forget(runId: string): void;
};

const TOOL_RESULT_MAX = 2000;
const USAGE_KEY_PREFIX = "cli-assistant:";

// 외부 입력 — 우리가 읽는 필드만 좁게 파싱하고 나머지(세션 스냅샷 필드 등)는 통과시킨다.
const ChatCommon = { runId: z.string().min(1), sessionKey: z.string() };
const ChatPayload = z.discriminatedUnion("state", [
  z.looseObject({ state: z.literal("status"), ...ChatCommon, phase: z.string() }),
  z.looseObject({
    state: z.literal("delta"),
    ...ChatCommon,
    deltaText: z.string(),
    replace: z.boolean().optional(),
    message: z.unknown().optional(),
  }),
  z.looseObject({ state: z.literal("final"), ...ChatCommon, message: z.unknown().optional() }),
  z.looseObject({
    state: z.literal("error"),
    ...ChatCommon,
    errorMessage: z.string().optional(),
    errorKind: z.string().optional(),
    errorDetail: z.record(z.string(), z.unknown()).optional(),
  }),
  z.looseObject({ state: z.literal("aborted"), ...ChatCommon }),
]);

const AgentPayload = z.looseObject({
  runId: z.string().min(1),
  stream: z.string(),
  data: z.record(z.string(), z.unknown()),
});
const ToolData = z.looseObject({
  phase: z.string(),
  toolCallId: z.string().min(1),
  name: z.string().optional(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
  isError: z.boolean().optional(),
});
const LifecycleData = z.looseObject({ phase: z.string() });

const SessionMessagePayload = z.looseObject({
  runId: z.string().min(1).optional(),
  message: z.looseObject({
    role: z.string().optional(),
    model: z.string().optional(),
    idempotencyKey: z.string().optional(),
    __openclaw: z.looseObject({ runId: z.string().optional() }).optional(),
    usage: z
      .looseObject({
        input: z.number().optional(),
        output: z.number().optional(),
        cost: z.looseObject({ total: z.number().optional() }).optional(),
      })
      .optional(),
  }),
});

type RunTrack = { started: boolean; textStarted: boolean; openToolIds: Set<string> };

export function createGatewayEventMapper(opts: { isOurRun: (runId: string) => boolean }): GatewayEventMapper {
  const runs = new Map<string, RunTrack>();
  // chat final·error·aborted 를 본 런. forget 전까지 늦게 온 chat·agent 프레임이 gateway_started 를 다시 내거나
  // 툴 상태를 새로 만들지 않게 막는다. usage(session.message)는 final 과 순서가 정해져 있지 않아 막지 않는다.
  const ended = new Set<string>();

  function track(runId: string): RunTrack {
    let t = runs.get(runId);
    if (!t) {
      t = { started: false, textStarted: false, openToolIds: new Set() };
      runs.set(runId, t);
    }
    return t;
  }

  /** 런의 첫 lifecycle start 또는 첫 chat 이벤트에서 한 번만. */
  function markStarted(runId: string, out: MappedEvent[]) {
    const t = track(runId);
    if (t.started) return;
    t.started = true;
    out.push({ runId, signal: { kind: "gateway_started" } });
  }

  function end(runId: string) {
    runs.delete(runId);
    ended.add(runId);
  }

  function mapChat(payload: unknown): MappedEvent[] {
    const parsed = ChatPayload.safeParse(payload);
    if (!parsed.success || ended.has(parsed.data.runId) || !opts.isOurRun(parsed.data.runId)) return [];
    const p = parsed.data;
    const runId = p.runId;
    const out: MappedEvent[] = [];
    markStarted(runId, out);
    const t = track(runId);

    switch (p.state) {
      case "status":
        out.push({ runId, event: { type: "STEP_STARTED", runId, stepName: p.phase } });
        break;
      case "delta": {
        if (!p.replace && p.deltaText === "") break;
        // Gateway 델타에는 메시지 id 가 없어 runId 를 messageId 로 쓴다.
        if (!t.textStarted) {
          t.textStarted = true;
          out.push({
            runId,
            event: { type: "TEXT_MESSAGE_START", runId, messageId: runId, role: "assistant" },
          });
        }
        const event: RunEventBody = p.replace
          ? { type: "TEXT_MESSAGE_REPLACE", runId, messageId: runId, text: messageText(p.message) }
          : { type: "TEXT_MESSAGE_CONTENT", runId, messageId: runId, delta: p.deltaText };
        out.push({ runId, event }, { runId, signal: { kind: "text_delta" } });
        break;
      }
      case "final":
        if (t.textStarted) out.push({ runId, event: { type: "TEXT_MESSAGE_END", runId, messageId: runId } });
        out.push({ runId, signal: { kind: "gateway_final" }, snapshotText: messageText(p.message) });
        end(runId);
        break;
      case "error": {
        const code = p.errorKind ?? "unknown";
        const message = p.errorMessage ?? p.errorKind ?? "gateway error";
        out.push(
          {
            runId,
            event: {
              type: "RUN_ERROR",
              runId,
              message,
              code,
              ...(p.errorDetail ? { detail: p.errorDetail } : {}),
            },
          },
          { runId, signal: { kind: "gateway_error", code, message } },
        );
        end(runId);
        break;
      }
      case "aborted":
        out.push(
          { runId, event: { type: "RUN_ABORTED", runId, by: "gateway" } },
          { runId, signal: { kind: "gateway_aborted" } },
        );
        end(runId);
        break;
    }
    return out;
  }

  function mapAgent(payload: unknown): MappedEvent[] {
    const parsed = AgentPayload.safeParse(payload);
    if (!parsed.success || ended.has(parsed.data.runId) || !opts.isOurRun(parsed.data.runId)) return [];
    const { runId, stream, data } = parsed.data;

    if (stream === "lifecycle") {
      const lifecycle = LifecycleData.safeParse(data);
      if (!lifecycle.success) return [];
      const out: MappedEvent[] = [];
      if (lifecycle.data.phase === "start") markStarted(runId, out);
      if (lifecycle.data.phase === "end") {
        out.push({ runId, event: { type: "STEP_FINISHED", runId, stepName: "lifecycle" } });
      }
      return out;
    }
    if (stream !== "tool") return []; // assistant(chat delta 와 중복)·thinking·run_status 는 무시

    const tool = ToolData.safeParse(data);
    if (!tool.success) return [];
    const { phase, toolCallId } = tool.data;
    const open = track(runId).openToolIds;

    if (phase === "start") {
      open.add(toolCallId);
      return [
        { runId, event: { type: "TOOL_CALL_START", runId, toolCallId, toolCallName: tool.data.name ?? "" } },
        {
          runId,
          event: { type: "TOOL_CALL_ARGS", runId, toolCallId, delta: JSON.stringify(tool.data.args ?? {}) },
        },
        { runId, signal: { kind: "tool_start" } },
      ];
    }
    if (phase === "result") {
      // 모르는 toolCallId 면 Set 에 없으니 카운터가 내려가지 않는다(음수 없음).
      open.delete(toolCallId);
      const content = resultText(tool.data.result).slice(0, TOOL_RESULT_MAX);
      return [
        { runId, event: { type: "TOOL_CALL_RESULT", runId, toolCallId, content, ok: !tool.data.isError } },
        { runId, event: { type: "TOOL_CALL_END", runId, toolCallId } },
        { runId, signal: { kind: "tool_end", openTools: open.size } },
      ];
    }
    return [];
  }

  function mapSessionMessage(payload: unknown): MappedEvent[] {
    const parsed = SessionMessagePayload.safeParse(payload);
    if (!parsed.success) return [];
    const { message } = parsed.data;
    if (message.role !== "assistant" || !message.usage) return [];
    // OpenClaw 정규 순서: 전사 메타 runId → payload runId → idempotencyKey(`cli-assistant:` 접두사는 뗀다).
    const key = message.idempotencyKey;
    const keyRunId = key?.startsWith(USAGE_KEY_PREFIX) ? key.slice(USAGE_KEY_PREFIX.length) : key;
    const runId = message.__openclaw?.runId || parsed.data.runId || keyRunId;
    if (!runId || !opts.isOurRun(runId)) return [];
    const value = {
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      costUsd: message.usage.cost?.total,
      model: message.model,
    };
    return [{ runId, event: { type: "CUSTOM", runId, name: "openclaw.usage", value } }];
  }

  return {
    map(frame) {
      switch (frame.event) {
        case "chat":
          return mapChat(frame.payload);
        case "agent":
          return mapAgent(frame.payload);
        case "session.message":
          return mapSessionMessage(frame.payload);
        default:
          return []; // sessions.changed·node.*·health·tick 등 — 런이 없다
      }
    },
    forget(runId) {
      runs.delete(runId);
      ended.delete(runId);
    },
  };
}

const FrameRunId = z.looseObject({ runId: z.string().min(1).optional() });

/**
 * 프레임이 가리키는 런 id — 매퍼가 item 을 내지 않는 프레임(agent thinking·run_status·assistant, 빈 delta, 모르는 tool phase 등)도
 * 읽는다. 런이 살아 있는지 볼 때 쓴다(재접속 유예 시계). session.message 는 mapSessionMessage 와 같은 순서로 읽는다
 */
export function frameRunId(frame: EventFrame): string | undefined {
  if (frame.event === "chat" || frame.event === "agent") {
    const parsed = FrameRunId.safeParse(frame.payload);
    return parsed.success ? parsed.data.runId : undefined;
  }
  if (frame.event === "session.message") {
    const parsed = SessionMessagePayload.safeParse(frame.payload);
    if (!parsed.success) return undefined;
    const { message } = parsed.data;
    const key = message.idempotencyKey;
    const keyRunId = key?.startsWith(USAGE_KEY_PREFIX) ? key.slice(USAGE_KEY_PREFIX.length) : key;
    return message.__openclaw?.runId || parsed.data.runId || keyRunId || undefined;
  }
  return undefined;
}

/** message.content 의 text 조각을 이어 붙인다. 문자열 content 는 그대로. */
function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const { type, text: partText } = part as { type?: unknown; text?: unknown };
    if (type === "text" && typeof partText === "string") text += partText;
  }
  return text;
}

function resultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  return typeof result === "string" ? result : JSON.stringify(result);
}
