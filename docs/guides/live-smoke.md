# dev Gateway 실연(live smoke) — 실제 Gateway·플러그인·러너·모델로 앱을 돌려 보는 절차

이 문서는 **지금 참인 절차**만 싣는다. 지난 실연의 결과(환경 실물·합격 기준 표·새로 찾은 것)는 `docs/superpowers/reports/*-live-smoke-report.md` 다 — 그 시점 기록이라 절차로 읽지 않는다. 새 실연의 결과도 이 문서가 아니라 새 리포트 `docs/superpowers/reports/<YYYY-MM-DD>-<주제>-live-smoke-report.md` 에 쓰고(머리에 무엇의 실연인지·계획과 태스크), 그 실연이 찾은 **지금도 참인 절차·함정**만 이 문서의 알맞은 절에 올린다.

## 1. 목적

통합 테스트(`apps/server/test/integration/`)는 가짜 Gateway·가짜 플러그인으로 돈다. 가짜가 실물과 다르게 구는 곳(구독 범위·지연·모델 출력)은 거기서 잡히지 않는다.
이 절차는 **실제 서버 + 로컬 dev Gateway(OpenClaw — 판은 「전제」 절) + 실제 플러그인 번들 + 실제 모델(claude-cli)** 로 기능마다 손으로 한 번 돌려
지연을 재고 틀린 것을 찾는다. 모델 런은 돈이 드므로 브리프가 상한을 정한다.
모델 런 없이 모델 경로를 두드리는 **런 0회 하네스**가 둘이다 — OpenClaw 쪽(「런 0회 하네스 — 모델 없이 모델 런의 툴 경로를 두드리기」 절, 가짜 claude CLI)과 러너 쪽(「Claude 러너 런 0회 하네스 — 번들 CLI + 가짜 Messages API」 절). 실연은 대개 하네스로 먼저 끝까지 돌리고, 모델로만 볼 수 있는 것만 사용자가 승인한 상한 안에서 모델 런으로 본다.

| 하려는 것 | 절 |
| --- | --- |
| dev Gateway·서버를 띄우고 Gateway·브리지를 붙이기 | 「전제」·「절차」 |
| REST·wire 를 손으로 두드리기 | 「`wire-cli`」 |
| 웹을 얹어 화면으로 보기 | 「웹을 얹을 때」 |
| 승인 카드를 실물에서 일으키기 | 「승인(Phase 2 ①)을 실물에서 보기 — 절차」 |
| 사람만 볼 수 있는 것(소리·팝업·잠금 화면·VoiceOver·OS 클립보드) | 「사람이 눈·귀로 확인할 것」 |
| OpenClaw 모델 런의 툴·첨부·승인·프롬프트를 모델 없이 | 「런 0회 하네스 — 모델 없이 모델 런의 툴 경로를 두드리기」 |
| Gateway 를 둘 이상 띄우기(사람의 dev 상태를 건드리지 않고) | 「Gateway 를 여럿 띄울 때」 |
| 러너(dodok-runner)를 모델 없이, 또는 모델 런으로 | 「Claude 러너 런 0회 하네스 — 번들 CLI + 가짜 Messages API」 |
| 웹 푸시·PWA | 「PWA·푸시(Phase 2 ④) — 푸시 확인 절차·VAPID 키 옮기기·사람이 볼 것」 |
| 브리지 토큰 교체 | 「브리지 토큰 교체 — 사람이 따라 할 절차」 |
| 바깥 MCP 클라이언트(`claude mcp`) | 「바깥 MCP 클라이언트 손 확인 — `claude mcp`」 |
| `llms.txt` 안내서 | 「`llms.txt` 안내서 따라 하기」 |
| iOS·Android 앱 푸시(실제 APNs·FCM, 사람이 한다) | 「네이티브 푸시 손 확인」 |

**지난 실연 결과** — 실연을 다시 돌리기 전에 같은 주제의 리포트에서 「새로 찾은 것」·「사람이 볼 것」을 먼저 본다.

| 주제 | 리포트 |
| --- | --- |
| 서버 코어(멘션·릴레이·이어가기·리셋·Gateway 재기동 복구, usage 값의 출처) | `docs/superpowers/reports/2026-09-15-server-core-live-smoke-report.md` |
| 웹 MVP(스트리밍 버블·지연·연결 점·중지 계측) | `docs/superpowers/reports/2026-09-20-web-mvp-live-smoke-report.md` |
| 승인 알림 재검증(알림 1건·tag·onclick·권한 팝업) | `docs/superpowers/reports/2026-09-21-approval-notifications-live-smoke-report.md` |
| components v1(모델이 낸 카드·결함 1·2·`ask_user`) | `docs/superpowers/reports/2026-09-23-components-v1-live-smoke-report.md` |
| 결함 1 고침(플러그인 전역 레지스트리, ADR 0004) | `docs/superpowers/reports/2026-09-23-plugin-registry-fix-live-smoke-report.md` |
| 첨부(하네스·모델 런 2회·결함 A 와 그 고침) | `docs/superpowers/reports/2026-09-23-attachments-live-smoke-report.md` |
| PWA·푸시(실제 FCM, GCM 연결 함정) | `docs/superpowers/reports/2026-09-24-pwa-push-live-smoke-report.md` |
| 설정 마법사(서버가 내려준 플러그인·브리지 토큰 교체) | `docs/superpowers/reports/2026-09-25-setup-wizard-live-smoke-report.md` |
| 운영 보강(런 한도·「다시 실행」·끊김 사건·버전 드리프트) | `docs/superpowers/reports/2026-09-25-ops-hardening-live-smoke-report.md` |
| 스레드(하위 세션·delivery-mirror·최종 답 억제) | `docs/superpowers/reports/2026-09-26-threads-live-smoke-report.md` |
| 팀(헤더 「참여자:」·승인 권한·푸시 대상·내보내기) | `docs/superpowers/reports/2026-09-27-team-live-smoke-report.md` |
| Claude 러너 런 0회 하네스(합격 기준 12) | `docs/superpowers/reports/2026-09-29-claude-runner-harness-live-smoke-report.md` |
| Claude 러너 모델 런(규칙 변경 뒤 `resume`) | `docs/superpowers/reports/2026-09-29-claude-runner-live-smoke-report.md` |
| 멀티 Gateway(같은 id 에이전트 둘·끄기·지우기) | `docs/superpowers/reports/2026-10-05-multi-gateway-live-smoke-report.md` |
| `llms.txt` 안내서 | `docs/superpowers/reports/2026-10-05-llms-txt-live-smoke-report.md` |
| 리액션(모델 입력·러너 턴 사실) | `docs/superpowers/reports/2026-10-07-reactions-live-smoke-report.md` |
| 제어 MCP(플러그인·러너·`claude mcp`, 카드 6분 반 끊김) | `docs/superpowers/reports/2026-10-13-control-mcp-live-smoke-report.md` |
| 채널 세션(대화 id 키·「이전 대화」 이어짐·대화 밖 전송 거절) | `docs/superpowers/reports/2026-10-26-channel-sessions-live-smoke-report.md` |
| 에이전트 DM(DM 줄·「이 DM 의 지시」·DM 밖 전송 거절) | `docs/superpowers/reports/2026-10-27-agent-dm-live-smoke-report.md` |
| 러너 일반화(CLI `cwd`·`<agent-instructions>`·`RUNNER_CEILING`·절대 경로 0) | `docs/superpowers/reports/2026-10-30-runner-generalization-live-smoke-report.md` |

## 2. 전제

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI | **스크래치 디렉터리에 설치한 `openclaw@2026.9.5`** 를 저장소 mise Node 24.21 로 돌린다(설치·`oc` 정의는 「절차」 절 머리). `OpenClaw.app` 번들에는 CLI 가 없다 — 앱 2026.9.6(2026-09-24 자동 업데이트)의 `Resources/node-worker/*/lib/node_modules/openclaw` 는 맥 노드 워커 전용이라 `bin/openclaw`·`openclaw.mjs` 가 없고 `package.json` 의 `bin` 이 비었다. 저장소 devDependency(`2026.9.4`)는 dev 설정을 `Config was last written by OpenClaw 2026.9.5, but you are running 2026.9.4` 로 거부하므로 쓰지 않는다 — 그 메시지가 권하는 `doctor --fix` 는 dev 설정을 옛 판으로 고쳐 쓰니 하지 않는다. `gateway install`·글로벌 설치·시스템 Node 교체 금지, 설치본은 스크래치에만 두고 끝나면 지운다. ⚠ npm 의 `2026.9.5` 는 빌드 `ec9c1a1`(`gatewayBuildId` `2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z`)로, 앱 번들 9.5 의 `f396007` 과 버전 문자열은 같고 빌드가 다르다. 저장소 핀은 `2026.9.4` 그대로라 **실연 전에 `oc --version` 을 적는다**. 서버 로그로도 보인다: `"gateway connected"`·`"bridge plugin hello"` 의 `gatewayVersion`. ⚠ 같은 줄의 `pluginBuiltWithSdk`(옛 이름 `sdkVersion`)는 **빌드 때 박힌 devDependency 상수**라 9.5 위에서도 `2026.9.4` 다 — Gateway 버전으로 읽지 않는다. 9.5 dist 를 코드로 읽어야 하는 리뷰가 남아 있으면 그 설치본을 지우기 전에 끝내거나, 다시 설치해 읽는다 — 저장소 핀 9.4 의 `node_modules/openclaw/dist` 만 읽었으면 리뷰 보고에 「9.4 dist 로만 확인」 이라고 적는다 |
| 프로필 | **dev 만**: 모든 CLI 호출에 `--dev`(상태 `~/.openclaw-dev`). 원격 프로필 `~/.openclaw` 는 건드리지 않는다. Gateway 를 여럿 띄우거나 사람의 dev 상태를 건드리지 않으려면 `--dev` 대신 `OPENCLAW_HOME=<스크래치 디렉터리>`(상태가 `<그 디렉터리>/.openclaw` 로 간다)로 가른다 — 「Gateway 를 여럿 띄울 때」 절 |
| 에이전트 | `dev`·`fin`, 모델 `anthropic/claude-opus-5` + `agentRuntime claude-cli`(ADR 0002 2절) |
| 플러그인 계정 | `channels.dodok.accounts.default = { bridgeUrl: "ws://127.0.0.1:19100/bridge", token: <브리지 토큰> }` — 토큰은 연결 페이지의 그 Gateway 카드에서 발급한 것(「절차」 절 (e)) |
| Gateway 공유 토큰 | 실연 쪽이 만들어 0600 파일 `data/dev-gateway.token` 에만 둔다(「절차」 절 (c)) — Gateway 를 띄울 때 OpenClaw CLI 의 env `OPENCLAW_GATEWAY_TOKEN` 으로 넘기고, 연결 페이지 「Gateway 추가」의 토큰 칸에 같은 값을 넣는다. 서버는 Gateway 주소·토큰을 `.env` 에서 읽지 않는다(DB). **`.env` 는 고치지 않는다** |
| 저장소 | Node 24.21.0 · pnpm 11.16.0, `pnpm install` 끝 |

### 시크릿 규칙

- `.env`·`~/.openclaw-dev/openclaw.json`·`~/.openclaw/openclaw.json` 은 cat·grep 하지 않는다. 값은 서브셸에서 `. ./.env` 로 **셸 변수**로만 읽고 echo 하지 않는다.
- Gateway 토큰은 OpenClaw CLI 의 env `OPENCLAW_GATEWAY_TOKEN` 으로만 넘긴다(인자 금지 — ps 에 남는다). 자식 환경에서 원격 `OPENCLAW_GATEWAY_URL` 은 뺀다(둘 다 OpenClaw CLI 가 읽는 변수다 — dodok 서버는 읽지 않는다). 서버에는 연결 페이지(또는 `POST /api/v1/gateways` 본문 — 파일에서 `jq --rawfile` 로)로만 넣는다.
- `config get` 은 URL 키만(`channels.dodok.accounts.default.bridgeUrl`). `config get channels.dodok` 처럼 토큰이 딸려 나오는 조회는 하지 않는다.
- `openclaw … cron` 같은 Gateway RPC CLI 는 `--url` 을 주면 `--token` 인자를 요구한다 — `--url` 대신 `--port 19001` 을 쓴다.
- 로그(`data/dev-gateway.log`·`data/phase1-live-<날짜>.log`)는 커밋하지 않지만, 옮기기 전에 토큰 값이 0번 나오는지 `grep -c -F -- "$TOK"` 로 개수만 확인한다.
- ⚠ **에이전트 자신이 시크릿을 읽을 수 있다.** dev 에이전트의 exec 는 기본 `security: "full"`(「승인(Phase 2 ①)을 실물에서 보기 — 절차」)이라, 일이 막히면 모델이 스스로 Bash 로 `~/.openclaw-dev/*.json` 을 뒤진다.
  그 툴 결과는 **런 이벤트(`run_events.payload_json`)·프레임 덤프·claude-cli 전사**에 그대로 남고 활동 탭에도 보인다.
  그래서 개수 확인은 로그만이 아니라 `data/*.sqlite*`(`-wal`·`-shm` 포함)·`data/frames-*.jsonl` 까지 한다. 들어갔으면 DB 는 가리고(값을 인자로 넘기지 않게 SQL 을 표준 입력으로) `PRAGMA wal_checkpoint(TRUNCATE)`·`VACUUM` 뒤 파일 바이트로 다시 센다 — 체크포인트 전에는 값이 WAL 에, VACUUM 전에는 빈 페이지에 남는다. 덤프는 지운다. claude-cli 전사에 남은 것은 지울 수 없으니(모델 제공자에게도 이미 갔다) 그 토큰을 교체한다.
- ⚠ **Gateway 가 띄우는 claude CLI 는 Gateway 의 환경을 물려받는다** — `OPENCLAW_GATEWAY_TOKEN` 도 CLI 환경에 있다(가짜 CLI 의 `envKeys` 로 보인다). exec 를 가진 에이전트는 그 값을 명령으로 읽을 수 있으므로 실연 Gateway 의 공유 토큰은 실연 뒤 버린다(스크래치에서 새로 만든 것만 쓴다). 에이전트 세션의 셸에서 Gateway·서버를 띄울 때는 `CLAUDE_CODE_*`·`CLAUDECODE` 같은 세션 변수도 `env -u` 로 뺀다.
- 세션 토큰을 `curl` 에 실을 때는 `-K -`(표준 입력의 설정)로 싣는다. `-K -` 와 `-d @-` 는 표준 입력을 함께 쓸 수 없다 — 본문은 0600 파일에서 `-d @<파일>` 로 싣거나 인자로 준다(본문에 시크릿이 없을 때만).
- `config patch` 는 `~/.openclaw-dev/openclaw.json.bak*` 백업을 남길 수 있다 — 브리지 토큰을 바꾼 뒤 그 백업에 옛 토큰이 있을 수 있으니 열지 말고 지운다(그 토큰은 폐기한다).

## 3. 절차

아래 `oc` 는 dev Gateway CLI 를 부르는 약속이다(각 셸에서 정의). CLI 는 스크래치 디렉터리에 한 번 설치한다 — 앱 번들에는 없다(「전제」 절 표).

```bash
OCDIR=<스크래치 디렉터리>/oc     # 레포·홈 밖. 끝나면 rm -rf "$OCDIR"
npm install --prefix "$OCDIR" --ignore-scripts --no-audit --no-fund openclaw@2026.9.5
OCBIN=$OCDIR/node_modules/.bin   # openclaw → openclaw.mjs(#!/usr/bin/env node — PATH 의 mise Node 24.21 로 돈다)
oc() { env PATH="$OCBIN:$PATH" openclaw "$@"; }
oc --version                     # OpenClaw 2026.9.5 (ec9c1a1)
```

zsh 에서 Gateway id 를 셸 변수에 담을 때는 `GID`·`UID`·`EUID` 대신 `GWID` 같은 이름을 쓴다 — 셋은 읽기 전용 특수 변수라 `bad math expression` 으로 명령이 깨진다.

`--ignore-scripts` 로 설치해도 `--dev` 의 `plugins`·`config`·`gateway run` 이 돈다. 설치가 `~/.openclaw`·`~/.openclaw-dev` 를 건드리지 않는지는 두 디렉터리의 `ls -la` 를 설치 전후로 떠서 `diff` 로 본다.
아래 절들의 `PATH="$OCBIN:$PATH" openclaw …` 는 이 `OCBIN` 을 그대로 쓴다.

### (a) 이전 실연·스파이크의 채널 설정 지우기

```bash
oc --dev config unset channels.dodok.channels     # 계정 default 는 그대로
```

### (b) 플러그인 최신 번들 재설치

```bash
pnpm -F @dodok/openclaw-plugin run pack:plugin
oc --dev plugins install packages/openclaw-plugin/dist/dodok-openclaw-plugin-0.0.0.tgz --force --accept-capabilities
oc --dev plugins inspect dodok --json | jq '{status: .plugin.status, channelIds: .plugin.channelIds}'   # status "loaded"
shasum -a 256 packages/openclaw-plugin/dist/index.js ~/.openclaw-dev/extensions/dodok/dist/index.js     # 둘이 같아야 한다
```

설치는 떠 있는 Gateway 에 반영되지 않는다(「next Gateway start」) — Gateway 를 이 뒤에 띄우거나 재시작한다.

> ⚠ **Gateway 를 먼저 내리고 설치한다.** 2026.9.5 는 떠 있는 Gateway 에 라이브 리로드를 시도하다
> `unauthorized: device token scope mismatch (re-pair or approve scope upgrade)` 로 실패하는데, **파일도 갱신되지 않는다**.
> 실패를 놓치면 옛 번들을 그대로 재게 된다 — **설치 뒤 위 sha 두 줄이 같은지 반드시 확인**한다.

### (c) dev Gateway 기동

```bash
mkdir -p data
( umask 077; [ -s data/dev-gateway.token ] || openssl rand -hex 24 > data/dev-gateway.token )   # 이 dev Gateway 의 공유 토큰 — 출력하지 않는다
( printf '\n===== gateway start %s\n' "$(date -u +%FT%TZ)" >> data/dev-gateway.log
  env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$(cat data/dev-gateway.token)" OPENCLAW_CLI_BACKEND_LOG_OUTPUT=1 PATH="$OCBIN:$PATH" \
    nohup openclaw --dev gateway run --dev --auth token --port 19001 --bind loopback \
    >> data/dev-gateway.log 2>&1 < /dev/null & )
until lsof -nP -iTCP:19001 -sTCP:LISTEN -t >/dev/null; do sleep 1; done
grep -m1 'http server listening' data/dev-gateway.log
```

`OPENCLAW_CLI_BACKEND_LOG_OUTPUT=1` 은 claude-cli 의 `cli argv:`·stdout 을 로그에 남긴다(프롬프트 주입·토큰 사용량 확인용). 서버가 아직 없으니 플러그인은 `bridge: 재연결 …ms 후` 를 백오프로 찍는다(상한 10s, 지터 포함 최대 ~12s 간격).

### (d) 서버 기동

실연 전용 환경 파일을 만든다(`data/` 는 ignored). 소스 실행의 서버는 루트 `.env` 도 읽지만 **이미 있는 환경 변수는 `.env` 가 덮지 않고**, Gateway 주소·토큰·브리지 토큰은 어차피 `.env` 에서 읽지 않는다(DB).

```bash
umask 077
PORT=$(oc --dev config get channels.dodok.accounts.default.bridgeUrl | sed -E 's#^wss?://[^:/]+:([0-9]+).*#\1#')   # 계정 설정은 바꾸지 않는다
cat > data/live-smoke.env <<EOF
APP_ORIGIN=http://localhost:5173
PORT=$PORT
BRIDGE_PUBLIC_URL=ws://127.0.0.1:$PORT/bridge
DB_PATH=data/live-smoke.sqlite
LOCAL_AUTH_TOKEN=$(openssl rand -hex 24)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
LOG_LEVEL=debug
EOF
(set -a; . data/live-smoke.env; set +a; nohup pnpm -F @dodok/server dev >> data/phase1-live-$(date +%Y%m%d).log 2>&1 < /dev/null &)
```

- `BRIDGE_PUBLIC_URL` 은 발급 조각의 `bridgeUrl` 이 된다 — 비우면 `APP_ORIGIN`(웹 5173)에서 만들어져, (e) 에서 조각을 patch 하면 플러그인이 Vite 포트로 붙으려다 실패한다.
- 첫 부팅 로그에 `"url":"http://127.0.0.1:<PORT>"` 와, Gateway 가 아직 없으면 `no OpenClaw gateway configured — add one in the connection page` 한 줄.
- 디바이스 아이덴티티·디바이스 토큰은 Gateway 마다 `data/gateways/<Gateway id>/` 에 생긴다(`device.json`, Gateway 가 디바이스 토큰을 내주면 `device-tokens.json`) — 환경 변수로 옮기지 않는다. dev Gateway 와 원격 Gateway 는 서로 다른 Gateway 행이라 페어링이 섞이지 않는다. 실연 DB 를 새로 만들면 Gateway 행도 새로 생기므로 그 Gateway 와 처음부터 다시 페어링한다.
- 스크래치 `DATA_DIR` 로 서버를 새로 띄울 때(사람의 `data/`·`.env` 를 건드리지 않을 때)는 소스 실행 `node --import tsx src/main.ts`(`apps/server`)에 **설정 키를 전부 환경으로** 준다 — 빈 값은 「설정 안 함」이고 루트 `.env` 가 덮지 못한다. 로컬 로그인 토큰·`BETTER_AUTH_SECRET` 은 스크래치에서 새로 만든 0600 파일에서 읽는다. 러너를 붙일 거면 기동 전에 `pnpm -F @dodok/claude-runner pack:runner`, 서버가 내려줄 플러그인을 쓸 거면 `pnpm -F @dodok/openclaw-plugin run pack:plugin`.

### (e) Gateway 추가·브리지 토큰·연결 확인

화면으로 해도 된다 — 연결 페이지(`http://localhost:5173/settings/connection`)의 「Gateway 추가」(주소 `ws://127.0.0.1:19001`, 토큰은 `data/dev-gateway.token` 의 값) → 그 Gateway 카드의 「새 토큰 발급」 → 설정 조각을 패치 파일로. 아래는 같은 일을 값을 화면에 찍지 않고 하는 꼴이다.

```bash
W() { (set -a; . data/live-smoke.env; set +a; export DODOK_LOCAL_TOKEN="$LOCAL_AUTH_TOKEN"; pnpm -s wire-cli http://127.0.0.1:$PORT "$@"); }
W login >/dev/null
T=$(jq -r '."http://127.0.0.1:'$PORT'"' data/wire-cli-session.json)   # 출력하지 않는다
GW=$(jq -n --rawfile t data/dev-gateway.token '{name: "dev", url: "ws://127.0.0.1:19001", token: ($t | rtrimstr("\n"))}' \
  | curl -s -H "authorization: Bearer $T" -H 'content-type: application/json' -d @- http://127.0.0.1:$PORT/api/v1/gateways \
  | jq -r .id)
# 목록에 이 Gateway 가 있는지 — 없으면(POST 가 실패해 GW=null 등) jq -e 가 0 이 아닌 값으로 끝나 경고가 찍힌다(tokenSet 은 늘 true 라 보지 않는다)
curl -s -H "authorization: Bearer $T" http://127.0.0.1:$PORT/api/v1/gateways \
  | jq -e --arg id "$GW" '.[] | select(.id == $id) | {id, name, url}' || echo "Gateway '$GW' 가 목록에 없다 — 위 POST 응답을 다시 본다"
( umask 077; curl -s -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"label":"live-smoke"}' \
    http://127.0.0.1:$PORT/api/v1/gateways/$GW/bridge-tokens | jq .pluginConfig > data/bridge-token.patch.json )
oc --dev config patch --file data/bridge-token.patch.json && rm data/bridge-token.patch.json   # 9.5 는 Gateway 재기동 없이 dodok 채널만 다시 띄운다(핫 리로드)
curl -s -H "authorization: Bearer $T" http://127.0.0.1:$PORT/api/v1/adapter/status
# {"statuses":[{"provider":"openclaw","gateways":[{"id":"…","name":"dev","enabled":true,"gateway":"connected","bridge":"connected"}]},{"provider":"runner","runners":{…}}],…}
```

- 루프백 + 공유 토큰이면 페어링이 자동 승인되고 `operator.admin` 까지 붙는다(ADR 0003 2절) — 「Gateway 추가」 직후 서버 로그 `"msg":"gateway connected"`(scopes 에 `operator.admin`, `gatewayId`, `gatewayVersion`·`gatewayBuildId` 가 `oc --version` 의 `<버전> (<빌드>)` 와 같은지).
- 발급 응답의 `pluginConfig` 가 계정 설정 조각(`channels.dodok.accounts.default` 의 `bridgeUrl`·`token`)이다 — 원문이 든 파일이라 패치한 뒤 곧바로 지운다. 브리지 토큰은 **그 Gateway 에 묶인다** — 다른 Gateway 의 계정에 넣으면 서버는 그 플러그인을 발급한 Gateway 의 것으로 안다.
- `wire-cli add-agent` 는 Gateway 가 하나면 `gatewayId` 를 빼도 된다(「`wire-cli`」 절 표).

`bridge` 가 60초 안에 `connected` 가 안 되면 `data/dev-gateway.log` 의 `[dodok] bridge:` 줄을 본다. 서버가 늦게 뜨면 플러그인 백오프가 벌어져 있어
첫 연결에 그만큼 걸린다(상한 10s, 지터 포함 ~12s). `UNAUTHORIZED` 면 계정 토큰이 그 Gateway 의 활성 토큰과 다르다. **브리지 토큰의 정본은 DB 고 Gateway 마다 따로다** — 실연 DB 를 새로 만들었으면 위처럼 새로 발급해 패치한다. 교체 절차는 이 문서 「브리지 토큰 교체 — 사람이 따라 할 절차」 절 · `docs/guides/docker-deploy.md` 「브리지 토큰 교체」.

주의: Gateway 를 띄우면 OpenClaw 내장 주간 cron `skill-collection-review:<agent>`(격리 세션, exec·write 툴)가 밀린 실행을 곧바로 돌 수 있다 — Gateway 기동 2분 뒤쯤 에이전트마다 주에 한 번 돌고(같은 주에 다시 띄우면 돌지 않는다), 우리 런과 별개의 모델 사용이라 실연 비용을 셀 때 뺀다.
예정은 `( env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$(cat data/dev-gateway.token)" PATH="$OCBIN:$PATH" openclaw --dev cron list --json --port 19001 )` 로 본다.

### (f) 정리

```bash
kill -INT <서버 node pid>          # lsof -nP -iTCP:$PORT -sTCP:LISTEN -t. close() 는 10s 상한, 플러그인이 system.notice shutdown 을 받는다
kill <tsx watch·pnpm 부모 pid>     # tsx watch 는 자식이 끝나도 남는다
kill <Gateway pid>                  # lsof -nP -iTCP:19001 -sTCP:LISTEN -t
# 실연 DB(data/live-smoke.sqlite*)를 지우면 data/gateways/ 아래 그 Gateway 의 디렉터리도 지운다 — 연결 페이지에서 Gateway 를 지우면 서버가 지운다
oc --dev config unset channels.dodok.channels
oc --dev plugins inspect dodok --json | jq .plugin.status     # 여전히 "loaded"
```

- 「(b) 플러그인 최신 번들 재설치」가 만든 `packages/openclaw-plugin/dist` 는 실연 뒤 지운다 — 남아 있으면 `apps/server/test/control.mcp.test.ts` 「/mcp 의 실패 카운터는 따로다」가 `plugin.tgz` 를 404 대신 200 으로 받아 `pnpm test` 가 깨진다.

⚠ 「승인(Phase 2 ①)을 실물에서 보기 — 절차」 절로 승인 정책(`agents.entries.<id>.tools.exec.ask`)을 켰다면 **여기서 되돌린다** — 그 절 「되돌리기 — 반드시 한다」.

## 4. `wire-cli`

`pnpm wire-cli <origin> [localToken] <명령> …` — `scripts/wire-cli.ts`. `localToken` 을 빼면 env `DODOK_LOCAL_TOKEN`.
로그인은 레이트리밋(5회/분)이 있어 세션 토큰을 `data/wire-cli-session.json`(0600)에 오리진별로 캐시하고 `GET /auth/me` 가 401 이면 다시 로그인한다. 토큰류는 출력하지 않는다.
실패는 `{ code, message }` 를 stderr 에 찍고 exit 1.

| 명령 | 하는 일 |
| --- | --- |
| `login` | 새로 로그인(캐시 갱신) → `GET /auth/me` 출력 |
| `channels` | `GET /channels` |
| `create-channel <name>` | `POST /channels` |
| `add-agent <channelId> <providerAgentId> <handle> [gatewayId]` | `GET /agents` 에 그 Gateway 의 그 `providerAgentId` 가 없으면 `POST /agents { providerAgentId, handle, name: handle, gatewayId }`, 있으면 재사용 → `POST /channels/:id/members { memberType: "agent", memberId }`. `gatewayId` 를 빼면 `GET /gateways` 가 하나일 때 그것(둘 이상이면 USAGE 오류) |
| `patch-channel <channelId> <json>` | `PATCH /channels/:id` (예: `'{"relayPolicy":{"maxRelayTurns":2,"allowPairs":"all"},"prompt":"…"}'`) |
| `send <channelId> <text> [--conversation <id> \| --new-session] [--watch-ms 60000]` | wire 접속 → `channel.subscribe` → `message.send`(`--conversation` 이면 그 세션, `--new-session` 이면 `newConversation`, 둘 다 없으면 `GET /channels/:id/conversations?status=open` 의 첫 세션, 열린 세션이 없으면 새 세션) → 서버 이벤트를 `[+ms] <event> <요약>` 으로 `--watch-ms` 동안. ack 줄의 `conversation=` 이 보낸 세션이다 |
| `interact <channelId> <messageId> <itemId> [--conversation <id>] [--watch-ms 60000]` | 그 세션(없으면 최근 열린 세션)의 최근 200개(`GET /conversations/:id/messages`)에서 메시지를 찾아 `component.interact { messageId, componentId: components.id, itemId, values: {} }` → ack → 이벤트 |
| `watch <channelId> [--watch-ms 60000]` | 구독만 하고 이벤트(재접속 때 `adapter.status` 관찰용) |
| `runs <channelId>` | `GET /channels/:id/runs` 를 한 줄씩(상태·트리거·depth·providerRunId·error·usage·시각) |

- **`wire-cli` 의 스레드는 보내기만이다.** `send … --thread <rootId>` 는 그 루트의 스레드 답글로 보낸다(세션은 루트의 세션이어야 한다 — 최근 열린 세션이 아니면 `--conversation` 으로 준다). `interact` 는 세션 최상위 200개에서만 메시지를 찾아 스레드 안 카드를 못 누른다. 스레드 안 카드를 누르려면 `scripts/wire-cli.ts` 를 `data/`(ignored)에 복사해 고쳐 쓰거나(`interact` 가 `/channels/:id/threads/:rootId/messages` 에서 찾게), 「재는 것별 메모」의 사람 쪽 드라이버를 쓴다 — 고친 사본은 커밋하지 않고 끝나면 지운다.
- `--conversation <id>` 를 셸 함수에서 한 인자로 묶어 넘기면(`"--conversation $CV"`) 무시되고 「열린 첫 세션」으로 간다 — 두 인자로 넘긴다. 보낸 세션은 ack 줄의 `conversation=` 으로 확인한다.
- `W send` 두 개를 같이 띄우면 두 연결이 같은 채널을 구독해 **양쪽 시간표에 두 런이 다 찍힌다** — 판정은 `runs` 의 `startedAt`·`endedAt` 으로 한다.
시간표 형식: 첫 줄 `# t0 <ISO> (epoch <ms>)` — 서버 pino `time`(epoch ms)·Gateway 로그 시각과 맞춰 볼 때 쓴다. `TEXT_MESSAGE_CONTENT` 는 런별 첫 델타만 바로 찍고,
나머지는 그 런의 다른 이벤트가 오거나 watch 가 끝날 때 `TEXT_MESSAGE_CONTENT×N (첫 델타 +ms) "…"`(100자) 한 줄로 뭉친다. 그 밖의 서버 이벤트(`approval.requested` 등)는 JSON 앞 300자.

## 5. 원격 Gateway 에서 같은 절차를 돌릴 때 다른 점

- 플러그인은 **사용자가 Gateway 호스트에 설치**한다(ADR 0002 9.2~9.5: `pack:plugin` → tarball 복사 → `openclaw plugins install … --force --accept-capabilities` → 계정 설정은 패치 파일). 워커는 원격 호스트를 만지지 않는다.
- 서버: 연결 페이지 「Gateway 추가」로 원격 주소(`wss://…`)·공유 토큰을 넣는다. 디바이스 디렉터리는 그 Gateway 행의 것(`data/gateways/<Gateway id>/`)이라 dev Gateway 와 따로다.
  원격 공유 토큰은 `operator.admin` 을 부여한다(계획서 10장 #15 — 스코프 승급 자동 승인).
- 브리지: 플러그인이 **아웃바운드로** 서버에 붙는다. 개발 PC 서버면 터널(cloudflared 등)로 `wss://…/bridge` 를 만들고, 그 주소를 `BRIDGE_PUBLIC_URL` 에 적고 호스트의 계정 `bridgeUrl` 에 넣는다. 토큰은 연결 페이지의 그 원격 Gateway 카드에서 발급한 것 — 브리지 토큰의 정본은 DB 고 Gateway 마다 따로다(이 문서 「브리지 토큰 교체 — 사람이 따라 할 절차」 절 · `docs/guides/docker-deploy.md` 「브리지 토큰 교체」).
- 원격은 루프백이 아니므로 페어링 자동 승인·지연 수치가 다를 수 있다. 지연(사람 메시지 → 플러그인 ack → 첫 델타 → 정본)을 다시 재고 결과는 `docs/superpowers/reports/` 의 리포트로 남긴다.
- **[사람] 원격 Gateway 버전을 먼저 확인한다.** 서버를 원격에 붙이면 접속 한 번에 로그 두 줄이 알려 준다 — `"gateway connected"` 의 `gatewayVersion`·`gatewayBuildId`(hello-ok `server.version`·`server.buildId`)와 `"bridge plugin hello"` 의 `gatewayVersion`(원격 호스트의 플러그인이 보낸 `runtime.version`).
  원격이 `2026.9.5` 이상이면 **ADR 0004 이전 번들은 배포에서도 에이전트가 카드를 못 보낸다**(결함 1) — 호스트의 플러그인을 새 번들로 바꾸고, 그 버전에서 「런 0회 하네스 — 모델 없이 모델 런의 툴 경로를 두드리기」 절을 한 번 돌린다. `pluginBuiltWithSdk` 는 Gateway 버전이 아니다(「전제」 절).
- dev 프로필 전용 주의(내장 cron·`~/.openclaw-dev` 잔여물)는 원격 호스트의 설정·예정 작업으로 바뀐다 — 호스트에서 `openclaw cron list` 로 본다.
- **[사람] 첨부(Phase 2 ③) — 호스트 설정 둘을 정한다**(스펙 `docs/superpowers/specs/2026-09-23-attachments-design.md` 5.3, 스파이크 보고서 Q1·2-3).
  ① **`attachments.ttlHours`** — 설정하지 않으면 플러그인이 저장한 사람 이미지 원본(`media/inbound/`)이 호스트에 **영구히** 남는다. Gateway 의 시간당 미디어 정비는 이 값이 있을 때만 지운다. 너무 짧으면 이력 재생에서 이미지가 빠진다(전사가 그 경로를 기억한다). 이미지는 호스트에 최소 세 부가 생긴다 — 원본, claude CLI 복사본(`<ws>/.openclaw-cli-images/`, 7일 스윕), 스테이징(`<ws>/media/inbound/openclaw-staged-*`, 정리 코드를 못 찾음).
  ② **`tools.fs.workspaceOnly`** — `false`(기본)면 모델이 **호스트에서 읽을 수 있는 아무 파일이나** `message` 툴 `media` 로 채널에 보낼 수 있다(플러그인은 `loadWebMediaRaw` 에 Gateway 의 `mediaAccess` 를 그대로 넘긴다). `true` 면 워크스페이스·미디어 캐시·임시 루트로 좁혀진다. 원격 호스트에서 어느 쪽인지 확인하고 적는다.
  계정 설정 `mediaMaxMb`(선택, 1~20, 기본 20)는 에이전트가 보내는 파일 한 개의 상한이다 — 서버 상한 20 MiB 를 넘을 수 없다.
- 첨부 바이트는 브리지 WS 가 아니라 **같은 오리진의 HTTP** 로 오간다 — 플러그인이 `bridgeUrl` 의 `wss:`→`https:`(`ws:`→`http:`)로 바꿔 `GET`·`POST /bridge/attachments` 를 부른다(브리지 토큰). 터널·리버스 프록시가 `/bridge` WS 만 통과시키면 첨부만 실패한다. 요청 본문 상한은 20 MiB 보다 크게 둔다. 서버 쪽 블롭은 `ATTACHMENTS_DIR`(기본 `<DATA_DIR>/attachments`)에 쌓인다.

---

## 6. 웹을 얹을 때

「절차」 절 (a)~(e)를 그대로 하고 아래를 더한다. 승인 카드·활동 탭·첨부처럼 화면으로만 보이는 것을 볼 때 필요하다.

### 준비 — 「절차」 절에 더할 것

- `data/live-smoke.env` 의 `APP_ORIGIN` 은 웹 dev 서버 주소와 **글자까지 같아야 한다**(`http://localhost:5173`). wire 는 핸드셰이크 `Origin` 이 `APP_ORIGIN` 과 같을 때만 세션 쿠키를 받는다(웹 스펙 9.1).
- 웹을 띄운다. 서버 포트가 3000 이 아니므로 프록시 대상을 준다.

```bash
DODOK_API_ORIGIN=http://127.0.0.1:$PORT pnpm -F @dodok/web dev      # 5173, strictPort
```

- 브라우저는 **`http://localhost:5173`** 으로 연다. 웹을 `--host 127.0.0.1` 로 띄운 뒤 `127.0.0.1:5173` 으로 열면 `Origin` 이 달라 wire 가 `UNAUTHORIZED` 를 주고, 앱은 REST 세션이 살아 있는 것을 보고
  재연결을 멈춘 뒤 「실시간 연결이 거부되었습니다 — 이 주소(http://127.0.0.1:5173)가 서버의 APP_ORIGIN 과 다릅니다」 배너를 띄운다(설계대로다 — 헷갈리지 말 것).
  Vite 기본값(`localhost`)은 macOS 에서 `::1` 에만 열려 `127.0.0.1:5173` 은 그 전에 연결 거부(`ERR_CONNECTION_REFUSED`)다 — 배너를 일부러 보려면 웹을 `--host 127.0.0.1` 로 띄운다.
- 포트를 바꿔 띄울 때(5173 을 다른 프로젝트가 쓰고 있을 때 — `strictPort` 라 겹치면 안 뜬다)는 `APP_ORIGIN`·브라우저 주소·`--port` 셋을 같이 바꾼다: `DODOK_API_ORIGIN=http://127.0.0.1:$PORT pnpm -F @dodok/web dev --port 5180` — pnpm 11 은 스크립트 뒤 인자를 그대로 `vite` 에 넘긴다.
- **로그인 토큰을 화면·전사에 남기지 않고 넣는 법.** 토큰은 `data/live-smoke.env` 의 `LOCAL_AUTH_TOKEN`(실연 전용으로 새로 뽑은 값 — `.env` 의 것이 아니다)이다.
  Vite dev 서버는 워크스페이스 안 파일을 `/@fs<절대경로>` 로 **같은 출처**에 서빙하므로, 페이지 안에서

  ```js
  const env = await (await fetch('/@fs' + REPO + '/data/live-smoke.env')).text();
  const tok = env.match(/^LOCAL_AUTH_TOKEN=(.+)$/m)[1].trim();   // 입력칸에 넣고 제출
  ```

  하면 값이 셸 출력·도구 전사 어디에도 남지 않는다. Vite 기본 `server.fs.deny` 는 `.env`·`.env.*` 라 `live-smoke.env` 는 걸리지 않는다.
  **토큰을 다른 파일로 복사하지 않는다**(`data/` 밖으로 나가고, 에이전트 도구가 「자격 증명 복제」로 막기도 한다). Vite 를 내리면 이 경로도 닫힌다.
  입력칸은 제어 컴포넌트라 `value` 를 그냥 넣으면 React 가 되돌린다 — `HTMLInputElement.prototype` 의 네이티브 setter 로 넣고 `input` 이벤트를 쏜다.
- **프레임 원본은 늘 남긴다.** `data/live-smoke.env` 에 `OPENCLAW_FRAME_DUMP_PATH=data/frames-<날짜>.jsonl` 을 더한다(파일은 Gateway 연결마다 `<경로>.<연결 id>` — `.env` 의 Gateway 는 `data/frames-<날짜>.jsonl.env`). usage 출처는 이 덤프로 가른다 — `docs/adr/0005-usage-values.md`.
- 「절차」 절 (a) 가 `Config path not found: channels.dodok.channels. Nothing was changed.` 를 찍으면 **이미 깨끗하다는 뜻**이다(정상 — 오류가 아니다).
- 에이전트는 웹에서 등록한다: `/settings/agents` → 「에이전트 가져오기」 → `dev`·`fin`. dev 의 표시 이름은 `C3-PO` 이고 **핸들 칸은 `dev` 로 채워진다**(멘션은 `@dev`).
- **스크린샷·콘솔·WS 프레임.** BrowserOS neo 는 스크린샷을 파일로 주지 않고 `console.log`·네트워크·WS 프레임을 못 본다(browser-verification.md).
  저장소 `.mcp.json` 의 `playwright-neo` 가 세션에 붙지 않았으면, neo 의 CDP(`~/Library/Application Support/BrowserClaw/.browseros/config.json` 의 `ports.cdp`, 기본 9110)에
  **Node 24 내장 `WebSocket`** 으로 직접 붙어 `Page.captureScreenshot`·`Runtime.enable`·`Network.enable` 로 대신한다 — 의존성이 필요 없다.

### 화면에서 잴 때 걸리는 곳

- ⚠ **검증 탭은 앞으로 꺼낸다.** 배경 탭은 타이머를 ~1s 로 조인다 — 페이지에 심은 `setInterval` 표본기가 짧은 답의 스트리밍 창(런당 1초 안팎)을 통째로 놓친다.
  **폴링은 페이지 타이머가 아니라 브라우저 바깥**(neo `run` 런타임·CDP)에서 돌리고,
  사람이 누르는 것을 흉내 내는 확인은 탭을 앞으로 꺼낸 뒤 한다(CDP `Page.bringToFront`). 델타 렌더 자체는 배경 탭에서도 정상이다 — WS 수신은 조이지 않는다.
- ⚠ **스트리밍 창(첫 델타 → 마지막 델타)은 답 길이에 정비례한다.** claude-cli 의 델타 간격은 답 길이와 무관하게 ~80ms 로 일정하고 개수만 길이를 따라간다 — 짧은 답에는 사람도 중지를 누를 틈이 거의 없고 자동 검증은 창을 통째로 놓친다. **중지를 볼 때는 길게 답하라고 시켜 창을 넓히고**(「다섯 문장으로 길게」), 게이트는 단순하게 둔다 — **「중지 버튼이 보이면 1.5초 뒤 누른다」** 면 충분하다(버블 길이를 재는 선택자로 게이트를 걸면 빈 값으로 한 번도 안 열린다). 탭 앞으로·바깥 폴링을 함께 쓴다.
- **모달의 date 칸**: 자동화 도구의 키 입력(`type`·`press`)으로는 세그먼트가 채워지지 않는다(값 `""`). 네이티브 setter 로 넣고 `input`·`change` 를 쏜다(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(d,'2026-09-30')` → `validity.badInput=false`). 사람이 칠 때의 롤오버는 사람 몫이다.
- **작성기에 파일을 넣는 법.** 작성기의 `<input type=file>` 은 `class="hidden"` 이라 BrowserOS neo 스냅샷에 ref 가 없고 `upload` 가 못 잡는다. 이미지를 워크트리 `data/`(ignored) 아래에 복사하고, 페이지 안에서 `fetch('/@fs<워크트리>/data/<폴더>/<파일>')` → `new File([blob], 이름, {type})` → `DataTransfer` 로 `input.files` 를 채운 뒤 `change` 를 쏜다. 칩이 뜨고 「보내기」가 켜진다(파일 선택기와 같은 코드 경로). 멘션은 입력칸에 `@dev` 를 쳐서 뜬 후보를 누른다. `wire-cli` 는 첨부를 보내지 못한다.
- **캐시가 식으면 런 값이 비싸진다.** 같은 채널이라도 Gateway 를 재기동하면 claude-cli 캐시가 날아가 다음 런이 `cache_creation` 을 다시 쓴다(몇 배가 된다). 실연을 쪼개 돌릴수록 비싸진다 — **한 번 띄웠을 때 볼 것을 다 본다.**
- 실제 모델 런의 claude-cli 는 사람의 `~/.claude` 설정을 싣는다(argv `--setting-sources user`) — 그 설정의 훅(SessionStart 등)이 턴마다 돌고 첫 턴 캐시 생성이 커진다. 실연 비용·로그를 읽을 때 감안한다.
- 모델 런 상한이 있는 실연은 **에이전트 답 속 멘션이 런을 더 만들지 않게** 런 앞에서 릴레이 턴 상한을 0 으로 두고(`patch-channel <CH> '{"relayPolicy":{"maxRelayTurns":0,"allowPairs":"all"}}'`), 릴레이를 볼 런 앞에서만 올린다. 상한을 바꾸면 채널 프롬프트 리비전이 오르고 다음 인바운드에 `ChannelPromptContext` 가 실린다(설계대로). 설정 저장·에이전트 등록·채널 만들기는 런을 쓰지 않는다.

### 릴레이·자동 응답을 볼 때

⚠ **사람 메시지에 `@fin` 을 쓰면 릴레이가 아니다.** 라우터는 사람 메시지의 멘션을 전부 depth 0 런으로 만든다(`router/decide.ts`) — `@dev @fin …` 은 릴레이 체인이 아니라
**병렬 런 2개**가 되고, 각자의 답이 또 릴레이를 켜서 상한을 넘긴다. 릴레이를 보려면 **`fin` 앞의 `@` 를 뺀다**: `@dev fin 에게 …`.

⚠ **`자동 응답`은 멘션이 하나도 없는 사람 메시지에만 걸린다**(같은 파일). `@…` 로 시작하는 우리 문장들은 자동 응답 런을 만들지 않으므로 켜 두어도 예산에 영향이 없다.


- `relay_limit` 카드의 「이어가기」는 components 액션 로우라 **30분(`ttlMs`) 안에 눌러야 한다** — 그 뒤에는 스스로 비활성이 된다(릴레이 정책과는 무관하다). 누르면 런이 하나 더 돈다.

### 정리

「절차」 절 (f)에 웹 것을 더한다: Vite(5173) 종료, 열었던 탭·브라우저 정리, `data/` 의 실연 파일(`live-smoke.env`·`*.sqlite`·로그·프레임 덤프·`cdp-*.jsonl`)은 `data/` 안에 두거나 지운다 — 커밋하지 않는다.
⚠ 포트로 죽일 때는 `lsof -nP -iTCP:<포트> -sTCP:LISTEN -t` 로 **LISTEN 만** 고른다(그냥 `lsof -ti:3000` 은 그 포트에 붙은 Vite 까지 죽인다).
**DB(`live-smoke.sqlite`)와 `live-smoke.env` 를 그대로 두면 채널·에이전트·대화·로그인이 살아 있어** Gateway·서버·Vite 를 다시 띄울 때 준비 단계를 건너뛸 수 있다. 대신 claude-cli 캐시가 식어 다음 런이 비싸진다(위 「화면에서 잴 때 걸리는 곳」).

---

## 7. 승인(Phase 2 ①)을 실물에서 보기 — 절차

실물 dev Gateway 는 기본값에서 **승인을 한 번도 일으키지 않는다.** 샌드박스가 아닌 런타임 기본이 `security: "full"`·`ask: "off"` 이라
claude-cli 의 네이티브 툴이 **전부 자동 허용**되기 때문이다(승인 스파이크 2.1 — ADR 0001 6.5 가 승인 0회였던 이유도 이것이다).
승인 카드를 보려면 에이전트의 exec 정책을 「물어보기」로 **일시적으로** 바꾸고, 끝나면 반드시 되돌린다.

**웹이 떠 있어야 「승인을 일으키는 프롬프트」의 「볼 것」이 보인다** — 카드도 활동 탭도 웹 화면이다. 「절차」 절 (a)~(e) 에 더해 **「웹을 얹을 때」 절**을 그대로 밟는다(`APP_ORIGIN` 과 글자까지 같은 주소·`DODOK_API_ORIGIN` 프록시·브라우저는 `http://localhost:5173`·에이전트 등록). 그 뒤 「켜기」로 간다.
**모델 런 없이** 승인을 일으키려면 「켜기」로 정책을 켠 뒤 가짜 CLI 가 `can_use_tool` 제어 요청을 내게 한다(「런 0회 하네스 — 모델 없이 모델 런의 툴 경로를 두드리기」 절 「모델 없이 승인 일으키기」) — 카드 대신 wire 이벤트로 본다.

### 켜기

「절차」 절 (c) 로 dev Gateway 를 띄운 **뒤에** 한 줄이면 된다. Gateway 재시작은 필요 없다(`Change will apply without restarting the gateway.`).

```bash
oc --dev config get  agents.entries.dev.tools.exec.ask     # 되돌릴 값을 먼저 적어 둔다(없으면 「없음」)
oc --dev config set  agents.entries.dev.tools.exec.ask always
```

- `oc` 는 「절차」 절의 약속(스크래치 설치본 + `--dev`)이다. **「시크릿 규칙」 그대로**: 이 키는 URL·토큰이 아니라 정책 값 하나라 `config get` 으로 읽어도 토큰이 딸려 나오지 않는다.
  `config get agents.entries.dev` 처럼 **묶음을 통째로 읽지 않는다**(토큰이 섞여 나온다). `~/.openclaw-dev/openclaw.json` 은 열지 않는다.
- 판정은 `resolveCliNativeToolApprovalPlan` 한 줄이다 — `security==="deny"` → deny, `ask==="off"` → (`full` 이면 allow, 아니면 deny), 그 밖 → **prompt**.
- 층은 셋이고 `security = min(설정, 파일)` · `ask = max(설정, 파일)` 로 합쳐진다. exec 승인 파일 층(`exec.approvals.get/set`)은 **건드리지 않는다** — 설정 층의 `always` 가 `max` 로 그대로 이긴다(스파이크 2.1 에서 실측).
- ⚠ `ask: "always"` 는 **`Read` 까지 포함해 모든 네이티브 툴**에 프롬프트를 건다. 한 턴에 승인이 여러 건 뜰 수 있다(스파이크에서 `Write`·`Read` 2건).
- 우리 정본 응답 경로(`mcp__openclaw__*` 의 `message` 툴)는 `PreToolUse` 를 그대로 지나므로 **승인이 걸리지 않는다** — 정책을 켜도 답은 평소대로 온다.
- `ask: "always"` 면 `allowedDecisions` 에서 **`allow-always` 가 빠진다**(`["allow-once","deny"]`). 카드에 「항상 허용」 버튼이 없는 것이 정상이다.

### 승인을 일으키는 프롬프트

스파이크에서 실제로 `Write` 1건 + `Read` 1건을 일으킨 문장이다(한 런에 2건 — 승인 카드가 둘일 때의 동작까지 볼 수 있다).

```
@dev 확인용 작업이야. 워크스페이스에 spike-approval.txt 파일을 만들고 hello 한 줄만 써.
그 다음 그 파일을 Read 도구로 읽어서 내용을 그대로 알려줘. 그 두 가지 말고는 다른 도구를 쓰지 마.
```

볼 것: 카드가 **두 자리**(메시지 흐름·활동 탭 맨 위)에 같이 뜨는가 · 카운트다운 · 「이번만 허용」 뒤 런이 이어지는가 · 「거절」 뒤 툴 오류로 이어지는가 ·
활동 탭 타임라인의 승인 행이 「허용됨」·「거절됨」으로 남는가. 만료까지 보려면 아무것도 누르지 않고 TTL(실물 기본 120초)을 넘긴다 — 모델 런 1회가 더 든다.

`dev:fake` 와 다른 점 둘:
- **미해결 승인의 재접속 복구**(세션 구독의 `approvalReplay`)는 실물에서만 끝까지 볼 수 있다. `dev:fake` 는 재기동하면 가짜 Gateway 도 상태를 잃어 런이 실패·승인이 「취소됨」이 된다.
- 실물 TTL 은 120초라 `dev:fake` 의 20초보다 기다림이 길다.

### 되돌리기 — 반드시 한다

```bash
oc --dev config unset agents.entries.dev.tools.exec.ask        # 「켜기」 전에 값이 없었을 때
# 값이 있었으면: oc --dev config set agents.entries.dev.tools.exec.ask <적어 둔 값>
oc --dev config get   agents.entries.dev.tools.exec.ask        # 되돌아갔는지 확인
oc --dev config get   agents.entries.dev.tools                 # 「켜기」 전에 없던 키면 { "exec": {} } 빈 껍데기가 남는다
oc --dev config unset agents.entries.dev.tools                 # 빈 껍데기일 때만 — 다른 키가 보이면 두고 exec 만 본다
```

`set` → `unset` 은 `exec.ask` 만 지우고 그 위의 빈 객체(`tools.exec`)를 남긴다 — 설정 파일 크기가 시작값과 달라진다. 되돌린 뒤 `~/.openclaw-dev/openclaw.json` 의 **크기**(`stat -f %z`, 내용은 열지 않는다)가 「켜기」 전과 같은지 본다.
「절차」 절 (f) 정리에 이 줄들을 더한다. 되돌리지 않으면 **다음 실연이 모든 툴에서 멈춰** 서 있게 된다 — 승인을 누르는 사람이 없으면 런이 120초마다 만료로 끝난다.
`--dev` 프로필만 건드리므로 원격 프로필(`~/.openclaw`)에는 영향이 없다. `Config path not found … Nothing was changed.` 가 나오면 이미 깨끗하다는 뜻이다(정상).

---

## 8. 사람이 눈·귀로 확인할 것 (자동 검증이 원리상 못 재는 것)

아래는 브라우저 자동화·jsdom 이 **측정할 수 없는** 것들이다 — 도구를 바꿔서 될 일이 아니라 사람의 눈·귀가 필요한 자리다. 코드가 하는 일까지는 자동화로 잴 수 있다 — 「흉내 내는 법」에 적어 두었다(같은 방법을 그대로 쓰면 준비가 빨라진다).
`dev:fake` 로도 되고 실물로도 된다 — 「승인(Phase 2 ①)을 실물에서 보기 — 절차」로 승인을 한 번 일으킨 김에 같이 본다. 브라우저는 `http://localhost:5173` 고정(알림 권한은 **출처별**이라 주소가 다르면 다시 묻는다).

알림을 켜는 자리는 「설정」 → 「알림」 탭(`/settings/notifications`)이고, **이 기기에 푸시가 켜져 있으면 탭 안 승인 알림은 쉰다** — 빌드본 preview(「푸시 확인 절차 (`dev:fake`, 모델 런 0회)」)에서 이 절을 볼 때는 「사람이 볼 것 (자동화가 원리상 못 잰 것)」 끝의 순서(권한 허용 → 푸시 「끄기」)를 먼저 한다. 아래 고정 주소 5173(dev 서버, 서비스 워커 없음)에서는 「푸시 알림 켜기」가 권한만 받고 10초 뒤 「서비스 워커가 준비되지 않았습니다」로 끝나 「끄기」 버튼이 생기지 않는다 — 플래그가 없으므로 그대로 탭 안 알림이 돈다. 아래 「알림 켜기」는 그 탭의 「푸시 알림 켜기」(권한을 묻는 자리)로 읽는다.
⚠ **순서가 있다**: `granted` 를 **먼저** 본다. 권한을 한 번 `denied` 로 만들면 「알림 켜기」 토글이 영영 사라지고(설계대로), 같은 출처에서 다시 묻지 못한다.
되돌리려면 브라우저 사이트 설정에서 손으로 초기화해야 한다.

### 사람이 볼 것 — 여섯

| # | 볼 것 | 어떻게 | 통과 기준 |
| --- | --- | --- | --- |
| 1 | **권한 팝업 모양** | 「설정」 → 「알림」 탭의 「알림 켜기」를 누른다(그 전에는 한 번도 안 떠야 한다) | 버튼을 누른 **뒤에만** 팝업이 뜬다. 로그인·홈·채널·설정의 다른 탭에서는 0회 |
| 2 | **실제 알림 소리** | 권한 `granted` → 탭을 **진짜로** 숨긴다(다른 앱으로 전환·창 최소화) → 승인을 일으킨다 | 알림 1건과 함께 OS 알림음이 들린다 |
| 3 | **알림을 누르면 탭이 앞으로 오는가** | 위 알림을 클릭 | 브라우저 창이 앞으로 오고, 그 채널의 **활동 탭**(`/c/<id>/activity`)이 열린다. Phase 2 ④ 웹푸시가 그대로 이어받는 동작이라 한 번은 꼭 본다 |
| 4 | **잠금 화면 표시** | 알림이 뜬 상태에서 화면을 잠근다 | 잠금 화면에 배너가 보이는가(보인다면 제목·본문에 툴 인자가 새지 않는지 — 문구는 「승인 필요 — @dev 가 Write 를 실행하려 합니다」 / 「general 채널」뿐이어야 한다) |
| 5 | **VoiceOver 가 확정·만료 안내를 읽는가** | VoiceOver(⌘F5) 를 켜고 「이번만 허용」을 누른다 | 「선택: 이번만 허용」 줄이 읽힌다. 만료도 같다(「시간이 지나 답할 수 없습니다.」) |
| 6 | **같은 문구가 두 번 읽히는가** | 위를 **활동 탭이 열린 상태**에서 다시 한다 | 같은 승인의 카드가 흐름·패널 **둘**이라 같은 `aria-live` 문구가 같은 밀리초에 둘 삽입된다. 두 번 읽히면 한쪽을 `aria-hidden` 으로 죽일지 판단한다(현재는 둘 다 `polite`) |

DOM 사실은 이미 확인돼 있다: 확정·만료 안내는 **텍스트를 담은 채 새로 삽입되는** `<p aria-live="polite">` 다(기존 영역의 텍스트 변경이 아니라 조건부 렌더). 카운트다운 span 에는 `aria-live` 를 붙이지 않았다.
활동 탭이 열려 있으면 **같은 문구의 live 영역 둘(흐름·패널)이 같은 프레임에 삽입되는 것**까지 실측됐다. 남은 물음은 「그래서 **두 번 읽히는가**」 하나다.
5 와 6 의 기대: 결정 뒤 초점은 **`aria-live` 줄이 아니라 결과 줄(「허용됨」)** 로 간다 — 「허용됨」 한 마디 + 「선택: 이번만 허용」 한 마디로 **서로 다른 두 마디가 한 번씩**이다.

곁들여 남은 것: **작성기 한글 IME**(조합 중 Enter 가 전송하지 않는지) 도 사람만 볼 수 있다 — CDP·자동화는 실제 IME 조합 이벤트를 만들지 못한다. 두벌식으로 「안녕」을 치다가 조합 중 Enter 를 눌러 확정만 되는지 같은 자리에서 한 번 본다.

### 흉내 내는 법 — 자동화로 잴 수 있는 것

위 여섯을 빼면 알림 경로의 코드가 하는 일(다른 채널을 볼 때 승인 1건 → `Notification` 1건·`tag` `approval:<id>`·툴 인자 없음, `onclick` 이 `window.focus()` 와 활동 탭 이동, 같은 채널을 볼 때 보임 0·숨김 1, 권한 팝업이 버튼 전에 0회)은 아래 방법으로 잰다. 잰 값은 `docs/superpowers/reports/2026-09-21-approval-notifications-live-smoke-report.md`.
둘 다 CDP — 저장소 pnpm 스토어의 `playwright-core` 를 BrowserOS neo 의 CDP 포트(neo 설정의 `ports.cdp`)에 얹어 쓴다. 새 브라우저를 띄우거나 의존성을 더하지 않는다.
- **알림 권한**: 「알림 켜기」를 눌러 요청이 **1회 나가는 것**을 먼저 보이고(팝업은 배경 탭이라 큐에 걸려 `default` 로 남는다), 그 뒤 `Browser.grantPermissions` 로 `localhost:5173` 에 `notifications` 를 부여한다.
  `denied` 판은 `Browser.setPermission` 으로 만들고, 끝나면 **`Browser.resetPermissions` 로 `default` 로 되돌린다** — 프로필을 갈아 끼울 필요가 없다. 위의 ⚠ 순서 경고(`granted` 를 먼저)는 **사람이 손으로 팝업에 답할 때** 그대로 유효하다.
- **탭 숨김**: `document.visibilityState` 를 `hidden` 으로 덮어쓴다(neo 는 배경 탭도 `visible` 로 유지한다). **진짜 숨김이 아니다** — 그래서 위 표 2·3(소리·클릭으로 탭이 앞으로)은 사람이 **진짜로** 다른 앱으로 전환해 봐야 한다.
- 뷰포트 변경·wire 소켓만 끊기도 같은 CDP 경로로 한다. 소켓만 끊을 때는 `/socket.io/` 짜리만 막고 **REST 와 Vite HMR 소켓은 건드리지 않는다** — 브라우저를 통째로 offline 으로 만들면 재접속 때 목록을 알아서 다시 받아 재현이 안 되고, HMR 을 막으면 페이지가 새로 고쳐져 「재접속」이 아니라 「새 탭」이 된다.

### 첨부(Phase 2 ③) — 사람이 볼 것

자동화는 파일 선택을 숨은 `input` 에 파일을 넣는 것으로, 붙여넣기를 페이지 안에서 만든 `ClipboardEvent` 로 대신한다. 칩·사유 문구·「서식 없이 글만」 같은 **코드가 하는 일**은 그것으로 잰다.
**실제 OS 가 채우는 클립보드·드래그 데이터**는 자동화가 흉내 낼 수 없다 — 아래는 사람이 한 번 본다. `dev:fake` + 웹이면 된다(모델 런 0회, `AGENTS.md` 「명령」 절의 「웹 손 확인」).

| # | 볼 것 | 어떻게 | 통과 기준 |
| --- | --- | --- | --- |
| 1 | **웹 페이지 이미지 붙여넣기** | 다른 탭에서 이미지를 우클릭 → 「이미지 복사」 → 작성기에 붙여넣기 | 칩이 생기고 올라간다. 보내면 메시지에 이미지가 그려진다 |
| 2 | **오피스·문서에서 이미지와 글을 함께 붙여넣기** | Word·한글·구글 문서에서 이미지와 글이 섞인 구간을 복사 → 붙여넣기 | 이미지가 파일로 실리는 앱이면 칩이 생긴다. 글은 **서식 없이** 들어온다 — 굵게·표·깨진 HTML 이 본문에 보이지 않는다. 이미지를 파일로 싣지 않는 앱이면 글만 들어오는 것이 정상이다. 앱마다 어땠는지 적는다 |
| 3 | **PNG 끌어다 놓기** | Finder 에서 PNG 를 작성기(칩 줄·버튼 위 포함) 위로 끌어 놓는다 | 커서가 「복사」 모양이고 칩이 생긴다 |
| 4 | **SVG·PDF 끌어다 놓기** | SVG(또는 PDF)를 작성기 위로 | 칩 없이 토스트 「이미지만 올릴 수 있습니다」. 서버 요청 0건 |
| 5 | **작성기 밖에 놓기** | 이미지를 메시지 목록 위로 끌어 놓는다 | 커서가 「놓을 수 없음」, 토스트 「이미지는 입력 칸에 놓아 주세요」. 브라우저가 이미지를 열어 앱을 떠나지 않는다 |
| 6 | **OS 파일 선택창** | 「이미지 첨부」 → 파일 창 | PNG·JPEG·GIF·WebP 만 고를 수 있다(`accept`). SVG 는 흐리거나 안 보인다 |
| 7 | **Safari 에서 크게 보기를 닫은 뒤 초점** | Safari 에서 이미지를 **마우스로** 눌러 크게 보기 → Esc → Tab | 초점이 그 이미지 버튼 자리에서 이어진다(`body` 로 떨어져 문서 처음부터 다시 돌지 않는다). Chromium·jsdom 은 클릭한 버튼에 초점을 줘 이 차이를 못 잰다 |

---

## 9. 런 0회 하네스 — 모델 없이 모델 런의 툴 경로를 두드리기

**왜**: 가짜 Gateway 통합 테스트는 플러그인을 한 인스턴스로 불러, 「모델 런의 툴 호출이 어느 플러그인 인스턴스로 가는가」 같은 실물 경로를 원리상 못 본다(ADR 0004 4절).
여기 둘은 **실제 Gateway 의 루프백 `/mcp`** 를 두드리되 모델을 부르지 않는다(비용 0). OpenClaw 버전을 올렸을 때, 플러그인의 툴·아웃바운드를 고쳤을 때 한 번 돌린다.

| 하네스 | 붙는 곳 | 어느 인스턴스로 가나 | 쓸모 |
| --- | --- | --- | --- |
| `attach.grant` | 모델 런이 쓰는 바로 그 루프백 서버(세션 grant) | 세대 1(`startAccount` 를 돈 쪽) — run 문맥이 없다 | 툴 노출·`components` 스키마 확인. **결함 1 은 재현하지 않는다** |
| 가짜 claude CLI(정본) | 루프백 서버(run grant — 진짜 모델 런과 같다) | 세대 2(prepared-runtime) — 모델 런과 같다 | **결함 1·2 재현, 고친 뒤 합격 확인** |

러너 에이전트(OpenClaw 를 거치지 않는다)의 하네스는 이 절이 아니라 「Claude 러너 런 0회 하네스 — 번들 CLI + 가짜 Messages API」 절이다.

`openclaw --dev mcp serve` 는 **다른 경로**다(외부 MCP 클라이언트용 채널 브리지, 툴 9개에 `message`·`components` 없음) — 이 목적에 쓰지 않는다.

### 준비 (「절차」 절 (a)~(e) 그대로 + 하네스용 채널)

```bash
# OCBIN 은 「절차」 절 머리의 스크래치 설치본
oc() { env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_GATEWAY_TOKEN PATH="$OCBIN:$PATH" openclaw "$@"; }
oc --version                                   # 적는다
# 「절차」 절 (a) 채널 설정 지우기 · (b) pack:plugin + plugins install --force(설치본 sha = 빌드본 sha) · (c) Gateway · (d) data/live-smoke.env + 서버 · (e) adapter/status connected
W() { (set -a; . data/live-smoke.env; set +a; export DODOK_LOCAL_TOKEN="$LOCAL_AUTH_TOKEN"; pnpm -s wire-cli http://127.0.0.1:$PORT "$@"); }
W create-channel harness-$(date +%m%d%H%M); W channels | tail -n +2      # 첫 줄은 `HTTP 200 GET …` — 새 채널 id 를 CH 에
W add-agent $CH dev dev
W send $CH "하네스 준비" --new-session --watch-ms 3000     # 멘션 없는 글 — 런 없이 대화만 생긴다. ack 줄의 conversation= 을 CV 에
```

- **세션 키와 `message` 툴 대상은 채널 id 가 아니라 대화 id 다** — 세션 키 `agent:dev:dodok:channel:$CV`, 대상 `channel:$CV`. 채널 id 를 대상으로 주면 플러그인이 「이 대화에만 보낼 수 있습니다」로 거절한다(채널 id 는 대화가 아니다 — 세션 기능 전부터 있던 채널의 「이전 대화」만 id 가 채널 id 와 같다). 대화 id 는 `W send` ack 줄의 `conversation=` 이나 `GET /api/v1/channels/$CH/conversations` 로 본다. 준비 글에는 멘션을 넣지 않는다 — `@dev` 를 넣으면 가짜 CLI 를 붙이기 전의 Gateway 에서 진짜 모델 런이 된다(채널에 자동 응답을 켰어도 같다).
⚠ **하네스용 채널은 따로 만든다.** 가짜 CLI 런은 채널 세션에 **가짜 claude 세션 id**(`00000000-0000-4000-8000-00000000c214`)를 남긴다. 같은 채널에서 나중에 진짜 모델 런을 하면 `--resume` 이 그 id 를 찾다 실패할 수 있다.
`data/args.json` 은 `message` 툴 인자다 — `{"action":"send","target":"channel:<CV>","message":"…","components":{…}}`. 모델이 낸 인자는 서버 `run_events` 의 `TOOL_CALL_ARGS` 에 그대로 있다(카드 예시는 `docs/guides/agent-guide.md` 의 components 예시면 충분하다).
(선택) **어느 인스턴스에서 돌았는지** 보려면 `packages/openclaw-plugin/src/channel.ts` 모듈 최상위에 probe 를 붙여 재패킹·재설치한다 — **커밋 금지**, 끝나면 `git checkout -- src/channel.ts` → 재패킹 → 재설치 → sha 가 원래 값인지 확인.
Gateway 는 `NODE_OPTIONS=--stack-trace-limit=60` 로 띄운다(기본 10줄로는 누가 로드했는지 안 보인다).

```ts
const PROBE_INSTANCE = Math.random().toString(36).slice(2, 8);
const PROBE_G = globalThis as Record<string, unknown>;
PROBE_G["__dodokProbeRealm"] ??= Math.random().toString(36).slice(2, 8);
PROBE_G["__dodokProbeEvals"] = ((PROBE_G["__dodokProbeEvals"] as number | undefined) ?? 0) + 1;
function probe(event: string, extra: Record<string, unknown> = {}): void {
  console.info(`dodok:probe ${JSON.stringify({ event, instance: PROBE_INSTANCE, realm: PROBE_G["__dodokProbeRealm"],
    evals: PROBE_G["__dodokProbeEvals"], pid: process.pid, ...extra })}`);
}
probe("module-eval", { url: import.meta.url, stack: new Error().stack?.split("\n").slice(1, 60) });
// 부를 자리: startDodokAccount 의 registerBridge 뒤 probe("start-account"), handleAction·sendText 의 getBridge 뒤 probe("handle-action"|"send-text", { found: !!bridge })
```

### `attach.grant` — 툴 노출·스키마 확인용

```bash
umask 077
( env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$(cat data/dev-gateway.token)" PATH="$OCBIN:$PATH" \
    openclaw --dev gateway call attach.grant --port 19001 --json \
    --params "{\"sessionKey\":\"agent:dev:dodok:channel:$CV\",\"agentId\":\"dev\",\"ttlMs\":1800000}" ) > data/grant.json
jq '{sessionKey, expiresAtMs, url: .mcpConfig.mcpServers.openclaw.url}' data/grant.json          # token 은 출력하지 않는다
printf 'Authorization: Bearer %s\nContent-Type: application/json\nAccept: application/json, text/event-stream\n' \
  "$(jq -r .token data/grant.json)" > data/grant.headers                                          # curl -H @파일 — ps 에 안 남는다
URL=$(jq -r .mcpConfig.mcpServers.openclaw.url data/grant.json)
curl -s -H @data/grant.headers -X POST $URL -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
curl -s -H @data/grant.headers -X POST $URL -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | jq '.result.tools[] | select(.name=="message") | .inputSchema.properties.components | keys'
BODY=$(jq -cn --argjson a "$(cat data/args.json)" '{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"message",arguments:$a}}')
curl -s -H @data/grant.headers -X POST $URL -d "$BODY"      # 세대 1 → 성공(카드 도착). 결함 1 의 합격 판정에는 쓰지 않는다
rm data/grant.json data/grant.headers                     # grant 는 TTL 뒤 또는 Gateway 를 내리면 사라진다
```

확인할 것: `tools/list` 에 `message`·`ask_user` 가 있고, `components` 키가 `blocks·id·modal·reusable·text·ttlMs` 다.
⚠ `attach.revoke` 는 토큰을 `--params` 인자로 넘겨 ps 에 잠깐 남는다 — revoke 대신 Gateway 를 내려 없앤다.

### 가짜 claude CLI — 결함 1·2 재현·합격 확인(정본)

Gateway 는 claude-cli 백엔드를 **PATH 의 `claude`** 로 띄운다. 가짜 `claude` 를 PATH 앞에 둔 Gateway 를 띄우고 채널에 `@dev` 를 보낸다. 가짜 CLI 는 `--mcp-config` 와 env(`OPENCLAW_MCP_TOKEN`·`OPENCLAW_MCP_CLI_CAPTURE_KEY`)로
**run grant** 를 받아 루프백에 `message`(와 `ask_user`)를 한 번씩 부르고 끝낸다. 가짜 CLI 는 **레포에 파일로 두지 않는다**(실행 파일이 레포에 있으면 진짜 `claude` 를 가릴 수 있다) — 아래 「가짜 claude CLI 스크립트」를 스크래치 디렉터리에 만든다.

```bash
SP=$(mktemp -d); mkdir -p $SP/fakebin
cp data/args.json $SP/fake-args.json                                            # message 인자
echo '{"questions":[{"id":"q","header":"형식","question":"골라 주세요","options":[{"label":"A","description":"a"},{"label":"B","description":"b"}]}]}' > $SP/fake-ask-user.json   # 있으면 ask_user 도 부른다
# 「가짜 claude CLI 스크립트」를 $SP/fakebin/claude 로 저장한 뒤:
REAL=$(whence -p claude 2>/dev/null || command -v claude)                     # zsh 에서 alias·함수면 command -v 는 경로가 아니다
[[ $REAL == /* && -x $REAL ]] && sed -i '' "s#__REAL_CLAUDE__#$REAL#" $SP/fakebin/claude && chmod +x $SP/fakebin/claude \
  || echo "claude 절대경로가 아니다(REAL=$REAL) — REAL 에 직접 넣고 다시"
kill $(lsof -nP -iTCP:19001 -sTCP:LISTEN -t)                                   # 지금 Gateway
( env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$(cat data/dev-gateway.token)" NODE_OPTIONS=--stack-trace-limit=60 \
      PATH="$SP/fakebin:$OCBIN:$PATH" \
      nohup openclaw --dev gateway run --dev --auth token --port 19001 --bind loopback >> data/dev-gateway.log 2>&1 < /dev/null & )
# 서버 로그에 bridge 가 다시 connected 가 된 뒤
W send $CH "@dev 가짜 CLI 프로브" --watch-ms 20000
jq -c 'select(.isRun != false) | del(.argv,.envKeys)' $SP/fake-out/fake-claude.jsonl    # tools/call message 결과 원문
grep "dodok:probe\|dodok:tool-send" data/dev-gateway.log | tail                       # probe 번들이면 어느 세대인지
```

**합격 기준**(ADR 0004 6절):
- `tools/call message` → `sent to dodok channel <CV> (<messageId>)`. (고치기 전: `{"content":[{"type":"text","text":"dodok: account \"default\" bridge is not running"}],"isError":true}`)
- 서버에 카드 `message.created` 가 오고, 그 메시지의 **`runId` 가 그 가짜 런**이고 **`replyTo` 가 방금 보낸 사람 메시지**다 — 상관관계(`correlations`)까지 공유됐는지를 이것으로 본다. 카드만 오고 `runId` 가 비면 반쪽이다.
- `ask_user` 는 다음 층 `agent not found`(결함 2 의 뒷반쪽, `docs/guides/plan.md` 8장 이월)에서 막히는 것이 **정상**이다. 고치기 전에는 `ask_user prompt delivery failed | dodok: bridge is not running`.
- 런 정본은 가짜 답 `FAKE_CLI_DONE` → `message.created` · `RUN_FINISHED`(usage 0·cost 0).

**가짜 CLI 가 걸리는 곳 셋**(이걸 어기면 런이 `RUN_ERROR "Claude CLI live session exited unexpectedly without a terminal result."` 로 끝난다):
1. 툴을 너무 일찍 부르면 `Native tool authority is not initialized` 가 난다. CLI 가 `system/init` 레코드(`tools` 배열)를 먼저 stdout 에 내야 authority 가 잡힌다.
2. Gateway 는 stdin 으로 `control_request{subtype:"initialize"}` 를 먼저 보내고 `control_response` 를 기다린다. 그다음에 `user` 레코드가 온다. 순서는 **control_response → user 수신 → system/init → 툴 호출 → assistant·result**.
3. `-p` 가 없는 호출(버전·인증 확인)은 진짜 `claude` 로 넘긴다 — 모델을 부르지 않는다.

**세션을 잴 때 걸리는 곳 넷**(ADR 0006):
1. **가짜 CLI 는 claude 전사 파일을 만들지 않는다** — 같은 세션의 둘째 턴은 Gateway 로그 `cli session reset: reason=missing-transcript` 로 매번 새 CLI 세션이 된다. `--resume` 경로는 이 하네스로 못 잰다.
   같은 세션에 턴 둘을 겹쳐 보내지 않는다 — 큐잉된 둘째 턴은 살아 있는 프로세스로 가는데, 첫 턴 뒤 끝나는 가짜 CLI 는 `Managed CLI live session is no longer reusable` 로 실패한다. 세션 id 는 argv 의 `--session-id`/`--resume` 값을 그대로 되돌린다.
2. **시스템 프롬프트는 argv 가 아니라 stdin `control_request { subtype: "initialize", appendSystemPrompt }`** 로 온다 — argv 만 보면 「채널 프롬프트가 안 들어갔다」로 오판한다.
3. **zsh 에서 세션 키를 셸 변수로 이을 때는 `${B}:thread:${T}`** 로 쓴다 — `$B:thread:…` 는 `:t` 수식자로 먹혀 `${B:t}hread…` 가 된다. 깨진 키로 부른 `chat.history` 는 오류 없이 빈 결과를 돌려준다.
4. 새로 만든 9.5 상태(`OPENCLAW_HOME`)에서 Gateway 세션은 파일이 아니라 `agents/<에이전트>/agent/openclaw-agent.sqlite` 다 — 「Gateway 세션 읽기·지우기」.

**끝나면**: 가짜 PATH 없이 Gateway 를 다시 띄우거나(「절차」 절 (c)) 내린다. `rm -rf $SP`. probe 를 붙였으면 「준비」 대로 되돌린다. 하네스 채널은 진짜 모델 런에 쓰지 않는다.

### 가짜 claude CLI 스크립트

모델을 부르지 않는다. `-p` 런이면 run grant 로 루프백 `/mcp` 에 `message`(그리고 `fake-ask-user.json` 이 있으면 `ask_user`)를 한 번씩 부르고 끝낸다.
출력은 `$SP/fake-out/fake-claude.jsonl`(env 는 **키 이름만** 적는다 — 토큰 값은 남기지 않는다).

```js
#!/usr/bin/env node
// 가짜 claude — 모델을 부르지 않는다. -p 런이면 루프백 MCP 로 message 툴을 한 번 호출하고 끝낸다.
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const DIR = __dirname + "/../fake-out";
fs.mkdirSync(DIR, { recursive: true });
const argv = process.argv.slice(2);
const log = (o) => fs.appendFileSync(DIR + "/fake-claude.jsonl", JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...o }) + "\n");
const isRun = argv.includes("-p") || argv.includes("--print");
log({ event: "invoke", isRun, argv: argv.map((a) => (a.length > 200 ? a.slice(0, 200) + "…" : a)), envKeys: Object.keys(process.env).filter((k) => /OPENCLAW|MCP|CLAUDE|ANTHROPIC/.test(k)) });
if (!isRun) {
  const r = spawnSync("__REAL_CLAUDE__", argv, { stdio: "inherit" }); // 정본 절차의 sed 가 진짜 claude 경로로 바꾼다
  process.exit(r.status ?? 1);
}
const SID = "00000000-0000-4000-8000-00000000c214";
let inBuf = "";
let started = false;
process.stdin.on("data", (d) => {
  inBuf += d;
  let i;
  while ((i = inBuf.indexOf("\n")) >= 0) {
    const line = inBuf.slice(0, i); inBuf = inBuf.slice(i + 1);
    try { const m = JSON.parse(line);
      if (m.type === "control_request") process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } }) + "\n");
      if (m.type === "user" && !started) { started = true; startTurn(); }
      log({ event: "stdin-record", type: m.type, subtype: m.subtype, requestSubtype: m.request?.subtype }); } catch { log({ event: "stdin-raw", bytes: line.length }); }
  }
});
const startTurn = () => (async () => {
  // native tool authority 는 system/init 의 tools 로 잡힌다 — 툴 호출보다 먼저
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: SID, model: "fake", tools: [] }) + "\n");
  await new Promise((r) => setTimeout(r, 500));
  try {
    const i = argv.indexOf("--mcp-config");
    const cfg = JSON.parse(fs.readFileSync(argv[i + 1], "utf8"));
    const srv = cfg.mcpServers.openclaw;
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    for (const [k, v] of Object.entries(srv.headers ?? {})) headers[k] = String(v).replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] ?? "");
    log({ event: "mcp-config", url: srv.url, headerKeys: Object.keys(srv.headers ?? {}), tokenPresent: !!process.env.OPENCLAW_MCP_TOKEN, captureKeyPresent: !!process.env.OPENCLAW_MCP_CLI_CAPTURE_KEY });
    let id = 0;
    const rpc = async (method, params) => {
      const res = await fetch(srv.url, { method: "POST", headers, signal: AbortSignal.timeout(25000), body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      return { status: res.status, text: await res.text() };
    };
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "0" } });
    log({ event: "initialize", status: init.status, body: init.text.slice(0, 300) });
    const list = await rpc("tools/list", {});
    let names = [];
    try { names = JSON.parse(list.text).result.tools.map((t) => t.name); } catch {}
    log({ event: "tools/list", status: list.status, count: names.length, hasMessage: names.includes("message"), hasAskUser: names.includes("ask_user") });
    const args = JSON.parse(fs.readFileSync(__dirname + "/../fake-args.json", "utf8"));
    const call = await rpc("tools/call", { name: "message", arguments: args });
    log({ event: "tools/call message", status: call.status, body: call.text.slice(0, 600) });
    if (fs.existsSync(__dirname + "/../fake-ask-user.json")) {
      const ask = await rpc("tools/call", { name: "ask_user", arguments: JSON.parse(fs.readFileSync(__dirname + "/../fake-ask-user.json", "utf8")) });
      log({ event: "tools/call ask_user", status: ask.status, body: ask.text.slice(0, 600) });
    }
  } catch (e) {
    log({ event: "error", error: String((e && e.stack) || e).slice(0, 800) });
  }
  process.stdout.write(JSON.stringify({ type: "assistant", session_id: SID, message: { id: "msg_fake", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "FAKE_CLI_DONE" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "FAKE_CLI_DONE", session_id: SID, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } }) + "\n");
  log({ event: "exit" });
  setTimeout(() => process.exit(0), 1500);
})();
setTimeout(() => { log({ event: "no-user-record-timeout" }); process.exit(0); }, 60000);
```

### 첨부 재기 (Phase 2 ③)

정본 하네스에 세 가지를 더해 첨부 경로를 모델 없이 두드린다(스파이크 `.superpowers/sdd/2026-09-23-phase2-attachments-spike/report.md` 「절차 요지」를 이 문서 모양으로 다시 적은 것). 더 보탤 것은 이 절 끝 ⑤ 에 있다.
새 번들 설치는 「절차」 절 (b) 대로 한다 — **Gateway 를 먼저 내리고**, 설치 뒤 설치본 sha 가 빌드본과 같은지 본다.
**① 가짜 CLI 가 받은 이미지를 잰다.** 「가짜 claude CLI 스크립트」의 stdin 처리에서 `log({ event: "stdin-record", … })` 한 줄을 아래로 바꾼다. claude-cli 는 이미지를 base64 블록이 아니라 프롬프트 끝 `@<ws>/.openclaw-cli-images/<sha256>.<ext>` 로 받는다(스파이크 1-7). 그 파일의 크기·권한·앞 8바이트만 적는다 — **base64 본문과 경로는 적지 않는다.**

```js
const c = m.message?.content;
const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
const atRefs = [...text.matchAll(/@(\/\S+)/g)].map(([, p]) => {
  try {
    const st = fs.statSync(p), head = Buffer.alloc(8), fd = fs.openSync(p, "r");
    fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
    return { size: st.size, mode: (st.mode & 0o777).toString(8), magic: head.toString("hex") };
  } catch (e) { return { error: e.code }; }
});
log({ event: "stdin-record", type: m.type, subtype: m.subtype, requestSubtype: m.request?.subtype,
  contentKind: Array.isArray(c) ? "blocks" : typeof c, atRefs,
  blocks: Array.isArray(c) ? c.filter((b) => b.type !== "text").map((b) => ({ type: b.type, mediaType: b.source?.media_type, bytes: b.source?.data?.length })) : [] });
```

**② 최종 응답을 파일로 바꾼다.** 스크립트의 `FAKE_CLI_DONE` 두 자리(`assistant` 의 `text`, `result` 의 `result`)를 `FINAL` 로 바꾸고, 툴 호출은 `fake-args.json` 이 있을 때만 한다.

```js
const FINAL_FILE = __dirname + "/../fake-final.txt";
const FINAL = fs.existsSync(FINAL_FILE) ? fs.readFileSync(FINAL_FILE, "utf8") : "FAKE_CLI_DONE";
// startTurn 안: const args = … 앞에서 if (!fs.existsSync(__dirname + "/../fake-args.json")) { log({ event: "no-tool-call" }); } else { …툴 호출… }
```

⚠ 가짜 CLI 런은 `message` 툴을 써도 최종 텍스트가 **억제되지 않고** `FINAL` 이 따로 한 메시지로 온다. 9.5 에서는 실제 모델 런도 같다 — 채널·스레드 모두 최종 답이 올라온다(`docs/adr/0006-thread-sessions-spike.md`). ADR 0002 가 9.4 에서 잰 억제(`terminalReply.disposition: "silent"`)는 이 하네스로 재지 않는다.

**③ 준비물.** 툴이 읽을 파일은 **Gateway 워크스페이스 안**에 둔다(dev: `~/.openclaw-dev/workspace`). 밖이면 `tools.fs.workspaceOnly` 에 따라 「허용되지 않은 경로」가 날 수 있다.

```bash
WS=~/.openclaw-dev/workspace; mkdir -p $WS/a3-harness
cp <아무 PNG> $WS/a3-harness/chart.png; cp <아무 PDF> "$WS/a3-harness/월간 보고서.pdf"
shasum -a 256 $WS/a3-harness/*; stat -f '%z %N' $WS/a3-harness/*          # 크기·sha 를 적어 둔다
```

**④ 차례와 합격 기준**(계획 `docs/superpowers/plans/2026-09-23-attachments.md` 태스크 11 의 1). 런마다 `$SP/fake-args.json`·`fake-final.txt` 를 바꾸고 `@dev` 를 한 번 보낸다. 사람 이미지는 **웹 작성기로** 보낸다 — `wire-cli` 는 첨부를 보내지 못한다(「웹을 얹을 때」 절대로 웹을 띄운다).

| # | 런 | 준비 | 합격 |
| --- | --- | --- | --- |
| a | **인바운드** — 사람 이미지 | `fake-args.json`·`fake-final.txt` 없음. 웹에서 PNG 한 장 + `@dev 첨부 프로브` | `stdin-record` 의 `atRefs` 가 하나, `magic` 이 `89504e470d0a1a0a`, `size` 가 올린 원본과 같다(`contentKind:"string"`, `blocks:[]`). Gateway 로그 `[dodok] inbound-media` 가 `images:1`·`reasons:[]` |
| b | **툴 `media`** — PNG·PDF·한국어 이름 | `fake-args.json` = `{"action":"send","target":"channel:<CV>","message":"첨부 둘","mediaUrls":["<WS>/a3-harness/chart.png","<WS>/a3-harness/월간 보고서.pdf"]}` | `tools/call message` 가 `sent to dodok channel …`. 채널 메시지에 첨부 둘이 **그 순서로**, 이름 `chart.png`·`월간 보고서.pdf` 그대로. 내려받은 바이트의 sha 가 ③ 과 같다. `dodok:tool-send-media` 가 `uploaded:2`·`failed:0` |
| c | **최종 응답 `MEDIA:` 줄** | `fake-args.json` 없음. `fake-final.txt` 세 줄 — `결과`, 빈 줄, `MEDIA:<WS>/a3-harness/chart.png`(`printf '결과\n\nMEDIA:%s\n' <경로> > $SP/fake-final.txt`) | 채널 메시지 본문이 `결과` 이고 **`MEDIA:` 가 없다**, 첨부 하나. `[dodok] deliver-media` 가 `uploaded:1`. 서버 로그에 `gateway snapshot media lines dropped` 가 없다(플러그인 정본이 먼저 왔다는 뜻 — 스펙 11장 Ruling 2) |
| d | **미디어만 있는 응답** | `fake-args.json` 없음. `fake-final.txt` 한 줄 — `MEDIA:<WS>/a3-harness/chart.png` | 채널에 **본문 없이** 첨부만 온다. 채널 어디에도 호스트 경로(`/Users/`·`~/.openclaw`)가 없다 |
| e | **실패 문구**(선택) | b 의 경로 하나를 없는 파일로 | 툴 결과가 `dodok: 첨부를 보내지 못했습니다 — <이름>: 파일을 찾을 수 없음`. 호스트 경로가 툴 결과·채널에 없다(원문은 `dodok:tool-send-media` 의 `details` 에만, 가려서) |

`<CV>`·`<WS>` 는 실제 값으로 바꿔 쓴다. c·d 가 통과하면 스파이크 2-10 의 결함(미디어 전용 응답이 `MEDIA:/호스트/경로` 를 채널에 드러냄)이 실물에서 닫힌 것이다.
이 표는 플러그인 `channel.ts` 배선(순수 함수를 부르는가)의 합격 기준도 겸한다 — 단위 테스트는 그 우회를 못 잡는다(`docs/guides/plan.md` 8장 이월).

**끝나면**: 정본 절차대로 되돌리고, `rm -rf $WS/a3-harness`. 플러그인이 저장한 원본(`~/.openclaw-dev/media/inbound/`)·CLI 복사본(`<ws>/.openclaw-cli-images/`)·스테이징(`<ws>/media/inbound/openclaw-staged-*`)·**아웃바운드 스테이징(`~/.openclaw-dev/media/outbound/` — 툴 `media` 와 `MEDIA:` 줄이 코어를 지날 때 복사본이 생긴다, Gateway 가 24h 뒤 지운다)**에서 이번 런이 만든 것만 지운다(`find … -newermt '<시작 시각>'` 로 가른다. 스파이크 보고서 「정리 상태」가 본보기). 모델 런이 워크스페이스에 만든 파일(예: `hello-c3po.txt`)도 지운다.
**⑤ 보탤 것**
- **로그 머리가 둘이다.** 인바운드·최종 응답 쪽은 런타임 `logger` 라 `[dodok] inbound-media`·`[dodok] deliver`·`[dodok] deliver-media`, 툴 쪽은 `console.info` 라 `dodok:tool-send`·`dodok:tool-send-media` 다. `grep -a 'inbound-media\|deliver-media\|tool-send'` 로 한 번에 본다. 로그에 색 코드가 섞여 있어 `sed 's/\x1b\[[0-9;]*m//g'` 를 먼저 건다.
- **`fake-args.json` 을 배열로도 받고, 한 번 쓰면 치운다.** 한 런에서 여러 호출(b·e·상대 경로)을 한 번에 두드리고, 릴레이(에이전트 A 의 툴 전송이 `@dev` 를 불러 dev 의 런이 이어지는 것)에서 두 번째 런이 같은 툴을 다시 부르지 않게 한다. 스크립트의 `const args = …; const call = …` 자리를 `const raw = fs.readFileSync(ARGS_FILE); fs.renameSync(ARGS_FILE, ARGS_FILE + ".used-" + Date.now()); const calls = [].concat(JSON.parse(raw));` 와 `for (const args of calls) …` 로 바꾼다.
- **`stdin-record` 에 두 가지를 더 적었다.** `atRefs` 마다 `sha256` 앞 16자(원본과 바이트 동일을 크기·magic 보다 세게 본다), 그리고 프롬프트에서 `/Users/…` 가 든 줄의 **꼴만**(`hostPathLines` — 홈을 `~` 로 바꾸고 160자로 자른다). 알림 줄은 `^\[(첨부 파일|이미지를 불러오지)` 로 뽑아 `notes` 에 둔다. Gateway 가 프롬프트에 `[media attached i/N: <스테이징 호스트 경로> …]` 를 스스로 붙이는 것이 이것으로 보인다.
- **6 MiB 넘는 인바운드는 릴레이로만 잰다.** 사람 업로드 상한이 5 MiB 라 웹으로는 `saveMediaBuffer` 의 `maxBytes`(20 MiB)를 두드릴 수 없다. 채널에 `fin` 을 더하고, `fake-args.json` 을 `{"action":"send","target":"channel:<CV>","message":"@dev …","mediaUrls":["<WS>/a3-harness/big.png","<WS>/a3-harness/월간 보고서.pdf"]}` 로 둔 채 `@fin …` 을 보낸다 — fin 의 가짜 런이 큰 PNG·PDF 를 올리고, 그 메시지가 dev 를 불러 dev 의 인바운드에 이미지 하나 + `[첨부 파일: 월간 보고서.pdf]` 가 실린다. 무작위 픽셀 PNG(1700×1700, 8.7 MB)는 PIL 로 만든다.
- **델타를 쪼개 흘리려면 `stream_event` 레코드를 낸다.** `assistant` 레코드만 내면 Gateway 는 그것을 `result` 가 올 때 **한 델타로** 흘린다(`assistant` 와 `result` 사이에 지연을 넣어도 버블이 먼저 보이지 않는다). 진짜 CLI 처럼 `stream_event` 를 내면 Gateway 가 조각마다 따로 흘린다 — 코어의 claude-cli 파서가 `stream_event` 의 `content_block_delta`·`text_delta` 를 델타로 읽는다(9.5 `dist/cli-live-session-registry-*.mjs` 의 `parseClaudeCliStreamingDelta`). 그래서 **모델 런 없이 델타 쪼개기·시각을 잴 수 있다**. 스크립트의 `assistant`·`result` 두 줄 앞에 아래를 넣는다(`fake-stream.json` = `{"gapMs":600,"deltas":["…","…"]}`, 최종 텍스트는 `deltas` 를 이은 것).
  ```js
  const MID = "msg_fake_" + Date.now(), se = (event) => out({ type: "stream_event", session_id: SID, event });
  se({ type: "message_start", message: { id: MID, type: "message", role: "assistant", model: "fake", content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const text of spec.deltas) { await sleep(spec.gapMs); se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }); }
  se({ type: "content_block_stop", index: 0 }); se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }); se({ type: "message_stop" });
  // 그다음 스크립트대로 assistant(content = deltas.join("")) · result(result = 같은 글)
  ```
  사람 눈에 실제로 얼마나 오래 보이는지(모델의 토큰 간격)는 여전히 모델 런으로만 잰다.

### 가짜 CLI 에 보태는 것 — 재는 것마다

모두 「가짜 claude CLI 스크립트」를 고쳐 쓴다. 기록은 스크래치에만 둔다(비밀이 들어가지 않는 실연 글이다).

**`-p` 없는 호출에 고정값으로 답하기.** OpenClaw CLI·Gateway 는 `claude auth status --json` 의 `loggedIn` 을 보고(Gateway 기동마다 등), 첫 런 앞에 `--version` 을 한 번 묻는다. 진짜 `claude` 로 넘기지 않으려면:

```js
if (!isRun) {
  if (argv.includes("--version")) { process.stdout.write("2.1.283 (Claude Code)\n"); process.exit(0); }
  if (argv[0] === "auth" && argv[1] === "status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) + "\n"); process.exit(0); }
  process.exit(1);
}
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const SID = at("--session-id") ?? at("--resume");                       // 세션 id 는 argv 값을 되돌린다
```

**모델 입력(프롬프트)을 적기.** 루프백 MCP 호출을 빼고(또는 아래 `calls.json` 이 있을 때만 부르고) stdin 의 첫 `user` 레코드 글을 `log({ event: "prompt", sid: SID, text })` 로 적는다. `invoke` 줄에는 argv(인자마다 6,000자까지)와 `--session-id`·`--resume` 값을 적는다. 헤더(에이전트가 받는 사실)는 `prompt` 글에서 `\n---\n` 앞을 잘라 본다 — 반응 블록 같은 문구는 shared 함수(`formatReactionFacts` 등)에 같은 입력을 넣은 결과와 글자까지 대조한다(`pnpm exec tsx` 로 `packages/shared/src/index.ts` 를 불러 `head.endsWith("\n" + 블록)`).
⚠ 9.5 의 `user` 레코드 `content` 는 문자열 하나이고, 앞에 OpenClaw 가 붙인 `Conversation info: ⟦openclaw:ctx⟧` JSON 블록(`chat_id` 등 — 대화 id), 그 뒤에 플러그인 헤더·`---`·사람 글이 온다. `jq -r .text … | tail -1` 처럼 줄로 자르면 사람 글 줄만 남아 「헤더가 없다」로 오판한다 — `capture` 로 꺼낸다.

```bash
jq -c 'select(.event=="prompt") | {sid: .sid[0:8],
  chat_id: (.text | capture("\"chat_id\":\"(?<c>[^\"]+)\"").c),
  session: (.text | capture("\n세션: (?<s>[^\n]*)").s),
  recent: ([.text | scan("\n\\[[0-9:]+\\] [^\n]*")] | map(.[1:])),
  last: (.text | split("\n---\n") | last)}' <스크래치>/fake/out/fake-claude.jsonl
```

**툴을 여럿 부르기.** `-p` 런이면 `<스크래치>/fake/calls.json`(배열 `{label, name, arguments, timeoutMs?}`)이 있을 때 읽고 지운 뒤 루프백 `/mcp` 에 `tools/call` 을 차례로 부르고 결과 원문을 적는다. 최종 답은 `FAKE_CLI_DONE sid=<세션 id 앞 8자> <label>=ok|error …` 처럼 결과를 실으면 채널에서 바로 보인다. 제어 도구(`dodok_<tool>`)도 같은 길로 부른다 — `tools/list` 의 `dodok` 이름과 스키마를 함께 적는다.

**시스템 프롬프트 전체를 남기기.** 채널 프롬프트·「이 DM 의 지시」는 argv 가 아니라 stdin `control_request { subtype: "initialize", appendSystemPrompt }` 로 오고, 9.5 의 `appendSystemPrompt` 는 3만 자를 넘어 기록 한 줄에 다 싣지 못한다(채널 프롬프트는 그 안 그룹 소개 문단 뒤에 실린다). 그 값을 따로 파일에 쓴다.

```js
// control_request 를 받는 자리에 더한다
if (m.request?.subtype === "initialize") {
  const asp = typeof m.request.appendSystemPrompt === "string" ? m.request.appendSystemPrompt : "";
  fs.writeFileSync(DIR + `/asp-${SID.slice(0, 8)}-${process.pid}.txt`, asp);
  log({ event: "asp", sid: SID, len: asp.length, markers: asp.match(/[A-Z]+-RULE-[A-Z0-9]+/g) ?? [] });
}
```

판정은 지시에 넣은 표식(`DM-RULE-MAIN` 등)을 `asp-*.txt`·`prompt` 기록에서 찾고, 플러그인이 Gateway 로그에 남기는 `[dodok] ingress {…, "groupSystemPromptChars":…, "channelPromptContextItems":…}` 줄과 맞춰 본다.

```bash
jq -c 'select(.event=="asp" or .event=="prompt") | {event, sid: .sid[0:8], len, markers}' <스크래치>/fake/out/fake-claude.jsonl
grep ingress <스크래치>/logs/gw.log | grep -o '{.*}' | jq -c '{sessionKey, groupSystemPromptChars, channelPromptContextItems}'
```

**모델 없이 승인 일으키기.** Gateway 의 claude-cli 백엔드는 CLI 가 stdout 으로 낸 `control_request { subtype: "can_use_tool" }` 을 네이티브 툴 권한 요청으로 받아(9.5 `dist/extensions/anthropic/cli.runtime.js` 의 `handleRequest`) exec 정책을 판정하고, `ask` 가 `always` 면 승인을 만든다. 스크립트의 `startTurn` 에서 `system/init` 뒤에 아래를 넣고, stdin 처리에 `control_response` 를 기다리는 자리를 더한다. 정책은 「승인(Phase 2 ①)을 실물에서 보기 — 절차」 「켜기」로 켜고 **「되돌리기 — 반드시 한다」로 되돌린다**.

```js
// fake-approve.json = {"tool_name":"Write","input":{"file_path":"<~/.openclaw-dev/workspace>/t8a-approval.txt","content":"hello"}}
// 파일은 실제로 쓰지 않는다. 한 번 쓰면 .used-<시각> 으로 치운다
const request_id = "req_fake_" + Date.now();
const res = await new Promise((resolve) => {
  pending.set(request_id, resolve);            // stdin 의 { type: "control_response", response: { request_id, response: { behavior } } } 가 푼다
  out({ type: "control_request", request_id,
        request: { subtype: "can_use_tool", tool_name: spec.tool_name, input: spec.input, tool_use_id: "toolu_fake_" + Date.now() } });
});
final = "FAKE_CLI_DONE approval=" + (res.response?.behavior ?? res.subtype);   // allow·deny
```

- `Write`·`Read`·`Edit` 에 `file_path` 가 있으면 코어가 경로 규칙을 먼저 본다 — 워크스페이스(`~/.openclaw-dev/workspace`) 안 경로를 준다. 승인은 Gateway 에서 **플러그인 승인**(`plugin.approval.waitDecision`)으로 뜬다.
- 가짜 CLI 의 대기 상한은 승인 TTL(실물 120초)보다 길게 둔다(예: 300초).
- 모델 런이 아니라 Gateway 가 기록하는 승인 이벤트·`approval.resolve` RPC·런 재개가 실물 그대로 돈다.
- 가짜 CLI 의 `fetch`(undici)는 응답 머리를 300초까지만 기다린다(`headersTimeout` 기본값) — 그보다 오래 두는 카드·승인은 `headersTimeout: 0` 인 undici `Agent` 를 주거나 「진짜 번들 CLI 를 Gateway 의 `claude` 로」 꼴로 잰다.

**진짜 번들 CLI 를 Gateway 의 `claude` 로.** 실제 Claude Code CLI 가 OpenClaw 의 툴·제어 요청을 어떻게 다루는지(대기 시간·끊김 등) 보려면 러너 tgz 의 번들 CLI(`claude-agent-sdk-<os>-<arch>/claude.real`)를 Gateway PATH 앞의 감싸개로 둔다 — 감싸개는 「Claude 러너 런 0회 하네스 — 번들 CLI + 가짜 Messages API」 절의 꼴에 `HOME`·`CLAUDE_CONFIG_DIR` 을 스크래치로 주고, `auth status` 에는 감싸개가 `{"loggedIn":true}` 로 답한다. 모델 자리는 `packages/claude-runner/scripts/fake-messages-api.ts` 의 스크래치 사본에 대본을 더해 쓴다 — OpenClaw 프롬프트 모양에 맞게 대본 키를 마지막 user 메시지 전체에서 찾게 한다. 이 CLI 의 런은 **새 채널에서만** 한다(가짜 CLI 의 세션 id 가 남은 채널을 잇지 않게 — 「준비」의 경고).

### 운영자 `tools.invoke` 로 `message` 툴 부르기

모델 없이 `message` 툴을 실물 Gateway 의 운영자 경로로 부른다(모델 런의 툴 경로와는 다른 세대로 간다 — 「런 0회 하네스」 표). 토큰은 env 로만, `--url` 대신 `--port`:

```bash
ARGS='{"action":"send","target":"channel:<대화 id>","message":"…","components":{…}}'   # 모델이 낸 인자는 run_events 의 TOOL_CALL_ARGS 에 그대로 있다
PARAMS=$(jq -cn --argjson a "$ARGS" --arg sk "agent:dev:dodok:channel:<대화 id>" '{name:"message", args:$a, sessionKey:$sk, agentId:"dev", idempotencyKey:"probe-1"}')
( env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$(cat data/dev-gateway.token)" PATH="$OCBIN:$PATH" \
    openclaw --dev gateway call tools.invoke --port 19001 --json --params "$PARAMS" )
# {"ok":true,"toolName":"message","output":{…"sent to dodok channel … (<messageId>)"…},"source":"core"}
```

- **세션 키를 꼭 준다.** 9.5 는 세션 키 없는 `tools.invoke` 에 `agent:<에이전트>:main` 을 채우고, 플러그인은 그것을 dodok 밖 세션으로 보고 「이 대화에만 보낼 수 있습니다」로 거절한다.
- ⚠ 이렇게 올린 카드는 **그 세션의 모델이 모른다** — 모델의 전사에는 그 툴 호출이 없다. 다음 런의 답을 읽을 때 감안한다.
- 운영자가 보낸 메시지의 `runId`·`replyTo` 는 그 세션의 **마지막 인바운드**(이미 끝난 런과 그 사람 메시지)로 채워진다 — 플러그인 상관(세션 키당 마지막 인바운드)이 운영자 전송에도 붙는다.

### Gateway 세션 읽기·지우기

`gcall` 은 「절차」 절 (c) 의 env 로 `openclaw --dev gateway call <메서드> --port 19001 --json --params <json>` 을 부르는 셸 함수다(토큰은 env 로만).

```bash
# 세션 전사 요약 — 항목 수·delivery-mirror 수만(본문은 보지 않는다)
hist() { gcall chat.history "{\"sessionKey\":\"$1\",\"limit\":500}" | jq -c '{total: (.messages|length),
  mirror: ([.messages[] | select((.model // "") == "delivery-mirror")] | length), sessionId}'; }
B="agent:dev:dodok:channel:${CV}"          # zsh — ${B}:thread:${R} 로 잇는다(「세션을 잴 때 걸리는 곳 넷」)
hist "$B"; hist "${B}:thread:${R1}"
# 끝나면 만든 세션을 지운다 — Gateway 가 *.jsonl.deleted.<시각>.*.zst 로 보관한다
gcall sessions.list '{"limit":300}' | jq -r --arg cv "$CV" '.sessions[] | select(.key|contains($cv)) | .key' \
  | while read k; do gcall sessions.delete "{\"key\":\"$k\"}" >/dev/null; done
```

- Gateway `sessions.list` 의 `startedAt` 은 세션 시작이 아니라 **마지막 런의 시작**이고 리셋하면 `null` 이 된다 — 세션 시작 시각으로 읽지 않는다. 세션 시작은 서버 `agent_sessions.session_started_at`(`sessions.reset` 응답의 `entry.sessionStartedAt` 을 옮긴 것)으로 본다.
- **9.5 Gateway 의 세션 저장소는 SQLite 다**(새로 만든 상태에서 — `<OPENCLAW_HOME>/.openclaw/agents/<에이전트>/agent/openclaw-agent.sqlite`, dev 는 `~/.openclaw-dev/agents/<에이전트>/agent/openclaw-agent.sqlite`). 읽기 전용으로 연다.

```bash
A="file:$SP/gw/.openclaw/agents/main/agent/openclaw-agent.sqlite?mode=ro"
sqlite3 "$A" "select session_key, current_session_id, display_name from session_nodes order by created_at"   # 키마다 OpenClaw 세션 하나
sqlite3 "$A" "select w.session_key, count(*), sum(instr(e.event_json,'ALPHA')>0), sum(instr(e.event_json,'BRAVO')>0)
              from transcript_events e join session_windows w using(session_id) group by w.session_key"         # 전사 사건 수·표식이 든 사건 수
```

### 재는 것별 메모

**run_error 카드·「다시 실행」**
- **run_error 카드는 브리지가 끊긴 채 멘션해야 생긴다.** 실물 Gateway 에서는 Gateway 를 내리면 플러그인이 함께 끊긴다 — 멘션한 런이 `queuedMs`(120초) 뒤 `ADAPTER_UNAVAILABLE` 로 닫히며 카드가 붙는다. 가짜 CLI 를 실패시키면 런 오류 코드가 `unknown` 으로 오고(어댑터가 Gateway `errorKind` 를 코드로 쓰고, 없으면 `unknown`), 서버는 그 코드에 카드를 붙이지 않는다(`orchestrator.ts` 의 `NOTIFY_CODES`).
- 같은 세션·같은 에이전트에 여러 멘션을 걸면 세션 큐 때문에 120초씩 이어진다 — 카드가 여럿 필요하면 채널(또는 세션)을 나눈다.
- Gateway 를 오래 내렸다 올리면 서버의 Gateway 재접속 백오프(상한 30초)만큼 늦게 붙는다 — `adapter/status` 가 둘 다 `connected` 인지 보고 「다시 실행」을 누른다(`W interact $CH <카드 메시지 id> retry_run`).
- 레이트리밋 사건을 보려고 틀린 토큰으로 1분에 다섯 번 넘게 로그인하면(여섯째부터 429) **같은 IP 의 정상 로그인도 그 창이 지날 때까지 429** 다 — 정상 로그인은 그 뒤에.

**세션·스레드**
- 두 멘션을 같이 보낼 때는 **서로 다른 세션**에 보낸다. 같은 세션에 겹쳐 보내면 가짜 CLI 의 둘째 턴이 실패한다(「세션을 잴 때 걸리는 곳 넷」 1).
- 옛 플러그인(새 capability 가 없는 것)을 재려면 새 플러그인을 설치하기 전에 잰다 — 그 이전 커밋에서 `pack:plugin` 한 tgz 를 「절차」 절 (b) 대로 설치한다. 설치 전 설치본은 `~/.openclaw-dev/extensions/dodok` 을 `package/` 아래로 묶어 tgz 로 남겨 둘 수 있다.

**사람이 여럿인 채널**
- `wire-cli` 는 로컬 토큰 owner 하나만 안다. 사람 여럿(초대·수락·멤버 로그인·사람마다 소켓)이 필요하면 `data/`(ignored)에 드라이버를 두고 `pnpm -s exec tsx data/<파일>.ts <명령>` 으로 돌린다 — `socket.io-client` 로 `auth: {token: <세션>, protocol: 1}`, `channel.subscribe` → 이벤트를 받은 시각과 함께 jsonl 로, `disconnect` 면 이유를 적는다. 원문·비밀번호·세션 토큰은 출력하지 않고 스크래치 0600 파일에만 둔다. 끝나면 지운다.
- 에이전트 헤더(「참여자:」 등)는 가짜 CLI 기록의 `prompt` 로 판정한다. 서버의 `GET /channels/<CH>/members` 는 사람을 id 로만 준다.

**로컬 푸시 받이**(누가 푸시 대상인지 실제 서비스 없이) — 구독 `endpoint` 는 `https://` 만 받는다(shared `PushSubscriptionInput`). 스크래치에 자체 서명 인증서(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1`)를 만들고, `https.createServer` 로 `127.0.0.1:19443` 에서 POST 의 **경로·바이트 수·`Urgency`·`Topic` 헤더만** 적고 201 을 돌려준다(본문은 암호문이라 안 적는다). 서버는 `NODE_EXTRA_CA_CERTS=<그 인증서>` 로 띄운다(`data/live-smoke.env` 에 한 줄) — TLS 검사를 끄지 않는다.
구독은 사람마다 `POST /api/v1/push/subscriptions {endpoint: "https://127.0.0.1:19443/push/<핸들>", keys: {p256dh: <P-256 공개키 base64url>, auth: <16바이트 base64url>}}`(키는 `crypto.createECDH("prime256v1")`). 받는 사람은 받이의 경로로, 서버 쪽은 `"push sent"` 의 `subscriptionId` 를 `push_subscriptions` 와 이어 본다(그 줄에 `userId` 가 없다).
관찰 소켓은 `presence.update` 를 보내지 않으므로 「보고 있으면 거름」(`push skipped — watching`)은 걸리지 않는다 — 누가 대상인지만 본다.

---

## 10. Gateway 를 여럿 띄울 때

멀티 Gateway 를 보거나, 사람의 dev 상태(`~/.openclaw-dev`)를 건드리지 않고 실물 Gateway 를 띄울 때 쓴다. `openclaw --help` 가 보이는 갈래는 셋이다 — `--dev`(상태 `~/.openclaw-dev`, 기본 포트 19001), `--profile <name>`(상태 `~/.openclaw-<name>` — 홈 아래라 쓰지 않는다), 그리고 환경 변수.
번들에서 읽는 이름은 `OPENCLAW_HOME`·`OPENCLAW_STATE_DIR`·`OPENCLAW_CONFIG_PATH`·`OPENCLAW_PROFILE` 등이다(`grep -rhoE 'OPENCLAW_(STATE_DIR|CONFIG_PATH|HOME|PROFILE)' <설치>/node_modules/openclaw/dist | sort | uniq -c`).
**`OPENCLAW_HOME=<디렉터리>` 하나로 상태가 `<디렉터리>/.openclaw/` 로 옮겨 간다** — `openclaw config file` 이 `<디렉터리>/.openclaw/openclaw.json` 을 낸다. 홈의 두 상태 디렉터리가 그대로인지는 설치·기동 전후 `ls -la` 해시로 본다.
⚠ Gateway 의 날짜 로그 `/tmp/openclaw/openclaw-<날짜>.log` 는 `OPENCLAW_HOME` 과 상관없이 하나를 함께 쓴다 — 시크릿 개수 확인 범위에 넣는다.

**새 상태의 Gateway 설정** — 새 상태에는 기본 에이전트 `main` 하나가 있다. `config patch` 한 번(`$SP/base.patch.json5`)으로 dev 설정과 같은 꼴로 만든다(ADR 0002 2절): `gateway.mode "local"`·`agents.defaults.model "anthropic/claude-opus-5"`·`agents.defaults.models["anthropic/claude-opus-5"].agentRuntime.id "claude-cli"`·`heartbeat.every "0m"`·`tools.agentToAgent.enabled false`·`tools.sessions.visibility "tree"`·`plugins.entries.bonjour.enabled false`·`plugins.entries.memory-core.config.dreaming.enabled false`.
```bash
G=A; P=19011                                           # 「집」은 G=B P=19021
gw() { env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH -u OPENCLAW_PROFILE \
         OPENCLAW_HOME=$SP/gw$G PATH="$OCBIN:$PATH" openclaw "$@"; }
gw config patch --file $SP/base.patch.json5          # 위 「새 상태의 Gateway 설정」
( umask 077; openssl rand -hex 24 > $SP/gw$G.token )
( env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH -u OPENCLAW_PROFILE OPENCLAW_HOME=$SP/gw$G \
    OPENCLAW_GATEWAY_TOKEN="$(cat $SP/gw$G.token)" PATH="$SP/fake$G/fakebin:$OCBIN:$PATH" \
    nohup openclaw gateway run --auth token --port $P --bind loopback >> $SP/logs/gw$G.log 2>&1 < /dev/null & echo $! > $SP/gw$G.pid )
```

- 가짜 CLI 의 답 글을 `FAKE_CLI_DONE gateway=<A·B>` 로 두면 어느 Gateway 가 답했는지 채널에서 보인다.
- `--dev` 없는 Gateway 의 CLI 호출은 모두 같은 `OPENCLAW_HOME` 으로 부른다(위 `gw`) — 빠뜨리면 홈의 기본 상태 `~/.openclaw`(원격 프로필)를 건드린다.

**붙이기** — 「절차」 절 (d)~(e) 에 더한다.
1. **Gateway 추가** — `POST /api/v1/gateways { name, url: "ws://127.0.0.1:<포트>", token }`(본문은 `jq --rawfile` 로 토큰 파일에서, 「절차」 절 (e)). 화면의 「Gateway 추가」와 같은 경로다.
2. **플러그인** — `GET /api/v1/setup/plugin.tgz`(연결 페이지 「플러그인 받기」)로 받은 파일 → **Gateway 둘을 내린 뒤** `gw plugins install <받은 파일> --force --accept-capabilities` 를 Gateway 마다 → 설치본 `dist/index.js` sha 를 대조.
3. **브리지 토큰** — Gateway 마다 `POST /api/v1/gateways/<id>/bridge-tokens` → 응답의 `pluginConfig` 를 0600 파일로 → `gw config patch --file …` → 파일 삭제 → Gateway 를 다시 띄운다.
4. **에이전트** — 화면 「에이전트 가져오기」에서 Gateway 「사무실」의 `main` 을 핸들 `main` 으로, 「집」의 `main` 을 핸들 `main-home` 으로. 채널 하나에 둘 다 넣는다(`POST /channels/:id/members`).
5. **멘션·끄기·삭제** — `wire-cli send` 로 `@main`·`@main-home` 을 각각, 「집」 Gateway 프로세스를 내린 채(`kill <PID>`) 둘을 다시, 「집」을 다시 띄운 뒤 run_error 카드 「다시 실행」(`wire-cli interact … retry_run`), 연결 페이지 「사무실 끄기」 뒤 둘을 다시, 다시 켠 뒤 「집」 삭제·옮기기.
- 웹을 얹을 때 브라우저는 독립 Chromium(Playwright `chromium.launch`)이 낫다 — 쿠키는 포트를 가리지 않아 다른 포트의 `localhost` 로그인이 neo 에 살아 있는 다른 `localhost` 인스턴스의 세션 쿠키를 덮는다(`docs/guideline/browser/04-shared-profile.md`). 로그인 토큰을 스크립트가 파일에서 읽어 화면·도구 입력에 싣지 않으려고도 그렇다.

---

## 11. Claude 러너 런 0회 하네스 — 번들 CLI + 가짜 Messages API

러너 어댑터는 번들 CLI 에 `ANTHROPIC_BASE_URL`(로컬 가짜 Messages API)·가짜 API 키·스크래치 `CLAUDE_CONFIG_DIR` 을 주어 모델 없이 실제 요청 본문과 권한·도구·interrupt 흐름을 두드린다(ADR 0007 「다시 재는 법」).
**실제 서버** + **실제 러너**(서버가 내려준 tgz 를 `npm install -g` 한 설치본) + **실제 번들 CLI**(SDK 가 찾는 그 바이너리)를 끝까지 돌린다. 가짜는 모델 자리의 `packages/claude-runner/scripts/fake-messages-api.ts` 하나다.
러너의 로컬 설정은 **천장(허용 루트·프로그램·권한 상한)만** 쥐고, 프로젝트·러너 에이전트는 앱(REST — 화면과 같은 경로)에서 만든다.
러너·SDK·CLI 판본을 올렸을 때, 러너의 `buildQueryOptions`·천장·경로 가림·권한·도구·중지를 고쳤을 때, 그리고 **모델 런으로 도는 러너 실연 전에** 한 번 돌린다.
**CLI `cwd`·절대 경로 기준(아래 「합격 기준」 1·11)은 러너 일반화 스펙 완료 기준 1·4 의 유일한 실물 근거다** — 통합 시나리오(`apps/server/test/integration/runner-projects.test.ts`)는 가짜 러너라 서버 경계까지만 증명한다.

### 구성

| 항목 | 값 |
| --- | --- |
| 서버 | 기동 전에 `pnpm -F @dodok/claude-runner pack:runner` — 서버는 부팅 때 `packages/claude-runner/dist` 의 tgz 를 잰다. `PORT=<포트> APP_ORIGIN=http://localhost:<웹 포트> LOG_LEVEL=debug pnpm -F @dodok/server dev:fake`(웹은 띄우지 않아도 된다) — dev:fake 의 가짜 러너 둘은 `POST /__devfake/runner {"connected":false}`·`{"connected":false,"runner":"limited"}` 로 내린다. 또는 스크래치 `DATA_DIR` 의 소스 실행 서버(「절차」 절 (d) 끝 줄) |
| 러너 | owner 로 `POST /api/v1/setup/runner-tokens` → 원문은 스크래치 `home/.dodok-runner/token`(0600)에만, 응답의 토큰 id 가 러너 id 다 → `GET /api/v1/setup/runner.tgz` → `npm install -g --prefix <스크래치>/runner <받은 tgz>` → 아래 감싸개 → `env -i PATH=<스크래치>/runner/bin:<node bin>:/usr/bin:/bin HOME=<스크래치>/home LANG=en_US.UTF-8 TMPDIR=<스크래치>/tmp SHELL=/bin/bash USER=$USER dodok-runner --config <스크래치>/runner-config.json`. 첫 줄 `dodok-runner <판> · Claude Agent SDK <판> · Claude Code <판> · 루트 src(smoke-src) · 프로그램 claude · 동시 1` |
| 러너 설정 | 아래 JSON. `serverUrl` 은 서버 오리진을 직접 적는다 — 발급 응답의 `runnerConfig.serverUrl` 은 공개 주소(`BRIDGE_PUBLIC_URL`)에서, 없으면 `APP_ORIGIN`(dev 에서는 웹 오리진)에서 만든다. `tokenFile` 은 스크래치 `HOME` 기준 |
| 루트·작업 파일 | 루트 `<스크래치>/roots/src` 안에 `proj-a`(커밋 하나 있는 git 저장소)·`proj-b`(일반 디렉터리), 루트 밖 `<스크래치>/outside/elsewhere`. `proj-a` 안 `hx-out.txt`, 루트 밖 `<스크래치>/hx-outside.txt`, 사람 이미지 8×8 PNG |
| 가짜 API | `node packages/claude-runner/scripts/fake-messages-api.ts --port <포트> --out <스크래치>/api` — 대본 키워드는 그 파일 머리 주석의 표. 요청마다 `requests.jsonl` 한 줄과 본문 `NNN.json` |

```json
{
  "serverUrl": "http://127.0.0.1:<서버 포트>",
  "tokenFile": "~/.dodok-runner/token",
  "maxConcurrentRuns": 1,
  "roots": [{ "id": "src", "path": "<스크래치>/roots/src", "label": "smoke-src" }],
  "browse": true,
  "programs": { "claude": { "configDir": "<스크래치>/cfg", "maxPermissionMode": "acceptEdits" } }
}
```

옛 꼴(작업 디렉터리를 러너 설정의 `agents` 에 적던 판)은 러너가 `dodok-runner: 에이전트는 이제 앱에서 만듭니다 — 설정에서 agents 를 지우고 roots 를 적으세요` 로 거절하고 exit 1 이다(서버에 붙지 않는다).

**번들 CLI 감싸개.** 러너의 env 허용 목록(`packages/claude-runner/src/drivers/claude/run.ts` 의 `ENV_ALLOWLIST`)은 `ANTHROPIC_*` 를 CLI 로 넘기지 않는다(ADR 0007 「함정」 — 러너 env 가 CLI 로 새지 않게). 그래서 가짜 API 주소는 러너가 아니라 **스크래치 설치본의 번들 CLI 자리**에 얹는다. SDK 는 `@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude` 를 찾아 그대로 spawn 하므로, 진짜 바이너리를 `claude.real` 로 옮기고 그 자리에 셸 조각을 둔다 — **이 설치본의 CLI 는 로컬 주소 없이는 뜨지 않는다.** 기록 줄의 `cwd` 가 CLI 가 뜬 디렉터리다(합격 기준 1).

```sh
B=<스크래치>/runner/lib/node_modules/@dodok/claude-runner/node_modules/@anthropic-ai/claude-agent-sdk-$(node -p 'process.platform+"-"+process.arch')
mv "$B/claude" "$B/claude.real"
cat > "$B/claude" <<SH
#!/bin/sh
echo "\$(date -u +%FT%TZ) pid=\$\$ cwd=\$(pwd -P) argv=\$*" >> <스크래치>/logs/cli-invocations.log
exec /usr/bin/env ANTHROPIC_BASE_URL=http://127.0.0.1:<가짜 API 포트> ANTHROPIC_API_KEY=sk-ant-fake-harness-0000 \\
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1 \\
  ENABLE_TOOL_SEARCH=true "$B/claude.real" "\$@"
SH
chmod +x "$B/claude"
```

- `ENABLE_TOOL_SEARCH=true` — 가짜 키 모드는 도구 검색이 꺼져 있어 지연 로드를 볼 수 없다(ADR 0007 「함정」의 SDK MCP 도구 지연 로드). 켜야 `alwaysLoad` 를 잰다.
- 러너 전용 로그인(`~/.dodok-runner/claude`)은 쓰지 않는다 — `HOME` 도 `CLAUDE_CONFIG_DIR` 도 스크래치다. 가짜 키라 CLI 의 `apiKeySource` 는 `ANTHROPIC_API_KEY` 이고 런 비용은 `costKind: "api"` 로 온다.
- CLI 는 기동마다 `HEAD <ANTHROPIC_BASE_URL>/api/hello` 를 한 번 보낸다(연결 확인). 가짜 API 는 404 로 답하고 CLI 는 그대로 진행한다.

### 앱에서 프로젝트·러너 에이전트 만들기

`api` 는 세션 토큰을 `-K -` 로 싣는 `curl`(「시크릿 규칙」)이다 — `T` 는 「절차」 절 (e) 처럼 `wire-cli login` 뒤 세션 캐시에서 읽는다(`dev:fake` 면 로컬 토큰 `dev-fake-local-token`).

```bash
api() {  # api <METHOD> <경로> [json]
  if [ -n "$3" ]; then printf 'header = "authorization: Bearer %s"\n' "$T" | curl -s -K - -X "$1" -H 'content-type: application/json' --data-binary "$3" "http://127.0.0.1:$PORT$2"
  else printf 'header = "authorization: Bearer %s"\n' "$T" | curl -s -K - -X "$1" "http://127.0.0.1:$PORT$2"; fi
}
api GET /api/v1/runners | jq -c '.runners[] | {id, name}'                              # 러너 id(= 러너 토큰 id) — 러너가 붙어 있어야 둘러보기·프로젝트 더하기가 된다
api POST /api/v1/runners/$RID/projects '{"rootId":"src","relPath":"proj-a"}'           # → 프로젝트 id. 루트 밖은 400 outside_root, 없는 곳은 400 not_found
api POST /api/v1/agents '{"provider":"runner","runnerProjectId":"<프로젝트 id>","program":"claude","handle":"hx","name":"hx","model":"sonnet","permissionMode":"acceptEdits","basePrompt":"HX-INSTR-ALPHA: 답은 한 줄로."}'
api POST /api/v1/channels/$CH/members '{"memberType":"agent","memberId":"<에이전트 id>"}'
```

- 러너 에이전트는 만들 때부터 그 프로젝트의 러너 토큰에 묶인다. `permissionMode` 를 빼면 `default`, `allowedTools` 를 빼면 상한 안에서 프로그램 기본이다. 러너의 `maxPermissionMode` 를 넘는 값은 400 `{field: "permissionMode"}` 다.
- `curl -X DELETE` 에 `content-type: application/json` 을 붙이고 본문을 비우면 400 이다(빈 JSON 본문) — `api DELETE …` 처럼 그 머리 없이 부른다(러너 토큰 폐기 등).

**러너 설정을 바꿔 띄우기** — 「머신 주인이 설정을 바꿈」은 설정 파일 사본을 `jq` 로 만들고 러너를 SIGTERM 으로 내린 뒤 그 사본으로 다시 띄운다: `.programs.claude.maxPermissionMode="default"`(상한 낮춤)·`.roots[0].id="src2"`(루트 id 바꿈)·`.programs={}`(프로그램 끔)·`. + {agents:[…]}`(옛 설정). 루트 밖은 저장한 프로젝트 디렉터리를 루트 밖을 가리키는 링크로 바꿔 만든다(되돌린 뒤 「다시 실행」).

**드라이버.** 사람 쪽(REST·wire)은 `wire-cli` 가 못 하는 것(승인 결정·중지·러너 토큰 첨부 GET)이 있어 워크트리 `data/`(ignored)에 드라이버를 두고 `pnpm -s exec tsx data/<파일>.mts <명령>` 으로 돌린다(끝나고 지운다). `socket.io-client` 로 `auth: {token: <세션>, protocol: 1}`, 이벤트는 스크래치 `wire.jsonl` 에 받은 시각과 함께. 멘션·「다시 실행」만이면 `wire-cli send`·`interact … retry_run` 으로 된다.

| 명령 | 하는 일 |
| --- | --- |
| `setup` | owner 로그인(`POST /api/v1/auth/local`) → 가짜 러너 끄기 → 러너 토큰 발급(원문은 토큰 파일에만) → tgz 받기 → 채널 둘(`hx-lab`·`hx-other`) |
| `register` | 위 「앱에서 프로젝트·러너 에이전트 만들기」 — 프로젝트 → 러너 에이전트 → `hx-lab` 에 넣기 |
| `send <본문> [--conversation <id>] [--attach <id>] [--approve allow-once\|allow-always\|deny] [--abort-after <n>] [--kill-pid <pid> --kill-after <n> --kill-signal <신호>]` | 구독 → `message.send` → 런이 끝날 때까지 기록. `approval.requested` 가 오면 0.5초 뒤 `approval.resolve`, `TEXT_MESSAGE_CONTENT` 가 n개 오면 `run.abort` 또는 러너 PID 에 신호. 런이 모두 `done`·`error`·`aborted` 가 된 뒤 1.5초 더 받고 닫는다 — 중지·죽이기 뒤에 늦게 오는 메시지를 보려고 |
| `interact <messageId> <componentId> <itemId>` | `component.interact {messageId, componentId, itemId, values: {}}`(「다시 실행」) 뒤 같은 기록 |
| `upload <채널> <파일>` · `status-code <첨부 id>` | 사람 첨부 올리기 · **러너 토큰으로** `GET /runner/attachments/<id>` 의 상태·바이트 수(토큰은 파일에서 읽고 찍지 않는다) |

요청 본문은 작은 스크립트로 요약한다 — `system[]` 블록 길이, 틀 머리(`# dodok agent instructions`·`# dodok channel settings`·`# dodok direct message settings`)와 규칙·지시 표식의 개수(시스템·본문 전체), `messages[]` 블록마다 역할·종류와 표지(`UserPromptSubmit hook additional context`·`[dodok context] 이 턴의 사실`·`[dodok context] channel=`·`deferred`·`mcp__dodok__post`), `tools[]` 이름과 `defer_loading`. 요청 파일(`NNN.json`)에서 직접 `grep -F` 하면 JSON 이 따옴표를 `\"` 로 적어 속성 꼴 표식(`<channel-rules channel="…">`)이 0 으로 나온다 — `jq -r` 로 글을 꺼낸 뒤 센다.

### 합격 기준

런은 모두 `hx-lab` 의 러너 에이전트 멘션이다. 결과는 같은 주제의 리포트(「목적」 절 「지난 실연 결과」 표)에 적는다.

| # | 기준 | 어떻게 본다 |
| --- | --- | --- |
| 1 | 앱에서 더한 프로젝트 디렉터리에서 돈다(CLI `cwd`) | 감싸개 기록의 `cwd=` 가 그 프로젝트 디렉터리 · 요청 `messages[0]` 환경 블록의 `Primary working directory` · 오래 도는 런(`HX-SLOW`) 동안 `lsof -a -p <claude.real pid> -d cwd`. argv 의 `--model`·`--permission-mode` 가 에이전트 정의 그대로 |
| 2 | 시스템 프롬프트에 에이전트 지시(`<agent-instructions>`)·틀 입힌 채널 규칙이 **한 벌씩** | `system[]` 셋째 블록에 `# dodok agent instructions` → `<agent-instructions>` … → `# dodok channel settings` → `<channel-rules …>` 차례, 각 1. 지시·규칙 속 태그는 `&lt;` 로 이스케이프 |
| 3 | 규칙·지시를 바꾼 뒤 런에 새 것만 | `PATCH /channels/<CH> {"prompt":…}` 또는 `PATCH /agents/<id> {"basePrompt":…}` 뒤 다음 런은 새 `--session-id`(러너 세션을 새로 연다) + 채널 시스템 글, 요청에 새 표식 1 · 옛 표식 0 |
| 4 | `UserPromptSubmit` 훅 문맥 자리 | 프롬프트 뒤의 `role: "system"` 메시지 안 `<system-reminder>UserPromptSubmit hook additional context: [dodok context] 이 턴의 사실 — … 참여자: … 자리: 채널</system-reminder>` |
| 5 | `mcp__dodok__post` 가 지연 목록에 없음(`alwaysLoad`) | `tools[]` 에 `input_schema`째 있고 `defer_loading` 없음, 「deferred tools」 블록에 없음 |
| 6 | 쓰기 Bash → 승인 카드 → 허용·거절·항상 허용 | `HX-BASH` — `approval.requested`(`kind: tool`) → 결정 → `TOOL_CALL_RESULT` → 다음 요청의 `tool_result is_error` 가 결정대로. 항상 허용이 작업 디렉터리에 `.claude/` 를 만들지 않는다(규칙이 `session` 으로만) |
| 7 | 중지 → 메시지 없는 중지 | `HX-SLOW` 델타 몇 개 뒤 `run.abort` → `RUN_ABORTED {by:"user"}`, 그 런의 에이전트 메시지 0, 남은 CLI 프로세스 0 |
| 8 | 러너를 죽이면 run_error 카드, 「다시 실행」은 같은 세션 `--resume` | 러너 PID 에 `SIGKILL` → `RUN_ERROR ADAPTER_UNAVAILABLE` + 「다시 실행」 → 러너를 다시 띄우고 누르면 새 런(`parentRunId`)이 `--resume` 으로 `done`. `SIGKILL` 은 러너가 CLI 를 멈출 틈이 없어 `claude.real` 이 고아로 남아 그 턴을 끝까지 돈다 — 「다시 실행」의 `resume` 이력에 채널에 없던 답이 실린다(`docs/guides/docker-deploy.md` 「러너 설치」 절이 `kill -9` 를 막는 까닭) |
| 9 | 서버 재시작 → 러너 재접속 | 서버 SIGINT → 러너 「서버와 끊겼습니다 …」 → 백오프 → 「연결됨」, 러너는 끝나지 않는다(종료 2 아님) |
| 10 | 첨부 — 러너가 남의 첨부 GET 404 · 파일 보내기는 작업 디렉터리 안만 | 러너 토큰 `GET /runner/attachments/<id>`: 열린 런의 트리거 첨부·자기 업로드만 200, 나머지 404(같은 응답). `HX-POST-IN` 은 채널 파일 카드, `HX-POST-OUT`(`../…`)은 도구 결과 `is_error` 「작업 디렉터리 밖을 가리킵니다」 |
| 11 | 천장 — 루트 밖·상한 넘는 권한·루트 id 바꿈·꺼진 프로그램이 `RUNNER_CEILING` 카드(「다시 실행」 포함), CLI 기동 0 | 「러너 설정을 바꿔 띄우기」의 넷 → `RUN_ERROR {code: "RUNNER_CEILING", message: path\|permissionMode\|root\|program}`, 러너 로그 「천장에 걸려 거절」 |
| 12 | 로그 위생 — 시크릿·러너 머신 절대 경로 0, 모델 런 0 | 러너 토큰·세션 토큰·로컬 토큰 파일로 `grep -a -c -F -f`, 스크래치 루트의 절대 경로(앞 `/private` 를 뗀 꼴 포함)로도 같게 — 서버 로그·DB(`sqlite3 -readonly .dump` 와 파일 바이트)·러너 로그·wire 기록·REST 응답 전부 0, 양성 대조(토큰 파일·러너 설정 자신) ≥1. CLI 기동 수 = 감싸개 기록 줄 수(모두 `ANTHROPIC_BASE_URL=http://127.0.0.1:…`) = 런 수 |

### 절차 메모

- 가짜 API 의 대본은 **마지막 비시스템 메시지**의 도구 결과로 턴을 끝낸다. CLI 는 도구 결과 뒤에도 `role: "system"` 메시지(`<system-reminder>`)를 붙이므로 맨 끝 메시지만 보면 도구 결과를 못 보고 같은 도구를 다시 내 — 승인이 끝없이 되풀이된다(드라이버의 자동 허용과 만나면 수십 번 돈다). 대본을 고칠 때 이 자리를 지킨다.
- 러너 세션을 새로 열어도(규칙·지시 변경) 앞 세션 전사는 러너의 `configDir/projects/<cwd 경로>/` 에 남는다 — 스크래치 `cfg/` 를 지울 때 함께 지운다.
- 러너 표준 오류에 **런마다** SDK 경고 `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] canUseTool will not be invoked for: …`(`mcp__dodok__post` 와 제어 도구를 늘어놓는 한 줄)가 찍힌다 — 의도한 미리 허용이라 해롭지 않다.
- 러너를 `SIGTERM`(또는 `Ctrl+C`)으로 끄면 도는 런을 멈추고 끝난다 — 그 런은 `ADAPTER_UNAVAILABLE` 카드와 「다시 실행」으로 닫힌다(`docs/guides/docker-deploy.md` 「러너 설치」 절의 「끄기」).
- hello 의 프로그램 `auth` 는 로그인 디렉터리(`configDir`)가 있는지만 본다(자격 증명을 읽지 않는다) — 스크래치 `cfg/` 면 「로그인 모름」(`unknown`)이 정상이다.
- 러너 전용 로그인(`~/.dodok-runner/claude`)·사람의 `~/.claude` 는 읽지도 쓰지도 않는다 — `HOME` 도 `configDir` 도 스크래치다. 가짜 키라 CLI 의 `apiKeySource` 는 `ANTHROPIC_API_KEY` 이고 런 비용은 `costKind: "api"` 로 온다.
- **정리** — 러너(SIGTERM)·가짜 API·서버를 자기 PID 로 내리고 포트 LISTEN 0, 남은 `claude.real`·`dodok-runner`·`fake-messages-api` 프로세스 0 을 본다. 스크래치(러너 설치본·감싸개·`HOME`(토큰)·`cfg/`(세션 전사)·루트·요청 본문·로그)와 워크트리 `data/`(드라이버·세션)·`packages/claude-runner/dist` 를 지운다.

### 모델 런으로 도는 러너 실연

이 절의 하네스를 먼저 끝까지 돌린 뒤에 한다. 모델 런은 사용자가 승인한 상한 안에서 센다(러너가 연 `query()` 하나 = 1회 — 릴레이·카드 누르기가 만드는 러너 런도 센다).
- **감싸개를 두지 않는다**(실제 API). 프로그램의 `configDir` 는 러너 전용 로그인 `~/.dodok-runner/claude`(`docs/guides/docker-deploy.md` 「러너 설치」 절의 로그인)이고, 러너 env 의 `HOME` 은 실제 홈이다(키체인 로그인을 찾게 — ADR 0007 「질문별」 인증).
- OpenClaw 모델 런을 0 으로 지키려면 OpenClaw 쪽은 `dev:fake` 의 가짜 Gateway·에이전트로 둔다. 가짜 `dev` 는 부른 에이전트를 늘 되부르므로 채널 `relayPolicy.maxRelayTurns` 를 1 로 둬 러너 런이 더 생기지 않게 한다.
- 운영 화면의 러너 런 비용(구독이면 「환산 포함」)을 같이 본다.

### 모델 런으로만 재는 것

하네스·`dev:fake` 가 원리상 못 재는 것이라 다음 모델 런 실연 때 같이 본다(각 줄 끝이 근거 자리).

- 실제 모델로 두 `main` 의 대화가 섞이지 않는지 — `docs/superpowers/reports/2026-10-05-multi-gateway-live-smoke-report.md` 「21.6 사람이 볼 것」.
- 실제 모델이 반응 블록을 요청이 아니라 사실로 읽는지 — `docs/guides/plan.md` 8장 리액션 줄 「실제 모델이 그 블록을 요청이 아니라 사실로 읽는지는 모른다」.
- 실제 모델이 읽은 글 속 지시를 따르지 않는지, 「결과를 모릅니다」를 받고 같은 요청을 되풀이하지 않는지 — `docs/superpowers/reports/2026-10-13-control-mcp-live-smoke-report.md` 「25.5 사람이 볼 것」.
- 러너 DM 틀(「주인이 설정 화면에서 정해 둔 설정」)을 모델이 주입으로 읽지 않고 따르는지 — `docs/guides/plan.md` 8장 이월 「러너 DM 틀을 모델이 따르는지 모른다」.
- 실제 모델이 `<agent-instructions>` 틀을 따르는지 — `docs/guides/plan.md` 8장 이월 「실물로 못 본 것」(러너 일반화 줄).
- 진짜 claude 세션 전사로 `--resume` 이 이어지는지(같은 스레드 둘째 턴·두 세션이 섞이지 않는지) — `docs/guides/plan.md` 8장 이월 「같은 스레드 둘째 턴의 `--resume` …」·「실물로 못 본 것」(채널 세션 줄).

---

## 12. PWA·푸시(Phase 2 ④) — 푸시 확인 절차·VAPID 키 옮기기·사람이 볼 것

스펙 `docs/superpowers/specs/2026-09-23-pwa-push-design.md`(구현과 달라진 것은 11장). 「푸시 확인 절차」는 **모델 런 0회**이고 dev Gateway 도 필요 없다 — `dev:fake` 로 돈다.
실제 dev Gateway 로 에이전트 멘션 푸시를 본 결과는 `docs/superpowers/reports/2026-09-24-pwa-push-live-smoke-report.md` 다 — 「런 0회 하네스」의 가짜 CLI 가 `@owner` 를 멘션하는 답을 내게 하면 실제 FCM 경로까지 모델 없이 돈다.

### 푸시 확인 절차 (`dev:fake`, 모델 런 0회)

**띄우기** — 5173 은 이 머신의 다른 프로젝트라 웹은 5180, API 는 3100 이다.

```bash
# 서버: 실제 web-push 발송기(구독하고 트리거를 일으키면 실제 푸시 서비스로 나간다). 로그인 토큰 dev-fake-local-token
PORT=3100 APP_ORIGIN=http://localhost:5180 pnpm -F @dodok/server dev:fake
# 웹: 빌드본 preview — 프록시는 vite.config.ts 의 server.proxy 를 그대로 따른다
pnpm -F @dodok/web build
DODOK_API_ORIGIN=http://127.0.0.1:3100 pnpm -F @dodok/web exec vite preview --port 5180 --strictPort
```

- **개발 서버(`pnpm -F @dodok/web dev`)에는 서비스 워커가 없다**(스펙 11장 R4). 거기서 보려면 셸에서 `VITE_PWA_DEV=1` 을 준다(`.env` 의 값은 닿지 않는다). 개발 SW 는 미리 저장이 비어 오프라인 탐색 폴백이 없다 — 오프라인 확인은 preview 로만 된다. 같은 오리진에서 preview 와 dev 를 오갈 때의 주의는 `docs/guides/browser-verification.md` 「이 저장소에서 달라지는 것」.
- `dev:fake` 는 VAPID 주체가 기본값이라 시작 때 `VAPID subject is a local placeholder …` warn 한 줄을 찍는다 — 의도한 경고다. 키 `data/vapid.json` 은 재시작해도 그대로다(지우면 그 오리진의 구독이 모두 무효).

**브라우저 — headed 여야 한다.** 헤드리스 Chromium 은 권한을 줘도 `Notification.permission` 이 `"denied"` 로 고정된다(`Notification.requestPermission()` 결과와 `navigator.permissions.query` 는 `granted` 인데 동기 getter 만 `denied`). 앱은 동기 getter 를 보므로 헤드리스에서는 패널이 늘 「거절됨」이다.
Playwright 가 받아 둔 Chromium(`~/Library/Caches/ms-playwright`, Google Chrome for Testing — 없으면 `pnpm dlx playwright@1.62.1 install chromium` — 저장소의 playwright-core 1.62.1 과 같은 버전이어야 그 Chromium 빌드를 찾는다)을 `playwright-core`(openclaw 가 끌어오는 전이 의존성 — 브라우저를 내려받지 않는다)로 **headed** 로, `--window-position=-2400,-2400` 으로 화면 밖에 띄워 사람 화면을 가리지 않는다. 이 빌드는 Google Chrome for Testing 이라 **실제 FCM 수신까지 된다** — 시스템 Chrome 으로 갈아탈 필요가 없다. 프로필은 스크래치패드의 영구 프로필(`launchPersistentContext`)이고, 권한은 `context.grantPermissions(["notifications"], { origin: "http://localhost:5180" })` 로 준다.
⚠ **실제 FCM 을 받으려면 Playwright 기본 인자 `--disable-background-networking` 을 뺀다** — `launchPersistentContext(..., { ignoreDefaultArgs: ["--disable-background-networking"] })`. 이 플래그가 있으면 `chrome://gcm-internals` 가 `GCM Client State: LOADING`·`Connection Client Created: false` 에서 멈추고 실제 발송이 브라우저에 닿지 않는다(서버는 보낸다). 빼면 `Connection State: CONNECTED`(`mtalk.google.com`)까지 간다. 새 프로필은 처음 몇 분 동안 GCM 준비가 덜 돼 도착이 늦거나 빠질 수 있다 — 프로필을 데운 뒤 잰다.
BrowserOS neo 를 쓸 수 있으면 neo 의 CDP(`docs/guides/browser-verification.md`)에 붙여도 된다 — 권한은 `Browser.grantPermissions`, 끝나면 `Browser.resetPermissions`(「흉내 내는 법 — 자동화로 잴 수 있는 것」).

**켜기** — 로그인 → 「설정」 → 「알림」 탭 → 「푸시 알림 켜기」 → 「이 기기에서 알림을 받습니다」. 서버 행은 읽기 전용으로 본다: `sqlite3 -readonly data/dev-fake.sqlite "select user_id, substr(endpoint,1,40) from push_subscriptions"`(endpoint 는 `https://…google.com/fcm/send/…`). 브라우저 쪽 플래그는 `localStorage["dodok.push"]`(= 켠 사용자 id).

**푸시를 직접 넣기 — CDP `ServiceWorker.deliverPushMessage`**(서버·푸시 서비스를 거치지 않는다):

```js
// page 는 5180 을 연 탭, ctx 는 그 컨텍스트 (playwright-core)
const cdp = await ctx.newCDPSession(page);
const updated = new Promise((r) => cdp.once("ServiceWorker.workerRegistrationUpdated", r));
await cdp.send("ServiceWorker.enable");
const { registrations } = await updated;
const reg = registrations.find((x) => x.scopeURL === "http://localhost:5180/" && !x.isDeleted);
const push = (data) =>
  cdp.send("ServiceWorker.deliverPushMessage", { origin: "http://localhost:5180", registrationId: reg.registrationId, data });
await push(JSON.stringify({ kind: "approval", channelId: "<uuid>", title: "dodok",
  body: "#general에 승인 요청이 있습니다", url: "/c/<uuid>/activity", tag: "approval:verify-1" }));
// 뜬 알림 읽기
await page.evaluate(async () =>
  (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data })));
```

| 넣은 것 | 기대(스펙 3장·11장) |
| --- | --- |
| 위 옳은 페이로드 | `{ title: "dodok", body: "#general에 승인 요청이 있습니다", tag: "approval:verify-1", data.url: "/c/<uuid>/activity" }`, 승인이라 `renotify` |
| `not json{` | `{ title: "dodok — 새 알림", body: "", data.url: "/" }` |
| 옳은 꼴 + url `//evil.example/c/x`·`https://evil.example/…` | `data.url: "/"` |
| 옳은 꼴 + 빈 tag | 알림이 뜨고 tag `""`, `renotify` 없음(TypeError 없음) |

**서버 트리거를 실물로 — 실제 `web-push` → FCM**. `dev:fake` 키워드:

| 푸시 | 보낼 글 | 조건 |
| --- | --- | --- |
| 멘션 | `@dev 나 불러` | 답 `@owner 확인해 주세요` 가 owner 를 멘션한다. **그 채널을 보이는 탭으로 보고 있으면 오지 않는 것이 정상**(결정 2) — 다른 채널로 옮기거나 탭을 숨긴 뒤. `나 불러 느리게` 면 델타가 1.5초 간격이라 옮길 시간이 난다 |
| 승인 요청 | `@dev 승인` · `승인 둘`(두 건, tag 가 달라 둘 다 뜬다) · `승인 항상` | 같음. 푸시가 켜진 기기는 탭 안 승인 알림(`new Notification`)이 0회여야 한다(결정 8) |
| 릴레이 한도 | `@dev @fin 시작` | 채널에 dev·fin 둘 다. 채널 설정에서 릴레이 턴 상한을 1 로(`PATCH /channels/:id {relayPolicy:{maxRelayTurns:1, allowPairs:"all"}}`) 하면 곧바로 닿는다 |

도착은 `registration.getNotifications()` 로 본다. 알림 본문에 메시지 본문·툴 인자가 없는 것, 서버 로그에 `p256dh`·비밀 키·알림 문구·`fcm/send` 가 없는 것도 같이 본다.
**걸렀다·보냈다·보냈는데 안 왔다를 가르는 법** — `LOG_LEVEL=debug` 면 디스패처가 거를 때 `push skipped — watching`(`userId`·`channelId`·`kind`), 푸시 서비스가 받으면 `push sent`(`subscriptionId`·`transport`·`result`)를 한 줄씩 남긴다(HTTP 상태는 디스패처 줄에 없다 — 통로가 거절·실패를 받았을 때만 그 통로가 `statusCode` 와 고정 문구 `reason` 을 warn 으로 남긴다: `push send failed`(warn)·`push rejected`(error)). 이 두 줄과 `chrome://gcm-internals` 의 Receive Message Log 로 가른다. `dev:fake` 도 `LOG_LEVEL` 을 따른다(없으면 `info`) — `LOG_LEVEL=debug pnpm -F @dodok/server dev:fake`.
**탭을 닫으면** 브라우저가 웹소켓을 곧바로 닫고(vite preview 프록시도 늦추지 않는다), 웹은 `pagehide` 에서도 「안 보임」을 보낸다 — 닫은 직후의 트리거도 걸러지지 않는다. 남는 최대 45초 창(engine.io 핑 25s+20s)은 close 가 서버에 가지 않는 경우 — 네트워크 단절·절전·프로세스 멈춤 — 뿐이다(스펙 10장 트레이드오프).
⚠ 자동화 브라우저를 강제 종료(kill)하며 여러 번 붙으면, 죽은 소켓이 ping 제한까지 presence 에 남아 「보고 있음」으로 한 번 더 걸러질 수 있다. 헷갈리면 서버를 `--keep` 으로 다시 띄워 presence 만 비운다.

**알림 누르기** — 헤드리스·CDP 로는 시스템 알림을 누를 수 없고, 서비스 워커 안에서 `new NotificationEvent("notificationclick", …)` 를 합성하면 `waitUntil` 이 `InvalidStateError` 로 던진다(신뢰되지 않은 이벤트). 서비스 워커 컨텍스트(`ctx.serviceWorkers()[0].evaluate`)에서 신뢰된 클릭에만 허용되는 셋 — `ExtendableEvent.prototype.waitUntil`·`WindowClient.prototype.focus`·`clients.openWindow` — 만 기록하는 것으로 대신 풀고, 나머지(창 고르기·`postMessage`·앱의 라우터 이동)는 빌드본 그대로 돌린다.
기대: 다른 채널에 열린 창이 앞으로 오고(`focus` 1회, `openWindow` 0회) **새로고침 없이** 그 채널 활동 탭으로 옮겨 간다(누르기 전 심은 `window.__marker` 가 남는다). 창이 없으면 `openWindow("/c/<id>…")` 1회. **OS 창이 실제로 앞으로 오는지는 「사람이 볼 것」 — 사람이 본다.**

**오프라인** — Playwright `context.setOffline(true)` 뒤 새로고침하면 `navigator.onLine` 이 `true` 로 돌아온다(CDP `Network.emulateNetworkConditions` 도 같다). 그 판은 「브라우저는 온라인인데 서버에 안 닿는」 경우라 배너가 me 재시도 뒤 약 3초에 뜬다.
「기기가 처음부터 오프라인」은 초기화 스크립트로 `navigator.onLine` 을 `false` 로 두고 모든 요청을 막아 흉내 낸다 — 기대는 API 요청 0·토스트 0·배너 1. 실제 비행기 모드는 「사람이 볼 것」.

**정리** — 등록한 서비스 워커·캐시·IndexedDB(`keyval-store`)를 지우고, 푸시 구독을 해지하고(「끄기」 또는 `getSubscription()?.unsubscribe()`), 컨텍스트를 닫고 프로필 디렉터리를 지운다. 3100·5180 을 내리고 LISTEN 0 을 확인한다(5173 은 그대로). 워크트리에서 띄웠으면 `dev:fake` 가 만든 워크트리 `data/` 를 지운다. **최상위 `data/vapid.json` 은 지우지 않는다** — 개발자의 키다.

### 원격 배포에서 VAPID 키 옮기기

서버는 키를 두 곳 중 하나에서 얻는다(`apps/server/src/modules/push/vapid.ts`). **환경변수 `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY` 가 둘 다 있으면 그것**, 아니면 `<DATA_DIR>/vapid.json`(`{"publicKey","privateKey"}`, 없으면 처음 부팅 때 만들고 0600). 한쪽 환경변수만 주면 없는 것으로 보고 파일을 쓴다.

**키를 바꾸면 모든 기기의 푸시 구독이 무효가 된다.** 구독은 만들 때의 공개키에 묶여 있어서다. 옮길 때는 같은 키를 그대로 가져간다:

- **파일로** — 옛 서버의 `data/vapid.json` 을 새 서버의 `DATA_DIR` 로 복사하고 `chmod 600`. 환경변수는 비워 둔다.
- **환경변수로** — 파일의 두 값을 배포의 비밀 저장소(또는 서버 호스트의 `.env`)에 `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY` 로 넣는다. 둘 다 있으면 파일은 읽지도 만들지도 않는다. 비밀 키는 로그에서 가린다(`VAPID_PRIVATE_KEY`·`privateKey`). 「시크릿 규칙」대로 `data/`·`.env` 에만 두고 커밋하지 않는다.
- ⚠ `data/` 를 새로 만든 채(파일도 환경변수도 없이) 부팅하면 **새 키가 조용히 생긴다** — 그 순간 옛 구독은 모두 무효다. 망가진 파일은 덮어쓰지 않고 부팅을 멈춘다(「지우면 새로 만들지만 모든 푸시 구독이 무효가 된다」).
- 키가 바뀐 뒤: 앱을 다시 연 기기는 동기화(`syncPushSubscription`)가 서버 공개키와 구독의 키를 비교해 새로 구독한다(푸시를 켠 그 사용자로 로그인해 있을 때). 앱을 열지 않은 기기는 그때까지 못 받는다. 옛 구독으로 보낸 발송의 응답 코드가 무엇인지(404·410 이면 행이 지워지고, 403 이면 행을 남기고 `push rejected` error)는 재지 않았다.

**`VAPID_SUBJECT` 는 실제 연락처로** — `mailto:ops@example.com` 또는 `https://…`(`mailto:`/`https://` 뒤에 공백 없는 값이 있어야 한다 — 아니면 설정 오류로 부팅하지 않는다). 기본값 `mailto:dodok@localhost` 는 개발용이다.
주체의 호스트가 `localhost`·`127.0.0.1`·`*.local` 이면 **Apple Push(Safari·iOS)가 `403 BadJwtToken` 으로 거부한다**(web-push#947·#988) — 서버는 시작 때 warn 한 줄을 남기고, 발송 403 은 구독을 지우지 않고 error 를 남긴다(키·주체 문제라 구독 탓이 아니다). FCM(Chrome) 은 로컬 주체로도 받는다.
실기기에는 HTTPS 배포가 필요하다 — 서비스 워커·푸시는 보안 출처에서만 돈다(`localhost` 는 예외). 배포는 `docs/guides/docker-deploy.md`.

### 사람이 볼 것 (자동화가 원리상 못 잰 것)

`dev:fake` + 빌드본 preview(「푸시 확인 절차」)면 된다(모델 런 0회). 브라우저는 사람이 쓰는 데스크톱 Chrome 이고, 알림 권한은 **출처별**이라 `http://localhost:5180` 으로 연다.

| # | 볼 것 | 어떻게 | 통과 기준 |
| --- | --- | --- | --- |
| 1 | **실제 OS 알림 클릭** | 푸시를 켜고 작성기에 초안을 조금 쓴 뒤, 그 창을 **다른 채널에 두거나 최소화**한다 → 다른 브라우저 프로필이나 `pnpm wire-cli` 로 에이전트가 있는 채널에서 `@dev 승인` → macOS 알림 센터의 dodok 알림을 누른다 | 그 브라우저 창이 **앞으로 오고** 그 채널 활동 탭(`/c/<id>/activity`)으로 옮겨 간다. 작성기에 써 둔 초안이 남아 있다(새로고침이 아니다) |
| 2 | **창이 없을 때 클릭** | dodok 탭을 모두 닫고(브라우저는 켜 둔 채) 다른 프로필이나 `pnpm wire-cli` 로 `@dev 나 불러` 를 보내 알림을 누른다 | 새 창이 그 채널(`/c/<id>`)로 열린다 |
| 3 | **「앱 설치」를 끝까지** | 「설정」 → 「알림」 탭(`/settings/notifications`)의 「앱 설치」 → OS 설치 대화상자 → 설치 | 설치된 앱이 독립 창(standalone)으로 뜨고, 탭의 「앱 설치」 버튼이 사라진다. 설치된 창에서도 1 이 된다 |
| 4 | **macOS 알림 모양** | 1·2 의 알림을 본다. 알림이 뜬 채 화면을 잠근다 | 제목 `dodok`, 본문은 누가·어디·무엇뿐(「@dev가 #<채널>에서 불렀습니다」·「#<채널>에 승인 요청이 있습니다」·「#<채널>의 에이전트 대화가 한도에 닿았습니다」). 아이콘이 dodok 아이콘이다. 잠금 화면에도 메시지 본문·툴 인자가 없다 |
| 5 | **가려진 창 경계** | 같은 채널을 연 창을 다른 창 뒤로 **일부만** 가리거나 포커스만 빼고 → 그 채널에서 `@dev 승인` | 기록한다: 푸시도 탭 안 알림도 안 뜨는가. 창이 `visible` 이면 서버가 걸러 알림이 아무 데도 안 뜰 수 있다 — `docs/guides/plan.md` 8장 「이월」(판단 필요) |
| 6 | **실제 기기 오프라인** | 앱을 한 번 연 뒤 Wi-Fi 를 끄고(비행기 모드) 앱을 새로 연다 → 다시 켠다 | 곧바로 배너 「오프라인 — 저장된 내용을 보여 줍니다」와 최근 채널, 토스트 없음, 보내기 막힘. 다시 연결되면 배너가 사라진다 |
| 7 | **iOS·안드로이드 실기기** | HTTPS 배포 뒤 | iOS 16.4+ 는 홈 화면에 추가한 앱에서만(패널 「홈 화면에 추가하면 알림을 받을 수 있습니다 — …」). `VAPID_SUBJECT` 가 실제 연락처여야 Apple 이 받는다(「원격 배포에서 VAPID 키 옮기기」) |

「사람이 눈·귀로 확인할 것」 절의 탭 안 승인 알림(「승인 필요 — @dev 가 Write 를 실행하려 합니다」)은 **이 기기에 푸시가 켜져 있으면 쉰다**(결정 8). 빌드본 preview 에서 그 절을 볼 때는 「푸시 알림 켜기」로 권한을 허용한 뒤 「끄기」를 누른다 — 권한은 `granted` 로 남고 플래그가 지워져 탭 안 알림이 돈다. dev 서버(서비스 워커 없음)에서는 「푸시 알림 켜기」가 권한만 받고 10초 뒤 「서비스 워커가 준비되지 않았습니다」로 끝난다 — 「끄기」 버튼은 생기지 않고, 플래그가 없으므로 그대로 탭 안 알림이 돈다. 「알림 켜기」는 「설정」 → 「알림」 탭에 있다(푸시를 지원하지 않는 브라우저에서만 「탭이 열려 있을 때만 알림 켜기」로 남는다).

---

## 13. 브리지 토큰 교체 — 사람이 따라 할 절차

dev 는 모든 `openclaw` 에 `--dev` 를 붙이고 상태 디렉터리가 `~/.openclaw-dev` 다. 원격 Gateway 호스트는 `docs/guides/docker-deploy.md` 「[웹 → B] 플러그인 설치·브리지 토큰」의 [B] 와 같은 자리에서 한다. 정본 절차는 `docs/guides/docker-deploy.md` 「브리지 토큰 교체」다.

1. 연결 페이지의 그 Gateway 카드 「브리지 토큰」 → 「새 토큰 발급」 → 라벨. 대화상자의 「설정 복사」로 `pluginConfig` 조각을 복사한다(원문은 이때 한 번만 보인다).
2. Gateway 호스트에서 조각을 **파일로** 저장한다 — `umask 077` 인 셸에서 편집기로 붙여 넣는다. 셸 인자·`echo` 로 넘기지 않는다(`ps`·셸 기록에 남는다).
3. `openclaw config patch --file <파일> && rm <파일>`. 조각에는 `bridgeUrl` 도 들어 있다 — 서버의 `BRIDGE_PUBLIC_URL`(없으면 `APP_ORIGIN` 에서 만든 값)이 그 Gateway 가 서버에 닿는 주소와 다르면 조각 그대로 넣으면 안 된다. 2026.9.5 는 Gateway 재기동 없이 dodok 채널만 다시 띄운다(`Change will apply without restarting the gateway.`) — 브리지가 한 번 끊겼다가 새 토큰으로 곧 붙는다. 출력이 재기동 없이 적용된다고 말하지 않으면 Gateway 를 재기동한다.
4. 연결 페이지에서 새 토큰 줄에 「지금 접속 중」이 뜨는 것을 본다. 서버 로그로는 가를 수 없다(`"bridge plugin hello"` 에 tokenId 가 없다) — 화면이나 `GET /api/v1/setup/status` 의 `gateways[].bridge.plugin.tokenId` 로 본다.
5. 옛 토큰 줄 「폐기」. 지금 연결은 끊기지 않는다. 옛 토큰으로 붙는 것은 그 뒤로 `UNAUTHORIZED` 다.

---

## 14. 바깥 MCP 클라이언트 손 확인 — `claude mcp`

제어 MCP(`POST /mcp` + 개인 토큰 `dpt_`)에 실제 Claude Code 를 붙여 본다. 스크래치 `HOME`·`CLAUDE_CONFIG_DIR` 로(사람의 Claude 설정을 건드리지 않게), 「내 계정」에서 발급한 토큰을 0600 파일에 두고 붙인다. 절차·토큰 규칙은 `docs/guides/docker-deploy.md` 「제어 MCP — 바깥 클라이언트의 `/mcp`」 절.

```bash
env HOME=<스크래치>/home CLAUDE_CONFIG_DIR=<스크래치>/cfg claude mcp add --transport http dodok http://localhost:<포트>/mcp --header "Authorization: Bearer $(cat <토큰 파일>)"
env HOME=<스크래치>/home CLAUDE_CONFIG_DIR=<스크래치>/cfg claude mcp list      # dodok: … (HTTP) - ✔ Connected
```

- `add` 는 머리를 `"Authorization": "[REDACTED]"` 로 찍는다. ⚠ `claude mcp get dodok` 은 `Authorization: Bearer dpt_…` 를 **원문으로** 찍는다 — 전사에 남는 자리에서 부르지 않는다.
- **틀린 토큰**이면 `list` 가 `✘ Failed to connect — Server rejected the configured Authorization header (HTTP 401) …`(본문 `{"code":"UNAUTHORIZED",…}`)이고 OAuth 흐름(`/.well-known/oauth-protected-resource`)으로 빠지지 않는다 — 서버 요청 기록에 `/.well-known` 요청이 없어야 한다.
- 연결 첫 요청 `server/discover` 가 400 「Unsupported protocol version」이어도 정상이다 — 클라이언트가 곧바로 `initialize` 로 물러선다.
- 도구 호출은 모델 없이 공식 SDK 클라이언트(`@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`, 서버가 쓰는 같은 판)로 — `listTools`·`callTool list_channels`·`callTool update_channel` → 채널 시스템 글 「@<사람> 가 MCP 로 …」·운영 사건 `control_change`(detail `via: "pat"`).

---

## 15. `llms.txt` 안내서 따라 하기

`GET /llms.txt` 의 두 절(「OpenClaw Gateway 호스트」·「러너 머신」)을 노드 자리에서 **명령 그대로** 돌려 안내서가 맞는지 본다 — 모델 런 금지면 실제 AI 에게 건네지 않고 실연자가 AI 가 할 일을 손으로 대신한다. 사람의 dev 상태와 `.env` 를 건드리지 않게 Gateway 상태(「Gateway 를 여럿 띄울 때」)·노드 홈·서버 DB 를 스크래치에 새로 만든다.

1. **토큰** — owner 로그인(`POST /api/v1/auth/local`, 본문은 `jq --arg` 로) → `POST /api/v1/gateways`(본문은 Gateway 토큰 파일에서 `jq --rawfile`) → `POST /api/v1/gateways/<id>/bridge-tokens` → 원문을 `jq -r .token` 으로 0600 파일에만. 러너 토큰(`POST /api/v1/setup/runner-tokens`)도 같게. owner 세션 토큰은 `curl -K -` 로만 싣는다(「시크릿 규칙」).
2. **「AI 에게 맡기기」 한 줄** — 웹의 `llmsHandoffLine`(토큰 자리만 바꿔 실행)이 만드는 줄은 `<오리진>/llms.txt 를 읽고 「OpenClaw Gateway 호스트」 절대로 이 호스트에 dodok 플러그인을 설치해 줘. 브리지 토큰: <원문>`(러너는 「러너 머신」·「러너 토큰:」)이다 — 안내서 주소의 오리진은 연결 상태 `bridge.publicUrl` 의 오리진이다.
3. **두 절** — 각 bash 블록을 글자 그대로 `bash -c` 로 돌린다. 토큰 한 줄은 첫 블록의 표준 입력으로만 넣는다. 사람 몫인 「Gateway 를 내린다·올린다」는 그 호스트의 방식(LISTEN 하는 PID 에 `kill`, 「Gateway 를 여럿 띄울 때」 꼴의 `nohup … gateway run`)으로 한다. 러너 절의 전경 명령은 뒤에서 띄우고 출력의 `연결됨` 을 기다린다. 블록을 꺼내고 노드 자리에서 돌리는 꼴:
   ```bash
   SP=$(mktemp -d); mkdir -p $SP/home $SP/npm-global $SP/blocks
   curl -fsS http://127.0.0.1:$PORT/llms.txt > $SP/llms.txt
   # 절 하나의 ```bash 블록을 차례대로 $SP/blocks/<접두>-<n>.sh 로 — 안내서는 블록을 세 칸 들여 쓴다
   blocks() { awk -v sec="## $1" -v out="$SP/blocks/$2" '
     /^## / { on = ($0 == sec) }
     on && /^ *```bash$/ { n++; f = out "-" n ".sh"; inb = 1; next }
     inb && /^ *```$/ { inb = 0; close(f); next }
     inb { sub(/^   /, ""); print > f }' $SP/llms.txt; }
   blocks "OpenClaw Gateway 호스트" gw; blocks "러너 머신" runner; ls $SP/blocks   # 빈 목록이면 절 제목이 바뀐 것이다
   # 노드 자리 — 안내서의 ~/…·npm install -g·$(npm root -g) 가 고치지 않은 글자 그대로 스크래치를 가리킨다(전역 설치 없음).
   # OCBIN 은 「절차」 절 머리의 스크래치 설치본, Gateway 쪽에 가짜 claude 를 앞세우려면 PATH 앞에 「가짜 claude CLI 스크립트」의 $SP/fakebin
   node_sh() { env HOME=$SP/home OPENCLAW_HOME=$SP/home npm_config_prefix=$SP/npm-global \
     PATH="$SP/npm-global/bin:$OCBIN:$PATH" bash -c "$(cat "$1")"; }
   node_sh $SP/blocks/gw-1.sh < <0600 브리지 토큰 파일>   # 첫 블록만 표준 입력에 토큰 한 줄
   node_sh $SP/blocks/gw-2.sh                             # 나머지는 차례대로 — 사람 몫 단계는 위처럼 손으로
   ```
4. 판정 — 연결 페이지의 Gateway 카드 「연결됨」·플러그인 「접속됨 · 서버와 같은 빌드입니다」, 러너 카드 「연결됨 · 서버와 같은 빌드입니다」.

---

## 16. 네이티브 푸시 손 확인 — 실제 APNs·FCM 으로 한 번 쏘기 (사람이 한다)

서버가 iOS(APNs)·Android(FCM)로 알림을 보내는 경로(`apps/server/src/modules/push/transports/`)를 실제 서비스에 한 번 태워 본다. 자동 테스트(`apps/server/test/integration/push-native.test.ts`·`push-native-android.test.ts`)는 로컬 가짜 APNs·FCM 으로만 돌고 **실제 Apple·Google 로는 한 번도 나가지 않는다** — 자격 증명이 맞는지·기기 토큰이 서버가 고른 호스트(sandbox·production)와 맞는지·알림이 기기에 뜨는지는 여기서만 안다. 모델 런은 쓰지 않는다. 자격 증명을 만드는 법은 `docs/guides/docker-deploy.md` 「네이티브 푸시 자격 증명」 절.

**왜 사람이 하나** — 실제 발송이고(받는 쪽 기기가 있어야 한다) 자격 증명(`.p8`·서비스 계정 JSON)과 기기 토큰이 있어야 한다. 에이전트는 가짜 통로만 쓴다.

**전제**

- 서버가 뜨고(`dev:fake` 가 아니어도 된다 — 실제 서버면 된다) 부팅 로그에 `push transport apns: on` 또는 `push transport fcm: on` 이 있다(없으면 그 플랫폼 등록이 `503 PUSH_UNAVAILABLE`). 로그 수준은 `LOG_LEVEL=debug` 로 두면 「보냈다」까지 보인다. 배포 서버면 `127.0.0.1:$PORT` 대신 공개 오리진(`https://<도메인>`)을 쓴다 — `wire-cli` 도 그 오리진으로 로그인하고 1번의 `jq` 키도 그 오리진이다.
- 알림을 받을 기기와 **그 기기에서 얻은 토큰·앱 id** — iOS 는 64자 hex 기기 토큰·번들 id(= `apns-topic`)·`environment`(Xcode 디버그 빌드는 `sandbox`, 배포 빌드는 `production`), Android 는 FCM 등록 토큰·패키지명. 앱 쪽 등록 흐름은 모바일 하위 프로젝트가 만든다 — 그 전에는 토큰을 앱 샘플·Xcode·`adb logcat` 에서 손으로 얻어 아래 `curl` 로 넣는다.
- 알림을 받는 사람의 세션 하나와, 멘션을 일으킬 다른 사람(또는 에이전트) — 아래 5번.

**절차**

1. 로그인해 세션 토큰을 변수로 받는다(출력하지 않는다) — 「`wire-cli`」 절의 `W login` 뒤 `data/wire-cli-session.json` 에서 읽는 「절차」 절 (e) 의 꼴 그대로:
   ```bash
   T=$(jq -r '."http://127.0.0.1:'$PORT'"' data/wire-cli-session.json)
   ```
2. 켜진 통로를 본다 — `curl -s -H "authorization: Bearer $T" http://127.0.0.1:$PORT/api/v1/push/capabilities | jq .` → `{ "webpush": true, "ios": …, "android": … }`. 쓸 플랫폼이 `true` 여야 한다.
3. 기기를 등록한다(토큰은 셸 변수에 두고 화면에 찍지 않는다):
   ```bash
   # iOS
   curl -s -H "authorization: Bearer $T" -H 'content-type: application/json' \
     -d '{"platform":"ios","token":"'"$IOS_TOKEN"'","appId":"<번들 id>","environment":"sandbox"}' http://127.0.0.1:$PORT/api/v1/push/devices
   # Android
   curl -s -H "authorization: Bearer $T" -H 'content-type: application/json' \
     -d '{"platform":"android","token":"'"$FCM_TOKEN"'","appId":"<패키지명>"}' http://127.0.0.1:$PORT/api/v1/push/devices
   ```
   성공은 `200 {"id":"…"}`. 꼴이 틀리면 `400 VALIDATION`(iOS 토큰은 64자 hex — 대문자는 소문자로 모인다, `appId` 는 영숫자로 시작하고 영숫자·`.`·`_`·`-` 만 200자까지), 그 통로가 꺼져 있으면 `503 PUSH_UNAVAILABLE`. **한 세션에는 기기 한 행만 남는다** — 같은 세션이 다른 토큰을 등록하면 앞의 것이 지워지니, 두 기기를 한꺼번에 시험하려면 세션(로그인)을 따로 쓴다.
4. 그 사용자가 **그 채널을 보고 있지 않게** 한다 — 웹이 그 채널을 보는 탭이 열려 있으면 서버가 알림을 거른다(`push skipped — watching`). 브라우저 탭을 닫거나 다른 채널로 옮긴다.
5. **다른 계정**이 그 사용자를 멘션하게 한다 — 웹에서 member 계정(또는 다른 브라우저 프로필의 다른 사람)으로 그 채널에 `@<받는 사람 핸들>` 을 쓴다. 에이전트가 도구 승인을 요청하게 해도 된다(승인 알림은 owner·admin 에게 간다). `wire-cli send` 는 1번과 같은 세션이라 쓰지 않는다 — 자기 글은 자기에게 알림이 가지 않는다(작성자 제외). 그 채널을 구독하는 소켓이라 「보고 있음」으로도 걸러진다. 알림 제목은 `dodok`, 본문은 「누가·어디」뿐이다.
6. 기기에서 알림이 뜨는지·누르면 앱이 열리는지 본다. 서버 쪽은 `docker compose … logs app | grep 'push '`(또는 소스 실행이면 서버 로그)에서 `push sent`(`debug`, `transport`·`result: ok`)를 본다.
7. 정리 — 시험이 끝나면 기기를 해제한다: `curl -s -X DELETE -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"token":"'"$IOS_TOKEN"'"}' …/api/v1/push/devices` → `204`(없는 토큰도 204).

**결과를 가르는 법**

| 로그·화면 | 뜻 | 고칠 곳 |
| --- | --- | --- |
| `push sent`(result `ok`)인데 기기에 안 뜬다 | 통로는 받았다 — 기기 쪽(알림 권한·집중 모드·앱 푸시 기능·`environment` 가 빌드와 다름) | 앱·기기 설정. APNs 는 sandbox 토큰을 production 호스트로 보내면 `BadDeviceToken` 으로 기기 행이 지워진다 |
| `push device gone — removed` | APNs 410·`BadDeviceToken`·`DeviceTokenNotForTopic`, FCM `UNREGISTERED`·404 — 토큰이 죽었거나 앱 id 가 토큰과 다르다 | 앱에서 토큰을 다시 받아 등록 |
| `push credentials rejected` + 운영 화면 사건 「푸시 자격 증명이 거부되었습니다(apns\|fcm)」 | 키·팀 id·서비스 계정이 거절됨(APNs 403, FCM 토큰 교환 400·401·403·발송 401·403) | 자격 증명 다시 만들기 — `docker-deploy.md` 「네이티브 푸시 자격 증명」 절 |
| `push rejected` | 기기 탓이 아닌 400(예: 잘린 페이로드) | 통로가 warn 으로 남긴 `statusCode`·`reason` |
| `push send failed` | 429·5xx·네트워크 — 그 알림은 버려졌다(재시도 없음) | 잠시 뒤 다시 |
| `push skipped — watching` | 그 사용자가 그 채널을 보고 있다 | 4번 |
| `push skipped — transport off` | 그 플랫폼 통로가 꺼져 있다 | 부팅 로그의 `push transport` 줄 |

**이 절차가 못 하는 것** — 알림 동작 버튼(승인 허용·거절·빠른 답장), 앱 아이콘 배지 수, 앱이 서버에 토큰을 등록하는 흐름(앱 하위 프로젝트), 중앙 푸시 중계. 결과 표는 `docs/guides/docker-deploy.md` 「사람이 한 번 따라 한 결과」 절의 「네이티브 푸시」 줄에 적는다.
