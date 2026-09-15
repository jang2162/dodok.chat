import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { AgentAdapter } from "../../adapters/types";
import type { Db, DbOrTx } from "../../db/client";
import { agentSessions, agents, channels } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

export type AgentSessionRow = typeof agentSessions.$inferSelect;

export type EnsureSessionInput = { channelId: string; agentId: string };

/** 어댑터 resetSession 응답 그대로 */
export type SessionResetInfo = { sessionStartedAt?: string; lifecycleRevision?: string };

/**
 * 스펙 3.9 — 디스패치 직전에 부른다. 행이 없으면 현재 채널 promptRevision 으로 만든다(첫 턴은 설정 경로가 이미
 * 프롬프트를 담으므로 동봉하지 않는다). 세션 시작 뒤 리비전이 올랐으면 needsPromptContext.
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
      .where(and(eq(agentSessions.channelId, input.channelId), eq(agentSessions.agentId, input.agentId)))
      .get();
    const session =
      existing ??
      tx
        .insert(agentSessions)
        .values({
          id: uuidv7(),
          channelId: input.channelId,
          agentId: input.agentId,
          sessionKey: adapter.sessionKeyFor(providerAgentIdOf(tx, input.agentId), input.channelId),
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
 */
export function markSessionReset(
  db: Db,
  channelId: string,
  agentId: string,
  reset: SessionResetInfo,
): AgentSessionRow {
  return db.transaction((tx) => {
    const now = new Date();
    const fields = {
      promptRevisionAtStart: currentPromptRevision(tx, channelId),
      sessionStartedAt: isoToDate(reset.sessionStartedAt),
      lifecycleRevision: reset.lifecycleRevision ?? null,
      lastSyncedAt: now,
    };
    return tx
      .insert(agentSessions)
      .values({
        id: uuidv7(),
        channelId,
        agentId,
        sessionKey: canonicalSessionKey(providerAgentIdOf(tx, agentId), channelId),
        ...fields,
      })
      .onConflictDoUpdate({ target: [agentSessions.channelId, agentSessions.agentId], set: fields })
      .returning()
      .get();
  });
}

/** 어댑터 sessionKeyFor 와 같은 원형(계획서 #19, 스펙 6.5). 어댑터를 받지 않는 markSessionReset 이 행을 만들 때만 쓴다. */
function canonicalSessionKey(providerAgentId: string, channelId: string): string {
  return `agent:${providerAgentId}:dodok:channel:${channelId}`;
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
  return agent.providerAgentId;
}

function isoToDate(iso: string | undefined): Date | null {
  if (iso === undefined) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
