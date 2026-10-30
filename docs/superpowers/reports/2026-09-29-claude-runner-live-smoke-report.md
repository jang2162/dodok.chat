# Claude 러너(Phase 4 ③) 실연 — 2026-09-29 결과 (p4c-t9b, 모델 런 3회)

> Claude 러너(Phase 4 ③)를 실제 모델로 돌린 실연의 기록 — 계획 `docs/superpowers/plans/2026-09-27-claude-runner.md` 태스크 9(p4c-t9b), 스펙 `docs/superpowers/specs/2026-09-27-claude-runner-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


「Claude 러너 런 0회 하네스」 절을 먼저 끝까지 돌린 뒤에 한다. 모델 런은 **3회 이내**(러너가 연 `query()` 하나 = 1회 — 릴레이·카드 누르기가 만드는 러너 런도 센다), 러너 전용 로그인(`CLAUDE_CONFIG_DIR=~/.dodok-runner/claude` — `docs/guides/docker-deploy.md` 「Claude 러너 설치」 절의 로그인)으로.

**판정: 멘션 경로(스트리밍·도구·최종 답·운영 비용)는 통과. 규칙 변경 뒤 `resume` 은 새 규칙을 따르지 않았다** — 서버는 새 규칙만 실었는데(모델 0 으로 확인) 이어 간 세션의 모델이 자기 앞 답의 옛 표식을 이어 썼고, 「새 대화」 뒤 새 세션은 새 규칙을 따랐다(20.3). 승인·`post`·릴레이(원래 배분의 셋째)는 모델로 보지 않았다 — 셋째 런을 규칙 변경의 원인 가르기에 썼다.

### 20.1 구성

OpenClaw 쪽은 실제 dev Gateway 대신 **`dev:fake` 의 가짜 Gateway·가짜 OpenClaw 에이전트 `dev`** 다 — OpenClaw 모델 런을 0 으로 지키려고. 러너 어댑터·`/runner`·오케스트레이터·운영 집계는 운영 코드 그대로다.

| 항목 | 값 |
| --- | --- |
| 서버 | `pnpm -F @dodok/claude-runner pack:runner` 뒤 `PORT=3131 APP_ORIGIN=http://localhost:5181 LOG_LEVEL=debug pnpm -F @dodok/server dev:fake`(웹은 띄우지 않았다). 가짜 러너는 `POST /__devfake/runner {"connected":false}` 로 내리고, 에이전트 `dev`(openclaw)는 `POST /api/v1/agents` 로 등록 — `dev:fake` 는 `coder`(claude)만 미리 등록한다 |
| 러너 설치 | owner 로 `POST /api/v1/setup/runner-tokens` → 원문은 스크래치 0600 파일에만 → `GET /api/v1/setup/runner.tgz` → `npm install -g --prefix <스크래치>/runner <tgz>`. **감싸개를 두지 않는다**(실제 API) |
| 러너 설정 | `serverUrl` `http://127.0.0.1:3131`, `tokenFile` 스크래치 파일, `claudeConfigDir` `~/.dodok-runner/claude`, `maxConcurrentRuns` 1, 에이전트 `coder`(작업 디렉터리 스크래치 git 저장소 — `README.md`·`fib.sh` 커밋 하나, 라벨 `t9b-ws`, 모델 `sonnet`) |
| 러너 env | `env -i PATH=<스크래치>/runner/bin:<node bin>:/usr/bin:/bin HOME=$HOME LANG=en_US.UTF-8 TMPDIR=<스크래치>/tmp SHELL=/bin/bash USER=$USER` — `HOME` 은 실제 홈(키체인 로그인을 찾게 — ADR 0007 「질문별」 인증) |
| 채널 | `t9b-lab` — `dev`·`coder`, `relayPolicy {maxRelayTurns: 1}`(가짜 `dev` 는 부른 에이전트를 늘 되부르므로 — `dev:fake` `fakeAgentScript` — 한도 1 이면 `coder → dev` 한 번 뒤 되부름이 막혀 러너 런이 더 생기지 않는다), 채널 프롬프트 「모든 답은 첫 줄을 정확히 `[T9B-AMBER]` 한 줄로 시작하고, 그다음 줄부터 본문을 쓰세요. 답은 짧게(세 문장 이내) 한국어로 하세요.」 |
| 드라이버 | 워크트리 `data/`(ignored)에 둔 `socket.io-client` 스크립트(끝나고 지웠다) — `channel.subscribe` → `message.send` → 받은 wire 이벤트를 받은 시각과 함께 jsonl 로, `approval.requested` 가 오면 1.5초 뒤 `approval.resolve`. 런이 모두 `done`·`error`·`aborted` 가 된 뒤 8초 더 받는다 |

### 20.2 모델 런 (상한 3, 실제 3)

`+ms` 는 드라이버가 보낸 때부터. 비용은 러너가 보낸 `costUsd`(`total_cost_usd` 의 런 전후 차이), 전부 구독 로그인이라 `costKind: "subscription_estimate"` — 청구액이 아니라 공시 단가 환산값이다.

| 런 | 무엇 | 세션 | 모델이 한 것 | 시각 | 비용·토큰 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `@coder 작업 디렉터리의 README.md 를 읽고 이 저장소가 무엇인지 한 문장으로 알려 줘.` | 새 세션 | Bash `find . -maxdepth 1 -iname "README*"`(승인 없이 자동 허용) → Read `README.md` → 답 | `RUN_STARTED` +4509 → 도구 둘 +4511~+6541 → 첫 델타 +7414 → 최종 +7639 | $0.1238 · 입력 81,604 · 출력 322 | **통과** — 델타 3개, 최종 답 첫 줄 `[T9B-AMBER]`, `finalSource=plugin`. 활동 탭 자리(`run_events`)에 `TOOL_CALL_START·ARGS·END·RESULT` 도구마다 한 벌, 도구 인자·결과는 상대 경로(`README.md`, `./README.md`). 운영 `GET /api/v1/ops/runs?days=1` 이 그 런을 `measuredRuns 1 · tokens 81,926 · costEstimated: true`(웹 「환산 포함」 — `RunsTable` 의 태그)로 더했다 |
| 2 | 채널 프롬프트의 표식을 `[T9B-COBALT]` 로 바꾸고(`PATCH /api/v1/channels/<CH> {prompt}`) `@coder fib.sh 가 하는 일을 한 문장으로 알려 줘. 실행하지 말고 읽기만 해 줘.` | 런 1 세션 `resume` | Read `fib.sh` → 답 | `RUN_STARTED` +1545 → 최종 +3538 | $0.0409 · 입력 56,115 · 출력 233 | **새 규칙 불이행** — 답 첫 줄이 옛 표식 `[T9B-AMBER]`. 원인 가르기는 20.3 |
| 3 | 「새 대화」(`POST /api/v1/channels/<CH>/agents/<coder>/reset`) 뒤 런 2 와 같은 문장 | 새 세션 | 도구 없이 답(최근 대화에 인용된 런 2 의 답을 보고) | `RUN_STARTED` +3286 → 최종 +3727 | $0.0244 · 입력 27,292 · 출력 194 | **새 규칙 이행** — 답 첫 줄 `[T9B-COBALT]` |

합 **$0.1891**(환산). 런 2 가 런 1 의 세션을 이었다는 것은 러너 전용 로그인의 `projects/<작업 디렉터리>/` 전사 수로 안다(런 2 뒤 1개, 런 3 뒤 2개). 그 길이 러너의 `sessionExists` 판정으로 곧바로 `resume` 이었는지, `--session-id` 거절 뒤 「이미 있는 세션」 재시도(`session-in-use`)였는지는 **모른다** — 두 판정 모두 러너 로그에 남지 않고, 감싸개가 없어 CLI argv 도 안 적혔다. 하네스 설치본(감싸개가 argv 를 적는다)에서는 두 번째 런이 재시도 없이 `--resume` 한 번이었다(20.3 의 후보 확인).

### 20.3 규칙 변경 뒤 `resume` — 무엇이 옛 표식을 따르게 했나

런 2 의 모델이 본 것에는 새 규칙과 옛 표식 예시가 함께 있다 — **시스템 프롬프트의 새 규칙**(아래 H1), **세션 이력의 자기 앞 답**(런 1 의 `[T9B-AMBER]` 답), 그리고 **사용자 턴의 「최근 대화」 인용**(러너 프롬프트는 resume 이든 아니든 매 런 채널 최상위 최근 20개를 싣는다 — `packages/shared/src/runner/prompt.ts` 의 `renderRunnerPrompt`, 서버 `RECENT_MESSAGES_MAX` — 여기에 coder 의 `[T9B-AMBER]` 답이 있다). 모델 없이 앞의 것을, 런 3 으로 뒤의 둘을 갈랐다.

| # | 무엇 | 어떻게 | 결과 |
| --- | --- | --- | --- |
| H1 | 서버가 그 리비전에 새 규칙만 싣는가 | 실제 러너를 SIGTERM 으로 내리고, 같은 tgz 를 다른 스크래치 prefix 에 설치해 「Claude 러너 런 0회 하네스」 절의 감싸개·가짜 API(`--port 3197`)·스크래치 `HOME`·`claudeConfigDir` 로 붙여 같은 채널에 `@coder HX-TEXT …` 한 번(모델 0). 스크래치 설정 디렉터리엔 전사가 없어 새 세션(`--session-id`)이다 | 요청 `system[]` 셋(73·94·15,285자)에 **COBALT 1 · AMBER 0**, 틀 머리 1, `<relay-rules>` 의 「최대 1턴」 1. 요청 본문 전체의 AMBER 2 는 전부 `messages[0]` 사용자 블록의 「최근 대화:」 안 coder 답 둘이다 |
| 런 3 | 세션 이력 없이 「최근 대화」 인용만 옛 표식이면 | 「새 대화」 → 새 세션, 최근 대화는 런 2 직후와 같게(H1 이 남긴 사람·coder 메시지 두 행은 dev DB 에서 지웠다 — 최근 대화에 표식 없는 coder 답이 끼지 않게) | 새 표식을 따랐다 |

**판정** — 런 2 의 불이행은 전달 문제가 아니다(H1). 옛 표식이 **최근 대화 인용에만** 있을 때(런 3)는 새 규칙을 따랐고, **세션 이력의 자기 앞 답**이 함께 있을 때(런 2)는 옛 표식을 이어 썼다. 세션 이력만으로 충분하다(ADR 0007 「규칙이 바뀐 뒤 이어 간 세션」 절 — 인용을 빼도 0/2). 그래서 서버는 러너 세션을 채널 규칙 리비전이 바뀌면 다음 런에서 새 세션으로 연다 — 사람이 「새 대화」를 누르지 않아도 된다(`docs/guides/agent-guide.md` 「Claude 러너 에이전트」).

**고칠 길 후보 — 요청 본문만 봤다(모델 0, 코드는 고치지 않았다).** H1 과 같은 하네스 설치본의 번들(`dist/main.js`)만 임시로 고쳐 같은 채널에 새 세션 한 번·`resume` 한 번을 보냈다.

- **ⓐ 러너 프롬프트의 「최근 대화」에서 그 에이전트 자신의 답을 뺀다**(세션 이력에 이미 있다) — `resume` 요청의 새 사용자 턴에서 coder 줄이 빠지고 사람 줄만 남는다. 대가 둘: 새 세션(「새 대화」 뒤)은 자기 앞 답을 전혀 못 본다 — 런 3 은 바로 그 인용을 보고 도구 없이 답했다. 그리고 이미 이력에 들어간 앞 사용자 턴의 「최근 대화」 블록은 옛 모양 그대로 남는다. 그래서 빼는 것은 `resume` 런에서만, 그 세션이 시작된 뒤의 답만이어야 한다.
- **ⓑ 규칙이 바뀐 런의 턴 사실에 한 줄** — 「채널 규칙이 바뀌었습니다 — 앞 답의 형식을 따르지 말고 지금 채널 규칙을 따르세요.」 가 `UserPromptSubmit` 훅 `<system-reminder>` 안 턴 사실 끝에 실린다. 훅 문맥은 턴마다 이력에 쌓이므로(`resume` 요청에 두 턴 것이 다 있다) 늘 붙이면 안 되고 **규칙이 바뀐 뒤 그 세션의 첫 런에만** 붙여야 한다. 세션을 이어 간다면 서버의 `needsPromptContext` 는 세션 시작·「새 대화」 때 리비전(`promptRevisionAtStart`)과 견주므로 한 번 바뀐 뒤로는 「새 대화」 전까지 계속 참이다 — 「그 세션에 마지막으로 실은 리비전」을 따로 기억해야 한다.

두 후보를 모델로 잰 결과와 추천은 ADR 0007 「규칙이 바뀐 뒤 이어 간 세션」 절이다 — ⓐ 는 효과가 없었고(0/2), ⓑ 는 표식을 돌렸지만(2/2) 모델이 그 줄을 주입으로 의심해 채널 답에 적었다.

### 20.4 런을 더 쓰지 않고 본 것

- **로그 위생 — 호스트 경로·러너 토큰·이메일 0.** 스크래치 경로·`/private/tmp`·실제 홈·`.dodok-runner` 를 한 줄씩 담은 파일로 `grep -a -c -F -f <그 파일>`, 러너 토큰 파일로 같게, `drn_`, 이메일 꼴(`grep -a -c -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|net|org|io|dev|kr)'`): wire 기록 셋(34·28·20줄)·러너 로그(17줄)·서버 로그(87줄)·DB 덤프(`sqlite3 -json` 으로 `messages`·`run_events`·`runs`·`approvals`·`attachments`·`ops_events`) 전부 0. Python 부분 문자열 세기로 한 번 더 세어 같다. 양성 대조(토큰 파일 자신·러너 설정 파일의 작업 디렉터리) 1.
- **시스템 경로도 가려진다** — 런 2 의 Read 결과(활동 탭 도구 결과·`run_events`)에서 `fib.sh` 첫 줄 `#!/bin/sh` 가 `#!<작업 디렉터리 밖>` 이 됐다. `!` 뒤는 경로 시작으로 보는 가림 규칙(`packages/claude-runner/src/mask.ts` 의 `PATH_START`)대로다 — 작업 디렉터리 밖 절대 경로는 `/bin/sh`·`/usr/bin/env` 같은 시스템 경로도 가린다. 모델은 가리지 않은 원문을 받는다(가림은 서버로 가는 이벤트에만).
- **읽기 전용 Bash 자동 허용** — 런 1 의 `find . -maxdepth 1 -iname "README*"` 는 승인 카드 없이 돌았다(ADR 0007 「확인 못 한 것」 3 의 표본 하나).
- **러너가 세션을 어느 길로 열었는지 로그에 없다** — `sessionExists` 결과도 「이미 있는 세션」 재시도도 찍히지 않아, 감싸개 없는 실제 러너에서는 재시도가 났는지 알 길이 없다(20.2). 러너의 「런 시작」 줄에 `resume`·재시도 여부를 싣는 것이 가장 싸다(자리: `packages/claude-runner/src/drivers/claude/run.ts` 의 `runOnce`).
- 러너 표준 오류는 **런마다** SDK 경고 `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] … mcp__dodok__post` 한 줄(+`--trace-warnings` 안내 한 줄)뿐이다 — 한 러너 프로세스에서 두 런이 돌아도 두 번 찍혔다. 그 밖의 경고·오류 줄 0.
- 가짜 러너를 끊으면 60초 뒤 그 토큰의 `runner_down`(warn) 사건이 운영 화면에 남는다 — 이 절차에서는 늘 생긴다.

### 20.5 모델로 보지 않은 것

- **승인·`post`·릴레이** — 쓰기 도구의 승인 카드 허용, `post` 로 카드(components)와 작업 디렉터리 안 파일, `@dev` 릴레이 한 번. 기계 경로(승인 카드·허용·거절·`post` 카드·파일·안/밖 판정)는 「Claude 러너 런 0회 하네스」 절이 실제 번들 CLI 로 끝까지 봤다. 모델이 `post` 의 `components` 를 스키마에 맞게 쓰는지, `artifact://` 이름의 공백을 인코딩하는지는 모른다.
- 카드 누르기가 만드는 다음 러너 런 — `dev:fake` 가짜 러너 위 브라우저 검증이 봤다.

### 20.6 정리·잔여물

- 러너(SIGTERM)·하네스 러너·가짜 API·서버(LISTEN 하는 node PID 에 SIGINT)를 자기 PID 로 내렸다. **3131·3197 LISTEN 0**, 남은 `dodok-runner`·`claude.real`·`dev-fake` 프로세스 0. 발급한 러너 토큰은 내리기 전에 폐기했다(`DELETE /api/v1/setup/runner-tokens/<id>` 204).
- 러너 전용 로그인 디렉터리에서 **이 실연이 만든 세션 자리만** 지웠다 — `projects/<작업 디렉터리 경로>/`(전사 2), `session-env/<런 1·2 세션>/`, 그리고 `/private/tmp/claude-<uid>/<작업 디렉터리 경로>/`. 그 디렉터리의 다른 파일은 열지 않았다. CLI 가 런 중에 바꾼 `.claude.json`·`backups/.claude.json.backup.*`(새로 2)·`cache/model-catalog/`(새로 1)는 로그인·설정 파일이라 두었다 — `.claude.json` 에 작업 디렉터리 경로의 프로젝트 항목이 남았을 수 있다(열어 보지 않았다).
- 스크래치(러너 설치본 둘·감싸개·가짜 API 요청 본문·wire 기록·로그·토큰 파일)와 워크트리 `data/`(드라이버·DB·세션)·`packages/claude-runner/dist` 를 지웠다.
