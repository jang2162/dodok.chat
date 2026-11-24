# 여러 에이전트 답 묶음 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사람 글 하나에서 시작해 에이전트 2명 이상이 답하면, 그 답(릴레이 포함)을 메인 타임라인에 따로 쌓지 않고 루트 글 아래 에이전트별 접힌 줄 묶음으로 보인다.

**Architecture:** 서버는 이미 런마다 `rootMessageId`·`triggerMessageId` 를 저장한다. 이것을 wire 의 `RunState` 와 클라이언트용 `Message`(새 칸 `runRoot`)에 실어 웹이 안다. 웹은 순수 함수 `computeBundles` 로 타임라인 + 런 저장소에서 묶음을 계산하고, `groupRows` 가 묶음에 든 메시지·버블을 메인 행에서 빼고 루트 글 바로 뒤에 `bundle` 행 하나를 둔다. 세션 키·문맥·저장 스키마는 바꾸지 않는다(마이그레이션 없음).

**Tech Stack:** TypeScript, Zod(shared), Fastify + drizzle/SQLite(server), React + zustand + TanStack Virtual(web), vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-multi-agent-reply-bundle-design.md`

## Global Constraints

- 화면 표시만 바뀐다 — 세션 키(`dodokSessionKey`)·문맥 동봉·릴레이 판정·DB 스키마는 건드리지 않는다.
- 묶음 판정: 사람(`authorType: "user"`) 최상위 글(`threadRootId` 없음) + `rootMessageId` 가 그 글인 런의 **서로 다른 에이전트 2명 이상**(진행 중 런 포함). 멘션 수는 보지 않는다.
- 루트가 불러온 타임라인에 없으면 묶지 않는다(답은 지금 자리).
- 스레드 패널(`threadRootId` 가 있는 목록)에서는 묶지 않는다. DM·그룹 DM 은 채널과 같다.
- 도구 승인 카드는 지금 자리(목록 맨 아래·결정 자리)에 둔다. 묶음 줄에는 「승인 대기」 표시와 그 카드로 가는 누름만.
- 처음엔 접힘. 누를 수 있는 components 카드(만료 전·소비 안 됨)가 든 줄만 펼친 채. 사람이 손으로 펼치거나 접은 것은 그대로 둔다.
- 새 칸은 모두 선택(optional) — 옛 서버면 칸이 없어 묶지 않는다(지금 화면 그대로).
- 커밋: 경로를 명시해 stage, Conventional Commits 패키지 스코프(`feat(shared)`, `feat(server)`, `feat(web)`, `docs`).
- `pnpm test` 는 typecheck·build 와 동시에 돌리지 않는다. 통과를 보고할 때 실행된 시험 수를 함께 적는다.

**스펙과 달라진 것(계획 단계 판단):** `run_limit` 시스템 메시지는 런이 만들어지기 전에 막힌 것이라 `runId`·루트가 없다 — 묶음 맨 아래가 아니라 지금처럼 메인에 둔다. 묶음 안 components 카드를 눌러 생긴 런은 루트가 그 에이전트 글이므로(`components/service.ts`) 묶이지 않고 메인에 온다.

## Review Focus

1. **둘째 에이전트가 늦게 붙는 순간** — 1명 답이 메인에 있다가 릴레이로 둘째 런이 시작되면 첫 답이 묶음으로 옮겨 간다. 사용자가 바닥에 있을 때 스크롤이 튀지 않아야 한다(Task 4 시험).
2. **루트가 페이지 밖** — 최신 페이지에 답만 있고 루트가 없으면 답이 사라지지 않고 메인에 그려져야 한다(Task 3 시험).
3. **메시지 없이 끝난 런** — 중지·실패해 에이전트 글이 없는 런도 줄이 있고 상태(「중지됨」·「실패」)가 보여야 한다. 지난 기록에서는 `run_error` 시스템 메시지로 줄이 선다(Task 3 시험).
4. **같은 에이전트가 두 번** — 릴레이로 dev 가 다시 불리면 dev 줄이 둘(런마다), 시간 순(Task 3 시험).
5. **결과로 가기·알림으로 묶음 안 글에 갈 때** — 그 줄이 펼쳐지고 강조돼야 한다. 묶음 행 키로 스크롤한다(Task 5 시험).

---

### Task 1: shared — `RunState`·`Message` 에 루트 연결 칸

**Files:**
- Modify: `packages/shared/src/domain/index.ts` (`Message` 397–432, `RunState` 534–549)
- Test: `packages/shared/test/domain.test.ts`

**Interfaces:**
- Produces:
  - `RunState` 에 `rootMessageId?: Id`, `triggerMessageId?: Id` (선택 — `Run.pick` 에 넣으면 `Run` 의 필수가 따라오므로 `.extend({ rootMessageId: Id.optional(), triggerMessageId: Id.optional() })` 로 둔다. 서버 `toRunState`(= `RunState.parse(run)`)는 그대로 두 칸을 싣는다).
  - `export const MessageRunRoot = z.object({ runId: Id, agentId: Id, rootMessageId: Id, triggerMessageId: Id.optional() })`, `Message.runRoot?: MessageRunRoot` — 에이전트 메시지(`runId`)와 `run_error` 시스템 메시지(`systemMeta.runId`)에만 서버가 붙인다.

- [ ] **Step 1: 실패하는 시험** — `domain.test.ts` 에 `describe("run root")`:
  - `RunState.parse({...기존 최소 필드, rootMessageId: <uuid>, triggerMessageId: <uuid>})` 가 두 칸을 그대로 돌려준다.
  - 두 칸 없이도 파싱된다(옛 서버).
  - `Message.parse({...최소 메시지, runRoot: { runId, agentId, rootMessageId } })` 가 `runRoot` 를 유지하고, `runRoot` 없는 메시지도 통과.
- [ ] **Step 2:** `pnpm -F @dodok/shared test -- domain` → FAIL(칸이 걸러짐).
- [ ] **Step 3:** 위 Interfaces 대로 구현.
- [ ] **Step 4:** `pnpm -F @dodok/shared test -- domain` → PASS, `pnpm -F @dodok/shared typecheck` 통과.
- [ ] **Step 5: Commit** — `git add packages/shared/src/domain/index.ts packages/shared/test/domain.test.ts` · `feat(shared): run root on RunState and Message`

### Task 2: server — 런 상태와 메시지에 루트 싣기

**Files:**
- Modify: `apps/server/src/modules/messages/service.ts` (`hydrateForClient` 278–280, 새 `withRunRoots`)
- Test: `apps/server/test/messages.service.test.ts`, `apps/server/test/wire.runs.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `MessageRunRoot`, `RunState` 두 칸.
- Produces: `withRunRoots(db: DbOrTx, msgs: Message[]): Message[]` — 대상 메시지(`authorType === "agent" && runId`, 또는 `kind === "system" && systemMeta?.kind === "run_error" && systemMeta.runId`)의 런 id 를 모아 `runs` 를 **질의 한 번**(`inArray`)으로 읽고 `runRoot` 를 붙인다. 대상이 없으면 질의하지 않는다. `hydrateForClient` 체인에 더한다.

- [ ] **Step 1: 실패하는 시험** — `messages.service.test.ts`:
  - `"hydrateForClient 는 에이전트 메시지에 runRoot 를 붙인다"`: 사람 글 R, 그 글로 시작한 런(에이전트 A) 의 메시지 → `runRoot` 가 `{ runId, agentId: A, rootMessageId: R.id, triggerMessageId: R.id }`.
  - `"릴레이 런의 메시지는 원래 루트와 부른 글을 싣는다"`: A 의 글 M 이 트리거한 relay 런(에이전트 B, `rootMessageId: R.id`) 메시지 → `rootMessageId: R.id`, `triggerMessageId: M.id`.
  - `"run_error 시스템 메시지에도 붙는다"`, `"사람 글·info 시스템 글에는 붙지 않는다"`.
  - 시험 데이터는 그 파일의 기존 런 만들기 도우미를 쓴다(없으면 `runs.store.test.ts` 의 `createRun` 사용 방식).
- [ ] **Step 2: 실패하는 시험** — `wire.runs.test.ts`: 기존 `run.state` 수신 시험 옆에 `"run.state 는 rootMessageId·triggerMessageId 를 싣는다"`.
- [ ] **Step 3:** `pnpm -F @dodok/server test -- messages.service wire.runs` → 새 시험 FAIL.
- [ ] **Step 4:** `withRunRoots` 구현·체인 연결. `run.state` 는 Task 1 로 이미 실리는지 확인하고, 안 실리면 `toRunState` 입력에 두 칸이 있는지 본다.
- [ ] **Step 5:** 같은 명령 PASS. 이어 `pnpm -F @dodok/server test` 전체(혼자) — 메시지를 통째로 단언하는 기존 시험이 `runRoot` 때문에 깨지면 기대값에 칸을 더한다(깨진 파일 이름을 보고에 적는다).
- [ ] **Step 6: Commit** — 고친 파일만 경로로 · `feat(server): carry run root to clients`

### Task 3: web — 묶음 계산과 행 배치

**Files:**
- Create: `apps/web/src/features/messages/bundles.ts`
- Modify: `apps/web/src/features/messages/groupRows.ts`, `apps/web/src/features/runs/runStore.ts`(`RunView` 에 `rootMessageId?`·`triggerMessageId?` — `reduceState` 가 `state` 에서 옮겨 담고, 빠진 상태가 와도 앞 값을 잊지 않는다, `threadRootId` 와 같은 규칙)
- Test: `apps/web/src/features/messages/bundles.test.ts`(새), `apps/web/src/features/messages/groupRows.test.ts`, `apps/web/src/features/runs/runStore.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `Message.runRoot`, `RunState.rootMessageId/triggerMessageId`.
- Produces:
  ```ts
  export type BundleLane = {
    runId: string; agentId: string;
    /** 릴레이면 부른 에이전트(트리거 글의 작성자) — 사람이 부른 줄은 없음 */
    fromAgentId?: string;
    messageIds: string[];            // seq 순
    systemIds: string[];             // 그 런의 run_error
    /** 저장소에 있으면 그 상태, 없으면(지난 기록) 메시지로 짐작: 에이전트 글 있음 → done, run_error 만 → error */
    status: RunState["status"];
    firstSeq?: number;
  };
  export type Bundle = { rootId: string; lanes: BundleLane[]; tailSystemIds: string[] /* relay_limit·relay_denied */ };
  export type BundleRun = { runId: string; agentId: string; rootMessageId: string; triggerMessageId?: string; status: RunState["status"] };
  export function computeBundles(items: readonly Message[], runs: readonly BundleRun[]): Map<string, Bundle>;
  /** 메시지 id·런 id → 그 묶음의 rootId (groupRows·이동이 쓴다) */
  export function bundleIndex(bundles: Map<string, Bundle>): { byMessage: Map<string, string>; byRun: Map<string, string> };
  ```
  - `groupRows(timeline, bubbleRunIds, approvals, tz, opts)` 의 `opts` 에 `bundles?: Map<string, Bundle>` 추가. `Row` 에 `{ kind: "bundle"; key: \`bundle:${rootId}\`; rootId: string }` 추가.

- [ ] **Step 1: 실패하는 시험** — `bundles.test.ts`:
  - `"두 에이전트가 답한 사람 글은 묶음"`: R(사람) + A·B 메시지(`runRoot.rootMessageId = R`) → 묶음 1, 줄 2(런 id 순).
  - `"한 에이전트만이면 묶지 않는다"`: R + A 메시지 둘(같은 런) → 빈 맵.
  - `"1명만 불렀어도 릴레이로 둘째가 답하면 묶는다"`: A 글 M, B 런 `triggerMessageId = M` → 줄 2, B 줄 `fromAgentId = A`.
  - `"진행 중 런도 센다"`: A 메시지 + 저장소 런 B(`status: "running"`, 메시지 없음) → 묶음, B 줄 `messageIds: []`, `status: "running"`.
  - `"같은 에이전트의 두 런은 줄 둘"`: A 런 1·B 런·A 런 2 → 줄 3, 런 id(생성) 순.
  - `"run_error 만 남은 런은 error 줄"`, `"relay_limit 은 tailSystemIds"`(`systemMeta.relay.rootMessageId = R`).
  - `"루트가 items 에 없으면 묶지 않는다"`, `"에이전트 글이 루트면 묶지 않는다"`, `"스레드 답글이 루트면 묶지 않는다"`.
- [ ] **Step 2: 실패하는 시험** — `groupRows.test.ts`:
  - `"묶음에 든 메시지는 행에서 빠지고 루트 뒤에 bundle 행"`: 행 키 순서가 `msg:R`, `bundle:R`, 그 뒤 다른 메시지.
  - `"묶음 런의 버블은 맨 아래 bubble 행으로 그리지 않는다"`.
  - `"묶음 안 메시지는 새 메시지 구분선을 세우지 않는다"`(`entryReadSeq` 가 묶음 안 seq 를 가리킬 때 구분선은 그 뒤 첫 메인 글 앞).
  - `"bundles 를 안 주면 지금과 같다"`(기존 시험이 그대로 통과하는 것으로 갈음).
- [ ] **Step 3: 실패하는 시험** — `runStore.test.ts`: `"reduceState 는 rootMessageId·triggerMessageId 를 담고 빠진 상태에도 잊지 않는다"`.
- [ ] **Step 4:** `pnpm -F @dodok/web test -- bundles groupRows runStore` → FAIL.
- [ ] **Step 5:** 구현. 런 상태는 `RunView` 에서 `BundleRun` 으로 바꿔 넘긴다(바꾸는 일은 Task 4 의 `MessageList`). 같은 런이 저장소와 메시지 양쪽에 있으면 저장소 상태가 이긴다.
- [ ] **Step 6:** 같은 명령 PASS, `pnpm -F @dodok/web typecheck`.
- [ ] **Step 7: Commit** — `feat(web): compute reply bundles and place bundle rows`

### Task 4: web — 묶음 화면(`ReplyBundle`)과 목록 연결

**Files:**
- Create: `apps/web/src/features/messages/ReplyBundle.tsx`, `apps/web/src/features/messages/bundleExpansion.ts`
- Modify: `apps/web/src/features/messages/MessageList.tsx`(`ChannelMessages` 의 `rows` 계산 138–143, 행 그리기 ~640)
- Test: `apps/web/src/features/messages/ReplyBundle.test.tsx`(새), `apps/web/src/features/messages/MessageList.test.tsx`

**Interfaces:**
- Consumes: Task 3 의 `Bundle`·`computeBundles`·`bundleIndex`·`Row` `bundle`.
- Produces:
  - `bundleExpansion.ts`: zustand 저장소 `useBundleExpansion` — `{ open: Record<runId, boolean>; set(runId, open): void }`. 값이 없으면 자동 규칙(아래)을 따르고, 사람이 누르면 `set` 으로 고정. 이동(Task 5)도 `set(runId, true)` 를 쓴다.
  - `<ReplyBundle bundle={Bundle} messagesById={Map<string, Message>} />` — 묶음 `role="group"` `aria-label`「@<첫 핸들> 외 N 답」(1명 남짓이면 「@dev·@fin 답」). 줄 = `button` `aria-expanded`, 내용: 아바타(`size-5`)·핸들·(릴레이면 「@from → @to」 작은 글)·첫 줄 미리보기(마크다운 걷은 첫 줄, 없으면 상태 문구)·상태(진행 중 `runStatusLabel`, done ✓, error 「실패」, aborted 「중지됨」)·승인 대기 배지.
  - 펼친 줄 안: 그 런의 메시지를 기존 `MessageItem` 으로(머리 생략), 진행 중이면 기존 `StreamingBubble`, `run_error` 는 기존 `SystemCard`. 최대 높이 `max-h-96` + 넘치면 「전체 보기」로 풀기.
  - 자동 펼침: 저장소에 값이 없고, 그 줄의 메시지 중 `components` 가 있고 `componentState` 가 만료·소비 전인 것이 있으면 펼침. 그 밖은 접힘.
  - 승인 대기 배지: 그 런 id 의 미해결 승인(`useApprovalStore`)이 있으면 「승인 대기」. 누르면 그 승인 행(`approval:<id>`)으로 스크롤.
- `ChannelMessages`: `threadRootId === undefined` 일 때만 `computeBundles(timeline.items, selectScopeRuns 결과 → BundleRun[])` 을 `groupRows` 의 `opts.bundles` 로 넘기고, `bubbleRunIds` 에서 묶음 런을 뺀다(Task 3 의 `groupRows` 가 이미 빼면 중복으로 하지 않는다). `bundle` 행은 `<ReplyBundle>` 로 그린다.

- [ ] **Step 1: 실패하는 시험** — `ReplyBundle.test.tsx`:
  - `"줄은 접혀 있고 누르면 그 답을 펼친다"`(`aria-expanded` false → true, 본문 보임).
  - `"누를 수 있는 카드가 든 줄은 펼친 채, 소비된 카드면 접힘"`.
  - `"진행 중 줄은 상태 문구"`(`runStatusLabel` 결과 글), `"error 런은 「실패」, aborted 는 「중지됨」"`.
  - `"릴레이 줄은 「@dev → @coder」"`.
  - `"승인 대기 배지를 누르면 승인 행으로 스크롤"`(스크롤 콜백 호출 단언).
  - `"사람이 접은 줄은 카드가 있어도 다시 펼치지 않는다"`.
- [ ] **Step 2: 실패하는 시험** — `MessageList.test.tsx`:
  - `"두 에이전트 답은 루트 아래 묶음으로, 메인에 따로 없다"`.
  - `"스레드 패널(threadRootId)에서는 묶지 않는다"`.
  - `"둘째 런이 시작되면 첫 답이 묶음으로 옮겨 가고 바닥 고정이 유지된다"`(바닥에 있던 상태에서 `run.state` 로 B 런을 넣은 뒤 끝 보임 유지 단언 — 그 파일의 기존 바닥 고정 시험 방식을 따른다).
- [ ] **Step 3:** `pnpm -F @dodok/web test -- ReplyBundle MessageList` → FAIL.
- [ ] **Step 4:** 구현. 스타일은 기존 `ThreadChip`·`AvatarGroup` 과 같은 토큰, 움직임 줄이기 설정이면 진행 표시 정지(기존 버블 규칙).
- [ ] **Step 5:** 같은 명령 PASS, `pnpm -F @dodok/web typecheck`, `pnpm lint:fix && pnpm fmt`.
- [ ] **Step 6: Commit** — `feat(web): reply bundle under multi-agent requests`

### Task 5: web — 묶음 안으로 이동과 「답 도착」 칩

**Files:**
- Modify: `apps/web/src/features/messages/MessageList.tsx`(이동 강조·스크롤 키), `apps/web/src/features/messages/useJump.ts`
- Test: `apps/web/src/features/messages/MessageList.test.tsx`, `apps/web/src/features/messages/jumpList.test.tsx`

**Interfaces:**
- Consumes: Task 3 의 `bundleIndex`, Task 4 의 `useBundleExpansion.set`.
- Produces: 이동 대상 메시지 id 가 `byMessage` 에 있으면 그 런 줄을 `set(runId, true)` 로 펼치고 `bundle:<rootId>` 행으로 스크롤, 강조(`data-highlighted`)는 묶음 안의 그 메시지에. 「답 도착」 칩: 묶음에 새 에이전트 메시지(이 탭에서 `message.created` 로 받은 것)가 들어왔는데 그 `bundle:<rootId>` 행이 화면 밖이면 목록 아래에 「@<핸들> 답 도착 — 보기」(기존 「새 메시지」 칩 자리·모양), 누르면 그 줄을 펼치고 그 행으로 스크롤. 바닥 따라가기·자동 스크롤은 하지 않는다. 사이드바 읽지 않음 수는 바꾸지 않는다.

- [ ] **Step 1: 실패하는 시험** — `jumpList.test.tsx`: `"묶음 안 메시지로 가면 그 줄이 펼쳐지고 강조된다"`. `MessageList.test.tsx`: `"화면 밖 묶음에 답이 오면 「답 도착」 칩, 누르면 그 묶음으로"`, `"묶음이 화면 안이면 칩이 없다"`.
- [ ] **Step 2:** `pnpm -F @dodok/web test -- jumpList MessageList` → FAIL.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** PASS, 이어 `pnpm -F @dodok/web test` 전체 혼자(실제 시간 시험이 흔들리면 그 시험만 다시).
- [ ] **Step 5: Commit** — `feat(web): jump into reply bundles and arrival chip`

### Task 6: 문서와 화면 확인

**Files:**
- Modify: `docs/manual/user-guide.md`(「에이전트 답 보기」 절 317 아래에 `### 여러 에이전트의 답 묶음`)

- [ ] **Step 1:** 한 단락: 한 글에서 에이전트 2명 이상이 답하면(릴레이 포함) 글 아래 에이전트별 줄로 묶인다 · 누르면 펼침 · 누를 카드가 있는 줄은 펼친 채 · 승인 카드는 아래 자리 그대로, 줄의 「승인 대기」를 누르면 간다 · 스레드 안에서는 묶지 않는다 · 묶음 안 카드를 눌러 생긴 답은 메인에 온다.
- [ ] **Step 2: 화면 확인**(워커, `pnpm -F @dodok/server dev:fake` + `pnpm -F @dodok/web dev`, http://localhost:5173, BrowserOS neo — 연 탭은 닫는다): 씨앗 채널 「세션」에서 `@dev @coder` 한 글 → 묶음 2줄·진행 상태·펼침, 사무실 `@dev` 가 `@fin` 을 부르는 대본 → 1명 부른 글이 묶음으로 바뀜, 「도구」 대본 승인 → 맨 아래 카드 + 줄의 「승인 대기」, 390px 폭. 스크린숏 경로를 보고에 적는다.
- [ ] **Step 3: 전체 검사** — `pnpm lint` · `pnpm fmt:check` · `pnpm typecheck` 를 마친 뒤 따로 `pnpm exec turbo run test --continue` — 패키지별 실행 수를 보고에 적는다.
- [ ] **Step 4: Commit** — `git add docs/manual/user-guide.md` · `docs: reply bundle in user guide`
