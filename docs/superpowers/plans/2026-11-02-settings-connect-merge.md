# 「연결」 탭 통합과 연결의 주인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 Orca 워커가 단계(1단계·2단계)를 따로 맡는다 — AGENTS.md 「작업 방식」.

**Goal:** 설정의 「에이전트」·「러너」·「연결」 탭을 연결 중심의 「연결」 탭 하나(목록 + 상세)로 합치고 화면 문구를 한 줄로 걷은 뒤(1단계), 연결마다 주인을 두어 member 가 자기 Gateway·러너를 붙이고 관리하게 한다(2단계).

**Architecture:** 웹은 `features/connections/` 새 기능 폴더에 트리 모델(순수 함수) → 레이아웃(트리 | 상세 `Outlet`) → 상세 화면 넷(Gateway·러너·프로젝트·에이전트)과 연결 추가를 둔다. 상세 화면은 지금 `features/setup`·`features/runners`·`features/agents` 의 부품(`GatewayCard` 의 섹션들, `RunnerCard`·`ProjectList`·`AddProjectDialog`, `AgentRow`, `DiscoverDialog`, `RunnerAgentForm`)을 그대로 끌어다 쓰고, 옛 페이지 셋은 지운다. 2단계는 서버 정책 함수(`auth/policies.ts`)에 「이 연결의 주인인가」를 더하고 owner 전용 라우트를 정책으로 바꾸며, Gateway 승인 상태를 어댑터에 넘기는 유일한 자리(`gatewayConfig`)에서 막는다.

**Tech Stack:** React + TanStack Router/Query(apps/web), Fastify + drizzle(sqlite)(apps/server), Zod(packages/shared), vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-settings-connect-merge-design.md`

## Global Constraints

- 탭 이름 「연결」, 주소 `/settings/connection`. 탭 순서: 내 계정 · 알림 · 연결 · 채널 · 자동화 · 멤버 · 운영. 「연결」은 누구나 본다.
- 옛 주소 `/settings/agents`·`/settings/runners`·`/agents` → `/settings/connection` 으로 `redirect({ replace: true })`.
- 상세 주소: `/settings/connection/gateway/$gatewayId` · `/runner/$runnerId` · `/project/$projectId` · `/agent/$agentId` · `/new`.
- 화면 문구는 한 줄. 넘치는 사정은 「?」 펼침(`HelpDetails` — 접근성 이름 「<섹션> 도움말」) 또는 사용 설명서 링크. 위험 경고(러너 경고 한 줄, 다른 빌드, 쓸 수 있는 토큰 없음, 5분 넘은 페어링, 상한 초과)는 늘 보인다. 화면 문구에 스펙 이름·판정 번호를 쓰지 않는다.
- 러너 경고 한 줄(글자 그대로): 「이 러너의 에이전트는 채널 멤버 누구나 부를 수 있고, 루트 안 파일을 읽습니다. 루트는 좁게, 상한은 낮게.」
- 브리지 토큰 한 줄(글자 그대로): 「플러그인이 이 서버에 붙을 때 쓰는 토큰.」
- 주소·토큰·설치 명령이 든 섹션은 그 연결의 주인과 admin 이상에게만 그린다(1단계는 지금 권한 — Gateway·러너 토큰 섹션은 owner).
- 플러그인 설치 상자의 **내용**은 바꾸지 않는다(`plugin-install-cmd` 작업 몫) — `PluginDownload` 를 자리만 옮긴다.
- 러너 설치 2단계(로그인)의 명령·문구는 바꾸지 않는다(`runner-default-claude-login` 작업 몫).
- 채널 멤버십 규칙, `dmAccess`, 러너 로컬 천장은 바꾸지 않는다.
- 커밋: 경로를 명시해 stage(`git add -A` 금지), Conventional Commits + 패키지 스코프(`feat(web): …`, `feat(server): …`, `docs: …`), 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- 검사: `pnpm -F @dodok/web test`·`pnpm -F @dodok/server test`(다른 검사와 동시에 돌리지 않는다)·`pnpm typecheck`·`pnpm lint`·`pnpm fmt`. 통과 보고에는 실행된 시험 수를 적는다.

## Review Focus

1. **역할마다 다른 트리** — member·admin·owner 가 같은 주소를 열었을 때 그 역할에 없는 API(`GET /setup/status` owner, `GET /runners` admin)를 부르지 않고(부르면 전역 토스트 「권한이 없습니다」) 빈 칸 없이 그린다. Task 1·2 시험이 역할 셋을 다 본다.
2. **없는 id·지워진 연결의 상세 주소** — `/settings/connection/gateway/<지운 id>` 를 열거나, 상세를 연 채 다른 탭에서 그 Gateway 를 지우면 빈 화면·예외가 아니라 「이 연결을 찾을 수 없습니다」와 「← 연결」. Task 3·4·5 시험.
3. **폰 폭(390px)** — 트리와 상세가 한 칸씩, 상세 머리에 「← 연결」. 설정 셸의 「← 설정」과 겹쳐 뒤로 가기 단추가 둘이 되지 않는다. Task 2 시험(`useIsNarrow` 를 참으로).
4. **승인 우회** — member 가 승인된 Gateway 의 `url` 을 바꾸면 승인이 풀리고 어댑터가 끊는다. 같은 PATCH 에 `enabled: true` 를 실어도 접속하지 않는다. Task 10 시험.
5. **남의 연결의 비밀** — member 가 남의 Gateway·러너 id 로 `GET /setup/status`·`GET /gateways/:id/bridge-tokens`·`GET /setup/runner-tokens` 를 불러도 그 연결의 주소·토큰 줄이 응답에 없다(403 또는 걸러짐). Task 11·12 시험.

---

# 1단계 — 화면 통합(서버 권한 그대로)

### Task 1: 연결 트리 모델

**Files:**
- Create: `apps/web/src/features/connections/tree.ts`
- Test: `apps/web/src/features/connections/tree.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TreeAgent = { kind: "agent"; agent: Agent };
  export type TreeProject = { kind: "project"; id: string; label: string; runnerId: string; agents: TreeAgent[] };
  export type TreeGateway = { kind: "gateway"; id: string; name: string; state: GatewayStateLabel; ownerUserId: string | null; approved: boolean; agents: TreeAgent[] };
  export type TreeRunner = { kind: "runner"; id: string; label: string; state: "연결됨" | "끊김" | "폐기됨" | null; ownerUserId: string | null; projects: TreeProject[]; agents: TreeAgent[] };
  export type TreeConnection = TreeGateway | TreeRunner;
  export type ConnectionTree = { mine: TreeConnection[]; others: TreeConnection[]; orphaned: TreeAgent[]; archived: Agent[] };
  export type TreeInput = {
    agents: Agent[];
    gateways: { id: string; name: string; state: GatewayStateLabel; ownerUserId?: string | null; approved?: boolean }[];
    runners: { id: string; label: string; state: TreeRunner["state"]; ownerUserId?: string | null }[] | null; // null = 이 역할은 러너 목록을 모른다
    projects: RunnerProject[] | null; // null = 이 역할은 프로젝트를 모른다
    meId: string | null; // null = 1단계(주인 가름 없음) — 모든 연결을 `others` 에 넣는다
  };
  export function buildConnectionTree(input: TreeInput): ConnectionTree;
  export type GatewayStateLabel = ReturnType<typeof gatewayStateLabel> | "승인 대기";
  ```
  1단계에서는 `meId: null` 이고 모든 연결이 `others` 에 든다 — 화면(Task 2)은 `mine` 이 비면 묶음 제목 없이 「연결」 한 묶음으로 그린다.

- [ ] **Step 1: Write the failing tests** — `tree.test.ts`:
  - `groups OpenClaw agents under their gateway` — gateways `[{id:"g1",name:"사무실"}]`, agents dev·fin(gateway g1) → `others[0].agents` 핸들 `["dev","fin"]`.
  - `shows gateways with no agents` — 에이전트 없는 g2 도 `others` 에 있다.
  - `nests runner agents under project when projects are known` — runners `[r1]`, projects `[p1(runnerId r1)]`, agent coder(`runner.tokenId r1`, `runnerAgent.projectId p1`) → `others[r1].projects[0].agents` 에 coder, `others[r1].agents` 비어 있음.
  - `hangs runner agents directly under runner when projects are unknown` — projects `null`, runnerAgent 없음(member) → `others[r1].agents` 에 coder.
  - `derives runners from agents when the runner list is unknown` — runners `null`, agent 의 `runner {tokenId:"r1", label:"mia 의 맥북", revoked:false}` → runner 노드 `{id:"r1", label:"mia 의 맥북", state:null}`. revoked 면 `state: "폐기됨"`.
  - `puts agents without a connection in orphaned` — `gateway: null` 인 OpenClaw, `runner` 없는 러너, `runner.revoked` 인 러너 에이전트 → `orphaned`.
  - `puts archived agents in archived only` — `archivedAt` 있는 에이전트는 어느 노드에도 없고 `archived` 에만.
  - `splits mine and others by ownerUserId when meId is set` — meId `"u1"`, g1 owner u1, g2 owner u2 → `mine` g1, `others` g2.
- [ ] **Step 2: Run** `pnpm -F @dodok/web exec vitest run src/features/connections/tree.test.ts` — Expected: FAIL(모듈 없음).
- [ ] **Step 3: Implement `buildConnectionTree`** — 순서는 입력 차례(Gateway 는 더한 차례, 러너는 `runners` 차례, 모르면 에이전트에서 처음 본 차례). `gatewayStateLabel` 은 `features/setup/GatewayCard.tsx` 의 것을 그대로 쓴다.
- [ ] **Step 4: Run** 같은 명령 — Expected: PASS(8).
- [ ] **Step 5: Commit** `git add apps/web/src/features/connections/tree.ts apps/web/src/features/connections/tree.test.ts` · `feat(web): connection tree model for the merged Connection tab`

### Task 2: 「연결」 레이아웃·트리·탭·주소

**Files:**
- Create: `apps/web/src/features/connections/ConnectionsLayout.tsx`, `apps/web/src/features/connections/ConnectionTreeList.tsx`, `apps/web/src/features/connections/useConnectionTree.ts`, `apps/web/src/features/connections/DetailHeader.tsx`, `apps/web/src/features/connections/NotFoundDetail.tsx`
- Modify: `apps/web/src/features/settings-shell/tabs.ts`, `apps/web/src/app/router.tsx`(설정 라우트 묶음·`legacyAgentsRoute`·`routeTree`)
- Test: `apps/web/src/features/connections/connectionsLayout.test.tsx`, `apps/web/src/app/router.test.tsx`, `apps/web/src/features/settings-shell/settingsShell.test.tsx`

**Interfaces:**
- Consumes: `buildConnectionTree` (Task 1), `useAgents`·`useAdapterStatus`·`useRole`·`useCachedMe` (`apps/web/src/api/queries.ts`), `useRunners`·`useRunnerProjects` (`features/runners/queries.ts`), `useSetupStatus` (`features/setup/queries.ts`).
- Produces:
  - `useConnectionTree(): { tree: ConnectionTree | undefined; pending: boolean; error: boolean; refetch(): void }` — 역할로 쿼리를 가른다: member 는 agents + adapter, admin 은 + runners·projects(러너마다 `useRunnerProjects` 대신 Task 5 의 `useAllRunnerProjects`가 필요하면 이 파일에 `useQueries` 로), owner 는 + setup status(Gateway 상태 정본). 역할에 없는 쿼리는 `enabled: false`.
  - 라우트 상수 `connectionRoute`(레이아웃, `path: "connection"`)와 자식 `connectionIndexRoute`(`/`)·`connectionGatewayRoute`(`gateway/$gatewayId`)·`connectionRunnerRoute`(`runner/$runnerId`)·`connectionProjectRoute`(`project/$projectId`)·`connectionAgentRoute`(`agent/$agentId`)·`connectionNewRoute`(`new`) — 자식 컴포넌트는 Task 3~6 이 채운다. 이 태스크에서는 자식마다 `NotFoundDetail` 을 임시로 단다.
  - `DetailHeader({ title, badge?, actions?, meta? })` — 좁은 화면이면 「← 연결」(`/settings/connection` 링크)을 머리에 단다. 상세 화면 넷이 모두 쓴다.
  - `NotFoundDetail()` — 「이 연결을 찾을 수 없습니다」 + 「← 연결」.

- [ ] **Step 1: Write the failing tests**
  - `connectionsLayout.test.tsx`: `member sees gateways and runner agents without calling admin APIs` — 역할 member, 가짜 서버(`apps/web/test/setupServer.tsx`·`runnersServer.tsx` 를 늘려 쓴다)가 `/runners`·`/setup/status` 호출을 세고 0 을 단언, 트리에 「사무실」「Dev」「mia 의 맥북」「Coder」. `admin sees projects under runners` — 「dodok」 아래 「Coder」. `owner sees gateway state from setup status`. `narrow screen shows tree first then detail with back link` — `useIsNarrow` 참, 줄 클릭 → 트리가 사라지고 「← 연결」. `archived group is collapsed and shows count` — 「삭제된 에이전트 1」. `orphaned group only when present`.
  - `router.test.tsx`: `/settings/agents`·`/settings/runners`·`/agents` → 위치가 `/settings/connection`, 기록 길이 그대로(replace).
  - `settingsShell.test.tsx`: 탭 목록 — member `["내 계정","알림","연결","채널"]`, admin `[…,"자동화","멤버","운영"]`, owner 같음. 옛 「에이전트」「러너」 탭 단언은 지운다.
- [ ] **Step 2: Run** `pnpm -F @dodok/web exec vitest run src/features/connections src/app/router.test.tsx src/features/settings-shell/settingsShell.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** — `tabs.ts` 에서 에이전트·러너 줄을 빼고 연결 줄을 알림 다음으로 옮겨 `visible: () => true`, 아이콘 `CableIcon`. 라우터: 옛 `agentsRoute`·`runnersRoute` 를 redirect 라우트로 바꾸고(`beforeLoad` 에서 `throw redirect({ to: "/settings/connection", replace: true })`), `legacyAgentsRoute` 대상도 같게. `ConnectionsLayout` — 넓은 화면은 트리 칸(`w-72 shrink-0 border-r overflow-y-auto`, 내 판단 — 빌더가 바꿔도 된다) | `<Outlet/>`, 좁은 화면은 index 에서만 트리, 자식에서는 `Outlet` 만. 머리: h1 「연결」, 한 줄 「에이전트가 어디에 붙어 있는지 보고 관리합니다.」, 「＋ 연결 추가」(1단계 owner 만, `/settings/connection/new` 링크). 트리 줄은 `<Link>` 이고 지금 주소의 줄에 `aria-current="page"`. 넓은 화면 index 의 오른쪽은 「왼쪽에서 연결이나 에이전트를 고르세요.」 한 줄.
- [ ] **Step 4: Run** 같은 명령 — Expected: PASS. 이어 `pnpm -F @dodok/web test` 로 옛 탭을 단언하던 시험이 어디서 깨지는지 본다 — 이 태스크에서는 `settingsShell`·`router` 만 고치고, 나머지는 그 화면을 옮기는 태스크(3~5)가 고친다(깨진 목록을 커밋 메시지 본문에 적는다).
- [ ] **Step 5: Commit** 위 Files 의 경로를 명시해 stage · `feat(web): Connection tab layout with connection tree and legacy redirects`

### Task 3: 에이전트 상세

**Files:**
- Create: `apps/web/src/features/connections/AgentDetail.tsx`
- Modify: `apps/web/src/features/agents/AgentRow.tsx`(목록 줄 꼴 `li` → 상세 본문으로 쓸 수 있게 `as` 또는 래퍼 분리, `RunnerLine` 문구의 「「러너」 탭에서」 → 「그 러너 화면에서」 + 러너 상세 링크), `apps/web/src/features/agents/MoveGatewayDialog.tsx`(연결 페이지 언급 문구), `apps/web/src/app/router.tsx`(`connectionAgentRoute` 컴포넌트)
- Delete: `apps/web/src/features/agents/AgentsPage.tsx`(Task 7 에서 — 여기서는 남겨 두고 라우트에서만 뗀다)
- Test: `apps/web/src/features/agents/agentsList.test.tsx`, `agentsDm.test.tsx`, `agentsArchive.test.tsx`, `agentsGateway.test.tsx`, `agentsProvider.test.tsx`, `agentsRunner.test.tsx`, `apps/web/test/agentsPage.tsx`(하네스)

**Interfaces:**
- Consumes: `DetailHeader`·`NotFoundDetail`(Task 2), `useAgents`.
- Produces: `AgentDetail()` — `connectionAgentRoute` 의 컴포넌트. 메타 줄 「<연결 이름> › <프로젝트 이름> · <프로그램>」 또는 「<Gateway 이름> · OpenClaw」, 연결 이름은 그 연결 상세 링크.

- [ ] **Step 1: 하네스를 옮긴다** — `apps/web/test/agentsPage.tsx` 가 `AgentsPage` 대신 `/settings/connection/agent/<id>` 를 그리도록 바꾸고(에이전트 id 인자를 받는다), 목록 단언(`agentsList`)은 트리(`ConnectionTreeList`) 단언으로 옮긴다. 원칙: **지금 있는 단언마다 새 자리에서 같은 뜻의 단언을 남긴다.** 지우는 것은 걷은 문구(에이전트 탭 머리 문단)를 단언하던 줄뿐이다.
- [ ] **Step 2: Run** `pnpm -F @dodok/web exec vitest run src/features/agents` — Expected: FAIL(상세 없음).
- [ ] **Step 3: Implement `AgentDetail`** — `AgentRow` 본문을 그대로 쓰고 머리만 `DetailHeader` 로. 없는 id 는 `NotFoundDetail`. 보관한 에이전트 id 면 상세에 「삭제된 에이전트」 배지와 지금 `ArchivedAgents` 의 「되살리기」.
- [ ] **Step 4: Run** 같은 명령 — Expected: PASS. 보관·되살리기 뒤 초점 시험(지금 `AgentsPage` 의 `groupRef`·`restoredRef`)은 「보관하면 트리의 「삭제된 에이전트 N」 단추로, 되살리면 그 에이전트 상세 머리(h1)로」로 바꿔 단언한다.
- [ ] **Step 5: Commit** · `feat(web): agent detail under the Connection tab`

### Task 4: Gateway 상세와 「?」 도움말

**Files:**
- Create: `apps/web/src/features/connections/GatewayDetail.tsx`, `apps/web/src/features/connections/HelpDetails.tsx`
- Modify: `apps/web/src/features/setup/GatewayCard.tsx`(섹션 `GatewayStatus`·`PluginStatus`·`BridgeTokens` 를 export, 브리지 토큰 문구를 Global Constraints 의 한 줄 + `HelpDetails`), `apps/web/src/features/setup/sections.tsx`(`PluginDownload` 에 `defaultOpen` 을 받아 접힘 `details` 로 감싸는 래퍼 — **상자 안 내용은 손대지 않는다**), `apps/web/src/features/agents/DiscoverDialog.tsx`(`gatewayId?: string` 을 받아 그 Gateway 로 고정, 「연결 페이지에서」 문구 → 「＋ 연결 추가로」), `apps/web/src/app/router.tsx`
- Test: `apps/web/src/features/setup/gateways.test.tsx`, `apps/web/src/features/setup/connection.test.tsx`, `apps/web/src/features/setup/issueToken.test.tsx`, `apps/web/src/features/agents/agentsRegister.test.tsx`, `apps/web/src/features/connections/gatewayDetail.test.tsx`

**Interfaces:**
- Consumes: `DetailHeader`·`NotFoundDetail`, `useSetupStatus`(owner), `useAdapterStatus`.
- Produces:
  - `HelpDetails({ label, children })` — `<details aria-label={`${label} 도움말`}>` + 「?」 summary. Task 5·6·7 이 쓴다.
  - `GatewayDetail()` — owner: 머리(이름·`gatewayStateLabel` 배지·수정/끄기/삭제 — `GatewayCard` 머리 그대로) · 메타 「OpenClaw Gateway · <주소> · <버전>」 · 「플러그인」(페어링 승인 블록 → 상태 한 줄 → `PluginDownload` — 플러그인이 안 붙었으면 펼침, 붙었으면 「다시 설치」 접힘) · 「브리지 토큰」 · 「에이전트 N」(+ admin 이상 「에이전트 가져오기」 = `DiscoverDialog gatewayId`). owner 아님: 머리(이름·wire 상태) · 「에이전트 N」만.
  - 삭제하면 `/settings/connection` 으로 가고 지금의 라이브 영역 문구 「「<이름>」 Gateway 를 삭제했습니다」를 트리 머리 라이브 영역에 쓴다.

- [ ] **Step 1: Write the failing tests** — `gatewayDetail.test.tsx`: `owner sees plugin, bridge tokens and agents`, `plugin box is open when no plugin is connected and collapsed otherwise`(`details` 의 `open`), `bridge token copy is one line with help`(정확 문구 + 「브리지 토큰 도움말」), `admin sees only header and agents with discover`, `unknown gateway id shows not found`, `deleting navigates to the list and announces`. 옛 `connection.test.tsx`·`gateways.test.tsx` 의 Gateway 카드 단언을 이 화면으로 옮긴다(`installCommands` 와 docker-deploy.md [B] 블록 대조 시험은 **그대로 둔다** — 1번 작업 몫). 「서버」 섹션(버전) 단언은 지운다.
- [ ] **Step 2: Run** `pnpm -F @dodok/web exec vitest run src/features/connections src/features/setup src/features/agents/agentsRegister.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** 위 Produces 대로.
- [ ] **Step 4: Run** 같은 명령 — Expected: PASS.
- [ ] **Step 5: Commit** · `feat(web): gateway detail with plugin, bridge tokens and agents`

### Task 5: 러너 상세·프로젝트 상세

**Files:**
- Create: `apps/web/src/features/connections/RunnerDetail.tsx`, `apps/web/src/features/connections/ProjectDetail.tsx`
- Modify: `apps/web/src/features/runners/RunnersPage.tsx`(`RunnerDetail`·`ProgramLine` 을 export — 페이지는 Task 7 에서 지운다), `apps/web/src/features/runners/ProjectList.tsx`(줄 버튼 묶음을 프로젝트 상세에서 쓸 수 있게 `ProjectActions` 로 분리), `apps/web/src/features/setup/RunnerSection.tsx`(`InstallSteps` 를 export, 「드러나는 것」 네 줄을 `RunnerExposure` 로 분리·export, 설치 3단계 긴 문단 → 「roots 는 좁게, label 은 꼭.」 + `HelpDetails`, `SameBuildInstall` 설명 문단 → 한 줄, 「위에서 러너 토큰을 발급해」 → 「러너 토큰을 <파일>에 저장하고」), `apps/web/src/features/setup/RunnerTokenList.tsx`(토큰 하나만 그리는 `RunnerTokenRow` 로 쓸 수 있게), `apps/web/src/features/agents/RunnerAgentForm.tsx`(`projectId?: string` 고정, 「러너 탭에서」·「연결 페이지에서」 링크 → 러너 상세·「＋ 연결 추가」), `apps/web/src/features/runners/copy.ts`, `apps/web/src/app/router.tsx`
- Test: `apps/web/src/features/runners/runners.test.tsx`, `apps/web/src/features/runners/addProject.test.tsx`, `apps/web/src/features/setup/runner.test.tsx`, `apps/web/src/features/setup/llmsHandoff.test.tsx`, `apps/web/src/features/agents/agentsRunner.test.tsx`, `apps/web/src/features/connections/runnerDetail.test.tsx`

**Interfaces:**
- Consumes: `HelpDetails`(Task 4), `DetailHeader`·`NotFoundDetail`, `useRunners`·`useRunnerProjects`, `useRunnerTokens`·`useSetupStatus`(owner).
- Produces:
  - `RunnerDetail()` — 러너 id 는 러너 토큰 id 와 같다(`RunnerSummary.id` = `runner_tokens.id`). 머리(라벨·연결됨/끊김/폐기됨 · owner 에게 「토큰 다시 발급」「폐기」 — `RunnerTokenList` 의 대화상자 그대로) · 메타 「러너 · dodok-runner <판본>」·`ProgramLine`·루트 · 경고 한 줄(Global Constraints 글자 그대로) + `HelpDetails`(안에 `RunnerExposure`) · 「프로젝트 N」 + `AddProjectDialog`(admin 이상) · 「설치 안내」(owner — 러너가 붙어 있거나 토큰 `lastUsedAt` 이 있으면 접힘, 아니면 펼침) · 그 러너 토큰 한 줄. member: 머리(라벨, 상태 모름이면 배지 없음) · 경고 한 줄 · 그 러너의 에이전트.
  - `ProjectDetail()`(admin 이상 — 아니면 「권한이 없습니다」 한 줄) — 머리(이름·「<루트 라벨>/<상대 경로>」) · `ProjectActions`(확인·이름 바꾸기·옮기기·보관) · 「에이전트 N」 + 「＋ 에이전트」(`RunnerAgentForm projectId`). 보관·옮기기 뒤에는 그 러너 상세로 간다.

- [ ] **Step 1: Write the failing tests** — `runnerDetail.test.tsx`: `owner sees warning line, projects, install steps and its token`, `install steps are collapsed once the runner has connected`, `warning help contains the four exposure lines`, `member sees only header, warning and agents and no runner API call`, `project detail is admin only`, `archiving a project returns to the runner detail`, `unknown runner id shows not found`. 옛 `runners.test.tsx`·`runner.test.tsx`·`addProject.test.tsx`·`llmsHandoff.test.tsx` 의 단언을 새 자리로 옮긴다(Task 3 원칙).
- [ ] **Step 2: Run** `pnpm -F @dodok/web exec vitest run src/features/connections src/features/runners src/features/setup/runner.test.tsx src/features/setup/llmsHandoff.test.tsx src/features/agents/agentsRunner.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** 위 Produces 대로.
- [ ] **Step 4: Run** 같은 명령 — Expected: PASS.
- [ ] **Step 5: Commit** · `feat(web): runner and project detail under the Connection tab`

### Task 6: 연결 추가

**Files:**
- Create: `apps/web/src/features/connections/NewConnection.tsx`
- Modify: `apps/web/src/features/setup/GatewayForm.tsx`(트리거 없이 본문만 쓰는 꼴 `GatewayFormBody({ onSaved(row) })` 를 export), `apps/web/src/features/setup/IssueRunnerTokenDialog.tsx`(본문 `IssueRunnerTokenBody({ onDone(tokenId) })` 를 export), `apps/web/src/app/router.tsx`
- Test: `apps/web/src/features/connections/newConnection.test.tsx`

**Interfaces:**
- Consumes: `RunnerExposure`(Task 5), `DetailHeader`.
- Produces: `NewConnection()` — 1단계 owner 만(아니면 「권한이 없습니다」). 라디오 「OpenClaw Gateway」·「러너」. Gateway: `GatewayFormBody` → 저장하면 `/settings/connection/gateway/<id>`. 러너: `IssueRunnerTokenBody`(이름 → 원문 한 번·「AI 에게 맡기기」) 아래 `RunnerExposure` 네 줄을 펼친 채 → 「다 했습니다」 → `/settings/connection/runner/<id>`.

- [ ] **Step 1: Write the failing tests** — `creating a gateway opens its detail with the plugin box open`, `issuing a runner token shows the token once, the four exposure lines, then opens the runner detail`, `non-owner sees no access in stage 1`.
- [ ] **Step 2: Run** `pnpm -F @dodok/web exec vitest run src/features/connections/newConnection.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS. 옛 `issueToken.test.tsx` 의 러너 토큰 대화상자 단언이 깨지면 같은 뜻으로 옮긴다.
- [ ] **Step 5: Commit** · `feat(web): add-connection flow for gateways and runners`

### Task 7: 옛 페이지 걷기·링크·사람용 문구

**Files:**
- Delete: `apps/web/src/features/setup/ConnectionPage.tsx`, `apps/web/src/features/runners/RunnersPage.tsx`(Task 5 에서 export 한 부품은 `apps/web/src/features/runners/RunnerParts.tsx` 로 옮긴다), `apps/web/src/features/agents/AgentsPage.tsx`, `apps/web/src/features/setup/access.test.tsx`(연결 페이지 owner 가름 — 새 자리 단언은 Task 4~6 에 있다)
- Modify: `apps/web/src/app/layout/Banners.tsx`(「연결 설정 보기」 → 끊긴 Gateway 가 하나면 그 상세, 여럿이면 `/settings/connection`), `apps/web/src/features/setup/sections.tsx`(`ServerSection` 삭제), `apps/web/src/features/ops/OpsPage.tsx`·`StatusCard.tsx`·`members/MembersPage.tsx`·`automations/AutomationsPage.tsx`·`account/McpTokensSection.tsx`·`settings/MembersSection.tsx`·`realtime/handlers.ts`·`api/queries.ts`(「연결 페이지」·「러너 탭」을 사람에게 보이는 문구에서 「설정 → 연결」로 — 주석은 그대로 둬도 된다)
- Modify(서버·공유 사람용 문구 — 동작 그대로): `apps/server/src/modules/setup/llms.ts`, `apps/server/src/modules/runs/orchestrator.ts`, `apps/server/src/modules/ops/health.ts`, `apps/server/src/modules/control/handlers.ts`, `apps/server/src/modules/runners/routes.ts`, `apps/server/src/modules/runners/projects.routes.ts`, `apps/server/src/modules/runners/tokens.ts`, `apps/server/src/modules/runners/runner-file.ts`, `apps/server/src/modules/gateways/service.ts`, `apps/server/src/realtime/events.ts`, `apps/server/src/config.ts`, `packages/shared/src/setup/index.ts`, `packages/shared/src/domain/index.ts`, `packages/shared/src/control/runner-bodies.ts`, `packages/openclaw-adapter/src/connection/gateway-connection.ts`
- Test: `apps/server/test/setup.llms.test.ts`, `apps/server/test/orchestrator.runner.test.ts`, `apps/server/test/unbound-agent.test.ts`, `apps/web/src/app/App.test.tsx`(배너 링크)

- [ ] **Step 1: 찾기** — `grep -rnE '연결 페이지|러너 탭|「러너」 탭|「연결」 탭|settings/(runners|agents)' apps packages --include='*.ts' --include='*.tsx'` 를 돌려, 줄마다 사람에게 보이는 문자열인지(따옴표 안·JSX 텍스트·llms 본문) 주석인지 가른다. 사람용만 이 태스크에서 고친다. 결과 수를 두 번 센다(AGENTS.md 「수를 셀 때는 두 번」).
- [ ] **Step 2: 시험부터 고친다** — 그 문구를 글자 그대로 단언하는 시험(`grep -rn` 같은 문구로 `apps/*/test` 와 `*.test.ts*`)을 새 문구로 바꾼다. Run `pnpm -F @dodok/server test` · `pnpm -F @dodok/web test` — Expected: 고친 시험만 FAIL.
- [ ] **Step 3: 문구와 링크를 고치고 옛 페이지를 지운다.**
- [ ] **Step 4: Run** `pnpm typecheck && pnpm lint` 뒤 `pnpm -F @dodok/server test`, `pnpm -F @dodok/web test`(따로, 동시에 돌리지 않는다) — Expected: PASS, 실행 수를 적는다. `grep -rn "ConnectionPage\|RunnersPage\|AgentsPage" apps/web/src` 가 0줄.
- [ ] **Step 5: Commit** · `refactor(web): remove the old agents, runners and connection pages` 와 `fix(server): point user-facing copy at Settings → Connection`(서버·공유·어댑터 경로를 나눠 두 커밋)

### Task 8: 1단계 문서

**Files:**
- Modify: `docs/manual/user-guide.md`(「역할」 표, 「설정」 절 탭 표, 「에이전트 등록·삭제」·「러너 (admin 이상)」·「연결 페이지 (owner)」 → 「연결」 절 하나 — 목록·상세 넷·연결 추가·역할별로 보이는 것·옛 주소), `docs/guides/docker-deploy.md`, `docs/guides/live-smoke.md`, `docs/guides/runner-release.md`, `docs/guides/agent-guide.md`, `docs/guides/project-structure.md`(`features/connections`), `README.md`, `docs/guides/plan.md`(8장 완료·10장 결정 「연결 탭 통합(1단계)」), `.ruler/AGENTS.md`(dev:fake 설명의 「연결 페이지에서 「다시 발급」」 등)
- [ ] **Step 1:** `grep -rnE '연결 페이지|러너 탭|「러너」 탭|「에이전트」 탭|settings/(runners|agents|connection)' docs README.md .ruler/AGENTS.md` — 줄마다 고치고 다시 센다.
- [ ] **Step 2:** 사용 설명서의 화면 문구는 Task 2~6 에서 실제로 쓴 문자열을 그대로 옮긴다(따로 지어내지 않는다 — 웹 소스에서 복사).
- [ ] **Step 3:** `pnpm exec ruler apply` → `git status` 에 추적 파일 변경이 `.ruler/AGENTS.md` 뿐인지 본다. 문서의 `---` 앞 빈 줄과 표 줄을 눈으로 본다(oxfmt 는 md 를 안 본다).
- [ ] **Step 4: Commit** · `docs: describe the merged Connection tab`

---

# 2단계 — 연결의 주인

### Task 9: 주인·승인 칸과 마이그레이션

**Files:**
- Modify: `apps/server/src/db/schema.sqlite.ts`(`runnerTokens.ownerUserId`, `gateways.approvedAt`·`approvedBy`), `apps/server/src/modules/gateways/service.ts`(`createGateway`·`updateGateway`·`gatewayConfig`·`toGatewaySummary`), `apps/server/src/modules/runners/tokens.ts`(`issueRunnerToken`·`listRunnerTokens`), `packages/shared/src/gateways/index.ts`(`GatewaySummary.approved: boolean`), 러너 토큰 요약 타입(`packages/shared/src/setup/index.ts` 의 러너 토큰 줄에 `ownerUserId`)
- Create: `apps/server/drizzle/0033_connection_owner.sql`(`pnpm -F @dodok/server db:generate` 로 만들고 백필 SQL 을 덧붙인다)
- Test: `apps/server/test/gateways.test.ts`, `apps/server/test/runners.tokens.test.ts`, `apps/server/test/multi-gateway.integration.test.ts`

**Interfaces:**
- Produces:
  - `createGateway(db, workspaceId, body, actor: { userId: string; role: TeamRole }, now?)` — `ownerUserId = actor.userId`, `approvedAt = roleAtLeast(actor.role,"admin") ? now : null`, `approvedBy` 같은 규칙.
  - `updateGateway(db, workspaceId, id, patch, actor, now?)` — `url` 이 바뀌고 `actor.role` 이 admin 미만이면 `approvedAt = null, approvedBy = null`.
  - `approveGateway(db, workspaceId, id, actor, now?): GatewayRow` — 새 함수.
  - `gatewayConfig(row)` 의 `enabled` = `row.enabled && row.approvedAt !== null` — 어댑터에 넘기는 유일한 자리라 여기서만 막는다.
  - `issueRunnerToken(db, workspaceId, label, ownerUserId, now?)`.
  - 마이그레이션 백필: `UPDATE gateways SET owner_user_id = (SELECT user_id FROM memberships WHERE workspace_id = gateways.workspace_id AND role = 'owner' LIMIT 1), approved_at = created_at WHERE owner_user_id IS NULL;` 와 `runner_tokens` 의 같은 꼴(승인 칸 없음).
- [ ] **Step 1: Write the failing tests** — `gateways.test.ts`: `member-created gateway is not approved and is passed to the adapter disabled`, `admin-created gateway is approved`, `member changing url drops approval and disconnects`(가짜 어댑터의 `upsertGateway` 가 `enabled:false` 로 불림), `member changing only name keeps approval`, `approve enables the adapter connection`, `existing rows are backfilled with the workspace owner and approved`(마이그레이션을 적용한 새 DB 에 옛 행을 넣고 확인 — 지금 마이그레이션 시험의 꼴을 따른다). `runners.tokens.test.ts`: `issued runner token records its owner`.
- [ ] **Step 2: Run** `pnpm -F @dodok/server exec vitest run test/gateways.test.ts test/runners.tokens.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** + `db:generate`. 부르는 쪽(`modules/gateways/routes.ts`·`modules/runners/routes.ts`·dev:fake `addFakeGateway`)은 지금 요청자의 `sessionUser(request)` 와 역할을 넘긴다 — 라우트 권한은 아직 owner 그대로(Task 10 에서 바꾼다).
- [ ] **Step 4: Run** `pnpm -F @dodok/server test` — Expected: PASS, 실행 수 기록.
- [ ] **Step 5: Commit** · `feat(server): connection owner and gateway approval columns`

### Task 10: 정책 — 주인이 자기 연결을 관리한다

**Files:**
- Modify: `apps/server/src/auth/policies.ts`, `apps/server/src/auth/roles.ts`(`requirePolicy` 는 그대로 두고 자원을 보는 정책은 핸들러에서 부른다), `apps/server/src/modules/gateways/routes.ts`, `apps/server/src/modules/runners/routes.ts`, `apps/server/src/modules/runners/projects.routes.ts`, `apps/server/src/modules/agents/routes.ts`, `apps/server/src/modules/agents/service.ts`(`agentForRole` 꼴의 `runnerAgent` 가름 — 주인에게도), `apps/server/src/modules/control/handlers.ts`(`authorize` 에 `actor` 를 넘긴다)
- Create: `apps/server/src/modules/connections/owner.ts`
- Test: `apps/server/test/auth.policies.test.ts`, `apps/server/test/roles.matrix.test.ts`, `apps/server/test/gateways.test.ts`, `apps/server/test/runners.routes.test.ts`, `apps/server/test/runner-projects.routes.test.ts`, `apps/server/test/agents.gateway.test.ts`, `apps/server/test/agents.service.test.ts`, `apps/server/test/agents.archive.test.ts`, control 도구 시험(`grep -ln authorizeAgentRegister apps/server/test`)

**Interfaces:**
- Produces:
  - `type ConnectionActor = { role: TeamRole | undefined; ownsConnection: boolean }`.
  - `authorizeConnectionCreate(role)` — member 이상. `authorizeConnectionManage(actor)` — `ownsConnection || admin 이상`. `authorizeConnectionRead(actor)`(주소·토큰) — 같은 규칙. `authorizeGatewayApprove(role)` — admin 이상.
  - `authorizeAgentDiscover/Register/Patch/Archive(actor: ConnectionActor)` — 역할만 받던 것을 actor 로. `authorizeRunnerManage(actor)` 같음.
  - `authorizeAgentMoveGateway(role, ownsBoth: boolean)` — admin 이상, 또는 `ownsBoth`. 프로젝트 옮기기도 같은 꼴 `authorizeProjectMove(role, ownsBoth)`.
  - `owner.ts`: `gatewayOwner(db, workspaceId, gatewayId): string | null`, `runnerOwner(db, workspaceId, runnerTokenId): string | null`, `agentConnectionOwner(db, workspaceId, agentId): string | null`(OpenClaw → Gateway 주인, 러너 → 러너 토큰 주인, 연결 없음 → null), `projectOwner(db, workspaceId, projectId): string | null`.
  - 라우트: `requireOwner` 자리를 `requireSession` + 핸들러 안 정책으로. `POST /api/v1/gateways/:id/approve`(admin 이상) 새로.
- [ ] **Step 1: Write the failing tests** — `auth.policies.test.ts` 에 5.2 권한 표의 줄마다 한 단언(member 주인 ✅·member 남 ❌·admin ✅·owner ✅). `roles.matrix.test.ts` 의 Gateway·러너 토큰·프로젝트·에이전트 줄을 표에 맞춰 고친다. 라우트 시험: `member can create a gateway and a runner token`, `member can manage agents on own runner but not on others'`, `admin can manage agents on a member's runner`, `member cannot approve`, `member moves agent between own gateways only`, `control tool register follows the same owner rule`, `restoring an archived agent follows its connection owner, admin only when the connection is gone`(`POST /agents/:id/restore` 의 `admin` preHandler 를 정책으로).
- [ ] **Step 2: Run** `pnpm -F @dodok/server exec vitest run test/auth.policies.test.ts test/roles.matrix.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm -F @dodok/server test` — Expected: PASS.
- [ ] **Step 5: Commit** · `feat(server): let members manage their own connections`

### Task 11: 누구나 읽는 연결 목록·걸러진 설정 상태·실시간

**Files:**
- Create: `apps/server/src/modules/connections/routes.ts`, `packages/shared/src/connections/index.ts`(export 를 `packages/shared/src/index.ts` 에)
- Modify: `apps/server/src/modules/setup/routes.ts`(`GET /setup/status` 를 member 이상으로 열고 `gateways` 를 그 사람이 `authorizeConnectionRead` 를 지나는 것만으로 거른다), `apps/server/src/modules/runners/routes.ts`(`GET /setup/runner-tokens` 같은 걸러냄), `apps/server/src/modules/gateways/routes.ts`(`GET /gateways/:id/bridge-tokens` 정책), `apps/server/src/realtime/events.ts`·`packages/shared/src/wire/index.ts`(`connections.changed` 빈 페이로드), `apps/server/src/app.ts`(라우트 등록)
- Test: `apps/server/test/connections.routes.test.ts`, `apps/server/test/setup.status.test.ts`, `apps/server/test/setup.routes.test.ts`, `apps/server/test/roles.matrix.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ConnectionsResponse = z.object({
    gateways: z.array(z.object({ id: Id, name: z.string(), enabled: z.boolean(), approved: z.boolean(), owner: z.object({ id: Id, name: z.string() }).nullable() })),
    runners: z.array(z.object({ id: Id, label: z.string(), connected: z.boolean(), revoked: z.boolean(), owner: z.object({ id: Id, name: z.string() }).nullable() })),
    projects: z.array(z.object({ id: Id, runnerId: Id, label: z.string(), archived: z.boolean() })),
  });
  ```
  `GET /api/v1/connections`(member 이상). 주소·토큰·호스트·루트는 싣지 않는다. 연결 추가·수정·승인·삭제, 러너 토큰 발급·폐기, 프로젝트 추가·이름·보관·옮기기 뒤에 `connections.changed` 를 워크스페이스에 낸다.
- [ ] **Step 1: Write the failing tests** — `connections.routes.test.ts`: `member reads all connections without urls or tokens`(응답 JSON 문자열에 Gateway `url`·토큰 접두가 없다), `unapproved gateway is listed with approved false`. `setup.status.test.ts`: `member sees only own gateways in setup status`, `admin sees all`. Review Focus 5 의 시험을 여기에 둔다.
- [ ] **Step 2: Run** `pnpm -F @dodok/server exec vitest run test/connections.routes.test.ts test/setup.status.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm -F @dodok/server test` — Expected: PASS.
- [ ] **Step 5: Commit** · `feat(server): member-readable connection list and filtered setup status`

### Task 12: 2단계 화면

**Files:**
- Modify: `apps/web/src/features/connections/useConnectionTree.ts`(`GET /connections` 를 누구나, `meId` 를 넘긴다, wire `connections.changed` 로 무효화 — `apps/web/src/realtime/handlers.ts`), `ConnectionsLayout.tsx`(「내 연결」·「다른 사람의 연결」 묶음, 「＋ 연결 추가」 member 이상), `GatewayDetail.tsx`(메타에 「주인 <이름>」, 「승인 대기」 배지, admin 이상 「승인」 단추와 주소 한 줄, 주인·admin 이상에게 플러그인·브리지 토큰), `RunnerDetail.tsx`(주인 메타, 주인·admin 이상에게 설치·토큰·프로젝트 관리), `ProjectDetail.tsx`(주인도), `NewConnection.tsx`(member 이상, member 의 Gateway 저장 뒤 「승인 대기 — admin 이 승인하면 서버가 접속합니다」), `AgentDetail.tsx`·`agents/AgentRow.tsx`(`readOnly` = 「이 에이전트 연결의 주인도 admin 도 아니다」), `features/setup/RunnerSection.tsx`(`RunnerExposure` 문구를 스펙 5.5 대로 — 「채널 멤버 누구나 이 러너의 에이전트를 부를 수 있습니다」, 「admin 은 루트 안 아무 디렉터리에서 상한까지의 도구로 에이전트를 만들 수 있습니다 — 루트는 좁게, 상한은 낮게」, 나머지 둘은 지금 뜻 그대로)
- Create: `apps/web/src/features/connections/permissions.ts`
- Test: `apps/web/src/features/connections/connectionsLayout.test.tsx`, `gatewayDetail.test.tsx`, `runnerDetail.test.tsx`, `newConnection.test.tsx`, `apps/web/src/features/connections/permissions.test.ts`

**Interfaces:**
- Consumes: `ConnectionsResponse`(Task 11), 서버 정책(Task 10).
- Produces: `canManageConnection(role: TeamRole | undefined, meId: string | null, ownerId: string | null): boolean` — 서버 `authorizeConnectionManage` 와 같은 표. 화면의 모든 쓰기 단추가 이것으로 가른다(서버가 정본, 이것은 숨김 편의).
- [ ] **Step 1: Write the failing tests** — `permissions.test.ts`: 5.2 표의 줄마다. 화면: `member sees own connections under 내 연결 and can add one`, `member's new gateway shows pending approval`, `admin sees approve button with the url`, `member opening another's runner sees no install steps or token`(Review Focus 5 의 화면 쪽), `connections.changed refreshes the tree`.
- [ ] **Step 2: Run** `pnpm -F @dodok/web exec vitest run src/features/connections` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `pnpm -F @dodok/web test` — Expected: PASS.
- [ ] **Step 5: Commit** · `feat(web): own connections, gateway approval and member add flow`

### Task 13: 2단계 문서·dev:fake

**Files:**
- Modify: `docs/manual/user-guide.md`(「역할」 표에 member 의 자기 연결·admin 의 승인, 「연결」 절에 주인·승인 대기·「내 연결」), `docs/guides/plan.md`(10장 결정 「연결의 주인·Gateway 승인」, 8장), `docs/guides/docker-deploy.md`(Gateway 추가를 owner 만으로 적은 곳), `apps/server/scripts/dev-fake.ts`·`apps/server/test/helpers/live-app.ts`(`addFakeGateway` — 가짜 Gateway·러너의 주인을 owner 로 승인된 채 만든다. mia 가 만든 「승인 대기」 Gateway 하나를 새 DB 씨앗에 둘지는 빌더 판단), `.ruler/AGENTS.md`(dev:fake 설명 갱신)
- [ ] **Step 1:** 문서 고치기(화면 문구는 웹 소스에서 복사).
- [ ] **Step 2:** `pnpm exec ruler apply` → `git status`.
- [ ] **Step 3: Commit** · `docs: connection owners and gateway approval`

---

## 다른 작업과의 병합 메모

- `plugin-install-cmd` 가 `apps/web/src/features/setup/sections.tsx`(`PluginDownload`·`installCommands`)와 `IssueTokenDialog.tsx` 를 바꾼다. Task 4 는 `PluginDownload` 를 **감싸기만** 하므로, 그 작업이 먼저 들어오면 감싸는 래퍼만 새 꼴에 맞추고, 나중에 들어오면 그 작업이 `GatewayDetail` 의 자리를 그대로 쓴다. 병합 순서는 코디네이터가 정한다.
- `runner-default-claude-login` 은 `RunnerSection.tsx` 의 `InstallSteps` 2단계를 바꾼다 — Task 5 가 `InstallSteps` 를 export 만 하고 내용은 두므로 충돌은 그 함수 안 2단계 줄뿐이다.
- `messenger-basics` 는 「내 계정」만 — Task 2 의 `tabs.ts` 와 겹치지 않는다(그 작업이 탭을 더하면 이쪽 순서 단언을 맞춘다).
