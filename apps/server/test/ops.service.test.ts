import { OPS_DEFAULT_DAILY_RUN_LIMIT, OPS_DEFAULT_TIME_ZONE, OpsEvent } from "@dodok/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client";
import { opsEvents, workspaces } from "../src/db/schema.sqlite";
import { ipPrefix } from "../src/modules/ops/ip";
import { createOpsService, OPS_EMIT_COALESCE_MS, type OpsService } from "../src/modules/ops/service";
import { recordEvent, unackedCounts } from "../src/modules/ops/store";
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

describe("OpsService.record — 저장 전 모양 검사(shared OpsEvent.key·detail)", () => {
  const SECRET = "tok_SECRET";
  const rejected = () => lines.filter((l) => l.msg === "ops record rejected");

  it.each([
    ["201자 key", { key: `/x?token=${SECRET}${"t".repeat(200)}` }],
    ["객체 값 detail", { detail: { nested: { token: SECRET } } as unknown as OpsEvent["detail"] }],
    ["배열 값 detail", { detail: { list: [SECRET] } as unknown as OpsEvent["detail"] }],
    ["201자 문자열 detail", { detail: { token: SECRET + "t".repeat(200) } }],
  ])("%s → 저장하지 않고 null·logger.error, 로그에 값이 남지 않는다", (_name, patch) => {
    const got = ops.record({ kind: "ratelimit", key: "rest:/api/v1/messages", severity: "warn", ...patch });
    expect(got).toBeNull();
    expect(db.select().from(opsEvents).all()).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(rejected()).toEqual([expect.objectContaining({ level: 50, kind: "ratelimit" })]);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it("경계 — 200자 key·200자 문자열·숫자·불리언·null 은 그대로 저장되고 스키마를 통과한다", () => {
    const got = ops.record({
      kind: "ratelimit",
      key: "k".repeat(200),
      severity: "info",
      detail: { s: "v".repeat(200), n: 1, b: true, z: null },
    });
    expect(got).not.toBeNull();
    expect(OpsEvent.parse(got)).toEqual(got);
  });

  it("묶일 줄이 있어도 모양이 틀리면 그 줄을 건드리지 않는다(count 그대로)", () => {
    ops.record({ kind: "ratelimit", key: "k", severity: "info" });
    expect(
      ops.record({ kind: "ratelimit", key: "k", severity: "info", detail: { x: "v".repeat(201) } }),
    ).toBeNull();
    expect(db.select().from(opsEvents).all()).toEqual([expect.objectContaining({ count: 1, detail: {} })]);
  });

  it("resolve — 병합한 detail 이 모양을 어기면 닫지 않고 null·logger.error", () => {
    db.insert(opsEvents)
      .values({
        id: "0199a000-0000-7000-8000-000000000001",
        workspaceId: ws,
        kind: "gateway_down",
        severity: "warn",
        key: "gateway",
        detail: { nested: { a: 1 } } as unknown as OpsEvent["detail"],
        firstAt: T0,
        lastAt: T0,
      })
      .run();
    expect(ops.resolve("gateway_down", "gateway", new Date(T0.getTime() + MIN))).toBeNull();
    expect(db.select().from(opsEvents).get()?.resolvedAt).toBeNull();
    expect(emitted).toHaveLength(0);
    expect(lines).toContainEqual(expect.objectContaining({ level: 50, msg: "ops resolve failed" }));
  });
});

describe("OpsService — 폭주 병합(같은 줄의 ops.event·로그는 창마다 한 번, unacked 는 캐시)", () => {
  beforeEach(() => void vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => void vi.useRealTimers());

  /** unacked 집계 쿼리(count(*)) 준비 횟수 — drizzle 은 쿼리마다 prepare 한다 */
  const countQueries = () => {
    const spy = vi.spyOn(db.$client, "prepare");
    return () => spy.mock.calls.filter(([q]) => /count\(\*\)/i.test(String(q))).length;
  };

  it(`1000번 record — DB 는 매번 count 가 오르고, emit·로그는 첫 번 즉시 1 + ${OPS_EMIT_COALESCE_MS}ms 뒤 마지막 상태 1, unacked 집계 0회`, () => {
    ops.record({ kind: "ratelimit", key: "k", severity: "warn" }); // 새 줄 — 여기서만 센다
    const unackedQueries = countQueries();
    for (let i = 0; i < 999; i++) ops.record({ kind: "ratelimit", key: "k", severity: "warn" });
    expect(db.select().from(opsEvents).get()?.count).toBe(1000);
    expect(unackedQueries()).toBe(0);
    expect(emitted).toHaveLength(1);
    expect(opsLines()).toHaveLength(1);

    vi.advanceTimersByTime(OPS_EMIT_COALESCE_MS);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual({
      event: expect.objectContaining({ count: 1000 }),
      unacked: { warn: 1, error: 0 },
    });
    expect(opsLines().at(-1)).toMatchObject({ count: 1000, coalesced: 999 });
    expect(unackedQueries()).toBe(0);

    vi.advanceTimersByTime(10 * OPS_EMIT_COALESCE_MS); // 조용해지면 더 보내지 않는다
    expect(emitted).toHaveLength(2);
    expect(opsLines()).toHaveLength(2);

    ops.record({ kind: "ratelimit", key: "k", severity: "warn" }); // 창 밖 묶임 — 즉시 보내되 다시 세지 않는다
    expect(emitted.at(-1)).toEqual({
      event: expect.objectContaining({ count: 1001 }),
      unacked: { warn: 1, error: 0 },
    });
    expect(unackedQueries()).toBe(0);
  });

  it("창이 계속 이어져도 같은 줄은 창마다 한 번만 — 조용한 창 뒤의 record 는 다시 즉시", () => {
    const rec = () => ops.record({ kind: "ratelimit", key: "k", severity: "info" });
    rec(); // 즉시
    vi.advanceTimersByTime(OPS_EMIT_COALESCE_MS / 2);
    rec(); // 보류
    vi.advanceTimersByTime(OPS_EMIT_COALESCE_MS / 2); // 창 끝 → 보류분(count 2)
    expect(emitted.map((p) => p.event.count)).toEqual([1, 2]);
    rec(); // 방금 보냈으니 다시 보류
    expect(emitted).toHaveLength(2);
    vi.advanceTimersByTime(OPS_EMIT_COALESCE_MS);
    expect(emitted.map((p) => p.event.count)).toEqual([1, 2, 3]);
    vi.advanceTimersByTime(OPS_EMIT_COALESCE_MS); // 보류 없는 창 → 창을 닫는다
    rec();
    expect(emitted.map((p) => p.event.count)).toEqual([1, 2, 3, 4]); // 즉시
  });

  it("다른 줄은 서로의 창에 묶이지 않는다", () => {
    ops.record({ kind: "ratelimit", key: "a", severity: "info" });
    ops.record({ kind: "ratelimit", key: "b", severity: "info" });
    expect(emitted.map((p) => p.event.key)).toEqual(["a", "b"]);
  });

  it("severity 가 오르면 창 안이어도 즉시 보내고 unacked 를 다시 센다", () => {
    ops.record({ kind: "disk_low", key: "data", severity: "warn" });
    ops.record({ kind: "disk_low", key: "data", severity: "error" });
    expect(emitted.at(-1)).toMatchObject({
      event: { severity: "error", count: 2 },
      unacked: { warn: 0, error: 1 },
    });
    vi.advanceTimersByTime(OPS_EMIT_COALESCE_MS);
    expect(emitted).toHaveLength(2);
  });

  it("resolve 는 즉시 보내고, 그 줄의 보류분(옛 상태)을 버린다", () => {
    ops.record({ kind: "gateway_down", key: "gateway", severity: "warn" });
    ops.record({ kind: "gateway_down", key: "gateway", severity: "warn" }); // 보류
    const closed = ops.resolve("gateway_down", "gateway");
    expect(emitted.at(-1)?.event).toEqual(closed);
    vi.advanceTimersByTime(OPS_EMIT_COALESCE_MS);
    expect(emitted.at(-1)?.event).toEqual(closed);
    expect(emitted).toHaveLength(2);
  });

  it("ack 는 즉시 보내고, 그 줄의 보류분(옛 상태)을 버린다", () => {
    ops.record({ kind: "run_failed", key: "agent:a", severity: "warn" });
    ops.record({ kind: "run_failed", key: "agent:a", severity: "warn" }); // 보류
    expect(ops.ack()).toBe(1);
    const acked = emitted.at(-1);
    expect(acked).toMatchObject({
      event: { count: 2, ackedAt: clock.toISOString() },
      unacked: { warn: 0, error: 0 },
    });
    vi.advanceTimersByTime(OPS_EMIT_COALESCE_MS);
    expect(emitted.at(-1)).toEqual(acked);
    expect(emitted).toHaveLength(2);
  });

  it("close 는 보류분을 내보내고 타이머를 끈다", () => {
    ops.record({ kind: "ratelimit", key: "k", severity: "info" });
    ops.record({ kind: "ratelimit", key: "k", severity: "info" });
    ops.close();
    expect(emitted.map((p) => p.event.count)).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close 뒤 record 는 DB 에 쓰고 로그·emit 을 즉시 하되 창(타이머)을 열지 않는다 — 종료 도중의 기록(o3-t1 N3)", () => {
    ops.close();
    ops.record({ kind: "crash_exception", key: "process", severity: "error" });
    ops.record({ kind: "crash_exception", key: "process", severity: "error" });
    expect(vi.getTimerCount()).toBe(0);
    expect(db.select().from(opsEvents).all()).toEqual([expect.objectContaining({ count: 2 })]);
    expect(emitted.map((p) => p.event.count)).toEqual([1, 2]);
    expect(opsLines().map((l) => l.count)).toEqual([1, 2]);
  });

  it("unacked 캐시는 부팅(서비스 생성) 때 한 번 센 값에서 시작하고, 새 줄·ack·sweep 뒤 DB 와 같다", () => {
    recordEvent(db, ws, { kind: "run_failed", key: "old", severity: "warn" }, T0); // 서비스 밖에서 먼저 있던 줄
    const bus = new ServerBus();
    const svc = createOpsService({
      db,
      bus,
      logger: captureLogger().logger,
      workspaceId: ws,
      now: () => clock,
    });
    const same = () => expect(svc.unacked()).toEqual(unackedCounts(db, ws));
    expect(svc.unacked()).toEqual({ warn: 1, error: 0 });

    svc.record({ kind: "crash_exception", key: "process", severity: "error" });
    same();
    svc.record({ kind: "crash_exception", key: "process", severity: "error" }); // 묶임 — 수는 그대로
    same();
    clock = new Date(T0.getTime() + MIN);
    svc.ack(new Date(T0.getTime()));
    expect(svc.unacked()).toEqual({ warn: 0, error: 0 });
    same();
    clock = new Date(T0.getTime() + 2 * MIN);
    svc.record({ kind: "run_failed", key: "new", severity: "warn" });
    same();
    svc.sweep(new Date(T0.getTime() + 2 * MIN + 30 * 24 * 60 * MIN + 1));
    expect(svc.unacked()).toEqual({ warn: 0, error: 0 });
    same();
    svc.close();
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
  const SEOUL = OPS_DEFAULT_TIME_ZONE;
  const storedRaw = () =>
    JSON.parse(db.select({ opsJson: workspaces.opsJson }).from(workspaces).get()?.opsJson ?? "");

  it("키가 없으면 dailyRunLimit 300·timeZone Asia/Seoul", () => {
    expect(OPS_DEFAULT_DAILY_RUN_LIMIT).toBe(300);
    expect(OPS_DEFAULT_TIME_ZONE).toBe("Asia/Seoul");
    expect(getOpsSettings(db, ws)).toEqual({ dailyRunLimit: 300, timeZone: SEOUL });
  });

  it("null 은 무제한, 숫자는 그대로 — 모르는 키는 설정에 싣지 않는다", () => {
    setRaw(JSON.stringify({ dailyRunLimit: null, future: "x" }));
    expect(getOpsSettings(db, ws)).toEqual({ dailyRunLimit: null, timeZone: SEOUL });
    setRaw(JSON.stringify({ dailyRunLimit: 20, timeZone: "America/New_York" }));
    expect(getOpsSettings(db, ws)).toEqual({ dailyRunLimit: 20, timeZone: "America/New_York" });
  });

  it("망가진 값(JSON 아님·범위 밖·배열·문자열 아닌 시간대)이면 {} 로 보고 warn", () => {
    const { logger, lines: warnLines } = captureLogger();
    for (const raw of [
      "{nope",
      JSON.stringify({ dailyRunLimit: 0 }),
      "[]",
      JSON.stringify({ timeZone: 9 }),
    ]) {
      setRaw(raw);
      expect(getOpsSettings(db, ws, logger)).toEqual({ dailyRunLimit: 300, timeZone: SEOUL });
    }
    expect(warnLines.filter((l) => l.level === 40 && l.msg === "ops settings unreadable")).toHaveLength(4);
  });

  it("patch 는 준 키만 바꾸고 다른 키(모르는 키 포함)는 남긴다", () => {
    setRaw(JSON.stringify({ future: 1 }));
    expect(patchOpsSettings(db, ws, { dailyRunLimit: null })).toEqual({
      dailyRunLimit: null,
      timeZone: SEOUL,
    });
    expect(patchOpsSettings(db, ws, { dailyRunLimit: 50 }).dailyRunLimit).toBe(50);
    expect(storedRaw()).toEqual({ dailyRunLimit: 50, future: 1 });
    expect(patchOpsSettings(db, ws, { timeZone: "America/New_York" })).toEqual({
      dailyRunLimit: 50,
      timeZone: "America/New_York",
    });
    expect(storedRaw()).toEqual({ dailyRunLimit: 50, future: 1, timeZone: "America/New_York" });
  });

  it("patch 가 범위 밖이면 VALIDATION 으로 던지고 저장하지 않는다", () => {
    expect(() => patchOpsSettings(db, ws, { dailyRunLimit: 0 })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => patchOpsSettings(db, ws, { dailyRunLimit: 10_001 })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(getOpsSettings(db, ws)).toEqual({ dailyRunLimit: 300, timeZone: SEOUL });
  });

  it("없는 시간대 이름이면 VALIDATION 으로 던지고 같이 준 한도도 저장하지 않는다", () => {
    expect(() => patchOpsSettings(db, ws, { dailyRunLimit: 9, timeZone: "Mars/Base" })).toThrow(
      expect.objectContaining({ status: 400, body: expect.objectContaining({ code: "VALIDATION" }) }),
    );
    expect(getOpsSettings(db, ws)).toEqual({ dailyRunLimit: 300, timeZone: SEOUL });
  });

  it("저장된 시간대가 Intl 이 모르는 이름이면 시간대만 기본값으로 읽고 warn — 한도는 그대로", () => {
    const { logger, lines } = captureLogger();
    setRaw(JSON.stringify({ dailyRunLimit: 20, timeZone: "Mars/Base" }));
    expect(getOpsSettings(db, ws, logger)).toEqual({ dailyRunLimit: 20, timeZone: SEOUL });
    expect(lines.filter((l) => l.level === 40 && l.msg === "ops settings time zone unknown")).toHaveLength(1);
    // logger 없이 읽어도 던지지 않는다 — 스케줄러가 매 틱 읽는다
    expect(getOpsSettings(db, ws).timeZone).toBe(SEOUL);
    // 고정 오프셋도 모르는 이름과 같다(IANA 이름만)
    setRaw(JSON.stringify({ dailyRunLimit: 20, timeZone: "+09:00" }));
    expect(getOpsSettings(db, ws).timeZone).toBe(SEOUL);
  });

  it("저장된 시간대를 모를 때 한도만 patch 하면 읽기와 같은 폴백으로 돌려주고, 저장된 이름은 그대로 둔다", () => {
    setRaw(JSON.stringify({ dailyRunLimit: 20, timeZone: "Mars/Base" }));
    expect(patchOpsSettings(db, ws, { dailyRunLimit: 7 })).toEqual({ dailyRunLimit: 7, timeZone: SEOUL });
    expect(storedRaw()).toEqual({ dailyRunLimit: 7, timeZone: "Mars/Base" });
  });

  it("patch 는 시간대를 Intl 의 정규형으로 저장한다 — 대소문자·옛 이름", () => {
    expect(patchOpsSettings(db, ws, { timeZone: "asia/seoul" }).timeZone).toBe("Asia/Seoul");
    expect(storedRaw().timeZone).toBe("Asia/Seoul");
    expect(patchOpsSettings(db, ws, { timeZone: "US/Eastern" }).timeZone).toBe("America/New_York");
    expect(getOpsSettings(db, ws).timeZone).toBe("America/New_York");
  });

  it("망가진 값 위에 patch 하면 {} 에서 시작한다", () => {
    setRaw("{nope");
    expect(patchOpsSettings(db, ws, { dailyRunLimit: 7 })).toEqual({ dailyRunLimit: 7, timeZone: SEOUL });
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
