# 운영 보강(Phase 3 ③) 실연 — 2026-09-25 결과 (o3-t9a, 계획 태스크 9, 모델 런 0회)

> 운영 보강(Phase 3 ③)의 런 한도·「다시 실행」·끊김 사건·버전 드리프트를 실물 dev Gateway 에서 돌린 실연의 기록 — 계획 `docs/superpowers/plans/2026-09-25-ops-hardening.md` 태스크 9, 스펙 `docs/superpowers/specs/2026-09-25-ops-hardening-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


실물 dev Gateway 위에서 운영 보강의 네 줄기 — Gateway 버전 드리프트 사건, 워크스페이스 런 한도, run_error 「다시 실행」, 끊김 사건(`gateway_down`·`plugin_down`) — 가 도는지 쟀다.
메시지 경로는 11절 가짜 claude CLI 로만 두드렸다 — **모델 런 0회**(가짜 CLI 의 `-p` 런 5회, 나머지 12회는 `-p` 없는 호출을 진짜 `claude` 로 넘긴 것).

**판정: 합격 기준 6/6 통과. dodok 코드 결함 0.** 새로 찾은 것은 관찰 다섯(16.5) — 그중 「Gateway 쪽 실패(`unknown`)에는 「다시 실행」 버튼이 없다」와 「끊김 시간에 서버 재접속 백오프가 들어간다」는 사람 판단 거리다.
로그는 워크트리 `data/`(ignored)에 두었다가 정리 때 지웠다: `dev-gateway.log`(Gateway·플러그인)·`phase3-live-o3t9a.log`(서버·어댑터)·`web-5180.log`.

### 16.1 환경 실물

| 항목 | 값 |
| --- | --- |
| 워크트리 | main `99d9f6b` 그대로(코드 변경 없음) |
| OpenClaw CLI·Gateway | 스크래치 설치 `openclaw@2026.9.5` → `OpenClaw 2026.9.5 (ec9c1a1)`, mise Node 24.21.0(2절 표·3절 머리). 설치 전후 `~/.openclaw`·`~/.openclaw-dev` 목록 `diff` 동일(홈 디렉터리 `..` 수정 시각만 다름 — npm 캐시) |
| 버전 로그 | `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z"`, scopes 에 `operator.admin` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"`(`pluginBuiltWithSdk="2026.9.4"` 는 빌드 상수) |
| 가짜 claude CLI | 11.4 스크립트에서 툴 호출을 뺀 꼴(늘 `FAKE_CLI_DONE`) + 실패 스위치: 스크래치에 `fake-fail` 파일이 있고 내용이 `exit` 면 `-p` 런을 stderr 한 줄·exit 1 로 끝낸다. 기록에는 argv 대신 인자 개수만 적었다. Gateway 는 **매번** `PATH="<스크래치>/fakebin:$OCBIN:$PATH"` 로 띄웠다 |
| 플러그인 번들 | 이 워크트리 `pack:plugin` 빌드본 `dist/index.js` = 설치본 = `36aaf479439de23d68ee58ba9e7688b7717f53257d8e653921377ad8a1aaf797` — **다시 설치하지 않았다**(`status: "loaded"`). dev 설정 파일 `~/.openclaw-dev/openclaw.json` 수정 시각·크기가 시작·끝에 같다 |
| 서버 | `:19100`(dev 계정 `bridgeUrl` 이 `ws://127.0.0.1:19100/bridge` 라 플러그인 설정을 바꾸지 않으려고 이 포트), `APP_ORIGIN=http://localhost:5180`, 새 DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug`. `.env` 의 `BRIDGE_TOKEN` 을 라벨 `env` 로 이어받아 플러그인이 그대로 붙었다 |
| 웹·브라우저(기준 1 화면만) | `DODOK_API_ORIGIN=http://127.0.0.1:19100 pnpm -F @dodok/web exec vite --port 5180 --strictPort` · 스크래치 `playwright-core@1.62.1` headless(`chromium_headless_shell-1234`), 폭마다 새 컨텍스트, 로그인은 `context.request.post('/api/v1/auth/local')` |
| 채널 | `o3t9a-limit`(한도) · `o3t9a-clifail`(가짜 CLI 실패) · `o3t9a-retry`(다시 실행) — 전부 멤버 `@dev`, 가짜 claude 세션 id 가 박힌 하네스 전용 |
| 내장 cron | `cron list` 의 다음 실행이 fin 2026-09-27·dev 2026-09-30 — 실연 중 돌지 않았다 |

### 16.2 합격 기준

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | Gateway 버전 드리프트 → 사건 1줄 | **통과** | 새 DB 첫 접속에 `GET /api/v1/ops/status` 의 `gateway` = `{"state":"connected","version":"2026.9.5","pinned":"2026.9.4","drift":true}`, 사건 `gateway_version_untested` `key "gateway:2026.9.5"` `info` **count 1**. Gateway 를 두 번 내렸다 올린 뒤에도 count 1 그대로, `gateway_version_changed` 0(같은 버전). 운영 화면(1280·390px): 「Gateway 버전 2026.9.5 — 저장소가 검증한 버전(2026.9.4)과 다릅니다」 줄이 `data-problem="true"`(빨간 강조), 사건 목록 「검증 안 된 Gateway 버전 (2026.9.5)」. 두 폭 가로 넘침 0, 콘솔 오류 0 |
| 2 | 워크스페이스 상한 2 → 멘션 셋 → 셋째 막힘 → 비우면 다시 돎 | **통과** | `PATCH /api/v1/ops/settings {"dailyRunLimit":2}`(기본값은 300) → `@dev 한도 프로브 하나`·`둘` 은 `FAKE_CLI_DONE`·`finalSource=plugin`. `셋` 은 런 없이 시스템 메시지 `systemMeta={"kind":"run_limit","limit":{"scope":"workspace","limit":2}}` 「오늘 런 한도(2)에 도달했습니다 — 내일 0시에 풀립니다」 + `ops.event` `run_limit` `key workspace` `warn` count 1(보낸 뒤 12ms). `넷` 을 더 보내면 시스템 메시지는 **1개 그대로**, 사건은 같은 줄 count 2. `ops/status` `runsToday 2`·`blockedToday 2`. `{"dailyRunLimit":null}` 뒤 `다섯` → 답(0.96초), `runsToday 3` |
| 3 | run_error → 「다시 실행」 → 새 런 `parentRunId` | **통과** | 카드는 **플러그인 끊기**로 만들었다(가짜 CLI 실패는 카드를 만들지 않는다 — 16.5). Gateway 를 내리고(플러그인도 함께 끊김) `@dev 다시 실행 프로브` → 런 `queued` → **120초 뒤** `RUN_ERROR code=ADAPTER_UNAVAILABLE "inbound not delivered within 120000ms"` + 시스템 메시지 「@dev 실행이 실패했습니다: ADAPTER_UNAVAILABLE」 `components items=[retry_run]`. Gateway 를 올리고 둘 다 connected 뒤 `wire-cli interact <CH> <카드 id> retry_run` → `message.updated … consumed=[retry_run]` → 새 런 `RUN_QUEUED`(+11ms) → `FAKE_CLI_DONE` `replyTo=<원래 사람 메시지>` → `done finalSource=plugin`. `GET /channels/<CH>/runs`: 새 런 `parentRunId` = 원래 런 id, `triggerMessageId` = 원래 사람 메시지, 원래 런 `error ADAPTER_UNAVAILABLE`. 사건 `run_failed` 도 남았다 |
| 4 | Gateway 끊김 70초 넘게 → `gateway_down` 열림·닫힘, `downMs` ≈ 실제 | **통과** | Gateway 자기 pid kill → 서버 `"gateway connection closed; reconnecting"`·`bridge down`(26·36ms 뒤). 30·55초에 사건 없음, **60.0초**에 `gateway_down`·`plugin_down` `warn` 열림(`detail.thresholdMs 60000`, `resolvedAt null`). 78초에 기동 명령 → 85초에 둘 다 connected → 두 줄 닫힘. `downMs` 는 서버가 본 끊김과 **1~2ms** 차: gateway 84,876(서버 closed→connected 84,877), plugin 84,851(bridge down→hello 84,853). 3번의 긴 끊김에서도 한 쌍 더: gateway 172,263(실측 172,265)·plugin 148,596(실측 148,596). 부팅 때 플러그인이 7초 늦게 붙은 것은 사건이 되지 않았다(60초 임계) |
| 5 | 로그 위생 — 토큰·본문·IP 전체 0 | **통과** | 비밀 다섯(Gateway 토큰·브리지 토큰·로컬 로그인 토큰·`BETTER_AUTH_SECRET`·wire 세션 토큰) + 레이트리밋용 틀린 토큰을 스크래치 0600 파일로 두고 `grep -a -c -F -f`. 본문 넷(`한도 프로브`·`다시 실행 프로브`·`가짜 CLI 실패 프로브`·`FAKE_CLI_DONE`), IP(`127.0.0.1`·`::1`). **서버 로그·Gateway 로그·Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-25.log`·`web-5180.log`·`GET /api/v1/ops/events` 응답·`ops_events` 테이블(8행)·가짜 CLI 기록: 토큰 0·본문 0.** IP 는 `ops_events`·사건 응답 0 — 레이트리밋 사건을 일부러 일으켜(틀린 토큰 로그인 7번 → 401×5, 429×2) `detail.ipPrefix "127.0.0.0/24"` 로 줄어든 것을 봤다. 서버 로그의 IP 142줄은 전부 Fastify 요청 로그(`req.remoteAddress`)·Gateway 재접속 오류(`ECONNREFUSED 127.0.0.1:19001`)·listening URL 이다(16.5). DB 파일은 WAL 에 wire 세션 토큰 6회 — better-auth `session` 테이블의 정본 저장(그 토큰 1행 일치), `ops_events`·`messages`·`run_events`·`runs` 덤프에는 0. 양성 대조: `live-smoke.env` 로컬 토큰 1, `.env` 브리지 토큰 1 |
| 6 | 모델 런 0 | **통과** | 가짜 CLI 호출 17 = `-p` 5(성공 4 = 한도 하나·둘·다섯·다시 실행, `exit` 실패 1) + `-p` 없음 12(진짜 `claude` 로 넘긴 버전·인증 확인). `runs` 테이블 done 4·error 2(하나는 Gateway 에 닿지 않은 `ADAPTER_UNAVAILABLE`), usage `outputTokens`·`costUsd` 합 0 |

### 16.3 절차 — 3절·11절에 더한 것

11.1 준비(3절 (c)~(e), 하네스 채널) 뒤 아래를 차례로. `W` 는 11.1 의 wire-cli, `api` 는 wire-cli 세션 캐시의 토큰을 헤더 파일로 넘기는 `curl`(토큰을 인자·화면에 두지 않는다).

```bash
api GET /api/v1/ops/status | jq '{gateway, plugin, runsToday, dailyRunLimit, blockedToday, unacked}'   # 기준 1
api GET /api/v1/ops/events | jq -c '.events[] | {kind,key,severity,count,firstAt,resolvedAt,detail}'
api PATCH /api/v1/ops/settings '{"dailyRunLimit":2}'                                                   # 기준 2 — 새 DB 라 오늘 런 0
for n in 하나 둘 셋 넷; do W send $CH "@dev 한도 프로브 $n" --watch-ms 12000; done
api PATCH /api/v1/ops/settings '{"dailyRunLimit":null}'; W send $CH "@dev 한도 프로브 다섯" --watch-ms 6000
kill <Gateway pid>   # 기준 4 — 60초 전·후로 events 를 본다. 70초 넘게 기다렸다 3절 (c)(가짜 PATH) 로 올린다
kill <Gateway pid>; W send $CH2 "@dev 다시 실행 프로브" --watch-ms 135000     # 기준 3 — 120초 뒤 run_error 카드
# 3절 (c) 로 올리고 adapter/status 가 둘 다 connected 가 된 뒤
W interact $CH2 <카드 메시지 id> retry_run --watch-ms 15000
api GET /api/v1/channels/$CH2/runs | jq -c '.runs[] | {id,status,parentRunId,finalSource,error:.error.code}'
```

- **run_error 카드는 브리지가 끊긴 채 멘션해야 생긴다.** 실물 Gateway 에서는 Gateway 를 내리면 플러그인이 함께 끊긴다 — 멘션한 런이 `queuedMs`(120초) 뒤 `ADAPTER_UNAVAILABLE` 로 닫히며 카드가 붙는다. 가짜 CLI 를 실패시키면 런 오류 코드가 `unknown` 으로 오고(어댑터가 Gateway `errorKind` 를 코드로 쓰고, 없으면 `unknown`), 서버는 그 코드에 카드를 붙이지 않는다(`orchestrator.ts` 의 `NOTIFY_CODES`).
- 같은 채널·같은 에이전트에 여러 멘션을 걸면 세션 큐 때문에 120초씩 이어진다 — 카드가 여럿 필요하면 채널을 나눈다.
- Gateway 를 오래 내렸다 올리면 서버의 Gateway 재접속 백오프(상한 30초)만큼 늦게 붙는다 — 3번 차례에서 LISTEN 뒤 24.5초. `adapter/status` 가 둘 다 `connected` 인지 보고 누른다.
- 레이트리밋 사건을 보려고 틀린 토큰으로 1분에 다섯 번 넘게 로그인하면(여섯째부터 429) **같은 IP 의 정상 로그인도 그 창이 지날 때까지 429** 다 — 웹 로그인은 그 뒤에.

### 16.4 증거 원문 (본문·토큰 없음)

```text
# 서버 — 첫 접속
{"mod":"adapter","scopes":["operator.read","operator.write","operator.approvals","operator.admin"],"gatewayVersion":"2026.9.5","gatewayBuildId":"2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z","msg":"gateway connected"}
{"event":"ops.gateway_version_untested","key":"gateway:2026.9.5","count":1,"msg":"ops event"}
# ops/status — 기준 1
"gateway":{"state":"connected","version":"2026.9.5","pinned":"2026.9.4","drift":true}
# 기준 2 — 셋째 멘션
message.created kind=system systemMeta={"kind":"run_limit","limit":{"scope":"workspace","limit":2}} body="오늘 런 한도(2)에 도달했습니다 — 내일 0시에 풀립니다"
ops.event {"kind":"run_limit","severity":"warn","key":"workspace","detail":{"limit":2},"count":1}
# 기준 4 — 닫힌 두 줄
{"kind":"gateway_down","key":"gateway","count":1,"firstAt":"2026-09-25T03:20:55.979Z","resolvedAt":"2026-09-25T03:21:20.855Z","detail":{"thresholdMs":60000,"downMs":84876}}
{"kind":"plugin_down","key":"plugin","count":1,"firstAt":"2026-09-25T03:20:55.990Z","resolvedAt":"2026-09-25T03:21:20.841Z","detail":{"thresholdMs":60000,"downMs":84851}}
# 기준 3 — 카드와 다시 실행
RUN_ERROR code=ADAPTER_UNAVAILABLE message="inbound not delivered within 120000ms"
message.created kind=system systemMeta={"kind":"run_error","runId":"01a0d696-49d3-…"} items=[retry_run] consumed=[] body="@dev 실행이 실패했습니다: ADAPTER_UNAVAILABLE"
message.updated … consumed=[retry_run]
{"id":"01a0d698-ecd5-…","status":"done","parentRunId":"01a0d696-49d3-…","finalSource":"plugin","error":null}
# 기준 5 — 레이트리밋 사건
{"kind":"ratelimit","key":"rest:/api/v1/auth/local","severity":"info","detail":{"ipPrefix":"127.0.0.0/24"}}
```

### 16.5 새로 찾은 것 (코드는 고치지 않았다)

- **사람 판단 — Gateway 쪽 실패에는 「다시 실행」 버튼이 없다.** 가짜 CLI 가 exit 1 로 끝나면 Gateway 는 `RUN_ERROR code=unknown "Claude Code process exited with code 1"` 을 보내고, 서버는 `run_failed` 사건만 남기고 채널에는 카드를 붙이지 않는다(버블의 「실행 실패」만). `NOTIFY_CODES` 가 디스패치 실패·타임아웃만 알리는 설계대로다. 실제 CLI 가 인증 만료·한도 초과로 죽어도 같은 `unknown` 으로 올 가능성이 크다 — 이 경우에도 버튼을 둘지는 판단 거리(자리는 `apps/server/src/modules/runs/orchestrator.ts` 의 `notifyRunError`).
- **사람 판단 — `downMs` 는 「서버가 본 끊김」이다.** Gateway 가 다시 떠도 서버의 Gateway 재접속 백오프(`connection-manager.ts` 의 `backoff.maxMs` 30초)가 남아 있으면 그만큼 더 끊긴 것으로 센다 — 긴 끊김에서 Gateway LISTEN 뒤 서버가 붙기까지 24.5초, 그동안 플러그인은 1초 만에 붙어 `plugin_down` 은 먼저 닫혔다(gateway 172초·plugin 149초). 운영 화면이 「Gateway 연결 끊김 (3분 동안)」 이라고 말하는 동안 실제 Gateway 정지는 2분 27초였다.
- **관찰(낮음) — `run_failed` 는 에이전트별 한 줄이라 코드가 마지막 것만 남는다.** `unknown` 1번 + `ADAPTER_UNAVAILABLE` 1번이 운영 화면에서 「런 실패 (ADAPTER_UNAVAILABLE) ×2」 로 보인다. 앞의 코드는 목록에서 사라진다(사건 `key agent:<id>`, `detail.code` 덮어씀).
- **관찰(낮음) — wire 의 `RUN_STARTED` 가 `providerRunId=undefined` 로 찍히는 런이 있다.** 같은 세션의 둘째 런(`한도 프로브 둘`)에서 났고, `GET /channels/<CH>/runs` 의 `providerRunId` 는 채워져 있다. 가짜 CLI 런에서도 나므로 모델 출력과 무관하다 — 표시 순서 문제로 보인다(재지 않았다).
- **관찰 — 서버 로그에 IP 전체가 있다.** Fastify 기본 요청 로그 `"incoming request"` 의 `req.remoteAddress`(96줄)와 Gateway 재접속 오류 메시지. 스펙이 IP 를 줄이라고 한 곳은 사건·집계라 기준 밖이다. 배포에서는 Caddy 뒤라 컨테이너 네트워크 주소가 찍힌다 — 로그 보존·공유 정책이 필요하면 판단 거리.
- 스펙대로인 것 둘: 오늘 런 수는 상태 무관이라 끊김 중 `ADAPTER_UNAVAILABLE` 로 닫힌 런도 한도를 먹는다(운영 화면 「오늘 6회」 = done 4 + error 2). 워크스페이스 상한으로 막힌 수는 채널별 표의 「차단」에 들어가지 않는다(`o3t9a-limit 차단 0`, 한도 절 「막힌 런 2회」).

### 16.6 사람이 볼 것

- 원격 Gateway(원격 배포)에서 끊김 사건 — 이번은 루프백 dev 만 쟀다. 원격은 네트워크 끊김·Caddy 재시작처럼 Gateway 프로세스가 살아 있는 끊김이 있다.
- 16.5 의 앞 두 줄(Gateway 쪽 실패의 버튼, `downMs` 의 뜻).
- 14.3 의 표는 그대로다.

### 16.7 정리·잔여물

- 서버(SIGINT, `run-state.json` `clean:true`)·tsx watch/pnpm 부모·웹(vite·pnpm 부모)·Gateway 를 자기 pid 로 내렸다. **19001·19100·3100·5180·3000·8443 LISTEN 0, 5173 은 1 그대로**(다른 프로젝트, 무접촉).
- 플러그인 설치본 `36aaf479…` 그대로(`status: "loaded"`), dev 설정 파일 무변경(수정 시각·크기 같음), dev 에이전트·승인 정책 무변경, 원격 `~/.openclaw` 무접촉.
- dev 채널 세션 3개(`o3t9a-limit`·`o3t9a-clifail`·`o3t9a-retry`, 가짜 claude 세션 id)가 `~/.openclaw-dev` 에 남는다 — 진짜 모델 런에 쓰지 않는다.
- 스크래치의 `openclaw@2026.9.5` 설치본·`playwright-core`·가짜 CLI·가짜 CLI 기록·비밀 파일, 워크트리 `data/` 를 지웠다. Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-25.log` 는 Gateway 기본 자리라 두었다(토큰·본문 0). `/tmp/openclaw/openclaw-claude-skills-*` 는 이번 실연 전부터 있던 것뿐이다.
- 운영 화면 스크린숏은 `.superpowers/sdd/2026-09-25-ops-hardening/screens/o3-t9a-ops-{1280,390}.png`(ignored).
