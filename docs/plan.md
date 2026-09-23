# dodok.chat — 에이전트 네이티브 메신저 개발 계획서 (v0.12)

작성일: 2026-09-14 · 상태: v0.12 (2026-09-24) — Phase 2 ④ PWA·푸시 구현·브라우저 검증 종료(16/16·결함 0, 실연은 예정 — `docs/guides/live-smoke.md` 14절). 8장 Phase 2 「PWA」에 완료 표시와 확인 방법, 「이월」을 Phase 2 ④ 종료 시점으로 다시 모음

### 변경 이력

| 버전 | 내용 |
| --- | --- |
| v0.3 | 결정 사항 6건 확정, 세션·내부 위임 설계(5.8) 추가 |
| v0.4 | (1) 프로젝트·플러그인 id를 `dodok`으로 통일 (2) 기본 배포 형태를 "본인 운영 원격 Gateway + 플러그인의 아웃바운드 브리지 접속"으로 변경 (3) OpenClaw 패키지 기준을 2026.8.1 → 2026.9.4로 갱신, "Gateway와 동일 버전 핀" 규칙 명문화 (4) 실시간 전송을 Socket.IO로 확정 (5) 최신 `protocol.schema.json`·`gateway-client` README·공식 문서 대조로 3.1절 사실 보강 (6) 채널 봇 루프 보호 설정과 `relayPolicy`의 이중 동작 검증을 Phase 0에 추가 (7) 결정 사항 7~10 추가, 내보내기 아티팩트 링크·HTML 엔티티 정리 |
| v0.5 | 스파이크 1(`docs/adr/0001-gateway-client-spike.md`) 실측 반영 — (1) `hello-ok.features`는 참고 목록, 가용성은 호출해 `FORBIDDEN`/`MISSING_SCOPE`로 판정 (2) caps 정본은 `GATEWAY_CLIENT_CAPS`, `features.capabilities`는 서버 플래그 (3) `chat.send`는 `idempotencyKey` 필수이고 `runId`가 그 값 (4) `final`에 `usage`·`stopReason` 없음 → `session.message` (5) 툴 진행은 `session.tool`이 아니라 `agent` `stream:"tool"` (6) `sessions.subscribe` 응답은 `{subscribed:true}`뿐 (7) `chat.abort`는 `sessionKey` (8) 디바이스 토큰은 단수 (9) 페어링은 공유 토큰이면 자동 승인 (10) `seq`는 순서용, 연속 아님 |
| v0.6 | Phase 0 종료 — ADR 0002 12절(6건)·ADR 0003 10절(7건)의 결정을 10장에 확정: #1 채널 프롬프트 주입 재판정, #11 Node 24 전환, #12 components 노출, #13 봇 루프 보호, #14 브리지 계약 `admission`, #15 「새 대화」= `sessions.reset` + `operator.admin`, #16 재접속 복구, #17 대체 경로 미사용, #18 `inboundChannelPrompt` 제거, #19 `:g<N>` 제거, #20 업스트림 보고 보류, #21 로컬 첫 에이전트 `dev`. 7장 백엔드 Node 24, 8장 Phase 1 첫 작업 두 건 추가 |
| v0.7 | Phase 1 종료 — 8장 Phase 1 의 웹 항목(마크다운 렌더, 스트리밍 버블·중지, 에이전트 등록 UI·채널 추가·프롬프트 편집)에 완료 표시와 실물 요약, 완료 기준에 확인 방법(통합 시나리오 1~8 · dev Gateway 실연 6런 · `dev:fake` 브라우저 검증 시나리오 5), Phase 2 에 마크다운 렌더 보강 한 줄, 8장 끝에 「이월 — 남은 문제」(웹 렌더·서버·웹·실물 확인) 추가 |
| v0.8 | Phase 2 ① 종료(활동 패널·승인) — 8장 Phase 2 의 「활동 패널(툴 타임라인, 런 목록), 승인 카드」에 완료 표시와 실물 요약, 「이월」에서 Phase 2 ① 이 정리한 아홉(서버 넷·웹 넷·`wire-cli` typecheck) 제거와 「한국어 강조·구두점 경계」 해결 표시, 브라우저 검증이 남긴 셋(D4 카드 점프·D6 카운트다운 어긋남·D11 로그아웃 401)과 서버 둘(다른 채널 미해결 승인의 새로고침 복구, `providerApprovalId` 가 어댑터 상한 처리 밖)을 이월에 추가, Phase 1 「실물 확인」 줄을 실연 완료(2026-09-20)로 정정 |
| v0.9 | Phase 2 ① **종료 확정** — 8장 Phase 2 「활동 패널·승인 카드」 완료 줄에 브라우저 재검증 결과(시나리오 9/9, 고친 7건 수치 확인, 새 결함 D12·D13·D14 도 수정), 「이월」 웹에 재검증 수정 라운드가 남긴 여섯(타임라인 행이 낡은 채 남음 · 자리값 소요가 계속 흐름 · `ended`·`vanished` 상한 없음 · 로그아웃 때 `/runs` 한 번 더 · 넓은 화면 「설정 닫기」 초점 · `PanelSlot` 하네스), 「실물 확인」의 사람 몫 줄에 재검증도 못 쟀다는 사실과 흉내 낸 방법 |
| v0.10 | Phase 2 ② **components v1 종료**(2026-09-22) — 8장 Phase 2 「`components` v1 렌더러」에 완료 표시와 실물 요약(블록 5종·셀렉트·모달·결과 줄, 확인 방법), 「이월」에서 Phase 2 ② 가 끼워 정리한 셋(D6 카운트다운 어긋남 · 자리값 소요가 계속 흐름 · 넓은 화면 「설정 닫기」 초점) 제거, Phase 2 ② 가 남긴 것 추가(계약·서버 프로토타입 계열 한 묶음과 권고 · `required` checkbox · 모순 셀렉트 refine · ack 타입 · 결과 문구의 빈 값 · 날짜 키 롤오버 · `lastSeq` 재구독 · 가상화 목록 초점 · 오류 문구 「버튼」 · 이미지 크게 보기 · 긴 라벨 버튼 넘침 · `media`·`file` 문구 비대칭 · 초점·타이머 낮은 셋 · `App.test` 셔플 · `a11y.test` 셀렉트 · `infra/` 부재), 「끝난 런 기억」에 `stopped` 보탬. 같은 날 브라우저 **재검증 24/24·결함 0** 을 완료 줄에 반영(실제 앱에서 다섯 사유·섞인 줄 24px 간격·셀렉트 스크롤 상자), 「이월」의 `lastSeq` 재구독·날짜 키 롤오버·긴 라벨 버튼에 재검증이 본 것과 못 잰 것 |
| v0.11 | Phase 2 ③ **첨부·이미지 종료**(2026-09-23, 실연은 남음) — 8장 Phase 2 「이미지 첨부」에 완료 표시와 확인 방법(통합 11a~11i · 브라우저 17/17 · 결함 1 고친 뒤 실제 앱 재측정), Phase 2 ② 「`components` v1」 줄의 `artifact://` 자리표시 문장을 지금 동작으로, 「이월」에서 Phase 2 ③ 이 닫은 둘(「`media` 이미지를 크게 볼 수 없다」·「`media`·`file` 문구 비대칭」) 제거, Phase 2 ③ 이 남긴 것 추가(스펙 10장 열린 문제 넷 · 판정 Ruling 1·2 가 틀렸을 때 남는 것 · `artifact://` 이름의 본질적 모호 · 잘린 VP8L · dev:fake 키워드 손 목록·진입점 · 채널 전환 초점 · 플러그인 배선 우회 · 종료를 붙잡는 keep-alive · 사람이 볼 것) |
| v0.12 | Phase 2 ④ **PWA·푸시 종료**(2026-09-24, 실연은 예정) — 8장 Phase 2 「PWA」에 완료 표시와 확인 방법(통합 12a~12h + 종료 · 브라우저 16/16·결함 0 — 실제 `web-push` → FCM 왕복 포함), 「이월」에 Phase 2 ④ 가 남긴 것 추가(스펙 10장 열린 문제 넷 · 구독 행이 세션과 묶이지 않음 · 가려졌지만 `visible` 인 창 · presence 잔류·상한 · 승인 기억 상한 테스트(p4-t3 리뷰 m2) · 동기화 경로 `userVisibleOnly`(Nit R14b) · 권한 `default` 문구(Nit F1c) · 서버만 죽었을 때 토스트 · 알려진 경고 셋(DEP0169·#912·#928) · 사람이 볼 것), 웹 「`lastSeq` 재구독」 줄에 사본 복원 경로는 닫혔다는 것(R5)과 남은 5분 창 |

---

## 1. 개요

### 1.1 한 줄 정의

사람과 AI 에이전트가 **같은 채널에서 동등한 참여자로 대화하는 메신저**. Slack/Discord처럼 채널로 주제를 나누되, 에이전트의 스트리밍 응답·작업 로그·버튼/선택 같은 인터랙티브 UI를 1급 기능으로 지원한다. 1차 연동 대상은 OpenClaw이며, 이후 Claude Code, Codex, Hermes 등을 같은 어댑터 인터페이스로 붙인다. 프로젝트 이름은 **dodok.chat**, 코드·설정·플러그인 id는 **`dodok`**이다.

### 1.2 목표

- **MVP (개인용)**: 웹앱 + PWA에서 OpenClaw 에이전트 여러 개를 채널별로 배치하고, 멘션 기반으로 대화·협업시킨다.
- **확장 (팀용)**: 워크스페이스/멤버/권한 개념을 처음부터 데이터 모델에 두어, 팀 단위 플랫폼으로 전환할 때 스키마 재설계를 피한다.
- **후속**: 데스크톱(Tauri)·모바일(Capacitor 또는 네이티브) 앱, Claude/Codex/Hermes 직접 연동.

### 1.3 확정된 방향 (v0.3 + v0.4)

| 항목 | 결정 |
| --- | --- |
| OpenClaw 연동 방식 | **하이브리드** — 전용 채널 플러그인(라우팅·UI 컴포넌트·채널 프롬프트) + Gateway WS 클라이언트(토큰 스트리밍·툴 이벤트·승인) |
| 멀티에이전트 발언 규칙 | **멘션 + 자동 릴레이** — @멘션된 에이전트가 응답, 에이전트가 다른 에이전트를 @멘션하면 앱이 릴레이 (턴 제한·루프 가드) |
| 기술 스택 / 실행 형태 | **TypeScript 풀스택 + 셀프호스팅** — React(Vite) PWA, Node 백엔드(Fastify + Socket.IO), SQLite→Postgres, Docker Compose |
| Gateway 배치 | **본인 운영 원격 Gateway에 연결이 기본**. 플러그인은 Gateway 호스트에 설치되어 우리 서버의 브리지로 아웃바운드 WSS 접속. 로컬 개발용 Compose 프로필로 동반 기동도 지원 |
| 버전 정책 | `@openclaw/gateway-client`·`@openclaw/gateway-protocol`·`openclaw`(플러그인 SDK)를 **Gateway와 같은 버전으로 정확히 핀**. 시작 버전 2026.9.4, 프로토콜 v4 |
| 산출물 | 마크다운 계획서 (본 문서) + 구성 가이드(`docs/project-structure.md`), 저장소에 저장 |

---

## 2. 요구사항 정리

### 2.1 기능 요구사항

| ID | 요구사항 | MVP | 비고 |
| --- | --- | --- | --- |
| F-1 | OpenClaw 에이전트 연동 (메시지 송수신, 세션 유지) | ✅ | 하이브리드 구조 |
| F-2 | 채널 생성/관리로 대화 주제 분리 | ✅ | 워크스페이스 > 채널 > 스레드(후속) |
| F-3 | 한 채널에 여러 에이전트 배치, 에이전트 간 소통 | ✅ | 멘션 + 릴레이 |
| F-4 | 채널별 프롬프트 (시스템 지시) | ✅ | 채널 프롬프트 + 에이전트별 채널 오버라이드 |
| F-5 | OpenClaw UI 입력 네이티브 지원 (텍스트·버튼·선택·모달) | ✅ | Discord 플러그인의 components 규약 대응 |
| F-6 | 스트리밍 채팅 (토큰 단위 델타) | ✅ | Gateway `chat`/`agent` 이벤트 |
| F-7 | 에이전트 작업 기록(툴 호출·실행 상태) 확인 | ✅ | `agent`(`stream:"tool"`)/`session.operation` 이벤트 → 활동 패널 |
| F-8 | 실행 승인(exec approval) 응답 | ✅(기본) | 버튼으로 승인/거부 |
| F-9 | 첨부파일·이미지 | △ | MVP는 이미지 업로드/표시까지 |
| F-10 | Claude Code / Codex / Hermes 연동 | 후속 | 어댑터 인터페이스만 MVP에서 정의 |
| F-11 | 데스크톱/모바일 앱 | 후속 | PWA로 대체 |
| F-12 | 팀 워크스페이스 (멤버 초대·권한) | 후속 | 데이터 모델은 MVP부터 포함 |

### 2.2 비기능 요구사항

- **셀프호스팅 우선**: 메신저 서버(API + 웹 정적 + Caddy)는 Docker Compose로 기동한다. OpenClaw Gateway는 기본적으로 **별도 호스트에서 본인이 운영하는 원격 Gateway**에 `wss://`로 연결하고, 우리 채널 플러그인은 그 Gateway 호스트에 설치되어 우리 서버의 브리지 엔드포인트로 **아웃바운드 WSS** 접속한다. 따라서 서버의 브리지·웹·API는 리버스 프록시(TLS)로 외부에 노출되어야 한다. 로컬 개발·데모용으로 Compose 프로필에서 Gateway를 동반 기동하는 옵션도 둔다.
- **오프라인 내성**: PWA로 최근 채널 캐시, 재접속 시 `chat.history` 델타 커서로 복구.
- **확장 가능한 인증**: MVP는 단일 사용자(로컬 토큰), 이후 OIDC/이메일 로그인 추가 가능하도록 `users`/`memberships` 테이블 선반영.
- **관측성**: 에이전트 런(run) 단위로 이벤트를 저장해 사후 재생(replay) 가능.
- **비용 통제**: 에이전트 간 릴레이 턴 수 상한, 채널별 일일 런 상한(옵션).

### 2.3 범위 밖 (MVP)

음성/영상, E2E 암호화, 외부 메신저(Slack/Discord) 브리지, 플러그인 마켓, 과금.

---

## 3. 조사 결과: OpenClaw 연동 지점

OpenClaw는 단일 장기 실행 **Gateway 데몬**(기본 포트 18789)이 모든 채널·에이전트·세션을 관리하고, 타입이 있는 WebSocket API(요청/응답 + 서버 푸시 이벤트)를 제공한다. 우리 앱과 맞닿는 지점은 두 가지다.

### 3.1 Gateway 클라이언트 (WS API) — 스트리밍·작업 로그·승인용

기준 버전: `@openclaw/gateway-client` / `@openclaw/gateway-protocol` **2026.9.4** (2026-09-14 npm latest). 아래 사실은 해당 버전의 `protocol.schema.json`, 패키지 README/CHANGELOG, 공식 문서(`rpc-bootstrap-and-events`)를 대조해 확인했다.

- **프로토콜 v4** (`PROTOCOL_VERSION = 4`, `MIN_CLIENT_PROTOCOL_VERSION = 4`). 일반 클라이언트는 `minProtocol: 4, maxProtocol: 4`로 고정 협상. v5 후보 변경(`SessionsPatchMutation`의 `execSecurity/execAsk` 제거 등)은 CHANGELOG의 "Deferred to the next wire version"에 보류 중이므로, 와이어 버전 상승은 명시적 파손 이벤트로 취급한다. 패키지 버전(`YYYY.M.PATCH`)과 와이어 버전은 별개다.
- **버전 핀**: 정확 핀(`--save-exact`)하고 **배포하는 Gateway와 같은 버전**으로 맞춘다. 현재 Gateway는 2026.9.2, npm 최신은 2026.9.4 → Phase 0 첫 단계에서 Gateway를 2026.9.4로 올린 뒤 핀한다. Node `>=22.19.0` 필요.
- **핸드셰이크**: 클라이언트는 Gateway의 `connect.challenge` 이벤트를 기다린 뒤 `connect` 요청을 보낸다(`GatewayClient`가 처리, 챌린지 없는 폴백 없음). `ConnectParams`에는 `minProtocol/maxProtocol`, `client`, `caps`, `role`, `scopes`, `device`(서명된 디바이스 아이덴티티), `auth`(token / bootstrapToken / deviceToken / password 등)가 들어간다. 응답 `hello-ok`는 협상된 `protocol`, `server`, **`features` 맵(`methods`, `events`, `capabilities`)**, 초기 `snapshot`, `auth`(발급된 디바이스 토큰 — 실측은 단수 `deviceToken`이며 스키마의 복수 `deviceTokens`는 오지 않았다), `policy`(`maxPayload`, `maxBufferedBytes`, `tickIntervalMs`)를 돌려준다. **`features`는 참고 목록이지 지원의 진실이 아니다**(ADR 0001: `features`에 없는 메서드도 호출되고, 없는 메서드와 스코프 부족이 똑같이 `FORBIDDEN`/`MISSING_SCOPE`로 온다). 가용성은 호출해서 판정하고, 그 응답에는 기능만 끄고 연결은 유지한다.
- **인증·페어링**: `role: "operator"` + 스코프 `operator.read`(히스토리·세션·이벤트), `operator.write`(전송·세션 변경), `operator.approvals`(승인). **`operator.admin`(「새 대화」의 `sessions.reset`, `chat.inject`)도 함께 요청한다** — 원격이 부여하는지는 Phase 1 첫 작업에서 확인하고 거부되면 키 세대 회전으로 폴백(10장 #15). Ed25519 디바이스 아이덴티티로 챌린지에 서명 → `connect` → 원격에서는 첫 `connect`가 `NOT_PAIRED`(`details.code: "PAIRING_REQUIRED"`, `details.requestId`)로 거절되지만 **공유 토큰이 있으면 수 초 뒤 자동 승인된다**(dev 루프백 + 공유 토큰은 거절 없이 붙고 요청한 `operator.admin`까지 부여, 디바이스 토큰 미발급 — ADR 0003 2절; 원격에서 admin이 부여되는지는 미확인)(ADR 0001, `retryable:false`를 보고 포기하면 놓친다) → 2~5초 간격으로 재시도하고, 지속될 때만 사람에게 `openclaw devices approve <requestId>`를 안내 → 발급된 디바이스 토큰 저장. **디바이스 키·토큰 저장은 호스트(우리 서버)의 책임**이다 — `GatewayClient`는 `hostDeps`(`loadOrCreateDeviceIdentity`, `signDevicePayload`, `publicKeyRawBase64UrlFromPem`)를 통해서만 접근하며 OpenClaw의 로컬 자격 증명을 자동으로 읽지 않는다.
- **전송 보안**: 원격 연결은 `wss://` 필수. Node 클라이언트는 루프백·사설망·`.local`/`.ts.net`에 한해 평문 `ws://`를 허용하지만 암호화는 아니다.
- 클라이언트 capability 선언: 문서상 `tool-events`(툴 실행 실시간 이벤트), `approvals`, `session-scoped-events`. 정본은 `@openclaw/gateway-protocol/client-info`의 `GATEWAY_CLIENT_CAPS` 상수다(세 이름 모두 있음). `hello-ok.features.capabilities`는 서버 기능 플래그라 선언한 caps를 에코하지 않으며, 선언 효과는 행동으로만 드러난다(`tool-events`를 선언하면 `session.tool` 대신 `agent`로 받는다). **선언한 것은 반드시 구현**한다.
- 핵심 메서드 (스키마 존재 확인)
  - `chat.send` — 세션에 메시지 전송. 파라미터: `sessionKey`, `agentId`, `message`, **`idempotencyKey`(필수 — 응답 `runId`가 이 값과 같다)**, `mentions`, `queueMode`(`steer`/`followup`/`collect`/`interrupt`), `fastMode`, `deliver`, **`originatingChannel`/`originatingTo`/`originatingAccountId`/`originatingThreadId`**, `replyToId`, `attachments`, `timeoutMs` 등. 배달의 열쇠는 `originating*`가 아니라 **`deliver:true`**다 — `originating*`는 `operator.admin`이 필요하고 `deliver` 없이는 배달 경로가 아니며, channel-scoped 세션은 `deliver:true`만으로 세션 `deliveryContext`를 상속한다. 배달은 `sendText`(agentId·runId 없음)로 오고 턴은 owner 권한으로 돈다 → MVP에서 대체 경로로 쓰지 않는다(ADR 0003 6·7.3). 응답은 `{ runId, status: "started" }` — `messageSeq`는 여기 없고 `session.message`의 필드다. `sessions.create` 없이 `chat.send`만으로 세션이 생성된다(`sessionKey`와 `sessionId`는 다른 값).
  - `chat.history` — 표시용 정규화된 트랜스크립트. `sessionKey`, `agentId`, `cursor`, `limit`, `maxBytes` 등. 요청 파라미터는 `cursor`, 응답 필드가 `deltaCursor`이며 커서 호출은 `{kind:"delta"}` 또는 `{kind:"reset"}`. **claude-cli 세션은 `deltaCursor`가 오지 않고 커서 호출은 늘 `reset`**(CLI 바인딩 없는 세션에서만 delta). 커서 호출에서 `limit`은 무시된다. 일반 응답 메시지는 전사 메시지(`__openclaw.seq`), delta 항목은 `session.message` 봉투(`messageSeq`)로 모양이 다르다(ADR 0003 5절).
  - `chat.abort` — 필수는 `sessionKey`(+`agentId`/`runId`/`preserveSideRuns`), `clearQueued` 옵션.
  - `sessions.subscribe` — 응답은 `{subscribed: true}`뿐이다(로스터 스냅샷·`inFlightRun` 없음). 로스터는 `sessions.list`, 재접속 복구는 `sessions.list` + `chat.history`(`deltaCursor` 증분은 claude-cli 세션에서 성립하지 않으므로 전체 치환이 기본, 커서는 최적화 — ADR 0003 5·7.2). `sessions.messages.subscribe({includeApprovals:true})` 응답의 `approvalReplay`가 승인 카드 복구원이다.
  - `sessions.create/patch/reset/delete`, `sessions.messages.subscribe({ includeApprovals: true })`, `sessions.title.prepare`.
  - `approval.get/resolve/history`, `exec.approval.request/get/list/resolve/waitDecision`, `exec.approvals.get/set`, `plugin.approval.list/request/waitDecision/resolve`(`get`은 없다). 승인 이력은 30일 보관, first-answer-wins.
- 핵심 이벤트
  - `chat` — 페이로드는 항상 `runId`, `sessionKey`, `agentId`, `seq`를 담고 `state`로 구분: **`delta`**(`deltaText` 증분, `message` 누적 스냅샷, `replace` 플래그), **`final`**(`message`만 — `usage`·`stopReason`·`model`·비용은 같은 시점의 `session.message`에 있다), **`status`**(`phase`, `retry`), **`error`**(`errorMessage`, `errorKind`, `errorDetail` — provider/model/httpStatus 등), **`aborted`**. 서브에이전트가 만든 런은 `spawnedBy`로 부모를 가리킨다. `seq`는 순서용이며 연속이 아니다(빠른 델타가 병합되며 건너뛴다) — 빈 칸을 유실로 보지 않는다.
  - `agent` — 런 단위 스트림(`runId`, `seq`, `stream`, `ts`, `data`, `isHeartbeat`). 재접속 후 `runId`+`seq`로 순서 복원.
  - `session.message`, `session.operation`, `session.tool`, `session.approval`, `session.observer` — 공식 문서(`rpc-bootstrap-and-events`)에 명시. `session.operation`은 현재 스키마에서 `operation: "compact"`(컨텍스트 압축)만 정의되어 있다. **툴 진행은 `agent`의 `stream: "tool"`(phase `start`/`result`)로 받는다** — `tool-events`를 선언한 연결(= `chat.send`를 보낸 우리 연결)은 `session.tool` 수신 대상에서 제외된다(ADR 0001 5.3). `features.events`에는 `mentions.changed`도 있다(멘션 릴레이 설계에서 확인). 이벤트명 목록은 `hello-ok.features.events`(60개)로 보되 참고 목록으로 다룬다.
  - 시스템: `presence`, `tick`, `health`, `heartbeat`, `shutdown`. 이벤트 프레임은 `seq`·`stateVersion`을 실을 수 있다.

### 3.2 채널 플러그인 — 라우팅·UI 컴포넌트·채널 프롬프트용

- 진입점: 권장은 `defineChannelPluginEntry({ plugin, setRuntime })`(`openclaw/plugin-sdk/plugin-entry`; `definePluginEntry` + `registerChannel` 도 동작하지만 감싼 형태가 표준, ADR 0002 3.1). 매니페스트(`openclaw.plugin.json`)에 `channels`·`channelConfigs`, `package.json` 에 `openclaw.channel` 을 두고 **런타임 dependencies 없이 단일 번들**로 배포한다. 플러그인 SDK는 `openclaw` 패키지의 `./plugin-sdk/*` 서브패스로 제공되며, 관련 진입점으로 `channel-message`(`ChannelMessageActionAdapter`), `channel-contract`, `channel-config-schema`(채널 설정 스키마 빌더), `channel-mention-gating`, `channel-inbound`/`channel-outbound`, `channel-reply-pipeline`, `channel-streaming-config`, `discord`(컴포넌트 빌더 `buildDiscordComponentMessage`, `DiscordComponentMessageSpec` 참조용)가 있다. `openclaw` 패키지는 unpacked 200MB급이므로 플러그인 패키지의 devDependency로만 두고 Gateway와 같은 버전으로 핀한다.
- 코어가 공용 `message` 툴·프롬프트 배선·세션 관리를 소유하고, 채널 플러그인은 **액션 디스커버리·capability·채널 고유 스키마 조각**만 담당(`ChannelMessageActionAdapter.describeMessageTool`). 즉 Discord의 `components`처럼 **우리 채널만의 UI 스키마를 message 툴에 끼워 넣을 수 있다** — 실측으로 동작한다(ADR 0002 6절: 모델이 첫 시도에 `components` 를 채워 호출). **단 SDK 방침은 provider-native 스키마 조각을 막고 `presentation` capability 를 권하므로 향후 차단 리스크가 있다**(ADR 0002 12절 결정 2).
- `accountId`, `currentChannelId`, `chatType`, `currentThreadTs`, `currentMessageId`, `sessionKey`, `sessionId`, `agentId` 는 **message 툴 디스커버리·실행 컨텍스트**에서 코어가 주는 스코프다. 인바운드는 반대로 플러그인이 `buildContext`·`dispatch` 에 `route`·`reply`·`sender` 를 **넘기는** 쪽이다(ADR 0002 4.1·5.2).
- 채널 설정 스키마에는 `ReplyToModeSchema`, `ChannelBotLoopProtectionSchema`(채널 단위 봇 루프 보호) 등이 포함된다. 봇 루프 보호는 **플러그인이 인바운드에 `botLoopProtection` 사실을 넘길 때만** 코어가 동작한다(5.3, ADR 0002 7절).
- 추가 확장점: `registerTool`(에이전트 툴), Gateway 메서드 등록, HTTP 라우트, 백그라운드 서비스, 설정 쓰기(`runtime.config.mutateConfigFile`; `channel-config-writes` 는 쓰기 **권한 판정** 모듈이지 쓰기가 아니다 — ADR 0002 8절).
- **원격 배치**: 플러그인은 Gateway 프로세스 안에서 실행되므로 Gateway 호스트에 설치한다(호스트에서 `openclaw plugins install <tarball> --force --accept-capabilities`; tarball 은 `pnpm pack` — `openclaw plugins pack` 은 채널 플러그인을 거부한다. Gateway RPC `plugins.install` 은 clawhub/official 소스만 받으므로 원격 설치는 호스트 작업이다. 안정화 후 npm `@dodok/openclaw-plugin` 퍼블리시. ADR 0002 3.3·9절). 플러그인 계정 설정에 우리 서버의 브리지 URL·토큰을 넣고, 플러그인이 **아웃바운드**로 접속한다. Gateway 호스트에서 우리 서버로의 egress만 있으면 되고, Gateway 쪽 인바운드 포트를 추가로 열 필요는 없다.

### 3.3 Discord 플러그인의 인터랙티브 UI 규약 (우리가 미러링할 대상)

- 에이전트는 `message` 툴에 `components` 페이로드를 붙여 전송: `{ channel: "discord", action: "send", to, message: "fallback", components: { reusable, text, blocks: [...], modal: {...} } }`.
- 블록 종류: 텍스트 섹션, 구분선, **액션 로우(버튼 최대 5개 또는 셀렉트 1개)**, 미디어 갤러리, 파일, **모달(필드 최대 5개)**.
- 버튼: 이모지·링크 변형, 스타일 `success`/`danger`/기본, `allowedUsers`로 사용자 제한.
- 셀렉트: `string`/`user`/`role`/`mentionable`/`channel`, 옵션 최대 25개.
- 모달 필드: `text`/`checkbox`/`radio`/`select`/`role-select`/`user-select`. 트리거 버튼 자동 생성.
- 사용자의 상호작용 결과는 **일반 인바운드 메시지로 에이전트에게 되돌아감**(replyToMode 준수). 기본 1회용, `reusable: true`면 만료까지 반복. 콜백 TTL 기본 30분, 최대 24시간.
- 실행 승인: `channels.discord.execApprovals.{enabled, approvers, target}` — 버튼 기반 승인, 승인자만 상호작용 가능.
- 채널 단위 설정: `guilds.<id>.requireMention`, `channels.<id>.requireMention`, `channels.<id>.systemPrompt`, `channels.<id>.skills`, `channels.<id>.users`, `replyToMode`(`off|first|all|batched`). → 우리 플러그인도 같은 형태의 채널별 설정을 갖추면 "채널별 프롬프트"(F-4)와 "멘션 게이트"(F-3)를 OpenClaw 관례대로 구현할 수 있다.

### 3.4 멀티에이전트

- `agents.entries[]`에 `agentId`별로 워크스페이스(SOUL.md, AGENTS.md)·상태 디렉터리·세션 스토어(SQLite) 분리. `openclaw agents add <id>`.
- 바인딩: `{ agentId, match: { channel, accountId, peer } }`, **가장 구체적인 매치 우선**(exact peer → parent peer → wildcard → guild+roles → guild → team → account → channel → default).
- 세션 키: DM은 `agent:<agentId>:main`, 그룹은 채널/피어 기반 키.
- 에이전트 간 소통: `tools.agentToAgent.allow`로 허용 쌍 제한, `sessions_send/list/history` 툴, 서브에이전트 위임(코디네이터→스페셜리스트 프리셋).
- Gateway 요청에서 `agentId`를 지정하면 바인딩을 우회해 특정 에이전트에 직접 전달 가능.

### 3.5 후속 연동 대상 요약

| 대상 | 연동 경로 (예상) | 비고 |
| --- | --- | --- |
| Claude Code | Claude Agent SDK (TS/Python) — 스트리밍 메시지·툴 이벤트·권한 콜백 | 로컬 프로세스 실행 필요 |
| Codex | `codex app-server`(JSON-RPC, 공개 프로토콜; TS 클라이언트 존재) 또는 Codex SDK | 로컬 프로세스 |
| Hermes Agent | 자체 메시징 게이트웨이(30+ 플랫폼) + OpenAI 호환 API 서버 | 커스텀 어댑터 문서 부재, 조사 필요 |

---

## 4. 아키텍처

### 4.1 구성도

```mermaid
flowchart LR
  subgraph Client["웹앱 / PWA (React + Vite)"]
    UI[채널 UI · 스트리밍 뷰 · 활동 패널 · 컴포넌트 렌더러]
  end

  subgraph Server["dodok 서버 (Node/TS, 셀프호스팅, Caddy TLS)"]
    API[REST + Socket.IO 허브]
    Router[채널 라우터<br/>멘션 파싱 · 릴레이 · 루프 가드]
    Adapters[에이전트 어댑터 레이어]
    OCAdapter[OpenClaw 어댑터]
    Bridge[플러그인 브리지 엔드포인트<br/>/bridge · WSS · 토큰]
    DB[(SQLite → Postgres)]
  end

  subgraph OpenClaw["OpenClaw Gateway (원격 호스트, 본인 운영)"]
    Plugin[dodok 채널 플러그인<br/>registerChannel + components 스키마]
    Agents[에이전트 A / B / C<br/>agents.entries]
    WS[Gateway WS API v4]
  end

  UI <-- "Socket.IO / HTTP" --> API
  API --> Router --> Adapters --> OCAdapter
  OCAdapter --- Bridge
  Plugin -- "아웃바운드 WSS 접속<br/>인바운드 전달 · message 툴 아웃바운드 · 컴포넌트 결과" --> Bridge
  Plugin --> Agents
  OCAdapter -- "operator 클라이언트 (wss)<br/>chat.send · chat.history · session.* · approvals" --> WS
  WS --> Agents
  API --> DB
```

### 4.2 두 경로의 역할 분담

| 관심사 | 채널 플러그인 경로 | Gateway 클라이언트 경로 |
| --- | --- | --- |
| 사용자 메시지 → 에이전트 | ✅ 인바운드 (바인딩·멘션 게이트 활용) | 대체 경로는 MVP 미사용 — `deliver:true`로 배달은 되지만 agentId·runId 없는 `sendText`이고 owner 권한 턴이 된다(ADR 0003 6·7.3) |
| 에이전트 최종 응답 | ✅ 아웃바운드 (`message` 툴) | `chat` 이벤트 `state: final`의 `message` 스냅샷으로도 수신 |
| 버튼/셀렉트/모달 | ✅ 우리 채널의 `components` 스키마 | — |
| 토큰 스트리밍 | 편집 기반(제한적) | ✅ `chat` `state: delta`의 `deltaText` / `agent` 이벤트 |
| 툴 실행 로그 | — | ✅ `agent`(`stream:"tool"`), `session.operation`(압축) |
| 실행 승인 | 플러그인 approval 버튼 가능 | ✅ `approval.*`, `exec.approval.*`, `session.approval` |
| 세션 히스토리 복구 | — | ✅ `chat.history` 전체 치환(claude-cli), `deltaCursor`는 CLI 바인딩 없는 세션에서만 최적화(ADR 0003 5절) |

플러그인이 "정식 채널"이 되면 OpenClaw 입장에서 우리 앱은 Discord와 같은 위치가 되어, 바인딩·그룹 정책·컴포넌트·승인 설정을 기존 문서 그대로 재사용할 수 있다. Gateway 클라이언트는 여기에 실시간성과 관측성을 더한다.

### 4.3 메시지 흐름 (예: 사용자가 `@researcher` 멘션)

1. 클라이언트가 Socket.IO로 메시지 전송 → 서버가 저장(`messages`) → 채널 룸 구독자에게 브로드캐스트.
2. 채널 라우터가 멘션을 파싱해 대상 에이전트(`researcher`)를 결정. 채널 프롬프트 + 에이전트별 오버라이드를 컨텍스트로 합성.
3. OpenClaw 어댑터가 브리지(플러그인이 열어 둔 WSS 연결)로 인바운드 전달(`peer = channel:<id>`, `agentId = researcher`).
4. 동시에 Gateway 클라이언트가 해당 세션 키의 `chat`/`agent`(`stream:"tool"`) 이벤트를 구독 → 델타·툴 이벤트를 `runs`/`run_events`에 저장하며 클라이언트에 실시간 릴레이.
5. 에이전트가 `message` 툴로 최종 응답(선택적으로 `components`) 전송 → 플러그인 → 브리지 → 서버 → 메시지 확정, 스트리밍 버퍼를 최종 본문으로 교체.
6. 응답에 `@planner` 멘션이 있으면 라우터가 릴레이 규칙 검사 후 2단계부터 반복. 턴 카운터가 상한에 도달하면 "사람 개입 필요" 시스템 메시지로 종료.
7. 사용자가 버튼 클릭 → 서버가 `component_interactions` 저장 → 브리지로 플러그인에 전달 → 인바운드 메시지로 변환해 원래 에이전트에게 전달(Discord 규약과 동일).

### 4.4 재접속·복구

- 클라이언트: 마지막 `messageSeq`를 보관, 재접속 시 서버에 이후 메시지 요청.
- 서버 ↔ Gateway: 재접속을 "새 프로젝션"으로 취급 — `sessions.subscribe` 재수립 → 선택 세션 `chat.history` 치환(커서는 최적화, `reset`이면 전체 치환) → `inFlightRun` 채택(응답 필드는 스키마에 있으나 미관찰, ADR 0003 5.1) → 이후 `agent` 이벤트를 `runId`+`seq`로 정합.
- 플러그인 ↔ 서버 브리지: 플러그인이 지수 백오프로 재접속. 끊긴 동안의 아웃바운드(에이전트 응답·컴포넌트 결과)는 플러그인 쪽 큐에 보관 후 재전송, 서버는 `runId`/메시지 id로 중복 제거.

### 4.5 배포 토폴로지

| 구성 요소 | 위치 | 노출 |
| --- | --- | --- |
| dodok 서버(API·Socket.IO·브리지)·웹 정적·Caddy | 본인 서버 A (Docker Compose) | Caddy가 TLS로 `/`(웹), `/api`, `/socket.io` 노출(브리지는 Socket.IO 네임스페이스 `/bridge` 라 `/socket.io` 하나로 충분 — ADR 0002) |
| OpenClaw Gateway + dodok 플러그인 + 에이전트 | 본인 서버 B (원격, 이미 운영 중) | 우리 서버가 `wss://`로 접속. 플러그인은 `/bridge`로 아웃바운드 접속. 추가 인바운드 포트 불필요 |
| 로컬 개발 | 개발 PC | 서버는 `pnpm dev`. Gateway는 원격에 붙거나 Compose `--profile gateway`로 로컬 기동. 원격 플러그인이 개발 PC의 브리지에 붙어야 할 때는 터널(cloudflared/tailscale 등)로 `BRIDGE_PUBLIC_URL`을 만든다 |

A와 B가 같은 호스트여도 되며, 그 경우 Compose 프로필 하나로 함께 띄운다.

---

## 5. 핵심 설계

### 5.1 도메인 모델

- **Workspace**: 최상위 컨테이너. MVP는 1개 자동 생성. 팀 전환 시 다수.
- **User / Membership**: MVP는 owner 1명. `role`(owner/admin/member/guest)을 미리 둔다.
- **Agent**: 워크스페이스에 등록된 에이전트 프로필. `provider`(openclaw/claude/codex/hermes), `providerAgentId`(OpenClaw `agentId`), 표시 이름, 아바타, 기본 프롬프트, 활성 여부.
- **Channel**: 주제 단위. `prompt`(채널 프롬프트), `relayPolicy`(최대 릴레이 턴, 허용 에이전트 쌍), `visibility`.
- **ChannelMember**: 사람 또는 에이전트의 채널 참여. 에이전트인 경우 `promptOverride`, `mentionAliases`, `autoRespond`(멘션 없이도 응답할지, 기본 false).
- **Message**: `author`(user|agent|system), 본문(마크다운), 첨부, `components`(렌더용 JSON), `replyTo`, `runId`(에이전트 메시지일 때), `seq`.
- **Run**: 에이전트 1회 실행. `sessionKey`, `providerRunId`, 상태(queued/streaming/tool/awaiting_approval/done/error/aborted), 토큰·비용 메타.
- **RunEvent**: 런의 이벤트 로그(델타·툴 시작/종료·승인 요청/결정·에러). 활동 패널과 재생의 원천.
- **ComponentInteraction**: 버튼/셀렉트/모달 제출 기록. `componentId`, `userId`, `payload`, `deliveredToAgentAt`.
- **Approval**: OpenClaw approval id 미러. 상태·결정자·만료.

### 5.2 채널 프롬프트 합성 규칙

에이전트가 채널에서 메시지를 받을 때 컨텍스트 = `[채널 프롬프트] + [해당 에이전트의 채널 오버라이드] + [채널 참여자 목록(사람/에이전트, 멘션 방법)] + [릴레이 규칙 요약]`. OpenClaw 에이전트 자체의 SOUL.md/AGENTS.md는 건드리지 않는다.

주입 경로는 두 가지 후보가 있다. (a) Discord 플러그인이 지원하는 채널별 설정(`channels.<id>.systemPrompt`, `channels.<id>.requireMention`, `channels.<id>.skills`)과 같은 형태로 우리 플러그인 설정에 채널 프롬프트를 두고, 앱에서 프롬프트가 바뀌면 Gateway 설정을 갱신하는 방식. (b) 플러그인 인바운드 메시지에 **채널 컨텍스트 프리픽스**로 붙이는 방식. (a)가 OpenClaw 관례와 맞아 기본안으로 하되 — 단 **claude-cli 백엔드에서는 CLI 세션 시작 시점에만 들어가고 드리프트·Gateway 재시작으로 갱신되지 않는다**(ADR 0003 3절; 기존 세션 반영은 리셋·키 회전 또는 인바운드 (b)/(c) `ChannelPromptContext`) — 에이전트별 오버라이드처럼 동적인 부분은 (b)로 보완한다.

Gateway가 원격이므로 (a)의 "설정 갱신"은 우리 서버가 직접 파일을 만질 수 없다. 후보는 두 가지: (a-1) 서버가 브리지로 플러그인에 "채널 설정 변경"을 보내고 **플러그인이 `runtime.config.mutateConfigFile` 로 Gateway 설정을 갱신**(`channel-config-writes` 는 권한 판정 모듈), (a-2) Gateway WS의 설정 메서드를 operator 클라이언트로 호출. (a-1)이 플러그인 하나로 닫혀 단순하므로 기본안이다. 스파이크 2 미리보기(ADR 0002 8절): 반영은 `applied: "live"`(재시작 불필요)이고 **새 세션에는 들어가지만 claude-cli 의 기존 세션에는 두 턴 연속 반영되지 않았다** — 기존 세션 갱신은 스파이크 3에서 쟀다: `sessions.reset` = 반영, Gateway 재시작 = 미반영, 다른 백엔드 = 미측정. 원인은 Claude CLI가 `--resume` 시 세션 생성 때의 `prompt_snapshot`으로 재개하는 것(추정, ADR 0003 3.2). 권고는 (a) 기준선 + 서버가 세션 시작 리비전을 기억해 현재와 다르면 `ChannelPromptContext`로 동봉(ADR 0003 7.1, 결정 대기).

### 5.3 멀티에이전트 발언 규칙 (멘션 + 자동 릴레이)

- 사람 메시지: `@에이전트` 멘션된 대상만 응답. 멘션이 없으면 `autoRespond=true`인 에이전트(채널당 최대 1개 권장)만 응답.
- 에이전트 메시지 안의 `@다른에이전트`: 라우터가 릴레이. 조건 — `relayPolicy.allowPairs`에 포함, 현재 대화 스레드의 릴레이 턴 수 < `maxRelayTurns`(기본 4), 동일 (from,to,본문 해시) 반복 감지 시 차단.
- 상한 도달 시: 시스템 메시지 "릴레이 한도 도달 — 계속하려면 사람이 멘션하세요" + 이어가기 버튼.
- **OpenClaw 내부 에이전트 간 통신(`sessions_send`)은 MVP에서 차단 (결정됨)**. 이유와 설정은 5.8 참고. 같은 에이전트가 자기 작업을 쪼개는 서브에이전트(`sessions_spawn`)는 허용하되, 자식 세션은 활동 패널에서 "하위 작업"으로 표시(`chat` 이벤트의 `spawnedBy`로 식별).
- **OpenClaw 채널 봇 루프 보호와의 관계**(ADR 0002 7절 실측): 코어 보호는 **플러그인이 에이전트 작성 인바운드에 `botLoopProtection` 사실을 넘길 때만** 동작한다 — 넘기지 않으면 기본값은 릴레이를 막지 않는다. 넘기면 기본 예산 20회/60초·쿨다운 60초이고, 초과 시 인바운드는 런 없이 `admission: drop, reason: bot-loop-protection` 으로 떨어지며(브리지 ack 는 `{}`), `enabled: false` 로 즉시 해제된다. 권고안은 (2) 사실을 넘기되 코어 예산을 우리 `maxRelayTurns` 보다 느슨하게 두어 안전망으로만 쓰는 것이며, drop 사유를 브리지 계약에 싣는 것까지 함께 정한다(ADR 0002 12절 결정 3·4).

### 5.4 네이티브 UI 컴포넌트 규약 (`components` v1)

Discord 플러그인 규약을 상위 집합으로 미러링하되, Discord 전용 타입(role/channel/mentionable select)은 제외하고 웹에 맞는 타입을 추가한다.

```jsonc
{
  "components": {
    "reusable": false,
    "ttlMs": 1800000,          // 기본 30분, 최대 24h
    "text": "어떤 방식으로 진행할까요?",
    "blocks": [
      { "type": "section", "text": "**옵션을 선택하세요**" },
      { "type": "separator" },
      { "type": "actions", "items": [
        { "type": "button", "id": "go_fast", "label": "빠르게", "style": "primary", "emoji": "⚡" },
        { "type": "button", "id": "go_safe", "label": "안전하게", "style": "success" },
        { "type": "button", "id": "cancel",  "label": "취소",    "style": "danger",
          "allowedUsers": ["user_123"] }
      ]},
      { "type": "actions", "items": [
        { "type": "select", "id": "target", "placeholder": "대상 선택", "multi": false,
          "options": [ { "value": "web", "label": "웹" }, { "value": "api", "label": "API" } ] }
      ]},
      { "type": "media", "items": [ { "url": "artifact://img_1", "alt": "미리보기" } ] },
      { "type": "file", "url": "artifact://report.pdf", "name": "report.pdf" }
    ],
    "modal": {
      "id": "details", "title": "세부 정보", "triggerLabel": "입력하기",
      "fields": [
        { "type": "text", "id": "title", "label": "제목", "required": true },
        { "type": "textarea", "id": "desc", "label": "설명" },
        { "type": "select", "id": "priority", "label": "우선순위",
          "options": [ { "value": "p1", "label": "높음" }, { "value": "p2", "label": "보통" } ] },
        { "type": "checkbox", "id": "notify", "label": "완료 시 알림" }
      ]
    }
  }
}
```

제약: 액션 로우당 버튼 ≤ 5 또는 셀렉트 1, 셀렉트 옵션 ≤ 25, 모달 필드 ≤ 5 (Discord와 동일하게 두어 에이전트 프롬프트 호환성 유지). 웹 추가 타입: `textarea`, `date`, `number`, `multi select`. 상호작용 결과는 `{ componentId, blockId, values, userId }`를 사람이 읽을 수 있는 텍스트로 변환해 인바운드 메시지로 에이전트에게 전달하고, 원본 JSON은 `component_interactions`에 저장.

### 5.5 스트리밍

- 서버는 Gateway `chat` 이벤트(`state: delta`)의 `deltaText`를 런별 버퍼에 누적하며 클라이언트에 `run.delta` 이벤트로 중계. `replace` 플래그가 오면 버퍼를 `message` 스냅샷으로 치환. 클라이언트는 임시 "스트리밍 메시지 버블"에 렌더.
- 에이전트 최종 응답이 플러그인 경로로 도착하면 버블을 확정 메시지로 교체(본문은 플러그인 경로 기준, 중복 방지 키 = `runId` — `replyOptions.runId` 로 Gateway runId 가 우리 runId 와 같아진다, ADR 0002 4.3). `message` 툴로 답한 런은 최종 텍스트가 `terminalReply.disposition: "silent"` 로 억제되는데 그 전에 `chat` delta 가 한두 조각 샐 수 있으므로, `final`/lifecycle 로 silent 가 확정되면 미리보기 버블을 지운다(ADR 0002 5.2). 플러그인 경로가 일정 시간 내 도착하지 않으면 `state: final`의 `message` 스냅샷으로 확정하고 "미리보기 기준" 표시.
- `state: error`/`aborted`는 런 상태를 갱신하고 버블에 오류/중단 표시.
- 백프레셔: 델타를 50ms 단위로 코얼레싱, 클라이언트당 미전송 큐 상한. Gateway `hello-ok.policy.maxBufferedBytes`를 존중.
- 중단: 사용자의 "중지" → `chat.abort({ key, runId })`.

### 5.6 작업 기록(활동 패널)

- `agent` `stream:"tool"`(툴 호출 start/result·인자·결과 요약), `agent` 이벤트의 `stream`별 데이터, `session.operation`(현재는 컨텍스트 압축 `compact`), `exec.*` 노드 이벤트(명령·exitCode·bounded output)를 `run_events`로 저장.
- UI: 메시지 옆 "작업 보기" 토글 → 타임라인(툴명·소요시간·상태·접힌 상세). 런 목록 뷰에서 채널 전체 활동을 시간순으로 확인.
- 승인 요청은 활동 패널과 채널 본문 양쪽에 버튼 카드로 노출, `approval.resolve`로 응답. Gateway 쪽 30일 보관과 별도로 우리 DB에 미러.
- 주의: 노드 exec 이벤트는 best-effort(내구성 있는 원장이 아님) — 누락 가능성을 UI에 표기.

### 5.7 에이전트 어댑터 인터페이스 (후속 연동 대비)

```ts
interface AgentAdapter {
  id: "openclaw" | "claude" | "codex" | "hermes";
  connect(config): Promise<void>;
  listAgents(): Promise<AgentProfile[]>;
  send(input: { agentId; channelId; sessionKey; text; context; attachments? }): Promise<{ runId }>;
  abort(runId): Promise<void>;
  onEvent(handler: (e: RunEvent) => void): Unsubscribe;   // delta | tool | approval | final | error
  resolveApproval?(approvalId, decision): Promise<void>;
  deliverInteraction(runIdOrSession, interaction): Promise<void>;  // 버튼/모달 결과
}
```

OpenClaw 어댑터가 첫 구현. Claude Agent SDK/Codex app-server는 로컬 프로세스 관리(spawn, 워크스페이스 경로, 권한 콜백)가 추가로 필요하므로 별도 "로컬 러너" 서비스로 분리한다.

### 5.8 OpenClaw 세션·내부 위임 설계 (결정 사항)

**세션 키 단위 — 채널당 에이전트별 1세션.** 키 형식은 OpenClaw 그룹 관례를 따른다: `agent:<agentId>:dodok:channel:<channelId>` (DM은 `agent:<agentId>:dodok:direct:<userId>`). OpenClaw에서 세션은 "에이전트별 대화 컨텍스트(트랜스크립트·컨텍스트 윈도우·압축)"이므로, 에이전트 3개가 있는 채널에는 세션도 3개다. 각 에이전트는 자기 세션에 전달된 메시지만 기억하므로, 우리 플러그인은 멘션으로 트리거된 인바운드에 **최근 채널 메시지 N개(다른 에이전트 발언 포함)를 컨텍스트 창으로 동봉**해 "같은 방에 있다"는 감각을 준다. 같은 세션에서는 런이 직렬이라 동일 에이전트를 연속 멘션하면 두 번째는 큐잉(`queueMode: followup` 기본)되고, 서로 다른 에이전트는 세션이 다르므로 병렬 실행된다. `groupScope: "main"`(에이전트 메인 세션 공유)은 채널 간 컨텍스트가 섞이므로 쓰지 않는다. 채널에서 "새 대화" 명령은 `sessions.reset`, 후속 스레드 기능은 `...:thread:<id>` 하위 세션으로 확장한다.

**내부 위임(`sessions_send`) — MVP 차단.** OpenClaw 기본값은 `tools.agentToAgent.enabled: true`, `tools.sessions.visibility: "all"`이라 아무 설정 없이 두면 에이전트가 다른 에이전트·다른 채널의 세션에 직접 메시지를 보낼 수 있다. 우리가 관리하는 OpenClaw 설정에서 `tools.agentToAgent.enabled: false`, `tools.sessions.visibility: "tree"`(자기 세션 + 자기가 스폰한 자식만; 루트 `sessions` 키는 설정 스키마가 거부한다 — ADR 0002)로 명시한다. 차단 근거: (1) 교환 내용이 채널 기록 밖에서 일어나 F-3/F-7의 "소통·작업 기록 확인"이 깨진다. (2) 응답 후 자동 실행되는 "announce step"이 요청자/대상 전달 컨텍스트에 답을 다시 게시하는데, 이를 끌 수 있는 설정이 없고(#7463 미해결, #105503 요청 중) 멀티에이전트 구성에서 엉뚱한 채팅에 게시되는 버그(#55981)가 보고되어 있다. (3) 루프 제한이 OpenClaw 내장 상한으로 걸려 우리 `relayPolicy`와 이중으로 동작한다. (4) 채널 A의 에이전트가 채널 B 세션을 읽을 수 있어 채널 분리 원칙과 충돌한다. 후속 단계에서 announce 비활성화 옵션이 생기면, 허용 쌍(`allow`)을 채널 `relayPolicy`와 동기화하고 `sessions_send` 툴 이벤트를 "위임 카드"로 채널에 표시하는 방식으로 재검토한다.

---

## 6. 데이터 모델 (초안)

```
workspaces(id, name, created_at)
users(id, workspace_id, email, display_name, auth_provider)
memberships(id, workspace_id, user_id, role)
agents(id, workspace_id, provider, provider_agent_id, name, avatar, base_prompt, enabled)
channels(id, workspace_id, name, topic, prompt, relay_policy_json, visibility, created_by)
channel_members(id, channel_id, member_type[user|agent], member_id, prompt_override, auto_respond, aliases_json)
messages(id, channel_id, seq, author_type, author_id, body_md, attachments_json, components_json, reply_to, run_id, created_at)
runs(id, channel_id, agent_id, trigger_message_id, session_key, provider_run_id, status, started_at, ended_at, usage_json, relay_depth)
run_events(id, run_id, seq, type, payload_json, created_at)
component_interactions(id, message_id, component_id, user_id, payload_json, delivered_at)
approvals(id, run_id, provider_approval_id, kind, status, decided_by, decided_at, expires_at)
push_subscriptions(id, user_id, endpoint, keys_json, user_agent, created_at)
```

SQLite(WAL)로 시작, Drizzle ORM으로 스키마 정의해 Postgres 전환 시 마이그레이션만 교체.

---

## 7. 기술 스택

| 레이어 | 선택 | 이유 |
| --- | --- | --- |
| 프런트 | React 19 + Vite + TypeScript, TanStack Query/Router, Zustand, Tailwind, `vite-plugin-pwa` | PWA 설치·오프라인 캐시, 이후 Tauri/Capacitor 래핑 용이 |
| 렌더링 | Streamdown(스트리밍 마크다운) + shiki(코드), 자체 컴포넌트 렌더러 | 에이전트 출력·UI 블록 |
| 백엔드 | Node 24(openclaw 2026.9.4 의 engines 에 맞춰 `mise.toml` 핀) + Fastify(REST) + **Socket.IO**(실시간; 채널 = 룸, 자동 재연결·ack), Zod 스키마 공유 | 장기 WS 연결·스트리밍에 적합, Open WebUI·OpenClaw 플러그인 사례와 동일 |
| DB | SQLite(better-sqlite3) → Postgres, Drizzle ORM | 개인→팀 전환 경로 |
| OpenClaw | `@openclaw/gateway-client`, `@openclaw/gateway-protocol`, `openclaw`(plugin-sdk) — **2026.9.4 정확 핀, Gateway와 동일 버전** | 공식 경로 |
| 모노레포 | pnpm workspaces + Turborepo: `apps/web`, `apps/server`, `packages/shared`(타입·컴포넌트 스키마·이벤트·wire 계약), `packages/openclaw-plugin`, `packages/openclaw-adapter`. npm 스코프 `@dodok/*` | 스키마 단일 소스 |
| 배포 | Docker Compose(서버 + 웹 정적 + Caddy; `--profile gateway`로 로컬 Gateway 동반 기동), 기본은 원격 Gateway 연결 | 셀프호스팅 |
| 테스트 | Vitest, Playwright(E2E), `protocol.schema.json` 기반 계약 테스트 | |

### 7.1 오픈소스 활용 맵 — 직접 만들지 않을 것

원칙: **채널·멀티에이전트 라우팅·OpenClaw 어댑터·컴포넌트 규약만 우리가 만들고**, 나머지는 검증된 오픈소스를 가져다 쓴다. 후보는 라이선스가 허용적(MIT/Apache/BSD)이고 TS 스택과 맞는 것을 우선했다.

#### (A) 베이스 앱을 포크할 것인가 → 아니오, 단 Open WebUI Channels는 벤치마크

| 후보 | 평가 | 결론 |
| --- | --- | --- |
| **Open WebUI "Channels"** | 사람+모델이 같은 채널에서 대화, `@모델` 멘션, 스레드/리액션, 스트리밍, 툴 호출·추론 블록 표시까지 이미 구현. **OpenClaw↔Open WebUI Channels 플러그인**(Skyzi000, MIT)도 존재 — OpenClaw가 봇 유저로 채널에 참여(REST+Socket.IO, 멘션 트리거, 스레드, 업로드, 타이핑 표시). | 스택이 Svelte+Python이라 우리 TS 스택과 불일치. v0.6.6부터 **브랜딩 유지 조항**(30일 내 사용자 50명 초과 시 브랜딩 제거 불가) → 팀 플랫폼 확장 시 걸림. 채널 프롬프트·에이전트 간 릴레이·버튼/모달 없음. **포크 대신 Phase 0에서 "이미 되는 것"의 기준선으로 써보고, 플러그인의 봇-인-채널 패턴(멘션·스레드·타이핑)을 우리 플러그인에 그대로 차용.** |
| Rocket.Chat / Mattermost / Zulip | 성숙한 팀 메신저지만 Meteor/Go/Python 스택, 에이전트 스트리밍·툴 로그 개념 없음, 규모가 커서 개조 비용 > 신규 구현 비용. | 베이스로 부적합. 후속 단계에 "브리지 대상"으로만 고려. |
| Revolt / Spacebar | Discord 클론(Rust/TS). UI 참고는 가능하나 에이전트 기능 전무. | UI/UX 참고용. |
| OpenClaw 커뮤니티 웹 UI (openclaw-web-ui, clawUI, openClaw-web-interface 등) | 단일 에이전트 채팅 클라이언트. Gateway 클라이언트 연결·페어링·히스토리 코드는 참고 가치 있음. | Gateway 연결 코드 참고. 채널 개념이 없어 베이스 부적합. |

#### (B) 레이어별 재사용 후보

| 레이어 | 1순위 | 대안 | 비고 |
| --- | --- | --- | --- |
| **스트리밍 마크다운 렌더** | **Streamdown**(Vercel) — react-markdown 드롭인, 미완성 마크다운 처리, Shiki 코드, KaTeX, Mermaid, `rehype-harden` 보안 | react-markdown + remark-gfm + shiki 직접 조합 | AI SDK 없이 단독 사용 가능. 스트리밍 버블·최종 메시지 모두 이걸로 |
| **AI 메시지 UI 조각** | **AI Elements**(Vercel, shadcn 레지스트리) — Message, Tool(툴 호출 카드), Reasoning, CodeBlock, PromptInput, Actions | assistant-ui(MIT, 헤드리스 프리미티브) | AI Elements는 복사-소유 방식이라 AI SDK 타입에 묶이지 않게 우리 `RunEvent`로 매핑해 사용. assistant-ui는 "단일 어시스턴트 스레드" 모델이라 멀티유저 채널과 충돌 소지 → 툴 호출 UI만 참고 |
| **기본 UI 킷** | **shadcn/ui + Radix + Tailwind**, lucide 아이콘 | Mantine | 버튼/셀렉트/모달/시트 등 `components` v1 렌더러의 재료 |
| **메시지 목록 가상화** | **TanStack Virtual**(MIT) | react-virtuoso(기본 MIT; "Message List" 제품은 상용) | 역방향 스크롤·하단 고정 처리만 직접 |
| **메시지 작성기(@멘션)** | **Tiptap**(MIT 코어) + Mention 확장 + 마크다운 직렬화 | Lexical(Meta, MIT) | 사람/에이전트 멘션 자동완성, 슬래시 커맨드, 이미지 붙여넣기 |
| **JSON → 폼/모달 렌더** | 우리 `components` 스키마를 **Zod**로 정의하고 shadcn 프리미티브로 직접 렌더(규모가 작음) | react-jsonschema-form(Apache-2.0) | 모달 필드 ≤5 제약이라 자체 렌더러가 더 가벼움 |
| **이모지/리액션** | emoji-mart | — | |
| **에이전트 이벤트 표준** | **AG-UI**(MIT) 이벤트 모델을 내부 `RunEvent` 형식으로 채택 — TEXT_MESSAGE_*, TOOL_CALL_START/ARGS/END, STATE_*, CUSTOM | 자체 정의 | OpenClaw `chat`/`agent`(`stream:"tool"`) 이벤트를 AG-UI로 정규화하면 후속 Claude/Codex/Hermes 어댑터가 같은 형식으로 합류. CopilotKit·Pydantic AI·Mastra 등 1st-party 커넥터 존재 |
| **선언적 UI 규약(후속)** | A2UI(Google, Apache-2.0) — OpenClaw도 `/__openclaw__/a2ui/` 호스팅 | — | v1은 Discord 미러링 규약으로 가고, 이후 A2UI 호환 레이어 검토 |
| **실시간 전송** | **Socket.IO**(MIT) — 룸, 자동 재연결, ack, 바이너리 (확정) | `ws` + 자체 프로토콜 | Open WebUI·OpenClaw 플러그인 사례와 동일. 채널 = 룸 |
| **HTTP/검증** | Fastify + Zod(스키마 공유) | Hono | |
| **DB/ORM** | Drizzle + better-sqlite3 → Postgres | Prisma | |
| **인증** | **Better Auth**(MIT) — 이메일/패스키/OIDC·SSO, **조직·팀·멀티테넌트 플러그인**, Drizzle 어댑터 | Auth.js | MVP는 단일 사용자로 두되 팀 확장 시 재작업 없이 켤 수 있음 |
| **PWA·푸시** | **vite-plugin-pwa + Workbox**(서비스워커·오프라인 캐시), **web-push**(Node, VAPID) | — | iOS는 홈 화면 설치 PWA에서만 푸시 가능(16.4+) → 설치 안내 UI 필요 |
| **파일 업로드** | Uppy(MIT) 또는 단순 multipart + sharp 썸네일 | tus 재개 가능 업로드 | MVP는 단순 multipart |
| **검색** | SQLite FTS5 → Postgres tsvector | Meilisearch | 후속 |
| **로깅/관측** | pino, OpenTelemetry | — | |
| **OpenClaw 연동** | `@openclaw/gateway-client`, `@openclaw/gateway-protocol`, `openclaw/plugin-sdk/*`; **Discord 플러그인 소스**(components 구현 참조), **openclaw-open-webui-channels**(봇-인-채널 패턴 참조) | — | 2026.9.4 핀 |
| **데스크톱/모바일(후속)** | Tauri(데스크톱), Capacitor(모바일) | Electron / React Native | 같은 웹 번들 재사용 |

#### (C) 직접 만드는 것 (차별점)

채널·멤버십·에이전트 도메인 모델, 멘션 라우터와 릴레이 루프 가드, OpenClaw 채널 플러그인(+ `components` 스키마 조각, 브리지 클라이언트), OpenClaw 어댑터(브리지 서버 + Gateway 클라이언트 이벤트 정규화), `components` v1 렌더러, 활동 패널(런 타임라인), 승인 카드.

---

## 8. 로드맵

### Phase 0 — 검증 스파이크 (1주)

목표: 하이브리드 구조가 **원격 Gateway** 배치에서 실제로 동작하는지 최소 코드로 확인.

- **준비**: 원격 Gateway를 2026.9.4로 업그레이드하고 세 패키지를 같은 버전으로 핀. 에이전트 2개(`agents.entries`) 구성. `tools.agentToAgent.enabled: false`, `tools.sessions.visibility: "tree"` 적용.
- **스파이크 1 (Gateway 클라이언트)**: `@openclaw/gateway-client`로 `wss://` 접속 → 디바이스 페어링(`openclaw devices approve`) → `hello-ok.features`(methods/events/capabilities) 덤프 → `chat.send` → `chat` 델타(`state: delta`) 수신 → `session.tool` 이벤트 수신 콘솔 출력. 산출: 프로토콜 매핑 표(문서상 이름 vs 실제 features). → **완료** (`docs/adr/0001-gateway-client-spike.md`): 페어링은 자동 승인이라 `devices approve` 불필요, 툴 이벤트는 `session.tool` 대신 `agent` `stream:"tool"`, `runId = idempotencyKey`.
- **스파이크 2 (채널 플러그인)**: 스켈레톤 플러그인(`registerChannel`)을 원격 Gateway 호스트에 설치(tarball), 개발 PC의 브리지에 터널로 아웃바운드 접속. 인바운드를 받고 `message` 툴로 아웃바운드하는지, `components` 스키마 조각을 message 툴에 노출할 수 있는지 확인. 릴레이 시나리오로 `ChannelBotLoopProtection` 기본값이 우리 릴레이를 막는지 확인(5.3). **막히면 대안**: `registerTool("ui_render")`. → **완료** (`docs/adr/0002-channel-plugin-spike.md`, 로컬 dev Gateway 2026.9.4 로 실측 — 원격 설치 경로가 없어 호스트 배포는 9절의 사람 절차로 남김): 인바운드·`message` 툴 아웃바운드·`components` 조각 모두 동작, 봇 루프 보호는 플러그인이 사실을 넘길 때만 동작, `systemPrompt` 설정 쓰기는 live 이나 기존 claude-cli 세션엔 미반영.
- **스파이크 3 (채널 프롬프트)**: 5.2의 (a-1) 플러그인 내부 설정 쓰기 경로로 `channels.dodok.channels.<id>.systemPrompt` 갱신 → 반영 지연·재시작 필요 여부 확인. 실패 시 (a-2) 또는 (b). → **완료** (`docs/adr/0003-channel-prompt-spike.md`): 설정 쓰기는 live 이지만 claude-cli 기존 세션은 리셋·새 키에서만 반영, 인바운드 프리픽스·`ChannelPromptContext`는 매 턴 반영. (a-2)도 같은 GroupSystemPrompt라 기존 세션 문제를 풀지 못한다.
- **대체 경로 확인**: `chat.send` + `originatingChannel: "dodok"`으로 보낸 메시지의 응답이 플러그인 아웃바운드로 도착하는지. → **완료** (ADR 0003 6절): `deliver:true`면 도착하지만 agentId·runId 없는 `sendText` — MVP 미사용 권고.
- 벤치마크: Open WebUI Channels + openclaw-open-webui-channels 플러그인을 띄워 "이미 되는 것/안 되는 것"을 체험하고 UX 기준선으로 기록.
- 산출: 스파이크 리포트(`docs/adr/` 한 장씩) + 확정된 프로토콜 매핑 표.

### Phase 1 — MVP 코어 (3~4주)

- **시작 전 정리**(10장 #14·#18·#19): 플러그인의 스파이크용 `:g<N>` 세대 회전·`inboundChannelPrompt` 설정 키 제거, `context.channelPrompt`·`promptOverride` 는 `ChannelPromptContext` 로, 브리지 계약 `InboundDeliverResult` 에 `admission`·`reason` 추가. → **완료**(서버, 2026-09-15).
- **첫 작업**(10장 #15): Gateway 클라이언트가 `operator.admin` 을 포함해 접속했을 때 원격이 부여하는지 확인. 거부되면 「새 대화」는 키 세대 회전으로 폴백(ADR 0003 7.1 대안). → **완료**(서버, 2026-09-15).
- 모노레포·DB 스키마·인증(로컬 토큰). → **완료**(서버, 2026-09-15).
- 채널 CRUD, 메시지 저장/브로드캐스트, 마크다운 렌더. → 채널 CRUD·메시지 저장/브로드캐스트 **완료**(서버, 2026-09-15). 마크다운 렌더 → **완료**(웹, 2026-09-20) — Streamdown(원시 HTML 끔), 멘션 칩, 단일 개행은 줄바꿈, 마크다운 이미지는 불러오지 않고 링크로. 코드 하이라이트·CJK 강조 경계는 Phase 2(아래 「이월」).
- OpenClaw 어댑터: 브리지 서버 + Gateway 클라이언트, 재접속 복구(서버↔Gateway, 플러그인↔브리지 양쪽). → **완료**(서버, 2026-09-15) — dev Gateway 실연 `docs/guides/live-smoke.md`.
- 스트리밍 버블, 중지 버튼. → **완료**(웹, 2026-09-20) — 런 상태별 버블(대기·스트리밍·종료 문구), 버블 안 중지 버튼과 작성기 `/stop`.
- 에이전트 등록 UI(OpenClaw `agentId` 매핑), 채널에 에이전트 추가, 채널 프롬프트/오버라이드 편집. → **완료**(웹, 2026-09-20) — 「Gateway 에서 가져오기」·직접 입력, 채널 설정 패널(기본·프롬프트·멤버·에이전트별 오버라이드·자동 응답·릴레이 정책)·「새 대화」.
- 멘션 파싱 + 자동 릴레이 + 루프 가드. → **완료**(서버, 2026-09-15).
- **완료 기준**: 채널 하나에서 사람 1명 + 에이전트 2개가 멘션으로 3턴 이상 협업하는 시나리오가 E2E 테스트로 통과. → **확인**(2026-09-20): 서버는 통합 시나리오 1~8(실제 어댑터 + 가짜 Gateway·플러그인, `apps/server/test/integration/`)과 dev Gateway 실연 6런(`docs/guides/live-smoke.md` 5절), 웹은 `pnpm -F @dodok/server dev:fake` 위 브라우저 검증 시나리오 5(사람 → `@dev` → dev 답의 `@fin` 릴레이 → 턴 상한 → 「이어가기」로 이어짐)가 **결함 0** 으로 통과했다. 웹은 E2E 테스트 파일을 남기지 않는 것이 설계 결정이라(스펙 10.2) 근거는 워커 검증 보고서다(`.superpowers/sdd/2026-09-19-web-mvp/web-t13*.md`, git 제외). 실물 dev Gateway·실제 플러그인·실제 모델로 같은 흐름을 도는 것도 **마쳤다**(2026-09-20, 런 4 — 멘션·릴레이·「이어가기」 카드 통과, 앱 결함 0. 중지만 계측 문제로 미확인: `docs/guides/live-smoke.md` 7절).

### Phase 2 — 인터랙티브 UI·작업 기록 (2~3주)

- `components` v1 렌더러(버튼·셀렉트·모달·미디어·파일), 상호작용 → 인바운드 변환, TTL·reusable·allowedUsers. (Phase 1 은 `actions` 블록의 버튼만 그린다 — 나머지는 자리표시 한 줄.) → **완료**(2026-09-22, dev Gateway 실연 2026-09-23 — `docs/guides/live-smoke.md` 10절) — 스펙 `docs/superpowers/specs/2026-09-21-components-v1-design.md`(설계와 달라진 것은 11장), 계획 `docs/superpowers/plans/2026-09-21-components-v1.md`.
  웹 `features/components/` 가 블록 5종(`section`·`separator`·`actions`·`media`·`file`)과 셀렉트(단일=라디오·다중=체크박스, 「보내기」로 확정)·모달(필드 7종, 화면 검사, ack 오류는 대화상자 안)을 그린다. 자리표시 한 줄은 없어졌다.
  누가 무엇을 보냈는지는 카드 안 **결과 줄**로 남는다 — 서버가 `Message.interactions`(최신 20건)를 wire 팬아웃과 `listMessages` 에서 하이드레이션하므로 새로고침·새 탭에서도 보이고, 상호작용마다 `message.updated` 가 나가 reusable 카드도 실시간으로 는다.
  `media` 는 `https://` 이미지를 `no-referrer`·`lazy` 로 불러오고(드러나는 것은 스펙 결정 8), `artifact://` 는 그때 media·file·링크 버튼 모두 「첨부는 곧 지원합니다」 자리표시였고, 아래 「이미지 첨부」(Phase 2 ③)가 같은 메시지의 첨부로 풀었다. 비활성 사유는 컨트롤 옆 보이는 글로 말한다. 「이어가기」 시스템 카드도 같은 렌더러를 탄다.
  「이월」의 초점·타이머 셋(D6 카운트다운 · 자리값 소요 · 넓은 화면 「설정 닫기」 초점)도 이때 정리했다. 의존성 추가 0(새 UI 래퍼는 `ui/radio-group.tsx` 하나), `packages/shared/src/components/` 는 한 줄도 안 바꿨다.
  **확인 방법**: 통합 시나리오 10a~10g(`apps/server/test/integration/components.test.ts` — 셀렉트·모달 → 그 에이전트의 다음 런, 결과 줄 세 경로, reusable, 상한 20, 동시 두 번, 스키마 위반 거절 · 실제 어댑터 + 가짜 Gateway·플러그인) · `pnpm -F @dodok/server dev:fake` 위 브라우저 검증 1차(시나리오 12 + 보탬 12 중 22 통과, 결함 1 — 비활성 사유가 `title`·`sr-only` 로만 있어 눈에 안 보임 → 고침 `aa0d4d8`·`4864ecb`)와 **수정 뒤 재검증 24/24·결함 0**(2026-09-22).
  재검증은 **실제 앱에서** 다섯 사유(consumed·expired·forbidden·busy·disconnected)를 버튼·셀렉트·모달 셋 모두 1280·390px 에서 눈으로 읽히는 글로 확인했고, 사유 셋이 한 줄에 섞인 경우(consumed·forbidden·`artifact://`)도 `basis-full` 로 줄마다 **24px 간격**으로 갈리는 것을 쟀다(수정 라운드는 정적 페이지로만 쟀었다). 셀렉트 스크롤 상자도 옵션 10개(재검증이 임시로 늘린 대본)에서 `scrollHeight` 250 > `clientHeight` 224 로 **실제로 스크롤되는 것**을 처음 봤다 — c2-t3 리뷰가 남긴 「대본에 7옵션 이상 셀렉트가 없어 못 잰다」가 닫혔다(정식 대본은 12개다).
  dev Gateway 실연(2026-09-23, 모델 런 3회 — `docs/guides/live-smoke.md` 10절)에서 모델은 v1 스키마에 맞는 셀렉트·모달을 냈고, 그 카드의 제출이 다음 런으로 이어졌다(Phase 2 완료 기준 — 카드는 모델이 만든 components 를 운영자 `tools.invoke` 로 대신 보냈다). 그때 모델 런 안 `message` 툴이 「bridge is not running」으로 실패한 결함 1 은 고치고 실물로 확인했다(ADR 0004, `live-smoke.md` 12절). 남은 것은 아래 「이월」.
- 마크다운 렌더 보강: 코드 하이라이트(`@streamdown/code`), 한국어 강조·구두점 경계(`@streamdown/cjk`) — 아래 「이월」의 웹 렌더. → **한국어 강조는 완료**(2026-09-20, Phase 2 ① 태스크 1). 코드 하이라이트는 번들 크기 판단이 남았다.
- 활동 패널(툴 타임라인, 런 목록), 승인 카드(`approval.resolve`). → **완료**(2026-09-21) — 스펙 `docs/superpowers/specs/2026-09-20-activity-approvals-design.md`, 계획 `docs/superpowers/plans/2026-09-20-activity-approvals.md`.
  오른쪽 패널의 「활동」 탭(런 목록 + 툴 타임라인, 인자·결과 펼치기), 승인 카드 두 자리(메시지 흐름·활동 탭 맨 위)와 카운트다운·허용·거절·만료, 승인 브라우저 알림.
  근거는 승인 스파이크(`.superpowers/sdd/2026-09-20-phase2-approval-spike/`) — 실물 Gateway 승인 프레임을 한 번 받아 보고 계약을 맞췄다. 아래 「이월」의 서버 넷·웹 넷·`wire-cli` 도 이때 함께 정리했다.
  **확인 방법**: 통합 시나리오 9a~9g(`apps/server/test/integration/approvals.test.ts`, 9c′ 포함 8건 — 실제 어댑터 + 가짜 Gateway·플러그인) · `pnpm -F @dodok/server dev:fake` 위 브라우저 검증(시나리오 1~9)과 **수정 뒤 재검증 9/9**(2026-09-21).
  재검증은 1차가 찾은 결함 11 중 고친 7건을 수치로 확인했고(알림 0→1건 · 옛 런 노출 420→0ms · 탭 전환 뒤 Tab 5→2회 · 짧은 창 타임라인 54→128px), 새로 찾은 셋(재접속 뒤 끝난 런이 목록에서 사라짐 · 결정 뒤 초점이 `body` · 좁은 화면 시트 초점)도 고쳐 넣었다. 남은 것은 아래 「이월」.
- 이미지 첨부(업로드 → 첨부 정책 검증 `hello-ok.policy`) 및 에이전트 생성 이미지(`artifacts.download` 단기 URL) 표시. → **완료**(2026-09-23, 실연 2026-09-23 — `docs/guides/live-smoke.md` 13절) — 스펙 `docs/superpowers/specs/2026-09-23-attachments-design.md`(구현과 달라진 것은 11장), 계획 `docs/superpowers/plans/2026-09-23-attachments.md`, 근거 스파이크 `.superpowers/sdd/2026-09-23-phase2-attachments-spike/report.md`.
  원래 적은 길과 다르게 갔다 — 첨부의 정본은 **서버**다(로컬 디스크 블롭 + `attachments` 테이블, 경계를 넘는 꼴은 `artifact://<id>`). 에이전트 파일은 `artifacts.download` 가 아니라 Gateway 호스트 경로로 오므로(스파이크) 플러그인이 `loadWebMediaRaw` 로 읽어 브리지 HTTP(`POST /bridge/attachments`, 브리지 토큰)로 올린다. 서버는 외부 URL 을 가져오지 않는다. `hello-ok.policy.attachments` 는 WS `chat.send` 의 첨부 정책이라(스파이크 5-2) 쓰지 않고, 상한은 shared `ATTACHMENT_LIMITS` 하나를 세 패키지가 읽는다.
  사람은 이미지(PNG·JPEG·GIF·WebP, 5 MB, 메시지당 10장)를 버튼·붙여넣기·끌어다 놓기로 올리고 글 없이도 보낸다. 에이전트는 이미지·파일(20 MiB)을 `message` 툴 `media` 나 최종 응답 `MEDIA:` 줄로 보낸다. MIME 은 매직 바이트로 정하고 SVG 는 늘 파일이다.
  웹은 본문 아래 이미지 격자·파일 카드와 크게 보기(←/→·원본 내려받기·초점 복귀)를 그리고, components `media`·`file`·링크 버튼의 `artifact://<파일 이름>` 을 같은 메시지 첨부로 푼다. 미디어만 있는 최종 응답이 호스트 경로(`MEDIA:/Users/…`)를 채널에 드러내던 결함은 코드로 닫았다(플러그인 1차, 서버 폴백 2차). 실연에서 메시지에 경로가 없는 것은 확인했다(`docs/guides/live-smoke.md` 13.2-4·5). 같은 줄이 스트리밍 델타로 새던 결함 A 는 서버에서 고치고 실물로 확인했다(13.7, 스펙 11장 Ruling 6).
  의존성 추가는 서버 `image-size` 2.0.4 하나, 웹 0.
  **확인 방법**: 통합 시나리오 11a~11i(`apps/server/test/integration/attachments.test.ts`, 11a′·11g 둘 포함 11건 — 실제 어댑터 + 가짜 Gateway·플러그인) · 플러그인·웹 단위(테스트 1973: shared 101·plugin 108·adapter 206·server 562·web 996) · `pnpm -F @dodok/server dev:fake` 위 브라우저 검증 **17/17**(계획 시나리오 10 + 리뷰가 넘긴 7, 1280·390px) — 결함 1(칩을 키보드로 빼면 초점이 `body`)을 고치고(`f3379b8`) 실제 앱(Chromium)에서 초점 이동을 다시 쟀다(가운데·마지막·전부·오류 칩·올리는 중 칩).
  **실연**(2026-09-23, 스펙 8.5 — `docs/guides/live-smoke.md` 13절): 런 0회 하네스 합격 기준 9/9, 모델 런 2회(이미지 단어 맞히기·파일 만들어 첨부) 통과. 남은 것은 아래 「이월」의 「첨부·이미지(Phase 2 ③)」(느린 링크·9.4 런타임·원격 Gateway 포함).
- PWA: 설치, 오프라인 최근 채널 캐시, **푸시 알림(확정)** — 구독 저장(`push_subscriptions`), 멘션/승인 요청/릴레이 한도 이벤트에 발송, iOS 설치 안내. → **완료**(2026-09-24, 실연은 예정 — `docs/guides/live-smoke.md` 14절) — 스펙 `docs/superpowers/specs/2026-09-23-pwa-push-design.md`(구현과 달라진 것은 11장), 계획 `docs/superpowers/plans/2026-09-23-pwa-push.md`.
  웹은 `vite-plugin-pwa`(`injectManifest`)로 서비스 워커 하나(`src/sw.ts`)를 만든다 — 빌드 산출물 미리 저장과 SPA 탐색 폴백(`/api/`·`/socket.io/` 는 네트워크만), 푸시 → 알림, 알림 누르기 → 열린 창을 앞으로 가져와 라우터로 그 채널(전체 새로고침 없이). 새 버전은 토스트 「새 버전이 있습니다」 + 「새로고침」으로만 넘어간다(작성 중 초안 보존). 개발 모드 SW 는 기본으로 끈다(`VITE_PWA_DEV=1` 일 때만 — 스펙 11장 R4).
  오프라인 사본은 TanStack Query 를 골라 IndexedDB 에 저장한다 — `me`·채널 목록·에이전트 + 최근 본 채널 5개의 채널·멤버·타임라인(최근 50개, 보내는 중 제외), 7일·빌드가 바뀌면 버림, 로그아웃·401 이면 지움. 오프라인이면 배너 「오프라인 — 저장된 내용을 보여 줍니다」, 보내기는 막힌다.
  서버 `modules/push/` 가 VAPID 키(환경변수 둘 또는 `data/vapid.json`)·구독 저장(`endpoint` upsert — 다른 사용자 것이면 옮긴다)·트리거 셋(멘션·승인 요청·릴레이 한도)·「그 채널을 보이는 탭으로 보고 있으면 거르기」(wire `presence.update`)·`web-push` 발송(404·410 정리)을 맡는다. 알림에는 누가·어디·무엇만 싣는다 — 본문·툴 인자·승인 설명은 없다.
  사이드바 하단 「알림」 패널이 기기별 푸시 상태 다섯(미지원·설치 필요(iOS)·거절됨·꺼짐·켜짐)·켜기·끄기·「앱 설치」를 보인다. 이 기기에 푸시가 켜져 있으면 탭 안 승인 알림은 쉰다. 로그아웃은 서버 해지 → 기기 해지 → 사본 지우기 순이고, 세션이 없어진 채 연 앱도 기기 구독을 해지한다(401 에서만).
  의존성 추가: 웹 `vite-plugin-pwa` 1.3.0(dev)·`workbox-precaching`·`workbox-routing`·`workbox-window` 7.4.1·`@tanstack/query-persist-client-core`·`@tanstack/query-async-storage-persister` 5.103.1·`idb-keyval` 6.3.0, 서버 `web-push` 3.6.7(+`@types/web-push` 3.6.4). 스키마·마이그레이션 변경 없음(`push_subscriptions` 는 0000 부터 있었다).
  **확인 방법**: 통합 시나리오 12a~12h + 종료(`apps/server/test/integration/push.test.ts` — 멘션·보고 있으면 거름·승인(두 번 실려도 1건)·릴레이 한도·410 정리·자기 멘션·**페이로드에 본문 없음**·한 사람의 소켓 둘, 실제 앱 + 가짜 Gateway·플러그인 + 가짜 발송기) · 테스트 2182(shared 113·plugin 108·adapter 206·server 656·web 1099, main `330f5e8`) · 빌드본 `vite preview`(5180) + `pnpm -F @dodok/server dev:fake`(3100) 위 브라우저 검증 **16/16·결함 0**(계획 시나리오 10 + 넘겨받은 6, headed 오프스크린 Chromium, 1280·390px).
  브라우저 검증은 **실제 `web-push` → FCM 왕복**으로 멘션·승인·릴레이 한도 알림이 도착하는 것과 같은 채널을 보고 있으면 오지 않는 것, CDP `ServiceWorker.deliverPushMessage` 로 넣은 옳은·잘못된·바깥 url 페이로드, 알림 누르기(서비스 워커 안 합성 클릭 — 라우터 이동·창이 없으면 `openWindow`), 오프라인 새로고침·처음부터 오프라인(요청 0·토스트 0), 복원 채널의 카드 결과 줄, 로그아웃·세션 만료 뒤 구독·플래그·사본 없음, 새 버전 토스트(초안 보존), 설치 버튼을 봤다. 절차는 `docs/guides/live-smoke.md` 14절.
  **실연**(스펙 8.4, 계획 태스크 9 — 모델 런 1회, 사용자 승인)은 아직이다. 남은 것은 아래 「이월」의 「PWA·푸시(Phase 2 ④)」와 「실물 확인」.
- **완료 기준**: 에이전트가 버튼/모달로 사용자 입력을 받아 작업을 이어가고, 툴 실행 로그가 UI에 실시간 표시.

### Phase 3 — 안정화·개인용 릴리스 (1~2주)

- Docker Compose 패키징, 설정 마법사(Gateway URL·토큰·페어링·**플러그인 설치 안내와 브리지 URL/토큰 발급**).
- 에러/재시도·레이트리밋·비용 상한, 로그·메트릭.
- 문서화(설치, 에이전트 프롬프트 가이드 — components 사용법 포함).

### Phase 4 — 확장 (후속, 순서는 재검토)

- 팀: 워크스페이스 멤버 초대, OIDC 로그인, 채널 권한, 멀티 Gateway 연결.
- 어댑터: Claude Agent SDK 러너 → Codex app-server 러너 → Hermes(API 서버 경로).
- 앱: Tauri 데스크톱(트레이·알림), Capacitor 모바일 또는 네이티브.
- 스레드, 검색, 에이전트 내부 위임 결과 요약 게시, 채널 템플릿.

### 이월 — 남은 문제(Phase 2 ④ 종료 시점, 2026-09-24)

Phase 1 ①·② 와 Phase 2 ①·②·③·④ 를 돌면서 「고치지 않고 알고 넘긴 것」을 한곳에 모았다. 상세 근거는 각 줄에 적은 문서에 있다. 위 Phase 2·3 항목과 겹치면 그쪽을 가리킨다.
Phase 1 이 남긴 아홉(서버 넷·웹 넷·`wire-cli` typecheck)은 Phase 2 ① 태스크 0·1 에서, Phase 2 ① 이 남긴 초점·타이머 셋(D6 카운트다운 어긋남 · 자리값 소요가 계속 흐름 · 넓은 화면 「설정 닫기」 초점)은 Phase 2 ② 태스크 8 에서 정리해 지웠다.
Phase 2 ② 가 남긴 「`media` 이미지를 크게 볼 수 없다」·「`media`·`file` 문구 비대칭」은 Phase 2 ③ 이 닫아 지웠다(크게 보기 `ImageViewer`, 세 블록이 해석기 하나로 「첨부를 찾을 수 없습니다」·「열 수 없는 링크입니다」를 같이 쓴다).
Phase 2 ② 의 출처(c2-t*)는 실행 원장 `.superpowers/sdd/2026-09-21-components-v1/`, Phase 2 ③ 의 출처(a3-t*·a3-c*)는 `.superpowers/sdd/2026-09-23-attachments/`, Phase 2 ④ 의 출처(p4-t*·판정 R1~R8)는 `.superpowers/sdd/2026-09-23-pwa-push/`(셋 다 git 제외)의 리뷰·보고서·원장이다.

**components 계약·서버(Phase 2 ②)**

- **칸·아이템 id 가 `constructor`·`__proto__` 일 수 있다 — 한 뿌리의 세 자리.** 계약 `ItemId`(`packages/shared/src/components/index.ts:4`, `/^[a-z0-9_-]{1,40}$/`)가 두 이름을 받는다(`Object.prototype` 의 다른 이름은 대문자가 섞여 정규식에 안 걸린다). 그 값이 객체 키로 쓰이는 자리 둘이 서버에 있다.
  - 서버 `valuesSchemaFor`(`apps/server/src/modules/components/interact.ts:74-90`) — **사용자가 실제로 겪는 증상은 여기서 난다.** 두 이름이 서로 다르게 깨진다.
    `constructor` 칸은 **선택 칸인데 비워 둘 수 없다.** 웹은 비운 선택 칸의 키를 빼고 보내는데(`modal/validate.ts` 의 `submitValues`), zod 4.6.5 는 칸이 있는지를 `key in input` 으로 본다(`zod/v4/core/schemas.js` 의 `handlePropertyResult`). `in` 은 프로토타입 사슬까지 보므로 빈 `fields` 가 상속한 `Object` 함수를 그 칸 값으로 읽어 `VALIDATION`(`invalid_type`, radio 는 `invalid_value`)으로 거절한다 — 모달은 비워 둔 그 칸 아래에 「받아들일 수 없는 값입니다」를 띄운다(`issues` 의 경로가 `fields.constructor` 다). 값을 채우면 통과하고, 늘 값을 싣는 checkbox 만 멀쩡하다.
    `__proto__` 칸은 `shape[f.id] = …`(`:86`)가 프로토타입 세터를 타 스키마에서 사라진다. 그 칸에 값을 실어 보내면 `unrecognized_keys` 로 `VALIDATION`(모달 하단 「처리할 수 없는 요청입니다」) — 채운 칸과 늘 값을 싣는 checkbox 는 **제출할 수 없다**. 비워 보내면 `required` 여도 통과한다.
  - 서버 `formatInteractionText` 의 `fields[f.id] === undefined`(`interact.ts:165`) — **상속 값을 읽는다.** 실물 경로(wire → `validateInteraction` → 문구)에서 에이전트에게 닿는 것은 **`__proto__` 칸을 비워 제출했을 때** 하나다 — 검증을 통과한 뒤 `- 라벨: [object Object]` 가 인바운드 글에 붙는다. `constructor` 칸의 `- 라벨: function Object() { [native code] }` 는 이 함수를 **검증 없이** 부를 때만 나온다. 실물 경로에서는 위 `valuesSchemaFor` 가 문구보다 먼저 막는다(`interact.ts:127-128`).
    c2-t6 리뷰가 두 함수를 검증 없이 673건으로 맞댄 결과 갈린 125건 중 **123건이 이 뿌리**였다. 그중 실물 경로에서 닿는 것은 `__proto__` 빈 제출 부류뿐이다.
  - 웹은 이미 막혔다 — c2-t4 재리뷰가 칸 id `__proto__` 면 모달을 여는 순간 렌더가 던지는 것을 보여, 칸 id 로 찾는 객체를 프로토타입 없이 만든다(`apps/web/src/features/components/modal/validate.ts` 의 `byFieldId`, 결과 줄은 `Object.hasOwn`).
  - **고치는 길 둘.** ① **계약 한 줄** — `ItemId` 에서 두 이름을 뺀다. 그러면 플러그인 `coerceComponents`(`packages/openclaw-plugin/src/outbound.ts:65`)와 서버 저장(`apps/server/src/modules/messages/service.ts:266`)이 카드를 거절하고, 에이전트는 「components: v1 스키마 위반 — …」를 **읽는다**. 실패가 경계에서 한 번, 크게 난다. ② **서버 두 자리 방어** — `Object.hasOwn` + 프로토타입 없는 shape.
  - **권고는 ① 이다.** 근거는 측정이다(c2-t10, zod 4.6.5). ② 의 두 방어는 **어느 이름도 혼자서 고치지 못한다.**
    `__proto__`: `Object.fromEntries`·`Object.create(null)` 로 만든 shape 라도 `z.object`·`z.strictObject` 는 shape 키 `__proto__` 를 **검증하지 못한다** — `{"__proto__": 123}` 이 `z.string()` 칸을 통과하고 출력에 그 키가 없으며, 빈 `{}` 도 통과한다(`required` 무효, 입력을 프로토타입 없는 객체로 옮겨 담아도 같다). 그래서 ② 는 `__proto__` 칸의 **값을 조용히 버려 에이전트에게 안 보낸다** — 지금(값을 실으면 `VALIDATION`)보다 나쁘다.
    `constructor`: 뿌리가 shape 가 아니라 **입력 쪽의 `in`** 이라, 프로토타입 없는 shape 도 빈 `{}` 를 여전히 `invalid_type` 으로 거절한다 — 선택 칸을 비울 수 없는 증상이 그대로 남는다. 지금 shape 그대로 **입력 `fields` 를 `Object.create(null)` 로 옮겨 담아야** 선택 칸은 통과하고 필수 칸은 제대로 거절된다.
    그러니 ② 를 고른다면 `Object.hasOwn` 에 더해 **`constructor` 는 입력 복사, `__proto__` 는 그 id 를 서버가 `VALIDATION` 으로 거절하는 한 줄이 둘 다 따라와야 한다** — 서버 세 곳을 고치고도 한 이름은 서버에서 막는 셈이라, 사실상 ① 을 서버에서 늦게(사용자가 제출할 때) 하는 것이다. 셋 중 `hasOwn` 은 빠지면 안 된다 — **입력 복사를 `hasOwn` 없이 하면 `function Object()` 가 샌다**(측정, c2-t10 재리뷰). 검증은 통과하는데 zod 가 내는 `fields` 는 평범한 객체라 `formatInteractionText` 가 상속 값을 읽어, `- 라벨: function Object() { [native code] }` 가 이번엔 실물 경로로 에이전트에게 간다. ① 은 두 이름을 카드가 들어오는 경계에서 한 줄로 닫고, 서버의 상속 값 유출도 거기 닿을 id 가 없어져 함께 닫힌다.
    ① 의 비용 하나: `ItemId` 는 저장된 행을 읽을 때(`rowToMessage` 의 `parseStored` — `ComponentsV1` 과 `ComponentState.consumed`)에도 쓰여, 두 이름을 가진 옛 행이 있으면 그 행 읽기가 실패한다. 그런 행은 관측되지 않았다.
  - 출처: c2-t4 리뷰·재리뷰(원장 Ruling 5), c2-t6 리뷰 A.1, c2-t10 측정 · c2-t10 리뷰 A.3-P(실물 `valuesSchemaFor` 로 다시 잼) · c2-t10 수정 라운드 1 의 재확인(웹 `submitValues` → JSON → wire `ComponentInteract` → `validateInteraction` → `formatInteractionText` 를 칸 7종 × 두 이름 × `required` 로). 미룬 까닭: 계약 변경은 에이전트가 보는 계약을 바꾸는 일이라 Phase 2 ② 스펙 1장이 범위 밖으로 뒀고, 서버 두 자리는 웹 태스크의 금지 범위였다. 지금 에이전트가 이 이름을 쓴 적은 관측되지 않았다.
- **`required: true` 인 checkbox 가 아무것도 강제하지 않는다** — 서버 `fieldSchema` 가 checkbox 를 `z.boolean()` 으로 두고 `required` 는 `.optional()` 을 붙이느냐만 가른다(`interact.ts:63-65`·`:70`). 체크박스는 늘 `true|false` 를 보내므로 「동의 필수」를 이걸로 걸어도 안 눌러도 통과한다. 웹은 서버를 따른다. 출처: c2-t4 리뷰(원장 Ruling 5). 미룬 까닭: 「checkbox 의 `required` 는 켜져야 한다」로 **뜻을 정하고** 서버·플러그인 스키마 설명·웹을 함께 고쳐야 하는 계약 결정이다. 권고: 「켜져야 한다」로 정한다 — 안 그러면 `required` 가 checkbox 에서만 죽은 필드다.
- **shared 스키마에 모순 셀렉트를 막는 `refine` 이 없다** — `minValues > maxValues`·`minValues > options.length`·단일인데 `minValues > 1` 인 카드는 「보내기」가 영영 안 켜지고(서버도 같은 경계로 거절하니 정합은 맞다) 화면은 채울 수 없는 안내(「5개 이상 고르세요」)를 낸다. `refine` 을 두면 플러그인이 에이전트에게 곧바로 오류를 돌려준다. 출처: c2-t3 리뷰. 미룬 까닭: `packages/shared` 계약 변경이라 Phase 2 ② 범위 밖. 웹이 따로 할 일은 없다(서버와 다르게 굴면 그것이 결함이다).
- **서버 wire 핸들러의 ack 모양이 타입으로 안 걸린다** — `realtime/socket.ts` 의 `reply(ack: unknown, …)` 라 wire 계약(`Ack<{ interactionId: Id }>`)을 서버 쪽에서 타입으로 확인하지 않는다. 핸들러 안에서 모양을 바꾸면 tsc 는 조용하고 테스트만 잡는다. 출처: c2-t1 재리뷰. 미룬 까닭: Phase 1 부터의 기존 성질이고, 지금은 테스트가 그물이다.
- **결과 문구의 빈 값이 어색하다(서버·웹 같은 규칙)** — 계약이 셀렉트 `placeholder: ""` 를 받아(`max(150)`, `min` 없음) 웹 결과 줄은 `@owner — : PDF`, 서버 인바운드 글은 `""에서 PDF을 골랐습니다.` 가 된다. 서버는 고른 것이 0개일 때도 `"…"에서 을 골랐습니다.` 를 낸다. 출처: c2-t6 리뷰 A.1·보고서. 미룬 까닭: 둘 다 `??` 로 규칙이 같아 갈림은 아니고, 고치려면 계약(`min(1)`)이나 서버 문구를 건드린다.

**웹 렌더(Phase 2 의존성 — 의존성을 더해야 한다)** — 「한국어 강조·구두점 경계」는 Phase 2 ① 태스크 1 에서 `@streamdown/cjk` 1.0.3 으로 해결했다.

- **코드 하이라이트**: Streamdown 2.6 은 shiki 를 `@streamdown/code` 플러그인으로 뺐고 웹 MVP 의존성에 없다 — 지금 코드 블록은 틀·복사 버튼까지다(스펙 5.2). Phase 2 에서 번들 크기(첫 화면 0.47MB)와 함께 판단한다.
- 마크다운 이미지(`![](https://…)`)는 지금도 **불러오지 않고 새 탭 링크로** 보인다(추적 픽셀 차단). 첨부 이미지는 Phase 2 ③ 이 본문 아래 격자로 그린다(위 「이미지 첨부」).

**서버**

- usage 값이 틀리고(claude-cli `message_start` 스냅샷) 출처가 확정되지 않았다 — 다음 실연에서 `OPENCLAW_FRAME_DUMP_PATH` 로 원본 프레임을 남겨 가른다. 활동 패널의 비용·토큰 표시는 그때까지 쓸 수 없다. 상세 `docs/guides/live-smoke.md` 5.4 의 2번.
- 정본이 먼저 오고 Gateway 이벤트가 없는 퇴화 경로에서 늦은 답이 다음 런에 붙을 수 있다 — `docs/guides/live-smoke.md` 5.4 의 4번(남음).
- 재접속 구독 ack 의 `pendingApprovals` 는 **채널 단위**라, 다른 채널의 미해결 승인은 새로고침하면 돌아오지 않는다(요구·확정 실시간 팬아웃만 워크스페이스 룸이다 — 스펙 4.6). 출처: Phase 2 ① p2-t12s 리뷰. 미룬 까닭: 복구 경로를 워크스페이스 단위로 넓히면 ack 페이로드 상한·정렬을 다시 정해야 해서 범위가 커진다.
- **`providerApprovalId` 만 어댑터의 상한 처리 밖이라 그 필드는 fail-open 이 아니다** — shared `Approval` 은 `.max(200)` 을 걸지만(`packages/shared/src/domain/index.ts:222`) 어댑터 `MAX` 에 이 필드가 없고 정규화가 Gateway id 를 그대로 싣는다(`packages/openclaw-adapter/src/gateway/approvals.ts:48-56`·`:348`, 프레임 스키마도 `:108`·`:122` 가 `min(1)` 뿐이라 상한이 없다). 200자를 넘는 id 가 오면 잘리거나 버려지는 대신 `rowToApproval` → `parseStored` 가 `INTERNAL` 로 터진다(`apps/server/src/modules/approvals/store.ts:61`·`apps/server/src/http/validate.ts:28-39`). 출처: Phase 2 ① p2-t11 재리뷰. 미룬 까닭: 실물 id 는 `plugin:<uuid>` 라 지금 닿지 않는 자리이고, 고치려면 이 필드도 상한 처리에 넣을지(버릴 수 없는 키라 자를 수도 버릴 수도 없다 — 승인을 떨구는 수밖에) 를 먼저 정해야 해서 fail-open 판정 자체를 다시 연다.

**웹**

- **D4 확정 순간 카드가 78px 뛴다** — 대기 카드는 목록 맨 아래에 있다가 확정되면 `createdAt` 자리로 돌아가므로, 승인 대기 중 **뒤에 다른 메시지가 끼었을 때만** 한 프레임에 자리가 바뀐다(카드는 화면 안에 남는다). 출처: Phase 2 ① 브라우저 검증. 미룬 까닭: 사소하고 조건이 좁으며, 고치려면 정렬 규칙이나 전이 애니메이션을 새로 들여야 한다.
- **D11 로그아웃 전이에서 401 이 5건 더 난다** — 로그아웃 직후 마운트돼 있던 쿼리(`/channels`·`/channels/:id`·`/members`·`/agents`·`/adapter/status`)가 재조회된다. 출처: Phase 2 ① 브라우저 검증(재검증에서도 그대로 5건). 미룬 까닭: **Phase 1 유래**이고 Phase 2 ① 범위 밖이다 — 기능에는 영향이 없고 콘솔 오류로만 보인다.
- **끊긴 사이 끝난 런의 「타임라인 행」이 재접속 뒤에도 낡은 채 남는다** — 목록 줄은 「완료 · 21초」로 맞는데 그 아래 타임라인의 승인 행은 「대기 중」이고 「결과 보기」가 없다. **D12 고침이 만든 것이 아니다**: `runReplay` 가 구독 ack 의 `activeRuns` 에 있는 런만 처음부터 재생하고 `qk.runEvents` 는 앱 어디에서도 무효화되지 않는 **원래 빈틈**인데, 전에는 줄 자체가 사라져 그 런을 고를 수 없어 가려져 있었다. 다른 런을 눌렀다 돌아오거나 새로고침하면 맞는다. 출처: Phase 2 ① p2-t14 보고서 8장 1·리뷰 §A.5(코드로 확인). 미룬 까닭: 수정 브리프가 「타임라인이 **바뀌지** 않는다」를 요구했고 범위 밖이었다 — 고침은 한 줄이 아니라 대여섯 줄(`useQueryClient` 를 들여와 **새로 빠진 id 만** `qk.runEvents` 무효화; 전부 무효화하면 옛 런 타임라인까지 다시 받는다).
- **끝난 런 기억(`ended`·`vanished`·`stopped`)에 개수 상한이 없다** — 한 채널에 머무는 동안 런 종료·재접속마다 자란다(채널을 옮기면 통째로 버린다). `stopped`(빠진 런을 안 시각 — 그 줄의 소요를 멈추는 데 쓴다)는 Phase 2 ② 태스크 8 이 더한 셋째 Map 으로(`apps/web/src/features/activity/ActivityPanel.tsx` 의 `stopped`), 그 런이 다시 실시간으로 올 때만 지워진다. 출처: Phase 2 ① p2-t12w 리뷰 A.1 와 p2-t14 리뷰 §A.3, `stopped` 는 c2-t8 리뷰. 미룬 까닭: 한 항목이 런 하나라 작고, **셋을 한 훅으로 묶으면서 함께** 상한을 넣어야 규칙이 여러 군데로 갈리지 않는다.
- **로그아웃(=런 스토어 리셋) 때 `/channels/:id/runs` 가 한 번 더 나간다** — 진행 중이던 런이 전부 「빠진 런」으로 기록돼 재조회가 한 번 더 걸린다(실측 1→2회). 패널은 곧 언마운트되므로 화면에는 안 보이고, 남는 자국은 위 D11 의 401 이 하나 느는 것뿐이다. 출처: Phase 2 ① p2-t14 리뷰 §A.3. 미룬 까닭: D11 과 같은 자리라 그때 함께 본다.
- **`PanelSlot` 테스트 하네스가 실물에 안 묶여 있다** — D13 의 「카드가 다음 승인으로 갈아탄다」를 재는 하네스가 `ActivityPanel` 의 카드 자리 규칙을 **베낀** 것이고, 실물 쪽에는 그 규칙을 잠그는 테스트가 없다. 규칙이 바뀌면 그 테스트가 조용히 무의미해진다(버그를 **가리지는** 않는다). 출처: Phase 2 ① p2-t14 재리뷰 정리 a. 미룬 까닭: 막는 결함이 아니고, 고침은 활동 테스트 끝에 「승인 둘이면 A 확정 뒤 `data-approval-id` 가 B 로 바뀐다」 한 줄이다.
- **`lastSeq` 재구독이 옛 카드의 결과 줄을 갱신하지 않는다** — 웹은 채널을 떠날 때 구독을 풀고 캐시는 남기며, 돌아오거나 재접속하면 `lastSeq` 로 구독한다(`apps/web/src/realtime/subscriptions.ts`). 서버는 `afterSeq` 초과 메시지만 돌려주므로(`listMessages`) 떠나 있는 사이 다른 탭·다른 사람이 누른 카드(seq ≤ lastSeq)는 **결과 줄·`consumed` 가 낡은 채** 남는다(새로고침·새 탭은 맞다). `consumed` 쪽은 Phase 1 부터 있던 빈틈이다. 출처: c2-t7 리뷰. **브라우저 검증 두 번 모두 「갱신 안 됨」을 못 쟀다** — 1차(c2-t9)는 오프라인 → 온라인 복구 자체는 정상임을 봤으나 「갱신 안 됨」은 두 번째 행위자가 필요해 재현하지 못했고, 재검증(c2-t13)은 같은 까닭(다른 행위자가 필요)으로 시도하지 않았다. 다음에 잴 때는 이 줄의 조건대로 같은 사람의 **두 번째 탭**이 누르면 된다(떠난 탭은 구독을 푼다 — `subscriptions.ts` 의 `leave`). 미룬 까닭: c2-t7(하네스·통합 테스트) 범위 밖이었고, `consumed` 까지 같은 빈틈이라 결과 줄만의 일이 아니다 — 재구독이 옛 메시지의 변경을 받게 하려면 「`lastSeq` 이후 **새** 메시지만」 돌려주는 구독 계약(`realtime/socket.ts` 의 subscribe)을 넓혀야 한다.
  Phase 2 ④ 에서 한 길이 더 생겼다가 닫혔다. 오프라인 사본에서 복원한 타임라인이 `lastSeq` 로 이어지면 앱이 닫혀 있던 동안의 결과 줄이 영영 안 보였다(p4-t4 리뷰 결함 1, 실물 재현) — 사본은 `lastSeq` 를 0 으로 저장해 복원한 채널의 첫 구독을 `fresh` 로 돌린다(원장 R5, 스펙 11장). 브라우저 검증(p4-t7 시나리오 L)이 두 번째 행위자로 실물에서 확인했다. 첫 구현의 `gcTime` 7일은 이 틈을 세션 전체로 넓혔으나 걷었다(R6). **남은 것은 이 줄 그대로다** — 메모리 캐시가 살아 있는 5분(기본 `gcTime`) 안에 채널을 떠났다 돌아오거나 재접속하면 결과 줄이 빠질 수 있다.
- **가상화 목록이 초점 가진 행을 지우면 초점이 `body` 로 떨어진다** — 결과 줄·승인 카드의 결과 줄·링크 등 행 안에서 초점을 가진 무엇이든, 새 메시지가 몰려 그 행이 가상화 범위 밖으로 나가면 DOM 에서 빠지고 `activeElement` 가 `body` 가 된다. 다음 Tab 은 메시지 영역 뒤 첫 정거장(「새 메시지 N개」 칩이 떠 있으면 칩)으로 간다. components 가 초점을 옮기는 것은 아니지만 결정 뒤 초점(D13 규칙)으로 초점이 그 행에 **있을 일**이 늘었다. 출처: c2-t9 관찰, c2-t12 가 두 탭으로 재현하고 코드로 확인(칩에 `focus()` 하는 코드는 없다). 미룬 까닭: `MessageList`(Phase 1 ②)의 가상화 성질이라 components 범위 밖이다. 고칠 자리는 `rangeExtractor` 로 초점 행을 늘 그려 두는 것 등(`MessageList` 몫).
- **날짜 칸의 키 롤오버에서 제출 오류가 조용히 지워진다** — 부분 날짜(또는 빈 필수 칸)에서 한 글자 키·Backspace 를 **떼기 전에** Enter 를 누르면, Enter 의 암묵 제출이 띄운 오류를 늦게 온 그 키의 keyup 이 곧바로 지운다(전송 0·문구 0, 값 손실은 없고 다시 Enter 하면 뜬다). jsdom 으로도 재현된다(`userEvent.keyboard("202{6>}{Enter}{/6}")`). 출처: c2-t4 재리뷰 2(B10·B11). 더 나은 길이 확인돼 있다 — keydown 에서 `value`·`validity.badInput` 을 적고 keyup 에서 **달라졌을 때만** 고친 것으로 본다(실브라우저 32단계 모두 기대대로). 미룬 까닭: 기존 date 키 테스트 5건(`modal.test.tsx`)을 전이 흉내로 다시 써야 해 막는 결함 대비 비용이 컸다. 브라우저 검증(c2-t9)은 자동화의 세그먼트 입력이 사람 타이핑과 달라 재현하지 못했다. 재검증(c2-t13)은 이 줄을 「확인됨」(결함으로 세지 않음)으로 적었지만, 본 것은 슬래시를 섞어 친 입력에서 세그먼트가 뒤섞인 것(`10/15/2026` → `101520-02-06`)이라 이 줄의 증상(keyup 이 Enter 의 오류를 지움)을 실브라우저에서 잰 것은 아니다.
- **`useInteract` 오류 문구가 「버튼」이라고 말한다** — 「만료된 버튼입니다」·「이미 처리된 버튼입니다」·「이 버튼을 누를 권한이 없습니다」(`apps/web/src/features/components/useInteract.ts` 의 `ERR`). 셀렉트를 보내다 만료되면 토스트로, 모달은 대화상자 하단 한 줄로(`ComponentModal.tsx` 의 `setFormError(r.text)`) 「만료된 버튼입니다」가 뜬다. 출처: c2-t3 리뷰(낮음). 미룬 까닭: 태스크 2 파일이라 셀렉트 태스크가 못 고쳤고, 「항목」 같은 중립어로 바꾸는 한 줄이다.
- **긴 라벨 버튼이 390px 에서 카드 밖으로 넘친다** — 계약은 버튼 라벨을 80자까지 받는데(`packages/shared/src/components/index.ts` 의 `Button.label` `max(80)`), 공용 `ui/button` 이 `whitespace-nowrap shrink-0` 이라 버튼 하나는 줄을 바꾸지 못한다(버튼 줄의 `flex-wrap` 은 버튼 **사이**만 바꾼다). 72자 라벨 버튼이 폭 575px 로 카드 오른쪽(374px) 밖으로 나가 라벨 끝이 잘렸다 — 페이지 가로 스크롤은 없다(`scrollWidth` 390). 모달을 여는 `triggerLabel` 버튼(역시 80자)도 같은 래퍼다(실측은 액션 버튼만). 출처: c2-t12 리뷰 이월 후보 1(390px 실측). 재검증(c2-t13)도 「확인됨」(결함으로 세지 않음)으로 다시 쟀다 — 58자 라벨이 폭 600px, 오른쪽 끝 664px 로 뷰포트 밖이고 `scrollWidth` 는 390, 390px 전체 스캔에서 뷰포트 밖으로 나간 요소는 이 버튼 하나였다. 미룬 까닭: 옛 `ActionButtons` 부터 있던 성질이고 대본 라벨이 짧아 드러나지 않았다. 공용 `ui/button` 을 바꾸면 앱의 다른 버튼에 퍼지므로 카드 안 버튼에만 줄바꿈을 허용하는 쪽으로 따로 정해야 한다.
- **초점·타이머 낮은 셋(Phase 2 ② 태스크 8 곁가지)** — 모두 낮음. 출처: c2-t8 리뷰 「이월」 ①·④·⑤(같은 절의 ②·③ 은 c2-t8 수정 라운드 1·2 가 테스트와 `resetNowTick` 으로 닫았다). 미룬 까닭: 태스크 8 수정 브리프가 범위 밖으로 뒀고, 셋 다 값을 잃거나 초점을 잃지 않는다.
  - **켜짐 전이 첫 프레임이 옛 시각이다** — `useNowTick` 은 마운트 때만 `readNow` 로 읽고(`apps/web/src/hooks/useNowTick.ts` 의 `useState(readNow)`), `active` 가 거짓 → 참으로 **바뀌는** 렌더는 효과가 구독해 새 값을 넣기 전 한 프레임 동안 옛 `now` 를 그린다(기존 동작).
  - **넓은 화면 「닫기」의 수정자 클릭·뒤로 가기** — 닫기 링크의 `onClick` 이 수정자를 가리지 않아 Cmd/Ctrl/Shift 클릭은 패널이 열린 채 초점만 헤더 「채널 설정」으로 옮긴다(라우터는 수정자 클릭이면 이동하지 않는다, `app/layout/PanelTabs.tsx`). 브라우저 뒤로 가기로 패널이 내려가면 초점은 여전히 `body` 로 떨어진다 — 고침은 닫기 링크에만 걸려 있다.
  - **멈춘 자리값 줄에 시각 표식이 없다** — `frozenAt` 으로 소요는 멈추지만(`features/activity/timeline.ts`) 줄 모양은 흐르는 줄과 같고, 멈춘 값은 실제보다 길 수 있다(빠진 것을 **안** 시각에서 멈춘다).

**테스트**

- **`App.test` 가 셔플 순서에 기대 있다** — 「Query 밖 REST 401(notifyUnauthorized)도 같은 곳…」(`apps/web/src/app/App.test.tsx:93`)이 파일 안에서 맨 처음 돌면 늘 실패한다(시드 8123·1789969248075 에서 재현, 기본 순서에서는 네 번째라 통과). 뿌리: 이 테스트의 fetch 가짜는 `notifyUnauthorized` 뒤에도 `me` 에 200 을 주고, 라우트 분할된 `LoginPage` 청크가 차가우면 그 200 이 먼저 와 로그인 폼 제목이 한 번도 그려지지 않는다. **Phase 2 ② 와 무관** — 기준 커밋에서도 재현되고 라우트 분할(`f70813b`)부터 있던 것이다. 출처: c2-t2·c2-t8 리뷰, c2-t6 재리뷰(원인 분석). 고칠 자리: 형제 테스트(`:66`)처럼 `notifyUnauthorized` 뒤에 `me` 를 401 로 바꾼다 — 「401 뒤에도 세션 살아 있음」 흉내 자체가 비현실적이다. 미룬 까닭: 범위 밖 파일이다.
- **`a11y.test` 에 셀렉트가 없다** — 이 스윕(`apps/web/src/a11y.test.tsx`)의 대상 카드에 셀렉트가 없고 `ROLES` 에 `radio`·`group` 도 없어, 이름 없는 라디오·이름 없는 무리를 못 잡는다. 옵션 목록의 이름(legend)은 `OptionList.test.tsx` 가 따로 잰다. 출처: c2-t3 리뷰. 미룬 까닭: 모달·블록 태스크도 같은 파일을 만질 수 있어 병합 뒤 한 번에 하려고 이월했다.

**문서**

- **`infra/` 가 없는데 두 문서가 있다고 말한다** — `docs/project-structure.md` 1장 트리의 `infra/`(`docker-compose.yml`·`caddy/Caddyfile`)와 `CLAUDE.md` 「명령」의 `docker compose -f infra/docker-compose.yml up [--profile gateway]` 는 지금 없는 경로다(`git ls-files infra` 0줄, 이력 `git log --all -- infra` 0건) — 그 명령은 돌리면 실패한다. 출처: c2-t10 보고서 걱정 2, c2-t10 리뷰 C.2. 미룬 까닭: Phase 2 ② 가 만든 거짓이 아니고, 채울 일은 위 Phase 3 「Docker Compose 패키징」이다. 그때까지 두 자리에 「(Phase 3, 아직 없음)」을 달지는 그 문서들을 만지는 사람이 정한다.

**플러그인·OpenClaw 버전(2026-09-23, components 실연 결함 1 뒤)** — 결함 1(모델 런의 `message` 툴 「bridge is not running」)은 2026.9.5 의 번들 이중 평가가 원인이었고 전역 레지스트리로 고쳤고 **실물에서 확인했다**(c2-t16, 모델 런 0회 — `live-smoke.md` 11.3·12절, `docs/adr/0004-plugin-global-registry.md`). 출처는 c2-t14 원인 가르기(모델 런 0회)·c2-t15 구현, 실물 확인 절차는 `docs/guides/live-smoke.md` 11절.

- **결함 2(`ask_user`)의 뒷 두 층이 남았다.** 첫 층(`sendText` 도 두 번째 인스턴스에서 돌아 「bridge is not running」)은 ADR 0004 로 같이 닫혔다(실물 확인됨 — c2-t16 에서 `ask_user` 가 다음 층까지 갔다). 남은 것: ① 브리지를 찾아도 `sendText`(`packages/openclaw-plugin/src/channel.ts` 의 `outbound.attachedResults.sendText`)는 `agentId:"unknown"`·`sessionKey:"agent:unknown:dodok:channel:…"` 로 아웃바운드를 만들어 **서버가 `agent not found` 로 거절한다**(c2-t14 F7, `mcp serve` 의 `messages_send` 로 확인). `sendText` 가 `to`·세션 문맥에서 에이전트를 알아내거나 서버가 채널의 에이전트 멤버로 보정해야 한다. ② 전달돼도 **텍스트뿐이라 선택지 컨트롤이 없다**. 9.5 CHANGELOG 의 「Structured channel questions」(채널이 에이전트 질문의 선택지를 네이티브로 받는 새 계약)과 **겹치는지부터 본다** — `ask_user` 를 dodok 카드로 그릴지는 그 계약과 우리 `components` 를 맞대고 정한다(모델이 components 보다 `ask_user` 를 먼저 고른다는 관찰 — `live-smoke.md` 10.4 의 3 — 과 같은 판단이다). 미룬 까닭: 에이전트를 가리는 규칙과 새 upstream 계약 조사가 필요한 설계 일이다.
- **길 C — 인스턴스 무관 전송.** `handleAction`·`sendText` 가 브리지 소켓 대신 서버 HTTP(브리지 오리진 + 토큰)로 아웃바운드를 보내고, 상관(`runId`·`replyTo`)은 **서버가** 세션 키의 활성 런으로 정한다. 플러그인의 `correlations`(지우는 자리가 없어 세션 키 수만큼 남는다 — 채널 × 에이전트라 지금은 문제없다)와 「운영자가 보낸 카드가 끝난 런에 붙는다」(`live-smoke.md` 10.4 의 5)가 함께 사라진다. 미룬 까닭: 새 엔드포인트·인증·dedupe·스펙 변경에 브리지 단일 연결 원칙에 두 번째 통로를 둘지 결정이 필요하다(ADR 0004 3절). **올릴 신호**: OpenClaw 가 플러그인을 별도 realm·워커·프로세스로 격리한다는 신호(9.5 CHANGELOG 「worker-backed keyed and conditional state operations」가 방향) — 그러면 전역 레지스트리가 깨진다. 버전을 올릴 때 `live-smoke.md` 11.3 하네스를 한 번 돌리면 먼저 안다.
- **9.5 라이브 재로드를 쓰기 전에 볼 것** — 전역 레지스트리의 삭제 가드는 **Map 만** 지킨다(c2-t15 리뷰 L2·L3). ① `finally` 의 `setStatus({running:false, connected:false})` 는 `releaseBridge` 결과와 무관하게 돈다. 핫 리로드에서 B 가 `onReady` 로 connected 를 보고한 뒤 A 의 finally 가 오면, 같은 계정을 down 으로 덮을 수 있다. 계정 상태가 인스턴스별인지 계정별인지는 확인하지 않았다(9.5 SDK). 지금은 라이브 재로드를 쓰지 않는다(`packages/openclaw-plugin/src/channel.ts:286`). ② 두 세대 브리지가 겹치면 서버가 옛 연결을 `replaced` 로 끊는다. 옛 클라이언트는 `disconnect` 핸들러에서 `scheduleReconnect` 를 걸고, `system.notice replaced` 를 받아도 재연결을 멈추지 않는다. 그래서 옛 세대가 abort 될 때까지 **두 연결이 서로 교체하는 핑퐁**이 가능하다. 이번 변경 전에도 같았다(`packages/openclaw-plugin/src/bridge-client.ts:164-167`·`packages/openclaw-adapter/src/bridge/server.ts:130-133`). 고칠 자리: `releaseBridge` 가 false 면 status 를 건드리지 않는 방안, `replaced` 공지를 받으면 재연결하지 않도록 할지 — 9.5 재로드를 쓸 때 정한다.
- **dev Gateway 가 스스로 업데이트해 정확 핀이 조용히 깨진다.** OpenClaw.app 이 2026-09-20 에 9.4 → 9.5 로 올랐고(앱 번들 `bin/openclaw` 심링크 수정 시각), 저장소 핀(`openclaw`·`@openclaw/gateway-*` `2026.9.4`)과 실연 Gateway 가 달라진 채 결함 1 을 만났다. 실연 전 `oc --version` 적기(`live-smoke.md` 2절)는 알아챌 뿐 막지 못한다. **사람이 할 일**: 앱의 자동 업데이트를 끌 수 있는지 확인한다. 그다음 핀 정책(9.5 로 올릴지 — 저장소 devDependency·`pluginApi`·`live-smoke.md` 2절)을 원격 버전과 함께 정한다(ADR 0004 3절 길 B).
- **원격(배포) Gateway 버전을 아직 모른다.** 원격이 9.5 이상이면 ADR 0004 이전 번들은 배포에서도 에이전트가 카드를 못 보낸다. 서버가 이제 접속 로그에 싣는다 — `"gateway connected"` 의 `gatewayVersion`(hello-ok `server.version`)·`gatewayBuildId`(`server.buildId`, 같은 버전 문자열의 두 빌드를 가른다 — 없으면 `null`)와 `"bridge plugin hello"` 의 `gatewayVersion`(플러그인의 `runtime.version`). **원격에 한 번 붙으면 알 수 있다**(사람 몫, `live-smoke.md` 6절). ⚠ 같은 줄의 `pluginBuiltWithSdk`(옛 `sdkVersion`)는 빌드 때 박힌 상수라 Gateway 버전이 아니다.

**첨부·이미지(Phase 2 ③, 2026-09-23)** — 스펙 `docs/superpowers/specs/2026-09-23-attachments-design.md` 10장(열린 문제)·11장(구현과 맞춘 것). 아래 출처의 보고서·리뷰(a3-t*·a3-c*)와 원장은 `.superpowers/sdd/2026-09-23-attachments/`, 스파이크 보고서는 `.superpowers/sdd/2026-09-23-phase2-attachments-spike/report.md` 다(둘 다 git 제외).

- **사람이 채팅에 쓴 호스트 경로가 모델 문맥에 들어갈 수 있다** — Gateway 는 프롬프트 속 절대 이미지 경로를 찾아, 허용 루트 안이면 모델에 자동으로 붙인다(스파이크 1-16). 우리 쪽 텍스트(본문·문맥 줄·자리표시)에는 경로를 쓰지 않지만, 사람이 `/Users/…/x.png` 를 타이핑하면 그 호스트 이미지가 들어갈 수 있다. 출처: 스펙 10장, 스파이크 보고서 걱정 1. 미룬 까닭: 막으려면 서버가 사람 글을 고쳐 보내는 규칙(어떤 꼴을 어떻게 바꿀지)을 새로 정해야 한다. 원격 호스트에서는 Gateway 의 미디어 허용 루트가 먼저 좁힌다(스파이크 1-16 — `tools.fs.workspaceOnly` 가 이 경로에도 걸리는지는 재지 않았다, `docs/guides/live-smoke.md` 6절).
- **5 MiB 가까운 이미지가 Anthropic 이미지 상한에 걸리는지 모른다** — 스파이크가 5.32 MiB PNG 가 claude CLI 까지 그대로 가는 것은 봤지만 모델 런으로 재지는 않았다. 우리 상한 5 MB(5,242,880 바이트)가 방어선이다. 단, 에이전트가 올린 이미지가 릴레이로 다음 에이전트에게 갈 때는 인바운드 상한이 20 MiB 라(스펙 11장), 5~6 MiB 이미지가 그대로 간다(6 MiB 넘는 것은 Gateway 가 재압축, 스파이크 1-12). 출처: 스펙 10장, 스파이크 걱정 4. 미룬 까닭: 모델 런이 필요하다 — 실연(a3-t11)의 모델 런은 작은 이미지(`word.png` 10,619B)만 썼다(8.68 MB 는 가짜 CLI 런의 릴레이 — `docs/guides/live-smoke.md` 13.2-6). 큰 이미지 한 장의 모델 런이 따로 필요하다.
- **9.4 런타임에서 인바운드 `media` fact·`@경로` 가 같은지 모른다** — 실물로 잰 것은 2026.9.5(스파이크·실연 a3-t11)뿐이다. 구현은 9.4 SDK 타입과 로더 코드를 읽어 맞췄지만(a3-t5), 실물 Gateway 에서는 돌지 않았다. 출처: 스펙 10장, 스파이크 걱정 5. 미룬 까닭: 원격 Gateway 버전을 아직 모른다(아래 「플러그인·OpenClaw 버전」). 버전을 본 뒤 `docs/guides/live-smoke.md` 11.5 로 한 번 돈다.
- **Gateway 호스트에 이미지 사본이 셋 남는다** — 플러그인이 저장한 원본(`media/inbound/`, 기본값으로 영구), claude CLI 복사본(`<ws>/.openclaw-cli-images/`, 7일 스윕), 스테이징(`<ws>/media/inbound/openclaw-staged-*`, 정리 코드를 못 찾음). 출처: 스펙 결정 6·10장, 스파이크 걱정 3. 미룬 까닭: 설계가 운영 설정(`attachments.ttlHours`)에 맡겼다 — 너무 빨리 지우면 이력 재생에서 이미지가 빠진다. 설치 안내는 `docs/guides/live-smoke.md` 6절.
- **실연(a3-t11, `docs/guides/live-smoke.md` 13절)이 잰 것 — 판정 둘과 `channel.ts` 배선.** 배선(단위 테스트가 못 잡는 변이 세 자리)과 Ruling 2 의 전제는 실물로 확인했다. **남은 것은 느린 링크다** — Ruling 1 의 ack 상한도, Ruling 2 의 연장 상한(정본이 final 뒤 31·45ms 에 와 연장이 쓰인 적 없음)도 루프백에서는 두드려지지 않았다. 출처: 원장 Ruling 1·2, a3-t4 보고서 걱정 1~3, a3-t5 재리뷰 3·변이 표 끝, a3-t11 보고서 「Ruling 1·2 의 전제」·합격 기준 6·7. 미룬 까닭: 느린 링크는 루프백 실연에서 재지 못했다(a3-t11) — 원격 Gateway 에서 잰다.
  - Ruling 1(인바운드 ack = 10초 + 이미지당 30초) — **루프백 정상 경로만 확인**(ack 3장 117ms·8.7 MB 175ms·새 세션 873ms, 재전송·deliveryId 중복 0). 틀리면: 한 장 받기가 30초를 넘는 느린 링크에서 ack 전에 재전송돼 같은 런이 **두 번 돌 수 있다**(플러그인에 `deliveryId` dedupe 가 없고, Gateway 가 같은 runId 를 거르는지는 재지 않았다). 상한은 이미지 수만 보고 크기는 안 본다.
  - Ruling 2(`MEDIA:` 줄당 finalizing +30초, 최대 120초)가 틀리면: 120초 넘는 업로드는 **같은 답이 두 번** 저장된다(두 번째에만 첨부). 정본이 아예 안 오는 런도 `MEDIA:` 줄이 있으면 최대 120초 「마무리 중」으로 보인다. — **전제는 맞았다**: 실제 `gateway_final` 스냅샷에 `MEDIA:` 줄이 남는다(하네스·모델 런 ② 프레임 덤프). 이번 실연에서 정본은 final 뒤 31·45ms 에 와 연장이 실제로 쓰인 적은 없다.
  - 플러그인 `channel.ts` 가 순수 함수(`shouldDeliverFinal`·`inboundSaveArgs`·`loaderOptions`)를 **우회하는** 변이 3건은 테스트가 못 잡는다(스펙 8.2 방침 — SDK 를 import 하는 파일이다). 실연 합격 기준 6 이 셋 다 실물로 확인했다(미디어 전용 응답이 보내짐 · 8.68 MB PNG 인바운드 — `maxBytes` 전달 · 워크스페이스 상대 경로 `media` 업로드 — `mediaAccess`). 앞으로는 `docs/guides/live-smoke.md` 11.5 하네스를 다시 돌려야 잡힌다(자동 테스트로는 여전히 안 잡힌다).
- **`artifact://` 이름 해석에 본질적으로 모호한 셋이 남았다** — 웹 `resolveRef`(대안 B, Ruling 5)는 ① `a%20b c.pdf`(`%20` 문자열과 공백이 함께 든 이름 — 플러그인이 `a%20b%20c.pdf` 로 보낸다)를 못 찾고(「첨부를 찾을 수 없습니다」) ② 첨부 `[a%20b.pdf, a b.pdf]` 에서 뒤를 뜻한 `a%20b.pdf` 를 앞 첨부로 푼다 ③ `[50% a b.pdf, 50% a%20b.pdf]` 에서 뒤를 뜻한 것을 앞 첨부로 푼다(전에는 missing). 테스트가 지금 결과를 단언한다. 출처: a3-c1 리뷰 2절 표, a3-c2 보고서(표·걱정). 미룬 까닭: 인코딩된 문자열만으로는 원래 이름을 가를 수 없다. ①은 그런 이름 하나만 있어도 나고, ②·③ 은 한 메시지에 이름이 이렇게 겹쳐야 난다.
- **잘린 16바이트 WebP(VP8L)가 1×1 이미지로 저장된다** — `RIFF\0\0\0\0WEBPVP8L` 은 독립 버퍼로 줘도 `image-size` 2.0.4 가 끝을 넘은 인덱스를 0 으로 읽어 1×1 을 돌려준다. 그래서 「못 읽으면 `file`」(스펙 4.2)과 조금 어긋난다. 뷰 밖 메모리를 읽는 것은 아니라 누출은 없고, 웹은 `<img>` 가 실패하면 파일 카드로 물러난다. 출처: a3-t2 보고서 수정 라운드 1 「남은 관찰」, a3-t2 재리뷰(동의). 미룬 까닭: 해가 없고 범위 밖이다. 고치려면 WebP 가 30바이트 미만이면 `file` 로 두는 가드 한 줄.
- **dev:fake 키워드 목록의 앞 다섯이 손으로 적은 목록이다** — `DEV_FAKE_KEYWORDS` 는 `COMPONENT_CARDS`·`ATTACHMENT_REPLIES` 키를 표에서 뽑지만, 드롭·실패·느리게·도구·승인 다섯은 `fakeAgentScript` 안의 `text.includes("…")` 와 따로 산다(`apps/server/scripts/dev-fake.ts`). 인라인 조건에 새 키워드를 더하면 「대본 글에 키워드가 없다」 전수 검사를 빠져나간다(변이 K5 생존). 지금 값은 맞다. 출처: a3-t8 재리뷰 N1. 미룬 까닭: 낮음. 고칠 길은 인라인 다섯도 표에서 읽거나, 소스의 `text.includes` 리터럴이 목록에 모두 드는지 보는 사례 하나.
- **dev:fake 진입점 한 줄이 잠기지 않았다** — 진입점의 `startDevFake(opts)` 를 `appOrigin` 없이 부르게 망가뜨려도 테스트가 초록이다(변이 M4c′). 출처: a3-t8 보고서 수정 라운드 2, a3-t8 재리뷰. 미룬 까닭: 진입점을 테스트에서 띄우면 저장소 `data/dev-fake.sqlite` 를 지운다. 한 줄 배선이고 시작 로그의 `web` 값으로 손 확인이 된다. 싸게 잠그려면 몸통을 `runDevFakeCli(env, argv, start = startDevFake)` 로 빼고 가짜 `start` 가 받은 옵션을 본다(10줄 안팎).
- **채널 전환으로 칩이 빌 때 「초점을 건드리지 않는다」가 잠기지 않았다** — 칩을 빼면 초점을 옆 칩·「이미지 첨부」로 옮기는데(`f3379b8`), 보낸 뒤 비우기는 테스트가 「초점이 편집기에 남는다」를 잠그고 채널 전환 경로는 초점을 보지 않는다. 출처: a3-t9f 리뷰 m1. 미룬 까닭: Minor — 그 경로는 훅 안의 `clear` 라 클릭 핸들러를 거치지 않는다. 고침은 기존 「채널을 옮기면 칩을 비우고…」 테스트에 초점 단언 한 줄.
- **격자에서 불러오지 못한 이미지도 크게 보기 목록에 남는다** — 그 칸은 파일 카드로 물러나지만 뷰어 목록은 `MessageAttachments` 가 미리 만든다. 이웃 이미지에서 ←/→ 로 넘기면 깨진 이미지를 볼 수 있다. 출처: a3-t6 보고서 걱정, a3-t6 리뷰 「못 잰 것」. 미룬 까닭: 드문 경우이고 결함으로 올리지 않았다.
- **쉬고 있는 keep-alive 연결이 서버 종료를 붙잡는다** — undici `fetch`(keep-alive)로 요청한 뒤 `app.close()` 가 10초 상한(`APP_CLOSE_TIMEOUT_MS`)까지 기다렸다(`agent: false` 면 1.2초). 첨부 경로만의 성질은 아니다. 플러그인이 keep-alive 로 첨부를 주고받으면 서버 재기동이 최대 10초 늦어질 수 있다. 원인(`io.close()` 의 순서인지 Fastify `forceCloseConnections` 인지)은 확인하지 않았다. 출처: a3-t3 보고서 걱정 1. 미룬 까닭: 태스크 3 범위 밖의 기존 성질이다.
- **마우스로 연 크게 보기를 닫은 뒤 Safari 초점은 재지 않았다** — 뷰어는 닫을 때 기본 복귀를 막고(`onCloseAutoFocus` 의 `preventDefault`) 연 버튼으로 직접 돌려준다. Safari 는 클릭해도 버튼에 초점을 주지 않아 두 길이 갈릴 수 있는데, jsdom·Chromium 에서는 같은 곳을 가리켜 잠기지 않았다. 출처: a3-t6 리뷰 n2. 미룬 까닭: 이 머신의 Playwright 에 WebKit 이 없었다 — 사람 몫(`docs/guides/live-smoke.md` 9.3).
- **코어가 프롬프트에 스테이징 호스트 경로를 붙인다(실연 관찰 B)** — 이미지 인바운드 때 Gateway 코어가 claude CLI 프롬프트에 장마다 `[media attached i/N: <스테이징 호스트 경로> …]` 줄을 붙인다(`<ws>/media/inbound/openclaw-staged-<uuid>/…` — 가짜 CLI 의 `hostPathLines` 로 봤다). 우리 텍스트가 아니라 코어가 넣는 것이다. 모델이 이 경로를 답에 옮겨 쓰면 채널 본문에 호스트 경로가 들어간다. 우리 쪽 방어는 없다. 스트리밍 필터(스펙 11장 Ruling 6)는 줄 머리 `MEDIA:` 만 보므로 이것을 막지 않는다. 출처: `docs/guides/live-smoke.md` 13.4 B, a3-t11 보고서 「새로 찾은 결함」 관찰 B·걱정 2, a3-t12 보고서 걱정 3. 미룬 까닭: 코어가 넣는 텍스트라 우리 코드로 프롬프트에서 뺄 수 없다(a3-t11 걱정 2). 막으려면 에이전트 본문의 호스트 경로 꼴을 고쳐 싣는 규칙을 새로 정해야 한다. 위 「사람이 채팅에 쓴 호스트 경로」(스펙 10장)와 같은 계열이라 함께 정한다.
- **활동 탭의 툴 인자·결과에 호스트 경로가 있다(실연 관찰 C)** — 모델 런 ② 의 `Write` 인자 `file_path` 와 결과 `File created successfully at: /Users/…` 가 `TOOL_CALL_ARGS`·`TOOL_CALL_RESULT` 로 `run_events` 에 저장되고 활동 탭 툴 타임라인에 보인다. Ruling 6 필터는 텍스트 델타에만 걸린다. `TOOL_CALL_ARGS` 는 일부러 그대로 두었다(테스트로 잠갔다 — a3-t12 보고서). 출처: `docs/guides/live-smoke.md` 13.4 C, a3-t11 보고서 관찰 C, a3-t12 보고서 걱정 3. 미룬 까닭: 툴 타임라인이 원문을 보여 주는 것은 Phase 2 ① 부터의 설계다. 「호스트 경로를 드러내지 않는다」(스펙 9장)를 활동 탭까지 넓힐지는 판단이 필요하다(`live-smoke.md` 13.4 C).
- **Gateway 가 아웃바운드 스테이징 사본을 24시간 남긴다(실연 관찰 E)** — 툴 `media` 와 최종 응답 `MEDIA:` 줄은 Gateway 코어를 지나며 `~/.openclaw-dev/media/outbound/<이름>---<uuid>.<ext>` 사본을 남긴다. a3-t11 에서 8개, a3-t13 에서 런마다 1개가 생겼다. 툴로 보낸 8.7 MB PNG 는 **JPEG 4,047,716B** 사본도 생겼다(서버에는 원본 PNG 가 갔다). 위 「사본 셋」에 더해지는 넷째 사본이다. `MEDIA:` 줄의 사본은 스파이크 2-7, 툴 `media` 의 사본은 실연(a3-t11 관찰 E)이 처음 봤다. Gateway 가 24시간 뒤 지우는 것은 스파이크 보고서 「언제 지워도 되는가」(`OUTBOUND_STAGING_TTL_MS`, 코드 읽기)다. 출처: `docs/guides/live-smoke.md` 13.4 E·11.5 「끝나면」, a3-t11 보고서 관찰 E. 미룬 까닭: 실연이 결함이 아닌 관찰로 올렸다(판단 필요). 우리 코드가 만드는 사본이 아니고 코어가 스스로 지운다 — 「사본 셋」과 함께 운영 설정·설치 안내(`docs/guides/live-smoke.md` 6절)에서 다룬다.
- **스트리밍 필터·폴백이 `Media: …` 로 시작하는 보통 글 줄도 걷는다(a3-t12 재리뷰 N-1)**
  - 코어는 줄 머리가 `MEDIA:`(대소문자 무시)여도 페이로드가 `isValidMedia`(경로·URL·확장자 있는 파일 이름)일 때만 첨부로 뽑고, 아니면 줄을 그대로 둔다(9.5 `dist/parse-output-DGOcuzU4.mjs:258-320`).
  - 우리 줄 정의 `/^[ \t]*MEDIA:/i`(`apps/server/src/modules/runs/media-lines.ts:6-7`, 스트리밍 필터와 폴백 `stripMediaLines` 가 함께 쓴다)는 페이로드를 보지 않는다. 그래서 `Media: coverage was positive`·`Media: 이번 주 보도 요약입니다`·`MEDIA: 설명 문장` 을 걷는다(재리뷰가 코어 `splitMediaOutput` 를 직접 실행해 맞댔다).
  - 결과: ⓐ 정본(플러그인) 경로 — 스트리밍 버블에는 없던 줄이 정본에서 나타난다(덧붙는 튐). ⓑ 폴백(`finalizeFromSnapshot`) 경로 — 저장 메시지에서 그 줄이 **영구히 빠진다**. ⓒ `extendFinalizingForMedia` 가 그 줄을 미디어로 세어 finalizing 상한을 늘린다(무해, 대기만 길어진다).
  - 같은 종류(걷는 쪽): 코드 펜스 안 `MEDIA:` 줄도 걷는다(코어는 남긴다 — a3-t12 리뷰 「정본과 스트리밍의 일치」 1). 반대로 새는 쪽이 하나 있다: NBSP 들여쓰기 `MEDIA:` 줄은 코어 `trimStart()` 가 뽑는데 우리 `[ \t]*` 는 걷지 않는다(리뷰 Nit — 모델이 그렇게 쓸 일은 거의 없다).
  - 출처: a3-t12 재리뷰 「새 결함 N-1」, a3-t12 리뷰 「정본과 스트리밍의 일치」·「경계」.
  - 미룬 까닭: 걷는 쪽으로 틀리는 것은 호스트 경로 누출을 막는 안전한 방향이다. 대문자 `MEDIA: 설명` 은 고치기 전에도 같았다 — 범주는 기존이고, 대소문자 무시(`/i`)가 영어 산문에 흔한 `Media:` 머리글로 넓혔다. 스트리밍 중에는 줄이 끝나야 판정할 수 있어 코어의 `isValidMedia` 를 옮기는 것도 가볍지 않다.
  - 고친다면 재리뷰 권고대로 한다: 「줄이 끝났을 때 페이로드가 경로·URL·확장자 모양이 아니고 공백이 든 산문이면 내보낸다」를 필터·폴백 두 경로에 함께 넣는다. 한쪽만 고치면 스트림과 정본이 다시 어긋난다.

**PWA·푸시(Phase 2 ④, 2026-09-24)** — 스펙 `docs/superpowers/specs/2026-09-23-pwa-push-design.md` 10장(열린 문제)·11장(구현과 맞춘 것). 아래 출처의 보고서·리뷰(p4-t*)와 원장은 `.superpowers/sdd/2026-09-23-pwa-push/`(git 제외)에 있다.

- **실기기(iOS 16.4+ 홈 화면 PWA·안드로이드 Chrome) 푸시를 안 봤다** — 이번 확인은 데스크톱 Chromium(Google Chrome for Testing)이다. 출처: 스펙 결정 5·10장. 미룬 까닭: 푸시·서비스 워커는 보안 출처에서만 돌고, 실기기에는 HTTPS 배포(위 Phase 3 「Docker Compose 패키징」)가 필요하다. 그때 `VAPID_SUBJECT` 를 실제 연락처로 둔다(Apple 은 로컬 주체를 `403 BadJwtToken` 으로 거부 — `docs/guides/live-smoke.md` 14.2).
- **iOS 는 오래 안 쓴 설치 PWA 의 저장소를 지울 수 있다** — 오프라인 사본이 사라질 수 있다. 출처: 스펙 10장. 미룬 까닭: 플랫폼 정책이라 앱이 막을 수 없고, 사본이 없으면 지금처럼 오류 화면이다(스펙 7장).
- **푸시 서비스로 가는 메타데이터(언제·몇 번)는 드러난다** — 페이로드는 암호화되고 누가·어디·무엇만 싣지만, 발송 시각과 횟수는 FCM·APNs 가 본다. 출처: 스펙 10장. 미룬 까닭: 웹 푸시의 구조다. 줄이려면 알림 종류를 끄는 설정(스펙 1장 「후속」)이 먼저다.
- **presence 가 틀리는 두 방향** — ① 서버 재시작 직후 presence 가 빈 몇 초 동안은 보고 있어도 푸시가 간다(스펙 10장). ② 강제 종료(크래시·kill -9)로 FIN 없이 죽은 탭의 소켓은 socket.io ping 제한까지 presence 에 남아, 그동안 그 채널 푸시가 과하게 걸러진다(p4-t7 「확인됨」 2 — 여러 자동화 세션을 강제 종료하며 한 번 났고, 정상 종료 단일 세션에서는 재현되지 않았다). 또 서버는 `presence.update` 의 `channelId` 를 검증하지 않고 사용자당 소켓 수 상한도 없다(p4-t3 보고서 걱정 — 남의 채널 id 는 자기 알림을 덜 받게 할 뿐이고, 끊김마다 지워 새지는 않는다). 미룬 까닭: 모두 몇 초~수십 초의 틈이거나 자기 자신에게만 닿는다. presence 를 저장하거나 ping 을 줄이는 것은 비용이 이득보다 크다.
- **가려졌지만 `visible` 인 창이 있으면 승인 알림이 아무 데도 안 뜰 수 있다** — 같은 채널을 연 창이 다른 창에 **부분적으로 가려졌거나 포커스가 없어도** `document.visibilityState` 는 `visible` 이다. 그러면 서버는 「보고 있음」으로 푸시를 거르고(스펙 결정 2), 이 기기에 푸시가 켜져 있으면 탭 안 승인 알림도 쉰다(결정 8). 사람이 그 창을 안 보고 있으면 승인 요청을 놓친다. 출처: 원장 「이월(판단 필요)」, p4-t7 뒤. 미룬 까닭: 판단이 필요하다 — `document.hasFocus()` 를 presence 에 더하면 반대로 옆 창에서 보고 있는 사람에게도 푸시가 간다. 실제로 놓치는지는 사람이 본다(`docs/guides/live-smoke.md` 14.3).
- **구독 행이 세션과 묶이지 않는다 — 세션이 모두 만료된 사용자에게도 보낸다** — 서버는 `push_subscriptions` 의 사용자에게 살아 있는 세션이 있는지 보지 않는다. 로그아웃 없이 떠난 공유 브라우저에서는 그 사람의 알림이 세션 만료(30일, 쓸 때마다 연장) 뒤에도 계속 뜬다. 로그아웃의 서버 해지가 3초를 넘기거나 실패해도 행이 남는다(기기 구독은 해지되므로 다음 발송의 404·410 이 지운다). 출처: p4-t5 리뷰 「못 잰 것」 5, 원장 「이월(서버, 범위 밖)」. 미룬 까닭: 웹 쪽은 R8(401 에서 기기 구독 해지)로 「누군가 앱을 연 뒤」부터는 막았다. 근본은 서버 설계다 — 「발송 전에 살아 있는 세션이 없으면 보내지 않음/행 정리」를 정하려면 세션 테이블 조회를 발송 경로에 넣어야 해서 태스크 5(웹) 범위 밖이었다.
- **승인 기억 상한(1000)을 재는 테스트가 없다** — 같은 승인 중복 제거(`apps/server/src/modules/push/service.ts:212`·`:236-243`)의 FIFO 삭제를 빼도 기능 테스트는 초록이다. 출처: p4-t3 리뷰 m2(변이 M11 생존). 미룬 까닭: 메모리 상한이라 운영 영향이 작다(승인 1개당 uuid 1개). m1(사용자 단위 실패 로그 필드)만 고쳤다(`0ba1ad2`).
- **동기화 경로의 `userVisibleOnly: true` 가 잠기지 않았다** — `syncPushSubscription` 이 키가 바뀌어 다시 구독하는 자리(`apps/web/src/pwa/push.ts:212`)에서 `false` 로 바꿔도 테스트가 초록이다. 출처: p4-t5 재리뷰 Nit 1(변이 R14b). 미룬 까닭: 실제 Chrome 은 `false` 구독을 거부하고 catch 가 조용히 삼키므로 실물에서는 「키가 바뀐 뒤 재구독이 안 됨」으로만 드러난다. `enablePush` 쪽(R14)은 닫았다.
- **권한 물음을 닫아 `default` 로 끝난 경우의 패널 문구가 잠기지 않았다** — `NotifySettings.tsx:81` 의 `if (now !== "denied")` 를 `now === "granted"` 로 바꿔도 초록이다. 이때 「알림 권한을 허용해야 켤 수 있습니다」가 패널에 보이는지를 패널 테스트가 재지 않는다(`push.test.ts` 는 이유 문자열만 잰다). 출처: p4-t5 재리뷰 Nit 2(변이 F1c). 미룬 까닭: Nit — 지금 코드는 맞다.
- **서버만 죽고 브라우저는 온라인이면 토스트가 배너와 같은 말을 한 번 더 한다** — 오프라인 배너는 me 재시도(1초·2초) 뒤 약 3초에 뜨고, 그 사이 다른 쿼리의 재요청 실패가 기존 규칙대로 「서버에 연결할 수 없습니다」 토스트 하나를 낸다. 기기가 오프라인인 경우는 R7 로 닫혔다(요청 0·토스트 0). 출처: p4-t4 보고서 걱정 3, p4-t4 리뷰 실측 2. 미룬 까닭: 기존 `queryClient` 토스트 규칙(한 id 로 하나만)이고, 서버 사망을 브라우저가 미리 알 길이 없다.
- **localStorage 를 못 쓰는 브라우저는 앱을 열 때마다 기기 구독을 해지한다** — 플래그(켠 사용자 id)가 없으면 누가 켰는지 몰라 동기화가 해지한다. 출처: p4-t5 보고서 걱정 3. 미룬 까닭: 그런 브라우저(사생활 모드 등)는 대개 푸시 자체가 안 된다.
- **알려진 경고 셋(결함 아님, 고치지 않는다)** — 웹 빌드 `inlineDynamicImports option is deprecated`(vite-plugin-pwa#912)·`[baseline-browser-mapping] … over two months old`(#928), 서버 `url.parse()` 폐기 경고 DEP0169(web-push 3.6.7 내부, Node 24). 출처: 계획 Global Constraints·Self-Review 「실행 전 이슈 확인」. 미룬 까닭: 동작 영향이 없고, web-push 는 upstream main 에만 고침이 있고 3년째 릴리스가 없다(web-push#978). 의존성은 정확 핀으로 둔다(vite-plugin-pwa#933 — 메인테이너가 workbox 포크를 준비 중).

**실물 확인**

- **PWA·푸시의 실연(스펙 8.4, 계획 태스크 9)은 예정이다** — dev Gateway 에서 에이전트가 사람을 멘션하는 모델 런 1회(런 0회 하네스로 경로를 먼저 잰다). 결과는 `docs/guides/live-smoke.md` 14.4 에 적는다. 자동화가 원리상 못 잰 것(실제 OS 알림 클릭·설치 끝까지·macOS 알림 모양·가려진 창)은 14.3 — 사람이 한 번 봐야 한다. 브라우저 검증이 알림 누르기를 잰 것은 서비스 워커 안 합성 클릭(신뢰된 클릭만 허용되는 `waitUntil`·`focus`·`openWindow` 를 대행)이라, OS 창이 실제로 앞으로 오는지는 모른다.
- 첨부를 실물 dev Gateway(2026.9.5)로 본 것은 스파이크(모델 런 2회), 실연(a3-t11 — 런 0회 하네스 합격 기준 9/9 + 모델 런 2회, `docs/guides/live-smoke.md` 13절), 결함 A 고침 확인(a3-t13 — 런 0회, 13.7절)이다. 9.4 런타임과 원격 Gateway 는 아직 안 봤다(위 이월). 자동화가 원리상 못 잰 것(실제 OS 클립보드 붙여넣기·끌어다 놓기·Safari 초점)은 `docs/guides/live-smoke.md` 9.3 — 사람이 한 번 봐야 한다.
- 승인을 실물 Gateway·실제 모델로 본 것은 스파이크 1회(`.superpowers/sdd/2026-09-20-phase2-approval-spike/`)뿐이다. 웹 화면까지 실물로 도는 절차는 `docs/guides/live-smoke.md` 8절.
- 자동 검증이 원리상 못 재는 것들(실제 소리·OS 알림 클릭으로 탭이 앞에 오는가·권한 팝업 모양·잠금 화면·VoiceOver 가 조건부 `aria-live` 를 읽는가)은 **1차 검증도 재검증(p2-t13)도 못 쟀다** — 사람이 한 번 봐야 한다. 절차와 「재검증이 대신 어떻게 흉내 냈나」는 `docs/guides/live-smoke.md` 9절.
- 승인 재접속 복구의 「**서버 재기동 뒤** 미해결 승인이 돌아온다」는 `dev:fake` 로는 끝내 못 본다 — 서버를 재기동하면 가짜 Gateway 도 상태를 잃기 때문이다. 재검증은 서버를 살린 채 wire 소켓만 끊어 「앱이 구독 ack 로 미해결을 되살린다」까지만 확인했다(p2-t13 시나리오 5). 실물 Gateway 의 `approvalReplay` 경로는 다음 실연 몫이다(`docs/guides/live-smoke.md` 8절).

---

## 9. 리스크와 대응

| 리스크 | 영향 | 대응 |
| --- | --- | --- |
| OpenClaw 프로토콜/플러그인 SDK 변경 속도가 빠름 (월 단위 릴리스) | 연동 파손 | Gateway와 동일 버전 핀 + 동반 업그레이드, `protocol.schema.json` 기반 계약 테스트, 어댑터 레이어로 격리. CHANGELOG의 "Deferred to next wire version" 항목을 릴리스마다 확인 |
| 원격 Gateway ↔ 서버 브리지 네트워크(방화벽·TLS·터널·재연결) | 인바운드/아웃바운드 유실 | 플러그인 아웃바운드 접속(Gateway 쪽 포트 개방 불필요), 지수 백오프 재접속, 플러그인 측 아웃바운드 큐 + `runId` 중복 제거, 브리지 헬스 상태를 UI에 표시 |
| 채널 플러그인의 `components` 확장이 문서만큼 일반화되어 있지 않을 수 있음 | UI 요구사항(F-5) 지연 | Phase 0에서 검증. 실패 시 대안: 에이전트에게 우리 전용 `ui_render` 툴(`registerTool`) 제공 |
| 두 경로(플러그인·WS)로 같은 응답이 중복 수신 | 메시지 중복/순서 꼬임 | `runId` 기준 dedupe, 플러그인 경로를 "정본", WS 경로를 "미리보기"로 고정 |
| OpenClaw 채널 봇 루프 보호가 우리 릴레이를 차단 | 릴레이 불능 또는 이중 상한 | 확인 끝(ADR 0002 7절): 기본값은 막지 않는다 — 플러그인이 사실을 넘길 때만 동작(20회/60초). 조정은 사실 전달 여부 + 채널 설정, 결정은 ADR 0002 12절 3 |
| 에이전트 간 릴레이 무한 루프·비용 폭주 | 비용·소음 | 턴 상한, 쌍 허용 목록, 반복 해시 감지, 채널별 일일 런 상한 |
| claude-cli 재개 세션이 채널 프롬프트 변경을 무시(ADR 0003 3절) | 에이전트가 옛 규칙으로 답함 | 서버가 세션별 프롬프트 리비전을 추적해 불일치 시 `ChannelPromptContext` 동봉(10장 #1), 「새 대화」는 `sessions.reset`(#15), 업스트림 보고는 보류(#20) |
| 디바이스 페어링·토큰 관리가 셀프호스팅 사용자에게 어려움 | 온보딩 이탈 | 설정 마법사에서 `PAIRING_REQUIRED` 안내·요청 ID 표시·재시도. 디바이스 키·토큰은 서버 `data/`에만 저장 |
| `openclaw` 패키지 크기(unpacked 200MB급) | 플러그인 설치·CI 시간 | devDependency로만 사용, CI 캐시, 플러그인 번들은 SDK를 external로 두고 Gateway가 제공하는 것을 사용 |
| 노드 exec 이벤트 best-effort | 작업 로그 누락 | UI에 "일부 누락 가능" 표시, `approval.history`·`chat.history`로 보완 |
| Hermes 커스텀 어댑터 경로 불명확 | 후속 연동 지연 | 후속 단계 초입에 별도 조사 스파이크 |

---

## 10. 결정 사항

| # | 항목 | 결정 | 확정일 |
| --- | --- | --- | --- |
| 1 | 채널 프롬프트 주입 방식 | **(a) 채널별 `systemPrompt` 설정(플러그인 내부 쓰기 a-1)이 기준선.** claude-cli 기존 세션에는 설정 변경이 들어가지 않으므로(ADR 0003 3절) 서버가 세션별로 「세션 시작 시점의 채널 프롬프트 리비전」을 기억해 현재와 다르면 인바운드 `context.channelPrompt` 를 채우고 플러그인이 `ChannelPromptContext` 로 싣는다(ADR 0003 7.1). 새 세션(첫 턴·리셋 뒤)은 싣지 않는다. 에이전트별 `promptOverride` 도 헤더 줄 대신 `ChannelPromptContext`(전사 오염 방지, 같은 이유). 프롬프트 변경으로 리셋·회전하지 않는다 | 2026-09-14 (v0.4) · **2026-09-15 확정**(ADR 0003 10절 1 = ADR 0002 12절 5) |
| 2 | 에이전트 내부 위임(`sessions_send`) | **MVP 차단** — `tools.agentToAgent.enabled: false`, `tools.sessions.visibility: "tree"`. 서브에이전트 스폰은 허용. 상세 5.8 | 2026-09-14 |
| 3 | OpenClaw 세션 키 단위 | **채널당 에이전트별 1세션** `agent:<agentId>:dodok:channel:<channelId>`, 스레드는 후속 하위 세션. 상세 5.8 | 2026-09-14 |
| 4 | 자동 응답 에이전트 | 채널당 1개 허용, 기본값은 꺼짐 | 2026-09-14 |
| 5 | PWA 푸시 알림 | MVP 포함 — 멘션·승인 요청·릴레이 한도 도달 시 발송 | 2026-09-14 |
| 6 | Gateway 호스팅 관계 | **본인 운영 원격 Gateway 연결이 기본**. 플러그인은 Gateway 호스트에 설치되어 우리 서버 브리지로 아웃바운드 WSS 접속. Compose 프로필로 로컬 동반 기동 옵션 제공 | 2026-09-14 (v0.4 변경) |
| 7 | 프로젝트·플러그인 이름 | **`dodok`** — 저장소 dodok.chat, npm 스코프 `@dodok/*`, 플러그인 id `dodok`, 설정 키 `channels.dodok.*`, 세션 키의 채널 세그먼트 `dodok` | 2026-09-14 (v0.4) |
| 8 | OpenClaw 버전 정책 | 세 패키지를 **배포 Gateway와 같은 버전으로 정확 핀**. 시작은 2026.9.4(Gateway 업그레이드 후). 프로토콜 v4. 업그레이드는 Gateway와 같은 PR에서 | 2026-09-14 (v0.4) |
| 9 | 실시간 전송 | **Socket.IO** (채널 = 룸, ack, 자동 재연결). `ws` 직접 구현은 채택하지 않음 | 2026-09-14 (v0.4) |
| 10 | 브리지 방향·인증 | 플러그인 → 서버 **아웃바운드 WSS**, 공유 토큰 인증, 브리지는 Socket.IO 네임스페이스 `/bridge`(Caddy 는 `/socket.io` 만 노출). 플러그인 측 아웃바운드 큐로 단절 내성 | 2026-09-14 (v0.4) |
| 11 | 저장소 Node 버전 | **Node 24 로 전환** — `mise.toml` 에 node 24.21.0 · pnpm 11.16.0 핀, `engines >=24.16.0 <25`, `.npmrc engine-strict`. openclaw 2026.9.4 의 engines 와 일치하고 플러그인 `channel.ts` 를 SDK 테스트 유틸(`docs/plugins/sdk-testing.md`)로 단위 테스트할 수 있다. Docker 이미지도 node:24 | 2026-09-15 (ADR 0002 12절 1) |
| 12 | `components` 노출 방식 | **Phase 1 은 (a) `describeMessageTool` 스키마 조각**(동작 확인, SDK 방침과 충돌 리스크). (b) `presentation` capability → components v1 매핑을 병행 설계해 두고 코어 업그레이드 PR 마다 조각 노출을 회귀 확인. (c) `ui_render` 툴은 채택하지 않음 | 2026-09-15 (ADR 0002 12절 2) |
| 13 | 봇 루프 보호와 `relayPolicy` | **(2) 플러그인이 사실(발신자가 봇인지 등)을 넘기고 코어 예산은 우리 `maxRelayTurns` 보다 느슨하게** 두어 안전망으로만 쓴다. 릴레이 상한의 정본은 서버 `relayPolicy` | 2026-09-15 (ADR 0002 12절 3) |
| 14 | 브리지 계약 보강 | `InboundDeliverResult` 에 **`admission: "dispatch" \| "drop"` 과 `reason?`** 추가 — 서버가 「런 없이 끝남」을 릴레이 한도 메시지로 바꿀 수 있게. `providerRunId` 는 존치하되 값은 우리 `runId` 와 같다(ADR 0002 4.3) | 2026-09-15 (ADR 0002 12절 4) |
| 15 | 「새 대화」와 Gateway 스코프 | 서버의 Gateway 연결은 **`operator.admin` 을 포함해 요청**, 「새 대화」= `sessions.reset`(`sessionId` 는 유지되므로 `sessionStartedAt`·`lifecycleRevision` 으로 판별). 원격 공유 토큰이 admin 을 주는지는 Phase 1 첫 작업에서 확인하고, 거부되면 키 세대 회전(`:g<N>`)으로 폴백 | 2026-09-15 (ADR 0003 10절 2) · **원격 실측(2026-09-15): 부여** — `grantedScopes` 에 `operator.admin` 포함, `sessions.reset` → `resetOutcome: ok`(`{"ok":true,"key":...,"entry":{...}}`) |
| 16 | 재접속 복구 | `sessions.list` → 선택 세션 `chat.history`(limit) **전체 치환**이 기본. `deltaCursor` 가 오면 저장해 다음 재접속에 `cursor` 로 먼저 시도하고 `kind:"reset"` 이면 전체 치환으로 — 최적화일 뿐(claude-cli 세션은 커서 없음). 메시지 정본은 서버 DB | 2026-09-15 (ADR 0003 10절 3) |
| 17 | `chat.send` 대체 경로 | **MVP 미사용.** 비상 경로가 필요하면 `deliver` 없이 `chat.send` 만 보내고 WS `chat` final 을 서버 메시지로 쓴다 | 2026-09-15 (ADR 0003 10절 4) |
| 18 | 플러그인 `inboundChannelPrompt` 설정 키 | **제거.** 인바운드 `context.channelPrompt` 가 있으면 플러그인은 항상 `ChannelPromptContext` 로 싣고, 채울지 판단(리비전 불일치)은 서버가 한다. `InboundContext` 에 리비전 필드는 두지 않는다 | 2026-09-15 (ADR 0003 10절 5) |
| 19 | 세션 키 세대 접미사 `:g<N>` | **플러그인 수용 코드 제거**(#15 로 리셋을 쓴다). 폴백이 필요해지면 되살린다. 세션 키 규칙은 원형 유지 | 2026-09-15 (ADR 0003 10절 7) |
| 20 | 업스트림 이슈 보고 | **보류** — MVP 뒤 재검토. 재현 절차는 ADR 0003 3.1(P0→P1) | 2026-09-15 (ADR 0003 10절 6) |
| 21 | 로컬 첫 에이전트 id | dev 프로필(`openclaw --dev`)은 `main` 을 만들 수 없으므로 로컬 개발 문서는 **`dev`** 를 첫 에이전트로 쓴다. `doctor --fix` 절차는 적지 않는다 | 2026-09-15 (ADR 0002 12절 6) |

Phase 0 의 미확정 사항은 위 #1·#11~#21 로 전부 확정됐다. 구현 중에 재는 열린 질문은 ADR 0002 11절·ADR 0003 9절에 있다.

---

## 11. 참고 자료

- OpenClaw Gateway 아키텍처: https://docs.openclaw.ai/concepts/architecture
- Gateway 프로토콜 (v4): https://docs.openclaw.ai/gateway/protocol
  - 세션 제어 메서드: https://docs.openclaw.ai/gateway/protocol/rpc-session-control
  - 세션 부트스트랩·이벤트: https://docs.openclaw.ai/gateway/protocol/rpc-bootstrap-and-events
  - 디바이스·노드·승인: https://docs.openclaw.ai/gateway/protocol/rpc-devices-nodes-and-approvals
- Gateway 클라이언트 만들기: https://docs.openclaw.ai/gateway/clients
- npm 패키지: https://www.npmjs.com/package/@openclaw/gateway-client · https://www.npmjs.com/package/@openclaw/gateway-protocol (README·CHANGELOG에 와이어 버전 이력) · https://www.npmjs.com/package/openclaw (`plugin-sdk/*`)
- 플러그인 내부 구조: https://docs.openclaw.ai/plugins/architecture
- Discord 컴포넌트·승인: https://docs.openclaw.ai/channels/discord/rich-messages
- 멀티에이전트 라우팅: https://docs.openclaw.ai/concepts/multi-agent
- 세션 툴(sessions_send/spawn, agentToAgent, visibility): https://docs.openclaw.ai/concepts/session-tool
- 그룹 세션 키·groupScope·requireMention: https://docs.openclaw.ai/channels/groups
- announce step 관련 이슈: https://github.com/openclaw/openclaw/issues/7463 · https://github.com/openclaw/openclaw/issues/105503 · https://github.com/openclaw/openclaw/issues/55981
- 에이전트 설정: https://docs.openclaw.ai/gateway/config-agents
- Discord 채널 설정(systemPrompt·requireMention 등): https://docs.openclaw.ai/gateway/config-channels/community-chat#discord
- Codex app-server 프로토콜: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Open WebUI Channels: https://docs.openwebui.com/features/channels/ · 라이선스: https://docs.openwebui.com/license/
- OpenClaw ↔ Open WebUI Channels 플러그인: https://github.com/Skyzi000/openclaw-open-webui-channels
- Streamdown: https://github.com/vercel/streamdown · AI Elements: https://github.com/vercel/ai-elements
- AG-UI 프로토콜: https://github.com/ag-ui-protocol/ag-ui/
- Better Auth: https://github.com/better-auth/better-auth
- AI 채팅 UI 라이브러리 비교(2026): https://dev.to/alexander_lukashov/i-evaluated-every-ai-chat-ui-library-in-2026-heres-what-i-found-and-what-i-built-4p10
- A2A 플러그인 브리지 사례(확장점 참고): https://www.freecodecamp.org/news/openclaw-a2a-plugin-architecture-guide/
- Hermes Agent 메시징 게이트웨이: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/
