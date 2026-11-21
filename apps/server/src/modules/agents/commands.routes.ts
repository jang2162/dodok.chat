import { type Agent, Id } from "@dodok/shared";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdapterRegistry } from "../../adapters/registry";
import type { Auth } from "../../auth";
import { authorizeRead } from "../../auth/policies";
import { requirePolicy } from "../../auth/roles";
import { sessionUser } from "../../auth/routes";
import type { Db, DbOrTx } from "../../db/client";
import { agents } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseParams } from "../../http/validate";
import type { Logger } from "../../logger";
import { listMembers, loadReadableChannel } from "../channels/service";
import { sessionAgentIds } from "../conversations/invited-agents";
import { getReadableConversation } from "../conversations/store";
import { type AgentCommandsRunners, type AgentCommandsService, createAgentCommandsService } from "./commands";
import { isAgentActive, rowToAgent } from "./service";

export type AgentCommandsRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  logger: Logger;
  registry: AdapterRegistry;
  /** 러너 어댑터가 없으면(OpenClaw 만 붙인 테스트 앱) null — 러너 에이전트는 supported false */
  runners: AgentCommandsRunners | null;
  now?: () => number;
  /** 앱이 만든 서비스(라우터와 캐시를 같이 쓴다) — 없으면 여기서 만든다 */
  agentCommands?: AgentCommandsService;
};

const Params = z.object({ id: Id });

/** 활성 에이전트만, 받은 id 차례대로 */
function activeAgents(db: DbOrTx, ids: string[]): Agent[] {
  if (ids.length === 0) return [];
  const byId = new Map(
    db
      .select()
      .from(agents)
      .where(inArray(agents.id, ids))
      .all()
      .map((row) => [row.id, rowToAgent(row)] as const),
  );
  return ids.flatMap((id) => {
    const agent = byId.get(id);
    return agent !== undefined && isAgentActive(agent) ? [agent] : [];
  });
}

/**
 * 작성기 자동완성의 에이전트 명령 목록(에이전트 명령 스펙 5.2) — 그 대화(채널)를 읽을 수 있는 사람에게. 남의 DM·다른 워크스페이스는 404
 */
export function registerAgentCommandRoutes(fastify: FastifyInstance, ctx: AgentCommandsRouteContext): void {
  const service =
    ctx.agentCommands ??
    createAgentCommandsService({
      registry: ctx.registry,
      runners: ctx.runners,
      logger: ctx.logger,
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
    });

  /** 그 대화에서 부를 수 있는 에이전트 — 채널 멤버 + 그 대화의 초대 */
  fastify.get(
    "/api/v1/conversations/:id/agent-commands",
    { preHandler: requirePolicy(ctx, authorizeRead) },
    async (request) => {
      const { id } = parseParams(Params, request.params);
      const user = sessionUser(request);
      const conversation = getReadableConversation(ctx.db, id, user.workspaceId, user.id);
      if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
      const ids = sessionAgentIds(ctx.db, { channelId: conversation.channelId, conversationId: id });
      return service.list(ctx.db, activeAgents(ctx.db, ids));
    },
  );

  /** 새 세션 창(대화가 아직 없다) — 그 채널의 에이전트 멤버 */
  fastify.get(
    "/api/v1/channels/:id/agent-commands",
    { preHandler: requirePolicy(ctx, authorizeRead) },
    async (request) => {
      const { id } = parseParams(Params, request.params);
      const user = sessionUser(request);
      loadReadableChannel(ctx.db, id, user.workspaceId, user.id);
      const ids = listMembers(ctx.db, id)
        .filter((m) => m.memberType === "agent")
        .map((m) => m.memberId);
      return service.list(ctx.db, activeAgents(ctx.db, ids));
    },
  );
}
