import { IssuedInvite, User } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { account as authAccount, session as authSession, user as authUser } from "../src/db/auth-schema";
import { agents, invites, memberships, opsEvents, users } from "../src/db/schema.sqlite";
import { findValidInvite } from "../src/modules/members/invites";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { connectWire } from "./helpers/wire";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const PASSWORD = "correct-horse-battery";
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function issue(a: App, headers: Record<string, string>, role: "admin" | "member" = "member") {
  const res = await a.fastify.inject({ method: "POST", url: "/api/v1/invites", headers, payload: { role } });
  if (res.statusCode !== 201) throw new Error(`issue 실패: ${res.statusCode} ${res.body}`);
  return IssuedInvite.parse(res.json());
}

const accept = (a: App, payload: Record<string, unknown>) =>
  a.fastify.inject({ method: "POST", url: "/api/v1/invites/accept", payload });

const joinBody = (token: string, over: Record<string, unknown> = {}) => ({
  token,
  handle: "bee",
  displayName: "Bee",
  email: "bee@example.com",
  password: PASSWORD,
  ...over,
});

const me = (a: App, token: string) =>
  a.fastify.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(token) });

function counts(a: App) {
  return {
    users: a.db.select().from(users).all().length,
    memberships: a.db.select().from(memberships).all().length,
    authUsers: a.db.select().from(authUser).all().length,
  };
}

/** 로그인 버킷(5회/분)을 넉넉히 — 이 파일은 로그인을 여러 번 한다. 수락·재설정은 초대 경로 버킷(invitePublicPerMin)이라 따로다 */
const roomy = { limits: { localLoginPerMin: 100 } };

describe("POST /api/v1/invites/lookup·accept", () => {
  it("정상 가입 → 쿠키·sessionToken, /auth/me 의 role 이 초대의 역할, 초대는 소비·used_by", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const issued = await issue(app, owner.headers, "admin");

    const lookup = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/lookup",
      payload: { token: issued.token },
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toEqual({ workspaceName: "dodok", kind: "invite", role: "admin" });

    const res = await accept(app, joinBody(issued.token));
    expect(res.statusCode).toBe(200);
    const { sessionToken, user } = res.json() as { sessionToken: string; user: User };
    expect(User.parse(user)).toEqual(user);
    expect(user).toMatchObject({ handle: "bee", displayName: "Bee", email: "bee@example.com" });
    expect(user.authProvider).toBe("local");
    expect(res.cookies.find((c) => c.name === "dodok.session")).toMatchObject({
      value: sessionToken,
      httpOnly: true,
    });
    const meRes = await me(app, sessionToken);
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toMatchObject({ role: "admin", user: { id: user.id } });

    const row = app.db.select().from(invites).where(eq(invites.id, issued.invite.id)).get();
    expect(row?.usedAt).toBeInstanceOf(Date);
    expect(row?.usedBy).toBe(user.id);
    // 재사용 404 — 조회도 수락도
    const reuse = await accept(app, joinBody(issued.token, { handle: "bee2", email: "bee2@example.com" }));
    expect(reuse.statusCode).toBe(404);
    const relookup = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/lookup",
      payload: { token: issued.token },
    });
    expect(relookup.statusCode).toBe(404);
  });

  it("만료·폐기·없음·재설정 토큰은 모두 같은 404 본문", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const expired = await issue(app, owner.headers);
    app.db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invites.id, expired.invite.id))
      .run();
    const revoked = await issue(app, owner.headers);
    await app.fastify.inject({
      method: "DELETE",
      url: `/api/v1/invites/${revoked.invite.id}`,
      headers: owner.headers,
    });
    const member = await userWithRole(app, "mem", "member");
    const reset = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/members/${member.id}/reset-link`,
      headers: owner.headers,
    });
    const resetToken = (reset.json() as { token: string }).token;

    const bodies = [];
    for (const token of [expired.token, revoked.token, "dit_nope", resetToken]) {
      const res = await accept(app, joinBody(token));
      expect(res.statusCode, token.slice(0, 8)).toBe(404);
      bodies.push(res.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(counts(app).users).toBe(2);
  });

  it("Review Focus 1 — 같은 링크를 거의 동시에 두 번 제출하면 한 명만, 다른 쪽 404", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const issued = await issue(app, owner.headers);
    const before = counts(app);
    const [a, b] = await Promise.all([
      accept(app, joinBody(issued.token)),
      accept(app, joinBody(issued.token, { handle: "wasp", email: "wasp@example.com" })),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
    expect(counts(app)).toEqual({
      users: before.users + 1,
      memberships: before.memberships + 1,
      authUsers: before.authUsers + 1,
    });
  });

  it("Review Focus 2 — 에이전트 핸들 dev 로 가입하면 409 field:handle, 초대 미소비, 고쳐서 성공", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    app.db
      .insert(agents)
      .values({
        id: uuidv7(),
        workspaceId: app.workspaceId,
        provider: "openclaw",
        providerAgentId: "dev",
        handle: "dev",
        name: "Dev",
        createdAt: new Date(),
      })
      .run();
    const issued = await issue(app, owner.headers);
    const before = counts(app);
    const clash = await accept(app, joinBody(issued.token, { handle: "dev" }));
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ code: "CONFLICT", details: { field: "handle" } });
    expect(counts(app)).toEqual(before);
    expect(findValidInvite(app.db, issued.token, new Date())?.id).toBe(issued.invite.id);
    // 사람 핸들(owner)과 겹쳐도 409
    const human = await accept(app, joinBody(issued.token, { handle: "owner" }));
    expect(human.json()).toMatchObject({ code: "CONFLICT", details: { field: "handle" } });

    const fixed = await accept(app, joinBody(issued.token, { handle: "dev2" }));
    expect(fixed.statusCode).toBe(200);
  });

  it("이메일은 소문자로 넣는다 — 대문자만 다른 이메일로 둘째 가입은 409 field:email, owner 이메일도 409", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const first = await accept(
      app,
      joinBody((await issue(app, owner.headers)).token, { email: "Bee@X.com" }),
    );
    expect(first.statusCode).toBe(200);
    expect((first.json() as { user: User }).user.email).toBe("bee@x.com");

    const issued = await issue(app, owner.headers);
    const dup = await accept(app, joinBody(issued.token, { handle: "bee2", email: "BEE@x.com" }));
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: "CONFLICT", details: { field: "email" } });
    const ownerEmail = await accept(
      app,
      joinBody(issued.token, { handle: "bee2", email: "Owner@dodok.local" }),
    );
    expect(ownerEmail.json()).toMatchObject({ code: "CONFLICT", details: { field: "email" } });
    expect(findValidInvite(app.db, issued.token, new Date())?.id).toBe(issued.invite.id);

    const login2 = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: { email: "bee@x.com", password: PASSWORD },
    });
    expect(login2.statusCode).toBe(200);
  });

  it("입력 검증 — 핸들 모양·짧은 비밀번호·빈 표시 이름은 400, 초대 미소비", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const issued = await issue(app, owner.headers);
    for (const over of [
      { handle: "Bee" },
      { handle: "b" },
      { password: "short-pass1" },
      { displayName: "   " },
      { email: "not-an-email" },
    ]) {
      const res = await accept(app, joinBody(issued.token, over));
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
    }
    expect(findValidInvite(app.db, issued.token, new Date())?.id).toBe(issued.invite.id);
  });

  it("우리 행 쓰기가 실패하면 Better Auth 사용자를 지우고 초대를 되돌린다 → 500, 고친 뒤 다시 성공", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const issued = await issue(app, owner.headers);
    const before = counts(app);
    app.db.$client.exec(
      "CREATE TRIGGER fail_membership BEFORE INSERT ON memberships BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    const res = await accept(app, joinBody(issued.token));
    expect(res.statusCode).toBe(500);
    expect(counts(app)).toEqual(before);
    expect(findValidInvite(app.db, issued.token, new Date())?.id).toBe(issued.invite.id);
    expect(app.db.select().from(opsEvents).where(eq(opsEvents.kind, "invite_accept_failed")).all()).toEqual(
      [],
    );

    app.db.$client.exec("DROP TRIGGER fail_membership;");
    expect((await accept(app, joinBody(issued.token))).statusCode).toBe(200);
  });

  it("users 쓰기 실패(되돌리기 성공) → 500, 로그에 쿼리 파라미터(이메일·핸들)가 없다", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
    app = await bootTestApp({}, { ...roomy, logger });
    const owner = await login(app);
    const issued = await issue(app, owner.headers);
    const before = counts(app);
    app.db.$client.exec(
      "CREATE TRIGGER fail_users BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    const res = await accept(app, joinBody(issued.token, { handle: "secret-handle" }));
    expect(res.statusCode).toBe(500);
    expect(counts(app)).toEqual(before);
    expect(findValidInvite(app.db, issued.token, new Date())?.id).toBe(issued.invite.id);
    const logText = lines.join("\n");
    expect(logText).toContain("invite accept failed");
    for (const secret of [issued.token, "bee@example.com", PASSWORD, "secret-handle"]) {
      expect(logText, secret.slice(0, 6)).not.toContain(secret);
    }
  });

  it("되돌리기도 실패하면 운영 사건 invite_accept_failed(원문 없이) 후 500 — 로그에 쿼리 파라미터(이메일·핸들)가 없다", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
    app = await bootTestApp({}, { ...roomy, logger });
    const owner = await login(app);
    const issued = await issue(app, owner.headers);
    // users INSERT 의 파라미터에 이메일·핸들이 실린다 — drizzle 쿼리 오류 문구가 로그로 새지 않는지 본다
    app.db.$client.exec(
      "CREATE TRIGGER fail_users BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    app.db.$client.exec(
      "CREATE TRIGGER fail_unclaim BEFORE UPDATE ON invites WHEN NEW.used_at IS NULL BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    const res = await accept(app, joinBody(issued.token));
    expect(res.statusCode).toBe(500);
    const events = app.db.select().from(opsEvents).where(eq(opsEvents.kind, "invite_accept_failed")).all();
    expect(events).toHaveLength(1);
    const text = JSON.stringify(events);
    expect(text).not.toContain(issued.token);
    expect(text).not.toContain("bee@example.com");
    expect(text).not.toContain(PASSWORD);
    const logText = lines.join("\n");
    expect(logText).toContain("invite accept rollback failed");
    for (const secret of [issued.token, "bee@example.com", PASSWORD, '"bee"']) {
      expect(logText, secret.slice(0, 6)).not.toContain(secret);
    }
  });

  it("경합 — 검사 뒤 다른 요청이 같은 핸들을 먼저 커밋하면 409 로 바뀌고 초대가 되돌려진다", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const issued = await issue(app, owner.headers);
    const before = counts(app);
    const ctx = await app.auth.$context;
    const createUser = ctx.internalAdapter.createUser.bind(ctx.internalAdapter);
    // assertHandleFree·claimInvite 는 이미 동기로 지났다 — Better Auth 사용자를 만드는 await 중간에
    // 다른 요청이 같은 핸들로 먼저 커밋했다고 흉내 낸다. Promise.all 로 두 accept 를 동시에 내면 앞선 요청의 행이
    // 동기 검사보다 먼저 들어가 이 catch 경로에 닿지 않는다(리뷰 p4m-t3-review.md m1-2) — 그래서 직접 끼워 넣는다
    ctx.internalAdapter.createUser = (async (...args: Parameters<typeof createUser>) => {
      app!.db
        .insert(users)
        .values({
          id: uuidv7(),
          workspaceId: app!.workspaceId,
          handle: "bee",
          displayName: "Rival",
          email: "rival@example.com",
          authProvider: "local",
          createdAt: new Date(),
        })
        .run();
      return createUser(...args);
    }) as typeof createUser;

    const res = await accept(app, joinBody(issued.token));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "CONFLICT", details: { field: "handle" } });
    expect(findValidInvite(app.db, issued.token, new Date())?.id).toBe(issued.invite.id);
    // Better Auth 사용자는 만들어졌다가 되돌리기로 지워진다 — rival 의 users 행 하나만 늘어난다
    expect(counts(app)).toEqual({
      users: before.users + 1,
      memberships: before.memberships,
      authUsers: before.authUsers,
    });
  });
});

describe("초대 수락 — 고아 Better Auth 사용자(우리 users 행 없음)는 지우고 새로 만든다", () => {
  /** 수락 도중(Better Auth 생성 뒤·우리 행 앞) 프로세스가 죽은 자리를 흉내 낸다 — 사용자·계정·세션만 있고 users 행이 없다 */
  async function orphan(a: App, email: string) {
    const ctx = await a.auth.$context;
    const id = uuidv7();
    await ctx.internalAdapter.createUser(
      { id, email, name: "ghost", emailVerified: true },
      { method: "email-password" },
    );
    await ctx.internalAdapter.linkAccount({
      userId: id,
      providerId: "credential",
      accountId: id,
      password: await ctx.password.hash("ghost-password-123"),
    });
    const session = await ctx.internalAdapter.createSession(id);
    return { id, sessionToken: session.token };
  }
  const authRows = (a: App, userId: string) => ({
    user: a.db.select().from(authUser).where(eq(authUser.id, userId)).all().length,
    accounts: a.db.select().from(authAccount).where(eq(authAccount.userId, userId)).all().length,
    sessions: a.db.select().from(authSession).where(eq(authSession.userId, userId)).all().length,
  });

  it("같은 이메일의 고아가 있으면 그 사용자·계정·세션을 지우고 가입한다 — 새 비밀번호로 로그인되고 고아의 것은 안 된다", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const ghost = await orphan(app, "bee@example.com");
    const issued = await issue(app, owner.headers);
    const before = counts(app);

    const res = await accept(app, joinBody(issued.token, { email: "Bee@Example.com" }));
    expect(res.statusCode).toBe(200);
    const { user } = res.json() as { user: User };
    expect(user.id).not.toBe(ghost.id);
    expect(authRows(app, ghost.id)).toEqual({ user: 0, accounts: 0, sessions: 0 });
    expect(counts(app)).toEqual({
      users: before.users + 1,
      memberships: before.memberships + 1,
      authUsers: before.authUsers,
    });
    expect((await me(app, ghost.sessionToken)).statusCode).toBe(401);
    const signIn = (password: string) =>
      app!.fastify.inject({
        method: "POST",
        url: "/api/v1/auth/local",
        payload: { email: "bee@example.com", password },
      });
    expect((await signIn(PASSWORD)).statusCode).toBe(200);
    expect((await signIn("ghost-password-123")).statusCode).toBe(401);
  });

  it("우리 users 행이 있는 사용자는 절대 지우지 않는다 — 409 field:email, 그 사람의 세션·계정 그대로, 초대 미소비", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const member = await userWithRole(app, "mem", "member");
    const ctx = await app.auth.$context;
    await ctx.internalAdapter.linkAccount({
      userId: member.id,
      providerId: "credential",
      accountId: member.id,
      password: await ctx.password.hash(PASSWORD),
    });
    const issued = await issue(app, owner.headers);
    const before = authRows(app, member.id);

    const res = await accept(app, joinBody(issued.token, { email: "mem@dodok.local" }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "CONFLICT", details: { field: "email" } });
    expect(authRows(app, member.id)).toEqual(before);
    expect(before).toEqual({ user: 1, accounts: 1, sessions: 1 });
    expect((await me(app, member.token)).statusCode).toBe(200);
    expect(findValidInvite(app.db, issued.token, new Date())?.id).toBe(issued.invite.id);
  });

  it("owner 이메일의 Better Auth 사용자는 users 행이 없어도 지우지 않는다 — 409", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const issued = await issue(app, owner.headers);
    // owner 부트스트랩 중간(Better Auth 사용자만 있고 users 행 전)을 흉내 낸다 — 다음 부팅이 그 사용자로 users 행을 채운다
    app.db.delete(memberships).where(eq(memberships.userId, app.ownerUserId)).run();
    app.db.$client.pragma("foreign_keys = OFF");
    app.db.delete(users).where(eq(users.id, app.ownerUserId)).run();
    app.db.$client.pragma("foreign_keys = ON");

    const res = await accept(app, joinBody(issued.token, { email: "owner@dodok.local" }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "CONFLICT", details: { field: "email" } });
    expect(authRows(app, app.ownerUserId).user).toBe(1);
  });

  it("같은 이메일의 수락이 진행 중이면(Better Auth 생성 뒤·우리 행 앞) 그 사용자를 고아로 보지 않는다 — 뒤 요청 409, 앞 요청 성공", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const first = await issue(app, owner.headers);
    const second = await issue(app, owner.headers);
    const ctx = await app.auth.$context;
    const linkAccount = ctx.internalAdapter.linkAccount.bind(ctx.internalAdapter);
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    ctx.internalAdapter.linkAccount = (async (...args: Parameters<typeof linkAccount>) => {
      entered();
      await gate;
      return linkAccount(...args);
    }) as typeof linkAccount;

    const pending = accept(app, joinBody(first.token));
    await reached;
    ctx.internalAdapter.linkAccount = linkAccount;
    const rival = await accept(app, joinBody(second.token, { handle: "wasp" }));
    expect(rival.statusCode).toBe(409);
    expect(rival.json()).toMatchObject({ code: "CONFLICT", details: { field: "email" } });
    expect(findValidInvite(app.db, second.token, new Date())?.id).toBe(second.invite.id);

    release();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    const { user, sessionToken } = res.json() as { user: User; sessionToken: string };
    expect(authRows(app, user.id)).toEqual({ user: 1, accounts: 1, sessions: 1 });
    expect((await me(app, sessionToken)).statusCode).toBe(200);
  });
});

describe("POST /api/v1/invites/reset", () => {
  it("재설정 뒤 대상의 옛 세션 401, 새 세션으로 로그인됨, 새 비밀번호로 로그인·옛 비밀번호 401", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const joined = await accept(app, joinBody((await issue(app, owner.headers)).token));
    const oldSession = (joined.json() as { sessionToken: string }).sessionToken;
    const userId = (joined.json() as { user: User }).user.id;

    const link = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/members/${userId}/reset-link`,
      headers: owner.headers,
    });
    const { token } = link.json() as { token: string };
    const lookup = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/lookup",
      payload: { token },
    });
    expect(lookup.json()).toEqual({ workspaceName: "dodok", kind: "reset" });

    const next = "brand-new-password-42";
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/reset",
      payload: { token, password: next },
    });
    expect(res.statusCode).toBe(200);
    const { sessionToken, user } = res.json() as { sessionToken: string; user: User };
    expect(user.id).toBe(userId);
    expect(res.cookies.find((c) => c.name === "dodok.session")?.value).toBe(sessionToken);
    expect((await me(app, oldSession)).statusCode).toBe(401);
    expect((await me(app, sessionToken)).statusCode).toBe(200);

    const signIn = (password: string) =>
      app!.fastify.inject({
        method: "POST",
        url: "/api/v1/auth/local",
        payload: { email: "bee@example.com", password },
      });
    expect((await signIn(PASSWORD)).statusCode).toBe(401);
    expect((await signIn(next)).statusCode).toBe(200);

    const reuse = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/reset",
      payload: { token, password: "another-password-42" },
    });
    expect(reuse.statusCode).toBe(404);
    // 초대 토큰은 재설정에 못 쓴다
    const invite = await issue(app, owner.headers);
    const wrongKind = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/reset",
      payload: { token: invite.token, password: next },
    });
    expect(wrongKind.statusCode).toBe(404);
  });

  it("재설정은 대상의 열린 wire 소켓을 모두 서버가 끊는다 — 옛 세션 재접속은 거절, 새 세션·다른 사람 소켓은 그대로", async () => {
    app = await bootTestApp({}, roomy);
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const owner = await login(app);
    const joined = await accept(app, joinBody((await issue(app, owner.headers)).token));
    const first = (joined.json() as { sessionToken: string }).sessionToken;
    const userId = (joined.json() as { user: User }).user.id;
    const signedIn = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: { email: "bee@example.com", password: PASSWORD },
    });
    const second = (signedIn.json() as { sessionToken: string }).sessionToken;
    const victims = [
      await connectWire(app, first),
      await connectWire(app, first),
      await connectWire(app, second),
    ];
    const watcher = await connectWire(app, owner.token);
    try {
      const reasons = victims.map((s) => new Promise<string>((resolve) => s.once("disconnect", resolve)));
      const link = await app.fastify.inject({
        method: "POST",
        url: `/api/v1/members/${userId}/reset-link`,
        headers: owner.headers,
      });
      const res = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/invites/reset",
        payload: { token: (link.json() as { token: string }).token, password: "brand-new-password-42" },
      });
      expect(res.statusCode).toBe(200);
      // 클라이언트가 스스로 끊은 게 아니다
      expect(await Promise.all(reasons)).toEqual(Array(3).fill("io server disconnect"));
      for (const token of [first, second]) {
        await expect(connectWire(app, token)).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
      }
      const fresh = await connectWire(app, (res.json() as { sessionToken: string }).sessionToken);
      fresh.close();
      expect(watcher.connected).toBe(true);
    } finally {
      for (const s of [...victims, watcher]) s.close();
    }
  });

  it("대상이 더 이상 멤버가 아니면 404, 링크는 소비되지 않는다", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const member = await userWithRole(app, "mem", "member");
    const link = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/members/${member.id}/reset-link`,
      headers: owner.headers,
    });
    const { token } = link.json() as { token: string };
    app.db
      .delete(memberships)
      .where(and(eq(memberships.workspaceId, app.workspaceId), eq(memberships.userId, member.id)))
      .run();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/reset",
      payload: { token, password: "brand-new-password-42" },
    });
    expect(res.statusCode).toBe(404);
    expect(findValidInvite(app.db, token, new Date())).toBeDefined();
  });

  it("검사 뒤 claim 전(비밀번호 해시 중)에 대상이 멤버에서 빠지면 404, 링크는 소비되지 않고 비밀번호도 그대로", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const joined = await accept(app, joinBody((await issue(app, owner.headers)).token));
    const userId = (joined.json() as { user: User }).user.id;
    const link = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/members/${userId}/reset-link`,
      headers: owner.headers,
    });
    const { token } = link.json() as { token: string };
    // claim 직전의 await 에 끼는 훅 — 첫 검사는 이미 지났다
    const ctx = await app.auth.$context;
    const hash = ctx.password.hash;
    ctx.password.hash = async (password: string) => {
      app!.db
        .delete(memberships)
        .where(and(eq(memberships.workspaceId, app!.workspaceId), eq(memberships.userId, userId)))
        .run();
      return hash(password);
    };
    try {
      const res = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/invites/reset",
        payload: { token, password: "brand-new-password-42" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      ctx.password.hash = hash;
    }
    expect(findValidInvite(app.db, token, new Date())).toBeDefined();
    const account = await ctx.internalAdapter.findCredentialAccount(userId);
    expect(await ctx.password.verify({ hash: account!.password!, password: PASSWORD })).toBe(true);
  });

  it("조회도 — 대상이 더 이상 멤버가 아니면 404", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const member = await userWithRole(app, "mem", "member");
    const link = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/members/${member.id}/reset-link`,
      headers: owner.headers,
    });
    const { token } = link.json() as { token: string };
    app.db
      .delete(memberships)
      .where(and(eq(memberships.workspaceId, app.workspaceId), eq(memberships.userId, member.id)))
      .run();
    const lookup = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/lookup",
      payload: { token },
    });
    expect(lookup.statusCode).toBe(404);
    expect(findValidInvite(app.db, token, new Date())).toBeDefined();
  });

  it("동시 두 번 제출 — 한 쪽만 성공한다(claim 결과를 본다)", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const joined = await accept(app, joinBody((await issue(app, owner.headers)).token));
    const userId = (joined.json() as { user: User }).user.id;
    const link = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/members/${userId}/reset-link`,
      headers: owner.headers,
    });
    const { token } = link.json() as { token: string };
    const submit = (password: string) =>
      app!.fastify.inject({ method: "POST", url: "/api/v1/invites/reset", payload: { token, password } });
    const [a, b] = await Promise.all([submit("first-new-password-1"), submit("second-new-password-2")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
  });
});
