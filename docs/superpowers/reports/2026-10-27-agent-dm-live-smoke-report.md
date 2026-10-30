# DM 실연 — 2026-10-27 결과 (dm-t7, 에이전트 DM 계획 태스크 7, 모델 런 0회)

> 에이전트 DM 의 한 세션이 OpenClaw 모델 입력과 러너 요청에 무엇으로 실리는지 잰 실연의 기록 — 계획 `docs/superpowers/plans/2026-10-26-agent-dm.md` 태스크 7, 스펙 `docs/superpowers/specs/2026-10-25-agent-dm-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


설계는 `docs/superpowers/specs/2026-10-25-agent-dm-design.md`(구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장), 에이전트 쪽은 `docs/guides/agent-guide.md` 「DM — 주인과 1:1」 절, 사람 쪽은 `docs/manual/user-guide.md` 「다이렉트 메시지」 절.
OpenClaw 에이전트와 Claude 러너 에이전트 각각과 DM 을 열어 한 세션씩 돌리고, **에이전트가 받는 것**(OpenClaw 의 모델 입력 — 가짜 claude CLI 가 받은 `user` 레코드와 `initialize` 의 `appendSystemPrompt`, 러너의 요청 본문 — 가짜 Messages API 가 받은 것)에 DM 줄·세션 줄·참여자·릴레이 줄·「이 DM 의 지시」가 어디에 실리는지, **DM 런의 message 툴이 DM 밖으로 보내는 것**이 거절되는지를 쟀다.
사람의 상태(`~/.openclaw`·`~/.openclaw-dev`·`~/.claude*`·`~/.dodok-runner`)와 `.env` 는 읽지도 쓰지도 않았다 — Gateway 상태·공유 토큰·서버 DB·러너 홈을 모두 스크래치에 새로 만들었다.

**판정: 합격 기준 4/4 통과, 결함 0.** 확인한 사실과 가정은 기준마다 갈라 적었다. 새로 안 것은 「새로 찾은 것」 — 그중 「OpenClaw 는 DM 을 그룹 채널로 모델에게 소개한다」가 판단 거리다.

### 27.1 환경 실물

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI·Gateway | 스크래치 설치 `openclaw@2026.9.5` → `OpenClaw 2026.9.5 (ec9c1a1)`(「절차」 절 머리와 같은 설치), 저장소 mise Node 24.21. `OPENCLAW_HOME=<스크래치>/gw`·포트 19061·`gateway run --auth token --bind loopback`(`--dev` 없음), 설정은 「멀티 Gateway 실연」 절 「Gateway 설정」과 같은 `config patch` 한 번, 기본 에이전트 `main`. 서버 로그 `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z"`, scopes `operator.read·write·approvals·admin`(루프백 자동 페어링) · `"bridge plugin hello"` `gatewayVersion="2026.9.5"` |
| 서버 | 이 워크트리 소스 `node --import tsx src/main.ts`(`apps/server`), 포트 3980, `DATA_DIR=<스크래치>/data`, `APP_ORIGIN=http://localhost:6180`(웹은 띄우지 않았다 — 화면과 같은 REST·wire 로 했다), `BRIDGE_PUBLIC_URL=ws://127.0.0.1:3980/bridge`, `LOG_LEVEL=debug`. 루트 `.env` 가 끼어들지 않게 설정 키를 전부 환경에 줬다(「멀티 Gateway 실연」 절과 같다 — `OPENCLAW_GATEWAY_URL`·`OPENCLAW_GATEWAY_TOKEN` 도 빈 값으로). 기동 전에 `pack:plugin`·`pack:runner` |
| 플러그인 | 「플러그인 받기」와 같은 `GET /api/v1/setup/plugin.tgz`(owner 세션) → sha256 이 `pack:plugin` 빌드 tgz 와 같음 → Gateway 를 띄우기 전에 `plugins install <받은 파일> --force --accept-capabilities` → 설치본 `dist/index.js` sha256 = tgz 안 번들. 브리지 토큰은 `POST /api/v1/gateways/<id>/bridge-tokens {"label":…}` 의 `pluginConfig` 를 0600 파일로 `config patch` 뒤 지움. `GET /api/v1/setup/status` 의 그 Gateway `pluginMatches: true`, `gateway.state`·`bridge.state` 모두 `connected` |
| 가짜 claude CLI | Gateway PATH 앞. 「채널 세션 실연」 절 26.2 의 CLI(프롬프트·argv·`calls.json`)에 하나를 더했다 — 아래 27.2. 모델을 부르지 않는다 |
| 러너 | 「Claude 러너 런 0회 하네스」 절 그대로 — `GET /api/v1/setup/runner.tgz`(sha256 = 빌드 tgz)를 스크래치에 `npm install -g --prefix`, 번들 CLI 자리에 감싸개(`ANTHROPIC_BASE_URL=http://127.0.0.1:3987`), 가짜 Messages API `packages/claude-runner/scripts/fake-messages-api.ts --port 3987`, `env -i … HOME=<스크래치>` 로 `dodok-runner`(`dodok-runner 0.0.0 · Claude Agent SDK 0.3.283 · Claude Code 2.1.283`), 에이전트 `hx`(작업 디렉터리 스크래치 git 저장소, 라벨 `hx-ws`, 모델 `sonnet`) |
| 에이전트·사람 | `main`(OpenClaw, Gateway 「사무실」)·`hx`(러너), 둘 다 `dmAccess` 기본 `admins`. DM 주인은 owner(핸들 `owner`) |
| 채널·DM | 일반 채널 `dm-smoke-ch`(`@main`·`@hx`) — 세션 G(`@main` 이 답한 세션), G0(사람 글만). `main` 과의 DM — 세션 A·B. `hx` 와의 DM — 세션 하나 |

### 27.2 절차 — 「채널 세션 실연」 절에 더한 것

**시스템 프롬프트 전체를 남기는 가짜 CLI.** 26.2 의 CLI 는 stdin `control_request { subtype: "initialize" }` 를 그대로 받아 넘기기만 한다. 9.5 의 `appendSystemPrompt` 는 3만 자를 넘어(이번 실연 34,264자) 기록 한 줄에 다 싣지 못하므로, 그 값을 따로 파일에 쓴다(스크래치 기록에만 — 비밀이 들어가지 않는 실연 글이다).

```js
// 26.2 의 CLI 에서 control_request 를 받는 자리에 더한다
if (m.request?.subtype === "initialize") {
  const asp = typeof m.request.appendSystemPrompt === "string" ? m.request.appendSystemPrompt : "";
  fs.writeFileSync(DIR + `/asp-${SID.slice(0, 8)}-${process.pid}.txt`, asp);
  log({ event: "asp", sid: SID, len: asp.length, markers: asp.match(/[A-Z]+-RULE-[A-Z0-9]+/g) ?? [] });
}
```

판정은 지시에 넣은 표식(`DM-RULE-MAIN` 등)을 `asp-*.txt`·`prompt` 기록에서 찾고, 플러그인이 Gateway 로그에 남기는 `[dodok] ingress {…, "groupSystemPromptChars":…, "channelPromptContextItems":…}` 줄과 맞춰 본다.

```bash
jq -c 'select(.event=="asp" or .event=="prompt") | {event, sid: .sid[0:8], len, markers}' <스크래치>/fake/out/fake-claude.jsonl
grep ingress <스크래치>/logs/gw.log | grep -o '{.*}' | jq -c '{sessionKey, groupSystemPromptChars, channelPromptContextItems}'
```

러너 요청 본문은 「Claude 러너 런 0회 하네스」 절처럼 요약했다 — `system[]` 을 이어 붙인 글과 `messages[]` 의 글 블록에서 표식(`# dodok direct message settings`·`# dodok channel settings`·`<channel-rules channel="dm:@owner">`·`"#dm"`·`다이렉트 메시지: @owner 님과 1:1`·`자리: DM`·`자리: 채널`)의 개수를 센다. 요청 파일(`NNN.json`)에서 직접 `grep -F` 하면 JSON 이 따옴표를 `\"` 로 적어 속성 꼴 표식이 0 으로 나온다 — `jq -r` 로 글을 꺼낸 뒤 센다.

**순서**(런은 하나씩 끝난 뒤 다음, 사람 쪽은 `wire-cli send`·REST): ① 일반 채널 G 를 `--new-session` 으로 만들며 `@main 일반 채널 첫 질문 GEN-1`(대조 — `main` 이 일반 채널에도 세션을 갖는다) ② `POST /api/v1/dms {agentId: main}` → `PATCH /api/v1/channels/<DM> {"prompt":"DM-RULE-MAIN: …"}` → DM 새 세션 A `DM 첫 질문 DMA-1 — @hx 도 같이 봐 줘` ③ A 에 `DM 둘째 턴 DMA-2` ④ 지시를 `DM-RULE-MAINTWO: …` 로 바꾸고 A 에 `DM 셋째 턴 DMA-3` ⑤ DM 새 세션 B ⑥ `calls.json`(아래 기준 3 의 `message` 여섯)을 두고 A 에 `DM 툴 프로브 TOOLPROBE` ⑦ `POST /api/v1/dms {agentId: hx}` → 지시 `DM-RULE-HX: …` → 새 세션 `HX-TEXT 러너 DM 첫째 DMH-1 @main 도` → 같은 세션 `HX-TEXT 러너 DM 둘째 DMH-2` → 대조로 일반 채널 G 에 `@hx HX-TEXT 러너 일반 채널 GEN-HX`.

### 27.3 합격 기준

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | OpenClaw 에이전트 DM 한 세션 — 헤더에 DM 줄·세션 줄·참여자 주인 + 나·DM 릴레이 줄, 「이 DM 의 지시」가 채널 프롬프트 자리 | **통과** | **확인한 사실**: A 첫 턴의 모델 입력(`prompt` 기록) 헤더가 `[dodok context] channel=<DM 채널 id> you=@main` · **`다이렉트 메시지: @owner 님과 1:1`**(둘째 줄 — 세션 줄 앞) · `세션: DM 첫 질문 DMA-1 — @hx 도 같이 봐 줘` · `참여자: @owner(사람), @main(에이전트, 나)` · `릴레이 규칙: DM 에는 릴레이가 없습니다 — @핸들은 글로만 남습니다.` · `---` · 사람 글. 대조인 일반 채널 G 런의 헤더에는 DM 줄이 없고 참여자에 `@hx(에이전트)` 가 더 있으며 릴레이 줄은 채널 문구다. 둘째 턴부터 「최근 대화」는 그 세션 글만(A 셋째 턴에 A 의 앞 두 턴 네 줄). 사람 글의 `@hx` 는 글자 그대로 남았고(`mentions_json` `{"users":[],"agents":[]}`) `hx` 의 런은 생기지 않았다 — 실연 당시 DB 질의(27.6). **지시가 가는 자리**는 일반 채널의 채널 프롬프트와 같다: 세션 A 의 턴에서 플러그인 ingress 줄이 `groupSystemPromptChars: 37`·`channelPromptContextItems: 0` 이고, A 둘째 턴의 `appendSystemPrompt`(34,264자)에 `DM-RULE-MAIN: 이 DM 에서는 세 문장 안으로 답하세요.` 한 줄이 OpenClaw 의 채널 소개 문단 바로 뒤에 있다(Gateway 채널 설정 `systemPrompt` — 서버의 프롬프트 동기화). 지시를 바꾼 뒤의 셋째 턴은 ingress `channelPromptContextItems: 1` 이고 `user` 레코드 머리에 `Context: ⟦openclaw:ctx⟧` 블록 `채널 프롬프트: DM-RULE-MAINTWO: 바꾼 지시 — 표로 답하세요.` 가 헤더 앞에 붙었다(`ChannelPromptContext` — 항목 이름은 「채널 프롬프트:」). **가정**: 가짜 CLI 는 전사를 만들지 않아 턴마다 새 CLI 세션이므로 셋째 턴의 `appendSystemPrompt` 에도 새 지시가 실렸다 — 진짜 claude-cli 세션에서는 시스템 프롬프트가 세션 시작 때 값이고 바뀐 지시는 `채널 프롬프트:` 항목으로만 간다고 본다(ADR 0003, `docs/guides/agent-guide.md` 「채널 프롬프트와 채널 지시」). **못 본 것**: A 첫 턴의 `appendSystemPrompt` — 그때의 CLI 는 12,000자에서 잘라 적어 지시 줄까지 닿지 않았다(둘째 턴부터 전체를 남겼다) |
| 2 | 러너 에이전트 DM 한 세션 — 턴 사실에 DM 줄·`자리: DM`, 채널 규칙 append 가 `#dm` 이 아니라 DM 틀 | **통과** | **확인한 사실**: 첫 턴 요청(`002.json`, `--session-id=a5227b5f…`)의 `system[]`(15,596자)에 `# dodok direct message settings` 1 · `# dodok channel settings` 0 · `<channel-rules channel="dm:@owner">` 1(그 안에 `DM-RULE-HX: …`) · `<relay-rules>` 안 `DM 에는 릴레이가 없습니다 — @핸들은 글로만 남습니다.` 1 · 틀 머리 「This Claude Code session runs as an agent in a direct message with @owner in dodok. …」, 요청 전체에 `"#dm"` 0. 턴 사실(`UserPromptSubmit hook additional context`)은 `[dodok context] 이 턴의 사실 — …` · **`다이렉트 메시지: @owner 님과 1:1`** · `세션: HX-TEXT 러너 DM 첫째 DMH-1 @main 도` · `참여자: @owner(사람), @hx(에이전트, 나)` · **`자리: DM`**. 사용자 메시지는 `[dodok context] channel=<DM 채널 id> you=@hx` · `보낸 사람: @owner(사람)` · `---` · 글. 둘째 턴(`004.json`, `--resume=a5227b5f…`)은 `messages` 5, DM 틀 1, DM 줄·`자리: DM` 각 2(앞 턴 것이 이력에 남음 — 「Claude 러너 런 0회 하네스」 절 기준 3 과 같다). 대조인 일반 채널 런(`006.json`, 새 `--session-id=9da4e8f3…`)은 `# dodok channel settings` 1·`<channel-rules channel="#dm-smoke-ch">`·DM 틀 0·DM 줄 0·`자리: 채널` 1. 세 수는 남긴 요청 파일로 다시 센다. 러너 세션 제목 `DM · HX` 가 그 세션의 CLI 전사 파일에 있었다(실연 당시 `grep` — 전사는 지웠다). 글의 `@main` 은 `main` 의 런을 만들지 않았다(실연 당시 DB 질의). **가정**: 모델 자리는 가짜 API 라 모델이 DM 틀을 어떻게 따르는지는 모른다(「새로 찾은 것」 아래 이월) |
| 3 | DM 런의 message 툴이 DM 밖으로 보내면 「이 대화에만 보낼 수 있습니다」·저장 0 | **통과** | **확인한 사실**: A 의 런에서 `message`(action `send`) 여섯 — 자기 세션(`channel:<A>`) `isError:false`·「sent to dodok channel <A> (<메시지 id>)」, 일반 채널 G(`main` 이 세션을 가진 대화 — 세션 행 규칙은 통과시키고 서버 `assertCanonicalConversation` 만 막는 꼴)·G0(사람 글만 있는 대화)·일반 채널 id·같은 DM 의 세션 B·DM 채널 id 다섯은 모두 도구 결과 `{"type":"text","text":"이 대화에만 보낼 수 있습니다"}`·`isError:true`. 최종 답 `FAKE_CLI_DONE sid=b25ab3c8 own=ok gen=error gen0=error gench=error dmb=error dmch=error`. Gateway 로그 `dodok:tool-send` 여섯 모두 `"sessionKey":"agent:main:dodok:channel:<A>"`·`"agentId":"main"`, 다섯은 `"ok":false,"error":"이 대화에만 보낼 수 있습니다"`. 서버 DB 의 `TOOL-` 표식 글은 A 의 `TOOL-OWN` 하나뿐(실연 당시 질의). **못 본 것**: 플러그인을 거치지 않은 정본, 채널 런이 DM 대화로 보내는 꼴 — 실물 플러그인으로는 만들 수 없다(통합 `apps/server/test/integration/conversations.test.ts` 「[에이전트 DM 스펙 4장] DM 과 일반 채널 사이 …」가 본다). 러너 `post` 는 대상 인자가 없어 다른 세션을 겨눌 수 없다 |
| 4 | 시크릿 0 · 모델 런 0 | **통과** | 토큰 여섯 — Gateway 공유 토큰·로컬 로그인 토큰·`BETTER_AUTH_SECRET`·브리지 토큰·러너 토큰·`wire-cli` 세션 토큰(0600 파일 하나씩으로 `grep -a -o -F -f`) — 이 서버·Gateway·러너·가짜 API·감싸개·설치 로그, `wire-cli` 기록, 가짜 CLI 기록·`asp-*.txt`, 가짜 API 요청 본문 전부, 공용 `/tmp/openclaw/openclaw-<날짜>.log` 에서 모두 **0**, 접두 `dbt_`·`drn_`·`dpt_`(뒤 7자 이상)도 로그에 0. DB 덤프에는 Gateway 공유 토큰 1(`gateways`, 설계 — 평문 저장)·세션 토큰 1(Better Auth `session`)뿐. 양성 대조(토큰 파일 자신) 6. 모델: Gateway `cli exec: provider=claude-cli` 6줄 = 가짜 CLI `-p` 6회 = `main` 의 런 6(DM 5·일반 1, 비용 0), `-p` 없는 호출 4회(`--version` 1·`auth status --json` 3)는 고정값으로 답했다(진짜 `claude` 0회). 러너 번들 CLI 3회 = 감싸개 기록 3줄 = `hx` 의 런 3, 가짜 API 가 받은 것은 `POST /v1/messages` 3·`HEAD /api/hello` 3 뿐 |

### 27.4 새로 찾은 것 (코드는 고치지 않았다)

- **OpenClaw(9.5)는 DM 을 그룹 채널로 모델에게 소개한다.** 모델 입력의 `Conversation info` 블록은 `"is_group_chat":true`, 시스템 프롬프트의 `openclaw.inbound_meta.v2` 는 `"chat_type":"channel"`, 그 아래 문단이 「You are in a Dodok channel. …」와 「Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included).」다 — DM 에서는 멘션 없이 모든 글이 런이 되는데 모델은 「멘션될 때만 불린다」를 받는다. DM 이라는 사실은 dodok 헤더의 `다이렉트 메시지:` 줄 하나로만 간다. 플러그인이 인바운드를 `conversation: { kind: "channel" }` 로 넣는 자리(`packages/openclaw-plugin/src/channel.ts`)다. 모델이 이것을 어떻게 읽는지는 모델 런 없이 모른다 — `docs/guides/plan.md` 8장 「이월」 「에이전트 DM」 묶음.
- **「이 DM 의 지시」는 OpenClaw 에이전트에게 일반 채널의 채널 프롬프트와 같은 두 길로 간다** — 새 세션은 Gateway 채널 설정 `systemPrompt`(시스템 프롬프트), 세션이 시작된 뒤 바꾸면 `채널 프롬프트:` 항목. 항목 이름은 「이 DM 의 지시」가 아니라 「채널 프롬프트:」다(`docs/guides/agent-guide.md` 「DM — 주인과 1:1」 절에 적었다).
- `RUN_STARTED` 의 `providerRunId` 가 일반 채널 G 의 첫 `main` 런에는 런 id 와 같은 값이고 그 뒤 `main` 의 런 다섯(모두 DM)에는 비었다(`wire-cli` 기록 `providerRunId=undefined`). `hx` 의 러너 런 셋은 DM 이든 아니든 찼다. 런은 모두 `done`·`finalSource=plugin` 이고 정본·최종 답이 그 런에 붙었다. DM 때문인지 「Gateway 의 둘째 런부터」인지는 이번 순서로 가르지 못했다 — 다시 재려면 같은 Gateway 에서 일반 채널 런을 둘 잇달아 돌리고 `RUN_STARTED` 를 견준다.
- **Gateway 가 띄운 claude CLI 의 환경에 `OPENCLAW_GATEWAY_TOKEN` 이 있다** — 가짜 CLI 의 `invoke` 기록 `envKeys`(이름만 적는다 — 값은 남기지 않았다) 여섯 번 모두 `OPENCLAW_GATEWAY_TOKEN`·`OPENCLAW_MCP_TOKEN`·`OPENCLAW_MCP_CLI_CAPTURE_KEY` 등. 「절차」 절대로 Gateway 를 env `OPENCLAW_GATEWAY_TOKEN` 으로 띄우면 그 값이 모델 런의 CLI 까지 내려가, exec 를 가진 에이전트가 명령으로 읽을 수 있다(「시크릿 규칙」 마지막 줄과 같은 줄기 — DM 과 무관). 이번 실연은 Gateway·서버를 이 세션의 셸에서 띄우며 `CLAUDE_CODE_*`·`CLAUDECODE` 같은 에이전트 세션 변수를 `env -u` 로 뺐다 — 그 기록에 그 이름은 없다.
- 모델 입력의 「최근 대화」 시각은 UTC 다(`[01:14]` — `Conversation info` 의 `timestamp` 는 `GMT+9`) — `docs/guides/agent-guide.md` 「매 턴의 인바운드」 절이 적은 그대로이고 DM 과 무관하다.

### 27.5 사람이 볼 것

- 실제 모델이 DM 에서 「Activation: trigger-only」 문단과 dodok 의 DM 줄 사이에서 어떻게 구는지(위 「새로 찾은 것」 첫 줄), 러너 모델이 DM 틀의 「주인이 정해 둔 설정」을 지시 주입으로 읽지 않는지 — 모델 런이 필요하다.
- 원격 Gateway 판에서의 DM — 이번에는 로컬 9.5 와 빈 DB 였다.

### 27.6 정리·잔여물

- 러너(SIGTERM)·가짜 API·서버(SIGINT)·Gateway 를 자기 PID 로 내렸다 — 19061·3980·6180·3987 LISTEN 0, 남은 `dodok-runner`·`claude.real`·`fake-messages-api`·Gateway 프로세스 0(이 실연의 것). 홈의 `~/.openclaw`·`~/.openclaw-dev` 는 시작 전후 수정 시각이 같고(`stat`), 시작 뒤 바뀐 항목이 둘 아래 두 단계 안에 없다(`find -newer`).
- 스크래치의 Gateway 상태·서버 `DATA_DIR`(DB)·CLI 설치본·러너 설치본·러너 홈(토큰)·Claude 설정 디렉터리(세션 전사)·작업 디렉터리·토큰 파일·받은 tgz·DB 덤프를 지웠다. 워크트리의 `packages/openclaw-plugin/dist`·`packages/claude-runner/dist`·`data/`(`wire-cli` 세션)도 지웠다(남기면 「제어 MCP 실연」 절 「새로 찾은 것」의 서버 테스트가 실패한다).
- 남긴 것: 공용 `/tmp/openclaw/openclaw-<날짜>.log`(다른 Gateway 도 쓰는 날짜 파일 — 시크릿 0), 스크래치의 로그(서버·Gateway·러너·가짜 API·감싸개·`wire-cli` 기록)·가짜 CLI 기록·`asp-*.txt`·가짜 API 요청 본문(`NNN.json`·`requests.jsonl`)·실연 당시 DB·Gateway 질의 결과를 적은 요약 파일(커밋하지 않는다). 기준 1·2 의 헤더·틀·턴 사실 개수와 기준 3 의 도구 결과·`tool-send` 줄, 기준 4 의 로그 쪽 개수는 남긴 파일로 다시 센다. **기준 1·3 의 DB 사실(`mentions_json`·`TOOL-` 글·런 수), Gateway 세션 표(`session_nodes` — 키 셋이 G·A·B 의 대화 id 로 서로 다른 OpenClaw 세션), 기준 4 의 DB 덤프 개수, 기준 2 의 전사 속 `DM · HX` 는 실연 당시 질의·`grep` 결과이고 남은 파일로 다시 셀 수 없다** — DB·Gateway 상태·전사를 지웠다.
