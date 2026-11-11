/**
 * 대화 × 러너 에이전트의 세션 설정(세션 설정 스펙 5.1) — 저장·조회. 행이 없으면 에이전트의 「새 세션 시작값」(S5·S10)이다.
 * 권한 판정(누가 무엇을 고르나)은 호출자(REST·첫 글) 몫이다 — 여기는 값만 다룬다
 */
import type {
  AgentSettingsPatch,
  ConversationAgentSettings,
  RunnerEffort,
  RunnerPermissionMode,
  RunnerProgram,
  TeamRole,
} from "@dodok/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { authorizeSessionSettings } from "../../auth/policies";
import type { DbOrTx } from "../../db/client";
import { agents, conversationAgentSettings, runs } from "../../db/schema.sqlite";
import { listMembers } from "../channels/service";
import { agentActor } from "../connections/owner";
import type { RunnerLiveApi } from "../runners/live";

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

/** 상태 줄에 오르는 에이전트(S13) — 그 채널의 러너 에이전트 멤버(DM 이면 그 DM 의 에이전트도 멤버다). 보관한 에이전트는 빠진다 */
export function settingsAgentsOf(
  db: DbOrTx,
  channelId: string,
): Array<{ id: string; runnerTokenId: string | null; program: RunnerProgram | null }> {
  const ids = listMembers(db, channelId)
    .filter((m) => m.memberType === "agent")
    .map((m) => m.memberId);
  if (ids.length === 0) return [];
  const rows = db
    .select({ id: agents.id, runnerTokenId: agents.runnerTokenId, program: agents.program })
    .from(agents)
    .where(and(inArray(agents.id, ids), eq(agents.provider, "runner")))
    .all();
  // 멤버 차례(들어온 순)를 지킨다
  return ids.flatMap((id) => rows.filter((r) => r.id === id));
}

/** 그 러너가 그 프로그램에 대해 hello 로 알린 권한 상한 — 러너가 붙어 있지 않거나 모르면 null(대조를 건너뛴다) */
export function runnerPermissionCeiling(
  runners: Pick<RunnerLiveApi, "runnerInfo"> | null,
  agent: { runnerTokenId: string | null; program: RunnerProgram | null },
): RunnerPermissionMode | null {
  if (!runners || agent.runnerTokenId === null || agent.program === null) return null;
  const live = runners.runnerInfo(agent.runnerTokenId);
  return live?.programs.find((p) => p.program === agent.program)?.ceiling.maxPermissionMode ?? null;
}

/**
 * 그 세션에서 그 에이전트의 마지막 실행 컨텍스트 사용률(S7) — 스레드면 그 스레드 런만, 아니면 대화 세션(스레드 아닌) 런만. 사용량이
 * 실린 가장 최근 런의 round(contextTokens / contextWindow × 100), 없으면 null
 */
export function contextPercentOf(
  db: DbOrTx,
  key: { conversationId: string; agentId: string; threadRootId?: string },
): number | null {
  const rows = db
    .select({ usage: runs.usage })
    .from(runs)
    .where(
      and(
        eq(runs.conversationId, key.conversationId),
        eq(runs.agentId, key.agentId),
        key.threadRootId === undefined ? isNull(runs.threadRootId) : eq(runs.threadRootId, key.threadRootId),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(20)
    .all();
  for (const { usage } of rows) {
    const tokens = usage?.contextTokens;
    const window = usage?.contextWindow;
    if (tokens === undefined || window === undefined || window <= 0) continue;
    return Math.min(100, Math.max(0, Math.round((tokens / window) * 100)));
  }
  return null;
}

/** 그 에이전트의 권한 상한(runnerPermissionCeiling) — 에이전트 id 로 러너·프로그램을 찾는다. 러너 에이전트가 아니면 null */
export function agentPermissionCeiling(
  db: DbOrTx,
  runners: Pick<RunnerLiveApi, "runnerInfo"> | null,
  agentId: string,
): RunnerPermissionMode | null {
  const agent = db
    .select({ runnerTokenId: agents.runnerTokenId, program: agents.program })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  return agent ? runnerPermissionCeiling(runners, agent) : null;
}

export function toConversationAgentSettings(
  db: DbOrTx,
  key: { conversationId: string; agentId: string; threadRootId?: string },
  runners: Pick<RunnerLiveApi, "runnerInfo"> | null,
): ConversationAgentSettings {
  return {
    agentId: key.agentId,
    ...getEffectiveSettings(db, key),
    contextPercent: contextPercentOf(db, key),
    ceiling: agentPermissionCeiling(db, runners, key.agentId),
  };
}

/**
 * 그 대화의 그 에이전트 설정을 바꿀 수 있는가(S2·5.3) — 상태 줄에 오르는 에이전트가 아니면(OpenClaw·채널 밖) 404, 그 밖은
 * authorizeSessionSettings. 채널을 읽을 수 있는지는 호출자가 먼저 본다
 */
export function assertSettingsWritable(
  db: DbOrTx,
  input: {
    workspaceId: string;
    channelId: string;
    agentId: string;
    user: { id: string; role: TeamRole | undefined };
    permissionMode: RunnerPermissionMode | null | undefined;
    runners: Pick<RunnerLiveApi, "runnerInfo"> | null;
  },
  notFound: () => Error,
): void {
  const agent = settingsAgentsOf(db, input.channelId).find((a) => a.id === input.agentId);
  if (!agent) throw notFound();
  authorizeSessionSettings({
    canRead: true,
    ownsConnection: agentActor(db, input.workspaceId, input.agentId, input.user).ownsConnection,
    role: input.user.role,
    permissionMode: input.permissionMode,
    ceiling: runnerPermissionCeiling(input.runners, agent),
  });
}
