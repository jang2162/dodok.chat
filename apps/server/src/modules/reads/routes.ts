import type { UnreadSnapshot } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../../auth";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { unreadFor } from "./store";

export type ReadRouteContext = { auth: Auth; db: Db; workspaceId: string };

/** 사용자 id 는 세션에서만 온다 — 누구나 자기 현황만 받는다(읽지 않음 스펙 「권한」 장) */
export function registerReadRoutes(fastify: FastifyInstance, ctx: ReadRouteContext): void {
  fastify.get("/api/v1/me/unread", { preHandler: [requireSession(ctx)] }, async (request) => {
    const user = sessionUser(request);
    const snapshot: UnreadSnapshot = { channels: unreadFor(ctx.db, user.workspaceId, user.id) };
    return snapshot;
  });
}
