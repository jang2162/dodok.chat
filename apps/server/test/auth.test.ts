import { User } from "@dodok/shared";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import pino from "pino";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { OWNER_EMAIL, verifySessionToken } from "../src/auth";
import { account, session, user } from "../src/db/auth-schema";
import { memberships, users } from "../src/db/schema.sqlite";
import { bootTestApp, login, TEST_LOCAL_TOKEN } from "./helpers/app";

let app: App | undefined;
let tmpDir: string | undefined;
afterEach(async () => {
  await app?.close();
  if (tmpDir) {
    app?.db.$client.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
  app = undefined;
  tmpDir = undefined;
});

const local = (a: App, token: unknown) =>
  a.fastify.inject({ method: "POST", url: "/api/v1/auth/local", payload: { token } });

describe("auth", () => {
  it("첫 부팅에 owner 가 만들어지고 로컬 토큰으로 로그인하면 sessionToken 이 온다", async () => {
    app = await bootTestApp();
    const bad = await local(app, "wrong-wrong-wrong-1");
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ code: "UNAUTHORIZED", message: expect.any(String) });

    const ok = await local(app, TEST_LOCAL_TOKEN);
    expect(ok.statusCode).toBe(200);
    const { sessionToken, user: me } = ok.json();
    expect(User.parse(me)).toEqual(me);
    expect(me).toMatchObject({ id: app.ownerUserId, workspaceId: app.workspaceId, handle: "owner" });
    expect(sessionToken).toEqual(expect.any(String));
    const cookie = ok.cookies.find((c) => c.name === "dodok.session");
    expect(cookie).toMatchObject({ value: sessionToken, httpOnly: true, path: "/", sameSite: "Lax" });
    expect(cookie?.secure).toBeFalsy();

    const res = await app.fastify.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: me,
      workspaceId: app.workspaceId,
      workspace: { id: app.workspaceId, name: "dodok" },
      role: "owner",
    });
    // sessionId 는 세션 행의 id 다 — 토큰 원문이 아니다(wire 소켓이 socket.data 에 둔다)
    const row = app.db.select().from(session).where(eq(session.token, sessionToken)).get();
    expect(await verifySessionToken(app.auth, sessionToken)).toEqual({ userId: me.id, sessionId: row?.id });
    expect(row?.id).not.toBe(sessionToken);
    expect(await verifySessionToken(app.auth, "nope")).toBeNull();
    // 헤더 값이 될 수 없는 입력도 예외가 아니라 null (wire auth.token 은 임의 유니코드)
    expect(await verifySessionToken(app.auth, "토큰")).toBeNull();
    expect(await verifySessionToken(app.auth, "a\nb")).toBeNull();
  });

  it("owner 는 Better Auth user·credential account 와 users·memberships(owner) 에 같은 id 로 한 번만 생긴다", async () => {
    app = await bootTestApp();
    const id = app.ownerUserId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(app.db.select().from(user).all()).toEqual([
      expect.objectContaining({ id, email: OWNER_EMAIL, name: "owner", emailVerified: true }),
    ]);
    const accounts = app.db.select().from(account).all();
    expect(accounts).toEqual([
      expect.objectContaining({ userId: id, providerId: "credential", accountId: id }),
    ]);
    expect(accounts[0]?.password).not.toContain(TEST_LOCAL_TOKEN);
    expect(app.db.select().from(users).all()).toEqual([
      expect.objectContaining({
        id,
        workspaceId: app.workspaceId,
        handle: "owner",
        displayName: "owner",
        email: OWNER_EMAIL,
        authProvider: "local",
      }),
    ]);
    expect(app.db.select().from(memberships).all()).toEqual([
      expect.objectContaining({ workspaceId: app.workspaceId, userId: id, role: "owner" }),
    ]);
  });

  it("인증 없는 REST 는 401 ApiError", async () => {
    app = await bootTestApp();
    const none = await app.fastify.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ code: "UNAUTHORIZED", message: expect.any(String) });
    const wrong = await app.fastify.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: "Bearer not-a-session" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ code: "UNAUTHORIZED", message: expect.any(String) });
  });

  it("dodok.session 쿠키로도 인증되고, 로그아웃하면 그 세션은 더 이상 통하지 않는다", async () => {
    app = await bootTestApp();
    const { token } = await login(app);
    const cookieHeaders = { cookie: `dodok.session=${token}` };
    const me = await app.fastify.inject({ method: "GET", url: "/api/v1/auth/me", headers: cookieHeaders });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(app.ownerUserId);

    const out = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: cookieHeaders,
    });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ ok: true });
    expect(out.cookies.find((c) => c.name === "dodok.session")?.value).toBe("");

    expect(await verifySessionToken(app.auth, token)).toBeNull();
    const after = await app.fastify.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it("토큰이 바뀌면 다음 부팅에서 owner 비밀번호가 갱신되고 기존 세션은 끊긴다", async () => {
    tmpDir = join(tmpdir(), `dodok-auth-${uuidv7()}`);
    mkdirSync(tmpDir);
    const DB_PATH = join(tmpDir, "dodok.sqlite");

    const first = await bootTestApp({ DB_PATH });
    const ownerId = first.ownerUserId;
    const oldSession = (await local(first, TEST_LOCAL_TOKEN)).json().sessionToken as string;
    expect(await verifySessionToken(first.auth, oldSession)).toMatchObject({ userId: ownerId });
    await first.close();
    first.db.$client.close();

    const NEW_TOKEN = "n".repeat(20);
    app = await bootTestApp({ DB_PATH, LOCAL_AUTH_TOKEN: NEW_TOKEN });
    expect(app.ownerUserId).toBe(ownerId);
    // 토큰을 바꾼 건 옛 토큰을 버린다는 뜻 — 그 토큰으로 만든 세션도 끊는다
    expect(await verifySessionToken(app.auth, oldSession)).toBeNull();
    expect((await local(app, TEST_LOCAL_TOKEN)).statusCode).toBe(401);
    const ok = await local(app, NEW_TOKEN);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.id).toBe(ownerId);
    expect(app.db.select().from(user).all()).toHaveLength(1);
    expect(app.db.select().from(users).all()).toHaveLength(1);
    expect(app.db.select().from(memberships).all()).toHaveLength(1);
  });

  it("owner 외에는 가입할 수 없고, Better Auth 의 이메일 사인인은 HTTP 로 열려 있지 않다", async () => {
    app = await bootTestApp();
    const signUp = await app.fastify.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: "http://localhost:5173" },
      payload: { email: "intruder@example.com", password: "p".repeat(20), name: "intruder" },
    });
    expect(signUp.statusCode).toBeGreaterThanOrEqual(400);
    expect(signUp.statusCode).toBeLessThan(500);
    expect(signUp.body).toContain("EMAIL_PASSWORD_SIGN_UP_DISABLED");
    expect(app.db.select().from(user).all()).toHaveLength(1);

    // 레이트리밋이 걸린 /api/v1/auth/local 을 우회해 토큰을 대입하지 못하게
    const signIn = await app.fastify.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: "http://localhost:5173" },
      payload: { email: OWNER_EMAIL, password: TEST_LOCAL_TOKEN },
    });
    expect(signIn.statusCode).toBe(404);
  });

  it("Better Auth 의 비밀번호·프로필 변경 경로는 HTTP 로 열려 있지 않다", async () => {
    app = await bootTestApp();
    const { headers } = await login(app);
    for (const url of ["/api/auth/change-password", "/api/auth/update-user"]) {
      const res = await app.fastify.inject({
        method: "POST",
        url,
        headers: { ...headers, "content-type": "application/json" },
        payload: { currentPassword: TEST_LOCAL_TOKEN, newPassword: "y".repeat(20), name: "x" },
      });
      expect(res.statusCode, url).toBe(404);
    }
  });
  it("Better Auth 의 세션 폐기·로그아웃 경로는 HTTP 로 열려 있지 않다 — 세션은 우리 경로만 지운다(소켓 끊기와 함께)", async () => {
    app = await bootTestApp();
    const { token, headers } = await login(app);
    const session = await verifySessionToken(app.auth, token);
    for (const url of [
      "/api/auth/revoke-session",
      "/api/auth/revoke-sessions",
      "/api/auth/revoke-other-sessions",
      "/api/auth/sign-out",
    ]) {
      const res = await app.fastify.inject({
        method: "POST",
        url,
        headers: { ...headers, origin: "http://localhost:5173", "content-type": "application/json" },
        payload: { token },
      });
      expect(res.statusCode, url).toBe(404);
    }
    expect(await verifySessionToken(app.auth, token)).toEqual(session);
  });
  it("/api/v1/auth/local 은 1분에 5회까지, 6번째는 429 RATE_LIMITED", async () => {
    app = await bootTestApp();
    for (let i = 0; i < 5; i++) expect((await local(app, `wrong-token-${i}-xxxxxx`)).statusCode).toBe(401);
    const sixth = await local(app, TEST_LOCAL_TOKEN);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toEqual({ code: "RATE_LIMITED", message: expect.any(String) });
  });

  it("잘못된 본문은 400 VALIDATION 이고, 실패한 토큰 값은 로그에 남지 않는다", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "trace" }, { write: (line: string) => void lines.push(line) });
    app = await bootTestApp({}, { logger });
    const missing = await app.fastify.inject({ method: "POST", url: "/api/v1/auth/local", payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ code: "VALIDATION", message: expect.any(String) });

    const secret = "leak-check-token-0123456789";
    expect((await local(app, secret)).statusCode).toBe(401);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(secret);
  });

  it("토큰 불일치가 아닌 사인인 실패(DB 등)는 401 로 뭉개지 않고 500 INTERNAL", async () => {
    app = await bootTestApp();
    vi.spyOn(app.auth.api, "signInEmail").mockRejectedValueOnce(new Error("disk I/O error"));
    const res = await local(app, TEST_LOCAL_TOKEN);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: "INTERNAL", message: expect.any(String) });
  });

  it("GET /auth/me 의 workspace.name 은 설정한 워크스페이스 이름이다", async () => {
    app = await bootTestApp({ DODOK_WORKSPACE_NAME: "우리 팀" });
    const { headers } = await login(app);
    const res = await app.fastify.inject({ method: "GET", url: "/api/v1/auth/me", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().workspace).toEqual({ id: app.workspaceId, name: "우리 팀" });
  });

  it("APP_ORIGIN 이 https 면 세션 쿠키에 Secure 를 붙인다", async () => {
    app = await bootTestApp({ APP_ORIGIN: "https://chat.example.com" });
    const res = await local(app, TEST_LOCAL_TOKEN);
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "dodok.session");
    expect(cookie).toMatchObject({ value: res.json().sessionToken, secure: true });
  });
});
