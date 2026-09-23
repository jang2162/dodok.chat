# Phase 3 ① 배포 패키징 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`CLAUDE.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나.

**Goal:** 배포 호스트에서 `.env` 하나와 `docker compose -f infra/compose.yml up -d --build` 한 줄로 HTTPS dodok(서버·웹)이 뜨고, 데이터가 볼륨에 남고, 백업·복원·업데이트가 된다.

**Architecture:** 서버는 esbuild 로 한 파일(`dist/main.js`)로 묶여 `node:24` 슬림 이미지에서 비루트로 돈다(네이티브 `better-sqlite3` 등은 lockfile 로 설치). 웹 빌드 산출물은 Caddy 이미지에 구워 넣고, Caddy 가 정적 서빙·TLS·`/api`·`/socket.io`·`/healthz` 프록시를 맡는다. 호스트에 여는 포트는 Caddy 80·443 뿐이다.

**Tech Stack:** Docker 29 / Compose 5(colima, arm64 — 로컬 검증) · `node:24.21.0-bookworm`(빌드)·`node:24.21.0-bookworm-slim`(실행) · `caddy:2` 정확 태그 · esbuild 0.28.2(플러그인이 이미 쓰는 버전) · pnpm 11.16.0 · better-sqlite3 13.0.3

**Spec:** `docs/superpowers/specs/2026-09-24-deploy-packaging-design.md` — 결정 0장, 구조 2장, 데이터 3장, 연결 절차 4장, 오류 5장, 보안 6장, 검증 9장. **태스크를 시작하기 전에 스펙의 해당 장을 읽는다.**

## Global Constraints

- **이미지 태그는 정확 핀**: `node:24.21.0-bookworm`·`node:24.21.0-bookworm-slim`(mise 의 Node 24.21.0 과 같다), `caddy:<2.x 정확 태그>`(태스크 3 이 `docker pull` 되는 최신 2.x 를 골라 적는다 — `latest`·`2` 금지).
- **새 npm 의존성은 없다.** 서버 번들은 저장소에 이미 있는 esbuild 0.28.2 를 서버 devDependency 로 정확 핀해 쓴다(`pnpm -F @dodok/server add -D -E esbuild@0.28.2`).
- **실행 이미지의 `node_modules` 는 lockfile 에서 온다**(`--frozen-lockfile`). 손으로 쓴 package.json·`npm install` 로 버전을 풀지 않는다.
- **호스트에 여는 포트는 Caddy 뿐**이다(운영 80·443, 로컬 검증 8443). `app` 은 `expose` 만.
- **컨테이너는 비루트**(`node` 사용자, UID 1000)로 돈다. `/data` 는 그 사용자 소유.
- **이미지에 `.env*`(`.env.example` 제외)·`data/`·`.worktrees/`·`.superpowers/`·`node_modules`(호스트 것)·`.git` 이 들어가지 않는다**(루트 `.dockerignore`).
- 운영 이미지에 개발 진입점(dev:fake)을 넣지 않는다 — dev:fake 는 별도 빌드 타깃(`devfake`)이다.
- 5173·3000 은 이 머신에서 다른 프로젝트·다른 용도다 — 로컬 검증은 **8443**(Caddy)·컨테이너 안 포트만 쓴다.
- 시크릿 규칙은 `docs/guides/live-smoke.md` 2절: `.env`·`~/.openclaw*/openclaw.json` 을 cat·grep 하지 않는다, 로그의 시크릿은 `grep -c -F` 로 개수만.
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프(`feat(server):`·`feat(infra):`·`docs:`). 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 **자기 실행 출력에서** 패키지별로.

## Review Focus

1. **볼륨 소유자** — 이미 있는 `dodok-data` 볼륨이 root 소유(예: 이전 이미지·손으로 만든 볼륨)면 비루트 앱이 `/data` 에 못 써 부팅이 실패한다. 사람은 「권한 오류 한 줄 + 문서의 `chown` 한 줄」을 기대한다. → 태스크 3(엔트리 검사)·태스크 4(재현).
2. **SPA 폴백·캐시 헤더** — 없는 `/api/v1/...` 가 index.html(200)로 떨어지면 웹이 JSON 대신 HTML 을 파싱하다 이상하게 깨진다. `sw.js` 가 캐시되면 새 버전이 영영 안 뜬다. → 태스크 3(curl 단언)·태스크 4.
3. **업로드 상한 경계** — 19 MiB 는 통과, 21 MiB 는 Caddy 413 이 아니라 서버의 고정 문구(첨부 상한)가 나와야 한다. → 태스크 4.
4. **TRUST_PROXY·실제 클라이언트 IP** — 프록시 뒤에서 로그인 레이트리밋이 모든 사용자를 Caddy IP 하나로 묶으면 한 사람의 실패가 모두를 막는다. `X-Forwarded-For` 가 서버의 `request.ip` 로 들어오는지. → 태스크 4.
5. **쓰는 중 백업·복원 뒤 낡은 WAL** — 메시지가 들어오는 동안 백업해도 백업 DB 가 온전하고(무결성 검사), 복원 때 옛 `-wal`·`-shm` 이 남아 복원본을 덮지 않는다. → 태스크 2(단위)·태스크 4(실물).

---

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `apps/server/scripts/build.mjs` | 1 | esbuild 번들(엔트리 `main`·`backup`) |
| `apps/server/src/runtime.ts` | 1 | 실행 모드 판정(소스/번들) — chdir·`.env` 읽기 여부, 마이그레이션 폴더 |
| `apps/server/src/main.ts`·`src/db/client.ts` | 1 | runtime.ts 사용 |
| `apps/server/scripts/bundle-smoke.mjs` | 1 | 번들을 임시 DATA_DIR 로 띄워 `/healthz` 200 확인 |
| `apps/server/src/backup.ts`·`src/backup-main.ts` | 2 | 온라인 백업·보관 개수 / CLI 진입점 |
| `.dockerignore` | 3 | 빌드 컨텍스트 제외 |
| `infra/Dockerfile.server` | 3 | `build`·`runtime`·`devfake` 타깃 |
| `infra/Dockerfile.web` | 3 | 웹 빌드 → Caddy |
| `infra/Caddyfile`·`infra/compose.yml`·`infra/compose.local.yml`·`infra/local.env.example` | 3 | 운영·로컬 검증 구성 |
| `apps/server/scripts/dev-fake.ts` | 3 | `DEV_FAKE_HOST` 로 리슨 주소 |
| `.env.example` | 3 | 배포 절 |
| `docs/guides/deploy.md` | 5 | 사람 절차 |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 서버 운영 번들 | — |
| B | 2 백업·복원 | 1 |
| C | 3 이미지·Compose·Caddy | 2 |
| D | 4 로컬 Compose 검증 → 수정 → 재검증 | 3 |
| E | 5 문서(deploy.md·구성·계획서) | 4 |

---

### Task 1: 서버 운영 번들

**Files:**
- Create: `apps/server/src/runtime.ts`, `apps/server/test/runtime.test.ts`, `apps/server/scripts/build.mjs`, `apps/server/scripts/bundle-smoke.mjs`
- Modify: `apps/server/src/main.ts`, `apps/server/src/db/client.ts`, `apps/server/package.json`(`build`·`bundle:smoke` 스크립트, esbuild devDependency)

**Interfaces:**
- Produces:
  - `isBundled(): boolean` — esbuild 가 `define` 으로 넣는 `__DODOK_BUNDLED__`(없으면 false)
  - `migrationsFolder(env = process.env): string` — `DODOK_MIGRATIONS_DIR` 가 있으면 그것, 없으면 소스 기준 `apps/server/drizzle`(지금 값)
  - 번들 산출물 `apps/server/dist/main.js`(태스크 2 가 `dist/backup.js` 를 더한다), `pnpm -F @dodok/server build`
  - 실행 이미지가 설정할 환경변수: `DODOK_MIGRATIONS_DIR=/app/drizzle`

- [ ] **Step 1: 번들이 되는지 먼저 잰다(관문)**

`build.mjs` 를 최소로 쓰고(아래 Step 4) `external: ["better-sqlite3"]` 만 두고 묶는다. `node dist/main.js` 를 **임시 DATA_DIR·닿지 않는 Gateway URL** 로 띄운다(Step 5 의 smoke 스크립트). 실패하면(동적 `require`·`import.meta` 경로·네이티브 모듈·optional 의존성 `bufferutil`·`utf-8-validate` 등) 원인 패키지를 `external` 에 더해 가며 **최소 external 목록**을 찾는다. 결과(external 목록·까닭·번들 크기)를 보고서 표로. external 이 10개를 넘거나 better-auth 전체가 external 이 되어야 하면 **멈추고 조율자에게 물어라**(접근 A 의 전제가 약해진다).

- [ ] **Step 2: runtime 테스트(실패)**

```ts
// apps/server/test/runtime.test.ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBundled, migrationsFolder } from "../src/runtime";

describe("runtime", () => {
  it("테스트(소스 실행)에서는 번들이 아니다", () => {
    expect(isBundled()).toBe(false);
  });
  it("DODOK_MIGRATIONS_DIR 가 있으면 그것을 쓴다", () => {
    expect(migrationsFolder({ DODOK_MIGRATIONS_DIR: "/app/drizzle" })).toBe("/app/drizzle");
  });
  it("없거나 비었으면 소스 기준 apps/server/drizzle", () => {
    const dir = migrationsFolder({});
    expect(dir.endsWith(join("apps", "server", "drizzle"))).toBe(true);
    expect(migrationsFolder({ DODOK_MIGRATIONS_DIR: "" })).toBe(dir);
  });
});
```

- [ ] **Step 3: 구현**

```ts
// apps/server/src/runtime.ts
/** 실행 모드(스펙 2.1) — 소스(tsx·vitest)와 운영 번들(esbuild, dist/main.js)의 차이를 한곳에 둔다 */
import { fileURLToPath } from "node:url";

declare const __DODOK_BUNDLED__: boolean | undefined;

export function isBundled(): boolean {
  return typeof __DODOK_BUNDLED__ !== "undefined" && __DODOK_BUNDLED__ === true;
}

/** drizzle 마이그레이션 폴더. 번들에서는 import.meta.url 기준 상대 경로가 바뀌므로 이미지가 DODOK_MIGRATIONS_DIR 를 준다 */
export function migrationsFolder(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DODOK_MIGRATIONS_DIR;
  if (fromEnv) return fromEnv;
  return fileURLToPath(new URL("../drizzle", import.meta.url));
}
```

(`runtime.ts` 는 `src/` 바로 아래라 `../drizzle` = `apps/server/drizzle`. 번들에서 기본값이 쓰이면 틀린 경로가 되므로, 번들 모드에서 환경변수가 없으면 **부팅 때 설정 오류로 끝낸다** — 아래 client.ts.)

```ts
// apps/server/src/db/client.ts — migrate 줄
import { isBundled, migrationsFolder } from "../runtime";
…
  if (isBundled() && !process.env.DODOK_MIGRATIONS_DIR) {
    throw new Error("설정 오류: 운영 번들에는 DODOK_MIGRATIONS_DIR 가 필요하다(이미지가 /app/drizzle 로 준다)");
  }
  migrate(db, { migrationsFolder: migrationsFolder() });
```

```ts
// apps/server/src/main.ts — 앞부분
import { isBundled } from "./runtime";
…
// 소스 실행(`pnpm -F @dodok/server dev`)은 cwd 가 apps/server 다 — ./data·.env 가 저장소 루트를 가리키게 옮긴다.
// 운영 번들은 이미지의 WORKDIR·환경변수(env_file)를 그대로 쓴다(.env 파일을 읽지 않는다)
if (!isBundled()) {
  process.chdir(resolve(import.meta.dirname, "../../.."));
  if (existsSync(".env")) process.loadEnvFile(".env");
}
```

- [ ] **Step 4: build.mjs**

```js
// apps/server/scripts/build.mjs — 운영 번들(스펙 2.1). 사용: pnpm -F @dodok/server build
import { build } from "esbuild";

const external = ["better-sqlite3" /* Step 1 이 찾은 나머지 — 까닭을 한 줄씩 주석으로 */];

await build({
  entryPoints: { main: "src/main.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  external,
  define: { __DODOK_BUNDLED__: "true" },
  // ESM 번들 안의 CommonJS 의존성이 require 를 쓸 수 있게
  banner: { js: "import { createRequire as __dodokCreateRequire } from 'node:module'; const require = __dodokCreateRequire(import.meta.url);" },
  logLevel: "info",
});
```

`package.json` 스크립트: `"build": "node scripts/build.mjs"`, `"bundle:smoke": "node scripts/bundle-smoke.mjs"`. `dist/` 는 이미 `.gitignore` 에 있다.

- [ ] **Step 5: bundle-smoke.mjs**

```js
// apps/server/scripts/bundle-smoke.mjs — dist/main.js 를 임시 DATA_DIR 로 띄워 /healthz 200 을 본다(스펙 8장). 네트워크 밖으로 나가지 않는다
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "dodok-bundle-"));
const port = 3000 + Math.floor(Math.random() * 1000) + 3000; // 6000~6999 — 3000·5173 을 피한다
const secret = () => randomBytes(24).toString("hex");
const child = spawn(process.execPath, ["dist/main.js"], {
  env: {
    PATH: process.env.PATH,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    DODOK_MIGRATIONS_DIR: resolve("drizzle"),
    APP_ORIGIN: `http://localhost:${port}`,
    LOCAL_AUTH_TOKEN: secret(),
    BETTER_AUTH_SECRET: secret(),
    BRIDGE_TOKEN: secret(),
    OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:9", // 닿지 않는다 — 부팅을 막지 않는다(app.ts)
    OPENCLAW_GATEWAY_TOKEN: secret(),
    VAPID_SUBJECT: "mailto:smoke@example.com",
    LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
let ok = false;
for (let i = 0; i < 60 && !ok; i++) {
  await new Promise((r) => setTimeout(r, 250));
  ok = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
}
child.kill("SIGTERM");
await new Promise((r) => child.once("exit", r));
rmSync(dataDir, { recursive: true, force: true });
console.log(ok ? "bundle smoke: /healthz 200" : "bundle smoke: FAILED");
process.exit(ok ? 0 : 1);
```

- [ ] **Step 6: 통과 확인** — `pnpm -F @dodok/server test`(runtime 3건 포함), `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke` exit 0, 소스 실행(`pnpm -F @dodok/server dev`)이 기존처럼 루트 `.env` 를 읽는지 **값을 찍지 않고**(부팅 로그 한 줄) 확인. 번들 크기·external 표를 보고서에.

- [ ] **Step 7: 커밋** — `feat(server): 운영 번들(esbuild)과 실행 모드 판정`

---

### Task 2: 백업·복원

**Files:**
- Create: `apps/server/src/backup.ts`, `apps/server/src/backup-main.ts`, `apps/server/test/backup.test.ts`
- Modify: `apps/server/scripts/build.mjs`(엔트리 `backup: "src/backup-main.ts"`)

**Interfaces:**
- Consumes: 태스크 1 의 `build.mjs`·`migrationsFolder`
- Produces:
  - `runBackup(opts: { dataDir: string; dbPath?: string; keep?: number; now?: Date }): Promise<{ dir: string; dbBytes: number; ms: number; removed: string[] }>`
  - CLI `node dist/backup.js [--keep N]` — 환경변수 `DATA_DIR`(기본 `/data`)·`DB_PATH`(기본 `<DATA_DIR>/dodok.sqlite`), 한 줄 출력, 실패 exit 1

- [ ] **Step 1: 테스트(실패)**

```ts
// apps/server/test/backup.test.ts — 핵심 사례
it("쓰는 중에도 온전한 사본을 만든다 [Review Focus 5]", async () => {
  // createDb(임시 파일)로 행을 넣는 루프를 돌리는 동안 runBackup → 사본을 열어 PRAGMA integrity_check = "ok", 테이블이 있다
});
it("백업 디렉터리는 UTC 시각 이름이고 vapid.json·openclaw-device*.json 사본을 0600 으로 둔다", async () => {});
it("같은 초에 두 번 돌려도 서로 덮지 않는다(두 번째는 -1 접미사)", async () => {});
it("keep 을 넘치면 오래된 것부터 지운다(기본 7)", async () => {});
it("DB 가 없으면 사유와 함께 던지고 부분 디렉터리를 남기지 않는다", async () => {});
it("사본 파일에 WAL·SHM 이 따라가지 않는다(단일 파일)", async () => {});
```

각 테스트는 `mkdtemp` 임시 디렉터리만 쓴다. 저장소 `data/` 를 건드리지 않는다.

- [ ] **Step 2: 구현**

```ts
// apps/server/src/backup.ts — 스펙 3.2. better-sqlite3 온라인 백업이라 서버를 멈추지 않는다
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const SIDE_FILES = ["vapid.json", "openclaw-device.json", "openclaw-device-dev.json"];

export async function runBackup(opts: { dataDir: string; dbPath?: string; keep?: number; now?: Date }) {
  const started = Date.now();
  const dbPath = opts.dbPath ?? join(opts.dataDir, "dodok.sqlite");
  if (!existsSync(dbPath)) throw new Error(`백업할 DB 가 없다: ${dbPath}`);
  const root = join(opts.dataDir, "backups");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  let dir = join(root, stamp);
  for (let n = 1; existsSync(dir); n++) dir = join(root, `${stamp}-${n}`);
  mkdirSync(dir, { mode: 0o700 });
  try {
    const src = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      await src.backup(join(dir, "dodok.sqlite"));
    } finally {
      src.close();
    }
    chmodSync(join(dir, "dodok.sqlite"), 0o600);
    for (const f of SIDE_FILES) {
      const p = join(opts.dataDir, f);
      if (existsSync(p)) {
        copyFileSync(p, join(dir, f));
        chmodSync(join(dir, f), 0o600);
      }
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const keep = opts.keep ?? 7;
  const all = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort();
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const d of removed) rmSync(join(root, d), { recursive: true, force: true });
  return { dir, dbBytes: statSync(join(dir, "dodok.sqlite")).size, ms: Date.now() - started, removed };
}
```

```ts
// apps/server/src/backup-main.ts — CLI: node dist/backup.js [--keep N]
import { runBackup } from "./backup";

const i = process.argv.indexOf("--keep");
const keep = i >= 0 ? Number(process.argv[i + 1]) : undefined;
if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
  console.error("백업 실패: --keep 은 1 이상의 정수");
  process.exit(1);
}
const dataDir = process.env.DATA_DIR || "/data";
try {
  const r = await runBackup({ dataDir, ...(process.env.DB_PATH ? { dbPath: process.env.DB_PATH } : {}), ...(keep ? { keep } : {}) });
  console.log(`백업 완료: ${r.dir} (${r.dbBytes} bytes, ${r.ms} ms, 지움 ${r.removed.length})`);
} catch (err) {
  console.error(`백업 실패: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
```

복원은 코드가 아니라 절차다(스펙 3.3) — 태스크 4 가 실물로 잰다. 복원 절차의 「WAL·SHM 지우기」가 빠지면 복원본이 덮인다는 것을 태스크 4 가 재현해 문서 근거로 남긴다.

- [ ] **Step 3: 번들 엔트리 추가·확인** — `build.mjs` `entryPoints` 에 `backup: "src/backup-main.ts"`. `pnpm -F @dodok/server build` 뒤 임시 디렉터리에서 `DATA_DIR=<tmp> node dist/backup.js` 가 DB 없음으로 exit 1·한 줄, DB 를 만든 뒤 exit 0.

- [ ] **Step 4: 통과 확인·커밋** — `feat(server): 온라인 백업 명령`

---

### Task 3: 이미지·Compose·Caddy

**Files:**
- Create: `.dockerignore`, `infra/Dockerfile.server`, `infra/Dockerfile.web`, `infra/Caddyfile`, `infra/compose.yml`, `infra/compose.local.yml`, `infra/local.env.example`, `infra/check-caddy.sh`
- Modify: `apps/server/scripts/dev-fake.ts`(`DEV_FAKE_HOST`), 그 테스트, `.env.example`(배포 절)

**Interfaces:**
- Consumes: 태스크 1·2 의 `pnpm -F @dodok/server build` → `dist/main.js`·`dist/backup.js`, `DODOK_MIGRATIONS_DIR`
- Produces: 서비스 `app`·`caddy`, 볼륨 `dodok-data`·`caddy-data`·`caddy-config`, 빌드 타깃 `runtime`·`devfake`, 로컬 검증 명령(아래 Step 7)

- [ ] **Step 1: `.dockerignore`**

```
.git
**/node_modules
**/dist
data
.env
.env.*
!.env.example
.worktrees
.superpowers
.claude
.turbo
.idea
.vscode
*.tgz
.playwright-mcp
```

- [ ] **Step 2: `infra/Dockerfile.server`**

```dockerfile
# 스펙 2.1 — build: 워크스페이스 설치·번들 / runtime: 번들 + lockfile 의 운영 의존성 / devfake: 로컬 검증 전용(운영 이미지 아님)
FROM node:24.21.0-bookworm AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@11.16.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile --filter @dodok/server... --filter @dodok/web...
RUN pnpm -F @dodok/server build
# 운영 의존성만 담은 배치 — lockfile 기준(Global Constraints). 방법은 Step 2 확인에서 실측으로 고른다
RUN pnpm --filter @dodok/server deploy --prod /deploy

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=3000 DODOK_MIGRATIONS_DIR=/app/drizzle
WORKDIR /app
COPY --from=build --chown=node:node /deploy/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/server/dist ./dist
COPY --from=build --chown=node:node /repo/apps/server/drizzle ./drizzle
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM build AS devfake
ENV HOST=0.0.0.0 DEV_FAKE_HOST=0.0.0.0 PORT=3000
WORKDIR /repo
CMD ["pnpm", "-F", "@dodok/server", "dev:fake", "--keep"]
```

**Step 2 확인(관문)**: `docker build -f infra/Dockerfile.server --target runtime .` 가 되는지. `pnpm deploy --prod` 가 pnpm 11 에서 워크스페이스 옵션(예: `inject-workspace-packages`·`--legacy`)을 요구하면 그 옵션을 쓰고, 안 되면 대안(`pnpm install --prod --frozen-lockfile --filter @dodok/server` 뒤 `apps/server/node_modules` + 루트 `.pnpm` 저장소 복사) 중 **이미지가 작고 lockfile 을 따르는 쪽**을 골라 까닭을 보고서에. 운영 이미지에서 번들 external 의존성이 전부 풀리는지 `docker run --rm <img> node -e "import('better-sqlite3')…"` 로 확인. better-sqlite3 prebuild 가 없어 빌드가 필요하면 build 단계(bookworm 전체 이미지)에서 컴파일되고 runtime(slim, 같은 glibc)에서 돈다.

- [ ] **Step 3: `infra/Dockerfile.web`·`infra/Caddyfile`**

```dockerfile
# 스펙 2.2 — 웹 빌드 산출물을 Caddy 에 굽는다
FROM node:24.21.0-bookworm AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@11.16.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile --filter @dodok/web...
RUN pnpm -F @dodok/web build

FROM caddy:<2.x 정확 태그> AS web
COPY --from=build /repo/apps/web/dist /srv
COPY infra/Caddyfile /etc/caddy/Caddyfile
```

Caddyfile 은 스펙 2.3 코드 그대로에 둘을 더한다: 전역 옵션 블록 `{ {$CADDY_GLOBAL} }` 대신 로컬은 `compose.local.yml` 이 `CADDY_LOCAL_CERTS=local_certs` 를 넘길 수 있게 **전역 블록을 환경변수 자리로** 둔다(Caddy 는 `{$VAR}` 를 전역 블록 안에서도 치환한다 — 실측으로 확인하고 안 되면 로컬 전용 Caddyfile 을 `compose.local.yml` 에서 마운트). `@nocache` 에 실제 빌드 산출물 이름을 대조해(`dist/` 목록) `registerSW.js` 가 없으면 뺀다. CSP 는 **넣지 않는다**(스펙 2.3·11장 — 로컬 검증에서 `Content-Security-Policy-Report-Only` 로 한 번 재 보고 결과만 보고서에).

- [ ] **Step 4: `infra/compose.yml`·`compose.local.yml`·`local.env.example`**

```yaml
# infra/compose.yml — 운영(스펙 2.4). 실행: docker compose -f infra/compose.yml up -d --build (저장소 루트에서)
name: dodok
services:
  app:
    build: { context: .., dockerfile: infra/Dockerfile.server, target: runtime }
    env_file: ../.env
    volumes: [dodok-data:/data]
    expose: ["3000"]
    restart: unless-stopped
  caddy:
    build: { context: .., dockerfile: infra/Dockerfile.web }
    environment:
      DODOK_DOMAIN: ${DODOK_DOMAIN:?DODOK_DOMAIN 이 필요하다}
    ports: ["80:80", "443:443", "443:443/udp"]
    volumes: [caddy-data:/data, caddy-config:/config]
    depends_on: { app: { condition: service_healthy } }
    restart: unless-stopped
volumes:
  dodok-data:
  caddy-data:
  caddy-config:
```

(`DODOK_DOMAIN` 은 compose 가 루트 `.env` 를 변수 치환용으로 읽지 않으므로 — compose 는 **프로젝트 디렉터리(infra/)** 의 `.env` 를 읽는다 — 배포 문서가 `--env-file .env` 를 붙이게 하거나 `infra/.env` 심볼릭 링크를 권한다. 어느 쪽인지 실측으로 정해 compose 파일 머리 주석과 태스크 5 문서에 적는다.)

```yaml
# infra/compose.local.yml — 이 Mac 의 로컬 검증 전용(스펙 9장). 8443 만 연다
services:
  app:
    env_file: !override [./local.env]
  caddy:
    environment:
      DODOK_DOMAIN: localhost
      CADDY_LOCAL_CERTS: local_certs
    ports: !override ["8443:443"]
  devfake:
    profiles: [devfake]
    build: { context: .., dockerfile: infra/Dockerfile.server, target: devfake }
    environment: { APP_ORIGIN: "https://localhost:8443" }
    volumes: [devfake-data:/repo/data]
    expose: ["3000"]
volumes:
  devfake-data:
```

`local.env.example`: 로컬 검증용 **가짜** 값(`APP_ORIGIN=https://localhost:8443`, `TRUST_PROXY=true`, 닿지 않는 `OPENCLAW_GATEWAY_URL=ws://host.invalid:9`, 토큰은 `openssl rand -hex 32` 로 만들라는 주석과 빈 자리). 실제 `infra/local.env` 는 `.gitignore`(`.env.*` 규칙에 안 걸리므로 `infra/local.env` 줄을 더한다). devfake 모드에서 Caddy 가 `app` 대신 `devfake` 로 프록시하게 하는 방법(Caddy 의 upstream 을 `{$DODOK_UPSTREAM:app:3000}` 로)도 이 단계에서 넣는다.

- [ ] **Step 5: dev-fake 리슨 주소**

`dev-fake.ts:507` 의 `host: "127.0.0.1"` 와 `loadConfig({ HOST: "127.0.0.1" … })` 를 `env.DEV_FAKE_HOST || "127.0.0.1"` 로(진입점 옵션에 `host` 추가). 테스트: 옵션을 안 주면 127.0.0.1(기존), 주면 그 값. 플러그인이 붙는 `app.url` 이 `0.0.0.0` 이면 가짜 플러그인 접속 주소는 `127.0.0.1` 로 바꿔 쓴다.

- [ ] **Step 6: `.env.example` 배포 절** — `DODOK_DOMAIN`(Caddy 가 인증서를 받을 도메인), 「컨테이너에서는 `HOST`·`PORT`·`DATA_DIR`·`DODOK_MIGRATIONS_DIR` 를 이미지가 정한다 — `.env` 에 두면 덮는다」, `TRUST_PROXY=true`, `APP_ORIGIN=https://<도메인>`, `BRIDGE_PUBLIC_URL=wss://<도메인>/bridge`.

- [ ] **Step 7: 빌드·기동 연기 확인** — `infra/local.env` 를 만들고(값은 셸 변수로 생성, 화면에 찍지 않는다)
```bash
docker compose -f infra/compose.yml -f infra/compose.local.yml up -d --build
docker compose -f infra/compose.yml -f infra/compose.local.yml ps   # 둘 다 healthy
bash infra/check-caddy.sh https://localhost:8443
```
`infra/check-caddy.sh`(검증 스크립트, 커밋) — `curl -sk` 로: `/healthz` 200 · `/` 200 HTML · `/c/00000000-0000-0000-0000-000000000000` 200 HTML(SPA) · `/api/v1/does-not-exist` 가 **JSON 404**(HTML 아님) · `/sw.js` `Cache-Control: no-cache` · `/assets/<빌드 파일 하나>` `immutable` · HSTS·nosniff 헤더. 각 줄 PASS/FAIL, 하나라도 FAIL 이면 exit 1. [Review Focus 2]
- 볼륨 소유자 [Review Focus 1]: `docker volume create dodok_dodok-data` 를 root 소유로 미리 만든 경우(`docker run --rm -v dodok_dodok-data:/data alpine chown root:root /data`)에 app 이 **권한 오류 한 줄**로 끝나는지 로그로 보고, 오류가 알아보기 어려우면 `main.ts` 부팅 초기에 `DATA_DIR` 쓰기 가능 검사(설정 오류 한 줄: 「DATA_DIR 에 쓸 수 없다: <경로> — 볼륨 소유자를 1000:1000 으로」)를 더하고 단위 테스트한다.
- 끝나면 `docker compose … down -v`, 이미지 크기 기록.

- [ ] **Step 8: 커밋** — `feat(infra): Docker 이미지·Compose·Caddy`(dev-fake 변경은 `feat(server): dev:fake 리슨 주소`로 나눠도 된다)

---

### Task 4: 로컬 Compose 검증 → 수정 → 재검증

워커(verify)가 한다. 코드를 고치지 않고 결함은 보고만 — 조율자가 수정 워커를 띄운다. 스펙 9장 합격 기준 1~11 + Review Focus 1~5.

띄우는 법: 운영 모드(`app` — 닿지 않는 Gateway, 사람 쪽 기능 전부)와 devfake 모드(`--profile devfake`, Caddy upstream 을 devfake 로 — 에이전트 스트리밍·카드·승인이 Caddy 의 WebSocket 을 지나는 것)를 **둘 다** 돈다. 브라우저는 Playwright(Chromium, headed 오프스크린 `--window-position=-2400,-2400`, `ignoreHTTPSErrors: true`, 알림 권한은 `grantPermissions`), 주소 `https://localhost:8443`.

| # | 확인 |
| --- | --- |
| 1 | 이미지 둘 빌드·크기. `docker run --rm <app 이미지> sh -c 'ls -a /app; find / -name ".env*" -not -path "/proc/*" 2>/dev/null'` — `.env` 0, 소스 TS 0 |
| 2 | healthy 둘, `lsof -iTCP -sTCP:LISTEN` 에 3000 류 없음(8443 만) |
| 3 | `infra/check-caddy.sh` PASS |
| 4 | 로그인 → 채널 → 메시지 → (devfake) 스트리밍 답·카드·승인 · 첨부 19 MiB 업로드·내려받기 sha256 일치 · **21 MiB 는 서버 고정 문구**(Caddy 413 아님) [RF3] |
| 5 | wire 가 붙고 재연결 반복 없음(콘솔·서버 로그) |
| 6 | SW 등록·매니페스트·푸시 켜기(구독 행) — FCM 수신은 필수 아님(보면 기록) |
| 7 | 캐시 헤더·SPA 깊은 경로 새로고침·없는 API JSON 404 [RF2] |
| 8 | `down && up -d` 뒤 메시지·첨부·구독·`vapid.json` 공개키 유지 |
| 9 | 메시지를 보내는 루프를 돌리며 `exec app node dist/backup.js` → 사본 `integrity_check` ok [RF5] → 스펙 3.3 복원(WAL·SHM 지우기 포함) → 데이터 복귀. **WAL·SHM 을 안 지우면 어떻게 되는지**도 한 번 재서 문서 근거로 |
| 10 | 로그인 레이트리밋 키가 실제 클라이언트 IP 인가 — `X-Forwarded-For` 를 서로 다르게 보내는 두 클라이언트(curl)로 한쪽을 한도까지 틀리게 해도 다른 쪽은 로그인된다. `TRUST_PROXY=false` 로 바꾸면 둘이 같이 막히는지(대조) [RF4] |
| 11 | 볼륨 소유자 root 재현 → 오류 한 줄 [RF1] |
| 12 | 로그·이미지 시크릿 0(`grep -c -F`), 정리(`down -v`, 볼륨·이미지 목록, 포트 LISTEN 0, 5173·3000 그대로) |

결함은 심각도·파일:줄 → 수정 워커 → 범위 재검증 → 결함 0.

---

### Task 5: 문서

- **`docs/guides/deploy.md`**(새): 스펙 4장 체크리스트 1~7 을 그대로 명령으로(시크릿을 찍지 않는 꼴), 3.2~3.4 백업·복원·업데이트·되돌리기(태스크 4 가 잰 WAL·SHM 근거), 5장 오류 표, `.env` 항목 표, compose `--env-file`/`infra/.env` 결정(태스크 3), 로컬 검증 명령(`compose.local.yml`), 「사람이 한 번 따라 한 결과」 절(빈 표 — 실제 배포 뒤 채운다).
- `docs/project-structure.md`: `infra/`(이제 있다 — 1장 트리의 「없는 경로」 이월 닫기), 서버 `scripts/build.mjs`·`bundle-smoke.mjs`·`src/runtime.ts`·`backup*.ts`.
- `docs/plan.md`: 8장 Phase 3 「Docker Compose 패키징」 완료 표시·확인 방법, 이월에서 「`infra/` 가 없는데 두 문서가 있다고 말한다」 제거, 4.5·기술 표의 `--profile gateway` 를 「뺐다(스펙 결정 5)」로, 새 이월(스펙 11장), 머리 버전 +0.01.
- 스펙 끝 「구현과 맞춘 것」 장·상태 줄.
- `CLAUDE.md` 는 조율자가 고친다(명령 줄의 `docker compose …` 를 실제 명령으로).

---

## Self-Review (계획 작성 때 한 것)

- **스펙 적용 범위**: 결정 1(Caddy 자동 HTTPS — 태스크 3 Caddyfile·5 문서)·2(번들 — 1, Caddy 정적 — 3)·3(서비스 둘·포트 — 3·4)·4(호스트 빌드 — 3·5)·5(gateway 프로필 제외 — 5 문서)·6(로컬 검증·사람 절차 — 4·5)·7(`.env` — 3·5). 2.1 → 1·3, 2.2·2.3·2.4 → 3, 2.5 → 3 Step 6·5, 3장 → 2·4·5, 4장 → 5, 5장 → 3·4·5, 6장 → 3·4, 7장 → 1·2·3, 8장 → 1·2, 9장 → 4, 10장 → 4·5, 11장 → 5.
- **스펙과 다르게 정한 것**: (1) 로컬 검증의 에이전트 경로는 dev:fake 를 **별도 빌드 타깃**(`devfake`)으로 돌린다 — 스펙 9장이 계획에 맡긴 선택, 운영 이미지에 개발 진입점을 넣지 않는다. (2) CSP 는 넣지 않고 Report-Only 로 한 번 재기만 한다 — 스펙 2.3 이 계획에 맡긴 판단, 서비스 워커·인라인 스타일 충돌을 실측 없이 켜면 앱이 깨질 위험이 더 크다. (3) `DATA_DIR` 쓰기 검사는 Review Focus 1 이 재현될 때만 더한다.
- **자리표시 검사**: `caddy:<2.x 정확 태그>` 는 태스크 3 이 실측으로 고르도록 명시한 값이다(Global Constraints). external 목록·`pnpm deploy` 옵션도 관문 단계의 실측 결과로 채우도록 판정 조건을 적었다.
- **타입 일관**: `isBundled`·`migrationsFolder`·`runBackup`·`DODOK_MIGRATIONS_DIR`·`dist/backup.js`·`DEV_FAKE_HOST` 가 태스크 1·2·3·4 에서 같은 이름.
- **Review Focus** 다섯 → 3·4(1), 3·4(2), 4(3), 4(4), 2·4(5).
