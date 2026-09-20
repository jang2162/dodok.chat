import type { Run, RunState } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { AGENT, CH, RUN, RUN2, runEvent, runState, textDelta, uid } from "../../../test/fixtures";
import {
  approvalOutcomeLabel,
  isTruncated,
  keepTimelineEvents,
  mergeRunEvents,
  mergeRuns,
  runDurationMs,
  toActivityRows,
  toolNameByCallId,
  UNKNOWN_TOOL,
} from "./timeline";

const APPROVAL = uid(301);
const SUB = uid(401);

describe("toActivityRows", () => {
  it("툴 호출은 시작·인자·결과·끝을 한 행으로 접는다", () => {
    const rows = toActivityRows([
      runEvent({ type: "TOOL_CALL_START", seq: 1, toolCallId: "t1", toolCallName: "Read" }),
      runEvent({ type: "TOOL_CALL_ARGS", seq: 2, toolCallId: "t1", delta: '{"path":' }),
      runEvent({ type: "TOOL_CALL_ARGS", seq: 3, toolCallId: "t1", delta: '"README.md"}' }),
      runEvent({
        type: "TOOL_CALL_RESULT",
        seq: 4,
        toolCallId: "t1",
        content: "ok",
        ok: true,
        durationMs: 12,
      }),
      runEvent({ type: "TOOL_CALL_END", seq: 5, toolCallId: "t1" }),
    ]);
    expect(rows).toEqual([
      {
        kind: "tool",
        key: "tool:t1",
        toolCallId: "t1",
        name: "Read",
        args: '{"path":"README.md"}',
        result: "ok",
        ok: true,
        durationMs: 12,
        state: "done",
      },
    ]);
  });

  it("끝나지 않은 툴은 running", () => {
    const rows = toActivityRows([
      runEvent({ type: "TOOL_CALL_START", seq: 1, toolCallId: "t1", toolCallName: "Write" }),
      runEvent({ type: "TOOL_CALL_ARGS", seq: 2, toolCallId: "t1", delta: "{}" }),
    ]);
    expect(rows).toEqual([
      { kind: "tool", key: "tool:t1", toolCallId: "t1", name: "Write", args: "{}", state: "running" },
    ]);
  });

  it("결과만 와도 끝난 것으로 본다(END 가 없는 경로)", () => {
    const rows = toActivityRows([
      runEvent({ type: "TOOL_CALL_START", seq: 1, toolCallId: "t1", toolCallName: "Read" }),
      runEvent({ type: "TOOL_CALL_RESULT", seq: 2, toolCallId: "t1", content: "boom", ok: false }),
    ]);
    expect(rows[0]).toMatchObject({ state: "done", ok: false, result: "boom" });
  });

  it("시작을 못 본 툴도 행으로 남는다(이름은 모름)", () => {
    const rows = toActivityRows([
      runEvent({ type: "TOOL_CALL_RESULT", seq: 7, toolCallId: "t9", content: "ok", ok: true }),
    ]);
    expect(rows).toEqual([
      {
        kind: "tool",
        key: "tool:t9",
        toolCallId: "t9",
        name: UNKNOWN_TOOL,
        result: "ok",
        ok: true,
        state: "done",
      },
    ]);
  });

  it("텍스트 델타는 행이 되지 않는다", () => {
    expect(
      toActivityRows([
        textDelta(1, "안녕"),
        runEvent({ type: "TEXT_MESSAGE_START", seq: 2, messageId: "m", role: "assistant" }),
        runEvent({ type: "TEXT_MESSAGE_REPLACE", seq: 3, messageId: "m", text: "다시" }),
        runEvent({ type: "TEXT_MESSAGE_END", seq: 4, messageId: "m" }),
        runEvent({ type: "RUN_QUEUED", seq: 5 }),
        runEvent({ type: "STATE_SNAPSHOT", seq: 6, snapshot: runState() }),
      ]),
    ).toEqual([]);
  });

  it("승인·단계·서브에이전트·오류는 순서대로 행이 된다", () => {
    const rows = toActivityRows([
      runEvent({ type: "STEP_STARTED", seq: 1, stepName: "계획" }),
      runEvent({ type: "TOOL_CALL_START", seq: 2, toolCallId: "t1", toolCallName: "Write" }),
      runEvent({
        type: "APPROVAL_REQUESTED",
        seq: 3,
        approvalId: APPROVAL,
        kind: "plugin",
        title: "Write 실행",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        toolCallId: "t1",
        expiresAt: "2027-01-15T08:02:00.000Z",
      }),
      runEvent({ type: "SUBAGENT_STARTED", seq: 4, subagentRunId: SUB, label: "조사" }),
      runEvent({ type: "RUN_ERROR", seq: 5, message: "Gateway 끊김", code: "GATEWAY" }),
      runEvent({ type: "STEP_FINISHED", seq: 6, stepName: "계획" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["step", "tool", "approval", "subagent", "error"]);
    expect(rows[0]).toEqual({ kind: "step", key: "step:1", name: "계획", state: "finished" });
    expect(rows[2]).toMatchObject({ kind: "approval", approvalId: APPROVAL, toolCallId: "t1" });
    expect(rows[3]).toMatchObject({ kind: "subagent", label: "조사", state: "started" });
    expect(rows[4]).toEqual({ kind: "error", key: "error:5", message: "Gateway 끊김" });
  });

  it("서브에이전트 오류는 그 행에 붙는다", () => {
    const rows = toActivityRows([
      runEvent({ type: "SUBAGENT_STARTED", seq: 1, subagentRunId: SUB }),
      runEvent({ type: "SUBAGENT_ERROR", seq: 2, subagentRunId: SUB, message: "실패" }),
    ]);
    expect(rows).toEqual([{ kind: "subagent", key: `subagent:${SUB}`, state: "error", message: "실패" }]);
  });

  const requested = (over: Record<string, unknown> = {}) =>
    runEvent({
      type: "APPROVAL_REQUESTED",
      seq: 1,
      approvalId: APPROVAL,
      kind: "plugin",
      title: "Write 실행",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      expiresAt: "2027-01-15T08:02:00.000Z",
      ...over,
    });
  const resolved = (over: Record<string, unknown> = {}) =>
    runEvent({
      type: "APPROVAL_RESOLVED",
      seq: 2,
      approvalId: APPROVAL,
      decision: "allow-once",
      reason: "user",
      ...over,
    });

  it("요구와 확정은 한 승인 행으로 접힌다", () => {
    const rows = toActivityRows([requested(), resolved()]);
    expect(rows).toEqual([
      {
        kind: "approval",
        key: `approval:${APPROVAL}`,
        approvalId: APPROVAL,
        title: "Write 실행",
        decision: "allow-once",
        reason: "user",
      },
    ]);
  });

  it("툴 행과 잇는 열쇠는 승인 레코드다 — 이벤트에 toolCallId 가 없어도 이어진다(Ruling 2)", () => {
    const events = [
      runEvent({ type: "TOOL_CALL_START", seq: 1, toolCallId: "t1", toolCallName: "Write" }),
      requested({ seq: 2 }), // 실물 요구 짝 순서에서는 toolCallId 가 빈다(p2-t6 어긋남 C)
    ];
    expect(toActivityRows(events)[1]).not.toHaveProperty("toolCallId");
    const rows = toActivityRows(events, { approval: () => ({ toolCallId: "t1" }) });
    expect(rows[1]).toMatchObject({ kind: "approval", toolCallId: "t1" });
    expect(toolNameByCallId(rows).get("t1")).toBe("Write");
  });

  it("레코드가 있으면 이벤트의 toolCallId 보다 레코드를 쓴다", () => {
    const rows = toActivityRows([requested({ toolCallId: "stale" })], {
      approval: () => ({ toolCallId: "t1" }),
    });
    expect(rows[0]).toMatchObject({ toolCallId: "t1" });
  });

  it("확정만 본 승인도 행이 된다 — 제목은 레코드에서", () => {
    const rows = toActivityRows([resolved({ decision: "deny", reason: "timeout" })], {
      approval: () => ({ title: "Write 실행", toolCallId: "t1" }),
    });
    expect(rows).toEqual([
      {
        kind: "approval",
        key: `approval:${APPROVAL}`,
        approvalId: APPROVAL,
        title: "Write 실행",
        toolCallId: "t1",
        decision: "deny",
        reason: "timeout",
      },
    ]);
  });

  // Ruling 3 — 중지 때 RUN_ABORTED 와 APPROVAL_RESOLVED 의 순서는 보장되지 않는다(경주)
  it("중지 때 RUN_ABORTED 와 APPROVAL_RESOLVED 는 어느 순서로 와도 같은 행이 된다", () => {
    const abort = runEvent({ type: "RUN_ABORTED", seq: 3, by: "user" });
    const cancel = resolved({ seq: 4, decision: "deny", reason: "run-aborted" });
    const before = toActivityRows([requested(), abort, cancel]);
    const after = toActivityRows([requested(), { ...cancel, seq: 3 }, { ...abort, seq: 4 }]);
    expect(before).toEqual(after);
    expect(before).toEqual([
      {
        kind: "approval",
        key: `approval:${APPROVAL}`,
        approvalId: APPROVAL,
        title: "Write 실행",
        decision: "deny",
        reason: "run-aborted",
      },
    ]);
  });
});

describe("isTruncated", () => {
  it("Gateway 의 잘림 표시를 알아본다", () => {
    expect(isTruncated('{"path":"a"} … …[+120 chars hidden]… …')).toBe(true);
    expect(isTruncated('{"path":"a"}')).toBe(false);
    expect(isTruncated(undefined)).toBe(false);
  });
});

describe("keepTimelineEvents", () => {
  it("행이 되지 않는 이벤트(텍스트 델타 등)를 버린다", () => {
    const tool = runEvent({ type: "TOOL_CALL_START", seq: 2, toolCallId: "t1", toolCallName: "Read" });
    expect(keepTimelineEvents([textDelta(1, "가"), tool, textDelta(3, "나")])).toEqual([tool]);
  });

  it("버릴 것이 없으면 같은 배열을 그대로 돌려준다", () => {
    const events = [runEvent({ type: "TOOL_CALL_END", seq: 1, toolCallId: "t1" })];
    expect(keepTimelineEvents(events)).toBe(events);
  });

  it("남긴 것만으로 만든 행이 원본으로 만든 행과 같다", () => {
    const events = [
      textDelta(1, "가"),
      runEvent({ type: "TOOL_CALL_START", seq: 2, toolCallId: "t1", toolCallName: "Read" }),
      runEvent({ type: "RUN_FINISHED", seq: 3, messageIds: [] }),
    ];
    expect(toActivityRows(keepTimelineEvents(events))).toEqual(toActivityRows(events));
  });
});

describe("approvalOutcomeLabel", () => {
  it("확정 전이면 없다", () => {
    expect(approvalOutcomeLabel({})).toBeUndefined();
  });

  it("만료는 decision 이 아니라 reason 으로 가른다(경로마다 decision 이 다르다)", () => {
    expect(approvalOutcomeLabel({ decision: "deny", reason: "timeout" })).toBe("만료됨");
    expect(approvalOutcomeLabel({ reason: "timeout" })).toBe("만료됨");
  });

  it("취소·허용·거절", () => {
    expect(approvalOutcomeLabel({ reason: "run-aborted" })).toBe("취소됨");
    expect(approvalOutcomeLabel({ decision: "allow-once", reason: "user" })).toBe("허용됨");
    expect(approvalOutcomeLabel({ decision: "allow-always", reason: "user" })).toBe("허용됨");
    expect(approvalOutcomeLabel({ decision: "deny", reason: "user" })).toBe("거절됨");
    expect(approvalOutcomeLabel({ decision: "deny", reason: "no-route" })).toBe("처리하지 못함");
  });
});

describe("mergeRunEvents", () => {
  const e = (seq: number) => textDelta(seq, `d${seq}`);

  it("seq 로 합치고 중복은 한 번만 남긴다", () => {
    expect(mergeRunEvents([e(1), e(2)], [e(2), e(3)]).map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it("늦게 온 옛 이벤트도 자리를 찾아 끼운다", () => {
    expect(mergeRunEvents([e(1), e(3)], [e(2)]).map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it("보탤 것이 없으면 같은 배열을 그대로 돌려준다(다시 그리지 않게)", () => {
    const base = [e(1)];
    expect(mergeRunEvents(base, [])).toBe(base);
    expect(mergeRunEvents([], base)).toBe(base);
  });

  it("먼저 온 쪽(REST 바탕)이 이긴다", () => {
    const rest = runEvent({ type: "TOOL_CALL_ARGS", seq: 1, toolCallId: "t1", delta: "rest" });
    const live = runEvent({ type: "TOOL_CALL_ARGS", seq: 1, toolCallId: "t1", delta: "live" });
    expect(mergeRunEvents([rest], [live])[0]).toBe(rest);
  });
});

describe("mergeRuns", () => {
  const run = (id: string, over: Partial<Run> = {}): Run => ({
    id,
    channelId: CH,
    agentId: AGENT,
    triggerKind: "mention",
    rootMessageId: uid(9),
    relayDepth: 0,
    sessionKey: "agent:dev:dodok:channel:c",
    status: "done",
    hasCanonical: true,
    createdAt: "2027-01-15T08:00:00.000Z",
    startedAt: "2027-01-15T08:00:01.000Z",
    endedAt: "2027-01-15T08:00:05.000Z",
    ...over,
  });

  it("실시간 상태가 REST 값을 덮는다", () => {
    const merged = mergeRuns([run(RUN, { status: "streaming" })], [runState({ id: RUN, status: "done" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: RUN, status: "done", createdAt: "2027-01-15T08:00:00.000Z" });
  });

  it("REST 에 없는 새 런도 목록에 든다 — 최신(uuid v7 큰 것)이 앞", () => {
    const merged = mergeRuns([run(RUN)], [runState({ id: RUN2, status: "streaming" })]);
    expect(merged.map((r) => r.id)).toEqual([RUN2, RUN]);
  });

  it("실시간이 싣지 않는 열은 REST 값이 남는다", () => {
    const live: RunState = runState({ id: RUN, status: "done" });
    const merged = mergeRuns([run(RUN, { endedAt: "2027-01-15T08:00:05.000Z" })], [live]);
    expect(merged[0]?.endedAt).toBe("2027-01-15T08:00:05.000Z");
  });
});

describe("runDurationMs", () => {
  it("끝난 런은 시작~끝, 진행 중이면 시작~지금", () => {
    expect(
      runDurationMs(
        { startedAt: "2027-01-15T08:00:00.000Z", endedAt: "2027-01-15T08:00:12.000Z" },
        Date.parse("2027-01-15T09:00:00.000Z"),
      ),
    ).toBe(12_000);
    expect(
      runDurationMs({ startedAt: "2027-01-15T08:00:00.000Z" }, Date.parse("2027-01-15T08:00:03.000Z")),
    ).toBe(3_000);
    expect(runDurationMs({}, 0)).toBeUndefined();
  });
});
