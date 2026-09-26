import { Id, UpdateMemberRoleBody } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { requireRole, requireSession, sessionUser } from "../../auth/roles";
import type { Db } from "../../db/client";
import { parseBody, parseParams } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import { broadcastPeople, listPeople } from "./people";
import { changeRole, listMembers, removeMember } from "./service";

export type MemberManageRouteContext = {
  auth: Auth;
  db: Db;
  bus: ServerBus;
  workspaceId: string;
  /** 내보낸 사람의 열린 wire 소켓을 끊는다 — app.ts 가 realtime/socket.ts disconnectUser 를 묶어 준다 */
  disconnectUser(userId: string): void;
};

const MemberParams = z.object({ userId: Id });

/** 멤버 관리(팀 스펙 「멤버 관리」 절)와 사람 목록. 초대·재설정·내 계정 경로는 members/routes.ts */
export function registerMemberManageRoutes(fastify: FastifyInstance, ctx: MemberManageRouteContext): void {
  const authed = { preHandler: requireSession(ctx) };
  const admin = { preHandler: requireRole(ctx, "admin") };
  const owner = { preHandler: requireRole(ctx, "owner") };

  fastify.get("/api/v1/people", authed, async (request) => ({
    people: listPeople(ctx.db, sessionUser(request).workspaceId),
  }));

  fastify.get("/api/v1/members", admin, async (request) => ({
    members: listMembers(ctx.db, sessionUser(request).workspaceId),
  }));

  fastify.patch("/api/v1/members/:userId", owner, async (request) => {
    const { userId } = parseParams(MemberParams, request.params);
    const { role } = parseBody(UpdateMemberRoleBody, request.body);
    const actor = sessionUser(request);
    const member = changeRole(ctx.db, actor.workspaceId, actor.id, userId, role);
    broadcastPeople(ctx.bus, ctx.db, actor.workspaceId);
    return { member };
  });

  /** admin 이상이 부른다 — admin 은 member 만, owner 는 owner 를 뺀 모두(removeMember) */
  fastify.delete("/api/v1/members/:userId", admin, async (request, reply) => {
    const { userId } = parseParams(MemberParams, request.params);
    const actor = sessionUser(request);
    await removeMember({ ...ctx, workspaceId: actor.workspaceId }, actor.id, userId);
    broadcastPeople(ctx.bus, ctx.db, actor.workspaceId);
    return reply.code(204).send();
  });
}
