# 배포 — 한 호스트에 dodok 을 올리고 원격 Gateway·폰까지 잇기

dodok 서버·웹을 Docker Compose 로 한 호스트에 올리고, Caddy 가 공개 도메인에 자동 HTTPS 를 붙인다. 원격 Gateway 의 플러그인이 그 도메인의 브리지로 붙고, 폰이 PWA·푸시로 붙는다.
설계는 `docs/superpowers/specs/2026-09-24-deploy-packaging-design.md`(구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장)다. 각 파일이 **왜 그렇게 생겼는지는 그 파일의 머리 주석이 정본**이다 — `infra/compose.yml`·`infra/compose.local.yml`·`infra/Caddyfile`·`infra/Dockerfile.server`·`infra/Dockerfile.web`·`infra/check-caddy.sh`.

표기: **[A]** dodok 호스트(Docker·Compose v2 이상, git), **[B]** Gateway 호스트, **[PC]** 개발 PC(이 저장소, Node·pnpm — `mise.toml`), **[폰]**.
명령은 [A] 의 저장소 루트에서 부른다(따로 적지 않으면).

## 시크릿 규칙

`docs/guides/live-smoke.md` 「시크릿 규칙」 절과 같다. 이 문서의 명령은 값을 화면에 찍지 않는 꼴이다. 배포에서 더 조심할 것:

- `.env` 를 `cat`·`grep` 하지 않는다. 값이 필요하면 서브셸에서 `. ./.env` 로 **셸 변수**로만 읽는다.
- ⚠ **`docker compose config` 와 `docker compose exec app env` 는 `.env` 값을 그대로 찍는다** — 부르지 않는다. 합쳐진 설정을 볼 때는 `docker compose -f infra/compose.yml config --services`(서비스 이름만)처럼 값이 안 나오는 것만 쓴다.
- 서버 로그(`docker compose logs app`)는 토큰·비밀 키를 가린다(pino redact). 옮기기 전에는 그래도 `grep -c -F` 로 개수만 확인한다.

## 설정 — `.env`

`.env` 는 저장소 루트에 하나 둔다(git 제외). 앱 설정은 `compose.yml` 의 `env_file: ../.env` 로 컨테이너 환경변수가 되고, 운영 번들은 `.env` 파일을 직접 읽지 않는다.

**`infra/.env` 링크를 한 번 만든다(기본).**

```bash
ln -s ../.env infra/.env
```

까닭: compose 는 변수 치환(`${DODOK_DOMAIN}`·`${DODOK_WEB_BUILD_ID}`)에 **첫 `-f` 파일의 디렉터리(`infra/`)의 `.env`** 만 읽고 루트 `.env` 는 보지 않는다. 치환은 `up` 뿐 아니라 `ps`·`logs`·`exec`·`down` 에서도 돌아서, 링크가 없으면 모든 명령이 `DODOK_DOMAIN 이 필요하다` 로 멈춘다. 링크 대신 `--env-file .env` 를 쓸 수도 있지만 **그 명령마다** 붙여야 한다(cron 줄 포함). 링크는 git 이 무시하고(`.gitignore` 의 `.env`), 이미지 빌드 컨텍스트에서도 빠진다(`.dockerignore` 의 `infra/.env`).

**만들기** — 토큰은 셸이 만들어 파일에만 쓴다.

```bash
cp .env.example .env && chmod 600 .env
for k in LOCAL_AUTH_TOKEN BETTER_AUTH_SECRET BRIDGE_TOKEN; do
  sed -i.bak "s/^$k=\$/$k=$(openssl rand -hex 32)/" .env; done; rm .env.bak
${EDITOR:-vi} .env      # 아래 표의 나머지 값 — OPENCLAW_GATEWAY_TOKEN 은 [B] 에서 받은 값을 여기서 붙여 넣는다
```

| 값 | 배포에서 | 뜻 |
| --- | --- | --- |
| `DODOK_DOMAIN` | **필수** | Caddy 가 인증서를 받을 공개 도메인(예 `dodok.example.com`). 비면 compose 가 먼저 멈춘다 |
| `APP_ORIGIN` | **필수** | `https://<도메인>` — 슬래시 없이 정확히. 쿠키·wire 핸드셰이크 `Origin` 검사 기준이라 브라우저 주소와 다르면 웹이 「rejected」 배너로 막힌다 |
| `TRUST_PROXY` | **필수** `true` | Caddy 뒤. 로그인 레이트리밋이 Caddy 가 붙인 클라이언트 IP 로 걸린다(아래 「보안」) |
| `LOCAL_AUTH_TOKEN` | **필수**(≥16자) | 로그인 토큰 = owner 비밀번호. 바꾸면 기존 세션이 끊긴다 |
| `BETTER_AUTH_SECRET` | **필수**(≥32자) | 세션 서명 비밀 |
| `OPENCLAW_GATEWAY_URL` · `OPENCLAW_GATEWAY_TOKEN` | **필수** | 원격 Gateway(`wss://…`)와 그 공유 토큰. `OPENCLAW_TARGET` 은 비워 둔다(기본 `remote`) |
| `BRIDGE_TOKEN` | **필수**(≥16자) | 플러그인 계정 설정의 `token` 과 같은 값 |
| `BRIDGE_PUBLIC_URL` | **필수** | `wss://<도메인>/bridge` — 정보용(서버는 이 값으로 리슨하지 않는다). 플러그인 계정 설정의 `bridgeUrl` 에 같은 값을 쓴다 |
| `VAPID_SUBJECT` | **필수**(실제 연락처) | `mailto:<실제 주소>` 또는 `https://…`. 로컬 자리값(`localhost`·`*.local`)이면 Apple Push 가 `403 BadJwtToken` 으로 거부한다 — 폰 푸시가 안 온다 |
| `LOG_LEVEL` · `OWNER_HANDLE` · `DODOK_WORKSPACE_NAME` | 선택 | 기본 `info` · `owner` · `dodok` |
| `VAPID_PUBLIC_KEY` · `VAPID_PRIVATE_KEY` | 선택 | 비우면 서버가 `/data/vapid.json` 을 만들어 쓴다(볼륨에 남는다). 키가 바뀌면 모든 기기의 푸시 구독이 무효가 된다 |
| `DB_PATH` · `ATTACHMENTS_DIR` · `OPENCLAW_DEVICE_IDENTITY_PATH` | **비워 둔다** | 기본값이 `/data` 아래다. 볼륨 밖 경로를 주면 컨테이너를 다시 만들 때 그 데이터가 사라진다 |
| `HOST` · `PORT` · `DATA_DIR` · `DODOK_MIGRATIONS_DIR` | 무시된다 | compose 가 `environment` 로 `0.0.0.0`·`3000`·`/data`·`/app/drizzle` 을 고정한다. `.env.example` 을 복사해 생긴 빈 줄(`HOST=`)이 그대로 있어도 된다 |
| `OPENCLAW_DEV_*` · `OPENCLAW_FRAME_DUMP_PATH` · `BRIDGE_URL` | 쓰지 않는다 | 개발·진단·스파이크 전용 |

`DODOK_WEB_BUILD_ID` 는 `.env` 에 두지 않는다 — 배포마다 셸이 계산해 넘기는 값이다(아래 「기동」). `.env` 에 고정하면 웹이 바뀌어도 ID 가 그대로라 클라이언트가 옛 오프라인 사본을 버리지 않는다.
전체 변수 목록과 기본값은 `docs/project-structure.md` 「환경 변수」 장, 형식은 `.env.example`.

## 체크리스트 — 처음 배포

### 1. [A] 도메인·포트·저장소·`.env`

```bash
dig +short A <도메인>                 # [A] 의 공인 IP 가 나와야 한다
# 방화벽·클라우드 보안 그룹에서 80/tcp·443/tcp·443/udp 를 연다(Let's Encrypt HTTP 검증은 80 을 쓴다)
git clone <저장소 URL> dodok.chat && cd dodok.chat     # --depth 를 주지 않는다(아래 「기동」의 웹 빌드 ID)
```

그다음 위 「설정 — `.env`」 대로 `.env` 를 만들고 `ln -s ../.env infra/.env`.

### 2. [A] 기동

```bash
DODOK_WEB_BUILD_ID=$(git log -1 --format=%h -- apps/web packages/shared pnpm-lock.yaml tsconfig.base.json package.json pnpm-workspace.yaml infra/Dockerfile.web) \
  docker compose -f infra/compose.yml up -d --build
docker compose -f infra/compose.yml ps          # app·caddy 둘 다 (healthy)
curl -fsS https://<도메인>/healthz              # "db":"ok" 가 든 JSON
```

- 빌드는 이 호스트에서 소스로 한다(이미지 레지스트리 없음). 빌드 중에 npm 레지스트리에 닿아야 한다(`pnpm fetch`·`pnpm deploy`).
- **`DODOK_WEB_BUILD_ID`** 는 웹 산출물에 들어가는 빌드 ID 다(`__BUILD_ID__` — 오프라인 사본을 버리는 기준, 청크·`sw.js` 이름에도 스민다). 위 경로들(웹 빌드의 입력)이 마지막으로 바뀐 커밋이라, 서버만 바뀐 배포에서는 ID 가 그대로고 웹 산출물이 바이트 단위로 같다 — 클라이언트는 새 버전 토스트도 오프라인 사본 폐기도 겪지 않는다.
  - 빼거나 비면 빌드 시각이 ID 가 된다(늘 새 버전 — 안전한 쪽이지만 배포마다 모든 클라이언트가 청크를 다시 받는다).
  - ⚠ **얕은 클론(`--depth`)에서는 이 값이 틀린다** — 잘린 이력의 첫 커밋이 모든 파일을 바꾼 것으로 보여 웹이 안 바뀐 배포에서도 ID 가 바뀐다. 이미 얕으면 `git fetch --unshallow`.
  - ⚠ **호스트에서 파일을 손으로 고쳐 빌드하지 않는다** — 커밋되지 않은 변경은 ID 를 바꾸지 않아, 웹이 바뀌었는데 클라이언트가 옛 사본을 계속 쓴다.
- `app` 은 호스트에 포트를 열지 않는다(`expose` 만). 열리는 것은 Caddy 의 80·443 뿐이다.
- `caddy` 의 헬스는 관리 API 다 — **인증서 발급에 실패해도 healthy 다.** `/healthz` 가 안 되면 `docker compose -f infra/compose.yml logs caddy` 를 본다(아래 「오류」).

### 3. [A] Gateway 접속·페어링 확인

```bash
docker compose -f infra/compose.yml logs app | grep -E 'gateway connected|pairing required'
```

- `"gateway connected"` 줄의 `gatewayVersion` 이 저장소가 핀한 OpenClaw 버전(`packages/openclaw-adapter/package.json` 의 `@openclaw/gateway-client`)과 같은지 본다. 원격이 `2026.9.5` 이상이면 플러그인은 ADR 0004 이후 번들이어야 한다(`docs/guides/live-smoke.md` 「원격 Gateway 에서 같은 절차를」 절). 같은 줄의 `pluginBuiltWithSdk` 는 Gateway 버전이 아니다.
- `device pairing required (requestId: …)` 가 **계속** 나오면 [B] 에서 `openclaw devices approve <requestId>`. 공유 토큰이면 보통 몇 초 뒤 자동 승인이라 필요 없다(ADR 0001).
- 디바이스 아이덴티티는 `/data/openclaw-device.json` 에 생긴다(볼륨 — 재시작해도 다시 페어링하지 않는다).

### 4. [PC → B] 플러그인 설치·브리지 설정

[PC] — 번들을 만들고 [B] 로 옮긴다.

```bash
pnpm -F @dodok/openclaw-plugin run pack:plugin
shasum -a 256 packages/openclaw-plugin/dist/index.js        # 이 값을 [B] 설치 뒤 대조한다
scp packages/openclaw-plugin/dist/dodok-openclaw-plugin-0.0.0.tgz <B>:/tmp/
```

[A] — 계정 설정 패치 파일을 `.env` 에서 만들어 [B] 로 옮긴다(토큰이 화면·셸 기록·`ps` 에 남지 않는다 — `printf` 는 셸 내장).

```bash
( . ./.env; umask 077
  printf '{ channels: { dodok: { accounts: { default: { bridgeUrl: "%s", token: "%s" } } } } }\n' \
    "$BRIDGE_PUBLIC_URL" "$BRIDGE_TOKEN" > /tmp/dodok.patch.json5 )
scp /tmp/dodok.patch.json5 <B>:/tmp/ && rm /tmp/dodok.patch.json5
```

[B] — **Gateway 를 먼저 내리고** 설치한다(2026.9.5 는 떠 있는 Gateway 에 라이브 리로드를 시도하다 실패하면서 파일도 안 바꾼다 — `docs/guides/live-smoke.md` 「플러그인 최신 번들 재설치」).

```bash
# Gateway 를 내린다(호스트가 Gateway 를 돌리는 방식대로)
openclaw plugins install /tmp/dodok-openclaw-plugin-0.0.0.tgz --force --accept-capabilities
openclaw plugins inspect dodok --json | jq '.plugin.status, .plugin.channelIds'   # "loaded", ["dodok"]
sha256sum ~/.openclaw/extensions/dodok/dist/index.js      # 기본 상태 디렉터리일 때. [PC] 의 값과 같아야 한다
openclaw config patch --file /tmp/dodok.patch.json5 && rm /tmp/dodok.patch.json5
# Gateway 를 올린다
```

- `--accept-capabilities` 가 없으면 설치되지 않는다. 호스트에 `security.installPolicy` 가 있으면 archive 설치(`provenance-invalid`)가 막힐 수 있다 — ADR 0002 「원격 배포 절차」.
- 첨부를 쓰기 전에 [B] 의 `attachments.ttlHours`·`tools.fs.workspaceOnly` 를 정한다 — `docs/guides/live-smoke.md` 「원격 Gateway 에서 같은 절차를」 절의 첨부 항목.

### 5. [A] 브리지 접속 확인

```bash
docker compose -f infra/compose.yml logs app | grep 'bridge plugin hello'
```

`"bridge plugin hello"` 줄이 있으면 플러그인이 `wss://<도메인>/bridge` 로 붙었다(Socket.IO `/socket.io/` 의 `/bridge` 네임스페이스). 그 줄의 `gatewayVersion` 은 플러그인이 보낸 Gateway 런타임 버전이다.
안 붙으면: [B] 계정 설정의 `bridgeUrl`(`wss://`, 경로 `/bridge`)·`token` 이 `.env` 의 `BRIDGE_PUBLIC_URL`·`BRIDGE_TOKEN` 과 같은지, [B] 에서 `https://<도메인>/healthz` 가 닿는지.
첨부 바이트는 같은 오리진의 HTTP `/bridge/attachments` 로 오간다 — Caddy 가 `/bridge/*` 를 서버로 넘긴다(`infra/Caddyfile` 의 `@backend`).

### 6. [폰] 로그인·설치·푸시

1. `https://<도메인>` → 로그인(`LOCAL_AUTH_TOKEN` — 폰에 옮길 때는 비밀번호 관리자처럼 화면에 남지 않는 길로).
2. iOS(16.4+): Safari 공유 → 「홈 화면에 추가」 → **그 아이콘으로 연다**(iOS 는 홈 화면 PWA 에서만 푸시가 된다). 안드로이드: Chrome 에서 연다(설치는 선택).
3. 앱의 알림 설정에서 「푸시 알림 켜기」 → OS 권한 허용.
4. [PC] 브라우저에서 에이전트에게 사람을 부르는 답을 내게 한다(예: 「@<핸들> 불러 줘」 류) — 또는 승인 요청.
5. 폰을 잠근 채 푸시가 오는지, 누르면 그 채널이 열리는지 본다.

결과는 아래 「사람이 한 번 따라 한 결과」 절에 적는다.

### 7. [A] 백업 한 번

```bash
docker compose -f infra/compose.yml exec app node dist/backup.js
# 백업 완료: /data/backups/<UTC 시각> (<N> bytes, <M> ms, 지움 <K>)
```

정기 백업은 아래 「백업」 절의 cron 줄.

## 백업

```bash
docker compose -f infra/compose.yml exec app node dist/backup.js [--keep N]
```

- 서버를 멈추지 않는다 — better-sqlite3 온라인 백업을 **한 번에 전부** 복사한다(한 읽기 트랜잭션의 스냅숏이라 쓰기와 겹쳐도 온전하다). 그동안 서버는 계속 쓰고, WAL 이 잠시 자랄 수 있다.
- 결과는 `/data/backups/<UTC 시각>/` 에 `dodok.sqlite` 와 `vapid.json`·`openclaw-device.json`(있으면 `openclaw-device-dev.json`) 사본, 전부 0600.
- **보관**: 최근 7개(기본), `--keep N` 으로 바꾼다. 넘친 것은 오래된 것부터 지운다. 보관 개수는 **백업 이름 형식(`YYYY-MM-DDTHH-MM-SS-mmmZ`)** 인 디렉터리만 센다 — 오래 둘 백업은 다른 이름으로 옮겨 둔다(그대로 두면 정리가 센다).
- **`.partial-*`**: 백업은 `backups/.partial-<시각>-XXXXXX/` 에서 만든 뒤 다 되면 `<시각>/` 으로 옮긴다. 중단(Ctrl-C·`SIGTERM` 은 스스로 지운다, `SIGKILL`·전원 끊김은 남는다)으로 남은 `.partial-*` 는 **복원에 쓰지 않는다** — 1시간이 지나면 다음 백업이 지운다.
- 출력은 한 줄(시크릿 없음), 실패는 exit 1 과 `백업 실패: <사유>` 한 줄(디스크 부족이면 부분 디렉터리를 지운다).
- **첨부는 백업에 들어가지 않는다** — 내용 주소(sha256) 블롭이라 백업마다 복사하지 않는다. 첨부까지 옮기려면 아래 「볼륨째 옮기기」.
- 백업은 같은 볼륨 안에 있다 — 호스트가 죽으면 같이 잃는다. 다른 곳으로 보내는 것은 사람 몫이다: `docker compose -f infra/compose.yml cp app:/data/backups/<이름> ./<이름>` 로 호스트에 꺼낸 뒤 옮긴다.

**cron 예시**(매일 04:00, 14개 보관). cron 에는 TTY 가 없으므로 `-T`. `infra/.env` 링크가 있어야 `--env-file` 없이 돈다.

```cron
0 4 * * * cd <저장소 경로> && docker compose -f infra/compose.yml exec -T app node dist/backup.js --keep 14 >> "$HOME/dodok-backup.log" 2>&1
```

### 볼륨째 옮기기(첨부 포함)

데이터는 볼륨 `dodok_dodok-data` 하나다(`dodok.sqlite`·WAL·`attachments/`·`vapid.json`·`openclaw-device.json`·`backups/`). 통째로 옮기면 서버를 옮길 수 있다.

```bash
docker compose -f infra/compose.yml stop app
docker compose -f infra/compose.yml run --rm --no-deps -u 0 -v "$PWD":/out --entrypoint tar app czf /out/dodok-data.tgz -C /data .
docker compose -f infra/compose.yml start app
```

새 호스트에서는 같은 저장소·`.env`·링크를 두고 `up` 전에 풀어 놓는다(`… run --rm --no-deps -u 0 -v "$PWD":/in --entrypoint tar app xzf /in/dodok-data.tgz -C /data` 뒤 `… run --rm -u 0 app chown -R 1000:1000 /data`). 이 두 명령은 아직 한 번도 돌려 보지 않았다 — 처음 쓰는 사람이 결과를 「사람이 한 번 따라 한 결과」 절에 적는다.

## 복원

일회용 컨테이너 안에서 한다.

```bash
docker compose -f infra/compose.yml stop app
docker compose -f infra/compose.yml run --rm --entrypoint sh app
```

컨테이너 안:

```sh
ls /data/backups                       # .partial-* 는 고르지 않는다
B=/data/backups/<고른 이름>
cp "$B/dodok.sqlite" /data/dodok.sqlite
rm -f /data/dodok.sqlite-wal /data/dodok.sqlite-shm
# 필요할 때만: cp -p "$B/vapid.json" /data/   ·   cp -p "$B/openclaw-device.json" /data/
exit
```

```bash
docker compose -f infra/compose.yml start app
docker compose -f infra/compose.yml ps     # app (healthy)
```

⚠ **WAL·SHM 삭제(`rm -f …-wal …-shm`)를 절대 빼먹지 않는다.** 남아 있으면 서버가 뜰 때 그 WAL 을 **방금 되돌린 파일 위에 재생해 복원이 조용히 무효가 된다** — 오류도 경고도 없고 `integrity_check` 도 `ok` 다.
로컬 검증에서 쟀다: 백업 시점 메시지 66건, 그 뒤 4건 더 쓰고 `docker kill` 로 WAL 을 남긴 채 `dodok.sqlite` 만 덮어 기동하면 **70건**, WAL·SHM 을 지우고 같은 절차면 66건. 다시 재려면 이 순서(백업 → 쓰기 → `docker kill app` → 덮기)를 따른다.
정상 정지(`docker compose stop`)는 서버가 DB 를 닫으며 WAL 을 합치고 지우므로 **지울 WAL 이 없는 게 정상**이다. WAL 이 남는 것은 비정상 종료(kill·크래시·OOM·전원) 뒤다 — 그래서 늘 지운다(없으면 `rm -f` 는 아무 일도 하지 않는다).

- `vapid.json` 을 되돌리면 그 백업 뒤에 켠 기기의 푸시 구독이 무효가 된다(키가 바뀐다). 키를 잃은 경우에만 되돌린다.
- `openclaw-device.json` 을 되돌리지 않고 지우면 Gateway 와 다시 페어링한다(체크리스트 3).

## 업데이트

```bash
docker compose -f infra/compose.yml exec app node dist/backup.js     # 이 백업의 이름을 적어 둔다
git rev-parse --short HEAD                                          # 되돌아갈 커밋을 적어 둔다
git pull --ff-only
DODOK_WEB_BUILD_ID=$(git log -1 --format=%h -- apps/web packages/shared pnpm-lock.yaml tsconfig.base.json package.json pnpm-workspace.yaml infra/Dockerfile.web) \
  docker compose -f infra/compose.yml up -d --build
docker compose -f infra/compose.yml ps                              # app·caddy (healthy)
```

마이그레이션은 부팅 때 자동이다. 플러그인이 바뀐 커밋이면 체크리스트 4를 다시 한다(재설치 뒤 Gateway 재시작).

### 되돌리기

부팅에 실패하면(`app` 이 unhealthy·재시작 반복 — `docker compose -f infra/compose.yml logs app`):

```bash
docker compose -f infra/compose.yml stop app
# 위 「복원」 절차로 **업데이트 직전 백업**을 되돌린다
git checkout <적어 둔 커밋>
DODOK_WEB_BUILD_ID=$(git log -1 --format=%h -- apps/web packages/shared pnpm-lock.yaml tsconfig.base.json package.json pnpm-workspace.yaml infra/Dockerfile.web) \
  docker compose -f infra/compose.yml up -d --build
```

⚠ **되돌릴 때는 반드시 업데이트 직전 백업으로 복원한다.** 마이그레이션은 앞으로만 간다 — 새 코드가 이미 올린 스키마를 옛 코드가 읽지 못한다. 더 오래된 백업이면 그 뒤의 데이터를 잃고, 더 새 백업(업데이트 뒤)이면 옛 코드가 못 연다. 백업 뒤 업데이트 사이에 쓰인 것은 잃는다.
고친 뒤 돌아올 때는 `git checkout main && git pull --ff-only` 부터 업데이트를 다시 한다(`checkout <커밋>` 은 detached HEAD 라 `pull` 이 안 된다).

## 오류

| 증상 | 원인·확인 | 고침 |
| --- | --- | --- |
| compose 명령이 `DODOK_DOMAIN 이 필요하다 — 루트 .env 에 두고 ln -s ../.env infra/.env` 로 멈춤 | 링크가 없거나 `.env` 에 `DODOK_DOMAIN` 이 비었다 | `ln -s ../.env infra/.env`, 값 채우기 |
| `app` 이 재시작을 되풀이, `caddy` 는 대기 | `.env` 필수 값이 없거나 틀렸다 — `docker compose -f infra/compose.yml logs app` 에 `설정 오류` 한 줄 | 그 값을 고치고 `up -d` |
| `app` 로그 한 줄: `설정 오류: DATA_DIR 에 쓸 수 없다: /data (EACCES) — 컨테이너면 볼륨 소유자를 1000:1000 으로: …` | 볼륨이 다른 UID(예: root)로 채워진 적이 있다. 컨테이너는 `node`(1000:1000)로 돈다. 빈 볼륨은 Docker 가 이미지의 `/data` 소유자를 입혀 이 경우가 안 생긴다 — 파일이 이미 든 볼륨에서만 난다 | `docker compose -f infra/compose.yml run --rm -u 0 app chown -R 1000:1000 /data` 뒤 `up -d` |
| `/healthz` 가 안 됨, `caddy` 는 healthy | 인증서 발급 실패 — `logs caddy`. 확인 순서: DNS A 레코드가 이 호스트인가 → 80·443 이 밖에서 열려 있나 → `DODOK_DOMAIN` 이 그 이름인가 | 고친 뒤 `docker compose -f infra/compose.yml restart caddy`. Let's Encrypt 는 실패가 잦으면 잠시 막는다 — 고치기 전에 되풀이하지 않는다 |
| Caddy 502 | `app` 이 아직 안 떴거나 재시작 중 | `ps`·`logs app` |
| 업데이트 뒤 `app` unhealthy | 마이그레이션·부팅 실패 — `logs app` | 위 「되돌리기」 |
| 웹이 「rejected」 배너 | 브라우저 주소와 `APP_ORIGIN` 이 다르다(스킴·포트·끝 슬래시까지) | `APP_ORIGIN=https://<도메인>` |
| 에이전트 목록이 비고 로그에 Gateway 재시도 | Gateway URL·토큰, 방화벽 — 서버는 멈추지 않고 재시도만 한다 | 체크리스트 3 |
| `bridge plugin hello` 가 안 나옴 | 플러그인 `bridgeUrl`·`token`, [B] → [A] 443 | 체크리스트 5 |
| 폰에 푸시가 안 옴(iOS) | `VAPID_SUBJECT` 가 로컬 자리값이면 Apple 이 `403 BadJwtToken` — 서버 시작 로그에 warn 한 줄 | 실제 연락처로 바꾸고 `up -d` |
| 백업 `백업 실패: …` exit 1 | 한 줄 사유(디스크 부족이면 부분 디렉터리는 지워진다) | 공간 확보 뒤 다시 |
| 에이전트 파일 업로드 413 | 32 MB 초과면 Caddy 의 413, 20 MiB~32 MB 면 서버의 413 JSON `{"code":"VALIDATION","message":"Request body is too large"}` — 첨부 전용 고정 문구가 아니다(`docs/plan.md` 8장 이월). 웹과 플러그인은 올리기 전에 크기를 걸러 자기 문구를 낸다 | 파일을 줄인다 |

## 보안

- 호스트에 열리는 포트는 Caddy 80·443(udp 포함)뿐이다. `app` 은 compose 내부 네트워크에만 있다.
- 컨테이너는 비루트(`node`)로 돈다. `.env`·`data/` 는 이미지에 들어가지 않는다(`.dockerignore`).
- HSTS·`nosniff`·`Referrer-Policy` 는 Caddy 가 붙인다. CSP 는 없다(스펙 「구현과 맞춘 것」).
- **`X-Forwarded-For` 를 위조해도 로그인 레이트리밋은 우회되지 않는다.** Caddy 에 `trusted_proxies` 가 없어(기본 — 아무도 믿지 않음) 클라이언트가 보낸 XFF 를 그대로 넘기지 않고 자기가 본 연결 IP 로 덮는다. 서버는 `TRUST_PROXY=true` 로 그 값을 읽는다. 로컬 검증에서 틀린 토큰 로그인을 XFF 를 바꿔 가며 보내도 5회 뒤 새 XFF 값의 첫 요청부터 429 였다(다시 재려면 `curl -H 'X-Forwarded-For: <아무 값>'` 으로 `POST /api/v1/auth/local` 을 6회). Caddy 앞에 다른 프록시를 더 두면 이 전제가 바뀐다 — 그때는 Caddy 에 그 프록시만 `trusted_proxies` 로 둔다.

## Docker 정리 규칙

이 저장소를 만지는 사람·에이전트는 **다른 프로젝트와 한 Docker 데몬을 나눠 쓴다**(개발 PC 가 그렇고, 배포 호스트도 그럴 수 있다).

- ⚠ **`docker image prune`·`volume prune`·`system prune`·`builder prune` 을 쓰지 않는다 — 어떤 필터로도.** 남의 dangling 이미지·빌드 캐시·볼륨이 함께 지워지고 되돌릴 수 없다.
- 지울 때는 **자기가 만든 것만, 이름이나 ID 로** 지운다. dangling 이미지는 `docker image ls --filter dangling=true --format '{{.ID}} {{.CreatedAt}}'` 로 생성 시각을 보고, 자기 작업 시간대의 것만 ID 로 `docker image rm`.
- 다른 compose 프로젝트의 컨테이너·볼륨·네트워크는 읽기만 한다. 작업 전후로 `docker ps -a`·`docker volume ls`·`docker image ls -a` 를 떠 두고 대조하면 무엇을 남겼는지 안다.
- 이 저장소가 만드는 이름: 이미지 `dodok-app`·`dodok-caddy`(로컬 검증은 `dodok-devfake` 도), 볼륨 `dodok_dodok-data`·`dodok_caddy-data`·`dodok_caddy-config`(로컬 검증은 `dodok_devfake-data` 도), 네트워크 `dodok_default`. 베이스 이미지(`node:24.21.0-bookworm`·`node:24.21.0-bookworm-slim`·`caddy:2.11.4`)는 다음 빌드의 캐시라 두는 것이 기본이다.
- ⚠ 운영 호스트에서 `down -v` 는 **데이터 볼륨을 지운다.** 운영에서는 `-v` 를 붙이지 않는다.

## 로컬 검증 (이 Mac)

운영과 같은 이미지·Caddy 를 `https://localhost:8443` 에 띄운다. 겹침 파일 `infra/compose.local.yml` 이 Caddy 내부 CA(`local_certs`)와 `127.0.0.1:8443` 하나만 연다 — devfake 프로필은 고정 로그인 토큰이라 LAN 에 열면 안 된다.

```bash
cp infra/local.env.example infra/local.env
for k in LOCAL_AUTH_TOKEN BETTER_AUTH_SECRET BRIDGE_TOKEN OPENCLAW_GATEWAY_TOKEN; do
  sed -i.bak "s/^$k=\$/$k=$(openssl rand -hex 32)/" infra/local.env; done; rm infra/local.env.bak
```

`infra/local.env` 는 git 제외다. 이 파일은 `app` 의 `env_file` 이면서 compose 의 `--env-file`(변수 치환)이라, **모든** compose 명령에 같은 조합을 붙인다.

```bash
# zsh 는 따옴표 없는 변수를 낱말로 쪼개지 않는다 — 변수 대신 함수로 둔다
lc() { docker compose --env-file infra/local.env -f infra/compose.yml -f infra/compose.local.yml "$@"; }

# 운영 모드 — Gateway 는 닿지 않는 주소(부팅은 막지 않는다). 로그인·채널·사람 메시지·첨부·PWA·푸시 구독까지
lc up -d --build
bash infra/check-caddy.sh https://localhost:8443      # 줄마다 PASS/FAIL, 끝 줄 「check-caddy: 전부 PASS」

# devfake 모드 — 가짜 Gateway·플러그인(dev:fake)을 Caddy 뒤에 둔다. 에이전트 스트리밍·카드·승인·에이전트 첨부가 Caddy 를 지나는지
DODOK_UPSTREAM=devfake:3000 lc --profile devfake up -d --build
# 로그인 토큰은 dev-fake-local-token(개발 전용 고정값)
```

- devfake → 운영으로 돌아갈 때: `lc --profile devfake stop devfake && lc --profile devfake rm -f devfake` 뒤 `lc up -d`(`DODOK_UPSTREAM` 없이 — Caddy 가 다시 만들어지며 `app:3000` 으로 돌아온다).
- 브라우저: ⚠ Claude-in-Chrome 은 자체 인증서를 넘기지 못한다(`ERR_CERT_AUTHORITY_INVALID`). Playwright 로 **`chromium.launchPersistentContext(<임시 디렉터리>, { args: ["--ignore-certificate-errors"], ignoreHTTPSErrors: true })`** — 임시 컨텍스트(`newContext()`)는 Chromium 이 시크릿으로 취급해 Push API 가 없다. 자세히는 `docs/guides/browser-verification.md` 「로컬 HTTPS(Compose 8443)를 볼 때」.
- 볼륨 권한 오류를 재현할 때: 빈 볼륨의 소유자만 root 로 바꾸면 Docker 가 첫 마운트 때 이미지 소유자로 되메꿔 재현되지 않는다 — 볼륨에 파일을 하나 넣은 뒤 `chown -R 0:0` 한다.
- 정리(위 「Docker 정리 규칙」):
  ```bash
  lc --profile devfake down -v                 # 프로필 없이 down -v 하면 devfake-data 볼륨이 남는다
  docker volume ls --filter name=dodok_         # 남았으면 그 이름으로 docker volume rm
  docker image rm dodok-app dodok-caddy dodok-devfake
  rm infra/local.env
  lsof -iTCP:8443 -sTCP:LISTEN                  # 비어 있어야 한다
  ```
  재빌드마다 생긴 dangling 이미지는 생성 시각으로 골라 ID 로 지운다.

## 사람이 한 번 따라 한 결과

실제 서버·도메인·폰으로 위 체크리스트를 처음 따라 한 사람이 채운다. 이것이 채워지면 Phase 2 ④ 가 넘긴 실기기 푸시 확인(`docs/plan.md` 8장 이월 「PWA·푸시」)이 닫힌다. 틀린 명령·빠진 단계는 이 문서 본문을 고치고, 여기에는 결과만 적는다.

| 단계 | 결과 | 메모(호스트·OS·버전·걸린 것) |
| --- | --- | --- |
| 1. 도메인·포트·저장소·`.env` | | |
| 2. 기동(healthy·`/healthz`) | | |
| 3. Gateway 접속·페어링(`gatewayVersion`) | | |
| 4. 플러그인 설치·sha 대조·계정 설정 | | |
| 5. 브리지 접속(`bridge plugin hello`) | | |
| 6. 폰 — iOS 홈 화면 PWA 푸시·누르기 | | |
| 6. 폰 — 안드로이드 Chrome 푸시·누르기 | | |
| 7. 백업·cron | | |
| 복원(업데이트 직전 백업) | | |
| 업데이트·되돌리기 | | |
| 볼륨째 옮기기 | | |
