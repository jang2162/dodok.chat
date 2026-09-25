# Phase 4 ① 스레드·검색 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`CLAUDE.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나.

**Goal:** 사람이 채널 메시지에서 스레드를 열어 에이전트와 스레드 하위 세션으로 대화하고, 채널·스레드 메시지를 한국어로 전문 검색해 그 자리로 간다.

**Architecture:** 스레드는 `messages.thread_root_id` 로 채널 안에 둔다(`seq` 는 채널 하나를 같이 쓴다). 에이전트 세션 행이 (에이전트, 채널, 스레드) 단위가 되고 세션 키에 `:thread:<rootId>` 가 붙는다 — 키 만들기·풀기는 shared 헬퍼 하나를 서버·어댑터·플러그인이 같이 쓴다. 브리지 계약에 `threadId` 가 생기고 플러그인은 인바운드 사실·아웃바운드 셋(route·handleAction·sendText)을 스레드 인식으로 고친다(ADR 0006). 검색은 FTS5 `trigram` 가상 테이블과 트리거, 1~2글자는 `LIKE`.

**Tech Stack:** Fastify 5 · Socket.IO 4.8 · drizzle-orm 0.45 + better-sqlite3(번들 SQLite — FTS5 trigram) · zod 4 · React 19 + TanStack Router/Query · OpenClaw 플러그인 SDK(2026.9.4 핀, dev Gateway 9.5) — **새 의존성 없음**

**Spec:** `docs/superpowers/specs/2026-09-25-threads-search-design.md` — 결정 0장, 스레드 2~4장, 검색 5장, 보안 6장, 오류 7장, 검증 8장. 근거 ADR `docs/adr/0006-thread-sessions-spike.md`. **태스크를 시작하기 전에 스펙의 해당 장과 ADR 0006 「설계에 주는 제약과 추천」 절을 읽는다.**

## Global Constraints

- **새 npm 의존성은 없다.**
- 세션 키: 채널 `agent:<providerAgentId>:dodok:channel:<channelId>`, 스레드 `agent:<providerAgentId>:dodok:channel:<channelId>:thread:<rootId 소문자>`. **만들기·풀기는 shared 헬퍼(`dodokSessionKey`·`parseDodokSessionKey`)만** 쓴다 — 문자열을 직접 조립하거나 정규식을 따로 두지 않는다.
- 스레드 안의 스레드 없음 — `thread_root_id` 는 루트(`thread_root_id IS NULL`)만 가리킨다.
- 스레드 문맥: 루트 본문 4,000자에서 자름, 스레드 최근 메시지 최대 20개, **채널 최근 대화는 싣지 않는다.**
- 포크 없음(`route.parentSessionKey` 비움). 봇 루프 예산 `conversationId = channelId` 그대로.
- 스레드 세션의 에이전트는 채널 최상위·다른 채널로 쓰지 못한다(플러그인이 고정 사유로 거절).
- 옛 플러그인(hello `capabilities` 에 `"threads"` 없음)으로 스레드 런 → 런 `error` 코드 `PLUGIN_OUTDATED`.
- 검색: FTS5 `tokenize='trigram case_sensitive 0'`, 3글자 이상 `MATCH`(입력은 따옴표 구절 하나), 1~2글자 `LIKE ... ESCAPE`(최근 90일·50개·`limited: true`), 페이지 20, `q` 2~200자, 사용자당 분당 60(`LIMITS.searchPerMin`), 스니펫 앞뒤 64자·표시 `\u0002`/`\u0003`.
- 시크릿 규칙 `docs/guides/live-smoke.md` 「시크릿 규칙」. 5173·3000 금지(웹 5180, dev:fake 3100 대). 프로세스는 자기 PID 로만. Docker `prune` 금지.
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프. 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 생성물(drizzle SQL·meta)은 생성기로. FTS 가상 테이블·트리거처럼 drizzle-kit 이 못 만드는 SQL 은 **커스텀 마이그레이션**(`drizzle-kit generate --custom`)으로 만들어 그 파일에만 손으로 쓴다.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 자기 실행 출력에서 패키지별로(0개는 통과가 아니다).

## Review Focus

1. **스레드 답글에서 「스레드에서 답하기」를 누른 사람** — 스레드 안의 스레드는 없으므로 웹은 그 답글의 루트 스레드를 연다. 서버는 `message.send` 의 `threadRootId` 가 답글을 가리키면 `VALIDATION` 으로 거절한다(웹이 루트를 보낸다) — 조용히 다른 곳에 저장하지 않는다. → 태스크 4(서버)·6(웹).
2. **플러그인을 다시 설치하기 전의 원격 Gateway** — 스레드 멘션은 `PLUGIN_OUTDATED` run_error 카드(재설치 안내)로 끝나고, 같은 채널 최상위 런은 그대로 돈다. 플러그인을 새로 설치한 뒤 「다시 실행」하면 스레드에서 답한다. → 태스크 5.
3. **끊긴 사이 스레드 답글이 온 재접속** — `channel.subscribe` 의 `lastSeq` 재동기화가 루트와 답글을 모두 돌려주고, 웹은 답글을 스레드 캐시에, 루트의 `threadSummary` 를 채널 캐시에 반영한다(칩·패널 둘 다 맞다). → 태스크 4(`scope: "all"`)·6.
4. **특수 문자·FTS 연산자가 든 검색어** — `%`·`_`·`"`·`*`·`OR`·`NEAR(`·`col:` 은 글자 그대로 찾고 오류(500)가 나지 않는다. → 태스크 3.
5. **스레드 세션의 에이전트가 `message` 툴로 최상위·다른 채널을 가리킴** — 플러그인이 고정 사유로 거절하고, 채널 세션 전사에 스레드 전송이 새지 않는다(delivery-mirror). → 태스크 2.

---

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `packages/shared/src/{domain,wire,bridge}/index.ts`·`session-key.ts`(새)·`search/index.ts`(새)·`index.ts` | 1 | 계약·세션 키 헬퍼 |
| `packages/openclaw-plugin/src/{inbound,outbound,channel,context}.ts` | 2 | 스레드 인바운드·아웃바운드·hello |
| `packages/openclaw-adapter/src/{gateway/sessions,gateway/approvals,openclaw-adapter,adapter-types,fake-adapter}.ts` | 2 | 스레드 키·구독·복구·승인·플러그인 능력 |
| `apps/server/src/db/schema.sqlite.ts`·`drizzle/0006_*`·`0007_*`(커스텀) | 3·4 | `thread_root_id`·FTS |
| `apps/server/src/modules/search/{service,routes}.ts` | 3 | 검색 |
| `apps/server/src/modules/messages/{service,routes}.ts`·`realtime/socket.ts` | 4 | 스레드 데이터·`around`·REST |
| `apps/server/src/modules/{sessions,router,runs,components,push}/*` | 5 | 스레드 런 |
| `apps/web/src/features/threads/*`·`app/router.tsx`·`features/messages/*`·`features/composer/*`·`realtime/handlers.ts`·`pwa/*` | 6 | 스레드 화면 |
| `apps/web/src/features/search/*`·`app/layout/Sidebar.tsx` | 7 | 검색 화면 |
| `apps/server/scripts/dev-fake.ts` | 8 | 대본 스레드 |
| 문서 | 9 | plan #19·project-structure·agent-guide·deploy·live-smoke |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 shared 계약·세션 키 | — |
| B | 2 플러그인·어댑터 ‖ 3 검색 서버 ‖ 4 스레드 데이터(서버) | 1 (3·4 는 마이그레이션 번호 — 4 가 0006, 3 이 0007. 3 은 4 병합 뒤 rebase 하고 생성기를 다시 돌린다) |
| C | 5 스레드 런(서버) | 2·4 |
| D | 6 웹 스레드 ‖ 7 웹 검색 | 3·5(6), 3·4(7) |
| E | 8 dev:fake + 브라우저 검증 + 실연 준비 | 6·7 |
| F | 9 실연(런 0 + 모델 런 1~2 — 사용자 승인 뒤) + 문서 | 8 |

---

### Task 1: shared 계약·세션 키 헬퍼

**Files:**
- Create: `packages/shared/src/session-key.ts`, `packages/shared/src/search/index.ts`, `packages/shared/test/session-key.test.ts`, `packages/shared/test/threads-search.test.ts`
- Modify: `packages/shared/src/domain/index.ts`(Message·ThreadSummary), `packages/shared/src/wire/index.ts`(MessageSend·ChannelSubscribe 결과), `packages/shared/src/bridge/index.ts`(InboundDeliver·InboundContext·OutboundMessage·BridgeCapability), `packages/shared/src/index.ts`

**Interfaces — Produces:**

```ts
// session-key.ts — 계획서 10장 #19(태스크 9 가 스레드 접미사를 적는다)
export function dodokSessionKey(providerAgentId: string, channelId: string, threadRootId?: string): string;
//   → "agent:<a>:dodok:channel:<c>" 또는 "...:thread:<rootId 소문자>"
export type ParsedDodokSessionKey = { providerAgentId: string; channelId: string; threadRootId?: string };
/** 우리 모양이 아니면 undefined. channelId·threadRootId 는 소문자 UUID 로 돌려준다 */
export function parseDodokSessionKey(key: string | undefined): ParsedDodokSessionKey | undefined;

// domain
export const ThreadSummary = z.object({ count: z.int().min(1), lastAt: IsoDateTime, agentIds: z.array(Id).max(10) });
// Message 에 threadRootId: Id.optional(), threadSummary: ThreadSummary.optional()

// wire
// MessageSend 에 threadRootId: Id.optional()
// ChannelSubscribe 결과(ChannelSubscribeResult) 모양은 그대로 — lastSeq 가 있으면 messages 에 답글도 들어간다(태스크 4)

// bridge
// BridgeCapability 에 "threads"
// InboundDeliver 에 threadId: Id.optional()
// InboundContext 에 thread: z.object({ root: z.object({ author: InboundAuthor, text: z.string().max(4000), ts: IsoDateTime }),
//                                      recentMessages: z.array(...같은 모양).max(20) }).optional()
// OutboundMessage 에 threadId: Id.optional()
/** 세션 키의 스레드 접미사와 threadId 가 같은가(둘 다 없으면 참). 서버·플러그인이 같이 쓴다 */
export function threadMatchesSessionKey(sessionKey: string, threadId: string | undefined): boolean;

// search/index.ts
export const SearchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  channelId: Id.optional(), authorType: z.enum(["user", "agent"]).optional(), authorId: Id.optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(), cursor: z.string().max(200).optional(),
});
export const SearchHit = z.object({
  messageId: Id, channelId: Id, threadRootId: Id.optional(), authorType: z.enum(["user", "agent"]),
  authorId: Id.optional(), createdAt: IsoDateTime, snippet: z.string().max(400),
});
export const SearchResult = z.object({ hits: z.array(SearchHit), nextCursor: z.string().optional(), limited: z.boolean() });
export const SEARCH_SNIPPET_OPEN = "\u0002"; export const SEARCH_SNIPPET_CLOSE = "\u0003";
```

- [ ] **Step 1: 실패하는 테스트** — `session-key.test.ts`: 채널 키 왕복, 스레드 키 왕복(대문자 UUID 를 넣으면 소문자로 만들고 풀린다), 접미사가 다른 것(`:g2`·`:thread:` 뒤 UUID 아님·앞뒤 공백·`agent:a:other:channel:…`)은 `undefined`, `threadMatchesSessionKey` 네 경우(둘 다 없음·같음·다름·키만 스레드). `threads-search.test.ts`: `SearchQuery` 가 1자·201자·공백만을 거절하고 앞뒤 공백을 잘라 받음, `InboundContext.thread.root.text` 4001자 거절, `ThreadSummary.count` 0 거절.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.**
- [ ] **Step 3: 기존 호출처 컴파일 유지** — 이 태스크는 shared 만 바꾼다. 서버·어댑터·플러그인·웹 typecheck 가 깨지지 않게 새 필드는 모두 선택. 루트 검사 4종.
- [ ] **Step 4: 커밋** — `feat(shared): 스레드·검색 계약과 세션 키 헬퍼`.

---

### Task 2: 플러그인·어댑터 — 스레드 세션

**Files:**
- Modify: `packages/openclaw-plugin/src/inbound.ts`(`dodokSessionKey` 는 shared 로 대체 — 머리주석의 「접미사는 두지 않는다」 삭제), `context.ts`(스레드 헤더), `outbound.ts`(`messageToolSendToOutbound`·`buildOutboundMessage` 에 threadId), `channel.ts`(route·handleAction·sendText·hello·인바운드 디스패치의 `conversation.threadId`·`reply.messageThreadId`)
- Modify: `packages/openclaw-adapter/src/gateway/sessions.ts`(`sessionKeyFor` → shared), `gateway/approvals.ts`(`parseSessionKey` → shared, 스레드 id 돌려줌), `adapter-types.ts`·`openclaw-adapter.ts`·`fake-adapter.ts`(`sessionKeyFor(providerAgentId, channelId, threadRootId?)`, `pluginSupports(cap: "threads"): boolean`, 스레드 키 구독·재접속 복구 대상)
- Test: 각 패키지의 기존 테스트 파일 옆

**Interfaces:**
- Consumes: 태스크 1 `dodokSessionKey`·`parseDodokSessionKey`·`threadMatchesSessionKey`, `InboundDeliver.threadId`·`context.thread`, `OutboundMessage.threadId`, `BridgeCapability "threads"`.
- Produces:

```ts
// adapter-types.ts AgentAdapter
sessionKeyFor(providerAgentId: string, channelId: string, threadRootId?: string): string;
/** 지금 붙은 플러그인이 그 능력을 hello 로 알렸는가(붙은 플러그인이 없으면 false) */
pluginSupports(capability: "threads"): boolean;
// ProviderApproval 의 상관 결과(parseSessionKey)가 threadRootId?: string 를 싣는다
```

- **인바운드(플러그인)**: `toInboundFacts` 는 `d.sessionKey === dodokSessionKey(d.agentId, d.channelId, d.threadId)` 이고 `threadMatchesSessionKey` 여야 한다. 스레드면 디스패치에 `conversation.threadId = d.threadId`, `reply.messageThreadId = d.threadId`. `route.parentSessionKey` 를 넣지 않는다. 헤더(`formatInboundContext`)는 `context.thread` 가 있으면 「최근 대화」 대신 `스레드 루트: [HH:MM] @작성자: 본문` + `스레드 최근:` 줄들.
- **아웃바운드(플러그인)** — ADR 0006 「아웃바운드와 delivery-mirror 누수」 절:
  - `resolveOutboundSessionRoute` → SDK 의 스레드 인식 빌더(`buildThreadAwareOutboundSessionRoute`, precedence `["threadId", "currentSession"]`). 그 헬퍼 이름·모양은 9.4 핀 SDK 타입에서 확인하고, 없으면 ADR 0006 이 쓴 코어 경로를 따라 같은 결과를 내는 코드를 쓴다(보고서에 적는다).
  - `handleAction`: `parseDodokSessionKey(actionCtx.sessionKey)` 로 스레드를 풀어 `OutboundMessage.threadId`. **스레드 세션인데 대상(`to`)이 그 세션 채널의 최상위를 가리키거나 다른 채널이면** 고정 사유 `dodok: 이 대화는 스레드라 이 스레드에만 보낼 수 있습니다` 로 `toolInputError`. `actionCtx.toolContext?.currentThreadTs` 는 대조만(다르면 warn 로그).
  - `sendText`: `ctx.threadId` 를 `OutboundMessage.threadId` 로.
- **hello**: `capabilities: ["run_id_in_outbound", "config.set", "threads"]`.
- **어댑터**: 스레드 키도 인바운드 전에 `sessions.messages.subscribe`, 재접속 때 알려진 스레드 세션 키 전부 재구독. `pluginSupports` 는 마지막 hello 의 capabilities.

- [ ] **Step 1: 실패하는 테스트(플러그인)** — 스레드 인바운드 사실(threadId·messageThreadId·parentSessionKey 없음·conversationId = channelId), 키·threadId 불일치 거절, 스레드 헤더 모양(채널 최근 대화 없음), handleAction 스레드 → `OutboundMessage.threadId`, **스레드 세션이 최상위·다른 채널 지정 → 고정 사유 거절**(Review Focus 5), sendText threadId, route 가 스레드 인식 빌더를 쓴다(스레드 키 입력 → 스레드 세션 키 출력), hello capabilities.
- [ ] **Step 2: 실패하는 테스트(어댑터)** — `sessionKeyFor` 세 인자, 스레드 키 구독이 인바운드 전에 나감, 재접속 재구독에 스레드 키 포함, `parseSessionKey` 스레드 키 → threadRootId, `pluginSupports` 가 hello 에 따라 참·거짓, 플러그인 없음이면 false. FakeAdapter 도 같은 표면.
- [ ] **Step 3: 구현 → 통과.** 플러그인 빌드 가드(`packages/openclaw-plugin/scripts/build.mjs`)가 통과하는지 `pnpm -F @dodok/openclaw-plugin build`.
- [ ] **Step 4: 커밋** — `feat(plugin,adapter): 스레드 하위 세션 — 인바운드·아웃바운드·구독`.

---

### Task 3: 검색 서버

**Files:**
- Create: `apps/server/drizzle/0007_*`(커스텀 — FTS 가상 테이블·트리거·백필), `apps/server/src/modules/search/{service,routes}.ts`, `apps/server/test/search.service.test.ts`, `apps/server/test/search.routes.test.ts`
- Modify: `apps/server/src/modules/ops/limits.ts`(`searchPerMin: 60`), `apps/server/src/app.ts`(부팅 trigram 확인·라우트 등록)

**Interfaces — Produces:**

```ts
// search/service.ts
export function assertTrigramSupport(db: Db): void; // 없으면 throw Error("SQLite FTS5 trigram 을 쓸 수 없다 — …")
export function searchMessages(db: DbOrTx, workspaceId: string, userId: string, q: SearchQuery, now: Date): SearchResult;
// routes: GET /api/v1/search (requireSession, LIMITS.searchPerMin)
```

- 커스텀 마이그레이션: `CREATE VIRTUAL TABLE messages_fts USING fts5(body, attachment_names, content='', tokenize='trigram case_sensitive 0', contentless_delete=1)` — rowid 는 `messages` 의 rowid. INSERT/UPDATE/DELETE 트리거(`kind = 'normal'` 만), 기존 행 백필 `INSERT INTO messages_fts(rowid, body, attachment_names) SELECT rowid, body_md, <attachments_json 의 name 들을 공백으로 이은 것> FROM messages WHERE kind = 'normal'`. `contentless_delete` 가 SQLite 판에서 안 되면 `content='messages'` 외부 콘텐츠 방식으로 바꾸고 보고서에 적는다.
- 3글자 이상: `WHERE messages_fts MATCH '"' || replace(q, '"', '""') || '"'` (구절 하나), `ORDER BY bm25(messages_fts), created_at DESC`. `snippet(messages_fts, 0, char(2), char(3), '…', 16)` 은 토큰 단위라 trigram 에서 글자 수가 흔들린다 — 스니펫은 서버가 본문에서 첫 일치 위치를 찾아 앞뒤 64자로 직접 자른다.
- 1~2글자: `body_md LIKE ? ESCAPE '\'`(`%`·`_`·`\` 이스케이프), `created_at >= now - 90일`, `LIMIT 50`, 최신순, `limited: true`.
- 필터·커서: `channelId`·`authorType`·`authorId`·`from`/`to`(서버 현지 날짜 경계), 커서는 불투명 문자열(`base64url(JSON {rank, createdAt, id})`). 멤버십: 사용자가 멤버인 채널만(지금 워크스페이스 전부 — `channel_members` 로 거르는 자리를 둔다).

- [ ] **Step 1: 실패하는 테스트** — 트리거 동기화(삽입 → 찾힘, 본문 수정 → 옛 말 안 찾힘·새 말 찾힘, 삭제 → 안 찾힘, 시스템 메시지 안 찾힘), 한국어 「배포를 마쳤다」 에서 `배포를`·`마쳤다`(3글자) 찾힘, 2글자 `배포` → LIKE 경로·`limited: true`·90일 밖 안 찾힘, **특수 문자·연산자 `%`·`_`·`"`·`*`·`OR`·`NEAR(`·`body:` → 글자 그대로, 500 없음**(Review Focus 4), 필터·커서 두 페이지, 첨부 이름으로 찾힘, 스니펫 64자·표시 문자, 스레드 답글 결과에 `threadRootId`, 레이트리밋 61번째 429, 익명 401, `q` 1자·201자 400.
- [ ] **Step 2: 마이그레이션 생성**(`pnpm -F @dodok/server exec drizzle-kit generate --custom --name search_fts`) → SQL 작성 → 기존 DB(0006 까지)에 적용되는지 테스트.
- [ ] **Step 3: 구현 → 통과.** `assertTrigramSupport` 를 부팅에 — 번들 스모크(`pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`)가 통과해야 한다.
- [ ] **Step 4: 커밋** — `feat(server): 메시지 전문 검색 — FTS5 trigram`.

---

### Task 4: 스레드 데이터(서버) — 저장·조회·wire·REST

**Files:**
- Modify: `apps/server/src/db/schema.sqlite.ts`(`messages.threadRootId`·인덱스, `agentSessions.threadRootId`·유일 제약 (channel, agent, thread), `runs.threadRootId` — 태스크 5 가 쓴다, 마이그레이션을 한 번에 두려고 여기서 만든다) → `drizzle/0006_*`(생성기)
- Modify: `apps/server/src/modules/messages/{service,routes}.ts`, `apps/server/src/realtime/socket.ts`(`message.send`·`channel.subscribe`)
- Test: `apps/server/test/messages.threads.test.ts`, 기존 messages·socket 테스트

**Interfaces — Produces:**

```ts
// messages/service.ts
export type MessageScope = "roots" | "all" | { threadRootId: string };
export type ListMessagesOptions = { limit: number; beforeSeq?: number; afterSeq?: number; aroundSeq?: number; scope?: MessageScope }; // 기본 "roots"
export function threadSummaryOf(db: DbOrTx, rootId: string): ThreadSummary | undefined;
// createUserMessage / createAgentMessage 입력에 threadRootId?: string — 저장 뒤 루트의 threadSummary 를 다시 계산해 bus "message.updated"(루트)
// rowToMessage 가 threadRootId, (루트면) threadSummary 를 싣는다 — listMessages 는 한 번의 집계 쿼리로 붙인다(N+1 금지)
```

- `message.send` 의 `threadRootId`: 같은 채널·`thread_root_id IS NULL` 인 메시지여야 한다. 답글·다른 채널·없음 → `VALIDATION`(Review Focus 1). 멱등 재전송(같은 clientMsgId)은 그대로.
- `channel.subscribe`: `lastSeq` 가 없으면 `scope: "roots"`, 있으면 `scope: "all"`(재동기화 — Review Focus 3).
- REST: `GET /api/v1/channels/:id/messages?around=<seq>&limit=`(스코프 roots, 그 seq 가 답글이면 그 루트를 가운데로), `GET /api/v1/channels/:id/threads/:rootId/messages?before&after&around&limit`(루트 + 답글, 오래된 순).
- 이 태스크는 **에이전트 런을 건드리지 않는다**(라우터는 스레드 답글을 아직 채널처럼 다룬다 — 태스크 5 가 바꾼다). 단 라우터가 스레드 답글로 런을 만들지 않게 태스크 5 전까지 `threadRootId` 가 있는 메시지는 라우팅을 건너뛰고 warn 로그(임시 — 태스크 5 가 지운다, 주석에 태스크 번호).

- [ ] **Step 1: 실패하는 테스트** — 스레드 답글 저장(`threadRootId`·seq 연속), 루트 요약(count·lastAt·agentIds 최대 10)과 `message.updated`(루트), 답글에 루트 지정 → VALIDATION(Review Focus 1)·다른 채널·없는 id, `listMessages` roots/all/thread 스코프·before/after/around, subscribe lastSeq → 답글 포함(Review Focus 3), REST 두 경로(권한 — 다른 워크스페이스 채널 404), `around` 가 답글 seq 면 루트 중심, 루트 요약 쿼리 N+1 없음(쿼리 수 스파이).
- [ ] **Step 2: 마이그레이션 생성** → 세 열(messages·agent_sessions·runs)·인덱스·유일 제약만 있는지 SQL 확인.
- [ ] **Step 3: 구현 → 통과.** 기존 `ensureSession` 은 이 태스크에서 스레드 인자 없이 그대로 동작해야 한다(유일 제약이 (channel, agent, NULL thread) 로 기존 행을 지킨다 — SQLite 의 NULL 유일성 주의: `thread_root_id` 를 NULL 로 두면 같은 (channel, agent) 두 행이 막히지 않는다. **유일 인덱스를 `(channel_id, agent_id, coalesce(thread_root_id, ''))` 표현식 인덱스로** 만들거나 채널 세션 행을 `''` 로 저장하고 까닭을 주석에).
- [ ] **Step 4: 커밋** — `feat(server): 스레드 데이터 — 저장·요약·스코프 조회·around`.

---

### Task 5: 스레드 런(서버)

**Files:**
- Modify: `apps/server/src/modules/sessions/service.ts`(`ensureSession({channelId, agentId, threadRootId?})`·`markSessionReset(…, threadRootId?)`), `modules/router/{decide,service}.ts`(스레드 답글 라우팅·루트 에이전트 규칙 — 태스크 4 의 임시 건너뛰기 삭제), `modules/runs/{context,orchestrator,store}.ts`(스레드 문맥·`threadId` 인바운드·`PLUGIN_OUTDATED`·정본 스레드 대조·에이전트 메시지 `threadRootId`), `modules/components/service.ts`(카드·이어가기·다시 실행 런이 스레드 메시지면 스레드 런), `modules/channels/routes.ts`(「새 대화」 스레드 인자), `modules/push/*`(스레드 멘션 문구·링크), `realtime/socket.ts`(필요하면)
- Test: `apps/server/test/integration/threads.test.ts` + 단위

**Interfaces:**
- Consumes: 태스크 2 `sessionKeyFor(…, threadRootId?)`·`pluginSupports("threads")`, 태스크 4 `threadRootId`·`scope`.
- Produces: `RunPlan.threadRootId?: string`(`router/decide.ts`), 런 행의 `thread_root_id` 채우기(열은 태스크 4 마이그레이션에 있다), REST `POST /api/v1/channels/:id/agents/:agentId/reset?threadRootId=`.

- 라우팅(스펙 2.2): 스레드 답글(사람) — 멘션 에이전트마다 스레드 런, 멘션 없으면 ① 루트가 에이전트 메시지면 그 에이전트(활성·채널 멤버일 때) ② 채널 자동 응답 에이전트. 에이전트 스레드 답글 — 멘션이 릴레이(같은 스레드). 사슬·반복·쌍 허용·관문 그대로.
- 문맥(스펙 2.3): `buildInboundDeliver` 가 스레드 런이면 `threadId`, `context.thread`(루트 4,000자·스레드 최근 20, 트리거 앞), `context.recentMessages` 는 **빈 배열**. 세션 행은 (에이전트, 채널, 스레드).
- 디스패치 전: 스레드 런인데 `adapter.pluginSupports("threads")` 가 거짓이면 런을 `error{code:"PLUGIN_OUTDATED"}` 로 끝낸다 — `notifyRunError` 가 알리는 코드에 더하고 본문 「@dev 가 스레드에서 답하지 못했습니다 — 플러그인을 새로 설치해야 합니다(연결 페이지)」, 「다시 실행」 버튼 유지(Review Focus 2).
- 정본(`onCanonical`): `threadMatchesSessionKey(msg.sessionKey, msg.threadId)` 이고 런의 스레드와 같아야 저장 — 아니면 거절·warn. 저장하는 에이전트 메시지 `threadRootId` = 런의 스레드. 시스템 메시지(한도·실패·릴레이)도 그 스레드에.
- 「새 대화」: 스레드 인자가 있으면 그 스레드 세션만 `resetSession`.
- 푸시: 스레드 멘션 문구 「@dev가 #채널 스레드에서 불렀습니다」, 링크 `/c/<id>/t/<rootId>`.

- [ ] **Step 1: 실패하는 통합 테스트**(가짜 Gateway·플러그인 — 가짜 플러그인이 hello 에 `threads` 를 싣게) — 스레드 멘션 → 인바운드 세션 키 `…:thread:<root>`·`threadId`·`context.thread`·`recentMessages` 빔 → 정본이 스레드에 저장·루트 요약 갱신 · 멘션 없는 스레드 답글: 루트가 에이전트 메시지 → 그 에이전트 / 사람 루트 → 자동 응답 · 채널 런과 스레드 런 동시 진행(세션 큐 병렬) · 같은 스레드 두 멘션은 직렬 · 스레드 릴레이가 스레드 안 · 한도가 스레드 런도 셈 · 스레드 「새 대화」는 스레드 세션만 · **hello 에 threads 없음 → PLUGIN_OUTDATED 카드, 채널 런은 정상**(Review Focus 2) · 정본 threadId 불일치 거절 · 카드 버튼(스레드 안 메시지) → 스레드 런 · 다시 실행(스레드) → 스레드 런 · 스레드 멘션 푸시 문구·링크.
- [ ] **Step 2: 구현 → 통과.** 태스크 4 의 임시 건너뛰기를 지운다.
- [ ] **Step 3: 커밋** — `feat(server): 스레드 하위 세션 런 — 라우팅·문맥·정본·리셋·푸시`.

---

### Task 6: 웹 — 스레드

**Files:**
- Create: `apps/web/src/features/threads/{ThreadPanel,ThreadChip,useThread,queries}.tsx|ts` + 테스트
- Modify: `apps/web/src/app/router.tsx`(`/c/$channelId/t/$rootId` — 채널 라우트 자식), `features/messages/{MessageItem,MessageList,useTimeline,timeline}.ts(x)`(루트만·칩·메뉴 「스레드에서 답하기」), `features/composer/*`(스레드 작성기 — `threadRootId`), `realtime/handlers.ts`(답글은 스레드 캐시, 루트 `message.updated` 는 채널 캐시), `app/layout/PanelTabs.tsx`(스레드 탭), `pwa/*`(오프라인 사본에 연 스레드 마지막 페이지), 채널 설정의 에이전트 줄 「새 대화」(스레드 패널 안 복사본)

**Interfaces:** Consumes 태스크 4 REST·wire, 태스크 5 리셋 REST.

- 답글에서 「스레드에서 답하기」 → 그 답글의 루트 스레드를 연다(Review Focus 1). 칩 「답글 N · 마지막 시각 · 에이전트 아바타(최대 3)」.
- 스레드 패널: 넓은 화면은 오른쪽 패널 탭, 좁은 화면 전체 시트. 루트·답글(스트리밍 버블·카드·첨부·승인·시스템 메시지 포함 — 기존 행 컴포넌트 재사용), 위로 스크롤하면 이전 페이지, 작성기(`@` 자동완성 — 채널 멤버), 에이전트별 「새 대화」.
- URL 새로고침·푸시 링크로 바로 열림. 없는 루트면 「스레드를 찾을 수 없습니다」.
- 재접속 재동기화(Review Focus 3): subscribe ack 의 답글을 스레드 캐시에(열려 있지 않은 스레드는 버리고 루트 요약만).

- [ ] **Step 1: 실패하는 테스트** — 칩·메뉴, 답글에서 열기 → 루트 스레드, 패널 목록·이전 페이지·작성기 전송(`threadRootId`), 스트리밍 버블이 스레드 안에, 채널 타임라인에 답글이 안 나옴, URL 로 열기·없는 루트, 390px 시트, 재동기화, 스레드 「새 대화」, 오프라인 사본.
- [ ] **Step 2: 구현 → 통과, 웹 빌드.**
- [ ] **Step 3: 커밋** — `feat(web): 스레드 — 칩·패널·작성기·URL`.

---

### Task 7: 웹 — 검색

**Files:**
- Create: `apps/web/src/features/search/{SearchDialog,SearchResults,useSearch,highlight}.tsx|ts` + 테스트
- Modify: `app/layout/Sidebar.tsx`(검색 칸), 전역 단축키(`⌘K`/`Ctrl+K`), `features/messages/{useTimeline,MessageList}`(`around` 로 갈아 끼우기·강조), 태스크 6 의 스레드 패널 열기(답글 결과)

- 스니펫 표시 문자(`\u0002`/`\u0003`)를 `<mark>` 로 — `dangerouslySetInnerHTML` 쓰지 않는다(글자 조각 배열로 렌더).
- 결과 누름 → 채널 이동 → `around` 페이지 → 그 메시지로 스크롤·2초 강조(`prefers-reduced-motion` 면 색만). 답글이면 스레드 패널을 그 답글 위치로.
- 짧은 검색어면 「1~2글자는 최근 90일에서 50개까지만 찾습니다」.

- [ ] **Step 1: 실패하는 테스트** — `⌘K`·`Ctrl+K`·Esc, 입력 디바운스·요청, 스니펫 강조(HTML 주입 문자열이 글자로 나옴), 필터, 더 보기(커서), limited 문구, 결과 → around 이동·강조, 답글 결과 → 스레드 패널, 390px 시트, 결과 없음·오류.
- [ ] **Step 2: 구현 → 통과, 웹 빌드.**
- [ ] **Step 3: 커밋** — `feat(web): 검색 — ⌘K 대화상자·결과로 가기`.

---

### Task 8: dev:fake + 브라우저 검증

- [ ] `apps/server/scripts/dev-fake.ts`: 가짜 플러그인 hello 에 `threads`, 대본에 스레드 답(멘션한 스레드로 답)·스레드 릴레이, 개발 전용 훅 `POST /__devfake/plugin-capabilities {threads:boolean}`(옛 플러그인 흉내 — owner 세션·application/json·운영 번들에 없음, 기존 훅과 같은 규칙). 테스트.
- [ ] 브라우저 검증(dev:fake 3100 대 + 웹 5180, Playwright 스크래치 프로필, CDP 로 붙을 때마다 `setViewportSize`, 390·1280px, **네가 연 탭·브라우저는 네가 닫아라**): 스레드 열기·답·칩·패널·390px 시트·URL 새로고침·푸시 링크(서비스 워커 합성 클릭) · 답글에서 열기 → 루트 · 채널·스레드 동시 스트리밍 · 스레드 새 대화 · 옛 플러그인 훅 → PLUGIN_OUTDATED 카드 → 훅 되돌림 → 다시 실행 · 재접속(wire 끊기) 뒤 스레드 답글·칩 · 검색 `⌘K`·한국어 조사·2글자·특수 문자·결과 이동·강조·스레드 답글 결과.
- [ ] 결함은 조율자가 수정 워커로.

### Task 9: 실연 + 문서

- [ ] 실연(dev Gateway, 스크래치 `openclaw@2026.9.5`, live-smoke 「런 0회 하네스」): 새 플러그인 설치 → 스레드 멘션 → 스레드 세션 키·답이 스레드 → **채널 세션 전사에 스레드 전송이 없음**(delivery-mirror 누수 없음 — ADR 0006 재현 방법) → 스레드 릴레이 → 채널·스레드 동시 → 스레드 리셋. **모델 런 1~2회는 사용자 승인 뒤**: 스레드에서 `message` 툴(카드)·최종 답이 스레드로 오는지, 최종 답 억제. 결과 `docs/guides/live-smoke.md` 새 절, ADR 0006 「확인 못 한 것」에서 잰 것.
- [ ] 문서: `docs/plan.md` 10장 #19 에 스레드 접미사·8장 Phase 4 ① 완료·이월, `docs/project-structure.md`(threads·search 모듈·FTS·세션 키 헬퍼), `docs/guides/agent-guide.md` 「스레드」 절(에이전트가 스레드에서 받는 헤더·최상위 금지·세션이 따로라는 것), `docs/guides/deploy.md`(이 버전부터 플러그인 재설치 — 「업데이트」 절), `docs/guides/live-smoke.md` 「런 0회 하네스」 에 스파이크가 찾은 세 줄(가짜 CLI 는 claude 전사를 안 만들어 둘째 턴이 새 세션 / 시스템 프롬프트는 stdin `initialize.appendSystemPrompt` / zsh 에서 `$B:thread` 는 `${B}:thread`), 스펙 「구현과 맞춘 것」. `CLAUDE.md`(불변 규칙의 세션 키·현재 단계)는 조율자.

---

## Self-Review (계획 작성 때 한 것)

- **스펙 대조**: 결정 1~8 → T1~T7 · 2.1 DB → T4(+T5 runs) · 2.2 라우팅 → T5 · 2.3 문맥 → T2(헤더)·T5 · 2.4 리셋 → T5·T6 · 3.1 키 → T1·T2 · 3.2 계약·PLUGIN_OUTDATED → T1·T5 · 3.3 플러그인 → T2 · 3.4 어댑터 → T2 · 3.5 저장·요약 → T4·T5 · 4.1 계약 → T1·T4 · 4.2 웹 → T6 · 5.1 색인 → T3 · 5.2 API → T3 · 5.3 around → T4·T7 · 5.4 웹 → T7 · 6장 보안 → T2(대조·최상위 거절)·T3(구절 주입) · 7장 오류 → 각 태스크 · 8장 검증 → T1~T9.
- **계획에서 정한 것(스펙에 없던 세부)**: `listMessages` 스코프(`roots`/`all`/thread) — 재동기화가 답글을 놓치지 않게. `agent_sessions` 유일 제약의 NULL 함정(표현식 인덱스). 스니펫은 서버가 직접 자름(trigram 토큰 단위 스니펫이 흔들려서). 태스크 4 동안 스레드 답글 라우팅 임시 건너뛰기. dev:fake 옛 플러그인 훅.
- **자리표시**: 마이그레이션 파일 이름은 생성기가 정한다. SDK 스레드 인식 빌더 이름은 T2 가 9.4 타입에서 확인(없으면 대체 경로·보고).
- **타입 일관성**: `dodokSessionKey`/`parseDodokSessionKey`/`threadMatchesSessionKey`(T1) = T2·T5 · `sessionKeyFor(…, threadRootId?)`·`pluginSupports`(T2) = T5 · `MessageScope`·`threadSummaryOf`(T4) = T5·T6 · `SearchQuery`/`SearchResult`(T1) = T3·T7.
- **Review Focus**: 1 → T4 Step 1·T6 · 2 → T5 Step 1·T8 · 3 → T4 Step 1·T6 · 4 → T3 Step 1 · 5 → T2 Step 1.
