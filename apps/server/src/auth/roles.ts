import { TeamRole } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DbOrTx } from "../db/client";
import { memberships } from "../db/schema.sqlite";
import { apiError } from "../http/errors";
import { type Auth, SESSION_COOKIE, verifySessionToken } from "./index";
import { requireAtLeast } from "./policies";

// 요청이 누구이고 무엇을 할 수 있는가 — 역할 매트릭스의 정본은 팀 스펙 「역할과 권한」 절 표다.
// requireSession 도 여기 있는 까닭: 세션 확인이 membership 을 읽고(없으면 401) requireRole 은 그 위에 선다 —
// 둘을 auth/routes.ts 와 나누면 두 모듈이 서로를 import 한다

declare module "fastify" {
  interface FastifyRequest {
    /** requireSession 이 채운다. role 은 이 요청에서 membership 을 읽은 값이다. sessionId 는 Better Auth session 행의 id */
    user?: { id: string; workspaceId: string; role: TeamRole; sessionId: string };
  }
}

type GuardContext = { auth: Auth; db: DbOrTx; workspaceId: string };

/**
 * membership 그대로 — 비활성도 낸다. 멤버 관리(비활성화·다시 활성화·멤버 표)와 로그인의 403 처럼 비활성을 가려 봐야 하는 자리만 쓴다.
 * 권한 판정은 roleOf 로 한다. 없거나 모르는 역할(guest 등)이면 undefined
 */
export function membershipOf(
  db: DbOrTx,
  workspaceId: string,
  userId: string,
): { role: TeamRole; deactivatedAt: Date | null } | undefined {
  const row = db
    .select({ role: memberships.role, deactivatedAt: memberships.deactivatedAt })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
    .get();
  const parsed = TeamRole.safeParse(row?.role);
  return row && parsed.success ? { role: parsed.data, deactivatedAt: row.deactivatedAt } : undefined;
}

/**
 * 그 워크스페이스에서의 역할. membership 이 없거나 모르는 값(guest 등)이거나 비활성이면 undefined — 비활성을 막는 자리는 이 함수
 * 하나다(채널 보관·멤버 비활성화 계획 판정 PC3). REST(requireSession)·wire 핸드셰이크와 connection·로그인·재설정 링크가 모두 이것으로 본다
 */
export function roleOf(db: DbOrTx, workspaceId: string, userId: string): TeamRole | undefined {
  const membership = membershipOf(db, workspaceId, userId);
  return membership && membership.deactivatedAt === null ? membership.role : undefined;
}

/** 핸들러 안에서(필드별 검사 등) — membership 을 다시 읽어 모자라면 403 을 던진다 */
export function assertRole(db: DbOrTx, workspaceId: string, userId: string, min: TeamRole): void {
  requireAtLeast(roleOf(db, workspaceId, userId), min);
}

/**
 * REST 인증 preHandler. `Authorization: Bearer <sessionToken>` 또는 `dodok.session` 쿠키.
 * Better Auth 자체 쿠키는 보지 않는다. membership 이 없거나 비활성인 세션은 401.
 * 사용자를 확인한 뒤 앱의 REST 상한(restLimits)을 지난다 — 넘으면 429
 */
export function requireSession(ctx: GuardContext) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = sessionTokenOf(request);
    const session = token ? await verifySessionToken(ctx.auth, token) : null;
    if (!session) throw apiError("UNAUTHORIZED", "로그인이 필요하다");
    const role = roleOf(ctx.db, ctx.workspaceId, session.userId);
    if (!role) throw apiError("UNAUTHORIZED", "워크스페이스 멤버가 아니다");
    request.user = { id: session.userId, workspaceId: ctx.workspaceId, role, sessionId: session.sessionId };
    request.server.restLimits?.rest(request, session.userId);
  };
}

/** 세션 확인 뒤 membership 역할을 요청마다 읽는다 — 역할이 바뀌면 다음 요청부터 따른다. 세션 없음 401, membership 없음 401, 모자람 403 */
export function requireRole(ctx: GuardContext, min: TeamRole) {
  const session = requireSession(ctx);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await session(request, reply);
    requireAtLeast(sessionUser(request).role, min);
  };
}

/**
 * 세션 확인 뒤 정책 함수(auth/policies.ts)를 이 요청의 역할로 부른다 — 제어 도구에 대응하는 경로가 쓴다. 본문을 보는 정책(필드별)은
 * 파싱 뒤 핸들러에서 sessionUser(request).role 로 부른다
 */
export function requirePolicy(ctx: GuardContext, policy: (role: TeamRole) => void) {
  const session = requireSession(ctx);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await session(request, reply);
    policy(sessionUser(request).role);
  };
}

/** requireSession 뒤 핸들러에서 쓴다 */
export function sessionUser(request: FastifyRequest): {
  id: string;
  workspaceId: string;
  role: TeamRole;
  sessionId: string;
} {
  if (!request.user) throw apiError("UNAUTHORIZED", "로그인이 필요하다");
  return request.user;
}

export function sessionTokenOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header && header.slice(0, 7).toLowerCase() === "bearer ") {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  return request.cookies[SESSION_COOKIE] || undefined;
}
