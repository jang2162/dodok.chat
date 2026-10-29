import type { Agent, CreateAgentBody, DiscoverAgentsQuery } from "@dodok/shared";
import type { AdapterRegistry } from "../../adapters/registry";
import { AdapterError } from "../../adapters/types";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import type { ServerBus } from "../../realtime/bus";
import { getGatewayRow } from "../gateways/service";
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
  /** 러너 에이전트 등록이 묶을 러너 토큰 — 그 id 를 지금 맡는 러너의 토큰(러너 어댑터 servingTokenId). 없으면 묶임 없이 등록 */
  runnerTokenFor?: (providerAgentId: string) => string | undefined;
};

/** 다른 탭·사람의 화면이 에이전트·채널 멤버 목록을 다시 받게 — 본문이 없다(계획 판정 PS4) */
function changed(ctx: AgentActionContext): void {
  ctx.bus.emit("agents.changed", {});
}

export function registerAgentAndNotify(
  ctx: AgentActionContext,
  body: CreateAgentBody,
  workspaceId: string,
): Agent {
  if (body.provider === "openclaw" && body.gatewayId === undefined)
    throw apiError("VALIDATION", "gatewayId is required for OpenClaw", { field: "gatewayId" });
  const runnerTokenId = body.provider === "runner" ? ctx.runnerTokenFor?.(body.providerAgentId) : undefined;
  const agent = createAgent(ctx.db, {
    ...body,
    workspaceId,
    ...(runnerTokenId === undefined ? {} : { runnerTokenId }),
  });
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
 * 그 제공자 어댑터의 listAgents 를 그대로 — 등록 화면(admin)의 선택지. OpenClaw 는 Gateway agents.list, 러너는 붙은
 * 러너들이 hello 로 알린 에이전트(충돌 빼고). 자동 동기화는 하지 않는다(스펙 3.5). 같은 자리의 보관한 에이전트가 있으면
 * archivedAgentId 를 싣는다 — 웹은 등록 대신 되살리기를 보인다
 */
export async function discoverAgents(
  ctx: Pick<AgentActionContext, "db" | "registry">,
  query: DiscoverAgentsQuery,
  workspaceId: string,
): Promise<{ agents: Array<DiscoveredAgent & { archivedAgentId?: string }> }> {
  const { provider, gatewayId } = query;
  if (provider === "openclaw") {
    if (gatewayId === undefined)
      throw apiError("VALIDATION", "gatewayId is required for OpenClaw", { field: "gatewayId" });
    // 등록·옮기기와 같이 워크스페이스의 Gateway 만. 꺼진 Gateway 는 어댑터에 묻지 않는다(연결이 없다)
    const gateway = getGatewayRow(ctx.db, workspaceId, gatewayId);
    if (!gateway) throw apiError("VALIDATION", "gateway not found", { field: "gatewayId" });
    if (!gateway.enabled) throw apiError("ADAPTER_UNAVAILABLE", "gateway is disabled");
  }
  const adapter = ctx.registry.forProvider(provider);
  if (!adapter) throw apiError("ADAPTER_UNAVAILABLE", "adapter not configured");
  try {
    const found = await adapter.listAgents(provider === "openclaw" ? (gatewayId ?? null) : null);
    return {
      agents: found.map((entry) => {
        const archivedAgentId = findArchivedAgent(ctx.db, {
          workspaceId,
          provider,
          providerAgentId: entry.providerAgentId,
          gatewayId: provider === "openclaw" ? (gatewayId ?? null) : null,
        });
        return archivedAgentId === undefined ? entry : { ...entry, archivedAgentId };
      }),
    };
  } catch (err) {
    if (err instanceof AdapterError) throw apiError(err.code, err.message);
    throw err;
  }
}
