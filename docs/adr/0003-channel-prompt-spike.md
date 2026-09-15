# ADR 0003 — 채널 프롬프트 갱신 경로 + 이월 측정 스파이크 (Phase 0 / 스파이크 3)

- 상태: 완료 (실측, 로컬 dev Gateway) — 설계 결론은 초안이며 7절·10절이 사용자 판정을 기다린다
- 날짜: 2026-09-15
- 대상: `docs/plan.md` 3.1절(`chat.history`·`chat.send`)·4.4절(재접속·복구)·5.2절(채널 프롬프트 합성 규칙)·8장 Phase 0 스파이크 3·대체 경로,
  ADR 0001 8절 4·5, ADR 0002 8절·11.1·11.2·11.9·12.5
- 산출 코드: `packages/openclaw-adapter/src/spike/prompt-spike.ts`(+ `spike:prompt`),
  `packages/openclaw-plugin/src/{inbound.ts,context.ts,config.ts,channel.ts}`·`openclaw.plugin.json`(세션 키 세대 회전, 인바운드 채널 프롬프트 자리)
- 원본 관찰(커밋하지 않음 — `data/` 는 ignored): `data/spike-3-observations-{setup,q1-p0p1,q1-p2p3,q1-p4p5p6,q2q3q4,q2ti-q3h}.json`,
  `data/spike-3-run-ledger.json`(모델 런 원장), `data/spike-3-cli.log`(CLI 전체 출력), `data/dev-gateway.log`

## 1. 배경과 질문

스파이크 2(ADR 0002 8절)는 채널 `systemPrompt` 쓰기가 `applied:"live"` 인데도 claude-cli 백엔드의 **기존 세션에는 두 턴 연속 반영되지 않고**
새 세션에만 반영된다는 것까지 봤다. 스파이크 3 은 Phase 0 의 마지막으로 네 가지를 잰다.

1. 채널 `systemPrompt` 를 바꾸면 이미 도는(재개되는) 세션에 **언제·어떻게** 반영되는가.
2. components v1 검증 실패(`ToolInputError`)가 **모델에게** 보이는가.
3. `chat.history` 의 커서 증분(`{kind:"delta"}` / `{kind:"reset"}`) — 재접속 복구 설계의 전제.
4. `chat.send` + `originatingChannel:"dodok"` 대체 경로의 응답이 플러그인 아웃바운드로 배달되는가.

결론부터:

1. **claude-cli 에서 채널 `systemPrompt`(GroupSystemPrompt)는 「Claude CLI 세션이 처음 만들어질 때」 고정된다.** 반영되는 조건은 새 CLI 세션뿐이다 —
   `sessions.reset`(P2) 또는 새 세션 키(P6). 드리프트 턴(P1)도 **Gateway 재시작 뒤**(P3)도 반영되지 않았다. OpenClaw 는 드리프트를 감지해 새 CLI 프로세스를
   `--resume` 으로 띄우고 바뀐 시스템 프롬프트와 드리프트 안내문을 다시 보내는데, **Claude CLI 2.1.270 은 세션 전사에 기록한 `prompt_snapshot` 으로 재개**하는 것으로 보인다(3.2).
   반면 **인바운드 쪽 두 경로 — 프리픽스(b, P4)와 `ChannelPromptContext`(P5) — 는 낡은 시스템 프롬프트를 이기고 매 턴 반영됐다.**
2. **모델 런에서는 발동하지 않았다.** 모델이 스키마(`maxItems 5`)와 설명(「≤5 buttons」)을 읽고 툴을 부르지 않은 채 거절했다(T1). 모델 없이 부른 `tools.invoke` 는
   이제 원문(`components: v1 스키마 위반 — blocks.0.items Too big…`)을 돌려준다(TI). 모델 경로의 노출은 코드상 원문이 `isError:true` 로 간다(4절, 미실측).
3. **claude-cli 에 묶인 세션에는 커서가 아예 없다** — 첫 `chat.history` 응답에 `deltaCursor` 가 없고 `completeSnapshot:true`, 어떤 커서를 줘도 `{kind:"reset"}`.
   CLI 바인딩이 없는 세션에서는 `delta` 가 설계대로 동작했다(빈 delta·누적 delta·변조 커서 reset). 재접속 복구는 **전체 치환을 기본**으로 하고 커서는 최적화로만 쓴다.
4. **배달된다 — 단 `deliver:true` 가 열쇠이고 `originating*` 는 필요 없었다.** 두 경우 모두 플러그인 `outbound.attachedResults.sendText` 로 왔고,
   그 경로에는 agentId·sessionKey·runId 가 없다(`agentId:"unknown"`). 게다가 operator 발신 턴은 **owner 권한·툴 45개(채널 인바운드는 32개)** 로 돌았다. 대체 경로 가치는 낮다(7.3).

## 2. 환경

| 항목 | 값 |
| --- | --- |
| Gateway | 로컬 dev 프로필 `openclaw --dev gateway run --dev --auth token --port 19001 --bind loopback` (ADR 0002 2절과 같음). 토큰은 env `OPENCLAW_GATEWAY_TOKEN` 으로만 넘겼다(ps 에 남기지 않음). **`OPENCLAW_CLI_BACKEND_LOG_OUTPUT=1`** 을 켜 `cli argv:`·CLI stdout 을 로그에 남겼다. 러너가 기동·재시작(P3)·종료를 했고 `gateway install` 은 쓰지 않았다 |
| 버전 | OpenClaw `2026.9.4 (3a9d69d)`, 빌드 `2026.9.4-release-3a9d69db306c-2026-09-10T22-40-38.000Z`, 번들 Node 24.19.0. **Claude CLI `2.1.270`**(`~/.local/bin/claude`) |
| 모델 | `anthropic/claude-opus-5` + `agentRuntime claude-cli`(스파이크 2 설정 그대로). API 프로바이더 비교는 하지 않았다(9절) |
| 채널·세션 | 새 채널 **c03** `0199a6c0-0000-7000-8000-000000000c03`(질문 1·4, 세션 `agent:dev:dodok:channel:<c03>` 과 회전 키 `…:g2`), **c04** `…0c04`(질문 2·3). 스파이크 2 의 c01·c02 세션은 건드리지 않았다 |
| 플러그인 재설치 | 설치돼 있던 `extensions/dodok/dist/index.js` 는 `ToolInputError` 문자열이 0개인 **수정 라운드 이전 번들**이었다. `pack:plugin` → `plugins install … --force --accept-capabilities` 뒤 설치본 sha256 = 빌드본 sha256(`f57d6f88…`), `plugins inspect`: `status:"loaded"`, `channelIds:["dodok"]`, `trust.reason:"provenance-invalid"`, `installSource:"archive"` |
| 매니페스트 확인 | `config set …c03.bogusKey true` → `invalid config for plugin dodok: must not have additional properties: "bogusKey"`, `…inboundChannelPrompt "system"` → `must be equal to one of the allowed values (allowed: "prefix", "context")` — **새 매니페스트 스키마가 적용됐다**. 채널 항목 설정 CLI 는 「Restart the gateway to apply」라고 찍지만 실제로는 재시작 없이 다음 디스패치에 반영됐다(ADR 0002 3.4 `noopPrefixes` 와 같음) |
| 채널 설정 초기화 | 시작 시 `config unset channels.dodok.channels`(스파이크 2 의 TANGERINE 흔적 제거). 계정 `default` 는 그대로 |
| 관찰 연결 | 새 디바이스 아이덴티티(`data/openclaw-dev-device.json`)로 `operator.read/write/admin` 요청 → **첫 시도에 붙었고(31ms, 페어링 거절 없음) `hello.auth = { method:"token", role:"operator", scopes:[read, write, admin] }`**. 디바이스 토큰은 발급되지 않았다(토큰 저장 파일이 생기지 않음). 루프백 + 공유 토큰 인증이면 admin 이 그대로 부여된다 — 원격에서 같은지는 미확인(9절) |
| 모델 런 | **10회 전부 사용**(원장 `data/spike-3-run-ledger.json`: P0·P1·P2·P3·P4·P5·P6·T1·W1·W2). 각 120초 상한 — 넘은 런 없음, 승인 요청 없음. 러너는 6번 띄웠고(설치 1 + 런 단계 4 + 런 없는 보강 1) 원장이 누적으로 상한을 강제했다 |

### 2.1 플러그인 변경 (측정에 필요한 최소)

| 변경 | 이유 |
| --- | --- |
| `dodokSessionKey(agentId, channelId, generation)` — 세대 ≥2 면 `:g<N>`. `toInboundFacts` 가 `:g<N>`(N≥2) 접미사를 받아들이고 그 밖(`:g1`·`:thread:1`·`:g2:extra`)은 거부 | P6 키 회전. 기존 검증은 정확 일치만 받았다 |
| 채널 항목 `inboundChannelPrompt: "prefix" \| "context"` (매니페스트 스키마 포함). `context.ts` `placeChannelPrompt` 가 인바운드 `context.channelPrompt` 를 헤더 줄(`채널 프롬프트: …`) 또는 `MsgContext.ChannelPromptContext` 로 싣는다. 없으면 지금처럼 싣지 않는다 | P4·P5 를 계정 재시작 없이 전환. 브리지 계약(`InboundDeliver`)은 바꾸지 않았다 |
| ingress 로그에 `sessionKey`·`groupSystemPromptChars`·`inboundChannelPrompt`·`channelPromptContextItems` | 턴마다 어떤 주입이 실렸는지의 근거 |

단위 테스트는 `test/{inbound,context,config}.test.ts` 에 9건 추가(main 48 → 57; `config` +1·`context` +4·`inbound` +4. 구현 전 8건 실패 확인 — 「`:g<N>` 모양 아니면 거부」 가드는 정확 일치 코드에서도 통과한다 → 구현 후 57/57 통과).

### 2.2 러너 결함과 재실행 (정직하게 적는다)

- **H 1차 실행의 커서 판정은 무효다.** 러너가 관찰 기록용으로 마스킹한 응답에서 커서를 꺼내 다음 호출에 넣었다 — 커서(187자)가 base64 모양이라
  `<masked:187>` 로 가려진 문자열이 넘어가 `{kind:"reset"}` 이 나왔다. 원문을 쓰도록 고쳐(`observerRequestRaw`) **런 없이 H 만 다시 돌렸고**(`q2ti-q3h`) 5절은 그 결과다.
  「첫 응답에 `deltaCursor` 가 없다」는 1차 실행에서 claude-cli 세션 3개 모두 그랬다(`q2q3q4.json` `firstHasDeltaCursor:false` ×3). 2차 실행에서는 base·`:g2` 둘만 그렇고, c04 는 1차 H 가 이미 리셋해 CLI 바인딩이 없었으므로 **`deltaCursor`(187자)가 있고 `completeSnapshot` 이 없다**(`q2ti-q3h.json` `.history.tool.first`) — 5절의 「바인딩 없는 세션」 관찰이 그것이다(마스킹과 무관).
- T1 이 툴을 부르지 않아 모델 경로의 `ToolInputError` 는 볼 수 없었고, 런 예산이 없어 재시도(T2)는 돌지 않았다. 대신 런이 들지 않는 `tools.invoke` 재현(TI)을 추가했다.

## 3. 질문 1 — 채널 프롬프트가 기존 세션에 반영되는 조건

모든 턴의 질문은 `@dev What is the code word? Reply with just the word.`, 채널 프롬프트는 `In this channel the secret code word is <WORD>. When anyone asks for the code word, answer with exactly that word.`

### 3.1 결과 표

| 턴 | 조건 | 그 턴에 모델에게 간 것 | CLI 로그 (`cli exec:` / live session) | 답 | 반영 |
| --- | --- | --- | --- | --- | --- |
| P0 | 새 세션 c03, 채널 프롬프트 없음 (`Reply with exactly: READY`) | GroupSystemPrompt 0자 | `useResume=false session=none reuse=none`, `--session-id f26651f8…`, live session start | `READY` | — (기존 세션 만들기) |
| P1 | `config.set`(AMBER, `applied:"live"` 75ms) 뒤 **같은 세션 다음 턴** | GroupSystemPrompt 113자 | `useResume=true session=present reuse=reusable-drift:system-prompt`, `--resume f26651f8…`, **새 live session start**, promptChars 760(드리프트 안내문 포함 — 표 아래) | 「코드 워드는 받은 적이 없습니다… READY 라고 답하라는 요청만」(메모리 검색 툴 1회 호출) | **안 됨** |
| P2 | WS `sessions.reset {key, agentId, reason:"reset"}`(admin, 성공) 뒤 같은 질문 | GroupSystemPrompt 113자(AMBER) | `useResume=false session=none reuse=none`, `--session-id 274820f3…`(새 CLI 세션) | `AMBER` | **됨** |
| P3 | `config.set`(COBALT) → **dev Gateway 프로세스 종료·재기동**(SIGTERM 750ms, 기동 4.7초, 플러그인 재접속 307ms, 관찰 연결 재접속) 뒤 같은 질문 | GroupSystemPrompt 114자(COBALT) | `useResume=true reuse=reusable-drift:system-prompt`, `--resume 274820f3…`, 새 live session start, promptChars 760 | `AMBER` (옛 값) | **안 됨** |
| P4 | 채널 설정 그대로(systemPrompt=COBALT, CLI 스냅샷=AMBER), `inboundChannelPrompt:"prefix"` + 인바운드 channelPrompt=DAHLIA | GroupSystemPrompt 114자 + 헤더 줄 `채널 프롬프트: …DAHLIA…` | `useResume=true reuse=reusable`, promptChars 756 | `DAHLIA` | **됨** |
| P5 | 같은 조건, `inboundChannelPrompt:"context"` + channelPrompt=EMBER | GroupSystemPrompt 114자 + `ChannelPromptContext` 1항목 | `useResume=true reuse=reusable`, **웜 프로세스 재사용**(live session start 없음), promptChars 780 | `EMBER` | **됨** |
| P6 | `config.set`(FJORD) 뒤 **세션 키 세대 회전** `…:c03:g2` | GroupSystemPrompt 113자(FJORD) | `useResume=false session=none`, `--session-id 06e4dfd4…`, activeSessions=2 | `FJORD` | **됨** |

- 드리프트 안내문: P1·P3 의 promptChars 가 P0/P2 보다 정확히 「질문 길이 차 + 128」 크다. 128 = `OpenClaw resumed this CLI session after prompt content changed. Follow the current turn's instructions; changed=system-prompt.` + 빈 줄
  (`cli-session-*.mjs` `buildCliSessionDriftNote`). Claude CLI 전사에서도 그 문장으로 시작하는 사용자 메시지가 확인된다.
- `cli argv:` 에는 P0~P6 어디에도 시스템 프롬프트 플래그가 없다. claude-cli 는 플러그인 소유 실행(`anthropic/cli.runtime.js`)이라 argv 가 아니라 stdio `initialize` 요청의
  `appendSystemPrompt` 로 넘기기 때문이다 — 로그 argv 로는 전송 여부를 판정할 수 없다.

### 3.2 원인 — OpenClaw 는 다시 보내고, Claude CLI 는 스냅샷으로 재개한다

**OpenClaw 쪽 (코드, 2026.9.4 번들)**

1. 턴마다 `get-reply` 가 `GroupSystemPrompt` 를 `extraSystemPromptParts`·`extraSystemPromptStatic` 에 넣고, 그 해시가 CLI 세션 바인딩의 `extraSystemPromptHash` 와 다르면
   `resolveCliSessionReuse` 가 `reuse-with-drift` 를 낸다(로그 `reusable-drift:system-prompt`). claude-cli 백엔드 설정은 `systemPromptFileArg:"--append-system-prompt-file"`,
   `systemPromptWhen:"always"` 라 `canTransportSystemPrompt` 가 참 → 세션을 무효화하지 않고 **재개 + 재전송** 경로로 간다.
2. 라이브 세션 지문(`buildCliLiveSessionFingerprint`)에 `extraSystemPromptHash` 가 들어 있어 지문이 바뀌고, `executeClaudeCli` 는 기존 프로세스를 재시작한 뒤 새 transport 의
   `initialize({ appendSystemPrompt: context.systemPrompt })` 로 **현재 시스템 프롬프트 전체**를 보낸다(P1·P3 의 「live session start」). 사용자 턴 앞에는 드리프트 안내문을 붙인다.

**Claude CLI 쪽 (관찰)** — `~/.claude/projects/-Users-jang2162--openclaw-dev-workspace/<cliSessionId>.jsonl`(문자열 개수만 확인):

| CLI 세션 | 만든 턴 | 전사 안 `prompt_snapshot` 첨부 | `secret code word` / AMBER / COBALT (P3 직후에 셈) |
| --- | --- | --- | --- |
| `f26651f8…` | P0(프롬프트 없음), P1 은 `--resume` | 세션 생성 때만 | 0 / 0 / 0 — P1 의 AMBER 가 어디에도 없다 |
| `274820f3…` | P2(AMBER), P3·P4·P5·W 는 `--resume` | 2건, 둘 다 P2 중 기록. `attachment.systemPrompt[9]` 에 `…Address the specific sender noted in the message context.\n\nIn this channel the secret code word is AMBER…`(시스템 프롬프트 23,338자) | 2 / 4 / **0** — P3 의 COBALT 는 스냅샷에도 전사에도 없다 |

즉 **Claude CLI 는 세션을 만들 때 시스템 프롬프트를 `prompt_snapshot` 으로 전사에 남기고, `--resume` 턴에서는 새 스냅샷을 만들지 않았다.** 모델 답(P1 모름, P3 옛 AMBER)과 합치면
`initialize.appendSystemPrompt` 의 변경은 재개된 세션에 쓰이지 않는다고 보는 것이 가장 단순한 설명이다. Claude CLI 내부 코드는 보지 않았으므로 **「관찰로 강하게 뒷받침되는 추정」** 으로 둔다.
Gateway 재시작(P3)이 아무것도 바꾸지 못한 것은 이 설명과 맞는다 — 문제는 Gateway 의 라이브 프로세스가 아니라 CLI 세션 자체다(ADR 0002 8절의 「warm subprocess 재사용 추정」은 틀렸다).

P3 에는 교란 요인이 하나 있다 — 전사에 P2 의 답 `AMBER` 가 있었다. 그러나 P1 은 그런 이력이 없는데도(READY 뿐) 반영되지 않았으므로 결론은 같다.

### 3.3 인바운드 경로가 남기는 흔적 — (b) 프리픽스와 `ChannelPromptContext`

| | (b) 프리픽스 (P4) | `ChannelPromptContext` (P5) |
| --- | --- | --- |
| OpenClaw 전사(`session.message`·`chat.history`) 사용자 메시지 | **헤더 안에 그대로 남는다** — `[dodok context] …\n릴레이 규칙: …\n채널 프롬프트: In this channel … DAHLIA …\n---\n@dev What is the code word?…` | **남지 않는다** — 헤더·본문만(`채널 프롬프트` 줄 없음). `chat.history` 에서 이 메시지만 `__openclaw.importedFrom` 이 비어 있었다(CLI 전사와 본문이 달라 가져오기 매칭이 안 된 것으로 보인다) |
| Claude CLI 전사(= 다음 턴부터 모델 컨텍스트) | 사용자 메시지 본문에 들어간다 | 사용자 메시지에 `Context: ⟦openclaw:ctx⟧\n채널 프롬프트: …EMBER…` 블록으로 **들어간다** — 인바운드 메타 JSON 블록 뒤 |
| 코어의 취급 | 사용자 발화 | `buildReplyPromptEnvelope` 가 `kind:"conversation-data"` 로 현재 인바운드 컨텍스트에 붙인다. 타입 주석: 「Channel-provided metadata that must not be treated as system instructions」 |
| promptChars | 756 | 780 |

두 경로 모두 **토큰은 매 턴 들고 모델 컨텍스트에 누적된다**. 차이는 OpenClaw 표시 전사를 오염시키는가(b 만)와 권위(사용자 발화 vs 비신뢰 메타데이터)다.
이번 질문은 사실 회상(코드워드)이라 「지시로서 따르는가」의 차이는 재지 못했다(9절).

### 3.4 세부 실물

- **`sessions.reset` 응답**: `{ ok:true, key, entry:{ sessionId, lifecycleRevision, sessionStartedAt, systemSent:false, compactionCount:0, createdVia:"channel", createdActor, delivery:{kind:"external", route, context, origin}, … } }`. **`sessionId` 는 리셋 전후 같다**(c03 base 는 P0·P2·H 전부 동일, c04 도 두 번의 리셋 전후 동일 — `q1-p2p3.json` `.turns[0].setup[0].sessionsReset.response.entry.sessionId`, `q2ti-q3h.json` `sessions.list`). 바뀌는 것은 `sessionStartedAt`(리셋 시각; `createdAt` 과 다름)·`lifecycleRevision`·`systemSent:false` → 서버의 리셋 판별과 7.1 의 「세션이 시작될 때의 리비전」 추적은 `sessionId` 가 아니라 `sessionStartedAt`/`lifecycleRevision` 으로 한다.
  메서드 스코프는 `operator.admin`(`method-scopes-*.mjs`). 리셋 뒤 OpenClaw 전사 첫 항목은 `role:"system"` `"Reset"`(`__openclaw.seq:1`)이고 이전 메시지는 표시 전사에서 빠진다.
  CLI 바인딩이 비어 다음 턴이 새 CLI 세션이 된다(P2 `session=none`).
- **dev CLI 대체 경로**: `openclaw sessions` 에는 `reset` 하위 명령이 없다(`archive`·`cleanup`·`compact`·`delete`·`export-trajectory`·`list`·`tail`). 러너는 WS 가 거절되면
  `openclaw --dev gateway call sessions.reset --url … --params …` 로 대체하게 했으나 WS 가 성공해 쓰이지 않았다.
- **키 회전(P6)**: OpenClaw 는 `agent:dev:dodok:channel:<id>:g2` 를 별도 세션으로 받았다(`routeSessionKey` 그대로, `sessions.list` 에 별도 행, `sessionId` 별도).
  `displayName` 등은 base 와 같은 채널 라벨을 쓴다. 이전 세대 세션은 목록에 남는다.

## 4. 질문 2 — `ToolInputError` 가 모델에게 보이는가

| 확인 | 결과 |
| --- | --- |
| T1 모델 런 (c04 새 세션, `Send me a message with SIX buttons in one action row using the components field.`) | **툴을 부르지 않았다** — `agent` `stream:"tool"` 이벤트 0건, 플러그인 `tool-send` 로그 0줄, MCP `tools/call` 0회. 최종 텍스트: 「이건 못 보내요. components 스키마에서 `actions` 블록 하나에 들어가는 항목은 최대 5개라서… 1) 5개+1개 두 줄 2) select 하나」 + 「이 채널은 inline buttons가 꺼져 있다고 나와요… `dodok.capabilities.inlineButtons`」 |
| (a) 툴 결과에 원문이 실리는가 | **미관찰**(호출이 없었다). 코드상(`mcp-http-*.mjs` `tools/call`): 툴이 던지면 `{ content:[{type:"text", text: formatErrorMessage(err)}], isError:true }` — 이름과 무관하게 **원문이 모델에게 간다**(네트워크 툴만 보호 래핑) |
| (b) 스스로 5개로 고쳐 재시도하는가 | 호출 전에 스키마를 보고 스스로 제약을 지켰다 — 고칠 기회 자체가 없었다 |
| (c) 최종 아웃바운드 | `deliver` 최종 텍스트 1건(위 거절 문장). components 없음 |
| TI `tools.invoke` (런 없음, 같은 인자) | `{ ok:false, toolName:"message", error:{ code:"internal_error", message:"components: v1 스키마 위반 — blocks.0.items Too big: expected array to have <=5 items" } }`. 스파이크 2 의 `tool execution failed` 에서 **원문으로 바뀌었다**(코드상 내부 결과는 status 400 `tool_error` — `tools-invoke-shared-*.mjs` `resolveToolInputErrorStatus`. RPC 봉투의 `code` 는 여전히 `internal_error`). 플러그인 로그 `tool-send … "ok":false,"error":"components: v1 …"`, outbound 0건 |

**부수 관찰 — 코어 시스템 프롬프트의 버튼 힌트.** 모델이 말한 「inline buttons 꺼짐」은 코어가 message 툴 절에 넣는
`- Inline buttons OFF for dodok; ask owner for dodok.capabilities.inlineButtons=dm|group|all|allowlist.`(`system-prompt-params-*.mjs`)다. 우리 `describeMessageTool` 이
`capabilities: []` 라 코어는 「이 채널은 버튼 불가」라고 안내하면서 동시에 우리 `components` 스키마 조각은 버튼을 받는다 — **모델이 받는 신호가 서로 어긋난다**.
ADR 0002 12.2(components 노출 방식) 판정 때 `presentation`/inline buttons capability 선언과 함께 봐야 한다.

## 5. 질문 3 — `chat.history` 커서 실물

파라미터(`ChatHistoryParams`): `sessionKey`(필수), `agentId`, **`cursor`**(요청 이름은 `deltaCursor` 가 아니다), `limit`, `maxBytes`, `offset`, `pendingBefore`, `inputRunIds`, `messageId`, `sessionId`, `maxChars`.
`cursor` 는 `offset`·`messageId` 와 함께 쓸 수 없다(`INVALID_REQUEST`).

### 5.1 커서 없는 호출의 응답

| 세션 종류 | 최상위 필드 |
| --- | --- |
| claude-cli 에 묶인 세션(c03 base·`:g2`·T1 뒤 c04) | `sessionKey, sessionId, messages, pendingInputs, hasMore, totalMessages, `**`completeSnapshot:true`**`, defaults, sessionInfo` — **`deltaCursor` 없음** |
| CLI 바인딩이 없는 세션(리셋 뒤 c04) | `sessionKey, sessionId, messages, pendingInputs, `**`deltaCursor`**`(187자), hasMore, totalMessages, defaults, sessionInfo` |

메시지 항목은 **전사 메시지 그 자체**다 — `{ role, content, timestamp, idempotencyKey?, stopReason?/usage?/model?…, __openclaw }`. **최상위 `messageSeq` 는 없고 `__openclaw.seq`** 에 있다.
사용자 메시지의 `__openclaw` 키: `senderIsOwner, senderId, senderName, senderIdentity, transport{channel, conversationRef, messageId}, id, idempotencyKey, recordTimestampMs, transcriptPosition{source, rawSeq}, seq, importedFrom:"claude-cli", externalId, cliSessionId`.
claude-cli 세션의 표시 전사는 **CLI 세션 전사에서 가져온 것**(`importedFrom:"claude-cli"`)이다. `defaults`: `{ modelProvider, model, contextTokens, agentRuntime:{id:"claude-cli",…}, modelSelectionTarget }`. `pendingInputs: {items:[], total:0}`.
이번에 진행 중인 런이 없어 `inFlightRun` 은 관찰하지 못했다(스키마상 커서 결과·일반 결과 모두에 있다).

### 5.2 커서 호출

| 순서 (CLI 바인딩 없는 c04, 모델 런 없이 `chat.inject` 로 한 줄씩 추가) | 결과 |
| --- | --- |
| `sessions.reset` → 커서 없이 호출 | `messages:[system "Reset"]`, `deltaCursor` = c0 |
| c0, 변화 없음 | `{ kind:"delta", messages:[], deltaCursor:c0(같은 값), pendingInputs, sessionInfo }` |
| `chat.inject` 1 → c0 | `kind:"delta"`, 1건, **새 커서 c1** |
| `chat.inject` 2 → c1 | `kind:"delta"`, 1건(2번째만) |
| 옛 c0 다시 | `kind:"delta"`, 2건(누적) — 커서는 소비되지 않는다 |
| c0 + `limit:1` | `kind:"delta"`, 2건 — **`limit` 은 커서 호출에서 무시된다** |
| c0 끝 4글자 변조 | `{ kind:"reset" }` (다른 필드 없음) |
| 엉터리 문자열 | `{ kind:"reset" }` |
| claude-cli 세션에 아무 커서 | `{ kind:"reset" }` |

delta 항목은 표시 전사 메시지가 아니라 **`session.message` 이벤트와 같은 봉투**다 — `{ sessionKey, agentId, message, messageId, `**`messageSeq`**`, session, sessionId, … 세션 행 필드 70여 개 }`.
`chat.inject` 한 줄은 `role:"assistant"`, 본문 `[<label>]\n\n<message>` 로 들어갔다.

### 5.3 원인 (코드, `chat-history-handler-*.mjs`)

- 커서 호출에서 `!sessionId || !storePath || resolveClaudeCliBindingSessionId(entry)` 면 **곧바로 `{kind:"reset"}`** — CLI 바인딩이 있는 세션은 증분 대상이 아니다.
  첫 응답의 `deltaCursor` 도 `transcriptSource === "active"` 일 때만 실린다 — claude-cli 세션은 CLI 전사 가져오기 경로(`resolveChatHistoryWithCliSessionImports`, 응답 `completeSnapshot`)라 실리지 않는 것으로 보인다.
- 그 밖의 reset 조건(`readChatHistoryDelta`): 페이지가 `hasMore`, 구간에 `reset`/`compaction` 이벤트, 200 이벤트 초과, 1MB 초과(`maxBytes` 와 작은 쪽), 어시스턴트 오류 투영 대기, 스트림 폴백 세그먼트.

## 6. 질문 4 — `chat.send` 대체 경로

관찰 연결(admin)에서 c03 base 세션으로 보냈다.

| | W1 | W2 |
| --- | --- | --- |
| 파라미터 | `sessionKey, agentId, message:"@dev Reply with exactly: VIA-WS", idempotencyKey, originatingChannel:"dodok", originatingTo:"channel:<c03>", originatingAccountId:"default", deliver:true` | 같되 `originating*` 없이 `deliver:true` |
| 응답 | `{ runId, status:"started" }` (9ms) | 같음 (3ms) |
| (a) 플러그인 아웃바운드 | **옴** — `outbound.attachedResults.sendText` 경로(플러그인 로그 `dodok:outbound-sendText`), `outboundId:"dodok-out-…"`, **`agentId:"unknown"`, `sessionKey:"agent:unknown:dodok:channel:<c03>"`, `runId` 없음**, text `VIA-WS` | **옴** — 같은 모양, text `VIA-WS-2` |
| (b) `chat` final | 보낸 연결에 옴(`runId` 일치, `VIA-WS`) | 옴 |
| (c) 둘 다 | **둘 다** | **둘 다** |
| CLI | `reuse=reusable-drift:system-prompt,prompt-tools`, 새 live session, promptChars 413 | `reuse=reusable`, promptChars 274 |
| MCP 루프백 | `senderIsOwner:true, toolCount:45, cronVisible:true` | (새 프로세스 없음) |
| 전사 사용자 메시지 | `@dev Reply with exactly: VIA-WS` — dodok 컨텍스트 헤더 없음 | 같음 |

원인 (코드, `chat-origin-routing-*.mjs`·`chat-send-handler-*.mjs`):

- `originating*` 가 하나라도 있으면 `originatingChannel`·`originatingTo` 둘 다 필수이고 **`operator.admin` 이 없으면 `originating route fields require admin scope`** 로 거절한다.
- 명시 경로도 **`explicitDeliverRoute = deliver === true`** 다 — `deliver` 없이 `originating*` 만 주면 배달 경로로 쓰이지 않는다.
- `originating*` 없이 `deliver:true` 면 세션의 `deliveryContext`(`{channel:"dodok", to:"channel:<id>", accountId}`, 플러그인 인바운드가 세션을 만들 때 기록)를 상속한다 —
  키 모양이 `…:dodok:channel:…`(channel-scoped)라 조건을 통과한다. W2 가 그 경로다. `deliver` 자체에는 admin 검사가 없다(코드상; 이번 연결은 admin 이라 실측 구분은 못 했다).
- 배달은 채널 아웃바운드 어댑터(`sendText`)로 가고, `ChannelOutboundContext` 타입에는 `cfg, to, text, media…, replyToId, threadId, accountId, identity, deliveryQueueId…` 만 있다 —
  **agentId·sessionKey·runId 가 없다.** 그래서 플러그인이 `unknown` 을 채웠다(ADR 0002 11.4 의 「sendText 폴백이 언제 불리는가」 답: WS `deliver:true` 턴).
- operator 연결에서 온 턴은 발신자가 owner 로 판정돼 툴 표면이 넓어진다(채널 인바운드 턴은 `senderIsOwner:false, toolCount:32, cronVisible:false`). 그 차이가 `prompt-tools` 드리프트다.

## 7. 설계 결론 (초안)

### 7.1 채널 프롬프트 주입 경로

전제: 1차 연동 백엔드가 claude-cli 인 한, **GroupSystemPrompt 는 「CLI 세션 시작 시점의 값」** 이다. OpenClaw 가 고치기 전까지(9절 업스트림) 바꿀 수 있는 것은 새 세션뿐이다.

| 안 | 반영 | 대가 |
| --- | --- | --- |
| (a) 설정 `systemPrompt` 만 | 새 세션에만 | 기존 세션은 조용히 옛 프롬프트로 돈다 — **단독으로는 부적합** |
| (a) + 변경 시 `sessions.reset` | 다음 턴부터 | 에이전트의 세션 기억(툴 결과·긴 대화)이 사라진다, `operator.admin` 필요, 채널에 에이전트 N명이면 N번 |
| (a) + 변경 시 키 세대 회전 | 다음 턴부터 | 기억 소실은 같다, admin 불필요, 세대가 쌓여 세션 목록·서버 매핑이 는다 |
| (b) 프리픽스 매 턴 | 매 턴 | 표시 전사 오염(사용자 발화로 남음), 토큰 누적 |
| (c) `ChannelPromptContext` 매 턴 | 매 턴 | 토큰 누적은 (b)와 같음, 표시 전사는 깨끗, 「비신뢰 메타데이터」 라벨이라 지시 권위는 미측정 |

**권고: (a) 를 기준선으로 유지하고, 서버가 세션별로 「그 세션이 시작될 때의 채널 프롬프트 리비전」을 기억해 현재 리비전과 다르면 인바운드에 (c) 로 현재 채널 프롬프트를 싣는다.**
새 세션(첫 턴·리셋·회전 뒤)은 (a) 가 이미 담고 있으니 싣지 않는다. 「새 대화」 명령(계획서 5.8)의 `sessions.reset` 은 기억을 버리고 (a) 로 수렴시키는 사용자 행위로 둔다.
근거는 P4·P5 — 낡은 시스템 프롬프트(AMBER)·설정(COBALT)·이전 프리픽스(DAHLIA)가 섞여 있어도 최신 인바운드 값이 이겼다. (b) 대신 (c) 인 이유는 표시 전사를 오염시키지 않아서다.
에이전트별 오버라이드(`promptOverride`)도 같은 이유로 헤더 줄 대신 (c) 로 옮길지 함께 정한다(10절).

주의: 이 권고는 **사실 회상** 실험에 기댄다. 채널 프롬프트가 행동 규칙(말투·금지 사항)일 때 (c) 의 권위가 시스템 프롬프트만큼인지는 따로 재야 한다.
API 프로바이더 백엔드는 드리프트 재전송이 실제로 먹힐 수 있어 결론이 달라질 수 있다(9절).

### 7.2 재접속 복구에 `deltaCursor` 를 쓸 수 있는가

**claude-cli 세션에서는 쓸 수 없다**(커서가 안 오고, 줘도 reset). 따라서 서버의 재접속 복구는 「`sessions.list` → 선택 세션 `chat.history`(limit) **전체 치환**」을 기본 경로로 하고,
응답에 `deltaCursor` 가 있으면 저장했다가 다음 재접속에 `cursor` 로 먼저 시도해 `kind:"reset"` 이면 전체 치환으로 떨어지는 **최적화**로만 둔다.
커서 호출에서는 `limit` 이 무시되므로 크기 상한은 `maxBytes`(서버 상한 1MB)로 건다. 메시지 순서 키는 일반 응답 `__openclaw.seq`, delta 봉투 `messageSeq` 로 모양이 다르다.
실제로는 **dodok 서버 DB 가 메시지의 정본**(플러그인 경로 + 아웃바운드 큐)이라 `chat.history` 는 「끊긴 동안 OpenClaw 에서만 일어난 것」을 보는 보조 수단이다.

### 7.3 대체 경로(`chat.send` + `originating*`/`deliver`)의 가치

**MVP 에서 쓰지 않는다.** 배달은 되지만 (1) 플러그인 아웃바운드에 agentId·runId 가 없어 WS `chat` final 과 dedupe 할 키가 없고,
(2) operator 발신 턴이 owner 권한·넓은 툴(cron 포함)로 돌며, (3) dodok 컨텍스트 헤더가 없고, (4) 세션에 `prompt-tools` 드리프트를 일으킨다.
플러그인 인바운드가 막혔을 때의 비상 경로가 필요하면 **`deliver` 없이 `chat.send` 만** 보내고 서버가 WS `chat` final 을 자기 메시지로 쓰는 편이 상관관계(runId = idempotencyKey)가 온전하다
(owner 권한 문제는 그대로 남는다).

## 8. 계획서·스펙·구성 문서에서 고쳐야 할 것

위치는 `파일:줄`(이 브랜치, main `646904e` 기준). `plan.md` = `docs/plan.md`, `구성.md` = `docs/project-structure.md`, `스펙.md` = `docs/superpowers/specs/2026-09-14-shared-contracts-design.md`.

| 위치 | 지금 | 실측 | 근거 |
| --- | --- | --- | --- |
| `plan.md:89` | `chat.history` 파라미터 `cursor` … 「`deltaCursor`로 증분 캐치업(`{kind:"delta"}` 또는 `{kind:"reset"}`)」 | 요청 파라미터는 `cursor`, 응답 필드가 `deltaCursor`. **claude-cli 세션은 커서가 오지 않고 커서 호출은 늘 `reset`**. 커서 호출에서 `limit` 무시. 일반 응답 메시지는 전사 메시지(`__openclaw.seq`), delta 항목은 `session.message` 봉투(`messageSeq`) | 5절 |
| `plan.md:91` | 「`deltaCursor` 증분은 미확인 — 스파이크 3으로 이월」 | 확인 끝 — 위 행. 재접속 복구는 전체 치환 기본 + 커서 최적화 | 5·7.2 |
| `plan.md:183` (4.2 표) | 세션 히스토리 복구 「✅ `chat.history` + `deltaCursor`」 | `chat.history` 전체 치환(claude-cli), 커서는 CLI 바인딩 없는 세션에서만 | 5 |
| `plan.md:200` (4.4) | 「선택 세션 `chat.history` 치환 → `inFlightRun` 채택」 | 치환은 맞다. `inFlightRun` 은 `chat.history` 응답 필드(스키마) — 이번엔 진행 중 런이 없어 미관찰 | 5.1 |
| `plan.md:88` | `originating*` 는 「응답을 우리 플러그인으로 배달시키는 열쇠… Phase 0에서 검증」 | 배달의 열쇠는 **`deliver:true`**. `originating*` 는 admin 스코프 필요·`deliver` 없으면 배달 경로 아님. channel-scoped 세션은 `deliver:true` 만으로 세션 `deliveryContext` 상속. 배달은 `sendText`(agentId·runId 없음), 턴은 owner 권한 | 6 |
| `plan.md:177` (4.2 표) | 사용자 메시지 → 에이전트 대체 경로 `chat.send` + `agentId` + `originatingChannel:"dodok"` | 위 행과 같다 — MVP 에서 쓰지 않음 권고(7.3) | 6·7.3 |
| `plan.md:415` (8장) | 대체 경로 확인 항목 | 완료 — ADR 0003 6절 | 6 |
| `plan.md:234` (5.2) | 「(a)가 … **세션 시스템 프롬프트에 안정적으로 들어가므로** 기본안」 | claude-cli 에서는 **CLI 세션 시작 시점에만** 들어간다. 드리프트·Gateway 재시작으로 갱신되지 않는다. 기존 세션 반영은 리셋·키 회전 또는 인바운드 (b)/(c) | 3 |
| `plan.md:236` (5.2) | 「기존 세션 갱신(`sessions.reset`·재시작·다른 백엔드)은 스파이크 3의 첫 과제」 | 리셋 = 반영, 재시작 = 미반영, 다른 백엔드 = 미측정. 원인은 Claude CLI `prompt_snapshot` 재개(추정) | 3.1·3.2 |
| `plan.md:322` (5.8) | 「"새 대화" 명령은 `sessions.reset`」 | 맞다. **`operator.admin` 스코프 필요**(dev 루프백은 공유 토큰으로 부여, 원격 미확인). 리셋 뒤 표시 전사는 `system "Reset"` 부터 | 3.4 |
| `plan.md:414` (8장) | 스파이크 3 「반영 지연·재시작 필요 여부 확인. 실패 시 (a-2) 또는 (b)」 | 완료. (a-2)(WS 설정 메서드)도 같은 GroupSystemPrompt 라 기존 세션 문제를 풀지 못한다 — 대안은 (c)/(b)/리셋·회전 | 3·7.1 |
| `plan.md:473` (10장 결정 #1) | 「채널별 `systemPrompt` 설정을 기본 … Phase 0에서 확인」 | 확인 끝 — 7.1 권고로 재판정 필요(10절 1) | 7.1 |
| `plan.md:452~` (9장 위험표) | 채널 프롬프트 행 없음 | 추가 제안: 「claude-cli 재개 세션이 채널 프롬프트 변경을 무시 → 에이전트가 옛 규칙으로 답함」 / 대응: 리비전 추적 + (c) 동봉, 업스트림 보고 | 3 |
| `plan.md:84` (3.1 인증) | 첫 `connect` 는 `NOT_PAIRED`, 공유 토큰이면 수 초 뒤 자동 승인 | 원격 관찰(ADR 0001)은 그대로. **dev 루프백 + 공유 토큰은 거절 없이 붙고 `hello.auth.method:"token"`, 요청한 `operator.admin` 까지 부여, 디바이스 토큰 미발급** — 원격과 조건 차이를 명시 | 2 |
| `구성.md:111` | `config-sync.ts`: 「채널 프롬프트 변경 → … 플러그인이 Gateway 설정 갱신 → 반영 확인」 | 「반영 확인」은 설정 스냅샷까지만 뜻한다. 세션 반영은 서버가 리비전을 추적해 (c) 동봉 또는 리셋을 정해야 한다 | 3·7.1 |
| `구성.md:120~121` | `channel.ts` 채널별 설정 스키마(requireMention, systemPrompt, users, botLoopProtection) | 스파이크 3 에서 `inboundChannelPrompt`(prefix\|context) 추가 — Phase 1 에서 존치·계약 이동 여부 결정(10절 5). `users` 는 스키마에 없다(원안부터) | 2.1 |
| `구성.md:125~126` | `config-writer.ts` 「반영은 live 이나 claude-cli 기존 세션엔 미반영 — 스파이크 3 과제」 | 과제 완료 — 원인과 대안은 ADR 0003 3·7.1 | 3 |
| `구성.md:127` | `context.ts` 「최근 채널 메시지 N개 + 참여자 목록 + 릴레이 규칙 요약」 | + `placeChannelPrompt`(채널 프롬프트를 헤더 줄 또는 `ChannelPromptContext` 로) | 2.1 |
| `구성.md:102` | `sessions.ts` 세션 키 매핑 `agent:<agentId>:dodok:channel:<channelId>` | 키 회전을 채택하면 `:g<N>` 세대 접미사(플러그인은 이미 수용) | 3.4·7.1 |
| `구성.md:207` | 개발 순서 4 「채널 프롬프트 설정 갱신을 … 반영·확인 (스파이크 3)」 | 완료 표시 + 결론 한 줄 | 3 |
| `스펙.md:803` (8.3) | 「`channelPrompt`는 `config.set`으로 이미 Gateway 설정에 들어가 있으면 생략하고, 설정 경로가 불가하면 프리픽스」 | 설정 경로는 **새 세션에만** 된다 — 「세션이 시작될 때의 리비전과 다르면 `ChannelPromptContext` 로 동봉」(7.1 판정 뒤 문구 확정). `InboundContext` 에 리비전 필드가 필요할 수 있다 | 3·7.1 |
| `스펙.md:947` (11절 #5) | 「부분 확정 … claude-cli 기존 세션 미반영 — 스파이크 3에서 확정」 | 확정: `applied:"live"` 는 설정 스냅샷 기준. claude-cli 기존 세션은 드리프트·재시작으로도 미반영, 리셋·새 키에서만 반영 | 3 |
| `스펙.md:949` (11절 #7) | 「미확인 — 스파이크 3에 얹을 수 있다」 | 확정: `deliver:true` 로 배달됨(sendText, 상관관계 없음), `originating*` 는 admin 필요. 기본값 「미사용」 유지 권고 | 6·7.3 |
| `CLAUDE.md:43` | 「다음: 스파이크 3 …」 | 스파이크 3 완료(ADR 0003) — Phase 0 종료, 결정 대기 목록 갱신 | — |
| ADR 0001 `:433`, `:447~448` | 「재접속 캐치업은 `chat.history` 의 `deltaCursor` 로 해야 한다」, 복구는 `sessions.list` + `chat.history` | 복구 조합은 맞다. 캐치업 수단으로 `deltaCursor` 는 claude-cli 세션에서 성립하지 않는다(ADR 0003 5절) — ADR 은 기록이므로 계획서 쪽을 고친다 | 5 |
| ADR 0002 8절 끝 | 「warm subprocess 재사용 쪽 문제로 추정」 | 틀렸다 — Gateway 재시작 뒤에도 미반영, CLI 세션 `prompt_snapshot` 쪽(ADR 0003 3.2) | 3.2 |

## 9. 남은 질문

1. **API 프로바이더 백엔드**(claude-cli 가 아닌 `anthropic` 등)에서 드리프트 재전송이 기존 세션에 먹히는가. 사용자 API 키를 쓰지 않기로 해 재지 않았다. 결과에 따라 7.1 의 (c) 동봉을 「claude-cli 한정」으로 좁힐 수 있다.
2. **Claude CLI 가 `--resume` 시 `initialize.appendSystemPrompt` 를 버리는지 코드로 확정**하지 못했다(바이너리 내부). OpenClaw 에 「claude-cli 에서는 system-prompt 드리프트를 `invalidate`(히스토리 재주입 새 세션)로 처리」를 요청할 가치가 있다 — 업스트림 이슈 후보(10절 6).
3. `ChannelPromptContext`/프리픽스가 **행동 지시**(말투·금지 규칙)로서 시스템 프롬프트만큼 따라지는가 — 사실 회상만 쟀다.
4. 모델 런에서 `ToolInputError` 원문이 실제로 모델에게 보이고 모델이 고치는가 — JSON 스키마로 표현되지 않는 규칙(교차 필드 등)을 어기게 해야 관찰할 수 있다. 코드상은 원문 `isError:true`.
5. 원격 Gateway 에서 공유 토큰이 `operator.admin` 을 주는가(dev 루프백은 줬다) — `sessions.reset`·`originating*` 가 원격 서버 연결에서 가능한지가 여기에 달렸다.
6. `inFlightRun` 실물(진행 중 런이 있을 때의 `chat.history`), 그리고 CLI 바인딩 없는 세션이 claude-cli 런을 한 번 돌면 커서가 끊기는지(코드상 reset) — 실측 안 함.
7. `deliver` 에 admin 이 필요 없는지(코드상 불필요) — admin 연결로만 보냈다. `sendText` 의 `identity` 필드로 에이전트를 식별할 수 있는지.
8. 코어 시스템 프롬프트의 「Inline buttons OFF for dodok」 힌트가 components 사용률에 주는 영향 — B1(스파이크 2)은 첫 시도에 채웠지만 이번 T1 은 그 힌트까지 언급했다.
9. `~/.openclaw-dev` 에 이번 흔적이 남아 있다: `channels.dodok.channels.<c03>.systemPrompt`(FJORD 문구), 세션 c03·`c03:g2`·c04(c04 는 리셋 2회 + `chat.inject` 3회 — 1차 H 1회, 2차 H 2회; 표시 전사에는 마지막 리셋 뒤 2줄만 보인다), Claude CLI 전사 파일들. 다음에 이 dev 프로필을 쓸 때 채널 설정을 `config unset` 으로 지우고 시작한다.

## 10. 결정 필요

1. **채널 프롬프트 주입 경로**(ADR 0002 12.5 의 판정): 권고는 (a) 기준선 + 리비전 불일치 시 (c) `ChannelPromptContext` 동봉(7.1). 대안은 변경 시 리셋 또는 키 회전(기억 소실), (b) 매 턴(전사 오염).
2. **「새 대화」와 프롬프트 변경 시 리셋 정책**: 서버 Gateway 연결에 `operator.admin` 을 요청할지(리셋·`originating*` 에 필요) — 권한 최소화와 충돌한다.
3. **재접속 복구 설계**: `chat.history` 전체 치환 기본 + 커서 최적화(7.2)로 확정할지.
4. **대체 경로**: MVP 미사용(7.3)으로 확정할지. 쓴다면 `deliver` 없이 WS final 만.
5. **플러그인 `inboundChannelPrompt` 설정 키**: 스파이크용으로 추가했다. Phase 1 에서 (i) 채널 설정으로 존치, (ii) 브리지 계약(`InboundContext` 에 주입 지시·리비전)으로 옮김, (iii) 제거 중 택일.
6. **업스트림 보고**: claude-cli 드리프트가 재개 세션에 반영되지 않는 문제를 OpenClaw 에 이슈로 올릴지(재현 절차는 3.1 표 P0→P1).
7. **세션 키 세대 접미사 `:g<N>`**: 7.1 에서 회전을 쓰지 않으면 플러그인의 수용 코드를 되돌릴지.

### 확정 (2026-09-15, `docs/plan.md` 10장)

| 항목 | 결정 | 계획서 |
| --- | --- | --- |
| 1 주입 경로 | (a) 기준선 + 서버가 리비전 불일치 때만 `context.channelPrompt` 를 채우고 플러그인은 `ChannelPromptContext` 로. `promptOverride` 도 같은 자리 | #1 |
| 2 리셋 정책 | 서버 연결에 `operator.admin` 요청, 「새 대화」= `sessions.reset`. 원격 부여 여부는 Phase 1 첫 작업에서 확인, 거부 시 회전 폴백 → **원격 실측(2026-09-15): 부여**(`grantedScopes` 에 `operator.admin` 포함, `sessions.reset` → `resetOutcome: ok`) | #15 |
| 3 재접속 복구 | 전체 치환 기본 + 커서 최적화(7.2) | #16 |
| 4 대체 경로 | MVP 미사용(7.3) | #17 |
| 5 `inboundChannelPrompt` | 제거 — 값이 있으면 항상 `ChannelPromptContext` | #18 |
| 6 업스트림 보고 | 보류 | #20 |
| 7 `:g<N>` | 플러그인 수용 코드 제거 | #19 |
