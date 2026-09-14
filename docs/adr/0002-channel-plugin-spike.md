# ADR 0002 — 채널 플러그인 스파이크 (Phase 0 / 스파이크 2)

- 상태: 완료 (실측, 로컬 dev Gateway) — 원격 배포는 사람이 할 절차로 9절에 넘긴다
- 날짜: 2026-09-15
- 대상: `docs/plan.md` 3.2절(채널 플러그인)·3.3절(components 규약)·5.2절(채널 프롬프트)·5.3절(릴레이·봇 루프 보호)·5.4절(components v1)·8장 Phase 0 스파이크 2
- 산출 코드: `packages/openclaw-plugin/{openclaw.plugin.json,scripts/build.mjs,src/*}`,
  `packages/openclaw-adapter/src/bridge/{server.ts,session.ts}`, `src/spike/bridge-spike.ts`
- 원본 관찰(커밋하지 않음 — `data/` 는 ignored): `data/spike-2-observations-main.json`(A·T·B·C·D),
  `data/spike-2-observations-d2-fresh-session.json`(D2), `data/spike-2-observations-r-reset.json`(R),
  `data/spike-2-observations-tool-invoke-dryrun.json`, `data/dev-gateway.log`, `data/spike-2-run.log`

## 1. 배경과 확인할 가정

스파이크 1(ADR 0001)이 Gateway WS 쪽 절반을 쟀다. 이번에는 반대쪽 — **우리 채널 플러그인이 Gateway 안에서 돌면서 브리지로
인바운드를 받고, 에이전트가 `message` 툴로 아웃바운드를 보내며, `components` 스키마 조각을 그 툴에 노출할 수 있는가**를 잰다.
계획서가 SDK 타입·문서를 읽고 세운 가정은 다음과 같다.

1. 진입점은 `definePluginEntry({ id, register(api) { api.registerChannel({...}) } })` 이다 (3.2).
2. 플러그인은 Gateway 호스트에 `openclaw plugins install <tarball | git URL>` 로 설치하고, 계정 설정에 브리지 URL·토큰을 넣으면 아웃바운드로 붙는다 (3.2).
3. 코어가 공용 `message` 툴을 소유하고, 채널 플러그인은 `ChannelMessageActionAdapter.describeMessageTool` 로 **채널 고유 스키마 조각**(Discord `components` 같은)을 끼워 넣을 수 있다 (3.2·3.3).
4. 인바운드 시 코어가 `accountId`·`currentChannelId`·`sessionKey`·`agentId` 등의 스코프를 넘긴다 (3.2).
5. 세션 키는 `agent:<agentId>:dodok:channel:<channelId>` 로 잡을 수 있다 (5.8).
6. 채널 설정 스키마의 `ChannelBotLoopProtectionSchema` 가 에이전트 응답을 다시 인바운드로 넣는 우리 릴레이를 막을 수 있다 (5.3).
7. 채널 프롬프트는 채널별 설정(`channels.<id>.systemPrompt`)으로 두고, 플러그인이 `channel-config-writes`/`config-mutation` 으로 갱신하면 반영된다 (5.2 a-1, 스파이크 3).
8. 설정 조각 `sessions.visibility: "tree"` 로 세션 가시성을 좁힌다 (5.8, 구성 가이드 4장).

결론부터: **1·3·4·5 는 맞다(형태만 조금 다르다). 2·7·8 은 실물과 다르고, 6 은 「기본으로 막는다」가 아니라 「플러그인이 사실을 넘길 때만 동작한다」 이다.**
그리고 계획서가 몰랐던 것 하나 — **`replyOptions.runId` 로 Gateway 런 id 를 우리 런 id 로 정할 수 있다**(4.3).

## 2. 환경

| 항목 | 값 |
| --- | --- |
| Gateway | **로컬 dev 프로필** `openclaw --dev gateway run --dev --auth token --port 19001 --bind loopback` (OpenClaw.app 번들 CLI, Node 24.19.0). `gateway install`(launchd) 안 씀 |
| 버전 | OpenClaw `2026.9.4 (3a9d69d)` — 원격과 같은 버전·빌드 |
| 상태 디렉터리 | `~/.openclaw-dev` (**지우지 않았다 — 스파이크 3이 이어 쓴다**) |
| 모델 | `agents.defaults.model = "anthropic/claude-opus-5"` + `models["anthropic/claude-opus-5"].agentRuntime.id = "claude-cli"` → 관찰값 `provider: "claude-cli"`, `model: "claude-opus-5"`, thinking=high. API 키 없음(Claude Code CLI 로그인 재사용) |
| 에이전트 | **`dev` + `fin`** (브리프의 `main` 은 만들 수 없었다 — 2.1) |
| 끈 것 | `agents.defaults.heartbeat.every: "0m"`, `plugins.entries.memory-core.config.dreaming.enabled: false`, `plugins.entries.bonjour.enabled: false` (모델 런·LAN 광고 방지) |
| 계획서 설정 조각 | `tools.agentToAgent.enabled: false`, **`tools.sessions.visibility: "tree"`** (계획서의 `sessions.visibility` 는 스키마에 없다 — 10절) |
| 브리지 | 스파이크 러너가 `127.0.0.1:19100` 에 Fastify 5.12.4 + Socket.IO 4.8.3, 네임스페이스 `/bridge`. 로컬이라 터널 없음 |
| 플러그인 계정 설정 | `channels.dodok.accounts.default = { bridgeUrl: "ws://127.0.0.1:19100/bridge", token: <BRIDGE_TOKEN> }` |
| 저장소 Node / pnpm | 22.23.1 / 11.16.0 (플러그인 번들은 Gateway 의 Node 24 에서 돈다) |
| 모델 런 | **8회 전부 사용** (A 예비 1 + 본 실행 5 + D2 1 + R 1). 각 런 120초 상한 — 넘은 런 없음, 승인 요청 없음 |

### 2.1 `agents add main` 이 막혔다

```
Cannot create agent "main" while agents/main/agent owns the shared auth store. Run openclaw doctor --fix to relocate shared auth, then retry.
```

dev 프로필이 만든 기본 에이전트는 `dev`(`agents.defaults.authInheritance.agentId = "main"`)다. `doctor --fix` 는 dev 상태 밖(서비스 등)을 건드릴 수 있어 쓰지 않고
**`dev` 를 첫 번째 에이전트로 썼다**. 세션 키·릴레이 판정은 agentId 문자열에만 달려 있어 결과에 영향이 없다.

## 3. 플러그인 패키지 실물

### 3.1 진입점 — `defineChannelPluginEntry`

`api.registerChannel` 의 실제 시그니처는 `(registration: { plugin: ChannelPlugin } | ChannelPlugin) => void` 다(`openclaw/plugin-sdk/plugin-entry`).
SDK 문서가 채널 플러그인에 권하는 형태는 그것을 감싼 **`defineChannelPluginEntry({ id, name, description, plugin, setRuntime, registerCliMetadata?, registerFull? })`**
(`openclaw/plugin-sdk/channel-core`)이고, 등록 모드(`full`/`setup-only`/`cli-metadata`/`discovery`) 분기와 런타임 주입을 대신 해 준다. 산출 코드는 이것을 쓴다.
채널 객체는 `createChatChannelPlugin({ base: { id, meta, capabilities, reload, configSchema, config, messaging, actions, gateway }, outbound })` 로 만든다.

| `ChannelPlugin` 표면 | 우리가 쓴 것 |
| --- | --- |
| `config` | `listAccountIds`·`resolveAccount`·`defaultAccountId`·`isConfigured`·`isEnabled`·`inspectAccount` |
| `gateway.startAccount(ctx)` | 계정마다 브리지 연결을 열고 `waitUntilAbort(ctx.abortSignal)` 까지 유지. `ctx.channelRuntime` 로 인바운드 디스패치 |
| `actions` (`ChannelMessageActionAdapter`) | `describeMessageTool`·`supportsAction`·`handleAction` |
| `messaging` | `normalizeTarget`·`inferTargetChatType: "channel"`·`targetResolver`·`resolveOutboundSessionRoute` |
| `outbound.attachedResults.sendText` | 코어 일반 전송용 폴백(스파이크 중 호출되지 않음) |
| `reload` | `configPrefixes: ["channels.dodok"]`, `noopPrefixes: ["channels.dodok.channels"]` (3.4) |

### 3.2 매니페스트와 패키지

- `openclaw.plugin.json`: `id: "dodok"`, **`channels: ["dodok"]`**(채널 소유 표시는 `kind` 가 아니라 이 필드), `categories: ["channels"]`,
  `activation.onStartup: false`, **`channelConfigs.dodok.schema`**(= `channels.dodok` 검증용 JSON Schema), `configSchema`(= `plugins.entries.dodok.config`, 비움).
  스캐폴드(feature 플러그인)의 `contracts` 는 채널에는 필요 없었다. `channelConfigs.dodok.schema` 는 `src/config.ts` 의 Zod 스키마를 `z.toJSONSchema` 한 것이고
  `test/manifest.test.ts` 가 어긋남을 잡는다 — **Gateway 는 이 매니페스트 스키마로 `channels.dodok` 쓰기를 검증한다**
  (실측: `config set channels.dodok.channels.<id>.bogusKey true` → `invalid config for plugin dodok: must not have additional properties: "bogusKey"`).
- `package.json`: `openclaw.extensions: ["./dist/index.js"]`, `openclaw.channel: { id, label, blurb }`, `openclaw.compat.pluginApi: ">=2026.9.4"`,
  `openclaw.build.openclawVersion: "2026.9.4"`. **런타임 `dependencies` 는 없다** — `@dodok/shared`·`zod`·`socket.io-client` 는 esbuild 로 번들하고
  (`openclaw`·`openclaw/*`·node 내장·`bufferutil`·`utf-8-validate` external, CJS `require` 를 살리는 `createRequire` 배너), 설치가 `workspace:` 의존성을 받으러 가지 않게 한다.
- 번들 크기 **1.0MB** — 입력 기준 zod 832KB 가 대부분(11절).

### 3.3 설치·활성화

| 단계 | 명령·결과 |
| --- | --- |
| 빌드 | `pnpm -F @dodok/openclaw-plugin build` → `dist/index.js` |
| 패킹 | **`openclaw plugins pack`/`validate`/`build` 는 채널 플러그인을 거부**: `plugin entry does not expose tool or feature authoring metadata` (feature/tool 플러그인 전용). → **`pnpm pack --pack-destination dist`** 로 `dodok-openclaw-plugin-0.0.0.tgz`(dist/index.js·openclaw.plugin.json·package.json) |
| 설치 | `openclaw --dev plugins install <tgz> --force --accept-capabilities`. `--force` 없으면 경고(ClawHub 밖 소스), **`--accept-capabilities` 없으면 `Plugin "dodok" requires capability consent. The plugin was not installed.`** 설치 위치 `~/.openclaw-dev/extensions/dodok` |
| 로드 | `plugins inspect dodok`: `status: "loaded"`, `channelIds: ["dodok"]`, `capabilities: [{kind:"channel", ids:["dodok"]}]`, `activationReason: "enabled in config"`, **`trust.reason: "provenance-invalid"`**(archive 설치) |
| RPC `plugins.list` | `{ id:"dodok", installed:true, enabled:true, state:"enabled", origin:"global", category:"channel" }` — `restartRequired` 필드는 없다 |
| RPC `plugins.setEnabled {pluginId:"dodok", enabled:true}` | `restartRequired: false` (이미 켜져 있어 변화 없음). 파라미터 이름은 `id` 가 아니라 **`pluginId`** |

### 3.4 재시작·핫리로드 (실측 로그)

| 변화 | Gateway 반응 |
| --- | --- |
| `plugins install`(설정에 `plugins.entries.dodok` 추가) | `config hot reload applied (plugins.entries.dodok)` — 그러나 CLI 는 「Plugin source changes take effect on the next Gateway start」. 코드는 재시작 전까지 안 바뀐다 |
| `channels.dodok` 계정 추가 | `config change requires gateway restart (channels.dodok)` → **SIGUSR1 in-process restart 자동**(0.4초). 재시작 뒤 새로 설치한 번들이 로드됐다(hello 의 capabilities 로 확인) |
| `channels.dodok.channels.<id>.*` 변경 (CLI `config set` 또는 플러그인 `mutateConfigFile`) | `config change detected; evaluating reload (...)` 만 찍히고 **재시작·계정 재시작 없음** — `reload.noopPrefixes` 가 먹었다. 브리지 연결이 끊기지 않았다 |

## 4. 인바운드 경로 실물

### 4.1 흐름

```
서버 inbound.deliver ──Socket.IO──▶ bridge-client (InboundDeliver Zod 파싱)
  → toInboundFacts (세션 키 검증, sender user:<handle>/agent:<handle>, buildInboundText)
  → resolveStableChannelMessageIngress({ conversation:{kind:"channel"}, dmPolicy:"open", groupPolicy:"open", contextBinding })  → admission "dispatch" / decision "allow"
  → channelRuntime.inbound.buildContext({ route:{agentId, routeSessionKey, dispatchSessionKey}, reply:{to:"channel:<id>"}, message:{body,…}, channelIngress, extra })
  → channelRuntime.inbound.dispatch({ route:{agentId, sessionKey}, ctxPayload, replyOptions:{ runId, onAgentRunStart }, botLoopProtection?, delivery:{ deliver } })
```

- **라우팅은 코어 바인딩을 거치지 않는다.** `dispatch` 의 `route` 를 플러그인이 정하므로 서버가 고른 `agentId` 와 세션 키가 그대로 쓰인다.
- 인가 경계는 브리지 토큰이다. 플러그인은 서버가 멘션 라우팅을 끝낸 인바운드만 받으므로 ingress 정책은 `open` 으로 두었다.
- 브리지 ack 는 **`onAgentRunStart` 시점**(런 시작, 41~97ms) 또는 **런 없이 디스패치가 끝난 시점**(루프 보호 drop, 6ms)에 보낸다 — `dispatch()` 자체는 런이 끝나야 resolve 된다.

### 4.2 세션 키 — **계획서 형식 그대로 잡혔다**

`dispatch-result.routeSessionKey`, `sessions.changed.sessionKey`, `session.message.sessionKey`, `chat.sessionKey` 모두
`agent:dev:dodok:channel:0199a6c0-0000-7000-8000-000000000c01` (C 는 `agent:fin:…`). 세션은 첫 인바운드로 자동 생성되고
`sessions.changed { reason:"participants", createdVia:"channel", createdActor:{type:"human", id:"user:jang"} }` 가 먼저 온다.
전사(transcript)의 사용자 메시지에는 `__openclaw.senderIdentity = { type:"observation", id:"user:jang", pluginId:"dodok", accountId:"default", senderKind:"human" }`
(에이전트 작성자면 `senderKind:"bot"`), `transport = { channel:"dodok", conversationRef:"conv_…", messageId:<우리 message.id> }` 가 붙는다.

### 4.3 런 id — **`replyOptions.runId` 로 우리 런 id 가 Gateway 런 id 가 된다**

`GetReplyOptions.runId` 는 「Override run id for agent events」다. 인바운드의 `runId`(우리 런 id)를 넘기자
`onAgentRunStart(runId)`·`sessions.changed{phase:"start"|"end", runId}`·`chat{runId}`·`agent{runId}`·전사 `idempotencyKey` 접두가 **전부 우리 런 id 와 같았다**
(A: `4604b9f3-…` 네 곳 일치). ADR 0001 의 「`chat.send` 는 `idempotencyKey` 가 runId」와 합치면, **플러그인 경로와 WS 경로 어느 쪽으로 런을 띄워도 runId 를 우리가 정한다** —
계획서의 「runId 로 dedupe」가 id 매핑 없이 성립한다. 브리지 계약의 `providerRunId` 는 이 구성에서 `runId` 와 늘 같다(12절).

### 4.4 런을 띄우지 않은 WS 연결이 받는 것

스파이크 러너의 operator 연결(`operator.read`·`operator.write`, caps 없음)이 `sessions.subscribe` + `sessions.messages.subscribe {agentId, key}` 한 뒤
플러그인이 띄운 런에 대해 **`chat`(delta/final)·`agent`(lifecycle/thinking/tool)·`session.message`·`sessions.changed` 를 모두 받았다**.
`sessions.messages.subscribe` 에 `includeApprovals: true` 를 넣으면 `requires a paired device and gateway scope: operator.approvals` 로 거절된다.

## 5. 아웃바운드 경로 실물

### 5.1 최종 응답 — `delivery.deliver`

`deliver(payload, info)`: `info.kind: "final"`, `payload` 키 `text, replyToId, mediaUrls, mediaUrl, replyToTag, replyToCurrent, audioAsVoice`.
플러그인이 `OutboundMessage` 로 바꿔 보낸 실물(A):

```json
{ "outboundId": "dodok-reply-<uuid>", "channelId": "0199a6c0-…-000000000c01", "agentId": "dev",
  "sessionKey": "agent:dev:dodok:channel:0199a6c0-…-000000000c01",
  "runId": "4604b9f3-…", "providerRunId": "4604b9f3-…", "replyToInboundId": "<inbound message.id>",
  "text": "PONG", "attachments": [], "ts": "…" }
```

### 5.2 `message` 툴 — `describeMessageTool` 과 `handleAction`

- `describeMessageTool` 반환: `{ actions: ["send"], capabilities: [], schema: { properties: { components: <JSON Schema 7.3KB> }, actions: ["send"], visibility: "current-channel" } }`.
  타입은 TypeBox `TSchema` 지만 **Zod 에서 뽑은 JSON Schema 를 그대로 넣어도 됐다**.
- `tools.effective(sessionKey)` 의 `message` 항목: `rawDescription: "Send/manage channel messages. Supports actions: send."` — 우리가 선언한 액션 목록이 반영된다(스키마 본문은 이 RPC 에 안 나온다).
- claude-cli 백엔드에서 툴 이름은 **`mcp__openclaw__message`**(OpenClaw 툴이 MCP 루프백으로 전달된다).
- 모델이 B1 에서 보낸 인자(WS `agent` `stream:"tool"` `phase:"start"` 실물): `{ action:"send", target:"channel:0199a6c0-…", message:"버튼 테스트입니다.", components:{ text:"버튼 테스트입니다.", blocks:[{ type:"actions", items:[{ type:"button", id:"ok", label:"OK", style:"primary" }] }] } }` — **`to` 가 아니라 `target`**.
- `handleAction(ctx)` 가 받은 `ctx.params` 키: `action, target, message, components, presentation, interactive, idempotencyKey, channel, to, accountId, media, mediaUrls, replyTo, __sessionKey, __agentId`
  (코어가 `to`·`presentation`·`interactive`·`__sessionKey`·`__agentId` 등을 채운다). `ctx.sessionKey`·`ctx.agentId`·`ctx.accountId` 도 있다.
- **같은 채널에서 message 툴로 답하면 최종 텍스트 응답이 억제된다**: B1 에서 `deliver` 가 호출되지 않았고, `agent` lifecycle end 에
  `terminalReply.disposition: "silent"`, `terminalReceipt: { successfulToolNames:["message"], sourceReplyDelivered:true, rerouted:true }`.
  단 **WS `chat` delta 로 `"N"` 조각이 한 번 나갔다**(무응답 토큰의 앞머리로 보인다) — WS 미리보기 버퍼는 silent 로 끝난 런의 델타를 버려야 한다(10절).
- 전사에는 툴 전송이 `model:"delivery-mirror"` 인 assistant 메시지로 남는다.

## 6. `components`

| 확인 | 결과 |
| --- | --- |
| 스키마 조각이 툴에 붙는가 | **붙는다.** 모델이 스키마의 필드명·모양(`blocks[].type:"actions"`, `items[].type:"button"`, `id` 패턴)대로 채워 보냈다 |
| 에이전트가 실제로 채워 보내는가 | **첫 시도(B1, 브리프 문구 그대로)에 채웠다** — 재시도 불필요. 서버가 받은 `components` 는 Zod 기본값이 채워진 `{ reusable:false, ttlMs:1800000, text, blocks:[…] }` |
| 모델 없이 직접 호출 (T1, `tools.invoke`) | `{ ok:true, toolName:"message", output:{ content:[{type:"text", text:"sent to dodok channel … (<messageId>)"}], details:{…} } }` + 서버에 `components` 1블록 도착 |
| 검증 실패 (T2, 버튼 6개) | 플러그인 `handleAction` 이 `components: v1 스키마 위반 — blocks.0.items Too big: expected array to have <=5 items` 로 throw. **`tools.invoke` 응답은 `{ ok:false, error:{ code:"internal_error", message:"tool execution failed" } }` 로 뭉개진다**(원문은 Gateway 로그 `[tools-invoke] tool execution failed: Error: …` 에만). 모델 런에서 모델이 원문을 보는지는 미확인(11절) |
| 대상 없이 (T3, `to` 없음) | 플러그인까지 오지 않는다 — 코어 `MessageActionDeniedError: Action send requires a target.` (턴 컨텍스트 없는 `tools.invoke` 기준) |

**주의 — SDK 문서의 방침과 부딪힌다.** `docs/plugins/architecture-internals/channel-surfaces.md`:
「Provider-native schema extensions require explicit maintainer approval … Discord `components` is the approved built-in exception …
Do not expose unapproved provider-native UI escape hatches from the generic message tool.」 권장 경로는 `presentation` capability
(`MessagePresentation`: text·context·divider·chart·table·buttons·select 블록, 코어가 네이티브 렌더 또는 텍스트 강등)다.
2026.9.4 는 외부 플러그인의 조각을 막지 않았지만 **정책상 언제든 막힐 수 있는 경로**다. `presentation` 에는 modal·media·file 이 없다(12절).

## 7. 봇 루프 보호

### 7.1 실물 — **플러그인이 사실을 넘길 때만 동작한다**

`ChannelBotLoopProtection` 은 채널 설정 스키마만으로 켜지는 게 아니다. 코어 인바운드 러너가 턴의 **`botLoopProtection` 사실**
(`{ scopeId, conversationId, senderId, receiverId, eventId?, config?, defaultsConfig?, defaultEnabled }`)을 받았을 때만 `(scope, 대화, 봇 쌍)` 슬라이딩 윈도 예산을 적용한다
(`docs/channels/bot-loop-protection.md`: 기본 `enabled:true, maxEventsPerWindow:20, windowSeconds:60, cooldownSeconds:60`, A→B 와 B→A 는 같은 쌍).
사실을 안 넘기면 에이전트 작성 인바운드도 사람 것처럼 통과한다. 산출 플러그인은 **작성자가 에이전트일 때만** `{ scopeId: accountId, conversationId: channelId, senderId:"agent:<작성자 handle>", receiverId:"agent:<자기 handle>", eventId: deliveryId }`,
`config: channels.dodok.channels.<id>.botLoopProtection ?? channels.dodok.botLoopProtection`, `defaultsConfig: channels.defaults.botLoopProtection`, `defaultEnabled: true` 를 넘긴다.

### 7.2 시나리오 C

| 단계 | 설정 | 결과 |
| --- | --- | --- |
| C1 `dev`(에이전트) → `@fin …Reply with exactly: ACK` | 기본값 | **통과** — 런 시작(ack 97ms), `fin` 응답 `ACK` |
| C2 같은 쌍 두 번째 이벤트 | `channels.dodok.channels.<id>.botLoopProtection = {maxEventsPerWindow:1, windowSeconds:600, cooldownSeconds:600}` (CLI `config set`, 재시작 없음) | **막힘** — ack 6ms `{}`(런 없음), `dispatch-result { admission:{ kind:"drop", reason:"bot-loop-protection" }, dispatched:false }`. Gateway WS 이벤트 **0건**(세션 이벤트도 없음) |
| C3 같은 쌍 (C2 쿨다운 600초 안) | `botLoopProtection = { enabled:false }` | **통과** — 런 시작, `fin` 응답 `ACK3`. 끄면 쿨다운 중이어도 바로 풀린다 |

즉 계획서 5.3의 세 질문에 대한 답: (1) **기본값은 우리 릴레이를 막지 않는다** — 한 쌍이 60초에 20번을 넘기 전에는. (2) 막으려면·끄려면 플러그인이 사실 전달 여부와
채널 설정 키(`channels.dodok[.channels.<id>].botLoopProtection`)를 정한다 — 이 키는 우리 매니페스트 스키마에 우리가 넣은 것이다. (3) 결정은 12절.

## 8. 스파이크 3 미리보기 — 채널 `systemPrompt`

| 단계 | 결과 |
| --- | --- |
| 브리지 `config.set { channelId, config:{ systemPrompt } }` → 플러그인 `runtime.config.mutateConfigFile({ afterWrite:{mode:"auto"}, mutate })` | `followUp: { mode:"auto", requiresRestart:false }`. `runtime.config.current()` 반영까지 **62ms**(c01)·**228ms**(c02), 재시작 없음 → ack `{ applied:"live" }`. 쓰기 직후(25ms) 확인하면 아직 옛 값이라 폴링이 필요했다 |
| 주입 | 디스패치마다 `current()` 를 읽어 `buildContext({ extra:{ GroupSystemPrompt } })` — 코어 `get-reply` 가 `extraSystemPromptParts` 에 넣는다 |
| D — **기존 세션**(A·B 가 쓴 `agent:dev:…:c01`)에 코드워드 질문 | **반영 안 됨** — 「코드 워드를 모르겠습니다…」. CLI 실행 로그 `reuse=reusable-drift:system-prompt`(드리프트는 감지) |
| D2 — **새 채널 c02**(새 세션)에 같은 절차 | **반영됨** — `TANGERINE`. CLI 로그 `useResume=false session=none` |
| R — c01 에 한 번 더(드리프트 다음 턴) | **여전히 반영 안 됨**. 로그 `reuse=reusable`. 원래 계획한 `sessions.reset` 은 `missing scope: operator.admin` 으로 실패해 리셋 없이 돌았다 — 리셋 효과는 미확인 |

즉 **(a-1) 쓰기 경로 자체는 live 로 되지만, claude-cli 백엔드의 재개된 세션에는 바뀐 채널 프롬프트가 들어가지 않았다**(두 턴 연속).
코어는 드리프트 턴에 시스템 프롬프트를 다시 보내도록 짜여 있다(`resendSystemPromptForSoftResume`) — 그런데도 안 보였으므로 warm subprocess 재사용 쪽 문제로 추정한다(미확정).
스파이크 3은 이 조건(기존 세션·백엔드별)부터 잰다. 플러그인은 `ChannelPromptContext`(비신뢰 메타데이터)·인바운드 프리픽스(b)라는 대안 주입 자리도 갖고 있다.

## 9. 원격 배포 절차 (사람이 할 것)

Gateway RPC `plugins.install` 은 `source: "clawhub" | "official"` 만 받고, 로컬 CLI 의 `plugins install` 은 **CLI 가 도는 머신**에 설치한다. 원격 Gateway 에 올리려면 호스트 셸이 필요하다.

1. 개발 PC: `pnpm -F @dodok/openclaw-plugin pack` → `packages/openclaw-plugin/dist/dodok-openclaw-plugin-0.0.0.tgz`
2. 호스트로 복사: `scp packages/openclaw-plugin/dist/dodok-openclaw-plugin-0.0.0.tgz <gateway-host>:/tmp/`
3. 호스트에서(Gateway 와 같은 사용자·Node 24):
   ```bash
   openclaw plugins install /tmp/dodok-openclaw-plugin-0.0.0.tgz --force --accept-capabilities
   openclaw plugins inspect dodok --json | jq '.plugin.status, .plugin.channelIds'   # "loaded", ["dodok"]
   ```
4. 개발 PC 에서 브리지를 띄우고(`DODOK_SPIKE_MAX_RUNS=0 pnpm -F @dodok/openclaw-adapter spike:bridge`), 터널을 연다:
   ```bash
   cloudflared tunnel --url http://127.0.0.1:19100   # OpenClaw.app 번들 사본(스파이크 스크래치패드 bin/cloudflared). 출력의 https://<random>.trycloudflare.com
   ```
   Socket.IO 는 `/socket.io/` 경로로 붙으므로 터널은 오리진 전체를 넘기면 된다.
5. 호스트에서 계정 설정(토큰은 파일로 넘기고 셸 기록에 남기지 않는다):
   ```json5
   // /tmp/dodok.patch.json5 (0600)
   { channels: { dodok: { accounts: { default: { bridgeUrl: "wss://<random>.trycloudflare.com/bridge", token: "<BRIDGE_TOKEN>" } } } } }
   ```
   `openclaw config patch --file /tmp/dodok.patch.json5 && rm /tmp/dodok.patch.json5` — `channels.dodok` 변경은 Gateway 재시작을 요구한다(3.4). 서비스로 돌면 `openclaw gateway restart`.
6. 확인: 브리지 콘솔에 `플러그인 hello: {"pluginId":"dodok",…}`. 그 뒤 `DODOK_SPIKE_MAX_RUNS=<n>` 로 시나리오를 돌린다(원격 에이전트 id 는 `DODOK_SPIKE_AGENT=main DODOK_SPIKE_AGENT2=<다른 id>`).
7. 원격에 계획서 설정 조각을 적용할 때는 `tools.sessions.visibility`(10절)로 쓴다.

안정화 뒤에는 npm 퍼블리시(`openclaw plugins install @dodok/openclaw-plugin`, 호스트 CLI) 또는 ClawHub 게시(그때는 RPC `plugins.install {source:"clawhub"}` 로 원격 설치 가능)를 검토한다.

## 10. 계획서·스펙·구성 문서에서 고쳐야 할 것

| 위치 | 지금 | 실측 | 원인 |
| --- | --- | --- | --- |
| plan 5.8, 8장 Phase 0 준비, 구성 가이드 4장 설정 조각 | `sessions: { visibility: "tree" }` | **`tools.sessions.visibility`**. 루트 `sessions` 는 `Unrecognized key: "sessions"` 로 거부 | 설정 스키마(`config schema`) |
| plan 3.2·8장, 구성 가이드 2.4 배포 | 호스트에서 `plugins install <tarball \| git URL>` | 가능하나 `--force --accept-capabilities` 필요, tarball 은 `pnpm pack`(`openclaw plugins pack` 은 채널 플러그인 거부). RPC 원격 설치는 clawhub/official 만 | 3.3 |
| 구성 가이드 2.4 `index.ts` | `definePluginEntry({ register(api) { api.registerChannel(...) } })` | 동작하는 형태지만 권장은 `defineChannelPluginEntry({ plugin, setRuntime })`. 매니페스트에 `channels`·`channelConfigs`, 패키지에 `openclaw.channel`, **런타임 dependencies 없음(번들)** | 3.1·3.2 |
| 구성 가이드 2.4 `channel.ts` 설명 | 「채널별 설정 스키마(… 봇 루프 보호 조정)」 | 봇 루프 보호는 설정만으로 동작하지 않는다 — 플러그인이 인바운드에서 `botLoopProtection` 사실을 넘겨야 한다 | 7.1 |
| plan 3.2 인바운드 스코프 목록 | `accountId, currentChannelId, …` 를 「코어가 넘겨준다」 | 그 목록은 **message 툴 디스커버리·실행 컨텍스트** 쪽이다. 인바운드는 플러그인이 `buildContext`·`dispatch` 에 `route`·`reply`·`sender` 를 **넘기는** 쪽 | 4.1·5.2 |
| plan 5.3 봇 루프 보호 문단 | 「Gateway 가 자체 차단할 수 있다」 | 플러그인이 사실을 넘길 때만. 기본 예산 20/60초/쿨다운 60초, drop 사유 `bot-loop-protection`, `enabled:false` 로 즉시 해제 | 7 |
| plan 3.2·3.3·5.4 components | 「우리 채널만의 UI 스키마를 message 툴에 끼워 넣을 수 있다」 | 기술적으로 된다(실측). 단 SDK 방침은 provider-native 스키마를 막고 `presentation` 을 권한다 — 리스크로 명시 | 6 |
| plan 5.2 (a-1) | 플러그인이 `channel-config-writes`/`config-mutation` 으로 갱신 | 쓰기는 `runtime.config.mutateConfigFile`(`openclaw/plugin-sdk/config-mutation` 도 같은 이름을 export). `channel-config-writes` 는 **쓰기 권한 판정**(`authorizeConfigWrite`·`resolveChannelConfigWrites`)이지 쓰기가 아니다. 반영은 live 이나 claude-cli 기존 세션에 안 들어감 | 8 |
| 구성 가이드 3장·`infra/caddy` 설명 | `/bridge` 를 TLS 로 노출 | 브리지는 Socket.IO **네임스페이스** `/bridge` — HTTP 경로는 `/socket.io/`. `BRIDGE_PUBLIC_URL=wss://host/bridge` 는 클라이언트 URL(오리진+네임스페이스)로 맞고, 프록시 라우트는 `/socket.io` 하나로 충분 | 브리지 구현 |
| plan 4.2·5.5, 스펙 스트리밍 | WS 델타를 미리보기로 중계 | message 툴로 답한 런은 `terminalReply.disposition:"silent"` 인데 `chat` delta `"N"` 이 먼저 나간다 — `final`/lifecycle 로 silent 가 확정되면 미리보기 버블을 지워야 한다 | 5.2 |
| 브리지 계약 `InboundDeliverResult.providerRunId`·`OutboundMessage.providerRunId` | Gateway 런 id 를 따로 싣는다 | `replyOptions.runId` 로 `providerRunId === runId`. 필드는 남겨도 되지만 의미가 「같다」로 바뀐다 | 4.3 |
| CLAUDE.md 불변 규칙 「OpenClaw 패키지 3종 정확 핀」 | — | 이번에 `openclaw` 2026.9.4 devDependency 핀 완료(3종 모두 핀) | — |

## 11. 남은 질문

1. **모델 런에서 툴 검증 실패 원문이 모델에게 보이는가.** `tools.invoke` 는 `tool execution failed` 로 뭉갰다. 에이전트 턴의 MCP 툴 결과에 원문이 실리는지 한 런으로 잴 것.
2. **claude-cli 기존 세션의 시스템 프롬프트 갱신**: `sessions.reset`(operator.admin 필요) 뒤, Gateway 재시작 뒤, 다른 백엔드(API 프로바이더)에서 각각 반영되는가 — 스파이크 3의 첫 과제.
3. 원격(Gateway 호스트 → 터널 → 개발 PC 브리지)에서 같은 결과인가 — 9절 절차로 사람이 확인. 특히 `trust.reason: provenance-invalid` 인 archive 설치가 원격 `security.installPolicy` 에서 막히는지.
4. `message` 툴을 **다른 dodok 채널**(`target` 이 현재 채널이 아님)로 보낼 때 코어가 `resolveOutboundSessionRoute` 를 거쳐 어떤 세션에 기록하는가, `outbound.sendText` 폴백이 언제 불리는가(스파이크 중 0회).
5. 인바운드 컨텍스트 헤더(참여자·릴레이 규칙·최근 대화)를 본문 프리픽스 대신 `ChannelPromptContext`/`SupplementalContext` 로 넣으면 모델 행동·전사가 어떻게 달라지는가.
6. 번들 1.0MB(zod 전체) — `zod/mini` 나 공유 스키마 분리로 줄일 가치가 있는가. Gateway 의 플러그인 로드 시간 영향은 미측정.
7. `inbound.deliver` 를 같은 세션에 연속으로 넣을 때(`queueMode`) ack 시점·순서 — 이번엔 직렬 시나리오만 돌렸다.
8. 플러그인 연결이 끊긴 동안 도착한 최종 응답(큐 적재 → 재연결 flush)의 실제 동작 — 큐는 단위 테스트만 했다.

## 12. 결정 필요

1. **Node 24 전환 여부.** `openclaw` 패키지는 `engines.node >=24.16.0 <25 || >=26.1.0` 이고 Gateway 도 Node 24 에서 돈다. 지금은 플러그인 단위 테스트를 openclaw 비의존 모듈로 한정해
   저장소를 Node 22 로 유지했다(SDK 코드는 dev Gateway 실측으로만 검증). 전환하면 `channel.ts` 를 SDK 테스트 유틸(`docs/plugins/sdk-testing.md`)로 단위 테스트할 수 있다.
2. **components 노출 방식.** (a) 지금처럼 `describeMessageTool` 스키마 조각(동작함, SDK 방침과 충돌 — 향후 차단 리스크) / (b) `presentation` capability 로 선언하고 `MessagePresentation` → components v1 렌더
   (공식 경로, modal·media·file 없음) / (c) 계획서 대안 `registerTool("ui_render")`(우리 툴, 코어 message 억제·대상 해석 이점 없음). 권고: **Phase 1 은 (a) 로 가되 (b) 매핑을 병행 설계**하고, 코어 업그레이드 PR 마다 조각 노출을 회귀 확인.
3. **봇 루프 보호와 `relayPolicy` 의 관계.** (1) 사실을 넘기지 않아 코어 보호를 끄고 우리 `relayPolicy` 만 쓴다 / (2) 사실을 넘기고 코어 예산을 우리 `maxRelayTurns` 보다 느슨하게 둬 안전망으로만 쓴다(현재 구현) /
   (3) 둘 다 켜고 코어를 더 낮게. 권고: **(2)** — drop 은 브리지 ack `{}` 로만 드러나므로 서버가 「런 없이 끝남」을 릴레이 한도 메시지로 바꿀 수 있게 계약에 사유를 싣는 것까지 함께 정한다.
4. **브리지 계약 보강.** `InboundDeliverResult` 에 `{ admission: "dispatch" | "drop", reason? }` 추가 여부(3번), `providerRunId` 존치 여부(4.3).
5. **채널 프롬프트 주입 경로**(스파이크 3 결과를 보고): `GroupSystemPrompt`(설정 쓰기, 새 세션만 확인) / 인바운드 프리픽스 / 둘 병행.
6. **첫 에이전트 id.** 원격은 `main` 이 있으나 dev 프로필은 `main` 을 만들 수 없었다 — 로컬 개발 문서에 `dev` 를 쓰라고 적을지, `doctor --fix` 절차를 적을지.
