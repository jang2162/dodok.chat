# 멀티 Gateway 실연 — 2026-10-05 결과 (mg-t10, 멀티 Gateway 계획 태스크 10, 모델 런 0회)

> 멀티 Gateway 를 실물 dev Gateway 둘로 돌린 실연의 기록 — 계획 `docs/superpowers/plans/2026-10-04-multi-gateway.md` 태스크 10, 스펙 `docs/superpowers/specs/2026-10-04-multi-gateway-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


설계는 `docs/superpowers/specs/2026-10-04-multi-gateway-design.md`(구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장). 실물 OpenClaw Gateway **둘**을 서로 다른 상태 디렉터리·포트로 띄워
연결 페이지 「Gateway 추가」로 붙이고, 두 Gateway 의 같은 id 에이전트(`main`)를 핸들을 달리해 등록한 뒤 같은 채널에서 각각 불렀다. 모델은 가짜 claude CLI(11절)라 비용 0 이다.
사람의 dev 상태(`~/.openclaw-dev`·`~/.openclaw`)와 `.env` 는 읽지도 쓰지도 않았다 — Gateway 상태·공유 토큰·서버 DB 를 모두 스크래치에 새로 만들었다.

### 21.1 환경 실물

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI | 스크래치 설치 `openclaw@2026.9.5`(`OpenClaw 2026.9.5 (ec9c1a1)`, 「절차」 절 머리와 같은 설치), 저장소 mise Node 24.21 |
| Gateway 둘 | 「사무실」 `OPENCLAW_HOME=<스크래치>/gwA`·포트 19011, 「집」 `OPENCLAW_HOME=<스크래치>/gwB`·포트 19021. 둘 다 `gateway run --auth token --bind loopback`(`--dev` 없음), 공유 토큰은 Gateway 마다 새로 만든 0600 파일 → env `OPENCLAW_GATEWAY_TOKEN` |
| Gateway 설정 | 새 상태의 기본 에이전트 `main` 하나. `config patch` 한 번 — `gateway.mode "local"`·`agents.defaults.model "anthropic/claude-opus-5"`·`agents.defaults.models["anthropic/claude-opus-5"].agentRuntime.id "claude-cli"`·`heartbeat.every "0m"`·`tools.agentToAgent.enabled false`·`tools.sessions.visibility "tree"`·`plugins.entries.bonjour.enabled false`·`plugins.entries.memory-core.config.dreaming.enabled false`(ADR 0002 2절의 dev 설정과 같은 꼴) |
| 모델 | Gateway 마다 PATH 앞에 가짜 claude CLI — 11.4 스크립트에서 `message`·`ask_user` 호출을 빼고, 답 글을 `FAKE_CLI_DONE gateway=<A·B>` 로(어느 Gateway 가 답했는지), 세션 id 는 argv 의 `--session-id`·`--resume` 값을 되돌린다 |
| 서버 | 소스 실행(`tsx src/main.ts`), 포트 3950, `DATA_DIR=<스크래치>/data`, `APP_ORIGIN=http://localhost:6150`, `BRIDGE_PUBLIC_URL=ws://127.0.0.1:3950/bridge`, `LOG_LEVEL=debug`. 루트 `.env` 가 끼어들지 않게 설정 키를 **전부** 환경에 줬다(빈 값은 「설정 안 함」이고 `.env` 가 덮지 못한다) |
| 웹 | Vite dev 6150(`DODOK_API_ORIGIN=http://127.0.0.1:3950`) |
| 브라우저 | 독립 headless Chromium(Playwright `chromium.launch`). neo 를 쓰지 않은 까닭: 쿠키는 포트를 가리지 않아 `localhost:6150` 로그인이 neo 에 살아 있는 다른 `localhost` 인스턴스의 세션 쿠키를 덮는다(`docs/guideline/browser/04-shared-profile.md`), 그리고 로그인 토큰을 스크립트가 파일에서 읽어 화면·도구 입력에 싣지 않으려고 |

### 21.2 둘째 실물 Gateway — 상태 디렉터리 가르기 (계획 판정 PG8)

`openclaw --help` 가 보이는 갈래는 셋이다 — `--dev`(상태 `~/.openclaw-dev`, 기본 포트 19001), `--profile <name>`(상태 `~/.openclaw-<name>` — 홈 아래라 쓰지 않았다), 그리고 환경 변수.
번들에서 읽는 이름은 `OPENCLAW_HOME`·`OPENCLAW_STATE_DIR`·`OPENCLAW_CONFIG_PATH`·`OPENCLAW_PROFILE` 등이다(`grep -rhoE 'OPENCLAW_(STATE_DIR|CONFIG_PATH|HOME|PROFILE)' <설치>/node_modules/openclaw/dist | sort | uniq -c`).
`OPENCLAW_HOME=<디렉터리>` 하나로 상태가 `<디렉터리>/.openclaw/` 로 옮겨 간다 — `openclaw config file` 이 `<디렉터리>/.openclaw/openclaw.json` 을 낸다. 홈의 두 상태 디렉터리는 설치·기동 전후 `ls -la` 해시가 같았다.
**결과: 실물 둘로 실연했다.** 다만 Gateway 의 날짜 로그 `/tmp/openclaw/openclaw-<날짜>.log` 는 `OPENCLAW_HOME` 과 상관없이 하나를 함께 쓴다 — 시크릿 개수 확인 범위에 넣는다.

```bash
G=A; P=19011                                           # 「집」은 G=B P=19021
gw() { env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH -u OPENCLAW_PROFILE \
         OPENCLAW_HOME=$SP/gw$G PATH="$OCBIN:$PATH" openclaw "$@"; }
gw config patch --file $SP/base.patch.json5          # 21.1 「Gateway 설정」
( umask 077; openssl rand -hex 24 > $SP/gw$G.token )
( env -u OPENCLAW_GATEWAY_URL -u OPENCLAW_STATE_DIR -u OPENCLAW_CONFIG_PATH -u OPENCLAW_PROFILE OPENCLAW_HOME=$SP/gw$G \
    OPENCLAW_GATEWAY_TOKEN="$(cat $SP/gw$G.token)" PATH="$SP/fake$G/fakebin:$OCBIN:$PATH" \
    nohup openclaw gateway run --auth token --port $P --bind loopback >> $SP/logs/gw$G.log 2>&1 < /dev/null & echo $! > $SP/gw$G.pid )
```

### 21.3 절차 — 3절에 더한 것

1. **Gateway 추가** — `POST /api/v1/gateways { name, url: "ws://127.0.0.1:<포트>", token }`(본문은 `jq --rawfile` 로 토큰 파일에서, 「절차」 절 (e)). 화면의 「Gateway 추가」와 같은 경로다.
2. **플러그인** — `GET /api/v1/setup/plugin.tgz`(연결 페이지 「플러그인 받기」)로 받은 파일 → **Gateway 둘을 내린 뒤** `gw plugins install <받은 파일> --force --accept-capabilities` 를 Gateway 마다 → 설치본 `dist/index.js` sha 를 대조.
3. **브리지 토큰** — Gateway 마다 `POST /api/v1/gateways/<id>/bridge-tokens` → 응답의 `pluginConfig` 를 0600 파일로 → `gw config patch --file …` → 파일 삭제 → Gateway 를 다시 띄운다.
4. **에이전트** — 화면 「에이전트 가져오기」에서 Gateway 「사무실」의 `main` 을 핸들 `main` 으로, 「집」의 `main` 을 핸들 `main-home` 으로. 채널 하나에 둘 다 넣는다(`POST /channels/:id/members`).
5. **멘션·끄기·삭제** — `wire-cli send` 로 `@main`·`@main-home` 을 각각, 「집」 Gateway 프로세스를 내린 채(`kill <PID>`) 둘을 다시, 「집」을 다시 띄운 뒤 run_error 카드 「다시 실행」(`wire-cli interact … retry_run`), 연결 페이지 「사무실 끄기」 뒤 둘을 다시, 다시 켠 뒤 「집」 삭제·옮기기.

### 21.4 합격 기준

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 둘째 실물 Gateway(PG8) | **통과** | 21.2 — 실물 둘, 상태 디렉터리·포트·공유 토큰이 서로 다르다 |
| 2 | 「Gateway 추가」만으로 재시작 없이 붙는다, 루프백 페어링은 자동 | **통과** | `gateway added` 뒤 25~27ms 에 `gateway connected`(scopes `operator.read·write·approvals·admin`, `gatewayVersion 2026.9.5`·`gatewayBuildId 2026.9.5-release-ec9c1a13db89-…`, `gatewayId` 붙음). `openclaw devices approve` 는 필요 없었다. 카드 버전 줄 「2026.9.5 — 저장소가 검증한 버전(2026.9.4)과 다릅니다」 |
| 3 | 플러그인 받기·설치·「서버와 같은 빌드입니다」 | **통과** | 받은 파일(`dodok-openclaw-plugin-<sha 앞 12자>.tgz`) sha256 = `packages/openclaw-plugin/dist/*.tgz`, 두 설치본 `dist/index.js` sha = 빌드본. Gateway 를 다시 띄우고 약 20s 에 두 카드 모두 「플러그인 — 상태 접속됨 … 서버와 같은 빌드입니다」, 각 카드의 발급 줄에 「지금 접속 중」 |
| 4 | 가져오기 — Gateway 고르기·같은 id·핸들 겹침 | **통과** | 대화상자 「Gateway」 라디오 「사무실」·「집」. 「집」에서 `main` 을 고르면 핸들 칸이 `main` 으로 차고 「이미 쓰이는 핸들입니다 — 다른 핸들을 입력하세요」, `main-home` 으로 바꿔 등록. 에이전트 화면 `@main · 사무실`·`@main-home · 집` |
| 5 | 같은 채널에서 각각 멘션 — 답이 맞는 Gateway 에서 | **통과** | `@main` → `FAKE_CLI_DONE gateway=A`(정본 +1.23s, `finalSource=plugin`), `@main-home` → `gateway=B`(+1.16s). 두 런의 `sessionKey` 는 같은 `agent:main:dodok:channel:<채널>` 이고 `runs.connection_id` 는 각자의 Gateway id(`sqlite3 … "select a.handle, r.connection_id from runs r join agents a on a.id=r.agent_id"`) |
| 6 | 한 Gateway 가 내려가도 다른 쪽은 그대로 | **통과** | 「집」 프로세스를 내리자 어댑터 상태 「사무실」 connected/connected·「집」 reconnecting/down. `@main` 은 +0.94s 에 답. 배너 「OpenClaw Gateway 「집」에 연결되지 않아 그 Gateway 의 에이전트가 답하지 못합니다. 메시지는 저장됩니다.」, 연결 점 노랑 둘. `@main-home` 은 「대기 중」 뒤 **120s** 에 `ADAPTER_UNAVAILABLE`(`inbound not delivered within 120000ms`) run_error 카드(`retry_run`) |
| 7 | 끊긴 사이 바뀐 채널 프롬프트가 hello 때 따라온다 | **통과** | 「집」이 내려간 동안 `patch-channel {"prompt":…}` → 「사무실」 설정에는 곧바로, 「집」 설정에는 없음 → 「집」을 다시 띄우자(약 14s 에 connected/connected) 「집」 설정에도 같은 값(`gw config get channels.dodok.channels.<채널>.systemPrompt`). 다음 런의 가짜 CLI `appendSystemPrompt` 길이가 33600 → 33618 |
| 8 | 「다시 실행」 | **통과** | 6 의 카드 「다시 실행」 → 새 런이 「집」에서 `gateway=B` 로 답, `replyTo` 는 원래 사람 메시지 |
| 9 | 끄기 — 그 Gateway 만 | **통과** | 연결 페이지 「사무실 끄기」 → 배지 「꺼짐」·버튼 「켜기」·플러그인 「접속한 플러그인이 없습니다.」, 어댑터 상태 `enabled:false`·`gateway:"disabled"`. `@main` 은 10ms 에 `ADAPTER_UNAVAILABLE`(`gateway is disabled`) 카드, `@main-home` 은 그대로 답. 연결 점은 초록 둘(꺼진 Gateway 는 세지 않는다). 「켜기」(PATCH `enabled:true`) 뒤 약 8s 에 둘 다 connected/connected |
| 10 | 운영 화면 | **통과**(새로 찾은 것 1) | 상태 카드 「Gateway 「사무실」」·「플러그인 「사무실」」·「Gateway 「사무실」 버전」과 「집」의 세 줄. 사건 「Gateway 「집」 연결 끊김 (3분 동안)」·「Gateway 「집」 플러그인 연결 끊김 (3분 동안)」·「Gateway 「사무실」 검증 안 된 버전 (2026.9.5)」·「런 실패 (ADAPTER_UNAVAILABLE)」. 끄기로는 끊김 사건이 열리지 않았다 |
| 11 | 삭제·옮기기 | **통과** | `DELETE /api/v1/gateways/<집>` → `{"unboundAgents":1,"deletedTokens":1}`, `data/gateways/<집 id>/` 가 사라졌다. `@main-home` 의 `gateway` 는 null, 에이전트 화면(owner) 「Gateway 가 삭제됨 — 다른 Gateway 로 옮기세요」. 「사무실」로 옮기기 → 409 `CONFLICT`(사무실에 `main` 이 이미 있다). 지운 Gateway 의 플러그인은 계속 다시 붙으려다 `bridge connection rejected`·`token mismatch from 127.0.0.0/24 (6 more suppressed)` |
| 12 | 시크릿 | **통과** | Gateway 공유 토큰 둘·브리지 토큰 둘·로컬 로그인 토큰의 출현 수 — 서버·Gateway·웹 로그, wire-cli 기록, 공용 `/tmp/openclaw/openclaw-<날짜>.log`, 가짜 CLI 출력에서 모두 **0**. DB 덤프에는 Gateway 공유 토큰이 `gateways.token` 에 하나씩(설계 — 평문 저장), 브리지 토큰은 0(해시만) |

### 21.5 새로 찾은 것 (코드는 고치지 않았다)

1. **같은 id 를 이름 그대로 가져오면 운영 화면과 채널에서 두 에이전트가 갈리지 않는다.** 가져오기는 이름 칸을 Gateway 가 준 이름(없으면 id)으로 채워 두 에이전트 모두 이름이 `main` 이 됐다. 운영 화면 「런」의 에이전트별 표는 `main` 두 줄, 채널 메시지 작성자도 둘 다 `main` 이다 — 핸들·Gateway 는 멘션 칩·에이전트 화면·채널 설정에만 보인다. 지금 피하는 법: 가져올 때 이름도 바꾼다(예: `main (집)`).
2. **루프백 공유 토큰 접속에서는 `data/gateways/<id>/` 에 `device.json` 만 생겼다** — `device-tokens.json` 은 Gateway 가 디바이스 토큰을 내줄 때 생긴다. 백업·복원은 디렉터리째라 상관없다.
3. **끊긴 Gateway 의 에이전트 멘션은 120s 「대기 중」 뒤에야 실패한다**(꺼진 Gateway 는 곧바로). 그 사이는 배너가 알린다. 플러그인 끊김을 인바운드 제한시간으로 가르는 기존 동작이다.

### 21.6 사람이 볼 것

- 루프백이 아닌 원격 Gateway 의 페어링 대기 블록(요청 id·「승인 명령 복사」) — 이번에는 루프백이라 자동 승인이었다.
- 실제 모델로 두 `main` 의 대화가 섞이지 않는지 — 이번 실연은 가짜 CLI 라 claude 세션 전사가 없다(11.3 「세션을 잴 때 걸리는 곳」).

### 21.7 정리·잔여물

- Gateway 둘·서버(LISTEN 하는 node 에 SIGINT, tsx 부모)·웹을 자기 PID 로 내렸다 — 19011·19021·3950·6150 LISTEN 0.
- 스크래치의 Gateway 상태 디렉터리 둘·서버 `DATA_DIR`·CLI 설치본·토큰 파일·발급 응답·세션 파일을 지웠다. 워크트리 `data/wire-cli-session.json`(이 실연의 오리진 하나뿐)도 지웠다.
- 남긴 것: 공용 `/tmp/openclaw/openclaw-<날짜>.log`(다른 Gateway 도 쓰는 날짜 파일이라 지우지 않았다 — 시크릿 0), 스크래치의 화면 사진·로그(커밋하지 않는다).
