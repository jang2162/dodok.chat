import { OPS_DEFAULT_DAILY_RUN_LIMIT } from "@dodok/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { opsEvents, workspaces } from "../src/db/schema.sqlite";
import { ipPrefix } from "../src/modules/ops/ip";
import { createOpsService, type OpsService } from "../src/modules/ops/service";
import { getOpsSettings, patchOpsSettings } from "../src/modules/ops/settings";
import { type BusEvents, ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";

const T0 = new Date("2026-09-25T00:00:00.000Z");
const MIN = 60_000;

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { logger, lines };
}

let db: Db;
let ws: string;
let clock: Date;
let emitted: Array<BusEvents["ops.event"]>;
let lines: Array<Record<string, unknown>>;
let ops: OpsService;

beforeEach(() => {
  db = newTestDb();
  ws = seedWorkspace(db).workspaceId;
  clock = T0;
  const bus = new ServerBus();
  emitted = [];
  bus.on("ops.event", (p) => void emitted.push(p));
  const captured = captureLogger();
  lines = captured.lines;
  ops = createOpsService({ db, bus, logger: captured.logger, workspaceId: ws, now: () => clock });
});

const opsLines = () => lines.filter((l) => l.msg === "ops event");

describe("OpsService.record", () => {
  it("줄을 돌려주고 ops.event {event, unacked} 를 보내며, severity 를 로그 레벨로 event: ops.<kind> 줄을 남긴다", () => {
    const event = ops.record({
      kind: "run_failed",
      key: "agent:a",
      severity: "warn",
      detail: { code: "E1" },
    });
    expect(event).toMatchObject({ kind: "run_failed", key: "agent:a", count: 1, detail: { code: "E1" } });
    expect(emitted).toEqual([{ event, unacked: { warn: 1, error: 0 } }]);
    expect(opsLines()).toEqual([
      expect.objectContaining({ level: 40, event: "ops.run_failed", key: "agent:a", count: 1, code: "E1" }),
    ]);

    ops.record({ kind: "crash_rejection", key: "process", severity: "error", detail: { name: "TypeError" } });
    ops.record({ kind: "ratelimit", key: "wire:message.send", severity: "info" });
    expect(opsLines().map((l) => l.level)).toEqual([40, 50, 30]);
    expect(emitted.at(-1)?.unacked).toEqual({ warn: 1, error: 1 });
  });

  it("detail 의 키가 로그 고정 필드(event·key·count)를 덮지 못한다", () => {
    ops.record({ kind: "ratelimit", key: "k", severity: "info", detail: { event: "x", key: "y", count: 9 } });
    expect(opsLines()[0]).toMatchObject({ event: "ops.ratelimit", key: "k", count: 1 });
  });

  it("폭주 — 1000번 record 하면 DB 행은 1(count 1000), emit 은 1000번", () => {
    for (let i = 0; i < 1000; i++) ops.record({ kind: "ratelimit", key: "k", severity: "info" });
    expect(db.select().from(opsEvents).all()).toHaveLength(1);
    expect(emitted).toHaveLength(1000);
    expect(emitted.at(-1)?.event.count).toBe(1000);
  });

  it("DB 오류(닫힌 DB)면 던지지 않고 null + logger.error", () => {
    db.$client.close();
    expect(ops.record({ kind: "run_failed", key: "agent:a", severity: "warn" })).toBeNull();
    expect(emitted).toHaveLength(0);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 50, msg: "ops record failed", kind: "run_failed", key: "agent:a" }),
    );
  });

  it("버스 처리기가 던져도 기록한 줄을 돌려준다(원래 동작을 막지 않는다)", () => {
    const bus = new ServerBus();
    bus.on("ops.event", () => {
      throw new Error("fanout boom");
    });
    const captured = captureLogger();
    const svc = createOpsService({ db, bus, logger: captured.logger, workspaceId: ws, now: () => clock });
    expect(svc.record({ kind: "run_failed", key: "agent:a", severity: "warn" })).not.toBeNull();
    expect(captured.lines).toContainEqual(
      expect.objectContaining({ level: 50, msg: "ops event emit failed" }),
    );
  });
});

describe("OpsService.resolve", () => {
  it("열린 끊김 줄을 닫고(downMs) emit — 열린 줄이 없으면 null·emit 없음", () => {
    expect(ops.resolve("gateway_down", "gateway")).toBeNull();
    expect(emitted).toHaveLength(0);
    ops.record({ kind: "gateway_down", key: "gateway", severity: "warn" });
    clock = new Date(T0.getTime() + 3 * MIN);
    const closed = ops.resolve("gateway_down", "gateway");
    expect(closed).toMatchObject({ resolvedAt: clock.toISOString(), detail: { downMs: 3 * MIN } });
    expect(emitted.at(-1)?.event).toEqual(closed);
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 30, event: "ops.gateway_down", resolved: true, downMs: 3 * MIN }),
    );
  });

  it("at 을 주면 그 시각으로 닫는다", () => {
    ops.record({ kind: "plugin_down", key: "plugin", severity: "warn" });
    const closed = ops.resolve("plugin_down", "plugin", new Date(T0.getTime() + MIN));
    expect(closed?.detail.downMs).toBe(MIN);
  });

  it("DB 오류면 null + logger.error", () => {
    db.$client.close();
    expect(ops.resolve("plugin_down", "plugin")).toBeNull();
    expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: "ops resolve failed" }));
  });
});

describe("OpsService.ack·list·unacked·sweep", () => {
  it("ack 는 확인한 줄 수를 돌려주고 줄마다 emit(마지막 unacked 0)", () => {
    ops.record({ kind: "run_failed", key: "agent:a", severity: "warn" });
    ops.record({ kind: "crash_rejection", key: "process", severity: "error" });
    emitted.length = 0;
    clock = new Date(T0.getTime() + MIN);
    expect(ops.ack()).toBe(2);
    expect(emitted).toHaveLength(2);
    expect(emitted.every((p) => p.event.ackedAt === clock.toISOString())).toBe(true);
    expect(emitted.at(-1)?.unacked).toEqual({ warn: 0, error: 0 });
    expect(ops.unacked()).toEqual({ warn: 0, error: 0 });
  });

  it("ack(upTo) 는 그 시각 뒤에 마지막으로 난 줄을 남긴다", () => {
    ops.record({ kind: "run_failed", key: "agent:a", severity: "warn" });
    clock = new Date(T0.getTime() + 2 * MIN);
    ops.record({ kind: "run_failed", key: "agent:b", severity: "warn" });
    expect(ops.ack(new Date(T0.getTime() + MIN))).toBe(1);
    expect(ops.unacked()).toEqual({ warn: 1, error: 0 });
  });

  it("list 는 store 규칙 그대로(기본 50, 커서)", () => {
    for (let i = 0; i < 51; i++) ops.record({ kind: "ratelimit", key: `k${i}`, severity: "info" });
    const first = ops.list({});
    expect(first.events).toHaveLength(50);
    expect(ops.list({ cursor: first.nextCursor as string }).events).toHaveLength(1);
  });

  it("sweep 는 30일 지난 줄을 지운 수를 돌려준다", () => {
    ops.record({ kind: "ratelimit", key: "k", severity: "info" });
    expect(ops.sweep(new Date(T0.getTime() + 30 * 24 * 60 * MIN))).toBe(0);
    expect(ops.sweep(new Date(T0.getTime() + 30 * 24 * 60 * MIN + 1))).toBe(1);
  });
});

describe("운영 설정(ops_json)", () => {
  const setRaw = (raw: string) =>
    db.update(workspaces).set({ opsJson: raw }).where(eq(workspaces.id, ws)).run();

  it("키가 없으면 dailyRunLimit 300", () => {
    expect(OPS_DEFAULT_DAILY_RUN_LIMIT).toBe(300);
    expect(getOpsSettings(db, ws)).toEqual({ dailyRunLimit: 300 });
  });

  it("null 은 무제한, 숫자는 그대로, lastGatewayVersion 도 읽는다", () => {
    setRaw(JSON.stringify({ dailyRunLimit: null, lastGatewayVersion: "2026.9.5" }));
    expect(getOpsSettings(db, ws)).toEqual({ dailyRunLimit: null, lastGatewayVersion: "2026.9.5" });
    setRaw(JSON.stringify({ dailyRunLimit: 20 }));
    expect(getOpsSettings(db, ws)).toEqual({ dailyRunLimit: 20 });
  });

  it("망가진 값(JSON 아님·범위 밖·배열)이면 {} 로 보고 warn", () => {
    const { logger, lines: warnLines } = captureLogger();
    for (const raw of ["{nope", JSON.stringify({ dailyRunLimit: 0 }), "[]"]) {
      setRaw(raw);
      expect(getOpsSettings(db, ws, logger)).toEqual({ dailyRunLimit: 300 });
    }
    expect(warnLines.filter((l) => l.level === 40 && l.msg === "ops settings unreadable")).toHaveLength(3);
  });

  it("patch 는 준 키만 바꾸고 다른 키(모르는 키 포함)는 남긴다", () => {
    setRaw(JSON.stringify({ lastGatewayVersion: "2026.9.4", future: 1 }));
    expect(patchOpsSettings(db, ws, { dailyRunLimit: null })).toEqual({
      dailyRunLimit: null,
      lastGatewayVersion: "2026.9.4",
    });
    expect(patchOpsSettings(db, ws, { lastGatewayVersion: "2026.9.5" })).toEqual({
      dailyRunLimit: null,
      lastGatewayVersion: "2026.9.5",
    });
    expect(patchOpsSettings(db, ws, { dailyRunLimit: 50 }).dailyRunLimit).toBe(50);
    const raw = db.select({ opsJson: workspaces.opsJson }).from(workspaces).get()?.opsJson ?? "";
    expect(JSON.parse(raw)).toEqual({ dailyRunLimit: 50, lastGatewayVersion: "2026.9.5", future: 1 });
  });

  it("patch 가 범위 밖이면 VALIDATION 으로 던지고 저장하지 않는다", () => {
    expect(() => patchOpsSettings(db, ws, { dailyRunLimit: 0 })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => patchOpsSettings(db, ws, { dailyRunLimit: 10_001 })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(getOpsSettings(db, ws)).toEqual({ dailyRunLimit: 300 });
  });

  it("망가진 값 위에 patch 하면 {} 에서 시작한다", () => {
    setRaw("{nope");
    expect(patchOpsSettings(db, ws, { dailyRunLimit: 7 })).toEqual({ dailyRunLimit: 7 });
  });
});

describe("ipPrefix", () => {
  it.each([
    ["203.0.113.7", "203.0.113.0/24"],
    ["2001:db8:1:2::5", "2001:db8:1::/48"],
    ["::ffff:198.51.100.9", "198.51.100.0/24"],
    ["::ffff:c633:6409", "198.51.100.0/24"],
    ["2001:0db8:0000:0000::1", "2001:db8::/48"],
    ["fe80::1%en0", "fe80::/48"],
    ["::1", "::/48"],
    ["", "unknown"],
    ["garbage", "unknown"],
    ["999.1.1.1", "unknown"],
  ])("%s → %s", (ip, expected) => {
    expect(ipPrefix(ip)).toBe(expected);
  });
});
