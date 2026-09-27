import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { BridgeTokenRecord, IssueBridgeTokenResult, SetupStatus } from "@dodok/shared";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { v7 as uuid } from "uuid";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { bridgeTokens, memberships, users } from "../src/db/schema.sqlite";
import { PLUGIN_BUNDLE_ENTRY } from "../src/modules/setup/plugin-file";
import { verifyBridgeTokenDb } from "../src/modules/setup/tokens";
import { bootTestApp, login } from "./helpers/app";
import { testEnv } from "./helpers/env";

const ENV_TOKEN = testEnv.BRIDGE_TOKEN as string;
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
      { adapter, pluginDirs: [pluginDir], logger: log.logger },
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

  it("member 는 다섯 경로 모두 403, membership 이 없거나 세션이 없으면 401 [Review Focus 4]", async () => {
    const id = uuid();
    const routes: Array<["GET" | "POST" | "DELETE", string, object?]> = [
      ["GET", "/status"],
      ["GET", "/bridge-tokens"],
      ["POST", "/bridge-tokens", { label: "x" }],
      ["DELETE", `/bridge-tokens/${id}`],
      ["GET", "/plugin.tgz"],
    ];
    const before = app.db.select().from(bridgeTokens).all().length;
    for (const [method, url, body] of routes) {
      const forbidden = await call(member, method, url, body);
      expect(forbidden.statusCode, `${method} ${url}`).toBe(403);
      expect(forbidden.json().code).toBe("FORBIDDEN");
      expect((await call(noMembership, method, url, body)).statusCode, `${method} ${url}`).toBe(401);
      expect((await call(undefined, method, url, body)).statusCode, `${method} ${url}`).toBe(401);
    }
    expect(app.db.select().from(bridgeTokens).all()).toHaveLength(before);
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
    expect(status.envTokenIgnored).toBe(false);
    expect(res.body).not.toContain(pluginDir);
  });

  it("POST 발급 — 201·no-store, 원문은 이 응답에만(목록·상태·로그에 없다), pluginConfig 는 publicUrl·원문", async () => {
    const res = await call(owner, "POST", "/bridge-tokens", { label: " rotate " });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const issued = IssueBridgeTokenResult.parse(res.json());
    expect(issued.record.label).toBe("rotate");
    expect(issued.pluginConfig).toEqual({
      channels: {
        dodok: { accounts: { default: { bridgeUrl: "wss://chat.example.com/bridge", token: issued.token } } },
      },
    });
    expect(verifyBridgeTokenDb(app.db, issued.token)).toEqual({ tokenId: issued.record.id });

    const list = await call(owner, "GET", "/bridge-tokens");
    expect(list.body).not.toContain(issued.token);
    expect(list.body).not.toContain(issued.token.slice(4));
    const status = await call(owner, "GET", "/status");
    expect(status.body).not.toContain(issued.token.slice(4));
    expect(log.lines.join("\n")).not.toContain(issued.token.slice(4));
  });

  it("POST 라벨 검증 — 빈 값·61자 400, 본문 없음 400", async () => {
    expect((await call(owner, "POST", "/bridge-tokens", { label: "" })).statusCode).toBe(400);
    expect((await call(owner, "POST", "/bridge-tokens", { label: "x".repeat(61) })).statusCode).toBe(400);
    expect((await call(owner, "POST", "/bridge-tokens")).statusCode).toBe(400);
  });

  it("POST 라벨 env(대소문자·앞뒤 공백 무시)는 400 VALIDATION — 목록의 env 줄은 이어받은 토큰 하나뿐이다", async () => {
    const before = app.db.select().from(bridgeTokens).all().length;
    for (const label of ["env", " ENV ", "Env"]) {
      const res = await call(owner, "POST", "/bridge-tokens", { label });
      expect(res.statusCode, label).toBe(400);
      expect(res.json()).toMatchObject({
        code: "VALIDATION",
        message: "env 는 .env 에서 이어받은 토큰에만 쓰는 라벨입니다",
      });
    }
    expect(app.db.select().from(bridgeTokens).all()).toHaveLength(before);
    const { tokens } = (await call(owner, "GET", "/bridge-tokens")).json() as { tokens: BridgeTokenRecord[] };
    expect(tokens.filter((t) => t.label.toLowerCase() === "env")).toHaveLength(1);
  });

  it("GET 목록 — env 이어받은 줄 포함, 새것부터, 지금 접속 중인 토큰이 connected", async () => {
    const issued = IssueBridgeTokenResult.parse(
      (await call(owner, "POST", "/bridge-tokens", { label: "now" })).json(),
    );
    const detail = adapter.setupDetail();
    adapter.setSetupDetail({
      ...detail,
      bridge: {
        state: "connected",
        plugin: {
          version: "0.0.0",
          sdkVersion: "2026.9.4",
          gatewayVersion: null,
          bundleSha256: null,
          tokenId: issued.record.id,
          connectedAt: new Date().toISOString(),
        },
      },
    });
    try {
      const { tokens } = (await call(owner, "GET", "/bridge-tokens")).json() as {
        tokens: BridgeTokenRecord[];
      };
      for (const t of tokens) BridgeTokenRecord.strict().parse(t);
      expect(tokens[0]).toMatchObject({ id: issued.record.id, connected: true });
      expect(tokens.filter((t) => t.connected)).toHaveLength(1);
      expect(tokens.at(-1)?.label).toBe("env");
    } finally {
      adapter.setSetupDetail(detail);
    }
  });

  it("DELETE — 204·폐기·그 토큰의 브리지 세션 끊기, 없는 id 는 404, 잘못된 id 는 400", async () => {
    const issued = IssueBridgeTokenResult.parse(
      (await call(owner, "POST", "/bridge-tokens", { label: "gone" })).json(),
    );
    const res = await call(owner, "DELETE", `/bridge-tokens/${issued.record.id}`);
    expect(res.statusCode).toBe(204);
    expect(adapter.calls.revokeTokenSessions).toContain(issued.record.id);
    expect(verifyBridgeTokenDb(app.db, issued.token)).toBeNull();
    const { tokens } = (await call(owner, "GET", "/bridge-tokens")).json() as { tokens: BridgeTokenRecord[] };
    expect(tokens.find((t) => t.id === issued.record.id)?.revokedAt).not.toBeNull();
    expect((await call(owner, "DELETE", `/bridge-tokens/${uuid()}`)).statusCode).toBe(404);
    expect((await call(owner, "DELETE", "/bridge-tokens/not-an-id")).statusCode).toBe(400);
  });

  it("DELETE — 세션 끊기가 던져도 폐기는 되고 warn 한 줄", async () => {
    const issued = IssueBridgeTokenResult.parse(
      (await call(owner, "POST", "/bridge-tokens", { label: "x" })).json(),
    );
    const original = adapter.revokeTokenSessions.bind(adapter);
    adapter.revokeTokenSessions = () => {
      throw new Error("socket gone");
    };
    try {
      expect((await call(owner, "DELETE", `/bridge-tokens/${issued.record.id}`)).statusCode).toBe(204);
    } finally {
      adapter.revokeTokenSessions = original;
    }
    expect(verifyBridgeTokenDb(app.db, issued.token)).toBeNull();
    expect(log.lines.filter((l) => l.includes("bridge session revoke failed"))).toHaveLength(1);
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
});

describe("설정 API — 플러그인 파일이 없을 때·BRIDGE_TOKEN 설정", () => {
  let app: App | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
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

  it("BRIDGE_TOKEN 없이 부팅 — 활성 토큰 0, 상태 정상(envTokenIgnored false)", async () => {
    app = await bootTestApp({ BRIDGE_TOKEN: "" }, { pluginDirs: [] });
    expect(app.db.select().from(bridgeTokens).all()).toHaveLength(0);
    const { headers } = await login(app);
    const res = await app.fastify.inject({ method: "GET", url: "/api/v1/setup/status", headers });
    expect(res.statusCode).toBe(200);
    expect(SetupStatus.parse(res.json()).envTokenIgnored).toBe(false);
  });

  it("이어받은 뒤 .env 를 바꿔 재시작 — warn 한 줄, 새 값은 안 통하고 envTokenIgnored true [Review Focus 1]", async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-setup-env-"));
    const DB_PATH = join(dir, "db.sqlite");
    app = await bootTestApp({ DB_PATH, BRIDGE_TOKEN: ENV_TOKEN }, { pluginDirs: [] });
    expect(
      app.db
        .select()
        .from(bridgeTokens)
        .all()
        .map((r) => r.label),
    ).toEqual(["env"]);
    await app.close();

    const { logger, lines } = captureLogger();
    const edited = "z".repeat(24);
    app = await bootTestApp({ DB_PATH, BRIDGE_TOKEN: edited }, { pluginDirs: [], logger });
    const warns = lines.filter((l) =>
      l.includes("BRIDGE_TOKEN in .env is ignored — manage bridge tokens in the connection page"),
    );
    expect(warns).toHaveLength(1);
    expect(JSON.parse(warns[0] as string).level).toBe(40);
    expect(lines.join("\n")).not.toContain(edited);
    expect(verifyBridgeTokenDb(app.db, edited)).toBeNull();
    expect(verifyBridgeTokenDb(app.db, ENV_TOKEN)).not.toBeNull();
    const { headers } = await login(app);
    const res = await app.fastify.inject({ method: "GET", url: "/api/v1/setup/status", headers });
    expect(SetupStatus.parse(res.json()).envTokenIgnored).toBe(true);
  });
});
