# llms.txt 실연 — 2026-10-05 결과 (sal-t6, 설정 통합 계획 태스크 6, 모델 런 0회)

> `llms.txt` 안내서의 두 절을 노드 자리에서 그대로 돌린 실연의 기록 — 계획 `docs/superpowers/plans/2026-10-05-settings-agents-llms.md` 태스크 6, 스펙 `docs/superpowers/specs/2026-10-05-settings-agents-llms-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


설계는 `docs/superpowers/specs/2026-10-05-settings-agents-llms-design.md`(구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장), 운영 절차는 `docs/guides/docker-deploy.md` 「[웹 → B] 플러그인 설치·브리지 토큰」·「러너 설치」 절의 「AI 에게 맡기는 길」.
owner 로 Gateway 를 추가하고 브리지·러너 토큰을 발급한 뒤, 「AI 에게 맡기기」 한 줄이 가리키는 `llms.txt` 의 두 절을 노드 자리에서 **명령 그대로** 돌렸다 — AI 가 할 일을 실연자가 손으로 대신했다(모델 런 금지라 실제 AI 에게 건네지 않았다).
사람의 dev 상태(`~/.openclaw-dev`·`~/.openclaw`)와 `.env` 는 읽지도 쓰지도 않았다 — Gateway 상태·노드 홈·서버 DB 를 모두 스크래치에 새로 만들었다.

**판정: 두 절 모두 통과** — Gateway 카드 「연결됨」·플러그인 「접속됨 · 서버와 같은 빌드입니다」, 러너 카드 「연결됨 · 서버와 같은 빌드입니다」. 안내서가 맞지 않는 자리는 「새로 찾은 것」 — dev 에서만 틀리는 연결 페이지 주소, 경로에 UUID 가 든 npm 전역 자리에서 깨지는 `$(npm root -g)`.

### 22.1 환경 실물

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI | 스크래치 설치 `openclaw@2026.9.5`(`OpenClaw 2026.9.5 (ec9c1a1)`, 「절차」 절 머리와 같은 설치), 저장소 mise Node 24.21 |
| 노드 자리 | 모든 노드 명령을 `HOME=<스크래치>/home OPENCLAW_HOME=<같은 곳> npm_config_prefix=<스크래치>/npm-global` 로 돌렸다 — 안내서의 `~/.dodok-bridge-token`·`~/.openclaw/extensions/…`·`~/.dodok-runner/…` 와 `npm install -g`·`$(npm root -g)` 가 고치지 않은 글자 그대로 스크래치를 가리킨다(전역 설치 없음) |
| Gateway | `gateway run --auth token --port 19051 --bind loopback`(`--dev` 없음), 공유 토큰은 0600 파일 → env `OPENCLAW_GATEWAY_TOKEN`. 설정은 「멀티 Gateway 실연」 절 「Gateway 설정」과 같은 `config patch` 한 번. PATH 앞에 가짜 `claude`(불리면 argv 를 적고 exit 1 — 모델 런이 생겨도 비용 0) |
| 서버 | `pnpm -F @dodok/openclaw-plugin run pack:plugin`·`pnpm -F @dodok/claude-runner pack:runner` 뒤 소스 실행 `node --import tsx src/main.ts`, 포트 3950, `DATA_DIR=<스크래치>/data`, `APP_ORIGIN=http://localhost:6150`, `BRIDGE_PUBLIC_URL=ws://127.0.0.1:3950/bridge`, `LOG_LEVEL=debug`. 루트 `.env` 가 끼어들지 않게 설정 키를 전부 환경에 줬다(「멀티 Gateway 실연」 절과 같다) |
| 웹 | Vite dev 6150(`DODOK_API_ORIGIN=http://127.0.0.1:3950`) |
| 브라우저 | 독립 headless Chromium(`playwright-core` 1.62.1) — 연결 페이지를 읽고 찍기만. neo 를 쓰지 않은 까닭은 「멀티 Gateway 실연」 절과 같다(`localhost` 쿠키가 neo 의 다른 세션을 덮는다). 세션 토큰은 파일에서 쿠키로만 넣었다 |
| 러너 | 안내서 2번으로 설치한 설치본. 3번(러너 전용 Claude 로그인)은 사람 단계라 하지 않고, 번들 CLI 자리에 「Claude 러너 런 0회 하네스」 절의 감싸개를 얹었다 — `ANTHROPIC_BASE_URL` 은 닫힌 로컬 포트(런을 돌리지 않아 가짜 Messages API 는 띄우지 않았다) |

### 22.2 절차

1. **토큰** — owner 로그인(`POST /api/v1/auth/local`, 본문은 `jq --arg` 로) → `POST /api/v1/gateways`(본문은 Gateway 토큰 파일에서 `jq --rawfile`) → `POST /api/v1/gateways/<id>/bridge-tokens` → 원문을 `jq -r .token` 으로 0600 파일에만. 러너 토큰(`POST /api/v1/setup/runner-tokens`)도 같게. owner 세션 토큰은 `curl -K -` 로만 실었다. 세션 토큰을 파일로 실을 때 `-K -` 와 `-d @-` 는 표준 입력을 함께 쓸 수 없다 — 본문은 0600 파일에서 `-d @<파일>`.
2. **「AI 에게 맡기기」 한 줄** — 웹의 `llmsHandoffLine`(토큰 자리만 바꿔 실행)이 만드는 줄은 `http://127.0.0.1:3950/llms.txt 를 읽고 「OpenClaw Gateway 호스트」 절대로 이 호스트에 dodok 플러그인을 설치해 줘. 브리지 토큰: <원문>`(러너는 「Claude 러너 머신」·「러너 토큰:」) — 안내서 주소의 오리진은 연결 상태 `bridge.publicUrl` 의 오리진이다. 그 주소의 본문은 웹 6150 프록시로 받은 것과 바이트가 같았다(`text/plain; charset=utf-8`·`nosniff`).
3. **두 절** — 각 bash 블록을 글자 그대로 `bash -c` 로 돌렸다. 토큰 한 줄은 1번 블록의 표준 입력으로만 넣었다. 사람 몫인 「Gateway 를 내린다·올린다」는 이 호스트의 방식(LISTEN 하는 PID 에 `kill`, 「멀티 Gateway 실연」 절 꼴의 `nohup … gateway run`)으로, 러너 4번의 에이전트는 `llmsbot`(이름 「실연 러너」, 작업 디렉터리 `~/src/my-repo` 를 만들어서)로 답했다. 러너 5번의 전경 명령은 뒤에서 띄우고 출력의 `연결됨` 을 기다렸다.

### 22.3 합격 기준

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 안내서가 로그인 없이 서버 값을 채운다 | **통과** | 200, 오리진 `http://127.0.0.1:3950`, `bridgeUrl` `ws://127.0.0.1:3950/bridge`, 두 파일의 파일·번들 sha256 이 연결 페이지 「플러그인 받기」·러너 「설치」의 값과 같다 |
| 2 | Gateway 1번 — 토큰 파일 | **통과** | `~/.dodok-bridge-token` `-rw-------` |
| 3 | Gateway 2번 — 토큰으로 받기·파일 sha256 | **통과** | `shasum -a 256` = 안내서의 파일 sha256(`90ac8f36…bca5`) |
| 4 | Gateway 3번 — 내린 뒤 설치·`loaded`·번들 sha256 | **통과** | 「Installed plugin: dodok」·「Saved for the next Gateway start.」, `"loaded"`·`["dodok"]`, `~/.openclaw/extensions/dodok/dist/index.js` = 안내서의 번들 sha256(`b59bfae2…2b06`) |
| 5 | Gateway 4번 — 패치·정리 | **통과** | 「Applied 2 config update(s). …」 exit 0, `TMPDIR` 안의 `dodok.*` 디렉터리와 토큰 파일이 모두 사라짐, `config get channels.dodok.accounts.default.bridgeUrl` = `ws://127.0.0.1:3950/bridge` |
| 6 | Gateway 5번 — 「접속됨 · 서버와 같은 빌드입니다」 | **통과** | 올린 지 약 5s 에 브리지 `connected`, `GET /api/v1/setup/status` 의 `pluginMatches: true`. 연결 페이지 카드 「실연」 「연결됨」, 「플러그인 — 상태 접속됨 … 서버와 같은 빌드입니다」, 토큰 줄 「지금 접속 중」. 루프백이라 페어링은 자동(`devices approve` 필요 없음) |
| 7 | 러너 1번 — 토큰 파일 | **통과** | `~/.dodok-runner` `drwx------`, `token` `-rw-------` |
| 8 | 러너 2번 — 받기·파일 sha256·설치·번들 sha256 | **통과**(「새로 찾은 것」 2 뒤) | 파일 `700a35c7…9754`, 설치본 `dist/main.js` `1955e0bd…6cea` — 안내서 값과 같다 |
| 9 | 러너 3번 — 번들 CLI 줄 | **통과** | 둘째 줄의 경로 `$(npm root -g)/@dodok/claude-runner/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 가 있다(로그인은 사람 단계라 띄우지 않았다) |
| 10 | 러너 4·5번 — `연결됨`·카드 | **통과** | 출력 「dodok-runner 0.0.0 · Claude Agent SDK 0.3.283 · Claude Code 2.1.283 · 에이전트 llmsbot(my-repo) · 동시 3」 → 「dodok-runner: 연결됨(서버 0.0.0)」. 연결 페이지 러너 카드 「llms-live-runner」 「연결됨」 … 「서버와 같은 빌드입니다」, 에이전트 줄 「실연 러너 · llmsbot · my-repo · sonnet」, 토큰 줄 「지금 접속 중」 |
| 11 | 시크릿 | **통과** | 브리지·러너·Gateway 공유·로컬 로그인·세션 토큰의 출현 수(`grep -a -c -F -f <토큰 파일>`) — 서버·Gateway·러너·웹 로그, 공용 `/tmp/openclaw/openclaw-<날짜>.log`, 가짜 `claude` 기록, 연결 페이지 글, 안내서 본문에서 모두 **0**. DB 덤프에는 Gateway 공유 토큰 1(설계 — 평문 저장), 브리지·러너 토큰 0(해시만). 양성 대조(토큰 파일 자신) 1 |
| 12 | 모델 런 0 | **통과** | 번들 CLI 감싸개 기록 0줄. Gateway 쪽 가짜 `claude` 는 3번 불렸고 모두 `auth status --json`(`config patch`·Gateway 기동 때 OpenClaw 가 CLI 로그인 상태를 묻는 것)이다 |

### 22.4 새로 찾은 것 (코드·안내서는 고치지 않았다)

1. **dev 에서는 5번의 연결 페이지 주소가 웹이 아니다.** 두 절 5번이 「사람에게 dodok 연결 페이지(http://127.0.0.1:3950/settings/connection)의 …」라고 말하는데, 이 오리진은 공개 오리진(`BRIDGE_PUBLIC_URL` 의 오리진)이라 dev(서버 3950·웹 6150 이 다른 오리진)에서는 404(JSON)다. 배포(Caddy 한 오리진)에서는 맞다. 기존 이월 「발급 조각 bridgeUrl 이 공개 주소 파생」과 같은 줄기다 — 서버는 웹 오리진(`APP_ORIGIN`)을 따로 알지만 안내서는 공개 오리진 하나만 쓴다.
2. **`npm root -g` 가 경로 속 UUID 꼴을 `***` 로 가려 내놓는다.** 처음에 npm 전역 자리를 세션 UUID 가 든 스크래치 경로로 두었더니 `$(npm root -g)` 가 `…/***/…` 를 내 2번 마지막 줄 `shasum -a 256 "$(npm root -g)/@dodok/claude-runner/dist/main.js"` 가 「No such file or directory」로 실패했다(설치 자체는 됐다). npm 11.19.0 이 출력의 UUID 를 비밀로 보고 가린 것이다. UUID 없는 링크 경로를 전역 자리로 주고 2번을 처음부터 다시 돌려 통과했다. 사람 머신의 전역 자리에 UUID 가 들어가는 일은 드물지만, 그러면 안내서의 `$(npm root -g)` 세 자리(2번 번들 대조·3번 번들 CLI 줄·3번 `ls`)가 함께 깨진다.
3. **받은 설치 파일은 고정 `/tmp` 이름이고 지우는 줄이 없다** — `/tmp/dodok-openclaw-plugin.tgz`·`/tmp/dodok-claude-runner.tgz` 는 패치 파일과 달리 `mktemp` 자리가 아니다(실연 뒤 손으로 지웠다). 토큰은 들어 있지 않고 sha256 대조가 바꿔치기를 잡지만, 공유 `/tmp` 에서 다른 사용자가 같은 이름을 미리 만들어 두면 `curl -o` 가 실패하거나 대조와 설치 사이에 바뀔 수 있다.

### 22.5 사람이 볼 것

- 실제 AI(Claude Code 등)에게 「AI 에게 맡기기」 한 줄을 건넸을 때 안내서의 규칙(토큰을 화면·명령 인자에 싣지 않는다, 사람 단계에서 멈춘다, sha256 이 다르면 멈춘다)을 지키는지 — 이번 실연은 명령을 사람이 그대로 돌렸다.
- 루프백이 아닌 원격 Gateway 의 페어링 대기에서 요청 id 를 AI 에게 넘기는 5번, Linux 노드(`sha256sum`, musl 의 번들 CLI 디렉터리 이름).

### 22.6 정리·잔여물

- 러너(SIGTERM)·Gateway·서버(SIGINT)·웹을 자기 PID 로 내렸다 — 19051·3950·6150 LISTEN 0, 남은 `dodok-runner`·`claude.real` 0.
- 스크래치(노드 홈 — OpenClaw 상태·토큰·러너 설정·npm 전역 자리, 서버 `DATA_DIR`, CLI 설치본, 로그)와 안내서 명령이 `/tmp` 에 만든 tgz 둘, `packages/openclaw-plugin/dist`·`packages/claude-runner/dist` 의 tgz 를 지웠다. 홈의 `~/.openclaw`·`~/.openclaw-dev` 는 시작 전후 목록이 같다(홈 디렉터리 자체의 수정 시각만 다르다).
- 남긴 것: 공용 `/tmp/openclaw/openclaw-<날짜>.log`(다른 Gateway 도 쓰는 날짜 파일이라 지우지 않았다 — 시크릿 0).
