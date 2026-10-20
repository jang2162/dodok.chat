# 앱 컨테이너 하나 배포 — 설계

> 상태: 설계(2026-10-20). 사용자 요청을 브레인스토밍으로 정리했다. 구현은 이 문서에서 계획(docs/superpowers/plans/)으로 간다.

## 1. 의도

지금 배포 구성(`infra/`)은 dodok 앱(서버)과 **웹을 구운 Caddy** 를 함께 올린다. Caddy 가 호스트의 80·443 을 잡고 자동 HTTPS·정적 웹·경로 나누기·보안 헤더·로그 가림을 한다. 이미 리버스 프록시가 있는 서버는 덮어쓰기 파일로 Caddy 를 프록시 뒤에 다시 앉혀야 해서, 프록시가 두 겹이 되고 신뢰 주소·XFF 같은 함정이 생겼다(직전 작업 9aad972).

사용자가 원하는 것:

- **배포 구성은 앱만 올린다.** 프록시(HTTPS·도메인)는 배포 구성에 넣지 않는다. 각자 자기 서버의 프록시에 맞게 덮어쓴다 — 사용자의 서버는 Caddy 컨테이너지만 서버마다 다르다.
- **배포 대상은 앱 컨테이너 하나.** 프록시는 그 컨테이너의 포트 하나로 모든 경로를 보낸다(사용자 결정).
- **compose 파일은 저장소 루트에 하나만.** `infra/` 의 compose 셋을 정리한다.
- **Komodo 로 배포할 수 있게 덮어쓰기가 가능한 구성**이고, 그 구성이 문서에 적혀 있다. 공용 지침 `docs/guideline/komodo/`(00-stack·01-environment·02-override)를 따른다.
- **배포 문서 이름은 docker** 다. Komodo 이름이 붙은 문서는 없앤다(`docs/guides/deploy-komodo.md`).

## 2. 목표 · 비목표 · 반목표

목표

- 루트 `compose.yaml` 하나(서비스 `app` 하나)로 `docker compose up -d` 하면 앱이 뜨고, 그 포트로 웹 화면·API·실시간·브리지·러너·웹훅·`/mcp`·`/llms.txt` 가 모두 된다.
- 프록시 뒤 서버는 저장소를 고치지 않고 서버에서만 쓰는 덮어쓰기 파일 하나로 맞춘다(Komodo 는 `File Paths` 로).
- 문서 하나(`docs/guides/docker-deploy.md`)가 설치·운영·덮어쓰기·Komodo Stack 표를 담는다.

비목표

- 앱 안 TLS·자동 인증서. HTTPS 는 프록시 몫이다.
- 특정 프록시용 compose 서비스·설정 파일을 저장소에 두는 것. 프록시 쪽 설정은 문서의 예시 조각으로만 싣는다.
- 레지스트리 이미지 배포(CI 푸시). 지금처럼 서버에서 저장소로 빌드한다.

반목표(이렇게 되면 동작해도 실패)

- **클라이언트 IP 위조로 레이트리밋·실패 카운터가 뚫린다.** Caddy 가 XFF 를 덮어 주던 보호가 사라지므로 앱이 직접 막아야 한다.
- **SPA 폴백이 백엔드 404 를 삼킨다.** `/api/없는것` 이 index.html 200 으로 오면 안 된다.
- **보안 헤더(CSP 등)·캐시 규칙이 빠지거나 느슨해진다.** 지금 Caddyfile 과 같은 값이어야 한다.
- 웹 빌드 ID 가 서버만 바뀐 배포에서 바뀐다(모든 클라이언트가 새 버전 토스트·청크 재다운로드).
- 웹훅·MCP 토큰이 앱 로그에 원문으로 남는다(지금 서버 가림은 그대로 살아 있어야 한다).

## 3. 정해진 것

### 3.1 컨테이너

- 루트 `Dockerfile`(지금 `infra/Dockerfile.server` 와 `infra/Dockerfile.web` 의 빌드를 합친 다단계). 런타임 이미지가 서버 번들·마이그레이션·플러그인 tgz·러너 tgz 에 더해 **빌드된 웹(`apps/web/dist`)** 을 품는다. 이미지 안 자리와 env 이름(예: `DODOK_WEB_DIR`)은 빌더 몫이되, 지금 `DODOK_PLUGIN_DIR` 처럼 compose `environment:` 에 고정해 `.env` 빈 줄이 덮지 못하게 한다.
- 웹 빌드 ID 는 지금처럼 **웹 입력의 내용 해시**(Dockerfile.web 의 규칙 — 해시 입력 목록에 Dockerfile 자신을 넣는 것 포함)이고, 빌드 인자로 넘기면 그 값이 이긴다. 서버 입력만 바뀐 배포에서 ID 가 그대로인지가 합격 기준이다.
- `devfake` 단계(지금 Dockerfile.server 안)는 로컬 검증용으로 유지할지 빌더가 정한다 — 남기면 루트 `Dockerfile` 안에.

### 3.2 서버가 웹을 내준다

지금 Caddyfile 이 하는 일을 서버(Fastify)가 맡는다. 값은 지금 `infra/Caddyfile` 과 같다.

| 일 | 규칙 |
| --- | --- |
| 백엔드 경로 | `/api/*` `/socket.io/*` `/bridge/*` `/runner/*` `/hooks/*` `/mcp` `/healthz` `/llms.txt` 는 지금처럼 서버 라우트. 없는 백엔드 경로는 지금처럼 서버 404 — **SPA 폴백을 타지 않는다** |
| `/assets/*` | 파일이 있으면 `Cache-Control: public, max-age=31536000, immutable`. 없으면 404(index.html 아님) |
| 나머지 GET·HEAD | 파일이 있으면 그 파일, 없으면 `index.html`. 둘 다 `Cache-Control: no-cache` |
| 보안 헤더(모든 응답) | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, Caddyfile 의 `Content-Security-Policy` 문자열 그대로, `Strict-Transport-Security: max-age=31536000` 은 `APP_ORIGIN` 이 https 일 때만 |
| 압축 | 정적 파일은 압축해 내준다(방법은 빌더 — 미리 압축 또는 플러그인) |

웹 디렉터리가 없으면(개발 서버 `pnpm -F @dodok/server dev`) 정적 서빙을 끄고 지금처럼 동작한다 — 개발은 지금처럼 Vite(5173)가 웹을 낸다. 서비스 워커(`sw.js`)·매니페스트의 캐시 헤더가 PWA 갱신과 맞는지(지금 Caddy 와 같은 `no-cache`) 확인한다.

### 3.3 클라이언트 IP 신뢰

Caddy 가 없으면 앱이 XFF 를 직접 판정한다. **믿는 프록시 주소 목록**을 env 로 받는다.

- `TRUST_PROXY` 를 `false`(기본) 또는 **IP·CIDR 쉼표 목록**으로 바꾼다. 목록이면 Fastify `trustProxy` 에 그 목록을 주고(proxy-addr — XFF 를 오른쪽에서부터 믿는 주소만 건너뛴다), 브리지 핸드셰이크·wire 소켓의 주소(`app.ts` `bridgeClientAddress` — 지금은 「XFF 첫 값」)도 **같은 판정**을 쓴다. 첫 값을 쓰는 지금 방식은 위조에 열려 있으니 바꾼다.
- `true`(모두 믿기)는 받지 않는다 — 부팅 실패로 이유를 말한다. 지금 `true` 를 쓰는 자리(compose·테스트·dev:fake·문서)는 목록이나 `false` 로 옮긴다.
- 문서: 컨테이너 프록시면 그 프록시의 **고정 IP `/32`**(공유 네트워크에서 프록시 컨테이너에 `ipv4_address` 를 준다 — 컨테이너를 다시 만들면 IP 가 바뀌어 남에게 갈 수 있다), 호스트에 깐 프록시면 compose 기본 네트워크의 게이트웨이 `/32`. 서브넷 전체를 주면 같은 네트워크의 다른 컨테이너가 XFF 를 위조할 수 있다는 것을 적는다(직전 작업이 실측: 서브넷이면 위조 통과, `/32` 면 막힘).

### 3.4 compose 와 덮어쓰기

- 루트 `compose.yaml`(Komodo 지침의 이름). `name: dodok`, 서비스 `app` 하나, 볼륨 `dodok-data:/data`, 헬스체크, `pull_policy: build`, `stop_grace_period: 15s`, 로그 로테이션, `environment:` 고정값(지금 `infra/compose.yml` 의 것 + 웹 디렉터리).
- 기본 파일은 로컬에서도 돈다: `ports: ["127.0.0.1:${DODOK_HTTP_PORT:-3000}:3000"]`(제 판단 — 루프백만 열어 프록시 없이 바깥에 드러나지 않게). 호스트에 깐 프록시는 이 포트로 보낸다.
- `.env` 는 루트 하나. compose 를 루트에서 부르므로 변수 치환과 `env_file: .env` 가 같은 파일을 읽는다 — 지금의 `ln -s ../.env infra/.env` 링크가 없어진다. Komodo 는 Run Directory 를 저장소 루트로 두면 그 자리에 `.env` 를 쓴다.
- 서버 덮어쓰기 파일 이름은 Komodo 지침 기본값 `compose.override.yaml`(docs/guideline/komodo/02-override.md — 저장소에 같은 이름이 커밋돼 있지 않다), 루트 `.gitignore` 에 `/compose.override.yaml` 로 올린다. `-f` 없이 부르면 Docker Compose 가 이 파일을 자동으로 읽으므로 검사 스크립트는 `-f compose.yaml` 을 명시한다(저장소에 예시 파일을 두지 않는다 — 내용은 문서에). 문서에 두 꼴을 싣는다:
  - **컨테이너 프록시(공유 네트워크)**: `ports: !reset []`, 외부 네트워크 `external: true` 에 붙이고 `default` 도 남긴다, `TRUST_PROXY` 를 프록시 고정 IP `/32` 로.
  - **호스트에 깐 프록시**: 포트는 기본 그대로(필요하면 `!override` 로 다른 루프백 포트), `TRUST_PROXY` 를 게이트웨이 `/32` 로.
- 서버마다 다른 값(외부 네트워크 이름·프록시 IP)은 Komodo 지침대로 Environment 의 `${VAR:?}` 이거나 서버 파일의 고정값이다. 저장소 문서에는 이름과 뜻만 쓴다.

### 3.5 프록시 쪽 요구(문서에 실을 것)

프록시가 꼭 해야 하는 것: HTTPS 종료, 모든 경로를 앱 포트 하나로, WebSocket 업그레이드(`/socket.io`·`/bridge`·`/runner`), 요청 본문 32 MB 이상(첨부 20 MiB + 여유 — 지금 Caddyfile `max_size 32MB`), 긴 연결 제한시간, `X-Forwarded-For`·`X-Forwarded-Proto` 전달. Caddy 와 nginx 예시 조각을 싣는다. **프록시 자신의 접근 로그에는 웹훅 경로 토큰(`/hooks/whk_…`)·쿼리에 잘못 실린 `dpt_` 가 원문으로 남는다** — 앱은 막을 수 없으니 경고로 적고, Caddy 면 지금 Caddyfile 의 `log … format filter` 조각을 예시로 준다.

### 3.6 정리

- `infra/` 를 통째로 없앤다(Caddyfile·Dockerfile 둘·compose 셋·`check-caddy.sh`·`local.env.example`).
- `check-caddy.sh` 의 확인 가운데 앱에 남는 것(정적·SPA 폴백·백엔드 404·캐시·보안 헤더·`/healthz`·WebSocket·앱 로그의 토큰 가림·XFF 위조 거부)은 앱을 직접 두드리는 검사 스크립트로 옮긴다. 자리는 `scripts/` 아래(이름은 빌더).
- 문서: `docs/guides/deploy.md` 와 `docs/guides/deploy-komodo.md` 를 합쳐 **`docs/guides/docker-deploy.md`** 하나로 다시 쓴다. 본문은 `docker compose` 기준(Komodo 지침 「배포 가이드는 Docker 기준으로 쓴다」), Komodo Stack 설정 표·Environment 표·덮어쓰기 파일 내용은 그 문서의 **부록 절**. 지금 deploy.md 의 운영 절(브리지 토큰·Gateway·러너·멤버·웹훅·MCP·푸시·운영 화면·백업·복원·업데이트·되돌리기·오류·보안·Docker 정리)은 내용을 살려 옮기고, Caddy 전제(80·443 개방·Let's Encrypt·Caddy 로그)를 걷는다.
- 옛 이름을 가리키는 자리를 모두 고친다 — `git grep` 으로 `infra/`·`deploy.md`·`deploy-komodo`·`check-caddy`·`Caddy` 를 찾는다(현재 약 30개 파일: `.ruler/AGENTS.md`·`.ruler/90-reference.md`·README·`.env.example`·`.dockerignore`·`.gitignore`·서버 빌드 스크립트·`llms.ts`·웹의 안내 문구·docs/guides 여럿·매뉴얼). `docs/superpowers/` 아래 지난 스펙·계획과 `.superpowers/` 는 기록이라 고치지 않는다. `.ruler/` 를 고치면 `pnpm exec ruler apply`.
- 아직 실제 서버에 배포한 적이 없으므로(사용자 확인 2026-10-20 — 이 구성을 정리한 뒤 처음 띄운다) 옛 구성에서 옮기는 이전 절차는 쓰지 않는다. 볼륨 이름(`dodok_dodok-data`)은 그대로다.

### 3.7 로컬 검증 (메인 세션 판단 — 빌더 확인에서 나온 질문)

- **저장소에 검증용 compose·Caddyfile 을 더하지 않는다.** compose 는 루트 하나라는 요청을 지킨다. 프록시 흉내(앞단 Caddy, 고정 IP `/32`)와 XFF 를 꾸며 보낼 다른 컨테이너는 검사 스크립트가 `docker network create`·`docker run` 으로 그때 만들고 끝나면 지운다(이름에 고유 접두사 — `docker … prune` 금지). 앱 직결 항목만 도는 빠른 모드와, 컨테이너를 만드는 프록시 모드를 나눠도 된다(빌더).
- **개발용 루트 `.env` 와 부딪히지 않게** 한다. 개발 `.env` 는 `APP_ORIGIN` 이 Vite(5173)라 compose 로 띄운 앱의 Origin 과 다르다. compose 가 읽을 env 파일 이름을 바꿀 수 있게 하거나(예: `env_file: ${DODOK_ENV_FILE:-.env}` — Komodo 에서는 기본값 그대로) 검사 스크립트가 별도 env 파일을 쓰게 한다. 방법은 빌더, 운영(Komodo)에서 `.env` 하나라는 꼴은 지킨다.
- `devfake` 단계를 남기면 검사 스크립트가 `docker build --target devfake` 로 직접 띄운다(compose 프로필 없음).
- 이 결정으로 바뀌는 지침 줄(`.ruler/AGENTS.md` 「로컬 검증」, `docs/guides/browser-verification.md`, live-smoke 의 로컬 Compose 절차)은 검사 스크립트 명령으로 고쳐 쓴다.

## 4. 빌더 몫

- 정적 서빙 구현 방식(플러그인 선택·라우트 순서·압축 방법), 이미지 안 웹 자리와 env 이름.
- 검사 스크립트의 이름·형태, `devfake` 단계 유지 여부.
- 서버 테스트 배치(정적 서빙·헤더·폴백·`TRUST_PROXY` 목록 판정·위조 거부).
- 문서의 절 구성. 단 본문 Docker 기준·Komodo 는 부록이라는 틀은 지킨다.

## 5. 합격 기준

1. `docker compose up -d --build`(루트, 덮어쓰기 없음) 뒤 `http://127.0.0.1:3000` 에서 로그인·채널·메시지·첨부·실시간이 된다.
2. 컨테이너 프록시 꼴(`-f compose.yaml -f compose.override.yaml`, 앞에 Caddy 컨테이너 하나를 둔 로컬 흉내)에서 HTTPS 로 같은 것이 되고, 쿠키 `Secure`·WebSocket·20 MiB 첨부가 통과한다. `config` 결과에 호스트 포트가 없다.
3. 프록시 고정 IP `/32` 면 XFF 위조로 로그인 레이트리밋을 넘지 못한다(429). 프록시가 아닌 같은 네트워크 컨테이너가 보낸 XFF 는 무시된다.
4. 백엔드 없는 경로는 404, SPA 경로는 index.html, `/assets/*` 캐시·보안 헤더가 Caddyfile 과 같다.
5. 서버만 바꾼 빌드에서 웹 빌드 ID 가 그대로, 웹을 바꾸면 바뀐다.
6. `git grep` 에 옛 경로(`infra/`·`deploy-komodo`·`check-caddy`)를 가리키는 현역 문서·코드가 없다(지난 스펙·계획 제외). 전체 테스트·typecheck·lint 통과(실행 개수 적기).
