# Claude 러너 런 0회 하네스 — 번들 CLI + 가짜 Messages API (p4c-t9a, Claude 러너 계획 태스크 9, 모델 런 0회)

> Claude 러너(Phase 4 ③)를 번들 CLI + 가짜 Messages API 로 두드린 런 0회 하네스 실연의 기록 — 계획 `docs/superpowers/plans/2026-09-27-claude-runner.md` 태스크 9(p4c-t9a), 스펙 `docs/superpowers/specs/2026-09-27-claude-runner-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


Claude 러너 어댑터는 번들 CLI 에 `ANTHROPIC_BASE_URL`(로컬 가짜 Messages API)·가짜 API 키·스크래치 `CLAUDE_CONFIG_DIR` 을 주어 모델 없이 실제 요청 본문과 권한·도구·interrupt 흐름을 두드린다(ADR 0007 「다시 재는 법」).
**실제 서버**(`dev:fake` — 가짜는 Gateway·플러그인뿐이고 러너 어댑터·`/runner`·첨부 HTTP·승인·오케스트레이터는 운영 코드 그대로) + **실제 러너**(서버가 내려준 tgz 를 `npm install -g` 한 설치본) + **실제 번들 CLI**(SDK 가 찾는 그 바이너리)를 끝까지 돌린다. 가짜는 모델 자리의 `packages/claude-runner/scripts/fake-messages-api.ts` 하나다.
러너·SDK·CLI 판본을 올렸을 때, 러너의 `buildQueryOptions`·권한·도구·중지를 고쳤을 때, 그리고 **모델 런 실연(「Claude 러너(Phase 4 ③) 실연」 절) 전에** 한 번 돌린다.

⚠ 이 절의 러너 설정(`agents` — 작업 디렉터리를 러너 설정에 적던 판)과 드라이버의 `register`(`discover?provider=claude` → `POST /agents {provider:"claude", providerAgentId}`)는 러너 일반화 전 꼴이라 지금 러너·서버에서 돌지 않는다. 지금은 설정에 `roots`·`programs` 를 적고 앱에서 프로젝트·러너 에이전트를 만든다 — 「러너 일반화 실연」 절 「환경 실물」 표. 감싸개·가짜 API·요청 본문 요약은 그대로 쓴다.

**판정: 합격 기준 12/12 통과. 제품 결함 0.** 새로 안 것은 「새로 찾은 것」 — 그중 「러너를 `SIGKILL` 로 죽이면 CLI 가 고아로 남아 그 턴을 끝까지 돈다」가 비용·이력 판단 거리다.

### 19.1 구성

| 항목 | 값 |
| --- | --- |
| 서버 | `PORT=3121 APP_ORIGIN=http://localhost:5199 LOG_LEVEL=debug pnpm -F @dodok/server dev:fake`(웹은 띄우지 않는다), 기동 전에 `pnpm -F @dodok/claude-runner pack:runner` — 서버는 부팅 때 `packages/claude-runner/dist` 의 tgz 를 잰다. dev:fake 의 가짜 러너는 `POST /__devfake/runner {"connected":false}` 로 내린다 |
| 러너 | owner 로 `POST /api/v1/setup/runner-tokens` → 원문을 스크래치 `home/.dodok-runner/token`(0600)에만 → `GET /api/v1/setup/runner.tgz` → `npm install -g --prefix <스크래치>/runner <받은 tgz>` → 아래 감싸개 → `env -i PATH=<스크래치>/runner/bin:<node bin>:/usr/bin:/bin HOME=<스크래치>/home LANG=en_US.UTF-8 TMPDIR=<스크래치>/tmp SHELL=/bin/bash USER=$USER dodok-runner --config <스크래치>/runner-config.json` |
| 러너 설정 | `serverUrl` `http://127.0.0.1:3121`(발급 응답의 `runnerConfig.serverUrl` 은 `APP_ORIGIN` 파생이라 dev 에서는 웹 오리진이다 — 「새로 찾은 것」), `tokenFile` `~/.dodok-runner/token`(스크래치 `HOME` 기준), `claudeConfigDir` 스크래치 `cfg/`, 에이전트 `hx`(작업 디렉터리 스크래치 `ws/` — 커밋 하나 있는 git 저장소, 라벨 `hx-ws`, 모델 `sonnet`) |
| 가짜 API | `node packages/claude-runner/scripts/fake-messages-api.ts --port 3197 --out <스크래치>/api` — 대본 키워드는 그 파일 머리 주석의 표. 요청마다 `requests.jsonl` 한 줄과 본문 `NNN.json` |
| 작업 파일 | 작업 디렉터리 안 `hx-out.txt`, 밖 `<스크래치>/hx-outside.txt`, 사람 이미지 8×8 PNG |

**번들 CLI 감싸개.** 러너의 env 허용 목록(`packages/claude-runner/src/drivers/claude/run.ts` 의 `ENV_ALLOWLIST`)은 `ANTHROPIC_*` 를 CLI 로 넘기지 않는다(ADR 0007 「함정」 — 러너 env 가 CLI 로 새지 않게). 그래서 가짜 API 주소는 러너가 아니라 **스크래치 설치본의 번들 CLI 자리**에 얹는다. SDK 는 `@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude` 를 찾아 그대로 spawn 하므로, 진짜 바이너리를 `claude.real` 로 옮기고 그 자리에 셸 조각을 둔다 — **이 설치본의 CLI 는 로컬 주소 없이는 뜨지 않는다.**

```sh
B=<스크래치>/runner/lib/node_modules/@dodok/claude-runner/node_modules/@anthropic-ai/claude-agent-sdk-$(node -p 'process.platform+"-"+process.arch')
mv "$B/claude" "$B/claude.real"
cat > "$B/claude" <<SH
#!/bin/sh
echo "\$(date -u +%FT%TZ) pid=\$\$ argv=\$*" >> <스크래치>/logs/cli-invocations.log
exec /usr/bin/env ANTHROPIC_BASE_URL=http://127.0.0.1:3197 ANTHROPIC_API_KEY=sk-ant-fake-harness-0000 \\
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 DISABLE_AUTOUPDATER=1 \\
  ENABLE_TOOL_SEARCH=true "$B/claude.real" "\$@"
SH
chmod +x "$B/claude"
```

- `ENABLE_TOOL_SEARCH=true` — 가짜 키 모드는 도구 검색이 꺼져 있어 지연 로드를 볼 수 없다(ADR 0007 「함정」의 SDK MCP 도구 지연 로드). 켜야 `alwaysLoad` 를 잰다.
- 러너 전용 로그인(`~/.dodok-runner/claude`)은 쓰지 않는다 — `HOME` 도 `CLAUDE_CONFIG_DIR` 도 스크래치다. 가짜 키라 CLI 의 `apiKeySource` 는 `ANTHROPIC_API_KEY` 이고 런 비용은 `costKind: "api"` 로 온다.

**드라이버.** 사람 쪽(REST·wire)은 `wire-cli` 가 못 하는 것(승인 결정·중지·버튼·러너 토큰 첨부 GET)이 있어 「팀(Phase 4 ②) 실연」 절의 「절차」 처럼 워크트리 `data/`(ignored)에 드라이버를 두고 `pnpm -s exec tsx data/<파일>.mts <명령>` 으로 돌렸다(끝나고 지웠다). `socket.io-client` 로 `auth: {token: <세션>, protocol: 1}`, 이벤트는 스크래치 `wire.jsonl` 에 받은 시각과 함께.

| 명령 | 하는 일 |
| --- | --- |
| `setup` | owner 로그인(`POST /api/v1/auth/local`) → 가짜 러너 끄기 → 러너 토큰 발급(원문은 토큰 파일에만) → tgz 받기 → 채널 둘(`hx-lab`·`hx-other`) |
| `register` | `GET /api/v1/agents/discover?provider=claude` → `POST /api/v1/agents {provider:"claude", providerAgentId:"hx", …}` → `hx-lab` 에 넣기 |
| `send <본문> [--attach <id>] [--approve allow-once\|allow-always\|deny] [--abort-after <n>] [--kill-pid <pid> --kill-after <n> --kill-signal <신호>]` | 구독 → `message.send` → 런이 끝날 때까지 기록. `approval.requested` 가 오면 0.5초 뒤 `approval.resolve`, `TEXT_MESSAGE_CONTENT` 가 n개 오면 `run.abort` 또는 러너 PID 에 신호 |
| `interact <messageId> <componentId> <itemId>` | `component.interact {messageId, componentId, itemId, values: {}}`(「다시 실행」) 뒤 같은 기록 |
| `upload <채널> <파일>` · `status-code <첨부 id>` | 사람 첨부 올리기 · **러너 토큰으로** `GET /runner/attachments/<id>` 의 상태·바이트 수(토큰은 파일에서 읽고 찍지 않는다) |

요청 본문은 작은 스크립트로 요약했다 — `system[]` 블록 길이, 틀 머리 `# dodok channel settings` 와 규칙 표식의 개수(시스템·본문 전체), `messages[]` 블록마다 역할·종류와 표지(`UserPromptSubmit hook additional context`·`[dodok context] 이 턴의 사실`·`[dodok context] channel=`·`deferred`·`mcp__dodok__post`), `tools[]` 이름과 `defer_loading`.

### 19.2 합격 기준

`+ms` 는 드라이버가 보낸 때부터. 런은 모두 `hx-lab` 의 `@hx`.

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 요청의 시스템 프롬프트에 틀 입힌 채널 규칙이 **한 벌만** | **통과** | 채널 프롬프트 `HX-RULE-ALPHA: … <b>태그</b> …` → 첫 런(`--session-id=`) 요청: `system[]` 셋(과금 머리 73자·「You are Claude Code … Claude Agent SDK.」 94자·본문 15,275자), 틀 머리는 **본문 블록 14,277자 자리에 1개**(본문 전체에서도 1), 뒤로 `<channel-rules>`·`<relay-rules>` 가 블록 끝까지. 표식 `HX-RULE-ALPHA` 본문 전체 1, 규칙 안 `<b>` 는 `&lt;b>` 로 1 |
| 2 | 규칙을 바꾼 뒤 런에 새 규칙만 | **통과** | `PATCH /channels/<CH> {"prompt":"HX-RULE-BRAVO: …"}` → 둘째 런은 `--resume=<같은 id>`, 요청 `messages` 5개(앞 턴 3 + 새 턴 2)에 **BRAVO 1 · ALPHA 0**(시스템·본문 전체 둘 다), 틀 머리 1 |
| 3 | `UserPromptSubmit` 훅 문맥 자리 | **통과** | 프롬프트(`messages[0]` 사용자 셋째 블록 `[dodok context] channel=… --- @hx HX-TEXT …`) **뒤의 `role: "system"` 메시지** 안 `<system-reminder>UserPromptSubmit hook additional context: [dodok context] 이 턴의 사실 — …\n참여자: @owner(사람), @hx(에이전트, 나)\n자리: 채널</system-reminder>`. `resume` 한 둘째 런 요청에는 이 블록이 **둘**(앞 턴 것이 이력에 남음 — ADR 0007 「질문별」 채널 프롬프트 표 (나)와 같다) |
| 4 | `mcp__dodok__post` 가 지연 목록에 없음(`alwaysLoad`) | **통과** | `tools[]` 14개 중 `mcp__dodok__post` 가 `input_schema`(`text`·`components`·`files`)째 있고 `defer_loading` 없음. 같은 요청의 「The following deferred tools are now available via ToolSearch」 블록은 12개(`CronCreate` … `WebSearch`)이고 `mcp__dodok__post` 는 없다 |
| 5 | 쓰기 Bash `tool_use` → `canUseTool` → 승인 카드 → 허용 → 도구 결과 | **통과** | `HX-BASH`(`touch hx-note.txt`) — `TOOL_CALL_START Bash` +479 → `approval.requested` +529(`kind: tool`·`toolName: Bash`·`detail: "touch hx-note.txt"`·결정 셋) → `allow-once` +1032 → `approval.resolved allowed` +1034 → `TOOL_CALL_RESULT ok:true "(Bash completed with no output)"` `durationMs` 592 +1069 → 다음 요청의 `tool_result is_error:false` → 최종 답 `HX-BASH-DONE is_error=false …` +1148, 런 `done`, 작업 디렉터리에 `hx-note.txt` 생김. **거절**: `tool_result is_error:true` 「사람이 거절했습니다」 → 답에 그대로, 파일 없음. **항상 허용**: 허용되고 작업 디렉터리에 `.claude/` 가 생기지 않았다(규칙이 `session` 으로만) |
| 6 | 중지 → 메시지 없는 중지 | **통과** | `HX-SLOW` 델타 3개 뒤 `run.abort` +1783 → `RUN_ABORTED {by:"user"}`·런 `aborted` +1785, 러너 「런 끝」 +10ms. 그 런의 에이전트 메시지 0, 가짜 API 에 응답 중 끊김 1건, 남은 CLI 프로세스 0 |
| 7 | 러너를 죽이면 run_error 카드 | **통과** | `HX-SLOW` 델타 3개 뒤 러너 PID 에 `SIGKILL` +1783 → `RUN_ERROR {code:"ADAPTER_UNAVAILABLE", message:"runner disconnected"}` +1787 → 채널 「@hx 실행이 실패했습니다: ADAPTER_UNAVAILABLE」 + 「다시 실행」(`retry_run`) +1790. 러너를 다시 띄우자 6ms 만에 붙고, 「다시 실행」 → 새 런(`parentRunId` = 죽은 런)이 **같은 세션 `--resume`** 으로 끝까지 `done`. 고아 CLI 는 「새로 찾은 것」 |
| 8 | 서버 재시작 → 러너 재접속(판정 R4) | **통과** | 서버 SIGINT → 러너 「서버와 끊겼습니다(transport close) — 도는 런을 멈췄습니다」 → 1초·2초 백오프 → **3.0초 뒤 「연결됨」**, 서버 로그 `runner hello`(같은 토큰 id). 러너는 끝나지 않았다(종료 2 아님). `dev:fake --keep` 로 다시 띄운 뒤 멘션 → `--resume` 으로 답 |
| 9 | 러너가 남의 첨부 GET 404(판정 R5) | **통과** | 러너 토큰 `GET /runner/attachments/<id>`: 사람이 `hx-lab` 에 올린 이미지 — 런 전 **404**, 그 이미지를 단 멘션의 런 안에서 러너가 받은 것 **200**(요청에 `image/png` 블록, 바이트가 원본과 같다), 런 뒤 **404** · `hx-other`(러너 에이전트 없는 채널) 이미지 **404** · 러너가 `post` 로 올린 `hx-out.txt` **200** · 없는 id **404**(본문 53바이트 — 넷 모두 같은 응답) |
| 10 | 파일 보내기 — 안의 파일은 채널 카드, 밖은 거절 | **통과** | `HX-POST-IN`(`files: ["hx-out.txt"]`) → 승인 없이 `message.created` 「하네스가 파일을 보냅니다.」 + 첨부 `{kind:"file", name:"hx-out.txt", size:30}`(최종 답보다 먼저) → 도구 결과 「보냈습니다(메시지 <id>)」. owner 가 받은 파일이 원본과 같다(`cmp`). `HX-POST-OUT`(`files: ["../hx-outside.txt"]`) → 도구 결과 `is_error` 「파일을 보내지 않았습니다 — … - <작업 디렉터리 밖>: 작업 디렉터리 밖을 가리킵니다」, 첨부 메시지 0, 런은 계속돼 `done` |
| 11 | 로그 위생 — 러너 토큰·호스트 경로 0 | **통과** | 러너 토큰 파일로 `grep -a -c -F -f`, 스크래치 경로로도 같게: wire 기록 1,167줄·러너 로그 57줄·서버 로그 두 벌(167줄)·DB 덤프(`messages`·`run_events`·`runs`·`approvals`·`attachments`·`ops_events` 870줄) 전부 **토큰 0 · 경로 0**, 서버 로그 `drn_` 0. 양성 대조(토큰 파일 자신) 1 |
| 12 | 모델 런 0 | **통과** | CLI 기동 14회 = 런 14개 = 감싸개 기록 14줄(모두 `ANTHROPIC_BASE_URL=http://127.0.0.1:3197`). 가짜 API 가 받은 것은 `POST /v1/messages` 64건과 기동마다 `HEAD /api/hello` 1건뿐, 그 밖의 경로 0. 런마다 CLI 한 번 — 「이미 있는 세션」 재시도(`session-in-use`)는 한 번도 나지 않았다 |

### 19.3 절차 메모

- 가짜 API 의 대본은 **마지막 비시스템 메시지**의 도구 결과로 턴을 끝낸다. CLI 는 도구 결과 뒤에도 `role: "system"` 메시지(`<system-reminder>`)를 붙이므로 맨 끝 메시지만 보면 도구 결과를 못 보고 같은 도구를 다시 내 — 승인이 끝없이 되풀이된다(드라이버의 자동 허용과 만나 45번 돌았다). 대본을 고칠 때 이 자리를 지킨다.
- 「새 대화」(`POST /channels/<CH>/agents/<agentId>/reset`)는 서버가 새 UUID 를 정할 뿐이라, 앞 세션 전사는 러너의 `CLAUDE_CONFIG_DIR/projects/<cwd 경로>/` 에 남는다.
- 드라이버의 `send` 는 런이 모두 `done`·`error`·`aborted` 가 된 뒤 1.5초 더 받고 닫는다 — 중지·죽이기 뒤에 늦게 오는 메시지를 보려고.

### 19.4 새로 찾은 것 (코드는 고치지 않았다)

- **러너를 `SIGKILL` 로 죽이면 CLI 가 고아로 남아 그 턴을 끝까지 돈다.** 부모가 `1` 로 바뀐 `claude.real` 이 가짜 API 스트림을 끝까지(약 20초) 받고 스스로 끝났다 — 응답 중 끊김이 없었다. 모델이면 **아무도 못 볼 답에 비용이 든다.** 그리고 그 답이 세션 전사에 남아, 「다시 실행」의 `resume` 요청에 **채널에 없던 앞 답(assistant 메시지)이 이력으로 실린다**(`messages` 34 → 37). 노트북 덮개를 닫는 것(러너 프로세스가 사는 끊김)은 러너가 `interrupt()` 하므로 해당하지 않는다 — 러너 프로세스가 갑자기 죽을 때의 일이다.
- **러너를 `SIGTERM` 으로 끄면 도는 런이 사람 중지와 같은 모양으로 닫힌다** — `RUN_ABORTED {by:"user"}`·런 `aborted`·메시지 없음(러너 스펙 「구현과 맞춘 것」 장의 러너 종료 판정대로). 「다시 실행」 카드가 없어서 채널의 사람은 러너가 꺼진 줄 모르고 활동 탭에 「중지됨」만 본다.
- 러너 표준 오류에 **런마다** SDK 경고 `[CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] canUseTool will not be invoked for: mcp__dodok__post …` 가 한 줄씩 찍힌다(러너 로그 57줄 중 14줄). 의도한 미리 허용(러너 스펙 「승인」 절 마지막 줄)이라 해롭지 않지만, 사람이 러너 터미널에서 보는 줄의 4분의 1이 이 경고다.
- 발급 응답·연결 페이지 설정 예시의 `serverUrl` 이 dev 에서는 `APP_ORIGIN`(웹 오리진)이다 — 기존 이월 「발급 조각 bridgeUrl 이 공개 주소 파생」과 같은 줄기. 배포(한 오리진)에서는 맞다.
- 연결 페이지의 로그인 명령 `CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude` 는 `claude` 가 PATH 에 있다고 가정한다. 러너 tgz 는 번들 CLI 를 품지만 PATH 에 두지 않는다 — `docs/guides/docker-deploy.md` 「러너 설치」 절에 번들 CLI 로 로그인하는 명령을 적었다.
- CLI 는 기동마다 `HEAD <ANTHROPIC_BASE_URL>/api/hello` 를 한 번 보낸다(연결 확인). 가짜 API 는 404 로 답하고 CLI 는 그대로 진행했다.
- 러너 에이전트가 받는 `tools[]` 14개에 Claude Code 기본 도구가 그대로 있다 — `AskUserQuestion`·`Agent`·`Workflow`·`ScheduleWakeup`·`Skill` 등. 사람에게 되묻는 `AskUserQuestion` 이나 예약·하위 에이전트 도구를 모델이 부르면 dodok 에서 어떻게 되는지는 재지 않았다(러너 설정 `disallowedTools` 로 뺄 수 있다).

### 19.5 정리·잔여물

- 러너(SIGTERM)·가짜 API·서버를 자기 PID 로 내렸다. **3121·3197·3198 LISTEN 0**, 남은 `claude.real`·`dodok-runner`·`dev-fake` 프로세스 0.
- 스크래치(러너 설치본·감싸개·`HOME`·`cfg/`(세션 전사 둘)·작업 디렉터리·요청 본문·로그·토큰 파일)와 워크트리 `data/`(드라이버·DB·세션)·`packages/claude-runner/dist` 를 지웠다. 러너 전용 로그인 디렉터리·`~/.claude` 는 읽지도 쓰지도 않았다.
