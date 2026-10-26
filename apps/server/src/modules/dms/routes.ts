import { CreateDmBody, type DmList } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../../auth";
import { authorizeRead } from "../../auth/policies";
import { requirePolicy } from "../../auth/roles";
import { sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { parseBody } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import { listDms, openDm } from "./service";

export type DmRouteContext = { auth: Auth; db: Db; bus: ServerBus; workspaceId: string };

/** 사람은 자기 DM 만 — 주인은 세션에서만 온다(에이전트 DM 계획 판정 PD1·PD3). 누가 여나는 에이전트 dmAccess 가 정한다 */
export function registerDmRoutes(fastify: FastifyInstance, ctx: DmRouteContext): void {
  const read = { preHandler: requirePolicy(ctx, authorizeRead) };

  fastify.get("/api/v1/dms", read, async (request): Promise<DmList> => {
    const user = sessionUser(request);
    return { dms: listDms(ctx.db, user.workspaceId, user.id, user.role) };
  });

  /** 찾거나 만든다 — 처음 만들면 channel.created(DM 이라 주인 user 룸으로만 간다 — realtime/events.ts channelAudience) */
  fastify.post("/api/v1/dms", read, async (request) => {
    const user = sessionUser(request);
    const { agentId } = parseBody(CreateDmBody, request.body);
    const { channel, created } = openDm(ctx.db, {
      workspaceId: user.workspaceId,
      userId: user.id,
      role: user.role,
      agentId,
    });
    if (created) ctx.bus.emit("channel.created", { channel });
    return { channel };
  });
}
