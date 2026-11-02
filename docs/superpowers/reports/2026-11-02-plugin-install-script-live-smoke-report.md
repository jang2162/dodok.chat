# 실연 보고 — OpenClaw 플러그인 설치 한 줄 명령(2026-11-02)

계획 `docs/superpowers/plans/2026-11-02-openclaw-plugin-install-command.md` Task 5 · 스펙 `docs/superpowers/specs/2026-11-02-openclaw-plugin-install-command-design.md`. 모델 런 0회.

## 환경

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI | 스크래치에 `npm install --prefix <스크래치>/oc --ignore-scripts openclaw@2026.9.4` — `OpenClaw 2026.9.4 (3a9d69d)`(AGENTS.md 핀). 서버 로그 `gatewayBuildId` `2026.9.4-release-3a9d69db306c-2026-09-10T22-53-16.719Z` |
| Gateway 상태 | `--dev` 대신 `OPENCLAW_HOME=<스크래치>/gwhome` — 스크립트는 `openclaw` 를 `--dev` 없이 부르므로 상태를 환경으로 갈랐다. 기본 설정 위에 `gateway.mode "local"`·`gateway.port 19197`·`cron.enabled false`·`agents.defaults.heartbeat.every "0m"`·`tools.agentToAgent.enabled false`·bonjour 끔·memory-core dreaming 끔 |
| Gateway 기동 | `openclaw gateway run --auth token --port 19197 --bind loopback`(서비스가 아니다), 환경 `OPENCLAW_SKIP_CRON=1`·`OPENCLAW_SKIP_STARTUP_MODEL_PREWARM=1`, 공유 토큰은 스크래치 0600 파일 → `OPENCLAW_GATEWAY_TOKEN` |
| 서버 | 이 브랜치 소스 실행 `node --import tsx src/main.ts`, 포트 3197, 스크래치 `DATA_DIR`·`DB_PATH`, `BRIDGE_PUBLIC_URL=ws://127.0.0.1:3197/bridge`, 설정 키는 모두 환경으로(루트 `.env` 를 쓰지 않음). 플러그인 tgz 는 `pnpm -F @dodok/openclaw-plugin run pack:plugin`(끝난 뒤 `packages/openclaw-plugin/dist` 를 지웠다) |
| 웹 | 띄우지 않았다 — 카드가 그리는 값(`GET /api/v1/setup/status`·`GET /api/v1/gateways/:id/bridge-tokens`)을 API 로 읽었다 |

Gateway 추가는 `POST /api/v1/gateways`(루프백 + 공유 토큰이라 자동 페어링 — `gateway connected` scopes 에 `operator.admin`). 브리지 토큰은 `POST /api/v1/gateways/:id/bridge-tokens` 로 발급하고, 대화상자가 그리는 한 줄과 같은 꼴(` curl -fsS http://127.0.0.1:3197/api/v1/setup/plugin-install.sh | DODOK_BRIDGE_TOKEN='<원문>' bash`)을 스크래치 0600 파일에 적어 `bash <그 파일>` 로 돌렸다. 화면에서 복사하지 않은 것만 계획과 다르다(꼴은 `pluginInstallCommand` 와 `connection.test.tsx` 가 대조한다).

## 결과

| # | 무엇을 | 명령 | 끝 코드 | 본 것 |
| --- | --- | --- | --- | --- |
| ① | Gateway 가 떠 있고 서비스가 아닐 때 한 줄 그대로 | 발급 토큰 `first` 의 한 줄 | 1 | `dodok: 이 호스트의 Gateway 가 서비스로 깔려 있지 않아 설치하지 않았습니다(아무것도 바꾸지 않았습니다). … DODOK_GATEWAY_SERVICE=0 …`. Gateway pid 그대로, `extensions/` 없음 |
| ② | Gateway 를 직접 내리고 `DODOK_GATEWAY_SERVICE=0` | 같은 줄의 bash 앞에 `DODOK_GATEWAY_SERVICE=0` | 0 | 받기 → 설치(`Installed plugin: dodok`) → 계정 설정(`Applied 2 config update(s)`) → 「설치가 끝났습니다. Gateway 를 직접 올리세요.」. `plugins inspect dodok` status `loaded`·channelIds `["dodok"]`·`rootDir` 가 `<상태>/extensions/dodok`, 설치본 `dist/index.js` sha256 앞 16자 `45572516386a3b40` = 서버가 품은 번들. 계정 `bridgeUrl` `ws://127.0.0.1:3197/bridge`. Gateway 를 직접 올리자 `bridge plugin hello`(tokenId = `first`), 상태 `gateway connected`·`bridge connected`·`pluginMatches true`(카드 「접속됨」·「서버와 같은 빌드입니다」) |
| ②' | 교체·업데이트 — 새 토큰 `second` 로 같은 명령 | ②와 같은 꼴 | 0 | 붙은 토큰이 `second` 로 옮겨 감. 토큰 목록 `second connected:true`, `first connected:false`(둘 다 활성) — 카드가 옛 줄에 「이제 폐기해도 됩니다」를 그리는 조건(`TokenList.tsx`). `pluginMatches true` 그대로 |
| ③ | 틀린 토큰(`dbt_` + 43자 무작위) | 기본 한 줄 | 1 | `dodok: 토큰이 틀렸거나 폐기됐습니다(401) — 연결 페이지 Gateway 카드에서 토큰을 새로 발급해 그 명령을 다시 돌리세요.` Gateway pid·설치본·`openclaw.json` 의 수정 시각 모두 그대로, 브리지 `connected` 그대로 |

- 토큰 원문 개수: 두 발급 토큰 모두 서버 로그·Gateway 로그·스크립트 출력·`/tmp/openclaw/openclaw-2026-11-02.log` 에서 0번.
- 모델 런: 0회 — Gateway 로그에 `[heartbeat] disabled`·cron 꺼짐(`scheduled skill collection reviews are disabled`)만 있고 런 줄이 없다. 서버 로그에도 런이 없다.
- 홈의 `~/.openclaw`·`~/.openclaw-dev` 안에는 기동 뒤 수정된 항목이 없다(`find -newer`). 사람의 OpenClaw 앱(`ai.openclaw.mac`, 포트 18789)은 건드리지 않았다.

## 실연에서 나온 것 — 스크립트를 고쳤다

**스펙 2절 5번의 전제가 2026.9.4 에서 틀렸다.** 스펙은 「`openclaw gateway stop --force` 가 실패하면(서비스가 아닌 Gateway) 설치하지 않고 멈춘다」고 봤지만, 2026.9.4 의 `runDaemonStop`(`dist/lifecycle-*.mjs`)은 서비스가 로드되지 않았으면 실패하지 않고 `stopGatewayWithoutServiceManager` 로 **떠 있는 비관리 Gateway 에 SIGTERM 을 보내고 성공**한다. 그 뒤의 `openclaw gateway start` 는 서비스가 없어 그 Gateway 를 다시 올리지 못한다 — 스크립트가 Gateway 를 내린 채 끝나는 「실패로 칠 것」 3번이 된다. 락·설정에서 포트를 못 찾으면 기본 포트(18789)의 Gateway 를 겨눌 수도 있다.

→ 커밋 `600c7bc fix(server): refuse to install when the Gateway is not a service` — 내리기 전에 `openclaw gateway status --json --no-probe` 의 `service.loaded` 를 보고, `true` 가 아니면(또는 상태를 못 읽으면) 아무것도 건드리지 않고 `DODOK_GATEWAY_SERVICE=0` 을 안내하며 멈춘다. ①이 그 동작이다.

## 확인하지 못한 것

- **systemd(우분투) 호스트에서 `service.loaded`** — 이 머신은 macOS 라 launchd 의 `not-loaded` 만 봤다. 사람의 Gateway 는 우분투 systemd 서비스다. user 단위 서비스(`openclaw gateway install`)면 `loaded: true` 가 기대값이고, system 단위 유닛이면 `false` 로 읽혀 스크립트가 멈출 수 있다 — 그때는 직접 내리고 `DODOK_GATEWAY_SERVICE=0` 으로 돌리면 된다(안전한 쪽으로 실패). 원격 Gateway 에서 처음 돌릴 때 끝 코드와 `openclaw gateway status --json --no-probe` 의 `service` 를 함께 본다.
- **서비스로 깔린 Gateway 에서 stop → install → start 전체 흐름** — 이 머신에는 dodok 용 Gateway 서비스가 없고(`gateway install` 금지), 사람의 앱 Gateway 를 건드릴 수 없어 재지 않았다. 순서와 실패 시 다시 올리기는 가짜 `openclaw` 시험(`apps/server/test/setup.plugin-install-script.test.ts`)만 잰다.
- **화면** — 대화상자의 「설치 명령 복사」와 카드 문구는 웹 시험만 잰다(이 실연은 같은 값을 API 로 읽었다).
- 2026.9.5 이상의 Gateway — 재지 않았다.
