# Phase 4 ③ Claude 러너 — Claude Agent SDK 어댑터 설계

**상태**: 설계 확정(2026-09-27). 계획 `docs/superpowers/plans/2026-09-27-claude-runner.md`(태스크 1~9, 계획 판정 P1~P10).
**범위**:
- 사람의 머신에서 도는 러너(`@dodok/claude-runner`)가 Claude Agent SDK 로 에이전트를 돌리고, 서버 `/runner` 로 나가는 WSS 하나로 dodok 에 붙는다
- 서버는 에이전트의 `provider` 로 어댑터를 고른다(`openclaw` · `claude`) — 한 채널에 두 종류 에이전트가 함께 있고 서로 @멘션 릴레이한다
- 러너 토큰(연결 페이지, owner), 도구 승인(`canUseTool` → 기존 승인 카드), dodok 도구 `mcp__dodok__post`(카드·파일)

**앞선 근거**:
- 실측 ADR `docs/adr/0007-claude-agent-sdk-spike.md` — 특히 「설계에 주는 제약과 추천」(프로세스 단위·채널 규칙 경로·`/runner` 계약 초안·`RunEvent` 대응표·승인·도구·격리 기본값)과 「확인 못 한 것」
- 어댑터 계약: `packages/openclaw-adapter/src/adapter-types.ts` 의 `AgentAdapter`(서버는 `apps/server/src/adapters/types.ts` 로 re-export)
- 발급 원문을 한 번만 보이는 토큰과 연결 페이지: 설정 마법사 스펙 `docs/superpowers/specs/2026-09-24-setup-wizard-design.md`(브리지 토큰·플러그인 tgz·`bundleSha256`)
- 역할과 승인 결정자: 팀 스펙 `docs/superpowers/specs/2026-09-26-team-members-design.md` 「역할과 권한」

---

## 0. 결정 (브레인스토밍 2026-09-27)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **Phase 4 어댑터는 Claude Agent SDK 러너부터**(Codex·Hermes 는 뒤) | OpenClaw 없이 에이전트를 붙일 두 번째 길. 계정 하나로 바로 쓴다. |
| 2 | **러너는 사람의 머신에서 그 사람의 저장소를 작업 디렉터리로 쓴다** | 「내 저장소에서 일하는 에이전트를 팀 채널에 부른다」가 쓰임새다. 서버 호스트에서 도는 러너는 v1 에 두지 않는다. |
| 3 | **`/runner` 네임스페이스 + 서버 어댑터 레지스트리**(접근 1) | 브리지 계약에 섞으면 OpenClaw 전용 의미(Gateway·플러그인 세대)가 러너로 샌다. 레지스트리는 다음 어댑터(Codex 등)도 같은 자리에 꽂는다. |
| 4 | **인증은 러너 전용 로그인**(`CLAUDE_CONFIG_DIR` 을 러너 전용 디렉터리로) | 사람의 평소 `~/.claude` 와 세션·메모리·설정이 섞이지 않는다(ADR 0007 「함정」 — 키체인 이름이 설정 디렉터리마다 다르다). |
| 5 | **권한의 천장은 러너의 로컬 설정** | 서버나 러너 토큰이 털려도 사람 머신에서 할 수 있는 일은 머신 주인이 적은 범위(도구·작업 디렉터리·권한 모드)를 넘지 못한다. |
| 6 | **채널 규칙은 틀을 갖춘 `systemPrompt.append` + `snapshot: false`, 턴 사실은 `UserPromptSubmit` 훅** | ADR 0007 실측 — 틀 없는 append 는 모델이 「주입」으로 거부했고, 틀을 갖춘 append 는 운영 정책으로 따랐다. 훅 문맥은 출처를 정확히 알아본다. |

## 1. 범위

**한다**
- `packages/claude-runner` — 러너 CLI(설정 파일·토큰·재접속·런 실행·도구·승인·첨부)
- `packages/shared/src/runner/` — `/runner` 프레임 Zod, 채널 규칙 틀(`buildChannelRulesAppend`), 턴 사실 문장(`buildTurnFacts`)
- `packages/shared/src/adapter/` — `AgentAdapter` 계약을 어댑터 패키지 밖으로(타입과 `AdapterError` 만, Node API 없음)
- `packages/runner-adapter` — 서버 측 `/runner` 엔드포인트·토큰 검사·러너 연결 관리·`AgentAdapter` 구현
- 서버: `AdapterRegistry`, `runner_tokens`·에이전트 등록·연결 페이지 러너 블록·승인 종류 `tool`·운영 사건 `runner_down`·런 비용 값
- 웹: 연결 페이지 러너 블록(발급·폐기·상태·에이전트), 에이전트 등록의 제공자 고르기, 도구 승인 카드, 운영 화면의 제공자별 연결 줄·비용
- dev:fake 가짜 러너, 런 0회 하네스(번들 CLI + 가짜 Messages API), 실연
- 문서: `docs/guides/deploy.md` 러너 설치 절, `docs/guides/agent-guide.md` Claude 러너 절, `docs/guides/live-smoke.md` 러너 하네스·실연 절, ADR 0007 갱신

**하지 않는다**
- Codex·Hermes 어댑터, 데스크톱·모바일 앱
- 러너를 OS 서비스로 자동 시작(v1 은 사람이 터미널에서 띄운다)
- 재접속 뒤 런 이벤트 이어 받기
- 웹에서 러너 설정 원격 편집
- thinking 표시(글이 오지 않는다 — ADR 0007 「질문별」 스트리밍)
- 멤버별 개인 러너(러너 토큰은 owner 가 발급한다)

## 2. 구성

```
사람의 머신                              dodok 서버
┌───────────────────────────┐   WSS    ┌──────────────────────────────────┐
│ @dodok/claude-runner      │ ───────▶ │ /runner (runner-adapter)         │
│  config.json (에이전트·   │  토큰    │   RunnerAdapter: AgentAdapter    │
│   작업 디렉터리·도구)     │          │ /bridge (openclaw-adapter)       │
│  Claude Agent SDK ─ CLI   │ ◀─HTTP── │   OpenClawAdapter: AgentAdapter  │
│  (런마다 query() 하나)     │  첨부    │ AdapterRegistry(provider → 어댑터)│
└───────────────────────────┘          └──────────────────────────────────┘
```

- **러너는 나가는 연결만 쓴다.** 사람 머신 쪽 포트를 열지 않는다(브리지와 같은 방향). 첨부 바이트는 서버 첨부 HTTP(`/runner/attachments`, 러너 토큰)로 오간다.
- **어댑터 계약을 `shared` 로 옮긴다.** `AgentAdapter`·`AdapterEvent`·`RunEventBody`·`AdapterCapabilities`·`AdapterError` 가 `packages/shared/src/adapter/` 로 가고, 두 어댑터 패키지와 서버가 거기서 가져간다. OpenClaw 에만 있는 것은 일반형과 어댑터별 부분으로 나눈다:
  - `provider` 는 `"openclaw" | "claude"`(`AgentProvider` 의 부분집합)
  - `setupDetail()` 은 `{ provider, detail }` 판별 유니온 — OpenClaw 는 지금의 gateway·bridge, 러너는 러너 목록(5장)
  - `revokeBridgeSessions(tokenId)` 는 `revokeTokenSessions(tokenId)` 로 이름을 바꿔 두 어댑터가 각자 토큰 종류로 구현한다
  - `ProviderApproval` 은 어댑터 공통 모양(`providerApprovalId`·`kind`·`sessionKey`·`toolCallId?`·`summary`·`expiresAt`·`state`)으로 올리고 OpenClaw 정규화가 그것을 채운다
  - `pluginSupports(capability)` 는 `supports(agent, capability)` — OpenClaw 는 붙은 플러그인, 러너는 그 에이전트를 알린 러너의 hello 능력
- **`AdapterRegistry`**(`apps/server/src/adapters/registry.ts`): `forProvider(p)`·`forAgent(agent)`·`all()`. 오케스트레이터·승인·세션·채널·에이전트·연결·운영 모듈이 어댑터 하나를 쥐던 자리를 레지스트리로 바꾼다. 이벤트는 `all()` 을 구독해 받는다. 한 채널의 릴레이는 에이전트마다 자기 어댑터로 간다 — 릴레이 규칙·일일 한도·런 관문은 어댑터와 무관하게 지금 그대로다.
- **세션**: 세션 키는 `dodokSessionKey`(스레드면 하위 세션 키) 그대로. Claude 세션 UUID 는 세션 행의 `providerSessionId` 가 정본이다. 러너 에이전트의 첫 런에서 서버가 UUID 를 정하고, 「새 대화」는 서버가 새 UUID 를 정하는 것으로 끝난다(러너에 할 일 없음). 러너 에이전트 id 는 OpenClaw agentId 와 같은 규칙(소문자 — 스레드 스펙 R4)으로 검사한다.
- **에이전트 등록**: `provider` 에 `claude` 를 연다. `providerAgentId` 는 지금 붙은 러너가 hello 로 알린 에이전트 중에서만 고른다(OpenClaw 의 `listAgents` 자리). 등록 뒤 러너가 끊겨도 에이전트는 남는다.

## 3. `/runner` 계약

프레임은 `packages/shared/src/runner/` 의 Zod 판별 유니온. 경계에서 파싱하고, 모르는 프레임 종류는 버리고 warn 로그.

| 방향 | 프레임 | 내용 |
| --- | --- | --- |
| 러너 → 서버 | `hello` | `runnerProtocol: 1`, `runnerVersion`, `sdkVersion`, `claudeCodeVersion`, `bundleSha256`, `capabilities: string[]`(`threads`·`interrupt`·`approvals`·`attachments`), `agents: { id, name, model, workdirLabel }[]` — 경로 원문은 싣지 않는다 |
| 서버 → 러너 | `hello.ok` / `hello.reject` | 거절 사유 코드 — 기존 `ErrorCode` 의 `PROTOCOL_MISMATCH`·`UNAUTHORIZED`(폐기·틀린 토큰)·`RATE_LIMITED`(가드 차단) — 러너는 사유를 출력하고 종료한다 |
| 서버 → 러너 | `run.start` | `InboundDeliver` 전부 + `providerSessionId` + `resume: boolean` + `channelRulesAppend`(틀을 입힌 문자열) + `turnFacts`(문자열) |
| 러너 → 서버 | `run.ack` | `{ runId, admission: "dispatch" \| "drop", queuedPosition?, reason? }` — `queuedPosition` 이 있으면 어댑터가 `RUN_QUEUED` 를 낸다 |
| 러너 → 서버 | `run.event` | `{ runId, event: RunEventBody }` — ADR 0007 대응표. 서버가 `seq`·`ts` 를 붙인다 |
| 러너 → 서버 | `run.final` | `{ runId, text, stopReason, usage?, costUsd?, costKind: "api" \| "subscription_estimate" }` |
| 러너 → 서버 | `run.error` | `{ runId, code: ErrorCode, message }` — 마지막 `result` 전에 SDK 예외·CLI 종료가 났을 때만 |
| 서버 → 러너 | `run.abort` | `{ runId }` — 러너는 `interrupt()`, 5초 안에 턴이 끝나지 않으면 `close()` |
| 러너 → 서버 | `outbound.post` | dodok 도구 호출 — `OutboundMessage` 와 같은 모양(첨부는 이미 올린 `artifact://` id). 서버가 `outbound.ack { messageId }` 로 답하고 러너가 도구 결과로 돌려준다 |
| 러너 → 서버 | `approval.requested` / `approval.withdrawn` | 6장 |
| 서버 → 러너 | `approval.resolve` | `{ providerApprovalId, decision }` |
| 양쪽 | `ping` / `pong` | 20초 간격, 60초 무응답이면 끊는다 |

- **런의 끝**은 그 프롬프트 턴의 `result` 다. `resume` 직후 먼저 오는 `num_turns: 0` 결과는 건너뛰고, 마지막 `result` 뒤 CLI 가 exit 1 로 끝나 반복자가 던지는 것은 실패로 보지 않는다(ADR 0007 「질문별」 중지).
- **런 비용**은 `total_cost_usd` 의 런 전후 차이(세션 누적이라 차이여야 런 몫이다). 첫 런은 0 에서의 차이. 구독 로그인(`accountInfo` 의 구독 종류가 있으면)이면 `costKind: "subscription_estimate"`.
- **토큰 수**는 `result.usage` 에서.

## 4. 러너

### 4.1 설정 파일

`dodok-runner --config <경로>`(기본 `~/.dodok-runner/config.json`). 러너가 Zod 로 파싱하고, 틀리면 어느 키가 왜 틀렸는지 출력하고 종료한다.

```json
{
  "serverUrl": "https://chat.example.com",
  "tokenFile": "~/.dodok-runner/token",
  "claudeConfigDir": "~/.dodok-runner/claude",
  "maxConcurrentRuns": 3,
  "agents": [
    {
      "id": "coder",
      "name": "코더",
      "workdir": "~/src/my-repo",
      "workdirLabel": "my-repo",
      "model": "sonnet",
      "permissionMode": "default",
      "allowedTools": ["Read", "Grep", "Glob", "Bash(git status)", "Bash(git diff:*)"],
      "disallowedTools": []
    }
  ]
}
```

- 토큰은 `tokenFile`(권한 0600 이 아니면 경고) 또는 env `DODOK_RUNNER_TOKEN`. 설정 파일 본문에는 두지 않는다. 로그·오류 문구에 토큰을 싣지 않는다.
- `workdir` 는 존재하는 디렉터리여야 한다. `workdirLabel` 이 없으면 디렉터리 이름.
- `allowedTools` 에는 러너가 늘 `mcp__dodok__post` 를 더한다.

### 4.2 런 하나

런마다 `query()` 하나, 끝나면 CLI 프로세스도 끝난다. 옵션:

- `cwd: agent.workdir`, `model`, `permissionMode`, `allowedTools`, `disallowedTools`
- 첫 런 `sessionId: providerSessionId`, 이후 `resume: providerSessionId`
- `systemPrompt: { type: "preset", preset: "claude_code", append: channelRulesAppend, snapshot: false }` — 틀은 세션의 첫 런부터 늘 싣는다(틀 없는 규칙을 한 번 거부한 세션은 되돌리지 못한다 — ADR 0007 「함정」)
- `hooks.UserPromptSubmit` 이 `additionalContext: turnFacts` 를 돌려준다
- `mcpServers: { dodok: createSdkMcpServer({ name: "dodok", alwaysLoad: true, tools: [post] }) }`, `strictMcpConfig: true`, `settingSources: []`
- `canUseTool` — 6장
- `includePartialMessages: true`
- 새 세션이면 `title`(채널 이름 + 에이전트 이름) — 제목을 지으려는 보조 모델 호출이 없어진다
- `env` 는 허용 목록: `PATH`·`HOME`·`LANG`·`LC_ALL`·`TERM`·`TMPDIR`·`SHELL`·`USER` + `CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. 러너 프로세스 자신의 `process.env.CLAUDE_CONFIG_DIR` 도 같은 값으로 둔다(SDK 세션 도우미가 그것을 읽는다).
- SDK 는 러너의 의존성으로 **정확 핀**, `pathToClaudeCodeExecutable` 은 비워 번들 CLI 를 쓴다.

프롬프트: `InboundDeliver.message` 의 `text` 에 지금 OpenClaw 경로와 같은 dodok 헤더(보낸 사람·채널, 스레드면 스레드)를 붙인 것. 이미지 첨부는 러너가 `/runner/attachments/<id>` 에서 받아 사용자 메시지의 이미지 블록으로 넣는다.

### 4.3 스트림 → `RunEvent`

ADR 0007 「설계에 주는 제약과 추천」의 대응표를 그대로 따른다. 러너가 도구 `durationMs` 를 `TOOL_CALL_START` 부터 잰다. `thinking` 블록·`system/thinking_tokens`·`tool_progress`·그 밖의 `system/*` 는 버린다. `interrupt()` 로 끝난 턴은 `RUN_ABORTED { by: "user" }`, `result` 의 `error_*` 는 `RUN_ERROR`.

### 4.4 dodok 도구 `mcp__dodok__post`

입력 `{ text?: string, components?: ComponentsV1, files?: string[] }`(셋 중 하나는 있어야 한다). `components` 는 shared `ComponentsV1` Zod 스키마를 도구 입력 스키마로 쓴다.

- `files` 는 **작업 디렉터리 안의 상대 경로만**. 러너가 `realpath` 로 풀어 작업 디렉터리 밖(`..`·심볼릭 링크·절대 경로)이면 거절하고, 20 MiB·10개를 넘으면 거절한다. 통과한 파일은 `/runner/attachments` 로 올려 `artifact://<id>` 를 받는다.
- 거절 사유는 도구 결과로 모델에게 돌려준다. **호스트 경로는 어떤 텍스트에도 쓰지 않는다** — 도구 결과·`run.event`·오류 문구에도 작업 디렉터리 상대 경로만.
- **글 답은 최종 답으로, 이 도구는 카드·파일을 보낼 때** — 에이전트 가이드가 이렇게 가르친다. 최종 답과 도구 글이 겹치는 것을 막는 장치는 두지 않는다.

### 4.5 동시 실행·끊김

- 동시 CLI 수는 `maxConcurrentRuns`(기본 3 — 런 중 CLI 하나가 약 300 MiB). 넘치면 `run.ack` 에 `queuedPosition` 을 싣고 자리가 나면 시작한다.
- 같은 `providerSessionId` 의 런이 이미 돌고 있으면 `run.error { code: "CONFLICT" }`(서버 세션 큐가 직렬화하므로 정상 경로에서는 나지 않는다).
- **서버 연결이 끊기면 그 러너의 모든 런을 곧바로 `interrupt()`** 하고 대기열을 비운다. 재접속은 1초에서 30초까지 지수 백오프.

## 5. 러너 토큰·연결 페이지

- `runner_tokens`: `id`, `label`(머신 이름), `token_hash`(sha256), `created_at`, `revoked_at`, `last_seen_at`. 원문 `drn_…` 은 발급 응답 한 번만. 발급·폐기는 owner.
- 폐기하면 그 토큰의 러너 연결을 곧바로 끊는다(`revokeTokenSessions`). 끊긴 러너의 런은 4.5 대로 멈추고 서버는 `ADAPTER_UNAVAILABLE` 로 닫는다.
- 인증 실패는 브리지와 같은 `BridgeAuthGuard`(실패 카운터·IP 버킷)를 `/runner` 핸드셰이크와 `/runner/attachments` 가 함께 쓴다 — 가드를 어댑터 공용 자리(`packages/runner-adapter` 가 가져다 쓸 수 있는 곳)로 옮긴다.
- **러너 여러 대.** 토큰 하나 = 러너 연결 하나(같은 토큰의 두 번째 연결은 먼저 붙은 것을 끊는다). 에이전트 id 는 `claude` 제공자 안에서 유일해야 한다 — 이미 붙은 러너가 알린 id 를 다른 러너가 또 알리면 뒤 러너의 그 에이전트만 「충돌」로 표시하고 배정하지 않는다(warn 로그).
- **같은 빌드**: 서버 이미지가 같은 커밋의 러너 tgz 를 품고(`/app/runner`, 플러그인 tgz 와 같은 방식) 연결 페이지가 내려준다. 러너 번들은 SDK 를 품지 않는다(`external`) — 설치할 때 npm 에서 받는다. hello 의 `bundleSha256` 으로 「같은 빌드」를 가른다.
- **연결 페이지 러너 블록**(owner): 토큰 목록·발급·폐기, 러너별 연결 상태·러너/SDK/CLI 버전·같은 빌드 여부·붙은 시각·에이전트 목록(충돌 표시), 설치 안내(tgz 받기 → 전용 로그인 → 설정 파일 → 실행). 그리고 **드러나는 것 둘**을 같은 블록에 적는다:
  1. 러너 계정의 이메일이 에이전트 문맥에 들어간다(끌 방법이 없다) — 러너 전용 계정을 권한다.
  2. 채널 멤버는 에이전트를 통해 러너 작업 디렉터리 안의 파일을 읽을 수 있다 — 그 에이전트를 어느 채널에 둘지는 admin 이 판단한다.
- 60초 넘게 끊긴 러너(마지막 연결이 있었던 토큰)는 운영 사건 `runner_down`(키는 토큰 id). 운영 화면 연결 줄은 제공자별로 — OpenClaw(Gateway·플러그인)와 러너(붙은 수 / 토큰 수).

## 6. 승인

- **무엇을 묻는가는 러너 설정과 CLI 가 정한다.** dodok 은 CLI 가 `canUseTool` 로 묻는 것을 사람에게 전한다. CLI 가 스스로 허용하는 것(미리 허용한 도구·규칙, 읽기 전용 Bash 일부)은 묻지 않는다.
- `canUseTool(toolName, input, { signal, suggestions, toolUseID, … })` 가 오면 러너가 `approval.requested { providerApprovalId, runId, sessionKey, toolCallId: toolUseID, toolName, summary, canAllowAlways }` 를 보내고 결정을 기다린다.
  - `summary`: Bash 는 명령, 파일 도구는 작업 디렉터리 상대 경로, 그 밖은 입력 JSON 앞 200자. 호스트 경로는 상대 경로로 바꾸고, 작업 디렉터리 밖이면 `<작업 디렉터리 밖>` 으로 가린다.
- `ApprovalKind` 에 `tool` 을 더한다. 카드는 지금 승인 카드 모양(허용·항상 허용·거절), 결정은 admin 이상(팀 스펙 그대로), 결정자는 이긴 결정을 누른 사람.
- **기한은 서버가 정한다 — 10분.** SDK·CLI 에 기한이 없다(ADR 0007). 지나면 서버가 `approval.resolve { decision: "deny" }` 를 보내고 러너는 `{ behavior: "deny", message: "승인 시간이 지났습니다" }`.
- **항상 허용**은 제안의 `destination` 을 `session` 으로 바꿔 `updatedPermissions` 에 싣는다 — 러너 로컬 설정 파일에는 쓰지 않는다. 거절은 사유를 `message` 로.
- 콜백 `signal` 이 끊기면(런 중지 등) `approval.withdrawn` — 카드는 지금 철회 경로 그대로.
- 콜백이 입력 검증보다 먼저 오므로 `mcp__dodok__post` 는 미리 허용해 승인에 오지 않게 한다.

## 7. 웹

- **연결 페이지** 러너 블록(5장). 발급 대화상자는 브리지 토큰 대화상자를 재사용한다.
- **에이전트 등록** — 제공자 고르기(OpenClaw · Claude 러너). Claude 러너를 고르면 붙은 러너들이 알린 에이전트 목록(러너 라벨·작업 디렉터리 라벨·모델과 함께)에서 고른다. 러너가 하나도 없으면 연결 페이지로 가는 안내.
- **도구 승인 카드** — `kind: tool` 은 도구 이름과 요약(코드 글꼴)을 보인다.
- **운영 화면** — 제공자별 연결 줄, `claude` 런의 비용 값(구독이면 「환산값」 표시). OpenClaw 런은 지금처럼 「측정 불가」.
- 문구는 합쇼체, 서버 오류 문구를 그대로 보이지 않는다(팀 스펙 규칙).

## 8. 오류 처리

| 상황 | 결과 |
| --- | --- |
| 에이전트의 러너가 붙어 있지 않음 | `ADAPTER_UNAVAILABLE` → 기존 run_error 카드(「다시 실행」) |
| 러너가 런 중 끊김 | 러너가 `interrupt()`, 서버는 그 런을 `ADAPTER_UNAVAILABLE` 로 닫음. 「다시 실행」은 같은 세션을 `resume` |
| 러너가 `hello` 로 알린 에이전트에 없는 id 의 `run.start` | `run.error { code: "NOT_FOUND" }` |
| 설정 파일·토큰 파일 오류 | 러너가 사유를 출력하고 종료(연결 시도 없음) |
| 프로토콜 불일치 | `hello.reject { PROTOCOL_MISMATCH }` — 러너가 「서버와 러너 판본을 맞추라」 출력 후 종료 |
| 인증 실패 반복 | `BridgeAuthGuard` 차단 — 운영 사건 `bridge_auth_blocked`(지금 그대로, 경로 필드로 가른다) |
| CLI 가 로그인 안 됨(`authentication_failed` 등) | `run.error { code: "PROVIDER_AUTH" }`(`ErrorCode` 에 새로 더하는 유일한 코드) — 카드 문구는 「러너의 Claude 로그인을 확인하세요」 |
| `mcp__dodok__post` 경로 탈출·크기 초과 | 도구 결과로 거절 사유, 런은 계속 |
| 서버가 런 제한시간으로 닫음 | `run.abort` → `forgetRun` |

## 9. 테스트·검증

- **shared**: `/runner` 프레임 Zod 왕복·거절, `buildChannelRulesAppend`·`buildTurnFacts` 문장 고정.
- **claude-runner**: SDK `query` 를 주입할 수 있게 두고 가짜 스트림으로 — 대응표 전 항목, 「그 턴의 `result`」 판정(`num_turns: 0` 건너뛰기·마지막 `result` 뒤 exit 1), `interrupt` → `RUN_ABORTED`, 승인 왕복·기한 `deny`·항상 허용 `destination`, `files` 경로 탈출(`..`·심볼릭 링크·절대 경로)·크기, `env` 허용 목록 밖의 값이 CLI 에 가지 않음, 동시 상한·`queuedPosition`, 끊기면 전부 `interrupt`, 설정 파일 오류 문구, 토큰이 로그에 없음.
- **runner-adapter·서버**: 가짜 러너(WS 클라이언트)로 통합 시나리오(모델 런 0) — 멘션 → 런 → 최종 답, 스레드 하위 세션, 승인(허용·항상 허용·거절·만료), 러너 끊김 → 「다시 실행」 → `resume`, 토큰 폐기 → 즉시 끊김, 에이전트 id 충돌, **OpenClaw 에이전트와 Claude 에이전트가 한 채널에서 서로 @멘션 릴레이**(레지스트리 핵심).
- **dev:fake**: 가짜 러너 하나(대본 재사용) — 웹에서 러너 블록·`claude` 에이전트 등록·도구 승인 카드. 브라우저 검증은 워커가.
- **런 0회 하네스**: 실제 번들 CLI 에 로컬 가짜 Messages API(`ANTHROPIC_BASE_URL`·가짜 키·스크래치 `CLAUDE_CONFIG_DIR`)를 붙여 실제 러너 + 실제 서버를 끝까지 — 요청 본문의 틀·훅 문맥·`alwaysLoad`·`canUseTool`·중지. `docs/guides/live-smoke.md` 새 절.
- **실연**: 모델 런은 실행 직전 사용자 승인(3회 이내 예정) — 규칙을 바꾼 뒤 `resume` 한 세션이 새 규칙을 따르는가(ADR 0007 「확인 못 한 것」), 실제 도구 승인 카드, `post` 로 카드·파일, 운영 화면 비용.

## 10. 완료 기준

1. 한 채널에서 사람이 Claude 러너 에이전트를 멘션하면 스트리밍 버블과 최종 답이 오고, 활동 탭에 도구 타임라인이 보인다.
2. 채널 규칙이 에이전트의 답에 반영되고, 규칙을 바꾸면 다음 런부터 새 규칙을 따른다.
3. 쓰기 도구는 승인 카드가 뜨고 admin 이 허용·거절할 수 있으며, 10분이 지나면 거절로 닫힌다.
4. 에이전트가 `post` 로 카드와 작업 디렉터리 안의 파일을 채널에 보낸다. 밖의 경로는 거절된다.
5. OpenClaw 에이전트와 Claude 러너 에이전트가 같은 채널에서 서로 @멘션 릴레이한다.
6. 러너 토큰을 폐기하면 그 러너가 곧바로 끊기고, 그 러너의 에이전트 런은 「다시 실행」 카드로 끝난다.
7. 운영 화면에 러너 런의 비용이 보인다.
8. 전체 테스트·typecheck·lint·fmt·웹 빌드·서버 번들 스모크 통과.

## 11. 열린 문제 (범위 밖 기록)

- SDK 라이선스가 오픈소스가 아니다 — 러너 tgz 는 SDK 를 품지 않고 설치 때 npm 에서 받게 했다. 러너를 공개 배포할지는 법무 판단.
- 계정 이메일을 에이전트 문맥에서 빼는 법(ADR 0007 「확인 못 한 것」).
- 읽기 전용 Bash 자동 허용의 경계, `PreToolUse` 훅으로 dodok 이 묻는 범위를 정하는 길.
- 러너가 서버 호스트에서 도는 배치(컨테이너 안 러너).
