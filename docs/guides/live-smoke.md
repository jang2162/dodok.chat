# dev Gateway 실연(live smoke) — 서버 코어를 실제 Gateway·플러그인·모델로 한 번 돌리기

작성: 2026-09-15 (서버 코어 계획 태스크 15) · 근거: 서버 코어 스펙 9.3, ADR 0002 2절·9절, ADR 0003 2절 · 7절 2026-09-20 (웹 MVP 계획 태스크 15) · 8~9절 2026-09-21 (활동 패널·승인 계획 태스크 11) · 10절 2026-09-23 (components v1 계획 태스크 11) · 11절 2026-09-23 (c2-t14 하네스, ADR 0004) · 12절 2026-09-23 (c2-t16 고침 실물 확인)

## 1. 목적

통합 테스트(`apps/server/test/integration/`)는 가짜 Gateway·가짜 플러그인으로 돈다. 가짜가 실물과 다르게 구는 곳(구독 범위·지연·모델 출력)은 거기서 잡히지 않는다.
이 절차는 **실제 서버 + 로컬 dev Gateway(OpenClaw 2026.9.4) + 실제 플러그인 번들 + 실제 모델(claude-cli)** 로 시나리오 2~4·8·재접속을 손으로 한 번 돌려
지연을 재고 틀린 것을 찾는다. 모델 런은 돈이 드므로 브리프가 상한을 정한다.

2~6절은 서버 코어(Phase 1 ①, 2026-09-15 에 돌린 결과가 5절)다. **웹(Phase 1 ②)을 같은 환경에 얹는 절차와 2026-09-20 에 돌린 결과는 7절**이다.
**승인(Phase 2 ①)을 실물에서 일으키는 절차는 8절** — 기본 설정에서는 승인이 한 번도 안 뜬다. **사람만 확인할 수 있는 것(소리·팝업·잠금 화면·VoiceOver)은 9절**이다.
**components v1(Phase 2 ②)을 실제 모델로 돌린 절차와 2026-09-23 결과는 10절**이다 — ❗ 모델 런 안의 `message` 툴 전송이 실물에서 깨져 있었다(10.4).
원인(2026.9.5 번들 이중 평가)과 고침은 ADR 0004, **모델 런 없이 실물 Gateway 의 모델 경로를 두드리는 하네스는 11절**, **그 하네스로 고침을 확인한 2026-09-23 결과는 12절**이다.

## 2. 전제

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI | `/Applications/OpenClaw.app` 번들 CLI(`2026.9.4 (3a9d69d)`, 번들 Node 24.19.0). PATH 에 번들 bin 을 앞에 둘 때만 쓴다 — `gateway install`·글로벌 설치·시스템 Node 교체 금지. ⚠ **앱은 스스로 업데이트된다** — 2026-09-23 에는 `2026.9.5 (f396007)` 였다(앱 번들 `bin/openclaw` 심링크 수정 시각 2026-09-20 14:24 — 승인 스파이크 뒤. 전에 적은 「09-19」는 번들 `node` 바이너리 시각이었다, c2-t14). 저장소 핀은 `2026.9.4` 그대로라 **실연 전에 `oc --version` 을 적는다**(10.1). 서버 로그로도 보인다: `"gateway connected"`·`"bridge plugin hello"` 의 `gatewayVersion`. ⚠ 같은 줄의 `pluginBuiltWithSdk`(옛 이름 `sdkVersion`)는 **빌드 때 박힌 devDependency 상수**라 9.5 위에서도 `2026.9.4` 다 — Gateway 버전으로 읽지 않는다 |
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

아래 `oc` 는 번들 CLI 를 부르는 약속이다(각 셸에서 정의).

```bash
OCBIN=/Applications/OpenClaw.app/Contents/Resources/node-worker/arm64/bin
oc() { env PATH="$OCBIN:$PATH" openclaw "$@"; }
```

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
# {"provider":"openclaw","gateway":"connected","bridge":"connected","capabilities":{"sessionReset":true,"agentsList":true,"configSet":true}}
```

`bridge` 가 60초 안에 `connected` 가 안 되면 `data/dev-gateway.log` 의 `[dodok] bridge:` 줄을 본다. 서버가 늦게 뜨면 플러그인 백오프가 벌어져 있어
첫 연결에 그만큼 걸린다(상한 10s, 지터 포함 ~12s — 30s 상한이던 이번 실연은 21s). `UNAUTHORIZED` 면 계정 토큰을 `.env` 의 `BRIDGE_TOKEN` 과 맞춘다 — 인자로 넘기면 ps 에 남으므로 ADR 0002 9.5 처럼 패치 파일로:

```bash
( . ./.env; umask 077; printf '{ channels: { dodok: { accounts: { default: { token: "%s" } } } } }\n' "$BRIDGE_TOKEN" > data/bridge-token.patch.json5 )
oc --dev config patch --file data/bridge-token.patch.json5 && rm data/bridge-token.patch.json5   # 계정 변경은 Gateway in-process 재시작을 부른다
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
- 브리지: 플러그인이 **아웃바운드로** 서버에 붙는다. 개발 PC 서버면 터널(cloudflared 등)로 `wss://…/bridge` 를 만들고, 그 주소를 `BRIDGE_PUBLIC_URL` 에 적고 호스트의 계정 `bridgeUrl` 에 넣는다. 토큰은 `BRIDGE_TOKEN` 과 같게.
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
  재연결을 멈춘 뒤 「실시간 연결이 거부되었습니다 — 주소(localhost:5173)를 확인하세요」 배너를 띄운다(설계대로다 — 헷갈리지 말 것).
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
```

3절 (f) 정리에 이 한 줄을 더한다. 되돌리지 않으면 **다음 실연이 모든 툴에서 멈춰** 서 있게 된다 — 승인을 누르는 사람이 없으면 런이 120초마다 만료로 끝난다.
`--dev` 프로필만 건드리므로 원격 프로필(`~/.openclaw`)에는 영향이 없다. `Config path not found … Nothing was changed.` 가 나오면 이미 깨끗하다는 뜻이다(정상).

---

## 9. 사람이 눈·귀로 확인할 것 (자동 검증이 원리상 못 재는 것)

아래는 브라우저 자동화·jsdom 이 **측정할 수 없는** 것들이다. 1차 브라우저 검증(p2-t10 §5)에 이어 **재검증(p2-t13)도 넷 다 못 쟀다** — 도구를 바꿔서 될 일이 아니라 사람의 눈·귀가 필요한 자리다.
재검증이 대신 무엇을 확인했고 **어떻게 흉내 냈는지**는 9.2 에 적어 뒀다 — 같은 방법을 그대로 쓰면 준비가 빨라진다.
`dev:fake` 로도 되고 실물로도 된다 — 8절로 승인을 한 번 일으킨 김에 같이 본다. 브라우저는 `http://localhost:5173` 고정(알림 권한은 **출처별**이라 주소가 다르면 다시 묻는다).

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

`openclaw --dev mcp serve` 는 **다른 경로**다(외부 MCP 클라이언트용 채널 브리지, 툴 9개에 `message`·`components` 없음) — 이 목적에 쓰지 않는다.

### 11.1 준비 (3절 (a)~(e) 그대로 + 하네스용 채널)

```bash
OCBIN=/Applications/OpenClaw.app/Contents/Resources/node-worker/arm64/bin
oc() { env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_GATEWAY_TOKEN PATH="$OCBIN:$PATH" openclaw "$@"; }
oc --version                                   # 적는다 (2026-09-23: 2026.9.5 (f396007))
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

11.3 하네스에 세 가지를 더해 첨부 경로를 모델 없이 두드린다. 스파이크(`.superpowers/sdd/2026-09-23-phase2-attachments-spike/report.md` 「절차 요지」)가 11.4 를 넓혀 쓴 것을 이 문서 모양으로 다시 적었다 — **이 코드 그대로는 아직 돌리지 않았다.** 처음 돌리는 사람이 고친 데를 여기 적는다.
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

⚠ 가짜 CLI 런은 `message` 툴을 써도 최종 텍스트가 **억제되지 않는다**(스파이크 2-15 — 가짜 CLI 가 `tool_use` 레코드를 내지 않아서로 보인다). 툴 런에서 `FINAL` 이 따로 한 메시지로 오는 것은 하네스 탓이다. 억제 동작은 이 하네스로 재지 않는다.

**③ 준비물.** 툴이 읽을 파일은 **Gateway 워크스페이스 안**에 둔다(dev: `~/.openclaw-dev/workspace`). 밖이면 `tools.fs.workspaceOnly` 에 따라 「허용되지 않은 경로」가 날 수 있다.

```bash
WS=~/.openclaw-dev/workspace; mkdir -p $WS/a3-harness
cp <아무 PNG> $WS/a3-harness/chart.png; cp <아무 PDF> "$WS/a3-harness/월간 보고서.pdf"
shasum -a 256 $WS/a3-harness/*; stat -f '%z %N' $WS/a3-harness/*          # 크기·sha 를 적어 둔다
```

**④ 차례와 합격 기준**(계획 `docs/superpowers/plans/2026-09-23-attachments.md` 태스크 11 의 1). 런마다 `$SP/fake-args.json`·`fake-final.txt` 를 바꾸고 `@dev` 를 한 번 보낸다. 사람 이미지는 **웹 작성기로** 보낸다 — `wire-cli` 는 첨부를 보내지 못한다(7.1 준비대로 웹을 띄운다).

| # | 런 | 준비 | 합격 |
| --- | --- | --- | --- |
| a | **인바운드** — 사람 이미지 | `fake-args.json`·`fake-final.txt` 없음. 웹에서 PNG 한 장 + `@dev 첨부 프로브` | `stdin-record` 의 `atRefs` 가 하나, `magic` 이 `89504e470d0a1a0a`, `size` 가 올린 원본과 같다(`contentKind:"string"`, `blocks:[]`). Gateway 로그 `dodok:inbound-media` 가 `images:1`·`reasons:[]` |
| b | **툴 `media`** — PNG·PDF·한국어 이름 | `fake-args.json` = `{"action":"send","target":"channel:<CH>","message":"첨부 둘","mediaUrls":["<WS>/a3-harness/chart.png","<WS>/a3-harness/월간 보고서.pdf"]}` | `tools/call message` 가 `sent to dodok channel …`. 채널 메시지에 첨부 둘이 **그 순서로**, 이름 `chart.png`·`월간 보고서.pdf` 그대로. 내려받은 바이트의 sha 가 ③ 과 같다. `dodok:tool-send-media` 가 `uploaded:2`·`failed:0` |
| c | **최종 응답 `MEDIA:` 줄** | `fake-args.json` 없음. `fake-final.txt` 세 줄 — `결과`, 빈 줄, `MEDIA:<WS>/a3-harness/chart.png`(`printf '결과\n\nMEDIA:%s\n' <경로> > $SP/fake-final.txt`) | 채널 메시지 본문이 `결과` 이고 **`MEDIA:` 가 없다**, 첨부 하나. `dodok:deliver-media` 가 `uploaded:1`. 서버 로그에 `gateway snapshot media lines dropped` 가 없다(플러그인 정본이 먼저 왔다는 뜻 — 스펙 11장 Ruling 2) |
| d | **미디어만 있는 응답** | `fake-args.json` 없음. `fake-final.txt` 한 줄 — `MEDIA:<WS>/a3-harness/chart.png` | 채널에 **본문 없이** 첨부만 온다. 채널 어디에도 호스트 경로(`/Users/`·`~/.openclaw`)가 없다 |
| e | **실패 문구**(선택) | b 의 경로 하나를 없는 파일로 | 툴 결과가 `dodok: 첨부를 보내지 못했습니다 — <이름>: 파일을 찾을 수 없음`. 호스트 경로가 툴 결과·채널에 없다(원문은 `dodok:tool-send-media` 의 `details` 에만, 가려서) |

`<CH>`·`<WS>` 는 실제 값으로 바꿔 쓴다. c·d 가 통과하면 스파이크 2-10 의 결함(미디어 전용 응답이 `MEDIA:/호스트/경로` 를 채널에 드러냄)이 실물에서 닫힌 것이다.
이 표는 플러그인 `channel.ts` 배선(순수 함수를 부르는가)의 합격 기준도 겸한다 — 단위 테스트는 그 우회를 못 잡는다(`docs/plan.md` 8장 이월).

**끝나면**: 11.3 대로 되돌리고, `rm -rf $WS/a3-harness`. 플러그인이 저장한 원본(`~/.openclaw-dev/media/inbound/`)·CLI 복사본(`<ws>/.openclaw-cli-images/`)·스테이징(`<ws>/media/inbound/openclaw-staged-*`)에서 이번 런이 만든 것만 지운다(스파이크 보고서 「정리 상태」가 본보기).

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
