import { Agent, Id, isRegistrableAgentId } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdapterRegistry } from "../../adapters/registry";
import { AdapterError } from "../../adapters/types";
import type { Auth } from "../../auth";
import { requireRole } from "../../auth/roles";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams, parseQuery } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { syncPromptToGateway } from "../channels/prompt-sync";
import { agentChannelGateways } from "../channels/service";
import { getGatewayRow } from "../gateways/service";
import type { Orchestrator } from "../runs/orchestrator";
import {
  archiveAgent,
  createAgent,
  findArchivedAgent,
  getAgent,
  listAgents,
  moveAgentGateway,
  restoreAgent,
  updateAgent,
} from "./service";

export type AgentRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  bus: ServerBus;
  logger: Logger;
  registry: Pick<AdapterRegistry, "forProvider">;
  /** 보관이 그 에이전트의 열린 런을 사람 「중지」와 같은 길로 멈춘다 */
  orchestrator: Pick<Orchestrator, "abort">;
  /** claude 에이전트 등록이 묶을 러너 토큰 — 그 id 를 지금 맡는 러너의 토큰(러너 어댑터 servingTokenId). 없으면 묶임 없이 등록 */
  runnerTokenFor?: (providerAgentId: string) => string | undefined;
};

const AgentParams = z.object({ id: Id });
// OpenClaw 는 그 Gateway 의 agents.list — gatewayId 가 있어야 한다. 러너는 붙은 러너 전부(연결을 고르지 않는다)
const DiscoverQuery = z.object({
  provider: z.enum(["openclaw", "claude"]).default("openclaw"),
  gatewayId: Id.optional(),
});

const CreateAgentBody = Agent.pick({
  providerAgentId: true,
  handle: true,
  name: true,
  avatarUrl: true,
  basePrompt: true,
}).extend({
  // 세션 키 빌더(dodokSessionKey) 규칙에 소문자까지 — 밖의 id 는 키를 못 만들고, 대문자는 코어가 접은 키와 어긋난다
  providerAgentId: Agent.shape.providerAgentId.refine(isRegistrableAgentId, {
    message:
      "providerAgentId 는 OpenClaw 에이전트 id(영문 소문자·숫자로 시작, 영문 소문자·숫자·_·-, 64자 이하)여야 한다",
  }),
  // 판정 P9 — 서버는 목록 검사를 하지 않는다(OpenClaw 와 같다). 웹이 discover?provider= 목록에서 고른다
  provider: z.enum(["openclaw", "claude"]).default("openclaw"),
  enabled: Agent.shape.enabled.default(true),
  // OpenClaw 에이전트의 Gateway — OpenClaw 면 필수(아래 라우트가 400), 러너 에이전트는 무시한다
  gatewayId: Id.optional(),
});

const MoveGatewayBody = z.object({ gatewayId: Id });

/** avatarUrl·basePrompt 는 null 로 지운다 */
const UpdateAgentBody = Agent.pick({ handle: true, name: true, enabled: true }).partial().extend({
  avatarUrl: Agent.shape.avatarUrl.unwrap().nullable().optional(),
  basePrompt: Agent.shape.basePrompt.unwrap().nullable().optional(),
});

export function registerAgentRoutes(fastify: FastifyInstance, ctx: AgentRouteContext): void {
  const authed = { preHandler: requireSession(ctx) };
  const admin = { preHandler: requireRole(ctx, "admin") };
  const owner = { preHandler: requireRole(ctx, "owner") };
  // 다른 탭·사람의 화면이 에이전트·채널 멤버 목록을 다시 받게 — 본문이 없다(계획 판정 PS4)
  const changed = () => ctx.bus.emit("agents.changed", {});

  fastify.get("/api/v1/agents", authed, async (request) => ({
    agents: listAgents(ctx.db, sessionUser(request).workspaceId),
  }));

  fastify.post("/api/v1/agents", admin, async (request, reply) => {
    const body = parseBody(CreateAgentBody, request.body);
    if (body.provider === "openclaw" && body.gatewayId === undefined)
      throw apiError("VALIDATION", "gatewayId is required for OpenClaw", { field: "gatewayId" });
    const runnerTokenId = body.provider === "claude" ? ctx.runnerTokenFor?.(body.providerAgentId) : undefined;
    const agent = createAgent(ctx.db, {
      ...body,
      workspaceId: sessionUser(request).workspaceId,
      ...(runnerTokenId === undefined ? {} : { runnerTokenId }),
    });
    changed();
    return reply.code(201).send({ agent });
  });

  fastify.patch("/api/v1/agents/:id", admin, async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    if (!getAgent(ctx.db, id, sessionUser(request).workspaceId))
      throw apiError("NOT_FOUND", "agent not found");
    const patch = parseBody(UpdateAgentBody, request.body);
    const agent = updateAgent(ctx.db, id, patch);
    changed();
    return { agent };
  });

  /**
   * 보관(스펙 「에이전트 보관」 절, admin) — 행·핸들·채널 참여·세션은 남고 열린 런은 멈춘다. 이미 보관했으면 200 그대로
   */
  fastify.delete("/api/v1/agents/:id", admin, async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    const agent = await archiveAgent(ctx.db, ctx, id, sessionUser(request).workspaceId);
    changed();
    return { agent };
  });

  /** 되살리기(admin) — 같은 채널·세션으로 이어 답한다. 살아 있으면 200 그대로 */
  fastify.post("/api/v1/agents/:id/restore", admin, async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    const agent = restoreAgent(ctx.db, id, sessionUser(request).workspaceId);
    changed();
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

  /**
   * 그 제공자 어댑터의 listAgents 를 그대로 — 등록 화면(admin)의 선택지. OpenClaw 는 Gateway agents.list, Claude 러너는 붙은
   * 러너들이 hello 로 알린 에이전트(충돌 빼고). 자동 동기화는 하지 않는다(스펙 3.5). 같은 자리의 보관한 에이전트가 있으면
   * archivedAgentId 를 싣는다 — 웹은 등록 대신 되살리기를 보인다
   */
  fastify.get("/api/v1/agents/discover", admin, async (request) => {
    const { provider, gatewayId } = parseQuery(DiscoverQuery, request.query);
    if (provider === "openclaw") {
      if (gatewayId === undefined)
        throw apiError("VALIDATION", "gatewayId is required for OpenClaw", { field: "gatewayId" });
      // 등록·옮기기와 같이 워크스페이스의 Gateway 만. 꺼진 Gateway 는 어댑터에 묻지 않는다(연결이 없다)
      const gateway = getGatewayRow(ctx.db, sessionUser(request).workspaceId, gatewayId);
      if (!gateway) throw apiError("VALIDATION", "gateway not found", { field: "gatewayId" });
      if (!gateway.enabled) throw apiError("ADAPTER_UNAVAILABLE", "gateway is disabled");
    }
    const adapter = ctx.registry.forProvider(provider);
    if (!adapter) throw apiError("ADAPTER_UNAVAILABLE", "adapter not configured");
    try {
      const found = await adapter.listAgents(provider === "openclaw" ? (gatewayId ?? null) : null);
      const workspaceId = sessionUser(request).workspaceId;
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
  });
}
