import { Id } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { authorizeRead } from "../../auth/policies";
import { requirePolicy } from "../../auth/roles";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseParams, parseQuery } from "../../http/validate";
import { getChannel } from "../channels/service";
import { getRunInWorkspace, listChannelRuns, listRunEvents } from "./store";

export type RunRouteContext = { auth: Auth; db: Db; workspaceId: string };

/** REST 런 목록 한 페이지 상한 */
export const RUN_PAGE_MAX = 200;

const IdParams = z.object({ id: Id });
const RunListQuery = z.object({ limit: z.coerce.number().int().min(1).max(RUN_PAGE_MAX).default(50) });
const RunEventsQuery = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });

/** 활동 패널용 런 조회(스펙 4장). 실시간 갱신은 wire run.state·run.event */
export function registerRunRoutes(fastify: FastifyInstance, ctx: RunRouteContext): void {
  const auth = { preHandler: requireSession(ctx) };

  const visibleRun = (runId: string, workspaceId: string) => {
    const run = getRunInWorkspace(ctx.db, runId, workspaceId);
    if (!run) throw apiError("NOT_FOUND", "run not found");
    return run;
  };

  fastify.get("/api/v1/channels/:id/runs", auth, async (request) => {
    const { id } = parseParams(IdParams, request.params);
    const { limit } = parseQuery(RunListQuery, request.query);
    if (!getChannel(ctx.db, id, sessionUser(request).workspaceId))
      throw apiError("NOT_FOUND", "channel not found");
    return { runs: listChannelRuns(ctx.db, id, limit) };
  });

  fastify.get("/api/v1/runs/:id", { preHandler: requirePolicy(ctx, authorizeRead) }, async (request) => {
    const { id } = parseParams(IdParams, request.params);
    return { run: visibleRun(id, sessionUser(request).workspaceId) };
  });

  fastify.get("/api/v1/runs/:id/events", auth, async (request) => {
    const { id } = parseParams(IdParams, request.params);
    const { afterSeq } = parseQuery(RunEventsQuery, request.query);
    const run = visibleRun(id, sessionUser(request).workspaceId);
    return { events: listRunEvents(ctx.db, id, afterSeq), run };
  });
}
