import { CreateDirectBody, type DirectList, type OpenDirectResult } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../../auth";
import { authorizeRead } from "../../auth/policies";
import { requirePolicy } from "../../auth/roles";
import { sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { parseBody } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import { listDirects, openDirect } from "./service";

export type DirectRouteContext = { auth: Auth; db: Db; bus: ServerBus; workspaceId: string };

/** 사람 DM·그룹 DM — 활성 멤버 누구나 연다(역할 무관, 사람 간 DM 스펙 결정 5). 에이전트를 넣을 때는 참여자 전원의 dmAccess 를 서비스가 본다 */
export function registerDirectRoutes(fastify: FastifyInstance, ctx: DirectRouteContext): void {
  const read = { preHandler: requirePolicy(ctx, authorizeRead) };

  fastify.get("/api/v1/directs", read, async (request): Promise<DirectList> => {
    const user = sessionUser(request);
    return { directs: listDirects(ctx.db, user.workspaceId, user.id, user.role) };
  });

  /** 찾거나 만든다 — 처음 만들면 channel.created(direct 라 사람 참여자의 user 룸으로만 간다 — realtime/events.ts channelAudience) */
  fastify.post("/api/v1/directs", read, async (request): Promise<OpenDirectResult> => {
    const user = sessionUser(request);
    const { userIds, agentIds } = parseBody(CreateDirectBody, request.body);
    const result = openDirect(ctx.db, { workspaceId: user.workspaceId, userId: user.id, userIds, agentIds });
    if (result.created) ctx.bus.emit("channel.created", { channel: result.channel });
    return result;
  });
}
