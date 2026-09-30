# Phase 4 ③ Claude 러너 — Claude Agent SDK 어댑터 설계

**상태**: 설계 확정(2026-09-27), 구현·브라우저 검증·런 0회 하네스 완료(2026-09-29 — 계획 태스크 1~8 과 태스크 9 의 하네스·문서, 하네스 합격 기준 12/12) — 구현이 이 설계와 달라진 것은 「구현과 맞춘 것」 장(계획 판정 P1~P10·판정 R1~R5·M4). 계획 `docs/superpowers/plans/2026-09-27-claude-runner.md`(태스크 1~9), 하네스는 `docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」 절, 모델 런 실연(2026-09-29, 모델 런 3회 — 규칙 변경 뒤 이어 간 세션의 결과는 「구현과 맞춘 것」 장 끝)은 같은 문서 「Claude 러너(Phase 4 ③) 실연」 절.
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

## 12. 구현과 맞춘 것 (2026-09-29)

구현(계획 태스크 1~8)·리뷰·dev:fake 브라우저 검증·런 0회 하네스(계획 태스크 9)에서 이 설계와 달라지거나 설계가 정하지 않은 것을 정한 자리만 모았다. main `aacc979` 기준이다.
정본 근거는 실행 원장 `.superpowers/sdd/2026-09-27-claude-runner/ledger.md`(git 제외)의 계획 판정 P1~P10·조율자 판정 R1~R5·M4 와, 원장이 가리키는 보고서·리뷰(`p4c-t*`)다. 하네스 결과는 `docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」 절, 남은 문제는 `docs/plan.md` 8장 「이월」 한곳에 있다. 각 파일이 왜 그렇게 생겼는지는 그 파일의 머리 주석이 정본이다.

**계약 — `/runner`·어댑터(계획 판정 P1~P10)**

- **P1 — `/runner` 는 Socket.IO 네임스페이스다**(브리지 `/bridge` 와 같은 `io` 서버). 프레임은 이벤트 이름 + ack 이고 **3장 표의 `ping`/`pong` 프레임은 없다** — Socket.IO 하트비트가 그 몫이다. 첨부 HTTP 는 `RUNNER_ATTACHMENTS_PATH = "/runner/attachments"`. 배포는 Caddy 가 `/socket.io/*` 와 `/runner/*` 를 서버로 넘긴다(`infra/Caddyfile`).
- **P2 — `run.start` 에 `resume` 을 싣지 않는다.** 서버는 그 세션이 CLI 에 실제로 만들어졌는지 모른다(첫 런이 CLI 기동 전에 실패할 수 있다). 러너가 SDK `getSessionInfo` 로 그 `providerSessionId` 의 전사가 작업 디렉터리에 있으면 `resume`, 없으면 `sessionId` 로 연다. SDK 는 요약을 뽑을 수 없는 세션도 「없음」으로 돌려준다 — 그래서 `--session-id` 로 연 CLI 가 「이미 있는 세션」으로 거절하면(스트림 전) **`resume` 으로 한 번 다시 연다**.
- **P3 — 채널 규칙 틀·턴 사실은 러너 어댑터(서버 쪽)가 만든다.** `run.start` = `InboundDeliver` + `providerSessionId` + `channelRulesAppend` + `turnFacts`(+ 새 세션이면 `sessionTitle`). 문장은 shared `buildChannelRulesAppend`·`buildTurnFacts`·`renderRunnerPrompt` 한곳. 러너 어댑터는 `capabilities().promptEveryRun = true` 라 오케스트레이터가 채널 프롬프트를 **매 런** 싣는다(OpenClaw 는 새 세션에서만). 채널 지시(`promptOverride`)는 `<channel-rules>` 안 「Instructions for you (this agent) in this channel:」 아래, 릴레이 규칙은 관리자가 쓴 글이 아니라 틀 밖 `<relay-rules>` 에 둔다. 규칙 안의 `<` 와 닮은꼴(＜ ﹤ ‹ ˂ ⟨ 〈 〈)은 표식이든 아니든 모두 `&lt;` 로, 보이지 않는 서식 글자(`\p{Cf}`)는 지운다 — 대가로 규칙의 평범한 `a < b`·책 제목 괄호 〈…〉 도 바뀌어 모델에 간다. 턴 사실·프롬프트 머리는 플러그인 헤더와 같은 한국어 꼴이고, 프롬프트에 `보낸 사람:` 줄을 더했다(참여자·릴레이 규칙은 한 요청에 두 번 싣지 않게 프롬프트에서 뺐다). `InboundDeliver` 에 릴레이 깊이가 없어 턴 사실에 `릴레이:` 줄은 실리지 않는다.
- **P4 — Claude 세션 UUID 는 오케스트레이터가 정한다.** `capabilities().serverSessionIds = true` 인 어댑터면 `agent_sessions.provider_session_id` 가 비었을 때 `randomUUID()` 를 쓰고 `send(input, { providerSessionId })` 로 넘긴다. 「새 대화」는 그 열을 비운다 — 앞 세션 전사는 러너 머신의 `CLAUDE_CONFIG_DIR` 에 남는다.
- **P5 — 승인 기한 타이머는 러너 어댑터가 쥔다**(6장의 「서버가 정한다」를 어댑터 자리로). `ProviderApproval.expiresAt = now + 10분`, 그때까지 결정이 없으면 러너에 `approval.resolve { decision: "deny" }` 를 보내고 `expired`(+`timeout`)로 갱신한다. 서버의 기존 만료 감시도 같은 시각에 돈다.
- **P6 — 승인 결정 전 「Gateway 연결」 검사는 어댑터 안으로.** OpenClaw 어댑터의 `resolveApproval` 이 `ADAPTER_UNAVAILABLE` 로 던지고, 러너 어댑터는 그 승인의 러너가 없으면 같은 코드로 던진다. 러너 어댑터의 판정 순서: 모름 `NOT_FOUND` → 만료 `EXPIRED` → 이미 결정됨이면 그 스냅숏 → 러너 끊김 `ADAPTER_UNAVAILABLE` → 철회됨 `CONFLICT` → 허용 목록 밖 결정 `VALIDATION`.
- **P7 — `AdapterStatus` 는 `provider` 판별 유니온**(`{ provider: "openclaw", gateway, bridge }` | `{ provider: "claude", runners: { connected, tokens } }`). wire `adapter.status` 는 어댑터마다 따로 나가고, 웹의 연결 점·배너는 `openclaw` 만 본다.
- **P8 — usage 이벤트 이름은 `dodok.usage`**, `RunUsage.costKind?: "api" | "subscription_estimate"`. 운영 요약이 토큰·금액을 더하는 제공자는 **붙은 어댑터 ∩ 에이전트가 등록된 제공자 ∩ `USAGE_TRUSTED_PROVIDERS`(`claude`)** 다 — 러너 어댑터는 모든 배포에 붙으므로 「붙음」만으로 가르면 OpenClaw 만 쓰는 배포에서 「측정 불가」가 사라진다.
- **P9 — 에이전트 등록은 서버에서 목록 검사를 하지 않는다**(2장 「붙은 러너가 알린 에이전트 중에서만」은 웹이 `GET /agents/discover?provider=claude` 목록으로 고르게 하는 것). `POST /agents` 의 `provider` 는 `"openclaw" | "claude"`, `discover` 의 모르는 `provider` 는 400, claude 어댑터가 없으면 503 `ADAPTER_UNAVAILABLE`. 웹의 트리거 이름은 「에이전트 가져오기」.
- **P10 — `BridgeAuthGuard` 는 shared 로 옮겼다**(가져오는 것이 없는 순수 클래스). `/bridge`·`/runner` 핸드셰이크와 두 첨부 HTTP 가 **한 카운터**를 쓰고, 운영 사건 `bridge_auth_blocked` 의 `detail.path`(`"bridge"`|`"runner"`)로 가른다(key 는 그대로 `bridge`).
- **서버는 OpenClaw 어댑터 없이는 부팅하지 않는다** — 설정 마법사·운영 Gateway 줄·Gateway 감시가 OpenClaw 어댑터를 전제한다. OpenClaw 없는 배포는 범위 밖. 어댑터가 없는 `provider` 의 에이전트 런은 만들자마자 `ADAPTER_UNAVAILABLE` 로 닫고 「다시 실행」을 붙인다.

**런의 끝과 중지(조율자 판정 R1)**

- **러너는 수명 이벤트를 `run.event` 로 내지 않는다.** 어댑터가 `run.event` 를 허용 목록(TEXT_MESSAGE_*·TOOL_CALL_*·STEP_*·CUSTOM — CUSTOM 중 `dodok.usage`·`openclaw.usage` 는 막음)으로 거르고 `event.runId` 를 바깥 `runId` 와 대조한다. 그래서 4.3 의 「`interrupt()` 로 끝난 턴은 `RUN_ABORTED`」는 **`run.final { text: "", stopReason: "aborted" }`** 로, 「`result` 의 `error_*` 는 `RUN_ERROR`」는 **`run.error`** 로 알린다. 어댑터는 `stopReason: "aborted"` 이거나 서버가 abort 한 런이면 메시지 없이 `RUN_ABORTED { by: "user" }` + 종료 신호를 낸다. 러너를 끄느라 멈춘 턴은 `stopReason: "runner_shutdown"`(shared `RUNNER_SHUTDOWN_STOP_REASON`)이고, 서버가 abort 하지 않은 런이면 어댑터가 러너가 끊긴 런과 같이 `ADAPTER_UNAVAILABLE` 로 닫는다. 중지한 런의 `outbound.post` 는 `FORBIDDEN`(최종 답도 올리지 않는 런에 중간 글만 올라가지 않게).
- 최종 답은 `dodok.usage` → 정본 저장(outboundId `runner-final:<runId>`, 트리거에 `replyTo`) → 종료 신호 순이다 — 정본이 먼저 있어 곧바로 `done`. 빈 답은 메시지 없이 끝난다. `TOOL_CALL_END` 는 입력 블록이 닫힌 것뿐이라 오케스트레이터의 `tool_end` 신호는 `TOOL_CALL_RESULT` 에서 낸다. `TOOL_CALL_ARGS` 는 경로를 가리려고 델타마다가 아니라 도구 블록이 끝날 때 한 번에 낸다.
- ack 를 기다리는 중에 러너가 끊기면 `send` 가 15초를 기다리지 않고 닫는다. 설정에 없는 에이전트·같은 세션 겹침은 ack `dispatch` 뒤 `run.error`(`NOT_FOUND`·`CONFLICT`).
- **러너 대기열에 선 런은 `queuedMs`(120초)로 닫지 않는다.** ack 에 `queuedPosition` 이 있으면 어댑터가 `send` 결과에 `queued: true`(`AdapterSendResult` — 브리지 wire 의 `InboundDeliverResult` 에는 없다)를 싣고, 오케스트레이터는 그 런을 런 상한(`runMs`)으로 잰다 — 앞 런이 몇 분 도는 것이 흔해서다. 시작하면 런 상한이 새로 걸린다. 러너가 끊기거나 토큰이 폐기되면 어댑터가 `ADAPTER_UNAVAILABLE` 로 닫는다.
- **최종 답은 어댑터가 10만 자(UTF-16, 코드 포인트 경계) 안으로 자르고 `(길어서 잘렸습니다)` 를 붙인다** — `RunnerRunFinal.text` 에는 상한이 없고, 넘치면 정본 저장과 스냅숏이 같은 글로 실패해 답이 조용히 사라진다. 러너가 아니라 어댑터에서 자르는 까닭은 어느 판본의 러너가 붙어도 막히게 하려는 것이다. 멘션 토큰화(`@핸들` → `<@a:…>`)로 늘어나는 몫은 따지지 않는다.
- **`dodok.usage` 는 비용·토큰 중 하나라도 있을 때만 낸다** — 러너가 CLI 를 띄우기 전에 멈춘 런(대기열째 중지)의 final 은 `costKind` 만 기본값(`subscription_estimate`)이라, 그대로 내면 API 키 러너 행에 「환산 포함」이 켜진다.

**러너 연결·끊김(조율자 판정 R4·M4, 러너 태스크의 달라진 것)**

- **3장 `hello.reject` 의 거절 코드는 `PROTOCOL_MISMATCH` 하나다**(`RunnerHelloResult`). 토큰 틀림 `UNAUTHORIZED`·가드 차단 `RATE_LIMITED` 는 hello 가 아니라 핸드셰이크 미들웨어가 `connect_error` 로 거절한다(브리지는 둘 다 `UNAUTHORIZED`). 러너는 `PROTOCOL_MISMATCH`·`UNAUTHORIZED` 면 끝나고, `RATE_LIMITED`(풀리는 차단)와 계약 밖의 hello 응답은 끝내지 않고 백오프로 다시 붙는다.
- **4.5 의 「서버 연결이 끊기면 재접속」은 전송 끊김(transport close·ping timeout — 서버 재시작·네트워크·덮개)만이다.** 서버가 스스로 끊은 연결(`io server disconnect` — 같은 토큰의 새 러너, 토큰 폐기)이면 러너는 사유를 찍고 종료 코드 2 로 끝난다 — 같은 토큰의 두 러너가 서로를 끝없이 밀어내지 않게. 그래서 **R4**: 러너 어댑터는 서버 종료·hello 타임아웃에는 전송만 닫아(러너가 다시 붙는다) 교체·폐기만 `disconnect(true)` 로 끊는다. 대가: 러너 쪽에서는 교체와 폐기를 가르지 못한다(문구 하나).
- **같은 토큰 교체는 hello 때**다 — 뒤 연결의 hello 가 실패하면 앞 연결이 산다. **M4**: 교체된 러너는 옛 러너의 자리(에이전트 배정 순서)를 잇는다 — 순간 재접속 한 번에 충돌해 있던 다른 러너로 에이전트가 넘어가(세션 전사가 없는 머신) 맥락이 끊기지 않게. 5장 「먼저 러너가 끊기면 뒤가 이어받는다」는 교체가 아닌 끊김에만 선다.
- **러너를 SIGINT·SIGTERM 으로 끄면** 도는 런마다 `interrupt()` 를 걸고 `run.final { stopReason: "runner_shutdown" }` 을 낼 때까지 최대 5초 기다린 뒤 끊는다 — 그 런은 서버에서 사람 중지가 아니라 `ADAPTER_UNAVAILABLE` 오류로 닫히고, 트리거가 있으면 채널 run_error 카드에 「다시 실행」이 붙는다(채널의 사람이 러너가 꺼진 줄 안다). 대기열의 런도 같다. 사람이 먼저 중지한 런(`run.abort`)은 러너가 꺼지며 닫아도 중지 그대로다. 러너는 중지 `AbortSignal` 의 `reason` 으로 둘을 가른다(`scheduler.abortAll(reason)`). 두 번째 신호는 기다리지 않는다.
- **러너가 스스로 끝나는 경로(서버가 끊음·`UNAUTHORIZED`·hello 거절)도 같은 유예를 쓴다** — 도는 런에 `interrupt()` 를 걸고 끝날 때까지 최대 5초 기다린 뒤 종료 코드 2. 곧바로 끝나면 interrupt 가 CLI 에 닿기 전에 러너가 끝나 CLI 가 고아로 남아 그 턴을 이어 간다(토큰 폐기 뒤에도 미리 허용된 도구가 돈다). 서버는 그 런을 이미 닫았으므로 이때의 final 은 버려진다.
- **`runner_down`**(5장)은 `watchConnections` 가 아니라 `watchRunners` 가 맡는다 — 규칙은 **이 서버 프로세스에서 붙은 적 있는 토큰**이 `DISCONNECT_EVENT_MS`(60초) 넘게 끊기면 열고(key 토큰 id), 붙으면 닫는다(앞 프로세스가 연 줄도). 끊긴 사이 폐기되면 남기지 않는다. 서버 재시작 뒤 한 번도 안 붙은 토큰은 사건이 없다.
- **R3 — 러너 어댑터 `supports(agentId, cap)`** 는 그 에이전트를 가진 붙은 러너가 있고 그 러너가 `cap` 을 알리지 않았을 때만 false 다. 러너가 없으면 true — `send` 가 `ADAPTER_UNAVAILABLE` 로 닫게(없음이 `PLUGIN_OUTDATED` 문구로 닫혀 원인을 잘못 가리키지 않게).
- 연결 세대 — 끊긴 연결에서 시작한 런의 이벤트는 다시 붙은 연결로 보내지 않는다(서버는 그 런을 이미 닫았다). 재접속은 socket.io-client 옵션이 아니라 러너가 직접 백오프(1초~30초)한다.

**에이전트 id(조율자 판정 R2)** — 같은 워크스페이스에서 `providerAgentId` 는 **제공자를 가로질러** 유일하다(대소문자 무시). 등록이 다른 제공자의 같은 id 를 409 로 막고 웹은 고정 문구 「이미 등록된 id 입니다 — 다른 제공자의 에이전트도 같은 id 를 쓸 수 없습니다」. 까닭: 세션 키(`dodokSessionKey`)에 제공자가 없어 세션 큐·승인 상관이 섞인다. 러너 설정의 id 는 `isRegistrableAgentId`(소문자)로 검사한다.

**러너 — 설정·옵션·경로 가림**

- **env 허용 목록**(4.2)에 프록시(`HTTPS_PROXY`·`HTTP_PROXY`·`NO_PROXY` 대·소문자)·`NODE_EXTRA_CA_CERTS`·`SSL_CERT_FILE` 을 더했다 — 사내 프록시·사설 CA 뒤에서 CLI 가 API 에 닿으려면 필요하고 비밀이 아니다(프록시 URL 에 자격을 넣은 설정이면 그 자격도 CLI 로 간다). `ANTHROPIC_*` 는 넘기지 않는다.
- **`costKind` 는 `accountInfo` 가 아니라 `system/init` 의 `apiKeySource`** 로 가른다(3장). `accountInfo()` 는 CLI 를 띄워야 부를 수 있다. `ANTHROPIC_API_KEY`·`apiKeyHelper`·`/login managed key` 면 `api`, 그 밖(`none` — claude.ai 로그인)이면 `subscription_estimate`, init 을 못 봤으면 `subscription_estimate`.
- **`alwaysLoad`** 는 서버 설정 필드가 아니라 `createSdkMcpServer({ alwaysLoad: true })` 가 도구마다 `_meta` 로 싣는다(SDK 0.3.283). SDK import 는 `packages/claude-runner/src/sdk.ts` 한 파일이다.
- **답 글도 가린다.** 러너는 델타·최종 답·`post` 의 `text`·카드 안 글·도구 인자·도구 결과·오류 문구에서 작업 디렉터리 경로를 상대 경로로, 밖을 `<작업 디렉터리 밖>` 으로 바꾼다(`mask.ts`). 델타는 공백 경계로 쥐었다 내므로 공백 없이 긴 글은 늦게 보인다. 가린 표지가 원문보다 길어 카드 스키마를 넘기면 보내지 않고 도구 결과로 알린다.
- 설정 스키마는 strict(모르는 키·본문 `token` 거절), `serverUrl` 은 http/https 만, 같은 에이전트 id 둘은 거절, `tokenFile` 을 적었는데 못 읽으면 env 로 넘어가지 않는다. `@dodok/shared` 는 번들에 들어가므로 러너 `devDependencies`. 번들 해시는 굽지 않고 런타임에 번들 파일을 읽어 잰다.
- hello `capabilities` 는 `threads`·`interrupt`·`approvals`·`attachments`.
- **러너는 `AskUserQuestion`·`PushNotification` 과 예약·원격 실행 도구(`ScheduleWakeup`·`CronCreate`·`CronDelete`·`CronList`·`RemoteTrigger`)를 늘 막는다**(`RUNNER_DISALLOWED_TOOLS`, 설정의 `disallowedTools` 와 합침). 앞의 둘은 채널이 아니라 러너 머신에 묻거나 알리고(`AskUserQuestion` 은 승인 카드로 뜨고 허용해도 답이 없다), 예약 도구는 턴이 끝난 뒤에 돌아 결과가 채널에 닿지 않는다. 계획 모드 도구는 `permissionMode: "plan"` 이 쓰므로 두고, `Monitor`·`Agent`·`Skill` 도 둔다.

**`mcp__dodok__post`·첨부(조율자 판정 R5, 러너 태스크의 달라진 것)**

- **`files` 는 작업 디렉터리 안을 가리키는 절대 경로도 받는다**(4.4 「상대 경로만」의 글자와 다름) — CLI 의 파일 도구가 절대 경로를 써서 모델도 그렇게 줄 공산이 크다. 경계는 같다(글자 + `realpath`).
- **파일 경계는 경로 기준이고 파일 보내기는 macOS·Linux 만이다.** 모든 파일을 검사한 뒤 올리기 직전에 한 번에 열고, 연 fd 가 `realpath` 그대로의 경로(어느 성분도 링크가 아님)에서 열렸는지 macOS 는 `O_NOFOLLOW_ANY`, Linux 는 `/proc/self/fd` 로 보고 dev·ino 를 대조한다. 둘 다 없는 플랫폼은 `files` 를 거절한다(카드·글은 된다). 하드 링크·복사는 막지 않는다. 하나라도 거절이면 아무것도 올리지 않는다.
- `outbound.post` 의 `outboundId` 는 `runner-post:<uuid>` — 계약(`RunnerOutboundPost`)이 접두사 `RUNNER_POST_ID_PREFIX` 를 강제하고 아니면 `VALIDATION`(최종 답 `runner-final:<runId>` 를 먼저 써서 막거나 다른 메시지의 `external_id` 로 그 id 를 돌려받지 못하게). 채널·에이전트·세션·스레드·런은 `run.start.deliver` 그대로 — 어댑터가 열린 런과 대조해 다른 채널·남의 런이면 `FORBIDDEN`. 파일 MIME 힌트는 서버가 힌트를 받는 글 종류(`.txt`·`.md`·`.log`·`.json`·`.csv`·`.zip`)만.
- **R5 — 러너 토큰의 첨부 GET 은 그 러너에 열린 런의 트리거 첨부와 그 토큰이 올린 첨부만** 읽는다(나머지는 없는 id 와 같은 404). 러너는 사람 머신이라 브리지보다 신뢰가 한 단계 낮다. 러너가 올린 파일은 업로더 `bridge` + `uploader_id` = 토큰 id 로 남는다. 대가: 런이 끝난 뒤에는 그 런의 첨부를 다시 못 받는다(러너는 런 중에만 받는다).
- 이미지는 글보다 앞에 두고(Messages API 권고), 못 받은 장(5 MiB 초과·SVG·서버 첨부가 아닌 URL 포함)은 빼고 본문 끝에 「첨부 이미지 N장을 불러오지 못했습니다」. 10장 상한을 러너도 지킨다.

**승인(6장 구체화)**

- 서버 쪽 승인 id 는 `runner:<토큰 id>:<러너 id>` — `providerApprovalId` 유일 인덱스가 제공자를 가리지 않아 러너가 고른 id 가 다른 행을 덮지 않게. 러너에 보내는 `approval.resolve` 는 원래 id. 심각도는 `warning`.
- 철회(런 중지·러너 끊김)는 `status: "cancelled", reason: "run-aborted"`, 기한 만료만 `expired`+`deny`+`timeout`. 런이 끝나면 남은 승인을 `cancelled` 로 닫는다.
- 러너는 CLI 의 취소 요청이 없어도 런 signal 로 카드를 거둔다(CLI 가 늦거나 반응하지 않을 때 승인 대기에 매달리지 않게). `suppressAlwaysAllowRule` 이면 「항상 허용」을 내지 않는다.
- 요약(6장)은 400자에서 앞·뒤를 남기고 가운데를 생략 표시로 줄이고(JSON 은 200자), 제어·양방향 서식·보이지 않는 폭 글자(Cc·Cf(ZWJ 제외)·Zl·Zp·공백 아닌 Zs·한글 채움·점자 빈칸)를 `\u{…}` 로, 줄바꿈을 `⏎` 로 보인다 — 명령 꼬리를 줄·폭으로 숨기지 못하게. 도구에 넘기는 입력은 바뀌지 않는다. 웹 카드는 요약을 줄바꿈·`break-all` 로 그린다.

**드러나는 것(5장)** — 연결 페이지 러너 블록과 `docs/guides/deploy.md` 「Claude 러너 설치」 절의 「드러나는 것」은 **셋**이다. 셋째: 러너 토큰 하나로 워크스페이스의 모든 Claude 러너 에이전트 id 를 맡을 수 있다(에이전트는 토큰에 묶이지 않고 먼저 알린 러너가 맡는다) — 토큰은 믿는 머신에만 준다.

**웹·운영(7장 구체화)**

- 운영 런 표의 구독 환산 꼬리표는 **「환산 포함」**이다(7장의 「환산값」) — 같은 합에 api 청구분이 섞일 수 있어 합 전체를 환산값이라 부르지 않는다(`OpsRunsRow.costEstimated`). 믿는 런만 더한 행은 **「런 m/n개만」**(서버 `measuredRuns`), 믿는 런이 없는 행은 「측정 불가」. 행에 제공자 칸은 없다.
- 운영 화면 상태 카드의 러너 줄은 「<n>대 붙음 / 토큰 <m>개」이고 강조하지 않는다(러너는 사람 PC 라 꺼져 있을 수 있다 — 60초 넘는 끊김은 `runner_down`).
- 러너 토큰 발급 결과 `IssueRunnerTokenResult` 에 `runnerConfig { serverUrl, tokenFile }` — `serverUrl` 은 `BRIDGE_PUBLIC_URL`(없으면 `APP_ORIGIN`)의 오리진. 설치 명령은 `npm install -g ./dodok-claude-runner-<sha 12자>.tgz`.
- 8장 `PROVIDER_AUTH` 의 「러너의 Claude 로그인을 확인하세요」는 채널 run_error 카드(「@<에이전트> 실행이 실패했습니다: 러너의 Claude 로그인을 확인하세요」 — 오케스트레이터 `runErrorBody`, 알리는 코드 `NOTIFY_CODES`)와 활동 탭 런 오류 문구 둘 다에 있다. 카드에는 트리거가 있으면 「다시 실행」이 붙는다 — 러너 머신에서 다시 로그인한 뒤 누른다.
- **10장 완료 기준 2 의 뒷부분(「규칙을 바꾸면 다음 런부터 새 규칙을 따른다」)은 새 세션으로 선다** — 이어 가는 세션의 모델은 바뀐 규칙이 실려도 세션 이력 속 자기 앞 답의 형식을 따른다(ADR 0007 「규칙이 바뀐 뒤 이어 간 세션」 절). 그래서 서버는 `serverSessionIds` 어댑터의 세션을 디스패치할 때 채널 `promptRevision` 이 세션 행 `promptRevisionAtStart` 와 다르면 「새 대화」처럼 `providerSessionId` 를 비우고 리비전을 맞춘 뒤(`apps/server/src/modules/sessions/service.ts` 의 `renewSessionOnPromptChange`) 그 자리(스레드면 스레드)에 info 「채널 규칙이 바뀌어 @<핸들> 의 대화를 새로 시작했습니다」를 한 번 남긴다. 새 열은 없다 — 스레드 세션 행은 행마다, 같은 세션의 런은 세션 큐가 하나씩 보내므로 한 리비전 변화에 한 번. 리비전은 채널 하나라 한 에이전트의 채널 지시만 바뀌어도 그 채널의 모든 러너 세션이 새로 시작한다. OpenClaw 세션은 그대로 `needsPromptContext` 경로다.
