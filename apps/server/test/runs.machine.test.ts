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
  // tool_start
  ["queued", false, { kind: "tool_start" }, "tool"],
  ["streaming", false, { kind: "tool_start" }, "tool"],
  ["tool", false, { kind: "tool_start" }, "tool"],
  ["awaiting_approval", false, { kind: "tool_start" }, null],
  ["finalizing", false, { kind: "tool_start" }, null],
  // tool_end
  ["tool", false, { kind: "tool_end", openTools: 0 }, "streaming"],
  ["tool", false, { kind: "tool_end", openTools: 1 }, "tool"],
  ["streaming", false, { kind: "tool_end", openTools: 0 }, null],
  // approval
  ["queued", false, { kind: "approval_requested" }, "awaiting_approval"],
  ["streaming", false, { kind: "approval_requested" }, "awaiting_approval"],
  ["tool", false, { kind: "approval_requested" }, "awaiting_approval"],
  ["finalizing", false, { kind: "approval_requested" }, null],
  ["awaiting_approval", false, { kind: "approval_resolved" }, "streaming"],
  ["streaming", false, { kind: "approval_resolved" }, null],
  // gateway_final
  ["queued", false, { kind: "gateway_final" }, "finalizing"],
  ["streaming", false, { kind: "gateway_final" }, "finalizing"],
  ["streaming", true, { kind: "gateway_final" }, "done", { finalSource: "plugin" }],
  ["tool", true, { kind: "gateway_final" }, "done", { finalSource: "plugin" }],
  ["awaiting_approval", true, { kind: "gateway_final" }, "done", { finalSource: "plugin" }],
  ["finalizing", false, { kind: "gateway_final" }, null],
  // canonical_received
  ["queued", false, { kind: "canonical_received" }, "queued", { hasCanonical: true }],
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
  // final_timeout
  ["finalizing", false, { kind: "final_timeout" }, "done", { finalSource: "gateway" }],
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
