import { Agent, Id, isRegistrableAgentId } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdapterRegistry } from "../../adapters/registry";
import { OPENCLAW_ENV_CONNECTION_ID } from "../../config";
import { AdapterError } from "../../adapters/types";
import type { Auth } from "../../auth";
import { requireRole } from "../../auth/roles";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams, parseQuery } from "../../http/validate";
import { createAgent, getAgent, listAgents, updateAgent } from "./service";

export type AgentRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  registry: Pick<AdapterRegistry, "forProvider">;
  /** claude 에이전트 등록이 묶을 러너 토큰 — 그 id 를 지금 맡는 러너의 토큰(러너 어댑터 servingTokenId). 없으면 묶임 없이 등록 */
  runnerTokenFor?: (providerAgentId: string) => string | undefined;
};

const AgentParams = z.object({ id: Id });
const DiscoverQuery = z.object({ provider: z.enum(["openclaw", "claude"]).default("openclaw") });

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
});

/** avatarUrl·basePrompt 는 null 로 지운다 */
const UpdateAgentBody = Agent.pick({ handle: true, name: true, enabled: true }).partial().extend({
  avatarUrl: Agent.shape.avatarUrl.unwrap().nullable().optional(),
  basePrompt: Agent.shape.basePrompt.unwrap().nullable().optional(),
});

export function registerAgentRoutes(fastify: FastifyInstance, ctx: AgentRouteContext): void {
  const authed = { preHandler: requireSession(ctx) };
  const admin = { preHandler: requireRole(ctx, "admin") };

  fastify.get("/api/v1/agents", authed, async (request) => ({
    agents: listAgents(ctx.db, sessionUser(request).workspaceId),
  }));

  fastify.post("/api/v1/agents", admin, async (request, reply) => {
    const body = parseBody(CreateAgentBody, request.body);
    const runnerTokenId = body.provider === "claude" ? ctx.runnerTokenFor?.(body.providerAgentId) : undefined;
    const agent = createAgent(ctx.db, {
      ...body,
      workspaceId: sessionUser(request).workspaceId,
      ...(runnerTokenId === undefined ? {} : { runnerTokenId }),
    });
    return reply.code(201).send({ agent });
  });

  fastify.patch("/api/v1/agents/:id", admin, async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    if (!getAgent(ctx.db, id, sessionUser(request).workspaceId))
      throw apiError("NOT_FOUND", "agent not found");
    const patch = parseBody(UpdateAgentBody, request.body);
    return { agent: updateAgent(ctx.db, id, patch) };
  });

  /**
   * 그 제공자 어댑터의 listAgents 를 그대로 — 등록 화면(admin)의 선택지. OpenClaw 는 Gateway agents.list, Claude 러너는 붙은
   * 러너들이 hello 로 알린 에이전트(충돌 빼고). 자동 동기화는 하지 않는다(스펙 3.5)
   */
  fastify.get("/api/v1/agents/discover", admin, async (request) => {
    const { provider } = parseQuery(DiscoverQuery, request.query);
    const adapter = ctx.registry.forProvider(provider);
    if (!adapter) throw apiError("ADAPTER_UNAVAILABLE", "adapter not configured");
    try {
      // OpenClaw 는 아직 .env 의 Gateway 하나, 러너 찾기는 붙은 러너 전부(연결을 고르지 않는다)
      return {
        agents: await adapter.listAgents(provider === "openclaw" ? OPENCLAW_ENV_CONNECTION_ID : null),
      };
    } catch (err) {
      if (err instanceof AdapterError) throw apiError(err.code, err.message);
      throw err;
    }
  });
}
