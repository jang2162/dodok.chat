# Phase 3 ② 설정 마법사(연결 점검·브리지 토큰) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`CLAUDE.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나.

**Goal:** 웹 「연결」 페이지에서 Gateway·페어링·플러그인·브리지 상태와 다음 할 일을 보고, 서버가 품은 플러그인을 받고, 브리지 토큰을 발급·겹침 교체·폐기한다.

**Architecture:** 브리지 토큰은 새 테이블 `bridge_tokens`(해시만)로 옮기고, 어댑터의 브리지 인증을 「토큰 한 개」에서 「검증 함수」로 바꿔 소켓(`/bridge`)과 첨부 HTTP 가 같은 함수를 쓴다. 새 서버 모듈 `setup` 이 어댑터의 상세 상태·플러그인 파일 정보·토큰을 모아 owner 전용 API 와 wire `setup.status` 로 내고, 웹 `features/setup/` 이 그린다. 플러그인은 hello 에 자기 번들 sha256 을 실어 서버가 품은 파일과 같은 빌드인지 가른다.

**Tech Stack:** Fastify 5 · Socket.IO 4.8 · drizzle-orm 0.45 + better-sqlite3 · zod 4 · React 19 + TanStack Router/Query · Node 24 `crypto`(`randomBytes`·`createHash`·`timingSafeEqual`) — **새 의존성 없음**

**Spec:** `docs/superpowers/specs/2026-09-24-setup-wizard-design.md` — 결정 0장, 구조 2장, API 3장, 페이지 4장, 보안 5장, 오류 6장, 테스트 7장. **태스크를 시작하기 전에 스펙의 해당 장을 읽는다.**

## Global Constraints

- **새 npm 의존성은 없다.**
- **토큰 원문은 발급 응답에만 있다** — DB(해시만)·로그·목록·wire·오프라인 사본·서비스 워커 어디에도 없다. 발급 응답 `Cache-Control: no-store`.
- 원문 형식 `dbt_` + `randomBytes(32).toString("base64url")`, 해시 `sha256(원문)` hex, `prefix` = 원문의 `dbt_` 뒤 6자. 비교는 해시 버퍼끼리 `timingSafeEqual`.
- **setup API 는 owner 세션만**(`memberships.role = "owner"`), 아니면 403. 경로는 `/api/v1/setup/...`.
- `.env` 의 `BRIDGE_TOKEN` 은 **선택**이 된다(있으면 16자 이상). 테이블이 비었을 때만 라벨 `env` 로 한 번 이어받는다. 다르면 무시하고 warn 한 줄.
- Gateway URL·토큰은 `.env` 그대로 — 화면·API 에는 **호스트만**(자격 증명·경로·쿼리 없음), Gateway 토큰은 어디에도 없다.
- 시크릿 규칙은 `docs/guides/live-smoke.md` 2절. 5173·3000 금지(웹 확인은 5180, dev:fake 는 3100 류).
- **Docker 정리 규칙**: `docker … prune`(image·volume·system·builder) 금지 — 자기가 만든 것만 이름·ID 로 지운다. 다른 compose 프로젝트는 읽기만. 시작·끝 스냅숏 대조.
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프. 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 **자기 실행 출력에서** 패키지별로.

## Review Focus

1. **`.env` 의 BRIDGE_TOKEN 을 고쳐 교체하려는 사람** — 이어받은 뒤 `.env` 를 바꾸고 재시작해도 새 값은 통하지 않는다. 사람은 「왜 안 붙지?」가 아니라 화면·로그의 「.env 의 BRIDGE_TOKEN 은 더 이상 쓰지 않습니다 — 연결 페이지에서 발급하세요」를 봐야 한다. → 태스크 3(warn·`envTokenIgnored`)·5(문구).
2. **폐기된 토큰으로 계속 재접속하는 플러그인** — 로그가 재접속마다 쌓이면 안 된다. 거절 로그는 원격 주소별 1분에 한 번. → 태스크 2.
3. **발급 원문을 다시 보려는 사람** — 새로고침·뒤로 가기·오프라인 사본·서비스 워커 어디에서도 원문이 되살아나지 않는다(쿼리 캐시에 남기지 않는다). → 태스크 3(`no-store`)·5(캐시 단언).
4. **owner 가 아닌 사용자**(Phase 4 대비) — API 403, 사이드바 진입점 없음, `setup.status` 이벤트를 받지 않는다. → 태스크 3·5.
5. **옛 빌드·다른 빌드 플러그인** — `bundleSha256` 이 없으면 「빌드를 알 수 없습니다」, 다르면 「다른 빌드입니다 — 받아서 다시 설치」. 같은 빌드인데 다르게 보이면 안 된다(서버가 비교하는 값은 tgz 전체가 아니라 **안의 번들 파일** sha256). → 태스크 1·3.

---

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `packages/shared/src/setup/index.ts`·`bridge/index.ts`·`wire/index.ts` | 1 | 계약 |
| `packages/openclaw-plugin/src/bundle-hash.ts`·`channel.ts` | 1 | hello `bundleSha256` |
| `packages/openclaw-adapter/src/bridge/{server,session}.ts`·`gateway/connection-manager.ts`·`openclaw-adapter.ts`·`adapter-types.ts`·`fake-adapter.ts` | 2 | 검증 함수·세션 토큰 id·폐기 끊기·상세 상태 |
| `apps/server/src/db/schema.sqlite.ts`·`drizzle/0004_*.sql` | 3 | `bridge_tokens` |
| `apps/server/src/modules/setup/{tokens,status,plugin-file,routes}.ts` | 3 | 토큰·상태·파일·API |
| `apps/server/src/{config,app}.ts`·`modules/attachments/routes.ts`·`realtime/events.ts` | 3 | 배선 |
| `infra/Dockerfile.server` | 4 | 플러그인 tgz 를 품는다 |
| `apps/web/src/features/setup/*`·`app/router.tsx`·`app/layout/{Sidebar,Banners}.tsx`·`pwa/persist.ts`·`realtime/handlers.ts` | 5 | 연결 페이지 |
| `apps/server/scripts/dev-fake.ts` | 6 | 가짜 플러그인 토큰 바꾸기 훅 |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 shared 계약 + 플러그인 해시 | — |
| B | 2 어댑터 | 1 |
| C | 3 서버 setup 모듈 | 2 |
| D | 4 서버 이미지 플러그인 ‖ 5 웹 연결 페이지 | 3 |
| E | 6 dev:fake 훅 + 브라우저 검증 | 5 |
| F | 7 실연(dev Gateway, 모델 런 0) + Compose 확인 | 4·6 |
| G | 8 문서 | 7 |

---

### Task 1: shared 계약 + 플러그인 번들 해시

**Files:**
- Create: `packages/shared/src/setup/index.ts`(+ `src/index.ts` export), `packages/shared/test/setup.test.ts`, `packages/openclaw-plugin/src/bundle-hash.ts`, `packages/openclaw-plugin/test/bundle-hash.test.ts`
- Modify: `packages/shared/src/bridge/index.ts`(`BridgeHello.bundleSha256`), `packages/shared/src/wire/index.ts`(`setup.status`), `packages/shared/test/wire.test-d.ts`, `packages/openclaw-plugin/src/channel.ts:348`

**Interfaces:**
- Produces (shared):
  - `Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/)`
  - `BridgeHello.bundleSha256: Sha256Hex.optional()`
  - `BridgeTokenRecord = z.object({ id: Id, label: z.string().min(1).max(60), prefix: z.string().length(6), createdAt: IsoDateTime, lastUsedAt: IsoDateTime.nullable(), revokedAt: IsoDateTime.nullable(), connected: z.boolean() })`
  - `IssueBridgeTokenInput = z.object({ label: z.string().trim().min(1).max(60) })`
  - `IssueBridgeTokenResult = z.object({ token: z.string().regex(/^dbt_[A-Za-z0-9_-]{43}$/), record: BridgeTokenRecord, pluginConfig: z.unknown() })`
  - `SetupStatus` — 스펙 3장 꼴 그대로(zod)
  - wire `ServerToClientEvents["setup.status"]: (p: { status: SetupStatus }) => void`
- Produces (plugin): `computeBundleSha256(fileUrl: string, read?: (p: string) => Buffer): string | undefined`

- [ ] **Step 1: shared 테스트(실패)** — `Sha256Hex` 63·65자·대문자 거부, `IssueBridgeTokenInput` 공백만·61자 거부, `IssueBridgeTokenResult.token` 형식, `SetupStatus` 의 `pluginFile` 두 갈래·`gateway.pairing` null, `BridgeHello` 가 `bundleSha256` 없이도·있어도 통과.
- [ ] **Step 2: 구현** — Interfaces 그대로. `wire.test-d.ts` 이벤트 이름 목록에 `setup.status`.
- [ ] **Step 3: 플러그인 테스트(실패)**

```ts
// packages/openclaw-plugin/test/bundle-hash.test.ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeBundleSha256 } from "../src/bundle-hash";

describe("computeBundleSha256", () => {
  it("파일 내용의 sha256(hex)", () => {
    const bytes = Buffer.from("bundle");
    expect(computeBundleSha256("file:///x/index.js", () => bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
  it("읽기 실패면 undefined(hello 에서 필드를 뺀다)", () => {
    expect(computeBundleSha256("file:///x/index.js", () => { throw new Error("ENOENT"); })).toBeUndefined();
  });
  it("file: 이 아닌 URL 이면 undefined", () => {
    expect(computeBundleSha256("https://x/index.js", () => Buffer.alloc(0))).toBeUndefined();
  });
});
```

- [ ] **Step 4: 구현**

```ts
// packages/openclaw-plugin/src/bundle-hash.ts — 설정 마법사 스펙 결정 5: 서버가 품은 파일과 같은 빌드인지 가른다
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function computeBundleSha256(fileUrl: string, read: (p: string) => Buffer = readFileSync): string | undefined {
  try {
    if (!fileUrl.startsWith("file:")) return undefined;
    return createHash("sha256").update(read(fileURLToPath(fileUrl))).digest("hex");
  } catch {
    return undefined;
  }
}
```

`channel.ts` 모듈 스코프에서 `const BUNDLE_SHA256 = computeBundleSha256(import.meta.url);` 하고 hello 에 `...(BUNDLE_SHA256 ? { bundleSha256: BUNDLE_SHA256 } : {})`. 번들에서 `import.meta.url` 은 번들 파일 자신이다(esbuild ESM) — 플러그인 빌드 뒤 `node -e` 로 번들을 import 하지 말고, 빌드 산출물의 sha256 과 `computeBundleSha256(pathToFileURL(dist/index.js))` 가 같은지 확인해 보고서에(ADR 0004 — 세대마다 복사 경로가 달라도 내용은 같다).

- [ ] **Step 5: 통과·커밋** — `feat(shared,plugin): 설정 계약과 플러그인 번들 해시`

---

### Task 2: 어댑터 — 검증 함수·세션 토큰 id·폐기 끊기·상세 상태

**Files:**
- Modify: `packages/openclaw-adapter/src/bridge/server.ts`(옵션·`namespace.use`), `bridge/session.ts`(`tokenId`), `gateway/connection-manager.ts`(페어링·버전 상태), `openclaw-adapter.ts`(옵션·`setupDetail`·`revokeBridgeSessions`), `adapter-types.ts`, `fake-adapter.ts`, 테스트

**Interfaces:**
- Consumes: 태스크 1 `BridgeHello.bundleSha256`
- Produces:
  - `type BridgeTokenVerifier = (presented: unknown) => { tokenId: string } | null`
  - `BridgeServerOptions.verifyToken: BridgeTokenVerifier`(옛 `token: string` 제거). 기존 `verifyBridgeToken(expected, provided)` 헬퍼는 **남긴다**(테스트·가짜에서 쓴다)
  - `BridgeSessionState.tokenId: string | null`
  - `AgentAdapter.setupDetail(): AdapterSetupDetail` — `{ gateway: { state, host, version: string|null, pairing: { requestId: string; since: string } | null }, bridge: { state, plugin: { version, sdkVersion, gatewayVersion: string|null, bundleSha256: string|null, tokenId: string|null, connectedAt: string } | null } }`
  - `AgentAdapter.revokeBridgeSessions(tokenId: string): number`(끊은 수)
  - 어댑터 이벤트 `{ kind: "setup" }` — setupDetail 이 바뀔 때(페어링 시작·해소, 플러그인 hello·끊김) 한 번

- [ ] **Step 1: 테스트(실패)**
  - 검증 함수가 `{ tokenId: "t1" }` 을 주면 접속, `null` 이면 `UNAUTHORIZED`. hello 뒤 `setupDetail().bridge.plugin.tokenId === "t1"`, `bundleSha256` 이 hello 값.
  - `revokeBridgeSessions("t1")` → 그 소켓 끊김·반환 1, 다른 토큰 세션은 그대로.
  - **[Review Focus 2]** 같은 주소에서 거절이 10번 와도 `onRejected` 로그는 1분에 1번(가짜 시계).
  - 페어링 오류(`GatewayPairingRequiredError`) → `setupDetail().gateway.pairing.requestId`, 다음 성공 접속 → `pairing: null`, `version` 이 hello 의 `server.version`. `host` 는 URL 호스트만(`wss://u:p@gw.example:443/path?x` → `gw.example:443`).
  - 각 변화마다 `{ kind: "setup" }` 이벤트 1회.
- [ ] **Step 2: 구현 요점** — `namespace.use` 에서 `const r = opts.verifyToken(token); if (r) { socket.data.tokenId = r.tokenId; return next(); }`, 세션 생성 때 `socket.data.tokenId` 를 세션에. 거절 로그 스로틀은 `Map<address, lastMs>`(최대 256개, 오래된 것부터 지움). connection-manager 는 페어링 오류 때 `pairing = { requestId, since }`(이미 같은 requestId 면 since 유지), 성공 때 null·`version` 저장, 상태 콜백에 실어 어댑터로. `fake-adapter.ts` 는 두 메서드를 단순 구현(테스트가 상세를 주입할 수 있게).
- [ ] **Step 3: 통과·커밋** — `feat(adapter): 브리지 토큰 검증 함수·세션 토큰 id·상세 상태`

---

### Task 3: 서버 setup 모듈

**Files:**
- Modify: `apps/server/src/db/schema.sqlite.ts`, 새 마이그레이션(`pnpm -F @dodok/server db:generate`), `src/config.ts`(`BRIDGE_TOKEN` 선택), `src/app.ts`(어댑터 `verifyToken`·setup 라우트·이벤트), `src/modules/attachments/routes.ts:121`(`requireBridge` 가 같은 검증), `src/realtime/events.ts`(`setup.status` 를 owner 사용자 룸에), `src/auth/routes.ts:89`(`GET /api/v1/auth/me` 응답에 `role` — 그 워크스페이스 `memberships.role`)
- Create: `src/modules/setup/{tokens,status,plugin-file,routes}.ts`, 테스트 `test/setup.tokens.test.ts`·`setup.status.test.ts`·`setup.routes.test.ts`·`test/integration/setup.test.ts`

**Interfaces:**
- Consumes: 태스크 1 계약, 태스크 2 `verifyToken`·`setupDetail`·`revokeBridgeSessions`·`{kind:"setup"}`
- Produces:
  - `issueBridgeToken(db, workspaceId, label) → { token, record }` · `verifyBridgeTokenDb(db, presented) → { tokenId } | null` · `listBridgeTokens(db, workspaceId, connectedTokenId) → BridgeTokenRecord[]` · `revokeBridgeToken(db, workspaceId, id) → boolean` · `importEnvToken(db, workspaceId, envToken) → "imported" | "ignored" | "skipped"`
  - `readPluginFile(candidates: string[]) → { path, sha256, bundleSha256, bytes } | null`(tgz 안 `package/dist/index.js` 의 sha256 은 `tar` 없이 Node `zlib.gunzipSync` + tar 헤더 파싱 — 512바이트 블록, 작은 함수)
  - `buildSetupStatus({ detail, pluginFile, serverVersion, publicUrl, envTokenIgnored }) → SetupStatus`
  - 플러그인 파일 후보: `DODOK_PLUGIN_DIR`(이미지가 `/app/plugin`) → 소스 실행이면 `packages/openclaw-plugin/dist`
  - `requireOwner(ctx)` 프리핸들러
  - `GET /api/v1/auth/me` 응답에 `role: string`(지금 값은 `"owner"`·`"member"`) — 웹 `MeResponse` 타입(`apps/web/src/api/queries.ts:15`)도 같이

- [ ] **Step 1: 스키마·마이그레이션** — 스펙 2.2. `hash` unique. `db:generate` 로 만들고 SQL 을 보고서에.
- [ ] **Step 2: 토큰 테스트(실패)** — 형식(`/^dbt_[A-Za-z0-9_-]{43}$/`), DB 에 원문 없음(`SELECT *` 행 JSON 에 원문 부분 문자열 0), 검증 맞음·틀림·폐기됨·빈 값·비문자열, `lastUsedAt` 은 1분에 한 번만 갱신, **env 이어받기**: 빈 테이블 → `imported`(라벨 env), 같은 값 다시 → `skipped`, 다른 값 → `ignored` [Review Focus 1], 라벨 61자 거부.
- [ ] **Step 3: 구현** — 스펙 2.1. 해시 비교는 `timingSafeEqual(Buffer.from(a,"hex"), Buffer.from(b,"hex"))` 를 활성 행마다(활성 토큰은 소수라 전수 비교가 싸다 — 해시 인덱스로 먼저 찾고 한 번 비교해도 된다).
- [ ] **Step 4: 상태·파일 테스트(실패) → 구현** — `publicUrl` 유도(`BRIDGE_PUBLIC_URL` 우선, 없으면 `APP_ORIGIN` `https:`→`wss:`·`http:`→`ws:` + `/bridge`), `pluginMatches`: 파일 없음 또는 플러그인 없음 또는 `bundleSha256` 없음 → `null`, 같음 → `true`, 다름 → `false` [Review Focus 5 — 비교 대상은 tgz 가 아니라 안의 `dist/index.js`], `envTokenIgnored`, `readPluginFile` 은 실제로 만든 작은 tgz(테스트에서 tar 블록을 직접 만들어)로.
- [ ] **Step 5: 라우트·통합 테스트(실패) → 구현**
  - 스펙 3장 다섯. owner 가 아니면 403 [Review Focus 4](테스트에서 membership role 을 `member` 로 둔 두 번째 사용자).
  - 발급 응답 `Cache-Control: no-store` [Review Focus 3], 목록·상태·로그 캡처·wire 이벤트에 원문 0.
  - 통합(가짜 Gateway·플러그인): 토큰 A 로 붙은 플러그인 → B 발급 → 가짜 플러그인이 B 로 재접속 → 목록 `connected` 가 B → A 폐기 → A 로 재접속 거절, **첨부 HTTP 가 A 로 401·B 로 200**. 접속 중 토큰 폐기 → 세션 즉시 끊김. `setup.status` 이벤트가 owner 소켓에만.
  - 설정: `BRIDGE_TOKEN` 없이 부팅 → 활성 0, 브리지 접속 거절, 상태 정상. 있으면 이어받기, 다르면 부팅 warn 한 줄(`"BRIDGE_TOKEN in .env is ignored — manage bridge tokens in the connection page"`).
  - `setup.status` 는 어댑터 `{kind:"setup"}`·토큰 발급·폐기 때 보낸다.
- [ ] **Step 6: dev:fake 가 계속 도는지** — dev:fake 는 `BRIDGE_TOKEN: DEV_FAKE_BRIDGE_TOKEN` 을 넘긴다 → 이어받기 경로로 그대로 붙어야 한다. dev-fake 테스트 초록.
- [ ] **Step 7: 통과·커밋** — `feat(server): 설정 모듈 — 브리지 토큰·연결 상태·플러그인 파일`

---

### Task 4: 서버 이미지가 플러그인 tgz 를 품는다

**Files:** `infra/Dockerfile.server`, (필요하면) `apps/server/scripts/bundle-smoke.mjs`·`infra/check-caddy.sh` 한 줄

- [ ] **Step 1: 관문(실측)** — build 단계에서 `pnpm install --frozen-lockfile --filter @dodok/openclaw-plugin...` 가 `openclaw`(약 200 MB) 를 받는 시간·크기, `pack:plugin` 이 컨테이너 안(linux)에서 되는지. 되면 `COPY --from=build … packages/openclaw-plugin/dist/*.tgz /app/plugin/` + `ENV DODOK_PLUGIN_DIR=/app/plugin`. runtime 이미지 크기 변화를 보고서에(tgz 만 늘어야 한다). 빌드가 20분을 넘거나 실패하면 **멈추고 물어라**.
- [ ] **Step 2: 확인** — 로컬 Compose(Phase 3 ① 명령, `127.0.0.1:8443`)로 띄워 owner 로그인 → `GET /api/v1/setup/plugin.tgz` 의 sha256 = 이미지 안 파일 sha256 = 상태의 `pluginFile.sha256`, `bundleSha256` = tgz 안 `dist/index.js` sha256. **Docker 정리 규칙** 준수·스냅숏 대조.
- [ ] **Step 3: 커밋** — `feat(infra): 서버 이미지가 플러그인 파일을 품는다`

---

### Task 5: 웹 연결 페이지

**Files:**
- Create: `apps/web/src/features/setup/{ConnectionPage,IssueTokenDialog,TokenList,sections}.tsx`·`queries.ts`·`mutations.ts` + 테스트
- Modify: `apps/web/src/app/router.tsx`(`/settings/connection` — 기존 채널 `settings` 자식 라우트와 겹치지 않는 최상위 경로로; 실제 라우트 트리를 읽고 정한다), `app/layout/Sidebar.tsx`(owner 에게만 「연결」), `app/layout/Banners.tsx`(연결 배너에 「연결 설정 보기」 링크), `pwa/persist.ts`(`setup` 쿼리 제외), `realtime/handlers.ts`(`setup.status` → 쿼리 캐시), `api/queries.ts`(`qk.setupStatus`·`qk.bridgeTokens`)

**Interfaces:** Consumes 태스크 1 계약, 태스크 3 API, 태스크 3 이 더한 `me.role`(`useMe().data.role === "owner"`).

- [ ] **Step 1: 테스트(실패)**
  - 상태별 문구(스펙 4장 표): Gateway `down`·페어링 대기(명령 복사, 5분 넘으면 강조)·연결됨, 플러그인 없음·같은 빌드·다른 빌드·모름 [Review Focus 5], 토큰 0개, `envTokenIgnored` 한 줄 [Review Focus 1].
  - 발급: 라벨 → 원문·설정 조각 표시 → 「복사했습니다」 전에는 닫히지 않음 → 닫은 뒤 쿼리 캐시·DOM 어디에도 원문 없음 [Review Focus 3](`queryClient.getQueryCache().getAll()` JSON 에 `dbt_` 0).
  - 교체 안내: `setup.status` 로 접속 토큰이 바뀌면 옛 토큰 줄에 「이제 폐기해도 됩니다」.
  - 폐기: 접속 중이면 경고 확인, 활성 0개가 되면 두 번째 확인.
  - owner 아니면 사이드바 진입점 없음, 직접 주소로 오면 「권한이 없습니다」 [Review Focus 4].
  - 오프라인 사본에 setup 쿼리 없음.
- [ ] **Step 2: 구현** — 기존 설정 패널(`features/settings/Section.tsx`)·`ConfirmDialog`·복사 버튼 꼴을 따른다. 복사는 `navigator.clipboard.writeText`(실패하면 선택 가능한 텍스트로).
- [ ] **Step 3: 통과·커밋** — `feat(web): 연결 페이지 — 상태·플러그인 받기·브리지 토큰`

---

### Task 6: dev:fake 훅 + 브라우저 검증

- [ ] dev:fake 에 **개발 전용** 경로 `POST /__devfake/plugin-token { token }`(dev:fake 앱에만 등록, 운영 코드에 없음) → 가짜 플러그인을 그 토큰으로 다시 붙인다. 테스트 한 건.
- [ ] 브라우저 검증(verify 워커, Playwright headed 오프스크린, dev:fake 3100 + 웹 5180): 연결 페이지 상태 → 발급(원문 한 번) → 훅으로 가짜 플러그인 교체 → 「지금 접속 중」 이동·「폐기해도 됩니다」 → 옛 토큰 폐기 → 옛 토큰 재접속 거절(서버 로그) → 새로고침·뒤로 가기에 원문 없음 → 플러그인 받기(개발 모드면 안내 문구, `pack:plugin` 을 해 두면 받기·sha256 일치). 390px 도. 결함은 보고만 → 수정 워커 → 재검증.

---

### Task 7: 실연(dev Gateway, 모델 런 0) + Compose 확인

- [ ] live-smoke 2·3절 규칙. 서버가 품은(또는 `pack:plugin` 한) tgz 를 dev Gateway 에 설치 → 연결 페이지 「같은 빌드」 → 새 토큰 발급 → **dev 프로필** 플러그인 설정(`openclaw --dev config`)을 새 토큰으로 → Gateway 재기동 → 접속 이동 → 옛 토큰 폐기 → 에이전트가 계속 도는지(런 0회 하네스 11절로 메시지 경로만). 결과는 `docs/guides/live-smoke.md` 새 절.
- [ ] Compose 한 번: 태스크 4 확인을 다시(Docker 정리 규칙).

---

### Task 8: 문서

- `docs/guides/deploy.md`: 체크리스트 4·5 를 연결 페이지 흐름으로(플러그인 받기·토큰 발급·교체·폐기), `.env` 표의 `BRIDGE_TOKEN` 을 선택·이어받기로.
- `docs/project-structure.md`: 서버 `modules/setup/`, 웹 `features/setup/`, 플러그인 `bundle-hash.ts`.
- `docs/plan.md` 8장: Phase 3 「설정 마법사」 완료·확인 방법, 이월, 버전.
- 스펙 끝 「구현과 맞춘 것」·상태 줄. `CLAUDE.md` 는 조율자.

---

## Self-Review (계획 작성 때 한 것)

- **스펙 적용 범위**: 결정 1(태스크 3 — `.env` Gateway 그대로)·2(3 토큰·5 교체)·3(3 이어받기)·4(4 이미지·3 파일·5 받기)·5(1 해시·3 비교)·6(3 owner·5 진입점). 2.1→3, 2.2→3, 2.3→2, 2.4→1, 2.5→4, 2.6→1, 2.7→5, 3장→3, 4장→5, 5장→3·5, 6장→3·5, 7장→각 태스크·6·7, 8장→6·7.
- **스펙과 다르게 정한 것**: 없음. 세부로 정한 것: 거절 로그 스로틀(주소별 1분 — 스펙 5장이 「기존 레이트리밋」이라고만 했다, Review Focus 2), `lastUsedAt` 갱신 빈도 1분, tgz 안 번들 해시는 Node 로 직접(tar 의존성 없이), dev:fake 훅 경로.
- **자리표시 검사**: 웹 라우트 경로는 실제 라우트 트리를 읽고 정한다. owner 판별은 `me` 에 role 이 없어(`auth/routes.ts:89`) 태스크 3 이 더한다. 태스크 4 는 관문(빌드 시간·크기)으로.
- **타입 일관**: `BridgeTokenVerifier`·`setupDetail`·`revokeBridgeSessions`·`SetupStatus`·`BridgeTokenRecord.connected`·`bundleSha256` 이 1·2·3·5 에서 같은 이름.
- **Review Focus** 다섯 → 3·5(1), 2(2), 3·5(3), 3·5(4), 1·3·5(5).
