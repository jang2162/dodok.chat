# 팀(Phase 4 ②) 실연 — 2026-09-27 결과 (p4m-t8a, 계획 태스크 8, 모델 런 0회)

> 팀(Phase 4 ②) — 사람이 여럿인 채널의 헤더·승인 권한·푸시 대상·내보내기를 실물 dev Gateway 에서 돌린 실연의 기록 — 계획 `docs/superpowers/plans/2026-09-26-team-members.md` 태스크 8, 스펙 `docs/superpowers/specs/2026-09-26-team-members-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


실물 dev Gateway 위에서 사람이 여럿인 채널을 쟀다 — 에이전트가 받는 헤더 「참여자:」(쓴 사람만·사람 멘션으로 자동 참여·내보내면 빠짐), 승인 권한(member 는 결정 못 함·admin 은 결정하고 에이전트가 이어감), 승인 푸시 대상(owner·admin 만), 내보내기(소켓 끊김·재접속 거절).
메시지 경로는 11절 가짜 claude CLI 로만 두드렸다 — **모델 런 0회**(가짜 CLI `-p` 런 4회). 승인도 모델 없이 일으켰다(18.3 — 가짜 CLI 의 `can_use_tool` 제어 요청).

**판정: 합격 기준 6/6 통과. dodok 팀 기능 결함 0.** 새로 안 것은 18.4 — 그중 「실물 Gateway 에서는 승인을 누른 사람(`decided_by`)이 비어 남는다」가 팀 맥락의 판단 거리다.
로그는 워크트리 `data/`(ignored)에 두었다가 정리 때 지웠다: `dev-gateway.log`(Gateway·플러그인)·`p4m-t8a-server.log`(서버·어댑터).

### 18.1 환경 실물

| 항목 | 값 |
| --- | --- |
| 워크트리 | main `c997623`(코드 변경 없음) |
| OpenClaw CLI·Gateway | 스크래치 설치 `openclaw@2026.9.5` → `OpenClaw 2026.9.5 (ec9c1a1)`, mise Node 24.21.0(2절 표·3절 머리). 설치 전후 `~/.openclaw`·`~/.openclaw-dev` 목록 `diff` 동일 |
| 버전 로그 | `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-ec9c1a13db89-2026-09-18T18-51-37.323Z"`, scopes 에 `operator.approvals`·`operator.admin` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"` |
| 플러그인 설치본 | 시작·끝 `b097e4039172228acb78ae7482b066ed1993dba7ea09e8a81b8e4ff0be162c41`(`status: "loaded"`) — **다시 설치하지 않았다.** 이 main 의 `pack:plugin` 빌드본은 `5d69522b…` 로 다르지만, 번들 `diff` 61줄이 전부 플러그인이 부르지 않는 shared 선언(`members` 스키마·`User.leftHandle`)이다 — 플러그인 소스(`packages/openclaw-plugin`)는 스레드 실연 뒤 바뀌지 않았다. 헤더를 만드는 `formatInboundContext`(`packages/openclaw-plugin/src/context.ts`)가 같다 |
| 서버 | `:19100`(dev 계정 `bridgeUrl` 이 `ws://127.0.0.1:19100/bridge` — 플러그인 설정을 바꾸지 않으려고), `APP_ORIGIN=http://localhost:5190`(웹은 띄우지 않았다 — 초대 링크 `url` 의 오리진 확인용), 새 DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug`, `NODE_EXTRA_CA_CERTS=<스크래치 푸시 받이 인증서>`(18.3). `.env` 의 `BRIDGE_TOKEN` 을 라벨 `env` 로 이어받아 플러그인이 그대로 붙었다 |
| 가짜 claude CLI | 11.4 에 둘을 보탰다 — `user` 레코드에서 **헤더 줄과 `참여자:` 줄만** 적음(핸들 목록이라 비밀 아님, 본문은 안 적음), 스크래치에 `fake-approve.json` 이 있으면 `can_use_tool` 제어 요청을 내고 결정을 최종 답 `FAKE_CLI_DONE approval=<behavior>` 에 실음(18.3). Gateway 는 `PATH="<스크래치>/fakebin:$OCBIN:$PATH"` 로 띄웠다 |
| 사람 | `@owner`(로컬 토큰) · `@adm1`(admin 초대) · `@mem1`(member 초대) · `@mem3`(member 초대, **가입만**). 셋 다 `POST /api/v1/invites` → `/invites/lookup` → `/invites/accept`, 그 뒤 이메일 로그인 `POST /auth/local {email,password}`. 비밀번호는 무작위 24자, 스크래치 0600 파일에만 |
| 채널 | `t8a-harness-<숫자>` — `@dev` 하나, 가짜 CLI 전용 |
| 내장 cron | 실연 중 `skill-collection-review` 실행 0(Gateway 로그) |

곁들여 잰 가입 경로(모두 기대대로): 초대 응답 `url` = `APP_ORIGIN` + `/join/<원문>` · 조회 200 `{workspaceName, kind:"invite", role}` · **같은 초대 원문으로 두 번째 가입 → 404** · 재설정 링크 `url` = `APP_ORIGIN` + `/reset/<원문>` → 수락 200 뒤 **옛 세션 `/auth/me` 401 · 옛 비밀번호 로그인 401 · 새 비밀번호 로그인 200** · `/auth/me` 의 `role` 이 초대 역할과 같다.

### 18.2 합격 기준

`<CH>`=하네스 채널. wire 관찰은 사람 넷이 **각자 소켓을 열고 `<CH>` 를 구독한 채**(18.3 `watch`) 쟀다 — 구독(읽기)만으로는 참여가 되지 않는다는 것도 함께 본다.

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | owner 가 초대 → member 가입 → 둘이 같은 채널에 쓰고 `@dev` → 헤더 「참여자:」에 둘 다, 쓰지 않은 사람은 없음 | **통과** | owner 일반 메시지 → mem1 일반 메시지(그 순간 `channel_members` 에 mem1 행, `joinedAt` = 보낸 시각) → owner `@dev 참여자 프로브 1` → 가짜 CLI 가 받은 줄 `참여자: @owner(사람), @mem1(사람), @dev(에이전트, 나)`. **adm1·mem3 없음** — 둘 다 가입·로그인하고 `<CH>` 를 구독해 이벤트를 받고 있었지만 쓰지 않았다 |
| 2 | 사람 멘션으로 셋째를 부르면 그 뒤 헤더에 든다 | **통과** | owner `@mem3 이것 좀 봐 주세요`(런 없음 — 사람 멘션) → mem3 참여 행 생김, mem3 에게 멘션 푸시(`urgency: normal`) 1건 → owner `@dev 참여자 프로브 2` → `참여자: @owner(사람), @mem1(사람), @mem3(사람), @dev(에이전트, 나)` |
| 3 | 승인 — member 의 결정은 `FORBIDDEN`, admin 은 결정되고 에이전트가 이어감, 승인 푸시는 owner·admin 에게만 | **통과** | 8.1 로 `exec.ask always` → mem1 `@dev 승인 프로브`(member 도 멘션은 된다) → 가짜 CLI `can_use_tool Write`(+0.68s) → 네 소켓 모두 `approval.requested` `status: pending` `toolName: Write`(+36ms). **mem1 `approval.resolve allow-once` → ack `{ok:false, error:{code:"FORBIDDEN", message:"승인·거절은 admin 이상만 할 수 있다"}}`, mem3 `deny` → 같은 `FORBIDDEN`** — 승인은 `pending` 그대로, 가짜 CLI 는 계속 기다림. REST: 승인 결정 REST 경로는 없다(wire `approval.resolve` 하나 — 팀 스펙 「역할과 권한」 절 표). 같은 member 의 admin 전용 REST 는 `POST /channels/<CH>/agents/<dev>/reset` → **403 `FORBIDDEN`**, `PATCH /channels/<CH> {"prompt":…}` → **403**. **adm1 `allow-once` → ack `{ok:true}`** → Gateway `plugin.approval.waitDecision` 18572ms 로 풀림 → 가짜 CLI `control_response behavior: "allow"`(+14ms) → 최종 답 `FAKE_CLI_DONE approval=allow` `message.created`(+318ms), 런 `done`, 네 소켓에 `approval.resolved status: allowed decision: allow-once`. 서버 `"approval resolve requested"` 의 `userId` = adm1. **푸시**: 푸시 받이에 `/push/owner`·`/push/adm1` 각 1건(`urgency: high`, 같은 `topic`) · 서버 `"push sent"` 2줄의 `subscriptionId` 가 owner·adm1 의 구독 행 · **mem1·mem3 0건**(둘 다 구독이 있다 — mem3 은 기준 2 에서 멘션 푸시를 받았다) |
| 4 | 내보내기 — member 의 소켓이 끊기고 이후 헤더에서 빠진다 | **통과** | owner `DELETE /api/v1/members/<mem1>` → 204. mem1 소켓 `disconnect reason: "io server disconnect"`(204 와 같은 ms) → 1초 뒤 재접속 `connect_error UNAUTHORIZED "invalid session"` · 옛 세션 REST(`/auth/me`·`/channels/<CH>/messages`) 401 · wire 전송 거절 · 옛 비밀번호 이메일 로그인 401 「이메일 또는 비밀번호가 맞지 않는다」. DB: `users` 행 `handle=left-<id 뒤 27자>`·`left_handle=mem1`·`email NULL`, mem1 의 푸시 구독·`channel_members` 행 없음, mem1 이 쓴 메시지 2건은 남음. owner `@dev 참여자 프로브 3` → `참여자: @owner(사람), @mem3(사람), @dev(에이전트, 나)` |
| 5 | 로그 위생 — 초대·재설정 토큰 원문·비밀번호·Gateway 토큰 0 | **통과** | 비밀 여섯 갈래를 스크래치 0600 파일로 두고 `grep -a -c -F -f` — 초대·재설정 원문 4(`dit_` 3·`drt_` 1), 비밀번호 4, 세션 토큰 8, Gateway 토큰, 브리지 토큰, 로컬 토큰·`BETTER_AUTH_SECRET`. 서버 로그 113줄·Gateway 로그 72줄·Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-27.log` 74줄·가짜 CLI 기록·wire 관찰 기록 312줄·푸시 받이 기록·DB 덤프(`messages`·`run_events`·`runs`·`ops_events`·`approvals`·`invites`·`users`·`memberships`·`push_subscriptions`·`channel_members`) 전부 **0**. 접두 문자열 `dit_`·`drt_` 도 서버·Gateway 로그에 0. 양성 대조: 하네스 상태 파일(비밀번호 3·세션 4), `.env`(Gateway 1·브리지 1), `data/live-smoke.env`(2) |
| 6 | 모델 런 0 | **통과** | 가짜 CLI `-p` 4회 = Gateway `cli exec: provider=claude-cli` 4줄 = 서버 런 4건(`done`·`finalSource=plugin`·`costUsd 0`). `-p` 없는 6회는 진짜 `claude` 로 넘긴 버전·인증 확인이다 |

### 18.3 절차 — 3절·11절에 더한 것

11.1 준비(3절 (a)~(e) — 이번은 (b) 재설치를 건너뜀) 뒤, 사람·wire 는 `wire-cli` 가 못 하므로(로컬 토큰 owner 하나만 안다) **`data/`(ignored)에 하네스 스크립트를 두고 `pnpm -s exec tsx data/<파일>.ts <명령>` 으로 돌렸다**(끝나고 지웠다). 명령과 하는 일:

| 명령 | 하는 일 |
| --- | --- |
| `setup` | owner 로그인(`LOCAL_AUTH_TOKEN`) → 초대 3건(`admin`·`member`·`member`)·조회·수락·같은 원문 재수락 → mem3 재설정 링크 발급·수락·옛/새 로그인 → 멤버 이메일 로그인 → 채널·`@dev` → 사람 넷 푸시 구독. 원문·비밀번호·세션 토큰은 **출력하지 않고** 스크래치 0600 파일에 한 줄씩(기준 5 의 `-f` 목록), 세션은 `data/` 상태 파일(0600)에 |
| `watch <사람> <ms>` | 그 사람 세션으로 소켓(`auth: {token, protocol: 1}`)을 열고 `channel.subscribe` → 이벤트를 `{ev, approval{id,status,decision,toolName} \| message{id,author,runId,본문 앞 80자}}` 로 기록, `disconnect` 면 이유를 적고 1초 뒤 재접속을 한 번 시도해 결과를 적는다. 사람마다 백그라운드로 하나씩 |
| `send <사람> <본문>` · `resolve <사람> <approvalId> <결정>` · `api <사람> <METHOD> <경로> [json]` | 그 사람으로 `message.send` · `approval.resolve`(ack 원문을 찍는다) · REST |

**모델 없이 승인을 일으키기.** Gateway 의 claude-cli 백엔드는 CLI 가 stdout 으로 낸 `control_request { subtype: "can_use_tool" }` 을 네이티브 툴 권한 요청으로 받아(9.5 `dist/extensions/anthropic/cli.runtime.js` 의 `handleRequest`) exec 정책을 판정하고, `ask` 가 `always` 면 승인을 만든다. 11.4 스크립트의 `startTurn` 에서 `system/init` 뒤에 아래를 넣고, stdin 처리에 `control_response` 를 기다리는 자리를 더한다. 정책은 8.1 로 켜고 **8.3 으로 되돌린다**.

```js
// fake-approve.json = {"tool_name":"Write","input":{"file_path":"<~/.openclaw-dev/workspace>/t8a-approval.txt","content":"hello"}}
// 파일은 실제로 쓰지 않는다. 한 번 쓰면 .used-<시각> 으로 치운다
const request_id = "req_fake_" + Date.now();
const res = await new Promise((resolve) => {
  pending.set(request_id, resolve);            // stdin 의 { type: "control_response", response: { request_id, response: { behavior } } } 가 푼다
  out({ type: "control_request", request_id,
        request: { subtype: "can_use_tool", tool_name: spec.tool_name, input: spec.input, tool_use_id: "toolu_fake_" + Date.now() } });
});
final = "FAKE_CLI_DONE approval=" + (res.response?.behavior ?? res.subtype);   // allow·deny
```

- `Write`·`Read`·`Edit` 에 `file_path` 가 있으면 코어가 경로 규칙을 먼저 본다 — 워크스페이스(`~/.openclaw-dev/workspace`) 안 경로를 준다. 이번 승인은 Gateway 에서 **플러그인 승인**(`plugin.approval.waitDecision`)으로 떴다.
- 가짜 CLI 의 대기 상한은 승인 TTL(실물 120초)보다 길게 둔다 — 이번은 300초.
- 모델 런이 아니라 Gateway 가 기록하는 승인 이벤트·`approval.resolve` RPC·런 재개가 실물 그대로 돈다. 17.5 에서 「못 잰 것」이던 승인 이벤트를 이 방법으로 모델 비용 0 으로 잴 수 있다.

**로컬 푸시 받이.** 구독 `endpoint` 는 `https://` 만 받는다(shared `PushSubscriptionInput`). 스크래치에 자체 서명 인증서(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1`)를 만들고, `https.createServer` 로 `127.0.0.1:19443` 에서 POST 의 **경로·바이트 수·`Urgency`·`Topic` 헤더만** 적고 201 을 돌려준다(본문은 암호문이라 안 적는다). 서버는 `NODE_EXTRA_CA_CERTS=<그 인증서>` 로 띄운다(`data/live-smoke.env` 에 한 줄) — TLS 검사를 끄지 않는다.
구독은 사람마다 `POST /api/v1/push/subscriptions {endpoint: "https://127.0.0.1:19443/push/<핸들>", keys: {p256dh: <P-256 공개키 base64url>, auth: <16바이트 base64url>}}`(키는 `crypto.createECDH("prime256v1")`). 받는 사람은 받이의 경로로, 서버 쪽은 `"push sent"` 의 `subscriptionId` 를 `push_subscriptions` 와 이어 본다(그 줄에 `userId` 가 없다 — 18.4).
관찰 소켓은 `presence.update` 를 보내지 않으므로 「보고 있으면 거름」(`push skipped — watching`)은 걸리지 않는다 — 누가 대상인지만 본다.

- 헤더는 가짜 CLI 기록의 `participants` 줄로 판정한다. 서버의 `GET /channels/<CH>/members` 는 사람을 id 로만 준다.
- 끝나면 만든 세션을 17.3 의 `sessions.list`·`sessions.delete` 로 지운다(이번은 `agent:dev:dodok:channel:<CH>` 하나).

### 18.4 새로 찾은 것 (코드는 고치지 않았다)

- **실물 Gateway 에서는 승인을 누른 사람이 남지 않는다(`approvals.decided_by` NULL).** adm1 의 `approval.resolve` 로 서버가 Gateway RPC 를 보내고 응답을 받기까지 11ms(`"approval resolve sent to gateway"` → `"approval already resolved — not relayed"`) 사이에 **Gateway 의 해결 이벤트가 먼저** 와서, `apps/server/src/modules/approvals/service.ts` 의 `resolve` 가 「먼저 온 쪽이 이긴다」 갈래로 빠졌다 — 그 갈래는 이벤트 쪽 행(다른 디바이스가 해결한 것으로 보는 `decidedBy` 없음)을 그대로 둔다. 누가 눌렀는지는 서버 로그 `"approval resolve requested"` 의 `userId` 에만 있다. 웹은 지금 `decidedBy` 를 그리지 않아 화면 결함은 아니지만, 사람이 여럿이면 「누가 허용했나」가 감사 거리다 — 조율자 판단.
- 관찰 — `approval.requested` 가 소켓마다 **같은 id 로 두 번**(1~2ms 차) 온다. 서버가 두 프레임을 병합하며 둘 다 wire 로 흘리는 기존 동작이다(푸시는 `seenApprovals` 로 한 번만 — 이번에도 사람마다 1건).
- 관찰 — `"push sent"` debug 줄에는 `userId` 가 없고 `subscriptionId` 만 있다(`"push send failed"`·`"push skipped — watching"` 에는 있다). 「누구에게 갔나」를 로그만으로 보려면 같은 줄에 `userId`·`kind` 를 싣는 것이 가장 싸다(자리: `apps/server/src/modules/push/service.ts` 의 `sendOne`).
- 관찰 — 플러그인 소스가 그대로여도 shared 가 바뀌면 번들 sha 가 달라진다(이번 `b097e403…` 대 `5d69522b…`, 차이는 플러그인이 안 쓰는 shared 선언뿐). 연결 페이지의 「같은 빌드」 판정(`bundleSha256`)은 이런 main 에서 「다른 빌드」로 보인다 — 보수적 판정이라 틀린 것은 아니다.
- 관찰 — 8.3 되돌리기가 `agents.entries.dev.tools = { exec: {} }` 빈 껍데기를 남겨 dev 설정 파일이 51바이트 커졌다. `tools` 를 지워 시작 크기(2155)로 되돌렸고, 8.3 에 그 줄을 보탰다.
- 주석 어긋남 — `packages/shared/src/domain/index.ts` 의 `leftHandle` 주석은 「`left-<id 뒤 12자>`」라 하는데 실제 핸들은 스펙대로 `left-<id 뒤 27자>` 다(DB 에서 확인).

### 18.5 사람이 볼 것

- 원격 Gateway 판(9.4 일 수 있음)에서 승인 — `decided_by` 가 비는지(이벤트·RPC 응답 순서)는 판마다 다를 수 있다.
- 실제 폰에서 승인 푸시가 owner·admin 에게만 오는지 — 이번은 로컬 받이로 대상만 쟀다(실제 FCM·APNs 전달은 `docs/guides/docker-deploy.md` 체크리스트).
- 18.4 첫 줄(`decided_by`)을 고칠지.

### 18.6 정리·잔여물

- 서버(SIGINT, `run-state.json` `clean:true`)·tsx watch/pnpm 부모·Gateway·푸시 받이·관찰 소켓을 자기 pid 로 내렸다. **19001·19100·19443·3110·5190 LISTEN 0**, 5173 은 시작 때부터 떠 있던 다른 프로세스 그대로. 남은 `fakebin/claude`·`openclaw-gateway` 프로세스 0.
- 플러그인 설치본 `b097e403…` 그대로(`status: "loaded"`), `bridgeUrl` `ws://127.0.0.1:19100/bridge` 그대로, `channels.dodok.channels` 시작·끝 없음, `agents.entries.dev.tools` 시작·끝 없음 — dev 설정 파일 크기 2155 로 시작과 같다(수정 시각만 `config set/unset` 이 바꿨다). dev 에이전트 무변경, 원격 `~/.openclaw` 무접촉(목록 `diff` 는 홈 `..` 수정 시각만).
- 만든 dev 세션 1개(`agent:dev:dodok:channel:<CH>`)를 `sessions.delete` 로 지웠다. 워크스페이스에 파일을 만들지 않았다(가짜 `Write` 는 승인만 청했다).
- 스크래치의 `openclaw@2026.9.5` 설치본·가짜 CLI·그 기록·푸시 받이·인증서·비밀 파일, 워크트리 `data/`(하네스 스크립트·상태·DB·로그)·`packages/openclaw-plugin/dist` 를 지웠다. Gateway 자체 로그 `/tmp/openclaw/openclaw-dev-2026-09-27.log` 는 Gateway 기본 자리라 두었다(비밀 0).
