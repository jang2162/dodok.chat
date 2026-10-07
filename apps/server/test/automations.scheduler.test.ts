/**
 * 예약 자동화 스케줄러·게시(자동화 스펙 「실행」 장) — 주입한 시계로 tick 을 돌리고 route 는 가짜다. 한 번만 게시는 claimRun 의
 * 조건부 UPDATE(계획 판정 PA3), 놓친 예약은 10분 안이면 한 번·넘으면 skipped, 게시 실패는 그 자동화만 error 로 남기고 틱은 이어 간다.
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import type { AutomationSchedule, Message } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import type { Db } from "../src/db/client";
import { channelMembers, channels, messages, runs } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage, listMessages } from "../src/modules/messages/service";
import { patchOpsSettings } from "../src/modules/ops/settings";
import { countRunsTodayInWorkspace } from "../src/modules/runs/store";
import type { Logger } from "../src/logger";
import { postAutomationMessage } from "../src/modules/automations/post";
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
import { seedChannelWithAgent } from "./helpers/seed";

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

  it("보관한 채널이면 CHANNEL_ARCHIVED 로 던지고 저장·라우팅이 없다", async () => {
    const t = setup();
    const a = t.add();
    archive(t.db, t.seed.channelId);
    await expect(postAutomationMessage(t.deps, a)).rejects.toMatchObject({
      status: 409,
      body: { code: "CHANNEL_ARCHIVED" },
    });
    expect(t.posted(a.id)).toHaveLength(0);
    expect(t.route).not.toHaveBeenCalled();
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

  it("런 한도에 막혀도 게시한다 — last_status ok·한도 알림, 런은 없다", async () => {
    const { channelId, automation } = due("@dev 한도 확인");
    const filler = due("채우기용");
    patchOpsSettings(app.db, app.workspaceId, {
      dailyRunLimit: countRunsTodayInWorkspace(app.db, new Date()) + 1,
    });
    try {
      // 다른 채널의 사람 멘션 하나로 한도를 채운다 — 이 채널의 한도 알림은 자동화 글의 멘션이 막혀서만 생긴다
      const human = createUserMessage(app.db, app.bus, {
        channelId: filler.channelId,
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
