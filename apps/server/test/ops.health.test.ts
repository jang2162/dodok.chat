import { FAKE_GATEWAY_ID, FakeAdapter, type FakeGatewayState } from "@dodok/openclaw-adapter/fake";
import type { RunnerConnection, RunState } from "@dodok/shared";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client";
import { opsEvents } from "../src/db/schema.sqlite";
import {
  createDiskMonitor,
  DISCONNECT_EVENT_MS,
  DISK_CHECK_INTERVAL_MS,
  diskLevel,
  observeGatewayVersion,
  startRunState,
  watchConnections,
  watchGatewayVersion,
  watchRunFailures,
  watchRunners,
} from "../src/modules/ops/health";
import { createOpsService, type OpsService } from "../src/modules/ops/service";
import { getGatewayRow } from "../src/modules/gateways/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { insertGateway } from "./helpers/gateways";
import { openclawDetail } from "./helpers/openclaw";
import { seedWorkspace } from "./helpers/seed";

const GW = { id: FAKE_GATEWAY_ID, name: "사무실", url: "ws://office", token: "t1", enabled: true };
const OTHER_GW = {
  id: "00000000-0000-4000-8000-0000000000f2",
  name: "집",
  url: "ws://home",
  token: "t2",
  enabled: true,
};
const KEY = `gateway:${FAKE_GATEWAY_ID}`;

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const SEC = 1_000;

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { logger, lines };
}

let db: Db;
let ws: string;
let ops: OpsService;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-25T00:00:00.000Z") });
  db = newTestDb();
  ws = seedWorkspace(db).workspaceId;
  ops = createOpsService({ db, bus: new ServerBus(), logger: pino({ level: "silent" }), workspaceId: ws });
});
afterEach(() => {
  ops.close();
  vi.useRealTimers();
});

const rows = () => db.select().from(opsEvents).all();
const rowsOf = (kind: string) => rows().filter((r) => r.kind === kind);

describe("watchConnections — 60초 넘는 끊김만 사건(Review Focus 2)", () => {
  function setup(initial: Partial<FakeGatewayState> = {}) {
    const adapter = new FakeAdapter();
    adapter.upsertGateway(GW);
    adapter.setGatewayState({ gateway: "connected", bridge: "connected", ...initial });
    const set = (patch: Partial<FakeGatewayState>) => {
      adapter.setGatewayState(patch);
      adapter.emitStatus();
    };
    return { adapter, set };
  }

  it("50초 끊김 → 붙음을 다섯 번 되풀이하면 사건 0줄", () => {
    const { adapter, set } = setup();
    const watch = watchConnections(adapter, ops);
    for (let i = 0; i < 5; i++) {
      set({ gateway: "reconnecting", bridge: "down" });
      vi.advanceTimersByTime(50 * SEC);
      set({ gateway: "connected", bridge: "connected" });
      vi.advanceTimersByTime(5 * SEC);
    }
    vi.advanceTimersByTime(10 * DISCONNECT_EVENT_MS);
    expect(rows()).toEqual([]);
    watch.close();
  });

  it("61초 끊김이면 한 줄이 열리고, 붙으면 그 줄이 닫히며(downMs), 다시 61초 끊기면 새 줄", () => {
    const { adapter, set } = setup();
    const watch = watchConnections(adapter, ops);
    set({ gateway: "reconnecting" });
    vi.advanceTimersByTime(30 * SEC);
    set({ gateway: "down" }); // reconnecting ↔ down 은 끊김이 이어지는 것이다 — 다시 재지 않는다
    vi.advanceTimersByTime(31 * SEC);
    expect(rowsOf("gateway_down")).toEqual([
      expect.objectContaining({
        key: KEY,
        severity: "warn",
        count: 1,
        resolvedAt: null,
        detail: { thresholdMs: DISCONNECT_EVENT_MS, gatewayName: "사무실" },
      }),
    ]);
    expect(rowsOf("plugin_down")).toEqual([]);

    vi.advanceTimersByTime(20 * SEC);
    set({ gateway: "connected" });
    const [closed] = rowsOf("gateway_down");
    expect(closed?.resolvedAt).not.toBeNull();
    // 줄은 끊긴 지 60초에 열리지만 downMs 는 실제로 끊긴 때부터다 — 30 + 31 + 20초
    expect(closed?.detail).toMatchObject({ downMs: 81 * SEC });

    set({ gateway: "reconnecting" });
    vi.advanceTimersByTime(61 * SEC);
    expect(rowsOf("gateway_down")).toHaveLength(2);
    expect(rowsOf("gateway_down").filter((r) => r.resolvedAt === null)).toHaveLength(1);
    watch.close();
  });

  it("90초 끊겼다 붙으면 downMs 는 90초 — 임계 60초를 빼지 않는다", () => {
    const { adapter, set } = setup();
    const watch = watchConnections(adapter, ops);
    set({ bridge: "down" });
    vi.advanceTimersByTime(90 * SEC);
    set({ bridge: "connected" });
    expect(rowsOf("plugin_down")[0]?.detail).toMatchObject({ downMs: 90 * SEC });
    watch.close();
  });

  it("브리지 down 61초 → plugin_down(key 는 그 Gateway), 복구 때 닫힘. Gateway 와 따로 잰다", () => {
    const { adapter, set } = setup();
    const watch = watchConnections(adapter, ops);
    set({ bridge: "down" });
    vi.advanceTimersByTime(40 * SEC);
    set({ gateway: "reconnecting" });
    vi.advanceTimersByTime(21 * SEC);
    expect(rows().map((r) => [r.kind, r.key])).toEqual([["plugin_down", KEY]]);
    set({ bridge: "connected" });
    expect(rowsOf("plugin_down")[0]?.resolvedAt).not.toBeNull();
    vi.advanceTimersByTime(40 * SEC);
    expect(rowsOf("gateway_down")).toHaveLength(1);
    watch.close();
  });

  it("부팅 뒤 한 번도 붙지 않은 채 61초면 gateway_down 1줄", () => {
    const { adapter } = setup({ gateway: "down" });
    const watch = watchConnections(adapter, ops);
    vi.advanceTimersByTime(60 * SEC - 1);
    expect(rows()).toEqual([]);
    vi.advanceTimersByTime(1 * SEC);
    expect(rowsOf("gateway_down")).toHaveLength(1);
    watch.close();
  });

  it("close 뒤에는 타이머가 남지 않고 사건을 남기지 않는다", () => {
    const { adapter, set } = setup();
    const watch = watchConnections(adapter, ops);
    set({ gateway: "down", bridge: "down" });
    watch.close();
    vi.advanceTimersByTime(10 * DISCONNECT_EVENT_MS);
    expect(rows()).toEqual([]);
    set({ gateway: "reconnecting" });
    vi.advanceTimersByTime(10 * DISCONNECT_EVENT_MS);
    expect(rows()).toEqual([]);
  });

  it("앞 프로세스가 열어 둔 끊김 줄도 붙는 순간 닫는다", () => {
    ops.record({ kind: "gateway_down", key: KEY, severity: "warn" });
    const { adapter, set } = setup({ gateway: "reconnecting" });
    const watch = watchConnections(adapter, ops);
    set({ gateway: "connected" });
    expect(rowsOf("gateway_down")[0]?.resolvedAt).not.toBeNull();
    watch.close();
  });
});

describe("watchRunners — 토큰별 runner_down(러너 스펙 5장)", () => {
  const A = "01999999-0000-7000-8000-00000000000a";
  const B = "01999999-0000-7000-8000-00000000000b";
  const runner = (tokenId: string): RunnerConnection => ({
    tokenId,
    label: tokenId === A ? "macbook" : "desktop",
    runnerVersion: "0.0.0",
    sdkVersion: "0.3.283",
    claudeCodeVersion: "2.1.283",
    bundleSha256: null,
    capabilities: [],
    connectedAt: "2026-09-25T00:00:00.000Z",
    agents: [],
  });
  function setup(active = new Set([A, B])) {
    const adapter = new FakeAdapter({ provider: "claude" });
    const connect = (...tokenIds: string[]) => {
      adapter.setSetupDetail({ provider: "claude", runners: tokenIds.map(runner) });
      adapter.setStatus({ provider: "claude", runners: { connected: tokenIds.length, tokens: active.size } });
      adapter.emit({ kind: "status", status: adapter.status(), capabilities: adapter.capabilities() });
      adapter.emit({ kind: "setup" });
    };
    const watch = watchRunners(adapter, ops, { isActiveToken: (id) => active.has(id) });
    return { adapter, connect, watch, active };
  }

  it("붙었던 토큰이 61초 끊기면 runner_down(key 토큰 id) 한 줄, 다시 붙으면 닫힌다(downMs)", () => {
    const { connect, watch } = setup();
    connect(A, B);
    connect(B);
    vi.advanceTimersByTime(60 * SEC - 1);
    expect(rowsOf("runner_down")).toEqual([]);
    vi.advanceTimersByTime(1 * SEC);
    expect(rowsOf("runner_down")).toEqual([
      expect.objectContaining({ key: A, severity: "warn", count: 1, resolvedAt: null }),
    ]);
    vi.advanceTimersByTime(29 * SEC);
    connect(A, B);
    const [closed] = rowsOf("runner_down");
    expect(closed?.resolvedAt).not.toBeNull();
    expect(closed?.detail).toMatchObject({ downMs: 90 * SEC - 1 });
    watch.close();
  });

  it("50초 끊김 → 붙음이면 사건 없음, 두 토큰은 따로 잰다", () => {
    const { connect, watch } = setup();
    connect(A, B);
    connect(B);
    vi.advanceTimersByTime(50 * SEC);
    connect(A);
    vi.advanceTimersByTime(61 * SEC);
    expect(rowsOf("runner_down").map((r) => r.key)).toEqual([B]);
    watch.close();
  });

  it("한 번도 붙지 않은 토큰은 사건을 남기지 않는다 — 러너 0대로 시작해도 조용하다", () => {
    const { connect, watch } = setup();
    connect();
    vi.advanceTimersByTime(10 * DISCONNECT_EVENT_MS);
    expect(rows()).toEqual([]);
    watch.close();
  });

  it("끊긴 사이 폐기된 토큰은 사건을 남기지 않는다", () => {
    const { connect, watch, active } = setup();
    connect(A);
    connect();
    active.delete(A);
    vi.advanceTimersByTime(61 * SEC);
    expect(rows()).toEqual([]);
    watch.close();
  });

  it("OpenClaw 어댑터의 상태는 보지 않고, close 뒤에는 타이머가 남지 않는다", () => {
    const { connect, watch } = setup();
    connect(A);
    connect();
    watch.close();
    vi.advanceTimersByTime(10 * DISCONNECT_EVENT_MS);
    expect(rows()).toEqual([]);
    const openclaw = new FakeAdapter();
    const other = watchRunners(openclaw, ops, { isActiveToken: () => true });
    openclaw.emit({ kind: "status", status: openclaw.status(), capabilities: openclaw.capabilities() });
    vi.advanceTimersByTime(10 * DISCONNECT_EVENT_MS);
    expect(rows()).toEqual([]);
    other.close();
  });

  it("앞 프로세스가 열어 둔 runner_down 줄도 그 토큰이 붙는 순간 닫는다", () => {
    ops.record({ kind: "runner_down", key: A, severity: "warn" });
    const { connect, watch } = setup();
    connect(A);
    expect(rowsOf("runner_down")[0]?.resolvedAt).not.toBeNull();
    watch.close();
  });
});

describe("diskLevel", () => {
  it.each([
    [255 * MIB, 100 * GIB, "error"],
    [900 * MIB, 100 * GIB, "warn"],
    [3 * GIB, 100 * GIB, "warn"], // 3%
    [3 * GIB, 10 * GIB, "ok"],
    [256 * MIB, 256 * MIB, "warn"], // 256 MiB 는 error 가 아니다(1 GiB 미만이라 warn)
    [1 * GIB, 20 * GIB, "ok"], // 1 GiB·5% 는 미만이 아니다
  ] as const)("free %d / total %d → %s", (free, total, level) => {
    expect(diskLevel(free, total)).toBe(level);
  });
});

describe("createDiskMonitor", () => {
  const statfsOf = (freeBytes: number, totalBytes: number) =>
    vi.fn(async () => ({
      bavail: BigInt(freeBytes / 4096),
      bsize: 4096n,
      blocks: BigInt(totalBytes / 4096),
    }));

  it("부팅 때 재고 warn·error 면 disk_low(key data, detail.freeBytes)를 남긴다. 10분마다 다시 잰다", async () => {
    const { logger } = captureLogger();
    const statfs = statfsOf(900 * MIB, 100 * GIB);
    const disk = createDiskMonitor({ dataDir: "/data", ops, statfs, logger });
    expect(disk.current()).toEqual({ level: "unknown" }); // 첫 측정 전
    await disk.ready;
    expect(statfs).toHaveBeenCalledWith("/data");
    expect(disk.current()).toEqual({ level: "warn", freeBytes: 900 * MIB, totalBytes: 100 * GIB });
    expect(rowsOf("disk_low")).toEqual([
      expect.objectContaining({ key: "data", severity: "warn", detail: { freeBytes: 900 * MIB } }),
    ]);

    statfs.mockImplementation(async () => ({ bavail: 100n, bsize: 4096n, blocks: 1_000_000n }));
    await vi.advanceTimersByTimeAsync(DISK_CHECK_INTERVAL_MS);
    expect(statfs).toHaveBeenCalledTimes(2);
    expect(disk.current().level).toBe("error");
    expect(rowsOf("disk_low").map((r) => r.severity)).toEqual(["error"]); // 같은 줄이 error 로 오른다
    disk.close();
  });

  it("ok 면 사건이 없다", async () => {
    const disk = createDiskMonitor({
      dataDir: "/data",
      ops,
      statfs: statfsOf(3 * GIB, 10 * GIB),
      logger: pino({ level: "silent" }),
    });
    await disk.ready;
    expect(disk.current().level).toBe("ok");
    expect(rows()).toEqual([]);
    disk.close();
  });

  it("statfs 가 던지면 unknown + warn 로그, 사건 없음", async () => {
    const { logger, lines: logged } = captureLogger();
    const statfs = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT: /secret/path"), { code: "ENOENT" });
    });
    const disk = createDiskMonitor({ dataDir: "/data", ops, statfs, logger });
    await disk.ready;
    expect(disk.current()).toEqual({ level: "unknown" });
    expect(rows()).toEqual([]);
    expect(logged).toContainEqual(
      expect.objectContaining({ level: 40, msg: "disk check failed", code: "ENOENT" }),
    );
    disk.close();
  });

  it("error 를 잰 뒤 statfs 가 던지면 unknown 으로 돌아간다 — 옛 error 로 업로드를 계속 막지 않는다", async () => {
    const statfs = statfsOf(100 * MIB, 50 * GIB);
    const disk = createDiskMonitor({ dataDir: "/data", ops, statfs, logger: pino({ level: "silent" }) });
    await disk.ready;
    expect(disk.current().level).toBe("error");
    statfs.mockImplementation(async () => {
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    });
    await vi.advanceTimersByTimeAsync(DISK_CHECK_INTERVAL_MS);
    expect(statfs).toHaveBeenCalledTimes(2);
    expect(disk.current()).toEqual({ level: "unknown" });
    disk.close();
  });

  it("check() 는 주기를 기다리지 않고 지금 다시 잰다 — 끝나면 current()·사건에 곧바로 반영된다", async () => {
    const statfs = statfsOf(3 * GIB, 10 * GIB);
    const disk = createDiskMonitor({ dataDir: "/data", ops, statfs, logger: pino({ level: "silent" }) });
    await disk.ready;
    expect(disk.current().level).toBe("ok");
    statfs.mockImplementation(async () => ({ bavail: 100n, bsize: 4096n, blocks: 1_000_000n }));
    await disk.check();
    expect(statfs).toHaveBeenCalledTimes(2);
    expect(disk.current().level).toBe("error");
    expect(rowsOf("disk_low").map((r) => r.severity)).toEqual(["error"]);
    disk.close();
  });

  it("check() 가 진행 중인 측정과 겹치면 그 측정이 끝난 뒤 한 번 더 잰다 — 부르기 전에 바꾼 값을 놓치지 않는다", async () => {
    let release: (v: { bavail: bigint; bsize: bigint; blocks: bigint }) => void = () => {};
    const statfs = vi.fn(
      () => new Promise<{ bavail: bigint; bsize: bigint; blocks: bigint }>((r) => (release = r)),
    );
    const disk = createDiskMonitor({ dataDir: "/data", ops, statfs, logger: pino({ level: "silent" }) });
    const checked = disk.check(); // 첫 측정(ready)이 아직 진행 중
    release({ bavail: 1_000_000n, bsize: 4096n, blocks: 2_000_000n }); // 옛 값 — ok
    await disk.ready;
    await vi.waitFor(() => expect(statfs).toHaveBeenCalledTimes(2));
    release({ bavail: 100n, bsize: 4096n, blocks: 2_000_000n }); // 새 값 — error
    await checked;
    expect(disk.current().level).toBe("error");
    disk.close();
  });

  it("close 뒤 check() 는 재지 않는다", async () => {
    const statfs = statfsOf(3 * GIB, 10 * GIB);
    const disk = createDiskMonitor({ dataDir: "/data", ops, statfs, logger: pino({ level: "silent" }) });
    await disk.ready;
    disk.close();
    await disk.check();
    expect(statfs).toHaveBeenCalledTimes(1);
  });

  it("close 뒤에는 다시 재지 않고, 진행 중이던 측정 결과도 기록하지 않는다", async () => {
    let release: (v: { bavail: number; bsize: number; blocks: number }) => void = () => {};
    const statfs = vi.fn(
      () => new Promise<{ bavail: number; bsize: number; blocks: number }>((r) => (release = r)),
    );
    const disk = createDiskMonitor({ dataDir: "/data", ops, statfs, logger: pino({ level: "silent" }) });
    disk.close();
    release({ bavail: 1, bsize: 4096, blocks: 1_000_000 });
    await disk.ready;
    await vi.advanceTimersByTimeAsync(3 * DISK_CHECK_INTERVAL_MS);
    expect(statfs).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([]);
  });
});

describe("observeGatewayVersion — Gateway 별 gateways.last_version", () => {
  const lastVersion = () => getGatewayRow(db, ws, GW.id)?.lastVersion;
  beforeEach(() => void insertGateway(db, ws, { id: GW.id, name: GW.name }));

  it("처음 본 버전이 핀과 다르면 untested 1·changed 0, 같은 값은 0, 바뀌면 changed(from·to)와 새 key 의 untested", () => {
    const deps = { db, workspaceId: ws, ops };
    const updatedAt = getGatewayRow(db, ws, GW.id)?.updatedAt;
    observeGatewayVersion(GW, "2026.9.5", deps);
    expect(rows().map((r) => [r.kind, r.key, r.severity, r.detail])).toEqual([
      ["gateway_version_untested", `${KEY}:2026.9.5`, "info", { gatewayName: "사무실", version: "2026.9.5" }],
    ]);
    expect(lastVersion()).toBe("2026.9.5");
    // 관측값이라 설정의 updated_at 은 그대로
    expect(getGatewayRow(db, ws, GW.id)?.updatedAt).toEqual(updatedAt);

    observeGatewayVersion(GW, "2026.9.5", deps);
    expect(rows()).toHaveLength(1);

    observeGatewayVersion(GW, "2026.9.6", deps);
    expect(rowsOf("gateway_version_changed")).toEqual([
      expect.objectContaining({
        key: KEY,
        severity: "warn",
        detail: { from: "2026.9.5", to: "2026.9.6", gatewayName: "사무실" },
      }),
    ]);
    expect(rowsOf("gateway_version_untested").map((r) => r.key)).toEqual([
      `${KEY}:2026.9.5`,
      `${KEY}:2026.9.6`,
    ]);
    expect(lastVersion()).toBe("2026.9.6");
  });

  it("핀과 같은 버전은 untested 가 없고, null 은 아무것도 하지 않는다", () => {
    const deps = { db, workspaceId: ws, ops };
    observeGatewayVersion(GW, null, deps);
    expect(lastVersion()).toBeNull();
    observeGatewayVersion(GW, "2026.9.4", deps);
    expect(rows()).toEqual([]);
    expect(lastVersion()).toBe("2026.9.4");
    observeGatewayVersion(GW, "2026.9.5", deps);
    expect(
      rows()
        .map((r) => r.kind)
        .sort(),
    ).toEqual(["gateway_version_changed", "gateway_version_untested"]);
  });

  it("사건을 쓰다 던지면 기억하지 않는다 — 다음 관측이 다시 쓴다", () => {
    const failing = {
      record: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    expect(() => observeGatewayVersion(GW, "2026.9.5", { db, workspaceId: ws, ops: failing })).toThrow(
      "boom",
    );
    expect(lastVersion()).toBeNull();
    observeGatewayVersion(GW, "2026.9.5", { db, workspaceId: ws, ops });
    expect(rowsOf("gateway_version_untested")).toHaveLength(1);
    expect(lastVersion()).toBe("2026.9.5");
  });

  it("지운 Gateway(행 없음)는 사건도 기억도 남기지 않는다", () => {
    observeGatewayVersion({ id: OTHER_GW.id, name: OTHER_GW.name }, "2026.9.5", { db, workspaceId: ws, ops });
    expect(rows()).toEqual([]);
    expect(getGatewayRow(db, ws, OTHER_GW.id)).toBeUndefined();
  });
});

describe("watchGatewayVersion", () => {
  beforeEach(() => void insertGateway(db, ws, { id: GW.id, name: GW.name }));

  it("Gateway 가 connected 일 때 setup·status 이벤트에서 바뀐 버전만 대조한다", () => {
    const adapter = new FakeAdapter();
    adapter.upsertGateway(GW);
    const detail = openclawDetail(adapter);
    const setVersion = (version: string | null) =>
      adapter.setSetupDetail({ ...detail, gateway: { ...detail.gateway, version } });
    const lastVersion = () => getGatewayRow(db, ws, GW.id)?.lastVersion;
    const { logger } = captureLogger();
    adapter.setGatewayState({ gateway: "reconnecting" });
    setVersion("2026.9.5");
    const watch = watchGatewayVersion(adapter, { db, workspaceId: ws, ops, logger });
    adapter.emit({ kind: "setup" });
    expect(lastVersion()).toBeNull(); // 붙기 전에는 보지 않는다

    adapter.setGatewayState({ gateway: "connected" });
    adapter.emitStatus();
    expect(lastVersion()).toBe("2026.9.5");
    adapter.emit({ kind: "setup" });
    expect(rowsOf("gateway_version_untested")).toHaveLength(1);

    setVersion("2026.9.6");
    adapter.emit({ kind: "setup" });
    expect(rowsOf("gateway_version_changed")).toHaveLength(1);
    watch.close();
    setVersion("2026.9.7");
    adapter.emit({ kind: "setup" });
    expect(lastVersion()).toBe("2026.9.6");
  });

  it("DB 오류는 logger.error 한 줄(Gateway id)로 끝내고 던지지 않는다", () => {
    const adapter = new FakeAdapter();
    adapter.upsertGateway(GW);
    const detail = openclawDetail(adapter);
    adapter.setSetupDetail({ ...detail, gateway: { ...detail.gateway, version: "2026.9.5" } });
    const { logger, lines: logged } = captureLogger();
    db.$client.close();
    expect(() => watchGatewayVersion(adapter, { db, workspaceId: ws, ops, logger })).not.toThrow();
    expect(logged).toContainEqual(
      expect.objectContaining({ level: 50, gatewayId: GW.id, msg: "gateway version check failed" }),
    );
  });
});

describe("startRunState — 종료 표지", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "dodok-run-state-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const file = () => join(dir, "run-state.json");
  const silent = pino({ level: "silent" });

  it("파일이 없으면 previousClean null·사건 0, 새 표지 {clean:false, startedAt} 를 쓴다", () => {
    const state = startRunState(dir, ops, silent);
    expect(state.previousClean).toBeNull();
    expect(rows()).toEqual([]);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      clean: false,
      startedAt: "2026-09-25T00:00:00.000Z",
    });
  });

  it("직전 표지가 clean:false 면 unclean_shutdown(process, warn) 1줄", () => {
    writeFileSync(file(), JSON.stringify({ clean: false, startedAt: "2026-09-24T00:00:00.000Z" }));
    const state = startRunState(dir, ops, silent);
    expect(state.previousClean).toBe(false);
    expect(rows()).toEqual([
      expect.objectContaining({ kind: "unclean_shutdown", key: "process", severity: "warn" }),
    ]);
  });

  it("markClean 뒤 다시 시작하면 사건 0", () => {
    startRunState(dir, ops, silent).markClean();
    expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ clean: true });
    const again = startRunState(dir, ops, silent);
    expect(again.previousClean).toBe(true);
    expect(rows()).toEqual([]);
  });

  it("망가진 JSON 이면 warn·사건 0·새로 쓴다", () => {
    const { logger, lines: logged } = captureLogger();
    writeFileSync(file(), "{not json");
    const state = startRunState(dir, ops, logger);
    expect(state.previousClean).toBeNull();
    expect(rows()).toEqual([]);
    expect(logged).toContainEqual(expect.objectContaining({ level: 40, msg: "run state unreadable" }));
    expect(JSON.parse(readFileSync(file(), "utf8"))).toMatchObject({ clean: false });
  });

  it("쓸 수 없는 자리면 warn 만 남기고 던지지 않는다", () => {
    const { logger, lines: logged } = captureLogger();
    const state = startRunState(join(dir, "missing", "deeper"), ops, logger);
    expect(() => state.markClean()).not.toThrow();
    expect(logged.filter((l) => l.level === 40).map((l) => l.msg)).toEqual([
      "run state write failed",
      "run state write failed",
    ]);
  });
});

describe("watchRunFailures", () => {
  const run = (id: string, status: RunState["status"], code?: string): RunState => ({
    id,
    channelId: "01a09fc9-d204-7551-89d6-38544d07a102",
    conversationId: "01a09fc9-d204-7551-89d6-38544d07a102",
    agentId: "01a09fc9-d204-7551-89d6-38544d07a103",
    status,
    relayDepth: 0,
    hasCanonical: false,
    startedAt: "2026-09-25T00:00:00.000Z",
    ...(code === undefined ? {} : { error: { code, message: "본문은 싣지 않는다" } }),
  });

  it("error 로 바뀐 런마다 한 번 run_failed(agent:<id>, warn, detail.code) — 같은 런의 중복 방송은 세지 않는다", () => {
    const bus = new ServerBus();
    const watch = watchRunFailures(bus, ops);
    bus.emit("run.state", { run: run("r1", "queued") });
    bus.emit("run.state", { run: run("r1", "streaming") });
    expect(rows()).toEqual([]);
    bus.emit("run.state", { run: run("r1", "error", "TIMEOUT") });
    bus.emit("run.state", { run: run("r1", "error", "TIMEOUT") });
    bus.emit("run.state", { run: run("r2", "done") });
    bus.emit("run.state", { run: run("r3", "error") });
    expect(rowsOf("run_failed")).toEqual([
      expect.objectContaining({
        key: "agent:01a09fc9-d204-7551-89d6-38544d07a103",
        severity: "warn",
        count: 2,
      }),
    ]);
    watch.close();
    bus.emit("run.state", { run: run("r4", "error", "X") });
    expect(rowsOf("run_failed")[0]?.count).toBe(2);
  });

  it("detail 에는 code 만 싣고 200자로 자른다", () => {
    const bus = new ServerBus();
    const watch = watchRunFailures(bus, ops);
    bus.emit("run.state", { run: run("r1", "error", `DROPPED:${"x".repeat(300)}`) });
    const detail = rowsOf("run_failed")[0]?.detail ?? {};
    expect(Object.keys(detail)).toEqual(["code"]);
    expect(detail.code).toHaveLength(200);
    watch.close();
  });
});
