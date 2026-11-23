# 러너 봇 2부(봇 도구) Implementation Plan

> **For agentic workers:** 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 브리프가 이 계획의 태스크를 가리키고, 워커는 이 계획과 스펙을 함께 읽는다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 봇마다 앱에서 MCP 서버(`.mcp.json` 의 `mcpServers` 꼴)를 적어 붙이고, 러너 로컬 `appMcp` 천장이 종류별로 허용하며, 켠 봇에게 「이 러너 설정 제어」 도구를 준다.

**Architecture:** shared 에 MCP 설정 스키마·판정 함수 `appMcpVerdict`·`RUNNER_CONTROL_TOOLS` 를 두고 서버(표시·전송)와 러너(런)가 같은 판정을 쓴다. 서버는 봇 정의에 MCP·자동 허용·내장 도구를 저장하고(비밀값은 쓰기 전용) 능력 `botMcp`·`runnerControl` 을 보고 런 정의 `bot` 에 싣는다. 러너는 받은 서버를 SDK `mcpServers` 에 `dodok` 과 나란히 넣고, 러너 제어 도구는 기존 `control.call` 길로 서버에 묻는다. 봇이 부른 업데이트는 서버의 「업데이트 대기」로 들어가 런이 모두 끝나면 나간다.

**Tech Stack:** Zod(shared), drizzle·SQLite(마이그레이션 다음 번호), Fastify, Claude Agent SDK(runner — `mcpServers` 의 http·sse·stdio 꼴), React(web).

**Spec:** `docs/superpowers/specs/2026-11-23-runner-bot-tools-design.md` — T1~T18. 1부 스펙 `docs/superpowers/specs/2026-11-23-runner-bots-design.md`(B1~B13)와 1부 계획 `docs/superpowers/plans/2026-11-23-runner-bots.md` 가 바탕이다.

## Global Constraints

- 러너 로컬 설정(T2): `appMcp: "off" | "http" | "all"` 기본 `"http"`, `appMcpCommands?: string[]`(실행 파일 basename). 앱·도구로 바꾸지 않는다.
- hello 자리(T3): `appMcp` 천장은 `programs[].ceiling` 안(strict 가 아닌 자리) — `RunnerHello` 최상위에 키를 더하지 않는다.
- MCP 서버 이름: `^[a-zA-Z0-9_-]{1,64}$`, `dodok` 거절, 봇마다 최대 16개. URL 은 `http:`·`https:` 만.
- 비밀값(T4): REST 읽기는 `headers`·`env` 값 자리에 `"••••"`(U+2022 넷). 쓰기에서 값이 정확히 `"••••"` 면 저장된 원래 값을 지킨다. 로그·run.start 로그·감사 기록·웹 응답에 원문 금지.
- `"http"` 가 막는 주소 글자(T17): `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `fc00::/7`, `fe80::/10`, `0.0.0.0`.
- stdio `env` 거절 키(T18): `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`(접두사), `PATH`.
- 판정 사유(T3·T15) 코드와 문구: `appMcpOff`「앱 MCP 꺼짐」, `stdioNotAllowed`「이 러너는 stdio 서버를 받지 않음」, `commandNotAllowed`「명령 <basename> 이 허용 목록에 없음」, `privateAddress`「로컬·사설 주소는 받지 않음」, `envKeyNotAllowed`「env <키> 는 받지 않음」, `toolCeiling`「도구 상한 밖」.
- 옛 러너 문구(T5): 「러너를 업데이트하세요(봇 도구는 0.10.0 부터)」. 능력 이름 `botMcp`·`runnerControl`.
- 도구로 권한을 올리지 못한다(T14): 러너 제어 도구 입력에 `mcpServers`·자동 허용·`builtinTools`·`sessionDefaults.permissionMode` 없음, 부른 봇 자신은 고치기 대상 아님.
- 업데이트 대기 문구(T16): 웹 「업데이트 대기 — 런이 끝나면 올립니다」, 도구 결과 「예약됨 — 이 러너의 런이 모두 끝나면 업데이트합니다」.
- 러너 판본은 이 계획에서 올리지 않는다(조율자가 0.10.0 으로 — T13).
- 공통: Conventional Commits·패키지 스코프, 경로 명시 stage, 실제 모델 런 금지, `pnpm test` 를 typecheck·build 와 동시에 돌리지 않는다.

## Review Focus

1. **러너 로컬이 막았는데 stdio 명령이 실행되는 길이 없다** — 서버가 판정을 건너뛰고 보내도(가짜 서버) 러너가 다시 판정해 뺀다. `"all"` + `appMcpCommands` 에서 `command` 가 `/tmp/npx`·`./npx`·`npx.sh` 일 때 basename 판정, `env.DYLD_INSERT_LIBRARIES`. (Task 2)
2. **비밀값이 새지 않는다** — `GET` 응답·member 응답·제어 도구 `list_agents`·러너 제어 목록 도구·서버 로그(`logger.test.ts` 꼴)·러너 run.start 로그 줄에 헤더 값 원문이 없다. 값 없이 이름만 바꾼 편집이 원래 값을 지킨다. (Task 1·3)
3. **러너 제어 도구가 다른 러너에 닿지 않는다** — 다른 러너의 프로젝트·에이전트 id 를 넘기면 NOT_FOUND, 자기 자신 고치기 거절, 자동화 사슬(`requested_by` null)은 쓰기 거절. (Task 4)
4. **업데이트 대기가 런이 남은 채 나가지 않고, 서버 재시작·러너 재접속 뒤에도 남는다**, 취소하면 나가지 않는다. 대기 중 웹 단추를 누르면 지금처럼(바쁘면 거절). (Task 4)
5. **MCP 를 고치면 그 봇의 세션이 새로 열린다**(리비전 +1), 고치지 않은 저장(이름만 같은 다시 저장)은 올리지 않는다. 옛 러너(`botMcp` 없음)에 MCP 없는 봇 런은 그대로 간다. (Task 3)

---

### Task 1: 계약(shared)
**Files:** Create `packages/shared/src/runner/mcp.ts`(`McpServerConfig` — `type: "http" | "sse"` `{ url, headers? }` 와 `type?: "stdio"` `{ command, args?, env? }` 의 strict union, `McpServers` 레코드(이름 꼴·16개·`dodok` 거절), `McpAutoAllow = { mode: "none" } | { mode: "all" } | { mode: "tools"; tools: string[] }`, `AppMcpCeiling = { appMcp: "off"|"http"|"all"; appMcpCommands: string[] | null; allowedToolsCeiling: string[] | null }`, `appMcpVerdict(ceiling, name, server, autoAllow): { ok: true; allowedTools: string[] } | { ok: false; reason: AppMcpBlockReason; detail?: string }`, `maskMcpSecrets(servers)`, `mergeMcpSecrets(incoming, stored)`, `MCP_SECRET_MASK = "••••"`), `packages/shared/src/runner/index.ts`(`RunnerCapability` 에 `"botMcp"`·`"runnerControl"`, 프로그램 천장에 `appMcp`·`appMcpCommands` 선택 필드, `RunnerRunAgent.bot` 에 `mcpServers?`·`mcpAutoAllow?: Record<string, McpAutoAllow>`·`builtinTools?: ("runnerControl")[]`), `packages/shared/src/domain/index.ts`(`RunnerBotDefinition` 에 `mcpServers`·`mcpAutoAllow`·`builtinTools` 기본 빈 값), Create `packages/shared/src/control/runner-tools.ts`(`RUNNER_CONTROL_TOOLS` — 이름 `runner_status`·`list_runner_projects`·`create_runner_project`·`update_runner_project`·`archive_runner_project`·`add_runner_worktree`·`list_runner_agents`·`create_runner_agent`·`set_agent_session_defaults`·`request_runner_update`, `CONTROL_TOOLS` 의 `tool()` 꼴·access, 입력은 rest-bodies 의 본문을 T14 대로 `omit`, 대상 러너 id 는 입력에 없음, 설명에 T10 문장), `packages/shared/src/control/index.ts`(내보내기·`findControlTool` 이 둘 다 찾게 하거나 `findRunnerControlTool`). Test: Create `packages/shared/test/runner-mcp.test.ts`, `packages/shared/test/runner.test.ts`, `packages/shared/test/runner-v2.test.ts`, `packages/shared/test/control.test.ts`.
- [ ] 실패하는 시험: `.mcp.json` 통째(`{ mcpServers: {...} }`)와 값만 둘 다 파싱, `dodok`·17개·`ftp:` 거절; `appMcpVerdict` 표 — off→`appMcpOff`, http+stdio→`stdioNotAllowed`, http+`http://127.0.0.1:3000`·`http://[::1]`·`http://foo.localhost`·`http://192.168.1.2`→`privateAddress`, all+`http://127.0.0.1`→ok, all+commands `["npx"]`+`/usr/local/bin/npx`→ok·`npx.sh`→`commandNotAllowed`, all+`env.DYLD_INSERT_LIBRARIES`→`envKeyNotAllowed`, autoAllow all→`["mcp__gh"]`·tools→`["mcp__gh__a"]`, `allowedToolsCeiling: ["mcp__gh__a"]`+autoAllow all→`toolCeiling`; `maskMcpSecrets` 뒤 원문 없음, `mergeMcpSecrets` 가 `"••••"` 자리를 저장 값으로; 러너 제어 도구 입력에 `mcpServers`·`permissionMode` 가 있으면 strict 거절; 옛 hello(천장에 `appMcp` 없음) 그대로 파싱 → 실패 확인 → 구현 → 통과(실행 수) → 커밋 `feat(shared): bot MCP contracts and runner control tools`

### Task 2: 러너
**Files:** `packages/claude-runner/src/config.ts`(`appMcp`·`appMcpCommands` — 최상위 키, hello 로는 `programs[].ceiling` 에 실음), `packages/claude-runner/src/connection.ts`(능력 `botMcp`·`runnerControl`, hello 천장, run.start 로그에서 `mcpServers` 를 이름만으로), `packages/claude-runner/src/drivers/claude/run.ts`(봇 런: `appMcpVerdict` 를 다시 돌려 통과한 서버만 `mcpServers` 에, 막힌 것은 로그 한 줄 `bot mcp blocked <이름> <사유>`(값 없음), 자동 허용 이름을 `allowedTools` 에 합침, `builtinTools` 에 `runnerControl` 이면 러너 제어 도구를 dodok MCP 에), `packages/claude-runner/src/control-tools.ts`(`createControlTools` 가 `RUNNER_CONTROL_TOOLS` 도 받게 — 같은 `control.call` 길, `CONTROL_TOOL_FULL_NAMES` 와 나란히 `RUNNER_CONTROL_TOOL_FULL_NAMES`), `packages/claude-runner/README.md`(설정 예·T18 문장). Test: `packages/claude-runner/test/config.test.ts`, `connection.test.ts`, `run.test.ts`, `control-tools.test.ts`, `adapter-integration.test.ts`.
- [ ] 실패하는 시험: 설정 기본 `appMcp` = `"http"`, 틀린 값 거절; hello 천장에 실림·능력 둘; 봇 런의 SDK 옵션 `mcpServers` 에 `dodok` + 허용된 것만(가짜 서버가 stdio 를 보내도 `"http"` 러너는 뺌 — Review Focus 1), 자동 허용 이름이 `allowedTools` 에, 프로젝트 에이전트 런에는 외부 MCP 없음(T12), `runnerControl` 켠 봇만 러너 제어 도구 이름이 있음; run.start 로그 줄에 헤더 값 없음 → 실패 확인 → 구현 → 통과 → 커밋 `feat(runner): app-managed MCP servers for bots`

### Task 3: 서버 — 저장·표시·런 정의
**Files:** 마이그레이션(필요하면 — `agents.runner_bot` JSON 에 넣으면 스키마 변경 없이 기본값 파싱만; 별도 칸이면 다음 번호), `apps/server/src/db/schema.sqlite.ts`, `apps/server/src/modules/agents/service.ts`(봇 정의 저장 — `mergeMcpSecrets`, 정의 리비전 +1 은 MCP·자동 허용·내장 도구가 실제로 바뀔 때만), `apps/server/src/modules/agents/routes.ts`·`actions.ts`(읽기 응답 `maskMcpSecrets`, member 응답은 지금처럼 정의 없음), `apps/server/src/modules/runners/definition.ts`(런 정의 `bot.mcpServers`·`mcpAutoAllow`·`builtinTools` — 능력 `botMcp` 없으면 MCP 를 싣지 않고, MCP 가 있는 봇이면 T5 run_error), `packages/runner-adapter/src/runner-adapter.ts`(T5 run_error, `runnerControl` 능력 없으면 `builtinTools` 빼고 보냄 — T7), `apps/server/src/modules/runners/live.ts`(hello 천장의 `appMcp` 를 러너 상세 응답에), `apps/server/src/logger.ts`(MCP 값이 실릴 수 있는 자리를 redact — 실제로 실리는 자리를 찾아서), `apps/server/scripts/dev-fake.ts`·`apps/server/test/fakes/fake-runner.ts`(dev-fake 는 `"http"`·능력 둘, 제한은 `"off"`), `apps/server/test/dev-fake.test.ts`. Test: `apps/server/test/agents.service.test.ts`, `apps/server/test/orchestrator.runner.test.ts`, `apps/server/test/runners.routes.test.ts`, `apps/server/test/logger.test.ts`, `apps/server/test/roles.matrix.test.ts`, `packages/runner-adapter/test/runner-adapter.test.ts`.
- [ ] 실패하는 시험: 저장 뒤 GET 에 `"••••"`·원문 없음, 마스크 그대로 다시 저장하면 DB 값 유지·리비전 그대로, 헤더 값을 바꾸면 리비전 +1; 런 정의에 원문 MCP(러너로는 원문이 가야 한다); `botMcp` 없는 러너 + MCP 봇 → T5 문구 run_error, MCP 없는 봇 → 그대로 런; `runnerControl` 없는 러너 → `builtinTools` 빠짐; 러너 상세 응답에 `appMcp` 천장; member 응답·`list_agents` 제어 결과에 MCP 없음 → 실패 확인 → 구현 → 통과(서버·어댑터 각각 혼자) → 커밋 `feat(server): store and send bot MCP servers`

### Task 4: 서버 — 러너 제어 도구와 업데이트 대기
**Files:** `apps/server/src/modules/control/handlers.ts`(`RUNNER_CONTROL_TOOLS` 처리기 — 기존 REST 처리 함수 재사용, 대상 러너 = `principal.runId` 런의 연결(러너 토큰), 다른 러너 대상 NOT_FOUND, 부른 봇 자신 대상 거절), `apps/server/src/modules/control/service.ts`(러너 경로에서만 이 도구들을 받음 — `/mcp`·브리지는 모르는 도구), `apps/server/src/modules/control/confirm.ts`(카드 문구), `apps/server/src/modules/connections/remote-updates.ts`(업데이트 대기 — 저장(서버 재시작을 넘김), 「그 러너의 열린 런 0」·러너 재접속 때 판정해 지금 웹 업데이트와 같은 요청, 취소), `apps/server/src/modules/runners/projects.routes.ts`(대기 조회·취소 REST — 러너 주인·admin), 마이그레이션(대기 저장 자리, 다음 번호), `apps/server/src/db/schema.sqlite.ts`, 런 종료 훅을 거는 자리(런 상태 기계 `apps/server/src/modules/runs/` 에서 끝남을 알리는 곳 — codegraph 로 찾는다). Test: `apps/server/test/control.service.test.ts`, `apps/server/test/control.confirm.test.ts`, `apps/server/test/control.principal.test.ts`, `apps/server/test/runner-projects.routes.test.ts`, `apps/server/test/roles.matrix.test.ts`, Create `apps/server/test/runner-update-queue.test.ts`.
- [ ] 실패하는 시험: 켠 봇 런에서 `list_runner_projects` 가 그 러너 것만; `create_runner_project` 는 확인 카드 → 승인 뒤 생김; 다른 러너의 프로젝트 id → NOT_FOUND; 자기 자신에 `set_agent_session_defaults` → 거절; 자동화 사슬 쓰기 거절; `/mcp`(PAT)로 러너 제어 도구 → 모르는 도구; `request_runner_update` → 카드 → 「예약됨」, 런이 남아 있으면 안 나감, 마지막 런 끝 → 업데이트 요청 1회, 서버 재시작(같은 DB) 뒤에도 대기 남음, 러너 끊김 중 끝났으면 재접속 때 나감, 취소 뒤 안 나감 → 실패 확인 → 구현 → 통과(서버 혼자, `roles.matrix` 포함) → 커밋 `feat(server): runner control tools and deferred runner update`

### Task 5: 웹
**Files:** `apps/web/src/features/agents/RunnerAgentForm.tsx`(봇 만들기의 「도구」 칸 — JSON 편집, `.mcp.json` 붙여넣기, 서버마다 허용 표시(러너 상세의 `appMcp` 천장 + shared `appMcpVerdict`)·자동 허용 고르기, 「이 러너 설정 제어」 켜기 — `runnerControl` 능력 없으면 잠금 사유), `apps/web/src/features/connections/AgentDetail.tsx`(정의 편집에 같은 칸, 비밀값은 `"••••"` 로 보이고 바꾸면 그 값만), `apps/web/src/features/connections/RunnerDetail.tsx`(「업데이트 대기 — 런이 끝나면 올립니다」·「취소」), `apps/web/src/features/agents/mutations.ts`. Test: `apps/web/src/features/agents/agentsRunner.test.tsx`, `apps/web/src/features/connections/runnerDetail.test.tsx`.
- [ ] 실패하는 시험: 붙여넣은 `.mcp.json` 에서 서버 둘이 보이고 stdio 는 dev-fake(`"http"`)에서 「이 러너는 stdio 서버를 받지 않음」; 저장 본문에 마스크 자리는 `"••••"` 그대로; 자동 허용 고르기가 본문에; `runnerControl` 없는 러너에서 켜기 잠금; 러너 상세 대기 표시·취소; member 에게 도구 칸 없음 → 실패 확인 → 구현 → 통과(웹 혼자) → 브라우저(dev:fake, 워크트리 전용 포트, 390·1280px — 봇에 MCP 붙이기·허용 표시·업데이트 대기 표시) → 커밋 `feat(web): bot tools editor and runner update queue`

### Task 6: 런 0회 하네스·문서
- [ ] 이 브랜치의 러너 tgz + 가짜 Messages API + 가짜 HTTP MCP 하나(스크래치의 작은 Streamable HTTP 서버, 도구 하나): 봇에 붙이고 런 → 가짜 API 요청 본문의 tools 에 `mcp__<이름>__<도구>` 가 있는지, `appMcp: "off"` 러너에서는 없는지, 러너 로그에 헤더 값이 없는지 확인. 결과를 `docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」 절에 절차로 더한다.
- [ ] 문서 `docs/manual/user-guide.md`(봇의 도구·러너 설정 제어·업데이트 대기), `docs/guides/agent-guide.md`(러너 제어 도구), `docs/guides/docker-deploy.md`(백업에 MCP 비밀값이 든다 — T4), `docs/guides/plan.md` 8장(2부 완료·3부 이월). 커밋 `docs: runner bot tools`
