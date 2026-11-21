# 에이전트 명령(Claude Code·OpenClaw 슬래시 명령) — 설계

상태: 승인 대기(2026-11-21) · 결정: 사용자와의 대화(2026-11-21), 빌더 확인 1회, SDK 스파이크 1회

## 1. 왜

채널·DM 에서 에이전트 쪽 슬래시 명령을 쓰고 싶다(사용자). 쓰임은 둘 다다(사용자): ① 세션 관리 — 압축·상태·컨텍스트 보기, ② **내가 만든 스킬·사용자 명령을 에이전트에게 실행시키기**. 지금 dodok 작성기가 아는 명령은 `/stop` 하나이고, 나머지 `/…` 는 평범한 글로 간다.

- 러너(Claude Code): SDK 는 프롬프트가 `/` 로 시작하면 명령으로 처리하지만, 러너가 사람 글 앞에 채널 머리말을 붙여 보내 명령이 되지 않는다. SDK `supportedCommands()` 가 그 머신·프로젝트의 명령 목록(스킬·사용자 명령 포함)을 준다.
- OpenClaw: Gateway 가 `/` 로 시작하는 단독 메시지(명령)와 글 속 지시어(`/model`·`/think` 등)를 처리한다 — 허가된 발신자일 때만. dodok 플러그인은 지금 `CommandInterpretationSuppressed: true` 로 명령 해석을 **일부러 꺼 두었다**(`packages/openclaw-plugin/src/channel.ts`) — 채널 참여자가 Gateway 명령을 마음대로 쓰지 못하게.

## 2. 목표 · 하지 않을 것

**목표**
- `@에이전트 /명령 [인자]` 로 그 에이전트에게 명령을 보낸다. 에이전트 1:1 DM 에서는 `/명령 [인자]`.
- 명령은 dodok 이 해석하지 않고 **그대로 넘긴다**(사용자 1번) — 스킬·사용자 명령·새 명령이 dodok 수정 없이 돈다.
- 결과는 그 에이전트의 평범한 답글로 대화에 남는다(다른 참여자에게도 보인다).
- 작성기 자동완성: 멘션한 에이전트(또는 1:1 DM 의 에이전트) 뒤에서 `/` 를 치면 그 에이전트의 명령 목록.
- 위험한 명령은 dodok 서버가 막는다(3장 C4).

**하지 않을 것**
- dodok 공통 명령 정의(사용자가 2번을 버렸다).
- 나만 보는 답글.
- 에이전트 여럿에게 한 번에 같은 명령(멘션이 둘 이상이면 명령으로 보지 않는다 — 평범한 글).
- 사람 사이 DM·사람만 있는 대화의 명령.

**실패로 볼 것(돌아가도)**
- member 가 명령으로 Gateway 호스트·러너 머신의 로그인·설정·셸을 건드리는 것.
- 명령이 아닌 글(경로 `/usr/bin`, URL)이 명령으로 잡히는 것.
- 옛 러너·옛 플러그인에서 명령이 머리말 붙은 평범한 글로 모델에게 가 엉뚱한 답을 받는 것 — 막고 사유를 보여야 한다.
- 명령 런이 끝나지 않고 「응답 중」으로 남는 것(답 글이 없는 명령 포함).

## 3. 결정

| # | 결정 | 출처 |
| --- | --- | --- |
| C1 | 넘겨주기 방식 — dodok 은 명령을 알아보고 머리말 없이 그 글만 러너·플러그인에 보낸다. 처리는 Claude Code·OpenClaw 가 한다 | 사용자(1) |
| C2 | 모양: 글이 정확히 「멘션 하나 + 공백 + `/이름` + (공백 + 인자)」일 때만 명령. 1:1 에이전트 DM 은 맨 앞 `/이름`. `/이름` 은 `[A-Za-z0-9][A-Za-z0-9:_-]{0,63}`(Claude 플러그인 명령의 `plugin:name` 포함). 첨부가 있으면 명령으로 보지 않는다 | 조율자(사용자 이의 없음) |
| C3 | 결과는 그 에이전트의 평범한 답글. 명령 글 자체도 사람 글로 남는다 | 조율자(사용자 이의 없음) |
| C4 | (C10·C18 이 대신한다 — 아래는 첫 판정) 막는 명령(서버가 거절, 사람에게 「이 명령은 dodok 에서 쓸 수 없습니다」): OpenClaw `/restart` `/update` `/bash` `/config` `/mcp` `/plugins` `/debug` `/exec` `/elevated`, `!…` 시작 글. Claude `/login` `/logout` `/config`. 러너 `/model`·`/clear` 는 막고 안내(「모델은 작성기 칩에서 바꾸세요」·「새 세션을 여세요」) — 러너는 런마다 서버가 정한 모델·세션으로 돈다 | 사용자 이의 없음(막는 목록), 안내 문구는 조율자 |
| C5 | 그 밖의 이름은 목록에 없어도 넘긴다(자동완성 목록은 도움말일 뿐, 허용 목록이 아니다) — 새 스킬·명령을 막지 않게 | 조율자 |
| C6 | 누가 — 그 에이전트를 멘션해 부를 수 있는 사람이면 누구나(지금 멘션 규칙 그대로). 막는 명령(C4)은 owner 도 막는다 | 조율자 |
| C7 | 옛 러너·옛 플러그인(능력 `commands` 없음)이면 서버가 그 명령을 보내지 않고 대화에 시스템 줄 「이 에이전트는 명령을 지원하지 않습니다 — 러너·플러그인을 업데이트하세요」 | 조율자 |
| C8 | 러너 명령 목록은 **프로젝트마다** 묻는다 — 프로젝트 명령이 cwd 마다 다르므로(C14 의 `project` 감싸개). 서버 → 러너 ack 요청 `commands.list { project: RunnerProjectRef }`(상한 30초) → 러너가 그 cwd·감싸개로 프롬프트 없는 query 를 열어 `supportedCommands()`(스파이크: 모델 요청 0) → `{ name, description, argumentHint?, aliases? }[]`. 서버는 프로젝트 id 별로 10분 캐시하고 러너 재접속 때 비운다. hello 에는 싣지 않는다 | 조율자(스파이크로 바꿈) |
| C10 | **OpenClaw 는 허용 목록으로 바꾼다**(C4·C5 의 OpenClaw 부분을 대신한다) — Gateway 명령 상당수가 호스트·설정·페어링·승인·세션을 건드리고(`/login` `/allowlist` `/pair` `/approve` `/send` `/export-session` `/loop` `/diagnostics` `/openclaw` `/acp` `/codex` `/dreaming` `/activation` 등) 판마다 늘어난다. 허용: `/status` `/help` `/commands` `/whoami` `/usage` `/compact` `/skill`, 지시어 `/think` `/fast` `/verbose` `/reasoning` `/queue` `/model`(인자에 `-g`·`-a` 가 있으면 막음). `/new`·`/reset` 은 막고 「새 세션을 여세요」(dodok 세션과 Gateway 세션이 갈라지지 않게 — 러너 `/clear` 와 대칭). 스킬은 `/skill <이름>` 로. 러너(Claude)는 C4 막는 목록 + C5 그대로 | 조율자(빌더 확인 Q3) |
| C11 | 역할 차등 없음 — 허용 목록(C10)이 호스트를 건드리지 않는 것만 담으므로 멘션할 수 있으면 누구나(C6) | 조율자(빌더 확인 Q4) |
| C12 | OpenClaw 명령 허가 — 명령 갈래에서만 플러그인이 `CommandInterpretationSuppressed` 를 빼고 ingress 를 `command: { allowTextCommands: true, hasControlCommand: true }` + `useAccessGroups: false`·`modeWhenAccessGroupsOff: "allow"` 로 넘긴다(dodok 서버가 이미 판정했으므로). Gateway 에 `commands.ownerAllowFrom` 이 있으면 owner 전용 명령은 Gateway 가 조용히 무시한다 — 그것은 Gateway 주인의 설정으로 둔다(dodok 이 owner 를 사칭하지 않는다). 무시된 명령은 C13 로 닫힌다 | 조율자(빌더 확인 Q2·a) |
| C13 | 답이 없는 명령 런은 **성공으로** 닫는다 — 플러그인 admission `handled`·`drop`(지금은 `DROPPED:handled` 실패 런·운영 사건·「다시 실행」이 된다)과 러너 `num_turns: 0` 결과(지금 `stream-map` 이 「resume 직후 빈 result」로 버려 런이 안 끝난다)를 명령 런에서는 끝으로 본다. 결과 글이 비면 「`/이름` 완료」 한 줄(5.1) | 조율자(빌더 확인 b·c) |
| C14 | 러너가 사람의 명령·스킬을 읽게 한다 — **명령·스킬만 골라 연다**(사용자 B). 스파이크 결과(`.superpowers/sdd/2026-11-21-agent-commands/spike-report.md`, SDK 0.3.283·CLI 2.1.283/2.1.330, 모델 런 0회)대로: `settingSources: []` 그대로 두고, 러너가 임시 디렉터리에 플러그인 감싸개 둘을 만든다 — `user`(`.claude-plugin/plugin.json` `{"name":"user"}`, `commands`·`skills` → `<configDir 또는 ~/.claude>/` 의 같은 폴더로 심볼릭 링크)와 `project`(→ `<cwd>/.claude/commands`·`skills`, 있는 것만). `plugins: [{type:"local", path, skipMcpDiscovery:true}]`. 사람 폴더에는 아무것도 쓰지 않는다. 확인된 것: settings.json 의 permissions·hooks·env·CLAUDE.md 는 0, `skills:"all"`·`additionalDirectories` 는 효과 없음 | 사용자(B), 꼴은 스파이크 |
| C15 | 명령·스킬 파일이 스스로 지닌 권한·훅을 막는다(스파이크가 실측으로 확인): `settings: { disableAllHooks: true, disableSkillShellExecution: true }`(스킬 frontmatter 훅·본문 `` !`cmd` `` 끔 — 러너의 SDK 콜백 훅은 그대로 돈다), 그리고 명령 frontmatter `allowed-tools` 가 승인 카드를 건너뛰지 않게 러너 SDK `PreToolUse` 콜백 훅이 안전 도구 목록 SAFE(`Read` `Glob` `Grep` `LS` `NotebookRead` `TodoWrite` `Task` `ListAgents` `EnterPlanMode` `ExitPlanMode` 와 `mcp__dodok__*` — 실측으로 default 에서 카드 없이 도는 읽기 전용 도구) **밖의** 도구를 모드별로 막는다: default → `ask`(승인 카드), acceptEdits → 편집 도구(`Edit` `Write` `MultiEdit` `NotebookEdit`)도 빼고 `ask`, dontAsk → `deny`(묻지 않는 모드의 뜻), plan → 개입 안 함(CLI 가 이미 막고, ask 는 오히려 카드로 연다). 목록을 「안전한 것」으로 두어 새 CLI 도구도 카드로 간다(fail-safe — 구현 중 실측, 조율자 판정 2026-11-21). 러너 천장(`disallowedTools`·plan 상한)은 스파이크에서 이미 뚫리지 않았다 | 조율자(스파이크) |
| C16 | 이름: `supportedCommands()` 의 `builtin` 이 아닌 행은 `user:이름`·`project:이름` 꼴이다. 앱은 그 이름 그대로 보이고 넘긴다. 스킬은 접두사 없는 별칭(`aliases`)도 실행되므로 자동완성에 별칭을 함께 싣는다(명령에는 별칭이 없다 — `/user:review` 로만 실행). 목록에 없는 이름은 CLI 가 오류 없이 글 그대로 모델에 보낸다(C5 와 맞는다) | 조율자(스파이크) |
| C17 | 결과: 마지막 result 에 `local_command` 가 있으면(CLI 가 모델 없이 처리 — `/context`·`/compact`·`/cost` 등) 그 런의 답은 **result 글**이고 그 사이 assistant 글은 모으지 않는다(`/compact` 가 앞 턴 글을 다시 내므로). result 가 비면 「`/이름` 완료」(C13). 없으면 지금처럼 | 조율자(스파이크) |
| C18 | 리뷰 판정(2026-11-21, 두 차례): ① OpenClaw 인자에 줄바꿈이나 `/` 로 시작하는 토큰(글 시작 또는 JS `\s` 뒤)이 있으면 막는다(`/skill` 포함) — 핀 2026.9.4 가 본문 전체에서 지시어를 뽑아 세션에 저장해 허용 목록·`-g` 막기를 뚫으므로. ② Claude **내장** 명령은 허용 목록 `compact` `context` `usage`(별칭 `cost`) — `help` 는 핀한 CLI 판에 없고, `usage` 의 다른 별칭 `stats` 는 넘기지 않는다. 그 밖 내장(`/insights`·`/recap`·`/heapdump` 등)은 막고 목록에서 뺀다. `:` 든 사람 명령과 스킬 별칭은 넘긴다(C5 는 이 둘에만). `:` 없는 이름은 스킬 별칭일 때만 — 서버 라우터는 별칭 캐시에 답이 있을 때만 그것으로 판정하고 비었으면 기다리지 않고 넘기며, 러너가 그 런의 `supportedCommands()` 로 마지막에 판정한다. 목록 묻기가 실패하면 응답은 `supported: true, listFailed: true, commands: []` 이고 웹은 별칭을 모른다고 본다. ③ 인자에 멘션 토큰이 있으면 명령 아님. ④ SAFE 에 `Skill` 을 더한다. ⑤ default 모드의 읽기 전용 Bash 도 카드가 되는 것은 받아들인다(C15 fail-safe). ⑥ 「항상 허용」 — 러너는 CLI 제안 없이 온 카드(훅 `ask`)에서만 그 런 안에서 기억하고, 키는 Bash 명령 글·파일 도구의 절대 경로·WebFetch 호스트·그 밖은 입력 JSON 전체. CLI 제안이 있으면 그 제안을 세션 규칙으로만 준다. ⑦ 「다시 실행」·재시작 뒤 명령 런도 `checkCommand` 를 다시 본다 | 조율자(리뷰 R1·R2·R5, 재리뷰 N1~N7) |
| C9 | OpenClaw 명령 목록: shared 에 2026.9.4 문서(`docs/tools/slash-commands.md`)의 명령·지시어 중 C4 를 뺀 고정 목록(이름·한 줄 설명). Gateway 의 스킬 명령(`nativeSkills`)은 자동완성에 없어도 넘긴다(C5) | 조율자 |

## 4. 방법(고른 것과 버린 것)

1. **넘겨주기(고름, C1)** — 처리는 원래 프로그램이, dodok 은 알아보기·막기·전달·자동완성만. 사용자 스킬이 그대로 돈다.
2. **dodok 공통 명령(버림)** — 화면은 통일되지만 정해 둔 명령만 되어 「내 스킬 실행」 목적을 못 채운다.

## 5. 설계

### 5.1 서버

- 메시지 저장 때(지금 멘션 해석 자리) C2 를 만족하면 런을 `triggerKind: "command"`(새 값)로 만들고 `command: { name, args }` 를 런 시작에 싣는다. C4 면 런을 만들지 않고 그 대화에 시스템 줄(사람 글은 남는다). C7 이면 같은 식으로 시스템 줄.
- 명령 런은 릴레이·자동 응답을 일으키지 않는다(그 답글에 멘션이 있어도 릴레이 안 함 — `decideRuns` 의 `sourceRun.triggerKind === "command"`) — 명령 결과가 다른 에이전트를 부르지 않게. 1:1 DM 은 멘션 없이 런이 생기는 길(DM 경로)에서 명령을 가른다.
- 「다시 실행」은 트리거 글을 다시 `parseAgentCommand` 로 풀어 같은 명령을 보낸다. `@에이전트 /stop` 은 dodok 의 중지가 아니라 그 에이전트에게 넘기는 명령으로 보지 않는다 — 막고 「중지는 `/stop` 만 쓰세요」.
- 답 글이 없는 명령(예: Claude `/compact` 가 결과 글 없이 끝남, OpenClaw admission `handled`)도 런을 닫는다 — 결과 글이 비면 그 에이전트 이름으로 「`/이름` 완료」 한 줄을 게시한다.
- 런 한도·레이트리밋·「다시 실행」은 지금 런과 같다.

### 5.2 계약(`packages/shared`)

- `RunTriggerKind` 에 `"command"`.
- 러너 `run.start` 의 deliver 에 `command?: { name: string; args: string }`. 브리지 `inbound.deliver` 에도 같은 필드.
- 러너 hello 능력·플러그인 hello 능력에 `"commands"`(각 enum 에 값을 더한다 — 옛 서버는 모르는 값을 버린다).
- 러너 ack 요청 `commands.list`(C8) — 결과 `{ name; description; argumentHint?; aliases? }[]`(상한 200개·이름 64자·설명 200자).
- `OPENCLAW_COMMANDS`(C9), `BLOCKED_COMMANDS`(C4 — 프로그램별), `parseAgentCommand(text, …)`(C2 — 웹·서버가 같은 함수).
- 대화 설정 응답·`agent-ceilings`(작성기 칩이 이미 받는 자리)에 에이전트별 `commands` — 러너면 hello 목록, OpenClaw 면 고정 목록, 끊겼거나 옛 판이면 빈 목록. (OpenClaw 에이전트는 지금 그 응답에 없다 — 명령 목록만은 OpenClaw 에이전트도 싣는다. 자리가 맞지 않으면 빌더가 새 GET 을 둔다.)

### 5.3 러너

- `command` 가 있는 런은 프롬프트를 `/<name> <args>`(args 가 비면 `/<name>`) 그대로 보낸다 — 머리말·이미지 없음, 세션은 그 대화의 세션 그대로(resume).
- 결과는 지금처럼 final. 결과 글이 비면 서버가 5.1 의 한 줄을 게시한다(러너는 빈 글 그대로).
- 러너도 C4 의 Claude 목록을 한 번 더 막는다(서버를 지나도 — 이중 방어).
- 명령 런에도 `UserPromptSubmit` 훅의 채널 사실(`additionalContext`)은 그대로 붙는다 — 스킬이 어느 대화에서 도는지 알게(조율자).
- 능력 `commands`, `commands.list` 응답(C8). 감싸개(C14)·막기 옵션(C15)·결과 꼴(C17).
- 스트림 매퍼(`stream-map.ts`)가 `num_turns: 0` 결과를 「resume 직후 빈 result」로 버리는 것을 명령 런에서는 끝으로 본다(C13).

### 5.4 OpenClaw 플러그인

- `command` 가 있는 인바운드는 `body`·`bodyForAgent`·`rawBody`·`commandBody` 를 모두 `/<name> <args>` 로, 채널 머리말·최근 대화 동봉 없이, `CommandInterpretationSuppressed` 를 빼고 그 발신자를 명령 허가로(`channelIngress` 의 command 갈래 — `allowTextCommands: true`, `commandAuthorized: true`. 정확한 SDK 필드는 빌더가 2026.9.4 플러그인 SDK 에서 확인한다). **`command` 가 없는 인바운드는 지금처럼 해석을 끈 채** — 평범한 글 속 `/model` 이 지시어로 먹지 않게.
- 플러그인도 C10 허용 목록을 한 번 더 본다. 해석을 켠 명령 글은 단독 메시지(C2)라 인자 속 인라인 단축(`/status` 등)도 처리될 수 있다 — 허용 목록 안의 것뿐이라 받아들인다.
- 능력 `commands`. 명령 응답은 지금 outbound 길로 온다. 런 없이 끝나면(admission `handled`) 지금 ack 대로 — 서버가 5.1 로 닫는다.

### 5.5 웹(작성기)

```
@coder /re▏
 ┌───────────────────────────────┐
 │ /review   코드 리뷰 (스킬)    │
 │ /resume   …                   │
 └───────────────────────────────┘
```
- 멘션 칩 하나 + 공백 뒤 첫 글자 `/`, 또는 1:1 에이전트 DM 의 맨 앞 `/` 에서 그 에이전트의 `commands` 를 띄운다(지금 멘션 목록과 같은 꼴, 키보드 선택). 막는 명령(C4)은 목록에 없다.
- 보내기 전 `parseAgentCommand` 로 C4 면 보내지 않고 작성기 아래 사유(서버도 막는다).
- `/stop` 은 지금 그대로(멘션 없이 맨 앞 `/stop`).

## 6. 남은 것(빌더 몫)

- OpenClaw 명령 허가 필드의 정확한 이름(5.4), `handled` admission 때 응답 글이 오는지 실제 dev Gateway 로 확인(`docs/guides/live-smoke.md` — 모델 런 0회로 되는 명령 `/status`·`/help` 로).
- Claude `/compact`·`/context` 등의 결과 꼴(SDK 메시지 — `context_usage` 등)이 final 글에 어떻게 실리는지 런 0회 하네스로 확인.
- 시험: shared `parseAgentCommand`(경로·URL·멘션 둘·첨부·대소문자·`plugin:name`), 서버(C4·C7·명령 런의 릴레이 없음·빈 결과 한 줄·런 한도), 러너(프롬프트 그대로·머리말 없음·이중 막기), 플러그인(명령일 때만 해석 켬·평범한 글 속 `/model` 은 그대로), 웹(자동완성·막는 명령·1:1 DM).
- 판: 러너 0.8.0·플러그인 재설치 안내. 문서 `docs/manual/user-guide.md`, `docs/guides/agent-guide.md`, `docs/guides/plan.md` 8장.
