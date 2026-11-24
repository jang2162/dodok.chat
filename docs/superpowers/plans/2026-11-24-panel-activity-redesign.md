# 채널 오른쪽 패널 활동 탭 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 Orca 워커가 워크트리 안에서 이 계획을 한 작업씩 실행한다.

**Goal:** 활동 탭의 「런 목록 + 고른 런 하나의 타임라인」을 런마다 펼치는 카드 목록으로 바꾸고, 거르기 칩과 패널 머리의 승인 대기 배지를 단다(스펙 목표 7).

**Architecture:** `ActivityPanel` 의 데이터 줄기(`useChannelRuns` + 런 스토어 + `useSettledRuns` + `freezeDurations`/`mergeRuns`, 승인 스토어)는 그대로 둔다. `RunList` 를 `RunCards` 로 바꾸고, 펼친 카드 안에 지금의 `RunTimeline` 을 `key={runId}` 로 세운다. 승인 카드는 지금처럼 패널 맨 위. 런 카드 머리의 프로그램 배지는 연결 탭 작업의 `ProgramBadge`, 머리 배지는 패널 설정 작업의 `PanelTabs` `badges` prop 을 쓴다. 서버 무변경.

**Tech Stack:** React 19, Zustand(런·승인 스토어), TanStack Query, Tailwind v4, shadcn `@/ui/*`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-24-connections-and-panel-redesign-design.md`(목표 7, 「정한 것(내 판단)」의 승인 카드 자리·거르기 정의). 시안: https://claude.ai/artifact/7gJsBvbHjuvNACCyy6vWex 의 「바꾼 뒤 — 패널 · 활동」(승인 카드가 런 안에 있는 것은 스펙대로 맨 위로 바꾼다).

**선행:** `connections-redesign`(→ `apps/web/src/features/runners/ProgramBadge.tsx`)과 `panel-settings`(→ `PanelTabs` 의 `badges?: Partial<Record<PanelTab, number>>`, 활동 탭 접근 이름 「활동, 승인 대기 N」)가 main 에 병합된 뒤 시작한다.

## Global Constraints

- 서버·shared 무변경. 응답 안의 활동(`InlineActivity.tsx`·`StreamingBubble`·`MessageItem`)의 동작은 바꾸지 않는다 — 공유 줄(`ReasoningLine`·`ToolCallRow`)의 꼴을 바꾸면 그쪽 시험도 PASS 해야 한다.
- 지금 활동 탭의 보장을 지킨다: 진행 중 런의 소요만 1초 틱(`hasFlowingDuration`), 끝난 런이 스토어에서 빠져도 줄이 흔들리지 않음(`useSettledRuns` D2·D9·D12), 목록 조회 실패에도 실시간 런은 그린다, 진행 중 타임라인은 끝에 붙어 따라가되 위로 올린 사람은 끌어내리지 않음, 채널을 옮기면 상태를 버린다(`key={channelId}`), 승인 카드는 맨 위·확정 뒤에도 결과 한 줄.
- 상태 칩 색: 진행 중 = primary 옅은 바탕, 승인 대기 = warning, 완료 = success, 실패 = destructive, 멈춤(aborted) = muted. 글자는 지금의 `runStatusLabel`.
- 거르기 정의(스펙 「정한 것」): 진행 중 = 끝나지 않은 모든 상태, 승인 대기 = `awaiting_approval`, 실패 = `error`. 칩마다 수.
- 커밋은 경로를 적어 stage, `feat(web): …`.

## Review Focus

1. 펼친 카드의 런이 끝나 스토어에서 빠질 때 — 카드가 접히거나 타임라인이 새로 서지 않는다(펼침·스크롤 유지). (Task 2 시험)
2. 거르기 칩이 고른 채 새 런이 오면 — 그 거르기에 맞으면 나타나고 수가 는다, 맞지 않으면 수만 다른 칩에서 는다. (Task 2 시험)
3. 「승인 대기」로 거른 채 승인이 끝나면 — 그 런이 목록에서 빠지되 펼친 다른 카드는 그대로, 목록이 비면 「승인을 기다리는 런이 없습니다」. (Task 2 시험)
4. 에이전트를 모르는 런(지운 에이전트) — 「알 수 없는 에이전트」, 배지 없음. (Task 1 시험)
5. 런이 수백 개인 채널 — 처음엔 최근 런 하나만 펼치고 나머지는 접힌 요약이라 타임라인 조회는 펼친 것만(지금처럼 `GET /runs/:id/events` 는 펼칠 때). (Task 2 시험 — 펼치지 않은 카드는 이벤트를 부르지 않는다)

---

### Task 1: 런 카드

**Files:**
- Create: `apps/web/src/features/activity/RunCard.tsx`
- Modify: `apps/web/src/features/activity/RunTimeline.tsx`(세로 선 타임라인 꼴 — 줄 앞 상태 원, 승인 줄은 「승인 대기 — 위 카드에서 답하세요」)
- Modify: `apps/web/src/features/activity/ToolCallRow.tsx`(밑줄 「인자 보기」·「결과 보기」 → 줄 전체가 펼침 단추, 인자 한 줄 요약 고정폭. 펼침 시 `<pre>` 그대로)
- Test: `apps/web/src/features/activity/activity.test.tsx`, `apps/web/src/features/activity/InlineActivity.test.tsx`

**Interfaces:**
- Consumes: `ProgramBadge`(`@/features/runners/ProgramBadge`, `program: RunnerProgram`), `ActivityRun`·`runStatusLabel`·`runDurationMs`(`./timeline`).
- Produces: `RunCard({ run, expanded, onToggle, now, approval }: { run: ActivityRun; expanded: boolean; onToggle(): void; now: number; approval: (approvalId: string) => Approval | undefined })` — `section` 접근 이름 「@<핸들> 런, <상태 글>」. 머리: 아바타·핸들·프로그램 배지(러너 에이전트만)·상태 칩·시작 시각·소요·펼침 단추(`aria-expanded`). 진행 중이면 「런 중지」(지금 중지 동작과 같은 길 — 버블의 중지와 같은 mutation). 접힌 끝난 런은 요약 한 줄(「생각 N · 도구 N(<이름들>) · 답 N」 — 이벤트를 이미 가진 경우만, 없으면 요약 없음).

- [ ] **Step 1: 시험(activity.test.tsx)** — 지금 런 목록 단추를 누르던 시험을 카드 펼침으로 옮긴다. 추가: 러너 에이전트 런 카드에 「Claude Code」 배지, OpenClaw 에이전트 런은 배지 없음, 모르는 에이전트는 「알 수 없는 에이전트」; 도구 줄을 누르면 인자·결과 `<pre>` 가 펼쳐진다(`aria-expanded`); 진행 중 카드의 「런 중지」.
- [ ] **Step 2:** `pnpm -F @dodok/web exec vitest run src/features/activity` → FAIL 확인.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** 같은 명령 → PASS(`InlineActivity.test.tsx` 포함), 실행 수 확인.
- [ ] **Step 5:** 커밋 `feat(web): run cards with program badge and expandable tool rows`.

### Task 2: 카드 목록·거르기

**Files:**
- Modify: `apps/web/src/features/activity/ActivityPanel.tsx`(RunList → 카드 목록, 펼침 상태 `Set<string>`, 거르기)
- Delete: `apps/web/src/features/activity/RunList.tsx`(쓰는 곳이 없어지면)
- Modify: `apps/web/src/features/activity/timeline.ts`(거르기 함수)
- Test: `apps/web/src/features/activity/activity.test.tsx`, `apps/web/src/features/activity/timeline.test.ts`

**Interfaces:**
- Produces(`timeline.ts`): `type RunFilter = "all" | "running" | "approval" | "failed"`, `filterRuns(runs: readonly ActivityRun[], f: RunFilter): ActivityRun[]`, `countRuns(runs: readonly ActivityRun[]): Record<RunFilter, number>`.

- [ ] **Step 1: 시험(timeline.test.ts)** — `filterRuns`·`countRuns` 가 스펙 정의대로(aborted 는 all 에만, finalizing 은 running).
- [ ] **Step 2: 시험(activity.test.tsx)** —
  - 처음엔 가장 최근 런만 펼침, 나머지 접힘. 접힌 카드는 `GET /runs/:id/events` 를 부르지 않는다.
  - 펼친 진행 중 런이 끝나 스토어에서 빠져도 카드는 펼친 채, 타임라인이 새로 서지 않는다(펼친 도구 줄 그대로).
  - 거르기 `group` 「런 거르기」, 칩 「전체 N」·「진행 중 N」·「승인 대기 N」·「실패 N」(`aria-pressed`). 「실패」를 누르면 error 런만; 비면 「실패한 런이 없습니다」.
  - 「승인 대기」 거르기 중 승인이 끝나면 그 런이 빠진다.
  - 채널을 옮기면 펼침·거르기 초기화.
  - 승인 카드는 거르기·펼침과 무관하게 맨 위.
- [ ] **Step 3:** FAIL 확인.
- [ ] **Step 4:** 구현.
- [ ] **Step 5:** `pnpm -F @dodok/web exec vitest run src/features/activity` → PASS.
- [ ] **Step 6:** 커밋 `feat(web): activity tab as run cards with filters`.

### Task 3: 머리 배지

**Files:**
- Modify: `apps/web/src/features/messages/ChannelPage.tsx`(`PanelTabs` 에 `badges={{ activity: <그 채널의 대기 중 승인 수> }}`)
- Modify: `apps/web/src/features/approvals/approvalStore.ts`(필요하면 `selectPendingCount(channelId): (s) => number` 셀렉터 추가)
- Test: `apps/web/src/features/approvals/approvalStore.test.ts`, `apps/web/src/features/messages/ChannelPage.test.tsx`

- [ ] **Step 1: 시험** — 그 채널에 대기 승인 둘이면 활동 탭 접근 이름 「활동, 승인 대기 2」; 하나가 허용되면 1; 없으면 배지 없음. 다른 채널의 승인은 세지 않는다. 패널이 닫혀 있으면 배지를 그리지 않는다(패널이 없다).
- [ ] **Step 2:** FAIL 확인.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `pnpm -F @dodok/web exec vitest run src/features/approvals src/features/messages src/app/layout` → PASS.
- [ ] **Step 5:** 커밋 `feat(web): pending approval badge on the activity tab`.

### Task 4: 전체 검사·문서·브라우저 확인

**Files:**
- Modify: `docs/manual/user-guide.md`(활동 탭 절)

- [ ] **Step 1:** `pnpm -F @dodok/web typecheck && pnpm lint && pnpm fmt:check` → 오류 없음. 그 뒤 따로 `pnpm -F @dodok/web test` → 전부 PASS, 실행 수 적기.
- [ ] **Step 2:** user-guide 갱신.
- [ ] **Step 3:** dev:fake(워크트리 전용 포트)로 neo 에서 — `@coder` 런(추론·도구), 사무실 `@dev` 「도구」 대본, 승인 대본 키워드로 승인 대기(머리 배지·맨 위 카드·「승인 대기」 거르기), 「실패」 대본, 좁은 화면 시트, 다크 모드. 응답 안의 활동(버블)이 그대로인지도. 스크린숏을 보고서에. 연 탭은 닫는다.
- [ ] **Step 4:** 커밋 `docs: activity tab run cards in user guide`.
