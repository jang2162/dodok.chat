import { Invite, IssuedInvite } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { invites } from "../src/db/schema.sqlite";
import {
  canIssueResetLink,
  claimInvite,
  findValidInvite,
  issueInvite,
  issueResetLink,
  listPendingInvites,
  revokeInvite,
  unclaimInvite,
} from "../src/modules/members/invites";
import { hashToken, newToken } from "../src/modules/members/tokens";
import { bootTestApp, login, userWithRole } from "./helpers/app";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const DAY = 24 * 60 * 60 * 1000;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("tokens", () => {
  it("초대 dit_·재설정 drt_ + 32바이트 base64url, 해시는 sha256 hex, prefix 는 원문 앞 8자", () => {
    const invite = newToken("invite");
    expect(invite.token).toMatch(/^dit_[A-Za-z0-9_-]{43}$/);
    expect(invite.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.hash).toBe(hashToken(invite.token));
    expect(invite.prefix).toBe(invite.token.slice(0, 8));
    expect(newToken("reset").token).toMatch(/^drt_[A-Za-z0-9_-]{43}$/);
    expect(newToken("invite").token).not.toBe(invite.token);
  });
});

describe("invites service", () => {
  it("발급 — DB 에는 해시만, 목록에 원문 없음, 7일 뒤 무효(가짜 시계)", async () => {
    app = await bootTestApp();
    const now = new Date("2026-09-26T00:00:00Z");
    const { invite, token } = issueInvite(app.db, {
      workspaceId: app.workspaceId,
      role: "member",
      createdBy: app.ownerUserId,
      now,
    });
    expect(Invite.parse(invite)).toEqual(invite);
    expect(invite).toMatchObject({ kind: "invite", role: "member", prefix: token.slice(0, 8) });
    expect(invite.expiresAt).toBe(new Date(now.getTime() + 7 * DAY).toISOString());
    const row = app.db.select().from(invites).where(eq(invites.id, invite.id)).get();
    expect(row?.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const listed = listPendingInvites(app.db, app.workspaceId, now);
    expect(listed).toEqual([invite]);
    expect(JSON.stringify(listed)).not.toContain(token);

    expect(findValidInvite(app.db, token, new Date(now.getTime() + 7 * DAY - 1))?.id).toBe(invite.id);
    expect(findValidInvite(app.db, token, new Date(now.getTime() + 7 * DAY))).toBeUndefined();
    expect(listPendingInvites(app.db, app.workspaceId, new Date(now.getTime() + 7 * DAY))).toEqual([]);
    expect(findValidInvite(app.db, `${token}x`, now)).toBeUndefined();
    expect(findValidInvite(app.db, "", now)).toBeUndefined();
  });

  it("claim 은 한 번만 — 되돌리면 다시 잡힌다. 폐기·만료된 초대는 잡히지 않는다", async () => {
    app = await bootTestApp();
    const now = new Date();
    const input = { workspaceId: app.workspaceId, role: "member" as const, createdBy: app.ownerUserId, now };
    const { invite, token } = issueInvite(app.db, input);
    expect(claimInvite(app.db, invite.id, now)).toBe(true);
    expect(claimInvite(app.db, invite.id, now)).toBe(false);
    expect(findValidInvite(app.db, token, now)).toBeUndefined();
    unclaimInvite(app.db, invite.id);
    expect(findValidInvite(app.db, token, now)?.id).toBe(invite.id);
    expect(claimInvite(app.db, invite.id, now)).toBe(true);

    const revoked = issueInvite(app.db, input);
    expect(revokeInvite(app.db, app.workspaceId, revoked.invite.id, now)?.id).toBe(revoked.invite.id);
    expect(revokeInvite(app.db, app.workspaceId, revoked.invite.id, now)).toBeUndefined();
    expect(claimInvite(app.db, revoked.invite.id, now)).toBe(false);
    expect(findValidInvite(app.db, revoked.token, now)).toBeUndefined();

    const old = issueInvite(app.db, { ...input, now: new Date(now.getTime() - 8 * DAY) });
    expect(claimInvite(app.db, old.invite.id, now)).toBe(false);
  });

  it("재설정 링크 — 새로 발급하면 대상의 앞 것은 무효, 24시간 뒤 무효, 대기 초대 목록에 없다", async () => {
    app = await bootTestApp();
    const member = await userWithRole(app, "bee", "member");
    const now = new Date();
    const input = { workspaceId: app.workspaceId, targetUserId: member.id, createdBy: app.ownerUserId, now };
    const first = issueResetLink(app.db, input);
    expect(first.token).toMatch(/^drt_/);
    expect(first.invite).toMatchObject({ kind: "reset", targetUserId: member.id });
    expect(first.invite.role).toBeUndefined();
    const second = issueResetLink(app.db, input);
    expect(findValidInvite(app.db, first.token, now)).toBeUndefined();
    expect(findValidInvite(app.db, second.token, now)?.id).toBe(second.invite.id);
    expect(findValidInvite(app.db, second.token, new Date(now.getTime() + DAY))).toBeUndefined();
    expect(listPendingInvites(app.db, app.workspaceId, now)).toEqual([]);
  });
});

describe("canIssueResetLink — 발급·조회·수락이 함께 쓰는 규칙", () => {
  it("owner 는 owner 밖 누구에게나, admin 은 member 에게만, member·역할 없음(비활성 멤버)은 누구에게도 못 낸다", () => {
    const roles = ["owner", "admin", "member", undefined] as const;
    const allowed = roles.flatMap((issuer) =>
      roles.filter((target) => canIssueResetLink(issuer, target)).map((target) => `${issuer}→${target}`),
    );
    expect(allowed).toEqual(["owner→admin", "owner→member", "admin→member"]);
  });
});

describe("invites REST", () => {
  it("owner 발급 — 201·no-store·원문 dit_·url 은 APP_ORIGIN/join/<token>, 목록엔 원문 없음, 폐기 뒤 목록에서 빠짐", async () => {
    app = await bootTestApp();
    const { headers } = await login(app);
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites",
      headers,
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const issued = IssuedInvite.parse(res.json());
    expect(issued.token).toMatch(/^dit_/);
    expect(issued.url).toBe(`http://localhost:5173/join/${issued.token}`);
    expect(issued.invite).toMatchObject({ role: "admin", createdBy: app.ownerUserId });

    const list = await app.fastify.inject({ method: "GET", url: "/api/v1/invites", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ invites: [issued.invite] });
    expect(list.body).not.toContain(issued.token);

    const del = await app.fastify.inject({
      method: "DELETE",
      url: `/api/v1/invites/${issued.invite.id}`,
      headers,
    });
    expect(del.statusCode).toBe(204);
    const again = await app.fastify.inject({
      method: "DELETE",
      url: `/api/v1/invites/${issued.invite.id}`,
      headers,
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual({ code: "NOT_FOUND", message: "대기 중인 초대를 찾을 수 없습니다" });
    expect((await app.fastify.inject({ method: "GET", url: "/api/v1/invites", headers })).json()).toEqual({
      invites: [],
    });
  });

  it("admin 은 member 초대만 발급·폐기, member 는 초대 경로 403", async () => {
    app = await bootTestApp();
    const owner = await login(app);
    const admin = await userWithRole(app, "adm", "admin");
    const member = await userWithRole(app, "mem", "member");
    const issue = (headers: Record<string, string>, role: string) =>
      app!.fastify.inject({ method: "POST", url: "/api/v1/invites", headers, payload: { role } });

    expect((await issue(bearer(admin.token), "admin")).statusCode).toBe(403);
    const memberInvite = await issue(bearer(admin.token), "member");
    expect(memberInvite.statusCode).toBe(201);
    expect((await issue(bearer(member.token), "member")).statusCode).toBe(403);
    expect(
      (await app.fastify.inject({ method: "GET", url: "/api/v1/invites", headers: bearer(member.token) }))
        .statusCode,
    ).toBe(403);

    const adminInvite = IssuedInvite.parse((await issue(owner.headers, "admin")).json());
    const revoke = (headers: Record<string, string>, id: string) =>
      app!.fastify.inject({ method: "DELETE", url: `/api/v1/invites/${id}`, headers });
    expect((await revoke(bearer(admin.token), adminInvite.invite.id)).statusCode).toBe(403);
    expect((await revoke(bearer(member.token), adminInvite.invite.id)).statusCode).toBe(403);
    // 막힌 폐기는 초대를 건드리지 않는다
    expect(findValidInvite(app.db, adminInvite.token, new Date())?.id).toBe(adminInvite.invite.id);
    const memberInviteId = IssuedInvite.parse(memberInvite.json()).invite.id;
    expect((await revoke(bearer(admin.token), memberInviteId)).statusCode).toBe(204);
  });

  it("재설정 링크 — owner 는 admin·member 에게, admin 은 member 에게만, owner 계정 대상은 403, 없는 사용자 404", async () => {
    app = await bootTestApp();
    const owner = await login(app);
    const admin = await userWithRole(app, "adm", "admin");
    const admin2 = await userWithRole(app, "adm2", "admin");
    const member = await userWithRole(app, "mem", "member");
    const reset = (headers: Record<string, string>, userId: string) =>
      app!.fastify.inject({ method: "POST", url: `/api/v1/members/${userId}/reset-link`, headers });

    const byOwner = await reset(owner.headers, admin.id);
    expect(byOwner.statusCode).toBe(201);
    expect(byOwner.headers["cache-control"]).toBe("no-store");
    const issued = IssuedInvite.parse(byOwner.json());
    expect(issued.token).toMatch(/^drt_/);
    expect(issued.url).toBe(`http://localhost:5173/reset/${issued.token}`);

    expect((await reset(owner.headers, app.ownerUserId)).statusCode).toBe(403);
    expect((await reset(bearer(admin.token), app.ownerUserId)).statusCode).toBe(403);
    expect((await reset(bearer(admin.token), admin2.id)).statusCode).toBe(403);
    expect((await reset(bearer(admin.token), member.id)).statusCode).toBe(201);
    expect((await reset(bearer(member.token), member.id)).statusCode).toBe(403);
    expect((await reset(owner.headers, "0190a000-0000-7000-8000-000000000000")).statusCode).toBe(404);
  });

  it("발급은 사용자당 분당 inviteIssuePerMin — 초대와 재설정 링크가 같은 버킷", async () => {
    let clock = 0;
    app = await bootTestApp({}, { limits: { inviteIssuePerMin: 2 }, limitClock: () => clock });
    const { headers } = await login(app);
    const member = await userWithRole(app, "mem", "member");
    const issue = () =>
      app!.fastify.inject({ method: "POST", url: "/api/v1/invites", headers, payload: { role: "member" } });
    expect((await issue()).statusCode).toBe(201);
    expect(
      (
        await app.fastify.inject({
          method: "POST",
          url: `/api/v1/members/${member.id}/reset-link`,
          headers,
        })
      ).statusCode,
    ).toBe(201);
    const third = await issue();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ code: "RATE_LIMITED" });
    clock += 60_000;
    expect((await issue()).statusCode).toBe(201);
  });
});
