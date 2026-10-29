import { CreateAgentBody, DiscoverAgentsQuery, Id, UpdateAgentBody } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdapterRegistry } from "../../adapters/registry";
import type { Auth } from "../../auth";
import {
  authorizeAgentArchive,
  authorizeAgentDiscover,
  authorizeAgentPatch,
  authorizeAgentRegister,
  authorizeRead,
} from "../../auth/policies";
import { requirePolicy, requireRole } from "../../auth/roles";
import { sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams, parseQuery } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { syncPromptToGateway } from "../channels/prompt-sync";
import { agentChannelGateways, listMembers } from "../channels/service";
import type { Orchestrator } from "../runs/orchestrator";
import {
  archiveAgentAndNotify,
  discoverAgents,
  patchAgentAndNotify,
  registerAgentAndNotify,
} from "./actions";
import { getAgent, listAgents, moveAgentGateway, restoreAgent } from "./service";

export type AgentRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  bus: ServerBus;
  logger: Logger;
  registry: Pick<AdapterRegistry, "forProvider">;
  /** 보관이 그 에이전트의 열린 런을 사람 「중지」와 같은 길로 멈춘다 */
  orchestrator: Pick<Orchestrator, "abort">;
};

const AgentParams = z.object({ id: Id });
const MoveGatewayBody = z.object({ gatewayId: Id });

export function registerAgentRoutes(fastify: FastifyInstance, ctx: AgentRouteContext): void {
  const policy = (p: Parameters<typeof requirePolicy>[1]) => ({ preHandler: requirePolicy(ctx, p) });
  const admin = { preHandler: requireRole(ctx, "admin") };
  const owner = { preHandler: requireRole(ctx, "owner") };
  // 다른 탭·사람의 화면이 에이전트·채널 멤버 목록을 다시 받게 — 본문이 없다(계획 판정 PS4)
  const changed = () => ctx.bus.emit("agents.changed", {});

  fastify.get("/api/v1/agents", policy(authorizeRead), async (request) => ({
    agents: listAgents(ctx.db, sessionUser(request).workspaceId),
  }));

  fastify.post("/api/v1/agents", policy(authorizeAgentRegister), async (request, reply) => {
    const body = parseBody(CreateAgentBody, request.body);
    const agent = registerAgentAndNotify(ctx, body, sessionUser(request).workspaceId);
    return reply.code(201).send({ agent });
  });

  fastify.patch("/api/v1/agents/:id", policy(authorizeAgentPatch), async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    // 본문보다 먼저 404 — 옛 순서 그대로(patchAgentAndNotify 도 다시 본다)
    if (!getAgent(ctx.db, id, sessionUser(request).workspaceId))
      throw apiError("NOT_FOUND", "agent not found");
    const patch = parseBody(UpdateAgentBody, request.body);
    return { agent: patchAgentAndNotify(ctx, id, patch, sessionUser(request).workspaceId) };
  });

  /** 보관(admin) — 이미 보관했으면 200 그대로 */
  fastify.delete("/api/v1/agents/:id", policy(authorizeAgentArchive), async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    return { agent: await archiveAgentAndNotify(ctx, id, sessionUser(request).workspaceId) };
  });

  /** 되살리기(admin) — 같은 채널·세션으로 이어 답한다. 살아 있으면 200 그대로 */
  fastify.post("/api/v1/agents/:id/restore", admin, async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    const { agent, autoRespondOffChannelIds } = restoreAgent(ctx.db, id, sessionUser(request).workspaceId);
    changed();
    for (const channelId of autoRespondOffChannelIds)
      ctx.bus.emit("channel.member.changed", { channelId, members: listMembers(ctx.db, channelId) });
    return { agent };
  });

  /**
   * OpenClaw 에이전트를 다른 Gateway 로(멀티 Gateway 스펙 「에이전트 API」 절, owner) — Gateway 가 지워져 연결이 빈 에이전트를 살리는 길이다.
   * 그 Gateway 가 이 에이전트의 채널에 새로 들어오면 그 채널의 프롬프트를 한 번 보낸다(계획 판정 PG10)
   */
  fastify.put("/api/v1/agents/:id/gateway", owner, async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    const { gatewayId } = parseBody(MoveGatewayBody, request.body);
    const workspaceId = sessionUser(request).workspaceId;
    const channelsBefore = agentChannelGateways(ctx.db, id);
    const { agent, previousGatewayId } = moveAgentGateway(ctx.db, { workspaceId, agentId: id, gatewayId });
    if (previousGatewayId !== gatewayId) {
      for (const { channelId, gatewayIds } of channelsBefore)
        if (!gatewayIds.includes(gatewayId)) syncPromptToGateway(ctx, channelId, gatewayId);
    }
    changed();
    return { agent };
  });

  /** 가져올 에이전트 목록(admin) — 검사·보관한 에이전트 표시는 discoverAgents */
  fastify.get("/api/v1/agents/discover", policy(authorizeAgentDiscover), async (request) =>
    discoverAgents(ctx, parseQuery(DiscoverAgentsQuery, request.query), sessionUser(request).workspaceId),
  );
}
