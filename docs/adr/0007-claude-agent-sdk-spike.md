# ADR 0007 — Claude Agent SDK 스파이크 (Phase 4 로컬 러너 어댑터 설계의 근거)

- 상태: 완료 (실측, 가짜 CLI, **모델 런 0회**) — 로컬 러너 스펙이 「설계에 주는 제약과 추천」 절을 입력으로 받는다
- 날짜: 2026-09-27
- 대상: `docs/plan.md` 「5.7 에이전트 어댑터 인터페이스 (후속 연동 대비)」 절·기술 표의 「에이전트 이벤트 표준」, `packages/openclaw-adapter/src/adapter-types.ts` 의 `AgentAdapter`·`AdapterEvent`
- 산출 코드: 없음 — 가짜 CLI·드라이버·스크래치 설치본은 버렸다
- 근거 원장(git 제외): `.superpowers/sdd/2026-09-27-claude-runner-spike/p4c-spike-report.md` — 요약·모델 런이 필요한 것·정리 상태

## 1. 결론

| # | 질문 | 답 |
| --- | --- | --- |
| 1 | 스트리밍 모양, 최종 답 가르기 | `includePartialMessages: true` 면 Anthropic 스트리밍 이벤트가 **`stream_event` 로 그대로** 온다(`message_start`·`content_block_*`·`message_delta`·`message_stop`, 도구 인자는 `input_json_delta`). SDK 는 CLI 가 낸 간격을 그대로 넘긴다(가짜 CLI 40ms 간격 → 소비 쪽 41ms). 완성본은 블록마다 `assistant`(같은 `message.id`), 도구 결과는 `user` 의 `tool_result`, 턴 끝은 `result` 한 건. **최종 답은 `result.result`**(마지막 API 메시지의 텍스트) — 중간 텍스트는 `stop_reason: "tool_use"` 로 끝난 API 메시지에 있다 |
| 2 | 권한 콜백 | `canUseTool(toolName, input, { signal, toolUseID, requestId, title, displayName, description, suggestions, mcpServer, … })` → `{ behavior: "allow", updatedInput?, updatedPermissions? }` 또는 `{ behavior: "deny", message, interrupt? }`. **SDK·CLI 어느 쪽에도 기한이 없다** — 330초 기다린 허용이 그대로 먹었고, CLI 의 권한 요청 경로에는 타이머가 없다(5분 기한 `dialogExpiry` 는 `request_user_dialog` 몫이다). 입력 수정(`updatedInput`)이 된다. 대기 중 중지하면 CLI 가 `control_cancel_request` 를 보내고 SDK 가 콜백의 `signal` 을 끊는다 |
| 3 | 세션 | 세션 id 는 `system/init` 과 모든 메시지의 `session_id`. **러너가 id 를 정할 수 있다** — 첫 런 `sessionId: <UUID>`(→ `--session-id=`), 다음 런 `resume: <id>`(→ `--resume=`). 리셋은 새 UUID 로 시작하면 끝이다. 저장 위치는 `CLAUDE_CONFIG_DIR` 로 옮겨진다(CLI·SDK 헬퍼 둘 다 — 단 5.2 의 두 함정). `query()` 하나가 CLI 프로세스 하나라 한 Node 프로세스에서 세션 30개를 동시에 돌렸다 |
| 4 | 중지 | `q.interrupt()` 는 제어 요청이라 **프로세스를 살려 둔 채** 그 턴만 끝낸다 — 도구 실행 중·스트리밍 중 모두 먹었고, 같은 프로세스에 다음 턴을 보낼 수 있었다. `AbortController.abort()`·`q.close()` 는 stdin 을 닫고 **2초 뒤 SIGTERM, 다시 5초 뒤 SIGKILL**. abort 는 반복자가 `AbortError` 로 던지고 close 는 조용히 끝난다 |
| 5 | 채널 프롬프트·문맥 | `systemPrompt: { type: "preset", preset: "claude_code", append }` 의 `append` 는 **프로세스 시작 때 `initialize.appendSystemPrompt` 로 한 번** 간다. 기본값(`snapshot` 생략·`true`)은 대화의 첫 요청에서 시스템 프롬프트를 **기록하고 resume 뒤에도 그 기록을 쓴다** — ADR 0003 과 같은 부류다. **`snapshot: false` 면 요청마다 새로 렌더**한다. 헤더를 사용자 메시지 말고 넣는 길은 `UserPromptSubmit` 훅의 `additionalContext`(턴마다, 러너 안에서 돈다) |
| 6 | 채널로 쓰는 도구 | 된다. `createSdkMcpServer` + `tool()` 로 러너 **프로세스 안에** 도구를 둔다. CLI 가 `mcp_message` 제어 요청으로 부르고 핸들러가 러너에서 돈다 — 인자와 `extra._meta["claudecode/toolUseId"]` 를 받는다. 핸들러가 1.5초 서버 왕복을 기다려도 그 결과가 `tool_result` 로 모델에게 갔다. 이름은 `mcp__<서버>__<도구>` |
| 7 | 자원 | SDK 쪽은 세션당 약 0.25 MB(30개 동시 86 → 93 MB). **CLI 프로세스 하나가 유휴 RSS 약 172 MiB**·스레드 20(번들 CLI 를 인증 없이 `initialize` 만 주고 잰 값, 외부 연결 0). 동시 세션 수의 상한은 SDK 가 아니라 이 CLI 메모리다 |
| 8 | 모델 런이 있어야 아는 것 | 「확인 못 한 것 — 모델 런이 있어야 아는 것」 절 |

## 2. 환경

| 항목 | 값 |
| --- | --- |
| SDK | `@anthropic-ai/claude-agent-sdk@0.3.283`(npm `latest`·`next` 같은 값), `claudeCodeVersion: "2.1.283"`. 라이선스 `SEE LICENSE IN README.md` — 패키지 `LICENSE.md` 는 「© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.」 **오픈소스 라이선스가 아니다** |
| 피어 의존성 | `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0` — 루트 엔트리는 피어를 번들에 품고, `/core` 엔트리는 설치본을 쓴다(한 프로세스에서 둘을 섞지 않는다) |
| 번들 CLI | 플랫폼별 선택 의존성 `@anthropic-ai/claude-agent-sdk-<os>-<arch>` 의 네이티브 바이너리 `claude`(darwin-arm64 225 MB). `pathToClaudeCodeExecutable` 을 안 주면 SDK 가 이것을 찾는다. **스파이크 동안 이름을 바꿔 실행 불가로 막았다** — 4.7 의 유휴 측정 한 번만 조율자 승인 아래 직접 띄웠다 |
| Node | 24.21.0 (저장소 `mise.toml` 핀) |
| 가짜 CLI | Node 스크립트. `pathToClaudeCodeExecutable` 에 두면 SDK 가 **셸뱅 실행 파일을 그대로** spawn 한다. 사용자 메시지 안 지시어로 시나리오를 고른다 — 스트리밍, 도구(`Bash`), 권한 요청(`can_use_tool`), SDK MCP 호출(`mcp_message`), `UserPromptSubmit` 훅(`hook_callback`), 긴 도구(`tool_progress` 뒤 대기, `interrupt` 가 오면 멈춤), stdin EOF·SIGTERM 무시 |
| 격리 | `HOME`·`CLAUDE_CONFIG_DIR` 은 스크래치, `settingSources: []`, `options.env` 를 명시(주지 않으면 SDK 는 `process.env` 전체를 넘긴다). 사용자 `~/.claude`·키·env 는 읽지 않았다 |

## 3. 실측 — CLI 를 부르는 모양

- argv(문자열 프롬프트도 같다): `--output-format stream-json --verbose --input-format stream-json --setting-sources= --permission-mode default`. 옵션이 붙이는 것 — `allowedTools` → `--allowedTools <이름>`, `canUseTool` → `--permission-prompt-tool stdio`, `includePartialMessages` → `--include-partial-messages`, `sessionId` → `--session-id=<id>`, `resume` → `--resume=<id>`, `forkSession` → `--fork-session`, `resumeSessionAt` → `--resume-session-at=<uuid>`, `persistSession: false` → `--no-session-persistence`.
- env 는 `options.env` 에 SDK 가 `CLAUDE_AGENT_SDK_VERSION`·`CLAUDE_CODE_ENTRYPOINT` 를 더한 것.
- stdin 첫 줄은 `control_request { subtype: "initialize", … }` — `appendSystemPrompt`·`systemPrompt`·`systemPromptSnapshot`·`hooks`(콜백 id)·`sdkMcpServers`·`sdkMcpServerManifests`(도구 목록을 미리 실어 CLI 의 핸드셰이크 왕복을 던다). 그다음 `user` 레코드가 프롬프트다.
- ⚠ **`systemPrompt` 를 안 주면 SDK 는 `systemPrompt: [""]` 를 보낸다** — Claude Code 기본 프롬프트가 아니라 빈 사용자 정의 프롬프트다. Claude Code 의 도구 안내·작업 방식을 원하면 `{ type: "preset", preset: "claude_code" }` 를 명시한다.
- 문자열 프롬프트도 stdin 을 첫 `result` 까지 열어 두므로 `interrupt()`·`canUseTool`·SDK MCP 가 모두 된다(첫 결과를 기다리는 데 기한이 없다). 스트리밍 입력(`AsyncIterable<SDKUserMessage>`)이면 프로세스 하나로 여러 턴을 잇는다.

## 4. 실측 — 질문별

### 4.1 스트리밍 (질문 1)

도구 하나를 쓰는 턴의 소비 쪽 순서(`includePartialMessages: true`, 가짜 CLI 간격 40ms):

```
system init
stream_event message_start
stream_event content_block_start {type:"text"} idx=0
stream_event content_block_delta {type:"text_delta", text:"안녕"} idx=0      … 5회, 41ms 간격
stream_event content_block_stop idx=0
stream_event content_block_start {type:"tool_use", id, name:"Bash", input:{}} idx=1
stream_event content_block_delta {type:"input_json_delta", partial_json:"{\"command\":\""} idx=1   … 4회
stream_event content_block_stop idx=1
stream_event message_delta {stop_reason:"tool_use"} · message_stop
assistant  message.id=msg_1 content=[text, tool_use]         ← 실제 CLI 는 블록마다 한 건씩(같은 message.id)
user       [tool_result {tool_use_id, content, is_error}]  tool_use_result={stdout, stderr}
stream_event message_start … text_delta "최종 답: 완료" … message_stop
assistant  message.id=msg_2 content=[text]
result     success result="…" session_id usage total_cost_usd modelUsage permission_denials
```

- 부분 메시지의 **간격은 CLI 가 낸 그대로**다 — SDK 가 묶거나 늦추지 않는다(실제 모델의 간격은 모델 런으로만 안다).
- 완성본 `assistant` 는 SDK 타입 문서대로 **블록마다 한 건, 같은 `message.id`**, 중단으로 잘린 것에는 `aborted: true` 가 붙는다(가짜 CLI 는 한 건에 몰아 냈다).
- 턴마다 `result` 가 정확히 한 건이다. 성공이면 `subtype: "success"` 와 `result`(최종 텍스트), 실패는 `error_during_execution`·`error_max_turns`·`error_max_budget_usd`·`error_max_structured_output_retries` 와 `errors[]`. `total_cost_usd`·`modelUsage` 는 **query() 누적**이다(스트리밍 입력에서 턴마다 합이 아니라 마지막 값을 읽는다).
- 그 밖에 흐름에 섞이는 것: `tool_progress`(도구 실행 중 경과), `system/permission_denied`, `system/session_state_changed`(`idle`·`running`·`requires_action`), `tool_use_summary`, `conversation_reset`(`/clear` 류).

### 4.2 권한 콜백 (질문 2)

| 경우 | 결과 |
| --- | --- |
| 330초 기다렸다 허용(`updatedInput` 으로 명령을 바꿈) | CLI 가 330,003ms 뒤 응답을 받고 **바뀐 입력으로** 도구를 돌렸다. 반복자는 그동안 조용히 기다렸다 |
| 거절 `{ behavior: "deny", message }` | `tool_result` 가 `is_error: true`, 내용은 그 `message` 그대로 — 모델에게 사람의 거절 사유가 간다. 턴은 이어진다 |
| 대기 중 `interrupt()` | CLI 가 `control_cancel_request` → SDK 가 콜백 `signal` 을 끊음(`AbortError`). 콜백이 뒤늦게 돌려준 값은 버려진다. `tool_result` 는 `Tool permission request aborted`, 턴은 `error_during_execution` |
| 대기 중 `abort()` | 콜백 `signal` 이 끊기고 stdin 이 닫힌다. 반복자가 `AbortError`(`Operation aborted`)로 던진다 |
| 대기 중 `close()` | 콜백 `signal` 이 끊기고 반복자가 조용히 끝난다 |

- **기한** — SDK: `CanUseTool` 문서 「permission prompts have no park deadline」, 첫 결과를 기다리는 `waitForFirstResult` 에도 타이머가 없다. CLI(번들 2.1.283, 정적 조회): 권한 요청은 `can_use_tool` 을 보내고 훅(`PermissionRequest`)과 경주만 한다 — 타이머 없음. 오류로 끝나는 길은 둘뿐이다 — 턴 중단이면 `Tool permission request aborted`, 스트림이 닫히면 거절. 5분 기본값(`dialogExpiry`·`CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS`)은 `request_user_dialog`(AskUserQuestion 류) 경로다.
- **`null` 을 돌려주지 않는다** — `null` 은 「응답을 따로 보냈다」는 뜻이라 SDK 가 응답을 안 쓰고 도구가 영원히 막힌다(타입 문서).
- **미리 허용과 모드** — `allowedTools`(→ `--allowedTools`)에 든 도구는 콜백 없이 돈다(가짜 CLI 는 그 판단을 흉내만 냈다 — 판단은 CLI 몫). `disallowedTools` 는 모델 문맥에서 도구를 뺀다. `permissionMode`: `default`·`acceptEdits`·`plan`·`dontAsk`(미리 허용 안 된 것은 묻지 않고 거절)·`bypassPermissions`(`allowDangerouslySkipPermissions` 필수). `permissionPrompts: "none"` 은 콜백을 아예 부르지 않고 물어야 할 것을 즉시 거절한다. `canUseTool` 과 `permissionPromptToolName` 은 같이 못 쓴다(SDK 가 던진다).
- **「항상 허용」** — 콜백의 `suggestions` 를 `updatedPermissions` 로 돌려주면 규칙이 붙는다. 제안의 `destination` 은 `session`·`localSettings`·`userSettings`·`projectSettings`·`cliArg` 중 하나라 **그대로 돌려주면 사용자 파일에 규칙이 써질 수 있다** — 러너는 `destination: "session"` 으로 바꿔 돌려준다(6절 5).
- MCP 도구의 권한 요청에는 `mcpServer: { name, source }` 가 붙는다. `source: "sdk"` 가 러너가 등록한 도구다 — 신뢰 판단은 이름이 아니라 `source` 로 한다(타입 문서).

### 4.3 세션 (질문 3)

- `sessionId`(UUID)를 주면 CLI 가 그 id 로 시작한다. `resume` 은 전사를 읽어 잇는다. `sessionId` 는 `resume` 과 함께 못 쓴다(`forkSession` 일 때만 — 포크의 새 id).
- 세션 하나를 `query()` 하나로 붙잡고 스트리밍 입력으로 두 턴을 보내자 **같은 CLI 프로세스가 두 턴을 처리**했다. 턴 사이에 보낸 `applyFlagSettings` 는 제어 요청으로 건너갔지만 `appendSystemPrompt` 는 설정 키가 아니라 바뀌지 않는다(5.3).
- 리셋 — CLI 에 할 일이 없다. 새 UUID 로 첫 런을 시작하면 새 세션이다. 옛 전사를 지우려면 `deleteSession(id)`.
- 한 프로세스 여러 세션 — `query()` 마다 CLI 프로세스가 따로다(동시 1·10·30개 → 서로 다른 PID 1·10·30개, 각 2초 도구 턴의 벽시계 2.23~2.28초 — 병렬).
- **같은 세션 id 로 두 `query()` 를 겹쳐 돌리지 않는다** — 같은 전사 파일을 두 프로세스가 쓴다. 직렬화는 러너(와 서버 오케스트레이터의 세션 큐)가 한다. 이 스파이크는 겹쳐 돌리지 않았다.

### 4.4 중지 (질문 4)

| 방법 | 스트리밍 중 | 도구 실행 중 | 뒤에 이어 쓰기 |
| --- | --- | --- | --- |
| `q.interrupt()` | 제어 요청 → 응답 `{ still_queued: [] }` 즉시. 이미 버퍼에 있던 델타 1건이 더 오고 `result error_during_execution` | 같은 식. `tool_result` 가 `is_error: true` | **같은 프로세스에 다음 턴을 보내 정상 `result`** |
| `AbortController.abort()` | stdin 닫힘 → CLI 가 내던 것은 계속 소비됨 → 반복자 `AbortError` | stdin 닫힘 → **2초 뒤 SIGTERM** → 반복자 `Claude Code process aborted by user` | 프로세스가 끝난다 — 다음 런은 `resume` 으로 새 프로세스 |
| `q.close()` | abort 와 같은 종료 순서, 반복자는 조용히 끝남 | 같음 | 같음 |

- 종료 단계(SDK `ProcessTransport` 의 정리 코드): stdin EOF → 2초 → SIGTERM → 5초 → SIGKILL. SIGTERM 을 무시하는 가짜 CLI 에서 SIGTERM 이 2,001ms 에 왔다.
- interrupt 뒤 실제 CLI 가 내는 `result` 의 `subtype`·`errors` 모양과 전사에 남는 중단 표식은 가짜 CLI 로는 모른다(8절).

### 4.5 채널 프롬프트·문맥 (질문 5)

- `append` 는 `initialize.appendSystemPrompt` 로 **프로세스마다 한 번** 간다. 런마다 `query()` 를 새로 부르면(=`resume` 으로 새 프로세스) 그때의 채널 프롬프트가 간다 — 가짜 CLI 가 `resume` 네 번에 네 가지 `append` 를 각각 받았다.
- 그러나 CLI 는 기본적으로 **시스템 프롬프트를 대화의 첫 요청에서 기록하고, 이후 요청과 `resume` 에 그 기록을 그대로 보낸다**(`systemPrompt.snapshot` 생략·`true` — 타입 문서: 「a different `append` … passed on a later launch of the same session is ignored until compaction or a new session」). 이 기록은 계정별로 롤아웃 중이라 켜진 계정에서만 동작한다.
  → 기본값이면 **바뀐 채널 프롬프트가 기존 세션에 안 들어간다** — ADR 0003 「질문 1 — 채널 프롬프트가 기존 세션에」 절의 claude-cli 와 같은 부류이고, 계정에 따라 달라 더 나쁘다.
- `snapshot: false` 를 주면 SDK 가 `initialize.systemPromptSnapshot: false` 를 보낸다(실측) — 요청마다 새로 렌더한다. 대가는 채널 프롬프트가 바뀐 턴에서 프롬프트 캐시 접두가 깨지는 것뿐이다(바뀌지 않으면 같다).
- 턴마다 붙는 문맥의 길 셋:
  1. 사용자 메시지 본문 앞에 `[dodok context]` 헤더(지금 OpenClaw 플러그인과 같은 모양).
  2. **`UserPromptSubmit` 훅의 `additionalContext`** — 러너 프로세스 안의 콜백이 턴마다 돈다. SDK 쪽 왕복은 실측했다(CLI 가 `hook_callback` 을 보내면 SDK 가 콜백 출력 `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }` 을 돌려준다). 모델에게 어떤 모양으로 보이고 전사에 남는지는 모델 런으로만 안다.
  3. `SDKUserMessage.shouldQuery: false` — 턴을 일으키지 않고 전사에 붙였다가 다음 질의에 합친다(타입 문서, 미실측).

### 4.6 채널로 쓰는 도구 (질문 6)

- `createSdkMcpServer({ name: "dodok", tools: [tool("post_card", …, zodShape, handler)] })` 를 `mcpServers: { dodok }` 로 주면 SDK 는 **도구 목록을 `initialize` 에 미리 싣고**(`sdkMcpServerManifests` — JSON Schema 는 zod 에서 만든다, `maxItems: 5` 같은 제약도 들어간다), CLI 는 호출을 `control_request { subtype: "mcp_message", server_name, message: <JSON-RPC> }` 로 보낸다.
- 핸들러는 **러너 프로세스 안에서** `(args, extra)` 로 불린다. `extra._meta["claudecode/toolUseId"]` 가 그 `tool_use` id, `extra.signal` 이 있다. 핸들러가 await 하는 동안 CLI 는 기다리고, 돌려준 `{ content: [...] }` 가 `tool_result` 로 모델에게 간다.
- 따라서 러너는 OpenClaw `message` 툴 자리를 이렇게 채운다 — 도구 호출 → 러너가 `/runner` 로 서버에 `outbound.message`(런 id·세션 키 포함) → 서버 ack(메시지 id) → 핸들러가 `sent to dodok channel …` 를 돌려준다. **상관은 공짜다** — 런마다 `query()` 가 따로라 핸들러 클로저가 런을 안다(OpenClaw 의 세션 키별 `correlations` 가 필요 없다).
- 도구 호출에는 제한 시간이 있다 — 서버별 `timeout` 또는 `MCP_TOOL_TIMEOUT`(벽시계, 진행 알림으로 늘지 않는다). 기본값은 확인 못 했다. 카드를 올리는 도구는 짧으니 문제가 되지 않지만, 사람 응답을 기다리는 도구를 만들면 이 한도에 걸린다.

### 4.7 자원 (질문 7)

| 잰 것 | 값 | 재는 법 |
| --- | --- | --- |
| SDK(러너 Node) RSS | 동시 0 → 30 세션에서 86 → 93 MB | 「다시 재는 법」 3 |
| 동시 세션 | 1·10·30 모두 병렬(각 2초 턴, 벽시계 2.23~2.28초), CLI 프로세스 1·10·30개 | 「다시 재는 법」 3 |
| 번들 CLI 유휴 | RSS 176,528 → 176,816 → 177,024 KB(3초 간격), 스레드 20, 외부 연결 0 | 「다시 재는 법」 5 |

- 번들 CLI 는 `initialize` 만 받고 사용자 메시지 없이 섰다. 그 사이 `CLAUDE_CONFIG_DIR` 에 `.claude.json`·`backups/`·`.last-cleanup` 을 만들었고 `HOME` 에는 아무것도 쓰지 않았다 — **설정 파일도 `CLAUDE_CONFIG_DIR` 로 옮겨진다.** `initialize` 응답에는 `commands`·`models`(`default`·`opus`·`claude-fable-5-1`·`sonnet`·`haiku`)·`account` 등이 있다.
- 모델 런 중 메모리(전사·도구 출력이 쌓인 뒤)와 CLI 기동 시간은 재지 않았다(8절).

## 5. 함정

### 5.1 기본 시스템 프롬프트는 비어 있다

3절 — `systemPrompt` 를 생략하면 `[""]`. 러너는 늘 preset 을 명시한다.

### 5.2 `CLAUDE_CONFIG_DIR` 은 두 곳에 두고, 로그인이 따라오지 않는다

- SDK 는 `options.env.CLAUDE_CONFIG_DIR` 을 CLI 에 넘기지만, **SDK 쪽 세션 헬퍼(`listSessions`·`getSessionMessages`·`deleteSession`)는 러너 프로세스의 `process.env.CLAUDE_CONFIG_DIR`** 을 읽는다(없으면 `~/.claude`). 둘을 같게 둔다.
- CLI 는 `CLAUDE_CONFIG_DIR` 이 있으면 macOS 키체인 항목 이름에 그 경로의 sha256 앞 8자를 붙인다(`Claude Code-credentials-<8자>`, 정적 조회). **사용자가 평소 `claude` 로 로그인한 자격 증명이 안 보인다.** `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` 를 주면 접미사 없는 기본 이름으로 돌아간다(정적 조회 — 실제 로그인으로는 재지 않았다). 인증 방식(러너 전용 로그인·기본 로그인 공유·API 키)은 스펙이 고른다.

### 5.3 턴 사이 설정 변경으로는 `append` 가 안 바뀐다

`applyFlagSettings`·`updateSettings` 는 설정 계층을 바꾸고, `appendSystemPrompt` 는 설정 키가 아니다. 채널 프롬프트를 바꿔 반영하려면 새 프로세스(`resume`)와 `snapshot: false` 가 함께 있어야 한다.

### 5.4 `options.env` 를 안 주면 러너의 env 전부가 CLI 로 간다

SDK 기본값은 `{ ...process.env }`. 러너가 가진 브리지 토큰 같은 것이 CLI(와 그 도구가 여는 셸)로 새지 않게 env 를 허용 목록으로 만든다.

## 6. 설계에 주는 제약과 추천

1. **프로세스 단위 — 런마다 `query()` 하나(추천).** 첫 런은 `sessionId`, 이후는 `resume`. 런이 끝나면 프로세스가 끝나 유휴 세션이 메모리를 잡지 않는다(유휴 CLI 하나 약 172 MiB). 채널 프롬프트가 런마다 새로 간다(5.3). 런 도중에는 `interrupt()` 가 된다(문자열 프롬프트도 첫 결과까지 stdin 이 열려 있다 — 실측). 세션을 붙잡는 길(스트리밍 입력으로 상주)은 기동 비용을 아끼지만 채널 프롬프트를 못 바꾸고 메모리를 잡는다 — 기동 비용을 재 본 뒤(8절) 필요하면 `startup()`·`prewarm()` 으로 보탠다.
2. **세션 키와 Claude 세션 id** — dodok 세션 키(`dodokSessionKey`, 스레드면 `:thread:<rootId>`)는 그대로 쓰고, 그 키에 Claude 세션 UUID 를 하나 묶는다. **정본은 서버**가 갖기를 추천한다(세션 행에 `providerSessionId`) — 러너를 다시 깔거나 다른 머신으로 옮겨도 이어진다(전사 파일은 그 머신 `CLAUDE_CONFIG_DIR` 에 있다는 점은 남는다). 리셋은 서버가 새 UUID 를 정해 다음 런에 싣는다 — 러너에 할 일이 없다. 같은 키의 런은 서버 오케스트레이터의 세션 큐가 이미 직렬화한다 — 러너도 같은 세션 id 의 겹친 런을 거절한다.
3. **`/runner` 계약 초안**(서버 ↔ 러너, 러너가 나가는 연결 하나. 브리지처럼 hello·토큰·능력):

   | 방향 | 프레임 | 내용 |
   | --- | --- | --- |
   | 러너 → 서버 | `hello` | 러너 버전·SDK 버전·`claudeCodeVersion`·능력(`threads`·`interrupt`·`approvals`·`attachments`)·에이전트 목록(러너가 돌릴 수 있는 에이전트 id·작업 디렉터리 라벨 — 경로 원문은 싣지 않는다) |
   | 서버 → 러너 | `run.start` | 지금 `InboundDeliver` 에 `providerSessionId`·`resume: boolean`·`systemPromptAppend`(채널 프롬프트 + 릴레이 규칙)를 더한 것 |
   | 러너 → 서버 | `run.ack` | `{ runId, admission: "dispatch" \| "drop", reason? }` — `InboundDeliverResult` 와 같은 뜻 |
   | 러너 → 서버 | `run.event` | 러너가 4.1 을 `RunEventBody` 로 정규화한 것(아래 표). 서버는 `seq`·`ts` 를 붙인다 |
   | 러너 → 서버 | `run.final` | `{ runId, text, stopReason, usage?, costUsd? }` — `result` 에서. `OutboundMessage` 의 최종 답 자리(`finalSource` 가 플러그인 경로와 같은 역할) |
   | 러너 → 서버 | `outbound.message` | dodok 도구 호출(4.6) — 지금 `OutboundMessage` 그대로(`runId`·`sessionKey`·`threadId`·`components`·`attachmentIds`). 서버 ack 로 메시지 id 를 돌려받아 도구 결과로 쓴다 |
   | 러너 → 서버 | `approval.requested` / `approval.withdrawn` | `canUseTool` 이 불리면 / 그 `signal` 이 끊기면(4.2) |
   | 서버 → 러너 | `approval.resolve` | `{ approvalId, decision }` |
   | 서버 → 러너 | `run.abort` | `interrupt()` → 반응이 없으면 `close()` |
   | 러너 → 서버 | `run.error` | SDK 예외·`result` 오류·CLI 종료 |

   `RunEvent` 대응(4.1):

   | SDK | `RunEvent` |
   | --- | --- |
   | `stream_event content_block_start {text}` 가 그 API 메시지의 첫 텍스트 | `TEXT_MESSAGE_START { messageId: message.id }` |
   | `content_block_delta text_delta` | `TEXT_MESSAGE_CONTENT { messageId, delta }` |
   | `message_stop` (텍스트가 있었던 메시지) | `TEXT_MESSAGE_END` |
   | `content_block_start {tool_use}` | `TOOL_CALL_START { toolCallId: id, toolCallName: name, parentMessageId: message.id }` |
   | `content_block_delta input_json_delta` | `TOOL_CALL_ARGS { delta: partial_json }` |
   | `content_block_stop` (도구 블록) | `TOOL_CALL_END` |
   | `user` 의 `tool_result` | `TOOL_CALL_RESULT { content, ok: !is_error }` (`durationMs` 는 러너가 START 부터 잰다) |
   | `result success` | `run.final` → 서버가 `RUN_FINISHED` |
   | `result error_*` | `RUN_ERROR { code, message: errors.join }` |
   | `interrupt()` 로 끝난 턴 | `RUN_ABORTED { by: "user" }` |
   | `thinking` 블록·`tool_progress`·`system/*` | 버리거나 `CUSTOM`(활동 탭에 무엇을 보일지는 스펙) |

   **최종 답은 `result.result` 한곳**에서 만든다. 스트리밍 버블(중간 텍스트 포함)은 델타로, 채널에 남는 메시지는 `run.final` 로 — 지금 「델타는 Gateway WS, 정본은 플러그인」의 두 경로가 러너 한 연결 안의 두 프레임이 된다. 도구로 채널에 쓴 런의 최종 답을 따로 올릴지는 스펙이 정한다(지금 OpenClaw 9.5 는 둘 다 올린다 — `docs/guides/live-smoke.md` 「스레드(Phase 4 ①) 실연」 절).
4. **`AgentAdapter` 가 바뀔 자리** — `provider: "openclaw"` 를 `"openclaw" | "claude-runner"` 로. `connect`/`status` 의 뜻이 「Gateway·브리지」에서 「러너 연결」로 바뀌므로 `AdapterStatus`·`AdapterSetupDetail` 은 어댑터별로 가른다. `send` 는 그대로(`InboundDeliver` → `InboundDeliverResult`) 두되 러너는 세션 id·append 를 더 받는다. `abort(runId, sessionKey)` 는 그대로. `resetSession` 은 서버 안에서 새 UUID 를 정하는 것으로 끝난다(러너 왕복 없음 — `sessionStartedAt`·`lifecycleRevision` 은 서버가 만든다). `syncChannelConfig` 는 러너에 할 일이 없다(런마다 append 를 싣는다) — `{ applied: "live" }`. `resolveApproval` 의 `kind` 는 `ApprovalKind` 에 도구 승인 종류(예: `"tool"`)를 더하거나 `Bash` 만 `exec` 로 매핑한다 — 스펙이 고른다. `pluginSupports` 는 러너 hello 능력으로. `AdapterEvent` 의 `canonical` 은 `run.final`·`outbound.message` 가 채운다.
5. **승인 흐름** — `canUseTool` 이 불리면 러너가 `approval.requested`(`toolUseID`·`title`·`displayName`·`description`·`input` 요약·`suggestions` 유무)를 보내고 promise 를 붙잡는다. **기한은 dodok 이 정한다**(SDK·CLI 에 없다) — 서버가 `expiresAt` 에 `deny` 를 보내면 러너가 `{ behavior: "deny", message: "승인 시간이 지났습니다" }` 를 돌려준다. `allow-once` → `{ behavior: "allow" }`, `allow-always` → `updatedPermissions` 에 제안을 **`destination: "session"` 으로 바꿔** 싣는다(사용자 설정 파일에 쓰지 않는다), `deny` → 사유를 `message` 로(모델이 읽는다). 콜백 `signal` 이 끊기면(중지) `approval.withdrawn` → 서버가 `APPROVAL_RESOLVED { reason: "cancelled" 류 }`. 러너가 등록한 dodok 도구와 읽기 전용 도구는 `allowedTools` 로 미리 허용해 카드가 뜨지 않게 한다.
6. **도구 노출** — dodok 도구는 `createSdkMcpServer` 로 러너 안에(이름 `mcp__dodok__message` 등). components v1 스키마는 shared Zod 를 도구 입력 스키마로 그대로 쓸 수 있다(SDK 가 zod 로 JSON Schema 를 만든다 — `tool()` 은 zod raw shape 를 받는다). 첨부는 러너가 로컬 파일을 읽어 서버 첨부 HTTP 로 올리고 `artifact://` id 를 싣는다(OpenClaw 플러그인 `outbound-media` 와 같은 자리).
7. **격리 기본값** — `options.env` 허용 목록(5.4), `CLAUDE_CONFIG_DIR` 은 러너 전용 디렉터리(러너 프로세스 env 에도, 5.2), `settingSources` 는 스펙이 고른다(`[]` 면 사용자·프로젝트 설정과 `CLAUDE.md` 를 안 읽는다 — 작업 디렉터리의 `CLAUDE.md` 를 쓰려면 `project` 를 넣는다), `cwd` 는 에이전트별 작업 디렉터리, `pathToClaudeCodeExecutable` 은 비워 번들 CLI 를 쓰되 SDK 버전을 정확 핀한다(OpenClaw 3종 핀과 같은 이유 — 번들 CLI 판본이 SDK 판본에 묶인다).
8. **동시 실행 상한** — 러너 전역 상한(동시 CLI 프로세스 수)을 둔다. 유휴 172 MiB 만으로도 10개면 1.7 GiB 다. 넘치면 서버 쪽 큐(지금 `RUN_QUEUED`)로 되돌린다.
9. **라이선스** — SDK 는 오픈소스가 아니다(2절). 러너 배포물에 SDK 를 품어 재배포할지, 사용자 머신에서 설치하게 할지는 법무 판단을 받는다.

## 7. 다시 재는 법

스크래치 디렉터리에서(저장소 의존성에 넣지 않는다, 글로벌 설치 금지):

1. 설치·봉인
   ```bash
   SP=<스크래치>; mkdir -p $SP/sdk $SP/fakebin $SP/out $SP/home $SP/cfg $SP/ws; cd $SP/sdk
   npm init -y && npm i --ignore-scripts @anthropic-ai/claude-agent-sdk@<판> zod@4
   npm view @anthropic-ai/claude-agent-sdk version license          # 적는다. package.json 의 claudeCodeVersion 도
   B=node_modules/@anthropic-ai/claude-agent-sdk-$(node -p 'process.platform+"-"+process.arch')/claude
   mv $B $B.DISABLED && chmod a-x $B.DISABLED                         # 번들 CLI 를 SDK 가 못 찾게 봉인
   ```
2. 가짜 CLI(`$SP/fakebin/claude`, 셸뱅 Node, `chmod +x`). 해야 할 것 — argv·env 키 이름·stdin 레코드를 파일에 적는다. `initialize` 에 `control_response { subtype: "success", request_id, response: { commands: [], models: [], … } }`. `user` 레코드를 받으면 `system/init`(`session_id` 는 `--session-id`/`--resume` 값) → 지시어별로 `stream_event`·`assistant`·`user(tool_result)`·`result` 를 낸다. 권한은 `control_request { subtype: "can_use_tool", tool_name, input, tool_use_id, permission_suggestions }` 를 내고 `control_response` 를 기다린다, SDK 도구는 `control_request { subtype: "mcp_message", server_name, message: <JSON-RPC initialize·tools/list·tools/call> }`, 훅은 `initialize.hooks.UserPromptSubmit[].hookCallbackIds` 로 `control_request { subtype: "hook_callback", callback_id, input }`. `interrupt` 가 오면 성공으로 답하고, 대기 중 요청마다 `control_cancel_request { request_id }` 를 낸 뒤 `result error_during_execution`. `FAKE_STUBBORN` 이면 stdin EOF·SIGTERM 을 무시한다.
3. 드라이버 — `query({ prompt, options: { pathToClaudeCodeExecutable: $SP/fakebin/claude, cwd: $SP/ws, settingSources: [], env: { PATH, HOME: $SP/home, CLAUDE_CONFIG_DIR: $SP/cfg }, … } })` 를 `HOME=$SP/home CLAUDE_CONFIG_DIR=$SP/cfg node <드라이버>` 로. 판정은 소비 쪽 메시지 순서·시각과 가짜 CLI 기록(argv·`initialize` 내용·`control_response` 도착 시각). 동시성은 `query()` N개를 `Promise.all` 로, SDK RSS 는 `process.memoryUsage().rss` 를 50ms 마다.
4. 정적 조회 — 번들 CLI 문자열은 `LC_ALL=C strings -n 200 $B.DISABLED > cli-strings.txt` 로 한 번 뽑고 Node 로 찾는다(225 MB 바이너리에 `grep -aoE '.{700}…'` 는 몇 분 걸린다). 찾을 이름: `subtype:"can_use_tool"`(권한 경로와 경주·타이머 유무), `function hee`(대화상자 기한), `-credentials"`(키체인 이름), `"projects"`(전사 위치). SDK 쪽은 `sdk.mjs` 의 `processControlRequest`·`waitForFirstResult`·`"SIGKILL"`·`process.env.CLAUDE_CONFIG_DIR`.
5. 번들 CLI 유휴(모델 호출 없음 — 조율자 승인 아래서만): `chmod +x` 로 잠깐 풀고 `env -i PATH=… HOME=<스크래치> CLAUDE_CONFIG_DIR=<스크래치> CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1` 로 3절 argv 를 붙여 띄우고, stdin 에 `initialize` 한 줄만 쓴다(사용자 메시지는 **절대** 보내지 않는다). `ps -o rss= -p <pid>`·`ps -M -p <pid> | wc -l`·`lsof -nP -a -p <pid> -i` 를 3초 간격 세 번 → 그 PID 에 SIGTERM → `chmod a-x`.
6. 끝나면 `rm -rf $SP`(가짜 CLI·설치본·`cfg`·`cfg-real`).

## 8. 확인 못 한 것 — 모델 런이 있어야 아는 것

1. **실제 부분 메시지 간격·크기**와 `thinking` 블록이 스트림에 섞이는 모양(적응형 사고가 기본인 모델에서).
2. **실제 도구 호출 모양** — 블록마다 따로 오는 `assistant`, 병렬 도구 호출 때 `tool_use` 블록 여럿·`tool_result` 순서, `tool_progress` 주기.
3. **interrupt 뒤 실제 `result`** 의 `subtype`·`errors`·`aborted: true` 메시지, 그리고 전사에 남는 중단 표식이 다음 `resume` 턴에 어떻게 보이는가.
4. **`snapshot` 동작** — 이 계정에서 기록이 켜져 있는지, 기본값이면 `resume` 뒤 바뀐 `append` 가 정말 무시되는지, `snapshot: false` 면 반영되는지(ADR 0003 을 다시 재는 셈).
5. **`UserPromptSubmit` 의 `additionalContext` 가 모델에게 어떻게 보이고 전사에 남는가**, `[dodok context]` 헤더를 사용자 메시지에 넣는 것과 무엇이 다른가.
6. **`allowedTools`·`permissionMode` 조합의 실제 판단** — 어떤 도구가 콜백 없이 돌고 무엇이 묻는가(판단은 CLI 몫이라 가짜 CLI 는 흉내만 냈다). `Bash` 규칙(`Bash(git status)` 류)의 일치.
7. **dodok 도구 호출** — 모델이 `mcp__dodok__*` 를 components 스키마대로 부르는가, 그 호출에도 `canUseTool` 이 오는가(`allowedTools` 로 미리 허용했을 때와 안 했을 때).
8. **`result` 의 `usage`·`total_cost_usd`·`modelUsage`** 가 믿을 만한가(ADR 0005 는 OpenClaw claude-cli 층의 값이 틀렸다고 했다 — SDK 직접 경로는 다를 수 있다).
9. **런 중 CLI 메모리와 기동 시간**(`query()` 부터 `system/init` 까지, 첫 델타까지).
10. **인증** — 러너 전용 `CLAUDE_CONFIG_DIR` 에서의 로그인 방법, `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` 로 기본 로그인을 쓰는 것이 실제로 되는가(모델 런 전에 인증만으로도 잴 수 있다 — 사용자 자격 증명을 건드리므로 사람 승인 사항).
