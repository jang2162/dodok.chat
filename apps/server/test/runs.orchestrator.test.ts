import { AdapterError } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import type { AdapterStatus, Message, OutboundMessage, Run, RunEvent, RunState } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEventBody } from "../src/adapters/types";
import type { DbOrTx } from "../src/db/client";
import { agents, attachments, componentInteractions, messages } from "../src/db/schema.sqlite";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage, getMessage, rowToMessage } from "../src/modules/messages/service";
import type { RunPlan } from "../src/modules/router/decide";
import {
  type OrchestratorDeps,
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

/** 브리지가 올린 미묶음 첨부 행 — 블롭 없이 묶기만 볼 때 */
function bridgeAttachment(db: DbOrTx, channelId: string): string {
  const id = uuid();
  db.insert(attachments)
    .values({
      id,
      channelId,
      uploaderType: "bridge",
      uploaderId: null,
      kind: "file",
      name: "r.pdf",
      mime: "application/pdf",
      size: 10,
      sha256: "0".repeat(64),
      messageId: null,
      createdAt: new Date(),
    })
    .run();
  return id;
}

function setup(opts: { timeouts?: Partial<RunTimeouts>; approvals?: OrchestratorDeps["approvals"] } = {}) {
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
    ...(opts.approvals ? { approvals: opts.approvals } : {}),
  });

  let n = 0;
  const say = (bodyMd = "@dev 안녕", at: Ids = ids, threadRootId?: string) =>
    createUserMessage(db, bus, {
      channelId: at.channelId,
      authorId: at.userId,
      bodyMd,
      clientMsgId: `c${++n}`,
      threadRootId,
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
    attachmentIds: [],
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

  describe("스트리밍 델타의 MEDIA: 줄(결함 A) — 저장·팬아웃 전에 걷는다", () => {
    async function streaming() {
      const t = setup();
      const run = await t.enqueue();
      await t.flush();
      await t.orch.signal(run.id, { kind: "gateway_started" });
      const emit = (event: RunEventBody) => t.adapter.emit({ kind: "run_event", runId: run.id, event });
      const content = (delta: string) =>
        emit({ type: "TEXT_MESSAGE_CONTENT", runId: run.id, messageId: run.id, delta });
      const texts = (events: RunEvent[]) =>
        events
          .filter((e) => e.type === "TEXT_MESSAGE_CONTENT" || e.type === "TEXT_MESSAGE_REPLACE")
          .map((e) =>
            e.type === "TEXT_MESSAGE_CONTENT"
              ? e.delta
              : `=${e.type === "TEXT_MESSAGE_REPLACE" ? e.text : ""}`,
          );
      return { t, run, emit, content, texts };
    }

    it("쪼개진 MEDIA: 줄은 run_events 에도 팬아웃에도 없고, 정본은 그대로 저장된다", async () => {
      const { t, run, emit, content, texts } = await streaming();
      for (const d of ["끝났어요.\n\n", "MEDIA:/Users/someone", "/.openclaw-d", "ev/workspace/hello.txt"]) {
        content(d);
        vi.advanceTimersByTime(60); // 조각마다 따로 flush 되는 최악의 경우
      }
      emit({ type: "TEXT_MESSAGE_END", runId: run.id, messageId: run.id });
      await t.orch.signal(
        run.id,
        { kind: "gateway_final" },
        { message: "끝났어요.\n\nMEDIA:/Users/someone/.openclaw-dev/workspace/hello.txt" },
      );
      await t.orch.onCanonical(t.outbound({ text: "끝났어요.", runId: run.id }));
      await t.flush();

      expect(texts(t.eventsOf(run.id))).toEqual(["끝났어요.\n\n"]);
      expect(JSON.stringify(t.eventsOf(run.id))).not.toContain("/Users/");
      expect(JSON.stringify(t.events)).not.toContain("/Users/");
      expect(t.runOf(run.id).status).toBe("done");
      t.orch.stop();
    });

    it("M 으로 시작하는 보통 줄은 두 번째 글자에서 풀려나 첫 코얼레싱 창에 나간다", async () => {
      const { t, run, content, texts } = await streaming();
      content("M");
      content("a");
      vi.advanceTimersByTime(50);
      expect(texts(t.eventsOf(run.id))).toEqual(["Ma"]);
      content("rkdown");
      vi.advanceTimersByTime(50);
      expect(texts(t.eventsOf(run.id))).toEqual(["Ma", "rkdown"]);
      t.orch.stop();
    });

    it("붙잡은 접두(MEDI)는 TEXT_MESSAGE_END 보다 먼저 나간다", async () => {
      const { t, run, emit, content } = await streaming();
      content("보통\nMEDI");
      emit({ type: "TEXT_MESSAGE_END", runId: run.id, messageId: run.id });
      expect(
        t
          .eventsOf(run.id)
          .filter((e) => e.type === "TEXT_MESSAGE_CONTENT" || e.type === "TEXT_MESSAGE_END")
          .map((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? e.delta : e.type)),
      ).toEqual(["보통\nMEDI", "TEXT_MESSAGE_END"]);
      t.orch.stop();
    });

    it("END 없이 끝난 런(오류·중지) — 붙잡은 MEDIA: 줄은 버리고 접두는 종료 이벤트 전에 내보낸다", async () => {
      const a = await streaming();
      a.content("앞\nMEDIA:/Users/x/a.png");
      await a.t.orch.signal(a.run.id, { kind: "gateway_error", code: "boom", message: "x" });
      expect(a.texts(a.t.eventsOf(a.run.id))).toEqual(["앞\n"]);
      expect(JSON.stringify(a.t.events)).not.toContain("/Users/");
      a.t.orch.stop();

      const b = await streaming();
      b.content("앞\nME");
      await b.t.orch.abort(b.run.id);
      const types = b.t.eventsOf(b.run.id).map((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? e.delta : e.type));
      expect(types.slice(types.indexOf("앞\nME"))).toContain("RUN_ABORTED");
      expect(b.texts(b.t.eventsOf(b.run.id))).toEqual(["앞\nME"]);
      b.t.orch.stop();
    });

    it("TEXT_MESSAGE_REPLACE 본문의 MEDIA: 줄도 걷고, 이어지는 델타는 그 뒤에서 판정한다", async () => {
      const { t, run, emit, content, texts } = await streaming();
      emit({
        type: "TEXT_MESSAGE_REPLACE",
        runId: run.id,
        messageId: run.id,
        text: "가\nMEDIA:/Users/x/a\n나\nMEDIA:/Us",
      });
      content("ers/y/b.png\n다");
      vi.advanceTimersByTime(50);
      expect(texts(t.eventsOf(run.id))).toEqual(["=가\n나\n", "다"]);
      expect(JSON.stringify(t.events)).not.toContain("/Users/");
      t.orch.stop();
    });

    /** 「stream media lines dropped」 줄의 runId·mediaLinesDropped */
    const droppedLines = (t: ReturnType<typeof setup>) =>
      t.logger.info.mock.calls
        .filter((c) => c[1] === "stream media lines dropped")
        .map((c) => c[0] as { runId: string; mediaLinesDropped: number });

    it("끝난 런의 필터는 남지 않는다 — END·종료 전이가 치운 필터를 stop() 이 다시 판정하지 않는다", async () => {
      // END 뒤 done
      const a = await streaming();
      a.content("앞\nMEDIA:/Users/x/a.png\n뒤");
      a.emit({ type: "TEXT_MESSAGE_END", runId: a.run.id, messageId: a.run.id });
      await a.t.orch.signal(a.run.id, { kind: "gateway_final" });
      await a.t.orch.onCanonical(a.t.outbound({ text: "앞\n뒤", runId: a.run.id }));
      await a.t.flush();
      expect(a.t.runOf(a.run.id).status).toBe("done");
      const seqA = a.t.eventsOf(a.run.id).length;
      a.t.orch.stop();
      expect(droppedLines(a.t)).toEqual([{ runId: a.run.id, mediaLinesDropped: 1 }]);
      expect(a.t.eventsOf(a.run.id)).toHaveLength(seqA);

      // END 없이 오류로 끝난 런 — 붙잡은 MEDIA: 줄을 종료 전이가 판정한다
      const b = await streaming();
      b.content("앞\nMEDIA:/Users/x/a.png");
      await b.t.orch.signal(b.run.id, { kind: "gateway_error", code: "boom", message: "x" });
      const seqB = b.t.eventsOf(b.run.id).length;
      b.t.orch.stop();
      expect(droppedLines(b.t)).toEqual([{ runId: b.run.id, mediaLinesDropped: 1 }]);
      expect(b.t.eventsOf(b.run.id)).toHaveLength(seqB);
    });

    it("REPLACE 가 버리는 이전 필터가 걷은 줄 수도 로그에 남는다", async () => {
      const { t, run, emit, content } = await streaming();
      content("가\nMEDIA:/Users/x/a\n");
      emit({
        type: "TEXT_MESSAGE_REPLACE",
        runId: run.id,
        messageId: run.id,
        text: "나\nMEDIA:/Users/y/b\n",
      });
      emit({ type: "TEXT_MESSAGE_END", runId: run.id, messageId: run.id });
      expect(droppedLines(t).reduce((n, l) => n + l.mediaLinesDropped, 0)).toBe(2);
      t.orch.stop();
    });

    it("REPLACE 앞에 붙잡혀 있던 접두는 내보내지 않는다 — 본문이 통째 바뀌었다", async () => {
      const { t, run, emit, content, texts } = await streaming();
      content("보통\nMEDI");
      emit({ type: "TEXT_MESSAGE_REPLACE", runId: run.id, messageId: run.id, text: "새 본문" });
      expect(texts(t.eventsOf(run.id))).toEqual(["보통\n", "=새 본문"]);
      t.orch.stop();
    });

    it("TOOL_CALL_ARGS 델타는 건드리지 않는다(관찰 C, 이월)", async () => {
      const { t, run, emit } = await streaming();
      emit({ type: "TOOL_CALL_START", runId: run.id, toolCallId: "t1", toolCallName: "Write" });
      emit({ type: "TOOL_CALL_ARGS", runId: run.id, toolCallId: "t1", delta: "MEDIA:/Users/x" });
      vi.advanceTimersByTime(50);
      expect(t.eventsOf(run.id).filter((e) => e.type === "TOOL_CALL_ARGS")).toEqual([
        expect.objectContaining({ delta: "MEDIA:/Users/x" }),
      ]);
      t.orch.stop();
    });
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

  describe("Gateway 이벤트 없이 정본이 먼저 온 queued 런(Phase 1 실연 — 구독 누락·WS 단절)", () => {
    it("finalizing(RUN_STARTED·startedAt) 을 거쳐 10초 뒤 done(plugin) — run_error·스냅샷 메시지 없이 정본 1개", async () => {
      const t = setup();
      const trigger = t.say("@dev 요약해줘");
      const run = await t.enqueue(trigger);
      await t.flush();

      const ack = await t.orch.onCanonical(
        t.outbound({ runId: run.id, text: "정본", replyToInboundId: trigger.id }),
      );
      expect(t.runOf(run.id)).toMatchObject({ status: "finalizing", hasCanonical: true });
      expect(t.runOf(run.id).startedAt).toEqual(expect.any(String));
      expect(t.eventsOf(run.id).map((e) => e.type)).toEqual(["RUN_QUEUED", "RUN_STARTED", "STATE_SNAPSHOT"]);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(t.runOf(run.id).status).toBe("finalizing");
      await vi.advanceTimersByTimeAsync(1);

      expect(t.runOf(run.id)).toMatchObject({
        status: "done",
        finalSource: "plugin",
        endedAt: expect.any(String),
      });
      expect(t.runOf(run.id).error).toBeUndefined();
      expect(t.states.map((s) => s.status)).toEqual(["queued", "finalizing", "done"]);
      expect(t.states.at(-1)).toMatchObject({ status: "done", finalSource: "plugin" });
      expect(t.eventsOf(run.id).at(-1)).toMatchObject({ type: "RUN_FINISHED", messageIds: [ack.messageId] });
      const bodies = t.db
        .select()
        .from(messages)
        .where(eq(messages.runId, run.id))
        .all()
        .map((m) => m.bodyMd);
      expect(bodies).toEqual(["정본"]);
      expect(systemMessages(t.db)).toEqual([]);
      expect(t.onAgentMessage).toHaveBeenCalledTimes(1);
      // queued·run 타이머는 finalizing 에서 풀렸다 — 뒤에 TIMEOUT 이 붙지 않는다
      await vi.advanceTimersByTimeAsync(600_000);
      expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource: "plugin" });
      expect(systemMessages(t.db)).toEqual([]);
      t.orch.stop();
    });

    it("그 사이 gateway_final 이 오면 10초를 기다리지 않고 곧바로 done(plugin), 스냅샷은 버린다", async () => {
      const t = setup();
      const run = await t.enqueue();
      await t.flush();
      const ack = await t.orch.onCanonical(t.outbound({ runId: run.id, text: "정본" }));
      expect(t.runOf(run.id).status).toBe("finalizing");

      // 늦게 온 Gateway 시작·델타는 finalizing 을 되돌리지 않는다
      await t.orch.signal(run.id, { kind: "gateway_started" });
      await t.orch.signal(run.id, { kind: "text_delta" });
      expect(t.runOf(run.id).status).toBe("finalizing");

      await t.orch.signal(run.id, { kind: "gateway_final" }, { message: "스냅샷" });
      expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource: "plugin" });
      expect(t.states.map((s) => s.status)).toEqual(["queued", "finalizing", "done"]);
      expect(t.eventsOf(run.id).at(-1)).toMatchObject({ type: "RUN_FINISHED", messageIds: [ack.messageId] });

      await vi.advanceTimersByTimeAsync(10_000);
      const bodies = t.db
        .select()
        .from(messages)
        .where(eq(messages.runId, run.id))
        .all()
        .map((m) => m.bodyMd);
      expect(bodies).toEqual(["정본"]);
      expect(systemMessages(t.db)).toEqual([]);
      t.orch.stop();
    });

    it("정본만 오고 final_timeout 으로 done(plugin) 이 된 런은 60s 뒤 forgetRun, stop() 이 대기 타이머를 지운다", async () => {
      const t = setup();
      const run = await t.enqueue();
      await t.flush();
      await t.orch.onCanonical(t.outbound({ runId: run.id }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource: "plugin" });
      expect(t.adapter.calls.forget).toEqual([]);
      // 늦은 session.message usage 를 받을 만큼 기다린다
      await vi.advanceTimersByTimeAsync(59_999);
      expect(t.adapter.calls.forget).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.adapter.calls.forget).toEqual([run.id]);

      const second = await t.enqueue(t.say("@dev 둘"));
      await t.flush();
      await t.orch.onCanonical(t.outbound({ runId: second.id }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.runOf(second.id)).toMatchObject({ status: "done", finalSource: "plugin" });
      t.orch.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.adapter.calls.forget).toEqual([run.id]);
    });
  });

  it.each([
    ["final → 정본 없음 → 10s", "gateway", ["started", "final", "wait"]],
    ["정본 → final(finalizing 에서)", "plugin", ["canonical", "final"]],
    // 이미 닫힌 런에 늦게 온 final_timeout 은 무시된다 — applySignal 이 그 런을 돌려줘도 걸지 않는다
    ["정본 → final → 늦은 final_timeout", "plugin", ["canonical", "final", "late_timeout"]],
  ] as const)(
    "Gateway final 을 본 런(%s → done(%s))은 오케스트레이터가 forgetRun 하지 않는다 — 어댑터가 gateway_final 에서 이미 60s 지연 해제한다",
    async (_label, finalSource, steps) => {
      const t = setup();
      const run = await t.enqueue();
      await t.flush();
      for (const step of steps) {
        if (step === "started") await t.orch.signal(run.id, { kind: "gateway_started" });
        else if (step === "canonical") await t.orch.onCanonical(t.outbound({ runId: run.id }));
        else if (step === "final")
          await t.orch.signal(run.id, { kind: "gateway_final" }, { message: "스냅샷" });
        else if (step === "late_timeout") await t.orch.signal(run.id, { kind: "final_timeout" });
        else await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.adapter.calls.forget).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      t.orch.stop();
    },
  );

  it.each([
    // streaming 에서 정본은 hasCanonical 만 바꾼다(같은 상태의 run.state 가 한 번 더 나간다)
    [
      "정본 → final",
      "plugin",
      ["canonical", "final"],
      ["queued", "streaming", "streaming", "done"],
      ["정본"],
    ],
    [
      "final → 정본",
      "plugin",
      ["final", "canonical"],
      ["queued", "streaming", "finalizing", "done"],
      ["정본"],
    ],
    ["final → 10초", "gateway", ["final", "wait"], ["queued", "streaming", "finalizing", "done"], ["스냅샷"]],
  ] as const)(
    "streaming 경로(%s)는 그대로 — done(%s)",
    async (_label, finalSource, steps, statuses, bodies) => {
      const t = setup();
      const run = await t.enqueue();
      await t.flush();
      await t.orch.signal(run.id, { kind: "gateway_started" });
      for (const step of steps) {
        if (step === "canonical") await t.orch.onCanonical(t.outbound({ runId: run.id, text: "정본" }));
        else if (step === "final")
          await t.orch.signal(run.id, { kind: "gateway_final" }, { message: "스냅샷" });
        else await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource });
      expect(t.states.map((s) => s.status)).toEqual(statuses);
      expect(
        t.db
          .select()
          .from(messages)
          .where(eq(messages.runId, run.id))
          .all()
          .map((m) => m.bodyMd),
      ).toEqual(bodies);
      expect(systemMessages(t.db)).toEqual([]);
      t.orch.stop();
    },
  );

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

  it("승인 서비스 없이 awaiting_approval 에 들어가면 평소 런 상한으로 돌아간다", async () => {
    // deps.approvals 가 없으면 감시할 승인 행도 없다 — 시계를 아예 끄면 런이 영원히 산다
    const t = setup({ timeouts: { runMs: 50 } });
    const run = await t.enqueue();
    await t.flush();
    await t.orch.signal(run.id, { kind: "approval_requested" });
    expect(t.runOf(run.id).status).toBe("awaiting_approval");
    expect(t.logger.warn).toHaveBeenCalledWith(
      { runId: run.id },
      "awaiting approval without a pending approval row",
    );

    await vi.advanceTimersByTimeAsync(51);

    expect(t.runOf(run.id)).toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
    t.orch.stop();
  });

  it("승인 만료가 실패해 행이 그대로 남으면 감시를 다시 걸지 않고 평소 런 상한으로 돌아간다", async () => {
    // expireForRun 이 던지면(markApproval 오류) 만료 시각이 지난 행이 pending 으로 남는다.
    // 그 행으로 감시를 다시 걸면 0ms 로 무한히 돈다 — 런 시계가 상한을 맡는다(p2-t5 리뷰 이월 3)
    const expiresAt = new Date(Date.now() + 20_000);
    const approvals = {
      ingest: vi.fn(),
      cancelForRun: vi.fn(),
      expireForRun: vi.fn(() => {
        throw new Error("db is gone");
      }),
      earliestPendingExpiry: vi.fn(() => expiresAt),
    };
    const t = setup({ timeouts: { runMs: 50 }, approvals });
    const run = await t.enqueue();
    await t.flush();
    await t.orch.signal(run.id, { kind: "approval_requested" });
    expect(t.runOf(run.id).status).toBe("awaiting_approval");

    await vi.advanceTimersByTimeAsync(25_000); // 만료 + 5초 — 감시 타이머가 울린다
    expect(approvals.expireForRun).toHaveBeenCalledTimes(1);
    expect(t.logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error), runId: run.id },
      "approval expiry failed",
    );
    expect(t.runOf(run.id).status).toBe("awaiting_approval"); // 아무것도 닫히지 않았다

    await vi.advanceTimersByTimeAsync(51);

    expect(t.runOf(run.id)).toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
    expect(approvals.expireForRun).toHaveBeenCalledTimes(1); // 감시를 다시 걸지 않았다
    t.orch.stop();
  });

  it("run_timeout 은 같은 세션의 다음 런을 보내기 전에 Gateway abort 를 먼저 보낸다", async () => {
    const t = setup({ timeouts: { runMs: 50 } });
    const first = await t.enqueue();
    const second = await t.enqueue(); // 같은 세션 — 대기
    await t.flush();
    await t.orch.signal(first.id, { kind: "gateway_started" });
    expect(t.adapter.calls.send.map((s) => s.runId)).toEqual([first.id]);
    const order: string[] = [];
    const send = t.adapter.send.bind(t.adapter);
    vi.spyOn(t.adapter, "send").mockImplementation((input, ...rest) => {
      order.push(`send:${input.runId}`);
      return send(input, ...rest);
    });
    vi.spyOn(t.adapter, "abort").mockImplementation(async (runId, sessionKey) => {
      order.push(`abort:${runId}`);
      t.adapter.calls.abort.push({ runId, sessionKey });
    });

    await vi.advanceTimersByTimeAsync(50);

    expect(order).toEqual([`abort:${first.id}`, `send:${second.id}`]);
    expect(t.runOf(first.id)).toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
    expect(t.adapter.calls.forget).toEqual([first.id]);
    expect(t.logger.warn).not.toHaveBeenCalledWith(expect.anything(), "adapter abort after timeout failed");
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
    ["늦은 dispatch ack", "resolve"],
    ["어댑터의 forgotten 거부", "reject"],
  ])(
    "ack 전(send 대기 — 플러그인 없음 등)에 queuedMs 가 지나면 error(ADAPTER_UNAVAILABLE) + run_error, Gateway abort(best-effort) 뒤 어댑터 전송을 버리고(forgetRun) 세션의 다음 런을 보낸다 — 첫 send 는 %s 로 끝난다",
    async (_label, late) => {
      const t = setup();
      const acks = new Map<string, () => void>();
      const lates = new Map<string, () => void>();
      t.adapter.script(
        (input) =>
          new Promise((resolve, reject) => {
            acks.set(input.runId, () => resolve({ admission: "dispatch", providerRunId: input.runId }));
            lates.set(input.runId, () =>
              reject(new AdapterError("ADAPTER_UNAVAILABLE", "run forgotten before delivery")),
            );
          }),
      );
      const first = await t.enqueue(t.say("@dev 하나"));
      const second = await t.enqueue(t.say("@dev 둘"));
      await t.flush();
      expect(t.adapter.calls.send.map((s) => s.runId)).toEqual([first.id]);

      await vi.advanceTimersByTimeAsync(119_999);
      expect(t.runOf(first.id).status).toBe("queued");
      await vi.advanceTimersByTimeAsync(1);

      expect(t.runOf(first.id)).toMatchObject({ status: "error", error: { code: "ADAPTER_UNAVAILABLE" } });
      expect(t.eventsOf(first.id).at(-1)).toMatchObject({ type: "RUN_ERROR", code: "ADAPTER_UNAVAILABLE" });
      expect(systemMessages(t.db).map((m) => m.bodyMd)).toEqual([
        "@dev 실행이 실패했습니다: ADAPTER_UNAVAILABLE",
      ]);
      // 전달 도중 상한이 울렸을 수 있어 Gateway abort 는 best-effort 로 보내고, 어댑터가 기다리던 전송은 버린다(플러그인이 늦게 붙어도 보내지 않게)
      expect(t.adapter.calls.forget).toEqual([first.id]);
      expect(t.adapter.calls.abort).toEqual([{ runId: first.id, sessionKey: t.sessionKey }]);
      expect(t.adapter.calls.send.map((s) => s.runId)).toEqual([first.id, second.id]);

      // 늦게 끝난 첫 send 는 닫힌 런을 건드리지 않는다
      const eventsBefore = t.eventsOf(first.id);
      (late === "resolve" ? acks : lates).get(first.id)?.();
      await t.flush();
      expect(t.runOf(first.id)).toMatchObject({ status: "error", error: { code: "ADAPTER_UNAVAILABLE" } });
      expect(t.runOf(first.id).providerRunId).toBeUndefined();
      expect(t.eventsOf(first.id)).toEqual(eventsBefore);

      // 두 번째 런은 자기 전송부터 잰다 — 60s 뒤 ack 되면 그때부터 Gateway 시작 상한(queue_timeout → TIMEOUT)
      await vi.advanceTimersByTimeAsync(60_000);
      acks.get(second.id)?.();
      await t.flush();
      await vi.advanceTimersByTimeAsync(119_999);
      expect(t.runOf(second.id).status).toBe("queued");
      await vi.advanceTimersByTimeAsync(1);
      expect(t.runOf(second.id)).toMatchObject({ status: "error", error: { code: "TIMEOUT" } });
      expect(t.adapter.calls.abort).toEqual([
        { runId: first.id, sessionKey: t.sessionKey },
        { runId: second.id, sessionKey: t.sessionKey },
      ]);
      expect(t.logger.error).not.toHaveBeenCalled();
      expect(t.logger.warn).not.toHaveBeenCalledWith(expect.anything(), "run dispatch failed");
      t.orch.stop();
    },
  );

  it("ack 가 queuedMs 안에 오면 ack 전 상한은 풀리고, gateway_started 가 ack 보다 먼저 와도 런은 닫히지 않는다", async () => {
    const t = setup();
    let ack: () => void = () => undefined;
    t.adapter.script(
      (input) =>
        new Promise((resolve) => {
          ack = () => resolve({ admission: "dispatch", providerRunId: input.runId });
        }),
    );
    const run = await t.enqueue();
    await t.flush();
    await vi.advanceTimersByTimeAsync(100_000);
    // 플러그인은 런이 시작될 때 ack 한다 — Gateway 프레임이 먼저 올 수 있다
    await t.orch.signal(run.id, { kind: "gateway_started" });
    await vi.advanceTimersByTimeAsync(100_000);
    ack();
    await t.flush();
    await vi.advanceTimersByTimeAsync(100_000);

    expect(t.runOf(run.id)).toMatchObject({ status: "streaming", providerRunId: run.id });
    expect(t.runOf(run.id).error).toBeUndefined();
    expect(t.adapter.calls.forget).toEqual([]);
    expect(systemMessages(t.db)).toEqual([]);
    t.orch.stop();
  });

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

  it.each([
    ["AdapterError", new AdapterError("ADAPTER_UNAVAILABLE", "run forgotten before delivery"), false],
    ["그 밖의 예외", new TypeError("boom"), true],
  ])(
    "종료된 런의 늦은 send 거부 — %s 면 상태는 그대로 두고, 예상 밖 예외만 error 로그",
    async (_label, err, logsError) => {
      const t = setup();
      let fail: () => void = () => undefined;
      t.adapter.script(
        () =>
          new Promise((_resolve, reject) => {
            fail = () => reject(err);
          }),
      );
      const run = await t.enqueue();
      await t.flush();
      await t.orch.abort(run.id);
      const eventsBefore = t.eventsOf(run.id);

      fail();
      await t.flush();

      expect(t.runOf(run.id)).toMatchObject({ status: "aborted" });
      expect(t.runOf(run.id).error).toBeUndefined();
      expect(t.eventsOf(run.id)).toEqual(eventsBefore);
      const errorLines = t.logger.error.mock.calls.filter(
        (c) => c[1] === "run dispatch failed after run ended",
      );
      expect(errorLines).toEqual(
        logsError ? [[{ err, runId: run.id, status: "aborted" }, "run dispatch failed after run ended"]] : [],
      );
      if (!logsError) expect(t.logger.error).not.toHaveBeenCalled();
      expect(t.logger.debug).toHaveBeenCalledTimes(logsError ? 0 : 1);
      t.orch.stop();
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
        bodyMd: "@dev 가 봇 루프 보호로 메시지를 받지 않았습니다",
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

  it("ack 전(send 대기 중)에 abort 하면 어댑터가 쥔 전송을 버린다(forgetRun) — 플러그인이 늦게 붙어도 보내지 않는다", async () => {
    const t = setup();
    let ack: () => void = () => undefined;
    t.adapter.script(
      (input) =>
        new Promise((resolve) => {
          ack = () => resolve({ admission: "dispatch", providerRunId: input.runId });
        }),
    );
    const run = await t.enqueue();
    await t.flush();
    expect(t.adapter.calls.send.map((s) => s.runId)).toEqual([run.id]);

    await t.orch.abort(run.id);

    expect(t.runOf(run.id).status).toBe("aborted");
    expect(t.adapter.calls.forget).toEqual([run.id]);
    // 늦게 온 ack 는 닫힌 런을 건드리지 않는다
    const eventsBefore = t.eventsOf(run.id);
    ack();
    await t.flush();
    expect(t.runOf(run.id)).toMatchObject({ status: "aborted" });
    expect(t.eventsOf(run.id)).toEqual(eventsBefore);
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

  it("대문자로 저장된 providerAgentId — 런은 저장된 id 그대로 키를 만들고, 소문자 agentId 의 런 없는 정본도 그 에이전트에 붙는다", async () => {
    const t = setup();
    t.db.update(agents).set({ providerAgentId: "Dev" }).where(eq(agents.id, t.agentId)).run();
    const run = await t.enqueue();
    await t.flush();
    expect(t.runOf(run.id).status).toBe("queued");
    expect(t.adapter.calls.send).toEqual([
      expect.objectContaining({ runId: run.id, sessionKey: `agent:Dev:dodok:channel:${t.channelId}` }),
    ]);

    const ack = await t.orch.onCanonical(
      t.outbound({ text: "혼잣말", agentId: "dev", sessionKey: t.sessionKey }),
    );
    expect(getMessage(t.db, ack.messageId ?? "")).toMatchObject({ authorId: t.agentId, bodyMd: "혼잣말" });
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

  describe("폴백의 MEDIA: 줄(스펙 4.6)과 finalizing 상한 연장(Ruling 2)", () => {
    const bodiesOf = (t: ReturnType<typeof setup>, runId: string) =>
      t.db
        .select()
        .from(messages)
        .where(eq(messages.runId, runId))
        .all()
        .map((m) => m.bodyMd);
    const finalWith = async (t: ReturnType<typeof setup>, snapshot: string) => {
      const run = await t.enqueue();
      await t.flush();
      t.adapter.emit({ kind: "run_signal", runId: run.id, signal: { kind: "gateway_started" } });
      t.adapter.emit({
        kind: "run_signal",
        runId: run.id,
        signal: { kind: "gateway_final" },
        snapshotText: snapshot,
      });
      await t.flush();
      expect(t.runOf(run.id).status).toBe("finalizing");
      return run;
    };
    /** finalizing 이 정확히 ms 에 닫히는가 — ms-1 에는 열려 있고 ms 에 done */
    const closesAt = async (t: ReturnType<typeof setup>, runId: string, ms: number) => {
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(t.runOf(runId).status).toBe("finalizing");
      await vi.advanceTimersByTimeAsync(1);
      expect(t.runOf(runId).status).toBe("done");
    };

    it("스냅샷의 단독 줄 MEDIA: 를 걷고 저장한다 — 호스트 경로는 본문·로그에 남지 않고 걷은 수만 로그에", async () => {
      const t = setup();
      const run = await finalWith(t, "결과\n\nMEDIA:/Users/x/a.png");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource: "gateway" });
      expect(bodiesOf(t, run.id)).toEqual(["결과"]);
      expect(t.logger.warn).toHaveBeenCalledWith(
        { runId: run.id, mediaLinesDropped: 1 },
        "gateway snapshot media lines dropped",
      );
      const logged = JSON.stringify([t.logger.warn.mock.calls, t.logger.info.mock.calls]);
      expect(logged).not.toContain("/Users/x");
      expect(t.onAgentMessage).toHaveBeenCalledTimes(1);
      t.orch.stop();
    });

    it("스냅샷이 MEDIA: 줄뿐이면 메시지를 만들지 않고 done(gateway)", async () => {
      const t = setup();
      const run = await finalWith(t, "MEDIA:/Users/x/a.png\nMEDIA:/Users/x/b.png\n");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource: "gateway" });
      expect(bodiesOf(t, run.id)).toEqual([]);
      expect(t.onAgentMessage).not.toHaveBeenCalled();
      t.orch.stop();
    });

    it.each([
      ["MEDIA 없음 → 10초", "그냥 답", 10_000],
      ["MEDIA 2줄 → 70초", "답\nMEDIA:/a.png\nMEDIA:/b.png", 70_000],
      ["MEDIA 5줄 → 120초 상한", `답\n${"MEDIA:/a.png\n".repeat(5)}`, 120_000],
    ])("finalizing 상한: %s", async (_label, snapshot, ms) => {
      const t = setup();
      const run = await finalWith(t, snapshot);
      await closesAt(t, run.id, ms);
      t.orch.stop();
    });

    it("늘어난 상한 안에 정본이 오면 정본 하나만 남는다(같은 답 두 번 저장 없음)", async () => {
      const t = setup();
      const run = await finalWith(t, "답\nMEDIA:/Users/x/a.png\nMEDIA:/Users/x/b.png");
      await vi.advanceTimersByTimeAsync(40_000); // 옛 상한(10초)은 지났다 — 플러그인이 아직 올리는 중
      expect(t.runOf(run.id).status).toBe("finalizing");
      await t.orch.onCanonical(t.outbound({ runId: run.id, text: "답" }));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource: "plugin" });
      expect(bodiesOf(t, run.id)).toEqual(["답"]);
      t.orch.stop();
    });

    it("상한 연장은 주입한 timeouts 를 따른다(finalizingMs + 줄당 finalizingMediaLineMs, finalizingMaxMs 까지)", async () => {
      const t = setup({ timeouts: { finalizingMs: 100, finalizingMediaLineMs: 50, finalizingMaxMs: 180 } });
      const one = await finalWith(t, "a\nMEDIA:/x");
      await closesAt(t, one.id, 150);
      const t2 = setup({ timeouts: { finalizingMs: 100, finalizingMediaLineMs: 50, finalizingMaxMs: 180 } });
      const two = await finalWith(t2, "a\nMEDIA:/x\nMEDIA:/y");
      await closesAt(t2, two.id, 180);
      t.orch.stop();
      t2.orch.stop();
    });

    it("중복 gateway_final 은 상한을 다시 늘리지 않는다", async () => {
      const t = setup();
      const run = await finalWith(t, "답\nMEDIA:/a.png");
      await vi.advanceTimersByTimeAsync(30_000);
      t.adapter.emit({
        kind: "run_signal",
        runId: run.id,
        signal: { kind: "gateway_final" },
        snapshotText: "답\nMEDIA:/a.png",
      });
      await closesAt(t, run.id, 10_000);
      t.orch.stop();
    });

    it("정본의 attachmentIds — 같은 채널 브리지 첨부만 묶고, 빠진 id 는 outboundId 와 함께 경고 한 줄", async () => {
      const t = setup();
      const other = createChannel(t.db, { workspaceId: t.workspaceId, createdBy: t.userId, name: "other" });
      const ok = bridgeAttachment(t.db, t.channelId);
      const stray = bridgeAttachment(t.db, other.id);
      const run = await t.enqueue();
      await t.flush();
      const out = t.outbound({ runId: run.id, text: "", attachmentIds: [ok, stray] });
      const { messageId } = await t.orch.onCanonical(out);
      const stored = getMessage(t.db, messageId ?? "");
      expect(stored).toMatchObject({ bodyMd: "", attachments: [{ id: ok }] });
      expect(t.logger.warn).toHaveBeenCalledWith(
        { outboundId: out.outboundId, dropped: [stray] },
        "outbound attachments dropped",
      );
      // 본문 없는(미디어만) 정본도 라우팅된다
      expect(t.onAgentMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: messageId }),
        expect.anything(),
      );
      t.orch.stop();
    });
  });

  describe("진단 로그 — 본문·토큰 없이 런 종료 한 줄, 상한으로 닫힐 때 한 줄", () => {
    type Spy = ReturnType<typeof vi.fn>;
    const lines = (spy: Spy, msg: string) =>
      spy.mock.calls.filter((call) => call[1] === msg).map((call) => call[0] as Record<string, unknown>);
    /** 로그 객체의 키가 정확히 이것뿐이고, 어느 값에도 메시지 본문이 없다 */
    const expectOnlyKeys = (line: Record<string, unknown> | undefined, keys: string[], bodies: string[]) => {
      expect(Object.keys(line ?? {}).sort()).toEqual([...keys].sort());
      for (const body of bodies) expect(JSON.stringify(line)).not.toContain(body);
    };
    const ENDED_KEYS = ["runId", "channelId", "agentId", "status", "durationMs"];
    const TIMEOUT_KEYS = ["runId", "reason", "statusBefore", "elapsedMs"];

    it("done(plugin) — info 「run ended」 한 줄(finalSource·durationMs), 상한 줄 없음", async () => {
      const t = setup();
      const run = await t.enqueue(t.say("@dev 비밀 질문"));
      await t.flush();
      await t.orch.signal(run.id, { kind: "gateway_started" });
      await vi.advanceTimersByTimeAsync(3_000);
      await t.orch.onCanonical(t.outbound({ runId: run.id, text: "비밀 답" }));
      await t.orch.signal(run.id, { kind: "gateway_final" }, { message: "비밀 답" });

      const ended = lines(t.logger.info, "run ended");
      expect(ended).toEqual([
        {
          runId: run.id,
          channelId: t.channelId,
          agentId: t.agentId,
          status: "done",
          finalSource: "plugin",
          durationMs: 3_000,
        },
      ]);
      expectOnlyKeys(ended[0], [...ENDED_KEYS, "finalSource"], ["비밀 질문", "비밀 답"]);
      expect(lines(t.logger.warn, "run closed by timeout")).toEqual([]);
      expect(lines(t.logger.info, "run closed by timeout")).toEqual([]);
      t.orch.stop();
    });

    it("queue_timeout — warn 「run closed by timeout」(queued·120s) 뒤 info 「run ended」(error·TIMEOUT)", async () => {
      const t = setup();
      const run = await t.enqueue(t.say("@dev 비밀 질문"));
      await t.flush();
      await vi.advanceTimersByTimeAsync(120_000);

      const closed = lines(t.logger.warn, "run closed by timeout");
      expect(closed).toEqual([
        { runId: run.id, reason: "queue_timeout", statusBefore: "queued", elapsedMs: 120_000 },
      ]);
      expectOnlyKeys(closed[0], TIMEOUT_KEYS, ["비밀 질문"]);
      const ended = lines(t.logger.info, "run ended");
      expect(ended).toEqual([
        {
          runId: run.id,
          channelId: t.channelId,
          agentId: t.agentId,
          status: "error",
          errorCode: "TIMEOUT",
          durationMs: 120_000,
        },
      ]);
      expectOnlyKeys(ended[0], [...ENDED_KEYS, "errorCode"], ["비밀 질문", "queued timeout"]);
      // 원인(상한)이 결과(종료)보다 먼저 찍힌다
      const warnAt = t.logger.warn.mock.invocationCallOrder[
        t.logger.warn.mock.calls.findIndex((c) => c[1] === "run closed by timeout")
      ] as number;
      const infoAt = t.logger.info.mock.invocationCallOrder[
        t.logger.info.mock.calls.findIndex((c) => c[1] === "run ended")
      ] as number;
      expect(warnAt).toBeLessThan(infoAt);
      t.orch.stop();
    });

    it("run_timeout — warn(reason run_timeout, statusBefore tool)", async () => {
      const t = setup();
      const run = await t.enqueue();
      await t.flush();
      await vi.advanceTimersByTimeAsync(1_000);
      await t.orch.signal(run.id, { kind: "tool_start" });
      await vi.advanceTimersByTimeAsync(600_000);

      expect(lines(t.logger.warn, "run closed by timeout")).toEqual([
        { runId: run.id, reason: "run_timeout", statusBefore: "tool", elapsedMs: 601_000 },
      ]);
      expect(lines(t.logger.info, "run ended")).toEqual([
        expect.objectContaining({
          runId: run.id,
          status: "error",
          errorCode: "TIMEOUT",
          durationMs: 601_000,
        }),
      ]);
      t.orch.stop();
    });

    it("ack 전 상한 — warn(reason undelivered, statusBefore queued)", async () => {
      const t = setup();
      t.adapter.script(() => new Promise(() => undefined)); // ack 가 오지 않는다
      const run = await t.enqueue();
      await t.flush();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(lines(t.logger.warn, "run closed by timeout")).toEqual([
        { runId: run.id, reason: "undelivered", statusBefore: "queued", elapsedMs: 120_000 },
      ]);
      expect(lines(t.logger.info, "run ended")).toEqual([
        expect.objectContaining({ runId: run.id, status: "error", errorCode: "ADAPTER_UNAVAILABLE" }),
      ]);
      t.orch.stop();
    });

    it("final_timeout 은 정상 경로일 수 있어 info — 정본이 먼저 온 queued 런도, 스냅샷 경로도", async () => {
      const t = setup();
      const early = await t.enqueue(t.say("@dev 하나"));
      await t.flush();
      await t.orch.onCanonical(t.outbound({ runId: early.id, text: "비밀 답" }));
      await vi.advanceTimersByTimeAsync(10_000);
      const late = await t.enqueue(t.say("@dev 둘"));
      await t.flush();
      await t.orch.signal(late.id, { kind: "gateway_started" });
      await t.orch.signal(late.id, { kind: "gateway_final" }, { message: "비밀 스냅샷" });
      await vi.advanceTimersByTimeAsync(10_000);

      const closed = lines(t.logger.info, "run closed by timeout");
      expect(closed).toEqual([
        { runId: early.id, reason: "final_timeout", statusBefore: "finalizing", elapsedMs: 10_000 },
        { runId: late.id, reason: "final_timeout", statusBefore: "finalizing", elapsedMs: 10_000 },
      ]);
      for (const line of closed) expectOnlyKeys(line, TIMEOUT_KEYS, ["비밀 답", "비밀 스냅샷"]);
      expect(lines(t.logger.warn, "run closed by timeout")).toEqual([]);
      const ended = lines(t.logger.info, "run ended");
      expect(ended).toEqual([
        expect.objectContaining({
          runId: early.id,
          status: "done",
          finalSource: "plugin",
          durationMs: 10_000,
        }),
        expect.objectContaining({
          runId: late.id,
          status: "done",
          finalSource: "gateway",
          durationMs: 10_000,
        }),
      ]);
      for (const line of ended)
        expectOnlyKeys(line, [...ENDED_KEYS, "finalSource"], ["비밀 답", "비밀 스냅샷"]);
      t.orch.stop();
    });

    it("abort·Gateway 오류로 끝나도 「run ended」 한 줄, 상한 줄은 없다", async () => {
      const t = setup();
      const aborted = await t.enqueue(t.say("@dev 하나"));
      await t.flush();
      await t.orch.abort(aborted.id);
      const errored = await t.enqueue(t.say("@dev 둘"));
      await t.flush();
      await t.orch.signal(errored.id, {
        kind: "gateway_error",
        code: "provider_error",
        message: "비밀 오류 본문",
      });

      const ended = lines(t.logger.info, "run ended");
      expect(ended).toEqual([
        expect.objectContaining({ runId: aborted.id, status: "aborted" }),
        expect.objectContaining({ runId: errored.id, status: "error", errorCode: "provider_error" }),
      ]);
      expectOnlyKeys(ended[0], ENDED_KEYS, []);
      expectOnlyKeys(ended[1], [...ENDED_KEYS, "errorCode"], ["비밀 오류 본문"]);
      expect(lines(t.logger.warn, "run closed by timeout")).toEqual([]);
      t.orch.stop();
    });
  });

  describe("스레드 런", () => {
    /** 루트와 그 스레드 답글 @dev 로 스레드 런 하나 */
    async function threadRun(t: ReturnType<typeof setup>) {
      const root = t.say("루트");
      const reply = t.say("@dev 스레드", t, root.id);
      const run = await t.enqueue(reply, { threadRootId: root.id });
      return { root, reply, run };
    }

    it("스레드 세션 키·threadRootId 로 런을 만들고 인바운드에 threadId 를 싣는다 — 정본은 그 스레드에 저장", async () => {
      const t = setup();
      const { root, run } = await threadRun(t);
      await t.flush();
      const threadKey = `${t.sessionKey}:thread:${root.id}`;
      expect(run).toMatchObject({ sessionKey: threadKey, threadRootId: root.id });
      expect(t.states[0]).toMatchObject({ id: run.id, threadRootId: root.id });
      expect(t.adapter.calls.send).toEqual([
        expect.objectContaining({ runId: run.id, sessionKey: threadKey, threadId: root.id }),
      ]);
      const { messageId } = await t.orch.onCanonical(
        t.outbound({ runId: run.id, sessionKey: threadKey, threadId: root.id }),
      );
      expect(getMessage(t.db, messageId ?? "")).toMatchObject({ runId: run.id, threadRootId: root.id });
      t.orch.stop();
    });

    it("채널 런과 스레드 런은 세션 큐가 달라 동시에 send 된다", async () => {
      const t = setup();
      const channelRun = await t.enqueue();
      const { run } = await threadRun(t);
      await t.flush();
      expect(t.adapter.calls.send.map((d) => d.runId)).toEqual([channelRun.id, run.id]);
      t.orch.stop();
    });

    it("붙은 플러그인이 스레드를 모르면 send 없이 PLUGIN_OUTDATED — 스레드에 run_error 카드(다시 실행), 채널 런은 정상", async () => {
      const t = setup();
      t.adapter.setPluginCapabilities(["run_id_in_outbound", "config.set"]);
      const { root, run } = await threadRun(t);
      const channelRun = await t.enqueue();
      await t.flush();
      expect(t.runOf(run.id)).toMatchObject({ status: "error", error: { code: "PLUGIN_OUTDATED" } });
      expect(t.adapter.calls.send.map((d) => d.runId)).toEqual([channelRun.id]);
      expect(systemMessages(t.db)).toEqual([
        expect.objectContaining({
          threadRootId: root.id,
          bodyMd: "@dev 가 스레드에서 답하지 못했습니다 — 플러그인을 새로 설치해야 합니다(연결 페이지)",
          systemMeta: { kind: "run_error", runId: run.id },
          components: expect.objectContaining({
            blocks: [expect.objectContaining({ items: [expect.objectContaining({ id: "retry_run" })] })],
          }),
        }),
      ]);
      t.orch.stop();
    });

    it("붙은 플러그인이 없으면 PLUGIN_OUTDATED 로 단정하지 않고 보낸다(어댑터가 플러그인을 기다린다)", async () => {
      const t = setup();
      t.adapter.setPluginCapabilities([]);
      t.adapter.setSetupDetail({
        ...t.adapter.setupDetail(),
        bridge: { state: "down", plugin: null },
      });
      const { run } = await threadRun(t);
      await t.flush();
      expect(t.adapter.calls.send.map((d) => d.runId)).toEqual([run.id]);
      expect(t.runOf(run.id).status).toBe("queued");
      t.orch.stop();
    });

    it("정본의 threadId 가 세션 키·런의 스레드와 다르면 저장하지 않고 VALIDATION·warn", async () => {
      const t = setup();
      const { root, run } = await threadRun(t);
      await t.flush();
      const threadKey = `${t.sessionKey}:thread:${root.id}`;
      const other = t.say("다른 루트");
      const cases: Partial<OutboundMessage>[] = [
        { runId: run.id, sessionKey: threadKey }, // threadId 없음
        { runId: run.id, sessionKey: threadKey, threadId: other.id }, // 키와 다름
        { runId: run.id, sessionKey: `${t.sessionKey}:thread:${other.id}`, threadId: other.id }, // 런의 스레드와 다름
        { runId: run.id, sessionKey: t.sessionKey }, // 스레드 런에 채널 키
      ];
      for (const over of cases) {
        await expect(t.orch.onCanonical(t.outbound(over))).rejects.toMatchObject({
          body: { code: "VALIDATION" },
        });
      }
      expect(t.db.select().from(messages).where(eq(messages.kind, "normal")).all()).toHaveLength(3);
      expect(t.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run.id }),
        "canonical thread mismatch — rejected",
      );
      expect(t.runOf(run.id).hasCanonical).toBe(false);
      t.orch.stop();
    });

    it("스레드 런의 정본이 채널 키에 그 런의 threadId 를 실으면 거절한다(키 쪽 대조)", async () => {
      const t = setup();
      const { root, run } = await threadRun(t);
      await t.flush();
      await expect(
        t.orch.onCanonical(t.outbound({ runId: run.id, sessionKey: t.sessionKey, threadId: root.id })),
      ).rejects.toMatchObject({
        body: { code: "VALIDATION", message: expect.stringContaining("threadId does not match") },
      });
      expect(t.db.select().from(messages).where(eq(messages.kind, "normal")).all()).toHaveLength(2);
      t.orch.stop();
    });

    it("런 없는 정본은 세션 키의 스레드에 저장하고, 채널 키에 threadId 가 붙으면 거절한다", async () => {
      const t = setup();
      const root = t.say("루트");
      const { messageId } = await t.orch.onCanonical(
        t.outbound({ text: "혼잣말", sessionKey: `${t.sessionKey}:thread:${root.id}`, threadId: root.id }),
      );
      expect(getMessage(t.db, messageId ?? "")).toMatchObject({ authorId: t.agentId, threadRootId: root.id });
      expect(getMessage(t.db, messageId ?? "")?.runId).toBeUndefined();

      await expect(
        t.orch.onCanonical(t.outbound({ text: "샌 말", sessionKey: t.sessionKey, threadId: root.id })),
      ).rejects.toMatchObject({ body: { code: "VALIDATION" } });
      expect(t.db.select().from(messages).where(eq(messages.bodyMd, "샌 말")).all()).toEqual([]);
      t.orch.stop();
    });

    it("채널 런에 스레드 정본이 오면 거절한다", async () => {
      const t = setup();
      const run = await t.enqueue();
      await t.flush();
      const root = t.say("루트");
      await expect(
        t.orch.onCanonical(
          t.outbound({ runId: run.id, sessionKey: `${t.sessionKey}:thread:${root.id}`, threadId: root.id }),
        ),
      ).rejects.toMatchObject({ body: { code: "VALIDATION" } });
      t.orch.stop();
    });

    it("finalizing 상한의 스냅샷 메시지도 런의 스레드에 저장한다", async () => {
      const t = setup();
      const { root, run } = await threadRun(t);
      await t.flush();
      t.adapter.emit({ kind: "run_signal", runId: run.id, signal: { kind: "gateway_started" } });
      t.adapter.emit({
        kind: "run_signal",
        runId: run.id,
        signal: { kind: "gateway_final" },
        snapshotText: "스냅샷 답",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(t.runOf(run.id)).toMatchObject({ status: "done", finalSource: "gateway" });
      const stored = t.db.select().from(messages).where(eq(messages.runId, run.id)).all().map(rowToMessage);
      expect(stored).toEqual([expect.objectContaining({ bodyMd: "스냅샷 답", threadRootId: root.id })]);
      t.orch.stop();
    });
  });

  it("저장된 providerAgentId 가 세션 키 규칙 밖이면 런을 만들어 곧바로 error(INVALID_AGENT_ID) — 사유 있는 run_error 카드, send 없음", async () => {
    const t = setup();
    t.db.update(agents).set({ providerAgentId: "dev:main" }).where(eq(agents.id, t.agentId)).run();
    const run = await t.enqueue();
    await t.flush();
    expect(t.runOf(run.id)).toMatchObject({ status: "error", error: { code: "INVALID_AGENT_ID" } });
    expect(t.adapter.calls.send).toEqual([]);
    expect(t.eventsOf(run.id).map((e) => e.type)).toEqual(["RUN_QUEUED", "STATE_SNAPSHOT", "RUN_ERROR"]);
    expect(systemMessages(t.db)).toEqual([
      expect.objectContaining({
        bodyMd:
          "@dev 실행이 실패했습니다: OpenClaw 에이전트 id 가 세션 키 규칙(영문·숫자·_·-)에 맞지 않습니다 — 올바른 id 로 에이전트를 다시 등록하세요",
        systemMeta: { kind: "run_error", runId: run.id },
      }),
    ]);
    expect(systemMessages(t.db)[0]?.components).toBeUndefined();
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
