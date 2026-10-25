/**
 * 예약 자동화 스케줄러·게시(자동화 스펙 「실행」 장) — 주입한 시계로 tick 을 돌리고 route 는 가짜다. 한 번만 게시는 claimRun 의
 * 조건부 UPDATE(계획 판정 PA3), 놓친 예약은 10분 안이면 한 번·넘으면 skipped, 게시 실패는 그 자동화만 error 로 남기고 틱은 이어 간다.
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { AutomationName, type AutomationSchedule, type Message, parseMentions } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import type { Db } from "../src/db/client";
import {
  channelMembers,
  channels,
  conversations,
  memberships,
  messages,
  runs,
  users,
} from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage, listMessages } from "../src/modules/messages/service";
import { patchOpsSettings } from "../src/modules/ops/settings";
import { createTriggerLookups } from "../src/modules/push/service";
import { targetsForMessage } from "../src/modules/push/triggers";
import { countRunsTodayInWorkspace } from "../src/modules/runs/store";
import type { Logger } from "../src/logger";
import { postAutomationMessage } from "../src/modules/automations/post";
import { getConversation } from "../src/modules/conversations/store";
import {
  MISSED_GRACE_MS,
  rescheduleAll,
  rescheduleOne,
  type SchedulerDeps,
  tick,
} from "../src/modules/automations/scheduler";
import {
  type NewAutomationRow,
  getAutomation,
  insertAutomation,
  updateAutomation,
} from "../src/modules/automations/store";
import { ServerBus } from "../src/realtime/bus";
import { bootTestApp } from "./helpers/app";
import { newTestDb } from "./helpers/db";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { channelConversation, seedChannelWithAgent } from "./helpers/seed";

const SEOUL = "Asia/Seoul";
/** 2026-10-07 수요일 09:05 KST */
const NOW = new Date("2026-10-07T00:05:00.000Z");
const kst = (iso: string) => new Date(`${iso}+09:00`);
const daily = (time: string): AutomationSchedule => ({ repeat: "daily", time });

function setup() {
  const db = newTestDb();
  const seed = seedChannelWithAgent(db);
  const bus = new ServerBus();
  const created: Message[] = [];
  bus.on("message.created", ({ message }) => created.push(message));
  const routed: Message[] = [];
  const route = vi.fn(async (m: Message) => {
    routed.push(m);
  });
  const record = vi.fn();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Logger;
  let timeZone = SEOUL;
  const deps: SchedulerDeps = { db, bus, route, logger, ops: { record }, timeZone: () => timeZone };
  let n = 0;
  const add = (over: Partial<NewAutomationRow> = {}) =>
    insertAutomation(db, {
      id: uuid(),
      workspaceId: seed.workspaceId,
      name: `자동화 ${++n}`,
      channelId: seed.channelId,
      kind: "schedule",
      bodyMd: "@dev 점검해 줘",
      enabled: true,
      scheduleJson: daily("09:00"),
      nextRunAt: kst("2026-10-07T09:00"),
      createdBy: seed.userId,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    });
  const row = (id: string) => getAutomation(db, seed.workspaceId, id);
  const posted = (automationId: string) =>
    db
      .select()
      .from(messages)
      .all()
      .filter((m) => m.authorType === "automation" && m.authorId === automationId);
  const eventsOf = (kind: string) =>
    record.mock.calls.map(([input]) => input).filter((input) => input.kind === kind);
  return {
    db,
    bus,
    seed,
    deps,
    route,
    routed,
    created,
    record,
    logger,
    add,
    row,
    posted,
    eventsOf,
    setTimeZone: (tz: string) => {
      timeZone = tz;
    },
  };
}

const channelConversations = (db: Db, channelId: string) =>
  db.select({ id: conversations.id }).from(conversations).where(eq(conversations.channelId, channelId)).all();

const archive = (db: Db, channelId: string) =>
  db.update(channels).set({ archivedAt: NOW }).where(eq(channels.id, channelId)).run();

describe("tick", () => {
  it("[Review Focus 1] 09:05 에 켜짐 — 09:00(5분 놓침)은 한 번 게시, 08:30(35분 놓침)은 skipped·사건 하나, 둘 다 다음 날로", async () => {
    const t = setup();
    const nine = t.add({ scheduleJson: daily("09:00"), nextRunAt: kst("2026-10-07T09:00") });
    const early = t.add({ scheduleJson: daily("08:30"), nextRunAt: kst("2026-10-07T08:30") });

    await tick(t.deps, NOW);

    expect(t.posted(nine.id)).toHaveLength(1);
    expect(t.row(nine.id)).toMatchObject({
      lastStatus: "ok",
      lastRunAt: NOW,
      nextRunAt: kst("2026-10-08T09:00"),
    });
    expect(t.posted(early.id)).toHaveLength(0);
    expect(t.row(early.id)).toMatchObject({ lastStatus: "skipped", nextRunAt: kst("2026-10-08T08:30") });
    expect(t.eventsOf("automation_skipped")).toEqual([
      expect.objectContaining({
        kind: "automation_skipped",
        key: `automation:${early.id}`,
        severity: "warn",
        detail: expect.objectContaining({ automationId: early.id }),
      }),
    ]);
    expect(t.eventsOf("automation_failed")).toEqual([]);
    // 게시한 글은 라우터로 간다 — 멘션 런은 라우터가 만든다
    expect(t.routed.map((m) => m.authorId)).toEqual([nine.id]);

    // 같은 now 로 다시(틱 겹침), 새 deps 로 또 다시(재부팅 두 번) — 09:00 은 여전히 한 번
    await tick(t.deps, NOW);
    await tick({ ...t.deps, route: vi.fn(async () => undefined) }, NOW);
    expect(t.posted(nine.id)).toHaveLength(1);
    expect(t.eventsOf("automation_skipped")).toHaveLength(1);
  });

  it("[PA3] 틱이 겹쳐도 한 회차는 한 번 — 앞 틱이 게시를 기다리는 사이 뒤 틱이 같은 행을 가져가면 앞 틱은 그 행을 건너뛴다", async () => {
    const t = setup();
    const first = t.add({ nextRunAt: kst("2026-10-07T09:00") });
    const second = t.add({ nextRunAt: kst("2026-10-07T09:01") });
    let release: () => void = () => undefined;
    const slowRoute = vi.fn((m: Message) =>
      m.authorId === first.id ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve(),
    );
    // 앞 틱은 두 행을 읽고 first 를 게시한 뒤 route 에서 멈춘다 — second 는 아직 가져가지 않았다
    const slow = tick({ ...t.deps, route: slowRoute }, NOW);
    expect(t.posted(first.id)).toHaveLength(1);
    // 뒤 틱이 second 를 가져가 게시한다
    await tick(t.deps, NOW);
    expect(t.posted(second.id)).toHaveLength(1);
    // 앞 틱이 이어 가며 읽어 둔 second 를 가져가려 하지만 next_run_at 이 이미 올라 있다
    release();
    await slow;
    expect(t.posted(first.id)).toHaveLength(1);
    expect(t.posted(second.id)).toHaveLength(1);
    expect(t.row(second.id)?.nextRunAt).toEqual(kst("2026-10-08T09:00"));
  });

  it("10분 경계 — 정확히 10분 늦으면 게시, 1ms 더 늦으면 skipped", async () => {
    const t = setup();
    const onEdge = t.add({ nextRunAt: new Date(NOW.getTime() - MISSED_GRACE_MS) });
    const past = t.add({ nextRunAt: new Date(NOW.getTime() - MISSED_GRACE_MS - 1) });
    expect(MISSED_GRACE_MS).toBe(10 * 60_000);

    await tick(t.deps, NOW);

    expect(t.posted(onEdge.id)).toHaveLength(1);
    expect(t.row(onEdge.id)?.lastStatus).toBe("ok");
    expect(t.posted(past.id)).toHaveLength(0);
    expect(t.row(past.id)?.lastStatus).toBe("skipped");
  });

  it("기한 전인 예약은 건드리지 않는다", async () => {
    const t = setup();
    const later = t.add({ nextRunAt: new Date(NOW.getTime() + 1) });
    await tick(t.deps, NOW);
    expect(t.posted(later.id)).toHaveLength(0);
    expect(t.row(later.id)).toMatchObject({ lastStatus: null, lastRunAt: null, nextRunAt: later.nextRunAt });
  });

  it("게시 중 예외(메시지는 저장된 뒤 route 가 던짐) → error·사건 automation_failed, next_run_at 은 다음 회차", async () => {
    const t = setup();
    const a = t.add();
    t.route.mockRejectedValueOnce(new Error("route boom"));

    await tick(t.deps, NOW);

    expect(t.posted(a.id)).toHaveLength(1);
    expect(t.row(a.id)).toMatchObject({ lastStatus: "error", nextRunAt: kst("2026-10-08T09:00") });
    expect(t.eventsOf("automation_failed")).toEqual([
      expect.objectContaining({
        key: `automation:${a.id}`,
        severity: "error",
        detail: expect.objectContaining({ automationId: a.id }),
      }),
    ]);
    // 다음 틱(같은 now)에 다시 돌지 않는다
    await tick(t.deps, NOW);
    expect(t.posted(a.id)).toHaveLength(1);
    expect(t.eventsOf("automation_failed")).toHaveLength(1);
  });

  it("꺼진 자동화·웹훅 종류는 건드리지 않는다", async () => {
    const t = setup();
    const off = t.add({ enabled: false });
    const hook = t.add({
      kind: "webhook",
      scheduleJson: null,
      tokenHash: "h".repeat(64),
      tokenPrefix: "abcdef",
    });
    await tick(t.deps, NOW);
    expect(t.posted(off.id)).toHaveLength(0);
    expect(t.posted(hook.id)).toHaveLength(0);
    expect(t.row(off.id)).toMatchObject({ lastStatus: null, nextRunAt: off.nextRunAt });
    expect(t.row(hook.id)).toMatchObject({ lastStatus: null, nextRunAt: hook.nextRunAt });
  });

  it("[Review Focus 5] 보관한 채널의 예약 — 게시 0·error·사건 automation_failed(code CHANNEL_ARCHIVED)·다음 시각으로, 같은 틱의 다른 예약은 게시", async () => {
    const t = setup();
    const other = seedChannelWithAgent(t.db, { channelName: "other" });
    const archived = t.add({
      channelId: other.channelId,
      workspaceId: other.workspaceId,
      createdBy: other.userId,
    });
    const fine = t.add({ nextRunAt: kst("2026-10-07T09:01") });
    archive(t.db, other.channelId);

    await tick(t.deps, NOW);

    expect(t.posted(archived.id)).toHaveLength(0);
    expect(getAutomation(t.db, other.workspaceId, archived.id)).toMatchObject({
      lastStatus: "error",
      nextRunAt: kst("2026-10-08T09:00"),
    });
    expect(t.eventsOf("automation_failed")).toEqual([
      expect.objectContaining({
        key: `automation:${archived.id}`,
        detail: { automationId: archived.id, code: "CHANNEL_ARCHIVED" },
      }),
    ]);
    expect(t.posted(fine.id)).toHaveLength(1);
    expect(t.row(fine.id)?.lastStatus).toBe("ok");
  });

  it("다음 시각을 셀 수 없는 자동화(망가진 예약)는 그 자동화만 error·사건·멈춤 — 틱은 이어 가고 매분 되풀이하지 않는다", async () => {
    const t = setup();
    // weekday 가 빠진 weekly — 맞는 날이 없어 nextRunAt 이 던진다(저장 경계가 막지만 DB 를 직접 고친 경우)
    const broken = t.add({
      scheduleJson: { repeat: "weekly", time: "09:00" } as unknown as AutomationSchedule,
    });
    const fine = t.add({ nextRunAt: kst("2026-10-07T09:01") });

    await tick(t.deps, NOW);

    expect(t.posted(broken.id)).toHaveLength(0);
    expect(t.row(broken.id)).toMatchObject({ lastStatus: "error", nextRunAt: null });
    expect(t.eventsOf("automation_failed")).toEqual([
      expect.objectContaining({ key: `automation:${broken.id}` }),
    ]);
    expect(t.posted(fine.id)).toHaveLength(1);

    await tick(t.deps, new Date(NOW.getTime() + 60_000));
    expect(t.eventsOf("automation_failed")).toHaveLength(1);
  });

  it("한 자동화의 결과를 적다 던져도(사건 기록 실패) 틱은 던지지 않고 다음 자동화를 게시한다", async () => {
    const t = setup();
    const other = seedChannelWithAgent(t.db, { channelName: "other" });
    t.add({ channelId: other.channelId, workspaceId: other.workspaceId, createdBy: other.userId });
    const fine = t.add({ nextRunAt: kst("2026-10-07T09:01") });
    archive(t.db, other.channelId);
    t.record.mockImplementationOnce(() => {
      throw new Error("record boom");
    });

    await expect(tick(t.deps, NOW)).resolves.toBeUndefined();

    expect(t.posted(fine.id)).toHaveLength(1);
    expect(t.row(fine.id)?.lastStatus).toBe("ok");
  });

  it("시간대가 Intl 이 모르는 이름이어도 틱은 던지지 않는다 — 자동화마다 error·사건", async () => {
    const t = setup();
    const a = t.add();
    const b = t.add({ nextRunAt: kst("2026-10-07T09:01") });
    t.setTimeZone("Mars/Base");

    await expect(tick(t.deps, NOW)).resolves.toBeUndefined();

    expect(t.posted(a.id)).toHaveLength(0);
    expect(t.posted(b.id)).toHaveLength(0);
    expect(t.row(a.id)?.lastStatus).toBe("error");
    expect(t.row(b.id)?.lastStatus).toBe("error");
    expect(t.eventsOf("automation_failed").map((e) => e.key)).toEqual([
      `automation:${a.id}`,
      `automation:${b.id}`,
    ]);
  });
});

describe("rescheduleOne", () => {
  it("[Review Focus 4] 끈 상태에서 예약을 과거 시각으로 바꾸고 켜면 다음 시각은 켜는 순간 뒤의 첫 회차 — 바로 게시되지 않는다", async () => {
    const t = setup();
    const a = t.add({ enabled: false, nextRunAt: null });
    const tenAm = kst("2026-10-07T10:00");
    // 태스크 3 의 PATCH 가 하는 꼴 — 칸을 바꾸고 rescheduleOne
    updateAutomation(t.db, t.seed.workspaceId, a.id, { enabled: true, scheduleJson: daily("09:30") });
    rescheduleOne(t.db, t.seed.workspaceId, a.id, SEOUL, tenAm);

    expect(t.row(a.id)?.nextRunAt).toEqual(kst("2026-10-08T09:30"));
    await tick(t.deps, tenAm);
    expect(t.posted(a.id)).toHaveLength(0);
  });

  it("꺼졌거나 웹훅이면 null, 켜진 예약이면 now 뒤 첫 회차", () => {
    const t = setup();
    const off = t.add({ enabled: false });
    const hook = t.add({ kind: "webhook", scheduleJson: null, nextRunAt: NOW });
    const on = t.add({ nextRunAt: null, scheduleJson: { repeat: "hourly", minute: 15 } });
    for (const id of [off.id, hook.id, on.id]) rescheduleOne(t.db, t.seed.workspaceId, id, SEOUL, NOW);
    expect(t.row(off.id)?.nextRunAt).toBeNull();
    expect(t.row(hook.id)?.nextRunAt).toBeNull();
    expect(t.row(on.id)?.nextRunAt).toEqual(kst("2026-10-07T09:15"));
  });

  it("다른 워크스페이스의 id 면 NOT_FOUND 이고 아무 행도 바꾸지 않는다", () => {
    const t = setup();
    const other = seedChannelWithAgent(t.db, { channelName: "other" });
    const a = t.add({ nextRunAt: null });
    expect(() => rescheduleOne(t.db, other.workspaceId, a.id, SEOUL, NOW)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(t.row(a.id)?.nextRunAt).toBeNull();
  });
});

describe("rescheduleAll", () => {
  it("시간대를 바꾸면 그 워크스페이스의 켜진 예약만 새 시간대로 다시 센다 — 꺼진 것·웹훅·다른 워크스페이스는 그대로", () => {
    const t = setup();
    const other = seedChannelWithAgent(t.db, { channelName: "other" });
    const on = t.add();
    const off = t.add({ enabled: false, nextRunAt: null });
    const hook = t.add({ kind: "webhook", scheduleJson: null, nextRunAt: null });
    const elsewhere = t.add({
      workspaceId: other.workspaceId,
      channelId: other.channelId,
      createdBy: other.userId,
    });

    rescheduleAll(t.db, t.seed.workspaceId, "America/New_York", NOW);

    // NOW = 2026-10-06 20:05 EDT → 다음 09:00 EDT 는 2026-10-07 13:00Z
    expect(t.row(on.id)?.nextRunAt).toEqual(new Date("2026-10-07T13:00:00.000Z"));
    expect(t.row(off.id)?.nextRunAt).toBeNull();
    expect(t.row(hook.id)?.nextRunAt).toBeNull();
    expect(getAutomation(t.db, other.workspaceId, elsewhere.id)?.nextRunAt).toEqual(elsewhere.nextRunAt);
  });

  it("다음 시각이 비어 있던 켜진 예약(셀 수 없어 멈춘 것)도 다시 센다", () => {
    const t = setup();
    const stalled = t.add({ nextRunAt: null });
    rescheduleAll(t.db, t.seed.workspaceId, SEOUL, NOW);
    expect(t.row(stalled.id)?.nextRunAt).toEqual(kst("2026-10-08T09:00"));
  });
});

describe("postAutomationMessage", () => {
  it("문구(+ 웹훅 블록)를 채널 최상위에 자동화 작성자로 게시하고 라우터에 넘긴다", async () => {
    const t = setup();
    const a = t.add({ bodyMd: "@dev 배포 알림" });
    const message = await postAutomationMessage(t.deps, a, "```json\n{}\n```");
    expect(message).toMatchObject({
      kind: "normal",
      authorType: "automation",
      authorId: a.id,
      channelId: t.seed.channelId,
      bodyMd: `<@a:${t.seed.agentId}> 배포 알림\n\n\`\`\`json\n{}\n\`\`\``,
      mentions: { agents: [t.seed.agentId], users: [] },
    });
    expect(message.threadRootId).toBeUndefined();
    expect(t.routed).toEqual([message]);
    expect(t.created.map((m) => m.id)).toEqual([message.id]);
    // 블록이 없으면 문구만
    expect((await postAutomationMessage(t.deps, a)).bodyMd).toBe(`<@a:${t.seed.agentId}> 배포 알림`);
  });

  it("웹훅 원문은 멘션이 아니다 — 블록 안의 리터럴 토큰은 멘션으로 읽히지 않고, 늘린 펜스 안의 @핸들은 토큰화하지 않는다(참여·푸시 0)", async () => {
    const t = setup();
    const mia = uuid();
    t.db
      .insert(users)
      .values({
        id: mia,
        workspaceId: t.seed.workspaceId,
        handle: "mia",
        displayName: "mia",
        authProvider: "local",
        createdAt: NOW,
      })
      .run();
    t.db
      .insert(memberships)
      .values({ id: uuid(), workspaceId: t.seed.workspaceId, userId: mia, role: "member" })
      .run();
    const joins: string[] = [];
    t.bus.on("channel.member.changed", (p) => joins.push(p.channelId));
    const hook = t.add({
      kind: "webhook",
      scheduleJson: null,
      nextRunAt: null,
      tokenHash: "h".repeat(64),
      tokenPrefix: "abcdef",
      bodyMd: "새 이벤트",
    });
    // 펜스를 늘린 블록 — 안의 ``` 뒤가 토큰화 경계(splitCode)에서 코드 밖으로 읽힌다
    const extraMd = `\`\`\`\`json\n{"by":"<@a:${t.seed.agentId}> <@u:${mia}>","log":"\`\`\` @dev @mia"}\n\`\`\`\``;

    const message = await postAutomationMessage(t.deps, hook, extraMd);

    expect(message.mentions).toEqual({ agents: [], users: [] });
    expect(parseMentions(message.bodyMd)).toEqual({ agents: [], users: [] });
    // 보이는 글자는 원문 그대로 — 멘션 토큰 꼴만 읽히지 않게 바뀐다
    expect(message.bodyMd.replaceAll("\u2060", "")).toBe(`새 이벤트\n\n${extraMd}`);
    expect(joins).toEqual([]);
    expect(
      t.db
        .select()
        .from(channelMembers)
        .all()
        .some((m) => m.memberId === mia),
    ).toBe(false);
    expect(targetsForMessage(message, createTriggerLookups(t.db, t.seed.workspaceId))).toEqual([]);
  });

  it("문구의 멘션은 원문 블록과 함께여도 그대로 — 멘션은 문구에서만 나온다", async () => {
    const t = setup();
    const hook = t.add({
      kind: "webhook",
      scheduleJson: null,
      nextRunAt: null,
      tokenHash: "h".repeat(64),
      tokenPrefix: "abcdef",
      bodyMd: "@dev 봐 줘",
    });
    const message = await postAutomationMessage(
      t.deps,
      hook,
      `\`\`\`text\n<@u:${t.seed.userId}> @owner\n\`\`\``,
    );
    expect(message.mentions).toEqual({ agents: [t.seed.agentId], users: [] });
    expect(parseMentions(message.bodyMd)).toEqual(message.mentions);
  });

  it("보관한 채널이면 CHANNEL_ARCHIVED 로 던지고 저장·라우팅이 없다 — 자기 세션도 만들지 않는다", async () => {
    const t = setup();
    const a = t.add();
    const before = channelConversations(t.db, t.seed.channelId);
    archive(t.db, t.seed.channelId);
    await expect(postAutomationMessage(t.deps, a)).rejects.toMatchObject({
      status: 409,
      body: { code: "CHANNEL_ARCHIVED" },
    });
    expect(t.posted(a.id)).toHaveLength(0);
    expect(t.route).not.toHaveBeenCalled();
    expect(channelConversations(t.db, t.seed.channelId)).toEqual(before);
    expect(t.row(a.id)?.conversationId).toBeNull();
  });

  describe("자기 세션(채널 세션 스펙 「자동화」 절)", () => {
    const events = (bus: ServerBus) => {
      const seen: string[] = [];
      bus.on("conversation.created", ({ conversation }) => seen.push(`conversation:${conversation.id}`));
      bus.on("message.created", ({ message }) => seen.push(`message:${message.conversationId}`));
      return seen;
    };

    it("첫 게시가 「⚙ <이름>」 세션을 만들어 달고 conversation.created 를 메시지 앞에 낸다 — 채널의 최근 세션이 아니라 그 세션에 이어 쓴다", async () => {
      const t = setup();
      const seen = events(t.bus);
      const a = t.add({ name: "아침 점검" });
      const first = await postAutomationMessage(t.deps, a);
      const own = t.row(a.id)?.conversationId;
      expect(own).toBe(first.conversationId);
      expect(own).not.toBe(t.seed.conversationId);
      expect(
        t.db
          .select()
          .from(conversations)
          .where(eq(conversations.id, own ?? ""))
          .get(),
      ).toMatchObject({
        channelId: t.seed.channelId,
        title: "⚙ 아침 점검",
        titleSource: "user",
        createdByType: "automation",
        createdById: a.id,
        closedAt: null,
      });
      expect(seen).toEqual([`conversation:${own}`, `message:${own}`]);

      // 사람이 채널의 다른 세션에서 더 최근에 말해도 자동화는 자기 세션에 — 새 세션을 또 만들지 않는다
      createUserMessage(t.db, t.bus, {
        conversationId: t.seed.conversationId,
        authorId: t.seed.userId,
        bodyMd: "사람의 글",
        clientMsgId: uuid(),
      });
      const second = await postAutomationMessage(t.deps, (t.row(a.id) ?? a) as typeof a);
      expect(second.conversationId).toBe(own);
      // 옛 행(conversation_id 가 비어 있던 스냅숏)을 넘겨도 트랜잭션 안에서 다시 읽는다
      const third = await postAutomationMessage(t.deps, a);
      expect(third.conversationId).toBe(own);
      expect(seen.filter((e) => e.startsWith("conversation:"))).toHaveLength(1);
      expect(channelConversations(t.db, t.seed.channelId)).toHaveLength(2);
    });

    it("세션 제목은 UTF-16 80 단위 안 — 이모지가 든 40자 이름(「⚙ 」를 붙이면 81)은 서로게이트 쌍을 가르지 않고 자른다", async () => {
      const t = setup();
      // 「⚙ a」 3 단위 + 이모지 39개 78 단위 = 81 — 80 에서 자르면 마지막 이모지의 쌍이 갈린다
      const name = `a${"😀".repeat(39)}`;
      expect(AutomationName.safeParse(name).success).toBe(true);
      const a = t.add({ name });
      const first = await postAutomationMessage(t.deps, a);
      const title = getConversation(t.db, first.conversationId)?.title ?? "";
      expect(title).toBe(`⚙ a${"😀".repeat(38)}`);
      expect(title.length).toBe(79);
    });

    it("자기 세션이 닫혀 있으면 새 세션을 만들어 바꿔 단다", async () => {
      const t = setup();
      const a = t.add({ name: "주간" });
      const first = await postAutomationMessage(t.deps, a);
      t.db
        .update(conversations)
        .set({ closedAt: NOW, closedBy: t.seed.userId })
        .where(eq(conversations.id, first.conversationId))
        .run();
      const seen = events(t.bus);
      const next = await postAutomationMessage(t.deps, a);
      expect(next.conversationId).not.toBe(first.conversationId);
      expect(t.row(a.id)?.conversationId).toBe(next.conversationId);
      expect(seen).toEqual([`conversation:${next.conversationId}`, `message:${next.conversationId}`]);
    });

    it("채널을 바꾼 자동화는 새 채널에 자기 세션을 새로 만든다 — 옛 채널의 세션에 쓰지 않는다", async () => {
      const t = setup();
      const a = t.add();
      const first = await postAutomationMessage(t.deps, a);
      const other = createChannel(t.db, {
        workspaceId: t.seed.workspaceId,
        createdBy: t.seed.userId,
        name: "other",
      });
      const moved = updateAutomation(t.db, t.seed.workspaceId, a.id, { channelId: other.id });
      const next = await postAutomationMessage(t.deps, moved);
      expect(next.channelId).toBe(other.id);
      expect(next.conversationId).not.toBe(first.conversationId);
      expect(t.row(a.id)?.conversationId).toBe(next.conversationId);
    });

    it("세션 정책이 「세션 관리자만」인 채널에도 게시한다 — 정책은 자동화에 걸지 않는다", async () => {
      const t = setup();
      t.db
        .update(channels)
        .set({ sessionPolicy: { create: "managers" } })
        .where(eq(channels.id, t.seed.channelId))
        .run();
      const a = t.add();
      const message = await postAutomationMessage(t.deps, a);
      expect(t.row(a.id)?.conversationId).toBe(message.conversationId);
    });
  });
});

describe("실제 라우터·런 관문으로 (FakeAdapter)", () => {
  let app: App;
  let adapter: FakeAdapter;
  let agentId: string;
  let n = 0;

  beforeAll(async () => {
    adapter = new FakeAdapter();
    // 부팅·주기 틱이 이 테스트의 행을 먼저 가져가지 않게 주기를 늘린다 — 틱은 여기서 손으로 돈다
    app = await bootTestApp({}, { adapters: [adapter], automationTickMs: 3_600_000 });
    agentId = createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
    }).id;
  });
  afterAll(async () => {
    await app.close();
  });

  const deps = (): SchedulerDeps => ({
    db: app.db,
    bus: app.bus,
    logger: app.logger,
    ops: app.ops,
    route: (m) => app.services.router.routeMessage(m),
    timeZone: () => SEOUL,
  });
  const due = (bodyMd: string) => {
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: `auto-real-${++n}`,
    });
    addMember(app.db, channel.id, { memberType: "agent", memberId: agentId }, app.logger);
    const automation = insertAutomation(app.db, {
      id: uuid(),
      workspaceId: app.workspaceId,
      name: `실제 ${n}`,
      channelId: channel.id,
      kind: "schedule",
      bodyMd,
      enabled: true,
      scheduleJson: daily("09:00"),
      nextRunAt: new Date(Date.now() - 60_000),
      createdBy: app.ownerUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { channelId: channel.id, automation };
  };
  const runsFor = (messageId: string) =>
    app.db.select().from(runs).where(eq(runs.triggerMessageId, messageId)).all();
  const automationPosts = (channelId: string) =>
    listMessages(app.db, channelId, { limit: 50 }).messages.filter((m) => m.authorType === "automation");

  it("문구의 @dev 는 멘션 런 하나 — 인바운드 보낸 사람은 system:automation 「자동화 <이름>」", async () => {
    const { channelId, automation } = due("@dev 점검해 줘");
    await tick(deps(), new Date());
    const [posted] = automationPosts(channelId);
    expect(posted).toBeDefined();
    expect(runsFor(posted?.id as string)).toEqual([
      expect.objectContaining({ agentId, triggerKind: "mention", relayDepth: 0 }),
    ]);
    await vi.waitFor(() =>
      expect(adapter.calls.send.find((s) => s.message.id === posted?.id)?.message.author).toEqual({
        type: "system",
        handle: "automation",
        displayName: `자동화 ${automation.name}`,
      }),
    );
  });

  it("멘션 없는 문구 + 자동 응답 에이전트 → 게시는 되고 런 없음", async () => {
    const { channelId } = due("오늘도 좋은 하루");
    app.db
      .update(channelMembers)
      .set({ autoRespond: true })
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.memberId, agentId)))
      .run();
    await tick(deps(), new Date());
    const [posted] = automationPosts(channelId);
    expect(posted).toBeDefined();
    expect(runsFor(posted?.id as string)).toEqual([]);
  });

  it("웹훅 원문 속 멘션(리터럴 토큰·늘린 펜스의 @dev)은 런을 만들지 않는다", async () => {
    const { channelId, automation } = due("웹훅 알림");
    // 이 행은 손으로 게시한다 — 뒤 사례의 틱이 다시 가져가지 않게 끈다
    updateAutomation(app.db, app.workspaceId, automation.id, { enabled: false, nextRunAt: null });
    const posted = await postAutomationMessage(
      { db: app.db, bus: app.bus, logger: app.logger, route: (m) => app.services.router.routeMessage(m) },
      automation,
      `\`\`\`\`text\n<@a:${agentId}>\n\`\`\` @dev\n\`\`\`\``,
    );
    expect(automationPosts(channelId).map((m) => m.id)).toEqual([posted.id]);
    expect(runsFor(posted.id)).toEqual([]);
    expect(adapter.calls.send.some((s) => s.message.id === posted.id)).toBe(false);
  });

  it("런 한도에 막혀도 게시한다 — last_status ok·한도 알림, 런은 없다", async () => {
    const { channelId, automation } = due("@dev 한도 확인");
    const filler = due("채우기용");
    patchOpsSettings(app.db, app.workspaceId, {
      dailyRunLimit: countRunsTodayInWorkspace(app.db, new Date()) + 1,
    });
    try {
      // 다른 채널의 사람 멘션 하나로 한도를 채운다 — 이 채널의 한도 알림은 자동화 글의 멘션이 막혀서만 생긴다
      const human = createUserMessage(app.db, app.bus, {
        conversationId: channelConversation(app.db, filler.channelId),
        authorId: app.ownerUserId,
        bodyMd: "@dev 먼저",
        clientMsgId: uuid(),
      });
      await app.services.router.routeMessage(human);
      expect(runsFor(human.id)).toHaveLength(1);

      await tick(deps(), new Date());

      const [posted] = automationPosts(channelId);
      expect(posted).toBeDefined();
      expect(getAutomation(app.db, app.workspaceId, automation.id)?.lastStatus).toBe("ok");
      expect(runsFor(posted?.id as string)).toEqual([]);
      const notices = listMessages(app.db, channelId, { limit: 50 }).messages.filter(
        (m) => m.systemMeta?.kind === "run_limit",
      );
      expect(notices).toHaveLength(1);
    } finally {
      patchOpsSettings(app.db, app.workspaceId, { dailyRunLimit: null });
    }
  });
});
