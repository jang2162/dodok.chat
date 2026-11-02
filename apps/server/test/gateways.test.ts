/**
 * Gateway API(멀티 Gateway 스펙 「Gateway API」 절·계획 판정 PG6·PG7·PG9) — `.env` 없이 Gateway 0개로 뜨고, 연결 페이지 API 로 추가·수정·삭제하면
 * 재시작 없이 어댑터가 따라온다. 공유 토큰 원문은 응답·목록·로그·설정 상태 어디에도 없다. 브리지 토큰은 Gateway 아래.
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import {
  DeleteGatewayResult,
  GatewaySummary,
  IssueBridgeTokenResult,
  type BridgeTokenRecord,
  SetupStatus,
} from "@dodok/shared";
import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { io as connectIo } from "socket.io-client";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasGateways, type OpenClawGateways } from "../src/adapters/types";
import { type App, createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { agents, bridgeTokens, gateways } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import {
  approveGateway,
  createGateway,
  gatewayConfig,
  toGatewaySummary,
  updateGateway,
} from "../src/modules/gateways/service";
import { type FakeGateway, startFakeGateway } from "./fakes/fake-gateway";
import { type FakePlugin, startFakePlugin } from "./fakes/fake-plugin";
import { bootTestApp, login, noExternalPush, plentyOfDisk } from "./helpers/app";
import { newTestDb } from "./helpers/db";
import { testEnv } from "./helpers/env";
import { openclawOf, openclawStatus } from "./helpers/openclaw";
import { seedWorkspace } from "./helpers/seed";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const SHARED_TOKEN = "gateway-shared-secret-0123456789";

function captureLogger() {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
  return { logger, lines };
}

/** 브리지 핸드셰이크만 해 보고 connect_error 메시지(붙으면 "connected")를 돌려준다 */
function tryBridge(url: string, token: string): Promise<string> {
  const socket = connectIo(`${url}/bridge`, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve) => {
    socket.once("connect", () => {
      socket.close();
      resolve("connected");
    });
    socket.once("connect_error", (error) => {
      socket.close();
      resolve(error.message);
    });
  });
}

function gatewaysOf(app: App): OpenClawGateways {
  const adapter = openclawOf(app);
  if (!hasGateways(adapter)) throw new Error("OpenClaw adapter does not manage gateways");
  return adapter;
}

type Live = { app: App; dir: string; lines: string[]; headers: { authorization: string } };

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const run of cleanups.splice(0).reverse()) await run();
});

/** 실제 OpenClaw 어댑터로 .env 의 OpenClaw 변수 없이 띄운다 — testEnv 에 그 변수가 없다 */
async function bootReal(): Promise<Live> {
  const dir = mkdtempSync(join(tmpdir(), "dodok-gateways-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const { logger, lines } = captureLogger();
  const app = await createApp(
    loadConfig({ ...testEnv, DATA_DIR: dir, ATTACHMENTS_DIR: join(dir, "attachments") }),
    { logger, pushSend: noExternalPush, statfs: plentyOfDisk, gatewayBackoff: { initialMs: 50, maxMs: 200 } },
  );
  cleanups.push(() => app.close());
  await app.fastify.listen({ host: "127.0.0.1", port: 0 });
  return { app, dir, lines, headers: (await login(app)).headers };
}

async function fakeGateway(): Promise<FakeGateway> {
  const gateway = await startFakeGateway();
  cleanups.push(() => gateway.close());
  return gateway;
}

async function plugin(app: App, token: string): Promise<FakePlugin> {
  const p = await startFakePlugin({ bridgeUrl: app.url, token });
  cleanups.push(() => p.close());
  return p;
}

const api = (
  live: Pick<Live, "app" | "headers">,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
) =>
  live.app.fastify.inject({
    method,
    url: `/api/v1${url}`,
    headers: live.headers,
    ...(payload === undefined ? {} : { payload }),
  });

const setupStatus = async (live: Live) => SetupStatus.parse((await api(live, "GET", "/setup/status")).json());

describe("Gateway 0개 — .env 에 OpenClaw 변수 없이 뜬다(Review Focus 5)", () => {
  it("목록·설정 상태·어댑터 상태의 Gateway 가 비고, 어떤 토큰으로도 브리지에 붙지 못한다", async () => {
    const live = await bootReal();
    expect((await api(live, "GET", "/gateways")).json()).toEqual([]);
    expect((await setupStatus(live)).gateways).toEqual([]);
    expect(openclawStatus(openclawOf(live.app))).toEqual({ provider: "openclaw", gateways: [] });
    expect(await tryBridge(live.app.url, `dbt_${"A".repeat(43)}`)).toBe("UNAUTHORIZED");
    expect(live.lines.some((l) => l.includes("no OpenClaw gateway configured"))).toBe(true);
  });
});

describe("Gateway 추가·브리지 토큰·삭제 — 실제 어댑터 + 가짜 Gateway·플러그인", () => {
  it("추가하면 재시작 없이 붙고, 응답·목록·설정 상태·로그 어디에도 공유 토큰 원문이 없다", async () => {
    const live = await bootReal();
    const gw = await fakeGateway();
    const res = await api(live, "POST", "/gateways", { name: " 사무실 ", url: gw.url, token: gw.token });
    expect(res.statusCode).toBe(201);
    const summary = GatewaySummary.parse(res.json());
    expect(summary).toMatchObject({
      name: "사무실",
      url: gw.url,
      enabled: true,
      tokenSet: true,
      // 만든 owner 가 주인이고, owner 가 만든 것이라 만들 때 승인된다
      ownerUserId: live.app.ownerUserId,
      approved: true,
    });
    expect(res.json()).not.toHaveProperty("token");

    await vi.waitFor(() =>
      expect(gatewaysOf(live.app).gatewaySetupDetails()).toEqual([
        expect.objectContaining({ id: summary.id, gateway: expect.objectContaining({ state: "connected" }) }),
      ]),
    );
    const list = await api(live, "GET", "/gateways");
    expect(list.json()).toEqual([summary]);
    const status = await api(live, "GET", "/setup/status");
    expect(SetupStatus.parse(status.json()).gateways.map((g) => [g.id, g.gateway.state])).toEqual([
      [summary.id, "connected"],
    ]);
    for (const body of [res.body, list.body, status.body, live.lines.join("\n")]) {
      expect(body).not.toContain(gw.token);
    }
    // 디바이스 아이덴티티는 그 Gateway 의 디렉터리에(멀티 Gateway 스펙 「디바이스 아이덴티티」 절)
    expect(existsSync(join(live.dir, "gateways", summary.id, "device.json"))).toBe(true);
  });

  it("이름 겹침 409(이름 칸), http(s) 주소·빈 이름·33자 이름·빈 토큰 400, 없는 id 404", async () => {
    const live = await bootReal();
    const first = await api(live, "POST", "/gateways", {
      name: "집",
      url: "ws://127.0.0.1:1",
      token: SHARED_TOKEN,
    });
    expect(first.statusCode).toBe(201);
    const dup = await api(live, "POST", "/gateways", { name: "집", url: "ws://127.0.0.1:2", token: "t" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: "CONFLICT", details: { field: "name" } });
    for (const body of [
      { name: "a", url: "http://gw.example", token: "t" },
      { name: "a", url: "https://gw.example", token: "t" },
      { name: "", url: "ws://gw", token: "t" },
      { name: "x".repeat(33), url: "ws://gw", token: "t" },
      { name: "a", url: "ws://gw", token: "" },
      { name: "a", url: "ws://gw", token: "   " },
      { name: "a", url: "wss://bob:pw@gw.example", token: "t" },
      { name: "a", url: "wss:/bob:pw@gw.example", token: "t" },
    ]) {
      const res = await api(live, "POST", "/gateways", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION" });
    }
    expect((await api(live, "GET", "/gateways")).json()).toHaveLength(1);
    const id = (first.json() as { id: string }).id;
    const second = await api(live, "POST", "/gateways", {
      name: "사무실",
      url: "ws://127.0.0.1:2",
      token: "t",
    });
    const renamed = await api(live, "PATCH", `/gateways/${(second.json() as { id: string }).id}`, {
      name: "집",
    });
    expect(renamed.statusCode).toBe(409);
    expect((await api(live, "PATCH", `/gateways/${id}`, { url: "http://gw" })).statusCode).toBe(400);
    for (const [method, url] of [
      ["PATCH", `/gateways/${uuid()}`],
      ["DELETE", `/gateways/${uuid()}`],
      ["GET", `/gateways/${uuid()}/bridge-tokens`],
      ["POST", `/gateways/${uuid()}/bridge-tokens`],
    ] as const) {
      const res = await api(
        live,
        method,
        url,
        method === "GET" || method === "DELETE" ? undefined : { label: "x" },
      );
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("브리지 토큰은 그 Gateway 아래 — 원문은 발급 응답 한 번, 그 토큰으로 붙은 플러그인은 그 Gateway 의 것, 다른 Gateway 목록에는 없다", async () => {
    const live = await bootReal();
    const [gwA, gwB] = [await fakeGateway(), await fakeGateway()];
    const a = GatewaySummary.parse(
      (await api(live, "POST", "/gateways", { name: "사무실", url: gwA.url, token: gwA.token })).json(),
    );
    const b = GatewaySummary.parse(
      (await api(live, "POST", "/gateways", { name: "집", url: gwB.url, token: gwB.token })).json(),
    );
    const issuedRes = await api(live, "POST", `/gateways/${a.id}/bridge-tokens`, {
      label: " 사무실 플러그인 ",
    });
    expect(issuedRes.statusCode).toBe(201);
    expect(issuedRes.headers["cache-control"]).toBe("no-store");
    const issued = IssueBridgeTokenResult.parse(issuedRes.json());
    expect(issued.record.label).toBe("사무실 플러그인");
    expect(issued.pluginConfig).toEqual({
      channels: {
        dodok: { accounts: { default: { bridgeUrl: "ws://localhost:5173/bridge", token: issued.token } } },
      },
    });

    await plugin(live.app, issued.token);
    await vi.waitFor(async () => {
      const status = await setupStatus(live);
      expect(status.gateways.map((g) => [g.id, g.bridge.plugin?.tokenId ?? null])).toEqual([
        [a.id, issued.record.id],
        [b.id, null],
      ]);
    });
    const tokensOf = async (id: string) =>
      ((await api(live, "GET", `/gateways/${id}/bridge-tokens`)).json() as { tokens: BridgeTokenRecord[] })
        .tokens;
    expect((await tokensOf(a.id)).map((t) => [t.id, t.connected])).toEqual([[issued.record.id, true]]);
    expect(await tokensOf(b.id)).toEqual([]);
    // 다른 Gateway 경로로는 폐기할 수 없다
    expect(
      (await api(live, "DELETE", `/gateways/${b.id}/bridge-tokens/${issued.record.id}`)).statusCode,
    ).toBe(404);
    const listed = await api(live, "GET", `/gateways/${a.id}/bridge-tokens`);
    expect(listed.body).not.toContain(issued.token.slice(4));
    expect(live.lines.join("\n")).not.toContain(issued.token.slice(4));
  });

  it("삭제 — 그 Gateway 의 토큰 행이 지워지고(폐기된 것도) 에이전트는 남아 연결만 비고, 그 플러그인은 다시 붙지 못하고 디바이스 디렉터리가 없어진다. 다른 Gateway 는 그대로", async () => {
    const live = await bootReal();
    const [gwA, gwB] = [await fakeGateway(), await fakeGateway()];
    const a = GatewaySummary.parse(
      (await api(live, "POST", "/gateways", { name: "사무실", url: gwA.url, token: gwA.token })).json(),
    );
    const b = GatewaySummary.parse(
      (await api(live, "POST", "/gateways", { name: "집", url: gwB.url, token: gwB.token })).json(),
    );
    const issue = async (id: string, label: string) =>
      IssueBridgeTokenResult.parse(
        (await api(live, "POST", `/gateways/${id}/bridge-tokens`, { label })).json(),
      );
    const [tokenA, revokedA, tokenB] = [
      await issue(a.id, "a"),
      await issue(a.id, "old"),
      await issue(b.id, "b"),
    ];
    await api(live, "DELETE", `/gateways/${a.id}/bridge-tokens/${revokedA.record.id}`);
    const agent = (handle: string, gatewayId: string) =>
      createAgent(live.app.db, {
        workspaceId: live.app.workspaceId,
        providerAgentId: "main",
        handle,
        name: handle,
        gatewayId,
      });
    const [office, home] = [agent("main-office", a.id), agent("main-home", b.id)];
    const pluginA = await plugin(live.app, tokenA.token);
    await plugin(live.app, tokenB.token);
    await vi.waitFor(() => expect(existsSync(join(live.dir, "gateways", a.id, "device.json"))).toBe(true));
    await vi.waitFor(async () =>
      expect((await setupStatus(live)).gateways.map((g) => g.bridge.state)).toEqual([
        "connected",
        "connected",
      ]),
    );

    const res = await api(live, "DELETE", `/gateways/${a.id}`);
    expect(res.statusCode).toBe(200);
    expect(DeleteGatewayResult.parse(res.json())).toEqual({ unboundAgents: 1, deletedTokens: 2 });

    const db = live.app.db;
    expect(db.select().from(gateways).where(eq(gateways.id, a.id)).all()).toEqual([]);
    expect(db.select({ id: bridgeTokens.id }).from(bridgeTokens).all()).toEqual([{ id: tokenB.record.id }]);
    const byId = new Map(
      db
        .select({ id: agents.id, g: agents.gatewayId })
        .from(agents)
        .all()
        .map((r) => [r.id, r.g]),
    );
    expect(byId.get(office.id)).toBeNull();
    expect(byId.get(home.id)).toBe(b.id);
    expect(existsSync(join(live.dir, "gateways", a.id))).toBe(false);
    // 그 Gateway 의 토큰 행이 없어 다시 붙지 못한다(끊기 자체는 어댑터 테스트 multi-gateway 가 본다)
    expect(await tryBridge(live.app.url, tokenA.token)).toBe("UNAUTHORIZED");
    await expect(pluginA.reconnect()).rejects.toThrow(/UNAUTHORIZED/);
    const status = await setupStatus(live);
    expect(status.gateways.map((g) => [g.id, g.bridge.state])).toEqual([[b.id, "connected"]]);
  });
});

describe("Gateway 수정·부팅 — 어댑터에 넘기는 값(FakeAdapter)", () => {
  async function bootFake(overrides: Record<string, string> = {}) {
    const adapter = new FakeAdapter();
    const app = await bootTestApp(overrides, { adapters: [adapter] }, { gateway: false });
    cleanups.push(() => app.close());
    return { app, adapter, headers: (await login(app)).headers };
  }

  it("추가는 어댑터에 그 설정(공유 토큰 포함)을 한 번 넣는다", async () => {
    const live = await bootFake();
    const res = await api(live, "POST", "/gateways", {
      name: "사무실",
      url: "ws://gw:1",
      token: SHARED_TOKEN,
    });
    const { id } = GatewaySummary.parse(res.json());
    expect(live.adapter.calls.upsertGateway).toEqual([
      { id, name: "사무실", url: "ws://gw:1", token: SHARED_TOKEN, enabled: true },
    ]);
  });

  // FakeAdapter 는 upsertGateway 에 setup 이벤트를 내지 않는다 — 알림은 라우트가 낸 것뿐이다
  it("추가하면 setup.status 를 한 번 알리고, 그 상태에 새 Gateway 가 있다", async () => {
    const live = await bootFake();
    const statuses: SetupStatus[] = [];
    live.app.bus.on("setup.status", ({ status }) => statuses.push(status));
    const res = await api(live, "POST", "/gateways", {
      name: "사무실",
      url: "ws://gw:1",
      token: SHARED_TOKEN,
    });
    const { id } = GatewaySummary.parse(res.json());
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.gateways.map((g) => g.id)).toEqual([id]);
    expect(JSON.stringify(statuses)).not.toContain(SHARED_TOKEN);
  });

  it("이름만 바꾸면 이름만 바뀐 설정으로 넣고(어댑터는 다시 붙지 않는다 — 태스크 2), 빈 토큰은 「바꾸지 않음」, 바뀐 것이 없으면 넣지 않는다", async () => {
    const live = await bootFake();
    const { id } = GatewaySummary.parse(
      (
        await api(live, "POST", "/gateways", { name: "사무실", url: "ws://gw:1", token: SHARED_TOKEN })
      ).json(),
    );
    live.adapter.calls.upsertGateway.length = 0;
    const tokenRow = () =>
      live.app.db.select({ t: gateways.token }).from(gateways).where(eq(gateways.id, id)).get()?.t;

    const renamed = await api(live, "PATCH", `/gateways/${id}`, { name: "본사", token: "" });
    expect(renamed.statusCode).toBe(200);
    expect(GatewaySummary.parse(renamed.json())).toMatchObject({ id, name: "본사", url: "ws://gw:1" });
    expect(renamed.body).not.toContain(SHARED_TOKEN);
    expect(live.adapter.calls.upsertGateway).toEqual([
      { id, name: "본사", url: "ws://gw:1", token: SHARED_TOKEN, enabled: true },
    ]);
    expect(tokenRow()).toBe(SHARED_TOKEN);

    // 공백만 든 토큰도 「바꾸지 않음」
    await api(live, "PATCH", `/gateways/${id}`, { token: "   " });
    expect(tokenRow()).toBe(SHARED_TOKEN);

    // 같은 값·빈 토큰뿐이면 아무것도 넣지 않는다
    await api(live, "PATCH", `/gateways/${id}`, { name: "본사", token: "" });
    await api(live, "PATCH", `/gateways/${id}`, {});
    expect(live.adapter.calls.upsertGateway).toHaveLength(1);

    await api(live, "PATCH", `/gateways/${id}`, { url: "wss://gw:2", token: "rotated" });
    await api(live, "PATCH", `/gateways/${id}`, { enabled: false });
    expect(live.adapter.calls.upsertGateway.slice(1)).toEqual([
      { id, name: "본사", url: "wss://gw:2", token: "rotated", enabled: true },
      { id, name: "본사", url: "wss://gw:2", token: "rotated", enabled: false },
    ]);
    expect(tokenRow()).toBe("rotated");
  });

  it("이름이 바뀌면 agents.changed 를 한 번 보낸다 — 주소·켜기만 바뀌거나 같은 이름이면 보내지 않는다", async () => {
    const live = await bootFake();
    const { id } = GatewaySummary.parse(
      (await api(live, "POST", "/gateways", { name: "사무실", url: "ws://gw:1", token: "t" })).json(),
    );
    let agentsChanged = 0;
    live.app.bus.on("agents.changed", () => void agentsChanged++);
    await api(live, "PATCH", `/gateways/${id}`, { name: "본사" });
    expect(agentsChanged).toBe(1);
    await api(live, "PATCH", `/gateways/${id}`, { name: "본사" });
    await api(live, "PATCH", `/gateways/${id}`, { url: "ws://gw:2", enabled: false });
    expect(agentsChanged).toBe(1);
  });

  it("삭제는 어댑터의 removeGateway 를 부른다", async () => {
    const live = await bootFake();
    const { id } = GatewaySummary.parse(
      (await api(live, "POST", "/gateways", { name: "사무실", url: "ws://gw:1", token: "t" })).json(),
    );
    expect((await api(live, "DELETE", `/gateways/${id}`)).json()).toEqual({
      unboundAgents: 0,
      deletedTokens: 0,
    });
    expect(live.adapter.calls.removeGateway).toEqual([id]);
  });

  it("부팅 때 DB 의 Gateway 를 더한 차례로 모두 넣는다 — 꺼진 것은 enabled: false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-gateways-boot-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const DB_PATH = join(dir, "db.sqlite");
    const first = await bootFake({ DB_PATH });
    const t = (n: number) => new Date(Date.UTC(2026, 9, 4, 0, 0, n));
    const bootOwner = { userId: first.app.ownerUserId, role: "owner" } as const;
    const rows = [
      createGateway(
        first.app.db,
        first.app.workspaceId,
        { name: "사무실", url: "ws://a:1", token: "ta" },
        bootOwner,
        t(1),
      ),
      createGateway(
        first.app.db,
        first.app.workspaceId,
        { name: "집", url: "ws://b:1", token: "tb" },
        bootOwner,
        t(2),
      ),
      createGateway(
        first.app.db,
        first.app.workspaceId,
        { name: "꺼둠", url: "ws://c:1", token: "tc" },
        bootOwner,
        t(3),
      ),
    ];
    first.app.db
      .update(gateways)
      .set({ enabled: false })
      .where(eq(gateways.id, rows[2]?.id ?? ""))
      .run();
    await first.app.close();

    const second = await bootFake({ DB_PATH });
    expect(second.adapter.calls.upsertGateway).toEqual([
      { id: rows[0]?.id, name: "사무실", url: "ws://a:1", token: "ta", enabled: true },
      { id: rows[1]?.id, name: "집", url: "ws://b:1", token: "tb", enabled: true },
      { id: rows[2]?.id, name: "꺼둠", url: "ws://c:1", token: "tc", enabled: false },
    ]);
    const status = await setupStatus({ ...second, dir, lines: [] });
    expect(status.gateways.map((g) => [g.name, g.enabled, g.gateway.state])).toEqual([
      ["사무실", true, "connected"],
      ["집", true, "connected"],
      ["꺼둠", false, "disabled"],
    ]);
  });
});

describe("Gateway 주인·승인 — 서비스(연결의 주인 스펙 5.1·5.4)", () => {
  const T = new Date(Date.UTC(2026, 10, 2, 0, 0, 0));
  function fresh() {
    const db = newTestDb();
    const { workspaceId, userId } = seedWorkspace(db);
    return { db, workspaceId, userId };
  }
  const body = { name: "사무실", url: "ws://gw:1", token: "t" };

  it("member 가 만든 Gateway 는 그 사람이 주인이고 미승인 — 어댑터에는 꺼진 채로 간다", () => {
    const { db, workspaceId, userId } = fresh();
    const row = createGateway(db, workspaceId, body, { userId, role: "member" }, T);
    expect(row).toMatchObject({ ownerUserId: userId, approvedAt: null, approvedBy: null, enabled: true });
    expect(gatewayConfig(row).enabled).toBe(false);
    expect(toGatewaySummary(row)).toMatchObject({ ownerUserId: userId, approved: false, enabled: true });
  });

  it("admin 이상이 만든 Gateway 는 만들 때 승인된다", () => {
    const { db, workspaceId, userId } = fresh();
    const row = createGateway(db, workspaceId, body, { userId, role: "admin" }, T);
    expect(row).toMatchObject({ ownerUserId: userId, approvedAt: T, approvedBy: userId });
    expect(gatewayConfig(row).enabled).toBe(true);
    expect(toGatewaySummary(row).approved).toBe(true);
  });

  it("member 가 승인된 Gateway 의 주소를 바꾸면 승인이 풀린다 — 같은 수정에 enabled:true 를 실어도 어댑터에는 꺼진 채로", () => {
    const { db, workspaceId, userId } = fresh();
    const created = createGateway(db, workspaceId, body, { userId, role: "member" }, T);
    const approved = approveGateway(db, workspaceId, created.id, { userId, role: "admin" }, T);
    expect(gatewayConfig(approved).enabled).toBe(true);
    const { row } = updateGateway(
      db,
      workspaceId,
      created.id,
      { url: "ws://elsewhere:1", enabled: true },
      { userId, role: "member" },
      T,
    );
    expect(row).toMatchObject({ approvedAt: null, approvedBy: null, enabled: true });
    expect(gatewayConfig(row).enabled).toBe(false);
  });

  it("member 가 이름·토큰만 바꾸면 승인이 남는다", () => {
    const { db, workspaceId, userId } = fresh();
    const created = createGateway(db, workspaceId, body, { userId, role: "member" }, T);
    approveGateway(db, workspaceId, created.id, { userId, role: "owner" }, T);
    const { row } = updateGateway(
      db,
      workspaceId,
      created.id,
      { name: "본사", token: "rotated" },
      { userId, role: "member" },
      T,
    );
    expect(row.approvedAt).toEqual(T);
    expect(gatewayConfig(row).enabled).toBe(true);
  });

  it("admin 이상이 주소를 바꾸면 승인이 남는다", () => {
    const { db, workspaceId, userId } = fresh();
    const created = createGateway(db, workspaceId, body, { userId, role: "admin" }, T);
    const { row } = updateGateway(
      db,
      workspaceId,
      created.id,
      { url: "ws://elsewhere:1" },
      { userId, role: "admin" },
      T,
    );
    expect(row.approvedAt).toEqual(T);
  });

  it("승인하면 어댑터 설정이 켜진다 — 꺼 둔 Gateway 는 승인해도 꺼진 채", () => {
    const { db, workspaceId, userId } = fresh();
    const created = createGateway(db, workspaceId, body, { userId, role: "member" }, T);
    const approved = approveGateway(db, workspaceId, created.id, { userId, role: "admin" }, T);
    expect(approved).toMatchObject({ approvedAt: T, approvedBy: userId });
    expect(gatewayConfig(approved).enabled).toBe(true);
    const off = updateGateway(db, workspaceId, created.id, { enabled: false }, { userId, role: "admin" }, T);
    expect(gatewayConfig(off.row).enabled).toBe(false);
  });
});
