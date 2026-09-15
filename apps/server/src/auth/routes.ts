import type { User } from "@dodok/shared";
import { isAPIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client";
import { users } from "../db/schema.sqlite";
import { apiError } from "../http/errors";
import type { Logger } from "../logger";
import { type Auth, OWNER_EMAIL, SESSION_COOKIE, SESSION_MAX_AGE_S, verifySessionToken } from "./index";

declare module "fastify" {
  interface FastifyRequest {
    /** requireSession 이 채운다 */
    user?: { id: string; workspaceId: string };
  }
}

export type AuthRouteContext = {
  auth: Auth;
  db: Db;
  logger: Logger;
  workspaceId: string;
  /** APP_ORIGIN 이 https 일 때 true — 세션 쿠키에 Secure */
  secureCookie: boolean;
};

const LocalLoginBody = z.object({ token: z.string().min(1).max(256) });

export function registerAuthRoutes(fastify: FastifyInstance, ctx: AuthRouteContext): void {
  // Better Auth 자체 엔드포인트. 가입·이메일 사인인은 createAuth 에서 막혀 있다.
  fastify.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const headers = fromNodeHeaders(request.headers);
      headers.delete("content-length"); // 파싱된 본문을 다시 직렬화하므로 원래 길이와 다를 수 있다
      const hasBody = request.method !== "GET" && request.body !== undefined;
      const res = await ctx.auth.handler(
        new Request(new URL(request.url, ctx.auth.options.baseURL), {
          method: request.method,
          headers,
          ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
        }),
      );
      reply.status(res.status);
      for (const [key, value] of res.headers) {
        if (key !== "set-cookie") reply.header(key, value);
      }
      const cookies = res.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);
      return reply.send(await res.text());
    },
  });

  fastify.post(
    "/api/v1/auth/local",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = LocalLoginBody.safeParse(request.body);
      if (!body.success) throw apiError("VALIDATION", "token 이 필요하다");
      let signed: { token: string; user: { id: string } };
      try {
        signed = await ctx.auth.api.signInEmail({
          body: { email: OWNER_EMAIL, password: body.data.token },
          headers: fromNodeHeaders(request.headers),
          asResponse: false,
        });
      } catch (error) {
        if (isAPIError(error) && error.statusCode === 401) {
          throw apiError("UNAUTHORIZED", "토큰이 맞지 않는다");
        }
        // 토큰 불일치가 아닌 실패(DB 등)는 401 로 뭉개지 않는다 — 에러 핸들러가 500 으로 낸다
        ctx.logger.error({ err: error }, "local login failed");
        throw error;
      }
      reply.setCookie(SESSION_COOKIE, signed.token, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: ctx.secureCookie,
        maxAge: SESSION_MAX_AGE_S,
      });
      return { sessionToken: signed.token, user: loadUser(ctx.db, signed.user.id) };
    },
  );

  fastify.get("/api/v1/auth/me", { preHandler: requireSession(ctx) }, async (request) => ({
    user: loadUser(ctx.db, sessionUser(request).id),
    workspaceId: ctx.workspaceId,
  }));

  fastify.post("/api/v1/auth/logout", { preHandler: requireSession(ctx) }, async (request, reply) => {
    const token = sessionTokenOf(request);
    if (token) await ctx.auth.api.signOut({ headers: bearerHeaders(token) });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}

/**
 * REST 인증 preHandler. `Authorization: Bearer <sessionToken>` 또는 `dodok.session` 쿠키.
 * Better Auth 자체 쿠키는 보지 않는다.
 */
export function requireSession(ctx: { auth: Auth; workspaceId: string }) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = sessionTokenOf(request);
    const session = token ? await verifySessionToken(ctx.auth, token) : null;
    if (!session) throw apiError("UNAUTHORIZED", "로그인이 필요하다");
    request.user = { id: session.userId, workspaceId: ctx.workspaceId };
  };
}

/** requireSession 뒤 핸들러에서 쓴다 */
export function sessionUser(request: FastifyRequest): { id: string; workspaceId: string } {
  if (!request.user) throw apiError("UNAUTHORIZED", "로그인이 필요하다");
  return request.user;
}

function sessionTokenOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header && header.slice(0, 7).toLowerCase() === "bearer ") {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  return request.cookies[SESSION_COOKIE] || undefined;
}

function bearerHeaders(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

function loadUser(db: Db, id: string): User {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  // Better Auth 세션은 있는데 users 행이 없으면 dodok 사용자가 아니다
  if (!row) throw apiError("UNAUTHORIZED", "사용자를 찾을 수 없다");
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    handle: row.handle,
    displayName: row.displayName,
    ...(row.email ? { email: row.email } : {}),
    authProvider: row.authProvider as User["authProvider"],
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}
