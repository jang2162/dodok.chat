/**
 * 에이전트별 명령 목록(에이전트 명령 스펙 C8·C9·5.2) — 작성기 자동완성의 도움말일 뿐 허용 목록이 아니다(C5). OpenClaw 는 shared 고정
 * 목록, 러너는 그 프로젝트의 commands.list(프로젝트마다 10분 캐시 — 러너가 다시 붙으면 hello 시각이 바뀌어 새로 묻는다). 맡은 쪽이
 * 끊겼거나 옛 판(능력 commands 없음)이면 supported false·빈 목록. 봇은 그 봇 폴더로 묻는다(러너 봇 스펙 B13 — 능력 bots 일 때, 캐시
 * 키는 봇 id)
 */
import {
  type Agent,
  type AgentCommand,
  type AgentCommandsResponse,
  checkCommand,
  OPENCLAW_COMMANDS,
  type RunnerCommandsList,
  type RunnerCommandsListResult,
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

/**
 * commands 가 null 이면 묻기가 실패했다(목록은 빈 것으로 보이고 listFailed, 별칭은 모른다). settled 는 답이 온 뒤의 값 — 라우터가
 * 기다리지 않고 들여다본다(skillAliases)
 */
type CacheEntry = {
  connectedAt: string;
  expiresAt: number;
  commands: Promise<AgentCommand[] | null>;
  settled?: { commands: AgentCommand[] | null };
};

export type AgentCommandsService = {
  /** 에이전트마다 목록 — 차례는 받은 차례 그대로 */
  list(db: DbOrTx, agentList: Agent[]): Promise<AgentCommandsResponse>;
  /**
   * 러너 에이전트의 사람 스킬 별칭(checkCommand 의 skillAliases — 에이전트 명령 C4). 같은 캐시에 답이 와 있을 때만 그것으로 —
   * 비었거나 아직 묻는 중이면 기다리지 않고 undefined(모른다 — 러너가 그 런의 목록으로 다시 본다)이고, 다음을 위해 묻기만 걸어 둔다
   * (재리뷰 N5 — 기다리면 그 명령 글의 라우팅이 늦어 뒤에 보낸 글이 먼저 런이 된다). 러너가 끊겼거나 옛 판이거나 묻기가 실패해도
   * undefined. OpenClaw 는 undefined
   */
  skillAliases(db: DbOrTx, agent: Agent): ReadonlySet<string> | undefined;
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

  /** cacheKey 는 프로젝트 id 또는 `bot:<봇 id>` — 같은 폴더면 같은 목록 */
  function runnerCommands(
    tokenId: string,
    cacheKey: string,
    req: RunnerCommandsList,
  ): CacheEntry | undefined {
    const projectId = cacheKey;
    const runners = deps.runners;
    const live = runners?.runnerInfo(tokenId) ?? null;
    if (!runners || !live || !runners.hasCapability(tokenId, "commands")) return undefined;
    if ("bot" in req && !runners.hasCapability(tokenId, "bots")) return undefined;
    const at = now();
    const hit = cache.get(projectId);
    if (hit && hit.connectedAt === live.connectedAt && hit.expiresAt > at) return hit;
    // 실패하면 지운다 — 루트가 없다 등이 고쳐지면 바로 다시 묻게. 그사이(재접속 뒤) 새로 넣은 항목은 남긴다
    const forget = () => {
      if (cache.get(projectId) === entry) cache.delete(projectId);
    };
    const commands = runners.commandsList(tokenId, req).then(
      (result: RunnerCommandsListResult) => {
        entry.settled = { commands: result.ok ? result.commands : null };
        if (result.ok) return result.commands;
        forget();
        return null;
      },
      (err: unknown) => {
        entry.settled = { commands: null };
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
    return entry;
  }

  /** 러너 에이전트의 캐시 항목(없으면 묻기를 건다) — undefined 면 맡은 쪽이 없다(끊김·옛 판·프로젝트 없음) */
  function runnerAgentEntry(db: DbOrTx, agent: Agent): CacheEntry | undefined {
    const row = db
      .select({
        tokenId: agents.runnerTokenId,
        providerAgentId: agents.providerAgentId,
        bot: agents.runnerBot,
        projectId: runnerProjects.id,
        rootId: runnerProjects.rootId,
        relPath: runnerProjects.relPath,
      })
      .from(agents)
      .leftJoin(runnerProjects, eq(runnerProjects.id, agents.runnerProjectId))
      .where(eq(agents.id, agent.id))
      .get();
    if (!row || row.tokenId === null) return undefined;
    if (row.bot !== null) {
      const id = row.providerAgentId.toLowerCase();
      return runnerCommands(row.tokenId, `bot:${id}`, { bot: { id } });
    }
    if (row.projectId === null || row.rootId === null || row.relPath === null) return undefined;
    return runnerCommands(row.tokenId, row.projectId, {
      project: { rootId: row.rootId, relPath: row.relPath },
    });
  }

  /** 러너 에이전트의 목록 — undefined 면 맡은 쪽이 없다(끊김·옛 판·프로젝트 없음), null 이면 묻기가 실패했다 */
  async function runnerAgentCommands(db: DbOrTx, agent: Agent): Promise<AgentCommand[] | null | undefined> {
    return runnerAgentEntry(db, agent)?.commands;
  }

  async function forAgent(db: DbOrTx, agent: Agent) {
    const none = { agentId: agent.id, commands: [] as AgentCommand[], supported: false };
    if (agent.provider === "runner") {
      const commands = await runnerAgentCommands(db, agent);
      if (commands === undefined) return none;
      // 묻기 실패(일시 실패·루트 없음)는 「쓸 수 있는 별칭이 없다」가 아니다 — 웹은 별칭을 모른다고 보고 막지 않는다(재리뷰 N3)
      return commands === null
        ? { agentId: agent.id, commands: [] as AgentCommand[], supported: true, listFailed: true }
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
    skillAliases(db, agent) {
      if (agent.provider !== "runner") return undefined;
      const commands = runnerAgentEntry(db, agent)?.settled?.commands;
      return commands === undefined || commands === null ? undefined : skillAliasesOf(commands);
    },
  };
}
