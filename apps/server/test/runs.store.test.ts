import { RunEvent } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { runEvents } from "../src/db/schema.sqlite";
import { createAgentMessage, createUserMessage } from "../src/modules/messages/service";
import {
  appendRunEvent,
  chainHashes,
  countRunsToday,
  findOpenRunBySession,
  findRunByTriggerMessage,
  getRun,
  insertRun,
  listOpenRuns,
  listRunEvents,
  listRunMessageIds,
  toRunState,
  updateRun,
} from "../src/modules/runs/store";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const ids = seedChannelWithAgent(db);
  const sessionKey = `agent:dev:dodok:channel:${ids.channelId}`;
  const newRun = (over: Partial<Parameters<typeof insertRun>[1]> = {}) =>
    insertRun(db, {
      channelId: ids.channelId,
      agentId: ids.agentId,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth: 0,
      sessionKey,
      createdAt: new Date(),
      ...over,
    });
  return { db, bus, sessionKey, newRun, ...ids };
}

describe("runs store", () => {
  it("스레드 런은 thread_root_id 를 저장하고 Run·RunState 가 싣는다", () => {
    const { newRun, db } = setup();
    const threadRootId = uuid();
    const run = newRun({ threadRootId });
    expect(run.threadRootId).toBe(threadRootId);
    expect(getRun(db, run.id)?.threadRootId).toBe(threadRootId);
    expect(toRunState(run).threadRootId).toBe(threadRootId);
    expect(newRun()).not.toHaveProperty("threadRootId", expect.anything());
  });

  it("insertRun 은 queued 행을 만들고 getRun·updateRun 이 Run 도메인으로 돌려준다", () => {
    const { db, newRun, channelId, agentId, sessionKey } = setup();
    const triggerInteractionId = uuid();
    const run = newRun({ triggerKind: "interaction", triggerInteractionId, relayHash: "h1" });
    expect(run).toEqual({
      id: run.id,
      channelId,
      agentId,
      triggerKind: "interaction",
      triggerInteractionId,
      rootMessageId: run.rootMessageId,
      relayDepth: 0,
      sessionKey,
      status: "queued",
      hasCanonical: false,
      createdAt: run.createdAt,
    });
    expect(getRun(db, run.id)).toEqual(run);
    expect(getRun(db, uuid())).toBeUndefined();

    const endedAt = new Date("2026-09-15T03:00:00.000Z");
    const updated = updateRun(db, run.id, {
      status: "error",
      error: { code: "TIMEOUT", message: "queued timeout" },
      providerRunId: "p-1",
      usage: { inputTokens: 3 },
      endedAt,
    });
    expect(updated).toMatchObject({
      status: "error",
      error: { code: "TIMEOUT", message: "queued timeout" },
      providerRunId: "p-1",
      usage: { inputTokens: 3 },
      endedAt: endedAt.toISOString(),
    });
    expect(getRun(db, run.id)).toEqual(updated);
    expect(() => updateRun(db, uuid(), { status: "done" })).toThrow();
  });

  it("appendRunEvent 는 런별로 seq 를 1부터 매기고 listRunEvents 는 afterSeq 초과를 순서대로 준다", () => {
    const { db, newRun } = setup();
    const a = newRun();
    const b = newRun();
    const ts = new Date("2026-09-15T01:00:00.000Z");
    const first = appendRunEvent(db, a.id, { type: "RUN_QUEUED", runId: a.id, position: 0 }, ts);
    expect(first).toEqual({ type: "RUN_QUEUED", runId: a.id, position: 0, seq: 1, ts: ts.toISOString() });
    appendRunEvent(db, b.id, { type: "RUN_QUEUED", runId: b.id }, ts);
    const second = appendRunEvent(
      db,
      a.id,
      { type: "TEXT_MESSAGE_CONTENT", runId: a.id, messageId: "m", delta: "hi" },
      ts,
    );
    expect(second.seq).toBe(2);
    expect(appendRunEvent(db, b.id, { type: "STEP_STARTED", runId: b.id, stepName: "x" }, ts).seq).toBe(2);

    expect(listRunEvents(db, a.id, 0)).toEqual([first, second]);
    expect(listRunEvents(db, a.id, 1)).toEqual([second]);
    expect(listRunEvents(db, a.id, 2)).toEqual([]);
    for (const e of listRunEvents(db, b.id, 0)) expect(RunEvent.safeParse(e).success).toBe(true);
    // 계약을 어긴 이벤트는 저장하지 않는다
    expect(() =>
      appendRunEvent(db, a.id, { type: "TEXT_MESSAGE_CONTENT", runId: a.id, messageId: "m", delta: "" }, ts),
    ).toThrow();
    expect(db.select().from(runEvents).all()).toHaveLength(4);
  });

  it("findOpenRunBySession 은 그 연결·세션의 가장 오래된 미종료 런, listOpenRuns 는 미종료 전부", () => {
    const { db, newRun, sessionKey } = setup();
    const t = (s: number) => new Date(Date.UTC(2026, 8, 15, 0, 0, s));
    const done = newRun({ createdAt: t(1), connectionId: "g1" });
    updateRun(db, done.id, { status: "done" });
    // 다른 연결의 같은 세션 키(두 Gateway 의 같은 id 에이전트) — 더 먼저 만들었어도 g1 의 런이 아니다
    const elsewhere = newRun({ createdAt: t(1), connectionId: "g2" });
    const head = newRun({ createdAt: t(2), connectionId: "g1" });
    updateRun(db, head.id, { status: "streaming" });
    const waiting = newRun({ createdAt: t(3), connectionId: "g1" });
    const other = newRun({ createdAt: t(4), sessionKey: "agent:fin:dodok:channel:x", connectionId: "g1" });

    expect(findOpenRunBySession(db, "g1", sessionKey)?.id).toBe(head.id);
    expect(findOpenRunBySession(db, "g2", sessionKey)?.id).toBe(elsewhere.id);
    expect(findOpenRunBySession(db, "g1", "agent:nobody:dodok:channel:x")).toBeUndefined();
    expect(findOpenRunBySession(db, "g3", sessionKey)).toBeUndefined();
    expect(listOpenRuns(db).map((r) => r.id)).toEqual([elsewhere.id, head.id, waiting.id, other.id]);
  });

  it("findRunByTriggerMessage 는 트리거 메시지(와 에이전트)로 가장 최근 런을 찾는다", () => {
    const { db, bus, newRun, channelId, userId, agentId } = setup();
    const m = createUserMessage(db, bus, {
      channelId,
      authorId: userId,
      bodyMd: "@dev hi",
      clientMsgId: "c1",
    });
    const t = (s: number) => new Date(Date.UTC(2026, 8, 15, 0, 0, s));
    newRun({ triggerMessageId: m.id, createdAt: t(1) });
    const latest = newRun({ triggerMessageId: m.id, createdAt: t(2) });
    expect(findRunByTriggerMessage(db, m.id)?.id).toBe(latest.id);
    expect(findRunByTriggerMessage(db, m.id, agentId)?.id).toBe(latest.id);
    expect(findRunByTriggerMessage(db, m.id, uuid())).toBeUndefined();
    expect(findRunByTriggerMessage(db, uuid())).toBeUndefined();
  });

  it("countRunsToday 는 서버 로컬 자정 이후 그 채널 런 수, chainHashes 는 루트 체인의 relayHash 집합", () => {
    const { db, newRun, channelId } = setup();
    const now = new Date(2026, 8, 15, 12, 0, 0);
    const midnight = new Date(2026, 8, 15, 0, 0, 0);
    newRun({ createdAt: new Date(midnight.getTime() - 1) });
    newRun({ createdAt: midnight });
    newRun({ createdAt: now });
    expect(countRunsToday(db, channelId, now)).toBe(2);
    const other = seedChannelWithAgent(db);
    expect(countRunsToday(db, other.channelId, now)).toBe(0);

    const root = uuid();
    newRun({ rootMessageId: root, relayHash: "a", createdAt: midnight });
    newRun({ rootMessageId: root, relayHash: "b", createdAt: midnight });
    newRun({ rootMessageId: root, createdAt: midnight });
    newRun({ rootMessageId: uuid(), relayHash: "c", createdAt: midnight });
    expect(chainHashes(db, root)).toEqual(new Set(["a", "b"]));
    expect(chainHashes(db, uuid())).toEqual(new Set());
  });

  it("listRunMessageIds 는 그 런이 만든 메시지 id 를 seq 순으로", () => {
    const { db, bus, newRun, channelId, agentId } = setup();
    const run = newRun();
    const m1 = createAgentMessage(db, bus, {
      channelId,
      agentId,
      runId: run.id,
      externalId: "o1",
      bodyMd: "a",
    });
    createAgentMessage(db, bus, { channelId, agentId, externalId: "o2", bodyMd: "b" });
    const m3 = createAgentMessage(db, bus, {
      channelId,
      agentId,
      runId: run.id,
      externalId: "o3",
      bodyMd: "c",
    });
    expect(listRunMessageIds(db, run.id)).toEqual([m1.id, m3.id]);
  });
});
