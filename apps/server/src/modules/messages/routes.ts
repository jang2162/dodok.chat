import { Id } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseParams, parseQuery } from "../../http/validate";
import { getChannel } from "../channels/service";
import { listMessages, MESSAGE_PAGE_MAX } from "./service";

export type MessageRouteContext = { auth: Auth; db: Db; workspaceId: string };

const ChannelParams = z.object({ id: Id });
const HistoryQuery = z.object({
  beforeSeq: z.coerce.number().int().min(1).optional(),
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(MESSAGE_PAGE_MAX).default(50),
});

/** 메시지 전송은 wire(message.send) 로만 — REST 는 히스토리 페이징 */
export function registerMessageRoutes(fastify: FastifyInstance, ctx: MessageRouteContext): void {
  fastify.get("/api/v1/channels/:id/messages", { preHandler: requireSession(ctx) }, async (request) => {
    const { id } = parseParams(ChannelParams, request.params);
    const query = parseQuery(HistoryQuery, request.query);
    if (!getChannel(ctx.db, id, sessionUser(request).workspaceId))
      throw apiError("NOT_FOUND", "channel not found");
    return listMessages(ctx.db, id, query);
  });
}
