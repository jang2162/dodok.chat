# 러너 백그라운드 작업 — 추가 응답과 화면 표시 설계

- 날짜: 2026-11-24
- 범위: 러너(`dodok-runner`, Claude Code 드라이버) 에이전트. OpenClaw Gateway 에이전트는 이 설계에 들지 않는다.
- 상태: 검토 대기(builder 점검 반영)

## 1. 왜

러너 에이전트가 셸을 `Bash` 의 `run_in_background: true` 로 돌리거나 서브에이전트를 백그라운드로 띄우면, 모델은 「끝나면 알려 드릴게요」라고 답하고 턴을 끝낸다. 지금 러너는 그 턴의 첫 `result` 에서 입력을 닫고 CLI 를 끝낸다(`packages/claude-runner/src/drivers/claude/run.ts` 의 `end()`·`finally` 의 `q.close()`). 그래서

- 백그라운드 셸·서브에이전트가 CLI 와 함께 죽는다(ADR 0007 5.8 실측 — `sleep 45 && echo done`).
- 뒤늦은 `task_notification` 은 `if (ended) continue;` 로 버려진다.
- 다음 resume 에서야 「Background shell command didn't finish before the previous session ended」 흔적만 남는다(ADR 0007 4.3).

에이전트가 지키지 못할 약속을 채널에 남기는 셈이다. 이 설계는 그 약속이 지켜지게 하고, 지금 무엇이 돌고 있는지 사람이 화면에서 보고 끌 수 있게 한다.

## 2. 목표·비목표·실패 조건

**목표**

- G1. 백그라운드 작업(셸·서브에이전트)이 남아 있으면 런이 끝나도 CLI 를 살려 둔다. **시간 상한은 없다**(사용자 결정).
- G2. 작업이 끝나 CLI 가 이어지는 턴을 시작하면, 그 답을 **처음 응답 메시지의 스레드**에 올린다(사용자 결정).
- G3. 돌고 있는 백그라운드 셸·서브에이전트를 **활동 탭의 그 런 카드 안**에서 본다 — 줄마다 종류·설명·걸린 시간·「종료」(사용자 결정).
- G4. 끝나지 않는 작업(개발 서버 등)도 사람이 화면에서 끌 수 있다.

**비목표**

- OpenClaw Gateway 에이전트의 백그라운드 작업.
- 러너 프로세스 재시작·원격 업데이트를 넘어 작업을 살리는 것.
- 작업 출력의 실시간 보기(출력 파일은 호스트 경로라 가림·크기 문제가 따로 있다 — 제 판단, 9장).
- 채널 머리 표시·러너 단위 작업 화면(사용자가 활동 탭만 골랐다).

**실패 조건(작동해도 실패인 것)**

- 에이전트가 「끝나면 알려 드릴게요」라고 했는데 아무 일도 없다.
- 화면에 보이지 않는 CLI 가 메모리(약 300 MiB/개)와 러너 자리를 쥐고 있다.
- 사람이 끈 작업이 화면에는 계속 「도는 중」으로 남는다.

## 3. 정한 것

| # | 결정 | 누가 |
| --- | --- | --- |
| D1 | 방식: CLI 프로세스를 살려 두고 SDK 의 작업 이벤트를 쓴다 | 사용자(아래 4장) |
| D2 | 시간 상한 없음 | 사용자 |
| D3 | 추가 응답은 그 런의 첫 응답 메시지 스레드로 | 사용자 |
| D4 | 그 스레드에 사람이 물으면 **지금 규칙대로 스레드 세션**이 답한다(`…:thread:<루트 id>`). 셸 자체는 채널 세션 프로세스가 쥔다 | 사용자 |
| D5 | 표시 자리: 활동 탭 런 카드 안 | 사용자 |
| D6 | 붙든 프로세스에 들어가는 다음 런의 설정이 다르면, 도는 중에 바꿀 수 있는 것(`setModel`·`setPermissionMode`·`setMaxThinkingTokens`·`setMcpServers`)은 바꾸고 못 바꾸는 것(채널 규칙 덧붙임·허용 도구 등)은 옛 값으로 잇는다. 그 런 카드에 「백그라운드 작업 때문에 일부 설정은 이전 값으로 실행」 표시 | 사용자 |
| D7 | 붙든 프로세스가 러너 동시 상한을 채우면 새 런은 기다린다. 기다리는 런의 카드·버블에 「백그라운드 작업 N개가 러너 자리를 쓰는 중 — 활동 탭에서 종료하면 이어집니다」 | 사용자 |

## 4. 방식 — 고른 것과 버린 것

1. **CLI 프로세스를 살려 둔다(골랐다).** 모델은 평소처럼 `run_in_background` 와 백그라운드 서브에이전트를 쓰고, 러너는 SDK 의 `background_tasks_changed`·`task_started`·`task_progress`·`task_updated`·`task_notification` 을 화면과 추가 응답으로 옮긴다. 셸과 서브에이전트를 한 방식으로 다룬다. 대가는 작업이 사는 동안 CLI 가 메모리와 자리를 쥐는 것, 러너가 재시작하면 작업이 죽는 것.
2. **셸은 러너가 직접 돌린다(버렸다).** CLI 내장 백그라운드를 끄고(`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`) dodok MCP 도구로 러너가 셸을 쥐고, 끝나면 resume 런으로 결과를 넣는다. 쉬는 동안 메모리를 쓰지 않지만 **백그라운드 서브에이전트를 다룰 수 없어** G3 을 못 채운다. 끄는 변수의 효과도 재지 않았다.
3. 둘을 섞는 것은 두 길을 다 유지해야 해서 뺐다.

## 5. 설계

### 5.1 SDK 쪽 사실(SDK 0.3.283 `sdk.d.ts`)

- `Query.stopTask(taskId)` — 작업을 끈다. `task_notification { status: "stopped" }` 가 뒤따른다.
- `system/background_tasks_changed { tasks: [{ task_id, task_type, description, ambient? }] }` — 살아 있는 백그라운드 작업 **전체**(바꿔 끼우는 값). 프로세스마다의 값이라 시작 때는 오지 않는다 — 프로세스가 새로 뜨면 빈 목록으로 본다. `ambient: true` 는 활동이 아니라 표시에서 뺀다.
- `system/task_started { task_id, tool_use_id?, description, subagent_type?, is_backgrounded?, task_type? }` — `task_type` 은 `local_bash`·`local_agent` 등.
- `system/task_progress { task_id, description, usage, last_tool_name?, summary? }`, `system/task_updated { task_id, patch: { status?, is_backgrounded?, … } }`, `system/task_notification { task_id, status: completed|failed|stopped, reason?, summary, output_file }`.
- `thinking_tokens` 의 주석에 「synthetic/scheduled (meta) turn」이 있다 — CLI 가 사용자 입력 없이 턴을 시작하는 길이 있다는 뜻이지만 **헤드리스(SDK)에서 작업 알림 뒤 스스로 턴을 여는지는 재지 않았다**(5.9 스파이크).

### 5.2 러너 — 「붙든 프로세스」

러너 드라이버가 세션마다 CLI 를 하나 붙들 수 있게 한다. 이름은 **세션 프로세스**(코드에서는 builder 가 정한다).

- 프롬프트 턴의 `result` 를 받으면 지금처럼 `final` 을 보낸다(서버의 런은 평소처럼 끝난다). 그 뒤
  - 표시 대상 백그라운드 작업(`ambient` 가 아닌 것)이 **없으면** 지금처럼 입력을 닫고 끝낸다.
  - **있으면** 입력을 닫지 않고 프로세스를 붙든다. 반복자(`for await`)는 계속 읽는다 — 지금의 `if (ended) continue;` 자리가 바뀐다.
- 붙든 프로세스는 작업 목록이 비고, 돌고 있는 턴이 없을 때 닫는다(짧은 유예 뒤, 지금의 `closeLater` 와 같은 길).
- **자리:** 붙든 프로세스도 러너 전역 동시 상한(`createScheduler(max)`)의 자리 하나를 쓴다 — 그 상한이 메모리 때문에 있기 때문이다. 자리가 차면 새 런은 지금처럼 기다리고, 기다리는 사유를 알린다(D7). 러너는 대기를 알릴 때 「붙든 프로세스 때문」인지와 그 수를 함께 싣는다(지금 `queuedPosition` 옆 — 칸 이름은 builder). 화면의 「종료」로 자리를 비운다.
- **같은 세션의 새 런:** 세션 프로세스가 붙들려 있는 세션에 `run.start` 가 오면 새 `query()` 를 띄우지 않고 그 프로세스의 입력으로 프롬프트를 넣는다. 지금의 `sessionTaken` → `busy` 거절은 이 경우에 「이어 쓰기」로 바뀐다. 같은 세션 파일을 두 CLI 가 쓰면 안 되기 때문이다(ADR 0007 4.3).
- **한 번에 한 턴:** 한 세션 프로세스 안에서는 턴 하나씩 돈다. 추가 응답 턴이 도는 중에 사람 런의 프롬프트가 오면 그 턴의 `result` 뒤에 넣는다 — CLI 가 도는 턴에 사용자 글을 합쳐 버릴 수 있어서다(`thinking_tokens` 주석의 「folded」). 실제 동작은 5.9 에서 잰다.
- **런마다 다시 꽂는 것:** 지금 `attempt()` 는 아래를 `query()` 를 만들 때 한 번 고정한다. 붙든 프로세스에서는 이것들이 「지금 런」을 가리키게 바꾼다 — 안 그러면 추가 응답·다음 사람 런의 글이 첫 런의 deliver·runId 로 나간다.
  - `message` 도구의 보내는 곳(`createPoster` 의 `deliver`·`signal`), 제어 도구의 `runId`(`createControlTools`), 승인 콜백의 `runId`·`sessionKey`·`signal`(`createCanUseTool`), 턴 문맥(`UserPromptSubmit` 훅의 `turnFacts`).
  - 런 단위 「항상 허용」(`alwaysAllowed`)은 **런 단위 그대로** 둔다 — 프로세스 단위로 넓히지 않는다(제 판단, 보안).
- 런 단위 설정(모델·권한 모드·채널 규칙·effort·봇 MCP·허용 도구)은 `buildQueryOptions` 가 query 를 만들 때 넣는다. 붙든 프로세스에 들어가는 다음 런은 D6 대로 — 러너가 붙든 프로세스의 옵션과 새 런의 옵션을 비교해 바꿀 수 있는 것은 그 턴 전에 바꾸고, 못 바꾼 것이 있으면 `run.event` 로 표시용 CUSTOM 이벤트(이름은 builder)를 낸다. 웹 카드가 그것으로 D6 표시를 붙인다. 러너가 ceiling(천장)을 런마다 보는 검사는 붙든 프로세스에서도 런마다 그대로 한다.

### 5.3 러너 — 추가 응답 턴

붙든 프로세스에서 사용자 입력 없이 턴이 시작되면(첫 `assistant`·`stream_event` 가 런 없이 온다) 러너는 서버에 추가 응답 런을 청한다.

- 새 러너 → 서버 프레임 `run.followup` (ack 있음): `{ sessionKey, originRunId, taskIds }`. 서버가 런을 만들고 `runId` 와 그 런의 `deliver` 를 돌려준다.
- ack 전에 온 SDK 메시지는 러너가 모아 두었다가 ack 뒤에 그 런의 이벤트로 낸다.
- 서버가 거절하면(일일 런 한도·보관한 채널·끈 에이전트·닫은 세션) 러너는 그 턴을 `interrupt()` 로 멈추고 모은 것을 버린다. 거절 알림은 서버가 스레드에 남긴다(5.5).
- 그 턴의 `result` 는 지금처럼 `final` 로 낸다. 비용은 같은 프로세스의 누적값 차이라 지금 `recordCost` 그대로 맞는다.
- 승인이 필요한 도구는 지금 길(`canUseTool` → 승인 카드)을 그대로 탄다.
- **원래 런이 여럿일 때:** 서로 다른 런이 띄운 작업들이 한 턴에 함께 끝나면 `originRunId` 는 **그 턴을 연 알림(가장 먼저 온 `task_notification`)의 작업이 시작된 런**이고, `taskIds` 에 함께 끝난 것을 모두 싣는다(제 판단). 답은 그 런의 응답 스레드 하나에 간다.
- **사람 런 턴 도중에 끝난 작업:** CLI 가 그 알림을 사람 런의 턴에 섞어 답하면 그 답은 사람 런의 응답으로 간다. 추가 응답 런을 따로 만들지 않는다 — 작업 줄은 `tasks.update` 로 사라진다(제 판단).
- **원래 런이 스레드 런일 때:** 스레드 안에 스레드는 없으므로 추가 응답은 **그 스레드**에 쓴다. 이때는 세션 키와 보낼 자리가 같아 「응답 스레드 루트」 칸이 지금 규칙과 같은 값이 된다(제 판단).
- **중지·타임아웃:** 붙든 프로세스에서 돈 턴(사람 런·추가 응답 런)을 「중지」하거나 `runMs` 가 지나면 **그 턴만** `interrupt()` 한다. 프로세스와 백그라운드 작업은 남고 작업 줄의 「종료」로 끈다. 지금 `onAbort` 의 `closeLater()` 는 붙든 프로세스에서는 부르지 않는다(작업이 없을 때만). 처음 런이 아직 돌 때 「중지」해도 같다 — 지금은 interrupt 가 백그라운드 셸을 함께 죽이므로(ADR 0007 5.4) 스파이크 3 에서 interrupt 가 작업을 살려 두는지도 잰다. 살려 두지 못하면 지금 동작(함께 죽음)을 받아들이고 화면에 「중지하면 백그라운드 작업도 꺼집니다」를 적는다(제 판단).

### 5.4 러너 — 작업 상태 보고

- 새 러너 → 서버 프레임 `tasks.update` (ack 없음, 바꿔 끼우는 값): `{ sessionKey, tasks: [{ taskId, kind: "shell" | "subagent" | "other", description, subagentType?, startedAt, originRunId, toolUseId?, lastToolName?, summary? }] }`.
  - `kind` 는 `task_type` 으로 가른다(`local_bash` → shell, `local_agent` → subagent, 나머지 other).
  - `originRunId` 는 그 작업이 시작된(`task_started`) 때 돌던 런. 백그라운드로 옮겨 간 앞쪽 작업(`task_updated.patch.is_backgrounded`)도 그 런이다.
  - `description`·`summary` 는 호스트 경로를 지금 가림(`mask.ts`)으로 가리고 길이를 자른다.
- 보낼 때: `background_tasks_changed`·`task_started`·`task_progress`·`task_updated`·`task_notification` 마다(같은 세션에서 초당 한 번으로 묶는다 — 제 판단). 붙든 프로세스가 닫히면 빈 목록을 한 번 보낸다.
- 러너가 서버에 다시 붙으면(hello 뒤) 살아 있는 세션 프로세스마다 지금 목록을 한 번씩 보낸다.

**런이 도는 동안의 서브에이전트:** 지금 `stream-map.ts` 는 `parent_tool_use_id` 가 있는 스트림을 버린다. 이것은 그대로 두고, `task_started`(local_agent) → `SUBAGENT_STARTED`, `task_notification` → `SUBAGENT_FINISHED`/`SUBAGENT_ERROR` 를 **그 런의 이벤트**로 더 낸다(계약 `packages/shared/src/events/index.ts` 에 이미 있고 웹 타임라인에 「서브에이전트 줄」이 있다). 런이 끝난 뒤의 상태는 런 이벤트가 아니라 `tasks.update` 로만 간다 — 끝난 런의 이벤트는 서버가 버린다(`applySignal`).

### 5.5 서버

- **작업 목록은 메모리에만** 둔다(러너 연결의 `RunnerLive` 와 같은 결). 키는 러너 토큰 + 세션 키. 러너가 끊기면 그 러너의 목록을 「연결 끊김」으로 표시하고, 다시 붙어 보낸 목록으로 바꾼다. 다시 붙은 뒤 일정 시간 안에 오지 않은 세션의 작업은 사라진 것으로 본다(러너 재시작 — 아래).
- **wire:** 그 대화를 볼 수 있는 사람에게만 `tasks.updated { conversationId, originRunId 별 작업 }` 를 내고, 채널·대화 구독 때 지금 값을 한 번 준다. 볼 권한은 활동 탭과 같다(`auth/channel-access.ts`).
- **추가 응답 런 만들기(`run.followup`):**
  - 런 관문(`createRunGate().enqueue`)을 지난다 — 일일 한도·보관·끈 에이전트가 그대로 막는다.
  - 시킨 사람(`requestedBy`)은 원래 런의 값.
  - **세션 큐:** 추가 응답 턴은 러너 안에서 이미 시작됐다. 서버는 이 런을 큐에 줄 세우지 않고 곧바로 「도는 중」으로 만든다. 같은 세션 큐에 기다리는 사람 런이 있으면 그 런은 이 런 뒤로 간다. 러너 쪽에서도 한 번에 한 턴이라(5.2) 순서가 맞는다.
  - **보낼 자리:** 대화는 원래 런의 대화, 스레드 루트는 원래 런의 첫 응답 메시지(`RUN_FINISHED.messageIds[0]`). 지금 런은 세션 키로 보낼 자리를 정한다(「에이전트의 글은 그 세션 키의 대화에만」). 이 런은 **채널 세션 키로 돌면서 스레드에 쓴다** — 런에 「응답 스레드 루트」 칸을 더한다. 원래 런의 응답 메시지가 없으면(도구만 쓰고 답이 없던 런) 그 런의 트리거 메시지를 루트로 쓴다(제 판단).
  - 거절되면 스레드에 시스템 글: 「백그라운드 작업이 끝났지만 <사유>로 이어서 답하지 못했습니다」.
- **런 타임아웃(`runMs` 10분)** 은 추가 응답 런에도 그대로다 — 붙든 시간이 아니라 그 턴의 시간이다.
- **끄기:** `POST /api/v1/runs/:runId/tasks/:taskId/stop` → 러너 → 서버 프레임 `task.stop { sessionKey, taskId }` → `q.stopTask(taskId)`. 권한은 그 런의 「중지」와 같다(제 판단). 끈 결과는 `tasks.update` 로 돌아온다.
- **함께 끄는 때:** 세션 닫기(`abortConversation`)·에이전트 보관·채널 보관·대화에서 에이전트 내보내기(`abortConversationAgent`)는 그 세션의 작업을 모두 끄고 붙든 프로세스를 닫는다. 새 프레임 `session.release { sessionKey }`.
- **작업이 죽은 채 끝났을 때:** 러너 재시작·원격 업데이트·연결 끊김 뒤 작업이 사라지면, 그 작업의 원래 런 응답 스레드에 시스템 글 「백그라운드 작업이 끝나지 못했습니다 — 러너가 다시 시작됐습니다」를 남긴다.

### 5.6 러너 원격 업데이트

지금 `selfUpdate` 의 `busy` 는 `scheduler.size() > 0` 이다. 붙든 프로세스를 busy 로 세면 끝나지 않는 작업 하나가 업데이트를 영영 막는다. 그래서 **붙든 프로세스는 busy 로 세지 않고**, 업데이트 화면(설정 → 연결 → 러너 상세)이 「백그라운드 작업 N개가 꺼집니다」 확인을 받는다. 업데이트가 시작되면 5.5 의 「죽은 채 끝났을 때」 알림이 남는다(제 판단).

### 5.7 웹 — 활동 탭 런 카드

`docs/manual/user-guide.md` 「활동 탭 — 실행과 도구 기록」 의 카드에 더한다.

```
[@coder CC] 완료 · 백그라운드 2          14:02 · 3분
  ● 셸  pnpm dev                  12분째   [종료]
  ● 서브에이전트 Explore — 파일 찾기   2분째   [종료]
```

- 카드 머리 상태 칩 옆에 「백그라운드 N」(N > 0 일 때만). 화면 읽기는 「백그라운드 작업 N개」.
- 카드가 접혀 있어도 작업 줄은 보인다(끝난 런에서 사람이 찾는 것이 이것이다 — 제 판단).
- 줄: 종류 배지, 설명(`description`), 서브에이전트면 `subagentType`·`summary`·`lastToolName` 한 줄, 걸린 시간(`startedAt` 부터, 화면에서 센다), 「종료」. 「종료」는 끄기 권한이 있는 사람에게만.
- 「연결 끊김」이면 줄이 흐리고 「러너 연결 끊김」, 「종료」 없음.
- 거르기 칩: 「진행 중」에 백그라운드 작업이 있는 끝난 런도 넣는다(제 판단). 「백그라운드」 칩은 따로 두지 않는다.
- 추가 응답 런은 보통 런 카드로 나온다. 카드에 「추가 응답 · <원래 런 시작 시각> 런」 표시를 붙여 원래 런과 잇는다.
- 같은 정보를 DM 의 활동 탭에도 낸다(DM 활동 탭은 같은 구성 요소다).

### 5.8 에이전트가 받는 것

- 추가 응답 턴은 CLI 가 스스로 연 턴이라 dodok 헤더·턴 문맥(`turnFacts`)이 붙지 않는다. 모델이 쓰는 `message` 도구의 보내는 곳은 그 런의 deliver(스레드)다. 그래서 모델 쪽은 바뀌지 않는다.
- 문서: `docs/guides/agent-guide.md` 에 「백그라운드 작업」 절 — 끝나면 이어지는 답이 그 응답의 스레드로 간다, 스레드에서 사람이 물으면 그 스레드 세션이 받으며 셸은 만지지 못한다, 러너 재시작 때 작업은 죽는다.

### 5.9 먼저 잴 것 — 스파이크(런 0회 하네스)

`docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」(로컬 가짜 Messages API)로 잰다. 결과는 ADR 0007 에 덧붙인다. **이 넷 중 하나라도 가정과 다르면 5.2·5.3 을 다시 정하고 사용자에게 알린다.**

1. 첫 `result` 뒤 입력을 열어 두면, 백그라운드 셸이 끝날 때 CLI 가 **사용자 입력 없이 턴을 여는가**. 열면 어떤 메시지 순서로 오는가(`task_notification` → `assistant` … → `result`).
2. 추가 응답 턴이 도는 중에 입력으로 사용자 글을 넣으면 그 턴에 합쳐지는가, 다음 턴이 되는가.
3. `stopTask` 가 셸·백그라운드 서브에이전트 둘 다 끄고 `task_notification { stopped }`·`background_tasks_changed` 를 내는가.
4. 백그라운드 서브에이전트가 `task_started { task_type: "local_agent", is_backgrounded: true }` 를 내고, 끝나면 1 과 같이 턴을 여는가.
5. 프롬프트 턴 도중 `interrupt()` 가 백그라운드 작업을 함께 죽이는가(ADR 0007 은 죽인다고 적었다 — 붙든 프로세스에서도 같은가).

**계획은 두 단계로 끊는다(제 판단):** 먼저 스파이크만 하고 결과를 사용자에게 보인 뒤 구현에 들어간다. 1·4 가 「스스로 턴을 열지 않는다」로 나오면 대안은 러너가 알림을 받아 **합성 사용자 입력**(「백그라운드 작업 <설명>이 <상태>로 끝났습니다 — 결과를 알려 주세요」)을 넣어 턴을 여는 것이다. 이때는 5.3 의 「런 없는 첫 메시지 감지」 대신 러너가 먼저 `run.followup` 을 청하고, 그 입력에 dodok 헤더·`turnFacts` 를 싣는다. 이 대안으로 갈지는 스파이크 결과와 함께 사용자에게 묻는다.

## 6. 바뀌는 계약

- 러너 프로토콜(`packages/shared/src/runner/index.ts`): 러너 → 서버 `run.followup`(ack), `tasks.update`. 서버 → 러너 `task.stop`(ack), `session.release`. 새 capability `backgroundTasks` — 없는 옛 러너는 지금 동작 그대로(서버는 프레임을 보내지 않고 화면에 작업 줄이 없다).
- wire: `tasks.updated`, 구독 스냅샷.
- 런: 「응답 스레드 루트」 칸, 「원래 런」 칸(추가 응답 런 → 원래 런), 트리거 종류 「백그라운드 작업」.
- REST: `POST /api/v1/runs/:runId/tasks/:taskId/stop`.
- 런 이벤트: 러너가 `SUBAGENT_*` 를 내기 시작한다(계약은 이미 있다).

## 7. 시험

- 러너: 가짜 SdkPort(`test/helpers/fake-query.ts`)로 — 작업이 남은 `result` 뒤 프로세스를 붙든다 / 작업이 비면 닫는다 / 사용자 입력 없는 턴 → `run.followup` → 이벤트 순서 / 거절이면 interrupt / 붙든 세션에 `run.start` 가 오면 같은 프로세스 / 한 번에 한 턴 / `task.stop` → `stopTask` / `tasks.update` 묶기·가림 / 재접속 뒤 다시 보내기 / 자리 상한에 붙든 프로세스가 든다.
- 서버: `run.followup` 이 관문·한도·보관을 지난다 / 보낼 자리가 첫 응답 스레드 / 세션 큐 앞에 선다 / 끄기 권한 / 세션 닫기·보관이 `session.release` 를 보낸다 / 러너 끊김·재시작 알림.
- 웹: 카드의 「백그라운드 N」·작업 줄·「종료」 권한·「연결 끊김」·추가 응답 표시.
- dev:fake: 가짜 러너에 「백그라운드」 대본(셸 하나·서브에이전트 하나, 몇 초 뒤 끝남, 하나는 끝나지 않음)을 더해 손 확인할 수 있게 한다.

## 8. 문서

- `docs/manual/user-guide.md` 「활동 탭」·「스레드」 절.
- `docs/guides/agent-guide.md` 「백그라운드 작업」 절.
- `docs/adr/0007-claude-agent-sdk-spike.md` 스파이크 결과.
- `docs/guides/plan.md` 8장 완료 항목·이월.
- AGENTS.md(`.ruler/` 소스) dev:fake 설명에 새 대본.

## 9. 제 판단으로 정한 것(사용자 확인 필요)

- 출력 실시간 보기는 뺀다.
- 끄기 권한은 그 런의 「중지」와 같다.
- 런 단위 「항상 허용」은 붙든 프로세스에서도 런 단위로 둔다.
- 여러 원래 런의 작업이 한 턴에 끝나면 그 턴을 연 알림의 런 스레드 하나로. 사람 런 턴에 섞인 알림은 따로 추가 응답을 만들지 않는다.
- 스레드 런의 추가 응답은 그 스레드에.
- 붙든 프로세스의 턴을 중지·타임아웃하면 그 턴만 멈추고 작업은 남긴다.
- 계획은 스파이크 → 결과 보고 → 구현의 두 단계. 스스로 턴을 열지 않으면 합성 입력 대안을 그때 묻는다.
- 붙든 프로세스는 원격 업데이트의 busy 로 세지 않고, 업데이트 확인을 받는다.
- 카드가 접혀 있어도 작업 줄이 보이고, 「진행 중」 거르기에 든다.
- 응답 메시지가 없는 런의 추가 응답은 트리거 메시지 스레드로.
- `tasks.update` 는 세션마다 초당 한 번으로 묶는다.

## 10. builder 에게 남긴 것

- 세션 프로세스의 코드 구조·이름, 러너 `run.ts` 를 어떻게 가를지.
- 서버 작업 목록의 자료 구조, wire 이벤트 이름.
- 「다시 붙은 뒤 일정 시간」 값.
- 웹 줄 모양의 세부(5.7 의 스케치 안에서).
