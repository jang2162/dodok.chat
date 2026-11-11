import { type AgentCeiling, AgentSettingsPatch, Id } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { authorizeRead } from "../../auth/policies";
import { requirePolicy } from "../../auth/roles";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams, parseQuery } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import { loadReadableChannel } from "../channels/service";
import type { RunnerLiveApi } from "../runners/live";
import {
  assertSettingsWritable,
  runnerPermissionCeiling,
  settingsAgentsOf,
  toConversationAgentSettings,
  upsertSettings,
} from "./agent-settings";
import { getReadableConversation } from "./store";

export type AgentSettingsRouteContext = {
  auth: Auth;
  db: Db;
  bus: ServerBus;
  workspaceId: string;
  /** 권한 상한 대조 — 러너 어댑터가 없으면 null(대조를 건너뛴다) */
  runners: Pick<RunnerLiveApi, "runnerInfo"> | null;
};

const ConversationParams = z.object({ id: Id });
const AgentParams = z.object({ id: Id, agentId: Id });
const SettingsQuery = z.object({ threadRootId: Id.optional() });

const notFound = () => apiError("NOT_FOUND", "agent not found in this conversation");

/**
 * 러너 에이전트의 세션 설정(세션 설정 스펙 5.2) — 읽기는 그 대화를 읽을 수 있는 사람, 바꾸기는 authorizeSessionSettings(S2). 남의 DM 의
 * 대화·다른 워크스페이스는 404, 상태 줄에 오르지 않는 에이전트(OpenClaw·채널 밖)도 404
 */
export function registerAgentSettingsRoutes(fastify: FastifyInstance, ctx: AgentSettingsRouteContext): void {
  /** threadRootId 를 주면 컨텍스트 % 만 그 스레드 세션의 것이다(S9) — 값은 대화의 것 */
  fastify.get(
    "/api/v1/conversations/:id/agent-settings",
    { preHandler: requirePolicy(ctx, authorizeRead) },
    async (request) => {
      const { id } = parseParams(ConversationParams, request.params);
      const { threadRootId } = parseQuery(SettingsQuery, request.query);
      const user = sessionUser(request);
      const conversation = getReadableConversation(ctx.db, id, user.workspaceId, user.id);
      if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
      return {
        settings: settingsAgentsOf(ctx.db, conversation.channelId).map((agent) =>
          toConversationAgentSettings(
            ctx.db,
            {
              conversationId: id,
              agentId: agent.id,
              ...(threadRootId === undefined ? {} : { threadRootId }),
            },
            ctx.runners,
          ),
        ),
      };
    },
  );

  /**
   * 새 세션 창(대화가 아직 없다)의 권한 상한 — 상태 줄에 오르는 에이전트마다, 그 채널을 읽을 수 있는 누구에게나. 남의 DM 은 404
   */
  fastify.get(
    "/api/v1/channels/:id/agent-ceilings",
    { preHandler: requirePolicy(ctx, authorizeRead) },
    async (request) => {
      const { id } = parseParams(ConversationParams, request.params);
      const user = sessionUser(request);
      loadReadableChannel(ctx.db, id, user.workspaceId, user.id);
      const ceilings: AgentCeiling[] = settingsAgentsOf(ctx.db, id).map((agent) => ({
        agentId: agent.id,
        ceiling: runnerPermissionCeiling(ctx.runners, agent),
      }));
      return { ceilings };
    },
  );

  /** 보낸 필드만 바꾼다. 다음 실행부터(S6). 성공하면 그 채널 룸에 conversation.agent_settings */
  fastify.patch(
    "/api/v1/conversations/:id/agent-settings/:agentId",
    { preHandler: requireSession(ctx) },
    async (request) => {
      const { id, agentId } = parseParams(AgentParams, request.params);
      const user = sessionUser(request);
      const conversation = getReadableConversation(ctx.db, id, user.workspaceId, user.id);
      if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
      const patch = parseBody(AgentSettingsPatch, request.body);
      const saved = ctx.db.transaction((tx) => {
        assertSettingsWritable(
          tx,
          {
            workspaceId: user.workspaceId,
            channelId: conversation.channelId,
            agentId,
            user,
            permissionMode: patch.permissionMode,
            runners: ctx.runners,
          },
          notFound,
        );
        upsertSettings(tx, { conversationId: id, agentId, patch, userId: user.id });
        return toConversationAgentSettings(tx, { conversationId: id, agentId }, ctx.runners);
      });
      ctx.bus.emit("conversation.agent_settings", {
        channelId: conversation.channelId,
        conversationId: id,
        settings: saved,
      });
      return saved;
    },
  );
}
