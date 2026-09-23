# Phase 3 ① 배포 패키징 설계

**상태**: 설계 확정(2026-09-24)
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
백업 → `git pull` → `docker compose up -d --build`. 마이그레이션은 부팅 때 자동이다. 부팅에 실패하면(헬스체크 unhealthy) `git checkout <앞 커밋>` → 백업 복원 → 다시 빌드한다. 마이그레이션은 앞으로만 가므로, 되돌릴 때는 반드시 **업데이트 직전 백업**으로 복원한다(문서에 굵게).

---

## 4. 원격 Gateway·플러그인 연결 (사람 절차 — `docs/guides/deploy.md`)

표기: **[A]** dodok 호스트, **[B]** Gateway 호스트, **[PC]** 개발 PC, **[폰]**.

1. [A] DNS 가 A 를 가리키고 80·443 이 열려 있는지 확인. 저장소 clone, `.env` 작성(2.5, 토큰은 `openssl rand -hex 32`).
2. [A] `docker compose -f infra/compose.yml up -d --build` → `docker compose ps` 두 서비스 healthy → `https://<도메인>/healthz`.
3. [A] 서버 로그에서 Gateway 접속 결과를 본다. `device pairing required (requestId: …)` 가 있으면 [B] `openclaw devices approve <requestId>`(ADR 0001 — 필요 없을 수도 있다). 로그의 `gatewayVersion` 이 핀한 OpenClaw 버전과 맞는지 확인.
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
