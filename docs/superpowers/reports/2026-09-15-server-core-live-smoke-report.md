# 이번 실연 결과 (2026-09-15, 서버 코어 태스크 15)

> 서버 코어(Phase 1 ①)를 실제 dev Gateway·플러그인·모델로 돌린 실연의 기록 — 계획 `docs/superpowers/plans/2026-09-15-server-core.md` 태스크 15, 스펙 `docs/superpowers/specs/2026-09-15-server-core-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


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
