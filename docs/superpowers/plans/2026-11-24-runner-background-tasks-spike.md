# 러너 백그라운드 작업 — 1단계 스파이크 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 Orca 가 살아 있으면 `scripts/orca-worker.sh` 워커가 실행한다(AGENTS.md 「작업 방식」).

**Goal:** 설계 5.9 의 다섯 가지를 모델 런 0회로 재서, 2단계 구현 계획의 전제(헤드리스 CLI 가 작업 알림 뒤 스스로 턴을 여는가 등)를 확정한다.

**Architecture:** 가짜 Messages API(`packages/claude-runner/scripts/fake-messages-api.ts`)에 백그라운드 대본을 더하고, 러너를 거치지 않는 일회용 SDK 드라이버로 `query()` 를 직접 열어 모든 SDK 메시지를 시각과 함께 기록한다. 결과는 ADR 0007 에 덧붙인다.

**Tech Stack:** Node 24.21.0, `@anthropic-ai/claude-agent-sdk@0.3.283`(설치된 `claude` 실행 파일), 가짜 Messages API.

**Spec:** `docs/superpowers/specs/2026-11-24-runner-background-tasks-design.md`(특히 5.1·5.2·5.3·5.9)

## Global Constraints

- **모델 런 0회.** CLI 는 가짜 API 에만 묻는다 — `ANTHROPIC_BASE_URL=http://127.0.0.1:<가짜 API 포트>`, `ANTHROPIC_API_KEY=sk-ant-fake-harness-0000`. 실제 키·실제 로그인을 쓰지 않는다.
- `HOME`·`CLAUDE_CONFIG_DIR`·`TMPDIR` 은 스크래치. 러너 전용 로그인 `~/.dodok-runner/claude` 와 사람의 `~/.claude` 를 쓰지 않는다.
- CLI 끄기 변수는 하네스와 같게: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1`.
- 실행 파일은 이 머신의 `claude`(`command -v claude`) — 러너가 먼저 쓰는 것이다(`docs/guides/live-smoke.md` 11절 「CLI 감싸개」). 판본을 보고서에 적는다.
- 스파이크 드라이버·전사·기록은 커밋하지 않는다 — 자리는 `.superpowers/sdd/2026-11-24-runner-bg-spike/`(git 제외, ADR 0007 「근거 원장」과 같은 관례).
- 커밋은 경로를 명시해 stage(`git add -A` 금지). Conventional Commits.
- 스파이크가 띄운 `sleep` 등 자식 프로세스는 시나리오마다 끝에 지운다(아래 Review Focus 2).

## Review Focus

- **작업 알림 요청이 첫 프롬프트 대본을 다시 고르는 것.** 가짜 API 의 `lastPromptBody` 는 뒤에서부터 `[dodok context]` 머리를 찾으므로, 알림 턴의 요청에도 첫 프롬프트(`HX-BG-BASH`)가 걸려 백그라운드 셸을 또 띄운다 — 무한 반복. Task 1 이 알림 판정을 프롬프트 찾기보다 먼저 한다. Task 2 의 `requests.jsonl` 에서 시나리오 열이 `HX-BG-FOLLOWUP` 인지 본다.
- **`sleep 100000` 이 남는 것.** 스파이크가 끝나도 CLI 가 고아 셸을 남길 수 있다. 시나리오마다 끝에 `pgrep -f hx-bg-forever` 가 비어 있는지 보고, 남았으면 지우고 그 사실을 보고서에 적는다.
- **서브에이전트 요청이 dodok 대본으로 가는 것.** 서브에이전트의 요청에는 `[dodok context]` 머리가 없어 `aux` 로 가야 한다(`HX-SUB-SLOW` 만 예외). `requests.jsonl` 로 확인한다.
- **첫 `result` 를 끝으로 읽는 것.** 드라이버는 `result` 뒤에도 정해진 시간 동안 계속 읽고 모든 메시지를 남긴다 — 「둘째 result 가 없었다」는 그 시간 동안 없었다는 뜻으로 적는다(관찰 시간 명시).
- **보고서에 호스트 경로·계정이 실리는 것.** `output_file` 경로는 스크래치 아래이므로 그대로 둬도 되지만, 사람 홈 경로가 보이면 `~` 로 줄인다.

---

### Task 1: 가짜 Messages API 에 백그라운드 대본 더하기

**Files:**
- Modify: `packages/claude-runner/scripts/fake-messages-api.ts`(머리 주석의 대본 표, `SCRIPTS`, `plan()`)
- Modify: `docs/guides/live-smoke.md` 11절 — 대본 키워드는 그 파일 머리 주석이 정본이라 표를 옮기지 않고, 「백그라운드 대본은 ADR 0007 5.10 스파이크에 쓴다」 한 줄만

**Interfaces:**
- Produces: 키워드 `HX-BG-BASH`·`HX-BG-FOREVER`·`HX-BG-AGENT`·`HX-SUB-SLOW`, 알림 턴 시나리오 이름 `HX-BG-FOLLOWUP`(`requests.jsonl` 의 `scenario`). Task 2 가 이 이름으로 기록을 거른다.

- [ ] **Step 1: 대본 넷을 `SCRIPTS` 에 더한다**
  - `HX-BG-BASH` → `Bash` `{ command: "sleep 3; echo hx-bg-done", description: "Harness background shell", run_in_background: true }`
  - `HX-BG-FOREVER` → `Bash` `{ command: "sleep 100000 # hx-bg-forever", description: "Harness endless shell", run_in_background: true }`
  - `HX-BG-AGENT` → 서브에이전트 도구 `{ description: "Harness subagent", prompt: "HX-SUB-SLOW 하위 작업", subagent_type: "general-purpose", run_in_background: true }`. 도구 이름은 이 CLI 판의 첫 요청 본문 `tools[].name` 에서 고른다(`Agent` 또는 `Task` — 둘 다 있으면 `Agent`). 고른 이름을 대본 주석에 적는다.
  - 모두 `intervalMs: 20`. 도구 결과가 돌아오면 지금 `plan()` 이 `<키>-DONE` 글로 턴을 끝낸다(바꾸지 않는다).

- [ ] **Step 2: `plan()` 에 두 판정을 더한다 — 순서가 중요하다**
  1. 도구 결과 판정(지금 것) 다음, 프롬프트 찾기 **전**에: 마지막 비-system 메시지가 `user` 이고 도구 결과가 없으며 그 글에 `task-notification`(대소문자 무시)이나 `Background command` 가 있으면 시나리오 `HX-BG-FOLLOWUP`, 글 10조각을 0.5초 간격(5초)으로 — 첫 조각은 `HX-BG-FOLLOWUP `, 마지막 조각에 그 알림 글 앞 200자를 공백을 줄여 싣는다. 5초인 까닭: 설계 5.9-2(도는 추가 응답 턴에 사람 글 넣기)를 재려면 턴이 잠시 돌아야 한다.
  2. `[dodok context]` 머리가 없는 요청(지금 `aux`)이면서 첫 `user` 메시지 글에 `HX-SUB-SLOW` 가 있으면 시나리오 `HX-SUB-SLOW`, 글 40조각 0.5초 간격(20초) — 서브에이전트 끄기(5.9-3)를 재기 위해서다.
  - 알림 글의 실제 모양은 모른다. 판정이 빗나가면 Task 2 에서 `NNN.json` 을 보고 판정 문자열을 고친 뒤 이 커밋을 고친다(amend 가 아니라 새 커밋).

- [ ] **Step 3: 머리 주석의 대본 표에 다섯 줄(넷 + `HX-BG-FOLLOWUP` 판정)을 더한다**

- [ ] **Step 4: 정적 검사**

Run: `pnpm -F @dodok/runner typecheck && pnpm lint && pnpm fmt:check`
Expected: 오류 0(`scripts` 는 runner tsconfig 의 include 에 든다)

- [ ] **Step 5: 손으로 한 번 띄워 본다**

Run: `node packages/claude-runner/scripts/fake-messages-api.ts --port 3197 --out <스크래치>/api` 를 띄우고 `curl -s -X POST http://127.0.0.1:3197/v1/messages -H 'content-type: application/json' -d '{"model":"x","stream":false,"messages":[{"role":"user","content":"<task-notification>done</task-notification>"}]}'`
Expected: 응답 글이 `HX-BG-FOLLOWUP` 로 시작하고 `requests.jsonl` 마지막 줄 `scenario` 가 `HX-BG-FOLLOWUP`. 같은 요청에 앞쪽 user 메시지로 `[dodok context] channel=x\n---\nHX-BG-BASH` 를 더해도 결과가 같다(Review Focus 1).

- [ ] **Step 6: Commit**

```bash
git add packages/claude-runner/scripts/fake-messages-api.ts docs/guides/live-smoke.md
git commit -m "test(runner): background task scripts in fake messages api"
```

---

### Task 2: SDK 직접 드라이버로 다섯 가지를 잰다

**Files(커밋하지 않음):**
- Create: `.superpowers/sdd/2026-11-24-runner-bg-spike/spike.mts`
- Create: `.superpowers/sdd/2026-11-24-runner-bg-spike/<시나리오>/messages.jsonl`, `api/`(가짜 API 기록), `spike-report.md`

**Interfaces:**
- Consumes: Task 1 의 키워드·시나리오 이름.
- Produces: `spike-report.md` — 아래 5 질문마다 「예/아니오 + 근거 메시지 줄(시각·type·subtype·주요 필드)」, CLI 판본, 관찰 시간. Task 3 이 이것을 ADR 로 옮긴다.

- [ ] **Step 1: 드라이버 `spike.mts` 를 쓴다**
  - SDK 는 워크트리의 `packages/claude-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` 를 절대 경로로 import 한다(러너 코드를 거치지 않는다).
  - 인자: `--scenario <bash|fold|stop|agent|interrupt> --api-port <n> --out <디렉터리> [--observe-ms 30000]`.
  - `query({ prompt, options })` — `prompt` 는 닫기 전까지 열린 async 반복자(러너의 `prompt()` 처럼 `yield` 뒤 대기, 드라이버가 나중에 더 넣을 수 있게 큐로). `options`: `pathToClaudeCodeExecutable` = `command -v claude`, `cwd` = 스크래치 `work/`(빈 git 저장소), `env` = Global Constraints 의 값 + `PATH`·`HOME`·`TMPDIR`·`CLAUDE_CONFIG_DIR`(스크래치), `permissionMode: "bypassPermissions"`(권한 콜백은 이번 질문이 아니다 — 보고서에 적는다), `includePartialMessages: true`.
  - 프롬프트 글은 `[dodok context] channel=spike\n---\n<키워드>` 꼴(가짜 API 의 `lastPromptBody` 가 찾는 머리).
  - 모든 SDK 메시지를 `{ t: <시작부터 ms>, type, subtype, ...그 메시지 }` 로 `messages.jsonl` 에 한 줄씩. `stream_event` 는 `event.type` 만 남겨 줄인다.
  - 관찰 시간(`--observe-ms`)이 지나거나 시나리오가 끝나면 입력을 닫고 `close()`, 그 뒤 `pgrep -f hx-bg-forever` 결과를 기록한다.

- [ ] **Step 2: 시나리오를 차례로 돌린다** (가짜 API 는 시나리오마다 새 `--out`)
  1. `bash` — `HX-BG-BASH`. 첫 `result` 뒤 입력을 연 채 30초 관찰. **잴 것(5.9-1):** 사용자 입력 없이 둘째 턴(`HX-BG-FOLLOWUP` 요청 → `assistant` → `result`)이 오는가, 그 앞뒤의 `task_started`·`task_progress`·`task_updated`·`background_tasks_changed`·`task_notification` 순서와 필드(`task_type`·`is_backgrounded`·`ambient`·`output_file`·`summary`), 둘째 `result` 의 `num_turns`·`total_cost_usd`.
  2. `fold` — `bash` 와 같이 시작하고, 추가 응답 턴의 첫 `stream_event` 가 오면 1초 뒤 `[dodok context] channel=spike\n---\nHX-TEXT` 를 입력으로 넣는다. **잴 것(5.9-2):** 그 글이 도는 턴에 합쳐지는가(다음 API 요청의 messages 에 HX-TEXT 가 같은 턴으로 들어가고 `result` 가 하나), 아니면 다음 턴인가(`result` 가 둘).
  3. `stop` — `HX-BG-FOREVER`. `background_tasks_changed` 에 작업이 하나 보이면 `stopTask(task_id)`. 이어서 `HX-BG-AGENT` 를 넣고 서브에이전트 작업이 보이면 그것도 `stopTask`. **잴 것(5.9-3):** 둘 다 `task_notification { status: "stopped" }`·빈 `background_tasks_changed` 가 오는가, 끈 뒤 추가 응답 턴이 열리는가, `pgrep` 이 비는가.
  4. `agent` — `HX-BG-AGENT` 를 넣되 서브에이전트가 20초 걸린다(`HX-SUB-SLOW`). 60초 관찰. **잴 것(5.9-4):** `task_started { task_type, is_backgrounded, subagent_type }`, 서브에이전트의 `parent_tool_use_id` 달린 메시지가 오는가, 끝난 뒤 1 처럼 턴이 열리는가.
  5. `interrupt` — `HX-BG-FOREVER` 의 `result` 뒤 `HX-SLOW` 를 넣고, 그 턴의 첫 `stream_event` 2초 뒤 `interrupt()`. **잴 것(5.9-5):** 백그라운드 셸이 살아남는가(`task_updated { status: "killed" }`·`background_tasks_changed` 변화·`pgrep`). 비교로, 첫 프롬프트 턴 도중(도구 결과 전)에 interrupt 하는 변형도 한 번.

- [ ] **Step 3: `spike-report.md` 를 쓴다** — 질문 1~5 마다 답·근거 줄, 그리고 설계 5.2·5.3 의 가정(① 스스로 턴을 연다 ② 한 번에 한 턴은 러너가 맞춰야 하는가 ③ `stopTask` 로 끈다 ④ 서브에이전트도 같다 ⑤ 턴만 interrupt 하면 작업이 남는다)마다 「맞음/틀림/모름」. 예상과 다른 메시지·필드가 있으면 그대로 적는다.

- [ ] **Step 4: 남은 프로세스 확인**

Run: `pgrep -fl 'hx-bg-forever|sleep 100000'`
Expected: 출력 없음. 남았으면 그 PID 만 지우고 보고서에 적는다.

---

### Task 3: ADR 0007 에 결과를 덧붙이고 설계에 잇는다

**Files:**
- Modify: `docs/adr/0007-claude-agent-sdk-spike.md` — 새 절 「5.10 백그라운드 작업과 붙든 프로세스(2026-11-24)」(번호는 그 문서의 마지막 5.x 다음으로 — 있으면 맞춘다), 1장 결론 표에 한 줄, 「근거 원장」에 `.superpowers/sdd/2026-11-24-runner-bg-spike/spike-report.md`
- Modify: `docs/superpowers/specs/2026-11-24-runner-background-tasks-design.md` — 5.9 끝에 「결과: ADR 0007 5.10」 한 줄과, 가정이 틀린 항목마다 「틀림 — 2단계에서 다시 정함」 표시(설계 본문은 고치지 않는다 — 다시 정하는 것은 사용자와 한다)

**Interfaces:**
- Consumes: Task 2 의 `spike-report.md`.

- [ ] **Step 1: ADR 절을 쓴다** — CLI·SDK 판본, 다섯 질문의 답, 메시지 순서 예시 하나(시나리오 1, 10줄 안팎), 함정(예상 밖 동작). 출처 인용 규칙은 `docs/guideline/base/04-citation.md`.
- [ ] **Step 2: 설계 5.9 에 결과 줄과 표시를 단다**
- [ ] **Step 3: 문서 눈 확인** — `---` 앞 빈 줄, 표 줄(oxfmt 는 md 를 보지 않는다).
- [ ] **Step 4: Commit**

```bash
git add docs/adr/0007-claude-agent-sdk-spike.md docs/superpowers/specs/2026-11-24-runner-background-tasks-design.md
git commit -m "docs(adr): background tasks spike results"
```

- [ ] **Step 5: 메인 세션에 보고** — 다섯 질문의 답 한 줄씩, 틀린 가정 목록, 2단계 계획 전에 사용자가 정할 것(특히 1 이 「아니오」면 합성 입력 대안).
