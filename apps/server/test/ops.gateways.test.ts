import { OPENCLAW_PINNED_VERSION } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { GatewaySummary, OpsStatus } from "@dodok/shared";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, watchGatewayReconnecting } from "../src/app";
import type { Db } from "../src/db/client";
import { opsEvents } from "../src/db/schema.sqlite";
import { getGatewayRow } from "../src/modules/gateways/service";
import { DISCONNECT_EVENT_MS, watchConnections, watchGatewayVersion } from "../src/modules/ops/health";
import { createOpsService, type OpsService } from "../src/modules/ops/service";
import { ServerBus } from "../src/realtime/bus";
import { bootTestApp, login } from "./helpers/app";
import { newTestDb } from "./helpers/db";
import { insertGateway } from "./helpers/gateways";
import { openclawDetail } from "./helpers/openclaw";
import { seedWorkspace } from "./helpers/seed";

// 멀티 Gateway 태스크 5 — 운영 사건·버전·재연결 알림·운영 상태를 Gateway 마다(스펙 6.5, Review Focus 5)

const SEC = 1_000;
const G1 = {
  id: "00000000-0000-4000-8000-0000000000a1",
  name: "사무실",
  url: "ws://office",
  token: "t1",
  enabled: true,
};
const G2 = {
  id: "00000000-0000-4000-8000-0000000000a2",
  name: "집",
  url: "ws://home",
  token: "t2",
  enabled: true,
};
const key = (g: { id: string }) => `gateway:${g.id}`;

describe("감시 — Gateway 마다 따로(가짜 시계)", () => {
  let db: Db;
  let ws: string;
  let ops: OpsService;
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-05T00:00:00.000Z") });
    db = newTestDb();
    ws = seedWorkspace(db).workspaceId;
    ops = createOpsService({ db, bus: new ServerBus(), logger: pino({ level: "silent" }), workspaceId: ws });
  });
  afterEach(() => {
    ops.close();
    vi.useRealTimers();
  });
  const rows = () => db.select().from(opsEvents).all();
  const twoGateways = () => {
    const adapter = new FakeAdapter();
    adapter.upsertGateway(G1);
    adapter.upsertGateway(G2);
    return adapter;
  };

  it("Gateway 둘 중 1 만 60초 넘게 끊기면 gateway_down 은 그 Gateway 의 한 줄(이름 포함), 2 는 사건 없음", () => {
    const adapter = twoGateways();
    const watch = watchConnections(adapter, ops);
    adapter.setGatewayState({ gateway: "reconnecting" }, G1.id);
    adapter.emitStatus();
    vi.advanceTimersByTime(DISCONNECT_EVENT_MS + SEC);
    expect(rows().map((r) => [r.kind, r.key, r.detail])).toEqual([
      ["gateway_down", key(G1), { thresholdMs: DISCONNECT_EVENT_MS, gatewayName: "사무실" }],
    ]);

    // 2 의 플러그인만 끊겨도 1 의 줄과 따로 묶인다
    adapter.setGatewayState({ bridge: "down" }, G2.id);
    adapter.emitStatus();
    vi.advanceTimersByTime(DISCONNECT_EVENT_MS + SEC);
    expect(rows().map((r) => [r.kind, r.key])).toEqual([
      ["gateway_down", key(G1)],
      ["plugin_down", key(G2)],
    ]);

    // 1 이 붙으면 1 의 줄만 닫힌다
    adapter.setGatewayState({ gateway: "connected" }, G1.id);
    adapter.emitStatus();
    expect(rows().map((r) => [r.key, r.resolvedAt !== null])).toEqual([
      [key(G1), true],
      [key(G2), false],
    ]);
    watch.close();
  });

  it("Gateway 0개면 아무리 지나도 사건·재연결 알림이 없다(Review Focus 5)", () => {
    const adapter = new FakeAdapter();
    const bus = new ServerBus();
    const notices: unknown[] = [];
    bus.on("system.notice", (n) => notices.push(n));
    const connections = watchConnections(adapter, ops);
    const reconnecting = watchGatewayReconnecting(adapter, bus, { warn: vi.fn() });
    adapter.emitStatus();
    vi.advanceTimersByTime(10 * DISCONNECT_EVENT_MS);
    expect(adapter.status()).toEqual({ provider: "openclaw", gateways: [] });
    expect(rows()).toEqual([]);
    expect(notices).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    connections.close();
    reconnecting.close();
  });

  it("꺼진 Gateway 는 down 사건을 내지 않고, 끄면 재던 끊김을 버리고 열린 줄을 닫는다", () => {
    const adapter = twoGateways();
    ops.record({ kind: "plugin_down", key: key(G2), severity: "warn" }); // 앞 프로세스가 열어 둔 줄
    adapter.upsertGateway({ ...G2, enabled: false });
    const watch = watchConnections(adapter, ops);
    expect(rows().find((r) => r.key === key(G2))?.resolvedAt).not.toBeNull();

    adapter.setGatewayState({ gateway: "down", bridge: "down" }, G1.id);
    adapter.emitStatus();
    vi.advanceTimersByTime(DISCONNECT_EVENT_MS + SEC);
    expect(
      rows()
        .filter((r) => r.resolvedAt === null)
        .map((r) => [r.kind, r.key]),
    ).toEqual([
      ["gateway_down", key(G1)],
      ["plugin_down", key(G1)],
    ]);
    adapter.upsertGateway({ ...G1, enabled: false });
    expect(rows().filter((r) => r.resolvedAt === null)).toEqual([]);

    // 꺼진 동안 끊김을 재지 않는다 — 다시 켜서 끊겨 있으면 그때부터 잰다
    adapter.setGatewayState({ gateway: "down" }, G2.id);
    adapter.emitStatus();
    vi.advanceTimersByTime(10 * DISCONNECT_EVENT_MS);
    expect(rows().filter((r) => r.resolvedAt === null)).toEqual([]);
    adapter.upsertGateway(G2);
    vi.advanceTimersByTime(DISCONNECT_EVENT_MS + SEC);
    expect(
      rows()
        .filter((r) => r.resolvedAt === null)
        .map((r) => [r.kind, r.key]),
    ).toEqual([["gateway_down", key(G2)]]);
    watch.close();
  });

  it("지운 Gateway 는 재던 끊김을 버리고 열린 줄을 닫는다", async () => {
    const adapter = twoGateways();
    const watch = watchConnections(adapter, ops);
    adapter.setGatewayState({ gateway: "down" }, G1.id);
    adapter.setGatewayState({ bridge: "down" }, G2.id);
    adapter.emitStatus();
    vi.advanceTimersByTime(DISCONNECT_EVENT_MS + SEC);
    expect(rows()).toHaveLength(2);
    await adapter.removeGateway(G1.id);
    expect(rows().map((r) => [r.key, r.resolvedAt !== null])).toEqual([
      [key(G1), true],
      [key(G2), false],
    ]);
    // 지운 뒤에는 그 Gateway 의 줄이 다시 열리지 않는다
    vi.advanceTimersByTime(10 * DISCONNECT_EVENT_MS);
    expect(rows()).toHaveLength(2);
    watch.close();
  });

  it("재연결 알림은 Gateway 마다, 문구에 그 Gateway 이름 — 꺼진 Gateway 는 재지 않는다", () => {
    const adapter = twoGateways();
    const bus = new ServerBus();
    const notices: Array<{ message: string }> = [];
    bus.on("system.notice", (n) => notices.push(n));
    const logger = { warn: vi.fn() };
    const watch = watchGatewayReconnecting(adapter, bus, logger);
    adapter.setGatewayState({ gateway: "reconnecting" }, G1.id);
    adapter.emitStatus();
    vi.advanceTimersByTime(30 * SEC);
    adapter.setGatewayState({ gateway: "reconnecting" }, G2.id);
    adapter.emitStatus();
    vi.advanceTimersByTime(30 * SEC);
    expect(notices.map((n) => n.message)).toEqual(["OpenClaw Gateway 「사무실」에 연결하지 못하고 있습니다"]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayId: G1.id }),
      expect.any(String),
    );

    // 2 를 끄면 2 의 알림은 나가지 않는다
    adapter.upsertGateway({ ...G2, enabled: false });
    vi.advanceTimersByTime(60 * SEC);
    expect(notices).toHaveLength(1);
    watch.close();
  });

  it("재연결 중에 지운 Gateway 는 임계가 지나도 알림을 내지 않는다", async () => {
    const adapter = twoGateways();
    const bus = new ServerBus();
    const notices: Array<{ message: string }> = [];
    bus.on("system.notice", (n) => notices.push(n));
    const watch = watchGatewayReconnecting(adapter, bus, { warn: vi.fn() });
    adapter.setGatewayState({ gateway: "reconnecting" }, G1.id);
    adapter.emitStatus();
    vi.advanceTimersByTime(30 * SEC);
    await adapter.removeGateway(G1.id);
    vi.advanceTimersByTime(60 * SEC);
    expect(notices).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    watch.close();
  });

  it("재연결 중에 마지막 Gateway 를 지워 목록이 비어도 그 타이머를 버린다 — 임계가 지나도 알림 없음(재리뷰 R1)", async () => {
    const adapter = new FakeAdapter();
    adapter.upsertGateway(G1);
    const bus = new ServerBus();
    const notices: Array<{ message: string }> = [];
    bus.on("system.notice", (n) => notices.push(n));
    const watch = watchGatewayReconnecting(adapter, bus, { warn: vi.fn() });
    adapter.setGatewayState({ gateway: "reconnecting" }, G1.id);
    adapter.emitStatus();
    vi.advanceTimersByTime(30 * SEC);
    await adapter.removeGateway(G1.id);
    vi.advanceTimersByTime(60 * SEC);
    expect(notices).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    watch.close();
  });

  it("버전 사건은 Gateway 마다 — 둘의 버전이 다르면 각자, 기억은 그 Gateway 행에", () => {
    insertGateway(db, ws, G1);
    insertGateway(db, ws, G2);
    const adapter = twoGateways();
    const detail = openclawDetail(adapter);
    const setVersion = (id: string, version: string) =>
      adapter.setSetupDetail({ ...detail, gateway: { ...detail.gateway, version } }, id);
    setVersion(G1.id, OPENCLAW_PINNED_VERSION);
    setVersion(G2.id, "2026.9.5");
    const watch = watchGatewayVersion(adapter, {
      db,
      workspaceId: ws,
      ops,
      logger: pino({ level: "silent" }),
    });
    expect(rows().map((r) => [r.kind, r.key, r.detail])).toEqual([
      ["gateway_version_untested", `${key(G2)}:2026.9.5`, { gatewayName: "집", version: "2026.9.5" }],
    ]);
    expect(getGatewayRow(db, ws, G1.id)?.lastVersion).toBe(OPENCLAW_PINNED_VERSION);
    expect(getGatewayRow(db, ws, G2.id)?.lastVersion).toBe("2026.9.5");

    // 1 만 바뀌면 changed 는 1 의 줄 하나
    setVersion(G1.id, "2026.9.6");
    adapter.emit({ kind: "setup" });
    expect(
      rows()
        .filter((r) => r.kind === "gateway_version_changed")
        .map((r) => [r.key, r.detail]),
    ).toEqual([[key(G1), { from: OPENCLAW_PINNED_VERSION, to: "2026.9.6", gatewayName: "사무실" }]]);
    expect(getGatewayRow(db, ws, G2.id)?.lastVersion).toBe("2026.9.5");
    watch.close();
  });

  it("두 Gateway 가 같은 버전이어도 기억·사건은 Gateway 마다 따로", () => {
    insertGateway(db, ws, G1);
    insertGateway(db, ws, G2);
    const adapter = twoGateways();
    const detail = openclawDetail(adapter);
    adapter.setSetupDetail({ ...detail, gateway: { ...detail.gateway, version: "2026.9.5" } });
    const watch = watchGatewayVersion(adapter, {
      db,
      workspaceId: ws,
      ops,
      logger: pino({ level: "silent" }),
    });
    expect(rows().map((r) => r.key)).toEqual([`${key(G1)}:2026.9.5`, `${key(G2)}:2026.9.5`]);
    expect([G1, G2].map((g) => getGatewayRow(db, ws, g.id)?.lastVersion)).toEqual(["2026.9.5", "2026.9.5"]);
    watch.close();
  });
});

describe("앱 — 운영 상태·사건 줄을 Gateway 마다(가짜 어댑터, 실제 시계)", () => {
  const DISCONNECT_MS = 50;
  let app: App;
  let adapter: FakeAdapter;
  let headers: { authorization: string };
  afterEach(async () => {
    await app.close();
  });
  async function boot(gateway: boolean) {
    adapter = new FakeAdapter();
    app = await bootTestApp({}, { adapters: [adapter], disconnectEventMs: DISCONNECT_MS }, { gateway });
    headers = (await login(app)).headers;
  }
  const api = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app.fastify.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
  const opsStatus = async () => OpsStatus.parse((await api("GET", "/ops/status")).json());
  const rows = () => app.db.select().from(opsEvents).all();
  const addGateway = async (g: { name: string; url: string; token: string }) =>
    GatewaySummary.parse((await api("POST", "/gateways", g)).json());

  it("Gateway 0개 — 운영 상태·어댑터 상태의 Gateway 가 비고, 임계가 지나도 사건이 없다(Review Focus 5)", async () => {
    await boot(false);
    expect((await opsStatus()).gateways).toEqual([]);
    const adapterStatus = (await api("GET", "/adapter/status")).json() as { statuses: unknown[] };
    expect(adapterStatus.statuses).toContainEqual({ provider: "openclaw", gateways: [] });
    await new Promise((r) => setTimeout(r, DISCONNECT_MS * 6));
    expect(rows()).toEqual([]);
  });

  it("운영 상태는 Gateway 마다 한 줄 — 꺼진 Gateway 는 「꺼짐」(disabled)·버전 없음, 핀·드리프트는 Gateway 별", async () => {
    await boot(false);
    const a = await addGateway({ name: "사무실", url: "ws://office.test", token: "secret-a" });
    const b = await addGateway({ name: "집", url: "ws://home.test", token: "secret-b" });
    const detail = openclawDetail(adapter);
    adapter.setSetupDetail({ ...detail, gateway: { ...detail.gateway, version: "2026.9.5" } }, a.id);
    adapter.setSetupDetail(
      { ...detail, gateway: { ...detail.gateway, version: OPENCLAW_PINNED_VERSION } },
      b.id,
    );
    adapter.setGatewayState({ bridge: "down" }, a.id);
    expect((await api("PATCH", `/gateways/${b.id}`, { enabled: false })).statusCode).toBe(200);

    const status = await opsStatus();
    expect(status.gateways).toEqual([
      {
        id: a.id,
        name: "사무실",
        enabled: true,
        gateway: { state: "connected", version: "2026.9.5", pinned: OPENCLAW_PINNED_VERSION, drift: true },
        plugin: { state: "down" },
      },
      {
        id: b.id,
        name: "집",
        enabled: false,
        gateway: { state: "disabled", version: null, pinned: OPENCLAW_PINNED_VERSION, drift: false },
        plugin: { state: "down" },
      },
    ]);
    // 공유 토큰은 운영 상태에 없다
    expect(JSON.stringify(status)).not.toContain("secret-");
  });

  it("Gateway 를 지우면 그 Gateway 의 열린 끊김 사건이 닫히고, 다른 Gateway 의 줄은 그대로", async () => {
    await boot(false);
    const a = await addGateway({ name: "사무실", url: "ws://office.test", token: "secret-a" });
    const b = await addGateway({ name: "집", url: "ws://home.test", token: "secret-b" });
    adapter.setGatewayState({ gateway: "down" }, a.id);
    adapter.setGatewayState({ gateway: "down" }, b.id);
    adapter.emitStatus();
    await vi.waitFor(() => expect(rows()).toHaveLength(2), { timeout: DISCONNECT_MS * 40 });

    expect((await api("DELETE", `/gateways/${a.id}`)).statusCode).toBe(200);
    expect(rows().map((r) => [r.key, r.resolvedAt !== null])).toEqual([
      [`gateway:${a.id}`, true],
      [`gateway:${b.id}`, false],
    ]);
    expect((await opsStatus()).gateways.map((g) => g.id)).toEqual([b.id]);
  });
});
