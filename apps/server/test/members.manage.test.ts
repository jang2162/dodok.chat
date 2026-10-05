import { IssuedInvite, type MemberRow, type Person } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { invites, memberships, users } from "../src/db/schema.sqlite";
import { findValidInvite } from "../src/modules/members/invites";
import { changeRole } from "../src/modules/members/service";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { connectWire, recordEvents, type WireClient } from "./helpers/wire";

// 멤버 관리(팀 스펙 「멤버 관리」 절) — 목록·역할 바꾸기, 그리고 에이전트 등록 쪽 핸들 유일(Review Focus 2 반대쪽).
// 비활성화·다시 활성화는 members.deactivate.test.ts

describe("멤버 관리 REST", () => {
  let app: App;
  let ownerToken: string;
  const sockets: WireClient[] = [];
  let n = 0;

  beforeAll(async () => {
    // 조회·수락·재설정(초대 경로 IP 버킷)과 로그인을 이 파일이 여러 번 부른다
    app = await bootTestApp({}, { limits: { localLoginPerMin: 1000, invitePublicPerMin: 1000 } });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    ownerToken = (await login(app)).token;
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (token: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.fastify.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
  /** 역할을 준 새 사용자 — 이메일도 우리 행에 싣는다 */
  const person = async (role: "admin" | "member", prefix = role) => {
    const handle = `${prefix}${++n}`;
    const user = await userWithRole(app, handle, role);
    app.db
      .update(users)
      .set({ email: `${handle}@dodok.local` })
      .where(eq(users.id, user.id))
      .run();
    return { ...user, handle, email: `${handle}@dodok.local` };
  };
  const wire = async (token: string) => {
    const socket = await connectWire(app, token);
    sockets.push(socket);
    return socket;
  };
  const open = (url: string, payload: object) => app.fastify.inject({ method: "POST", url, payload });
  const PASSWORD = "correct-horse-battery";
  /** 초대 링크를 발급하고 원문 토큰을 낸다 */
  const issueInvite = async (token: string) => {
    const res = await call(token, "POST", "/api/v1/invites", { role: "member" });
    expect(res.statusCode).toBe(201);
    return IssuedInvite.parse(res.json()).token;
  };
  const issueReset = async (token: string, userId: string) => {
    const res = await call(token, "POST", `/api/v1/members/${userId}/reset-link`);
    expect(res.statusCode).toBe(201);
    return IssuedInvite.parse(res.json()).token;
  };
  const joinBody = (token: string, handle: string, email = `${handle}@example.com`) => ({
    token,
    handle,
    displayName: handle,
    email,
    password: PASSWORD,
  });
  /** 같은 연결의 ack 왕복 — 앞서 보낸 서버 이벤트가 이미 도착했음을 보장한다 */
  const roundTrip = (socket: WireClient) =>
    new Promise<void>((resolve) =>
      socket.emit("channel.unsubscribe", { channelId: uuid() }, () => resolve()),
    );

  describe("GET /members", () => {
    it("admin 은 멤버 표를 받는다 — 역할·이메일·가입 시각, 비활성 멤버도 deactivatedAt 과 함께", async () => {
      const admin = await person("admin");
      const member = await person("member");
      const res = await call(admin.token, "GET", "/api/v1/members");
      expect(res.statusCode).toBe(200);
      const rows = (res.json() as { members: MemberRow[] }).members;
      const mine = rows.find((r) => r.id === member.id);
      expect(mine).toMatchObject({ handle: member.handle, role: "member", email: member.email });
      expect(typeof mine?.createdAt).toBe("string");
      expect(rows.find((r) => r.id === app.ownerUserId)?.role).toBe("owner");

      expect(mine?.deactivatedAt).toBeNull();

      expect((await call(admin.token, "POST", `/api/v1/members/${member.id}/deactivate`)).statusCode).toBe(
        200,
      );
      const after = (await call(admin.token, "GET", "/api/v1/members")).json() as { members: MemberRow[] };
      expect(after.members.find((r) => r.id === member.id)?.deactivatedAt).toEqual(expect.any(String));
    });

    it("member 는 403", async () => {
      const member = await person("member");
      const res = await call(member.token, "GET", "/api/v1/members");
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("PATCH /members/:userId", () => {
    it("owner 가 member 를 admin 으로 — 그 세션의 다음 요청부터 admin 이다", async () => {
      const member = await person("member");
      expect((await call(member.token, "GET", "/api/v1/members")).statusCode).toBe(403);
      const res = await call(ownerToken, "PATCH", `/api/v1/members/${member.id}`, { role: "admin" });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { member: MemberRow }).member).toMatchObject({ id: member.id, role: "admin" });
      expect((await call(member.token, "GET", "/api/v1/members")).statusCode).toBe(200);

      const down = await call(ownerToken, "PATCH", `/api/v1/members/${member.id}`, { role: "member" });
      expect(down.statusCode).toBe(200);
      expect((await call(member.token, "GET", "/api/v1/members")).statusCode).toBe(403);
    });

    it("admin 은 역할을 못 바꾼다(403)", async () => {
      const admin = await person("admin");
      const member = await person("member");
      const res = await call(admin.token, "PATCH", `/api/v1/members/${member.id}`, { role: "admin" });
      expect(res.statusCode).toBe(403);
      expect(app.db.select().from(memberships).where(eq(memberships.userId, member.id)).get()?.role).toBe(
        "member",
      );
    });

    it("owner 대상은 403 — owner 자신도", async () => {
      const res = await call(ownerToken, "PATCH", `/api/v1/members/${app.ownerUserId}`, { role: "member" });
      expect(res.statusCode).toBe(403);
      expect(
        app.db.select().from(memberships).where(eq(memberships.userId, app.ownerUserId)).get()?.role,
      ).toBe("owner");
    });

    it("owner 로 올리기는 본문에서 거절(400), 없는 사용자는 404", async () => {
      const member = await person("member");
      expect(
        (await call(ownerToken, "PATCH", `/api/v1/members/${member.id}`, { role: "owner" })).statusCode,
      ).toBe(400);
      expect(
        (await call(ownerToken, "PATCH", `/api/v1/members/${uuid()}`, { role: "admin" })).statusCode,
      ).toBe(404);
    });

    it("admin 을 member 로 내리면 그 사람이 발급한 쓰이지 않은 링크가 폐기된다 — admin 을 admin 으로 두면 그대로, 이미 수락이 끝난 링크는 그대로", async () => {
      const admin = await person("admin");
      const kept = await person("admin");
      const member = await person("member");
      const invite = await issueInvite(admin.token);
      const reset = await issueReset(admin.token, member.id);
      const keptInvite = await issueInvite(kept.token);
      const used = await issueInvite(admin.token);
      const usedRow = findValidInvite(app.db, used, new Date());
      if (!usedRow) throw new Error("invite not found");
      expect((await open("/api/v1/invites/accept", joinBody(used, `used${++n}`))).statusCode).toBe(200);

      expect(
        (await call(ownerToken, "PATCH", `/api/v1/members/${admin.id}`, { role: "member" })).statusCode,
      ).toBe(200);
      expect(
        (await call(ownerToken, "PATCH", `/api/v1/members/${kept.id}`, { role: "admin" })).statusCode,
      ).toBe(200);

      expect((await open("/api/v1/invites/accept", joinBody(invite, `dm${++n}`))).statusCode).toBe(404);
      expect((await open("/api/v1/invites/reset", { token: reset, password: PASSWORD })).statusCode).toBe(
        404,
      );
      expect((await open("/api/v1/invites/lookup", { token: keptInvite })).statusCode).toBe(200);
      // 이미 수락이 끝난(used_by 있음) 링크는 발급자를 강등해도 폐기되지 않는다
      expect(app.db.select().from(invites).where(eq(invites.id, usedRow.id)).get()?.revokedAt).toBeNull();
    });

    it("admin 이 member 에게 낸 재설정 링크는 대상이 admin 으로 오르면 조회·수락 모두 404 — 대상의 옛 세션은 살고 링크는 소비되지 않는다", async () => {
      const admin = await person("admin");
      const target = await person("member");
      const reset = await issueReset(admin.token, target.id);
      const row = findValidInvite(app.db, reset, new Date());
      if (!row) throw new Error("reset link not found");

      expect(
        (await call(ownerToken, "PATCH", `/api/v1/members/${target.id}`, { role: "admin" })).statusCode,
      ).toBe(200);
      // 새 발급은 규칙대로 403 — 앞서 받은 링크도 같은 규칙으로 막혀야 한다
      expect((await call(admin.token, "POST", `/api/v1/members/${target.id}/reset-link`)).statusCode).toBe(
        403,
      );
      expect((await open("/api/v1/invites/lookup", { token: reset })).statusCode).toBe(404);
      expect((await open("/api/v1/invites/reset", { token: reset, password: PASSWORD })).statusCode).toBe(
        404,
      );
      expect((await call(target.token, "GET", "/api/v1/auth/me")).statusCode).toBe(200);
      expect(app.db.select().from(invites).where(eq(invites.id, row.id)).get()).toMatchObject({
        usedAt: null,
        usedBy: null,
      });
    });

    it("admin 이 낸 재설정 링크는 대상이 admin 으로 오를 때 폐기된다 — 다시 member 로 내려가도 되살아나지 않는다", async () => {
      const admin = await person("admin");
      const target = await person("member");
      const reset = await issueReset(admin.token, target.id);
      const ownerReset = await issueReset(ownerToken, (await person("member")).id);
      // 같은 admin 이 다른 member 에게 낸 링크 — owner 거르기에 안 걸려 대상 범위만이 이것을 남긴다
      const otherReset = await issueReset(admin.token, (await person("member")).id);
      const row = findValidInvite(app.db, reset, new Date());
      if (!row) throw new Error("reset link not found");

      for (const role of ["admin", "member"] as const) {
        expect((await call(ownerToken, "PATCH", `/api/v1/members/${target.id}`, { role })).statusCode).toBe(
          200,
        );
      }
      expect(app.db.select().from(invites).where(eq(invites.id, row.id)).get()?.revokedAt).not.toBeNull();
      expect((await open("/api/v1/invites/lookup", { token: reset })).statusCode).toBe(404);
      expect((await open("/api/v1/invites/reset", { token: reset, password: PASSWORD })).statusCode).toBe(
        404,
      );
      expect((await call(target.token, "GET", "/api/v1/auth/me")).statusCode).toBe(200);
      // 다른 사람을 겨눈 링크는 그대로
      expect((await open("/api/v1/invites/lookup", { token: otherReset })).statusCode).toBe(200);
      expect((await open("/api/v1/invites/lookup", { token: ownerReset })).statusCode).toBe(200);
    });

    it("owner 가 낸 재설정 링크는 대상이 admin 으로 올라도 조회·수락된다", async () => {
      const target = await person("member");
      const reset = await issueReset(ownerToken, target.id);
      expect(
        (await call(ownerToken, "PATCH", `/api/v1/members/${target.id}`, { role: "admin" })).statusCode,
      ).toBe(200);
      expect((await open("/api/v1/invites/lookup", { token: reset })).statusCode).toBe(200);
      expect((await open("/api/v1/invites/reset", { token: reset, password: PASSWORD })).statusCode).toBe(
        200,
      );
      expect((await call(target.token, "GET", "/api/v1/auth/me")).statusCode).toBe(401);
    });

    it("서비스도 직접 막는다 — admin 행위자의 역할 바꾸기는 403", async () => {
      const admin = await person("admin");
      const member = await person("member");
      let thrown: unknown;
      try {
        changeRole(app.db, app.workspaceId, admin.id, member.id, "admin");
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ status: 403 });
      expect(app.db.select().from(memberships).where(eq(memberships.userId, member.id)).get()?.role).toBe(
        "member",
      );
    });

    it("역할을 바꾸면 워크스페이스 방에 people.changed 가 한 번 간다", async () => {
      const member = await person("member");
      const watcher = await wire(ownerToken);
      const seen = recordEvents(watcher, ["people.changed"]);
      await call(ownerToken, "PATCH", `/api/v1/members/${member.id}`, { role: "admin" });
      await roundTrip(watcher);
      expect(seen).toHaveLength(1);
      const people = (seen[0]?.payload as { people: Person[] } | undefined)?.people ?? [];
      expect(people.find((p) => p.id === member.id)?.role).toBe("admin");
    });
  });

  describe("핸들은 사람과 에이전트를 통틀어 유일(Review Focus 2 반대쪽)", () => {
    it("사람 핸들로 에이전트를 등록하면 409 field handle", async () => {
      const member = await person("member");
      const res = await call(ownerToken, "POST", "/api/v1/agents", {
        providerAgentId: `pa${++n}`,
        handle: member.handle,
        name: "겹침",
        gatewayId: FAKE_GATEWAY_ID,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "CONFLICT", details: { field: "handle" } });
    });

    it("에이전트 핸들을 사람 핸들로 바꿔도 409", async () => {
      const member = await person("member");
      const created = await call(ownerToken, "POST", "/api/v1/agents", {
        providerAgentId: `pa${++n}`,
        handle: `ag${n}`,
        name: "에이전트",
        gatewayId: FAKE_GATEWAY_ID,
      });
      const { agent } = created.json() as { agent: { id: string } };
      const res = await call(ownerToken, "PATCH", `/api/v1/agents/${agent.id}`, { handle: member.handle });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ details: { field: "handle" } });
    });
  });

  describe("가입·표시 이름 바꾸기 뒤 people.changed", () => {
    it("초대를 수락하면 워크스페이스 방에 people.changed 가 한 번 — 새 사람이 실린다", async () => {
      const invite = await issueInvite(ownerToken);
      const watcher = await wire(ownerToken);
      const seen = recordEvents(watcher, ["people.changed"]);
      const handle = `joiner${++n}`;
      const res = await open("/api/v1/invites/accept", joinBody(invite, handle));
      expect(res.statusCode).toBe(200);
      await roundTrip(watcher);
      expect(seen).toHaveLength(1);
      const people = (seen[0]?.payload as { people: Person[] } | undefined)?.people ?? [];
      expect(people.find((p) => p.handle === handle)?.role).toBe("member");
    });

    it("PATCH /me 로 표시 이름을 바꾸면 people.changed 가 한 번 — 바뀐 이름으로", async () => {
      const member = await person("member");
      const watcher = await wire(ownerToken);
      const seen = recordEvents(watcher, ["people.changed"]);
      const res = await call(member.token, "PATCH", "/api/v1/me", { displayName: "새 이름" });
      expect(res.statusCode).toBe(200);
      await roundTrip(watcher);
      expect(seen).toHaveLength(1);
      const people = (seen[0]?.payload as { people: Person[] } | undefined)?.people ?? [];
      expect(people.find((p) => p.id === member.id)?.displayName).toBe("새 이름");
    });
  });
});
