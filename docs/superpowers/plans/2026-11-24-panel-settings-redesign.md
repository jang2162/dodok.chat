# 채널 오른쪽 패널 머리·설정 탭 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 Orca 워커가 워크트리 안에서 이 계획을 한 작업씩 실행한다.

**Goal:** 채널 오른쪽 패널의 머리를 탭 한 줄로 합치고(스펙 목표 5), 설정 탭의 섹션별 「저장」을 패널 아래 저장 막대 하나로 바꾼다(스펙 목표 6).

**Architecture:** `PanelTabs` 의 바깥 틀·포털·초점 규칙은 그대로 두고 머리 줄만 다시 그린다. 설정 탭은 `ChannelSettingsPanel` 안에 초안 등록소(컨텍스트)를 두고, 저장 버튼이 있던 세 섹션(기본·채널 프롬프트·릴레이 정책)이 자기 초안·저장 함수를 등록한다. 저장 막대가 그것을 모아 차례로 저장한다. 즉시 저장되던 칸은 그대로. 떠날 때는 TanStack Router 차단으로 묻는다. 서버 무변경.

**Tech Stack:** React 19, TanStack Router 1.170(`useBlocker`), TanStack Query(`mutateAsync`), Tailwind v4, shadcn `@/ui/*`, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-24-connections-and-panel-redesign-design.md`(목표 5·6, 반목표, 정한 것의 저장 막대 범위·떠날 때 확인). 시안: https://claude.ai/artifact/7gJsBvbHjuvNACCyy6vWex 의 「바꾼 뒤 — 패널 · 설정」.

## Global Constraints

- 서버·shared 무변경. 활동 탭 내용(`features/activity/*`)은 건드리지 않는다 — `inline-activity` 워커가 고치는 중이다.
- 패널 보장 넷을 지킨다(반목표): 탭을 옮겨도 머리 링크가 언마운트되지 않음(D3), 폭이 바뀌어도 같은 `host` 포털이라 초안 유지, 닫으면 여는 자리로 초점(D14), DM 종류별 `only` 탭 목록.
- 패널 폭 384px(넓은 화면). 좁은 화면은 지금처럼 전체 화면 시트.
- 저장 막대에 드는 것은 기본·채널 프롬프트·릴레이 정책 셋뿐. 세션 정책·자동 응답·세션 관리자·멤버 넣기·빼기·에이전트별 채널 프롬프트 오버라이드는 지금처럼 즉시 저장.
- 권한이 없으면(잠금) 그 섹션은 초안을 등록하지 않는다 — 막대에 세지 않는다.
- 저장 중 초점 규칙(키보드로 저장한 사람의 초점이 `<body>` 로 떨어지지 않음)은 막대의 「저장」 버튼으로 옮겨 지킨다 — `disabled` 대신 `aria-disabled`.
- 오류 표시 규칙 그대로: VALIDATION·CONFLICT 는 그 섹션 안, 그 밖은 전역 토스트.
- 커밋은 경로를 적어 stage, `feat(web): …`.

## Review Focus

1. 두 섹션을 고치고 저장했는데 하나만 실패 — 성공한 섹션은 저장됨·초안 해제, 실패한 섹션 칸 옆에 오류, 막대는 「바뀐 항목 1개」로 남는다. (Task 2 시험)
2. 바뀐 것이 있는 채 패널 닫기·다른 탭·다른 채널 — 확인 대화상자, 「취소」면 그대로, 「버리기」면 이동, 「저장」이면 저장 성공 뒤 이동(실패면 머문다). (Task 3 시험)
3. 저장 중에 또 고치기 — 저장이 끝난 뒤 새로 고친 값은 초안으로 남는다(서버 응답이 덮지 않는다). (Task 2 시험)
4. admin 이 member 로 강등된 직후 — 잠긴 섹션은 서버 값을 보이고 막대에서 빠진다(지금 `OverrideEditor` 규칙과 같다). (Task 2 시험)
5. 좁은 화면 시트에서 막대가 시트 아래에 붙고 화면 키보드에 가려지지 않는다 — 브라우저 확인(Task 4).

---

### Task 1: 패널 머리 한 줄

**Files:**
- Modify: `apps/web/src/app/layout/PanelTabs.tsx`(머리 줄·폭)
- Modify: `apps/web/src/features/messages/ChannelPage.tsx`(새 prop 전달만)
- Test: `apps/web/src/app/layout/layout.test.tsx`, `apps/web/src/features/settings/settings.test.tsx`

**Interfaces:**
- Produces: `PanelTabs` 새 prop `badges?: Partial<Record<PanelTab, number>>` — 0 이나 없음이면 그리지 않는다. 배지의 접근 이름은 탭 이름에 붙는다(「활동, 승인 대기 1」). 활동 탭 작업(다른 계획)이 수를 채운다 — 이 작업에서는 ChannelPage 가 넘기지 않는다.

- [ ] **Step 1: 시험** —
  - 패널에 보이는 제목 줄(「채널 설정」 큰 글)이 없고, 탭 `nav` 「패널 탭」 한 줄 + 「패널 닫기」. 패널 `aside` 의 접근 이름은 지금 제목(스크린 리더용, `aria-labelledby` 유지).
  - 지금 탭은 `aria-current="page"`.
  - `badges={{ activity: 2 }}` 면 활동 탭 접근 이름이 「활동, 승인 대기 2」.
  - 기존 「탭을 옮겨도 초점이 `<body>` 가 아니다」·「닫으면 초점이 여는 자리로」·「폭이 바뀌어도 초안 그대로」 시험이 그대로 PASS(「설정 닫기」 같은 이름을 바꾸면 단언을 옮긴다).
- [ ] **Step 2:** `pnpm -F @dodok/web exec vitest run src/app/layout src/features/settings` → 새 시험 FAIL.
- [ ] **Step 3:** 구현 — 탭은 세그먼트 꼴(아이콘 + 글), 스레드·프로필 탭은 열렸을 때만(지금 규칙).
- [ ] **Step 4:** 같은 명령 → PASS, 실행 수 확인.
- [ ] **Step 5:** 커밋 `feat(web): single-row panel header with segmented tabs`.

### Task 2: 초안 등록소와 저장 막대

**Files:**
- Create: `apps/web/src/features/settings/draft.tsx`
- Create: `apps/web/src/features/settings/SaveBar.tsx`
- Modify: `apps/web/src/features/settings/ChannelSettingsPanel.tsx`(등록소 Provider, 막대를 패널 아래에)
- Modify: `apps/web/src/features/settings/BasicSection.tsx`, `apps/web/src/features/settings/PromptSection.tsx`, `apps/web/src/features/settings/RelayPolicySection.tsx`(각 섹션의 「저장」 버튼 제거, 등록)
- Modify: `apps/web/src/features/settings/Section.tsx`(섹션 머리 꼴 — 작은 회색 글, 섹션 사이 선)
- Test: `apps/web/src/features/settings/settings.test.tsx`, `apps/web/src/features/settings/mutations.test.tsx`, `apps/web/src/features/settings/roleView.test.tsx`

**Interfaces:**
- Produces(`draft.tsx`):
  - `type DraftKey = "basic" | "prompt" | "relay"`
  - `type DraftEntry = { changed: number; save(): Promise<void>; reset(): void }` — `changed` 는 바뀐 칸 수(0 이면 없는 것과 같다). `save` 는 실패하면 reject(섹션이 오류를 제 안에 이미 보였다).
  - `DraftProvider({ children })`
  - `useRegisterDraft(key: DraftKey, entry: DraftEntry | null): void` — null(잠금·바뀐 것 없음)이면 빠진다.
  - `useDrafts(): { total: number; saving: boolean; saveAll(): Promise<boolean>; resetAll(): void }` — `saveAll` 은 바뀐 섹션을 `basic → prompt → relay` 차례로, 하나가 실패해도 나머지를 계속, 모두 성공이면 true.
- `SaveBar()` — `total > 0` 일 때만. 「바뀐 항목 N개」·「되돌리기」·「저장」(저장 중 「저장 중…」, `aria-disabled`).

- [ ] **Step 1: 시험 옮기기(settings.test.tsx)** — 섹션별 「저장」을 누르던 시험을 모두 막대의 「저장」으로 옮긴다(PATCH 본문 단언은 그대로). 추가:
  - 아무것도 안 고치면 막대 없음. 이름을 고치면 「바뀐 항목 1개」, 이름 칸에 바뀐 표시(`data-dirty`).
  - 이름·채널 프롬프트를 고치고 저장 → PATCH 둘(기본 먼저), 막대 사라짐, 「저장했습니다」.
  - 기본은 성공·프롬프트는 VALIDATION → 기본은 저장됨, 프롬프트 섹션 안 오류, 막대 「바뀐 항목 1개」.
  - 「되돌리기」 → 서버 값으로, 막대 사라짐.
  - 저장 중에 이름을 또 고치면, 저장이 끝난 뒤 그 새 값이 초안으로 남는다.
  - 키보드로 막대 「저장」 → 저장 중·뒤에도 초점이 그 버튼(옛 「키보드로 저장하면…」 시험을 옮긴다).
  - 세션 정책을 고르면 막대 없이 바로 PATCH(그대로).
- [ ] **Step 2: 시험(roleView.test.tsx)** — member 가 보면 잠긴 섹션은 막대에 들지 않는다. 고치던 중 강등되면 그 섹션 초안이 빠지고 서버 값.
- [ ] **Step 3:** FAIL 확인.
- [ ] **Step 4:** 구현 — 섹션의 `mutate` 를 `mutateAsync` 로, 성공 처리(캐시 갱신·「저장했습니다」)는 지금 자리 그대로.
- [ ] **Step 5:** `pnpm -F @dodok/web exec vitest run src/features/settings` → PASS, 실행 수 확인.
- [ ] **Step 6:** 커밋 `feat(web): one save bar for channel settings sections`.

### Task 3: 떠날 때 확인과 컨트롤 꼴

**Files:**
- Create: `apps/web/src/features/settings/LeaveGuard.tsx`
- Modify: `apps/web/src/features/settings/ChannelSettingsPanel.tsx`(LeaveGuard 를 Provider 안에)
- Modify: `apps/web/src/features/settings/RelayPolicySection.tsx`(턴 상한 −/+ 스텝퍼 — 숫자 칸은 그대로 두고 양옆 버튼, 「모든 에이전트끼리 허용」 설명 있는 스위치 줄)
- Modify: `apps/web/src/features/settings/SessionSection.tsx`(라디오 → 세그먼트 `role="group"` 「새 세션을 만들 수 있는 사람」 + `aria-pressed`, 즉시 저장 그대로)
- Modify: `apps/web/src/features/settings/ArchiveSection.tsx`(맨 아래 접힌 줄 「채널 보관」, 펼치면 지금 내용)
- Test: `apps/web/src/features/settings/settings.test.tsx`

**Interfaces:**
- Consumes: `useDrafts`(Task 2).
- `LeaveGuard()` — `useBlocker({ shouldBlockFn: () => total > 0, withResolver: true })`. 대화상자(`@/ui/dialog`) 「저장하지 않은 변경 N개」 + 「저장」·「버리기」·「취소」. 「저장」은 `saveAll()` 이 true 일 때만 진행, false 면 머문다. 브라우저 새로고침·창 닫기는 `enableBeforeUnload: () => total > 0`.

- [ ] **Step 1: 시험** —
  - 이름을 고친 채 활동 탭 링크 → 대화상자. 「취소」 → 설정 탭 그대로·초안 그대로. 「버리기」 → 활동 탭. 「저장」 → PATCH 뒤 활동 탭.
  - 「저장」인데 VALIDATION → 머문다, 섹션 안 오류.
  - 고친 채 「패널 닫기」·다른 채널 링크도 같은 대화상자.
  - 바뀐 것이 없으면 대화상자 없이 이동.
  - 턴 상한 「늘리기」 → 값 +1(최대 32 에서 잠김), 「줄이기」 최소 0.
  - 세션 정책 세그먼트 누르면 즉시 PATCH(기존 시험을 옮긴다).
- [ ] **Step 2:** FAIL 확인.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `pnpm -F @dodok/web exec vitest run src/features/settings src/app/layout src/features/messages` → PASS.
- [ ] **Step 5:** 커밋 `feat(web): confirm unsaved channel settings on leave and refreshed controls`.

### Task 4: 전체 검사·문서·브라우저 확인

**Files:**
- Modify: `docs/manual/user-guide.md`(채널 설정 절 — 저장 막대, 떠날 때 확인, 패널 머리)

- [ ] **Step 1:** `pnpm -F @dodok/web typecheck && pnpm lint && pnpm fmt:check` → 오류 없음. 그 뒤 따로 `pnpm -F @dodok/web test` → 전부 PASS, 실행 수 적기.
- [ ] **Step 2:** user-guide 갱신.
- [ ] **Step 3:** dev:fake(워크트리 전용 포트)로 neo 에서 — 넓은 화면·좁은 화면(시트), 설정 고치기 → 막대 → 저장, 고친 채 탭 옮기기 → 확인 대화상자, member(mia) 로 잠긴 섹션, 그룹 DM·에이전트 DM 의 탭 목록, 다크 모드. 스크린숏을 보고서에. 연 탭은 닫는다.
- [ ] **Step 4:** 커밋 `docs: channel settings save bar in user guide`.
