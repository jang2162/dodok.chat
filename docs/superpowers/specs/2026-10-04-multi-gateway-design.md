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
