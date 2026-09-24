/**
 * Phase 3 ③ 계획 태스크 4 — 운영 안정성 사건의 배선. 실제 서버 + 가짜 Gateway·플러그인 + wire 클라이언트.
 * 60초 임계 자체(깜빡임 0줄·61초 한 줄)는 가짜 타이머 단위 테스트(ops.health.test.ts)가 잰다 — 여기서는 실제 시계로
 * 잴 수 있게 임계를 줄여(disconnectEventMs) 어댑터 상태 → 사건 → owner 소켓 → 복구 닫힘이 이어지는지를 본다
 */
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opsEvents } from "../../src/db/schema.sqlite";
import { getOpsSettings } from "../../src/modules/ops/settings";
import { bootLiveApp, type LiveApp, type LiveAppOptions } from "../helpers/live-app";
import { makePng } from "../helpers/png";
import { openChannelWire, sendMessage, setupRelayChannel } from "../helpers/scenario-steps";
import { connectWire, waitFor, type WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };

describe("운영 안정성 — 끊김·실패한 런·Gateway 버전·디스크", () => {
  let live: LiveApp | undefined;
  const sockets: WireClient[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live?.close();
    live = undefined;
  });

  async function boot(opts: LiveAppOptions = {}): Promise<LiveApp> {
    live = await bootLiveApp(opts);
    return live;
  }
  const eventsOf = (l: LiveApp, kind: string) =>
    l.app.db
      .select()
      .from(opsEvents)
      .where(eq(opsEvents.kind, kind as never))
      .all();
  const until = async <T>(read: () => T | undefined, what: string, ms = 5_000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (Date.now() > end) throw new Error(`기다림 초과: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it("플러그인이 임계보다 오래 끊기면 plugin_down 1줄이 owner 소켓에 가고, 다시 붙으면 그 줄이 닫힌다(downMs)", async () => {
    const l = await boot({ deps: { disconnectEventMs: 300 } });
    const owner = await connectWire(l.app, l.auth.token);
    sockets.push(owner);

    const opened = waitFor(owner, "ops.event");
    l.plugin.disconnect();
    const payload = await opened;
    expect(payload.event).toMatchObject({ kind: "plugin_down", key: "plugin", severity: "warn", count: 1 });
    expect(payload.unacked).toEqual({ warn: 1, error: 0 });
    expect(eventsOf(l, "plugin_down")).toHaveLength(1);

    const closed = waitFor(owner, "ops.event");
    await l.plugin.reconnect();
    const resolved = await closed;
    expect(resolved.event.id).toBe(payload.event.id);
    expect(resolved.event.resolvedAt).toBeDefined();
    // 줄은 끊긴 지 임계(300ms)에 열린다 — downMs 는 끊긴 때부터라 임계보다 짧을 수 없다
    expect(resolved.event.detail.downMs).toBeGreaterThanOrEqual(300);
    expect(eventsOf(l, "gateway_down")).toEqual([]);
  });

  it("임계보다 짧게 끊겼다 붙기를 되풀이하면 사건이 없다", async () => {
    const l = await boot({ deps: { disconnectEventMs: 2_000 } });
    for (let i = 0; i < 3; i++) {
      l.plugin.disconnect();
      await l.plugin.reconnect();
    }
    await new Promise((r) => setTimeout(r, 2_300));
    expect(eventsOf(l, "plugin_down")).toEqual([]);
  });

  it("런이 error 로 끝나면 run_failed 1줄(agent:<id>, detail.code)", async () => {
    const l = await boot({ timeouts: { queuedMs: 500, runMs: 5_000, finalizingMs: 300 } });
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    const log = await openChannelWire(l, setup.channel.id, sockets);
    l.plugin.disconnect();
    await log.until(() => log.adapterStatus.find((s) => s.bridge === "down"), "bridge down");
    await sendMessage(log.socket, setup.channel.id, "@dev 해줘");
    const queued = await log.until(
      () => log.states.find((s) => s.agentId === setup.dev.id && s.status === "queued"),
      "dev 런",
    );
    expect(await log.terminal(queued.id)).toMatchObject({ status: "error" });
    const [row] = await until(
      () => (eventsOf(l, "run_failed").length > 0 ? eventsOf(l, "run_failed") : undefined),
      "run_failed",
    );
    expect(row).toMatchObject({
      key: `agent:${setup.dev.id}`,
      severity: "warn",
      count: 1,
      detail: { code: "ADAPTER_UNAVAILABLE" },
    });
  });

  it("Gateway 버전 — 핀과 같으면 사건 없이 기억만, 다르면 gateway_version_untested", async () => {
    const pinned = await boot();
    await until(() => getOpsSettings(pinned.app.db, pinned.app.workspaceId).lastGatewayVersion, "기억");
    expect(getOpsSettings(pinned.app.db, pinned.app.workspaceId).lastGatewayVersion).toBe("2026.9.4");
    expect(eventsOf(pinned, "gateway_version_untested")).toEqual([]);
    await pinned.close();

    const drifted = await boot({ serverVersion: "2026.9.5" });
    const [row] = await until(
      () =>
        eventsOf(drifted, "gateway_version_untested").length > 0
          ? eventsOf(drifted, "gateway_version_untested")
          : undefined,
      "untested",
    );
    expect(row).toMatchObject({ key: "gateway:2026.9.5", severity: "info" });
    expect(getOpsSettings(drifted.app.db, drifted.app.workspaceId).lastGatewayVersion).toBe("2026.9.5");
  });

  it("createApp 은 첫 디스크 측정이 끝나야 풀린다 — 부팅 직후 disk() 가 unknown 이 아니다", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const statfs = vi.fn(async () => {
      await gate;
      return { bavail: (100 * MIB) / 4096, bsize: 4096, blocks: (50 * GIB) / 4096 };
    });
    const booting = bootLiveApp({ deps: { statfs } });
    const early = await Promise.race([
      booting.then(() => "booted" as const),
      new Promise<"waiting">((r) => setTimeout(() => r("waiting"), 1_000)),
    ]);
    release();
    live = await booting;
    expect(early).toBe("waiting");
    expect(live.app.disk()).toMatchObject({ level: "error" });
  });

  it("디스크 여유 error 면 disk_low(error) 가 남고 사람·브리지 업로드가 507 — 업로드 상한이 먼저 센다", async () => {
    const statfs = vi.fn(async () => ({
      bavail: (100 * MIB) / 4096,
      bsize: 4096,
      blocks: (50 * GIB) / 4096,
    }));
    const l = await boot({ deps: { statfs, limits: { uploadPerMin: 1 } } });
    expect(l.app.disk()).toMatchObject({ level: "error", freeBytes: 100 * MIB });
    expect(eventsOf(l, "disk_low")).toEqual([
      expect.objectContaining({ key: "data", severity: "error", detail: { freeBytes: 100 * MIB } }),
    ]);
    const setup = await setupRelayChannel(l, RELAY_POLICY);
    const upload = () =>
      l.app.fastify.inject({
        method: "POST",
        url: `/api/v1/attachments?channelId=${setup.channel.id}`,
        headers: { ...l.auth.headers, "content-type": "image/png" },
        payload: Buffer.from(makePng(2, 2)),
      });
    const first = await upload();
    expect(first.statusCode).toBe(507);
    expect(first.json()).toMatchObject({ code: "INSUFFICIENT_STORAGE" });
    // 상한(분당 1)은 507 을 받은 요청도 센다 — 곧바로 다시 보내면 디스크를 보기 전에 429
    expect((await upload()).statusCode).toBe(429);

    await expect(
      l.plugin.uploadAttachment({ channelId: setup.channel.id, bytes: makePng(2, 2), mime: "image/png" }),
    ).rejects.toThrow(/fake upload 507: .*INSUFFICIENT_STORAGE/);
  });
});
