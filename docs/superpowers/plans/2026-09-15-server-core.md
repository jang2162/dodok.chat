# 서버 코어(Phase 1 ①) 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: 이 저장소는 Orca 워커로 태스크를 실행한다(CLAUDE.md, docs/guides/worktree-workflow.md). Orca 가 없을 때만 superpowers:subagent-driven-development 로 대체한다. 단계는 체크박스(`- [ ]`)로 추적한다.

**Goal:** `apps/server` 를 실제로 뜨는 서버로 만들고 `packages/openclaw-adapter` 를 프로덕션 수준으로 올려, 사람 1명 + 에이전트 2개가 채널에서 멘션 릴레이로 3턴 협업하는 시나리오가 가짜 Gateway·가짜 플러그인 통합 테스트로 통과하고 로컬 dev Gateway 로 실연된다.

**Architecture:** 접근 A — Fastify 한 프로세스에 REST `/api/v1`, Socket.IO wire, `/bridge` 네임스페이스를 올린다. 모듈은 `Db` 를 받는 서비스 함수 묶음이고 `ServerBus` 로 통지한다. `runs/orchestrator` 가 런의 타이머·스트리밍 버퍼만 메모리에 들고 `runs` 행을 정본으로 `transition()` 을 적용한다. 어댑터는 `AgentAdapter` 인터페이스 뒤에 Gateway 클라이언트·브리지·설정 동기화를 감춘다.

**Tech Stack:** Node 24.21.0(mise), pnpm 11.16.0, TypeScript 5.9.3, Fastify 5.12.4, Socket.IO 4.8.3(+ socket.io-client 4.8.3), better-sqlite3 13.0.3 + Drizzle 0.45.2, Zod 4.6.5, Better Auth 1.7.5(`better-auth/adapters/drizzle`, `better-auth/plugins/bearer`, `better-auth/node`), pino 10.3.1, `@fastify/cookie` 11.1.2, `@fastify/rate-limit` 11.2.0, `ws` 8.21.3(가짜 Gateway 전용 dev), `@openclaw/gateway-client`·`@openclaw/gateway-protocol` 2026.9.4, vitest 4.1.11, oxlint/oxfmt.

**Spec:** `docs/superpowers/specs/2026-09-15-server-core-design.md` (계약 정본은 `docs/superpowers/specs/2026-09-14-shared-contracts-design.md`, 결정은 `docs/plan.md` 10장)

## Global Constraints

- Node `24.21.0`·pnpm `11.16.0` — `mise.toml` 핀. Bash 에서 `node -v` 가 24 가 아니면 `export PATH="$(mise where node)/bin:$PATH"`.
- 새 의존성은 **정확 핀**(`^`·`~` 금지): `better-auth 1.7.5`, `pino 10.3.1`, `@fastify/cookie 11.1.2`, `@fastify/rate-limit 11.2.0`, `fastify 5.12.4`, `socket.io 4.8.3`, `socket.io-client 4.8.3`(dev), `ws 8.21.3`(dev), `@types/ws 8.18.1`(dev). pnpm 11 의 최소 배포 경과 시간 보호에 걸리면 `pnpm-workspace.yaml` `minimumReleaseAgeExclude` 에 그 버전을 추가한다(기존 항목과 같은 방식).
- OpenClaw 패키지는 `2026.9.4` 정확 핀 유지. `shared` 는 Node 전용 API 금지. 외부 입력은 경계에서 Zod 파싱(계약 스펙 1.3).
- 시크릿·디바이스 아이덴티티·브리지 토큰은 `data/` 와 `.env` 에만. 로그에 토큰을 찍지 않는다. `.env`·`~/.openclaw*/openclaw.json` 은 읽지 않는다.
- 세션 키는 `agent:<providerAgentId>:dodok:channel:<channelId>` 원형(접미사 없음). 에이전트 간 소통은 채널 릴레이로만.
- 타임아웃 기본값: queued 120s, run 600s, finalizing 10s. 델타 코얼레싱 50ms. 인바운드 ack 재시도 1s·4s·16s 3회(ack 타임아웃 10s). 소켓 미전송 큐 상한 500 이벤트.
- 모든 태스크는 TDD: 실패하는 테스트 → 최소 구현 → 통과 → 커밋. 루트에서 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check` 통과 뒤 커밋(포맷은 `pnpm fmt`).
- 커밋은 경로를 명시해 stage(`git add -A`·`commit -a` 금지). Conventional Commits + 패키지 스코프. 메시지 끝에 `Co-Authored-By: <워커 자신의 모델명> <noreply@anthropic.com>` 과 `Claude-Session: https://claude.ai/code/session_01RCZ7VZGV9V7gx1CPYBxSRP`.
- dev Gateway·모델 런은 태스크 0 과 태스크 15 에서만. 다른 태스크는 네트워크 없이 끝낸다.

---

## 파일 구조

```
apps/server/
├─ package.json                 scripts: dev(tsx watch src/main.ts), test, typecheck, db:generate (auth:generate·@better-auth/cli 는 deprecated 라 쓰지 않음 — auth-schema.ts 는 손으로 작성)
├─ drizzle.config.ts            schema: ["./src/db/schema.sqlite.ts", "./src/db/auth-schema.ts"]
├─ drizzle/0001_*.sql           promptRevision·agent_sessions·Better Auth 테이블
├─ src/main.ts                  process.loadEnvFile → loadConfig → createApp → listen, 시그널 처리
├─ src/app.ts                   createApp(config): Fastify + Socket.IO + 어댑터 + 부팅 정리, close()
├─ src/config.ts                ServerConfig(zod) + loadConfig(env)
├─ src/logger.ts                pino 루트 로거, 토큰 마스킹 serializer
├─ src/db/{client,schema.sqlite,auth-schema}.ts
├─ src/auth/{index,owner,routes}.ts        Better Auth 인스턴스·owner 부트스트랩·/auth/local·requireSession·verifySessionToken
├─ src/realtime/{bus,socket,events}.ts     ServerBus·wire 서버·bus→룸 팬아웃
├─ src/modules/channels/{service,routes}.ts
├─ src/modules/agents/{service,routes}.ts
├─ src/modules/messages/{service,routes,seq}.ts
├─ src/modules/router/{service,decide}.ts
├─ src/modules/runs/{orchestrator,context,timers,routes,machine}.ts
├─ src/modules/sessions/service.ts
├─ src/modules/components/{service,interact}.ts
├─ src/adapters/{types,registry,fake}.ts   fake 는 테스트 전용이지만 src 에 두어 wire-cli 도 쓴다
├─ src/http/{errors,plugins}.ts            ApiError 매핑, JSON 스키마 파서
├─ test/helpers/{db,app}.ts                인메모리 DB·테스트 앱 부팅
├─ test/fakes/{fake-gateway,fake-plugin,scenario}.ts
├─ test/integration/*.test.ts
└─ test/*.test.ts
packages/openclaw-adapter/src/
├─ index.ts                     OpenClawAdapter (AgentAdapter 구현)
├─ gateway/{client,device-identity,connection-manager,events,sessions}.ts
├─ bridge/{server,session}.ts   (기존) + ack Zod 파싱
├─ config-sync.ts
└─ spike/admin-scope-probe.ts   태스크 0
scripts/wire-cli.ts             태스크 15
```

---

### Task 0: 원격 Gateway 의 `operator.admin` 부여 확인 (실측, verify 워커)

**Files:**
- Create: `packages/openclaw-adapter/src/spike/admin-scope-probe.ts`
- Modify: `packages/openclaw-adapter/package.json` (script `spike:admin-scope`)
- Modify: `docs/plan.md` 10장 #15 확정일 열, `docs/adr/0003-channel-prompt-spike.md` 10절 확정 표 2행

**Interfaces:**
- Consumes: `connectGateway`(`gateway/client.ts`), `.env` 의 `OPENCLAW_GATEWAY_URL`·`OPENCLAW_GATEWAY_TOKEN`·`OPENCLAW_DEVICE_IDENTITY_PATH`(스파이크 1 디바이스 재사용 — 새 디바이스를 만들지 않는다).
- Produces: 원격이 `operator.admin` 을 주는지(`sessions.reset` 이 `MISSING_SCOPE` 인지) 사실 한 줄 → 태스크 11 의 `capabilities.sessionReset` 기본 기대값.

- [ ] **Step 1: 프로브 작성**

```ts
// packages/openclaw-adapter/src/spike/admin-scope-probe.ts
/**
 * 원격 Gateway 공유 토큰이 operator.admin 을 주는지 잰다(계획서 10장 #15). 남기는 것: 세션 1개(agent:main:dodok:channel:<probe uuid>).
 * 실행: pnpm -F @dodok/openclaw-adapter spike:admin-scope   (.env 의 OPENCLAW_GATEWAY_* 사용)
 */
import { randomUUID } from "node:crypto";
import { connectGateway } from "../gateway/client";

const url = process.env.OPENCLAW_GATEWAY_URL;
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const identityPath = process.env.OPENCLAW_DEVICE_IDENTITY_PATH ?? "./data/openclaw-device.json";
if (!url || !token) throw new Error("OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN 이 필요하다");

const conn = await connectGateway({
  url, token, deviceIdentityPath: identityPath, clientDisplayName: "dodok-admin-probe",
  scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
  caps: [], connectTimeoutMs: 30_000,
});
const grantedScopes = (conn.hello.auth as { scopes?: string[] } | undefined)?.scopes ?? [];
const key = `agent:main:dodok:channel:${randomUUID()}`;
let resetOutcome: string;
try {
  const res = await conn.request("sessions.reset", { key }, { timeoutMs: 15_000 });
  resetOutcome = `ok: ${JSON.stringify(res).slice(0, 200)}`;
} catch (error) {
  const details = (error as { details?: { code?: string; missingScope?: string } }).details;
  resetOutcome = `error: ${(error as Error).message} code=${details?.code ?? "?"} missingScope=${details?.missingScope ?? "-"}`;
}
console.log(JSON.stringify({ grantedScopes, probeKey: key, resetOutcome }, null, 2));
await conn.stop();
```

- [ ] **Step 2: 스크립트 등록** — `packages/openclaw-adapter/package.json` scripts 에 `"spike:admin-scope": "tsx src/spike/admin-scope-probe.ts"`.
- [ ] **Step 3: 실행** — 최상위 `.env` 를 복사한 워크트리에서 `pnpm -F @dodok/openclaw-adapter spike:admin-scope`. 출력의 `grantedScopes` 에 `operator.admin` 이 있고 `resetOutcome` 이 `ok:` 면 **부여**, `MISSING_SCOPE` 면 **미부여**.
- [ ] **Step 4: 기록** — `docs/plan.md` 10장 #15 확정일 열에 「원격 실측(날짜): 부여/미부여」, ADR 0003 10절 확정 표 2행에 같은 사실. 미부여면 이 계획의 태스크 11 은 `capabilities.sessionReset=false` 를 기본으로 두고 「새 대화」 REST 는 409 를 내는 것으로 끝낸다(회전 폴백은 별도 결정).
- [ ] **Step 5: 커밋** — `git add packages/openclaw-adapter/src/spike/admin-scope-probe.ts packages/openclaw-adapter/package.json docs/plan.md docs/adr/0003-channel-prompt-spike.md && git commit -m "chore(adapter): 원격 operator.admin 부여 프로브 — 결과 기록"`.

---

### Task 1: 서버 뼈대 — config·logger·app·main·헬스

**Files:**
- Create: `apps/server/src/config.ts`, `apps/server/src/logger.ts`, `apps/server/src/app.ts`, `apps/server/src/main.ts`, `apps/server/src/http/errors.ts`, `apps/server/test/config.test.ts`, `apps/server/test/app.healthz.test.ts`, `apps/server/test/helpers/db.ts`
- Modify: `apps/server/package.json`(deps·scripts), `.env.example`, `pnpm-workspace.yaml`(필요 시 exclude)

**Interfaces:**
- Produces: `loadConfig(env): ServerConfig`, `createApp(config, deps?): Promise<App>` where `App = { fastify: FastifyInstance; io: Server; db: Db; bus: ServerBus; close(): Promise<void>; url: string }`(이 태스크에서는 `io`·`bus` 자리만 만들고 실제 배선은 5·12 태스크), `apiError(code, message, details?)`, `newTestDb()`.

- [ ] **Step 1: 의존성** — `apps/server/package.json` dependencies 에 `fastify 5.12.4`, `socket.io 4.8.3`, `pino 10.3.1`, `@fastify/cookie 11.1.2`, `@fastify/rate-limit 11.2.0`, `better-auth 1.7.5`, `@dodok/openclaw-adapter workspace:*`; devDependencies 에 `socket.io-client 4.8.3`, `ws 8.21.3`, `@types/ws 8.18.1`, `@better-auth/cli 1.4.21`, `pino-pretty 13.1.3`. scripts: `"dev": "tsx watch --env-file-if-exists=../../.env src/main.ts"`, `"start": "node --env-file-if-exists=../../.env dist/main.js"`(빌드는 Phase 3), `"auth:generate": "better-auth generate --config src/auth/index.ts --output src/db/auth-schema.ts"`. `pnpm install` 뒤 `pnpm-workspace.yaml` 경고가 나오면 exclude 추가.

- [ ] **Step 2: 실패 테스트 — config**

```ts
// apps/server/test/config.test.ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const base = {
  APP_ORIGIN: "http://localhost:5173", LOCAL_AUTH_TOKEN: "x".repeat(16), BETTER_AUTH_SECRET: "s".repeat(32),
  BRIDGE_TOKEN: "b".repeat(16), OPENCLAW_TARGET: "dev", OPENCLAW_DEV_GATEWAY_URL: "ws://127.0.0.1:19001", OPENCLAW_DEV_GATEWAY_TOKEN: "t",
};

describe("loadConfig", () => {
  it("dev 대상이면 dev 쌍을 gateway 로 고르고 디바이스 파일 이름에 -dev 를 붙인다", () => {
    const c = loadConfig({ ...base, DATA_DIR: "./tmp-data" });
    expect(c.gateway).toEqual({ url: "ws://127.0.0.1:19001", token: "t" });
    expect(c.deviceIdentityPath).toBe("tmp-data/openclaw-device-dev.json");
    expect(c.dbPath).toBe("tmp-data/dodok.sqlite");
    expect(c.PORT).toBe(3000);
  });
  it("remote 대상인데 원격 쌍이 없으면 어떤 변수가 빠졌는지 말하며 실패한다", () => {
    expect(() => loadConfig({ ...base, OPENCLAW_TARGET: "remote" })).toThrow(/OPENCLAW_GATEWAY_URL/);
  });
  it("LOCAL_AUTH_TOKEN 이 16자 미만이면 실패한다", () => {
    expect(() => loadConfig({ ...base, LOCAL_AUTH_TOKEN: "short" })).toThrow(/LOCAL_AUTH_TOKEN/);
  });
});
```

- [ ] **Step 3: 실패 확인** — `pnpm -F @dodok/server test -- config` → 모듈 없음으로 실패.
- [ ] **Step 4: config 구현**

```ts
// apps/server/src/config.ts
import { Handle } from "@dodok/shared";
import { join } from "node:path";
import { z } from "zod";

const Raw = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.url(),
  DATA_DIR: z.string().default("./data"),
  DB_PATH: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DODOK_WORKSPACE_NAME: z.string().min(1).max(80).default("dodok"),
  OWNER_HANDLE: Handle.default("owner"),
  LOCAL_AUTH_TOKEN: z.string().min(16),
  BETTER_AUTH_SECRET: z.string().min(32),
  OPENCLAW_TARGET: z.enum(["remote", "dev"]).default("remote"),
  OPENCLAW_GATEWAY_URL: z.url().optional(),
  OPENCLAW_GATEWAY_TOKEN: z.string().min(1).optional(),
  OPENCLAW_DEV_GATEWAY_URL: z.url().optional(),
  OPENCLAW_DEV_GATEWAY_TOKEN: z.string().min(1).optional(),
  OPENCLAW_DEVICE_IDENTITY_PATH: z.string().optional(),
  BRIDGE_TOKEN: z.string().min(16),
  BRIDGE_PUBLIC_URL: z.url().optional(),
});

export type ServerConfig = z.infer<typeof Raw> & {
  dbPath: string;
  deviceIdentityPath: string;
  gateway: { url: string; token: string };
};

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const parsed = Raw.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    throw new Error(`설정 오류:\n${lines.join("\n")}`);
  }
  const c = parsed.data;
  const pair = c.OPENCLAW_TARGET === "dev"
    ? { url: c.OPENCLAW_DEV_GATEWAY_URL, token: c.OPENCLAW_DEV_GATEWAY_TOKEN, names: "OPENCLAW_DEV_GATEWAY_URL / OPENCLAW_DEV_GATEWAY_TOKEN" }
    : { url: c.OPENCLAW_GATEWAY_URL, token: c.OPENCLAW_GATEWAY_TOKEN, names: "OPENCLAW_GATEWAY_URL / OPENCLAW_GATEWAY_TOKEN" };
  if (!pair.url || !pair.token) throw new Error(`설정 오류: OPENCLAW_TARGET=${c.OPENCLAW_TARGET} 에는 ${pair.names} 가 필요하다`);
  const suffix = c.OPENCLAW_TARGET === "dev" ? "-dev" : "";
  return {
    ...c,
    dbPath: c.DB_PATH ?? join(c.DATA_DIR, "dodok.sqlite"),
    deviceIdentityPath: c.OPENCLAW_DEVICE_IDENTITY_PATH ?? join(c.DATA_DIR, `openclaw-device${suffix}.json`),
    gateway: { url: pair.url, token: pair.token },
  };
}
```

- [ ] **Step 5: logger·errors·db 헬퍼**

```ts
// apps/server/src/logger.ts
import pino, { type Logger } from "pino";
const SECRET_KEYS = new Set(["token", "LOCAL_AUTH_TOKEN", "BRIDGE_TOKEN", "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_DEV_GATEWAY_TOKEN", "BETTER_AUTH_SECRET", "password", "authorization", "cookie"]);
export function createLogger(level: string): Logger {
  return pino({ level, redact: { paths: [...SECRET_KEYS].flatMap((k) => [k, `*.${k}`, `*.*.${k}`]), censor: "***" } });
}
export type { Logger };
```

```ts
// apps/server/src/http/errors.ts
import { type ApiError, type ErrorCode } from "@dodok/shared";
export class HttpError extends Error {
  constructor(readonly status: number, readonly body: ApiError) { super(body.message); this.name = "HttpError"; }
}
const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION: 400, CONFLICT: 409, RATE_LIMITED: 429, RELAY_LIMIT: 409,
  ADAPTER_UNAVAILABLE: 503, PROTOCOL_MISMATCH: 400, EXPIRED: 410, CONSUMED: 409, TIMEOUT: 504, INTERNAL: 500,
};
export function apiError(code: ErrorCode, message: string, details?: Record<string, unknown>): HttpError {
  return new HttpError(STATUS[code], { code, message, ...(details ? { details } : {}) });
}
```

```ts
// apps/server/test/helpers/db.ts
import { createDb } from "../../src/db/client";
export function newTestDb() { return createDb(":memory:"); }
```

- [ ] **Step 6: 실패 테스트 — healthz**

```ts
// apps/server/test/app.healthz.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app";
import { loadConfig } from "../src/config";
import { FakeAdapter } from "../src/adapters/fake";   // Task 6 이 만든다 — 그 전까지는 adapter: undefined 로 부팅한다

let app: App | undefined;
afterEach(async () => { await app?.close(); });

describe("createApp", () => {
  it("/healthz 는 인증 없이 db·adapter 상태를 낸다", async () => {
    app = await createApp(loadConfig({ /* Task 1 config.test 의 base 재사용 */ ...testEnv, DB_PATH: ":memory:", PORT: "0" }), { adapter: undefined });
    const res = await app.fastify.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, db: "ok", adapter: { gateway: "down", bridge: "down" }, workspace: expect.any(String) });
  });
  it("워크스페이스가 없으면 부팅 때 하나 만든다", async () => {
    app = await createApp(loadConfig({ ...testEnv, DB_PATH: ":memory:", PORT: "0" }), { adapter: undefined });
    const rows = app.db.select().from(workspaces).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("dodok");
  });
});
```

- [ ] **Step 7: app·main 구현**

```ts
// apps/server/src/app.ts
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { Server } from "socket.io";
import { v7 as uuidv7 } from "uuid";
import type { AgentAdapter } from "./adapters/types";
import { type ServerConfig } from "./config";
import { createDb, type Db } from "./db/client";
import { workspaces } from "./db/schema.sqlite";
import { HttpError } from "./http/errors";
import { createLogger, type Logger } from "./logger";
import { ServerBus } from "./realtime/bus";

export type AppDeps = { adapter?: AgentAdapter | undefined; logger?: Logger };
export type App = { fastify: FastifyInstance; io: Server; db: Db; bus: ServerBus; logger: Logger; workspaceId: string; url: string; close(): Promise<void> };

export async function createApp(config: ServerConfig, deps: AppDeps = {}): Promise<App> {
  const logger = deps.logger ?? createLogger(config.LOG_LEVEL);
  const db = createDb(config.dbPath);
  const workspaceId = ensureWorkspace(db, config.DODOK_WORKSPACE_NAME);
  const bus = new ServerBus();
  const fastify = Fastify({ loggerInstance: logger });
  await fastify.register(cookie);
  fastify.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send(error.body);
    logger.error({ err: error }, "unhandled");
    return reply.status(500).send({ code: "INTERNAL", message: "internal error" });
  });
  fastify.get("/healthz", async () => ({
    ok: true, db: "ok", workspace: workspaceId,
    adapter: deps.adapter?.status() ?? { gateway: "down", bridge: "down" },
  }));
  const io = new Server(fastify.server, { cors: { origin: config.APP_ORIGIN, credentials: true } });
  // 인증·wire·어댑터·REST 배선은 Task 3/5/12 가 여기에 register 한다
  await fastify.ready();
  return {
    fastify, io, db, bus, logger, workspaceId,
    get url() { const addr = fastify.server.address(); return typeof addr === "object" && addr ? `http://127.0.0.1:${addr.port}` : ""; },
    async close() { io.close(); await fastify.close(); },
  };
}

function ensureWorkspace(db: Db, name: string): string {
  const existing = db.select().from(workspaces).get();
  if (existing) return existing.id;
  const id = uuidv7();
  db.insert(workspaces).values({ id, name, createdAt: new Date() }).run();
  return id;
}
```

```ts
// apps/server/src/main.ts
import { existsSync } from "node:fs";
import { createApp } from "./app";
import { loadConfig } from "./config";
if (existsSync(".env")) process.loadEnvFile(".env");
const config = loadConfig();
const app = await createApp(config);
await app.fastify.listen({ host: config.HOST, port: config.PORT });
app.logger.info({ url: app.url }, "dodok server listening");
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    const t = setTimeout(() => process.exit(1), 10_000);
    void app.close().then(() => { clearTimeout(t); process.exit(0); });
  });
}
```

- [ ] **Step 8: 통과 확인** — `pnpm -F @dodok/server test`, `pnpm typecheck`. `.env.example` 에 3.1 의 전체 변수를 주석과 함께 추가(`LOCAL_AUTH_TOKEN`·`BETTER_AUTH_SECRET`·`OPENCLAW_TARGET`·`APP_ORIGIN`·`DATA_DIR`·`PORT`).
- [ ] **Step 9: 커밋** — `git add apps/server/package.json apps/server/src/config.ts apps/server/src/logger.ts apps/server/src/app.ts apps/server/src/main.ts apps/server/src/http/errors.ts apps/server/test/config.test.ts apps/server/test/app.healthz.test.ts apps/server/test/helpers/db.ts .env.example pnpm-lock.yaml pnpm-workspace.yaml && git commit -m "feat(server): 서버 뼈대 — config·logger·createApp·main·healthz"`.

---

### Task 2: DB — `promptRevision`·`agent_sessions`·Better Auth 테이블·마이그레이션

**Files:**
- Modify: `apps/server/src/db/schema.sqlite.ts`(channels.promptRevision, agentSessions), `apps/server/drizzle.config.ts`(schema 배열), `apps/server/src/db/client.ts`(auth 스키마 포함)
- Create: `apps/server/src/db/auth-schema.ts`(CLI 생성 뒤 커밋), `apps/server/drizzle/0001_*.sql`, `apps/server/test/db.sessions.test.ts`

**Interfaces:**
- Produces: `agentSessions` 테이블(스펙 3.2 컬럼 그대로), `channels.promptRevision`, `authSchema`(`user`·`session`·`account`·`verification`).

- [ ] **Step 1: 실패 테스트**

```ts
// apps/server/test/db.sessions.test.ts
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentSessions, channels } from "../src/db/schema.sqlite";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";   // Task 4 가 확장; 여기서는 workspace·user·agent·channel 최소 삽입 헬퍼를 만든다

describe("agent_sessions", () => {
  it("채널·에이전트당 한 행이고 promptRevision 기본값은 1", () => {
    const db = newTestDb();
    const { channelId, agentId } = seedChannelWithAgent(db);
    expect(db.select().from(channels).where(eq(channels.id, channelId)).get()?.promptRevision).toBe(1);
    db.insert(agentSessions).values({ id: "01", channelId, agentId, sessionKey: "k", promptRevisionAtStart: 1 }).run();
    expect(() => db.insert(agentSessions).values({ id: "02", channelId, agentId, sessionKey: "k", promptRevisionAtStart: 1 }).run()).toThrow(/UNIQUE/);
  });
  it("Better Auth 테이블이 마이그레이션에 포함된다", () => {
    const db = newTestDb();
    const names = db.all<{ name: string }>(sql`select name from sqlite_master where type='table'`).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["user", "session", "account", "verification", "agent_sessions"]));
  });
});
```

- [ ] **Step 2: 스키마 수정** — `channels` 에 `promptRevision: integer("prompt_revision").notNull().default(1)`, 스펙 3.2 의 `agentSessions` 를 추가. `drizzle.config.ts` `schema: ["./src/db/schema.sqlite.ts", "./src/db/auth-schema.ts"]`.
- [ ] **Step 3: Better Auth 스키마 생성** — Task 3 의 `src/auth/index.ts` 최소본(아래 Step 4 의 `createAuth` 만 있는 상태)을 먼저 두고 `pnpm -F @dodok/server auth:generate` → `src/db/auth-schema.ts`. 생성 결과가 문서 예시(`user`·`session`·`account`·`verification`, `text id`·`integer timestamp_ms`)와 같은지 확인하고 커밋 대상에 넣는다(재생성 가능하지만 마이그레이션 재현을 위해 커밋).
- [ ] **Step 4: 마이그레이션 생성** — `pnpm -F @dodok/server db:generate` → `drizzle/0001_*.sql`. `client.ts` 의 `schema` 에 `...authSchema` 를 합친다(`drizzle(sqlite, { schema: { ...schema, ...authSchema } })`).
- [ ] **Step 5: 통과 확인·커밋** — `git add apps/server/src/db apps/server/drizzle apps/server/drizzle.config.ts apps/server/test/db.sessions.test.ts apps/server/test/helpers/seed.ts && git commit -m "feat(server): DB — channels.promptRevision, agent_sessions, Better Auth 테이블 마이그레이션"`.

---

### Task 3: 인증 — Better Auth + owner 부트스트랩 + 로컬 토큰 로그인

**Files:**
- Create: `apps/server/src/auth/index.ts`, `apps/server/src/auth/owner.ts`, `apps/server/src/auth/routes.ts`, `apps/server/test/auth.test.ts`
- Modify: `apps/server/src/app.ts`(auth 등록)

**Interfaces:**
- Produces: `createAuth(db, config)`, `bootstrapOwner(db, auth, config): Promise<{ userId }>`, `registerAuthRoutes(fastify, ctx)`, `requireSession`(Fastify preHandler; `request.user = { id, workspaceId }`), `verifySessionToken(auth, token): Promise<{ userId } | null>`(Task 5 wire 접속에서 쓴다).

- [ ] **Step 1: 실패 테스트**

```ts
// apps/server/test/auth.test.ts
describe("auth", () => {
  it("첫 부팅에 owner 가 만들어지고 로컬 토큰으로 로그인하면 sessionToken 이 온다", async () => {
    app = await bootTestApp();                       // test/helpers/app.ts: createApp(testConfig, { adapter: new FakeAdapter() })
    const bad = await app.fastify.inject({ method: "POST", url: "/api/v1/auth/local", payload: { token: "wrong-wrong-wrong-1" } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.fastify.inject({ method: "POST", url: "/api/v1/auth/local", payload: { token: TEST_LOCAL_TOKEN } });
    expect(ok.statusCode).toBe(200);
    const { sessionToken, user } = ok.json();
    expect(user.handle).toBe("owner");
    const me = await app.fastify.inject({ method: "GET", url: "/api/v1/auth/me", headers: { authorization: `Bearer ${sessionToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(user.id);
    expect(await verifySessionToken(app.auth, sessionToken)).toEqual({ userId: user.id });
    expect(await verifySessionToken(app.auth, "nope")).toBeNull();
  });
  it("인증 없는 REST 는 401 ApiError", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: "UNAUTHORIZED", message: expect.any(String) });
  });
  it("토큰이 바뀌면 다음 부팅에서 owner 비밀번호가 갱신된다", async () => { /* 같은 파일 DB 로 두 번 createApp, 두 번째는 새 토큰으로 로그인 성공 */ });
});
```

- [ ] **Step 2: 구현**

```ts
// apps/server/src/auth/index.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins/bearer";
import type { Db } from "../db/client";
import * as authSchema from "../db/auth-schema";

export const OWNER_EMAIL = "owner@dodok.local";
export function createAuth(db: Db, config: { BETTER_AUTH_SECRET: string; APP_ORIGIN: string }) {
  return betterAuth({
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.APP_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: [config.APP_ORIGIN],
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 16, maxPasswordLength: 256 },
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    plugins: [bearer()],
  });
}
export type Auth = ReturnType<typeof createAuth>;

export async function verifySessionToken(auth: Auth, token: string): Promise<{ userId: string } | null> {
  const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
  return session ? { userId: session.user.id } : null;
}
```

```ts
// apps/server/src/auth/owner.ts — disableSignUp 이라 가입 API 를 쓸 수 없으므로 내부 어댑터로 만든다
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db } from "../db/client";
import * as authSchema from "../db/auth-schema";
import { memberships, users } from "../db/schema.sqlite";
import { OWNER_EMAIL, type Auth } from "./index";

export async function bootstrapOwner(db: Db, auth: Auth, config: { LOCAL_AUTH_TOKEN: string; OWNER_HANDLE: string }, workspaceId: string) {
  const ctx = await auth.$context;
  let user = await ctx.internalAdapter.findUserByEmail(OWNER_EMAIL);
  const hash = await ctx.password.hash(config.LOCAL_AUTH_TOKEN);
  if (!user) {
    const id = uuidv7();
    const created = await ctx.internalAdapter.createUser({ id, email: OWNER_EMAIL, name: config.OWNER_HANDLE, emailVerified: true });
    await ctx.internalAdapter.linkAccount({ userId: created.id, providerId: "credential", accountId: created.id, password: hash });
    user = { user: created, accounts: [] } as typeof user;
    db.insert(users).values({ id: created.id, workspaceId, handle: config.OWNER_HANDLE, displayName: config.OWNER_HANDLE, email: OWNER_EMAIL, authProvider: "local", createdAt: new Date() }).run();
    db.insert(memberships).values({ id: uuidv7(), workspaceId, userId: created.id, role: "owner" }).run();
    return { userId: created.id };
  }
  // 토큰이 바뀌었으면 비밀번호 갱신 (검증은 verify 로 — 해시가 매번 달라도 된다)
  const account = (await ctx.internalAdapter.findAccounts(user.user.id)).find((a) => a.providerId === "credential");
  const same = account?.password ? await ctx.password.verify({ hash: account.password, password: config.LOCAL_AUTH_TOKEN }) : false;
  if (!same && account) await ctx.internalAdapter.updatePassword(user.user.id, hash);
  const row = db.select().from(users).where(eq(users.id, user.user.id)).get();
  if (!row) db.insert(users).values({ id: user.user.id, workspaceId, handle: config.OWNER_HANDLE, displayName: config.OWNER_HANDLE, email: OWNER_EMAIL, authProvider: "local", createdAt: new Date() }).run();
  return { userId: user.user.id };
}
```

`ctx.internalAdapter` 의 메서드 이름(`findUserByEmail`·`createUser`·`linkAccount`·`findAccounts`·`updatePassword`)과 `ctx.password.hash/verify` 는 Better Auth 1.7 의 `auth.$context` 실물로 확인해 맞춘다(`node_modules/better-auth/dist/**/*.d.ts` 의 `InternalAdapter`). 이름이 다르면 그 이름으로 — 의미는 위와 같다.

```ts
// apps/server/src/auth/routes.ts
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { apiError } from "../http/errors";
import { OWNER_EMAIL, type Auth } from "./index";

declare module "fastify" { interface FastifyRequest { user?: { id: string; workspaceId: string } } }

export function registerAuthRoutes(fastify: FastifyInstance, ctx: { auth: Auth; workspaceId: string; db: Db }) {
  // Better Auth 자체 엔드포인트 (로그아웃·세션 갱신에 쓴다)
  fastify.route({ method: ["GET", "POST"], url: "/api/auth/*", async handler(request, reply) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const req = new Request(url, { method: request.method, headers: fromNodeHeaders(request.headers), ...(request.body ? { body: JSON.stringify(request.body) } : {}) });
    const res = await ctx.auth.handler(req);
    reply.status(res.status); res.headers.forEach((v, k) => reply.header(k, v));
    return reply.send(res.body ? await res.text() : null);
  } });

  fastify.post("/api/v1/auth/local", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = z.object({ token: z.string().min(1) }).safeParse(request.body);
    if (!body.success) throw apiError("VALIDATION", "token 이 필요하다");
    let signed: { token: string | null; user: { id: string } };
    try {
      signed = await ctx.auth.api.signInEmail({ body: { email: OWNER_EMAIL, password: body.data.token }, headers: fromNodeHeaders(request.headers), asResponse: false });
    } catch { throw apiError("UNAUTHORIZED", "토큰이 맞지 않는다"); }
    if (!signed.token) throw apiError("UNAUTHORIZED", "세션을 만들지 못했다");
    reply.setCookie("dodok.session", signed.token, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 30 });
    const user = ctx.db.select().from(users).where(eq(users.id, signed.user.id)).get();
    return { sessionToken: signed.token, user: toUser(user) };
  });
  fastify.get("/api/v1/auth/me", { preHandler: requireSession(ctx) }, async (request) => ({ user: toUser(ctx.db.select().from(users).where(eq(users.id, request.user!.id)).get()), workspaceId: ctx.workspaceId }));
  fastify.post("/api/v1/auth/logout", { preHandler: requireSession(ctx) }, async (request, reply) => {
    await ctx.auth.api.signOut({ headers: bearerHeaders(request) }); reply.clearCookie("dodok.session", { path: "/" }); return { ok: true };
  });
}

function bearerHeaders(request: FastifyRequest): Headers {
  const h = fromNodeHeaders(request.headers);
  const cookieToken = request.cookies["dodok.session"];
  if (!h.get("authorization") && cookieToken) h.set("authorization", `Bearer ${cookieToken}`);
  return h;
}
export function requireSession(ctx: { auth: Auth; workspaceId: string }) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const session = await ctx.auth.api.getSession({ headers: bearerHeaders(request) });
    if (!session) throw apiError("UNAUTHORIZED", "로그인이 필요하다");
    request.user = { id: session.user.id, workspaceId: ctx.workspaceId };
  };
}
```

쿠키 이름은 우리 것(`dodok.session`)으로 두고 값은 Better Auth 세션 토큰이다 — Better Auth 자체 쿠키에 기대지 않아 프록시·오리진 설정에 덜 민감하다. `app.ts` 에서 `@fastify/rate-limit` 를 `global: false` 로 등록하고 `createAuth`·`bootstrapOwner`·`registerAuthRoutes` 를 부팅 3·4단계에 넣는다. `App` 에 `auth` 를 노출한다.

- [ ] **Step 3: 통과 확인·커밋** — `git add apps/server/src/auth apps/server/src/app.ts apps/server/test/auth.test.ts apps/server/test/helpers/app.ts && git commit -m "feat(server): Better Auth + owner 부트스트랩 + 로컬 토큰 로그인, requireSession"`.

---

### Task 4: 채널·에이전트·메시지 서비스와 REST

**Files:**
- Create: `apps/server/src/realtime/bus.ts`, `apps/server/src/modules/channels/{service,routes}.ts`, `apps/server/src/modules/agents/{service,routes}.ts`, `apps/server/src/modules/messages/{service,routes}.ts`, `apps/server/src/http/validate.ts`, `apps/server/test/{channels,agents,messages}.service.test.ts`, `apps/server/test/rest.test.ts`
- Modify: `apps/server/src/app.ts`(라우트 등록), `apps/server/test/helpers/seed.ts`

**Interfaces:**
- Produces:
  - `ServerBus` — `emit<K extends keyof BusEvents>(k, p)`, `on(k, h): () => void`; `BusEvents` = `message.created|message.updated|run.state|run.event|channel.updated|channel.member.changed|typing|adapter.status|system.notice`(페이로드는 계약 스펙 7.2 ServerToClientEvents 와 같고 `run.event` 만 `{ event, channelId }`).
  - channels: `createChannel(db, { workspaceId, createdBy, name, topic?, prompt?, relayPolicy?, visibility? }): Channel`, `updateChannel(db, id, patch): { channel; promptChanged: boolean }`(prompt/relayPolicy 변경 시 promptRevision+1), `listChannels`, `getChannel`, `addMember(db, channelId, { memberType, memberId, promptOverride?, autoRespond?, aliases? })`, `updateAgentMember(db, channelId, memberId, patch): { member; promptChanged }`, `removeMember`, `listMembers(db, channelId): ChannelMember[]`, `channelParticipants(db, channelId): Participant[]`(mention.ts 의 Participant — 사람·에이전트 handle·aliases 포함).
  - agents: `createAgent`, `updateAgent`, `listAgents(db, workspaceId)`, `getAgent`.
  - messages: `createUserMessage`, `createAgentMessage`, `createSystemMessage`, `listMessages(db, channelId, { beforeSeq?, afterSeq?, limit })`, `getMessage`. 전부 `Message`(계약 스펙 3장) 를 돌려주고 저장 뒤 bus `message.created` 를 emit 한다(트랜잭션 커밋 뒤).
  - `parseBody(schema, body)` / `parseQuery` → `VALIDATION` HttpError.
  - REST 표(스펙 4장) 중 auth·adapter·reset·runs 를 제외한 전부.

- [ ] **Step 1: 실패 테스트 — 서비스** (세 파일에 나누어) 핵심 단언: 채널 생성 시 `relayPolicy` 기본값 `{ maxRelayTurns: 4, allowPairs: "all" }`; `updateChannel({ prompt })` → `promptRevision` 2, `promptChanged: true`; `updateChannel({ name })` → 리비전 그대로; `addMember(agent, autoRespond: true)` 두 번째는 저장되되 `logger.warn` 호출; `createUserMessage` 가 `seq` 1·2 를 발급하고 `mentions.agents` 에 `@handle` 로 부른 에이전트 id 가 들어가며(`tokenize`) 같은 `clientMsgId` 재호출은 같은 행; `createAgentMessage` 의 같은 `externalId` 는 같은 행; `listMessages({ beforeSeq: 3, limit: 2 })` 는 seq 1·2; bus `message.created` 가 저장마다 1회.
- [ ] **Step 2: 실패 테스트 — REST** (`rest.test.ts`, `bootTestApp` + 로그인 헬퍼 `authed(app)`): `POST /channels` 201 → `GET /channels/:id`; `PATCH /channels/:id { prompt }` 응답 `channel.promptRevision` 2 와 `FakeAdapter.calls.syncChannelConfig` 1건; `POST /channels/:id/members { memberType: "agent", memberId }`; `GET /channels/:id/messages?limit=50`; `POST /agents` 중복 handle 409 `CONFLICT`; `GET /agents/discover` 가 `FakeAdapter.listAgents` 결과.
- [ ] **Step 3: 구현** — 서비스는 Drizzle 쿼리 + 도메인 Zod 로 행→객체 변환(`rowToChannel` 등; `createdAt` 은 ISO 문자열). `createUserMessage` 는 `db.transaction`: `allocateSeq` → `tokenize(bodyMd, participants)` → INSERT. 시스템 메시지의 `authorId` 는 없음. `routes.ts` 는 `requireSession` preHandler + `parseBody`. 채널 갱신에서 `promptChanged` 면 `deps.adapter.syncChannelConfig(channelId, { systemPrompt })` 를 `void ...catch(warn → bus system.notice)` 로 비동기 호출.
- [ ] **Step 4: 통과·커밋** — `feat(server): 채널·에이전트·메시지 서비스와 REST, ServerBus`.

---

### Task 5: wire — Socket.IO 서버(인증·룸·구독·전송·타이핑·팬아웃·백프레셔)

**Files:**
- Create: `apps/server/src/realtime/socket.ts`, `apps/server/src/realtime/events.ts`, `apps/server/test/wire.test.ts`, `apps/server/test/helpers/wire.ts`
- Modify: `apps/server/src/app.ts`

**Interfaces:**
- Consumes: `verifySessionToken`, messages/channels 서비스, `ServerBus`.
- Produces: `attachWire(io, ctx: { auth, db, bus, logger, workspaceId, route: (message: Message) => Promise<void>, runs: RunsFacade })` — `route` 와 `runs`(`abort`, `replay`, `interact`) 는 Task 9 가 채우며 이 태스크는 `route: async () => {}`·`runs: null` 스텁으로 붙인다. `helpers/wire.ts`: `connectWire(app, sessionToken): Promise<Socket<ServerToClientEvents, ClientToServerEvents>>`, `waitFor(socket, event, pred, timeoutMs)`.

- [ ] **Step 1: 실패 테스트** — `wire.test.ts`: (a) 토큰 없으면 `connect_error.data.code === "UNAUTHORIZED"`, `protocol: 99` 면 `PROTOCOL_MISMATCH`; (b) `channel.subscribe { channelId }` ack `{ messages: [], hasMore: false, activeRuns: [], pendingApprovals: [] }`; (c) 두 소켓이 구독한 채널에 A 가 `message.send` → ack `{ message }` 의 `seq` 1, B 가 `message.created` 수신, 같은 `clientMsgId` 재전송은 같은 `message.id`; (d) `channel.subscribe { lastSeq: 1 }` 뒤 seq 2 만 온다; (e) `typing` 이 다른 구독자에게 `{ actorType: "user", actorId }` 로 중계되고 보낸 사람에게는 안 온다; (f) bus `run.event` 를 501개 연속 emit 하면 느린 소켓에 `run.state { resync: true }` 가 오고 이후 델타는 버려진다(소켓의 `sendBuffer.length` 대신 우리 카운터 — 테스트는 `io.sockets.sockets.get(id)` 의 `conn.transport` 를 일시 정지시켜 잰다; 어렵다면 `attachWire` 가 받는 `maxPending` 옵션을 3 으로 낮춰 잰다).
- [ ] **Step 2: 구현**

```ts
// apps/server/src/realtime/socket.ts (핵심)
io.use(async (socket, next) => {
  const { token, protocol } = (socket.handshake.auth ?? {}) as { token?: unknown; protocol?: unknown };
  if (protocol !== WIRE_PROTOCOL) return next(Object.assign(new Error("PROTOCOL_MISMATCH"), { data: { code: "PROTOCOL_MISMATCH", message: `wire protocol ${String(protocol)} != ${WIRE_PROTOCOL}` } }));
  const user = typeof token === "string" ? await verifySessionToken(ctx.auth, token) : null;
  if (!user) return next(Object.assign(new Error("UNAUTHORIZED"), { data: { code: "UNAUTHORIZED", message: "invalid session" } }));
  socket.data.userId = user.userId; next();
});
io.on("connection", (socket) => {
  socket.join(`user:${socket.data.userId}`);
  socket.on("channel.subscribe", async (raw, ack) => {
    const p = ChannelSubscribe.safeParse(raw); if (!p.success) return ack(validation(p.error));
    const channel = getChannel(ctx.db, p.data.channelId); if (!channel) return ack({ ok: false, error: { code: "NOT_FOUND", message: "channel" } });
    await socket.join(`channel:${channel.id}`);
    const page = listMessages(ctx.db, channel.id, { afterSeq: p.data.lastSeq ?? 0, limit: 200 });
    ack({ ok: true, data: { messages: page.messages, hasMore: page.hasMore, activeRuns: ctx.runs?.activeRuns(channel.id) ?? [], pendingApprovals: [] } });
  });
  socket.on("message.send", async (raw, ack) => {
    const p = MessageSend.safeParse(raw); if (!p.success) return ack(validation(p.error));
    const message = createUserMessage(ctx.db, ctx.bus, { ...p.data, authorId: socket.data.userId });
    ack({ ok: true, data: { message } });
    await ctx.route(message).catch((err) => ctx.logger.error({ err, messageId: message.id }, "route failed"));
  });
  socket.on("typing", (raw) => { const p = Typing.safeParse(raw); if (p.success) socket.to(`channel:${p.data.channelId}`).emit("typing", { channelId: p.data.channelId, actorType: "user", actorId: socket.data.userId }); });
  // run.abort / run.events.replay / component.interact / approval.resolve 는 Task 9 가 ctx.runs 로 붙인다 (없으면 ADAPTER_UNAVAILABLE)
});
```

`events.ts`: bus 구독 → `io.to("channel:<id>").emit(...)`; `adapter.status`·`system.notice` 는 `io.emit`(단일 사용자). 백프레셔: 소켓별 `pending` 카운터(우리가 emit 할 때 +1, Socket.IO `socket.conn.on("drain")` 또는 `socket.emit(..., ack)` 대신 `socket.conn.transport.writable` 확인으로 근사) — 단순화: `socket.conn.bufferSize > 1MB` 이거나 `socket.sendBuffer.length > maxPending(500)` 이면 `run.event` 를 건너뛰고 런별 1회 `run.state { resync: true }` 를 보낸다. `RunsFacade.activeRuns(channelId)` 는 Task 8 이 제공(그 전에는 `[]`).

- [ ] **Step 3: 통과·커밋** — `feat(server): wire Socket.IO — 인증·구독·전송·타이핑·팬아웃·백프레셔`.

---

### Task 6: 어댑터 인터페이스·레지스트리·FakeAdapter

**Files:**
- Create: `apps/server/src/adapters/types.ts`, `apps/server/src/adapters/registry.ts`, `apps/server/src/adapters/fake.ts`, `apps/server/test/adapters.fake.test.ts`

**Interfaces:**
- Produces(스펙 6.1, `session_changed` 제외):

```ts
export type AdapterCapabilities = { sessionReset: boolean; agentsList: boolean; configSet: boolean };
export type AdapterEvent =
  | { kind: "run_event"; runId: string; event: Omit<RunEvent, "seq" | "ts"> }
  | { kind: "run_signal"; runId: string; signal: RunSignal }
  | { kind: "canonical"; message: OutboundMessage }
  | { kind: "status"; status: AdapterStatus; capabilities: AdapterCapabilities };
export interface AgentAdapter {
  readonly provider: "openclaw";
  connect(): Promise<void>; close(): Promise<void>;
  status(): AdapterStatus; capabilities(): AdapterCapabilities;
  listAgents(): Promise<Array<{ providerAgentId: string; name?: string }>>;
  sessionKeyFor(providerAgentId: string, channelId: string): string;
  send(input: InboundDeliver): Promise<InboundDeliverResult>;      // ok:false 는 throw AdapterError(code)
  abort(runId: string, sessionKey: string): Promise<void>;
  resetSession(sessionKey: string): Promise<{ sessionStartedAt?: string; lifecycleRevision?: number }>;
  syncChannelConfig(channelId: string, config: ConfigSet["config"]): Promise<ConfigSetResult>;
  onEvent(handler: (e: AdapterEvent) => void): () => void;
}
export class AdapterError extends Error { constructor(readonly code: ErrorCode, message: string) { super(message); } }
```

  - `FakeAdapter`: 위 전부를 메모리로. `calls: { send: InboundDeliver[]; syncChannelConfig: [...]; reset: string[]; abort: [...] }`, `script(fn: (input) => InboundDeliverResult | Promise<...>)`, `emit(e: AdapterEvent)`, `setStatus(...)`, `setCapabilities(...)`; `sessionKeyFor` 는 원형 문자열. `listAgents` 는 `[{ providerAgentId: "dev", name: "dev" }, { providerAgentId: "fin" }]` 기본.
  - `createAdapterRegistry({ openclaw: adapter })` → `get(provider)`.

- [ ] **Step 1~3: 테스트(스크립트·emit·calls 기록) → 구현 → 커밋** `feat(server): AgentAdapter 인터페이스·레지스트리·FakeAdapter`.

---

### Task 7: 세션 상태와 인바운드 컨텍스트 조립

**Files:**
- Create: `apps/server/src/modules/sessions/service.ts`, `apps/server/src/modules/runs/context.ts`, `apps/server/test/sessions.test.ts`, `apps/server/test/runs.context.test.ts`

**Interfaces:**
- Produces:
  - `ensureSession(db, adapter, { channelId, agentId, providerAgentId }): { session: AgentSessionRow; needsPromptContext: boolean }`
  - `markSessionReset(db, channelId, agentId, { sessionStartedAt?, lifecycleRevision? })`
  - `buildInboundDeliver(db, { run, trigger: { message?: Message; interactionText?: string; interactionMessageId?: Id }, session, needsPromptContext }): InboundDeliver`(스펙 7장) — `deliveryId` 는 새 uuid, `runId = run.id`, `agentId = providerAgentId`, `sessionKey = session.sessionKey`, `message.text = renderForAgent(bodyMd, participants)`(상호작용이면 `interactionText`), `context.recentMessages` 는 트리거 이전 최근 20개(시스템 제외, 각각 `renderForAgent`), `participants`(`isSelf` = 이 에이전트), `relayRules` 문장, `channelPrompt` 는 `needsPromptContext` 일 때만, `promptOverride` 는 있으면 항상, `options: {}`.

- [ ] **Step 1: 실패 테스트** — `sessions.test.ts`: 첫 호출은 행 생성 + `needsPromptContext=false`, `promptRevision` 을 올린 뒤 `true`, `markSessionReset` 뒤 `false`. `runs.context.test.ts`: 20개 상한·시스템 제외·트리거 제외, `isSelf` 한 명, `relayRules` 에 `최대 4턴`, `allowPairs` 제한 시 허용 핸들 나열, `channelPrompt` 조건부, `promptOverride` 항상, `InboundDeliver.safeParse` 통과.
- [ ] **Step 2: 구현 → 통과 → 커밋** `feat(server): agent_sessions 서비스와 인바운드 컨텍스트 조립`.

---

### Task 8: 런 오케스트레이터

**Files:**
- Create: `apps/server/src/modules/runs/orchestrator.ts`, `apps/server/src/modules/runs/timers.ts`, `apps/server/src/modules/runs/store.ts`(runs·run_events CRUD), `apps/server/test/runs.orchestrator.test.ts`, `apps/server/test/runs.store.test.ts`

**Interfaces:**
- Consumes: `transition`(machine.ts), `AgentAdapter`, `ServerBus`, `buildInboundDeliver`, `ensureSession`, messages 서비스.
- Produces:

```ts
export type RunTimeouts = { queuedMs: number; runMs: number; finalizingMs: number; coalesceMs: number; maxInflight: number };
export type EnqueueTrigger = { message?: Message; interactionId?: string; interactionText?: string; interactionMessageId?: string };
export interface Orchestrator {
  enqueueRun(plan: RunPlan & { channelId: string }, trigger: EnqueueTrigger): Promise<Run>;
  signal(runId: string, s: RunSignal, ctx?: { message?: string }): Promise<void>;
  applyRunEvent(runId: string, event: Omit<RunEvent, "seq" | "ts">): Promise<void>;   // 델타 코얼레싱·run_events 저장·팬아웃
  abort(runId: string): Promise<void>;
  onCanonical(msg: OutboundMessage): Promise<void>;
  activeRuns(channelId: string): RunState[];
  recoverOnBoot(): Promise<number>;
  stop(): void;   // 타이머 전부 해제
}
export function createOrchestrator(deps: {
  db: Db; bus: ServerBus; adapter: AgentAdapter; logger: Logger;
  onAgentMessage: (message: Message, run: Run) => Promise<void>;   // 라우터(Task 9) — 정본 저장 직후 호출
  now?: () => Date; timeouts?: Partial<RunTimeouts>;
}): Orchestrator
```

  - 어댑터 이벤트 배선: `createOrchestrator` 가 `adapter.onEvent` 를 구독해 `run_event → applyRunEvent`, `run_signal → signal`, `canonical → onCanonical`, `status → bus adapter.status` 로 넘긴다.
  - `store.ts`: `insertRun`, `updateRun(id, patch)`, `getRun`, `findOpenRunBySession(sessionKey)`, `findRunByTriggerMessage`, `appendRunEvent(runId, event) → seq`, `listRunEvents(runId, afterSeq)`, `listOpenRuns()`, `countRunsToday(channelId, now)`, `chainHashes(rootMessageId)`.

- [ ] **Step 1: 실패 테스트**(vitest `vi.useFakeTimers()`, FakeAdapter, 인메모리 DB, seed) — 이름 그대로 단언:
  1. 「enqueue 는 queued 런과 RUN_QUEUED 를 만들고 즉시 디스패치한다(같은 세션에 진행 중 런이 없을 때)」 — `adapter.calls.send[0].runId === run.id`, `context.recentMessages` 존재.
  2. 「같은 세션의 두 번째 런은 첫 런이 끝날 때까지 send 되지 않는다」 — 두 번 enqueue → `send` 1건 → 첫 런 `gateway_final`+`canonical_received` → `send` 2건.
  3. 「gateway_started·text_delta·tool_start/end·gateway_final 이 상태를 전이시키고 run.state 를 팬아웃한다」 — bus 수집 배열의 status 순서 `queued → streaming → tool → streaming → finalizing`.
  4. 「50ms 안의 TEXT_MESSAGE_CONTENT 는 하나로 합쳐 저장·전송된다」 — 델타 3개 → `vi.advanceTimersByTime(50)` → run_events 1건 `delta: "abc"`, bus run.event 1건.
  5. 「정본이 오면 에이전트 메시지가 runId 를 달고 저장되고 onAgentMessage 가 불린다; final 뒤엔 done(plugin)」 — `finalSource: "plugin"`, `RUN_FINISHED.messageIds` 에 메시지 id.
  6. 「final 뒤 정본이 10초 안에 안 오면 스냅샷으로 done(gateway)」 — `gateway_final` with `ctx.message: "snapshot"` → `advance(10_000)` → 메시지 본문 `snapshot`, `finalSource: "gateway"`.
  7. 「queued 120초 안에 gateway_started 가 없으면 error(TIMEOUT)」, 「run 600초」.
  8. 「어댑터가 drop 을 돌려주면 error(DROPPED:bot-loop-protection) 과 run_error 시스템 메시지」, 「AdapterError(ADAPTER_UNAVAILABLE) 도 error 로 닫힌다」.
  9. 「abort 는 adapter.abort 를 부르고 aborted 로 전이한다」.
  10. 「종료된 런에 늦게 온 정본은 runId 를 달아 저장만 하고 상태는 그대로」.
  11. 「recoverOnBoot 는 종료되지 않은 런을 SERVER_RESTART 로 닫고 개수를 돌려준다」.
  12. 「maxInflight(2)를 넘는 런은 앞 런이 끝날 때까지 send 되지 않는다」.
  13. 「런을 못 찾는 정본은 런 없이 저장되고 warn 로그」.
- [ ] **Step 2: 구현 요점**
  - 메모리: `Map<runId, { timers: { queued?; run?; finalizing? }; buffer?: { messageId; text; timer } }>`, `Map<sessionKey, queue: runId[]>`, `inflight: Set<runId>`.
  - `enqueueRun`: `insertRun(queued)` → `appendRunEvent(RUN_QUEUED)` → `bus run.state` → `pump(sessionKey)`.
  - `pump`: 세션 큐 head 가 inflight 가 아니고 `inflight.size < maxInflight` 면 `dispatch(run)`.
  - `dispatch`: `ensureSession` → `buildInboundDeliver` → `adapter.send()` (`try/catch`) → 결과 `admission === "drop"` → `signal(gateway_error { code: "DROPPED", message: reason })`; 예외 `AdapterError` → `gateway_error { code }`; 성공이면 `providerRunId` 저장, queued 타이머 시작.
  - `signal`: `transition(run, s)` → `next === null` 이면 로그 → 아니면 `updateRun` + `STATE_SNAPSHOT` + bus → 타이머 재배치 → 종료면 `finish(run)`(버퍼 flush, 타이머 해제, `inflight.delete`, 세션 큐 pop, `pump`).
  - `onCanonical`: 상관관계 → `createAgentMessage({ runId, externalId: outboundId, bodyMd: text, components })` → `onAgentMessage` → `signal(canonical_received)`.
  - `gateway_final` 의 `ctx.message`(WS 스냅샷 본문) 는 메모리에 보관했다가 `final_timeout` 에서 쓴다.
  - 예외는 런 단위로 잡아 `error(INTERNAL)`.
- [ ] **Step 3: 통과·커밋** — `feat(server): 런 오케스트레이터 — 직렬화·타이머·코얼레싱·정본 상관·부팅 정리`.

---

### Task 9: 라우터 서비스·상호작용·wire 런 이벤트·시스템 메시지 배선

**Files:**
- Create: `apps/server/src/modules/router/service.ts`, `apps/server/src/modules/components/service.ts`, `apps/server/src/modules/runs/routes.ts`, `apps/server/src/wiring.ts`, `apps/server/test/router.service.test.ts`, `apps/server/test/components.service.test.ts`, `apps/server/test/wire.runs.test.ts`
- Modify: `apps/server/src/realtime/socket.ts`(run.abort·run.events.replay·component.interact·approval.resolve), `apps/server/src/app.ts`

**Interfaces:**
- Produces:
  - `createRouter(deps: { db, bus, logger, enqueue: Orchestrator["enqueueRun"] }) → { routeMessage(message: Message): Promise<void> }` — `decideRuns` 입력 조립(스펙 3.7), `blocked` → `createSystemMessage(relay_limit|relay_denied, systemMeta.relay, components)`; `relay_limit` 의 components: `{ blocks: [{ type: "actions", items: [{ type: "button", id: "continue_relay", label: "이어가기", style: "primary" }] }] }`.
  - `interact(db, bus, orchestrator, { userId, messageId, componentId, blockId?, itemId, values }): { interactionId }` — 스펙 3.10 순서. `continue_relay` 는 `systemMeta.relay` 에서 대상 에이전트·rootMessageId 를 읽어 `enqueue({ triggerKind: "continue", relayDepth: 0, rootMessageId: message.id, agentId: toAgentId }, { interactionId })`.
  - `wiring.ts`: `createServices(app 부품)` — 라우터·오케스트레이터 상호 참조를 `let orchestrator` 클로저로 묶고 `{ router, orchestrator, runsFacade }` 를 돌려준다. `runsFacade = { activeRuns, abort, replay(runId, afterSeq): RunEventsReplayResult, interact }`.
  - REST `GET /channels/:id/runs`, `GET /runs/:id`, `GET /runs/:id/events?afterSeq`.

- [ ] **Step 1: 실패 테스트** — `router.service.test.ts`: 사람 메시지 `@dev` → enqueue 1(`mention`, depth 0); 에이전트(dev) 메시지 `@fin` → enqueue(`relay`, depth 1, `rootMessageId` 유지); depth 초과 → `relay_limit` 시스템 메시지 + `continue_relay` 버튼 + `systemMeta.relay.toAgentId`; `allowPairs` 제한 → `relay_denied`; 같은 본문 반복 → `repeat`; `enabled=false` 에이전트는 대상 제외. `components.service.test.ts`: `continue_relay` 클릭 → `continue` 런; 만료 컴포넌트 → `EXPIRED`; 1회용 소비 뒤 → `CONSUMED`; `message.updated` 팬아웃. `wire.runs.test.ts`: `run.abort` ack + `adapter.calls.abort`; `run.events.replay { afterSeq }`; `component.interact` ack `{ interactionId }`.
- [ ] **Step 2: 구현 → 통과 → 커밋** `feat(server): 멘션 라우터·상호작용·런 wire 핸들러·시스템 메시지, 서비스 배선`.

---

### Task 10: 어댑터 — OpenClaw 이벤트 → RunEvent/RunSignal 매핑

**Files:**
- Create: `packages/openclaw-adapter/src/gateway/events.ts`, `packages/openclaw-adapter/test/events.test.ts`, `packages/openclaw-adapter/test/fixtures/gateway-events.ts`

**Interfaces:**
- Produces: `mapGatewayEvent(frame: EventFrame, ctx: { isOurRun: (runId: string) => boolean }): MappedEvent[]` where `MappedEvent = { runId; event?: Omit<RunEvent,"seq"|"ts">; signal?: RunSignal; snapshotText?: string }`. 표는 계약 스펙 6.1: `chat status → STEP_STARTED(phase)`, `chat delta → TEXT_MESSAGE_START(첫)+CONTENT, signal text_delta`, `chat final → TEXT_MESSAGE_END + signal gateway_final + snapshotText(message.content text 결합)`, `chat error → RUN_ERROR + gateway_error`, `chat aborted → RUN_ABORTED(gateway) + gateway_aborted`, `agent tool start → TOOL_CALL_START + TOOL_CALL_ARGS(JSON.stringify(args)) + signal tool_start`, `agent tool result → TOOL_CALL_RESULT(content 는 2,000자로 자름) + TOOL_CALL_END + signal tool_end{openTools}`(열린 툴 수는 매퍼 상태로 센다), `agent lifecycle start(또는 첫 chat) → signal gateway_started 만(RUN_STARTED 는 태스크 8 오케스트레이터가 런 행으로 만든다 — 2026-09-15 판정 D)`, `agent lifecycle end → STEP_FINISHED("lifecycle")`, `agent assistant/thinking/run_status → 무시`, `session.message(assistant, usage) → CUSTOM{name:"openclaw.usage", value:{input,output,cost}}`(런 usage 갱신은 오케스트레이터가 CUSTOM 을 보고), `sessions.changed·node.* → []`. `isOurRun` 이 false 면 `[]`.
- 픽스처는 `data/spike-1-observations.json` 의 프레임 모양(ADR 0001 6.3·6.5)을 손으로 옮긴 것 — 토큰·워크스페이스 내용 없음.

- [ ] **Step 1~3: 테스트(표의 행마다 1개 + 첫 델타에만 START + 툴 카운터) → 구현 → 커밋** `feat(adapter): Gateway 이벤트 → RunEvent/RunSignal 매핑`.

---

### Task 11: 어댑터 — `OpenClawAdapter`(연결 관리·브리지·설정 동기화·리셋·재접속 복구)

**Files:**
- Create: `packages/openclaw-adapter/src/index.ts`, `packages/openclaw-adapter/src/gateway/connection-manager.ts`, `packages/openclaw-adapter/src/gateway/sessions.ts`, `packages/openclaw-adapter/src/config-sync.ts`, `packages/openclaw-adapter/test/{adapter,connection-manager,sessions}.test.ts`
- Modify: `packages/openclaw-adapter/src/bridge/server.ts`(ack Zod 파싱), `packages/openclaw-adapter/src/gateway/client.ts`(scopes 기본값에 approvals·admin, `caps: ["tool-events","approvals","session-scoped-events"]` 기본), `packages/openclaw-adapter/package.json`(`exports`·`main` 을 `src/index.ts` 로; 서버가 워크스페이스 소스로 import)

**Interfaces:**
- Consumes: `AgentAdapter`(Task 6 — 타입은 `@dodok/openclaw-adapter` 가 서버를 import 할 수 없으므로 **인터페이스를 `packages/openclaw-adapter/src/adapter-types.ts` 로 옮기고 서버의 `adapters/types.ts` 는 re-export** 한다. Task 6 을 구현할 때 이 위치로 만든다).
- Produces:

```ts
export function createOpenClawAdapter(opts: {
  gateway: { url: string; token: string; deviceIdentityPath: string };
  bridge: { io: Server; token: string; serverVersion: string };
  logger: Logger;
  connector?: (o: GatewayConnectOptions) => Promise<GatewayConnection>;   // 테스트 주입(기본 connectGateway)
  sessionKeysToRecover?: () => string[];                                  // 재접속 복구 대상 (서버가 agent_sessions 에서 준다)
}): AgentAdapter
```

  - `connection-manager.ts`: `start()` → 백오프(1s→30s, ±20% 지터)로 `connector` 재시도, `PairingRequired` 는 5s 뒤 재시도, hello 뒤 `sessions.subscribe({})` + 복구 대상마다 `sessions.messages.subscribe({ key, agentId })` + `chat.history({ sessionKey, limit: 50, ...(cursor ? { cursor } : {}) })`(결과 `kind:"reset"` 이면 커서 없이 재호출; 응답의 `deltaCursor` 를 `historyCursors` 맵에 저장), 끊기면 `status reconnecting` → 재시작. `request()` 는 연결 없으면 `AdapterError("ADAPTER_UNAVAILABLE")`, Gateway 오류 `details.code === "MISSING_SCOPE"` 면 `AdapterError("FORBIDDEN")`.
  - `send`: `bridge.deliverInbound(payload, 10_000)` → 결과 `ok:false` 코드 `TIMEOUT` 이면 1s·4s·16s 뒤 재시도(최대 3회), `ADAPTER_UNAVAILABLE` 이면 `bridge.waitForReady(120_000)` 뒤 1회 재시도, 그래도 실패면 `AdapterError`. `ok:true` 의 `data` 를 `InboundDeliverResult.safeParse` — 실패면 `AdapterError("INTERNAL", "ADAPTER_PROTOCOL: ...")`.
  - `resetSession(key)`: `request("sessions.reset", { key })` → `entry.sessionStartedAt`(ms → ISO)·`lifecycleRevision`; `FORBIDDEN` 이면 `capabilities.sessionReset=false` 로 내리고 `status` 이벤트 후 `AdapterError("FORBIDDEN")`.
  - `abort(runId, sessionKey)`: `request("chat.abort", { sessionKey, runId })`.
  - `listAgents`: `request("agents.list", {})` → `agents[].id` 를 `providerAgentId` 로(응답 모양은 ADR 0001 2.1 표: `agents: [{ id, name?, ... }]` — 실물이 다르면 그에 맞춘다).
  - `syncChannelConfig`: `bridge.setConfig({ channelId, config }, 10_000)` → `ok:false` 는 `AdapterError`.
  - 이벤트: Gateway `onEvent` → `mapGatewayEvent` → `run_event`/`run_signal`(`isOurRun` 은 서버가 준 `knownRunIds: Set` — `send` 성공 시 `runId` 를 넣고 `run_signal` 종료 시 지운다); 브리지 `onOutboundMessage` → `canonical` emit 후 `{ messageId }` 는 서버가 저장한 id 를 돌려줘야 하므로 `onOutboundMessage` 콜백은 **서버가 등록하는 훅**(`opts.onCanonical: (m) => Promise<{ messageId }>`)으로 두고 어댑터 `AdapterEvent.canonical` 은 알림용으로만 — 즉 `createOpenClawAdapter` 인자에 `onCanonical` 을 추가하고 오케스트레이터 `onCanonical` 이 저장한 `messageId` 를 돌려주게 Task 8 시그니처를 `Promise<{ messageId?: string }>` 로 맞춘다.
- [ ] **Step 1: 실패 테스트** — 가짜 `connector`(이벤트 주입 가능한 `GatewayConnection` 대역)와 실제 `attachBridge` + `socket.io-client` 가짜 플러그인으로: 연결 성공 → `status connected`; connector 가 2번 실패 뒤 성공 → 백오프 호출 횟수; `send` 재시도 시퀀스(가짜 플러그인이 첫 ack 를 안 주면 1s 뒤 재전송); ack `{}` → `ADAPTER_PROTOCOL`; `sessions.reset` MISSING_SCOPE → capability false; `chat.history` reset → 재호출; 매핑된 이벤트가 `run_event` 로 emit 되고 모르는 runId 는 무시.
- [ ] **Step 2: 구현 → 통과 → 커밋** `feat(adapter): OpenClawAdapter — 연결 관리·백오프·브리지 ack 파싱·재시도·config-sync·리셋·재접속 복구`.

---

### Task 12: 서버 배선 완성 — 실제 어댑터·adapter.status·「새 대화」·부팅 정리

**Files:**
- Modify: `apps/server/src/app.ts`, `apps/server/src/wiring.ts`, `apps/server/src/modules/channels/routes.ts`(reset), `apps/server/src/modules/channels/service.ts`(`resetAgentSession`)
- Create: `apps/server/src/modules/adapter/routes.ts`(`GET /adapter/status`), `apps/server/test/app.wiring.test.ts`

**Interfaces:**
- `createApp(config, deps)` 의 `deps.adapter` 가 없으면 `createOpenClawAdapter({ gateway: config.gateway, bridge: { io, token: config.BRIDGE_TOKEN, serverVersion }, sessionKeysToRecover: () => agent_sessions 의 키, onCanonical: orchestrator.onCanonical })` 를 만든다. 순서: db → auth → fastify → io → 어댑터 생성 → 서비스 배선(`createServices`) → 라우트·wire 등록 → `orchestrator.recoverOnBoot()` → `adapter.connect()`(실패해도 부팅 계속) → ready. `close()` 는 역순 + `orchestrator.stop()`.
- `POST /channels/:id/agents/:agentId/reset` → `resetAgentSession` → 409 `ADAPTER_CAPABILITY_MISSING`(코드는 `FORBIDDEN` 로 매핑, message 로 구분) / 503.
- `GET /adapter/status` → `{ ...adapter.status(), capabilities, gatewayVersion? }`.

- [ ] **Step 1: 실패 테스트** — FakeAdapter 로: 부팅 시 `recoverOnBoot` 가 이전 DB 의 진행 중 런을 닫는다(파일 DB 로 두 번 부팅); `PATCH /channels/:id { prompt }` → `syncChannelConfig` 호출; `POST .../reset` → `adapter.calls.reset` + 시스템 메시지 `info` + `agent_sessions.promptRevisionAtStart` 갱신; capability 없으면 409; `GET /adapter/status`; bus `adapter.status` 가 wire 로 팬아웃.
- [ ] **Step 2: 구현 → 통과 → 커밋** `feat(server): 실제 어댑터 배선·adapter.status·새 대화·부팅 정리`.

---

### Task 13: 테스트 하네스 — 가짜 Gateway·가짜 플러그인·시나리오

**Files:**
- Create: `apps/server/test/fakes/fake-gateway.ts`, `apps/server/test/fakes/fake-plugin.ts`, `apps/server/test/fakes/scenario.ts`, `apps/server/test/fakes/fake-gateway.test.ts`, `apps/server/test/fakes/fake-plugin.test.ts`

**Interfaces:**
- `startFakeGateway(opts: { grantAdmin?: boolean }): Promise<FakeGateway>` — `ws` 서버. `url`, `token: "fake-token"`, `close()`, `runs: Map<runId, {...}>`, `scriptRun(handler: (params: ChatSendParams) => Promise<void> | void)`, `emitEvent(event: string, payload: unknown)`, `chatDelta(runId, sessionKey, agentId, text)`, `chatFinal(...)`, `toolStart/toolResult(...)`, `requests: RequestFrame[]`(수신 기록).
  - 연결 시 즉시 `{ type: "event", event: "connect.challenge", payload: { nonce: randomUUID(), ts: Date.now() } }`.
  - `req connect` → 검증 없이 `res ok payload: { type: "hello-ok", protocol: 4, server: { version: "2026.9.4", connId }, features: { methods: [...우리가 쓰는 것 전부], events: [...], capabilities: [] }, snapshot: { presence: [], health: { ok: true }, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0, sessionDefaults: { defaultAgentId: "dev" } }, auth: { method: "token", role: "operator", scopes: [...params.scopes] }, policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 30000 } }`. `hello-ok` 필수 필드는 `@openclaw/gateway-protocol` `HelloOkSchema` 를 따른다 — 실제 `GatewayClient` 가 붙지 않으면 스키마의 필수 필드(`snapshot.health`, `stateVersion` 등)를 채운다.
  - `req chat.send` → `res { runId: params.idempotencyKey, status: "started" }` 뒤 `scriptRun` 호출. `sessions.subscribe`·`sessions.messages.subscribe` → `{ subscribed: true }`. `sessions.list` → `{ sessions: [] }`. `chat.history` → `{ sessionKey, messages: [], completeSnapshot: true }` (`cursor` 가 오면 `{ kind: "reset" }`). `chat.abort` → `{ ok: true }` + `chat aborted` 이벤트. `sessions.reset` → `grantAdmin` 이면 `{ ok: true, key, entry: { sessionId, lifecycleRevision: randomUUID(), sessionStartedAt: Date.now() } }`, 아니면 `res ok:false error { code: "FORBIDDEN", message: "missing scope", details: { code: "MISSING_SCOPE", missingScope: "operator.admin" } }`. `agents.list` → `{ agents: [{ id: "dev", name: "dev" }, { id: "fin", name: "fin" }] }`. 모르는 메서드 → `FORBIDDEN/MISSING_SCOPE`(ADR 0001 과 같게).
  - 이벤트 프레임은 `{ type: "event", event, payload, seq }`, `chat` payload `{ runId, sessionKey, agentId, seq, state, deltaText?, message? }`, `agent` payload `{ runId, sessionKey, agentId, seq, ts, isHeartbeat: false, stream, data }`.
- `startFakePlugin(opts: { bridgeUrl, token, onInbound: (d: InboundDeliver) => Promise<InboundDeliverResult> }): Promise<FakePlugin>` — `socket.io-client` → `/bridge`, `hello { pluginVersion: "test", protocol: BRIDGE_PROTOCOL, capabilities: ["agents.list","config.set","typing","run_id_in_outbound"] }`, `inbound.deliver` → `onInbound` → ack; `config.set` → ack `{ ok: true, data: { applied: "live" } }` + `configSets` 기록; `sendOutbound(m: Omit<OutboundMessage,"outboundId"|"ts">): Promise<{ messageId }>`; `disconnect()`, `reconnect()`.
- `scenario.ts`: `createScenario({ gateway, plugin, agents: { [providerAgentId]: (turn) => { deltas: string[]; reply: string; tool?: {...} } } })` — `onInbound` 가 `dispatch` 를 ack 하고 `setImmediate` 로 가짜 Gateway 에 `lifecycle start → deltas → final` 을 흘린 뒤 플러그인 `outbound.message { runId, text: reply, sessionKey, agentId }` 를 보낸다. `turn` 은 `{ delivery, index }`.

- [ ] **Step 1: 하네스 자체 테스트** — 실제 `connectGateway` 로 가짜 Gateway 에 붙어 `hello.protocol === 4`, `chat.send` 응답 `runId`, 이벤트 수신; 가짜 플러그인이 `attachBridge` 에 hello 하고 `inbound.deliver` ack 를 돌려준다.
- [ ] **Step 2: 구현 → 통과 → 커밋** `test(server): 가짜 Gateway·가짜 플러그인·시나리오 하네스`.

---

### Task 14: 통합 시나리오 1~8

**Files:**
- Create: `apps/server/test/integration/{relay,recovery,prompt}.test.ts`, `apps/server/test/helpers/live-app.ts`(`bootLiveApp()`: 가짜 Gateway 기동 → config(`OPENCLAW_TARGET=dev`, dev URL = 가짜) → `createApp` 실제 `OpenClawAdapter` → 가짜 플러그인 접속 → 로그인 → wire 소켓)

- [ ] **Step 1: 시나리오 테스트 작성**(스펙 9.2 의 1~8, 각 `it` 하나. 실제 시계 사용, 타임아웃이 필요한 6·7 은 `createApp` 의 `deps.timeouts` 로 `queuedMs: 500` 처럼 줄인다):
  1. 로그인 → 채널 → 에이전트 `dev`·`fin` 등록·멤버 추가 → `relayPolicy.maxRelayTurns = 2`.
  2. `@dev 안녕` → `run.state` 순서 `queued, streaming, finalizing?, done` 관용 검사(streaming 포함·마지막 done), `run.event` 에 `TEXT_MESSAGE_CONTENT`, `message.created` 의 `runId`·본문 `reply`.
  3. dev 답변 `@fin ...` → fin 런 `relayDepth 1` → fin 답변 `@dev ...` → dev 런 `relayDepth 2` → dev 답변 `@fin` → `relay_limit` 시스템 메시지(`systemMeta.relay.toAgentId === fin`), `continue_relay` 버튼.
  4. `component.interact { itemId: "continue_relay" }` → `continue` 런 `relayDepth 0`.
  5. 대본을 같은 본문 반복으로 → `relay_denied`(`repeat`); `allowPairs: [{ from: dev, to: fin }]` 에서 fin→dev → `relay_denied`.
  6. 플러그인 대본 `drop` → `run_error` 시스템 메시지에 `bot-loop-protection`; 플러그인 disconnect 뒤 메시지 → `queuedMs` 뒤 `error ADAPTER_UNAVAILABLE`.
  7. wire 재접속 `lastSeq` → 빈틈 메움; `app.close()` 후 같은 DB 파일로 `createApp` → 진행 중 런 `SERVER_RESTART`.
  8. `PATCH prompt` → 다음 인바운드 `context.channelPrompt` 존재 + 플러그인 `configSets` 1건; `POST reset`(가짜 `grantAdmin: true`) → 다음 인바운드 `channelPrompt` 없음; `grantAdmin: false` 앱에서 reset → 409.
- [ ] **Step 2: 통과할 때까지 구현 결함 수정(태스크 8~12 파일) → 커밋** `test(server): 통합 시나리오 1~8 — 릴레이·상한·이어가기·차단·드롭·복구·프롬프트 리비전`.

---

### Task 15: wire-cli·문서·dev Gateway 실연

**Files:**
- Create: `scripts/wire-cli.ts`, `docs/guides/live-smoke.md`
- Modify: `package.json`(루트 script `wire-cli`), `.env.example`, `docs/project-structure.md`(2.2·2.3·4장), `CLAUDE.md`(명령·현재 단계), `docs/plan.md` 8장 Phase 1 체크

- [ ] **Step 1: wire-cli** — `tsx scripts/wire-cli.ts <origin> <localToken> <명령>`: `login`, `channels`, `create-channel <name>`, `add-agent <channelId> <providerAgentId> <handle>`, `send <channelId> <text>`(구독 후 `message.created`·`run.state`·`run.event` 를 60초 동안 stdout 에 시간표로 찍고 종료), `reset <channelId> <agentId>`. REST 는 `fetch`, wire 는 `socket.io-client`.
- [ ] **Step 2: 실연(verify 워커, 로컬 dev Gateway)** — 브리프에 모델 런 상한 8. 절차: `~/.openclaw-dev` 의 `channels.dodok.channels` 를 `config unset` 으로 비움 → 플러그인 최신 번들(`pack:plugin`) 재설치(`admission` 을 싣는 번들) → `openclaw --dev gateway run` → `.env` 에 `OPENCLAW_TARGET=dev`·`BRIDGE_TOKEN` → `pnpm -F @dodok/server dev` → 플러그인 계정 `bridgeUrl` 을 서버로 → wire-cli 로 시나리오 2~4(사람 → `@dev` → `@fin` → 상한) → 로그 `data/phase1-live-<날짜>.log`. 결과(응답 지연·ack 지연·틀린 것)를 `docs/guides/live-smoke.md` 에 절차와 함께 기록.
- [ ] **Step 3: 문서** — `.env.example` 전체 변수, 구성 가이드 2.2(파일 실물)·2.3(어댑터 실물)·4장(환경 변수 표), CLAUDE.md 명령(`pnpm -F @dodok/server dev`, `pnpm wire-cli`)·현재 단계(「Phase 1 ① 완료, 다음 ② 웹」), 계획서 8장 Phase 1 서버 항목 체크.
- [ ] **Step 4: 커밋** `feat(server): wire-cli 와 dev Gateway 실연 절차, 문서 갱신`.

---

## 실행 순서와 병렬성

- 순차: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 12 → 13 → 14 → 15.
- 병렬 가능: 태스크 0(원격 프로브, verify)은 언제든. 태스크 10·11(어댑터)은 태스크 6 뒤 서버 태스크 7~9 와 **다른 워크트리에서 병렬**(파일이 겹치지 않는다 — 단 `adapter-types.ts` 위치는 태스크 6 이 먼저 정한다).
- 워커 브리프는 태스크 본문 + 「Interfaces」 + Global Constraints 만 담는다. 리뷰는 태스크마다.

## 자체 검토

- 스펙 커버리지: 2장(부팅·종료) → T1·T12; 3.1 → T1; 3.2 → T2; 3.3 → T3; 3.4·3.5·3.6 → T4; 3.7 → T9; 3.8 → T8; 3.9 → T7·T12; 3.10 → T9; 3.11 → T5·T9; 3.12 → T6; 4장 → T3·T4·T9·T12; 5장 → T14; 6.1 → T6; 6.2 → T11; 6.3 → T11; 6.4 → T11·T12; 6.5 → T11; 7장 → T7; 8장 → T8·T11·T14; 9.1 → 각 태스크; 9.2 → T13·T14; 9.3 → T15; 10장 1 → T0.
- 스펙 정정(이 계획과 함께 반영): 스펙 3.9·6.1·6.2 의 「재접속 시 `sessions.list` 로 `sessionStartedAt`/`lifecycleRevision` 변화 감지」는 실측과 맞지 않는다 — `sessions.list` 항목과 `chat.history.sessionInfo` 에는 두 필드가 없고 `sessions.reset` 응답 `entry` 에만 있다(`data/spike-3-observations-*.json`). 외부 리셋 감지는 MVP 범위 밖으로 두고 `AdapterEvent.session_changed` 를 뺀다.
- 타입 일관성: `Orchestrator.onCanonical` 은 `Promise<{ messageId?: string }>`(T8·T11), `AgentAdapter` 정의는 `packages/openclaw-adapter/src/adapter-types.ts`(T6·T11), `RunsFacade` 는 T5 가 참조하고 T9 가 구현, `ServerBus` 이벤트 이름은 계약 스펙 7.2 와 같다.
