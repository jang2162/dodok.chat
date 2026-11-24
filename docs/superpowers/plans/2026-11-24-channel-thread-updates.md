# 채널 세션에 스레드 소식 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 채널(대화) 세션 런의 헤더에, 그 세션이 지난 턴 뒤 이 대화의 스레드들에 새로 달린 답글을 「스레드 소식」으로 한 번씩 싣는다.

**Architecture:** 반응(reactions)이 걸은 길을 그대로 따른다 — shared 계약에 선택 필드·상한 상수·공용 문구 함수, 서버에 세션 행 커서 열(`thread_replies_seen_at`)과 고르기·올리기 함수, 오케스트레이터 디스패치에서 고르고 send 가 받아들여지면 커서를 올린다. OpenClaw 는 플러그인이 `threadUpdates` 능력을 알린 연결에만 싣고, 러너는 서버가 만드는 턴 사실(`buildTurnFacts`)에 넣는다.

**Tech Stack:** TypeScript, Zod, Drizzle(SQLite, drizzle-kit), Vitest, pnpm·Turbo.

**Spec:** `docs/superpowers/specs/2026-11-24-channel-thread-updates-design.md` (결정 T1~T7)

## Global Constraints

- 대화 세션 런(`run.threadRootId === undefined`)에만 싣는다. 스레드 세션 런에는 절대 싣지 않는다.
- 범위: 같은 `conversationId`, `messages.kind = 'normal'`, `thread_root_id IS NOT NULL`, `created_at > thread_replies_seen_at`. 작성자는 가리지 않는다(이 에이전트 자신 포함). 수정(`edited_at`)은 보지 않는다.
- 상한: 스레드 ≤ **5**(새 답글이 가장 늦게 달린 스레드부터), 스레드마다 최근 답글 ≤ **3**, 답글 본문 **300**자(서러게이트 쌍을 가르지 않음), 루트 발췌 **60**자(`REACTION_EXCERPT_MAX`, 반응의 `excerptOf` 변환). 밖으로 밀린 스레드 수는 `threadUpdatesOmitted`.
- 커서: send 가 받아들여진 경로에서만, 고려한 새 답글 전체(보인 것·밀린 것 모두)의 가장 늦은 `created_at` 으로. 뒤로 가지 않는다. null 커서면 싣지 않고 지금으로 채운다.
- OpenClaw: `threadUpdates` 능력이 없는 연결이면 싣지도 커서를 건드리지도 않는다. 러너: 늘 지원(능력 플래그 없음, `renderRunnerPrompt` 는 고치지 않는다 — 러너 판 올림 없음).
- 새 세션 행·`renewSessionOnPromptChange` 는 이 커서를 지금으로. 마이그레이션 0043 은 기존 행을 마이그레이션 시각으로 채운다.
- 머리줄 뜻: 「스레드 소식(지난 턴 뒤 이 세션의 스레드에 새로 달린 답글):」. 자리: 플러그인 헤더는 「최근 대화」 다음·반응 앞, 러너 턴 사실은 반응 앞.
- 커밋: 경로를 명시해 stage, Conventional Commits 패키지 스코프(`feat(shared): …`). `pnpm test` 는 typecheck·build 와 동시에 돌리지 않는다. 실행 개수를 보고에 적는다.

## Review Focus

1. **같은 채널의 다른 세션(대화)에 달린 스레드 답글** — 실리면 안 된다. → Task 2 `다른 대화의 답글은 싣지 않는다`.
2. **스레드 런** — 스레드 세션에는 이 칸이 없어야 한다(채널 커서도 건드리지 않음). → Task 3 통합 `스레드 런에는 threadUpdates 가 없다`.
3. **ack 를 기다리는 사이 달린 답글** — 다음 런에 남아야 한다(커서는 고른 것의 latestAt 까지만). → Task 2 `latestAt 은 고려한 것 중 가장 늦은 시각`·Task 3 통합 두 번째 턴.
4. **옛 플러그인(능력 없음)** — 싣지 않고 커서도 그대로, 플러그인이 능력을 알린 뒤 첫 턴에 쌓인 것이 실린다. → Task 3 통합.
5. **시스템·run_error 등 normal 아닌 스레드 메시지와 빈 본문+첨부 답글** — 앞은 빠지고 뒤는 자리표시로. → Task 2 `normal 만`·`첨부만 있는 답글은 자리표시`.

---

### Task 1: shared 계약·문구

**Files:**
- Modify: `packages/shared/src/bridge/index.ts` (상수·`InboundThreadUpdate`·`InboundContext` 필드·`BridgeCapability`)
- Create: `packages/shared/src/thread-updates/index.ts`
- Modify: `packages/shared/src/index.ts` (`export * from "./thread-updates";`)
- Modify: `packages/shared/src/adapter/index.ts:181-185` (`supports` 의 capability 유니온에 `"threadUpdates"`)
- Modify: `packages/shared/src/runner/prompt.ts` (`buildTurnFacts` 입력·반응 앞 줄)
- Test: `packages/shared/test/thread-updates.test.ts` (새), `packages/shared/test/runner-prompt.test.ts`(스키마 단언도 thread-updates 테스트에)

**Interfaces:**
- Produces:
  - `INBOUND_THREAD_UPDATES_MAX = 5`, `THREAD_UPDATE_REPLIES_MAX = 3`, `THREAD_UPDATE_REPLY_TEXT_MAX = 300` (bridge)
  - `InboundThreadUpdate = z.object({ rootId: Id, rootExcerpt: z.string().max(REACTION_EXCERPT_MAX), newReplies: z.int().min(1), recent: z.array(InboundContextMessage.extend({ text: z.string().max(THREAD_UPDATE_REPLY_TEXT_MAX) })).min(1).max(THREAD_UPDATE_REPLIES_MAX) })`
  - `InboundContext.threadUpdates?: InboundThreadUpdate[]` (max 5), `InboundContext.threadUpdatesOmitted?: number` (int ≥ 1)
  - `BridgeCapability` 에 `"threadUpdates"`
  - `formatThreadUpdates(updates: readonly InboundThreadUpdate[], omitted: number | undefined, hhmm: (iso: string) => string): string` — 비면 `""`
  - `buildTurnFacts` 입력에 `threadUpdates?: readonly InboundThreadUpdate[]`, `threadUpdatesOmitted?: number`

- [ ] **Step 1: 실패하는 테스트** — `packages/shared/test/thread-updates.test.ts`

```ts
it("스레드마다 루트 발췌·새 답글 수·최근 답글, 끝에 외 N개", () => {
  const out = formatThreadUpdates([{
    rootId: ROOT, rootExcerpt: "제출하면 erdd 가", newReplies: 4,
    recent: [msg("owner", "제출 된 폼인데?", "2026-11-24T08:28:00Z"), msg("guideline", "제가 잘못 말했습니다.", "2026-11-24T08:29:00Z")],
  }], 2, (iso) => iso.slice(11, 16));
  expect(out).toBe([
    "스레드 소식(지난 턴 뒤 이 세션의 스레드에 새로 달린 답글):",
    "- 「제출하면 erdd 가」 새 답글 4(최근 2):",
    "  [08:28] @owner: 제출 된 폼인데?",
    "  [08:29] @guideline: 제가 잘못 말했습니다.",
    "(외 스레드 2개)",
  ].join("\n"));
});
it("비면 빈 문자열", () => expect(formatThreadUpdates([], undefined, String)).toBe(""));
it("InboundContext 는 threadUpdates 6개를 거절한다", () => { /* InboundContext.safeParse(...).success === false */ });
it("답글 본문 301자를 거절한다", () => { /* InboundThreadUpdate.safeParse */ });
```

`runner-prompt.test.ts` 에 추가: `buildTurnFacts({ …, threadUpdates: [U], reactions: [R] })` 결과에서 「스레드 소식」 줄의 인덱스가 「반응(」 줄보다 앞이고, 시각은 그 파일의 `hhmm`(UTC 기준, 기존 테스트와 같은 꼴)로 찍힌다. `threadUpdates` 가 없으면 결과가 기존 기대값과 글자까지 같다(기존 테스트가 그대로 통과).

- [ ] **Step 2:** `pnpm -F @dodok/shared test -- thread-updates runner-prompt` → FAIL(`formatThreadUpdates` 없음).
- [ ] **Step 3: 구현** — 위 Interfaces 대로. 줄 꼴: 스레드 줄 `- 「<rootExcerpt>」 새 답글 <newReplies>(최근 <recent.length>):`, 답글 줄 두 칸 들여쓰기 `[hh:mm] @handle: text`, 답글 text 안의 줄바꿈은 공백 하나로 접는다(헤더 줄을 지어내지 못하게 — 플러그인의 세션 줄 접기와 같은 까닭). `buildTurnFacts` 는 자기 파일의 `hhmm` 을 넘긴다.
- [ ] **Step 4:** 같은 명령 → PASS, 실행 개수 확인. `pnpm -F @dodok/shared typecheck`.
- [ ] **Step 5: 커밋** `feat(shared): thread updates contract and formatter`

---

### Task 2: 서버 커서·고르기

**Files:**
- Modify: `apps/server/src/db/schema.sqlite.ts:265` 근처 (`threadRepliesSeenAt: ts("thread_replies_seen_at")`)
- Create: `apps/server/drizzle/0043_thread_replies_seen_at.sql` + meta (`pnpm -F @dodok/server db:generate` 로 만들고, 끝에 `UPDATE agent_sessions SET thread_replies_seen_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE thread_replies_seen_at IS NULL;` 를 0019 와 같은 꼴로 덧붙인다)
- Modify: `apps/server/src/modules/sessions/service.ts` (`ensureSession` 새 행 `threadRepliesSeenAt: now`, `renewSessionOnPromptChange` set 에 `threadRepliesSeenAt: now`)
- Modify: `apps/server/src/modules/reactions/service.ts` (`excerptOf`·`mentionHandles` 를 export)
- Create: `apps/server/src/modules/thread-updates/service.ts`
- Test: `apps/server/test/thread-updates.service.test.ts` (새, `apps/server/test/reactions.service.test.ts` 의 DB 준비 꼴을 따른다)

**Interfaces:**
- Consumes: Task 1 의 상수·`InboundThreadUpdate`
- Produces:
  - `pendingThreadUpdatesFor(db: DbOrTx, q: { conversationId: string; since: Date | null }): PendingThreadUpdates`
  - `type PendingThreadUpdates = { updates: InboundThreadUpdate[]; omitted?: number; latestAt?: Date }`
  - `advanceThreadRepliesCursor(db: DbOrTx, sessionRowId: string, to: Date): void` (뒤로 가지 않음, null 이면 채움 — `advanceReactionCursor` 와 같은 꼴)

- [ ] **Step 1: 실패하는 테스트** — `thread-updates.service.test.ts`
  - `since 가 null 이면 빈 결과` → `{ updates: [] }`, `latestAt` 없음.
  - `커서 뒤 답글만, 고르기는 최근 활동 순·싣는 순서는 오래된 것부터` — 스레드 A(답글 t1,t5), B(t3) · since=t2 → updates 순서는 A 가 아니라 **오래된 것부터 읽히게 마지막 활동 오름차순**: `[B, A]`, A.newReplies=1, A.recent=[t5], `latestAt`=t5.
  - `스레드 6개면 가장 오래된 1개가 밀려 omitted=1, latestAt 은 밀린 것까지 포함한 최댓값`.
  - `스레드당 새 답글 5개면 recent 는 마지막 3개, newReplies=5`.
  - `다른 대화의 답글은 싣지 않는다` — 같은 채널 다른 conversationId 의 스레드 답글.
  - `normal 만` — 스레드 안 `kind: "system"` 답글은 세지도 싣지도 않는다.
  - `첨부만 있는 답글은 자리표시` — text 가 `[이미지 1장]`.
  - `답글 본문은 300자에서 자른다`, `루트 발췌는 60자 이내`.
  - `이 에이전트 자신의 답글도 싣는다`.
  - sessions: `ensureSession 새 대화 행의 threadRepliesSeenAt 은 만든 시각`, `renewSessionOnPromptChange 가 threadRepliesSeenAt 을 지금으로 올린다`.
  - `advanceThreadRepliesCursor 는 뒤로 가지 않는다`.
- [ ] **Step 2:** `pnpm -F @dodok/server test -- thread-updates.service` → FAIL.
- [ ] **Step 3: 구현** — 질의 둘: ① 커서 뒤 답글을 스레드별로 묶어 (rootId, count, max(created_at)) 를 max 내림차순으로 전부(밀린 수·전체 latestAt 계산용), ② 고른 5개 스레드의 최근 3개 답글. 작성자는 `runs/context.ts` 의 `resolveAuthors`, 본문은 `renderForAgent`(참여자 목록은 그 함수가 요구하는 것 — 대화의 `sessionParticipants(…, { includeInactive: true })`), 자리표시는 `attachmentPlaceholder`, 자르기는 `context.ts` 의 `clip` 을 export 해 쓴다. 루트 발췌는 `excerptOf(root.bodyMd, mentionHandles(...))`. 결과 배열은 마지막 활동 오름차순.
- [ ] **Step 4:** 같은 명령 → PASS(개수 확인). `pnpm -F @dodok/server typecheck`.
- [ ] **Step 5: 커밋** `feat(server): thread replies cursor and pending thread updates`

---

### Task 3: 디스패치 연결·어댑터 능력

**Files:**
- Modify: `apps/server/src/modules/runs/orchestrator.ts:980-990, 1050-1056` (반응 옆에서 고르고, 같은 받아들임 경로에서 올린다) 와 `withReactionFacts` 옆에 `withThreadUpdates`
- Modify: `packages/openclaw-adapter/src/connection/gateway-connection.ts:156` (`supports` 유니온)
- Modify: `packages/openclaw-adapter/src/fake-adapter.ts:383-393` (유니온)
- Modify: `packages/runner-adapter/src/runner-adapter.ts:1214` (`capability === "threadUpdates"` 이면 늘 true) 와 `:1274-1282` (`buildTurnFacts` 에 `threadUpdates`·`threadUpdatesOmitted` 전달)
- Modify: `apps/server/test/fakes/fake-plugin.ts:92` (`FAKE_PLUGIN_HELLO.capabilities` 에 `"threadUpdates"`)
- Test: `apps/server/test/integration/thread-updates.test.ts` (새, `apps/server/test/integration/reactions.test.ts` 의 준비 꼴), `packages/runner-adapter/test/runner-adapter.test.ts`

**Interfaces:**
- Consumes: Task 2 `pendingThreadUpdatesFor`·`advanceThreadRepliesCursor`, Task 1 `buildTurnFacts` 입력
- Produces: 없음(종단)

- [ ] **Step 1: 실패하는 통합 테스트** — `thread-updates.test.ts`
  - `채널 루트에 스레드 답글 둘 뒤 채널 멘션 → delivery.context.threadUpdates[0].recent 의 text 가 그 둘`.
  - `바로 다음 채널 멘션에는 threadUpdates 가 없다`.
  - `스레드 런에는 threadUpdates 가 없다` — 스레드 안 멘션의 delivery.
  - `능력 없는 플러그인(hello 에서 threadUpdates 를 뺀 것)이면 싣지 않고, 능력을 알린 뒤 첫 채널 런에 그동안의 답글이 실린다`.
  - `send 가 drop 되면 커서가 그대로라 다음 런에 다시 실린다`.
  - runner-adapter 테스트: `context.threadUpdates 가 있으면 turnFacts 에 「스레드 소식」 줄`.
- [ ] **Step 2:** `pnpm -F @dodok/server test -- integration/thread-updates` → FAIL.
- [ ] **Step 3: 구현** — 디스패치: `run.threadRootId === undefined && adapter.supports(providerAgentId, connectionId, "threadUpdates")` 일 때만 `getSessionRow(...)?.threadRepliesSeenAt` 를 (갱신 판정 뒤) 읽어 고른다. 받아들여진 경로에서 `cursor = pending.latestAt ?? (since === null ? now() : undefined)` 를 올린다 — 고르지 않은 런(스레드 런·미지원)은 건드리지 않는다.
- [ ] **Step 4:** 같은 명령 + `pnpm -F @dodok/runner-adapter test` + `pnpm -F @dodok/openclaw-adapter typecheck` → PASS(개수 확인). 반응 통합(`integration/reactions.test.ts`)·`integration/threads.test.ts` 도 다시 돌려 그대로 통과.
- [ ] **Step 5: 커밋** `feat(server): deliver thread updates to channel session runs`

---

### Task 4: 플러그인 헤더·능력, dev:fake, 문서

**Files:**
- Modify: `packages/openclaw-plugin/src/context.ts` (`formatInboundContext` — 「최근 대화」 다음·반응 앞, `hhmm(ts, tz)` 를 넘김)
- Modify: `packages/openclaw-plugin/src/channel.ts:85-92` (`DODOK_BRIDGE_CAPABILITIES` 에 `"threadUpdates"`)
- Modify: `apps/server/scripts/dev-fake.ts` (인바운드 로그 줄 `dev:fake inbound reactions` 에 `threadUpdates` 수를 싣는다 — 손 확인용), `apps/server/test/dev-fake.test.ts` 가 그 줄을 단언하면 함께
- Modify: `docs/guides/agent-guide.md` (49줄 「채널의 최근 대화에는 스레드 답글이 들어가지 않는다…」, 967줄 근처 문제 줄 — 스펙 7장), `docs/guides/plan.md` (8장 스레드 항목 545줄 근처, 10장 결정 한 줄)
- Test: `packages/openclaw-plugin/test/context.test.ts`

- [ ] **Step 1: 실패하는 테스트** — `context.test.ts`: `threadUpdates 가 있으면 「최근 대화」 절 다음, 반응 줄 앞에 「스레드 소식」 절 (Asia/Seoul 시각)`; `스레드 런 delivery 에 threadUpdates 가 있어도(계약 위반) 싣지 않는다` — 스레드 분기에서는 그리지 않는다; `없으면 헤더가 이전과 글자까지 같다`(기존 테스트 통과).
- [ ] **Step 2:** `pnpm -F @dodok/openclaw-plugin test -- context` → FAIL.
- [ ] **Step 3: 구현** — 위 Files 대로. 문서는 스펙 7장의 내용(최근 대화는 그대로 최상위만, 「스레드 소식」으로 지난 턴 뒤 새 답글·상한·수정은 다시 안 옴·스레드 세션은 그대로·옛 플러그인은 원격 업데이트 뒤부터)을 그 줄들에 녹인다. md 는 oxfmt 가 안 보므로 `---` 앞 빈 줄·표 줄을 눈으로 본다.
- [ ] **Step 4:** `pnpm -F @dodok/openclaw-plugin test` → PASS. 이어서 혼자: `pnpm lint && pnpm fmt:check && pnpm typecheck`, 그다음 따로 `pnpm exec turbo run test --continue` — 실행 개수와 실패 0 을 보고.
- [ ] **Step 5: 커밋** `feat(plugin): render thread updates in the inbound header` (문서는 `docs: thread updates in agent guide and plan` 로 따로)
- [ ] **Step 6: 손 확인(dev:fake, 워크트리 전용 포트)** — 씨앗 채널 「세션」에서 owner 글에 스레드를 열고 답글 둘 → 채널에서 `@dev` 멘션 → 서버 로그 인바운드 줄에 threadUpdates 1, 다시 멘션 → 0.
