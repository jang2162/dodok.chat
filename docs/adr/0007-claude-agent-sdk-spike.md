# ADR 0007 — Claude Agent SDK 스파이크 (Phase 4 로컬 러너 어댑터 설계의 근거)

- 상태: 완료 (실측 — 가짜 CLI, 번들 CLI + 로컬 가짜 Messages API, **모델 런 5회**) — 로컬 러너 스펙이 「설계에 주는 제약과 추천」 절을 입력으로 받는다
- 날짜: 2026-09-27
- 대상: `docs/plan.md` 「5.7 에이전트 어댑터 인터페이스 (후속 연동 대비)」 절·기술 표의 「에이전트 이벤트 표준」, `packages/openclaw-adapter/src/adapter-types.ts` 의 `AgentAdapter`·`AdapterEvent`
- 산출 코드: 없음 — 가짜 CLI·가짜 Messages API·드라이버·스크래치 설치본·스파이크 세션 전사는 버렸다
- 근거 원장(git 제외): `.superpowers/sdd/2026-09-27-claude-runner-spike/` 의 `p4c-spike-report.md`(모델 없이 잰 것)·`p4c-spike2-report.md`(모델 런 1~3)·`p4c-spike3-report.md`(채널 규칙 전달 경로·`alwaysLoad`, 모델 런 4·5)

## 1. 결론

| # | 질문 | 답 |
| --- | --- | --- |
| 1 | 스트리밍 모양, 최종 답 가르기 | `includePartialMessages: true` 면 Anthropic 스트리밍 이벤트가 **`stream_event` 로 그대로** 온다. 실제 모델에서 텍스트 델타는 약 11자씩, 간격 중앙값 Sonnet 5 46ms·Haiku 4.5 26ms. **`thinking` 블록은 글자가 비어 온다**(`thinking_delta` 의 텍스트가 빈 문자열, 끝에 `signature_delta` 하나) — 대신 CLI 가 `system/thinking_tokens`(추정 토큰 수)를 약 1초마다 낸다. 완성본은 블록마다 `assistant`(같은 `message.id`), 턴 끝은 `result`. **최종 답은 `result.result`** |
| 2 | 권한 콜백 | `canUseTool(toolName, input, { signal, toolUseID, requestId, displayName, description, suggestions, blockedPath, mcpServer, decisionReason, … })`. **SDK·CLI 어느 쪽에도 기한이 없다**. 실제 모델 런에서 콜백이 온 것은 미리 허용되지 않은 **쓰기** 도구뿐이다 — 미리 허용한 dodok 도구, 규칙이 맞은 `git status`, 규칙이 없는 읽기 전용 명령(`git log`·`sleep`)에는 오지 않았다. 콜백은 **입력 검증보다 먼저** 온다 |
| 3 | 세션 | 세션 id 는 러너가 정한다 — 첫 런 `sessionId: <UUID>`, 다음 런 `resume: <id>`. 전사는 `CLAUDE_CONFIG_DIR/projects/<cwd 경로>/<id>.jsonl`. `query()` 하나가 CLI 프로세스 하나 |
| 4 | 중지 | `q.interrupt()` 는 프로세스를 살린 채 그 턴만 끝낸다 — `result` 는 `error_during_execution`, `errors` 는 진단 문자열 하나(`[ede_diagnostic] … stop_reason=…`), 전사에는 사용자 메시지 `[Request interrupted by user]`(도구 중이면 `… for tool use]` 와 거절된 `tool_result`)가 남아 다음 턴·`resume` 에서 모델이 그것을 본다. 중지는 **백그라운드 셸도 죽인다** |
| 5 | 채널 프롬프트·문맥 | `append` 는 프로세스 시작 때 한 번 가고, **기본값(`snapshot` 생략)은 첫 요청의 시스템 프롬프트를 전사에 기록해 `resume` 에서도 그것을 보낸다 — 바뀐 `append` 는 요청에 실리지 않는다**(실측, 이 계정·가짜 키 둘 다). **`snapshot: false` 면 바뀐 `append` 가 요청에 실린다.** 채널 규칙은 **출처·권한을 밝히는 틀**(4.5 「채널 규칙 틀」)에 담으면 Sonnet 5 가 새 세션에서 따른다 — 틀을 갖춘 `append`(가)와 `UserPromptSubmit` 훅 `additionalContext`(나) 둘 다 네 턴 모두 따랐고, 훅으로 바꾼 규칙은 다음 턴부터 따랐다. **맨 문장만 넣으면 「주입된 지시」로 보고 따르지 않는다**(5.5). 추천은 (가) — 6의 2 |
| 6 | 채널로 쓰는 도구 | 된다 — `createSdkMcpServer` 도구가 러너 프로세스 안에서 돈다. 모델이 components 모양 카드를 **스키마대로** 보냈다. **SDK MCP 도구는 기본으로 지연 로드(ToolSearch 뒤)된다** — 스키마를 못 본 첫 호출은 틀린다. **`alwaysLoad: true` 를 주면 지연 목록에서 빠지고, Sonnet 5 가 ToolSearch 없이 첫 호출부터 스키마대로 불렀다**(5.7) |
| 7 | 자원 | 런 중 CLI RSS 약 **190 MiB 로 시작해 290~325 MiB**(모델 런, 전사가 쌓인 뒤). `query()` → `system/init` 약 0.55초, 첫 API 응답 시작 1.3~2.4초, 첫 텍스트는 사고 길이에 달려 5.8~17초 |
| 8 | usage·비용 | 토큰 수는 믿을 수 있다 — 스트림의 `message_delta.usage` 와 `result.usage`(턴 안 API 호출의 합)가 맞고, `total_cost_usd` 는 **토큰 × 공시 단가와 정확히 같다**. 단 `total_cost_usd`·`modelUsage` 는 **세션 누적이고 `resume` 하면 앞 프로세스 몫까지 이어진다** — 런 비용은 차이로 잰다. 구독 로그인에서는 청구액이 아니라 공시 단가 환산값이다 |
| 9 | 인증 | 러너 전용 `CLAUDE_CONFIG_DIR` 로그인이 SDK 에서 그대로 먹는다(`accountInfo`·`system/init` — 모델 호출 없이도 확인된다). 그 계정의 **claude.ai 커넥터와 이메일이 에이전트 문맥에 따라 들어온다**(5.6) |
| 10 | 모델 런이 있어야 아는 것 중 남은 것 | 「확인 못 한 것」 절 |

## 2. 환경

| 항목 | 값 |
| --- | --- |
| SDK | `@anthropic-ai/claude-agent-sdk@0.3.283`(npm `latest`·`next` 같은 값), `claudeCodeVersion: "2.1.283"`. 라이선스 `SEE LICENSE IN README.md` — 패키지 `LICENSE.md` 는 「© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance.」 **오픈소스 라이선스가 아니다** |
| 피어 의존성 | `@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0` — 루트 엔트리는 피어를 번들에 품고, `/core` 엔트리는 설치본을 쓴다(한 프로세스에서 둘을 섞지 않는다) |
| 번들 CLI | 플랫폼별 선택 의존성 `@anthropic-ai/claude-agent-sdk-<os>-<arch>` 의 네이티브 바이너리 `claude`(darwin-arm64 225 MB). `pathToClaudeCodeExecutable` 을 안 주면 SDK 가 이것을 찾는다 |
| Node | 24.21.0 (저장소 `mise.toml` 핀) |
| 가짜 CLI | Node 스크립트. `pathToClaudeCodeExecutable` 에 두면 SDK 가 셸뱅 실행 파일을 그대로 spawn 한다. 모델 없이 SDK 쪽 제어 흐름(권한·SDK MCP·훅·interrupt·종료)을 잰 도구 — 「다시 재는 법」 2 |
| 가짜 Messages API | 로컬 HTTP 서버. **번들 CLI** 에 `ANTHROPIC_BASE_URL`·가짜 `ANTHROPIC_API_KEY`·스크래치 `CLAUDE_CONFIG_DIR` 을 주면 CLI 가 실제로 보내는 요청 본문(시스템 프롬프트·메시지 배열·도구 목록·사고 설정)을 모델 없이 본다. 키워드로 텍스트·`tool_use` 를 돌려줘 CLI 의 권한 판단·도구 실행·interrupt 까지 돈다 — 「다시 재는 법」 6 |
| 모델 런 | 5회(`query()` 하나 = 1회), 러너 전용 로그인(Claude Max, firstParty). 비용은 CLI 가 보고한 `total_cost_usd` 의 런 전후 차이 — 런 1 Sonnet 5 새 세션 턴 3개 **$0.0886**(보조 Haiku 제목 호출 $0.0010 포함) · 런 2 Haiku 4.5 `resume` 턴 4개(도구 5개·interrupt) **$0.0896** · 런 3 Sonnet 5 `resume` 턴 1개 **$0.2088**(시스템 프롬프트가 바뀌고 모델이 바뀌어 캐시 50,901 토큰을 새로 씀) · 런 4 Sonnet 5 새 세션 턴 4개(틀 `append`, 카드 도구 1회) **$0.1514** · 런 5 Sonnet 5 새 세션 턴 4개(훅 문맥, 카드 도구 1회) **$0.1728** · 합 **$0.7111** |
| 격리 | `options.env` 허용 목록(`PATH`·`HOME`·`USER`·`LOGNAME`·`SHELL=/bin/bash`·`LANG`·`TMPDIR`·`CLAUDE_CONFIG_DIR`·`DISABLE_AUTOUPDATER`), 러너 프로세스 `process.env.CLAUDE_CONFIG_DIR` 도 같은 값, `settingSources: []`, `cwd` 는 스크래치의 빈 git 저장소. 모델 런에서 `HOME` 은 실제 홈이다(키체인 로그인을 찾게) |

## 3. 실측 — CLI 를 부르는 모양

- argv(문자열 프롬프트도 같다): `--output-format stream-json --verbose --input-format stream-json --setting-sources= --permission-mode default`. 옵션이 붙이는 것 — `allowedTools` → `--allowedTools <이름>`, `canUseTool` → `--permission-prompt-tool stdio`, `includePartialMessages` → `--include-partial-messages`, `sessionId` → `--session-id=<id>`, `resume` → `--resume=<id>`, `forkSession` → `--fork-session`, `resumeSessionAt` → `--resume-session-at=<uuid>`, `persistSession: false` → `--no-session-persistence`, `strictMcpConfig` → `--strict-mcp-config`.
- env 는 `options.env` 에 SDK 가 `CLAUDE_AGENT_SDK_VERSION`·`CLAUDE_CODE_ENTRYPOINT` 를 더한 것.
- stdin 첫 줄은 `control_request { subtype: "initialize", … }` — `appendSystemPrompt`·`systemPrompt`·`systemPromptSnapshot`·`hooks`(콜백 id)·`sdkMcpServers`·`sdkMcpServerManifests`. 그다음 `user` 레코드가 프롬프트다.
- ⚠ **`systemPrompt` 를 안 주면 SDK 는 `systemPrompt: [""]` 를 보낸다** — Claude Code 기본 프롬프트가 아니라 빈 사용자 정의 프롬프트다. Claude Code 의 도구 안내·작업 방식을 원하면 `{ type: "preset", preset: "claude_code" }` 를 명시한다.
- 문자열 프롬프트도 stdin 을 첫 `result` 까지 열어 두므로 `interrupt()`·`canUseTool`·SDK MCP 가 모두 된다. 스트리밍 입력(`AsyncIterable<SDKUserMessage>`)이면 프로세스 하나로 여러 턴을 잇는다.
- CLI 가 API 에 보내는 요청(가짜 Messages API 로 본 것): 시스템은 블록 셋 — 과금 헤더 줄, `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`, 본문(Claude Code 프롬프트 약 27 KB, **`append` 는 이 본문의 맨 끝에 그대로 붙는다**). 모델별 사고 설정 — Sonnet 5 는 `thinking: { type: "adaptive" }`·`output_config.effort: "high"`·`max_tokens` 64000, Haiku 4.5 는 `thinking: { type: "enabled", budget_tokens: 31999 }`·`max_tokens` 32000. 환경·git 상태·날짜·기술 목록·에이전트 목록·훅 문맥은 `<system-reminder>` 블록으로 메시지 배열에 들어간다. 프롬프트 캐시는 1시간 TTL 로 쓴다(`ephemeral_1h_input_tokens`).
- 전사에 남는 것(`CLAUDE_CONFIG_DIR/projects/<cwd 경로>/<세션>.jsonl`): `user`·`assistant` 외에 `attachment` 레코드 — `hook_additional_context`·`prompt_snapshot`·`session_context`(계정 이메일·git 상태)·`credential_org`·`deferred_tools_delta`·`mcp_instructions_delta` 등 — 와 `cost-state`·`ai-title`·`queue-operation`. 그 밖에 `CLAUDE_CONFIG_DIR/session-env/<세션>/`, `backups/.claude.json.backup.*`, 백그라운드 셸 출력은 `TMPDIR` 과 무관하게 `/private/tmp/claude-<uid>/<cwd 경로>/<세션>/` 에 쓴다.

## 4. 실측 — 질문별

### 4.1 스트리밍 (질문 1)

실제 모델(Sonnet 5, 사고 기본값)의 턴 하나:

```
system init                                     t=0.56s  (query() 부터)
system status requesting
stream_event message_start  usage{input, cache_creation, cache_read}   t=2.36s
stream_event content_block_start {type:"thinking", thinking:"", signature:""}
system thinking_tokens {estimated_tokens:50}    … 약 1.1초마다, 150·250·…·1350
stream_event content_block_delta thinking_delta ""   ×13, 끝에 signature_delta ×1
stream_event content_block_stop                 t=17.09s (사고 14.7초)
assistant  content=[thinking(빈 글, signature 5,868자)]  message.id=msg_…
stream_event content_block_start {type:"text"}
stream_event content_block_delta text_delta     ×82, 약 11자씩, 간격 중앙값 46ms·p90 63ms
stream_event content_block_stop · message_delta {stop_reason:"end_turn", usage} · message_stop
assistant  content=[text]  같은 message.id
result     success  result="…"  usage  total_cost_usd  modelUsage
```

- **`thinking` 은 글자가 오지 않는다** — Sonnet 5·Haiku 4.5 둘 다 빈 `thinking_delta` 와 서명만 왔다. 사고가 길면 첫 텍스트까지 한참 조용하다(위 턴 14.7초, 다른 턴 5.5초) — 「생각 중」 표시는 `system/thinking_tokens` 로 만든다.
- 텍스트 델타 간격 중앙값: Sonnet 5 45~46ms, Haiku 4.5 26ms. 크기 중앙값 11~14자, 최대 35자.
- 완성본 `assistant` 는 **블록마다 한 건, 같은 `message.id`**(사고·텍스트·도구 블록 각각).
- 턴마다 `result` 가 정확히 한 건이다. 실패는 `error_during_execution`·`error_max_turns`·`error_max_budget_usd`·`error_max_structured_output_retries` 와 `errors[]`.
- 흐름에 섞이는 것: `system/thinking_tokens`, `system/status`, `rate_limit_event`(구독의 5시간 창 사용률), `system/task_started`·`task_notification`·`task_updated`·`background_tasks_changed`(셸 작업), `tool_progress`(이 스파이크의 모델 런에서는 안 나왔다), `system/permission_denied`, `system/session_state_changed`, `tool_use_summary`.
- 턴을 보내면 그 턴마다 `system/init` 이 다시 온다(같은 프로세스).

### 4.2 권한 콜백 (질문 2)

| 경우 | 결과 |
| --- | --- |
| 330초 기다렸다 허용(`updatedInput` 으로 명령을 바꿈, 가짜 CLI) | 바뀐 입력으로 도구가 돌았다. 반복자는 그동안 조용히 기다렸다 |
| 거절 `{ behavior: "deny", message }` (가짜 CLI) | `tool_result` 가 `is_error: true`, 내용은 그 `message` 그대로 — 모델에게 거절 사유가 간다 |
| 대기 중 `interrupt()` (가짜 CLI) | CLI 가 `control_cancel_request` → SDK 가 콜백 `signal` 을 끊음. `tool_result` 는 `Tool permission request aborted`, 턴은 `error_during_execution` |
| 대기 중 `abort()`·`close()` (가짜 CLI) | 콜백 `signal` 이 끊기고, abort 는 반복자가 `AbortError`, close 는 조용히 끝난다 |

실제 모델 런(Haiku 4.5, `permissionMode: "default"`, `allowedTools: ["mcp__dodok__send_card", "Bash(git status)"]`) — 한 요청에 도구 다섯을 시켰을 때:

| 호출 | `canUseTool` |
| --- | --- |
| `mcp__dodok__send_card` (미리 허용) | 안 옴 |
| `mcp__dodok__post_card` (같은 스키마, 미리 허용 안 함) | 옴 — `mcpServer: { name: "dodok", source: "sdk" }`, `displayName: "Post Card"`, `suggestions: [{ type: "addRules", destination: "localSettings", rules: [{ toolName: "mcp__dodok__post_card" }] }]`. 두 번 부르면 두 번 온다 |
| `Bash` `git status` (규칙 `Bash(git status)`) | 안 옴 |
| `Bash` `git log --oneline -1` (규칙 없음) | **안 옴** — CLI 가 읽기 전용으로 분류해 묻지 않는다. `sleep 45 && echo done` 도 같다 |
| `Bash` `touch spike-note.txt` (규칙 없음, 쓰기) | 옴 — `description`(모델이 쓴 설명), `blockedPath`, `suggestions` 셋(`addRules`→`localSettings`, `addDirectories`→`session`, `setMode: "acceptEdits"`→`session`) |

- 콜백 인자 키: `signal`·`suggestions`·`blockedPath`·`mcpServer`·`decisionReason`·`title`·`displayName`·`description`·`defaultToNo`·`suppressAlwaysAllowRule`·`toolUseID`·`agentID`·`requestId`. 이 런에서 `title` 은 비어 있었다.
- **콜백은 입력 검증보다 먼저 온다** — 스키마에 안 맞는 `post_card` 호출에도 콜백이 왔고, 허용하자 그 뒤에 검증 오류(`MCP error -32602`)가 났다.
- `allowedTools` 에 맨 이름을 넣으면 SDK 가 경고한다(`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` — 「그 도구는 콜백 없이 허용된다, 호출마다 막으려면 PreToolUse 훅」).
- **기한** — SDK: 「permission prompts have no park deadline」. CLI(2.1.283, 정적 조회): 권한 요청 경로에 타이머가 없다. 5분 기본값(`dialogExpiry`·`CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS`)은 `request_user_dialog`(AskUserQuestion 류) 경로다.
- **`null` 을 돌려주지 않는다** — `null` 은 「응답을 따로 보냈다」는 뜻이라 도구가 영원히 막힌다(타입 문서).
- **「항상 허용」** — 제안의 `destination` 은 실제로 `localSettings` 로 왔다. 그대로 돌려주면 작업 디렉터리의 `.claude/settings.local.json` 에 규칙이 써진다 — 러너는 `destination: "session"` 으로 바꿔 돌려준다.
- 신뢰 판단은 이름이 아니라 `mcpServer.source` 로 한다 — 러너가 등록한 도구는 `"sdk"`.

### 4.3 세션 (질문 3)

- `sessionId`(UUID)를 주면 CLI 가 그 id 로 시작하고, `resume` 은 전사를 읽어 잇는다. `sessionId` 는 `resume` 과 함께 못 쓴다(`forkSession` 일 때만).
- 스트리밍 입력이면 같은 CLI 프로세스가 여러 턴을 처리한다.
- 리셋 — 새 UUID 로 첫 런을 시작하면 새 세션이다. 옛 전사를 지우려면 `deleteSession(id)`.
- 한 프로세스 여러 세션 — `query()` 마다 CLI 프로세스가 따로다(가짜 CLI 로 동시 1·10·30개 병렬).
- **같은 세션 id 로 두 `query()` 를 겹쳐 돌리지 않는다** — 같은 전사 파일을 두 프로세스가 쓴다. 직렬화는 러너(와 서버 오케스트레이터의 세션 큐)가 한다.
- **`resume` 직후 프롬프트와 무관한 `result` 가 먼저 올 수 있다** — 앞 프로세스에서 끝나지 않은 백그라운드 셸이 있으면 CLI 가 `system/task_notification`(「Background shell command didn't finish before the previous session ended」)과 `num_turns: 0`·빈 `result` 의 `result` 한 건을 낸 뒤 프롬프트 턴을 처리했다. 첫 `result` 를 런의 끝으로 읽으면 안 된다.
- `SDKUserMessage.shouldQuery: false` — 모델을 부르지 않고 `num_turns: 0`·빈 `result` 의 `result` 를 한 건 낸다. 그 글은 다음 턴의 사용자 메시지에 **별도 텍스트 블록으로 합쳐져** 간다(모델도 「같은 턴으로 합쳐 왔다」고 답했다). 훅은 불리지 않는다.

### 4.4 중지 (질문 4)

| 방법 | 스트리밍·사고 중 | 도구 실행 중 | 뒤에 이어 쓰기 |
| --- | --- | --- | --- |
| `q.interrupt()` | 제어 응답 `{ still_queued: [] }` 즉시. 전사에 사용자 메시지 `[Request interrupted by user]`, `result error_during_execution`·`errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"]`·usage 0 (실제 모델, 사고 중) | 도구 `tool_result` 가 `is_error: true`·「The user doesn't want to proceed with this tool use. The tool use was rejected … STOP what you are doing and wait for the user to tell you how to proceed.」, 뒤에 `[Request interrupted by user for tool use]`, `errors: ["… stop_reason=tool_use"]` (번들 CLI + 가짜 API) | 같은 프로세스에 다음 턴을 보낼 수 있다. 모델은 다음 요청에서 위 두 표식을 그대로 본다 |
| `AbortController.abort()` | stdin 닫힘 → 반복자 `AbortError` | stdin 닫힘 → **2초 뒤 SIGTERM** → 반복자 `Claude Code process aborted by user` | 프로세스가 끝난다 — 다음 런은 `resume` 으로 새 프로세스 |
| `q.close()` | abort 와 같은 종료 순서, 반복자는 조용히 끝남 | 같음 | 같음 |

- 종료 단계(SDK `ProcessTransport`): stdin EOF → 2초 → SIGTERM → 5초 → SIGKILL.
- **interrupt 는 그 프로세스의 백그라운드 셸도 죽인다**(`system/task_updated { status: "killed" }`). 모델은 긴 명령을 스스로 `run_in_background: true` 로 돌리기도 한다(5.8).
- interrupt 로 끝난 턴 뒤 스트리밍 입력을 닫자 **CLI 가 exit code 1 로 끝났고 반복자가 `Claude Code process exited with code 1` 을 던졌다**(마지막 `result` 를 받은 뒤). 러너는 마지막 `result` 뒤의 비정상 종료를 런 실패로 읽지 않는다.
- 이 스파이크에서 `aborted: true` 가 붙은 `assistant` 는 보지 못했다 — 사고 중 interrupt 는 사고 블록 완성본을 내지 않고 끝났다.

### 4.5 채널 프롬프트·문맥 (질문 5)

**시스템 프롬프트 기록(`snapshot`)** — 같은 세션을 `append` 만 바꿔 이어 가며 CLI 가 보내는 시스템 프롬프트를 봤다(가짜 Messages API) — 그리고 같은 순서를 이 계정의 모델 런으로 되풀이했다.

| 런 | `append` | `snapshot` | 요청의 시스템 프롬프트에 실린 규칙 | 전사 |
| --- | --- | --- | --- | --- |
| 새 세션 | ALPHA | 생략 | ALPHA | `attachment.type: "prompt_snapshot"` 기록(시스템 프롬프트 16조각 — `append` 는 마지막 조각 그대로 — 도구 목록, `cliPrefix`, `systemTurns: true` 등) |
| `resume` | BRAVO | 생략 | **ALPHA** — 바뀐 `append` 는 요청에 실리지 않는다 | 새 `prompt_snapshot` 없음 |
| `resume` | CHARLIE | `false` | **CHARLIE** | — |

- 기록은 이 계정(Claude Max)에서도, 가짜 API 키·`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 에서도 켜져 있었다. **기본값이면 바뀐 채널 프롬프트가 기존 세션에 안 들어간다** — ADR 0003 「질문 1 — 채널 프롬프트가 기존 세션에」 절의 claude-cli 와 같은 부류다.
- `snapshot: false` 의 대가: 시스템 프롬프트가 바뀐 런은 프롬프트 캐시를 처음부터 쓴다(런 3 — 캐시 읽기 0, 쓰기 50,901 토큰. 모델도 바뀌어 두 원인이 겹친다).

**채널 규칙 전달 경로 셋** — 같은 채널 규칙을 세 자리에 넣어 CLI 가 보내는 요청을 봤고(번들 CLI + 가짜 Messages API), (가)·(나)는 각각 새 세션의 모델 런(Sonnet 5, 턴 4개 — 평범한 질문·긴 답을 부르는 질문·카드 도구·「규칙을 어디서 받았다고 보는가」)으로 따르는지 봤다.

| 경로 | 요청 안의 자리 | 규칙이 바뀌면 | 모델 런 |
| --- | --- | --- | --- |
| (가) 틀을 갖춘 `append`(`snapshot: false`) | 시스템 본문의 맨 끝 | 다음 프로세스(`resume`)의 시스템 프롬프트가 새 규칙으로 **바뀐다** — 옛 규칙은 요청에 남지 않는다. 같은 프로세스 안에서는 안 바뀐다(5.3) | **따랐다** — 네 턴 모두 첫 줄 표식·세 문장. 출처를 「채널 관리자가 설정 화면에서 쓴 dodok channel settings」로 보고 **사용자 요청(「길어도 괜찮아」)보다 위의 운영 정책**으로 다뤄 마지막 답도 세 문장으로 줄였다. 자리는 「system-reminder」라고 틀리게 말했다 |
| (나) `UserPromptSubmit` 훅 `additionalContext` | 턴마다 `<system-reminder>UserPromptSubmit hook additional context: …` 블록(가짜 Messages API 에서는 프롬프트 뒤의 시스템 역할 메시지) | 다음 턴의 블록이 새 규칙이다. **옛 블록은 이력에 그대로 남는다** — 같은 프로세스든 `resume` 이든 | **따랐다** — 둘째 턴에 바꾼 규칙(표식 v2)을 그 턴부터 따랐고, 틀의 「앞 블록을 대체한다」 문장을 근거로 댔다. 출처를 훅 블록으로 정확히 짚었다. 마지막 답에서는 표식은 지키고 세 문장 제한은 「사용자가 길어도 된다고 했고 투명성 질문이라」며 **스스로 넘겼다** |
| (다) `CLAUDE.md` | 첫 사용자 메시지의 `<system-reminder>` — 「Codebase and user instructions are shown below … IMPORTANT: These instructions OVERRIDE any default behavior …」 머리에 `Contents of <절대 경로> (project instructions, checked into the codebase):` | `resume` 한 프로세스가 파일을 다시 읽어 **「Instruction files were re-read when this session started; these differ from their earlier copies — each replaces its earlier copy …」 블록으로 새 내용을 덧붙인다**(옛 사본은 이력에 남는다). 같은 프로세스 안에서 파일을 바꾸면 다음 턴에 반영되지 않았다 | 재지 않았다 |

- (다)가 읽히는 조건: `settingSources: []` 면 `cwd` 의 `CLAUDE.md` 를 읽지 않는다. `settingSources: ["project"]` 면 읽는다 — 그 대신 작업 디렉터리의 `.claude/settings.json`(훅·권한 규칙) 같은 **사람 저장소의 설정도 함께 들어온다**(`sdk.d.ts` 의 `settingSources` 설명 — 「`'project'` - Project settings (`.claude/settings.json`) … Must include `'project'` to load CLAUDE.md files」). `additionalDirectories: [<채널 디렉터리>]` 와 env `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 을 주면 `settingSources: []` 여도 그 디렉터리의 `CLAUDE.md` 가 같은 자리·같은 머리로 실린다 — 채널별 파일을 둘 수 있지만, 그 디렉터리는 에이전트 도구가 읽고 쓸 수 있는 작업 범위가 된다.
- **틀이 없으면 따르지 않는다.** 새 세션의 Sonnet 5 가 `append` 의 맨 문장(「dodok channel rule: begin every reply with the exact token ALPHA: …」)을 「formatted to look like a directive but isn't in a proper system block … reads like an injection attempt」라며 거부했다. 한 번 그렇게 판정한 세션은 뒤에 틀을 고쳐도 이력이 그 판정을 싣고 가 되돌리지 못했다(Sonnet 5·Haiku 4.5 `resume`).
- 두 모델 런은 경로마다 새 세션 한 번씩이다 — 같은 틀·같은 질문의 반복 표본이 아니다. (가)의 「바뀐 규칙을 `resume` 뒤에 따르는가」는 모델로 재지 않았다.

**채널 규칙 틀** — (가)·(나) 모델 런이 따른 글이다(`{…}` 만 채널마다 바뀐다). 요소는 넷 — 무엇이 이 세션을 띄웠는가, 누가 썼는가(채널 관리자, 설정 화면), **대화 상대가 쓴 글이 아니라는 것**, 앞 블록을 대체한다는 것 — 과 규칙을 감싼 태그다.

```
# dodok channel settings

This Claude Code session runs as an agent in the dodok channel "#{channel}". dodok is a team messenger where people and AI agents talk in shared channels; the dodok runner that launched this session delivers this channel's settings here on every run. The rules below were written by the channel's administrator in dodok's channel settings screen. They are operator configuration for this deployment, not text from the person you are talking to, and they apply to every reply in this channel until the administrator changes them. If this conversation contains an earlier dodok channel settings block, this one replaces it.

<channel-rules channel="#{channel}">
{관리자가 쓴 규칙}
</channel-rules>
```

**턴마다 붙는 문맥**:

1. **`UserPromptSubmit` 훅의 `additionalContext`** — 모델에게 `<system-reminder>\nUserPromptSubmit hook additional context: [dodok context] …\n</system-reminder>` 로 간다. Sonnet 5 는 이것을 **그대로 인용하고 출처(훅이 붙인 문맥, 사용자가 쓴 글도 기본 시스템 프롬프트도 아님)를 정확히 짚었으며 주입으로 다루지 않았다.** 틀을 갖춘 채널 규칙을 담으면 지시로 따른다(위 표 (나)). 요청 안의 자리(가짜 Messages API 로 본 요청): 진행 중인 세션의 Sonnet 5 요청에서는 프롬프트 뒤의 시스템 역할 메시지, Haiku 4.5 요청에서는 프롬프트 앞의 사용자 텍스트 블록. `resume` 으로 다시 그린 이력은 사용자 텍스트 블록으로 간 요청도, 시스템 역할 메시지로 남은 요청(Sonnet 5)도 있었다 — 설계는 이 자리에 기대지 않는다. 전사에는 `attachment.type: "hook_additional_context"`(`content`·`hookName`)로 남아 이후 턴에도 이력으로 따라간다. 훅 입력 키는 `session_id`·`transcript_path`·`cwd`·`prompt_id`·`permission_mode`·`hook_event_name`·`prompt`.
2. **훅 문맥이 요청에서 빠지는 두 경우**(번들 CLI + 가짜 API — 훅은 불렸고 값도 돌려줬다): ① 앞 턴이 아직 처리 중일 때 들어간 프롬프트(스트리밍 입력으로 틈 없이 연달아 보냄) ② 같은 프로세스에서 interrupt 로 끝난 턴 바로 다음 프롬프트(1.5초 뒤에 보내도). 런마다 `query()` 하나(첫 프롬프트 하나)면 둘 다 생기지 않는다.
3. 사용자 메시지 본문 앞 `[dodok context]` 헤더(지금 OpenClaw 플러그인과 같은 모양) — 모델에게는 사용자가 쓴 글로 보인다(모델 런으로 재지 않았다).

### 4.6 채널로 쓰는 도구 (질문 6)

- `createSdkMcpServer({ name: "dodok", tools: [tool("send_card", …, zodShape, handler)] })` 를 `mcpServers: { dodok }` 로 주면 SDK 는 도구 목록을 `initialize` 에 미리 싣고, CLI 는 호출을 `control_request { subtype: "mcp_message" }` 로 보낸다. 핸들러는 러너 프로세스 안에서 `(args, extra)` 로 불리고 `extra._meta["claudecode/toolUseId"]`·`extra.signal` 을 받는다. 돌려준 `{ content: [...] }` 가 `tool_result` 로 모델에게 간다.
- **지연 로드** — 이 CLI 는 도구가 많으면 일부를 ToolSearch 뒤로 미룬다. 모델 런에서 `mcp__dodok__*` 도 미뤄졌다(`total_deferred_tools: 22`). 모델은 스키마를 못 본 채 처음 불러 `components` 를 JSON **문자열**로, 블록 키를 `elements` 로 보냈고 → SDK MCP 가 zod 로 검증해 `MCP error -32602: Input validation error … expected object, received string` 을 `is_error` 결과로 돌려줬다 → 모델이 `ToolSearch("select:mcp__dodok__send_card,mcp__dodok__post_card")` 로 스키마를 불러와 다시 불렀다 → 두 번째는 스키마대로였다(섹션 블록 + 버튼 둘, `id`·`label`·`style` 모두 맞음). **핸들러에는 검증을 통과한 입력만 왔다.**
- **`alwaysLoad`** — `tool(name, desc, shape, handler, { alwaysLoad: true })` 는 도구 `_meta["anthropic/alwaysLoad"]` 를 싣고, `createSdkMcpServer({ alwaysLoad: true })` 는 그 서버의 도구 전부에 같은 것을 싣는다(둘은 OR). CLI 는 이 표시가 있는 도구를 지연 목록에서 빼 `tools[]` 에 스키마째 넣는다(가짜 Messages API — `ENABLE_TOOL_SEARCH=true` 에서 없으면 `deferred tools` 목록에, 있으면 `tools[]` 에). 모델 런 두 번(Sonnet 5, 러너 로그인)에서 `system/init` 의 `tools` 에 `mcp__dodok__send_card` 가 있었고 전사의 `deferred_tools_delta.addedNames` 에는 없었다. 모델은 **ToolSearch 없이 첫 호출에** 섹션 블록과 버튼 둘(`id`·`label`·`style`)을 스키마대로 보냈다(2/2).
- 병렬 호출: 한 API 메시지에 `tool_use` 다섯이 왔고(완성본 `assistant` 는 블록마다 한 건), 결과는 끝난 순서대로 `user` 메시지 한 건씩 왔다. 카드 입력은 `input_json_delta` 47조각으로 약 650ms 동안 흘렀다.
- 러너는 OpenClaw `message` 툴 자리를 이렇게 채운다 — 도구 호출 → 러너가 `/runner` 로 서버에 `outbound.message`(런 id·세션 키 포함) → 서버 ack(메시지 id) → 핸들러가 `sent to dodok channel …` 를 돌려준다. 런마다 `query()` 가 따로라 핸들러 클로저가 런을 안다.
- 도구 호출에는 제한 시간이 있다 — 서버별 `timeout` 또는 `MCP_TOOL_TIMEOUT`(벽시계). 기본값은 확인 못 했다.

### 4.7 자원 (질문 7·9)

| 잰 것 | 값 | 재는 법 |
| --- | --- | --- |
| 런 중 CLI RSS | 시작 약 188 MiB(0.3초) → 1초 249 MiB → 최대 **324 MiB**(Sonnet 5, 턴 3개·35초) / 288 MiB(Sonnet 5 `resume` 턴 1개) | 「다시 재는 법」 7 — 드라이버가 250ms 마다 `ps` 로 자식 프로세스 RSS |
| 번들 CLI 유휴(인증 없음, `initialize` 만) | 약 172 MiB, 스레드 20, 외부 연결 0 | 「다시 재는 법」 5 |
| SDK(러너 Node) RSS | 세션당 약 0.25 MB(가짜 CLI 동시 30개 86 → 93 MB) | 「다시 재는 법」 3 |
| 기동 | `query()` → `system/init` 0.54~0.56초(`resume` 포함) → 첫 `message_start` 1.3~2.4초 → 첫 텍스트 델타 5.8초(사고 짧음)·17.1초(사고 14.7초) | 「다시 재는 법」 7 — 소비 쪽 메시지 시각 |

- 번들 CLI 는 `CLAUDE_CONFIG_DIR` 에 `.claude.json`·`backups/` 를 쓰고 `HOME` 에는 쓰지 않는다. 동시 세션 수의 상한은 SDK 가 아니라 CLI 메모리다.

### 4.8 usage·비용 (질문 8)

- `result.usage` = **그 턴의 API 호출 합**(도구 턴에서 호출 넷의 `cache_read_input_tokens` 합과 맞았다), 호출 하나인 턴은 스트림의 마지막 `message_delta.usage` 와 같다. `output_tokens_details.thinking_tokens` 가 따로 있다.
- `total_cost_usd` 는 **토큰 × 공시 단가와 소수점까지 같다**(`costBasis: "list"`) — 예: Sonnet 5 턴 하나 캐시 읽기 20,037 × $0.20 + 1시간 캐시 쓰기 9,693 × $4 + 출력 1,841 × $10 + 입력 2 × $2 (백만 토큰당) = $0.0611934 = CLI 보고값. Haiku 4.5 는 $1/$5.
- **`total_cost_usd`·`modelUsage` 는 세션 누적이다 — `resume` 한 프로세스도 전사의 `cost-state` 에서 앞 프로세스 몫을 이어받는다.** 런 비용은 런 전후 차이(또는 `result.usage` × 단가)로 잰다.
- `modelUsage` 에는 **`result.usage` 에 없는 보조 호출**이 들어간다 — 새 세션 첫 턴에 Haiku 4.5 로 세션 제목을 만드는 호출(입력 983·출력 13 토큰). **`title` 옵션을 주면 이 호출이 없다** — `title` 을 준 새 세션 모델 런 두 번의 `modelUsage` 에는 Sonnet 5 만 있었다.
- ADR 0005 「usage」 판정(OpenClaw claude-cli 층의 출력 토큰이 틀림)과 달리, 이 경로에서는 스트림·`result.usage`·`modelUsage` 의 출력 토큰이 서로 맞았다 — 토큰 수는 콘솔 없이 믿는다. 구독 로그인에서 달러 값은 청구액이 아니라 공시 단가 환산이다(구독의 한도는 `rate_limit_event` 의 창 사용률로 보인다).

### 4.9 인증 (질문 10)

- `CLAUDE_CONFIG_DIR=<러너 전용 디렉터리>` 에서 `/login` 해 둔 로그인이 SDK 에서 그대로 먹는다. **모델 호출 없이 확인된다** — 사용자 메시지 없이 `query()` 를 열고 `q.accountInfo()`(`subscriptionType`·`apiProvider`) 를 읽는다. `system/init` 의 `apiKeySource` 는 `"none"`(OAuth).
- 모델 런은 `HOME` 을 실제 홈으로 줬다 — 스크래치 `HOME` 에서 키체인 로그인이 보이는지는 재지 않았다.
- `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` 로 기본 로그인을 공유하는 길은 재지 않았다(러너 전용 로그인을 썼다).

## 5. 함정

### 5.1 기본 시스템 프롬프트는 비어 있다

3절 — `systemPrompt` 를 생략하면 `[""]`. 러너는 늘 preset 을 명시한다.

### 5.2 `CLAUDE_CONFIG_DIR` 은 두 곳에 두고, 로그인이 따라오지 않는다

- SDK 는 `options.env.CLAUDE_CONFIG_DIR` 을 CLI 에 넘기지만, **SDK 쪽 세션 헬퍼(`listSessions`·`getSessionMessages`·`deleteSession`)는 러너 프로세스의 `process.env.CLAUDE_CONFIG_DIR`** 을 읽는다(없으면 `~/.claude`). 둘을 같게 둔다.
- CLI 는 `CLAUDE_CONFIG_DIR` 이 있으면 macOS 키체인 항목 이름에 그 경로의 sha256 앞 8자를 붙인다(`Claude Code-credentials-<8자>`, 정적 조회) — 평소 `claude` 로그인이 안 보인다. 그 디렉터리에서 따로 `/login` 하면 된다(4.9).

### 5.3 기본값이면 바뀐 채널 프롬프트가 기존 세션에 안 들어간다

4.5 — `snapshot` 을 생략하면 첫 요청의 시스템 프롬프트가 전사에 기록되고 `resume` 도 그것을 보낸다. 턴 사이 설정 변경(`applyFlagSettings`·`updateSettings`)으로도 `append` 는 안 바뀐다(설정 키가 아니다). 바뀐 채널 프롬프트를 반영하려면 새 프로세스(`resume`)와 `snapshot: false` 가 함께 있어야 한다.

### 5.4 `options.env` 를 안 주면 러너의 env 전부가 CLI 로 간다

SDK 기본값은 `{ ...process.env }`. 러너가 가진 브리지 토큰 같은 것이 CLI(와 그 도구가 여는 셸)로 새지 않게 env 를 허용 목록으로 만든다.

### 5.5 틀 없이 넣은 규칙을 모델이 주입으로 읽는다

4.5 — Sonnet 5 가 새 세션에서 `append` 의 맨 문장 규칙을 「주입 시도」로 판정하고 따르지 않았다. 출처·권한을 밝히는 틀(4.5 「채널 규칙 틀」)에 담으면 같은 자리(`append`)에서도, 훅 문맥에서도 따랐다. 한 번 「주입」으로 판정한 세션은 이력이 그 판정을 싣고 가므로 뒤에 틀을 고쳐도 되돌리지 못한다 — 틀은 세션의 첫 런부터 있어야 한다.

### 5.6 계정이 따라 들어온다 — claude.ai 커넥터와 이메일

- `settingSources: []` 여도 **로그인한 계정의 claude.ai 커넥터**가 MCP 서버로 붙는다(`scope: "claudeai"` — 이 계정은 Claude Docs 연결됨, Gmail·Google Calendar·Google Drive 인증 필요). 세션 시작 뒤 비동기로 붙어 둘째 턴부터 지연 도구로 보였다. **`strictMcpConfig: true` 또는 env `ENABLE_CLAUDEAI_MCP_SERVERS=false` 면 붙지 않는다**(둘 다 모델 호출 없이 `q.mcpServerStatus()` 로 확인 — 「다시 재는 법」 8).
- 문맥에 `session_context` 로 **계정 이메일**이 들어간다(「The user's email address is … Use it only to identify the user …」). 에이전트가 채널에 러너 주인의 이메일을 쓸 수 있다. 끄는 방법은 찾지 못했다.

### 5.7 SDK MCP 도구도 지연 로드된다

4.6 — `alwaysLoad` 없이 등록한 dodok 도구가 ToolSearch 뒤로 밀려 모델이 스키마 없이 첫 호출을 했다. `tool()` 의 다섯째 인자 `{ alwaysLoad: true }`(또는 `createSdkMcpServer({ alwaysLoad: true })`)를 주면 지연 목록에서 빠지고 첫 호출이 스키마대로다. 가짜 Messages API 로 이것을 볼 때는 env `ENABLE_TOOL_SEARCH=true` 를 준다 — 이 모드는 기본으로 도구 검색이 꺼져 있어 아무것도 미뤄지지 않는다.

### 5.8 모델이 긴 명령을 백그라운드로 돌린다

`sleep 45 && echo done` 을 시키자 Haiku 4.5 가 `run_in_background: true` 로 돌렸다 — 도구는 즉시 「Command running in background with ID …」를 돌려주고 턴이 끝났다. 그 셸은 interrupt 나 프로세스 종료 때 죽고, 다음 `resume` 에서 「didn't finish before the previous session ended」 알림으로 나타난다(4.3). 런마다 프로세스가 끝나는 러너에서는 백그라운드 작업이 런을 넘어 살지 못한다. CLI 에 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 가 있다(정적 조회 — 효과는 재지 않았다).

### 5.9 `total_cost_usd` 는 세션 누적이다

4.8 — `resume` 한 프로세스의 첫 `result` 에 앞 런 비용이 이미 들어 있다. 그대로 더하면 두 번 센다.

### 5.10 자동 메모리가 켜져 있다 — 작업 디렉터리가 같은 채널끼리 공유한다

`settingSources: []` 여도 시스템 프롬프트에 「# auto memory — You have a persistent, file-based memory system at `<CLAUDE_CONFIG_DIR>/projects/<cwd 경로>/memory/`」 절이 들어가고 CLI 가 그 디렉터리를 만든다(가짜 Messages API). 메모리 자리는 **`cwd` 로 정해지므로 같은 작업 디렉터리를 쓰는 채널·스레드가 한 메모리를 나눠 쓴다** — 한 채널에서 에이전트가 적은 것이 다른 채널의 문맥에 들어간다. env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 이면 그 절이 요청에서 빠진다(가짜 Messages API — 모델 런 둘도 이 값으로 돌렸다).

## 6. 설계에 주는 제약과 추천

1. **프로세스 단위 — 런마다 `query()` 하나(추천).** 첫 런은 `sessionId`, 이후는 `resume`, 늘 `systemPrompt: { type: "preset", preset: "claude_code", append, snapshot: false }`(5.3). 런이 끝나면 프로세스가 끝나 유휴 세션이 메모리를 잡지 않는다. 기동은 `system/init` 까지 약 0.55초라 런마다 새 프로세스여도 체감 지연은 사고 시간이 지배한다. 첫 프롬프트 하나만 보내므로 훅 문맥이 빠지는 두 경우(4.5)도 생기지 않는다. 런의 끝은 **그 프롬프트의 턴에서 나온 `result`** 다 — `resume` 직후 `num_turns: 0` 결과가 먼저 올 수 있고(4.3), 마지막 `result` 뒤 CLI 가 exit 1 로 끝나 반복자가 던질 수 있다(4.4).
2. **채널 규칙은 틀을 갖춘 `append` 로 싣는다(추천 — 경로 (가)).** 런마다 서버가 준 채널 규칙을 4.5 「채널 규칙 틀」에 넣어 `systemPrompt.append` 로, `snapshot: false` 와 함께. 고른 까닭:
   - 새 세션에서 Sonnet 5 가 따랐고, 규칙을 **사용자 요청보다 위의 운영 정책**으로 다뤘다 — 관리자가 채널에 거는 규칙의 권한과 맞는다. 훅 경로(나)도 따랐지만 사용자가 명시적으로 달리 청하자 규칙 하나를 스스로 넘겼다(4.5 표).
   - 요청에 규칙이 **한 벌만** 실린다 — 바뀐 규칙은 다음 런의 시스템 프롬프트를 통째로 바꾸고 옛 규칙은 남지 않는다. 훅 경로는 턴마다 한 벌씩 이력에 쌓이고(바뀌어도 옛 블록이 남는다) 틀의 「대체한다」 문장에 기대 최신 것을 가린다.
   - 대가: 규칙이 바뀐 런은 프롬프트 캐시를 처음부터 쓴다(4.5 — 새 세션 첫 요청의 캐시 쓰기가 약 26,000 토큰이었다, 1시간 캐시 쓰기 단가). 규칙은 드물게 바뀌므로 받아들인다. 그리고 **바뀐 규칙을 `resume` 뒤에 따르는가는 모델로 재지 않았다**(요청에 새 규칙만 실리는 것은 가짜 Messages API 로 봤다 — 「확인 못 한 것」 1). 스펙의 실연에서 첫 규칙 변경을 본다.
   - 틀은 세션의 첫 런부터 싣는다 — 틀 없는 규칙을 한 번 「주입」으로 판정한 세션은 되돌리지 못한다(5.5).
   - 턴마다 바뀌는 사실(참여자·릴레이 깊이·스레드 여부 — 지금 OpenClaw 의 `ChannelPromptContext`)은 `UserPromptSubmit` 훅 `additionalContext` 로 싣는다. 모델이 출처를 정확히 알아보고 지시로 따르는 경로다(4.5 표 (나)). 런마다 `query()` 하나라 훅 문맥이 빠지는 두 경우(4.5)는 생기지 않는다.
   - `CLAUDE.md`(다)는 쓰지 않는다 — `settingSources: ["project"]` 는 사람 저장소의 `.claude/settings.json` 을 함께 끌어오고, 채널별 파일은 `additionalDirectories`(에이전트의 작업 범위가 된다)로만 둘 수 있으며, 머리가 「project instructions, checked into the codebase」라 출처를 틀리게 말한다(4.5).
3. **세션 키와 Claude 세션 id** — dodok 세션 키(`dodokSessionKey`, 스레드면 `:thread:<rootId>`)는 그대로 쓰고, 그 키에 Claude 세션 UUID 를 하나 묶는다. 정본은 서버(세션 행에 `providerSessionId`)를 추천한다. 리셋은 서버가 새 UUID 를 정해 다음 런에 싣는다. 같은 키의 런은 서버 오케스트레이터의 세션 큐가 직렬화하고, 러너도 같은 세션 id 의 겹친 런을 거절한다.
4. **`/runner` 계약 초안**(서버 ↔ 러너, 러너가 나가는 연결 하나. 브리지처럼 hello·토큰·능력):

   | 방향 | 프레임 | 내용 |
   | --- | --- | --- |
   | 러너 → 서버 | `hello` | 러너 버전·SDK 버전·`claudeCodeVersion`·능력(`threads`·`interrupt`·`approvals`·`attachments`)·에이전트 목록(러너가 돌릴 수 있는 에이전트 id·작업 디렉터리 라벨 — 경로 원문은 싣지 않는다) |
   | 서버 → 러너 | `run.start` | 지금 `InboundDeliver` 에 `providerSessionId`·`resume: boolean`·채널 프롬프트(+ 릴레이 규칙)를 더한 것 |
   | 러너 → 서버 | `run.ack` | `{ runId, admission: "dispatch" \| "drop", reason? }` — `InboundDeliverResult` 와 같은 뜻 |
   | 러너 → 서버 | `run.event` | 러너가 4.1 을 `RunEventBody` 로 정규화한 것(아래 표). 서버는 `seq`·`ts` 를 붙인다 |
   | 러너 → 서버 | `run.final` | `{ runId, text, stopReason, usage?, costUsd? }` — `result` 에서. `costUsd` 는 런 전후 `total_cost_usd` 차이(4.8) |
   | 러너 → 서버 | `outbound.message` | dodok 도구 호출(4.6) — 지금 `OutboundMessage` 그대로. 서버 ack 로 메시지 id 를 돌려받아 도구 결과로 쓴다 |
   | 러너 → 서버 | `approval.requested` / `approval.withdrawn` | `canUseTool` 이 불리면 / 그 `signal` 이 끊기면(4.2) |
   | 서버 → 러너 | `approval.resolve` | `{ approvalId, decision }` |
   | 서버 → 러너 | `run.abort` | `interrupt()` → 반응이 없으면 `close()` |
   | 러너 → 서버 | `run.error` | SDK 예외·`result` 오류·CLI 종료(마지막 `result` 전일 때만) |

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
   | `system/thinking_tokens` | 「생각 중」 표시용 `CUSTOM`(사고 글은 오지 않는다 — 4.1) |
   | `thinking` 블록·`tool_progress`·그 밖의 `system/*` | 버리거나 `CUSTOM`(활동 탭에 무엇을 보일지는 스펙) |

   **최종 답은 `result.result` 한곳**에서 만든다. 스트리밍 버블은 델타로, 채널에 남는 메시지는 `run.final` 로. 도구로 채널에 쓴 런의 최종 답을 따로 올릴지는 스펙이 정한다(지금 OpenClaw 9.5 는 둘 다 올린다 — `docs/guides/live-smoke.md` 「스레드(Phase 4 ①) 실연」 절).
5. **`AgentAdapter` 가 바뀔 자리** — `provider: "openclaw"` 를 `"openclaw" | "claude-runner"` 로. `AdapterStatus`·`AdapterSetupDetail` 은 어댑터별로 가른다. `send` 는 그대로 두되 러너는 세션 id·채널 프롬프트를 더 받는다. `abort(runId, sessionKey)` 는 그대로. `resetSession` 은 서버 안에서 새 UUID 를 정하는 것으로 끝난다. `syncChannelConfig` 는 러너에 할 일이 없다(런마다 채널 프롬프트를 싣는다) — `{ applied: "live" }`. `resolveApproval` 의 `kind` 는 `ApprovalKind` 에 도구 승인 종류를 더하거나 `Bash` 만 `exec` 로 매핑한다 — 스펙이 고른다. `pluginSupports` 는 러너 hello 능력으로.
6. **승인 흐름** — `canUseTool` 이 불리면 러너가 `approval.requested`(`toolUseID`·`displayName`·`description`·`blockedPath`·`input` 요약·`suggestions` 유무)를 보내고 promise 를 붙잡는다. **기한은 dodok 이 정한다**(SDK·CLI 에 없다) — 서버가 `expiresAt` 에 `deny` 를 보내면 러너가 `{ behavior: "deny", message: "승인 시간이 지났습니다" }` 를 돌려준다. `allow-always` → `updatedPermissions` 에 제안을 **`destination: "session"` 으로 바꿔** 싣는다(제안은 `localSettings` 로 온다 — 4.2). `deny` → 사유를 `message` 로. 콜백 `signal` 이 끊기면 `approval.withdrawn`. 콜백은 입력 검증보다 먼저 오므로(4.2) 러너가 dodok 도구 입력을 스스로 한 번 zod 로 보고 틀리면 카드를 띄우지 않고 거절해도 된다. 읽기 전용 Bash 는 CLI 가 묻지 않고 돌린다 — 「무엇을 사람에게 묻는가」를 dodok 이 정하려면 `PreToolUse` 훅이나 `permissionMode: "dontAsk"` + 허용 목록을 스펙이 고른다.
7. **도구 노출** — dodok 도구는 `createSdkMcpServer` 로 러너 안에(이름 `mcp__dodok__message` 등), `allowedTools` 로 미리 허용하고 **`createSdkMcpServer({ alwaysLoad: true })`** — ToolSearch 없이 첫 호출이 스키마대로다(4.6·5.7). components v1 스키마는 shared Zod 를 도구 입력 스키마로 쓸 수 있다(SDK 가 zod 로 JSON Schema 를 만들고 호출 입력도 그 zod 로 검증한다 — 4.6). 첨부는 러너가 로컬 파일을 읽어 서버 첨부 HTTP 로 올리고 `artifact://` id 를 싣는다.
8. **격리 기본값** — `options.env` 허용 목록(5.4), `CLAUDE_CONFIG_DIR` 은 러너 전용 디렉터리(러너 프로세스 env 에도, 5.2), **`strictMcpConfig: true`**(계정 커넥터를 막는다 — 5.6), `settingSources: []`(6의 2 — `CLAUDE.md` 경로를 쓰지 않는다), env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`(채널 사이 메모리 공유를 막는다 — 5.10), `cwd` 는 에이전트별 작업 디렉터리, 새 세션에는 `title` 을 준다(Haiku 제목 호출이 없어진다 — 4.8), `pathToClaudeCodeExecutable` 은 비워 번들 CLI 를 쓰되 SDK 버전을 정확 핀한다(번들 CLI 판본이 SDK 판본에 묶이고, 스냅숏·지연 로드·훅 문맥 자리 같은 동작이 CLI 판본마다 다를 수 있다).
9. **동시 실행 상한** — 러너 전역 상한(동시 CLI 프로세스 수)을 둔다. 런 중 CLI 하나가 290~325 MiB 라 10개면 3 GiB 안팎이다. 넘치면 서버 쪽 큐(지금 `RUN_QUEUED`)로 되돌린다.
10. **비용·한도** — 운영 화면의 런 비용은 `total_cost_usd` 의 런 전후 차이로(5.9), 토큰은 `result.usage` 로 기록한다. 구독 로그인이면 달러는 환산값이고 실제 한도는 `rate_limit_event` 다 — 운영 화면에 무엇을 보일지는 스펙이 고른다.
11. **라이선스** — SDK 는 오픈소스가 아니다(2절). 러너 배포물에 SDK 를 품어 재배포할지, 사용자 머신에서 설치하게 할지는 법무 판단을 받는다.

## 7. 다시 재는 법

스크래치 디렉터리에서(저장소 의존성에 넣지 않는다, 글로벌 설치 금지):

1. 설치
   ```bash
   SP=<스크래치>; mkdir -p $SP/sdk $SP/fakebin $SP/out $SP/home $SP/cfg $SP/ws $SP/tmp; cd $SP/sdk
   npm init -y && npm i --ignore-scripts @anthropic-ai/claude-agent-sdk@<판> zod@4
   npm view @anthropic-ai/claude-agent-sdk version license          # 적는다. package.json 의 claudeCodeVersion 도
   ln -s sdk/node_modules $SP/node_modules                            # 드라이버를 $SP 에 두고 맨 이름으로 import
   (cd $SP/ws && git init -q && echo x > README.md && git add . && git -c user.name=s -c user.email=s@l commit -qm init)
   ```
   모델 없이 SDK 만 볼 때는 번들 CLI 를 봉인한다: `B=node_modules/@anthropic-ai/claude-agent-sdk-$(node -p 'process.platform+"-"+process.arch')/claude; mv $B $B.DISABLED && chmod a-x $B.DISABLED`.
2. 가짜 CLI(`$SP/fakebin/claude`, 셸뱅 Node, `chmod +x`). 해야 할 것 — argv·env 키 이름·stdin 레코드를 파일에 적는다. `initialize` 에 `control_response { subtype: "success", request_id, response: { commands: [], models: [], … } }`. `user` 레코드를 받으면 `system/init` → 지시어별로 `stream_event`·`assistant`·`user(tool_result)`·`result` 를 낸다. 권한은 `control_request { subtype: "can_use_tool", … }`, SDK 도구는 `control_request { subtype: "mcp_message", … }`, 훅은 `control_request { subtype: "hook_callback", … }`. `interrupt` 가 오면 성공으로 답하고 대기 중 요청마다 `control_cancel_request` 를 낸 뒤 `result error_during_execution`.
3. 드라이버 — `query({ prompt, options: { cwd: $SP/ws, settingSources: [], env: <허용 목록>, includePartialMessages: true, systemPrompt: { type: "preset", preset: "claude_code", append, snapshot }, hooks: { UserPromptSubmit: [...] }, mcpServers: { dodok }, allowedTools, canUseTool, … } })` 를 `CLAUDE_CONFIG_DIR=<같은 값> node <드라이버>` 로. 턴 여럿은 `AsyncIterable<SDKUserMessage>` 로 보내되 **앞 턴의 `result` 를 받고 1.5초 뒤에** 다음 턴을 보낸다(틈이 없으면 훅 문맥이 빠진다 — 4.5). 소비 쪽 메시지를 `{ t, m }` 로 한 줄씩, 콜백·핸들러·훅·interrupt 를 사건 파일로 적는다. 반복자는 `try` 로 감싼다(4.4). 동시성은 `query()` N개를 `Promise.all` 로.
4. 정적 조회 — `LC_ALL=C strings -n 12 <번들 CLI> > cli-strings.txt` 로 한 번 뽑고 찾는다: `subtype:"can_use_tool"`(권한 경로·타이머 유무), `-credentials"`(키체인 이름), `"projects"`(전사 위치), env 이름(`ENABLE_CLAUDEAI_MCP_SERVERS`·`CLAUDE_CODE_DISABLE_*`). SDK 쪽은 `sdk.mjs` 의 `processControlRequest`·`waitForFirstResult`·`"SIGKILL"`·`process.env.CLAUDE_CONFIG_DIR`, 옵션 뜻은 `sdk.d.ts`.
5. 번들 CLI 유휴(모델 호출 없음): `env -i PATH=… HOME=<스크래치> CLAUDE_CONFIG_DIR=<스크래치> CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1` 로 3절 argv 를 붙여 띄우고 stdin 에 `initialize` 한 줄만 쓴다(사용자 메시지는 보내지 않는다). `ps -o rss= -p <pid>`·`ps -M -p <pid> | wc -l`·`lsof -nP -a -p <pid> -i` → 그 PID 에 SIGTERM.
6. **가짜 Messages API 리허설(모델 호출 없음)** — 로컬 HTTP 서버가 `POST /v1/messages` 의 본문을 파일로 적고(헤더는 적지 않는다) SSE 로 `message_start`·`content_block_*`(사고·텍스트·`tool_use`)·`message_delta`·`message_stop` 을 돌려준다. 마지막 사용자 글의 키워드로 `tool_use` 를 고른다. 드라이버 env 를 `ANTHROPIC_BASE_URL=http://127.0.0.1:<포트>`·`ANTHROPIC_API_KEY=sk-ant-fake-…`·`CLAUDE_CONFIG_DIR=<스크래치>`·`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 로 바꾸면 **번들 CLI 가 실제로 보내는 요청**과 CLI 의 권한 판단·도구 실행·interrupt 모양을 본다. 요청 본문에서 `system[].text` 의 채널 규칙, `messages[]` 의 `<system-reminder>` 블록 자리, `thinking`·`output_config`·`tools[].name` 을 읽는다. **모델 런 드라이버는 먼저 여기서 끝까지 돌려 본다.** 계정별 롤아웃 기능은 이 모드에서 기본값이라 실제 계정과 다를 수 있다 — 달라도 되는 것은 전사의 `prompt_snapshot` 플래그(`systemTurns`·`contextRendering`)로 비교한다. 이 모드는 도구 검색이 꺼져 있다 — 지연 로드·`alwaysLoad` 를 볼 때는 env `ENABLE_TOOL_SEARCH=true` 를 더한다. 채널 규칙 경로를 볼 때는 규칙 문장이 `system[].text` 에 있는지(가), `messages[]` 의 `UserPromptSubmit hook additional context` 블록에 있는지(나), `Contents of … CLAUDE.md` 블록에 있는지(다)를 요청마다 세고, 규칙을 바꾼 턴·`resume` 에서 옛 규칙이 요청에 남는지를 본다.
7. 모델 런(사람 승인 사항 — 횟수를 먼저 정한다) — 6과 같은 드라이버를 러너 로그인의 `CLAUDE_CONFIG_DIR`·실제 `HOME` 으로. 드라이버가 250ms 마다 `ps -A -o pid=,ppid=,rss=,comm=` 에서 자기 자손 중 `claude` 의 RSS 를 적고, 소비 쪽 메시지 시각에서 `system/init`·첫 `content_block_delta`·첫 `text_delta` 를 뽑는다. 채널 규칙 판정은 전사의 `prompt_snapshot`(`systemPrompt` 조각에서 규칙 문장)과 모델에게 규칙 문장을 그대로 인용하게 한 답을 함께 본다. 비용은 런 전후 `total_cost_usd` 차이, 단가 검증은 `result.usage` × 공시 단가. 끝나면 `CLAUDE_CONFIG_DIR/projects/<cwd 경로>/`·`session-env/<세션>/`·`/private/tmp/claude-<uid>/<cwd 경로>/` 를 지운다.
8. 계정 커넥터(모델 호출 없음) — 사용자 메시지를 보내지 않는 프롬프트(끝나지 않는 `AsyncIterable`)로 `query()` 를 열고 8초 기다려 `q.mcpServerStatus()` 의 `name`·`scope`·`status` 를 적은 뒤 `q.close()`. 기본값·`strictMcpConfig: true`·env `ENABLE_CLAUDEAI_MCP_SERVERS=false` 셋을 비교한다. 같은 방법으로 `q.accountInfo()` 에서 인증을 본다(이메일·조직은 적지 않는다).
9. 끝나면 `rm -rf $SP`.

## 8. 확인 못 한 것 — 모델 런이 있어야 아는 것

1. **바뀐 채널 규칙을 `resume` 한 세션이 따르는가(경로 (가))** — 요청에 새 규칙만 실리는 것은 봤지만(가짜 Messages API), 앞 답들이 옛 표식으로 시작하는 이력 위에서 모델이 새 규칙을 따르는지는 재지 않았다. 경로마다 새 세션 표본이 하나씩이고, 해로운 일을 시키는 규칙(모델이 거부해야 하는 규칙)과 `CLAUDE.md`(다)는 모델로 재지 않았다.
2. **실제 모델에서 전경 도구 실행 중 interrupt** — 번들 CLI + 가짜 API 로 모양(4.4)은 봤지만, 실제 모델이 전경으로 돈 긴 도구를 멈춘 경우와 `tool_progress` 주기는 보지 못했다(모델이 백그라운드로 돌렸다).
3. **읽기 전용 Bash 자동 허용의 경계** — CLI 가 어떤 명령을 묻지 않는지(이 스파이크는 `git status`·`git log`·`sleep … && echo` 가 묻지 않고, `touch` 가 물었다는 것만 안다). `permissionMode: "dontAsk"`·`PreToolUse` 훅과의 조합.
4. **스크래치 `HOME` 에서의 로그인**과 `CLAUDE_SECURESTORAGE_CONFIG_DIR=""` 로 기본 로그인을 공유하는 길.
5. **`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 가 백그라운드 실행을 막는가**, 계정 이메일(`session_context`)을 문맥에서 뺄 수 있는가.
