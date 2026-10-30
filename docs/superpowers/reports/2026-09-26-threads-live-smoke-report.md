# 스레드(Phase 4 ①) 실연 — 2026-09-26 결과 (p4t-t9a, 계획 태스크 9, 모델 런 2회)

> 스레드(Phase 4 ①) 하위 세션을 실물 dev Gateway 에서 돌린 실연의 기록 — 계획 `docs/superpowers/plans/2026-09-25-threads-search.md` 태스크 9, 스펙 `docs/superpowers/specs/2026-09-25-threads-search-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


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
B="agent:dev:dodok:channel:${CH}"          # zsh — ${B}:thread:${R} 로 잇는다(11.3 「세션을 잴 때 걸리는 곳 넷」)
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
- 기준 5 는 **서로 다른 세션**의 두 멘션을 같이 보낸다. 같은 세션에 겹쳐 보내면 가짜 CLI 의 둘째 턴이 실패한다(11.3 「세션을 잴 때 걸리는 곳 넷」 1).
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
