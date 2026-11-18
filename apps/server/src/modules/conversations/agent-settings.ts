/**
 * 대화 × 러너 에이전트의 세션 설정(세션 설정 스펙 5.1) — 저장·조회. 행이 없으면 에이전트의 「새 세션 시작값」(S5·S10)이다.
 * 권한 판정(누가 무엇을 고르나)은 호출자(REST·첫 글) 몫이다 — 여기는 값만 다룬다
 */
import type {
  AgentSettingsPatch,
  ConversationAgentSettings,
  RunnerContextBreakdown,
  RunnerEffort,
  RunnerModelOption,
  RunnerPermissionMode,
  RunnerProgram,
  RunUsage,
  TeamRole,
} from "@dodok/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { authorizeSessionSettings } from "../../auth/policies";
import type { DbOrTx } from "../../db/client";
import { agents, conversationAgentSettings, runs } from "../../db/schema.sqlite";
import { listMembers } from "../channels/service";
import { sessionAgentIds } from "./invited-agents";
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

/**
 * 상태 줄에 오르는 에이전트(S13) — 그 채널의 러너 에이전트 멤버(DM 이면 그 DM 의 에이전트도 멤버다). 보관한 에이전트는 빠진다.
 * conversationId 를 주면 그 대화에 초대한 러너 에이전트도 뒤에 든다(세션 에이전트 초대 스펙 5.2) — 새 세션 창(대화 없음)은 주지 않는다
 */
export function settingsAgentsOf(
  db: DbOrTx,
  channelId: string,
  conversationId?: string,
): Array<{ id: string; runnerTokenId: string | null; program: RunnerProgram | null }> {
  const ids =
    conversationId === undefined
      ? listMembers(db, channelId)
          .filter((m) => m.memberType === "agent")
          .map((m) => m.memberId)
      : sessionAgentIds(db, { channelId, conversationId });
  if (ids.length === 0) return [];
  const rows = db
    .select({ id: agents.id, runnerTokenId: agents.runnerTokenId, program: agents.program })
    .from(agents)
    .where(and(inArray(agents.id, ids), eq(agents.provider, "runner")))
    .all();
  // 멤버 차례(들어온 순)를 지킨다
  return ids.flatMap((id) => rows.filter((r) => r.id === id));
}

/**
 * 그 러너가 그 프로그램에 대해 hello 로 알린 권한 상한 — 러너가 붙어 있지 않거나 모르면 null(대조를 건너뛴다). 끊긴 러너의 상한을
 * 서버는 모르지만 실행은 그 러너가 붙어야 돌고, 그때 러너가 자기 천장으로 RUNNER_CEILING 거절한다 — 저장을 막지 않아도 상한 위로 돌지 않는다
 */
export function runnerPermissionCeiling(
  runners: Pick<RunnerLiveApi, "runnerInfo"> | null,
  agent: { runnerTokenId: string | null; program: RunnerProgram | null },
): RunnerPermissionMode | null {
  if (!runners || agent.runnerTokenId === null || agent.program === null) return null;
  const live = runners.runnerInfo(agent.runnerTokenId);
  return live?.programs.find((p) => p.program === agent.program)?.ceiling.maxPermissionMode ?? null;
}

/**
 * 그 러너가 그 프로그램에 대해 hello 로 알린 모델 목록(작성기 칩 스펙 C3) — 러너가 붙어 있지 않거나 옛 러너면 빈 목록(화면은 고정
 * 목록으로 — C4). member 는 남의 러너가 GET /runners 에 없으므로 상한처럼 대화 설정 응답·agent-ceilings 에 싣는다(5.3)
 */
export function runnerModels(
  runners: Pick<RunnerLiveApi, "runnerInfo"> | null,
  agent: { runnerTokenId: string | null; program: RunnerProgram | null },
): RunnerModelOption[] {
  if (!runners || agent.runnerTokenId === null || agent.program === null) return [];
  const live = runners.runnerInfo(agent.runnerTokenId);
  return live?.programs.find((p) => p.program === agent.program)?.models ?? [];
}

type SessionKey = { conversationId: string; agentId: string; threadRootId?: string };

/**
 * 그 세션에서 그 에이전트의 사용량이 실린 마지막 실행(S7) — 스레드면 그 스레드 런만, 아니면 대화 세션(스레드 아닌) 런만, 최근 20행
 * 안에서. 「실렸다」는 contextTokens·contextWindow 가 둘 다 있거나 세부(contextBreakdown)가 있는 것. 퍼센트와 세부는 이 한 런에서
 * 나온다 — 게이지와 팝오버가 같은 런을 말하게(작성기 칩 스펙 2장)
 */
function lastContextRun(db: DbOrTx, key: SessionKey): RunUsage | null {
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
    if (!usage) continue;
    if (usage.contextBreakdown !== undefined) return usage;
    const window = usage.contextWindow;
    if (usage.contextTokens !== undefined && window !== undefined && window > 0) return usage;
  }
  return null;
}

/**
 * 마지막 실행 컨텍스트 사용률 — 그 런에 세부가 있으면 세부의 percentage(창 초과는 100 으로 자른다 — C8), 없으면(옛 러너·세부 받기
 * 실패) round(contextTokens / contextWindow × 100). 없으면 null
 */
export function contextPercentOf(db: DbOrTx, key: SessionKey): number | null {
  return percentOf(lastContextRun(db, key));
}

/**
 * 마지막 실행의 컨텍스트 세부 — contextPercentOf 와 같은 런. 그 런이 세부를 싣지 않았으면(옛 러너) 그 런의 contextTokens·contextWindow
 * 로 항목 없는 세부를 채운다 — 팝오버가 `사용/창` 한 줄을 보인다(작성기 칩 스펙 C4). 둘 다 없으면 null
 */
export function contextOf(db: DbOrTx, key: SessionKey): RunnerContextBreakdown | null {
  return contextOfUsage(lastContextRun(db, key));
}

function contextOfUsage(usage: RunUsage | null): RunnerContextBreakdown | null {
  if (!usage) return null;
  if (usage.contextBreakdown !== undefined) return usage.contextBreakdown;
  const tokens = usage.contextTokens;
  const window = usage.contextWindow;
  if (tokens === undefined || window === undefined || window <= 0) return null;
  // percentage 는 자르지 않는다 — 세부처럼 100 을 넘으면 팝오버가 「창 초과」를 보인다(게이지 퍼센트는 percentOf 가 자른다)
  return {
    model: (usage.model ?? "").slice(0, 128),
    totalTokens: tokens,
    maxTokens: window,
    percentage: (tokens / window) * 100,
    categories: [],
  };
}

const clampPercent = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

function percentOf(usage: RunUsage | null): number | null {
  if (!usage) return null;
  if (usage.contextBreakdown !== undefined) return clampPercent(usage.contextBreakdown.percentage);
  const tokens = usage.contextTokens;
  const window = usage.contextWindow;
  if (tokens === undefined || window === undefined || window <= 0) return null;
  return clampPercent((tokens / window) * 100);
}

export function toConversationAgentSettings(
  db: DbOrTx,
  key: { conversationId: string; agentId: string; threadRootId?: string },
  runners: Pick<RunnerLiveApi, "runnerInfo"> | null,
): ConversationAgentSettings {
  const last = lastContextRun(db, key);
  const agent = db
    .select({ runnerTokenId: agents.runnerTokenId, program: agents.program })
    .from(agents)
    .where(eq(agents.id, key.agentId))
    .get();
  return {
    agentId: key.agentId,
    ...getEffectiveSettings(db, key),
    contextPercent: percentOf(last),
    ceiling: agent ? runnerPermissionCeiling(runners, agent) : null,
    context: contextOfUsage(last),
    models: agent ? runnerModels(runners, agent) : [],
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
    /** 이미 있는 대화면 그 대화 — 초대한 러너 에이전트도 고른다. 새 세션의 첫 글은 없다(아직 초대가 없다) */
    conversationId?: string;
    agentId: string;
    user: { id: string; role: TeamRole | undefined };
    permissionMode: RunnerPermissionMode | null | undefined;
    runners: Pick<RunnerLiveApi, "runnerInfo"> | null;
  },
  notFound: () => Error,
): void {
  const agent = settingsAgentsOf(db, input.channelId, input.conversationId).find(
    (a) => a.id === input.agentId,
  );
  if (!agent) throw notFound();
  authorizeSessionSettings({
    canRead: true,
    ownsConnection: agentActor(db, input.workspaceId, input.agentId, input.user).ownsConnection,
    role: input.user.role,
    permissionMode: input.permissionMode,
    ceiling: runnerPermissionCeiling(input.runners, agent),
  });
}
