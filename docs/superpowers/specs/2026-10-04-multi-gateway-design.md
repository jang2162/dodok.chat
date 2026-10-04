# 멀티 Gateway — 앱에서 구성하는 OpenClaw 연결 여럿 설계

**상태**: 설계 확정(2026-10-04), 구현 전.
**범위**:
- OpenClaw Gateway 연결(주소·공유 토큰)을 `.env` 가 아니라 연결 페이지(owner)에서 추가·수정·끄기·삭제하고 DB 에 둔다
- 한 워크스페이스에 Gateway 여럿을 붙이고, Gateway 마다 플러그인·브리지 토큰·페어링·디바이스 아이덴티티를 따로 둔다
- 에이전트는 Gateway 별로 구분한다 — 두 Gateway 의 같은 id(예: `main`)를 둘 다 등록하고 채널에서는 dodok 핸들로 가른다

**앞선 근거**:
- 어댑터 계약 `packages/shared/src/adapter/`(`AgentAdapter`·`AdapterEvent`), 레지스트리 `apps/server/src/adapters/registry.ts`
- 「어댑터 하나가 연결 여럿을 품고 에이전트를 연결에 묶는」 본보기: Claude 러너 스펙 `docs/superpowers/specs/2026-09-27-claude-runner-design.md`(러너 토큰·`agents.runner_token_id`·「이 러너로 묶기」·첨부 범위 R5 — 그 스펙 「구현과 맞춘 것」 장)
- 브리지 토큰·플러그인 tgz·연결 페이지: 설정 마법사 스펙 `docs/superpowers/specs/2026-09-24-setup-wizard-design.md`
- 세션 키 형식과 스레드 하위 세션: `packages/shared/src/session-key.ts`(`dodokSessionKey`·`parseDodokSessionKey`), 스레드 스펙 `docs/superpowers/specs/2026-09-25-threads-search-design.md`
- 역할: 팀 스펙 `docs/superpowers/specs/2026-09-26-team-members-design.md` 「역할과 권한」

---

## 0. 결정 (브레인스토밍 2026-10-04)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **배포 이력이 없으므로 기존 배포 이행을 만들지 않는다** — `.env` 의 OpenClaw·브리지 값을 이어받는 경로 없음 | 사용자 결정. 이행 코드는 지킬 대상이 없다. |
| 2 | **쓰임새는 「한 팀의 Gateway 여럿」과 「사람마다 자기 Gateway」를 둘 다 염두**에 둔다 — v1 은 owner 가 관리하고, 데이터 모델에 소유자 자리(`owner_user_id`)만 둔다 | 사용자 결정. 사람마다 붙이기는 권한·화면이 따로 필요해 다음 사이클이다. |
| 3 | **에이전트는 Gateway 별로 구분**한다 — 정체는 「Gateway + Gateway 안 id」, 채널에서는 워크스페이스 유일 핸들 | 사용자 결정. OpenClaw 기본 에이전트(`main`)끼리 자주 겹친다. |
| 4 | **Gateway 공유 토큰은 DB 에 평문**으로 두고 API 로 다시 내보내지 않는다 | 사용자 결정. 같은 `data/` 에 그것만으로 Gateway 에 붙는 디바이스 아이덴티티·디바이스 토큰이 평문으로 있고 백업에도 같이 들어가므로, 공유 토큰만 암호화해도 방어가 늘지 않는다. |
| 5 | **구조는 안 B — OpenClaw 어댑터 하나가 Gateway 연결 여럿을 품는다**(레지스트리는 「제공자당 하나」 그대로) | 사용자 결정. 바뀌는 자리가 어댑터 패키지 안과 계약의 연결 id 로 모이고, 러너 어댑터와 같은 모양이라 「연결」 개념이 하나다. 안 A(Gateway 마다 어댑터 인스턴스)는 레지스트리를 런타임에 바뀌는 목록으로 만들며 서버 배선 전체를 흔든다. |
| 6 | **핸들은 워크스페이스에서 유일**하고, 등록 때 겹치면 대화상자에서 다른 핸들을 고르게 한다 | 사람이 부르는 이름은 하나여야 한다. |
| 7 | **Gateway 를 지우면 그 Gateway 의 브리지 토큰은 함께 지우고, 에이전트는 남겨 연결을 비운다**(옮기기를 기다림) | 채널 이력·멤버십을 지킨다. 러너의 「이 러너로 묶기」와 같은 복구 길. |
| 8 | **브리지 첨부 읽기를 Gateway 단위로 좁힌다**(러너 R5 와 같은 규칙) — 이번 범위에 넣는다 | Gateway 가 여럿이면 지금의 「브리지 토큰이면 아무 첨부나」가 다른 Gateway 의 채널 첨부를 연다. 사람마다 붙이기로 넓히면 구멍이 된다. |
| 9 | **Gateway 옮기기는 owner 전용** | 연결을 다루는 일이라 러너 「이 러너로 묶기」와 같은 권한이다. |
| 10 | **연결 점은 Gateway 를 하나로 모아 보이고, 플러그인 받기는 연결 페이지 OpenClaw 블록 머리에 한 번** | 점이 Gateway 수만큼 늘면 머리띠가 넘친다. 플러그인 tgz 는 서버에 하나다. |

---

## 1. 범위

**넣는 것**
- `gateways` 표와 owner 전용 Gateway API(목록·추가·수정·끄기/켜기·삭제), 저장 즉시 어댑터에 반영(재시작 없음)
- OpenClaw 어댑터의 연결 관리자 — Gateway 마다 WS 클라이언트·재접속·페어링·디바이스 아이덴티티·세션 복구·상태·버전
- `/bridge` 가 토큰 → Gateway 로 플러그인 연결을 나눠 받고, 「활성 플러그인 하나」를 Gateway 마다 둔다
- 어댑터 계약에 연결 id — 런·세션·승인 메서드가 받고, 어댑터 이벤트가 싣는다(러너 어댑터도 같은 계약)
- 서버 대조를 「연결 id + 세션 키」로 — 런 대기열·열린 런 찾기·최종 답의 에이전트 찾기·승인 대조·세션 복구 대상
- 에이전트 등록·찾기에 Gateway, 에이전트의 Gateway 옮기기, 연결이 빈 에이전트 표시
- 브리지 첨부 범위를 Gateway 단위로
- 운영 사건·버전 드리프트·상태·배너·연결 점을 Gateway 별로
- 연결 페이지 Gateway 카드 목록, 에이전트 가져오기의 Gateway 고르기, 운영 화면 Gateway 줄
- `.env` 에서 OpenClaw·브리지 토큰 변수 제거, Gateway 0개로 부팅
- dev:fake 를 가짜 Gateway·플러그인 둘로(같은 id 에이전트를 일부러 겹침)

**넣지 않는 것** — 「열린 문제」 장
- 사람마다 자기 Gateway 붙이기(화면·권한) — 자리(`owner_user_id`)만
- 플러그인 변경 — 필요 없다(3장)
- Gateway 공유 토큰 암호화
- 한 Gateway 를 dodok 서버 여러 곳에 붙이기

---

## 2. 구성

```
dodok 서버
 ├─ AdapterRegistry ── openclaw · claude          (제공자당 하나 — 그대로)
 ├─ OpenClaw 어댑터 = 연결 관리자
 │    ├─ Gateway 연결 gw1 ── Gateway WS · 페어링 · 디바이스 data/gateways/<gw1>/ · 플러그인 세션
 │    ├─ Gateway 연결 gw2 ── …
 │    └─ /bridge ── 토큰 검사 → { tokenId, gatewayId } → 그 연결로
 ├─ 러너 어댑터 = 연결 관리자 (러너 토큰마다 연결 — 그대로, 계약만 맞춤)
 └─ modules/gateways ── owner API · DB · 부팅 때 켜진 Gateway 를 어댑터에 넣음
```

**연결 id** — 어댑터 계약에서 「에이전트를 맡은 연결」을 가리키는 값이다. OpenClaw 는 `gateways.id`(에이전트 행의 `gateway_id`), 러너는 러너 토큰 id(에이전트 행의 `runner_token_id`)다. 서버는 에이전트 행에서 이 값을 꺼내 어댑터에 넘기고, 어댑터는 자기 이벤트에 이 값을 실어 돌려준다.

**세션 키** — 형식은 그대로다(OpenClaw 가 정한 모양 — 두 Gateway 의 `main` 이 같은 채널에 있으면 키가 같다). 서버 안에서 런·세션을 찾는 기준만 「연결 id + 세션 키」가 된다.

---

## 3. 데이터 모델·설정

### 3.1 `gateways` (새 표)

| 열 | 뜻 |
| --- | --- |
| `id` | uuid — 연결 id |
| `workspace_id` | |
| `name` | 화면 이름(예: 사무실·집). 워크스페이스 안에서 유일, 1~32자 |
| `url` | `ws://` 또는 `wss://` 만 |
| `token` | Gateway 공유 토큰, 평문. API 응답에 싣지 않는다(「설정됨」만) |
| `enabled` | 거짓이면 연결하지 않는다 |
| `owner_user_id` | v1 은 늘 null(워크스페이스가 관리). 사람마다 붙이기의 자리 |
| `last_version` | 마지막으로 본 Gateway 버전 — 드리프트·버전 바뀜 사건 |
| `created_at` · `updated_at` | |

### 3.2 바뀌는 표

- `bridge_tokens.gateway_id` — 필수, FK(`gateways.id`, ON DELETE CASCADE). 브리지 토큰은 Gateway 에 묶인다.
- `agents.gateway_id` — OpenClaw 에이전트만, FK(ON DELETE SET NULL). null 이면 「연결이 빈 에이전트」.
- `runs.connection_id` — 그 런을 실제로 맡은 연결 id(OpenClaw 는 Gateway id, 러너는 러너 토큰 id — `send` 가 돌려준 값, 4장). 에이전트를 옮겨도 옛 런의 대조가 흔들리지 않게 런에 남긴다.
- `approvals.connection_id` — 승인이 온 연결.
- 유일성:
  - OpenClaw 에이전트: `(gateway_id, provider_agent_id)` 유일.
  - 러너 에이전트: `(workspace_id, provider, provider_agent_id)` 유일 — 그대로(러너가 id 로 에이전트를 가져간다).
  - 제공자를 가로지르는 유일 규칙(러너 스펙 R2)은 없앤다.
  - 핸들 `(workspace_id, handle)` 유일 — 그대로.
  - `runs.provider_run_id`·`approvals.provider_approval_id` 는 전역 유일에서 연결 안 유일로 바꾼다. `messages.external_id` 는 계획 단계에서 생성 방식을 확인해, 플러그인이 만드는 UUID 면 전역 유일 그대로 둔다.
- `workspaces.ops_json.lastGatewayVersion` 은 없앤다(`gateways.last_version` 이 맡는다).

### 3.3 디바이스 아이덴티티

Gateway 마다 `DATA_DIR/gateways/<id>/` 아래에 디바이스 파일과 디바이스 토큰 파일을 둔다(지금 토큰 파일의 키 `deviceId:role` 에는 Gateway 가 없어 한 파일을 함께 쓰면 서로 덮는다). Gateway 주소가 바뀌면 그 디렉터리의 디바이스 토큰을 지워 다시 페어링한다. Gateway 를 지우면 디렉터리를 지운다. 백업은 `DATA_DIR/gateways/` 를 통째로 담는다.

### 3.4 `.env`

- 없앤다: `OPENCLAW_TARGET`·`OPENCLAW_GATEWAY_URL`·`OPENCLAW_GATEWAY_TOKEN`·`OPENCLAW_DEV_GATEWAY_URL`·`OPENCLAW_DEV_GATEWAY_TOKEN`·`OPENCLAW_DEVICE_IDENTITY_PATH`·`BRIDGE_TOKEN`(과 그 이어받기 `importEnvToken`·연결 페이지의 「.env 의 BRIDGE_TOKEN 은 더 이상 쓰지 않습니다」).
- 남긴다: `BRIDGE_PUBLIC_URL`(서버 공통 공개 주소), `OPENCLAW_FRAME_DUMP_PATH`(진단 — Gateway 마다 파일 이름에 id 를 붙인다).
- 서버는 Gateway 가 0개여도 뜬다.

---

## 4. 어댑터 계약

`packages/shared/src/adapter/` 의 `AgentAdapter`·`AdapterEvent`.

- 메서드가 연결 id 를 받는다:
  - `send(deliver, { connectionId, providerSessionId? })`
  - `abort(runId, sessionKey, connectionId)`
  - `resetSession(sessionKey, connectionId)`
  - `resolveApproval(providerApprovalId, kind, decision, connectionId)`
  - `supports(providerAgentId, connectionId, "threads")`
  - `listAgents(connectionId)`
  - `syncChannelConfig(channelId, config, connectionId)`
- `connectionId` 의 타입은 `string | null` 이다. OpenClaw 어댑터는 null 이면 `ADAPTER_UNAVAILABLE`. 러너 어댑터는 null 이면 지금 규칙(묶임 없는 에이전트는 먼저 알린 러너가 가져감)대로 고른다.
- `send` 의 결과(`AdapterSendResult`)는 **실제로 맡은 연결 id** 를 돌려준다 — 서버는 그 값을 `runs.connection_id` 에 남긴다(러너가 묶임 없는 에이전트를 가져간 경우에도 그 뒤 이벤트와 대조되게).
- `AdapterEvent` 의 `canonical`·`approval`·`run_event`·`run_signal` 에 `connectionId` 가 실린다.
- OpenClaw 상태·설정 상세가 Gateway 목록이 된다: `AdapterStatus` 의 openclaw 변형은 `{ provider: "openclaw", gateways: Array<{ id, name, enabled, gateway, bridge }> }`, `OpenClawSetupDetail` 은 Gateway 마다 지금의 `gateway`·`bridge.plugin` 블록을 담은 목록.
- 레지스트리 계약(`forProvider`·`forAgent`·`onEvent`·`all`)은 그대로다.

---

## 5. OpenClaw 어댑터·브리지

### 5.1 연결 관리자

`createOpenClawAdapter` 가 지금 하나 품은 것을 **Gateway 연결** 단위로 떼어 낸다. 연결마다:
- Gateway WS 클라이언트(`connectGateway`)·재접속 백오프·페어링 대기(`pairing.requestId`·`since`)
- 디바이스 디렉터리(3.3)
- 세션 복구 대상 — 그 Gateway 에이전트의 세션만(서버가 연결 id 별로 준다)
- 상태·버전·프레임 덤프 파일
- 그 Gateway 의 플러그인 세션과 중복 제거(`OutboundDedupe`)·진행 중 전달 기록

어댑터가 내는 조작:
- `upsertGateway({ id, name, url, token, enabled })` — 없으면 만들고, 주소·토큰이 바뀌었으면 그 연결만 다시 붙고, `enabled` 가 거짓이면 끊는다.
- `removeGateway(id)` — 연결과 플러그인 세션을 끊고 디바이스 디렉터리를 지운다.

**고장 격리** — 연결 하나의 예외·재접속 루프·페어링 대기가 다른 연결의 런을 막지 않는다. 연결마다 자기 오류 경계를 두고, 이벤트는 늘 자기 연결 id 를 단다.

**끊김·끄기·삭제 때 진행 중 런** — 그 연결의 열린 런은 러너가 끊길 때와 같은 경로로 닫힌다(`ADAPTER_UNAVAILABLE` + 「다시 실행」). 다시 실행은 에이전트가 그때 묶인 연결로 간다.

### 5.2 브리지

- 네임스페이스는 `/bridge` 하나이고 어댑터가 쥔다.
- 토큰 검사(`BridgeTokenVerifier`)가 `{ tokenId, gatewayId }` 를 돌려준다. 꺼졌거나 없는 Gateway 의 토큰은 거절한다.
- **「활성 플러그인 하나」는 Gateway 마다** — 같은 Gateway 에 새 플러그인이 hello 하면 앞 연결을 `replaced` 로 끊고, 다른 Gateway 의 플러그인은 건드리지 않는다.
- 토큰 폐기는 지금처럼 그 토큰의 연결만 끊는다(`revokeTokenSessions`).

### 5.3 플러그인은 바뀌지 않는다

hello 모양(`BridgeHello`)과 설정 조각(`channels.dodok.accounts.default` 의 `bridgeUrl`·`token`)은 그대로다. 서버는 토큰만으로 Gateway 를 안다. 이미 설치된 플러그인은 Gateway 마다 자기 브리지 토큰을 넣으면 된다.

---

## 6. 서버

### 6.1 대조 — 「연결 id + 세션 키」

- 열린 런 찾기(`findOpenRunBySession`)·런 대기열(`sessionQueues`)·최종 답의 에이전트 찾기(`agentIdFor`)·승인 대조(`approvals.ingest`)가 연결 id 를 함께 쓴다. 이벤트의 연결 id 는 4장대로 어댑터 이벤트에서 온다.
- `send` 가 돌려준 연결 id 를 `runs.connection_id` 에 채운다. `send` 전에 거절·대기로 끝난 런은 에이전트 행의 연결 id(없으면 null)를 남긴다.
- 세션 복구 대상(`sessionRecoverTargets`)은 Gateway 별로 나눠 각 연결에 준다.
- 채널 프롬프트 동기화는 그 채널에 에이전트를 둔 Gateway 마다 보낸다. 채널에 다른 Gateway 의 에이전트가 처음 들어오면 그 Gateway 에도 보낸다.

### 6.2 Gateway API (`modules/gateways/`, owner 전용)

- `GET /api/v1/gateways` — 목록(토큰 원문 없음, `tokenSet: true`). 상태는 연결 페이지의 설정 상태가 싣는다.
- `POST /api/v1/gateways` — `{ name, url, token }`. 저장 뒤 `upsertGateway`.
- `PATCH /api/v1/gateways/:id` — `{ name?, url?, token?, enabled? }`. 토큰 칸이 비면 그대로 둔다.
- `DELETE /api/v1/gateways/:id` — 브리지 토큰 삭제(cascade), 에이전트 `gateway_id` 비움, `removeGateway`. 응답에 비워진 에이전트 수·지운 토큰 수.
- 브리지 토큰 발급·목록·폐기는 `/api/v1/gateways/:id/bridge-tokens` 아래로 옮긴다. 발급 응답의 플러그인 설정 조각은 지금 모양 그대로.
- 부팅 때 켜진 Gateway 를 모두 `upsertGateway` 한다.

### 6.3 에이전트 API

- 찾기: `GET /api/v1/agents/discover?provider=openclaw&gatewayId=…`(admin 이상). OpenClaw 는 `gatewayId` 필수.
- 등록: OpenClaw 면 본문에 `gatewayId` 필수. 같은 Gateway 에 같은 id 가 있으면 `CONFLICT`, 핸들이 겹치면 지금처럼 `CONFLICT`.
- Gateway 옮기기: `PUT /api/v1/agents/:id/gateway { gatewayId }`(owner). 대상 Gateway 에 같은 id 가 있으면 `CONFLICT`.
- 에이전트 응답에 Gateway 요약(`{ id, name }` 또는 null)을 싣는다.

### 6.4 브리지 첨부 범위

러너 R5 와 같게 — 브리지 토큰으로 읽을 수 있는 첨부는 그 토큰의 Gateway 에서 열린 런이 받은 트리거 첨부와 그 Gateway 가 올린 첨부뿐이다. 첨부 묶기(`claimBridgeAttachments`)는 그 Gateway 가 올린 첨부만 받는다.

### 6.5 운영

- 사건 키에 Gateway id: `gateway_down`·`plugin_down`(키 `gateway:<id>`), 버전 사건(`gateway_version_changed` 키 `gateway:<id>`, `gateway_version_untested` 키 `gateway:<id>:<version>`).
- 버전 드리프트는 Gateway 마다 `gateways.last_version` 으로.
- 「OpenClaw Gateway 에 연결하지 못하고 있습니다」 시스템 알림은 Gateway 이름을 넣고 Gateway 마다 따로 낸다.
- `OpsStatus`·wire `adapter.status`·`GET /api/v1/adapter/status` 가 Gateway 목록을 싣는다.

### 6.6 권한

| 일 | 권한 |
| --- | --- |
| Gateway 추가·수정·끄기·삭제, 브리지 토큰, 에이전트 Gateway 옮기기 | owner |
| Gateway 에서 에이전트 찾기·등록 | admin 이상 |
| 운영 화면의 Gateway 줄 | admin 이상 |
| 연결 점·배너 | 누구나 |

---

## 7. 웹

**연결 페이지**(`/settings/connection`, owner)
- OpenClaw 블록 머리: 「플러그인 받기」(tgz 하나)와 「Gateway 추가」(이름·주소·토큰).
- Gateway 카드 목록. 카드 하나 = 상태(연결됨·재연결 중·페어링 대기·꺼짐, 호스트·버전·드리프트, 페어링 대기면 `openclaw devices approve <id>` 복사) · 플러그인(「접속됨 · 서버와 같은 빌드입니다」 등 지금 문구) · 이 Gateway 의 브리지 토큰(목록·발급·폐기, 발급 대화상자 그대로) · 메뉴(수정 — 토큰 칸은 「바꾸려면 입력」, 끄기/켜기, 삭제).
- 삭제는 페이지 안에서 한 번 더 확인한다 — 「이 Gateway 의 에이전트 N개는 남고 연결이 비어 옮기기를 기다립니다 · 브리지 토큰 M개가 지워집니다」.
- Gateway 0개면 빈 상태: 「OpenClaw Gateway 를 추가하면 그 안의 에이전트를 채널에 데려올 수 있습니다」 + 「Gateway 추가」.
- Claude 러너 블록은 그대로.

**에이전트 화면**(`/agents`)
- OpenClaw 에이전트 줄에 Gateway 이름(예: `@main-home · 집`).
- 「에이전트 가져오기」: OpenClaw 면 Gateway 를 먼저 고르고 그 Gateway 의 목록을 본다. 이미 등록한 것은 「같은 Gateway + 같은 id」로 숨긴다. 핸들 칸은 id 로 미리 채우고, 겹치면 「이미 쓰이는 핸들입니다 — 다른 핸들을 입력하세요」.
- 연결이 빈 에이전트 줄: 「Gateway 가 삭제됨 — 다른 Gateway 로 옮기거나 지우세요」 + 「Gateway 옮기기」(owner).

**어디서나**
- 연결 점: Gateway 를 하나로 모은다 — 모두 연결됨 초록, 일부 끊김 노랑, 모두 끊김 빨강, Gateway 없음 회색. 올리면 Gateway 별 상태.
- 배너: 끊긴 Gateway 이름 — 「OpenClaw Gateway 「집」에 연결되지 않아 그 Gateway 의 에이전트가 답하지 못합니다」, 둘 이상이면 「Gateway 2개」로 묶음. 「연결 설정 보기」는 연결 페이지로.
- 멘션 후보: OpenClaw 에이전트 옆에 Gateway 이름을 작게.

**운영 화면**(`/settings/operations`, admin 이상) — 상태 카드의 Gateway·플러그인·버전 줄을 Gateway 마다 반복, 사건 목록에 Gateway 이름.

---

## 8. 오류 처리

| 상황 | 동작 |
| --- | --- |
| 연결이 빈 에이전트를 멘션 | `ADAPTER_UNAVAILABLE` run_error 카드(「다시 실행」은 옮긴 뒤에 통한다) |
| 꺼진 Gateway 의 에이전트를 멘션 | 같음 |
| Gateway 끊김·끄기·삭제 때 진행 중 런 | `ADAPTER_UNAVAILABLE` + 「다시 실행」 |
| 꺼졌거나 지워진 Gateway 의 브리지 토큰으로 플러그인 접속 | 핸드셰이크 거절(토큰 틀림과 같은 경로·로그) |
| 같은 Gateway 에 플러그인 둘 | 나중 것이 이기고 앞 것은 `replaced` |
| Gateway 이름 겹침·잘못된 주소 | 400/409, 대화상자 칸 오류 |
| 같은 Gateway 에 같은 id 등록·옮기기 | `CONFLICT` |
| Gateway 주소 변경 | 그 연결만 다시 붙고 다시 페어링(디바이스 토큰 지움) |

---

## 9. 테스트·검증

- **shared** — 계약 스키마(Gateway API 본문, 상태·설정 상세 모양).
- **어댑터 단위**(가짜 Gateway 둘) — 연결 격리(하나가 재접속 루프여도 다른 연결이 런을 받음), Gateway 마다 활성 플러그인 하나, 토큰 → Gateway 분배, 끄기·삭제·폐기는 그 연결만, 주소 변경은 그 연결만 다시 페어링, 이벤트의 연결 id.
- **서버 통합**(가짜 Gateway·플러그인 둘) — 두 Gateway 의 `main` 을 같은 채널에 넣고 각각 멘션: 최종 답·승인·런 이벤트가 맞는 에이전트로, 대기열이 서로 막지 않음 · Gateway 삭제 → 열린 런 `ADAPTER_UNAVAILABLE`·에이전트 연결 비움 → 옮긴 뒤 다시 실행 · 브리지 첨부가 다른 Gateway 첨부를 못 읽음 · 채널 프롬프트가 에이전트를 둔 Gateway 에만 감.
- **역할 매트릭스** — 새 경로(Gateway CRUD·옮기기·브리지 토큰 = owner, 찾기·등록 = admin 이상).
- **dev:fake** — 시작할 때 가짜 Gateway 둘을 DB 에 넣는다(「사무실」 `dev`·`fin`, 「집」 `main`·`dev` — 같은 id 가 일부러 겹친다), 가짜 플러그인 둘(각자 고정 브리지 토큰). 훅은 Gateway 를 고른다(`/__devfake/gateway {gatewayId, state}`, `/__devfake/plugin-token {gatewayId, token}` 등). 화면에서 「Gateway 추가」로 붙여 볼 셋째 가짜 Gateway 주소를 하나 더 열어 둔다.
- **브라우저 검증**(dev:fake) — 연결 페이지 카드·추가·수정·끄기·삭제, 가져오기 대화상자(Gateway 고르기·핸들 겹침), 같은 id 두 에이전트 멘션, 옮기기, 배너·연결 점, 운영 화면.
- **실연**(모델 런 0회 기본) — 로컬 dev Gateway(`openclaw --dev`)를 연결 페이지 「Gateway 추가」로 붙여 페어링·플러그인·런 0회 하네스. 둘째 실물 Gateway 는 dev Gateway 를 다른 상태 디렉터리·포트로 하나 더 띄울 수 있으면 실물로, 안 되면 가짜로 짝을 맞춘다(계획 단계에서 먼저 확인). 모델 런은 따로 승인을 받는다.
- 태스크마다 독립 리뷰(변이)·수정·범위 재리뷰.

---

## 10. 완료 기준

1. `.env` 에 OpenClaw·브리지 토큰 변수 없이 서버가 뜨고, 연결 페이지에서 Gateway 를 추가하면 재시작 없이 붙는다.
2. Gateway 둘에 같은 id 의 에이전트를 각각 등록해 같은 채널에서 핸들로 부를 수 있고, 답·승인·런 이벤트가 섞이지 않는다.
3. Gateway 하나를 끄거나 지워도 다른 Gateway 의 런·플러그인·사건은 그대로다.
4. 지운 Gateway 의 에이전트를 다른 Gateway 로 옮겨 다시 쓸 수 있다.
5. 브리지 토큰은 자기 Gateway 의 첨부만 읽는다.
6. 운영 화면·배너·연결 점이 Gateway 별 상태를 보인다.
7. 문서(`docs/guides/deploy.md`·`user-guide.md`·`project-structure.md`·`live-smoke.md`·`.env.example`·CLAUDE.md)가 env 없이 연결 페이지에서 Gateway 를 붙이는 흐름을 말한다.
8. 테스트·브라우저 검증·실연 결과가 기록돼 있다.

---

## 11. 열린 문제 (범위 밖 기록)

- **사람마다 자기 Gateway** — `owner_user_id` 를 채우는 화면·권한, 그 Gateway 의 에이전트를 누가 등록·옮길 수 있는지, member 가 연결 페이지 일부를 보는 모양.
- **한 Gateway 를 dodok 서버 여러 곳에** — 플러그인 다중 계정은 이미 되지만 채널 설정(`channels.dodok.channels.<id>`)이 계정별이 아니다.
- **Gateway 공유 토큰 암호화** — 디바이스 아이덴티티·토큰 파일과 함께 다룰 때.
- **다른 에이전트 러너**(Codex 등) — 이 설계의 연결 id 계약 위에 얹는다.

---

## 12. 구현과 맞춘 것

구현(계획 `docs/superpowers/plans/2026-10-04-multi-gateway.md` 태스크 1~9)·리뷰·브라우저 검증(태스크 9)·곁가지 c1·실연(태스크 10)에서 이 설계와 달라지거나 설계가 정하지 않은 것을 정한 자리만 모았다.
정본 근거는 실행 원장 `.superpowers/sdd/2026-10-04-multi-gateway/ledger.md`(git 제외)의 판정과 원장이 가리키는 보고서·리뷰(`t1`~`t10`·`c1` — 줄 끝 괄호가 출처)다. 본문(0~11장)은 설계를 확정한 때의 기록이라 고치지 않았다 — **본문과 이 장이 다르면 이 장이 구현이다.**
실연은 `docs/guides/live-smoke.md` 「멀티 Gateway 실연」 절, 운영 절차는 `docs/guides/deploy.md` 「체크리스트 — 처음 배포」·「Gateway 수정·끄기·삭제」 절, 각 파일이 왜 그렇게 생겼는지는 그 파일의 머리 주석이 정본이다.

**계획 판정 PG1~PG10**

- **PG1 — 태스크 1 은 동작을 바꾸지 않았다.** 계약·스키마·대조를 먼저 연결 단위로 바꾸고, 그동안 `.env` 의 Gateway 하나를 연결 id 고정값 `env`(서버 `config.ts` 의 `OPENCLAW_ENV_CONNECTION_ID`)로 두었으며 `gateway_id` 가 null 인 OpenClaw 에이전트에 그 값을 썼다. 태스크 3 이 상수와 null 대체를 지웠다(계획, t1·t3).
- **PG2 — `messages.external_id` 는 전역 유일 그대로다.** 플러그인이 `dodok-reply-<uuid>`·`dodok-tool-<uuid>`·`dodok-out-<uuid>` 로 만든다(3.2 마지막 줄의 확인 결과, 계획).
- **PG3 — `runs.provider_run_id`·`approvals.provider_approval_id` 는 연결 안 유일**(`runs_connection_provider_run`·`approvals_connection_provider`), 런 대기열 키는 `${connectionId}\u0000${sessionKey}`. 묶임 없는 러너 에이전트는 빈 연결 키라, 첫 연결에 묶이는 한 번의 경계에서 앞 런과 뒤 런이 다른 큐에 선다 — 러너 쪽 대기열이 받는다(t1 「남은 것」·리뷰 M1).
- **PG4 — `AdapterSendResult.connectionId`**(`ok` 면 필수)를 `runs.connection_id` 에 쓴다. 런의 연결이 정해진 뒤 다른 연결이 그 런 id 를 실은 이벤트·정본은 버린다(warn). 연결이 아직 null 인 런(send 결과 전 — 러너는 ack 전에도 이벤트를 보낸다)은 받는다(t1 판단 4).
- **PG5 — 연결이 사라질 때 열린 런은 러너가 끊길 때와 같은 경로로 닫는다**(`ADAPTER_UNAVAILABLE` + 「다시 실행」). 닫는 때는 끄기·삭제·주소 변경, 그리고 **토큰 변경**이다. ack 전 send 는 send 가 `ADAPTER_UNAVAILABLE` 로 던지고(오케스트레이터가 닫는다 — RUN_ERROR 를 겹쳐 내지 않는다), ack 뒤 정본 전이면 RUN_ERROR + `gateway_error` 신호. final 뒤 60s 「늦은 프레임 받기」 창의 런은 열린 런이 아니다(t2 판단 4·6).
- **PG6 — 브리지 토큰 API 는 `/api/v1/gateways/:id/bridge-tokens` 아래다**(`GET`·`POST`, `DELETE …/:tokenId`). `/api/v1/setup/bridge-tokens*` 는 없다. 플러그인 tgz(`/api/v1/setup/plugin.tgz`)·설정 상태(`/api/v1/setup/status`)는 그 자리(계획).
- **PG7 — `SetupStatus` 의 OpenClaw 부분은 `gateways: GatewaySetup[]`**(`{ id, name, url, enabled, gateway: {state, host, version, pinned, drift, pairing}, bridge: {state, plugin}, pluginMatches }`), `bridge.publicUrl`·`pluginFile` 은 Gateway 와 상관없는 머리 값, `envTokenIgnored` 는 없다. 목록의 정본은 DB 행이다 — 어댑터 상세는 id 로 짝짓고, 어댑터가 모르는 행은 켜졌으면 down·꺼졌으면 disabled 로 보여 넣다 실패한 Gateway 도 연결 페이지에 남는다(계획, t3 판단 7).
- **PG8 — 둘째 실물 Gateway 는 `OPENCLAW_HOME` 으로 상태 디렉터리를 갈라 띄웠다** — 실연은 실물 둘(t10, `docs/guides/live-smoke.md` 「멀티 Gateway 실연」).
- **PG9 — 삭제는 한 트랜잭션**(브리지 토큰 cascade·에이전트 `gateway_id` 비움·행 삭제) 뒤 `removeGateway`, 응답 `{ unboundAgents, deletedTokens }`. `removeGateway` 실패는 warn 이다(행은 이미 없어 그 토큰은 핸드셰이크에서 거절된다). 그 Gateway 의 열린 사건 줄은 라우트가 아니라 감시(`watchConnections`)가 status 이벤트를 보고 닫는다 — 어느 경로로 빠지든 같은 결과(계획, t5 판단 2).
- **PG10 — 채널 프롬프트 동기화 대상은 그 채널의 OpenClaw 에이전트 멤버가 속한 Gateway 집합이다.** OpenClaw 에이전트가 없는 채널은 보내지 않는다(계획, t3 판단 4). 넣을 때·hello 때는 아래 「서버」.

**어댑터·상태 (태스크 2·5)**

- **판정 B — Gateway 별 상태.** 태스크 2 는 계약 `status()`·`setupDetail()` 의 단수 모양을 지키고 `gatewayStatuses()`·`gatewaySetupDetails()` 를 더했다(어댑터 안에 diff 를 가두려고). 태스크 5 가 계약 `status()`·wire `adapter.status`·`GET /api/v1/adapter/status` 를 `{ provider: "openclaw", gateways: [{ id, name, enabled, gateway, bridge }] }` 로 바꿨다 — Gateway 가 없으면 빈 목록, 꺼진 Gateway 는 `enabled: false`·`gateway: "disabled"`. 화면의 한 값(연결 점·배너)은 웹이 켜진 Gateway 를 모아 만든다. 계약 `setupDetail()` 만 단수(첫 켜진 Gateway)로 남고, 설정·운영 상태는 `gatewaySetupDetails()` 를 읽는다(ledger 판정 B, t2 판단 1, t5 판단 1·지침 보고 1).
- **능력(`capabilities()`)은 어댑터에 하나다** — 어느 Gateway 든 FORBIDDEN 이면 내린다(t2 판단 7).
- **주소·토큰을 바꿔도 플러그인 소켓은 끊지 않는다** — 브리지 토큰은 Gateway 주소와 상관없다. 플러그인을 끊는 것은 끄기·삭제뿐이다. 디바이스 토큰 파일은 주소가 바뀔 때만 지운다(t2 판단 4).
- **Gateway WS 가 끊기기만 한 것(재접속 루프)은 진행 중 런을 닫지 않는다** — 응답 정본은 플러그인 경로라 WS 가 없어도 런이 끝난다. 5.1·8장의 「끊김」은 PG5 의 끄기·삭제·주소 변경·토큰 변경으로 읽는다. 플러그인까지 끊긴 Gateway 의 런은 인바운드 제한시간(120s) 뒤 `ADAPTER_UNAVAILABLE` 로 끝난다(t2 판단 5·리뷰 지침 보고 2, t10 실연).
- **I1 판정 — 닫는 런에 abort 를 최선 노력으로 보낸다.** 끄기·삭제·주소/토큰 변경으로 닫는 런은 신호를 내기 전에 옛 Gateway 링크로 `chat.abort` 를 보낸다 — 링크가 붙어 있을 때만, 런마다 2s 상한(어댑터가 직접 건다 — 연결 구현이 제한시간을 지킨다는 보장이 없어서), 실패는 warn. 그 뒤 PG5 신호(`gateway_error`, `connectionClosed: true`)를 내고 옛 링크를 멈춘다. 새 링크는 기다리지 않는다. abort 는 최선 노력이다 — 링크가 붙어 있지 않거나 abort 가 실패·무응답이거나 abort 뒤에 플러그인이 디스패치하면 Gateway 안 런은 끝까지 돌 수 있다(t2 리뷰 I1, t2 수정 보고 지침 보고 1, t2 재리뷰 지침 보고).
- **늦은 정본 판정** — `connectionClosed` 로 닫힌 런의 늦은 정본은 **저장만 한다**(답을 잃지 않는다). 릴레이·푸시는 없고, 그 런의 「다시 실행」 카드는 소비된다 — 중복 실행을 막는다. 사람이 늦은 답을 다른 메시지로 오해할 수 있는 것이 대가다. `message.created` 의 `silent` 는 버스 안 표지라 wire 로 나가지 않는다(ledger 판정, t3 판단 8).
- **꺼졌거나 없는 Gateway 의 브리지 토큰** — 핸드셰이크는 `token mismatch` 와 같은 거절 로그로 거절하되 **인증 실패 카운터(`bridgeFail`)에 세지 않는다.** 꺼진 Gateway 의 플러그인은 자기 백오프로 계속 다시 붙고, 그걸 세면 같은 호스트의 다른 Gateway 플러그인까지 주소째 막힌다. 핸드셰이크와 hello 사이에 꺼지면 hello 를 `UNAUTHORIZED` 로 거절한다. 첨부 HTTP(`/bridge/attachments` 업로드·읽기)도 같은 401·같은 로그 문구(`route: "attachments"` 로 가른다)로 거절하고 세지 않는다 — 꺼짐 판정은 검증 함수가 아니라 라우트 훅에서 DB `gateways.enabled` 로 한다(검증의 null 은 카운터에 들어가서)(t2 판단 3·지침 보고 3, t5 수정 판단 1·3·지침 보고 2).
- **로그의 `gatewayId`** 는 Gateway WS 루프 줄(접속·재접속·페어링)과 Gateway 연결 추가·제거 줄에만 붙는다. `inbound delivered`·`bridge plugin hello` 같은 기존 줄에는 없다(t2 판단 8).
- **디바이스 아이덴티티는 `DATA_DIR/gateways/<Gateway id>/`**(`device.json`, Gateway 가 디바이스 토큰을 내주면 `device-tokens.json`). 서버는 `OPENCLAW_DEVICE_IDENTITY_PATH` 를 읽지 않고 옛 디바이스 파일을 이어 쓰지 않는다 — 다시 페어링한다(배포 이력 없음). 백업은 `gateways/` 를 통째로 담는다(파일 0600·디렉터리 0700). 루프백 공유 토큰 접속에서는 `device.json` 만 생겼다(t2 판단 9·10, t3, t10 실연).

**서버 (태스크 1·3·4)**

- **shared Gateway 스키마(`packages/shared/src/gateways/`)는 태스크 3 이 만들었다**(계획은 태스크 1 몫). 주소의 사용자 정보는 정규식 `^[a-z]+://[^/?#]*@` 로 거절한다 — shared 의 `lib` 에 `URL` 타입이 없어서다. `ws://a\b@host` 처럼 사용자 정보가 아닌 꼴도 거절되는 더 엄격한 쪽이다(t3 판단 1, t3 수정 보고 M1).
- **0013 은 Gateway 에 묶이지 않은 `bridge_tokens` 행을 버린다** — `bridge_tokens.gateway_id` 를 NOT NULL 로 바꾸며 생성기가 표를 다시 만들 때, 복사에 `WHERE gateway_id IS NOT NULL` 을 손으로 붙였다(null 행이 남으면 마이그레이션이 실패해 서버가 뜨지 않는다). 0012·0014 의 `ADD gateway_id … REFERENCES` 줄은 생성기가 빠뜨린 ON DELETE 를 손으로 붙였다(t1 판단 6, t3 판단 2, t4).
- **연결 id 는 공유 `Run`·`Approval` 에 싣지 않는다** — store 의 `getRunConnectionId`·`getApprovalConnectionId` 로 읽는다. `Run` 은 REST 로, `Approval` 은 wire 로 멤버에게 나가 Gateway uuid·러너 토큰 id 를 드러내게 된다(t1 판단 1).
- **`listAgents(connectionId | null)`** — 러너 찾기는 연결을 고르지 않는다(붙은 러너 전부). 이벤트의 에이전트 찾기(`agentOnConnection`)는 OpenClaw 면 `gateway_id = 연결`, 러너면 `runner_token_id = 연결 OR runner_token_id IS NULL`(묶임 없는 러너 에이전트는 먼저 알린 러너가 맡는다)(t1 판단 2·3).
- **유일성** — 러너 스펙 R2(제공자를 가로지르는 유일)를 없앴고, 같은 제공자 안 유일은 앱(`createAgent`, 대소문자 무시)에서도 지킨다. Gateway 가 빈 OpenClaw 에이전트끼리는 id 가 겹쳐도 된다 — 어느 연결의 것도 아니라 가를 대조가 없고, Gateway 둘을 지우면 각 Gateway 의 `main` 이 함께 비는 것이 자연스럽다(t1 판단 5, t4 판단 1).
- **에이전트 API** — OpenClaw 는 등록·찾기 모두 `gatewayId` 필수(워크스페이스의 Gateway 가 아니면 400), 찾기는 꺼진 Gateway 면 `ADAPTER_UNAVAILABLE`. 등록 본문·찾기 쿼리 스키마는 shared 가 아니라 서버 라우트에 있다(웹이 import 하지 않는다). `wire-cli add-agent <채널> <id> <핸들> [gatewayId]` — Gateway 가 하나면 뺄 수 있다(t4 판단 2·8).
- **`lacksThreads`(옛 플러그인 판정)** — 연결이 null 이면 막지 않고(할 일은 「옮기세요」라 `ADAPTER_UNAVAILABLE` 로 간다), 그 런의 Gateway 에 붙은 플러그인을 본다. 어댑터 목록에 없는 연결 id 는 「플러그인 없음」이다(t3 판단 5, t3 리뷰 I1, t3 수정 보고 I1).
- **첨부 범위(6.4 구체화)** — 브리지 토큰은 그 Gateway 가 올린 첨부를 묶이기 전후로 읽고(러너 R5 와 같다), 사람 첨부는 묶여 있어도 그 Gateway 에서 열린 런의 트리거일 때만 읽는다 — 런이 `queued` 여도 읽힌다(`runs.connection_id` 는 enqueue 때 채워지고 플러그인은 ack 전에 받는다). 정본에 묶는 첨부는 정본을 낸 Gateway 가 올린 것뿐이고, 러너의 정본은 Gateway 가 올린 첨부를 묶지 못하며 러너 claim 은 그 러너 토큰이 올린 것만 묶는다(`uploadedBy` 가 없으면 아무것도 묶지 않는다). Gateway 를 지우면 그 Gateway 가 올린 미묶음 첨부는 `gateway_id` 가 비어 어느 Gateway 도 묶지 못한다(t4 판단 3~5·지침 보고 2, t4 리뷰 m1, t5 수정 판단 4·지침 보고 1).
- **채널 프롬프트 재전송** — Gateway 의 플러그인이 hello 하면 그 Gateway 에 에이전트를 둔 채널의 프롬프트를 그 Gateway 에 다시 보낸다(꺼졌다 켜진 Gateway·끊긴 사이 바뀐 프롬프트가 따라온다). 채널에 Gateway 가 처음 들어올 때와 hello 때는 프롬프트가 비어 있어도 `""` 를 보낸다 — 그 Gateway 가 낡은 값을 들고 있을 수 있다. 감시를 시작할 때 이미 붙어 있던 플러그인은 새 hello 로 치지 않는다(실물은 부팅 때 붙은 플러그인이 없어 서버를 다시 띄우면 Gateway 마다 한 번 보낸다)(t4 판단 6·7·지침 보고 3, t10 실연 기준 7).

**운영 (태스크 5)**

- **꺼진 Gateway 는 끊김 사건을 내지 않고, 끄면 열려 있던 그 Gateway 의 down 줄도 닫는다**(꺼진 채 부팅해도 앞 프로세스의 줄을 닫는다). Gateway 가 0개거나 모두 꺼졌으면 사건·배너가 없다(t3 리뷰 M5, t5 판단 3).
- **사건 detail 의 `gatewayName` 은 줄을 연 때의 이름이다** — 운영 화면은 key 의 id 로 지금 이름을 찾고, 못 찾으면(지운 Gateway) detail 의 이름을 쓴다(t5 판단 4, t7 판단 7).
- 옛 사건 key(`gateway`·`plugin`·`gateway:<version>`)를 이어받는 코드는 없다(배포 이력 없음, t5 판단 9).

**웹 (태스크 6·7, 곁가지 c1)**

- **Gateway 카드의 메뉴는 드롭다운이 아니라 버튼 셋**(「수정」·「끄기」/「켜기」·「삭제」, 접근 이름 「<이름> 수정」 등)이다 — 동작 셋을 펼침 뒤에 숨길 까닭보다 비용(쓰인 적 없는 드롭다운·jsdom 폴리필)이 컸고, 390px 에서도 배지와 한 줄에 든다(t6 판단, t6 리뷰 「메뉴를 버튼 셋으로 둔 판단」).
- **카드 상태 문구** — 7장의 넷(연결됨·재연결 중·페어링 대기·꺼짐)에 `down` 의 「연결 안 됨」을 더했다. 「페어링 대기」는 상태 값이 아니라 `pairing` 이 있을 때다. 「재연결 중」은 연결 페이지와 운영 화면 상태 카드가 같은 문구를 쓴다. 꺼 둔 Gateway 에는 「Gateway 주소·토큰과 서버 로그를 확인하세요.」를 내지 않는다. 끄기는 확인 없이 보낸다(진행 중 런이 「다시 실행」 카드로 닫힌다는 것은 수정 대화상자 설명에 있다)(t6 판단, t6 리뷰 Minor, t7 수정).
- **판정 S1 — 연결 점은 켜진 Gateway 만 센다.** 붙은 것이 없어도 다시 붙는 중인 Gateway 가 있으면 노랑(「Gateway 다시 연결 중」), 켜진 Gateway 가 없으면(0개·모두 꺼짐) 회색(「Gateway 없음」). 실물 어댑터는 끊긴 켜진 Gateway 를 `reconnecting` 으로 두므로 7장의 「모두 끊김 빨강」은 거의 나오지 않는다 — Gateway 하나일 때의 노랑을 지키고 배너가 함께 뜬다. 플러그인 점은 상태가 둘뿐이라 7장 네 상태 그대로다(ledger 판정 S1, t7 판단 4·지침 보고 2, t7 리뷰 S1, t9 R1).
- **판정 S2 — 「Gateway 옮기기」는 owner 에게 OpenClaw 에이전트 줄마다 있다**(연결된 줄에도 — 잘못 고른 Gateway 를 바로잡는 길도 같다). 연결이 빈 줄에는 빨간 안내가 더 붙는다(ledger 판정 S2, t7 판단 2·지침 보고 1).
- **가져오기 대화상자의 Gateway 목록은 어댑터 상태에서 온다** — `GET /api/v1/gateways` 는 owner 전용이고, 어댑터 상태는 누구나 읽어 admin 도 Gateway 를 고를 수 있다. 핸들 겹침은 아는 에이전트 핸들로 미리 막고, 사람 핸들 겹침은 서버 409 를 같은 문구로 보인다(t7 판단 1·8).
- **연결이 빈 에이전트 줄은 역할별 문구다** — owner 는 「Gateway 가 삭제됨 — 다른 Gateway 로 옮기세요」 + 「Gateway 옮기기」, admin·member 는 「Gateway 가 삭제됨 — owner 가 다른 Gateway 로 옮길 때까지 답하지 못합니다」. 7장의 「지우세요」는 뺐다 — 에이전트를 지우는 기능이 서버·웹 어디에도 없다(끄기는 「사용」 스위치)(ledger c1 판정, t9 D2, c1 D2·지침 보고).
- **옮기기 대화상자 안내는 두 규칙을 함께 말한다** — 옮길 Gateway 의 OpenClaw 에 그 id 의 에이전트가 **있어야** 답하고, 그 Gateway 로 이미 등록된 같은 id 는 **없어야** 한다(겹치면 409 — 「옮길 Gateway 에 같은 id 의 에이전트가 이미 있습니다」)(t9 D1, c1).
- **배너** — 7장 문장 뒤에 「메시지는 저장됩니다.」를 남겼다(옛 배너가 주던 정보). 「연결 설정 보기」는 owner 에게만(t7 판단 3).
- **운영 화면 상태 카드는 켜진 Gateway 마다 세 줄**(「Gateway 「<이름>」」·「플러그인 「<이름>」」·「Gateway 「<이름>」 버전」)이고 꺼진 Gateway 는 줄이 없다 — 줄 이름에 Gateway 이름을 넣은 것은 `dl` 안에 묶음 제목을 끼우면 HTML 이 어긋나서다(t7 판단 5·6).
- **7장 밖에서 더한 Gateway 이름** — 채널 설정의 「에이전트 추가」 고르기와 멤버 줄에도 OpenClaw 에이전트의 Gateway 이름이 붙는다(t9 M2, c1).
- **브리지 토큰 빈 안내** — 폐기된 줄만 남아도 「쓸 수 있는 토큰이 없습니다 — 발급하세요」. 삭제 확인의 토큰 수는 폐기된 토큰도 센다(지우는 행 수와 같다)(t9 M1, c1).
- wire 가 다시 붙으면 에이전트 목록을 다시 받는다(끊긴 사이 옮기기·삭제가 있었을 수 있다)(t7 재리뷰 N2, c1).
- **남긴 것** — 옮기기로 닫힌 대기 런의 카드는 일반 「@<에이전트> 실행이 실패했습니다: ADAPTER_UNAVAILABLE」 문구다. 「옮겨서 닫힘」을 가를 사유 코드가 서버에 없다(t4 리뷰 m3, t7 판단 10). 같은 id 를 이름 그대로 가져오면 운영 화면 에이전트별 표·채널 작성자 이름이 같아 갈리지 않는다(t10 실연 「새로 찾은 것」 1).

**dev:fake (태스크 8, 곁가지 c1)**

- 가짜 Gateway 둘은 「사무실」(`dev`·`fin`)·「집」(`main`·`dev`)이고 일부러 겹치는 id 는 `dev` 다(집 `dev` 의 핸들 `dev-home`). 에이전트 넷을 시작 때 등록하므로 두 Gateway 의 가져오기 목록은 비어 있는 것이 맞다 — 가져오기·핸들 겹침은 시작 로그 `spareGateway` 의 셋째 Gateway(로그 키 `gatewayToken` — `token` 키는 로거가 가린다)로 본다(t8 판단 2·3, t8 리뷰 지침 보고 2).
- 훅은 `gatewayId` 가 없거나 사무실·집의 고정 id 가 아니면 400 이다. `plugin-token` 훅에 다른 Gateway 에 묶인 토큰을 주면 400(받으면 그 플러그인이 다른 Gateway 자리를 차지해 짝이 섞인다)(t8 판단 4, t8 리뷰 Minor, t7 수정).
- 시작은 가짜 플러그인이 붙은 고정 짝만 기다린다. 사람이 끈 고정 Gateway·폐기한 고정 토큰이면 warn 만 남기고, 사람 손이 닿지 않았는데 고정 짝이 못 붙으면 시작이 실패한다(t7 수정, t7 재리뷰 N1, c1).
