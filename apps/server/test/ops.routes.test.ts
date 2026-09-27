import { OPENCLAW_PINNED_VERSION, type OpenClawSetupDetail } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { OpsEventsPage, OpsRunsSummary, OpsStatus } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { opsEvents, runs } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { createChannel } from "../src/modules/channels/service";
import { getOpsSettings, patchOpsSettings } from "../src/modules/ops/settings";
import { insertRun } from "../src/modules/runs/store";
import packageJson from "../package.json" with { type: "json" };
import { bootTestApp, login, userWithRole } from "./helpers/app";

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
      adapter.setStatus({ provider: "openclaw", gateway: "reconnecting", bridge: "down" });
      const res = await call(owner, "GET", "/status");
      expect(res.statusCode).toBe(200);
      const status = OpsStatus.parse(res.json());
      expect(status.workspaceId).toBe(app.workspaceId);
      expect(status.adapter).toEqual({ provider: "openclaw", gateway: "reconnecting", bridge: "down" });
      expect(status.gateway.state).toBe("reconnecting");
      expect(status.plugin).toEqual({ state: "down" });
      expect(status.server.version).toBe(packageJson.version);
      expect(Date.parse(status.server.startedAt)).toBeLessThanOrEqual(Date.now());
      expect(status.dailyRunLimit).toBe(300);
      // helpers/app plentyOfDisk: bavail 2^20·blocks 2^21 블록, 4096 바이트
      expect(status.disk).toEqual({ level: "ok", freeBytes: 2 ** 20 * 4096, totalBytes: 2 ** 21 * 4096 });
      expect(status.db.bytes).toBeGreaterThan(0);
      adapter.setStatus({ provider: "openclaw", gateway: "connected", bridge: "connected" });
    });

    it("Gateway 버전·핀·드리프트 — 모르면(null) 드리프트 아님", async () => {
      const gatewayOf = async () => OpsStatus.parse((await call(owner, "GET", "/status")).json()).gateway;
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
      adapter.setStatus({ provider: "bogus", gateway: "connected", bridge: "connected" } as never);
      const res = await call(owner, "GET", "/status");
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe("INTERNAL");
      expect(res.body).not.toContain("bogus");
      adapter.setStatus({ provider: "openclaw", gateway: "connected", bridge: "connected" });
    });
  });

  describe("PATCH /settings", () => {
    const limitNow = async () => OpsStatus.parse((await call(owner, "GET", "/status")).json()).dailyRunLimit;

    it("1~10000 과 null(무제한)을 저장하고 status 에 반영한다", async () => {
      const res = await call(owner, "PATCH", "/settings", { dailyRunLimit: 5 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ dailyRunLimit: 5 });
      expect(await limitNow()).toBe(5);
      expect((await call(owner, "PATCH", "/settings", { dailyRunLimit: null })).json()).toEqual({
        dailyRunLimit: null,
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

    it("lastGatewayVersion 은 건드리지 않는다", async () => {
      patchOpsSettings(app.db, app.workspaceId, { lastGatewayVersion: "2026.9.5" });
      await call(owner, "PATCH", "/settings", { dailyRunLimit: 9 });
      expect(getOpsSettings(app.db, app.workspaceId)).toEqual({
        dailyRunLimit: 9,
        lastGatewayVersion: "2026.9.5",
      });
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
        expect(summary.usageTrustedProviders).toEqual(["claude"]);
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
      expect(summary.byChannel.find((r) => r.id === channel.id)).toMatchObject({ runs: 1 });
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
