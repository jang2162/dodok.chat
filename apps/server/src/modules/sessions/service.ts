import { dodokSessionKey, isOpenClawAgentId } from "@dodok/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { AgentAdapter } from "../../adapters/types";
import type { Db, DbOrTx } from "../../db/client";
import { agentSessions, agents, channels } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

export type AgentSessionRow = typeof agentSessions.$inferSelect;

/** 저장된 providerAgentId 가 세션 키 규칙 밖일 때의 사유 — 런 경로(run_error 카드)와 「새 대화」 REST 가 같은 문장을 쓴다 */
export const INVALID_AGENT_ID_REASON =
  "OpenClaw 에이전트 id 가 세션 키 규칙(영문·숫자·_·-)에 맞지 않습니다 — 올바른 id 로 에이전트를 다시 등록하세요";

/** threadRootId 가 있으면 그 스레드의 하위 세션(ADR 0006), 없으면 채널 세션 */
export type EnsureSessionInput = { channelId: string; agentId: string; threadRootId?: string | undefined };

/** 어댑터 resetSession 응답 그대로 */
export type SessionResetInfo = { sessionStartedAt?: string; lifecycleRevision?: string };

/**
 * 스펙 3.9 — 디스패치 직전에 부른다. 행이 없으면 현재 채널 promptRevision 으로 만든다(첫 턴은 설정 경로가 이미
 * 프롬프트를 담으므로 동봉하지 않는다). 세션 시작 뒤 리비전이 올랐으면 needsPromptContext. 리비전은 스레드 세션 행별로 기억한다(스펙 2.3).
 * providerAgentId 가 세션 키 규칙 밖이면 VALIDATION 을 던진다 — 행을 만들지 않는다.
 */
export function ensureSession(
  db: Db,
  adapter: Pick<AgentAdapter, "sessionKeyFor">,
  input: EnsureSessionInput,
): { session: AgentSessionRow; needsPromptContext: boolean } {
  return db.transaction((tx) => {
    const promptRevision = currentPromptRevision(tx, input.channelId);
    const existing = tx
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.channelId, input.channelId),
          eq(agentSessions.agentId, input.agentId),
          sameThread(input.threadRootId),
        ),
      )
      .get();
    const session =
      existing ??
      tx
        .insert(agentSessions)
        .values({
          id: uuidv7(),
          channelId: input.channelId,
          agentId: input.agentId,
          threadRootId: input.threadRootId ?? null,
          sessionKey: adapter.sessionKeyFor(
            providerAgentIdOf(tx, input.agentId),
            input.channelId,
            input.threadRootId,
          ),
          promptRevisionAtStart: promptRevision,
        })
        .returning()
        .get();
    return { session, needsPromptContext: session.promptRevisionAtStart !== promptRevision };
  });
}

/**
 * 서버가 정하는 제공자 세션 id(러너 계획 판정 P4 — serverSessionIds 어댑터만 부른다). 비었으면 새 UUID 를 써 두고 돌려준다 —
 * 같은 세션 행의 다음 런은 같은 값을 받는다. 「새 대화」가 비우면(clearProviderSessionId) 다음 런이 새 값을 쓴다
 */
export function ensureProviderSessionId(db: Db, sessionId: string): string {
  return db.transaction((tx) => {
    const row = tx
      .select({ providerSessionId: agentSessions.providerSessionId })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    if (!row) throw apiError("NOT_FOUND", "agent session not found");
    if (row.providerSessionId !== null) return row.providerSessionId;
    const providerSessionId = randomUUID();
    tx.update(agentSessions).set({ providerSessionId }).where(eq(agentSessions.id, sessionId)).run();
    return providerSessionId;
  });
}

/**
 * 「새 대화」가 서버가 정한 세션 id 를 비운다(판정 P4 — serverSessionIds 어댑터만). 어댑터 리셋을 기다리기 전에 부른다 —
 * 그 사이 디스패치된 런이 옛 id 로 옛 대화를 잇지 않고, 리셋 뒤에 비우면 그 런이 새로 쓴 id 까지 지워 대화가 갈린다
 */
export function clearProviderSessionId(db: Db, sessionId: string): void {
  db.update(agentSessions).set({ providerSessionId: null }).where(eq(agentSessions.id, sessionId)).run();
}

/**
 * 서버가 세션 id 를 정하는 어댑터(러너)의 디스패치 직전 — 세션 시작 뒤 채널 리비전이 올랐으면 「새 대화」와 같은 결과로 만든다:
 * 세션 id 를 비우고(다음 ensureProviderSessionId 가 새 UUID) 리비전·시작 표지를 맞춘다. 이어 간 세션은 자기 앞 답의 옛 형식을
 * 따른다(ADR 0007 「규칙이 바뀐 뒤 이어 간 세션」). 리비전은 채널 하나라 promptOverride 가 바뀌어도 그 채널의 모든 행이 해당한다.
 * 버린 대화가 있었을 때만 true — 세션 id 가 아직 없으면 리비전만 맞춘다. 한 트랜잭션이라 같은 리비전 변화에 두 번 true 가 없다
 */
export function renewSessionOnPromptChange(db: Db, sessionId: string): boolean {
  return db.transaction((tx) => {
    const row = tx
      .select({
        channelId: agentSessions.channelId,
        promptRevisionAtStart: agentSessions.promptRevisionAtStart,
        providerSessionId: agentSessions.providerSessionId,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    if (!row) throw apiError("NOT_FOUND", "agent session not found");
    const promptRevision = currentPromptRevision(tx, row.channelId);
    if (row.promptRevisionAtStart === promptRevision) return false;
    tx.update(agentSessions)
      .set({
        providerSessionId: null,
        promptRevisionAtStart: promptRevision,
        sessionStartedAt: null,
        lifecycleRevision: null,
        lastSyncedAt: new Date(),
      })
      .where(eq(agentSessions.id, sessionId))
      .run();
    return row.providerSessionId !== null;
  });
}

/**
 * 우리 resetSession 이 성공한 뒤 부른다 — 새 세션은 현재 채널 프롬프트를 설정 경로로 받으므로 리비전을 맞춘다.
 * 응답에 없는 sessionStartedAt·lifecycleRevision 은 null(옛 세션 값을 남기지 않는다). 행이 없으면 만든다.
 * threadRootId 가 있으면 그 스레드 세션 행만 바꾼다. 서버가 정한 세션 id 는 건드리지 않는다(clearProviderSessionId)
 */
export function markSessionReset(
  db: Db,
  channelId: string,
  agentId: string,
  reset: SessionResetInfo,
  threadRootId?: string,
): AgentSessionRow {
  return db.transaction((tx) => {
    const now = new Date();
    const fields = {
      promptRevisionAtStart: currentPromptRevision(tx, channelId),
      sessionStartedAt: isoToDate(reset.sessionStartedAt),
      lifecycleRevision: reset.lifecycleRevision ?? null,
      lastSyncedAt: now,
    };
    const row = {
      id: uuidv7(),
      channelId,
      agentId,
      threadRootId: threadRootId ?? null,
      sessionKey: dodokSessionKey(providerAgentIdOf(tx, agentId), channelId, threadRootId),
      ...fields,
    };
    // 스레드 행은 3열 유일 인덱스, 채널 행은 부분 유일 인덱스(agent_sessions_channel_session) — 채널 쪽은 targetWhere 가
    // 인덱스 조건과 같아야 SQLite 가 받는다
    const upsert = tx.insert(agentSessions).values(row);
    return (
      threadRootId === undefined
        ? upsert.onConflictDoUpdate({
            target: [agentSessions.channelId, agentSessions.agentId],
            targetWhere: sql`thread_root_id IS NULL`,
            set: fields,
          })
        : upsert.onConflictDoUpdate({
            target: [agentSessions.channelId, agentSessions.agentId, agentSessions.threadRootId],
            set: fields,
          })
    )
      .returning()
      .get();
  });
}

function sameThread(threadRootId: string | undefined) {
  return threadRootId === undefined
    ? isNull(agentSessions.threadRootId)
    : eq(agentSessions.threadRootId, threadRootId);
}

function currentPromptRevision(db: DbOrTx, channelId: string): number {
  const channel = db
    .select({ promptRevision: channels.promptRevision })
    .from(channels)
    .where(eq(channels.id, channelId))
    .get();
  if (!channel) throw apiError("NOT_FOUND", "channel not found");
  return channel.promptRevision;
}

function providerAgentIdOf(db: DbOrTx, agentId: string): string {
  const agent = db
    .select({ providerAgentId: agents.providerAgentId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  if (!agent) throw apiError("NOT_FOUND", "agent not found");
  // 빌더가 일반 Error 로 던지면 REST 가 500 이 된다 — 키를 만들기 전에 사유 있는 4xx 로
  if (!isOpenClawAgentId(agent.providerAgentId)) throw apiError("VALIDATION", INVALID_AGENT_ID_REASON);
  return agent.providerAgentId;
}

function isoToDate(iso: string | undefined): Date | null {
  if (iso === undefined) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
