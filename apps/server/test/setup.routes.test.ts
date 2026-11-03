import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { PLUGIN_INSTALL_SCRIPT_PATH, SetupStatus } from "@dodok/shared";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { v7 as uuid } from "uuid";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { memberships, users } from "../src/db/schema.sqlite";
import { PLUGIN_BUNDLE_ENTRY } from "../src/modules/setup/plugin-file";
import { bootTestApp, login } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function captureLogger() {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
  return { logger, lines };
}

/** package/dist/index.js 하나만 든 tgz(ustar 한 블록 — 체크섬은 읽는 쪽이 보지 않는다) */
function tinyPluginTgz(bundle: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(PLUGIN_BUNDLE_ENTRY, 0);
  header.write(`${bundle.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  header.write("ustar\0", 257);
  const body = Buffer.alloc(Math.ceil(bundle.length / 512) * 512);
  bundle.copy(body);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}

/** 두 번째 사용자 — membership role 을 준다(Phase 4 팀원 대비). role 이 null 이면 membership 행을 만들지 않는다. 세션은 Better Auth 내부 어댑터로 바로 낸다 */
async function userWithRole(app: App, handle: string, role: string | null) {
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
  if (role !== null)
    app.db.insert(memberships).values({ id: uuid(), workspaceId: app.workspaceId, userId: id, role }).run();
  const session = await ctx.internalAdapter.createSession(id);
  return { id, headers: { authorization: `Bearer ${session.token}` } };
}

describe("설정 API /api/v1/setup", () => {
  let app: App;
  let adapter: FakeAdapter;
  let owner: { authorization: string };
  let member: { authorization: string };
  let noMembership: { authorization: string };
  let pluginDir: string;
  let log: ReturnType<typeof captureLogger>;
  const BUNDLE = Buffer.from("export const dodok = 1;\n");
  let tgz: Buffer;

  beforeAll(async () => {
    pluginDir = mkdtempSync(join(tmpdir(), "dodok-setup-plugin-"));
    tgz = tinyPluginTgz(BUNDLE);
    writeFileSync(join(pluginDir, "dodok-openclaw-plugin-0.0.0.tgz"), tgz);
    adapter = new FakeAdapter();
    log = captureLogger();
    app = await bootTestApp(
      { APP_ORIGIN: "https://chat.example.com" },
      { adapters: [adapter], pluginDirs: [pluginDir], logger: log.logger },
    );
    owner = (await login(app)).headers;
    member = (await userWithRole(app, "bee", "member")).headers;
    noMembership = (await userWithRole(app, "nom", null)).headers;
  });
  afterAll(async () => {
    await app.close();
    rmSync(pluginDir, { recursive: true, force: true });
  });

  const call = (
    headers: Record<string, string> | undefined,
    method: "GET" | "POST" | "DELETE",
    url: string,
    payload?: object,
  ) =>
    app.fastify.inject({
      method,
      url: `/api/v1/setup${url}`,
      ...(headers ? { headers } : {}),
      ...(payload === undefined ? {} : { payload }),
    });

  it("GET /auth/me 에 그 워크스페이스 role — owner·member, membership 이 없으면 401", async () => {
    const me = (h: Record<string, string>) =>
      app.fastify.inject({ method: "GET", url: "/api/v1/auth/me", headers: h });
    expect((await me(owner)).json().role).toBe("owner");
    expect((await me(member)).json().role).toBe("member");
    expect((await me(noMembership)).statusCode).toBe(401);
  });

  // 브리지 토큰 경로는 Gateway 아래로 옮겼다 — gateways.test.ts·roles.matrix.test.ts
  it("GET /status 는 멤버 누구나 — 연결이 없는 member 는 Gateway·러너가 빈 상태(연결 탭 통합 스펙 5.3)", async () => {
    const res = await call(member, "GET", "/status");
    expect(res.statusCode).toBe(200);
    const status = SetupStatus.parse(res.json());
    expect(status.gateways).toEqual([]);
    expect(status.runners.list).toEqual([]);
    expect((await call(noMembership, "GET", "/status")).statusCode).toBe(401);
    expect((await call(undefined, "GET", "/status")).statusCode).toBe(401);
  });

  it("member 는 플러그인 파일 받기 403, membership 이 없거나 세션이 없으면 401 [Review Focus 4]", async () => {
    const routes: Array<["GET" | "POST" | "DELETE", string, object?]> = [["GET", "/plugin.tgz"]];
    for (const [method, url, body] of routes) {
      const forbidden = await call(member, method, url, body);
      expect(forbidden.statusCode, `${method} ${url}`).toBe(403);
      expect(forbidden.json().code).toBe("FORBIDDEN");
      expect((await call(noMembership, method, url, body)).statusCode, `${method} ${url}`).toBe(401);
      expect((await call(undefined, method, url, body)).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("옛 브리지 토큰 경로 /api/v1/setup/bridge-tokens 는 없다(멀티 Gateway 계획 판정 PG6)", async () => {
    expect((await call(owner, "GET", "/bridge-tokens")).statusCode).toBe(404);
    expect((await call(owner, "POST", "/bridge-tokens", { label: "x" })).statusCode).toBe(404);
    expect((await call(owner, "DELETE", `/bridge-tokens/${uuid()}`)).statusCode).toBe(404);
  });

  it("GET /status — 계약 모양, publicUrl 은 APP_ORIGIN 에서, 품은 파일 정보(번들 sha)", async () => {
    const res = await call(owner, "GET", "/status");
    expect(res.statusCode).toBe(200);
    const status = SetupStatus.parse(res.json());
    expect(status.bridge.publicUrl).toBe("wss://chat.example.com/bridge");
    expect(status.pluginFile).toEqual({
      available: true,
      sha256: sha(tgz),
      bundleSha256: sha(BUNDLE),
      bytes: tgz.length,
    });
    expect(status.gateways.map((g) => [g.id, g.gateway.state, g.bridge.state])).toEqual([
      [FAKE_GATEWAY_ID, "connected", "connected"],
    ]);
    expect(res.body).not.toContain(pluginDir);
    expect(res.body).not.toContain("fake-gateway-token");
  });

  it("GET /status — pluginMatches 는 Gateway 마다 붙은 플러그인의 번들 sha 와 품은 파일을 견준다", async () => {
    const detail = adapter.setupDetail();
    const plugin = {
      version: "0.0.0",
      sdkVersion: "2026.9.4",
      gatewayVersion: null,
      tokenId: null,
      connectedAt: new Date().toISOString(),
    };
    const matchesWith = async (bundleSha256: string | null) => {
      adapter.setSetupDetail({
        ...detail,
        bridge: { state: "connected", plugin: { ...plugin, bundleSha256 } },
      });
      return SetupStatus.parse((await call(owner, "GET", "/status")).json()).gateways[0]?.pluginMatches;
    };
    try {
      expect(await matchesWith(sha(BUNDLE))).toBe(true);
      expect(await matchesWith("f".repeat(64))).toBe(false);
      expect(await matchesWith(null)).toBeNull();
    } finally {
      adapter.setSetupDetail(detail);
    }
  });

  it("GET plugin.tgz — 파일 그대로, attachment 이름에 sha 앞 12자", async () => {
    const res = await call(owner, "GET", "/plugin.tgz");
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(tgz)).toBe(true);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="dodok-openclaw-plugin-${sha(tgz).slice(0, 12)}.tgz"`,
    );
  });

  it("GET plugin.tgz — 부팅 뒤 파일이 다시 빌드됐으면 409(보인 sha 와 다른 파일을 주지 않는다), 지워졌으면 404", async () => {
    const path = join(pluginDir, "dodok-openclaw-plugin-0.0.0.tgz");
    try {
      writeFileSync(path, tinyPluginTgz(Buffer.from("rebuilt")));
      const changed = await call(owner, "GET", "/plugin.tgz");
      expect(changed.statusCode).toBe(409);
      expect(changed.json().message).toMatch(/^PLUGIN_FILE_CHANGED/);
      rmSync(path);
      expect((await call(owner, "GET", "/plugin.tgz")).json()).toMatchObject({
        code: "NOT_FOUND",
        message: "PLUGIN_FILE_MISSING",
      });
    } finally {
      writeFileSync(path, tgz);
    }
    expect((await call(owner, "GET", "/plugin.tgz")).statusCode).toBe(200);
  });

  it("GET plugin-install.sh — 로그인 없이 200, text/plain·nosniff, 본문에 bridgeUrl·두 sha·plugin.tgz 주소", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: PLUGIN_INSTALL_SCRIPT_PATH,
      remoteAddress: "10.9.0.1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(res.body).toContain("'wss://chat.example.com/bridge'");
    expect(res.body).toContain(`'${sha(tgz)}'`);
    expect(res.body).toContain(`'${sha(BUNDLE)}'`);
    expect(res.body).toContain("'https://chat.example.com'");
    expect(res.body).toContain("/api/v1/setup/plugin.tgz");
    // 토큰 자리는 환경 변수뿐 — 본문에 토큰·서버 안 경로가 없다
    expect(res.body).not.toMatch(/dbt_[A-Za-z0-9_-]{43}/);
    expect(res.body).not.toContain(pluginDir);
  });

  it("GET plugin-install.sh — llms.txt 와 같은 IP 버킷(둘을 합쳐 31번째가 429)", async () => {
    const get = (url: string) => app.fastify.inject({ method: "GET", url, remoteAddress: "10.9.0.31" });
    for (let i = 0; i < 15; i++) {
      expect((await get("/llms.txt")).statusCode, `llms ${i + 1}`).toBe(200);
      expect((await get(PLUGIN_INSTALL_SCRIPT_PATH)).statusCode, `install ${i + 1}`).toBe(200);
    }
    expect((await get(PLUGIN_INSTALL_SCRIPT_PATH)).statusCode).toBe(429);
    expect((await get("/llms.txt")).statusCode).toBe(429);
  });
});

describe("설정 API — 플러그인 파일이 없을 때", () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("품은 파일이 없으면 plugin.tgz 는 404 PLUGIN_FILE_MISSING, 상태는 available:false", async () => {
    app = await bootTestApp({}, { pluginDirs: [] });
    const { headers } = await login(app);
    const res = await app.fastify.inject({ method: "GET", url: "/api/v1/setup/plugin.tgz", headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND", message: "PLUGIN_FILE_MISSING" });
    const status = await app.fastify.inject({ method: "GET", url: "/api/v1/setup/status", headers });
    expect(status.json().pluginFile).toEqual({ available: false });
  });

  it("plugin-install.sh 도 404 PLUGIN_FILE_MISSING", async () => {
    app = await bootTestApp({}, { pluginDirs: [] });
    const res = await app.fastify.inject({ method: "GET", url: PLUGIN_INSTALL_SCRIPT_PATH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND", message: "PLUGIN_FILE_MISSING" });
  });
});
