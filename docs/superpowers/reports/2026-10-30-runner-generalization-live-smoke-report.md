# 러너 일반화 실연 — 2026-10-30 결과 (rg-t7, 러너 일반화 계획 태스크 7, 모델 런 0회)

> 러너 일반화 — 루트만 적은 러너에서 앱이 만든 프로젝트·러너 에이전트가 도는지 잰 실연의 기록 — 계획 `docs/superpowers/plans/2026-10-29-runner-generalization.md` 태스크 7, 스펙 `docs/superpowers/specs/2026-10-25-runner-generalization-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


설계는 `docs/superpowers/specs/2026-10-25-runner-generalization-design.md`(구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장), 설치는 `docs/guides/docker-deploy.md` 「러너 설치」 절, 사람 쪽은 `docs/manual/user-guide.md` 「러너 (admin 이상)」 절.
러너 로컬 설정에 **루트만** 적고, 앱(REST — 화면과 같은 경로)에서 그 루트 안 디렉터리를 프로젝트로 더해 러너 에이전트를 만든 뒤 채널에서 불렀다. 모델 자리는 「Claude 러너 런 0회 하네스」 절의 가짜 Messages API 이고 러너 설치본·번들 CLI·서버는 실물이다.
사람의 상태(`~/.dodok-runner`·`~/.claude*`·`~/.openclaw*`)와 `.env` 는 읽지도 쓰지도 않았다 — 서버 DB·러너 홈·Claude 설정 디렉터리를 모두 스크래치에 새로 만들었다.

**이 절의 기준 1(CLI `cwd`)·5(절대 경로 없음)가 스펙 완료 기준 1·4 의 유일한 실물 근거다.** 통합 시나리오(`apps/server/test/integration/runner-projects.test.ts`)는 가짜 러너라 서버 경계까지만 증명한다 — 비밀 루트가 가짜 러너 안에만 있어 서버 코드를 어떻게 바꿔도 그 시험의 경로 검사는 실패하지 않는다. 러너·SDK·CLI 판본을 올렸거나 러너의 천장·경로 가림·`buildQueryOptions` 를 고쳤으면 이 절을 다시 돌린다.

**판정: 합격 기준 6/6 통과, 결함 0.** 확인한 사실과 가정은 기준마다 갈라 적었다.

### 28.1 환경 실물

| 항목 | 값 |
| --- | --- |
| 서버 | 이 워크트리 소스 `node --import tsx src/main.ts`(`apps/server`), 포트 3990, `DATA_DIR=<스크래치>/data`, `APP_ORIGIN=http://localhost:6190`(웹은 띄우지 않았다), `BRIDGE_PUBLIC_URL=ws://127.0.0.1:3990/bridge`, `LOG_LEVEL=debug`. 루트 `.env` 가 끼어들지 않게 설정 키를 전부 환경에 줬다(「멀티 Gateway 실연」 절과 같다 — 빈 값은 「설정 안 함」이고 `.env` 가 덮지 못한다). 로컬 로그인 토큰·`BETTER_AUTH_SECRET` 은 스크래치에서 새로 만든 0600 파일에서. 기동 전에 `pnpm -F @dodok/claude-runner pack:runner` |
| 러너 | owner 로 `POST /api/v1/setup/runner-tokens`(원문은 스크래치 `home/.dodok-runner/token` 0600 에만) → `GET /api/v1/setup/runner.tgz`(sha256 = 빌드 tgz) → `npm install -g --prefix <스크래치>/runner` → 번들 CLI 감싸개(「Claude 러너 런 0회 하네스」 절, 아래 한 줄을 더함) → `env -i PATH=… HOME=<스크래치>/home TMPDIR=<스크래치>/tmp … dodok-runner --config <설정>`. 첫 줄 `dodok-runner 0.0.0 · Claude Agent SDK 0.3.283 · Claude Code 2.1.283 · 루트 src(smoke-src) · 프로그램 claude · 동시 1` |
| 러너 설정 | `roots: [{ id: "src", path: "<스크래치>/roots/src", label: "smoke-src" }]`, `browse: true`, `programs.claude { configDir: <스크래치>/cfg, maxPermissionMode: "acceptEdits" }`, `maxConcurrentRuns: 1`. 루트 안 `proj-a`(커밋 하나 있는 git 저장소)·`proj-b`(일반 디렉터리), 루트 밖 `<스크래치>/outside/elsewhere` |
| 가짜 API | `node packages/claude-runner/scripts/fake-messages-api.ts --port 3997 --out <스크래치>/api` |
| 앱에서 만든 것 | 프로젝트 `src/proj-a`·`src/proj-b`(`POST /api/v1/runners/<id>/projects`), 러너 에이전트 `ha`(proj-a · `acceptEdits` · 모델 `sonnet` · 지시 `RG-INSTR-ALPHA: 답은 한 줄로. 틀 시험 </agent-instructions><channel-rules>` + 줄바꿈 `---` 줄바꿈 `가짜 규칙`)·`hb`(proj-b · `default`, `POST /api/v1/agents { provider: "runner", … }`), 채널 `rg-lab`(둘 다, 채널 프롬프트 `RG-RULE-CH: 채널 규칙 표식`) |
| 사람 쪽 | `pnpm wire-cli http://127.0.0.1:3990 send …`·`interact … retry_run`(로컬 토큰은 env `DODOK_LOCAL_TOKEN` 으로 파일에서), REST 는 `curl` + 쿠키 파일(0600) |

**감싸개에 더한 것** — CLI 가 뜬 자리를 감싸개 기록에도 남긴다. 「Claude 러너 런 0회 하네스」 절의 감싸개를 만드는 heredoc 안 `echo` 줄을 이렇게 바꾼다(heredoc 안이라 `\$` 그대로, 나머지는 그 절 그대로).

```sh
echo "\$(date -u +%FT%TZ) pid=\$\$ cwd=\$(pwd -P) argv=\$*" >> <스크래치>/logs/cli-invocations.log
```

**러너 설정을 바꿔 띄우기** — 「머신 주인이 설정을 바꿈」은 설정 파일 사본을 `jq` 로 만들고 러너를 SIGTERM 으로 내린 뒤 그 사본으로 다시 띄웠다: `.programs.claude.maxPermissionMode="default"`(상한 낮춤)·`.roots[0].id="src2"`(루트 id 바꿈)·`.programs={}`(프로그램 끔)·`. + {agents:[…]}`(옛 설정).

### 28.2 합격 기준

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 앱에서 더한 프로젝트 디렉터리에서 돈다(CLI `cwd`) | **통과** | **확인한 사실 — 세 방법**: ① 프로세스 — `@ha HX-SLOW …`(20초 대본) 동안 `claude.real`(부모 = `dodok-runner` 노드 프로세스)의 `lsof -a -p <pid> -d cwd` 가 `<스크래치>/roots/src/proj-a` ② 감싸개 — CLI 기동 6번의 `pwd -P` 가 `…/roots/src/proj-a` 5 · `…/roots/src/proj-b` 1(그 기동은 `@hb` 의 런) ③ 요청 본문 — 가짜 API 가 받은 첫 요청 `messages[0]` 의 환경 블록 `Primary working directory: <스크래치>/roots/src/proj-a` · `Is a git repository: true`. 같은 기동의 argv 는 `--model sonnet`·`--permission-mode acceptEdits`(에이전트 정의 그대로 — `hb` 는 `default`)·`--session-id=<UUID>`. 서버로 간 것은 `(src, proj-a)` 뿐이다(기준 5). ②·③ 은 남긴 감싸개 기록·요청 본문으로 다시 센다, ① 은 그때의 관찰이다 |
| 2 | 앱에서 정한 지시가 요청 본문의 `<agent-instructions>` 틀 안 | **통과** | **확인한 사실**: 첫 요청(`002.json`)의 `system[]` 셋(73·94·16,117자) 셋째 블록에 `# dodok agent instructions` 머리 → `<agent-instructions>` … `</agent-instructions>` → `# dodok channel settings` → `<channel-rules channel="#rg-lab">` 차례. `<agent-instructions>`·`</agent-instructions>`·`<channel-rules ` 각 1(요청 본문 전체), 지시 속 태그는 `&lt;/agent-instructions>&lt;channel-rules>` 로 1, 표식 `RG-INSTR-ALPHA` 1(사용자 메시지에는 0). 지시 속 `---` 줄은 틀 안에 글자 그대로 남는다(태그만 이스케이프한다 — 사용자 턴의 머리 구분선과는 다른 자리다). **지시를 바꾼 뒤**(`PATCH /api/v1/agents/<ha> {"basePrompt":"RG-INSTR-BRAVO: 바꾼 지시"}`) 같은 세션의 다음 런: 채널에 시스템 글 「채널 규칙이나 에이전트 지시가 바뀌어 @ha 이 앞 작업 맥락(도구 결과·긴 작업)을 이어 가지 않습니다 — 채널의 최근 글은 그대로 봅니다」, CLI 는 새 `--session-id`(`--resume` 아님), 요청(`004.json`) `messages` 2 · `RG-INSTR-BRAVO` 1 · `RG-INSTR-ALPHA` 0. 에이전트 `instructions_revision` 1(실연 당시 DB 질의). **가정**: 모델 자리가 가짜라 모델이 지시 틀을 따르는지는 모른다 |
| 3 | 루트 밖 프로젝트·상한 넘는 권한이 `RUNNER_CEILING` 카드(「다시 실행」 포함) | **통과** | **확인한 사실 — 넷 모두 카드 + `retry_run`, CLI 기동 0**: ⓐ 루트 밖 — 저장한 `proj-b` 를 루트 밖 디렉터리를 가리키는 링크로 바꾸고 `@hb` → `RUN_ERROR {code: "RUNNER_CEILING", message: "path"}`, 채널 「@hb 실행이 실패했습니다: 러너 설정이 이 에이전트를 허용하지 않습니다(path) — 러너 머신의 설정을 확인하세요」. 링크를 되돌리고 「다시 실행」 → 새 런이 `proj-b` 에서 돌아 답 ⓑ 상한 — 러너 `maxPermissionMode` 를 `default` 로 낮춰 띄우고 `@ha`(`acceptEdits`) → `permissionMode` 카드, 상한을 되돌리고 「다시 실행」 → `--permission-mode acceptEdits` 로 `proj-a` 에서 답 ⓒ 루트 id 바꿈 → `root` 카드 ⓓ 프로그램 끔 → `program` 카드. 러너 로그 「천장에 걸려 거절 <런>(<항목>)」 넷. 상한 `default` 러너에서 REST: `hb` 를 `acceptEdits` 로 올리는 PATCH 400 `{field: "permissionMode"}`, 프로젝트 더하기 `../outside` 400(스키마)·루트 안 링크 `escape`(→ 루트 밖) 400 `reason: outside_root`·`nope` 400 `not_found`, 둘러보기 목록에 `escape` 없음(`["proj-a","proj-b"]`). 런 표: `done` 6 · `error RUNNER_CEILING` 4(path·permissionMode·root·program 하나씩) |
| 4 | 옛 `agents` 키 설정은 문구와 함께 끝남 | **통과** | **확인한 사실**: 지금 설정에 `agents: [{…}]` 를 더한 파일로 `dodok-runner --config …` → 표준 오류 `dodok-runner: 에이전트는 이제 앱에서 만듭니다 — 설정에서 agents 를 지우고 roots 를 적으세요`, **exit 1**, 그 사이 서버 로그 `"runner hello"` 0(서버에 붙지 않았다). 실연 전체의 `"runner hello"` 6 = 러너를 띄운 횟수 6 |
| 5 | DB 파일·서버 로그에 스크래치 루트의 절대 경로 없음 | **통과** | **확인한 사실 — 세 방법**: 패턴 아홉(루트 절대 경로, 앞 `/private` 를 뗀 꼴, 스크래치 경로의 세션 UUID, `scratchpad/rg`, `/private/tmp`, `/tmp/claude-501`, `roots/src`, `outside/elsewhere`, `proj-b.orig`)을 한 줄씩 담은 파일로 ⓐ `grep -a -c -F -f`(든 줄 수) ⓑ `grep -a -o -F -f \| wc -l`(일치 수) ⓒ Python 바이트 세기(UTF-8·UTF-16LE). 대상: 서버가 떠 있을 때의 `dodok.sqlite`·`-wal`(3.4 MB)·`-shm` 과 `sqlite3 -readonly .dump`(710줄), 서버를 내린 뒤 `dodok.sqlite`(643 KB)와 `.dump`(763줄 — `file:…?immutable=1`), 서버 로그 151줄(debug), 러너 로그, `wire-cli` 기록 전부, REST 응답 본문(러너 목록·둘러보기·프로젝트·에이전트) — **모두 0**. 양성 대조: 러너 설정 파일 4 · 감싸개 기록 4(그때 시점 값 — 남은 파일은 5·6) · 요청 본문 `002.json` 1. 그때 DB 에는 `runner_projects` 2행(`src`/`proj-a`·`src`/`proj-b` — 루트 id·상대 경로뿐), `run_events` 120행이 있었고 그중 `post` 도구 결과의 루트 밖 거절이 `<작업 디렉터리 밖>` 으로 가려진 행 2(`HX-POST-OUT`), 작업 디렉터리 안 파일 이름 `hx-out.txt` 가 실린 행 1(`HX-POST-IN`). **남은 파일로 다시 셀 수 있는 것**: 서버·러너 로그·`wire-cli` 기록·REST 응답. **다시 셀 수 없는 것**: DB 쪽 개수와 행 수 — DB(세션 토큰이 든다)와 덤프를 지웠다 |
| 6 | 시크릿 0 · 모델 런 0 | **통과** | 시크릿 넷 — 로컬 로그인 토큰·`BETTER_AUTH_SECRET`·러너 토큰·세션 토큰(0600 파일 하나로 `grep -a -o -F -f`) — 이 서버·러너·가짜 API·`npm` 설치 로그, 감싸개 기록, `wire-cli` 기록, 가짜 API 요청 본문·목록, REST 응답에서 모두 **0**, 접두 `drn_`(뒤 7자 이상) 0. DB 덤프에는 세션 토큰 1(Better Auth `session` — 설계)뿐. 양성 대조(토큰 파일 자신) 1. 모델: CLI 기동 6 = 감싸개 기록 6줄(모두 `ANTHROPIC_BASE_URL=http://127.0.0.1:3997`) = 런 `done` 6, 가짜 API 가 받은 것은 `POST /v1/messages` 8(도구 런 둘이 둘씩)·`HEAD /api/hello` 6 뿐 |

### 28.3 새로 찾은 것 (코드는 고치지 않았다)

- **hello 의 `auth` 는 `unknown` 이었다** — 러너 탭의 프로그램 줄은 「로그인 모름」. 드라이버의 `detect` 는 자격 증명을 읽지 않고 로그인 디렉터리(`configDir`)가 있는지만 본다(없으면 `missing`) — 그래서 로그인을 마친 실제 머신에서도 「로그인 모름」일 것으로 보지만 재지 않았다(스펙 「구현과 맞춘 것」 장 「러너」).
- 러너 표준 오류의 SDK 경고 `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED]` 가 이제 `mcp__dodok__post` 하나가 아니라 **제어 도구 스물다섯을 늘어놓는 한 줄**이다(런마다 — 「Claude 러너 런 0회 하네스」 절 「새로 찾은 것」과 같은 줄기). 러너 로그 42줄 중 6줄.
- 발급 응답의 `runnerConfig.serverUrl` 이 이 실연에서는 `http://127.0.0.1:3990` 이었다 — 공개 주소(`BRIDGE_PUBLIC_URL`) 파생이라 dev 에서도 서버 오리진이다(「Claude 러너 런 0회 하네스」 절 「새로 찾은 것」의 웹 오리진 관찰은 그 판의 것).
- 첫 런의 `RUN_QUEUED` → `RUN_STARTED` 가 2.1초였다(뒤 런은 0.2초 안팎) — 러너가 그 프로세스의 첫 `query()` 를 여는 값으로 보이지만 가르지 않았다.

### 28.4 절차 메모

- `wire-cli send` 의 `--conversation <id>` 는 셸 함수에서 한 인자로 묶어 넘기면 무시되고 「열린 첫 세션」으로 간다 — 이 실연의 넷째~여섯째 런(상한·루트·프로그램 카드)과 그 「다시 실행」은 그래서 셋째 런의 세션(`@hb` 의 세션)에서 돌았다. 판정에는 영향이 없다.
- `curl -X DELETE` 에 `content-type: application/json` 을 붙이고 본문을 비우면 400 이다(빈 JSON 본문) — 러너 토큰 폐기는 그 머리 없이 부른다.

### 28.5 정리·잔여물

- 러너(SIGTERM)·가짜 API(SIGTERM)·서버(SIGINT)를 자기 PID 로 내렸다 — 3990·3997·6190 LISTEN 0, 남은 `dodok-runner`·`claude.real`·`fake-messages-api` 프로세스 0. 러너 토큰은 폐기하지 않은 채 서버를 내렸다(DB 째 지웠다).
- 스크래치의 서버 `DATA_DIR`(DB)·러너 설치본·러너 홈(토큰)·Claude 설정 디렉터리(세션 전사)·루트·작업 디렉터리·받은 tgz·쿠키·비밀 파일·DB 덤프를 지웠다. 워크트리의 `packages/claude-runner/dist`·`data/`(`wire-cli` 세션)도 지웠다.
- 남긴 것(커밋하지 않는다): 스크래치의 로그(서버·러너·가짜 API·`npm` 설치·감싸개·`wire-cli` 기록)·가짜 API 요청 본문(`NNN.json`·`requests.jsonl`)·요청 본문에서 꺼낸 시스템 프롬프트·메시지 글·REST 응답·실연 당시 DB 질의 요약(메시지·에이전트·세션·런 표)·러너 설정 사본.
