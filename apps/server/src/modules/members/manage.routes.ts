import { Id, UpdateMemberRoleBody } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { authorizeRead } from "../../auth/policies";
import { requirePolicy, requireRole, sessionUser } from "../../auth/roles";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import type { OpsService } from "../ops/service";
import { broadcastPeople, listPeople } from "./people";
import { changeRole, deactivateMember, listMembers, reactivateMember } from "./service";

export type MemberManageRouteContext = {
  auth: Auth;
  db: Db;
  bus: ServerBus;
  workspaceId: string;
  ops: Pick<OpsService, "record">;
  logger: Logger;
  /** 비활성화한 사람의 열린 wire 소켓을 끊는다 — app.ts 가 realtime/socket.ts disconnectUser 를 묶어 준다 */
  disconnectUser(userId: string): void;
};

const MemberParams = z.object({ userId: Id });

/** 멤버 관리(팀 스펙 「멤버 관리」 절)와 사람 목록. 초대·재설정·내 계정 경로는 members/routes.ts */
export function registerMemberManageRoutes(fastify: FastifyInstance, ctx: MemberManageRouteContext): void {
  const admin = { preHandler: requireRole(ctx, "admin") };
  const owner = { preHandler: requireRole(ctx, "owner") };

  fastify.get("/api/v1/people", { preHandler: requirePolicy(ctx, authorizeRead) }, async (request) => ({
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

  /**
   * 비활성화·다시 활성화 — admin 이상이 부른다. admin 은 member 만, owner 는 owner 를 뺀 모두(service.ts assertCanManage).
   * 이미 그 상태여도 200 이고 그때도 people.changed 를 낸다(목록 전체라 같은 값이 다시 갈 뿐이다)
   */
  for (const [path, change] of [
    ["deactivate", deactivateMember],
    ["reactivate", reactivateMember],
  ] as const) {
    fastify.post(`/api/v1/members/:userId/${path}`, admin, async (request) => {
      const { userId } = parseParams(MemberParams, request.params);
      const actor = sessionUser(request);
      await change({ ...ctx, workspaceId: actor.workspaceId }, actor.id, userId);
      broadcastPeople(ctx.bus, ctx.db, actor.workspaceId);
      const member = listMembers(ctx.db, actor.workspaceId).find((m) => m.id === userId);
      if (!member) throw apiError("NOT_FOUND", "member not found");
      return { member };
    });
  }
}
