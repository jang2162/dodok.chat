import type { Run, RunStatus } from "@dodok/shared";

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

export type RunPatch = Partial<Pick<Run, "hasCanonical" | "finalSource" | "error">>;

export type Transition = { next: RunStatus; patch: RunPatch } | { next: null; reason: "ignored" | "invalid" };

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "error", "aborted"]);
const ACTIVE: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "queued",
  "streaming",
  "tool",
  "awaiting_approval",
]);
const IGNORED: Transition = { next: null, reason: "ignored" };

function go(next: RunStatus, patch: RunPatch = {}): Transition {
  return { next, patch };
}

/**
 * 스펙 5.1 전이 표. 순수 함수 — 시각(startedAt/endedAt)과 저장은 호출자가 처리한다.
 * 표에 없는 조합은 ignored.
 */
export function transition(run: Pick<Run, "status" | "hasCanonical">, s: RunSignal): Transition {
  const st = run.status;
  if (TERMINAL_STATUSES.has(st)) return IGNORED;

  switch (s.kind) {
    case "gateway_started":
    case "text_delta":
      if (st === "queued" || st === "streaming") return go("streaming");
      if (st === "tool") return go("tool");
      return IGNORED;
    case "tool_start":
      if (st === "queued" || st === "streaming" || st === "tool") return go("tool");
      return IGNORED;
    case "tool_end":
      if (st !== "tool") return IGNORED;
      return s.openTools === 0 ? go("streaming") : go("tool");
    case "approval_requested":
      if (st === "queued" || st === "streaming" || st === "tool") return go("awaiting_approval");
      return IGNORED;
    case "approval_resolved":
      return st === "awaiting_approval" ? go("streaming") : IGNORED;
    case "gateway_final":
      if (!ACTIVE.has(st)) return IGNORED;
      return run.hasCanonical ? go("done", { finalSource: "plugin" }) : go("finalizing");
    case "canonical_received":
      if (ACTIVE.has(st)) return go(st, { hasCanonical: true });
      if (st === "finalizing") return go("done", { hasCanonical: true, finalSource: "plugin" });
      return IGNORED;
    case "final_timeout":
      return st === "finalizing" ? go("done", { finalSource: "gateway" }) : IGNORED;
    case "gateway_error":
      return go("error", { error: { code: s.code, message: s.message } });
    case "queue_timeout":
      return st === "queued"
        ? go("error", { error: { code: "TIMEOUT", message: "queued timeout" } })
        : IGNORED;
    case "run_timeout":
      return go("error", { error: { code: "TIMEOUT", message: "run timeout" } });
    case "gateway_aborted":
    case "abort_requested":
      return go("aborted");
  }
}
