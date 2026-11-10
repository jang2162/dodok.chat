import { RunEvent, type RunSignal } from "@dodok/shared";
import type { EventFrame } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import type { RunEventBody } from "../src";
import { createGatewayEventMapper, frameRunId, type MappedEvent } from "../src/gateway/events";
import * as f from "./fixtures/gateway-events";

const OTHER_RUN = "01a09fc9-d204-7551-89d6-38544d07a299";

function mapper(isOurRun: (runId: string) => boolean = () => true) {
  return createGatewayEventMapper({ isOurRun });
}

/** 매핑 결과를 검사하는 공통 단언: 모든 event 가 RunEvent 스키마를 통과하고 runId 가 항목과 같다. */
function run(m: ReturnType<typeof mapper>, frame: EventFrame): MappedEvent[] {
  const out = m.map(frame);
  for (const item of out) {
    expect(item.event !== undefined || item.signal !== undefined).toBe(true);
    if (item.event) {
      const parsed = RunEvent.safeParse({ ...item.event, seq: 1, ts: new Date().toISOString() });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(item.event.runId).toBe(item.runId);
    }
  }
  return out;
}

const events = (out: MappedEvent[]): RunEventBody[] => out.flatMap((m) => (m.event ? [m.event] : []));
const signals = (out: MappedEvent[]): RunSignal[] => out.flatMap((m) => (m.signal ? [m.signal] : []));
const types = (out: MappedEvent[]) => events(out).map((e) => e.type);

/** gateway_started 를 이미 낸 매퍼. */
function started() {
  const m = mapper();
  m.map(f.lifecycleStart());
  return m;
}

describe("createGatewayEventMapper — 매핑 표", () => {
  it("agent lifecycle start → gateway_started 만 (RUN_STARTED 는 오케스트레이터가 런 행으로 만든다)", () => {
    const out = run(mapper(), f.lifecycleStart());

    expect(out).toEqual([{ runId: f.RUN_ID, signal: { kind: "gateway_started" } }]);
  });

  it("chat status → STEP_STARTED(phase) 만", () => {
    const out = run(started(), f.chatStatus("starting_model"));

    expect(events(out)).toEqual([{ type: "STEP_STARTED", runId: f.RUN_ID, stepName: "starting_model" }]);
    expect(signals(out)).toEqual([]);
  });

  it("chat delta → TEXT_MESSAGE_START(첫 델타) + TEXT_MESSAGE_CONTENT + text_delta", () => {
    const out = run(started(), f.chatDelta("P"));

    expect(events(out)).toEqual([
      { type: "TEXT_MESSAGE_START", runId: f.RUN_ID, messageId: f.RUN_ID, role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", runId: f.RUN_ID, messageId: f.RUN_ID, delta: "P" },
    ]);
    expect(signals(out)).toEqual([{ kind: "text_delta" }]);
  });

  it("chat delta replace:true → TEXT_MESSAGE_REPLACE(message 스냅샷 텍스트) + text_delta", () => {
    const m = started();
    run(m, f.chatDelta("PO"));
    const out = run(m, f.chatDelta("X", { snapshot: "PX", replace: true }));

    expect(events(out)).toEqual([
      { type: "TEXT_MESSAGE_REPLACE", runId: f.RUN_ID, messageId: f.RUN_ID, text: "PX" },
    ]);
    expect(signals(out)).toEqual([{ kind: "text_delta" }]);
  });

  it("chat final → TEXT_MESSAGE_END + gateway_final(snapshotText)", () => {
    const m = started();
    run(m, f.chatDelta("P"));
    const out = run(m, f.chatFinal("PONG"));

    expect(events(out)).toEqual([{ type: "TEXT_MESSAGE_END", runId: f.RUN_ID, messageId: f.RUN_ID }]);
    expect(out.filter((item) => item.signal)).toEqual([
      { runId: f.RUN_ID, signal: { kind: "gateway_final" }, snapshotText: "PONG" },
    ]);
  });

  it("chat error → RUN_ERROR(errorMessage·errorKind·errorDetail) + gateway_error", () => {
    const detail = { provider: "claude-cli", model: "claude-opus-5", httpStatus: 429 };
    const out = run(
      started(),
      f.chatError({ errorMessage: "rate limited", errorKind: "rate_limit", errorDetail: detail }),
    );

    expect(events(out)).toEqual([
      { type: "RUN_ERROR", runId: f.RUN_ID, message: "rate limited", code: "rate_limit", detail },
    ]);
    expect(signals(out)).toEqual([{ kind: "gateway_error", code: "rate_limit", message: "rate limited" }]);
  });

  it("chat aborted → RUN_ABORTED(gateway) + gateway_aborted", () => {
    const out = run(started(), f.chatAborted());

    expect(events(out)).toEqual([{ type: "RUN_ABORTED", runId: f.RUN_ID, by: "gateway" }]);
    expect(signals(out)).toEqual([{ kind: "gateway_aborted" }]);
  });

  it("agent tool start → TOOL_CALL_START + TOOL_CALL_ARGS(JSON) + tool_start", () => {
    const args = { command: "ls", description: "list" };
    const out = run(started(), f.toolStart(f.TOOL_CALL_ID, { name: "Bash", args }));

    expect(events(out)).toEqual([
      { type: "TOOL_CALL_START", runId: f.RUN_ID, toolCallId: f.TOOL_CALL_ID, toolCallName: "Bash" },
      { type: "TOOL_CALL_ARGS", runId: f.RUN_ID, toolCallId: f.TOOL_CALL_ID, delta: JSON.stringify(args) },
    ]);
    expect(signals(out)).toEqual([{ kind: "tool_start" }]);
  });

  it("agent tool start 에 args 가 없으면 ARGS delta 는 {}", () => {
    const out = run(started(), f.toolStart(f.TOOL_CALL_ID, { args: undefined }));

    expect(events(out)[1]).toEqual({
      type: "TOOL_CALL_ARGS",
      runId: f.RUN_ID,
      toolCallId: f.TOOL_CALL_ID,
      delta: "{}",
    });
  });

  it("agent tool result → TOOL_CALL_RESULT(2,000자 자름) + TOOL_CALL_END + tool_end{openTools}", () => {
    const m = started();
    run(m, f.toolStart());
    const long = "x".repeat(2500);
    const out = run(m, f.toolResult(f.TOOL_CALL_ID, { result: long, isError: true }));

    expect(events(out)).toEqual([
      {
        type: "TOOL_CALL_RESULT",
        runId: f.RUN_ID,
        toolCallId: f.TOOL_CALL_ID,
        content: "x".repeat(2000),
        ok: false,
      },
      { type: "TOOL_CALL_END", runId: f.RUN_ID, toolCallId: f.TOOL_CALL_ID },
    ]);
    expect(signals(out)).toEqual([{ kind: "tool_end", openTools: 0 }]);
  });

  it("agent tool result 가 문자열이 아니면 JSON 으로 싣고, 없으면 빈 문자열", () => {
    const m = started();
    run(m, f.toolStart("a"));
    run(m, f.toolStart("b"));
    const objectResult = run(m, f.toolResult("a", { result: { stdout: "hi" } }));
    const noResult = run(m, f.toolResult("b", { result: undefined }));

    expect(events(objectResult)[0]).toMatchObject({ content: '{"stdout":"hi"}', ok: true });
    expect(events(noResult)[0]).toMatchObject({ content: "" });
  });

  it("agent lifecycle end → STEP_FINISHED(lifecycle) 만", () => {
    const out = run(started(), f.lifecycleEnd());

    expect(events(out)).toEqual([{ type: "STEP_FINISHED", runId: f.RUN_ID, stepName: "lifecycle" }]);
    expect(signals(out)).toEqual([]);
  });

  it("agent assistant·thinking·run_status → 무시", () => {
    const m = started();

    expect(run(m, f.agentEvent("assistant", { text: "P", delta: "P" }))).toEqual([]);
    expect(run(m, f.agentEvent("thinking", { progressTokens: 12 }))).toEqual([]);
    expect(run(m, f.agentEvent("run_status", { phase: "running" }))).toEqual([]);
  });

  it("session.message(assistant, usage) → CUSTOM openclaw.usage (runId 는 idempotencyKey 에서)", () => {
    const out = run(mapper(), f.sessionMessage());

    expect(out).toEqual([
      {
        runId: f.RUN_ID,
        event: {
          type: "CUSTOM",
          runId: f.RUN_ID,
          name: "openclaw.usage",
          value: { inputTokens: 2, outputTokens: 181, costUsd: 0.0123, model: "claude-opus-5" },
        },
      },
    ]);
  });

  it("sessions.changed·node.*·health 처럼 runId 없는 프레임 → []", () => {
    const m = started();

    expect(run(m, f.sessionsChanged())).toEqual([]);
    expect(run(m, { type: "event", event: "node.hostStats", payload: { cpu: 0.1 }, seq: 3 })).toEqual([]);
    expect(run(m, { type: "event", event: "health", payload: { ok: true } })).toEqual([]);
    expect(run(m, { type: "event", event: "chat" })).toEqual([]);
  });
});

describe("createGatewayEventMapper — 런별 상태", () => {
  it("gateway_started 는 lifecycle start 와 첫 chat 중 먼저 온 쪽에서 한 번만 낸다", () => {
    const lifecycleFirst = mapper();
    const a1 = run(lifecycleFirst, f.lifecycleStart());
    const a2 = run(lifecycleFirst, f.chatStatus());
    const a3 = run(lifecycleFirst, f.lifecycleStart());

    expect(signals(a1)).toEqual([{ kind: "gateway_started" }]);
    expect(types(a2)).toEqual(["STEP_STARTED"]);
    expect(a3).toEqual([]);

    const chatFirst = mapper();
    const b1 = run(chatFirst, f.chatStatus());
    const b2 = run(chatFirst, f.lifecycleStart());
    const b3 = run(chatFirst, f.chatDelta("P"));

    expect(types(b1)).toEqual(["STEP_STARTED"]);
    expect(signals(b1)).toEqual([{ kind: "gateway_started" }]);
    expect(b2).toEqual([]);
    expect(signals(b3)).toEqual([{ kind: "text_delta" }]);
  });

  it("gateway_started 는 같은 프레임의 다른 항목보다 앞선다", () => {
    const out = run(mapper(), f.chatDelta("P"));

    expect(out.map((item) => item.event?.type ?? item.signal?.kind)).toEqual([
      "gateway_started",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "text_delta",
    ]);
  });

  it("TEXT_MESSAGE_START 는 런의 첫 델타에만 낸다", () => {
    const m = started();
    const first = run(m, f.chatDelta("P"));
    const second = run(m, f.chatDelta("O", { snapshot: "PO" }));
    const third = run(m, f.chatDelta("NG", { snapshot: "PONG" }));

    expect(types(first)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]);
    expect(types(second)).toEqual(["TEXT_MESSAGE_CONTENT"]);
    expect(types(third)).toEqual(["TEXT_MESSAGE_CONTENT"]);
  });

  it("replace 가 첫 텍스트면 START 뒤에 REPLACE 를 낸다", () => {
    const out = run(started(), f.chatDelta("P", { replace: true }));

    expect(types(out)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_REPLACE"]);
  });

  it("런마다 상태가 따로다", () => {
    const m = mapper();
    const ours = run(m, f.chatDelta("P"));
    const other = run(m, f.chatDelta("Q", { runId: OTHER_RUN }));

    expect(types(ours)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]);
    expect(types(other)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]);
    expect(signals(other)).toEqual([{ kind: "gateway_started" }, { kind: "text_delta" }]);
    expect(other.every((item) => item.runId === OTHER_RUN)).toBe(true);
  });

  it("TEXT_MESSAGE_END 는 START 를 낸 런에만 낸다", () => {
    const out = run(started(), f.chatFinal("PONG"));

    expect(types(out)).toEqual([]);
    expect(signals(out)).toEqual([{ kind: "gateway_final" }]);
  });

  it.each([
    ["final", () => f.chatFinal("PONG")],
    ["error", () => f.chatError({ errorKind: "timeout" })],
    ["aborted", () => f.chatAborted()],
  ])("chat %s 로 런이 끝나면 그 런의 상태를 지운다 (종료 표시는 forget 이 푼다)", (_state, terminal) => {
    const m = mapper();
    run(m, f.chatDelta("P"));
    run(m, f.toolStart());
    run(m, terminal());
    m.forget(f.RUN_ID);
    const again = run(m, f.chatDelta("P"));
    const orphanResult = run(m, f.toolResult());

    expect(types(again)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]);
    expect(signals(again)).toEqual([{ kind: "gateway_started" }, { kind: "text_delta" }]);
    expect(signals(orphanResult)).toEqual([{ kind: "tool_end", openTools: 0 }]);
  });

  it("툴 카운터: 열린 툴 수를 세고, 모르는 toolCallId 의 result 는 내리지 않는다(음수 없음)", () => {
    const m = started();

    expect(signals(run(m, f.toolStart("a")))).toEqual([{ kind: "tool_start" }]);
    expect(signals(run(m, f.toolStart("b")))).toEqual([{ kind: "tool_start" }]);
    expect(signals(run(m, f.toolResult("a")))).toEqual([{ kind: "tool_end", openTools: 1 }]);

    const unknown = run(m, f.toolResult("zzz"));
    expect(types(unknown)).toEqual(["TOOL_CALL_RESULT", "TOOL_CALL_END"]);
    expect(signals(unknown)).toEqual([{ kind: "tool_end", openTools: 1 }]);

    expect(signals(run(m, f.toolResult("a")))).toEqual([{ kind: "tool_end", openTools: 1 }]);
    expect(signals(run(m, f.toolResult("b")))).toEqual([{ kind: "tool_end", openTools: 0 }]);
    expect(signals(run(m, f.toolResult("b")))).toEqual([{ kind: "tool_end", openTools: 0 }]);
  });

  it("isOurRun 이 false 면 [] 이고 상태도 만들지 않는다", () => {
    const ours = new Set<string>();
    const isOurRun = vi.fn((runId: string) => ours.has(runId));
    const m = mapper(isOurRun);

    expect(run(m, f.lifecycleStart())).toEqual([]);
    expect(run(m, f.chatDelta("P"))).toEqual([]);
    expect(run(m, f.toolStart())).toEqual([]);
    expect(run(m, f.chatFinal("PONG"))).toEqual([]);
    expect(run(m, f.sessionMessage())).toEqual([]);
    expect(isOurRun).toHaveBeenCalledWith(f.RUN_ID);

    ours.add(f.RUN_ID);
    const after = run(m, f.chatDelta("P"));
    expect(types(after)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]);
    expect(signals(after)).toEqual([{ kind: "gateway_started" }, { kind: "text_delta" }]);
  });

  it("빈 deltaText(replace 아님)는 텍스트 이벤트도 text_delta 도 내지 않는다", () => {
    const m = started();
    const empty = run(m, f.chatDelta(""));
    const next = run(m, f.chatDelta("P"));

    expect(empty).toEqual([]);
    expect(types(next)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]);
  });

  it("snapshotText 는 message.content 의 text 조각을 이어 붙이고, 없으면 빈 문자열", () => {
    const joined = run(
      started(),
      f.chatFinal([
        { type: "text", text: "PO" },
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "NG" },
      ]),
    );
    const empty = run(started(), f.chatFinal(null));

    expect(joined.find((item) => item.signal)?.snapshotText).toBe("PONG");
    expect(empty.find((item) => item.signal)?.snapshotText).toBe("");
  });
});

describe("createGatewayEventMapper — forget·종료 표시", () => {
  it("forget(runId) 은 런 상태를 지워, 다음 이벤트가 새 런처럼 gateway_started·TEXT_MESSAGE_START 를 다시 낸다", () => {
    const m = started();
    run(m, f.chatDelta("P"));
    run(m, f.toolStart("a"));

    m.forget(f.RUN_ID);
    const after = run(m, f.chatDelta("Q"));

    expect(signals(after)).toEqual([{ kind: "gateway_started" }, { kind: "text_delta" }]);
    expect(types(after)).toEqual(["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]);
  });

  it.each([
    ["final", () => f.chatFinal("PONG")],
    ["error", () => f.chatError({ errorKind: "timeout" })],
    ["aborted", () => f.chatAborted()],
  ])("chat %s 뒤에는 forget 전까지 chat·agent 프레임이 [] 이고 usage CUSTOM 만 통과한다", (_state, end) => {
    const m = started();
    run(m, f.chatDelta("P"));
    run(m, end());

    expect(run(m, f.chatDelta("late"))).toEqual([]);
    expect(run(m, f.chatStatus())).toEqual([]);
    expect(run(m, f.lifecycleStart())).toEqual([]);
    expect(run(m, f.lifecycleEnd())).toEqual([]);
    expect(run(m, f.toolStart("late"))).toEqual([]);
    expect(types(run(m, f.sessionMessage()))).toEqual(["CUSTOM"]);

    m.forget(f.RUN_ID);
    expect(signals(run(m, f.chatDelta("again")))).toEqual([
      { kind: "gateway_started" },
      { kind: "text_delta" },
    ]);
  });

  it("forget 은 다른 런의 상태·종료 표시를 건드리지 않는다", () => {
    const m = mapper();
    run(m, f.chatDelta("P", { runId: OTHER_RUN }));
    run(m, f.chatFinal("PONG"));

    m.forget(OTHER_RUN);

    expect(run(m, f.chatDelta("late"))).toEqual([]);
    expect(signals(run(m, f.chatDelta("x", { runId: OTHER_RUN })))).toEqual([
      { kind: "gateway_started" },
      { kind: "text_delta" },
    ]);
  });
});

describe("createGatewayEventMapper — 경계", () => {
  it("chat error 에 errorMessage·errorKind 가 없으면 기본값을 쓴다", () => {
    const onlyKind = run(started(), f.chatError({ errorKind: "timeout" }));
    const bare = run(started(), f.chatError());

    expect(events(onlyKind)).toEqual([
      { type: "RUN_ERROR", runId: f.RUN_ID, message: "timeout", code: "timeout" },
    ]);
    expect(signals(onlyKind)).toEqual([{ kind: "gateway_error", code: "timeout", message: "timeout" }]);
    expect(events(bare)).toEqual([
      { type: "RUN_ERROR", runId: f.RUN_ID, message: "gateway error", code: "unknown" },
    ]);
    expect(signals(bare)).toEqual([{ kind: "gateway_error", code: "unknown", message: "gateway error" }]);
  });

  it("session.message runId 순서: __openclaw.runId → payload runId → idempotencyKey, 모두 없으면 []", () => {
    const fromPayload = run(
      mapper(),
      f.sessionMessage({ idempotencyKey: "other-key", payloadRunId: OTHER_RUN }),
    );
    const none = run(mapper(), f.sessionMessage({ idempotencyKey: null }));

    expect(fromPayload.map((item) => item.runId)).toEqual([OTHER_RUN]);
    expect(none).toEqual([]);
  });

  it("session.message: __openclaw.runId 만 있어도 그 런으로 CUSTOM 을 낸다(가장 먼저 본다)", () => {
    const onlyMeta = run(mapper(), f.sessionMessage({ idempotencyKey: null, openclawRunId: OTHER_RUN }));
    const metaWins = run(mapper(), f.sessionMessage({ openclawRunId: OTHER_RUN, payloadRunId: f.RUN_ID }));

    expect(onlyMeta.map((item) => item.runId)).toEqual([OTHER_RUN]);
    expect(metaWins.map((item) => item.runId)).toEqual([OTHER_RUN]);
  });

  it("session.message: cli-assistant: 접두사가 없는 idempotencyKey 는 키 전체를 runId 로 쓴다", () => {
    const out = run(mapper(), f.sessionMessage({ idempotencyKey: OTHER_RUN }));
    const emptySuffix = run(mapper(), f.sessionMessage({ idempotencyKey: "cli-assistant:" }));

    expect(out.map((item) => item.runId)).toEqual([OTHER_RUN]);
    expect(emptySuffix).toEqual([]);
  });

  it("session.message: assistant 가 아니거나 usage 가 없으면 []", () => {
    expect(run(mapper(), f.sessionMessage({ role: "user" }))).toEqual([]);
    expect(run(mapper(), f.sessionMessage({ usage: null }))).toEqual([]);
  });

  it("모양이 틀린 payload 는 [] (던지지 않는다)", () => {
    const m = mapper();

    expect(run(m, { type: "event", event: "chat", payload: { runId: f.RUN_ID, state: "delta" } })).toEqual(
      [],
    );
    expect(
      run(m, {
        type: "event",
        event: "chat",
        payload: { runId: f.RUN_ID, sessionKey: f.SESSION_KEY, state: "weird" },
      }),
    ).toEqual([]);
    expect(run(m, f.agentEvent("tool", { phase: "start" }))).toEqual([]);
    expect(run(m, { type: "event", event: "agent", payload: "nope" })).toEqual([]);
    expect(run(m, { type: "event", event: "session.message", payload: { message: 42 } })).toEqual([]);
  });
});

describe("frameRunId — 매퍼가 버리는 프레임의 런 id 도 읽는다", () => {
  it("chat·agent 는 payload.runId — thinking·run_status·빈 delta 처럼 item 이 없는 프레임도", () => {
    expect(frameRunId(f.agentEvent("thinking", { progressTokens: 12 }))).toBe(f.RUN_ID);
    expect(frameRunId(f.agentEvent("run_status", { phase: "running" }))).toBe(f.RUN_ID);
    expect(frameRunId(f.chatStatus())).toBe(f.RUN_ID);
    expect(frameRunId(f.chatDelta("x", { runId: OTHER_RUN }))).toBe(OTHER_RUN);
  });

  it("session.message 는 매퍼와 같은 순서(전사 메타 → payload → idempotencyKey), usage 가 없어도", () => {
    expect(frameRunId(f.sessionMessage({ usage: null, role: "user" }))).toBe(f.RUN_ID);
    expect(frameRunId(f.sessionMessage({ openclawRunId: OTHER_RUN }))).toBe(OTHER_RUN);
    expect(frameRunId(f.sessionMessage({ idempotencyKey: null, payloadRunId: OTHER_RUN }))).toBe(OTHER_RUN);
  });

  it("런이 없는 프레임은 undefined", () => {
    expect(frameRunId(f.sessionsChanged())).toBeUndefined();
    expect(frameRunId(f.sessionMessage({ idempotencyKey: null }))).toBeUndefined();
  });
});
