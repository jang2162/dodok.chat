# 리액션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`CLAUDE.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나. 태스크마다 main 에 병합해도 초록이어야 한다.

**Goal:** 사람이 보통 메시지에 고정 이모지 8종으로 리액션을 달고, 에이전트가 쓴 메시지에 달린 리액션은 그 에이전트의 다음 런 인바운드에 사실로 실린다.

**Architecture:** 원본 표 `message_reactions` 와 서버 모듈 `modules/reactions/` 가 쓰기·집계·「아직 안 알린 것」 질의를 맡고, 집계는 기존 `hydrateForClient` 에 끼워 모든 클라이언트 경로가 받는다. 세션 행의 커서 `reactions_seen_at` 으로 안 알린 리액션을 골라 오케스트레이터가 런의 `InboundContext.reactions` 에 싣고, `send` 가 받아들여지면 커서를 올린다. 문구는 shared `formatReactionFacts` 하나를 플러그인 헤더와 러너 턴 사실이 함께 쓴다.

**Tech Stack:** Fastify 5 · Socket.IO 4.8 · drizzle-orm 0.45 + better-sqlite3 · zod 4 · React 19 + TanStack Query. **새 의존성 없음.**

**Spec:** `docs/superpowers/specs/2026-10-05-reactions-design.md` — 결정 0장, 대상 2장, 데이터 모델 3장, 계약 4장, 서버 5장, 웹 6장, 권한 7장, 오류 8장, 검증 9장, 완료 기준 10장. **태스크를 시작하기 전에 스펙의 해당 장을 읽는다.**

## Global Constraints

- 이모지는 `REACTION_EMOJIS = ["👍", "👎", "❤️", "😂", "🎉", "👀", "✅", "❓"]` 하나(shared). 다른 곳에 목록을 다시 적지 않는다.
- 리액션은 `kind = "normal"` 메시지에만. 런을 시작하지 않고, 읽지 않음·푸시에 영향이 없다.
- wire `reaction.set {messageId, emoji, on}` — 켜기/끄기(토글 아님), 버킷 `chatter`, 상태가 바뀌었을 때만 `message.updated`.
- 에이전트에게는 **그 에이전트가 쓴 메시지**의 리액션만, **그 세션 범위**(채널 = 최상위, 스레드 = 루트 + 그 답글)만, 런마다 **최근 20개** + `reactionsOmitted`.
- 커서는 `send` 가 받아들여졌을 때만 올린다. 리셋·러너 세션 새로 열기 때는 그 시각으로 올린다. 커서가 null 이면 싣지 않는다.
- 에이전트 문구는 shared `formatReactionFacts` 만 만든다(스펙 4.4 의 글 그대로).
- 플러그인은 바뀐다(재설치 필요). `dodok-runner` CLI 는 바뀌지 않는다.
- 외부 입력은 경계에서 Zod 파싱. shared 는 Node 전용 API 금지. 레이트리밋 숫자는 `apps/server/src/modules/ops/limits.ts` 한곳(새 숫자 없음).
- 웹 문구는 합쇼체: 「반응 추가」, 실패 토스트 「반응을 저장하지 못했습니다」, 나간 멤버 「나간 멤버 @옛핸들」.
- 포트 5173·3000 금지(사용자 인스턴스 3100·5180 도 건드리지 않는다 — 워커는 브리프가 주는 포트). 프로세스는 자기 PID 로만, `pkill` 금지. **모델 런 없음**(실연은 런 0회 하네스).
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프(`feat(shared)`·`feat(server)`·`feat(plugin)`·`feat(runner-adapter)`·`feat(web)`). 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 생성물(drizzle SQL·meta)은 `pnpm -F @dodok/server db:generate`. 기존 세션 행 채우기 SQL 만 생성된 파일 끝에 손으로 덧붙이고, 다시 generate 해 「No schema changes」.
- 읽지 않음 계획(`docs/superpowers/plans/2026-10-05-unread.md`)과 마이그레이션 번호가 겹칠 수 있다 — **먼저 병합된 쪽이 `0015`**, 나중 쪽은 병합 전에 rebase 하고 generate 를 다시 돌려 번호를 맞춘다.
- 문서·주석을 쓰기 전에 `docs/guideline/base/03-comments.md`·`04-citation.md` 를 읽는다.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 자기 실행 출력에서 패키지별로(0개는 통과가 아니다). 웹을 바꿨으면 `pnpm -F @dodok/web build`, 서버를 바꿨으면 `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`, 플러그인을 바꿨으면 그 패키지 빌드.

## 계획 판정 (스펙과 맞춘 것)

태스크 5 가 스펙에 「구현과 맞춘 것」 장을 만들어 옮긴다.

- **PR1 — 반응은 `buildInboundDeliver` 가 아니라 오케스트레이터가 싣는다.** 오케스트레이터는 `buildInboundDeliver` 뒤에 `renewSessionOnPromptChange` 를 부른다(`apps/server/src/modules/runs/orchestrator.ts` 의 런 보내기 자리). 세션을 새로 열면 커서가 그 시각으로 오르므로, 반응은 **그 판정 뒤에** 세션 행을 다시 읽어 `pendingReactionsFor` 로 고르고 `inbound.context.reactions`·`reactionsOmitted` 를 채운다. 실은 것 가운데 가장 늦은 `created_at` 은 지역 변수로 들고 있다가 `send` 결과가 받아들여진 경로(`admission` 이 `drop` 이 아닌 곳)에서 `advanceReactionCursor`.
- **PR2 — 좁은 화면의 「기존 메시지 메뉴」는 없다.** 「반응 추가」는 메시지 행의 동작 줄(넓은 화면은 마우스 올림·초점 때 나타나는 타임스탬프와 같은 규칙)에 두고, 마우스가 없는 기기(`@media (hover: none)`)에서는 늘 보이는 작은 아이콘으로 둔다.
- **PR3 — 세션 행을 만드는 자리는 `apps/server/src/modules/sessions/service.ts` 의 두 insert**(`ensureSession` 쪽과 `markSessionReset` 쪽 upsert)다. 둘 다 `reactionsSeenAt: now` 를 넣고, `markSessionReset` 은 기존 행 갱신에도 넣는다. 러너 세션을 새로 여는 `renewSessionOnPromptChange` 도 `reactionsSeenAt` 을 지금으로 올린다.
- **PR4 — `withReactions` 는 `hydrateForClient` 의 안쪽에 둔다**: `withThreadSummaries(db, withReactions(db, withInteractions(db, msgs)))`. `message.created` 팬아웃은 지금 `withInteractions` 만 거치므로 `withReactions` 도 거치게 한다(새 메시지는 빈 배열이지만 `Message.reactions` 기본값이 있어 생략돼도 안전하다 — 그래도 같은 경로를 지난다).
- **PR5 — 반응 질의의 메시지 본문 앞 60자는 `apps/server/src/modules/search/readable.ts` 의 읽는 글 변환**(멘션 → `@핸들`, 마크다운 표시 걷기)을 거친 뒤 자른다.

## Review Focus

1. **같은 사람이 같은 이모지를 빠르게 두 번 누름(켜기 → 끄기가 순서 바뀌어 도착)** — 마지막에 누른 상태가 남아야 한다. 웹은 마지막 요청만 화면 정본으로 두고, 서버 `message.updated` 가 오면 그것으로 맞춘다. → 태스크 4.
2. **리액션이 달린 뒤 그 에이전트의 다음 런이 대기열에 있다가 `send` 전에 abort 됨** — 커서가 오르지 않아 그다음 런에 실린다. → 태스크 2.
3. **에이전트 메시지가 스레드 루트이고, 루트에 리액션 + 그 스레드 런 + 채널 런** — 루트 리액션은 스레드 런에만 실린다(채널 범위는 `thread_root_id IS NULL` 이지만 루트 자신도 `thread_root_id` 가 null 이므로 채널 런에도 걸린다 — 그래서 **루트에 달린 리액션은 채널·스레드 두 세션 모두에 실린다**: 루트는 두 세션이 다 아는 메시지다). 두 세션의 커서는 따로 오른다. → 태스크 2.
4. **에이전트를 채널에서 뺐다가 다시 넣음 / 에이전트 메시지를 다른 사람이 단 리액션이 21개 이상** — 빠진 동안 쌓인 것은 다시 넣은 뒤 첫 런에 최근 20개 + 「외 n개」. → 태스크 2.
5. **나간 멤버가 단 리액션** — 칩 툴팁 「나간 멤버 @옛핸들」, 에이전트 문구의 `by` 는 옛 핸들. → 태스크 1(질의)·4(툴팁).

각 줄의 테스트는 해당 태스크의 단계에 들어 있다. 3번은 스펙의 「범위」 정의를 루트에 적용한 결과다 — 태스크 5 가 스펙 「구현과 맞춘 것」에 적는다.

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `packages/shared/src/domain/index.ts`·`bridge/index.ts`·`wire/index.ts`·`reactions/index.ts`(새)·`index.ts` | 1 | `REACTION_EMOJIS`·`ReactionEmoji`·`MessageReaction`·`Message.reactions`·`InboundReaction`·`InboundContext.reactions`·`reactionsOmitted`·`ReactionSet`·`formatReactionFacts` |
| `apps/server/src/db/schema.sqlite.ts`·`drizzle/00xx_*` | 1 | `message_reactions`, `agent_sessions.reactions_seen_at` |
| `apps/server/src/modules/reactions/service.ts`(새)·`modules/messages/service.ts` | 1 | `setReaction`·`withReactions`·`pendingReactionsFor`·`advanceReactionCursor`, 하이드레이션 |
| `apps/server/src/realtime/{socket,events}.ts`·`modules/runs/orchestrator.ts`·`modules/sessions/service.ts` | 2 | wire 처리기, 팬아웃 하이드레이션, 런에 싣기·커서 |
| `packages/openclaw-plugin/src/context.ts`·`packages/runner-adapter/src/runner-adapter.ts`·`packages/shared/src/runner/prompt.ts` | 3 | 헤더 블록·턴 사실 블록 |
| `apps/web/src/features/reactions/*`(새)·`features/messages/MessageItem.tsx` | 4 | 피커·칩·낙관적 갱신 |
| 문서·`apps/server/scripts/dev-fake.ts`(필요하면 인바운드 로그) | 5 | 검증·실연·문서 |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 계약·표·서비스 | — |
| B | 2 서버 wire·런 싣기 ‖ 3 어댑터 블록 | 1 |
| C | 4 웹 | 2 |
| D | 5 검증·실연·문서 | 3·4 |

---

### Task 1: 계약·표·리액션 서비스

**Files:**
- Modify: `packages/shared/src/domain/index.ts`, `packages/shared/src/bridge/index.ts`, `packages/shared/src/wire/index.ts`, `packages/shared/src/index.ts`; Create: `packages/shared/src/reactions/index.ts`
- Modify: `apps/server/src/db/schema.sqlite.ts`; Create(생성기 + 채우기): `apps/server/drizzle/00xx_*.sql`·meta
- Create: `apps/server/src/modules/reactions/service.ts`; Modify: `apps/server/src/modules/messages/service.ts`(`hydrateForClient`)
- Test: `packages/shared/test/reactions.test.ts`(새), `apps/server/test/reactions.service.test.ts`(새), `apps/server/test/db.test.ts`

**Interfaces:**
- Produces(shared):

```ts
// domain/index.ts
export const REACTION_EMOJIS = ["👍", "👎", "❤️", "😂", "🎉", "👀", "✅", "❓"] as const;
export const ReactionEmoji = z.enum(REACTION_EMOJIS);
export type ReactionEmoji = z.infer<typeof ReactionEmoji>;
export const MessageReaction = z.object({ emoji: ReactionEmoji, count: z.int().min(1), userIds: z.array(Id) });
export type MessageReaction = z.infer<typeof MessageReaction>;
// Message 에: reactions: z.array(MessageReaction).max(REACTION_EMOJIS.length).default([]),

// bridge/index.ts
export const InboundReaction = z.object({
  messageId: Id, excerpt: z.string().max(60), emoji: ReactionEmoji, by: z.string(), at: IsoDateTime,
});
export type InboundReaction = z.infer<typeof InboundReaction>;
// InboundContext 에: reactions: z.array(InboundReaction).max(20).optional(), reactionsOmitted: z.int().min(1).optional(),

// wire/index.ts
export const ReactionSet = z.object({ messageId: Id, emoji: ReactionEmoji, on: z.boolean() });
// ClientToServerEvents: "reaction.set": (p: ReactionSet, ack: Ack<null>) => void;

// reactions/index.ts
/** 스펙 4.4 의 글. 비면 "" */
export function formatReactionFacts(reactions: readonly InboundReaction[], omitted?: number): string;
```

- Produces(서버 `modules/reactions/service.ts`):

```ts
export function setReaction(db: Db, bus: ServerBus, workspaceId: string, userId: string, input: ReactionSet, now: Date): void;
export function withReactions(db: DbOrTx, msgs: Message[]): Message[];
export function pendingReactionsFor(db: DbOrTx, q: { channelId: string; agentId: string; threadRootId: string | null; since: Date | null }):
  { reactions: InboundReaction[]; omitted?: number; latestAt?: Date };
export function advanceReactionCursor(db: DbOrTx, sessionRowId: string, to: Date): void;
```

- Produces(DB): `messageReactions`(`messageId` FK cascade·`userId` FK users cascade·`emoji`·`createdAt`, PK `(message_id, user_id, emoji)`, 인덱스 `message_reactions_message`·`message_reactions_created`), `agentSessions.reactionsSeenAt`(nullable `ts`).

- [ ] **Step 1: 실패하는 테스트 — shared.** `reactions.test.ts`: `ReactionEmoji` 가 `"🔥"` 거절 · `formatReactionFacts([])` 는 `""` · 두 개면 스펙 4.4 의 머리줄 + `- @mia 👍 "…"` 줄 둘(`at` 오름차순으로 정렬해 넣어도 순서가 맞음) · `omitted 3` 이면 끝 줄 `(외 3개)` · **옛 스키마 호환**: `InboundContext.omit({ reactions: true, reactionsOmitted: true })` 로 만든 사본이 `reactions` 가 든 페이로드를 성공으로 파싱하고 그 키를 버림 · `Message` 를 `reactions` 없이 파싱하면 `[]`.
- [ ] **Step 2: 실패하는 테스트 — 서비스.** `reactions.service.test.ts`(기존 `test/helpers/db.ts`·`seed.ts`, 버스는 기록하는 가짜):
  - 켜기 → 행 1·이벤트 1, 같은 켜기 다시 → 이벤트 없음, 끄기 → 행 0·이벤트 1, 같은 끄기 다시 → 이벤트 없음.
  - 시스템 메시지 → `VALIDATION`, 없는 메시지·다른 워크스페이스 → `NOT_FOUND`.
  - `withReactions`: 이모지 순서가 `REACTION_EMOJIS` 순, `userIds` 는 단 순서, 리액션 없는 메시지는 `[]`, 메시지 여럿이면 질의 한 번(질의 수를 세지 못하면 결과 단언만).
  - `pendingReactionsFor`: 채널 범위는 그 에이전트의 최상위 메시지(스레드 루트 포함 — Review Focus 3) · 스레드 범위는 루트 + 그 스레드 답글 · 다른 에이전트·사람 메시지 제외 · `since` 이후만 · `since: null` 이면 빈 결과 · 지운 리액션 없음 · 25개면 최근 20개(`at` 오름차순으로 돌려줌)와 `omitted 5`·`latestAt` 은 가장 늦은 것 · 나간 멤버는 `by` 가 옛 핸들(Review Focus 5) · `excerpt` 는 멘션 토큰이 `@핸들` 로 풀린 앞 60자.
  - `advanceReactionCursor` 는 뒤로 가지 않음.
- [ ] **Step 3: 실패하는 테스트 — 마이그레이션.** `db.test.ts`: 직전 마이그레이션까지 적용한 DB 의 `agent_sessions` 행 둘이 새 마이그레이션 뒤 `reactions_seen_at` 이 null 이 아님.
- [ ] **Step 4: 실패 확인.** `pnpm -F @dodok/shared test` · `pnpm -F @dodok/server test -- reactions db`.
- [ ] **Step 5: 구현.**
  - 스키마 표·열을 더하고 `db:generate`, 생성 SQL 끝에:

```sql
--> statement-breakpoint
UPDATE `agent_sessions` SET `reactions_seen_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE `reactions_seen_at` IS NULL;
```

  - `pendingReactionsFor` 질의(범위 조건만 다르다):

```sql
SELECT r.message_id, r.emoji, r.created_at, m.body_md, m.mentions_json,
       COALESCE(u.left_handle, u.handle) AS by_handle
FROM message_reactions r
JOIN messages m ON m.id = r.message_id
JOIN users u ON u.id = r.user_id
WHERE m.channel_id = :channelId AND m.author_type = 'agent' AND m.author_id = :agentId
  AND r.created_at > :since
  AND <채널: m.thread_root_id IS NULL | 스레드: (m.id = :root OR m.thread_root_id = :root)>
ORDER BY r.created_at DESC
LIMIT 20
```

    + 같은 조건의 `COUNT(*)` 로 `omitted = total - 20`(양수일 때만). 결과를 뒤집어 오름차순으로. `excerpt` 는 PR5.
  - `hydrateForClient` 는 PR4.
- [ ] **Step 6: 통과 확인** — 실행 개수.
- [ ] **Step 7: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 8: 커밋** — `feat(shared): add reaction contracts and agent reaction facts`, `feat(server): store reactions and pick undelivered ones per agent session`.

---

### Task 2: 서버 — wire `reaction.set`·런에 싣기·커서

**Files:**
- Modify: `apps/server/src/realtime/socket.ts`(`WIRE_BUCKET["reaction.set"] = "chatter"`, 처리기), `apps/server/src/realtime/events.ts`(`message.created` 팬아웃이 `withReactions` 도 거침 — PR4)
- Modify: `apps/server/src/modules/runs/orchestrator.ts`(PR1), `apps/server/src/modules/sessions/service.ts`(PR3)
- Modify: `docs/superpowers/specs/2026-09-26-team-members-design.md` 「역할과 권한」 표(한 줄)
- Test: `apps/server/test/integration/reactions.test.ts`(새), `apps/server/test/roles.matrix.test.ts`, `apps/server/test/runs.orchestrator.test.ts`, `apps/server/test/sessions.test.ts`

**Interfaces:**
- Consumes: 태스크 1 의 서비스 넷·`ReactionSet`.
- Produces: 런의 `InboundDeliver.context.reactions`·`reactionsOmitted`(어댑터가 받는 값).

- [ ] **Step 1: 실패하는 테스트 — 통합.** `integration/reactions.test.ts`(가짜 Gateway·플러그인 — 기존 `test/helpers/openclaw.ts`·`scenario-steps.ts`):
  - mia·owner 소켓이 채널 룸에 있음 → mia 가 에이전트 답에 `reaction.set {on: true}` → 두 소켓이 `message.updated`(`reactions` 에 👍 1) · 같은 요청 다시 → 이벤트 없음.
  - 그 뒤 owner 가 에이전트를 멘션 → 가짜 플러그인이 받은 `InboundDeliver.context.reactions` 에 `@mia 👍` · 그다음 멘션 런에는 없음.
  - **Review Focus 2**: 리액션 → 멘션 → `send` 전에 abort(가짜 플러그인 ack 를 늦추고 `run.abort`) → 다음 멘션 런에 다시 실림.
  - 가짜 플러그인을 끊어 `send` 가 실패 → 다음 런(다시 붙인 뒤)에 다시 실림.
  - **Review Focus 3**: 에이전트 메시지가 스레드 루트 — 루트 리액션은 스레드 런과 채널 런 모두에, 스레드 답글 리액션은 스레드 런에만. 한쪽 런이 커서를 올려도 다른 세션은 그대로 받음.
  - 「새 대화」(리셋) 뒤 첫 런에는 안 실림.
  - **Review Focus 4**: 25개 리액션 → 첫 런에 20개 + `reactionsOmitted 5`.
  - 러너 에이전트(가짜 러너): 같은 시나리오 한 번 — `RunnerRunStart.deliver.context.reactions` 가 있음.
  - 형식 틀림 `VALIDATION` · 목록 밖 이모지 `VALIDATION` · 시스템 메시지 `VALIDATION` · `chatter` 상한 초과 `RATE_LIMITED`.
- [ ] **Step 2: 실패하는 테스트 — 단위·역할.** `sessions.test.ts`: 새 세션 행·리셋·`renewSessionOnPromptChange` 가 `reactionsSeenAt` 을 지금으로. `roles.matrix.test.ts`: `reaction.set` 세 역할 허용, membership 없는 소켓 거절.
- [ ] **Step 3: 실패 확인.**
- [ ] **Step 4: 구현.**
  - 처리기(`typing` 처리기 모양):

```ts
socket.on("reaction.set", async (raw: unknown, ack: unknown) => {
  if (limited("reaction.set")) return reply(ack, RATE_LIMITED);
  const res = await settle(ctx.logger, "reaction.set", async () => {
    setReaction(ctx.db, ctx.bus, ctx.workspaceId, userId, parsePayload(ReactionSet, raw), new Date());
    return null;
  });
  reply(ack, res);
});
```

  - 오케스트레이터(PR1): `renewSessionOnPromptChange` 판정 뒤

```ts
const cursorRow = getSessionRow(db, session.id); // 갱신된 reactions_seen_at
const pending = pendingReactionsFor(db, {
  channelId: run.channelId, agentId: run.agentId,
  threadRootId: run.threadRootId ?? null, since: cursorRow?.reactionsSeenAt ?? null,
});
if (pending.reactions.length > 0) {
  inbound.context.reactions = pending.reactions;
  if (pending.omitted !== undefined) inbound.context.reactionsOmitted = pending.omitted;
}
```

    `send` 결과가 받아들여진 경로에서 `if (pending.latestAt) advanceReactionCursor(db, session.id, pending.latestAt)`. 커서가 null 이었으면(`pending` 이 비었음) 받아들여진 경로에서 `advanceReactionCursor(db, session.id, now())` 로 채운다(스펙 3.2). `getSessionRow` 가 없으면 sessions 서비스에 같은 이름으로 더한다(id 로 한 행).
  - 세션 서비스(PR3).
  - 팀 스펙 표에 wire `reaction.set` — 「누구나」.
- [ ] **Step 5: 통과 확인** — 실행 개수.
- [ ] **Step 6: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 7: 커밋** — `feat(server): set reactions over wire and deliver them on the agent's next run`.

---

### Task 3: 어댑터 — 플러그인 헤더·러너 턴 사실

**Files:**
- Modify: `packages/openclaw-plugin/src/context.ts`(`formatInboundContext`), `packages/shared/src/runner/prompt.ts`(`buildTurnFacts` 입력), `packages/runner-adapter/src/runner-adapter.ts`(`buildTurnFacts` 호출)
- Test: `packages/openclaw-plugin/test/context.test.ts`, `packages/shared/test/runner-prompt.test.ts`(있는 파일 이름을 따른다), `packages/runner-adapter/test/runner-adapter.test.ts`

**Interfaces:**
- Consumes: 태스크 1 의 `formatReactionFacts`·`InboundContext.reactions`.
- Produces: `buildTurnFacts(input: { participants; thread?; relayDepth?; reactions?: readonly InboundReaction[]; reactionsOmitted?: number }): string`.

- [ ] **Step 1: 실패하는 테스트.**
  - 플러그인: `reactions` 둘 → 헤더에서 `---` 바로 앞 줄들이 `formatReactionFacts` 결과와 같음 · 없거나 빈 배열 → 반응 줄 없음, 나머지 헤더는 이전과 글자까지 같음(기존 스냅숏·단언 그대로 통과).
  - shared `buildTurnFacts`: `reactions` 가 있으면 끝에 블록, 없으면 이전과 같음.
  - 러너 어댑터: `deliver.context.reactions` 가 있는 런 시작 → `RunnerRunStart.turnFacts` 끝에 블록.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/openclaw-plugin test` · `pnpm -F @dodok/shared test` · `pnpm -F @dodok/runner-adapter test`.
- [ ] **Step 3: 구현.** 플러그인: `lines.push("---")` 앞에 `const facts = formatReactionFacts(d.context.reactions ?? [], d.context.reactionsOmitted); if (facts) lines.push(facts);`. 러너 어댑터: `buildTurnFacts({ participants, thread, reactions: deliver.context.reactions, reactionsOmitted: deliver.context.reactionsOmitted })`.
- [ ] **Step 4: 통과 확인** — 실행 개수.
- [ ] **Step 5: 루트 검사 4종 + 플러그인 빌드.**
- [ ] **Step 6: 커밋** — `feat(plugin): show reactions on the agent's messages in the turn header`, `feat(runner-adapter): add reactions to runner turn facts`.

---

### Task 4: 웹 — 피커·칩·낙관적 갱신

**Files:**
- Create: `apps/web/src/features/reactions/{ReactionPicker.tsx,ReactionChips.tsx,useSetReaction.ts}`
- Modify: `apps/web/src/features/messages/MessageItem.tsx`
- Test: `apps/web/src/features/reactions/reactions.test.tsx`(새), `apps/web/src/features/messages/MessageList.test.tsx`

**Interfaces:**
- Consumes: shared `REACTION_EMOJIS`·`MessageReaction`, wire `reaction.set`, `usePeople()`(`api/queries.ts`), 타임라인 캐시 갱신 도우미(`features/messages/timeline.ts` 의 `updateTimeline`·스레드 캐시 `updateThread`).
- Produces:

```ts
/** 낙관적 갱신 → reaction.set → 실패하면 되돌리고 토스트. 같은 (메시지, 이모지)는 마지막 요청만 화면 정본 */
export function useSetReaction(channelId: string, threadRootId?: string): (messageId: string, emoji: ReactionEmoji, on: boolean) => void;
export function ReactionChips(props: { message: Message; me: string; onToggle: (emoji: ReactionEmoji, on: boolean) => void }): JSX.Element | null;
export function ReactionPicker(props: { onPick: (emoji: ReactionEmoji) => void }): JSX.Element; // 「반응 추가」 버튼 + 팝오버
```

- [ ] **Step 1: 실패하는 테스트.**
  - 피커: 「반응 추가」 버튼 → 팝오버에 8개 · 화살표로 이동·Enter 로 고름·Esc 로 닫힘 · 닫히면 초점이 버튼으로.
  - 칩: `👍 3` · 내가 단 칩 `aria-pressed="true"` · 누르면 `onToggle("👍", false)` · 마우스 올림·초점 시 「@mia, @owner」 · 나간 멤버는 「나간 멤버 @옛핸들」(Review Focus 5) · 리액션이 없으면 아무것도 안 그림.
  - `useSetReaction`: 누르면 캐시가 곧바로 바뀜 · ack 실패면 원래대로 + 토스트 「반응을 저장하지 못했습니다」 · **Review Focus 1**: 켜기·끄기를 연달아 → 첫 요청이 늦게 실패해도 화면은 마지막(끄기) 상태 · 서버 `message.updated` 가 오면 그것으로 맞춤.
  - `MessageItem`: 시스템 메시지·보내는 중 항목에는 버튼·칩 없음 · 스레드 패널 안에서도 동작(스레드 캐시 갱신) · `@media (hover: none)` 에서 버튼이 보임(클래스 단언 — PR2).
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/web test -- reactions MessageList`.
- [ ] **Step 3: 구현.** `MessageItem` 의 동작 줄(타임스탬프가 나타나는 자리와 같은 `group-hover`·`group-focus-within` 규칙)에 `ReactionPicker`, 본문·첨부·카드 아래에 `ReactionChips`. `useSetReaction` 은 요청마다 번호를 매겨 (메시지, 이모지)별 최신 번호만 실패 시 되돌린다.
- [ ] **Step 4: 통과 확인** — 실행 개수.
- [ ] **Step 5: 루트 검사 4종 + 웹 빌드.**
- [ ] **Step 6: 커밋** — `feat(web): add reaction picker and chips`.

---

### Task 5: 브라우저 검증·런 0회 실연·문서

**Files:**
- Modify(필요하면): `apps/server/scripts/dev-fake.ts`(가짜 Gateway 가 받은 인바운드의 `context.reactions` 를 로그에 한 줄로 — 키워드 「반응」 대본은 만들지 않는다)
- Modify: `docs/guides/user-guide.md`(반응 달기), `docs/guides/agent-guide.md`(「반응」 블록의 뜻·AGENTS.md 에 붙일 문장), `docs/guides/deploy.md` 「업데이트」(플러그인 재설치), `docs/project-structure.md`(`modules/reactions/`·`features/reactions/`), `docs/guides/live-smoke.md`(리액션 실연 절), 스펙 「구현과 맞춘 것」(PR1~PR5·Review Focus 3), `docs/plan.md`, `CLAUDE.md` 「현재 단계」

- [ ] **Step 1: 브라우저(dev:fake, 브리프 포트, BrowserOS neo — 네가 연 탭은 네가 닫는다).** owner·mia 두 창: 실시간 칩 · 내 칩 강조·툴팁 · 에이전트 답에 단 리액션이 다음 멘션 뒤 dev:fake 로그의 인바운드에 있음 · 그다음 멘션에는 없음 · 스레드 안에서 달기 · 390px 에서 늘 보이는 아이콘으로 달기 · 시스템 카드에는 버튼 없음.
- [ ] **Step 2: 실연(dev Gateway 2026.9.5, 런 0회 하네스 — `docs/guides/live-smoke.md` 「런 0회 하네스」 절의 가짜 claude CLI).** 플러그인 tgz 를 새로 깔고 → 에이전트 답에 리액션 → 멘션 → 가짜 CLI 가 받은 프롬프트에 「반응(지난 턴 뒤 네 메시지에 달린 것):」 블록이 있음. 결과를 `live-smoke.md` 새 절에 기록. **모델 런 없음.**
- [ ] **Step 3: 결함은 재현 절차와 함께 보고서에**(이 태스크에서 고치지 않는다).
- [ ] **Step 4: 문서**(위 목록).
- [ ] **Step 5: 루트 `pnpm fmt:check`.**
- [ ] **Step 6: 커밋** — `docs: document reactions and record the live check`.

---

## Self-Review 기록

- **스펙 대조**: 2장 대상 → 태스크 1(검증)·4(버튼 없음). 3장 표·열 → 1. 4장 계약 → 1. 5.1 → 1. 5.2 → 2(PR1·PR3). 5.3 → 3. 6장 → 4(PR2). 7장 → 2. 8장 → 1·2·4. 9장 → 각 태스크·5. 10장 → 5.
- **이름 맞춤**: `REACTION_EMOJIS`·`ReactionEmoji`·`MessageReaction`·`InboundReaction`·`ReactionSet`·`formatReactionFacts`·`setReaction`·`withReactions`·`pendingReactionsFor`(`latestAt`)·`advanceReactionCursor`·`getSessionRow`·`useSetReaction`·`ReactionChips`·`ReactionPicker` — 태스크 사이에서 같은 이름.
- **Review Focus**: 다섯 줄 모두 태스크 1·2·4 단계에 테스트가 있다.
