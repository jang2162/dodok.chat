# 리액션 실연 — 2026-10-07 결과 (rx-t5, 리액션 계획 태스크 5, 모델 런 0회)

> 리액션이 OpenClaw 모델 입력과 러너 턴 사실에 실리는지 잰 실연의 기록 — 계획 `docs/superpowers/plans/2026-10-05-reactions.md` 태스크 5, 스펙 `docs/superpowers/specs/2026-10-05-reactions-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


설계는 `docs/superpowers/specs/2026-10-05-reactions-design.md`(구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장), 에이전트가 받는 글은 `docs/guides/agent-guide.md` 「반응 — 지난 턴 뒤 내 메시지에 달린 것」 절.
사람이 에이전트 답에 단 반응이 **실제 OpenClaw 가 모델에게 넘기는 입력**(가짜 claude CLI 가 받은 `user` 레코드)에 헤더 블록으로 실리는지를 쟀고, 같은 것을 「Claude 러너 런 0회 하네스」 절의 하네스로 러너 턴 사실에서도 봤다.
사람의 dev 상태(`~/.openclaw-dev`·`~/.openclaw`)와 `.env` 는 읽지도 쓰지도 않았다 — Gateway 상태·공유 토큰·서버 DB·러너 홈을 모두 스크래치에 새로 만들었다.

**판정: 합격 기준 6/6 통과. 리액션 결함 0.** 새로 안 것은 「새로 찾은 것」 — 「스레드를 열기 전에 루트에 단 반응은 그 스레드 대화에 가지 않는다」를 실물에서 봤다(설계대로, 스펙 「구현과 맞춘 것」 장).

### 23.1 환경 실물

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI·Gateway | 스크래치 설치 `openclaw@2026.9.5` → `OpenClaw 2026.9.5 (ec9c1a1)`(「절차」 절 머리와 같은 설치), 저장소 mise Node 24.21. `OPENCLAW_HOME=<스크래치>/gw`·포트 19031·`gateway run --auth token --bind loopback`(`--dev` 없음), 설정은 「멀티 Gateway 실연」 절 「Gateway 설정」과 같은 `config patch` 한 번, 기본 에이전트 `main` |
| 서버 | 소스 실행 `node --import tsx src/main.ts`(`apps/server`), 포트 3960, `DATA_DIR=<스크래치>/data`, `APP_ORIGIN=http://localhost:6160`, `BRIDGE_PUBLIC_URL=ws://127.0.0.1:3960/bridge`, `LOG_LEVEL=debug`. 루트 `.env` 가 끼어들지 않게 설정 키를 전부 환경에 줬다(「멀티 Gateway 실연」 절과 같다). 기동 전에 `pack:plugin`·`pack:runner` |
| 웹·브라우저 | Vite dev 6160(`DODOK_API_ORIGIN=http://127.0.0.1:3960`), 독립 headless Chromium(`playwright-core` 1.62.1) — owner 로 멘션 보내기·반응 달기·연결 페이지 읽기. 로그인 토큰은 스크립트가 파일에서 읽어 요청 본문으로만 |
| 버전 로그 | `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z"`, scopes `operator.read·write·approvals·admin`(루프백 자동 페어링) · `"bridge plugin hello"` `gatewayVersion="2026.9.5"` |
| 플러그인 | 연결 페이지 「플러그인 받기」와 같은 `GET /api/v1/setup/plugin.tgz`(owner 세션) → sha256 이 `pack:plugin` 빌드 tgz 와 같음 → **Gateway 를 내린 뒤** `plugins install <받은 파일> --force --accept-capabilities` → 설치본 `dist/index.js` sha256 = 빌드본(`be74df34…c458`), `status: "loaded"` · 브리지 토큰은 `POST /api/v1/gateways/<id>/bridge-tokens` 의 `pluginConfig` 를 0600 파일로 `config patch` 뒤 지움 → 다시 띄우자 브리지 `connected`, `GET /api/v1/setup/status` 의 `pluginMatches: true`, 연결 페이지 「접속됨 · 서버와 같은 빌드입니다」 |
| 가짜 claude CLI | Gateway PATH 앞(아래 23.2). 모델을 부르지 않는다 |
| 러너 | 「Claude 러너 런 0회 하네스」 절 그대로 — `GET /api/v1/setup/runner.tgz` 를 스크래치에 `npm install -g --prefix`, 번들 CLI 자리에 감싸개(`ANTHROPIC_BASE_URL=http://127.0.0.1:3967`), 가짜 Messages API `fake-messages-api.ts --port 3967`, `env -i … HOME=<스크래치>` 로 `dodok-runner`, 에이전트 `hx`(작업 디렉터리 스크래치 git 저장소, 모델 `sonnet`) |
| 채널 | `rx-live` 하나 — `@main`(OpenClaw)·`@hx`(러너) |

### 23.2 절차 — 「멀티 Gateway 실연」 절에 더한 것

**프롬프트를 적는 가짜 CLI.** 11.4 스크립트에서 루프백 MCP 호출(`message`·`ask_user`)을 빼고, stdin 의 첫 `user` 레코드 글을 그대로 적는다(스크래치 기록에만 — 비밀이 들어가지 않는 실연 글이다). `-p` 가 없는 호출은 진짜 `claude` 로 넘기지 않고 고정값으로 답한다 — OpenClaw CLI·Gateway 는 `claude auth status --json` 의 `loggedIn` 을 보고(이번 실연 5회 — Gateway 기동 둘씩 등), 첫 런 앞에 `--version` 을 한 번 묻는다.

```js
// 11.4 와 다른 곳만
if (!isRun) {
  if (argv.includes("--version")) { process.stdout.write("2.1.283 (Claude Code)\n"); process.exit(0); }
  if (argv[0] === "auth" && argv[1] === "status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) + "\n"); process.exit(0); }
  process.exit(1);
}
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const SID = at("--session-id") ?? at("--resume");                       // 세션 id 는 argv 값을 되돌린다
// stdin: control_request → control_response, 첫 user 레코드에서
//   log({ event: "prompt", text: <message.content 의 text 블록을 이은 글> }) → system/init → assistant·result "FAKE_CLI_DONE"
```

판정은 기록의 `prompt` 글에서 `\n---\n` 앞(헤더)을 잘라 본다. 헤더의 반응 블록은 shared `formatReactionFacts` 에 같은 입력(핸들·이모지·발췌)을 넣은 결과와 글자까지 대조했다(`pnpm exec tsx` 로 `packages/shared/src/index.ts` 를 불러 `head.endsWith("\n" + 블록)`).

**순서**(모두 owner 가 웹에서, 런은 하나씩 끝난 뒤 다음): ① `@main 첫 질문` → 답 A1 ② A1 에 👍·🎉 ③ `@main 둘째 질문` ④ `@main 셋째 질문` ⑤ A1 에서 스레드를 열고 `@main 스레드 하나`(스레드 세션이 이때 생긴다) → 스레드 답 T1 ⑥ T1 에 ❤️, 스레드 패널의 루트 A1 에 👀 ⑦ 스레드에 `@main 스레드 둘` ⑧ 채널에 `@main 넷째 질문`. 러너는 같은 채널에서 `@hx HX-TEXT 러너 첫째` → 답에 ✅·❓ → `…둘째` → `…셋째`.

### 23.3 합격 기준

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 에이전트 답에 단 반응이 다음 멘션의 모델 입력에 실린다 — 문구는 `formatReactionFacts` 정본 그대로, 자리는 `---` 바로 위 | **통과** | ③ 의 헤더 끝: `최근 대화:` 두 줄 뒤 `반응(지난 턴 뒤 네 메시지에 달린 것):` · `- @owner 👍 "FAKE_CLI_DONE"` · `- @owner 🎉 "FAKE_CLI_DONE"` · `---`. `formatReactionFacts` 결과와 글자까지 같다(대조 MATCH). 이 글은 OpenClaw 가 앞에 붙이는 `Conversation info: ⟦openclaw:ctx⟧` JSON 블록 **뒤**, 플러그인 헤더 안에 있다 |
| 2 | 그다음 멘션에는 없다 | **통과** | ④ 의 헤더에 `반응(` 없음 — 「최근 대화」 마지막 줄 바로 뒤가 `---` |
| 3 | 스레드 런은 스레드 범위만 | **통과** | ⑦ 의 헤더(`thread=<A1>`): `- @owner ❤️ "FAKE_CLI_DONE"`(T1 — 스레드 답글)·`- @owner 👀 "FAKE_CLI_DONE"`(루트 A1, 스레드 세션이 생긴 뒤에 달았다) — `formatReactionFacts` 와 MATCH. ⑧ 채널 런의 헤더: `- @owner 👀 "FAKE_CLI_DONE"` 하나뿐 — 스레드 답글의 ❤️ 는 채널 런에 없다(MATCH). ⑤ 스레드 첫 런에는 블록이 없다 — A1 의 👍·🎉 는 스레드 세션이 생기기 전에 달려 채널 세션(③)에만 갔다 |
| 4 | 반응이 없으면 헤더가 이전과 같다 | **통과** | ①·④·⑤ 의 헤더는 `[dodok context]`·`참여자:`·`릴레이 규칙:`·(`최근 대화:`·줄들 또는 `스레드 루트:`) 뒤 곧바로 `---` 다. 반응 전 플러그인과의 코드 차이는 `formatInboundContext` 의 「블록이 비지 않았을 때만 `---` 앞에 넣는」 두 줄뿐이다(`git diff ff7b509^ HEAD -- packages/openclaw-plugin/src/context.ts`) |
| 5 | (가능하면) 러너 턴 사실 | **통과** | 가짜 Messages API 가 받은 요청 본문의 `UserPromptSubmit hook additional context` 글: 둘째 런의 이번 턴 사실 끝에 `반응(지난 턴 뒤 네 메시지에 달린 것):` · `- @owner ✅ "하네스 답입니다 — 가짜 Messages API 가 보냈습니다."` · `- @owner ❓ "…"`, 셋째 런의 이번 턴 사실에는 없다. 셋째 요청은 `resume` 이라 앞 턴의 사실(둘째 런의 반응 블록 포함)이 이력에 그대로 있다 — 「새로 찾은 것」 |
| 6 | 공통 조건 — 시크릿 0 · 모델 런 0 | **통과** | Gateway 공유 토큰·로컬 로그인 토큰·세션 토큰·브리지 토큰·러너 토큰(0600 파일 하나로 `grep -a -c -F -f`)이 서버·Gateway·러너·웹 로그, 가짜 CLI 기록, 가짜 API 요청 본문·목록, 공용 `/tmp/openclaw/openclaw-<날짜>.log`, 드라이버 로그에서 모두 **0**, 접두 `dbt_`·`drn_` 도 서버·Gateway·러너 로그에 0. DB 덤프에는 Gateway 공유 토큰 1(`gateways`, 설계 — 평문 저장)·세션 토큰 1(Better Auth `session`)뿐, 브리지·러너·로컬 토큰 0. 양성 대조(토큰 파일 자신) 5. 모델: Gateway `cli exec: provider=claude-cli` 6줄 = 가짜 CLI `-p` 6회 = OpenClaw 런 6건(`done`·`finalSource=plugin`·비용 0), `-p` 없는 호출 6회는 고정값으로 답했다(진짜 `claude` 0회). 러너 번들 CLI 3회 = 감싸개 기록 3줄, 가짜 API 가 받은 것은 `HEAD /api/hello` 3·`POST /v1/messages` 3 뿐. 러너 런 비용 칸의 `0.00027` 은 CLI 가 가짜 API 의 사용량 숫자에 단가를 곱한 값이다(바깥 연결 없음) |

### 23.4 새로 찾은 것 (코드는 고치지 않았다)

- **스레드를 열기 전에 루트에 단 반응은 그 스레드 대화에 가지 않는다**(기준 3 의 ⑤). 스레드 세션 행은 그 스레드의 첫 런을 대기열에 넣을 때 생기고 반응 기준 시각이 그때라서다 — 설계대로이고(스펙 「구현과 맞춘 것」 장), 그 반응은 채널 세션에는 갔다. 사람에게는 「답에 👍 를 달고 곧바로 그 답에서 스레드를 열어 물었는데 에이전트가 👍 를 모른다」로 보인다. 바꿀 길은 `docs/guides/plan.md` 「이월」의 「리액션」 묶음.
- **러너 세션은 앞 턴의 반응 블록을 이력으로 안고 간다.** `resume` 한 요청의 `messages` 에 앞 턴의 `UserPromptSubmit` 문맥이 그대로 남아, 셋째 런의 모델은 둘째 런 때의 「반응」 블록을 다시 본다(이번 턴의 사실에는 없다). 「Claude 러너 런 0회 하네스」 절 기준 3 과 같은 성질 — 반응이 「다시 왔다」로 읽히지 않게 에이전트 가이드가 「새 반응은 이번 턴의 글에 있는 것뿐」이라고 적는다.
- **발췌만으로는 어느 메시지인지 가리지 못할 수 있다** — 이번 실연은 에이전트 답이 모두 `FAKE_CLI_DONE` 이라 세 반응의 인용이 같았다. 블록에는 메시지 id 가 없다(설계 — 에이전트 가이드가 「앞부분으로 알아본다」고 적는다). 실제 답은 글이 달라 문제가 덜하지만, 짧은 같은 답(「완료했습니다」 등)이 이어지면 같은 인용이 된다.

### 23.5 사람이 볼 것

- 실제 모델이 반응 블록을 요청이 아니라 사실로 읽는지(에이전트 가이드의 붙여 넣을 블록 문장 효과) — 모델 런 금지라 재지 않았다.
- 원격 Gateway 판(9.4 일 수 있음)에서 같은 헤더가 실리는지 — 옛 플러그인이면 반응 줄만 빠지는 것은 단위 테스트가 본다.

### 23.6 정리·잔여물

- 러너(SIGTERM)·가짜 API·웹·서버(SIGINT)·Gateway·브라우저 드라이버를 자기 PID 로 내렸다 — 19031·3960·6160·3967 LISTEN 0, 남은 `dodok-runner`·`claude.real`·`fake-messages-api` 프로세스 0.
- 스크래치의 Gateway 상태·서버 `DATA_DIR`·러너 설치본·러너 홈(토큰)·CLI 설치본·토큰 파일·받은 tgz 를 지웠다. 워크트리의 `packages/openclaw-plugin/dist`·`packages/claude-runner/dist`·`data/` 도 지웠다. 홈의 `~/.openclaw`·`~/.openclaw-dev` 는 시작 전후 수정 시각이 같다(`stat`).
- 남긴 것: 공용 `/tmp/openclaw/openclaw-<날짜>.log`(다른 Gateway 도 쓰는 날짜 파일이라 지우지 않았다 — 시크릿 0), 스크래치의 로그·가짜 CLI 기록·화면 사진(커밋하지 않는다).
