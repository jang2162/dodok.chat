# 스레드 글을 채널에도 보이기 Implementation Plan

> **For agentic workers:** 이 저장소는 Orca 워커가 구현한다(`docs/guides/worktree-workflow.md`). 태스크 순서대로, 태스크마다 시험 → 구현 → 통과 → 커밋. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스레드의 사람 답글에 「채널에도 보내기」 표시를 두어 채널(세션) 타임라인에도 보이고, 그 글이 일으킨 여러 에이전트 런을 그 아래 답 묶음으로 보인다.

**Architecture:** DB 열 `messages.also_in_channel` 하나. 서버는 새 조회 범위 `channel`(루트 + 표시된 답글)로 세션 타임라인을 내고, 기존 `roots`(제어 도구)는 그대로 둔다. 웹은 같은 메시지를 세션·스레드 두 캐시에 넣고, 묶음은 런으로 세워 누르면 스레드로 간다.

**Tech Stack:** drizzle(SQLite)·Fastify·Socket.IO wire·Zod(shared)·React/TanStack Query·vitest.

**Spec:** `docs/superpowers/specs/2026-11-25-thread-also-in-channel-design.md` — 값·규칙의 원본. 계획과 다르면 스펙을 따르고 보고한다.

## Global Constraints

- `alsoInChannel` 은 사람(`authorType: "user"`) 스레드 답글에만 참이 될 수 있다. 채널 kind 는 `channel`·`direct` 만(에이전트 DM 에는 스레드가 없다).
- shared `Message.alsoInChannel` 은 `z.literal(true).optional()` — 참일 때만 싣는다.
- wire `MessageSend.alsoInChannel?: boolean` — `true` 1, `false` 0, 없음 = 서버 자동(토큰화한 멘션의 서로 다른 에이전트 ≥ 2 인 스레드 답글이면 1).
- 제어 도구 `read_messages` 의 결과(`roots` 범위)는 바뀌지 않는다. 에이전트 문맥(`buildInboundDeliver`)도 바뀌지 않는다.
- 스레드만 읽어서는 채널 굵게를 지우지 않는다(스레드 읽음 모델을 만들지 않는다).
- 웹 문구: 링크 줄 「스레드에 댓글 남김: 」 + 루트 발췌 40자, 묶음 머리 「@a·@b 답 · 스레드에서 진행」, 작성기 체크 「채널에도 보내기」, 스레드 안 표시 「채널에도 보냄」.

## Review Focus

- 채널에도 보낸 답글을 **수정·반응**하면 세션 타임라인과 스레드 양쪽 화면이 같이 바뀐다 — Task 4 의 시험.
- **재동기화(끊겼다 붙기)** 뒤에도 그 답글이 세션 타임라인에 남는다(`applyToTimeline` 이 걸러 내지 않는다) — Task 4 의 시험.
- 결과로 가기(검색)로 그 답글의 seq 에 가면 세션 타임라인에서 **그 글 자리**가 가운데다(루트 자리가 아니다) — Task 2 의 시험.
- 사람이 체크를 끈 채 에이전트 둘을 멘션하면 **채널에 올리지 않는다**(`false` 명시가 자동 판정보다 이긴다) — Task 1·5 의 시험.
- 같은 글이 채널 굵게와 멘션 배지에 **두 번 세지지 않는다** — Task 3 의 시험.

---

### Task 1: 저장·계약 — `also_in_channel` 열과 보내기 판정

**Files:**
- Modify: `apps/server/src/db/schema.sqlite.ts`(messages 표), 새 마이그레이션 `apps/server/drizzle/0045_*.sql`(`pnpm -F @dodok/server db:generate` 로 만들고 이름은 `0045_messages_also_in_channel`)
- Modify: `packages/shared/src/domain/index.ts`(`Message`), `packages/shared/src/wire/index.ts`(`MessageSend`)
- Modify: `apps/server/src/modules/messages/service.ts`(`rowToMessage`·`sendUserMessage`·`CreateUserMessageInput`), `apps/server/src/realtime/socket.ts`(message.send 처리기가 값을 넘김)
- Test: `apps/server/test/messages.threads.test.ts`, `packages/shared/test/bridge.test.ts` 옆 shared 도메인 시험이 있으면 그 파일(없으면 `messages.threads.test.ts` 로 충분)

**Interfaces:**
- Produces: `messages.alsoInChannel`(drizzle 열, 정수 0/1, not null default 0) · `Message.alsoInChannel?: true` · `MessageSend.alsoInChannel?: boolean` · `CreateUserMessageInput.alsoInChannel?: boolean`
- Produces: `resolveAlsoInChannel(input: { requested: boolean | undefined; threadRootId: string | undefined; agentMentionCount: number }): boolean` — `service.ts` 안(내보내 시험).

- [ ] **Step 1: 시험** — `messages.threads.test.ts` 에 `describe("alsoInChannel")`: ① `true` + 스레드 답글 → 저장된 메시지 `alsoInChannel === true` ② `false` + 에이전트 둘 멘션 → `undefined` ③ 없음 + 에이전트 둘 멘션 → `true` ④ 없음 + 에이전트 하나 → `undefined` ⑤ `true` + 최상위 글 → `undefined`(오류 아님). `resolveAlsoInChannel` 단위 시험 다섯 줄도 같은 값.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/server exec vitest run test/messages.threads.test.ts -t alsoInChannel` → FAIL.
- [ ] **Step 3: 구현** — 열·마이그레이션·Zod 두 곳·`rowToMessage`(1 일 때만 `alsoInChannel: true`)·`sendUserMessage` 가 토큰화한 `mentions` 의 서로 다른 에이전트 수로 `resolveAlsoInChannel` 을 불러 저장. socket 처리기가 `p.alsoInChannel` 을 넘긴다.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, `pnpm typecheck` PASS.
- [ ] **Step 5: 커밋** — `feat(server): also_in_channel flag on thread replies`

### Task 2: 조회 범위 `channel` — 세션 타임라인·결과로 가기·rootRuns

**Files:**
- Modify: `apps/server/src/modules/messages/service.ts`(`MessageScope`·`scopeFilter`·`rootSeqAt`·`listMessages`·`canRootRuns`/`withRootRuns`), `apps/server/src/modules/messages/routes.ts`(세션 타임라인이 `scope: "channel"`)
- Test: `apps/server/test/messages.threads.test.ts`, `apps/server/test/control.service.test.ts`(read_messages 불변)

**Interfaces:**
- Consumes: Task 1 의 열.
- Produces: `MessageScope = "roots" | "channel" | …`(기존 값 유지) — `channel` = `thread_root_id IS NULL OR also_in_channel = 1`.

- [ ] **Step 1: 시험** — ① `GET /api/v1/conversations/:id/messages` 가 채널에도 보낸 답글을 seq 자리에 싣고 보통 답글은 싣지 않는다 ② `around=<그 답글 seq>` 의 가운데가 그 답글 ③ 그 답글이 `rootRuns` 를 싣는다(스레드 안 사람 글로 시작한 런 — `rootMessageId` 가 그 글) ④ `control.service.test.ts`: `read_messages`(threadRootId 없음) 결과에 그 답글이 **없다**.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/server exec vitest run test/messages.threads.test.ts test/control.service.test.ts` → ①②③ FAIL, ④ PASS.
- [ ] **Step 3: 구현** — `scopeFilter("channel")`, `rootSeqAt` 이 범위를 받아 `channel` 이면 표시된 답글은 자기 seq, `canRootRuns` 가 표시된 사람 답글도 받는다. 인덱스: 조회 계획이 `(channel_id, thread_root_id, seq)` 를 계속 쓰는지 `EXPLAIN QUERY PLAN` 으로 보고, 풀스캔이면 부분 인덱스를 Task 1 마이그레이션에 더한다(보고에 결과).
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: 커밋** — `feat(server): channel scope includes also-in-channel replies`

### Task 3: 읽지 않음 — 굵게 세기와 `channel.activity`

**Files:**
- Modify: `apps/server/src/modules/reads/store.ts`(굵게 조건), `packages/shared/src/reads/index.ts`(`ChannelActivity.alsoInChannel?: true`), `apps/server/src/realtime/events.ts`(channel.activity 에 싣기), `apps/web/src/features/reads/useUnread.ts:107`
- Test: `apps/server/test/reads.store.test.ts`, `apps/web/src/realtime/handlers.unread.test.ts`

**Interfaces:**
- Produces: `ChannelActivity.alsoInChannel?: true`.

- [ ] **Step 1: 시험** — 서버: 채널에도 보낸 답글 하나 → 세션 굵게 켜짐, 그 세션 읽음 위치가 그 seq 이상이면 꺼짐, 멘션 배지 수는 그 글 하나로 1(두 번 아님). 웹: `channel.activity` 에 `threadRootId` 와 `alsoInChannel: true` 가 같이 오면 굵게, `alsoInChannel` 없으면 지금처럼 아님.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/server exec vitest run test/reads.store.test.ts`, `pnpm -F @dodok/web exec vitest run src/realtime/handlers.unread.test.ts` → FAIL.
- [ ] **Step 3: 구현** — 조건 `thread_root_id IS NULL OR also_in_channel = 1`, 이벤트에 표시, 웹 `unread: next.unread || a.threadRootId === undefined || a.alsoInChannel === true`.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: 커밋** — `feat(reads): count also-in-channel replies as channel activity`

### Task 4: 웹 타임라인 — 두 캐시·링크 줄

**Files:**
- Modify: `apps/web/src/features/messages/timeline.ts`(`isRoot`), `apps/web/src/realtime/handlers.ts`(`applyMessage` 의 가름), `apps/web/src/features/messages/MessageItem.tsx`(링크 줄·칩 숨김·스레드 안 표시)
- Test: `apps/web/src/features/messages/timeline.test.ts`, `apps/web/src/realtime/handlers.test.ts`, `apps/web/src/features/threads/threads.test.tsx`

**Interfaces:**
- Produces: `isChannelVisible(m: Pick<Message, "threadRootId" | "alsoInChannel">): boolean`(timeline.ts, `isRoot` 를 대신해 내보냄).
- Consumes: 스레드 열기 — `threadOpener.ts` 의 기억한 보기를 싣는 기존 함수(새로 만들지 않는다).

- [ ] **Step 1: 시험** — ① `applyToTimeline` 이 표시된 답글을 세션 타임라인에 넣는다(재동기화) ② wire `message.created` 의 표시된 답글이 세션·스레드 두 캐시에 들고, `message.updated`(반응 추가)가 둘 다 바꾼다 ③ 세션 타임라인 행에 「스레드에 댓글 남김: 」+ 루트 발췌 링크, 스레드 칩·「스레드에서 답하기」 없음, 누르면 그 스레드가 열린다 ④ 스레드 안 같은 글에 「채널에도 보냄」.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/web exec vitest run src/features/messages/timeline.test.ts src/realtime/handlers.test.ts src/features/threads/threads.test.tsx` → FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces 대로. 루트 발췌는 세션 캐시에 루트가 있으면 그 본문, 없으면 스레드 캐시, 둘 다 없으면 「원래 글」.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: 커밋** — `feat(web): show also-in-channel replies in the session timeline`

### Task 5: 웹 — 묶음과 「채널에도 보내기」 체크

**Files:**
- Modify: `apps/web/src/features/messages/bundles.ts`(`canRoot`), `apps/web/src/features/messages/MessageList.tsx:146`(스레드 런 거르기), `apps/web/src/features/messages/ReplyBundle.tsx`(표시된 답글 묶음: 줄 누르면 스레드의 그 답으로, 머리 문구), `apps/web/src/features/composer/Composer.tsx`·`apps/web/src/features/composer/useSendMessage.ts`(스레드 작성기 체크와 전송 값)
- Test: `apps/web/src/features/messages/bundles.test.ts`, `apps/web/src/features/messages/ReplyBundle.test.tsx`, `apps/web/src/features/composer/Composer.test.tsx`, `apps/web/src/features/composer/useSendMessage.test.ts`

**Interfaces:**
- Consumes: Task 4 `isChannelVisible`, Task 1 `MessageSend.alsoInChannel`.
- Produces: `useSendMessage(...).send(body, { alsoInChannel?: boolean })`(기존 옵션 객체에 칸 하나).

- [ ] **Step 1: 시험** — ① `computeBundles`: 표시된 사람 답글 + 서로 다른 에이전트 런 둘 → 묶음, 보통 스레드 답글 → 없음 ② 묶음 줄 미리보기: 스레드 캐시에 그 런 메시지가 있으면 첫 줄, 없으면 상태 문구 ③ 줄을 누르면 펼치지 않고 그 스레드로 가 그 답으로 점프(`useJumpStore` 목표) ④ 머리 「@dev·@fin 답 · 스레드에서 진행」 ⑤ 스레드 작성기 「채널에도 보내기」: 에이전트 둘 멘션하면 켜짐, 하나면 꺼짐, 사람이 손대면 초안이 바뀌어도 유지, 보낼 때 그 값을 `alsoInChannel` 로 명시 ⑥ 세션 작성기에는 체크가 없다.
- [ ] **Step 2: 실패 확인** — 위 네 파일 vitest → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 위 네 파일 PASS, 이어 `pnpm -F @dodok/web test`(단독)·`pnpm typecheck`·`pnpm lint`·`pnpm fmt`.
- [ ] **Step 5: 커밋** — `feat(web): bundle and composer toggle for also-in-channel replies`

### Task 6: 문서·브라우저

**Files:**
- Modify: `docs/manual/user-guide.md`(「스레드」 절에 「채널에도 보내기」, 「읽지 않음」 절에 한 줄), `docs/superpowers/specs/2026-11-25-thread-also-in-channel-design.md`(끝에 「구현과 맞춘 것」 장 — 스펙과 달라진 것만)

- [ ] **Step 1: 브라우저** — 워크트리 전용 포트로 `dev:fake`+web, 씨앗 채널에서 스레드에 `@dev @fin` 글 → 채널 맨 아래 링크 줄·묶음·줄 누르면 스레드, 체크 끄고 보내면 채널에 없음, 반응이 양쪽에. 스크린샷 경로를 보고에.
- [ ] **Step 2: 문서 쓰기·커밋** — `docs: also-in-channel thread replies`
