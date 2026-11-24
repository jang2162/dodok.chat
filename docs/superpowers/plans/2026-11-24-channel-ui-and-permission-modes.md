# 채널 설정 UI 다듬기·러너 권한 auto·bypass 구현 계획

> **For agentic workers:** 이 계획은 서로 독립인 네 줄(A~D)이다. 워커는 브리프가 가리킨 **한 줄만** 한다. 단계는 `- [ ]` 로 표시한다.

**Goal:** 실사용에서 나온 불편 넷 — 러너 권한 `auto`·`bypassPermissions`, 러너 설정 패널의 「기본」 실제 값·열 정렬, 릴레이 허용 쌍 격자, 채널 통합 초대.

**Architecture:** 권한 모드는 shared 의 순서 배열 하나가 정본이라 그 끝에 둘을 붙이면 서버·러너·어댑터·웹의 상한 비교가 그대로 따라온다. 「기본」 표시는 러너가 SDK 의 default 줄 정보를 계약에 더 실어 보낸다. 나머지 둘은 웹 화면만 바꾼다(사람 멤버 추가 API 는 이미 있다).

**Tech Stack:** pnpm 모노레포, Zod(shared), Fastify(server), React + TanStack Query + Radix(web), Claude Agent SDK 0.3.283(claude-runner), vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-channel-ui-and-permission-modes-design.md`

**순서:** A·C·D 는 병렬. B 는 A 를 병합한 뒤 시작한다(둘 다 `AgentSettingChips.tsx`·shared 계약·러너 드라이버를 만진다. B 의 권한 「기본」 표시는 A 의 새 모드를 안다).

## Global Constraints

- 권한 순서: `["plan", "dontAsk", "default", "acceptEdits", "auto", "bypassPermissions"]` — 이 배열이 정본, 비교는 `permissionModeRank` 로만.
- 러너 `maxPermissionMode` 기본값은 `"default"` 그대로. 새 두 모드는 사람이 러너 설정에서 고를 때만 열린다.
- 「기본」(null) 권한은 지금처럼 min(default, 상한) — 상한이 열려도 저절로 올라가지 않는다(`resolvePermissionMode`).
- default 위 모드를 고를 권한은 지금 규칙(`policies.ts` — 러너 주인·admin)을 그대로 쓴다.
- Claude Agent SDK 는 claude-runner dependencies 의 정확 핀 그대로(판 올리지 않는다).
- 화면 문구 고정: 경고 「승인 카드 없이 실행됩니다」, 노력치 기본 「기본 · 모델 기본」, 모델 기본 「기본 · <이름>」, 권한 기본 「기본 · <모드>」.
- 커밋은 경로를 명시해 stage, Conventional Commits(`feat(web): …`, `feat(runner): …`, `feat(shared): …`).
- 검증: 바꾼 패키지의 `pnpm -F <패키지> test`(실행 개수를 보고에 적는다), `pnpm typecheck`, `pnpm lint`, `pnpm fmt`. `pnpm test` 는 typecheck 와 동시에 돌리지 않는다.

## Review Focus

- **옛 러너(새 모드를 모르는 판)에 붙은 에이전트** — 서버 `policies.ts` 상한 검사가 러너가 알린 상한(최대 acceptEdits)으로 막아야 한다. 러너가 끊긴 동안 저장된 `auto` 가 옛 러너로 다시 붙은 뒤 런으로 가면 사람이 읽을 수 있는 카드가 떠야 한다(Zod 파싱 실패로 조용히 죽지 않는다). → A 의 Task A2 시험.
- **`auto` 를 지원하지 않는 모델(`supportsAutoMode` 없음)** — 런이 조용히 default 로 돌거나 죽지 않고, 결과가 문서에 적혀야 한다. → A 의 Task A3.
- **옛 러너가 보낸 모델 목록(새 필드 없음)** — 「기본」 칩이 「기본」 그대로, 깨지지 않는다. → B 의 Task B1 시험.
- **릴레이 격자에 에이전트가 1개·10개 이상** — 1개면 안내 문구, 많으면 표만 가로 스크롤하고 페이지는 넘치지 않는다. 기존 `allowPairs` 에 채널에서 빠진 에이전트 쌍이 있어도 저장 때 사라지지 않는다(지금 동작 유지). → C 의 Task C1 시험.
- **통합 초대에서 여럿을 고르고 일부가 실패(예: 보관된 에이전트 409)** — 성공한 것은 들어가고 실패한 것만 그 자리에 이유와 함께 남는다. → D 의 Task D1 시험.

---

## A. 러너 권한 `auto`·`bypassPermissions`

### Task A1: shared 순서 배열과 상한 비교

**Files:**
- Modify: `packages/shared/src/domain/index.ts`(`RUNNER_PERMISSION_MODES` 와 그 주석 — 옛 「bypassPermissions 는 받지 않는다」 결정을 새 결정으로 바꾼다)
- Test: `packages/shared/test/runner-v2.test.ts`, `packages/shared/test/runner-rest.test.ts`, `packages/shared/test/control.test.ts`
- 따라오는 곳(값 비교만 — 고칠 것이 있으면): `packages/runner-adapter/src/runner-adapter.ts`(`resolvePermissionMode`), `packages/runner-adapter/test/runner-adapter.test.ts`, `apps/server/src/auth/policies.ts`, `apps/server/src/modules/runners/live.ts`, `apps/server/test/roles.matrix.test.ts`, `apps/server/test/agent-settings.routes.test.ts`, `apps/server/test/fakes/fake-runner.ts`

**Interfaces:**
- Produces: `RUNNER_PERMISSION_MODES = ["plan","dontAsk","default","acceptEdits","auto","bypassPermissions"] as const`, `RunnerPermissionMode` 에 두 값.

- [ ] 시험 먼저: `permissionModeRank("auto") > permissionModeRank("acceptEdits")`, `permissionModeRank("bypassPermissions") > permissionModeRank("auto")`, `RunnerPermissionMode.parse("bypassPermissions")` 성공. `resolvePermissionMode(null, "bypassPermissions") === "default"`. 서버: 상한 `acceptEdits` 러너에 `auto` PATCH → 400 VALIDATION `field: "permissionMode"`, 상한 `bypassPermissions` 러너에 member 가 `auto` → 403, 주인·admin → 200.
- [ ] 실패 확인 → 배열 바꾸기 → 통과 확인 → 커밋.

### Task A2: 러너 — 설정·드라이버·옛 러너

**Files:**
- Modify: `packages/claude-runner/src/setup.ts`(`PERMISSION_CHOICES`), `packages/claude-runner/src/drivers/claude/run.ts`(`buildQueryOptions`, `preToolDecision` 주석), `packages/claude-runner/src/ceiling.ts`(바뀔 것 없으면 그대로)
- Test: `packages/claude-runner/test/setup.test.ts`, `packages/claude-runner/test/run.test.ts`, `packages/claude-runner/test/ceiling.test.ts`, `packages/claude-runner/test/config.test.ts`, `packages/claude-runner/test/adapter-integration.test.ts`

- [ ] 시험: `PERMISSION_CHOICES` 에 `auto`·`bypassPermissions` 줄이 있고, 둘 중 하나를 고르면 `「승인 카드 없이 실행됩니다 — 이 상한을 연 사람이 책임집니다」` 경고를 출력한 뒤 `y` 확인을 받는다(아니면 다시 묻는다). 기본 선택(빈 입력, 이전 값 없음)은 여전히 `default`.
- [ ] 시험: `buildQueryOptions` 가 `permissionMode: "bypassPermissions"` 일 때만 `allowDangerouslySkipPermissions: true` 를 싣는다. `auto` 는 SDK 에 그대로 넘긴다. `preToolDecision(tool, "auto")`·`(tool, "bypassPermissions")` 는 `null`.
- [ ] 시험: 러너 config 의 `maxPermissionMode` 가 없으면 `"default"`. 상한 `acceptEdits` 러너가 `auto` 런을 받으면 `RUNNER_CEILING` 카드(기존 길).
- [ ] 옛 러너 확인: 지금 배포된 러너 판(새 enum 모름)이 `permissionMode: "auto"` 가 실린 `run.start` 를 받으면 어떻게 되는지 `adapter-integration` 또는 서버 쪽 시험으로 재현한다. 조용히 사라지면 서버가 보내기 전에 러너가 알린 상한으로 막아 카드로 바꾼다(`apps/server/src/modules/runners/live.ts` 의 `ceilingMiss` 길을 런 시작에도). 보고에 결과를 적는다.
- [ ] 구현 → 통과 → 커밋. 러너 판 올림은 `docs/guides/runner-release.md` 절차를 따라 이 줄에서 한다.

### Task A3: 웹 선택지·경고, `auto` 미지원 모델, 문서

**Files:**
- Modify: `apps/web/src/features/composer/AgentSettingChips.tsx`, `apps/web/src/features/agents/RunnerAgentForm.tsx`
- Test: `apps/web/src/features/composer/AgentSettingsBar.test.tsx`, `apps/web/src/features/agents/agentsRunner.test.tsx`, `apps/web/src/features/runners/runners.test.tsx`
- Docs: `docs/guides/plan.md`(10장 결정 한 줄·8장), `docs/guides/agent-guide.md`, `docs/manual/user-guide.md`(권한 모드 설명), `docs/guides/live-smoke.md`(러너 상한 설정 절에 두 모드)

- [ ] 시험: 상한이 `bypassPermissions` 인 러너면 권한 칩에 `auto`·`bypassPermissions` 가 고를 수 있게 뜨고, 각 줄에 「승인 카드 없이 실행됩니다」 안내. 상한이 `acceptEdits` 면 두 줄은 지금의 상한 잠금 사유로 막힌다. 고른 칩이 두 모드 중 하나면 칩에 경고색(`text-destructive` 계열) — 접근 이름에도 안내가 붙는다.
- [ ] 런 0회 하네스(`docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」)로 `auto` 를 `supportsAutoMode` 없는 모델에 걸었을 때 SDK 가 무엇을 하는지 확인하고 결과를 spec 의 「빌더에게 남긴 것」 옆과 live-smoke 에 적는다. 모델 런은 하지 않는다.
- [ ] 문서 갱신 → `pnpm -F @dodok/web test` → 커밋.

---

## B. 「기본」 실제 값과 열 정렬 (A 병합 뒤)

### Task B1: 모델 목록에 default 줄의 해석된 모델

**Files:**
- Modify: `packages/shared/src/domain/index.ts`(`RunnerModelOption` 에 `resolvedLabel: z.string().max(80).optional()`), `packages/claude-runner/src/drivers/claude/index.ts`(`toModelOptions`), `packages/claude-runner/src/drivers/claude/sdk.ts`(`SdkModelInfo` 에 `resolvedModel`·`description`)
- Test: `packages/claude-runner/test/models.test.ts`, `packages/claude-runner/test/connection.test.ts`, `apps/server/test/agent-settings.routes.test.ts`
- 따라오는 곳: `apps/server/src/modules/conversations/agent-settings.ts`, `apps/server/scripts/dev-fake.ts`(가짜 러너 목록의 default 줄에 값)

- [ ] 시험: `value: "default"` 줄에 `resolvedModel: "claude-opus-5-5"` 이 있으면, 같은 목록에서 그 값(또는 `resolvedModel` 이 같은 줄)의 `displayName` 을 `resolvedLabel` 로 싣는다. 찾지 못하면 `resolvedModel` 글자 그대로, 그것도 없으면 키 없음. 다른 줄에는 싣지 않는다. 80자 자름.
- [ ] 시험: `resolvedLabel` 없는 옛 목록도 파싱된다.
- [ ] 구현 → 통과 → 커밋.

### Task B2: 칩 「기본 · …」 표시와 패널 grid

**Files:**
- Modify: `apps/web/src/features/composer/AgentSettingChips.tsx`(`modelChoices`, `modelLabelOf`, 노력·권한 「기본」 라벨), `apps/web/src/features/composer/AgentPills.tsx`(`PanelBody`·시트의 줄 묶음)
- 줄을 그리는 곳: `apps/web/src/features/composer/AgentSettingsBar.tsx`(`renderLine` 넘기는 자리)
- Test: `apps/web/src/features/composer/AgentSettingsBar.test.tsx`

- [ ] 시험: default 줄에 `resolvedLabel: "Opus 5.5"` 면 모델 칩 글자가 `기본 · Opus 5.5`, 없으면 `기본`. 노력 「기본」은 `기본 · 모델 기본`. 권한 「기본」은 `기본 · <resolvePermissionMode(null, 상한)>`(웹 쪽 같은 계산 — `runner-adapter` 를 웹이 import 하지 않으면 shared 로 옮긴다). 드롭다운 안의 「기본」 줄도 같은 글자.
- [ ] 시험: 패널(팝오버) 안의 줄들이 하나의 grid 컨테이너의 자식이다 — 줄마다 핸들·모델·노력·권한·컨텍스트 칸이 같은 열(`grid-template-columns` 를 가진 한 부모, 줄은 `contents` 또는 `subgrid`). 시트(좁은 화면)도 같은 꼴, 줄 높이 44px 이상 유지.
- [ ] 구현 → `pnpm -F @dodok/web test` → 화면 확인(`pnpm -F @dodok/server dev:fake` + `pnpm -F @dodok/web dev`, 러너 에이전트 둘 이상인 채널, 넓은 화면·좁은 화면 스크린숏) → 커밋.

---

## C. 릴레이 정책 격자

### Task C1: `PairList` → 격자

**Files:**
- Modify: `apps/web/src/features/settings/RelayPolicySection.tsx`(`PairList` 를 `PairGrid` 로 교체, `togglePair` 옆에 `setPairs(from: string | null, to: string | null, on: boolean)`)
- 그대로: `apps/web/src/features/settings/relayPolicyForm.ts`(형식·검증 안 바꾼다)
- Test: `apps/web/src/features/settings/settings.test.tsx`(릴레이 절), `apps/web/src/features/settings/relayPolicyForm.test.ts`(바뀔 것 없으면 그대로)

- [ ] 시험: 에이전트 3개면 `<table>`(접근 이름 「허용 쌍」) 3×3, 대각선 칸은 체크박스 없음(「—」). 칸 체크박스 접근 이름은 지금처럼 `@a → @b`. 체크하면 저장 본문의 `allowPairs` 에 `{from:a, to:b}`.
- [ ] 시험: 행 머리 단추(접근 이름 `@a 가 보내는 쌍 모두`)를 누르면 a 행의 (자기 제외) 칸이 모두 켜지고, 이미 모두 켜져 있으면 모두 꺼진다. 열 머리(`@b 가 받는 쌍 모두`)도 같다.
- [ ] 시험: 에이전트 1개면 지금 안내 문구 그대로. 기존 `allowPairs` 에 채널에 없는 에이전트 쌍이 있으면 격자에는 안 보이고, 다른 칸을 바꿔 저장해도 그 쌍이 본문에 남는다.
- [ ] 구현: 표는 `overflow-x-auto` 감싸개 안, 첫 열 `sticky left-0`. 잠금(admin 미만)이면 칸·머리 단추 모두 disabled.
- [ ] `pnpm -F @dodok/web test` → 화면 확인(dev:fake, 에이전트 넷 채널) → 커밋.

---

## D. 채널 통합 초대

### Task D1: 초대 대화상자와 멤버 목록

**Files:**
- Create: `apps/web/src/features/settings/InviteMembersDialog.tsx`
- Modify: `apps/web/src/features/settings/MembersSection.tsx`(`AddAgentForm` 을 「초대」 단추 + 대화상자로, 사람 멤버 목록 추가), `apps/web/src/features/settings/mutations.ts`(`useAddMember(channelId)` 가 `{ memberType: "user" | "agent"; memberId: string }` 를 받게, `useRemoveMember` 가 사람도 — 그 호출자 `apps/web/src/features/settings/AgentMemberRow.tsx`)
- 서버 확인(고칠 것이 있으면): `apps/server/src/modules/channels/routes.ts`(POST·DELETE `/channels/:id/members`), `apps/server/src/auth/policies.ts`(`authorizeChannelMemberAdd`·`authorizeChannelMemberRemove`), `apps/server/test/roles.matrix.test.ts`
- Test: `apps/web/src/features/settings/members.test.tsx`, `apps/web/src/features/settings/mutations.test.tsx`, `apps/web/src/features/settings/memberRow.test.tsx`
- Docs: `docs/manual/user-guide.md`(「채널 만들기」·「채널 참여」 절, 권한 표 밑의 「API 에만 있고 화면에는 없다」 문장)

**Interfaces:**
- Produces: `useAddMember(channelId).mutateAsync({ memberType, memberId }): Promise<ChannelMember>`.

- [ ] 시험: 「초대」 단추 → 대화상자(제목 「채널에 초대」). 검색칸 하나로 사람(`usePeople`)과 에이전트(`useAgents`)를 핸들·이름으로 거른다. 줄마다 종류 표시(「사람」/「에이전트」, 에이전트는 `gatewaySuffix`·「꺼짐」). 이미 멤버·보관 에이전트·비활성 사람·나 자신(이미 참여 중이면)은 목록에 없다.
- [ ] 시험: 둘 이상 골라 「초대」 → 고른 수만큼 POST(차례로), 성공한 것은 목록에서 빠지고 멤버 칸에 보인다. 하나가 409(`AGENT_ARCHIVED` 등)면 그 줄에 `formError` 문구가 남고 대화상자는 닫히지 않는다. 전부 성공하면 닫히고 초점은 「초대」 단추로.
- [ ] 시험: 멤버 칸에 「사람」·「에이전트」 두 묶음. 사람 행은 아바타·이름·@핸들과 (권한이 있을 때만) 「빼기」. 에이전트 행은 지금 `AgentMemberRow` 그대로.
- [ ] 서버 정책이 화면의 권한 표시와 맞는지 `roles.matrix.test.ts` 로 확인하고 다르면 보고(정책은 바꾸지 않는다).
- [ ] 구현 → `pnpm -F @dodok/web test` → 화면 확인(dev:fake, owner·mia 계정) → user-guide 갱신 → 커밋.
