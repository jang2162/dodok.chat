# 설정 통합·에이전트 보관·llms.txt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 Orca 워커가 태스크마다 돈다(`docs/guides/worktree-workflow.md`).

**Goal:** 사이드바 하단을 「설정」 하나로 모은 `/settings` 탭 화면, 채팅 기록을 남기는 에이전트 보관·되살리기, 노드의 AI 가 설치를 대신하는 `GET /llms.txt` 를 만든다.

**Architecture:** 서버는 `agents.archived_at` 하나로 보관을 표시하고, 런을 만드는 판정 자리(`router/decide.ts` 의 `isActive`, `components/service.ts` 의 `assertDeliverable`)가 「켜져 있고 보관되지 않음」을 한 함수로 본다. `llms.txt` 는 서버가 공개 오리진·파일 sha 를 채운 평문이고, 설치 파일 경로는 owner 세션 또는 발급 토큰을 받는다. 웹은 `/settings` 레이아웃 아래 탭 라우트로 기존 페이지를 옮긴다.

**Tech Stack:** Fastify·Drizzle(SQLite)·Socket.IO·Zod(shared) / React·TanStack Router·TanStack Query·Tailwind / Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-settings-agents-llms-design.md`

## Global Constraints

- 사용자에게 보이는 문구는 스펙 그대로 쓴다: 「삭제됨」, 「삭제된 에이전트 N」, 「되살리기」, 「삭제됨 — 되살리기」, 「삭제된 에이전트입니다」, 「@핸들 을 삭제합니다. 채팅 기록은 남고, 되살리면 채널·대화가 그대로 돌아옵니다.」, 「⚙ 설정」, 「← 설정」, 「AI 에게 맡기기」, 「서버에 파일이 없습니다」.
- 보관·되살리기 권한은 admin 이상(에이전트 등록과 같다). 옮기기는 지금처럼 owner.
- 새 오류 코드 `AGENT_ARCHIVED`(shared `ErrorCode`). HTTP 409.
- 새 wire 서버 이벤트 `agents.changed`(본문 `{}`) — workspace 룸. 등록·수정·옮기기·보관·되살리기에서 보낸다.
- `GET /llms.txt` 는 로그인 없음, `text/plain; charset=utf-8`, IP 버킷 분당 30(`modules/ops/limits.ts` 에 이름 붙여 더한다). 토큰·Gateway 목록·사람 이름을 싣지 않는다.
- 설치 파일: `plugin.tgz` 는 owner 세션 또는 `Authorization: Bearer <브리지 토큰>`(폐기 안 됨·묶인 Gateway 켜짐), `runner.tgz` 는 owner 세션 또는 `Bearer <러너 토큰>`(폐기 안 됨). 틀린 토큰은 브리지 실패 카운터에 센다, 꺼진 Gateway 토큰은 401 이되 세지 않는다.
- 외부 입력은 경계에서 Zod. shared 는 Node 전용 API 금지. 시크릿·토큰은 로그·응답·문서에 싣지 않는다.
- 마이그레이션은 drizzle-kit 생성 뒤 손으로 확인한다(ON DELETE 등이 빠지는지 — `docs/project-structure.md` 의 db 절).
- 커밋은 경로를 명시해 stage(`git add -A`·`git commit -a` 금지), Conventional Commits + 패키지 스코프, 트레일러 `Co-Authored-By: <실제 모델명> <noreply@anthropic.com>`.
- 포트 3100·5180·5173·3000 금지. 워커는 브리프가 준 포트만. 띄운 프로세스는 자기 PID 로만 끈다. 모델 런 금지.
- 문서·주석을 고치기 전에 `docs/guideline/base/03-comments.md`·`04-citation.md` 를 읽는다. 스펙 인용은 절 제목으로(「에이전트 보관」 절처럼), 번호로 쓰지 않는다.

## 계획 판정

- **PS1 — 「철회됨」 승인 상태는 기존 `cancelled` 다.** shared `ApprovalStatus` 에 새 값을 더하지 않는다. 웹 승인 카드가 `cancelled` 를 그리는 문구를 그대로 쓴다.
- **PS2 — 「활성」 판정은 한 함수다.** `apps/server/src/modules/agents/service.ts` 에 `isAgentActive(agent: Agent): boolean` (`agent.enabled && agent.archivedAt === null`)을 두고, `router/decide.ts` 의 `isActive`·`components/service.ts` 의 `assertDeliverable`·러너 hello 처리가 이것을 쓴다. 다른 자리에 `enabled` 를 따로 보는 런 생성 경로가 있으면 같이 바꾼다(태스크 1 이 `git grep -n "\.enabled"` 로 전수).
- **PS3 — 채널 멤버 응답에서 보관한 에이전트를 빼는 자리는 서버 조회 한곳이다.** `channel_members` 행은 그대로 두고 읽을 때 거른다(`listMembers` 를 쓰는 응답·`channel.member.changed`·에이전트 헤더 「참여자:」). 런 판정용 내부 호출도 같은 결과를 받으므로 PS2 와 겹쳐도 해가 없다.
- **PS4 — `agents.changed` 는 본문 없이 보낸다.** 웹은 `qk.agents` 와 열린 채널의 멤버 질의를 무효화한다. `people.changed` 처럼 목록을 싣지 않는 것은 보관한 에이전트까지 실은 목록을 모든 소켓에 밀 까닭이 없어서다.
- **PS5 — 웹 설정 레이아웃은 TanStack Router 의 레이아웃 라우트 하나**(`/settings` 경로, 자식 탭 라우트)다. 넓은 화면의 탭 목록은 레이아웃이 그리고, 좁은 화면에서 `/settings` 자체는 탭 목록 페이지다.
- **PS6 — `llms.txt` 본문 틀은 서버 소스의 템플릿 문자열 한곳**(`apps/server/src/modules/setup/llms.ts`)이고, 채울 값은 함수 인자로 받는다. 대조 테스트가 그 템플릿의 명령·키를 플러그인·러너 코드의 상수와 맞춘다.

## Review Focus

1. **보관과 진행 중인 런의 경합** — 보관 요청과 같은 순간에 그 에이전트로 멘션이 들어오면, 보관 뒤에는 새 런이 하나도 남지 않아야 한다(보관 트랜잭션 뒤 대기열에 선 런까지). 테스트: 대기열에 런 둘을 세운 채 보관 → 둘 다 닫히고 새 런이 0.
2. **되살리기 뒤 이어 답하기** — 되살린 에이전트가 같은 채널에서 예전 세션 키로 이어 답해야 한다(세션 행을 지우거나 새 키를 만들면 안 된다). 테스트: 보관 → 되살리기 → 멘션 → 같은 `agent_sessions` 행을 쓴다.
3. **보관한 에이전트가 작성한 메시지·멘션 칩의 표시** — 새로고침·다른 탭·오프라인 사본(IndexedDB)에서도 「삭제됨」으로 보이고 「알 수 없는 사용자」가 되지 않아야 한다. 테스트: 오프라인 사본 복원 뒤 작성자 줄.
4. **좁은 화면 설정 이동** — 390px 에서 `/settings` → 탭 → 「← 설정」 → 다른 탭이 브라우저 뒤로 가기와 함께 자연스러워야 하고, 머리가 스크롤에 붙어 있어야 한다. 테스트: 라우트 단위 + 브라우저 검증 항목.
5. **설치 파일 토큰 인증의 우회** — 폐기한 토큰·꺼진 Gateway 토큰·러너 토큰으로 `plugin.tgz` 받기·브리지 토큰으로 `runner.tgz` 받기가 모두 막혀야 한다. 테스트: 네 조합 401.

---

### Task 1: 서버 — 에이전트 보관·되살리기

**Files:**
- Create: `apps/server/drizzle/0015_agent_archive.sql`(drizzle-kit 생성 이름을 따른다)
- Modify: `apps/server/src/db/schema.sqlite.ts`(`agents.archivedAt`), `packages/shared/src/domain/index.ts`(`Agent.archivedAt`), `packages/shared/src/common.ts`(`AGENT_ARCHIVED`), `packages/shared/src/wire/index.ts`(`agents.changed`)
- Modify: `apps/server/src/modules/agents/service.ts`(`isAgentActive`·`archiveAgent`·`restoreAgent`·`rowToAgent`), `apps/server/src/modules/agents/routes.ts`(`DELETE /api/v1/agents/:id`·`POST /api/v1/agents/:id/restore`·discover `archivedAgentId`·등록 409), `apps/server/src/modules/router/decide.ts`, `apps/server/src/modules/components/service.ts`, 채널 멤버 조회(`listMembers` 가 사는 모듈), 러너 hello 처리(러너 어댑터 서버 쪽 — `git grep -n "claimUnbound"`), 런 중지 경로(`apps/server/src/modules/runs/orchestrator.ts`)
- Test: `apps/server/test/agents.archive.test.ts`(새), `apps/server/test/roles.matrix.test.ts`(두 경로 추가), `packages/shared/test/*`(스키마)

**Interfaces:**
- Produces: `isAgentActive(agent: Agent): boolean`, `archiveAgent(db, deps, id: string, workspaceId: string): Agent`, `restoreAgent(db, id: string, workspaceId: string): Agent`, shared `Agent.archivedAt: IsoDateTime | null`, discover 항목의 `archivedAgentId?: Id`, wire `"agents.changed": (p: Record<string, never>) => void`, 오류 `AGENT_ARCHIVED`(details `{ agentId }`).

- [ ] **Step 1: 실패하는 테스트** — `agents.archive.test.ts` 에 아래를 쓴다(기존 통합 테스트의 가짜 Gateway·플러그인 부트 도우미를 쓴다):
  - admin 이 `DELETE /api/v1/agents/:id` → 200, 응답 `archivedAt` 이 시각. 두 번째 DELETE 도 200(멱등). member 403. 없는 id 404.
  - 보관 뒤 그 에이전트 멘션 메시지 → 런 0(`runs` 표 수 그대로).
  - 대기열에 선 런 둘(같은 세션 키로 연달아 멘션)이 있는 채로 보관 → 둘 다 닫힘, 열린 런 0(Review Focus 1).
  - 걸린 승인이 있는 런을 보관 → 승인 `cancelled`(PS1).
  - 보관한 에이전트의 run_error 「다시 실행」 → 거절, 카드 소비 안 됨.
  - 채널 멤버 응답·`channel.member.changed`·에이전트 헤더 「참여자:」에 보관한 에이전트 없음, `channel_members` 행은 남음.
  - `GET /api/v1/agents` 가 보관한 에이전트도 `archivedAt` 과 함께 준다.
  - discover 가 같은 Gateway·id 항목에 `archivedAgentId` 를 싣는다. 같은 Gateway·id 로 `POST /api/v1/agents` → 409 `AGENT_ARCHIVED`, `details.agentId`.
  - `POST /api/v1/agents/:id/restore` → 200, `archivedAt` null, 다음 멘션이 같은 `agent_sessions` 행으로 런(Review Focus 2).
  - 등록·수정·옮기기·보관·되살리기마다 workspace 룸에 `agents.changed` 한 번.
  - 러너 에이전트를 보관하면 러너 hello 가 그 id 를 알려도 묶지 않고 런을 보내지 않는다.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/server exec vitest run test/agents.archive.test.ts` → FAIL(경로 없음).
- [ ] **Step 3: 구현** — 스키마·마이그레이션(생성 뒤 SQL 확인), shared, 서비스·라우트, PS2 의 `isAgentActive` 를 `decide.ts`·`assertDeliverable`·러너 hello 에, PS3 의 멤버 조회 거름, 보관 때 열린 런을 사람 「중지」와 같은 함수로 멈추고 대기열 런을 닫기, `agents.changed` 팬아웃. `git grep -n "\.enabled"` 로 런 생성 경로를 전수해 남은 자리를 PS2 로 바꾼다.
- [ ] **Step 4: 역할 매트릭스** — `roles.matrix.test.ts` 에 두 경로를 admin 허용·member 거부로 추가.
- [ ] **Step 5: 통과 확인** — 서버·shared 테스트, 루트 `pnpm typecheck`.
- [ ] **Step 6: 커밋** — `feat(server): archive and restore agents` (+ shared 는 `feat(shared): …` 로 나눠도 된다).

### Task 2: 서버 + 웹 — `llms.txt`·토큰으로 설치 파일 받기·「AI 에게 맡기기」

**Files:**
- Create: `apps/server/src/modules/setup/llms.ts`(템플릿·`renderLlmsTxt(input: LlmsInput): string`), `apps/server/test/setup.llms.test.ts`
- Modify: `apps/server/src/modules/setup/routes.ts`(`GET /llms.txt`, `plugin.tgz` 인증), `apps/server/src/modules/runners/routes.ts`(`runner.tgz` 인증), `apps/server/src/modules/ops/limits.ts`(버킷 `llmsTxt` 분당 30), 토큰 검증(`modules/setup/tokens.ts`·`modules/runners/tokens.ts`), `infra/Caddyfile`(`@backend` 에 `/llms.txt`), `apps/web/vite.config.ts`(프록시 `/llms.txt`), 웹 발급 대화상자(`apps/web/src/features/setup/` 의 브리지·러너 토큰 발급 대화상자)
- Test: `apps/server/test/setup.llms.test.ts`, 웹 발급 대화상자 테스트, `infra/check-caddy.sh` 가 경로를 보면 거기에도

**Interfaces:**
- Consumes: 공개 오리진·`bridgeUrl` 계산(`modules/setup/status.ts` 의 `bridgePublicUrl` 과 같은 함수), 플러그인·러너 파일 정보(`plugin-file.ts`·`runner-file.ts` — 파일 sha256·번들 sha256).
- Produces: `GET /llms.txt`, `renderLlmsTxt({ origin, bridgeUrl, plugin: FileInfo | null, runner: FileInfo | null })`, 웹 `llmsHandoffLine(kind: "bridge" | "runner", origin: string, token: string): string`.

- [ ] **Step 1: 실패하는 테스트** — `setup.llms.test.ts`:
  - `GET /llms.txt` 로그인 없이 200, `content-type` `text/plain; charset=utf-8`, 본문에 공개 오리진·`bridgeUrl`·플러그인 파일 sha256·번들 sha256, 「OpenClaw Gateway 호스트」·「Claude 러너 머신」 절 제목, AI 규칙 네 줄.
  - 본문에 `dbt_`·`drn_`·Gateway 이름·사람 이메일이 없다(발급한 토큰·만든 Gateway 가 있는 상태에서).
  - 플러그인 파일이 없으면 그 절에 「서버에 파일이 없습니다」.
  - 버킷: 같은 IP 31번째 요청 429.
  - **대조**: 본문의 플러그인 계정 키(`bridgeUrl`·`token`), 설치 경로(`/api/v1/setup/plugin.tgz`·`/api/v1/setup/runner.tgz`), 러너 설정 키(`serverUrl`·`tokenFile`·`claudeConfigDir`·`agents`)가 각각 플러그인 설정 스키마·`packages/claude-runner/src/config.ts` 의 `RunnerConfig` 키에 있는지 import 해 확인(PS6).
  - `plugin.tgz`: owner 세션 200, 유효한 브리지 토큰 200, 폐기한 토큰 401, 꺼진 Gateway 토큰 401(실패 카운터 그대로), 러너 토큰 401, 틀린 토큰 401(카운터 +1). `runner.tgz`: 러너 토큰 200, 폐기 401, 브리지 토큰 401(Review Focus 5).
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/server exec vitest run test/setup.llms.test.ts` → FAIL.
- [ ] **Step 3: 구현** — 템플릿은 스펙 「`llms.txt`」 절의 순서·명령 그대로(`deploy.md` 「[웹 → B] 플러그인 설치·브리지 토큰」·「Claude 러너 설치」 절과 같은 명령), 라우트, 인증 preHandler(owner 세션이 없으면 Bearer 를 본다), 버킷, Caddy·Vite 경로.
- [ ] **Step 4: 웹 대화상자** — 발급 대화상자의 원문 아래 「AI 에게 맡기기」 줄과 「복사」. 문구는 스펙 「발급 대화상자」 절 그대로. 테스트: 원문이 보이는 동안만 줄이 있고, 복사 버튼이 그 줄 전체를 복사.
- [ ] **Step 5: 통과 확인** — 서버·웹 테스트, `bash infra/check-caddy.sh` 는 Docker 가 필요하므로 돌리지 않고 Caddyfile 문법은 리뷰에 맡긴다고 보고서에 적는다.
- [ ] **Step 6: 커밋** — `feat(server): serve llms.txt and let issued tokens download installers`, `feat(web): offer an AI handoff line when issuing tokens`.

### Task 3: 웹 — 설정 레이아웃·사이드바

**Files:**
- Create: `apps/web/src/features/settings-shell/SettingsLayout.tsx`, `SettingsNav.tsx`, `AccountPage.tsx`(지금 `features/account/AccountDialog.tsx` 내용 + 로그아웃), `NotificationsPage.tsx`(지금 `app/layout/NotifySettings.tsx` 내용), 테스트
- Modify: `apps/web/src/app/router.tsx`(`/settings` 레이아웃 + 자식 `account`·`notifications`·`agents`·`members`·`connection`·`operations`, `/settings` → `account` 넘김(넓은 화면만, 좁은 화면은 목록), `/agents` → `/settings/agents` 넘김), `apps/web/src/app/layout/Sidebar.tsx`(하단 = 연결 점 + 「⚙ 설정」 + admin 이상 배지), 옛 링크(`Banners.tsx`·`SystemCard.tsx`·`DiscoverDialog.tsx`)
- Delete(옮긴 뒤): `AccountDialog.tsx`·`NotifySettings.tsx` 의 대화상자·위젯 껍데기(내용은 페이지로)
- Test: `apps/web/src/features/settings-shell/*.test.tsx`, `apps/web/src/app/layout/layout.test.tsx`

**Interfaces:**
- Consumes: `useIsOwner`·`useCanManage`(역할), `useOpsStatus`(배지), 기존 페이지 컴포넌트(`AgentsPage`·`MembersPage`·`ConnectionPage`·`OpsPage`).
- Produces: `SETTINGS_TABS: readonly { path: string; label: string; visible: (role) => boolean }[]` — 태스크 4 가 에이전트 탭을 그 자리에서 고친다.

- [ ] **Step 1: 실패하는 테스트** — 사이드바 하단에 「⚙ 설정」 하나와 연결 점만(에이전트·멤버·연결·운영·내 계정·로그아웃·알림이 없다), admin 이상이면 배지 수, member 는 배지 없음. 탭 목록이 역할대로(member: 내 계정·알림·에이전트, admin: +멤버·운영, owner: +연결). `/agents` → `/settings/agents`. 넓은 화면 `/settings` → `/settings/account`. 좁은 화면 `/settings` 는 탭 목록, 탭 페이지 머리에 「← 설정」(누르면 `/settings`). 로그아웃은 내 계정 페이지에 있고 누르면 지금과 같은 로그아웃 훅. 탭 이동 뒤 초점이 내용 제목.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/web exec vitest run src/features/settings-shell` → FAIL.
- [ ] **Step 3: 구현** — PS5. 넓은 화면은 탭 목록(고정) + 내용(따로 스크롤 — 셸의 `#page-scroll` 안에서 내용 칸만 스크롤), 좁은 화면 머리는 `sticky top-0`. 기존 페이지의 머리(`OpenSidebarButton` + 제목)는 레이아웃이 그리게 옮기거나, 페이지가 그리되 좁은 화면에서 「← 설정」을 더한다 — 한 가지로 고르고 보고서에 적는다.
- [ ] **Step 4: 통과 확인** — 웹 테스트·typecheck·lint·웹 빌드.
- [ ] **Step 5: 커밋** — `feat(web): gather settings under /settings tabs`.

### Task 4: 웹 — 에이전트 삭제·되살리기·「삭제됨」 표시

**Files:**
- Modify: `apps/web/src/features/agents/AgentsPage.tsx`·`AgentRow.tsx`(「삭제」·확인 대화상자·「삭제된 에이전트 N」 접힌 묶음·「되살리기」), `DiscoverDialog.tsx`(`archivedAgentId` → 「삭제됨 — 되살리기」), `apps/web/src/features/messages/useAuthors.ts`·`MessageItem.tsx`(작성자 「삭제됨」), 멘션 칩 렌더(`features/composer/mentions.ts` 와 메시지 렌더의 칩), 멘션 후보·채널 설정 에이전트 셀렉트·멤버 줄(보관 거름), 운영 화면 에이전트별 표(「삭제됨」), `apps/web/src/realtime/handlers.ts`(`agents.changed` → `qk.agents`·채널 멤버 무효화), API 클라이언트(`archiveAgent`·`restoreAgent`), 오류 문구(`AGENT_ARCHIVED`)
- Test: 각 화면 테스트, `people.test.tsx`(작성자), 오프라인 사본 복원 테스트(Review Focus 3)

**Interfaces:**
- Consumes: 태스크 1 의 API·`Agent.archivedAt`·`agents.changed`·`AGENT_ARCHIVED`, 태스크 3 의 `/settings/agents`.

- [ ] **Step 1: 실패하는 테스트** — admin 에게 줄마다 「삭제」, 확인 문구(Global Constraints 그대로), 확인하면 `DELETE` 를 한 번만(같은 틱 연속 클릭 가드), member 에게 「삭제」·「되살리기」 없음. 「삭제된 에이전트 N」 묶음이 접혀 있고 펼치면 「되살리기」. 보관한 에이전트가 쓴 메시지 작성자 옆·멘션 칩에 「삭제됨」, 멘션 후보·채널 설정 셀렉트·멤버 줄에 없음. discover 의 보관 항목이 「삭제됨 — 되살리기」이고 누르면 `restore`. `agents.changed` 를 받으면 다른 탭 목록이 바뀐다. 오프라인 사본에서 복원한 채널에서도 작성자 「삭제됨」(Review Focus 3).
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 웹 테스트·typecheck·lint·웹 빌드.
- [ ] **Step 5: 커밋** — `feat(web): archive and restore agents and mark their history`.

### Task 5: dev:fake 브라우저 검증 (검증 워커 — 코드를 고치지 않는다)

**Files:** 보고서·스크린샷만.

- [ ] **Step 1:** dev:fake + 웹을 브리프 포트로 띄우고 독립 Chromium(neo 금지)으로 owner·admin·member 각각:
  1. 사이드바 하단(설정·배지), 탭 노출, 옛 `/agents` 넘김.
  2. 넓은 화면 탭 이동·내용만 스크롤, 390px `/settings` 목록 → 탭 → 「← 설정」 → 뒤로 가기, 머리 고정(Review Focus 4).
  3. 내 계정(이름 바꾸기·로그아웃), 알림 탭.
  4. 에이전트 삭제 → 채널 기록 「삭제됨」 → 멘션 후보에서 빠짐 → 손으로 친 `@핸들` 이 런을 안 만듦 → 되살리기 → 같은 채널에서 이어 답함. 다른 탭에서 목록이 바뀜.
  5. 셋째 Gateway 로 가져오기 → 삭제 → 가져오기 목록 「삭제됨 — 되살리기」.
  6. 브리지·러너 토큰 발급 대화상자의 「AI 에게 맡기기」 줄, `curl` 로 `/llms.txt`(웹 오리진 프록시 경유)와 토큰 `plugin.tgz` 받기.
- [ ] **Step 2:** 보고서에 항목별 통과/결함(재현 단계·스크린샷·기대와 실제), 콘솔 오류.

### Task 6: 문서·실연

**Files:**
- Modify: `docs/guides/deploy.md`(「[웹 → B] 플러그인 설치·브리지 토큰」·「Claude 러너 설치」 절에 「AI 에게 맡기는 길」, 「설정 — `.env`」 표는 그대로, `/settings` 주소들), `docs/guides/user-guide.md`(설정 화면·에이전트 삭제·되살리기), `docs/project-structure.md`(서버 `modules/setup/llms.ts`·에이전트 보관, 웹 `features/settings-shell`), `docs/guides/agent-guide.md`(보관한 에이전트는 런을 받지 않는다 — 해당 절이 있으면), `docs/guides/live-smoke.md`(새 절 「llms.txt 실연」), 스펙 끝에 「구현과 맞춘 것」 장(판정 PS1~PS6 와 원장 Ruling)
- [ ] **Step 1: 실연(모델 런 0회)** — 스크래치 상태 디렉터리의 실물 dev Gateway(`OPENCLAW_HOME`, 멀티 Gateway 실연 절차)와 소스 실행 서버로: 연결 페이지에서 Gateway 추가·브리지 토큰 발급 → 「AI 에게 맡기기」 줄의 `llms.txt` 「OpenClaw Gateway 호스트」 절 명령을 **사람 손으로 그대로** 따라 해 「접속됨 · 서버와 같은 빌드입니다」. 러너 절은 런 0회 하네스 설치본으로 `연결됨` 까지. 토큰은 어떤 출력에도 찍지 않는다.
- [ ] **Step 2: 문서** — 위 파일. 화면 문구는 소스 그대로.
- [ ] **Step 3: 확인** — `pnpm fmt:check`, 문서 대조 테스트(`connection.test.tsx` 의 deploy.md 블록 대조 등) 실행 수.
- [ ] **Step 4: 커밋** — `docs: …`, 실연 결과는 `docs(live-smoke): …` 로 나눈다.

## 순서

A 태스크 1 ‖ 태스크 2 ‖ 태스크 3 → B 태스크 4(1·3 병합 뒤) → C 태스크 5 → D 태스크 6.
태스크 2 와 3 은 웹에서 `features/setup/` 발급 대화상자와 `router.tsx` 가 겹칠 수 있다 — 먼저 병합된 쪽 위로 rebase 한다.

## Self-Review

- 스펙 「에이전트 보관」 데이터·API·서버 동작 → 태스크 1, 웹 → 태스크 4. 「설정 통합」 → 태스크 3. 「`llms.txt`」 내주기·내용·토큰 받기 → 태스크 2, 발급 대화상자 → 태스크 2 Step 4. 「오류」 표 → 태스크 1·2 테스트. 「테스트·검증」의 브라우저·실연 → 태스크 5·6. 「완료 기준」 4(문서) → 태스크 6.
- 운영 화면 에이전트별 표의 「삭제됨」 → 태스크 4.
- 이름 대조: `isAgentActive`·`archiveAgent`·`restoreAgent`·`renderLlmsTxt`·`llmsHandoffLine`·`SETTINGS_TABS`·`AGENT_ARCHIVED`·`agents.changed` 가 태스크 사이에 같은 이름이다.
