# 작성기 에이전트 칩·컨텍스트 세부 Implementation Plan

> **For agentic workers:** 이 저장소에서는 Orca 워커가 태스크를 맡는다(`AGENTS.md` 「작업 방식」). 브리프가 이 계획의 태스크를 가리키고, 워커는 이 계획과 스펙을 함께 읽는다. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 작성기 위 러너 에이전트 상태 줄을 모델·노력치·권한 칩과 원형 컨텍스트 게이지로 바꾸고, 러너가 알린 실제 모델 목록과 런 끝 컨텍스트 세부를 보인다.

**Architecture:** 러너가 hello 의 프로그램 상태에 `models`(SDK `supportedModels()`)를, `run.final.usage` 에 `contextBreakdown`(SDK `getContextUsage({ detail: "summary" })` 를 줄인 것)을 싣는다. 어댑터가 세부를 `RunUsage` 로 옮기고 서버가 `runs.usage` 에 저장한다. 대화 설정 응답·`agent-ceilings` 가 마지막 세부와 모델 목록을 실어 웹 칩·게이지가 그린다.

**Tech Stack:** Zod(shared), Claude Agent SDK 0.3.283(runner), Socket.IO wire, Fastify·drizzle(server), React·TanStack Query·Radix dropdown/tooltip(web).

**Spec:** `docs/superpowers/specs/2026-11-17-composer-agent-chips-design.md` — 결정 C1~C11 은 그 3장. 이 계획은 그 번호로 가리킨다.

## Global Constraints

- 러너 에이전트만 — OpenClaw 에이전트에는 칩을 그리지 않는다(C5).
- 새 필드는 모두 **선택**이다. `RUNNER_PROTOCOL` 은 올리지 않는다. `RunnerHello` 최상위에 새 키를 두지 않는다(`strictObject` 라 옛 서버가 거절한다) — 프로그램 상태(`RunnerProgramStatus`) 안에만.
- `getContextUsage` 는 `detail: "summary"` 만(C6), 상한 **2000ms**(C7). 실패·시간 초과·중지된 런이면 세부 없이 지금처럼 final.
- 퍼센트: 세부가 있으면 세부의 `percentage` 를 `0..100` 으로 자른 값, 없으면 지금 `round(contextTokens/contextWindow×100)`(C8).
- 세부에는 `mcp_tools`·`memory_files`·`agents`·`skills` 줄별 목록을 싣지 않는다(경로·이름 노출).
- 상한: `categories` ≤ 32줄, `name` ≤ 80자, `models` ≤ 32개, 모델 `value` ≤ 128자(지금 `SettingModel` 상한과 같게), `displayName` ≤ 80자.
- 목록 받기가 모델 런(토큰 사용)이 되면 안 된다. 시험은 모두 가짜 SDK — 실제 모델 런 금지.
- 러너 `package.json` 판본은 태스크에서 올리지 않는다(배포는 조율자 — 0.6.0, `docs/guides/runner-release.md`).
- 화면 문구는 2026-11-10 문구 정리 기준 — 라벨·값·단추. 설명 문단 없음.
- 공통: Conventional Commits·패키지 스코프, 경로 명시 stage.

## Review Focus

1. **세부를 받다 SDK 가 멈추거나 던져도 런은 2초 안에 final 로 끝나고 답이 남는다.** (Task 2 시험 `getContextUsage hangs → final without breakdown within 2s`)
2. **새 러너(세부·목록 실음)가 옛 서버 스키마에 붙어도 hello·final 이 거절되지 않는다** — 옛 `RunnerProgramStatus`·`RunnerRunFinal` 파싱이 새 키를 지운다. (Task 1 시험)
3. **저장된 모델이 목록에 없으면(직접 입력·러너 이동) 칩에 그대로 보이고 말없이 바뀌지 않는다.** (Task 5 시험)
4. **1M 창 모델에서 게이지 퍼센트와 팝오버 합계가 같은 수를 말한다** — 응답의 `contextPercent` 가 세부 `percentage` 에서 나온다. (Task 4 시험)
5. **러너가 끊기면 모델 목록이 빈 목록으로 오고 칩이 고정 목록으로 떨어진다** — 비거나 고를 수 없게 되지 않는다. (Task 4·5 시험)

---

### Task 1: 계약 — 세부·모델 목록 스키마

**Files:**
- Modify: `packages/shared/src/runner/index.ts`(`RunnerRunFinal.usage`, `RunnerProgramStatus`)
- Modify: `packages/shared/src/domain/index.ts`(`RunUsage`)
- Modify: `packages/shared/src/conversations/index.ts`(`ConversationAgentSettings`, `AgentCeiling`)
- Test: `packages/shared/test/runner.test.ts`, `packages/shared/test/domain.test.ts`

**Interfaces:**
- Produces (`packages/shared/src/runner/index.ts`, 패키지 루트에서 export):
  - `RunnerContextCategory = z.object({ name: z.string().max(80), tokens: z.int().min(0), kind: z.enum(["used","free","buffer","deferred"]) })`
  - `RunnerContextBreakdown = z.object({ model: z.string().max(128), totalTokens: z.int().min(0), maxTokens: z.int().min(1), percentage: z.number().min(0), categories: z.array(RunnerContextCategory).max(32) })`
  - `RunnerModelOption = z.object({ value: z.string().min(1).max(128), displayName: z.string().max(80), efforts: z.array(RunnerEffort).max(5) })`
  - `RunnerRunFinal.usage.contextBreakdown?: RunnerContextBreakdown`
  - `RunnerProgramStatus.models?: RunnerModelOption[]`(`.max(32)`)
  - `RunUsage.contextBreakdown?: RunnerContextBreakdown`
  - `ConversationAgentSettings` 에 `context: RunnerContextBreakdown.nullable()`, `models: z.array(RunnerModelOption)`
  - `AgentCeiling` 에 `models: z.array(RunnerModelOption)`

- [ ] **Step 1: 실패하는 시험** — `runner.test.ts` 에 `RunnerRunFinal parses usage.contextBreakdown`(categories 4줄, kind 넷 다) / `rejects 33 categories` / `RunnerProgramStatus keeps models` / **옛 모양 흉내**: 새 키를 뺀 옛 스키마 사본이 아니라, 새 스키마에서 `RunnerProgramStatus.omit({ models: true }).parse(withModels)` 결과에 `models` 키가 없음(지움, 거절 아님)을 단언. `domain.test.ts` 에 `RunUsage accepts contextBreakdown`.
- [ ] **Step 2: 실행해 실패 확인** — `pnpm -F @dodok/shared test` → 새 시험 FAIL.
- [ ] **Step 3: 스키마 구현** — 위 Interfaces 그대로. `RunnerEffort` 를 runner/index.ts 로 import(domain 에 있다). `RunUsage` 는 domain 에 있으므로 `RunnerContextBreakdown` 을 domain 에 정의하고 runner 가 import 하는 쪽이 순환을 피하면 그렇게 옮긴다(runner 는 이미 domain 을 import 한다).
- [ ] **Step 4: 통과 확인** — `pnpm -F @dodok/shared test`, `pnpm typecheck`(서버·웹이 `ConversationAgentSettings` 리터럴을 만드는 곳이 깨지면 다음 태스크 몫 — 이 태스크에서는 `context: null, models: []` 로 채워 typecheck 를 통과시킨다: `apps/server/src/modules/conversations/agent-settings.ts` `toConversationAgentSettings`, `agent-settings.routes.ts` ceilings, `apps/web/src/features/composer/AgentSettingsBar.tsx` `rowOf`). 실행 개수를 보고에 적는다.
- [ ] **Step 5: 커밋** — `feat(shared): context breakdown and model list contracts`

### Task 2: 러너 — 런 끝 세부

**Files:**
- Modify: `packages/claude-runner/src/drivers/claude/sdk.ts`(`SdkQuery`)
- Modify: `packages/claude-runner/src/drivers/claude/run.ts`(`attempt` 의 final 길)
- Create: `packages/claude-runner/src/drivers/claude/context-usage.ts`
- Modify: `packages/claude-runner/test/helpers/fake-query.ts`
- Test: `packages/claude-runner/test/run.test.ts`, `packages/claude-runner/test/context-usage.test.ts`

**Interfaces:**
- Consumes: Task 1 `RunnerContextBreakdown`.
- Produces:
  - `SdkQuery` 에 `getContextUsage(opts?: { detail?: "summary" | "full" }): Promise<SDKControlGetContextUsageResponse>`(SDK 타입은 sdk.ts 에서만 import·재export)
  - `toContextBreakdown(raw: SDKControlGetContextUsageResponse): RunnerContextBreakdown | undefined` — 필드 다섯만, `categories` 는 `{name, tokens, kind}` 만, 0 토큰 줄 유지(웹이 숨김), 32줄 넘으면 자름, 스키마 safeParse 실패면 undefined
  - `CONTEXT_USAGE_TIMEOUT_MS = 2000`
  - `fetchContextBreakdown(q: SdkQuery, timeoutMs?: number): Promise<RunnerContextBreakdown | undefined>` — 던지지 않는다

- [ ] **Step 1: 실패하는 시험** — `context-usage.test.ts`: `toContextBreakdown drops memoryFiles/mcpTools/gridRows`, `keeps percentage over 100`, `returns undefined on malformed`. `run.test.ts`: `final carries contextBreakdown when getContextUsage resolves`, `getContextUsage hangs → final without breakdown within 2s`(가짜 타이머), `getContextUsage throws → final without breakdown`, `aborted run does not call getContextUsage`, `getContextUsage is called with detail summary before input closes`(가짜 query 가 입력이 닫힌 뒤 부르면 던지게).
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/runner test` → FAIL.
- [ ] **Step 3: 구현** — `fake-query.ts` 에 `getContextUsage` 를 더한다(기본 응답 하나 + 시험이 덮을 자리). `attempt` 에서 `item.final` 을 받으면 `interrupted` 가 아닐 때 `await fetchContextBreakdown(q)` 뒤 `ctx.sink.final({ ...rest, usage: { ...rest.usage, contextBreakdown } … })` 하고 그다음 `end()`. for-await 안에서 await 하므로 그 사이 오는 메시지는 지금 `ended` 검사로 버려진다 — 순서를 시험이 단언한다.
- [ ] **Step 4: 통과 확인** — `pnpm -F @dodok/runner test`, 실행 개수 기록.
- [ ] **Step 5: 커밋** — `feat(runner): attach context breakdown to run.final`

### Task 3: 러너 — 모델 목록

**Files:**
- Modify: `packages/claude-runner/src/driver.ts`(`ProgramDetection` 에 `"models"`)
- Modify: `packages/claude-runner/src/drivers/claude/sdk.ts`(`SdkPort` 에 `listModels`)
- Modify: `packages/claude-runner/src/drivers/claude/index.ts`(`detect`)
- Modify: `packages/claude-runner/src/main.ts`(드라이버에 `modelsCwd` 전달 — 첫 루트 경로)
- Modify: `packages/claude-runner/test/helpers/fake-query.ts`
- Test: `packages/claude-runner/test/connection.test.ts`, `packages/claude-runner/test/models.test.ts`

**Interfaces:**
- Consumes: Task 1 `RunnerModelOption`.
- Produces:
  - `SdkPort.listModels(args: { options: SdkOptions }): Promise<ModelInfo[]>` — 실제 구현은 빈 프롬프트 스트림(아무것도 yield 하지 않고 기다리는 async generator)으로 `query()` 를 열고 `supportedModels()` 를 받은 뒤 `close()`. 프롬프트를 보내지 않으므로 모델 호출이 없다 — 이 성질을 런 0회 하네스(Task 6)가 확인한다.
  - `toModelOptions(list: ModelInfo[]): RunnerModelOption[]` — `value`·`displayName`·`efforts = supportedEffortLevels ?? []`, `value === "default"` 줄도 그대로 싣는다(웹이 「기본」에 합친다 — C9), 32개 자름
  - `ClaudeDriverOptions.modelsCwd?: string`, `MODELS_TIMEOUT_MS = 10_000`
  - `detect` 는 `available` 일 때만 목록을 받는다. 실패·시간 초과면 `models` 를 빼고 돌려준다(던지지 않는다). 같은 CLI 선택(`lastChoice`)이면 앞 결과를 재사용한다(재연결마다 CLI 를 띄우지 않게).

- [ ] **Step 1: 실패하는 시험** — `models.test.ts`: `toModelOptions maps supportedEffortLevels`, `keeps default row`, `caps at 32`. `connection.test.ts`: `hello program status carries models from detect`, `listModels failure → hello without models`, `second detect with same CLI reuses models`.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/runner test`.
- [ ] **Step 3: 구현** — 위 Interfaces. `listModels` 의 options 는 `buildQueryOptions` 를 쓰지 않고 env 허용 목록(`ENV_ALLOWLIST`)·`cwd: modelsCwd`·`pathToClaudeCodeExecutable`·`settingSources` 를 런과 같게 둔다(로그인·`availableModels` 가 런과 같게 걸리도록).
- [ ] **Step 4: 통과 확인** — `pnpm -F @dodok/runner test`, `pnpm -F @dodok/runner typecheck`.
- [ ] **Step 5: 커밋** — `feat(runner): report supported models in hello`

### Task 4: 어댑터·서버 — 저장과 응답

**Files:**
- Modify: `packages/runner-adapter/src/runner-adapter.ts`(`onRunFinal` 의 usage 복사·`measured`)
- Modify: `apps/server/src/modules/conversations/agent-settings.ts`(`contextPercentOf`, `toConversationAgentSettings`, 새 `contextOf`·`runnerModels`)
- Modify: `apps/server/src/modules/conversations/agent-settings.routes.ts`(ceilings 에 `models`)
- Modify: `apps/server/scripts/dev-fake.ts`(가짜 러너 둘의 `programs[].models`, `fakeContextUsage` 옆 세부, `run.final` 에 세부)
- Test: `packages/runner-adapter/test/runner-adapter.test.ts`, `apps/server/test/agent-settings.routes.test.ts`, `apps/server/test/agent-settings.store.test.ts`, `apps/server/test/dev-fake.test.ts`

**Interfaces:**
- Consumes: Task 1 스키마.
- Produces:
  - `contextOf(db, key): RunnerContextBreakdown | null` — `contextPercentOf` 와 같은 런 고르기(같은 20행·스레드 규칙)로 세부가 실린 가장 최근 런. **세부와 퍼센트는 같은 런에서** 나와야 한다 — 두 함수가 한 조회를 나눠 쓰게 `lastContextRun(db, key)` 하나로 묶는다.
  - `contextPercentOf` — 그 런에 세부가 있으면 `clamp(round(percentage), 0, 100)`, 없으면 지금 계산.
  - `runnerModels(runners, agent: { runnerTokenId; program }): RunnerModelOption[]` — 붙은 러너의 그 프로그램 `models ?? []`, 끊겼으면 `[]`.
  - 어댑터: `final.usage?.contextBreakdown` 을 `usage.contextBreakdown` 으로 옮긴다. `measured` 조건에 `contextBreakdown !== undefined` 를 더한다.
  - dev:fake: `DEV_FAKE_MODELS: RunnerModelOption[]`(`default`·`opus`(표시 `Opus 5.5`, 다섯 단계)·`sonnet`(`Sonnet 5.5`, low·medium·high)·`haiku`(`Haiku 5.5`, 빈 목록)), 「dev-fake 제한」 러너는 `models` 를 싣지 않는다(옛 러너 흉내 — C4 손 확인용). `fakeContextBreakdown(sessionKey)` 는 `fakeContextUsage` 와 같은 수로 Messages·System prompt·System tools·Free space·Autocompact buffer·MCP tools (deferred) 여섯 줄.

- [ ] **Step 1: 실패하는 시험** — 어댑터: `run.final contextBreakdown reaches RunUsage`, `breakdown-only usage is stored`. 서버 store: `contextPercent comes from breakdown percentage (1M window: tokens 50k, window 1M, breakdown percentage 25 → 25)`, `percentage 130 → 100`, `run without breakdown keeps old percent`, `thread run uses its own breakdown`. routes: `GET agent-settings returns context and models`, `member gets models of another owner's runner`, `disconnected runner → models []`, `agent-ceilings returns models`. dev-fake: `main fake runner hello has models, limited has none`.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/runner-adapter test`, `pnpm -F @dodok/server test -- agent-settings dev-fake`.
- [ ] **Step 3: 구현** — 위 Interfaces.
- [ ] **Step 4: 통과 확인** — 두 패키지 시험 전체를 각각 혼자 돌린다(`pnpm test` 를 typecheck 와 동시에 돌리지 않는다). 실행 개수 기록.
- [ ] **Step 5: 커밋** — `feat(server): serve context breakdown and runner models to the settings bar`

### Task 5: 웹 — 칩과 게이지

**Files:**
- Modify: `apps/web/src/features/composer/AgentSettingsBar.tsx`(`SettingsLine` 을 칩 줄로, `settingsSummary` 제거 또는 접근성 라벨로)
- Modify: `apps/web/src/features/composer/AgentSettingsPopover.tsx` → 칩 셋으로 나눈다. Create: `apps/web/src/features/composer/AgentSettingChips.tsx`, `apps/web/src/features/composer/ContextGauge.tsx`
- Test: `apps/web/src/features/composer/AgentSettingsBar.test.tsx`, Create: `apps/web/src/features/composer/ContextGauge.test.tsx`

**Interfaces:**
- Consumes: Task 4 응답의 `context`·`models`(새 세션 창은 `useAgentCeilings` 의 `models`).
- Produces:
  - `AgentSettingChips({ row, models, canRaise, onSave }: { row: ConversationAgentSettings; models: RunnerModelOption[]; canRaise: boolean; onSave: (patch: AgentSettingsPatch) => Promise<boolean> })`
  - `modelChoices(models, saved: string | null): Array<{ value: string | null; label: string }>` — 목록이 비면 `MODEL_PRESETS` + 「직접 입력」(C4). `value === "default"` 줄은 「기본」(null) 하나로 합친다(C9). 저장값이 목록에 없으면 맨 위에 그 값 그대로.
  - `effortChoices(models, model: string | null): RunnerEffort[]` — 모델 줄의 `efforts`, 「기본」이면 `default` 줄의 것, 비었거나 목록 없음이면 `RUNNER_EFFORTS` 전부. 지금 값이 목록 밖이면 칩에 그대로 보이고 `aria-invalid` + 경고 아이콘.
  - `ContextGauge({ percent, context }: { percent: number | null; context: RunnerContextBreakdown | null })` — SVG 원(지름 16px)·퍼센트 글, 없으면 「—」. 트리거는 `button`(키보드 초점으로 열림). 팝오버: `formatTokens(n)`(`248.5k`·`1.2M`) `totalTokens / maxTokens`, `used`·`free`·`buffer` 줄은 `tokens/maxTokens` %(소수 1자리), `deferred` 는 「불러올 때만」 아래 토큰 수, 0 토큰 줄 숨김, `percentage > 100` 이면 「창 초과」 한 줄. `context` 가 null 이고 percent 만 있으면 팝오버는 퍼센트 한 줄.

- [ ] **Step 1: 실패하는 시험** — `AgentSettingsBar.test.tsx`: `picking a model chip saves immediately (PATCH model)`, `new-session window keeps chip choice in pending`, `models [] falls back to sonnet/opus/haiku + 직접 입력`, `saved model not in list stays shown at top`, `default row merges into 기본`, `effort chip lists only the model's efforts`, `out-of-list effort shows warning and is not changed`, `acceptEdits locked for member (RAISE_LOCKED)`, `save failure shows 저장하지 못했습니다`, `OpenClaw agents get no chips`. `ContextGauge.test.tsx`: `shows — without runs`, `focus opens breakdown with 248.5k / 800k`, `hides zero rows`, `deferred rows under 불러올 때만`, `over 100 shows 창 초과`.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/web test -- composer`.
- [ ] **Step 3: 구현** — 칩은 `ui/dropdown-menu.tsx`, 게이지 팝오버는 `ui/tooltip.tsx`(초점·호버 둘 다 연다). 좁은 화면은 `flex-wrap`.
- [ ] **Step 4: 통과 확인** — 웹 시험 혼자 전체, `pnpm lint`, `pnpm fmt`. 실행 개수 기록.
- [ ] **Step 5: 브라우저 확인(워커)** — `dev:fake` + 웹 dev, `http://localhost:5173`. 씨앗 채널 「세션」의 `@coder` 에 글을 보내 런 하나 → 게이지에 퍼센트, 호버·Tab 초점으로 세부 여섯 줄. 모델 칩에 `Opus 5.5`·`Sonnet 5.5`·`Haiku 5.5`, `Sonnet 5.5` 를 고르면 노력치가 셋. `POST /__devfake/runner {connected:false}` 뒤 새로고침 → 모델 칩이 고정 목록. 390·1280px 에서 가로 스크롤 없음(`scrollWidth`). 탭은 백그라운드로 열고 연 탭은 닫는다.
- [ ] **Step 6: 커밋** — `feat(web): inline model/effort chips and context gauge`

### Task 6: 런 0회 하네스·문서

**Files:**
- Modify: `packages/claude-runner/scripts/fake-messages-api.ts`(필요하면 — 요청 수를 세는 자리)
- Modify: `docs/guides/live-smoke.md`(「Claude 러너 런 0회 하네스」 절에 세부·목록 확인 한 단계)
- Modify: `docs/manual/user-guide.md`(작성기 위 칩·게이지)
- Modify: `docs/guides/plan.md`(8장 완료 항목 한 줄)

- [ ] **Step 1: 하네스** — 번들 CLI + 가짜 Messages API 로 러너를 붙여 (a) hello 의 `models` 가 실리고 그동안 가짜 API 의 `/v1/messages` 요청 수가 0, (b) 런 하나 뒤 `run.final.usage.contextBreakdown` 이 실리고 `getContextUsage` 가 추가 `/v1/messages` 를 만들지 않는지(`count_tokens` 포함) 본다. (c) C8: 찍힌 `maxTokens`·`rawMaxTokens`·`used+free+buffer` 합을 보고에 적는다 — `maxTokens` 가 합과 다르면 **멈추고 조율자에게 보고**(분모를 바꿀지는 조율자가 정한다).
- [ ] **Step 2: 문서** — 위 세 문서. oxfmt 가 `.md` 를 보지 않으니 `---` 앞 빈 줄·표 줄을 눈으로 본다.
- [ ] **Step 3: 커밋** — `docs: composer chips, context breakdown, runner 0.6.0 harness step`

배포(러너 0.6.0 판 올리기·태그)는 병합 뒤 조율자가 `docs/guides/runner-release.md` 로 한다.
