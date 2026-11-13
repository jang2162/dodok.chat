import { Id, InviteAgentBody, type InvitedAgent, MAX_INVITED_AGENTS } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Auth } from "../../auth";
import { authorizeChannelMemberAdd, authorizeChannelMemberRemove, authorizeRead } from "../../auth/policies";
import { requirePolicy } from "../../auth/roles";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseBody, parseParams } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import { josa } from "../../util/josa";
import { getAgent } from "../agents/service";
import type { AdapterRegistry } from "../../adapters/registry";
import type { Logger } from "../../logger";
import { syncPromptToGateway } from "../channels/prompt-sync";
import { channelGatewayIds, getChannel, listMembers } from "../channels/service";
import { createSystemMessage } from "../messages/service";
import type { Orchestrator } from "../runs/orchestrator";
import { deleteInvite, insertInvite, listInvited } from "./invited-agents";
import { assertConversationWritable, getReadableConversation } from "./store";

export type InvitedAgentsRouteContext = {
  auth: Auth;
  db: Db;
  bus: ServerBus;
  logger: Logger;
  workspaceId: string;
  /** 초대로 새 Gateway 가 그 채널에 들어오면 채널 프롬프트를 한 번(I5) — OpenClaw 어댑터로 */
  registry: Pick<AdapterRegistry, "forProvider">;
  /** 내보내기가 그 대화에서 그 에이전트의 열린 런을 멈출 때 */
  orchestrator: Pick<Orchestrator, "abortConversationAgent">;
};

const ConversationParams = z.object({ id: Id });
const AgentParams = z.object({ id: Id, agentId: Id });

/**
 * 세션에 에이전트 초대(세션 에이전트 초대 스펙 5.3) — 읽기는 그 대화를 읽을 수 있는 사람, 초대·내보내기는 그 채널에 에이전트를 넣고 빼는
 * 판정(I3)과 같다. 일반 채널의 세션만(I2 — DM·그룹 DM 이면 400), 닫힌 세션·보관한 채널은 둘 다 거절. 남의 DM·다른 워크스페이스는 404
 */
export function registerInvitedAgentRoutes(fastify: FastifyInstance, ctx: InvitedAgentsRouteContext): void {
  fastify.get(
    "/api/v1/conversations/:id/agents",
    { preHandler: requirePolicy(ctx, authorizeRead) },
    async (request) => {
      const { id } = parseParams(ConversationParams, request.params);
      const user = sessionUser(request);
      const conversation = getReadableConversation(ctx.db, id, user.workspaceId, user.id);
      if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
      return { invited: listInvited(ctx.db, id) };
    },
  );

  /** 초대 — 그 세션에 시스템 메시지 하나(I7)와 채널 룸에 conversation.agents */
  fastify.post("/api/v1/conversations/:id/agents", { preHandler: requireSession(ctx) }, async (request) => {
    const { id } = parseParams(ConversationParams, request.params);
    const user = sessionUser(request);
    const session = loadInvitable(ctx, id, user);
    const { agentId } = parseBody(InviteAgentBody, request.body);
    authorizeChannelMemberAdd(user.role, { memberType: "agent" });
    assertConversationWritable(ctx.db, id, user.workspaceId);
    const gatewaysBefore = channelGatewayIds(ctx.db, session.channelId);
    const handle = ctx.db.transaction((tx) => {
      const agent = getAgent(tx, agentId, user.workspaceId);
      if (!agent) throw apiError("VALIDATION", "agent not found", { field: "agentId" });
      if (agent.archivedAt !== null)
        throw apiError("VALIDATION", "삭제된 에이전트입니다", { field: "agentId", agentId });
      const inChannel = listMembers(tx, session.channelId).some(
        (m) => m.memberType === "agent" && m.memberId === agentId,
      );
      if (inChannel) throw apiError("VALIDATION", "이미 이 채널의 에이전트다", { field: "agentId", agentId });
      const invited = listInvited(tx, id);
      if (invited.some((row) => row.agentId === agentId))
        throw apiError("CONFLICT", "이미 이 세션에 초대한 에이전트다", { agentId });
      if (invited.length >= MAX_INVITED_AGENTS)
        throw apiError("VALIDATION", `한 세션에 초대는 ${MAX_INVITED_AGENTS}까지다`, { field: "agentId" });
      insertInvite(tx, { conversationId: id, agentId, invitedBy: user.id });
      return agent.handle;
    });
    announce(ctx, { conversationId: id, byUserId: user.id, agentHandle: handle, verb: "초대했습니다" });
    // 다른 Gateway 의 에이전트가 처음 들어오면 그 Gateway 에 채널 프롬프트를 한 번 — 채널 멤버 추가와 같은 꼴(channels/actions.ts)
    for (const gatewayId of channelGatewayIds(ctx.db, session.channelId))
      if (!gatewaysBefore.includes(gatewayId)) syncPromptToGateway(ctx, session.channelId, gatewayId);
    return { invited: emitInvited(ctx, session) };
  });

  /**
   * 내보내기 — 그 대화(스레드 포함)에서 그 에이전트의 열린 런을 사람 「중지」와 같은 길로 멈추고(걸린 승인은 cancelled), 시스템 메시지
   * 하나와 conversation.agents. 초대하지 않은 에이전트면 404
   */
  fastify.delete(
    "/api/v1/conversations/:id/agents/:agentId",
    { preHandler: requireSession(ctx) },
    async (request) => {
      const { id, agentId } = parseParams(AgentParams, request.params);
      const user = sessionUser(request);
      const session = loadInvitable(ctx, id, user);
      authorizeChannelMemberRemove(user.role);
      assertConversationWritable(ctx.db, id, user.workspaceId);
      if (!deleteInvite(ctx.db, { conversationId: id, agentId }))
        throw apiError("NOT_FOUND", "agent is not invited to this conversation");
      // 행을 먼저 지운다 — 멈추는 사이 도착한 정본·릴레이 멘션은 이미 「세션 밖」으로 읽힌다
      await ctx.orchestrator.abortConversationAgent(id, agentId);
      const handle = getAgent(ctx.db, agentId)?.handle ?? "알 수 없음";
      announce(ctx, { conversationId: id, byUserId: user.id, agentHandle: handle, verb: "내보냈습니다" });
      return { invited: emitInvited(ctx, session) };
    },
  );
}

/** 읽을 수 있는 그 대화와 채널 — 없거나 못 읽으면 404, 일반 채널이 아니면 400(I2) */
function loadInvitable(
  ctx: InvitedAgentsRouteContext,
  conversationId: string,
  user: { id: string; workspaceId: string },
): { channelId: string; conversationId: string } {
  const conversation = getReadableConversation(ctx.db, conversationId, user.workspaceId, user.id);
  if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
  if (getChannel(ctx.db, conversation.channelId)?.kind !== "channel")
    throw apiError("VALIDATION", "일반 채널의 세션에만 에이전트를 초대할 수 있다");
  return { channelId: conversation.channelId, conversationId };
}

/** 「@<사람> 이(가) @<에이전트> 를 이 세션에 초대했습니다」·「…내보냈습니다」(I7) — 세션 닫기 알림과 같은 info 시스템 메시지 */
function announce(
  ctx: InvitedAgentsRouteContext,
  input: { conversationId: string; byUserId: string; agentHandle: string; verb: string },
): void {
  const who =
    ctx.db.select({ handle: users.handle }).from(users).where(eq(users.id, input.byUserId)).get()?.handle ??
    "알 수 없음";
  const agent = input.agentHandle;
  createSystemMessage(ctx.db, ctx.bus, {
    conversationId: input.conversationId,
    kind: "info",
    bodyMd: `@${who} ${josa(who, "이", "가")} @${agent} ${josa(agent, "을", "를")} 이 세션에 ${input.verb}`,
  });
}

/** 그 대화의 초대 전체를 채널 룸에 알리고 돌려준다 */
export function emitInvited(
  ctx: { db: Db; bus: ServerBus },
  session: { channelId: string; conversationId: string },
): InvitedAgent[] {
  const invited = listInvited(ctx.db, session.conversationId);
  ctx.bus.emit("conversation.agents", { ...session, invited });
  return invited;
}
