# OpenClaw owner 권한 조사 — 2026-11-28 (모델 런 0회)

> 사용자 버그 리포트(2026-11-28, 원격 Gateway OpenClaw 2026.11.9, 에이전트 `@claw`(main), DM)의 둘째 줄 「DM 에서 owner 가 Gateway 재시작을 시켰는데 `gateway needs the owner's authority, and this turn was not started by the owner` 로 거부」를 조사한 기록. 코드는 고치지 않았다. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다.

같은 리포트의 첫 줄(`group_subject`·`conversation_label` 에 세션 id)은 같은 브랜치에서 고쳤다 — 아래 4절에 실물 확인을 함께 적는다. 근거는 핀 SDK(`packages/openclaw-plugin/node_modules/openclaw`, 2026.11.10 — 원격 11.9 판의 dist 는 읽지 않았다, **11.10 dist 로만 확인**)와 스크래치 Gateway 실연이다.

**판정: 지금 dodok 사람은 Gateway 주인의 1:1 DM(`direct`)에서도 OpenClaw owner 가 아니다(실물 재현). 채널 플러그인이 owner 를 표시할 공개 자리는 없고, owner 가 되는 길은 Gateway 설정 `commands.ownerAllowFrom` 에 dodok 발신자 id 를 적는 것뿐이다(실물 확인). 추천: ⓑ — 운영자가 고르는 문서 안내, 기본은 ⓒ 그대로.**

## 1. owner 판정은 무엇으로 정해지나 (핀 SDK 11.10)

파일은 `packages/openclaw-plugin/node_modules/openclaw/dist/` 기준. 번들이 한 줄로 접혀 있어 줄 번호는 그 심볼이 든 줄이다.

| 무엇 | 자리 | 내용 |
| --- | --- | --- |
| 거부 문구 | `agent-tools.async-Cu9hozum.mjs:13` (`resolveTurnToolSurface`) | owner 전용 툴이 `ownerOnlyDenied` 에 들면 「`<툴> needs the owner's authority, and this turn was not started by the owner. Do not retry <툴>.`」로 바꿔 끼운다 |
| owner 전용 툴 | `dangerous-tools-Bm_fma95.mjs:3` (`GATEWAY_OWNER_ONLY_CORE_TOOLS`·`resolveGatewayOwnerOnlyToolDenylist`) | 제어면 툴(`gateway` 등)에 `sessions`·`screen`·`terminal`·`portal`·`conversations_*`·`nodes`·`computer`·`mobile_ui`·`openclaw`·`intent` — `senderIsOwner !== true` 면 막는다 |
| `senderIsOwner` | `command-auth-Ch_q0NQN.mjs:9` (`resolveCommandAuthorizationState`) | `senderIsOwner = k ‖ A ‖ 바인딩된 owner 권한`. **k** — 발신자 후보(`SenderId`·`From`)가 `commands.ownerAllowFrom` 의 명시 목록(`resolveExplicitOwnerList` — 설정만 읽는다)에 있다. **A** — 내부 채널(webchat·Control UI)이고 `GatewayClientScopes` 에 `operator.admin`. **바인딩** — 코어가 같은 런의 앞 판정에서 owner 였을 때만 붙인다(`get-reply-C7sh3gUj.mjs:82` `if(ue.senderIsOwner&&nt)bindCommandOwnerAuthority(…)`) |
| 목록 항목 꼴 | `command-auth-Ch_q0NQN.mjs:9` (`resolveOwnerAllowFromList`) | `<채널>:<id>` 는 그 채널(providerId)에만, 접두가 채널이 아닌 항목(`user:owner`)은 **모든 채널**에 든다. 계정(accountId)은 가르지 않는다 |
| 운영자 안내 | `doctor-command-owner-Cqm0nMSF.mjs:3` (`formatCommandOwnerHint`), `command-gates-B701pr1y.mjs:3` (`rejectNonOwnerCommand`) | 비owner 의 owner 전용 명령에 「Ask the operator to run `openclaw config set commands.ownerAllowFrom '[…]'`」를 붙인다 — OpenClaw 가 정한 길도 이 설정이다 |
| 다른 길 — 연결된 운영자 프로필 | `channel-operator-authority-B_nLSHs2.mjs:3` (`resolveChannelOperatorAdminAuthority`) | 명명 운영자 역할(`gateway.roles`)이나 `gateway.auth.identityScopes` 를 켠 Gateway 에서 채널 발신자를 운영자 프로필에 묶으면 그 프로필의 `operator.admin` 이 owner 권한이 된다. Gateway 쪽 신원 연결이라 dodok 이 할 일이 없어 이번에는 재지 않았다 |

**채널 플러그인이 owner 를 표시할 정식 자리는 없다.**

- ingress(`resolveStableChannelMessageIngress`)의 `command.commandOwnerAllowFrom`(`config-contracts-CmjbWZfI.d.ts:8817`)은 ingress 명령 게이트(`commandAccess.authorized`)만 정한다 — 위 k 는 설정의 `commands.ownerAllowFrom` 만 읽는다.
- `MsgContext.OwnerAllowFrom`(`config-contracts-CmjbWZfI.d.ts:67207`, 「trusted, configuration-derived」)은 `extra` 로 실을 수는 있으나 `resolveCommandAuthorizationState` 에서 `enforceOwnerForCommands` 의 명령 허가(P)에만 들고 `senderIsOwner` 를 만들지 않는다.
- `bindCommandOwnerAuthority` 는 내부 심볼(`Symbol("openclaw.commandOwnerAuthority")`)이고 `plugin-sdk/` 의 공개 타입·하위 경로 어디에도 `senderIsOwner`·`ownerAllowFrom` 이 없다(`dist/plugin-sdk` 532개 파일에 0회).

## 2. 실물 — 스크래치 Gateway 에서 판정 값을 직접 봄

| 항목 | 값 |
| --- | --- |
| OpenClaw | 스크래치 설치 `openclaw@2026.11.10` → `OpenClaw 2026.11.10 (6ea542f)`(CLI 는 Homebrew Node 26.13.1 로 다시 떴다). `OPENCLAW_HOME=<스크래치>/gwA`·포트 19011·`gateway run --auth token --bind loopback`, 설정은 live-smoke 10절 「새 상태의 Gateway 설정」 그대로, 기본 에이전트 `main` |
| 서버 | 이 워크트리 소스 `node --import tsx src/main.ts`, 포트 19100, 스크래치 `DATA_DIR`·`DB_PATH`, 설정 키 전부 환경으로 |
| 플러그인 | 이 워크트리 `pack:plugin` → `plugins install --force --accept-capabilities`, 빌드본·설치본 `dist/index.js` sha256 같음(`b83ec304…`), `adapter/status` 의 `gateway`·`bridge` 모두 `connected` |
| Gateway 행 | owner 세션으로 `POST /api/v1/gateways` — `ownerUserId` = owner(= DM 주인 → 그 DM 은 `dm.direct`) |
| 가짜 claude CLI | live-smoke 9절 스크립트에서 `message` 호출 대신 run grant 로 `gateway` 툴을 `{action: "update.cleanup", dryRun: true}` 로 한 번 부른다(owner 여도 지우지 않는 미리보기 — 판정 문구만 본다). 그리고 Gateway 가 `initialize` 에 실은 `UserPromptSubmit` 훅을 `hook_callback` 으로 불러 돌려받은 문맥(「Conversation info」)을 파일로 남긴다 |

| 단계 | 조건 | `gateway` 툴 결과 |
| --- | --- | --- |
| 1 | 채널 `#ops-smoke` 의 owner 글(`chat_type: channel`) | **거부** — `gateway needs the owner's authority, and this turn was not started by the owner. Do not retry gateway.`(리포트 문구 그대로) |
| 2 | owner ↔ main DM(Gateway 주인 DM — 시스템 `chat_type: "direct"`·「You are in a Dodok direct conversation」) | **거부** — 같은 문구 |
| 3 | `commands.ownerAllowFrom: ["dodok:user:owner"]`(핫 리로드, 재시작 없음) 뒤 2 와 같은 DM | **실행** — `{"stateDir":"…","artifacts":[],"totals":{…}}`(dry-run 미리보기) |
| 4 | 3 과 같은 설정, 채널 `#ops-smoke` 의 owner 글 | **실행** — 채널에서도 owner 다 |
| 5 | `["user:owner"]`(채널 접두 없음) | **실행** |
| 6 | `["dodok:user:mia"]`(다른 사람) | **거부** |
| 7 | `config unset commands.ownerAllowFrom` | **거부**(되돌아옴) |

사람 `mia` 로 보내는 턴은 재지 않았다 — 6 이 「발신자가 목록에 없으면 owner 가 아니다」를 같은 발신자 쪽에서 잰다.

## 3. 길과 위험

세 길 모두 **세션 키·dodok 쪽 권한 모델은 바뀌지 않는다**. 바뀌는 것은 「그 dodok 사람이 시킨 턴에서 에이전트가 OpenClaw owner 전용 툴을 쓸 수 있는가」다. owner 전용 툴은 Gateway 재시작·업데이트·설정 읽기(`gateway`)만이 아니라 `terminal`·`computer`·`nodes`·`sessions`·`conversations_*` 까지다(1절 표) — 사실상 그 Gateway 호스트의 운영자 권한이다.

### ⓐ 플러그인이 「DM 주인 = Gateway 주인」(서버 `dm.direct`)일 때 owner 로 표시

- **지금 핀 SDK 로는 할 수 없다** — 1절 「정식 자리는 없다」. 남는 꼴은 둘이고 둘 다 받아들이기 어렵다. ① 내부 심볼을 흉내 내 바인딩 — SDK 판마다 깨지고 OpenClaw 가 신뢰 경계로 둔 자리를 우회한다. ② 플러그인이 `commands.ownerAllowFrom` 을 스스로 고쳐 씀 — 운영자 설정을 플러그인이 바꾸는 자기 승격이다.
- 된다고 치면 따라가는 것: 판정이 dodok 서버의 `gateways.owner_user_id` 를 따르므로 dodok 에서 Gateway 주인을 바꾸면 OpenClaw owner 도 따라 바뀐다(운영자가 모르는 사이에). **dodok 계정 탈취 = 그 Gateway 의 owner 권한**, dodok 서버 탈취(브리지 토큰으로 아무 `dm.direct` 를 실을 수 있다) = 그 서버에 붙은 모든 Gateway 의 owner 권한. 채널에서는 안 되고 주인 DM 에서만 된다는 점만 ⓑ 보다 좁다.

### ⓑ Gateway 운영자가 `commands.ownerAllowFrom` 에 dodok 발신자 id 를 적게 안내

- 적는 값은 `dodok:user:<핸들>`(채널 접두를 붙인다). 접두 없는 `user:<핸들>` 도 통하지만(2절 5) **모든 채널**에 들어 다른 채널의 같은 꼴 발신자 id 와 겹칠 수 있다.
- 그 사람이 시킨 **모든 턴**에서 owner 다 — DM 만이 아니라 채널·그룹 DM·스레드도(2절 4). 채널 턴에는 그 사람 글 말고도 「최근 대화」의 남의 글이 실리므로, 남이 쓴 글이 owner 권한 턴의 모델을 움직일 수 있다(OpenClaw 의 `isTurnTainted` 가 무엇을 오염으로 보는지는 재지 않았다). 에이전트가 쓴 글(릴레이)은 발신자가 `agent:<핸들>` 이라 owner 가 아니다.
- 핸들 변경: 사람의 핸들은 지금 바꾸는 길이 없다(`users.handle` 을 고치는 서버 코드 없음, `OWNER_HANDLE` 은 owner 를 처음 만들 때만). 재사용: 핸들은 워크스페이스 안에서 사람·에이전트를 통틀어 유일하고 비활성 멤버도 쥔다(`apps/server/src/modules/members/handles.ts` `assertHandleFree`) — 같은 워크스페이스에서는 남이 그 핸들을 얻지 못한다. **목록은 계정(accountId)을 가르지 않으므로** 한 Gateway 에 dodok 서버(워크스페이스) 둘을 붙이면 다른 워크스페이스의 같은 핸들도 owner 가 된다.
- 계정 탈취: 그 dodok 계정을 쥔 사람이 owner 권한을 얻는다 — ⓐ 와 같다. dodok 서버 탈취는 브리지 토큰으로 발신자를 꾸밀 수 있어 목록의 핸들로 owner 가 된다(ⓐ 와 같다).
- Gateway 주인 변경: dodok 에서 Gateway 주인을 바꿔도 **따라가지 않는다** — 운영자가 목록을 고쳐야 한다(정적 설정). 이것이 ⓐ 와 가장 큰 차이이고, 권한을 넓히는 쪽이 늘 운영자 손을 거친다는 장점이다.
- OpenClaw 가 스스로 권하는 길이다(`formatCommandOwnerHint`). 설정은 핫 리로드라 재시작이 필요 없다(2절 3).

### ⓒ 그대로

- dodok 사람은 어디서도 OpenClaw owner 가 아니다. Gateway 재시작·업데이트·owner 전용 툴은 Gateway 쪽(Control UI — `operator.admin`, 또는 그 호스트의 CLI)에서 한다. 에이전트는 지금처럼 「owner 가 아니다」로 답한다.

### 추천 — ⓑ, 기본은 ⓒ

ⓐ 는 공개 SDK 로 할 수 없고, 해도 권한 승격이 dodok 쪽 데이터(Gateway 주인 칸)에 묶여 운영자 모르게 움직인다. ⓑ 는 OpenClaw 가 정한 길이고, 넓히는 결정이 Gateway 운영자 손에 남는다. 그래서 **기본은 ⓒ(아무것도 하지 않음), 운영자가 원하면 ⓑ 를 문서로 안내**한다. 안내에 실을 것: ① `openclaw config set commands.ownerAllowFrom '["dodok:user:<핸들>"]'`(접두 포함, 기존 항목과 합쳐서) ② DM 만이 아니라 그 사람의 채널 턴에서도 owner 이고, owner 전용 툴에 `terminal`·`computer` 가 든다는 것 ③ 한 Gateway 에 dodok 서버를 둘 이상 붙였으면 쓰지 않는다 ④ dodok 에서 Gateway 주인을 바꿔도 따라가지 않는다. 자리는 `docs/guides/docker-deploy.md` 의 OpenClaw 연결 절이나 `docs/manual/user-guide.md` 「연결」 절 — 이번 브리프 범위 밖이라 쓰지 않았다(`docs/guides/plan.md` 8장 「이월」).

## 4. 라벨(같은 브랜치의 수정) — 실물 확인

같은 Gateway·같은 가짜 CLI 로, Gateway 가 `UserPromptSubmit` 훅으로 돌려준 「Conversation info」:

- 채널 `#ops-smoke` 의 세션 「@main 채널 라벨 프로브」: `"conversation_label":"#ops-smoke · @main 채널 라벨 프로브"`, `"group_subject":"#ops-smoke · @main 채널 라벨 프로브"`, `"is_group_chat":true`. 세션 id 는 `chat_id`(`channel:<대화 id>`)에만 있다.
- owner ↔ main DM(`direct`): `conversation_label`·`group_subject`·`is_group_chat` 이 없다 — 코어가 `direct` 에서 둘을 빼기 때문이다(`inbound-meta-CNb-mJb7.mjs:14` `conversation_label:a?void 0`, `reply-options-C7MkDUiM.mjs:3` `GroupSubject:e.conversation.kind!==\`direct\`?…`). 플러그인이 만든 `DM @owner · <제목>` 은 세션 항목의 origin 라벨(`session-accessor.sqlite-entry-CM0_ZPpq.mjs:3` `deriveSessionOrigin`)로만 간다.
- 라벨은 세션 키·`conversationRef` 에 쓰이지 않는다 — 세션 키는 플러그인이 준 명시 키(`route.dispatchSessionKey`), `conversationRef` 는 채널·계정·kind·peer·스레드로만 만든다(`conversation-identity-yZh1sIjW.mjs:3` `buildConversationIdentity` — `label` 은 결과에 실을 뿐). 같은 세션에 턴을 여럿 보낸 동안 세션 키는 그대로였다.
- 이 하네스로 처음 알게 된 것: 11.10 은 「Conversation info」 블록을 `user` 레코드가 아니라 `initialize` 의 `hooks.UserPromptSubmit` 훅 콜백 답으로 넘긴다. live-smoke 9절의 가짜 CLI(훅을 부르지 않음)로는 라벨이 보이지 않는다 — 아래 「지침」.

## 5. 지침에 넣을 것(보고)

- `docs/guides/live-smoke.md` 9절 「세션을 잴 때 걸리는 곳 넷」의 2 뒤에 한 줄: 「11.10 은 시스템 프롬프트를 `initialize` 의 `systemPrompt` 로(`appendSystemPrompt` 가 아니다), OpenClaw 가 만든 턴 문맥(「Conversation info」의 `conversation_label`·`group_subject`·`chat_id` 등)을 `user` 레코드가 아니라 `initialize.hooks.UserPromptSubmit` 의 훅 콜백 답으로 넘긴다 — 가짜 CLI 가 `control_request { subtype: "hook_callback", callback_id: <hookCallbackIds[0]>, input: { hook_event_name: "UserPromptSubmit", prompt } }` 를 stdout 에 내고 `control_response` 를 받아야 보인다(`docs/superpowers/reports/2026-11-28-openclaw-owner-authority-report.md` 2·4절).」 — 지난 실연 보고(`2026-11-27-dm-direct-live-smoke-report.md`)는 `appendSystemPrompt` 를 셌는데, 이번 실연에서 그 키가 `initialize` 에 없었다(`systemPrompt`·`systemPromptSnapshot`·`excludeDynamicSections`·`hooks`). 어느 쪽이 맞는지 가르지 않았다.

## 6. 띄운 것 / 끈 것

- 띄운 것: 스크래치 Gateway(포트 19011, `OPENCLAW_HOME` 스크래치), 스크래치 서버(포트 19100). 가짜 claude CLI 는 Gateway 가 턴마다 띄우고 끝났다(Gateway 의 모델 목록 확인 `claude --print … --tools ""` 도 가짜가 받았다 — 모델 턴 아님). 웹·러너·가짜 Messages API 는 띄우지 않았다. 모델 런 0회.
- 끈 것: 둘 다 — 끈 뒤 두 포트 모두 LISTEN 없음, 스크래치 경로를 쥔 프로세스 없음. 스크래치 디렉터리(설치본·Gateway 상태·DB·기록)는 지웠고, 이 워크트리의 `data/wire-cli-session.json`·`packages/openclaw-plugin/dist` 도 지웠다.
- 시크릿: Gateway 공유 토큰·로컬 로그인 토큰·`BETTER_AUTH_SECRET`·브리지 토큰·세션 토큰이 서버·Gateway 로그, 가짜 CLI 기록, 공용 `/tmp/openclaw/*.log` 에 0회(`grep -c -F`).
- 사람의 상태: `find ~/.openclaw ~/.openclaw-dev -maxdepth 2 -newer <시작 표식>` 비어 있음.
