# dev Gateway 실연(live smoke) — 서버 코어를 실제 Gateway·플러그인·모델로 한 번 돌리기

작성: 2026-09-15 (서버 코어 계획 태스크 15) · 근거: 서버 코어 스펙 9.3, ADR 0002 2절·9절, ADR 0003 2절

## 1. 목적

통합 테스트(`apps/server/test/integration/`)는 가짜 Gateway·가짜 플러그인으로 돈다. 가짜가 실물과 다르게 구는 곳(구독 범위·지연·모델 출력)은 거기서 잡히지 않는다.
이 절차는 **실제 서버 + 로컬 dev Gateway(OpenClaw 2026.9.4) + 실제 플러그인 번들 + 실제 모델(claude-cli)** 로 시나리오 2~4·8·재접속을 손으로 한 번 돌려
지연을 재고 틀린 것을 찾는다. 모델 런은 돈이 드므로 브리프가 상한을 정한다.

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

`OPENCLAW_CLI_BACKEND_LOG_OUTPUT=1` 은 claude-cli 의 `cli argv:`·stdout 을 로그에 남긴다(프롬프트 주입·토큰 사용량 확인용). 서버가 아직 없으니 플러그인은 `bridge: 재연결 …ms 후` 를 백오프로 찍는다(최대 ~34s 간격).

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

`bridge` 가 60초 안에 `connected` 가 안 되면 `data/dev-gateway.log` 의 `[dodok] bridge:` 줄을 본다. 서버가 늦게 뜨면 플러그인 백오프가 ~34s 까지 벌어져 있어
첫 연결에 그만큼 걸린다(이번 실연 21s). `UNAUTHORIZED` 면 계정 토큰을 `.env` 의 `BRIDGE_TOKEN` 과 맞춘다 — 인자로 넘기면 ps 에 남으므로 ADR 0002 9.5 처럼 패치 파일로:

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
| 브리지 | 서버 listen 뒤 21.5s 에 `ready`(플러그인 백오프 7번째 시도). 재기동 때는 10.6s |
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
2. **[남음] usage 값.** 5.3 ⑤. `session.message` 원본을 덤프해 Gateway 가 스냅샷만 싣는지, 매퍼가 첫 값을 고르는지 가려야 한다(이번에는 원본을 기록하지 않았다). 활동 패널의 비용·토큰 표시는 이대로 쓸 수 없다.
3. **[고침] 서버 로그로 진단이 안 된다.** `inbound.deliver` ack(admission·걸린 시간)와 런 타임아웃(`queued timeout`)이 서버 로그에 한 줄도 남지 않았다 — 런 1 원인은 Gateway 로그로 찾았다.
   이제 어댑터 `inbound delivered`(info: `runId`·`deliveryId`·`admission`·`ackMs`(첫 시도부터)·`retries`·`waitedForPlugin`), 오케스트레이터 `run ended`(info: `status`·`finalSource`·`errorCode`·`durationMs`(created→ended))·
   `run closed by timeout`(warn: `reason` = `queue_timeout`·`run_timeout`·`undelivered`(ack 전 상한), `statusBefore`·`elapsedMs`(created 부터); `final_timeout` 은 info). 본문·토큰은 싣지 않는다. 정상 런은 info 2줄.
4. **[고침] 정본이 왔는데 `queued` 로 남는 런.** Gateway 이벤트 없이 정본만 오는 경우(결함 1, 또는 WS 만 끊긴 경우) 런은 120s 뒤 `error` 가 되고 「실행이 실패했습니다」가 답 아래에 붙었다.
   이제 `queued` 에서 `canonical_received` 를 받으면 `finalizing`(`hasCanonical`)으로 가고, Gateway `final` 이 오면 곧바로·안 오면 10s 뒤 `done(finalSource=plugin)` 이다(계약 스펙 5.1 ⁵, 통합 시나리오 6(c)).
   가짜 Gateway 하네스에서는 서버가 브리지 소켓을 먼저 읽어 정본이 Gateway 이벤트보다 먼저 처리되고 있었다 — 대본은 정본 앞에서 `gateway.flush()`(ping/pong)로 이벤트 처리를 기다린다.
5. **[프롬프트] 서술 속 멘션도 릴레이다.** 런 5 의 dev 는 보고 문장에 `@fin` 을 넣었고 그것이 릴레이 판정을 받았다(상한 0 이라 카드만). 상한이 남아 있으면 fin 런이 돈다 — 에이전트 프롬프트 가이드(Phase 3)에 「부를 때만 @핸들」을 적을 것.
6. **[환경] claude-cli 가 사용자 `~/.claude` 설정을 싣는다**(`--setting-sources user`): 턴마다 SessionStart 훅(startup 18·resume 4회 관찰)이 돌고 첫 턴 캐시 생성 53k 토큰($0.53). 6런 CLI 보고 비용 합 약 $1.77, 7일 사용률 0.87 → 0.89.
7. **[환경] 내장 cron** — 5.2. dev 프로필에서 실연을 반복하면 매주 한 번씩 섞인다(fin 것은 2026-09-17 예정).
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
