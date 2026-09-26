# Phase 4 ① 스레드·검색 설계

**상태**: 설계 확정(2026-09-25), 구현·브라우저 검증 완료(2026-09-26 — 계획 태스크 1~8 과 곁가지 p4t-c1, 브라우저 11항목 중 9 통과·재접속 결함 수정, 테스트 3190) — 구현이 이 설계와 달라진 것은 「구현과 맞춘 것」 장(판정 R1~R5·R3′ 등). 계획 `docs/superpowers/plans/2026-09-25-threads-search.md`, 스레드 하위 세션 실측 ADR 0006, 실연(계획 태스크 9)은 `docs/guides/live-smoke.md` 「스레드(Phase 4 ①) 실연」 절
**범위**:
- 스레드: 채널 메시지에서 스레드를 열고, 스레드 안의 에이전트는 **스레드마다 하위 세션**으로 답한다
- 검색: 채널·스레드 메시지 전문 검색(SQLite FTS5 trigram)과 결과로 가기

**앞선 근거**:
- 계획서 `docs/plan.md` 8장 Phase 4 「스레드, 검색, 에이전트 내부 위임 결과 요약 게시, 채널 템플릿」, 5.8 절 「OpenClaw 세션·내부 위임 설계」, 10장 결정 #3(「스레드는 후속 하위 세션」)·#19(세션 키 규칙)
- ADR 0006 `docs/adr/0006-thread-sessions-spike.md` — 스레드 하위 세션의 키·아웃바운드·구독·동시성·리셋 실측(모델 런 0회)
- ADR 0002(채널 플러그인 — 인바운드·`message` 툴·아웃바운드·봇 루프 보호), ADR 0003(채널 프롬프트·세션 시작 리비전)
- 계획서 7장 기술 표 「검색 — SQLite FTS5」

---

## 0. 결정 (브레인스토밍 2026-09-25)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **Phase 4 는 스레드·검색부터**, 이번 사이클은 그 둘만. 위임 결과 요약·채널 템플릿은 다음 | 1인 사용에서도 매일 체감한다. 검색이 처음부터 스레드를 덮는다. |
| 2 | **스레드마다 에이전트 하위 세션** — 키 `agent:<agentId>:dodok:channel:<channelId>:thread:<rootId>` | 스레드 작업이 채널 대화·다른 스레드와 섞이지 않는다. 채널과 스레드 런이 병렬로 돈다(ADR 0006). |
| 3 | **스레드 문맥에 채널 대화를 싣지 않는다** — 루트 전문과 스레드 최근 메시지만 | 스레드는 채널의 소음과 떨어지려고 연다. 필요한 문맥은 루트가 담는다. |
| 4 | **멘션이 없으면 루트가 에이전트 메시지일 때 그 에이전트가 답한다**, 아니면 채널 자동 응답 에이전트 | 「에이전트 답에 이어서 묻기」가 가장 흔한 쓰임새다. |
| 5 | **포크(`route.parentSessionKey`)를 쓰지 않는다** | 부모 전사 복사가 누수 mirror 와 통제 못 하는 재주입을 들여온다(ADR 0006 「포크」 절). |
| 6 | **스레드 세션의 에이전트는 채널 최상위에 쓰지 못한다** | 스레드에서 한 말은 스레드에만 간다. 최상위로 올릴 일은 사람이 한다. |
| 7 | **봇 루프 예산은 채널과 공유**(`conversationId = channelId`) | 릴레이 상한의 정본은 서버 `relayPolicy` 이고 코어 예산은 안전망이다(10장 #13). 스레드마다 쪼개면 안전망이 넓어진다. |
| 8 | **검색은 FTS5 `trigram`**, 2글자 검색어는 `LIKE`(최근 90일·50개) | 한국어는 조사가 붙어 공백 토큰으로는 안 잡힌다. trigram 은 3글자부터 색인을 탄다. |

---

## 1. 범위

**한다**
- 사람이 아무 채널 메시지에서 스레드를 열고 스레드 안에서 대화한다(사람·에이전트 메시지 모두 루트가 될 수 있다)
- 스레드 안의 에이전트 런은 스레드 하위 세션 — 멘션·자동 응답·릴레이·카드·첨부·승인·「새 대화」·다시 실행이 스레드 안에서 돈다
- 채널 타임라인은 루트만, 루트 아래에 답글 요약 칩
- 스레드 패널(넓은 화면 오른쪽, 좁은 화면 전체 시트)과 그 안의 작성기
- 스레드 알림(푸시) — 누르면 그 스레드
- 전문 검색 API·검색 대화상자(`⌘K`/`Ctrl+K`)·결과로 가기(특정 `seq` 주변 받기)
- 계획서 10장 #19 와 `CLAUDE.md` 불변 규칙(세션 키)에 스레드 접미사

**하지 않는다**
- 스레드 안의 스레드, 스레드를 채널로 올리기, 스레드 읽음 상태, 스레드 목록 화면
- 에이전트가 스레드를 스스로 여는 것
- 에이전트 툴 인자·런 이벤트·첨부 내용 검색, 의미 검색, 검색어 저장
- 위임 결과 요약 게시, 채널 템플릿

---

## 2. 스레드 — 데이터와 동작

### 2.1 DB

- `messages.thread_root_id`(nullable, 같은 채널의 메시지 id). 루트는 `NULL` 이고 스레드 답글은 루트 id 를 가진다. 인덱스 `(channel_id, thread_root_id, seq)`.
- 스레드의 루트는 **루트가 아닌 메시지일 수 없다** — 답글에서 스레드를 열면 그 답글의 루트 스레드로 간다(스레드 안의 스레드 없음).
- `seq` 는 채널 하나의 연속 번호를 루트·답글이 같이 쓴다 — 재구독(`lastSeq`)·오프라인 사본이 그대로 돈다.
- `agent_sessions` 에 `thread_root_id`(nullable) — 세션 행의 단위가 (에이전트, 채널, 스레드)가 된다. 유일 제약도 셋으로.
- 시스템 메시지(릴레이 한도·실패·런 한도)는 그 일이 일어난 곳(채널 또는 스레드)에 남는다.

### 2.2 누가 답하나 (라우터)

- **채널 최상위 메시지** — 지금 그대로.
- **스레드 답글(사람)** — 멘션된 에이전트마다 스레드 런. 멘션이 없으면 ① 루트가 에이전트 메시지면 그 에이전트 ② 아니면 채널 자동 응답 에이전트. 둘 다 비활성·없으면 런 없음.
- **스레드 답글(에이전트)** — 멘션이 릴레이. 릴레이 런도 같은 스레드의 세션이다. 턴 상한·반복 감지는 사슬 단위(`rootMessageId`) 그대로, 쌍 허용·일일 한도도 그대로(스레드 런도 센다).
- 이어가기·다시 실행 버튼이 스레드 안 시스템 메시지에 있으면 새 런도 그 스레드.

### 2.3 스레드 세션이 받는 문맥

- 인바운드 헤더에 `스레드:` 절 — 루트 메시지(작성자·시각·본문, 본문은 4,000자에서 자른다)와 스레드 안 최근 메시지 최대 20개(트리거 앞). 채널 최근 대화는 싣지 않는다.
- 채널 프롬프트·채널 지시(`ChannelPromptContext`)는 채널과 같다. 채널 `systemPrompt` 는 스레드 세션에도 들어간다(ADR 0006).
- 세션 시작 리비전(10장 #1)은 스레드 세션 행별로 기억한다.

### 2.4 「새 대화」

- 스레드 패널의 에이전트 줄에서 그 스레드의 그 에이전트 세션만 `sessions.reset`. 채널 세션은 그대로. 작성기 `/new @에이전트` 도 스레드 안이면 스레드 세션.

---

## 3. 스레드 — 브리지·플러그인·어댑터 (ADR 0006 「설계에 주는 제약과 추천」)

### 3.1 세션 키

- `agent:<agentId>:dodok:channel:<channelId>:thread:<rootId 소문자>` — **서버가 만든다**(`sessionKeyFor` 에 스레드 인자). 플러그인은 모양과 `threadId` 대조만.

### 3.2 shared 브리지 계약

- `InboundDeliver.threadId?`·`OutboundMessage.threadId?`(UUID). 세션 키의 스레드 접미사와 같아야 한다 — 서버·플러그인 모두 대조하고 다르면 거절.
- `InboundDeliver.context` 에 `thread?: { root: { author, text, ts }, recentMessages }`.
- 옛 플러그인(이 필드를 모름)으로는 스레드 런이 돌지 않는다 — 서버는 스레드 런을 디스패치하기 전에 플러그인 hello 의 번들이 스레드를 아는지(`capabilities.threads`) 보고, 모르면 런을 `ADAPTER_UNAVAILABLE` 이 아니라 새 코드 `PLUGIN_OUTDATED` 로 끝내고 run_error 카드에 「플러그인을 새로 설치해야 스레드에서 답할 수 있습니다 — 연결 페이지」를 남긴다.

### 3.3 플러그인

- 인바운드: 스레드면 `conversation.threadId`·`reply.messageThreadId` 를 채운다. `route.parentSessionKey` 는 비운다.
- 아웃바운드:
  - `resolveOutboundSessionRoute` 를 스레드 인식 경로(precedence `threadId` → `currentSession`)로 — **필수**(ADR 0006 「아웃바운드와 delivery-mirror 누수」 절).
  - `handleAction` 은 `ctx.sessionKey` 에서 스레드를 풀어 `OutboundMessage.threadId` 에 싣는다. 스레드 세션에서 채널 최상위를 가리키는 전송(결정 6)은 거절하고 모델에게 고정 사유(「이 대화는 스레드라 스레드에만 보낼 수 있습니다」)를 돌려준다.
  - `sendText` 는 `ctx.threadId` 를 받아 스레드로.
- 봇 루프 예산의 `conversationId` 는 `channelId` 그대로.
- hello 에 `capabilities.threads: true`.

### 3.4 어댑터

- 스레드 키를 인바운드 전에 `sessions.messages.subscribe`(세션이 생기기 전에 해도 된다), 재접속 복구 대상에 스레드 세션.
- 승인 `parseSessionKey` 가 스레드 키를 받아 `{ agentId, channelId, threadRootId }`.
- 델타·툴·승인 이벤트는 `runId` 로 상관된다 — 경로 그대로.

### 3.5 서버 저장·팬아웃

- 정본 도착(`onCanonical`) 때 `OutboundMessage.threadId` 가 런의 스레드와 같아야 저장한다(다르면 거절·warn). 에이전트 메시지의 `thread_root_id` 는 런에서 온다.
- 스레드 답글이 저장되면 루트의 `threadSummary` 를 다시 계산해 `message.updated`(루트)로 보낸다.

---

## 4. 스레드 — wire·REST·웹

### 4.1 계약

- `Message.threadRootId?`, 루트 메시지의 `threadSummary?: { count, lastAt, agentIds }`(답글이 있을 때만).
- `message.send` 에 `threadRootId?`. 루트가 없거나 다른 채널·답글을 가리키면 `VALIDATION`(답글이면 서버가 그 루트로 바꾸지 않는다 — 웹이 루트를 보낸다).
- `listMessages`(채널)는 루트만. REST `GET /api/v1/channels/:id/threads/:rootId/messages?before&after&limit`.
- `channel.subscribe` 는 채널 룸 하나로 루트·답글 이벤트를 모두 받는다(스레드 룸 없음) — 웹이 `threadRootId` 로 나눈다.

### 4.2 웹

- 루트 아래 칩 「답글 N · 마지막 시각 · 에이전트 아바타」, 메시지 메뉴 「스레드에서 답하기」.
- 스레드 패널: 루트·답글 목록(스트리밍 버블·카드·첨부·승인 포함)·작성기(`@` 자동완성 — 채널 멤버)·에이전트 줄의 「새 대화」. 넓은 화면은 오른쪽 패널(설정·활동 탭과 같은 자리, 탭 하나로), 좁은 화면은 전체 시트. URL `/c/$channelId/t/$rootId`(새로고침·푸시 링크).
- 푸시: 스레드 멘션은 「@dev가 #채널 스레드에서 불렀습니다」, 누르면 스레드 URL. 보고 있으면 거름은 채널 단위 그대로.
- 오프라인 사본: 최근 채널 5개에 그 채널에서 연 스레드의 마지막 페이지를 함께 둔다.

---

## 5. 검색

### 5.1 색인

- FTS5 가상 테이블 `messages_fts(body, attachment_names, content='')`(외부 콘텐츠 없음, rowid = messages 의 정수 rowid), `tokenize='trigram case_sensitive 0'`.
- 대상: `kind = 'normal'` 메시지(채널·스레드). 시스템 메시지 제외. 스트리밍 델타는 넣지 않는다 — 저장된 메시지만.
- 동기화: `messages` 의 INSERT·UPDATE(본문·첨부)·DELETE 트리거. 마이그레이션이 기존 메시지를 한 번에 채운다.
- SQLite 판이 `trigram` 을 지원하는지 부팅 때 한 번 확인한다(better-sqlite3 가 번들한 SQLite). 없으면 부팅 실패 한 줄.

### 5.2 API — `GET /api/v1/search`

- 인자: `q`(2~200자, 앞뒤 공백 제거), `channelId?`, `authorType?`(`user`·`agent`), `authorId?`, `from?`·`to?`(ISO 날짜), `cursor?`. 한 페이지 20개.
- `q` 가 3글자 이상: `messages_fts MATCH` — 사용자 입력은 따옴표로 감싼 구절 하나로만 넘긴다(FTS 연산자 주입 방지). 정렬 `bm25` 다음 최신순.
- `q` 가 2글자(코드 포인트 기준 — 스키마 하한이 2라 1글자는 400): `body_md LIKE '%q%'`(`ESCAPE` 로 `%`·`_` 이스케이프), 최근 90일·최대 50개, 최신순. 응답에 `limited: true`.
- 결과: `{ messageId, channelId, seq, threadRootId?, authorType, authorId?, createdAt, snippet }` — `seq` 는 결과로 가기(5.3)가 `around` 로 받는 자리 — `snippet` 은 일치 부분을 `\u0002`·`\u0003` 으로 감싼 앞뒤 64자(웹이 강조로 바꾼다, HTML 을 서버가 만들지 않는다).
- 권한: 사용자가 멤버인 채널만(지금은 워크스페이스의 모든 채널). 레이트리밋: REST 상한 위에 검색 전용 사용자당 분당 60(`LIMITS.searchPerMin`).

### 5.3 결과로 가기

- REST `GET /api/v1/channels/:id/messages?around=<seq>&limit=` — 그 `seq` 앞뒤 절반씩. 웹 타임라인이 그 페이지로 갈아 끼우고 위·아래로 이어 받는다.
- 결과가 스레드 답글이면 채널을 열고 스레드 패널을 그 답글 위치로 연다.
- 스레드 REST(`GET /api/v1/channels/:id/threads/:rootId/messages`)도 `around` 를 받는다 — 답글 결과는 스레드도 이전 페이지를 되풀이해 받지 않고 around 로 받는다. 채널 경로의 `around` 가 답글 seq 면 서버가 그 루트를 가운데로 둔다(채널 타임라인은 루트만).
- 도착한 메시지는 2초 강조(`prefers-reduced-motion` 이면 색만).

### 5.4 웹

- 사이드바 위 검색 칸, `⌘K`/`Ctrl+K` 로 검색 대화상자(390px 전체 시트). 필터: 채널·사람/에이전트·기간. 짧은 검색어면 「2글자는 최근 90일에서 50개까지만 찾습니다」 한 줄.

---

## 6. 보안·개인정보

- 스레드 세션 키·`threadId` 는 서버가 만들고 플러그인·서버가 서로 대조한다 — 플러그인이 다른 스레드·채널로 쓰게 하는 길이 없다.
- 검색 결과는 멤버인 채널만. 스니펫은 본문에서 자르고, 본문에 일치가 없으면(첨부 이름으로 찾힌 결과) 첨부 이름에서 자른다. 툴 인자·런 이벤트는 싣지 않는다 — 호스트 경로가 들어간 메시지는 이미 저장 전에 걸러진다(첨부 스펙).
- FTS 입력은 구절 하나로만 — 연산자·열 필터 주입 없음. `LIKE` 는 이스케이프.

---

## 7. 오류 처리

| 상황 | 동작 |
| --- | --- |
| 스레드 런인데 플러그인이 스레드를 모름 | 런 `error` `PLUGIN_OUTDATED`, run_error 카드에 재설치 안내(다시 실행 버튼은 있다 — 새로 설치한 뒤 누른다) |
| `OutboundMessage.threadId` 가 런의 스레드와 다름 | 저장 거절, warn, 플러그인 ack 오류 |
| 스레드 에이전트가 최상위로 보내려 함 | 플러그인이 툴 호출을 고정 사유로 거절 |
| `message.send` 의 `threadRootId` 가 답글·다른 채널·없음 | `VALIDATION` |
| 검색 SQLite 에 trigram 없음 | 부팅 실패 한 줄 |
| 검색어 2자 미만·200자 초과 | 400 `VALIDATION` |

---

## 8. 테스트·검증

- **shared**: 스레드 계약(threadId 와 세션 키 대조 헬퍼), 검색 응답 스키마.
- **플러그인 단위**: 스레드 인바운드 사실(`threadId`·`messageThreadId`·포크 없음), 아웃바운드 셋(route·handleAction·sendText)의 스레드, 최상위 전송 거절, hello capabilities.
- **어댑터 단위**: 스레드 키 구독·복구, 승인 parseSessionKey.
- **서버 단위·통합**(가짜 Gateway·플러그인): 스레드 멘션 → 스레드 세션 키·문맥(채널 대화 없음) → 답이 스레드로 · 멘션 없음(루트 에이전트 / 자동 응답) · 채널·스레드 병렬 · 스레드만 리셋 · 릴레이가 스레드 안 · 한도가 스레드 런도 셈 · 옛 플러그인 → `PLUGIN_OUTDATED` · threadId 불일치 거절 · 루트 요약 `message.updated`.
- **검색**: 트리거 동기화(삽입·수정·삭제), 조사 붙은 한국어 3글자 이상, 2글자 `LIKE`(90일·50개·이스케이프), 필터·커서, 스니펫, FTS 연산자 주입, `around` 페이지.
- **웹 단위·브라우저**(`dev:fake` — 대본에 스레드 답·릴레이 추가): 스레드 열기·답·칩·패널·390px 시트·URL 새로고침·푸시 링크, 검색 `⌘K`·결과로 가기·강조·스레드 답글 결과.
- **실연**(dev Gateway): 런 0회 하네스로 스레드 멘션·릴레이·리셋·누수 없음(채널 세션 전사) · **모델 런 1~2회(승인 뒤)** — 스레드에서 `message` 툴과 최종 답이 어떻게 오는지(ADR 0006 이 못 잰 것).

---

## 9. 완료 기준

- 사람이 스레드를 열고 에이전트와 스레드 안에서 대화하며, 그 대화가 채널 세션·다른 스레드에 섞이지 않는다(채널 세션 전사 확인).
- 채널의 다른 일과 스레드 일이 동시에 돈다.
- 한국어 검색이 조사와 상관없이 찾고, 결과를 누르면 그 메시지(스레드 답글 포함)로 간다.
- 서버 통합·웹 단위·브라우저 검증 결함 0, 검사 4종 통과, 실연 통과.

---

## 10. 열린 문제 (범위 밖 기록)

- 스레드 읽음 상태·스레드 목록 화면·스레드를 채널로 올리기.
- 스레드 자동 리셋(코어 `session.resetByType.thread`).
- 봇 루프 예산을 스레드별로 쪼갤지(지금은 공유).
- 원격 Gateway 판에서의 스레드 동작(SDK 표면은 9.4 타입에도 있다 — 실연은 dev 9.5).
- 검색: 의미 검색·첨부 내용·툴 인자.

---

## 11. 구현과 맞춘 것 (2026-09-26)

구현(계획 태스크 1~8)·리뷰·브라우저 검증과 곁가지(p4t-c1)에서 이 설계와 달라지거나 설계가 정하지 않은 것을 정한 자리만 모았다. main `446238c` 기준이다.
정본 근거는 실행 원장 `.superpowers/sdd/2026-09-25-threads-search/ledger.md`(git 제외)의 판정 R1~R5·R3′ 와, 원장이 가리키는 보고서·리뷰(`p4t-t*`·`p4t-c1`)다. 보고서의 커밋 해시는 워크트리 것이라 main 에서는 다르다 — 아래 해시는 main 의 것이다.
실연은 `docs/guides/live-smoke.md` 「스레드(Phase 4 ①) 실연」 절, 스레드 하위 세션의 실측 근거는 ADR 0006, 남은 문제는 `docs/plan.md` 8장 「이월」 한곳에 있다. 각 파일이 왜 그렇게 생겼는지는 그 파일의 머리 주석이 정본이다.

**계약·세션 키(태스크 1·2 — `4995a0c`·`911e8b4`·`d1eaf5f`)**

- **세션 키는 shared `packages/shared/src/session-key.ts` 의 두 함수로만 만들고 푼다** — `dodokSessionKey(agentId, channelId, rootId?)`·`parseDodokSessionKey(key)`. 서버·어댑터·플러그인이 따로 조립하거나 정규식을 두지 않는다(서버 `canonicalSessionKey`·플러그인 자체 빌더·`SESSION_CHANNEL_RE` 는 없다). 빌더는 **channelId·rootId 를 소문자로** 만든다 — 코어가 dodok 키를 통째로 소문자로 접으므로 우리 쪽의 날 문자열 비교(세션 행·플러그인 인바운드 대조)도 Gateway 와 같은 결론을 낸다. agentId 는 그대로 둔다. 빌더는 agentId 가 OpenClaw 규칙 `[a-z0-9][a-z0-9_-]{0,63}`(대소문자 무시) 밖이거나 rootId 가 빈 문자열이면 **던진다**. 파서도 같은 규칙으로 거절하고, 채널 키에는 `threadRootId` 속성 자체가 없다.
- **R1 — 모르는 hello capability 는 버리고 받는다.** `BridgeHello.capabilities` 는 닫힌 enum 이 아니라 `z.array(z.unknown())` 을 아는 값만 남기는 transform 이다(배열이 아니면 여전히 거절). 닫힌 enum 이면 옛 서버가 새 플러그인의 hello 를 통째로 거절한다. **이 규칙은 R1 을 가진 서버부터다** — `threads` 를 모르는 Phase 3 서버는 새 플러그인 hello 를 거절하므로, 서버를 그 판으로 되돌릴 때는 플러그인도 같은 커밋의 tgz 로 되돌린다(`docs/guides/deploy.md` 「업데이트」 절의 「되돌리기」).
- 플러그인 hello 는 `DODOK_BRIDGE_CAPABILITIES` = `["run_id_in_outbound","config.set","threads"]` 를 싣는다. 어댑터 `pluginSupports("threads")` 는 **지금 붙은** 플러그인의 hello 로 답하고, 붙은 플러그인이 없으면 false 다.
- **채널 세션의 `threadId` 인자는 쓰지 않는다** — `handleAction` 도 route(`outboundRouteThreadId`)도. 채널 세션에서 route 만 스레드로 가면 채널 발언이 그 스레드 전사에 mirror 된다.
- **「최상위를 가리킴」의 해석**(3.3) — `message` 툴의 `to` 는 `channel:<id>` 하나라 최상위와 스레드를 가를 수 없다. 스레드 세션에서 같은 채널 + `threadId` 없음은 그 스레드로 보내고, `to` 가 다른 채널이거나 `threadId` 인자가 그 스레드가 아니면(`"top"` 같은 값 포함) 고정 사유 `dodok: 이 대화는 스레드라 이 스레드에만 보낼 수 있습니다`(`THREAD_ONLY_REASON`)로 거절한다. 코어의 `topLevel: true`·`threadId: null` 표지는 거절하지 않는다(이월). `toolContext.currentThreadTs` 는 대조만 하고 다르면 warn(`dodok:tool-send-thread-mismatch`).
- 인바운드 헤더 첫 줄에 `thread=<rootId>`, 스레드면 `스레드 루트:`·`스레드 최근:` 줄을 싣고 채널 「최근 대화」는 서버가 채워 보내도 싣지 않는다. 헤더 모양은 `docs/guides/agent-guide.md` 「스레드」 절.
- **재접속 복구에 어댑터 쪽 기억을 두지 않는다** — 서버 `sessionRecoverTargets` 가 `agent_sessions` 전부(스레드 행 포함)를 주므로 스레드 키도 그대로 다시 구독된다.

**스레드 데이터(태스크 4 — `7f77f55`·`34d8b02`)**

- **유일 제약은 `coalesce(thread_root_id, '')` 표현식 인덱스가 아니라 부분 유일 인덱스 둘이다**(2.1) — 스레드 행 `agent_sessions_channel_agent_thread (channel_id, agent_id, thread_root_id)` 와 채널 행 `agent_sessions_channel_session (channel_id, agent_id) WHERE thread_root_id IS NULL`. drizzle-kit 0.31.10 이 표현식 인덱스의 쉼표에서 SQL 을 깨뜨려 생성한다. 채널 세션 행은 NULL 그대로다. 그래서 채널 세션 upsert 는 `targetWhere: thread_root_id IS NULL` 이 있어야 부분 인덱스를 고르고, 스레드 행 upsert 는 3열 대상(targetWhere 없이)을 쓴다. 세 `thread_root_id` 열(messages·agent_sessions·runs)에 FK 는 없다 — 무결성은 저장 경로 검증이 지킨다.
- **REST 모양**(4.1·5.3 구체화) — 스레드 경로도 채널 경로와 같은 `beforeSeq`·`afterSeq`·`limit` 에 `around` 를 더한다(스펙의 `before&after` 는 약칭). `around` 를 `beforeSeq`·`afterSeq` 와 함께 주면 400. around 페이지는 `{ messages, hasMore, hasMoreAfter }` 로 기준 seq 이하에서 절반(올림), 초과에서 나머지다. 스레드 경로 응답은 `{ root, messages, hasMore[, hasMoreAfter] }` — `root` 는 요약을 실어 늘 싣고, 기본 페이지는 가장 최근 쪽이라 답글이 limit 를 넘으면 `messages` 에 루트가 없을 수 있다. 다른 워크스페이스 채널·없는 id·답글 id·다른 채널 루트는 404.
- **`threadSummary` 는 `hydrateForClient`(상호작용 + 스레드 요약)가 붙인다** — REST·구독 ack·팬아웃 `message.updated` 가 이것을 쓰고, `message.created` 팬아웃은 붙이지 않는다(새 메시지에는 답글이 없다). 요약 `count` 는 시스템 메시지를 포함한 모든 답글이고, `agentIds` 는 가장 최근에 답한 에이전트부터 최대 10.
- **구독 스코프** — `channel.subscribe` 는 `lastSeq` 가 없으면 루트만, 있으면 그 뒤 루트·답글 모두(≤200)를 준다.
- **R2 — lastSeq 재동기화는 옛 루트 요약을 `ChannelSubscribeResult.threadRoots`(선택)로 싣는다.** 끊긴 사이 옛 루트(seq ≤ lastSeq)에 답글이 붙으면 그 루트는 페이지에 없어 새 요약이 오지 않았다. `messages` 의 「lastSeq 이후」 의미는 그대로 두고, 페이지의 답글이 가리키는 루트 중 페이지에 없는 것을 질의 한 번으로 모은다. `lastSeq` 가 없으면 필드가 없다. 틀리면 필드를 걷고 웹이 답글로 요약을 다시 센다. 200 을 넘겨 REST 로 이어 받는 구간은 덮지 않는다(이월).
- 시스템 메시지도 `threadRootId` 를 가진다(2.1 「그 일이 일어난 곳」) — 같은 검증·요약 갱신을 지난다.

**검색(태스크 3·7 — `dd51150`·`34efa61`·`9a75198`)**

- 마이그레이션은 `0007_search_fts.sql`(커스텀, 스레드 열 `0006` 뒤)이다. `contentless_delete=1`(better-sqlite3 13.0.3 의 SQLite 3.53.4)이고, 수정 트리거는 `UPDATE OF body_md, attachments_json, kind` — components 상태 갱신은 색인을 흔들지 않는다.
- **`messages` 를 다시 만드는 마이그레이션은 색인을 조용히 망가뜨린다** — `messages` 는 text PK 라 rowid 가 별명이 아니다. drizzle 의 테이블 재생성(`__new_messages` 복사 → DROP → RENAME)은 트리거를 지우고 rowid 를 새로 매긴다. 그 뒤에 `*_search_fts.sql` 의 트리거 셋과 백필을 새 커스텀 마이그레이션으로 다시 넣는다. 가드는 `apps/server/test/search.service.test.ts` 의 백필 테스트다 — 모든 마이그레이션 뒤 `messages` 에 트리거 셋이 걸려 있고 남은 행마다 제 id 로만 찾히는지 본다.
- **trigram 확인은 app 부팅이 아니라 `createDb` 의 `migrate` 직전이다**(5.1) — `apps/server/src/db/fts.ts` 의 `assertTrigramSupport(sqlite)`. 부팅에서 재면 마이그레이션이 먼저 여러 줄 drizzle 오류로 죽는다.
- **NUL(`\u0000`)이 든 검색어는 400 `VALIDATION`**(7장 보탬) — FTS5 파서는 NUL 에서 문자열을 끝내 500 이 되고, LIKE 는 패턴이 NUL 에서 잘려 더 넓게 찾는다.
- **2글자 경로는 커서 없이 한 번에 최대 50개**(`nextCursor` 없음, `limited: true`) — 페이지 20 은 MATCH 경로에만. 2·3글자 경계는 코드 포인트로 센다(스키마 하한도 zod 4 가 코드 포인트로 잰다).
- 스니펫은 본문에 일치가 없으면 첨부 이름에서 자르고(6장), 그래도 없으면 본문 머리 128자를 표시 없이 준다. 앞뒤 64 + 검색어 200 + 표시·말줄임 4 = 332 라 `snippet` 상한 400 안이다.
- **R5 — `SearchHit.seq` 는 필수다**(5.2) — around 가 seq 만 받는데 결과에 seq 가 없었다(계획 빈틈). 틀리면 id → seq 조회 REST 로 대체한다.

**스레드 런(태스크 5 — `b8b1041`·`ad159ab`·`cd216b3`·`d8beb95`)**

- **R3′ — shared `Run.threadRootId?`(rootMessageId 다음)와 `RunState` 의 `threadRootId`.** RUN_STARTED 는 queued → streaming 때만 나와 queued 동안·queued → error(`PLUGIN_OUTDATED`) 스레드 런의 소속을 몰랐다. 서버 `rowToRun` 이 `runs.thread_root_id` 로 채우고 run.state·구독 activeRuns·run.events.replay·REST 런에 실린다. 채널 런은 필드가 없다. 틀리면 필드를 걷는다.
- **PLUGIN_OUTDATED 는 붙은 플러그인이 있고 그 hello 에 `threads` 가 없을 때만이다**(3.2 정정) — 붙은 플러그인이 없으면 채널 런처럼 보내 어댑터가 기다리게 한다(못 붙으면 `ADAPTER_UNAVAILABLE`). `pluginSupports` 만 보면 브리지가 잠깐 끊긴 사이의 스레드 멘션이 모두 재설치 안내가 된다. 대가: 기다리는 동안 옛 플러그인이 붙으면 PLUGIN_OUTDATED 가 아니라 `ADAPTER_ERROR:INTERNAL` 카드다(이월). 카드 본문은 「@dev 가 스레드에서 답하지 못했습니다 — 플러그인을 새로 설치해야 합니다(연결 페이지)」, 「다시 실행」 버튼이 있다.
- **정본 거절의 플러그인 ack 코드는 `INTERNAL` 이다**(7장 구체화) — 서버는 `VALIDATION`(`threadId does not match`)을 던지지만 어댑터 브리지가 훅 예외를 모두 `INTERNAL: <메시지>` 로 싣는다(기존 「모르는 에이전트」도 같다). 정본 대조는 런이 있으면 세션 키의 스레드·`threadId`·런의 스레드가 모두 같아야 하고, 런이 없는 정본(상관되지 않은 툴 전송)은 키의 스레드와 `threadId` 가 같으면 그 스레드에 저장한다.
- **채널 런의 문맥에서 스레드 답글을 뺀다**(2.3 보탬) — 채널 런 `recentMessages` 는 `thread_root_id IS NULL` 만. 빼지 않으면 스레드 대화가 채널 세션 문맥에 섞인다(결정 2). 스레드 런은 `recentMessages: []` 에 `context.thread`(루트 4,000자·그 스레드 normal 답글 최근 20, 트리거 앞 — 상호작용이면 카드까지).
- **스레드 세션 큐** — 채널 세션과 병렬, 같은 스레드 세션은 직렬.
- **「새 대화」는 `POST /api/v1/channels/:id/agents/:agentId/reset?threadRootId=<rootId>`**(2.4 구체화) — 그 스레드 세션만 reset 하고 그 스레드 런만 abort, info 도 스레드에. 채널 리셋은 스레드 런을 건드리지 않는다. 쿼리가 루트가 아니면(답글·다른 채널 루트·없는 id) 404, UUID 가 아니면 400.
- **R4 — providerAgentId 는 소문자만 등록하고, 조회는 대소문자를 무시한다.** 등록 경계(`POST /agents`)는 shared `isRegistrableAgentId`(= `isOpenClawAgentId` ∧ 소문자)로 400 `VALIDATION`(「providerAgentId 는 OpenClaw 에이전트 id(영문 소문자·숫자로 시작, 영문 소문자·숫자·_·-, 64자 이하)여야 한다」). 승인 `findAgentId`·런 없는 정본 `agentIdFor` 는 `agents/service.ts` 의 `providerAgentIdIs`(`lower()` 비교)를 함께 쓴다 — 코어가 세션 키를 소문자로 접어 날 비교가 어긋났다. 이미 저장된 대문자 행은 빌더(`/i`)가 그대로 받아 런이 돈다. 틀리면 대문자 id 를 쓰는 사람이 등록 400 을 받는다(OpenClaw id 는 사실상 소문자). `PATCH /agents` 는 providerAgentId 를 받지 않아 검증이 없다.
- **규칙 밖으로 저장된 행 → 런은 `INVALID_AGENT_ID`, 「새 대화」는 400** — 세션 키를 못 만들므로 런을 만들고 곧바로 `error{code:"INVALID_AGENT_ID"}`(세션 큐에 넣지 않는다), run_error 카드 「@dev 실행이 실패했습니다: OpenClaw 에이전트 id 가 세션 키 규칙(영문·숫자·_·-)에 맞지 않습니다 — 올바른 id 로 에이전트를 다시 등록하세요」. 다시 실행해도 같아 버튼이 없다. REST 「새 대화」는 같은 사유로 400 `VALIDATION`(사유 문장은 `INVALID_AGENT_ID_REASON` 하나).
- **run_limit 「하루 한 번」은 채널 단위 그대로다** — 관문 `check(channelId, threadRootId?)` 가 막힌 곳이 스레드면 알림도 스레드에 남기지만, 그날 첫 알림이 스레드에 남으면 같은 날 최상위에는 다시 남지 않는다(이월). 릴레이 차단 알림·이어가기·다시 실행·카드 런도 그 스레드다.
- **스레드 멘션 푸시 tag 는 `mention:t:<rootId>`**(4.2 구체화) — `mention:<channelId>:<rootId>` 는 81자라 계약 상한 80 을 넘는다. 링크는 `/c/<id>/t/<rootId>`. 스레드 안 relay_limit 은 tag 는 채널 그대로, 문구·링크만 스레드다.

**웹 스레드(태스크 6 — `5987330`·`dab7e72`)**

- **R3 — 스트리밍 버블·런 스토어의 스레드 소속은 `run.state.threadRootId` 1순위, 없으면 `RUN_STARTED.sessionKey` 를 `parseDodokSessionKey` 로 푼 값이다.** 스토어는 런 id → 루트를 `remove` 뒤에도 남겨 확정 승인 카드가 채널로 새지 않게 한다. 버블·`/stop` 은 `selectScopeRuns(ch, root?)` 로 가르고, 활동 탭은 여전히 채널의 전부다.
- **캐시 모양** — 채널 `["timeline", ch]` 은 루트만, 스레드 `["thread", ch, root]` 는 루트와 답글을 seq 순 한 목록. 스레드는 REST 로 처음 받고 그 뒤는 wire 가 고친다. 연 적 없는(캐시가 없는) 스레드의 답글은 버리고 칩은 루트 `message.updated` 가 맞춘다. 채널 `lastSeq` 는 루트·답글 모두의 최대 seq 다 — 답글 뒤의 루트가 거짓 빈틈이 되지 않는다.
- **`withThreadEdits` — 스레드 REST 가 도는 사이 온 wire 변경을 받은 페이지에 다시 적용한다**(첫 열기·다시 받기 모두). `updateThread` 에 넘기는 함수는 새 페이지에 다시 적용돼도 맞아야 한다. 같은 Query 키의 관찰자는 모두 같은 `queryFn` 을 준다(`timelineQuery` — 읽기만 하는 관찰자가 `skipToken` 을 주면 무효화 뒤 다시 받기가 `Missing queryFn` 으로 실패했다).
- 스레드 작성기는 `typing` 을 보내지 않는다 — wire `Typing` 이 채널 단위라 채널 작성기 아래 「입력 중」으로 보인다.
- 오프라인 사본은 `recentThreads`(채널 → 마지막으로 연 루트)로 최근 채널마다 스레드 하나, 루트 + 마지막 답글 50 이다(4.2 「그 채널에서 연 스레드」의 구체화). 서비스 워커의 푸시 URL 필터는 `/c/<uuid>/t/<uuid>` 도 받는다.

**웹 검색·결과로 가기(태스크 7 — `fc2f81d`·`2ee2291`)**

- **떨어진 창** — 결과로 가기가 around 로 갈아 끼운 타임라인은 `Timeline.hasNewer` 를 가진다. 그 창에서는 창 안(가장 새 항목의 seq 이하)과 이미 가진 것만 넣고 `lastSeq` 만 올린다 — wire 새 메시지·재동기화·REST 이어 받기·전송 ack 가 손대지 않고 창 밖 메시지를 붙이지 않는다. `lastSeq` 는 내려가지 않는다(`max(prev, 페이지 끝)`). 5.3 의 「아래로 이어 받는다」는 `useNewerPages` 와 「최신 메시지로」 단추로 채웠고, 떨어진 창에서 보내면 먼저 최신으로 간다. 가상 목록의 `followOnAppend` 는 떨어진 창에서 끈다(켜 두면 아래로 이어 받은 행을 따라 내려가 다음 쪽이 연달아 불린다).
- **`withTimelineEdits`** — `withThreadEdits` 를 채널 타임라인으로 일반화했다. around·아래로 이어 받기·최신으로의 결과에 받는 사이 온 변경을 다시 얹는다.
- 채널 목록은 구독 응답을 받은 뒤(`lastSeq > 0`)에만 around 를 부른다 — 사본에서 복원한 타임라인은 첫 구독이 `fresh` 라 그 전에 갈아 끼우면 곧바로 덮인다. 결과로 가기의 목표는 zustand 스토어(`features/messages/jumpTarget.ts`)다 — 새로고침·뒤로 가기에 다시 뛰지 않게 URL 에 두지 않는다. 답글 결과면 채널 목록의 목표는 그 루트, 스레드 패널의 목표는 그 답글이다.
- 대화상자: 다른 대화상자가 열려 있으면 ⌘K 를 무시한다 · 한글 입력기 상태에서도 물리 키 K(`e.code === "KeyK"`)면 연다 · 닫으면 연 자리로 초점(Trigger 없이 여는 대화상자라 Radix 기본 복귀가 `body` 로 갔다) · 다음 쪽 실패(429 등)는 받은 결과를 두고 목록 아래에 한 줄 · 입력이 2글자 미만이면 옛 결과를 곧바로 숨긴다 · 429·오류는 대화상자 안 한 줄, 재시도·전역 토스트 없음.

**곁가지 — 재접속·알림·초점(p4t-c1 — `62775d6`·`e4c9f42`·`446238c`)**

- **wire 재접속은 `WireManager`(`apps/web/src/realtime/wire.ts`)가 연다.** socket.io-client 4.8.3 `Manager.open()` 은 engine 의 `error` 만 듣는데, WebSocket 이 핸드셰이크 전에 오류 없이 close 프레임만으로 닫히면 engine 은 `close` 만 낸다 — Manager 가 그 시도를 실패로 몰라 연결 제한시간(20초)까지 다음 시도를 잡지 않았다. `WireManager` 는 `open`·`error` 전에 온 `close` 를 engine `error`(`"<reason> before handshake"`)로 알려 원래 실패 경로(백오프 → 다음 시도)를 타게 한다. **Phase 4 이전부터 있던 결함이다**(스레드와 무관). 연결 제한시간만 줄이는 안은 느린 링크에서 정상 시도까지 끊어 버렸다. socket.io 판을 올릴 때 내부 가정 둘(`open()` 이 `this.engine` 을 동기로 만든다·여는 동안 engine `error` 를 듣는다)은 `wire.test.ts` 가 실제 Manager 로 잡는다(정확 핀 — protected `emitReserved` 의존).
- 끊긴 동안 연결 점은 「Gateway 상태 모름」이다(결함 아님 — `ConnectionDots` 는 wire 가 connected 일 때만 값을 믿는다).
- 알림 클릭 — 서비스 워커는 `focusAndNavigate`(`pwa/sw-logic.ts`)로 focus 가 거절돼도 `postMessage({type:"navigate"})` 를 보낸다.
- **스레드 닫기 초점**(4.2 보탬) — 칩이나 「스레드에서 답하기」로 연 스레드를 닫으면 그 요소로 돌아간다(`features/threads/threadOpener.ts` — 요소가 아직 붙어 있을 때만). 주소·검색·푸시로 연 스레드, 다른 스레드로 옮긴 뒤, 다른 탭에서 닫으면 헤더 「채널 설정」(설정·활동 탭과 같은 규칙).

**검증이 확인한 것**

- 서버 통합 `apps/server/test/integration/threads.test.ts` 11건(가짜 Gateway·플러그인 — 8장 서버 항목 전부: 스레드 키·문맥·정본·요약, activeRuns 의 threadRootId, 멘션 없는 답글, 병렬·직렬, 릴레이·relay_limit, 한도, 스레드 「새 대화」, PLUGIN_OUTDATED → 다시 실행, threadId 불일치 거절, 카드 버튼, 푸시), 검색 서비스·라우트 단위(트리거·rowid 재사용·백필 가드·주입·2글자·NUL), 웹 단위, 태스크마다 독립 리뷰(변이)·수정·범위 재리뷰. `dev:fake` 대본은 스레드에서 멘션하면 그 스레드로 답하고, 「오래」(약 15초)와 훅 `POST /__devfake/plugin-capabilities` 가 있다.
- `dev:fake` 위 브라우저 검증(BrowserOS neo + Playwright): 11항목 중 9 통과(1 스레드 열기·답·칩, 2 답글 주소 404, 3 390·1280 가로 스크롤 0 — 칩 닫기 초점(m5)은 남아 p4t-c1 이 고쳤다, 4 새로고침·없는 루트, 5 채널·스레드 동시 스트리밍, 6 스레드 「새 대화」, 7 PLUGIN_OUTDATED → 다시 실행, 10 검색 ⌘K·2글자·특수 문자·강조·답글 결과, 11 콘솔 새 오류 0), 8 재접속은 결함 1(20초 넘는 멈춤)을 찾아 p4t-c1 이 원인을 확정하고 고쳤다(같은 재현에서 다시 붙기 22~24초 → 약 3초, Phase 4 이전 커밋에서도 22950ms), 9 푸시 링크는 서비스 워커 안 합성 클릭이 user activation 이 없어 부분 확인(p4t-c1 이 고친 서비스 워커로 이동까지 다시 봤다), 390px 은 항목 3 의 레이아웃만. 확인 못 한 것은 `docs/plan.md` 8장 「이월」.
- 테스트 3190(shared 247·plugin 146·adapter 264·server 1151·web 1382 — 루트 `pnpm test` 의 패키지별 `Tests` 줄).
