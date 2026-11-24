# 연결 탭 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 Orca 워커가 워크트리 안에서 이 계획을 한 작업씩 실행한다.

**Goal:** 설정 › 연결 탭(트리·Gateway·러너·에이전트 상세)을 스펙 목표 1~4 의 꼴로 다시 짠다 — 상태 점, 카드 몸통, 「⋯」 메뉴, 여러 프로그램 표시.

**Architecture:** 라우트·데이터(`useConnectionTree`, 연결 목록 쿼리, 상세 쿼리)는 그대로 두고 그리는 컴포넌트만 바꾼다. 프로그램 표시는 웹 한 곳의 표(`programMeta.ts`)에서 나와 트리·러너 카드·에이전트 칩이 함께 쓴다. 서버·shared 무변경.

**Tech Stack:** React 19, TanStack Router 1.170, Tailwind v4, shadcn `@/ui/*`(radix-ui), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-24-connections-and-panel-redesign-design.md`(목표 1~4, 반목표, 제약, 정한 것). 시안: https://claude.ai/artifact/7gJsBvbHjuvNACCyy6vWex 의 「설정 › 연결 — 바꾼 뒤」 줄(에이전트 상세의 프로그램 셀렉트는 스펙대로 읽기 전용으로 바꾼다).

## Global Constraints

- 서버·wire·`packages/shared` 를 고치지 않는다.
- 상태 색: 연결됨 = `--success`, 끊김·승인 대기·로그인 필요 = `--warning`, 꺼짐·보관·폐기 = `--muted-foreground`. 강조색(`--primary`)은 선택·링크·주요 버튼·포커스에만. 새 하드코딩 색 금지 — 칩 바탕은 `color-mix(in oklab, var(--success) 14%, transparent)` 꼴로 토큰에서.
- 상태는 색만으로 전하지 않는다 — 점 옆에 글, 칩은 글자.
- 지금 상세에 있는 동작은 하나도 없애지 않는다 — 버튼이 「⋯」 메뉴로 옮겨 갈 뿐이다. 확인이 필요한 동작은 지금의 확인 대화상자를 연다.
- 보관·삭제 뒤 트리의 자리로 초점 복귀(`ConnectionsContext.focusTree`)와 머리 라이브 알림(`announce`)을 지킨다.
- 좁은 화면은 지금처럼 한 칸씩(트리 → 상세). 카드 2열 격자는 `@container` 또는 `sm:` 아래에서 1열.
- 아이콘만 있는 버튼은 `aria-label`. 「⋯」 버튼 이름은 「<대상> 더 보기」.
- 기존 시험이 찾던 접근 이름을 바꾸면 그 시험의 단언을 새 꼴로 옮긴다(지우지 않는다).
- 커밋은 경로를 적어 stage(`git add -A` 금지), Conventional Commits `feat(web): …`.

## Review Focus

1. 끊긴 러너(`programs: []`) — 프로그램 카드가 「끊김 — 다시 접속하면 프로그램이 보입니다」 한 줄만 보이고 「지원 예정」 줄을 만들지 않는다. (Task 4 시험)
2. member 가 남의 연결 상세를 볼 때 — 「⋯」 메뉴에 권한 없는 항목이 보이지 않거나 잠긴다(지금 `useCanManageConnection` 이 숨기던 버튼과 같은 규칙). (Task 3 시험)
3. 트리 검색이 아무것도 못 찾을 때 — 「찾는 연결·에이전트가 없습니다」, 검색을 비우면 원래 트리와 펼침 상태. (Task 2 시험)
4. 보관한 에이전트·승인 대기 Gateway·폐기된 러너 토큰 — 각 상태 칩 글자가 맞고 점 색이 회색/주황. (Task 2·3 시험)
5. 다크 모드(시스템 설정) — 칩 대비가 토큰에서 오므로 깨지지 않는지 브라우저 확인(Task 6).

---

### Task 1: 프로그램 표(배지·이름·상태)

**Files:**
- Create: `apps/web/src/features/runners/programMeta.ts`
- Create: `apps/web/src/features/runners/ProgramBadge.tsx`
- Test: `apps/web/src/features/runners/programMeta.test.ts`

**Interfaces:**
- Produces:
  - `PROGRAM_META: Record<RunnerProgram, { name: string; short: string; tone: "clay" | "blue" | "violet" }>` — `claude → { name: RUNNER_PROGRAM_NAME.claude, short: "CC", tone: "clay" }`, `codex → "CX" blue`, `opencode → "OC" violet`. 이름은 shared `RUNNER_PROGRAM_NAME` 을 그대로.
  - `type ProgramRowState = "available" | "login" | "not-installed" | "unknown-auth" | "unsupported"`
  - `programRows(programs: RunnerProgramStatus[], connected: boolean): { kind: "disconnected" } | { kind: "rows"; rows: Array<{ program: RunnerProgram; state: ProgramRowState; status?: RunnerProgramStatus }> }`
  - `<ProgramBadge program={p} size?: "sm" | "md" />` — 글자 둘, 옅은 바탕, `title`·`aria-label` = 이름.

- [ ] **Step 1: 실패하는 시험** — `programRows`:
  - `connected=false` → `{ kind: "disconnected" }`(programs 가 있어도).
  - `[claude available auth ok]` → rows 셋, 순서는 `RunnerProgram.options` 순: claude `available`, codex `unsupported`, opencode `unsupported`.
  - claude `available:false` + reason → `not-installed`; `auth: "missing"` → `login`; `auth: "unknown"` + available → `unknown-auth`.
  - 같은 프로그램이 두 번 오면 앞의 것.
- [ ] **Step 2:** `pnpm -F @dodok/web exec vitest run src/features/runners/programMeta.test.ts` → FAIL(모듈 없음).
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** 같은 명령 → PASS, 실행 수 확인.
- [ ] **Step 5:** 커밋 `feat(web): program meta table and badge for runner programs`.

### Task 2: 연결 트리

**Files:**
- Modify: `apps/web/src/features/connections/ConnectionTreeList.tsx`
- Modify: `apps/web/src/features/connections/ConnectionsLayout.tsx`(머리·검색칸·트리 칸 폭 300px·「보관된 연결 보기」를 칸 아래로)
- Modify: `apps/web/src/features/connections/tree.ts`(검색 거르기 함수 추가)
- Test: `apps/web/src/features/connections/tree.test.ts`, `apps/web/src/features/connections/connectionsLayout.test.tsx`

**Interfaces:**
- Consumes: `ProgramBadge`(Task 1).
- Produces: `filterConnectionTree(tree: ConnectionTree, query: string): ConnectionTree` — 이름·핸들(대소문자 무시, 앞뒤 공백 무시)로 거른다. 연결 이름이 맞으면 그 연결을 통째로, 에이전트·프로젝트가 맞으면 그 연결 아래 맞는 것과 그 부모만 남긴다. 빈 문자열이면 그대로.

- [ ] **Step 1: 실패하는 시험(tree.test.ts)** — `filterConnectionTree`: "co" → dev-fake 러너 아래 dodok 프로젝트·Coder 만; "사무실" → 사무실 Gateway 와 에이전트 전부; "zzz" → mine·others 빈 배열; "" → 같은 객체.
- [ ] **Step 2: 실패하는 시험(connectionsLayout.test.tsx)** —
  - 트리에 `region` 「GATEWAY」·「러너」 묶음 머리(개수 포함).
  - 연결 줄의 상태가 글로 있다(「연결됨」), 파란 배지 클래스가 아니다 — 대신 `data-state="connected"` 점.
  - 러너 에이전트 줄에 `ProgramBadge`(접근 이름 「Claude Code」).
  - 검색칸(접근 이름 「연결·에이전트 찾기」)에 "zzz" → 「찾는 연결·에이전트가 없습니다」; 지우면 원래 줄 수.
  - 승인 대기 Gateway 는 「승인 대기」 글 + `data-state="warning"`, 폐기된 러너는 「폐기됨」 + `data-state="muted"`.
- [ ] **Step 3:** 두 시험 FAIL 확인.
- [ ] **Step 4:** 구현 — 에이전트 점은 `IdentityAvatar`(`@/ui/identity-avatar`)의 작은 꼴로, 펼침/접힘 쉐브론, 접힌 연결 줄 끝 「에이전트 N」·「프로젝트 N」. 상태 점 컴포넌트는 이 파일 안 `StatusDot({ tone, label })`.
- [ ] **Step 5:** `pnpm -F @dodok/web exec vitest run src/features/connections` → PASS(기존 시험 포함), 실행 수 확인.
- [ ] **Step 6:** 커밋 `feat(web): grouped connection tree with status dots, program badges and search`.

### Task 3: 상세 머리와 「⋯」 메뉴, Gateway 상세 카드

**Files:**
- Modify: `apps/web/src/features/connections/DetailHeader.tsx`(아이콘·제목·상태 칩·값 줄·주 동작·메뉴 슬롯)
- Create: `apps/web/src/features/connections/DetailCard.tsx`
- Modify: `apps/web/src/features/connections/GatewayDetail.tsx`
- Modify: `apps/web/src/features/connections/RemoteUpdate.tsx`(`PluginUpdate` 를 상태 카드 칸 안에서 쓸 수 있게 — 꼴만)
- Test: `apps/web/src/features/connections/gatewayDetail.test.tsx`

**Interfaces:**
- Produces:
  - `DetailHeader({ icon, title, state?: { tone: "success" | "warning" | "muted"; label: string }, facts: ReactNode[], primary?: ReactNode, menu?: ReactNode })`
  - `DetailCard({ title, count?, action?, children, tone?: "danger" })` — `section` + `aria-label={title}`, 머리 줄(제목·개수·동작).
  - `OverflowMenu({ label, items: Array<{ label: string; onSelect(): void; danger?: boolean; disabled?: boolean }> })` — `DetailCard.tsx` 에 함께, `@/ui/dropdown-menu`. 항목이 없으면 버튼도 그리지 않는다.

- [ ] **Step 1: 시험 옮기기·추가(gatewayDetail.test.tsx)** —
  - 머리: 제목 「사무실」, 상태 칩 「연결됨」, 값 줄에 판·주인·주소.
  - 「이름·주소 수정」 버튼이 머리에 있고, 끄기·삭제는 「사무실 더 보기」 메뉴 항목(삭제는 확인 대화상자를 연다 — 기존 삭제 시험의 단언을 이 길로 옮긴다).
  - 카드 셋: `region` 「상태」·「에이전트」·「브리지 토큰」. 「에이전트」 카드 머리 동작 「가져오기」, 「브리지 토큰」 카드 머리 동작 「새 토큰 발급」.
  - 플러그인 빌드를 모르면 상태 카드 안 안내 띠 + 「다시 설치 방법」(지금 「다시 설치」 접힘의 내용).
  - member 가 남의 Gateway 를 보면 「더 보기」 메뉴가 없거나 항목이 없다(지금 숨기던 것과 같은 조건).
- [ ] **Step 2:** FAIL 확인.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `pnpm -F @dodok/web exec vitest run src/features/connections` → PASS.
- [ ] **Step 5:** 커밋 `feat(web): gateway detail as header, overflow menu and cards`.

### Task 4: 러너 상세 — 프로그램 카드·프로젝트 줄

**Files:**
- Modify: `apps/web/src/features/connections/RunnerDetail.tsx`
- Modify: `apps/web/src/features/runners/RunnerParts.tsx`(`ProgramLine` → 프로그램 카드 줄)
- Modify: `apps/web/src/features/runners/ProjectList.tsx`(줄마다 「워크트리 만들기」 + 「⋯」 — 확인·이름 바꾸기·옮기기·보관)
- Test: `apps/web/src/features/connections/runnerDetail.test.tsx`, `apps/web/src/features/runners/runners.test.tsx`, `apps/web/src/features/runners/worktree.test.tsx`

**Interfaces:**
- Consumes: `programRows`, `ProgramBadge`(Task 1), `DetailHeader`·`DetailCard`·`OverflowMenu`(Task 3).

- [ ] **Step 1: 시험** —
  - 연결된 러너: `region` 「에이전트 프로그램」에 줄 셋 — Claude Code(「쓸 수 있음」, 판·로그인·권한 상한 `acceptEdits`), Codex(「설치 안 됨」 + 「설치 방법」), OpenCode(「지원 예정」).
  - `auth: "missing"` → 「로그인 필요」 칩 + reason 글.
  - 끊긴 러너 → 카드에 「끊김 — 다시 접속하면 프로그램이 보입니다」만, 「지원 예정」 없음.
  - 머리: 「러너 업데이트」(최신보다 낮을 때 — 지금 업데이트 버튼의 조건), 「dev-fake 더 보기」 메뉴에 설치 안내·삭제(지금 있던 것만).
  - 프로젝트 줄: 「워크트리 만들기」 버튼 + 「dodok 더 보기」 메뉴 항목 확인·이름 바꾸기·옮기기·보관(기존 다섯 버튼 시험의 단언을 메뉴로 옮긴다).
  - 봇·프로젝트 밖 에이전트·러너 토큰 카드가 지금과 같은 조건에서 있다.
- [ ] **Step 2:** FAIL 확인.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `pnpm -F @dodok/web exec vitest run src/features/connections src/features/runners` → PASS.
- [ ] **Step 5:** 커밋 `feat(web): runner detail cards with per-program rows and project overflow menu`.

### Task 5: 에이전트 상세

**Files:**
- Modify: `apps/web/src/features/connections/AgentDetail.tsx`
- Modify: `apps/web/src/features/agents/AgentRow.tsx`(`AgentAvatarField`·`DmAccessField`·`RunnerSessionDefaults`·`BasePromptEditor`·`ArchiveAgentButton` 를 카드에 나눠 쓸 수 있게 export·꼴만. `DmAccessField` 는 라디오 → 세그먼트 `role="group"` + `aria-pressed`)
- Test: `apps/web/src/features/agents/agentsRunner.test.tsx`, `apps/web/src/features/agents/agentsDm.test.tsx`, `apps/web/src/features/agents/agentsGateway.test.tsx`

**Interfaces:**
- Consumes: `ProgramBadge`(Task 1), `DetailCard`·`OverflowMenu`(Task 3).

- [ ] **Step 1: 시험** —
  - 러너 에이전트: 머리 칩 줄에 「Claude Code」 배지·「러너 dev-fake」 링크·「프로젝트 dodok」 링크. `region` 「실행」에 프로그램(읽기 전용 글, 셀렉트 없음)·새 세션 시작값·지시. 봇이면 지시 자리에 봇 정의·도구 칸.
  - OpenClaw 에이전트: 「실행」 카드 없음, 「프로필」 카드에 「메모 — 에이전트에게 전달되지 않음」.
  - 스위치 접근 이름 「에이전트 켜짐」 + 보이는 글 「켜짐」/「꺼짐」.
  - DM 허용: `group` 「DM 을 열 수 있는 사람」, 버튼 끔·admin 이상·모두, 누르면 지금과 같은 PATCH(기존 라디오 시험을 옮긴다).
  - 「관리」 카드: 옮기기(Gateway 옮기기 또는 다른 프로젝트로)·삭제.
- [ ] **Step 2:** FAIL 확인.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `pnpm -F @dodok/web exec vitest run src/features/agents src/features/connections` → PASS.
- [ ] **Step 5:** 커밋 `feat(web): agent detail as header and cards with read-only program`.

### Task 6: 전체 검사·문서·브라우저 확인

**Files:**
- Modify: `docs/manual/user-guide.md`(연결 탭 절 — 버튼 이름·자리, 프로그램 카드)

- [ ] **Step 1:** `pnpm -F @dodok/web typecheck && pnpm lint && pnpm fmt:check` → 오류 없음. 그 뒤 따로 `pnpm -F @dodok/web test` → 전부 PASS, 실행 수 적기.
- [ ] **Step 2:** user-guide 갱신(표 줄·`---` 앞 빈 줄 눈으로 확인).
- [ ] **Step 3:** dev:fake(워크트리 전용 포트, `docs/guideline/base/08-shared-resources.md`)로 neo 에서 확인 — 연결 탭: 사무실·집 Gateway, dev-fake·dev-fake 제한 러너, Coder·dev 에이전트, 승인 대기 Gateway(member mia 로 연결 추가), `POST /__devfake/runner {connected:false}` 로 끊긴 러너의 프로그램 카드. 좁은 화면 폭과 다크 모드도. 스크린숏을 보고서에. 연 탭은 닫는다.
- [ ] **Step 4:** 커밋 `docs: connections tab redesign in user guide`.
