# 앱 컨테이너 하나 배포 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 Orca 워커가 이 계획을 태스크 순서대로 한 워크트리에서 실행한다.

**Goal:** Caddy 를 빼고 dodok 앱 컨테이너 하나(서버가 웹까지 냄)를 루트 `compose.yaml` 로 배포하고, 프록시는 서버마다 `compose.override.yaml` 로 붙이며, 배포 문서를 `docs/guides/docker-deploy.md` 하나로 다시 쓴다.

**Architecture:** 서버(Fastify)가 Caddyfile 이 하던 정적 웹·SPA 폴백·캐시·보안 헤더를 맡고, 클라이언트 IP 는 `TRUST_PROXY` 로 받은 믿는 프록시 목록으로 proxy-addr 가 판정한다(REST·소켓 같은 판정). 루트 다단계 `Dockerfile` 의 runtime 이미지가 서버 번들과 빌드된 웹을 함께 품는다. `infra/` 는 없어진다.

**Tech Stack:** Node 24.21 · Fastify 5.12.4 · proxy-addr · Docker Compose · pnpm 11.16

**Spec:** `docs/superpowers/specs/2026-10-20-app-only-docker-design.md` — 이 계획은 스펙의 결정을 옮긴다. 실행자는 둘 다 읽는다.

## Global Constraints

- compose 파일은 저장소 루트 `compose.yaml` 하나. 서비스는 `app` 하나. 저장소에 다른 compose·Caddyfile 을 두지 않는다(검증 프록시는 스크립트가 그때 만든다 — 스펙 3.7).
- 서버 덮어쓰기 파일 이름 `compose.override.yaml`, `.gitignore` 에 `/compose.override.yaml`. 저장소에 예시 파일 없음(내용은 문서).
- `TRUST_PROXY` 값: 비었거나 `false` → 아무도 안 믿음, IP·CIDR 쉼표 목록 → 그 주소만. `true` 는 부팅 실패(이유를 말한다).
- 캐시·보안 헤더 값은 지금 `infra/Caddyfile` 과 글자 그대로 같다: `/assets/*` 있는 파일 `public, max-age=31536000, immutable`, 나머지 `no-cache`, `nosniff`, `strict-origin-when-cross-origin`, CSP 문자열, HSTS `max-age=31536000` 은 `APP_ORIGIN` 이 https 일 때만.
- 백엔드 경로 `/api/* /socket.io/* /bridge/* /runner/* /hooks/* /mcp /healthz /llms.txt` 는 SPA 폴백을 타지 않는다.
- 웹 빌드 ID 는 웹 입력의 내용 해시(빌드 인자가 이긴다). 서버 소스만 바뀌면 그대로.
- 새 의존성은 정확 핀. Docker `prune` 금지, 만든 것만 이름으로 지운다. 커밋은 경로 명시 stage, Conventional Commits.
- `docs/superpowers/` 의 지난 스펙·계획과 `.superpowers/` 는 고치지 않는다. `.ruler/` 를 고치면 `pnpm exec ruler apply`.

## Review Focus

1. **경로 탈출** — `/..%2f..%2fetc/passwd`, `/%2e%2e/`, 백슬래시, NUL 이 든 경로가 웹 디렉터리 밖 파일을 내지 않는다(404 또는 index.html). → Task 2 테스트.
2. **IPv4-mapped 주소** — 컨테이너 연결 주소가 `::ffff:172.18.0.5` 로 와도 `TRUST_PROXY=172.18.0.5/32` 가 그 프록시를 믿는다. → Task 1 테스트.
3. **프록시가 덧붙인 XFF** — 클라이언트가 `X-Forwarded-For: 1.2.3.4` 를 꾸며 보내고 프록시가 `1.2.3.4, <진짜 IP>` 로 덧붙이면 앱이 고르는 주소는 진짜 IP(오른쪽부터 믿는 주소만 건너뜀). REST `request.ip` 와 소켓 주소가 같다. → Task 1 테스트.
4. **HEAD·비GET 과 폴백** — `POST /c/x` 는 index.html 이 아니라 404, `HEAD /` 는 200·본문 없음·같은 헤더. → Task 2 테스트.
5. **웹 디렉터리 없음** — `DODOK_WEB_DIR` 이 없거나 가리키는 곳에 `index.html` 이 없으면 정적 서빙을 끄고(개발), 있다고 했는데 없으면 부팅 로그 한 줄로 알린다 — 조용히 모든 경로가 JSON 404 가 되지 않게. → Task 2 테스트.

---

### Task 1: 믿는 프록시 목록으로 클라이언트 IP 판정

**Files:**
- Modify: `apps/server/src/config.ts` (TRUST_PROXY 스키마), `apps/server/src/app.ts:166-180, 238-262, 308, 806` (`bridgeClientAddress` → 새 함수, Fastify `trustProxy`)
- Create: `apps/server/src/http/client-address.ts`
- Modify: `apps/server/package.json` (`proxy-addr` 정확 핀 — lockfile 에 fastify 가 이미 끌어온 버전과 같게, 타입은 `@types/proxy-addr` devDependency 정확 핀)
- Modify: `TRUST_PROXY: "true"` 를 쓰는 테스트·스크립트 — `apps/server/test/app.request-log.test.ts`, `app.wiring.test.ts`, `integration/ops-ratelimit.test.ts`, `integration/setup.test.ts`, `apps/server/scripts/dev-fake.ts`(쓰면), `bundle-smoke.mjs`(쓰면)
- Test: `apps/server/test/client-address.test.ts`, `apps/server/test/config.test.ts`(있으면 거기, 없으면 새로)

**Interfaces:**
- Produces: `parseTrustProxy(raw: string | undefined): TrustProxy` — `type TrustProxy = { kind: "none" } | { kind: "list"; entries: string[] }`. `"true"` 는 `Error`(메시지에 「TRUST_PROXY=true 는 받지 않는다 — 프록시 주소를 IP·CIDR 로」). 잘못된 CIDR 도 `Error`.
- Produces: `fastifyTrustProxy(t: TrustProxy): boolean | string` — none → `false`, list → `entries.join(",")`.
- Produces: `clientAddressOf(t: TrustProxy): (h: { address: string; headers: Record<string, string | string[] | undefined> }) => string` — proxy-addr `compile(entries)` 로 `proxyaddr({ connection: { remoteAddress: h.address }, headers: h.headers }, trust)`. none → `h.address`.
- `config.TRUST_PROXY` 는 문자열 그대로 두고 `app.ts` 가 부팅 때 `parseTrustProxy` 를 한 번 부른다(부팅 실패 경로는 지금 config 오류와 같은 꼴).

- [ ] **Step 1: 실패하는 테스트**

`client-address.test.ts`:
- `parseTrustProxy(undefined)`·`("")`·`("false")` → `{kind:"none"}`; `("172.18.0.5/32, 10.0.0.1")` → `{kind:"list", entries:["172.18.0.5/32","10.0.0.1"]}`; `("true")` 던짐(메시지에 `TRUST_PROXY=true`); `("not-an-ip")` 던짐.
- 믿음 없음: `clientAddressOf(none)({address:"10.0.0.9", headers:{"x-forwarded-for":"1.2.3.4"}})` → `"10.0.0.9"`.
- 덧붙인 XFF(Review Focus 3): list `["172.18.0.5/32"]`, `{address:"172.18.0.5", xff:"1.2.3.4, 203.0.113.7"}` → `"203.0.113.7"`.
- 믿지 않는 이웃: list `["172.18.0.5/32"]`, `{address:"172.18.0.6", xff:"1.2.3.4"}` → `"172.18.0.6"`.
- IPv4-mapped(Review Focus 2): `{address:"::ffff:172.18.0.5", xff:"203.0.113.7"}` → `"203.0.113.7"`.

`app.wiring.test.ts` 의 기존 「TRUST_PROXY=true 면 …」 테스트를 `TRUST_PROXY: "127.0.0.1"`(inject 의 연결 주소)로 바꾸고, `bootTestApp({TRUST_PROXY:"true"})` 가 거절되는 테스트를 더한다. `setup.test.ts`·`ops-ratelimit.test.ts` 의 XFF 테스트는 덧붙인 XFF(`"1.2.3.4, 203.0.113.7"`)를 보내 오른쪽 값(`203.0.113.7`)이 핸드셰이크·첨부 HTTP 양쪽 주소인지로 바꾼다 — 지금의 「첫 값」 기대를 뒤집는 것이 이 태스크의 요점이다.

- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/server exec vitest run test/client-address.test.ts test/app.wiring.test.ts test/integration/setup.test.ts test/integration/ops-ratelimit.test.ts` → 새 테스트 FAIL.

- [ ] **Step 3: 구현** — `client-address.ts` 세 함수, `config.ts` 의 `TRUST_PROXY` 를 `z.string().optional()` 로(빈 값은 지금처럼 기본), `app.ts` 가 `parseTrustProxy` → `Fastify({ trustProxy: fastifyTrustProxy(t) })`, `bridgeClientAddress` 두 자리를 `clientAddressOf(t)` 로. `bridgeClientAddress` 는 지운다(호출자가 둘뿐). 주석의 `infra/Caddyfile` 언급을 걷는다. `.env.example` 13·55행의 `TRUST_PROXY` 설명을 「비우거나 false, 프록시 뒤면 그 프록시 주소 `/32`」로.

- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, 이어서 `pnpm -F @dodok/server test` 전체 PASS(실행 개수 기록) · `pnpm typecheck`.

- [ ] **Step 5: 커밋** — `feat(server): trust only listed proxies for the client address`

### Task 2: 서버가 웹을 낸다

**Files:**
- Create: `apps/server/src/http/web-static.ts`, `apps/server/scripts/precompress-web.mjs`
- Modify: `apps/server/src/config.ts` (`DODOK_WEB_DIR` 선택), `apps/server/src/app.ts` (등록 — 백엔드 라우트 뒤, `setNotFoundHandler` 로 폴백), `apps/server/src/runtime.ts`(부팅 로그 자리가 거기면)
- Test: `apps/server/test/web-static.test.ts`

**Interfaces:**
- Consumes: 없음(Task 1 과 독립).
- Produces: `registerWebStatic(fastify: FastifyInstance, opts: { webDir: string | undefined; httpsOrigin: boolean; logger: Logger }): { enabled: boolean }`.
- Produces: `SECURITY_HEADERS`(CSP 등 고정 값 객체 — 테스트가 Caddyfile 문자열과 견준다), `BACKEND_PREFIXES`.
- Produces: `node apps/server/scripts/precompress-web.mjs <dir>` — `<dir>` 안 `.js .css .html .svg .json .webmanifest .txt` 파일마다 `.br`·`.gz` 를 옆에 쓴다(이미 작으면 1 KiB 미만은 건너뜀). Task 3 의 Dockerfile 이 부른다.

동작(스펙 3.2 표 그대로):
- 보안 헤더는 `onSend` 훅으로 **모든** Fastify 응답에(JSON API 포함). HSTS 는 `httpsOrigin` 일 때만.
- `GET|HEAD /assets/*`: 파일이 있으면 그 파일 + immutable, 없으면 404(index.html 아님).
- 백엔드 접두는 지금 404 그대로.
- 그 밖 `GET|HEAD`: 파일이면 그 파일, 아니면 `index.html`, 둘 다 `no-cache`. GET·HEAD 가 아니면 지금 404.
- `Accept-Encoding` 에 `br`/`gzip` 이 있고 미리 압축한 파일이 있으면 그것을, `Content-Encoding`·`Vary: Accept-Encoding` 를 단다. `Content-Type` 은 원본 확장자로.
- 경로는 디코드 뒤 `path.resolve(webDir, "." + p)` 가 `webDir + sep` 로 시작할 때만, 디렉터리·심볼릭 링크 밖은 폴백.
- `webDir` 이 없으면 `{enabled:false}` 로 아무것도 안 함. 주어졌는데 `index.html` 이 없으면 `logger.error` 한 줄 + `{enabled:false}`.

- [ ] **Step 1: 실패하는 테스트** — 임시 디렉터리에 `index.html`·`assets/app-abc.js`(+ `.br`)·`sw.js` 를 만들고 `bootTestApp({ DODOK_WEB_DIR: dir })`:
  - `GET /` → 200, `text/html`, `cache-control: no-cache`, CSP 헤더가 Caddyfile 의 문자열과 같음, `x-content-type-options: nosniff`, `referrer-policy: strict-origin-when-cross-origin`, HSTS 없음(`APP_ORIGIN` http).
  - `APP_ORIGIN=https://x` 로 부팅하면 `strict-transport-security: max-age=31536000`.
  - `GET /c/abc` → index.html 200 no-cache. `GET /sw.js` → 파일, no-cache.
  - `GET /assets/app-abc.js` → `public, max-age=31536000, immutable`; `accept-encoding: br` 면 `content-encoding: br`·`vary` 포함. `GET /assets/none.js` → 404, immutable 없음.
  - `GET /api/v1/nope` → 지금 JSON 404(본문이 HTML 아님), CSP 헤더 있음. `GET /hooks/x`·`/mcp` GET 도 index.html 아님.
  - Review Focus 1: `/..%2f..%2fetc%2fpasswd`, `/%2e%2e/%2e%2e/etc/passwd`, `/assets/..%5c..%5cpackage.json`, `/a%00b` → 200 index.html 이거나 404, 본문에 웹 디렉터리 밖 파일 내용이 없다(밖에 `secret.txt` 를 두고 확인).
  - Review Focus 4: `POST /c/x` → 404 JSON. `HEAD /` → 200, 본문 0, `cache-control: no-cache`.
  - Review Focus 5: `DODOK_WEB_DIR` 없음 → `GET /` 404(지금 동작). 빈 디렉터리 → 로거에 error 한 줄, `GET /` 404.
  - `precompress-web.mjs` 를 임시 디렉터리에 돌리면 큰 `.js` 옆에 `.br`·`.gz` 가 생기고 풀면 원본과 같다.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/server exec vitest run test/web-static.test.ts` → FAIL.
- [ ] **Step 3: 구현** — 위 시그니처. 정적 파일은 `fs.createReadStream`/`reply.send(stream)`; MIME 은 작은 확장자 표(html, js, mjs, css, json, webmanifest, svg, png, jpg, jpeg, gif, webp, ico, woff2, txt, map — 나머지 `application/octet-stream`). 새 의존성 없이.
- [ ] **Step 4: 통과 확인** — 같은 테스트 PASS · `pnpm -F @dodok/server test` 전체 · `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`(번들이 새 파일을 품는지).
- [ ] **Step 5: 커밋** — `feat(server): serve the built web with the Caddy headers and cache rules`

### Task 3: 루트 Dockerfile·compose.yaml, infra/ 정리, 검사 스크립트

**Files:**
- Create: `Dockerfile`(루트 — `infra/Dockerfile.server` 의 build·deploy·plugin·runner·runtime·devfake 단계 + `infra/Dockerfile.web` 의 웹 빌드 단계 `web`), `compose.yaml`, `scripts/check-deploy.sh`
- Delete: `infra/` 전부(`git rm -r infra`)
- Modify: `.dockerignore`, `.gitignore`(`/compose.override.yaml` 추가, `infra/.env`·`infra/local.env`·`infra/compose.server.yml` 줄 제거), `apps/server/scripts/build.mjs`·`bundle-smoke.mjs`·`prune-runtime-deps.mjs` 와 그 테스트(`test/prune-runtime-deps.test.ts`·`test/runtime.test.ts`)의 `infra/Dockerfile.server` 언급을 `Dockerfile` 로
- Test: `scripts/check-deploy.sh` 실행 결과(아래)

**Interfaces:**
- Consumes: Task 1 의 `TRUST_PROXY` 목록 꼴, Task 2 의 `DODOK_WEB_DIR`·`precompress-web.mjs`.
- Produces: 이미지 안 `/app/web`(웹 산출물, 미리 압축 포함), compose `environment: DODOK_WEB_DIR: /app/web`.
- Produces: `bash scripts/check-deploy.sh app <origin>`(앱 직결 확인) · `bash scripts/check-deploy.sh proxy`(검증 프록시를 만들어 위조까지 재고 지운다). 끝에 `PASS n / FAIL n / SKIP n`, FAIL 이 있으면 종료 1.

`Dockerfile` 요점:
- `web` 단계는 지금 Dockerfile.web 의 build 단계 그대로(해시 입력 목록의 `infra/Dockerfile.web` → `Dockerfile`, `ARG VITE_BUILD_ID=`), 끝에 `node apps/server/scripts/precompress-web.mjs apps/web/dist`.
- runtime 에 `COPY --from=web --chown=node:node /repo/apps/web/dist ./web`, `ENV DODOK_WEB_DIR=/app/web`.
- fetch 층까지 줄이 같아 단계들이 캐시를 나눠 쓰게 한다(한 파일이니 같은 `build` 기반에서 갈라도 된다 — 빌더).

`compose.yaml` 요점(스펙 3.4): `name: dodok`, 서비스 `app` 만, `build: { context: ., target: runtime, args: { VITE_BUILD_ID: "${DODOK_WEB_BUILD_ID:-}" } }`, `pull_policy: build`, `env_file: ${DODOK_ENV_FILE:-.env}`, `environment:` 고정값(HOST·PORT·DATA_DIR·DODOK_MIGRATIONS_DIR·DODOK_PLUGIN_DIR·DODOK_RUNNER_DIR·DODOK_WEB_DIR — `TRUST_PROXY` 는 고정하지 않는다: 덮어쓰기·`.env` 가 정한다), `ports: ["127.0.0.1:${DODOK_HTTP_PORT:-3000}:3000"]`, 볼륨 `dodok-data:/data`, `restart`, `stop_grace_period: 15s`, 로그 로테이션, 머리 주석에 덮어쓰기 파일과 문서 가리킴. 필수 보간 변수 없음.

`check-deploy.sh` 가 옮겨 오는 확인(지금 `infra/check-caddy.sh` 에서 앱에 남는 것): `/healthz` 200, `/` 와 SPA 깊은 경로 index.html no-cache, `/assets/<실제 파일>` immutable·압축, 없는 청크 404, `/api/없는것` JSON 404, 보안 헤더 넷(https 오리진이면 HSTS), `/llms.txt` 200, Socket.IO 폴링 핸드셰이크 200, 웹훅 토큰 꼴 경로를 부른 뒤 `docker logs` 에 토큰 원문이 없음(컨테이너 이름을 받으면). `proxy` 모드는 이름에 고유 접두(예 `dodok-check-<pid>`)를 붙여 네트워크(서브넷 지정)·Caddy 컨테이너(고정 IP, 내부 CA HTTPS, `reverse_proxy app:3000`)·위조용 컨테이너를 만들고, 앱을 `-f compose.yaml` 과 임시 덮어쓰기 파일(`ports: !reset []`, 그 네트워크, `TRUST_PROXY=<Caddy IP>/32`)로 띄워: HTTPS 로그인 쿠키 `Secure`, WebSocket 업그레이드, 20 MiB 첨부 업로드, XFF 위조로 로그인 6회째 429, 위조용 컨테이너가 직접 보낸 XFF 가 무시됨(그 컨테이너 주소로 셈), `compose config` 에 호스트 포트 없음. 개발 `.env` 와 부딪히지 않게 임시 env 파일과 `DODOK_ENV_FILE`·`-p dodok-check-<pid>` 를 쓰고, 끝나면(trap) 만든 것만 이름으로 지운다.

- [ ] **Step 1: 파일 쓰기** — `Dockerfile`·`compose.yaml`·`check-deploy.sh`, `git rm -r infra`, ignore 파일·스크립트 언급 고침.
- [ ] **Step 2: 앱 모드 확인** — 임시 env(`APP_ORIGIN=http://127.0.0.1:3000`, `LOCAL_TOKEN` 등 — `.env.example` 기준)로 `DODOK_ENV_FILE=<임시> docker compose -p dodok-check -f compose.yaml up -d --build` → healthy, `bash scripts/check-deploy.sh app http://127.0.0.1:3000` FAIL 0. 스펙 합격 기준 1(로그인·채널·메시지·첨부·실시간)은 `pnpm wire-cli http://127.0.0.1:3000 <localToken> …` 로 잰다.
- [ ] **Step 3: 프록시 모드 확인** — `bash scripts/check-deploy.sh proxy` FAIL 0(합격 기준 2·3).
- [ ] **Step 4: 빌드 ID 확인**(합격 기준 5) — `apps/server/src` 아무 파일에 주석 한 줄을 더해 다시 빌드 → 이미지 안 웹 빌드 ID(빌드 로그 「웹 빌드 ID(내용 해시)」 줄) 그대로, `apps/web/src` 에 더하면 바뀜. 더한 줄은 되돌린다.
- [ ] **Step 5: 정리·회귀** — 만든 컨테이너·네트워크·볼륨·이미지를 이름으로 지운다. `pnpm test`·`pnpm typecheck`·`pnpm lint`·`pnpm fmt:check` 통과(실행 개수).
- [ ] **Step 6: 커밋** — `build: deploy a single app container from the root compose.yaml`

### Task 4: 배포 문서 다시 쓰기와 참조 정리

**Files:**
- Create: `docs/guides/docker-deploy.md`
- Delete: `docs/guides/deploy.md`, `docs/guides/deploy-komodo.md`
- Modify(옛 경로·Caddy 전제를 고침): `.ruler/AGENTS.md`(「배포」 줄 — 아래 명령, 「현재 단계」의 지난 기록 줄은 그대로), `.ruler/90-reference.md`(참조 표의 deploy.md → docker-deploy.md), `README.md`, `.env.example`, `apps/server/src/logger.ts`·`modules/setup/llms.ts`·`apps/server/test/setup.llms.test.ts`·`automations.webhook.test.ts`(문서·Caddy 언급), `apps/web/src/features/account/tokens.ts`·`features/reads/readSender.ts`·`features/setup/sections.tsx`·`connection.test.tsx`·`lib/zodJitless.ts`·`apps/web/vite.config.ts`, `docs/adr/0002-channel-plugin-spike.md`(현역 안내 줄만), `docs/guides/agent-guide.md`·`browser-verification.md`·`live-smoke.md`(절차 줄만 — 지난 실연 결과 표는 기록이라 그대로)·`plan.md`·`project-structure.md`, `docs/manual/user-guide.md`
- Test: `git grep` 확인(아래)

**Interfaces:**
- Consumes: Task 3 의 명령·파일 이름·`check-deploy.sh` 사용법, Task 1 의 `TRUST_PROXY` 꼴.

`docker-deploy.md` 구성(스펙 3.5·3.6, Komodo 지침 00-stack 「배포 가이드는 Docker 기준」):
1. 무엇이 뜨나 — 앱 컨테이너 하나, 포트 3000(호스트는 `127.0.0.1:${DODOK_HTTP_PORT}`), HTTPS 는 프록시 몫.
2. 준비 — 저장소 clone, `.env`(`.env.example` 복사 — 필수 값 표), `docker compose up -d --build`, 첫 로그인.
3. 프록시 붙이기 — 프록시가 해야 할 것(HTTPS·모든 경로 한 포트·WebSocket·본문 32 MB·긴 연결·XFF/Proto 전달), `TRUST_PROXY` 를 정하는 법(서브넷 금지 까닭 — 실측), `compose.override.yaml` 두 꼴(컨테이너 프록시: `ports: !reset []`·외부 네트워크 `external: true`·`default` 유지·프록시 고정 IP / 호스트 프록시: 루프백 포트·게이트웨이 `/32`), Caddy·nginx 예시 조각(Caddy 예는 웹훅·`dpt_` 가림 `log … format filter` 포함), 프록시 접근 로그 토큰 경고, `docker compose -f compose.yaml -f compose.override.yaml config` 로 확인.
4. 운영 — 지금 `deploy.md` 의 운영 절 전부를 옮긴다(Gateway 추가·브리지 토큰·러너 설치·멤버·웹훅·MCP·네이티브 푸시 자격 증명·운영 화면·백업·복원·업데이트·되돌리기·오류·보안·Docker 정리). Caddy 로그·80/443·Let's Encrypt 문장은 걷는다. 업데이트 명령은 `git pull && docker compose up -d --build`(덮어쓰기가 있으면 `-f` 둘).
5. 확인 — `scripts/check-deploy.sh` 사용법과 **그 스크립트가 보지 않는 것**(실제 도메인 인증서, 프록시 로그 가림, 실기기 푸시)을 같은 자리에. 사람이 채우는 결과 표.
6. 부록: Komodo — Stack 설정 표(Source GitLab Provider 바꾸기·Run Directory 루트·File Paths `compose.yaml` 다음 `compose.override.yaml`·Webhook 끔·Reclone 끔·Run Build 끔 — 까닭은 지금 `deploy-komodo.md` 에서), Environment 표(보간용 `.env` 가 됨, 비밀은 `[[KEY]]`), 덮어쓰기 파일은 Periphery clone 디렉터리에 서버에서 직접 쓰고 저장소 밖에도 사본, `config` 는 `--quiet`/`--services` 로.

서버마다 다른 값(Komodo 서버 이름·호스트 경로·외부 네트워크 이름·IP)은 이름과 뜻만 쓴다(komodo 00-stack 첫 절).

`.ruler/AGENTS.md` 「배포」 줄 새 내용(뜻이 같으면 문구는 빌더): 배포는 루트 `compose.yaml`(앱 하나 — 서버가 웹도 낸다, HTTPS 는 각자 프록시) `docker compose up -d --build` · 프록시·서버별 값은 서버의 `compose.override.yaml`(git 무시, 내용은 docs/guides/docker-deploy.md, `TRUST_PROXY` 는 프록시 `/32`) · Komodo 는 그 문서 부록 · 로컬 검증 `bash scripts/check-deploy.sh app|proxy` · 서버 번들·`prune` 금지 문장은 그대로.

- [ ] **Step 1: 문서 쓰기** — `docker-deploy.md`, 옛 둘 `git rm`.
- [ ] **Step 2: 참조 고치기** — 위 목록.
- [ ] **Step 3: 확인** — `git grep -n -E 'infra/|deploy-komodo|check-caddy|guides/deploy\.md|Dockerfile\.(server|web)|compose\.server\.(yml|example)' -- ':!docs/superpowers' ':!.superpowers'` 가 지난 실연 기록(`live-smoke.md` 결과 표·`plan.md` 완료 기록) 말고는 비어야 한다 — 남은 줄은 하나씩 「기록이라 둠」인지 판정해 보고에 적는다. 문서 안 상대 링크가 모두 있는 파일을 가리키는지 확인.
- [ ] **Step 4: 생성물** — `pnpm exec ruler apply` 뒤 `git status` 에 추적 파일 변화 없음(생성물은 무시됨). `pnpm test`(웹·서버 문구 테스트)·`pnpm typecheck`·`pnpm fmt:check`.
- [ ] **Step 5: 커밋** — `docs: rewrite deployment as docker-deploy.md for the single app container`
