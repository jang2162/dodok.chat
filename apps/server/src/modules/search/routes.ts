import { SearchQuery } from "@dodok/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Auth } from "../../auth";
import { authorizeRead } from "../../auth/policies";
import { requirePolicy } from "../../auth/roles";
import { sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseQuery } from "../../http/validate";
import { recordRateLimit } from "../ops/http-limits";
import type { Limits } from "../ops/limits";
import { KeyedLimiter } from "../ops/ratelimit";
import type { OpsService } from "../ops/service";
import { searchMessages } from "./service";

export type SearchRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  limits: Pick<Limits, "searchPerMin">;
  ops: Pick<OpsService, "record">;
  /** 레이트리밋 시계 — app.ts 의 limitClock(테스트가 주입) */
  now: () => number;
};

/** 검색은 REST 상한(requireSession — requirePolicy 가 먼저 부른다) 위에 사용자당 분당 상한이 한 번 더 걸린다 — FTS·LIKE 훑기가 일반 REST 보다 무겁다 */
export function registerSearchRoutes(fastify: FastifyInstance, ctx: SearchRouteContext): void {
  const limiter = new KeyedLimiter({ perMin: ctx.limits.searchPerMin, now: ctx.now });
  const searchLimit = async (request: FastifyRequest): Promise<void> => {
    if (limiter.take(sessionUser(request).id)) return;
    recordRateLimit(ctx.ops, request);
    throw apiError("RATE_LIMITED", "검색 요청이 너무 많습니다");
  };
  fastify.get(
    "/api/v1/search",
    { preHandler: [requirePolicy(ctx, authorizeRead), searchLimit] },
    async (request) => {
      const query = parseQuery(SearchQuery, request.query);
      const user = sessionUser(request);
      return searchMessages(ctx.db, user.workspaceId, user.id, query, new Date());
    },
  );
}
