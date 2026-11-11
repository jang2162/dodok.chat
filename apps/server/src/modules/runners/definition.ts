/**
 * run.start 에 실을 러너 에이전트 정의(러너 일반화 스펙 3장) — 에이전트 행과 프로젝트 행, 모델·effort·권한 모드는 그 대화의 세션 설정
 * (세션 설정 스펙 5장 — 행이 없으면 에이전트 시작값). 러너 어댑터가 런마다 부른다(agentDefinition 옵션). 지시는 base_prompt —
 * 어댑터가 채널 규칙 틀 앞에 싣는다(계획 판정 PR1). 권한 「기본」(null)은 어댑터가 그 러너의 상한으로 채운다
 */
import type { RunnerAgentDefinition } from "@dodok/runner-adapter";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { agents, runnerProjects } from "../../db/schema.sqlite";
import { providerAgentIdIs } from "../agents/service";
import { getEffectiveSettings, sessionDefaultsOf } from "../conversations/agent-settings";

/**
 * 그 러너 토큰에 묶인 러너 에이전트의 정의. 그 토큰의 러너 에이전트가 아니거나 프로젝트가 없으면 null. 보관한 프로젝트의 에이전트도
 * 정의가 있다 — 프로젝트 보관은 목록 정리일 뿐 런은 돈다(스펙 8장).
 * 에이전트와 프로젝트가 둘 다 그 토큰의 것이어야 한다 — (rootId, relPath) 는 러너 머신 하나 안에서만 뜻이 있어, 에이전트 토큰만 다른
 * 러너를 가리키면 그 러너의 같은 이름 루트에서 돈다(태스크 3 리뷰 D1). 둘을 함께 바꾸는 길은 프로젝트 옮기기(projects.ts moveProject) 하나다.
 * conversationId 가 없으면(능력 묻기처럼 대화가 없는 자리) 에이전트 시작값이다
 */
export function runnerAgentDefinition(
  db: DbOrTx,
  workspaceId: string,
  providerAgentId: string,
  runnerTokenId: string,
  conversationId?: string,
): RunnerAgentDefinition | null {
  const row = db
    .select({ agent: agents, project: runnerProjects })
    .from(agents)
    .innerJoin(runnerProjects, eq(runnerProjects.id, agents.runnerProjectId))
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.provider, "runner"),
        providerAgentIdIs(providerAgentId),
        eq(agents.runnerTokenId, runnerTokenId),
        eq(runnerProjects.runnerTokenId, runnerTokenId),
      ),
    )
    .get();
  if (!row || row.agent.program === null) return null;
  const settings =
    conversationId === undefined
      ? sessionDefaultsOf(db, row.agent.id)
      : getEffectiveSettings(db, { conversationId, agentId: row.agent.id });
  return {
    name: row.agent.name,
    instructions: row.agent.basePrompt,
    agent: {
      program: row.agent.program,
      project: { rootId: row.project.rootId, relPath: row.project.relPath },
      model: settings.model,
      effort: settings.effort,
      permissionMode: settings.permissionMode,
      // 허용 도구는 고르지 않는다(S4) — 옛 러너가 이 키를 요구해 늘 null 로 싣는다
      allowedTools: null,
      disallowedTools: row.agent.disallowedToolsJson,
    },
  };
}
