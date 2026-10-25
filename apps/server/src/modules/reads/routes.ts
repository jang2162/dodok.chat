import type { UnreadSnapshot } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../../auth";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { listedChannelIds, unreadFor } from "./store";

export type ReadRouteContext = { auth: Auth; db: Db; workspaceId: string };

/** 사용자 id 는 세션에서만 온다 — 누구나 자기 현황만 받는다(읽지 않음 스펙 「권한」 장) */
export function registerReadRoutes(fastify: FastifyInstance, ctx: ReadRouteContext): void {
  fastify.get("/api/v1/me/unread", { preHandler: [requireSession(ctx)] }, async (request) => {
    const user = sessionUser(request);
    // 한 트랜잭션에서 읽는다 — 사이에 보관이 끼면 대화 목록과 채널 목록이 서로 다른 때의 것이 된다
    return ctx.db.transaction((tx): UnreadSnapshot => ({
      conversations: unreadFor(tx, user.workspaceId, user.id),
      channels: listedChannelIds(tx, user.workspaceId),
    }));
  });
}
