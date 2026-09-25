# ADR 0006 — 스레드 하위 세션 스파이크 (Phase 4 스레드·검색 설계의 근거)

- 상태: 완료 (실측, 로컬 dev Gateway, **모델 런 0회**) — 스레드 스펙이 7절 「설계에 주는 제약과 추천」을 입력으로 받는다
- 날짜: 2026-09-25
- 대상: `docs/plan.md` 「5.8 OpenClaw 세션·내부 위임 설계」 절, 10장 결정 #3(「스레드는 후속 하위 세션」)·#19(세션 키 원형)
- 산출 코드: 없음 — 실험 플러그인 사본·러너·가짜 CLI 는 버렸다
- 근거 원장(git 제외): `.superpowers/sdd/2026-09-25-thread-spike/spike-report.md` — 질문별 실측·probe 모양·연결별 이벤트 수·정리 상태

## 1. 결론

| # | 질문 | 답 |
| --- | --- | --- |
| 1 | 인바운드에 스레드 필드가 있나, 키는 누가 만드나 | 있다 — `ConversationFacts.threadId`, `ReplyPlanFacts.messageThreadId`, `RouteFacts.parentSessionKey`. **키는 플러그인이 정한다**(디스패치 `route.sessionKey` 그대로 쓰인다). 코어는 `:thread:` 를 해석만 하고, 헬퍼 `resolveThreadSessionKeys` 의 모양은 `<채널 키>:thread:<threadId 소문자>` |
| 2 | 아웃바운드에 스레드가 실려 오나 | 최종 답(`deliver`)은 안 실린다 — 디스패치 클로저가 안다. `message` 툴(`handleAction`)은 `ctx.sessionKey` 가 스레드 키, `ctx.toolContext.currentThreadTs` 가 스레드 id. 코어 일반 전송(`sendText`)은 `ctx.threadId`. **지금 플러그인 그대로면 스레드의 툴 전송이 채널 세션 전사에 delivery-mirror 로 샌다**(3.2) |
| 3 | WS 이벤트·구독 | `agent`·`chat` 의 `sessionKey` 는 스레드 키 그대로, `runId` 는 우리 런 id. 어댑터 caps(`session-scoped-events`)로는 **그 스레드 키를 `sessions.messages.subscribe` 한 연결만** 받는다. 세션이 생기기 전에 구독해도 된다 |
| 4 | 채널 `systemPrompt`·리셋 | 채널 프롬프트는 스레드 세션에도 들어간다. `sessions.reset` 은 그 스레드 키만 새 세션으로 돌리고 채널 세션은 그대로 |
| 5 | 채널 런과 스레드 런이 동시에 도나 | **돈다.** 직렬화 단위는 세션 키다 — 같은 스레드 두 건은 직렬 |
| 6 | 봇 루프 예산·ChannelPromptContext 공유 | 봇 루프 예산의 키는 플러그인이 넘기는 `conversationId` 다 — 지금(`channelId`)은 채널과 스레드가 **한 예산**. ChannelPromptContext 는 공유 상태가 아니라 인바운드마다 서버가 채우는 값 |

## 2. 환경

| 항목 | 값 |
| --- | --- |
| Gateway | dev 프로필, 스크래치 `openclaw@2026.9.5 (ec9c1a1)`, PATH 앞에 가짜 claude CLI(`docs/guides/live-smoke.md` 「런 0회 하네스 — 모델 없이」 절의 변형 — 세션 id 를 argv 에서 받아 되돌리고, 프롬프트 지시어로 `message` 툴 호출·잠들기를 고른다) |
| SDK 읽기 | 저장소 핀 `openclaw@2026.9.4` 타입·번들과 스크래치 9.5 `dist`. 1·2 의 필드·헬퍼는 두 판 모두에 있다. 동작은 9.5 에서만 쟀다 |
| 실험 플러그인 | 인바운드 세션 키에 `:thread:<t>` 가 붙으면 받아 `conversation.threadId`·`reply.messageThreadId` 를 채운다(본문에 `[fork]` 가 있으면 `route.parentSessionKey` = 채널 키). 아웃바운드 지점마다 관찰 줄. 변형 2 는 `resolveOutboundSessionRoute` 를 `buildThreadAwareOutboundSessionRoute` 로 감쌌다 |
| 러너 | 브리지 서버(19100) + Gateway 관찰 연결 셋 — A: 어댑터와 같은 caps, 채널 키만 구독(지금 서버의 모양) · B: 같은 caps, 스레드 키도 미리 구독 · C: `session-scoped-events` 없음, 구독 없음 |
| 런 | 인바운드 13건(봇 루프 drop 1) → Gateway 런 12회, 가짜 CLI 프로세스 11개. 실제 모델 호출 0 |

## 3. 실측

### 3.1 세션 키와 인바운드 (질문 1)

- `buildChannelInboundEventContext` 가 `SessionKey = route.dispatchSessionKey ?? route.routeSessionKey`, `MessageThreadId = reply.messageThreadId ?? conversation.threadId`, `ParentSessionKey = route.parentSessionKey` 로 옮긴다.
  `ThreadLabel`(세션 표시 이름이 된다)·`ThreadStarterBody` 는 `extra` 로 넣는 MsgContext 필드다.
- 스레드 키 `agent:dev:dodok:channel:<CH>:thread:<T>` 로 디스패치하자 `dispatch-result.routeSessionKey` 가 그 키였고, `sessions.list` 에 채널과 다른 `sessionId`(`chatType: "channel"`, `kind: "group"`)로 생겼다. claude CLI 쪽도 스레드마다 새 `--session-id`.
- 코어는 `MessageThreadId`·`ThreadLabel`·`ParentSessionKey` 가 있거나 키에 `:thread:` 가 있으면 스레드로 분류하고(`resolveThreadFlag`) 리셋 정책 종류를 `"thread"` 로 둔다 — `session.resetByType.thread` 가 스레드에만 걸린다. 기본 정책은 mode `none` 이라 자동 리셋은 없다.
- 키를 가르는 쪽은 `parseThreadSessionSuffix` — `lastIndexOf(":thread:")` 로, 대소문자를 무시한다. 헬퍼는 스레드 id 를 소문자로 바꾼다.

### 3.2 아웃바운드와 delivery-mirror 누수 (질문 2)

| 경로 | 스레드를 아는 자리 |
| --- | --- |
| 최종 답 `delivery.deliver(payload, info)` | payload 키는 `text, replyToId, mediaUrls, mediaUrl, replyToTag, replyToCurrent, audioAsVoice` 뿐 — 디스패치 클로저의 facts |
| `message` 툴 → `actions.handleAction(ctx)` | `ctx.sessionKey`(스레드 키), `ctx.toolContext.currentThreadTs`(스레드 id). 모델이 `threadId` 를 안 넣으면 `ctx.params` 에는 없다 |
| 코어 일반 전송 `outbound.attachedResults.sendText(ctx)` | `ctx.threadId` — 스레드 런이 실패했을 때 코어가 보낸 오류 알림에 스레드 id 가 실려 왔다. 지금 `sendText` 는 이것을 버리고 채널 최상위로 보낸다 |
| `messaging.resolveOutboundSessionRoute(params)` | `params.currentSessionKey`(스레드 키)·`params.threadId`. **반환한 경로의 키가 `ctx.params.__sessionKey` 가 되고, 코어가 그 세션 전사에 툴 전송을 delivery-mirror 로 적는다** |

- **상관은 이미 된다.** 플러그인 `correlations` 가 세션 키별이라 스레드 키로 갈린다 — 스레드 런의 툴 전송·최종 답 모두 `runId`·`replyToInboundId` 가 그 런·인바운드와 맞았다.
- **누수.** 지금 `resolveOutboundSessionRoute` 는 `buildChannelOutboundSessionRoute` 만 불러 채널 키를 돌려준다. 그래서 스레드 세션의 툴 전송이 **채널 세션 전사**에 mirror 로 남고 스레드 전사에는 없다.
  claude-cli 에서 모델 문맥의 정본은 CLI 세션이지만, OpenClaw 전사는 `chat.history`(재접속 복구 — 계획서 10장 #16)·포크(3.6)·새 CLI 세션의 전사 재주입(3.6)이 읽는다 — 채널 세션이 남의 스레드 발언을 제 것으로 받는다.
- **막는 법(변형 2 실측).** `buildThreadAwareOutboundSessionRoute({ route, threadId, currentSessionKey, precedence: ["threadId", "currentSession"] })` 를 돌려주자
  스레드 런의 mirror 는 스레드 전사에만 남고 채널 전사는 그대로였고, 채널 런은 채널 키 그대로였다.
  ⚠ 헬퍼의 기본 precedence 는 `replyToId` 를 먼저 본다. 우리 `replyToId` 는 인바운드 **메시지 id** 라 기본값을 쓰면 `:thread:<메시지 id>` 라는 없는 세션으로 간다.

### 3.3 WS 이벤트와 구독 (질문 3)

| 연결 | 채널 키 이벤트 | 스레드 T1 이벤트 |
| --- | --- | --- |
| A — 어댑터 caps, 채널 키만 구독 | 받음 | **0** |
| B — 어댑터 caps, T1 을 세션 생성 전에 구독 | 받음 | 받음 |
| C — `session-scoped-events` 없음, 구독 없음 | 0 | 0 |

- 모양: `agent { runId, agentId, sessionKey, sessionId, stream: "lifecycle", data.phase, … }`, `chat { runId, sessionKey, agentId, seq, state: "delta" | "final", … }` — `sessionKey` 는 스레드 키 전문.
- 없는 키의 `sessions.messages.subscribe { key, agentId, includeApprovals: true }` 는 `{ subscribed, key, approvalReplay }` 로 성공했고, 그 뒤 첫 런부터 이벤트가 왔다.
- 어댑터: `connection-manager` 의 `subscribeSession(sessionKey, agentId)` 는 키 문자열만 쓰므로 스레드 키를 넘기면 된다. **`gateway/approvals.ts` 의 `parseSessionKey` 는 스레드 키를 버린다**(정규식이 채널 키에서 끝난다) — 스레드 승인은 카드가 안 뜨고 서버가 「approval for unknown session」을 남긴다(정적 판단, 승인은 가짜 CLI 로 못 일으켰다).

### 3.4 채널 프롬프트·리셋 (질문 4)

- claude-cli 는 시스템 프롬프트를 argv 가 아니라 **stdin `control_request { subtype: "initialize", appendSystemPrompt }`** 로 받는다. 채널 `systemPrompt` 가 채널 세션·스레드 세션 양쪽 `appendSystemPrompt` 에 있었다 — 플러그인이 디스패치마다 채널 항목을 읽어 `GroupSystemPrompt` 로 싣기 때문이다.
- 스레드 세션의 첫 턴은 새 CLI 세션이라 그때의 채널 프롬프트가 들어간다. 오래 산 스레드는 채널 세션과 같은 문제(ADR 0003 「질문 1 — 채널 프롬프트가 기존 세션에」 절 — 재개된 CLI 세션은 바뀐 프롬프트를 안 받는다)를 **스레드마다 따로** 갖는다.
- 인바운드 `context.channelPrompt` 를 주면 스레드 프롬프트에도 `ChannelPromptContext` 로 실렸다.
- `sessions.reset { key: <스레드 키> }` → 응답 `entry` 에 새 `sessionStartedAt`·`lifecycleRevision`(`sessionId` 는 유지 — ADR 0003 과 같다). 채널 세션의 `sessionStartedAt`·전사는 그대로. 채널 키 리셋이 스레드에 영향이 없는지는 재지 않았다.

### 3.5 동시성 (질문 5)

- 채널 런과 스레드 런(각 8.5초)을 같이 보내자 가짜 CLI 의 턴 시작 시각이 같았고 끝도 3ms 차이였다 — 병렬. 같은 스레드 두 건은 두 번째가 큐잉되고(ack 는 `providerRunId` 없는 `dispatch`) 첫 런이 끝난 뒤 시작했다 — 직렬.
- 코드: 임베디드 러너 레인 `resolveSessionLane` = `session:<sessionKey>` + 전역 레인 `main`(`agents.defaults.maxConcurrent`), claude-cli 큐 키 `resolveCliRunQueueKey` 는 라이브 세션 백엔드면 `agentId`·`sessionId`·`sessionKey` 를 섞은 owner 키 — 세션별이다.
  서버 `runs/orchestrator.ts` 의 세션 큐도 sessionKey 별이다. 상한은 에이전트가 아니라 Gateway 전역 `maxConcurrent` 다.

### 3.6 포크(`route.parentSessionKey`) — 곁가지

- 주면 새 스레드 세션이 부모(채널) 전사를 **복사**한다(`sessions.list` 의 `forkedFromParent: true`, Gateway 로그 「forking from parent session」). 복사본에는 3.2 의 누수 mirror 도 따라왔다.
- claude-cli 는 새 CLI 세션으로 시작했고 가짜 CLI 의 프롬프트에 부모 내용은 없었다(`historyPrompt=none`, 인증 경계를 몰라 전사 재주입을 거절 — `reason=auth-unknown`).
  그러나 claude-cli 백엔드 기본값이 `reseedFromRawTranscriptWhenUncompacted: true` 라, 인증 경계가 알려진 실제 런에서는 새 CLI 세션에 OpenClaw 전사 꼬리가 다시 들어갈 수 있다 — **미실측**.

### 3.7 봇 루프 예산 (질문 6)

- 채널 항목에 `botLoopProtection { maxEventsPerWindow: 1, windowSeconds: 600, cooldownSeconds: 600 }` 를 두고 fin→dev 를 채널에 한 번, 스레드에 한 번 보내자 스레드 쪽이 `drop` `bot-loop-protection`.
  예산 키 `(scopeId, conversationId, 봇 쌍)` 의 `conversationId` 를 플러그인이 `channelId` 로 넘기기 때문이다(ADR 0002 「봇 루프 보호」 절).

## 4. 설계에 주는 제약과 추천

1. **세션 키** — `agent:<agentId>:dodok:channel:<channelId>:thread:<threadId>`, `threadId` 는 스레드 루트 메시지 id(우리 UUID, 소문자). 코어 헬퍼 `resolveThreadSessionKeys` 와 같은 모양이라 코어의 스레드 분류·`parseThreadSessionSuffix` 와 맞는다. **서버가 만든다**(`sessionKeyFor` 에 스레드 인자), 플러그인은 검증만 한다.
2. **인바운드** — 스레드면 `conversation.threadId`·`reply.messageThreadId` 를 채운다(`ThreadLabel` 은 선택). **`route.parentSessionKey` 는 비운다** — 포크는 누수와 통제 못 하는 재주입을 들여온다(3.6). 스레드 문맥(루트·스레드 최근 메시지·필요하면 채널 발췌)은 우리가 인바운드 컨텍스트로 싣는다.
3. **아웃바운드** — 셋 다 고친다.
   - `resolveOutboundSessionRoute` 를 `buildThreadAwareOutboundSessionRoute`(precedence `["threadId", "currentSession"]`)로 — **필수**, 3.2 누수.
   - `handleAction` 은 `ctx.sessionKey` 에서 스레드를 푼다(`toolContext.currentThreadTs` 는 대조용). 상관은 지금 구조 그대로 된다.
   - `sendText` 는 `ctx.threadId` 를 받아 스레드로 보낸다 — 안 그러면 스레드의 오류 알림이 채널 최상위로 간다.
   - 스레드 세션의 에이전트가 채널 최상위에 쓰는 것(`message` 툴의 최상위 지정)을 허용할지는 스펙이 정한다 — 이번에 재지 않았다.
4. **브리지 계약** — `InboundDeliver`·`OutboundMessage` 에 선택 필드 `threadId` 를 두고 세션 키와 대조한다. 키 문자열 파싱만으로도 되지만, 서버가 스레드를 명시 필드로 받는 편이 저장·팬아웃에서 틀리기 어렵다.
5. **어댑터** — 스레드 키를 전송 전에 `sessions.messages.subscribe` 한다(지금 흐름에 키만 바꾼다). 재접속 복구 대상에 스레드 세션을 넣는다. 승인의 `parseSessionKey` 가 스레드 키를 받아 스레드 id 까지 돌려주게 한다.
6. **서버** — 세션 행의 단위가 (에이전트, 채널)에서 (에이전트, 채널, 스레드)로 는다 — 리셋·「세션 시작 리비전」(계획서 10장 #1)·복구가 스레드 키별이다. 오케스트레이터의 세션 큐는 그대로 쓴다.
7. **동시성** — 한 에이전트의 채널·스레드 런은 병렬, 한 스레드 안은 직렬이다. 스레드가 많아지면 Gateway 전역 `maxConcurrent` 가 실제 상한이다.
8. **리셋** — 스레드의 「새 대화」는 스레드 키 `sessions.reset`. 스레드 자동 리셋이 필요하면 코어 `session.resetByType.thread` 로 스레드에만 걸 수 있다.
9. **봇 루프 예산** — 공유(`conversationId: channelId`)를 유지하기를 추천한다. 릴레이 상한의 정본은 서버 `relayPolicy` 이고 코어 예산은 안전망이다(계획서 10장 #13) — 스레드로 쪼개면 안전망이 스레드 수만큼 넓어진다.

## 5. 고쳐야 할 문서·코드 (스레드 스펙에서)

- `docs/plan.md` 10장 #19 「세션 키 규칙은 원형 유지」 — 스레드 접미사 `:thread:<threadId>` 를 규칙에 넣는다(세대 접미사 `:g<N>` 는 그대로 제거 상태).
- `packages/openclaw-plugin/src/inbound.ts` 의 `dodokSessionKey` 머리주석(「접미사(세대·스레드)는 두지 않는다」)과 `toInboundFacts` 의 완전 일치 검사.
- `packages/openclaw-adapter/src/gateway/approvals.ts` 의 `parseSessionKey`(「접미사가 붙으면 우리 것이 아니다」).
- `packages/shared/src/bridge/index.ts` 의 `InboundDeliver.sessionKey` 주석(채널 키 모양만 적혀 있다).

## 6. 확인 못 한 것

- 실제 모델 런에서의 동작 — 모델이 스레드 세션에서 `message` 툴에 `threadId`·최상위 지정을 넣는지, 같은 채널 툴 전송 뒤 최종 답 억제(`silent`), 포크·새 CLI 세션의 전사 재주입.
- `agent` `stream: "tool"`·승인 이벤트의 `sessionKey` — 가짜 CLI 는 claude `tool_use` 를 내지 않는다. 코드상 같은 세션 키 경로다.
- 같은 스레드 두 번째 턴의 `--resume` — 가짜 CLI 가 claude 전사 파일을 만들지 않아 매번 새 CLI 세션이 됐다.
- 채널 키 리셋이 스레드 세션에 영향이 없는지.
- 원격 Gateway 판에서의 동작(SDK 표면은 9.4 타입에도 있다).

## 7. 다시 재는 법

`docs/guides/live-smoke.md` 「런 0회 하네스 — 모델 없이」 절의 준비·가짜 CLI 에 아래를 더한다. 자세한 모양은 근거 원장.

1. 플러그인 사본의 `toInboundFacts` 가 `<채널 키>:thread:<t>` 를 받게 하고, 디스패치에 `conversation.threadId`·`reply.messageThreadId` 를 채운다. `handleAction`·`sendText`·`resolveOutboundSessionRoute`·`deliver` 에 관찰 줄. 재패킹 → Gateway 를 내리고 설치 → 설치본 sha 확인.
2. 가짜 CLI 는 세션 id 를 `--resume`/`--session-id` 에서 받아 되돌리고, stdin 레코드 전체(`initialize` 포함)에서 표식 문자열의 **이름만** 센다 — 시스템 프롬프트는 `initialize.appendSystemPrompt` 로 온다.
3. 브리지 서버와 Gateway 관찰 연결(어댑터 caps, 채널 키만 구독 / 스레드 키도 구독)을 띄우고 채널 키·스레드 키로 인바운드를 보낸다. 판정은 연결별 `chat`·`agent` 이벤트의 `sessionKey`, 두 세션의 `chat.history` 에서 `model: "delivery-mirror"` 개수, 가짜 CLI 의 턴 시작·끝 시각.
4. zsh 에서 키를 이을 때는 `${BASE}:thread:${T}` — `$BASE:thread` 는 `:t` 수식자로 먹힌다.
5. 끝나면 사본을 되돌려 재패킹·재설치하고 sha 가 main 빌드와 같은지, `channels.dodok.channels` 를 지웠는지, 만든 세션을 `sessions.delete` 로 지웠는지 본다.
