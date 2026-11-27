/**
 * run.start 에 실을 러너 에이전트 정의(러너 일반화 스펙 3장) — 에이전트 행과 프로젝트 행, 모델·effort·권한 모드는 그 대화의 세션 설정
 * (세션 설정 스펙 5장 — 행이 없으면 에이전트 시작값). 러너 어댑터가 런마다 부른다(agentDefinition 옵션). 지시는 base_prompt —
 * 어댑터가 채널 규칙 틀 앞에 싣는다(계획 판정 PR1). 권한 「기본」(null)은 어댑터가 그 러너의 상한으로 채운다
 */
import type { RunnerAgentDefinition } from "@dodok/runner-adapter";
import { renderBotSoul } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { agents, runnerProjects } from "../../db/schema.sqlite";
import { normalizeBot, providerAgentIdIs } from "../agents/service";
import { getEffectiveSettings, sessionDefaultsOf } from "../conversations/agent-settings";

/**
 * 그 러너 토큰에 묶인 러너 에이전트의 정의. 그 토큰의 러너 에이전트가 아니거나 프로젝트가 없으면 null. 보관한 프로젝트의 에이전트도
 * 정의가 있다 — 프로젝트 보관은 목록 정리일 뿐 런은 돈다(스펙 8장).
 * 에이전트와 프로젝트가 둘 다 그 토큰의 것이어야 한다 — (rootId, relPath) 는 러너 머신 하나 안에서만 뜻이 있어, 에이전트 토큰만 다른
 * 러너를 가리키면 그 러너의 같은 이름 루트에서 돈다(태스크 3 리뷰 D1). 둘을 함께 바꾸는 길은 프로젝트 옮기기(projects.ts moveProject) 하나다.
 * conversationId 가 없으면(능력 묻기처럼 대화가 없는 자리) 에이전트 시작값이다. 봇(runner_bot — 러너 봇 스펙 B2)은 프로젝트 대신
 * bot(그 러너의 봇 폴더 id = providerAgentId·SOUL.md 본문)을 싣고 지시 자리에 기본 지시 대신 봇 정의가 간다(B9)
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
    .leftJoin(runnerProjects, eq(runnerProjects.id, agents.runnerProjectId))
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.provider, "runner"),
        providerAgentIdIs(providerAgentId),
        eq(agents.runnerTokenId, runnerTokenId),
      ),
    )
    .get();
  if (!row || row.agent.program === null) return null;
  const bot = row.agent.runnerBot;
  let place: Pick<RunnerAgentDefinition["agent"], "project" | "bot">;
  if (bot !== null) {
    // 봇 폴더 id 는 providerAgentId 그대로 — 서버가 짓는 `r-` + 소문자 hex 10(B1)
    // MCP 는 원문 그대로 — 러너가 헤더·env 로 서버에 붙는다(T4·T5). 능력(botMcp·runnerControl)에 따른 거르기는 어댑터 send 가 한다
    const def = normalizeBot(bot);
    place = {
      bot: {
        id: row.agent.providerAgentId.toLowerCase(),
        soul: renderBotSoul(def),
        ...(def.mcpServers === undefined ? {} : { mcpServers: def.mcpServers }),
        ...(def.mcpAutoAllow === undefined ? {} : { mcpAutoAllow: def.mcpAutoAllow }),
        ...(def.builtinTools === undefined ? {} : { builtinTools: def.builtinTools }),
      },
    };
  } else {
    // 프로젝트도 그 토큰의 것이어야 한다(태스크 3 리뷰 D1). 프로젝트 없는 옛 에이전트는 정의가 없다
    if (row.project === null || row.project.runnerTokenId !== runnerTokenId) return null;
    place = { project: { rootId: row.project.rootId, relPath: row.project.relPath } };
  }
  const settings =
    conversationId === undefined
      ? sessionDefaultsOf(db, row.agent.id)
      : getEffectiveSettings(db, { conversationId, agentId: row.agent.id });
  return {
    name: row.agent.name,
    instructions: bot === null ? row.agent.basePrompt : null,
    // 지시 틀에는 네 칸만 — MCP 값을 프롬프트 조립 자리로 가져가지 않는다
    ...(bot === null
      ? {}
      : {
          botDefinition: { purpose: bot.purpose, watches: bot.watches, does: bot.does, reports: bot.reports },
        }),
    agent: {
      program: row.agent.program,
      ...place,
      model: settings.model,
      effort: settings.effort,
      permissionMode: settings.permissionMode,
      // 허용 도구는 고르지 않는다(S4) — 옛 러너가 이 키를 요구해 늘 null 로 싣는다
      allowedTools: null,
      disallowedTools: row.agent.disallowedToolsJson,
      // 켰을 때만 — 옛 러너는 이 키를 모른다(어댑터가 상한을 알리지 않은 러너에는 보내지 않고 닫는다)
      ...(row.agent.allowOutsideWorkdir ? { allowOutsideWorkdir: true } : {}),
    },
  };
}
