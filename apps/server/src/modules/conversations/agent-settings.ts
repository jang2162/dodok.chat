/**
 * 대화 × 러너 에이전트의 세션 설정(세션 설정 스펙 5.1) — 저장·조회. 행이 없으면 에이전트의 「새 세션 시작값」(S5·S10)이다.
 * 권한 판정(누가 무엇을 고르나)은 호출자(REST·첫 글) 몫이다 — 여기는 값만 다룬다
 */
import type { AgentSettingsPatch, RunnerEffort, RunnerPermissionMode } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { agents, conversationAgentSettings } from "../../db/schema.sqlite";

export type ConversationAgentSettingsRow = typeof conversationAgentSettings.$inferSelect;

export type EffectiveSettings = {
  model: string | null;
  effort: RunnerEffort | null;
  permissionMode: RunnerPermissionMode | null;
};

const NO_SETTINGS: EffectiveSettings = { model: null, effort: null, permissionMode: null };

/** 그 에이전트의 「새 세션 시작값」 — 에이전트가 없으면 모두 기본 */
export function sessionDefaultsOf(db: DbOrTx, agentId: string): EffectiveSettings {
  const row = db
    .select({
      model: agents.sessionDefaultModel,
      effort: agents.sessionDefaultEffort,
      permissionMode: agents.sessionDefaultPermissionMode,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  return row ?? { ...NO_SETTINGS };
}

export function getSettingsRow(
  db: DbOrTx,
  key: { conversationId: string; agentId: string },
): ConversationAgentSettingsRow | undefined {
  return db
    .select()
    .from(conversationAgentSettings)
    .where(
      and(
        eq(conversationAgentSettings.conversationId, key.conversationId),
        eq(conversationAgentSettings.agentId, key.agentId),
      ),
    )
    .get();
}

/** 그 대화에서 그 에이전트가 도는 값 — 행이 있으면 그 값, 없으면 에이전트 시작값 */
export function getEffectiveSettings(
  db: DbOrTx,
  key: { conversationId: string; agentId: string },
): EffectiveSettings {
  const row = getSettingsRow(db, key);
  if (!row) return sessionDefaultsOf(db, key.agentId);
  return { model: row.model, effort: row.effort, permissionMode: row.permissionMode };
}

/**
 * 보낸 필드만 바꾼다. 행이 없으면 시작값에서 출발한 행을 만든다 — 한 필드만 바꿔도 나머지가 「기본」으로 떨어지지 않게
 */
export function upsertSettings(
  db: DbOrTx,
  input: { conversationId: string; agentId: string; patch: AgentSettingsPatch; userId: string | null },
): ConversationAgentSettingsRow {
  const base = getEffectiveSettings(db, input);
  const next: EffectiveSettings = {
    model: input.patch.model === undefined ? base.model : input.patch.model,
    effort: input.patch.effort === undefined ? base.effort : input.patch.effort,
    permissionMode:
      input.patch.permissionMode === undefined ? base.permissionMode : input.patch.permissionMode,
  };
  const values = { ...next, updatedBy: input.userId, updatedAt: new Date() };
  return db
    .insert(conversationAgentSettings)
    .values({ conversationId: input.conversationId, agentId: input.agentId, ...values })
    .onConflictDoUpdate({
      target: [conversationAgentSettings.conversationId, conversationAgentSettings.agentId],
      set: values,
    })
    .returning()
    .get();
}
