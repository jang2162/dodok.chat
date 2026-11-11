import { SidebarLayout } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../../auth";
import { requireSession, sessionUser } from "../../auth/roles";
import type { Db } from "../../db/client";
import { parseBody } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import { getSidebarLayout, saveSidebarLayout } from "./store";

export type SidebarRouteContext = { auth: Auth; db: Db; bus: ServerBus; workspaceId: string };

/** 사이드바 개인 섹션(사이드바 섹션 스펙 B4) — 누구나, 자기 것만. 남의 배치를 읽는 길은 없다 */
export function registerSidebarRoutes(fastify: FastifyInstance, ctx: SidebarRouteContext): void {
  fastify.get("/api/v1/me/sidebar", { preHandler: requireSession(ctx) }, async (request) =>
    getSidebarLayout(ctx.db, sessionUser(request).id),
  );

  fastify.put("/api/v1/me/sidebar", { preHandler: requireSession(ctx) }, async (request) => {
    const body = parseBody(SidebarLayout, request.body);
    const me = sessionUser(request);
    const layout = saveSidebarLayout(ctx.db, me.id, body);
    // 본인의 다른 탭·기기(보낸 탭도 받는다 — 걷은 배치로 맞춘다)
    ctx.bus.emit("me.sidebar", { userId: me.id, layout });
    return layout;
  });
}
