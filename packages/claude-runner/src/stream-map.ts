import type { ErrorCode, RunEventBody } from "@dodok/shared";
import { NO_MASK, type PathMasker } from "./mask";
import type { SdkMessage } from "./sdk";

// SDK 스트림 → RunEvent. 대응표의 정본은 ADR 0007 「설계에 주는 제약과 추천」 4 의 `RunEvent` 대응 표 —
// 여기서 달라진 것만 적는다:
// - 도구 인자는 델타마다가 아니라 블록이 끝날 때 한 번에 낸다(OpenClaw 경로도 인자를 한 번에 싣는다). 델타 조각에
//   걸친 호스트 경로를 가리려면 전체 글이 있어야 한다
// - 러너는 수명 변형(RUN_*)을 내지 않는다(조율자 판정 R1) — interrupt 로 끝난 턴은 `final`(text 빈 글·stopReason
//   "aborted"), result 의 오류는 `error`(run.error)로. 러너 어댑터가 run.event 의 수명 변형을 허용 목록으로 거른다(태스크 3)
// - 답 글 델타는 마지막 공백 뒤 꼬리를 쥐었다가 다음 델타·블록 끝에서 가려 낸다 — 델타 둘에 걸친 경로를 가리려면
//   이어 붙여야 한다(mask.ts safeCut)
// - 서브에이전트 안(parent_tool_use_id 가 있는) 스트림은 본 답 버블에 섞이지 않게 버린다

/** interrupt 로 끝난 런의 final — 어댑터가 메시지 없는 중지로 닫는다(판정 R1) */
export const ABORTED_STOP_REASON = "aborted";

/** 도구 결과는 OpenClaw 경로(openclaw-adapter gateway/events.ts TOOL_RESULT_MAX)와 같은 길이로 자른다 */
export const TOOL_RESULT_MAX = 2000;
const ERROR_MESSAGE_MAX = 2000;

/** 그 프롬프트 턴의 result — 런 비용(costUsd)은 세션 누적값의 차이라 run.ts 가 계산한다 */
export type RunnerRunFinalBody = {
  text: string;
  stopReason: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  totalCostUsd?: number;
};

export type MapItem = {
  event?: RunEventBody;
  final?: RunnerRunFinalBody;
  error?: { code: ErrorCode; message: string };
};

// 로그인이 안 됐거나 풀린 CLI 가 내는 글. 표지가 있으면 PROVIDER_AUTH(카드 문구 「러너의 Claude 로그인을 확인하세요」)
const AUTH_FAILURE =
  /authentication[_ ]failed|not logged in|invalid api key|please run \/login|oauth token has expired|\b401\b/i;
export const isAuthFailureText = (text: string): boolean => AUTH_FAILURE.test(text);

type Block =
  | { kind: "text"; pending: string }
  | { kind: "tool"; id: string; args: string }
  | { kind: "other" };

// SDK 메시지 유니온은 크고 판본마다 필드가 는다 — 쓰는 필드만 느슨하게 읽는다
type Loose = {
  type?: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  error?: string;
  event?: {
    type?: string;
    index?: number;
    message?: { id?: string };
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string };
  };
  message?: { content?: unknown };
  // result
  is_error?: boolean;
  num_turns?: number;
  result?: string;
  stop_reason?: string | null;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  errors?: string[];
};

function toolResultText(content: unknown, mask: PathMasker): string {
  if (typeof content === "string") return mask(content);
  if (!Array.isArray(content))
    return content === undefined || content === null ? "" : JSON.stringify(mask.value(content));
  return content
    .map((b: { type?: string; text?: string }) =>
      b?.type === "text" ? mask(b.text ?? "") : `[${b?.type ?? "?"}]`,
    )
    .join("\n");
}

// result.usage 는 그 턴 API 호출의 합(ADR 0007 4.8) — 입력은 캐시 쓰기·읽기까지 더한 처리량
function usageOf(u: Loose["usage"]): RunnerRunFinalBody["usage"] {
  if (!u) return undefined;
  const inputTokens =
    u.input_tokens === undefined
      ? undefined
      : u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return { inputTokens, outputTokens: u.output_tokens };
}

function finalOf(r: Loose, text: string, stopReason: string): RunnerRunFinalBody {
  const usage = usageOf(r.usage);
  return {
    text,
    stopReason,
    ...(usage ? { usage } : {}),
    ...(typeof r.total_cost_usd === "number" ? { totalCostUsd: r.total_cost_usd } : {}),
  };
}

export function createStreamMapper(
  now: () => number,
  opts: { runId: string; mask?: PathMasker },
): { map(m: SdkMessage): MapItem[]; markInterrupted(): void } {
  const { runId } = opts;
  const mask = opts.mask ?? NO_MASK;
  let messageId = "";
  let textStarted = false;
  let blocks = new Map<number, Block>();
  const toolStartedAt = new Map<string, number>();
  let interrupted = false;
  let authFailed = false;

  const errorItem = (code: ErrorCode, message: string): MapItem => ({
    error: { code, message: mask(message).slice(0, ERROR_MESSAGE_MAX) },
  });

  const content = (delta: string): MapItem[] =>
    delta ? [{ event: { type: "TEXT_MESSAGE_CONTENT", runId, messageId, delta } }] : [];

  // 쥔 꼬리를 모두 가려 낸다 — 블록 끝·API 메시지 끝
  function flushText(): MapItem[] {
    const out: MapItem[] = [];
    for (const b of blocks.values()) {
      if (b.kind !== "text" || !b.pending) continue;
      out.push(...content(mask(b.pending)));
      b.pending = "";
    }
    return out;
  }

  function mapStream(e: NonNullable<Loose["event"]>): MapItem[] {
    switch (e.type) {
      case "message_start":
        messageId = e.message?.id ?? "";
        textStarted = false;
        blocks = new Map();
        return [];
      case "content_block_start": {
        const b = e.content_block;
        const index = e.index ?? -1;
        if (b?.type === "text") {
          blocks.set(index, { kind: "text", pending: "" });
          if (textStarted) return [];
          textStarted = true;
          return [{ event: { type: "TEXT_MESSAGE_START", runId, messageId, role: "assistant" } }];
        }
        if (b?.type === "tool_use" && b.id) {
          blocks.set(index, { kind: "tool", id: b.id, args: "" });
          toolStartedAt.set(b.id, now());
          return [
            {
              event: {
                type: "TOOL_CALL_START",
                runId,
                toolCallId: b.id,
                toolCallName: b.name ?? "",
                ...(messageId ? { parentMessageId: messageId } : {}),
              },
            },
          ];
        }
        blocks.set(index, { kind: "other" });
        return [];
      }
      case "content_block_delta": {
        const block = blocks.get(e.index ?? -1);
        const d = e.delta;
        if (block?.kind === "text" && d?.type === "text_delta" && d.text) {
          const text = block.pending + d.text;
          const cut = mask.safeCut(text);
          block.pending = text.slice(cut);
          return content(mask(text.slice(0, cut)));
        }
        if (block?.kind === "tool" && d?.type === "input_json_delta") block.args += d.partial_json ?? "";
        return [];
      }
      case "content_block_stop": {
        const block = blocks.get(e.index ?? -1);
        if (block?.kind === "text") {
          const out = content(mask(block.pending));
          block.pending = "";
          return out;
        }
        if (block?.kind !== "tool") return [];
        return [
          ...(block.args
            ? [
                {
                  event: {
                    type: "TOOL_CALL_ARGS",
                    runId,
                    toolCallId: block.id,
                    delta: mask.json(block.args),
                  },
                } as const,
              ]
            : []),
          { event: { type: "TOOL_CALL_END", runId, toolCallId: block.id } },
        ];
      }
      case "message_stop": {
        if (!textStarted) return [];
        textStarted = false;
        return [...flushText(), { event: { type: "TEXT_MESSAGE_END", runId, messageId } }];
      }
      default:
        return [];
    }
  }

  function mapToolResults(content: unknown): MapItem[] {
    if (!Array.isArray(content)) return [];
    const out: MapItem[] = [];
    for (const b of content as Array<{
      type?: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>) {
      if (b?.type !== "tool_result" || !b.tool_use_id) continue;
      const started = toolStartedAt.get(b.tool_use_id);
      toolStartedAt.delete(b.tool_use_id);
      out.push({
        event: {
          type: "TOOL_CALL_RESULT",
          runId,
          toolCallId: b.tool_use_id,
          content: toolResultText(b.content, mask).slice(0, TOOL_RESULT_MAX),
          ok: !b.is_error,
          ...(started === undefined ? {} : { durationMs: Math.max(0, Math.round(now() - started)) }),
        },
      });
    }
    return out;
  }

  function mapResult(r: Loose): MapItem[] {
    // resume 직후 앞 프로세스의 백그라운드 셸 알림과 함께 프롬프트와 무관한 빈 result 가 먼저 온다(ADR 0007 4.3) —
    // 런의 끝으로 읽으면 답이 비고 진짜 턴이 버려진다
    if (r.subtype === "success" && r.num_turns === 0) return [];
    if (r.subtype === "success") {
      // API 오류로 끝난 턴도 success 로 온다 — result 가 오류 글이다
      if (r.is_error) {
        const text = r.result ?? "";
        return [
          errorItem(authFailed || isAuthFailureText(text) ? "PROVIDER_AUTH" : "INTERNAL", text || "error"),
        ];
      }
      return [{ final: finalOf(r, mask(r.result ?? ""), r.stop_reason ?? "end_turn") }];
    }
    if (interrupted && r.subtype === "error_during_execution") {
      return [{ final: finalOf(r, "", ABORTED_STOP_REASON) }];
    }
    const text = (r.errors ?? []).join("; ") || r.subtype || "error";
    return [errorItem(authFailed || isAuthFailureText(text) ? "PROVIDER_AUTH" : "INTERNAL", text)];
  }

  return {
    markInterrupted: () => {
      interrupted = true;
    },
    map(m) {
      const x = m as unknown as Loose;
      if (x.parent_tool_use_id) return [];
      switch (x.type) {
        case "stream_event":
          return x.event ? mapStream(x.event) : [];
        case "user":
          return mapToolResults(x.message?.content);
        case "assistant":
          if (x.error === "authentication_failed") authFailed = true;
          return [];
        case "result":
          return mapResult(x);
        default:
          // system/*(thinking_tokens·status·init…)·tool_progress·rate_limit_event 등은 버린다(스펙 4.3)
          return [];
      }
    },
  };
}
