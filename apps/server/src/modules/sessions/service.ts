import { dodokSessionKey, isOpenClawAgentId } from "@dodok/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
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
 * 우리 resetSession 이 성공한 뒤 부른다 — 새 세션은 현재 채널 프롬프트를 설정 경로로 받으므로 리비전을 맞춘다.
 * 응답에 없는 sessionStartedAt·lifecycleRevision 은 null(옛 세션 값을 남기지 않는다). 행이 없으면 만든다.
 * threadRootId 가 있으면 그 스레드 세션 행만 바꾼다.
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
