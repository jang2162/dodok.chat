/**
 * 초대·재설정 링크·「내 계정」 REST(팀 스펙 3.2~3.5). 원문 토큰은 발급 응답에만 싣고 그 응답은 `Cache-Control: no-store`.
 * lookup·accept·reset 은 로그인 없이 열려 있어 셋이 한 IP 버킷(invitePublicLimit)을 지난다 — 로그인 버킷과는 따로다.
 */
import {
  AcceptInviteBody,
  ChangePasswordBody,
  Id,
  type InviteLookup,
  IssueInviteBody,
  type IssuedInvite,
  ResetPasswordBody,
  TokenBody,
  UpdateMeBody,
} from "@dodok/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { loadUser, loadWorkspace, setSessionCookie } from "../../auth/routes";
import { requireRole, requireSession, roleOf, sessionTokenOf, sessionUser } from "../../auth/roles";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { recordRateLimit } from "../ops/http-limits";
import type { Limits } from "../ops/limits";
import { KeyedLimiter } from "../ops/ratelimit";
import type { OpsService } from "../ops/service";
import { acceptInvite, inviteNotFound, resetPassword } from "./accept";
import { changePassword, updateDisplayName } from "./account";
import {
  canIssueResetLink,
  findValidInvite,
  getPendingInvite,
  issueInvite,
  issueResetLink,
  listPendingInvites,
  resetLinkUsable,
  revokeInvite,
} from "./invites";
import { broadcastPeople } from "./people";

export type MemberRouteContext = {
  auth: Auth;
  db: Db;
  /** 가입·표시 이름 바꾸기 뒤 people.changed(people.ts broadcastPeople) */
  bus: ServerBus;
  logger: Logger;
  workspaceId: string;
  /** 링크 url 의 앞부분(`<APP_ORIGIN>/join/<token>`) */
  appOrigin: string;
  secureCookie: boolean;
  limits: Pick<Limits, "inviteIssuePerMin">;
  /** 로그인과 같이 쓰는 IP 버킷(auth/routes.ts createIpLimit, LIMITS.localLoginPerMin) — me/password 가 지난다 */
  loginLimit: onRequestHookHandler;
  /** lookup·accept·reset 이 같이 쓰는 IP 버킷(createIpLimit, LIMITS.invitePublicPerMin) */
  invitePublicLimit: onRequestHookHandler;
  /** 재설정 수락 뒤 대상의 열린 wire 소켓을 모두 끊는다(realtime/socket.ts disconnectUser) */
  disconnectUser(userId: string): void;
  /** me/password 뒤 지운 세션의 열린 wire 소켓만 끊는다(realtime/socket.ts disconnectSessions) */
  disconnectSessions(sessionIds: readonly string[]): void;
  ops: Pick<OpsService, "record">;
  /** 레이트리밋 시계 — app.ts 의 limitClock */
  limitNow: () => number;
  /** 만료 판정 시계(기본 new Date) */
  now?: () => Date;
};

const IdParams = z.object({ id: Id });
const UserParams = z.object({ userId: Id });

export function registerMemberRoutes(fastify: FastifyInstance, ctx: MemberRouteContext): void {
  const now = ctx.now ?? (() => new Date());
  const admin = requireRole(ctx, "admin");
  const acceptDeps = {
    db: ctx.db,
    auth: ctx.auth,
    workspaceId: ctx.workspaceId,
    ops: ctx.ops,
    logger: ctx.logger,
    now,
  };
  const issueLimiter = new KeyedLimiter({ perMin: ctx.limits.inviteIssuePerMin, now: ctx.limitNow });
  // 초대와 재설정 링크가 한 버킷 — 링크를 대량으로 찍어 두는 것을 막는다(스펙 7장)
  const issueLimit = async (request: FastifyRequest): Promise<void> => {
    if (issueLimiter.take(sessionUser(request).id)) return;
    recordRateLimit(ctx.ops, request);
    throw apiError("RATE_LIMITED", "링크 발급 요청이 너무 많습니다");
  };
  const linkUrl = (path: "join" | "reset", token: string) =>
    `${ctx.appOrigin.replace(/\/+$/, "")}/${path}/${token}`;
  const issued = (reply: FastifyReply, result: IssuedInvite) =>
    reply.status(201).header("cache-control", "no-store").send(result);

  fastify.post("/api/v1/invites", { preHandler: [admin, issueLimit] }, async (request, reply) => {
    const { role } = parseBody(IssueInviteBody, request.body);
    const me = sessionUser(request);
    if (role === "admin" && me.role !== "owner")
      throw apiError("FORBIDDEN", "admin 초대는 owner 만 할 수 있다");
    const { invite, token } = issueInvite(ctx.db, {
      workspaceId: ctx.workspaceId,
      role,
      createdBy: me.id,
      now: now(),
    });
    ctx.logger.info({ inviteId: invite.id, role, by: me.id }, "invite issued");
    return issued(reply, { invite, token, url: linkUrl("join", token) });
  });

  fastify.get("/api/v1/invites", { preHandler: admin }, async () => ({
    invites: listPendingInvites(ctx.db, ctx.workspaceId, now()),
  }));

  fastify.delete("/api/v1/invites/:id", { preHandler: admin }, async (request, reply) => {
    const { id } = parseParams(IdParams, request.params);
    const me = sessionUser(request);
    const at = now();
    const pending = getPendingInvite(ctx.db, ctx.workspaceId, id, at);
    if (!pending) throw apiError("NOT_FOUND", "invite not found");
    if (pending.role === "admin" && me.role !== "owner")
      throw apiError("FORBIDDEN", "admin 초대는 owner 만 폐기할 수 있다");
    if (!revokeInvite(ctx.db, ctx.workspaceId, id, at)) throw apiError("NOT_FOUND", "invite not found");
    ctx.logger.info({ inviteId: id, by: me.id }, "invite revoked");
    return reply.status(204).send();
  });

  fastify.post(
    "/api/v1/members/:userId/reset-link",
    { preHandler: [admin, issueLimit] },
    async (request, reply) => {
      const { userId } = parseParams(UserParams, request.params);
      const me = sessionUser(request);
      const target = roleOf(ctx.db, ctx.workspaceId, userId);
      if (!target) throw apiError("NOT_FOUND", "member not found");
      if (!canIssueResetLink(me.role, target))
        throw apiError(
          "FORBIDDEN",
          target === "owner"
            ? "owner 는 재설정 링크를 받을 수 없다"
            : "admin 은 member 의 재설정 링크만 만들 수 있다",
        );
      const { invite, token } = issueResetLink(ctx.db, {
        workspaceId: ctx.workspaceId,
        targetUserId: userId,
        createdBy: me.id,
        now: now(),
      });
      ctx.logger.info({ inviteId: invite.id, targetUserId: userId, by: me.id }, "reset link issued");
      return issued(reply, { invite, token, url: linkUrl("reset", token) });
    },
  );

  fastify.post("/api/v1/invites/lookup", { onRequest: ctx.invitePublicLimit }, async (request) => {
    const { token } = parseBody(TokenBody, request.body);
    const invite = findValidInvite(ctx.db, token, now());
    if (!invite || invite.workspaceId !== ctx.workspaceId) throw inviteNotFound();
    // 재설정 링크가 지금 역할로 발급 규칙을 못 지나면(대상이 나감·오름) 수락이 404 다 — 조회도 같게
    if (invite.kind === "reset" && !resetLinkUsable(ctx.db, ctx.workspaceId, invite)) throw inviteNotFound();
    const result: InviteLookup = {
      workspaceName: loadWorkspace(ctx.db, ctx.workspaceId).name,
      kind: invite.kind,
      ...(invite.kind === "invite" && invite.role ? { role: invite.role } : {}),
    };
    return result;
  });

  fastify.post("/api/v1/invites/accept", { onRequest: ctx.invitePublicLimit }, async (request, reply) => {
    const body = parseBody(AcceptInviteBody, request.body);
    const { userId, sessionToken } = await acceptInvite(acceptDeps, body);
    broadcastPeople(ctx.bus, ctx.db, ctx.workspaceId);
    setSessionCookie(reply, sessionToken, ctx.secureCookie);
    return { sessionToken, user: loadUser(ctx.db, userId) };
  });

  fastify.post("/api/v1/invites/reset", { onRequest: ctx.invitePublicLimit }, async (request, reply) => {
    const body = parseBody(ResetPasswordBody, request.body);
    const { userId, sessionToken } = await resetPassword(
      { ...acceptDeps, disconnectUser: ctx.disconnectUser },
      body,
    );
    setSessionCookie(reply, sessionToken, ctx.secureCookie);
    return { sessionToken, user: loadUser(ctx.db, userId) };
  });

  fastify.patch("/api/v1/me", { preHandler: requireSession(ctx) }, async (request) => {
    const { displayName } = parseBody(UpdateMeBody, request.body);
    const me = sessionUser(request);
    updateDisplayName(ctx.db, me.id, displayName);
    broadcastPeople(ctx.bus, ctx.db, ctx.workspaceId);
    return { user: loadUser(ctx.db, me.id) };
  });

  // 현재 비밀번호 대입을 로그인과 같은 IP 버킷으로 막는다 — 세션이 새어도 비밀번호까지 얻지 못하게
  fastify.post(
    "/api/v1/me/password",
    { onRequest: ctx.loginLimit, preHandler: requireSession(ctx) },
    async (request, reply) => {
      const me = sessionUser(request);
      if (me.role === "owner") throw apiError("FORBIDDEN", "owner 비밀번호는 로컬 토큰이다 — .env 로 바꾼다");
      const body = parseBody(ChangePasswordBody, request.body);
      const keep = sessionTokenOf(request);
      if (!keep) throw apiError("UNAUTHORIZED", "로그인이 필요하다");
      await changePassword(ctx.auth, me.id, keep, body, ctx.disconnectSessions);
      ctx.logger.info({ userId: me.id }, "password changed");
      return reply.status(204).send();
    },
  );
}
