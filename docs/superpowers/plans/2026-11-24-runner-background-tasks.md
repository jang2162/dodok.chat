# 러너 백그라운드 작업 — 2단계 구현 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 Orca 가 살아 있으면 `scripts/orca-worker.sh` 워커가 태스크를 맡는다(AGENTS.md 「작업 방식」).

**Goal:** 러너 에이전트의 백그라운드 셸·서브에이전트가 런보다 오래 살고, 끝나면 처음 응답의 스레드에 이어서 답하며, 도는 작업을 활동 탭 런 카드에서 보고 끌 수 있게 한다.

**Architecture:** 러너 Claude 드라이버가 세션마다 CLI 프로세스(「세션 프로세스」)를 붙든다. SDK 의 작업 메시지를 작업 목록으로 줄여 서버에 보내고, CLI 가 스스로 연 턴은 서버에 추가 응답 런을 청해 그 런으로 낸다. 서버는 작업 목록을 메모리에 두고 채널 구독자에게 내며, 추가 응답 런을 런 관문으로 만들어 원래 런의 응답 스레드에 쓰게 한다. 웹은 런 카드에 작업 줄과 「종료」를 붙인다.

**Tech Stack:** TypeScript, Zod 4, Socket.IO, Fastify, drizzle(SQLite), React, Vitest, `@anthropic-ai/claude-agent-sdk@0.3.283`.

**Spec:** `docs/superpowers/specs/2026-11-24-runner-background-tasks-design.md`(결정 D1~D7, 9장 「제 판단」). 실측 근거: `docs/adr/0007-claude-agent-sdk-spike.md` 5.11.

## Global Constraints

- 범위는 러너 Claude 드라이버뿐 — OpenClaw 경로는 바꾸지 않는다(설계 머리).
- 시간 상한 없음(D2). 추가 응답 런의 `runMs`(600 000ms) 는 그 턴에만 건다(설계 5.5).
- 표시에서 빼는 작업: `ambient: true`, 그리고 전경 작업(`is_backgrounded: false` 이고 뒤에 백그라운드로 옮겨 가지 않은 것 — ADR 5.11 함정 「전경 Bash 도 작업 메시지를 낸다」). 백그라운드 목록의 정본은 `background_tasks_changed`(바꿔 끼우는 값).
- 스스로 연 턴의 표지는 **돌고 있는 런이 없을 때 오는 `system/init`**(ADR 5.11 — init 은 사람 턴마다도 온다).
- 한 세션 프로세스 안에서는 한 번에 한 턴 — 사람 프롬프트는 도는 턴의 `result` 뒤에 넣는다(ADR 5.11 질문 2: 요청 경계가 남은 턴에는 합쳐진다).
- interrupt 는 백그라운드 작업을 죽이지 않고, 입력을 닫고 `close()` 하면 죽는다(ADR 5.11 질문 5).
- 런 단위 「항상 허용」(`alwaysAllowed`)은 붙든 프로세스에서도 런 단위(설계 5.2).
- 작업 설명·요약은 `sink.mask`(작업 디렉터리 가림)로 가리고 `description` 200자, `summary` 300자로 자른다(제 판단 — 승인 카드 요약과 같은 자르기 함수를 쓴다).
- `tasks.update` 는 세션마다 1초에 한 번으로 묶는다(설계 9장).
- 러너가 다시 붙은 뒤 작업 목록을 기다리는 시간 `BACKGROUND_RESYNC_MS = 30_000`(설계 10장 「일정 시간」 — 이 계획의 값).
- 새 능력 `backgroundTasks` 가 없는 러너에는 새 프레임을 보내지 않는다 — 옛 러너는 지금 동작 그대로.
- 문구(설계 원문 그대로):
  - 카드 칩 「백그라운드 N」, 화면 읽기 「백그라운드 작업 N개」
  - 끊김 줄 「러너 연결 끊김」
  - D6 「백그라운드 작업 때문에 일부 설정은 이전 값으로 실행」
  - D7 「백그라운드 작업 N개가 러너 자리를 쓰는 중 — 활동 탭에서 종료하면 이어집니다」
  - 거절 「백그라운드 작업이 끝났지만 <사유> 이어서 답하지 못했습니다」(사유에 조사까지 — 「오늘 런 한도로」·「채널이 보관돼」·「에이전트가 꺼져」·「세션이 닫혀」)
  - 죽음 「백그라운드 작업이 끝나지 못했습니다 — 러너가 다시 시작됐습니다」
  - 업데이트 확인 「백그라운드 작업 N개가 꺼집니다」
- 모델 런은 실행 직전 사용자 승인. 이 계획의 모든 시험은 가짜 SdkPort·가짜 러너·런 0회 하네스로 돈다.
- `pnpm test` 는 typecheck·build 와 동시에 돌리지 않는다. 커밋은 경로 명시, Conventional Commits, 패키지 스코프.

## Review Focus

- **작업이 남은 채 러너가 끊겼다 붙는 것.** 끊긴 동안 CLI 는 살아 있고 작업도 끝날 수 있다 — 붙은 뒤 목록을 다시 보내고(Task 5), 끊긴 동안 연 추가 응답 턴은 서버 없이 돌았으므로 그 턴은 interrupt 하고 붙은 뒤 「죽음」 알림 대신 거절 알림을 남긴다. 시험: Task 5 `resends tasks after reconnect`, Task 4 `interrupts a follow-up turn when the followup request fails`.
- **세션 닫기·보관 직후 작업 알림이 와 추가 응답을 청하는 것.** 서버는 닫힌 대화·보관 채널을 런 관문에서 거절해야 하고, 러너는 거절이면 그 턴을 멈춘다. 시험: Task 7 `rejects followup for a closed conversation`.
- **사람 런이 붙든 프로세스로 들어가는 사이 추가 응답 턴이 열리는 것(경합).** 러너가 한 번에 한 턴만 돌리므로 사람 프롬프트는 추가 응답 턴의 `result` 뒤에 들어가야 한다. 시험: Task 4 `queues a human prompt behind a self-opened turn`.
- **같은 세션에 두 프로세스.** 붙든 세션에 `run.start` 가 오면 새 `query()` 를 만들지 않는다. 시험: Task 3 `routes the next run of a held session into the same process`.
- **끈 셸은 턴을 열지 않는다.** 「종료」 뒤 작업 줄이 사라지고 추가 응답 런이 생기지 않는다(ADR 5.11 질문 3). 시험: Task 4 `stopTask on a shell removes it without a follow-up`.

---

### Task 1: 공유 계약 — 러너 프레임·wire·런 칸

**Files:**
- Modify: `packages/shared/src/runner/index.ts`(프레임·능력·ack)
- Modify: `packages/shared/src/bridge/index.ts`(`InboundDeliver.kind` 에 `"background"`)
- Modify: `packages/shared/src/events/index.ts`(`RUN_QUEUED` 에 `heldSlots`)
- Modify: `packages/shared/src/domain/index.ts`(`BackgroundTask`, `Run.backgroundOriginRunId`)
- Modify: `packages/shared/src/wire/*.ts`(`tasks.updated`, `task.stop`, 구독 결과의 `tasks`) — 정확한 파일은 `ServerToClientEvents` 가 있는 파일
- Test: `packages/shared/test/runner.test.ts`, `packages/shared/test/wire.test.ts`(없으면 그 디렉터리의 같은 이름 관례대로 만든다)

**Interfaces:**
- Produces:
  - `RunnerCapability` 에 `"backgroundTasks"`.
  - `BackgroundTask = z.object({ taskId: z.string().min(1).max(128), kind: z.enum(["shell","subagent","other"]), description: z.string().max(200), subagentType: z.string().max(64).optional(), summary: z.string().max(300).optional(), lastToolName: z.string().max(128).optional(), startedAt: IsoDateTime, originRunId: Id })` — domain 에 두고 runner 쪽이 재사용.
  - 러너 → 서버: `"tasks.update": (p: RunnerTasksUpdate) => void`, `RunnerTasksUpdate = { sessionKey: string; tasks: BackgroundTask[] (max 50) }`.
  - 러너 → 서버: `"run.followup": (p: RunnerFollowupRequest, ack: (r: RunnerFollowupResult) => void) => void`, `RunnerFollowupRequest = { sessionKey: string; originRunId: Id; taskIds: string[] (1..50) }`, `RunnerFollowupResult = { ok: true; runId: Id; deliver: InboundDeliver } | { ok: false; reason: "limit" | "archived" | "inactive" | "closed" | "unknown" }`.
  - 서버 → 러너: `"task.stop": (p: { sessionKey: string; taskId: string }, ack: (r: { ok: boolean }) => void) => void`, `"session.release": (p: { sessionKey: string }) => void`.
  - `RunnerRunAck` 에 `heldSlots: z.int().min(0).optional()`(대기 사유 — 자리를 쥔 붙든 프로세스 수). `RUN_QUEUED` 이벤트에 `heldSlots: z.int().min(0).optional()`.
  - `Run`(domain) 에 `backgroundOriginRunId?: Id`.
  - wire 서버 → 클라이언트 `"tasks.updated": (p: { channelId: Id; conversationId: Id; runnerConnected: boolean; tasks: BackgroundTask[] }) => void` — 그 대화의 그 러너 세션 몫 전체(바꿔 끼우는 값). 채널 구독 결과에 `tasks: Array<{ conversationId: Id; runnerConnected: boolean; tasks: BackgroundTask[] }>`(기본 `[]`).
  - wire 클라이언트 → 서버 `"task.stop": (p: { runId: Id; taskId: string }, ack: Ack<null>) => void`. (설계 6장의 REST `POST …/tasks/:taskId/stop` 대신 — 런 중지가 wire `run.abort` 이므로 같은 길로. 설계와 다른 유일한 자리다.)

- [ ] **Step 1: 시험을 쓴다** — `runner.test.ts`: `accepts tasks.update with a shell and a subagent`, `rejects tasks.update over 50 tasks`, `followup result is a discriminated union on ok`, `hello keeps unknown capabilities out`(기존 꼴에 `backgroundTasks` 추가 확인). `wire.test.ts`: `subscribe result defaults tasks to []`.
- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/shared test` → 새 시험 FAIL.
- [ ] **Step 3: 스키마를 더한다**(위 Interfaces 그대로).
- [ ] **Step 4: 통과·전체 typecheck** — `pnpm -F @dodok/shared test && pnpm typecheck`. typecheck 가 깨지는 곳(판별 유니온 `switch` 의 exhaustive 등)은 이 태스크에서 기존 동작을 바꾸지 않는 최소로 맞춘다.
- [ ] **Step 5: Commit** `feat(shared): background task contracts`.

---

### Task 2: 러너 — SDK 작업 메시지 줄이기·서브에이전트 런 이벤트

**Files:**
- Create: `packages/claude-runner/src/drivers/claude/tasks.ts`
- Modify: `packages/claude-runner/src/drivers/claude/stream-map.ts`(system 메시지 → `SUBAGENT_*`)
- Test: `packages/claude-runner/test/tasks.test.ts`, `packages/claude-runner/test/stream-map.test.ts`

**Interfaces:**
- Consumes: Task 1 `BackgroundTask`.
- Produces:
  - `createTaskTracker(o: { now: () => number; mask: PathMasker; currentRunId: () => string | undefined }): TaskTracker`
  - `TaskTracker = { apply(m: SdkMessage): { changed: boolean; notifications: TaskNotice[] }; list(): BackgroundTask[]; has(taskId: string): boolean; size(): number; reset(): void }`
  - `TaskNotice = { taskId: string; status: "completed" | "failed" | "stopped"; kind: BackgroundTask["kind"]; originRunId: string }`
  - 규칙: `task_started` 로 메타(kind·description·subagentType·originRunId = 그때의 `currentRunId()`·startedAt)를 기억, `task_progress` 로 summary·lastToolName, `task_updated.patch.is_backgrounded` 로 백그라운드 편입, `background_tasks_changed` 로 목록을 **바꿔 끼운다**(ambient 제외, 메타를 모르는 id 는 description 그대로·kind other·originRunId 는 currentRunId 또는 마지막 알려진 런). `task_notification` 은 notice 로 낸다. `task_type`: `local_bash`→shell, `local_agent`→subagent.
  - stream-map: `task_started`(local_agent) → `{ type: "SUBAGENT_STARTED", runId, subagentRunId: uuidv7(), label: subagent_type ?? description }`, `task_notification`(그 작업) → `SUBAGENT_FINISHED` 또는 `SUBAGENT_ERROR { message: summary 앞 300자 }`. task_id → subagentRunId 대응은 매퍼 안 Map. **이 런이 도는 동안만** — 매퍼는 런마다 새로 만든다(지금 그대로).

- [ ] **Step 1: 시험** — `tasks.test.ts`: `replaces the list on background_tasks_changed`(ADR 5.11 시나리오 1 순서를 그대로 먹여 마지막 목록이 `[]`), `drops ambient tasks`, `ignores foreground bash`(is_backgrounded false 이고 changed 에 없음 → list 비어 있음), `marks originRunId from the run that started it`, `masks description and cuts to 200`, `emits a stopped notice for a killed shell`. `stream-map.test.ts`: `maps a local_agent task to SUBAGENT_STARTED/FINISHED`, `keeps parent_tool_use_id streams out of the bubble`(기존 동작 유지).
- [ ] **Step 2: FAIL 확인** — `pnpm -F @dodok/runner test -- tasks stream-map`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: PASS 확인**(같은 명령) + `pnpm -F @dodok/runner typecheck`.
- [ ] **Step 5: Commit** `feat(runner): track background tasks from sdk messages`.

---

### Task 3: 러너 — 세션 프로세스(붙들기·다음 런 이어 넣기·런마다 다시 꽂기)

**Files:**
- Create: `packages/claude-runner/src/drivers/claude/session-process.ts`
- Modify: `packages/claude-runner/src/drivers/claude/run.ts`(`attempt` 의 query·입력·반복을 세션 프로세스로 옮긴다 — 한 런의 시작·final·error 판정은 run.ts 에 남는다)
- Modify: `packages/claude-runner/src/drivers/claude/index.ts`(드라이버가 세션 프로세스 맵을 쥔다)
- Modify: `packages/claude-runner/src/driver.ts`(`ProgramDriver.background?`)
- Test: `packages/claude-runner/test/session-process.test.ts`, `packages/claude-runner/test/run.test.ts`, `packages/claude-runner/test/helpers/fake-query.ts`(작업 메시지·스스로 연 턴을 흘릴 수 있게)

**Interfaces:**
- Consumes: Task 2 `createTaskTracker`.
- Produces:
  - `ProgramDriver.background?: { stopTask(sessionKey: string, taskId: string): Promise<boolean>; release(sessionKey: string): void; held(): Array<{ sessionKey: string; tasks: BackgroundTask[] }> }`
  - `ClaudeDriverOptions` 에 `hooks?: BackgroundHooks`, `BackgroundHooks = { requestFollowup(req: RunnerFollowupRequest): Promise<RunnerFollowupResult>; tasksChanged(sessionKey: string, tasks: BackgroundTask[]): void; held(sessionKey: string, holding: boolean): void }` — Task 5 의 연결이 채운다.
  - `SessionProcess`(session-process.ts 내부 계약, 이름은 구현자가 다듬어도 된다): `runTurn(binding: RunBinding, prompt: SdkUserMessage): AsyncIterable<SdkMessage>` — 그 턴의 `result` 까지의 메시지, `bindingRef`(지금 런의 deliver·runId·sessionKey·signal·turnFacts·alwaysAllowed 를 가리키는 가변 참조 — `createPoster`·`createControlTools`·`createCanUseTool`·`UserPromptSubmit` 훅이 이것을 읽는다), `holding(): boolean`(작업이 남았는가), `close()`.
  - 규칙:
    - 프롬프트 턴 `result` → final 을 낸 뒤 `tracker.size() > 0` 이면 입력을 닫지 않고 `hooks.held(sessionKey, true)`. 0 이면 지금처럼 닫는다.
    - 붙든 프로세스는 `tracker` 가 비고 도는 턴이 없을 때 지금의 `closeLater`(유예 `ABORT_CLOSE_MS`) 로 닫고 `hooks.held(sessionKey, false)`·`tasksChanged(sessionKey, [])`.
    - 드라이버의 `startRun(spec)` 은 `spec.start.deliver.sessionKey` 의 세션 프로세스가 붙들려 있으면 새 `query()` 를 만들지 않고 그 프로세스에 턴을 넣는다.
    - 붙든 프로세스에서 「중지」(signal abort)·런 타임아웃은 **그 턴만** `interrupt()` — `closeLater` 를 부르지 않는다. 붙들지 않은 프로세스는 지금 그대로.
    - 런 단위 설정(D6): 이어 넣는 런의 `model`·`permissionMode`·`effort`(→ `setMaxThinkingTokens`)·봇 MCP(→ `setMcpServers`) 가 프로세스를 연 옵션과 다르면 턴 전에 바꾼다. 못 바꾸는 것(채널 규칙 `channelRulesAppend`, `allowedTools`, `disallowedTools`, `appMcp`)이 다르면 그 런에 `run.event` CUSTOM `{ name: "dodok.held_settings", value: { fields: string[] } }` 를 낸다.

- [ ] **Step 1: 시험** — `session-process.test.ts`: `holds the process when a background task survives the result`, `closes the process when the task list empties`, `routes the next run of a held session into the same process`(가짜 SdkPort 의 query 호출 수 1), `rebinds the poster to the current run`(둘째 런의 `mcp__dodok__post` 가 둘째 run 의 deliver 로 나간다), `keeps alwaysAllowed per run`, `interrupt on a held process stops only the turn`(close 호출 0, 작업 남음), `applies setModel and setPermissionMode before the next turn`, `emits dodok.held_settings when channel rules differ`. `run.test.ts` 의 기존 시험은 그대로 통과해야 한다(바꾸지 않는다).
- [ ] **Step 2: FAIL 확인** — `pnpm -F @dodok/runner test -- session-process`.
- [ ] **Step 3: 구현.** run.ts 의 `attempt` 를 쪼갤 때 기존 주석의 「입력은 런의 끝까지 열어 둔다」·「세부는 입력을 닫기 전에 묻는다」·비용 누적 차이(`recordCost`) 의미를 지킨다 — 붙든 프로세스에서는 `resume` 이 아니므로 비용은 같은 프로세스의 직전 누적값과의 차이다.
- [ ] **Step 4: PASS + 러너 전체** — `pnpm -F @dodok/runner test`(실행 수를 적는다) + typecheck.
- [ ] **Step 5: 구분력** — 「붙든 세션이면 같은 프로세스」 분기를 되돌려 `routes the next run…` 이 실패하는지 보고 복구, `git status` 깨끗.
- [ ] **Step 6: Commit** `feat(runner): hold the claude process while background tasks run`.

---

### Task 4: 러너 — 스스로 연 턴(추가 응답)·한 번에 한 턴·작업 끄기

**Files:**
- Modify: `packages/claude-runner/src/drivers/claude/session-process.ts`
- Modify: `packages/claude-runner/src/drivers/claude/index.ts`(`background.stopTask`·`release`)
- Test: `packages/claude-runner/test/session-process.test.ts`

**Interfaces:**
- Consumes: Task 3 `BackgroundHooks`, `RunBinding`.
- Produces: (계약은 Task 3 의 것 — 여기서 동작을 채운다)
  - 돌고 있는 턴이 없을 때 `system/init` 이 오면: 그 사이 온 `task_notification` 들의 작업 id 를 모아 `hooks.requestFollowup({ sessionKey, originRunId: 첫 알림 작업의 originRunId, taskIds })`. 응답 전 메시지는 버퍼에 쥔다.
    - `ok: true` → 받은 `deliver` 로 바인딩을 바꾸고(runId·deliver·signal 새로) 버퍼를 그 런의 이벤트로 내고, 그 턴의 `result` 를 그 런의 final 로.
    - `ok: false` 또는 던짐 → `interrupt()`, 버퍼를 버린다.
  - 사람 런이 오면: 도는 턴(사람·추가 응답)이 있으면 그 턴의 `result` 뒤에 프롬프트를 넣는다(대기열). 대기 중인 런의 `signal` 이 끊기면 대기열에서 빼고 `abortedFinal`.
  - `background.stopTask(sessionKey, taskId)` → `q.stopTask(taskId)`, 없는 세션·작업이면 false.
  - `background.release(sessionKey)` → 도는 턴 interrupt, 입력 닫기, `close()`.
  - 끈 셸의 알림은 턴을 열지 않는다(ADR 5.11 질문 3) — 그 알림만으로 followup 을 청하지 않는다. 끈 서브에이전트는 턴을 열므로 청한다(원래 동작 그대로 따라간다 — 따로 막지 않는다).

- [ ] **Step 1: 시험** — `opens a follow-up run when the cli opens a turn on its own`(requestFollowup 인자 `originRunId`·`taskIds`, 이벤트가 새 runId 로), `interrupts a follow-up turn when the followup request fails`, `queues a human prompt behind a self-opened turn`(가짜 query 가 받은 입력 순서), `stopTask on a shell removes it without a follow-up`, `release closes the process and clears tasks`, `uses the origin of the first notification when two runs finish together`.
- [ ] **Step 2: FAIL 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: PASS + 러너 전체**(실행 수).
- [ ] **Step 5: 구분력** — 「도는 턴이 있으면 대기」를 되돌려 `queues a human prompt…` 가 실패하는지 보고 복구.
- [ ] **Step 6: Commit** `feat(runner): follow-up turns for finished background tasks`.

---

### Task 5: 러너 — 연결·스케줄러·프레임

**Files:**
- Modify: `packages/claude-runner/src/connection.ts`
- Modify: `packages/claude-runner/src/scheduler.ts`
- Modify: `packages/claude-runner/src/main.ts`(드라이버에 hooks 를 넘긴다)
- Test: `packages/claude-runner/test/connection.test.ts`, `packages/claude-runner/test/scheduler.test.ts`, `packages/claude-runner/test/adapter-integration.test.ts`

**Interfaces:**
- Consumes: Task 1 프레임, Task 3·4 `ProgramDriver.background`·`BackgroundHooks`.
- Produces:
  - 스케줄러: `hold(sessionId: string): void`·`unhold(sessionId: string): void`(붙든 프로세스도 자리 하나 — Global 「자리」), `submit` 이 붙든 세션이면 `busy` 대신 곧바로 그 일을 돌린다(자리를 더 쓰지 않는다). 대기로 들어가면 `{ queuedPosition, heldSlots }`. `size()` 는 붙든 것을 뺀 도는 수(원격 업데이트 busy — 설계 5.6), `heldCount()` 추가.
  - hello 능력에 `backgroundTasks`(드라이버에 `background` 가 있을 때).
  - `hooks.requestFollowup` → `socket.emitWithAck("run.followup", …)`(시간 제한 10 000ms, 넘으면 `{ ok:false, reason:"unknown" }`). 끊겨 있으면 곧바로 `{ ok:false, reason:"unknown" }`.
  - `hooks.tasksChanged` → 세션마다 1초 묶어 `tasks.update`. hello 성공 뒤 `driver.background.held()` 를 세션마다 한 번 보낸다.
  - `task.stop` 받으면 `driver.background.stopTask` 결과로 ack. `session.release` 받으면 `release`.
  - 러너 종료(`settleRuns`)·원격 업데이트는 붙든 프로세스를 그대로 끝낸다(프로세스 종료로 작업이 죽는다 — 알림은 서버 몫, Task 7).

- [ ] **Step 1: 시험** — `scheduler.test.ts`: `a held session uses a slot`, `submit into a held session does not take another slot`, `queued ack carries heldSlots`, `size excludes held sessions`. `connection.test.ts`: `announces backgroundTasks`, `throttles tasks.update to once per second per session`, `resends tasks after reconnect`, `answers task.stop from the driver`, `followup times out to unknown`. (실제 어댑터와 잇는 `adapter-integration.test.ts` 시험은 Task 6 몫 — 이 태스크에서는 그 파일의 기존 시험이 그대로 통과하는지만 본다.)
- [ ] **Step 2: FAIL 확인.**
- [ ] **Step 3: 구현.**
- [ ] **Step 4: PASS + 러너 전체**(실행 수).
- [ ] **Step 5: Commit** `feat(runner): background task frames and held slots`.

---

### Task 6: 러너 어댑터 — 프레임 받기·런 추적·끄기

**Files:**
- Modify: `packages/runner-adapter/src/runner-adapter.ts`
- Test: `packages/runner-adapter/test/runner-adapter.test.ts`, `packages/claude-runner/test/adapter-integration.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `RunnerAdapterOptions` 에 `onFollowup?: (connectionId: string, req: RunnerFollowupRequest) => Promise<RunnerFollowupResult>`, `onTasks?: (connectionId: string, update: RunnerTasksUpdate | { disconnected: true }) => void`(`onControlCall` 와 같은 결).
  - `run.followup` → `onFollowup`; `ok:true` 면 그 runId 로 `RunTrack` 을 `started: true` 로 등록(이후 `run.event`·`run.final` 이 `ownRun` 을 통과한다).
  - `tasks.update` → `onTasks`; 러너가 빠지면(`dropRunner`) `onTasks(tokenId, { disconnected: true })`.
  - 어댑터 메서드 `stopTask(connectionId: string, sessionKey: string, taskId: string): Promise<boolean>`(그 러너가 없거나 능력이 없으면 false), `releaseSession(connectionId: string, sessionKey: string): void`.
  - 프레임 레이트: 새 프레임 셋을 기존 `frameLimit` 버킷에 넣는다(`tasks.update` 는 런 이벤트 버킷, `run.followup` 은 control 버킷 — `namesOpenWork` 규칙에 맞춘다).

- [ ] **Step 1: 시험** — `runner-adapter.test.ts`: `followup registers a started run that accepts events`, `followup rejection keeps no track`, `tasks.update reaches onTasks`, `drop reports disconnected tasks`, `stopTask acks false for a runner without the capability`. `adapter-integration.test.ts`: `held process follow-up flows through the real adapter`(가짜 SdkPort + 실제 어댑터 — 작업 하나, 스스로 연 턴, final 이 새 런으로).
- [ ] **Step 2: FAIL 확인** — `pnpm -F @dodok/runner-adapter test`.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: PASS** — `pnpm -F @dodok/runner-adapter test && pnpm -F @dodok/runner test -- adapter-integration`(실행 수).
- [ ] **Step 5: Commit** `feat(runner-adapter): background task frames`.

---

### Task 7: 서버 — 추가 응답 런·작업 목록·끄기·함께 끄기·알림

**Files:**
- Create: `apps/server/src/modules/runs/background.ts`
- Create: `apps/server/drizzle/0043_runs_background_origin.sql`(`pnpm -F @dodok/server db:generate` 로 만든다 — 손으로 쓰지 않는다) + `meta/`
- Modify: `apps/server/src/db/schema.sqlite.ts`(`runs.backgroundOriginRunId` → `background_origin_run_id`)
- Modify: `apps/server/src/modules/runs/orchestrator.ts`(`adoptRun`, `onCanonical` 의 스레드 예외, `rowToRun` 의 새 칸 — `runs/store.ts`)
- Modify: `apps/server/src/modules/runs/store.ts`
- Modify: `apps/server/src/app.ts`(runner-adapter 옵션 `onFollowup`·`onTasks` 를 background 서비스로)
- Modify: 실시간 핸들러(`run.abort` 를 처리하는 파일 — 같은 권한 검사로 `task.stop`), 채널 구독 결과에 `tasks`
- Modify: 세션 닫기·에이전트 보관·채널 보관·세션에서 내보내기 자리(`abortConversation`·`abortConversationAgent` 를 부르는 곳) — 그 세션의 러너 세션 키마다 `releaseSession`
- Modify: 러너 상세 응답(설정 → 연결 → 러너 상세의 REST) 에 `backgroundTasks: number`
- Test: `apps/server/test/runs.background.test.ts`, `apps/server/test/runs.orchestrator.test.ts`, `apps/server/test/fakes/fake-runner.ts`, `apps/server/test/roles.matrix.test.ts`(`task.stop` 권한 줄)

**Interfaces:**
- Consumes: Task 1, Task 6 옵션·메서드.
- Produces:
  - `Orchestrator.adoptRun(plan: RunPlan & { channelId; conversationId }, trigger: EnqueueTrigger & { backgroundOriginRunId: string; threadRootId: string }): Promise<Run>` — 세션 큐에 줄 세우지 않고 곧바로 `streaming` 으로(RUN_STARTED·startedAt·run 타이머), 같은 세션 큐의 기다리는 런은 이 런 뒤로. `triggerKind: "background"`, `requestedBy` 는 원래 런의 값.
  - `createBackgroundService(deps: { db; bus; orchestrator; gate: RunGate; registry; now; logger }): BackgroundService`
  - `BackgroundService = { onFollowup(connectionId, req): Promise<RunnerFollowupResult>; onTasks(connectionId, update): void; snapshot(channelId: string): ChannelSubscribeResult["tasks"]; stop(runId: string, taskId: string, principal): Promise<void>; releaseConversation(conversationId: string, agentId?: string): void; heldCount(runnerTokenId: string): number }`
  - 추가 응답 규칙(설계 5.5): 원래 런 → 대화·에이전트·채널. 스레드 루트 = 원래 런이 스레드 런이면 그 `threadRootId`, 아니면 원래 런의 첫 정본 메시지 id, 없으면 원래 런의 트리거 메시지. 관문(`gate.check` + 에이전트 활성·채널 보관·대화 닫힘)에 막히면 그 스레드에 시스템 글 「백그라운드 작업이 끝났지만 <사유> 이어서 답하지 못했습니다」(사유에 조사까지: 한도 「오늘 런 한도로」, 보관 「채널이 보관돼」, 비활성 「에이전트가 꺼져」, 닫힘 「세션이 닫혀」) 후 `{ ok:false, reason }`. `deliver` 는 지금 런 디스패치가 만드는 것과 같은 함수로 만들되 `kind: "background"`, `threadId` = 스레드 루트, `sessionKey` = 원래 런의 세션 키.
  - `onCanonical`: 런이 `triggerKind === "background"` 이고 `msg.threadId === run.threadRootId` 면 세션 키의 스레드 대조를 통과시킨다. 그 밖은 지금 그대로.
  - 작업 목록: 키 `connectionId + sessionKey`, 값 `{ conversationId, channelId, agentId, tasks, runnerConnected, lastSeen }`. 바뀔 때마다 채널 룸에 `tasks.updated`. `{ disconnected:true }` 면 그 러너 몫을 `runnerConnected:false` 로. 러너가 다시 붙고 `BACKGROUND_RESYNC_MS` 안에 오지 않은 세션은 지우고, 그 작업마다 원래 런의 응답 스레드에 「백그라운드 작업이 끝나지 못했습니다 — 러너가 다시 시작됐습니다」(같은 스레드에 한 번).
  - 대기 사유(D7): 러너 ack 의 `heldSlots` 를 `RUN_QUEUED.heldSlots` 로 싣는다(런 디스패치 자리).

- [ ] **Step 1: 시험** — `runs.background.test.ts`: `followup creates a running run in the origin reply thread`, `followup uses the origin thread for a thread run`, `followup falls back to the trigger message without a reply`, `rejects followup for a closed conversation`(시스템 글 문구), `rejects followup over the daily limit`, `canonical of a background run is stored in the thread`, `tasks.updated reaches channel subscribers only`, `subscribe snapshot carries tasks`, `task.stop needs the same permission as run.abort`, `closing a session releases the runner session`, `lost tasks after reconnect leave one notice per thread`, `runner detail counts background tasks`. `runs.orchestrator.test.ts`: `adoptRun puts waiting runs of the session behind it`, `queued event carries heldSlots`. `roles.matrix.test.ts`: `task.stop` 줄.
- [ ] **Step 2: FAIL 확인** — `pnpm -F @dodok/server test -- runs.background runs.orchestrator roles.matrix`.
- [ ] **Step 3: 마이그레이션을 생성하고 구현.**
- [ ] **Step 4: PASS + 서버 전체** — `pnpm -F @dodok/server test`(혼자, 실행 수).
- [ ] **Step 5: 구분력** — `onCanonical` 의 스레드 예외를 되돌려 `canonical of a background run…` 이 실패하는지 보고 복구.
- [ ] **Step 6: Commit** `feat(server): background follow-up runs and task list`.

---

### Task 8: 웹 — 런 카드의 작업 줄·종료·표시

**Files:**
- Create: `apps/web/src/features/activity/BackgroundTasks.tsx`, `apps/web/src/features/activity/useBackgroundTasks.ts`
- Modify: `apps/web/src/features/activity/RunCard.tsx`, `apps/web/src/features/activity/ActivityPanel.tsx`(거르기 「진행 중」), 버블 대기 표시(RUN_QUEUED 를 그리는 곳 — `InlineActivity.tsx` 또는 버블 상태 줄), 러너 업데이트 확인 대화상자(설정 → 연결 → 러너 상세)
- Test: `apps/web/src/features/activity/activity.test.tsx`, `apps/web/src/features/activity/useBackgroundTasks.test.ts`

**Interfaces:**
- Consumes: Task 1 wire, Task 7 동작.
- Produces:
  - `useBackgroundTasks(channelId: string): { byRun(runId: string): { tasks: BackgroundTask[]; runnerConnected: boolean }; activeRunIds: Set<string> }` — 구독 스냅샷 + `tasks.updated` 를 대화별로 바꿔 끼운다. 작업은 `originRunId` 로 런 카드에 붙는다.
  - `BackgroundTasks` 줄: 종류 배지(「셸」·「서브에이전트」·「작업」), `description`, 서브에이전트면 `subagentType`·`summary`·`lastToolName` 한 줄, 걸린 시간(`startedAt` 부터 화면에서 1초마다), 「종료」(그 런의 중지를 할 수 있는 사람에게만 — 중지 단추와 같은 판정). 「종료」 → `task.stop`, 누른 뒤 응답 전까지 단추 비활성.
  - 카드 머리 칩 「백그라운드 N」(N>0), `aria-label` 「백그라운드 작업 N개」. 카드가 접혀 있어도 작업 줄이 보인다.
  - `runnerConnected:false` → 줄 흐리게, 「러너 연결 끊김」, 「종료」 없음.
  - 거르기 「진행 중」 = 끝나지 않은 런 ∪ `activeRunIds`.
  - 추가 응답 런 카드: 머리에 「추가 응답 · <원래 런 시작 시각> 런」(`run.backgroundOriginRunId`).
  - CUSTOM `dodok.held_settings` 가 있는 런 카드에 D6 문구.
  - `RUN_QUEUED.heldSlots > 0` 이면 대기 표시에 D7 문구(N = heldSlots).
  - 러너 상세 업데이트 확인에 `backgroundTasks > 0` 이면 「백그라운드 작업 N개가 꺼집니다」.
  - DM 활동 탭도 같은 구성 요소라 따로 하지 않는다 — 시험 하나로 확인.

- [ ] **Step 1: 시험** — `useBackgroundTasks.test.ts`: `replaces tasks per conversation`, `groups tasks by originRunId`. `activity.test.tsx`: `shows background rows on a collapsed card`, `hides stop for people who cannot abort`, `stop sends task.stop and disables the button`, `marks disconnected runner rows`, `in progress filter includes finished runs with tasks`, `follow-up card names its origin run`, `held settings note`, `queued bubble explains held slots`, `dm activity shows background rows`.
- [ ] **Step 2: FAIL 확인** — `pnpm -F @dodok/web test -- activity useBackgroundTasks`.
- [ ] **Step 3: 구현.** 실제 시간을 재는 시험이 있으면 `HIGHLIGHT_MS` 에 기대지 않게.
- [ ] **Step 4: PASS + 웹 전체**(혼자, 실행 수) + `pnpm -F @dodok/web typecheck`.
- [ ] **Step 5: Commit** `feat(web): background tasks on activity run cards`.

---

### Task 9: dev:fake 대본·문서

**Files:**
- Modify: dev:fake 가짜 러너(`apps/server` 의 dev:fake 러너 대본 파일 — 「도구」·「실패」 대본이 있는 곳)
- Modify: `docs/manual/user-guide.md`(「활동 탭 — 실행과 도구 기록」·「스레드」 절), `docs/guides/agent-guide.md`(새 절 「백그라운드 작업」 — 설계 5.8 문장), `docs/guides/plan.md` 8장(완료 항목·이월: OpenClaw 백그라운드·출력 보기·러너 재시작 뒤 생존), `.ruler/50-project.md` 또는 AGENTS.md 의 소스(dev:fake 설명에 새 대본 한 줄) 뒤 `pnpm exec guideline apply`
- Test: dev:fake 대본 시험이 있으면 그 파일(없으면 서버의 dev:fake 시험 관례 — 실행 수를 적는다)

**Interfaces:**
- Produces: dev:fake 대본 키워드 「백그라운드」 — 사무실 @coder 런이 백그라운드 셸 하나(5초 뒤 끝나 추가 응답)와 끝나지 않는 셸 하나(「종료」로만 끝남)를 만든다. 가짜 러너가 Task 1 프레임을 실제로 낸다.

- [ ] **Step 1: 대본 시험을 쓴다**(dev:fake 시험 관례대로) — `background script opens a follow-up in the reply thread`, `endless task stops on task.stop`.
- [ ] **Step 2: FAIL → 구현 → PASS.**
- [ ] **Step 3: 문서를 고친다** — `docs/guideline/base/04-citation.md` 를 먼저 읽는다. `---` 앞 빈 줄·표 줄 눈 확인.
- [ ] **Step 4: `pnpm exec guideline apply && git status`** — 추적 파일 변경은 소스뿐.
- [ ] **Step 5: Commit** `feat(server): dev:fake background script` + `docs: background tasks`(둘로).

---

### Task 10: 검증 — 런 0회 하네스로 실제 러너·CLI 끝까지

**Files:** 없음(보고만). 기록은 `.superpowers/sdd/2026-11-24-runner-bg-impl/`(git 제외).

- [ ] **Step 1:** `docs/guides/live-smoke.md` 11절대로 실제 서버(dev:fake, 가짜 러너 내림) + 실제 러너 tgz + 설치된 `claude` + 가짜 API(`HX-BG-BASH`·`HX-BG-FOREVER`·`HX-BG-AGENT`). CLI `cwd` 는 홈 밖.
- [ ] **Step 2: 확인할 것** — ① `HX-BG-BASH` 뒤 처음 응답의 스레드에 `HX-BG-FOLLOWUP` 답이 저장된다 ② 활동 탭 카드에 작업 줄이 생겼다 사라진다(Playwright 를 neo 에 — `docs/guides/browser-verification.md`) ③ `HX-BG-FOREVER` 의 「종료」로 줄이 사라지고 추가 응답이 없다 ④ 같은 세션에 사람 글을 보내면 CLI 기동 수가 늘지 않는다(감싸개 기록) ⑤ 러너를 죽였다 띄우면 30초 뒤 「끝나지 못했습니다」 알림 ⑥ `pgrep -f hx-bg-forever` 가 끝에 비어 있다.
- [ ] **Step 3: 보고** — 항목마다 관찰값, 띄운 것/끈 것, 네가 연 탭은 네가 닫는다.
