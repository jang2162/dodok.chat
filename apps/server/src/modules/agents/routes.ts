import {
  CreateOpenClawAgentBody,
  CreateRunnerAgentBody,
  DiscoverAgentsQuery,
  Id,
  UpdateAgentBody,
} from "@dodok/shared";
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
import { assertWithinCeiling, type RunnerLiveApi } from "../runners/live";
import {
  archiveAgentAndNotify,
  createRunnerAgentAndNotify,
  discoverAgents,
  patchAgentAndNotify,
  registerAgentAndNotify,
} from "./actions";
import {
  agentForRole,
  getAgent,
  listAgents,
  moveAgentGateway,
  restoreAgent,
  runnerPlacement,
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
  /** 러너 에이전트 만들기·고치기의 천장 대조 — 러너 어댑터가 없으면 null(러너 에이전트 만들기는 503) */
  runners: RunnerLiveApi | null;
};

/**
 * 러너 에이전트 PATCH 의 권한 모드·허용 도구가 붙은 러너의 천장 안인가 — 러너가 끊겨 있으면 건너뛴다(런에서 러너가 거절한다 — 러너
 * 일반화 계획 Task 4). OpenClaw 에이전트의 러너 필드는 서비스(updateAgent)가 VALIDATION 으로 막는다
 */
function assertRunnerPatchWithinCeiling(
  ctx: AgentRouteContext,
  id: string,
  patch: UpdateAgentBody,
  workspaceId: string,
): void {
  if (patch.permissionMode === undefined && patch.allowedTools === undefined) return;
  const placement = runnerPlacement(ctx.db, id, workspaceId);
  if (placement?.provider !== "runner" || placement.runnerTokenId === null || placement.program === null)
    return;
  const live = ctx.runners?.runnerInfo(placement.runnerTokenId) ?? null;
  if (!live) return;
  assertWithinCeiling(
    live,
    placement.program,
    {
      ...(patch.permissionMode === undefined ? {} : { permissionMode: patch.permissionMode }),
      ...(patch.allowedTools === undefined ? {} : { allowedTools: patch.allowedTools }),
    },
    { requireAvailable: false },
  );
}

/**
 * 러너 에이전트의 프로그램·프로젝트는 PATCH 로 바꾸지 않는다(태스크 4 보고 3-4 — 프로젝트는 「다른 러너로 옮기기」 하나로, 프로그램을
 * 바꾸면 세션 전사가 다른 프로그램 것이 된다). UpdateAgentBody 는 모르는 키를 버리므로 조용히 200 이 되지 않게 원래 본문에서 본다(태스크
 * 4 리뷰 L4)
 */
const FIXED_RUNNER_FIELDS = ["program", "runnerProjectId"] as const;

function assertNoFixedRunnerFields(body: unknown): void {
  if (typeof body !== "object" || body === null) return;
  const field = FIXED_RUNNER_FIELDS.find((key) => Object.hasOwn(body, key));
  if (field) throw apiError("VALIDATION", `러너 에이전트의 ${field} 는 고칠 수 없습니다`, { field });
}

const AgentParams = z.object({ id: Id });
const MoveGatewayBody = z.object({ gatewayId: Id });

export function registerAgentRoutes(fastify: FastifyInstance, ctx: AgentRouteContext): void {
  const policy = (p: Parameters<typeof requirePolicy>[1]) => ({ preHandler: requirePolicy(ctx, p) });
  const admin = { preHandler: requireRole(ctx, "admin") };
  const owner = { preHandler: requireRole(ctx, "owner") };
  // 다른 탭·사람의 화면이 에이전트·채널 멤버 목록을 다시 받게 — 본문이 없다(계획 판정 PS4)
  const changed = () => ctx.bus.emit("agents.changed", {});

  fastify.get("/api/v1/agents", policy(authorizeRead), async (request) => {
    const user = sessionUser(request);
    return { agents: listAgents(ctx.db, user.workspaceId).map((agent) => agentForRole(agent, user.role)) };
  });

  /** 등록(admin) — provider 로 갈래를 고르고 그 갈래의 스키마로 파싱한다(오류가 그 갈래의 필드를 가리키게) */
  fastify.post("/api/v1/agents", policy(authorizeAgentRegister), async (request, reply) => {
    const { workspaceId, id: userId } = sessionUser(request);
    const runner = (request.body as { provider?: unknown } | null)?.provider === "runner";
    const agent = runner
      ? createRunnerAgentAndNotify(ctx, parseBody(CreateRunnerAgentBody, request.body), workspaceId, userId)
      : registerAgentAndNotify(ctx, parseBody(CreateOpenClawAgentBody, request.body), workspaceId, userId);
    return reply.code(201).send({ agent });
  });

  fastify.patch("/api/v1/agents/:id", policy(authorizeAgentPatch), async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    // 본문보다 먼저 404 — 옛 순서 그대로(patchAgentAndNotify 도 다시 본다)
    const current = getAgent(ctx.db, id, sessionUser(request).workspaceId);
    if (!current) throw apiError("NOT_FOUND", "agent not found");
    const patch = parseBody(UpdateAgentBody, request.body);
    if (current.provider === "runner") assertNoFixedRunnerFields(request.body);
    assertRunnerPatchWithinCeiling(ctx, id, patch, sessionUser(request).workspaceId);
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
