# 제어 MCP 실연 — 2026-10-13 결과 (cm-t7, 제어 MCP 계획 태스크 7, 모델 런 0회)

> 제어 MCP 도구가 OpenClaw·러너·`claude mcp` 에서 서버에 닿는지 잰 실연의 기록 — 계획 `docs/superpowers/plans/2026-10-06-control-mcp.md` 태스크 7, 스펙 `docs/superpowers/specs/2026-10-06-control-mcp-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


설계는 `docs/superpowers/specs/2026-10-06-control-mcp-design.md`(구현과 달라진 것은 그 스펙의 「구현과 맞춘 것」 장), 에이전트 쪽은 `docs/guides/agent-guide.md` 「제어 도구 — 채널·에이전트 설정 읽고 바꾸기」 절, 바깥 클라이언트는 `docs/guides/docker-deploy.md` 「제어 MCP — 바깥 클라이언트의 `/mcp`」 절.
실물 OpenClaw Gateway(9.5)의 모델 런 경로에서 플러그인 제어 도구가 보이고 브리지 `control.call` 로 서버에 닿는지, 그 둘째 평가 세대(ADR 0004)에서 도는지, 확인 카드를 오래 둔 뒤 허용하면 모델 쪽이 무엇을 받는지를 쟀다. Claude 러너는 「Claude 러너 런 0회 하네스」 절의 하네스로, 바깥 클라이언트는 실제 `claude mcp` 로 붙였다.
사람의 상태(`~/.openclaw`·`~/.openclaw-dev`·`~/.claude*`·`~/.dodok-runner`)와 `.env` 는 읽지도 쓰지도 않았다 — Gateway 상태·서버 DB·러너 홈·Claude 설정을 모두 스크래치에 새로 만들었다.

**판정: 합격 기준 7/8 통과, 기준 6 은 주의(이월).** 태스크 5 리뷰가 걱정한 「OpenClaw claude-cli 런은 카드 대기가 5분에 끊긴다」는 진짜 CLI(2.1.283)에서 5분에는 일어나지 않았지만 **약 6분 반(실측 420초)에 다른 길로 끊긴다** — 하네스에서는 그 뒤 카드가 `cancelled` 로 닫혀 아무것도 바뀌지 않았다(기준 6). 새로 안 것은 「새로 찾은 것」.

### 25.1 환경 실물

| 항목 | 값 |
| --- | --- |
| OpenClaw CLI·Gateway | 스크래치 설치 `openclaw@2026.9.5` → `OpenClaw 2026.9.5 (ec9c1a1)`, 저장소 mise Node 24.21. `OPENCLAW_HOME=<스크래치>/gw`·포트 19061·`gateway run --auth token --bind loopback`(`--dev` 없음), 설정은 「멀티 Gateway 실연」 절 「Gateway 설정」과 같은 `config patch` 한 번, 기본 에이전트 `main` |
| 서버 | 소스 실행 `node --import tsx src/main.ts`(`apps/server`), 포트 3172, `DATA_DIR=<스크래치>/data`, `APP_ORIGIN=http://localhost:5178`(웹은 띄우지 않았다), `BRIDGE_PUBLIC_URL=ws://127.0.0.1:3172/bridge`, `LOG_LEVEL=debug`. 루트 `.env` 가 끼어들지 않게 설정 키를 전부 환경에 줬다(빈 값 포함 — 「멀티 Gateway 실연」 절과 같다). 기동 전에 `pack:plugin`·`pack:runner` |
| 버전 로그 | `"gateway connected"` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"` |
| 플러그인 | 연결 페이지 「플러그인 받기」와 같은 `GET /api/v1/setup/plugin.tgz`(owner 세션) → sha256 이 `pack:plugin` 빌드 tgz 와 같음 → **Gateway 를 내린 뒤** `plugins install <받은 파일> --force --accept-capabilities` → 설치본 `dist/index.js` sha256 = 빌드본. 브리지 토큰은 `POST /api/v1/gateways/<id>/bridge-tokens` 의 `pluginConfig` 를 0600 파일로 `config patch` 뒤 지움. 그 뒤 아래 probe 를 붙인 빌드를 같은 방법으로 다시 설치했다(설치본 sha = probe 빌드) |
| probe(커밋 안 함) | `packages/openclaw-plugin/src/control-tools.ts` — 팩토리(문맥 키·`sessionKey`·`agentAccountId`·`import.meta.url` 끝)·`prepareBeforeToolCallParams`(`hookContext` 키·`runId`)·`execute`(그 `runId` 와 상관관계 `providerRunId ?? runId`) 마다 `console.info("dodok:probe …")`, `channel.ts` — `registerBridge` 뒤 `start-account`(`import.meta.url` 끝). 같은 realm 인지는 `globalThis.__dodokProbeRealm`. 끝난 뒤 `git checkout` 으로 되돌렸다 |
| 가짜 claude CLI | 11.4 스크립트에서 — `-p` 런이면 `tools/list` 의 `dodok` 이름·`update_channel` 스키마를 적고, `fake-calls.json`(배열 `{name, arguments, timeoutMs}`)의 도구를 차례로 부른 뒤 쓰고 치운다. `--mcp-config` 의 `type`·`timeout` 을 적는다. `-p` 없는 호출은 「리액션 실연」 절처럼 고정값으로 답한다 |
| 진짜 claude CLI | 러너 tgz 의 번들 CLI(`claude-agent-sdk-darwin-arm64/claude.real`, Claude Code 2.1.283)를 Gateway PATH 앞의 감싸개로 — `HOME`·`CLAUDE_CONFIG_DIR` 은 스크래치, `ANTHROPIC_BASE_URL` 은 아래 가짜 Messages API, `auth status` 는 감싸개가 `{"loggedIn":true}` 로 답한다. 이 CLI 의 런은 새 채널에서만(가짜 CLI 의 세션 id 가 남은 채널을 잇지 않게 — 11.1 경고) |
| 러너 | 「Claude 러너 런 0회 하네스」 절 그대로 — `GET /api/v1/setup/runner.tgz` → 스크래치 `npm install -g --prefix`, 번들 CLI 감싸개(`ANTHROPIC_BASE_URL=http://127.0.0.1:3173`), `env -i … HOME=<스크래치>` 로 `dodok-runner`, 에이전트 `hx`(작업 디렉터리 스크래치 git 저장소, 모델 `sonnet`) |
| 가짜 Messages API | `packages/claude-runner/scripts/fake-messages-api.ts` 의 스크래치 사본(포트 3173)에 대본 셋 — `HX-CTL-LIST`(`mcp__dodok__list_channels`)·`HX-CTL-WRITE`(`mcp__dodok__update_channel`)·`HX-OC-WRITE`(`mcp__openclaw__dodok_update_channel`). 입력의 `$CH` 는 요청 본문의 `channel=<uuid>` 로 바꾼다. 대본 키는 마지막 user 메시지 전체에서도 찾는다(OpenClaw 프롬프트 모양) |
| 사람 쪽 드라이버 | 스크래치의 `socket.io-client` 스크립트 — 구독 → `message.send` → 이벤트를 받은 시각과 함께 적고, `approval.requested` 가 오면 정한 ms 뒤 `approval.resolve`(owner 세션, 토큰은 파일에서) |

### 25.2 합격 기준

`+ms` 는 드라이버가 보낸 때부터.

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 9.5 에서 플러그인 도구가 노출된다 — 이름·스키마·도구 정책 | **통과** | 가짜 CLI 의 loopback `tools/list` 57개 중 `dodok_list_channels` … `dodok_archive_agent` **23개**(매니페스트 `contracts.tools` 와 같은 차례), `dodok_update_channel` 의 `inputSchema` 는 `controlToolJsonSchema` 꼴(`channelId` uuid 패턴·`additionalProperties: false`). 기본 설정의 도구 정책이 거르지 않았다. 진짜 CLI 의 Messages 요청 `tools[]` 78개 중 **`mcp__openclaw__dodok_*` 23개**, `defer_loading` 없음 |
| 2 | 가짜 CLI 의 `list_channels` 가 브리지 `control.call` 로 서버에 닿아 결과가 온다 | **통과** | `tools/call dodok_list_channels` 200 · 15ms, 결과 본문이 서버 DB 의 채널 목록(`workspaceId`·`promptRevision` 포함) — 서버 말고는 낼 수 없는 값. `dodok_get_channel` 도 200 · 17ms(멤버 포함). 런 정본 `FAKE_CLI_DONE dodok_list_channels: 200 15ms · dodok_get_channel: 200 17ms` → `RUN_FINISHED` |
| 3 | 그 호출이 **둘째 평가 세대**에서 돈다(ADR 0004) | **통과** | `start-account` probe 의 `import.meta.url` 끝 `…openclaw-plugin-build-4eHbja/…/dodok/dist/index.js`, 팩토리·`prepare`·`execute` probe 는 모두 `…openclaw-plugin-build-xrZhHw/…` — 다른 평가, 같은 realm(`8isr7v`). 브리지·상관관계는 globalThis 레지스트리에서 찾았다(`ADAPTER_UNAVAILABLE`·`NOT_FOUND` 없이 성공) |
| 4 | 팩토리 문맥·호출 시점, `hookContext.runId`(태스크 5 리뷰 R3) | **통과** | 팩토리 문맥 키 25개 — `sessionKey`(`agent:main:dodok:channel:<채널>`)·`agentAccountId`(`default`)·`sessionId`·`toolBindings` 등, **런 id 는 없다**. 팩토리는 **런마다 두 번** 불렸다(런 준비 때, loopback `tools/list` 때 — 가짜 CLI 런 셋에 6번). `prepareBeforeToolCallParams` 의 `hookContext` 키는 `agentId·approvalReviewerDeviceId·channelId·config·loopDetection·runId·sessionId·sessionKey·turnSourceAccountId·turnSourceChannel·turnSourceThreadId·turnSourceTo·workspaceDir`, **`runId` 가 오고 상관관계 `providerRunId` 와 같았다**(두 런 모두 — 플러그인 대조가 통과해 서버로 갔다) |
| 5 | 쓰기 → 확인 카드 → 허용 → 바뀜(OpenClaw) | **통과** | `dodok_update_channel` → `APPROVAL_REQUESTED` +1904, `approval.requested`(`kind: dodok_control`·`requestedBy` owner·제목 「@main 이 #cm-live 의 이름·주제를 바꾸려 합니다」·설명 「주제: 실연이 바꾼 주제」·출처 「시킨 사람: @owner\n시작한 글: @owner · #cm-live · 3번째 글 「@main 쓰기 프로브」」) → 1초 뒤 허용 → `approval.resolved allowed` · `channel.updated` · 시스템 메시지 「@owner 의 요청으로 @main 이 채널 이름·주제를 바꿨습니다」 +2913 → 도구 결과 200 · 1031ms → 정본 · `RUN_FINISHED`. 운영 사건 `control_change` key `control:update_channel:<owner id>` |
| 6 | 카드를 5분 넘게 둔 뒤 허용(태스크 5 리뷰 R2) | **주의** — 330초 통과, 420초 끊김 | **진짜 CLI 2.1.283**: 카드 +548 → **330.5초 뒤 허용** → 시스템 메시지·`channel.updated` → 가짜 API 가 받은 다음 요청의 `tool_result` 가 `is_error=false`(바뀐 채널) → 정본 「HX-OC-WRITE-DONE is_error=false …」 → `RUN_FINISHED`. 카드는 하나, 5분에 끊기지 않았다. 기다리는 동안 Gateway 는 30초마다 `stalled session … reason=blocked_tool_call` 진단 줄만 남겼다. **진짜 CLI, 9분**: 카드 +457 → 결정 전 **420.2초**에 CLI 가 도구를 `MCP server "openclaw" transport dropped mid-call; response for tool "dodok_update_channel" was lost` 로 끝냄(가짜 API 가 받은 `tool_result` `is_error=true`) → 정본 「HX-OC-WRITE-DONE is_error=true …」 → 런이 닫혀 카드 `cancelled`(`run-aborted`) — 아무것도 바뀌지 않았고 카드는 하나였다. 번들 CLI 코드(`claude.real` 의 `callTool` 감시)는 30초마다 「전송 오류 뒤 90초가 지났으면」 그 오류로 끝낸다 — 390초 점검에서는 안 끝났으니 전송 오류는 300~330초 사이에 잡혔다. idle 상한은 `max(CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT ?? 300000, 서버 설정 timeout)` 이라 9.5 의 `timeout` 3,610,000ms 가 5분 idle 을 덮는다. **가짜 CLI**(Node `fetch`)는 300,872ms 에 `TypeError: fetch failed` — 가짜 CLI 자신의 undici `headersTimeout` 기본 300초다(Gateway loopback 은 `node:http` `createServer` 에 시간 상한을 걸지 않는다). 하네스의 한계이지 제품 동작이 아니다 — 그 뒤 가짜 CLI 가 턴을 끝내 런이 닫히고 카드가 `cancelled`(`run-aborted`), 아무것도 바뀌지 않았고 카드는 하나였다. loopback MCP 설정은 `type: "http"`, `timeout: 3610000` |
| 7 | Claude 러너 — `list_channels`·쓰기 카드 → 허용 | **통과** | `@hx HX-CTL-LIST` → 승인 카드 없이 도구 결과(채널 목록) → 정본 「HX-CTL-LIST-DONE is_error=false …」. `@hx HX-CTL-WRITE` → `approval.requested`(`kind: dodok_control`, 러너 도구 승인 카드는 없다 — 제어 도구는 `allowedTools`) +278 → 0.8초 뒤 허용 → `channel.updated`·시스템 메시지 「@owner 의 요청으로 @hx 가 채널 이름·주제를 바꿨습니다」 +1083 → 정본 「HX-CTL-WRITE-DONE is_error=false …」. 요청 `tools[]` 35개 중 `mcp__dodok__*` 24개(`post` + 제어 23), `defer_loading` 없음 |
| 8 | 시크릿 0 · 모델 런 0 | **통과** | Gateway 공유 토큰·로컬 로그인 토큰·세션 토큰·브리지 토큰·러너 토큰(0600 파일 하나로 `grep -a -c -F -f`)이 서버·Gateway 두 벌·러너·가짜 API 로그, 가짜 CLI 기록, 진짜 CLI 감싸개 기록, OpenClaw 쪽 드라이버 기록 7개, 공용 `/tmp/openclaw/openclaw-<날짜>.log`, 가짜 API 요청 본문에서 모두 **0**, 접두 `dbt_`·`drn_`·`dpt_`(뒤 7자 이상, `grep -E`)도 서버·Gateway·러너 로그에 0. DB 덤프에는 Gateway 공유 토큰 1(`gateways`, 설계 — 평문 저장)·세션 토큰 1(Better Auth `session`)뿐, 브리지·러너·로컬 토큰 0. 양성 대조(토큰 파일 자신) 5. 모델: 가짜 Messages API 가 받은 것은 `POST /v1/messages` 9건(러너 런 둘 × 2, 진짜 CLI 런 셋 — 1·2·2)과 `HEAD /api/hello` 3건뿐, 그 밖의 경로 0. 가짜 claude CLI `-p` 3회. 바깥 손 확인의 개인 토큰도 `dev:fake` 서버·웹·드라이버·프록시 기록에 0 |

### 25.3 바깥 손 확인 — `claude mcp`

스크래치 `HOME`·`CLAUDE_CONFIG_DIR` 로(사람의 Claude 설정을 건드리지 않게) `dev:fake` 서버(포트 3170)에 「내 계정」에서 발급한 owner 토큰으로 붙였다. Claude Code 2.1.296.

```bash
env HOME=<스크래치>/home CLAUDE_CONFIG_DIR=<스크래치>/cfg claude mcp add --transport http dodok http://localhost:3170/mcp --header "Authorization: Bearer $(cat <토큰 파일>)"
env HOME=<스크래치>/home CLAUDE_CONFIG_DIR=<스크래치>/cfg claude mcp list
```

- `add` → 「Added HTTP MCP server dodok with URL: http://localhost:3170/mcp to local config」, 머리는 `"Authorization": "[REDACTED]"` 로 찍고 스크래치 `cfg/.claude.json` 에 썼다. `list` → `dodok: http://localhost:3170/mcp (HTTP) - ✔ Connected`. ⚠ `claude mcp get dodok` 은 `Authorization: Bearer dpt_…` 를 **원문으로** 찍는다.
- **틀린 토큰** — `list` 가 `✘ Failed to connect — Server rejected the configured Authorization header (HTTP 401). Check that the token is valid for this MCP endpoint — OAuth fallback is disabled when headers.Authorization is set. Error detail: {"code":"UNAUTHORIZED","message":"mcp 토큰이 틀렸다"}`. OAuth 흐름(`/.well-known/oauth-protected-resource`)으로 빠지지 않았다 — 서버 요청 기록에 `/.well-known` 요청이 없다(태스크 4 리뷰 L6).
- 연결 한 번의 요청(로깅 프록시로 본 것): `POST` `server/discover`(프로토콜 `2026-07-28`) → **400** 「Unsupported protocol version」 → `initialize`(`2025-11-25`) 200 → `notifications/initialized` 202 → `GET` 405 → `tools/list` 200(23개). 첫 400 은 SDK 1.30.0 이 새 탐색 요청을 모르는 것이고 클라이언트가 곧바로 물러선다.
- 도구 호출은 모델 없이 공식 SDK 클라이언트(`@modelcontextprotocol/sdk` 1.30.0 `Client` + `StreamableHTTPClientTransport`, 서버가 쓰는 같은 판)로 — `listTools` 23개, `callTool list_channels` → `isError` 없음·채널 둘, `callTool update_channel` → 성공, 채널에 「@owner 가 MCP 로 채널 이름·주제를 바꿨습니다」, 사건 `control_change` detail `via: "pat"`·`agentId: null`.

### 25.4 새로 찾은 것 (코드는 고치지 않았다)

- **서버는 제어 호출을 로그에 남기지 않는다** — `LOG_LEVEL=debug` 에서도 `control.call` 이 어떤 도구로 왔는지 서버 로그에 줄이 없다. 쓰기는 운영 사건 `control_change` 가 남지만 읽기·거절(`FORBIDDEN`·`NOT_FOUND`)은 어디에도 없다. 그래서 이 실연은 「서버에 닿았다」를 결과 본문(서버 DB 값)과 쓰기의 사건·시스템 메시지로 봤다.
- **새 채널에 에이전트를 넣은 직후의 멘션이 `ADAPTER_ERROR:INTERNAL` 로 실패했다** — Gateway 로그 `PreparedModelCatalogConfigReplacedError: prepared model catalog owner config was replaced during the read`. 채널을 만들고 에이전트를 넣은 지 약 0.1초 뒤 보낸 멘션이었다 — 채널 프롬프트 동기화(`config.set`)가 설정 파일을 바꾸는 사이에 런 준비가 설정을 읽은 것으로 보인다. 같은 채널에 다시 보내자 정상이었다. 제어 MCP 와 무관한 기존 경로다(진짜 CLI 로 바꿔 띄운 Gateway 의 첫 런이었다).
- **가짜 CLI(Node `fetch`)로는 300초를 넘는 도구 대기를 못 잰다** — undici `headersTimeout` 기본값이 300초라 응답 머리를 기다리다 먼저 끊는다. 오래 기다리는 경로는 진짜 CLI + 가짜 Messages API(위 「환경 실물」)로 재거나, 가짜 CLI 의 `fetch` 에 `headersTimeout: 0` 인 undici `Agent` 를 준다.
- **러너 표준 오류의 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 경고가 런마다 도구 24개를 나열한다** — `mcp__dodok__post` 하나이던 것에 제어 도구 23개가 더해졌다(「Claude 러너 런 0회 하네스」 절 「새로 찾은 것」의 같은 경고). 의도한 미리 허용이라 해롭지 않지만 러너 터미널의 한 줄이 길어졌다.
- **서버 테스트 한 사례가 워크트리의 빌드 산출물에 기댄다** — `apps/server/test/control.mcp.test.ts` 「/mcp 의 실패 카운터는 따로다 — …」는 브리지 토큰으로 `GET /api/v1/setup/plugin.tgz` 를 불러 404(파일 없음 = 인증 통과)를 기대한다. 이 실연처럼 `pack:plugin` 으로 `packages/openclaw-plugin/dist` 에 tgz 가 있으면 200 이 와 실패한다(지우면 통과 — 둘 다 재현). 실연 뒤 `dist` 를 지우는 까닭이 하나 더 생겼다. 테스트가 「429 가 아니다」를 보거나 `DODOK_PLUGIN_DIR` 을 빈 임시 디렉터리로 주면 풀린다.
- **`control_change` 사건은 같은 사람의 다른 에이전트를 한 줄로 묶는다** — key 가 `control:<도구>:<시킨 사람>` 이라 owner 가 `@main`(OpenClaw)과 `@hx`(러너)에게 시킨 `update_channel` 셋이 `count: 3` 한 줄이고 detail 은 마지막 것(`agentId` = `@main`)이다. 스펙 「구현과 맞춘 것」 장의 판정(사람마다 묶는다)대로다 — 어느 에이전트였는지는 채널 시스템 메시지가 남는다.

### 25.5 사람이 볼 것

- 실제 모델이 읽은 글 속 지시를 따르지 않는지, 「결과를 모릅니다」를 받고 같은 요청을 되풀이하지 않는지 — 모델 런 금지라 재지 않았다.
- 원격 Gateway 판(9.4 일 수 있음)에서 `hookContext.runId` 가 오는지 — 9.4 dist 코드로는 온다(태스크 5 리뷰). 안 오면 플러그인은 대조 없이 보낸다.
- 6분 반을 넘긴 카드 뒤 **실제 모델**이 같은 요청을 다시 부르는지(카드 둘) — 하네스의 가짜 API 는 턴을 끝냈다. 전송 오류가 300초 근처에 생기는 자리(Gateway loopback 의 `node:http` 서버인지 CLI 의 HTTP 클라이언트인지)는 가르지 못했다.

### 25.6 정리·잔여물

- 러너(SIGTERM)·가짜 API·Gateway·서버(SIGINT)를 자기 PID 로 내렸다 — 19061·3172·3173 LISTEN 0, 남은 `dodok-runner`·`claude.real`·가짜 API 프로세스 0.
- 스크래치(Gateway 상태·서버 `DATA_DIR`·러너 설치본·러너 홈(토큰)·진짜 CLI 의 `HOME`·`CLAUDE_CONFIG_DIR`·CLI 설치본·토큰 파일·받은 tgz, 바깥 손 확인의 `HOME`·`CLAUDE_CONFIG_DIR`)를 지웠다. probe 를 단 `control-tools.ts`·`channel.ts` 는 `git checkout` 으로 되돌렸고, 워크트리의 `packages/openclaw-plugin/dist`·`packages/claude-runner/dist` 를 지웠다(남기면 위 「새로 찾은 것」의 서버 테스트가 실패한다). 홈의 `~/.openclaw`·`~/.openclaw-dev` 는 시작 전후 수정 시각이 같다(`stat`).
- 남긴 것: 공용 `/tmp/openclaw/openclaw-<날짜>.log`(다른 Gateway 도 쓰는 날짜 파일 — 시크릿 0), 임시 디렉터리의 `.openclaw-terminal-staging-<uid>`(사용자마다 하나인 이름이라 다른 Gateway 와 같이 쓴다), 스크래치의 로그·화면 사진(커밋하지 않는다).
