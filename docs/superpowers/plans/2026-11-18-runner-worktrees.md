# 러너 프로젝트 git 워크트리 Implementation Plan

> **For agentic workers:** 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 브리프가 이 계획의 태스크를 가리키고, 워커는 이 계획과 스펙을 함께 읽는다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** git 러너 프로젝트에서 워크트리를 하위 프로젝트로 만들고(기본 `<저장소>/.worktrees/<이름>`, 위치 선택 가능), 그 아래에 에이전트를 두며, 보관 때 러너가 워크트리 폴더를 지운다.

**Architecture:** 러너가 새 ack 요청 `worktree.create`·`worktree.remove` 를 `execFile("git")` 로 처리하고 hello 능력 `worktrees` 를 알린다. 서버는 `runner_projects` 에 부모·브랜치·git 여부·정리 사유 열을 더하고, 만들기·보관 REST 가 러너에 묻는다. 웹은 연결 트리·프로젝트 상세에 워크트리를 부모 아래로 그리고, 만들기 대화상자와 에이전트 폼 지름길을 둔다.

**Tech Stack:** Zod(shared), Node `child_process.execFile`·git(runner), Socket.IO ack, Fastify·drizzle·SQLite(server, 마이그레이션 `0040`), React·TanStack Query(web).

**Spec:** `docs/superpowers/specs/2026-11-18-runner-worktrees-design.md` — 결정 W1~W14 는 그 3장.

## Global Constraints

- git 은 `execFile("git", args)` 로만(셸 없음). 경로·브랜치 인자 앞에 `--`. 브랜치는 먼저 `git check-ref-format --branch <이름>` 으로 검사.
- 워크트리 만들기에 `--force` 없음, 지우기에 `--force` 없음(W7). 강제 삭제 기능을 만들지 않는다.
- 저장소의 추적 파일을 바꾸지 않는다 — 무시 규칙은 `git rev-parse --git-path info/exclude` 의 파일에만, `git check-ignore` 가 이미 덮으면 쓰지 않는다(W5).
- 기본 위치 `<부모 relPath>/.worktrees/<슬러그>`(W3), 기본 브랜치 `dodok/<슬러그>`(W6). 위치는 그 러너의 허용 루트 안(W4).
- ack 상한 `RUNNER_GIT_ACK_TIMEOUT_MS = 30_000`(기존 `RUNNER_FS_ACK_TIMEOUT_MS` 10초와 따로).
- 능력 문자열 `"worktrees"` — shared `RunnerCapability` enum 에 더한다. `RUNNER_PROTOCOL` 은 올리지 않는다.
- git stderr 를 사람에게 보일 때는 러너 `mask` 로 경로를 가리고 200자로 자른다.
- 러너 `package.json` 판본은 올리지 않는다(조율자 — 0.7.0). 실제 모델 런 금지.
- 화면 문구는 2026-11-10 문구 정리 기준. 정한 문구(스펙 원문): 「워크트리를 먼저 보관하세요」(W9), 「에이전트를 먼저 보관하세요」(W11), 「정리하지 못했습니다 — 커밋하지 않은 변경이 있습니다」(W7), 「러너가 연결되어 있어야 정리할 수 있습니다」, 「폴더를 남기고 보관」(W12), 「러너를 업데이트하세요(워크트리는 0.7.0 부터)」, 「러너 머신에 git 이 없습니다」.
- 공통: Conventional Commits·패키지 스코프, 경로 명시 stage.

## Review Focus

1. **브랜치·폴더 이름이 `-` 로 시작하거나 셸 문자(`;`·`$(…)`·공백)를 담아도 옵션·명령으로 해석되지 않는다** — 러너가 `invalid_branch` 또는 그 이름 그대로의 브랜치. (Task 2 시험)
2. **변경이 있는 워크트리의 보관은 아무것도 지우지 않고 409, 「폴더를 남기고 보관」은 폴더·브랜치를 그대로 둔다.** (Task 2·3 시험)
3. **만들기 도중 끊겨 남은 워크트리를 다시 만들면 같은 브랜치일 때 받아들여지고(W13), 다른 브랜치면 `target_exists`.** (Task 2 시험)
4. **보관한 자리와 같은 자리에 다시 만들 수 있고, 보관 안 된 같은 자리는 러너에 묻기 전에 409.** (Task 3 시험)
5. **옛 러너(능력 없음)·끊긴 러너·git 아님·이미 워크트리인 프로젝트에서 웹 단추가 사유와 함께 잠긴다.** (Task 4 시험)

---

### Task 1: 계약

**Files:**
- Modify: `packages/shared/src/runner/index.ts`(`RunnerCapability`, `RunnerProjectCheckResult`, 새 스키마, `RunnerServerToClientEvents`)
- Modify: `packages/shared/src/control/runner-bodies.ts`(`RunnerProject`, 새 본문)
- Test: `packages/shared/test/runner.test.ts`, `packages/shared/test/runner-rest.test.ts`, `packages/shared/test/runner-v2.test.ts`

**Interfaces — Produces:**
- `RunnerCapability` 에 `"worktrees"`.
- `RunnerProjectCheckResult` ok 갈래에 `isGitTop: z.boolean().optional()`(옛 러너는 없음 → 서버는 `false`).
- `RunnerWorktreeCreate = z.object({ repo: RunnerProjectRef, target: RunnerProjectRef, branch: z.string().min(1).max(200) })`
- `RunnerWorktreeCreateResult = discriminatedUnion("ok", [{ ok: true, created: boolean, adopted: boolean, base: string.max(64) }, { ok: false, reason: enum(["not_git","is_worktree","target_exists","outside_root","root_missing","branch_in_use","invalid_branch","git_failed"]), message: string.max(200).optional() }])`
- `RunnerWorktreeRemove = z.object({ repo: RunnerProjectRef, target: RunnerProjectRef })`
- `RunnerWorktreeRemoveResult = discriminatedUnion("ok", [{ ok: true }, { ok: false, reason: enum(["dirty","not_worktree","git_failed"]), message: string.max(200).optional() }])`
- `RunnerServerToClientEvents` 에 `"worktree.create"`·`"worktree.remove"`(ack 꼴은 `project.check` 와 같게).
- `RunnerProject` 에 `parentProjectId: Id.nullable()`, `branch: z.string().nullable()`, `isGit: z.boolean()`, `cleanupIssue: z.string().nullable()`.
- `CreateWorktreeBody = z.object({ label: z.string(), branch: z.string().optional(), location: RunnerProjectRef.optional() })`, `ArchiveRunnerProjectBody = z.object({ keepFolder: z.literal(true).optional() })`.

- [ ] **Step 1: 실패하는 시험** — 각 스키마의 parse 성공·실패(이유 enum 밖 값 거절, message 201자 거절), `RunnerCapability` 가 `"worktrees"` 를 받음, 옛 `project.check` ok(`isGitTop` 없음) 통과, `RunnerProject` 새 필드.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/shared test`.
- [ ] **Step 3: 구현** — 위 그대로. `RunnerProject` 를 리터럴로 만드는 서버·웹 자리는 typecheck 가 알려 준다 — 이 태스크에서는 `parentProjectId: null, branch: null, isGit: false, cleanupIssue: null` 로 채워 통과만 시킨다(서버 `apps/server/src/modules/runners/projects.ts` 의 행 → 응답 변환, 웹 시험 픽스처).
- [ ] **Step 4: 통과 확인** — shared 시험, `pnpm typecheck`. 실행 수 기록.
- [ ] **Step 5: 커밋** — `feat(shared): runner worktree contracts`

### Task 2: 러너 — git 워크트리

**Files:**
- Create: `packages/claude-runner/src/worktrees.ts`
- Modify: `packages/claude-runner/src/fs-browse.ts`(`checkProject` 에 `isGitTop`), `packages/claude-runner/src/connection.ts`(이벤트 둘·능력)
- Test: Create `packages/claude-runner/test/worktrees.test.ts`; Modify `packages/claude-runner/test/fs-browse.test.ts`, `packages/claude-runner/test/connection.test.ts`

**Interfaces:**
- Consumes: Task 1 스키마.
- Produces:
  - `createWorktree(cfg: Pick<ResolvedRunnerConfig,"roots">, req: RunnerWorktreeCreate, deps?: { git?: GitRunner; mask?: (s: string) => string }): Promise<RunnerWorktreeCreateResult>`
  - `removeWorktree(cfg, req: RunnerWorktreeRemove, deps?): Promise<RunnerWorktreeRemoveResult>`
  - `isGitTop(dir: string, git?: GitRunner): Promise<boolean>` — `rev-parse --show-toplevel` 이 dir 의 realpath 이고 `--git-dir` 와 `--git-common-dir` 의 절대 경로가 같음.
  - `type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>`(기본은 `execFile`, `ENOENT` 면 `git_failed` 「러너 머신에 git 이 없습니다」)
  - 판정 순서(만들기): repo 를 `resolveProject` 로 풀기(→ `root_missing`/`outside_root`) → `isGitTop` 아니면 `.git` 이 파일이면 `is_worktree`, 그 밖 `not_git` → `check-ref-format --branch`(→ `invalid_branch`) → target 을 루트 안으로 풀기(아직 없을 수 있으니 부모 디렉터리를 realpath 로 풀고 이름을 붙인다, 루트 밖이면 `outside_root`) → target 이 있으면: `git worktree list --porcelain` 에 그 경로가 있고 브랜치가 같으면 `{ ok, created:false, adopted:true }`, 아니면 `target_exists`(빈 디렉터리는 진행) → 브랜치 있음(`rev-parse --verify --quiet refs/heads/<b>`) 이면 `worktree add -- <target> <b>`, 없으면 `worktree add -b <b> -- <target> HEAD` → stderr 에 `already checked out`/`is already used by worktree` 면 `branch_in_use` → exclude(W5) → `base` 는 `rev-parse --short HEAD`(target 안에서).
  - exclude: target 이 repo 안이면 repo 기준 상대 경로 `/<rel>/` 을 `check-ignore -q` 로 보고 아니면 exclude 파일 끝에 한 줄(파일 끝 개행 보정). 기본 위치면 그 줄은 `/.worktrees/`.
  - 지우기: target 폴더가 없으면 `worktree prune` → ok. `.git` 파일이 없거나 repo 의 `worktree list` 에 없으면 `not_worktree`. `worktree remove -- <target>` 실패 stderr 가 `contains modified or untracked files` 면 `dirty`, 그 밖 `git_failed`.
  - hello `capabilities` 에 `"worktrees"`.

- [ ] **Step 1: 실패하는 시험** — `worktrees.test.ts` 는 **실제 git 으로** 임시 디렉터리에 저장소를 만들어(초기 커밋 하나) 돈다: `creates new branch at default location and excludes /.worktrees/ once`(두 번째 만들기에서 exclude 줄이 하나), `existing branch is checked out (created:false)`, `branch used by another worktree → branch_in_use`, `branch "-x" and "a;rm -rf b" → invalid_branch, no folder, no branch`, `target outside root → outside_root`, `target with files → target_exists`, `registered worktree same branch → adopted`, `already ignored by .gitignore → exclude untouched`, `repo is itself a worktree → is_worktree`, `remove clean → folder gone, branch kept`, `remove with untracked file → dirty, folder kept`, `remove missing folder → prune ok`, `git missing (ENOENT GitRunner) → git_failed with message`, `stderr paths are masked`. `fs-browse.test.ts`: `checkProject isGitTop true for repo top, false for subdir and worktree`. `connection.test.ts`: `hello capabilities include worktrees`, `worktree.create ack goes through createWorktree`.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/runner test`.
- [ ] **Step 3: 구현** — 위 Interfaces. 시험의 git 은 env 를 비운 `GIT_CONFIG_GLOBAL=/dev/null`·`user.name/email` 지정으로 머신 설정에 기대지 않게.
- [ ] **Step 4: 통과 확인** — 러너 시험, typecheck. 실행 수.
- [ ] **Step 5: 커밋** — `feat(runner): create and remove git worktrees on request`

### Task 3: 어댑터·서버

**Files:**
- Modify: `packages/runner-adapter/src/runner-adapter.ts`(`askRunner` 상한 인자, `worktreeCreate`·`worktreeRemove`, `RUNNER_GIT_ACK_TIMEOUT_MS`), `packages/runner-adapter/src/index.ts`(export)
- Modify: `apps/server/src/db/schema.sqlite.ts`, Create: `apps/server/drizzle/0040_runner_worktrees.sql`(+ `drizzle/meta` 는 drizzle-kit 로 생성)
- Modify: `apps/server/src/modules/runners/projects.ts`(`createWorktreeProject`, `archiveProject`, `moveProject`, 행 변환), `apps/server/src/modules/runners/projects.routes.ts`, `apps/server/src/modules/runners/live.ts`(능력·호출 노출이 거기 있으면), `apps/server/src/modules/agents/service.ts`(`restoreAgent`)
- Modify: `apps/server/scripts/dev-fake.ts`(가짜 러너 둘의 `worktree.*` 응답·능력 — 「dev-fake 제한」은 능력 없음)
- Test: `packages/runner-adapter/test/runner-adapter.test.ts`, `apps/server/test/runner-projects.routes.test.ts`, `apps/server/test/runner-projects.service.test.ts`, `apps/server/test/agents.archive.test.ts`, `apps/server/test/dev-fake.test.ts`, `apps/server/test/roles.matrix.test.ts`

**Interfaces:**
- Consumes: Task 1 스키마.
- Produces:
  - 어댑터 `worktreeCreate(tokenId: string, req: RunnerWorktreeCreate): Promise<RunnerWorktreeCreateResult>`, `worktreeRemove(tokenId, req): Promise<RunnerWorktreeRemoveResult>`, 러너의 능력 조회 `hasCapability(tokenId, "worktrees"): boolean`(이미 비슷한 조회가 있으면 그것).
  - 열: `parent_project_id`(FK self, nullable), `branch`(text nullable), `is_git`(integer boolean, default 0), `worktree_cleanup`(text nullable).
  - `createWorktreeProject(db, runners, input: { workspaceId; parentId; label; branch?; location?; user }): Promise<RunnerProjectRow>` — 순서: 부모 읽기(보관·워크트리·`is_git` 거짓이면 400) → 권한(W10, 지금 `createProject` 와 같은 검사) → 러너 붙음(아니면 409)·능력(아니면 400 스펙 문구) → 슬러그·기본값 → **같은 자리 활성 행 있으면 409**(러너에 묻기 전) → `worktreeCreate` → ok 면 행 insert(`parentProjectId`·`branch`·`isGit: false`), 실패면 400 `details.reason`·`message`.
  - `slugOf(label: string): string` — 소문자 ASCII·숫자·`-` 만, 나머지는 `-` 로, 앞뒤 `-` 제거, 40자, 비면 `wt-<6 hex>`.
  - `archiveProject` — 워크트리 행: 보관 안 된 에이전트 있음 또는 그 프로젝트 에이전트의 진행 중 런 있음 → 409 「에이전트를 먼저 보관하세요」(W11). `keepFolder` 면 바로 보관(`worktree_cleanup` 비움). 아니면 러너 폐기 → 409 `reason: "runner_revoked"`, 끊김 → 409 `reason: "runner_offline"`, `worktreeRemove` 실패 → `worktree_cleanup` 에 reason 저장 후 409. 성공 → 보관. 부모 행: 보관 안 된 워크트리 있으면 409 「워크트리를 먼저 보관하세요」(W9).
  - `moveProject` — 워크트리 행이면 400, 보관 안 된 워크트리가 있는 부모면 409(W9).
  - 프로젝트 만들기·`/check` 때 `isGitTop` 을 `is_git` 에 저장(W14).
  - `restoreAgent` — 그 에이전트 프로젝트가 보관된 워크트리면 409.
  - REST: `POST /api/v1/runner-projects/:id/worktrees`(본문 `CreateWorktreeBody`), `POST /api/v1/runner-projects/:id/archive`(본문 `ArchiveRunnerProjectBody` 선택).

- [ ] **Step 1: 실패하는 시험** — 어댑터: `worktree.create uses 30s ack and parses result`, `bad ack → INTERNAL`. 서버 routes·service: `creates worktree row with defaults .worktrees/<slug> and dodok/<slug>`, `Korean label → wt- slug`, `custom location passes through`, `parent not git / is worktree / archived → 400`, `runner without worktrees capability → 400 copy`, `offline → 409`, `same active place → 409 without asking runner`(가짜 어댑터 호출 0), `same place as archived row → ok`, `runner failure → no row, 400 reason`, `archive worktree with active agent → 409`, `archive dirty → 409 + cleanupIssue saved`, `keepFolder archives without asking runner`, `revoked runner → 409 runner_revoked`, `archive parent with active worktree → 409`, `move worktree → 400`, `move parent with worktree → 409`, `check stores isGit`. `agents.archive.test.ts`: `restore agent of archived worktree → 409`. `roles.matrix.test.ts`: 새 경로 둘의 역할별 허용·거부(지금 프로젝트 경로와 같은 표). dev-fake: `main fake runner advertises worktrees, limited does not`.
- [ ] **Step 2: 실패 확인** — 어댑터·서버 시험 각각 혼자.
- [ ] **Step 3: 구현** — 위 Interfaces. 마이그레이션은 drizzle-kit 로 만들고 번호가 `0040` 인지 본다.
- [ ] **Step 4: 통과 확인** — 각각 혼자, typecheck. 실행 수.
- [ ] **Step 5: 커밋** — `feat(server): runner worktree projects`

### Task 4: 웹

**Files:**
- Modify: `apps/web/src/features/runners/ProjectList.tsx`, `apps/web/src/features/runners/mutations.ts`, `apps/web/src/features/runners/copy.ts`, `apps/web/src/features/connections/tree.ts`, `apps/web/src/features/connections/ProjectDetail.tsx`, `apps/web/src/features/agents/RunnerAgentForm.tsx`
- Create: `apps/web/src/features/runners/CreateWorktreeDialog.tsx`, `apps/web/src/features/runners/worktreeFields.tsx`(대화상자·에이전트 폼이 함께 쓰는 이름·브랜치·위치 칸)
- Test: Create `apps/web/src/features/runners/worktree.test.tsx`; Modify `apps/web/src/features/runners/runners.test.tsx`, `apps/web/src/features/connections/tree.test.ts`, `apps/web/src/features/agents/agentsRunner.test.tsx`

**Interfaces:**
- Consumes: Task 1 `RunnerProject` 새 필드, Task 3 REST.
- Produces:
  - `useCreateWorktree(parentId: string)`(POST `/runner-projects/:id/worktrees`), `useArchiveRunnerProject` 에 `keepFolder` 인자.
  - `worktreeDefaults(parent: RunnerProject, label: string): { branch: string; location: RunnerProjectRef }` — 서버 `slugOf` 와 같은 규칙(같은 시험 값 셋을 양쪽 시험에 둔다: `"Feat Login" → feat-login`, `"로그인" → wt-…`(접두사만 단언), `"--x" → x`).
  - `worktreeLock(parent, runner): string | undefined` — 잠금 사유: 끊김, 능력 없음(스펙 문구), `!isGit`, 워크트리, 보관.
  - `projectPlace` 는 워크트리면 `<부모 label> · <branch>`.
  - 트리: 워크트리는 부모 프로젝트 노드의 `worktrees` 아래(`TreeProject` 에 `worktrees: TreeProject[]`).
- 위치 「바꾸기」: 「프로젝트 추가」(`AddProjectDialog.tsx`)의 둘러보기·직접 입력 부품을 다시 쓴다 — 둘러보기로 부모 디렉터리를 고르고 이름 칸을 붙인다. 둘러보기를 끈 러너는 직접 입력만.
- 에이전트 폼: 부모가 `isGit` 이고 잠금이 없을 때 「작업 위치」 라디오(「이 프로젝트」 기본 / 「새 워크트리」). 새 워크트리면 만들기 = `useCreateWorktree` → 새 프로젝트 id 로 에이전트 만들기. 에이전트 실패면 워크트리는 남기고 사유.
- 보관: 워크트리 보관 확인 대화상자에 「무시된 파일(node_modules 등)은 함께 지워집니다」 한 줄(W7). 409 면 그 줄에 사유와 「폴더를 남기고 보관」 단추(W12). 러너 폐기면 처음부터 그 단추만.

- [ ] **Step 1: 실패하는 시험** — `worktree.test.tsx`: `dialog prefills .worktrees/<slug> and dodok/<slug>`, `change location via direct input`, `browse disabled runner → direct input only`, `server 400 reason shows copy`, `lock reasons: offline / no capability / not git / is worktree`, `archive 409 dirty shows reason and keep-folder button`, `keep-folder archives with keepFolder:true`, `revoked runner shows keep-folder only`. `tree.test.ts`: `worktree nests under parent`. `agentsRunner.test.tsx`: `new worktree option creates worktree then agent`, `agent failure keeps worktree and shows reason`, `option hidden for non-git project`. `runners.test.tsx`: 기존 픽스처에 새 필드.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/web test -- runners connections agents`.
- [ ] **Step 3: 구현** — 위 Interfaces.
- [ ] **Step 4: 통과 확인** — 웹 시험 혼자 전체, typecheck·lint·fmt. 실행 수.
- [ ] **Step 5: 브라우저 확인(워커)** — dev:fake + 웹(워크트리 전용 포트). 「dev-fake」 러너의 git 프로젝트에서 워크트리 만들기(기본값) → 트리에 부모 아래 줄, 에이전트 만들기 「새 워크트리」로 한 번 더, 보관 409(가짜 러너가 dirty 를 돌려줄 대본 키) → 「폴더를 남기고 보관」. 「dev-fake 제한」 러너에서 단추 잠금 사유. 390·1280px. 연 탭·서버는 닫는다.
- [ ] **Step 6: 커밋** — `feat(web): create and archive runner worktrees`

### Task 5: 실제 러너로 손 확인·문서

**Files:**
- Modify: `docs/manual/user-guide.md`(러너 프로젝트 절), `docs/guides/live-smoke.md`(런 0회 하네스 절에 워크트리 한 단계), `docs/guides/plan.md`(8장 완료 줄)

- [ ] **Step 1: 하네스** — 실제 러너(이 브랜치의 `pack:runner` tgz) + 서버 dev(실제 어댑터)로 임시 git 저장소를 프로젝트로 더하고: 워크트리 만들기(기본) → 러너 머신에서 `git worktree list`·`.git/info/exclude`·`git status`(깨끗) 확인 → 그 워크트리의 에이전트로 런 0회 하네스 런 하나(작업 디렉터리가 워크트리인지 하네스 로그로) → 파일 하나 만들고 보관 → 409 → 지우고 보관 → 폴더 없음·브랜치 남음. 찍은 값을 보고에.
- [ ] **Step 2: 문서** — 세 문서. `---` 앞 빈 줄·표 줄을 눈으로.
- [ ] **Step 3: 커밋** — `docs: runner worktrees`

러너 0.7.0 판 올리기·태그는 병합 뒤 조율자.
