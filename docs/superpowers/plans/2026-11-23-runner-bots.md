# 러너 봇(1부) Implementation Plan

> **For agentic workers:** 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 브리프가 이 계획의 태스크를 가리키고, 워커는 이 계획과 스펙을 함께 읽는다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프로젝트 없이 러너 관리 폴더(`botsDir/<providerAgentId>`)에서 도는 봇 에이전트를 만들고, 봇 정의(목적·지켜볼 것·할 일·보고할 것)를 지시와 `SOUL.md` 로 쓴다.

**Architecture:** `agents.runner_bot` JSON 이 봇을 가르고, 런 정의는 `project` 대신 `bot: { id, soul }` 을 싣는다. 지시는 서버가 기존 에이전트 지시 자리에 렌더하고, 러너는 천장에서 봇 자리를 허용하며 `SOUL.md` 를 쓴다. 능력 `bots` 로 옛 러너를 가른다.

**Tech Stack:** Zod(shared), drizzle·SQLite(마이그레이션 다음 번호), Fastify, Claude Agent SDK(runner), React(web).

**Spec:** `docs/superpowers/specs/2026-11-23-runner-bots-design.md` — B1~B13.

## Global Constraints

- 봇 폴더 `<botsDir>/<providerAgentId>`(B1), `botsDir` 기본 `~/.dodok-runner/bots`, 러너 설정 `roots` 는 `min(0)`.
- 정의 상한(B3): `purpose` ≤200, `watches`·`does`·`reports` 각 ≤2000.
- `SOUL.md` 맨 위 줄(B4): `<!-- 이 파일은 dodok 앱이 관리합니다 — 앱의 에이전트 상세에서 고치세요. 여기서 고친 내용은 다음 런에 덮입니다 -->`.
- 옛 러너 문구(B7): 「러너를 업데이트하세요(봇은 0.9.0 부터)」.
- 템플릿(B5) id: `review`·`release`·`support`·`blank`.
- 제어 MCP 로 봇 만들기 없음(B12). 러너 판본은 올리지 않는다(조율자).
- 병렬 작업: `remote-update` 워크트리가 같은 파일(`packages/shared/src/runner/index.ts` 의 `RunnerCapability`·hello, `packages/claude-runner/src/config.ts`·`connection.ts`)에 자기 키(`remoteUpdate`)를 더한다. 이 작업은 `bots`·`botsDir`·`bot` 만 더하고 그쪽 키를 건드리지 않는다. 나중에 병합되는 쪽이 리베이스한다.
- 공통: Conventional Commits·패키지 스코프, 경로 명시 stage, 실제 모델 런 금지.

## Review Focus

1. **봇 id·핸들에 `..`·`/` 가 들어가도(또는 `botsDir/<id>` 가 심볼릭 링크여도) 봇 자리 밖에서 런이 돌지 않는다.** (Task 2)
2. **봇과 「프로젝트 없는 옛 러너 에이전트」가 섞이지 않는다** — 되살리기·「되살릴 수 없음」·「프로젝트 밖(옛 것)」 묶음. (Task 3·4)
3. **봇 정의를 고치면 지시 리비전이 오르고, 명령 목록은 봇 폴더 기준이다.** (Task 3)
4. **옛 러너에 봇 런을 보내지 않는다.** (Task 3)
5. **member 는 봇임을 알되 정의 내용은 보지 못한다.** (Task 3)

---

### Task 1: 계약
**Files:** `packages/shared/src/runner/index.ts`(`RunnerCapability` `"bots"`, `RunnerRunAgent.project` 선택 + `bot?: { id: string; soul: string }` — 정확히 하나는 refine, `RunnerCeilingItem` `"bot"`, `RunnerCommandsList` 에 `{ bot: { id } }` 갈래), `packages/shared/src/domain/index.ts`(`Agent.runner.bot?: boolean`, `RunnerBotDefinition`), `packages/shared/src/control/rest-bodies.ts`(`CreateRunnerAgentBody` union, 정의 수정 본문), Create `packages/shared/src/runner/bot-templates.ts`(`BOT_TEMPLATES`), `packages/shared/src/runner/prompt.ts`(`agentInstructionsBlock` 의 봇 머리 문구). Test: `packages/shared/test/runner.test.ts`, `runner-v2.test.ts`, `runner-rest.test.ts`, `runner-prompt.test.ts`, Create `bot-templates.test.ts`.
- [ ] 실패하는 시험(project·bot 둘 다/둘 다 없음 거절, 정의 상한, 템플릿 넷의 칸이 상한 안, 봇 지시 렌더 문구) → 실패 확인 → 구현 → 통과(실행 수) → 커밋 `feat(shared): runner bot contracts and templates`

### Task 2: 러너
**Files:** `packages/claude-runner/src/config.ts`(`botsDir`, `roots` min 0), `packages/claude-runner/src/ceiling.ts`(`resolveBot(botsDir, id)` — id 는 `^r-[0-9a-f]{10}$` 만, `botsDir` realpath 아래 정확히 한 단계, 없으면 0700 으로 만듦, 링크면 거절 → 천장 항목 `bot`), `packages/claude-runner/src/drivers/claude/run.ts`(봇 런은 cwd = 봇 폴더, 런 시작 때 `SOUL.md` 를 Global Constraints 의 머리 줄 + `soul` 로 다시 씀), `packages/claude-runner/src/connection.ts`(능력 `bots`, `commands.list` 의 봇 갈래). Test: `ceiling.test.ts`, `config.test.ts`, `run.test.ts`, `connection.test.ts`, `adapter-integration.test.ts`.
- [ ] 실패하는 시험(`resolveBot` 이 `../x`·`r-…/../..`·링크·대문자 거절, 없으면 만듦, `roots: []` + 봇 런 통과, 봇 런 cwd·`SOUL.md` 내용, 프로젝트 감싸개가 봇 폴더의 `.claude/commands` 를 봄, 능력·명령 목록 봇 갈래) → 실패 확인 → 구현 → 통과 → 커밋 `feat(runner): bot folders outside project roots`

### Task 3: 서버
**Files:** 마이그레이션(`agents.runner_bot` text JSON nullable — drizzle-kit 다음 번호), `apps/server/src/db/schema.sqlite.ts`, `apps/server/src/modules/agents/service.ts`(봇 만들기 — 러너 토큰으로 주인·러너, `restoreAgent` 봇 갈래, 정의 수정 시 지시 리비전 +1), `apps/server/src/modules/agents/routes.ts`·`actions.ts`(본문 union — 제어 MCP 는 봇 갈래 거절), `apps/server/src/modules/runners/definition.ts`(봇 정의 — innerJoin 대신 봇 갈래), `apps/server/src/modules/agents/commands.ts`(봇 목록·캐시 키), `packages/runner-adapter/src/runner-adapter.ts`(능력 `bots` 없으면 B7 run_error, 지시 렌더에 봇 정의), `agentForRole`(member 에게 `runner.bot` 은 남기고 정의는 지움). Test: `apps/server/test/agents.service.test.ts`, `agents.archive.test.ts`, `orchestrator.runner.test.ts`, `agent-commands.routes.test.ts`, `roles.matrix.test.ts`, `packages/runner-adapter/test/runner-adapter.test.ts`, dev:fake(`apps/server/scripts/dev-fake.ts`·`apps/server/test/fakes/fake-runner.ts`·`apps/server/test/dev-fake.test.ts` — 주 가짜 러너는 `bots` 능력, 제한 러너는 없음).
- [ ] 실패하는 시험(봇 만들기·주인, 되살리기 봇은 됨/옛 것은 거절 그대로, 정의 수정 → 리비전 +1, 런 정의에 `bot`, 옛 러너 → B7, member 응답에 정의 없음·`bot: true`, 명령 목록 봇) → 실패 확인 → 구현 → 통과(서버·어댑터 혼자) → 커밋 `feat(server): runner bot agents`

### Task 4: 웹
**Files:** `apps/web/src/features/agents/RunnerAgentForm.tsx`(「프로젝트 / 봇」 고르기, 템플릿, 네 칸), `apps/web/src/features/agents/mutations.ts`, `apps/web/src/features/connections/AgentDetail.tsx`(정의 편집), `apps/web/src/features/connections/RunnerDetail.tsx`(「봇」 묶음, 옛 것 묶음에서 봇 빼기), `apps/web/src/features/connections/tree.ts`·`useConnectionTree.ts`·`ConnectionTreeList.tsx`(러너 아래 「봇」), `apps/web/src/features/agents/ArchivedAgents.tsx`, `apps/web/src/features/dms/DmHeader.tsx`(봇이면 「봇」 표시). Test: `apps/web/src/features/agents/agentsRunner.test.tsx`, `apps/web/src/features/connections/runnerDetail.test.tsx`, `apps/web/src/features/connections/tree.test.ts`, `apps/web/src/features/agents/agentsArchive.test.tsx`.
- [ ] 실패하는 시험(봇 만들기 흐름·템플릿 채움·상한, 옛 러너 잠금 사유, 정의 편집, 트리·러너 상세 묶음, member 에게 정의 편집 없음) → 실패 확인 → 구현 → 통과(웹 혼자) → 브라우저(dev:fake, 워크트리 전용 포트, 390·1280px — 봇 만들기·DM·정의 고치기) → 커밋 `feat(web): create and edit runner bots`

### Task 5: 런 0회 하네스·문서
- [ ] 이 브랜치의 러너 tgz + 가짜 Messages API: `roots: []`·`botsDir` 임시 자리로 봇 만들기 → 런의 cwd·`SOUL.md`·지시에 정의(가짜 API 요청 본문) 확인. 문서 `docs/manual/user-guide.md`·`docs/guides/agent-guide.md`·`docs/guides/live-smoke.md`·`docs/guides/plan.md`. 커밋 `docs: runner bots`
