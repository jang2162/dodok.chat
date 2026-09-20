import { describe, expect, it } from "vitest";
import { RUN_EVENT_TYPES, RunEvent } from "../src/events";

const RUN = "01a09fc9-d204-7551-89d6-38544d07a101";
const AP = "01a09fc9-d204-7551-89d6-38544d07a105";
const base = { runId: RUN, seq: 1, ts: "2026-09-14T00:00:00Z" };

describe("RunEvent", () => {
  it("이벤트 종류 목록", () => {
    expect(RUN_EVENT_TYPES).toEqual([
      "RUN_QUEUED",
      "RUN_STARTED",
      "RUN_FINISHED",
      "RUN_ERROR",
      "RUN_ABORTED",
      "STATE_SNAPSHOT",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_REPLACE",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "STEP_STARTED",
      "STEP_FINISHED",
      "SUBAGENT_STARTED",
      "SUBAGENT_FINISHED",
      "SUBAGENT_ERROR",
      "APPROVAL_REQUESTED",
      "APPROVAL_RESOLVED",
      "CUSTOM",
    ]);
  });

  it.each([
    { type: "RUN_QUEUED" },
    {
      type: "RUN_STARTED",
      threadId: "01a09fc9-d204-7551-89d6-38544d07a102",
      agentId: "01a09fc9-d204-7551-89d6-38544d07a103",
      sessionKey: "agent:x:dodok:channel:y",
    },
    { type: "RUN_FINISHED", messageIds: [] },
    { type: "RUN_ERROR", message: "boom" },
    { type: "RUN_ABORTED", by: "user" },
    { type: "TEXT_MESSAGE_START", messageId: "gw-1", role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "gw-1", delta: "안녕" },
    { type: "TEXT_MESSAGE_REPLACE", messageId: "gw-1", text: "전체" },
    { type: "TEXT_MESSAGE_END", messageId: "gw-1" },
    { type: "TOOL_CALL_START", toolCallId: "t1", toolCallName: "exec" },
    { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: "{" },
    { type: "TOOL_CALL_END", toolCallId: "t1" },
    { type: "TOOL_CALL_RESULT", toolCallId: "t1", content: "ok", ok: true, durationMs: 12 },
    { type: "STEP_STARTED", stepName: "compact" },
    { type: "STEP_FINISHED", stepName: "compact" },
    { type: "SUBAGENT_STARTED", subagentRunId: "01a09fc9-d204-7551-89d6-38544d07a104" },
    { type: "SUBAGENT_FINISHED", subagentRunId: "01a09fc9-d204-7551-89d6-38544d07a104" },
    { type: "SUBAGENT_ERROR", subagentRunId: "01a09fc9-d204-7551-89d6-38544d07a104", message: "x" },
    {
      // 승인 스파이크 3.2 의 원본 프레임 값
      type: "APPROVAL_REQUESTED",
      approvalId: AP,
      kind: "plugin",
      title: "claude-cli native tool: Write",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      toolCallId: "toolu_018ohZoiNMZwidAe7fWsWSam",
      expiresAt: "2026-09-20T09:51:47.988Z",
    },
    { type: "APPROVAL_RESOLVED", approvalId: AP, decision: "allow-once", reason: "user" },
    { type: "CUSTOM", name: "openclaw.agent.lifecycle", value: { phase: "start" } },
    { type: "CUSTOM", name: "openclaw.agent.lifecycle" },
  ])("$type 파싱", (payload) => {
    expect(RunEvent.safeParse({ ...base, ...payload }).success).toBe(true);
  });

  it("STATE_SNAPSHOT은 RunState를 담는다", () => {
    const snapshot = {
      id: RUN,
      channelId: "01a09fc9-d204-7551-89d6-38544d07a102",
      agentId: "01a09fc9-d204-7551-89d6-38544d07a103",
      status: "streaming",
      relayDepth: 0,
      hasCanonical: false,
    };
    expect(RunEvent.safeParse({ ...base, type: "STATE_SNAPSHOT", snapshot }).success).toBe(true);
  });

  it("APPROVAL_RESOLVED 는 decision 과 reason 을 함께 싣는다(만료는 deny + timeout)", () => {
    const e = RunEvent.parse({
      ...base,
      type: "APPROVAL_RESOLVED",
      approvalId: AP,
      decision: "deny",
      reason: "timeout",
    });
    expect(e.type === "APPROVAL_RESOLVED" && e.reason).toBe("timeout");
  });

  it("승인 이벤트는 옛 결정 값과 빠진 필드를 거부한다", () => {
    const resolved = { ...base, type: "APPROVAL_RESOLVED", approvalId: AP };
    expect(RunEvent.safeParse({ ...resolved, decision: "approved", reason: "user" }).success).toBe(false);
    expect(RunEvent.safeParse({ ...resolved, decision: "deny" }).success).toBe(false); // reason 필수
    const requested = {
      ...base,
      type: "APPROVAL_REQUESTED",
      approvalId: AP,
      kind: "plugin",
      title: "claude-cli native tool: Write",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
    };
    expect(RunEvent.safeParse(requested).success).toBe(false); // expiresAt 필수
    expect(
      RunEvent.safeParse({ ...requested, expiresAt: "2026-09-20T09:51:47.988Z", allowedDecisions: [] })
        .success,
    ).toBe(false);
  });

  it("모르는 type, seq 0, 빈 delta는 거부", () => {
    expect(RunEvent.safeParse({ ...base, type: "NOPE" }).success).toBe(false);
    expect(RunEvent.safeParse({ ...base, seq: 0, type: "RUN_QUEUED" }).success).toBe(false);
    expect(
      RunEvent.safeParse({ ...base, type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "" }).success,
    ).toBe(false);
  });
});
