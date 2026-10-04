import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  OPS_DEFAULT_DAILY_RUN_LIMIT,
  OpsEvent,
  OpsEventKind,
  OpsAckResult,
  OpsEventsPage,
  OpsRunsRow,
  OpsRunsSummary,
  OpsSettingsPatch,
  OpsStatus,
  OpsUnacked,
  SystemKind,
  SystemMeta,
} from "../src";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";
const NOW = "2026-09-25T00:00:00Z";
const EVENT = {
  id: ID,
  kind: "gateway_down",
  severity: "warn",
  key: "gateway",
  detail: { downMs: 61_000, code: "E", ok: true, none: null },
  count: 1,
  firstAt: NOW,
  lastAt: NOW,
};

describe("OpsEvent", () => {
  it("문자열·수·불리언·null 값의 detail 을 받는다", () => {
    expect(OpsEvent.safeParse(EVENT).success).toBe(true);
    expect(OpsEvent.safeParse({ ...EVENT, resolvedAt: NOW, ackedAt: NOW }).success).toBe(true);
  });

  it("detail 의 객체·배열 값을 거절한다", () => {
    expect(OpsEvent.safeParse({ ...EVENT, detail: { nested: { a: 1 } } }).success).toBe(false);
    expect(OpsEvent.safeParse({ ...EVENT, detail: { list: [1, 2] } }).success).toBe(false);
  });

  it("detail 문자열은 200자까지, key 도 200자까지", () => {
    expect(OpsEvent.safeParse({ ...EVENT, detail: { s: "x".repeat(200) } }).success).toBe(true);
    expect(OpsEvent.safeParse({ ...EVENT, detail: { s: "x".repeat(201) } }).success).toBe(false);
    expect(OpsEvent.safeParse({ ...EVENT, key: "k".repeat(201) }).success).toBe(false);
  });

  it("count 는 1 이상 정수", () => {
    expect(OpsEvent.safeParse({ ...EVENT, count: 0 }).success).toBe(false);
    expect(OpsEvent.safeParse({ ...EVENT, count: 1.5 }).success).toBe(false);
  });

  it("모르는 kind·severity 를 거절한다", () => {
    expect(OpsEvent.safeParse({ ...EVENT, kind: "nope" }).success).toBe(false);
    expect(OpsEvent.safeParse({ ...EVENT, severity: "debug" }).success).toBe(false);
  });

  it("kind 열거는 운영 보강 3.1 표의 열두 가지 + 팀 설계의 invite_accept_failed·member_remove_failed + 러너의 runner_down", () => {
    expect(OpsEventKind.options).toEqual([
      "gateway_down",
      "plugin_down",
      "runner_down",
      "gateway_version_changed",
      "gateway_version_untested",
      "run_limit",
      "run_failed",
      "ratelimit",
      "bridge_auth_blocked",
      "crash_rejection",
      "crash_exception",
      "unclean_shutdown",
      "disk_low",
      "invite_accept_failed",
      "member_remove_failed",
    ]);
  });
});

describe("OpsUnacked·OpsEventsPage", () => {
  it("음수 수를 거절하고, 페이지는 nextCursor 가 선택이다", () => {
    expect(OpsUnacked.safeParse({ warn: 0, error: 3 }).success).toBe(true);
    expect(OpsUnacked.safeParse({ warn: -1, error: 0 }).success).toBe(false);
    expect(OpsEventsPage.safeParse({ events: [EVENT] }).success).toBe(true);
    expect(OpsEventsPage.safeParse({ events: [], nextCursor: "c" }).success).toBe(true);
  });
});

describe("OpsSettingsPatch", () => {
  it("1~10000 정수와 null 을 받는다", () => {
    expect(OpsSettingsPatch.safeParse({ dailyRunLimit: 1 }).success).toBe(true);
    expect(OpsSettingsPatch.safeParse({ dailyRunLimit: 10_000 }).success).toBe(true);
    expect(OpsSettingsPatch.safeParse({ dailyRunLimit: null }).success).toBe(true);
  });

  it("0·10001·소수·빠진 키를 거절한다", () => {
    expect(OpsSettingsPatch.safeParse({ dailyRunLimit: 0 }).success).toBe(false);
    expect(OpsSettingsPatch.safeParse({ dailyRunLimit: 10_001 }).success).toBe(false);
    expect(OpsSettingsPatch.safeParse({ dailyRunLimit: 2.5 }).success).toBe(false);
    expect(OpsSettingsPatch.safeParse({}).success).toBe(false);
  });

  it("기본 일일 상한은 300", () => {
    expect(OPS_DEFAULT_DAILY_RUN_LIMIT).toBe(300);
  });
});

describe("SystemMeta run_limit", () => {
  it("SystemKind 에 run_limit 이 있다", () => {
    expect(SystemKind.options).toContain("run_limit");
  });

  it("limit.scope 는 channel·workspace 두 값만, limit 은 1 이상 정수", () => {
    expect(SystemMeta.safeParse({ kind: "run_limit", limit: { scope: "channel", limit: 5 } }).success).toBe(
      true,
    );
    expect(
      SystemMeta.safeParse({ kind: "run_limit", limit: { scope: "workspace", limit: 300 } }).success,
    ).toBe(true);
    expect(SystemMeta.safeParse({ kind: "run_limit", limit: { scope: "agent", limit: 5 } }).success).toBe(
      false,
    );
    expect(SystemMeta.safeParse({ kind: "run_limit", limit: { scope: "channel", limit: 0 } }).success).toBe(
      false,
    );
    expect(SystemMeta.safeParse({ kind: "run_limit" }).success).toBe(true);
  });
});

describe("ErrorCode", () => {
  it("RUN_LIMIT·INSUFFICIENT_STORAGE 를 받는다", () => {
    expect(ErrorCode.safeParse("RUN_LIMIT").success).toBe(true);
    expect(ErrorCode.safeParse("INSUFFICIENT_STORAGE").success).toBe(true);
  });
});

const STATUS = {
  workspaceId: ID,
  server: { version: "0.0.0", startedAt: NOW, previousClean: null },
  db: { bytes: 4096 },
  disk: { level: "ok", freeBytes: 10, totalBytes: 20 },
  adapter: {
    provider: "openclaw",
    gateways: [{ id: ID, name: "집", enabled: true, gateway: "connected", bridge: "down" }],
  },
  gateways: [
    {
      id: ID,
      name: "집",
      enabled: true,
      gateway: { state: "connected", version: "2026.9.5", pinned: "2026.9.4", drift: true },
      plugin: { state: "down" },
    },
  ],
  runsToday: 3,
  dailyRunLimit: 300,
  blockedToday: 0,
  unacked: { warn: 1, error: 0 },
};

describe("OpsStatus", () => {
  it("디스크 unknown 은 수치 없이, 상한 null(무제한)·직전 종료 불리언을 받는다", () => {
    expect(OpsStatus.safeParse(STATUS).success).toBe(true);
    // Gateway 가 없으면 빈 목록, 꺼진 Gateway 는 disabled
    expect(
      OpsStatus.safeParse({ ...STATUS, adapter: { provider: "openclaw", gateways: [] }, gateways: [] })
        .success,
    ).toBe(true);
    const [gw] = STATUS.gateways;
    expect(
      OpsStatus.safeParse({
        ...STATUS,
        gateways: [{ ...gw, enabled: false, gateway: { ...gw?.gateway, state: "disabled", version: null } }],
      }).success,
    ).toBe(true);
    expect(OpsStatus.safeParse({ ...STATUS, disk: { level: "unknown" }, dailyRunLimit: null }).success).toBe(
      true,
    );
    expect(
      OpsStatus.safeParse({ ...STATUS, server: { ...STATUS.server, previousClean: false } }).success,
    ).toBe(true);
  });

  it("수치 없는 ok 디스크·음수 런 수·모르는 상태를 거절한다", () => {
    expect(OpsStatus.safeParse({ ...STATUS, disk: { level: "ok" } }).success).toBe(false);
    expect(OpsStatus.safeParse({ ...STATUS, runsToday: -1 }).success).toBe(false);
    expect(OpsStatus.safeParse({ ...STATUS, blockedToday: -1 }).success).toBe(false);
    const [gw] = STATUS.gateways;
    expect(
      OpsStatus.safeParse({ ...STATUS, gateways: [{ ...gw, plugin: { state: "reconnecting" } }] }).success,
    ).toBe(false);
  });

  it("/healthz 에서 뺀 워크스페이스 id·어댑터 상세가 있어야 한다(스펙 6장)", () => {
    const { workspaceId: _w, ...noWorkspace } = STATUS;
    const { adapter: _a, ...noAdapter } = STATUS;
    expect(OpsStatus.safeParse(noWorkspace).success).toBe(false);
    expect(OpsStatus.safeParse(noAdapter).success).toBe(false);
  });
});

describe("OpsRunsSummary", () => {
  const ROW = { id: ID, name: "general", runs: 2, failed: 1, aborted: 0, blocked: 0 };
  it("days 는 1·7 만, 토큰·금액은 선택", () => {
    const summary = { days: 7, byChannel: [ROW], byAgent: [], usageTrustedProviders: [] };
    expect(OpsRunsSummary.safeParse(summary).success).toBe(true);
    expect(OpsRunsSummary.safeParse({ ...summary, days: 3 }).success).toBe(false);
    expect(OpsRunsRow.safeParse({ ...ROW, tokens: 10, costUsd: 0.5 }).success).toBe(true);
    expect(OpsRunsRow.safeParse({ ...ROW, runs: -1 }).success).toBe(false);
  });
});

describe("OpsAckResult", () => {
  it("확인한 줄 수 — 0 이상 정수", () => {
    expect(OpsAckResult.safeParse({ acked: 0 }).success).toBe(true);
    expect(OpsAckResult.safeParse({ acked: -1 }).success).toBe(false);
  });
});
