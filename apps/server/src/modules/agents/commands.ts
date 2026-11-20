/**
 * 에이전트별 명령 목록(에이전트 명령 스펙 C8·C9·5.2) — 작성기 자동완성의 도움말일 뿐 허용 목록이 아니다(C5). OpenClaw 는 shared 고정
 * 목록, 러너는 그 프로젝트의 commands.list(프로젝트마다 10분 캐시 — 러너가 다시 붙으면 hello 시각이 바뀌어 새로 묻는다). 맡은 쪽이
 * 끊겼거나 옛 판(능력 commands 없음)이면 supported false·빈 목록
 */
import {
  type Agent,
  type AgentCommand,
  type AgentCommandsResponse,
  checkCommand,
  OPENCLAW_COMMANDS,
  type RunnerCommandsListResult,
  type RunnerProjectRef,
} from "@dodok/shared";
import type { RunnerAdapter } from "@dodok/runner-adapter";
import { eq } from "drizzle-orm";
import { agentConnectionId } from "../../adapters/connection";
import type { AdapterRegistry } from "../../adapters/registry";
import type { DbOrTx } from "../../db/client";
import { agents, runnerProjects } from "../../db/schema.sqlite";
import type { Logger } from "../../logger";
import { commandProgramOf } from "../router/decide";

/** 러너 명령 목록 캐시 수명 — 사람이 스킬을 더해도 길어야 이만큼 뒤에 자동완성에 보인다(목록에 없어도 넘긴다 — C5) */
export const RUNNER_COMMANDS_CACHE_MS = 10 * 60_000;

export type AgentCommandsRunners = Pick<RunnerAdapter, "runnerInfo" | "hasCapability" | "commandsList">;

export type AgentCommandsDeps = {
  registry: Pick<AdapterRegistry, "forAgent">;
  runners: AgentCommandsRunners | null;
  logger: Pick<Logger, "warn">;
  now?: () => number;
};

type CacheEntry = { connectedAt: string; expiresAt: number; commands: Promise<AgentCommand[] | null> };

export type AgentCommandsService = {
  /** 에이전트마다 목록 — 차례는 받은 차례 그대로 */
  list(db: DbOrTx, agentList: Agent[]): Promise<AgentCommandsResponse>;
};

export function createAgentCommandsService(deps: AgentCommandsDeps): AgentCommandsService {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  /** 막는 명령(C4·C10)은 목록에 싣지 않는다 — 러너도 내장 중 막는 것을 빼지만 서버가 한 번 더 거른다 */
  function allowed(agent: Agent, commands: readonly AgentCommand[]): AgentCommand[] {
    const program = commandProgramOf(agent);
    return commands.filter((c) => checkCommand(program, c.name, "").ok);
  }

  async function runnerCommands(
    tokenId: string,
    projectId: string,
    project: RunnerProjectRef,
  ): Promise<AgentCommand[] | null> {
    const runners = deps.runners;
    const live = runners?.runnerInfo(tokenId) ?? null;
    if (!runners || !live || !runners.hasCapability(tokenId, "commands")) return null;
    const at = now();
    const hit = cache.get(projectId);
    if (hit && hit.connectedAt === live.connectedAt && hit.expiresAt > at) return hit.commands;
    const commands = runners.commandsList(tokenId, project).then(
      (result: RunnerCommandsListResult) => {
        if (result.ok) return result.commands;
        cache.delete(projectId); // 루트가 없다 등 — 고쳐지면 바로 다시 묻게
        return [];
      },
      (err: unknown) => {
        cache.delete(projectId);
        deps.logger.warn({ err, tokenId, projectId }, "runner commands.list failed");
        return [];
      },
    );
    // 같은 프로젝트를 동시에 물어도 러너에는 한 번 — 약속을 캐시한다
    cache.set(projectId, {
      connectedAt: live.connectedAt,
      expiresAt: at + RUNNER_COMMANDS_CACHE_MS,
      commands,
    });
    return commands;
  }

  async function forAgent(db: DbOrTx, agent: Agent) {
    const none = { agentId: agent.id, commands: [] as AgentCommand[], supported: false };
    if (agent.provider === "runner") {
      const row = db
        .select({
          tokenId: agents.runnerTokenId,
          projectId: runnerProjects.id,
          rootId: runnerProjects.rootId,
          relPath: runnerProjects.relPath,
        })
        .from(agents)
        .innerJoin(runnerProjects, eq(runnerProjects.id, agents.runnerProjectId))
        .where(eq(agents.id, agent.id))
        .get();
      if (!row || row.tokenId === null) return none;
      const commands = await runnerCommands(row.tokenId, row.projectId, {
        rootId: row.rootId,
        relPath: row.relPath,
      });
      return commands === null
        ? none
        : { agentId: agent.id, commands: allowed(agent, commands), supported: true };
    }
    // OpenClaw — 그 Gateway 에 지금 붙은 플러그인이 commands 를 알렸을 때만(끊겼으면 어댑터가 false)
    let supported = false;
    try {
      supported = deps.registry
        .forAgent(agent)
        .supports(agent.providerAgentId, agentConnectionId(db, agent.id), "commands");
    } catch {
      supported = false;
    }
    return supported ? { agentId: agent.id, commands: allowed(agent, OPENCLAW_COMMANDS), supported } : none;
  }

  return {
    async list(db, agentList) {
      return { agents: await Promise.all(agentList.map((agent) => forAgent(db, agent))) };
    },
  };
}
