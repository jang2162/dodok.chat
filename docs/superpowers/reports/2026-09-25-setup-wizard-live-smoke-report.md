# 설정 마법사(Phase 3 ②) 실연 — 2026-09-25 결과 (s2-t7, 계획 태스크 7, 모델 런 0회)

> 설정 마법사(Phase 3 ②)의 플러그인 설치·브리지 토큰 교체를 실물 dev Gateway 에서 돌린 실연의 기록 — 계획 `docs/superpowers/plans/2026-09-24-setup-wizard.md` 태스크 7, 스펙 `docs/superpowers/specs/2026-09-24-setup-wizard-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


실물 dev Gateway 위에서 「서버가 내려준 플러그인 tgz 설치 → 같은 빌드 → 새 브리지 토큰 발급 → dev 플러그인 설정 교체 → 접속 이동 → 옛 토큰 폐기 → 에이전트가 계속 돈다」를 돌리고, Compose 이미지가 플러그인을 품는 것을 한 번 더 쟀다.
메시지 경로는 11절 가짜 claude CLI 로만 두드렸다 — **모델 런 0회**(가짜 CLI 의 `-p` 런 2회, 나머지 12회는 `auth status --json`·`--version` 을 진짜 `claude` 로 넘긴 것).

**판정: 합격 기준 13/13 통과. dodok 코드 결함 0.** 새로 찾은 것은 환경 하나(앱 번들에서 CLI 가 사라짐 — 2절 표·3절 머리를 고쳤다)와 관찰성 하나(15.5).
로그는 워크트리 `data/`(ignored)에 두었다가 정리 때 지웠다: `dev-gateway.log`(Gateway·플러그인)·`phase3-live-s2t7.log`(서버·어댑터)·`web-5180.log`.

### 15.1 환경 실물

| 항목 | 값 |
| --- | --- |
| 워크트리 | main `eef129b` 그대로(코드 변경 없음) |
| OpenClaw CLI·Gateway | 스크래치 설치 `openclaw@2026.9.5` → `OpenClaw 2026.9.5 (ec9c1a1)`, mise Node 24.21.0(2절 표·3절 머리). `OpenClaw.app` 은 `2026.9.6` 이고 번들에 CLI 가 없다. 저장소 `2026.9.4` CLI 는 dev 설정을 거부했다(설정 파일 수정 시각·크기 무변 확인). 설치 전후 `~/.openclaw`·`~/.openclaw-dev` 목록·수정 시각 `diff` 동일 |
| 버전 로그 | `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z"`, scopes 에 `operator.admin` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"`(`pluginBuiltWithSdk="2026.9.4"` 는 빌드 상수). 12~14절의 `f396007` 과 빌드가 다르다 |
| 가짜 claude CLI | 11.4 스크립트 + 11.5 ②의 「`fake-args.json` 이 없으면 툴을 부르지 않는다」. Gateway 는 **매번** `PATH="<스크래치>/fakebin:$PATH"` 로 띄웠다(내장 cron 이 돌아도 가짜로 간다) |
| 플러그인 번들 | 설치 전 `e4a6284c…`(`bundleSha256` 을 싣지 않는 옛 빌드) → 서버가 내려준 tgz 설치 뒤 `9e59c7a5e4bf40839596f0e3fcfa14627e77ba68838c918f5a52bfb3903f1940`. **끝난 뒤에도 이 번들이 설치돼 있다**(`status: "loaded"`) |
| 서버 | `:19100`, `APP_ORIGIN=http://localhost:5180`, **`BRIDGE_PUBLIC_URL=ws://127.0.0.1:19100/bridge`**(발급 결과 `pluginConfig.bridgeUrl` 이 dev 계정의 `bridgeUrl` 과 같아야 조각을 그대로 patch 한다), DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug` |
| 웹·브라우저 | `DODOK_API_ORIGIN=http://127.0.0.1:19100 pnpm -F @dodok/web exec vite --port 5180 --strictPort`(5173·3000 무접촉) · `playwright-core@1.62.1` headless(`chromium_headless_shell-1234`), 매번 새 컨텍스트, 로그인은 `context.request.post('/api/v1/auth/local')` |
| 채널 | 교체 전 `s2t7-before-0212`(`01a0d467-7515…`) · 교체 뒤 `s2t7-after-0214`(`01a0d469-d8fe…`) — 멤버 `@dev`, 가짜 CLI 세션 id 가 박힌 하네스 전용 |
| 토큰 원문 | 새 토큰은 발급 응답을 스크래치 0600 파일로만 받았다(`jq` 로 토큰·`pluginConfig` 를 각각 0600 파일에). `.env` 의 `BRIDGE_TOKEN` 은 서브셸 변수로만. 화면·로그·argv 에 원문 0 |

### 15.2 합격 기준

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | `.env` 토큰을 빈 테이블에서 라벨 `env` 로 한 번 이어받음 | **통과** | 첫 부팅 `"label":"env","msg":"bridge token imported from .env"` 1줄. `GET /api/v1/setup/bridge-tokens` 에 `env` 1행(`connected:true`, prefix 는 해시 앞 6자). 버전 로그는 15.1 |
| 2 | 서버가 내려준 tgz 로 설치 | **통과** | `pack:plugin` 뒤 부팅 → `status.pluginFile.available:true`. owner `GET /api/v1/setup/plugin.tgz` 200·195,283 B·`filename="dodok-openclaw-plugin-95f80fb8c77e.tgz"`, 받은 sha256 `95f80fb8…` = `status.pluginFile.sha256`. 익명 401. Gateway 를 내리고 `oc --dev plugins install <받은 파일> --force --accept-capabilities` → `Installed plugin: dodok`·`Saved for the next Gateway start.` · `inspect` `"loaded"`·`["dodok"]` · 설치본 `dist/index.js` = `9e59c7a5…` = `status.pluginFile.bundleSha256` = tgz 안 `package/dist/index.js`. 명령은 연결 페이지 설치 블록(= `docs/guides/docker-deploy.md` 「[PC → B] 플러그인 설치·브리지 설정」 [B])과 같은 꼴 — 다른 것은 dev 의 `--dev`, 파일 자리(페이지는 `/tmp/<받은 이름>`, 이번엔 같은 이름으로 스크래치), sha 대조 경로(`~/.openclaw-dev/…`)뿐 |
| 3 | 같은 빌드 | **통과** | 설치 전(옛 플러그인): `bridge.plugin.bundleSha256:null`·`pluginMatches:null`. 설치 뒤: `bundleSha256` = `9e59c7a5…` = 설치본, `pluginMatches:true`, 화면 「서버와 같은 빌드입니다」 |
| 4 | 새 토큰 발급 | **통과** | `POST /api/v1/setup/bridge-tokens {"label":"s2t7-dev"}` → 201·`cache-control: no-store`. 원문은 `^dbt_[A-Za-z0-9_-]{43}$`, record prefix 는 `dbt_` 뒤 6자, `pluginConfig.bridgeUrl` = `ws://127.0.0.1:19100/bridge`. 목록 2행 활성(`env` 접속 중·`s2t7-dev`). 서버 로그 `"bridge token issued"` 1줄, 원문 0 |
| 5 | dev 플러그인 설정 교체(원문을 인자로 넘기지 않음) | **통과** | 발급 응답의 `pluginConfig` 를 스크래치 0600 파일로 → `oc --dev config patch --file <파일>` → 파일 삭제. `config patch` 는 `--file`·`--stdin` 을 받는다(`config set` 도 `--batch-file` 로 argv 를 피할 수 있지만 조작 배열 꼴이다) — 발급 결과가 patch 꼴 조각이고, 연결 페이지 발급 대화상자가 사람에게 권하는 「이 조각을 파일로 저장해 `openclaw config patch --file` 로 적용하고 저장한 파일은 지우세요」와 같은 길을 골랐다. 출력 `Applied 2 config update(s). Change will apply without restarting the gateway.`(`bridgeUrl` 은 같은 값), 출력에 원문 0 |
| 6 | 접속 이동 | **통과** | 9.5 는 patch 만으로 옮겨 갔다: Gateway `[reload] config change detected; evaluating reload (channels.dodok.accounts.default.token)` → `[gateway/channels] restarting dodok channel` → `[dodok] bridge: ready`. 서버 `bridge status changed down` 17:13:25.778 → `bridge plugin hello` .792(**14ms**). `status.bridge.plugin.tokenId` = 새 토큰 id, 새 행 `lastUsedAt` 17:13:25.792Z, `env` 행은 17:12:16.462Z 에서 멈춤. 이어 Gateway 를 명시적으로 재기동(자기 pid kill → 3절 (c))해도 새 토큰으로 붙었다(`connectedAt` 17:14:24.482Z, 거절 0). 이때 `lastUsedAt` 은 앞 갱신 59초 뒤라 그대로였다(1분 스로틀, 스펙대로). ⚠ `"bridge plugin hello"` 줄에 tokenId 가 없다 — 어느 토큰으로 붙었는지는 `setup/status`·토큰 목록으로만 본다(15.5) |
| 7 | 옛 토큰 폐기 — 현재 연결 유지, 옛 토큰 거절 | **통과** | `DELETE /api/v1/setup/bridge-tokens/<env id>` 204 · `"bridge sessions revoked"` `sessions:0` · `"bridge token revoked"`. 폐기 뒤 `connectedAt` 17:14:24.482Z 그대로, `bridge status changed` 없음. 옛 원문(서브셸 변수 → 프로브 env)으로 `/bridge` 네임스페이스 socket.io 핸드셰이크 2회 → 둘 다 `connect_error UNAUTHORIZED`(4ms·3ms), 서버 `"bridge connection rejected"` `"token mismatch from 127.0.0.1"` **1줄**(둘째는 스로틀). 되돌림 때(15.6) 실제 플러그인이 폐기된 토큰으로 33초 동안 8회 재시도했을 때도 서버 거절 줄은 1줄 |
| 8 | 에이전트가 계속 돈다(교체 전·후) | **통과** | 전: `s2t7-before` 에 `@dev 교체 전 기준선 프로브` → `message.created … author=agent:@dev runId=<그 런> replyTo=<그 사람 메시지> body="FAKE_CLI_DONE"` · `finalSource=plugin hasCanonical` · `RUN_FINISHED usage={"inputTokens":0,"outputTokens":0,"costUsd":0}`. 후(폐기 뒤): `s2t7-after` 에 `@dev 교체 뒤 프로브` → 같은 꼴(1.3초) |
| 9 | 서버 재기동 뒤 env 부활 없음 | **통과** | 서버 SIGINT → 같은 `.env` 로 다시 부팅: 이어받기 줄 없음, `"BRIDGE_TOKEN in .env is ignored — manage bridge tokens in the connection page"` warn **1줄**. `env` 행 `revokedAt` 그대로, `envTokenIgnored:true`, 화면 「.env 의 BRIDGE_TOKEN 은 더 이상 쓰지 않습니다 — 연결 페이지에서 발급하세요」. 플러그인은 백오프 3회 뒤 새 토큰으로 다시 붙었다(warn 0.6초 뒤 hello, `lastUsedAt` 갱신). `envTokenIgnored` 는 폐기 직후(재기동 전)에 이미 `true` 였다 — 스펙 「오류 처리」의 정의(`.env` 값이 DB 활성 토큰과 다르다) 그대로 |
| 10 | 로그 위생 | **통과** | 두 원문을 0600 파일로 두고 `grep -a -c -F -f <파일>` — 서버 로그·Gateway 로그·`web-5180.log`·`live-smoke.sqlite`(+`-wal`·`-shm`)·`openclaw-device-dev.json`·`wire-cli-session.json`·`vapid.json`·`live-smoke.env`·wire 전사·가짜 CLI 기록·Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-25.log` 전부 **0**(양성 대조: 발급 응답 파일 1, `.env` 1) |
| 11 | 연결 페이지 화면(선택) | **통과** | 1280px·390px 각 한 장. 두 폭 모두 로그인 200, 가로 넘침 0, 콘솔 오류 0. 「서버와 같은 빌드입니다」, 파일·번들 sha256, 설치 블록, `s2t7-dev` `dbt_3gcB0C…` 「지금 접속 중」·「폐기」 버튼, `env` 「.env 에서 이어받음」 「폐기됨」, `.env` 무시 줄. 원문 대화상자는 열지 않았다. 스크린숏은 `.superpowers/sdd/2026-09-24-setup-wizard/screens/s2-t7-connection-{1280,390}.png`(ignored) |
| 12 | Compose 이미지가 플러그인을 품음 | **통과** | `docker compose --env-file infra/local.env -f infra/compose.yml -f infra/compose.local.yml up -d --build`(2분 33초) → app·caddy healthy. owner 로 받은 tgz(`filename="dodok-openclaw-plugin-aff875e62dc3.tgz"`, 195,283 B) = 이미지 안 `/app/plugin/dodok-openclaw-plugin-0.0.0.tgz` = `status.pluginFile.sha256` = `aff875e62dc356d5e2e01809da7215dcf2d65e28f872500002c0791f529e0d71`. `status.pluginFile.bundleSha256` = tgz 안 `package/dist/index.js` = `9e59c7a5…` = **A 의 설치본과 같다**. tgz sha 는 호스트 pack(`95f80fb8…`)과 컨테이너 pack(`aff875e6…`)이 다르고 번들 sha 는 같다 — tar 메타데이터 차이, 서버가 번들 sha 로 「같은 빌드」를 가르는 까닭(스펙 「결정」 5). `DODOK_PLUGIN_DIR=/app/plugin` 이 이미지 `Config.Env`·`compose config` 의 `app.environment`·컨테이너 env 셋 다에 있다. 익명 tgz 401 |
| 13 | Compose 정리 | **통과** | `down -v` 는 dodok 프로젝트만(컨테이너 2·볼륨 3·네트워크 1). 이 빌드가 만든 이미지 32개(생성 시각이 빌드 창 안, 시작 스냅숏에 없던 ID)만 ID 로 지웠고 이미지 ID 목록이 시작과 같다. `prune` 은 쓰지 않았다. 실연 중 다른 compose 프로젝트의 컨테이너·볼륨·네트워크가 새로 생겼다 — 이 작업이 만든 것이 아니라 건드리지 않았다 |

### 15.3 증거 원문 (토큰 원문 없음)

```text
# 서버 — 첫 부팅
{"label":"env","msg":"bridge token imported from .env"}
{"mod":"adapter","scopes":["operator.read","operator.write","operator.approvals","operator.admin"],"gatewayVersion":"2026.9.5","gatewayBuildId":"2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z","msg":"gateway connected"}
# 교체(9.5 핫 리로드) — Gateway
[reload] config change detected; evaluating reload (channels.dodok.accounts.default.token)
[gateway/channels] restarting dodok channel
[reload] config hot reload applied (channels.dodok.accounts.default.token)
[dodok] bridge: ready (server 0.0.0, protocol 1)
# 폐기 — 서버
{"mod":"adapter","tokenId":"01a0d466-5b74-74c5-aff8-766fb39c6610","sessions":0,"msg":"bridge sessions revoked"}
{"tokenId":"01a0d466-5b74-74c5-aff8-766fb39c6610","msg":"bridge token revoked"}
{"mod":"adapter","reason":"token mismatch from 127.0.0.1","msg":"bridge connection rejected"}
# 서버 재기동
{"msg":"BRIDGE_TOKEN in .env is ignored — manage bridge tokens in the connection page"}
# 폐기된 토큰으로 되돌린 플러그인 — Gateway(서버 거절 줄은 1줄)
[dodok] bridge: 재연결 564ms 후 (시도 1, 원인 connect_error UNAUTHORIZED)
…
[dodok] bridge: 재연결 11675ms 후 (시도 8, 원인 connect_error UNAUTHORIZED)
```

### 15.4 브리지 토큰 교체 — 사람이 따라 할 절차

dev 는 모든 `openclaw` 에 `--dev` 를 붙이고 상태 디렉터리가 `~/.openclaw-dev` 다. 원격 Gateway 호스트는 `docs/guides/docker-deploy.md` 「[웹 → B] 플러그인 설치·브리지 토큰」의 [B] 와 같은 자리에서 한다. 정본 절차는 `docs/guides/docker-deploy.md` 「브리지 토큰 교체」다.

1. 연결 페이지의 그 Gateway 카드 「브리지 토큰」 → 「새 토큰 발급」 → 라벨. 대화상자의 「설정 복사」로 `pluginConfig` 조각을 복사한다(원문은 이때 한 번만 보인다).
2. Gateway 호스트에서 조각을 **파일로** 저장한다 — `umask 077` 인 셸에서 편집기로 붙여 넣는다. 셸 인자·`echo` 로 넘기지 않는다(`ps`·셸 기록에 남는다).
3. `openclaw config patch --file <파일> && rm <파일>`. 조각에는 `bridgeUrl` 도 들어 있다 — 서버의 `BRIDGE_PUBLIC_URL`(없으면 `APP_ORIGIN` 에서 만든 값)이 그 Gateway 가 서버에 닿는 주소와 다르면 조각 그대로 넣으면 안 된다. 2026.9.5 는 Gateway 재기동 없이 dodok 채널만 다시 띄운다(`Change will apply without restarting the gateway.`) — 브리지가 한 번 끊겼다가 새 토큰으로 곧 붙는다. 출력이 재기동 없이 적용된다고 말하지 않으면 Gateway 를 재기동한다.
4. 연결 페이지에서 새 토큰 줄에 「지금 접속 중」이 뜨는 것을 본다. 서버 로그로는 가를 수 없다(`"bridge plugin hello"` 에 tokenId 가 없다) — 화면이나 `GET /api/v1/setup/status` 의 `gateways[].bridge.plugin.tokenId` 로 본다.
5. 옛 토큰 줄 「폐기」. 지금 연결은 끊기지 않는다. 옛 토큰으로 붙는 것은 그 뒤로 `UNAUTHORIZED` 다.

### 15.5 새로 찾은 것

- **환경(고침) — `OpenClaw.app` 2026.9.6 번들에 CLI 가 없다.** 3절의 `OCBIN`(앱 번들 bin)이 가리키던 `openclaw` 가 사라져 `env: openclaw: No such file or directory` 로 멈춘다. 저장소 `2026.9.4` CLI 는 9.5 가 쓴 dev 설정을 거부한다. 2절 표·3절 머리·11.1 을 스크래치 설치 `openclaw@2026.9.5` 로 바꿨다(글로벌 설치 없이, `--ignore-scripts` 로 충분).
- **관찰성(낮음) — `"bridge plugin hello"` 로그에 tokenId 가 없다.** 교체 중 「어느 토큰으로 붙었나」를 서버 로그만으로는 못 가른다(화면·`setup/status` 로만). 자리는 `packages/openclaw-adapter/src/openclaw-adapter.ts` 의 `onHello` 가 남기는 `"bridge plugin hello"` 줄 — 같은 함수가 받는 세션의 `tokenId`(원문 아님)를 싣으면 된다. 코드는 고치지 않았다.
- **관찰 — 핫 리로드 교체는 브리지를 한 번 끊는다(14ms).** 스펙 「연결 페이지」의 교체 흐름이 말하는 「에이전트는 멈추지 않는다」는 맞지만 `bridge: down` 이 한 번 지나간다. 그 순간 돌던 런이 있으면 어떻게 되는지는 재지 않았다(이번 두 런은 교체 앞뒤에 따로 돌렸다).

### 15.6 사람이 볼 것

- 원격 Gateway(`wss://<도메인>/bridge`) 에서 15.4 를 끝까지 — 이번은 dev(루프백 `ws://`)만 쟀다. `docs/guides/docker-deploy.md` 결과 표에 적는다.
- 발급 대화상자의 「설정 복사」 → Gateway 호스트 편집기에 붙여 넣기(실제 OS 클립보드) — 이번은 API 로 발급해 대화상자를 열지 않았다.
- 14.3 의 표는 그대로다.

### 15.7 정리·잔여물

- 서버(SIGINT)·tsx watch/pnpm 부모·웹(vite)·Gateway 를 자기 pid 로 내렸다. **19001·19100·5180·3000·3100·8443 LISTEN 0, 5173 은 1 그대로**(다른 프로젝트, 무접촉).
- dev 플러그인 설정 토큰을 `.env` 의 `BRIDGE_TOKEN` 으로 되돌렸다(교체와 같은 `config patch --file`, 원문 출력 없이). 폐기된 토큰이라 실연 DB 서버는 거절했고(15.3 끝), DB 를 옮겨 둔 채 새 DB 로 서버를 띄워 `env` 이어받기 → 플러그인 접속·`pluginMatches:true` 를 확인한 뒤 내렸다. `bridgeUrl` 은 `ws://127.0.0.1:19100/bridge` 그대로.
- 설치본은 `9e59c7a5…`(main `eef129b` 빌드), `status: "loaded"`. dev 에이전트·승인 정책 무변경, 원격 `~/.openclaw` 무접촉(설치 전후 목록 동일).
- dev 채널 세션 2개(`s2t7-before`·`s2t7-after`, 가짜 claude 세션 id)가 `~/.openclaw-dev` 에 남는다 — 진짜 모델 런에 쓰지 않는다. 교체 때 OpenClaw 가 만든 설정 백업(`openclaw.json.bak*`)에 실연 토큰이 남았을 수 있다(열어 보지 않았다) — 그 토큰은 지운 실연 DB 에만 있던 것이라 어디에도 통하지 않는다.
- 스크래치의 `openclaw@2026.9.5` 설치본·가짜 CLI·토큰 파일·쿠키·Playwright 스크립트, 워크트리 `data/`, `infra/local.env` 를 지웠다. Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-25.log` 는 Gateway 기본 자리라 두었다(원문 0).
