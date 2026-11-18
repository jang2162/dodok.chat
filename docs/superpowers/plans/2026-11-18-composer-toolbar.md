# 작성기 도구 줄과 러너 에이전트 여럿 — 구현계획

> **For agentic workers:** 이 저장소에서는 Orca 워커가 이 계획을 태스크 순서대로 실행한다(`docs/guides/worktree-workflow.md`). 단계는 체크박스(`- [ ]`)로 따라간다.

**Goal:** 러너 에이전트 칩을 작성기 안 도구 줄로 옮기고, 에이전트가 1명·2~3명·4명 이상·좁은 화면일 때의 모양(펼친 칩·알약·「+N」·모은 알약)과 설정 패널을 만든다.

**Architecture:** `Composer` 가 입력 상자를 두 줄(입력 / 도구 줄)로 바꾸고 도구 줄의 에이전트 칸에 `AgentSettingsBar` 를 둔다. `AgentSettingsBar` 는 데이터 흐름(`rowOf`·보류 값·`SettingsLine`)을 그대로 두고 모양만 고른다 — 1명은 `SettingsLine` 을 그 자리에, 2명 이상은 새 `AgentPills`(알약·「+N」·모은 알약)와 그것이 여는 패널(넓은 화면 팝오버, 좁은 화면 시트) 안에 `SettingsLine` 들을 둔다.

**Tech Stack:** React 19 · Tailwind v4 · `radix-ui` 1.6.7(Popover·Dialog) · TipTap 3 · Vitest + Testing Library(jsdom)

**Spec:** `docs/superpowers/specs/2026-11-18-composer-toolbar-design.md` (결정 T1~T9). 시안: UI 개선 시안 5번(사용자 승인 2026-11-18).

## Global Constraints

- 칩·게이지의 접근 이름은 바꾸지 않는다 — `@<핸들> 모델: <값>`·`@<핸들> 노력치: …`·`@<핸들> 권한: …`·`컨텍스트 <퍼센트|—>`(스펙 2장 실패 첫째).
- 접는 기준 `FOLD_OVER = 3` 그대로(T4). 주의 구간 70 은 `ContextGauge` 와 한 상수(5.2).
- 390px 에서 가로 스크롤 금지(작성기 칩 스펙 5.4).
- 칩의 저장·잠금·선택지·게이지 세부 팝오버 동작은 바꾸지 않는다(스펙 2장 「하지 않을 것」 첫째).
- 글자 12px 미만 금지(작성기 안 — T7).
- 서브에이전트·포크를 띄우지 않고 `git stash` 를 쓰지 않는다. 커밋은 경로를 명시해 stage, Conventional Commits(`feat(web): …`).
- `pnpm test` 는 typecheck·build 와 동시에 돌리지 않는다.

## Review Focus

- 패널 안에서 칩 드롭다운을 열고 고르면 패널이 닫히지 않아야 한다(팝오버의 바깥 누름 판정이 포털로 뜬 메뉴를 바깥으로 읽기 쉽다) → Task 3 `panel stays open while picking a chip`.
- 초안에 멘션을 넣고 지워도 알약 순서가 그대로여야 한다(입력 중 흔들림) → Task 3 `mention highlights without reordering`.
- 새 세션 창에서 에이전트가 2명이면 패널에서 바꾼 값이 첫 `message.send` 의 `agentSettings` 에 실려야 한다(보류 값이 패널 줄을 거쳐도) → Task 3 `new-session pending via panel`.
- 패널이 열린 채 러너 에이전트가 1명으로 줄면(멤버 갱신) 패널이 닫히고 펼친 칩이 보여야 한다 → Task 3 `panel closes when agents drop to one`.
- Esc 로 패널·시트를 닫으면 초점이 연 버튼으로 돌아와야 한다 → Task 3·4 각 `escape returns focus`.

---

### Task 1: 칩·게이지의 보이는 글

**Files:**
- Modify: `apps/web/src/features/composer/AgentSettingChips.tsx`
- Modify: `apps/web/src/features/composer/ContextGauge.tsx`
- Test: `apps/web/src/features/composer/AgentSettingsBar.test.tsx`
- Test: `apps/web/src/features/composer/ContextGauge.test.tsx`

**Interfaces:**
- Produces: `export const CONTEXT_WARN_PERCENT = 70`, `export const CONTEXT_DANGER_PERCENT = 90`(`ContextGauge.tsx` — `tone` 이 이것을 쓴다).
- Produces: `ContextGauge({ percent, context, label = false }: { percent: number | null; context: RunnerContextBreakdown | null; label?: boolean })` — `label` 이면 보이는 글 「컨텍스트 31%」·「컨텍스트 —」.
- Produces: `export function GaugeRing({ percent, className }: { percent: number | null; className?: string }): JSX.Element` — 지금 게이지의 SVG 원(색 구간 포함)만, `aria-hidden`. `ContextGauge` 도 이것을 쓴다.
- Produces: `export function modelLabelOf(row: ConversationAgentSettings, models: readonly RunnerModelOption[]): string` (`AgentSettingChips.tsx`) — 칩이 보이는 모델 값(「기본」·표시 이름·저장값).

- [ ] **Step 1: 실패하는 시험** — `AgentSettingsBar.test.tsx` 의 「러너 에이전트마다 한 줄 — 칩 셋…」 단언을 바꾼다: `expect(chip("reviewer", "모델")).toHaveTextContent("모델 기본")`, 노력치 「노력 기본」, 권한 「권한 기본」. 다른 시험의 `toHaveTextContent("기본 모델"|"기본 노력"|"기본 권한")`(303·466·534줄 근처)도 같은 꼴로. `ContextGauge.test.tsx` 에 `it("label 이면 보이는 글이 「컨텍스트 31%」, 접근 이름은 「컨텍스트 31%」 그대로")` 와 `label` 없을 때 보이는 글 「31%」.
- [ ] **Step 2:** `pnpm -F @dodok/web exec vitest run src/features/composer/AgentSettingsBar.test.tsx src/features/composer/ContextGauge.test.tsx` — 바꾼 단언이 FAIL.
- [ ] **Step 3: 구현** — 칩 트리거 안을 `<span className="text-muted-foreground">모델</span> {값}` 꼴로(값: `modelLabelOf`·노력 단계 이름 또는 「기본」·권한 모드 또는 「기본」). `DEFAULT_MODEL_LABEL`·`DEFAULT_EFFORT_LABEL`·`DEFAULT_PERMISSION_LABEL` 을 지운다(사용처는 이 파일뿐). 노력치 경고(⚠) 표시는 그대로.
- [ ] **Step 4:** 같은 명령 PASS, 이어서 `pnpm -F @dodok/web typecheck`.
- [ ] **Step 5: Commit** — `feat(web): label composer agent chips with name and value`

### Task 2: 두 줄 작성기와 1명일 때의 펼친 칩

**Files:**
- Modify: `apps/web/src/features/composer/Composer.tsx`
- Modify: `apps/web/src/features/composer/AgentSettingsBar.tsx`
- Create: `apps/web/src/features/composer/mentionedAgents.ts`
- Test: `apps/web/src/features/composer/mentionedAgents.test.ts`
- Test: `apps/web/src/features/composer/AgentSettingsBar.test.tsx`
- Test: `apps/web/src/features/composer/Composer.test.tsx`

**Interfaces:**
- Consumes: Task 1 의 `ContextGauge` `label`.
- Produces: `export function mentionedAgentIds(doc: JSONContent): ReadonlySet<string>` — `mention` 노드의 `attrs.id` 가 `a:<id>` 인 것의 `<id>`(중첩 노드 포함).
- Produces: `AgentSettingsBar` 새 prop `mentioned?: ReadonlySet<string>`(Task 3 이 쓴다). 칸의 `data-testid="agent-settings-bar"` 는 그대로, 1명이면 `SettingsLine`(`agent-settings-<핸들>`)이 칸 안에 바로.

- [ ] **Step 1: 실패하는 시험**
  - `mentionedAgents.test.ts`: `it("a: 멘션만 모은다 — 사람(u:)·글자 @ 는 뺀다")` — 문단 안 `{type:"mention",attrs:{id:"a:A1"}}`·`{id:"u:U1"}`·목록 안 `{id:"a:A2"}` → `new Set(["A1","A2"])`. 빈 문서 → 빈 집합.
  - `Composer.test.tsx`: `it("입력 상자 안 도구 줄 — 첨부·보내기 버튼과 입력이 한 상자에, 러너가 없으면 에이전트 칸 없음")` — `screen.getByRole("button",{name:"파일 첨부"})` 와 `{name:"보내기"}` 가 같은 `data-testid="composer-toolbar"` 안, `queryByTestId("agent-settings-bar")` 는 null.
  - `AgentSettingsBar.test.tsx`: `it("1명이면 칩 셋을 도구 줄에 펼치고 게이지는 「컨텍스트 —」")` — `within(screen.getByTestId("composer-toolbar")).getByTestId("agent-settings-coder")` 가 있고, 그 안 `getByRole("button",{name:"컨텍스트 —"})` 의 글이 「컨텍스트 —」.
- [ ] **Step 2:** `pnpm -F @dodok/web exec vitest run src/features/composer` — 새 시험 FAIL.
- [ ] **Step 3: 구현**
  - `Composer.tsx`: 입력 상자 안을 첨부 미리보기 → `EditorContent`(전체 폭) → `<div data-testid="composer-toolbar" className="flex flex-wrap items-center gap-1.5">` [첨부][`AgentSettingsBar`][`flex-1`][보내기] 로. `AgentSettingsBar` 를 상자 밖에서 안으로 옮기고 `mentioned={…}` 를 넘긴다 — 에디터 `update` 마다 `mentionedAgentIds(editor.getJSON())` 를 구해 이전 집합과 같으면 상태를 바꾸지 않는다.
  - `AgentSettingsBar.tsx`: 1명이면 `SettingsLine` 하나(테두리 묶음 — 시안 A)를 그리고 게이지에 `label`. 2명 이상은 이 태스크에서는 지금 동작(줄 쌓기·접기)을 그대로 둔다 — Task 3 이 바꾼다. 「초대됨」은 `text-xs`(12px — T7).
- [ ] **Step 4:** `pnpm -F @dodok/web exec vitest run src/features/composer` PASS(기존 시험 포함 — 실행 수를 보고에 적는다), `pnpm -F @dodok/web typecheck`.
- [ ] **Step 5: Commit** — `feat(web): two-row composer with agent chips in the toolbar`

### Task 3: 2명 이상 — 알약·「+N」·설정 패널·멘션 강조

**Files:**
- Create: `apps/web/src/ui/popover.tsx`
- Create: `apps/web/src/features/composer/AgentPills.tsx`
- Modify: `apps/web/src/features/composer/AgentSettingsBar.tsx`
- Test: `apps/web/src/features/composer/AgentSettingsBar.test.tsx`

**Interfaces:**
- Consumes: Task 1 `GaugeRing`·`modelLabelOf`·`CONTEXT_WARN_PERCENT`, Task 2 `mentioned`.
- Produces: `ui/popover.tsx` — shadcn 꼴 `Popover`·`PopoverTrigger`·`PopoverContent`(`radix-ui` 의 `Popover`, 포털, `data-slot`).
- Produces: `export function orderForPills<T extends { agent: Agent; row: ConversationAgentSettings }>(items: readonly T[]): T[]` (`AgentSettingsBar.tsx`) — `row.contextPercent >= CONTEXT_WARN_PERCENT` 인 것을 앞으로, 나머지는 받은 순서(안정 정렬).
- Produces: `AgentPills` — props `{ items: readonly { agent: Agent; row: ConversationAgentSettings; invited: boolean }[]; mentioned: ReadonlySet<string>; compact: boolean; isNew: boolean; renderLine: (item) => ReactNode }`. `compact` 은 Task 4 가 쓴다(이 태스크에서는 `false` 만).
- 정확한 이름(스펙 5.2): 알약 `data-testid="agent-pill-<핸들>"`, 접근 이름 `` `@${handle} 설정 — 모델 ${modelLabelOf(row, row.models)}, 컨텍스트 ${percent === null ? "—" : `${percent}%`}` ``, 멘션이면 뒤에 `" — 이 글에서 부름"`. 「+N」 `data-testid="agent-pill-more"`, 이름 `` `에이전트 ${n}명 더` ``(+ 같은 꼬리). 패널 `role="dialog"`, 이름 `` `러너 에이전트 ${N}` ``, 안내 글 대화 있음 「바꾸면 이 세션에 바로 저장됩니다」 / 새 세션 창 「첫 메시지와 함께 저장됩니다」. 버튼마다 `aria-haspopup="dialog"`·`aria-expanded`.

- [ ] **Step 1: 실패하는 시험** — `AgentSettingsBar.test.tsx` 에 도우미 `openPanel(name?: RegExp)`(알약 또는 「+N」을 눌러 `findByRole("dialog")` 를 돌려준다)를 두고, 2명 이상을 쓰는 기존 시험(「러너 에이전트마다 한 줄…」, 모델·노력치·권한 칩, 새 세션 창, 스레드 작성기 중 2명 이상인 것)은 칩을 찾기 전에 `openPanel()` 을 부르게 고친다. 새 시험:
  - `it("2명이면 알약 둘 — 점·핸들·모델·컨텍스트, 누르면 패널에 줄 둘이고 누른 에이전트 줄로 초점")`.
  - `it("셋이면 알약 셋, 넷이면 알약 둘 + 「+2」 — 70% 이상이 앞")` — `contextPercent` 를 coder 10·reviewer null·tester 72·docs 5 로 주면 보이는 알약은 tester·coder, 「+2」, 패널 줄 순서 tester·coder·reviewer·docs. (지금의 「넷이면 「러너 에이전트 4」 한 줄로 접히고…」·「셋이면 접지 않는다」 시험은 이것으로 바꾼다.)
  - `it("mention highlights without reordering")` — 초안에 `@reviewer` 멘션 노드를 넣으면(`setDoc`) reviewer 알약 이름에 「이 글에서 부름」, 알약 순서 그대로. 접힌 에이전트를 멘션하면 「+N」 이름에 꼬리.
  - `it("panel stays open while picking a chip")` — 패널을 열고 `pick("reviewer","모델",<그 시험 픽스처 목록의 다른 모델>)` 뒤에도 `getByRole("dialog")` 가 있고 PATCH 하나.
  - `it("new-session pending via panel")` — 새 세션 창·2명, 패널에서 tester 노력치를 바꾸고 보내면 첫 `message.send` 의 `agentSettings[testerId].effort` 가 그 값, PATCH 0.
  - `it("panel closes when agents drop to one")` — 패널을 연 채 멤버 쿼리를 1명으로 갈아 끼우면(`qc.setQueryData`) dialog 가 없어지고 펼친 칩이 보인다.
  - `it("escape returns focus")` — 알약으로 연 패널에서 `{Escape}` → 그 알약에 초점.
- [ ] **Step 2:** `pnpm -F @dodok/web exec vitest run src/features/composer/AgentSettingsBar.test.tsx` — 새 시험 FAIL.
- [ ] **Step 3: 구현** — `AgentSettingsBar` 가 2명 이상이면 `AgentPills` 에 `orderForPills(items)` 와 `renderLine`(지금의 `SettingsLine`)을 넘긴다. 알약 수: `items.length <= FOLD_OVER` 면 전부, 넘으면 앞 2개 + 「+(N-2)」. 패널은 하나(누른 버튼에 따라 초점 줄만 다름), 열린 상태는 `AgentPills` 가 쥔다. 칩의 `DropdownMenuContent` 가 포털로 떠도 팝오버가 닫히지 않게 `PopoverContent` 의 `onInteractOutside` 에서 대상이 Radix 메뉴(`[data-radix-popper-content-wrapper]` 안)면 `preventDefault()`. 패널 너비는 작성기 폭을 넘지 않게(`max-w-[min(40rem,calc(100vw-2rem))]`). 알약 핸들은 `max-w-32 truncate`.
- [ ] **Step 4:** `pnpm -F @dodok/web exec vitest run src/features/composer` PASS — 실행 수 보고. 구분력: `orderForPills` 를 받은 순서 그대로 돌려주게 되돌려 「넷이면…」 시험이 FAIL 하는지 보고 복구, `onInteractOutside` 를 빼서 「panel stays open…」이 FAIL 하는지 보고 복구(실패하지 않으면 덮지 말고 그렇다고 보고). `git status` 깨끗.
- [ ] **Step 5: Commit** — `feat(web): agent pills and settings panel for multiple runner agents`

### Task 4: 좁은 화면·스레드 작성기의 모은 알약과 시트

**Files:**
- Modify: `apps/web/src/features/composer/AgentPills.tsx`
- Modify: `apps/web/src/features/composer/AgentSettingsBar.tsx`
- Test: `apps/web/src/features/composer/AgentSettingsBar.test.tsx`

**Interfaces:**
- Consumes: Task 3 `AgentPills`(`compact`), `ui/sheet.tsx`(`Sheet`·`SheetContent side="bottom"`·`SheetTitle`), `useIsNarrow`(`@/hooks/useIsNarrow`), 시험은 `test/media.ts` 의 `stubMedia(true)`.
- Produces: `compact = isNarrow || threadRootId !== undefined`(2명 이상일 때만 의미). 모은 알약 `data-testid="agent-pill-summary"`, 이름 `` `러너 에이전트 ${N} 설정` ``(+ 멘션 꼬리), 보이는 글 「에이전트 N」 + 점 셋(`orderForPills` 앞 셋) + 가장 높은 퍼센트(없으면 「—」).

- [ ] **Step 1: 실패하는 시험**
  - `it("좁은 화면 3명 — 모은 알약 하나, 가장 높은 %, 누르면 아래 시트에 줄 셋")` — `stubMedia(true)`, 퍼센트 10·72·null → 알약 글에 「에이전트 3」「72%」, 누르면 `findByRole("dialog",{name:"러너 에이전트 3"})` 안에 줄 셋.
  - `it("넓은 화면의 스레드 작성기도 모은 알약 — 시트가 아니라 패널")`.
  - `it("좁은 화면 1명은 펼친 칩 그대로")`.
  - `it("모은 알약도 멘션하면 이름에 「이 글에서 부름」")`.
  - `it("escape returns focus")`(시트).
- [ ] **Step 2:** 같은 파일 실행 — FAIL.
- [ ] **Step 3: 구현** — `compact` 이면 알약 대신 모은 알약 하나. 좁은 화면이면 Task 3 의 팝오버 대신 `Sheet`(아래, 줄 `min-h-11`), 아니면 팝오버. `SheetTitle` 이 dialog 이름이 되게 「러너 에이전트 N」.
- [ ] **Step 4:** `pnpm -F @dodok/web exec vitest run src/features/composer` PASS, `pnpm -F @dodok/web typecheck`, `pnpm lint`, `pnpm fmt`. 이어서 단독으로 `pnpm -F @dodok/web test` — 실행 수와 결과를 보고에 적는다.
- [ ] **Step 5: Commit** — `feat(web): collapse agent pills on narrow screens and threads`

### Task 5: 문서와 브라우저 확인

**Files:**
- Modify: `docs/superpowers/specs/2026-11-11-runner-session-settings-design.md`(S3 표 줄·5.4 해당 문장 뒤에 「→ 2026-11-18 작성기 도구 줄 스펙 T1~T6 으로 바뀜(`docs/superpowers/specs/2026-11-18-composer-toolbar-design.md`)」 — 지우지 않는다)
- Modify: `docs/superpowers/specs/2026-11-17-composer-agent-chips-design.md`(5.4 「접기」 줄에 같은 표시)
- Modify: `docs/manual/user-guide.md`(「러너 에이전트 상태 줄」 절 → 「러너 에이전트 칩」, 스펙 5.4 가 나열한 「상태 줄」 자리 전부)
- Modify: `docs/guides/agent-guide.md`(러너 절의 「채널 작성기 위 상태 줄」과 절 인용)
- Modify: `docs/guides/plan.md`(8장 「이월」에 T9 한 줄)

- [ ] **Step 1:** 문서를 고친다 — 사용자 안내 절은 1명(펼친 칩)·2~3명(알약 → 패널)·4명 이상(앞 둘 + 「+N」, 70% 이상이 앞)·좁은 화면·스레드(모은 알약)·멘션 강조를 지금 절의 문체로. 칩의 선택지·누가 무엇을 고르나·게이지 세부 문단은 그대로 두고 칩 이름 꼴만(「기본 모델」 → 「모델 기본」).
- [ ] **Step 2:** `grep -nE '상태 줄' docs/manual/user-guide.md docs/guides/agent-guide.md` — 0줄이어야 한다(나오면 고친다). `---` 앞 빈 줄과 표 줄을 눈으로 본다(oxfmt 는 md 를 보지 않는다).
- [ ] **Step 3: 브라우저 확인** — 워크트리 전용 포트로 `dev:fake`(서버 3100 대, `PORT`·`APP_ORIGIN`·`DODOK_API_ORIGIN`·`--port` 를 함께) + 웹. 앱에서 가짜 러너 「dev-fake」에 러너 에이전트를 넷 더 만들어 채널 「세션」에 넣는다(`docs/manual/user-guide.md` 러너 에이전트 만들기 절). 1명·3명·5명 × 1440px·390px × 라이트·다크 화면을 찍고, 390px 에서 `document.documentElement.scrollWidth === 390`, 패널·시트를 Tab·Esc 로 다뤄 초점이 돌아오는지, 패널 안에서 칩을 골라도 패널이 남는지 본다. 도구 고르기는 `docs/guides/browser-verification.md`. 네가 연 탭은 네가 닫아라. 띄운 서버는 끝에 끈다.
- [ ] **Step 4: Commit** — `docs: composer toolbar and multi-agent chips`(문서 파일 경로를 명시해 stage)
