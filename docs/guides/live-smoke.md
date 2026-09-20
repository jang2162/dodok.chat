# dev Gateway 실연(live smoke) — 서버 코어를 실제 Gateway·플러그인·모델로 한 번 돌리기

작성: 2026-09-15 (서버 코어 계획 태스크 15) · 근거: 서버 코어 스펙 9.3, ADR 0002 2절·9절, ADR 0003 2절 · 7절 2026-09-20 (웹 MVP 계획 태스크 15) · 8~9절 2026-09-21 (활동 패널·승인 계획 태스크 11)

## 1. 목적

통합 테스트(`apps/server/test/integration/`)는 가짜 Gateway·가짜 플러그인으로 돈다. 가짜가 실물과 다르게 구는 곳(구독 범위·지연·모델 출력)은 거기서 잡히지 않는다.
이 절차는 **실제 서버 + 로컬 dev Gateway(OpenClaw 2026.9.4) + 실제 플러그인 번들 + 실제 모델(claude-cli)** 로 시나리오 2~4·8·재접속을 손으로 한 번 돌려
지연을 재고 틀린 것을 찾는다. 모델 런은 돈이 드므로 브리프가 상한을 정한다.

2~6절은 서버 코어(Phase 1 ①, 2026-09-15 에 돌린 결과가 5절)다. **웹(Phase 1 ②)을 같은 환경에 얹는 절차와 2026-09-20 에 돌린 결과는 7절**이다.
**승인(Phase 2 ①)을 실물에서 일으키는 절차는 8절** — 기본 설정에서는 승인이 한 번도 안 뜬다. **사람만 확인할 수 있는 것(소리·팝업·잠금 화면·VoiceOver)은 9절**이다.

## 2. 전제

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI | `/Applications/OpenClaw.app` 번들 CLI(`2026.9.4 (3a9d69d)`, 번들 Node 24.19.0). PATH 에 번들 bin 을 앞에 둘 때만 쓴다 — `gateway install`·글로벌 설치·시스템 Node 교체 금지 |
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
- 첫 부팅 로그에서 `"url":"http://127.0.0.1:<PORT>"`·`"msg":"gateway connected"`(scopes 에 `operator.admin`)를 확인한다.

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
- dev 프로필 전용 주의(내장 cron·`~/.openclaw-dev` 잔여물)는 원격 호스트의 설정·예정 작업으로 바뀐다 — 호스트에서 `openclaw cron list` 로 본다.

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

아래는 브라우저 자동화·jsdom 이 **측정할 수 없는** 것들이다(Phase 2 ① 브라우저 검증 p2-t10 §5 에서 미확인으로 남았다).
`dev:fake` 로도 되고 실물로도 된다 — 8절로 승인을 한 번 일으킨 김에 같이 본다. 브라우저는 `http://localhost:5173` 고정(알림 권한은 **출처별**이라 주소가 다르면 다시 묻는다).

⚠ **순서가 있다**: `granted` 를 **먼저** 본다. 권한을 한 번 `denied` 로 만들면 「알림 켜기」 토글이 영영 사라지고(설계대로), 같은 출처에서 다시 묻지 못한다.
되돌리려면 브라우저 사이트 설정에서 손으로 초기화해야 한다.

| # | 볼 것 | 어떻게 | 통과 기준 |
| --- | --- | --- | --- |
| 1 | **권한 팝업 모양** | 사이드바 하단 「알림 켜기」를 누른다(그 전에는 한 번도 안 떠야 한다) | 버튼을 누른 **뒤에만** 팝업이 뜬다. 로그인·홈·채널·에이전트 화면에서는 0회 |
| 2 | **실제 알림 소리** | 권한 `granted` → 탭을 **진짜로** 숨긴다(다른 앱으로 전환·창 최소화) → 승인을 일으킨다 | 알림 1건과 함께 OS 알림음이 들린다 |
| 3 | **알림을 누르면 탭이 앞으로 오는가** | 위 알림을 클릭 | 브라우저 창이 앞으로 오고, 그 채널의 **활동 탭**(`/c/<id>/activity`)이 열린다. Phase 2 ④ 웹푸시가 그대로 이어받는 동작이라 한 번은 꼭 본다 |
| 4 | **잠금 화면 표시** | 알림이 뜬 상태에서 화면을 잠근다 | 잠금 화면에 배너가 보이는가(보인다면 제목·본문에 툴 인자가 새지 않는지 — 문구는 「승인 필요 — @dev 가 Write 를 실행하려 합니다」 / 「general 채널」뿐이어야 한다) |
| 5 | **VoiceOver 가 확정·만료 안내를 읽는가** | VoiceOver(⌘F5) 를 켜고 「이번만 허용」을 누른다 | 「선택: 이번만 허용」 줄이 읽힌다. 만료도 같다(「시간이 지나 답할 수 없습니다.」) |
| 6 | **같은 문구가 두 번 읽히는가** | 위를 **활동 탭이 열린 상태**에서 다시 한다 | 같은 승인의 카드가 흐름·패널 **둘**이라 같은 `aria-live` 문구가 같은 밀리초에 둘 삽입된다. 두 번 읽히면 한쪽을 `aria-hidden` 으로 죽일지 판단한다(현재는 둘 다 `polite`) |

DOM 사실은 이미 확인돼 있다: 확정·만료 안내는 **텍스트를 담은 채 새로 삽입되는** `<p aria-live="polite">` 다(기존 영역의 텍스트 변경이 아니라 조건부 렌더). 카운트다운 span 에는 `aria-live` 를 붙이지 않았다.

곁들여 남은 것: **작성기 한글 IME**(조합 중 Enter 가 전송하지 않는지, 7.7) 도 사람만 볼 수 있다 — 같은 자리에서 한 번 본다.
