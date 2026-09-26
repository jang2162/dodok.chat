import { type MemberRow, type Person, WIRE_PROTOCOL } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import * as authSchema from "../src/db/auth-schema";
import {
  channelMembers,
  invites,
  memberships,
  messages,
  pushSubscriptions,
  users,
} from "../src/db/schema.sqlite";
import { createChannel } from "../src/modules/channels/service";
import { removeMember } from "../src/modules/members/service";
import { createUserMessage } from "../src/modules/messages/service";
import { upsertSubscription } from "../src/modules/push/service";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { connectWire, openWire, recordEvents, type WireClient } from "./helpers/wire";

// 멤버 관리(팀 스펙 「멤버 관리」 절) — 목록·역할 바꾸기·내보내기, 그리고 에이전트 등록 쪽 핸들 유일(Review Focus 2 반대쪽)

describe("멤버 관리 REST", () => {
  let app: App;
  let ownerToken: string;
  const sockets: WireClient[] = [];
  let n = 0;

  beforeAll(async () => {
    app = await bootTestApp();
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
  /** 역할을 준 새 사용자 — 이메일도 우리 행에 싣는다(내보내기가 놓아주는지 보려고) */
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
  /** 같은 연결의 ack 왕복 — 앞서 보낸 서버 이벤트가 이미 도착했음을 보장한다 */
  const roundTrip = (socket: WireClient) =>
    new Promise<void>((resolve) =>
      socket.emit("channel.unsubscribe", { channelId: uuid() }, () => resolve()),
    );

  describe("GET /members", () => {
    it("admin 은 멤버 표를 받는다 — 역할·이메일·가입 시각, 나간 멤버는 없다", async () => {
      const admin = await person("admin");
      const member = await person("member");
      const res = await call(admin.token, "GET", "/api/v1/members");
      expect(res.statusCode).toBe(200);
      const rows = (res.json() as { members: MemberRow[] }).members;
      const mine = rows.find((r) => r.id === member.id);
      expect(mine).toMatchObject({ handle: member.handle, role: "member", email: member.email });
      expect(typeof mine?.createdAt).toBe("string");
      expect(rows.find((r) => r.id === app.ownerUserId)?.role).toBe("owner");

      expect((await call(admin.token, "DELETE", `/api/v1/members/${member.id}`)).statusCode).toBe(204);
      const after = (await call(admin.token, "GET", "/api/v1/members")).json() as { members: MemberRow[] };
      expect(after.members.some((r) => r.id === member.id)).toBe(false);
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

  describe("DELETE /members/:userId — 내보내기(Review Focus 3)", () => {
    it("admin 이 member 를 내보내면 세션·소켓·푸시·채널 참여가 끊기고 행은 핸들·이메일을 놓아준다", async () => {
      const admin = await person("admin");
      const member = await person("member");
      const channel = createChannel(app.db, {
        workspaceId: app.workspaceId,
        createdBy: member.id,
        name: `kick-${++n}`,
      });
      const other = createChannel(app.db, {
        workspaceId: app.workspaceId,
        createdBy: app.ownerUserId,
        name: `kick-${++n}`,
      });
      const said = createUserMessage(app.db, app.bus, {
        channelId: channel.id,
        authorId: member.id,
        bodyMd: "나 간다",
        clientMsgId: `c${++n}`,
      });
      upsertSubscription(app.db, member.id, {
        endpoint: `https://push.example/${member.handle}`,
        keys: { p256dh: "p", auth: "a" },
      });
      const reset = uuid();
      app.db
        .insert(invites)
        .values({
          id: reset,
          workspaceId: app.workspaceId,
          kind: "reset",
          targetUserId: member.id,
          tokenHash: `h${reset}`,
          prefix: "drt_ab",
          createdBy: admin.id,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        })
        .run();

      const victim = await wire(member.token);
      const disconnected = new Promise<string>((resolve) => victim.once("disconnect", resolve));
      const watcher = await wire(ownerToken);
      await new Promise<void>((resolve) =>
        watcher.emit("channel.subscribe", { channelId: channel.id }, () => resolve()),
      );
      await new Promise<void>((resolve) =>
        watcher.emit("channel.subscribe", { channelId: other.id }, () => resolve()),
      );
      const seen = recordEvents(watcher, ["people.changed", "channel.member.changed"]);

      const res = await call(admin.token, "DELETE", `/api/v1/members/${member.id}`);
      expect(res.statusCode).toBe(204);

      // 열린 wire 는 서버가 끊는다 — 클라이언트가 스스로 끊은 게 아니다
      expect(await disconnected).toBe("io server disconnect");
      // 같은 세션 토큰의 다음 REST 는 401, 재접속 핸드셰이크는 거절
      expect((await call(member.token, "GET", "/api/v1/people")).statusCode).toBe(401);
      await expect(connectWire(app, member.token)).rejects.toMatchObject({
        data: { code: "UNAUTHORIZED" },
      });

      expect(app.db.select().from(memberships).where(eq(memberships.userId, member.id)).all()).toHaveLength(
        0,
      );
      expect(
        app.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, member.id)).all(),
      ).toHaveLength(0);
      expect(
        app.db
          .select()
          .from(channelMembers)
          .where(and(eq(channelMembers.memberType, "user"), eq(channelMembers.memberId, member.id)))
          .all(),
      ).toHaveLength(0);
      const row = app.db.select().from(users).where(eq(users.id, member.id)).get();
      expect(row).toMatchObject({ leftHandle: member.handle, email: null });
      expect(row?.handle).toMatch(/^left-[a-z0-9]+$/);
      expect(row?.handle.length).toBeLessThanOrEqual(32);
      // 그 사람의 메시지는 남는다(작성자 참조)
      expect(app.db.select().from(messages).where(eq(messages.id, said.id)).get()?.authorId).toBe(member.id);
      // Better Auth 사용자·세션·계정은 지운다 — 같은 이메일로 다시 들일 수 있게
      expect(
        app.db.select().from(authSchema.user).where(eq(authSchema.user.id, member.id)).all(),
      ).toHaveLength(0);
      expect(
        app.db.select().from(authSchema.session).where(eq(authSchema.session.userId, member.id)).all(),
      ).toHaveLength(0);
      // 그 사람을 겨눈 재설정 링크는 폐기된다
      expect(app.db.select().from(invites).where(eq(invites.id, reset)).get()?.revokedAt).toBeInstanceOf(
        Date,
      );

      await roundTrip(watcher);
      expect(seen.filter((e) => e.event === "people.changed")).toHaveLength(1);
      const people =
        (seen.find((e) => e.event === "people.changed")?.payload as { people: Person[] } | undefined)
          ?.people ?? [];
      const left = people.find((p) => p.id === member.id);
      expect(left).toMatchObject({ leftHandle: member.handle });
      expect(left?.role).toBeUndefined();
      // 참여하던 채널에만 channel.member.changed — 그 사람이 빠진 목록
      const changed = seen.filter((e) => e.event === "channel.member.changed");
      expect(changed.map((e) => (e.payload as { channelId: string }).channelId)).toEqual([channel.id]);
      const members = (changed[0]?.payload as { members: { memberId: string }[] } | undefined)?.members ?? [];
      expect(members.some((m) => m.memberId === member.id)).toBe(false);
    });

    it("같은 이메일·옛 핸들로 새 사람을 들일 수 있다(새 사용자)", async () => {
      const member = await person("member");
      expect((await call(ownerToken, "DELETE", `/api/v1/members/${member.id}`)).statusCode).toBe(204);
      // 초대 수락(태스크 3)이 하는 것과 같은 두 쓰기 — Better Auth 이메일 유일·우리 users 의 핸들·이메일 유일
      const ctx = await app.auth.$context;
      const id = uuid();
      await ctx.internalAdapter.createUser(
        { id, email: member.email, name: member.handle, emailVerified: true },
        { method: "email-password" },
      );
      app.db
        .insert(users)
        .values({
          id,
          workspaceId: app.workspaceId,
          handle: member.handle,
          displayName: member.handle,
          email: member.email,
          authProvider: "local",
          createdAt: new Date(),
        })
        .run();
      expect(app.db.select().from(users).where(eq(users.handle, member.handle)).get()?.id).toBe(id);
    });

    it("같은 분에 들어온 두 사람을 차례로 내보내도 나간 핸들이 겹치지 않는다", async () => {
      const a = await person("member");
      const b = await person("member");
      expect((await call(ownerToken, "DELETE", `/api/v1/members/${a.id}`)).statusCode).toBe(204);
      expect((await call(ownerToken, "DELETE", `/api/v1/members/${b.id}`)).statusCode).toBe(204);
      const handles = [a.id, b.id].map(
        (id) => app.db.select().from(users).where(eq(users.id, id)).get()?.handle,
      );
      expect(new Set(handles).size).toBe(2);
    });

    it("같은 사람을 두 번 동시에 내보내면 하나만 성공 — left_handle 은 옛 핸들 그대로", async () => {
      const member = await person("member");
      // 서비스를 바로 부른다 — 둘 다 await 앞의 검사를 지난 뒤 엇갈린다(REST 두 요청은 앞 요청이 끝난 뒤에야 검사에 닿는다)
      const deps = {
        db: app.db,
        auth: app.auth,
        bus: app.bus,
        workspaceId: app.workspaceId,
        disconnectUser: () => {},
      };
      const results = await Promise.allSettled([
        removeMember(deps, app.ownerUserId, member.id),
        removeMember(deps, app.ownerUserId, member.id),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 404 } });
      expect(app.db.select().from(users).where(eq(users.id, member.id)).get()?.leftHandle).toBe(
        member.handle,
      );
    });

    it("admin 은 admin 을 못 내보낸다(403), owner 는 admin 을 내보낸다", async () => {
      const admin = await person("admin");
      const target = await person("admin");
      expect((await call(admin.token, "DELETE", `/api/v1/members/${target.id}`)).statusCode).toBe(403);
      expect(app.db.select().from(memberships).where(eq(memberships.userId, target.id)).all()).toHaveLength(
        1,
      );
      expect((await call(ownerToken, "DELETE", `/api/v1/members/${target.id}`)).statusCode).toBe(204);
    });

    it("누구도 owner 를 못 내보낸다(403)", async () => {
      const admin = await person("admin");
      expect((await call(admin.token, "DELETE", `/api/v1/members/${app.ownerUserId}`)).statusCode).toBe(403);
      expect((await call(ownerToken, "DELETE", `/api/v1/members/${app.ownerUserId}`)).statusCode).toBe(403);
      expect(
        app.db.select().from(memberships).where(eq(memberships.userId, app.ownerUserId)).all(),
      ).toHaveLength(1);
    });

    it("member 는 403, 없는 사용자·이미 나간 사람은 404", async () => {
      const member = await person("member");
      const other = await person("member");
      expect((await call(member.token, "DELETE", `/api/v1/members/${other.id}`)).statusCode).toBe(403);
      expect((await call(ownerToken, "DELETE", `/api/v1/members/${uuid()}`)).statusCode).toBe(404);
      expect((await call(ownerToken, "DELETE", `/api/v1/members/${other.id}`)).statusCode).toBe(204);
      expect((await call(ownerToken, "DELETE", `/api/v1/members/${other.id}`)).statusCode).toBe(404);
    });

    it("핸드셰이크를 지나는 사이 membership 이 사라지면 connection 에서 끊는다", async () => {
      const member = await person("member");
      // attachWire 의 인증 미들웨어 뒤에 붙는다 — 인증은 지났고 방에는 아직 안 들어간 틈을 흉내 낸다
      app.io.use((socket, next) => {
        if (socket.data.userId === member.id) {
          app.db.delete(memberships).where(eq(memberships.userId, member.id)).run();
        }
        next();
      });
      const socket = openWire(app, { token: member.token, protocol: WIRE_PROTOCOL });
      sockets.push(socket);
      expect(await new Promise<string>((resolve) => socket.once("disconnect", resolve))).toBe(
        "io server disconnect",
      );
    });

    it("내보낸 사람의 옛 세션은 wire 쿠키 없이 토큰으로도 붙지 못한다", async () => {
      const member = await person("member");
      await call(ownerToken, "DELETE", `/api/v1/members/${member.id}`);
      const socket = openWire(app, { token: member.token, protocol: WIRE_PROTOCOL });
      sockets.push(socket);
      const err = await new Promise<Error & { data?: { code: string } }>((resolve) =>
        socket.once("connect_error", resolve),
      );
      expect(err.data?.code).toBe("UNAUTHORIZED");
    });
  });

  describe("핸들은 사람과 에이전트를 통틀어 유일(Review Focus 2 반대쪽)", () => {
    it("사람 핸들로 에이전트를 등록하면 409 field handle", async () => {
      const member = await person("member");
      const res = await call(ownerToken, "POST", "/api/v1/agents", {
        providerAgentId: `pa${++n}`,
        handle: member.handle,
        name: "겹침",
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
      });
      const { agent } = created.json() as { agent: { id: string } };
      const res = await call(ownerToken, "PATCH", `/api/v1/agents/${agent.id}`, { handle: member.handle });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ details: { field: "handle" } });
    });

    it("나간 사람의 옛 핸들로는 에이전트를 등록할 수 있다", async () => {
      const member = await person("member");
      await call(ownerToken, "DELETE", `/api/v1/members/${member.id}`);
      const res = await call(ownerToken, "POST", "/api/v1/agents", {
        providerAgentId: `pa${++n}`,
        handle: member.handle,
        name: "옛 핸들",
      });
      expect(res.statusCode).toBe(201);
    });
  });
});
