# 러너 세션 설정 Implementation Plan

> **For agentic workers:** 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 브리프가 이 계획의 태스크를 가리키고, 워커는 이 계획과 스펙을 함께 읽는다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 러너 에이전트의 모델·effort·권한 모드를 에이전트 정의에서 대화 × 에이전트 설정으로 옮기고, 작성기 위 상태 줄에서 보고 바꾸며 컨텍스트 % 를 보인다.

**Architecture:** 서버가 `conversation_agent_settings` 행(없으면 에이전트의 「새 세션 시작값」)으로 실행마다 `run.start.agent` 의 `model`·`effort`·`permissionMode` 를 채운다. 권한 「기본」(null)은 러너 어댑터가 그 연결의 hello 상한으로 `min(default, 상한)` 을 계산한다. 러너는 effort 를 SDK 옵션으로 넘기고 실행 끝 보고에 컨텍스트 토큰·창 크기를 싣는다.

**Tech Stack:** Zod(shared), Fastify·drizzle·better-sqlite3(server), Socket.IO wire, Claude Agent SDK 0.3.283(runner), React·TanStack Query(web).

**Spec:** `docs/superpowers/specs/2026-11-11-runner-session-settings-design.md` — 결정 S1~S14 는 그 3장. 이 계획은 그 번호로 가리킨다.

## Global Constraints

- 러너(`provider = "runner"`) 에이전트만. OpenClaw 에이전트에는 설정 행·상태 줄·REST 결과가 없다(S1).
- effort 값: `low`·`medium`·`high`·`xhigh`·`max`, 또는 null(기본).
- 권한 모드: shared `RUNNER_PERMISSION_MODES`(`plan`·`dontAsk`·`default`·`acceptEdits`), 또는 null(「기본」). `bypassPermissions` 없음.
- 권한 규칙(S2): 그 대화를 읽을 수 있는 사람은 `permissionModeRank(x) <= permissionModeRank("default")` 인 값과 null 을 고른다. `acceptEdits` 는 그 에이전트의 연결 주인 또는 admin 이상(`agentActor(...).ownsConnection` 또는 역할). 그 러너의 hello 상한을 넘는 값은 누구도 저장하지 못한다.
- 「기본」 권한 계산(S5): `null → 낮은 쪽(default, 상한)`. 사람이 고른 값이 상한을 넘으면 깎지 않는다 — 러너가 `RUNNER_CEILING` 으로 거절하는 지금 길.
- 옛 러너 호환: `RunnerRunAgent` 는 `z.object`(strict 아님) — 서버가 `effort` 를 더 실어도 옛 러너는 무시한다. 옛 러너는 `allowedTools` 를 요구하므로 서버는 그 필드를 늘 `null` 로 계속 보낸다. `RUNNER_PROTOCOL` 은 올리지 않는다.
- 화면 문구는 2026-11-10 문구 정리 기준 — 라벨·값·단추, 막힌 선택지는 `DisabledHint` 사유 한 줄. 설명 문단 없음.
- 러너 `package.json` 판본은 태스크에서 올리지 않는다(배포는 조율자 — 0.5.0).
- 공통: Conventional Commits·패키지 스코프, 경로 명시 stage, 실제 모델 런 금지.

## Review Focus

1. **새 세션 첫 글의 설정이 권한 위반이면 글 전체가 거절되고 대화도 설정 행도 남지 않는다** — member 가 손으로 만든 `message.send` 로 `acceptEdits` 를 실어도. (Task 3 시험)
2. **같은 `clientMsgId` 재전송이 설정을 두 번 쓰거나 다른 값으로 덮지 않는다** — 첫 전송의 값이 남는다. (Task 3 시험)
3. **러너 상한이 내려간 뒤 저장된 「기본」(null)은 새 상한 안으로 계산되고, 사람이 고른 `acceptEdits` 는 깎이지 않고 `RUNNER_CEILING` 카드가 된다.** (Task 2 시험)
4. **채널에서 러너 에이전트를 빼거나 보관해도 그 설정 행이 남아 다시 넣으면 돌아온다; 대화를 지우면 함께 지워진다.** (Task 2 시험)
5. **스레드 작성기의 상태 줄은 대화의 설정을 보이고, 컨텍스트 % 만 그 스레드 세션의 마지막 실행 값이다** — 스레드에 실행이 없으면 「—」. (Task 3 시험, Task 6 시험)

---

### Task 1: shared 계약

**Files:**
- Modify: `packages/shared/src/runner/index.ts`(`RunnerRunAgent`, `RunnerRunFinal`), `packages/shared/src/wire/index.ts`(`MessageSend`, 서버→클라이언트 이벤트 표)
- Create: `packages/shared/src/conversations/agent-settings.ts`(이름은 이웃 꼴을 따라 정한다 — 내보내기는 `packages/shared/src/index.ts`)
- Test: `packages/shared/test/runner-v2.test.ts`, `packages/shared/test/runner.test.ts`, 새 `packages/shared/test/agent-settings.test.ts`

**Interfaces:**
- Produces:
  - `RunnerEffort = z.enum(["low","medium","high","xhigh","max"])`
  - `RunnerRunAgent` 에 `effort: RunnerEffort.nullable().optional()`(옛 서버가 안 보내도 새 러너가 받게 optional). `allowedTools` 는 그대로 둔다(늘 null 로 보냄 — Global Constraints).
  - `RunnerRunFinal.usage` 에 `contextTokens: z.int().min(0).optional()`, `contextWindow: z.int().min(1).optional()`
  - `ConversationAgentSettings = z.object({ agentId: Id, model: z.string().min(1).max(128).nullable(), effort: RunnerEffort.nullable(), permissionMode: RunnerPermissionMode.nullable(), contextPercent: z.int().min(0).max(100).nullable() })`
  - `AgentSettingsPatch = z.object({ model: …nullable().optional(), effort: …nullable().optional(), permissionMode: …nullable().optional() })` + 하나 이상 있어야 한다는 refine
  - `MessageSend` 에 `agentSettings: z.array(AgentSettingsPatch.extend({ agentId: Id })).max(8).optional()` — `newConversation` 과 함께일 때만(refine), 같은 agentId 중복 금지
  - wire 서버→클라이언트 `"conversation.agent_settings": (p: { channelId: Id; conversationId: Id; settings: ConversationAgentSettings }) => void`
  - `SessionDefaults = z.object({ model, effort, permissionMode })`(세 필드 모두 nullable, `ConversationAgentSettings` 와 같은 값 규칙)

- [ ] **Step 1: 실패하는 시험** — `agent-settings.test.ts`: `AgentSettingsPatch` 빈 객체 거절, `bypassPermissions` 거절, effort `"extreme"` 거절; `MessageSend` 가 `conversationId` 와 `agentSettings` 를 함께 받으면 거절, `newConversation`+`agentSettings` 는 통과, 같은 agentId 둘이면 거절. `runner-v2.test.ts`: `effort` 없는 옛 `run.start.agent` 가 통과, `RunnerRunFinal.usage` 의 `contextWindow: 0` 거절.
- [ ] **Step 2:** `pnpm -F @dodok/shared test` — 새 사례 FAIL.
- [ ] **Step 3:** 위 스키마를 구현한다.
- [ ] **Step 4:** `pnpm -F @dodok/shared test` PASS, `pnpm typecheck`(다른 패키지가 깨지면 그 자리는 뒤 태스크 몫 — 깨진 곳 목록을 커밋 메시지가 아니라 보고에 적는다. shared 가 깨뜨린 타입은 이 태스크에서 기본값으로 메운다).
- [ ] **Step 5:** 커밋 `feat(shared): conversation agent settings contracts`

### Task 2: 서버 데이터·실행 경로

**Files:**
- Modify: `apps/server/src/db/schema.sqlite.ts`(새 표 `conversationAgentSettings`, `agents` 에 `sessionDefaultModel`·`sessionDefaultEffort`·`sessionDefaultPermissionMode`, 옛 `model`·`permissionMode`·`allowedToolsJson` 제거)
- Create: `apps/server/drizzle/0037_conversation_agent_settings.sql`(+ drizzle meta), `apps/server/src/modules/conversations/agent-settings.ts`(저장·조회)
- Modify: `apps/server/src/modules/runners/definition.ts`(`runnerAgentDefinition` 에 `conversationId?` 인자), `apps/server/src/app.ts:391`(호출자), `packages/runner-adapter/src/runner-adapter.ts`(`agentDefinition` 옵션 시그니처·`definitionOf`·`send` 의 「기본」 권한 계산), `apps/server/src/modules/agents/service.ts`(옛 열을 읽던 자리)
- Test: `apps/server/test/migrations.test.ts`(있는 이름을 쓴다), 새 `apps/server/test/agent-settings.store.test.ts`, `apps/server/test/orchestrator.runner.test.ts`, `packages/runner-adapter/test/runner-adapter.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `RunnerEffort`·`ConversationAgentSettings`
- Produces:
  - `getEffectiveSettings(db, { conversationId: string; agentId: string }): { model: string|null; effort: RunnerEffort|null; permissionMode: RunnerPermissionMode|null }` — 행이 있으면 그 값, 없으면 에이전트 시작값(S5·S10)
  - `upsertSettings(db, { conversationId, agentId, patch: AgentSettingsPatch, userId }): ConversationAgentSettingsRow`
  - `runnerAgentDefinition(db, workspaceId, agentId, tokenId, conversationId?)` — `agent.permissionMode` 가 null 일 수 있는 서버 쪽 타입(`RunnerAgentDefinition`), `effort` 포함, `allowedTools: null`
  - runner-adapter 옵션 `agentDefinition(providerAgentId, tokenId, conversationId?)`; `send` 가 deliver 의 세션 키(`parseDodokSessionKey`)에서 대화 id 를 꺼내 넘기고, `permissionMode === null` 이면 그 연결 hello 의 `claude` 상한과 `"default"` 중 `permissionModeRank` 가 낮은 쪽으로 채운다
- 마이그레이션(S8): 그 에이전트의 `agent_sessions` 가 있는 대화마다 `(conversation, agent, model, null, permission_mode)` 행을 넣고, 같은 값을 시작값 열에 복사한 뒤 옛 열을 지운다. 러너 에이전트만.

- [ ] **Step 1: 실패하는 시험** — store: 행 없음 → 시작값, 시작값도 없음 → 셋 다 null; upsert 부분 갱신이 다른 필드를 안 지운다; 대화 삭제 시 행 삭제; 채널에서 에이전트를 빼도 행 유지(Review Focus 4). 마이그레이션: 세션 둘·셋째 대화 없음인 에이전트 → 행 둘, 시작값 = 옛 값, 옛 열 없음, OpenClaw 에이전트 행 없음. runner-adapter: `permissionMode: null` + 상한 `plan` → run.start 의 `"plan"`; null + 상한 `acceptEdits` → `"default"`; 고른 `acceptEdits` + 상한 `default` → 깎지 않고 그대로 보내 러너 거절(Review Focus 3); `effort` 가 run.start 에 실림; `allowedTools: null`. orchestrator.runner: 대화 A 설정 opus·대화 B 행 없음(시작값 sonnet) → 각 실행의 model.
- [ ] **Step 2:** 해당 패키지 시험 FAIL 확인.
- [ ] **Step 3:** 스키마·마이그레이션(`pnpm -F @dodok/server` 의 drizzle 생성 스크립트 — 이웃 마이그레이션의 꼴을 따른다)·store·definition·adapter 구현. 옛 열을 쓰던 서버 자리(에이전트 목록·상세 응답)는 시작값을 싣도록 바꾼다 — 응답 모양은 Task 5 와 맞춘다(`sessionDefaults`).
- [ ] **Step 4:** `pnpm -F @dodok/server test`·`pnpm -F @dodok/runner-adapter test` PASS, `pnpm typecheck`.
- [ ] **Step 5:** 커밋 `feat(server): store runner settings per conversation and agent`

### Task 3: 서버 REST·권한·wire·첫 글·컨텍스트 %

**Files:**
- Create: `apps/server/src/modules/conversations/agent-settings.routes.ts`(이웃 라우트 꼴)
- Modify: `apps/server/src/auth/policies.ts`(새 정책 함수), `apps/server/src/realtime/socket.ts`(`message.send` 의 `agentSettings`), `apps/server/src/modules/messages/service.ts`(새 대화 생성 트랜잭션), 실행 끝 사용량 저장 자리(`runs.usage` 를 쓰는 곳 — `apps/server/src/modules/runs/orchestrator.ts`), `apps/server/src/app.ts`(라우트 등록)
- Test: 새 `apps/server/test/agent-settings.routes.test.ts`, `apps/server/test/roles.matrix.test.ts`, `apps/server/test/messages.send.test.ts`(있는 이름을 쓴다)

**Interfaces:**
- Consumes: Task 2 의 `getEffectiveSettings`·`upsertSettings`, `agentActor`(`apps/server/src/modules/connections/owner.ts`), `loadReadableChannel`(`apps/server/src/auth/channel-access.ts`)
- Produces:
  - `GET /api/v1/conversations/:id/agent-settings?threadRootId=<id>` → `{ settings: ConversationAgentSettings[] }` — S13 의 에이전트(채널 멤버인 러너 에이전트, DM 이면 그 에이전트), `contextPercent` 는 그 대화(스레드면 그 스레드)에서 그 에이전트의 마지막 실행의 `round(contextTokens / contextWindow × 100)`, 값이 없으면 null
  - `PATCH /api/v1/conversations/:id/agent-settings/:agentId` body `AgentSettingsPatch` → `ConversationAgentSettings`; 성공하면 채널 룸에 `conversation.agent_settings`
  - `authorizeSessionSettings({ canRead: boolean; ownsConnection: boolean; role: TeamRole|undefined; permissionMode: RunnerPermissionMode|null|undefined; ceiling: RunnerPermissionMode|null })` — 읽기 불가 404, `acceptEdits` 를 주인·admin 이 아니면 403, 상한 초과 400(`VALIDATION`)
  - 러너 실행 끝(`RunnerRunFinal.usage`)의 `contextTokens`·`contextWindow` 를 `runs.usage` 에 함께 저장

- [ ] **Step 1: 실패하는 시험** — routes: member 가 `plan`·`dontAsk`·`default`·null·모델·effort 저장 200; member 의 `acceptEdits` 403; 러너 주인 member 의 `acceptEdits` 200; admin 200; 상한 `default` 러너에 `acceptEdits` 400; 남의 DM 404; OpenClaw 에이전트 404; 저장 뒤 wire 이벤트 하나; contextPercent — 실행 없음 null, `contextTokens 42000 / contextWindow 100000` → 42, 스레드 질의는 스레드 실행만(Review Focus 5). message.send: `newConversation`+`agentSettings` → 대화와 행이 같이 생기고 그 글의 실행이 그 값; member 의 `acceptEdits` → 글 거절·대화·행 없음(Review Focus 1); 같은 `clientMsgId` 재전송에 다른 값 → 첫 값 유지(Review Focus 2); 채널 멤버가 아닌 에이전트 id → 거절. roles.matrix 에 새 라우트 줄.
- [ ] **Step 2:** FAIL 확인.
- [ ] **Step 3:** 구현.
- [ ] **Step 4:** `pnpm -F @dodok/server test` PASS(실행 수), `pnpm typecheck`.
- [ ] **Step 5:** 커밋 `feat(server): agent settings REST, permissions and first-message settings`

### Task 4: 러너 — effort·컨텍스트 사용량

**Files:**
- Modify: `packages/claude-runner/src/drivers/claude/run.ts`(`buildQueryOptions` — `effort`), `packages/claude-runner/src/drivers/claude/stream-map.ts`(result → `contextTokens`·`contextWindow`), `packages/claude-runner/src/ceiling.ts`(effort 는 천장 없음 — 손대지 않으면 손대지 않는다)
- Test: `packages/claude-runner/test/run.test.ts`, `packages/claude-runner/test/stream-map.test.ts`

**Interfaces:**
- Consumes: Task 1 `RunnerRunAgent.effort`, `RunnerRunFinal.usage.contextTokens/contextWindow`
- Produces: SDK `query()` 옵션 `effort`(null·없음이면 넣지 않음); `contextTokens` = 그 턴의 **마지막** API 호출의 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`(result 합계가 아니다 — 스트림의 마지막 assistant 메시지 usage), `contextWindow` = result `modelUsage[<그 모델>].contextWindow`(없으면 싣지 않음)

- [ ] **Step 1: 실패하는 시험** — run: `effort: "high"` → 옵션에 `effort: "high"`, null → 키 없음. stream-map: assistant 둘(usage 1000/0/500, 2000/100/30000) + result `modelUsage { "claude-opus-…": { contextWindow: 200000 } }` → `contextTokens 32100`, `contextWindow 200000`; modelUsage 없음 → 둘 다 없음.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** 구현 — SDK 0.3.283 `sdk.d.ts` 의 `effort`·`modelUsage` 꼴을 따른다.
- [ ] **Step 4:** `pnpm -F @dodok/runner test` PASS. 런 0회 하네스(`docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」)로 effort 가 CLI 요청에 실리는지 본다(가짜 Messages API 의 기록 파일). 모델 런 금지.
- [ ] **Step 5:** 커밋 `feat(runner): pass effort and report context usage`

### Task 5: 웹 — 에이전트 만들기·상세

**Files:**
- Modify: `apps/web/src/features/agents/RunnerAgentForm.tsx`(모델·권한 모드·허용 도구 칸 제거), `apps/web/src/features/connections/AgentDetail.tsx`(「새 세션 시작값」), 에이전트 생성·수정 API(`apps/server/src/modules/agents/routes.ts`·`actions.ts`·`service.ts` — `sessionDefaults` 받기, 옛 `model`·`permissionMode`·`allowedTools` 는 **무시**)
- Test: 이 화면의 시험 파일(`apps/web/src/features/agents/` 의 RunnerAgentForm 시험, `apps/web/src/features/connections/` 의 agentDetail 시험 — 있는 이름을 쓴다), `apps/server/test/agents.runner.test.ts`(있는 이름)

**Interfaces:**
- Consumes: Task 1 `SessionDefaults`, Task 2 의 시작값 열
- Produces: 에이전트 응답의 `sessionDefaults: SessionDefaults`(러너 에이전트만), `PATCH /api/v1/agents/:id` 의 `sessionDefaults` — 권한은 지금 에이전트 수정 권한, 권한 값은 그 러너 상한까지

- [ ] **Step 1: 실패하는 시험** — 만들기 폼에 「모델」·「권한 모드」·「허용 도구」 라벨이 없다; 상세에서 시작값 셋을 저장하면 PATCH 본문에 `sessionDefaults`; 상한 넘는 권한은 비활성+사유; 서버: 옛 클라이언트가 `model`·`permissionMode` 를 보내도 200 이고 무시.
- [ ] **Step 2:** FAIL. **Step 3:** 구현. **Step 4:** `pnpm -F @dodok/web test`·`pnpm -F @dodok/server test` PASS. **Step 5:** 커밋 `feat(web): move runner model and permission out of agent creation`

### Task 6: 웹 — 작성기 위 상태 줄

**Files:**
- Create: `apps/web/src/features/composer/AgentSettingsBar.tsx`, `apps/web/src/features/composer/AgentSettingsPopover.tsx`, `apps/web/src/features/conversations/agentSettings.ts`(쿼리·뮤테이션·wire 핸들러 연결 — 이웃 `queries.ts`·`mutations.ts` 꼴)
- Modify: `apps/web/src/features/composer/Composer.tsx`(상태 줄 자리, 새 세션의 보류 값을 `message.send` 의 `agentSettings` 로), `apps/web/src/realtime/handlers.ts`(`conversation.agent_settings`)
- Test: 새 `apps/web/src/features/composer/AgentSettingsBar.test.tsx`, `apps/web/src/features/composer/Composer.test.tsx`, `apps/web/src/realtime/handlers.test.ts`

**Interfaces:**
- Consumes: Task 3 REST·wire, Task 1 `MessageSend.agentSettings`
- Produces: 화면 — 줄마다 `@핸들 모델 · effort 값 · 권한 · 컨텍스트 N%` 와 「변경」; 「기본」은 「기본」, contextPercent null 은 「—」; 셋 넘으면 「러너 에이전트 N」 한 줄로 접힘. 팝오버 선택지는 스펙 5.4. 권한 선택지 비활성: `acceptEdits` 는 주인·admin 이 아니면, 상한 넘는 값은 누구나 — 사유는 `DisabledHint`.

- [ ] **Step 1: 실패하는 시험** — 상태 줄 값·「기본」·「—」·접기(넷이면 접힘); member 에게 `acceptEdits` 비활성; 저장하면 PATCH 하나; 다른 사람의 변경 wire 이벤트로 줄이 바뀜; 새 세션 창: 바꾼 값이 PATCH 없이 화면에만 있고 첫 `message.send` 에 `agentSettings` 로 실림, 창을 떠났다 오면 시작값(S11); 스레드 작성기는 대화 설정 + 스레드 컨텍스트 %(Review Focus 5).
- [ ] **Step 2:** FAIL. **Step 3:** 구현(문구 기준 — Global Constraints). **Step 4:** `pnpm -F @dodok/web test` PASS(실행 수). **Step 5:** 커밋 `feat(web): agent settings bar above the composer`

### Task 7: dev:fake·문서·화면 확인

**Files:**
- Modify: `apps/server/scripts/dev-fake.ts`(가짜 러너가 run 끝에 `contextTokens`·`contextWindow`, effort 받기), `docs/manual/user-guide.md`(에이전트 만들기·상세, 상태 줄), `docs/guides/agent-guide.md`(러너 에이전트 설정 문장이 있으면), `docs/guides/project-structure.md`(새 모듈·컴포넌트), `docs/guides/docker-deploy.md`(마이그레이션 0037 — 업데이트 절에 적을 것이 있으면)
- Test: `apps/server/test/dev-fake.test.ts`(가짜 러너 사용량)

- [ ] **Step 1:** dev:fake 변경과 그 시험.
- [ ] **Step 2:** 이 워크트리 전용 포트로 dev:fake + 웹을 띄워 BrowserOS neo(안 붙으면 독립 브라우저 — 보고에 적는다)로 본다: owner·member(mia) 각각 상태 줄 값·변경·`acceptEdits` 비활성, 새 세션에서 바꾸고 보내기·안 보내고 떠나기, 컨텍스트 % 표시, 에이전트 만들기에 세 칸 없음. 탭은 백그라운드로 열고 네가 연 탭은 닫는다. 띄운 것은 끈다.
- [ ] **Step 3:** 문서. 표·`---` 앞 빈 줄 확인.
- [ ] **Step 4:** `pnpm lint`·`pnpm fmt:check`·`pnpm typecheck`·`pnpm exec turbo run test --continue`(실행 수).
- [ ] **Step 5:** 커밋 `docs: runner session settings` (dev:fake 는 `feat(server): …` 로 따로)
