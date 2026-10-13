import { Id, PersonalTokenCreate } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { parseBody, parseParams } from "../../http/validate";
import { issuePersonalToken, listPersonalTokens, revokePersonalToken } from "./service";

export type TokenRouteContext = { auth: Auth; db: Db; workspaceId: string; now?: () => Date };

const TokenParams = z.object({ id: Id });

/** 개인 토큰(제어 MCP 스펙 「권한」 장) — 누구나, 자기 것만. 사람은 세션에서만 온다 */
export function registerTokenRoutes(fastify: FastifyInstance, ctx: TokenRouteContext): void {
  const authed = { preHandler: requireSession(ctx) };
  const now = ctx.now ?? (() => new Date());

  fastify.get("/api/v1/me/tokens", authed, async (request) => ({
    tokens: listPersonalTokens(ctx.db, sessionUser(request).id),
  }));

  // 원문은 이 응답에만 실린다 — 요청 로그(app.ts requestLogSerializer)는 응답 본문을 싣지 않는다
  fastify.post("/api/v1/me/tokens", authed, async (request, reply) => {
    const { label } = parseBody(PersonalTokenCreate, request.body);
    return reply.code(201).send(issuePersonalToken(ctx.db, sessionUser(request).id, label, now()));
  });

  fastify.delete("/api/v1/me/tokens/:id", authed, async (request, reply) => {
    const { id } = parseParams(TokenParams, request.params);
    revokePersonalToken(ctx.db, sessionUser(request).id, id, now());
    return reply.code(204).send();
  });
}
