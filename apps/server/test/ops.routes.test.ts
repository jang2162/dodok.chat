import { OPENCLAW_PINNED_VERSION, type OpenClawSetupDetail } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { OpsEventsPage, OpsRunsSummary, OpsStatus } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { opsEvents, runs, workspaces } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { createChannel } from "../src/modules/channels/service";
import { getOpsSettings } from "../src/modules/ops/settings";
import { nextRunAt } from "../src/modules/automations/schedule";
import { type NewAutomationRow, getAutomation, insertAutomation } from "../src/modules/automations/store";
import { insertRun } from "../src/modules/runs/store";
import packageJson from "../package.json" with { type: "json" };
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID, fakeGatewayStatus } from "./helpers/gateways";

type Method = "GET" | "POST" | "PATCH";

describe("운영 API /api/v1/ops", () => {
  let app: App;
  let adapter: FakeAdapter;
  let owner: { authorization: string };
  let ownerId: string;
  let member: { authorization: string };
  let admin: { authorization: string };

  beforeAll(async () => {
    adapter = new FakeAdapter();
    app = await bootTestApp({}, { adapters: [adapter] });
    const session = await login(app);
    owner = session.headers;
    ownerId = app.ownerUserId;
    member = { authorization: `Bearer ${(await userWithRole(app, "bee", "member")).token}` };
    admin = { authorization: `Bearer ${(await userWithRole(app, "ada", "admin")).token}` };
  });
  afterAll(async () => {
    await app.close();
  });
  // 테스트마다 사건을 비운다 — 먼저 서비스로 확인 처리해 unacked 캐시를 0 으로 맞춘 뒤 지운다(확인한 줄은 unacked 에 없다)
  beforeEach(() => {
    app.ops.ack();
    app.db.delete(opsEvents).run();
  });

  const call = (headers: Record<string, string> | undefined, method: Method, url: string, payload?: object) =>
    app.fastify.inject({
      method,
      url: `/api/v1/ops${url}`,
      ...(headers ? { headers } : {}),
      ...(payload === undefined ? {} : { payload }),
    });

  const detail = (version: string | null): OpenClawSetupDetail => ({
    ...adapter.setupDetail(),
    gateway: { ...adapter.setupDetail().gateway, version },
  });

  it("member 는 다섯 경로 모두 403, 세션이 없으면 401 — member 의 PATCH 는 설정을 바꾸지 않는다", async () => {
    const routes: Array<[Method, string, object?]> = [
      ["GET", "/status"],
      ["GET", "/runs?days=1"],
      ["GET", "/events"],
      ["POST", "/events/ack"],
      ["PATCH", "/settings", { dailyRunLimit: 7 }],
    ];
    app.ops.record({ kind: "run_failed", key: "agent:x", severity: "warn" });
    for (const [method, url, body] of routes) {
      const forbidden = await call(member, method, url, body);
      expect(forbidden.statusCode, `${method} ${url}`).toBe(403);
      expect(forbidden.json().code).toBe("FORBIDDEN");
      expect((await call(undefined, method, url, body)).statusCode, `${method} ${url}`).toBe(401);
    }
    expect(getOpsSettings(app.db, app.workspaceId).dailyRunLimit).toBe(300);
    expect(app.ops.unacked()).toEqual({ warn: 1, error: 0 });
  });

  it("admin 은 다섯 경로 모두 통과한다(팀 스펙 「역할과 권한」 — 운영 화면은 admin 이상)", async () => {
    app.ops.record({ kind: "run_failed", key: "agent:x", severity: "warn" });
    for (const [method, url, body] of [
      ["GET", "/status"],
      ["GET", "/runs?days=1"],
      ["GET", "/events"],
      ["POST", "/events/ack"],
      ["PATCH", "/settings", { dailyRunLimit: 7 }],
    ] as Array<[Method, string, object?]>) {
      expect((await call(admin, method, url, body)).statusCode, `${method} ${url}`).toBe(200);
    }
    expect(getOpsSettings(app.db, app.workspaceId).dailyRunLimit).toBe(7);
    expect(app.ops.unacked()).toEqual({ warn: 0, error: 0 });
    await call(owner, "PATCH", "/settings", { dailyRunLimit: 300 });
  });

  describe("GET /status", () => {
    it("계약 모양 — /healthz 에서 뺀 워크스페이스 id·어댑터 상세, 서버 버전, 기본 상한 300, 디스크 수치", async () => {
      adapter.setGatewayState({ gateway: "reconnecting", bridge: "down" });
      const res = await call(owner, "GET", "/status");
      expect(res.statusCode).toBe(200);
      const status = OpsStatus.parse(res.json());
      expect(status.workspaceId).toBe(app.workspaceId);
      expect(status.adapter).toEqual({
        provider: "openclaw",
        gateways: [fakeGatewayStatus({ gateway: "reconnecting", bridge: "down" })],
      });
      expect(status.gateways).toEqual([
        {
          id: FAKE_GATEWAY_ID,
          name: "가짜 Gateway",
          enabled: true,
          gateway: { state: "reconnecting", version: null, pinned: OPENCLAW_PINNED_VERSION, drift: false },
          plugin: { state: "down" },
        },
      ]);
      expect(status.server.version).toBe(packageJson.version);
      expect(Date.parse(status.server.startedAt)).toBeLessThanOrEqual(Date.now());
      expect(status.dailyRunLimit).toBe(300);
      // helpers/app plentyOfDisk: bavail 2^20·blocks 2^21 블록, 4096 바이트
      expect(status.disk).toEqual({ level: "ok", freeBytes: 2 ** 20 * 4096, totalBytes: 2 ** 21 * 4096 });
      expect(status.db.bytes).toBeGreaterThan(0);
      adapter.setGatewayState({ gateway: "connected", bridge: "connected" });
    });

    it("Gateway 버전·핀·드리프트 — 모르면(null) 드리프트 아님", async () => {
      const gatewayOf = async () =>
        OpsStatus.parse((await call(owner, "GET", "/status")).json()).gateways[0]?.gateway;
      adapter.setSetupDetail(detail("2026.9.5"));
      expect(await gatewayOf()).toMatchObject({
        version: "2026.9.5",
        pinned: OPENCLAW_PINNED_VERSION,
        drift: true,
      });
      adapter.setSetupDetail(detail(OPENCLAW_PINNED_VERSION));
      expect(await gatewayOf()).toMatchObject({ version: OPENCLAW_PINNED_VERSION, drift: false });
      adapter.setSetupDetail(detail(null));
      expect(await gatewayOf()).toMatchObject({ version: null, drift: false });
    });

    it("직전 종료 — 표지를 받기 전엔 null, main 이 넘긴 값을 그대로", async () => {
      const previousOf = async () =>
        OpsStatus.parse((await call(owner, "GET", "/status")).json()).server.previousClean;
      expect(await previousOf()).toBeNull();
      app.setPreviousClean(false);
      expect(await previousOf()).toBe(false);
      app.setPreviousClean(true);
      expect(await previousOf()).toBe(true);
    });

    it("오늘 런 수·오늘 워크스페이스 차단 수·확인 안 한 사건 수", async () => {
      const channel = createChannel(app.db, {
        workspaceId: app.workspaceId,
        createdBy: ownerId,
        name: `s${uuid()}`,
      });
      const agent = createAgent(app.db, {
        workspaceId: app.workspaceId,
        providerAgentId: `a${uuid()}`,
        handle: "alpha",
        name: "A",
      });
      const before = OpsStatus.parse((await call(owner, "GET", "/status")).json()).runsToday;
      for (let i = 0; i < 2; i++)
        insertRun(app.db, {
          channelId: channel.id,
          agentId: agent.id,
          triggerKind: "mention",
          rootMessageId: uuid(),
          relayDepth: 0,
          sessionKey: "k",
          createdAt: new Date(),
        });
      app.ops.record({ kind: "run_limit", key: "workspace", severity: "warn", detail: { limit: 1 } });
      app.ops.record({ kind: "run_limit", key: "workspace", severity: "warn", detail: { limit: 1 } });
      app.ops.record({
        kind: "run_limit",
        key: `channel:${channel.id}`,
        severity: "warn",
        detail: { limit: 1 },
      });
      app.ops.record({ kind: "crash_rejection", key: "process", severity: "error" });
      // 어제 끝난 워크스페이스 차단 줄 — 오늘 수에 들어가지 않는다. 확인한 줄로 넣어 unacked 캐시와 어긋나지 않게 한다
      const now = new Date();
      const lastNight = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999);
      app.db
        .insert(opsEvents)
        .values({
          id: uuid(),
          workspaceId: app.workspaceId,
          kind: "run_limit",
          severity: "warn",
          key: "workspace",
          detail: { limit: 1 },
          count: 5,
          firstAt: lastNight,
          lastAt: lastNight,
          ackedAt: lastNight,
        })
        .run();
      const status = OpsStatus.parse((await call(owner, "GET", "/status")).json());
      expect(status.runsToday).toBe(before + 2);
      expect(status.blockedToday).toBe(2); // 채널 한도 차단은 런 표의 행에만
      expect(status.unacked).toEqual({ warn: 2, error: 1 });
      app.db.delete(runs).run();
    });

    it("응답이 계약을 어기면 500 INTERNAL(서버 버그) — 어긴 값을 내보내지 않는다", async () => {
      adapter.setGatewayState({ gateway: "bogus" } as never);
      const res = await call(owner, "GET", "/status");
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe("INTERNAL");
      expect(res.body).not.toContain("bogus");
      adapter.setGatewayState({ gateway: "connected", bridge: "connected" });
    });
  });

  describe("PATCH /settings", () => {
    const limitNow = async () => OpsStatus.parse((await call(owner, "GET", "/status")).json()).dailyRunLimit;

    it("1~10000 과 null(무제한)을 저장하고 status 에 반영한다 — 응답은 바꾼 뒤의 설정 전체", async () => {
      const res = await call(owner, "PATCH", "/settings", { dailyRunLimit: 5 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dailyRunLimit: 5, timeZone: "Asia/Seoul" });
      expect(await limitNow()).toBe(5);
      expect((await call(owner, "PATCH", "/settings", { dailyRunLimit: null })).json()).toEqual({
        dailyRunLimit: null,
        timeZone: "Asia/Seoul",
      });
      expect(await limitNow()).toBeNull();
      expect((await call(owner, "PATCH", "/settings", { dailyRunLimit: 10_000 })).statusCode).toBe(200);
      expect(await limitNow()).toBe(10_000);
    });

    it("범위 밖·소수·문자열·빠진 키는 400 VALIDATION 이고 저장하지 않는다", async () => {
      await call(owner, "PATCH", "/settings", { dailyRunLimit: 42 });
      for (const body of [
        { dailyRunLimit: 0 },
        { dailyRunLimit: 10_001 },
        { dailyRunLimit: 1.5 },
        { dailyRunLimit: "9" },
        {},
      ]) {
        const res = await call(owner, "PATCH", "/settings", body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().code).toBe("VALIDATION");
      }
      expect(await limitNow()).toBe(42);
    });
  });

  describe("PATCH /settings — 시간대(자동화 스펙 「워크스페이스 시간대」 절, 계획 판정 PA4)", () => {
    const now = new Date();
    const wallInNewYork = (d: Date) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
    const addAutomation = (name: string, over: Partial<NewAutomationRow> = {}) => {
      const channel = createChannel(app.db, {
        workspaceId: app.workspaceId,
        createdBy: ownerId,
        name: `tz-${uuid()}`,
      });
      return insertAutomation(app.db, {
        id: uuid(),
        workspaceId: app.workspaceId,
        name,
        channelId: channel.id,
        kind: "schedule",
        bodyMd: "점검",
        enabled: true,
        scheduleJson: { repeat: "daily", time: "09:00" },
        nextRunAt: nextRunAt({ repeat: "daily", time: "09:00" }, "Asia/Seoul", now),
        createdBy: ownerId,
        createdAt: now,
        updatedAt: now,
        ...over,
      });
    };
    const settings = () => getOpsSettings(app.db, app.workspaceId);
    afterAll(async () => {
      await call(owner, "PATCH", "/settings", { dailyRunLimit: 300, timeZone: "Asia/Seoul" });
    });

    it("timeZone 만 보내도 저장하고 한도는 그대로 — 켜진 예약의 다음 시각을 새 시간대로 다시 센다", async () => {
      await call(owner, "PATCH", "/settings", { dailyRunLimit: 42, timeZone: "Asia/Seoul" });
      const on = addAutomation(`켜짐-${uuid()}`);
      const off = addAutomation(`꺼짐-${uuid()}`, { enabled: false, nextRunAt: null });
      const res = await call(owner, "PATCH", "/settings", { timeZone: "America/New_York" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dailyRunLimit: 42, timeZone: "America/New_York" });
      expect(settings()).toEqual({ dailyRunLimit: 42, timeZone: "America/New_York" });
      const moved = getAutomation(app.db, app.workspaceId, on.id)?.nextRunAt;
      expect(moved).not.toEqual(on.nextRunAt);
      expect(wallInNewYork(moved as Date)).toBe("09:00");
      expect((moved as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(getAutomation(app.db, app.workspaceId, off.id)?.nextRunAt).toBeNull();
    });

    it("한도와 함께 보내면 둘 다 저장한다 — 시간대는 정규형으로", async () => {
      const res = await call(admin, "PATCH", "/settings", { dailyRunLimit: 8, timeZone: "asia/seoul" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dailyRunLimit: 8, timeZone: "Asia/Seoul" });
      expect(settings()).toEqual({ dailyRunLimit: 8, timeZone: "Asia/Seoul" });
    });

    it("모르는 이름·고정 오프셋은 400 VALIDATION — 같이 보낸 한도도, 예약 시각도 바꾸지 않는다", async () => {
      await call(owner, "PATCH", "/settings", { dailyRunLimit: 11, timeZone: "Asia/Seoul" });
      const on = addAutomation(`그대로-${uuid()}`);
      for (const body of [
        { timeZone: "Mars/Base" },
        { dailyRunLimit: 6, timeZone: "Mars/Base" },
        { timeZone: "+09:00" },
        { dailyRunLimit: 6, timeZone: "-05:30" },
      ]) {
        const res = await call(owner, "PATCH", "/settings", body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().code).toBe("VALIDATION");
      }
      expect(settings()).toEqual({ dailyRunLimit: 11, timeZone: "Asia/Seoul" });
      expect(getAutomation(app.db, app.workspaceId, on.id)?.nextRunAt).toEqual(on.nextRunAt);
    });

    it("시간대가 그대로면(정규형 기준) 다음 시각을 다시 세지 않는다 — 기한이 막 지나 틱을 기다리는 회차가 내일로 밀리지 않게", async () => {
      await call(owner, "PATCH", "/settings", { timeZone: "Asia/Seoul" });
      const waiting = addAutomation(`기다림-${uuid()}`, { nextRunAt: new Date(Date.now() - 20_000) });
      for (const timeZone of ["Asia/Seoul", "asia/seoul"]) {
        const res = await call(owner, "PATCH", "/settings", { dailyRunLimit: 12, timeZone });
        expect(res.statusCode).toBe(200);
      }
      expect(getAutomation(app.db, app.workspaceId, waiting.id)?.nextRunAt).toEqual(waiting.nextRunAt);
    });

    it("저장된 시간대가 이 서버가 모르는 이름이어도 한도만 바꾸는 PATCH 는 200 — 응답은 읽기와 같은 폴백, 예약 시각 그대로", async () => {
      const on = addAutomation(`모르는-${uuid()}`);
      app.db
        .update(workspaces)
        .set({ opsJson: JSON.stringify({ dailyRunLimit: 300, timeZone: "Mars/Base" }) })
        .where(eq(workspaces.id, app.workspaceId))
        .run();
      const res = await call(owner, "PATCH", "/settings", { dailyRunLimit: 7 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dailyRunLimit: 7, timeZone: "Asia/Seoul" });
      expect(settings()).toEqual({ dailyRunLimit: 7, timeZone: "Asia/Seoul" });
      expect(getAutomation(app.db, app.workspaceId, on.id)?.nextRunAt).toEqual(on.nextRunAt);
    });

    it("member 의 시간대 PATCH 는 403 이고 바꾸지 않는다", async () => {
      const before = settings();
      const res = await call(member, "PATCH", "/settings", { timeZone: "America/New_York" });
      expect(res.statusCode).toBe(403);
      expect(settings()).toEqual(before);
    });
  });

  describe("GET /events·POST /events/ack", () => {
    it("lastAt 내림차순 50개씩, nextCursor 로 다음 페이지", async () => {
      for (let i = 0; i < 60; i++) app.ops.record({ kind: "ratelimit", key: `k${i}`, severity: "info" });
      const first = OpsEventsPage.parse((await call(owner, "GET", "/events")).json());
      expect(first.events).toHaveLength(50);
      expect(first.nextCursor).toBeDefined();
      const second = OpsEventsPage.parse(
        (await call(owner, "GET", `/events?cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).json(),
      );
      expect(second.events).toHaveLength(10);
      expect(second.nextCursor).toBeUndefined();
      const ids = [...first.events, ...second.events].map((e) => e.id);
      expect(new Set(ids).size).toBe(60);
    });

    it("severity 로 거른다 — 모르는 severity·망가진 커서는 400", async () => {
      app.ops.record({ kind: "ratelimit", key: "a", severity: "info" });
      app.ops.record({ kind: "run_failed", key: "agent:a", severity: "warn" });
      app.ops.record({ kind: "crash_rejection", key: "process", severity: "error" });
      const warn = OpsEventsPage.parse((await call(owner, "GET", "/events?severity=warn")).json());
      expect(warn.events.map((e) => e.kind)).toEqual(["run_failed"]);
      expect((await call(owner, "GET", "/events?severity=fatal")).statusCode).toBe(400);
      const bad = await call(owner, "GET", "/events?cursor=nope");
      expect(bad.statusCode).toBe(400);
      expect(bad.json().code).toBe("VALIDATION");
    });

    it("끊김 사건의 firstAt 은 가공하지 않는다(줄이 열린 때) — thresholdMs 를 그대로 싣는다", async () => {
      const opened = app.ops.record({
        kind: "gateway_down",
        key: "gateway",
        severity: "warn",
        detail: { thresholdMs: 60_000 },
      });
      const [event] = OpsEventsPage.parse((await call(owner, "GET", "/events")).json()).events;
      expect(event?.firstAt).toBe(opened?.firstAt);
      expect(event?.detail.thresholdMs).toBe(60_000);
    });

    it("ack 는 본문 없이 {acked} — 그 뒤 unacked 0, 다시 부르면 0", async () => {
      app.ops.record({ kind: "run_failed", key: "agent:a", severity: "warn" });
      app.ops.record({ kind: "crash_rejection", key: "process", severity: "error" });
      app.ops.record({ kind: "ratelimit", key: "a", severity: "info" });
      const res = await call(owner, "POST", "/events/ack");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ acked: 3 });
      expect(OpsStatus.parse((await call(owner, "GET", "/status")).json()).unacked).toEqual({
        warn: 0,
        error: 0,
      });
      const page = OpsEventsPage.parse((await call(owner, "GET", "/events")).json());
      expect(page.events.every((e) => e.ackedAt !== undefined)).toBe(true);
      expect((await call(owner, "POST", "/events/ack")).json()).toEqual({ acked: 0 });
    });
  });

  describe("GET /runs", () => {
    it("days=1·7 은 계약 모양, 그 밖(3·빠짐·문자)은 400", async () => {
      for (const days of [1, 7] as const) {
        const res = await call(owner, "GET", `/runs?days=${days}`);
        expect(res.statusCode).toBe(200);
        const summary = OpsRunsSummary.parse(res.json());
        expect(summary.days).toBe(days);
        // OpenClaw 어댑터만 붙은 서버 — 믿는 제공자(claude)가 붙어 있지 않아 비고, 웹은 「측정 불가」를 보인다
        expect(summary.usageTrustedProviders).toEqual([]);
      }
      for (const query of ["?days=3", "", "?days=x", "?days=1.0"]) {
        const res = await call(owner, "GET", `/runs${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json().code).toBe("VALIDATION");
      }
    });

    it("오늘 만든 런이 채널·에이전트 행에 잡힌다", async () => {
      const channel = createChannel(app.db, {
        workspaceId: app.workspaceId,
        createdBy: ownerId,
        name: `r${uuid()}`,
      });
      const agent = createAgent(app.db, {
        workspaceId: app.workspaceId,
        providerAgentId: `b${uuid()}`,
        handle: "bravo",
        name: "B",
      });
      insertRun(app.db, {
        channelId: channel.id,
        agentId: agent.id,
        triggerKind: "mention",
        rootMessageId: uuid(),
        relayDepth: 0,
        sessionKey: "k",
        createdAt: new Date(),
      });
      const summary = OpsRunsSummary.parse((await call(owner, "GET", "/runs?days=1")).json());
      expect(summary.byChannel.find((r) => r.id === channel.id)).toEqual({
        id: channel.id,
        name: channel.name,
        runs: 1,
        failed: 0,
        aborted: 0,
        blocked: 0,
      });
      expect(summary.byAgent.find((r) => r.id === agent.id)).toMatchObject({ name: "B", runs: 1 });
      app.db.delete(runs).run();
    });
  });
});

describe("GET /api/v1/ops/status 디스크", () => {
  it("statfs 가 실패하면 unknown — 수치 없이", async () => {
    const app = await bootTestApp(
      {},
      {
        statfs: async () => {
          throw Object.assign(new Error("boom"), { code: "EIO" });
        },
      },
    );
    try {
      const { headers } = await login(app);
      const status = OpsStatus.parse(
        (await app.fastify.inject({ method: "GET", url: "/api/v1/ops/status", headers })).json(),
      );
      expect(status.disk).toEqual({ level: "unknown" });
    } finally {
      await app.close();
    }
  });
});
