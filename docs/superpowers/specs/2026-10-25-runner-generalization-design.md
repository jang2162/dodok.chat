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

## 구현과 맞춘 것

계획 `docs/superpowers/plans/2026-10-29-runner-generalization.md`(태스크 1~7)를 구현하며 이 스펙과 달라졌거나 스펙이 정하지 않은 것을 정한 자리. 본문은 승인한 설계 그대로 두고 여기에만 적는다. 실물 확인은 `docs/guides/live-smoke.md` 「러너 일반화 실연」 절(모델 런 0회) — 그 절의 CLI `cwd`·절대 경로 기준이 10장 완료 기준 1·4 의 유일한 실물 근거다(통합 시나리오는 가짜 러너라 서버 경계까지만 증명한다).

### 계획 판정

- **PR1 — 에이전트 지시는 서버가 틀을 입힌다.** 3장 표의 `run.start.agent.instructions` 는 싣지 않는다. runner-adapter 가 `buildChannelRulesAppend` 에 `agentInstructions`(= `agents.base_prompt`)를 넘기고, shared 가 채널 규칙 틀 **앞**에 `# dodok agent instructions` 머리와 `<agent-instructions>` 틀을 채널 규칙과 같은 이스케이프(`escapeRuleTags`)로 붙인다. 비었거나 공백뿐이면 틀이 없다. 채널 규칙을 서버가 짓는 구조와 같은 자리라 다음 드라이버도 그대로 받는다. 틀 문장은 지금 「This Claude Code session …」으로 고정이다(다음 드라이버 때 프로그램 이름으로 — `docs/guides/plan.md` 8장 이월).
- **PR2 — 지시 리비전.** `agents.instructions_revision`(`base_prompt` 가 바뀔 때만 +1 — 이름·아바타만 바꾸면 그대로)과 `agent_sessions.instructions_revision_at_start`. `renewSessionOnPromptChange` 는 채널 리비전 **또는** 지시 리비전이 다르면 러너 세션을 새로 연다.
- **PR3 — 프로그램 능력은 hello 의 `programs[].capabilities`**(`serverSessionIds`·`approvals`·`images`·`interrupt`·`mcpTools`·`costs`). 어댑터 전체 능력 대신 `capabilitiesFor(agent)` 가 그 러너·그 프로그램의 값을 돌려준다. `serverSessionIds` 가 없는 프로그램은 `providerSessionId` 없이 보내고 `run.session` 으로 받은 값을 세션 행에 저장한다(이번 드라이버는 쓰지 않는다 — 서버 갈래와 시험은 가짜 러너의 `codex` 로).
- **PR4 — 러너 에이전트 필드.** `agents.program`(러너면 값 — 서비스가 지킨다)·`runner_project_id`(nullable FK — 「보관되지 않은 러너 에이전트는 프로젝트가 있다」는 서비스 불변)·`model`(nullable)·`permission_mode`(기본 `default`)·`allowed_tools_json`(null = 상한 안에서 SDK 기본)·`disallowed_tools_json`(`[]`). 지시는 새 열 없이 `base_prompt`. `providerAgentId` 는 서버가 `r-` + 소문자 hex 10 으로 짓는다(워크스페이스 유일, 부딪히면 다시 짓기).
- **PR5 — 계약은 V2 를 나란히 더했다가 V1 을 지웠다.** 지금 이름은 원래대로(`RunnerHello`·`RunnerRunStart` …), `RUNNER_PROTOCOL` 2.
- **PR6 — 마이그레이션 둘.** `0030_runner_provider`: `provider` `claude` → `runner`, `program` 열(옛 행은 `claude`), 부분 유일 색인 `agents_runner_ws_agent`. `0031_runner_projects`: `runner_projects`, PR2·PR4 열, **프로젝트가 없는 러너 에이전트를 모두 보관** — 화면은 「프로젝트가 없어 되살릴 수 없습니다 — 새로 만드세요」, 되살리기 REST 는 `VALIDATION`. 데이터 옮기기는 생성 SQL 에 손으로 덧붙였다.
- **PR7 — 토큰 다시 발급** `POST /api/v1/setup/runner-tokens/:id/reissue`(owner). 같은 행의 해시·접두사만 바꾸고 그 토큰의 러너 연결을 폐기와 같은 순서로 끊는다(러너는 종료 2). 응답은 발급과 같은 모양 `ReissueRunnerTokenResult`(`token`·`record`·`runnerConfig`), 폐기한 러너는 409.
- **PR8 — 프로젝트 옮기기** `POST /api/v1/runner-projects/:id/move { runnerId }`(admin 이상): 대상 러너가 붙어 있고 `project.check` 가 `ok` 일 때만, 프로젝트와 그 에이전트(보관한 것 포함)의 `runner_token_id` 를 한 트랜잭션에서 바꾸고 `agent_sessions.provider_session_id` 를 비운다. 같은 자리 프로젝트가 대상에 있으면 409, 대상 천장 밖 에이전트(보관 안 된 것 — 프로그램·권한·도구)가 하나라도 있으면 400 `VALIDATION`(`details.agentIds`, `item` 은 첫 에이전트의 항목)이고 아무것도 옮기지 않는다.
- **PR9 — 걷은 것.** `GET /agents/discover?provider=runner` 갈래(400), `PUT /setup/runner-tokens/:id/agents/:agentId`(「이 러너로 묶기」), `modules/runners/bindings.ts`, 어댑터의 `claimUnbound`·충돌 판정, 웹 `useBindRunnerAgent`·`AgentConflict`, `SetupStatus.runners[].agents`. 러너 에이전트는 만들 때 그 프로젝트의 러너 토큰에 묶인다.
- **PR10 — 프로그램·프로젝트는 PATCH 로 바꾸지 않는다**(6장 「고치기(프로그램…)」를 좁힘). 프로젝트는 PR8 옮기기 하나로만 바뀌어 프로젝트와 에이전트 토큰이 어긋나지 않는다 — 정의를 만드는 `runners/definition.ts runnerAgentDefinition` 도 프로젝트 토큰이 에이전트 토큰과 다르면 `null`(런이 그 러너로 가지 않는다). 프로그램을 바꾸면 세션 전사가 다른 프로그램 것이 되므로 새 에이전트를 만든다. PATCH 에 `program`·`runnerProjectId` 가 오면 400.
- **PR11 — 러너 에이전트 정의(`Agent.runnerAgent` — 프로젝트 id·모델·권한·도구)는 admin 이상에게만 싣는다**(REST·wire·제어 `list_agents`). member 의 에이전트 줄·DM 머리는 프로그램과 러너 이름까지만 보인다(`Agent.program` 은 누구나).

### 러너(`packages/claude-runner`)

- `checkCeiling` 은 셋째 인자로 그 연결의 detect 결과(`available`)를 받는다 — 「프로그램이 켜져 있고 쓸 수 있다」는 설정이 아니라 연결 상태라서다. 항목 순서 root → path → program → permissionMode → allowedTools. 루트 id 가 설정에 없으면 `root`, 루트 디렉터리 자체가 사라졌으면 realpath 실패라 `path`. `allowedTools` 상한은 글자 그대로의 부분집합(`Bash(git status)` 는 상한 `Bash` 에 들지 않는다), `null` 은 어느 상한에도 든다.
- 드라이버는 팩토리 `createClaudeDriver({ sdk, claudeCodeVersion, … })`, `ProgramDriver` 에 오류 문구용 `label` 을 더했다. `detect` 는 자격 증명을 읽지 않는다 — 로그인 디렉터리가 없으면 `auth: "missing"`, 있으면 `unknown`(그래서 러너 탭은 로그인한 머신에서도 「로그인 모름」이다). 설정에 적었지만 드라이버가 없는 프로그램은 `available: false`·「이 러너 판본에는 이 프로그램의 드라이버가 없습니다」, detect 가 던지면 「상태를 확인하지 못했습니다」.
- 경로 가림의 뿌리는 `sink.ts` 의 `workdirMasker` 하나이고, sink 가 `run.event`·`run.final`·`run.error`·`outbound.post` 의 글 칸을 내보내기 직전에 한 번 더 가린다. 승인 요약은 드라이버가 가린 뒤 줄인 글이라 sink 가 다시 가리지 않는다(다시 가리면 꼬리가 표지로 숨거나 상한을 넘는다).
- `providerSessionId` 없는 Claude Code 런은 `run.error VALIDATION`, 형식이 틀린 `run.start` 는 runId 를 읽을 수 있으면 dispatch 뒤 `run.error VALIDATION`(필드 경로만 — 보낸 쪽이 정한 키는 `?`), 못 읽으면 drop. 스케줄러의 겹침 키는 `providerSessionId ?? sessionKey`.
- `fs.list` 의 루트 밖·없음·파일은 모두 `NOT_FOUND`(루트 밖에 무엇이 있는지 알리지 않는다), 정렬은 코드 포인트 순, `.git` 이 파일이어도 git 저장소. `browse` 기본값은 `true`, hello 의 `programs` 는 설정에 적은 것만, 루트 `label` 이 없으면 디렉터리 이름. realpath 는 `realpathSync.native`(대소문자 무시 볼륨에서 디스크의 이름으로) — 루트·작업 디렉터리·둘러보기 링크 풀이가 같은 함수를 쓴다(`post` 의 `files.ts` 는 아직 JS 판 — 이월).
- 서버가 hello 거절 ack 와 끊김을 한 조각으로 보내면 끊김 처리기가 먼저 돌아 「서버가 끊었다」가 먼저 찍히던 것을 — hello 를 기다리는 중의 끊김은 `setImmediate` 로 미루고 `fatal` 은 이미 끝나는 중이면 사유만 남긴다 — 첫 문구가 판본 불일치가 되게 했다.

### 서버 런타임·데이터

- 에이전트 정의는 어댑터 계약(shared)을 넓히지 않고 어댑터 옵션 `agentDefinition` 콜백으로 받는다(`runners/definition.ts`). 정의가 없으면 `NOT_FOUND`, 정의가 `RunnerRunStart` 밖이면 보내지 않고 `INTERNAL` — 러너는 runId 를 못 읽는 형식 오류면 drop 하므로 서버가 먼저 같은 스키마로 거른다.
- `RunnerRunStart.providerSessionId` 는 UUID 가 아니라 string 1~128 선택이다(`run.session` 이 받은 id 를 그대로 싣는다). UUID 검사는 Claude Code 드라이버가 하고, 서버 `ensureProviderSessionId` 는 `serverSessionIds` 프로그램이면 저장 값이 UUID 꼴이 아닐 때 새로 짓는다.
- 러너 세션 갱신 조건은 어댑터 능력 `promptEveryRun`(옛 `serverSessionIds`) — 세션 id 를 프로그램이 짓는 드라이버도 규칙·지시가 바뀌면 새로 열려야 한다. 갱신 알림 문구는 「채널 규칙이나 에이전트 지시가 바뀌어 @<핸들> 이 앞 작업 맥락(도구 결과·긴 작업)을 이어 가지 않습니다 — 채널의 최근 글은 그대로 봅니다」. 다른 연결이 보낸 `run.session` 은 저장하지 않는다.
- `runner_projects` 에 `workspace_id` 를 더했다(5장 목록에 없음 — 다른 표와 같이 워크스페이스로 가른다, `runner_tokens.workspace_id` 와 늘 같다).
- 천장 카드는 다른 카드처럼 `@<핸들> 실행이 실패했습니다: ` 뒤에 「러너 설정이 이 에이전트를 허용하지 않습니다(<항목>) — 러너 머신의 설정을 확인하세요」. 런 오류 `message` 가 다섯 항목 밖이면 괄호 없이 낸다(러너가 보낸 아무 글이 카드에 오르지 않게). 「다시 실행」을 막는 코드에는 넣지 않았다. `PROVIDER_AUTH` 카드는 「러너의 <프로그램 이름> 로그인을 확인하세요」(`RUNNER_PROGRAM_NAME`, 지금 「Claude Code」).
- hello 는 판본부터 본다 — 옛 러너의 hello 는 모양도 달라 모양 오류가 아니라 판본 불일치로 답해야 머신 주인이 무엇을 할지 안다. hello 로그에는 루트 id 만 싣는다(라벨을 안 적으면 계정 이름이 올 수 있다). 러너 어댑터 능력 `agentsList: false`(러너는 에이전트를 알리지 않는다).
- 옛 REST 「id 로 러너 에이전트 등록」(`POST /agents { provider: "runner", providerAgentId }`)·제어 `register_agent { provider: "runner" }` 는 400 `VALIDATION` — 프로젝트 없이 만들 수 없다.
- 서버는 러너가 보낸 `run.error.message`·도구 인자·루트 라벨·프로그램 사유를 다시 가리지 않는다 — 경로 가림은 러너 sink 한 겹이다(이월).

### REST·권한·제어 도구

- 경로·응답 꼴은 `docs/guides/project-structure.md` 의 `modules/runners/` 줄이 정본이다. 어댑터 `fsList`·`projectCheck` 의 `AdapterError` 코드는 그대로 API 코드로(`ADAPTER_UNAVAILABLE` 503·`TIMEOUT` 504·`VALIDATION` 400·`INTERNAL` 500), 폐기한 러너에 프로젝트 더하기·옮기기는 409(503 이면 「다시 붙이면 된다」로 읽힌다).
- 권한 모드 enum·순서·도구 목록 스키마는 `domain` 으로 옮겼다(`Agent.runnerAgent` 가 써야 하고, `runner` 가 `domain` 을 값으로 import 해 반대 방향은 순환). `runner/index.ts` 가 다시 내보낸다.
- PATCH 의 천장 대조는 **바꾸는 필드만**이고 프로그램 available 은 만들 때만 본다 — 상한이 낮아진 뒤 권한을 낮추는 PATCH·이름만 바꾸는 PATCH 가 막히지 않게. 러너가 끊겨 있으면 대조를 건너뛴다(런에서 러너가 거절한다).
- 제어 `update_agent` 는 러너 에이전트의 `name`·`avatarUrl` 만 받고 `handle` 도 거절한다(처리기 `check` 라 채널 안 에이전트의 호출도 확인 카드 없이 거절). 정의 필드는 도구 입력 스키마에서 아예 뺐다.
- 둘러보기 요청의 `relPath` 쿼리는 운영 로그 한 줄뿐 아니라 Fastify 요청 로그에서도 가린다(`logger.ts redactUrl` — 쿼리 키를 퍼센트 디코드해서 본다). 프록시 접근 로그는 서버가 못 가린다(`docs/guides/docker-deploy.md` 「프록시 접근 로그」 절).
- 러너에 묻기·천장 대조는 `modules/runners/live.ts`, 「러너」 탭 라우트는 `projects.routes.ts`, 정책은 `authorizeRunnerManage`. 팀 스펙 「역할과 권한」 표에 러너 줄을 더했다.

### 웹

- 「확인 결과를 보고 저장」은 저장이 곧 확인이다 — 저장 전 자리를 묻는 REST 가 없고 `POST /runners/:id/projects` 가 먼저 `project.check` 한다. 화면은 자리·이름을 보이고 「확인하고 추가」, 실패면 `details.reason` 의 네 문구. 프로젝트 줄의 git 여부는 「확인」 결과에서만 안다(`RunnerProject` 에 없다 — 줄마다 러너 왕복을 하지 않는다).
- 「루트 없음」은 붙은 러너일 때만 — `rootLabel === null` 은 끊김에서도 오는데 끊긴 러너는 카드가 「끊김」이라 줄마다 달면 틀린 말이 된다.
- DM 머리는 「러너 · <프로그램> · <러너 라벨>」 — 한 러너가 프로그램 여럿을 돌리니 라벨만으로는 무엇과 말하는지 모른다.
- 버튼 이름은 「에이전트 가져오기」 그대로(7장의 「에이전트 추가」 자리) — 러너 갈래는 가져오지 않고 새로 만든다. 만들 때의 칸 이름은 「지시」, 에이전트 줄의 편집은 기존 「기본 프롬프트 편집」이 같은 값(`base_prompt`)을 고친다. 러너 에이전트 고치기는 줄 안 폼(「러너 설정 고치기」). `disallowedTools` 칸은 만들기·고치기 어디에도 없다(서버 기본 `[]` — REST 로 넣은 값이 화면에 안 보이는 것은 이월).
- 러너 탭의 실시간은 wire `adapter.status`(러너 어댑터가 hello 뒤·끊길 때마다 모두에게 낸다 — `setup.status` 는 owner 에게만 가서 admin 의 탭이 못 받는다). `agents.changed` 는 프로젝트 목록(에이전트 수)만 낡게 한다.
- 상한 아래로 내려간 저장 값은 고치기에서 「(상한 초과)」로 고를 수 없는 줄로 남기고 경고를 단다 — 다른 칸만 바꾸는 저장은 막지 않는다. 끊긴 러너의 고치기는 권한 모드 넷 다 고를 수 있다.
- 둘러보기 목록은 대화상자가 열린 동안 다시 받지 않는다(분당 60 상한), 직접 입력의 앞 `/` 는 거절(호스트 절대 경로를 서버로 보내지 않는다)·뒤 `/` 는 걷는다. 「서버와 같은 빌드입니다」 줄은 연결 페이지 토큰 줄로 옮겼다(러너 탭의 `RunnerSummary` 에는 번들 sha 가 없다). 보관한 프로젝트는 되돌리지 않는다(API 없음).
- 폼을 연 뒤 고른 것이 바뀌면 처음 고른 것을 쥔 채 잠근다 — 「선택된 러너가 끊겼습니다 …」·「선택돼 있던 러너의 토큰이 폐기됐습니다 …」·「선택된 프로그램을 지금 쓸 수 없습니다 …」(사람이 직접 고르지 않은 처음 값일 수 있어 「고른」이라 하지 않는다).
- 다시 발급 대화상자의 「AI 에게 맡기기」 한 줄은 설치가 아니라 토큰 교체다 — `llmsHandoffLine("runner-reissue", …)` 「「러너 머신」 절대로 이 머신의 dodok 러너 토큰만 바꿔 줘 — dodok-runner 를 멈추고 1번처럼 새 토큰을 토큰 파일에 덮어쓴 뒤 다시 띄운다(설치·설정은 그대로)」. 안내서 절 이름은 「러너 머신」, 운영 화면 연결 줄·채널 설정 저장 안내의 옛 「Claude 러너」는 「러너」.

### dev:fake·통합

- 천장은 가짜 러너가 실제로 본다(`test/fakes/fake-runner.ts` 옵션 `tree` — 실제 러너 `fs-browse.ts`·`ceiling.ts` 와 같은 갈래, 판정 기준은 그때 알리는 hello). 대본 키워드 「천장」도 둔다.
- 상한 `plan` 은 둘째 가짜 러너(「dev-fake 제한」 — 한 머신 설정 안에서 프로그램 하나에 상한 둘을 둘 수 없다), `dontAsk` 는 훅 `maxPermissionMode`. 둘째 러너에 루트 `src` 를 더했다 — 옮기기 성공은 대상에 같은 루트 id·경로가 있어야 한다.
- `--keep` 의 러너 토큰 행은 고정 id 로 찾고, 「다시 발급」으로 해시가 바뀐 행은 시작 때 고정 토큰으로 되돌린다(warn 한 줄) — 프로젝트·`coder` 가 그 러너에 남은 채 붙는다.
- 통합 `apps/server/test/integration/runner-projects.test.ts` 는 완료 기준 1~4 를 흐름마다 보고, 흐름마다 끝에 DB(+WAL)·서버 로그·REST 응답·wire 에 비밀 루트가 없는지 본다 — 비밀 루트는 가짜 러너 안에만 있어 이 검사는 「프로토콜에 경로 칸이 없고 서버가 경로를 만들어 내지 않는다」까지만 증명한다(맨 위 문단).
