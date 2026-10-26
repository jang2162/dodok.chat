import { ConversationPatch, Id, ListConversationsQuery } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { authorizeConversationManage, authorizeRead } from "../../auth/policies";
import { requirePolicy } from "../../auth/roles";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams, parseQuery } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import { loadReadableChannel } from "../channels/service";
import type { Orchestrator } from "../runs/orchestrator";
import { conversationActor, listConversations, renameConversation, setConversationClosed } from "./service";
import { getReadableConversation } from "./store";

export type ConversationRouteContext = {
  auth: Auth;
  db: Db;
  bus: ServerBus;
  workspaceId: string;
  /** 닫기가 그 대화의 열린 런을 멈출 때 */
  orchestrator: Pick<Orchestrator, "abortConversation">;
};

const ChannelParams = z.object({ id: Id });
const ConversationParams = z.object({ id: Id });

/** 세션 목록·하나·제목·닫기(채널 세션 스펙 「wire·REST」 장). 만들기 REST 는 없다 — 첫 message.send 가 만든다(결정 7). 메시지 목록은 messages/routes.ts */
export function registerConversationRoutes(fastify: FastifyInstance, ctx: ConversationRouteContext): void {
  fastify.get(
    "/api/v1/channels/:id/conversations",
    { preHandler: requirePolicy(ctx, authorizeRead) },
    async (request) => {
      const { id } = parseParams(ChannelParams, request.params);
      const query = parseQuery(ListConversationsQuery, request.query);
      const user = sessionUser(request);
      loadReadableChannel(ctx.db, id, user.workspaceId, user.id);
      return listConversations(ctx.db, id, query);
    },
  );

  /** 세션 하나 — 웹의 세션 머리(제목·닫힘)와 주소의 채널 대조가 읽는다. 다른 워크스페이스·남의 DM 의 세션은 404 */
  fastify.get(
    "/api/v1/conversations/:id",
    { preHandler: requirePolicy(ctx, authorizeRead) },
    async (request) => {
      const { id } = parseParams(ConversationParams, request.params);
      const user = sessionUser(request);
      const conversation = getReadableConversation(ctx.db, id, user.workspaceId, user.id);
      if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
      return { conversation };
    },
  );

  /** 제목 바꾸기·닫기·다시 열기 — 만든 사람·세션 관리자·admin 이상(authorizeConversationManage). 둘 다 오면 제목부터 */
  fastify.patch("/api/v1/conversations/:id", { preHandler: requireSession(ctx) }, async (request) => {
    const user = sessionUser(request);
    const { id } = parseParams(ConversationParams, request.params);
    const patch = parseBody(ConversationPatch, request.body);
    // 남의 DM 의 세션은 역할 판정(403)보다 먼저 404 — auth/channel-access.ts
    const current = getReadableConversation(ctx.db, id, user.workspaceId, user.id);
    if (!current) throw apiError("NOT_FOUND", "conversation not found");
    authorizeConversationManage(user.role, conversationActor(ctx.db, current, user.id));
    let conversation = current;
    if (patch.title !== undefined) conversation = renameConversation(ctx.db, ctx.bus, id, patch.title);
    if (patch.closed !== undefined) {
      conversation = await setConversationClosed(
        { db: ctx.db, bus: ctx.bus, runs: ctx.orchestrator },
        { conversationId: id, byUserId: user.id, closed: patch.closed },
      );
    }
    return { conversation };
  });
}
