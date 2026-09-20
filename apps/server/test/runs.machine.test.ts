import type { RunStatus } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { type RunPatch, type RunSignal, TERMINAL_STATUSES, transition } from "../src/modules/runs/machine";

type Case = [
  status: RunStatus,
  hasCanonical: boolean,
  signal: RunSignal,
  next: RunStatus | null,
  patch?: RunPatch,
];

const cases: Case[] = [
  // gateway_started / text_delta
  ["queued", false, { kind: "gateway_started" }, "streaming"],
  ["queued", false, { kind: "text_delta" }, "streaming"],
  ["streaming", false, { kind: "text_delta" }, "streaming"],
  ["tool", false, { kind: "text_delta" }, "tool"],
  ["awaiting_approval", false, { kind: "text_delta" }, null],
  ["finalizing", false, { kind: "text_delta" }, null],
  // 정본으로 finalizing 에 간 뒤 늦게 온 Gateway 시작·델타는 상태를 되돌리지 않는다
  ["finalizing", true, { kind: "gateway_started" }, null],
  ["finalizing", true, { kind: "text_delta" }, null],
  // tool_start
  ["queued", false, { kind: "tool_start" }, "tool"],
  ["streaming", false, { kind: "tool_start" }, "tool"],
  ["tool", false, { kind: "tool_start" }, "tool"],
  ["awaiting_approval", false, { kind: "tool_start" }, null],
  ["finalizing", false, { kind: "tool_start" }, null],
  ["finalizing", true, { kind: "tool_start" }, null],
  // tool_end
  ["tool", false, { kind: "tool_end", openTools: 0 }, "streaming"],
  ["tool", false, { kind: "tool_end", openTools: 1 }, "tool"],
  ["streaming", false, { kind: "tool_end", openTools: 0 }, null],
  // approval
  ["queued", false, { kind: "approval_requested" }, "awaiting_approval"],
  ["streaming", false, { kind: "approval_requested" }, "awaiting_approval"],
  ["tool", false, { kind: "approval_requested" }, "awaiting_approval"],
  ["finalizing", false, { kind: "approval_requested" }, null],
  ["finalizing", true, { kind: "approval_requested" }, null],
  // decision 은 아직 전이를 가르지 않는다 — 거절도 런은 툴 오류로 이어진다(스파이크 4.3)
  ["awaiting_approval", false, { kind: "approval_resolved", decision: "allow-once" }, "streaming"],
  ["awaiting_approval", false, { kind: "approval_resolved", decision: "deny" }, "streaming"],
  ["streaming", false, { kind: "approval_resolved", decision: "allow-once" }, null],
  // gateway_final
  ["queued", false, { kind: "gateway_final" }, "finalizing"],
  ["streaming", false, { kind: "gateway_final" }, "finalizing"],
  ["streaming", true, { kind: "gateway_final" }, "done", { finalSource: "plugin" }],
  ["tool", true, { kind: "gateway_final" }, "done", { finalSource: "plugin" }],
  ["awaiting_approval", true, { kind: "gateway_final" }, "done", { finalSource: "plugin" }],
  ["finalizing", false, { kind: "gateway_final" }, null],
  // 정본이 먼저 와 finalizing 에 있으면 final 이 곧 끝 — 10s 를 기다리지 않는다(Phase 1 실연)
  ["finalizing", true, { kind: "gateway_final" }, "done", { finalSource: "plugin" }],
  // canonical_received — queued 에서는 Gateway 이벤트 없이 정본이 먼저 온 것(구독 누락·WS 단절)
  ["queued", false, { kind: "canonical_received" }, "finalizing", { hasCanonical: true }],
  ["streaming", false, { kind: "canonical_received" }, "streaming", { hasCanonical: true }],
  ["tool", false, { kind: "canonical_received" }, "tool", { hasCanonical: true }],
  ["awaiting_approval", false, { kind: "canonical_received" }, "awaiting_approval", { hasCanonical: true }],
  [
    "finalizing",
    false,
    { kind: "canonical_received" },
    "done",
    { hasCanonical: true, finalSource: "plugin" },
  ],
  ["finalizing", true, { kind: "canonical_received" }, "done", { hasCanonical: true, finalSource: "plugin" }],
  // final_timeout
  ["finalizing", false, { kind: "final_timeout" }, "done", { finalSource: "gateway" }],
  ["finalizing", true, { kind: "final_timeout" }, "done", { finalSource: "plugin" }],
  ["streaming", false, { kind: "final_timeout" }, null],
  // errors
  [
    "streaming",
    false,
    { kind: "gateway_error", code: "provider", message: "x" },
    "error",
    { error: { code: "provider", message: "x" } },
  ],
  [
    "finalizing",
    false,
    { kind: "gateway_error", code: "provider", message: "x" },
    "error",
    { error: { code: "provider", message: "x" } },
  ],
  [
    "queued",
    false,
    { kind: "queue_timeout" },
    "error",
    { error: { code: "TIMEOUT", message: "queued timeout" } },
  ],
  ["streaming", false, { kind: "queue_timeout" }, null],
  ["tool", false, { kind: "run_timeout" }, "error", { error: { code: "TIMEOUT", message: "run timeout" } }],
  [
    "finalizing",
    false,
    { kind: "run_timeout" },
    "error",
    { error: { code: "TIMEOUT", message: "run timeout" } },
  ],
  // abort
  ["queued", false, { kind: "abort_requested" }, "aborted"],
  ["streaming", false, { kind: "abort_requested" }, "aborted"],
  ["finalizing", false, { kind: "gateway_aborted" }, "aborted"],
  ["finalizing", true, { kind: "abort_requested" }, "aborted"],
  [
    "finalizing",
    true,
    { kind: "gateway_error", code: "provider", message: "x" },
    "error",
    { error: { code: "provider", message: "x" } },
  ],
  // terminal: 모두 무시
  ["done", false, { kind: "text_delta" }, null],
  ["done", false, { kind: "canonical_received" }, null],
  ["error", false, { kind: "gateway_final" }, null],
  ["aborted", false, { kind: "gateway_error", code: "x", message: "y" }, null],
];

describe("transition", () => {
  it.each(cases)("%s (hasCanonical=%s) + %o → %s", (status, hasCanonical, signal, next, patch) => {
    const t = transition({ status, hasCanonical }, signal);
    if (next === null) {
      expect(t).toEqual({ next: null, reason: "ignored" });
    } else {
      expect(t.next).toBe(next);
      if (t.next !== null) expect(t.patch).toEqual(patch ?? {});
    }
  });

  it("종료 상태 집합", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["aborted", "done", "error"]);
  });
});
