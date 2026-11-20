# 에이전트 명령 Implementation Plan

> **For agentic workers:** 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 브리프가 이 계획의 태스크를 가리키고, 워커는 이 계획과 스펙을 함께 읽는다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@에이전트 /명령 [인자]`(1:1 에이전트 DM 은 `/명령`)를 머리말 없이 러너·OpenClaw 에 그대로 넘기고, 사람의 명령·스킬을 안전하게 들이며, 작성기에서 그 에이전트의 명령을 자동완성한다.

**Architecture:** shared `parseAgentCommand` 가 글을 명령으로 알아보고, 서버 라우터가 `triggerKind: "command"` 런을 만들어 `InboundDeliver.command` 를 싣는다. 러너는 플러그인 감싸개로 명령·스킬을 들이고(설정 파일 0) 프롬프트를 그대로 보내며, 플러그인은 명령 갈래에서만 Gateway 명령 해석을 켠다. 웹은 에이전트별 명령 목록 GET 으로 자동완성한다.

**Tech Stack:** Zod(shared), Fastify·Socket.IO(server), Claude Agent SDK 0.3.283(runner), OpenClaw 2026.9.4 plugin SDK(plugin), React·Tiptap(web).

**Spec:** `docs/superpowers/specs/2026-11-21-agent-commands-design.md` — 결정 C1~C17(3장). 스파이크 근거 `.superpowers/sdd/2026-11-21-agent-commands/spike-report.md`.

## Global Constraints

- 명령 모양(C2): 글이 정확히 「멘션 토큰 하나 + 공백 + `/이름` + (공백 + 인자)」, 1:1 에이전트 DM 은 맨 앞 `/이름`. 이름 `^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$`. 첨부가 있으면 명령 아님. 멘션 둘 이상이면 명령 아님.
- 러너(Claude) 막는 이름(C4): `login` `logout` `config`; 안내로 막는 이름: `model` → 「모델은 작성기 칩에서 바꾸세요」, `clear` → 「새 세션을 여세요」. 그 밖은 넘긴다(C5).
- OpenClaw 허용 목록(C10): `status` `help` `commands` `whoami` `usage` `compact` `skill` `think` `fast` `verbose` `reasoning` `queue` `model`(인자에 `-g`·`-a` 토큰이 있으면 막음). `new`·`reset` → 「새 세션을 여세요」. 그 밖은 「이 명령은 dodok 에서 쓸 수 없습니다」. `!` 로 시작하는 글은 명령으로 보지 않는다(평범한 글 — 플러그인이 해석을 끈 채 보낸다).
- `@에이전트 /stop` → 막고 「중지는 `/stop` 만 쓰세요」.
- 옛 러너·플러그인(능력 `commands` 없음, C7): 시스템 줄 「이 에이전트는 명령을 지원하지 않습니다 — 러너·플러그인을 업데이트하세요」.
- 답 없는 명령(C13): 「`/<이름>` 완료」 한 줄을 그 에이전트 이름으로.
- 러너 감싸개(C14): 플러그인 이름 `user`·`project`, `settingSources: []` 유지, `skipMcpDiscovery: true`. 막기(C15): `settings: { disableAllHooks: true, disableSkillShellExecution: true }` + SDK `PreToolUse` 콜백 `ask`.
- 명령 목록 ack 상한 30초, 서버 캐시 10분(C8). 목록 상한 200개·이름 64자·설명 200자.
- 러너 `package.json` 판본·플러그인 판본은 올리지 않는다(조율자). 실제 모델 런 금지.
- 공통: Conventional Commits·패키지 스코프, 경로 명시 stage.

## Review Focus

1. **경로·URL·코드가 명령으로 잡히지 않는다** — `@coder /usr/bin 이 뭐야`(이름 뒤가 `/` 로 이어짐 → 아님), `@coder https://x`, 글 중간 `/compact`. (Task 1 시험)
2. **명령 파일의 `allowed-tools: Bash(*)` 로 default 권한에서 승인 카드 없이 Bash 가 돌지 않는다.** (Task 3 시험)
3. **`/compact` 가 앞 턴의 답을 새 답으로 다시 게시하지 않는다.** (Task 3 시험)
4. **명령 결과 글에 다른 에이전트 멘션이 있어도 릴레이가 일어나지 않는다.** (Task 2 시험)
5. **명령이 아닌 평범한 글 속 `/model x` 는 OpenClaw 에서 지시어로 먹지 않는다**(해석은 명령 갈래에서만). (Task 4 시험)

---

### Task 1: 계약

**Files:**
- Create: `packages/shared/src/commands.ts`(export 는 `packages/shared/src/index.ts`)
- Modify: `packages/shared/src/domain/index.ts`(`RunTriggerKind`), `packages/shared/src/bridge/index.ts`(`InboundDeliver`, `BridgeCapability`), `packages/shared/src/runner/index.ts`(`RunnerCapability`, `commands.list` 이벤트·스키마)
- Test: Create `packages/shared/test/commands.test.ts`; Modify `packages/shared/test/bridge.test.ts`, `packages/shared/test/runner.test.ts`, `packages/shared/test/runner-v2.test.ts`

**Interfaces — Produces:**
- `parseAgentCommand(text: string, opts: { directAgentId?: string }): { agentId: string; name: string; args: string } | null` — 멘션 토큰은 shared `MENTION_TOKEN_RE`(`mention.ts`)로. 칩 뒤 공백은 `\s`(nbsp 포함). `directAgentId` 가 있으면(1:1 DM) 맨 앞 `/이름`.
- `type CommandVerdict = { ok: true } | { ok: false; reason: "blocked" | "use_chips" | "new_session" | "use_stop"; message: string }`
- `checkCommand(program: "claude" | "openclaw", name: string, args: string): CommandVerdict` — Global Constraints 의 목록·문구 그대로.
- `OPENCLAW_COMMANDS: ReadonlyArray<{ name: string; description: string }>` — C10 허용 목록(설명은 2026.9.4 `docs/tools/slash-commands.md` 에서 한 줄 한국어로).
- `AgentCommand = z.object({ name: z.string().max(64), description: z.string().max(200), argumentHint: z.string().max(200).optional(), aliases: z.array(z.string().max(64)).max(8).optional() })`
- `RunTriggerKind` 에 `"command"`. `InboundDeliver.command: z.object({ name, args: z.string().max(4000) }).optional()`.
- `BridgeCapability`·`RunnerCapability` 에 `"commands"`.
- 러너 `"commands.list"`: 요청 `{ project: RunnerProjectRef }`, 응답 `{ ok: true, commands: AgentCommand[] (max 200) } | { ok: false, reason: "root_missing" | "not_found" | "failed" }`.

- [ ] **Step 1: 실패하는 시험** — `commands.test.ts`: `"<@a:ID> /compact"` → `{agentId, name:"compact", args:""}`, `"<@a:ID> /user:review src/a.ts  x"` → args `"src/a.ts  x"`(인자 안 공백 보존), nbsp 뒤 `/` 도 됨, `"<@a:ID> /usr/bin 이 뭐야"` → null(이름 뒤 `/`), `"<@a:ID> https://x"` → null, `"hi <@a:ID> /compact"` → null, 멘션 둘 → null, `"/status"`+`directAgentId` → 됨, `directAgentId` 없이 `"/status"` → null, `"/stop"` 은 이 함수와 무관(null), 이름 65자 → null. `checkCommand`: claude `login`→blocked, `model`→use_chips, `clear`→new_session, `review`→ok, openclaw `status`→ok, `restart`→blocked, `new`→new_session, `model -g opus`→blocked, `model opus`→ok, 양쪽 `stop`→use_stop. 계약: `InboundDeliver` command 파싱, 능력 enum, `commands.list` 응답 201개 거절.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/shared test`.
- [ ] **Step 3: 구현** — 위 그대로.
- [ ] **Step 4: 통과 확인** — shared 시험, `pnpm typecheck`. 실행 수.
- [ ] **Step 5: 커밋** — `feat(shared): agent command parsing and contracts`

### Task 2: 서버 — 명령 런과 목록

**Files:**
- Modify: `apps/server/src/modules/router/decide.ts`, `apps/server/src/modules/router/service.ts`, `apps/server/src/modules/runs/orchestrator.ts`, `apps/server/src/modules/components/service.ts`(「다시 실행」), `packages/runner-adapter/src/runner-adapter.ts`·`packages/runner-adapter/src/index.ts`(`commandsList`)
- Create: `apps/server/src/modules/agents/commands.ts`, `apps/server/src/modules/agents/commands.routes.ts`(등록은 기존 라우트 등록 자리)
- Test: `apps/server/test/router.decide.test.ts`, `apps/server/test/runs.orchestrator.test.ts`, `apps/server/test/orchestrator.runner.test.ts`, `packages/runner-adapter/test/runner-adapter.test.ts`, Create `apps/server/test/agent-commands.routes.test.ts`, `apps/server/test/roles.matrix.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - 라우팅: 사람 글이 `parseAgentCommand` 를 만족하고 그 에이전트가 그 대화에서 부를 수 있으면 → `checkCommand`(러너면 `"claude"`, OpenClaw 면 `"openclaw"`) 실패면 런 없이 시스템 줄(`message` 그대로) / 그 연결이 `commands` 능력이 없으면 C7 시스템 줄 / 아니면 `RunPlan` 하나(`triggerKind: "command"`, `command: { name, args }`). 1:1 DM 은 DM 경로에서 `directAgentId` 로 같은 판정.
  - 릴레이: `sourceRun.triggerKind === "command"` 이면 에이전트 글의 멘션으로 런을 만들지 않는다.
  - 오케스트레이터: 명령 런의 deliver 에 `command`. 명령 런이 플러그인 admission `drop` 사유 `handled…` 로 끝나거나, 정본 글 없이 끝나면 에러가 아니라 done — 정본 글이 없거나 비면 그 에이전트 이름으로 「`/<이름>` 완료」 메시지 하나(Global Constraints).
  - 「다시 실행」: 원래 런이 `command` 면 트리거 글을 다시 `parseAgentCommand` 로 풀어 같은 명령.
  - `GET /api/v1/conversations/:id/agent-commands` → `{ agents: Array<{ agentId: string; commands: AgentCommand[]; supported: boolean }> }` — 그 대화를 부를 수 있는 에이전트마다. OpenClaw 는 `OPENCLAW_COMMANDS`, 러너는 어댑터 `commandsList(tokenId, projectRef)` 결과를 프로젝트 id 별 10분 캐시(러너 재접속 이벤트에 비움). 능력 없음·끊김이면 `supported: false`·빈 목록. 새 세션 창용으로 `GET /api/v1/channels/:id/agent-commands`(채널 멤버 에이전트) 도.
  - 권한: 그 대화(채널)를 읽을 수 있는 사람.

- [ ] **Step 1: 실패하는 시험** — `router.decide.test.ts`: `command mention creates one command run`, `two mentions with slash → normal mention runs`, `blocked command → no run + system line text`, `old runner without commands capability → C7 line`, `relay from command run is suppressed`, `@dev /stop → use_stop line`. orchestrator: `command run deliver carries command`, `handled drop closes command run as done with "/status 완료"`, `empty final → "/compact 완료"`, `non-command handled drop still errors`(기존 동작), `retry of command run re-parses trigger`. `agent-commands.routes.test.ts`: OpenClaw 목록, 러너 목록 캐시(두 번 불러도 어댑터 1번), 끊김 → supported false, 남의 DM 404. roles.matrix: 새 GET 두 경로. 어댑터: `commandsList uses 30s ack`.
- [ ] **Step 2: 실패 확인** — 서버·어댑터 시험 각각 혼자.
- [ ] **Step 3: 구현** — 위 그대로.
- [ ] **Step 4: 통과 확인** — 각각 혼자, typecheck. 실행 수.
- [ ] **Step 5: 커밋** — `feat(server): agent command runs and command lists`

### Task 3: 러너

**Files:**
- Create: `packages/claude-runner/src/drivers/claude/command-wrappers.ts`
- Modify: `packages/claude-runner/src/drivers/claude/run.ts`(`buildQueryOptions`·프롬프트·결과), `packages/claude-runner/src/drivers/claude/stream-map.ts`, `packages/claude-runner/src/drivers/claude/index.ts`·`sdk.ts`(목록 query 에 감싸개·`supportedCommands`), `packages/claude-runner/src/connection.ts`(`commands.list`, 능력)
- Test: Create `packages/claude-runner/test/command-wrappers.test.ts`; Modify `packages/claude-runner/test/run.test.ts`, `packages/claude-runner/test/stream-map.test.ts`, `packages/claude-runner/test/connection.test.ts`, `packages/claude-runner/test/helpers/fake-query.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `createCommandWrappers(opts: { configDir: string; cwd: string; tmpRoot?: string }): Promise<{ plugins: Array<{ type: "local"; path: string; skipMcpDiscovery: true }>; dispose(): Promise<void> }>` — 스파이크 꼴(`.claude-plugin/plugin.json` `{"name":"user"}`·`{"name":"project"}`, `commands`·`skills` 심볼릭 링크, 원본이 없으면 그 링크를 만들지 않는다, 둘 다 없으면 그 감싸개를 만들지 않는다). 사람 폴더에 쓰지 않는다. 런이 끝나면 `dispose`.
  - `buildQueryOptions` 에 `plugins`(모든 런 — 사람 글 속에서 모델이 스킬을 부를 수 있게), `settings: { disableAllHooks: true, disableSkillShellExecution: true }`, `hooks.PreToolUse` 콜백: `shouldAsk(toolName, permissionMode): boolean` — 러너가 늘 허용하는 dodok 도구(`mcp__dodok__*`)는 false, `acceptEdits` 의 편집 도구(`Edit`·`Write`·`MultiEdit`·`NotebookEdit`)는 false, 그 밖은 true → `permissionDecision: "ask"`.
  - 명령 런: 프롬프트는 `/<name>`·`/<name> <args>` 글 그대로(이미지·머리말 없음, `turnFacts` 훅은 그대로). Claude 막는 목록(`checkCommand("claude", …)`)이면 런 오류 `VALIDATION`(이중 방어).
  - 결과(C17): 마지막 result 에 `local_command` 가 있으면 final 글 = result 글(빈 글 그대로 — 서버가 한 줄을 붙인다), 그 사이 assistant 글은 버린다. `num_turns: 0` result 를 명령 런에서는 끝으로 본다(`stream-map` 의 「resume 직후 빈 result」 버림은 명령 런에서 끄기).
  - `commands.list`: 그 프로젝트 cwd 로 감싸개를 만들고 프롬프트 없는 query 에서 `supportedCommands()` → `builtin` 이 아닌 것과 내장 중 `checkCommand("claude")` 를 지나는 것을 `AgentCommand` 로(설명 앞 `(user) ` 꼴은 그대로). 상한 30초 안. 능력 `commands`.

- [ ] **Step 1: 실패하는 시험** — `command-wrappers.test.ts`(실제 임시 디렉터리): 두 감싸개 꼴·링크 대상, 원본 없는 링크 생략, `dispose` 뒤 없음, 사람 폴더 변경 0. `run.test.ts`: `command run sends raw prompt without header`, `blocked claude command → VALIDATION error, no query`, `local_command result replaces assistant text (compact replays previous answer)`, `num_turns 0 result ends a command run`, `query options carry plugins, disableAllHooks, disableSkillShellExecution`, `PreToolUse asks for Bash in default mode`, `PreToolUse does not ask for Edit in acceptEdits or for mcp__dodok__post`. `connection.test.ts`: `commands.list returns non-builtin commands with aliases`, `hello capabilities include commands`.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/runner test`.
- [ ] **Step 3: 구현** — 위 그대로. `fake-query.ts` 에 `supportedCommands` 와 result `local_command` 를 낼 자리.
- [ ] **Step 4: 통과 확인** — 러너 시험, typecheck. 실행 수.
- [ ] **Step 5: 커밋** — `feat(runner): run agent commands and load user/project commands safely`

### Task 4: OpenClaw 플러그인

**Files:**
- Modify: `packages/openclaw-plugin/src/channel.ts`, `packages/openclaw-plugin/src/inbound.ts`, `packages/openclaw-plugin/src/bridge-client.ts`(hello 능력)
- Test: `packages/openclaw-plugin/test/channel.test.ts`, `packages/openclaw-plugin/test/inbound.test.ts`, `packages/openclaw-plugin/test/bridge-client.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `delivery.command` 가 있으면 — `checkCommand("openclaw", …)` 실패면 그 인바운드를 거절(ack 오류), 통과면 `body`·`bodyForAgent`·`rawBody`·`commandBody` = `/<name>[ <args>]`, 채널 머리말·`ChannelPromptContext`·최근 대화 없음, `extra` 에서 `CommandInterpretationSuppressed` 를 뺀다, ingress 에 `command: { allowTextCommands: true, hasControlCommand: true }` 와 명령 허가가 되도록 `useAccessGroups: false`·`modeWhenAccessGroupsOff: "allow"`(정확한 자리는 2026.9.4 `openclaw/plugin-sdk/channel-ingress-runtime` 타입에서 확인 — 빌더 확인 보고 a). `command` 가 없으면 지금 그대로(해석 끔). hello 능력 `commands`.

- [ ] **Step 1: 실패하는 시험** — `channel.test.ts`: `command delivery enables command interpretation with raw body`, `plain delivery keeps CommandInterpretationSuppressed`, `plain text "/model x" stays suppressed`, `blocked openclaw command rejected`. `bridge-client.test.ts`: hello capabilities include commands.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/openclaw-plugin test`(패키지 이름은 그 `package.json`).
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인.** 실행 수.
- [ ] **Step 5: 커밋** — `feat(plugin): pass dodok-approved commands to the gateway`

### Task 5: 웹 — 작성기 자동완성

**Files:**
- Create: `apps/web/src/features/composer/CommandList.tsx`, `apps/web/src/features/composer/commands.ts`(쿼리·트리거 판정)
- Modify: `apps/web/src/features/composer/Composer.tsx`, `apps/web/src/features/composer/slash.ts`, `apps/web/src/features/composer/useSendMessage.ts`
- Test: Create `apps/web/src/features/composer/Composer.commands.test.tsx`; Modify `apps/web/src/features/composer/Composer.slash.test.tsx`

**Interfaces:**
- Consumes: Task 2 GET 두 경로, Task 1 `parseAgentCommand`·`checkCommand`.
- Produces: `useAgentCommands(conversationId | channelId)`, `commandTrigger(doc, opts): { agentId: string; query: string } | null` — 멘션 칩 하나 + 공백 뒤 `/` 로 시작하는 글자(또는 1:1 에이전트 DM 맨 앞 `/`). 목록은 `name`·`aliases` 가 query 로 시작하는 것, `MentionList` 와 같은 꼴·키보드. 고르면 `/<name> ` 을 넣는다. 보내기 전 `parseAgentCommand` → `checkCommand` 실패면 보내지 않고 작성기 아래 `message`. `supported: false` 면 목록 대신 「이 에이전트는 명령을 지원하지 않습니다 — 러너·플러그인을 업데이트하세요」 한 줄. `/stop`(멘션 없음)은 지금 그대로.

- [ ] **Step 1: 실패하는 시험** — `Composer.commands.test.tsx`: `typing / after mention chip opens that agent's commands`, `alias match (user-skill) shows the skill`, `choosing inserts "/name "`, `1:1 agent DM opens list at start`, `blocked command shows reason and does not send`, `unsupported agent shows update line`, `"/stop" still stops`. `Composer.slash.test.tsx` 기존 통과.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/web test -- composer`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** — 웹 혼자 전체, typecheck·lint·fmt. 실행 수.
- [ ] **Step 5: 브라우저 확인(워커)** — dev:fake(가짜 러너·플러그인이 `commands` 능력·목록을 알리게 `apps/server/scripts/dev-fake.ts` 와 `apps/server/test/fakes/fake-runner.ts` 를 늘린다 — 이 둘도 이 태스크 경계) + 웹, 워크트리 전용 포트. `@coder /` 목록·`@coder /compact` → 「`/compact` 완료」, `@dev /status`, `@dev /restart` 막힘 문구. 390·1280px. 연 탭·서버는 닫는다.
- [ ] **Step 6: 커밋** — `feat(web): agent command autocomplete in the composer`

### Task 6: 실제 런 0회 확인·문서

**Files:**
- Modify: `docs/guides/live-smoke.md`, `docs/manual/user-guide.md`, `docs/guides/agent-guide.md`, `docs/guides/plan.md`

- [ ] **Step 1: 러너 하네스** — 이 브랜치의 `pack:runner` + 서버 dev + 가짜 Messages API: 임시 configDir 에 명령(`allowed-tools: Bash(*)` 포함)·스킬, 임시 프로젝트에 명령. 앱에서 `@agent /` 목록에 `user:…`·`project:…`·별칭, `@agent /context` 결과 글, `/compact` 가 앞 답을 다시 게시하지 않음, `/user:at-cmd` 가 승인 카드를 띄움, `settings.json` 표지 0. 모델 런 0회.
- [ ] **Step 2: OpenClaw** — dev Gateway(`docs/guides/live-smoke.md` 「전제」)에서 모델 런 없이 되는 `@dev /status`·`/help` 의 응답이 채널에 오는지, admission 이 `handled` 일 때 런이 「`/status` 완료」 또는 응답 글로 닫히는지. Gateway 의 `commands.ownerAllowFrom` 값과 결과를 보고에. dev Gateway 를 띄울 수 없으면 그 사실과 까닭을 보고하고 건너뛴다.
- [ ] **Step 3: 문서** — 네 문서. `---` 앞 빈 줄·표 줄을 눈으로.
- [ ] **Step 4: 커밋** — `docs: agent commands`

러너 0.8.0·플러그인 판 올리기는 병합 뒤 조율자.
