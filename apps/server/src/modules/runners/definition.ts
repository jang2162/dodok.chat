/**
 * run.start 에 실을 러너 에이전트 정의(러너 일반화 스펙 3장) — 에이전트 행과 프로젝트 행 그대로. 러너 어댑터가 런마다 부른다
 * (agentDefinition 옵션). 지시는 base_prompt — 어댑터가 채널 규칙 틀 앞에 싣는다(계획 판정 PR1)
 */
import type { RunnerAgentDefinition } from "@dodok/runner-adapter";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { agents, runnerProjects } from "../../db/schema.sqlite";
import { providerAgentIdIs } from "../agents/service";

/**
 * 그 러너 토큰에 묶인 러너 에이전트의 정의. 그 토큰의 러너 에이전트가 아니거나 프로젝트가 없으면 null. 보관한 프로젝트의 에이전트도
 * 정의가 있다 — 프로젝트 보관은 목록 정리일 뿐 런은 돈다(스펙 8장).
 * 에이전트와 프로젝트가 둘 다 그 토큰의 것이어야 한다 — (rootId, relPath) 는 러너 머신 하나 안에서만 뜻이 있어, 에이전트 토큰만 다른
 * 러너를 가리키면 그 러너의 같은 이름 루트에서 돈다(태스크 3 리뷰 D1). 둘을 함께 바꾸는 길은 프로젝트 옮기기(projects.ts moveProject) 하나다
 */
export function runnerAgentDefinition(
  db: DbOrTx,
  workspaceId: string,
  providerAgentId: string,
  runnerTokenId: string,
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
  return {
    name: row.agent.name,
    instructions: row.agent.basePrompt,
    agent: {
      program: row.agent.program,
      project: { rootId: row.project.rootId, relPath: row.project.relPath },
      model: row.agent.model,
      permissionMode: row.agent.permissionMode,
      allowedTools: row.agent.allowedToolsJson,
      disallowedTools: row.agent.disallowedToolsJson,
    },
  };
}
