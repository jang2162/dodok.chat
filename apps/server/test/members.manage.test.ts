import { Handle, IssuedInvite, type MemberRow, type Person, WIRE_PROTOCOL } from "@dodok/shared";
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
  opsEvents,
  pushSubscriptions,
  users,
} from "../src/db/schema.sqlite";
import { createChannel } from "../src/modules/channels/service";
import { claimInvite, findValidInvite, unclaimInvite } from "../src/modules/members/invites";
import { changeRole, leftHandleOf, removeMember } from "../src/modules/members/service";
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
  const serviceDeps = () => ({
    db: app.db,
    auth: app.auth,
    bus: app.bus,
    workspaceId: app.workspaceId,
    ops: app.ops,
    logger: app.logger,
    disconnectUser: () => {},
  });
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

    it("같은 이메일·옛 핸들로 초대를 수락해 다시 들어온다 — 새 사용자 id, 옛 메시지는 옛 행(left_handle)에 남는다", async () => {
      const member = await person("member");
      const channel = createChannel(app.db, {
        workspaceId: app.workspaceId,
        createdBy: app.ownerUserId,
        name: `rejoin-${++n}`,
      });
      const said = createUserMessage(app.db, app.bus, {
        channelId: channel.id,
        authorId: member.id,
        bodyMd: "예전 말",
        clientMsgId: `c${++n}`,
      });
      expect((await call(ownerToken, "DELETE", `/api/v1/members/${member.id}`)).statusCode).toBe(204);

      const invite = await issueInvite(ownerToken);
      const res = await open("/api/v1/invites/accept", joinBody(invite, member.handle, member.email));
      expect(res.statusCode).toBe(200);
      const { user } = res.json() as { user: { id: string; handle: string } };
      expect(user.id).not.toBe(member.id);
      expect(user.handle).toBe(member.handle);
      expect(app.db.select().from(users).where(eq(users.handle, member.handle)).get()?.id).toBe(user.id);
      expect(app.db.select().from(messages).where(eq(messages.id, said.id)).get()?.authorId).toBe(member.id);
      expect(app.db.select().from(users).where(eq(users.id, member.id)).get()?.leftHandle).toBe(
        member.handle,
      );
    });

    it("내보낸 admin 이 발급해 둔 초대·재설정 링크는 폐기된다 — 다른 사람이 발급한 링크는 그대로", async () => {
      const admin = await person("admin");
      const member = await person("member");
      const invite = await issueInvite(admin.token);
      const reset = await issueReset(admin.token, member.id);
      const ownersInvite = await issueInvite(ownerToken);

      expect((await call(ownerToken, "DELETE", `/api/v1/members/${admin.id}`)).statusCode).toBe(204);

      expect((await open("/api/v1/invites/accept", joinBody(invite, `rm${++n}`))).statusCode).toBe(404);
      expect((await open("/api/v1/invites/reset", { token: reset, password: PASSWORD })).statusCode).toBe(
        404,
      );
      expect((await open("/api/v1/invites/lookup", { token: ownersInvite })).statusCode).toBe(200);
    });

    it("수락이 진행 중(claim 됨, used_by 없음)인 초대는 발급자를 내보내면 폐기된다 — 그 수락이 실패해 되돌아가도 링크는 무효로 남고, 이미 끝난 수락은 그대로", async () => {
      const admin = await person("admin");
      const claiming = await issueInvite(admin.token);
      const claimingRow = findValidInvite(app.db, claiming, new Date());
      if (!claimingRow) throw new Error("invite not found");
      // acceptInvite 가 claimInvite 로 used_at 만 찍고 아직 사용자 생성을 못 끝낸 틈을 흉내 낸다
      expect(claimInvite(app.db, claimingRow.id, new Date())).toBe(true);

      const done = await issueInvite(admin.token);
      const doneRow = findValidInvite(app.db, done, new Date());
      if (!doneRow) throw new Error("invite not found");
      expect((await open("/api/v1/invites/accept", joinBody(done, `n1${++n}`))).statusCode).toBe(200);

      expect((await call(ownerToken, "DELETE", `/api/v1/members/${admin.id}`)).statusCode).toBe(204);

      expect(
        app.db.select().from(invites).where(eq(invites.id, claimingRow.id)).get()?.revokedAt,
      ).toBeInstanceOf(Date);
      // 이미 수락이 끝난(used_by 있음) 행은 건드리지 않는다
      expect(app.db.select().from(invites).where(eq(invites.id, doneRow.id)).get()?.revokedAt).toBeNull();

      // 그 수락이 실패해 unclaimInvite 로 되돌아가도(used_at·used_by 만 NULL) 링크는 무효로 남는다
      unclaimInvite(app.db, claimingRow.id);
      expect((await open("/api/v1/invites/accept", joinBody(claiming, `n1retry${++n}`))).statusCode).toBe(
        404,
      );
    });

    it("트랜잭션이 실패해도 소켓을 끊고 운영 사건 member_remove_failed 를 남긴 뒤 500 — 막힌 것을 치우면 다시 불러 이어진다", async () => {
      const member = await person("member");
      // 나간 핸들 자리를 미리 차지해 users_ws_handle 유일 인덱스로 트랜잭션을 실패시킨다
      const blocker = uuid();
      app.db
        .insert(users)
        .values({
          id: blocker,
          workspaceId: app.workspaceId,
          handle: leftHandleOf(member.id),
          displayName: "막이",
          authProvider: "local",
          createdAt: new Date(),
        })
        .run();
      const victim = await wire(member.token);
      const disconnected = new Promise<string>((resolve) => victim.once("disconnect", resolve));

      const res = await call(ownerToken, "DELETE", `/api/v1/members/${member.id}`);
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ code: "INTERNAL" });
      expect(await disconnected).toBe("io server disconnect");
      const events = app.db.select().from(opsEvents).where(eq(opsEvents.kind, "member_remove_failed")).all();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ severity: "error", detail: { userId: member.id } });
      expect(app.db.select().from(memberships).where(eq(memberships.userId, member.id)).all()).toHaveLength(
        1,
      );

      app.db.delete(users).where(eq(users.id, blocker)).run();
      expect((await call(ownerToken, "DELETE", `/api/v1/members/${member.id}`)).statusCode).toBe(204);
      expect(app.db.select().from(users).where(eq(users.id, member.id)).get()).toMatchObject({
        leftHandle: member.handle,
        handle: leftHandleOf(member.id),
      });
    });

    it("나간 핸들은 uuid v7 의 시각 앞 5자만 버린다 — rand_a 만 다른 두 id 도 갈리고 Handle 규칙 안(32자)", () => {
      const a = leftHandleOf("0190a1b2-c3d4-7000-8000-00000000000a");
      const b = leftHandleOf("0190a1b2-c3d4-7fff-8000-00000000000a");
      expect(a).not.toBe(b);
      expect(a).toHaveLength(32);
      expect(Handle.parse(a)).toBe(a);
    });

    it("서비스도 직접 막는다 — member 행위자의 내보내기는 403", async () => {
      const actor = await person("member");
      const target = await person("member");
      await expect(removeMember(serviceDeps(), actor.id, target.id)).rejects.toMatchObject({ status: 403 });
      expect(app.db.select().from(memberships).where(eq(memberships.userId, target.id)).all()).toHaveLength(
        1,
      );
    });

    it("세션을 지운 뒤 트랜잭션 재검사가 403 으로 떨어져도(그 사이 행위자 강등) 대상의 열린 소켓은 끊는다", async () => {
      const actor = await person("admin");
      const target = await person("member");
      const real = (await app.auth.$context).internalAdapter;
      // Better Auth 사용자를 지운 직후 — 트랜잭션 재검사 전 — 행위자를 member 로 내린다
      const adapter = Object.create(real) as typeof real;
      adapter.deleteUser = async (userId: string) => {
        await real.deleteUser(userId);
        app.db.update(memberships).set({ role: "member" }).where(eq(memberships.userId, actor.id)).run();
      };
      const auth = { $context: Promise.resolve({ internalAdapter: adapter }) } as unknown as App["auth"];
      const cut: string[] = [];
      await expect(
        removeMember({ ...serviceDeps(), auth, disconnectUser: (id) => cut.push(id) }, actor.id, target.id),
      ).rejects.toMatchObject({ status: 403 });
      expect(cut).toEqual([target.id]);
      expect(app.db.select().from(memberships).where(eq(memberships.userId, target.id)).all()).toHaveLength(
        1,
      );
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
      const deps = serviceDeps();
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

    it("left- 로 시작하는 핸들은 나간 사람 몫이라 예약 — 에이전트 등록·수정, 사람 가입 모두 400 field handle", async () => {
      const created = await call(ownerToken, "POST", "/api/v1/agents", {
        providerAgentId: `pa${++n}`,
        handle: "left-agent",
        name: "예약",
      });
      expect(created.statusCode).toBe(400);
      expect(created.json()).toMatchObject({ code: "VALIDATION", details: { field: "handle" } });

      const ok = await call(ownerToken, "POST", "/api/v1/agents", {
        providerAgentId: `pa${++n}`,
        handle: `ag${n}`,
        name: "에이전트",
      });
      const { agent } = ok.json() as { agent: { id: string } };
      const patched = await call(ownerToken, "PATCH", `/api/v1/agents/${agent.id}`, { handle: "left-agent" });
      expect(patched.statusCode).toBe(400);
      expect(patched.json()).toMatchObject({ code: "VALIDATION", details: { field: "handle" } });

      const invite = await issueInvite(ownerToken);
      const joined = await open("/api/v1/invites/accept", joinBody(invite, "left-person"));
      expect(joined.statusCode).toBe(400);
      expect(joined.json()).toMatchObject({ code: "VALIDATION", details: { field: "handle" } });
      // 거절된 가입은 초대를 쓰지 않는다
      expect((await open("/api/v1/invites/lookup", { token: invite })).statusCode).toBe(200);
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
