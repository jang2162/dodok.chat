import type {
  Agent,
  CreateOpenClawAgentBody,
  CreateRunnerAgentBody,
  DiscoverAgentsQuery,
} from "@dodok/shared";
import type { AdapterRegistry } from "../../adapters/registry";
import { AdapterError } from "../../adapters/types";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import type { ServerBus } from "../../realtime/bus";
import { getGatewayRow } from "../gateways/service";
import { assertWithinCeiling, liveRunner, type RunnerLiveApi } from "../runners/live";
import { getProject } from "../runners/projects";
import type { Orchestrator } from "../runs/orchestrator";
import {
  type AgentPatch,
  archiveAgent,
  createAgent,
  findArchivedAgent,
  getAgent,
  updateAgent,
} from "./service";

// 에이전트 쓰기·가져오기 목록의 「검사 + 저장 + 알림」 — REST 라우트와 제어 도구(modules/control/handlers.ts)가 같은 함수를 불러 결과·
// 오류·버스 이벤트가 갈라지지 않는다(제어 MCP 스펙 결정 6). 역할 검사는 부르는 쪽이 먼저 한다

/** 어댑터 listAgents 한 줄 */
type DiscoveredAgent = { providerAgentId: string; name?: string; hint?: string };

export type AgentActionContext = {
  db: Db;
  bus: ServerBus;
  registry: Pick<AdapterRegistry, "forProvider">;
  /** 보관이 그 에이전트의 열린 런을 사람 「중지」와 같은 길로 멈춘다 */
  orchestrator: Pick<Orchestrator, "abort">;
};

/** 다른 탭·사람의 화면이 에이전트·채널 멤버 목록을 다시 받게 — 본문이 없다(계획 판정 PS4) */
function changed(ctx: AgentActionContext): void {
  ctx.bus.emit("agents.changed", {});
}

/** OpenClaw 에이전트 등록 — REST 와 제어 도구 register_agent. 러너 에이전트는 createRunnerAgentAndNotify(REST 만) */
export function registerAgentAndNotify(
  ctx: AgentActionContext,
  body: CreateOpenClawAgentBody,
  workspaceId: string,
  /** 만든 사람(소유자) — REST 는 요청한 사람, 제어 도구는 그 주체의 사람 */
  createdBy: string | null,
): Agent {
  if (body.gatewayId === undefined)
    throw apiError("VALIDATION", "gatewayId is required for OpenClaw", { field: "gatewayId" });
  const { provider: _, ...rest } = body;
  const agent = createAgent(ctx.db, { ...rest, provider: "openclaw", workspaceId, createdBy });
  changed(ctx);
  return agent;
}

/**
 * 러너 에이전트 만들기(러너 일반화 스펙 7장, REST 만 — 제어 도구는 러너 구성을 바꾸지 못한다). 프로젝트가 보관됐으면 붙은 러너를
 * 묻기 전에 VALIDATION, 그 프로젝트의 러너가 붙어 있어야 하고(아니면 503 — 프로그램 목록이 없다) 프로그램이 그 러너의 천장 안이어야
 * 한다(VALIDATION + 항목 이름). 모델·권한 모드는 만들 때 받지 않는다(세션 설정 스펙 5.5). 런마다 러너가 다시 본다
 */
export function createRunnerAgentAndNotify(
  ctx: AgentActionContext & { runners: RunnerLiveApi | null },
  body: CreateRunnerAgentBody,
  workspaceId: string,
  createdBy: string | null,
): Agent {
  const project = getProject(ctx.db, workspaceId, body.runnerProjectId);
  if (!project) throw apiError("VALIDATION", "runner project not found", { field: "runnerProjectId" });
  if (project.archivedAt !== null)
    throw apiError("VALIDATION", "runner project is archived", { field: "runnerProjectId" });
  assertWithinCeiling(
    liveRunner(ctx.runners, project.runnerTokenId),
    body.program,
    {},
    { requireAvailable: true },
  );
  const { provider: _, ...rest } = body;
  const agent = createAgent(ctx.db, { ...rest, provider: "runner", workspaceId, createdBy });
  changed(ctx);
  return agent;
}

/** 다른 워크스페이스의 에이전트는 없는 것과 같다(404) */
export function patchAgentAndNotify(
  ctx: AgentActionContext,
  id: string,
  patch: AgentPatch,
  workspaceId: string,
): Agent {
  if (!getAgent(ctx.db, id, workspaceId)) throw apiError("NOT_FOUND", "agent not found");
  const agent = updateAgent(ctx.db, id, patch);
  changed(ctx);
  return agent;
}

/**
 * 에이전트 사진(프로필 스펙 3.6) — 새 주소(올린 사진) 또는 null(지움)로 바꾸고 agents.changed. 옛 주소는 돌려준다 — 부르는 쪽이 그 파일을
 * 놓는다(profile/avatars.ts releaseAvatar). 역할 검사는 부르는 쪽이 먼저 한다(PATCH 와 같은 정책)
 */
export function setAgentAvatarAndNotify(
  ctx: Pick<AgentActionContext, "db" | "bus">,
  id: string,
  avatarUrl: string | null,
  workspaceId: string,
): { agent: Agent; previous: string | null } {
  const current = getAgent(ctx.db, id, workspaceId);
  if (!current) throw apiError("NOT_FOUND", "agent not found");
  const agent = updateAgent(ctx.db, id, { avatarUrl });
  ctx.bus.emit("agents.changed", {});
  return { agent, previous: current.avatarUrl ?? null };
}

/** 보관(스펙 「에이전트 보관」 절) — 행·핸들·채널 참여·세션은 남고 열린 런은 멈춘다. 이미 보관했으면 그대로 */
export async function archiveAgentAndNotify(
  ctx: AgentActionContext,
  id: string,
  workspaceId: string,
): Promise<Agent> {
  const agent = await archiveAgent(ctx.db, ctx, id, workspaceId);
  changed(ctx);
  return agent;
}

/**
 * OpenClaw Gateway 의 agents.list 를 그대로 — 등록 화면(admin)의 선택지. 러너 에이전트는 알린 목록이 없다(러너 프로젝트에서 만든다 —
 * 러너 일반화 계획 판정 PR9). 자동 동기화는 하지 않는다(스펙 3.5). 같은 자리의 보관한 에이전트가 있으면 archivedAgentId 를 싣는다 —
 * 웹은 등록 대신 되살리기를 보인다
 */
export async function discoverAgents(
  ctx: Pick<AgentActionContext, "db" | "registry">,
  query: DiscoverAgentsQuery,
  workspaceId: string,
): Promise<{ agents: Array<DiscoveredAgent & { archivedAgentId?: string }> }> {
  const { gatewayId } = query;
  if (gatewayId === undefined)
    throw apiError("VALIDATION", "gatewayId is required for OpenClaw", { field: "gatewayId" });
  // 등록·옮기기와 같이 워크스페이스의 Gateway 만. 꺼진 Gateway 는 어댑터에 묻지 않는다(연결이 없다)
  const gateway = getGatewayRow(ctx.db, workspaceId, gatewayId);
  if (!gateway) throw apiError("VALIDATION", "gateway not found", { field: "gatewayId" });
  if (!gateway.enabled) throw apiError("ADAPTER_UNAVAILABLE", "gateway is disabled");
  const adapter = ctx.registry.forProvider("openclaw");
  if (!adapter) throw apiError("ADAPTER_UNAVAILABLE", "adapter not configured");
  try {
    const found = await adapter.listAgents(gatewayId);
    return {
      agents: found.map((entry) => {
        const archivedAgentId = findArchivedAgent(ctx.db, {
          workspaceId,
          provider: "openclaw",
          providerAgentId: entry.providerAgentId,
          gatewayId,
        });
        return archivedAgentId === undefined ? entry : { ...entry, archivedAgentId };
      }),
    };
  } catch (err) {
    if (err instanceof AdapterError) throw apiError(err.code, err.message);
    throw err;
  }
}
