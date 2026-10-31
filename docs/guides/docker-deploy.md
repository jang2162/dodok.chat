# 배포 — Docker 로 dodok 앱을 올리고 원격 Gateway·폰까지 잇기

dodok 은 **앱 컨테이너 하나**다 — 서버가 웹 화면·API·실시간(Socket.IO)·브리지·러너·웹훅·`/mcp`·`/llms.txt` 를 한 포트로 낸다. 저장소 루트의 `compose.yaml` 로 한 호스트에 올리고, HTTPS·도메인은 그 호스트의 리버스 프록시(Caddy·nginx 등)가 맡는다. 웹의 연결 페이지에서 원격 OpenClaw Gateway 를 하나 이상 추가하면 서버가 Gateway 마다 붙고, Gateway 마다 설치한 플러그인이 그 도메인의 브리지로 붙고, 폰이 PWA·푸시로 붙는다. 사람의 머신에서 Claude Code 같은 에이전트를 돌리는 러너도 같은 도메인으로 붙는다(「러너 설치」 절).
설계는 `docs/superpowers/specs/2026-10-20-app-only-docker-design.md`(앱 컨테이너 하나), 웹의 연결 페이지(플러그인 받기·브리지 토큰)는 `docs/superpowers/specs/2026-09-24-setup-wizard-design.md`, Gateway 여럿은 `docs/superpowers/specs/2026-10-04-multi-gateway-design.md` 다(구현과 달라진 것은 각 스펙의 「구현과 맞춘 것」 장). 각 파일이 **왜 그렇게 생겼는지는 그 파일의 머리 주석이 정본**이다 — `compose.yaml`·`Dockerfile`·`scripts/check-deploy.sh`, 서버가 웹을 내는 규칙은 `apps/server/src/http/web-static.ts`.
본문은 `docker compose` 기준이다. Komodo 의 Git Repo Stack 으로 올릴 때 Komodo 안에만 남는 설정은 끝의 「부록 — Komodo Git Repo Stack」 절이다.

표기: **[A]** dodok 호스트(Docker·Compose v2 — `!reset` 을 읽는 판, git), **[B]** Gateway 호스트, **[PC]** 개발 PC(이 저장소, Node·pnpm — `mise.toml`), **[폰]**.
명령은 [A] 의 저장소 루트에서 부른다(따로 적지 않으면).

## 무엇이 뜨나

- **서비스 `app` 하나.** 이미지는 저장소 루트 `Dockerfile` 로 [A] 에서 빌드한다(레지스트리 없음 — `pull_policy: build`). 이미지가 서버 번들·마이그레이션·플러그인 tgz·러너 tgz·빌드된 웹을 함께 품는다.
- **포트** — 컨테이너 3000. 호스트에는 `127.0.0.1:${DODOK_HTTP_PORT:-3000}` 루프백에만 연다 — 프록시 없이 바깥에 드러나지 않게. 프록시가 컨테이너면 서버 덮어쓰기 파일로 이 포트도 닫는다(「프록시 붙이기」).
- **데이터** — 볼륨 `dodok_dodok-data` 하나(`/data` — DB·첨부·VAPID 키·Gateway 디바이스·백업).
- **서버가 웹을 내는 규칙** — `/api/*`·`/socket.io/*`·`/bridge/*`·`/runner/*`·`/hooks/*`·`/mcp`·`/healthz`·`/llms.txt` 는 서버 라우트이고 없는 경로는 서버의 JSON 404 다(웹 화면으로 떨어지지 않는다). `/assets/*` 는 있는 파일만 `Cache-Control: public, max-age=31536000, immutable`, 없는 청크는 404. 나머지 GET·HEAD 는 파일이 있으면 그 파일, 없으면 `index.html` 이고 둘 다 `no-cache`(`sw.js`·매니페스트 포함 — 서비스 워커가 캐시되면 새 버전이 안 뜬다). 텍스트 파일은 이미지 빌드가 미리 만든 `.br`·`.gz` 를 `Accept-Encoding` 에 맞춰 낸다. 모든 응답에 `X-Content-Type-Options: nosniff`·`Referrer-Policy: strict-origin-when-cross-origin`·CSP(아래 「보안」), `APP_ORIGIN` 이 `https:` 면 `Strict-Transport-Security: max-age=31536000` 도.
- **HTTPS·인증서·도메인은 프록시 몫**이다. 앱은 TLS 를 하지 않는다.

## 시크릿 규칙

`docs/guides/live-smoke.md` 「시크릿 규칙」 절과 같다. 이 문서의 명령은 값을 화면에 찍지 않는 꼴이다. 배포에서 더 조심할 것:

- `.env` 를 `cat`·`grep` 하지 않는다. 값이 필요하면 서브셸에서 `. ./.env` 로 **셸 변수**로만 읽는다.
- ⚠ **`docker compose config` 와 `docker compose exec app env` 는 `.env` 값을 그대로 찍는다** — 그대로 부르지 않는다. 합쳐진 설정은 값이 안 나오는 꼴로만 본다: `docker compose config --services`(서비스 이름만), `docker compose config --quiet`(오류만), `docker compose config --format json | jq -c '.services|map_values({ports, networks, pull_policy})'`(`environment` 를 찍지 않는다).
- 서버 로그(`docker compose logs app`)는 토큰·비밀 키를 가린다(pino redact). 옮기기 전에는 그래도 `grep -c -F` 로 개수만 확인한다.
- 자동화 웹훅 주소(`/hooks/whk_…`)는 토큰이 경로에 든 주소다 — 서버 로그는 `whk_` 와 그 뒤 6자만 남기고 `…` 로 가린다(아래 「자동화 웹훅」). **프록시의 접근 로그는 앱이 가릴 수 없다**(「프록시 접근 로그」). 주소 원문은 만들 때 대화상자에 한 번 보이는 것뿐이니 채팅·이슈에 붙여 넣지 않는다.

## 준비

[A] 에 둘 것: Docker·Compose v2(덮어쓰기 파일의 `!reset` 을 읽는 판 — 이 저장소의 로컬 검증은 Docker Compose 5.6.0), git, 그리고 HTTPS 를 끝내 줄 리버스 프록시(이미 있는 것을 쓴다 — 「프록시 붙이기」). 빌드 중에 npm 레지스트리에 닿아야 한다(`pnpm fetch`·`pnpm deploy`).

### 설정 — `.env`

`.env` 는 저장소 루트에 하나 둔다(git 제외). compose 가 같은 파일을 두 번 읽는다 — 변수 치환(`${DODOK_HTTP_PORT}`·`${TRUST_PROXY}` 등, compose 파일과 같은 디렉터리의 `.env`)과 앱 설정(`compose.yaml` 의 `env_file` — 컨테이너 환경변수가 된다). 운영 번들은 `.env` 파일을 직접 읽지 않는다.

**만들기** — 토큰은 셸이 만들어 파일에만 쓴다.

```bash
cp .env.example .env && chmod 600 .env
for k in LOCAL_AUTH_TOKEN BETTER_AUTH_SECRET; do
  sed -i.bak "s/^$k=\$/$k=$(openssl rand -hex 32)/" .env; done; rm .env.bak
${EDITOR:-vi} .env      # 아래 표의 나머지 값
```

OpenClaw Gateway 의 주소·공유 토큰과 브리지 토큰은 `.env` 에 두지 않는다 — 웹의 연결 페이지에서 Gateway 를 추가하고(체크리스트 3) 그 Gateway 의 브리지 토큰을 발급한다(체크리스트 4). 둘 다 DB 에 들어간다. 서버는 Gateway 가 하나도 없어도 뜬다(시작 로그 `no OpenClaw gateway configured — add one in the connection page`).

| 값 | 배포에서 | 뜻 |
| --- | --- | --- |
| `APP_ORIGIN` | **필수** | `https://<도메인>` — 슬래시 없이 정확히. 쿠키(`Secure`)·wire 핸드셰이크 `Origin` 검사·HSTS 의 기준이라 브라우저 주소와 다르면 웹이 「실시간 연결이 거부되었습니다 — …」 배너로 막힌다 |
| `LOCAL_AUTH_TOKEN` | **필수**(≥16자) | 로그인 토큰 = owner 비밀번호. 바꾸면 기존 세션이 끊긴다 |
| `BETTER_AUTH_SECRET` | **필수**(≥32자) | 세션 서명 비밀 |
| `TRUST_PROXY` | **프록시 뒤면 필수** | 믿는 프록시 주소 — IP·CIDR 쉼표 목록, 프록시 하나면 그 주소 `/32`. 비우거나 `false` 면 아무도 믿지 않는다(모든 요청이 연결 주소로 — 프록시 뒤면 모두가 프록시 주소 하나로 묶인다). `true` 는 받지 않는다(부팅 때 설정 오류). 정하는 법은 「신뢰 주소 — `TRUST_PROXY`」 |
| `DODOK_PROXY_NETWORK` | 프록시가 컨테이너면 필수 | 프록시와 함께 쓰는 Docker 네트워크 이름 — 「컨테이너 프록시」의 덮어쓰기 파일이 읽는다 |
| `DODOK_HTTP_PORT` | 선택(기본 `3000`) | 호스트 루프백 포트(compose 치환만 — 컨테이너는 늘 3000). 호스트에 깐 프록시가 다른 포트로 보낼 때 |
| `BRIDGE_PUBLIC_URL` | 선택 | `wss://<도메인>/bridge`. 비우면 `APP_ORIGIN` 의 `https:` → `wss:` + `/bridge` 로 같은 값이 된다. 연결 페이지가 보여 주고, 발급한 설정 조각의 `bridgeUrl` 에 들어간다(서버는 이 값으로 리슨하지 않는다). 모든 Gateway 의 플러그인이 이 한 주소로 붙고, 서버는 토큰으로 어느 Gateway 의 플러그인인지 가른다 |
| `VAPID_SUBJECT` | **필수**(실제 연락처) | `mailto:<실제 주소>` 또는 `https://…`. 로컬 자리값(`localhost`·`*.local`)이면 Apple Push 가 `403 BadJwtToken` 으로 거부한다 — 폰 푸시가 안 온다 |
| `LOG_LEVEL` · `OWNER_HANDLE` · `DODOK_WORKSPACE_NAME` | 선택 | 기본 `info` · `owner` · `dodok` |
| `TZ` | 선택(IANA 이름, 예 `Asia/Seoul`) | 「하루」의 경계다 — 일일 런 상한(워크스페이스·채널)이 서버 현지 자정에 풀리고, 한도 문구 「내일 0시에 풀립니다」와 운영 화면의 「오늘」 집계도 그 자정을 따른다. 비우면 이미지 기본인 UTC 라 한국에서는 오전 9시에 하루가 바뀐다. 이미지가 시간대 데이터를 품고 있어 값만 주면 된다(`docker run --rm -e TZ=Asia/Seoul node:24.21.0-bookworm-slim node -e 'console.log(new Date(0).getHours())'` → `9`) |
| `VAPID_PUBLIC_KEY` · `VAPID_PRIVATE_KEY` | 선택 | 비우면 서버가 `/data/vapid.json` 을 만들어 쓴다(볼륨에 남는다). 키가 바뀌면 모든 기기의 푸시 구독이 무효가 된다 |
| `APNS_KEY_PATH` · `APNS_KEY_ID` · `APNS_TEAM_ID` | 선택(iOS 앱 푸시) | APNs 인증 키(.p8)의 **컨테이너 안 경로**·키 id·팀 id. 비우면 `/data/apns/key.p8`·`/data/apns/config.json`(`{ "keyId": …, "teamId": … }`)을 본다 — 둘 다 없으면 iOS 통로는 꺼진다. 절차는 아래 「네이티브 푸시 자격 증명」 |
| `FCM_SERVICE_ACCOUNT_PATH` | 선택(Android 앱 푸시) | Firebase 서비스 계정 JSON 의 컨테이너 안 경로. 비우면 `/data/fcm/service-account.json`. 없으면 Android 통로는 꺼진다 |
| `PUSH_RELAY_URL` | 쓰지 않는다 | 중앙 푸시 중계 자리 — 구현이 없어 값이 있으면 부팅 때 warn 한 줄을 남기고 무시한다 |
| `DB_PATH` · `ATTACHMENTS_DIR` | **비워 둔다** | 기본값이 `/data` 아래다. 볼륨 밖 경로를 주면 컨테이너를 다시 만들 때 그 데이터가 사라진다 |
| `HOST` · `PORT` · `DATA_DIR` · `DODOK_MIGRATIONS_DIR` · `DODOK_PLUGIN_DIR` · `DODOK_RUNNER_DIR` · `DODOK_WEB_DIR` | 무시된다 | compose 가 `environment` 로 `0.0.0.0`·`3000`·`/data`·`/app/drizzle`·`/app/plugin`(이미지가 품은 플러그인 tgz)·`/app/runner`(러너 tgz)·`/app/web`(빌드된 웹)을 고정한다. `.env.example` 을 복사해 생긴 빈 줄(`HOST=`)이 그대로 있어도 된다 — 이미지 ENV 로만 두면 그 빈 줄이 값을 덮는다 |
| `OPENCLAW_FRAME_DUMP_PATH` · `BRIDGE_URL` | 쓰지 않는다 | 진단·스파이크 전용 |

compose 가 `.env` 와 상관없이 더 고정하는 것 — 로그 로테이션(`json-file`, 파일 10 MB × 5개 — 최대 50 MB)과 `stop_grace_period: 15s`(앱의 종료 상한 10초보다 길게 — 짧으면 SIGKILL 이 먼저 와 깨끗한 종료 표지를 못 쓰고, 다음 부팅의 운영 화면에 사건 「직전 종료가 비정상」이 뜬다). 컨테이너에 먹었는지는 `docker inspect <컨테이너> --format '{{json .HostConfig.LogConfig}} {{.Config.StopTimeout}}'`.

`DODOK_WEB_BUILD_ID` 는 `.env` 에 두지 않는다 — 넘기지 않으면 이미지 빌드가 웹 입력의 내용 해시로 정한다(아래 「기동」). `.env` 에 고정하면 웹이 바뀌어도 ID 가 그대로라 클라이언트가 옛 오프라인 사본을 버리지 않는다. `DODOK_ENV_FILE` 도 운영에서는 두지 않는다 — `compose.yaml` 이 `.env` 대신 읽을 파일을 정하는 손잡이로, 로컬 검사(`scripts/check-deploy.sh`)가 개발용 `.env` 와 부딪히지 않게 쓴다.
전체 변수 목록과 기본값은 `docs/guides/project-structure.md` 「환경 변수」 장, 형식은 `.env.example`.

## 체크리스트 — 처음 배포

### 1. [A] 저장소·`.env`·프록시

```bash
git clone <저장소 URL> dodok.chat && cd dodok.chat
```

그다음 위 「설정 — `.env`」 대로 `.env` 를 만든다. 프록시가 컨테이너면 `up` 전에 「컨테이너 프록시」의 덮어쓰기 파일을 둔다. 도메인의 DNS·방화벽·인증서는 그 프록시 몫이다.

### 2. [A] 기동

```bash
docker compose up -d --build
docker compose ps                                  # app (healthy)
curl -fsS http://127.0.0.1:3000/healthz            # {"ok":true,"db":"ok"} — 컨테이너 프록시 꼴(포트를 닫음)이면 건너뛴다
```

그다음 「프록시 붙이기」대로 프록시를 잇고 공개 주소로 본다.

```bash
curl -fsS https://<도메인>/healthz                 # {"ok":true,"db":"ok"}
bash scripts/check-deploy.sh app https://<도메인> "$(docker compose ps -q app)"   # 줄마다 PASS/FAIL, 끝 줄 「PASS n / FAIL 0 / SKIP 0」
```

- `docker compose` 를 `-f` 없이 부르면 Compose 가 `compose.yaml` 과 **`compose.override.yaml`(있으면)** 을 함께 읽는다 — 이 문서의 명령은 모두 그 꼴이다. `-f compose.yaml` 을 직접 쓰는 명령에는 덮어쓰기 파일도 `-f compose.override.yaml` 로 붙여야 한다(Komodo 가 그렇게 부른다 — 부록).
- **웹 빌드 ID** 는 웹 산출물에 들어가는 값이다(`__BUILD_ID__` — 오프라인 사본을 버리는 기준, 청크·`sw.js` 이름에도 스민다). `Dockerfile` 의 `web` 단계가 웹 빌드 입력(그 단계의 「웹 빌드 ID」 주석이 경로 목록의 정본 — `Dockerfile` 자신도 든다)의 **내용 해시**로 정한다 — 서버만 바뀐 배포에서는 ID 가 그대로고 웹 산출물이 바이트 단위로 같아, 클라이언트는 새 버전 토스트도 오프라인 사본 폐기도 겪지 않는다. `Dockerfile`·루트 `.gitignore`(Tailwind 가 클래스를 찾을 파일을 거른다)·`.npmrc` 만 고친 배포도 ID 가 바뀐다(클라이언트가 청크를 한 번 다시 받는 쪽 — 안전하다). 셸 계산이 없어 얕은 클론·Komodo 에서도 같다. 빌드 로그의 `웹 빌드 ID(내용 해시): <12자>` 줄로 값을 본다.
  - 선택: `DODOK_WEB_BUILD_ID=<값> docker compose up -d --build` 로 넘기면 그 값이 이긴다. `.env` 에는 두지 않는다(위 「설정 — `.env`」).
  - 해시는 빌드 컨텍스트의 파일로 잰다 — 호스트에서 웹 입력 파일을 손으로 고쳐 빌드하면 그 변경도 ID 를 바꾼다(커밋 여부와 상관없다).
- `check-deploy.sh app` 을 1분 안에 다섯 번 넘게 돌리면 `/bridge/attachments`·`/runner/attachments` 두 줄이 429 로 FAIL 한다 — 그 두 확인이 토큰 없는 요청을 보내 브리지 실패 카운터(`LIMITS.bridgeFail`)에 쌓인다. 1분 기다리거나 `docker compose restart app`. 이 스크립트가 보지 않는 것은 아래 「확인 — `scripts/check-deploy.sh`」.

### 3. [웹] Gateway 추가·페어링 확인

Gateway 는 dodok 웹의 **연결 페이지**(`https://<도메인>/settings/connection`)에서 붙인다. 개발 PC 는 필요 없다. Gateway 가 여럿이면 Gateway 마다 이 단계와 4·5 를 되풀이한다.

**연결 페이지 열기** — 브라우저로 `https://<도메인>` 에 로그인(로그인 화면 아래 「owner 로컬 토큰으로 로그인」을 펼쳐 `LOCAL_AUTH_TOKEN`)하고 사이드바 하단 「설정」 → 「연결」 탭. owner 에게만 보인다(owner 가 아니면 탭 목록에 없고, 그 주소로 직접 가도 「권한이 없습니다」). Gateway 가 하나도 없으면 「OpenClaw Gateway」 블록이 「OpenClaw Gateway 를 추가하면 그 안의 에이전트를 채널에 데려올 수 있습니다」를 보인다. OpenClaw 가 끊겼다는 배너의 「연결 설정 보기」도 같은 곳으로 간다.

**Gateway 추가** — 「OpenClaw Gateway」 블록 머리의 「Gateway 추가」 → 이름·주소·토큰 → 「추가」.

- **이름** — 화면에 보일 이름(예: 사무실). 1~32자, 워크스페이스 안에서 겹치지 않는다(겹치면 「이미 쓰이는 이름입니다 — 다른 이름을 입력하세요.」).
- **주소** — [B] Gateway 의 WS 주소. `ws://` 또는 `wss://` 만(원격이면 `wss://…`), 주소에 사용자 이름·비밀번호를 넣을 수 없다.
- **토큰** — [B] Gateway 의 공유 토큰. 서버는 DB 에 평문으로 두고 화면·API·로그 어디에도 다시 내보내지 않는다(같은 볼륨에 그것만으로 Gateway 에 붙는 디바이스 아이덴티티가 평문으로 있어, 토큰만 암호화해도 방어가 늘지 않는다). 카드의 「수정」 대화상자에서 토큰 칸은 「바꾸려면 입력」이고, 비워 두면 그대로다.

저장하면 서버가 재시작 없이 곧바로 붙는다. 카드 머리의 배지가 상태다 — 「연결됨」·「재연결 중」·「페어링 대기」·「꺼짐」·「연결 안 됨」. 그 아래 주소·호스트·버전이 보이고, 버전이 저장소 핀(`packages/openclaw-adapter/src/version.ts` 의 `OPENCLAW_PINNED_VERSION`)과 다르면 「<버전> — 저장소가 검증한 버전(<핀>)과 다릅니다」가 붙는다. 「연결 안 됨」이면 카드가 「Gateway 주소·토큰과 서버 로그를 확인하세요.」라고 한다. 카드 머리의 「수정」·「끄기」(꺼져 있으면 「켜기」)·「삭제」는 아래 「Gateway 수정·끄기·삭제」 절.

**페어링** — 공유 토큰이면 보통 몇 초 안에 자동 승인이라 할 일이 없다(ADR 0001 「재시도하면 사람 없이 통과한다」 절). 루프백 Gateway 는 거절 없이 곧바로 붙는다(ADR 0003 「환경」 절). 카드에 「Gateway 가 이 서버의 기기 페어링 승인을 기다립니다 (요청 id …).」가 계속 보이면 「승인 명령 복사」로 `openclaw devices approve <requestId>` 를 복사해 [B] 에서 돌린다. 요청 id 를 못 받았으면 「목록 명령 복사」(`openclaw devices list`)로 목록에서 이 서버의 요청을 골라 승인한다. 5분 넘게 기다리면 「5분 넘게 승인을 기다리고 있습니다.」로 붉게 강조한다.

서버 로그로도 본다 — Gateway 연결의 줄에는 `gatewayId` 가 붙는다.

```bash
docker compose logs app | grep -E 'gateway connected|pairing required'
```

- `"gateway connected"` 줄의 `gatewayVersion` 이 저장소가 핀한 OpenClaw 버전(`packages/openclaw-adapter/package.json` 의 `@openclaw/gateway-client`)과 같은지 본다. 원격이 `2026.9.5` 이상이면 플러그인은 ADR 0004 이후 번들이어야 한다(`docs/guides/live-smoke.md` 「원격 Gateway 에서 같은 절차를」 절).
- `"gateway pairing required; retrying"` 줄이 **계속** 나오면 그 줄의 `requestId` 필드 값으로 [B] 에서 `openclaw devices approve <requestId>`.
- 디바이스 아이덴티티와 디바이스 토큰은 Gateway 마다 `/data/gateways/<Gateway id>/` 에 생긴다 — `device.json`, 그리고 Gateway 가 디바이스 토큰을 내주면 `device-tokens.json`(볼륨 — 재시작해도 다시 페어링하지 않는다). 주소를 바꾸면 그 Gateway 의 `device-tokens.json` 이 지워져 다시 페어링하고, Gateway 를 지우면 그 디렉터리가 지워진다.

### 4. [웹 → B] 플러그인 설치·브리지 토큰

플러그인 파일과 브리지 토큰도 연결 페이지에서 받는다. 플러그인 파일은 서버에 하나라 「OpenClaw Gateway」 블록 머리에서 한 번 받고, 브리지 토큰은 **Gateway 카드마다** 발급한다 — Gateway 가 여럿이면 [B] 호스트마다 같은 파일을 설치하고, 그 Gateway 카드에서 발급한 토큰을 넣는다.

**플러그인 받기** — 「OpenClaw Gateway」 블록 머리의 「플러그인 받기」가 서버 이미지가 품은 tgz(같은 커밋에서 빌드한 것)를 내려준다. 파일 이름은 `dodok-openclaw-plugin-<파일 sha256 앞 12자>.tgz` 다. 받은 파일을 화면의 「파일 sha256」과 대조하고 [B] 로 옮긴다.

```bash
shasum -a 256 <받은 파일>          # 화면의 「파일 sha256」과 같아야 한다
scp <받은 파일> <B>:/tmp/
```

화면의 「번들 sha256」은 tgz 전체가 아니라 **안의 번들 파일**(`dist/index.js`)의 sha256 이다 — [B] 에 설치한 뒤 대조하는 값이고, 서버가 「같은 빌드」를 가르는 값도 이것이다. 받기 대신 「서버에 플러그인 파일이 없습니다. 저장소에서 만든 뒤 서버를 재시작하세요.」가 보이면 이미지가 파일을 품지 못한 것이다(소스 실행의 개발 서버에서만 난다 — `pnpm -F @dodok/openclaw-plugin run pack:plugin` 뒤 서버 재시작).

**브리지 토큰 발급** — 그 Gateway 카드의 「브리지 토큰」에서 「새 토큰 발급」 → 라벨(알아볼 이름, 예: Gateway 호스트 이름 — 1~60자) → 「발급」.

- ⚠ **토큰은 발급한 카드의 Gateway 에 묶인다.** 서버는 플러그인이 낸 토큰만으로 어느 Gateway 의 플러그인인지 안다 — 다른 Gateway 호스트에 넣으면 그 플러그인은 발급한 카드의 Gateway 로 붙어, 에이전트 답이 엉뚱한 Gateway 로 간다.

- **원문은 이 대화상자에서 한 번만 보인다.** 서버는 해시만 두고, 목록·로그·새로고침·뒤로 가기 어디에서도 원문을 다시 볼 수 없다. 원문이 보이는 동안 대화상자는 「복사했습니다」로만 닫히고, 다른 곳으로 가려 하면 한 번 더 묻는다(탭 닫기·새로고침은 브라우저가 묻는다. 세션이 끝나 로그인 화면으로 보내질 때만은 묻지 않고 원문이 사라진다). 복사하지 못한 채 닫았으면 그 토큰을 폐기하고 새로 발급한다.
- 「플러그인 설정」 조각(`channels.dodok.accounts.default` 의 `bridgeUrl`·`token`)을 「플러그인 설정」 아래의 「복사」로 복사해 [B] 에서 파일로 둔다 — 붙여 넣기로 쓰면 토큰이 셸 기록·`ps` 에 남지 않는다. 파일은 고정 `/tmp` 경로가 아니라 `mktemp -d` 가 만든 자리(0700)에 둔다 — 공유 `/tmp` 의 고정 이름은 다른 사용자가 미리 만들어 둘 수 있다. 아래 [B] 설치까지 **같은 셸**에서 한다(`$dir` 를 쓴다).
  ```bash
  dir="$(mktemp -d "${TMPDIR:-/tmp}/dodok.XXXXXX")"     # [B] — 템플릿을 줘야 macOS 도 TMPDIR 을 따른다
  ( umask 077; cat > "$dir/dodok.patch.json5" )     # [B] — 조각을 붙여 넣고 Ctrl-D
  ```
- 파일을 둔 뒤 「복사했습니다」.

**[B] 설치** — 「플러그인 받기」의 설치 명령 상자 아래 「복사」(「설치 명령 복사」)가 아래 블록과 같은 명령에 받은 파일 이름과 대조할 「번들 sha256」 값을 채워 준다(계정 설정 패치 줄은 빼고 — 토큰은 발급 대화상자가 따로 준다). 아래 블록의 파일 이름 `dodok-openclaw-plugin-0.0.0.tgz` 는 개발 PC 에서 `pnpm -F @dodok/openclaw-plugin run pack:plugin` 으로 만든 파일의 이름이고, sha 줄의 대조 값은 연결 페이지의 「번들 sha256」이다.

처음 설치라면 복사한 명령의 마지막 줄(Gateway 올리기) 전에 `openclaw config patch --file "$dir/dodok.patch.json5"; rm -rf "$dir"` 를 돌린다 — 아래 블록이 그 순서다. 성공·실패와 상관없이 토큰이 든 패치 파일을 지운다. 패치가 실패하면(`openclaw config patch` 가 오류를 찍는다 — 뒤의 `rm` 이 있어 줄 전체의 종료 코드로는 가를 수 없다) 그 Gateway 카드에서 토큰을 새로 발급해 붙여 넣기부터 다시 하고, 쓰지 않은 토큰은 「폐기」한다. 블록을 손으로 칠 때는 파일 이름을 받은 파일 이름으로 바꾼다.

[B] — **Gateway 를 먼저 내리고** 설치한다(2026.9.5 는 떠 있는 Gateway 에 라이브 리로드를 시도하다 실패하면서 파일도 안 바꾼다 — `docs/guides/live-smoke.md` 「절차」 절 (b)). 계정 설정을 넣은 뒤 올린다.

```bash
# Gateway 를 내린다(호스트가 Gateway 를 돌리는 방식대로)
openclaw plugins install /tmp/dodok-openclaw-plugin-0.0.0.tgz --force --accept-capabilities
openclaw plugins inspect dodok --json | jq '.plugin.status, .plugin.channelIds'   # "loaded", ["dodok"]
sha256sum ~/.openclaw/extensions/dodok/dist/index.js      # 기본 상태 디렉터리일 때. 연결 페이지의 「번들 sha256」과 같아야 한다(macOS 는 shasum -a 256)
openclaw config patch --file "$dir/dodok.patch.json5"; rm -rf "$dir"
# Gateway 를 올린다
```

- `--accept-capabilities` 가 없으면 설치되지 않는다. 호스트에 `security.installPolicy` 가 있으면 archive 설치(`provenance-invalid`)가 막힐 수 있다 — ADR 0002 「원격 배포 절차」.
- 플러그인만 다시 설치할 때(토큰은 그대로)는 `openclaw config patch` 줄을 건너뛴다 — 연결 페이지가 복사해 주는 명령에는 처음부터 그 줄이 없다.
- 첨부를 쓰기 전에 [B] 의 `attachments.ttlHours`·`tools.fs.workspaceOnly` 를 정한다 — `docs/guides/live-smoke.md` 「원격 Gateway 에서 같은 절차를」 절의 첨부 항목.

**AI 에게 맡기는 길** — [B] 에서 셸을 쓰는 AI 에이전트(Claude Code 등)가 돌면 위 받기·설치·계정 설정을 그 AI 에게 맡길 수 있다. 브리지 토큰 발급 대화상자의 원문 바로 아래 「AI 에게 맡기기」에서 「복사」로 한 줄을 복사해 [B] 의 AI 에게 건넨다 — `<공개 오리진>/llms.txt 를 읽고 「OpenClaw Gateway 호스트」 절대로 이 호스트에 dodok 플러그인을 설치해 줘. 브리지 토큰: <원문>`. 이 줄에는 원문이 들어 있어 원문과 같은 규칙이다(이 대화상자에서 한 번만 보인다). AI 의 대화 기록에도 원문이 남는다 — 믿는 AI 에게만 건넨다.

- **`llms.txt`** — 서버가 로그인 없이 내주는 평문 안내서다(`GET /llms.txt`, `text/plain`, IP 당 분당 30 — 아래 「운영 화면」 레이트리밋 표). 서버가 자기 공개 오리진(`BRIDGE_PUBLIC_URL` 의 오리진, 없으면 `APP_ORIGIN`)·계정 설정의 `bridgeUrl`·서버가 품은 플러그인과 러너 파일의 파일 sha256·번들 sha256 을 채운다. 토큰·Gateway 목록·사람 이름은 싣지 않는다. 서버에 파일이 없으면 그 절은 「서버에 파일이 없습니다」 한 줄이고 AI 는 거기서 멈춘다. 본문 틀의 정본은 `apps/server/src/modules/setup/llms.ts` 다.
- **「OpenClaw Gateway 호스트」 절이 하는 일** — 이 체크리스트 4·5 와 같은 순서를 명령으로 적는다. ① 토큰을 0600 파일 `~/.dodok-bridge-token` 에 둔다 ② 그 토큰으로 `plugin.tgz` 를 받아 파일 sha256 을 대조한다 ③ Gateway 를 내리고 설치한 뒤 `loaded` 와 번들 sha256(`~/.openclaw/extensions/dodok/dist/index.js` — 기본 상태 디렉터리일 때)을 대조한다 ④ 계정 설정 패치 파일을 `mktemp -d` 자리에 0600 으로 만들어 적용하고, 성공·실패와 상관없이 패치 파일과 토큰 파일을 지운다 ⑤ Gateway 를 올린다. 토큰은 어떤 명령의 인자에도 싣지 않는다 — curl 은 표준 입력의 설정(`-K -`)으로 머리를 받는다.
- **AI 가 멈추고 사람에게 묻는 자리** — Gateway 를 어떻게 내리고 올리는지 모를 때, sha256 이 다를 때, 계정 설정 패치가 실패했을 때(토큰 파일이 이미 지워졌다 — 새로 발급해 다시 건네고, 쓰지 않은 토큰은 「폐기」한다), 그리고 마지막 확인: 사람이 이 연결 페이지 그 Gateway 카드의 「플러그인」이 「접속됨」·「서버와 같은 빌드입니다」인지 본다(위 5). 카드에 페어링 대기가 보이면 요청 id 를 AI 에게 준다(`openclaw devices approve <요청 id>`).
- **노드에서 토큰으로 설치 파일 받기** — `GET /api/v1/setup/plugin.tgz` 는 owner 세션 **또는** `Authorization: Bearer <브리지 토큰>`(폐기되지 않았고 묶인 Gateway 가 켜져 있을 것)으로 받는다. 폐기된 토큰·러너 토큰·틀린 값은 401 이고 브리지 실패 카운터(`bridgeFail`)에 센다. 꺼진 Gateway 의 토큰과 Bearer 없는 요청은 401 이되 세지 않는다. 로그인한 owner 아닌 사람은 403 이다. 손으로 받을 때도 토큰을 명령 인자에 넣지 않는다:
  ```bash
  printf 'header = "Authorization: Bearer %s"\n' "$(cat ~/.dodok-bridge-token)" \
    | curl -fsS -K - https://<도메인>/api/v1/setup/plugin.tgz -o /tmp/dodok-openclaw-plugin.tgz
  ```

### 5. [웹] 브리지 접속 확인

연결 페이지가 실시간으로 바뀐다(새로고침하지 않아도 된다).

- 그 Gateway 카드의 「플러그인」: 상태 「접속됨」, 플러그인·SDK·Gateway 버전, **「서버와 같은 빌드입니다」**. 「다른 빌드입니다 — 받아서 다시 설치하세요」면 [B] 에 다른 번들이 깔려 있다 — 체크리스트 4 의 받기·설치를 다시 한다. 「빌드를 알 수 없습니다 — 새로 받아 설치하세요」면 번들 sha256 을 보내지 않는 옛 플러그인이다.
- 같은 카드의 「브리지 토큰」: 방금 발급한 줄에 「지금 접속 중」. 이 카드가 아니라 다른 Gateway 카드가 「접속됨」으로 바뀌었으면 다른 카드에서 발급한 토큰을 넣은 것이다 — 체크리스트 4 의 ⚠.

서버 로그로도 본다.

```bash
docker compose logs app | grep -E 'bridge plugin hello|bridge connection rejected'
```

`"bridge plugin hello"` 줄이 있으면 플러그인이 `wss://<도메인>/bridge` 로 붙었다(Socket.IO `/socket.io/` 의 `/bridge` 네임스페이스 — 프록시가 WebSocket 업그레이드를 넘겨야 한다). 그 줄의 `gatewayVersion` 은 플러그인이 보낸 Gateway 런타임 버전이다. 같은 줄의 `pluginBuiltWithSdk` 는 플러그인 빌드 때 박힌 SDK 버전이라 Gateway 버전이 아니다.
안 붙으면: [B] 계정 설정의 `bridgeUrl` 이 카드 「브리지 토큰」 설명의 브리지 주소(`wss://`, 경로 `/bridge`)와 같은지, [B] 에서 `https://<도메인>/healthz` 가 닿는지. `"bridge connection rejected"` 의 `token mismatch from <주소>` 는 토큰이 켜진 Gateway 의 활성 토큰 어느 것과도 맞지 않는다는 뜻이다(틀린 값·폐기된 토큰·꺼졌거나 지운 Gateway 의 토큰 — 마지막 것은 아래 「운영 화면」 레이트리밋 표의 `bridgeFail` 에 세지 않는다. 재접속이 되풀이돼도 주소마다 1분에 한 줄, 넘친 수는 `(N more suppressed)`). 로그의 주소가 모두 프록시 주소 하나면 `TRUST_PROXY` 가 그 프록시와 맞지 않는다(「신뢰 주소 — `TRUST_PROXY`」).
첨부 바이트는 같은 오리진의 HTTP `/bridge/attachments` 로 오간다 — 서버 라우트라 프록시가 모든 경로를 앱에 넘기면 된다. 폐기된 토큰과 꺼진 Gateway 의 토큰은 첨부 HTTP 에서도 401 이다.

### 6. [폰] 로그인·설치·푸시

1. `https://<도메인>` → 로그인(owner 는 「owner 로컬 토큰으로 로그인」 → `LOCAL_AUTH_TOKEN` — 폰에 옮길 때는 비밀번호 관리자처럼 화면에 남지 않는 길로. 초대로 가입한 멤버는 이메일·비밀번호 — 아래 「멤버 초대·비밀번호 재설정·비활성화」).
2. iOS(16.4+): Safari 공유 → 「홈 화면에 추가」 → **그 아이콘으로 연다**(iOS 는 홈 화면 PWA 에서만 푸시가 된다). 안드로이드: Chrome 에서 연다(설치는 선택).
3. 사이드바 하단 「설정」 → 「알림」 탭(`/settings/notifications`)에서 「푸시 알림 켜기」 → OS 권한 허용.
4. [PC] 브라우저에서 에이전트에게 사람을 부르는 답을 내게 한다(예: 「@<핸들> 불러 줘」 류) — 또는 승인 요청.
5. 폰을 잠근 채 푸시가 오는지, 누르면 그 채널이 열리는지 본다.
6. **CSP 확인** — 처음 배포에서는 PC 브라우저 개발자 도구 콘솔(가능하면 iOS 는 Mac Safari 웹 속성)에서 `Content-Security-Policy` 위반 줄이 0 인지, 서비스 워커가 등록되는지, wire 가 붙는지(연결 점) 본다. 정책 글은 `apps/server/src/http/web-static.ts` 의 `SECURITY_HEADERS`(각 허용의 까닭은 그 주석). 위반이 나면 결과 표에 그 줄을 적는다.

결과는 아래 「사람이 한 번 따라 한 결과」 절에 적는다.

### 7. [A] 백업 한 번

```bash
docker compose exec app node dist/backup.js
# 백업 완료: /data/backups/<UTC 시각> (<N> bytes, <M> ms, 지움 <K>)
```

정기 백업은 아래 「백업」 절의 cron 줄.

## 프록시 붙이기

프록시는 [A] 마다 다르다(이미 도는 Caddy·nginx·Traefik·Nginx Proxy Manager 등). 저장소의 `compose.yaml` 은 고치지 않고, 서버마다 다른 것은 **서버에서만 쓰는 덮어쓰기 파일 `compose.override.yaml`**(저장소 루트, git 이 무시한다)과 `.env` 가 갖는다. 프록시는 **모든 경로를 앱 포트 하나로** 넘긴다 — 경로는 서버가 나눈다.

### 프록시가 갖출 것

- **HTTPS** — 인증서·TLS 는 프록시가 끝낸다. 앱까지는 HTTP 다. 세션 쿠키의 `Secure`·wire 핸드셰이크 `Origin` 검사·HSTS·초대·웹훅 링크는 모두 `APP_ORIGIN`·`BRIDGE_PUBLIC_URL` 로 정해지므로 프록시 → 앱 구간이 HTTP 여도 쿠키는 `Secure` 로 나가고 wire 가 붙는다.
- **모든 경로를 앱 포트 하나로** — 대상은 `http://127.0.0.1:<DODOK_HTTP_PORT>`(호스트에 깐 프록시) 또는 `http://dodok-app:3000`(공유 네트워크의 별칭 — 컨테이너 프록시). 경로를 골라 넘기는 프록시면 웹 화면(`/`·`/assets/*`·`/sw.js` …)과 함께 `/api`·`/socket.io`·`/bridge`·`/runner`·`/hooks`·`/mcp`·`/healthz`·`/llms.txt` 를 모두 넘긴다 — 하나가 빠지면 그 기능만 조용히 404 다.
- **WebSocket** — `/socket.io/` 의 업그레이드를 넘긴다(nginx 는 `proxy_http_version 1.1` 과 `Upgrade`·`Connection` 머리). 웹·플러그인·러너의 연결은 늘 열려 있고 Socket.IO 가 25초마다 핑을 보낸다 — 유휴 상한이 그보다 길어야 한다(넉넉히 몇 분 — 아래 예시는 1시간).
- **본문 크기** — 32 MB 이상(에이전트 파일 20 MiB + 여유). 작으면(nginx 기본 `client_max_body_size 1m`) 첨부가 프록시의 413 으로 끊긴다.
- **`X-Forwarded-For`** — 받은 값 뒤에 연결 주소를 덧붙이거나(nginx `$proxy_add_x_forwarded_for`) 연결 주소로 덮는다. 둘 다 된다 — 앱이 `TRUST_PROXY` 의 주소만 믿고 오른쪽부터 그 주소를 건너뛴 첫 주소를 클라이언트로 삼는다(아래 「신뢰 주소 — `TRUST_PROXY`」).
- **Host** — 앱은 Host 로 가르지 않는다(어느 Host 든 같은 사이트). 프록시의 다른 사이트와 섞이지 않게 프록시 쪽 사이트 이름만 맞춘다.
- **HSTS** — 앱이 `APP_ORIGIN` 이 `https:` 면 붙여 보낸다. 프록시도 붙이면 머리가 두 줄이 되니 한쪽만 둔다.
- **`X-Forwarded-Proto`** — 넘겨도 되지만 앱은 읽지 않는다(위 HTTPS 줄).
- **로그** — ⚠ 아래 「프록시 접근 로그」.

### 신뢰 주소 — `TRUST_PROXY`

레이트리밋(로그인 분당 5 등)과 브리지·러너·웹훅·`/mcp` 실패 카운터는 클라이언트 IP 로 건다. 앱은 연결이 `TRUST_PROXY` 의 주소에서 온 것일 때만 `X-Forwarded-For` 를 읽고, 오른쪽부터 믿는 주소를 건너뛴 첫 주소를 쓴다(Fastify `trustProxy` 와 같은 `@fastify/proxy-addr` 판정 — REST 와 소켓 핸드셰이크가 같다, `apps/server/src/http/client-address.ts`). 연결 주소가 `::ffff:` 꼴(IPv4-mapped)이어도 같은 IPv4 로 본다.

- **값은 프록시 주소 `/32` 하나**(프록시가 여럿이면 쉼표로). 컨테이너 프록시면 공유 네트워크에서 그 프록시의 고정 주소, 호스트에 깐 프록시면 이 Stack 기본 네트워크 `dodok_default` 의 게이트웨이(호스트에서 게시 포트로 들어온 연결이 그 주소에서 온 것으로 보인다).
- ⚠ **네트워크 서브넷 전체를 주지 않는다.** 같은 네트워크의 다른 컨테이너(또는 게이트웨이로 보이는 연결)가 「믿는 프록시」가 되어, 그것이 꾸민 `X-Forwarded-For` 로 레이트리밋·실패 카운터를 피한다. `scripts/check-deploy.sh proxy` 의 덮어쓰기 파일에서 `TRUST_PROXY` 를 그 네트워크의 `/24` 로 바꿔 돌리면 「XFF 위조」 두 줄이 6번 모두 401 로 FAIL 한다(`/32` 면 6번째가 429).
- ⚠ **비우면(아무도 믿지 않으면) 프록시 뒤 모든 요청이 프록시 주소 하나로 묶인다** — 로그인 1분 5회, 브리지 실패 카운터 `bridgeFail` 60초 10번이 모든 사용자·모든 Gateway·러너 몫이 된다(플러그인 하나의 틀린 토큰이 모든 Gateway·러너 연결을 막는다).
- `true`(모두 믿기)는 받지 않는다 — 부팅이 `설정 오류: TRUST_PROXY: TRUST_PROXY=true 는 받지 않는다 — …` 로 멈춘다. 이름 붙은 범위(`loopback`·`uniquelocal` 등)와 `/0` 도 설정 오류다.
- **주소가 바뀌면** — 프록시 컨테이너를 다시 만들면 주소가 바뀔 수 있다. Docker 는 비어 있는 가장 낮은 주소를 다시 주므로, 프록시가 내려간 사이 공유 네트워크에 다른 컨테이너가 뜨면 그 컨테이너가 프록시의 옛 주소를 가져가 그것이 보낸 `X-Forwarded-For` 를 믿는다. 그래서 **프록시에 고정 주소를 준다**(공유 네트워크를 `docker network create --subnet <CIDR> <이름>` 으로 만들고 프록시에 `ipv4_address`·`docker run --ip`·`docker network connect --ip`). 고정할 수 없으면 프록시를 다시 만들 때마다 주소를 다시 보고 `.env` 를 고쳐 `docker compose up -d` 한다.

### 컨테이너 프록시

프록시가 컨테이너면 앱을 그 프록시와 같은 Docker 네트워크(공유 네트워크)에 붙이고 호스트 포트를 닫는다.

1. **공유 네트워크** — 프록시와 함께 쓸 네트워크가 [A] 에 먼저 있어야 한다(`external` — 없으면 `up` 이 멈춘다). 프록시가 이미 쓰는 네트워크가 있으면 그 이름, 없으면 `docker network create --subnet <CIDR> <이름>` 으로 만들고 `docker network connect --ip <주소> <이름> <프록시 컨테이너>` 로 프록시를 고정 주소로 붙인다.
2. **신뢰 주소** — 프록시가 그 네트워크에서 갖는 주소.
   ```bash
   docker inspect <프록시 컨테이너> --format '{{(index .NetworkSettings.Networks "<네트워크>").IPAddress}}'
   ```
3. **`.env`** — `TRUST_PROXY=<그 주소>/32`, `DODOK_PROXY_NETWORK=<네트워크 이름>`.
4. **덮어쓰기 파일** — 저장소 루트에 `compose.override.yaml`(git 이 무시한다). 기본 파일의 키를 복사하지 않고 달라지는 키만 쓴다:
   ```yaml
   services:
     app:
       # 호스트 포트를 닫는다 — 열어 두면 프록시를 건너뛰는 길이 생기고, 다른 Stack 과 포트가 겹치면 up 이 멈춘다
       ports: !reset []
       environment:
         # 비어 있으면 up 이 여기서 멈춘다 — 프록시 뒤에서 비면 모든 요청이 프록시 주소 하나로 묶인다
         TRUST_PROXY: ${TRUST_PROXY:?TRUST_PROXY 가 필요하다 — 프록시 컨테이너의 고정 주소 /32}
       networks:
         # 서비스에 networks 를 쓰면 적은 것에만 붙는다 — default 도 남긴다
         default:
         proxy:
           # 프록시가 겨눌 이름. 공유 네트워크에서 서비스 이름 app 은 다른 Stack 의 app 과 겹쳐 DNS 가 둘을 번갈아 돌려준다
           aliases: [dodok-app]
   networks:
     proxy:
       external: true
       name: ${DODOK_PROXY_NETWORK:?DODOK_PROXY_NETWORK 가 필요하다 — 프록시와 함께 쓰는 Docker 네트워크 이름}
   ```
   `scripts/check-deploy.sh proxy` 가 이 꼴로 띄워 잰다(네트워크 이름·`TRUST_PROXY`·별칭만 그 검사의 임시 값을 글자로 넣는다) — 이 조각을 바꾸면 그 스크립트의 덮어쓰기 파일도 함께 바꾼다.
5. **기동·확인** — `docker compose up -d --build` → `docker compose ps` 의 PORTS 가 비어 있다. 병합 결과는 값이 나오지 않는 꼴로 본다: `docker compose config --format json | jq -c '.services|map_values({ports, networks, pull_policy})'` → `app` 의 `ports` 가 `null`, `networks` 에 `default` 와 `proxy`. 오래된 Compose 는 `!reset` 을 읽지 못한다 — 이 명령이 오류 없이 `ports` 를 `null` 로 보이는지 본다.

### 호스트에 깐 프록시

프록시가 호스트 프로세스(systemd 의 nginx·Caddy 등)면 덮어쓰기 파일 없이 기본 파일 그대로 쓴다 — 앱은 `127.0.0.1:3000` 에 열려 있고 프록시는 `http://127.0.0.1:3000` 으로 넘긴다.

- **다른 포트**가 필요하면 `.env` 의 `DODOK_HTTP_PORT` 를 바꾼다(그 값도 루프백에만 열린다). 루프백이 아닌 주소에 열어야 하면 덮어쓰기 파일에서 `ports: !override ["<주소>:<포트>:3000"]` — ⚠ 아래 루프백 줄을 먼저 읽는다.
- **신뢰 주소** — `dodok_default` 네트워크의 게이트웨이 `/32`. 그 네트워크는 첫 `up` 이 만드니 `TRUST_PROXY` 를 비운 채 한 번 올리고(그동안은 아무도 믿지 않아 모든 요청이 게이트웨이 하나로 묶인다) 값을 본 뒤 `.env` 에 넣고 `docker compose up -d`.
  ```bash
  docker network inspect dodok_default --format '{{(index .IPAM.Config 0).Gateway}}'
  ```
  `docker compose down` 뒤 다시 올리면 네트워크가 새로 생겨 게이트웨이가 바뀔 수 있다. 바뀌면 아무도 믿지 않는 쪽(한 버킷)으로 떨어지니 아래 「프록시 뒤 확인」의 「주소 확인」으로 보고 다시 넣는다.
- ⚠ **포트는 `127.0.0.1` 에만 연다.** 게이트웨이를 믿으므로 그 포트로 들어오는 연결은 모두 「믿는 프록시」가 된다. 프록시를 거치지 않고 그 포트에 닿는 누구나 꾸민 `X-Forwarded-For` 로 레이트리밋을 피한다. 루프백에만 열면 그럴 수 있는 것은 호스트의 프로세스뿐이다.
- 이 저장소의 로컬 검증(colima 의 Linux VM, Docker Engine 29.2.1)에서 호스트가 `127.0.0.1:3000` 으로 보낸 요청은 앱 로그에 그 Stack 기본 네트워크의 /24 로 보였다(로그는 /24 로 줄여 싣어 게이트웨이 `.1` 인지까지는 로그로 가를 수 없다). 다른 Docker(데스크톱·userland-proxy 를 끈 Linux 등)는 다를 수 있다 — 「프록시 뒤 확인」의 「위조 확인」·「주소 확인」으로 잰다.

### 예시 조각 — Caddy·nginx

프록시 종류마다 설정 글은 다르니 위 「프록시가 갖출 것」의 성질을 맞춘다. `<도메인>` 과 대상만 바꿔 쓴다. 이 저장소가 돌려 본 것은 `scripts/check-deploy.sh proxy` 의 Caddy 꼴(`caddy:2.11.4`, 내부 CA)뿐이다 — 아래 nginx 조각은 돌려 보지 않았다.

**Caddy** — 기본 동작이 이 목록에 맞는다(WebSocket·Host·`X-Forwarded-For`·`X-Forwarded-Proto` 를 넘기고, 믿지 않는 클라이언트가 보낸 `X-Forwarded-For` 는 자기가 본 주소로 바꾼다, 유휴 상한 없음). 본문 상한만 정한다.

```caddyfile
<도메인> {
	request_body {
		max_size 32MB
	}
	# 컨테이너 Caddy(공유 네트워크)면 dodok-app:3000, 호스트에 깐 Caddy 면 127.0.0.1:3000
	reverse_proxy dodok-app:3000
}
```

**nginx**

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
server {
    listen 443 ssl;
    http2 on;
    server_name <도메인>;
    # ssl_certificate … · ssl_certificate_key …
    client_max_body_size 32m;

    location / {
        # 호스트에 깐 nginx 면 127.0.0.1:3000, 컨테이너 nginx(공유 네트워크)면 dodok-app:3000
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
    # 웹훅 경로에는 토큰이 든다 — 접근 로그를 끈다(아래 「프록시 접근 로그」)
    location /hooks/ {
        access_log off;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 프록시 접근 로그

⚠ 앱은 웹훅 토큰(`/hooks/whk_…`)과 쿼리에 잘못 실린 개인 토큰(`?token=dpt_…`)을 **자기 로그에서** 가리지만(「자동화 웹훅」·「제어 MCP」 절), **프록시의 로그는 모른다.** 접근 로그가 켜진 프록시는 그 URL 을 원문으로 남긴다 — 로그를 읽는 사람이 그 주소로 글을 올려 런 비용을 만들 수 있다. Caddy 는 접근 로그가 꺼져 있어도 앱이 내려간 동안의 502 같은 오류 로그(`http.log.error`)에 요청 URI 를 남긴다.

- **Caddy** — 전역 옵션에 오류 로그 필터를, 사이트에 접근 로그를 켰다면 그 로그에도 같은 필터를 둔다. 꼴은 서버의 `redactUrl`(`apps/server/src/logger.ts`)과 같다 — `/hooks/` 다음 조각(대소문자 무관)은 앞 10자, 그 밖 어디든 `whk_`·`dpt_` 토큰 꼴은 접두 + 6자 뒤를 `…` 로. 필드 하나에 필터 하나라 세 규칙을 교대로 합쳤다(맞지 않은 쪽 그룹은 빈 글).
  ```caddyfile
  {
  	log default {
  		format filter {
  			request>uri regexp "((?i:/hooks/)[^/?#]{10})[^/?#]+|(whk_[\w-]{6})[\w-]+|(dpt_[\w-]{6})[\w-]+" "${1}${2}${3}…"
  		}
  	}
  }
  ```
  `log_credentials` 는 켜지 않는다 — 켜면 오류 로그에 `Authorization` 머리(개인 토큰 `dpt_`·브리지 토큰)가 원문으로 남는다.
- **nginx** — `/hooks/` 의 `access_log off`(위 조각). 쿼리의 `dpt_` 는 경로로 고를 수 없으니 `/mcp` 접근 로그도 끄거나 `$uri`(쿼리 없음)만 싣는 `log_format` 을 쓴다.
- **러너 둘러보기의 `relPath`** — 「러너」 탭의 둘러보기(`GET /api/v1/runners/:id/fs?rootId=…&relPath=…`)의 `relPath` 는 러너 머신의 디렉터리 구조다. 서버 로그는 그 값을 `…` 로 가리지만 **프록시 접근 로그에는 원문이 남는다.** 그 경로(`/api/v1/runners/`)의 접근 로그를 끄거나(nginx `location /api/v1/runners/ { access_log off; … }`) Caddy 필터에 `relPath` 쿼리를 더한다 — 서버는 쿼리 키를 퍼센트 디코드해서 보므로(`rel%50ath=` 도 같은 키) 문자열 필터는 그런 요청을 놓친다. 끄는 쪽이 확실하다.
- 확인은 개수만 세는 꼴로: 프록시 로그에서 `grep -c 'whk_[A-Za-z0-9_-]\{7,\}'`·`grep -c 'dpt_[A-Za-z0-9_-]\{7,\}'` 가 0 이어야 한다(가린 줄은 접두 뒤 6자 + `…`).

### 프록시 뒤 확인

```bash
curl -fsS https://<도메인>/healthz                                                 # {"ok":true,"db":"ok"}
bash scripts/check-deploy.sh app https://<도메인> "$(docker compose ps -q app)"      # 끝 줄 「PASS n / FAIL 0 / SKIP 0」
```

- **위조 확인** — 틀린 토큰 로그인을 XFF 를 바꿔 가며 6번 보내면 6번째가 429 여야 한다. 6번 모두 401 이면 꾸민 XFF 가 앱의 판정에 닿는 것이다(`TRUST_PROXY` 에 서브넷·이웃이 들었다).
  ```bash
  for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'content-type: application/json' \
    -H "X-Forwarded-For: 1.2.3.$i" --data '{"token":"wrong-token-xxxxxxxxxxxx"}' https://<도메인>/api/v1/auth/local; done; echo
  ```
  1분 안에 같은 주소의 정상 로그인도 막히니 사람이 쓰지 않을 때 한다(재시작하면 풀린다 — `docker compose restart app`).
- **주소 확인** — `docker compose logs app | grep -o '"remoteAddress":"[^"]*"' | sort | uniq -c` 에 클라이언트들의 주소(앞 /24)가 보여야 한다. 프록시 네트워크·게이트웨이의 주소 하나만 보이면 `TRUST_PROXY` 가 프록시와 맞지 않는다(헬스체크는 `127.0.0.0/24` 로 보인다 — 그것은 빼고 본다). 단 프록시 자체가 클라이언트를 게이트웨이 주소로 보는 환경(Docker Desktop 의 게시 포트 등)에서는 그 주소가 보이는 것이 맞다.

## 브리지 토큰 교체

브리지 토큰은 Gateway 마다 따로다 — 아래는 바꿀 Gateway 의 카드에서 한다. 토큰은 겹쳐서 바꾼다 — 새 토큰을 넣고 다시 붙는 동안 옛 토큰도 통하므로 토큰 때문에 에이전트가 멈추지는 않는다(Gateway 재시작 동안의 짧은 끊김은 있다).

1. **발급** — 그 Gateway 카드의 「브리지 토큰」에서 「새 토큰 발급」(체크리스트 4 「브리지 토큰 발급」과 같다 — 원문은 한 번만 보인다). 「플러그인 설정」 아래의 「복사」로 복사한 조각을 [B] 에서 체크리스트 4 「브리지 토큰 발급」의 붙여 넣기 블록대로(`mktemp -d` 자리의 `$dir/dodok.patch.json5`) 두고 「복사했습니다」.
2. **[B] 설정 교체** — 플러그인은 다시 설치하지 않는다.
   ```bash
   openclaw config patch --file "$dir/dodok.patch.json5"; rm -rf "$dir"     # 1번과 같은 셸 — 성공·실패와 상관없이 지운다
   # Gateway 를 재시작한다(호스트가 Gateway 를 돌리는 방식대로)
   ```
3. **접속 이동 확인** — 같은 카드의 「브리지 토큰」에서 「지금 접속 중」이 새 줄로 옮겨 가고, 옛 줄에 「이제 폐기해도 됩니다 — 플러그인이 새 토큰으로 접속해 있습니다」가 뜬다. 옮겨 가지 않으면 [B] 의 설정·재시작을 다시 본다 — 이 단계 전에는 옛 토큰을 폐기하지 않는다.
4. **옛 토큰 폐기** — 옛 줄의 「폐기」 → 확인. 그 토큰으로 붙은 세션은 곧바로 끊기고, 그 뒤 핸드셰이크·첨부 HTTP 모두 거절된다. 되돌릴 수 없다.
   - 지금 접속 중인 토큰이면 확인 대화상자가 「폐기하면 곧바로 끊기고 에이전트가 멈춥니다」라고 알린다.
   - 활성 토큰이 하나도 남지 않게 되면 두 번째 확인(「그래도 폐기」)이 뜬다. 첫 확인 버튼이 있던 자리에는 「취소」가 오고(초점도 거기), 「그래도 폐기」는 반대쪽에 잠시(600ms) 누를 수 없게 나타난다 — 두 번 누르기·Enter 연타가 두 번째 확인으로 번지지 않는다.

## Gateway 수정·끄기·삭제

연결 페이지 Gateway 카드 머리의 버튼 셋이다 — 「수정」·「끄기」(꺼져 있으면 「켜기」)·「삭제」(화면 읽기 프로그램에는 「<이름> 수정」처럼 Gateway 이름이 붙는다). owner 만 하고, 저장하면 재시작 없이 곧바로 반영된다.

- **수정** — 이름·주소·토큰. 이름만 바꾸면 다시 붙지 않는다. 주소나 토큰을 바꾸면 이 Gateway 만 다시 붙고, 진행 중인 런은 「다시 실행」 카드로 닫힌다. 주소를 바꾸면 디바이스 토큰이 지워져 다시 페어링한다(체크리스트 3 「페어링」). 플러그인과 브리지 토큰은 그대로다 — 브리지 토큰은 Gateway 주소와 상관없다.
- **끄기** — 확인 없이 바로 끈다. Gateway 연결과 그 Gateway 플러그인의 브리지 세션을 끊고, 진행 중인 런은 `ADAPTER_UNAVAILABLE` run_error 카드(「다시 실행」)로 닫는다. 꺼진 동안 그 Gateway 의 에이전트를 부르면 곧바로 같은 카드가 남는다. 꺼진 Gateway 의 브리지 토큰은 핸드셰이크·첨부 HTTP 모두 거절된다(인증 실패로는 세지 않는다). 꺼진 Gateway 는 연결 점·배너·운영 화면 상태 카드·끊김 사건에서 빠진다. 「켜기」로 다시 붙으면 그 Gateway 의 플러그인이 hello 할 때 그 Gateway 에 에이전트를 둔 채널의 프롬프트를 다시 보낸다.
- **삭제** — 카드 안에서 한 번 더 묻는다: 「「<이름>」 Gateway 를 삭제할까요?」 + 「이 Gateway 의 에이전트 N개는 남고 연결이 비어 옮기기를 기다립니다 · 브리지 토큰 M개가 지워집니다」(M 은 폐기된 토큰도 센다). 지우면 그 Gateway 의 브리지 토큰과 디바이스 디렉터리(`/data/gateways/<Gateway id>/`)가 지워지고, 에이전트는 남아 연결이 빈다 — 에이전트 화면의 그 줄에 「Gateway 가 삭제됨 — 다른 Gateway 로 옮기세요」.
  - **옮기기** — 그 줄의 「Gateway 옮기기」(owner)에서 옮길 Gateway 를 고른다. 그 Gateway 의 OpenClaw 에 같은 id 의 에이전트가 있어야 답하고, 그 Gateway 로 이미 등록된 같은 id 가 있으면 옮길 수 없다(「옮길 Gateway 에 같은 id 의 에이전트가 이미 있습니다」). 옮긴 뒤 그 에이전트의 run_error 카드 「다시 실행」은 새 Gateway 로 간다. 「Gateway 옮기기」는 연결된 에이전트 줄에도 있다 — 잘못 고른 Gateway 를 바로잡는 길도 같다.
  - 지운 Gateway 의 [B] 플러그인은 계속 다시 붙으려다 `token mismatch` 로 거절된다(카운터에는 세지 않는다) — [B] 에서 플러그인을 내리거나 계정 설정을 지운다.

## 러너 설치

러너(`@dodok/claude-runner`, 명령 `dodok-runner`)는 **사람의 머신에서** 에이전트를 돌려 dodok 채널에 붙인다 — 그 머신의 저장소를 작업 디렉터리로 쓰는 에이전트를 팀 채널에서 부르는 길이다. 지금 돌릴 수 있는 프로그램은 Claude Code 하나(Claude Agent SDK)다. OpenClaw Gateway 는 거치지 않는다. 러너는 **나가는 연결만** 쓴다 — Socket.IO `/runner` 네임스페이스(`/socket.io/`)와 첨부 HTTP `/runner/attachments` 둘 다 [A] 의 공개 도메인 443 으로 간다(둘 다 서버 라우트 — 프록시가 모든 경로를 앱에 넘기면 된다). 머신 쪽 포트는 열지 않는다.

러너의 로컬 설정은 **천장**만 쥔다 — 에이전트가 돌 수 있는 디렉터리(루트)·켜 둘 프로그램·권한 상한. 그 루트 안의 **프로젝트와 에이전트는 dodok 앱**(설정 → 「러너」·「에이전트」 탭, admin 이상)에서 더하고, 서버가 런마다 에이전트 정의를 실어 보내면 러너가 천장 안인지 보고 돌린다. 설계는 `docs/superpowers/specs/2026-10-25-runner-generalization-design.md`, 바뀌지 않은 러너 동작(승인·`post`·경로 가림·끊김)은 `docs/superpowers/specs/2026-09-27-claude-runner-design.md`(둘 다 구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장).

표기: **[R]** 러너를 돌릴 머신(macOS 또는 Linux, Node — 저장소가 재는 판은 24, npm 레지스트리에 닿는 네트워크), **[웹]** owner 로 연 연결 페이지(`/settings/connection`)의 「러너」 블록, **[웹·admin]** admin 이상으로 연 설정의 「러너」 탭(`/settings/runners`)·「에이전트」 탭.

1. **[웹] 러너 토큰** — 「새 러너 토큰 발급」 → 라벨(머신 이름) → 원문 `drn_…` 이 **한 번만** 보인다(서버는 해시만 저장). [R] 에서 `~/.dodok-runner/token` 파일에 원문 한 줄로 두고 `chmod 600 ~/.dodok-runner/token`(0600 이 아니면 러너가 켤 때마다 경고한다). 대화상자 아래의 「러너 설정」 조각은 4번 설정 파일의 뼈대다 — 둘 다 복사한 뒤 「복사했습니다」로 닫는다. 토큰은 설정 파일 본문에 적지 않는다(적으면 러너가 설정 오류로 거절한다) — 파일 대신 env `DODOK_RUNNER_TOKEN` 으로 줘도 된다. env 로 줄 때는 설정 파일에서 `tokenFile` 키를 뺀다 — 키가 있으면 env 는 무시되고 파일을 못 읽으면 끝난다. 토큰 하나 = 러너 하나다.
2. **[웹 → R] 받기·설치** — 「러너 받기」 → `dodok-claude-runner-<sha 12자>.tgz` 를 [R] 로 옮기고 `npm install -g ./dodok-claude-runner-<sha 12자>.tgz`. 서버 이미지가 같은 커밋의 러너를 품고 내려준다. 러너는 Claude Agent SDK 를 품지 않는다 — 설치할 때 npm 에서 SDK(과 플랫폼별 번들 CLI, 약 225 MB)·`socket.io-client`·`zod` 를 받는다.
3. **[R] 러너 전용 로그인** — 러너는 평소 `~/.claude` 가 아니라 **러너 전용 디렉터리**(4번 `programs.claude.configDir`)의 로그인을 쓴다(세션·메모리·설정이 섞이지 않고, macOS 키체인 항목도 디렉터리마다 따로다 — ADR 0007 「함정」). `/login` 을 마치고 나온다.
   ```bash
   CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude
   # claude 명령이 없으면 러너가 품은 번들 CLI 로(플랫폼별 패키지 디렉터리 이름은 `ls "$(node -p 'path.resolve(fs.realpathSync(process.argv[1]), "../..")' "$(command -v dodok-runner)")/node_modules/@anthropic-ai"` 로 본다 — 아래 경로의 이름과 다르면 그 이름으로 바꾼다):
   CLAUDE_CONFIG_DIR=~/.dodok-runner/claude "$(node -p 'path.resolve(fs.realpathSync(process.argv[1]), "../..")' "$(command -v dodok-runner)")/node_modules/@anthropic-ai/claude-agent-sdk-$(node -p 'process.platform+"-"+process.arch')/claude"
   ```
   러너 **전용 Claude 계정**을 권한다 — 아래 「드러나는 것」 1.
4. **[R] 설정 파일** `~/.dodok-runner/config.json`(다른 자리면 `dodok-runner --config <경로>`). 1번의 조각에서 `roots` 를 고친다. 정본은 `packages/claude-runner/src/config.ts` 의 `RunnerConfig` — 모르는 키는 거절한다.
   ```json
   {
     "serverUrl": "https://<도메인>",
     "tokenFile": "~/.dodok-runner/token",
     "maxConcurrentRuns": 3,
     "roots": [
       { "id": "src", "path": "~/src", "label": "내 저장소들" }
     ],
     "browse": true,
     "programs": {
       "claude": {
         "configDir": "~/.dodok-runner/claude",
         "maxPermissionMode": "default",
         "disallowedTools": [],
         "allowedToolsCeiling": null
       }
     }
   }
   ```
   - `serverUrl` — 공개 주소(`https://<도메인>`). 조각의 값은 `BRIDGE_PUBLIC_URL`(없으면 `APP_ORIGIN`)의 오리진이다.
   - `maxConcurrentRuns` — 동시 CLI 수(1~16, 기본 3). 런 중 CLI 하나가 약 300 MiB 다. 넘치면 서버 쪽에 대기(`RUN_QUEUED`)로 보이고 자리가 날 때까지 기다린다 — 기다림도 런 상한(10분) 안이다.
   - `roots` — 에이전트가 돌 수 있는 디렉터리(1~16개). **루트가 경계다** — 앱의 프로젝트는 루트 안의 디렉터리이고(숨김 디렉터리도 경로를 적으면 프로젝트로 만들 수 있다), 루트 밖(`..`·밖을 가리키는 링크)은 러너가 거절한다. `path` 는 있는 디렉터리여야 하고 러너는 링크를 푼 자리로 쥔다. `id` 는 영문 소문자·숫자·`-`(1~32자), 러너 안에서 유일하다 — ⚠ **바꾸거나 지우면 그 루트의 프로젝트가 모두 「루트 없음」이 되고** 그 에이전트를 부르면 「러너 설정이 이 에이전트를 허용하지 않습니다(root)」 카드다(되돌리면 「다시 실행」이 돈다). ⚠ **`label` 을 꼭 적는다** — 서버로 가는 루트 정보는 `id`·`label` 뿐인데, 안 적으면 디렉터리 이름(홈이면 계정 이름)이 라벨로 간다. 경로는 서버에 가지 않는다.
   - `browse` — `false` 면 앱의 디렉터리 둘러보기를 거절한다(경로를 직접 적어 프로젝트를 더하는 것은 된다).
   - `programs` — 적지 않은 프로그램은 꺼진 것이다. 지금은 `claude` 하나다. `configDir` 은 3번의 로그인 디렉터리.
   - `maxPermissionMode` — 앱이 에이전트에 줄 수 있는 권한 모드의 상한. 순서는 `plan` < `dontAsk` < `default` < `acceptEdits`(기본 `default`), `bypassPermissions` 는 받지 않는다(승인 카드가 뜨지 않게 된다). `allowedToolsCeiling` 이 배열이면 앱의 「허용 도구」는 그 부분집합이어야 하고(`null` 이면 상한 없음 — 그래도 권한 모드와 승인이 남는다), `disallowedTools` 는 늘 막는다. **에이전트가 이 머신에서 할 수 있는 일의 천장은 이 파일**이다 — 서버나 러너 토큰이 털려도 이 범위를 넘지 못한다. 천장을 넘는 에이전트는 런마다 러너가 거절하고 채널에 「러너 설정이 이 에이전트를 허용하지 않습니다(<항목>) — 러너 머신의 설정을 확인하세요」 + 「다시 실행」 카드가 남는다(항목은 `root`·`path`·`program`·`permissionMode`·`allowedTools`).
   - 권한 모드에서 미리 허용하지 않은 쓰기 도구(파일 쓰기·명령 실행 등)를 CLI 가 물으면 채널에 **도구 승인 카드**가 뜨고 admin 이상이 결정한다(10분 안에 아무도 안 누르면 거절). 「항상 허용」은 그 세션에만 걸리고 이 파일·작업 디렉터리의 설정에는 쓰지 않는다. CLI 가 읽기 전용으로 보는 명령 일부(`git log` 등)는 규칙이 없어도 묻지 않고 돌린다(ADR 0007 「질문별」 권한 콜백). 러너는 `mcp__dodok__post`(채널에 카드·파일 보내기)를 늘 허용하고, 채널이 아니라 러너 머신에 묻거나 알리는 `AskUserQuestion`·`PushNotification` 과 턴이 끝난 뒤에 도는 예약·원격 실행 도구(`ScheduleWakeup`·`CronCreate`·`CronDelete`·`CronList`·`RemoteTrigger`)는 늘 막는다 — 이 파일의 `disallowedTools` 와 합친다(정본 `packages/claude-runner/src/drivers/claude/run.ts` 의 `RUNNER_DISALLOWED_TOOLS`).
   - 러너는 작업 디렉터리의 `CLAUDE.md`·`.claude/settings.json` 을 읽지 않는다(`settingSources: []`). 계정의 claude.ai 커넥터도 붙이지 않는다.
   - ⚠ 옛 설정(에이전트를 이 파일의 `agents` 에 적던 판)은 「에이전트는 이제 앱에서 만듭니다 — 설정에서 agents 를 지우고 roots 를 적으세요」 한 줄을 찍고 끝난다.
5. **[R] 실행** — `dodok-runner`. 첫 줄에 러너·SDK·Claude Code 판본과 루트(id·라벨)·프로그램·동시 수, 이어서 `연결됨(서버 …)`. 연결 페이지의 그 토큰 줄에 「지금 접속 중」과 「서버와 같은 빌드입니다」가 붙고, 「러너」 탭에 그 러너의 카드(연결됨·판본·루트 라벨·프로그램 줄 — 판본·로그인·권한 상한·허용 도구 상한)가 생긴다. v1 은 사람이 터미널에서 띄운다(OS 서비스로 자동 시작하지 않는다).
6. **[웹·admin] 프로젝트 더하기** — 「러너」 탭 → 그 러너 카드의 「프로젝트 추가」 → 루트 고르기 → 「둘러보기」(디렉터리만·숨김 제외·500개까지, git 저장소 표시) 또는 「직접 입력」(루트 안의 상대 경로 — 비우면 루트 자신) → 「확인하고 추가」. 서버가 러너에 그 자리를 물어 루트 밖·없음·파일이면 사유와 함께 거절한다. 같은 러너의 같은 자리는 하나다. 붙은 러너에만 더할 수 있다.
7. **[웹·admin] 에이전트 만들기** — 「에이전트」 탭 → 「에이전트 가져오기」 → 제공자 「러너」 → 러너 → 프로젝트 → 프로그램(못 쓰는 것은 사유와 함께 흐리다) → 핸들·이름·모델·권한 모드(러너 상한까지만 고를 수 있다)·허용 도구(상한의 부분집합)·지시·DM 허용 → 「만들기」. 끊긴 러너로는 만들 수 없다. 채널에 넣고 멘션한다 — 에이전트는 그 프로젝트 디렉터리에서 돈다. 지시와 채널 프롬프트는 **매 런** 요청에 실리고, 지시나 채널 규칙(프롬프트·채널 지시·릴레이 정책)을 바꾸면 서버가 그 에이전트의 러너 세션을 다음 런에서 새로 연다 — 사람이 새 세션을 열 필요가 없고, 대가로 세션 이력(앞 도구 결과·긴 작업 문맥)을 잃는다(`docs/guides/agent-guide.md` 「러너 에이전트」). 프로그램은 만든 뒤 바꾸지 않는다(새 에이전트를 만든다), 프로젝트는 「러너」 탭의 「옮기기」로만 바뀐다.

**AI 에게 맡기는 길** — [R] 에서 셸을 쓰는 AI 에이전트가 돌면 2~5번을 그 AI 에게 맡길 수 있다. 1번 발급 대화상자의 원문 바로 아래 「AI 에게 맡기기」에서 「복사」로 한 줄을 복사해 [R] 의 AI 에게 건넨다 — `<공개 오리진>/llms.txt 를 읽고 「러너 머신」 절대로 이 머신에 dodok 러너를 설치해 줘. 러너 토큰: <원문>`(원문이 들어 있다 — 체크리스트 4 「AI 에게 맡기는 길」과 같은 규칙). `llms.txt` 의 「러너 머신」 절은 토큰을 `~/.dodok-runner/token`(0600)에 두고, 그 토큰으로 `runner.tgz` 를 받아(`Authorization: Bearer <러너 토큰>` — owner 세션 대신. 폐기된 토큰·브리지 토큰·틀린 값은 401 이고 브리지 실패 카운터에 센다) 파일 sha256·설치·번들 sha256(`$(node -p 'path.resolve(fs.realpathSync(process.argv[1]), "../..")' "$(command -v dodok-runner)")/dist/main.js`)을 대조한 뒤, 설정 파일을 만들고 `dodok-runner` 를 띄운다. 6·7번(프로젝트·에이전트)은 사람이 앱에서 한다.

- **AI 가 멈추고 사람에게 묻는 자리** — 3번 러너 전용 로그인(사람이 한다 — AI 는 명령을 보여 주고 기다린다. `claude` 명령이 없으면 위 번들 CLI 줄을 보여 준다), 4번 `roots` 의 경로·라벨·id, sha256 이 다를 때. 5번 `dodok-runner` 는 끝나지 않고 전경에 머무니, 출력에 `연결됨` 이 보이면 AI 가 사람에게 넘긴다(끄기는 Ctrl+C) — 사람이 「러너」 탭에서 그 러너가 「연결됨」인지 본다.
- 안내서의 설정 예시는 4번과 같은 꼴이다(`maxPermissionMode` `default`·도구 상한 없음). 상한을 더 낮추거나 도구 상한을 두려면 사람이 4번대로 고친다.

**드러나는 것 넷** — 연결 페이지 같은 블록에도 적혀 있다.

1. 러너 계정의 **이메일이 에이전트 문맥에 들어간다**(끌 방법이 없다) — 에이전트가 채널에 그 이메일을 쓸 수 있다. 러너 전용 계정을 권한다.
2. 채널 멤버는 **에이전트를 통해 그 프로젝트 디렉터리 안의 파일을 읽을 수 있다** — 그 에이전트를 어느 채널에 둘지는 admin 이 판단한다.
3. **토큰 하나가 그 러너의 모든 에이전트를 맡는다** — 토큰은 믿는 머신에만 준다. 새는 것이 걱정되면 「다시 발급」으로 원문을 바꾼다(아래 — 프로젝트·에이전트는 그대로).
4. **서버 쪽 admin(과 서버를 손에 넣은 사람)은 루트 안 아무 디렉터리에서, 권한 상한까지의 도구로 에이전트를 돌릴 수 있다.** 루트는 좁게, 상한은 낮게 둔다.

**파일 보내기는 macOS·Linux 만** — 에이전트가 `post` 로 작업 디렉터리 안의 파일을 채널에 보낼 때 러너는 경로의 어느 성분도 링크가 아닌지 macOS 는 `O_NOFOLLOW_ANY`, Linux 는 `/proc/self/fd` 로 확인한다. 둘 다 없는 플랫폼에서는 파일을 거절한다(카드·글은 보낸다). 작업 디렉터리 밖(`..`·밖을 가리키는 링크·밖의 절대 경로)은 어느 플랫폼에서든 거절하고, 사유만 에이전트에게 돌려준다.

**끊김·끄기**

- **서버 재시작·네트워크 끊김·덮개 닫힘** — 러너가 그때 돌던 런을 멈추고, 1초~30초 백오프로 **스스로 다시 붙는다**. 서버는 그 런을 「@<에이전트> 실행이 실패했습니다: ADAPTER_UNAVAILABLE」 + 「다시 실행」으로 닫는다 — 다시 붙은 뒤 「다시 실행」은 같은 세션을 잇는다. 60초 넘게 끊겨 있으면 운영 사건 「러너 연결 끊김」이 열리고, 붙으면 닫힌다. 끊긴 동안 「러너」 탭의 카드는 「끊김」 하나만 보인다(서버는 러너가 알린 루트·프로그램을 메모리에만 든다).
- **토큰 폐기·다시 발급·같은 토큰으로 다른 러너가 붙음** — 서버가 끊은 것이라 러너는 도는 런을 멈추고(아래 「끄기」와 같이 최대 5초 기다린다 — CLI 가 남아 턴을 이어 가지 않게) 사유를 한 줄 찍고 **끝난다**(종료 코드 2 — 같은 토큰의 두 러너가 서로를 밀어내지 않게). 다시 띄워야 한다. 서버가 러너를 거절하면(핸드셰이크의 토큰 거절 `UNAUTHORIZED`, hello 의 판본 불일치 `PROTOCOL_MISMATCH`) 역시 같은 방식으로 끝난다 — 토큰을 확인하거나 러너를 다시 받는다. 인증 실패가 반복돼 주소가 막힌 것(`RATE_LIMITED`)은 끝나지 않고 풀릴 때까지 다시 시도한다(아래 「운영 화면」 레이트리밋 표의 `bridgeFail`).
- **끄기** — `Ctrl+C`(SIGINT) 또는 SIGTERM. 러너가 도는 런을 멈추고(최대 5초) 끝난다 — 그 런은 채널에 「@<에이전트> 실행이 실패했습니다: ADAPTER_UNAVAILABLE」 카드로 닫히고, 러너를 다시 띄운 뒤 「다시 실행」으로 같은 세션을 이어 간다. 대기열에 서 있던 런도 같다. 한 번 더 누르면 기다리지 않고 끝난다. ⚠ `kill -9` 는 쓰지 않는다 — 러너만 죽고 CLI 가 남아 그 턴을 끝까지 돈다(모델 비용이 들고, 채널에 없던 답이 세션 이력에 남는다 — `docs/superpowers/reports/2026-09-29-claude-runner-harness-live-smoke-report.md` 「19.4 새로 찾은 것 (코드는 고치지 않았다)」).

**토큰 다시 발급** — 연결 페이지 토큰 줄의 「다시 발급」(owner): 같은 러너의 원문만 바뀐다 — 옛 원문은 곧바로 안 통하고 그 토큰으로 붙은 러너는 끊겨 끝나며(위), 그 러너에서 돌던 런은 「다시 실행」 카드로 닫힌다. **프로젝트·에이전트·세션은 그대로 그 러너에 남는다.** 새 원문은 한 번만 보이고, 그 대화상자의 「AI 에게 맡기기」 줄은 설치가 아니라 「토큰만 바꾸고 다시 띄우기」다. ⚠ 다시 발급하면 **먼저 러너 서비스를 멈추고** `~/.dodok-runner/token` 에 새 토큰을 넣은 뒤 띄운다 — 옛 토큰으로 되풀이해 붙으면 그 주소가 잠시 막힌다(실패 카운터). 폐기한 토큰은 다시 발급할 수 없다(새 토큰을 발급한다).

**러너 폐기·옮기기** — 토큰 「폐기」는 그 러너를 닫는다 — 프로젝트·에이전트는 남지만 런은 `ADAPTER_UNAVAILABLE` 이다. 다른 머신으로 옮기려면 새 토큰으로 그 머신에 러너를 붙이고, 「러너」 탭의 그 프로젝트 「옮기기」(admin 이상)로 옮길 러너를 고른다 — 옮길 러너가 붙어 있고 **같은 루트 id·같은 상대 경로**에 디렉터리가 있어야 하며, 옮길 러너의 천장(프로그램·권한 상한·도구 상한) 밖인 에이전트가 하나라도 있으면 아무것도 옮기지 않는다. 그 프로젝트의 에이전트가 함께 옮겨 가고 다음 런은 새 세션이다(세션 전사는 옛 머신에 남는다).

**업데이트** — 서버를 올리면(아래 「업데이트」) 새 이미지가 그 커밋의 러너 tgz 를 품는다. 연결 페이지의 토큰 줄이 「다른 빌드입니다 — 러너를 받아서 다시 설치하세요」면 2번 받기·설치를 다시 하고 러너를 다시 띄운다(`npm install -g` 가 같은 이름을 덮는다). 토큰·설정 파일·로그인은 그대로다. SDK 판본은 러너가 정확 핀으로 들고 오므로 [R] 에서 따로 올리지 않는다.

## 멤버 초대·비밀번호 재설정·비활성화

사람은 초대 링크로 들인다 — 공개 가입은 없고 메일도 보내지 않는다. 역할은 셋이다: **owner**(한 명 — `LOCAL_AUTH_TOKEN` 으로 로그인하는 계정), **admin**(에이전트 동작·비용 설정·채널의 세션 정책·세션 관리자·도구 승인·에이전트 등록·member 관리·운영 화면), **member**(채널에서 대화하기·채널 만들기·이름·설명·에이전트 넣기·빼기). 무엇을 누가 하는지의 표는 팀 스펙 `docs/superpowers/specs/2026-09-26-team-members-design.md` 「역할과 권한」 절이고, 서버가 요청마다 막는다(화면에서 숨기는 것은 편의다). 화면은 사이드바 하단 「설정」 → 「멤버」 탭(`/settings/members`, owner·admin).

**초대**

1. 「초대」 → 역할을 고른다(owner 는 멤버·관리자, admin 은 멤버만) → 「링크 만들기」.
2. 링크 `<APP_ORIGIN>/join/dit_…` 가 **한 번만** 보인다 — 서버는 해시만 저장해 다시 보여 줄 수 없다. 「복사」 → 메신저로 그 사람에게 건넨다 → 「복사했습니다」로 닫는다. 잃었으면 대기 중인 초대에서 「폐기」하고 새로 만든다.
   - 링크의 앞부분은 `.env` 의 `APP_ORIGIN` 이다. 실제 도메인(`https://<도메인>`)이 아니면 받은 사람이 엉뚱한 주소를 연다 — 틀렸으면 `.env` 를 고치고 `docker compose up -d` 뒤 새 링크를 만든다.
   - 링크는 **1회용·7일**이다. 대기 중인 초대(역할·만료)는 같은 화면 아래에 있고 「폐기」로 무효로 만든다(admin 은 관리자 초대를 폐기하지 못한다).
3. 받은 사람이 링크를 열어 핸들·표시 이름·이메일·비밀번호(12자 이상)를 넣으면 곧바로 로그인돼 첫 채널로 간다. 핸들은 사람과 에이전트를 통틀어 겹칠 수 없다(비활성 멤버의 핸들도 그 사람 몫이다). 이미 다른 계정으로 로그인된 브라우저에서 열면 폼 위에 「지금 @<핸들> 로 로그인돼 있습니다 — 가입하면 이 브라우저는 새 계정으로 바뀝니다」가 뜬다.
4. 「초대가 만료됐거나 이미 쓰였습니다」가 뜨면 쓰였거나·만료됐거나·폐기된 링크다(까닭을 가르지 않는다) — 새 링크를 만든다. 「잠시 뒤 다시 시도하세요」는 한 주소(같은 사무실 NAT 포함)에서 초대 조회·가입·재설정이 1분에 20번을 넘은 것이다(위 「운영 화면」의 레이트리밋 표).

가입한 사람은 이메일·비밀번호로 로그인한다. 채널은 워크스페이스 전원이 본다(에이전트와의 다이렉트 메시지는 주인만 — `docs/manual/user-guide.md` 「다이렉트 메시지」 절) — 그 채널에 처음 쓰거나 멘션받으면 저절로 채널에 참여하고, 그때부터 에이전트가 받는 「참여자:」 줄에 실린다(`docs/guides/agent-guide.md` 「매 턴의 인바운드」 절).

**비밀번호 재설정** — 메일이 없으므로 관리자가 링크를 만든다.

1. 멤버 줄의 「재설정 링크」 → 확인(앞서 만든 그 사람의 재설정 링크는 쓸 수 없게 된다) → 링크 `<APP_ORIGIN>/reset/drt_…` 가 한 번만 보인다 → 메신저로 건넨다. admin 은 member 에게만, owner 는 owner 를 뺀 누구에게나 만든다 — 링크를 쓸 때도 같은 규칙을 지금 역할로 다시 보고, admin 이 만든 링크는 대상이 admin 으로 오를 때 폐기돼 다시 member 로 내려가도 쓸 수 없다. **1회용·24시간.**
2. 받은 사람이 새 비밀번호를 넣으면 곧바로 로그인되고, **그 사람의 다른 로그인(다른 기기·탭의 세션과 열린 연결)은 모두 끊긴다.**
3. 본인이 비밀번호를 알면 「설정」 → 「내 계정」 탭(`/settings/account`)에서 바꾼다 — 이 기기는 남고 다른 기기의 로그인은 끊긴다.

**owner 비밀번호는 `LOCAL_AUTH_TOKEN`** 이다 — 재설정 링크도 「내 계정」의 비밀번호 칸도 없다. 바꾸려면 `.env` 의 `LOCAL_AUTH_TOKEN` 을 고치고 `docker compose up -d` — owner 의 기존 세션이 끊긴다. owner 는 이메일·비밀번호 폼으로 로그인할 수 없다(「owner 로컬 토큰으로 로그인」만).

**역할 바꾸기** — owner 만, 멤버 표의 역할 칸(관리자 ↔ 멤버). 바꾸는 즉시 적용된다(확인 대화상자가 없다). 관리자를 멤버로 내리면 그 사람이 만들어 두고 아직 쓰이지 않은 초대·재설정 링크가 모두 폐기된다 — 다시 올려도 살아나지 않는다.

**비활성화** — 멤버 줄의 「비활성화」 → 확인(「@<핸들> 을 비활성화합니다. 로그인할 수 없게 되고, 쓴 메시지는 남습니다. 다시 활성화하면 그대로 돌아옵니다.」). admin 은 member 만, owner 는 owner 를 뺀 누구나. 비활성화한 사람은 곧바로 아무것도 못 한다 — 열린 화면은 로그인 화면으로 가고, 연결이 끊기고, 푸시 구독이 지워진다. 그 사람이 만들었거나 그 사람을 겨눈 쓰이지 않은 초대·재설정 링크도 폐기된다. 계정·핸들·이메일·역할·비밀번호·채널 참여는 남는다 — 쓴 메시지는 그 이름에 「비활성」이 붙어 보이고, 멘션 후보와 에이전트가 받는 「참여자:」에서 빠지며, 멘션해도 푸시가 가지 않는다. 그 사람이 맞는 비밀번호로 로그인하면 「비활성화된 계정입니다. 관리자에게 문의하세요.」(틀리면 보통의 실패 문구 그대로), 그 이메일로 초대를 수락하면 「비활성 멤버의 이메일입니다 — 관리자에게 다시 활성화를 요청하세요」가 뜨고 초대는 쓰이지 않는다. 비활성화가 끝에서 실패하면(로그인 세션 지우기) 500 과 운영 사건 「멤버 비활성화 실패」가 남는다 — 그 사람은 이미 막혀 있고, 원인을 보고 다시 비활성화하면 남은 세션을 지운다.

**다시 활성화** — 멤버 표 아래 접힌 「비활성 멤버 N」을 펼쳐 줄의 「다시 활성화」(권한은 비활성화와 같다). 역할·채널 참여가 그대로 돌아오고 예전 비밀번호로 로그인한다. 비밀번호를 모르면 새 재설정 링크를 만든다 — 비활성 중 폐기된 링크는 되살아나지 않는다. 비활성 줄에는 역할 바꾸기·재설정 링크가 없다(다시 활성화한 뒤에 한다). 계정을 지우는 길은 없다.

## 자동화 웹훅

자동화(웹 「설정」 → 「자동화」 탭, admin 이상 — 화면 쓰는 법은 `docs/manual/user-guide.md` 「자동화 (admin 이상)」 절)의 웹훅은 바깥 서비스가 `POST https://<도메인>/hooks/whk_<토큰>` 으로 보내면 정한 채널에 문구와 그 본문을 올린다. 설계는 `docs/superpowers/specs/2026-10-05-automations-design.md`(구현과 달라진 것은 「구현과 맞춘 것」 장).

- **공개 경로** — 로그인·쿠키 없이 토큰만 본다. `/hooks/*` 는 서버 라우트다 — 경로를 골라 넘기는 프록시면 `/hooks/` 를 빼먹지 않는다(빠지면 바깥 서비스의 POST 가 프록시에서 끝난다). `/api` 밖이라 로그인 사용자의 REST 상한을 타지 않고, 토큰마다 분당 상한과 웹훅 전용 실패 카운터를 따로 쓴다(아래 「운영 화면」 레이트리밋 표).
- **주소의 오리진** — 브리지 공개 주소(`BRIDGE_PUBLIC_URL`, 없으면 `APP_ORIGIN`)의 오리진을 `https:`(`ws:` 면 `http:`)로 바꾼 것이다 — 러너 설정의 `serverUrl` 과 같은 규칙. 운영에서는 `https://<도메인>` 이다.
- **토큰** — `whk_` + 43자. DB 에는 sha256 해시와 `whk_` 뒤 6자(목록에 보이는 앞부분)만 둔다. 원문은 만들기·「주소 다시 만들기」 응답 한 번뿐이다(`Cache-Control: no-store`). 새었으면 「주소 다시 만들기」 — 옛 주소는 곧바로 404 다.
- **응답** — 받으면 `202 {"messageId":"…"}`(에이전트 답을 기다리지 않는다). 모르는 토큰·꺼 둔 자동화·예약 종류·재발급 전 옛 토큰은 **모두 같은 404** `{"code":"NOT_FOUND","message":"not found"}` 다(어느 경우인지 드러내지 않는다). 본문 64 KiB 초과 413, 토큰 상한 초과 429, 보관한 채널 409 `CHANNEL_ARCHIVED`. `Content-Type` 머리의 꼴이 틀리면(`;;;`·빈 값) Fastify 가 파서 전에 415 를 낸다. 본문은 바이트로 받아 UTF-8 로 풀고(틀린 바이트는 `�`), 타입과 무관하게 받아들인다.
- **로그 가림** — 토큰이 경로에 있어 요청 로그가 그대로 남기면 로그를 읽는 사람이 그 주소로 글을 올려 런 비용을 만든다. 서버는 요청 로그(`incoming request` 의 `url`)와 Fastify 의 404 줄(`Route POST:/hooks/… not found`)을 `/hooks/` 다음 10자(`whk_` + 6자)와 `…` 로 가린다. 그 밖 자리의 `whk_` 토큰 꼴(쿼리 등)도 같다. ⚠ 프록시의 로그는 따로 막아야 한다 — 위 「프록시 접근 로그」. 확인은 개수만 세는 꼴로:
  ```bash
  docker compose logs app | grep -c 'whk_[A-Za-z0-9_-]\{7,\}'   # 0 이어야 한다(가린 줄은 whk_ 뒤 6자 + …)
  ```
- **손으로 보내 보기** — 화면에서 복사한 주소로 `curl -sS -X POST -H 'content-type: application/json' -d '{"ok":false}' '<주소>'` → `202`. 주소를 셸 기록에 남기지 않으려면 앞에 공백을 두거나(`HISTCONTROL=ignorespace`) 변수로 읽는다.

## 제어 MCP — 바깥 클라이언트의 `/mcp`

사람이 자기 Claude Code·Claude Desktop 같은 MCP 클라이언트로 채널·에이전트 설정을 읽고 바꾸는 입구다(도구 목록·권한은 `docs/guides/agent-guide.md` 「제어 도구 — 채널·에이전트 설정 읽고 바꾸기」 절, 화면은 `docs/manual/user-guide.md` 「내 계정」 절의 「MCP 토큰」). 설계는 `docs/superpowers/specs/2026-10-06-control-mcp-design.md`(구현과 달라진 것은 「구현과 맞춘 것」 장).

- **주소는 끝 슬래시 없이 `https://<도메인>/mcp`** 다. 서버는 `/mcp` 를 정확히 받는다 — `/mcp/` 는 웹 화면(`index.html`)으로 떨어져 엉뚱한 응답이 난다. 경로를 골라 넘기는 프록시면 `/mcp` 도 넘긴다 — 「내 계정」의 `claude mcp add` 예시는 웹 페이지의 오리진에 `/mcp` 를 붙인 주소라, 빠지면 예시 명령이 404 다.
- **로그** — 서버는 제어 호출마다(`/mcp`·채널 안 에이전트 모두) info 한 줄 `control call` 을 남긴다: `tool`·`via`(`pat`·`agent`)·`userId`·`agentId`·`runId`·`result`(`ok` 또는 오류 코드)·`ms`. 인자 값·프롬프트·토큰은 싣지 않는다 — 에이전트가 무엇을 읽고 바꾸려 했는지는 이 줄과 `control_change` 사건으로 본다. OpenClaw 에이전트의 확인 카드는 5분, 그 밖은 10분이다.
- **토큰** — 사람마다 「내 계정」에서 발급하는 개인 토큰 `dpt_` + 43자(사람마다 10개). DB 에는 sha256 해시와 앞 6자만 둔다. 원문은 발급 응답 한 번뿐이다. `Authorization: Bearer dpt_…` 머리로만 받는다 — URL·쿼리의 토큰은 보지 않는다. 그 사람의 **지금 역할**로 판정하고(REST 와 같은 규칙), 비활성화하면 그 사람의 토큰이 모두 폐기된다(다시 활성화해도 되살아나지 않는다). 바깥 클라이언트의 쓰기에는 확인 카드가 없다 — 클라이언트의 도구 확인에 맡긴다.
- **붙이기** — 「내 계정」의 예시 명령 그대로다(`claude mcp add --transport http dodok https://<도메인>/mcp --header "Authorization: Bearer dpt_…"`) → `claude mcp list` 가 `dodok: … (HTTP) - ✔ Connected`. ⚠ `claude mcp get dodok` 은 머리를 원문으로 보인다(`add`·`list` 는 `[REDACTED]`) — 화면 공유 중에는 부르지 않는다. 틀리거나 폐기된 토큰이면 `list` 가 `✘ Failed to connect — Server rejected the configured Authorization header (HTTP 401) … OAuth fallback is disabled when headers.Authorization is set. Error detail: {"code":"UNAUTHORIZED","message":"mcp 토큰이 틀렸다"}` 를 보인다 — 클라이언트가 OAuth 로그인으로 빠지지 않으니, 「내 계정」에서 새 토큰을 발급해 `claude mcp remove dodok` 뒤 다시 붙인다.
- **응답** — `POST` 만 받는다(상태 없는 Streamable HTTP, JSON 응답 — SSE 없음). `GET`·`DELETE` 는 토큰과 무관하게 405 `Allow: POST`. 토큰이 없거나 틀리면 401 `{"code":"UNAUTHORIZED","message":"mcp 토큰이 틀렸다"}`(`WWW-Authenticate` 없음), 맞는 토큰이어도 비활성 멤버면 401. 도구가 거절되면 HTTP 는 200 이고 MCP 결과가 `isError: true` + `{"code","message"}`(예: member 토큰의 `set_channel_prompt` → `FORBIDDEN`).
- **실패 카운터는 `/mcp` 전용**이다 — 아래 「운영 화면」 레이트리밋 표. 같은 머신의 러너·같은 출구 주소의 Gateway 플러그인과 나눈다(틀린 토큰을 넣은 클라이언트가 그 머신의 러너 핸드셰이크·런 도중의 첨부를 막지 않게).
- **로그 가림** — 토큰은 머리로만 오므로 요청 로그에 남지 않는다(`authorization` 머리는 로그에서 가린다). 쿼리에 `?token=dpt_…` 로 잘못 넣어 보낸 요청도 서버 요청 로그가 `dpt_` 뒤 6자 + `…` 로 가린다. ⚠ 프록시의 로그는 따로 막아야 한다(위 「프록시 접근 로그」 — Caddy 면 `log_credentials` 를 켜지 않는다). 확인은 개수만 세는 꼴로:
  ```bash
  docker compose logs app | grep -c 'dpt_[A-Za-z0-9_-]\{7,\}'   # 0 이어야 한다(가린 줄은 dpt_ 뒤 6자 + …)
  ```
- **채널 안 에이전트는 이 입구를 쓰지 않는다** — 러너는 `/runner`, OpenClaw 플러그인은 `/bridge` 의 기존 연결로 같은 도구를 부르고, 쓰기는 그 런을 시킨 사람의 확인 카드를 지난다. 그래서 그 둘을 쓰려면 러너·플러그인이 제어 도구를 아는 판이어야 한다(아래 「업데이트」).

## 네이티브 푸시 자격 증명

iOS·Android **앱**(모바일 하위 프로젝트)에 알림을 보내려면 서버가 Apple·Google 에 낼 자격 증명이 있어야 한다. 웹 푸시(VAPID)는 이것과 따로 늘 켜져 있다. 설계는 `docs/superpowers/specs/2026-10-06-native-push-design.md`(구현과 달라진 것은 「구현과 맞춘 것」 장). 두 통로는 **독립**이라 한쪽만 설정해도 된다. 자격 증명이 없는 통로는 꺼진 채로 서버가 정상 부팅하고, 그 플랫폼의 기기 등록은 `503 PUSH_UNAVAILABLE` 이다. 알림 본문에는 메시지 내용이 없다 — 누가·어디(제목은 늘 `dodok`)만 실린다.

**iOS — APNs 인증 키(.p8)**

1. Apple Developer → Certificates, Identifiers & Profiles → **Keys** → 「+」 → 이름을 정하고 **Apple Push Notifications service (APNs)** 를 체크해 만든다.
2. **키 id**(10자)를 적어 두고 `.p8` 파일을 받는다. ⚠ **`.p8` 은 이때 한 번만 받을 수 있다.** 서버 백업(`node dist/backup.js`)은 이 파일을 담지 않으므로 저장소 밖 안전한 곳에 따로 둔다.
3. **팀 id**(10자)는 Developer 계정 → Membership details 에 있다.
4. 서버의 데이터 볼륨에 둔다. 컨테이너는 `node`(1000:1000)로 도니 파일이 그 사용자 몫이어야 읽힌다(`docker cp` 로 넣은 파일은 root 소유가 되고 권한 비트는 원본을 따른다 — 원본이 0600 이면 서버가 못 읽어 부팅 로그가 APNs 는 `off(key unreadable)`, FCM 은 `off(no service account)` 가 된다. 아래 `chown`·`chmod` 로 늘 맞춰 둔다):
   ```bash
   docker compose exec app mkdir -p /data/apns
   docker compose cp ./AuthKey_<키 id>.p8 app:/data/apns/key.p8
   printf '{ "keyId": "<키 id>", "teamId": "<팀 id>" }' > apns-config.json
   docker compose cp ./apns-config.json app:/data/apns/config.json
   docker compose exec -u 0 app chown -R 1000:1000 /data/apns
   docker compose exec -u 0 app chmod 600 /data/apns/key.p8
   ```
   파일 대신 `.env` 의 `APNS_KEY_PATH`(컨테이너 안 경로)·`APNS_KEY_ID`·`APNS_TEAM_ID` 로 줘도 된다 — 환경 변수가 파일보다 먼저다. 호스트에 내려 둔 원본은 안전한 곳으로 옮기고 작업 폴더에 남기지 않는다.
5. 키는 **ES256(P-256) `.p8`** 이어야 한다. 다른 곡선·RSA 키는 부팅 때 `off(invalid key)` 로 걸러진다.
6. iOS 앱이 기기 토큰을 등록할 때 `environment` 로 `sandbox`(Xcode 디버그 빌드)·`production` 을 알려 준다 — 서버는 그 값으로 `api.sandbox.push.apple.com`·`api.push.apple.com` 을 가른다. 앱의 번들 id 가 `apns-topic` 이 되므로 그 번들 id 에 푸시 기능(Capability)이 켜져 있어야 한다. 키 하나로 둘 다 보낸다.

**Android — Firebase 서비스 계정**

1. Firebase 콘솔 → 프로젝트 설정 → **서비스 계정** → 「새 비공개 키 생성」 → JSON 을 받는다. 앱(`google-services.json`)과 같은 Firebase 프로젝트의 계정이어야 한다.
2. 데이터 볼륨에 둔다(소유자 규칙은 위 iOS 4번과 같다):
   ```bash
   docker compose exec app mkdir -p /data/fcm
   docker compose cp ./<받은 파일>.json app:/data/fcm/service-account.json
   docker compose exec -u 0 app chown -R 1000:1000 /data/fcm
   docker compose exec -u 0 app chmod 600 /data/fcm/service-account.json
   ```
   경로를 바꾸려면 `.env` 의 `FCM_SERVICE_ACCOUNT_PATH`. 이것도 백업에 들어가지 않으니 원본을 안전한 곳에 둔다.
3. 키는 RSA 서비스 계정 키여야 한다 — `project_id`·`client_email`·`private_key` 가 든 파일이 아니면 `off(invalid service account)` 다.

**켜졌는지 보기** — 서버를 다시 띄운 뒤 부팅 로그 두 줄로 안다. 사유는 고정 문구라 키·이메일은 로그에 없다.

```bash
docker compose up -d --force-recreate app   # 파일만 놓았으면 다시 띄워야 읽는다
docker compose logs app | grep 'push transport'
# push transport apns: on | off(no key | no key id | no team id | key unreadable | config unreadable | invalid config | invalid key)
# push transport fcm:  on | off(no service account | invalid service account)
```

로그인한 사용자(쿠키 세션)의 `GET /api/v1/push/capabilities` 가 `{ "webpush": true, "ios": …, "android": … }` 로 같은 사실을 돌려준다. 앱은 이것으로 어느 플랫폼을 등록할 수 있는지 안다.

**운영 중 신호**
- 알림이 가지 않을 때 **자격 증명이 거절된** 것이면(APNs 403 — 토픽 문제는 400 이라 아니다 · FCM 토큰 교환 400·401·403, 발송 401·403) 기기 행은 남기고 운영 화면에 사건 「푸시 자격 증명이 거부되었습니다(apns)」·「…(fcm)」(`push_credentials_invalid`, key `push:<통로>`, 같은 통로는 확인 전 1시간 안이면 한 줄)가 뜬다 — 키를 폐기했거나 팀·키 id 가 틀렸다는 뜻이다. 고친 뒤 확인(ack)한다.
- 기기가 사라진 것(APNs 410·`BadDeviceToken`·`DeviceTokenNotForTopic`, FCM `UNREGISTERED`)은 그 기기 행만 조용히 지운다. 429·5xx·네트워크 오류는 그 알림을 버리고 warn 이다(재시도 없음 — APNs 가 GOAWAY·REFUSED_STREAM 으로 **처리하지 않은** 요청만 한 번 더 보낸다).
- 로그 수준 `debug` 면 디스패처가 `push sent`·`push skipped — watching`·`push skipped — transport off` 를 남긴다(`transport`·`result` 필드). 거절 사유(`statusCode`와 고정 문구 `reason`)는 각 통로가 warn 으로 남긴다. 토큰·키·본문은 로그에 없다.
- 로그아웃·비밀번호 변경·비활성화로 세션이 지워지면 그 세션의 기기도 지워진다(웹 구독과 같은 규칙). 세션 하나에는 기기 한 행만 둔다 — 같은 세션이 새 토큰을 등록하면 옛 토큰 행은 지워진다.

실제 기기로 한 번 쏴 보는 법은 `docs/guides/live-smoke.md` 「네이티브 푸시 손 확인」 절.

## 운영 화면

웹 「설정」 → 「운영」 탭(`/settings/operations`, owner·admin — member 에게는 탭이 없고 직접 주소는 「권한이 없습니다」)이 「어젯밤 무슨 일이 있었나」에 답한다. 외부 모니터링 스택·푸시·웹훅 알림은 없다 — 사이드바 하단 「설정」과 「운영」 탭에 붙는 배지(확인 안 한 사건 수, admin 이상)로 알아챈다. 설계는 `docs/superpowers/specs/2026-09-25-ops-hardening-design.md`(구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장).

- **상태**(맨 위 카드) — 켜진 Gateway 마다 Gateway·플러그인 연결과 Gateway 버전 세 줄(줄 이름에 Gateway 이름 — 「Gateway 「사무실」」·「플러그인 「사무실」」·「Gateway 「사무실」 버전」, 꺼진 Gateway 는 줄이 없다), 러너 연결(「러너」 줄 — 「<n>대 붙음 / 토큰 <m>개」 — 러너는 사람 PC 라 꺼져 있을 수 있어 이 줄은 강조하지 않고, 60초 넘는 끊김은 사건 「러너 연결 끊김」이 알린다), 디스크 여유, 직전 종료, 서버·DB. 문제가 있는 줄만 강조한다. 연결 줄은 wire 로 실시간이고, 나머지 칸은 사건이 올 때와 화면을 보는 동안 30초마다 다시 받는다. Gateway 버전이 저장소 핀(`packages/openclaw-adapter/src/version.ts` 의 `OPENCLAW_PINNED_VERSION`)과 다르면 「저장소가 검증한 버전(<핀>)과 다릅니다」 — 연결 페이지 Gateway 카드에도 같은 문구가 붙는다.
- **런**(표) — 「오늘 / 7일」, 채널별·에이전트별 런·실패·중지·차단. OpenClaw 에이전트 런의 토큰·금액은 「측정 불가」다 — Gateway 가 주는 출력 토큰·비용 값이 틀린다(`docs/adr/0005-usage-values.md`). 러너 에이전트 런(프로그램 Claude Code)은 러너가 CLI 의 값으로 보낸 토큰·금액이 보인다(ADR 0007 「질문별」 usage·비용). 러너가 구독 로그인이면 금액은 청구액이 아니라 공시 단가 환산이라 「환산 포함」이 붙고, 한 행에 두 종류 런이 섞이면 더한 것은 러너 런뿐이라 「런 m/n개만」이 붙는다.
- **한도** — 워크스페이스 일일 런 상한. 값을 정한 적이 없으면 **300**, 1~10000, 비우면 무제한. 채널별 상한은 각 채널 설정 「릴레이 정책」의 「일일 실행 상한」이다. 둘 다 그 채널·워크스페이스에서 오늘 **만들어진 모든 런**(사람 멘션·자동 응답·릴레이·컴포넌트 상호작용·다시 실행)을 센다 — 한도로 막혀 만들지 않은 런은 세지 않는다. 막히면 런을 만들지 않고, 그 채널에 「오늘 런 한도(N)에 도달했습니다 — 내일 0시에 풀립니다」(채널 상한이면 「이 채널의」가 붙는다)를 범위마다 **하루 한 번** 남기며, 사람이 보낸 메시지는 그대로 저장된다. 「하루」는 `TZ` 의 자정이다(위 「설정 — `.env`」).
- **시간대** — 워크스페이스 시간대(기본 `Asia/Seoul`, IANA 이름 — `+09:00` 같은 고정 오프셋은 받지 않는다). 예약 자동화의 시각 기준이고, 바꾸면 켜진 예약의 다음 실행 시각을 다시 센다. 저장값은 서버 Intl 의 정규형이다(`asia/seoul` → `Asia/Seoul`, `EST` → `America/Panama`). 한도의 「하루」는 이 값이 아니라 `TZ` 다.
- **최근 사건** — 심각도 필터·「모두 확인」·「더 보기」. 같은 종류·대상의 사건은 확인하기 전 1시간 안이면 한 줄로 묶여 「×n」이 오르고, 30일 지난 줄은 지워진다. Gateway 사건은 이름이 붙는다(「Gateway 「집」 연결 끊김」·「Gateway 「집」 플러그인 연결 끊김」·「Gateway 「집」 검증 안 된 버전 (…)」 — 이름을 바꿨으면 지금 이름, 지운 Gateway 는 사건을 연 때의 이름). 자동화 사건은 둘이다 — 「자동화 예약을 놓쳐 건너뜀」(서버가 꺼져 있어 놓친 회차가 10분을 넘었다 — 몰아 올리지 않는다)과 「자동화 실행 실패」(게시 실패 — 보관한 채널이면 「(CHANNEL_ARCHIVED)」). 끊김 사건(Gateway·플러그인)은 Gateway 마다 **60초 넘게** 끊겨야 열리고(그 안에 돌아오면 남지 않는다), 붙으면 같은 줄이 「(n분 동안)」으로 닫힌다. 「(n분 동안)」은 서버가 다시 붙은 때까지다 — Gateway 가 먼저 떠도 서버의 재접속 백오프(최대 30초)만큼 길게 나온다.
- **배지** — 확인 안 한 주의·오류 사건 수(100 이상은 「99+」). 좁은 화면에서는 채널 목록 메뉴 버튼의 빨간 점. 「모두 확인」 뒤 사라진다.
- **다시 실행** — 디스패치 실패·타임아웃으로 끝난 런의 채널 알림 「@<에이전트> 실행이 실패했습니다: <코드>」에 1회용 「다시 실행」 버튼이 붙는다(채널의 사람 누구나, 24시간). 같은 트리거로 새 런을 만들고, 한도에 걸리면 버튼은 소비되지 않는다.

**서버 로그에서 사건 모으기** — 사건을 기록한 줄마다 `event` 필드가 `ops.<kind>` 다(메시지 `ops event`). 같은 줄이 폭주해도 1초에 한 번으로 모이고 모은 수가 `coalesced` 에 실린다.

```bash
docker compose logs app | grep '"event":"ops.'
```

**`/healthz`** — 인증 없이 열려 있고 본문은 `{"ok":true,"db":"ok"}`(DB 를 못 읽으면 503 `{"ok":false,"db":"error"}`)뿐이다. 워크스페이스 id·어댑터 상세는 admin 이상만 읽는 `GET /api/v1/ops/status`(운영 화면이 읽는 것)에만 있다.

**디스크 여유** — 부팅 때와 10분마다 `DATA_DIR` 이 든 파일 시스템을 잰다. 여유가 1 GiB 미만 **또는** 5% 미만이면 사건 「디스크 여유 부족」(주의), **256 MiB 미만이면 오류이고 첨부 업로드(사람 이미지·에이전트 파일 둘 다)를 507 `INSUFFICIENT_STORAGE` 로 거절한다** — SQLite 가 쓸 자리를 남긴다. 웹 칩은 「서버 디스크 여유가 부족해 올리지 못했습니다」. 공간을 비우면 다음 측정(최대 10분 뒤, 또는 `restart app`)부터 다시 받는다. 재지 못하면(`statfs` 실패) 「알 수 없음」이고 업로드는 막지 않는다.

**레이트리밋** — 숫자의 정본은 `apps/server/src/modules/ops/limits.ts` 의 `LIMITS` 하나다(`grep -nE 'PerMin|perMin|socketsPerUser|bridgeFail' apps/server/src/modules/ops/limits.ts`). 상태는 서버 메모리에 있어 재시작하면 풀린다. 걸릴 때마다 사건 「요청 제한 발동」(정보 — 배지에는 안 잡힌다)이 남고, 주소는 IPv4 /24·IPv6 /48 로 줄여 적힌다. 「IP 당」·「주소」는 `TRUST_PROXY` 판정의 클라이언트 주소다(위 「신뢰 주소 — `TRUST_PROXY`」).

| 입구 | `LIMITS` 키 | 넘으면 |
| --- | --- | --- |
| `POST /api/v1/auth/local`(로그인)·`POST /api/v1/me/password` | `localLoginPerMin`(IP 당 분당, 둘이 한 버킷) | 429 |
| `POST /api/v1/invites/lookup`·`/accept`·`/reset`(초대·재설정 링크) | `invitePublicPerMin`(IP 당 분당, 셋이 한 버킷 — 로그인과 따로) | 429 |
| `/api/auth/*`(Better Auth) | `betterAuthPerMin`(IP 당 분당) | 429 |
| `GET /llms.txt`(노드 설치 안내서 — 로그인 없음) | `llmsTxtPerMin`(IP 당 분당) | 429 |
| `POST /hooks/<토큰>`(자동화 웹훅 — 로그인 없음) | `webhookPerMin`(토큰마다 분당, 재발급한 토큰은 새 버킷) | 429 |
| `POST /hooks/<토큰>` 의 모르는 토큰 | `bridgeFail` 과 같은 숫자의 **웹훅 전용** 카운터(브리지·러너와 나누지 않는다) | 막힌 주소에서 모르는·꺼진 토큰은 429, 사건 「브리지 인증 실패가 반복돼 주소를 막음」(detail `path: webhook`). **켜진 자동화의 토큰은 막힌 주소에서도 통과한다** — GitHub 처럼 여러 고객이 발신 주소를 나눠 쓰는 서비스에서 남의 틀린 토큰이 내 웹훅을 막지 않게 |
| `POST /api/v1/invites`·`POST /api/v1/members/:userId/reset-link`(링크 발급) | `inviteIssuePerMin`(사용자당 분당, 둘이 한 버킷) | 429 |
| 로그인 뒤 REST `/api/v1/*` | `restPerMin`(사용자당 분당) | 429 `{"code":"RATE_LIMITED"}` |
| 첨부 업로드 `POST /api/v1/attachments` | `uploadPerMin`(사용자당 분당, REST 상한 위에 한 번 더) | 429 `RATE_LIMITED` |
| wire `message.send`·`component.interact`·`run.abort` | `wire.heavy`(소켓마다 토큰 버킷 — 분당·연속) | ack `RATE_LIMITED` — 작성기는 「너무 빠르게 보내고 있습니다 — 잠시 뒤 다시」, 「다시 보내기」는 같은 메시지라 런이 두 번 뜨지 않는다 |
| wire `run.events.replay` | `wire.replay` | ack `RATE_LIMITED` |
| wire `approval.resolve` | `wire.approval` | ack `RATE_LIMITED` |
| wire `typing`·`presence.update` | `wire.chatter` | 조용히 버린다(ack 없음) |
| wire `conversation.read` | `wire.chatter`(typing·presence.update 와 소켓마다 한 버킷) | ack `RATE_LIMITED` — 웹은 버리고 다음 조건이 서면 다시 보낸다(서버 값은 커지기만 한다) |
| wire `reaction.set` | `wire.chatter`(위 셋과 소켓마다 한 버킷) | ack `RATE_LIMITED` — 웹은 그 칩을 서버가 아는 상태로 되돌리고 「반응을 저장하지 못했습니다」 |
| wire 동시 소켓 | `socketsPerUser`(사용자당) | 새 연결을 핸드셰이크에서 거절 |
| 러너가 보내는 `run.event` | `runner.events`(러너 소켓마다 토큰 버킷 — 정상 스트리밍이 걸리지 않는 숫자, 근거는 그 키의 주석) | 버린다. 서버 로그 warn `runner frames rate limited — dropped` 와 사건 key `runner:<프레임>` 은 **주소마다 1분에 한 번**, 그사이 버린 수(`dropped`)와 함께 |
| 러너가 보내는 `hello`·`outbound.post`, 그리고 열린 런·기다리는 승인을 가리키지 않거나 서버가 받아들이지 않는(계약 위반·세션 키 불일치 등) `run.final`·`run.error`·`approval.*` | `runner.control`(같은 소켓의 둘째 버킷) | 같다 — `outbound.post` 는 ack `RATE_LIMITED`(에이전트의 `post` 도구가 실패로 받는다). 그 러너의 열린 런을 닫는 `run.final`·`run.error`, 그 런의 새 승인 요청(런마다 누계 32개까지 — 철회·결정으로 줄지 않는다, 러너 어댑터 `RUN_FREE_APPROVALS`), 기다리는 승인의 철회는 버킷을 세지 않는다 — `post` 가 버킷을 비워도 런이 `runMs` 까지 매달리지 않게 |
| `POST /mcp` 의 틀린·폐기된 개인 토큰 | `bridgeFail` 과 같은 숫자의 **`/mcp` 전용** 카운터(브리지·러너·첨부·설치 파일과 나누지 않는다) | 막힌 동안은 맞는 토큰도 429 `RATE_LIMITED`(토큰을 보지 않는다), 사건 「브리지 인증 실패가 반복돼 주소를 막음」(detail `path: mcp`). 맞는 토큰이어도 비활성 멤버면 401 이되 세지 않는다 |
| 제어 도구 호출(`/mcp`·러너 `control.call`·플러그인 `control.call`) | `controlPerMin`·쓰기는 그 안에서 한 번 더 `controlWritePerMin`(주체마다 — 개인 토큰이면 그 사람, 채널 안 에이전트면 (그 에이전트, 그 런을 시킨 사람). 같은 사람의 개인 토큰과 에이전트마다 버킷이 따로다) | 도구 결과 `isError` `RATE_LIMITED`, 사건 「요청 제한 발동」(key `control:<pat\|agent>`) |
| 러너가 보내는 `control.call` | `runner.control`(위 `hello`·`outbound.post` 와 같은 버킷) | ack `RATE_LIMITED`(에이전트의 도구가 오류로 받는다). 플러그인의 `control.call` 에는 프레임 버킷이 없다 — `/bridge` 는 원래 프레임을 세지 않는다 |
| `/bridge`·`/runner` 핸드셰이크, `/bridge/attachments`·`/runner/attachments`, 토큰으로 받는 설치 파일(`GET /api/v1/setup/plugin.tgz`·`runner.tgz` 의 `Authorization: Bearer`) | `bridgeFail`(**여섯이 한 카운터**(웹훅은 위 줄의 따로 둔 카운터), **실패만** 센다 — 한 주소가 창 안에 정해진 수만큼 틀리면 그 주소를 막는다. 설치 파일은 Bearer 가 없는 요청을 세지 않는다) | 막힌 동안은 토큰을 보지 않고 거절(첨부 HTTP·설치 파일은 429 「인증 실패가 너무 많습니다」), 사건 「브리지 인증 실패가 반복돼 주소를 막음」. 성공은 카운터를 비우지 않아 막힌 주소의 정상 플러그인도 막힌 동안은 거절되고, 풀리면 저절로 붙는다 |

토큰을 바꾼 직후 옛 토큰으로 재접속을 되풀이하는 플러그인이 [B] 와 같은 주소의 정상 플러그인까지 잠시 막을 수 있다 — 옛 플러그인 설정을 먼저 고치고, 풀리기를 기다린다(아래 「오류」).

## 백업

```bash
docker compose exec app node dist/backup.js [--keep N]
```

- 서버를 멈추지 않는다 — better-sqlite3 온라인 백업을 **한 번에 전부** 복사한다(한 읽기 트랜잭션의 스냅숏이라 쓰기와 겹쳐도 온전하다). 그동안 서버는 계속 쓰고, WAL 이 잠시 자랄 수 있다.
- 결과는 `/data/backups/<UTC 시각>/` 에 `dodok.sqlite` 와 `vapid.json` 사본, 그리고 `gateways/` 디렉터리 통째(Gateway 마다 디바이스 아이덴티티·디바이스 토큰). 파일은 0600, 디렉터리는 0700.
- **보관**: 최근 7개(기본), `--keep N` 으로 바꾼다. 넘친 것은 오래된 것부터 지운다. 보관 개수는 **백업 이름 형식(`YYYY-MM-DDTHH-MM-SS-mmmZ`)** 인 디렉터리만 센다 — 오래 둘 백업은 다른 이름으로 옮겨 둔다(그대로 두면 정리가 센다).
- **`.partial-*`**: 백업은 `backups/.partial-<시각>-XXXXXX/` 에서 만든 뒤 다 되면 `<시각>/` 으로 옮긴다. 중단(Ctrl-C·`SIGTERM` 은 스스로 지운다, `SIGKILL`·전원 끊김은 남는다)으로 남은 `.partial-*` 는 **복원에 쓰지 않는다** — 1시간이 지나면 다음 백업이 지운다.
- 출력은 한 줄(시크릿 없음), 실패는 exit 1 과 `백업 실패: <사유>` 한 줄(디스크 부족이면 부분 디렉터리를 지운다).
- **네이티브 푸시 자격 증명(`/data/apns/`·`/data/fcm/`)도 들어가지 않는다** — 백업이 담는 부수 파일은 `vapid.json` 과 `gateways/` 뿐이다. 볼륨을 잃으면 APNs `.p8`(Apple 에서 다시 받을 수 없다)·서비스 계정 JSON 은 원본 보관본에서 다시 놓아야 한다(위 「네이티브 푸시 자격 증명」).
- **첨부는 백업에 들어가지 않는다** — 내용 주소(sha256) 블롭이라 백업마다 복사하지 않는다. 첨부까지 옮기려면 아래 「볼륨째 옮기기」.
- 백업은 같은 볼륨 안에 있다 — 호스트가 죽으면 같이 잃는다. 다른 곳으로 보내는 것은 사람 몫이다: `docker compose cp app:/data/backups/<이름> ./<이름>` 로 호스트에 꺼낸 뒤 옮긴다.

**cron 예시**(매일 04:00, 14개 보관). cron 에는 TTY 가 없으므로 `-T`. 저장소 루트에서 부르면 `.env`·덮어쓰기 파일을 compose 가 함께 읽는다.

```cron
0 4 * * * cd <저장소 경로> && docker compose exec -T app node dist/backup.js --keep 14 >> "$HOME/dodok-backup.log" 2>&1
```

### 볼륨째 옮기기(첨부 포함)

데이터는 볼륨 `dodok_dodok-data` 하나다(`dodok.sqlite`·WAL·`attachments/`·`vapid.json`·`gateways/`·`backups/`). 통째로 옮기면 서버를 옮길 수 있다.

```bash
docker compose stop app
docker compose run --rm --no-deps -u 0 -v "$PWD":/out --entrypoint tar app czf /out/dodok-data.tgz -C /data .
docker compose start app
```

새 호스트에서는 같은 저장소·`.env`·덮어쓰기 파일을 두고 `up` 전에 풀어 놓는다(`… run --rm --no-deps -u 0 -v "$PWD":/in --entrypoint tar app xzf /in/dodok-data.tgz -C /data` 뒤 `… run --rm -u 0 app chown -R 1000:1000 /data`). 이 두 명령은 아직 한 번도 돌려 보지 않았다 — 처음 쓰는 사람이 결과를 「사람이 한 번 따라 한 결과」 절에 적는다.

## 복원

일회용 컨테이너 안에서 한다.

```bash
docker compose stop app
docker compose run --rm --entrypoint sh app
```

컨테이너 안:

```sh
ls /data/backups                       # .partial-* 는 고르지 않는다
B=/data/backups/<고른 이름>
cp "$B/dodok.sqlite" /data/dodok.sqlite
rm -f /data/dodok.sqlite-wal /data/dodok.sqlite-shm
# 필요할 때만: cp -p "$B/vapid.json" /data/   ·   rm -rf /data/gateways && cp -pR "$B/gateways" /data/
exit
```

```bash
docker compose start app
docker compose ps     # app (healthy)
```

⚠ **WAL·SHM 삭제(`rm -f …-wal …-shm`)를 절대 빼먹지 않는다.** 남아 있으면 서버가 뜰 때 그 WAL 을 **방금 되돌린 파일 위에 재생해 복원이 조용히 무효가 된다** — 오류도 경고도 없고 `integrity_check` 도 `ok` 다.
다시 재는 법: 백업 → 메시지 몇 건 더 쓰기 → `docker kill` 로 WAL 을 남긴 채 멈추기 → `dodok.sqlite` 만 덮어 기동하면 백업 뒤의 메시지까지 보이고, WAL·SHM 을 지우고 같은 절차면 백업 시점 메시지 수다.
정상 정지(`docker compose stop`)는 서버가 DB 를 닫으며 WAL 을 합치고 지우므로 **지울 WAL 이 없는 게 정상**이다. WAL 이 남는 것은 비정상 종료(kill·크래시·OOM·전원) 뒤다 — 그래서 늘 지운다(없으면 `rm -f` 는 아무 일도 하지 않는다).

- `vapid.json` 을 되돌리면 그 백업 뒤에 켠 기기의 푸시 구독이 무효가 된다(키가 바뀐다). 키를 잃은 경우에만 되돌린다.
- `gateways/<Gateway id>/` 를 되돌리지 않고 지우면 그 Gateway 와 다시 페어링한다(체크리스트 3). 디바이스 디렉터리는 DB 의 Gateway 행과 짝이라, DB 를 되돌리면 같은 백업의 `gateways/` 를 함께 되돌리는 것이 안전하다 — 그 백업 뒤에 추가한 Gateway 는 DB 에 없으니 디렉터리가 남아도 쓰이지 않는다.

## 업데이트

```bash
docker compose exec app node dist/backup.js     # 이 백업의 이름을 적어 둔다
git rev-parse --short HEAD                      # 되돌아갈 커밋을 적어 둔다
git pull --ff-only
docker compose up -d --build
docker compose ps                               # app (healthy)
```

마이그레이션은 부팅 때 자동이다. 러너를 쓰면 연결 페이지 러너 토큰 줄의 빌드 줄도 본다 — 위 「러너 설치」 절의 「업데이트」. 새 이미지는 그 커밋의 플러그인 tgz 를 품는다 — 연결 페이지 Gateway 카드의 「플러그인」이 「다른 빌드입니다 — 받아서 다시 설치하세요」면 그 Gateway 의 [B] 에 체크리스트 4 의 받기·설치를 다시 한다(토큰은 그대로 — 계정 설정 패치 줄은 건너뛴다). 「서버와 같은 빌드입니다」면 플러그인은 그대로 둔다.

**푸시 구독이 세션에 묶이는 판(마이그레이션 `0010_push_session`)으로 올리면 기존 푸시 구독 행은 모두 지워진다** — 어느 세션이 등록했는지 몰라서다. 로그인한 채 앱을 한 번 열면 그 기기의 구독이 지금 세션으로 다시 등록된다(웹이 앱을 열 때마다 하는 동기화). 그때까지 그 기기에는 푸시가 가지 않는다.

**스레드가 있는 판(Phase 4 ① 이후)으로 올릴 때는 플러그인을 반드시 다시 설치한다.** 스레드 런은 hello 에 `threads` 를 싣는 플러그인이 붙어 있어야 돈다. 옛 플러그인이 붙어 있으면 스레드에서 에이전트를 부를 때마다 스레드에 「@dev 가 스레드에서 답하지 못했습니다 — 플러그인을 새로 설치해야 합니다(연결 페이지)」 run_error 카드(`PLUGIN_OUTDATED`)가 남고, 채널 최상위 멘션은 그대로 돈다. 다시 설치한 뒤 그 카드의 「다시 실행」을 누르면 스레드에서 답한다.

**반응이 있는 판으로 올릴 때는 플러그인을 다시 설치해야 OpenClaw 에이전트가 반응을 본다.** 서버는 에이전트의 다음 턴에 그 에이전트 메시지에 달린 반응을 싣고 플러그인이 헤더에 그 줄을 넣는데(`docs/guides/agent-guide.md` 「반응 — 지난 턴 뒤 내 메시지에 달린 것」 절), 옛 플러그인은 모르는 필드를 버린다 — 턴은 그대로 돌고 반응 줄만 없다. 연결 페이지는 그 Gateway 카드에 「다른 빌드입니다 — 받아서 다시 설치하세요」를 보인다. Claude 러너(`dodok-runner`)는 다시 설치하지 않는다 — 턴 사실은 서버가 만들어 보낸다. 반응 판의 플러그인은 hello 를 바꾸지 않아 아래 「되돌리기」에서 반응 전 서버(Phase 4 ① 이후)에도 붙는다 — 반응 줄이 없을 뿐이다. 마이그레이션(`0019_message_reactions`)이 기존 에이전트 세션의 반응 기준 시각을 마이그레이션 때로 채운다 — 올리기 전의 반응은 없으니 잃는 것이 없다.

**자동화가 있는 판으로 올릴 때는 플러그인·러너를 다시 설치하지 않는다.** 에이전트는 자동화 글을 보낸 사람 `system:automation` 으로 받는데, 플러그인과 러너가 이미 다루는 꼴이다. 마이그레이션(`0020_automations`)은 새 표만 만든다. 웹훅 수신 경로 `/hooks/*` 는 서버 라우트라 `up -d --build` 로 함께 올라간다.

**제어 MCP 가 있는 판으로 올릴 때는 플러그인과 러너를 모두 다시 설치해야 채널 안 에이전트가 제어 도구를 쓴다.** 옛 플러그인·옛 `dodok-runner` 는 도구가 없을 뿐 런은 그대로 돈다(옛 플러그인은 hello 에 `control` 을 싣지 않아 서버가 그 Gateway 의 제어 호출을 받지 않는다). 연결 페이지는 그 Gateway·러너 카드에 「다른 빌드입니다 — 받아서 다시 설치하세요」를 보인다 — 플러그인은 체크리스트 4 의 받기·설치, 러너는 위 「러너 설치」 절의 「업데이트」. 바깥 클라이언트의 `/mcp` 는 서버 라우트라 `up -d --build` 로 함께 올라간다. 마이그레이션(`0022_run_requested_by`·`0023_personal_tokens`·`0024_approval_requested_by`)은 열·표만 더한다 — 올리기 전의 런은 「시킨 사람」이 비어 있어, 그 런의 「다시 실행」으로 생긴 런도 읽기 도구만 쓴다.

**채널 세션이 있는 판으로 올릴 때는 플러그인과 `dodok-runner` 를 모두 다시 설치해야 한다 — 안 하면 에이전트 답이 저장되지 않는다.** 이 판부터 에이전트가 보내는 글(플러그인 `OutboundMessage`·러너 `RunnerOutboundPost`)은 채널 id 대신 세션(대화) id(`conversationId`)를 싣고, 첨부 올리기 헤더도 `x-dodok-channel-id` 가 아니라 `x-dodok-conversation-id` 다 — 옛 플러그인·옛 러너의 답 글·첨부는 서버 Zod 에서 거절된다. 제어 도구도 바뀌었다: 옛 판은 `read_messages` 에 `channelId` 를 보내 `VALIDATION` 이 되고 새 읽기 도구 `list_conversations` 가 없다. 연결 페이지는 그 Gateway·러너 카드에 「다른 빌드입니다 — 받아서 다시 설치하세요」를 보인다 — 플러그인은 체크리스트 4 의 받기·설치, 러너는 위 「러너 설치」 절의 「업데이트」. 마이그레이션(`0025_channel_conversations`~`0028_conversation_reads`)은 채널마다 「이전 대화」 세션 하나(id = 그 채널 id)를 만들어 그 채널의 메시지·런·에이전트 세션·읽음을 모두 옮긴다 — 저장된 세션 키가 그대로라 에이전트는 「이전 대화」에서 전 대화를 이어 간다(`docs/superpowers/reports/2026-10-26-channel-sessions-live-smoke-report.md` 「26.3 합격 기준」 기준 4). 이 마이그레이션은 `messages` 등 네 표를 다시 만들므로 올리기 전 백업(위 첫 줄)을 꼭 남긴다.

**에이전트 DM 이 있는 판으로 올릴 때는 플러그인을 다시 설치해야 OpenClaw 에이전트가 DM 인 줄 안다.** DM 의 런에서 서버가 인바운드에 주인 핸들을 싣고 플러그인이 헤더에 `다이렉트 메시지: @<주인> 님과 1:1` 줄을 넣는데(`docs/guides/agent-guide.md` 「DM — 주인과 1:1」 절), 옛 플러그인은 모르는 필드를 버린다 — DM 런은 그대로 돌고 그 줄만 없다(참여자·「DM 에는 릴레이가 없습니다」 릴레이 줄은 서버가 만들어 옛 플러그인에도 간다). 연결 페이지는 그 Gateway 카드에 「다른 빌드입니다 — 받아서 다시 설치하세요」를 보인다 — 체크리스트 4 의 받기·설치. Claude 러너(`dodok-runner`)는 다시 설치하지 않는다 — DM 의 턴 사실·DM 틀은 서버가 만들어 보낸다. 마이그레이션(`0029_agent_dms`)은 열과 인덱스만 더한다 — `channels.kind`(기존 채널은 모두 `channel`)·`dm_owner_id`·`dm_agent_id`, 유일 인덱스 `channels_dm_pair`, `agents.dm_access`(기존 에이전트는 모두 기본 `admins` — owner·admin 만 DM 을 연다). 올린 뒤 member 에게 DM 을 열어 주려면 「설정」 → 「에이전트」 탭에서 그 에이전트의 「DM 허용」을 「모두」로 바꾼다(`docs/manual/user-guide.md` 「다이렉트 메시지」 절).

**러너 일반화 판(마이그레이션 `0030_runner_provider`·`0031_runner_projects`)으로 올릴 때는 `dodok-runner` 를 다시 설치하고 설정 파일을 새 꼴로 바꿔야 한다.** 러너 프로토콜이 2 로 올라 옛 러너는 `PROTOCOL_MISMATCH` 로 끝나고, 새 러너는 `agents` 키가 든 옛 설정을 거절한다(「러너 설치」 4). 서버는 기존 러너 에이전트의 작업 디렉터리를 모르므로(러너 설정에만 있었다) **0031 이 프로젝트 없는 러너 에이전트를 모두 보관한다** — 메시지·런의 작성자로 남고, 「보관한 에이전트」 줄은 「프로젝트가 없어 되살릴 수 없습니다 — 새로 만드세요」다. 순서: 서버를 올린다 → [R] 에서 러너를 받아 다시 설치하고 설정을 `roots`·`programs` 로 바꿔 띄운다 → 「러너」 탭에서 그 디렉터리를 프로젝트로 더하고 에이전트를 새로 만든다(핸들은 보관한 에이전트가 쥐고 있으니 다른 핸들로) → 채널에 넣는다. 플러그인은 그대로다.

### 되돌리기

부팅에 실패하면(`app` 이 unhealthy·재시작 반복 — `docker compose logs app`):

순서가 중요하다 — **옛 이미지를 먼저 빌드하고, `app` 을 멈춘 채 DB 를 되돌리고, 그 뒤에야 `app` 을 시작한다.** 위 「복원」 절을 통째로 따르지 않는다: 그 절의 마지막 `start app` 은 아직 새 이미지로 뜨고, 새 코드가 되돌린 DB 에 마이그레이션을 다시 올려 되돌리기가 조용히 무효가 된다.

```bash
docker compose stop app
git checkout <적어 둔 커밋>
docker compose build
docker compose run --rm --entrypoint sh app    # 방금 빌드한 옛 이미지
```

컨테이너 안(「복원」 절과 같다 — **업데이트 직전 백업**을 고른다):

```sh
B=/data/backups/<업데이트 직전 백업 이름>
cp "$B/dodok.sqlite" /data/dodok.sqlite
rm -f /data/dodok.sqlite-wal /data/dodok.sqlite-shm
exit
```

```bash
docker compose up -d
docker compose ps     # app (healthy)
```

**서버와 플러그인의 판이 엇갈릴 때** — 되돌리기는 서버만 옛 커밋으로 가므로 Gateway 의 플러그인은 새 판 그대로 남는다.

| 서버 | 플러그인 | 결과 |
| --- | --- | --- |
| 모르는 hello capability 를 버리는 서버(Phase 4 ① 이후) | 새 판(`threads` 를 싣는다) | 붙는다 — 서버가 모르는 값만 버린다 |
| Phase 4 ① 이후 서버 | 옛 판(`threads` 없음) | 채널만 돈다 — 스레드 멘션은 `PLUGIN_OUTDATED` 카드 |
| 채널 세션 전 서버 | 채널 세션 판 | 에이전트에게 인바운드가 닿지 않는다 — 새 플러그인은 `InboundDeliver.conversationTitle` 을 필수로 읽어 옛 서버의 인바운드를 거절한다(이 롤백 경로는 지키지 않는다). 플러그인도 옛 커밋의 것으로 다시 설치한다 |
| 채널 세션 판 서버 | 채널 세션 전 판 | 붙지만 에이전트 답·첨부가 서버 Zod 에서 거절돼 저장되지 않는다(위 「업데이트」) |
| 채널 세션 판 서버(DM 전) | DM 판 | 붙는다 — 인바운드의 `dm` 은 선택 필드라 DM 전 서버의 인바운드도 그대로 받는다 |
| DM 판 서버 | DM 전 판 | 붙는다 — DM 런의 헤더에 DM 줄만 없다(위 「업데이트」) |

⚠ **되돌릴 때는 반드시 업데이트 직전 백업으로 복원한다.** 마이그레이션은 앞으로만 간다 — 새 코드가 이미 올린 스키마를 옛 코드가 읽지 못한다. 더 오래된 백업이면 그 뒤의 데이터를 잃고, 더 새 백업(업데이트 뒤)이면 옛 코드가 못 연다. 백업 뒤 업데이트 사이에 쓰인 것은 잃는다.
⚠ **에이전트 DM 판에서 DM 전 판으로 되돌릴 때 DB 를 그대로 두면 DM 이 드러난다** — DM 전 서버는 `channels.kind` 를 몰라 DM 채널(이름 `dm`)을 일반 채널처럼 모든 사람의 채널 목록·검색에 낸다. 위 순서대로 업데이트 직전 백업을 복원하면 그 백업에는 DM 이 없다.
고친 뒤 돌아올 때는 `git checkout main && git pull --ff-only` 부터 업데이트를 다시 한다(`checkout <커밋>` 은 detached HEAD 라 `pull` 이 안 된다).

## 오류

| 증상 | 원인·확인 | 고침 |
| --- | --- | --- |
| `up` 이 `port is already allocated`(`Bind for 127.0.0.1:3000 failed` 류)로 멈춤 | 호스트의 그 루프백 포트를 다른 것이 쓴다 | `.env` 의 `DODOK_HTTP_PORT` 를 빈 포트로(프록시 대상도 함께), 또는 컨테이너 프록시면 「컨테이너 프록시」의 덮어쓰기 파일로 포트를 닫는다 |
| `up` 이 `TRUST_PROXY 가 필요하다 — …`·`DODOK_PROXY_NETWORK 가 필요하다 — …` 로 멈춤 | 덮어쓰기 파일(「컨테이너 프록시」)이 읽는 값이 `.env` 에 없다 | `.env` 에 값을 넣는다 |
| `up` 이 `network … declared as external, but could not be found` 로 멈춤 | 공유 네트워크가 [A] 에 없다 | 「컨테이너 프록시」 1 |
| 프록시가 502·연결 거부 | `app` 이 아직 안 떴거나 재시작 중 — 또는 프록시 대상이 틀렸다(컨테이너 프록시면 공유 네트워크·별칭 `dodok-app`, 호스트 프록시면 `127.0.0.1:<DODOK_HTTP_PORT>`) | `docker compose ps`·`logs app`, 프록시 대상 |
| 모든 화면 경로(`/`·`/c/…`)가 JSON 404 `Route GET:/ not found` | 서버가 웹을 내지 않는다 — 부팅 로그에 `DODOK_WEB_DIR 에 index.html 이 없다` 가 있으면 이미지의 웹 단계가 빠졌다(소스 실행의 개발 서버는 원래 웹을 내지 않는다 — Vite 가 낸다) | `docker compose build` 로그의 `web` 단계·`precompress-web` 줄, `DODOK_WEB_DIR` 은 compose 가 고정한다 |
| 프록시 뒤에서 로그인 429 가 모두에게 함께 걸림(또는 플러그인 하나의 틀린 토큰에 모든 Gateway·러너 연결이 함께 막힘), 앱 로그 `remoteAddress` 가 프록시 네트워크 하나 | `TRUST_PROXY` 가 비었거나 프록시의 지금 주소와 다르다(프록시 컨테이너를 다시 만들어 주소가 바뀌었다 등). 그 옛 주소를 다른 컨테이너가 받았으면 그 컨테이너가 보낸 `X-Forwarded-For` 를 믿는다 | 「신뢰 주소 — `TRUST_PROXY`」로 주소를 다시 보고 `.env` 를 고쳐 `docker compose up -d`. 다시 바뀌지 않게 프록시에 고정 주소를 준다 |
| `app` 이 재시작을 되풀이 | `.env` 필수 값이 없거나 틀렸다 — `docker compose logs app` 에 `Error: 설정 오류:` 줄(그 위에 소스 위치와 `^` 줄이 먼저 나온다)과 그 아래 틀린 항목마다 한 줄(`<이름>: <사유>`, 예 `TRUST_PROXY: TRUST_PROXY=true 는 받지 않는다 — …`), 이어서 Node 스택 | 그 값을 고치고 `up -d` |
| `app` 로그 한 줄: `설정 오류: DATA_DIR 에 쓸 수 없다: /data (EACCES) — 컨테이너면 볼륨 소유자를 1000:1000 으로: …` | 볼륨이 다른 UID(예: root)로 채워진 적이 있다. 컨테이너는 `node`(1000:1000)로 돈다. 빈 볼륨은 Docker 가 이미지의 `/data` 소유자를 입혀 이 경우가 안 생긴다 — 파일이 이미 든 볼륨에서만 난다 | `docker compose run --rm -u 0 app chown -R 1000:1000 /data` 뒤 `up -d` |
| 업데이트 뒤 `app` unhealthy | 마이그레이션·부팅 실패 — `logs app` | 위 「되돌리기」 |
| 웹 배너 「실시간 연결이 거부되었습니다 — …」 | 브라우저 주소와 `APP_ORIGIN` 이 다르다(스킴·포트·끝 슬래시까지) — 또는 프록시가 WebSocket 업그레이드를 넘기지 않는다 | `APP_ORIGIN=https://<도메인>`, 「프록시가 갖출 것」의 WebSocket |
| 채널 작성기 자리에 「보관된 채널입니다.」, 사이드바에 그 채널이 없음, 에이전트의 message 툴이 `CHANNEL_ARCHIVED` 로 실패 | admin 이상이 그 채널을 보관했다 — 기록은 남고 누구나 읽지만 보내기·카드·반응·채널 설정·첨부는 409 `CHANNEL_ARCHIVED`, 그 채널에는 런·푸시가 없다(보관할 때 돌던 실행은 「중지」와 같이 멈춘다) | admin 이상이 채널 작성기 자리나 「설정」 → 「채널」 탭에서 「보관 해제」 — 멤버·에이전트 대화가 그대로라 같은 대화로 이어진다. 지우는 길은 없다 |
| Gateway 카드 「재연결 중」·「연결 안 됨」, 로그에 그 `gatewayId` 의 재시도, 1분 뒤 「OpenClaw Gateway 「<이름>」에 연결하지 못하고 있습니다」 알림 | 그 Gateway 의 주소·토큰, 방화벽 — 서버는 멈추지 않고 그 Gateway 만 재시도한다(다른 Gateway 는 그대로) | 카드 「수정」(「Gateway 수정·끄기·삭제」), 체크리스트 3 |
| 에이전트 가져오기가 「Gateway 에 연결되지 않았습니다」 | 고른 Gateway 가 끊겼거나 꺼졌다 | 연결 페이지 그 Gateway 카드 |
| 에이전트 화면 「Gateway 가 삭제됨 — 다른 Gateway 로 옮기세요」, 멘션하면 `ADAPTER_UNAVAILABLE` 카드 | 그 에이전트의 Gateway 를 지웠다 | 「Gateway 옮기기」 뒤 카드의 「다시 실행」(「Gateway 수정·끄기·삭제」) |
| `bridge plugin hello` 가 안 나옴 | 플러그인 `bridgeUrl`·`token`, [B] → [A] 443, 프록시의 WebSocket. `bridge connection rejected` 의 `token mismatch` 면 토큰이 활성 토큰과 맞지 않는다 | 체크리스트 5 |
| Gateway 카드 「브리지 토큰」의 「쓸 수 있는 토큰이 없습니다 — 발급하세요」 | 그 Gateway 의 활성 토큰이 0개다(막 추가했거나 전부 폐기) — 그 Gateway 의 브리지 접속은 모두 거절된다 | 체크리스트 4 「브리지 토큰 발급」 |
| 연결 페이지 Gateway 카드 「다른 빌드입니다」·「빌드를 알 수 없습니다」 | 그 Gateway 의 [B] 플러그인이 이 서버 이미지가 품은 번들과 다르다(또는 번들 sha256 을 보내지 않는 옛 플러그인) | 체크리스트 4 의 받기·설치 |
| 「플러그인 받기」가 「플러그인 파일이 그새 다시 빌드됐습니다」 | 부팅 때 잰 tgz 와 지금 파일이 다르다(서버 409 `PLUGIN_FILE_CHANGED`) — 이미지로 돌면 나지 않는다 | 서버 재시작 |
| 폰에 푸시가 안 옴(앱의 알림 설정이 꺼져 보임) | 푸시 구독은 등록한 세션에 묶인다 — 그 세션이 끝나면(로그아웃·비밀번호 변경·재설정·비활성화·30일 미사용 만료) 서버가 구독을 지우고, 웹도 401 을 보면 기기 구독을 해지한다 | 다시 로그인한 뒤 「설정」 → 「알림」 탭에서 「푸시 알림 켜기」 |
| 폰에 푸시가 안 옴(iOS) | `VAPID_SUBJECT` 가 로컬 자리값이면 Apple 이 `403 BadJwtToken` — 서버 시작 로그에 warn 한 줄 | 실제 연락처로 바꾸고 `up -d` |
| 백업 `백업 실패: …` exit 1 | 한 줄 사유(디스크 부족이면 부분 디렉터리는 지워진다) | 공간 확보 뒤 다시 |
| 앱(iOS·Android)이 기기 등록에서 503 `PUSH_UNAVAILABLE` · 부팅 로그 `push transport apns: off(…)`·`fcm: off(…)` | 그 플랫폼의 자격 증명이 없거나 못 읽는다 — 사유가 고정 문구다(`no key`·`no key id`·`no team id`·`key unreadable`·`config unreadable`·`invalid key`·`invalid config`·`no service account`·`invalid service account`). 원본이 0600 이던 파일을 `docker cp` 로 넣으면 root 소유라 못 읽는다 — APNs 는 `key unreadable`, FCM 은 못 읽어도 `no service account` 로 보인다(파일이 있는데 이 사유면 소유자·권한부터 본다) | 위 「네이티브 푸시 자격 증명」 절 그대로 파일을 놓고 소유자를 1000:1000 으로 맞춘 뒤 `up -d --force-recreate app` |
| 첨부 업로드가 507 `INSUFFICIENT_STORAGE`, 운영 화면 「디스크 여유 부족」(오류) | 데이터 볼륨의 여유가 256 MiB 미만 | 공간 확보(`backups/` 의 오래된 백업, 호스트의 다른 파일) → 최대 10분 뒤 또는 `docker compose restart app`. 위 「운영 화면」 |
| 멘션해도 답이 없고 채널에 「오늘 런 한도(N)에 도달했습니다 — 내일 0시에 풀립니다」 | 워크스페이스 또는 채널 일일 런 상한 | 운영 화면 「한도」 또는 채널 설정 「일일 실행 상한」. 자정이 예상과 다르면 `TZ` |
| 요청이 429 `RATE_LIMITED`, 운영 화면 「요청 제한 발동」 | 레이트리밋(위 「운영 화면」의 표) — 한 사람·한 탭의 폭주 | 1분 안에 저절로 풀린다. 되풀이되면 그 사건의 `key`(경로·이벤트 이름)로 무엇이 두드리는지 본다 |
| 바깥 서비스의 웹훅이 404 `{"code":"NOT_FOUND","message":"not found"}` | 주소의 토큰이 지금 켜진 웹훅 자동화의 것이 아니다 — 틀린 주소, 꺼 둔 자동화, 지운 자동화, 「주소 다시 만들기」 전의 옛 주소가 모두 같은 404 다 | 「자동화」 탭에서 켜져 있는지 보고, 주소를 잃었으면 「주소 다시 만들기」 뒤 바깥 서비스의 주소를 바꾼다(「자동화 웹훅」) |
| 웹훅이 409 `CHANNEL_ARCHIVED`, 또는 예약이 「실패」·운영 화면 「자동화 실행 실패 (CHANNEL_ARCHIVED)」 | 자동화의 채널을 보관했다 — 목록에 「채널이 보관되었습니다」 | 채널 보관 해제, 또는 자동화의 채널을 바꾼다 |
| 운영 화면 「자동화 예약을 놓쳐 건너뜀」 | 예약 시각에 서버가 꺼져 있었고 켜졌을 때 가장 이른 놓친 회차가 10분을 넘었다 — 그 회차는 올리지 않고 다음 회차부터 돈다 | 할 일 없음. 놓친 글이 필요하면 「지금 실행」 |
| 웹훅이 413 / 415 / 429 | 본문 64 KiB 초과 / `Content-Type` 머리의 꼴이 틀림 / 그 토큰이 분당 30번을 넘었거나(토큰 상한) 그 주소가 모르는 토큰을 되풀이해 막혔다 | 본문을 줄인다 / 머리를 고친다 / 보내는 쪽의 재시도 간격을 늘린다. 켜진 웹훅의 토큰은 주소 막힘과 무관하게 통과한다 |
| 플러그인이 안 붙고 로그 `bridge connection rejected … blocked after repeated failures`, 운영 화면 「브리지 인증 실패가 반복돼 주소를 막음」 | 한 주소에서 틀린 토큰이 되풀이됐다(옛 토큰으로 재접속하는 플러그인 등) — `TRUST_PROXY` 가 프록시와 맞지 않으면 모든 플러그인이 프록시 주소 하나로 묶여 함께 막힌다 | 틀린 토큰을 쓰는 쪽을 고친 뒤 막힘이 풀리기를 기다린다(`LIMITS.bridgeFail.blockMs`) — 재시작해도 풀린다 |
| 에이전트 파일 업로드 413 | 프록시의 본문 상한(nginx 기본 1 MB 등)이면 프록시의 413, 20 MiB~프록시 상한이면 서버의 413 JSON `{"code":"VALIDATION","message":"Request body is too large"}` — 첨부 전용 고정 문구가 아니다(`docs/guides/plan.md` 8장 이월). 웹과 플러그인은 올리기 전에 크기를 걸러 자기 문구를 낸다 | 파일을 줄이거나 프록시 상한을 32 MB 이상으로(「프록시가 갖출 것」) |
| 러너가 `dodok-runner: 설정 파일 오류 — roots[0].path: 디렉터리가 없습니다(라벨 …)` 처럼 한 줄 찍고 끝남 | 설정 파일(`~/.dodok-runner/config.json`)이 틀렸다 — 어느 키가 왜 틀렸는지가 그 줄에 있다. 연결은 시도하지 않는다 | 그 키를 고치고 다시 띄운다(「러너 설치」 4) |
| 러너가 `dodok-runner: 에이전트는 이제 앱에서 만듭니다 — 설정에서 agents 를 지우고 roots 를 적으세요` 로 끝남 | 에이전트를 러너 설정에 적던 옛 판의 설정 파일이다 | `agents` 를 지우고 `roots`·`programs` 를 적은 뒤(「러너 설치」 4) 앱에서 프로젝트·에이전트를 만든다(같은 절 6·7) |
| 러너가 `서버가 러너 토큰을 거절했습니다(UNAUTHORIZED) — 토큰이 틀렸거나 폐기됐습니다 …` 로 끝남(종료 코드 2) | 토큰 파일의 값이 활성 러너 토큰이 아니다 | 새 러너 토큰 발급 → 토큰 파일 교체 → 다시 띄우기 |
| 러너는 붙었는데 멘션이 「실행이 실패했습니다: ADAPTER_UNAVAILABLE」, 에이전트 줄에 「토큰이 폐기돼 맡을 러너가 없습니다」 | 그 에이전트의 프로젝트가 폐기한 러너 토큰에 있다 | 「러너」 탭에서 그 프로젝트를 붙어 있는 러너로 「옮기기」(「러너 설치」 「러너 폐기·옮기기」) |
| 「@<에이전트> 실행이 실패했습니다: 러너 설정이 이 에이전트를 허용하지 않습니다(<항목>) — 러너 머신의 설정을 확인하세요」(런 오류 코드 `RUNNER_CEILING`) | 러너 설정의 천장 밖이다 — `root` 루트 id 가 바뀌었거나 지워짐, `path` 프로젝트 디렉터리가 없어졌거나 루트 밖을 가리킴, `program` 프로그램이 꺼졌거나 쓸 수 없음, `permissionMode`·`allowedTools` 에이전트가 상한 위 | [R] 의 설정을 되돌리거나 「에이전트」 탭에서 그 에이전트의 권한·도구를 낮춘 뒤 카드의 「다시 실행」 |
| 러너가 `서버가 이 러너 연결을 끊었습니다 — 같은 토큰으로 다른 러너가 붙었거나 토큰이 폐기됐습니다` 로 끝남 | 같은 토큰을 두 머신에서 썼거나 연결 페이지에서 폐기했다 | 머신마다 토큰을 따로 발급한다 |
| 러너가 `서버가 러너를 거절했습니다(PROTOCOL_MISMATCH: …) — 서버와 러너 판본을 맞추세요` 로 끝남 | 서버를 올렸는데 러너가 옛 판이다(또는 그 반대) | 「러너 설치」 2 로 러너를 다시 받는다 |
| 러너 에이전트를 멘션하면 「@<에이전트> 실행이 실패했습니다: ADAPTER_UNAVAILABLE」 | 그 에이전트의 러너가 붙어 있지 않다(꺼짐·끊김), 또는 런이 도는 중에 러너가 꺼지거나 끊겼다(토큰 다시 발급 포함) | 러너를 띄운 뒤 「다시 실행」 |
| 「@<에이전트> 실행이 실패했습니다: 러너의 Claude Code 로그인을 확인하세요」(런 오류 코드 `PROVIDER_AUTH` — 이름은 그 에이전트의 프로그램) | 러너 전용 로그인이 없거나 만료됐다 | [R] 에서 「러너 설치」 3 의 로그인을 다시 한 뒤 카드의 「다시 실행」 |

## 보안

- 호스트에 열리는 포트는 `127.0.0.1:${DODOK_HTTP_PORT:-3000}` 하나(루프백)이고, 컨테이너 프록시 꼴이면 그것도 닫는다. 바깥에 여는 것은 프록시 몫이다.
- 컨테이너는 비루트(`node`)로 돈다. `.env`·`data/`·`compose.override.yaml` 은 이미지에 들어가지 않는다(`.dockerignore`).
- HSTS(`APP_ORIGIN` 이 `https:` 일 때)·`nosniff`·`Referrer-Policy`·**CSP(강제)** 는 서버가 모든 응답에 붙인다. CSP 는 스크립트를 이 오리진의 파일만 허용하고(인라인·eval 없음), 스타일은 인라인까지(라이브러리가 런타임에 `<style>` 을 꽂는다), 이미지는 이 오리진·`data:`·`blob:`(작성기 미리보기)·`https:`(components media 블록의 외부 이미지), 연결은 이 오리진(wss 포함), 워커는 `/sw.js`, 다른 사이트의 틀 안에는 못 넣는다(`frame-ancestors 'none'`). 정책 글과 각 허용의 까닭은 `apps/server/src/http/web-static.ts` 의 `SECURITY_HEADERS` 주석, `check-deploy.sh` 는 헤더가 강제이고 `script-src 'self'` 만인지를 본다. 정책을 넓히거나 좁혔으면 로그인·채널·스트리밍·첨부 이미지·코드 하이라이트·서비스 워커를 돌며 콘솔의 CSP 위반이 0 인지 본다 — 독립 Playwright Chromium 으로 `securitypolicyviolation` 이벤트를 `addInitScript` 로 모은다(`docs/guides/browser-verification.md` 「배포 이미지(앱 컨테이너)를 볼 때」). 웹은 zod 를 jitless 로 둔다(`apps/web/src/lib/zodJitless.ts`) — 아니면 zod 의 `Function("")` 탐지가 페이지마다 위반 보고를 낸다(막혀도 앱은 돈다).
- **자동화 웹훅은 로그인 없는 공개 경로다**(`POST /hooks/<토큰>`, 위 「자동화 웹훅」) — 256비트 토큰이 유일한 열쇠이고, 서버 로그는 그 토큰을 가린다(프록시 로그는 「프록시 접근 로그」). 본문은 글자로만 다룬다 — 실행하거나 템플릿으로 풀지 않고, 본문 속 `@핸들`·멘션 토큰은 아무도 부르지 않는다. 서명 검증(GitHub `X-Hub-Signature-256` 등)은 없다.
- **`X-Forwarded-For` 를 위조해도 레이트리밋·실패 카운터는 우회되지 않는다** — 앱이 `TRUST_PROXY` 의 주소에서 온 연결의 XFF 만, 오른쪽부터 믿는 주소를 건너뛰어 읽는다(위 「신뢰 주소 — `TRUST_PROXY`」). 프록시가 클라이언트의 XFF 뒤에 덧붙이는 꼴(nginx `$proxy_add_x_forwarded_for`)이어도 앱이 고르는 것은 프록시가 붙인 진짜 주소다. `scripts/check-deploy.sh proxy` 가 덧붙이는 프록시로 잰다 — 프록시를 거친 위조 6회와 프록시가 아닌 이웃 컨테이너가 앱에 직접 보낸 위조 6회 모두 6번째가 429, 같은 프록시 뒤 다른 클라이언트의 첫 요청은 401.
- **서버 로그에는 IP 전체를 싣지 않는다.** 요청 로그(`incoming request` 줄의 `req.remoteAddress`)와 브리지·러너 핸드셰이크 거절 로그(`bridge connection rejected` 의 `reason`, `runner connection rejected` 의 `address`)는 운영 사건과 같이 IPv4 /24·IPv6 /48 로 줄인 값이다(`apps/server/src/modules/ops/ip.ts` 의 `ipPrefix`). 레이트리밋·인증 실패 카운터는 전체 IP 로 센다 — 로그만 줄인다. 이 가림은 로그뿐이다: DB 의 Better Auth 세션 행(`session.ip_address`)에는 로그인한 IP 전체가 남는다(`docs/guides/plan.md` 8장 이월).

## Docker 정리 규칙

이 저장소를 만지는 사람·에이전트는 **다른 프로젝트와 한 Docker 데몬을 나눠 쓴다**(개발 PC 가 그렇고, 배포 호스트도 그럴 수 있다).

- ⚠ **`docker image prune`·`volume prune`·`system prune`·`builder prune` 을 쓰지 않는다 — 어떤 필터로도.** 남의 dangling 이미지·빌드 캐시·볼륨이 함께 지워지고 되돌릴 수 없다.
- 지울 때는 **자기가 만든 것만, 이름이나 ID 로** 지운다. dangling 이미지는 `docker image ls --filter dangling=true --format '{{.ID}} {{.CreatedAt}}'` 로 생성 시각을 보고, 자기 작업 시간대의 것만 ID 로 `docker image rm`(지우면 그 부모 층이 새로 dangling 으로 보이니 같은 기준으로 되풀이한다).
- 다른 compose 프로젝트의 컨테이너·볼륨·네트워크는 읽기만 한다. 작업 전후로 `docker ps -a`·`docker volume ls`·`docker image ls -a` 를 떠 두고 대조하면 무엇을 남겼는지 안다.
- 이 저장소가 만드는 이름: 이미지 `dodok-app`, 볼륨 `dodok_dodok-data`, 네트워크 `dodok_default`. `scripts/check-deploy.sh proxy` 는 `dodok-check-<pid>` 로 시작하는 프로젝트·네트워크·컨테이너를 만들고 끝나면(trap) 이름으로 지운다. 베이스 이미지(`node:24.21.0-bookworm`·`node:24.21.0-bookworm-slim`·`caddy:2.11.4` — 마지막은 검사 스크립트의 임시 프록시)는 다음 빌드의 캐시라 두는 것이 기본이다.
- ⚠ 운영 호스트에서 `down -v` 는 **데이터 볼륨을 지운다.** 운영에서는 `-v` 를 붙이지 않는다.
- ⚠ **zsh 는 따옴표 없는 변수를 낱말로 쪼개지 않는다** — `IDS=$(…); for id in $IDS` 는 목록 전체를 한 번에 넘겨 아무것도 지우지 않고 오류도 내지 않는다. ID 목록은 배열(`ids=(${(f)"$(…)"})`)로 받거나 `${=IDS}` 로 돌린다. 지운 뒤 `docker image ls -a` 를 시작 스냅숏과 diff 해 실제로 사라졌는지 본다.

## 확인 — `scripts/check-deploy.sh`

앱이 웹·백엔드를 바르게 내는지 curl 로 단언한다. 줄마다 `PASS`/`FAIL`/`SKIP`, 끝 줄 `check-deploy <모드>: PASS n / FAIL n / SKIP n`, FAIL 이 있으면 종료 1. 확인 항목과 각 항목의 까닭은 그 스크립트가 정본이다.

- **`app <오리진> [컨테이너]`** — 떠 있는 앱을 두드린다(프록시 앞이든 앱 직결이든). `/healthz`·`/`·SPA 깊은 경로·`HEAD /`·`sw.js`·매니페스트의 `no-cache`, `/assets/<빌드 파일>` 의 `immutable` 과 미리 압축한 `br`, 없는 청크 404, 백엔드 경로가 서버로 가는지(없는 API JSON 404·Socket.IO 폴링 핸드셰이크·`/bridge`·`/runner` 첨부 401·`/hooks` 404·`/mcp` 401·`/llms.txt`), 보안 헤더(https 오리진이면 HSTS, 아니면 없음)와 CSP. 컨테이너 이름·id 를 주면 웹훅·`dpt_` 토큰을 실은 요청을 보낸 뒤 그 컨테이너 로그(`docker logs`)에 원문이 없고 가린 줄이 있는지 본다(`LOG_LEVEL=info` 이상).
- **`proxy`** — 이 머신에서 프록시 뒤 꼴을 흉내 낸다. 임시 네트워크(서브넷 지정)·Caddy 컨테이너(고정 IP, 내부 CA HTTPS, 받은 XFF 뒤에 덧붙이게 둠)·앱(`-f compose.yaml` + 「컨테이너 프록시」 꼴의 임시 덮어쓰기 파일, `TRUST_PROXY=<Caddy IP>/32`)을 만들고 `app` 모드 검사에 더해 `config` 에 호스트 포트가 없는지, HTTPS 로그인 쿠키 `Secure`, WebSocket 업그레이드 101, 20 MiB 첨부 업로드(Gateway·채널·브리지 토큰을 만들어 `/bridge/attachments` 로), XFF 위조(위 「보안」)를 잰 뒤 만든 것만 지운다. 개발용 `.env` 와 부딪히지 않게 임시 env 파일을 `DODOK_ENV_FILE` 로 준다. 호스트 포트 `127.0.0.1:8443`(이미 쓰이면 `DODOK_CHECK_HTTPS_PORT`) 하나를 쓰고, 이미지를 빌드하므로 처음이면 몇 분 걸린다.
- **로컬에서 운영 이미지를 띄워 볼 때** — 개발용 `.env`(`APP_ORIGIN` 이 Vite 5173)와 부딪히지 않게 임시 env 파일과 프로젝트 이름을 따로 준다:
  ```bash
  cp .env.example /tmp/dodok-local.env      # APP_ORIGIN=http://localhost:3000 · LOCAL_AUTH_TOKEN · BETTER_AUTH_SECRET · VAPID_SUBJECT 를 채운다
  DODOK_ENV_FILE=/tmp/dodok-local.env docker compose -p dodok-local -f compose.yaml up -d --build --wait
  bash scripts/check-deploy.sh app http://localhost:3000 "$(docker compose -p dodok-local -f compose.yaml ps -q app)"
  DODOK_ENV_FILE=/tmp/dodok-local.env docker compose -p dodok-local -f compose.yaml down -v --rmi local
  ```
  브라우저는 `APP_ORIGIN` 과 같은 주소로 연다(`localhost` 는 보안 컨텍스트라 서비스 워커·푸시 구독도 된다).

**이 스크립트가 보지 않는 것** — 실제 도메인의 인증서(`proxy` 는 Caddy 내부 CA 라 `-k`), 프록시 자신의 로그 가림(「프록시 접근 로그」 — 프록시마다 다르다), 실기기 푸시, 브라우저에서 CSP 위반 0(헤더 글자만 본다). 그리고 nginx 등 Caddy 가 아닌 프록시 — 운영 프록시 뒤에서는 `app` 모드와 「프록시 뒤 확인」의 「위조 확인」·「주소 확인」으로 잰다.

## 사람이 한 번 따라 한 결과

실제 서버·도메인·폰으로 위 체크리스트를 처음 따라 한 사람이 채운다. 이것이 채워지면 Phase 2 ④ 가 넘긴 실기기 푸시 확인(`docs/guides/plan.md` 8장 이월 「PWA·푸시」)이 닫힌다. 틀린 명령·빠진 단계는 이 문서 본문을 고치고, 여기에는 결과만 적는다.

| 단계 | 결과 | 메모(호스트·OS·버전·프록시 종류·걸린 것) |
| --- | --- | --- |
| 1. 저장소·`.env`·프록시(컨테이너·호스트 중 어느 꼴, 덮어쓰기 파일) | | |
| 2. 기동(healthy·`/healthz`·`check-deploy.sh app https://<도메인>`·「위조 확인」·「주소 확인」) | | |
| 3. 연결 페이지 「Gateway 추가」·페어링(`gatewayVersion`, Gateway 카드 — 페어링 대기였으면 요청 id·승인 명령이 보였나) | | |
| 4. 연결 페이지 — 플러그인 받기(파일 sha256 대조)·[B] 설치(번들 sha256 대조)·Gateway 카드에서 토큰 발급·계정 설정 | | |
| 5. 브리지 접속(「지금 접속 중」·「서버와 같은 빌드입니다」·`bridge plugin hello`) | | |
| 브리지 토큰 교체(발급 → [B] 설정 교체 → 「지금 접속 중」 이동 → 옛 토큰 폐기) | | |
| 둘째 Gateway(있으면) — 추가·설치·토큰, 같은 id 에이전트를 핸들을 달리해 가져와 각각 멘션 | | |
| 6. 폰 — iOS 홈 화면 PWA 푸시·누르기 | | |
| 6. 폰 — 안드로이드 Chrome 푸시·누르기 | | |
| 네이티브 푸시(앱) — 자격 증명(부팅 로그 `push transport … on`)·`docs/guides/live-smoke.md` 「네이티브 푸시 손 확인」 절의 실기기 알림 | | |
| 멤버 초대 — 다른 브라우저·폰에서 가입, 서로 멘션해 폰에 푸시가 오는가, 비활성화 뒤 그 화면·다시 활성화 뒤 같은 비밀번호 로그인 | | |
| 7. 백업·cron | | |
| 복원(업데이트 직전 백업) | | |
| 업데이트·되돌리기 | | |
| 볼륨째 옮기기 | | |
| 프록시 로그 가림(웹훅·`dpt_` 개수 0) | | |
| Komodo(쓰면) — 부록의 Stack 으로 Deploy, 덮어쓰기 파일 | | |

## 부록 — Komodo Git Repo Stack

dodok 을 [Komodo](https://komo.do) 의 **Git Repo Stack** 으로 올릴 때의 Stack 설정이다. 설치 절차·`.env` 의 뜻·운영은 위 본문이 정본이고 `docker compose` 기준이다 — 이 부록은 그 절차를 Komodo 로 부를 때 Komodo 안에만 남는 설정을 적는다. Stack 을 바꾸면 같은 커밋에서 이 표도 고친다.

Komodo 서버 이름, Periphery 가 clone 하는 호스트 경로, 공유 네트워크 이름·프록시 주소는 서버마다 달라 여기 적지 않는다 — Komodo 에서 고르거나 Environment 에 넣는다.

### Komodo 가 부르는 명령

Komodo 의 Periphery 는 저장소를 `<stack_dir>/<Stack 이름>/<clone_path>` 에 clone(이미 있으면 pull)하고, 그 아래 Run Directory 에 Environment 를 `.env`(`env_file_path`)로 쓴 뒤, Run Directory 에서 다음 꼴로 부른다(Environment 가 비면 `.env` 를 새로 쓰지 않는다 — 그 자리에 파일이 이미 있으면 그 파일을 `--env-file` 로 넘기고, 없으면 `--env-file` 도 없다).

```
docker compose -p <Stack 이름> -f <File Paths 1> [-f <File Paths 2>] --env-file .env config
docker compose -p <Stack 이름> -f … --env-file .env build        # Run Build 를 켰을 때만
docker compose -p <Stack 이름> -f … --env-file .env pull         # Auto Pull(기본 켬) — pull_policy: build 라 「No image to be pulled」로 건너뛴다
docker compose -p <Stack 이름> -f … --env-file .env up -d
```

출처: moghtech/komodo `main`(780ac68) 의 `bin/periphery/src/api/compose.rs`(`env_file_args` — 추가 env 파일 다음 Komodo 의 `.env` 를 마지막에 붙인다, `up -d` 명령 줄), `bin/periphery/src/stack/write.rs`(clone 자리·Run Directory·`.env` 를 쓰는 자리), `client/core/rs/src/entities/stack.rs`(필드 기본값 — `project_name` 이 비면 Stack 이름, `env_file_path` 기본 `.env`, `auto_pull`·`webhook_enabled` 기본 켬), 공식 문서 [Docker Compose](https://komo.do/docs/deploy/compose).

이 꼴이 dodok 의 compose 와 맞는 까닭:

- **Run Directory 를 저장소 루트로 두면 `.env` 하나를 둘이 같이 쓴다** — 변수 치환(덮어쓰기 파일의 `${TRUST_PROXY:?}` 등)은 `--env-file .env` 로, 앱 설정은 `compose.yaml` 의 `env_file: ${DODOK_ENV_FILE:-.env}`(Environment 에 `DODOK_ENV_FILE` 을 넣지 않으면 `.env`)로 같은 파일을 읽는다.
- **`-f` 를 주므로 `compose.override.yaml` 을 저절로 읽지 않는다** — 덮어쓰기 파일은 File Paths 에 직접 적는다(아래 표).
- **`up -d` 에 `--build` 가 없어도 빌드한다** — `pull_policy: build` 라 `up` 이 매번 저장소 코드로 빌드한다. 웹 빌드 ID 는 이미지 빌드가 웹 입력의 내용 해시로 정하므로 셸 계산이 없어도 서버만 바뀐 배포에서 그대로다(본문 「기동」).
- `-p <Stack 이름>` 이 `compose.yaml` 의 `name: dodok` 을 이긴다 — Stack 이름을 `dodok` 으로 두어야 볼륨 이름(`dodok_dodok-data`)이 본문과 같다. 다른 이름이면 볼륨 이름의 앞이 그 이름이 된다.

이 꼴은 로컬에서 흉내 내 확인할 수 있다 — `scripts/check-deploy.sh proxy` 가 `-p <이름> -f compose.yaml -f <덮어쓰기 파일>` 로 띄우고 `config` 에 호스트 포트가 없는지 본다. 실제 Komodo 로 배포해 보지는 않았다.

### Stack 설정

| 항목 | 값 |
| --- | --- |
| Name | `dodok` — compose 프로젝트 이름이 된다(Project Name 은 비운다) |
| Source | Git Repo — Git Provider `gitlab.develma.com`·Repo `app/dodok.chat`·Branch `main`. ⚠ Git Provider 의 기본값은 `github.com` 이라 바꾸지 않으면 clone 이 실패한다(`stack.rs` 의 `default_git_provider`). 비공개 저장소면 Komodo 에 등록한 Git Account |
| Run Directory | 비운다(저장소 루트). Komodo 가 여기 `.env` 를 쓴다 |
| File Paths | 호스트에 깐 프록시(포트 그대로): `compose.yaml` 하나. 컨테이너 프록시(또는 포트·네트워크를 바꾸는 서버): `compose.yaml` **다음에** `compose.override.yaml` — 순서가 바뀌면 기본 파일이 덮어쓰기를 덮어 호스트 포트가 다시 열린다 |
| Env File Path | 기본 `.env` 그대로 |
| Run Build | 끈다 — `pull_policy: build` 라 `up` 이 빌드한다(켜면 빌드를 한 번 더 부를 뿐이다) |
| Auto Pull | 기본(켬) 그대로 — `app` 을 건너뛴다 |
| Destroy Before Deploy | 끈다 — 켜면 배포마다 `down` 뒤 `up` 이라 끊김이 길어진다 |
| Reclone | 끈다(기본) — 켜면 배포마다 clone 디렉터리를 지우고 다시 받아 서버 덮어쓰기 파일이 매번 사라진다 |
| Webhook | **끈다**(Komodo 기본은 켬) — 까닭은 아래 |
| Environment | 아래 표 |
| 덮어쓰기 파일 | `compose.override.yaml`(서버에서 직접 쓴다 — 아래 「서버 덮어쓰기 파일」) |

**Webhook 을 끄는 까닭** — push 마다 재배포하면 `app` 컨테이너가 다시 만들어지며 그때 돌던 에이전트 런이 `ADAPTER_UNAVAILABLE`(「다시 실행」 카드)로 닫히고, 웹·Gateway 플러그인·러너의 연결이 모두 끊겼다 다시 붙는다(`stop_grace_period` 15초 안에 깨끗이 내린다). 마이그레이션도 배포 때 돈다 — 본문 「업데이트」는 그 전에 백업을 남기라고 한다. 사람이 백업을 남기고 Komodo 에서 Deploy 한다.

### Environment

Komodo 가 위 `.env` 로 쓴다 — compose 변수 치환과 앱의 `env_file` 이 같은 파일이라 컨테이너에도 그대로 들어간다. 값의 뜻·필수 여부는 본문 「설정 — `.env`」 표가 정본이고, 여기는 Stack 에 넣을 꼴이다. 비밀은 평문으로 쓰지 않고 Komodo Variable(Secret)로 두어 `[[…]]` 로 참조한다 — Variable 은 Komodo 전체가 나눠 쓰니 이름 앞에 `DODOK_` 을 붙인다.

| 키 | 필수 | 꼴 |
| --- | --- | --- |
| `APP_ORIGIN` | 필수 | `https://<도메인>` |
| `LOCAL_AUTH_TOKEN` | 필수(비밀) | `[[DODOK_LOCAL_AUTH_TOKEN]]` |
| `BETTER_AUTH_SECRET` | 필수(비밀) | `[[DODOK_BETTER_AUTH_SECRET]]` |
| `VAPID_SUBJECT` | 필수 | `mailto:<실제 주소>` |
| `TRUST_PROXY` | 프록시 뒤면 필수 | 프록시 주소 `/32`(본문 「신뢰 주소 — `TRUST_PROXY`」 — 서브넷 전체를 주지 않는다). 호스트에 깐 프록시면 `dodok_default` 게이트웨이 `/32` — 첫 Deploy 는 비우고, 게이트웨이를 본 뒤 넣고 다시 Deploy. 컨테이너 프록시의 덮어쓰기 파일은 이 값이 없으면 `config` 에서 멈춘다 |
| `DODOK_PROXY_NETWORK` | 컨테이너 프록시면 필수 | 공유 네트워크 이름(본문 「컨테이너 프록시」) — 덮어쓰기 파일이 읽는다 |
| `DODOK_HTTP_PORT` | 선택 | 호스트 루프백 포트(기본 `3000`) |
| `TZ` | 선택 | 예 `Asia/Seoul` |
| `BRIDGE_PUBLIC_URL` · `LOG_LEVEL` · `OWNER_HANDLE` · `DODOK_WORKSPACE_NAME` | 선택 | 본문 표 |
| `VAPID_PUBLIC_KEY` · `VAPID_PRIVATE_KEY` | 선택(비밀) | 비우면 서버가 볼륨에 만든다. 주면 `[[DODOK_VAPID_PRIVATE_KEY]]` |
| `APNS_KEY_PATH` · `APNS_KEY_ID` · `APNS_TEAM_ID` · `FCM_SERVICE_ACCOUNT_PATH` | 선택 | 본문 「네이티브 푸시 자격 증명」 |

- `DODOK_WEB_BUILD_ID`·`DODOK_ENV_FILE` 은 넣지 않는다 — 앞은 웹이 바뀌어도 ID 가 그대로가 되고(본문 「설정 — `.env`」), 뒤는 앱이 Komodo 의 `.env` 대신 다른 파일을 읽게 된다.
- `HOST`·`PORT`·`DATA_DIR`·`DODOK_WEB_DIR` 등 compose 가 고정하는 값은 넣어도 무시된다(본문 표의 「무시된다」 줄).
- Environment 를 바꾼 뒤에는 Deploy 를 다시 한다 — 떠 있는 컨테이너는 옛 값으로 돈다.
- Komodo 는 배포 기록에 `config` 결과(합친 설정 — `env_file` 로 읽은 값 포함)를 남기고, 가리는 것은 Secret Variable 로 치환한 값뿐이다(`compose.rs` 의 `merged_config`). 그래서 비밀은 꼭 `[[…]]` 로 둔다.

### 서버 덮어쓰기 파일

`compose.override.yaml` 은 저장소에 없고(`.gitignore`) 서버에서 직접 쓴다. Periphery 가 clone 한 디렉터리(그 호스트 경로는 Periphery 컨테이너 정의의 `root_directory`·`stack_dir` 바인드로 본다)의 루트에 둔다. 내용은 본문 「컨테이너 프록시」 4 의 조각 그대로다 — 서버마다 다른 값은 Environment 의 `TRUST_PROXY`·`DODOK_PROXY_NETWORK` 가 갖는다. 저장소 밖에도 사본을 둔다.

- 본문의 조각이 바뀌면(저장소를 pull 한 뒤 `git diff` 에 `docs/guides/docker-deploy.md` 「컨테이너 프록시」 가 보이면) 서버의 파일도 고친다. 갱신(pull)은 이 파일을 건드리지 않는다.
- ⚠ **clone 을 다시 하면 이 파일이 사라진다** — Stack 을 지우고 다시 만들거나, 이름·저장소·브랜치를 바꾸거나, Reclone 을 켜 두면 Periphery 가 디렉터리를 통째로 다시 만든다. 그 뒤 Deploy 는 File Paths 의 파일이 없어 실패한다. 파일을 다시 쓰고 Deploy 한다.
- 쓴 뒤 clone 디렉터리에서 값이 나오지 않는 꼴로 확인한다: `docker compose -p dodok -f compose.yaml -f compose.override.yaml --env-file .env config --quiet`(오류만), `… config --services`(서비스 이름만). 포트·네트워크는 본문 「컨테이너 프록시」 5 의 `jq` 꼴.
- 프록시가 갖출 것과 확인 절차는 본문 「프록시 붙이기」.

### 호스트에서 운영 명령 부르기

백업·로그·`exec` 는 파일 없이 프로젝트 이름만으로 돈다(Compose 가 컨테이너 라벨로 찾는다 — 어느 디렉터리에서든). 본문의 `docker compose <명령>` 을 아래 꼴로 읽는다.

```bash
docker compose -p dodok ps
docker compose -p dodok logs app
docker compose -p dodok exec app node dist/backup.js
```

cron(매일 04:00, 14개 보관 — `cd` 가 필요 없다):

```cron
0 4 * * * docker compose -p dodok exec -T app node dist/backup.js --keep 14 >> "$HOME/dodok-backup.log" 2>&1
```

- `up`·`run`·`build`·`config` 는 파일이 필요하다. 본문의 「복원」·「되돌리기」·「볼륨째 옮기기」처럼 `run --rm` 을 쓰는 절차는 clone 디렉터리에서 Komodo 와 같은 꼴로 부른다:
  ```bash
  kc() { docker compose -p dodok -f compose.yaml -f compose.override.yaml --env-file .env "$@"; }   # 덮어쓰기 파일이 없는 서버는 둘째 -f 를 뺀다
  ```
  `.env` 는 Komodo 가 마지막 배포 때 쓴 파일이다. ⚠ `kc config` 는 그 값을 찍는다(본문 「시크릿 규칙」).
- 「되돌리기」의 `git checkout <커밋>` 은 Komodo 의 clone 을 옮긴다 — 다음 Deploy 의 갱신이 Branch 로 되돌린다(Periphery 의 갱신은 `git checkout -f`·`git pull`). 되돌린 채 두려면 Komodo 의 Stack 설정에서 Commit 을 그 커밋으로 고정하고 Deploy 한다.

확인 못 한 것: Komodo 화면의 버튼 이름·위치는 판마다 다를 수 있어 필드 이름(`file_paths`·`run_directory`·`env_file_path`·`webhook_enabled`·`run_build`·`auto_pull`·`destroy_before_deploy`·`reclone`·`commit`)으로 적었다. 실제 Komodo 서버에 이 Stack 을 만들어 배포해 본 사람이 결과를 본문 「사람이 한 번 따라 한 결과」 표에 적는다.
