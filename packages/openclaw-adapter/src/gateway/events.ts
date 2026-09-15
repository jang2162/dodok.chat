import type { RunSignal } from "@dodok/shared";
import type { EventFrame } from "@openclaw/gateway-protocol";
import { z } from "zod";
import type { RunEventBody } from "../adapter-types";

// 계약 스펙 6.1 / 서버 코어 스펙 6.2 — Gateway EventFrame 하나를 RunEvent 본문·RunSignal 로 바꾸는 순수 매퍼.
// 실물 모양은 ADR 0001 6.3·6.5. 네트워크 없음. RUN_STARTED 는 오케스트레이터가 gateway_started 전이 때
// 런 행으로 만든다(Gateway agentId 는 providerAgentId 라 RunEvent 의 Id 가 아니다).

/** 항목마다 event 나 signal 중 하나만 싣는다. snapshotText 는 gateway_final 항목에만 있다. */
export type MappedEvent = { runId: string; event?: RunEventBody; signal?: RunSignal; snapshotText?: string };

export type GatewayEventMapper = { map(frame: EventFrame): MappedEvent[] };

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

  function mapChat(payload: unknown): MappedEvent[] {
    const parsed = ChatPayload.safeParse(payload);
    if (!parsed.success || !opts.isOurRun(parsed.data.runId)) return [];
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
        runs.delete(runId);
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
        runs.delete(runId);
        break;
      }
      case "aborted":
        out.push(
          { runId, event: { type: "RUN_ABORTED", runId, by: "gateway" } },
          { runId, signal: { kind: "gateway_aborted" } },
        );
        runs.delete(runId);
        break;
    }
    return out;
  }

  function mapAgent(payload: unknown): MappedEvent[] {
    const parsed = AgentPayload.safeParse(payload);
    if (!parsed.success || !opts.isOurRun(parsed.data.runId)) return [];
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
    const key = message.idempotencyKey;
    const runId =
      key?.startsWith(USAGE_KEY_PREFIX) && key.length > USAGE_KEY_PREFIX.length
        ? key.slice(USAGE_KEY_PREFIX.length)
        : parsed.data.runId;
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
  };
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
