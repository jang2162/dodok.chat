import { IssuedInvite, User } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { session as authSession } from "../src/db/auth-schema";
import { memberships } from "../src/db/schema.sqlite";
import { bootTestApp, login, TEST_LOCAL_TOKEN } from "./helpers/app";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const PASSWORD = "correct-horse-battery";
const WRONG_LOGIN = { code: "UNAUTHORIZED", message: "이메일 또는 비밀번호가 맞지 않는다" };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const local = (a: App, payload: Record<string, unknown>) =>
  a.fastify.inject({ method: "POST", url: "/api/v1/auth/local", payload });

const me = (a: App, token: string) =>
  a.fastify.inject({ method: "GET", url: "/api/v1/auth/me", headers: bearer(token) });

/** owner 가 초대하고 bee 가 가입한다 — 가입 세션을 돌려준다 */
async function join(
  a: App,
  ownerHeaders: Record<string, string>,
  over: Record<string, unknown> = {},
): Promise<{ sessionToken: string; user: User }> {
  const issued = IssuedInvite.parse(
    (
      await a.fastify.inject({
        method: "POST",
        url: "/api/v1/invites",
        headers: ownerHeaders,
        payload: { role: "member" },
      })
    ).json(),
  );
  const res = await a.fastify.inject({
    method: "POST",
    url: "/api/v1/invites/accept",
    payload: {
      token: issued.token,
      handle: "bee",
      displayName: "Bee",
      email: "bee@example.com",
      password: PASSWORD,
      ...over,
    },
  });
  if (res.statusCode !== 200) throw new Error(`join 실패: ${res.statusCode} ${res.body}`);
  return res.json() as { sessionToken: string; user: User };
}

const roomy = { limits: { localLoginPerMin: 100 } };

describe("POST /api/v1/auth/local 두 모양", () => {
  it("{token} owner 는 그대로, {email,password} 멤버 성공 — 응답 모양이 같다", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const joined = await join(app, owner.headers);

    const res = await local(app, { email: "BEE@example.com", password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessionToken: string; user: User };
    expect(Object.keys(body).sort()).toEqual(["sessionToken", "user"]);
    expect(body.user).toEqual(joined.user);
    expect(res.cookies.find((c) => c.name === "dodok.session")?.value).toBe(body.sessionToken);
    expect((await me(app, body.sessionToken)).json()).toMatchObject({ role: "member" });

    const ownerRes = await local(app, { token: TEST_LOCAL_TOKEN });
    expect(ownerRes.statusCode).toBe(200);
    expect((ownerRes.json() as { user: User }).user.id).toBe(app.ownerUserId);
  });

  it("틀린 비밀번호·없는 이메일·OWNER_EMAIL(맞는 토큰이어도)·membership 없는 사용자는 같은 401 문구", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const joined = await join(app, owner.headers);

    const wrong = await local(app, { email: "bee@example.com", password: "wrong-password-here" });
    const missing = await local(app, { email: "nobody@example.com", password: PASSWORD });
    const ownerEmail = await local(app, { email: "owner@dodok.local", password: TEST_LOCAL_TOKEN });
    // 대소문자만 다른 OWNER_EMAIL — Better Auth 는 이메일을 스스로 소문자로 바꾸므로, 우리 쪽 정규화가
    // 빠지면 대문자 owner 이메일 + 로컬 토큰으로 이메일 로그인이 될 수 있다(signInMember 의 normalizeEmail)
    const ownerEmailUpper = await local(app, { email: "OWNER@dodok.local", password: TEST_LOCAL_TOKEN });
    for (const res of [wrong, missing, ownerEmail, ownerEmailUpper]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(WRONG_LOGIN);
    }

    app.db
      .delete(memberships)
      .where(and(eq(memberships.workspaceId, app.workspaceId), eq(memberships.userId, joined.user.id)))
      .run();
    const sessionsBefore = app.db
      .select()
      .from(authSession)
      .where(eq(authSession.userId, joined.user.id))
      .all().length;
    const noMembership = await local(app, { email: "bee@example.com", password: PASSWORD });
    expect(noMembership.statusCode).toBe(401);
    expect(noMembership.json()).toEqual(WRONG_LOGIN);
    // 막힌 로그인은 세션을 남기지 않는다
    expect(app.db.select().from(authSession).where(eq(authSession.userId, joined.user.id)).all().length).toBe(
      sessionsBefore,
    );

    // 토큰 모양은 지금 문구 그대로
    expect((await local(app, { token: "wrong-token-xxxx" })).json()).toEqual({
      code: "UNAUTHORIZED",
      message: "토큰이 맞지 않는다",
    });
  });

  it("두 모양이 섞이거나 비었으면 400", async () => {
    app = await bootTestApp({}, roomy);
    for (const payload of [
      {},
      { token: TEST_LOCAL_TOKEN, email: "bee@example.com", password: PASSWORD },
      { email: "bee@example.com" },
      { email: "not-email", password: PASSWORD },
    ]) {
      const res = await local(app, payload);
      expect(res.statusCode, JSON.stringify(Object.keys(payload))).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION" });
    }
  });

  it("로그인·조회·수락·재설정이 IP 버킷 하나를 같이 쓴다", async () => {
    app = await bootTestApp({}, { limits: { localLoginPerMin: 4 } });
    const owner = await login(app); // 1
    expect(
      (
        await app.fastify.inject({
          method: "POST",
          url: "/api/v1/invites/lookup",
          payload: { token: "dit_x" },
        })
      ).statusCode,
    ).toBe(404); // 2
    expect(
      (await app.fastify.inject({ method: "POST", url: "/api/v1/invites/accept", payload: {} })).statusCode,
    ).toBe(400); // 3
    expect(
      (await app.fastify.inject({ method: "POST", url: "/api/v1/invites/reset", payload: {} })).statusCode,
    ).toBe(400); // 4
    const fifth = await local(app, { email: "bee@example.com", password: PASSWORD });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(owner.token).toEqual(expect.any(String));
  });

  it("me/password 도 같은 IP 버킷을 쓴다 — 상한을 넘기면 /auth/local 이 429", async () => {
    app = await bootTestApp({}, { limits: { localLoginPerMin: 3 } });
    const owner = await login(app); // 1
    const change = () =>
      app!.fastify.inject({
        method: "POST",
        url: "/api/v1/me/password",
        headers: bearer(owner.token),
        payload: {},
      });
    // owner 는 비밀번호를 못 바꿔 403 이지만, onRequest 의 loginLimit 은 핸들러보다 먼저 센다
    expect((await change()).statusCode).toBe(403); // 2
    expect((await change()).statusCode).toBe(403); // 3
    const fourth = await local(app, { token: TEST_LOCAL_TOKEN });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("「내 계정」", () => {
  it("PATCH /me 는 표시 이름을 바꾼다", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const joined = await join(app, owner.headers);
    const res = await app.fastify.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: bearer(joined.sessionToken),
      payload: { displayName: "  Queen Bee  " },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { user: User }).user.displayName).toBe("Queen Bee");
    expect((await me(app, joined.sessionToken)).json()).toMatchObject({ user: { displayName: "Queen Bee" } });
    const bad = await app.fastify.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: bearer(joined.sessionToken),
      payload: { displayName: "" },
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (await app.fastify.inject({ method: "PATCH", url: "/api/v1/me", payload: { displayName: "x" } }))
        .statusCode,
    ).toBe(401);
  });

  it("me/password — 현재 비밀번호가 틀리면 400 field:current, 맞으면 바꾸고 이 세션만 남는다, owner 403", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const joined = await join(app, owner.headers);
    const other = (await local(app, { email: "bee@example.com", password: PASSWORD })).json() as {
      sessionToken: string;
    };
    const change = (token: string, payload: Record<string, unknown>) =>
      app!.fastify.inject({ method: "POST", url: "/api/v1/me/password", headers: bearer(token), payload });

    const wrong = await change(joined.sessionToken, {
      current: "not-my-password",
      next: "next-password-123",
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: "VALIDATION", details: { field: "current" } });
    expect((await me(app, other.sessionToken)).statusCode).toBe(200);

    const short = await change(joined.sessionToken, { current: PASSWORD, next: "short" });
    expect(short.statusCode).toBe(400);

    const ok = await change(joined.sessionToken, { current: PASSWORD, next: "next-password-123" });
    expect(ok.statusCode).toBe(204);
    expect((await me(app, joined.sessionToken)).statusCode).toBe(200);
    expect((await me(app, other.sessionToken)).statusCode).toBe(401);
    expect((await local(app, { email: "bee@example.com", password: PASSWORD })).statusCode).toBe(401);
    expect((await local(app, { email: "bee@example.com", password: "next-password-123" })).statusCode).toBe(
      200,
    );

    const ownerChange = await change(owner.token, { current: TEST_LOCAL_TOKEN, next: "next-password-123" });
    expect(ownerChange.statusCode).toBe(403);
    expect((await local(app, { token: TEST_LOCAL_TOKEN })).statusCode).toBe(200);
  });
});

describe("로그 위생", () => {
  it("발급·조회·수락·재설정·로그인 실패·비밀번호 변경 전 과정의 로그에 원문 토큰·비밀번호·이메일이 없다", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
    app = await bootTestApp({}, { ...roomy, logger });
    const owner = await login(app);
    const email = "Secret.Bee@example.com";
    const issued = IssuedInvite.parse(
      (
        await app.fastify.inject({
          method: "POST",
          url: "/api/v1/invites",
          headers: owner.headers,
          payload: { role: "member" },
        })
      ).json(),
    );
    await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/lookup",
      payload: { token: issued.token },
    });
    const joined = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/accept",
      payload: { token: issued.token, handle: "bee", displayName: "Bee", email, password: PASSWORD },
    });
    expect(joined.statusCode).toBe(200);
    const { sessionToken, user } = joined.json() as { sessionToken: string; user: User };
    // 재사용(404)·중복(409) 실패 경로도 지난다
    await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/accept",
      payload: { token: issued.token, handle: "bee", displayName: "Bee", email, password: PASSWORD },
    });
    const link = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/members/${user.id}/reset-link`,
      headers: owner.headers,
    });
    const resetToken = (link.json() as { token: string }).token;
    const nextPassword = "reset-password-secret-9";
    expect(
      (
        await app.fastify.inject({
          method: "POST",
          url: "/api/v1/invites/reset",
          payload: { token: resetToken, password: nextPassword },
        })
      ).statusCode,
    ).toBe(200);
    const wrongPassword = "wrong-password-secret-7";
    expect((await local(app, { email, password: wrongPassword })).statusCode).toBe(401);
    expect(
      (await local(app, { email: "nobody.secret@example.com", password: wrongPassword })).statusCode,
    ).toBe(401);
    const relogin = (await local(app, { email, password: nextPassword })).json() as { sessionToken: string };
    const finalPassword = "final-password-secret-5";
    await app.fastify.inject({
      method: "POST",
      url: "/api/v1/me/password",
      headers: bearer(relogin.sessionToken),
      payload: { current: nextPassword, next: finalPassword },
    });

    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join("\n");
    for (const secret of [
      issued.token,
      resetToken,
      sessionToken,
      PASSWORD,
      nextPassword,
      wrongPassword,
      finalPassword,
      email,
      email.toLowerCase(),
      "nobody.secret@example.com",
    ]) {
      expect(text, secret.slice(0, 6)).not.toContain(secret);
    }
  });
});
