# 채널 세션 실연 — 2026-10-26 결과 (sessions-t9, 채널 세션 계획 태스크 9, 모델 런 0회)

> 채널 세션이 OpenClaw·러너에서 대화 id 키로 따로 맥락을 갖는지 잰 실연의 기록 — 계획 `docs/superpowers/plans/2026-10-25-channel-sessions.md` 태스크 9, 스펙 `docs/superpowers/specs/2026-10-25-channel-sessions-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


설계는 `docs/superpowers/specs/2026-10-25-channel-sessions-design.md`(구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장), 에이전트 쪽은 `docs/guides/agent-guide.md`, 사람 쪽은 `docs/manual/user-guide.md` 「세션」 절.
한 채널의 세션 둘이 실물 OpenClaw Gateway(9.5)에서 **대화 id 키로 따로 맥락을 갖는지**(스펙 「테스트·검증」 장의 유일한 가정 — OpenClaw 가 대화 id 를 피어로 받는가), 같은 것을 Claude 러너 하네스로, message 툴 호출에 세션 키가 실리는지, 대화 밖 전송이 거절되는지, **세션 기능 전 서버로 만든 DB·Gateway 세션이 올린 뒤 「이전 대화」로 같은 키에 이어지는지**를 쟀다.
사람의 상태(`~/.openclaw`·`~/.openclaw-dev`·`~/.claude*`·`~/.dodok-runner`)와 `.env` 는 읽지도 쓰지도 않았다 — Gateway 상태·공유 토큰·서버 DB·러너 홈을 모두 스크래치에 새로 만들었다.

**판정: 합격 기준 5/5 통과, 공통 조건(시크릿 0·모델 런 0) 지킴. 결함 0.** 확인한 사실과 가정은 기준마다 갈라 적었다. 새로 안 것은 「새로 찾은 것」.

### 26.1 환경 실물

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI·Gateway | 스크래치 설치 `openclaw@2026.9.5` → `OpenClaw 2026.9.5 (ec9c1a1)`(「절차」 절 머리와 같은 설치), 저장소 mise Node 24.21. `OPENCLAW_HOME=<스크래치>/gw`·포트 19041·`gateway run --auth token --bind loopback`(`--dev` 없음), 설정은 「멀티 Gateway 실연」 절 「Gateway 설정」과 같은 `config patch` 한 번, 기본 에이전트 `main`. 서버 로그 `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z"`, scopes `operator.read·write·approvals·admin`(루프백 자동 페어링) · `"bridge plugin hello"` `gatewayVersion="2026.9.5"` |
| 옛 서버(세션 기능 전) | 태스크 1 이전 main 커밋 `6079f74` 을 `git archive 6079f74 \| tar -x -C <스크래치>/old` 로 풀고(워크트리를 만들지 않는다) 그 안에서 `pnpm install --frozen-lockfile` → `pnpm -F @dodok/openclaw-plugin run pack:plugin` → `apps/server` 에서 `node --import tsx src/main.ts`. 소스 실행은 그 트리의 루트로 chdir 해 그 트리의 `.env` 만 찾는다(없다) |
| 새 서버(이 커밋) | 이 워크트리 소스 `node --import tsx src/main.ts`(`apps/server`), **옛 서버와 같은 `DATA_DIR`** — 부팅이 0025~ 마이그레이션을 얹는다. 둘 다 포트 3960, `DATA_DIR=<스크래치>/data`, `APP_ORIGIN=http://localhost:6160`(웹은 띄우지 않았다 — 연결 페이지와 같은 REST 로 했다), `BRIDGE_PUBLIC_URL=ws://127.0.0.1:3960/bridge`, `LOG_LEVEL=debug`. 루트 `.env` 가 끼어들지 않게 설정 키를 전부 환경에 줬다(「멀티 Gateway 실연」 절과 같다). 기동 전에 `pack:plugin`·`pack:runner` |
| 플러그인 | 옛·새 서버마다 「플러그인 받기」와 같은 `GET /api/v1/setup/plugin.tgz`(owner 세션) → sha256 이 그 트리의 `pack:plugin` 빌드 tgz 와 같음 → **Gateway 를 내린 뒤** `plugins install <받은 파일> --force --accept-capabilities` → 설치본 `dist/index.js` sha256 = 그 빌드본. 브리지 토큰은 옛 서버에서 한 번 발급해 `config patch` 뒤 지웠다 — DB 에 남아 새 서버도 같은 토큰으로 받았다(새 서버의 `GET /api/v1/setup/status` `pluginMatches: true`) |
| 가짜 claude CLI | Gateway PATH 앞(아래 26.2). 모델을 부르지 않는다 |
| 러너 | 「Claude 러너 런 0회 하네스」 절 그대로 — 새 서버의 `GET /api/v1/setup/runner.tgz` 를 스크래치에 `npm install -g --prefix`, 번들 CLI 자리에 감싸개(`ANTHROPIC_BASE_URL=http://127.0.0.1:3967`), 가짜 Messages API `packages/claude-runner/scripts/fake-messages-api.ts --port 3967`, `env -i … HOME=<스크래치>` 로 `dodok-runner`(`dodok-runner 0.0.0 · Claude Agent SDK 0.3.283 · Claude Code 2.1.283`), 에이전트 `hx`(작업 디렉터리 스크래치 git 저장소, 모델 `sonnet`) |
| 채널 | `legacy-smoke` — 옛 서버가 만든 채널(올린 뒤 「이전 대화」 하나) · `sessions-smoke` — 새 서버가 만든 채널, 세션 A(제목 「@main 세션 A 첫 질문 ALPHA-1」)·B(「@main 세션 B 첫 질문 BRAVO-1」)·C(사람 글만), `@main`·`@hx` |

### 26.2 절차 — 「멀티 Gateway 실연」·「리액션 실연」 절에 더한 것

> 시스템 프롬프트를 잴 때는 「DM 실연」 절 27.2 처럼 가짜 CLI 가 받은 `appendSystemPrompt` 를 따로 파일로 남긴다 — 3만 자를 넘고 채널 프롬프트는 그 안(그룹 소개 문단 뒤)에 실려, 기록 한 줄에 잘라 적으면 지시를 못 찾는다.

**가짜 claude CLI.** 「리액션 실연」 절 23.2 의 프롬프트를 적는 CLI 에 둘을 더했다. ① `invoke` 줄에 argv(인자마다 6,000자까지)와 `--session-id`·`--resume` 값, `prompt` 줄에 첫 `user` 레코드 원문(8,000자까지)을 적는다. ② `-p` 런이면 `<스크래치>/fake/calls.json`(배열 `{label, name, arguments}`)이 있을 때 읽고 지운 뒤, 11.4 처럼 `--mcp-config` 의 루프백 `/mcp` 에 `tools/call` 을 차례로 부르고 결과 원문을 적는다. 최종 답은 `FAKE_CLI_DONE sid=<세션 id 앞 8자> <label>=ok|error …`.
⚠ 9.5 의 `user` 레코드 `content` 는 문자열 하나이고, 앞에 OpenClaw 가 붙인 `Conversation info: ⟦openclaw:ctx⟧` JSON 블록(`chat_id` 등), 그 뒤에 플러그인 헤더·`---`·사람 글이 온다. `jq -r .text … | tail -1` 처럼 줄로 자르면 사람 글 줄만 남아 「헤더가 없다」로 오판한다 — `capture` 로 꺼낸다.

```bash
jq -c 'select(.event=="prompt") | {sid: .sid[0:8],
  chat_id: (.text | capture("\"chat_id\":\"(?<c>[^\"]+)\"").c),
  session: (.text | capture("\n세션: (?<s>[^\n]*)").s),
  recent: ([.text | scan("\n\\[[0-9:]+\\] [^\n]*")] | map(.[1:])),
  last: (.text | split("\n---\n") | last)}' <스크래치>/fake/out/fake-claude.jsonl
```

**9.5 Gateway 의 세션 저장소.** 새로 만든 9.5 상태에서 세션은 파일이 아니라 SQLite 다 — `<OPENCLAW_HOME>/.openclaw/agents/<에이전트>/agent/openclaw-agent.sqlite`. 읽기 전용으로 연다.

```bash
A="file:$SP/gw/.openclaw/agents/main/agent/openclaw-agent.sqlite?mode=ro"
sqlite3 "$A" "select session_key, current_session_id, display_name from session_nodes order by created_at"   # 키마다 OpenClaw 세션 하나
sqlite3 "$A" "select w.session_key, count(*), sum(instr(e.event_json,'ALPHA')>0), sum(instr(e.event_json,'BRAVO')>0)
              from transcript_events e join session_windows w using(session_id) group by w.session_key"         # 전사 사건 수·표식이 든 사건 수
```

**순서**(런은 하나씩 끝난 뒤 다음): ① 옛 서버 + 옛 플러그인으로 `legacy-smoke` 를 만들고 `@main 옛 서버 첫 질문 LEGACY-1`(옛 `wire-cli` — 옛 트리의 `scripts/wire-cli.ts`) ② 옛 서버·Gateway 를 내리고 새 서버를 같은 `DATA_DIR` 로 띄움 → 새 플러그인 설치 → Gateway 다시 띄움 ③ `legacy-smoke` 에 세션을 주지 않고 `@main 올린 뒤 둘째 질문 LEGACY-2` ④ `sessions-smoke` 에 `--new-session` 으로 A·B 를 만들며 `@main` 첫 질문, 이어 `--conversation` 으로 A·B 둘째 질문 ⑤ `calls.json` 을 두고 A 에서 `@main … TOOLPROBE` ⑥ A·B 에서 `@hx HX-TEXT …` 를 차례로 두 번씩 ⑦ 사람 글만 있는 세션 C 를 만들고 운영자 `tools.invoke`(세션 키 없이 — 10.2 (d) 에서 `sessionKey` 를 뺀 꼴)로 B·C 에 `message`.

### 26.3 합격 기준

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 한 채널의 세션 둘이 대화 id 키로 따로 맥락을 갖는다 — OpenClaw | **통과** | **확인한 사실**: ack `conversation=<A>`·`<B>` → `RUN_STARTED sessionKey=agent:main:dodok:channel:<A>`·`…:<B>`. Gateway `session_nodes` 에 키 셋(`legacy-smoke` 의 「이전 대화」·A·B)이 **서로 다른 `current_session_id`** 로, `display_name` 은 `dodok:g-<대화 id>`. 전사 사건 수 키마다 5, A 키는 `ALPHA` 2·`BRAVO` 0, B 키는 `ALPHA` 0·`BRAVO` 2(실연 당시 질의 — 남은 파일로 다시 셀 수 없다, 26.6). 모델 입력: A 런의 `chat_id` 는 `channel:<A>`, 헤더 `세션: @main 세션 A 첫 질문 ALPHA-1`, A 둘째 턴의 「최근 대화」는 A 의 첫 질문·답 두 줄뿐(B 둘째 턴도 B 의 두 줄뿐). **가정**: 가짜 CLI 는 claude 전사를 만들지 않아 런마다 새 CLI 세션 id 를 받는다(11.3 「세션을 잴 때」 1) — 「맥락」은 OpenClaw 세션·전사와 모델 입력 헤더로 봤고, 진짜 claude 세션의 `--resume` 은 재지 않았다 |
| 2 | 같은 것 — Claude 러너 | **통과** | **확인한 사실**: 감싸개 기록 넷 — A `--session-id=a65dbfad…` → 둘째 턴 `--resume=a65dbfad…`, B `--session-id=9755c5ac…` → `--resume=9755c5ac…`(세션 행마다 Claude 세션 하나). `RUN_STARTED sessionKey=agent:hx:dodok:channel:<A>`·`…:<B>`. 가짜 API 가 받은 A 둘째 턴 요청 본문에 `ALPHA` 6·`BRAVO` 0, B 둘째 턴에 `ALPHA` 0·`BRAVO` 6(실연 당시 질의 — 남은 파일로 다시 셀 수 없다, 26.6). 턴 사실(`UserPromptSubmit hook additional context`)은 `[dodok context] 이 턴의 사실 — …` · **`세션: @main 세션 A 첫 질문 ALPHA-1`**(둘째 줄) · `참여자: …` · `자리: 채널`, 프롬프트의 「최근 대화」는 그 세션 글만(A 에는 `@main` 답·툴로 보낸 글 포함) |
| 3 | message 툴 호출(`handleAction`)에 세션 키가 실린다 | **통과**(모델 런 경로는 가짜 CLI 로) | **확인한 사실**: Gateway 로그 `dodok:tool-send` 넷(⑤) 모두 `"sessionKey":"agent:main:dodok:channel:<A>"`·`"agentId":"main"`, 인자 키에 `__sessionKey`·`__agentId` — `"sessionKey":null` 인 줄 0. 자기 세션으로 보낸 글은 A 에 `runId` = 그 런, `replyTo` = 사람 글로 저장. 세션 키를 주지 않은 운영자 `tools.invoke` 둘(⑦)에는 Gateway 가 `"sessionKey":"agent:main:main"` 을 채웠고 플러그인이 dodok 밖 세션으로 보고 거절했다. **가정**: 가짜 CLI 가 부른 것은 run grant 의 루프백 `/mcp` — 진짜 모델 런의 CLI 와 같은 통로라 세션 키는 모델이 아니라 Gateway 가 붙인다고 본다. **못 본 것**: 실제 모델이 내는 호출(모델 런 금지), `actionCtx.sessionKey` 가 비는 갈래(이번에 만든 어떤 길에서도 닿지 않았다) |
| 4 | 마이그레이션 뒤 「이전 대화」에서 기존 OpenClaw 세션이 같은 키로 이어진다 | **통과** | **확인한 사실**: 옛 서버 런 `sessionKey=agent:main:dodok:channel:<legacy-smoke 채널 id>`, Gateway `session_nodes` 한 줄(`current_session_id` `e3f680a6…`)·전사 사건 3. 새 서버 첫 부팅 뒤 DB: `conversations` 에 id = 채널 id·「이전 대화」·`title_source user`·`last_seq 2`, `agent_sessions`·`runs` 의 `conversation_id` = 채널 id·`session_key` 그대로, 메시지 둘 모두 그 대화. 새 플러그인으로 세션을 주지 않고 보낸 글 → ack `conversation=<채널 id>`(최근 열린 세션) → `RUN_STARTED` 의 키가 옛 키와 같고, Gateway 는 **같은 키·같은 `current_session_id` `e3f680a6…`** 에 전사를 3 → 5 로 이었다. 새 사람 글 사건의 헤더는 `세션: 이전 대화` 와 「최근 대화」의 `LEGACY-1` 줄. **못 본 것**: 진짜 claude CLI 세션의 `--resume` 이 올린 뒤에도 이어지는지 — 가짜 CLI 의 CLI 세션 id 는 `0fa7f3e1…` → `1fa2bcc4…` 로 새로 났다(전사가 없다, 11.3) |
| 5 | 다른 세션·다른 채널로 보내는 툴 호출은 「이 대화에만 보낼 수 있습니다」 | **통과** | **확인한 사실**: A 의 런에서 `message` 넷 — 자기 세션(`channel:<A>`) `isError:false`, 같은 채널 B(`channel:<B>`)·다른 채널의 「이전 대화」(`channel:<legacy-smoke 채널 id>`)·채널 id(`channel:<sessions-smoke 채널 id>` — 대화가 아니다) 셋은 도구 결과 `{"type":"text","text":"이 대화에만 보낼 수 있습니다"}`·`isError:true`, tool-send 줄 `"ok":false,"error":"이 대화에만 보낼 수 있습니다"`. 서버 DB 에 `TOOL-` 표식 글은 A 의 하나뿐. 세션 키 없는 `tools.invoke` 의 B·C 행도 같은 사유(`code: internal_error`). **못 본 것**: 플러그인을 거치지 않은 정본을 서버가 거절하는 것 — 실물 플러그인으로는 만들 수 없다(통합 `apps/server/test/integration/conversations.test.ts` 「[Review Focus 4] …」 둘이 본다). 러너 `post` 는 대상 인자가 없어 다른 세션을 겨눌 수 없다 |
| 6 | 시크릿 0 · 모델 런 0 | **통과** | Gateway 공유 토큰·로컬 로그인 토큰·세션 토큰·러너 토큰·브리지 토큰(0600 파일 하나로 `grep -a -c -F -f`)이 서버(옛·새)·Gateway·러너·가짜 API·감싸개·설치 로그, 가짜 CLI 기록, 가짜 API 요청 목록, 공용 `/tmp/openclaw/openclaw-<날짜>.log`, `wire-cli` 세션 파일(옛·새 트리)에서 모두 **0**, 접두 `dbt_`·`drn_`(뒤 7자 이상)도 서버·Gateway·러너 로그에 0. DB 덤프에는 Gateway 공유 토큰 1(`gateways`, 설계 — 평문 저장)·세션 토큰 1(Better Auth `session`)뿐, 로컬·러너·브리지 토큰 0. 양성 대조(토큰 파일 자신) 5. 모델: Gateway `cli exec: provider=claude-cli` 7줄 = 가짜 CLI `-p` 7회 = OpenClaw 런 7건(비용 0), `-p` 없는 호출 7회는 고정값으로 답했다(진짜 `claude` 0회). 러너 번들 CLI 4회 = 감싸개 기록 4줄, 가짜 API 가 받은 것은 `POST /v1/messages` 4·`HEAD /api/hello` 4 뿐 |

### 26.4 새로 찾은 것 (코드는 고치지 않았다)

- **9.5 는 세션 키를 주지 않은 운영자 `tools.invoke` 에 `agent:<에이전트>:main` 을 채운다** — 그래서 플러그인이 dodok 밖 세션으로 보고 「이 대화에만 보낼 수 있습니다」로 거절한다. 운영자가 `message` 툴로 dodok 에 보내려면 10.2 (d) 처럼 그 대화의 dodok 세션 키를 준다(그대로 맞다).
- **모델 입력의 `Conversation info` 블록은 `chat_id`·`conversation_label`·`group_subject` 가 모두 `channel:<대화 id>`/대화 id 다** — 모델이 사람에게 보이는 이름 대신 uuid 를 본다. 세션 제목은 플러그인 헤더의 `세션:` 줄로만 간다. 헤더 첫 줄 `[dodok context] channel=` 은 채널 id 다(스펙 「구현과 맞춘 것」 장 — 설계대로).
- **새로 만든 9.5 상태에서 Gateway 세션은 SQLite(`agents/<에이전트>/agent/openclaw-agent.sqlite`)에 있다** — 세션 키 → OpenClaw 세션 id 는 `session_nodes`, 전사는 `transcript_events`(26.2). 이 판에서 세션을 재는 실연은 이 표를 본다.
- `message` 툴을 쓴 런의 최종 답(`FAKE_CLI_DONE …`)은 `RUN_FINISHED` 뒤 같은 `runId` 의 둘째 메시지로 왔다 — `docs/guides/plan.md` 8장 「이월」 「스레드·검색」 묶음의 줄과 같은 것이고 세션과 무관하다.

### 26.5 사람이 볼 것

- 실제 모델로 두 세션의 대화가 섞이지 않는지 — 진짜 claude 세션 전사·`--resume` 은 가짜 CLI 로 재지 못한다(기준 1·4). 러너는 실제 번들 CLI 가 세션마다 `--resume` 하는 것까지 봤다(기준 2).
- 운영 중인 DB(세션 기능 전 서버로 쓰던 것)를 올렸을 때 원격 Gateway 판에서 「이전 대화」가 같은 키로 이어지는지 — 이번에는 로컬 9.5 와 빈 DB 에 런 하나였다.

### 26.6 정리·잔여물

- 러너(SIGTERM)·가짜 API·서버(SIGINT)·Gateway 를 자기 PID 로 내렸다 — 19041·3960·6160·3967 LISTEN 0, 남은 `dodok-runner`·`claude.real`·`fake-messages-api` 프로세스 0(이 실연의 것). 홈의 `~/.openclaw`·`~/.openclaw-dev` 는 시작 전후 수정 시각이 같다(`stat`).
- 스크래치의 Gateway 상태·서버 `DATA_DIR`·옛 트리·CLI 설치본·러너 설치본·러너 홈(토큰)·토큰 파일·받은 tgz·DB 덤프를 지웠다. 워크트리의 `packages/openclaw-plugin/dist`·`packages/claude-runner/dist`·`data/` 도 지웠다(남기면 「제어 MCP 실연」 절 「새로 찾은 것」의 서버 테스트가 실패한다).
- 남긴 것: 공용 `/tmp/openclaw/openclaw-<날짜>.log`(다른 Gateway 도 쓰는 날짜 파일 — 시크릿 0), 스크래치의 로그·가짜 CLI 기록·기준별 요약(커밋하지 않는다). 가짜 API 요청 본문·Gateway 세션 DB·`RUN_STARTED`/ack 줄은 남기지 않았다. 기준 1·2 의 `ALPHA`/`BRAVO` 수와 전사 수는 실연 당시 질의 결과이고 남은 파일로 다시 셀 수 없다. 남은 증거: `criterion1-nodes.txt`·`criterion1-prompts.jsonl`·`legacy-before/after.txt`·`fake/out/fake-claude.jsonl`·감싸개 로그.
