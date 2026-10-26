/**
 * 자동화 관리 API(자동화 스펙 「관리 API」 장) — admin 이상. 예약은 만들기·켜기·예약 변경 때 지금 뒤 첫 회차로 next_run_at 을 두고,
 * 웹훅은 만들기·재발급 응답에만 URL 원문을 싣는다(오리진은 서버 공개 주소 — 계획 판정 PA2). 역할별 허용·거절은 roles.matrix.test.ts
 */
import { type AutomationCreated, type AutomationSchedule, type AutomationSummary } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { agents, automations, channels, conversations, messages } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { nextRunAt } from "../src/modules/automations/schedule";
import { getAutomation, updateAutomation } from "../src/modules/automations/store";
import { addMember, createChannel } from "../src/modules/channels/service";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { createDmChannelForTest } from "./helpers/seed";

const SEOUL = "Asia/Seoul";
const PUBLIC_HOST = "hooks.example.test";
const DAILY_NINE: AutomationSchedule = { repeat: "daily", time: "09:00" };

type Inject = { method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: object };

describe("자동화 관리 API", () => {
  let app: App;
  let headers: { authorization: string };
  let n = 0;

  beforeAll(async () => {
    // 브리지 공개 주소가 웹 오리진(APP_ORIGIN)과 다르게 — 웹훅 URL 이 어느 쪽에서 오는지 가른다(PA2)
    app = await bootTestApp({ BRIDGE_PUBLIC_URL: `wss://${PUBLIC_HOST}/bridge` });
    headers = (await login(app)).headers;
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (req: Inject) =>
    app.fastify.inject({
      method: req.method,
      url: `/api/v1${req.url}`,
      headers,
      ...(req.payload === undefined ? {} : { payload: req.payload }),
    });
  const newChannel = () =>
    createChannel(app.db, { workspaceId: app.workspaceId, createdBy: app.ownerUserId, name: `auto-${++n}` });
  const newAgent = (handle: string) =>
    createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: handle,
      handle,
      name: handle,
    });
  const create = async (payload: object) => {
    const res = await call({ method: "POST", url: "/automations", payload });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as AutomationCreated;
  };
  const schedule = (channelId: string, extra: object = {}) =>
    create({
      kind: "schedule",
      name: `예약 ${++n}`,
      channelId,
      bodyMd: "점검해 주세요",
      schedule: DAILY_NINE,
      ...extra,
    });
  const webhook = (channelId: string, extra: object = {}) =>
    create({ kind: "webhook", name: `웹훅 ${++n}`, channelId, bodyMd: "새 이벤트", ...extra });
  const list = async () => {
    const res = await call({ method: "GET", url: "/automations" });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as AutomationSummary[];
  };
  const listed = async (id: string) => (await list()).find((a) => a.id === id);
  const tokenOf = (url: string | undefined) => {
    const match = /^https:\/\/hooks\.example\.test\/hooks\/(whk_[A-Za-z0-9_-]{43})$/.exec(url ?? "");
    if (!match) throw new Error(`웹훅 URL 꼴이 아니다: ${url}`);
    return match[1] as string;
  };
  const hook = (token: string, payload = "ping") =>
    app.fastify.inject({
      method: "POST",
      url: `/hooks/${token}`,
      headers: { "content-type": "text/plain" },
      payload,
    });
  const postsOf = (automationId: string) =>
    app.db
      .select()
      .from(messages)
      .where(and(eq(messages.authorType, "automation"), eq(messages.authorId, automationId)))
      .all();
  const firstRunAround = (before: Date, after: Date, s: AutomationSchedule = DAILY_NINE) => [
    nextRunAt(s, SEOUL, before).toISOString(),
    nextRunAt(s, SEOUL, after).toISOString(),
  ];

  describe("만들기·목록", () => {
    it("예약 → 201, nextRunAt 은 지금 뒤 첫 회차(워크스페이스 시간대), 웹훅 URL·토큰 접두사 없음", async () => {
      const channel = newChannel();
      const before = new Date();
      const { automation, webhookUrl } = await schedule(channel.id, { name: "아침 점검" });
      const after = new Date();
      expect(automation).toMatchObject({
        name: "아침 점검",
        channelId: channel.id,
        kind: "schedule",
        bodyMd: "점검해 주세요",
        enabled: true,
        schedule: DAILY_NINE,
        warnings: [],
      });
      expect(firstRunAround(before, after)).toContain(automation.nextRunAt);
      expect(webhookUrl).toBeUndefined();
      expect(automation.tokenPrefix).toBeUndefined();
      expect(getAutomation(app.db, app.workspaceId, automation.id)?.createdBy).toBe(app.ownerUserId);
    });

    it("꺼진 채로 만든 예약은 nextRunAt 이 없다", async () => {
      const { automation } = await schedule(newChannel().id, { enabled: false });
      expect(automation.nextRunAt).toBeUndefined();
      expect(getAutomation(app.db, app.workspaceId, automation.id)?.nextRunAt).toBeNull();
    });

    it("[PA2] 웹훅 → webhookUrl 은 서버 공개 주소의 오리진(http(s)) + /hooks/whk_…, 응답은 no-store, 목록에는 tokenPrefix 만", async () => {
      const channel = newChannel();
      const res = await call({
        method: "POST",
        url: "/automations",
        payload: { kind: "webhook", name: "배포 알림", channelId: channel.id, bodyMd: "새 배포" },
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.headers["cache-control"]).toBe("no-store");
      const { automation, webhookUrl } = res.json() as AutomationCreated;
      const token = tokenOf(webhookUrl);
      expect(automation).toMatchObject({ kind: "webhook", tokenPrefix: token.slice(4, 10), warnings: [] });
      expect(automation.nextRunAt).toBeUndefined();
      expect(automation.schedule).toBeUndefined();

      const all = await list();
      expect(all.find((a) => a.id === automation.id)?.tokenPrefix).toBe(token.slice(4, 10));
      expect(JSON.stringify(all)).not.toContain(token);
      expect(JSON.stringify(all)).not.toContain("webhookUrl");
      // URL 이 그대로 쓰인다 — 경로 그대로 보내면 게시된다
      expect((await hook(token)).statusCode).toBe(202);
    });

    it("이름이 겹치면 409 CONFLICT(field name) — 앞뒤 공백은 걷고 잰다", async () => {
      const channel = newChannel();
      await schedule(channel.id, { name: "중복 이름" });
      const res = await call({
        method: "POST",
        url: "/automations",
        payload: { kind: "webhook", name: "  중복 이름 ", channelId: channel.id, bodyMd: "x" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "CONFLICT", details: { field: "name" } });
    });

    it("보관한 채널을 겨누면 409 CHANNEL_ARCHIVED, 없는 채널은 404 — 행이 생기지 않는다", async () => {
      const archived = newChannel();
      app.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived.id)).run();
      const before = app.db.select().from(automations).all().length;
      const res = await call({
        method: "POST",
        url: "/automations",
        payload: { kind: "webhook", name: `보관 ${++n}`, channelId: archived.id, bodyMd: "x" },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "CHANNEL_ARCHIVED" });
      const missing = await call({
        method: "POST",
        url: "/automations",
        payload: {
          kind: "webhook",
          name: `없음 ${++n}`,
          channelId: "01999999-0000-7000-8000-000000000000",
          bodyMd: "x",
        },
      });
      expect(missing.statusCode).toBe(404);
      expect(app.db.select().from(automations).all()).toHaveLength(before);
    });

    it("본문은 shared 스키마로 — 이름 41자·예약 없는 schedule 은 400 VALIDATION", async () => {
      const channel = newChannel();
      for (const payload of [
        { kind: "webhook", name: "가".repeat(41), channelId: channel.id, bodyMd: "x" },
        { kind: "schedule", name: "예약 없음", channelId: channel.id, bodyMd: "x" },
      ]) {
        const res = await call({ method: "POST", url: "/automations", payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json()).toMatchObject({ code: "VALIDATION" });
      }
    });
  });

  describe("수정", () => {
    it("끄면 nextRunAt 이 없고, 다시 켜면 켜는 순간 뒤 첫 회차", async () => {
      const { automation } = await schedule(newChannel().id);
      const off = await call({
        method: "PATCH",
        url: `/automations/${automation.id}`,
        payload: { enabled: false },
      });
      expect(off.statusCode, off.body).toBe(200);
      expect((off.json() as AutomationSummary).nextRunAt).toBeUndefined();
      expect((off.json() as AutomationSummary).enabled).toBe(false);

      const before = new Date();
      const on = await call({
        method: "PATCH",
        url: `/automations/${automation.id}`,
        payload: { enabled: true },
      });
      const after = new Date();
      expect(on.statusCode, on.body).toBe(200);
      expect(firstRunAround(before, after)).toContain((on.json() as AutomationSummary).nextRunAt);
    });

    it("예약을 바꾸면 새 예약의 첫 회차로 다시 센다", async () => {
      const { automation } = await schedule(newChannel().id);
      const hourly: AutomationSchedule = { repeat: "hourly", minute: 30 };
      const before = new Date();
      const res = await call({
        method: "PATCH",
        url: `/automations/${automation.id}`,
        payload: { schedule: hourly },
      });
      const after = new Date();
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ schedule: hourly });
      expect(firstRunAround(before, after, hourly)).toContain((res.json() as AutomationSummary).nextRunAt);
    });

    it("이름·문구만 바꾸거나 같은 값을 다시 보내면 next_run_at 은 그대로 — 기한이 지나 틱을 기다리는 회차가 밀리지 않는다", async () => {
      const { automation } = await schedule(newChannel().id);
      const due = new Date(Date.now() - 30_000);
      updateAutomation(app.db, app.workspaceId, automation.id, { nextRunAt: due });
      for (const payload of [
        { name: `새 이름 ${++n}` },
        { bodyMd: "바뀐 문구" },
        { enabled: true, schedule: DAILY_NINE },
      ]) {
        const res = await call({ method: "PATCH", url: `/automations/${automation.id}`, payload });
        expect(res.statusCode, res.body).toBe(200);
        expect(
          getAutomation(app.db, app.workspaceId, automation.id)?.nextRunAt,
          JSON.stringify(payload),
        ).toEqual(due);
      }
      expect(await listed(automation.id)).toMatchObject({ bodyMd: "바뀐 문구" });
    });

    it("웹훅에 schedule 을 주면 400 VALIDATION — 종류는 바뀌지 않는다", async () => {
      const { automation } = await webhook(newChannel().id);
      const res = await call({
        method: "PATCH",
        url: `/automations/${automation.id}`,
        payload: { schedule: DAILY_NINE },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION" });
      expect(getAutomation(app.db, app.workspaceId, automation.id)).toMatchObject({
        kind: "webhook",
        scheduleJson: null,
      });
    });

    it("보관한 채널로 옮기면 409 CHANNEL_ARCHIVED — 채널은 그대로", async () => {
      const home = newChannel();
      const archived = newChannel();
      app.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived.id)).run();
      const { automation } = await webhook(home.id);
      const res = await call({
        method: "PATCH",
        url: `/automations/${automation.id}`,
        payload: { channelId: archived.id },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "CHANNEL_ARCHIVED" });
      expect(getAutomation(app.db, app.workspaceId, automation.id)?.channelId).toBe(home.id);
    });

    it("다른 자동화의 이름으로 바꾸면 409, 없는 id 는 404", async () => {
      const channel = newChannel();
      const { automation: first } = await schedule(channel.id);
      const { automation: second } = await webhook(channel.id);
      const res = await call({
        method: "PATCH",
        url: `/automations/${second.id}`,
        payload: { name: first.name },
      });
      expect(res.statusCode).toBe(409);
      const missing = await call({
        method: "PATCH",
        url: "/automations/01999999-0000-7000-8000-000000000000",
        payload: { name: "x" },
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe("토큰 재발급", () => {
    it("새 URL 을 한 번 싣고 옛 해시는 사라진다 — 옛 URL 404, 새 URL 202", async () => {
      const { automation, webhookUrl } = await webhook(newChannel().id);
      const oldToken = tokenOf(webhookUrl);
      const oldHash = getAutomation(app.db, app.workspaceId, automation.id)?.tokenHash;
      const res = await call({ method: "POST", url: `/automations/${automation.id}/token` });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const reissued = res.json() as AutomationCreated;
      const newToken = tokenOf(reissued.webhookUrl);
      expect(newToken).not.toBe(oldToken);
      expect(reissued.automation.tokenPrefix).toBe(newToken.slice(4, 10));
      const row = getAutomation(app.db, app.workspaceId, automation.id);
      expect(row?.tokenHash).not.toBe(oldHash);
      expect(
        app.db
          .select()
          .from(automations)
          .where(eq(automations.tokenHash, oldHash as string))
          .all(),
      ).toEqual([]);
      expect((await hook(oldToken)).statusCode).toBe(404);
      expect((await hook(newToken)).statusCode).toBe(202);
    });

    it("예약 자동화는 토큰이 없다 — 400 VALIDATION, 행에 토큰이 생기지 않는다", async () => {
      const { automation } = await schedule(newChannel().id);
      const res = await call({ method: "POST", url: `/automations/${automation.id}/token` });
      expect(res.statusCode).toBe(400);
      expect(getAutomation(app.db, app.workspaceId, automation.id)?.tokenHash).toBeNull();
    });
  });

  describe("지금 실행", () => {
    it("예약 — 문구를 게시하고 202 {messageId}, next_run_at 은 그대로, 마지막 결과 ok", async () => {
      const { automation } = await schedule(newChannel().id, { bodyMd: "지금 점검" });
      const nextBefore = getAutomation(app.db, app.workspaceId, automation.id)?.nextRunAt;
      const res = await call({ method: "POST", url: `/automations/${automation.id}/run` });
      expect(res.statusCode, res.body).toBe(202);
      const { messageId } = res.json() as { messageId: string };
      expect(postsOf(automation.id).map((m) => [m.id, m.bodyMd])).toEqual([[messageId, "지금 점검"]]);
      const row = getAutomation(app.db, app.workspaceId, automation.id);
      expect(row?.nextRunAt).toEqual(nextBefore);
      expect(row?.lastStatus).toBe("ok");
      expect(row?.lastRunAt).toBeInstanceOf(Date);
    });

    it("요청 하나에 게시 하나 — 두 번 부르면 두 번 게시한다", async () => {
      const { automation } = await schedule(newChannel().id);
      for (let i = 0; i < 2; i++) {
        expect((await call({ method: "POST", url: `/automations/${automation.id}/run` })).statusCode).toBe(
          202,
        );
      }
      expect(postsOf(automation.id)).toHaveLength(2);
    });

    it("웹훅·꺼진 자동화도 문구만 게시한다(원문 블록 없음)", async () => {
      const { automation } = await webhook(newChannel().id, { bodyMd: "손으로 실행", enabled: false });
      const res = await call({ method: "POST", url: `/automations/${automation.id}/run` });
      expect(res.statusCode, res.body).toBe(202);
      expect(postsOf(automation.id).map((m) => m.bodyMd)).toEqual(["손으로 실행"]);
    });

    it("보관한 채널이면 409 CHANNEL_ARCHIVED — 게시하지 않는다", async () => {
      const channel = newChannel();
      const { automation } = await schedule(channel.id);
      app.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, channel.id)).run();
      const res = await call({ method: "POST", url: `/automations/${automation.id}/run` });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "CHANNEL_ARCHIVED" });
      expect(postsOf(automation.id)).toEqual([]);
    });
  });

  // 자동화는 DM 에 게시하지 않는다(에이전트 DM 스펙 5장, 계획 판정 PD5) — 남의 DM 은 없는 채널과 같은 404 가 먼저, 내 DM 은 VALIDATION
  describe("DM", () => {
    let mia: { id: string; token: string };
    beforeAll(async () => {
      mia = await userWithRole(app, "auto-mia", "member");
    });
    const dmOf = (ownerId: string) =>
      createDmChannelForTest(app.db, {
        workspaceId: app.workspaceId,
        ownerId,
        agentId: newAgent(`autodm${++n}`).id,
      }).id;
    const missing = "01990000-0000-7000-8000-00000000dead";

    it("만들기 — 남의 DM 은 없는 채널과 같은 404, 내 DM 은 400 VALIDATION, 행이 생기지 않는다", async () => {
      const before = (await list()).length;
      const payload = (channelId: string) => ({
        kind: "schedule",
        name: `DM ${++n}`,
        channelId,
        bodyMd: "엿보기",
        schedule: DAILY_NINE,
      });
      const foreign = await call({ method: "POST", url: "/automations", payload: payload(dmOf(mia.id)) });
      const unknown = await call({ method: "POST", url: "/automations", payload: payload(missing) });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual(unknown.json());
      const own = await call({
        method: "POST",
        url: "/automations",
        payload: payload(dmOf(app.ownerUserId)),
      });
      expect(own.statusCode, own.body).toBe(400);
      expect(own.json()).toMatchObject({ code: "VALIDATION" });
      expect(await list()).toHaveLength(before);
    });

    it("바꾸기 — 남의 DM 으로 옮기면 404, 내 DM 이면 400 VALIDATION, 채널은 그대로", async () => {
      const channel = newChannel();
      const { automation } = await schedule(channel.id);
      const move = (channelId: string) =>
        call({ method: "PATCH", url: `/automations/${automation.id}`, payload: { channelId } });
      const foreign = await move(dmOf(mia.id));
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual((await move(missing)).json());
      const own = await move(dmOf(app.ownerUserId));
      expect(own.statusCode, own.body).toBe(400);
      expect(own.json()).toMatchObject({ code: "VALIDATION" });
      expect(getAutomation(app.db, app.workspaceId, automation.id)?.channelId).toBe(channel.id);
    });

    it("방어선 — DM 을 가리키게 된 자동화는 「지금 실행」·웹훅이 게시하지 않고, DM 에 세션도 만들지 않는다", async () => {
      const dm = dmOf(app.ownerUserId);
      const sched = (await schedule(newChannel().id)).automation;
      const hooked = await webhook(newChannel().id);
      for (const id of [sched.id, hooked.automation.id])
        app.db.update(automations).set({ channelId: dm }).where(eq(automations.id, id)).run();
      const run = await call({ method: "POST", url: `/automations/${sched.id}/run` });
      expect(run.statusCode, run.body).toBe(400);
      expect(run.json()).toMatchObject({ code: "VALIDATION" });
      const res = await hook(tokenOf(hooked.webhookUrl));
      expect(res.statusCode, res.body).toBe(400);
      expect(postsOf(sched.id)).toEqual([]);
      expect(postsOf(hooked.automation.id)).toEqual([]);
      expect(app.db.select().from(conversations).where(eq(conversations.channelId, dm)).all()).toEqual([]);
      expect(getAutomation(app.db, app.workspaceId, hooked.automation.id)?.lastStatus).toBe("error");
    });
  });

  describe("삭제", () => {
    it("204 — 목록에서 빠지고 게시한 메시지는 남는다, 다시 지우면 404", async () => {
      const { automation } = await schedule(newChannel().id);
      expect((await call({ method: "POST", url: `/automations/${automation.id}/run` })).statusCode).toBe(202);
      const res = await call({ method: "DELETE", url: `/automations/${automation.id}` });
      expect(res.statusCode).toBe(204);
      expect(await listed(automation.id)).toBeUndefined();
      expect(postsOf(automation.id)).toHaveLength(1);
      expect((await call({ method: "DELETE", url: `/automations/${automation.id}` })).statusCode).toBe(404);
    });
  });

  describe("[Review Focus 3] 경고", () => {
    it("문구의 에이전트가 채널에 없음·꺼짐·보관됨·모르는 핸들 — 처음 나온 차례로 한 번씩, 사람·코드 안·채널의 켜진 에이전트는 경고 없음", async () => {
      const channel = newChannel();
      const k = ++n;
      const live = newAgent(`live${k}`);
      const off = newAgent(`off${k}`);
      const gone = newAgent(`gone${k}`);
      const outside = newAgent(`out${k}`);
      for (const agent of [live, off, gone]) {
        addMember(app.db, channel.id, { memberType: "agent", memberId: agent.id }, app.logger);
      }
      app.db.update(agents).set({ enabled: false }).where(eq(agents.id, off.id)).run();
      app.db.update(agents).set({ archivedAt: new Date() }).where(eq(agents.id, gone.id)).run();
      await userWithRole(app, `person${k}`, "member");
      const bodyMd = [
        `@${live.handle} @${outside.handle.toUpperCase()} 점검`,
        `@${off.handle} @${gone.handle} @ghost${k} @person${k}`,
        `\`@codeonly${k}\` 와 @${outside.handle} 다시`,
      ].join("\n");
      const { automation } = await schedule(channel.id, { bodyMd });
      const expected = [
        { kind: "agent_not_in_channel", handle: outside.handle },
        { kind: "agent_disabled", handle: off.handle },
        { kind: "agent_disabled", handle: gone.handle },
        { kind: "unknown_handle", handle: `ghost${k}` },
      ];
      expect(automation.warnings).toEqual(expected);
      expect((await listed(automation.id))?.warnings).toEqual(expected);
    });

    it("핸들이 바뀌면 옛 핸들은 모르는 핸들, 에이전트가 채널에서 빠지면 채널에 없음 — 게시는 된다", async () => {
      const channel = newChannel();
      const agent = newAgent(`mover${++n}`);
      addMember(app.db, channel.id, { memberType: "agent", memberId: agent.id }, app.logger);
      const { automation } = await schedule(channel.id, { bodyMd: `@${agent.handle} 점검` });
      expect(automation.warnings).toEqual([]);

      app.db
        .update(agents)
        .set({ handle: `moved${n}` })
        .where(eq(agents.id, agent.id))
        .run();
      expect((await listed(automation.id))?.warnings).toEqual([
        { kind: "unknown_handle", handle: agent.handle },
      ]);

      app.db.update(agents).set({ handle: agent.handle }).where(eq(agents.id, agent.id)).run();
      const removed = await call({ method: "DELETE", url: `/channels/${channel.id}/members/${agent.id}` });
      expect(removed.statusCode, removed.body).toBe(200);
      expect((await listed(automation.id))?.warnings).toEqual([
        { kind: "agent_not_in_channel", handle: agent.handle },
      ]);
      expect((await call({ method: "POST", url: `/automations/${automation.id}/run` })).statusCode).toBe(202);
    });

    it("[Review Focus 5] 채널을 보관하면 「channel_archived」 경고", async () => {
      const channel = newChannel();
      const { automation } = await webhook(channel.id);
      app.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, channel.id)).run();
      expect((await listed(automation.id))?.warnings).toEqual([{ kind: "channel_archived" }]);
    });
  });
});
