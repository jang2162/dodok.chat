import { LocalLoginBody, type User } from "@dodok/shared";
import { isAPIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from "fastify";
import type { Db } from "../db/client";
import { users, workspaces } from "../db/schema.sqlite";
import { apiError, HttpError } from "../http/errors";
import type { Logger } from "../logger";
import { normalizeEmail } from "../modules/members/accept";
import { recordRateLimit } from "../modules/ops/http-limits";
import type { OpsService } from "../modules/ops/service";
import { type Auth, OWNER_EMAIL, SESSION_COOKIE, SESSION_MAX_AGE_S } from "./index";
import { membershipOf, requireRole, requireSession, sessionTokenOf, sessionUser } from "./roles";

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
  /** /api/v1/auth/local 의 IP 버킷(createIpLimit, LIMITS.localLoginPerMin) — me/password 와 같이 쓴다 */
  loginLimit: onRequestHookHandler;
  /** 로그인 전 상한에 걸리면 ratelimit 사건을 남긴다 */
  ops: Pick<OpsService, "record">;
  /** 로그아웃 뒤 그 세션의 열린 wire 소켓을 끊는다(realtime/socket.ts disconnectSessions) */
  disconnectSessions(sessionIds: readonly string[]): void;
};

/** 이메일 모양 로그인 실패는 까닭(없는 이메일·틀린 비밀번호·owner 이메일·membership 없음)을 가르지 않는다 */
const WRONG_LOGIN = "이메일 또는 비밀번호가 맞지 않는다";
/** 비밀번호가 맞은 비활성 멤버 — 웹 로그인 화면이 이 문구를 그대로 보인다 */
const DEACTIVATED_LOGIN = "비활성화된 계정입니다. 관리자에게 문의하세요.";

/**
 * 여러 경로가 같이 쓰는 IP 당 분당 상한 하나 — 로그인(LIMITS.localLoginPerMin)·초대 경로(LIMITS.invitePublicPerMin)가 하나씩 만든다.
 * route config.rateLimit 은 경로마다 저장소를 새로 만들어 버킷이 갈린다(@fastify/rate-limit LocalStore.child) — 경로를 옮겨 다니며
 * 대입하지 못하게 fastify.rateLimit 핸들러 하나를 여러 경로의 onRequest 에 건다. 이 함수를 부를 때마다 저장소가 따로 생긴다
 */
export function createIpLimit(
  fastify: FastifyInstance,
  opts: { perMin: number; ops: Pick<OpsService, "record"> },
): onRequestHookHandler {
  return fastify.rateLimit({
    max: opts.perMin,
    timeWindow: "1 minute",
    onExceeded: (request: FastifyRequest) => recordRateLimit(opts.ops, request),
  });
}

/**
 * HTTP 로 통과시키는 Better Auth 경로(basePath 뒤). 기본은 닫힘 — 새 Better Auth 버전이 경로를 더해도 여기 없으면 404 다.
 * 웹·스크립트는 Better Auth HTTP 를 부르지 않는다(로그인·로그아웃·세션 확인은 /api/v1/auth/*, 서버 안은 auth.api 직접 호출이라
 * 이 목록과 무관). `/ok` 는 상태만 내는 확인 경로라 남긴다. 목록 밖에서 막는 것: 비밀번호 확인(/verify-password — 현재 비밀번호
 * 대입은 loginLimit 버킷의 me/password 로만)·세션 목록(/list-sessions — 세션 토큰 원문을 낸다) 등. createAuth 의 disabledPaths 는 겹 방어로 둔다
 */
export const BETTER_AUTH_HTTP_PATHS: ReadonlySet<string> = new Set(["/ok"]);

export function registerAuthRoutes(fastify: FastifyInstance, ctx: AuthRouteContext): void {
  const onExceeded = (request: FastifyRequest) => recordRateLimit(ctx.ops, request);
  // Better Auth 자체 엔드포인트 — BETTER_AUTH_HTTP_PATHS 만. 목록 밖도 이 라우트의 IP 버킷을 지나고 404 다
  fastify.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: { rateLimit: { max: ctx.betterAuthPerMin, timeWindow: "1 minute", onExceeded } },
    async handler(request, reply) {
      // 원문 경로(쿼리 뺀)를 정확히 대조한다 — 인코딩·끝 슬래시·`..` 을 풀지 않으므로 변형은 모두 목록 밖이다
      const path = request.url.split("?", 1)[0] ?? "";
      if (!path.startsWith("/api/auth/") || !BETTER_AUTH_HTTP_PATHS.has(path.slice("/api/auth".length)))
        throw apiError("NOT_FOUND", "not found");
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

  // 같은 쿠키를 쓰는 다른 탭의 소켓도 이 세션이다 — 세션 행을 지운 뒤 그 세션의 소켓을 모두 끊는다
  fastify.post("/api/v1/auth/logout", { preHandler: requireSession(ctx) }, async (request, reply) => {
    const token = sessionTokenOf(request);
    if (token) await ctx.auth.api.signOut({ headers: bearerHeaders(token) });
    ctx.disconnectSessions([sessionUser(request).sessionId]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}

/** owner 세션만 통과시키는 preHandler(설정 마법사 결정 6) — requireRole(ctx, "owner") 의 이름 */
export function requireOwner(ctx: { auth: Auth; db: Db; workspaceId: string }) {
  return requireRole(ctx, "owner");
}

/**
 * owner 는 토큰 모양으로만 — 이메일 모양으로 OWNER_EMAIL 을 주면 같은 401. 성공했는데 membership 이 없으면 세션을 지우고 401,
 * 비활성이면 세션을 지우고 403 MEMBER_DEACTIVATED — 비밀번호가 맞은 뒤에만 가르므로 틀린 비밀번호로는 계정이 비활성인지 알 수 없다
 */
async function signInMember(
  ctx: AuthRouteContext,
  request: FastifyRequest,
  rawEmail: string,
  password: string,
): Promise<{ token: string; user: { id: string } }> {
  const email = normalizeEmail(rawEmail);
  if (email === OWNER_EMAIL) throw apiError("UNAUTHORIZED", WRONG_LOGIN);
  const signed = await signIn(ctx, request, email, password, WRONG_LOGIN);
  const membership = membershipOf(ctx.db, ctx.workspaceId, signed.user.id);
  if (!membership || membership.deactivatedAt !== null) {
    await (await ctx.auth.$context).internalAdapter.deleteSession(signed.token);
    if (!membership) throw apiError("UNAUTHORIZED", WRONG_LOGIN);
    // MEMBER_DEACTIVATED 의 기본 상태는 409(가입) — 로그인은 403 이라 상태를 직접 준다
    throw new HttpError(403, { code: "MEMBER_DEACTIVATED", message: DEACTIVATED_LOGIN });
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
