# ADR 0001 — Gateway 클라이언트 스파이크 (Phase 0 / 스파이크 1)

- 상태: 완료 (실측)
- 날짜: 2026-09-15
- 대상: `docs/plan.md` 3.1절 「Gateway 클라이언트 (WS API)」, 8장 Phase 0 스파이크 1
- 산출 코드: `packages/openclaw-adapter/src/gateway/{client.ts,device-identity.ts}`, `src/spike/gateway-spike.ts`
- 원본 관찰: `data/spike-1-observations.json` (커밋하지 않음 — `data/` 는 ignored)

## 1. 배경과 확인할 가정

계획서 3.1절은 `@openclaw/gateway-client` 2026.9.4 의 `protocol.schema.json`·README·공식 문서를 읽고 쓴 것이다.
**문서를 읽어 세운 가정이므로 실제 배포 Gateway 에서 그대로인지는 확인된 바 없었다.** 이 스파이크가 확인한 가정은 다음과 같다.

1. 프로토콜 v4 로 `minProtocol: 4, maxProtocol: 4` 고정 협상이 된다.
2. Ed25519 디바이스 아이덴티티로 `connect` → 호스트에서 `openclaw devices approve <requestId>` → 디바이스 토큰 발급, 이라는 페어링 흐름.
3. `hello-ok.features`(`methods`/`events`/`capabilities`)가 **그 Gateway 가 실제로 지원하는 것의 진실**이다.
4. 클라이언트 capability `tool-events`·`approvals`·`session-scoped-events` 를 선언하면 `hello-ok.features.capabilities` 로 확정할 수 있다.
5. `chat.send` 응답은 `messageSeq`, `status: "started"`, `runStarted` 계열.
6. `chat` 이벤트 `final` 은 `message`·`usage`·`stopReason` 을 담는다.
7. 툴 실행 진행 상황은 `session.tool` 과 `agent` 이벤트에 의존한다.
8. `sessions.subscribe` 는 로스터 스냅샷 + `sessions.changed` 구독을 준다.

결론부터 적으면 **1·2 는 대체로 맞고, 3·4·5·6·7·8 은 실물과 다르다.** 아래 5~7절이 값과 함께 그 차이를 적는다.

## 2. 환경

| 항목 | 값 |
| --- | --- |
| Gateway | `wss://openclaw.develma.com` (원격, 사용자 본인 서버) |
| `hello-ok.server.version` | `2026.9.4` |
| `hello-ok.server.buildId` | `2026.9.4-release-3a9d69db306c-2026-09-10T22-53-16.719Z` |
| `hello-ok.server.controlUiBuildSource` | `bundled` |
| 협상된 `hello-ok.protocol` | `4` (요청 `minProtocol: 4, maxProtocol: 4`) |
| 클라이언트 | `@openclaw/gateway-client` `2026.9.4`, `@openclaw/gateway-protocol` `2026.9.4` (정확 핀) |
| Node / pnpm | 22.23.1 / 11.16.0 |
| 에이전트 | **6개** — `hello-ok.snapshot.health.agents` 기준 (2.1) |
| 기본 에이전트 | `snapshot.sessionDefaults.defaultAgentId = "main"` |
| 모델 | `provider: "claude-cli"`, `model: "claude-opus-5"` (관찰된 값) |
| 측정일 | 2026-09-15 (UTC 2026-09-14T15:27~15:29) |

계획서는 「Gateway 2026.9.2, 클라이언트 2026.9.4 로 어긋난 채 붙는지가 관찰 대상」이라고 적었으나,
**측정 시점의 Gateway 는 이미 2026.9.4 였다.** 따라서 버전 불일치 관찰은 하지 못했다 — 8절 남은 질문으로 넘긴다.

`pnpm 11` 의 `minimumReleaseAge` 는 두 패키지 설치를 막지 않았다(2026-09-11 게시, 4일 경과). `pnpm-workspace.yaml` 변경 없음.

### 2.1 에이전트 6개 — 멘션 릴레이 설계의 전제

`openclaw agents list` 는 `main (default)` 하나만 보여 주지만(원인은 미확인 — CLI 번들의 `buildAgentSummaries` 는 `cfg.agents.entries` 를 그대로 싣고 바인딩은 개수 열에만 쓰므로, `agents.entries` 가 비어 있었을 가능성이 크다. 8절 9번),
**`hello-ok.snapshot.health.agents` 는 6개를 싣는다.**

| `agentId` | `name` | `sessions.count` | `sessions.recent` | `heartbeat.enabled` |
| --- | --- | --- | --- | --- |
| `main` | (없음) | 14 | 5 | `true` (30분) |
| `fin` | 핀 | 14 | 5 | `false` |
| `moby` | 모비 | 7 | 5 | `false` |
| `booky` | 부기 | 4 | 4 | `false` |
| `mini` | 미니 | 3 | 3 | `false` |
| `mail_reader` | (없음) | 1 | 1 | `false` |

- **`isDefault` 는 6개 전부 `false` 다.** 기본 에이전트는 이 필드가 아니라 `snapshot.sessionDefaults.defaultAgentId`(= `"main"`)로 정해진다.
  에이전트 목록에서 기본을 고를 때 `isDefault` 를 믿으면 안 된다.
- `name` 은 있는 것과 없는 것이 섞인다(`main`·`mail_reader` 는 없음) → UI 표시명은 `name ?? agentId` 로 폴백해야 한다.
- 계획서 8장 Phase 0 「준비」는 「에이전트 2개 구성」을 전제했는데 **실제 배포에는 이미 6개**가 있다.
  에이전트 등록 UI(Phase 1)와 멘션 릴레이는 「2개」가 아니라 **임의 개수**를 전제로 설계해야 하고,
  채널에 어떤 에이전트를 붙일지 사용자가 고르는 화면이 MVP 에 필요하다.
- `agentId` 에 `_`(`mail_reader`)가 들어간다 → 세션 키 규약 `agent:<agentId>:dodok:channel:<channelId>` 의
  파서는 `:` 로만 쪼개야 하고 `agentId` 에 영숫자 외 문자가 온다고 가정해야 한다.

## 3. 페어링 실측 — **사람 승인이 필요 없었다**

계획서는 「`connect` → 호스트에서 `openclaw devices approve <requestId>` → 토큰 발급」을 전제했다. 실측은 다르다.

> **근거의 출처 — 이 절만 저장된 산출물로 재현되지 않는다.**
> 3.1·3.2 의 값은 **일회용 진단 프로브의 콘솔 출력**에서 왔고 그 stdout 은 저장되지 않았다.
> `data/spike-1-observations.json` 에는 `connectAttempts: []`, `pairing: null` 만 남아 있다 —
> 스파이크 본 실행이 **두 번째 실행**이었고 그때는 이미 페어링이 끝나 첫 접속부터 성공했기 때문이다.
> 3.2 표의 「20초」 한 줄은 스파이크 본 실행의 **첫 번째 실행**(`PAIRING_POLL_INTERVAL_MS = 20_000`)에서 나왔고,
> 「2초」·「15초」 두 줄은 임시 디렉터리에 새 아이덴티티를 만드는 프로브에서 나왔다. 총 3회다.
> 다시 재려면 새 디바이스 아이덴티티가 필요하고, 그러면 3.0 의 부작용이 또 생긴다.

### 3.0 이 스파이크가 사용자 Gateway 에 남긴 것

「Gateway 설정·에이전트·디바이스 목록을 바꾸지 않는다」가 브리프의 제약이었다. 설정과 에이전트는 건드리지 않았으나
**페어링을 재려면 디바이스 아이덴티티를 만들 수밖에 없고, 승인된 아이덴티티는 Gateway 의 paired-devices 에 남는다.**
실제로 남은 것은 다음과 같다.

| 남은 것 | 식별자 | 개인키 위치 | 상태 |
| --- | --- | --- | --- |
| 디바이스 1 (스파이크 본체) | `deviceId c1a55c00089b…`, `dodok-spike` | 워크트리 `data/openclaw-device.json` (0600) | 재사용 가능 |
| 디바이스 2 (프로브) | `deviceId bd20c8b1775f…`, `dodok-spike-probe` | `$TMPDIR/dodok-pairprobe-qTahPO/device.json` | **회수 불가** |
| 디바이스 3 (프로브) | `deviceId 8d5b9f0277b0…`, `dodok-spike-probe` | `$TMPDIR/dodok-pairprobe-XbCtZ4/device.json` | **회수 불가** |
| 세션 1개 | `agent:main:dodok:spike:20260915-0029` | — | 메시지 4개, 모델 런 2회, 관찰된 `usage.cost.total = 0` |

- 디바이스 2·3 은 임시 디렉터리에만 개인키가 있어 다시 붙을 수 없다 — 사용자 Gateway 목록에 **죽은 항목 2개**로 남는다.
- 이 머신에는 `operator.pairing` 스코프가 없어(`devices.list` 도 `FORBIDDEN`) 목록 확인·정리를 여기서 할 수 없다.
  정리하려면 Gateway 호스트에서 `openclaw devices list` 로 `dodok-spike-probe` 두 개를 찾아 제거해야 한다.
- **다음에 페어링을 잴 때는 영구 아이덴티티 하나를 재사용한다.** 프로브가 매번 새로 만든 것이 항목을 늘린 원인이다.

### 3.1 거절의 모양

새 디바이스 아이덴티티로 처음 붙으면 `connect` 요청이 거절된다. `GatewayClientRequestError` 의 값:

```
error.code        = "NOT_PAIRED"
error.gatewayCode = "NOT_PAIRED"
error.retryable   = false
error.message     = "device pairing required (requestId: e3fbfe98-1666-4506-b6e7-5d7f04783c47)"
error.details     = {
  code: "PAIRING_REQUIRED",
  reason: "not-paired",
  requestId: "e3fbfe98-1666-4506-b6e7-5d7f04783c47",
  remediationHint: "Approve this device from the pending pairing requests.",
  deviceId: "<64자 hex>",
  requestedRole: "operator",
  requestedScopes: ["operator.read", "operator.write", "operator.approvals"]
}
```

`requestId` 는 **`details.requestId` 에서 직접** 얻는다(메시지 파싱 불필요).
`@openclaw/gateway-protocol/connect-error-details` 의 `readPairingConnectErrorDetails(details)` 가 정규화해 준다 —
우리 래퍼는 이걸 `GatewayPairingRequiredError` 로 감싼다. 이벤트로는 오지 않는다(`device.pair.requested` 는 `features.events` 에 있지만
거절된 연결에는 이벤트가 오지 않으므로 **오류 응답이 유일한 통로**다).

### 3.2 재시도하면 사람 없이 통과한다

`gateway.remote.token`(공유 토큰)을 함께 보낸 경우, 페어링 요청은 **등록 후 수 초 안에 자동 승인**된다. 세 번 재현했다.

| 재시도 간격 | 결과 |
| --- | --- |
| 20초 | 1회차 `NOT_PAIRED` → 2회차(20초 뒤) 성공 |
| 2초 | 1회차·2회차(2초) `NOT_PAIRED` → 3회차(4초) 성공 |
| 15초 | 1회차 `NOT_PAIRED` → 2회차(15초) 성공 |

2초에는 아직 안 되고 4초에는 되므로 **시도 횟수가 아니라 경과 시간**이 조건이다(자동 승인이 비동기로 끝난다).
세 번 모두 사람은 아무 것도 하지 않았고, `openclaw devices approve` 도 실행하지 않았다.

### 3.3 승인 뒤 돌아오는 것

성공한 `hello-ok.auth`:

```json
{
  "method": "token",
  "role": "operator",
  "scopes": ["operator.read", "operator.write", "operator.approvals"],
  "deviceToken": "<masked:43>",
  "issuedAtMs": 1789399629480,
  "recoveryScope": "<masked:43>",
  "recoveryMigrationAllowed": true
}
```

- **`auth.deviceTokens`(복수 배열)는 오지 않는다.** 계획서가 「2026.9.x 는 복수 `deviceTokens`」라고 적은 것은 스키마에 그 필드가
  *존재한다*는 사실이었고, 이 Gateway 는 **단수 `auth.deviceToken` 만** 보낸다. 호스트 저장 코드는 단수를 정본으로 짜야 한다.
- `auth.method` 가 `"token"` 이다 — 디바이스 토큰이 발급됐어도 **이번 연결의 인증 수단은 공유 토큰**이다.
- 요청한 세 스코프(`operator.approvals` 포함)가 그대로 승인됐다. `operator.approvals` 는 스키마가 받는다.
- 발급된 `deviceToken` 은 `hostDeps.storeDeviceAuthToken` 으로 호스트에 넘어온다 — 우리 구현은 `data/openclaw-device-tokens.json`
  (0600)에 `{"<deviceId>:<role>": {token, scopes}}` 로 저장한다.

### 3.4 그래서 달라지는 것

설정 마법사(Phase 3)에 「페어링 승인을 사람이 해야 한다」를 **필수 단계로 넣지 않는다.** 공유 토큰이 있으면 자동 승인되고,
없거나 정책이 바뀐 배포에서는 `PAIRING_REQUIRED` 가 오므로 **그때만** `details.requestId` 를 화면에 띄우고 승인을 안내한다.
어댑터는 첫 연결 실패를 정상 경로로 취급해 **짧은 간격(2~5초)으로 몇 번 재시도**해야 한다 —
`retryable: false` 라고 해서 포기하면 자동 승인을 놓친다.

## 4. `hello-ok` 구조

### 4.1 최상위

`type`, `protocol`, `server`, `features`, `snapshot`, `auth`, `policy`.

### 4.2 `policy` (실측값)

```json
{
  "maxPayload": 26214400,
  "maxBufferedBytes": 52428800,
  "tickIntervalMs": 30000,
  "attachments": { "maxBytes": 19464192, "maxImageBytes": 6291456 },
  "allowedSessionVisibilities": ["shared", "read-only", "suggest", "draft"],
  "hasMultipleSessionSharingIdentities": false
}
```

Phase 2 의 이미지 첨부 상한은 여기서 읽는다: **이미지 6 MiB, 첨부 전체 18.56 MiB, 프레임 25 MiB.**

### 4.3 `snapshot` 최상위 키

`suspension`, `presence`, `health`, `stateVersion`, `uptimeMs`, `appliedConfigHash`, `sessionDefaults`, `updateSchedule`.

스키마가 허용하는 `configPath`·`stateDir`·`controlUiIdentityUrl`·`authMode`·`updateAvailable` 는 **오지 않았다**(원격 연결이라 경로류를 감춘 것으로 보인다).

**`snapshot` 에 부분 세션 로스터가 있다.** `snapshot.health.agents[].sessions` 가 에이전트마다
`{ path, count, recent }` 를 싣고, `recent` 는 `{ key, updatedAt, age }` 최대 5개다
(`main` 은 `count: 14` + `recent` 5개: `agent:main:main`, `agent:main:dashboard:<uuid>` 2개,
`agent:main:mattermost:group:<id>`, `agent:main:cron:<uuid>`). `snapshot.health.sessions` 에도 `main` 것이 한 번 더 온다.

- 전체 로스터는 아니다(에이전트당 5개 상한) → **첫 화면을 `hello-ok` 만으로 그릴 수는 없고** `sessions.list` 가 여전히 필요하다(6.4).
  다만 재접속 직후 「최근 세션」 정도는 추가 왕복 없이 그릴 수 있다.
- **이 스냅샷을 그대로 웹으로 흘리면 안 된다.** `sessions.path` 는 호스트 절대경로
  (`/Users/<user>/.openclaw/agents/*/agent/openclaw-agent.sqlite`)이고, `snapshot.presence`(9개 항목)는
  `host`·`ip`(LAN 주소)·`platform`·`modelIdentifier` 를 싣는다. 어댑터가 `hello-ok` 를 UI 로 중계할 때는
  **필요한 필드만 뽑아 올리는 화이트리스트**를 둔다.

### 4.4 `features.methods` — 443개

**계획서의 가정 3은 틀렸다.** `features.methods` 는 「그 Gateway 가 지원하는 것의 진실」이 아니라 **광고 목록**이다.
`protocol.schema.json` 의 메서드 레지스트리(445개)와 양쪽으로 어긋난다.

- **스키마에 있는데 `features` 에 없는 25개**:
  `sessions.get`, `sessions.resolve`, `sessions.usage`, `sessions.usage.timeseries`, `sessions.usage.logs`, `sessions.steer`,
  `chat.inject`, `assistant.media.get`, `poll`, `push.test`, `push.web.vapidPublicKey`, `push.web.subscribe`,
  `push.web.unsubscribe`, `push.web.test`, `config.openFile`, `connect`, `nativeHook.invoke`, `web.login.start`, `web.login.wait`,
  `device.pair.setupCode`, `device.pair.setupStatus`, `node.runnerInventory.update`, `worker.desktop.observe`,
  `worker.desktop.launch`, `desktop.launch`.
- **`features` 에만 있는 23개**(플러그인이 등록한 것): `browser.request`, `memory.sessionBackfill.{preview,apply,rollback}`, `wiki.*` 19개.

그리고 **`features` 에 없는 메서드도 실제로는 호출된다.** 직접 불러 확인했다.

| 호출 | 결과 |
| --- | --- |
| `push.web.vapidPublicKey` (features 에 없음) | **성공** — `{ vapidPublicKey }` |
| `sessions.get` (features 에 없음) | **성공** — `{ messages }` |
| `dodok.no.such.method` (스키마·features 어디에도 없음) | `FORBIDDEN`, `details = { code: "MISSING_SCOPE", missingScope: "operator.admin", requiredScopes: ["operator.admin"] }` |
| `devices.list` (스키마·features 어디에도 없음) | 위와 **글자 그대로 같은 오류** — 즉 존재하지 않는 메서드는 「`operator.admin` 스코프 부족」으로 응답된다. **없는 메서드와 권한 부족이 구분되지 않는다** |

**그래서 달라지는 것**: 계획서 3.1절의 「`features` 로 프로토콜 매핑 표를 확정한다」는 **확정이 아니라 참고**로 낮춘다.
어댑터는 (a) 필요한 메서드를 `features.methods` 로 미리 거르지 말고 그냥 호출하고,
(b) `FORBIDDEN`+`MISSING_SCOPE` 를 「없거나 권한 없음」 한 덩어리로 처리해 기능을 비활성화하되 연결은 유지해야 한다.

### 4.5 `features.events` — 60개 (전체)

```
connect.challenge, agent, chat, chat.metadata.changed, ui.command, session.approval, session.message,
session.observer, session.operation, session.sharing, session.sharing.evidence, session.suggestion,
session.typing, session.tool, sessions.changed, controlUi.sessionPullRequests.changed,
plugins.controlUi.changed, presence, tick, talk.mode, talk.event, shutdown, gateway.suspension, health,
heartbeat, cron, task, task.suggestion, node.pair.requested, node.pair.resolved, node.presence,
node.hostStats, node.runnerInventory.changed, node.invoke.cancel, node.invoke.input, node.invoke.request,
device.pair.changed, device.pair.requested, device.pair.resolved, device.pair.setup.completed,
device.pair.setup.deliveryUncertain, users.prefs.changed, skills.changed, voicewake.changed,
voicewake.routing.changed, exec.approval.requested, exec.approval.resolved, question.requested,
question.resolved, plugin.approval.requested, plugin.approval.resolved, openclaw.approval.requested,
openclaw.approval.resolved, terminal.data, terminal.exit, update.available, update.run.changed,
portal.changed, progressCard.changed, mentions.changed
```

계획서가 이름을 댄 이벤트는 **전부 이 목록에 있다**(`chat`, `agent`, `session.message`, `session.operation`, `session.tool`,
`session.approval`, `session.observer`, `presence`, `tick`, `health`, `heartbeat`, `shutdown`).
계획서가 몰랐던 것 중 우리에게 중요한 것: **`mentions.changed`**(멘션 릴레이), `chat.metadata.changed`, `session.typing`,
`session.sharing`, `progressCard.changed`.

### 4.6 `features.capabilities` — 17개, **우리가 선언한 caps 가 아니다**

```
board-widget-put-canvas-doc, chat-send-routing-contract, gateway-restart-target-safe-v1,
node-worker-bundle-retention-v1, node-worker-bundle-status-v1, node-worker-environment-session-v1,
node-worker-portal-stream-v1, published-model-catalog, progress-card-agent-scope-v1,
session-scoped-chat-metadata, session-unread-ack-contract, session-goal-start-v1,
session-settings-contract, session-settings-cas-v1, openclaw-chat-wizard-cancel,
openclaw-setup-model-ref, taskSuggestions.acceptModes
```

`connect.caps` 로 `tool-events`·`approvals`·`session-scoped-events` 를 선언했지만 **이 목록에는 하나도 없다.**
`features.capabilities` 는 **서버가 가진 기능 플래그**이고, 클라이언트 caps 와는 다른 축이다.

**계획서의 가정 4 는 틀렸다.** 클라이언트 caps 의 정본은 `@openclaw/gateway-protocol/client-info` 의 `GATEWAY_CLIENT_CAPS` 상수다:
`agent-kind`, `approvals`, `exec-approvals`, `inline-widgets`, `run-tool-bindings`, `session-scoped-events`, `plugin-approvals`,
`task-suggestions`, `terminal-offset-seq`, `terminal-session-metadata`, `terminal-upload-path-style`, `tool-events`,
`ui-commands`, `usage-refreshing` (14개). 계획서가 쓴 세 이름은 **전부 유효**하다.
선언 여부는 에코백으로 확인할 수 없고 **행동(어떤 이벤트가 오는가)으로만** 확인된다 — 5절이 그 실례다.

## 5. 프로토콜 매핑 표 — 계획서 3.1절 vs 실측

### 5.1 메서드

| 계획서 이름 | `features.methods` | 실제 | 비고 |
| --- | --- | --- | --- |
| `chat.send` | 있음 | 호출 성공 | **필수 파라미터 `idempotencyKey` 가 계획서에 빠져 있다** (6.1) |
| `chat.history` | 있음 | 미호출 | `deltaCursor` 검증은 남은 질문 |
| `chat.abort` | 있음 | 미호출 | 파라미터는 `key`+`runId` 가 아니라 **`sessionKey`**(필수) + `agentId`/`runId`/`preserveSideRuns` |
| `sessions.subscribe` | 있음 | 호출 성공 | 응답은 `{ "subscribed": true }` **뿐**. 로스터 없음 (6.4) |
| `sessions.messages.subscribe` | 있음 | 호출 성공 | `{ subscribed, key, approvalReplay }` (6.4) |
| `sessions.create/patch/reset/delete` | 있음 | 미호출 | `chat.send` 가 세션을 자동 생성하므로 MVP 에 불필요 (6.2) |
| `sessions.title.prepare` | 있음 | 미호출 | |
| `approval.get` / `approval.resolve` / `approval.history` | 있음 | 미호출 | |
| `exec.approval.{request,get,list,resolve,waitDecision}` | 있음 | 미호출 | |
| `exec.approvals.get/set` | 있음 | 미호출 | |
| `plugin.approval.*` | **부분** | — | `plugin.approval.get` **없음**. 실제는 `list`/`request`/`waitDecision`/`resolve` |
| `artifacts.download` | 있음 | 미호출 | `artifacts.list`·`artifacts.get` 도 있음 |
| (계획서 없음) | 있음 | — | `sessions.list` — **로스터는 여기서 읽어야 한다** |

### 5.2 이벤트

| 계획서 이름 | `features.events` | 실제로 왔나 | 비고 |
| --- | --- | --- | --- |
| `chat` | 있음 | **왔다** (8회) | `state`: `status`/`delta`/`final` 관찰. `error`·`aborted` 는 미관찰 |
| `agent` | 있음 | **왔다** (15회) | `stream`: `lifecycle`/`run_status`/`thinking`/`tool`/`assistant` |
| `session.message` | 있음 | **왔다** (4회) | `usage`·`stopReason`·`model` 이 여기 실린다 (6.3) |
| `session.tool` | 있음 | **안 왔다 (0회)** | 원인은 5.4 |
| `session.operation` | 있음 | 안 왔다 | compact 를 안 돌렸으니 예상대로 |
| `session.approval` | 있음 | 안 왔다 | 승인 요구가 발생하지 않았다 (6.5) |
| `session.observer` | 있음 | 안 왔다 | 관찰자 없음 |
| `presence`/`tick`/`health`/`heartbeat`/`shutdown` | 있음 | 안 왔다 | 연결이 ~15초로 짧았다(`tickIntervalMs` 30초) |
| (계획서 없음) | 있음 | **왔다** | `sessions.changed`(8회), `node.hostStats`(3회 — 전역 브로드캐스트) |

### 5.3 capability

계획서 3.1절은 「문서상 `tool-events`·`approvals`·`session-scoped-events`. 스키마에서 enum 으로 강제되지 않으므로
`hello-ok.features.capabilities` 로 이름을 확정한다」고 적었다. **확정 수단이 틀렸다** — `features.capabilities` 는 서버 기능 플래그다(4.6).

| 계획서 3.1절이 댄 이름 | `GATEWAY_CLIENT_CAPS` 상수 (정본) | `connect.caps` 로 선언 | `hello-ok.features.capabilities` 에 에코 | 선언의 실제 효과 |
| --- | --- | --- | --- | --- |
| `tool-events` | 있음 (`TOOL_EVENTS`) | 했다 | **없음** | **확인됨** — 툴 phase 가 `agent`/`stream:"tool"` 로 왔고 `session.tool` 은 오지 않았다 (5.4) |
| `approvals` | 있음 (`APPROVALS`) | 했다 | **없음** | 미확인 — 이번 런에서 승인 요구가 발생하지 않았다 (6.5) |
| `session-scoped-events` | 있음 (`SESSION_SCOPED_EVENTS`) | 했다 | **없음** | 미확인 — 세션 범위 필터링을 분리 검증하지 않았다 |

세 이름 모두 **유효한 값**이다. `GATEWAY_CLIENT_CAPS`(`@openclaw/gateway-protocol/client-info`) 전체 14개는
`agent-kind`, `approvals`, `exec-approvals`, `inline-widgets`, `run-tool-bindings`, `session-scoped-events`,
`plugin-approvals`, `task-suggestions`, `terminal-offset-seq`, `terminal-session-metadata`,
`terminal-upload-path-style`, `tool-events`, `ui-commands`, `usage-refreshing` 이다.
우리가 앞으로 쓸 만한 미선언 항목: `exec-approvals`, `plugin-approvals`(승인 종류별 이벤트),
`inline-widgets`(components v1 렌더러), `run-tool-bindings`.

**선언한 것은 반드시 구현한다**는 계획서 규칙은 그대로 유효하고, 오히려 더 중요해졌다 —
에코백이 없으므로 **선언의 효과는 행동으로만 드러나고**, 잘못 선언하면 조용히 이벤트 경로가 바뀐다. 5.4가 그 실례다.

### 5.4 `session.tool` 이 안 온 이유 — **`tool-events` 를 선언했기 때문이다**

Gateway 번들 소스를 읽어 확인했다
(`/Applications/OpenClaw.app/Contents/Resources/node-worker/arm64/lib/node_modules/openclaw/dist/`).

- `principal-CweFVZNq.mjs:4228` — `chat.send` 를 보낸 연결이 `tool-events` cap 을 선언했으면 그 런의 **`toolEventRecipients` 로 등록**된다:
  `connId && hasGatewayClientCap(principal?.connect?.caps, GATEWAY_CLIENT_CAPS.TOOL_EVENTS) ? (runId) => registerToolEventRecipient(runId, connId) : void 0`.
- `server-chat-BP_fmUto.mjs:916-923` — 툴 이벤트는 먼저 `toolEventRecipients` 에게 **`agent`** 로 나간다.
- `server-chat-BP_fmUto.mjs:932-939` — 그 다음 `session.tool` 은
  `excludeConnIds(sessionEventSubscribers.getAll(), runToolRecipients)`, 즉 **`toolEventRecipients` 를 뺀 집합**에만 나간다.

즉 **`session.tool` 과 `agent`(stream `tool`)는 같은 정보의 두 배달 경로이고, 우리는 전자에서 명시적으로 제외된 쪽**이다.
`session.tool` 은 「런을 띄우지 않았지만 세션을 보고 있는 다른 연결」용이다.

**조건이 하나 더 있다.** 두 분기 모두 앞에 **`isControlUiVisible`** 가 걸려 있고,
`session.tool` 분기는 `isControlUiVisible && sessionKey && !suppressHeartbeatToolEvents` 다.
`isControlUiVisible` 이 아닐 때는 `hasSessionMessageSubscribers` 인 경우에 한해 `agent` 가 나가고 `session.tool` 은 아예 안 나간다.
따라서 **`tool-events` 를 끄기만 하면 `session.tool` 이 온다고 단정할 수 없다** —
Phase 1 에서 `session.tool` 을 폴백 경로로 붙일 생각이라면 그 전에 이 조건부터 실측해야 한다.

**그래서 달라지는 것**: 계획서 3.1절의 「툴 실행 진행 상황은 `session.tool` 과 `agent` 이벤트에 의존한다」를
「**우리 어댑터는 `agent` 의 `stream: "tool"` 하나만 정규화한다. `session.tool` 은 우리가 `tool-events` 를 선언하는 한 오지 않는다**」로 고친다.
`packages/openclaw-adapter/src/gateway/events.ts` 는 `session.tool` 핸들러를 만들지 않아도 된다(방어적으로 같은 정규화 함수에 연결만 해 둔다).

## 6. 실물 페이로드

### 6.1 `chat.send` 요청·응답

보낸 파라미터(그대로):

```json
{
  "sessionKey": "agent:main:dodok:spike:20260915-0029",
  "agentId": "main",
  "message": "Reply with exactly: PONG",
  "idempotencyKey": "dodok-spike-agent:main:dodok:spike:20260915-0029-1"
}
```

응답:

```json
{ "runId": "dodok-spike-agent:main:dodok:spike:20260915-0029-1", "status": "started" }
```

- **`idempotencyKey` 는 스키마상 필수**(`required: ["sessionKey","message","idempotencyKey"]`)다. 계획서 3.1절의 파라미터 나열에 없다.
- **응답에 `messageSeq` 가 없다.** 계획서가 말한 `messageSeq` 는 `session.message` 이벤트의 필드다(6.3).
- **`runId` 가 우리가 보낸 `idempotencyKey` 와 글자 그대로 같다.** 즉 `runId` 는 Gateway 가 새로 만드는 값이 아니라
  클라이언트가 `idempotencyKey` 로 **정한다**. 계획서 「응답 정본은 플러그인 경로, Gateway WS 는 델타, runId 로 dedupe」 규칙에서
  **양쪽 runId 를 맞추려면 두 경로가 같은 `idempotencyKey` 를 쓰면 된다** — dedupe 설계가 훨씬 단순해진다.
- `status` 는 `"started"` 하나만 관찰. `runStarted` 계열 필드는 없다.

### 6.2 세션 자동 생성

`sessions.create` 없이 `chat.send` 만 보냈는데 세션이 만들어졌다. 첫 이벤트가
`sessions.changed { reason: "participants", createdVia: "operator", kind: "direct", visibility: "shared", sessionId: "<uuid>" }` 였다.
`sessionKey`(문자열)와 `sessionId`(uuid)는 **다른 값**이며 이벤트 페이로드에 둘 다 실린다.

### 6.3 `chat` 이벤트 실물

`state: "status"`:

```json
{ "runId": "...-1", "sessionKey": "agent:main:dodok:spike:20260915-0029", "agentId": "main",
  "seq": 2, "state": "status", "phase": "starting_model" }
```

`state: "delta"` (payload 키: `runId`, `sessionKey`, `agentId`, `seq`, `state`, `deltaText`, `message`):

```json
{ "runId": "...-1", "sessionKey": "...", "agentId": "main", "seq": 3, "state": "delta",
  "deltaText": "P",
  "message": { "role": "assistant", "content": [{ "type": "text", "text": "P" }], "timestamp": 1789399759910 } }
```

`message` 는 **누적 스냅샷**이 맞다. `replace` 플래그는 이번 관찰에 나오지 않았다.

`state: "final"` (payload 키: `runId`, `sessionKey`, `agentId`, `seq`, `state`, `message` — **끝**):

```json
{ "runId": "...-1", "sessionKey": "...", "agentId": "main", "seq": 6, "state": "final",
  "message": { "role": "assistant", "content": [{ "type": "text", "text": "PONG" }], "timestamp": 1789399760320 } }
```

**`usage` 도 `stopReason` 도 `final` 에 없다.** 계획서 3.1절의 「`final`(`message`, `usage`, `stopReason`)」은 틀렸다.
그 둘은 같은 시점에 오는 **`session.message`** 이벤트의 `message` 안에 있다:

```json
{ "role": "assistant", "content": [...], "stopReason": "stop",
  "api": "...", "provider": "claude-cli", "model": "claude-opus-5",
  "usage": { "input": 2, "output": 181, "totalTokens": 72629,
             "cacheRead": 71662, "cacheWrite": 784,
             "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 } },
  "timestamp": ..., "idempotencyKey": "cli-assistant:<runId>",
  "__openclaw": { "id": "<messageId>", "idempotencyKey": "...", "recordTimestampMs": ...,
                  "transcriptPosition": { "source": "<masked>", "rawSeq": 4 }, "seq": 4 } }
```

`session.message` 페이로드 최상위에는 `messageId`, **`messageSeq`**, `sessionId`, 그리고 세션 스냅샷 60여 필드
(`inputTokens`/`outputTokens`/`totalTokens`/`contextTokens`/`estimatedCostUsd`/`model`/`status`/`activeRunIds` 등)가 함께 온다.
**비용·토큰 표시(Phase 3 비용 상한)는 `session.message` 에서 읽는다.**

**`seq` 는 연속이 아니다.** 런 2 의 `chat` `seq` 는 `2 → 6 → 37 → 39`, 같은 런의 `agent` `seq` 는 `1,2,3,4,5,6,37,38,39` 였다.
`seq 37` 델타가 100자를 한 번에 실어 왔으므로 **Gateway 가 빠른 델타를 합치면서 `seq` 를 건너뛴다**.
따라서 `seq` 는 **순서 판정에만** 쓰고, 빈 칸을 유실로 보면 안 된다. 재접속 캐치업은 `seq` 연속성이 아니라 `chat.history` 의 `deltaCursor` 로 해야 한다.

### 6.4 구독 응답

```
sessions.subscribe({})                      → { "subscribed": true }
sessions.messages.subscribe({ key, agentId, includeApprovals: true })
                                            → { "subscribed": true,
                                                "key": "agent:main:dodok:spike:20260915-0029",
                                                "approvalReplay": { "sessionKey": "...", "updatedAtMs": ...,
                                                                    "approvals": [], "truncated": false } }
```

**`sessions.subscribe` 는 로스터를 주지 않는다** — 계획서의 「로스터 스냅샷 + `sessions.changed` 구독」 중 앞쪽이 틀렸다.
`inFlightRun` 같은 재접속 복구 필드도 없다. 로스터는 `sessions.list` 를 따로 불러 채우고,
**재접속 복구는 `sessions.list` + `chat.history`** 로 설계한다.

`sessions.messages.subscribe` 의 `approvalReplay` 는 `includeApprovals: true` 일 때 미해결 승인을 되감아 주는 자리다
(이번엔 빈 배열). 승인 카드(Phase 2)의 재접속 복구는 여기서 온다.

### 6.5 툴 이벤트와 승인

툴 유도 프롬프트(런 2)는 `Bash` 툴을 한 번 불렀고 **승인 요구는 발생하지 않았다**(`session.approval`·`exec.approval.requested`
·`openclaw.approval.requested` 0회). 이 에이전트의 권한 설정이 읽기 명령을 자동 허용한다는 뜻이며, 승인 이벤트의 실물 모양은 못 봤다.

`agent` 이벤트의 툴 phase 두 개(값은 요약, 워크스페이스 내용은 생략):

```json
{ "runId": "...-2", "sessionKey": "...", "agentId": "main", "seq": 4, "ts": ..., "isHeartbeat": false,
  "stream": "tool",
  "data": { "phase": "start", "name": "Bash", "toolCallId": "toolu_01Jx…",
            "args": { "command": "<셸 명령>", "description": "<한 줄 설명>" } } }

{ …, "seq": 5, "stream": "tool",
  "data": { "phase": "result", "name": "Bash", "toolCallId": "toolu_01Jx…",
            "isError": false, "result": "<툴 표준출력 전문>", "args": { … } } }
```

- `phase` 는 `start` → `result`. `toolCallId` 로 짝짓는다.
- **`result` 에 툴 출력 전문이 그대로 실린다.** 활동 패널(Phase 2)은 길이 상한과 마스킹을 UI 쪽에서 걸어야 한다.
- 툴 이벤트에는 세션 스냅샷 필드가 함께 붙는다(`buildSessionEventSnapshot`).

`agent` 의 다른 `stream` 값과 `data` 모양:

| `stream` | `data` |
| --- | --- |
| `lifecycle` | `{ phase: "start", startedAt }` / `{ phase: "end", endedAt, startedAt, terminalReply: { disposition, text }, executionSettled }` |
| `run_status` | `{ phase }` |
| `thinking` | `{ progressTokens }` |
| `assistant` | `{ text, delta }` (증분) / `{ text }` (최종) |
| `tool` | 위 |

`lifecycle`/`end` 의 `terminalReply.text` 가 **최종 응답 전문**이다 — `chat` `final` 과 중복되므로 둘 중 하나만 쓴다.

## 7. 계획서·스펙에서 고쳐야 할 것

| # | 계획서 3.1절의 서술 | 관찰된 값 | 고칠 내용 |
| --- | --- | --- | --- |
| 1 | 「`features` 가 지원의 진실 → Phase 0 에서 덤프해 매핑 표를 만든다」 | `features` 에 없는 `push.web.vapidPublicKey`·`sessions.get` 이 정상 호출됨; 없는 메서드와 스코프 부족이 똑같이 `FORBIDDEN`/`MISSING_SCOPE` | 「`features` 는 참고 목록. 가용성은 호출해서 `FORBIDDEN`/`MISSING_SCOPE` 로 판정」 |
| 2 | 「클라이언트 caps 를 `hello-ok.features.capabilities` 로 확정」 | `capabilities` 는 서버 기능 플래그 17개, 우리 caps 는 에코되지 않음 | 「caps 정본은 `GATEWAY_CLIENT_CAPS` 상수. 선언 효과는 행동으로만 확인」 |
| 3 | 「`chat.send` 파라미터: sessionKey, agentId, message, mentions, …」 | `idempotencyKey` 필수 | 파라미터 목록에 `idempotencyKey` 추가 |
| 4 | 「응답은 `messageSeq`, `status: "started"`, `runStarted` 계열」 | `{ runId, status: "started" }` | `messageSeq` 는 `session.message` 의 필드로 옮기고, `runId = idempotencyKey` 를 명시 |
| 5 | 「`final`(`message`, `usage`, `stopReason`)」 | `final` 은 `message` 만 | `usage`·`stopReason`·`model`·비용은 `session.message` 에서 읽는다고 고침 |
| 6 | 「툴 진행은 `session.tool` 과 `agent` 에 의존」 | `tool-events` 선언 연결은 `session.tool` 수신 대상에서 **제외**됨 | 「`agent` `stream:"tool"` 하나로 정규화」 |
| 7 | 「`sessions.subscribe` — 로스터 스냅샷 + 구독, `inFlightRun` 으로 재접속 복구」 | `{subscribed:true}` 뿐 | 로스터는 `sessions.list`, 복구는 `sessions.list`+`chat.history` |
| 8 | 「`chat.abort` — `key`+`runId`」 | 필수는 `sessionKey` | 파라미터명 정정 |
| 9 | 「2026.9.x 는 복수 `deviceTokens`」 | 단수 `auth.deviceToken` 만 옴 | 단수를 정본으로 |
| 10 | 「페어링: `openclaw devices approve <requestId>` 필요」 | 공유 토큰이 있으면 수 초 뒤 자동 승인 | 「보통은 자동. `PAIRING_REQUIRED` 가 지속될 때만 사람 안내」 + 짧은 재시도 필수 |
| 11 | `plugin.approval.get` | 없음 (`list`/`request`/`waitDecision`/`resolve`) | 이름 정정 |
| 12 | (없음) | `seq` 가 6→37 로 건너뜀 | 「`seq` 는 순서용, 연속성 아님」을 이벤트 정규화 규약에 명시 |
| 13 | (없음) | `policy.attachments.maxImageBytes = 6 MiB` | Phase 2 첨부 정책의 실제 상한 |
| 14 | (없음) | `mentions.changed` 이벤트 존재 | 멘션 릴레이 설계에서 확인할 것 |

### 7.1 계획서 3.1절 밖에서도 같은 이유로 틀린 문장

**이 표가 「고칠 곳의 목록」으로 쓰이므로 3.1절 바깥의 세 곳도 함께 적는다.** 빠뜨리면 병합 뒤 수정에서 그대로 새어 나간다.

| 위치 | 현재 문장 | 왜 틀렸나 | 고칠 내용 |
| --- | --- | --- | --- |
| `docs/plan.md:411` (8장 Phase 0, 스파이크 1 정의) | 「디바이스 페어링(`openclaw devices approve`) → `hello-ok.features` 덤프 → `chat.send` → `chat` 델타 수신 → **`session.tool` 이벤트 수신** 콘솔 출력」 | 표 6행·10행과 같은 이유 — 페어링은 자동 승인됐고(3.2), `session.tool` 은 `tool-events` 선언 때문에 오지 않는다(5.4) | 「페어링(보통 자동, 필요하면 `devices approve`) → … → **`agent` `stream:"tool"`** 수신」 |
| `docs/project-structure.md:197` (5장 2단계) | 「`openclaw-adapter/gateway/client.ts` — wss 접속·페어링·`hello-ok.features` 덤프·`chat.send`·`chat` 델타·**`session.tool` 콘솔 출력**까지 (스파이크 1)」 | 위와 같음 | `session.tool` → `agent`(`stream:"tool"`) |
| `docs/project-structure.md:101` (2.3절 `events.ts`) | 「`chat(delta/final/status/error/aborted)/agent/**session.tool**/session.approval → RunEvent 정규화 (runId+seq 정합)」 | `session.tool` 은 오지 않고(5.4), `usage`·`stopReason` 은 `session.message` 에 있다(6.3) | `session.tool` 을 빼고 `session.message` 를 넣는다. 「runId+seq 정합」은 **seq 가 연속이 아니라는 전제**(6.3)로 고친다 |

덧붙여 `docs/plan.md` 8장 Phase 0 「준비」의 **「에이전트 2개(`agents.entries`) 구성」**도 사실과 다르다 —
배포에는 이미 6개가 있다(2.1). 「임의 개수」로 고친다.

## 8. 남은 질문

1. **버전 불일치 동작을 못 봤다.** Gateway 가 이미 2026.9.4 였다. 프로토콜 불일치 시 `PROTOCOL_MISMATCH` + `expectedProtocol` 이
   온다는 것은 클라이언트 코드에서만 확인했고 실측은 아니다.
2. **승인 이벤트의 실물 모양을 못 봤다.** 읽기 전용 툴이 자동 허용됐다. 승인 카드 구현 전에 쓰기 툴로 한 번 더 유도해야 한다.
3. **`chat` `state: "error"`·`"aborted"` 미관찰.** `errorKind`/`errorDetail` 의 실제 값 목록이 필요하다.
4. **`chat.history` 의 `deltaCursor` 증분(`{kind:"delta"}`/`{kind:"reset"}`)을 확인하지 않았다.** 재접속 복구 설계의 핵심이므로 Phase 1 착수 전에 확인한다.
5. **`originatingChannel: "dodok"` 대체 경로 미확인.** 플러그인(스파이크 2)이 있어야 응답 배달을 볼 수 있다.
6. **`features` 에 없는데 호출되는 메서드가 왜 광고에서 빠지는지** 모른다. 플러그인/설정 조건부 등록으로 보이나 확인하지 않았다.
7. **자동 페어링 승인의 조건**(공유 토큰만으로 충분한지, 설정 항목이 따로 있는지)을 Gateway 설정에서 확인하지 않았다 — 설정을 바꾸지 않기로 했기 때문이다.
8. **`sessions.subscribe` 를 부르지 않아도 `chat`/`agent` 가 오는지** 분리 검증하지 않았다(둘 다 부른 뒤 관찰했다).
9. **`snapshot.health.agents` 의 6개가 `agents.entries` 소속인지 확인하지 않았다.** `openclaw agents list` 가 `main (default)` 하나만 보인 원인이 `cfg.agents.entries` 가 비어 있어서라면, 6개는 다른 경로(워크스페이스·세션 기록)로 잡힌 것일 수 있고 2.1절의 「계획서의 『에이전트 2개 구성』은 사실과 다르다」는 결론의 전제가 흔들린다. 스파이크 2 에서 Gateway 설정을 읽어 확정한다.

### 8.1 이월 — 스파이크 코드에 남은 것 (리뷰 지적, 이 스파이크에서 고치지 않음)

스파이크의 산출은 답이지 프로덕션 코드가 아니므로 아래는 **Phase 1 에서 이 코드를 이어받을 때** 처리한다.
「Phase 1 전 필요」로 표시한 것은 상시 연결로 바꾸는 순간 바로 문제가 되는 것들이다.

| 위치 | 내용 | 언제 |
| --- | --- | --- |
| `src/spike/gateway-spike.ts:283` | `await Promise.race([finished, sleep(RUN_TIMEOUT_MS)])` 가 **진 타이머를 끄지 않는다.** 런이 3초에 끝나도 120초짜리 타이머가 이벤트 루프에 남아 프로세스가 최대 2분 더 매달린다. 핸들을 잡아 `clearTimeout` 하면 된다 | 이 패턴이 서버로 복사되기 전 |
| `src/spike/gateway-spike.ts:56` | 마스킹 정규식 `/^[A-Za-z0-9+/_-]{40,}={0,2}$/` 가 `.`·`:` 를 포함한 토큰(JWT 모양, `prefix:secret`)을 **못 잡는다.** 키 이름이 `SECRET_KEYS` 에 없으면 평문으로 400자까지 기록된다 — 길이 임계만으로 가리는 설계가 fail-open 이다 | 이 마스킹을 재사용하기 전 |
| `src/spike/gateway-spike.ts:64` | 배열 원소에 `keyHint` 를 넘기지 않는다(`value.map((entry) => maskValue(entry))`). `SECRET_KEYS` 의 키 아래 문자열 배열(예: 스키마의 `deviceTokens: [...]`)이 오면 키 기반 마스킹이 무력화된다. `maskValue(entry, keyHint)` 로 넘기면 끝난다 | 위와 같이 |
| `src/spike/gateway-spike.ts:35` | `MAX_CHAT_SENDS` 는 **프로세스당 상한이지 누적 예산이 아니다.** `pnpm -F @dodok/openclaw-adapter spike:gateway` 를 다시 돌리면 사용자 Gateway 에서 모델 런이 2회 더 돈다. 브리프의 3회 상한은 사람이 지킨 것이지 코드가 강제하지 않았다 | 재실행 전 인지 |
| `src/spike/gateway-spike.ts:319` | `agentId` 기본값이 `"main"` 리터럴 — `snapshot.sessionDefaults.defaultAgentId` 를 읽으면 하드코딩이 필요 없다 (2.1) | Phase 1 |
| `src/gateway/client.ts:219-233` | `GatewayClientOptions` 의 **`onClose`·`onReconnectPaused`·`onGap` 이 배선돼 있지 않다.** `hello-ok` 이후 끊기면 `onConnectError` → 이미 확정된 프로미스로 흘러 무시되고 호출자는 끊김을 알 방법이 없다. `onGap({expected, received})` 를 버리는 것은 6.3 의 결론(「seq 는 순서용」)과 정면으로 맞물리는 자리다 | **Phase 1 전 필요** |
| `src/gateway/client.ts:65-72` | 토큰 저장소 `read()` 가 **모든 오류를 `{}` 로 삼킨다.** 손상된 토큰 파일이면 조용히 토큰을 잃고 재페어링한다 — 같은 상황에서 던지는 `device-identity.ts` 와 정책이 어긋난다. 최소한 `logError` 로 흘려야 한다 | **Phase 1 전 필요** |
| `src/gateway/client.ts:77-78` | 토큰 파일은 `renameSync` 뒤 `chmodSync(0o600)` 을 하지 않는다(`device-identity.ts:127` 은 한다). 실측 권한은 0600 이지만 umask 에 의존하는 형태다 | Phase 1 |
| `src/gateway/client.ts:57,68` | `StoredDeviceTokens` 를 캐스팅만 하고 검증하지 않는다. 손상 입력이 그대로 통과한다 (경계에서 Zod 파싱 규칙과 어긋남) | Phase 1 |
| `test/device-identity.test.ts` | `parseStoredDeviceIdentity` 의 **손상 파일 6갈래 분기와 0600 권한에 테스트가 없다.** 조용히 넘어가면 페어링이 날아가는, 이 모듈에서 가장 값비싼 로직이다 | Phase 1 에서 이 모듈을 실제로 쓸 때 |

**설계 판단이 필요한 자리**(리뷰가 8절 항목으로 올리라고 지적한 것): 지금 래퍼는 「첫 connect 실패 = 거절 + 클라이언트 폐기」라
라이브러리 재접속과 충돌하지 않는다. 스파이크에는 이게 맞다. 그러나 **상시 연결(Phase 1)에서는 라이브러리 재접속을 쓰고
`onClose`/`onGap` 을 `GatewayConnection` 의 수명 신호로 노출하는 쪽**으로 뒤집어야 한다 — 그때 3.4 의 「짧은 재시도」를
어느 층이 책임지는지도 함께 정해야 한다.
