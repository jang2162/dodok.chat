# 러너 일반화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나. 태스크마다 main 에 병합해도 테스트가 초록이어야 한다.

**Goal:** 사람 머신의 `dodok-runner` 는 허용 루트·프로그램·권한 상한(천장)만 쥐고, 그 루트 안의 프로젝트와 에이전트(프로그램·모델·권한·도구·지시)는 dodok 앱에서 더한다. 이번 드라이버는 Claude Code 하나다.

**Architecture:** 제공자는 `openclaw`·`runner` 둘이고 러너 에이전트의 프로그램은 `agents.program` 이다(태스크 1 — 이름만 바꾼다). 러너는 무상태다 — 서버가 `run.start` 에 에이전트 정의를 통째로 싣고 러너가 런마다 천장을 검사한다. 프로젝트는 `(rootId, relPath)` 로만 저장해 호스트 경로가 서버에 가지 않는다. 계약은 shared 에 V2 를 **나란히** 더해 러너(태스크 2)와 서버(태스크 3)를 따로 옮기고, 태스크 3 이 V1 을 지운다.

**Tech Stack:** Fastify 5 · Socket.IO 4.8 · drizzle-orm 0.45 + better-sqlite3 · zod 4 · React 19 + TanStack Router/Query · Claude Agent SDK(claude-runner, 정확 핀 그대로). **새 의존성 없음.**

**Spec:** `docs/superpowers/specs/2026-10-25-runner-generalization-design.md` — 결정 0장, 천장 2장, 계약 3장, 드라이버 4장, 데이터 5장, 권한 6장, 웹 7장, 오류 8장, 검증 9장, 완료 기준 10장. 바꾸지 않는 러너 동작(승인·`mcp__dodok__post`·경로 가림·env 허용 목록·끊김)은 `docs/superpowers/specs/2026-09-27-claude-runner-design.md` 「구현과 맞춘 것」 장. 채널 세션·DM 스펙의 「구현과 맞춘 것」 장이 지금 코드다. **태스크를 시작하기 전에 스펙의 해당 장을 읽는다.** 진입점 지도: `/Users/jang2162/IdeaProjects/dodok.chat/.superpowers/sdd/2026-10-29-runner-generalization/entrypoints.md`(git 무시 — 메인 체크아웃에만 있다).

## Global Constraints

- 제공자 enum 은 `openclaw`·`runner` 둘(`codex`·`hermes`·`claude` 값은 걷는다). 프로그램 enum `RunnerProgram = "claude" | "codex" | "opencode"`(shared) — 이번에 드라이버가 있는 것은 `claude` 뿐이다. 운영 비용 집계·`USAGE_TRUSTED`(지금 `ops/summary.ts USAGE_TRUSTED_PROVIDERS`)는 프로그램으로 가른다(`claude` 만 신뢰).
- 권한 모드 넷, 순서 `plan` < `dontAsk` < `default` < `acceptEdits`(shared `RUNNER_PERMISSION_MODES` 배열 순서가 정본, `permissionModeRank`). `bypassPermissions` 는 어느 스키마도 받지 않는다.
- `relPath`(shared `RunnerRelPath`): `/` 구분 상대 경로, 빈 문자열 = 루트 자신, `..`·`.`·빈 성분·NUL·`\`·앞 `/` 거절, 512자 이하. 서버·러너 둘 다 같은 스키마. 루트 id `[a-z0-9-]{1,32}`.
- **호스트 절대 경로는 서버로 가는 어떤 프레임·DB 행·로그·화면에도 없다** — 러너가 hello 로 알리는 루트는 `{ id, label }` 뿐, 오류 `message` 도 항목 이름만(완료 기준 4).
- 새 오류 코드 `RUNNER_CEILING`(카드 + 「다시 실행」). 카드 문구 그대로: 「러너 설정이 이 에이전트를 허용하지 않습니다(<항목>) — 러너 머신의 설정을 확인하세요」. 항목 이름은 `root`·`path`·`program`·`permissionMode`·`allowedTools` 중 하나. `PROVIDER_AUTH` 문구의 「Claude」 는 프로그램 이름으로.
- 러너 옛 설정의 `agents` 키 거절 문구 그대로: 「에이전트는 이제 앱에서 만듭니다 — 설정에서 agents 를 지우고 roots 를 적으세요」.
- `RUNNER_PROTOCOL` 은 2(태스크 2 가 V2 상수로 더하고 태스크 3 이 1 을 지운다). 옛 러너는 `PROTOCOL_MISMATCH`.
- 권한: 러너 토큰 발급·다시 발급·폐기는 owner, 러너 목록·둘러보기·프로젝트·러너 에이전트는 admin 이상(서버가 요청마다 판정). 둘러보기는 사용자당 분당 60(`LIMITS.runnerBrowsePerMin`, `apps/server/src/modules/ops/limits.ts` 한곳) + 운영 로그 한 줄(사용자·러너 id·루트 id — `relPath` 원문 없음). 새 경로는 `apps/server/test/roles.matrix.test.ts` 와 팀 스펙(`docs/superpowers/specs/2026-09-26-team-members-design.md`) 「역할과 권한」 표에.
- 제어 도구는 러너 구성을 바꾸지 못한다: `discover_agents`·`register_agent` 는 OpenClaw 만, `update_agent` 는 러너 에이전트의 `name`·`avatarUrl` 만(그 밖의 필드는 `VALIDATION`), 러너 프로젝트·둘러보기 도구는 두지 않는다.
- 외부 입력은 경계에서 Zod 파싱. shared 는 Node 전용 API 금지. Claude Agent SDK 는 `packages/claude-runner` 의 `sdk.ts`(옮기면 드라이버 안의 한 파일)만 import 한다.
- 포트 5173·3000 금지(사용자 인스턴스 3100·5180 도) — 워커는 브리프가 주는 포트. 프로세스는 자기 PID 로만, `pkill` 금지. **모델 런 없음.**
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프. 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`. 문서·주석을 쓰기 전에 `docs/guideline/base/03-comments.md`·`04-citation.md` 를 읽는다.
- 끝내기 검사: 루트 `pnpm test`(**다른 검사와 동시에 돌리지 않는다**) → `pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 자기 실행 출력에서 패키지별로(0개는 통과가 아니다). 웹을 바꿨으면 `pnpm -F @dodok/web build`, 서버를 바꿨으면 `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`, 러너를 바꿨으면 `pnpm -F @dodok/claude-runner pack:runner`.

## 계획 판정 (스펙과 맞춘 것)

조사한 코드에 맞춰 스펙을 구체화한 것. 태스크 7 이 스펙에 「구현과 맞춘 것」 장을 만들어 옮긴다.

- **PR1 — 에이전트 지시는 서버가 틀을 입힌다(스펙 3장 표의 `run.start.agent.instructions` 를 싣지 않는다).** runner-adapter 가 `buildChannelRulesAppend` 에 `agentInstructions`(= `agents.base_prompt`)를 넘기고, shared 가 채널 규칙 틀 **앞**에 `<agent-instructions>` 틀을 같은 이스케이프 함수로 붙인다. 채널 규칙을 서버가 짓는 지금 구조와 같은 자리여서 다음 드라이버도 공짜로 받는다. 비어 있으면 틀이 없다.
- **PR2 — 지시 리비전.** `agents.instructions_revision`(정수, `base_prompt` 가 바뀔 때만 +1)과 `agent_sessions.instructions_revision_at_start`. `renewSessionOnPromptChange` 는 채널 리비전 **또는** 지시 리비전이 다르면 러너 세션을 새로 연다(ADR 0007 「규칙이 바뀐 뒤 이어 간 세션」과 같은 까닭).
- **PR3 — 프로그램 능력은 hello 의 `programs[].capabilities`** (`serverSessionIds`·`approvals`·`images`·`interrupt`·`mcpTools`·`costs` 문자열). 어댑터 전체 `AdapterCapabilities.serverSessionIds` 대신 `capabilitiesFor(agent)` 가 그 러너·그 프로그램의 값을 돌려준다. 러너가 끊겨 있으면 런은 어차피 `ADAPTER_UNAVAILABLE`. `serverSessionIds` 가 없는 프로그램은 `providerSessionId` 없이 보내고 `run.session` 으로 받은 값을 세션 행에 저장한다(이번 드라이버는 쓰지 않지만 서버 갈래와 테스트는 가짜 러너로 둔다).
- **PR4 — 러너 에이전트 필드.** `agents.program`(태스크 1, 러너면 NOT NULL — 서비스가 지킨다)·`runner_project_id`(nullable FK — 「보관되지 않은 러너 에이전트는 프로젝트가 있다」는 서비스 불변)·`model`(nullable)·`permission_mode`(NOT NULL 기본 `default`)·`allowed_tools_json`(nullable = 상한 안에서 SDK 기본)·`disallowed_tools_json`(NOT NULL `[]`). 지시는 지금 `base_prompt` 를 쓴다(새 열 없음). `providerAgentId` 는 서버가 `r-` + 소문자 hex 10 으로 짓는다(워크스페이스 유일, 부딪히면 다시 짓기).
- **PR5 — 계약은 V2 를 나란히 더한다.** 태스크 2 는 shared 에 `RunnerHelloV2`·`RunnerRunStartV2`·새 프레임을 더하고 claude-runner 만 옮긴다(태스크 2·3 사이 실제 러너는 서버에 `PROTOCOL_MISMATCH` — 사용자가 없어 받아들인다, 테스트는 양쪽 다 초록). 태스크 3 이 runner-adapter·가짜 러너를 옮기고 V1 이름을 지운 뒤 V2 를 원래 이름(`RunnerHello` 등)으로 되돌린다.
- **PR6 — 마이그레이션 둘.** `0030_*`(태스크 1): `agents.provider` `claude`→`runner`, `program` 열(러너면 `claude`), 부분 유일 색인 `agents_claude_ws_agent` → `agents_runner_ws_agent`. `0031_*`(태스크 3): `runner_projects`, PR4·PR2 열, 그리고 **프로젝트가 없는 러너 에이전트를 모두 보관**(`archived_at = now`) — 메시지·런 작성자로 남고 화면은 「프로젝트가 없어 되살릴 수 없습니다 — 새로 만드세요」, 되살리기 REST 는 `VALIDATION`. 둘 다 `pnpm -F @dodok/server db:generate` 로 만들고 데이터 옮기기는 생성 SQL 에 손으로 더한 뒤 다시 generate 해 「No schema changes」.
- **PR7 — 토큰 다시 발급.** `POST /api/v1/setup/runner-tokens/:id/reissue`(owner) → `{ token }`(원문 한 번). 같은 행의 해시·접두사만 바꾸고 그 토큰의 러너 연결을 지금 폐기와 같은 순서로 끊는다(러너는 종료 2). 프로젝트·에이전트·세션 행은 그대로. 응답은 발급과 같은 모양(`ReissueRunnerTokenResult` — `token`·`record`·`runnerConfig`), 폐기한 러너는 409(태스크 4).
- **PR11 — 러너 에이전트 정의(`Agent.runnerAgent` — 모델·권한·도구·프로젝트 id)는 admin 이상에게만 싣는다**(REST·wire·제어 `list_agents`, 스펙 6장 「보기는 admin 이상」 — 태스크 4 리뷰 L2, 메인 판정). 러너 에이전트 PATCH 에 `program`·`runnerProjectId` 가 오면 조용히 버리지 않고 400(L4).
- **PR10 — 러너 에이전트의 프로그램·프로젝트는 PATCH 로 바꾸지 않는다(스펙 6장 「고치기(프로그램…)」를 좁힘, 메인 세션 판정).** 프로젝트는 「다른 러너로 옮기기」(PR8) 하나로만 바뀌어 프로젝트와 에이전트 토큰이 어긋나지 않는다(태스크 3 리뷰 D1). 프로그램을 바꾸면 세션 전사가 다른 프로그램 것이 되므로 새 에이전트를 만든다.
- **PR8 — 프로젝트 옮기기.** `POST /api/v1/runner-projects/:id/move { runnerId }`(admin 이상): 옮길 러너가 붙어 있고 `project.check` 가 `ok` 일 때만, 프로젝트와 그 에이전트의 `runner_token_id` 를 함께 바꾸고 그 에이전트들의 `agent_sessions.provider_session_id` 를 비운다. 같은 `(러너, 루트, relPath)` 의 보관 안 된 프로젝트가 이미 있으면 `CONFLICT`. 대상 러너의 천장 밖 에이전트(보관 안 된 것 — program·권한·도구)가 하나라도 있으면 400 `VALIDATION`(`details.agentIds`)이고 아무것도 옮기지 않는다(태스크 4 리뷰 L1 — 메인 판정). 보관한 에이전트도 함께 옮긴다.
- **PR9 — 걷는 것.** `GET /api/v1/agents/discover?provider=claude` 의 러너 갈래(OpenClaw 는 그대로), `PUT /setup/runner-tokens/:id/agents/:agentId`(「이 러너로 묶기」), `modules/runners/bindings.ts`, runner-adapter 의 `claimUnbound`·`conflicts`·`unboundOwned`, 웹 `useBindRunnerAgent`·`AgentConflict`, `SetupStatus.runners[].agents`. 러너 에이전트는 만들 때부터 그 러너 토큰에 묶인다.

## Review Focus

1. **루트 안의 심볼릭 링크가 루트 밖을 가리킴** — `fs.list` 에 나오지 않고, 그 경로로 `project.check` 는 `outside_root`, 이미 저장된 프로젝트의 디렉터리가 나중에 링크로 바뀌면 `run.start` 가 `RUNNER_CEILING(path)`. → 태스크 2.
2. **머신 주인이 로컬 설정의 루트 id 를 바꾸거나 지움** — 그 루트의 프로젝트는 화면에 「루트 없음」, 멘션하면 서버가 죽지 않고 `RUNNER_CEILING(root)` 카드, 루트를 되돌리면 다음 런이 돈다. → 태스크 2(러너)·3(카드)·5(화면).
3. **`acceptEdits` 로 만든 에이전트 뒤에 머신 주인이 `maxPermissionMode` 를 `default` 로 낮춤** — 다음 런은 `RUNNER_CEILING(permissionMode)` 카드, 에이전트 고치기 화면은 상한 위 모드를 고를 수 없고 서버 PATCH 도 붙어 있는 러너의 상한 위면 `VALIDATION`. → 태스크 2·3·4.
4. **지시에 `</agent-instructions>`·`<channel-rules>`·줄바꿈 뒤 `---` 를 넣음** — 틀이 깨지지 않는다(이스케이프), 다음 런에 실리고 러너 세션이 새로 열린다. → 태스크 3.
5. **런이 도는 중에 owner 가 그 러너 토큰을 다시 발급** — 옛 연결이 끊기고 열린 런은 `ADAPTER_UNAVAILABLE` + 「다시 실행」, 프로젝트·에이전트는 남고 새 토큰으로 러너를 다시 띄우면 「다시 실행」이 돈다. → 태스크 4.

각 줄의 테스트는 해당 태스크의 단계에 들어 있다.

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| shared `domain/index.ts`·`adapter/index.ts`·`wire/index.ts`·`setup/index.ts`·`control/{rest-bodies,tools}.ts`, 서버·어댑터·웹·dev:fake 의 `claude` 리터럴, `drizzle/0030_*` | 1 | 제공자 `runner` + `agents.program` |
| shared `runner/index.ts`(V2 계약·`RunnerRelPath`·`RunnerProgram`·권한 순서)·`common.ts`(`RUNNER_CEILING`) | 2 | 계약 V2 |
| `packages/claude-runner/src/{config,connection,ceiling,fs-browse}.ts`·`driver.ts`·`sink.ts`·`drivers/claude/{index,run,sdk,stream-map,approvals}.ts`(옮김) | 2 | 천장·hello V2·둘러보기·드라이버 |
| `packages/runner-adapter/src/*`·`apps/server/test/fakes/fake-runner.ts`·shared `runner/prompt.ts`(지시 틀)·`apps/server/src/{app.ts,adapters/connection.ts}`·`modules/{runners/projects,sessions/service,runs/orchestrator,agents/service}.ts`·`drizzle/0031_*` | 3 | 서버 런타임·데이터 |
| `apps/server/src/modules/runners/{routes,projects.routes,tokens}.ts`·`agents/{routes,actions}.ts`·`auth/policies.ts`·`control/handlers.ts`·`ops/limits.ts` | 4 | REST·권한·제어 도구 |
| `apps/web/src/features/runners/*`(새)·`features/settings-shell/tabs.ts`·`app/router.tsx`·`features/agents/*`·`features/setup/RunnerSection.tsx` | 5 | 웹 |
| `apps/server/scripts/dev-fake.ts`·`apps/server/test/integration/runner-projects.test.ts`(새) | 6 | 가짜 환경·통합·브라우저 |
| 문서 | 7 | 실연·문서 |

---

### Task 1: 제공자 `runner` 와 `agents.program` (동작 변화 없음)

**Files:** 진입점 지도 6절의 23개 파일과 그 테스트, `apps/server/drizzle/0030_*`. 타입 이름 `ClaudeAdapterStatus`·`ClaudeSetupDetail` 등은 `Runner…` 로, 캐시 키 `["adapter","claude"]`·`qk.discoverOf("claude")` 는 `runner` 로.

**Interfaces:**
- Produces: `AgentProvider = "openclaw" | "runner"`, `Agent.program: RunnerProgram | null`(러너면 값, OpenClaw 면 null), `RunnerProgram` 은 이 태스크가 shared `domain/index.ts` 에 둔다(태스크 2 가 `runner/index.ts` 에서 다시 내보낸다). 이름표 `PROVIDER_NAME.runner = "러너"`, 프로그램 이름표 `PROGRAM_NAME = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" }`(웹 `providerLabels.ts`).
  - 운영 wire 필드 `OpsRunsSummary.usageTrustedProviders` → `usageTrustedPrograms: RunnerProgram[]`, `OpsRouteContext.programsInUse`(태스크 1 이 이름을 바꿨다 — 태스크 5·7 이 이 이름을 쓴다).

- [ ] **Step 1: 실패하는 테스트.** `apps/server/test/db.test.ts` 「0030 뒤 claude 에이전트는 provider runner·program claude, 부분 유일 색인은 runner 행에 걸린다」. `ops.summary` 테스트에 「USAGE_TRUSTED 는 program claude 런만」.
- [ ] **Step 2: 마이그레이션·스키마·shared enum.** PR6 의 0030.
- [ ] **Step 3: 리터럴을 모두 옮긴다.** 다 옮긴 뒤 `grep -rnE '"claude"' apps packages --include='*.ts' --include='*.tsx'` 로 남은 줄이 프로그램 값(`program: "claude"`·이름표·SDK 판본 이름)뿐인지 표본을 열어 본다. 보고에 전·후 수를 적는다.
- [ ] **Step 4: 끝내기 검사**(웹 빌드·서버 번들 포함) → 커밋 `refactor: name the runner provider runner and record the program`.

### Task 2: 계약 V2 와 러너(천장·둘러보기·드라이버)

**Files:** 위 표의 태스크 2 줄 + 서버 `http/errors.ts`(`RUNNER_CEILING` 상태)·`modules/setup/llms.ts` 의 러너 설정 예시와 그 대조 시험 `test/setup.llms.test.ts`. 테스트: `packages/shared/test/runner-v2.test.ts`(새), `packages/claude-runner/test/{config,ceiling,fs-browse,connection}.test.ts`, 옮긴 드라이버 테스트(지금 러너 테스트 전부).

**Interfaces:**
- Produces (shared `runner/index.ts`, PR5 이름):
  - `RUNNER_PROTOCOL_V2 = 2`, `RunnerRootId`, `RunnerRelPath`, `RUNNER_PERMISSION_MODES = ["plan","dontAsk","default","acceptEdits"] as const`, `RunnerPermissionMode`, `permissionModeRank(m): number`, `RunnerProgramCapability`(PR3 의 여섯).
  - `RunnerHelloV2` = 지금 hello 에서 `agents`·`claudeCodeVersion` 을 빼고 `roots: { id, label }[]`(≤16), `browse: boolean`, `programs: { program, available, version?, auth: "ok"|"missing"|"unknown", reason?, capabilities, ceiling: { maxPermissionMode, allowedToolsCeiling: string[] | null } }[]`.
  - 서버 → 러너 ack 프레임 `fs.list { rootId, relPath }` → `{ ok: true, entries: { name, isGitRepo }[], truncated } | { ok: false, code: "FORBIDDEN" | "NOT_FOUND" }`, `project.check { rootId, relPath }` → `{ ok: true, isGitRepo } | { ok: false, reason: "root_missing"|"not_found"|"not_directory"|"outside_root" }`.
  - `RunnerRunStartV2` = 지금 것 + `agent: { program, project: { rootId, relPath }, model: string|null, permissionMode, allowedTools: string[]|null, disallowedTools: string[] }`, `providerSessionId` 는 선택.
  - 러너 → 서버 `run.session { runId, providerSessionId }`.
  - `ErrorCode` 에 `RUNNER_CEILING`.
- Produces (claude-runner):
  - `checkCeiling(cfg: ResolvedRunnerConfig, agent: RunnerRunStartV2["agent"]): { ok: true; workdir: string } | { ok: false; item: "root"|"path"|"program"|"permissionMode"|"allowedTools" }` — `realpath` 로 루트 안 디렉터리인지, 프로그램이 켜져 있고 `available`, 권한 순서, `allowedTools ⊆ allowedToolsCeiling`.
  - `ProgramDriver`(스펙 4장 그대로, `driver.ts`)·`RunSink`(`sink.ts` — 경로 가림을 맡는다)·`claudeDriver`(`drivers/claude/index.ts`).

- [ ] **Step 1: 실패하는 테스트 — shared.** `RunnerRelPath` 받음(`""`·`a/b`)·거절(`..`·`a//b`·`/a`·`a\b`·NUL·513자), 권한 순서, `RunnerHelloV2` 에 `agents` 가 있으면 거절(strict).
- [ ] **Step 2: shared 구현.**
- [ ] **Step 3: 실패하는 테스트 — 설정(스펙 2장).** 예시 설정이 풀리고 `roots[].path` 가 `realpath` 로, 옛 `agents` 키는 Global Constraints 문구로 거절, `bypassPermissions` 거절, 루트 id 중복·없는 디렉터리 거절, `programs` 에 없는 프로그램은 꺼짐, `disallowedTools` 가 `RUNNER_DISALLOWED_TOOLS` 와 합쳐짐.
- [ ] **Step 4: 실패하는 테스트 — 천장(Review Focus 1·2·3).** `checkCeiling` 의 다섯 항목 각각, `..` 꼴은 스키마에서, 루트 안 링크가 밖을 가리키면 `path`, 지운 루트 id 면 `root`.
- [ ] **Step 5: 실패하는 테스트 — 둘러보기.** `fs.list` 는 디렉터리만·`.` 시작 제외·이름순 500개 + `truncated`·루트 밖 링크 제외·`isGitRepo`(`.git` 있음)·`browse: false` 면 `FORBIDDEN`. `project.check` 네 사유.
- [ ] **Step 6: 실패하는 테스트 — hello·run.start.** hello 에 `roots`·`browse`·`programs`(claude 의 `detect` 결과)가 있고 **직렬화한 hello 어디에도 루트의 절대 경로 문자열이 없다**. `run.start` 가 천장에 걸리면 ack `dispatch` 뒤 `run.error { code: "RUNNER_CEILING", message: <항목> }`.
- [ ] **Step 7: 구현** — `config.ts`·`ceiling.ts`·`fs-browse.ts`·`connection.ts`. 드라이버로 옮기기: `run.ts`·`sdk.ts`·`stream-map.ts`·`approvals.ts` 를 `drivers/claude/` 로, `buildQueryOptions` 는 `RunSpec`(작업 디렉터리·권한·도구·모델은 `run.start.agent` 에서)을 받는다. 마스커·`outbound.post`·`run.*` 내보내기는 `sink.ts`. `PROVIDER_AUTH` 문구는 프로그램 이름표로.
- [ ] **Step 8: 지금 러너 테스트 전부가 옮긴 뒤에도 통과**(파일 이동만 하고 단언은 그대로 — 바꾼 단언은 보고에 이유와 함께).
- [ ] **Step 9: 끝내기 검사**(러너 pack 포함) → 커밋 둘 `feat(shared): add the v2 runner contract`, `feat(runner): hold only a ceiling and run agents the server defines`.

### Task 3: 서버 런타임 — hello V2·에이전트 정의·지시·데이터

**Files:** 위 표의 태스크 3 줄. 테스트: `packages/runner-adapter/test/*`, `apps/server/test/{runner-projects.service,sessions.renew,orchestrator.runner}.test.ts`, `db.test.ts`, `packages/claude-runner/test/adapter-integration.test.ts`(태스크 2 가 `describe.skip` 한 왕복 시험 7개를 어댑터 V2 기대값으로 되살리고 「V1 어댑터 PROTOCOL_MISMATCH」 시험을 걷는다).

**Interfaces:**
- Consumes: 태스크 2 의 V2 계약.
- Produces:
  - runner-adapter: `RunnerRegistry` 가 러너마다 hello V2(`roots`·`browse`·`programs`)를 메모리에. `fsList(tokenId, { rootId, relPath })`·`projectCheck(tokenId, …)`(연결 없으면 `AppError("ADAPTER_UNAVAILABLE")`, ack 제한시간 10초), `runnerInfo(tokenId): RunnerLive | null`, `capabilitiesFor(agent)`(PR3).
  - 서버 `modules/runners/projects.ts`: `createProject(db, { workspaceId, runnerTokenId, rootId, relPath, label?, createdBy })`(label 기본 = `relPath` 마지막 성분, 빈 `relPath` 면 루트 라벨), `listProjects(db, runnerTokenId)`, `renameProject`·`archiveProject`. 러너 에이전트 만들기는 `agents/service.ts createAgent` 의 러너 갈래(PR4 필드, `providerAgentId` 생성).
  - shared `buildChannelRulesAppend({ …, agentInstructions? })`(PR1).

- [ ] **Step 1: 마이그레이션 0031**(PR6·PR2·PR4) → `db.test.ts` 「0031 뒤 프로젝트 없는 러너 에이전트는 보관됨」.
- [ ] **Step 2: 실패하는 테스트 — 어댑터.** hello V2 를 받고 `PROTOCOL 1` 은 `PROTOCOL_MISMATCH`, `send` 가 `run.start.agent` 를 에이전트 행과 프로젝트 행 그대로 싣는다, `fsList`·`projectCheck` 왕복과 끊긴 러너 `ADAPTER_UNAVAILABLE`, `run.session` 이 세션 행에 저장(`serverSessionIds` 없는 프로그램 — 가짜 러너가 `codex` 를 그렇게 알린다), `RUNNER_CEILING` 은 그대로 런 오류.
  서버는 `run.start.agent` 를 shared `RunnerRunAgent` 그대로의 스키마로 만든다 — 러너는 runId 를 못 읽는 형식 오류면 drop 하므로(카드 없음) 서버 쪽 상한이 넓으면 런이 흔적 없이 사라진다(태스크 2 리뷰 M3).
- [ ] **Step 3: 구현** — runner-adapter·가짜 러너를 V2 로, V1 이름 지우기(PR5), `claimUnbound`·`conflicts` 걷기(PR9 의 어댑터 몫).
- [ ] **Step 4: 실패하는 테스트 — 지시(Review Focus 4).** shared: 지시 틀이 채널 규칙 앞, `</agent-instructions>`·`<channel-rules>` 를 넣어도 틀이 하나씩, 빈 지시면 틀 없음. 서버: `base_prompt` 를 바꾸면 `instructions_revision` +1, 다음 러너 런이 새 세션(`providerSessionId` 새 값)이고 append 에 새 지시가 있다. 이름만 바꾸면 리비전 그대로.
- [ ] **Step 5: 구현** — PR1·PR2(`sessions/service.ts renewSessionOnPromptChange`·`ensureSession`).
- [ ] **Step 6: 실패하는 테스트 — 카드(Review Focus 2·3).** 가짜 러너가 `RUNNER_CEILING` 을 내면 채널에 Global Constraints 문구 카드 + 「다시 실행」, 루트를 되돌리고 「다시 실행」하면 돈다.
- [ ] **Step 7: 구현** — `orchestrator.ts` `NOTIFY_CODES`·`runErrorBody`(「다시 실행」을 막는 `NO_RETRY_CODES` 에는 넣지 않는다).
- [ ] **Step 8: 호스트 경로 검사.** 통합 테스트 하나가 가짜 러너의 루트 경로를 고유 문자열(`/tmp/dodok-secret-root-<uuid>`)로 두고 프로젝트·에이전트·런 하나를 돈 뒤 DB 파일 바이트와 서버 로그 출력에 그 문자열이 없음을 본다(완료 기준 4).
- [ ] **Step 8a: 러너 hello 거절 문구(태스크 2 보고 7-5).** 서버가 hello 거절 ack 와 함께 끊으면 러너 `connection.ts fatal()` 이 두 번 불려 「서버가 끊었다」가 먼저 찍힌다 — 이미 끝나는 중이면 사유만 찍고 돌아가게 해 첫 문구가 판본 불일치가 되게 한다(테스트로 고정).
- [ ] **Step 8c: 러너 `invalidFields` 이름 꼴 거르기 시험(태스크 2 재리뷰 N2).** 경로에 임의 문자열 키가 오르는 Zod 이슈를 넘겨 그 성분이 `?` 로 바뀌는지 — 지금은 `FIELD_NAME` 검사를 빼도 통과한다.
- [ ] **Step 8b: 남은 옛 이름(태스크 1 리뷰 L1).** 제공자 뜻의 `claude` 가 남은 주석·테스트 이름 — `apps/web/src/api/queries.ts`(러너 줄 고르기 주석)·`apps/server/scripts/dev-fake.ts` 머리 주석·`packages/openclaw-adapter/src/fake-adapter.ts`(「claude 흉내」)·`packages/shared/src/setup/index.ts`(「claude 변형」)·`apps/web/src/realtime/handlers.test.ts`·`apps/web/src/features/ops/opsPage.test.tsx`·`apps/server/test/agents.provider.test.ts` 의 테스트 이름 — 를 `runner` 로.
- [ ] **Step 9: 끝내기 검사**(서버 번들 포함) → 커밋 둘 `feat(runner-adapter): speak the v2 runner contract`, `feat(server): run runner agents from their project and instructions`.

### Task 4: REST·권한·제어 도구

**Files:** 위 표의 태스크 4 줄. 테스트: `apps/server/test/runners.routes.test.ts`·`runner-projects.routes.test.ts`(새)·`roles.matrix.test.ts`·`control.*` 기존 파일.

**Interfaces:**
- Consumes: 태스크 3 의 `fsList`·`projectCheck`·`runnerInfo`·`createProject`.
- Produces (shared 본문·응답 스키마, `control/rest-bodies.ts` 옆):
  - `GET /api/v1/runners`(admin) → `{ runners: RunnerSummary[] }` = `{ id, label, connected, revoked, runnerVersion: string|null, browse: boolean|null, roots: { id, label }[], programs: <hello 의 programs>, projectCount }`(끊김이면 `null`·`[]` — 스펙 5장 「마지막으로 알린 내용 없이」).
  - `GET /api/v1/runners/:id/fs?rootId&relPath`(admin, `LIMITS.runnerBrowsePerMin`) → `fs.list` 결과. `browse: false` → 403 `FORBIDDEN`. 어댑터 `fsList`·`projectCheck` 의 `AdapterError` 코드는 그대로 API 오류 코드로(`ADAPTER_UNAVAILABLE` 503·`TIMEOUT`·`VALIDATION` 400, `INTERNAL` 500 — 태스크 3 보고).
  - `GET /api/v1/runners/:id/projects` → `{ projects: RunnerProject[] }`(`{ id, runnerId, rootId, rootLabel: string|null, relPath, label, agentCount, archivedAt }` — `rootLabel` null = 루트 없음 또는 끊김). `POST /api/v1/runners/:id/projects { rootId, relPath, label? }`(먼저 `project.check`, 실패는 400 `VALIDATION` + `details.reason`, 같은 자리 중복 409 `CONFLICT`). `PATCH /api/v1/runner-projects/:id { label }`·`POST …/archive`·`POST …/check` → `project.check` 결과·`POST …/move`(PR8).
  - `POST /api/v1/agents` 러너 갈래 `{ provider: "runner", runnerProjectId, program, name, handle, model?, permissionMode, allowedTools?, basePrompt?, dmAccess? }` — 러너가 붙어 있어야 하고 프로그램이 `available`, `permissionMode` 가 상한 이하, `allowedTools` 가 상한 부분집합(아니면 `VALIDATION` + 항목 이름), 보관된 프로젝트면 `VALIDATION`. `PATCH /api/v1/agents/:id` 도 같은 필드·같은 검사(러너가 끊겨 있으면 상한 검사는 건너뛰고 런에서 러너가 거절한다).
  - `POST /api/v1/setup/runner-tokens/:id/reissue`(PR7).

- [ ] **Step 1: 실패하는 테스트 — 경로들.** 위 Produces 의 성공·실패 꼴, 둘러보기 61번째 요청 429, 운영 로그 줄에 `relPath` 가 없음, 끊긴 러너의 둘러보기·프로젝트 더하기 `ADAPTER_UNAVAILABLE`, 프로젝트 없는(0031 이 보관한) 러너 에이전트 되살리기 `VALIDATION`, 보관한 프로젝트의 기존 에이전트는 런이 돈다(스펙 8장).
- [ ] **Step 2: 구현.** 러너 에이전트 본문의 `allowedTools`·`disallowedTools`·`model`·`permissionMode` 는 shared `RunnerRunAgent` 의 필드 스키마를 다시 쓴다(따로 정의 금지 — 태스크 2 리뷰). PATCH 는 `agents/service.ts updateAgent` 에 러너 필드를 더하고 `createAgent` 의 같은 필드 거르기를 쓴다(OpenClaw 에이전트면 `VALIDATION` — 태스크 3 보고). 태스크 3 의 서비스 이름: `modules/runners/projects.ts` `createProject`·`listProjects`·`getProject`·`renameProject`·`archiveProject`(`project.check` 는 호출자 몫), 어댑터 `runnerInfo`·`fsList`·`projectCheck`, 시험 도우미 `createRunnerAgentForTest`·`insertRunnerToken`.
- [ ] **Step 2b: 태스크 3 리뷰 넘김.** ① **D1(중간)** — `PUT /setup/runner-tokens/:id/agents/:agentId` 를 걷기 **전에** `runners/definition.ts runnerAgentDefinition` 이 `runner_projects.runner_token_id` 도 그 토큰과 같은지 본다(에이전트 토큰만 바꾸면 다른 러너가 옛 러너의 `(rootId, relPath)` 로 돈다). 재현: 러너 a 의 프로젝트를 가진 에이전트를 `bindRunnerToken` 으로 b 에 묶으면 b 로 그 프로젝트가 간다 → `toBeNull()`. PR8 옮기기는 프로젝트·에이전트 토큰을 한 트랜잭션에서 함께 바꾼다. ② **L1** — `codex`(serverSessionIds 없음) 에이전트의 지시를 바꾸면 다음 런이 `providerSessionId` 없이 가고 갱신 알림이 붙는다(세션 갱신 조건 `promptEveryRun` 을 지키는 시험). ③ **L2** — 다른 연결의 `run_session` 은 저장하지 않는다(오케스트레이터 연결 대조 시험). ④ **L3** — `ensureProviderSessionId` 는 `serverSessionIds` 프로그램이면 저장된 값이 UUID 가 아닐 때 새로 짓는다(Claude 드라이버 VALIDATION 은 카드가 없어 런이 소리 없이 닫힌다). ⑤ `apps/server/test/connection-routing.test.ts` 의 `claimUnbound` 주석은 묶기와 함께 걷는다.
- [ ] **Step 3: 실패하는 테스트 — 다시 발급(Review Focus 5).** 열린 런이 있는 러너의 토큰을 다시 발급 → 옛 토큰 핸드셰이크 401, 옛 소켓 끊김, 열린 런 `ADAPTER_UNAVAILABLE` 카드 + 「다시 실행」, 프로젝트·에이전트 행 그대로, 새 토큰으로 붙은 가짜 러너에서 「다시 실행」이 돈다. 옮기기(PR8) 세 꼴(끊긴 대상·check 실패·성공 뒤 세션 id 비움).
- [ ] **Step 4: 구현** — PR7·PR8. PR9 의 서버 몫(discover 러너 갈래·묶기 경로·`bindings.ts`·`SetupStatus.runners[].agents`)을 걷는다.
- [ ] **Step 5: 실패하는 테스트 — 권한·제어 도구.** `roles.matrix.test.ts` 에 새 경로 전부(admin 이상·발급/다시 발급 owner), 제어 `update_agent` 가 러너 에이전트의 `basePrompt`·`model` 등을 받으면 `VALIDATION`·`name` 은 성공, `register_agent { provider: "runner" }`·`discover_agents { provider: "runner" }` 는 `VALIDATION`.
- [ ] **Step 6: 구현.** 팀 스펙 「역할과 권한」 표에 러너 줄.
- [ ] **Step 7: 끝내기 검사** → 커밋 `feat(server): manage runner projects and agents over rest`.

### Task 5: 웹 — 「러너」 탭·프로젝트·에이전트 추가

**Files:** 위 표의 태스크 5 줄(`features/runners/{queries,mutations,RunnersPage,RunnerCard,ProjectList,AddProjectDialog,DirectoryBrowser}.tsx` 등 이름은 빌더 판단), `features/agents/{DiscoverDialog,AgentRow,AgentsPage}.tsx`·새 `RunnerAgentForm.tsx`, `features/setup/RunnerSection.tsx`·`features/setup/IssueRunnerTokenDialog.tsx`(설정 예시 — 러너 `RunnerConfig` 꼴과 맞춘다, 서버 `llms.ts` 예시는 태스크 2 가 바꿨다). 테스트: 각 폴더.

**Interfaces:**
- Consumes: 태스크 4 의 REST.
- Produces: `qk.runners()`·`qk.runnerProjects(runnerId)`·`qk.runnerFs(runnerId, rootId, relPath)`.

- [ ] **Step 1: 실패하는 테스트 — 탭.** 「러너」 탭이 admin 이상에게만(member 는 탭 없음, 주소로 오면 지금 권한 없는 탭 꼴). 러너 카드: 이름·연결 상태·판본·프로그램(설치·판본·로그인·권한 상한, 못 쓰는 것은 사유)·루트 라벨, 끊김이면 「끊김」 하나. 프로젝트 줄: 라벨·`루트 라벨/relPath`·git·에이전트 수·「확인」 결과, `rootLabel` null 이면 「루트 없음」(Review Focus 2).
- [ ] **Step 2: 실패하는 테스트 — 프로젝트 추가.** 루트 고르기 → 둘러보기(빵 부스러기·git 표시·`truncated` 안내) 또는 상대 경로 직접 입력 → 확인 결과를 보고 저장. 둘러보기 403 이면 「이 러너는 둘러보기를 끄고 있습니다 — 경로를 직접 입력하세요」, 확인 실패 사유는 네 문구(빌더가 짓고 보고에 적는다).
- [ ] **Step 3: 실패하는 테스트 — 에이전트 추가(스펙 7장).** 고치기 화면의 지금 값은 `Agent.runnerAgent`(태스크 4), 프로그램·프로젝트 칸은 고치기에서 읽기만(PR10). shared 이름: `control/runner-bodies.ts`(`RunnerSummary`·`RunnerFsQuery`·`RunnerFsListing`·`RunnerProject`·`CreateRunnerProjectBody`·`RenameRunnerProjectBody`·`MoveRunnerProjectBody`·`RunnerProjectCheck`), `control/rest-bodies.ts`(`CreateRunnerAgentBody`·`UpdateAgentBody`·`RUNNER_AGENT_FIELDS`), `setup/index.ts`(`ReissueRunnerTokenResult`). 태스크 4 가 걷은 것: 연결 페이지 러너 카드의 에이전트 목록·`AgentConflict`·`useBindRunnerAgent`. `DiscoverDialog`·`ManualAgentForm` 의 러너 갈래와 `agentsProvider.test.tsx` 는 빈 목록으로만 맞춰 두었다 — 이 태스크가 새 흐름으로 갈아엎는다. 제공자 「러너」: 러너 → 프로젝트 → 프로그램(못 쓰는 것은 흐리게 + 사유) → 이름·핸들·모델·권한 모드(상한 위는 선택지에 없음 — Review Focus 3)·허용 도구·지시·DM 허용. 끊긴 러너는 고를 수 없다. 에이전트 고치기도 같은 칸. 보관된 프로젝트 없는 러너 에이전트는 「프로젝트가 없어 되살릴 수 없습니다 — 새로 만드세요」.
- [ ] **Step 3b: DM 머리의 러너 줄(태스크 1 리뷰 L2).** 지금 「러너 · <러너 라벨>」을 고정하는 테스트가 없다 — 프로그램 이름(`PROGRAM_NAME`)을 붙일지 정하고 그 꼴을 테스트로 고정한다.
- [ ] **Step 3b′: 태스크 4 가 정한 응답 꼴.** 옮기기 400 `VALIDATION` `details.field === "runnerId"` 는 대상 러너 천장 밖 에이전트(`agentIds`, `item` 은 첫 에이전트의 항목 하나) — 화면은 「이 러너의 설정이 허용하지 않는 에이전트가 있습니다: <이름들> — 먼저 권한·도구를 낮추거나 보관하세요」처럼 이름을 늘어놓는다(에이전트마다 사유를 다시 묻지 않는다). member 의 `Agent` 에는 `runnerAgent` 가 없다(PR11) — 에이전트 카드·DM 머리는 정의를 보이지 않는다. 러너 에이전트 PATCH 에 `program`·`runnerProjectId` 를 보내지 않는다(400).
- [ ] **Step 3c: 다시 발급 버튼은 요청이 나가 있는 동안 막는다**(동시 두 번이면 먼저 받은 원문이 이미 죽어 있다 — 태스크 4 리뷰 L5).
- [ ] **Step 4: 실패하는 테스트 — 연결 페이지.** 러너 블록에 토큰 발급·「다시 발급」(원문 한 번)·폐기·설치 안내(로컬 설정 예시에 `roots`·`programs`, 「드러나는 것」 넷째 문장 — 스펙 7장)만, 상태·에이전트 목록·「이 러너로 묶기」 없음.
- [ ] **Step 5: 구현** → 통과. **Step 6: 끝내기 검사**(웹 빌드 포함) → 커밋 `feat(web): add runner projects and runner agents`.

### Task 6: dev:fake·통합 시나리오·브라우저 검증

**Files:** `apps/server/scripts/dev-fake.ts`·`apps/server/test/fakes/fake-runner.ts`·`apps/server/test/integration/runner-projects.test.ts`(새).

- [ ] **Step 1: dev:fake** — (태스크 5 리뷰) 상한이 `plan` 인 둘째 가짜 러너(또는 프로그램)를 하나 두어 상한 아래 처음 값을 브라우저에서 본다. 둘러보기 고정 나무에 `&`·`#`·`%`·공백·`\` 가 든 이름을 하나씩 둔다. 가짜 러너가 루트 둘(`src` 「내 저장소들」·`work` 「회사」)·프로그램 `claude`(ok, 상한 `acceptEdits`)와 `codex`(`available: false`, 사유 「설치되지 않음」)를 알리고, 둘러보기에 고정 디렉터리 나무(git 저장소 둘·일반 디렉터리 하나·500개 넘는 디렉터리 하나)를 낸다. `coder` 는 새 DB 에서 `src/dodok` 프로젝트 + 러너 에이전트로 만든다(지금 씨앗 조건 그대로). 대본에 「천장」 키워드 → `RUNNER_CEILING(permissionMode)`.
  dev:fake 에서 고정 러너 토큰을 다시 발급한 뒤 `--keep` 으로 다시 띄우면 `ensureDevFakeRunner` 가 해시로 행을 못 찾아 새 행을 만들고 coder 는 옛 행에 남는다 — 토큰 id 로 찾거나 그 경우를 문서에 적는다(태스크 4 리뷰).
- [ ] **Step 2: 통합 — 완료 기준 1~4 를 흐름 하나씩.** ① 프로젝트 더하기 → 에이전트 만들기 → 멘션 → `run.start.agent` 의 프로젝트가 그 행 ② 지시가 append 의 틀 안에 ③ 루트 밖·상한 넘는 권한·꺼진 프로그램이 카드로 ④ 태스크 3 Step 8 의 경로 검사를 이 흐름에도.
- [ ] **Step 3: 브라우저 검증** — 독립 Chromium, owner·mia(member), 1280·390px(`docs/guides/browser-verification.md`). 항목: 태스크 5 리뷰 5장 목록(상한 `plan`·`dontAsk` 로 만들기, 만들기 폼을 연 채 러너 끊기, 폐기·끊긴 카드에서 옮기기·보관 뒤 초점, 추가 대화상자를 연 채 러너 끊기, 둘러보기 실제 요청 수·429 문구, 특수 문자 디렉터리, 프로그램 줄·프로젝트 줄의 접근성 이름과 「확인」 결과 알림, 다크 모드의 「(상한 초과)」 option) 과 러너 탭이 mia 에게 없음, 카드·프로그램 사유, 둘러보기·`truncated`·직접 입력, 루트 없음 줄, 에이전트 추가의 상한 선택지·흐린 `codex`, 천장 카드와 「다시 실행」, 연결 페이지 다시 발급, 초점 이동은 실제 브라우저에서. 결함은 원인이 분명하면 고치고 그 항목을 다시 본다.
- [ ] **Step 4: 끝내기 검사** → 커밋 `test(server): cover runner projects end to end`.

### Task 7: 런 0회 실연·문서

- [ ] **Step 1: 실연** — 실제 러너 설치본 + 번들 CLI + 가짜 Messages API(`docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」). 스크래치 디렉터리를 루트로 두고 앱에서 프로젝트·에이전트를 만든다. 기준: ① 그 디렉터리에서 돈다(CLI `cwd`) ② 지시가 요청 본문의 `<agent-instructions>` 틀 안 ③ 루트 밖 프로젝트·상한 넘는 권한이 `RUNNER_CEILING` 카드 ④ 옛 `agents` 키 설정은 문구와 함께 끝남 ⑤ DB·서버 로그에 스크래치 루트의 절대 경로 없음 ⑥ 시크릿 0·모델 런 0(공통 조건).
- [ ] **Step 2: 문서** — 스펙에 「구현과 맞춘 것」 장(PR1~PR9 와 구현 판단). `docs/manual/user-guide.md` 의 에이전트 가져오기 라디오 이름(「러너」)·DM 머리 제공자 줄(태스크 5 가 정한 꼴)과 `docs/guides/live-smoke.md` 의 응답 예시 `{"provider":"claude",…}`(태스크 1 리뷰 L3). 옛 제공자 이름이 남은 현재 가이드: `grep -nE 'provider claude|provider=claude|usageTrustedProviders|agents_claude_ws_agent' docs/guides/project-structure.md docs/guides/live-smoke.md` 의 줄을 `runner`·`program claude`·`usageTrustedPrograms` 로(과거 계획·스펙은 그대로 둔다 — 태스크 1 보고). `docs/guides/docker-deploy.md` 「Claude 러너 설치」 → 「러너 설치」(로컬 설정 `roots`·`programs`, 루트 `label` 을 꼭 적는다 — 안 적으면 디렉터리 이름(홈이면 계정 이름)이 서버로 간다, 루트 안이면 숨김 디렉터리도 경로를 적어 프로젝트로 만들 수 있다 — 경계는 루트다(태스크 2 리뷰 L4·L5), 루트 id 를 바꾸면 그 프로젝트가 「루트 없음」, 다시 발급, 드러나는 것 넷), 「업데이트」에 이 판은 `dodok-runner` 재설치와 기존 러너 에이전트 보관. `docs/guides/agent-guide.md` 「Claude 러너 에이전트」(지시 틀). `docs/manual/user-guide.md`(러너 탭·프로젝트·에이전트 추가·역할 표). `docs/guides/project-structure.md`(드라이버 구조·`runner_projects`·0030·0031). `.ruler/AGENTS.md` 의 구조 줄·러너 명령 줄·dev:fake 괄호(가짜 러너 루트·프로젝트, 「이 러너로 묶기」 걷음)·「현재 단계」 → `pnpm exec ruler apply`. `docs/guides/plan.md` 완료 항목·이월. `docs/guides/live-smoke.md` 「러너 일반화 실연」 절.
  다시 발급 단락에 「다시 발급하면 먼저 러너 서비스를 멈추고 새 토큰을 넣은 뒤 띄운다 — 옛 토큰으로 되풀이해 붙으면 그 주소가 잠시 막힌다(실패 카운터)」. `.ruler/AGENTS.md` dev:fake 괄호의 「이 러너로 묶기」 문장을 「폐기 뒤에는 연결 페이지에서 그 러너의 토큰을 다시 발급해 `POST /__devfake/runner { connected: true, token }` 로 붙인다(프로젝트·coder 는 그 러너에 남는다)」로(태스크 4 리뷰). `serverSessionIds` 없는 프로그램의 런이 옮기는 순간 옛 러너에서 돌면 늦은 `run.session` 이 비운 세션 칸을 다시 채운다 — 다음 드라이버 때 이월.
  웹 문구는 태스크 5 보고 2장 목록을 매뉴얼에 쓴다. 다시 발급 대화상자의 「AI 에게 맡기기」 한 줄(지금 「이 머신에 dodok 러너를 설치해 줘」)을 토큰 교체·재시작 문구로 바꾸거나 뺀다(태스크 5 리뷰 L10). 이월: REST 로 넣은 러너 에이전트 `disallowedTools` 는 화면 어디에도 보이지 않는다. 스펙 「구현과 맞춘 것」에 태스크 5 보고 3장(확인은 더하기가 한다 — 저장 전 확인 REST 없음, 프로젝트 줄의 git 여부는 「확인」 결과만, 「루트 없음」은 붙은 러너만, DM 머리 「러너 · <프로그램> · <러너 라벨>」, 버튼 이름 「에이전트 가져오기」 그대로·러너 갈래는 새로 만든다, 러너 실시간은 wire `adapter.status`, `disallowedTools` 칸 없음). 옛 「Claude 러너」 이름이 남은 웹 자리 셋(`ops/StatusCard.tsx` 연결 줄·`settings/PromptSection.tsx` 갱신 안내·`setup/llms.ts` 절 이름 — 서버 `llms.ts` 절 제목과 맞물림)을 「러너」로.
  `docs/guides/docker-deploy.md` 「프록시 접근 로그」 절에 「러너 둘러보기(`GET /api/v1/runners/:id/fs?…&relPath=…`)의 `relPath` 는 러너 머신의 디렉터리 구조다 — 서버 로그는 가리지만 프록시 접근 로그에는 원문이 남는다. 필터 조각에 `relPath` 쿼리를 더하거나 그 경로의 접근 로그를 끈다」(태스크 4). 스펙 「구현과 맞춘 것」에 태스크 4 보고 3장 1~11(`Agent.runnerAgent`·권한 enum 의 `domain` 이동·폐기 러너 409·PATCH 천장은 바꾸는 필드만·제어 `update_agent` 는 러너 핸들도 거절·요청 로그 `relPath` 가림·`live.ts`).
  `docs/manual/user-guide.md`·`docs/guides/agent-guide.md` 의 러너 세션 갱신 알림 문구를 「채널 규칙이나 에이전트 지시가 바뀌어 @… 이 앞 작업 맥락(도구 결과·긴 작업)을 이어 가지 않습니다 — 채널의 최근 글은 그대로 봅니다」로(태스크 3 — 지시 리비전도 세션을 새로 연다). 스펙 「구현과 맞춘 것」에 태스크 3 보고 3장(정의는 어댑터 옵션 `agentDefinition`, `RunnerRunStart.providerSessionId` 를 string 1~128 로 넓히고 Claude 드라이버가 UUID 검사, 갱신 조건 `promptEveryRun`, `runner_projects.workspace_id`, 러너 `agentsList: false`).
  이월에 넣을 것(태스크 3 리뷰 L4·L5): 서버는 러너가 보낸 `run.error.message`·도구 인자·루트 라벨·프로그램 사유를 다시 가리지 않는다(경로 가림은 러너 sink 한 겹), 지시 틀 문장이 「This Claude Code session」으로 고정(다음 드라이버 때 프로그램 이름으로).
  이월에 넣을 것(태스크 2 재리뷰 N1): JSON 도구 인자의 경로 키 값이 `<작업 디렉터리>/~/…` 이면 sink 의 두 번째 가림이 드라이버가 가린 `~/` 를 「밖」 표지로 바꾼다(활동 탭 표시만, 경로는 새지 않음). 러너 `files.ts` 는 아직 JS `realpathSync`(대소문자만 틀린 post 파일 이름은 안전한 쪽으로 거절 — 태스크 2 수정 보고).
- [ ] **Step 3: 끝내기 검사** → 커밋 `docs: record runner generalization and its live smoke`.
