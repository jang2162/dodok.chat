import { IssuedInvite, User, WIRE_PROTOCOL } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import pino from "pino";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { session as authSession } from "../src/db/auth-schema";
import { memberships } from "../src/db/schema.sqlite";
import { bootTestApp, login, TEST_LOCAL_TOKEN } from "./helpers/app";
import { connectWire, openWire } from "./helpers/wire";

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

/**
 * app.io.in 을 감싸 호출마다 그 룸이 가리키는 세션 행이 그 순간 몇 개 있는지 남긴다(지우기 → 끊기 순서 확인 — m5·T2).
 * 소켓을 실제로 연결하지 않아도 disconnectUser·disconnectSessions·연결 미들웨어는 모두 io.in 을 거친다.
 */
function watchSessionRoomCalls(a: App): { room: string; sessionRows: number }[] {
  const snapshots: { room: string; sessionRows: number }[] = [];
  const originalIn = a.io.in.bind(a.io);
  vi.spyOn(a.io, "in").mockImplementation((room) => {
    for (const r of Array.isArray(room) ? room : [room]) {
      if (r.startsWith("session:")) {
        const id = r.slice("session:".length);
        snapshots.push({
          room: r,
          sessionRows: a.db.select().from(authSession).where(eq(authSession.id, id)).all().length,
        });
      } else if (r.startsWith("user:")) {
        const userId = r.slice("user:".length);
        snapshots.push({
          room: r,
          sessionRows: a.db.select().from(authSession).where(eq(authSession.userId, userId)).all().length,
        });
      }
    }
    return originalIn(room);
  });
  return snapshots;
}

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

  it("로그인 버킷(localLoginPerMin)이 차도 초대 경로는 된다 — 조회·수락·재설정은 자기 IP 버킷", async () => {
    app = await bootTestApp();
    const owner = await login(app); // 로그인 버킷 1
    for (let i = 0; i < 4; i++) {
      expect((await local(app, { email: "bee@example.com", password: PASSWORD })).statusCode).toBe(401);
    }
    const sixth = await local(app, { email: "bee@example.com", password: PASSWORD });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json()).toMatchObject({ code: "RATE_LIMITED" });
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
    const lookup = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/lookup",
      payload: { token: issued.token },
    });
    expect(lookup.statusCode).toBe(200);
  });

  it("조회·수락·재설정이 한 IP 버킷(invitePublicPerMin 20)을 같이 쓴다 — 21번째는 429, 로그인 버킷은 그대로 5", async () => {
    app = await bootTestApp();
    const paths = ["/api/v1/invites/lookup", "/api/v1/invites/accept", "/api/v1/invites/reset"];
    for (let i = 0; i < 20; i++) {
      const res = await app.fastify.inject({ method: "POST", url: paths[i % 3]!, payload: {} });
      expect(res.statusCode, `${i + 1}번째`).toBe(400);
    }
    for (const url of paths) {
      const res = await app.fastify.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode, url).toBe(429);
      expect(res.json()).toMatchObject({ code: "RATE_LIMITED" });
    }
    // 초대 경로가 다 써도 로그인은 자기 5회를 그대로 갖는다
    for (let i = 0; i < 5; i++) {
      expect((await local(app, { email: "bee@example.com", password: PASSWORD })).statusCode).toBe(401);
    }
    expect((await local(app, { email: "bee@example.com", password: PASSWORD })).statusCode).toBe(429);
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

  it("me/password — 지운 세션의 열린 wire 소켓만 서버가 끊고, 이 세션의 소켓은 남는다", async () => {
    app = await bootTestApp({}, roomy);
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const owner = await login(app);
    const joined = await join(app, owner.headers);
    const other = (await local(app, { email: "bee@example.com", password: PASSWORD })).json() as {
      sessionToken: string;
    };
    const kept = [await connectWire(app, joined.sessionToken), await connectWire(app, joined.sessionToken)];
    const cut = [await connectWire(app, other.sessionToken), await connectWire(app, other.sessionToken)];
    try {
      const reasons = cut.map((s) => new Promise<string>((resolve) => s.once("disconnect", resolve)));
      const res = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/me/password",
        headers: bearer(joined.sessionToken),
        payload: { current: PASSWORD, next: "next-password-123" },
      });
      expect(res.statusCode).toBe(204);
      expect(await Promise.all(reasons)).toEqual(["io server disconnect", "io server disconnect"]);
      await expect(connectWire(app, other.sessionToken)).rejects.toMatchObject({
        data: { code: "UNAUTHORIZED" },
      });
      // 같은 연결의 ack 왕복 — 끊기가 이미 지나갔어도 이 세션의 소켓은 살아서 답한다
      for (const socket of kept) {
        expect(socket.connected).toBe(true);
        const ack = await new Promise<{ ok: boolean }>((resolve) =>
          socket.emit("channel.unsubscribe", { channelId: uuidv7() }, resolve),
        );
        expect(ack.ok).toBe(true);
      }
    } finally {
      for (const s of [...kept, ...cut]) s.close();
    }
  });

  it("me/password — 세션이 하나뿐이면(끊을 세션 없음) 아무 소켓도 끊지 않는다 — 빈 목록 가드가 없으면 io.in([]) 이 전체를 끊는다", async () => {
    app = await bootTestApp({}, roomy);
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const owner = await login(app);
    const joined = await join(app, owner.headers);
    // joined.sessionToken 이 이 멤버의 유일한 세션이다 — changePassword 의 others 가 빈 배열이 된다
    const ownerSocket = await connectWire(app, owner.token);
    const memberSocket = await connectWire(app, joined.sessionToken);
    try {
      const res = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/me/password",
        headers: bearer(joined.sessionToken),
        payload: { current: PASSWORD, next: "next-password-123" },
      });
      expect(res.statusCode).toBe(204);
      for (const socket of [ownerSocket, memberSocket]) {
        const early = await Promise.race([
          new Promise<string>((resolve) => socket.once("disconnect", resolve)),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
        ]);
        expect(early).toBeNull();
        expect(socket.connected).toBe(true);
        const ack = await new Promise<{ ok: boolean }>((resolve) =>
          socket.emit("channel.unsubscribe", { channelId: uuidv7() }, resolve),
        );
        expect(ack.ok).toBe(true);
      }
    } finally {
      for (const s of [ownerSocket, memberSocket]) s.close();
    }
  });

  it("로그아웃 — 그 세션의 열린 wire 소켓(같은 쿠키를 쓰는 다른 탭 포함)을 모두 끊고, 다른 세션의 소켓은 남는다", async () => {
    app = await bootTestApp({}, roomy);
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const owner = await login(app);
    const joined = await join(app, owner.headers);
    const other = (await local(app, { email: "bee@example.com", password: PASSWORD })).json() as {
      sessionToken: string;
    };
    const cut = [await connectWire(app, joined.sessionToken), await connectWire(app, joined.sessionToken)];
    const kept = await connectWire(app, other.sessionToken);
    try {
      const reasons = cut.map((s) => new Promise<string>((resolve) => s.once("disconnect", resolve)));
      const res = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: { cookie: `dodok.session=${joined.sessionToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(await Promise.all(reasons)).toEqual(["io server disconnect", "io server disconnect"]);
      const ack = await new Promise<{ ok: boolean }>((resolve) =>
        kept.emit("channel.unsubscribe", { channelId: uuidv7() }, resolve),
      );
      expect(ack.ok).toBe(true);
    } finally {
      for (const s of [...cut, kept]) s.close();
    }
  });

  it("핸드셰이크를 지나는 사이 세션이 지워지면 connection 에서 끊는다", async () => {
    app = await bootTestApp({}, roomy);
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const owner = await login(app);
    const joined = await join(app, owner.headers);
    const db = app.db;
    // attachWire 의 인증 미들웨어 뒤에 붙는다 — 세션은 확인했고 방에는 아직 안 들어간 틈을 흉내 낸다
    app.io.use((socket, next) => {
      if (socket.data.userId === joined.user.id) {
        db.delete(authSession).where(eq(authSession.userId, joined.user.id)).run();
      }
      next();
    });
    const socket = openWire(app, { token: joined.sessionToken, protocol: WIRE_PROTOCOL });
    try {
      expect(await new Promise<string>((resolve) => socket.once("disconnect", resolve))).toBe(
        "io server disconnect",
      );
    } finally {
      socket.close();
    }
  });

  it("재설정 — 소켓을 끊는 순간엔 이미 그 사용자의 세션 행이 없다(지우기 → 끊기 순서)", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const joined = await join(app, owner.headers);
    const snapshots = watchSessionRoomCalls(app);
    const link = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/members/${joined.user.id}/reset-link`,
      headers: owner.headers,
    });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/invites/reset",
      payload: { token: (link.json() as { token: string }).token, password: "brand-new-password-42" },
    });
    expect(res.statusCode).toBe(200);
    const hit = snapshots.find((s) => s.room === `user:${joined.user.id}`);
    expect(hit).toBeDefined();
    expect(hit?.sessionRows).toBe(0);
  });

  it("me/password — 소켓을 끊는 순간엔 이미 그 세션 행이 없다(지우기 → 끊기 순서)", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const joined = await join(app, owner.headers);
    const other = (await local(app, { email: "bee@example.com", password: PASSWORD })).json() as {
      sessionToken: string;
    };
    const otherSessionId = app.db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.token, other.sessionToken))
      .get()?.id;
    if (!otherSessionId) throw new Error("세션 행을 못 찾았다");
    const snapshots = watchSessionRoomCalls(app);
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/me/password",
      headers: bearer(joined.sessionToken),
      payload: { current: PASSWORD, next: "next-password-123" },
    });
    expect(res.statusCode).toBe(204);
    const hit = snapshots.find((s) => s.room === `session:${otherSessionId}`);
    expect(hit).toBeDefined();
    expect(hit?.sessionRows).toBe(0);
  });

  it("로그아웃 — 소켓을 끊는 순간엔 이미 그 세션 행이 없다(지우기 → 끊기 순서)", async () => {
    app = await bootTestApp({}, roomy);
    const owner = await login(app);
    const joined = await join(app, owner.headers);
    const sessionId = app.db
      .select({ id: authSession.id })
      .from(authSession)
      .where(eq(authSession.token, joined.sessionToken))
      .get()?.id;
    if (!sessionId) throw new Error("세션 행을 못 찾았다");
    const snapshots = watchSessionRoomCalls(app);
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: `dodok.session=${joined.sessionToken}` },
    });
    expect(res.statusCode).toBe(200);
    const hit = snapshots.find((s) => s.room === `session:${sessionId}`);
    expect(hit).toBeDefined();
    expect(hit?.sessionRows).toBe(0);
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

describe("Better Auth 세션의 클라이언트 IP — 서버의 신뢰 프록시 판정(request.ip)과 같다", () => {
  const ipOf = (a: App, token: string) =>
    a.db.select({ ip: authSession.ipAddress }).from(authSession).where(eq(authSession.token, token)).get()
      ?.ip;
  const signIn = (a: App, remoteAddress: string, headers: Record<string, string>) =>
    a.fastify.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      remoteAddress,
      headers,
      payload: { token: TEST_LOCAL_TOKEN },
    });

  it("믿는 프록시가 없으면 꾸민 X-Forwarded-For·내부 헤더를 버리고 실제 연결 주소", async () => {
    app = await bootTestApp();
    const res = await signIn(app, "203.0.113.50", {
      "x-forwarded-for": "1.2.3.4",
      "x-dodok-client-ip": "5.6.7.8",
    });
    expect(res.statusCode).toBe(200);
    expect(ipOf(app, res.json().sessionToken)).toBe("203.0.113.50");
  });

  it("믿는 프록시 뒤면 그 프록시가 덧붙인 오른쪽 값 — 클라이언트가 꾸민 왼쪽 값이 아니다", async () => {
    app = await bootTestApp({ TRUST_PROXY: "203.0.113.50/32" });
    const res = await signIn(app, "203.0.113.50", {
      "x-forwarded-for": "1.2.3.4, 198.51.100.9",
      "x-dodok-client-ip": "5.6.7.8",
    });
    expect(res.statusCode).toBe(200);
    expect(ipOf(app, res.json().sessionToken)).toBe("198.51.100.9");
  });
});
