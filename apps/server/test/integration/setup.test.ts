/**
 * 설정 마법사 스펙 7장 서버 통합 — 가짜 Gateway·플러그인, 실제 OpenClawAdapter.
 * 겹침 교체(A → B 발급 → B 로 재접속 → A 폐기), 폐기된 토큰의 핸드셰이크·첨부 HTTP 거절, 접속 중 폐기의 즉시 끊김,
 * setup.status 가 owner 소켓에만, 원문이 로그·목록·wire 에 없음, 검증 함수가 던질 때 거절, 거절 로그 주소(TRUST_PROXY).
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import {
  type Attachment,
  type BridgeTokenRecord,
  type Channel,
  IssueBridgeTokenResult,
  SetupStatus,
} from "@dodok/shared";
import pino from "pino";
import { io as connectIo } from "socket.io-client";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../../src/app";
import { bridgeTokens, memberships, users } from "../../src/db/schema.sqlite";
import { type FakePlugin, startFakePlugin } from "../fakes/fake-plugin";
import { issueBridgeToken } from "../../src/modules/setup/tokens";
import { bootTestApp, login } from "../helpers/app";
import { FAKE_GATEWAY_ID } from "../helpers/gateways";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import { makePng } from "../helpers/png";
import { connectWire, recordEvents, waitFor, type WireClient, type WirePayload } from "../helpers/wire";
import { openclawStatus, openclawOf } from "../helpers/openclaw";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

function captureLogger() {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
  return { logger, lines };
}

/** membership role 을 준 두 번째 사용자 — 세션 토큰을 바로 낸다 */
async function userWithRole(app: App, handle: string, role: string): Promise<{ token: string }> {
  const ctx = await app.auth.$context;
  const id = uuid();
  await ctx.internalAdapter.createUser(
    { id, email: `${handle}@dodok.local`, name: handle, emailVerified: true },
    { method: "email-password" },
  );
  app.db
    .insert(users)
    .values({
      id,
      workspaceId: app.workspaceId,
      handle,
      displayName: handle,
      authProvider: "local",
      createdAt: new Date(),
    })
    .run();
  app.db.insert(memberships).values({ id: uuid(), workspaceId: app.workspaceId, userId: id, role }).run();
  return { token: (await ctx.internalAdapter.createSession(id)).token };
}

/** 같은 연결의 ack 왕복 한 번 — 그 전에 서버가 보낸 이벤트는 이미 도착했다(없는 채널 구독은 NOT_FOUND ack) */
async function roundTrip(socket: WireClient): Promise<void> {
  await socket.timeout(2_000).emitWithAck("channel.subscribe", { channelId: uuid() });
}

/** 브리지 핸드셰이크만 해 보고 connect_error 메시지(붙으면 "connected")를 돌려준다 */
function tryBridge(url: string, token: string, headers: Record<string, string> = {}): Promise<string> {
  const socket = connectIo(`${url}/bridge`, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    extraHeaders: headers,
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

describe("설정 마법사 통합 — 브리지 토큰 겹침 교체·폐기", () => {
  const sockets: WireClient[] = [];
  const plugins: FakePlugin[] = [];
  let live: LiveApp | undefined;

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const plugin of plugins.splice(0)) plugin.close();
    await live?.close();
    live = undefined;
  });

  it("A 로 붙은 플러그인 → B 발급 → B 로 재접속 → A 폐기 → A 는 핸드셰이크·첨부 모두 거절, B 는 통한다 → B 폐기는 즉시 끊는다", async () => {
    const { logger, lines } = captureLogger();
    live = await bootLiveApp({ deps: { logger, pluginDirs: [] } });
    const { app, gatewayId } = live;
    const TOKEN_A = live.bridgeToken;
    const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
      app.fastify.inject({
        method,
        url: `/api/v1${url}`,
        headers: live?.auth.headers ?? {},
        ...(payload === undefined ? {} : { payload }),
      });
    const tokensPath = `/gateways/${gatewayId}/bridge-tokens`;
    const tokens = async () =>
      ((await call("GET", tokensPath)).json() as { tokens: BridgeTokenRecord[] }).tokens;
    const pluginOf = (status: SetupStatus) => status.gateways[0]?.bridge.plugin ?? null;

    const ownerWire = await connectWire(app, live.auth.token);
    sockets.push(ownerWire);
    const member = await userWithRole(app, "bee", "member");
    const memberWire = await connectWire(app, member.token);
    sockets.push(memberWire);
    const memberSeen = recordEvents(memberWire, ["setup.status"]);
    const ownerSeen = recordEvents(ownerWire, ["setup.status"]);

    // Gateway 를 추가하며 발급한 토큰(A)으로 가짜 플러그인이 붙어 있다
    const [rowA] = await tokens();
    expect(rowA).toMatchObject({ label: "live-app", connected: true, revokedAt: null });
    const tokenA = rowA?.id as string;
    const status0 = SetupStatus.parse((await call("GET", "/setup/status")).json());
    expect(pluginOf(status0)?.tokenId).toBe(tokenA);
    expect(status0.bridge.publicUrl).toBe("ws://localhost:5173/bridge");

    // B 발급 — owner 에게 setup.status 가 간다
    const issuedEvent = waitFor(ownerWire, "setup.status");
    const issuedRes = await call("POST", tokensPath, { label: "rotate" });
    expect(issuedRes.statusCode).toBe(201);
    expect(issuedRes.headers["cache-control"]).toBe("no-store");
    const issued = IssueBridgeTokenResult.parse(issuedRes.json());
    const tokenB = issued.record.id;
    SetupStatus.parse((await issuedEvent).status);

    // 가짜 플러그인이 B 로 다시 붙는다 — 이전 연결은 replaced, connected 가 B 로 옮겨 간다
    const movedEvent = waitFor(ownerWire, "setup.status", (p) => pluginOf(p.status)?.tokenId === tokenB);
    const pluginB = await startFakePlugin({ bridgeUrl: app.url, token: issued.token });
    plugins.push(pluginB);
    await movedEvent;
    expect((await tokens()).filter((t) => t.connected).map((t) => t.id)).toEqual([tokenB]);

    // 첨부 하나(B 로 올린다 — 2xx 가 인증 통과다). 브리지 받기는 메시지에 묶인 첨부만 주므로 이 첨부는 인증을 지나면 404,
    // 인증에서 막히면 401 이다(인증은 onRequest 라 존재 확인보다 먼저)
    const createdChannel = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers: live.auth.headers,
      payload: { name: "setup" },
    });
    const { channel } = createdChannel.json() as { channel: Channel };
    const uploaded: Attachment = await pluginB.uploadAttachment({
      channelId: channel.id,
      bytes: makePng(2, 2),
      name: "a.png",
      mime: "image/png",
    });
    expect((await pluginB.downloadAttachment(uploaded.id, { token: TOKEN_A })).status).toBe(404);

    // A 폐기 — 재접속·첨부 모두 거절, B 는 그대로
    expect((await call("DELETE", `${tokensPath}/${tokenA}`)).statusCode).toBe(204);
    expect(await tryBridge(app.url, TOKEN_A)).toBe("UNAUTHORIZED");
    expect((await pluginB.downloadAttachment(uploaded.id, { token: TOKEN_A })).status).toBe(401);
    expect((await pluginB.downloadAttachment(uploaded.id)).status).toBe(404);
    await pluginB.uploadAttachment({
      channelId: channel.id,
      bytes: makePng(3, 3),
      name: "b.png",
      mime: "image/png",
    });
    expect(openclawStatus(openclawOf(app)).bridge).toBe("connected");

    // 접속 중인 B 폐기 → 그 세션이 곧바로 끊기고 owner 는 plugin null 상태를 받는다
    const downEvent = waitFor(ownerWire, "setup.status", (p) => pluginOf(p.status) === null);
    expect((await call("DELETE", `${tokensPath}/${tokenB}`)).statusCode).toBe(204);
    const down = await downEvent;
    expect(down.status.gateways[0]?.bridge.state).toBe("down");
    expect(openclawStatus(openclawOf(app)).bridge).toBe("down");
    expect(await tryBridge(app.url, issued.token)).toBe("UNAUTHORIZED");
    expect((await pluginB.downloadAttachment(uploaded.id)).status).toBe(401);

    // member 소켓은 setup.status 를 하나도 받지 않았다 [Review Focus 4] — 같은 연결의 ack 왕복 뒤에 본다
    await roundTrip(memberWire);
    expect(memberSeen).toHaveLength(0);
    expect(ownerSeen.length).toBeGreaterThanOrEqual(3);

    // 원문(두 토큰)은 로그·wire 이벤트·목록 어디에도 없다
    const secret = issued.token.slice(4);
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).not.toContain(TOKEN_A.slice(4));
    expect(JSON.stringify(ownerSeen)).not.toContain(secret);
    expect(JSON.stringify(await tokens())).not.toContain(secret);
    // 거절 로그는 남았다 — 토큰 없이 주소만
    expect(lines.some((l) => l.includes("bridge connection rejected"))).toBe(true);
  });

  // 실제 어댑터로 Gateway 0개 부팅·브리지 거절은 gateways.test.ts 가 본다
  it("Gateway 0개로 부팅 — 브리지 토큰 0, 설정 상태의 Gateway 목록은 비었다", async () => {
    const app = await bootTestApp({}, { pluginDirs: [] }, { gateway: false });
    try {
      expect(app.db.select().from(bridgeTokens).all()).toHaveLength(0);
      const { headers } = await login(app);
      const res = await app.fastify.inject({ method: "GET", url: "/api/v1/setup/status", headers });
      expect(res.statusCode).toBe(200);
      expect(SetupStatus.parse(res.json()).gateways).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("검증 함수가 던지면(테이블 없음) 브리지 핸드셰이크·첨부 HTTP 모두 거절 — 통과로 새지 않는다", async () => {
    const { logger, lines } = captureLogger();
    live = await bootLiveApp({ deps: { logger, pluginDirs: [] } });
    const { app, plugin } = live;
    app.db.$client.exec("DROP TABLE bridge_tokens");
    expect(await tryBridge(app.url, live.bridgeToken)).toBe("UNAUTHORIZED");
    const res = await plugin.downloadAttachment(uuid());
    expect(res.status).toBe(401);
    expect(lines.some((l) => l.includes("bridge token verification failed"))).toBe(true);
    expect(lines.join("\n")).not.toContain(live.bridgeToken.slice(4));
  });
});

describe("설정 마법사 통합 — 거절 로그 주소", () => {
  let live: LiveApp | undefined;
  afterEach(async () => {
    await live?.close();
    live = undefined;
  });

  const rejectedReasons = (lines: string[]) =>
    lines
      .map((l) => JSON.parse(l) as { msg?: string; reason?: string })
      .filter((l) => l.msg === "bridge connection rejected")
      .map((l) => l.reason);

  it("TRUST_PROXY=true 면 X-Forwarded-For 첫 값(trim)을 쓴다", async () => {
    const { logger, lines } = captureLogger();
    live = await bootLiveApp({ env: { TRUST_PROXY: "true" }, deps: { logger, pluginDirs: [] } });
    expect(await tryBridge(live.app.url, "wrong", { "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" })).toBe(
      "UNAUTHORIZED",
    );
    // 로그의 주소는 가린 값(ipPrefix) — 스로틀·가드 키는 전체 주소 그대로다
    expect(rejectedReasons(lines)).toEqual(["token mismatch from 203.0.113.0/24"]);
    expect(lines.join("\n")).not.toContain("203.0.113.9");
  });

  it("TRUST_PROXY=false 면 X-Forwarded-For 를 읽지 않는다 — 꾸민 헤더로 주소를 바꿀 수 없다", async () => {
    const { logger, lines } = captureLogger();
    live = await bootLiveApp({ env: { TRUST_PROXY: "false" }, deps: { logger, pluginDirs: [] } });
    expect(await tryBridge(live.app.url, "wrong", { "x-forwarded-for": "203.0.113.9" })).toBe("UNAUTHORIZED");
    // 같은 소켓 주소에서 헤더만 바꿔 다시 — 스로틀이 주소별이라 줄이 늘지 않는다
    expect(await tryBridge(live.app.url, "wrong", { "x-forwarded-for": "198.51.100.1" })).toBe(
      "UNAUTHORIZED",
    );
    const reasons = rejectedReasons(lines);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toBe("token mismatch from 127.0.0.0/24");
  });
});

describe("설정 마법사 통합 — 어댑터 setup 이벤트", () => {
  it("어댑터 {kind:setup} → 다시 읽은 상태(페어링 requestId 포함)가 owner 소켓에만 간다 — admin·member 는 못 받는다", async () => {
    const adapter = new FakeAdapter();
    const app = await bootTestApp({}, { adapters: [adapter], pluginDirs: [] });
    const sockets: WireClient[] = [];
    try {
      await app.fastify.listen({ host: "127.0.0.1", port: 0 });
      const { token } = await login(app);
      const owner = await connectWire(app, token);
      sockets.push(owner);
      const member = await connectWire(app, (await userWithRole(app, "bee", "member")).token);
      sockets.push(member);
      const memberSeen = recordEvents(member, ["setup.status"]);
      // 연결 페이지는 owner 전용이다 — ops.event 가 admin 까지 넓어져도 setup.status 는 넓어지지 않는다
      const admin = await connectWire(app, (await userWithRole(app, "ada", "admin")).token);
      sockets.push(admin);
      const adminSeen = recordEvents(admin, ["setup.status"]);

      const since = new Date().toISOString();
      adapter.setSetupDetail({
        ...adapter.setupDetail(),
        gateway: {
          state: "reconnecting",
          host: "gw.example:443",
          version: null,
          pairing: { requestId: "req-1", since },
        },
      });
      const got: Promise<WirePayload<"setup.status">> = waitFor(owner, "setup.status");
      adapter.emit({ kind: "setup" });
      const { status } = await got;
      expect(SetupStatus.parse(status).gateways[0]?.gateway.pairing).toEqual({ requestId: "req-1", since });

      const rest = await app.fastify.inject({
        method: "GET",
        url: "/api/v1/setup/status",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(SetupStatus.parse(rest.json()).gateways[0]?.gateway.pairing).toEqual({
        requestId: "req-1",
        since,
      });

      // member·admin 은 받지 않는다 — owner 가 받은 뒤 각 연결의 왕복을 한 번 더 기다린다
      await roundTrip(member);
      await roundTrip(admin);
      expect(memberSeen).toHaveLength(0);
      expect(adminSeen).toHaveLength(0);
    } finally {
      for (const socket of sockets) socket.close();
      await app.close();
    }
  });

  it("접속하지 않은 토큰을 폐기해도 서버가 setup.status 를 다시 보낸다 — 어댑터 이벤트(세션 끊김)에 기대지 않는다", async () => {
    // 붙지 않은 토큰이라 FakeAdapter 의 revokeTokenSessions 는 {kind:setup} 을 내지 않는다
    const adapter = new FakeAdapter();
    const app = await bootTestApp({}, { adapters: [adapter], pluginDirs: [] });
    const sockets: WireClient[] = [];
    try {
      await app.fastify.listen({ host: "127.0.0.1", port: 0 });
      const { token, headers } = await login(app);
      const owner = await connectWire(app, token);
      sockets.push(owner);
      const seen = recordEvents(owner, ["setup.status"]);
      await roundTrip(owner);
      seen.length = 0; // 접속 때 온 것이 있으면 버린다
      const { record } = issueBridgeToken(app.db, app.workspaceId, FAKE_GATEWAY_ID, "idle");
      const res = await app.fastify.inject({
        method: "DELETE",
        url: `/api/v1/gateways/${FAKE_GATEWAY_ID}/bridge-tokens/${record.id}`,
        headers,
      });
      expect(res.statusCode).toBe(204);
      await roundTrip(owner);
      expect(seen).toHaveLength(1);
      const payload = seen[0]?.payload as WirePayload<"setup.status"> | undefined;
      expect(SetupStatus.parse(payload?.status).gateways.map((g) => g.id)).toEqual([FAKE_GATEWAY_ID]);
    } finally {
      for (const socket of sockets) socket.close();
      await app.close();
    }
  });
});
