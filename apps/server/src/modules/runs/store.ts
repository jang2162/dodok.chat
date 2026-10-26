import { Run, RunEvent, RunState, type RunTriggerKind } from "@dodok/shared";
import { and, asc, count, desc, eq, gt, gte, isNotNull, max, notInArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { RunEventBody } from "../../adapters/types";
import type { DbOrTx } from "../../db/client";
import { channels, messages, runEvents, runs } from "../../db/schema.sqlite";
import { type ChannelReader, readerSql } from "../../auth/channel-access";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";
import { TERMINAL_STATUSES } from "./machine";

type RunRow = typeof runs.$inferSelect;
type RunInsert = typeof runs.$inferInsert;

export type InsertRunInput = {
  channelId: string;
  /** 트리거 메시지·상호작용 메시지의 대화 — 세션 키도 이 대화로 만든다 */
  conversationId: string;
  agentId: string;
  triggerKind: RunTriggerKind;
  triggerMessageId?: string | undefined;
  triggerInteractionId?: string | undefined;
  rootMessageId: string;
  relayDepth: number;
  relayHash?: string | undefined;
  parentRunId?: string | undefined;
  sessionKey: string;
  /** 스레드 하위 세션의 런이면 그 루트 */
  threadRootId?: string | undefined;
  /** 만들 때 에이전트 행의 연결(adapters/connection.ts connectionIdOf) — send 가 돌려준 값으로 덮는다 */
  connectionId?: string | null | undefined;
  /** 그 런을 시킨 사람 — 오케스트레이터 requesterOf 가 정한다. 없으면 null */
  requestedBy?: string | null | undefined;
  createdAt: Date;
};

/** 오케스트레이터가 바꾸는 열만. null 은 지움. */
export type RunRowPatch = Partial<
  Pick<
    RunInsert,
    | "status"
    | "hasCanonical"
    | "finalSource"
    | "usage"
    | "error"
    | "providerRunId"
    | "connectionId"
    | "startedAt"
    | "endedAt"
  >
>;

const TERMINAL = [...TERMINAL_STATUSES];

export function rowToRun(row: RunRow): Run {
  return parseStored(
    Run,
    {
      id: row.id,
      channelId: row.channelId,
      conversationId: row.conversationId,
      agentId: row.agentId,
      triggerKind: row.triggerKind,
      triggerMessageId: row.triggerMessageId ?? undefined,
      triggerInteractionId: row.triggerInteractionId ?? undefined,
      rootMessageId: row.rootMessageId,
      relayDepth: row.relayDepth,
      parentRunId: row.parentRunId ?? undefined,
      sessionKey: row.sessionKey,
      threadRootId: row.threadRootId ?? undefined,
      providerRunId: row.providerRunId ?? undefined,
      status: row.status,
      hasCanonical: row.hasCanonical,
      finalSource: row.finalSource ?? undefined,
      usage: row.usage ?? undefined,
      error: row.error ?? undefined,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString(),
      endedAt: row.endedAt?.toISOString(),
    },
    "run",
  );
}

/** wire run.state 요약 */
export function toRunState(run: Run): RunState {
  return RunState.parse(run);
}

export function insertRun(db: DbOrTx, input: InsertRunInput): Run {
  const row = db
    .insert(runs)
    .values({
      id: uuidv7(),
      channelId: input.channelId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      triggerKind: input.triggerKind,
      triggerMessageId: input.triggerMessageId ?? null,
      triggerInteractionId: input.triggerInteractionId ?? null,
      rootMessageId: input.rootMessageId,
      relayDepth: input.relayDepth,
      relayHash: input.relayHash ?? null,
      parentRunId: input.parentRunId ?? null,
      sessionKey: input.sessionKey,
      threadRootId: input.threadRootId ?? null,
      connectionId: input.connectionId ?? null,
      requestedBy: input.requestedBy ?? null,
      status: "queued",
      hasCanonical: false,
      createdAt: input.createdAt,
    })
    .returning()
    .get();
  return rowToRun(row);
}

export function updateRun(db: DbOrTx, id: string, patch: RunRowPatch): Run {
  const row = db.update(runs).set(patch).where(eq(runs.id, id)).returning().get();
  if (!row) throw apiError("NOT_FOUND", "run not found");
  return rowToRun(row);
}

export function getRun(db: DbOrTx, id: string): Run | undefined {
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  return row ? rowToRun(row) : undefined;
}

/** 그 런을 맡은 연결(runs.connection_id) — 공유 Run 에는 싣지 않는다(REST·wire 로 나가지 않게). 런이 없거나 비었으면 null */
export function getRunConnectionId(db: DbOrTx, id: string): string | null {
  return db.select({ c: runs.connectionId }).from(runs).where(eq(runs.id, id)).get()?.c ?? null;
}

/**
 * 그 런을 시킨 사람(runs.requested_by) — connectionId 처럼 공유 Run 에는 싣지 않는다(REST·wire 로 나가지 않게). 런이 없거나 비었으면 null
 */
export function getRunRequestedBy(db: DbOrTx, id: string): string | null {
  return db.select({ r: runs.requestedBy }).from(runs).where(eq(runs.id, id)).get()?.r ?? null;
}

/**
 * 채널이 그 워크스페이스에 있고 reader 가 그 채널을 읽을 수 있는 런 — REST·wire·제어 도구가 다른 워크스페이스·남의 DM 의 런을
 * NOT_FOUND 로 가린다(auth/channel-access.ts)
 */
export function getRunInWorkspace(
  db: DbOrTx,
  id: string,
  workspaceId: string,
  reader: ChannelReader,
): Run | undefined {
  const row = db
    .select({ run: runs })
    .from(runs)
    .innerJoin(channels, eq(channels.id, runs.channelId))
    .where(and(eq(runs.id, id), eq(channels.workspaceId, workspaceId), readerSql(reader)))
    .get();
  return row ? rowToRun(row.run) : undefined;
}

/**
 * 그 연결·세션의 종료되지 않은 런 중 가장 먼저 만든 것 — FIFO 직렬화라 디스패치된 런이 맨 앞이다. 세션 키만으로는 두 Gateway 의
 * 같은 id 에이전트(main)를 가르지 못한다
 */
export function findOpenRunBySession(db: DbOrTx, connectionId: string, sessionKey: string): Run | undefined {
  const row = db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.connectionId, connectionId),
        eq(runs.sessionKey, sessionKey),
        notInArray(runs.status, TERMINAL),
      ),
    )
    .orderBy(asc(runs.createdAt), asc(runs.id))
    .limit(1)
    .get();
  return row ? rowToRun(row) : undefined;
}

/** 채널의 런을 최근 것부터(createdAt·id 내림차순) limit 개 — REST 런 목록 */
export function listChannelRuns(db: DbOrTx, channelId: string, limit: number): Run[] {
  return db
    .select()
    .from(runs)
    .where(eq(runs.channelId, channelId))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit)
    .all()
    .map(rowToRun);
}

/** 트리거 메시지로 만든 가장 최근 런. 한 메시지가 여러 에이전트를 부를 수 있어 agentId 로 좁힌다. */
export function findRunByTriggerMessage(db: DbOrTx, messageId: string, agentId?: string): Run | undefined {
  const row = db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.triggerMessageId, messageId),
        agentId === undefined ? undefined : eq(runs.agentId, agentId),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1)
    .get();
  return row ? rowToRun(row) : undefined;
}

/** seq = 그 런의 MAX(seq)+1. 계약(RunEvent)을 어기면 던지고 저장하지 않는다. 트랜잭션 안에서 부른다. */
export function appendRunEvent(db: DbOrTx, runId: string, event: RunEventBody, now: Date): RunEvent {
  const last = db
    .select({ seq: max(runEvents.seq) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .get();
  const seq = (last?.seq ?? 0) + 1;
  const full = RunEvent.parse({ ...event, runId, seq, ts: now.toISOString() });
  db.insert(runEvents)
    .values({ id: uuidv7(), runId, seq, type: full.type, payload: full, createdAt: now })
    .run();
  return full;
}

export function listRunEvents(db: DbOrTx, runId: string, afterSeq: number): RunEvent[] {
  return db
    .select({ payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .all()
    .map((r) => parseStored(RunEvent, r.payload, "run event"));
}

/** 그 런에 이 type 의 이벤트가 이미 있는가 */
export function hasRunEvent(db: DbOrTx, runId: string, type: RunEvent["type"]): boolean {
  return (
    db
      .select({ id: runEvents.id })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), eq(runEvents.type, type)))
      .limit(1)
      .get() !== undefined
  );
}

export function listOpenRuns(db: DbOrTx): Run[] {
  return db
    .select()
    .from(runs)
    .where(notInArray(runs.status, TERMINAL))
    .orderBy(asc(runs.createdAt), asc(runs.id))
    .all()
    .map(rowToRun);
}

/** 서버 로컬 자정 이후 그 채널에서 만든 런 수 */
export function countRunsToday(db: DbOrTx, channelId: string, now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const row = db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.channelId, channelId), gte(runs.createdAt, midnight)))
    .get();
  return row?.n ?? 0;
}

/** 서버 현지 자정 이후 만든 런 수(상태 무관) — 서버는 워크스페이스 하나라 runs 전체를 센다 */
export function countRunsTodayInWorkspace(db: DbOrTx, now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const row = db.select({ n: count() }).from(runs).where(gte(runs.createdAt, midnight)).get();
  return row?.n ?? 0;
}

/** 같은 rootMessageId 체인의 relayHash 집합 */
export function chainHashes(db: DbOrTx, rootMessageId: string): Set<string> {
  const rows = db
    .select({ relayHash: runs.relayHash })
    .from(runs)
    .where(and(eq(runs.rootMessageId, rootMessageId), isNotNull(runs.relayHash)))
    .all();
  return new Set(rows.flatMap((r) => (r.relayHash === null ? [] : [r.relayHash])));
}

/** 그 런이 만든 메시지 id (seq 순) — RUN_FINISHED.messageIds */
export function listRunMessageIds(db: DbOrTx, runId: string): string[] {
  return db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.runId, runId))
    .orderBy(asc(messages.seq))
    .all()
    .map((r) => r.id);
}
