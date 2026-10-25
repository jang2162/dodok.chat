import { Id } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { authorizeRead } from "../../auth/policies";
import { requirePolicy } from "../../auth/roles";
import { sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseParams, parseQuery } from "../../http/validate";
import { getChannel } from "../channels/service";
import { getConversation } from "../conversations/store";
import { getThreadRoot, hydrateForClient, listMessages, MESSAGE_PAGE_MAX } from "./service";

export type MessageRouteContext = { auth: Auth; db: Db; workspaceId: string };

const ChannelParams = z.object({ id: Id });
const ThreadParams = z.object({ id: Id, rootId: Id });
export const HistoryQuery = z
  .object({
    beforeSeq: z.coerce.number().int().min(1).optional(),
    afterSeq: z.coerce.number().int().min(0).optional(),
    around: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(MESSAGE_PAGE_MAX).default(50),
  })
  .refine((q) => q.around === undefined || (q.beforeSeq === undefined && q.afterSeq === undefined), {
    message: "around 는 beforeSeq·afterSeq 와 함께 쓸 수 없다",
  });

/** 메시지 전송은 wire(message.send) 로만 — REST 는 히스토리 페이징 */
export function registerMessageRoutes(fastify: FastifyInstance, ctx: MessageRouteContext): void {
  /** 채널 타임라인 — 루트만. around 가 답글 seq 면 그 루트를 가운데로 */
  fastify.get(
    "/api/v1/channels/:id/messages",
    { preHandler: requirePolicy(ctx, authorizeRead) },
    async (request) => {
      const { id } = parseParams(ChannelParams, request.params);
      const { around, ...query } = parseQuery(HistoryQuery, request.query);
      if (!getChannel(ctx.db, id, sessionUser(request).workspaceId))
        throw apiError("NOT_FOUND", "channel not found");
      return listMessages(ctx.db, id, { ...query, aroundSeq: around });
    },
  );

  /** 스레드 — 루트와 답글, 오래된 순. root 는 페이지가 거기까지 닿지 않아도 늘 싣는다 */
  fastify.get(
    "/api/v1/channels/:id/threads/:rootId/messages",
    { preHandler: requirePolicy(ctx, authorizeRead) },
    async (request) => {
      const { id, rootId } = parseParams(ThreadParams, request.params);
      const { around, ...query } = parseQuery(HistoryQuery, request.query);
      if (!getChannel(ctx.db, id, sessionUser(request).workspaceId))
        throw apiError("NOT_FOUND", "channel not found");
      const root = getThreadRoot(ctx.db, id, rootId);
      if (!root) throw apiError("NOT_FOUND", "thread not found");
      const page = listMessages(ctx.db, id, { ...query, aroundSeq: around, scope: { threadRootId: rootId } });
      return { root: hydrateForClient(ctx.db, [root])[0], ...page };
    },
  );

  /** 세션 타임라인 — 그 대화의 루트만(채널 세션 스펙 「wire·REST」 장). 쿼리는 채널 경로와 같다(seq 는 채널 번호) */
  fastify.get(
    "/api/v1/conversations/:id/messages",
    { preHandler: requirePolicy(ctx, authorizeRead) },
    async (request) => {
      const { id } = parseParams(ChannelParams, request.params);
      const { around, ...query } = parseQuery(HistoryQuery, request.query);
      const conversation = getConversation(ctx.db, id, sessionUser(request).workspaceId);
      if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
      return listMessages(ctx.db, conversation.channelId, {
        ...query,
        aroundSeq: around,
        conversationId: conversation.id,
      });
    },
  );

  /** 세션 안의 스레드 — 루트가 그 대화의 것이어야 한다(아니면 404) */
  fastify.get(
    "/api/v1/conversations/:id/threads/:rootId/messages",
    { preHandler: requirePolicy(ctx, authorizeRead) },
    async (request) => {
      const { id, rootId } = parseParams(ThreadParams, request.params);
      const { around, ...query } = parseQuery(HistoryQuery, request.query);
      const conversation = getConversation(ctx.db, id, sessionUser(request).workspaceId);
      if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
      const root = getThreadRoot(ctx.db, conversation.channelId, rootId);
      if (!root || root.conversationId !== conversation.id) throw apiError("NOT_FOUND", "thread not found");
      const page = listMessages(ctx.db, conversation.channelId, {
        ...query,
        aroundSeq: around,
        scope: { threadRootId: rootId },
        conversationId: conversation.id,
      });
      return { root: hydrateForClient(ctx.db, [root])[0], ...page };
    },
  );
}
