# Phase 3 ① 배포 패키징 설계

**상태**: 설계 확정(2026-09-24), 구현·로컬 Compose 검증 완료(2026-09-24 — 계획 태스크 1~5, 검증 12/12, 테스트 2226) — 구현이 이 설계와 달라진 것은 12장. 실제 서버·도메인·폰은 사람 절차(`docs/guides/deploy.md` 「사람이 한 번 따라 한 결과」)
**범위**: Docker Compose 로 dodok 서버·웹을 한 호스트에 올린다. Caddy 가 공개 도메인에 자동 HTTPS 를 붙인다. 데이터 볼륨·백업·복원·업데이트, 원격 Gateway·플러그인 연결 절차(사람), 이 Mac 에서의 로컬 검증까지 다룬다.
**앞선 근거**:
- 계획서 `docs/plan.md` 4.5(배포 토폴로지)·8장 Phase 3 「Docker Compose 패키징」, 기술 표 「배포」
- ADR 0001(페어링 실측)·0002 9절(원격 플러그인 설치 절차)
- Phase 2 ④ 스펙 `2026-09-23-pwa-push-design.md` 결정 5(실기기 푸시는 HTTPS 배포 뒤)

Phase 3 은 넷으로 나눈다(브레인스토밍 2026-09-24). ① 배포 패키징(이 스펙) → ② 설정 마법사 → ③ 운영 보강(오류·재시도·레이트리밋·비용 상한·로그·메트릭) → ④ 문서(설치·에이전트 프롬프트 가이드). ② 는 ① 이 정한 공개 URL·볼륨 위에 서고, ④ 는 끝난 모양을 적는다.

---

## 0. 결정 (브레인스토밍 2026-09-24)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **공개 도메인 + Caddy 자동 HTTPS**(Let's Encrypt) | 폰(PWA·푸시)과 원격 Gateway 의 플러그인이 어디서나 붙어야 한다. 계획서 4.5 그대로다. |
| 2 | **Caddy 가 웹 정적 파일을 서빙하고, 서버는 esbuild 한 파일 번들로 돈다**(접근 A) | 서버는 API·wire·브리지만 맡는다. 운영 경로에 TS·`tsx` 가 없고 이미지가 작다. 캐시 헤더는 Caddy 설정 몇 줄이면 된다. |
| 3 | **서비스는 `app`·`caddy` 둘이다.** 호스트에 포트를 여는 것은 `caddy`(80·443)뿐이다 | 서버는 내부 네트워크에서만 받는다. TLS·헤더·본문 상한은 한곳(Caddy)에서 정한다. |
| 4 | **빌드는 배포 호스트에서 소스로 한다**(`git pull && docker compose up -d --build`). 레지스트리·CI 는 두지 않는다 | 개인용이다. 호스트 아키텍처(amd64·arm64)에서 바로 빌드해 네이티브 모듈(`better-sqlite3`) 문제가 없다. |
| 5 | **계획서의 `--profile gateway`(로컬 Gateway 동반 기동)는 뺀다** | 본인이 원격 Gateway 를 이미 운영하고, 개발은 `openclaw --dev` 로 한다. 쓸 곳이 없다. |
| 6 | **자동 검증은 이 Mac 의 로컬 Compose 까지다.** 실제 서버 배포·도메인·실기기 푸시는 사람 절차(체크리스트)로 한다 | 외부 서버·DNS·인증서 발급은 되돌리기 어렵고 바깥에 드러난다. 사람이 한 번 따라 하면 Phase 2 ④ 가 넘긴 실기기 확인도 닫힌다. |
| 7 | **설정은 호스트의 `.env`(`env_file`)로 준다.** 웹에서 바꾸는 설정은 ② 설정 마법사 몫이다 | 지금 서버가 전부 env 로 받는다. ① 은 모양을 바꾸지 않는다. |

---

## 1. 범위

**한다**
- `infra/` 에 이미지 둘(서버·웹+Caddy)·`compose.yml`·`Caddyfile`·`compose.local.yml`(로컬 검증 겹침 파일)
- 서버 운영 번들(esbuild) 빌드 스크립트와 그에 필요한 최소 코드 변경(마이그레이션 폴더를 찾는 자리)
- 백업 명령(온라인 SQLite 백업 + 보관 개수), 복원·업데이트·되돌리기 절차
- `docs/guides/deploy.md`: 배포·연결·실기기 확인 체크리스트
- 로컬 Compose 검증(9장)

**하지 않는다**
- 웹 설정 마법사·브리지 토큰 교체(②)
- 레이트리밋·비용 상한·메트릭(③)
- 레지스트리 이미지 게시·CI·다중 호스트·Postgres 전환
- 백업 스케줄러(cron 예시만 문서에)
- 로컬 Gateway 동반 기동(결정 5)

---

## 2. 구조

```
infra/
  Dockerfile.server      # 빌드 단계: pnpm install → 서버 번들 / 실행 단계: node:24-slim + better-sqlite3 + dist + drizzle
  Dockerfile.web         # 빌드 단계: pnpm -F @dodok/web build / 실행 단계: caddy:2 + dist 를 /srv
  compose.yml            # app, caddy, 볼륨 dodok-data·caddy-data·caddy-config
  Caddyfile              # {$DODOK_DOMAIN} — 정적·프록시·헤더·본문 상한
  compose.local.yml      # 로컬 검증: DODOK_DOMAIN=localhost, tls internal
apps/server/
  scripts/build.mjs      # esbuild: src/main.ts → dist/main.js, scripts/backup.ts → dist/backup.js
docs/guides/deploy.md
```

### 2.1 서버 이미지 (`Dockerfile.server`)
- **빌드 단계**(`node:24-slim` + corepack pnpm 11.16.0): 워크스페이스 전체를 복사하고 `pnpm install --frozen-lockfile` → `pnpm -F @dodok/server build`.
- **번들**: `main.ts` 가 들어가 워크스페이스 패키지(`@dodok/shared`·`@dodok/openclaw-adapter`)와 순수 JS 의존성을 한 파일로 묶는다. 네이티브·동적 로딩이 있는 것(`better-sqlite3`, 필요하면 그 밖)은 `external` 로 두고 실행 단계에서 설치한다. 무엇을 external 로 둘지는 계획이 실측으로 정한다.
- **실행 단계**(`node:24-slim`):
  - `dist/`·`drizzle/`(마이그레이션)과 external 의존성만 둔다. 비루트 사용자로 돈다.
  - `WORKDIR /app`, `DATA_DIR=/data`, `HOST=0.0.0.0`, `PORT=3000`, `CMD ["node", "dist/main.js"]`.
- **마이그레이션 폴더**: 지금 `db/client.ts` 가 `new URL("../../drizzle", import.meta.url)` 로 찾는데, 번들이 되면 이 상대 경로가 바뀐다. 번들 기준 경로로 맞추거나 `DODOK_MIGRATIONS_DIR`(선택) 환경변수로 준다 — 개발(`tsx`)과 번들 둘 다에서 도는지 테스트로 고정한다.
- **헬스체크**: `node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`(slim 이미지에 curl 이 없다).

### 2.2 웹 이미지 (`Dockerfile.web`)
- 빌드 단계에서 `pnpm -F @dodok/web build` 를 돌리고, 실행 단계(`caddy:2`, 태그 정확 핀)가 `dist/` 를 `/srv` 로, `Caddyfile` 을 `/etc/caddy/Caddyfile` 로 받는다.
- 웹 빌드는 API 오리진을 알 필요가 없다 — 같은 오리진의 `/api`·`/socket.io` 를 쓴다.

### 2.3 Caddyfile
```
{$DODOK_DOMAIN} {
  encode zstd gzip
  request_body { max_size 32MB }          # 첨부 20 MiB + 여유(multipart 오버헤드)
  @backend path /api/* /socket.io/* /healthz
  handle @backend { reverse_proxy app:3000 }
  handle {
    root * /srv
    @immutable path /assets/*
    header @immutable Cache-Control "public, max-age=31536000, immutable"
    @nocache path /sw.js /index.html /manifest.webmanifest /registerSW.js
    header @nocache Cache-Control "no-cache"
    try_files {path} /index.html
    file_server
  }
  header Strict-Transport-Security "max-age=31536000"
  header X-Content-Type-Options nosniff
  header Referrer-Policy strict-origin-when-cross-origin
}
```
- WebSocket(`/socket.io`, 브리지 네임스페이스 `/bridge` 포함)은 `reverse_proxy` 가 그대로 넘긴다.
- SPA 폴백은 `/api`·`/socket.io` 를 가로채지 않는다(위 `handle` 순서).
- Caddy 는 `X-Forwarded-For`·`X-Forwarded-Proto` 를 붙인다. 서버는 `TRUST_PROXY=true` 로 믿는다.
- 계획은 CSP 를 넣을지 실측으로 정한다(서비스 워커·인라인 스타일과 충돌 확인). 넣지 못하면 열린 문제로 남긴다.

### 2.4 compose.yml
- `app`: `build: { context: .., dockerfile: infra/Dockerfile.server }`, `env_file: ../.env`, `volumes: [dodok-data:/data]`, `restart: unless-stopped`, 헬스체크, **`ports` 없음**(`expose: [3000]`).
- `caddy`: `build: { context: .., dockerfile: infra/Dockerfile.web }`, `ports: ["80:80", "443:443", "443:443/udp"]`, `environment: DODOK_DOMAIN`, `volumes: [caddy-data:/data, caddy-config:/config]`, `depends_on: app (service_healthy)`, `restart: unless-stopped`.
- `compose.local.yml`: `DODOK_DOMAIN=localhost`, 로컬 전용 포트(예: `8443:443`), Caddy 전역 옵션 `local_certs`. 앱 설정은 로컬 검증용 env 파일로 준다.

### 2.5 설정 (`.env` — 배포 호스트)
- 필수: `APP_ORIGIN=https://<도메인>`·`TRUST_PROXY=true`·`LOCAL_AUTH_TOKEN`·`BETTER_AUTH_SECRET`·`OPENCLAW_GATEWAY_URL`·`OPENCLAW_GATEWAY_TOKEN`·`BRIDGE_TOKEN`·`BRIDGE_PUBLIC_URL=wss://<도메인>/bridge`·`VAPID_SUBJECT`(실제 연락처)·`DODOK_DOMAIN`.
- `HOST`·`PORT`·`DATA_DIR` 는 이미지가 정한다. `.env` 에 두지 않는다(두면 이미지 값을 덮으므로 문서에 적는다).
- `.env.example` 에 배포 절을 더한다(`DODOK_DOMAIN`, 컨테이너 기본값 설명).
- 서버가 `.env` 파일을 직접 읽는 동작(개발용)은 컨테이너 안에 `.env` 가 없으므로 영향이 없다 — 계획이 확인한다.

---

## 3. 데이터·백업·복원·업데이트

### 3.1 볼륨 `dodok-data:/data`
`dodok.sqlite`(+WAL)·`attachments/`·`vapid.json`·`openclaw-device.json`·`backups/`. 볼륨 하나를 통째로 옮기면 서버를 옮길 수 있다.

### 3.2 백업 (`docker compose exec app node dist/backup.js [--keep N]`)
- better-sqlite3 `db.backup()`(온라인 백업) → `/data/backups/<UTC 시각>/dodok.sqlite`. 서버를 멈추지 않는다.
- 같은 디렉터리에 `vapid.json`·`openclaw-device.json` 사본을 둔다(0600 유지). 첨부는 내용 주소(sha256) 블롭이라 백업마다 복사하지 않는다 — 볼륨째 옮기는 법을 문서에 적는다.
- 보관: 기본 최근 7개, `--keep` 으로 바꾼다. 넘친 것은 오래된 것부터 지운다.
- 출력: 백업 경로·DB 크기·걸린 시간 한 줄(시크릿 없음). 실패하면 exit 1 에 사유 한 줄.

### 3.3 복원 (문서 절차)
`docker compose stop app` → 백업의 `dodok.sqlite` 를 `/data/dodok.sqlite` 로 되돌리고 WAL·SHM 을 지운다 → 필요하면 `vapid.json`·디바이스 아이덴티티도 되돌린다 → `docker compose start app`. 절차는 일회용 컨테이너(`docker compose run --rm --entrypoint sh app`)로 한다.

### 3.4 업데이트
백업 → `git pull` → `docker compose up -d --build`. 마이그레이션은 부팅 때 자동이다. 부팅에 실패하면(헬스체크 unhealthy) `stop app` → `git checkout <앞 커밋>` → `docker compose build`(옛 이미지) → `app` 을 멈춘 채 일회용 컨테이너(`run --rm --entrypoint sh app`)에서 백업 복원(WAL·SHM 삭제) → 그 뒤에야 `up -d`. 3.3 의 `start app` 을 그대로 쓰면 새 이미지가 되돌린 DB 에 마이그레이션을 다시 올린다. 마이그레이션은 앞으로만 가므로, 되돌릴 때는 반드시 **업데이트 직전 백업**으로 복원한다(문서에 굵게).

---

## 4. 원격 Gateway·플러그인 연결 (사람 절차 — `docs/guides/deploy.md`)

표기: **[A]** dodok 호스트, **[B]** Gateway 호스트, **[PC]** 개발 PC, **[폰]**.

1. [A] DNS 가 A 를 가리키고 80·443 이 열려 있는지 확인. 저장소 clone, `.env` 작성(2.5, 토큰은 `openssl rand -hex 32`).
2. [A] `docker compose -f infra/compose.yml up -d --build` → `docker compose ps` 두 서비스 healthy → `https://<도메인>/healthz`.
3. [A] 서버 로그에서 Gateway 접속 결과를 본다. `"gateway pairing required; retrying"` 줄이 계속 나오면 그 줄의 `requestId` 필드 값으로 [B] `openclaw devices approve <requestId>`(ADR 0001 — 필요 없을 수도 있다). 로그의 `gatewayVersion` 이 핀한 OpenClaw 버전과 맞는지 확인.
4. [PC] `pnpm -F @dodok/openclaw-plugin run pack:plugin` → tgz 를 [B] 로 옮긴다 → [B] Gateway 를 내리고 설치 → sha 확인 → 올린다(live-smoke 3절 (b) 절차). 플러그인 계정 설정의 `bridgeUrl` 은 `wss://<도메인>/bridge`, 토큰은 `BRIDGE_TOKEN`.
5. [A] 서버 로그에서 브리지 접속(플러그인 hello)을 본다.
6. [폰] `https://<도메인>` → 로그인(`LOCAL_AUTH_TOKEN`) → iOS 는 홈 화면에 추가 뒤 그 아이콘으로 연다 → 「알림」 켜기 → PC 에서 에이전트에게 「@<핸들> 불러 줘」 류 요청 → 폰을 잠근 채 푸시 도착·누르면 그 채널. 안드로이드 Chrome 도 같게.
7. 백업 한 번 돌려 보기, cron 예시(`0 4 * * * cd … && docker compose -f infra/compose.yml exec -T app node dist/backup.js`).

시크릿 규칙은 live-smoke 2절과 같다 — 문서의 명령은 값을 화면에 찍지 않는다.

---

## 5. 오류 처리

| 상황 | 동작 |
| --- | --- |
| `.env` 필수 값 없음 | 서버가 기존대로 설정 오류 한 줄로 종료 → `app` 이 재시작을 되풀이하고 Caddy 는 `depends_on` 헬스 대기. 문서에 `docker compose logs app` 확인을 적는다 |
| 도메인 DNS·80 포트 문제로 인증서 발급 실패 | Caddy 로그. 문서에 확인 순서(DNS·방화벽·`DODOK_DOMAIN`) |
| 마이그레이션 실패 | 부팅 실패 → unhealthy → 3.4 되돌리기 |
| 볼륨 권한(비루트 사용자) | 이미지가 `/data` 소유자를 맞춘다. 기존 볼륨을 다른 UID 로 만든 경우는 문서에 `chown` 한 줄 |
| 백업 중 디스크 부족 | exit 1 + 사유, 부분 파일 삭제 |
| 업로드가 Caddy 상한을 넘음 | Caddy 413 — 서버의 20 MiB 상한보다 크게 잡아 서버의 고정 문구가 먼저 나오게 한다 |

---

## 6. 보안

- 호스트에 열리는 포트는 Caddy 80·443 뿐이다. `app` 은 compose 내부 네트워크에만 있다.
- 컨테이너는 비루트로 돈다. `.env` 는 이미지에 들어가지 않는다(`.dockerignore` 에 `.env*`·`data/`·`.worktrees/`·`node_modules`·`.superpowers/`).
- 이미지 빌드 컨텍스트에서 시크릿이 새지 않는지 검증에서 `docker history`·이미지 파일 목록으로 확인한다.
- HSTS·nosniff·Referrer-Policy 는 Caddy 가 붙인다. CSP 는 2.3 대로 계획이 판단한다.

---

## 7. 코드 변경 (최소)

- `apps/server`: `build` 스크립트(esbuild), `scripts/backup.ts`, 마이그레이션 폴더 해석(2.1).
- `.dockerignore`(루트), `.env.example` 배포 절.
- 그 밖의 앱 동작은 바꾸지 않는다. 바꿔야 하는 것이 나오면(예: 번들에서 깨지는 동적 import) 계획의 판정으로 기록한다.

---

## 8. 테스트

- 서버 단위: 마이그레이션 폴더 해석(환경변수·기본값), 백업 스크립트(임시 디렉터리 — 백업 파일이 열리고 행 수가 같다, 보관 개수, 실패 exit 1).
- 번들 연기 테스트: `pnpm -F @dodok/server build` 뒤 `node dist/main.js` 가 임시 `DATA_DIR`·가짜 설정으로 뜨고 `/healthz` 200(가능하면 테스트 스크립트로, 어렵다면 9장 검증에 포함).

---

## 9. 로컬 검증 (워커, 이 Mac — colima Docker 29·Compose 5, 모델 런 0)

`docker compose -f infra/compose.yml -f infra/compose.local.yml up -d --build`. `app` 은 실제 Gateway 없이 떠야 하므로, 로컬 검증용 설정으로 **로컬 dev Gateway**(`openclaw --dev`, 호스트에서)나 **dev:fake 동등 모드**를 쓴다 — 어느 쪽인지는 계획이 정한다(운영 이미지에 개발 진입점을 넣지 않는 쪽을 우선).

합격 기준:
1. 두 이미지 빌드 성공, 크기 기록. 이미지 안에 `.env`·`data/`·소스 TS·`node_modules` 전체가 없다(서버 이미지는 external 의존성만).
2. `docker compose ps` 둘 다 healthy. 호스트에서 `app` 포트가 열려 있지 않다(`lsof`).
3. `https://localhost:<포트>/healthz` 200(Caddy 로컬 인증서, 브라우저는 인증서 오류 무시 설정).
4. 브라우저(Playwright)로 로그인 → 채널 → 메시지 → 스트리밍 답(가짜 또는 dev Gateway) → 첨부 업로드(19 MiB 파일)·내려받기 바이트 일치.
5. WebSocket 이 Caddy 를 거쳐 붙는다(`rejected`·재연결 반복 없음).
6. 서비스 워커 등록, 매니페스트, 푸시 켜기(구독 행 생성).
7. 캐시 헤더: `/sw.js`·`/index.html` no-cache, `/assets/*` immutable. SPA 깊은 경로(`/c/<id>`) 새로고침이 앱을 낸다. `/api/v1/…` 없는 경로는 JSON 404(SPA 폴백이 아님).
8. `docker compose down && up -d` 뒤 메시지·첨부·구독·`vapid.json` 공개키가 그대로다.
9. 백업 → `/data/dodok.sqlite` 삭제 → 3.3 복원 → 데이터가 돌아온다. 보관 개수 동작.
10. 로그·이미지에서 시크릿 0(`grep -c -F` 로 개수만).
11. `docker compose down -v` 로 정리, 포트 LISTEN 0(5173·3000 은 건드리지 않는다).

---

## 10. 완료 기준

- 배포 호스트에서 `.env` 하나와 명령 하나(`docker compose -f infra/compose.yml up -d --build`)로 HTTPS dodok 이 뜬다(9장 로컬 검증으로 대신 확인).
- 재시작·업데이트에도 데이터가 남고, 백업·복원이 된다.
- `docs/guides/deploy.md` 체크리스트를 사람이 따라 원격 Gateway 연결과 폰 푸시까지 갈 수 있다. 사람이 한 번 따라 한 결과는 그 문서의 결과 절에 적는다(실기기 확인 — Phase 2 ④ 이월 닫기).
- 서버 단위 테스트 추가분·검사 4종 통과.

---

## 11. 열린 문제 (범위 밖 기록)

- 이미지 레지스트리·자동 빌드(CI) — 필요해지면.
- Postgres 전환 — 계획서 기술 표(「SQLite→Postgres」), 개인용에는 SQLite 로 충분.
- 백업을 다른 호스트·오브젝트 저장소로 보내기 — 사람 cron 몫.
- CSP — 2.3·6장, 계획이 넣지 못하면 여기 남는다.
- Gateway 버전 드리프트 감지(서버 로그 `gatewayVersion` 과 핀 비교 경고) — ③ 운영 보강 후보.

---

## 12. 구현과 맞춘 것 (2026-09-24)

구현(계획 태스크 1~3)·리뷰·로컬 Compose 검증(태스크 4)과 그 수정 라운드에서 이 설계와 달라진 것만 모았다. main `bb2b5bb` 기준이다.
정본 근거는 실행 원장 `.superpowers/sdd/2026-09-24-deploy-packaging/ledger.md`(git 제외)의 판정 R1~R7 과, 원장이 가리키는 보고서·리뷰(`d1-t*`)다. 보고서의 커밋 해시는 워크트리 것이라 main 에서는 다르다 — 아래 해시는 main 의 것이다.
운영 절차는 `docs/guides/deploy.md`, 남은 문제는 `docs/plan.md` 8장 「이월」 한곳에 있다. 각 파일이 왜 그렇게 생겼는지는 그 파일의 머리 주석이 정본이다.

**계획이 정한 셋**(계획 Self-Review 「스펙과 다르게 정한 것」)

- **로컬 검증의 에이전트 경로는 dev:fake 를 별도 빌드 타깃으로 돌린다**(9장이 계획에 맡긴 선택). `infra/Dockerfile.server` 의 `devfake` 단계(`build` 를 잇고 플러그인 소스까지 더 설치)와 `infra/compose.local.yml` 의 `devfake` 프로필이다 — 운영 이미지(`runtime`)에는 개발 진입점이 없다. dev:fake 는 `DEV_FAKE_HOST`(없거나 비면 `127.0.0.1`)로 리슨 주소를 받는다(`a772ca9`) — 컨테이너 안에서 Caddy 가 닿게 `0.0.0.0`.
- **CSP 는 넣지 않았다**(2.3·6장이 계획에 맡긴 판단 — 11장 「열린 문제」에 그대로 남는다). Report-Only 로 한 번 쟀다(d1-t3 보고서 실측 판정 9): devfake 위 로그인 → 채널 → 이미지 카드 답 → 새로고침에서 위반은 둘 — ① 번들이 런타임에 꽂는 `<style>`(`style-src-elem` inline, 페이지마다 2~3건) ② zod 의 기능 탐지 `Function("")`(`script-src` eval — 강제해도 대체 경로로 돈다). img·connect(wss 포함)·font 위반은 0. 넣으려면 `style-src 'self' 'unsafe-inline'`(또는 에디터 CSS 주입을 끄고 해시)이 필요하다. `worker-src` 는 로컬 CA 인증서 때문에 그 측정에서 못 쟀다.
- **`DATA_DIR` 쓰기 검사를 더했다**(5장 「볼륨 권한」 보탬, `532d27b`). 비루트 컨테이너에 파일이 이미 든 root 소유 볼륨이 붙으면 better-sqlite3 가 `unable to open database file` 과 여러 줄 스택으로 죽어 권한 문제로 읽히지 않았다(재현). 지금은 부팅 전에 `unwritableDataPath`(`apps/server/src/runtime.ts`)가 DATA_DIR·DB·WAL·SHM·첨부 디렉터리를 보고, 못 쓰면 `dataDirErrorMessage` 한 줄(원인 + `chown` 명령)로 exit 1 이다. 빈 볼륨은 Docker 가 첫 마운트 때 이미지의 `/data` 소유자(node, 1000:1000)를 입혀 이 경우가 안 생긴다.

**서버 번들에서 달라진 것**(태스크 1 — `605b2fc`·`31f3e0c`·`51374f5`·`31baa13`)

- **external 은 `better-sqlite3` 하나, 그런데 번들 밖에서 찾는 것이 하나 더 있다 — `ws`**(2.1 「무엇을 external 로 둘지는 계획이 실측으로」). `@openclaw/gateway-client` 가 `createRequire(import.meta.url)` 로 `ws/package.json` 을 런타임에 해석하고, 번들 뒤 `import.meta.url` 은 `dist/main.js` 라 실행 자리의 `node_modules` 에서 찾는다. 그래서 `ws` 는 `@dodok/server` 의 `dependencies` 다(devDependency 였을 때 프로드 배치에서 부팅 즉시 죽었다 — d1-t1 리뷰 Critical, 재현). 목록의 정본은 `apps/server/scripts/build.mjs` 의 `runtimeDeps`(`[...external, "ws"]`)이고 빌드가 `dist/runtime-deps.json` 으로 쓴다.
- **번들 배너에 `__filename`·`__dirname`**(`605b2fc`). 계획의 배너(`require` 만)로는 인증 없는 `GET /socket.io/socket.io.js` 한 번이 socket.io 클라이언트 파일 서빙의 `__dirname` 에서 `ReferenceError` 로 번들 서버를 죽였다(관문이 잡음). pino transport·thread-stream 도 `__dirname` 을 참조하지만 transport 를 안 써서 돌지 않는다 — 배너는 방어이고 그 두 줄을 빼도 스모크는 초록이다(`build.mjs` 주석).
- **R1 — `serveClient: false`**(`apps/server/src/app.ts` 의 Socket.IO 옵션, `31f3e0c`). 7장 「그 밖의 앱 동작은 바꾸지 않는다」의 예외다 — `/socket.io/socket.io.js` 를 쓰는 곳이 없고(웹은 `socket.io-client` 를 번들한다), 번들에서 프로세스를 죽이던 표면이다 — 배너를 고친 뒤에도 운영 번들에는 `client-dist` 가 없어 200 머리만 보내고 끊겼다. 소스·번들 두 모드 모두 끈다. 지금 그 경로는 engine.io 의 400 이다(`infra/check-caddy.sh` 가 서버까지 갔는지를 이것으로 본다). **틀리면 남는 것**: 그 파일을 받아 쓰던 외부 도구가 깨진다(없음).
- **R2·R4 — 번들 스모크는 prod 의존성만 있는 격리 배치에서 돈다**(8장 「번들 연기 테스트」 구체화). `pnpm -F @dodok/server bundle:smoke`(`apps/server/scripts/bundle-smoke.mjs`)가 저장소 밖 임시 디렉터리에 `pnpm deploy --prod --legacy --offline` 산출물을 만들고 — 저장소 안이면 워크스페이스 `node_modules` 가 빠진 prod 의존성을 가린다(ws 결함을 그렇게 놓쳤다) — 세 단계를 본다: ① `/healthz` 200·`/socket.io/socket.io.js` 400 뒤에도 생존 ② `DODOK_MIGRATIONS_DIR` 없이 띄우면 설정 오류로 exit≠0(번들이 자기를 번들로 아는지) ③ `dist/backup.js` 가 떠 있는 서버의 DATA_DIR 을 백업(exit 0·한 줄), DB 없는 디렉터리면 exit 1. deploy 는 **매니페스트 사본에서** 한다(R4) — 원본 워크스페이스에서 하면 `node_modules/.pnpm-workspace-state-v1.json` 을 운영(dev:false)으로 덮어, 다음 `CI=true` 설치가 devDependencies 를 조용히 지웠다. 중단(SIGINT·SIGTERM·SIGHUP)에도 임시 디렉터리를 지운다.
- **R3 — 소스맵을 이미지에 싣고 켠다**(2.1 보탬). `sourcemap: true` + 실행 이미지 `NODE_OPTIONS=--enable-source-maps` — 개인 운영 로그의 스택이 원본 TS 줄을 가리키게(소스는 공개 저장소 그대로). **대가**: `main.js.map` 만큼(약 10 MB) 이미지가 크다.
- **마이그레이션 폴더는 `DODOK_MIGRATIONS_DIR` 가 번들에서 필수다**(2.1 「번들 기준 경로로 맞추거나 환경변수로」 중 환경변수). `migrationsFolder`(`apps/server/src/runtime.ts`)는 env 가 있으면 그것, 없으면 소스 기준 `apps/server/drizzle` 이다. 번들인데 env 가 없으면 `createDb` 가 설정 오류로 던진다 — 번들 기준 상대 경로로 조용히 엉뚱한 자리를 읽지 않게. 번들 판정은 esbuild `define` 의 `__DODOK_BUNDLED__`(`isBundled`)이고, 번들은 `.env` 를 읽지 않고 cwd 도 옮기지 않는다(`apps/server/src/main.ts` — 2.5 끝 「계획이 확인한다」의 답).

**백업에서 달라진 것**(태스크 2 — `4657c21`·`195f8c8`)

- **자리는 `src/backup.ts`(`runBackup`)·`src/backup-main.ts`(CLI)**(2장 구조 정정 — 2장은 `scripts/backup.ts` 였다). 번들 엔트리 `backup` 이 `dist/backup.js` 를 낸다.
- **한 단계 전체 복사**(3.2 보탬). 계획의 단계당 100 페이지 백업은 단계 사이에 다른 연결이 쓸 때마다 SQLite 가 처음부터 다시 시작해, 쓰기가 이어지는 동안 끝나지 않았다(테스트 「쓰는 중에도」가 30초 안에 못 끝냄). 지금은 `progress: () => 0x7fffffff` 로 한 읽기 트랜잭션의 스냅숏을 한 번에 복사한다. 리뷰가 쓰기를 막지 않음을 쟀다(1 GB DB 백업 중 쓰기 p99 0.14 ms, WAL 4 → 19 MB). 로컬 검증에서 초당 몇 건씩 쓰는 중에 백업해도 `integrity_check` `ok` 였다.
- **`.partial-*` 에서 만들고 rename**(3.2 보탬, `195f8c8`). 백업은 `backups/.partial-<시각>-XXXXXX/` 에서 만든 뒤 다 되면 `<시각>/` 으로 옮긴다. 중단(SIGKILL 등)으로 남은 `.partial-*` 는 복원에 쓰지 않으며, 1시간이 지나면 다음 백업이 지운다(`STALE_PARTIAL_MS`). CLI 는 SIGINT·SIGTERM 에 자기 `.partial-*` 를 지우고 130·143 으로 끝난다 — 단 복사 단계는 동기라 복사 도중의 신호는 복사가 끝난 뒤에야 처리되고, 그때는 완료 줄을 찍고 exit 0 으로 끝난다. 고치기 전에는 중단된 백업이 백업 이름으로 남아 보관 개수를 차지하고 「가장 최근 백업」으로 골릴 수 있었다(d1-t2 리뷰 결함 1).
- **보관 개수는 백업 이름 형식만 센다**(3.2 보탬). `YYYY-MM-DDTHH-MM-SS-mmmZ(-N)` — 사람이 `backups/` 에 둔 다른 이름은 세지도 지우지도 않는다. 같은 시각이면 `-1`·`-2` 접미사.
- **사본 파일에 `openclaw-device-dev.json` 도**(3.2 보탬) — dev 대상 디바이스 아이덴티티가 있으면 함께 싣는다.

**이미지·Compose 에서 달라진 것**(태스크 3 — `a772ca9`·`e8a554d`·`532d27b`·`700cd37`·`bf7ce2a`·`c9246f3`·`df64609`·`bb2b5bb`)

- **베이스 이미지는 `node:24.21.0-bookworm`(빌드)·`node:24.21.0-bookworm-slim`(실행)·`caddy:2.11.4`**(2.1·2.2 정정 — `node:24-slim`·`caddy:2` 대신 정확 태그). 빌드 단계는 네이티브 모듈 빌드 도구가 있는 full 이미지다.
- **R5 — 실행 이미지의 `node_modules` 는 런타임 해석 닫힘만**(2.1 「external 의존성만 둔다」 구체화, `e8a554d`). `pnpm deploy --prod` 산출물을 그대로 실으면 better-auth 의 optional peer 가 lockfile 스냅숏에 워크스페이스 것으로 묶여 개발 도구(vitest·vite·drizzle-kit·jsdom…)와 `@dodok/*` TS 원본까지 따라왔다(234 MB). `apps/server/scripts/prune-runtime-deps.mjs` 가 `dist/runtime-deps.json` 의 이름에서 dependencies·optional·peer 를 따라간 닫힘만 남긴다 — `better-sqlite3`·`node-addon-api`·`ws`(27 MB, `docker run --rm dodok-app du -sh /app/node_modules`). 같은 스크립트를 Dockerfile 의 `deploy` 단계와 `bundle-smoke` 가 함께 써서, 목록이 모자라면 스모크가 빨개진다. 이미지는 `dodok-app` 407 MB(압축 95 MB)·`dodok-caddy` 87 MB(`docker image ls`). **남는 틈**: 스모크는 부팅 경로에서 찾는 것만 잡는다 — 요청 경로 안의 런타임 해석은 `build.mjs` 주석의 전수 재기로만 찾는다.
- **`pnpm deploy --prod --legacy` 앞에 `pnpm install --frozen-lockfile`, deploy 는 별도 단계**(2.1 보탬). 매니페스트가 lockfile 과 어긋나면 `deploy --legacy` 가 멈추지 않고 조용히 다시 해석한다 — 앞의 설치가 그 어긋남을 빌드 실패로 드러낸다. 같은 단계면 deploy 가 쓴 워크스페이스 상태 파일이 `devfake` 의 `dev:fake` 에 번진다. Docker 안에서는 `--offline` 을 못 쓴다(`pnpm fetch` 가 legacy deploy 의 메타데이터 캐시를 채우지 않는다 — `ERR_PNPM_NO_OFFLINE_META`) — 빌드가 npm 레지스트리에 닿아야 한다.
- **BuildKit 캐시 마운트 대신 `pnpm fetch` 층**(2.1 보탬). buildx 가 없는 Docker 에서 compose 가 클래식 빌더로 빌드해 `--mount=type=cache` 가 오류다. 두 Dockerfile 이 fetch 층까지 줄이 같아 캐시를 나눠 쓴다. **대가**: `COPY . .` 뒤라 저장소 어느 파일이 바뀌어도 웹·서버 빌드를 다시 한다.
- **실행 이미지는 deploy 산출물의 `package.json` 을 싣는다** — `"type": "module"` 이라야 `dist/main.js` 가 ESM 으로 읽힌다.
- **Caddyfile 결함 셋을 고쳤다**(2.3 정정, `700cd37`). ① `@backend` 에 **`/bridge/*`** — 플러그인의 첨부 HTTP 가 `/bridge/attachments` 다. 2.3 대로면 SPA 폴백으로 떨어져 원격 플러그인의 첨부 주고받기가 깨진다(2.3 첫 줄 「브리지는 `/socket.io` 하나로 충분」은 WebSocket 만 맞다). ② **no-cache 를 경로 목록 대신 정적 나머지 전부에** — 2.3 의 `@nocache path /sw.js /index.html …` 는 `header` 가 `try_files` 보다 먼저 돌아 원래 경로로 매칭돼, index.html 을 내는 `/` 와 SPA 깊은 경로(`/c/<id>`)에 안 붙는다. ③ **`/assets/*` 는 SPA 폴백 없이** — 없는 청크(옛 버전을 든 탭)가 index.html 200 + immutable 로 1년 캐시되지 않게 404.
- **immutable 은 있는 파일에만(`@built file`)**, **`registerSW.js` 는 목록에서 뺐다**(2.3 정정, `bf7ce2a`). 없는 `/assets/…` 의 404 도 immutable 이면 휴리스틱 캐시에 1년 남는다. `registerSW.js` 는 `injectManifest` 빌드에 없다.
- **Caddyfile 이 받는 env 가 둘 늘었다** — `CADDY_LOCAL_CERTS`(로컬 검증만 `local_certs`, 운영은 빈 전역 블록)·`DODOK_UPSTREAM`(기본 `app:3000`, devfake 프로필만 `devfake:3000`). `DODOK_DOMAIN` 이 비면 사이트 블록이 전역 블록으로 읽혀 `unrecognized global option: encode` 같은 엉뚱한 오류가 나서, compose 가 `${DODOK_DOMAIN:?…}` 로 먼저 막는다.
- **`infra/check-caddy.sh`**(9장 합격 기준 3·7 의 도구). 라우팅·SPA 폴백·캐시·보안 헤더를 curl 로 단언한다. `/healthz` 는 상태 코드만이 아니라 본문의 `"db":"ok"` 를 본다(`bf7ce2a` — 상태만 보면 `/healthz` 가 `@backend` 에서 빠져도 SPA 폴백 200 으로 통과한다). 보지 않는 것(업로드 상한·WebSocket·XFF)은 스크립트 머리에 적었다.
- **caddy 헬스체크는 관리 API**(`127.0.0.1:2019/config/`) — 운영 도메인은 컨테이너 안에서 그 이름으로 닿지 않고, 인증서 발급 전에도 헬스가 초록이어야 로그로 원인을 볼 수 있다. **대가**: 인증서 실패가 `ps` 에 안 보인다(`docs/guides/deploy.md` 「오류」).
- **compose 가 네 값을 `environment` 로 고정한다**(2.5 정정 — 2.5 는 「이미지가 정하고 `.env` 에 두지 않는다(두면 덮는다)」였다, `700cd37`). `HOST`·`PORT`·`DATA_DIR`·`DODOK_MIGRATIONS_DIR`. `.env.example` 을 복사하면 생기는 `HOST=` 빈 줄이 이미지 ENV 를 빈 문자열로 덮고, 서버는 빈 값을 기본값(127.0.0.1·./data)으로 읽어 헬스체크(컨테이너 안 127.0.0.1)는 초록인데 Caddy 는 502 였다(재현). `environment` 가 `env_file` 보다 앞서므로 지금 `.env` 의 그 네 이름은 무시된다.
- **변수 치환은 `infra/.env → ../.env` 링크로**(2.4 보탬, `700cd37`). compose 는 치환에 첫 `-f` 파일의 디렉터리(`infra/`)의 `.env` 만 읽고 루트 `.env` 는 안 본다. 치환이 `ps`·`logs`·`exec`·`down` 에서도 돌아 `--env-file .env` 는 명령마다 붙여야 해서 링크를 기본으로 정했다(`.dockerignore`·`.gitignore` 가 링크를 뺀다). 로컬 검증은 `--env-file infra/local.env`(치환이 파일을 합치기 전에 돌아 `compose.local.yml` 의 값으로는 못 피한다), 겹침 파일의 `env_file: !override` 로 루트 `.env` 없이도 돈다.
- **로컬 검증 포트는 `127.0.0.1:8443` 만**(2.4 정정, `bf7ce2a`). 모든 인터페이스면 devfake 프로필의 고정 로그인 토큰이 LAN 에 열린다.
- **R7 — 웹 빌드 ID 를 빌드 인자로**(2.2 보탬, `df64609`·`bb2b5bb`). 웹의 `__BUILD_ID__` 가 빌드 시각이면 `COPY . .` 때문에 서버만 바뀐 배포에서도 청크·`sw.js` 이름이 바뀌어 모든 클라이언트가 새 버전 토스트·오프라인 사본 폐기를 겪었다(d1-t3 재리뷰 N1). 지금은 compose 가 `DODOK_WEB_BUILD_ID` → `Dockerfile.web` 의 `ARG VITE_BUILD_ID` 로 넘기고, 배포 명령이 웹 입력(`apps/web packages/shared pnpm-lock.yaml tsconfig.base.json package.json pnpm-workspace.yaml infra/Dockerfile.web`)의 마지막 커밋을 준다 — 같은 ID·같은 입력이면 산출물이 바이트 단위로 같다. 비면 빌드 시각(늘 새 버전 — 안전한 쪽). 빈 값 방어가 두 겹이다 — Dockerfile 이 빈 ARG 를 unset 하고, `apps/web/vite.config.ts` 도 `??` 가 아니라 `||` 다(빈 문자열이 ID 로 고정되면 웹이 바뀌어도 사본이 안 버려진다). 얕은 클론에서는 값이 틀린다(`docs/guides/deploy.md` 「기동」).
- **`.dockerignore` 는 `**/` 로 하위까지**(6장 정정). `.dockerignore` 패턴은 루트 기준이라 6장 목록 그대로면 `.env.*`·`.turbo` 가 루트에서만 빠진다. `infra/*.env`·`infra/.env`(로컬 비밀·치환용 링크)도 뺀다. 로컬 검증에서 이미지 안 `.env*`·`*.ts` 0건, 로그·`docker history` 의 시크릿 0건(`grep -c -F`).
- **`.env.example` 배포 절**(2.5 대로) — `DODOK_DOMAIN`, 배포 값, compose 가 고정하는 네 값, 링크 한 줄.

**로컬 Compose 검증이 확인한 것**(태스크 4, 합격 기준 12개 — 9장의 11개에 볼륨 권한 재현을 더함)

- 12/12 통과, Review Focus 1~5 통과, 결함 1(아래 F1). 절차와 명령은 `docs/guides/deploy.md` 「로컬 검증 (이 Mac)」.
- **9장 기준 4의 19 MiB 업로드는 브리지 경로(`/bridge/attachments`)로 쟀다** — 사람 업로드는 이미지 5 MiB 상한이다. 사람 경로는 PNG 업로드·다운로드 sha256 일치로 봤다.
- **F1 — 5장 「업로드가 Caddy 상한을 넘음」 줄이 절반만 맞다**(이월, 사용자 영향 없음). 21 MiB 업로드는 Caddy(32 MB)를 지나 서버가 413 JSON 으로 거절하지만, 문구가 첨부 서비스의 고정 문구가 아니라 Fastify 의 `Request body is too large` 다 — 라우트 `bodyLimit` 이 앱 상한과 같아 body-too-large 가 핸들러보다 먼저 난다. 웹(업로드 전 검사)과 플러그인(상태 413 으로 자기 문구)은 영향이 없다. Phase 2 ③ 부터의 동작이다.
- **WAL·SHM 을 안 지운 복원은 조용히 무효가 된다**(3.3 의 경고를 실측). 백업 시점 66건, 그 뒤 4건 쓰고 `docker kill` → WAL 을 둔 채 DB 만 덮으면 70건(오류·경고 없음), 지우면 66건. 정상 정지(`docker compose stop`)는 WAL 을 합치고 지우므로 남는 것은 비정상 종료 뒤다. 문서(`docs/guides/deploy.md` 「복원」)에 굵게.
- **`X-Forwarded-For` 위조로 로그인 레이트리밋을 우회할 수 없다**(2.3 의 전제 확인). Caddy 에 `trusted_proxies` 가 없어 클라이언트 XFF 를 자기가 본 연결 IP 로 덮는다 — XFF 값을 바꿔도 5회 뒤 첫 요청부터 429.
- **자동화 브라우저 절차**: Claude-in-Chrome 은 자체 인증서를 못 넘고, Playwright 임시 컨텍스트는 시크릿 취급이라 Push API 가 없다 — `launchPersistentContext` + `--ignore-certificate-errors`(`docs/guides/browser-verification.md` 「로컬 HTTPS(Compose 8443)를 볼 때」).
