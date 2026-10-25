/**
 * 멤버 비활성화·다시 활성화(채널 보관·멤버 비활성화 스펙 「멤버 비활성화」 절, 계획 판정 PC3·PC4, Review Focus 2·3).
 * 비활성화는 계정·핸들·이메일·역할·비밀번호·채널 참여를 남기고 로그인과 요청만 막는다.
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import {
  type ChannelMember,
  IssuedInvite,
  type MemberRow,
  PersonalTokenIssued,
  type Person,
  WIRE_PROTOCOL,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import * as authSchema from "../src/db/auth-schema";
import {
  channelMembers,
  conversationReads,
  invites,
  memberships,
  messages,
  opsEvents,
  personalTokens,
  pushSubscriptions,
  users,
} from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { claimInvite, findValidInvite, unclaimInvite } from "../src/modules/members/invites";
import { deactivateMember, reactivateMember } from "../src/modules/members/service";
import { createUserMessage } from "../src/modules/messages/service";
import { markRead } from "../src/modules/reads/store";
import { listDevices, upsertDevice } from "../src/modules/push/devices";
import { createTriggerLookups, upsertSubscription } from "../src/modules/push/service";
import { targetsForMessage } from "../src/modules/push/triggers";
import { listPersonalTokens, verifyPersonalToken } from "../src/modules/tokens/service";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { connectWire, openWire, recordEvents, type WireClient } from "./helpers/wire";
import { channelConversation, sendTarget } from "./helpers/seed";

describe("멤버 비활성화·다시 활성화", () => {
  let app: App;
  let adapter: FakeAdapter;
  let ownerToken: string;
  const sockets: WireClient[] = [];
  let n = 0;

  beforeAll(async () => {
    adapter = new FakeAdapter();
    // 로그인·초대 수락(IP 버킷)을 이 파일이 여러 번 부른다
    app = await bootTestApp(
      {},
      { adapters: [adapter], limits: { localLoginPerMin: 1000, invitePublicPerMin: 1000 } },
    );
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
  const open = (url: string, payload: object) => app.fastify.inject({ method: "POST", url, payload });
  const deactivate = (token: string, userId: string) =>
    call(token, "POST", `/api/v1/members/${userId}/deactivate`);
  const reactivate = (token: string, userId: string) =>
    call(token, "POST", `/api/v1/members/${userId}/reactivate`);
  const PASSWORD = "correct-horse-battery";
  /** 역할을 준 새 사용자(비밀번호 없음) */
  const person = async (role: "admin" | "member") => {
    const handle = `${role}${++n}`;
    return { ...(await userWithRole(app, handle, role)), handle };
  };
  /** 초대를 수락해 비밀번호로 로그인할 수 있는 member 를 만든다 */
  const joined = async () => {
    const handle = `joined${++n}`;
    const email = `${handle}@example.com`;
    const invite = await call(ownerToken, "POST", "/api/v1/invites", { role: "member" });
    const token = IssuedInvite.parse(invite.json()).token;
    const res = await open("/api/v1/invites/accept", {
      token,
      handle,
      displayName: handle,
      email,
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessionToken: string; user: { id: string } };
    return { id: body.user.id, token: body.sessionToken, handle, email };
  };
  const loginWith = (email: string, password: string) => open("/api/v1/auth/local", { email, password });
  const issueReset = async (token: string, userId: string) => {
    const res = await call(token, "POST", `/api/v1/members/${userId}/reset-link`);
    expect(res.statusCode).toBe(201);
    return IssuedInvite.parse(res.json()).token;
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
  const membership = (userId: string) =>
    app.db.select().from(memberships).where(eq(memberships.userId, userId)).get();
  const sessionsOf = (userId: string) =>
    app.db.select().from(authSchema.session).where(eq(authSchema.session.userId, userId)).all();
  const serviceDeps = () => ({
    db: app.db,
    auth: app.auth,
    bus: app.bus,
    workspaceId: app.workspaceId,
    ops: app.ops,
    logger: app.logger,
    disconnectUser: () => {},
  });
  const channel = (name: string) =>
    createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: `${name}-${++n}`,
    });

  describe("권한 — admin 은 member, owner 는 admin 까지, owner 는 대상 아님", () => {
    for (const [label, send] of [
      ["비활성화", deactivate],
      ["다시 활성화", reactivate],
    ] as const) {
      it(`${label}: admin → member 200, admin → admin 403, owner → admin 200, owner 대상 403, member 행위자 403, 없는 id 404`, async () => {
        const admin = await person("admin");
        const otherAdmin = await person("admin");
        const member = await person("member");
        const actorMember = await person("member");
        // 다시 활성화는 비활성인 대상으로 본다 — 권한 표가 같은지
        if (send === reactivate) {
          for (const target of [otherAdmin, member])
            expect((await deactivate(ownerToken, target.id)).statusCode).toBe(200);
        }
        expect((await send(admin.token, otherAdmin.id)).statusCode).toBe(403);
        expect((await send(actorMember.token, member.id)).statusCode).toBe(403);
        expect((await send(admin.token, app.ownerUserId)).statusCode).toBe(403);
        expect((await send(ownerToken, app.ownerUserId)).statusCode).toBe(403);
        expect((await send(ownerToken, uuid())).statusCode).toBe(404);

        const ok = await send(admin.token, member.id);
        expect(ok.statusCode).toBe(200);
        const row = (ok.json() as { member: MemberRow }).member;
        expect(row).toMatchObject({ id: member.id, role: "member" });
        expect(row.deactivatedAt === null).toBe(send === reactivate);
        expect((await send(ownerToken, otherAdmin.id)).statusCode).toBe(200);
        expect(membership(otherAdmin.id)?.deactivatedAt === null).toBe(send === reactivate);
        // 같은 상태로 다시 불러도 200(멱등) — 시각은 그대로
        const before = membership(member.id)?.deactivatedAt;
        expect((await send(admin.token, member.id)).statusCode).toBe(200);
        expect(membership(member.id)?.deactivatedAt).toEqual(before);
      });
    }

    it("비활성 admin 은 아무것도 못 한다 — 그 사람의 옛 세션으로 member 를 비활성화하면 401", async () => {
      const admin = await person("admin");
      const member = await person("member");
      const adminSession = await (await app.auth.$context).internalAdapter.createSession(admin.id);
      expect((await deactivate(ownerToken, admin.id)).statusCode).toBe(200);
      expect((await deactivate(adminSession.token, member.id)).statusCode).toBe(401);
      expect(membership(member.id)?.deactivatedAt).toBeNull();
    });

    it("DELETE /members/:userId 는 없다(404) — membership 은 그대로", async () => {
      const member = await person("member");
      expect((await call(ownerToken, "DELETE", `/api/v1/members/${member.id}`)).statusCode).toBe(404);
      expect(membership(member.id)).toMatchObject({ role: "member", deactivatedAt: null });
    });
  });

  describe("비활성화가 끊는 것", () => {
    it("세션 0·열린 소켓 끊김·푸시 구독 0·발급하거나 겨눈 쓰이지 않은 링크 폐기 — 계정·핸들·이메일·채널 참여 행·메시지는 남는다", async () => {
      const admin = await person("admin");
      const target = await person("admin");
      const member = await person("member");
      const ch = channel("deact");
      const said = createUserMessage(app.db, app.bus, {
        conversationId: channelConversation(app.db, ch.id),
        authorId: target.id,
        bodyMd: "남는 말",
        clientMsgId: `c${++n}`,
      });
      const extra = await (await app.auth.$context).internalAdapter.createSession(target.id);
      upsertSubscription(
        app.db,
        { userId: target.id, sessionId: extra.id },
        { endpoint: `https://push.example/${target.handle}`, keys: { p256dh: "p", auth: "a" } },
      );
      const issued = await call(target.token, "POST", "/api/v1/invites", { role: "member" });
      const issuedInvite = IssuedInvite.parse(issued.json()).token;
      const issuedReset = await issueReset(target.token, member.id);
      const aimedReset = await issueReset(ownerToken, target.id);
      const othersInvite = IssuedInvite.parse(
        (await call(admin.token, "POST", "/api/v1/invites", { role: "member" })).json(),
      ).token;
      const emailBefore = app.db.select().from(users).where(eq(users.id, target.id)).get()?.email;

      const victim = await wire(target.token);
      const disconnected = new Promise<string>((resolve) => victim.once("disconnect", resolve));
      const watcher = await wire(ownerToken);
      await new Promise<void>((resolve) =>
        watcher.emit("channel.subscribe", { channelId: ch.id }, () => resolve()),
      );
      const seen = recordEvents(watcher, ["people.changed", "channel.member.changed"]);

      expect((await deactivate(ownerToken, target.id)).statusCode).toBe(200);

      expect(await disconnected).toBe("io server disconnect");
      expect((await call(target.token, "GET", "/api/v1/people")).statusCode).toBe(401);
      expect((await call(extra.token, "GET", "/api/v1/auth/me")).statusCode).toBe(401);
      await expect(connectWire(app, target.token)).rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
      expect(sessionsOf(target.id)).toHaveLength(0);
      expect(
        app.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, target.id)).all(),
      ).toHaveLength(0);
      for (const token of [issuedInvite, issuedReset, aimedReset])
        expect((await open("/api/v1/invites/lookup", { token })).statusCode).toBe(404);
      expect((await open("/api/v1/invites/lookup", { token: othersInvite })).statusCode).toBe(200);

      // 남는 것 — Better Auth 사용자·계정은 지우지 않는다(다시 활성화하면 예전 비밀번호로)
      expect(membership(target.id)).toMatchObject({ role: "admin", deactivatedAt: expect.any(Date) });
      expect(app.db.select().from(users).where(eq(users.id, target.id)).get()).toMatchObject({
        handle: target.handle,
        email: emailBefore ?? null,
      });
      expect(
        app.db.select().from(authSchema.user).where(eq(authSchema.user.id, target.id)).all(),
      ).toHaveLength(1);
      expect(
        app.db
          .select()
          .from(channelMembers)
          .where(and(eq(channelMembers.channelId, ch.id), eq(channelMembers.memberId, target.id)))
          .all(),
      ).toHaveLength(1);
      expect(app.db.select().from(messages).where(eq(messages.id, said.id)).get()?.authorId).toBe(target.id);

      await roundTrip(watcher);
      const people = seen.filter((e) => e.event === "people.changed");
      expect(people).toHaveLength(1);
      const listed = (people[0]?.payload as { people: Person[] } | undefined)?.people.find(
        (p) => p.id === target.id,
      );
      expect(listed).toMatchObject({
        handle: target.handle,
        role: "admin",
        deactivatedAt: expect.any(String),
      });
      // 참여하던 채널에 channel.member.changed — 그 사람이 빠진 목록
      const changed = seen.filter((e) => e.event === "channel.member.changed");
      expect(changed.map((e) => (e.payload as { channelId: string }).channelId)).toEqual([ch.id]);
      const members = (changed[0]?.payload as { members: ChannelMember[] } | undefined)?.members ?? [];
      expect(members.some((m) => m.memberId === target.id)).toBe(false);
    });

    it("비활성화 응답 뒤 그 사람의 열린 탭이 보낸 wire 요청은 하나도 닿지 않는다(Review Focus 2)", async () => {
      const member = await person("member");
      const ch = channel("tab");
      const victim = await wire(member.token);
      await new Promise<void>((resolve) =>
        victim.emit("channel.subscribe", { channelId: ch.id }, () => resolve()),
      );
      const disconnected = new Promise<string>((resolve) => victim.once("disconnect", resolve));

      expect((await deactivate(ownerToken, member.id)).statusCode).toBe(200);
      expect(await disconnected).toBe("io server disconnect");
      // 끊긴 소켓의 emit 은 버퍼에 남는다 — 다시 붙으려 해도 핸드셰이크가 막아 버퍼가 나가지 않는다
      victim.emit(
        "message.send",
        { channelId: ch.id, ...sendTarget(app.db, ch.id), clientMsgId: `late-${++n}`, bodyMd: "늦은 말" },
        () => {},
      );
      const refused = new Promise<Error & { data?: { code?: string } }>((resolve) =>
        victim.once("connect_error", (err) => resolve(err as Error & { data?: { code?: string } })),
      );
      victim.connect();
      expect((await refused).data?.code).toBe("UNAUTHORIZED");
      expect(app.db.select().from(messages).where(eq(messages.channelId, ch.id)).all()).toHaveLength(0);
    });

    it("핸드셰이크를 지나는 사이 비활성화되면 connection 에서 끊는다(Review Focus 2)", async () => {
      const member = await person("member");
      // 인증 미들웨어 뒤에 붙는다 — 인증은 지났고 방에는 아직 안 들어간 틈에 비활성화를 끼운다
      app.io.use((socket, next) => {
        if (socket.data.userId === member.id)
          app.db
            .update(memberships)
            .set({ deactivatedAt: new Date() })
            .where(eq(memberships.userId, member.id))
            .run();
        next();
      });
      const socket = openWire(app, { token: member.token, protocol: WIRE_PROTOCOL });
      sockets.push(socket);
      expect(await new Promise<string>((resolve) => socket.once("disconnect", resolve))).toBe(
        "io server disconnect",
      );
    });

    it("수락이 진행 중(claim 됨, used_by 없음)인 초대는 발급자를 비활성화하면 폐기된다 — 그 수락이 되돌아가도 링크는 무효, 이미 끝난 수락은 그대로", async () => {
      const admin = await person("admin");
      const issue = async () =>
        IssuedInvite.parse((await call(admin.token, "POST", "/api/v1/invites", { role: "member" })).json())
          .token;
      const claiming = await issue();
      const claimingRow = findValidInvite(app.db, claiming, new Date());
      if (!claimingRow) throw new Error("invite not found");
      // acceptInvite 가 claimInvite 로 used_at 만 찍고 아직 사용자 생성을 못 끝낸 틈을 흉내 낸다
      expect(claimInvite(app.db, claimingRow.id, new Date())).toBe(true);
      const done = await issue();
      const doneRow = findValidInvite(app.db, done, new Date());
      if (!doneRow) throw new Error("invite not found");
      const accepted = await open("/api/v1/invites/accept", {
        token: done,
        handle: `done${++n}`,
        displayName: "done",
        email: `done${n}@example.com`,
        password: PASSWORD,
      });
      expect(accepted.statusCode).toBe(200);

      expect((await deactivate(ownerToken, admin.id)).statusCode).toBe(200);

      expect(
        app.db.select().from(invites).where(eq(invites.id, claimingRow.id)).get()?.revokedAt,
      ).toBeInstanceOf(Date);
      expect(app.db.select().from(invites).where(eq(invites.id, doneRow.id)).get()?.revokedAt).toBeNull();
      unclaimInvite(app.db, claimingRow.id);
      expect((await open("/api/v1/invites/lookup", { token: claiming })).statusCode).toBe(404);
    });

    it("세션 지우기가 실패하면 운영 사건 member_deactivate_failed 와 500 — 그래도 이미 막혀 있고, 다시 부르면 세션이 지워진다", async () => {
      const member = await person("member");
      const session = sessionsOf(member.id)[0];
      if (!session) throw new Error("session not found");
      upsertSubscription(
        app.db,
        { userId: member.id, sessionId: session.id },
        { endpoint: `https://push.example/${member.handle}`, keys: { p256dh: "p", auth: "a" } },
      );
      upsertDevice(
        app.db,
        member.id,
        session.id,
        { platform: "android", token: "fcm-deactivate", appId: "chat.dodok.android" },
        new Date(),
      );
      const real = (await app.auth.$context).internalAdapter;
      const failing = Object.create(real) as typeof real;
      failing.deleteUserSessions = async () => {
        throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
      };
      const auth = { $context: Promise.resolve({ internalAdapter: failing }) } as unknown as App["auth"];
      const cut: string[] = [];

      await expect(
        deactivateMember(
          { ...serviceDeps(), auth, disconnectUser: (id) => cut.push(id) },
          app.ownerUserId,
          member.id,
        ),
      ).rejects.toMatchObject({ status: 500, body: { code: "INTERNAL" } });
      expect(cut).toEqual([member.id]);
      expect(membership(member.id)?.deactivatedAt).toBeInstanceOf(Date);
      expect((await call(member.token, "GET", "/api/v1/people")).statusCode).toBe(401);
      const events = app.db
        .select()
        .from(opsEvents)
        .where(eq(opsEvents.kind, "member_deactivate_failed"))
        .all();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ severity: "error", detail: { userId: member.id } });
      expect(sessionsOf(member.id)).toHaveLength(1);
      // 세션이 남아도 푸시 구독은 트랜잭션이 지웠다 — 세션 cascade 에만 기대지 않는다
      expect(
        app.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, member.id)).all(),
      ).toHaveLength(0);
      expect(listDevices(app.db, member.id)).toHaveLength(0);

      expect((await deactivate(ownerToken, member.id)).statusCode).toBe(200);
      expect(sessionsOf(member.id)).toHaveLength(0);
    });

    it("같은 사람을 두 번 동시에 비활성화해도 둘 다 성공하고 시각은 처음 것 그대로", async () => {
      const member = await person("member");
      const results = await Promise.allSettled([
        deactivateMember(serviceDeps(), app.ownerUserId, member.id),
        deactivateMember(serviceDeps(), app.ownerUserId, member.id),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(membership(member.id)?.deactivatedAt).toBeInstanceOf(Date);
    });
  });

  describe("로그인·초대", () => {
    it("비밀번호가 맞으면 403 MEMBER_DEACTIVATED, 틀리면 지금 실패 응답 그대로 — 403 뒤 세션이 남지 않는다", async () => {
      const member = await joined();
      const active = await joined();
      expect((await deactivate(ownerToken, member.id)).statusCode).toBe(200);

      const right = await loginWith(member.email, PASSWORD);
      expect(right.statusCode).toBe(403);
      expect(right.json()).toEqual({
        code: "MEMBER_DEACTIVATED",
        message: "비활성화된 계정입니다. 관리자에게 문의하세요.",
      });
      expect(right.headers["set-cookie"]).toBeUndefined();
      expect(sessionsOf(member.id)).toHaveLength(0);

      const wrong = await loginWith(member.email, "wrong-password-here");
      const wrongActive = await loginWith(active.email, "wrong-password-here");
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toEqual(wrongActive.json());
    });

    it("비활성 멤버의 이메일로 초대를 수락하면 409 MEMBER_DEACTIVATED details.userId — 대소문자 무시, 초대는 쓰이지 않는다", async () => {
      const member = await joined();
      expect((await deactivate(ownerToken, member.id)).statusCode).toBe(200);
      const token = IssuedInvite.parse(
        (await call(ownerToken, "POST", "/api/v1/invites", { role: "member" })).json(),
      ).token;
      const res = await open("/api/v1/invites/accept", {
        token,
        handle: `again${++n}`,
        displayName: "다시",
        email: member.email.toUpperCase(),
        password: PASSWORD,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "MEMBER_DEACTIVATED", details: { userId: member.id } });
      expect((await open("/api/v1/invites/lookup", { token })).statusCode).toBe(200);
    });

    it("활성 멤버의 이메일은 지금처럼 409 CONFLICT field email", async () => {
      const member = await joined();
      const token = IssuedInvite.parse(
        (await call(ownerToken, "POST", "/api/v1/invites", { role: "member" })).json(),
      ).token;
      const res = await open("/api/v1/invites/accept", {
        token,
        handle: `dup${++n}`,
        displayName: "겹침",
        email: member.email,
        password: PASSWORD,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "CONFLICT", details: { field: "email" } });
    });
  });

  describe("채널·멘션·참여자(계획 판정 PC4)", () => {
    it("채널 멤버 응답·「참여자:」·멘션 해석·푸시 수신자에서 빠지고 행은 남는다 — 다시 활성화하면 돌아온다", async () => {
      const member = await person("member");
      const ch = channel("pc4");
      const dev = createAgent(app.db, {
        workspaceId: app.workspaceId,
        providerAgentId: `pc4dev${++n}`,
        handle: `pc4dev${n}`,
        name: "dev",
        gatewayId: FAKE_GATEWAY_ID,
      });
      addMember(app.db, ch.id, { memberType: "agent", memberId: dev.id }, app.logger);
      const said = createUserMessage(app.db, app.bus, {
        conversationId: channelConversation(app.db, ch.id),
        authorId: member.id,
        bodyMd: "들어왔다",
        clientMsgId: `c${++n}`,
      });
      const members = async () =>
        (
          (await call(ownerToken, "GET", `/api/v1/channels/${ch.id}/members`)).json() as {
            members: ChannelMember[];
          }
        ).members;
      expect((await members()).some((m) => m.memberId === member.id)).toBe(true);

      expect((await deactivate(ownerToken, member.id)).statusCode).toBe(200);
      expect((await members()).some((m) => m.memberId === member.id)).toBe(false);
      const lookups = createTriggerLookups(app.db, app.workspaceId);
      expect(lookups.humanMembers(ch.id)).not.toContain(member.id);

      // 사람이 @그 사람 을 부르면 멘션이 되지 않는다 — 푸시 대상도 없다
      const mention = createUserMessage(app.db, app.bus, {
        conversationId: channelConversation(app.db, ch.id),
        authorId: app.ownerUserId,
        bodyMd: `@${member.handle} @${dev.handle} 확인`,
        clientMsgId: `c${++n}`,
      });
      expect(mention.mentions.users).not.toContain(member.id);
      expect(targetsForMessage(mention, lookups).map((t) => t.userId)).not.toContain(member.id);
      await app.services.router.routeMessage(mention);
      await vi.waitFor(() =>
        expect(
          adapter.calls.send.some((s) => s.sessionKey.includes(channelConversation(app.db, ch.id))),
        ).toBe(true),
      );
      const sent = adapter.calls.send
        .filter((s) => s.sessionKey.includes(channelConversation(app.db, ch.id)))
        .at(-1);
      expect(sent?.context.participants.map((p) => p.handle)).not.toContain(member.handle);
      // 옛 메시지는 에이전트에게도 그 사람 이름으로 남는다(작성자)
      expect(sent?.context.recentMessages.find((m) => m.text === said.bodyMd)?.author).toMatchObject({
        handle: member.handle,
      });
      expect(
        app.db
          .select()
          .from(channelMembers)
          .where(and(eq(channelMembers.channelId, ch.id), eq(channelMembers.memberId, member.id)))
          .all(),
      ).toHaveLength(1);

      // GET /members·people 에 deactivatedAt
      const listed = (await call(ownerToken, "GET", "/api/v1/members")).json() as { members: MemberRow[] };
      expect(listed.members.find((m) => m.id === member.id)?.deactivatedAt).toEqual(expect.any(String));
      const people = (await call(ownerToken, "GET", "/api/v1/people")).json() as { people: Person[] };
      expect(people.people.find((p) => p.id === member.id)).toMatchObject({
        role: "member",
        deactivatedAt: expect.any(String),
      });

      expect((await reactivate(ownerToken, member.id)).statusCode).toBe(200);
      expect((await members()).some((m) => m.memberId === member.id)).toBe(true);
      expect(createTriggerLookups(app.db, app.workspaceId).humanMembers(ch.id)).toContain(member.id);
      const again = createUserMessage(app.db, app.bus, {
        conversationId: channelConversation(app.db, ch.id),
        authorId: app.ownerUserId,
        bodyMd: `@${member.handle} 돌아왔네`,
        clientMsgId: `c${++n}`,
      });
      expect(again.mentions.users).toEqual([member.id]);
      const after = (await call(ownerToken, "GET", "/api/v1/people")).json() as { people: Person[] };
      expect(after.people.find((p) => p.id === member.id)?.deactivatedAt).toBeNull();
    });

    it("에이전트가 받는 옛 메시지 속 멘션은 비활성 멤버도 그 핸들로 풀린다 — 「참여자:」에서만 빠진다", async () => {
      const member = await person("member");
      const ch = channel("oldmention");
      const dev = createAgent(app.db, {
        workspaceId: app.workspaceId,
        providerAgentId: `omdev${++n}`,
        handle: `omdev${n}`,
        name: "dev",
        gatewayId: FAKE_GATEWAY_ID,
      });
      addMember(app.db, ch.id, { memberType: "agent", memberId: dev.id }, app.logger);
      const before = createUserMessage(app.db, app.bus, {
        conversationId: channelConversation(app.db, ch.id),
        authorId: app.ownerUserId,
        bodyMd: `@${member.handle} 이거 맡아 줘`,
        clientMsgId: `c${++n}`,
      });
      expect(before.mentions.users).toEqual([member.id]);
      expect((await deactivate(ownerToken, member.id)).statusCode).toBe(200);

      const ask = createUserMessage(app.db, app.bus, {
        conversationId: channelConversation(app.db, ch.id),
        authorId: app.ownerUserId,
        bodyMd: `@${dev.handle} 누가 맡았지?`,
        clientMsgId: `c${++n}`,
      });
      await app.services.router.routeMessage(ask);
      await vi.waitFor(() =>
        expect(
          adapter.calls.send.some((s) => s.sessionKey.includes(channelConversation(app.db, ch.id))),
        ).toBe(true),
      );
      const sent = adapter.calls.send
        .filter((s) => s.sessionKey.includes(channelConversation(app.db, ch.id)))
        .at(-1);
      expect(sent?.context.recentMessages.map((m) => m.text)).toContain(`@${member.handle} 이거 맡아 줘`);
      expect(sent?.context.participants.map((p) => p.handle)).not.toContain(member.handle);
    });

    it("채널에 없는 비활성 멤버를 멘션해도 자동 참여·멘션이 없다, 채널에 넣기도 404", async () => {
      const member = await person("member");
      const ch = channel("outside");
      expect((await deactivate(ownerToken, member.id)).statusCode).toBe(200);
      const msg = createUserMessage(app.db, app.bus, {
        conversationId: channelConversation(app.db, ch.id),
        authorId: app.ownerUserId,
        bodyMd: `@${member.handle} 와 봐`,
        clientMsgId: `c${++n}`,
      });
      expect(msg.mentions.users).toEqual([]);
      expect(
        app.db
          .select()
          .from(channelMembers)
          .where(and(eq(channelMembers.channelId, ch.id), eq(channelMembers.memberId, member.id)))
          .all(),
      ).toHaveLength(0);
      const added = await call(ownerToken, "POST", `/api/v1/channels/${ch.id}/members`, {
        memberType: "user",
        memberId: member.id,
      });
      expect(added.statusCode).toBe(404);
    });

    it("비활성 membership 의 소켓에는 역할 방 이벤트(ops.event)가 가지 않는다 — 끊기 전 틈이 있어도", async () => {
      const admin = await person("admin");
      const socket = await wire(admin.token);
      const owner = await wire(ownerToken);
      const seen = recordEvents(socket, ["ops.event"]);
      const ownerSeen = recordEvents(owner, ["ops.event"]);
      // 비활성화는 쓰기와 끊기가 한 동기 구간이라 이 틈을 REST 로는 못 만든다 — 행만 바꿔 흉내 낸다
      app.db
        .update(memberships)
        .set({ deactivatedAt: new Date() })
        .where(eq(memberships.userId, admin.id))
        .run();
      app.bus.emit("ops.event", { event: { id: uuid() } } as never);
      await roundTrip(owner);
      await roundTrip(socket);
      expect(ownerSeen).toHaveLength(1);
      expect(seen).toHaveLength(0);
    });

    it("비활성 admin 에게는 승인 푸시가 가지 않는다", async () => {
      const admin = await person("admin");
      expect(createTriggerLookups(app.db, app.workspaceId).admins()).toContain(admin.id);
      expect((await deactivate(ownerToken, admin.id)).statusCode).toBe(200);
      expect(createTriggerLookups(app.db, app.workspaceId).admins()).not.toContain(admin.id);
    });
  });

  describe("다시 활성화(Review Focus 3)", () => {
    it("예전 비밀번호로 곧바로 로그인되고 역할·채널 참여가 돌아온다 — 비활성 중 폐기된 재설정 링크는 되살아나지 않는다", async () => {
      const member = await joined();
      const ch = channel("back");
      createUserMessage(app.db, app.bus, {
        conversationId: channelConversation(app.db, ch.id),
        authorId: member.id,
        bodyMd: "참여",
        clientMsgId: `c${++n}`,
      });
      const reset = await issueReset(ownerToken, member.id);
      const resetRow = findValidInvite(app.db, reset, new Date());
      if (!resetRow) throw new Error("reset link not found");

      expect((await deactivate(ownerToken, member.id)).statusCode).toBe(200);
      expect(
        app.db.select().from(invites).where(eq(invites.id, resetRow.id)).get()?.revokedAt,
      ).toBeInstanceOf(Date);
      // 비활성 중에는 새 재설정 링크도 못 낸다
      expect((await call(ownerToken, "POST", `/api/v1/members/${member.id}/reset-link`)).statusCode).toBe(
        404,
      );

      expect((await reactivate(ownerToken, member.id)).statusCode).toBe(200);
      const back = await loginWith(member.email, PASSWORD);
      expect(back.statusCode).toBe(200);
      const token = (back.json() as { sessionToken: string }).sessionToken;
      expect((await call(token, "GET", "/api/v1/auth/me")).json()).toMatchObject({ role: "member" });
      const members = (
        (await call(token, "GET", `/api/v1/channels/${ch.id}/members`)).json() as { members: ChannelMember[] }
      ).members;
      expect(members.some((m) => m.memberId === member.id)).toBe(true);
      // 옛 링크는 404 그대로, 옛 세션도 죽은 채
      expect((await open("/api/v1/invites/lookup", { token: reset })).statusCode).toBe(404);
      expect(
        (await open("/api/v1/invites/reset", { token: reset, password: "brand-new-password-1" })).statusCode,
      ).toBe(404);
      expect((await call(member.token, "GET", "/api/v1/auth/me")).statusCode).toBe(401);
      // 새 링크는 다시 낼 수 있다
      expect((await call(ownerToken, "POST", `/api/v1/members/${member.id}/reset-link`)).statusCode).toBe(
        201,
      );
    });

    it("admin 을 다시 활성화하면 admin 역할로 돌아온다", async () => {
      const admin = await person("admin");
      await deactivate(ownerToken, admin.id);
      const res = await reactivate(ownerToken, admin.id);
      expect((res.json() as { member: MemberRow }).member).toMatchObject({
        role: "admin",
        deactivatedAt: null,
      });
    });

    it("남은 세션을 먼저 지운다 — 비활성화 때 세션 지우기가 실패했어도 옛 세션은 되살아나지 않는다", async () => {
      const member = await person("member");
      // 비활성화가 세션을 못 지운 상태를 흉내 낸다
      app.db
        .update(memberships)
        .set({ deactivatedAt: new Date() })
        .where(eq(memberships.userId, member.id))
        .run();
      expect(sessionsOf(member.id)).toHaveLength(1);
      expect((await reactivate(ownerToken, member.id)).statusCode).toBe(200);
      expect(sessionsOf(member.id)).toHaveLength(0);
      expect((await call(member.token, "GET", "/api/v1/auth/me")).statusCode).toBe(401);
    });

    it("세션을 지우는 사이 행위자가 강등되면 트랜잭션 재검사가 403 — 대상은 비활성 그대로", async () => {
      const actor = await person("admin");
      const target = await person("member");
      await deactivate(ownerToken, target.id);
      const real = (await app.auth.$context).internalAdapter;
      const demoting = Object.create(real) as typeof real;
      demoting.deleteUserSessions = async (userId: string) => {
        await real.deleteUserSessions(userId);
        app.db.update(memberships).set({ role: "member" }).where(eq(memberships.userId, actor.id)).run();
      };
      const auth = { $context: Promise.resolve({ internalAdapter: demoting }) } as unknown as App["auth"];
      await expect(reactivateMember({ ...serviceDeps(), auth }, actor.id, target.id)).rejects.toMatchObject({
        status: 403,
      });
      expect(membership(target.id)?.deactivatedAt).toBeInstanceOf(Date);
    });

    it("읽음 행은 비활성화에도 남고 다시 활성화한 뒤 /me/unread 가 비활성화 전과 같다(읽지 않음 스펙 「오류 처리」 장)", async () => {
      const target = await joined();
      const ch = channel("reads-keep");
      const conversationId = channelConversation(app.db, ch.id);
      for (const clientMsgId of ["k1", "k2", "k3"])
        createUserMessage(app.db, app.bus, {
          conversationId,
          authorId: app.ownerUserId,
          bodyMd: "hi",
          clientMsgId,
        });
      markRead(app.db, app.workspaceId, target.id, conversationId, 2, new Date());
      const pick = (body: unknown) =>
        (body as { conversations: { conversationId: string }[] }).conversations.find(
          (c) => c.conversationId === conversationId,
        );
      const unread = async () => {
        const res = await call(target.token, "GET", "/api/v1/me/unread");
        expect(res.statusCode).toBe(200);
        return pick(res.json());
      };
      const before = await unread();
      expect(before).toMatchObject({ lastReadSeq: 2, unread: true });
      const rows = () =>
        app.db.select().from(conversationReads).where(eq(conversationReads.userId, target.id)).all();
      const rowsBefore = rows();
      expect((await deactivate(ownerToken, target.id)).statusCode).toBe(200);
      expect(rows()).toEqual(rowsBefore);
      expect((await reactivate(ownerToken, target.id)).statusCode).toBe(200);
      // 비활성화가 세션을 지웠다 — 비밀번호로 다시 로그인한다
      const relogin = await loginWith(target.email, PASSWORD);
      expect(relogin.statusCode).toBe(200);
      const token = (relogin.json() as { sessionToken: string }).sessionToken;
      const after = await call(token, "GET", "/api/v1/me/unread");
      expect(pick(after.json())).toEqual(before);
    });

    it("비활성화·다시 활성화마다 people.changed 가 한 번씩", async () => {
      const member = await person("member");
      const watcher = await wire(ownerToken);
      const seen = recordEvents(watcher, ["people.changed"]);
      await deactivate(ownerToken, member.id);
      await reactivate(ownerToken, member.id);
      await roundTrip(watcher);
      expect(
        seen.map(
          (e) =>
            (e.payload as { people: Person[] }).people.find((p) => p.id === member.id)?.deactivatedAt ===
            null,
        ),
      ).toEqual([false, true]);
    });
  });

  // 제어 MCP Review Focus 5 — 비활성화된 사람의 개인 토큰은 곧바로 죽고, 다시 활성화해도 되살아나지 않는다
  describe("개인 토큰", () => {
    it("비활성화하면 그 사람의 토큰이 모두 폐기된다 — 다른 사람 것은 그대로, 다시 활성화해도 폐기 그대로", async () => {
      const target = await person("member");
      const other = await person("member");
      const issue = async (token: string) => {
        const res = await call(token, "POST", "/api/v1/me/tokens", { label: "laptop" });
        expect(res.statusCode).toBe(201);
        return PersonalTokenIssued.parse(res.json()).raw;
      };
      const mine = [await issue(target.token), await issue(target.token)];
      const theirs = await issue(other.token);
      for (const raw of [...mine, theirs]) expect(verifyPersonalToken(app.db, raw)).toBeDefined();

      expect((await deactivate(ownerToken, target.id)).statusCode).toBe(200);
      for (const raw of mine) expect(verifyPersonalToken(app.db, raw)).toBeUndefined();
      expect(verifyPersonalToken(app.db, theirs)).toMatchObject({ userId: other.id });
      const rows = app.db.select().from(personalTokens).where(eq(personalTokens.userId, target.id)).all();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);

      expect((await reactivate(ownerToken, target.id)).statusCode).toBe(200);
      for (const raw of mine) expect(verifyPersonalToken(app.db, raw)).toBeUndefined();
      expect(listPersonalTokens(app.db, target.id)).toEqual([]);
    });
  });

  describe("걷은 left- 의 흔적", () => {
    it("left- 로 시작하는 핸들도 이제 가입·에이전트 등록에 쓸 수 있다", async () => {
      const token = IssuedInvite.parse(
        (await call(ownerToken, "POST", "/api/v1/invites", { role: "member" })).json(),
      ).token;
      const res = await open("/api/v1/invites/accept", {
        token,
        handle: `left-person${++n}`,
        displayName: "레프트",
        email: `left${n}@example.com`,
        password: PASSWORD,
      });
      expect(res.statusCode).toBe(200);
      const agent = await call(ownerToken, "POST", "/api/v1/agents", {
        providerAgentId: `leftagent${++n}`,
        handle: `left-agent${n}`,
        name: "레프트",
        gatewayId: FAKE_GATEWAY_ID,
      });
      expect(agent.statusCode).toBe(201);
    });

    it("비활성 멤버의 핸들은 그 사람 몫이다 — 같은 핸들로 에이전트를 등록하면 409", async () => {
      const member = await person("member");
      await deactivate(ownerToken, member.id);
      const res = await call(ownerToken, "POST", "/api/v1/agents", {
        providerAgentId: `taken${++n}`,
        handle: member.handle,
        name: "겹침",
        gatewayId: FAKE_GATEWAY_ID,
      });
      expect(res.statusCode).toBe(409);
    });

    it("users 에 left_handle 열이 없다", () => {
      const columns = app.db.$client.prepare("SELECT name FROM pragma_table_info('users')").all() as {
        name: string;
      }[];
      expect(columns.map((c) => c.name)).not.toContain("left_handle");
    });
  });
});
