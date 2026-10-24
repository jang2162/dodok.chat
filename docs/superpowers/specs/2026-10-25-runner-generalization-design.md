# 러너 일반화 설계 (하위 프로젝트 C)

**상태**: 확정(2026-10-25, 사용자 승인).
**범위**: 사람 머신에 까는 러너(`dodok-runner`)가 Claude Code 하나가 아니라 여러 프로그램(Claude Code·Codex·OpenCode …)을 돌릴 수 있게 하고, 그 머신의 **프로젝트 경로와 에이전트를 dodok 앱에서** 더한다. 프로젝트마다 그 러너가 지원하는 프로그램을 골라 이름·프롬프트를 정해 에이전트를 만든다. 이번 구현은 Claude Code 드라이버 하나, 다른 프로그램은 같은 자리에 꽂는 후속이다.

**앞선 근거**:
- 로드맵 `docs/superpowers/specs/2026-10-25-sessions-dm-runner-roadmap.md` 결정 1·2·6
- 지금 러너: `docs/superpowers/specs/2026-09-27-claude-runner-design.md` 와 그 「구현과 맞춘 것」 장(P1~P10·R1~R5·M4) — 이 스펙이 바꾸지 않는 것(`/runner` 프레임·승인·`mcp__dodok__post`·경로 가림·env 허용 목록·끊김 규칙)은 거기 그대로다
- ADR `docs/adr/0007-claude-agent-sdk-spike.md`

---

## 0. 결정

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **에이전트·프로젝트의 정본은 서버 DB 다.** 러너의 로컬 설정에서 `agents` 를 걷는다 | 사용자 요청 — 앱에서 더한다. |
| 2 | **러너의 로컬 설정은 「천장」만 쥔다** — 허용 루트(`roots`), 프로그램별 켜기·로그인 디렉터리·권한 상한·늘 막는 도구, 동시 실행 수 | 러너 스펙 결정 5·로드맵 결정 6. 앱이 정한 것이 천장을 넘으면 러너가 런을 거절한다. |
| 3 | **호스트 경로는 서버에 가지 않는다** — 프로젝트는 `(rootId, relPath)` 로 저장하고, 러너가 hello 로 알리는 루트는 `{ id, label }` 뿐 | 지금 원칙(「호스트 경로는 어떤 텍스트에도 쓰지 않는다」)을 앱 구성에도 지킨다. 서버·DB·로그가 사람 머신의 사용자 이름·디렉터리 구조를 갖지 않는다. |
| 4 | **러너는 무상태다 — `run.start` 가 에이전트 정의를 통째로 싣고 러너가 매번 천장 검사** | 서버와 러너 사이 설정 동기화가 없으면 동기화가 어긋나는 상태도 없다. 설정을 바꾸면 다음 런부터 맞다. |
| 5 | **프로그램은 러너 안의 드라이버로 꽂는다** — 드라이버 계약 하나(4장), 이번에는 `claude` 만 | 사용자 요청(「이후 다른 프로그램 추가를 고려」). |
| 6 | **제공자는 `openclaw` · `runner` 둘** — 러너 에이전트의 프로그램은 `agents.program`. 옛 `claude`·`codex`·`hermes` 값은 걷는다 | 서버의 어댑터는 연결 방식(Gateway / 러너)으로 갈리고 프로그램은 러너 안 일이다. 운영 비용 집계·`USAGE_TRUSTED_PROVIDERS` 는 프로그램으로 가른다. |
| 7 | **러너 토큰 발급은 owner(지금 그대로), 러너의 프로젝트·에이전트 관리는 admin 이상** (설계자 판단) | 머신을 들이는 결정은 owner, 그 안에서 일을 나누는 것은 지금 에이전트 등록 권한(admin 이상)과 같게. 멤버가 자기 머신을 개인 러너로 붙이는 것은 하지 않는다(11장). |

## 1. 범위

**한다**
- 러너 로컬 설정을 천장으로 바꾸기(`agents` 걷음, `roots`·`programs` 더함)
- hello 에 루트·프로그램 목록(설치 여부·판본·로그인 상태), 디렉터리 둘러보기·프로젝트 확인 요청
- 드라이버 계약과 `claude` 드라이버(지금 `run.ts`·`sdk.ts`·`stream-map.ts`·`approvals.ts` 를 그 뒤로 옮김)
- 서버: `runner_projects`, 러너 에이전트 열(프로젝트·프로그램·모델·권한·도구·프롬프트), `run.start` 의 에이전트 정의, 제공자 `runner`
- 웹: 설정 → 「러너」 탭(러너·프로젝트·에이전트), 에이전트 추가 흐름에서 러너 고르기
- 에이전트 프롬프트(`basePrompt`)가 러너 에이전트에게 실제로 닿는다
- `dev:fake` 가짜 러너, 런 0회 하네스, 문서(`docs/guides/docker-deploy.md` 「Claude 러너 설치」 → 「러너 설치」, `docs/guides/agent-guide.md`, `docs/manual/user-guide.md`)

**하지 않는다**
- Codex·OpenCode 드라이버(각자 스파이크 → 스펙 — 11장), 러너를 OS 서비스로, 개인 러너
- 앱에서 러너 천장(루트·권한 상한)을 바꾸기 — 천장은 머신 주인이 그 머신에서만 고친다
- 프로젝트 디렉터리 만들기·git clone(앱이 머신에 디렉터리를 만들지 않는다)

## 2. 러너 로컬 설정 (천장)

```json
{
  "serverUrl": "https://chat.example.com",
  "tokenFile": "~/.dodok-runner/token",
  "maxConcurrentRuns": 3,
  "roots": [
    { "id": "src", "path": "~/src", "label": "내 저장소들" }
  ],
  "browse": true,
  "programs": {
    "claude": {
      "configDir": "~/.dodok-runner/claude",
      "maxPermissionMode": "acceptEdits",
      "disallowedTools": [],
      "allowedToolsCeiling": null
    }
  }
}
```

- `roots[].id` 는 `[a-z0-9-]{1,32}`, 러너 안에서 유일하고 **바꾸면 그 루트의 프로젝트가 모두 「루트 없음」이 된다**(설정 화면·문서에 적는다). `path` 는 존재하는 디렉터리, `realpath` 로 저장해 쓴다.
- `programs` 에 없는 프로그램은 꺼진 것이다. 권한 모드는 지금 러너가 받는 넷(`plan`·`dontAsk`·`default`·`acceptEdits`)이고, `maxPermissionMode` 의 순서는 「묻지 않고 돌 수 있는 것이 많은 순」 `plan` < `dontAsk` < `default` < `acceptEdits` 다(설계자 판단 — `dontAsk` 는 미리 허용한 것만 돌고 나머지는 묻지 않고 거절하므로 `default` 보다 아래). **`bypassPermissions` 는 열지 않는다** — 승인 카드가 아예 뜨지 않아 「쓰기 도구는 승인 카드」 원칙이 깨진다. `allowedToolsCeiling` 이 배열이면 앱의 `allowedTools` 는 그 부분집합이어야 한다(null 이면 상한 없음 — 그래도 `permissionMode` 와 승인이 남는다). `disallowedTools` 는 늘 더한다(지금 `RUNNER_DISALLOWED_TOOLS` 와 합침).
- `browse: false` 면 디렉터리 둘러보기를 거절한다(경로를 직접 적어 프로젝트를 더하는 것은 된다).
- 스키마는 지금처럼 strict — 옛 `agents` 키가 있으면 「에이전트는 이제 앱에서 만듭니다」 문구와 함께 거절하고 끝난다.

## 3. `/runner` 계약 — 바뀌는 것

| 방향 | 프레임 | 내용 |
| --- | --- | --- |
| 러너 → 서버 | `hello` | `agents` 를 걷고 `roots: { id, label }[]`, `browse: boolean`, `programs: { program, available, version?, auth: "ok" \| "missing" \| "unknown", reason?, capabilities: string[], ceiling: { maxPermissionMode, allowedToolsCeiling: string[] \| null } }[]` |
| 서버 → 러너 | `fs.list` (ack) | `{ rootId, relPath }` → `{ entries: { name, isGitRepo }[], truncated }` — 디렉터리만, 숨김(`.` 시작) 제외, 500개, 심볼릭 링크로 루트 밖이면 뺀다 |
| 서버 → 러너 | `project.check` (ack) | `{ rootId, relPath }` → `{ ok: true, isGitRepo } \| { ok: false, reason: "root_missing" \| "not_found" \| "not_directory" \| "outside_root" }` |
| 서버 → 러너 | `run.start` | 지금 것 + `agent: { program, project: { rootId, relPath }, model?, permissionMode, allowedTools, disallowedTools, instructions? }` — `instructions` 는 에이전트 프롬프트(`basePrompt`) |
| 러너 → 서버 | `run.session` | `{ runId, providerSessionId }` — 프로그램이 세션 id 를 스스로 짓는 드라이버만(4장). 서버가 세션 행에 저장 |

- 러너는 `run.start` 마다 천장 검사를 한다: 루트가 있고, `relPath` 가 `realpath` 로 루트 안의 디렉터리이고, 프로그램이 켜져 있고 쓸 수 있고, `permissionMode ≤ maxPermissionMode`, `allowedTools ⊆ allowedToolsCeiling`. 하나라도 어긋나면 ack `dispatch` 뒤 `run.error { code: "RUNNER_CEILING", message: <어긋난 항목 이름> }` — 새 `ErrorCode`, 카드 문구 「러너 설정이 이 에이전트를 허용하지 않습니다(<항목>) — 러너 머신의 설정을 확인하세요」. 「다시 실행」을 붙인다.
- `relPath` 는 `/` 구분 상대 경로, `..`·빈 성분·NUL 이면 서버·러너 둘 다 `VALIDATION`.
- 러너 `hello` 의 `runnerProtocol` 을 2 로 올린다(옛 러너는 `PROTOCOL_MISMATCH` — 로드맵 결정 1).

## 4. 드라이버 계약 (러너 안)

```ts
interface ProgramDriver {
  program: "claude" | "codex" | "opencode";
  detect(ceilingCfg): Promise<{ available; version?; auth; reason?; capabilities }>;
  capabilities: {
    serverSessionIds: boolean; // 서버가 정한 UUID 로 세션을 열 수 있나(claude: 예)
    approvals: boolean;        // 도구 승인을 dodok 에 물을 수 있나
    images: boolean; interrupt: boolean; mcpTools: boolean; costs: boolean;
  };
  startRun(spec: RunSpec, sink: RunSink, signal: AbortSignal): Promise<void>;
}
```

- `RunSpec` = 작업 디렉터리(풀린 절대 경로 — 러너 안에서만), 세션(`providerSessionId?`), 프롬프트·이미지, 채널 규칙 틀(`channelRulesAppend`)·턴 사실·에이전트 지시, 권한·도구, dodok 도구 목록(`post` + 제어 도구).
- `RunSink` 는 지금 `/runner` 프레임(`run.event`·`run.final`·`run.error`·`approval.*`·`outbound.post`·`run.session`)으로 내보내는 한 자리 — 경로 가림(`mask.ts`)은 sink 가 맡아 드라이버마다 다시 짜지 않는다.
- 서버는 hello 의 프로그램 `capabilities` 로 런 전에 가른다: `approvals` 가 없는 프로그램의 에이전트는 등록 화면이 「도구 승인 카드를 띄울 수 없습니다 — 권한 모드를 plan 으로만」처럼 막는다(드라이버가 생길 때 그 스펙이 정한다). 이번 `claude` 드라이버는 모두 예다.
- `serverSessionIds` 가 없는 드라이버는 첫 런의 `run.session` 으로 세션 id 를 알린다. 서버 오케스트레이터의 `serverSessionIds` 분기(러너 스펙 P4)는 에이전트의 프로그램 능력으로 정한다.
- 에이전트 지시(`instructions`)는 채널 규칙 틀 앞의 `<agent-instructions>` 틀로 `systemPrompt.append` 에 싣는다 — 틀·이스케이프 규칙은 `buildChannelRulesAppend` 와 같은 함수 계열(shared). 지시가 바뀌면 다음 런에 실린다(이어 가는 세션이 옛 형식을 따르는 문제 — ADR 0007 — 는 채널 규칙과 같으므로 리비전에 에이전트 지시 변경도 넣는다: `renewSessionOnPromptChange` 가 에이전트 `instructions_revision` 도 본다).

## 5. 서버 데이터

- `runner_tokens` 가 곧 러너다(토큰 하나 = 러너 하나 — 지금 규칙). `label` 은 머신 이름.
- 새 `runner_projects`: `id`, `runner_token_id`, `root_id`, `rel_path`, `label`(기본 마지막 성분), `created_by`, `created_at`, `archived_at`. 유일 `(runner_token_id, root_id, rel_path) WHERE archived_at IS NULL`.
- `agents` — 제공자 `runner` 면 `runner_token_id`·`runner_project_id`·`program` NOT NULL, 그리고 `model`·`permission_mode`·`allowed_tools_json`·`disallowed_tools_json`·`instructions_revision`. `providerAgentId` 는 서버가 짓는다(`r-` + 소문자 hex 10 — 세션 키 규칙 안, 워크스페이스에서 유일). 핸들·이름은 사람이 정한다.
- 지금의 「알린 에이전트 중에서 가져오기」(`GET /agents/discover?provider=claude`)·에이전트 id 충돌 표시·「이 러너로 묶기」는 걷는다 — 에이전트는 처음부터 러너에 묶인다.
- **토큰 교체·폐기** (설계자 판단 — 러너의 정체는 `runner_tokens` 행 id 이고 토큰 원문은 갈아 끼우는 자격일 뿐이다):
  - 「토큰 다시 발급」(owner): 같은 행의 해시·접두사만 바꾼다. 옛 토큰은 곧바로 안 통하고 그 연결을 끊는다(지금 폐기와 같은 끊김 — 러너는 종료 2). 프로젝트·에이전트는 그대로 그 러너에 남는다. 머신에 새 토큰을 넣고 다시 띄우면 이어진다.
  - 「러너 폐기」: 행에 `revoked_at`. 그 러너의 프로젝트·에이전트는 남지만 런은 `ADAPTER_UNAVAILABLE`.
  - 「다른 러너로 옮기기」(admin 이상, 프로젝트 단위): 옮길 러너가 붙어 있고 같은 `rootId`·`relPath` 가 `project.check` 를 통과할 때만. 프로젝트의 에이전트가 함께 옮겨 가고 에이전트 세션의 `providerSessionId` 는 비운다(세션 전사는 옛 머신에 있다 — 다음 런은 새 세션).
- **마이그레이션** (로드맵 결정 1): 서버는 기존 `provider = 'claude'` 에이전트의 작업 디렉터리를 모른다(러너 로컬 설정에만 있었다). 그래서 그 행은 `provider = 'runner'`·`program = 'claude'`·프로젝트 없음으로 바꾸고 **보관한다** — 메시지·런의 작성자로 남고, 화면은 「프로젝트가 없어 되살릴 수 없습니다 — 새로 만드세요」. 그래서 프로젝트 열은 DB 에서 nullable, 「보관되지 않은 러너 에이전트는 프로젝트가 있다」는 서비스가 지킨다. `dev:fake` 의 `coder` 는 시작 때 새 흐름(가짜 러너의 프로젝트 + 에이전트)으로 만든다.
- 연결 상태(붙음·hello 내용)는 메모리에만. 러너가 끊겨 있으면 그 러너의 프로젝트·에이전트 화면은 「마지막으로 알린」 내용 없이 「끊김」만 보인다(서버 재시작 뒤에도 같다).

## 6. 권한

| 하는 일 | 누가 |
| --- | --- |
| 러너 토큰 발급·폐기 | owner |
| 러너 목록·상태·프로그램·루트 보기 | admin 이상 |
| 디렉터리 둘러보기, 프로젝트 더하기·이름 바꾸기·보관 | admin 이상 |
| 러너 에이전트 만들기·고치기(프로그램·모델·권한·도구·지시)·보관 | admin 이상 |
| 러너 에이전트 도구 승인 | 채널: admin 이상(지금 그대로) · DM: DM 주인(스펙 B) |

- 둘러보기는 레이트리밋(사용자당 분당 60 — `LIMITS` 에)과 운영 로그 한 줄(누가·어느 러너·루트 id, 경로 원문 없음).
- **제어 도구는 러너 구성을 바꾸지 못한다** (설계자 판단 — 보안). 채널 안 에이전트가 확인 카드 하나로 자기 권한을 상한까지 올리는 길을 닫는다:
  - `discover_agents`·`register_agent` 는 OpenClaw 에이전트만 다룬다(러너 에이전트는 웹에서만 만든다 — 「알린 에이전트」가 없어졌다).
  - `update_agent` 는 러너 에이전트의 이름·아바타만 바꾸고 `program`·프로젝트·`model`·`permission_mode`·도구·지시·`dm_access` 는 받지 않는다(`VALIDATION`).
  - `set_agent_enabled`·`archive_agent` 는 지금 그대로.
  - 러너 프로젝트·둘러보기 도구는 두지 않는다.

## 7. 웹

- **설정 → 「러너」 탭**(admin 이상): 러너마다 카드 — 이름·연결 상태·러너 판본·프로그램(설치·판본·로그인 상태·권한 상한)·루트 라벨. 카드 안에 프로젝트 목록(라벨·`루트 라벨/relPath`·git 여부·에이전트 수·「확인」 결과), 「프로젝트 추가」 — 루트 고르기 → 디렉터리 둘러보기(빵 부스러기·git 표시) 또는 상대 경로 직접 입력 → `project.check` 결과를 보고 저장.
- **에이전트 추가**(지금 「에이전트 가져오기」 자리, 제공자 고르기에서 「러너」): 러너 → 프로젝트 → 프로그램(그 러너에 켜져 있고 쓸 수 있는 것만, 못 쓰는 것은 사유와 함께 흐리게) → 이름·핸들·모델·권한 모드(상한까지만 고를 수 있음)·허용 도구·지시·DM 허용(스펙 B — B 보다 먼저 구현하면 이 칸과 6장의 DM 줄은 빼고 B 가 더한다). 러너가 끊겨 있으면 만들 수 없다(프로그램 목록이 없다).
- 연결 페이지(owner)의 러너 블록은 토큰 발급·폐기·설치 안내만 남기고 상태·에이전트는 「러너」 탭으로 옮긴다. 설치 안내에 로컬 설정 예시(`roots`·`programs`)와 「드러나는 것」.
- **드러나는 것**(연결 페이지·설치 문서): 지금 셋(계정 이메일·작업 디렉터리 읽기·토큰 하나가 맡는 범위 — 셋째는 「그 러너의 모든 에이전트」로 바뀐다)에 넷째 — **서버 쪽 admin(과 서버를 손에 넣은 사람)은 루트 안 아무 디렉터리에서, 권한 상한까지의 도구로 에이전트를 돌릴 수 있다. 루트는 좁게, 상한은 낮게 둔다.**

## 8. 오류 처리

| 상황 | 결과 |
| --- | --- |
| 러너가 붙어 있지 않음 | `ADAPTER_UNAVAILABLE`(지금 그대로) |
| 천장 어긋남(루트 없음·경로 탈출·프로그램 꺼짐·권한·도구) | `RUNNER_CEILING` 카드 + 「다시 실행」 |
| 프로그램 로그인 안 됨 | `PROVIDER_AUTH`(지금 그대로, 문구의 「Claude」 는 프로그램 이름으로) |
| `browse: false` 인데 둘러보기 | ack 오류 `FORBIDDEN`, 웹은 「이 러너는 둘러보기를 끄고 있습니다 — 경로를 직접 입력하세요」 |
| 옛 러너(프로토콜 1) | `PROTOCOL_MISMATCH` |
| 프로젝트 보관 | 그 프로젝트의 에이전트를 새로 만들 수 없다. 이미 있는 에이전트는 남고 런은 돈다(프로젝트 보관은 목록 정리일 뿐 — 막으려면 에이전트를 보관) |

## 9. 테스트·검증

- shared: 새 프레임 Zod(`relPath` 거절 꼴 포함), 에이전트 지시 틀 문장 고정.
- runner: 천장 검사 전 항목(루트 없음·`..`·심볼릭 링크 탈출·권한 순서·도구 부분집합·꺼진 프로그램), `fs.list` 의 숨김·링크·500 상한·`browse:false`, 옛 `agents` 키 거절 문구, hello 에 경로 원문이 없음, `claude` 드라이버가 지금 테스트(러너 스펙 9장)를 그대로 통과.
- 서버 단위·통합(가짜 러너): 프로젝트 더하기 → 에이전트 만들기 → 멘션 → 런의 `run.start.agent` 가 DB 대로 · 지시 변경 → 다음 런에 실리고 러너 세션 새로 열림 · `RUNNER_CEILING` → 카드 · 역할 매트릭스(러너 탭 경로) · DB·로그에 호스트 경로가 없음(쓴 값 검사).
- `dev:fake`: 가짜 러너가 루트 둘·프로그램 `claude`(그리고 「설치 안 됨」인 `codex` 한 줄)를 알리고 둘러보기에 고정 디렉터리 나무를 낸다. 브라우저(1280·390px): 러너 탭·둘러보기·에이전트 추가·천장 카드.
- 런 0회 하네스: 실제 러너 설치본 + 번들 CLI + 가짜 Messages API 로 앱에서 만든 에이전트가 그 디렉터리에서 돈다(`cwd`)·지시가 요청 본문의 틀 안에 있다. 모델 런 0.

## 10. 완료 기준

1. 러너 머신의 로컬 설정에 루트만 적고, 앱에서 그 루트 안 디렉터리를 프로젝트로 더해 Claude Code 에이전트를 만들고, 채널에서 멘션하면 그 디렉터리에서 돈다.
2. 앱에서 정한 지시가 그 에이전트에게 닿는다.
3. 루트 밖·상한 넘는 권한·꺼진 프로그램은 러너가 거절하고 채널에 사유 카드가 남는다.
4. 서버 DB·로그·화면 어디에도 러너 머신의 절대 경로가 없다.
5. 전체 테스트·typecheck·lint·fmt·웹 빌드·서버 번들 스모크·러너 pack 통과.

## 11. 열린 문제·후속

- **Codex 드라이버** — 후보는 Codex 의 앱 서버(JSON-RPC, 승인·세션 이어 가기를 IDE 에 내주는 경로)나 TypeScript SDK. 스파이크로 볼 것: 도구 승인을 바깥에 물을 수 있나, 세션 id 를 누가 짓나, 스트리밍 단위, MCP 도구(`post`·제어)를 붙이는 법, 로그인 디렉터리 분리, 비용 값.
- **OpenCode 드라이버** — 후보는 `opencode serve` 의 HTTP·이벤트 스트림과 그 SDK. 같은 질문 + 모델 공급자 키를 어디서 읽는가(env 허용 목록과 부딪힌다).
- 두 프로그램의 위 사실은 이 스펙을 쓰며 확인하지 않았다 — 각 스파이크가 판본을 정확 핀하고 ADR 로 남긴다.
- 개인 러너(member 가 자기 머신을 붙이고 그 러너의 에이전트를 자기만 DM 으로 쓰는 것), 앱에서 디렉터리 만들기·clone, 러너를 OS 서비스로.
