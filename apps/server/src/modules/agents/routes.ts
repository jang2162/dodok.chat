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
  authorizeAgentMoveGateway,
  authorizeAgentPatch,
  authorizeAgentRegister,
  authorizeRead,
} from "../../auth/policies";
import { requirePolicy, requireSession } from "../../auth/roles";
import { sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams, parseQuery } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { syncPromptToGateway } from "../channels/prompt-sync";
import { agentChannelGateways, listMembers } from "../channels/service";
import {
  agentActor,
  agentConnectionOwner,
  connectionOwners,
  gatewayOwner,
  isOwner,
  ownerOfAgent,
  projectOwner,
} from "../connections/owner";
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
 * 러너 에이전트 PATCH 의 「새 세션 시작값」 권한 모드가 붙은 러너의 천장 안인가(세션 설정 스펙 5.5 — 그 러너 상한까지) — 러너가 끊겨
 * 있으면 건너뛴다(런에서 러너가 거절한다 — 러너 일반화 계획 Task 4). null(「기본」)은 늘 상한 안이다. OpenClaw 에이전트의 러너 필드는
 * 서비스(updateAgent)가 VALIDATION 으로 막는다
 */
function assertRunnerPatchWithinCeiling(
  ctx: AgentRouteContext,
  id: string,
  patch: UpdateAgentBody,
  workspaceId: string,
): void {
  const permissionMode = patch.sessionDefaults?.permissionMode;
  if (permissionMode === undefined || permissionMode === null) return;
  const placement = runnerPlacement(ctx.db, id, workspaceId);
  if (placement?.provider !== "runner" || placement.runnerTokenId === null || placement.program === null)
    return;
  const live = ctx.runners?.runnerInfo(placement.runnerTokenId) ?? null;
  if (!live) return;
  assertWithinCeiling(live, placement.program, { permissionMode }, { requireAvailable: false });
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
  // 쓰기는 그 에이전트 연결의 주인·admin 이상(연결 탭 통합 스펙 5.2) — 연결을 읽어야 해서 핸들러 안에서 정책을 부른다
  const session = { preHandler: requireSession(ctx) };
  // 다른 탭·사람의 화면이 에이전트·채널 멤버 목록을 다시 받게 — 본문이 없다(계획 판정 PS4)
  const changed = () => ctx.bus.emit("agents.changed", {});

  fastify.get("/api/v1/agents", policy(authorizeRead), async (request) => {
    const user = sessionUser(request);
    const owners = connectionOwners(ctx.db, user.workspaceId);
    return {
      agents: listAgents(ctx.db, user.workspaceId).map((agent) =>
        agentForRole(agent, user.role, isOwner(ownerOfAgent(agent, owners), user.id)),
      ),
    };
  });

  /**
   * 등록 — provider 로 갈래를 고르고 그 갈래의 스키마로 파싱한다(오류가 그 갈래의 필드를 가리키게). 그 Gateway(OpenClaw)·그 프로젝트의
   * 러너(러너 에이전트)의 주인·admin 이상
   */
  fastify.post("/api/v1/agents", session, async (request, reply) => {
    const { workspaceId, id: userId, role } = sessionUser(request);
    const runner = (request.body as { provider?: unknown } | null)?.provider === "runner";
    if (runner) {
      const body = parseBody(CreateRunnerAgentBody, request.body);
      const owner = projectOwner(ctx.db, workspaceId, body.runnerProjectId);
      authorizeAgentRegister({ role, ownsConnection: isOwner(owner, userId) });
      return reply.code(201).send({ agent: createRunnerAgentAndNotify(ctx, body, workspaceId, userId) });
    }
    const body = parseBody(CreateOpenClawAgentBody, request.body);
    const owner = body.gatewayId === undefined ? null : gatewayOwner(ctx.db, workspaceId, body.gatewayId);
    authorizeAgentRegister({ role, ownsConnection: isOwner(owner, userId) });
    return reply.code(201).send({ agent: registerAgentAndNotify(ctx, body, workspaceId, userId) });
  });

  fastify.patch("/api/v1/agents/:id", session, async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    const user = sessionUser(request);
    // 본문보다 먼저 404 — 옛 순서 그대로(patchAgentAndNotify 도 다시 본다)
    const current = getAgent(ctx.db, id, user.workspaceId);
    if (!current) throw apiError("NOT_FOUND", "agent not found");
    authorizeAgentPatch(agentActor(ctx.db, user.workspaceId, id, user));
    const patch = parseBody(UpdateAgentBody, request.body);
    if (current.provider === "runner") assertNoFixedRunnerFields(request.body);
    assertRunnerPatchWithinCeiling(ctx, id, patch, sessionUser(request).workspaceId);
    return { agent: patchAgentAndNotify(ctx, id, patch, sessionUser(request).workspaceId) };
  });

  /** 보관 — 그 에이전트 연결의 주인·admin 이상. 이미 보관했으면 200 그대로 */
  fastify.delete("/api/v1/agents/:id", session, async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    const user = sessionUser(request);
    authorizeAgentArchive(agentActor(ctx.db, user.workspaceId, id, user));
    return { agent: await archiveAgentAndNotify(ctx, id, user.workspaceId) };
  });

  /**
   * 되살리기 — 같은 채널·세션으로 이어 답한다. 살아 있으면 200 그대로. 그 에이전트 연결의 주인·admin 이상 — 연결이 지워졌으면 admin
   * 이상(스펙 5.2)
   */
  fastify.post("/api/v1/agents/:id/restore", session, async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    const user = sessionUser(request);
    authorizeAgentArchive(agentActor(ctx.db, user.workspaceId, id, user));
    const { agent, autoRespondOffChannelIds } = restoreAgent(ctx.db, id, user.workspaceId);
    changed();
    for (const channelId of autoRespondOffChannelIds)
      ctx.bus.emit("channel.member.changed", { channelId, members: listMembers(ctx.db, channelId) });
    return { agent };
  });

  /**
   * OpenClaw 에이전트를 다른 Gateway 로(멀티 Gateway 스펙 「에이전트 API」 절) — Gateway 가 지워져 연결이 빈 에이전트를 살리는 길이다.
   * admin 이상, 또는 원래 Gateway 와 옮길 Gateway 가 둘 다 자기 것인 member(연결 탭 통합 스펙 5.2 — 연결이 빈 에이전트는 admin 이상).
   * 그 Gateway 가 이 에이전트의 채널에 새로 들어오면 그 채널의 프롬프트를 한 번 보낸다(계획 판정 PG10)
   */
  fastify.put("/api/v1/agents/:id/gateway", session, async (request) => {
    const { id } = parseParams(AgentParams, request.params);
    const { gatewayId } = parseBody(MoveGatewayBody, request.body);
    const { workspaceId, id: userId, role } = sessionUser(request);
    // 원래 곳 — OpenClaw 에이전트면 그 Gateway 의 주인(연결이 비었으면 없음). 러너 에이전트는 서비스가 막는다
    const from =
      getAgent(ctx.db, id, workspaceId)?.provider === "openclaw"
        ? agentConnectionOwner(ctx.db, workspaceId, id)
        : null;
    const ownsBoth = isOwner(from, userId) && isOwner(gatewayOwner(ctx.db, workspaceId, gatewayId), userId);
    authorizeAgentMoveGateway(role, ownsBoth);
    const channelsBefore = agentChannelGateways(ctx.db, id);
    const { agent, previousGatewayId } = moveAgentGateway(ctx.db, { workspaceId, agentId: id, gatewayId });
    if (previousGatewayId !== gatewayId) {
      for (const { channelId, gatewayIds } of channelsBefore)
        if (!gatewayIds.includes(gatewayId)) syncPromptToGateway(ctx, channelId, gatewayId);
    }
    changed();
    return { agent };
  });

  /** 가져올 에이전트 목록 — 그 Gateway 의 주인·admin 이상. 검사·보관한 에이전트 표시는 discoverAgents */
  fastify.get("/api/v1/agents/discover", session, async (request) => {
    const { workspaceId, id: userId, role } = sessionUser(request);
    const query = parseQuery(DiscoverAgentsQuery, request.query);
    const owner = query.gatewayId === undefined ? null : gatewayOwner(ctx.db, workspaceId, query.gatewayId);
    authorizeAgentDiscover({ role, ownsConnection: isOwner(owner, userId) });
    return discoverAgents(ctx, query, workspaceId);
  });
}
