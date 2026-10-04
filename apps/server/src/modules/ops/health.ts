import { OPENCLAW_PINNED_VERSION } from "@dodok/openclaw-adapter";
import type { RunState } from "@dodok/shared";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { statfs as fsStatfs } from "node:fs/promises";
import { join } from "node:path";
import type { AgentAdapter, OpenClawGateways } from "../../adapters/types";
import type { Db } from "../../db/client";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { getGatewayRow, setGatewayLastVersion } from "../gateways/service";
import type { OpsService } from "./service";

// 운영 보강 스펙 5장 — 끊김·Gateway 버전·디스크·종료 표지·실패한 런을 운영 사건으로 남긴다

/** 끊김이 이만큼 이어져야 사건을 연다 — 그보다 짧은 깜빡임은 남기지 않는다(Review Focus 2) */
export const DISCONNECT_EVENT_MS = 60_000;
export const DISK_CHECK_INTERVAL_MS = 600_000;

const MIB = 1024 * 1024;
/** 이보다 적으면 error — 첨부 업로드를 507 로 거절해 SQLite 가 쓸 자리를 남긴다 */
export const DISK_ERROR_FREE_BYTES = 256 * MIB;
export const DISK_WARN_FREE_BYTES = 1024 * MIB;
export const DISK_WARN_FREE_RATIO = 0.05;

export type DiskState =
  | { freeBytes: number; totalBytes: number; level: "ok" | "warn" | "error" }
  | { level: "unknown" };

export function diskLevel(freeBytes: number, totalBytes: number): "ok" | "warn" | "error" {
  if (freeBytes < DISK_ERROR_FREE_BYTES) return "error";
  if (freeBytes < DISK_WARN_FREE_BYTES || freeBytes / totalBytes < DISK_WARN_FREE_RATIO) return "warn";
  return "ok";
}

type DownKind = "gateway_down" | "plugin_down";

/** 운영 사건 key — Gateway 의 끊김·버전 사건은 Gateway 마다 따로 묶인다(멀티 Gateway 스펙 「운영」 절) */
export const gatewayEventKey = (gatewayId: string): string => `gateway:${gatewayId}`;

/**
 * Gateway 마다 WS·플러그인 상태를 보고 60초 넘는 끊김에 사건(key `gateway:<id>`, detail 에 Gateway 이름)을 열고 복구 때 닫는다.
 * 부팅 직후 한 번도 안 붙은 상태도 60초 뒤 연다. Gateway 는 connected 가 아니면(reconnecting·down 사이를 오가도) 끊김이 이어지는
 * 것으로 본다. 꺼진 Gateway 는 고장이 아니다 — 재던 끊김을 멈추고 열린 줄을 닫는다. 목록에서 빠진(지운) Gateway 도 같다.
 * Gateway 가 없으면 아무것도 남기지 않는다
 */
export function watchConnections(
  adapter: Pick<AgentAdapter, "status" | "onEvent">,
  ops: Pick<OpsService, "record" | "resolve">,
  delayMs = DISCONNECT_EVENT_MS,
): { close(): void } {
  const watchSide = (kind: DownKind, key: string, name: () => string) => {
    let up: boolean | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    return {
      observe(next: boolean) {
        if (next === up) return;
        up = next;
        stopTimer();
        if (next) {
          // 열린 줄이 없으면 null — 이 프로세스가 연 줄이 아니어도(앞 프로세스가 끊긴 채 죽음) 붙은 순간 닫는다
          ops.resolve(kind, key);
          return;
        }
        timer = setTimeout(() => {
          timer = undefined;
          // 줄은 끊긴 지 delayMs 뒤에 열린다 — 닫을 때 downMs 가 실제로 끊긴 때부터가 되게 임계를 싣는다(store.resolveEvent)
          ops.record({ kind, key, severity: "warn", detail: { thresholdMs: delayMs, gatewayName: name() } });
        }, delayMs);
        timer.unref();
      },
      /** 꺼짐·지움 — 재던 끊김을 버리고 열린 줄을 닫는다 */
      settle() {
        stopTimer();
        ops.resolve(kind, key);
      },
      close: stopTimer,
    };
  };
  type Watched = {
    name: string;
    gateway: ReturnType<typeof watchSide>;
    plugin: ReturnType<typeof watchSide>;
  };
  const watched = new Map<string, Watched>();
  // 열린 줄을 이미 닫은 꺼진 Gateway — status 이벤트마다 다시 닫으러 가지 않는다
  const settled = new Set<string>();
  const observe = (status: ReturnType<AgentAdapter["status"]>) => {
    // Gateway·플러그인 줄은 OpenClaw 어댑터의 것이다 — 다른 어댑터의 상태는 건드리지 않는다
    if (status.provider !== "openclaw") return;
    const live = new Set<string>();
    for (const entry of status.gateways) {
      if (!entry.enabled) {
        if (settled.has(entry.id)) continue;
        settled.add(entry.id);
        const off = watched.get(entry.id);
        watched.delete(entry.id);
        if (off) {
          off.gateway.settle();
          off.plugin.settle();
        } else {
          // 앞 프로세스가 열어 둔 줄 — 꺼진 채 부팅해도 닫는다
          ops.resolve("gateway_down", gatewayEventKey(entry.id));
          ops.resolve("plugin_down", gatewayEventKey(entry.id));
        }
        continue;
      }
      settled.delete(entry.id);
      live.add(entry.id);
      let w = watched.get(entry.id);
      if (!w) {
        const key = gatewayEventKey(entry.id);
        const created: Watched = {
          name: entry.name,
          gateway: watchSide("gateway_down", key, () => created.name),
          plugin: watchSide("plugin_down", key, () => created.name),
        };
        w = created;
        watched.set(entry.id, w);
      }
      w.name = entry.name;
      w.gateway.observe(entry.gateway === "connected");
      w.plugin.observe(entry.bridge === "connected");
    }
    const listed = new Set(status.gateways.map((entry) => entry.id));
    for (const [id, w] of watched) {
      if (live.has(id)) continue;
      watched.delete(id);
      w.gateway.settle();
      w.plugin.settle();
    }
    for (const id of settled) if (!listed.has(id)) settled.delete(id);
  };
  const off = adapter.onEvent((e) => {
    if (e.kind === "status") observe(e.status);
  });
  observe(adapter.status());
  return {
    close() {
      off();
      for (const w of watched.values()) {
        w.gateway.close();
        w.plugin.close();
      }
    },
  };
}

/**
 * 러너 어댑터(claude)의 붙은 러너를 토큰별로 보고(러너 스펙 5장), 이 프로세스에서 붙은 적이 있는 토큰이 delayMs 넘게 끊겨 있으면
 * runner_down(key 토큰 id)을 열고 다시 붙으면 닫는다. 한 번도 안 붙은 토큰·끊긴 사이 폐기된 토큰은 사건을 남기지 않는다
 */
export function watchRunners(
  adapter: Pick<AgentAdapter, "setupDetail" | "onEvent">,
  ops: Pick<OpsService, "record" | "resolve">,
  opts: { isActiveToken(tokenId: string): boolean; delayMs?: number },
): { close(): void } {
  const delayMs = opts.delayMs ?? DISCONNECT_EVENT_MS;
  let connected = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const observe = () => {
    const detail = adapter.setupDetail();
    if (detail.provider !== "claude") return;
    const next = new Set(detail.runners.map((r) => r.tokenId));
    for (const tokenId of next) {
      if (connected.has(tokenId)) continue;
      clearTimeout(timers.get(tokenId));
      timers.delete(tokenId);
      // 열린 줄이 없으면 null — 앞 프로세스가 연 줄도 붙은 순간 닫는다
      ops.resolve("runner_down", tokenId);
    }
    for (const tokenId of connected) {
      if (next.has(tokenId)) continue;
      const timer = setTimeout(() => {
        timers.delete(tokenId);
        if (!opts.isActiveToken(tokenId)) return;
        ops.record({ kind: "runner_down", key: tokenId, severity: "warn", detail: { thresholdMs: delayMs } });
      }, delayMs);
      timer.unref();
      timers.set(tokenId, timer);
    }
    connected = next;
  };
  // hello·끊김마다 어댑터가 status 와 setup 을 함께 낸다 — 같은 목록을 두 번 보면 두 번째는 할 일이 없다
  const off = adapter.onEvent((e) => {
    if (e.kind === "status" || e.kind === "setup") observe();
  });
  observe();
  return {
    close() {
      off();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** 받은 Gateway 버전과 저장소 핀 — 버전을 모르면(null) 드리프트로 보지 않는다. 운영 상태·연결 페이지가 같은 판정을 쓴다 */
export function gatewayPin(version: string | null): { pinned: string; drift: boolean } {
  return { pinned: OPENCLAW_PINNED_VERSION, drift: version !== null && version !== OPENCLAW_PINNED_VERSION };
}

/**
 * 접속 때 받은 그 Gateway 의 버전을 기억(gateways.last_version)과 핀에 대조해 사건을 남긴다(key 에 Gateway id, detail 에 이름 —
 * untested 는 버전도. 웹은 key 를 풀지 않고 detail 을 읽는다).
 * 기억과 같으면 아무것도 하지 않는다 — untested 는 그 Gateway 의 버전이 바뀔 때마다 한 번. 지운 Gateway 면 아무것도 하지 않는다.
 * DB 오류는 던진다(부르는 쪽이 로그로 끝낸다)
 */
export function observeGatewayVersion(
  gateway: { id: string; name: string },
  version: string | null,
  deps: { db: Db; workspaceId: string; ops: Pick<OpsService, "record"> },
): void {
  if (version === null) return;
  const { db, workspaceId, ops } = deps;
  const row = getGatewayRow(db, workspaceId, gateway.id);
  if (!row || row.lastVersion === version) return;
  const last = row.lastVersion;
  const key = gatewayEventKey(gateway.id);
  if (last !== null)
    ops.record({
      kind: "gateway_version_changed",
      key,
      severity: "warn",
      detail: { from: last, to: version, gatewayName: gateway.name },
    });
  if (version !== OPENCLAW_PINNED_VERSION)
    ops.record({
      kind: "gateway_version_untested",
      key: `${key}:${version}`,
      severity: "info",
      detail: { gatewayName: gateway.name, version },
    });
  // 사건 → 기억 차례 — 사건 쓰기가 던지면 기억하지 않아 다음 관측이 다시 쓴다
  setGatewayLastVersion(db, workspaceId, gateway.id, version);
}

/**
 * 어댑터 setup·status 이벤트마다 Gateway 별 상태를 보고, connected 인 Gateway 의 버전(Gateway 별 상세)이 그 Gateway 에서 앞서 본
 * 값과 다르면 observeGatewayVersion 을 부른다. 꺼진 Gateway 는 보지 않는다. DB 오류는 logger.error 한 줄로 끝낸다 — 연결 처리를
 * 막지 않는다
 */
export function watchGatewayVersion(
  adapter: Pick<AgentAdapter, "status" | "onEvent"> & Pick<OpenClawGateways, "gatewaySetupDetails">,
  deps: { db: Db; workspaceId: string; ops: Pick<OpsService, "record">; logger: Pick<Logger, "error"> },
): { close(): void } {
  const seen = new Map<string, string>();
  const check = () => {
    const status = adapter.status();
    if (status.provider !== "openclaw") return;
    const versions = new Map(adapter.gatewaySetupDetails().map((d) => [d.id, d.gateway.version]));
    for (const gateway of status.gateways) {
      if (!gateway.enabled || gateway.gateway !== "connected") continue;
      const version = versions.get(gateway.id) ?? null;
      if (version === null || version === seen.get(gateway.id)) continue;
      seen.set(gateway.id, version);
      try {
        observeGatewayVersion(gateway, version, deps);
      } catch (err) {
        deps.logger.error({ err, gatewayId: gateway.id }, "gateway version check failed");
      }
    }
    const listed = new Set(status.gateways.map((gateway) => gateway.id));
    for (const id of seen.keys()) if (!listed.has(id)) seen.delete(id);
  };
  const off = adapter.onEvent((e) => {
    if (e.kind === "setup" || e.kind === "status") check();
  });
  check();
  return { close: off };
}

type Statfs = (
  path: string,
) => Promise<{ bavail: bigint | number; bsize: bigint | number; blocks: bigint | number }>;

/**
 * DATA_DIR 의 디스크 여유를 지금 한 번, 그 뒤 intervalMs 마다 잰다. warn·error 면 disk_low 를 남긴다(같은 줄로 묶인다).
 * ready 는 첫 측정이 끝나면 풀린다 — 그 전과 statfs 실패 때 current() 는 unknown 이고 업로드를 막지 않는다.
 * check() 는 주기를 기다리지 않고 지금 다시 잰다(진행 중인 측정이 있으면 그것이 끝난 뒤) — dev:fake 디스크 흉내가 쓴다
 */
export function createDiskMonitor(deps: {
  dataDir: string;
  ops: Pick<OpsService, "record">;
  logger: Pick<Logger, "warn">;
  statfs?: Statfs;
  intervalMs?: number;
}): { current(): DiskState; check(): Promise<void>; close(): void; ready: Promise<void> } {
  const { dataDir, ops, logger } = deps;
  const statfs: Statfs = deps.statfs ?? ((p) => fsStatfs(p, { bigint: true }));
  let state: DiskState = { level: "unknown" };
  let closed = false;
  let inflight: Promise<void> | undefined;

  const measure = async () => {
    try {
      const s = await statfs(dataDir);
      if (closed) return;
      const bsize = BigInt(s.bsize);
      const freeBytes = Number(BigInt(s.bavail) * bsize);
      const totalBytes = Number(BigInt(s.blocks) * bsize);
      const level = diskLevel(freeBytes, totalBytes);
      state = { freeBytes, totalBytes, level };
      if (level !== "ok")
        ops.record({ kind: "disk_low", key: "data", severity: level, detail: { freeBytes } });
    } catch (err) {
      if (closed) return;
      state = { level: "unknown" };
      // 경로가 든 메시지는 싣지 않는다 — 코드만
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      logger.warn({ code: code ?? "unknown" }, "disk check failed");
    }
  };
  /** 주기 측정 — 진행 중인 측정이 있으면 건너뛴다(겹쳐 재지 않는다) */
  const tick = (): Promise<void> => {
    if (closed || inflight) return inflight ?? Promise.resolve();
    const run = measure().finally(() => {
      if (inflight === run) inflight = undefined;
    });
    inflight = run;
    return run;
  };

  const ready = tick();
  const timer = setInterval(() => void tick(), deps.intervalMs ?? DISK_CHECK_INTERVAL_MS);
  timer.unref();
  return {
    current: () => state,
    async check() {
      // 진행 중인 측정은 부르기 전 값을 읽었을 수 있다 — 끝나기를 기다렸다가 새로 잰다
      await inflight;
      await tick();
    },
    close() {
      closed = true;
      clearInterval(timer);
    },
    ready,
  };
}

const RUN_STATE_FILE = "run-state.json";

/**
 * 부팅: 직전 표지를 읽고(clean:false 면 unclean_shutdown) 새 표지 {clean:false,startedAt} 를 쓴다. markClean 은 종료 끝에.
 * 읽기·쓰기 실패는 warn 로그만 — 부팅·종료를 막지 않는다(스펙 9장)
 */
export function startRunState(
  dataDir: string,
  ops: Pick<OpsService, "record">,
  logger: Pick<Logger, "warn">,
): { markClean(): void; previousClean: boolean | null } {
  const path = join(dataDir, RUN_STATE_FILE);
  let previousClean: boolean | null = null;
  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") logger.warn({ code: code ?? "unknown" }, "run state unreadable");
  }
  if (raw !== undefined) {
    let clean: unknown;
    try {
      clean = (JSON.parse(raw) as { clean?: unknown } | null)?.clean;
    } catch {
      clean = undefined;
    }
    if (typeof clean === "boolean") previousClean = clean;
    else logger.warn("run state unreadable");
  }
  if (previousClean === false) ops.record({ kind: "unclean_shutdown", key: "process", severity: "warn" });

  const startedAt = new Date().toISOString();
  // 임시 파일에 쓰고 rename — 쓰다 죽어도 반쯤 쓴 JSON 이 남지 않는다
  const write = (value: { clean: boolean; startedAt: string; stoppedAt?: string }) => {
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(value));
      renameSync(tmp, path);
    } catch (err) {
      logger.warn({ code: (err as NodeJS.ErrnoException).code ?? "unknown" }, "run state write failed");
    }
  };
  write({ clean: false, startedAt });
  return {
    previousClean,
    markClean: () => write({ clean: true, startedAt, stoppedAt: new Date().toISOString() }),
  };
}

/** 오류 코드는 run_error 의 code 그대로 — `DROPPED:<사유>` 처럼 길어질 수 있어 사건 detail 상한(200자)에 맞춰 자른다 */
const MAX_DETAIL_CHARS = 200;

/**
 * run.state 에서 error 로 바뀐 런마다 run_failed 를 한 번 남긴다. 같은 런의 error 방송이 다시 와도(재동기 등) 두 번 세지 않게
 * 센 runId 를 최근 RUN_FAILED_MEMORY 개까지 기억한다
 */
export function watchRunFailures(bus: ServerBus, ops: Pick<OpsService, "record">): { close(): void } {
  const counted = new Set<string>();
  const off = bus.on("run.state", ({ run }: { run: RunState }) => {
    if (run.status !== "error" || counted.has(run.id)) return;
    counted.add(run.id);
    if (counted.size > RUN_FAILED_MEMORY) {
      const oldest = counted.values().next().value;
      if (oldest !== undefined) counted.delete(oldest);
    }
    ops.record({
      kind: "run_failed",
      key: `agent:${run.agentId}`,
      severity: "warn",
      ...(run.error === undefined ? {} : { detail: { code: run.error.code.slice(0, MAX_DETAIL_CHARS) } }),
    });
  });
  return { close: off };
}

/** 한 런의 error 방송은 끝난 직후에 몰린다 — 동시에 끝나는 런 수보다 넉넉하면 된다 */
const RUN_FAILED_MEMORY = 1_000;
