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
  skillAliasesOf,
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

/** commands 가 null 이면 묻기가 실패했다(목록은 빈 것으로 보이고, 별칭은 모른다) */
type CacheEntry = { connectedAt: string; expiresAt: number; commands: Promise<AgentCommand[] | null> };

export type AgentCommandsService = {
  /** 에이전트마다 목록 — 차례는 받은 차례 그대로 */
  list(db: DbOrTx, agentList: Agent[]): Promise<AgentCommandsResponse>;
  /**
   * 러너 에이전트의 사람 스킬 별칭(checkCommand 의 skillAliases — 에이전트 명령 C4). 같은 캐시를 쓰고 없으면 그 자리에서 묻는다.
   * 러너가 끊겼거나 옛 판이거나 묻기가 실패하면 undefined(모른다 — 러너가 그 런의 목록으로 다시 본다). OpenClaw 는 undefined
   */
  skillAliases(db: DbOrTx, agent: Agent): Promise<ReadonlySet<string> | undefined>;
};

export function createAgentCommandsService(deps: AgentCommandsDeps): AgentCommandsService {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  /** 막는 명령(C4·C10)은 목록에 싣지 않는다 — 러너도 허용 목록 밖 내장을 빼지만 서버가 한 번 더 거른다 */
  function allowed(agent: Agent, commands: readonly AgentCommand[]): AgentCommand[] {
    const program = commandProgramOf(agent);
    const skillAliases = skillAliasesOf(commands);
    return commands.filter((c) => checkCommand(program, c.name, "", { skillAliases }).ok);
  }

  async function runnerCommands(
    tokenId: string,
    projectId: string,
    project: RunnerProjectRef,
  ): Promise<AgentCommand[] | null | undefined> {
    const runners = deps.runners;
    const live = runners?.runnerInfo(tokenId) ?? null;
    if (!runners || !live || !runners.hasCapability(tokenId, "commands")) return undefined;
    const at = now();
    const hit = cache.get(projectId);
    if (hit && hit.connectedAt === live.connectedAt && hit.expiresAt > at) return hit.commands;
    // 실패하면 지운다 — 루트가 없다 등이 고쳐지면 바로 다시 묻게. 그사이(재접속 뒤) 새로 넣은 항목은 남긴다
    const forget = () => {
      if (cache.get(projectId) === entry) cache.delete(projectId);
    };
    const commands = runners.commandsList(tokenId, project).then(
      (result: RunnerCommandsListResult) => {
        if (result.ok) return result.commands;
        forget();
        return null;
      },
      (err: unknown) => {
        forget();
        deps.logger.warn({ err, tokenId, projectId }, "runner commands.list failed");
        return null;
      },
    );
    // 같은 프로젝트를 동시에 물어도 러너에는 한 번 — 약속을 캐시한다
    const entry: CacheEntry = {
      connectedAt: live.connectedAt,
      expiresAt: at + RUNNER_COMMANDS_CACHE_MS,
      commands,
    };
    cache.set(projectId, entry);
    return commands;
  }

  /** 러너 에이전트의 목록 — undefined 면 맡은 쪽이 없다(끊김·옛 판·프로젝트 없음), null 이면 묻기가 실패했다 */
  async function runnerAgentCommands(db: DbOrTx, agent: Agent): Promise<AgentCommand[] | null | undefined> {
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
    if (!row || row.tokenId === null) return undefined;
    return runnerCommands(row.tokenId, row.projectId, { rootId: row.rootId, relPath: row.relPath });
  }

  async function forAgent(db: DbOrTx, agent: Agent) {
    const none = { agentId: agent.id, commands: [] as AgentCommand[], supported: false };
    if (agent.provider === "runner") {
      const commands = await runnerAgentCommands(db, agent);
      return commands === undefined
        ? none
        : { agentId: agent.id, commands: allowed(agent, commands ?? []), supported: true };
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
    async skillAliases(db, agent) {
      if (agent.provider !== "runner") return undefined;
      const commands = await runnerAgentCommands(db, agent);
      return commands === undefined || commands === null ? undefined : skillAliasesOf(commands);
    },
  };
}
