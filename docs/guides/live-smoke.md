# dev Gateway 실연(live smoke) — 서버 코어를 실제 Gateway·플러그인·모델로 한 번 돌리기

작성: 2026-09-15 (서버 코어 계획 태스크 15) · 근거: 서버 코어 스펙 9.3, ADR 0002 2절·9절, ADR 0003 2절 · 7절 2026-09-20 (웹 MVP 계획 태스크 15) · 8~9절 2026-09-21 (활동 패널·승인 계획 태스크 11) · 10절 2026-09-23 (components v1 계획 태스크 11) · 11절 2026-09-23 (c2-t14 하네스, ADR 0004) · 12절 2026-09-23 (c2-t16 고침 실물 확인) · 13절 2026-09-23 (a3-t11 첨부 실연) · 13.7 2026-09-23 (a3-t13 결함 A 고침 실물 확인) · 14절 2026-09-24 (PWA·푸시 계획 태스크 8 — p4-t7 브라우저 검증 절차) · 15절 2026-09-25 (설정 마법사 계획 태스크 7 — s2-t7 실연) · 16절 2026-09-25 (운영 보강 계획 태스크 9 — o3-t9a 실연) · 17절 2026-09-26 (스레드·검색 계획 태스크 9 — p4t-t9a 실연) · 「팀(Phase 4 ②) 실연」 절 2026-09-27 (팀 계획 태스크 8 — p4m-t8a 실연) · 「Claude 러너 런 0회 하네스」 절 2026-09-29 (Claude 러너 계획 태스크 9 — p4c-t9a) 

## 1. 목적

통합 테스트(`apps/server/test/integration/`)는 가짜 Gateway·가짜 플러그인으로 돈다. 가짜가 실물과 다르게 구는 곳(구독 범위·지연·모델 출력)은 거기서 잡히지 않는다.
이 절차는 **실제 서버 + 로컬 dev Gateway(OpenClaw 2026.9.4) + 실제 플러그인 번들 + 실제 모델(claude-cli)** 로 시나리오 2~4·8·재접속을 손으로 한 번 돌려
지연을 재고 틀린 것을 찾는다. 모델 런은 돈이 드므로 브리프가 상한을 정한다.

2~6절은 서버 코어(Phase 1 ①, 2026-09-15 에 돌린 결과가 5절)다. **웹(Phase 1 ②)을 같은 환경에 얹는 절차와 2026-09-20 에 돌린 결과는 7절**이다.
**승인(Phase 2 ①)을 실물에서 일으키는 절차는 8절** — 기본 설정에서는 승인이 한 번도 안 뜬다. **사람만 확인할 수 있는 것(소리·팝업·잠금 화면·VoiceOver)은 9절**이다.
**components v1(Phase 2 ②)을 실제 모델로 돌린 절차와 2026-09-23 결과는 10절**이다 — ❗ 모델 런 안의 `message` 툴 전송이 실물에서 깨져 있었다(10.4).
원인(2026.9.5 번들 이중 평가)과 고침은 ADR 0004, **모델 런 없이 실물 Gateway 의 모델 경로를 두드리는 하네스는 11절**, **그 하네스로 고침을 확인한 2026-09-23 결과는 12절**이다.
**첨부(Phase 2 ③)를 하네스(11.5)와 실제 모델로 돌린 2026-09-23 결과는 13절**이다 — 거기서 찾은 결함 A(최종 응답의 `MEDIA:` 줄이 스트리밍 델타로 호스트 경로를 드러냄)는 서버에서 고쳤고(a3-t12) **실물 Gateway 에서 모델 런 0회로 확인했다(13.7)**.
**PWA·푸시(Phase 2 ④)는 14절**이다 — 푸시 확인 절차(`dev:fake`, 모델 런 0회), 원격 배포에서 VAPID 키 옮기기, 사람이 볼 것. 실제 모델로 멘션 푸시를 보는 실연은 예정(14.4).
**설정 마법사(Phase 3 ②)의 「서버가 내려준 플러그인 설치 → 새 브리지 토큰으로 교체 → 옛 토큰 폐기」를 실물 dev Gateway 에서 모델 런 0회로 돌린 결과와 사람용 토큰 교체 절차는 15절**이다.
**운영 보강(Phase 3 ③)의 런 한도·「다시 실행」·끊김 사건·Gateway 버전 드리프트를 실물 dev Gateway 에서 모델 런 0회로 돌린 결과는 16절**이다.
**스레드(Phase 4 ①)의 하위 세션 — 세션 키·정본이 스레드에·delivery-mirror 누수 없음·릴레이·동시·리셋·옛 플러그인 — 을 런 0회 하네스로, `message` 툴 카드와 최종 답 억제를 모델 런 2회로 돌린 결과는 17절**이다.
**팀(Phase 4 ②) — 사람이 여럿인 채널의 에이전트 헤더 「참여자:」·자동 참여·승인 권한(member 거절·admin 결정)·승인 푸시 대상·내보내기 — 을 모델 런 0회로 돌린 결과는 「팀(Phase 4 ②) 실연」 절**이다. 그 절에 **가짜 CLI 로 모델 없이 승인을 일으키는 법**(`can_use_tool` 제어 요청)과 **로컬 푸시 받이**가 있다.
**Claude 러너(Phase 4 ③)를 모델 없이 실제 서버·러너 설치본·번들 CLI 로 두드리는 하네스와 그 결과는 「Claude 러너 런 0회 하네스」 절**이다 — 모델 자리만 로컬 가짜 Messages API 다. **모델 런으로 도는 러너 실연의 절차와 결과(규칙 변경 뒤 `resume` 이 옛 형식을 이어 쓴 것 포함)는 「Claude 러너(Phase 4 ③) 실연」 절**이다.

## 2. 전제

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI | **스크래치 디렉터리에 설치한 `openclaw@2026.9.5`** 를 저장소 mise Node 24.21 로 돌린다(설치·`oc` 정의는 3절 머리). `OpenClaw.app` 번들에는 CLI 가 없다 — 앱 2026.9.6(2026-09-24 자동 업데이트)의 `Resources/node-worker/*/lib/node_modules/openclaw` 는 맥 노드 워커 전용이라 `bin/openclaw`·`openclaw.mjs` 가 없고 `package.json` 의 `bin` 이 비었다. 저장소 devDependency(`2026.9.4`)는 dev 설정을 `Config was last written by OpenClaw 2026.9.5, but you are running 2026.9.4` 로 거부하므로 쓰지 않는다 — 그 메시지가 권하는 `doctor --fix` 는 dev 설정을 옛 판으로 고쳐 쓰니 하지 않는다. `gateway install`·글로벌 설치·시스템 Node 교체 금지, 설치본은 스크래치에만 두고 끝나면 지운다. ⚠ npm 의 `2026.9.5` 는 빌드 `ec9c1a1`(`gatewayBuildId` `2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z`)로, 앱 번들 9.5 의 `f396007` 과 버전 문자열은 같고 빌드가 다르다. 저장소 핀은 `2026.9.4` 그대로라 **실연 전에 `oc --version` 을 적는다**. 서버 로그로도 보인다: `"gateway connected"`·`"bridge plugin hello"` 의 `gatewayVersion`. ⚠ 같은 줄의 `pluginBuiltWithSdk`(옛 이름 `sdkVersion`)는 **빌드 때 박힌 devDependency 상수**라 9.5 위에서도 `2026.9.4` 다 — Gateway 버전으로 읽지 않는다 |
| 프로필 | **dev 만**: 모든 CLI 호출에 `--dev`(상태 `~/.openclaw-dev`). 원격 프로필 `~/.openclaw` 는 건드리지 않는다 |
| 에이전트 | `dev`·`fin`, 모델 `anthropic/claude-opus-5` + `agentRuntime claude-cli`(ADR 0002 2절) |
| 플러그인 계정 | `channels.dodok.accounts.default = { bridgeUrl: "ws://127.0.0.1:19100/bridge", token: <BRIDGE_TOKEN> }` — 스파이크 때 설정된 것을 그대로 쓴다 |
| `.env` | `OPENCLAW_DEV_GATEWAY_URL`(`ws://127.0.0.1:19001`)·`OPENCLAW_DEV_GATEWAY_TOKEN`·`BRIDGE_TOKEN` 이 있다. **`.env` 는 고치지 않는다** |
| 저장소 | Node 24.21.0 · pnpm 11.16.0, `pnpm install` 끝 |

### 시크릿 규칙

- `.env`·`~/.openclaw-dev/openclaw.json`·`~/.openclaw/openclaw.json` 은 cat·grep 하지 않는다. 값은 서브셸에서 `. ./.env` 로 **셸 변수**로만 읽고 echo 하지 않는다.
- Gateway 토큰은 env `OPENCLAW_GATEWAY_TOKEN` 으로만 넘긴다(인자 금지 — ps 에 남는다). 자식 환경에서 원격 `OPENCLAW_GATEWAY_URL` 은 뺀다.
- `config get` 은 URL 키만(`channels.dodok.accounts.default.bridgeUrl`). `config get channels.dodok` 처럼 토큰이 딸려 나오는 조회는 하지 않는다.
- `openclaw … cron` 같은 Gateway RPC CLI 는 `--url` 을 주면 `--token` 인자를 요구한다 — `--url` 대신 `--port 19001` 을 쓴다.
- 로그(`data/dev-gateway.log`·`data/phase1-live-<날짜>.log`)는 커밋하지 않지만, 옮기기 전에 토큰 값이 0번 나오는지 `grep -c -F -- "$TOK"` 로 개수만 확인한다.
- ⚠ **에이전트 자신이 시크릿을 읽을 수 있다.** dev 에이전트의 exec 는 기본 `security: "full"`(8절)이라, 일이 막히면 모델이 스스로 Bash 로 `~/.openclaw-dev/*.json` 을 뒤진다(2026-09-23 런 2).
  그 툴 결과는 **런 이벤트(`run_events.payload_json`)·프레임 덤프·claude-cli 전사**에 그대로 남고 활동 탭에도 보인다 — 그날 `BRIDGE_TOKEN` 값이 셋에 1회씩 들어갔다(10.6).
  그래서 개수 확인은 **로그만이 아니라 `data/*.sqlite`·`data/frames-*.jsonl` 까지** 한다. 들어갔으면 DB 는 가리고(값을 인자로 넘기지 않게 SQL 을 표준 입력으로) 덤프는 지운다.

## 3. 절차

아래 `oc` 는 dev Gateway CLI 를 부르는 약속이다(각 셸에서 정의). CLI 는 스크래치 디렉터리에 한 번 설치한다 — 앱 번들에는 없다(2절 표).

```bash
OCDIR=<스크래치 디렉터리>/oc     # 레포·홈 밖. 끝나면 rm -rf "$OCDIR"
npm install --prefix "$OCDIR" --ignore-scripts --no-audit --no-fund openclaw@2026.9.5
OCBIN=$OCDIR/node_modules/.bin   # openclaw → openclaw.mjs(#!/usr/bin/env node — PATH 의 mise Node 24.21 로 돈다)
oc() { env PATH="$OCBIN:$PATH" openclaw "$@"; }
oc --version                     # OpenClaw 2026.9.5 (ec9c1a1)
```

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
> 실패를 놓치면 옛 번들을 그대로 재게 된다 — **설치 뒤 위 sha 두 줄이 같은지 반드시 확인**한다(c2-t16 이 한 번 걸렸다).

### (c) dev Gateway 기동

```bash
mkdir -p data
( . ./.env    # export 하지 않는다 — 자식에는 아래 env 로 준 것만 간다
  printf '\n===== gateway start %s\n' "$(date -u +%FT%TZ)" >> data/dev-gateway.log
  env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_DEV_GATEWAY_TOKEN" OPENCLAW_CLI_BACKEND_LOG_OUTPUT=1 PATH="$OCBIN:$PATH" \
    nohup openclaw --dev gateway run --dev --auth token --port "${OPENCLAW_DEV_GATEWAY_URL##*:}" --bind loopback \
    >> data/dev-gateway.log 2>&1 < /dev/null & )
until lsof -nP -iTCP:19001 -sTCP:LISTEN -t >/dev/null; do sleep 1; done
grep -m1 'http server listening' data/dev-gateway.log
```

`OPENCLAW_CLI_BACKEND_LOG_OUTPUT=1` 은 claude-cli 의 `cli argv:`·stdout 을 로그에 남긴다(프롬프트 주입·토큰 사용량 확인용). 서버가 아직 없으니 플러그인은 `bridge: 재연결 …ms 후` 를 백오프로 찍는다(상한 10s, 지터 포함 최대 ~12s 간격).

### (d) 서버 기동

실연 전용 환경 파일을 만든다(`data/` 는 ignored). `.env` 의 dev URL·토큰·`BRIDGE_TOKEN` 은 `main.ts` 의 `process.loadEnvFile(".env")` 가 채우고, 이 파일의 값이 그 위에 얹힌다 — **이미 있는 환경 변수는 `.env` 가 덮지 않는다**.

```bash
umask 077
PORT=$(oc --dev config get channels.dodok.accounts.default.bridgeUrl | sed -E 's#^wss?://[^:/]+:([0-9]+).*#\1#')   # 계정 설정은 바꾸지 않는다
cat > data/live-smoke.env <<EOF
OPENCLAW_TARGET=dev
APP_ORIGIN=http://localhost:5173
PORT=$PORT
DB_PATH=data/live-smoke.sqlite
OPENCLAW_DEVICE_IDENTITY_PATH=
LOCAL_AUTH_TOKEN=$(openssl rand -hex 24)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
LOG_LEVEL=debug
EOF
(set -a; . data/live-smoke.env; set +a; nohup pnpm -F @dodok/server dev >> data/phase1-live-$(date +%Y%m%d).log 2>&1 < /dev/null &)
```

- `OPENCLAW_DEVICE_IDENTITY_PATH=` 는 빈 값으로 **export** 된다 — `.env` 에 원격용 경로가 있어도 덮이지 않고, 빈 값은 설정 로더가 「없음」으로 봐서 기본 `data/openclaw-device-dev.json` 이 새로 생긴다.
  루프백 + 공유 토큰이면 페어링이 자동 승인되고 `operator.admin` 까지 붙는다(ADR 0003 2절, 이번에도 첫 시도 20ms).
- 첫 부팅 로그에서 `"url":"http://127.0.0.1:<PORT>"`·`"msg":"gateway connected"`(scopes 에 `operator.admin`, `gatewayVersion`·`gatewayBuildId` 가 `oc --version` 의 `<버전> (<빌드>)` 와 같은지)를 확인한다.

### (e) 연결 확인

```bash
(set -a; . data/live-smoke.env; set +a; export DODOK_LOCAL_TOKEN="$LOCAL_AUTH_TOKEN"; pnpm -s wire-cli http://127.0.0.1:$PORT login)
T=$(jq -r '."http://127.0.0.1:'$PORT'"' data/wire-cli-session.json)   # 출력하지 않는다
curl -s -H "authorization: Bearer $T" http://127.0.0.1:$PORT/api/v1/adapter/status
# {"statuses":[{"provider":"openclaw","gateway":"connected","bridge":"connected"}],"capabilities":{"openclaw":{"sessionReset":true,…}}}
# 어댑터마다 statuses 한 줄 — 러너 어댑터가 붙으면 {"provider":"claude","runners":{…}} 가 더 나온다
```

`bridge` 가 60초 안에 `connected` 가 안 되면 `data/dev-gateway.log` 의 `[dodok] bridge:` 줄을 본다. 서버가 늦게 뜨면 플러그인 백오프가 벌어져 있어
첫 연결에 그만큼 걸린다(상한 10s, 지터 포함 ~12s — 30s 상한이던 이번 실연은 21s). `UNAUTHORIZED` 면 계정 토큰이 서버 DB 의 활성 토큰과 다르다. **브리지 토큰의 정본은 DB 다** — `.env` 의 `BRIDGE_TOKEN` 은 토큰 행이 하나도 없을 때(새 DB) 라벨 `env` 로 한 번 이어받을 뿐이고, 이어받은 뒤에는 `.env` 를 바꿔도 통하지 않는다. 새 토큰은 연결 페이지에서 발급한다(이 문서 「브리지 토큰 교체 — 사람이 따라 할 절차」 절 · `docs/guides/deploy.md` 「브리지 토큰 교체」). 이 절처럼 실연 DB 를 새로 만들었다면 계정 토큰을 `.env` 의 `BRIDGE_TOKEN` 과 맞추면 붙는다 — 인자로 넘기면 ps 에 남으므로 ADR 0002 9.5 처럼 패치 파일로:

```bash
( . ./.env; umask 077; printf '{ channels: { dodok: { accounts: { default: { token: "%s" } } } } }\n' "$BRIDGE_TOKEN" > data/bridge-token.patch.json5 )
oc --dev config patch --file data/bridge-token.patch.json5 && rm data/bridge-token.patch.json5   # 9.5 는 Gateway 재기동 없이 dodok 채널만 다시 띄운다(핫 리로드)
```

주의: Gateway 를 띄우면 OpenClaw 내장 주간 cron `skill-collection-review:<agent>`(격리 세션, exec·write 툴)가 밀린 실행을 곧바로 돌 수 있다 — 이번 실연에서 dev 의 것이
기동 2분 뒤 1회 돌았다(우리 런과 별개로 모델 사용). 예정은 `( . ./.env; env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_DEV_GATEWAY_TOKEN" PATH="$OCBIN:$PATH" openclaw --dev cron list --json --port 19001 )` 로 본다.

### (f) 정리

```bash
kill -INT <서버 node pid>          # lsof -nP -iTCP:$PORT -sTCP:LISTEN -t. close() 는 10s 상한, 플러그인이 system.notice shutdown 을 받는다
kill <tsx watch·pnpm 부모 pid>     # tsx watch 는 자식이 끝나도 남는다
kill <Gateway pid>                  # lsof -nP -iTCP:19001 -sTCP:LISTEN -t
oc --dev config unset channels.dodok.channels
oc --dev plugins inspect dodok --json | jq .plugin.status     # 여전히 "loaded"
```

⚠ 8절로 승인 정책(`agents.entries.<id>.tools.exec.ask`)을 켰다면 **여기서 되돌린다** — 8.3.

## 4. `wire-cli`

`pnpm wire-cli <origin> [localToken] <명령> …` — `scripts/wire-cli.ts`. `localToken` 을 빼면 env `DODOK_LOCAL_TOKEN`.
로그인은 레이트리밋(5회/분)이 있어 세션 토큰을 `data/wire-cli-session.json`(0600)에 오리진별로 캐시하고 `GET /auth/me` 가 401 이면 다시 로그인한다. 토큰류는 출력하지 않는다.
실패는 `{ code, message }` 를 stderr 에 찍고 exit 1.

| 명령 | 하는 일 |
| --- | --- |
| `login` | 새로 로그인(캐시 갱신) → `GET /auth/me` 출력 |
| `channels` | `GET /channels` |
| `create-channel <name>` | `POST /channels` |
| `add-agent <channelId> <providerAgentId> <handle>` | `GET /agents` 에 그 `providerAgentId` 가 없으면 `POST /agents { providerAgentId, handle, name: handle }`, 있으면 재사용 → `POST /channels/:id/members { memberType: "agent", memberId }` |
| `patch-channel <channelId> <json>` | `PATCH /channels/:id` (예: `'{"relayPolicy":{"maxRelayTurns":2,"allowPairs":"all"},"prompt":"…"}'`) |
| `send <channelId> <text> [--watch-ms 60000]` | wire 접속 → `channel.subscribe` → `message.send` → 서버 이벤트를 `[+ms] <event> <요약>` 으로 `--watch-ms` 동안 |
| `interact <channelId> <messageId> <itemId> [--watch-ms 60000]` | 최근 200개에서 메시지를 찾아 `component.interact { messageId, componentId: components.id, itemId, values: {} }` → ack → 이벤트 |
| `watch <channelId> [--watch-ms 60000]` | 구독만 하고 이벤트(재접속 때 `adapter.status` 관찰용) |
| `runs <channelId>` | `GET /channels/:id/runs` 를 한 줄씩(상태·트리거·depth·providerRunId·error·usage·시각) |
| `reset <channelId> <agentId\|handle>` | `POST /channels/:id/agents/:agentId/reset` (핸들이면 `GET /agents` 로 id 를 찾는다) |

시간표 형식: 첫 줄 `# t0 <ISO> (epoch <ms>)` — 서버 pino `time`(epoch ms)·Gateway 로그 시각과 맞춰 볼 때 쓴다. `TEXT_MESSAGE_CONTENT` 는 런별 첫 델타만 바로 찍고,
나머지는 그 런의 다른 이벤트가 오거나 watch 가 끝날 때 `TEXT_MESSAGE_CONTENT×N (첫 델타 +ms) "…"`(100자) 한 줄로 뭉친다. 그 밖의 서버 이벤트(`approval.requested` 등)는 JSON 앞 300자.

## 5. 이번 실연 결과 (2026-09-15, 서버 코어 태스크 15)

로그는 `data/phase1-live-20260915.log`(서버 pino)·`data/phase1-live-20260915-cli.log`(wire-cli 출력)·`data/dev-gateway.log`(Gateway·플러그인·claude-cli). 세 파일 모두 토큰 값 0회.

### 5.1 환경 실물

| 항목 | 값 |
| --- | --- |
| Gateway | OpenClaw `2026.9.4 (3a9d69d)`, 번들 Node 24.19.0, `:19001` loopback, token 인증. 기동 → `http server listening` 1.6s |
| 플러그인 | `pack:plugin` 번들 sha256 `163fca87…`(이전 설치본은 스파이크 3 의 `f57d6f88…`, `admission` 없는 번들) → 설치본과 일치, `status: "loaded"`, `trust.reason: "provenance-invalid"`(archive 설치) |
| 서버 | `:19100`(계정 `default` 의 bridgeUrl 포트), `OPENCLAW_TARGET=dev`, DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug` |
| 페어링 | 새 디바이스 파일 `data/openclaw-device-dev.json` 로 첫 시도에 접속(listen 뒤 9~20ms), scopes `operator.read·write·approvals·admin`. capabilities `sessionReset·agentsList·configSet` 모두 true |
| `.env` 덮어쓰기 규칙 | `.env` 에는 원격용 `OPENCLAW_DEVICE_IDENTITY_PATH` 값이 있는데, export 한 빈 값이 이겨 기본 dev 경로에 파일이 생겼다 — `process.loadEnvFile` 은 이미 있는 env 를 덮지 않는다(확인) |
| 브리지 | 서버 listen 뒤 21.5s 에 `ready`(플러그인 백오프 7번째 시도). 재기동 때는 10.6s. 그 뒤 백오프 상한을 30s → 10s 로 낮췄다(sv-residual) |
| 모델 | `anthropic/claude-opus-5` + claude-cli(Claude Code CLI 로그인 재사용), thinking high |

### 5.2 런 표 (계획 상한 8 → 사용률 경고로 조율자 판정 6, 실제 6)

| # | 시나리오 | 트리거 | 에이전트·depth | 소요(created→ended) | 결과 |
| --- | --- | --- | --- | --- | --- |
| 1 | S2 (수정 전) | mention | dev·0 | 120.14s | **`error TIMEOUT "queued timeout"`** — 정본은 +3.6s 에 저장됐는데 Gateway `chat`/`agent` 이벤트가 0건(5.4 결함 1). `run_error` 시스템 메시지 「@dev 실행이 실패했습니다: TIMEOUT」 |
| 2 | S2 (수정 `38fa0f1` 뒤) | mention | dev·0 | 3.23s | `queued → streaming → done`, `finalSource: plugin`, `RUN_STARTED`·델타 3·`RUN_FINISHED(messageIds=[정본])` |
| 3 | S3 | mention | dev·0 | 3.30s | done. 답 「@fin 안녕하세요, owner님이 인사 전해 달라고 하셨어요! … 답할 때 @dev 멘션해서 확인해 주세요.」(자기 멘션 `@dev` 는 라우터가 제외) |
| 4 | S3 | relay | fin·1 (**새 세션**) | 4.20s | done. 수정된 「전송 전 구독」 경로로 `RUN_STARTED`·델타 수신. 답 「@dev 인사 잘 받았어요…」 → `relay_limit`(1턴) + `continue_relay` |
| 5 | S4 | continue | dev·0 | 4.73s | `continue_relay` 클릭 → `message.updated consumed=[continue_relay]` → done. 답의 `@fin` 은 상한 0 에 막혀 `relay_limit`(0턴)만 |
| 6 | S8 | mention (리셋 뒤) | dev·0 | 4.12s | done. 답 **「[FJORD] 네, 준비됐어요! 🤖 무엇을 도와드릴까요?」** |

- S3 은 예산 때문에 `maxRelayTurns: 1`(dev → fin → 막힘)로 돌렸고, S4·S8 앞에서는 `maxRelayTurns: 0` 으로 에이전트 답의 멘션이 런을 더 만들지 않게 막았다. depth 2 경로는 통합 시나리오 3 이 잰다.
- 사람 메시지에 `@fin` 을 쓰면 fin 이 사람 멘션으로 바로 불린다 — S3 문구는 「@dev fin 에게 … 전해 줘」로 fin 앞의 `@` 를 뺐다.
- 승인 요청(`approval.requested`)은 한 번도 오지 않았다.
- 우리 런 밖의 모델 사용 1회: OpenClaw 내장 cron `skill-collection-review:dev`(Gateway 기동 2분 뒤, `trigger=cron`, `lastStatus ok`).

### 5.3 지연 측정

시각은 wire-cli `t0`+오프셋, 플러그인 로그(`ingress`·`run-start` = ack 시점), claude-cli `cli turn` 을 맞춰 쟀다. 서버에는 ack 시점 로그가 없다(5.4 결함 3).

| 측정 | 런 2 | 런 3 | 런 4 | 런 5 | 런 6 |
| --- | --- | --- | --- | --- | --- |
| ① `message.send`(또는 enqueue·interact) ack → 플러그인 `inbound.deliver` ack | 82ms | 46ms | 124ms (새 세션 구독 포함) | 53ms | 104ms |
| ② ack → 첫 델타(wire) | 2495ms | 1333ms | 2507ms | 2778ms | 3488ms |
| ③ 첫 델타 → 정본 `message.created` | 654ms | 1915ms | 1569ms | 1897ms | 522ms |

- ①: 플러그인은 `onAgentRunStart` 에서 ack 한다 — 스펙 10장 3의 걱정(ack 가 10s 타임아웃과 부딪힘)은 이번 규모에서 없었다(최대 135ms, 런 1 포함). 서버 `RUN_STARTED`(Gateway lifecycle start)는 ack 뒤 11~14ms.
- ②: claude-cli 는 부분 메시지를 몇 덩어리(런당 델타 3~11개)로만 준다. 첫 델타까지 대부분이 CLI 기동·모델 첫 토큰.
- ③: CLI 턴 종료 → 플러그인 `deliver`(final) 가 278~324ms, 그 뒤 정본 저장까지 수 ms.
- ④ **Gateway `runId` = 우리 런 uuid**: 6런 모두 `providerRunId` = 런 id, 플러그인 `run-start.runId` 도 같다(sc-t10 걱정 4 해소).
- ⑤ **usage 는 실리지만 값이 틀리다**: `RUN_FINISHED.usage`·런 행 모두 `{ inputTokens: 2, outputTokens: 1, costUsd: 0 }`(런 5 만 output 5) — claude-cli `message_start` 스냅샷 값이다. 같은 턴의 CLI 결과는 output 27~148, cache_creation 11k~53k, cache_read 0~43k, `total_cost_usd` 0.13~0.53(5.4 결함 2).

### 5.4 틀린 것·고칠 것

1. **[고침 `38fa0f1`] 접속 뒤 생긴 세션의 Gateway 이벤트를 받지 못했다.** 실물 Gateway 는 `sessions.messages.subscribe` 한 세션의 `chat`·`agent`·`session.message` 만 보낸다.
   어댑터는 접속 때 복구 대상(부팅 시 있던 `agent_sessions`)만 구독해서, 새 채널의 첫 런은 델타·`RUN_STARTED` 없이 queued 상한(120s)으로 `TIMEOUT` 이 됐다(정본은 도착).
   가짜 Gateway 가 구독과 무관하게 모든 연결에 보내 통합 테스트가 놓쳤다 — 수정은 `send` 전에 연결당 한 번 구독하고, 가짜도 구독한 연결에만 보낸다. 런 4(fin 새 세션)로 실물 확인.
2. **[갈렸다 2026-09-20 · 고치지는 않았다] usage 값.** 5.3 ⑤. 2026-09-19(sv-residual)의 추정은 아래에 남겨 두고, **프레임 덤프로 확인한 답을 먼저 적는다**
   (근거 표본 2개와 자세한 수치는 7.6-1).
   - **어디서 온 값인가**: 서버 값(`data/phase1-live-20260915-cli.log` 의 `RUN_FINISHED.usage`·런 행) `inputTokens 2`·`outputTokens 1`(런 5 만 `5`)·`costUsd 0` 은
     `data/phase1-dev-gateway-20260915.log` 의 claude-cli stream-json 에서 각 턴 `stream_event` `message_start` 의 `message.usage`, 그리고 그 스냅샷을 그대로 실은 `assistant` 이벤트의
     `message.usage`(`input_tokens 2`·`output_tokens 1`, 런 5 는 `5`)와 **런마다 같다**. 최종 값은 `message_delta` 의 `usage.output_tokens`(런 1~6: 27·28·75·43·148·37)와
     `result`(`usage` 같은 값 + `cache_creation_input_tokens` 11063~53174·`cache_read_input_tokens` 0~42679, `total_cost_usd` 0.53·0.13·0.27·0.18·0.43·0.22)에만 있다.
     매퍼는 `session.message` 의 `message.usage.{input,output,cost.total}` 을 옮기고 오케스트레이터는 온 값으로 덮어쓰므로(마지막 값이 남는다), **Gateway 가 `session.message` 에
     `assistant` 스냅샷 usage 를 싣는다**고 본다 — 매퍼가 첫 값을 고르는 것이 아니다. 원본 프레임이 없어 확정은 아니다. 구독이 빠져 `chat`·`agent` 가 0건이던 런 1 에도 같은 usage 가 실렸다
     (`session.message` 는 `sessions.subscribe` 만으로 온 것으로 보인다 — 확인 필요).
   - **프로토콜 선언**: `@openclaw/gateway-protocol` 2026.9.4 `schema-modules-*.d.mts` 의 `ChatEventSchema` 는 `delta`·`final`·`error` 에 `usage?: unknown`(모양 없음),
     `AgentEventSchema` 는 `data: Record<string, unknown>`, `session.message` 이벤트 페이로드는 스키마가 없다(catch-up 응답만). 스파이크 1 에서 `final` 에는 `usage` 가 없었고(ADR 0001 6.3),
     `session.message` 최상위의 `inputTokens`·`outputTokens`·`estimatedCostUsd` 는 세션 누계다. 더 정확한 값을 싣는 이벤트의 근거가 없어 **매퍼·오케스트레이터는 바꾸지 않았다**.
     claude-cli 백엔드의 `cost.total` 은 스파이크 1 부터 늘 0 이다.
   - **확인 결과(2026-09-20 프레임 덤프, 런 2개 표본)**: ① `session.message`(role `assistant`)는 턴당 1번 오고 `message.usage` 를 싣는다.
     ② `chat` 이벤트에는 **usage 가 없다**(델타·final 합쳐 18·94 프레임 모두 `usage: null`). ③ `agent` `group` 이벤트의 `data` 에도 **없다**.
     ④ 최상위 세션 누계(`inputTokens`·`outputTokens`·`estimatedCostUsd`)는 같은 스냅샷을 누적한 값이라 **턴 전후 차이도 CLI `result` 와 맞지 않는다**(런 4 뒤 `o: 8`·`c: 0.032768` vs 실제 출력 697·$1.199).
   - **결론**: 진짜 출력 토큰 수와 비용을 싣는 Gateway 프레임은 **없다** — claude-cli 의 `message_delta`·`result` 값이 Gateway 를 넘어오지 않는다(OpenClaw 쪽 한계).
     **매퍼가 첫 값을 고르는 것이 아니고, Gateway 가 스냅샷을 싣는다**는 2026-09-19 의 추정이 맞았다. 다만 매퍼(`gateway/events.ts:227-229`)가 읽는 바로 그 `message.usage` 안에
     **정확한 `cacheRead`·`cacheWrite`·`totalTokens` 가 함께 들어 있는데 버리고 있다**(런 1 `cacheWrite 56191` = CLI `cache_creation 56191`, 런 4 `57863` = `57863`).
     `totalTokens` 는 스냅샷 출력으로 만든 합이라 맞지 않는다 — 필드별 판정의 정본은 `docs/adr/0005-usage-values.md`.
   - **후속(이번에 고치지 않았다)**: ⓐ 계약 `RunUsage` 에 캐시 토큰 자리를 만들고 매퍼가 옮길지 — Phase 2 활동 패널과 함께 판단한다.
     ⓑ 출력 토큰·비용은 OpenClaw 쪽에 올린다(`chat` `final` 또는 `session.message` 에 `message_delta`/`result` 값을 실어 달라는 요청).
     그때까지 **활동 패널의 비용·출력 토큰 표시는 쓸 수 없다**(캐시 토큰만 믿을 수 있다).
3. **[고침] 서버 로그로 진단이 안 된다.** `inbound.deliver` ack(admission·걸린 시간)와 런 타임아웃(`queued timeout`)이 서버 로그에 한 줄도 남지 않았다 — 런 1 원인은 Gateway 로그로 찾았다.
   이제 어댑터 `inbound delivered`(info: `runId`·`deliveryId`·`admission`·`ackMs`(첫 시도부터)·`retries`·`waitedForPlugin`), 오케스트레이터 `run ended`(info: `status`·`finalSource`·`errorCode`·`durationMs`(created→ended))·
   `run closed by timeout`(warn: `reason` = `queue_timeout`·`run_timeout`·`undelivered`(ack 전 상한), `statusBefore`·`elapsedMs`(created 부터); `final_timeout` 은 info). 본문·토큰은 싣지 않는다. 정상 런은 info 2줄.
4. **[고침] 정본이 왔는데 `queued` 로 남는 런.** Gateway 이벤트 없이 정본만 오는 경우(결함 1, 또는 WS 만 끊긴 경우) 런은 120s 뒤 `error` 가 되고 「실행이 실패했습니다」가 답 아래에 붙었다.
   이제 `queued` 에서 `canonical_received` 를 받으면 `finalizing`(`hasCanonical`)으로 가고, Gateway `final` 이 오면 곧바로·안 오면 10s 뒤 `done(finalSource=plugin)` 이다(계약 스펙 5.1 ⁵, 통합 시나리오 6(c)).
   가짜 Gateway 하네스에서는 서버가 브리지 소켓을 먼저 읽어 정본이 Gateway 이벤트보다 먼저 처리되고 있었다 — 대본은 정본 앞에서 `gateway.flush()`(ping/pong)로 이벤트 처리를 기다린다.
   - **[남음]** 정본이 먼저 오는 퇴화 경로(Gateway 이벤트 없음)에서 에이전트가 턴 초반에 답하고 10s 넘게 일하면 런이 done(plugin) 으로 닫혀 다음 런이 먼저 전달되고, 플러그인 상관(세션키당 마지막 인바운드) 때문에 앞 턴의 늦은 답이 다음 런에 붙을 수 있다 — Gateway 이벤트가 오는 정상 경로에는 없다(sv-residual 리뷰 이월 2). 이 경로로 닫힌 런은 어댑터가 `gateway_final` 을 못 봤으므로 오케스트레이터가 60s 뒤 `forgetRun` 한다(늦은 usage 는 그때까지 받는다).
5. **[프롬프트·고침] 서술 속 멘션도 릴레이다.** 런 5 의 dev 는 보고 문장에 `@fin` 을 넣었고 그것이 릴레이 판정을 받았다(상한 0 이라 카드만). 상한이 남아 있으면 fin 런이 돈다.
   라우터는 그대로 두고(멘션 = 호출이 계약) 에이전트가 매 턴 받는 `relayRules` 를 「다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 N턴). 언급만 할 때는 @ 없이 이름만 쓰세요.」로 바꿨다. 효과는 다음 실연에서 본다.
6. **[환경] claude-cli 가 사용자 `~/.claude` 설정을 싣는다**(`--setting-sources user`): 턴마다 SessionStart 훅(startup 18·resume 4회 관찰)이 돌고 첫 턴 캐시 생성 53k 토큰($0.53). 6런 CLI 보고 비용 합 약 $1.77, 7일 사용률 0.87 → 0.89.
7. **[환경] 내장 cron** — 5.2. dev 프로필에서 실연을 반복하면 매주 한 번씩 섞인다(fin 것은 2026-09-17 예정).
   **2026-09-20 재확인**: 예고대로 **fin** 것이 Gateway 기동 2분 뒤 1회 돌았다(`trigger=cron`, 세션키 `agent:fin:cron:…`, 14.3s·$0.105) — 우리 런과 별개의 모델 사용이다.
   같은 날 Gateway 를 한 번 더 껐다 켰을 때는 **다시 돌지 않았다**(주간 몫을 이미 썼다). 실연 비용을 셀 때 이 한 번을 빼고 센다.
8. **[문서 정정] wire-cli `interact` 의 `componentId` 는 `components.id`(`cmp_…`)** 다(계약 9.3, `validateInteraction`). 블록 id 가 아니다.

### 5.5 새 대화·재접속

- **S8 리셋**: `POST /channels/:id/agents/:devId/reset` → Gateway `sessions.reset` 54ms, 200 `{ ok: true }`, info 시스템 메시지. 다음 턴 `cli exec useResume=false session=none`(새 CLI 세션),
  플러그인 `groupSystemPromptChars: 31`(새 프롬프트)·`channelPromptContextItems: 0` → 답에 `[FJORD]`. **ADR 0003 결론(리셋·새 키에서만 반영)이 실물과 맞다.**
  fin(기본이 아닌 에이전트)의 채널 키도 리셋 200, `agent_sessions.lifecycle_revision`·`session_started_at` 이 채워졌다(sc-t11 걱정 5 — dev 프로필에서는 된다).
- 프롬프트 리비전: `relayPolicy` 만 바꿔도 리비전이 오르고(설계대로) 다음 인바운드에 `ChannelPromptContext` 1개가 실렸다(런 3·5).
- **S6b Gateway 재기동**(서버·wire 는 그대로, 런 0): SIGTERM → Gateway 종료 438ms(`shutdown completed cleanly`) → 서버 `gateway connection closed; reconnecting`(code 1012 `service restart`) +24ms·`bridge down` +30ms
  → 재접속 시도 `ECONNREFUSED` 2회(백오프 1.9s·4.7s) → Gateway `listening` +6.86s → 플러그인 브리지 `hello` +7.31s → **어댑터 `gateway connected` +7.46s**
  → `gateway session recovered` dev(messages 3) +7.52s·fin(messages 1) +7.53s(`sessions.subscribe` → 세션별 `sessions.messages.subscribe` → `chat.history`).
  wire `adapter.status`: `reconnecting/connected` → `reconnecting/down` → `reconnecting/connected` → `connected/connected`. 60s 재접속 알림은 나오지 않았다(60s 미만).
  claude-cli 세션은 `deltaCursor` 가 없어 `agent_sessions.history_cursor` 는 null 로 남고 복구는 꼬리 페이지를 받는다(ADR 0003). 진행 중 런이 없어 `chat.history` 의 `inFlightRun` 은 보지 못했다.
- **서버 종료**: SIGINT → 프로세스 종료 131ms·125ms(두 번), 플러그인 `system.notice shutdown — server shutting down` 수신 후 재연결 백오프. `app close step failed` 없음.

### 5.6 잔여물

- `~/.openclaw-dev`: `extensions/dodok` 가 새 번들로 바뀜 · `openclaw.json` 백업 회전(`.bak`~`.bak.4`·`.last-good`, 채널 설정 쓰기·해제) — 끝에 `channels.dodok.channels` 는 해제, 계정 `default` 그대로 ·
  `state/openclaw.sqlite` · `agents/{dev,fin}/agent/openclaw-agent.sqlite`(세션 `agent:{dev,fin}:dodok:channel:01a0a420-7cdd-7288-af7d-ef7f646fca5e` 전사, 각 1회 리셋) · 내장 cron `skill-collection-review:dev` 실행 기록(다음 2026-09-22).
- `~/.claude/projects/-Users-jang2162--openclaw-dev-workspace`(세션 파일 2) · `-workspace-fin`(1) · `-agents-dev-agent-workshop-skills`(1, cron).
- `/tmp/openclaw/openclaw-dev-2026-09-15.log`(Gateway 파일 로그) · `/tmp/openclaw/openclaw-claude-skills-*`(임시 디렉터리 9개).
- 워크트리 `data/`(ignored): 로그 3개, `live-smoke.env`(시크릿), `live-smoke.sqlite`, `openclaw-device-dev.json`(디바이스 아이덴티티), `wire-cli-session.json`(세션 토큰).

## 6. 원격 Gateway 에서 같은 절차를 돌릴 때 다른 점

- 플러그인은 **사용자가 Gateway 호스트에 설치**한다(ADR 0002 9.2~9.5: `pack:plugin` → tarball 복사 → `openclaw plugins install … --force --accept-capabilities` → 계정 설정은 패치 파일). 워커는 원격 호스트를 만지지 않는다.
- 서버 env: `OPENCLAW_TARGET=remote`(기본), `OPENCLAW_GATEWAY_URL=wss://…`·`OPENCLAW_GATEWAY_TOKEN`, 디바이스 파일은 기본 `data/openclaw-device.json`(dev 와 따로).
  원격 공유 토큰은 `operator.admin` 을 부여한다(계획서 10장 #15, 2026-09-15 원격 실측 — 스코프 승급 자동 승인). 부여가 없어지면 `capabilities.sessionReset=false` 가 되고 「새 대화」는 409.
- 브리지: 플러그인이 **아웃바운드로** 서버에 붙는다. 개발 PC 서버면 터널(cloudflared 등)로 `wss://…/bridge` 를 만들고, 그 주소를 `BRIDGE_PUBLIC_URL` 에 적고 호스트의 계정 `bridgeUrl` 에 넣는다. 토큰은 서버 DB 의 활성 토큰과 같게 — 브리지 토큰의 정본은 DB 다. `.env` 의 `BRIDGE_TOKEN` 은 토큰 행이 없을 때 한 번 이어받을 뿐이고, 새 토큰은 연결 페이지에서 발급한다(이 문서 「브리지 토큰 교체 — 사람이 따라 할 절차」 절 · `docs/guides/deploy.md` 「브리지 토큰 교체」).
- 원격은 루프백이 아니므로 페어링 자동 승인·지연 수치가 다를 수 있다. ①~③ 을 다시 재고 이 문서에 표를 더한다.
- **[사람] 원격 Gateway 버전을 먼저 확인한다.** 서버를 원격에 붙이면 접속 한 번에 로그 두 줄이 알려 준다 — `"gateway connected"` 의 `gatewayVersion`·`gatewayBuildId`(hello-ok `server.version`·`server.buildId`)와 `"bridge plugin hello"` 의 `gatewayVersion`(원격 호스트의 플러그인이 보낸 `runtime.version`).
  원격이 `2026.9.5` 이상이면 **ADR 0004 이전 번들은 배포에서도 에이전트가 카드를 못 보낸다**(결함 1) — 호스트의 플러그인을 새 번들로 바꾸고, 그 버전에서 11절 하네스를 한 번 돌린다. `pluginBuiltWithSdk` 는 Gateway 버전이 아니다(2절).
- dev 프로필 전용 주의(내장 cron·`~/.openclaw-dev` 잔여물)는 원격 호스트의 설정·예정 작업으로 바뀐다 — 호스트에서 `openclaw cron list` 로 본다.
- **[사람] 첨부(Phase 2 ③) — 호스트 설정 둘을 정한다**(스펙 `docs/superpowers/specs/2026-09-23-attachments-design.md` 5.3, 스파이크 보고서 Q1·2-3).
  ① **`attachments.ttlHours`** — 설정하지 않으면 플러그인이 저장한 사람 이미지 원본(`media/inbound/`)이 호스트에 **영구히** 남는다. Gateway 의 시간당 미디어 정비는 이 값이 있을 때만 지운다. 너무 짧으면 이력 재생에서 이미지가 빠진다(전사가 그 경로를 기억한다). 이미지는 호스트에 최소 세 부가 생긴다 — 원본, claude CLI 복사본(`<ws>/.openclaw-cli-images/`, 7일 스윕), 스테이징(`<ws>/media/inbound/openclaw-staged-*`, 정리 코드를 못 찾음).
  ② **`tools.fs.workspaceOnly`** — `false`(기본)면 모델이 **호스트에서 읽을 수 있는 아무 파일이나** `message` 툴 `media` 로 채널에 보낼 수 있다(플러그인은 `loadWebMediaRaw` 에 Gateway 의 `mediaAccess` 를 그대로 넘긴다). `true` 면 워크스페이스·미디어 캐시·임시 루트로 좁혀진다. 원격 호스트에서 어느 쪽인지 확인하고 적는다.
  계정 설정 `mediaMaxMb`(선택, 1~20, 기본 20)는 에이전트가 보내는 파일 한 개의 상한이다 — 서버 상한 20 MiB 를 넘을 수 없다.
- 첨부 바이트는 브리지 WS 가 아니라 **같은 오리진의 HTTP** 로 오간다 — 플러그인이 `bridgeUrl` 의 `wss:`→`https:`(`ws:`→`http:`)로 바꿔 `GET`·`POST /bridge/attachments` 를 부른다(브리지 토큰). 터널·리버스 프록시가 `/bridge` WS 만 통과시키면 첨부만 실패한다. 요청 본문 상한은 20 MiB 보다 크게 둔다. 서버 쪽 블롭은 `ATTACHMENTS_DIR`(기본 `<DATA_DIR>/attachments`)에 쌓인다.

---

## 7. 웹(Phase 1 ②) 실물 확인 — 2026-09-20 결과

**상태(2026-09-20)**: 실제 dev Gateway·실제 플러그인 번들·실제 모델(`claude-opus-5` + claude-cli)로 웹을 한 번 돌렸다. 모델 런은 사용자 승인 상한 그대로 **4회**(3회 + 중지 재시도 1회).
**시나리오 4·5 는 통과, 6(중지)은 두 번 다 계측이 빗나가 「실물 중지 미확인」으로 남았다**(7.4 의 ❗). 절차는 7.1~7.2, 결과는 7.3~7.8. 로그는 `data/phase1-live-20260920.log`(서버 pino)·`data/dev-gateway.log`(Gateway·플러그인·claude-cli)·
`data/frames-20260920.jsonl`(Gateway 원본 프레임)·`data/cdp-*.jsonl`(브라우저 콘솔·WS 프레임). 전부 `data/` 안에 두고 커밋하지 않는다.

### 7.1 준비 — 3절에 더할 것

3절 (a)~(e)를 그대로 하고 아래를 더한다.

- `data/live-smoke.env` 의 `APP_ORIGIN` 은 웹 dev 서버 주소와 **글자까지 같아야 한다**(`http://localhost:5173`). wire 는 핸드셰이크 `Origin` 이 `APP_ORIGIN` 과 같을 때만 세션 쿠키를 받는다(웹 스펙 9.1).
- 웹을 띄운다. 서버 포트가 3000 이 아니므로 프록시 대상을 준다.

```bash
DODOK_API_ORIGIN=http://127.0.0.1:$PORT pnpm -F @dodok/web dev      # 5173, strictPort
```

- 브라우저는 **`http://localhost:5173`** 으로 연다. `127.0.0.1:5173` 으로 열면 `Origin` 이 달라 wire 가 `UNAUTHORIZED` 를 주고, 앱은 REST 세션이 살아 있는 것을 보고
  재연결을 멈춘 뒤 「실시간 연결이 거부되었습니다 — 이 주소(http://127.0.0.1:5173)가 서버의 APP_ORIGIN 과 다릅니다」 배너를 띄운다(설계대로다 — 헷갈리지 말 것).
- **로그인 토큰을 화면·전사에 남기지 않고 넣는 법.** 토큰은 `data/live-smoke.env` 의 `LOCAL_AUTH_TOKEN`(실연 전용으로 새로 뽑은 값 — `.env` 의 것이 아니다)이다.
  Vite dev 서버는 워크스페이스 안 파일을 `/@fs<절대경로>` 로 **같은 출처**에 서빙하므로, 페이지 안에서

  ```js
  const env = await (await fetch('/@fs' + REPO + '/data/live-smoke.env')).text();
  const tok = env.match(/^LOCAL_AUTH_TOKEN=(.+)$/m)[1].trim();   // 입력칸에 넣고 제출
  ```

  하면 값이 셸 출력·도구 전사 어디에도 남지 않는다. Vite 기본 `server.fs.deny` 는 `.env`·`.env.*` 라 `live-smoke.env` 는 걸리지 않는다.
  **토큰을 다른 파일로 복사하지 않는다**(`data/` 밖으로 나가고, 에이전트 도구가 「자격 증명 복제」로 막기도 한다). Vite 를 내리면 이 경로도 닫힌다.
  입력칸은 제어 컴포넌트라 `value` 를 그냥 넣으면 React 가 되돌린다 — `HTMLInputElement.prototype` 의 네이티브 setter 로 넣고 `input` 이벤트를 쏜다.
- ⚠ **검증 탭은 앞으로 꺼낸다.** 배경 탭은 타이머를 ~1s 로 조인다 — 페이지에 심은 `setInterval` 표본기가 스트리밍 창(이번에 런당 **0.2~1.5s**, 7.5)을 통째로 놓친다.
  2026-09-20 에 중지 클릭이 이것 때문에 불발했다(앱 결함이 아니라 계측 결함). **폴링은 페이지 타이머가 아니라 브라우저 바깥**(neo `run` 런타임·CDP)에서 돌리고,
  사람이 누르는 것을 흉내 내는 확인은 탭을 앞으로 꺼낸 뒤 한다(CDP `Page.bringToFront`). 델타 렌더 자체는 배경 탭에서도 정상이다 — WS 수신은 조이지 않는다.
- **프레임 원본은 늘 남긴다.** `data/live-smoke.env` 에 `OPENCLAW_FRAME_DUMP_PATH=data/frames-<날짜>.jsonl` 을 더한다. usage 출처(5.4-2)는 이 덤프로 갈랐다 — 7.6.
- 3절 (a) 가 `Config path not found: channels.dodok.channels. Nothing was changed.` 를 찍으면 **이미 깨끗하다는 뜻**이다(정상 — 오류가 아니다).
- 에이전트는 웹에서 등록한다: `/agents` → 「Gateway 에서 가져오기」 → `dev`·`fin`. dev 의 표시 이름은 `C3-PO` 이고 **핸들 칸은 `dev` 로 채워진다**(멘션은 `@dev`).
- **스크린샷·콘솔·WS 프레임.** BrowserOS neo 는 스크린샷을 파일로 주지 않고 `console.log`·네트워크·WS 프레임을 못 본다(browser-verification.md).
  저장소 `.mcp.json` 의 `playwright-neo` 가 세션에 붙지 않았으면, neo 의 CDP(`~/Library/Application Support/BrowserClaw/.browseros/config.json` 의 `ports.cdp`, 기본 9110)에
  **Node 24 내장 `WebSocket`** 으로 직접 붙어 `Page.captureScreenshot`·`Runtime.enable`·`Network.enable` 로 대신한다 — 의존성이 필요 없다(2026-09-20 에 그렇게 했다).

### 7.2 시나리오와 런 배분 — **모델 런 3회 이하**

⚠ **사람 메시지에 `@fin` 을 쓰면 릴레이가 아니다.** 라우터는 사람 메시지의 멘션을 전부 depth 0 런으로 만든다(`router/decide.ts`) — `@dev @fin …` 은 릴레이 체인이 아니라
**병렬 런 2개**가 되고, 각자의 답이 또 릴레이를 켜서 상한을 넘긴다. 릴레이를 보려면 **`fin` 앞의 `@` 를 뺀다**: `@dev fin 에게 …`.

⚠ **`자동 응답`은 멘션이 하나도 없는 사람 메시지에만 걸린다**(같은 파일). `@…` 로 시작하는 우리 문장들은 자동 응답 런을 만들지 않으므로 켜 두어도 예산에 영향이 없다.

| # | 입력 | 턴 상한 | 런 | 볼 것 |
| --- | --- | --- | --- | --- |
| 4 | `@dev 안녕하세요. 한 문장으로 자기소개 해줘` | **0** | 1 | 대기 → 델타가 버블에 쌓임 → 정본 교체 때 버블 0·메시지 1, 목록이 끝에 붙어 있음 |
| 5 | `@dev fin 에게 오늘 할 일을 한 줄로 전해줘` | **1** | 2·3 | dev 답의 `@fin` 이 멘션 칩 → fin 런(relay·depth 1) → fin 답의 `@dev` 가 상한에 막혀 `relay_limit` 카드 + 「이어가기」(**누르지 않는다** — 런이 하나 더 생긴다) |
| 6 | 런 3 스트리밍 중 버블의 중지 | 1 | — | 「중지됨」으로 끝나는지, **중지 뒤 늦은 정본이 오는지** |

- **런 1 앞에서는 턴 상한을 0 으로 둔다** — 에이전트 답 속 멘션이 런을 하나 더 만들지 않게(5.2 의 런 4·5 와 같은 방식). 런 2 앞에서 1 로 올린다.
  설정 저장·에이전트 등록·채널 만들기는 런을 쓰지 않는다.
- 상한을 바꾸면 채널 프롬프트 리비전이 오르고 다음 인바운드에 `ChannelPromptContext` 가 실린다(설계대로).

### 7.3 환경 실물 (2026-09-20)

| 항목 | 값 |
| --- | --- |
| Gateway | OpenClaw `2026.9.4 (3a9d69d)`, 번들 Node 24.19.0, `:19001` loopback, token 인증. 기동 → `http server listening` 1.3s(플러그인 14개) |
| 플러그인 | `pack:plugin` 번들 sha256 `4b0ecc34…` = 설치본과 일치, `status: "loaded"`, `trust.reason: "provenance-invalid"`(archive 설치) |
| 서버 | `:19100`(계정 `default` 의 bridgeUrl 포트), `OPENCLAW_TARGET=dev`, DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug`, 프레임 덤프 켬 |
| 웹 | Vite 8.3.0, `:5173`, `DODOK_API_ORIGIN=http://127.0.0.1:19100`, 브라우저 BrowserOS neo(Chrome 151.0.8162.137) |
| 저장소 | Node 24.21.0 · pnpm 11.16.0 |
| 브리지 | 서버 listen 뒤 **10.2s** 에 `ready`(플러그인 백오프 6번째 시도). 2026-09-15 의 21.5s 보다 짧다 — 백오프 상한을 30s → 10s 로 낮춘 효과(5.2) |
| 페어링 | `OPENCLAW_DEVICE_IDENTITY_PATH=` 빈 값 → `data/openclaw-device-dev.json` 새로 생성, 첫 시도 접속. capabilities `sessionReset·agentsList·configSet` 모두 true |
| 모델 | `anthropic/claude-opus-5` + claude-cli. 우리 런 **4회** CLI 보고 비용 합 **$2.575**(런1 $0.564·런2 $0.603·런3 $0.208·런4 $1.199) + 내장 cron $0.105 |

### 7.4 런 표 (상한 4, 실제 4)

채널 `실연`(id `01a0bd25-264c…`), 멤버 `@dev`(C3-PO)·`@fin`, `allowPairs: all`, fin 자동 응답 켬.

| # | 시나리오 | 입력 | 런 id | 에이전트·트리거·depth | 소요(created→ended) | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 4 | `@dev 안녕하세요. 한 문장으로 자기소개 해줘` | `01a0bd28-49c8` | dev·mention·0 | 4.22s | done·`finalSource: plugin`. 델타 **17개**(평균 77ms)가 버블에 쌓이고 정본으로 교체, 버블 0·메시지 1 |
| 2 | 5 | `@dev fin 에게 오늘 할 일을 한 줄로 전해줘` | `01a0bd2c-7382` | dev·mention·0 | 2.96s | done. 답 「**@fin** 오늘 할 일을 한 줄로 알려주세요.」 — 일을 넘길 때만 `@` 를 쓰라는 `relayRules`(5.4-5) 대로 썼다 |
| 3 | 5 | (릴레이) | `01a0bd2c-7f13` | fin·**relay**·1 | 4.82s | done. 답 끝의 `@dev` 가 상한 1 에 막혀 `relay_limit` 시스템 카드 + 「이어가기」 — 누르지 않았다 |
| 4 | 6 시도 | `@dev 너가 하는 일과 성격을 다섯 문장으로 길게 설명해줘` (턴 상한 **0**) | `01a0bd72-1c0e` | dev·mention·0 | 12.02s | done. **창을 넓히는 데는 성공**(델타 93개·평균 78ms·스트리밍 창 **7149ms**) 했으나 중지를 누르지 못했다 — 아래 ❗ |

- 세 런 모두 `status: done`, `finalSource: plugin`, `error: null`. 승인 요청(`approval.requested`)은 한 번도 오지 않았다.
- ❗ **시나리오 6(중지)은 「실물 중지 미확인」으로 남았다. 두 번 시도했고 두 번 다 계측이 빗나갔다 — 앱 결함이 아니다.**
  - **1차(런 3)**: 중지를 누를 표본기를 페이지 `setInterval(150ms)` 로 심었는데 **배경 탭에서 ~1s 로 조여져**(7.1 ⚠) 스트리밍 창 1526ms 를 통째로 놓쳤다.
  - **2차(런 4)**: 1차의 교훈대로 탭을 앞으로 꺼내고(CDP `Page.bringToFront`) 폴링을 **브라우저 바깥**(neo `run` 런타임)에서 돌렸다 — 조임은 사라져 표본이 ~50ms 간격으로 잡혔고,
    「다섯 문장으로」가 창을 **7149ms** 로 넓혀 누를 시간도 넉넉했다. 그런데 클릭 조건에 쓴 **버블 길이 선택자(`중지` 버튼의 `closest('article')`)가 빈 값을 줘**
    게이트가 한 번도 열리지 않았고, 루프 반복 상한(140회 ≈ 6.8s)을 먼저 소진했다. 중지 버튼 자체는 전송 0.2s 뒤부터 계속 눌 수 있는 상태였다(`run.abort` 프레임 0건).
  - **다음에 볼 때는** 게이트를 단순하게 둔다: **「중지 버튼이 보이면 1.5초 뒤 누른다」** 로 충분하다(길이 재기 금지). 탭 앞으로·바깥 폴링·긴 답 요구는 2차 방식 그대로 쓴다.
  - 따라서 **중지 뒤 「중지됨」 표시와 늦은 정본**(실물 OpenClaw 는 중단 뒤에도 부분 답을 보낼 수 있다 — web-t1 이월)은 **여전히 실물에서 확인되지 않았다**.
- 정본이 온 뒤 `relay_limit` 시스템 메시지가 **+19ms** 에 붙었다. 카드 문구는 「릴레이 한도(1턴)에 도달했습니다. 계속하려면 사람이 멘션하거나 이어가기를 누르세요.」
- 우리 런 밖 모델 사용 1회: OpenClaw 내장 cron(`trigger=cron`, 세션키 `agent:fin:cron:…`)이 Gateway 기동 2분 뒤 1회. 14.3s·$0.105 — 5.4-7 이 예고한 fin 것이다.

### 7.5 지연 측정

브라우저 WS 프레임(CDP `Network.webSocketFrame*`, `data/cdp-*.jsonl`)의 시각이다. `t=0` 은 클라이언트가 `message.send` 를 emit 한 순간.

| 측정 | 런 1 | 런 2 | 런 3(릴레이) | 런 4(긴 답) |
| --- | --- | --- | --- | --- |
| ⓪ `message.send` → wire ack | 31ms | 18ms | — (사람 전송 없음) | 16ms |
| ① 서버 `inbound delivered` ackMs(플러그인이 ack 하기까지) | 177ms | 53ms | 81ms | 68ms |
| ② ack → 첫 델타(`TEXT_MESSAGE_CONTENT`) | 2565ms | 2447ms | 2984ms¹ | 4518ms |
| ③ 첫 델타 → 정본 `message.created` | 1618ms | 493ms | 1829ms | 7480ms |
| 델타 개수 · 평균 간격 · **스트리밍 창** | 17 · 77ms · **1230ms** | 4 · 69ms · **206ms** | 18 · 90ms · **1526ms** | 93 · 78ms · **7149ms** |
| 런 전체(서버 `run ended` durationMs) | 4216ms | 2964ms | 4817ms | 12015ms |

¹ 런 3 은 사람 전송이 없으므로 **런 2 의 정본 도착**을 기준으로 잰 값이다(릴레이가 다음 턴을 시작하기까지).

- ①: 플러그인 ack 는 53~177ms — 10s 타임아웃과 부딪히지 않는다(5.3 ① 과 같은 결론).
- ②: 대부분이 CLI 기동 + 모델 첫 토큰이다. **화면에서 2.5초는 견딜 만했다** — 보낸 즉시(205ms) 아바타·대기 버블·중지 버튼이 서고, 그 뒤에 글자가 흐른다.
- ③·델타 알갱이: 이번 claude-cli 는 런당 델타를 **17·4·18·93개, 평균 간격 77·69·90·78ms** 로 줬다(2026-09-15 은 런당 3~11개).
  **간격은 답 길이와 무관하게 ~78ms 로 일정하고, 개수만 길이를 따라간다.** 버블에 글자가 매끄럽게 쌓이고, 커서가 끝에 붙어 따라온다.
- ⚠ **스트리밍 창(첫 델타 → 마지막 델타)이 답 길이에 정비례한다 — 1230ms·206ms·1526ms 에 견줘 「다섯 문장으로」는 7149ms.**
  짧은 답에는 사람도 중지를 누를 틈이 거의 없고 자동 검증은 창을 통째로 놓친다. **중지를 볼 때는 반드시 길게 답하라고 시켜 창을 넓힌다**(7.4 의 ❗).
- 정본 교체는 눈에 띄는 튐 없이 끝났다(web-t13 이 고친 경로 — 교체 뒤 `scrollHeight - clientHeight - scrollTop = 0`).

### 7.6 틀린 것·고칠 것

1. **[해결·5.4-2 의 「다음 확인」] usage 값의 출처를 프레임 덤프로 갈랐다.** 모델 런을 더 쓰지 않고 `data/frames-20260920.jsonl`(24 프레임)로 확인했다.
   - **`chat` 이벤트에는 usage 가 아예 없다** — 델타·`final` 18 프레임 모두 `usage: null`. (ADR 0001 6.3 의 관찰과 같다.)
   - **`agent` `group` 이벤트에도 없다** — `data` 키는 시작 `{phase, startedAt}`, 끝 `{endedAt, executionSettled, phase, startedAt, terminalReply}` 뿐이다.
   - **`session.message`(role `assistant`) 하나만 싣는다.** 런 1 의 값:
     `message.usage = { input: 2, output: 1, totalTokens: 56194, cacheRead: 0, cacheWrite: 56191, cost: { input:0, output:0, cacheRead:0, cacheWrite:0, total:0 } }`.
     같은 턴 claude-cli `result` 는 `input 2 · output 101 · cache_creation 56191 · cache_read 0 · total_cost_usd 0.5644`.
     ⇒ **`input`·`cacheRead`·`cacheWrite`·`totalTokens` 는 맞고, `output` 은 `message_start` 스냅샷이라 틀리며(1 vs 101), `cost.*` 는 claude-cli 백엔드라 전부 0 이다.**
   - 최상위 세션 누계 `inputTokens`·`outputTokens` 는 **null** 이고 `estimatedCostUsd` 는 0 이다 — 턴 전후 차이로도 메울 수 없다.
   - **남는 결론**: 진짜 출력 토큰 수와 비용을 싣는 Gateway 프레임은 **없다**(OpenClaw 쪽 한계 — claude-cli `message_delta`·`result` 값이 Gateway 를 넘어오지 않는다).
     다만 매퍼(`packages/openclaw-adapter/src/gateway/events.ts:227-229`)는 `usage.input`·`.output`·`.cost.total` 만 옮기고 **맞는 값인 `cacheRead`·`cacheWrite`·`totalTokens` 를 버린다** —
     활동 패널이 토큰을 보여 줘야 할 때 쓸 수 있는 유일한 실수치다. 계약(`RunUsage`)에 캐시 토큰 자리를 만들지는 Phase 2 판단. 출력 토큰·비용은 OpenClaw 쪽에 올린다.
     `totalTokens` 는 스냅샷 출력으로 만든 합이라 맞지 않는다 — 필드별 판정의 정본은 `docs/adr/0005-usage-values.md`.
2. **[문서·고침] 사람 메시지의 `@fin` 은 릴레이가 아니다.** 7.2 의 ⚠ 로 올렸다. 이 절의 옛 시나리오 표는 괄호로만 경고했는데, 그대로 따라 쓰면 병렬 런 2개가 되어 3회 상한을 넘긴다.
3. **[절차·고침] 런 1 앞에서 턴 상한을 0 으로 둔다.** 옛 7.2 는 상한을 언제 바꾸는지 적지 않아, 런 1 의 답에 멘션이 섞이면 예고 없이 런이 하나 더 생긴다.
4. **[절차·더함] 검증 탭의 배경 타이머 조임.** 7.1 의 ⚠. 2026-09-20 에 중지 검증이 이것 때문에 한 번 불발했다.
5. **[절차·더함] 로그인 토큰을 전사에 남기지 않고 넣는 법**(7.1) · **neo 의 CDP 로 스크린샷·콘솔·WS 를 보는 법**(7.1). 둘 다 옛 절차에 빠져 있었다.
6. **[남음·환경] 내장 cron 이 실연에 섞인다.** 이번엔 fin 것이 Gateway 기동 2분 뒤 1회($0.105). dev 프로필에서 실연을 반복하면 매주 한 번씩 섞인다(5.4-7 에 적었다).
   같은 날 Gateway 를 다시 껐다 켰을 때는 돌지 않았다 — 주간 몫은 한 번뿐이다.
7. **[절차·더함] 중지를 볼 때의 조건은 단순하게.** 7.4 의 ❗. 버블 길이로 게이트를 걸다 두 번 놓쳤다 — **「중지 버튼이 보이면 1.5초 뒤 누른다」** 면 충분하다.
   창을 넓히는 문장(「다섯 문장으로 길게」)과 탭 앞으로·바깥 폴링을 함께 쓴다.
8. **[남음] 캐시가 식으면 런 값이 비싸진다.** 같은 채널이라도 Gateway 를 재기동하면 claude-cli 캐시가 날아가 다음 런이 `cache_creation` 을 다시 쓴다
   (런 4 는 재기동 뒤라 `cw 57863`·**$1.199** — 이어 돌린 런 3 의 $0.208 과 견주면 6배다). 실연을 쪼개 돌릴수록 비싸진다 — **한 번 띄웠을 때 볼 것을 다 본다.**

### 7.7 곁들여 본 것 (모델 런 0회)

- **연결 점·배너가 실제 어댑터 상태를 보인다.** Gateway 만 `kill` 했을 때(wire 는 살아 있음):
  점 「Gateway 다시 연결 중」(주황)·「플러그인 끊김」(빨강), 배너 「OpenClaw 에 연결되지 않아 에이전트가 답하지 못합니다. 메시지는 저장됩니다.」 — **틀린 초록이 아니다**(web-t13 결함 6 수정이 실물에서도 맞다).
  서버 쪽은 `gateway connection closed; reconnecting`(code 1012) → `bridge down` 이 +3ms. 다시 띄우니 `bridge connected` → `gateway connected`(+80ms) → 세션 2개 복구(`messages` 4·2),
  화면은 배너가 내려가고 점 둘 다 초록으로 돌아왔다(5.5 의 S6b 와 같은 경로).
- **새로고침**: 로그인 유지(쿠키), 메시지 7행 복구, `relay_limit` 카드 유지, 끝에 붙은 채로 뜬다(`gap 0`) — web-t13 fix2 경로가 실물에서도 맞다.
  **구독도 복구된다**: 새로고침 뒤에 Gateway 를 죽였더니 배너·점이 실시간으로 바뀌었다(= 새 소켓이 `channel.subscribe` 를 마치고 `adapter.status` 를 받고 있었다).
- **멘션 작성기**: `@dev` 를 치면 「멘션 후보」 listbox 가 뜨고 **Enter 가 전송이 아니라 멘션 확정**에 쓰인다(web-t9 설계대로). 확정된 것은 진짜 노드다
  (`data-type="mention" data-id="a:<uuid>"`) — 저장 본문은 `<@a:uuid>` 토큰이 된다. 목록에서는 `data-mention` 칩으로 그려진다(이번 대화에서 4개).
- **에이전트 답의 평문 `@핸들` 은 서버가 토큰으로 바꾼다**: dev 가 쓴 `@fin` 이 저장 본문에서 `<@a:01a0bd23-902d…>` 였다(`PLAIN_MENTION_RE` → `tokenize`).
  그래서 릴레이 판정과 화면 칩이 사람 멘션과 같은 길을 탄다.
- **`relay_limit` 카드는 components v1 액션 로우다**: 시스템 메시지(`authorType: "system"`)에 `components.id = cmp_…`, `reusable: false`, `ttlMs: 1800000`, 아이템 1개
  `{ type: "button", id: "continue_relay", label: "이어가기", style: "primary" }`. 누르지 않았으므로 `componentState.consumed` 는 `[]` 로 남아 있다(누르면 런이 하나 더 돈다).
- **components TTL 이 실물에서 동작한다**(런 0회로 덤으로 확인): 카드가 선 지 30분이 지나자 「이어가기」가 **스스로 비활성**이 됐다(`disabled`, opacity 0.5, `pointer-events: none`).
  근거는 서버가 주는 `componentState.expiresAt`(`04:56:49` 생성 → `05:26:49` 만료)이고, 웹은 `ActionButtons` 의 `useExpired` 가 그 시각에 맞춰 한 번 다시 그린다 — `ttlMs` 를 웹이 직접 읽지는 않는다.
  **릴레이 정책과는 무관하다**(상한을 0↔1 로 되돌려도 비활성 그대로였다). 즉 「이어가기」는 **30분 안에 눌러야 한다.**
- **서술 속 멘션**(5.4-5): dev 도 fin 도 **일을 넘길 때만** `@` 를 썼다(dev → `@fin`, fin → `@dev`). 뜻 없는 멘션으로 런이 헛돌지 않았다 — 고친 `relayRules` 문구가 실물에서 먹는다.
- **콘솔·네트워크**: 런 1 구간·런 2·3 구간 모두 **JS 예외 0·`console.error` 0·4xx/5xx 0**. 나온 것은 Vite HMR `connecting/connected` 와 React DevTools 안내뿐이다.
- **작성기 한글 IME**(조합 중 Enter 가 전송하지 않는지)는 **확인하지 못했다.** CDP·자동화는 실제 IME 조합 이벤트를 만들지 못한다 — 사람이 두벌식으로 「안녕」을 치다가
  조합 중 Enter 를 눌러 확정만 되는지 한 번 봐야 한다.
- **채널 프롬프트·「새 대화」의 반영**은 모델 런이 더 필요해 이번 3회 예산에서 뺐다(ADR 0003 의 결론은 2026-09-15 실연에서 이미 확인했다 — 5.5).

### 7.8 정리·잔여물

3절 (f)에 웹 것을 더한다: Vite(5173) 종료, 열었던 탭·브라우저 정리, `data/` 의 실연 파일(`live-smoke.env`·`*.sqlite`·로그·프레임 덤프·`cdp-*.jsonl`)은 `data/` 안에 두거나 지운다 — 커밋하지 않는다.
⚠ 포트로 죽일 때는 `lsof -nP -iTCP:<포트> -sTCP:LISTEN -t` 로 **LISTEN 만** 고른다(그냥 `lsof -ti:3000` 은 그 포트에 붙은 Vite 까지 죽인다).

- `~/.openclaw-dev`: `extensions/dodok` 가 새 번들(`4b0ecc34…`)로 바뀜 · `openclaw.json` 백업 회전 · `state/openclaw.sqlite` ·
  `agents/{dev,fin}/agent/openclaw-agent.sqlite`(채널 세션 `agent:{dev,fin}:dodok:channel:01a0bd25-264c-71cb-a023-83a28648671f` 전사) · 내장 cron `fin` 실행 기록.
  끝에 `channels.dodok.channels` 는 해제했고 계정 `default` 는 그대로다.
- 워크트리 `data/`(ignored): 서버 로그·Gateway 로그·Vite 로그 · `frames-20260920.jsonl`(본문 포함) · `cdp-{run1,run23,run4,gwdown}.jsonl`(본문 포함) · `live-smoke.env`(시크릿) ·
  `live-smoke.sqlite` · `openclaw-device-dev.json` · `wire-cli-session.json`. **로그·덤프 8개 모두 토큰 값 0회**(`grep -c -F` 로 4종 확인).
- 중지 재시도 때 Gateway·서버·Vite 를 한 번 더 껐다 켰다. **DB(`live-smoke.sqlite`)와 `live-smoke.env` 를 그대로 두면 채널·에이전트·대화·로그인이 살아 있어** 준비 단계를 건너뛸 수 있다(약 1분).
  대신 claude-cli 캐시가 식어 다음 런이 비싸진다(7.6-8).

---

## 8. 승인(Phase 2 ①)을 실물에서 보기 — 절차

실물 dev Gateway 는 기본값에서 **승인을 한 번도 일으키지 않는다.** 샌드박스가 아닌 런타임 기본이 `security: "full"`·`ask: "off"` 이라
claude-cli 의 네이티브 툴이 **전부 자동 허용**되기 때문이다(승인 스파이크 2.1 — ADR 0001 6.5 가 승인 0회였던 이유도 이것이다).
승인 카드를 보려면 에이전트의 exec 정책을 「물어보기」로 **일시적으로** 바꾸고, 끝나면 반드시 되돌린다.

**웹이 떠 있어야 8.2 의 「볼 것」이 보인다** — 카드도 활동 탭도 웹 화면이다. 3절 (a)~(e) 에 더해 **7.1 「준비 — 3절에 더할 것」**을 그대로 밟는다(`APP_ORIGIN` 과 글자까지 같은 주소·`DODOK_API_ORIGIN` 프록시·브라우저는 `http://localhost:5173`·에이전트 등록). 그 뒤 8.1 로 간다.
**모델 런 없이** 승인을 일으키려면 8.1 로 정책을 켠 뒤 11절 가짜 CLI 가 `can_use_tool` 제어 요청을 내게 한다(「팀(Phase 4 ②) 실연」 절 「절차」) — 카드 대신 wire 이벤트로 본다.

### 8.1 켜기

3절 (c) 로 dev Gateway 를 띄운 **뒤에** 한 줄이면 된다. Gateway 재시작은 필요 없다(`Change will apply without restarting the gateway.`).

```bash
oc --dev config get  agents.entries.dev.tools.exec.ask     # 되돌릴 값을 먼저 적어 둔다(없으면 「없음」)
oc --dev config set  agents.entries.dev.tools.exec.ask always
```

- `oc` 는 3절의 약속(번들 CLI + `--dev`)이다. **2절 시크릿 규칙 그대로**: 이 키는 URL·토큰이 아니라 정책 값 하나라 `config get` 으로 읽어도 토큰이 딸려 나오지 않는다.
  `config get agents.entries.dev` 처럼 **묶음을 통째로 읽지 않는다**(토큰이 섞여 나온다). `~/.openclaw-dev/openclaw.json` 은 열지 않는다.
- 판정은 `resolveCliNativeToolApprovalPlan` 한 줄이다 — `security==="deny"` → deny, `ask==="off"` → (`full` 이면 allow, 아니면 deny), 그 밖 → **prompt**.
- 층은 셋이고 `security = min(설정, 파일)` · `ask = max(설정, 파일)` 로 합쳐진다. exec 승인 파일 층(`exec.approvals.get/set`)은 **건드리지 않는다** — 설정 층의 `always` 가 `max` 로 그대로 이긴다(스파이크 2.1 에서 실측).
- ⚠ `ask: "always"` 는 **`Read` 까지 포함해 모든 네이티브 툴**에 프롬프트를 건다. 한 턴에 승인이 여러 건 뜰 수 있다(스파이크에서 `Write`·`Read` 2건).
- 우리 정본 응답 경로(`mcp__openclaw__*` 의 `message` 툴)는 `PreToolUse` 를 그대로 지나므로 **승인이 걸리지 않는다** — 정책을 켜도 답은 평소대로 온다.
- `ask: "always"` 면 `allowedDecisions` 에서 **`allow-always` 가 빠진다**(`["allow-once","deny"]`). 카드에 「항상 허용」 버튼이 없는 것이 정상이다.

### 8.2 승인을 일으키는 프롬프트

스파이크에서 실제로 `Write` 1건 + `Read` 1건을 일으킨 문장이다(한 런에 2건 — 승인 카드가 둘일 때의 동작까지 볼 수 있다).

```
@dev 확인용 작업이야. 워크스페이스에 spike-approval.txt 파일을 만들고 hello 한 줄만 써.
그 다음 그 파일을 Read 도구로 읽어서 내용을 그대로 알려줘. 그 두 가지 말고는 다른 도구를 쓰지 마.
```

볼 것: 카드가 **두 자리**(메시지 흐름·활동 탭 맨 위)에 같이 뜨는가 · 카운트다운 · 「이번만 허용」 뒤 런이 이어지는가 · 「거절」 뒤 툴 오류로 이어지는가 ·
활동 탭 타임라인의 승인 행이 「허용됨」·「거절됨」으로 남는가. 만료까지 보려면 아무것도 누르지 않고 TTL(실물 기본 120초)을 넘긴다 — 모델 런 1회가 더 든다.

`dev:fake` 와 다른 점 둘:
- **미해결 승인의 재접속 복구**(세션 구독의 `approvalReplay`)는 실물에서만 끝까지 볼 수 있다. `dev:fake` 는 재기동하면 가짜 Gateway 도 상태를 잃어 런이 실패·승인이 「취소됨」이 된다(p2-t10 §5·걱정 3).
- 실물 TTL 은 120초라 `dev:fake` 의 20초보다 기다림이 길다.

### 8.3 되돌리기 — 반드시 한다

```bash
oc --dev config unset agents.entries.dev.tools.exec.ask        # 8.1 에서 값이 없었을 때
# 값이 있었으면: oc --dev config set agents.entries.dev.tools.exec.ask <적어 둔 값>
oc --dev config get   agents.entries.dev.tools.exec.ask        # 되돌아갔는지 확인
oc --dev config get   agents.entries.dev.tools                 # 8.1 전에 없던 키면 { "exec": {} } 빈 껍데기가 남는다
oc --dev config unset agents.entries.dev.tools                 # 빈 껍데기일 때만 — 다른 키가 보이면 두고 exec 만 본다
```

`set` → `unset` 은 `exec.ask` 만 지우고 그 위의 빈 객체(`tools.exec`)를 남긴다 — 설정 파일 크기가 시작값과 달라진다. 되돌린 뒤 `~/.openclaw-dev/openclaw.json` 의 **크기**(`stat -f %z`, 내용은 열지 않는다)가 8.1 전과 같은지 본다.
3절 (f) 정리에 이 줄들을 더한다. 되돌리지 않으면 **다음 실연이 모든 툴에서 멈춰** 서 있게 된다 — 승인을 누르는 사람이 없으면 런이 120초마다 만료로 끝난다.
`--dev` 프로필만 건드리므로 원격 프로필(`~/.openclaw`)에는 영향이 없다. `Config path not found … Nothing was changed.` 가 나오면 이미 깨끗하다는 뜻이다(정상).

---

## 9. 사람이 눈·귀로 확인할 것 (자동 검증이 원리상 못 재는 것)

아래는 브라우저 자동화·jsdom 이 **측정할 수 없는** 것들이다. 1차 브라우저 검증(p2-t10 §5)에 이어 **재검증(p2-t13)도 넷 다 못 쟀다** — 도구를 바꿔서 될 일이 아니라 사람의 눈·귀가 필요한 자리다.
재검증이 대신 무엇을 확인했고 **어떻게 흉내 냈는지**는 9.2 에 적어 뒀다 — 같은 방법을 그대로 쓰면 준비가 빨라진다.
`dev:fake` 로도 되고 실물로도 된다 — 8절로 승인을 한 번 일으킨 김에 같이 본다. 브라우저는 `http://localhost:5173` 고정(알림 권한은 **출처별**이라 주소가 다르면 다시 묻는다).

Phase 2 ④ 뒤: 옛 「알림 켜기」 토글은 사이드바 하단 「알림」 패널로 옮겨졌고, **이 기기에 푸시가 켜져 있으면 탭 안 승인 알림은 쉰다** — preview(14.1)에서 이 절을 볼 때는 14.3 끝의 순서(권한 허용 → 푸시 「끄기」)를 먼저 한다. 아래 고정 주소 5173(dev 서버, 서비스 워커 없음)에서는 「푸시 알림 켜기」가 권한만 받고 10초 뒤 「서비스 워커가 준비되지 않았습니다」로 끝나 「끄기」 버튼이 생기지 않는다 — 플래그가 없으므로 그대로 탭 안 알림이 돈다. 아래 「알림 켜기」는 그 패널의 「푸시 알림 켜기」(권한을 묻는 자리)로 읽는다.

⚠ **순서가 있다**: `granted` 를 **먼저** 본다. 권한을 한 번 `denied` 로 만들면 「알림 켜기」 토글이 영영 사라지고(설계대로), 같은 출처에서 다시 묻지 못한다.
되돌리려면 브라우저 사이트 설정에서 손으로 초기화해야 한다.

### 9.1 사람이 볼 것 — 여섯

| # | 볼 것 | 어떻게 | 통과 기준 |
| --- | --- | --- | --- |
| 1 | **권한 팝업 모양** | 사이드바 하단 「알림 켜기」를 누른다(그 전에는 한 번도 안 떠야 한다) | 버튼을 누른 **뒤에만** 팝업이 뜬다. 로그인·홈·채널·에이전트 화면에서는 0회 |
| 2 | **실제 알림 소리** | 권한 `granted` → 탭을 **진짜로** 숨긴다(다른 앱으로 전환·창 최소화) → 승인을 일으킨다 | 알림 1건과 함께 OS 알림음이 들린다 |
| 3 | **알림을 누르면 탭이 앞으로 오는가** | 위 알림을 클릭 | 브라우저 창이 앞으로 오고, 그 채널의 **활동 탭**(`/c/<id>/activity`)이 열린다. Phase 2 ④ 웹푸시가 그대로 이어받는 동작이라 한 번은 꼭 본다 |
| 4 | **잠금 화면 표시** | 알림이 뜬 상태에서 화면을 잠근다 | 잠금 화면에 배너가 보이는가(보인다면 제목·본문에 툴 인자가 새지 않는지 — 문구는 「승인 필요 — @dev 가 Write 를 실행하려 합니다」 / 「general 채널」뿐이어야 한다) |
| 5 | **VoiceOver 가 확정·만료 안내를 읽는가** | VoiceOver(⌘F5) 를 켜고 「이번만 허용」을 누른다 | 「선택: 이번만 허용」 줄이 읽힌다. 만료도 같다(「시간이 지나 답할 수 없습니다.」) |
| 6 | **같은 문구가 두 번 읽히는가** | 위를 **활동 탭이 열린 상태**에서 다시 한다 | 같은 승인의 카드가 흐름·패널 **둘**이라 같은 `aria-live` 문구가 같은 밀리초에 둘 삽입된다. 두 번 읽히면 한쪽을 `aria-hidden` 으로 죽일지 판단한다(현재는 둘 다 `polite`) |

DOM 사실은 이미 확인돼 있다: 확정·만료 안내는 **텍스트를 담은 채 새로 삽입되는** `<p aria-live="polite">` 다(기존 영역의 텍스트 변경이 아니라 조건부 렌더). 카운트다운 span 에는 `aria-live` 를 붙이지 않았다.
활동 탭이 열려 있으면 **같은 문구의 live 영역 둘(흐름·패널)이 같은 프레임에 삽입되는 것**까지 실측됐다(재검증, 만료 안내 두 개). 남은 물음은 「그래서 **두 번 읽히는가**」 하나다.
5 와 6 은 결정 뒤 초점을 **`aria-live` 줄이 아니라 결과 줄(「허용됨」)** 로 옮기도록 고친(D13) 뒤의 상태를 본다 — 기대는 「허용됨」 한 마디 + 「선택: 이번만 허용」 한 마디로 **서로 다른 두 마디가 한 번씩**이다.

곁들여 남은 것: **작성기 한글 IME**(조합 중 Enter 가 전송하지 않는지, 7.7) 도 사람만 볼 수 있다 — 같은 자리에서 한 번 본다.

### 9.2 재검증(p2-t13)이 확인한 것과 흉내 낸 방법

넷을 못 쟀다고 해서 알림 경로 전체가 미확인인 것은 아니다. **코드가 하는 일까지는 실측했다** — 다음 사람은 아래를 빼고 위 표의 여섯만 보면 된다.

| 이미 확인된 것(재검증 실측) | 값 |
| --- | --- |
| 다른 채널을 볼 때 승인 1건 → `Notification` | **정확히 1건**. 제목 「승인 필요 — @dev 가 Write 를 실행하려 합니다」 · 본문 「general 채널」 · `tag` `approval:<id>` · **툴 인자와 승인 제목은 안 실린다**(툴 이름만) |
| 알림 객체의 `show` 이벤트 | 생성 **1ms 안**에 발화(브라우저가 표시 단계로 넘겼다는 뜻) — 승인 2건 모두 |
| 알림 `onclick` | `window.focus()` **1회** 호출 + `/c/<채널>/activity` 로 이동, 활동 탭 선택·카드 2장 |
| 승인이 둘이면 | 알림 **2건**(승인마다 1건, `tag` 서로 다름) |
| 같은 채널을 보고 있을 때 | 보임 **0건** / 숨김 **1건** |
| 권한 `denied` | 토글이 **숨겨지고** 알림 0건, 카드는 정상, 예외 0 |
| 권한 팝업이 버튼 **전에** 뜨는가 | **0회** — 로그인·홈·에이전트·채널·활동·설정 여섯 화면 전부. 버튼을 누른 뒤에만 1회(스택 `NotifyToggle`) |

**흉내 낸 방법**(둘 다 CDP — 저장소 pnpm 스토어의 `playwright-core` 를 BrowserOS neo 의 CDP 포트 9110 에 얹어 썼다. 새 브라우저를 띄우거나 의존성을 더하지 않는다):

- **알림 권한**: 「알림 켜기」를 눌러 요청이 **1회 나가는 것**을 먼저 보이고(팝업은 배경 탭이라 큐에 걸려 `default` 로 남는다), 그 뒤 `Browser.grantPermissions` 로 `localhost:5173` 에 `notifications` 를 부여한다.
  `denied` 판은 `Browser.setPermission` 으로 만들고, 끝나면 **`Browser.resetPermissions` 로 `default` 로 되돌린다** — 프로필을 갈아 끼울 필요가 없다. 위의 ⚠ 순서 경고(`granted` 를 먼저)는 **사람이 손으로 팝업에 답할 때** 그대로 유효하다.
- **탭 숨김**: `document.visibilityState` 를 `hidden` 으로 덮어썼다(neo 는 배경 탭도 `visible` 로 유지한다). **진짜 숨김이 아니다** — 그래서 위 표 2·3(소리·클릭으로 탭이 앞으로)은 사람이 **진짜로** 다른 앱으로 전환해 봐야 한다.
- 뷰포트 변경·wire 소켓만 끊기도 같은 CDP 경로로 했다. 소켓만 끊을 때는 `/socket.io/` 짜리만 막고 **REST 와 Vite HMR 소켓은 건드리지 않는다** — 브라우저를 통째로 offline 으로 만들면 재접속 때 목록을 알아서 다시 받아 재현이 안 되고, HMR 을 막으면 페이지가 새로 고쳐져 「재접속」이 아니라 「새 탭」이 된다.

### 9.3 첨부(Phase 2 ③) — 사람이 볼 것

브라우저 검증(a3-t9)은 파일 선택을 숨은 `input` 에 파일을 넣는 것으로, 붙여넣기를 페이지 안에서 만든 `ClipboardEvent` 로 대신했다. 칩·사유 문구·「서식 없이 글만」 같은 **코드가 하는 일**은 그것으로 확인됐다.
**실제 OS 가 채우는 클립보드·드래그 데이터**는 자동화가 흉내 낼 수 없다 — 아래는 사람이 한 번 본다. `dev:fake` + 웹이면 된다(모델 런 0회, `CLAUDE.md` 「웹 손 확인」).

| # | 볼 것 | 어떻게 | 통과 기준 |
| --- | --- | --- | --- |
| 1 | **웹 페이지 이미지 붙여넣기** | 다른 탭에서 이미지를 우클릭 → 「이미지 복사」 → 작성기에 붙여넣기 | 칩이 생기고 올라간다. 보내면 메시지에 이미지가 그려진다 |
| 2 | **오피스·문서에서 이미지와 글을 함께 붙여넣기** | Word·한글·구글 문서에서 이미지와 글이 섞인 구간을 복사 → 붙여넣기 | 이미지가 파일로 실리는 앱이면 칩이 생긴다. 글은 **서식 없이** 들어온다 — 굵게·표·깨진 HTML 이 본문에 보이지 않는다. 이미지를 파일로 싣지 않는 앱이면 글만 들어오는 것이 정상이다. 앱마다 어땠는지 적는다 |
| 3 | **PNG 끌어다 놓기** | Finder 에서 PNG 를 작성기(칩 줄·버튼 위 포함) 위로 끌어 놓는다 | 커서가 「복사」 모양이고 칩이 생긴다 |
| 4 | **SVG·PDF 끌어다 놓기** | SVG(또는 PDF)를 작성기 위로 | 칩 없이 토스트 「이미지만 올릴 수 있습니다」. 서버 요청 0건 |
| 5 | **작성기 밖에 놓기** | 이미지를 메시지 목록 위로 끌어 놓는다 | 커서가 「놓을 수 없음」, 토스트 「이미지는 입력 칸에 놓아 주세요」. 브라우저가 이미지를 열어 앱을 떠나지 않는다 |
| 6 | **OS 파일 선택창** | 「이미지 첨부」 → 파일 창 | PNG·JPEG·GIF·WebP 만 고를 수 있다(`accept`). SVG 는 흐리거나 안 보인다 |
| 7 | **Safari 에서 크게 보기를 닫은 뒤 초점** | Safari 에서 이미지를 **마우스로** 눌러 크게 보기 → Esc → Tab | 초점이 그 이미지 버튼 자리에서 이어진다(`body` 로 떨어져 문서 처음부터 다시 돌지 않는다). Chromium·jsdom 은 클릭한 버튼에 초점을 줘 이 차이를 못 잰다(a3-t6 리뷰 n2) |

---

## 10. components v1(Phase 2 ②) 실물 확인 — 2026-09-23 결과

**상태(2026-09-23)**: 실제 dev Gateway·실제 플러그인 번들·실제 모델로 components 를 돌렸다. 모델 런은 사용자 승인 상한 그대로 **3회**.
**모델은 v1 스키마에 맞는 카드를 처음부터 만들어 냈고(10.3), 카드를 눌러 제출한 값을 다음 런이 읽고 일을 이어갔다(런 3 — Phase 2 완료 기준 통과).
그러나 모델 런 안에서 부른 `message` 툴 전송이 실물에서 매번 실패해, 에이전트는 스스로는 카드를 채널에 올리지 못했다(10.4 결함 1).**
런 3 은 모델이 만든 components 를 **운영자 `tools.invoke` 로 대신 보내** 올린 카드로 돌렸다(모델 런 0회, 10.2 (d)).
로그는 `data/phase2-live-20260923.log`(서버)·`data/dev-gateway.log`(Gateway·플러그인·claude-cli)·`data/wire-watch-20260923.log`(wire-cli `watch`). 커밋하지 않는다.

### 10.1 환경 실물

| 항목 | 값 |
| --- | --- |
| Gateway | OpenClaw **`2026.9.5 (f396007)`**(앱 자동 업데이트 — 저장소 핀·스파이크는 `2026.9.4`), 번들 Node 24.19.0, `:19001` loopback, token 인증. 기동 → `http server listening` 약 3s(플러그인 14개) |
| 플러그인 | `pack:plugin` 번들 sha256 `9520de1f…` = 설치본과 일치(이전 설치본 `4b0ecc34…`), `status: "loaded"`, `trust.reason: "provenance-invalid"` |
| 서버 | `:19100`, `OPENCLAW_TARGET=dev`, DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug`, 프레임 덤프 켬. 브리지 `ready` 는 서버 listen 뒤 약 8s(백오프 6번째 시도) |
| 웹 | Vite 8.3.0, **`:5180`**(아래), `DODOK_API_ORIGIN=http://127.0.0.1:19100`, 브라우저 BrowserOS neo |
| 모델 | `anthropic/claude-opus-5` + claude-cli, thinking high. 우리 런 3회 CLI 보고 비용 **$0.650·$1.239·$1.434**(합 $3.32) + 내장 cron $0.193 |
| 내장 cron | `cron list`: `skill-collection-review-dev` 다음 실행 **2026-09-23 09:47:31 KST**(Gateway 기동 2분 뒤 — 예정대로 1회 돌았다, 5 턴·$0.193), `…-fin` 다음 2026-09-27 13:44 KST |

**웹을 5180 으로 띄운 까닭**: 5173 은 같은 머신의 다른 프로젝트 Vite 가 쓰고 있었다(`strictPort` 라 겹치면 안 뜬다). 포트를 바꿀 때는 `APP_ORIGIN`·브라우저 주소·`--port` 셋을 같이 바꾼다.

### 10.2 절차 — 3절·7.1 에 더할 것

(a) 3절 (a)~(e) 를 그대로 하되 `data/live-smoke.env` 의 `APP_ORIGIN` 을 웹 포트와 맞춘다(`http://localhost:5180`). 프레임 덤프(`OPENCLAW_FRAME_DUMP_PATH`)도 켠다(7.1).

(b) 웹: `DODOK_API_ORIGIN=http://127.0.0.1:19100 pnpm -F @dodok/web dev --port 5180` — pnpm 11 은 스크립트 뒤 인자를 그대로 `vite` 에 넘긴다(`$ vite --port 5180`). 브라우저는 `http://localhost:5180`. 로그인은 7.1 의 `/@fs` 방법.

(c) 준비(런 0회): `/agents` → 「Gateway 에서 가져오기」 → `dev` 만 등록(`fin` 은 릴레이로 런을 더 쓴다) → 채널 만들기 → 설정 「멤버」에서 `@dev — C3-PO` 추가.
런 중 wire 이벤트는 `pnpm -s wire-cli http://127.0.0.1:19100 watch <채널 id> --watch-ms 3600000 > data/wire-watch-<날짜>.log` 을 백그라운드로 두면 시각표가 한 파일에 남는다.

(d) **모델 없이 `message` 툴을 두드리는 법**(10.4 결함 1 을 가를 때, 그리고 모델이 만든 카드를 올릴 때). 토큰은 env 로만, `--url` 대신 `--port`:

```bash
ARGS='{"action":"send","target":"channel:<채널 id>","message":"…","components":{…}}'   # 모델이 낸 인자는 run_events 의 TOOL_CALL_ARGS 에 그대로 있다
PARAMS=$(jq -cn --argjson a "$ARGS" --arg sk "agent:dev:dodok:channel:<채널 id>" '{name:"message", args:$a, sessionKey:$sk, agentId:"dev", idempotencyKey:"probe-1"}')
( . ./.env; env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_DEV_GATEWAY_TOKEN" PATH="$OCBIN:$PATH" \
    openclaw --dev gateway call tools.invoke --port 19001 --json --params "$PARAMS" )
# {"ok":true,"toolName":"message","output":{…"sent to dodok channel … (<messageId>)"…},"source":"core"}
```

⚠ 이렇게 올린 카드는 **그 세션의 모델이 모른다** — 모델의 전사에는 툴이 실패한 기록만 있다. 런 3 의 모델은 「툴은 두 번 다 에러였는데 카드는 도착했네요」라고 잘못 결론지었다. 다음 런의 답을 읽을 때 감안한다.

(e) **모달의 date 칸**: 자동화 도구의 키 입력(`type`·`press`)으로는 세그먼트가 채워지지 않았다(값 `""`). 네이티브 setter 로 넣고 `input`·`change` 를 쏘면 된다
(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(d,'2026-09-30')` → `validity.badInput=false`). 사람이 칠 때의 롤오버는 여전히 사람 몫(이월 그대로).

(f) 정리는 3절 (f) + 7.8. 이번에도 `channels.dodok.channels` 는 `Config path not found`(서버가 채널 설정을 쓰지 않았다 — 깨끗함). 승인 정책은 켜지 않았다(`agents.entries.dev.tools.exec.ask` unset 그대로).
**시크릿 개수 확인은 로그만이 아니라 `data/*.sqlite`·`data/frames-*.jsonl` 까지**(2절 ⚠).

### 10.3 런 표 (상한 3, 실제 3)

채널 `컴포넌트실연`(id `01a0cbbb-d86f…`), 멤버 `@dev`(C3-PO) 하나, 턴 상한 기본 4(에이전트가 하나라 릴레이 없음).

| # | 입력 | 런 id | 모델이 한 것 | 소요 | 결과 |
| --- | --- | --- | --- | --- | --- |
| 1 | `@dev 보고서 형식을 고르게 셀렉트 하나로 물어봐 줘. 선택지는 PDF·마크다운·HTML.` (브리프 문구 그대로) | `01a0cbbd-0fd9` | **`message` 가 아니라 OpenClaw 내장 `mcp__openclaw__ask_user`** 를 골랐다 — `questions:[{id:"report_format", header:"보고서 형식", options:[마크다운 (Recommended)·PDF·HTML, 각 description]}]`. 전달이 `ask_user prompt delivery failed \| dodok: bridge is not running` 으로 실패하자 평문으로 되물었다 | 13.3s | done·plugin. **카드 0** (결함 1·2) |
| 2 | `@dev message 툴의 components 로 카드 하나만 보내 줘. 보고서 형식을 고르는 셀렉트(PDF·마크다운·HTML)와, 새 작업을 받는 모달(제목 필수·설명·기한)을 함께. ask_user 는 쓰지 마.` | `01a0cbbf-6816` | `mcp__openclaw__message` 에 **v1 에 맞는 components** 를 실어 2번 보냈다(아래). 둘 다 플러그인 검증 통과(`tool-send … hasComponents:true, ok:true`) 뒤 `dodok: account "default" bridge is not running` 으로 실패. 사이에 Bash 6번으로 원인을 찾았다(`openclaw status`·`lsof :19100`·`~/.openclaw-dev` 탐색) | 85.0s | done·plugin. 「카드는 만들었는데 전송이 막혔습니다」 + 카드 내용을 글로 설명. **카드 0** (결함 1) |
| — | (모델 런 아님) 런 2 의 첫 components 를 10.2 (d) 로 전송 | — | — | 서버 `message.created` 는 플러그인 `tool-send` 뒤 약 7ms | 카드가 `@dev` 이름으로 채널에 섰다 — `components.id = cmp_01a0cbc3-8f8d…`, 셀렉트·모달 둘 다 |
| 3 | 위 카드의 **모달 「새 작업 등록」 제출** — 제목 「9월 배포 회고 보고서」, 설명 「9월 배포 3건의 장애·롤백을 정리하고 재발 방지책을 제안해 주세요. 분량은 A4 두 장 이내.」, 기한 2026-09-30 | `01a0cbc5-2ea2` | 받은 입력: `[dodok interaction] user=@owner kind=modal component=cmp_01a0cbc3-… item=new_task` + 「@owner 님이 "새 작업 등록" 양식을 제출했습니다.」 + `- 제목: …`·`- 설명: …`·`- 기한: 2026-09-30`. 첫 툴이 `memory_search {"query":"9월 배포 장애 롤백 인시던트 기록"}` | 24.4s | done·plugin. **통과** — 답이 세 값을 그대로 옮기고(「기한: 2026-09-30 (오늘 기준 7일)」) **같은 카드의 형식 셀렉트가 아직 미선택**임을 짚어 고르라고 한 뒤, 재료 출처를 물었다 |

**모델이 낸 components(런 2, 두 번 모두 같은 구조 — 섹션 문구만 조금 다름)**:
`blocks = [section("**보고서 형식을 골라 주세요.** …"), actions{id:"format_row", items:[select{id:"report_format", placeholder:"보고서 형식 선택", options:[markdown·pdf·html, 각 label·description]}]}, separator, section("**새 작업을 넘기실 것이 있나요?** 아래 버튼으로 …")]`,
`modal = {id:"new_task", title:"새 작업 등록", triggerLabel:"새 작업 등록", fields:[text{id:"title", required:true, placeholder}, textarea{id:"description", required:false}, date{id:"due_date", required:false}]}`, `ttlMs: 1800000`.
- **스키마 위반 0**: `id` 모두 유일·패턴 맞음 · 셀렉트는 **자기 액션 로우에 혼자**(버튼 ≤5 **또는** 셀렉트 1 을 지켰다) · 옵션 3(≤25) · 필드 3(≤5) · 모달 트리거를 **따로 버튼으로 만들지 않고 `triggerLabel` 로** 썼다(설계 그대로).
  `components: v1 스키마 위반 — …` 문구는 한 번도 나오지 않아 **그 문구가 모델에게 쓸모 있는지는 이번에도 못 쟀다**.
- 요청하지 않은 것도 알맞게 채웠다: 옵션 `description`, 모달 칸 `placeholder`, `message` 에 카드 제목(→ 서버 본문·알림 대체 텍스트 자리).
- 스크린샷 `…/screens/t11-1-card-from-model-components.png`(카드: 셀렉트는 옵션 6개 이하라 라디오 목록 + 「보내기」 비활성·「하나를 고르세요」, 모달 트리거), `t11-2-modal-filled.png`, `t11-3-result-line.png`(원장 폴더, git 제외).

### 10.4 틀린 것·고칠 것

1. **[결함·높음] 모델 런 안의 `message` 툴 전송이 실패한다 — `dodok: account "default" bridge is not running`.** 브리지는 `connected`(어댑터 상태·웹 점 초록), 정본 답(`deliver`)도 같은 브리지로 정상 도착했다.
   → **원인 확정·고침·실물 확인 완료(2026-09-23, 12절)**: 9.5 가 번들을 같은 realm 에서 두 번 평가하고 모델 런의 `handleAction` 이 `startAccount` 를 돌지 않은 두 번째 인스턴스로 간다(c2-t14, 모델 런 0회). 브리지·상관관계를 전역 레지스트리로 옮겼다 — ADR 0004. 실물 확인은 11절 하네스(아래 추정은 기록으로 남긴다).
   - **재현**: 3절대로 띄우고 채널에 `@dev message 툴의 components 로 카드 하나만 보내 줘 …`(런 2). Gateway 로그에 `dodok:tool-send {"action":"send","accountId":"default",…,"hasComponents":true,"ok":true}` 가 찍히고
     wire 에 `TOOL_CALL_RESULT {"content":"dodok: account \"default\" bridge is not running","ok":false}` 가 온다. 로그 줄은 `packages/openclaw-plugin/src/channel.ts` 의 `handleAction` — `bridges.get(accountId)` 가 `undefined`.
   - **가른 것**: 같은 인자를 운영자 `tools.invoke`(10.2 (d))로 보내면 **같은 `handleAction` 이 브리지를 찾고 성공한다**. 즉 실패는 **claude-cli → MCP 루프백으로 들어온 툴 호출에서만** 난다.
   - **추정 원인(확정 아님)**: 그 경로가 받는 채널 플러그인 객체가 브리지를 띄운(`startAccount`) 인스턴스와 다르다 — `bridges` 는 모듈 스코프 `Map` 이라 모듈이 두 번 평가되면 빈 쪽을 본다.
     (로그 머리가 `[dodok] …` 와 `dodok:tool-send` 로 다른 것은 증거가 아니다 — 앞은 런타임 `logger`, 뒤는 `console.info` 를 쓰는 코드 차이다.) 스파이크(ADR 0002 5.2, **2026.9.4**)에서는 모델 런(B1)의 같은 경로가 됐으므로
     **2026.9.5 로 바뀐 앱이 원인일 공산이 크다**(버전 드리프트 — 불변 규칙의 정확 핀이 dev 환경에서 깨져 있었다). 고치는 길은 둘: 브리지 레지스트리를 `globalThis[Symbol.for("dodok.bridges")]` 처럼 인스턴스를 넘어 공유하거나, dev Gateway 를 `2026.9.4` 로 맞춰 먼저 재현을 가른다.
   - **영향**: 실물에서 **에이전트가 카드를 스스로 보낼 수 없다** — components v1 전체가 dev 실물에서 쓸 수 없는 상태다. 가짜 Gateway·통합 시나리오는 플러그인을 한 인스턴스로 불러 이 경로를 못 본다.
2. **[결함·중간] `ask_user` 가 dodok 채널에서 깨진다.** 코어 `ask_user` 는 질문을 채널 `outbound.sendText` 로 보내는데(`ask-user-tool-*.mjs` → `sendDurableMessageBatchCore`), 우리 `sendText` 도 `bridges.get(…)` 이 비어
   `dodok: bridge is not running` 을 던진다(결함 1 과 같은 뿌리로 보인다). 설령 브리지를 찾아도 `sendText` 는 **텍스트만** 보내고 `agentId: "unknown"` 이라 질문의 **선택지 컨트롤이 없다** — dodok 은 `ask_user` 를 카드로 그릴 길이 없다.
   → 이어서 볼 곳: 첫 층(`sendText` 도 두 번째 인스턴스) → ADR 0004, 뒷 두 층(`agent not found`·선택지 컨트롤 없음) → `docs/plan.md` 8장 「플러그인·OpenClaw 버전」.
3. **[관찰·중요] 모델은 `components` 보다 `ask_user` 를 먼저 고른다(발견 가능성).** 「셀렉트로 물어봐 줘」처럼 자연스러운 요청에 모델은 `message` 툴의 components 가 아니라 `ask_user` 를 불렀다(런 1).
   `components` 는 `message` 툴 스키마의 한 속성일 뿐이라 「사용자에게 묻는다」는 의도에 먼저 걸리는 쪽은 이름부터 그 일인 `ask_user` 다. 결함 1·2 를 고쳐도 **우리 카드가 실무에서 잘 안 쓰일 수 있다**.
   손댈 곳: `components-schema.ts` 의 `COMPONENTS_DESCRIPTION`(「사용자에게 선택·입력을 받을 때는 이것을 쓴다」를 앞에), 채널 프롬프트, 또는 `ask_user` 를 dodok 이 카드로 받아 그리는 길(결함 2) — 어느 쪽으로 갈지는 판단이 필요하다.
4. **[관찰] 막히면 모델이 자기 환경을 뒤진다.** 런 2 에서 모델은 전송 실패 뒤 Bash 6번으로 `openclaw status`·`lsof`·`~/.openclaw-dev` 설정 파일을 살폈고, 그 결과(`BRIDGE_TOKEN` 값 1회 포함)가 런 이벤트로 저장·표시됐다(2절 ⚠, 10.6).
   그리고 끝에 `dodok.capabilities.inlineButtons` 를 켜야 한다는 **확인되지 않은 처방**을 사용자에게 내놓았다(우리 플러그인에는 그런 설정이 없다).
5. **[관찰·경미] 운영자가 보낸 카드가 앞 런에 붙는다.** 10.2 (d) 로 보낸 카드 메시지의 `runId`·`replyTo` 가 **이미 끝난 런 2** 와 그 사람 메시지로 채워졌다 — 플러그인 상관(세션키당 마지막 인바운드)이 운영자 전송에도 붙는다. 실사용 경로는 아니다.
6. **[관찰·경미] `component_interactions.delivered_at` 이 늘 null 이다.** 제출이 다음 런으로 잘 넘어갔는데도 비어 있다 — 스키마(`schema.sqlite.ts:231`)에만 있고 쓰는 코드가 없다. 쓸지 지울지는 뒤에 정한다.

### 10.5 곁들여 본 것 (모델 런 0회)

- **셀렉트 「보내기」 확정식**은 실물 카드에서도 그대로다 — 고르기 전 「보내기」 비활성 + 「하나를 고르세요」. 런이 모자라 셀렉트 제출은 하지 않았다(런 3 을 모달에 썼다).
- **모달**: 트리거 → 대화상자 「새 작업 등록」, 제목(필수 표시)·설명(textarea)·기한(date, 한국어 로캘 세그먼트) — 모델이 준 칸 셋 그대로. 제출 뒤 대화상자가 닫히고 트리거가 「이미 처리되었습니다」로 비활성.
- **결과 줄**: 카드 안에 「@owner — 새 작업 등록: 제목: … · 설명: … · 기한: 2026-09-30」. **새로고침 뒤에도 남는다**(결과 줄·「이미 처리되었습니다」 둘 다).
- **콘솔**: 런 1~3 과 새로고침 구간에서 **앱 예외 0**(`error`·`unhandledrejection`·`console.error` 가로채기).
- **지연**(wire-cli `watch` 시각):

| 측정 | 런 1 | 런 2 | 런 3 |
| --- | --- | --- | --- |
| 사람 메시지(또는 제출) 서버 수신 → `RUN_STARTED` | 571ms(ackMs 547 — 새 세션 구독 포함) | 129ms(ackMs 125) | 72ms(ackMs 67) |
| `RUN_STARTED` → 첫 툴 호출 | 6.0s(`ask_user`) | 12.6s(`message`) | 8.9s(`memory_search`) |
| `RUN_STARTED` → 정본 `message.created` | 12.8s | 84.9s(툴 8회) | 24.3s(툴 2회) |
| 제출 서버 수신 → 카드 `message.updated`(consumed) | — | — | 3ms |

  `tools.invoke` 로 보낸 카드: 플러그인 `tool-send` → 서버 `message.created` 약 7ms. **모달 제출 클릭 → 서버 수신은 재지 못했다** — 자동화 도구의 클릭이 정착 대기로 몇 초 늦게 실제로 눌려, 도구 쪽 시각이 믿을 수 없었다.

### 10.6 정리·잔여물

- 서버·Gateway(`shutdown completed cleanly`)·Vite(5180)·wire-cli `watch` 를 내렸다. 5173 의 다른 프로젝트 Vite 는 건드리지 않았다. 브라우저 탭은 닫았다.
- `~/.openclaw-dev`: `extensions/dodok` 새 번들(`9520de1f…`) · `openclaw.json` 백업 회전 · `state/openclaw.sqlite` · `agents/dev/agent/openclaw-agent.sqlite`(채널 세션 `agent:dev:dodok:channel:01a0cbbb-d86f-7162-8d82-5bb4c06b238c` 전사) ·
  내장 cron `dev` 실행 기록. `channels.dodok.channels` 는 없음(원래 없었다), 계정 `default`·승인 정책 그대로.
- ⚠ **`BRIDGE_TOKEN` 값이 새어 들어간 곳**(런 2 에서 모델이 Bash 로 읽음): 서버 DB `run_events` 1행 → **가렸다**(`[REDACTED-BRIDGE-TOKEN]`, WAL 체크포인트·VACUUM 뒤 0회) · 프레임 덤프 → **지웠다** ·
  claude-cli 전사 `~/.claude/projects/-Users-jang2162--openclaw-dev-workspace/<세션>.jsonl` 1회 → **남아 있다**(모델 제공자에게도 이미 갔다). 로컬 루프백 브리지 토큰이지만 **교체를 권한다**(`.env` 와 dev 계정 토큰을 함께 — 3절 (e) 의 패치 파일 방법).
- 워크트리 `data/`(ignored): 서버·Gateway·Vite·wire 로그, `live-smoke.env`(시크릿), `live-smoke.sqlite`(가림), `openclaw-device-dev.json`, `wire-cli-session.json`, `cron-list.json`, `run2-message-args.jsonl`(모델이 낸 `message` 인자). **Gateway 토큰은 전부 0회, `BRIDGE_TOKEN` 은 가린 뒤 0회**.

---

## 11. 런 0회 하네스 — 모델 없이 모델 런의 툴 경로를 두드리기 (c2-t14, ADR 0004)

**왜**: 가짜 Gateway 통합 테스트는 플러그인을 한 인스턴스로 불러, 「모델 런의 툴 호출이 어느 플러그인 인스턴스로 가는가」 같은 실물 경로를 원리상 못 본다(ADR 0004 4절).
여기 둘은 **실제 Gateway 의 루프백 `/mcp`** 를 두드리되 모델을 부르지 않는다(비용 0). OpenClaw 버전을 올렸을 때, 플러그인의 툴·아웃바운드를 고쳤을 때 한 번 돌린다.

| 하네스 | 붙는 곳 | 어느 인스턴스로 가나 | 쓸모 |
| --- | --- | --- | --- |
| 11.2 `attach.grant` | 모델 런이 쓰는 바로 그 루프백 서버(세션 grant) | 세대 1(`startAccount` 를 돈 쪽) — run 문맥이 없다 | 툴 노출·`components` 스키마 확인. **결함 1 은 재현하지 않는다** |
| 11.3 가짜 claude CLI(정본) | 루프백 서버(run grant — 진짜 모델 런과 같다) | 세대 2(prepared-runtime) — 모델 런과 같다 | **결함 1·2 재현, 고친 뒤 합격 확인** |

Claude 러너 에이전트(OpenClaw 를 거치지 않는다)의 하네스는 이 절이 아니라 「Claude 러너 런 0회 하네스」 절이다.

`openclaw --dev mcp serve` 는 **다른 경로**다(외부 MCP 클라이언트용 채널 브리지, 툴 9개에 `message`·`components` 없음) — 이 목적에 쓰지 않는다.

### 11.1 준비 (3절 (a)~(e) 그대로 + 하네스용 채널)

```bash
# OCBIN 은 3절 머리의 스크래치 설치본
oc() { env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_GATEWAY_TOKEN PATH="$OCBIN:$PATH" openclaw "$@"; }
oc --version                                   # 적는다
# 3절 (a) 채널 설정 지우기 · (b) pack:plugin + plugins install --force(설치본 sha = 빌드본 sha) · (c) Gateway · (d) data/live-smoke.env + 서버 · (e) adapter/status connected
W() { (set -a; . data/live-smoke.env; set +a; export DODOK_LOCAL_TOKEN="$LOCAL_AUTH_TOKEN"; pnpm -s wire-cli http://127.0.0.1:19100 "$@"); }
W create-channel harness-$(date +%m%d%H%M); W channels      # 새 채널 id 를 CH 에
W add-agent $CH dev dev
```

⚠ **하네스용 채널은 따로 만든다.** 가짜 CLI 런은 채널 세션에 **가짜 claude 세션 id**(`00000000-0000-4000-8000-00000000c214`)를 남긴다. 같은 채널에서 나중에 진짜 모델 런을 하면 `--resume` 이 그 id 를 찾다 실패할 수 있다.

`data/args.json` 은 `message` 툴 인자다 — `{"action":"send","target":"channel:<CH>","message":"…","components":{…}}`. 모델이 낸 인자는 서버 `run_events` 의 `TOOL_CALL_ARGS` 에 그대로 있다(10.3 의 카드면 충분하다).

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

### 11.2 `attach.grant` — 툴 노출·스키마 확인용

```bash
umask 077
( . ./.env; env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_DEV_GATEWAY_TOKEN" PATH="$OCBIN:$PATH" \
    openclaw --dev gateway call attach.grant --port 19001 --json \
    --params "{\"sessionKey\":\"agent:dev:dodok:channel:$CH\",\"agentId\":\"dev\",\"ttlMs\":1800000}" ) > data/grant.json
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

2026-09-23: `tools/list` 34개(`message`·`ask_user` 포함), `components` 키 `blocks·id·modal·reusable·text·ttlMs`.
⚠ `attach.revoke` 는 토큰을 `--params` 인자로 넘겨 ps 에 잠깐 남는다 — 그날은 revoke 대신 Gateway 종료로 없앴다.

### 11.3 가짜 claude CLI — 결함 1·2 재현·합격 확인(정본)

Gateway 는 claude-cli 백엔드를 **PATH 의 `claude`** 로 띄운다. 가짜 `claude` 를 PATH 앞에 둔 Gateway 를 띄우고 채널에 `@dev` 를 보낸다. 가짜 CLI 는 `--mcp-config` 와 env(`OPENCLAW_MCP_TOKEN`·`OPENCLAW_MCP_CLI_CAPTURE_KEY`)로
**run grant** 를 받아 루프백에 `message`(와 `ask_user`)를 한 번씩 부르고 끝낸다. 가짜 CLI 는 **레포에 파일로 두지 않는다**(실행 파일이 레포에 있으면 진짜 `claude` 를 가릴 수 있다) — 아래 11.4 를 스크래치 디렉터리에 만든다.

```bash
SP=$(mktemp -d); mkdir -p $SP/fakebin
cp data/args.json $SP/fake-args.json                                            # message 인자
echo '{"questions":[{"id":"q","header":"형식","question":"골라 주세요","options":[{"label":"A","description":"a"},{"label":"B","description":"b"}]}]}' > $SP/fake-ask-user.json   # 있으면 ask_user 도 부른다
# 11.4 스크립트를 $SP/fakebin/claude 로 저장한 뒤:
REAL=$(whence -p claude 2>/dev/null || command -v claude)                     # zsh 에서 alias·함수면 command -v 는 경로가 아니다
[[ $REAL == /* && -x $REAL ]] && sed -i '' "s#__REAL_CLAUDE__#$REAL#" $SP/fakebin/claude && chmod +x $SP/fakebin/claude \
  || echo "claude 절대경로가 아니다(REAL=$REAL) — REAL 에 직접 넣고 다시"
kill $(lsof -nP -iTCP:19001 -sTCP:LISTEN -t)                                   # 지금 Gateway
( . ./.env
  env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_DEV_GATEWAY_TOKEN" NODE_OPTIONS=--stack-trace-limit=60 \
      PATH="$SP/fakebin:$OCBIN:$PATH" \
      nohup openclaw --dev gateway run --dev --auth token --port 19001 --bind loopback >> data/dev-gateway.log 2>&1 < /dev/null & )
# 서버 로그에 bridge 가 다시 connected 가 된 뒤
W send $CH "@dev 가짜 CLI 프로브" --watch-ms 20000
jq -c 'select(.isRun != false) | del(.argv,.envKeys)' $SP/fake-out/fake-claude.jsonl    # tools/call message 결과 원문
grep "dodok:probe\|dodok:tool-send" data/dev-gateway.log | tail                       # probe 번들이면 어느 세대인지
```

**합격 기준**(ADR 0004 6절):
- `tools/call message` → `sent to dodok channel <CH> (<messageId>)`. (고치기 전: `{"content":[{"type":"text","text":"dodok: account \"default\" bridge is not running"}],"isError":true}`)
- 서버에 카드 `message.created` 가 오고, 그 메시지의 **`runId` 가 그 가짜 런**이고 **`replyTo` 가 방금 보낸 사람 메시지**다 — 상관관계(`correlations`)까지 공유됐는지를 이것으로 본다. 카드만 오고 `runId` 가 비면 반쪽이다.
- `ask_user` 는 다음 층 `agent not found`(결함 2 의 뒷반쪽, `docs/plan.md` 8장 이월)에서 막히는 것이 **정상**이다. 고치기 전에는 `ask_user prompt delivery failed | dodok: bridge is not running`.
- 런 정본은 가짜 답 `FAKE_CLI_DONE` → `message.created` · `RUN_FINISHED`(usage 0·cost 0).

**가짜 CLI 가 걸린 곳 셋**(다음 사람용 — c2-t14 는 1~3회차 런이 `RUN_ERROR "Claude CLI live session exited unexpectedly without a terminal result."` 로 끝났다):
1. 툴을 너무 일찍 부르면 `Native tool authority is not initialized` 가 난다. CLI 가 `system/init` 레코드(`tools` 배열)를 먼저 stdout 에 내야 authority 가 잡힌다.
2. Gateway 는 stdin 으로 `control_request{subtype:"initialize"}` 를 먼저 보내고 `control_response` 를 기다린다. 그다음에 `user` 레코드가 온다. 순서는 **control_response → user 수신 → system/init → 툴 호출 → assistant·result**.
3. `-p` 가 없는 호출(버전·인증 확인)은 진짜 `claude` 로 넘긴다 — 모델을 부르지 않는다.

**세션을 잴 때 걸리는 곳 셋**(ADR 0006 스파이크·17절 스레드 실연):
1. **가짜 CLI 는 claude 전사 파일을 만들지 않는다** — 같은 세션의 둘째 턴은 Gateway 로그 `cli session reset: reason=missing-transcript` 로 매번 새 CLI 세션이 된다. `--resume` 경로는 이 하네스로 못 잰다.
   같은 세션에 턴 둘을 겹쳐 보내지 않는다 — 큐잉된 둘째 턴은 살아 있는 프로세스로 가는데, 첫 턴 뒤 끝나는 가짜 CLI 는 `Managed CLI live session is no longer reusable` 로 실패한다. 세션 id 는 argv 의 `--session-id`/`--resume` 값을 그대로 되돌린다.
2. **시스템 프롬프트는 argv 가 아니라 stdin `control_request { subtype: "initialize", appendSystemPrompt }`** 로 온다 — argv 만 보면 「채널 프롬프트가 안 들어갔다」로 오판한다.
3. **zsh 에서 세션 키를 셸 변수로 이을 때는 `${B}:thread:${T}`** 로 쓴다 — `$B:thread:…` 는 `:t` 수식자로 먹혀 `${B:t}hread…` 가 된다. 깨진 키로 부른 `chat.history` 는 오류 없이 빈 결과를 돌려준다.

**끝나면**: 가짜 PATH 없이 Gateway 를 다시 띄우거나(3절 (c)) 내린다. `rm -rf $SP`. probe 를 붙였으면 11.1 대로 되돌린다. 하네스 채널은 진짜 모델 런에 쓰지 않는다.

### 11.4 가짜 claude CLI 스크립트

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
  const r = spawnSync("__REAL_CLAUDE__", argv, { stdio: "inherit" }); // 11.3 의 sed 가 진짜 claude 경로로 바꾼다
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

### 11.5 첨부 재기 (Phase 2 ③ — 계획 태스크 11 의 1단계)

11.3 하네스에 세 가지를 더해 첨부 경로를 모델 없이 두드린다. 스파이크(`.superpowers/sdd/2026-09-23-phase2-attachments-spike/report.md` 「절차 요지」)가 11.4 를 넓혀 쓴 것을 이 문서 모양으로 다시 적었다. **2026-09-23 a3-t11 이 처음 돌렸다(13절)** — 그때 고친 곳·보탠 것은 이 절 끝 ⑤ 에 있다.
새 번들 설치는 3절 (b) 대로 한다 — **Gateway 를 먼저 내리고**, 설치 뒤 설치본 sha 가 빌드본과 같은지 본다.

**① 가짜 CLI 가 받은 이미지를 잰다.** 11.4 스크립트의 stdin 처리에서 `log({ event: "stdin-record", … })` 한 줄을 아래로 바꾼다. claude-cli 는 이미지를 base64 블록이 아니라 프롬프트 끝 `@<ws>/.openclaw-cli-images/<sha256>.<ext>` 로 받는다(스파이크 1-7). 그 파일의 크기·권한·앞 8바이트만 적는다 — **base64 본문과 경로는 적지 않는다.**

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

**② 최종 응답을 파일로 바꾼다.** 11.4 의 `FAKE_CLI_DONE` 두 자리(`assistant` 의 `text`, `result` 의 `result`)를 `FINAL` 로 바꾸고, 툴 호출은 `fake-args.json` 이 있을 때만 한다.

```js
const FINAL_FILE = __dirname + "/../fake-final.txt";
const FINAL = fs.existsSync(FINAL_FILE) ? fs.readFileSync(FINAL_FILE, "utf8") : "FAKE_CLI_DONE";
// startTurn 안: const args = … 앞에서 if (!fs.existsSync(__dirname + "/../fake-args.json")) { log({ event: "no-tool-call" }); } else { …툴 호출… }
```

⚠ 가짜 CLI 런은 `message` 툴을 써도 최종 텍스트가 **억제되지 않고** `FINAL` 이 따로 한 메시지로 온다. 9.5 에서는 실제 모델 런도 같다 — 채널·스레드 모두 최종 답이 올라왔다(17.5). ADR 0002 가 9.4 에서 잰 억제(`terminalReply.disposition: "silent"`)는 이 하네스로 재지 않는다.

**③ 준비물.** 툴이 읽을 파일은 **Gateway 워크스페이스 안**에 둔다(dev: `~/.openclaw-dev/workspace`). 밖이면 `tools.fs.workspaceOnly` 에 따라 「허용되지 않은 경로」가 날 수 있다.

```bash
WS=~/.openclaw-dev/workspace; mkdir -p $WS/a3-harness
cp <아무 PNG> $WS/a3-harness/chart.png; cp <아무 PDF> "$WS/a3-harness/월간 보고서.pdf"
shasum -a 256 $WS/a3-harness/*; stat -f '%z %N' $WS/a3-harness/*          # 크기·sha 를 적어 둔다
```

**④ 차례와 합격 기준**(계획 `docs/superpowers/plans/2026-09-23-attachments.md` 태스크 11 의 1). 런마다 `$SP/fake-args.json`·`fake-final.txt` 를 바꾸고 `@dev` 를 한 번 보낸다. 사람 이미지는 **웹 작성기로** 보낸다 — `wire-cli` 는 첨부를 보내지 못한다(7.1 준비대로 웹을 띄운다).

| # | 런 | 준비 | 합격 |
| --- | --- | --- | --- |
| a | **인바운드** — 사람 이미지 | `fake-args.json`·`fake-final.txt` 없음. 웹에서 PNG 한 장 + `@dev 첨부 프로브` | `stdin-record` 의 `atRefs` 가 하나, `magic` 이 `89504e470d0a1a0a`, `size` 가 올린 원본과 같다(`contentKind:"string"`, `blocks:[]`). Gateway 로그 `[dodok] inbound-media` 가 `images:1`·`reasons:[]` |
| b | **툴 `media`** — PNG·PDF·한국어 이름 | `fake-args.json` = `{"action":"send","target":"channel:<CH>","message":"첨부 둘","mediaUrls":["<WS>/a3-harness/chart.png","<WS>/a3-harness/월간 보고서.pdf"]}` | `tools/call message` 가 `sent to dodok channel …`. 채널 메시지에 첨부 둘이 **그 순서로**, 이름 `chart.png`·`월간 보고서.pdf` 그대로. 내려받은 바이트의 sha 가 ③ 과 같다. `dodok:tool-send-media` 가 `uploaded:2`·`failed:0` |
| c | **최종 응답 `MEDIA:` 줄** | `fake-args.json` 없음. `fake-final.txt` 세 줄 — `결과`, 빈 줄, `MEDIA:<WS>/a3-harness/chart.png`(`printf '결과\n\nMEDIA:%s\n' <경로> > $SP/fake-final.txt`) | 채널 메시지 본문이 `결과` 이고 **`MEDIA:` 가 없다**, 첨부 하나. `[dodok] deliver-media` 가 `uploaded:1`. 서버 로그에 `gateway snapshot media lines dropped` 가 없다(플러그인 정본이 먼저 왔다는 뜻 — 스펙 11장 Ruling 2) |
| d | **미디어만 있는 응답** | `fake-args.json` 없음. `fake-final.txt` 한 줄 — `MEDIA:<WS>/a3-harness/chart.png` | 채널에 **본문 없이** 첨부만 온다. 채널 어디에도 호스트 경로(`/Users/`·`~/.openclaw`)가 없다 |
| e | **실패 문구**(선택) | b 의 경로 하나를 없는 파일로 | 툴 결과가 `dodok: 첨부를 보내지 못했습니다 — <이름>: 파일을 찾을 수 없음`. 호스트 경로가 툴 결과·채널에 없다(원문은 `dodok:tool-send-media` 의 `details` 에만, 가려서) |

`<CH>`·`<WS>` 는 실제 값으로 바꿔 쓴다. c·d 가 통과하면 스파이크 2-10 의 결함(미디어 전용 응답이 `MEDIA:/호스트/경로` 를 채널에 드러냄)이 실물에서 닫힌 것이다.
이 표는 플러그인 `channel.ts` 배선(순수 함수를 부르는가)의 합격 기준도 겸한다 — 단위 테스트는 그 우회를 못 잡는다(`docs/plan.md` 8장 이월).

**끝나면**: 11.3 대로 되돌리고, `rm -rf $WS/a3-harness`. 플러그인이 저장한 원본(`~/.openclaw-dev/media/inbound/`)·CLI 복사본(`<ws>/.openclaw-cli-images/`)·스테이징(`<ws>/media/inbound/openclaw-staged-*`)·**아웃바운드 스테이징(`~/.openclaw-dev/media/outbound/` — 툴 `media` 와 `MEDIA:` 줄이 코어를 지날 때 복사본이 생긴다, Gateway 가 24h 뒤 지운다)**에서 이번 런이 만든 것만 지운다(`find … -newermt '<시작 시각>'` 로 가른다. 스파이크 보고서 「정리 상태」가 본보기). 모델 런이 워크스페이스에 만든 파일(예: `hello-c3po.txt`)도 지운다.

**⑤ 처음 돌려 보고 고친 것·보탠 것 (a3-t11, 2026-09-23)**

- **로그 머리가 둘이다.** 인바운드·최종 응답 쪽은 런타임 `logger` 라 `[dodok] inbound-media`·`[dodok] deliver`·`[dodok] deliver-media`, 툴 쪽은 `console.info` 라 `dodok:tool-send`·`dodok:tool-send-media` 다. 위 표의 `dodok:inbound-media`·`dodok:deliver-media` 는 틀린 이름이었다(고쳤다). `grep -a 'inbound-media\|deliver-media\|tool-send'` 로 한 번에 본다. 로그에 색 코드가 섞여 있어 `sed 's/\x1b\[[0-9;]*m//g'` 를 먼저 건다.
- **웹 작성기에 파일을 넣는 법.** 작성기의 `<input type=file>` 은 `class="hidden"` 이라 BrowserOS neo 스냅샷에 ref 가 없고 `upload` 가 못 잡는다. 이미지를 워크트리 `data/`(ignored) 아래에 복사하고, 페이지 안에서 `fetch('/@fs<워크트리>/data/<폴더>/<파일>')` → `new File([blob], 이름, {type})` → `DataTransfer` 로 `input.files` 를 채운 뒤 `change` 를 쏜다. 칩이 뜨고 「보내기」가 켜진다(파일 선택기와 같은 코드 경로). 멘션은 입력칸에 `@dev` 를 쳐서 뜬 후보를 누른다.
- **`fake-args.json` 을 배열로도 받고, 한 번 쓰면 치운다.** 한 런에서 여러 호출(b·e·상대 경로)을 한 번에 두드리고, 릴레이(에이전트 A 의 툴 전송이 `@dev` 를 불러 dev 의 런이 이어지는 것)에서 두 번째 런이 같은 툴을 다시 부르지 않게 했다. 11.4 의 `const args = …; const call = …` 자리를 `const raw = fs.readFileSync(ARGS_FILE); fs.renameSync(ARGS_FILE, ARGS_FILE + ".used-" + Date.now()); const calls = [].concat(JSON.parse(raw));` 와 `for (const args of calls) …` 로 바꾼다.
- **`stdin-record` 에 두 가지를 더 적었다.** `atRefs` 마다 `sha256` 앞 16자(원본과 바이트 동일을 크기·magic 보다 세게 본다), 그리고 프롬프트에서 `/Users/…` 가 든 줄의 **꼴만**(`hostPathLines` — 홈을 `~` 로 바꾸고 160자로 자른다). 알림 줄은 `^\[(첨부 파일|이미지를 불러오지)` 로 뽑아 `notes` 에 둔다. Gateway 가 프롬프트에 `[media attached i/N: <스테이징 호스트 경로> …]` 를 스스로 붙이는 것이 이것으로 보였다(13.4).
- **6 MiB 넘는 인바운드는 릴레이로만 잰다.** 사람 업로드 상한이 5 MiB 라 웹으로는 `saveMediaBuffer` 의 `maxBytes`(20 MiB)를 두드릴 수 없다. 채널에 `fin` 을 더하고, `fake-args.json` 을 `{"action":"send","target":"channel:<CH>","message":"@dev …","mediaUrls":["<WS>/a3-harness/big.png","<WS>/a3-harness/월간 보고서.pdf"]}` 로 둔 채 `@fin …` 을 보낸다 — fin 의 가짜 런이 큰 PNG·PDF 를 올리고, 그 메시지가 dev 를 불러 dev 의 인바운드에 이미지 하나 + `[첨부 파일: 월간 보고서.pdf]` 가 실린다. 무작위 픽셀 PNG(1700×1700, 8.7 MB)는 PIL 로 만든다.
- **`assistant` 레코드만으로는 스트리밍 창을 못 늘린다.** Gateway 는 가짜 CLI 의 `assistant` 레코드(`stop_reason:"end_turn"`)를 `result` 가 올 때 **한 델타로** 흘린다 — `assistant` 와 `result` 사이에 지연을 넣어도 버블이 먼저 보이지 않았다(12초 넣고 확인).
  **정정(a3-t13)**: 진짜 CLI 처럼 `stream_event` 레코드를 내면 Gateway 가 조각마다 따로 흘린다 — 코어의 claude-cli 파서가 `stream_event` 의 `content_block_delta`·`text_delta` 를 델타로 읽는다(9.5 `dist/cli-live-session-registry-*.mjs` 의 `parseClaudeCliStreamingDelta`). 그래서 **모델 런 없이 델타 쪼개기·시각을 잴 수 있다**(13.7). 11.4 의 `assistant`·`result` 두 줄 앞에 아래를 넣는다(`fake-stream.json` = `{"gapMs":600,"deltas":["…","…"]}`, 최종 텍스트는 `deltas` 를 이은 것).
  ```js
  const MID = "msg_fake_" + Date.now(), se = (event) => out({ type: "stream_event", session_id: SID, event });
  se({ type: "message_start", message: { id: MID, type: "message", role: "assistant", model: "fake", content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const text of spec.deltas) { await sleep(spec.gapMs); se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }); }
  se({ type: "content_block_stop", index: 0 }); se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }); se({ type: "message_stop" });
  // 그다음 11.4 대로 assistant(content = deltas.join("")) · result(result = 같은 글)
  ```
  사람 눈에 실제로 얼마나 오래 보이는지(모델의 토큰 간격)는 여전히 모델 런으로만 잰다.
- 11.1 의 `W channels` 출력 첫 줄은 `HTTP 200 GET …` 이다 — jq 에 넘길 때 `tail -n +2` 를 건다.

## 12. 결함 1 고침의 실물 확인 — 2026-09-23 결과 (c2-t16, 모델 런 0회)

11.3 하네스로 ADR 0004 6절 합격 기준을 `oc 2026.9.5 (f396007)` 실물 Gateway 위에서 돌렸다. **모델 런 0회**(가짜 claude CLI, `costUsd: 0`), Gateway 에이전트 런 2회.

**판정: 고쳐졌다. 6/6 통과. dodok 코드 결함 0.**

| 항목 | 값 |
| --- | --- |
| Gateway | `OpenClaw 2026.9.5 (f396007)` — 저장소 핀(2026.9.4)과 다르다(앱 자동 업데이트, 8장 이월) |
| 번들 sha | 설치 전 `9520de1f…`(고치기 전 코드) → 설치 후 `0b53c75b…`(고친 코드). **둘이 다른 것을 확인하고 쟀다** |
| 채널 | 하네스 전용 새 채널(11.1 주의대로 — 가짜 claude 세션 id 가 채널 세션에 박힌다) |

| # | 합격 기준 | 결과 |
| --- | --- | --- |
| 1 | `tools/call message` | `sent to dodok channel <CH> (<messageId>)` · `isError:false` — 전에는 `dodok: account "default" bridge is not running` |
| 2 | 카드가 **런에 묶이는가** | `message.created … runId=<그 런> replyTo=<그 사람 메시지>` — 값이 정확히 일치. REST 로도 재확인. **`correlations` 도 세대를 넘었다**(반쪽 아님) |
| 3 | `components` 온전성 | 셀렉트(`actions`)·모달(필드 4종)이 보낸 그대로 저장·렌더 |
| 4 | `ask_user` | `ask_user prompt delivery failed \| INTERNAL: HttpError: agent not found` — 「bridge is not running」이 아니다. **첫 층이 닫혔다는 증거**(뒷 두 층은 8장 이월) |
| 5 | 버전 로그 | `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-f39600759bec-…"` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"`. ⚠ 같은 줄의 `pluginBuiltWithSdk="2026.9.4"` 는 빌드 상수다(Gateway 버전 아님) |
| 6 | probe — 세대 확인 | `module-eval evals=1 instance=26vo7d` / `evals=2 instance=exfwnw`(같은 pid) · `start-account instance=26vo7d` · **`handle-action instance=exfwnw found=true`** — 전역 레지스트리가 세대를 넘는 것이 눈으로 보인다 |

웹(5180): 카드 2장이 목록에 그려지고, 활동 탭에 런 2건이 모두 `완료`, 모달 「세부 정보」의 필드 4개가 그대로 열렸다. 콘솔 예외 유무는 재지 않았다.

**절차 노트**: 9.5 Gateway 가 떠 있는 채로 `plugins install --force` 하면 `device token scope mismatch` 로 실패하고 **파일도 안 바뀐다** — 3절 (b) 의 경고대로 Gateway 를 먼저 내리고, 설치 뒤 sha 를 반드시 확인한다.

## 13. 첨부(Phase 2 ③) 실물 확인 — 2026-09-23 결과 (a3-t11, 모델 런 2회)

11.5 하네스(처음 돌림 — 고친 것은 11.5 ⑤)로 첨부 경로를 모델 없이 두드린 뒤, 사용자 승인 상한(**모델 런 2회**, 웹 5180) 그대로 실제 모델로 두 번 돌렸다.

**판정: 첨부 경로는 실물에서 돈다 — 합격 기준 9/9, 모델 런 ①② 통과. 새 결함 1(중간): 최종 응답의 `MEDIA:` 줄이 스트리밍 델타로 흘러 호스트 경로가 버블·`run_events` 에 남는다(13.4 A).**
→ 결함 A 는 서버에서 고쳤고(a3-t12, `635fe76`) 실물 Gateway 에서 모델 런 0회로 확인했다 — **13.7**.
로그는 워크트리 `data/`(ignored): `dev-gateway.log`(Gateway·플러그인·claude-cli)·`phase2-live-20260923.log`(서버)·`frames-20260923.jsonl`(프레임 덤프)·`h2~h6-send.log`·`wire-watch-run1.log`·`wire-watch-run2.log`. 커밋하지 않는다.

### 13.1 환경 실물

| 항목 | 값 |
| --- | --- |
| Gateway | `OpenClaw 2026.9.5 (f396007)` — 12절과 같다. 서버 로그 `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-f39600759bec-2026-09-19T05-09-16.000Z"`, scopes 에 `operator.admin` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"`(같은 줄 `pluginBuiltWithSdk="2026.9.4"` 는 빌드 상수) |
| 플러그인 번들 | 설치 전 `0b53c75b…`(ADR 0004 고침, 첨부 이전) → `pack:plugin` 빌드본 `f5dc6438fbaf8b5c…` → **Gateway 를 내린 채로** 설치 → 설치본 `f5dc6438…` = 빌드본. `status: "loaded"`. main `b0b1b65` 의 깨끗한 트리에서 빌드했고 probe 는 쓰지 않았다 — **끝난 뒤에도 이 번들이 설치돼 있다** |
| 서버 | `:19100`, `APP_ORIGIN=http://localhost:5180`, DB `data/live-smoke.sqlite`, 프레임 덤프 켬, `LOG_LEVEL=debug` |
| 웹 | Vite 8.3.0 `:5180`(5173 은 다른 프로젝트 — 무접촉), 브라우저 BrowserOS neo |
| 채널 | 하네스 `harness-a3t11`(`01a0cda5-fd39…`, 멤버 `@dev`·`@fin`) · 모델 런 ① `model-a3t11-img`(`01a0cdae-f9de…`) · ② `model-a3t11-file`(`01a0cdae-fb86…`) — 런마다 새 채널(가짜 claude 세션 id 와 섞지 않게) |
| 시험 파일 | `word.png` 900×300 흰 바탕 검은 굵은 글씨 **`PLUMCOMET`**(10,619B) · `chart.png`(971B) · `photo.jpg`(92,415B) · `월간 보고서.pdf`(10,416B) · `big.png` 1700×1700 무작위 픽셀(8,683,839B) — PIL 로 만듦 |
| 모델 | `anthropic/claude-opus-5` + claude-cli. CLI 보고 비용 ① **$0.6055**(새 세션 캐시 생성 60k) · ② **$0.2975**. 내장 cron 은 이번에 돌지 않았다(다음 실행 dev 09-30·fin 09-27) |

### 13.2 합격 기준 (런 0회 — 가짜 claude CLI, 11.5)

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 새 번들 설치 | **통과** | 위 표. 설치 전 `0b53c75b…` ≠ 설치 후 `f5dc6438…` = 빌드본 |
| 2 | 인바운드 — `@<ws>/.openclaw-cli-images/<sha>.<ext>`, 크기·magic 이 원본과 같다. 이미지 아닌 첨부는 `[첨부 파일: …]` | **통과** | 웹 작성기로 3장(`word.png`·`chart.png`·`photo.jpg`) + `@dev` → `stdin-record` `contentKind:"string"`, `blocks:[]`, `atRefs` 3개가 **올린 순서대로** 크기 10619·971·92415, magic `89504e47…`·`89504e47…`·`ffd8ffe0…`, **sha256 앞 16자가 원본과 셋 다 같다**, 모두 `.openclaw-cli-images/` 안 0600. `[dodok] inbound-media` `images:3`·`reasons:[]`. PDF 는 릴레이(6)로 `notes:["[첨부 파일: 월간 보고서.pdf]"]` |
| 3 | 툴 `media` — PNG·PDF·한국어 공백 이름, 이름 그대로, 바이트 = 원본, components `artifact://<공백 든 이름>` 이 풀린다 | **통과** | 한 런에서 호출 셋. ① `mediaUrls:[chart.png, 월간 보고서.pdf]` + components(`media` → `artifact://chart.png`, `file`·링크 버튼 → `artifact://월간 보고서.pdf`) → `sent to dodok channel …`, `dodok:tool-send-media {"uploaded":2,"failed":0}`. 메시지 첨부가 그 순서로 `chart.png`(image/png 971)·`월간 보고서.pdf`(application/pdf 10416), REST 로 내려받은 sha 가 원본과 같다(`7ba5f6bd…`·`e1011056…`), `content-disposition` `filename*=UTF-8''%EC%9B%94%EA%B0%84%20…`. 저장된 components 의 url 은 `artifact://월간%20보고서.pdf`(Ruling 4). 웹에서 `media` 블록 `<img src=/api/v1/attachments/<chart id>>`, `file` 블록 「내려받기」·링크 버튼 「보고서 열기」가 **둘 다 PDF 첨부 id** 로 풀렸고 「첨부를 찾을 수 없습니다」·「열 수 없는 링크」는 0(Ruling 5). 카드가 가리킨 첨부는 격자에 다시 나오지 않았다 |
| 4 | 최종 응답 `MEDIA:` 줄 — 첨부로 오고 본문에 `MEDIA:` 없음. **`gateway_final` 스냅샷에 `MEDIA:` 가 남는가**. `finalSource` | **통과 · 전제 확인** | `fake-final.txt` = `결과\n\nMEDIA:<ws>/a3-harness/chart.png` → 메시지 본문 `결과` + 첨부 `chart.png` 1, `[dodok] deliver-media {"uploaded":1,"failed":0}`, `finalSource=plugin`, `gateway snapshot media lines dropped` 0회. **프레임 덤프의 `chat` `state:"final"` 의 `message.content[0].text` 가 `"결과\n\nMEDIA:/Users/…/a3-harness/chart.png"` — 실제 Gateway 스냅샷에 `MEDIA:` 줄이 남는다**(모델 런 ② 도 같다). 정본은 final 뒤 31ms 에 왔다 |
| 5 | 미디어만 있는 응답 — 첨부만, 호스트 경로 0 | **통과**(메시지) · 결함 A 는 별도 | `fake-final.txt` = `MEDIA:<경로>` 한 줄 → `[dodok] deliver {"textLength":0,…,"media":1}` → 메시지 `body=""` + 첨부 `chart.png`. 채널 메시지 전체(REST JSON)에 `/Users/`·`MEDIA:`·`openclaw-dev` **0건**, 웹 `main` 텍스트에도 0 |
| 6 | 플러그인 배선 잠금 셋(a3-t5 M2) | **통과** | ⓐ `shouldDeliverFinal`: 5 로 확인. ⓑ `saveMediaBuffer` 의 `maxBytes`: 릴레이로 **8,683,839B PNG** 가 인바운드됐다(기본 5 MB 였다면 `SaveMediaSourceError` → `[이미지를 불러오지 못했습니다]`) — `inbound-media {"images":1,"notes":1,"reasons":[]}`, CLI 에는 **Gateway 가 재압축한 JPEG 1,848,277B**(`ffd8ffc0…`, 스파이크 1-12 와 같은 동작). 서버에 저장된 `big.png` 는 원본 그대로(8,683,839B). ⓒ `handleAction` 의 `mediaAccess`: `media:"a3-harness/chart.png"`(**워크스페이스 상대 경로**) → `uploaded:1`, 첨부 sha = 원본 |
| 7 | Ruling 1 — ack 시간, 같은 deliveryId 재전송 없음 | **통과(루프백 한정)** | 어댑터 `inbound delivered` `ackMs`: 이미지 3장 **117ms**, 8.7 MB 릴레이 **175ms**, 첨부 없는 런 36~242ms, 새 세션 첫 런 873ms. `retries:0` 전부, `inbound.deliver ack timeout` 0회, 플러그인 `[dodok] ingress` 의 `deliveryId` 중복 0. **느린 링크(장당 30초 근처)는 재지 못했다** — 루프백이라 10초 기본값에도 한참 못 미친다 |
| 8 | 실패 문구 — 고정 문구, 경로 없음 | **통과** | `mediaUrls:[chart.png, "<ws>/a3-harness/없는 파일.pdf"]` → 툴 결과 `{"content":[{"type":"text","text":"dodok: 첨부를 보내지 못했습니다 — 없는 파일.pdf: 파일을 찾을 수 없음"}],"isError":true}`, 로그 `dodok:tool-send-media {"uploaded":1,"failed":1,"details":["file not found"]}` — 경로 0. 먼저 올라간 `chart.png` 는 미묶음 행으로 남았다(설계대로 — 24시간 정리) |
| 9 | 버전 로그 | **통과** | 13.1 — 12절과 같은 `2026.9.5`·같은 buildId |

### 13.3 모델 런 (상한 2, 실제 2)

| # | 채널 | 입력 | 런 id | 모델이 한 것 | 소요 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| ① | `model-a3t11-img` | 웹 작성기로 `word.png` + `@dev 이 이미지에 쓰인 단어가 뭐야?` | `01a0cdaf-cf69` | **툴 호출 0** — CLI 가 `@경로` 를 네이티브 첨부로 읽었다 | `RUN_STARTED` → 첫 델타 3.4s → 정본 4.8s(ack 873ms, 새 세션) | **통과** — `PLUMCOMET 입니다. 흰 배경에 굵은 산세리프 대문자로 딱 한 단어만 쓰여 있네요.` |
| ② | `model-a3t11-file` | `@dev 작은 텍스트 파일을 만들어 이 채널에 첨부로 보내 줘.` | `01a0cdb0-8736` | `Write{file_path:"<ws>/hello-c3po.txt"}` → **최종 응답 끝에 `MEDIA:<ws>/hello-c3po.txt` 줄**(스파이크 런 2 는 `message` 툴을 골랐다 — 이번엔 다른 입구를 탔다) | 첫 툴 5.6s → 정본 8.8s(ack 89ms) | **통과** — 본문 「@owner 파일 생성 완료입니다! `hello-c3po.txt`, … 첨부로 함께 보냅니다 …」 + 파일 카드 `hello-c3po.txt`(269 B, 텍스트). `deliver-media {"uploaded":1}`, `finalSource=plugin`, 본문·첨부 이름에 경로 0. 웹 카드 「내려받기」로 받은 바이트 sha = 워크스페이스 원본(`2809c2fe…`), `content-disposition: attachment` |

- 두 런 모두 `RUN_FINISHED usage` 가 `inputTokens:2, outputTokens:1|4, costUsd:0` 이다(CLI 는 $0.61·$0.30 을 보고) — 5.4 이월(usage 값)과 같은 줄기로 보인다. 이번엔 파지 않았다.
- **두 입구가 모두 실물 모델 런에서 돌았다**: 툴 `media`(스파이크 런 2)와 최종 응답 `MEDIA:` 줄(이번 런 ②). 런 ② 의 실제 `gateway_final` 스냅샷도 `…\n\nMEDIA:/Users/…/hello-c3po.txt` 였고 정본이 45ms 뒤에 와서 폴백·연장은 쓰이지 않았다.
- 웹(5180): ① 이미지 칩 → 보내기 → 메시지 격자에 `word.png`, ② 파일 카드 표시·내려받기를 눈으로 봤다. 탭은 닫았다.

### 13.4 틀린 것·고칠 것

**A. [결함·중간] 최종 응답의 `MEDIA:` 줄이 스트리밍 델타로 흘러, 호스트 경로가 채널 버블에 잠깐 보이고 `run_events` 에 영구히 남는다.**
- **재현**: 모델 런 ②. `run_events`(런 `01a0cdb0-8736…`) seq 26~28 의 `TEXT_MESSAGE_CONTENT` delta 가 `MEDIA:/Users/<사용자>` · `/.openclaw-d` · `ev/workspace/hello-c3po.txt`(09:55:01.715~.867), 정본 `message.created` 는 09:55:02.27 — **약 0.5초** 동안 채널을 보는 모든 사람의 스트리밍 버블에 호스트 경로가 그려진다. 하네스 c·d 에서도 wire `TEXT_MESSAGE_CONTENT` 에 `MEDIA:/Users/…` 가 그대로 실렸다(가짜 CLI 는 한 델타로 흘려 창이 ~30ms).
- **왜**: 서버 폴백(`stripMediaLines`, 스펙 4.6)과 플러그인 정본은 `MEDIA:` 를 걷지만 델타 경로는 걷지 않는다. 웹 `apps/web/src/features/runs/runStore.ts:18-19` 가 델타를 그대로 이어 붙이고, `bubblePhase.ts:25-32` 가 streaming·finalizing 에서 `textVisible: true` 다. 서버는 델타를 `run_events.payload_json` 에 저장한다.
- **영향**: 스펙 9장 「채널 어디에도 호스트 경로가 나타나지 않는다」가 잠깐 깨진다. 업로드가 느리면(큰 파일, Ruling 2 로 finalizing 최대 120초) 노출이 그만큼 길어진다. 경로가 줄 경계에서 델타 여럿으로 쪼개져 오므로(위 셋) 델타 하나씩 걷는 방식으로는 못 막는다 — 줄 단위로 버퍼링하거나 웹 표시에서 `MEDIA:` 로 시작하는 줄을 숨기는 쪽을 봐야 한다. 코드는 고치지 않았다.
- 활동 탭이 런 텍스트를 보여 주는지, 재접속 때 델타가 다시 재생되는지는 재지 않았다.
- **고침(a3-t12, `1d6a06a`·`635fe76`)**: 서버가 텍스트 델타를 코얼레싱(= `run_events` 저장·wire 팬아웃의 입구)에 넣기 **전에** 런별 줄 단위 필터로 거른다(`apps/server/src/modules/runs/media-lines.ts`, 스펙 11장 Ruling 6). 줄 처음 조각이 `MEDIA:` 이거나 그 접두일 수 있으면 붙잡고, 줄이 끝나면 `MEDIA:` 줄은 줄바꿈째 버린다. 대소문자는 가리지 않는다(코어와 같다). `TEXT_MESSAGE_REPLACE` 본문도 같은 필터를 지난다. 붙잡힌 조각은 저장도 팬아웃도 되지 않은 상태라 재접속 재생(DB 만 읽는다)에도 경로가 없다.
- **실물 확인(a3-t13, 모델 런 0회) — 13.7**: 실제 Gateway 가 `MEDIA:/Users/<u>` · `/.openclaw-d` · `ev/workspace/…/chart.png` 세 델타로 쪼개 보낸 것(런 ② 와 같은 모양)을 서버가 wire·`run_events` 어디에도 싣지 않았다. 소문자 `media:`·`Media: ` 줄도 같다. 보통 줄 델타는 Gateway 프레임 뒤 53~58ms(코얼레싱 창 50ms)에 그대로 나갔다.

**B. [관찰] Gateway 가 프롬프트에 스테이징 호스트 경로를 스스로 붙인다.** 이미지 인바운드 때 CLI 프롬프트에 `[media attached 1/3: ~/.openclaw-dev/workspace/media/inbound/openclaw-staged-<uuid>/input-word---<uuid>… ]` 줄이 장마다 붙는다(가짜 CLI `hostPathLines`). 우리 텍스트가 아니라 OpenClaw 코어가 넣는 것이다. 모델이 이 경로를 답에 옮기면 채널 본문에 호스트 경로가 들어간다 — 우리 쪽 방어는 없다(스펙 10장 「사람이 채팅에 쓴 호스트 경로」와 같은 계열).

**C. [관찰] 활동 탭의 툴 인자·결과에 호스트 경로가 있다.** 런 ② 의 `Write` 인자 `file_path` 와 결과 `File created successfully at: /Users/…` 가 `TOOL_CALL_ARGS`·`TOOL_CALL_RESULT` 로 저장·표시된다. Phase 2 ① 부터의 설계(툴 타임라인은 원문)이지만 「호스트 경로를 드러내지 않는다」를 활동 탭까지 넓힐지는 판단이 필요하다.

**D. [관찰] Ruling 1·2 의 전제.** Ruling 2 의 전제(실제 `gateway_final` 스냅샷에 `MEDIA:` 줄이 남는다)는 **맞았다** — 하네스 c 와 모델 런 ② 모두. 정본은 final 뒤 31·45ms 에 와서 연장이 실제로 필요한 경우는 못 봤다. Ruling 1 은 루프백에서 ack 가 0.1~0.2초라 **정상 경로에서 재전송이 안 난다는 것만** 확인했고, 느린 링크의 이중 디스패치 여부는 여전히 못 쟀다(원격 Gateway 실연 몫).

**E. [관찰] 아웃바운드 스테이징 사본.** 툴 `media` 와 `MEDIA:` 줄은 Gateway 코어를 지나며 `~/.openclaw-dev/media/outbound/<이름>---<uuid>.<ext>` 사본을 남긴다(이번 8개 — 툴로 보낸 `big.png` 는 **JPEG 4,047,716B** 사본도 생겼다, 서버에는 원본 PNG 가 갔다). Gateway 가 24h 뒤 지운다(스파이크 보고서 「언제 지워도 되는가」 — `OUTBOUND_STAGING_TTL_MS`, 코드 읽기. `MEDIA:` 줄의 사본은 스파이크 2-7, 툴 `media` 의 사본은 이번에 처음 봤다). 11.5 「끝나면」에 넣었다.

### 13.5 사람이 볼 것

9.3 그대로(실제 OS 클립보드 붙여넣기·끌어다 놓기). 13.4 A 는 서버가 wire 에 싣지 않게 고쳤고 wire 에서 0건을 확인했으므로(13.7), 버블에서 `MEDIA:/…` 를 눈으로 찾을 일은 더 없다. 고치기 전 코드(`1d6a06a` 이전 — `1c8ffc1` 까지)로 돌릴 때만 해당한다 — **긴 답 끝에 파일을 붙이는 런**에서 스트리밍 버블 마지막 줄에 `MEDIA:/…` 가 잠깐 보이는지 눈으로 한 번. 자동화 도구로는 0.5초 창을 안정적으로 잡지 못했다.

### 13.6 정리·잔여물

- 서버(SIGINT)·Gateway(`shutdown completed cleanly`)·Vite 5180·wire-cli `watch` 를 내렸다. **19001·19100·5180 LISTEN 0, 5173 은 1 그대로**(다른 프로젝트, 무접촉). 브라우저 탭은 닫았다.
- 설치본: `~/.openclaw-dev/extensions/dodok` = `f5dc6438…`(main `b0b1b65` 빌드, 첨부 든 번들), `status: loaded`. `channels.dodok.channels` 는 unset 그대로. 계정·에이전트·승인 정책 무변경.
- dev 프로필에서 이번에 만든 것만 지웠다(모두 18:40 이후 생성 확인): `<ws>/a3-harness/`·`<ws>/hello-c3po.txt`(런 ②)·`<ws>/.openclaw-cli-images/`·`<ws>/media/`(둘 다 이번에 새로 생김)·`~/.openclaw-dev/media/inbound/`(새로 생김)·`media/outbound/` 안 파일 8개(디렉터리는 남김).
- **남긴 것**: dev·fin 채널 세션 4개(하네스 채널 dev·fin — 가짜 세션 id `…a311` 가 박힘, 모델 채널 둘) · 실제 claude 전사(런 ①②, `~/.claude/projects/…` 는 읽지도 고치지도 않음) · `/tmp/openclaw/openclaw-dev-2026-09-23.log` · 워크트리 `data/`(ignored: 위 로그들, `live-smoke.{env,sqlite}`, `openclaw-device-dev.json`, `wire-cli-session.json`, `attachments/`(서버 블롭), `check-*.log`) · `packages/openclaw-plugin/dist/`(ignored, 깨끗한 빌드). 가짜 CLI·시험 이미지·스크래치는 지웠다.
- 시크릿: `BRIDGE_TOKEN`·dev Gateway 토큰·`LOCAL_AUTH_TOKEN` 값의 출현 수 **0** — `data/*.log`·`data/*.jsonl`·`data/*.json`·`data/live-smoke.sqlite*`(WAL 체크포인트 뒤)·가짜 CLI 출력·`/tmp/openclaw/…log`. 이번 모델 런은 설정 파일을 뒤지지 않았다.
- 검사: 루트 `pnpm test` exit 0(shared 101 · plugin 108 · adapter 206 · server 562 · web 996 = **1973**) · `pnpm typecheck` exit 0 · `pnpm lint` exit 0 · `pnpm fmt:check` exit 0.

### 13.7 결함 A 고침의 실물 확인 — 2026-09-23 (a3-t13, 모델 런 0회)

13.4 A 를 서버에서 고친 뒤(a3-t12 — 스펙 11장 Ruling 6), 실제 dev Gateway 위에서 11.5 하네스 c·d 꼴을 **델타를 쪼개** 다시 돌렸다. 가짜 claude CLI 가 `stream_event` 로 조각을 600ms 간격으로 흘린다(11.5 ⑤ 정정). **모델 런 0회**. 가짜 CLI 의 `-p` 런 3회는 모두 `costUsd:0`·usage 0이다. `-p` 없는 호출 4회(버전·인증 확인)는 진짜 `claude` 로 넘어갔지만 모델을 부르지 않는다.

**판정: 고쳐졌다.** 실제 Gateway 가 `MEDIA:` 줄을 세 델타로 쪼개 보냈다(런 ② 와 같은 모양). 서버는 그 줄을 wire 에도 `run_events` 에도 싣지 않았다. 소문자 `media:`(세 델타)·`Media: `(두 델타) 줄도 싣지 않았다. 첨부는 셋 다 오고, 본문에 경로는 0이다. 보통 줄은 늦어지지 않았다. dodok 코드 결함 0.
로그는 워크트리 `data/`(ignored)에 있다: `dev-gateway.log`·`phase2-live-a3t13.log`(서버)·`frames-a3t13.jsonl`(프레임 덤프)·`wire-raw-{c,d,e}.jsonl`(아래 원시 감시)·`h-{c,d,e}-send.log`·`h-messages.json`·`fake-claude-a3t13.jsonl`.

| 항목 | 값 |
| --- | --- |
| Gateway | `OpenClaw 2026.9.5 (f396007)`. 서버 로그 `gatewayVersion="2026.9.5"`, `gatewayBuildId` 는 13.1 과 같고 scopes 에 `operator.admin` 이 있다 |
| 플러그인 | **재설치하지 않았다.** 설치본 `f5dc6438…` 는 13.1 그대로다. `b0b1b65..635fe76` 에서 `packages/openclaw-plugin` 은 바뀌지 않았다(diff 0줄). `status: "loaded"` |
| 서버 | 워크트리 `a3-t13` = main `635fe76`, `:19100`, 새 DB `data/live-smoke.sqlite`, 프레임 덤프 켬. 웹은 띄우지 않았다(5173·5180 무접촉) |
| 채널 | 하네스 전용 `harness-a3t13`(멤버 `@dev`), 가짜 세션 id `…0a3013` |
| 시험 파일 | `<ws>/a3-harness/chart.png` 64×32 3,858B(sha `c5cdc0f6…`) |
| wire 원시 감시 | `wire-cli` 는 델타를 뭉쳐 찍는다(4절). 그래서 `socket.io-client` 로 구독만 하는 스크래치 스크립트를 따로 썼다. `run.event`·`message.*` 를 받은 시각(epoch ms)과 함께 JSONL 로 적는다. 세션 토큰은 `data/wire-cli-session.json` 에서 읽고 출력하지 않는다 |

**런 셋**(가짜 CLI `fake-stream.json` 의 `deltas`, `<u>` 는 사용자 이름)

| # | 조각 | 뜻 |
| --- | --- | --- |
| c | `첫 줄은 ` · `보통 글입니다.\n` · `M` · `arkdown 은 두 번째 글자에서 풀린다.\n\n` · `MEDIA:/Users/<u>` · `/.openclaw-d` · `ev/workspace/a3-harness/chart.png` | 13.2-4 꼴 + 줄 머리 `M` |
| d | `me` · `dia:/Users/<u>` · `/.openclaw-d` · `ev/workspace/a3-harness/chart.png` | 13.2-5 꼴(미디어만), **소문자** |
| e | `앞 줄입니다.\n` · `Media: ` · `/Users/<u>/.openclaw-d` · `ev/workspace/a3-harness/chart.png\n` · `뒤 줄도 ` · `곧바로 나옵니다.` | 가운데 줄, 대소문자 섞임, 뒤에 글 |

**결과**

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 입력이 정말 쪼개져 왔는가 | **그렇다** | 프레임 덤프 `chat` `state:"delta"` 의 `deltaText`: c `MEDIA:/Users/<u>`·`/.openclaw-d`·`ev/workspace/a3-harness/chart.png`(19:33:02.201·02.801·03.402), d `media:/Users/<u>`·`/.openclaw-d`·`ev/…/chart.png`, e `Media: /Users/<u>/.openclaw-d`·`ev/…/chart.png\n`. `gateway_final` 스냅샷에도 그 줄이 그대로 있다(13.2-4 와 같다) |
| 2 | wire `TEXT_MESSAGE_CONTENT`·`TEXT_MESSAGE_REPLACE` 에 `/Users/`·`MEDIA:`·`media:` 0 | **0** | 원시 감시 세 파일 전체에서 `/Users/`·`MEDIA:`·`media:`·`Media:` 가 모두 0건이다. `TEXT_MESSAGE_CONTENT` 는 c 3·d 0·e 3건이고 모두 보통 글이다. d 는 `TEXT_MESSAGE_START` → `END` 뿐이다. `TEXT_MESSAGE_REPLACE` 는 0건이다 — Gateway 가 `replace` 를 내지 않아 **REPLACE 경로는 실물에서 두드려지지 않았다**(단위 테스트만) |
| 3 | `run_events` 에 같은 검색 0 | **0** | 33행 중 `TEXT_MESSAGE_CONTENT` 는 6행이고 모두 보통 글이다. `instr(payload_json,'/Users/')` 0, `payload_json LIKE '%media:%'`(SQLite LIKE 는 ASCII 대소문자를 가리지 않는다) 0, `openclaw-dev` 0, `TEXT_MESSAGE_REPLACE` 0. `messages.body_md` 도 0이다 |
| 4 | 채널에 첨부가 오고 본문에 경로 0, `finalSource` | **통과** | c 본문 `첫 줄은 보통 글입니다.\nMarkdown 은 두 번째 글자에서 풀린다.` + `chart.png` · d 본문 `""` + `chart.png` · e 본문 `앞 줄입니다.\n뒤 줄도 곧바로 나옵니다.` + `chart.png`. REST 로 내려받은 세 첨부의 sha 가 원본과 같다(`c5cdc0f6…`). 채널 메시지 REST JSON 전체에서 `/Users/`·`media:`(대소문자 무시)·`openclaw-dev` 는 0이다. 세 런 모두 `finalSource=plugin` 이다. 플러그인 `[dodok] deliver-media` 는 `uploaded:1,failed:0` 을 세 번 찍었다. 서버 `gateway snapshot media lines dropped` 는 0회, `stream media lines dropped` 는 `mediaLinesDropped:1` 로 세 번 찍혔다 |
| 5 | 스트리밍이 느려지지 않았는가 | **그렇다 — 늘어난 지연 없음** | 아래 시각 표. 보통 줄 델타는 Gateway 프레임을 받은 뒤 **53~58ms** 에 wire 에 나왔다. 이 값은 코얼레싱 창 `coalesceMs: 50`(결함 A 이전부터 있다)에 해당한다. 고치기 전 코드로 같은 기준선을 다시 재지는 않았다 |

**시각** — 서버가 Gateway 프레임을 받은 시각(프레임 덤프 `receivedAt`)과 원시 감시가 wire 이벤트를 받은 시각이다. 둘 다 같은 머신의 시계다. 가짜 CLI 의 조각 방출 → Gateway 프레임은 1~7ms 였다(합쳐진 조각은 뒤 조각 기준).

| 런 | Gateway `deltaText` (받은 시각) | wire (받은 시각) | 차이 |
| --- | --- | --- | --- |
| c | `첫 줄은 ` (19:32:59.791) | seq 5 `첫 줄은 ` (59.849) | 58ms |
| c | `보통 글입니다.\n` (00.393) | seq 6 (00.447) | 54ms |
| c | `Markdown 은 …\n\n` (01.597) | seq 7 (01.652) | 55ms |
| c | `MEDIA:/Users/<u>` · `/.openclaw-d` · `ev/…/chart.png` (02.201·02.801·03.402) | **없음** | — |
| c | `final` (04.311) | `TEXT_MESSAGE_END` seq 9 (04.312) → 정본 `message.created` 는 그 뒤 67ms | — |
| e | `앞 줄입니다.\n` (19:34:58.307) | seq 5 (58.361) | 54ms |
| e | `Media: /Users/<u>/.openclaw-d` · `ev/…/chart.png\n` (59.513·00.113) | **없음** | — |
| e | `뒤 줄도 ` (00.714) | seq 6 (00.767) | 53ms |
| e | `곧바로 나옵니다.` (01.318) | seq 7 (01.372) | 54ms |

**관찰**
- **Gateway 가 짧은 줄 머리 조각을 스스로 합친다.** 가짜 CLI 가 따로 낸 `M`(c)·`me`(d)·`Media: `(e)를 Gateway 는 프레임으로 따로 내지 않았다. 다음 조각과 합쳐 `Markdown 은 …`·`media:/Users/<u>`·`Media: /Users/<u>/.openclaw-d` 로 냈다(600ms 뒤). 까닭은 파지 않았다.
  그래서 서버 필터의 **접두 붙잡기**(`M` → 다음 글자에서 풀림)는 이 실물 경로에서 두드려지지 않았다. 그 동작은 단위 테스트(a3-t12)가 잠근다. 합친 뒤의 `MEDIA:` 줄은 Gateway 가 그대로 델타로 흘린다 — 서버 필터는 여전히 필요하다.
- 붙잡힌 채 재접속하는 경우와 활동 탭 표시는 재지 않았다(웹을 띄우지 않았다). 재생은 DB 만 읽으므로 3번이 그 몫을 대신한다(a3-t12 리뷰 질문 2).

**정리**: 서버(SIGINT)와 tsx watch·pnpm 부모를 내렸다. Gateway 는 `shutdown completed cleanly` 로 내렸다. **19001·19100·5180 LISTEN 0, 5173 은 1 그대로**(무접촉). 설치본은 `f5dc6438…`, `status: loaded` 이고 `channels.dodok.channels` 는 unset 이다.
dev 프로필에서는 이번에 만든 것만 지웠다(19:31 이후 생성 확인): `<ws>/a3-harness/`, `~/.openclaw-dev/media/outbound/` 의 `chart---<uuid>.png` 3개(관찰 E 의 사본 — 런마다 하나). 가짜 CLI·스크래치는 지웠다. 하네스 채널의 dev 세션(가짜 세션 id)은 남겼다.
시크릿(`BRIDGE_TOKEN`·dev Gateway 토큰·`LOCAL_AUTH_TOKEN`)의 출현 수는 0이다. 확인 범위는 `data/*.log`·`*.jsonl`·`*.json`·`live-smoke.sqlite*`·가짜 CLI 출력이다.

---

## 14. PWA·푸시(Phase 2 ④) — 푸시 확인 절차·VAPID 키 옮기기·사람이 볼 것

스펙 `docs/superpowers/specs/2026-09-23-pwa-push-design.md`(구현과 달라진 것은 11장). 14.1 은 브라우저 검증(p4-t7, 2026-09-24 — 16/16·결함 0)이 실제로 쓴 절차다. **모델 런 0회**이고 dev Gateway 도 필요 없다 — `dev:fake` 로 돈다.
실제 dev Gateway·실제 모델로 에이전트 멘션 푸시를 보는 실연은 14.4(2026-09-24 결과 — 경로는 돈다, 모델 런 1건의 알림 표시만 미확인·재현 안 됨)다.

### 14.1 푸시 확인 절차 (`dev:fake`, 모델 런 0회)

**띄우기** — 5173 은 이 머신의 다른 프로젝트라 웹은 5180, API 는 3100 이다.

```bash
# 서버: 실제 web-push 발송기(구독하고 트리거를 일으키면 실제 푸시 서비스로 나간다). 로그인 토큰 dev-fake-local-token
PORT=3100 APP_ORIGIN=http://localhost:5180 pnpm -F @dodok/server dev:fake
# 웹: 빌드본 preview — 프록시는 vite.config.ts 의 server.proxy 를 그대로 따른다
pnpm -F @dodok/web build
DODOK_API_ORIGIN=http://127.0.0.1:3100 pnpm -F @dodok/web exec vite preview --port 5180 --strictPort
```

- **개발 서버(`pnpm -F @dodok/web dev`)에는 서비스 워커가 없다**(스펙 11장 R4). 거기서 보려면 셸에서 `VITE_PWA_DEV=1` 을 준다(`.env` 의 값은 닿지 않는다). 개발 SW 는 미리 저장이 비어 오프라인 탐색 폴백이 없다 — 오프라인 확인은 preview 로만 된다. 같은 오리진에서 preview 와 dev 를 오갈 때의 주의는 `docs/guides/browser-verification.md` 「PWA·서비스 워커를 볼 때」.
- `dev:fake` 는 VAPID 주체가 기본값이라 시작 때 `VAPID subject is a local placeholder …` warn 한 줄을 찍는다 — 의도한 경고다. 키 `data/vapid.json` 은 재시작해도 그대로다(지우면 그 오리진의 구독이 모두 무효).

**브라우저 — headed 여야 한다.** 헤드리스 Chromium 은 권한을 줘도 `Notification.permission` 이 `"denied"` 로 고정된다(`Notification.requestPermission()` 결과와 `navigator.permissions.query` 는 `granted` 인데 동기 getter 만 `denied`). 앱은 동기 getter 를 보므로 헤드리스에서는 패널이 늘 「거절됨」이다.
p4-t7 은 Playwright 가 받아 둔 Chromium(`~/Library/Caches/ms-playwright`, Google Chrome for Testing — 없으면 `pnpm dlx playwright@1.62.1 install chromium` — 저장소의 playwright-core 1.62.1 과 같은 버전이어야 그 Chromium 빌드를 찾는다)을 `playwright-core`(openclaw 가 끌어오는 전이 의존성 — 브라우저를 내려받지 않는다)로 **headed** 로, `--window-position=-2400,-2400` 으로 화면 밖에 띄워 사람 화면을 가리지 않았다. 이 빌드는 Google Chrome for Testing 이라 **실제 FCM 수신까지 된다** — 시스템 Chrome 으로 갈아탈 필요가 없었다. 프로필은 스크래치패드의 영구 프로필(`launchPersistentContext`)이고, 권한은 `context.grantPermissions(["notifications"], { origin: "http://localhost:5180" })` 로 준다.
BrowserOS neo 를 쓸 수 있으면 neo 의 CDP(`docs/guides/browser-verification.md`)에 붙여도 된다 — 권한은 `Browser.grantPermissions`, 끝나면 `Browser.resetPermissions`(9.2).

**켜기** — 로그인 → 사이드바 하단 「알림」 → 「푸시 알림 켜기」 → 「이 기기에서 알림을 받습니다」. 서버 행은 읽기 전용으로 본다: `sqlite3 -readonly data/dev-fake.sqlite "select user_id, substr(endpoint,1,40) from push_subscriptions"`(endpoint 는 `https://…google.com/fcm/send/…`). 브라우저 쪽 플래그는 `localStorage["dodok.push"]`(= 켠 사용자 id).

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

**서버 트리거를 실물로 — 실제 `web-push` → FCM**. `dev:fake` 키워드(p4-t6):

| 푸시 | 보낼 글 | 조건 |
| --- | --- | --- |
| 멘션 | `@dev 나 불러` | 답 `@owner 확인해 주세요` 가 owner 를 멘션한다. **그 채널을 보이는 탭으로 보고 있으면 오지 않는 것이 정상**(결정 2) — 다른 채널로 옮기거나 탭을 숨긴 뒤. `나 불러 느리게` 면 델타가 1.5초 간격이라 옮길 시간이 난다 |
| 승인 요청 | `@dev 승인` · `승인 둘`(두 건, tag 가 달라 둘 다 뜬다) · `승인 항상` | 같음. 푸시가 켜진 기기는 탭 안 승인 알림(`new Notification`)이 0회여야 한다(결정 8) |
| 릴레이 한도 | `@dev @fin 시작` | 채널에 dev·fin 둘 다. 채널 설정에서 릴레이 턴 상한을 1 로(`PATCH /channels/:id {relayPolicy:{maxRelayTurns:1, allowPairs:"all"}}`) 하면 곧바로 닿는다 |

도착은 `registration.getNotifications()` 로 본다 — **성공 발송은 서버 로그를 남기지 않는다**(실패만 `push send failed`(warn)·`push rejected`(error)). 알림 본문에 메시지 본문·툴 인자가 없는 것, 서버 로그에 `p256dh`·비밀 키·알림 문구·`fcm/send` 가 없는 것도 같이 본다(p4-t7 H — 0회).
⚠ 자동화 브라우저를 강제 종료(kill)하며 여러 번 붙으면, 죽은 소켓이 ping 제한까지 presence 에 남아 「보고 있음」으로 한 번 더 걸러질 수 있다(p4-t7 「확인됨」 2). 헷갈리면 서버를 `--keep` 으로 다시 띄워 presence 만 비운다.

**알림 누르기** — 헤드리스·CDP 로는 시스템 알림을 누를 수 없고, 서비스 워커 안에서 `new NotificationEvent("notificationclick", …)` 를 합성하면 `waitUntil` 이 `InvalidStateError` 로 던진다(신뢰되지 않은 이벤트). p4-t5 리뷰·p4-t7 은 서비스 워커 컨텍스트(`ctx.serviceWorkers()[0].evaluate`)에서 신뢰된 클릭에만 허용되는 셋 — `ExtendableEvent.prototype.waitUntil`·`WindowClient.prototype.focus`·`clients.openWindow` — 만 기록하는 것으로 대신 풀고, 나머지(창 고르기·`postMessage`·앱의 라우터 이동)는 빌드본 그대로 돌렸다.
기대: 다른 채널에 열린 창이 앞으로 오고(`focus` 1회, `openWindow` 0회) **새로고침 없이** 그 채널 활동 탭으로 옮겨 간다(누르기 전 심은 `window.__marker` 가 남는다). 창이 없으면 `openWindow("/c/<id>…")` 1회. **OS 창이 실제로 앞으로 오는지는 14.3 — 사람이 본다.**

**오프라인** — Playwright `context.setOffline(true)` 뒤 새로고침하면 `navigator.onLine` 이 `true` 로 돌아온다(CDP `Network.emulateNetworkConditions` 도 같다 — p4-t4 리뷰 탐침). 그 판은 「브라우저는 온라인인데 서버에 안 닿는」 경우라 배너가 me 재시도 뒤 약 3초에 뜬다.
「기기가 처음부터 오프라인」은 초기화 스크립트로 `navigator.onLine` 을 `false` 로 두고 모든 요청을 막아 흉내 낸다 — 기대는 API 요청 0·토스트 0·배너 1(p4-t7 K). 실제 비행기 모드는 14.3.

**정리** — 등록한 서비스 워커·캐시·IndexedDB(`keyval-store`)를 지우고, 푸시 구독을 해지하고(「끄기」 또는 `getSubscription()?.unsubscribe()`), 컨텍스트를 닫고 프로필 디렉터리를 지운다. 3100·5180 을 내리고 LISTEN 0 을 확인한다(5173 은 그대로). 워크트리에서 띄웠으면 `dev:fake` 가 만든 워크트리 `data/` 를 지운다. **최상위 `data/vapid.json` 은 지우지 않는다** — 개발자의 키다.

### 14.2 원격 배포에서 VAPID 키 옮기기

서버는 키를 두 곳 중 하나에서 얻는다(`apps/server/src/modules/push/vapid.ts`). **환경변수 `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY` 가 둘 다 있으면 그것**, 아니면 `<DATA_DIR>/vapid.json`(`{"publicKey","privateKey"}`, 없으면 처음 부팅 때 만들고 0600). 한쪽 환경변수만 주면 없는 것으로 보고 파일을 쓴다.

**키를 바꾸면 모든 기기의 푸시 구독이 무효가 된다.** 구독은 만들 때의 공개키에 묶여 있어서다. 옮길 때는 같은 키를 그대로 가져간다:

- **파일로** — 옛 서버의 `data/vapid.json` 을 새 서버의 `DATA_DIR` 로 복사하고 `chmod 600`. 환경변수는 비워 둔다.
- **환경변수로** — 파일의 두 값을 배포의 비밀 저장소(또는 서버 호스트의 `.env`)에 `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY` 로 넣는다. 둘 다 있으면 파일은 읽지도 만들지도 않는다. 비밀 키는 로그에서 가린다(`VAPID_PRIVATE_KEY`·`privateKey`). 시크릿 규칙(2절)대로 `data/`·`.env` 에만 두고 커밋하지 않는다.
- ⚠ `data/` 를 새로 만든 채(파일도 환경변수도 없이) 부팅하면 **새 키가 조용히 생긴다** — 그 순간 옛 구독은 모두 무효다. 망가진 파일은 덮어쓰지 않고 부팅을 멈춘다(「지우면 새로 만들지만 모든 푸시 구독이 무효가 된다」).
- 키가 바뀐 뒤: 앱을 다시 연 기기는 동기화(`syncPushSubscription`)가 서버 공개키와 구독의 키를 비교해 새로 구독한다(푸시를 켠 그 사용자로 로그인해 있을 때). 앱을 열지 않은 기기는 그때까지 못 받는다. 옛 구독으로 보낸 발송의 응답 코드가 무엇인지(404·410 이면 행이 지워지고, 403 이면 행을 남기고 `push rejected` error)는 재지 않았다.

**`VAPID_SUBJECT` 는 실제 연락처로** — `mailto:ops@example.com` 또는 `https://…`(`mailto:`/`https://` 뒤에 공백 없는 값이 있어야 한다 — 아니면 설정 오류로 부팅하지 않는다). 기본값 `mailto:dodok@localhost` 는 개발용이다.
주체의 호스트가 `localhost`·`127.0.0.1`·`*.local` 이면 **Apple Push(Safari·iOS)가 `403 BadJwtToken` 으로 거부한다**(web-push#947·#988) — 서버는 시작 때 warn 한 줄을 남기고, 발송 403 은 구독을 지우지 않고 error 를 남긴다(키·주체 문제라 구독 탓이 아니다). FCM(Chrome) 은 로컬 주체로도 받았다(p4-t7).
실기기에는 HTTPS 배포가 필요하다 — 서비스 워커·푸시는 보안 출처에서만 돈다(`localhost` 는 예외). 배포 구성은 Phase 3 이다(`docs/plan.md` 8장).

### 14.3 사람이 볼 것 (자동화가 원리상 못 잰 것)

`dev:fake` + 빌드본 preview(14.1)면 된다(모델 런 0회). 브라우저는 사람이 쓰는 데스크톱 Chrome 이고, 알림 권한은 **출처별**이라 `http://localhost:5180` 으로 연다.

| # | 볼 것 | 어떻게 | 통과 기준 |
| --- | --- | --- | --- |
| 1 | **실제 OS 알림 클릭** | 푸시를 켜고 작성기에 초안을 조금 쓴 뒤, 그 창을 **다른 채널에 두거나 최소화**한다 → 다른 브라우저 프로필이나 `pnpm wire-cli` 로 에이전트가 있는 채널에서 `@dev 승인` → macOS 알림 센터의 dodok 알림을 누른다 | 그 브라우저 창이 **앞으로 오고** 그 채널 활동 탭(`/c/<id>/activity`)으로 옮겨 간다. 작성기에 써 둔 초안이 남아 있다(새로고침이 아니다) |
| 2 | **창이 없을 때 클릭** | dodok 탭을 모두 닫고(브라우저는 켜 둔 채) 다른 프로필이나 `pnpm wire-cli` 로 `@dev 나 불러` 를 보내 알림을 누른다 | 새 창이 그 채널(`/c/<id>`)로 열린다 |
| 3 | **「앱 설치」를 끝까지** | 「알림」 패널의 「앱 설치」 → OS 설치 대화상자 → 설치 | 설치된 앱이 독립 창(standalone)으로 뜨고, 패널의 「앱 설치」 버튼이 사라진다. 설치된 창에서도 1 이 된다 |
| 4 | **macOS 알림 모양** | 1·2 의 알림을 본다. 알림이 뜬 채 화면을 잠근다 | 제목 `dodok`, 본문은 누가·어디·무엇뿐(「@dev가 #<채널>에서 불렀습니다」·「#<채널>에 승인 요청이 있습니다」·「#<채널>의 에이전트 대화가 한도에 닿았습니다」). 아이콘이 dodok 아이콘이다. 잠금 화면에도 메시지 본문·툴 인자가 없다 |
| 5 | **가려진 창 경계** | 같은 채널을 연 창을 다른 창 뒤로 **일부만** 가리거나 포커스만 빼고 → 그 채널에서 `@dev 승인` | 기록한다: 푸시도 탭 안 알림도 안 뜨는가. 창이 `visible` 이면 서버가 걸러 알림이 아무 데도 안 뜰 수 있다 — `docs/plan.md` 8장 「이월」(판단 필요) |
| 6 | **실제 기기 오프라인** | 앱을 한 번 연 뒤 Wi-Fi 를 끄고(비행기 모드) 앱을 새로 연다 → 다시 켠다 | 곧바로 배너 「오프라인 — 저장된 내용을 보여 줍니다」와 최근 채널, 토스트 없음, 보내기 막힘. 다시 연결되면 배너가 사라진다 |
| 7 | **iOS·안드로이드 실기기** | **Phase 3**(HTTPS 배포 뒤) | iOS 16.4+ 는 홈 화면에 추가한 앱에서만(패널 「홈 화면에 추가하면 알림을 받을 수 있습니다 — …」). `VAPID_SUBJECT` 가 실제 연락처여야 Apple 이 받는다(14.2) |

9절의 탭 안 승인 알림(「승인 필요 — @dev 가 Write 를 실행하려 합니다」)은 **이 기기에 푸시가 켜져 있으면 쉰다**(결정 8). preview(14.1)에서 9절을 볼 때는 「푸시 알림 켜기」로 권한을 허용한 뒤 「끄기」를 누른다 — 권한은 `granted` 로 남고 플래그가 지워져 탭 안 알림이 돈다. dev 서버(서비스 워커 없음)에서는 「푸시 알림 켜기」가 권한만 받고 10초 뒤 「서비스 워커가 준비되지 않았습니다」로 끝난다 — 「끄기」 버튼은 생기지 않고, 플래그가 없으므로 그대로 탭 안 알림이 돈다. 옛 「알림 켜기」 토글은 「알림」 패널로 옮겨졌다(푸시를 지원하지 않는 브라우저에서만 「탭이 열려 있을 때만 알림 켜기」로 남는다).

### 14.4 실연 — 2026-09-24 결과 (p4-t9, 계획 태스크 9)

11절 하네스(가짜 claude CLI 가 `@owner` 를 멘션하는 답을 낸다)로 실제 dev Gateway·플러그인·서버·실제 FCM 경로를 모델 런 0회로 먼저 돌린 뒤, 사용자 승인 상한(**모델 런 1회**) 그대로 실제 모델로 한 번 돌렸다.

**판정: 경로는 실물에서 돈다 — 런 0회 하네스 7/7 통과(같은 세션에서 여러 번 재현). 모델 런 1회는 합격 기준 3(멘션 파싱)·6(본문 무유출, finalSource=plugin 관찰로 대체 확인)은 통과, 5(브라우저 알림 표시)는 서버 발송·Chromium GCM 계층 수신까지는 확인했으나 관찰 창(약 15초) 안에 알림으로 표시되지 않았다 — 직후 같은 세션에서 하네스로 같은 경로를 재현하면 2초 만에 정상 도착해, dodok 코드 결함으로는 보지 않지만 원인을 특정하지 못한 채 미해결로 남긴다(아래 14.4.4).**
로그는 워크트리 `data/`(ignored, 정리 시 삭제): `dev-gateway.log`·`phase2-live-t9.log`(서버)·`vite-preview-t9.log`·`live-smoke.sqlite`. 브라우저 자동화 스크립트(`playwright-core` 로 여는 컨트롤 서버)는 세션 스크래치 디렉터리에 두고 끝나며 지웠다(레포에 커밋된 것 없음).

#### 14.4.1 환경 실물

| 항목 | 값 |
| --- | --- |
| 워크트리 | `main f92f799`(이 실연 시작 시점의 main HEAD, 코드 변경 없이 그대로) |
| Gateway | `OpenClaw 2026.9.5 (f396007)` — 12·13절과 같다. 서버 로그 `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-f39600759bec-2026-09-19T05-09-16.000Z"`(12·13절과 같은 buildId), scopes 에 `operator.admin`. `"bridge plugin hello"` 도 `gatewayVersion="2026.9.5"`(같은 줄 `pluginBuiltWithSdk="2026.9.4"` 는 빌드 상수) |
| VAPID 주체 warn | 부팅 로그에 정확히 1줄: `"vapidSubject":"mailto:dodok@localhost"` `"msg":"VAPID subject is a local placeholder — Apple Push rejects it (403 BadJwtToken)"`(기본값 그대로 — 스펙 11장 보탬) |
| 플러그인 번들 | **재설치했다** — 브리프는 「`packages/openclaw-plugin` 이 안 바뀌었으면 sha 만 대조」였지만, `git log ae63cf8..HEAD -- packages/openclaw-plugin` 는 0커밋인 반면 `-- packages/shared` 는 2커밋(`e9d2ede`·`b65a247`, 푸시 구독·페이로드 계약·`presence.update`)이었다. `pack:plugin` 은 esbuild 로 `@dodok/shared` 를 번들에 넣으므로, 플러그인 자체 소스가 안 바뀌어도 산출물 sha 가 달라진다 — 실제로 설치 전(`f5dc6438…`, a3-t13 때 빌드) ≠ 이번 빌드(`e4a6284c…`). **Gateway 를 내린 채로** 재설치했고, 설치 뒤 sha 가 빌드본과 같음을 확인했다(아래). `status: "loaded"` |
| 서버 | `:19100`, `APP_ORIGIN=http://localhost:5180`, DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug` |
| 웹 | 빌드본 `vite preview --port 5180 --strictPort`(`DODOK_API_ORIGIN=http://127.0.0.1:19100`) — 5173 은 다른 프로젝트라 무접촉, 3000 도 무접촉 |
| 브라우저 | `playwright-core@1.62.1`(워크트리 `node_modules/.pnpm` 안의 것, 새로 설치하지 않음) + 캐시된 Chromium `chromium-1234`(리비전이 1.62.1 의 `browsers.json` 과 일치, "Google Chrome for Testing" 151.0.7922.34) — **headed**, `--window-position=-2400,-2400`, 영구 프로필은 세션 스크래치 디렉터리(사람의 실제 브라우저 프로필 아님). 권한은 `context.grantPermissions(["notifications"], { origin: "http://localhost:5180" })` |
| 채널 | 하네스 `harness-09240304`(`01a0cf70-620c…`) · 억제/실도착 확인용 `other-09240313`(`01a0cf79-007e…`) · 모델 런 `model-t9-09240333`(`01a0cf8b-0b3c…`) — 런마다 새 채널(가짜 세션 id 와 섞이지 않게, 11.1 주의대로) |
| 사람 | owner(핸들 `owner`, id `01a0cf70-0fec-7665-a303-ad307112077a`) — 실연 서버가 매 부팅 새로 부트스트랩한 계정. 로그인은 `LOCAL_AUTH_TOKEN`(서브셸 변수로만, 로그·argv 에 안 남김) |
| 모델 | `anthropic/claude-opus-5` + claude-cli. CLI 보고 비용 **$0.6010**(새 세션 캐시 생성 59,649 토큰, `duration_api_ms 3893`). dodok `RUN_FINISHED` 자체 집계는 `inputTokens:2 outputTokens:4 costUsd:0` — 5.4·13.3 이월(usage 값 불일치)과 같은 줄기, 이번에 새로 파지 않았다 |

#### 14.4.2 합격 기준 — 런 0회 하네스 (11절, 여러 차례 재현)

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 버전 로그 | **통과** | 위 환경 표 — `gatewayVersion`·`gatewayBuildId` 가 12·13절과 같다. VAPID 로컬 주체 warn 1줄 |
| 2 | 설치 번들 sha = 빌드본 | **통과(재설치 경로로)** | 설치 전 `f5dc6438…` → 재설치 후 `e4a6284c5df128a018841f71ba0ca9f01f6fc4757d9fdf0c917dab25dbe42ebb` = `packages/openclaw-plugin/dist/index.js` 빌드본과 동일. `plugins inspect` `status:"loaded"` |
| 3 | 에이전트 답(플러그인 경로)의 `mentions.users` 에 사람 id | **통과** | 하네스 `message` 툴 호출로 보낸 `"@owner 한마디: 확인해 주세요"` → REST `GET .../messages` 의 그 메시지 `mentions:{agents:[],users:["01a0cf70-0fec-7665-a303-ad307112077a"]}`. wire 로도 `finalSource=plugin`·`runId`·`replyTo` 일치(ADR 0004 6절 기준 재확인) |
| 4 | 보고 있으면 거름 | **통과** | 브라우저가 하네스 채널을 보이게 보는 상태에서 같은 트리거 3회(최초·재확인·GCM 연결 뒤) → `registration.getNotifications()` 매번 `[]` |
| 5 | 다른 채널/탭 닫음 → 실제 FCM 알림 1건 | **통과** | 아래 14.4.3 참고 — 여러 차례 실패 끝에 A 를 걷은 뒤부터는 매번 성공했다(당시 원인으로 함께 꼽은 B 는 p4-c1 이 재현하지 못해 정정했다). 도착 페이로드: `{"title":"dodok","body":"@dev가 #harness-09240304에서 불렀습니다","tag":"mention:01a0cf70-620c-76bd-946b-90dd0fc0f6b0","data":{"url":"/c/01a0cf70-620c-76bd-946b-90dd0fc0f6b0"}}` — 스펙 5.2 문구·url·tag 그대로. 탭을 모두 닫고 SW 컨텍스트로 읽은 것도 같은 페이로드로 도착(p4-t7 방법) |
| 6 | 본문에 유일 문구 없음 | **통과** | 도착한 알림 본문 어디에도 트리거 문구(`"가짜 CLI 프로브"`·`"한마디: 확인해 주세요"`)나 `FAKE_CLI_DONE` 이 없다 — 「누가·어디」만 있다(결정 1) |
| 7 | 로그 위생 | **통과** | 아래 14.4.5 |

**추가로 CDP `ServiceWorker.deliverPushMessage` 로 직접 주입한 테스트 페이로드도 즉시 알림으로 떴다** — 브라우저 쪽 SW·알림 표시 파이프라인 자체는 항상 정상이었다(14.4.3 의 실패가 클라이언트 문제가 아니라는 근거).

#### 14.4.3 새로 찾은 것 — 실제 FCM 전달의 타이밍 제약 (제품 결함 아님, 절차 보탬 — B 는 p4-c1 이 정정)

이 둘은 dodok 코드가 아니라 **자동화 헤드리스/headed Chromium + 실제 Google 푸시 인프라**의 특성이다. 14.1 의 CDP `deliverPushMessage`(가짜 주입)로 확인하던 이전 검증(p4-t7)은 이 경로를 두드리지 않아 못 봤다.

- **A. `--disable-background-networking` 가 실제 GCM 연결을 막는다.** Playwright 의 기본 자동화 인자에 이 플래그가 들어 있다(`ps aux` 로 확인). 이 플래그가 있는 채로는 `chrome://gcm-internals` 가 `GCM Client State: LOADING`·`Connection Client Created: false` 에서 멈췄고(수 분 대기·45초 대기 재시도 모두 실패), 실제 FCM 발송이 브라우저에 전혀 닿지 않았다(서버는 발송을 시도하지만 알림이 안 뜬다). `chromium.launchPersistentContext(..., { ignoreDefaultArgs: ["--disable-background-networking"] })` 로 그 인자만 뺀 뒤에는 `Connection State: CONNECTED`(`mtalk.google.com`)까지 갔고, 그 뒤로는 실제 FCM 발송이 매번(하네스 재현 포함) 도착했다. **다만 이 플래그 하나가 유일한 원인인지 A/B 로 엄밀히 가르진 않았다** — 플래그 제거 전에는 최대 45초 대기까지도 실패했고, 제거 뒤에는 몇 차례(약 15~30초, 처음 구독을 만들고 실제 체크인까지는 더 걸릴 수도 있다) 만에 성공한 정황 증거다.
- **B. ~~탭을 닫으면 소켓 정리가 최대 45초 걸려 그 채널 푸시가 억제된다~~ — p4-c1 이 재서 재현되지 않았다(정정).** p4-t9 는 「탭을 닫은 직후 트리거 → 도착 0 → 45초 뒤 재현 → 도착」을 보고 engine.io 핑 시간(25s+20s)으로 설명했지만, 그때 서버는 걸렀는지·보냈는지를 로그로 남기지 않아 **도착 여부로만** 판단했고 같은 실연의 A(GCM 연결 지연)와 겹쳤다. p4-c1 은 `dev:fake`(3100)+빌드본 preview(5180)에서 headed Chromium(Chrome for Testing, 1.62.1)으로 서버 소켓의 connect·`presence.update`·disconnect·발송 시각을 직접 기록했다(닫은 뒤 곧바로 `@dev 나 불러` 트리거):

  | 경로 | 닫기 방식 | 서버 disconnect(닫기 호출부터) | `visible:false` 도착 | 트리거 발송 |
  | --- | --- | --- | --- | --- |
  | 앱(SW·푸시 켬), preview 프록시 경유 — 고치기 전 | `page.close({runBeforeUnload:true})` · CDP `Target.closeTarget` · `page.close()` · `goto about:blank` · `goto` 다른 오리진 | 9~68ms(`transport close`) | 5종 모두 disconnect 전(3~26ms) | 5/5 보냄(630~676ms) |
  | 앱, 같은 조건 — 고친 뒤(pagehide) | 같은 5종 + 닫기 3종 한 번 더 | 11~123ms | 8/8 disconnect 전(1~14ms) | 8/8 보냄(621~749ms), 서버 debug `push sent` 201 |
  | 최소 프로브(앱과 같은 presence 규칙), 프록시 경유 | `runBeforeUnload` · `Target.closeTarget` · `goto` 다른 오리진, pagehide 전송 유무 각각 | 4~590ms | 6/6 disconnect 전 | 6/6 보냄 |
  | 최소 프로브, 서버 3100 직접 | 같은 6조합 | 50~81ms | 6/6 disconnect 전 | 6/6 보냄 |

  탭을 닫든 다른 주소로 가든 브라우저가 웹소켓을 곧바로 닫고(React 정리가 안 돌아도 된다), vite preview 프록시도 늦추지 않는다. Chromium 은 언로드 때 `pagehide`(이때 `visibilityState` 는 아직 `visible`) 다음 `visibilitychange` hidden 을 보내고, 그 뒤에 소켓이 닫힌다. 웹은 이제 `pagehide` 에서도 「안 보임」을 강제로 보낸다(`WireProvider` `attachPresence` — 언로드 때 `visibilitychange` 가 오지 않는 엔진 대비, Chromium 에서는 결과가 같다). **남는 최대 45초 창은 close 가 서버에 가지 않는 경우 — 네트워크 단절·절전·프로세스 멈춤 — 뿐이다**(스펙 10장 트레이드오프, `pagehide` 로도 못 막는다).
  실제 알림 도착: 데워진 프로필에서는 닫기 3종 3/3 이 닫은 뒤 1.7~1.9초에 SW `getNotifications` 로 잡혔다. 새 프로필 첫 몇 분에는 5건 중 2건만 20초 안에 잡혔다(서버는 5건 모두 201) — A 와 같은 GCM 준비 쪽으로 보이며, 같은 `Topic` 의 대기 메시지가 다음 발송에 밀려 풀린 것처럼 보이는 꼴이었지만 원인은 가르지 않았다.
  **이제 서버가 가른다** — `LOG_LEVEL=debug` 면 디스패처가 거를 때 `push skipped — watching`(`userId`·`channelId`·`kind`), 푸시 서비스가 받으면 `push sent`(`subscriptionId`·`statusCode`)를 한 줄씩 남긴다. 다음 실연은 「걸렀다·보냈다·보냈는데 안 왔다」를 이 두 줄과 `chrome://gcm-internals` 로 가른다. `dev:fake` 진입점은 로그 수준을 `info` 로 고정하므로 debug 줄을 보려면 `startDevFake({ logLevel: "debug" })` 로 감싸 띄운다.

#### 14.4.4 모델 런 (상한 1, 실제 1)

`model-t9-09240333` 채널에서 `"@dev owner 에게 한마디 해 줘 — 답에 @owner 을 꼭 넣어"` 를 보냈다. 브라우저는 `other-09240313` 채널을 보고 있었다(A·B 를 걷은 뒤 안정적으로 통과하던 그 세션과 같은 브라우저 인스턴스).

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 3 | 모델 답의 `mentions.users` 에 사람 id, `finalSource: plugin` | **통과** | 모델 답: `"@owner 님, 오늘도 무사히 컴파일되는 하루 되시길 바랍니다! 🤖\n\n혹시 스택 트레이스가 47층까지 쌓이거든 주저 말고 부르십시오. 저는 육백만 가지 에러 메시지에 능통하니까요. 물론... 성공 확률은 3,720 대 1 정도겠지만, 그래도 함께 해보는 겁니다.\n\n오 메이커시여, 오늘의 빌드에 축복을! ⚠️"`. REST 로 그 메시지의 `mentions:{agents:[],users:["01a0cf70-0fec-7665-a303-ad307112077a"]}`. wire `run.state` 가 `finalSource=plugin`·`hasCanonical`, `RUN_FINISHED` 의 `messageIds` 가 그 메시지와 일치 |
| 5 | 실제 FCM 알림 도착 | **미확인(서버 발송·GCM 계층 수신까지만 확인)** | 서버가 발송을 시도했다는 것은 `lsof` 로 그 순간 dodok 서버 프로세스가 `172.217.211.101:443`(Google) 에 새 TCP 연결을 여는 것으로 간접 확인했다(하네스 발송 때도 같은 패턴). `chrome://gcm-internals` 의 **Receive Message Log** 에 우리 구독의 app id(`wp:http://localhost:5180/#4CF2BA56-AD13-4A58-9924-DAC3E54AA-V2`)로 **`Data msg received` 723 bytes** 가 모델 런 종료 약 1초 뒤(런 종료 03:33:44 무렵 → 수신 로그 03:33:45)에 찍혔다 — Chromium 이 실제로 그 발송을 받았다는 증거다. 그런데 그 뒤 약 15초(수신 직후·+5초·+10초 3회) 동안 `registration.getNotifications()` 는 계속 `[]` 였다. GCM 연결은 이미 5분 넘게 전에 `CONNECTED` 였고(같은 브라우저 인스턴스, 그 사이 다른 발송은 성공), 이 브라우저가 모델 채널을 본 적이 없어 presence 거르기로도 설명되지 않는다(14.4.3-B 는 p4-c1 이 재현하지 못했다) — 즉 14.4.3-A 도 이 건의 원인이 아니다. **모델 런은 1회로 제한돼 있어 재시도하지 않았다.** 대신 같은 세션·같은 브라우저에서 하네스로 같은 경로(다른 채널을 보며 `@owner` 멘션 트리거)를 바로 재현했더니 **2초 만에** 정상 도착했다 — 그래서 dodok 코드(트리거·발송·프레즌스 로직)의 결함으로 보지 않고, 이 한 번의 자동화 브라우저 전달 유실로 본다. 원인은 특정하지 못했다(짐작 가는 파일 없음 — 발송은 서버가 했고 수신은 Chromium 내부 GCM 파이프라인이라 dodok 코드 밖이다) |
| 6 | 본문에 모델 답 원문 없음 | **간접 확인** | 알림이 뜨지 않아 알림 자체로는 못 쟀다. 다만 알림 본문은 `triggers.ts` 의 `targetsForMessage` 가 메시지 종류와 무관하게 항상 `"{작성자}가 #{채널}에서 불렀습니다"` 템플릿만 만든다(모델의 실제 텍스트를 읽지 않는다) — 이 코드 경로는 하네스에서 같은 함수로 여러 번 통과 확인했다(위 14.4.2-6). 이번 모델 답 원문(`"컴파일되는 하루"`·`"스택 트레이스"` 등)이 알림 페이로드에 실릴 경로 자체가 없다 |

#### 14.4.5 로그 위생

| 검사 | `phase2-live-t9.log`(서버) | `vite-preview-t9.log` | `dev-gateway.log`(Gateway/플러그인) |
| --- | --- | --- | --- |
| `p256dh` | 0 | 0 | 0 |
| 구독 endpoint(`fcm/send` 부분 문자열) | 0 | 0 | 0 |
| VAPID 비밀 키 값 | 0 | 0 | 0 |
| 알림 본문 문구(`불렀습니다`) | 0 | 0 | 0 |
| 모델 답 원문(`컴파일되는 하루`·`스택 트레이스`) | 0 | 0 | **2** |

마지막 줄이 dodok 서버·어댑터 로그는 아니다 — `dev-gateway.log` 는 `OPENCLAW_CLI_BACKEND_LOG_OUTPUT=1`(live-smoke 3절 (c), 우리가 디버깅용으로 켠 Gateway 자체 옵션)로 claude-cli 의 stdout(`assistant`·`result` 레코드) 이 그대로 찍힌 것이다 — dodok 코드가 로그에 쓴 것이 아니라 OpenClaw CLI 백엔드 표준출력 캡처다. 이 파일은 워크트리 `data/`(ignored, 커밋 안 됨)에만 있었고 정리 때 지웠다. dodok 이 직접 쓰는 서버·웹 로그 기준으로는 7번 기준 그대로 **통과**다.

#### 14.4.6 사람이 볼 것

14.3 의 표 그대로(이번 실연은 전부 자동화 스크립트로 돌렸다 — 실제 macOS 알림 클릭·앱 설치 끝까지·iOS/안드로이드 실기기는 여전히 사람 몫, Phase 3).

#### 14.4.7 정리·잔여물

- 서버(SIGINT)·tsx watch/pnpm 부모·Gateway(SIGTERM) 를 내렸다. **19001·19100·5180 LISTEN 0(3100·3000 은 이번 실연이 쓰지 않았다), 5173 은 1 그대로**(다른 프로젝트, 무접촉).
- 설치본은 `e4a6284c…`(main `f92f799` 빌드), `status: loaded`, `channels.dodok.channels` 는 설정된 적 없음(이미 비어 있었다). 계정·에이전트·승인 정책 무변경.
- 가짜 claude CLI·컨트롤 서버 스크립트·Chromium 영구 프로필은 세션 스크래치 디렉터리에서 지웠다(레포·워크트리 밖).
- `~/.openclaw-dev/workspace`·`~/.openclaw-dev/media` 에 이번 세션이 새로 만든 파일은 없다(모델 런이 파일을 만들지 않는 요청이었다).
- 워크트리 `data/`(로그·DB·`vapid.json`·`live-smoke.env`·`wire-cli-session.json`) 를 통째로 지웠다. 저장소 최상위 `data/` 는 애초에 건드리지 않았다.
- **남긴 것**: dev 채널 세션 3개(하네스·`other`·모델 런 채널 — REST 로 만든 실연 채널, 실제 claude 전사 1건은 `~/.claude/projects/…` 에 있다, 읽지도 고치지도 않았다). 시크릿(`BRIDGE_TOKEN`·dev Gateway 토큰·`LOCAL_AUTH_TOKEN`) 값의 로그·DB 노출 0(위 14.4.5 와 같은 확인 범위).
- 검사: 루트 `pnpm fmt:check` exit 0. (이번 태스크는 코드를 고치지 않았으므로 `pnpm test`·`typecheck`·`lint` 는 다시 돌리지 않았다 — main `f92f799` 기준 그대로다.)

## 15. 설정 마법사(Phase 3 ②) 실연 — 2026-09-25 결과 (s2-t7, 계획 태스크 7, 모델 런 0회)

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
| 2 | 서버가 내려준 tgz 로 설치 | **통과** | `pack:plugin` 뒤 부팅 → `status.pluginFile.available:true`. owner `GET /api/v1/setup/plugin.tgz` 200·195,283 B·`filename="dodok-openclaw-plugin-95f80fb8c77e.tgz"`, 받은 sha256 `95f80fb8…` = `status.pluginFile.sha256`. 익명 401. Gateway 를 내리고 `oc --dev plugins install <받은 파일> --force --accept-capabilities` → `Installed plugin: dodok`·`Saved for the next Gateway start.` · `inspect` `"loaded"`·`["dodok"]` · 설치본 `dist/index.js` = `9e59c7a5…` = `status.pluginFile.bundleSha256` = tgz 안 `package/dist/index.js`. 명령은 연결 페이지 설치 블록(= `docs/guides/deploy.md` 「[PC → B] 플러그인 설치·브리지 설정」 [B])과 같은 꼴 — 다른 것은 dev 의 `--dev`, 파일 자리(페이지는 `/tmp/<받은 이름>`, 이번엔 같은 이름으로 스크래치), sha 대조 경로(`~/.openclaw-dev/…`)뿐 |
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

dev 는 모든 `openclaw` 에 `--dev` 를 붙이고 상태 디렉터리가 `~/.openclaw-dev` 다. 원격 Gateway 호스트는 `docs/guides/deploy.md` 「[PC → B] 플러그인 설치·브리지 설정」의 [B] 와 같은 자리에서 한다.

1. 연결 페이지 「브리지 토큰」 → 「새 토큰 발급」 → 라벨. 대화상자의 「설정 복사」로 `pluginConfig` 조각을 복사한다(원문은 이때 한 번만 보인다).
2. Gateway 호스트에서 조각을 **파일로** 저장한다 — `umask 077` 인 셸에서 편집기로 붙여 넣는다. 셸 인자·`echo` 로 넘기지 않는다(`ps`·셸 기록에 남는다).
3. `openclaw config patch --file <파일> && rm <파일>`. 조각에는 `bridgeUrl` 도 들어 있다 — 서버의 `BRIDGE_PUBLIC_URL`(없으면 `APP_ORIGIN` 에서 만든 값)이 그 Gateway 가 서버에 닿는 주소와 다르면 조각 그대로 넣으면 안 된다. 2026.9.5 는 Gateway 재기동 없이 dodok 채널만 다시 띄운다(`Change will apply without restarting the gateway.`) — 브리지가 한 번 끊겼다가 새 토큰으로 곧 붙는다. 출력이 재기동 없이 적용된다고 말하지 않으면 Gateway 를 재기동한다.
4. 연결 페이지에서 새 토큰 줄에 「지금 접속 중」이 뜨는 것을 본다. 서버 로그로는 가를 수 없다(`"bridge plugin hello"` 에 tokenId 가 없다) — 화면이나 `GET /api/v1/setup/status` 의 `bridge.plugin.tokenId` 로 본다.
5. 옛 토큰 줄 「폐기」. 지금 연결은 끊기지 않는다. 옛 토큰으로 붙는 것은 그 뒤로 `UNAUTHORIZED` 다.
6. 서버 `.env` 에 `BRIDGE_TOKEN` 이 남아 있으면 부팅마다 warn 한 줄·화면 한 줄이 뜬다. 되살아나지는 않는다 — 지워도 되고 둬도 된다.

### 15.5 새로 찾은 것

- **환경(고침) — `OpenClaw.app` 2026.9.6 번들에 CLI 가 없다.** 3절의 `OCBIN`(앱 번들 bin)이 가리키던 `openclaw` 가 사라져 `env: openclaw: No such file or directory` 로 멈춘다. 저장소 `2026.9.4` CLI 는 9.5 가 쓴 dev 설정을 거부한다. 2절 표·3절 머리·11.1 을 스크래치 설치 `openclaw@2026.9.5` 로 바꿨다(글로벌 설치 없이, `--ignore-scripts` 로 충분).
- **관찰성(낮음) — `"bridge plugin hello"` 로그에 tokenId 가 없다.** 교체 중 「어느 토큰으로 붙었나」를 서버 로그만으로는 못 가른다(화면·`setup/status` 로만). 자리는 `packages/openclaw-adapter/src/openclaw-adapter.ts` 의 `onHello` 가 남기는 `"bridge plugin hello"` 줄 — 같은 함수가 받는 세션의 `tokenId`(원문 아님)를 싣으면 된다. 코드는 고치지 않았다.
- **관찰 — 핫 리로드 교체는 브리지를 한 번 끊는다(14ms).** 스펙 「연결 페이지」의 교체 흐름이 말하는 「에이전트는 멈추지 않는다」는 맞지만 `bridge: down` 이 한 번 지나간다. 그 순간 돌던 런이 있으면 어떻게 되는지는 재지 않았다(이번 두 런은 교체 앞뒤에 따로 돌렸다).

### 15.6 사람이 볼 것

- 원격 Gateway(`wss://<도메인>/bridge`) 에서 15.4 를 끝까지 — 이번은 dev(루프백 `ws://`)만 쟀다. `docs/guides/deploy.md` 결과 표에 적는다.
- 발급 대화상자의 「설정 복사」 → Gateway 호스트 편집기에 붙여 넣기(실제 OS 클립보드) — 이번은 API 로 발급해 대화상자를 열지 않았다.
- 14.3 의 표는 그대로다.

### 15.7 정리·잔여물

- 서버(SIGINT)·tsx watch/pnpm 부모·웹(vite)·Gateway 를 자기 pid 로 내렸다. **19001·19100·5180·3000·3100·8443 LISTEN 0, 5173 은 1 그대로**(다른 프로젝트, 무접촉).
- dev 플러그인 설정 토큰을 `.env` 의 `BRIDGE_TOKEN` 으로 되돌렸다(교체와 같은 `config patch --file`, 원문 출력 없이). 폐기된 토큰이라 실연 DB 서버는 거절했고(15.3 끝), DB 를 옮겨 둔 채 새 DB 로 서버를 띄워 `env` 이어받기 → 플러그인 접속·`pluginMatches:true` 를 확인한 뒤 내렸다. `bridgeUrl` 은 `ws://127.0.0.1:19100/bridge` 그대로.
- 설치본은 `9e59c7a5…`(main `eef129b` 빌드), `status: "loaded"`. dev 에이전트·승인 정책 무변경, 원격 `~/.openclaw` 무접촉(설치 전후 목록 동일).
- dev 채널 세션 2개(`s2t7-before`·`s2t7-after`, 가짜 claude 세션 id)가 `~/.openclaw-dev` 에 남는다 — 진짜 모델 런에 쓰지 않는다. 교체 때 OpenClaw 가 만든 설정 백업(`openclaw.json.bak*`)에 실연 토큰이 남았을 수 있다(열어 보지 않았다) — 그 토큰은 지운 실연 DB 에만 있던 것이라 어디에도 통하지 않는다.
- 스크래치의 `openclaw@2026.9.5` 설치본·가짜 CLI·토큰 파일·쿠키·Playwright 스크립트, 워크트리 `data/`, `infra/local.env` 를 지웠다. Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-25.log` 는 Gateway 기본 자리라 두었다(원문 0).

## 16. 운영 보강(Phase 3 ③) 실연 — 2026-09-25 결과 (o3-t9a, 계획 태스크 9, 모델 런 0회)

실물 dev Gateway 위에서 운영 보강의 네 줄기 — Gateway 버전 드리프트 사건, 워크스페이스 런 한도, run_error 「다시 실행」, 끊김 사건(`gateway_down`·`plugin_down`) — 가 도는지 쟀다.
메시지 경로는 11절 가짜 claude CLI 로만 두드렸다 — **모델 런 0회**(가짜 CLI 의 `-p` 런 5회, 나머지 12회는 `-p` 없는 호출을 진짜 `claude` 로 넘긴 것).

**판정: 합격 기준 6/6 통과. dodok 코드 결함 0.** 새로 찾은 것은 관찰 다섯(16.5) — 그중 「Gateway 쪽 실패(`unknown`)에는 「다시 실행」 버튼이 없다」와 「끊김 시간에 서버 재접속 백오프가 들어간다」는 사람 판단 거리다.
로그는 워크트리 `data/`(ignored)에 두었다가 정리 때 지웠다: `dev-gateway.log`(Gateway·플러그인)·`phase3-live-o3t9a.log`(서버·어댑터)·`web-5180.log`.

### 16.1 환경 실물

| 항목 | 값 |
| --- | --- |
| 워크트리 | main `99d9f6b` 그대로(코드 변경 없음) |
| OpenClaw CLI·Gateway | 스크래치 설치 `openclaw@2026.9.5` → `OpenClaw 2026.9.5 (ec9c1a1)`, mise Node 24.21.0(2절 표·3절 머리). 설치 전후 `~/.openclaw`·`~/.openclaw-dev` 목록 `diff` 동일(홈 디렉터리 `..` 수정 시각만 다름 — npm 캐시) |
| 버전 로그 | `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z"`, scopes 에 `operator.admin` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"`(`pluginBuiltWithSdk="2026.9.4"` 는 빌드 상수) |
| 가짜 claude CLI | 11.4 스크립트에서 툴 호출을 뺀 꼴(늘 `FAKE_CLI_DONE`) + 실패 스위치: 스크래치에 `fake-fail` 파일이 있고 내용이 `exit` 면 `-p` 런을 stderr 한 줄·exit 1 로 끝낸다. 기록에는 argv 대신 인자 개수만 적었다. Gateway 는 **매번** `PATH="<스크래치>/fakebin:$OCBIN:$PATH"` 로 띄웠다 |
| 플러그인 번들 | 이 워크트리 `pack:plugin` 빌드본 `dist/index.js` = 설치본 = `36aaf479439de23d68ee58ba9e7688b7717f53257d8e653921377ad8a1aaf797` — **다시 설치하지 않았다**(`status: "loaded"`). dev 설정 파일 `~/.openclaw-dev/openclaw.json` 수정 시각·크기가 시작·끝에 같다 |
| 서버 | `:19100`(dev 계정 `bridgeUrl` 이 `ws://127.0.0.1:19100/bridge` 라 플러그인 설정을 바꾸지 않으려고 이 포트), `APP_ORIGIN=http://localhost:5180`, 새 DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug`. `.env` 의 `BRIDGE_TOKEN` 을 라벨 `env` 로 이어받아 플러그인이 그대로 붙었다 |
| 웹·브라우저(기준 1 화면만) | `DODOK_API_ORIGIN=http://127.0.0.1:19100 pnpm -F @dodok/web exec vite --port 5180 --strictPort` · 스크래치 `playwright-core@1.62.1` headless(`chromium_headless_shell-1234`), 폭마다 새 컨텍스트, 로그인은 `context.request.post('/api/v1/auth/local')` |
| 채널 | `o3t9a-limit`(한도) · `o3t9a-clifail`(가짜 CLI 실패) · `o3t9a-retry`(다시 실행) — 전부 멤버 `@dev`, 가짜 claude 세션 id 가 박힌 하네스 전용 |
| 내장 cron | `cron list` 의 다음 실행이 fin 2026-09-27·dev 2026-09-30 — 실연 중 돌지 않았다 |

### 16.2 합격 기준

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | Gateway 버전 드리프트 → 사건 1줄 | **통과** | 새 DB 첫 접속에 `GET /api/v1/ops/status` 의 `gateway` = `{"state":"connected","version":"2026.9.5","pinned":"2026.9.4","drift":true}`, 사건 `gateway_version_untested` `key "gateway:2026.9.5"` `info` **count 1**. Gateway 를 두 번 내렸다 올린 뒤에도 count 1 그대로, `gateway_version_changed` 0(같은 버전). 운영 화면(1280·390px): 「Gateway 버전 2026.9.5 — 저장소가 검증한 버전(2026.9.4)과 다릅니다」 줄이 `data-problem="true"`(빨간 강조), 사건 목록 「검증 안 된 Gateway 버전 (2026.9.5)」. 두 폭 가로 넘침 0, 콘솔 오류 0 |
| 2 | 워크스페이스 상한 2 → 멘션 셋 → 셋째 막힘 → 비우면 다시 돎 | **통과** | `PATCH /api/v1/ops/settings {"dailyRunLimit":2}`(기본값은 300) → `@dev 한도 프로브 하나`·`둘` 은 `FAKE_CLI_DONE`·`finalSource=plugin`. `셋` 은 런 없이 시스템 메시지 `systemMeta={"kind":"run_limit","limit":{"scope":"workspace","limit":2}}` 「오늘 런 한도(2)에 도달했습니다 — 내일 0시에 풀립니다」 + `ops.event` `run_limit` `key workspace` `warn` count 1(보낸 뒤 12ms). `넷` 을 더 보내면 시스템 메시지는 **1개 그대로**, 사건은 같은 줄 count 2. `ops/status` `runsToday 2`·`blockedToday 2`. `{"dailyRunLimit":null}` 뒤 `다섯` → 답(0.96초), `runsToday 3` |
| 3 | run_error → 「다시 실행」 → 새 런 `parentRunId` | **통과** | 카드는 **플러그인 끊기**로 만들었다(가짜 CLI 실패는 카드를 만들지 않는다 — 16.5). Gateway 를 내리고(플러그인도 함께 끊김) `@dev 다시 실행 프로브` → 런 `queued` → **120초 뒤** `RUN_ERROR code=ADAPTER_UNAVAILABLE "inbound not delivered within 120000ms"` + 시스템 메시지 「@dev 실행이 실패했습니다: ADAPTER_UNAVAILABLE」 `components items=[retry_run]`. Gateway 를 올리고 둘 다 connected 뒤 `wire-cli interact <CH> <카드 id> retry_run` → `message.updated … consumed=[retry_run]` → 새 런 `RUN_QUEUED`(+11ms) → `FAKE_CLI_DONE` `replyTo=<원래 사람 메시지>` → `done finalSource=plugin`. `GET /channels/<CH>/runs`: 새 런 `parentRunId` = 원래 런 id, `triggerMessageId` = 원래 사람 메시지, 원래 런 `error ADAPTER_UNAVAILABLE`. 사건 `run_failed` 도 남았다 |
| 4 | Gateway 끊김 70초 넘게 → `gateway_down` 열림·닫힘, `downMs` ≈ 실제 | **통과** | Gateway 자기 pid kill → 서버 `"gateway connection closed; reconnecting"`·`bridge down`(26·36ms 뒤). 30·55초에 사건 없음, **60.0초**에 `gateway_down`·`plugin_down` `warn` 열림(`detail.thresholdMs 60000`, `resolvedAt null`). 78초에 기동 명령 → 85초에 둘 다 connected → 두 줄 닫힘. `downMs` 는 서버가 본 끊김과 **1~2ms** 차: gateway 84,876(서버 closed→connected 84,877), plugin 84,851(bridge down→hello 84,853). 3번의 긴 끊김에서도 한 쌍 더: gateway 172,263(실측 172,265)·plugin 148,596(실측 148,596). 부팅 때 플러그인이 7초 늦게 붙은 것은 사건이 되지 않았다(60초 임계) |
| 5 | 로그 위생 — 토큰·본문·IP 전체 0 | **통과** | 비밀 다섯(Gateway 토큰·브리지 토큰·로컬 로그인 토큰·`BETTER_AUTH_SECRET`·wire 세션 토큰) + 레이트리밋용 틀린 토큰을 스크래치 0600 파일로 두고 `grep -a -c -F -f`. 본문 넷(`한도 프로브`·`다시 실행 프로브`·`가짜 CLI 실패 프로브`·`FAKE_CLI_DONE`), IP(`127.0.0.1`·`::1`). **서버 로그·Gateway 로그·Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-25.log`·`web-5180.log`·`GET /api/v1/ops/events` 응답·`ops_events` 테이블(8행)·가짜 CLI 기록: 토큰 0·본문 0.** IP 는 `ops_events`·사건 응답 0 — 레이트리밋 사건을 일부러 일으켜(틀린 토큰 로그인 7번 → 401×5, 429×2) `detail.ipPrefix "127.0.0.0/24"` 로 줄어든 것을 봤다. 서버 로그의 IP 142줄은 전부 Fastify 요청 로그(`req.remoteAddress`)·Gateway 재접속 오류(`ECONNREFUSED 127.0.0.1:19001`)·listening URL 이다(16.5). DB 파일은 WAL 에 wire 세션 토큰 6회 — better-auth `session` 테이블의 정본 저장(그 토큰 1행 일치), `ops_events`·`messages`·`run_events`·`runs` 덤프에는 0. 양성 대조: `live-smoke.env` 로컬 토큰 1, `.env` 브리지 토큰 1 |
| 6 | 모델 런 0 | **통과** | 가짜 CLI 호출 17 = `-p` 5(성공 4 = 한도 하나·둘·다섯·다시 실행, `exit` 실패 1) + `-p` 없음 12(진짜 `claude` 로 넘긴 버전·인증 확인). `runs` 테이블 done 4·error 2(하나는 Gateway 에 닿지 않은 `ADAPTER_UNAVAILABLE`), usage `outputTokens`·`costUsd` 합 0 |

### 16.3 절차 — 3절·11절에 더한 것

11.1 준비(3절 (c)~(e), 하네스 채널) 뒤 아래를 차례로. `W` 는 11.1 의 wire-cli, `api` 는 wire-cli 세션 캐시의 토큰을 헤더 파일로 넘기는 `curl`(토큰을 인자·화면에 두지 않는다).

```bash
api GET /api/v1/ops/status | jq '{gateway, plugin, runsToday, dailyRunLimit, blockedToday, unacked}'   # 기준 1
api GET /api/v1/ops/events | jq -c '.events[] | {kind,key,severity,count,firstAt,resolvedAt,detail}'
api PATCH /api/v1/ops/settings '{"dailyRunLimit":2}'                                                   # 기준 2 — 새 DB 라 오늘 런 0
for n in 하나 둘 셋 넷; do W send $CH "@dev 한도 프로브 $n" --watch-ms 12000; done
api PATCH /api/v1/ops/settings '{"dailyRunLimit":null}'; W send $CH "@dev 한도 프로브 다섯" --watch-ms 6000
kill <Gateway pid>   # 기준 4 — 60초 전·후로 events 를 본다. 70초 넘게 기다렸다 3절 (c)(가짜 PATH) 로 올린다
kill <Gateway pid>; W send $CH2 "@dev 다시 실행 프로브" --watch-ms 135000     # 기준 3 — 120초 뒤 run_error 카드
# 3절 (c) 로 올리고 adapter/status 가 둘 다 connected 가 된 뒤
W interact $CH2 <카드 메시지 id> retry_run --watch-ms 15000
api GET /api/v1/channels/$CH2/runs | jq -c '.runs[] | {id,status,parentRunId,finalSource,error:.error.code}'
```

- **run_error 카드는 브리지가 끊긴 채 멘션해야 생긴다.** 실물 Gateway 에서는 Gateway 를 내리면 플러그인이 함께 끊긴다 — 멘션한 런이 `queuedMs`(120초) 뒤 `ADAPTER_UNAVAILABLE` 로 닫히며 카드가 붙는다. 가짜 CLI 를 실패시키면 런 오류 코드가 `unknown` 으로 오고(어댑터가 Gateway `errorKind` 를 코드로 쓰고, 없으면 `unknown`), 서버는 그 코드에 카드를 붙이지 않는다(`orchestrator.ts` 의 `NOTIFY_CODES`).
- 같은 채널·같은 에이전트에 여러 멘션을 걸면 세션 큐 때문에 120초씩 이어진다 — 카드가 여럿 필요하면 채널을 나눈다.
- Gateway 를 오래 내렸다 올리면 서버의 Gateway 재접속 백오프(상한 30초)만큼 늦게 붙는다 — 3번 차례에서 LISTEN 뒤 24.5초. `adapter/status` 가 둘 다 `connected` 인지 보고 누른다.
- 레이트리밋 사건을 보려고 틀린 토큰으로 1분에 다섯 번 넘게 로그인하면(여섯째부터 429) **같은 IP 의 정상 로그인도 그 창이 지날 때까지 429** 다 — 웹 로그인은 그 뒤에.

### 16.4 증거 원문 (본문·토큰 없음)

```text
# 서버 — 첫 접속
{"mod":"adapter","scopes":["operator.read","operator.write","operator.approvals","operator.admin"],"gatewayVersion":"2026.9.5","gatewayBuildId":"2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z","msg":"gateway connected"}
{"event":"ops.gateway_version_untested","key":"gateway:2026.9.5","count":1,"msg":"ops event"}
# ops/status — 기준 1
"gateway":{"state":"connected","version":"2026.9.5","pinned":"2026.9.4","drift":true}
# 기준 2 — 셋째 멘션
message.created kind=system systemMeta={"kind":"run_limit","limit":{"scope":"workspace","limit":2}} body="오늘 런 한도(2)에 도달했습니다 — 내일 0시에 풀립니다"
ops.event {"kind":"run_limit","severity":"warn","key":"workspace","detail":{"limit":2},"count":1}
# 기준 4 — 닫힌 두 줄
{"kind":"gateway_down","key":"gateway","count":1,"firstAt":"2026-09-25T03:20:55.979Z","resolvedAt":"2026-09-25T03:21:20.855Z","detail":{"thresholdMs":60000,"downMs":84876}}
{"kind":"plugin_down","key":"plugin","count":1,"firstAt":"2026-09-25T03:20:55.990Z","resolvedAt":"2026-09-25T03:21:20.841Z","detail":{"thresholdMs":60000,"downMs":84851}}
# 기준 3 — 카드와 다시 실행
RUN_ERROR code=ADAPTER_UNAVAILABLE message="inbound not delivered within 120000ms"
message.created kind=system systemMeta={"kind":"run_error","runId":"01a0d696-49d3-…"} items=[retry_run] consumed=[] body="@dev 실행이 실패했습니다: ADAPTER_UNAVAILABLE"
message.updated … consumed=[retry_run]
{"id":"01a0d698-ecd5-…","status":"done","parentRunId":"01a0d696-49d3-…","finalSource":"plugin","error":null}
# 기준 5 — 레이트리밋 사건
{"kind":"ratelimit","key":"rest:/api/v1/auth/local","severity":"info","detail":{"ipPrefix":"127.0.0.0/24"}}
```

### 16.5 새로 찾은 것 (코드는 고치지 않았다)

- **사람 판단 — Gateway 쪽 실패에는 「다시 실행」 버튼이 없다.** 가짜 CLI 가 exit 1 로 끝나면 Gateway 는 `RUN_ERROR code=unknown "Claude Code process exited with code 1"` 을 보내고, 서버는 `run_failed` 사건만 남기고 채널에는 카드를 붙이지 않는다(버블의 「실행 실패」만). `NOTIFY_CODES` 가 디스패치 실패·타임아웃만 알리는 설계대로다. 실제 CLI 가 인증 만료·한도 초과로 죽어도 같은 `unknown` 으로 올 가능성이 크다 — 이 경우에도 버튼을 둘지는 판단 거리(자리는 `apps/server/src/modules/runs/orchestrator.ts` 의 `notifyRunError`).
- **사람 판단 — `downMs` 는 「서버가 본 끊김」이다.** Gateway 가 다시 떠도 서버의 Gateway 재접속 백오프(`connection-manager.ts` 의 `backoff.maxMs` 30초)가 남아 있으면 그만큼 더 끊긴 것으로 센다 — 긴 끊김에서 Gateway LISTEN 뒤 서버가 붙기까지 24.5초, 그동안 플러그인은 1초 만에 붙어 `plugin_down` 은 먼저 닫혔다(gateway 172초·plugin 149초). 운영 화면이 「Gateway 연결 끊김 (3분 동안)」 이라고 말하는 동안 실제 Gateway 정지는 2분 27초였다.
- **관찰(낮음) — `run_failed` 는 에이전트별 한 줄이라 코드가 마지막 것만 남는다.** `unknown` 1번 + `ADAPTER_UNAVAILABLE` 1번이 운영 화면에서 「런 실패 (ADAPTER_UNAVAILABLE) ×2」 로 보인다. 앞의 코드는 목록에서 사라진다(사건 `key agent:<id>`, `detail.code` 덮어씀).
- **관찰(낮음) — wire 의 `RUN_STARTED` 가 `providerRunId=undefined` 로 찍히는 런이 있다.** 같은 세션의 둘째 런(`한도 프로브 둘`)에서 났고, `GET /channels/<CH>/runs` 의 `providerRunId` 는 채워져 있다. 가짜 CLI 런에서도 나므로 모델 출력과 무관하다 — 표시 순서 문제로 보인다(재지 않았다).
- **관찰 — 서버 로그에 IP 전체가 있다.** Fastify 기본 요청 로그 `"incoming request"` 의 `req.remoteAddress`(96줄)와 Gateway 재접속 오류 메시지. 스펙이 IP 를 줄이라고 한 곳은 사건·집계라 기준 밖이다. 배포에서는 Caddy 뒤라 컨테이너 네트워크 주소가 찍힌다 — 로그 보존·공유 정책이 필요하면 판단 거리.
- 스펙대로인 것 둘: 오늘 런 수는 상태 무관이라 끊김 중 `ADAPTER_UNAVAILABLE` 로 닫힌 런도 한도를 먹는다(운영 화면 「오늘 6회」 = done 4 + error 2). 워크스페이스 상한으로 막힌 수는 채널별 표의 「차단」에 들어가지 않는다(`o3t9a-limit 차단 0`, 한도 절 「막힌 런 2회」).

### 16.6 사람이 볼 것

- 원격 Gateway(원격 배포)에서 끊김 사건 — 이번은 루프백 dev 만 쟀다. 원격은 네트워크 끊김·Caddy 재시작처럼 Gateway 프로세스가 살아 있는 끊김이 있다.
- 16.5 의 앞 두 줄(Gateway 쪽 실패의 버튼, `downMs` 의 뜻).
- 14.3 의 표는 그대로다.

### 16.7 정리·잔여물

- 서버(SIGINT, `run-state.json` `clean:true`)·tsx watch/pnpm 부모·웹(vite·pnpm 부모)·Gateway 를 자기 pid 로 내렸다. **19001·19100·3100·5180·3000·8443 LISTEN 0, 5173 은 1 그대로**(다른 프로젝트, 무접촉).
- 플러그인 설치본 `36aaf479…` 그대로(`status: "loaded"`), dev 설정 파일 무변경(수정 시각·크기 같음), dev 에이전트·승인 정책 무변경, 원격 `~/.openclaw` 무접촉.
- dev 채널 세션 3개(`o3t9a-limit`·`o3t9a-clifail`·`o3t9a-retry`, 가짜 claude 세션 id)가 `~/.openclaw-dev` 에 남는다 — 진짜 모델 런에 쓰지 않는다.
- 스크래치의 `openclaw@2026.9.5` 설치본·`playwright-core`·가짜 CLI·가짜 CLI 기록·비밀 파일, 워크트리 `data/` 를 지웠다. Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-25.log` 는 Gateway 기본 자리라 두었다(토큰·본문 0). `/tmp/openclaw/openclaw-claude-skills-*` 는 이번 실연 전부터 있던 것뿐이다.
- 운영 화면 스크린숏은 `.superpowers/sdd/2026-09-25-ops-hardening/screens/o3-t9a-ops-{1280,390}.png`(ignored).

## 17. 스레드(Phase 4 ①) 실연 — 2026-09-26 결과 (p4t-t9a, 계획 태스크 9, 모델 런 2회)

실물 dev Gateway 위에서 스레드 하위 세션이 도는지 쟀다 — 세션 키·정본이 그 스레드에·채널 세션 전사로 새는 delivery-mirror 가 없음·스레드 릴레이·채널과 동시·스레드 리셋·옛 플러그인의 `PLUGIN_OUTDATED`.
이 여덟은 11절 가짜 claude CLI 로만 두드렸고(`-p` 런 8회, 모델 비용 0), `message` 툴 카드와 최종 답 억제만 **모델 런 2회**로 봤다.

**판정: 합격 기준 8/8 통과. dodok 코드 결함 0.** 새로 안 것은 17.5 — 그중 「9.5 는 `message` 툴을 쓴 런의 최종 답을 채널·스레드 모두 억제하지 않는다」가 에이전트 가이드 문장과 맞물린다.
로그는 워크트리 `data/`(ignored)에 두었다가 정리 때 지웠다: `dev-gateway.log`(Gateway·플러그인)·`p4t-t9a-server.log`(서버·어댑터).

### 17.1 환경 실물

| 항목 | 값 |
| --- | --- |
| 워크트리 | main `446238c`(코드 변경 없음). 플러그인 번들은 문서 커밋을 얹은 main 에서 다시 빌드해도 같은 sha 다 |
| OpenClaw CLI·Gateway | 스크래치 설치 `openclaw@2026.9.5` → `OpenClaw 2026.9.5 (ec9c1a1)`, mise Node 24.21.0(2절 표·3절 머리). 설치 전후 `~/.openclaw`·`~/.openclaw-dev` 목록 `diff` 동일 |
| 버전 로그 | `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z"`, scopes 에 `operator.admin` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"` |
| 플러그인 설치본 | 시작 `36aaf479439de23d68ee58ba9e7688b7717f53257d8e653921377ad8a1aaf797` — Phase 4 이전 빌드라 번들에 `"threads"` 0(`grep -c '"threads"' ~/.openclaw-dev/extensions/dodok/dist/index.js`). 기준 7 을 이 설치본으로 먼저 쟀다 → Gateway 를 내리고 이 main 의 `pack:plugin` 빌드본 설치 → 빌드본 = 설치본 `b097e4039172228acb78ae7482b066ed1993dba7ea09e8a81b8e4ff0be162c41`(`"threads"` 2, `status: "loaded"`). **끝 설치본도 `b097e403…`** |
| 서버 | `:19100`(dev 계정 `bridgeUrl` 이 `ws://127.0.0.1:19100/bridge` — 플러그인 설정을 바꾸지 않으려고), `APP_ORIGIN=http://localhost:5180`(웹은 띄우지 않았다), 새 DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug`. `.env` 의 `BRIDGE_TOKEN` 을 라벨 `env` 로 이어받아 플러그인이 그대로 붙었다 |
| 가짜 claude CLI | 11.4 에 넷을 보탰다 — 세션 id 를 argv 에서 받아 되돌림, `fake-args.json`(배열 가능)·`fake-final.txt` 는 한 번 쓰면 치움(11.5 ⑤), `fake-sleep-ms` 가 있으면 최종 답 전에 잠듦, `user` 레코드는 **프롬프트 모양만** 적음(`[dodok context]` 헤더 줄, `스레드 루트:`·`스레드 최근:`·`최근 대화:` 줄이 있는지). 기준 1~8 동안 Gateway 는 `PATH="<스크래치>/fakebin:$OCBIN:$PATH"` 로 띄웠고, 모델 런 전에 가짜 CLI 없이 다시 띄웠다(Gateway 프로세스 `PATH` 에 `fakebin` 0) |
| 채널 | `p4t9a-harness` — `@dev`·`@fin`, `relayPolicy {maxRelayTurns:2, allowPairs:"all"}`, 가짜 CLI 전용 · `p4t9a-model` — `@dev`, 모델 런 전용 |
| 내장 cron | 실연 중 `skill-collection-review` 실행 0(Gateway 로그) |

### 17.2 합격 기준

`<CH>`=`p4t9a-harness`, `<R0>`·`<R1>`=그 채널의 스레드 루트 둘. 채널 최상위에는 루트 둘과 채널 멘션·답 여럿이 있다 — 스레드 런이 채널 대화를 받지 않는지 보려고 일부러 섞었다.

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 새 플러그인 설치 → hello 의 `threads`·`bundleSha256` 이 서버의 것과 같다 | **통과** | `GET /api/v1/setup/status` 의 `bridge.plugin.bundleSha256` = `pluginFile.bundleSha256` = `b097e403…`(옛 설치본일 때는 `36aaf479…` 대 `b097e403…`). `threads` 는 hello 가 싣지만 서버가 로그·API 어디에도 내놓지 않는다(17.5) — 번들의 `DODOK_BRIDGE_CAPABILITIES` 에 `"threads"` 가 있고, 기준 2 의 스레드 런이 `PLUGIN_OUTDATED` 없이 디스패치된 것으로 확인했다 |
| 2 | 스레드 멘션 → 스레드 세션 키·`threadId`·채널 대화 없음 → 정본이 그 스레드에·루트 요약 갱신 | **통과** | `<R1>` 스레드 답글 `@dev …` → `RUN_STARTED sessionKey=agent:dev:dodok:channel:<CH>:thread:<R1>`(+36ms). 가짜 CLI 가 받은 헤더 `[dodok context] channel=<CH> thread=<R1> you=@dev`, `스레드 루트:` 있음, `최근 대화:` 없음 — 스레드 런 5/5 가 `최근 대화:` 없음, 채널 런 3/3 은 있음. 툴 전송·최종 답 둘 다 `message.created … thread=<R1> replyTo=<답글>`, DB `messages.thread_root_id` = `<R1>`. 루트 `message.updated` 의 `threadSummary.count` 1 → 2 → 3, `agentIds` 에 `@dev`. 채널 최상위 목록(`GET /channels/<CH>/messages`)에 `threadRootId` 가 있는 메시지 0 |
| 3 | delivery-mirror 누수 없음 — 채널 세션 전사에 스레드 전송이 없다 | **통과** | 스레드 런에서 `message` 툴 1회(`sent to dodok channel <CH> (<id>)`). `chat.history` 요약 전→후: 채널 세션 `total 2·mirror 0` → **`2·0`**, 스레드 세션 `0·0` → `3·1`. 대조로 채널 런에서 같은 툴 1회: 채널 `2·0` → `5·1`, 스레드 `3·1` 그대로. Gateway `dodok:tool-send` 의 `sessionKey` 가 각각 스레드 키·채널 키, `tool-send-thread-mismatch` 0 |
| 4 | 스레드 릴레이 — 스레드 안 에이전트 답의 멘션이 같은 스레드 세션 키로 | **통과** | dev 의 스레드 답이 `@fin 스레드 릴레이 프로브`(`fake-final.txt`) → `@fin` 런 `depth=1` `RUN_STARTED sessionKey=agent:fin:dodok:channel:<CH>:thread:<R1>`(dev 답 뒤 150ms) → fin 답 `thread=<R1> replyTo=<dev 답>`. fin 의 채널 세션은 생기지 않았다(`chat.history` 0) |
| 5 | 채널·스레드 동시 | **통과** | `fake-sleep-ms` 8000 으로 채널 멘션·`<R1>` 스레드 멘션을 같이 보냄 → `runs` 의 채널 런 `started 05:49:03.551 · ended 05:49:12.681`, 스레드 런 `started 05:49:03.521 · ended 05:49:12.696`. 가짜 CLI `turn-start` 03.888·03.892, `turn-end` 12.390·12.395 — 병렬 |
| 6 | 스레드 리셋 → 스레드 세션만 새로, 채널 세션 그대로 | **통과** | `POST /channels/<CH>/agents/<dev>/reset?threadRootId=<R1>` → 200. 스레드 전사 `total 7` → **`1`**(system 경계 하나, `sessionId` 유지 — ADR 0003 과 같다), 채널 전사 `7` 그대로. 서버 `agent_sessions` 는 스레드 행만 `session_started_at`·`lifecycle_revision` 이 채워졌고 채널 행은 빈 채 그대로. **반대 방향도 쟀다**: 채널 리셋 → 채널 전사 `7` → `1`, `<R0>` 스레드·fin 스레드 전사 `2` 그대로, `<R1>` 스레드 행의 `session_started_at` 그대로 |
| 7 | 옛 플러그인 → 스레드 멘션은 `PLUGIN_OUTDATED`, 채널 멘션은 정상 | **통과** | `36aaf479…` 로 붙은 채 `<R0>` 스레드 멘션 → +10ms `RUN_ERROR code=PLUGIN_OUTDATED "connected plugin does not support threads"` + 시스템 메시지 `thread=<R0>` 「@dev 가 스레드에서 답하지 못했습니다 — 플러그인을 새로 설치해야 합니다(연결 페이지)」 `items=[retry_run]`, 사건 `run_failed` `detail.code PLUGIN_OUTDATED`. 디스패치 전에 닫혀 가짜 CLI 호출이 없다. 같은 설치본으로 채널 멘션 → `FAKE_CLI_DONE`·`finalSource=plugin`. 새 플러그인 설치 뒤 그 카드의 「다시 실행」 → 새 런이 스레드 키로 돌아 답 `thread=<R0>` |
| 8 | 로그 위생 — 토큰 0 | **통과** | 비밀 다섯(Gateway 토큰·브리지 토큰·로컬 로그인 토큰·`BETTER_AUTH_SECRET`·wire 세션 토큰)을 스크래치 0600 파일로 두고 `grep -a -c -F -f`: 서버 로그·Gateway 로그·Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-26.log`·가짜 CLI 기록·DB 덤프(`messages`·`run_events`·`runs`·`ops_events`·`agent_sessions`)·모델 런 시간표 전부 **0**. 양성 대조: `data/live-smoke.env` 2, `.env` 2. 모델 런은 `message` 툴만 불렀다(Bash·파일 읽기 0) |

### 17.3 절차 — 3절·11절에 더한 것

11.1 준비(3절 (a)~(e), 하네스 채널에 `W add-agent $CH dev dev`·`W add-agent $CH fin fin`, `W patch-channel $CH '{"relayPolicy":{"maxRelayTurns":2,"allowPairs":"all"}}'`) 뒤 아래 도구로 잰다. `gcall` 은 3절 (c) 의 env 로 `openclaw --dev gateway call <메서드> --port 19001 --json --params <json>` 을 부르는 셸 함수다(토큰은 env 로만).

```bash
# 세션 전사 요약 — 항목 수·delivery-mirror 수만(본문은 보지 않는다)
hist() { gcall chat.history "{\"sessionKey\":\"$1\",\"limit\":500}" | jq -c '{total: (.messages|length),
  mirror: ([.messages[] | select((.model // "") == "delivery-mirror")] | length), sessionId}'; }
B="agent:dev:dodok:channel:${CH}"          # zsh — ${B}:thread:${R} 로 잇는다(11.3 「세션을 잴 때 걸리는 곳 셋」)
hist "$B"; hist "${B}:thread:${R1}"          # 기준 3 — 스레드 런의 툴 전송 전후로 한 번씩
# 기준 6 — 스레드 리셋과 판정
api POST "/api/v1/channels/$CH/agents/<dev agentId>/reset?threadRootId=$R1"
sqlite3 data/live-smoke.sqlite "select thread_root_id, session_started_at, lifecycle_revision from agent_sessions where channel_id='$CH'"
# 끝나면 만든 세션을 지운다 — Gateway 가 *.jsonl.deleted.<시각>.*.zst 로 보관한다
gcall sessions.list '{"limit":300}' | jq -r --arg ch "$CH" '.sessions[] | select(.key|contains($ch)) | .key' \
  | while read k; do gcall sessions.delete "{\"key\":\"$k\"}" >/dev/null; done
```

- **`wire-cli` 는 스레드를 모른다.** `send` 는 `threadRootId` 를 싣지 못하고, `interact` 는 채널 최상위 200개에서만 메시지를 찾아 스레드 안 카드를 못 누르고, `reset` 은 `threadRootId` 를 못 넘긴다. 이번에는 `scripts/wire-cli.ts` 를 `data/`(ignored)에 복사해 env `WIRE_THREAD=<루트 id>` 가 있으면 셋에 스레드를 싣고(`interact` 는 `/channels/:id/threads/:rootId/messages`), 메시지 요약에 `thread=`·`threadSummary=`, `runs` 에 `thread=` 를 찍게 고쳐 썼다 — 끝나고 지웠다.
- **리셋은 전사와 서버 행으로 판정한다.** Gateway `sessions.list` 의 `startedAt` 은 세션 시작이 아니라 **마지막 런의 시작**이고 리셋하면 `null` 이 된다 — 세션 시작 시각으로 읽지 않는다.
  `sessions.reset` 의 응답 `entry.sessionStartedAt`(ADR 0006 「채널 프롬프트·리셋」 절)은 서버가 `agent_sessions.session_started_at` 에 옮긴다.
- **옛 플러그인(기준 7)은 새 플러그인을 설치하기 전에 잰다.** dev 설치본이 Phase 4 이전 빌드면(`"threads"` 0) 그대로 쓰면 된다. 아니면 Phase 4 이전 커밋에서 `pack:plugin` 한 tgz 를 3절 (b) 대로 설치한다. 설치 전 설치본은 `~/.openclaw-dev/extensions/dodok` 을 `package/` 아래로 묶어 tgz 로 남겨 둘 수 있다.
- 기준 5 는 **서로 다른 세션**의 두 멘션을 같이 보낸다. 같은 세션에 겹쳐 보내면 가짜 CLI 의 둘째 턴이 실패한다(11.3 「세션을 잴 때 걸리는 곳 셋」 1).
- `W send` 두 개를 같이 띄우면 두 연결이 같은 채널을 구독해 **양쪽 시간표에 두 런이 다 찍힌다** — 판정은 `runs` 의 `startedAt`·`endedAt` 으로 한다.

### 17.4 모델 런 (상한 2, 실제 2)

채널 `p4t9a-model`(`@dev` 하나), 스레드 루트 `<RM>`. 가짜 CLI 없이 다시 띄운 Gateway, 가짜 CLI 기록 줄 수가 두 런 전후로 같다(실제 `claude` 가 돌았다).
런 B 는 브리프의 「같은 스레드 둘째 턴」 대신 **같은 채널 최상위의 같은 흐름**으로 돌렸다(조율자 판정) — 9.5 의 채널 최상위 억제 기준값을 아무도 재지 않아 스레드 결과(A)를 견줄 곳이 없었기 때문이다.

| # | 자리 | 입력 | 모델이 한 것 | 시각 | 결과 |
| --- | --- | --- | --- | --- | --- |
| A | `<RM>` 스레드 | `@dev message 툴로 이 스레드에 카드(components) 하나를 보내 주세요 — 제목 「스레드 카드 확인」, 버튼 둘(「예」 id yes · 「아니오」 id no). 파일이나 설정은 읽지 말고 카드만 보낸 뒤, 최종 답은 「카드 보냄」 한 줄로.` | `mcp__openclaw__message` 1회 — `{action:"send", target:"channel:<CM>", threadId:"<RM>", message:"스레드 카드 확인", components: section + actions[yes, no]}`. **`threadId` 를 스스로 넣었다**(헤더 `thread=` 값) | `RUN_STARTED` +274ms(새 세션) → 툴 11.7s → 카드 11.8s → 끝 14.1s | **통과** — 카드 `thread=<RM>`(채널 최상위 아님) `items=[yes,no]`, 최종 답 「카드 보냄」 도 `thread=<RM>` 로 **따로 올라왔다**. 채널 세션 전사 없음(`chat.history` 0), 스레드 전사 `total 4·mirror 1`(user·toolcall·mirror·text). `run_events` 에 `TOOL_CALL_START·ARGS·END·RESULT` 각 1 — `agent` `stream:"tool"` 이 스레드 키로 서버까지 왔다. CLI 보고 $0.65 |
| B | `p4t9a-model` 최상위 | A 와 같은 문장에서 「이 스레드에」→「이 채널에」, 제목 「채널 카드 확인」 | `mcp__openclaw__message` 1회 — `threadId: null`, 나머지 A 와 같은 꼴 | 툴 5.4s → 카드 5.5s → 끝 6.6s | 카드 채널 최상위, 최종 답 「카드 보냄」 도 **따로 올라왔다**. 채널 전사 `total 4·mirror 1` — 이 런의 것뿐(user·toolcall·mirror·text), 스레드 전사 `4·1` 그대로. CLI 보고 $0.30 |

- 두 런 모두 Gateway `[dodok] deliver {"kind":"final","textLength":5,…}` 가 불렸다 — 코어가 최종 답을 억제하지 않았다. **9.5 는 채널·스레드 모두 억제하지 않는다**(A·B 가 같다).
- usage: `RUN_FINISHED usage` 는 `inputTokens 2·outputTokens 1` 과 `2·8`, `costUsd 0` — `USAGE_TRUSTED=false`(ADR 0005)라 참고값도 못 된다. 비용은 CLI `result.total_cost_usd` 로 적었다(합 $0.95).

### 17.5 새로 찾은 것 (코드는 고치지 않았다)

- **사실 — 9.5 는 `message` 툴을 쓴 런의 최종 답을 억제하지 않는다.** 채널 최상위(B)와 스레드(A) 모두 툴 전송 뒤의 최종 답이 따로 한 메시지로 올라왔다. ADR 0002 가 9.4 에서 잰 `terminalReply.disposition: "silent"` 와 다르다.
  `docs/guides/agent-guide.md` 의 「같은 채널에 `message` 툴을 쓴 런은 최종 답이 채널에 안 올라갈 수 있다」 문장을 어떻게 할지는 조율자 판단이다(9.4 원격 Gateway 에서는 여전히 억제될 수 있다).
- **그 결과 생기는 흐름** — 툴 전송이 먼저 정본으로 와 런이 `done`(`finalSource=plugin`, `RUN_FINISHED.messageIds` = 카드 하나)으로 닫히고, 최종 답은 **23~24ms 뒤 같은 `runId` 의 둘째 메시지**로 저장된다(`orchestrator.ts` 의 `onCanonical` 이 끝난 런에도 저장·라우팅하고 `canonical_received` 는 무시된다). 가짜 CLI 런도 같은 꼴이다. `RUN_FINISHED.messageIds` 에 최종 답이 없다 — 웹·푸시가 그 목록에 기대는 곳이 있으면 판단 거리.
- **관찰 — hello 의 `capabilities` 를 밖에서 볼 길이 없다.** `"bridge plugin hello"` 로그 줄에도 `GET /api/v1/setup/status` 에도 없다. 연결된 플러그인이 `threads` 를 아는지는 번들 sha 대조나 스레드 멘션을 해 봐야 안다 — 로그 줄에 싣는 것이 가장 싸다(자리: `packages/openclaw-adapter/src/openclaw-adapter.ts` 의 `"bridge plugin hello"` 로그).
- 관찰 — wire `RUN_STARTED` 가 `providerRunId=undefined` 로 찍히는 런이 이번에도 있다(16.5 와 같은 꼴 — 스레드 런·채널 런 모두, DB 의 `providerRunId` 는 채워져 있다).
- ADR 0006 의 확인 못 한 것 가운데 이번에 잰 것(채널 리셋이 스레드에 영향 없음, 모델의 `threadId`, 스레드 런의 `stream:"tool"`)은 그 ADR 「확인 못 한 것」 절에 옮겼다. **같은 스레드 둘째 턴의 `--resume` 은 여전히 못 쟀다** — 모델 런 B 를 채널 기준값에 썼다.

### 17.6 사람이 볼 것

- 원격 Gateway 판에서 스레드 — 이번은 루프백 dev(9.5)만 쟀다. 원격이 9.4 면 최종 답 억제가 9.4 대로일 수 있다.
- 17.5 의 억제 결과를 에이전트 가이드에 어떻게 반영할지, `RUN_FINISHED.messageIds` 에 최종 답이 없는 것이 문제인지.
- 웹 화면에서 모델이 보낸 스레드 카드 — 이번은 wire·DB 로만 봤다(스레드 화면 자체는 `dev:fake` 브라우저 검증이 봤다).

### 17.7 정리·잔여물

- 서버(SIGINT, `run-state.json` `clean:true`)·tsx watch/pnpm 부모·Gateway 를 자기 pid 로 내렸다. **19001·19100·3100·5180·3000·8443·5173 LISTEN 0**(5173 은 시작 때도 0). 남은 `fakebin/claude`·`openclaw-gateway` 프로세스 0.
- 플러그인 설치본: 시작 `36aaf479…`(Phase 4 이전) → **끝 `b097e403…`(이 main 빌드, `status: "loaded"`)**. `bridgeUrl` `ws://127.0.0.1:19100/bridge` 그대로, `channels.dodok.channels` 는 시작·끝 모두 없음. dev 설정 파일은 크기 같고 수정 시각만 `plugins install` 이 바꿨다. dev 에이전트·승인 정책 무변경, 원격 `~/.openclaw` 무접촉.
- 이번에 만든 dev 세션 6개(하네스 채널 4 — dev 채널·dev 스레드 둘·fin 스레드, 모델 채널 2)를 `sessions.delete` 로 지웠다(Gateway 보관본 `*.jsonl.deleted.*.zst` 는 그대로). 모델 런 둘의 claude-cli 쪽 세션 파일은 건드리지 않았다.
- 스크래치의 `openclaw@2026.9.5` 설치본·가짜 CLI·그 기록·옛 설치본 tgz·비밀 파일, 워크트리 `data/`(wire-cli 사본 포함)·`packages/openclaw-plugin/dist` 를 지웠다. Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-26.log` 는 Gateway 기본 자리라 두었다(토큰 0).

## 18. 팀(Phase 4 ②) 실연 — 2026-09-27 결과 (p4m-t8a, 계획 태스크 8, 모델 런 0회)

실물 dev Gateway 위에서 사람이 여럿인 채널을 쟀다 — 에이전트가 받는 헤더 「참여자:」(쓴 사람만·사람 멘션으로 자동 참여·내보내면 빠짐), 승인 권한(member 는 결정 못 함·admin 은 결정하고 에이전트가 이어감), 승인 푸시 대상(owner·admin 만), 내보내기(소켓 끊김·재접속 거절).
메시지 경로는 11절 가짜 claude CLI 로만 두드렸다 — **모델 런 0회**(가짜 CLI `-p` 런 4회). 승인도 모델 없이 일으켰다(18.3 — 가짜 CLI 의 `can_use_tool` 제어 요청).

**판정: 합격 기준 6/6 통과. dodok 팀 기능 결함 0.** 새로 안 것은 18.4 — 그중 「실물 Gateway 에서는 승인을 누른 사람(`decided_by`)이 비어 남는다」가 팀 맥락의 판단 거리다.
로그는 워크트리 `data/`(ignored)에 두었다가 정리 때 지웠다: `dev-gateway.log`(Gateway·플러그인)·`p4m-t8a-server.log`(서버·어댑터).

### 18.1 환경 실물

| 항목 | 값 |
| --- | --- |
| 워크트리 | main `c997623`(코드 변경 없음) |
| OpenClaw CLI·Gateway | 스크래치 설치 `openclaw@2026.9.5` → `OpenClaw 2026.9.5 (ec9c1a1)`, mise Node 24.21.0(2절 표·3절 머리). 설치 전후 `~/.openclaw`·`~/.openclaw-dev` 목록 `diff` 동일 |
| 버전 로그 | `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z"`, scopes 에 `operator.approvals`·`operator.admin` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"` |
| 플러그인 설치본 | 시작·끝 `b097e4039172228acb78ae7482b066ed1993dba7ea09e8a81b8e4ff0be162c41`(`status: "loaded"`) — **다시 설치하지 않았다.** 이 main 의 `pack:plugin` 빌드본은 `5d69522b…` 로 다르지만, 번들 `diff` 61줄이 전부 플러그인이 부르지 않는 shared 선언(`members` 스키마·`User.leftHandle`)이다 — 플러그인 소스(`packages/openclaw-plugin`)는 스레드 실연 뒤 바뀌지 않았다. 헤더를 만드는 `formatInboundContext`(`packages/openclaw-plugin/src/context.ts`)가 같다 |
| 서버 | `:19100`(dev 계정 `bridgeUrl` 이 `ws://127.0.0.1:19100/bridge` — 플러그인 설정을 바꾸지 않으려고), `APP_ORIGIN=http://localhost:5190`(웹은 띄우지 않았다 — 초대 링크 `url` 의 오리진 확인용), 새 DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug`, `NODE_EXTRA_CA_CERTS=<스크래치 푸시 받이 인증서>`(18.3). `.env` 의 `BRIDGE_TOKEN` 을 라벨 `env` 로 이어받아 플러그인이 그대로 붙었다 |
| 가짜 claude CLI | 11.4 에 둘을 보탰다 — `user` 레코드에서 **헤더 줄과 `참여자:` 줄만** 적음(핸들 목록이라 비밀 아님, 본문은 안 적음), 스크래치에 `fake-approve.json` 이 있으면 `can_use_tool` 제어 요청을 내고 결정을 최종 답 `FAKE_CLI_DONE approval=<behavior>` 에 실음(18.3). Gateway 는 `PATH="<스크래치>/fakebin:$OCBIN:$PATH"` 로 띄웠다 |
| 사람 | `@owner`(로컬 토큰) · `@adm1`(admin 초대) · `@mem1`(member 초대) · `@mem3`(member 초대, **가입만**). 셋 다 `POST /api/v1/invites` → `/invites/lookup` → `/invites/accept`, 그 뒤 이메일 로그인 `POST /auth/local {email,password}`. 비밀번호는 무작위 24자, 스크래치 0600 파일에만 |
| 채널 | `t8a-harness-<숫자>` — `@dev` 하나, 가짜 CLI 전용 |
| 내장 cron | 실연 중 `skill-collection-review` 실행 0(Gateway 로그) |

곁들여 잰 가입 경로(모두 기대대로): 초대 응답 `url` = `APP_ORIGIN` + `/join/<원문>` · 조회 200 `{workspaceName, kind:"invite", role}` · **같은 초대 원문으로 두 번째 가입 → 404** · 재설정 링크 `url` = `APP_ORIGIN` + `/reset/<원문>` → 수락 200 뒤 **옛 세션 `/auth/me` 401 · 옛 비밀번호 로그인 401 · 새 비밀번호 로그인 200** · `/auth/me` 의 `role` 이 초대 역할과 같다.

### 18.2 합격 기준

`<CH>`=하네스 채널. wire 관찰은 사람 넷이 **각자 소켓을 열고 `<CH>` 를 구독한 채**(18.3 `watch`) 쟀다 — 구독(읽기)만으로는 참여가 되지 않는다는 것도 함께 본다.

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | owner 가 초대 → member 가입 → 둘이 같은 채널에 쓰고 `@dev` → 헤더 「참여자:」에 둘 다, 쓰지 않은 사람은 없음 | **통과** | owner 일반 메시지 → mem1 일반 메시지(그 순간 `channel_members` 에 mem1 행, `joinedAt` = 보낸 시각) → owner `@dev 참여자 프로브 1` → 가짜 CLI 가 받은 줄 `참여자: @owner(사람), @mem1(사람), @dev(에이전트, 나)`. **adm1·mem3 없음** — 둘 다 가입·로그인하고 `<CH>` 를 구독해 이벤트를 받고 있었지만 쓰지 않았다 |
| 2 | 사람 멘션으로 셋째를 부르면 그 뒤 헤더에 든다 | **통과** | owner `@mem3 이것 좀 봐 주세요`(런 없음 — 사람 멘션) → mem3 참여 행 생김, mem3 에게 멘션 푸시(`urgency: normal`) 1건 → owner `@dev 참여자 프로브 2` → `참여자: @owner(사람), @mem1(사람), @mem3(사람), @dev(에이전트, 나)` |
| 3 | 승인 — member 의 결정은 `FORBIDDEN`, admin 은 결정되고 에이전트가 이어감, 승인 푸시는 owner·admin 에게만 | **통과** | 8.1 로 `exec.ask always` → mem1 `@dev 승인 프로브`(member 도 멘션은 된다) → 가짜 CLI `can_use_tool Write`(+0.68s) → 네 소켓 모두 `approval.requested` `status: pending` `toolName: Write`(+36ms). **mem1 `approval.resolve allow-once` → ack `{ok:false, error:{code:"FORBIDDEN", message:"승인·거절은 admin 이상만 할 수 있다"}}`, mem3 `deny` → 같은 `FORBIDDEN`** — 승인은 `pending` 그대로, 가짜 CLI 는 계속 기다림. REST: 승인 결정 REST 경로는 없다(wire `approval.resolve` 하나 — 팀 스펙 「역할과 권한」 절 표). 같은 member 의 admin 전용 REST 는 `POST /channels/<CH>/agents/<dev>/reset` → **403 `FORBIDDEN`**, `PATCH /channels/<CH> {"prompt":…}` → **403**. **adm1 `allow-once` → ack `{ok:true}`** → Gateway `plugin.approval.waitDecision` 18572ms 로 풀림 → 가짜 CLI `control_response behavior: "allow"`(+14ms) → 최종 답 `FAKE_CLI_DONE approval=allow` `message.created`(+318ms), 런 `done`, 네 소켓에 `approval.resolved status: allowed decision: allow-once`. 서버 `"approval resolve requested"` 의 `userId` = adm1. **푸시**: 푸시 받이에 `/push/owner`·`/push/adm1` 각 1건(`urgency: high`, 같은 `topic`) · 서버 `"push sent"` 2줄의 `subscriptionId` 가 owner·adm1 의 구독 행 · **mem1·mem3 0건**(둘 다 구독이 있다 — mem3 은 기준 2 에서 멘션 푸시를 받았다) |
| 4 | 내보내기 — member 의 소켓이 끊기고 이후 헤더에서 빠진다 | **통과** | owner `DELETE /api/v1/members/<mem1>` → 204. mem1 소켓 `disconnect reason: "io server disconnect"`(204 와 같은 ms) → 1초 뒤 재접속 `connect_error UNAUTHORIZED "invalid session"` · 옛 세션 REST(`/auth/me`·`/channels/<CH>/messages`) 401 · wire 전송 거절 · 옛 비밀번호 이메일 로그인 401 「이메일 또는 비밀번호가 맞지 않는다」. DB: `users` 행 `handle=left-<id 뒤 27자>`·`left_handle=mem1`·`email NULL`, mem1 의 푸시 구독·`channel_members` 행 없음, mem1 이 쓴 메시지 2건은 남음. owner `@dev 참여자 프로브 3` → `참여자: @owner(사람), @mem3(사람), @dev(에이전트, 나)` |
| 5 | 로그 위생 — 초대·재설정 토큰 원문·비밀번호·Gateway 토큰 0 | **통과** | 비밀 여섯 갈래를 스크래치 0600 파일로 두고 `grep -a -c -F -f` — 초대·재설정 원문 4(`dit_` 3·`drt_` 1), 비밀번호 4, 세션 토큰 8, Gateway 토큰, 브리지 토큰, 로컬 토큰·`BETTER_AUTH_SECRET`. 서버 로그 113줄·Gateway 로그 72줄·Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-27.log` 74줄·가짜 CLI 기록·wire 관찰 기록 312줄·푸시 받이 기록·DB 덤프(`messages`·`run_events`·`runs`·`ops_events`·`approvals`·`invites`·`users`·`memberships`·`push_subscriptions`·`channel_members`) 전부 **0**. 접두 문자열 `dit_`·`drt_` 도 서버·Gateway 로그에 0. 양성 대조: 하네스 상태 파일(비밀번호 3·세션 4), `.env`(Gateway 1·브리지 1), `data/live-smoke.env`(2) |
| 6 | 모델 런 0 | **통과** | 가짜 CLI `-p` 4회 = Gateway `cli exec: provider=claude-cli` 4줄 = 서버 런 4건(`done`·`finalSource=plugin`·`costUsd 0`). `-p` 없는 6회는 진짜 `claude` 로 넘긴 버전·인증 확인이다 |

### 18.3 절차 — 3절·11절에 더한 것

11.1 준비(3절 (a)~(e) — 이번은 (b) 재설치를 건너뜀) 뒤, 사람·wire 는 `wire-cli` 가 못 하므로(로컬 토큰 owner 하나만 안다) **`data/`(ignored)에 하네스 스크립트를 두고 `pnpm -s exec tsx data/<파일>.ts <명령>` 으로 돌렸다**(끝나고 지웠다). 명령과 하는 일:

| 명령 | 하는 일 |
| --- | --- |
| `setup` | owner 로그인(`LOCAL_AUTH_TOKEN`) → 초대 3건(`admin`·`member`·`member`)·조회·수락·같은 원문 재수락 → mem3 재설정 링크 발급·수락·옛/새 로그인 → 멤버 이메일 로그인 → 채널·`@dev` → 사람 넷 푸시 구독. 원문·비밀번호·세션 토큰은 **출력하지 않고** 스크래치 0600 파일에 한 줄씩(기준 5 의 `-f` 목록), 세션은 `data/` 상태 파일(0600)에 |
| `watch <사람> <ms>` | 그 사람 세션으로 소켓(`auth: {token, protocol: 1}`)을 열고 `channel.subscribe` → 이벤트를 `{ev, approval{id,status,decision,toolName} \| message{id,author,runId,본문 앞 80자}}` 로 기록, `disconnect` 면 이유를 적고 1초 뒤 재접속을 한 번 시도해 결과를 적는다. 사람마다 백그라운드로 하나씩 |
| `send <사람> <본문>` · `resolve <사람> <approvalId> <결정>` · `api <사람> <METHOD> <경로> [json]` | 그 사람으로 `message.send` · `approval.resolve`(ack 원문을 찍는다) · REST |

**모델 없이 승인을 일으키기.** Gateway 의 claude-cli 백엔드는 CLI 가 stdout 으로 낸 `control_request { subtype: "can_use_tool" }` 을 네이티브 툴 권한 요청으로 받아(9.5 `dist/extensions/anthropic/cli.runtime.js` 의 `handleRequest`) exec 정책을 판정하고, `ask` 가 `always` 면 승인을 만든다. 11.4 스크립트의 `startTurn` 에서 `system/init` 뒤에 아래를 넣고, stdin 처리에 `control_response` 를 기다리는 자리를 더한다. 정책은 8.1 로 켜고 **8.3 으로 되돌린다**.

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

- `Write`·`Read`·`Edit` 에 `file_path` 가 있으면 코어가 경로 규칙을 먼저 본다 — 워크스페이스(`~/.openclaw-dev/workspace`) 안 경로를 준다. 이번 승인은 Gateway 에서 **플러그인 승인**(`plugin.approval.waitDecision`)으로 떴다.
- 가짜 CLI 의 대기 상한은 승인 TTL(실물 120초)보다 길게 둔다 — 이번은 300초.
- 모델 런이 아니라 Gateway 가 기록하는 승인 이벤트·`approval.resolve` RPC·런 재개가 실물 그대로 돈다. 17.5 에서 「못 잰 것」이던 승인 이벤트를 이 방법으로 모델 비용 0 으로 잴 수 있다.

**로컬 푸시 받이.** 구독 `endpoint` 는 `https://` 만 받는다(shared `PushSubscriptionInput`). 스크래치에 자체 서명 인증서(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1`)를 만들고, `https.createServer` 로 `127.0.0.1:19443` 에서 POST 의 **경로·바이트 수·`Urgency`·`Topic` 헤더만** 적고 201 을 돌려준다(본문은 암호문이라 안 적는다). 서버는 `NODE_EXTRA_CA_CERTS=<그 인증서>` 로 띄운다(`data/live-smoke.env` 에 한 줄) — TLS 검사를 끄지 않는다.
구독은 사람마다 `POST /api/v1/push/subscriptions {endpoint: "https://127.0.0.1:19443/push/<핸들>", keys: {p256dh: <P-256 공개키 base64url>, auth: <16바이트 base64url>}}`(키는 `crypto.createECDH("prime256v1")`). 받는 사람은 받이의 경로로, 서버 쪽은 `"push sent"` 의 `subscriptionId` 를 `push_subscriptions` 와 이어 본다(그 줄에 `userId` 가 없다 — 18.4).
관찰 소켓은 `presence.update` 를 보내지 않으므로 「보고 있으면 거름」(`push skipped — watching`)은 걸리지 않는다 — 누가 대상인지만 본다.

- 헤더는 가짜 CLI 기록의 `participants` 줄로 판정한다. 서버의 `GET /channels/<CH>/members` 는 사람을 id 로만 준다.
- 끝나면 만든 세션을 17.3 의 `sessions.list`·`sessions.delete` 로 지운다(이번은 `agent:dev:dodok:channel:<CH>` 하나).

### 18.4 새로 찾은 것 (코드는 고치지 않았다)

- **실물 Gateway 에서는 승인을 누른 사람이 남지 않는다(`approvals.decided_by` NULL).** adm1 의 `approval.resolve` 로 서버가 Gateway RPC 를 보내고 응답을 받기까지 11ms(`"approval resolve sent to gateway"` → `"approval already resolved — not relayed"`) 사이에 **Gateway 의 해결 이벤트가 먼저** 와서, `apps/server/src/modules/approvals/service.ts` 의 `resolve` 가 「먼저 온 쪽이 이긴다」 갈래로 빠졌다 — 그 갈래는 이벤트 쪽 행(다른 디바이스가 해결한 것으로 보는 `decidedBy` 없음)을 그대로 둔다. 누가 눌렀는지는 서버 로그 `"approval resolve requested"` 의 `userId` 에만 있다. 웹은 지금 `decidedBy` 를 그리지 않아 화면 결함은 아니지만, 사람이 여럿이면 「누가 허용했나」가 감사 거리다 — 조율자 판단.
- 관찰 — `approval.requested` 가 소켓마다 **같은 id 로 두 번**(1~2ms 차) 온다. 서버가 두 프레임을 병합하며 둘 다 wire 로 흘리는 기존 동작이다(푸시는 `seenApprovals` 로 한 번만 — 이번에도 사람마다 1건).
- 관찰 — `"push sent"` debug 줄에는 `userId` 가 없고 `subscriptionId` 만 있다(`"push send failed"`·`"push skipped — watching"` 에는 있다). 「누구에게 갔나」를 로그만으로 보려면 같은 줄에 `userId`·`kind` 를 싣는 것이 가장 싸다(자리: `apps/server/src/modules/push/service.ts` 의 `sendOne`).
- 관찰 — 플러그인 소스가 그대로여도 shared 가 바뀌면 번들 sha 가 달라진다(이번 `b097e403…` 대 `5d69522b…`, 차이는 플러그인이 안 쓰는 shared 선언뿐). 연결 페이지의 「같은 빌드」 판정(`bundleSha256`)은 이런 main 에서 「다른 빌드」로 보인다 — 보수적 판정이라 틀린 것은 아니다.
- 관찰 — 8.3 되돌리기가 `agents.entries.dev.tools = { exec: {} }` 빈 껍데기를 남겨 dev 설정 파일이 51바이트 커졌다. `tools` 를 지워 시작 크기(2155)로 되돌렸고, 8.3 에 그 줄을 보탰다.
- 주석 어긋남 — `packages/shared/src/domain/index.ts` 의 `leftHandle` 주석은 「`left-<id 뒤 12자>`」라 하는데 실제 핸들은 스펙대로 `left-<id 뒤 27자>` 다(DB 에서 확인).

### 18.5 사람이 볼 것

- 원격 Gateway 판(9.4 일 수 있음)에서 승인 — `decided_by` 가 비는지(이벤트·RPC 응답 순서)는 판마다 다를 수 있다.
- 실제 폰에서 승인 푸시가 owner·admin 에게만 오는지 — 이번은 로컬 받이로 대상만 쟀다(실제 FCM·APNs 전달은 `docs/guides/deploy.md` 체크리스트).
- 18.4 첫 줄(`decided_by`)을 고칠지.

### 18.6 정리·잔여물

- 서버(SIGINT, `run-state.json` `clean:true`)·tsx watch/pnpm 부모·Gateway·푸시 받이·관찰 소켓을 자기 pid 로 내렸다. **19001·19100·19443·3110·5190 LISTEN 0**, 5173 은 시작 때부터 떠 있던 다른 프로세스 그대로. 남은 `fakebin/claude`·`openclaw-gateway` 프로세스 0.
- 플러그인 설치본 `b097e403…` 그대로(`status: "loaded"`), `bridgeUrl` `ws://127.0.0.1:19100/bridge` 그대로, `channels.dodok.channels` 시작·끝 없음, `agents.entries.dev.tools` 시작·끝 없음 — dev 설정 파일 크기 2155 로 시작과 같다(수정 시각만 `config set/unset` 이 바꿨다). dev 에이전트 무변경, 원격 `~/.openclaw` 무접촉(목록 `diff` 는 홈 `..` 수정 시각만).
- 만든 dev 세션 1개(`agent:dev:dodok:channel:<CH>`)를 `sessions.delete` 로 지웠다. 워크스페이스에 파일을 만들지 않았다(가짜 `Write` 는 승인만 청했다).
- 스크래치의 `openclaw@2026.9.5` 설치본·가짜 CLI·그 기록·푸시 받이·인증서·비밀 파일, 워크트리 `data/`(하네스 스크립트·상태·DB·로그)·`packages/openclaw-plugin/dist` 를 지웠다. Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-27.log` 는 Gateway 기본 자리라 두었다(비밀 0).

## 19. Claude 러너 런 0회 하네스 — 번들 CLI + 가짜 Messages API (p4c-t9a, Claude 러너 계획 태스크 9, 모델 런 0회)

Claude 러너 어댑터는 번들 CLI 에 `ANTHROPIC_BASE_URL`(로컬 가짜 Messages API)·가짜 API 키·스크래치 `CLAUDE_CONFIG_DIR` 을 주어 모델 없이 실제 요청 본문과 권한·도구·interrupt 흐름을 두드린다(ADR 0007 「다시 재는 법」).
**실제 서버**(`dev:fake` — 가짜는 Gateway·플러그인뿐이고 러너 어댑터·`/runner`·첨부 HTTP·승인·오케스트레이터는 운영 코드 그대로) + **실제 러너**(서버가 내려준 tgz 를 `npm install -g` 한 설치본) + **실제 번들 CLI**(SDK 가 찾는 그 바이너리)를 끝까지 돌린다. 가짜는 모델 자리의 `packages/claude-runner/scripts/fake-messages-api.ts` 하나다.
러너·SDK·CLI 판본을 올렸을 때, 러너의 `buildQueryOptions`·권한·도구·중지를 고쳤을 때, 그리고 **모델 런 실연(「Claude 러너(Phase 4 ③) 실연」 절) 전에** 한 번 돌린다.

**판정: 합격 기준 12/12 통과. 제품 결함 0.** 새로 안 것은 「새로 찾은 것」 — 그중 「러너를 `SIGKILL` 로 죽이면 CLI 가 고아로 남아 그 턴을 끝까지 돈다」가 비용·이력 판단 거리다.

### 19.1 구성

| 항목 | 값 |
| --- | --- |
| 서버 | `PORT=3121 APP_ORIGIN=http://localhost:5199 LOG_LEVEL=debug pnpm -F @dodok/server dev:fake`(웹은 띄우지 않는다), 기동 전에 `pnpm -F @dodok/claude-runner pack:runner` — 서버는 부팅 때 `packages/claude-runner/dist` 의 tgz 를 잰다. dev:fake 의 가짜 러너는 `POST /__devfake/runner {"connected":false}` 로 내린다 |
| 러너 | owner 로 `POST /api/v1/setup/runner-tokens` → 원문을 스크래치 `home/.dodok-runner/token`(0600)에만 → `GET /api/v1/setup/runner.tgz` → `npm install -g --prefix <스크래치>/runner <받은 tgz>` → 아래 감싸개 → `env -i PATH=<스크래치>/runner/bin:<node bin>:/usr/bin:/bin HOME=<스크래치>/home LANG=en_US.UTF-8 TMPDIR=<스크래치>/tmp SHELL=/bin/bash USER=$USER dodok-runner --config <스크래치>/runner-config.json` |
| 러너 설정 | `serverUrl` `http://127.0.0.1:3121`(발급 응답의 `runnerConfig.serverUrl` 은 `APP_ORIGIN` 파생이라 dev 에서는 웹 오리진이다 — 「새로 찾은 것」), `tokenFile` `~/.dodok-runner/token`(스크래치 `HOME` 기준), `claudeConfigDir` 스크래치 `cfg/`, 에이전트 `hx`(작업 디렉터리 스크래치 `ws/` — 커밋 하나 있는 git 저장소, 라벨 `hx-ws`, 모델 `sonnet`) |
| 가짜 API | `node packages/claude-runner/scripts/fake-messages-api.ts --port 3197 --out <스크래치>/api` — 대본 키워드는 그 파일 머리 주석의 표. 요청마다 `requests.jsonl` 한 줄과 본문 `NNN.json` |
| 작업 파일 | 작업 디렉터리 안 `hx-out.txt`, 밖 `<스크래치>/hx-outside.txt`, 사람 이미지 8×8 PNG |

**번들 CLI 감싸개.** 러너의 env 허용 목록(`packages/claude-runner/src/run.ts` 의 `ENV_ALLOWLIST`)은 `ANTHROPIC_*` 를 CLI 로 넘기지 않는다(ADR 0007 「함정」 — 러너 env 가 CLI 로 새지 않게). 그래서 가짜 API 주소는 러너가 아니라 **스크래치 설치본의 번들 CLI 자리**에 얹는다. SDK 는 `@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude` 를 찾아 그대로 spawn 하므로, 진짜 바이너리를 `claude.real` 로 옮기고 그 자리에 셸 조각을 둔다 — **이 설치본의 CLI 는 로컬 주소 없이는 뜨지 않는다.**

```sh
B=<스크래치>/runner/lib/node_modules/@dodok/claude-runner/node_modules/@anthropic-ai/claude-agent-sdk-$(node -p 'process.platform+"-"+process.arch')
mv "$B/claude" "$B/claude.real"
cat > "$B/claude" <<SH
#!/bin/sh
echo "\$(date -u +%FT%TZ) pid=\$\$ argv=\$*" >> <스크래치>/logs/cli-invocations.log
exec /usr/bin/env ANTHROPIC_BASE_URL=http://127.0.0.1:3197 ANTHROPIC_API_KEY=sk-ant-fake-harness-0000 \\
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1 \\
  ENABLE_TOOL_SEARCH=true "$B/claude.real" "\$@"
SH
chmod +x "$B/claude"
```

- `ENABLE_TOOL_SEARCH=true` — 가짜 키 모드는 도구 검색이 꺼져 있어 지연 로드를 볼 수 없다(ADR 0007 「함정」의 SDK MCP 도구 지연 로드). 켜야 `alwaysLoad` 를 잰다.
- 러너 전용 로그인(`~/.dodok-runner/claude`)은 쓰지 않는다 — `HOME` 도 `CLAUDE_CONFIG_DIR` 도 스크래치다. 가짜 키라 CLI 의 `apiKeySource` 는 `ANTHROPIC_API_KEY` 이고 런 비용은 `costKind: "api"` 로 온다.

**드라이버.** 사람 쪽(REST·wire)은 `wire-cli` 가 못 하는 것(승인 결정·중지·버튼·러너 토큰 첨부 GET)이 있어 「팀(Phase 4 ②) 실연」 절의 「절차」 처럼 워크트리 `data/`(ignored)에 드라이버를 두고 `pnpm -s exec tsx data/<파일>.mts <명령>` 으로 돌렸다(끝나고 지웠다). `socket.io-client` 로 `auth: {token: <세션>, protocol: 1}`, 이벤트는 스크래치 `wire.jsonl` 에 받은 시각과 함께.

| 명령 | 하는 일 |
| --- | --- |
| `setup` | owner 로그인(`POST /api/v1/auth/local`) → 가짜 러너 끄기 → 러너 토큰 발급(원문은 토큰 파일에만) → tgz 받기 → 채널 둘(`hx-lab`·`hx-other`) |
| `register` | `GET /api/v1/agents/discover?provider=claude` → `POST /api/v1/agents {provider:"claude", providerAgentId:"hx", …}` → `hx-lab` 에 넣기 |
| `send <본문> [--attach <id>] [--approve allow-once\|allow-always\|deny] [--abort-after <n>] [--kill-pid <pid> --kill-after <n> --kill-signal <신호>]` | 구독 → `message.send` → 런이 끝날 때까지 기록. `approval.requested` 가 오면 0.5초 뒤 `approval.resolve`, `TEXT_MESSAGE_CONTENT` 가 n개 오면 `run.abort` 또는 러너 PID 에 신호 |
| `interact <messageId> <componentId> <itemId>` | `component.interact {messageId, componentId, itemId, values: {}}`(「다시 실행」) 뒤 같은 기록 |
| `upload <채널> <파일>` · `status-code <첨부 id>` | 사람 첨부 올리기 · **러너 토큰으로** `GET /runner/attachments/<id>` 의 상태·바이트 수(토큰은 파일에서 읽고 찍지 않는다) |

요청 본문은 작은 스크립트로 요약했다 — `system[]` 블록 길이, 틀 머리 `# dodok channel settings` 와 규칙 표식의 개수(시스템·본문 전체), `messages[]` 블록마다 역할·종류와 표지(`UserPromptSubmit hook additional context`·`[dodok context] 이 턴의 사실`·`[dodok context] channel=`·`deferred`·`mcp__dodok__post`), `tools[]` 이름과 `defer_loading`.

### 19.2 합격 기준

`+ms` 는 드라이버가 보낸 때부터. 런은 모두 `hx-lab` 의 `@hx`.

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 요청의 시스템 프롬프트에 틀 입힌 채널 규칙이 **한 벌만** | **통과** | 채널 프롬프트 `HX-RULE-ALPHA: … <b>태그</b> …` → 첫 런(`--session-id=`) 요청: `system[]` 셋(과금 머리 73자·「You are Claude Code … Claude Agent SDK.」 94자·본문 15,275자), 틀 머리는 **본문 블록 14,277자 자리에 1개**(본문 전체에서도 1), 뒤로 `<channel-rules>`·`<relay-rules>` 가 블록 끝까지. 표식 `HX-RULE-ALPHA` 본문 전체 1, 규칙 안 `<b>` 는 `&lt;b>` 로 1 |
| 2 | 규칙을 바꾼 뒤 런에 새 규칙만 | **통과** | `PATCH /channels/<CH> {"prompt":"HX-RULE-BRAVO: …"}` → 둘째 런은 `--resume=<같은 id>`, 요청 `messages` 5개(앞 턴 3 + 새 턴 2)에 **BRAVO 1 · ALPHA 0**(시스템·본문 전체 둘 다), 틀 머리 1 |
| 3 | `UserPromptSubmit` 훅 문맥 자리 | **통과** | 프롬프트(`messages[0]` 사용자 셋째 블록 `[dodok context] channel=… --- @hx HX-TEXT …`) **뒤의 `role: "system"` 메시지** 안 `<system-reminder>UserPromptSubmit hook additional context: [dodok context] 이 턴의 사실 — …\n참여자: @owner(사람), @hx(에이전트, 나)\n자리: 채널</system-reminder>`. `resume` 한 둘째 런 요청에는 이 블록이 **둘**(앞 턴 것이 이력에 남음 — ADR 0007 「질문별」 채널 프롬프트 표 (나)와 같다) |
| 4 | `mcp__dodok__post` 가 지연 목록에 없음(`alwaysLoad`) | **통과** | `tools[]` 14개 중 `mcp__dodok__post` 가 `input_schema`(`text`·`components`·`files`)째 있고 `defer_loading` 없음. 같은 요청의 「The following deferred tools are now available via ToolSearch」 블록은 12개(`CronCreate` … `WebSearch`)이고 `mcp__dodok__post` 는 없다 |
| 5 | 쓰기 Bash `tool_use` → `canUseTool` → 승인 카드 → 허용 → 도구 결과 | **통과** | `HX-BASH`(`touch hx-note.txt`) — `TOOL_CALL_START Bash` +479 → `approval.requested` +529(`kind: tool`·`toolName: Bash`·`detail: "touch hx-note.txt"`·결정 셋) → `allow-once` +1032 → `approval.resolved allowed` +1034 → `TOOL_CALL_RESULT ok:true "(Bash completed with no output)"` `durationMs` 592 +1069 → 다음 요청의 `tool_result is_error:false` → 최종 답 `HX-BASH-DONE is_error=false …` +1148, 런 `done`, 작업 디렉터리에 `hx-note.txt` 생김. **거절**: `tool_result is_error:true` 「사람이 거절했습니다」 → 답에 그대로, 파일 없음. **항상 허용**: 허용되고 작업 디렉터리에 `.claude/` 가 생기지 않았다(규칙이 `session` 으로만) |
| 6 | 중지 → 메시지 없는 중지 | **통과** | `HX-SLOW` 델타 3개 뒤 `run.abort` +1783 → `RUN_ABORTED {by:"user"}`·런 `aborted` +1785, 러너 「런 끝」 +10ms. 그 런의 에이전트 메시지 0, 가짜 API 에 응답 중 끊김 1건, 남은 CLI 프로세스 0 |
| 7 | 러너를 죽이면 run_error 카드 | **통과** | `HX-SLOW` 델타 3개 뒤 러너 PID 에 `SIGKILL` +1783 → `RUN_ERROR {code:"ADAPTER_UNAVAILABLE", message:"runner disconnected"}` +1787 → 채널 「@hx 실행이 실패했습니다: ADAPTER_UNAVAILABLE」 + 「다시 실행」(`retry_run`) +1790. 러너를 다시 띄우자 6ms 만에 붙고, 「다시 실행」 → 새 런(`parentRunId` = 죽은 런)이 **같은 세션 `--resume`** 으로 끝까지 `done`. 고아 CLI 는 「새로 찾은 것」 |
| 8 | 서버 재시작 → 러너 재접속(판정 R4) | **통과** | 서버 SIGINT → 러너 「서버와 끊겼습니다(transport close) — 도는 런을 멈췄습니다」 → 1초·2초 백오프 → **3.0초 뒤 「연결됨」**, 서버 로그 `runner hello`(같은 토큰 id). 러너는 끝나지 않았다(종료 2 아님). `dev:fake --keep` 로 다시 띄운 뒤 멘션 → `--resume` 으로 답 |
| 9 | 러너가 남의 첨부 GET 404(판정 R5) | **통과** | 러너 토큰 `GET /runner/attachments/<id>`: 사람이 `hx-lab` 에 올린 이미지 — 런 전 **404**, 그 이미지를 단 멘션의 런 안에서 러너가 받은 것 **200**(요청에 `image/png` 블록, 바이트가 원본과 같다), 런 뒤 **404** · `hx-other`(러너 에이전트 없는 채널) 이미지 **404** · 러너가 `post` 로 올린 `hx-out.txt` **200** · 없는 id **404**(본문 53바이트 — 넷 모두 같은 응답) |
| 10 | 파일 보내기 — 안의 파일은 채널 카드, 밖은 거절 | **통과** | `HX-POST-IN`(`files: ["hx-out.txt"]`) → 승인 없이 `message.created` 「하네스가 파일을 보냅니다.」 + 첨부 `{kind:"file", name:"hx-out.txt", size:30}`(최종 답보다 먼저) → 도구 결과 「보냈습니다(메시지 <id>)」. owner 가 받은 파일이 원본과 같다(`cmp`). `HX-POST-OUT`(`files: ["../hx-outside.txt"]`) → 도구 결과 `is_error` 「파일을 보내지 않았습니다 — … - <작업 디렉터리 밖>: 작업 디렉터리 밖을 가리킵니다」, 첨부 메시지 0, 런은 계속돼 `done` |
| 11 | 로그 위생 — 러너 토큰·호스트 경로 0 | **통과** | 러너 토큰 파일로 `grep -a -c -F -f`, 스크래치 경로로도 같게: wire 기록 1,167줄·러너 로그 57줄·서버 로그 두 벌(167줄)·DB 덤프(`messages`·`run_events`·`runs`·`approvals`·`attachments`·`ops_events` 870줄) 전부 **토큰 0 · 경로 0**, 서버 로그 `drn_` 0. 양성 대조(토큰 파일 자신) 1 |
| 12 | 모델 런 0 | **통과** | CLI 기동 14회 = 런 14개 = 감싸개 기록 14줄(모두 `ANTHROPIC_BASE_URL=http://127.0.0.1:3197`). 가짜 API 가 받은 것은 `POST /v1/messages` 64건과 기동마다 `HEAD /api/hello` 1건뿐, 그 밖의 경로 0. 런마다 CLI 한 번 — 「이미 있는 세션」 재시도(`session-in-use`)는 한 번도 나지 않았다 |

### 19.3 절차 메모

- 가짜 API 의 대본은 **마지막 비시스템 메시지**의 도구 결과로 턴을 끝낸다. CLI 는 도구 결과 뒤에도 `role: "system"` 메시지(`<system-reminder>`)를 붙이므로 맨 끝 메시지만 보면 도구 결과를 못 보고 같은 도구를 다시 내 — 승인이 끝없이 되풀이된다(드라이버의 자동 허용과 만나 45번 돌았다). 대본을 고칠 때 이 자리를 지킨다.
- 「새 대화」(`POST /channels/<CH>/agents/<agentId>/reset`)는 서버가 새 UUID 를 정할 뿐이라, 앞 세션 전사는 러너의 `CLAUDE_CONFIG_DIR/projects/<cwd 경로>/` 에 남는다.
- 드라이버의 `send` 는 런이 모두 `done`·`error`·`aborted` 가 된 뒤 1.5초 더 받고 닫는다 — 중지·죽이기 뒤에 늦게 오는 메시지를 보려고.

### 19.4 새로 찾은 것 (코드는 고치지 않았다)

- **러너를 `SIGKILL` 로 죽이면 CLI 가 고아로 남아 그 턴을 끝까지 돈다.** 부모가 `1` 로 바뀐 `claude.real` 이 가짜 API 스트림을 끝까지(약 20초) 받고 스스로 끝났다 — 응답 중 끊김이 없었다. 모델이면 **아무도 못 볼 답에 비용이 든다.** 그리고 그 답이 세션 전사에 남아, 「다시 실행」의 `resume` 요청에 **채널에 없던 앞 답(assistant 메시지)이 이력으로 실린다**(`messages` 34 → 37). 노트북 덮개를 닫는 것(러너 프로세스가 사는 끊김)은 러너가 `interrupt()` 하므로 해당하지 않는다 — 러너 프로세스가 갑자기 죽을 때의 일이다.
- **러너를 `SIGTERM` 으로 끄면 도는 런이 사람 중지와 같은 모양으로 닫힌다** — `RUN_ABORTED {by:"user"}`·런 `aborted`·메시지 없음(러너 스펙 「구현과 맞춘 것」 장의 러너 종료 판정대로). 「다시 실행」 카드가 없어서 채널의 사람은 러너가 꺼진 줄 모르고 활동 탭에 「중지됨」만 본다.
- 러너 표준 오류에 **런마다** SDK 경고 `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] canUseTool will not be invoked for: mcp__dodok__post …` 가 한 줄씩 찍힌다(러너 로그 57줄 중 14줄). 의도한 미리 허용(러너 스펙 「승인」 절 마지막 줄)이라 해롭지 않지만, 사람이 러너 터미널에서 보는 줄의 4분의 1이 이 경고다.
- 발급 응답·연결 페이지 설정 예시의 `serverUrl` 이 dev 에서는 `APP_ORIGIN`(웹 오리진)이다 — 기존 이월 「발급 조각 bridgeUrl 이 공개 주소 파생」과 같은 줄기. 배포(한 오리진)에서는 맞다.
- 연결 페이지의 로그인 명령 `CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude` 는 `claude` 가 PATH 에 있다고 가정한다. 러너 tgz 는 번들 CLI 를 품지만 PATH 에 두지 않는다 — `docs/guides/deploy.md` 「Claude 러너 설치」 절에 번들 CLI 로 로그인하는 명령을 적었다.
- CLI 는 기동마다 `HEAD <ANTHROPIC_BASE_URL>/api/hello` 를 한 번 보낸다(연결 확인). 가짜 API 는 404 로 답하고 CLI 는 그대로 진행했다.
- 러너 에이전트가 받는 `tools[]` 14개에 Claude Code 기본 도구가 그대로 있다 — `AskUserQuestion`·`Agent`·`Workflow`·`ScheduleWakeup`·`Skill` 등. 사람에게 되묻는 `AskUserQuestion` 이나 예약·하위 에이전트 도구를 모델이 부르면 dodok 에서 어떻게 되는지는 재지 않았다(러너 설정 `disallowedTools` 로 뺄 수 있다).

### 19.5 정리·잔여물

- 러너(SIGTERM)·가짜 API·서버를 자기 PID 로 내렸다. **3121·3197·3198 LISTEN 0**, 남은 `claude.real`·`dodok-runner`·`dev-fake` 프로세스 0.
- 스크래치(러너 설치본·감싸개·`HOME`·`cfg/`(세션 전사 둘)·작업 디렉터리·요청 본문·로그·토큰 파일)와 워크트리 `data/`(드라이버·DB·세션)·`packages/claude-runner/dist` 를 지웠다. 러너 전용 로그인 디렉터리·`~/.claude` 는 읽지도 쓰지도 않았다.

## 20. Claude 러너(Phase 4 ③) 실연 — 2026-09-29 결과 (p4c-t9b, 모델 런 3회)

「Claude 러너 런 0회 하네스」 절을 먼저 끝까지 돌린 뒤에 한다. 모델 런은 **3회 이내**(러너가 연 `query()` 하나 = 1회 — 릴레이·카드 누르기가 만드는 러너 런도 센다), 러너 전용 로그인(`CLAUDE_CONFIG_DIR=~/.dodok-runner/claude` — `docs/guides/deploy.md` 「Claude 러너 설치」 절의 로그인)으로.

**판정: 멘션 경로(스트리밍·도구·최종 답·운영 비용)는 통과. 규칙 변경 뒤 `resume` 은 새 규칙을 따르지 않았다** — 서버는 새 규칙만 실었는데(모델 0 으로 확인) 이어 간 세션의 모델이 자기 앞 답의 옛 표식을 이어 썼고, 「새 대화」 뒤 새 세션은 새 규칙을 따랐다(20.3). 승인·`post`·릴레이(원래 배분의 셋째)는 모델로 보지 않았다 — 셋째 런을 규칙 변경의 원인 가르기에 썼다.

### 20.1 구성

OpenClaw 쪽은 실제 dev Gateway 대신 **`dev:fake` 의 가짜 Gateway·가짜 OpenClaw 에이전트 `dev`** 다 — OpenClaw 모델 런을 0 으로 지키려고. 러너 어댑터·`/runner`·오케스트레이터·운영 집계는 운영 코드 그대로다.

| 항목 | 값 |
| --- | --- |
| 서버 | `pnpm -F @dodok/claude-runner pack:runner` 뒤 `PORT=3131 APP_ORIGIN=http://localhost:5181 LOG_LEVEL=debug pnpm -F @dodok/server dev:fake`(웹은 띄우지 않았다). 가짜 러너는 `POST /__devfake/runner {"connected":false}` 로 내리고, 에이전트 `dev`(openclaw)는 `POST /api/v1/agents` 로 등록 — `dev:fake` 는 `coder`(claude)만 미리 등록한다 |
| 러너 설치 | owner 로 `POST /api/v1/setup/runner-tokens` → 원문은 스크래치 0600 파일에만 → `GET /api/v1/setup/runner.tgz` → `npm install -g --prefix <스크래치>/runner <tgz>`. **감싸개를 두지 않는다**(실제 API) |
| 러너 설정 | `serverUrl` `http://127.0.0.1:3131`, `tokenFile` 스크래치 파일, `claudeConfigDir` `~/.dodok-runner/claude`, `maxConcurrentRuns` 1, 에이전트 `coder`(작업 디렉터리 스크래치 git 저장소 — `README.md`·`fib.sh` 커밋 하나, 라벨 `t9b-ws`, 모델 `sonnet`) |
| 러너 env | `env -i PATH=<스크래치>/runner/bin:<node bin>:/usr/bin:/bin HOME=$HOME LANG=en_US.UTF-8 TMPDIR=<스크래치>/tmp SHELL=/bin/bash USER=$USER` — `HOME` 은 실제 홈(키체인 로그인을 찾게 — ADR 0007 「질문별」 인증) |
| 채널 | `t9b-lab` — `dev`·`coder`, `relayPolicy {maxRelayTurns: 1}`(가짜 `dev` 는 부른 에이전트를 늘 되부르므로 — `dev:fake` `fakeAgentScript` — 한도 1 이면 `coder → dev` 한 번 뒤 되부름이 막혀 러너 런이 더 생기지 않는다), 채널 프롬프트 「모든 답은 첫 줄을 정확히 `[T9B-AMBER]` 한 줄로 시작하고, 그다음 줄부터 본문을 쓰세요. 답은 짧게(세 문장 이내) 한국어로 하세요.」 |
| 드라이버 | 워크트리 `data/`(ignored)에 둔 `socket.io-client` 스크립트(끝나고 지웠다) — `channel.subscribe` → `message.send` → 받은 wire 이벤트를 받은 시각과 함께 jsonl 로, `approval.requested` 가 오면 1.5초 뒤 `approval.resolve`. 런이 모두 `done`·`error`·`aborted` 가 된 뒤 8초 더 받는다 |

### 20.2 모델 런 (상한 3, 실제 3)

`+ms` 는 드라이버가 보낸 때부터. 비용은 러너가 보낸 `costUsd`(`total_cost_usd` 의 런 전후 차이), 전부 구독 로그인이라 `costKind: "subscription_estimate"` — 청구액이 아니라 공시 단가 환산값이다.

| 런 | 무엇 | 세션 | 모델이 한 것 | 시각 | 비용·토큰 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `@coder 작업 디렉터리의 README.md 를 읽고 이 저장소가 무엇인지 한 문장으로 알려 줘.` | 새 세션 | Bash `find . -maxdepth 1 -iname "README*"`(승인 없이 자동 허용) → Read `README.md` → 답 | `RUN_STARTED` +4509 → 도구 둘 +4511~+6541 → 첫 델타 +7414 → 최종 +7639 | $0.1238 · 입력 81,604 · 출력 322 | **통과** — 델타 3개, 최종 답 첫 줄 `[T9B-AMBER]`, `finalSource=plugin`. 활동 탭 자리(`run_events`)에 `TOOL_CALL_START·ARGS·END·RESULT` 도구마다 한 벌, 도구 인자·결과는 상대 경로(`README.md`, `./README.md`). 운영 `GET /api/v1/ops/runs?days=1` 이 그 런을 `measuredRuns 1 · tokens 81,926 · costEstimated: true`(웹 「환산 포함」 — `RunsTable` 의 태그)로 더했다 |
| 2 | 채널 프롬프트의 표식을 `[T9B-COBALT]` 로 바꾸고(`PATCH /api/v1/channels/<CH> {prompt}`) `@coder fib.sh 가 하는 일을 한 문장으로 알려 줘. 실행하지 말고 읽기만 해 줘.` | 런 1 세션 `resume` | Read `fib.sh` → 답 | `RUN_STARTED` +1545 → 최종 +3538 | $0.0409 · 입력 56,115 · 출력 233 | **새 규칙 불이행** — 답 첫 줄이 옛 표식 `[T9B-AMBER]`. 원인 가르기는 20.3 |
| 3 | 「새 대화」(`POST /api/v1/channels/<CH>/agents/<coder>/reset`) 뒤 런 2 와 같은 문장 | 새 세션 | 도구 없이 답(최근 대화에 인용된 런 2 의 답을 보고) | `RUN_STARTED` +3286 → 최종 +3727 | $0.0244 · 입력 27,292 · 출력 194 | **새 규칙 이행** — 답 첫 줄 `[T9B-COBALT]` |

합 **$0.1891**(환산). 런 2 가 런 1 의 세션을 이었다는 것은 러너 전용 로그인의 `projects/<작업 디렉터리>/` 전사 수로 안다(런 2 뒤 1개, 런 3 뒤 2개). 그 길이 러너의 `sessionExists` 판정으로 곧바로 `resume` 이었는지, `--session-id` 거절 뒤 「이미 있는 세션」 재시도(`session-in-use`)였는지는 **모른다** — 두 판정 모두 러너 로그에 남지 않고, 감싸개가 없어 CLI argv 도 안 적혔다. 하네스 설치본(감싸개가 argv 를 적는다)에서는 두 번째 런이 재시도 없이 `--resume` 한 번이었다(20.3 의 후보 확인).

### 20.3 규칙 변경 뒤 `resume` — 무엇이 옛 표식을 따르게 했나

런 2 의 모델이 본 것에는 새 규칙과 옛 표식 예시가 함께 있다 — **시스템 프롬프트의 새 규칙**(아래 H1), **세션 이력의 자기 앞 답**(런 1 의 `[T9B-AMBER]` 답), 그리고 **사용자 턴의 「최근 대화」 인용**(러너 프롬프트는 resume 이든 아니든 매 런 채널 최상위 최근 20개를 싣는다 — `packages/shared/src/runner/prompt.ts` 의 `renderRunnerPrompt`, 서버 `RECENT_MESSAGES_MAX` — 여기에 coder 의 `[T9B-AMBER]` 답이 있다). 모델 없이 앞의 것을, 런 3 으로 뒤의 둘을 갈랐다.

| # | 무엇 | 어떻게 | 결과 |
| --- | --- | --- | --- |
| H1 | 서버가 그 리비전에 새 규칙만 싣는가 | 실제 러너를 SIGTERM 으로 내리고, 같은 tgz 를 다른 스크래치 prefix 에 설치해 「Claude 러너 런 0회 하네스」 절의 감싸개·가짜 API(`--port 3197`)·스크래치 `HOME`·`claudeConfigDir` 로 붙여 같은 채널에 `@coder HX-TEXT …` 한 번(모델 0). 스크래치 설정 디렉터리엔 전사가 없어 새 세션(`--session-id`)이다 | 요청 `system[]` 셋(73·94·15,285자)에 **COBALT 1 · AMBER 0**, 틀 머리 1, `<relay-rules>` 의 「최대 1턴」 1. 요청 본문 전체의 AMBER 2 는 전부 `messages[0]` 사용자 블록의 「최근 대화:」 안 coder 답 둘이다 |
| 런 3 | 세션 이력 없이 「최근 대화」 인용만 옛 표식이면 | 「새 대화」 → 새 세션, 최근 대화는 런 2 직후와 같게(H1 이 남긴 사람·coder 메시지 두 행은 dev DB 에서 지웠다 — 최근 대화에 표식 없는 coder 답이 끼지 않게) | 새 표식을 따랐다 |

**판정** — 런 2 의 불이행은 전달 문제가 아니다(H1). 옛 표식이 **최근 대화 인용에만** 있을 때(런 3)는 새 규칙을 따랐고, **세션 이력의 자기 앞 답**이 함께 있을 때(런 2)는 옛 표식을 이어 썼다. 세션 이력만으로 충분하다(ADR 0007 「규칙이 바뀐 뒤 이어 간 세션」 절 — 인용을 빼도 0/2). 그래서 서버는 러너 세션을 채널 규칙 리비전이 바뀌면 다음 런에서 새 세션으로 연다 — 사람이 「새 대화」를 누르지 않아도 된다(`docs/guides/agent-guide.md` 「Claude 러너 에이전트」).

**고칠 길 후보 — 요청 본문만 봤다(모델 0, 코드는 고치지 않았다).** H1 과 같은 하네스 설치본의 번들(`dist/main.js`)만 임시로 고쳐 같은 채널에 새 세션 한 번·`resume` 한 번을 보냈다.

- **ⓐ 러너 프롬프트의 「최근 대화」에서 그 에이전트 자신의 답을 뺀다**(세션 이력에 이미 있다) — `resume` 요청의 새 사용자 턴에서 coder 줄이 빠지고 사람 줄만 남는다. 대가 둘: 새 세션(「새 대화」 뒤)은 자기 앞 답을 전혀 못 본다 — 런 3 은 바로 그 인용을 보고 도구 없이 답했다. 그리고 이미 이력에 들어간 앞 사용자 턴의 「최근 대화」 블록은 옛 모양 그대로 남는다. 그래서 빼는 것은 `resume` 런에서만, 그 세션이 시작된 뒤의 답만이어야 한다.
- **ⓑ 규칙이 바뀐 런의 턴 사실에 한 줄** — 「채널 규칙이 바뀌었습니다 — 앞 답의 형식을 따르지 말고 지금 채널 규칙을 따르세요.」 가 `UserPromptSubmit` 훅 `<system-reminder>` 안 턴 사실 끝에 실린다. 훅 문맥은 턴마다 이력에 쌓이므로(`resume` 요청에 두 턴 것이 다 있다) 늘 붙이면 안 되고 **규칙이 바뀐 뒤 그 세션의 첫 런에만** 붙여야 한다. 세션을 이어 간다면 서버의 `needsPromptContext` 는 세션 시작·「새 대화」 때 리비전(`promptRevisionAtStart`)과 견주므로 한 번 바뀐 뒤로는 「새 대화」 전까지 계속 참이다 — 「그 세션에 마지막으로 실은 리비전」을 따로 기억해야 한다.

두 후보를 모델로 잰 결과와 추천은 ADR 0007 「규칙이 바뀐 뒤 이어 간 세션」 절이다 — ⓐ 는 효과가 없었고(0/2), ⓑ 는 표식을 돌렸지만(2/2) 모델이 그 줄을 주입으로 의심해 채널 답에 적었다.

### 20.4 런을 더 쓰지 않고 본 것

- **로그 위생 — 호스트 경로·러너 토큰·이메일 0.** 스크래치 경로·`/private/tmp`·실제 홈·`.dodok-runner` 를 한 줄씩 담은 파일로 `grep -a -c -F -f <그 파일>`, 러너 토큰 파일로 같게, `drn_`, 이메일 꼴(`grep -a -c -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|net|org|io|dev|kr)'`): wire 기록 셋(34·28·20줄)·러너 로그(17줄)·서버 로그(87줄)·DB 덤프(`sqlite3 -json` 으로 `messages`·`run_events`·`runs`·`approvals`·`attachments`·`ops_events`) 전부 0. Python 부분 문자열 세기로 한 번 더 세어 같다. 양성 대조(토큰 파일 자신·러너 설정 파일의 작업 디렉터리) 1.
- **시스템 경로도 가려진다** — 런 2 의 Read 결과(활동 탭 도구 결과·`run_events`)에서 `fib.sh` 첫 줄 `#!/bin/sh` 가 `#!<작업 디렉터리 밖>` 이 됐다. `!` 뒤는 경로 시작으로 보는 가림 규칙(`packages/claude-runner/src/mask.ts` 의 `PATH_START`)대로다 — 작업 디렉터리 밖 절대 경로는 `/bin/sh`·`/usr/bin/env` 같은 시스템 경로도 가린다. 모델은 가리지 않은 원문을 받는다(가림은 서버로 가는 이벤트에만).
- **읽기 전용 Bash 자동 허용** — 런 1 의 `find . -maxdepth 1 -iname "README*"` 는 승인 카드 없이 돌았다(ADR 0007 「확인 못 한 것」 3 의 표본 하나).
- **러너가 세션을 어느 길로 열었는지 로그에 없다** — `sessionExists` 결과도 「이미 있는 세션」 재시도도 찍히지 않아, 감싸개 없는 실제 러너에서는 재시도가 났는지 알 길이 없다(20.2). 러너의 「런 시작」 줄에 `resume`·재시도 여부를 싣는 것이 가장 싸다(자리: `packages/claude-runner/src/run.ts` 의 `runOnce`).
- 러너 표준 오류는 **런마다** SDK 경고 `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] … mcp__dodok__post` 한 줄(+`--trace-warnings` 안내 한 줄)뿐이다 — 한 러너 프로세스에서 두 런이 돌아도 두 번 찍혔다. 그 밖의 경고·오류 줄 0.
- 가짜 러너를 끊으면 60초 뒤 그 토큰의 `runner_down`(warn) 사건이 운영 화면에 남는다 — 이 절차에서는 늘 생긴다.

### 20.5 모델로 보지 않은 것

- **승인·`post`·릴레이** — 쓰기 도구의 승인 카드 허용, `post` 로 카드(components)와 작업 디렉터리 안 파일, `@dev` 릴레이 한 번. 기계 경로(승인 카드·허용·거절·`post` 카드·파일·안/밖 판정)는 「Claude 러너 런 0회 하네스」 절이 실제 번들 CLI 로 끝까지 봤다. 모델이 `post` 의 `components` 를 스키마에 맞게 쓰는지, `artifact://` 이름의 공백을 인코딩하는지는 모른다.
- 카드 누르기가 만드는 다음 러너 런 — `dev:fake` 가짜 러너 위 브라우저 검증이 봤다.

### 20.6 정리·잔여물

- 러너(SIGTERM)·하네스 러너·가짜 API·서버(LISTEN 하는 node PID 에 SIGINT)를 자기 PID 로 내렸다. **3131·3197 LISTEN 0**, 남은 `dodok-runner`·`claude.real`·`dev-fake` 프로세스 0. 발급한 러너 토큰은 내리기 전에 폐기했다(`DELETE /api/v1/setup/runner-tokens/<id>` 204).
- 러너 전용 로그인 디렉터리에서 **이 실연이 만든 세션 자리만** 지웠다 — `projects/<작업 디렉터리 경로>/`(전사 2), `session-env/<런 1·2 세션>/`, 그리고 `/private/tmp/claude-<uid>/<작업 디렉터리 경로>/`. 그 디렉터리의 다른 파일은 열지 않았다. CLI 가 런 중에 바꾼 `.claude.json`·`backups/.claude.json.backup.*`(새로 2)·`cache/model-catalog/`(새로 1)는 로그인·설정 파일이라 두었다 — `.claude.json` 에 작업 디렉터리 경로의 프로젝트 항목이 남았을 수 있다(열어 보지 않았다).
- 스크래치(러너 설치본 둘·감싸개·가짜 API 요청 본문·wire 기록·로그·토큰 파일)와 워크트리 `data/`(드라이버·DB·세션)·`packages/claude-runner/dist` 를 지웠다.
