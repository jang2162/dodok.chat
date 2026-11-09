# 그룹 DM 실연 — 2026-11-09 결과 (human-dm-t7, 사람 간 DM 계획 태스크 7, 모델 런 0회)

> 그룹 DM(사람 여럿 + 에이전트)의 한 세션이 OpenClaw 모델 입력과 러너 요청에 무엇으로 실리는지 잰 실연의 기록 — 계획 `docs/superpowers/plans/2026-11-03-human-dm.md` 태스크 7, 스펙 `docs/superpowers/specs/2026-11-03-human-dm-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다(그룹 DM 에만 해당하는 것은 그 문서 「그룹 DM 실연」 절).

설계는 스펙(구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장), 에이전트 쪽은 `docs/guides/agent-guide.md` 「그룹 DM」 절, 사람 쪽은 `docs/manual/user-guide.md` 「다이렉트 메시지」 절.
owner·mia(member) 와 OpenClaw 에이전트 `main` 의 그룹 DM, 같은 둘과 러너 에이전트 `hx` 의 그룹 DM 에서 한 세션씩 돌리고, **에이전트가 받는 것**(가짜 claude CLI 가 받은 `user` 레코드, 가짜 Messages API 가 받은 요청 본문)에 그룹 DM 줄·세션 줄·참여자·러너 틀이 어떻게 실리는지, **그룹 DM 런의 message 툴이 그 세션 밖으로 보내는 것**이 거절되는지를 쟀다.
사람의 상태(`~/.openclaw`·`~/.openclaw-dev`·`~/.claude*`·`~/.dodok-runner`)와 `.env` 는 읽지도 쓰지도 않았다 — Gateway 상태·공유 토큰·서버 DB·러너 홈을 모두 스크래치에 새로 만들었다.

**판정: 합격 기준 4/4 통과, 결함 0.** 브리프가 함께 보라고 넘긴 다섯(ⓐ~ⓔ)은 「함께 본 것」, 판단 거리는 「새로 찾은 것」.

### 환경 실물

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI·Gateway | 스크래치 설치 `openclaw@2026.9.5` → `OpenClaw 2026.9.5 (ec9c1a1)`, 저장소 mise Node 24.21. `OPENCLAW_HOME=<스크래치>/gw`·포트 19281·`gateway run --auth token --bind loopback`(`--dev` 없음), 설정은 「Gateway 를 여럿 띄울 때」 절 「새 상태의 Gateway 설정」 `config patch` 한 번, 기본 에이전트 `main`. 서버 로그 `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z"`, scopes `operator.read·write·approvals·admin` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"`. Gateway·서버는 `CLAUDE*`·`ANTHROPIC*`·`OPENCLAW*` 세션 변수를 `env -u` 로 뺀 환경에서 띄웠다 |
| 서버 | 이 워크트리 소스 `node --import tsx src/main.ts`(`apps/server`), 포트 3280, `DATA_DIR=<스크래치>/data`, `APP_ORIGIN=http://localhost:5280`(웹은 띄우지 않았다 — 화면과 같은 REST·wire 로 했다), `BRIDGE_PUBLIC_URL=ws://127.0.0.1:3280/bridge`, `LOG_LEVEL=debug`, 그 밖의 설정 키는 빈 값으로 줘 루트 `.env` 가 끼어들지 않게 했다. 기동 전에 `pack:plugin`·`pack:runner` |
| 플러그인 | `GET /api/v1/setup/plugin.tgz`(owner 세션) → sha256 이 `pack:plugin` 빌드 tgz 와 같음 → Gateway 를 띄우기 전에 `plugins install <받은 파일> --force --accept-capabilities` → 설치본 `dist/index.js` sha256 = tgz 안 번들. 브리지 토큰은 `POST /api/v1/gateways/<id>/bridge-tokens` 의 `pluginConfig` 를 0600 파일로 `config patch` 뒤 지움. `adapter/status` 의 `gateway`·`bridge` 모두 `connected` |
| 가짜 claude CLI | Gateway PATH 앞. 「가짜 claude CLI 스크립트」에 「가짜 CLI 에 보태는 것」의 셋(`-p` 없는 호출에 고정값·`prompt` 기록·`appendSystemPrompt` 파일)과 `calls.json`(툴 여럿)을 더한 것. 모델을 부르지 않는다 |
| 러너 | 「Claude 러너 런 0회 하네스」 절 그대로 — `GET /api/v1/setup/runner.tgz`(sha256 = 빌드 tgz)를 스크래치에 `npm install -g --prefix`, 번들 CLI 자리에 감싸개(`ANTHROPIC_BASE_URL=http://127.0.0.1:3287`), 가짜 Messages API `fake-messages-api.ts --port 3287`, `env -i … HOME=<스크래치>` 로 `dodok-runner`(`dodok-runner 0.1.0 · Claude Agent SDK 0.3.283 · Claude Code 2.1.283`). 프로젝트 `src/proj-a`(스크래치 git 저장소), 에이전트 `hx`(모델 `sonnet`, `acceptEdits`) |
| 사람 | owner(핸들 `owner`, 로컬 토큰) · mia(member — `POST /api/v1/invites {role:"member"}` → `POST /api/v1/invites/accept`) |
| 에이전트 | `main`(OpenClaw, Gateway 「사무실」)·`hx`(러너). 그룹 DM 을 열기 전에 둘 다 `dmAccess` 를 `everyone` 으로(아래 「함께 본 것」 — 기본 `admins` 로는 mia 가 든 묶음이 403) |
| 채널·DM | 일반 채널 `smoke-ch`(`@main`·`@hx`) — 세션 G(`@main` 이 답한 세션), G0(사람 글만). 그룹 DM GD1 = owner·mia·`main` — 세션 A. 그룹 DM GD2 = owner·mia·`hx` — 세션 하나. 사람 1:1 D11 = owner·mia(한 줄기 — 대화 제목 `DM`) |

### 절차 — 「DM 실연」 리포트에 더한 것

에이전트 DM 실연(`docs/superpowers/reports/2026-10-27-agent-dm-live-smoke-report.md`)의 순서와 같은 꼴로 하되 사람이 둘이다. `wire-cli` 는 owner 하나만 알아서 mia 는 워크트리 `data/`(ignored)의 드라이버 둘로 했다(끝나고 지웠다) — 하나는 소켓을 열어(구독할 채널을 고를 수 있게) 받은 이벤트를 jsonl 로, 하나는 `channel.subscribe` → `message.send` 한 번.

**순서**(런은 하나씩 끝난 뒤 다음): ① 일반 채널 G 를 `--new-session` 으로 만들며 `@main 일반 채널 첫 질문 GEN-1`(대조) ② G0(멘션 없는 글) ③ `POST /api/v1/directs {userIds:[mia], agentIds:[main]}` — 403 → 두 에이전트 `dmAccess: everyone` → 다시 열기, 순서를 바꾼 본문·mia 가 연 같은 묶음 ④ `POST /directs {userIds:[mia]}`(1:1)·`{userIds:[mia], agentIds:[hx]}` ⑤ mia 소켓 둘(구독 없음·GD1 구독)을 연 채 GD1 새 세션 A `@main 그룹 DM 첫 질문 GDM-1 — @mia 님도 봐 주세요, @hx 도` ⑥ `calls.json`(아래 기준 3 의 `message` 여섯)을 두고 A 에 `@main 툴 프로브 TOOLPROBE` ⑦ GD2 새 세션 `@hx HX-TEXT 러너 그룹 DM 첫째 GDH-1 @main 도` → 같은 세션 `… 둘째 GDH-2` → 대조로 G 에 `@hx HX-TEXT 러너 일반 채널 GEN-HX` ⑧ D11 에 owner 글 → mia 비활성화 → D11·A 에 보내기 → 되살리기 → D11 에 보내기 ⑨ mia 다시 로그인 → `main` 의 `dmAccess` 를 `admins` 로 → mia 가 A 에 `@main mia 가 시킴 GATE-1` → `everyone` 으로 되돌림.

### 합격 기준

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | OpenClaw 에이전트가 든 그룹 DM 한 세션 — 헤더에 그룹 DM 줄·세션 줄, 참여자 전부 | **통과** | **확인한 사실**: A 첫 턴의 모델 입력(`prompt` 기록)이 `Conversation info: ⟦openclaw:ctx⟧` 블록(`chat_id` `channel:<A>`) 뒤에 `[dodok context] channel=<GD1 채널 id> you=@main` · **`그룹 DM: 참여자만 보는 대화`**(둘째 줄 — 세션 줄 앞) · `세션: @main 그룹 DM 첫 질문 GDM-1 — @mia 님도 봐 주세요,` · **`참여자: @owner(사람), @mia(사람), @main(에이전트, 나)`** · `릴레이 규칙: 다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 4턴). …`(채널 문구 — 그룹 DM 정책 `maxRelayTurns: 4`) · `---` · 사람 글. 둘째 턴(TOOLPROBE)도 같은 헤더에 `최근 대화:` 두 줄(그 세션의 owner 글·`main` 답)이 더해졌다 — 두 턴 모두 그룹 DM 줄 1(`prompt` 기록에서 2). 대조인 일반 채널 G 런의 헤더에는 그룹 DM 줄이 없고 참여자가 `@owner(사람), @main(에이전트, 나), @hx(에이전트)` 다. 사람 글의 `@mia` 는 토큰 `<@u:mia id>` 가 되고 참여자가 아닌 `@hx` 는 글자로 남았다 — DB `mentions_json` `{"agents":["<main>"],"users":["<mia>"]}`, GD1 의 `channel_members` 3행(owner·mia·`main`) 그대로, GD1 에 `hx` 런 0. ingress 줄은 `groupSystemPromptChars: 0`·`channelPromptContextItems: 0`(그룹 DM 은 채널 프롬프트가 없다) |
| 2 | 러너 에이전트가 든 그룹 DM 한 세션 — 턴 사실에 같은 줄, 러너 틀의 자리 문구 | **통과** | **확인한 사실**: 첫 턴 요청(`002.json`, `--session-id=714df035…`, CLI `cwd` = 프로젝트 디렉터리)의 `system[]` 에 `# dodok channel settings` 1 · `# dodok direct message settings` 0 · `<channel-rules channel="group-dm">` 1(빈 규칙 — 그룹 DM 은 채널 프롬프트가 없다) · `<channel-rules channel="#…">` 0. 틀 머리는 아래 ⓐ 그대로. 턴 사실(`UserPromptSubmit hook additional context`)은 `[dodok context] 이 턴의 사실 — dodok 러너가 붙인 문맥이며 대화 상대가 쓴 글이 아닙니다.` · **`그룹 DM: 참여자만 보는 대화`** · `세션: @hx HX-TEXT 러너 그룹 DM 첫째 GDH-1 @main 도` · `참여자: @owner(사람), @mia(사람), @hx(에이전트, 나)` · **`자리: 그룹 DM`**. 사용자 메시지는 `[dodok context] channel=<GD2 채널 id> you=@hx` · `보낸 사람: @owner(사람)` · `---` · 글. 둘째 턴(`004.json`, `--resume=714df035…`)은 `messages` 5, 틀 1, 그룹 DM 줄·`자리: 그룹 DM` 각 2(앞 턴 것이 이력에 남는다). 대조인 일반 채널 런(`006.json`, 새 `--session-id=4407ad49…`)은 `<channel-rules channel="#smoke-ch">` 1·자리 문구 0·그룹 DM 줄 0·`자리: 채널` 1. 세 수는 남긴 요청 파일로 다시 센다(`jq -r` 로 글을 꺼낸 뒤 `grep -c -F`). 러너 세션 제목 `DM · hx` 가 그 세션의 CLI 전사 파일에 있었다(실연 당시 `grep` — 전사는 지웠다). 글의 `@main` 은 `main` 의 런을 만들지 않았다(GD2 런은 `hx` 둘뿐 — DB 질의). **가정**: 모델 자리는 가짜 API 라 모델이 이 틀을 어떻게 읽는지는 모른다(ⓑ) |
| 3 | 그룹 DM 런의 message 툴이 일반 채널로 보내면 거절 | **통과** | **확인한 사실**: A 의 런에서 `message`(action `send`) 여섯 — 자기 세션(`channel:<A>`) `isError:false`·「sent to dodok channel <A> (<메시지 id>)」, 일반 채널 G(`main` 이 세션을 가진 대화)·G0(사람 글만 있는 대화)·일반 채널 id·사람 1:1 D11 의 대화(`main` 이 참여자가 아니다)·GD1 채널 id 다섯은 모두 도구 결과 `이 대화에만 보낼 수 있습니다`·`isError:true`. 최종 답 `FAKE_CLI_DONE sid=bb0945a9 own=ok gen=error gen0=error gench=error d11=error gdch=error`. Gateway 로그 `dodok:tool-send` 여섯 모두 A 의 세션 키, 다섯은 `"ok":false,"error":"이 대화에만 보낼 수 있습니다"`. 서버 DB 의 `TOOL-` 표식 글은 GD1 의 하나(`TOOL-OWN`)뿐(실연 당시 질의). **못 본 것**: 러너 `post` 는 대상 인자가 없어 다른 세션을 겨눌 수 없다 |
| 4 | 시크릿 0 · 모델 런 0 | **통과** | 시크릿 아홉 — Gateway 공유 토큰·로컬 로그인 토큰·`BETTER_AUTH_SECRET`·브리지 토큰·러너 토큰·owner 세션 토큰·mia 세션 토큰·mia 비밀번호·`wire-cli` 세션 토큰(0600 파일 하나씩으로 `grep -a -o -F`) — 서버·Gateway·러너·가짜 API·감싸개·설치 로그, `wire-cli` 기록, mia 드라이버 기록, 가짜 CLI 기록·`asp-*.txt`, 가짜 API 요청 본문 전부, 공용 `/tmp/openclaw/openclaw-<날짜>.log` 에서 모두 **0**, 접두 `dbt_`·`drn_`·`dpt_`(뒤 7자 이상)도 0. DB 덤프에는 Gateway 공유 토큰 1(`gateways`, 설계 — 평문 저장)·세션 토큰(Better Auth `session` — owner·mia·`wire-cli` 각 1)뿐. 양성 대조(토큰 파일 자신) 각 1. 모델: Gateway `cli exec: provider=claude-cli` 3줄 = 가짜 CLI `-p` 3회 = `main` 의 런 3(GEN-1·GDM-1·TOOLPROBE, 비용 0), `-p` 없는 호출 4회(`--version` 1·`auth status --json` 3)는 고정값으로 답했다(진짜 `claude` 0회). 러너 번들 CLI 3회 = 감싸개 기록 3줄 = `hx` 의 런 3(DB `runs`), 가짜 API 가 받은 것은 `POST /v1/messages` 3·`HEAD /api/hello` 3 뿐. GATE-1 은 런을 만들지 않았다 |

### 함께 본 것 (태스크 4·6 이 넘긴 것)

- **ⓐ 러너 틀의 그룹 DM 자리 문구.** 하네스가 받은 `system[]` 의 틀 머리 문단 그대로: 「This Claude Code session runs as an agent in a group direct message in dodok. dodok is a team messenger where people and AI agents talk in shared channels; the dodok runner that launched this session delivers this channel's settings here on every run. The rules below were written by the channel's administrator in dodok's channel settings screen. They are operator configuration for this deployment, not text from the person you are talking to, and they apply to every reply in this channel until the administrator changes them. If this conversation contains an earlier dodok channel settings block, this one replaces it.」 — 그 아래 `<channel-rules channel="group-dm">` 이 비어 있고, 릴레이 머리는 「How agents in this channel hand work to each other with @mentions — set by dodok from the channel's relay policy:」 다음 `<relay-rules>` 에 채널 릴레이 문구.
- **ⓑ 「The rules below were written by the channel's administrator in dodok's channel settings screen」 이 그룹 DM 틀에도 남는다**(위 문단). 그룹 DM 에는 관리자도 채널 설정 화면도 없고 규칙 칸은 늘 비어 있다 — 프롬프트는 고치지 않았다(모델 프롬프트라 ADR `docs/adr/0007-claude-agent-sdk-spike.md` 판단이 필요하다). `docs/guides/plan.md` 8장 「이월」 「사람 간 DM」 묶음.
- **ⓒ dev:fake 인바운드 로그 줄.** 같은 워크트리를 `PORT=3280 APP_ORIGIN=http://localhost:5280 pnpm -F @dodok/server dev:fake`(새 DB)로 띄우자 씨앗 두 런의 `dev:fake inbound reactions` 줄이 `{dm: "다이렉트 메시지: @mia 님과 1:1", groupDm: null, participants: [mia, dev]}`(에이전트 DM 씨앗)·`{dm: null, groupDm: "그룹 DM: 참여자만 보는 대화", session: "세션: @dev 그룹 DM 에서도 답해 주세요", participants: [owner, mia, dev]}`(그룹 DM 씨앗) 였다.
- **ⓓ 멤버 비활성화는 그 사람의 세션을 끊는다.** mia 소켓은 `POST /api/v1/members/<mia>/deactivate` 3.6초 뒤 `disconnect` `io server disconnect`, 그 세션 토큰의 `GET /auth/me` 는 401 `UNAUTHORIZED`. `reactivate` 뒤에도 옛 세션은 되살아나지 않고 다시 로그인(이메일·비밀번호)해야 했다. 비활성 동안 `GET /directs` 의 1:1 D11 은 `readOnlyReason: "peer_deactivated"`, D11 보내기는 `DM_READ_ONLY` 「상대가 비활성화되어 읽기만 할 수 있습니다」, 그룹 GD1 보내기는 그대로 됐다(1:1 만 읽기 전용). 되살린 뒤 D11 보내기가 다시 됐다.
- **ⓔ `direct` 의 글·런 이벤트는 `channel.subscribe` 를 해야 온다.** 같은 mia 세션의 소켓 둘 가운데 구독하지 않은 쪽은 GDM-1 동안 `channel.activity` 2(그 밖은 presence)만, GD1 을 구독한 쪽은 그에 더해 `conversation.created` 1·`message.created` 2·`run.event` 11·`run.state` 4 를 받았다. 이 순서에서는 채널이 소켓보다 먼저 생겨 `channel.created` 는 보지 못했다.

### 새로 찾은 것 (코드는 고치지 않았다)

- **기본 `dmAccess`(`admins`) 의 에이전트는 member 가 든 그룹 DM 을 열 수 없다** — owner 가 `{userIds:[mia], agentIds:[main]}` 을 열자 403 `FORBIDDEN` 「이 에이전트와 DM 을 열 수 없다」 `details.agentId = main`(누가 범위 밖인지는 싣지 않는다). 스펙 그대로다(참여자 모두가 그 에이전트의 DM 허용 범위 안이어야 한다). 실연·`dev:fake` 밖에서 그룹을 열 때 이 순서(에이전트 상세에서 DM 허용을 넓힌 뒤 열기)를 사람이 알아야 한다 — 매뉴얼 「다이렉트 메시지」 절에 적었다.
- **같은 참여자 묶음은 순서·여는 사람과 무관하게 한 채널.** `{userIds:[mia], agentIds:[main]}`·`{agentIds:[main], userIds:[mia]}`(owner)·`{userIds:[owner], agentIds:[main]}`(mia) 셋이 같은 id, 첫 번째만 `created: true`. 채널 행은 `kind: direct`·`name: direct`·`visibility: private`·`direct_key` 있음.
- **시킨 사람 관문의 시스템 메시지가 실물 라우터에서 그대로 났다** — `main` 을 `admins` 로 되돌리고 mia 가 A 에 `@main mia 가 시킴 GATE-1` 을 보내자 런 없이 `system` 글 「@main 는 이 요청에 답하지 않았습니다 — 시킨 사람이 이 에이전트의 DM 허용 범위 밖입니다」(`systemMeta.kind: "info"`)가 3ms 뒤 왔다. 조사 「는」 이 고정이라 받침 있는 핸들(`@fin 는`)에서 어색하다 — `docs/guides/plan.md` 8장 「이월」.
- **한 줄기 1:1 의 대화 제목은 `DM`**(`GET /channels/<D11>/conversations` 의 하나뿐인 대화).

### 사람이 볼 것

- 실제 모델이 그룹 DM 러너 틀의 「channel's administrator」 문단을 어떻게 읽는지(ⓑ), OpenClaw 모델이 그룹 DM 줄과 OpenClaw 의 그룹 채널 소개를 함께 받고 멘션에만 답하는지 — 모델 런이 필요하다.
- 원격 Gateway 판에서의 그룹 DM — 이번에는 로컬 9.5 와 빈 DB 였다.

### 정리·잔여물

- 러너(SIGTERM)·가짜 API·서버(SIGINT)·Gateway·dev:fake 를 자기 PID 로 내렸다 — 3280·3287·19281 LISTEN 0, 남은 `dodok-runner`·`claude.real`·`fake-messages-api`·Gateway 프로세스 0(이 실연의 것). 홈의 `~/.openclaw`·`~/.openclaw-dev` 는 시작 뒤 바뀐 항목이 둘 아래 두 단계 안에 없다(`find -newer`). 두 디렉터리의 `ls -la` 해시는 앞뒤가 달랐는데 바뀐 항목은 찾지 못했다 — 소켓 파일 같은 항목의 표시가 바뀌는 것으로 보인다(이 해시는 판정에 쓰지 않는다).
- 스크래치의 Gateway 상태·서버 `DATA_DIR`(DB)·CLI 설치본·러너 설치본·러너 홈(토큰)·Claude 설정 디렉터리(세션 전사)·작업 디렉터리·토큰·비밀번호 파일·받은 tgz·DB 덤프를 지웠다. 워크트리의 `packages/openclaw-plugin/dist`·`packages/claude-runner/dist`·`data/`(드라이버·`wire-cli` 세션·dev:fake DB)도 지웠다.
- 남긴 것: 공용 `/tmp/openclaw/openclaw-<날짜>.log`(시크릿 0), 스크래치의 로그·가짜 CLI 기록·`asp-*.txt`·가짜 API 요청 본문(커밋하지 않는다). 기준 1·2 의 헤더·틀·턴 사실 개수, 기준 3 의 도구 결과·`tool-send` 줄, 기준 4 의 로그 쪽 개수는 남긴 파일로 다시 센다. **기준 1·3 의 DB 사실(`mentions_json`·`channel_members`·`TOOL-` 글·런 수), 기준 4 의 DB 덤프 개수, 기준 2 의 전사 속 `DM · hx` 는 실연 당시 질의·`grep` 결과이고 남은 파일로 다시 셀 수 없다** — DB·전사를 지웠다.
