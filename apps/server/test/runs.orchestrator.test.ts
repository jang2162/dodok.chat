import { AdapterError } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import type { AdapterStatus, Message, OutboundMessage, Run, RunEvent, RunState } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbOrTx } from "../src/db/client";
import { componentInteractions, messages } from "../src/db/schema.sqlite";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage, getMessage, rowToMessage } from "../src/modules/messages/service";
import type { RunPlan } from "../src/modules/router/decide";
import {
  type OrchestratorLogger,
  type RunTimeouts,
  createOrchestrator,
} from "../src/modules/runs/orchestrator";
import { getRun, insertRun, listRunEvents, updateRun } from "../src/modules/runs/store";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";

type Ids = ReturnType<typeof seedChannelWithAgent>;

function systemMessages(db: DbOrTx): Message[] {
  return db.select().from(messages).where(eq(messages.kind, "system")).all().map(rowToMessage);
}

function setup(opts: { timeouts?: Partial<RunTimeouts> } = {}) {
  const db = newTestDb();
  const bus = new ServerBus();
  const adapter = new FakeAdapter();
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onAgentMessage = vi.fn(async (_message: Message, _run: Run) => {});
  const ids = seedChannelWithAgent(db);
  const states: RunState[] = [];
  const events: RunEvent[] = [];
  bus.on("run.state", (p) => states.push(p.run));
  bus.on("run.event", (p) => events.push(p.event));
  const orch = createOrchestrator({
    db,
    bus,
    adapter,
    logger: logger as unknown as OrchestratorLogger,
    onAgentMessage,
    timeouts: opts.timeouts,
  });

  let n = 0;
  const say = (bodyMd = "@dev 안녕", at: Ids = ids) =>
    createUserMessage(db, bus, {
      channelId: at.channelId,
      authorId: at.userId,
      bodyMd,
      clientMsgId: `c${++n}`,
    });
  const enqueue = (message: Message = say(), plan: Partial<RunPlan & { channelId: string }> = {}) =>
    orch.enqueueRun(
      {
        agentId: ids.agentId,
        channelId: message.channelId,
        triggerKind: "mention",
        rootMessageId: message.id,
        relayDepth: 0,
        ...plan,
      },
      { message },
    );
  const sessionKey = `agent:dev:dodok:channel:${ids.channelId}`;
  const outbound = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
    outboundId: `out-${++n}`,
    channelId: ids.channelId,
    agentId: "dev",
    sessionKey,
    text: "답입니다",
    attachments: [],
    ts: new Date().toISOString(),
    ...over,
  });
  const runOf = (id: string) => {
    const run = getRun(db, id);
    if (!run) throw new Error(`run ${id} missing`);
    return run;
  };
  const eventsOf = (runId: string) => listRunEvents(db, runId, 0);
  // fake timers 는 advanceTimersByTimeAsync 가 실제 setImmediate 로 한 번 양보해 대기 중인 프로미스를 비운다
  const flush = () => vi.advanceTimersByTimeAsync(0);

  return {
    db,
    bus,
    adapter,
    logger,
    onAgentMessage,
    orch,
    states,
    events,
    say,
    enqueue,
    sessionKey,
    outbound,
    runOf,
    eventsOf,
    flush,
    ...ids,
  };
}

describe("orchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueue 는 queued 런과 RUN_QUEUED 를 만들고 즉시 디스패치한다(같은 세션에 진행 중 런이 없을 때)", async () => {
    const t = setup();
    const message = t.say("@dev 안녕");
    const run = await t.enqueue(message);

    expect(run).toMatchObject({
      status: "queued",
      channelId: t.channelId,
      agentId: t.agentId,
      triggerKind: "mention",
      triggerMessageId: message.id,
      rootMessageId: message.id,
      sessionKey: t.sessionKey,
      hasCanonical: false,
    });
    expect(t.eventsOf(run.id)).toEqual([
      { type: "RUN_QUEUED", runId: run.id, position: 0, seq: 1, ts: expect.any(String) },
    ]);
    expect(t.events.map((e) => e.type)).toEqual(["RUN_QUEUED"]);
    expect(t.states).toEqual([expect.objectContaining({ id: run.id, status: "queued" })]);

    expect(t.adapter.calls.send).toHaveLength(1);
    const inbound = t.adapter.calls.send[0];
    expect(inbound?.runId).toBe(run.id);
    expect(inbound?.kind).toBe("message");
    expect(inbound?.sessionKey).toBe(t.sessionKey);
    expect(inbound?.context.recentMessages).toEqual(expect.any(Array));

    await t.flush();
    expect(t.runOf(run.id)).toMatchObject({ status: "queued", providerRunId: run.id });
    t.orch.stop();
    await vi.advanceTimersByTimeAsync(120_000); // stop 이 타이머를 모두 풀었다
    expect(t.runOf(run.id).status).toBe("queued");
  });

  it("같은 세션의 두 번째 런은 첫 런이 끝날 때까지 send 되지 않는다", async () => {
    const t = setup();
    const first = await t.enqueue(t.say("@dev 하나"));
    const second = await t.enqueue(t.say("@dev 둘"));
    await t.flush();
    expect(t.adapter.calls.send.map((s) => s.runId)).toEqual([first.id]);
    expect(t.eventsOf(second.id)).toEqual([expect.objectContaining({ type: "RUN_QUEUED", position: 1 })]);

    // 대기 중인 런에는 queued 타이머가 없다 — 앞 런이 오래 걸려도 대기 런은 TIMEOUT 되지 않는다
    await t.orch.signal(first.id, { kind: "gateway_started" });
    await vi.advanceTimersByTimeAsync(200_000);
    expect(t.runOf(second.id).status).toBe("queued");

    await t.orch.signal(first.id, { kind: "gateway_final" });
    expect(t.adapter.calls.send).toHaveLength(1);
    await t.orch.signal(first.id, { kind: "canonical_received" });
    expect(t.runOf(first.id)).toMatchObject({ status: "done", finalSource: "plugin" });
    expect(t.adapter.calls.send.map((s) => s.runId)).toEqual([first.id, second.id]);
    t.orch.stop();
  });

  it("gateway_started·text_delta·tool_start/end·gateway_final 이 상태를 전이시키고 run.state 를 팬아웃한다", async () => {
    const t = setup();
    const run = await t.enqueue();
    await t.flush();
    const signal = (s: Parameters<typeof t.orch.signal>[1], snapshotText?: string) =>
      t.adapter.emit({
        kind: "run_signal",
        runId: run.id,
        signal: s,
        ...(snapshotText ? { snapshotText } : {}),
      });

    signal({ kind: "gateway_started" });
    t.adapter.emit({
      kind: "run_event",
      runId: run.id,
      event: { type: "TEXT_MESSAGE_START", runId: run.id, messageId: run.id, role: "assistant" },
    });
    signal({ kind: "text_delta" });
    signal({ kind: "tool_start" });
    signal({ kind: "tool_start" });
    signal({ kind: "tool_end", openTools: 1 });
    signal({ kind: "tool_end", openTools: 0 });
    signal({ kind: "gateway_started" }); // 이미 streaming — RUN_STARTED 를 다시 만들지 않는다
    signal({ kind: "gateway_final" }, "스냅샷");
    await t.flush();

    expect(t.states.map((s) => s.status)).toEqual(["queued", "streaming", "tool", "streaming", "finalizing"]);
    const stored = t.eventsOf(run.id);
    expect(stored.map((e) => e.type)).toEqual([
      "RUN_QUEUED",
      "RUN_STARTED",
      "STATE_SNAPSHOT",
      "TEXT_MESSAGE_START",
      "STATE_SNAPSHOT",
      "STATE_SNAPSHOT",
      "STATE_SNAPSHOT",
    ]);
    expect(stored[1]).toEqual({
      type: "RUN_STARTED",
      runId: run.id,
      threadId: t.channelId,
      agentId: t.agentId,
      sessionKey: t.sessionKey,
      providerRunId: run.id,
      seq: 2,
      ts: expect.any(String),
    });
    expect(stored.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(t.events).toEqual(stored);
    expect(t.runOf(run.id).startedAt).toEqual(expect.any(String));

    // 어댑터 run_signal 의 snapshotText 가 finalizing 상한에서 쓰인다
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource: "gateway" });
    expect(
      t.db
        .select()
        .from(messages)
        .where(eq(messages.runId, run.id))
        .all()
        .map((m) => m.bodyMd),
    ).toEqual(["스냅샷"]);
    t.orch.stop();
  });

  it("50ms 안의 TEXT_MESSAGE_CONTENT 는 하나로 합쳐 저장·전송된다", async () => {
    const t = setup();
    const run = await t.enqueue();
    await t.flush();
    await t.orch.signal(run.id, { kind: "gateway_started" });
    const content = (delta: string) =>
      t.adapter.emit({
        kind: "run_event",
        runId: run.id,
        event: { type: "TEXT_MESSAGE_CONTENT", runId: run.id, messageId: run.id, delta },
      });
    const contents = () => t.eventsOf(run.id).filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
    const sent = () => t.events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");

    content("a");
    vi.advanceTimersByTime(30);
    content("b");
    content("c");
    expect(contents()).toEqual([]);
    vi.advanceTimersByTime(19);
    expect(contents()).toEqual([]);
    vi.advanceTimersByTime(1); // 첫 조각 기준 50ms — 뒤 조각이 타이머를 다시 걸지 않는다
    expect(contents()).toEqual([expect.objectContaining({ runId: run.id, messageId: run.id, delta: "abc" })]);
    expect(sent()).toHaveLength(1);

    // 다른 종류의 이벤트가 오면 버퍼를 먼저 flush 해 순서를 지킨다
    content("d");
    t.adapter.emit({
      kind: "run_event",
      runId: run.id,
      event: { type: "TOOL_CALL_START", runId: run.id, toolCallId: "t1", toolCallName: "exec" },
    });
    t.adapter.emit({
      kind: "run_event",
      runId: run.id,
      event: { type: "TOOL_CALL_ARGS", runId: run.id, toolCallId: "t1", delta: '{"a":' },
    });
    t.adapter.emit({
      kind: "run_event",
      runId: run.id,
      event: { type: "TOOL_CALL_ARGS", runId: run.id, toolCallId: "t1", delta: "1}" },
    });
    await t.orch.signal(run.id, { kind: "gateway_error", code: "boom", message: "x" }); // 종료 시 flush
    expect(
      t
        .eventsOf(run.id)
        .filter((e) => ["TEXT_MESSAGE_CONTENT", "TOOL_CALL_START", "TOOL_CALL_ARGS"].includes(e.type))
        .map((e) => ("delta" in e ? `${e.type}:${e.delta}` : e.type)),
    ).toEqual([
      "TEXT_MESSAGE_CONTENT:abc",
      "TEXT_MESSAGE_CONTENT:d",
      "TOOL_CALL_START",
      'TOOL_CALL_ARGS:{"a":1}',
    ]);
    expect(t.events).toEqual(t.eventsOf(run.id));
    t.orch.stop();
  });

  it("정본이 오면 에이전트 메시지가 runId 를 달고 저장되고 onAgentMessage 가 불린다; final 뒤엔 done(plugin)", async () => {
    const t = setup();
    const trigger = t.say("@dev 요약해줘");
    const run = await t.enqueue(trigger);
    await t.flush();
    await t.orch.signal(run.id, { kind: "gateway_started" });
    let hasCanonicalWhenRouted: boolean | undefined;
    t.onAgentMessage.mockImplementation(async (_message, r) => {
      hasCanonicalWhenRouted = t.runOf(r.id).hasCanonical;
    });

    const out = t.outbound({ runId: run.id, text: "끝났어요 @owner", replyToInboundId: trigger.id });
    const ack = await t.orch.onCanonical(out);
    const stored = getMessage(t.db, ack.messageId ?? "");
    expect(stored).toMatchObject({
      authorType: "agent",
      authorId: t.agentId,
      runId: run.id,
      externalId: out.outboundId,
      replyTo: trigger.id,
      mentions: { users: [t.userId], agents: [] },
    });
    expect(t.onAgentMessage).toHaveBeenCalledTimes(1);
    expect(t.onAgentMessage).toHaveBeenCalledWith(stored, expect.objectContaining({ id: run.id }));
    expect(hasCanonicalWhenRouted).toBe(false); // 라우팅은 canonical_received 전에
    expect(t.runOf(run.id)).toMatchObject({ status: "streaming", hasCanonical: true });

    // 같은 outboundId 재전송은 같은 메시지, 라우팅 없음
    expect(await t.orch.onCanonical(out)).toEqual({ messageId: ack.messageId });
    expect(t.onAgentMessage).toHaveBeenCalledTimes(1);

    await t.orch.signal(run.id, { kind: "gateway_final" });
    expect(t.runOf(run.id)).toMatchObject({
      status: "done",
      finalSource: "plugin",
      endedAt: expect.any(String),
    });
    const finished = t.eventsOf(run.id).at(-1);
    expect(finished).toMatchObject({ type: "RUN_FINISHED", messageIds: [ack.messageId] });
    expect(t.states.at(-1)).toMatchObject({ status: "done", finalSource: "plugin" });
    t.orch.stop();
  });

  it("final 뒤 정본이 10초 안에 안 오면 스냅샷으로 done(gateway)", async () => {
    const t = setup();
    const run = await t.enqueue();
    await t.flush();
    await t.orch.signal(run.id, { kind: "gateway_started" });
    await t.orch.signal(run.id, { kind: "gateway_final" }, { message: "snapshot" });
    expect(t.runOf(run.id).status).toBe("finalizing");

    await vi.advanceTimersByTimeAsync(9_999);
    expect(t.runOf(run.id).status).toBe("finalizing");
    await vi.advanceTimersByTimeAsync(1);

    expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource: "gateway" });
    const agentMessages = t.db
      .select()
      .from(messages)
      .where(eq(messages.runId, run.id))
      .all()
      .map(rowToMessage);
    expect(agentMessages).toEqual([expect.objectContaining({ bodyMd: "snapshot", authorId: t.agentId })]);
    expect(t.eventsOf(run.id).at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      messageIds: [agentMessages[0]?.id],
    });
    expect(t.onAgentMessage).toHaveBeenCalledWith(agentMessages[0], expect.objectContaining({ id: run.id }));
    t.orch.stop();
  });

  it("final 뒤 스냅샷이 비어 있으면 메시지 없이 done(gateway)", async () => {
    const t = setup();
    const run = await t.enqueue();
    await t.flush();
    await t.orch.signal(run.id, { kind: "gateway_final" }, { message: "  " });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource: "gateway" });
    expect(t.db.select().from(messages).where(eq(messages.runId, run.id)).all()).toEqual([]);
    expect(t.eventsOf(run.id).at(-1)).toMatchObject({ type: "RUN_FINISHED", messageIds: [] });
    expect(t.onAgentMessage).not.toHaveBeenCalled();
    t.orch.stop();
  });

  it("queued 120초 안에 gateway_started 가 없으면 error(TIMEOUT)", async () => {
    const t = setup();
    const run = await t.enqueue();
    await t.flush();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(t.runOf(run.id).status).toBe("queued");
    await vi.advanceTimersByTimeAsync(1);

    expect(t.runOf(run.id)).toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
    expect(t.eventsOf(run.id).at(-1)).toMatchObject({ type: "RUN_ERROR", code: "TIMEOUT" });
    expect(systemMessages(t.db)).toEqual([
      expect.objectContaining({
        bodyMd: "@dev 실행이 실패했습니다: TIMEOUT",
        systemMeta: { kind: "run_error", runId: run.id },
      }),
    ]);
    t.orch.stop();
  });

  it("run 600초", async () => {
    const t = setup();
    const run = await t.enqueue();
    await t.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    await t.orch.signal(run.id, { kind: "gateway_started" });
    await vi.advanceTimersByTimeAsync(120_000); // queued 타이머는 gateway_started 에서 풀렸다
    expect(t.runOf(run.id).status).toBe("streaming");
    await t.orch.signal(run.id, { kind: "tool_start" });
    await vi.advanceTimersByTimeAsync(479_999);
    expect(t.runOf(run.id).status).toBe("tool");
    await vi.advanceTimersByTimeAsync(1);
    expect(t.runOf(run.id)).toMatchObject({
      status: "error",
      error: { code: "TIMEOUT", message: "run timeout" },
    });
    t.orch.stop();
  });

  it.each([
    ["queue_timeout", 120_000, false],
    ["run_timeout", 600_000, true],
  ])(
    "%s 로 닫은 런은 Gateway 런을 멈추고(abort, best-effort) 어댑터 추적을 버린다(forgetRun)",
    async (_kind, ms, started) => {
      const t = setup();
      const run = await t.enqueue();
      await t.flush();
      if (started) await t.orch.signal(run.id, { kind: "gateway_started" });
      const order: string[] = [];
      vi.spyOn(t.adapter, "abort").mockImplementation(async (runId, sessionKey) => {
        order.push("abort");
        t.adapter.calls.abort.push({ runId, sessionKey });
        throw new AdapterError("ADAPTER_UNAVAILABLE", "chat.abort: gateway not connected");
      });
      vi.spyOn(t.adapter, "forgetRun").mockImplementation((runId) => {
        order.push("forget");
        t.adapter.calls.forget.push(runId);
      });

      await vi.advanceTimersByTimeAsync(ms);

      expect(t.runOf(run.id)).toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
      expect(t.adapter.calls.abort).toEqual([{ runId: run.id, sessionKey: t.sessionKey }]);
      expect(t.adapter.calls.forget).toEqual([run.id]);
      expect(order).toEqual(["abort", "forget"]);
      // abort 실패는 warn 으로만 — 런은 이미 닫혔다
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run.id }),
        "adapter abort after timeout failed",
      );
      t.orch.stop();
    },
  );

  it.each([
    ["drop 으로 resolve", "drop"],
    ["reject", "reject"],
  ])(
    "stop() 뒤 늦게 끝난 send(%s)는 런을 건드리지 않는다 — 다음 부팅의 SERVER_RESTART 몫",
    async (_label, outcome) => {
      const t = setup();
      let settle: () => void = () => undefined;
      t.adapter.script(
        () =>
          new Promise((resolve, reject) => {
            settle = () =>
              outcome === "drop"
                ? resolve({ admission: "drop", reason: "bot-loop-protection" })
                : reject(new AdapterError("ADAPTER_UNAVAILABLE", "adapter closed"));
          }),
      );
      const run = await t.enqueue();
      await t.flush();
      expect(t.adapter.calls.send).toHaveLength(1);
      const eventsBefore = t.eventsOf(run.id);

      t.orch.stop();
      settle();
      await t.flush();

      expect(t.runOf(run.id)).toMatchObject({ status: "queued" });
      expect(t.runOf(run.id).error).toBeUndefined();
      expect(t.eventsOf(run.id)).toEqual(eventsBefore);
      expect(systemMessages(t.db)).toEqual([]);
      expect(t.logger.error).not.toHaveBeenCalled();
    },
  );

  it("어댑터가 drop 을 돌려주면 error(DROPPED:bot-loop-protection) 과 run_error 시스템 메시지", async () => {
    const t = setup();
    t.adapter.script(() => ({ admission: "drop", reason: "bot-loop-protection" }));
    const run = await t.enqueue();
    await t.flush();

    expect(t.runOf(run.id)).toMatchObject({
      status: "error",
      error: { code: "DROPPED:bot-loop-protection", message: "bot-loop-protection" },
    });
    expect(t.eventsOf(run.id).at(-1)).toMatchObject({
      type: "RUN_ERROR",
      code: "DROPPED:bot-loop-protection",
    });
    expect(systemMessages(t.db)).toEqual([
      expect.objectContaining({
        kind: "system",
        bodyMd: "@dev 이(가) 봇 루프 보호로 메시지를 받지 않았습니다",
        systemMeta: { kind: "run_error", runId: run.id },
      }),
    ]);
    // 드롭된 런은 queued 타이머를 남기지 않는다
    await vi.advanceTimersByTimeAsync(120_000);
    expect(systemMessages(t.db)).toHaveLength(1);
    t.orch.stop();
  });

  it("AdapterError(ADAPTER_UNAVAILABLE) 도 error 로 닫힌다", async () => {
    const t = setup();
    t.adapter.script(() => {
      throw new AdapterError("ADAPTER_UNAVAILABLE", "plugin not connected within 120000ms");
    });
    const first = await t.enqueue(t.say("@dev 하나"));
    const second = await t.enqueue(t.say("@dev 둘"));
    await t.flush();

    expect(t.runOf(first.id)).toMatchObject({ status: "error", error: { code: "ADAPTER_UNAVAILABLE" } });
    expect(systemMessages(t.db).map((m) => m.bodyMd)).toContain(
      "@dev 실행이 실패했습니다: ADAPTER_UNAVAILABLE",
    );
    // 앞 런이 실패로 끝나도 세션 큐는 다음 런을 보낸다
    expect(t.adapter.calls.send.map((s) => s.runId)).toEqual([first.id, second.id]);
    t.orch.stop();
  });

  it("send 거부는 gateway_started 뒤에 와도 런을 닫는다", async () => {
    const t = setup();
    t.adapter.script((input) => {
      t.adapter.emit({ kind: "run_signal", runId: input.runId, signal: { kind: "gateway_started" } });
      throw new AdapterError("TIMEOUT", "no ack after 4 attempts");
    });
    const run = await t.enqueue();
    await t.flush();

    expect(t.states.map((s) => s.status)).toEqual(["queued", "streaming", "error"]);
    expect(t.runOf(run.id)).toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
    // run 타이머도 풀렸다
    await vi.advanceTimersByTimeAsync(600_000);
    expect(t.states).toHaveLength(3);
    t.orch.stop();
  });

  it.each([
    [new AdapterError("INTERNAL", "ADAPTER_PROTOCOL: data: expected object"), "ADAPTER_PROTOCOL", true],
    [new AdapterError("VALIDATION", "bad inbound"), "ADAPTER_ERROR:VALIDATION", true],
    [new AdapterError("INTERNAL", "plugin crashed"), "ADAPTER_ERROR:INTERNAL", true],
    [new Error("unexpected"), "INTERNAL", false],
  ])("send 거부 %s → error(%s)", async (err, code, notifies) => {
    const t = setup();
    t.adapter.script(() => {
      throw err;
    });
    const run = await t.enqueue();
    await t.flush();
    expect(t.runOf(run.id)).toMatchObject({ status: "error", error: { code, message: err.message } });
    expect(systemMessages(t.db).map((m) => m.bodyMd)).toEqual(
      notifies ? [`@dev 실행이 실패했습니다: ${code}`] : [],
    );
    t.orch.stop();
  });

  it("상호작용 트리거는 runs.triggerInteractionId 를 채워 디스패치하고, 컨텍스트 조립 실패는 error(INTERNAL)", async () => {
    const t = setup();
    const card = t.say("카드");
    const interactionId = uuid();
    t.db
      .insert(componentInteractions)
      .values({
        id: interactionId,
        messageId: card.id,
        componentId: "cmp_1",
        userId: t.userId,
        itemId: "ok",
        values: {},
        createdAt: new Date(),
      })
      .run();
    const run = await t.orch.enqueueRun(
      {
        agentId: t.agentId,
        channelId: t.channelId,
        triggerKind: "interaction",
        rootMessageId: card.id,
        relayDepth: 0,
      },
      { interactionId, interactionText: "user=@owner pressed ok", interactionMessageId: card.id },
    );
    expect(run.triggerInteractionId).toBe(interactionId);
    expect(run.triggerMessageId).toBeUndefined();
    expect(t.adapter.calls.send[0]).toMatchObject({
      runId: run.id,
      kind: "interaction",
      message: { id: card.id, text: "user=@owner pressed ok", author: { handle: "owner" } },
    });

    // interactionId 없이 만든 상호작용 런은 buildInboundDeliver 가 던진다 → 런 단위 catch
    const broken = await t.orch.enqueueRun(
      {
        agentId: t.agentId,
        channelId: t.channelId,
        triggerKind: "interaction",
        rootMessageId: card.id,
        relayDepth: 0,
      },
      { interactionText: "x", interactionMessageId: card.id },
    );
    await t.orch.signal(run.id, { kind: "abort_requested" });
    await t.flush();
    expect(t.runOf(broken.id)).toMatchObject({ status: "error", error: { code: "INTERNAL" } });
    expect(t.adapter.calls.send.map((s) => s.runId)).toEqual([run.id]);
    expect(systemMessages(t.db)).toEqual([]);
    expect(t.logger.error).toHaveBeenCalled();
    t.orch.stop();
  });

  it("abort 는 adapter.abort 를 부르고 aborted 로 전이한다", async () => {
    const t = setup();
    const run = await t.enqueue();
    await t.flush();
    await t.orch.signal(run.id, { kind: "gateway_started" });
    await t.orch.abort(run.id);

    expect(t.adapter.calls.abort).toEqual([{ runId: run.id, sessionKey: t.sessionKey }]);
    expect(t.runOf(run.id)).toMatchObject({ status: "aborted", endedAt: expect.any(String) });
    expect(t.eventsOf(run.id).at(-1)).toMatchObject({ type: "RUN_ABORTED", by: "user" });
    expect(systemMessages(t.db)).toEqual([]);

    await t.orch.abort(run.id); // 이미 끝난 런은 아무것도 하지 않는다
    expect(t.adapter.calls.abort).toHaveLength(1);
    await expect(t.orch.abort(uuid())).rejects.toMatchObject({ body: { code: "NOT_FOUND" } });

    // 디스패치 전(세션 큐 대기) 런은 Gateway 에 보낸 적이 없어 어댑터를 부르지 않는다
    const head = await t.enqueue(t.say("@dev 하나"));
    const waiting = await t.enqueue(t.say("@dev 둘"));
    await t.orch.abort(waiting.id);
    expect(t.runOf(waiting.id).status).toBe("aborted");
    expect(t.adapter.calls.abort).toHaveLength(1);
    expect(t.adapter.calls.send.map((s) => s.runId)).toEqual([run.id, head.id]);
    t.orch.stop();
  });

  it("종료된 런에 늦게 온 정본은 runId 를 달아 저장만 하고 상태는 그대로", async () => {
    const t = setup();
    const run = await t.enqueue();
    await t.flush();
    await t.orch.signal(run.id, { kind: "gateway_started" });
    await t.orch.abort(run.id);
    const before = t.eventsOf(run.id);
    const statesBefore = t.states.length;
    // 종료 뒤 늦게 온 Gateway 이벤트·신호도 버린다
    t.adapter.emit({
      kind: "run_event",
      runId: run.id,
      event: { type: "TEXT_MESSAGE_CONTENT", runId: run.id, messageId: run.id, delta: "늦음" },
    });
    t.adapter.emit({ kind: "run_signal", runId: run.id, signal: { kind: "gateway_started" } });
    vi.advanceTimersByTime(50);

    const ack = await t.orch.onCanonical(t.outbound({ runId: run.id, text: "늦은 답" }));
    expect(getMessage(t.db, ack.messageId ?? "")).toMatchObject({ runId: run.id, bodyMd: "늦은 답" });
    expect(t.runOf(run.id)).toMatchObject({ status: "aborted", hasCanonical: false });
    expect(t.eventsOf(run.id)).toEqual(before);
    expect(t.states).toHaveLength(statesBefore);
    // 늦어도 릴레이 판단은 한다(스펙 8장)
    expect(t.onAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: ack.messageId }),
      expect.objectContaining({ id: run.id }),
    );
    t.orch.stop();
  });

  it("recoverOnBoot 는 종료되지 않은 런을 SERVER_RESTART 로 닫고 개수를 돌려준다", async () => {
    const t = setup();
    // 이 프로세스가 방금 enqueue 한 런은 닫지 않는다
    const mine = await t.enqueue();
    expect(await t.orch.recoverOnBoot()).toBe(0);
    expect(t.runOf(mine.id).status).toBe("queued");
    t.orch.stop();
    const make = (status: Run["status"]) => {
      const run = insertRun(t.db, {
        channelId: t.channelId,
        agentId: t.agentId,
        triggerKind: "mention",
        rootMessageId: uuid(),
        relayDepth: 0,
        sessionKey: t.sessionKey,
        createdAt: new Date(),
      });
      return status === "queued" ? run : updateRun(t.db, run.id, { status });
    };
    const open = [mine, make("queued"), make("streaming"), make("finalizing")];
    const closed = make("done");

    const rebootAdapter = new FakeAdapter();
    const rebooted = createOrchestrator({
      db: t.db,
      bus: t.bus,
      adapter: rebootAdapter,
      logger: t.logger as unknown as OrchestratorLogger,
      onAgentMessage: t.onAgentMessage,
    });
    expect(await rebooted.recoverOnBoot()).toBe(4);

    for (const run of open) {
      expect(t.runOf(run.id)).toMatchObject({
        status: "error",
        error: { code: "SERVER_RESTART" },
        endedAt: expect.any(String),
      });
      expect(
        t
          .eventsOf(run.id)
          .map((e) => e.type)
          .slice(-2),
      ).toEqual(["STATE_SNAPSHOT", "RUN_ERROR"]);
    }
    expect(t.runOf(closed.id).status).toBe("done");
    expect(systemMessages(t.db)).toEqual([]);
    // 부팅 정리는 어댑터 연결 전이다 — Gateway abort·forgetRun 을 부르지 않는다
    expect(rebootAdapter.calls.abort).toEqual([]);
    expect(rebootAdapter.calls.forget).toEqual([]);
    expect(rebooted.activeRuns(t.channelId)).toEqual([]);
    expect(await rebooted.recoverOnBoot()).toBe(0);
    rebooted.stop();
  });

  it("maxInflight(2)를 넘는 런은 앞 런이 끝날 때까지 send 되지 않는다", async () => {
    const t = setup({ timeouts: { maxInflight: 2, queuedMs: undefined } }); // undefined 는 기본값을 덮지 않는다
    const other1 = seedChannelWithAgent(t.db);
    const other2 = seedChannelWithAgent(t.db);
    const a = await t.enqueue();
    const b = await t.enqueue(t.say("@dev hi", other1), { agentId: other1.agentId });
    const c = await t.enqueue(t.say("@dev hi", other2), { agentId: other2.agentId });
    await t.flush();
    expect(t.adapter.calls.send.map((s) => s.runId)).toEqual([a.id, b.id]);
    expect(t.orch.activeRuns(t.channelId)).toEqual([expect.objectContaining({ id: a.id, status: "queued" })]);
    expect(t.orch.activeRuns(other2.channelId)).toEqual([
      expect.objectContaining({ id: c.id, status: "queued" }),
    ]);

    await t.orch.signal(b.id, { kind: "gateway_aborted" });
    expect(t.adapter.calls.send.map((s) => s.runId)).toEqual([a.id, b.id, c.id]);
    expect(t.eventsOf(b.id).at(-1)).toMatchObject({ type: "RUN_ABORTED", by: "gateway" });
    t.orch.stop();
  });

  it("런을 못 찾는 정본은 런 없이 저장되고 warn 로그", async () => {
    const t = setup();
    const ack = await t.orch.onCanonical(t.outbound({ text: "혼잣말", replyToInboundId: uuid() }));
    expect(getMessage(t.db, ack.messageId ?? "")).toMatchObject({ authorId: t.agentId, bodyMd: "혼잣말" });
    expect(getMessage(t.db, ack.messageId ?? "")?.runId).toBeUndefined();
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outboundId: expect.any(String), messageId: ack.messageId }),
      "canonical message without run",
    );
    expect(t.onAgentMessage).not.toHaveBeenCalled();

    // 모르는 에이전트의 정본은 저장하지 않고 거부한다
    await expect(t.orch.onCanonical(t.outbound({ agentId: "ghost" }))).rejects.toMatchObject({
      body: { code: "NOT_FOUND" },
    });
    t.orch.stop();
  });

  it("정본 상관관계: runId 가 없으면 세션의 미종료 런, 그다음 replyToInboundId 가 트리거한 런", async () => {
    const t = setup();
    const trigger = t.say("@dev 하나");
    const run = await t.enqueue(trigger);
    await t.flush();
    const bySession = await t.orch.onCanonical(t.outbound());
    expect(getMessage(t.db, bySession.messageId ?? "")?.runId).toBe(run.id);

    await t.orch.signal(run.id, { kind: "gateway_final" });
    expect(t.runOf(run.id).status).toBe("done");
    const byReply = await t.orch.onCanonical(
      t.outbound({ sessionKey: "agent:dev:dodok:channel:other", replyToInboundId: trigger.id }),
    );
    expect(getMessage(t.db, byReply.messageId ?? "")?.runId).toBe(run.id);

    // 다른 채널의 런 id 를 달고 와도 그 런에 붙이지 않는다
    const second = createChannel(t.db, { workspaceId: t.workspaceId, createdBy: t.userId, name: "second" });
    addMember(t.db, second.id, { memberType: "agent", memberId: t.agentId }, t.logger);
    const crossed = await t.orch.onCanonical(
      t.outbound({ channelId: second.id, runId: run.id, sessionKey: `agent:dev:dodok:channel:${second.id}` }),
    );
    expect(getMessage(t.db, crossed.messageId ?? "")).toMatchObject({
      channelId: second.id,
      authorId: t.agentId,
    });
    expect(getMessage(t.db, crossed.messageId ?? "")?.runId).toBeUndefined();
    t.orch.stop();
  });

  it("Gateway 가 먼저 보낸 RUN_ERROR·RUN_ABORTED 는 종료 전이에서 다시 만들지 않는다", async () => {
    const t = setup();
    const errored = await t.enqueue(t.say("@dev 하나"));
    await t.flush();
    t.adapter.emit({
      kind: "run_event",
      runId: errored.id,
      event: { type: "RUN_ERROR", runId: errored.id, message: "provider failed", code: "provider_error" },
    });
    t.adapter.emit({
      kind: "run_signal",
      runId: errored.id,
      signal: { kind: "gateway_error", code: "provider_error", message: "provider failed" },
    });
    expect(t.eventsOf(errored.id).map((e) => e.type)).toEqual(["RUN_QUEUED", "RUN_ERROR", "STATE_SNAPSHOT"]);
    expect(systemMessages(t.db)).toEqual([]); // Gateway 오류는 런 버블로 보인다

    const aborted = await t.enqueue(t.say("@dev 둘"));
    await t.flush();
    t.adapter.emit({
      kind: "run_event",
      runId: aborted.id,
      event: { type: "RUN_ABORTED", runId: aborted.id, by: "gateway" },
    });
    t.adapter.emit({ kind: "run_signal", runId: aborted.id, signal: { kind: "gateway_aborted" } });
    expect(t.eventsOf(aborted.id).map((e) => e.type)).toEqual([
      "RUN_QUEUED",
      "RUN_ABORTED",
      "STATE_SNAPSHOT",
    ]);
    t.orch.stop();
  });

  it("라우팅을 기다리는 사이 finalizing 이 끝나도 이미 저장된 정본이 있으면 스냅샷 메시지를 만들지 않는다", async () => {
    const t = setup();
    const run = await t.enqueue();
    await t.flush();
    await t.orch.signal(run.id, { kind: "gateway_final" }, { message: "snapshot" });
    t.onAgentMessage.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 20_000)));
    const pendingAck = t.orch.onCanonical(t.outbound({ runId: run.id, text: "정본" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource: "gateway" });
    await vi.advanceTimersByTimeAsync(10_000);
    const ack = await pendingAck;
    const bodies = t.db
      .select()
      .from(messages)
      .where(eq(messages.runId, run.id))
      .all()
      .map((m) => m.bodyMd);
    expect(bodies).toEqual(["정본"]);
    expect(t.eventsOf(run.id).at(-1)).toMatchObject({ type: "RUN_FINISHED", messageIds: [ack.messageId] });
    t.orch.stop();
  });

  it("usage CUSTOM 은 저장하지 않고 runs.usage 를 갱신하고, 어댑터 status 는 bus adapter.status 로", async () => {
    const t = setup();
    const statuses: AdapterStatus[] = [];
    t.bus.on("adapter.status", (s) => statuses.push(s));
    const run = await t.enqueue();
    await t.flush();
    t.adapter.emit({
      kind: "run_event",
      runId: run.id,
      event: {
        type: "CUSTOM",
        runId: run.id,
        name: "openclaw.usage",
        value: { inputTokens: 10, outputTokens: 5, model: "m" },
      },
    });
    expect(t.runOf(run.id).usage).toEqual({ inputTokens: 10, outputTokens: 5, model: "m" });
    expect(t.eventsOf(run.id).map((e) => e.type)).toEqual(["RUN_QUEUED"]);

    const status: AdapterStatus = { provider: "openclaw", gateway: "reconnecting", bridge: "down" };
    t.adapter.emit({
      kind: "status",
      status,
      capabilities: { sessionReset: true, agentsList: true, configSet: true },
    });
    expect(statuses).toEqual([status]);

    t.orch.stop();
    t.adapter.emit({ kind: "status", status, capabilities: t.adapter.capabilities() });
    expect(statuses).toHaveLength(1); // stop 뒤엔 구독 해제
  });
});
