# 스레드 칩 참여자·작업 중 표시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 메시지 아래 스레드 칩을 키우고, 사람·에이전트 참여자를 아바타 그룹으로, 그 스레드에서 진행 중인 런의 에이전트를 링과 상태 문구로 보인다.

**Architecture:** 서버 `summarizeThreads` 가 요약에 `participants`(사람·에이전트를 섞은 최근 순, 루트 작성자 포함)를 더한다. 웹 `ThreadChip` 은 그것과 런 저장소(`useRunStore` — 런마다 `threadRootId` 를 안다)의 진행 중 런을 합쳐 그린다. 실시간 경로·wire 이벤트는 바꾸지 않는다.

**Tech Stack:** Zod(shared), Drizzle·SQLite(server), React·zustand·Tailwind·vitest(web)

**Spec:** `docs/superpowers/specs/2026-11-24-thread-chip-participants-design.md`

## Global Constraints

- `ThreadSummary.agentIds` 는 그대로 둔다(기존 소비자·시험). 새 칸 `participants` 는 **optional** — 웹은 없으면 `agentIds` 로 대신 그린다(옛 서버).
- `participants: z.array(z.object({ kind: z.enum(["user", "agent"]), id: Id })).max(10)` — 최근에 쓴 순, 같은 작성자는 한 번, 루트 작성자는 답글을 안 썼으면 맨 뒤(10 안에 들 때만). system·automation 작성자는 넣지 않는다.
- 칩: 글자 `text-sm`, 아바타 `size-6`(24px), 보이는 아바타 4개 + 나머지 `+N`(`AvatarGroup`·`AvatarGroupCount`, `apps/web/src/app/layout/ChannelHeader.tsx:219-239` 와 같은 모양). 그룹은 `role="group" aria-label="스레드 참여자"`.
- 진행 중 = `TERMINAL`(`apps/web/src/features/runs/runStore.ts:5`)이 아닌 상태. 그 에이전트 아바타는 링(`ring-2 ring-primary` + `motion-safe:animate-pulse`), 칩 옆 문구 `@<핸들> <runStatusLabel(status)>…`, 둘 이상이면 `@<첫 핸들> 외 <n-1>명 <첫 상태 라벨>…`. `aria-live` 두지 않는다.
- 진행 중 에이전트가 참여자 목록에 없으면 앞에 더한다. 요약이 없어도 진행 중 런이 있으면 칩을 그린다(이때 「답글 N개」 대신 「스레드」).
- 사람 typing·에이전트 typing 은 하지 않는다(비목표).
- 커밋은 경로를 명시해 stage, Conventional Commits(`feat(server):`·`feat(web):`·`feat(shared):`).

## Review Focus

1. 같은 사람이 루트와 답글을 모두 썼을 때 — 참여자에 한 번만, 답글 시각 기준 자리.
2. 진행 중 런이 끝나면(done·error·aborted) 링과 문구가 사라진다 — 칩이 남은 채 깜빡이지 않는다.
3. 다른 세션(같은 채널)의 같은 rootId 가 아닌 런, 채널 런(threadRootId 없음)은 칩에 안 섞인다.
4. 지워졌거나 목록에 아직 없는 사람·에이전트 id — 건너뛰고 `+N` 계산에도 넣지 않는다.
5. 옛 서버(요약에 `participants` 없음)에서 칩이 깨지지 않고 에이전트 아바타로 그려진다.

각 줄의 시험은 아래 태스크에 들어 있다.

---

### Task 1: 요약에 participants (shared + server)

**Files:**
- Modify: `packages/shared/src/domain/index.ts:390-395`(`ThreadSummary`)
- Modify: `apps/server/src/modules/messages/service.ts:314-352`(`summarizeThreads` — 루트 작성자를 위해 루트 행도 읽는다)
- Test: `apps/server/test/messages.threads.test.ts`
- 요약을 통째로 단언하는 기존 시험이 깨지면 같이 고친다 — 후보: `apps/server/test/messages.service.test.ts`, `apps/server/test/conversations.service.test.ts`, `apps/server/test/integration/conversations.test.ts`, `apps/server/test/roles.matrix.test.ts`, `apps/web/src/features/messages/timeline.test.ts`

**Interfaces:**
- Produces: `ThreadSummary.participants?: { kind: "user" | "agent"; id: string }[]`

- [ ] **Step 1: 실패하는 시험** — `messages.threads.test.ts` 에 `summary participants are recent-first, deduped, root author last`: 루트(owner) → 답글 dev → 답글 mia → 답글 dev 순일 때 `participants` 가 `[{kind:"agent",id:dev},{kind:"user",id:mia},{kind:"user",id:owner}]`. 그리고 `root author who also replied appears once at reply position`: 루트(owner) → 답글 owner → 답글 dev 면 `[{agent dev},{user owner}]`.
- [ ] **Step 2:** `pnpm -F @dodok/server exec vitest run test/messages.threads.test.ts` — 새 두 시험 FAIL.
- [ ] **Step 3:** 스키마에 칸을 더하고 `summarizeThreads` 에서 기존 그룹 행(user·agent 만)을 `lastSeq` 내림차순으로 `participants` 를 만든 뒤, 루트 작성자(사람 또는 에이전트)가 없으면 끝에 붙이고 10개로 자른다. 루트 작성자는 `rootIds` 로 한 번 더 고른다(`messages.id in rootIds`).
- [ ] **Step 4:** `pnpm -F @dodok/server test` 와 `pnpm -F @dodok/shared test` 혼자 돌려 통과·실행 수 확인. 깨진 통째 단언은 새 칸을 넣어 고친다.
- [ ] **Step 5: 커밋** `feat(server): thread summary participants`

### Task 2: 스레드 칩 (web)

**Files:**
- Modify: `apps/web/src/features/threads/ThreadChip.tsx`
- Create: `apps/web/src/features/threads/threadParticipants.ts`(순수 함수)
- Create: `apps/web/src/features/threads/threadParticipants.test.ts`
- Modify: `apps/web/src/features/messages/MessageItem.tsx:221-223`(요약이 없어도 진행 중 런이 있으면 칩)
- Test: `apps/web/src/features/threads/threads.test.tsx`

**Interfaces:**
- Consumes: Task 1 `ThreadSummary.participants`
- Produces:
  - `threadFaces(summary: ThreadSummary | undefined, active: { agentId: string; status: RunStatus }[]): { kind: "user" | "agent"; id: string; active?: RunStatus }[]` — `participants ?? agentIds 를 agent 로`, 진행 중 에이전트를 표시하고 목록에 없으면 앞에 더한다, 중복 없음.
  - `activeLabel(handles: string[], status: RunStatus): string` — `@dev 응답 중…` / `@dev 외 1명 응답 중…`.
  - `useThreadActiveRuns(channelId, conversationId, rootId)` — `selectScopeRuns(channelId, conversationId, rootId)` 에서 `TERMINAL` 아닌 런을 `{ agentId, status }` 로(같은 에이전트는 한 번). `RunView` 에서 에이전트 id 를 얻는 칸은 `runStore.ts` 의 `RunState` 를 보고 고른다.

- [ ] **Step 1: 실패하는 순수 시험** (`threadParticipants.test.ts`): `falls back to agentIds without participants`, `active agent not in participants is prepended`, `active agent already in participants is marked, not duplicated`, `activeLabel one / many`.
- [ ] **Step 2: 실패하는 화면 시험** (`threads.test.tsx`): ① `chip shows people and agents as an avatar group` — 참여자 6명(아는 사람·에이전트)일 때 `getByRole("group", {name: "스레드 참여자"})` 안에 아바타 4개와 `+2`; 모르는 id 하나를 섞으면 `+1`(Review Focus 4). ② `chip shows the running agent in the thread` — 런 저장소에 그 rootId 의 `streaming` 런을 넣으면 `@dev 응답 중…`, 같은 런을 `done` 으로 바꾸면 문구가 사라진다(Review Focus 2). ③ `other thread or channel runs do not show` — 다른 rootId 런과 threadRootId 없는 런만 있을 때 문구 없음(Review Focus 3). ④ `chip renders for a running thread with no replies yet` — 요약 없는 루트 + 진행 중 런이면 칩(「스레드」)과 문구.
- [ ] **Step 3:** `pnpm -F @dodok/web exec vitest run src/features/threads` — FAIL.
- [ ] **Step 4:** 구현. 사람 얼굴은 `usePeople()` 로 풀어 `IdentityAvatar kind="person"`, 에이전트는 `useAgents()`. 진행 중 아바타는 Global Constraints 의 링. 크기·문구는 Global Constraints 그대로.
- [ ] **Step 5:** `pnpm -F @dodok/web test` 혼자 돌려 통과·실행 수 확인, `pnpm typecheck`·`pnpm lint`·`pnpm fmt`.
- [ ] **Step 6: 문서** `docs/manual/user-guide.md` 스레드 절에 칩 설명 한두 줄(참여자 아바타·진행 중 표시).
- [ ] **Step 7: 커밋** `feat(web): thread chip participants and running agents`

### Task 3: 화면 확인 (워커)

- [ ] `pnpm -F @dodok/server dev:fake`(워크트리 전용 포트 — PORT·APP_ORIGIN·DODOK_API_ORIGIN·--port 함께) + 웹 dev. 씨앗 채널에서 메시지에 스레드 답글로 `@dev` 를 멘션 → 칩에 링·「@dev 응답 중…」이 보이고 끝나면 사라지는지, owner·dev 아바타 그룹이 보이는지 스크린샷. 좁은 화면(390px)에서 칩이 넘치지 않는지. 연 탭은 닫는다.
