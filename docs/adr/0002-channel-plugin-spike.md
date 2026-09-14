# ADR 0002 — 채널 플러그인 스파이크 (Phase 0 / 스파이크 2)

- 상태: 완료 (실측, 로컬 dev Gateway) — 원격 배포는 사람이 할 절차로 9절에 넘긴다
- 날짜: 2026-09-15
- 대상: `docs/plan.md` 3.2절(채널 플러그인)·3.3절(components 규약)·5.2절(채널 프롬프트)·5.3절(릴레이·봇 루프 보호)·5.4절(components v1)·8장 Phase 0 스파이크 2
- 산출 코드: `packages/openclaw-plugin/{openclaw.plugin.json,scripts/build.mjs,src/*}`,
  `packages/openclaw-adapter/src/bridge/{server.ts,session.ts}`, `src/spike/{bridge-spike.ts,bridge-serve.ts}`
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
| 패킹 | **`openclaw plugins pack`/`validate`/`build` 는 채널 플러그인을 거부**: `plugin entry does not expose tool or feature authoring metadata` (feature/tool 플러그인 전용). → **`pnpm -F @dodok/openclaw-plugin run pack:plugin`**(빌드 → `pnpm pack --pack-destination dist`)로 `packages/openclaw-plugin/dist/dodok-openclaw-plugin-0.0.0.tgz`(dist/index.js·openclaw.plugin.json·package.json). 스크립트 이름을 `pack` 으로 두면 `pnpm -F … pack` 이 pnpm 내장 `pack` 을 불러 빌드 없이 워크스페이스 루트에 떨군다(수정 라운드 1에서 이름 변경) |
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

Gateway RPC `plugins.install` 은 `source: "clawhub" | "official"` 만 받고, CLI `plugins install` 은 **CLI 가 도는 머신**에 설치한다. 원격 Gateway 에 올리려면 호스트 셸이 필요하다.

**원격에서는 스파이크 러너(`spike:bridge`)를 쓰지 않는다.** 러너는 로컬 dev Gateway 에 묶여 있다 — `.env` 의 `OPENCLAW_DEV_GATEWAY_*` 가 필수이고,
관찰 WS 도 dev URL 로 붙고, C 의 설정 변경은 `openclaw --dev config` 로 **이 PC 의 `~/.openclaw-dev`** 를 바꾸고, 완료 판정은 로컬 `data/dev-gateway.log` 를 읽는다.
원격 확인은 **브리지만 띄우는 `spike:bridge-serve`**(`packages/openclaw-adapter/src/spike/bridge-serve.ts`)로 하고, 판정은 그 콘솔의 `inbound.deliver` ack 와 `outbound.message` 로만,
설정 변경(C·D)은 **호스트 CLI `openclaw config patch --file <json5>`** 로 한다.

표기: **[PC]** 개발 PC(이 저장소 루트), **[호스트]** Gateway 호스트 셸(Gateway 를 돌리는 사용자, Node 24).

### 9.1 준비 [PC]

1. `.env` 에 `BRIDGE_URL=ws://127.0.0.1:19100`(브리지가 리슨할 오리진)과 `BRIDGE_TOKEN`(예: `openssl rand -hex 32` 출력)이 있는지 본다. 형식은 `.env.example`.
2. cloudflared — 둘 중 하나.
   - 공식 설치: `brew install cloudflared` → `cloudflared --version`.
   - OpenClaw.app 번들 사본(설치 없이): 앱 안의 원본을 직접 실행하지 않고, 실행 권한을 준 사본을 쓴다.
     ```bash
     mkdir -p ~/.local/bin
     install -m 0755 /Applications/OpenClaw.app/Contents/Resources/cloudflared/arm64/cloudflared ~/.local/bin/cloudflared
     ~/.local/bin/cloudflared --version
     ```

### 9.2 빌드·패킹 [PC]

```bash
pnpm -F @dodok/openclaw-plugin run pack:plugin
tar tzf packages/openclaw-plugin/dist/dodok-openclaw-plugin-0.0.0.tgz   # package/dist/index.js, package/openclaw.plugin.json, package/package.json
```

`pack:plugin` 은 빌드(esbuild 번들) 뒤 `pnpm pack --pack-destination dist` 를 돈다. **`pnpm -F @dodok/openclaw-plugin pack` 은 쓰지 않는다** —
pnpm 내장 `pack` 이 불려 빌드 없이 워크스페이스 루트에 tgz 를 떨군다(`*.tgz` 는 ignored).

### 9.3 호스트에 설치 [PC → 호스트]

[PC]:

```bash
scp packages/openclaw-plugin/dist/dodok-openclaw-plugin-0.0.0.tgz <gateway-host>:/tmp/
```

[호스트]:

```bash
openclaw plugins install /tmp/dodok-openclaw-plugin-0.0.0.tgz --force --accept-capabilities
openclaw plugins inspect dodok --json | jq '.plugin.status, .plugin.channelIds'   # "loaded", ["dodok"]
```

- `--accept-capabilities` 가 없으면 `requires capability consent` 로 설치되지 않는다. `--force` 는 ClawHub 밖 소스 경고를 넘긴다.
- archive 설치라 `trust.reason: "provenance-invalid"` 다. 호스트에 `security.installPolicy` 가 있으면 여기서 막힐 수 있다(11.3) — 막히면 출력을 그대로 남기고 멈춘다.
- 플러그인 코드는 Gateway 가 다시 뜰 때 바뀐다. **첫 설치**는 9.5 의 계정 추가가 재시작을 부르므로 따로 재시작하지 않는다. **재설치(업데이트)** 는 설치 뒤 `openclaw gateway restart`.

### 9.4 브리지와 터널 [PC, 터미널 두 개]

터미널 1 — 브리지(저장소 루트):

```bash
pnpm -F @dodok/openclaw-adapter spike:bridge-serve
# 브리지 127.0.0.1:19100 네임스페이스 /bridge, 채널 0199a6c0-0000-7000-8000-000000000c01, 기본 에이전트 main
```

원격 첫 에이전트 id 가 `main` 이 아니면 `DODOK_SPIKE_AGENT=<id>` 를, 다른 채널로 보내려면 `DODOK_SPIKE_CHANNEL_ID=<uuid>` 를 앞에 붙인다.
이 명령은 Gateway·모델에 스스로 아무것도 보내지 않는다 — 콘솔에 입력한 줄만 인바운드로 나간다(9.6).
관찰은 콘솔 출력뿐이라 기록을 남기려면 처음부터 `pnpm -F @dodok/openclaw-adapter spike:bridge-serve 2>&1 | tee data/spike-2-remote.log` 로 띄운다(`data/` 는 ignored, 토큰은 찍지 않는다).

터미널 2 — 터널:

```bash
cloudflared tunnel --url http://127.0.0.1:19100     # 번들 사본이면 ~/.local/bin/cloudflared
# 출력의 https://<random>.trycloudflare.com 을 적어 둔다
```

Socket.IO 는 HTTP 경로 `/socket.io/` 로 붙고 `/bridge` 는 네임스페이스라 터널은 오리진 전체를 넘기면 된다.
quick tunnel 주소는 cloudflared 를 다시 띄울 때마다 바뀐다 — 그때는 9.5 를 다시 한다. 브리지(터미널 1)만 다시 띄우는 것은 플러그인이 백오프로 다시 붙으므로 괜찮다.

### 9.5 계정 설정 [호스트]

토큰은 파일로 넘기고 셸 기록에 남기지 않는다.

```bash
install -m 600 /dev/null /tmp/dodok.patch.json5 && ${EDITOR:-vi} /tmp/dodok.patch.json5
```

```json5
{ channels: { dodok: { accounts: { default: { bridgeUrl: "wss://<random>.trycloudflare.com/bridge", token: "<BRIDGE_TOKEN>" } } } } }
```

```bash
openclaw config patch --file /tmp/dodok.patch.json5 && rm /tmp/dodok.patch.json5
```

`channels.dodok` 계정 변경은 Gateway 재시작을 요구한다 — dev 실측에서는 in-process restart 가 자동으로 돌았다(3.4). 자동 재시작이 안 보이면 `openclaw gateway restart`.
원격에 계획서 설정 조각을 적용할 때는 `tools.sessions.visibility`(10절)로 쓴다.

### 9.6 확인과 시나리오 [PC 브리지 콘솔, 설정은 호스트]

1. **연결**: 터미널 1 에 `플러그인 hello: {"pluginId":"dodok",…,"gatewayVersion":"2026.9.4",…}` 가 찍힌다. 안 찍히면 [호스트] Gateway 로그의 `dodok bridge:` 줄(재연결 지연·hello 실패 원인)을 본다.
   hello 전에 입력한 줄은 `ADAPTER_UNAVAILABLE` 로 끝난다.
2. **시나리오**: 터미널 1 에 한 줄씩 입력한다. **한 줄 = 인바운드 1건 = 원격 모델 런 1회**(루프 보호로 막히면 런 없음). 입력 문법은
   `@<agentId> 본문`(사람 `operator` 작성), `<handle>> @<agentId> 본문`(에이전트 `<handle>` 작성 — 봇 루프 보호 사실이 붙는다).
   판정은 콘솔의 `→ inbound.deliver … ack`(`providerRunId` 있음 = 런 시작, `{}` = 런 없이 끝남)와 `← outbound.message` 로만 한다.

   | 시나리오 | 설정 [호스트] | 입력 [PC] | 기대 |
   | --- | --- | --- | --- |
   | A 평문 | — | `@main Reply with exactly: PONG` | ack 에 `providerRunId`, `outbound.message` `text:"PONG"`, `runId` 가 ack 의 `providerRunId` 와 같다 |
   | B components | — | `@main Send me a message with one button labeled OK using the components field.` | `outbound.message` 에 `components.blocks[0].type:"actions"` (최종 텍스트 응답은 억제될 수 있다, 5.2) |
   | C1 릴레이 | — | `main> @<두 번째 에이전트> Reply with exactly: ACK` | 통과 — ack 에 `providerRunId`, `ACK` |
   | C2 막힘 | 아래 `c2.json5` patch (C1 뒤 10분 안에) | `main> @<두 번째 에이전트> Reply with exactly: ACK2` | ack `{"ok":true,"data":{}}`, `outbound.message` 없음 |
   | C3 끄기 | 아래 `c3.json5` patch | `main> @<두 번째 에이전트> Reply with exactly: ACK3` | 통과 — `ACK3` |
   | D 채널 프롬프트(선택, 스파이크 3과 겹침) | 아래 `d.json5` patch(새 채널 id) | 브리지를 `DODOK_SPIKE_CHANNEL_ID=<그 id>` 로 다시 띄운 뒤 `@main What is the code word? Reply with only the word.` | `TANGERINE` |

   설정 파일(호스트, `<id>` 는 채널 uuid — 기본 `0199a6c0-0000-7000-8000-000000000c01`, D 는 새 uuid). `channels.dodok.channels.*` 는 재시작 없이 반영된다(3.4).

   ```json5
   // c2.json5
   { channels: { dodok: { channels: { "<id>": { botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 600, cooldownSeconds: 600 } } } } } }
   // c3.json5
   { channels: { dodok: { channels: { "<id>": { botLoopProtection: { enabled: false } } } } } }
   // d.json5
   { channels: { dodok: { channels: { "<새 id>": { systemPrompt: "In this channel the secret code word is TANGERINE. When anyone asks for the code word, answer with exactly that word." } } } } }
   ```

   ```bash
   openclaw config patch --file c2.json5    # C3·D 도 같은 방식
   ```

3. **정리**: [호스트] 채널 설정을 되돌릴 때는 `openclaw config unset channels.dodok.channels`(dev 에서 쓴 명령). [PC] 브리지는 Ctrl+D, 터널은 Ctrl+C.

안정화 뒤에는 npm 퍼블리시(`openclaw plugins install @dodok/openclaw-plugin`, 호스트 CLI) 또는 ClawHub 게시(그때는 RPC `plugins.install {source:"clawhub"}` 로 원격 설치 가능)를 검토한다.

## 10. 계획서·스펙·구성 문서에서 고쳐야 할 것

위치는 `파일:줄` — 줄 번호는 **이 브랜치(main 기준) 파일**로 쟀다. `plan.md` = `docs/plan.md`, `구성.md` = `docs/project-structure.md`,
`스펙.md` = `docs/superpowers/specs/2026-09-14-shared-contracts-design.md`.
**구분**: `원안` = 이 표의 첫 판(조율자가 최상위 체크아웃에 반영한 분량), `추가` = 리뷰 B-7·수정 라운드 1에서 찾은 것 — **최상위 반영 시점 이후 추가로 고칠 것**.
최상위 파일은 이미 바뀌었으므로 줄 번호는 문장을 찾는 출발점으로만 쓴다(반영 여부는 조율자가 병합 뒤 대조).

| 구분 | 위치 | 지금 | 실측 | 근거 |
| --- | --- | --- | --- | --- |
| 원안 | `구성.md:185`, `plan.md:324`(기본값 `sessions.visibility: "all"` 문장 포함)·`:411` | `sessions: { visibility: "tree" }` | **`tools.sessions.visibility`**. 루트 `sessions` 는 `Unrecognized key: "sessions"` 로 거부 | 설정 스키마(`config schema`) |
| 원안 | `plan.md:107`, `구성.md:129` | 호스트에서 `plugins install <tarball \| git URL>` | 가능하나 `--force --accept-capabilities` 필요, tarball 은 `pnpm -F @dodok/openclaw-plugin run pack:plugin`(`openclaw plugins pack` 은 채널 플러그인 거부). RPC 원격 설치는 clawhub/official 만 | 3.3·9 |
| 원안 | `구성.md:118` | `index.ts`: `definePluginEntry({ register(api) { api.registerChannel(...) } })` | 동작하는 형태지만 권장은 `defineChannelPluginEntry({ plugin, setRuntime })`. 매니페스트에 `channels`·`channelConfigs`, 패키지에 `openclaw.channel`, **런타임 dependencies 없음(번들)** | 3.1·3.2 |
| 원안 | `구성.md:120` | `channel.ts`: 「채널별 설정 스키마(… 봇 루프 보호 조정)」 | 봇 루프 보호는 설정만으로 동작하지 않는다 — 플러그인이 인바운드에서 `botLoopProtection` 사실을 넘겨야 한다 | 7.1 |
| 원안 | `plan.md:104` | 인바운드 스코프 `accountId, currentChannelId, …` 를 「코어가 넘겨준다」 | 그 목록은 **message 툴 디스커버리·실행 컨텍스트** 쪽이다. 인바운드는 플러그인이 `buildContext`·`dispatch` 에 `route`·`reply`·`sender` 를 **넘기는** 쪽 | 4.1·5.2 |
| 원안 | `plan.md:244` | 봇 루프 보호: 「Gateway 가 자체 차단할 수 있다」 | 플러그인이 사실을 넘길 때만. 기본 예산 20/60초/쿨다운 60초, drop 사유 `bot-loop-protection`, `enabled:false` 로 즉시 해제 | 7 |
| 원안 | `plan.md:103` | 「우리 채널만의 UI 스키마를 message 툴에 끼워 넣을 수 있다」 | 기술적으로 된다(실측). 단 SDK 방침은 provider-native 스키마를 막고 `presentation` 을 권한다 — 리스크로 명시 | 6 |
| 원안 | `plan.md:236` | (a-1) 플러그인이 `channel-config-writes`/`config-mutation` 으로 갱신 | 쓰기는 `runtime.config.mutateConfigFile`(`openclaw/plugin-sdk/config-mutation` 도 같은 이름을 export). `channel-config-writes` 는 **쓰기 권한 판정**(`authorizeConfigWrite`·`resolveChannelConfigWrites`)이지 쓰기가 아니다. 반영은 live 이나 claude-cli 기존 세션에 안 들어감 | 8 |
| 원안 | `구성.md:20` | `infra/caddy`: `/bridge` 를 TLS 로 노출 | 브리지는 Socket.IO **네임스페이스** `/bridge` — HTTP 경로는 `/socket.io/`. `wss://host/bridge` 는 클라이언트 URL(오리진+네임스페이스)로 맞고, 프록시 라우트는 `/socket.io` 하나로 충분 | 브리지 구현 |
| 원안 | `plan.md:291·459` | WS 델타를 미리보기로 중계 | message 툴로 답한 런은 `terminalReply.disposition:"silent"` 인데 `chat` delta `"N"` 이 먼저 나간다 — `final`/lifecycle 로 silent 가 확정되면 미리보기 버블을 지워야 한다 | 5.2 |
| 원안 | `스펙.md:248`(`Run.providerRunId`)·`:755`·`:769` | Gateway 런 id 를 따로 싣는다 | `replyOptions.runId` 로 `providerRunId === runId`. 필드는 남겨도 되지만 의미가 「같다」로 바뀐다 | 4.3 |
| 원안 | `CLAUDE.md:21` | 「OpenClaw 패키지 3종 정확 핀」 | 규칙은 그대로. 이번에 `openclaw` 2026.9.4 devDependency 핀 완료(`packages/openclaw-plugin/package.json:21`) | — |
| 추가 | `plan.md:102` | 3.2 진입점 `definePluginEntry({ id, register(api) { api.registerChannel({...}) } })` | `구성.md:118` 행과 같다 — `defineChannelPluginEntry` | 3.1 |
| 추가 | `plan.md:105`·`:460`(위험표) | 봇 루프 보호 「Phase 0 에서 확인한다」·「Phase 0 에서 기본값 확인, 채널 설정으로 조정」 | 확인 끝 — 기본값은 릴레이를 막지 않는다(20/60초). 조정은 채널 설정 **과** 플러그인의 사실 전달 여부. 결정은 12.3 | 7 |
| 추가 | `plan.md:413`, `구성.md:202` | 스파이크 2 = 원격 호스트에 tarball 설치 + 터널로 브리지 접속 | 실제는 **로컬 dev Gateway** 에서 쟀다. 원격은 9절 절차(사람)로 넘겼다 | 2·9 |
| 추가 | `CLAUDE.md:42` | 「다음: 스파이크 2(채널 플러그인, 원격 Gateway 설치 + 터널)」 | 스파이크 2 완료(ADR 0002, 로컬 dev) — 현재 단계 갱신 | — |
| 추가 | `구성.md:69·108`, `plan.md:207·482` | 「Fastify 앱에 브리지 WSS 라우트 `/bridge` 마운트」·「Caddy 가 `/bridge` 노출」 | `구성.md:20` 행과 같다 — `attachBridge(io)` 가 Socket.IO 네임스페이스를 붙인다. 별도 HTTP 라우트 없음 | 브리지 구현 |
| 추가 | `구성.md:123`, `plan.md:106` | `config-writer.ts` 가 「SDK(config-mutation / channel-config-writes)로」 반영·「플러그인 내부에서 Gateway 설정 갱신」 | `plan.md:236` 행과 같다 — `mutateConfigFile` 로 쓰고, `channel-config-writes` 는 권한 판정 | 8 |
| 추가 | `구성.md:199` | 핀 「plugin 은 스파이크 2에서」 | 완료(`openclaw` 2026.9.4 devDependency) | 3.2 |
| 추가 | `구성.md:122·159·160·174`, `plan.md:209`, `스펙.md:717` | 플러그인 접속 주소 `BRIDGE_PUBLIC_URL=wss://…/bridge`, `bridge-client.ts` 가 `BRIDGE_URL` 로 접속 | 플러그인은 env 가 아니라 **계정 설정 `channels.dodok.accounts.<id>.bridgeUrl`**(오리진+`/bridge`)로 접속한다. 이번 `.env.example` 의 `BRIDGE_URL` 은 **브리지가 리슨할 오리진**(스파이크 전용, `/bridge` 없음)이라 이름만 비슷하고 뜻이 다르다 — Phase 1 서버에서 `BRIDGE_PUBLIC_URL`(공개 주소, 설정 마법사 표시) 하나로 정리할지 정할 것 | 3.2·9 |
| 추가 | `스펙.md:717` | 접속 `auth: { token, protocol, pluginVersion }`, 접속 뒤 10초 안에 `hello` 가 없으면 끊는다 | 구현은 `auth: { token }` 만 — 버전·프로토콜은 `hello`/`BridgeHelloResult` 로 오간다. **hello 10초 타임아웃은 구현하지 않았다**(Phase 1 서버 과제) | 브리지 구현 |
| 추가 | `스펙.md:943·944·948` (11절 확정 항목 1·2·6) | 「스파이크 2 에서 확정」 | 1·2: `replyOptions.runId` 로 인바운드 runId 가 Gateway runId·아웃바운드 runId 가 된다(4.3). 6: 기본값은 막지 않고 사실 전달 시에만 동작(7) — 표를 확정값으로 갱신 | 4.3·7 |
| 추가 | `plan.md:474`(10장 결정 #2) | `sessions.visibility: "tree"` | `tools.sessions.visibility` — 첫 행과 같다 | 설정 스키마 |
| 추가 | `plan.md:91` | `chat.history` `deltaCursor` 증분 「스파이크 2에 얹는다」 | 스파이크 2 에서 재지 않았다 — **스파이크 3 으로 이월**(조율자 판정, 11.9) | — |

## 11. 남은 질문

1. **모델 런에서 툴 검증 실패 원문이 모델에게 보이는가.** `tools.invoke` 는 `tool execution failed` 로 뭉갰다 — 코어는 `err.name === "ToolInputError"` 일 때만 400 + 원문을 돌려준다.
   수정 라운드 1에서 `handleAction` 의 인자 검증 실패(components·target·본문)를 **`name = "ToolInputError"` 로 던지게 했다**(`outbound.ts` `toolInputError`, 단위 테스트는 이름만 확인).
   `tools.invoke` T2 재현과 모델 경로(claude-cli → MCP 루프백) 노출은 **스파이크 3에서 잰다**.
2. **claude-cli 기존 세션의 시스템 프롬프트 갱신**: `sessions.reset`(operator.admin 필요) 뒤, Gateway 재시작 뒤, 다른 백엔드(API 프로바이더)에서 각각 반영되는가 — 스파이크 3의 첫 과제.
3. 원격(Gateway 호스트 → 터널 → 개발 PC 브리지)에서 같은 결과인가 — 9절 절차로 사람이 확인. 특히 `trust.reason: provenance-invalid` 인 archive 설치가 원격 `security.installPolicy` 에서 막히는지.
4. `message` 툴을 **다른 dodok 채널**(`target` 이 현재 채널이 아님)로 보낼 때 코어가 `resolveOutboundSessionRoute` 를 거쳐 어떤 세션에 기록하는가, `outbound.sendText` 폴백이 언제 불리는가(스파이크 중 0회).
5. 인바운드 컨텍스트 헤더(참여자·릴레이 규칙·최근 대화)를 본문 프리픽스 대신 `ChannelPromptContext`/`SupplementalContext` 로 넣으면 모델 행동·전사가 어떻게 달라지는가.
6. 번들 1.0MB(zod 전체) — `zod/mini` 나 공유 스키마 분리로 줄일 가치가 있는가. Gateway 의 플러그인 로드 시간 영향은 미측정.
7. `inbound.deliver` 를 같은 세션에 연속으로 넣을 때(`queueMode`) ack 시점·순서 — 이번엔 직렬 시나리오만 돌렸다.
8. 플러그인 연결이 끊긴 동안 도착한 최종 응답(큐 적재 → 재연결 flush)의 실제 동작 — 실제 Gateway 단절로는 재지 않았다.
   수정 라운드 1에서 두 결함을 고치고 테스트로만 확인했다: flush 중 ack 타임아웃이면 플러그인이 끊고 재연결 뒤 같은 head 부터 다시 보낸다(가짜 소켓 테스트),
   브리지 서버는 `outboundId` 를 연결이 아니라 `attachBridge` 단위 LRU(최근 1,000개)로 기억하고 처리 중인 id 의 재전송은 그 결과에 합류한다(소켓 통합 테스트).
9. **`chat.history` `deltaCursor` 증분**(계획서 `plan.md:91` 이 스파이크 2에 얹었던 것)은 이번에 재지 않았다 — **스파이크 3으로 이월**(조율자 판정).
10. **`~/.openclaw-dev` 에 스파이크 흔적이 남아 있다** — `channels.dodok.channels.<c01|c02>.systemPrompt`(TANGERINE 문구)와 계정 `default` 의 브리지 토큰. 스파이크 3이 이어 쓰므로 지우지 않았고, **스파이크 3 브리프에 명시한다**(조율자 판정).

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
