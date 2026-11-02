import { UpdateMyStatusBody } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../../auth";
import { requireSession, sessionUser } from "../../auth/roles";
import type { Db } from "../../db/client";
import { parseBody } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import { broadcastPeople } from "../members/people";
import { updateMyStatus } from "./status";

export type ProfileRouteContext = {
  auth: Auth;
  db: Db;
  bus: ServerBus;
  workspaceId: string;
  /** 수동 모드가 바뀐 뒤 — 접속 점을 다시 계산한다(presence 허브) */
  onModeChanged?: (userId: string) => void;
  /** 만료 판정 시계(기본 new Date) */
  now?: () => Date;
};

/** 본인의 상태(프로필 스펙 3.2·3.3) — 누구나, 자기 것만 */
export function registerProfileRoutes(fastify: FastifyInstance, ctx: ProfileRouteContext): void {
  const now = ctx.now ?? (() => new Date());

  fastify.put("/api/v1/me/status", { preHandler: requireSession(ctx) }, async (request) => {
    const body = parseBody(UpdateMyStatusBody, request.body);
    const me = sessionUser(request);
    const { status, messageChanged, modeChanged } = updateMyStatus(ctx.db, me.id, body, now());
    // 본인의 다른 탭·기기 — 수동 모드는 이 길로만 간다(사람 목록에 싣지 않는다)
    ctx.bus.emit("me.status", { userId: me.id, status });
    if (messageChanged) broadcastPeople(ctx.bus, ctx.db, ctx.workspaceId);
    if (modeChanged) ctx.onModeChanged?.(me.id);
    return { status };
  });
}
