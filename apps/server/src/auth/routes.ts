import { LocalLoginBody, type User } from "@dodok/shared";
import { isAPIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from "fastify";
import type { Db } from "../db/client";
import { users, workspaces } from "../db/schema.sqlite";
import { apiError } from "../http/errors";
import type { Logger } from "../logger";
import { normalizeEmail } from "../modules/members/accept";
import { recordRateLimit } from "../modules/ops/http-limits";
import type { OpsService } from "../modules/ops/service";
import { type Auth, OWNER_EMAIL, SESSION_COOKIE, SESSION_MAX_AGE_S } from "./index";
import { requireRole, requireSession, roleOf, sessionTokenOf, sessionUser } from "./roles";

// 라우트 모듈들이 이 경로로 가져온다 — 정의는 auth/roles.ts
export { requireSession, sessionUser };

export type AuthRouteContext = {
  auth: Auth;
  db: Db;
  logger: Logger;
  workspaceId: string;
  /** APP_ORIGIN 이 https 일 때 true — 세션 쿠키에 Secure */
  secureCookie: boolean;
  /** /api/auth/*(Better Auth) IP 당 분당 상한 — LIMITS.betterAuthPerMin */
  betterAuthPerMin: number;
  /** /api/v1/auth/local 의 IP 버킷(createLoginLimit) — 초대 조회·수락·재설정과 같이 쓴다 */
  loginLimit: onRequestHookHandler;
  /** 로그인 전 상한에 걸리면 ratelimit 사건을 남긴다 */
  ops: Pick<OpsService, "record">;
};

/** 이메일 모양 로그인 실패는 까닭(없는 이메일·틀린 비밀번호·owner 이메일·membership 없음)을 가르지 않는다 */
const WRONG_LOGIN = "이메일 또는 비밀번호가 맞지 않는다";

/**
 * 로그인 전 경로의 IP 당 분당 상한(LIMITS.localLoginPerMin) 하나. route config.rateLimit 은 경로마다 저장소를 새로 만들어
 * 버킷이 갈린다(@fastify/rate-limit LocalStore.child) — 경로를 옮겨 다니며 대입하지 못하게 fastify.rateLimit 핸들러 하나를
 * 여러 경로의 onRequest 에 건다
 */
export function createLoginLimit(
  fastify: FastifyInstance,
  opts: { perMin: number; ops: Pick<OpsService, "record"> },
): onRequestHookHandler {
  return fastify.rateLimit({
    max: opts.perMin,
    timeWindow: "1 minute",
    onExceeded: (request: FastifyRequest) => recordRateLimit(opts.ops, request),
  });
}

export function registerAuthRoutes(fastify: FastifyInstance, ctx: AuthRouteContext): void {
  const onExceeded = (request: FastifyRequest) => recordRateLimit(ctx.ops, request);
  // Better Auth 자체 엔드포인트. 가입·이메일 사인인은 createAuth 에서 막혀 있다.
  fastify.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: { rateLimit: { max: ctx.betterAuthPerMin, timeWindow: "1 minute", onExceeded } },
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

  fastify.post("/api/v1/auth/local", { onRequest: ctx.loginLimit }, async (request, reply) => {
    const body = LocalLoginBody.safeParse(request.body);
    if (!body.success) throw apiError("VALIDATION", "token 또는 email·password 가 필요하다");
    const signed =
      "token" in body.data
        ? await signIn(ctx, request, OWNER_EMAIL, body.data.token, "토큰이 맞지 않는다")
        : await signInMember(ctx, request, body.data.email, body.data.password);
    setSessionCookie(reply, signed.token, ctx.secureCookie);
    return { sessionToken: signed.token, user: loadUser(ctx.db, signed.user.id) };
  });

  fastify.get("/api/v1/auth/me", { preHandler: requireSession(ctx) }, async (request) => ({
    user: loadUser(ctx.db, sessionUser(request).id),
    // workspaceId 는 기존 클라이언트를 위해 남긴다 — 이름이 필요한 화면은 workspace 를 본다
    workspaceId: ctx.workspaceId,
    workspace: loadWorkspace(ctx.db, ctx.workspaceId),
    // 그 워크스페이스 membership 의 역할 — 웹이 역할별 진입점을 가른다. 행이 없으면 requireSession 이 이미 401 로 막았다
    role: sessionUser(request).role,
  }));

  fastify.post("/api/v1/auth/logout", { preHandler: requireSession(ctx) }, async (request, reply) => {
    const token = sessionTokenOf(request);
    if (token) await ctx.auth.api.signOut({ headers: bearerHeaders(token) });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}

/** owner 세션만 통과시키는 preHandler(설정 마법사 결정 6) — requireRole(ctx, "owner") 의 이름 */
export function requireOwner(ctx: { auth: Auth; db: Db; workspaceId: string }) {
  return requireRole(ctx, "owner");
}

/** owner 는 토큰 모양으로만 — 이메일 모양으로 OWNER_EMAIL 을 주면 같은 401. 성공했는데 membership 이 없으면 세션을 지우고 401 */
async function signInMember(
  ctx: AuthRouteContext,
  request: FastifyRequest,
  rawEmail: string,
  password: string,
): Promise<{ token: string; user: { id: string } }> {
  const email = normalizeEmail(rawEmail);
  if (email === OWNER_EMAIL) throw apiError("UNAUTHORIZED", WRONG_LOGIN);
  const signed = await signIn(ctx, request, email, password, WRONG_LOGIN);
  if (!roleOf(ctx.db, ctx.workspaceId, signed.user.id)) {
    await (await ctx.auth.$context).internalAdapter.deleteSession(signed.token);
    throw apiError("UNAUTHORIZED", WRONG_LOGIN);
  }
  return signed;
}

async function signIn(
  ctx: AuthRouteContext,
  request: FastifyRequest,
  email: string,
  password: string,
  wrong: string,
): Promise<{ token: string; user: { id: string } }> {
  try {
    return await ctx.auth.api.signInEmail({
      body: { email, password },
      headers: fromNodeHeaders(request.headers),
      asResponse: false,
    });
  } catch (error) {
    if (isAPIError(error) && error.statusCode === 401) throw apiError("UNAUTHORIZED", wrong);
    // 자격 불일치가 아닌 실패(DB 등)는 401 로 뭉개지 않는다 — 에러 핸들러가 500 으로 낸다
    ctx.logger.error({ err: error }, "local login failed");
    throw error;
  }
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: SESSION_MAX_AGE_S,
  });
}

function bearerHeaders(token: string): Headers {
  return new Headers({ authorization: `Bearer ${token}` });
}

export function loadWorkspace(db: Db, id: string): { id: string; name: string } {
  const row = db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .get();
  // 부팅이 ensureWorkspace 로 보장한다 — 없으면 DB 가 갈린 것이다
  if (!row) throw apiError("INTERNAL", "workspace not found");
  return row;
}

export function loadUser(db: Db, id: string): User {
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
