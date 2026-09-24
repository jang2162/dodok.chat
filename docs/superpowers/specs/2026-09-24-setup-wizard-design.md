# Phase 3 ② 설정 마법사(연결 점검·브리지 토큰) 설계

**상태**: 설계 확정(2026-09-24)
**범위**:
- 웹 「연결」 페이지: 서버·Gateway·페어링·플러그인·브리지의 상태, 다음에 할 일, 복사할 명령·설정
- 서버가 품은 플러그인 파일 내려받기
- 브리지 토큰을 DB 로 옮겨 웹에서 발급·겹침 교체·폐기

**앞선 근거**:
- 계획서 `docs/plan.md` 8장 Phase 3 「설정 마법사(Gateway URL·토큰·페어링·플러그인 설치 안내와 브리지 URL/토큰 발급)」
- Phase 3 ① 스펙 `2026-09-24-deploy-packaging-design.md`(결정 7 — 웹 설정은 ②), `docs/guides/deploy.md`
- ADR 0001(페어링 실측)·0002 9절(원격 플러그인 설치)·0004(플러그인 전역 레지스트리), `docs/guides/live-smoke.md` 3절(플러그인 설치 절차)
- 사용자가 미뤄 둔 BRIDGE_TOKEN 교체

---

## 0. 결정 (브레인스토밍 2026-09-24)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **점검·안내 + 브리지 토큰만 웹에서.** Gateway URL·토큰·인증 설정은 `.env` 그대로, 어댑터를 실행 중에 다시 만들지 않는다 | Gateway 설정은 한 번 정하면 거의 안 바뀐다. 번거로운 것은 페어링 승인·플러그인 설치·브리지 토큰이다. 어댑터 재생성은 연결·세션 복구 전체를 건드려 비용이 크다. |
| 2 | **브리지 토큰은 겹침 교체, 원문은 발급 때 한 번만 보인다.** DB 에는 해시만 둔다 | 새 토큰을 플러그인에 넣고 다시 붙기까지 에이전트가 멈추지 않는다. DB·백업이 새도 토큰은 안 샌다. |
| 3 | **`.env` 의 `BRIDGE_TOKEN` 은 첫 부팅 때 첫 토큰(라벨 `env`)으로 이어받는다.** 그 뒤로는 선택이다 | 이미 배포된 플러그인 설정이 그대로 붙는다. |
| 4 | **서버 이미지가 같은 커밋의 플러그인 tgz 를 품고 웹에서 내려준다** | 개발 PC 없이도 Gateway 호스트에 설치할 파일을 얻는다. 서버와 플러그인이 같은 빌드인지 확인할 수 있다. |
| 5 | **플러그인과 서버의 「같은 빌드」는 번들 파일 sha256 으로 가른다** — 플러그인이 부팅 때 자기 번들을 해시해 hello 에 싣는다 | 플러그인 `package.json` 버전은 늘 `0.0.0` 이라 버전 문자열로는 못 가른다. 빌드 산출물에 자기 해시를 박으면 순환이 생긴다. |
| 6 | **setup API 는 owner 만** 쓴다(`memberships.role = "owner"`) | 연결·토큰은 워크스페이스 관리 권한이다. 지금 사용자는 owner 하나지만 Phase 4 의 팀 초대를 막지 않게 경계를 둔다. |

---

## 1. 범위

**한다**
- 서버 `modules/setup/`: 점검 상태, 브리지 토큰(발급·목록·폐기), 플러그인 파일 내려받기
- 어댑터: 브리지 인증을 검증 함수로 바꾸고, 세션이 쓴 토큰 id 를 기억하고, 폐기되면 그 세션을 끊는다
- shared: `BridgeHello.bundleSha256`(선택), setup API 계약, wire `setup.status` 이벤트
- 플러그인: 부팅 때 자기 번들 sha256 을 계산해 hello 에 싣는다
- 서버 이미지(Phase 3 ①의 `Dockerfile.server`)가 플러그인 tgz 를 빌드해 품는다
- 웹 `/settings/connection` 페이지, 사이드바 진입점, 연결 배너의 「연결 설정 보기」 링크
- `.env` 의 `BRIDGE_TOKEN` 을 선택으로 바꾼다(없어도 부팅한다)

**하지 않는다**
- Gateway URL·토큰을 웹에서 바꾸기, 설정 없이 부팅하는 첫 실행 마법사(결정 1)
- Gateway 호스트를 원격으로 조작(플러그인 설치·설정 패치를 RPC 로) — 명령을 보여 주고 사람이 돌린다
- 토큰 만료 기한, 토큰별 권한 범위
- 여러 플러그인 계정·여러 Gateway(Phase 4)

---

## 2. 구조

### 2.1 서버 — `apps/server/src/modules/setup/`
- `tokens.ts`: `bridge_tokens` 저장소
  - 원문 형식: `dbt_` + 무작위 32바이트 base64url
  - 해시: `sha256(원문)`(hex). 알아보기용 `prefix` 는 원문의 `dbt_` 뒤 6자.
  - `issueBridgeToken(db, label)` → `{ token(원문), record }`
  - `verifyBridgeToken(db, presented)` → `{ tokenId } | null` — 활성 해시들과 `timingSafeEqual`, 맞으면 `lastUsedAt` 갱신(1분에 한 번까지)
  - `listBridgeTokens(db)`, `revokeBridgeToken(db, id)`
  - `importEnvToken(db, envToken)`: 테이블이 비었을 때만 라벨 `env` 로 넣는다
- `status.ts`: 어댑터 상태 + 플러그인 파일 정보 + 서버 버전을 모아 `SetupStatus` 를 만든다(순수 조립)
- `plugin-file.ts`: 품은 tgz 를 찾고(이미지 `/app/plugin/`, 개발 `packages/openclaw-plugin/dist/`) sha256·크기·안의 `dist/index.js` sha256 을 부팅 때 한 번 계산
- `routes.ts`: 3장 API

### 2.2 DB — 새 테이블 `bridge_tokens`
`id`(uuid v7), `workspace_id`, `label`(1~60자), `hash`(unique), `prefix`, `created_at`, `last_used_at`(nullable), `revoked_at`(nullable). drizzle 마이그레이션.

### 2.3 어댑터 — `packages/openclaw-adapter`
- `bridge.token: string` → `bridge.verifyToken: (presented: unknown) => { tokenId: string } | null`
- 브리지 세션(`bridge/session.ts`)이 `tokenId` 를 기억하고, `status()` 의 플러그인 요약에 싣는다
- `revokeBridgeSessions(tokenId)`: 그 토큰으로 붙은 소켓을 끊는다(사유 로그 한 줄)
- 상태 요약 확장(`AdapterStatus` 는 그대로 두고 어댑터의 **내부 상세** `setupDetail()` 로):
  - `gateway: { state, host, version, pairing: { requestId, since } | null }` — 페어링 오류(`connection-manager.ts` 의 `gateway pairing required`)를 상태로 남긴다
  - `bridge: { state, plugin: { version, sdkVersion, gatewayVersion, bundleSha256, tokenId, connectedAt } | null }`

### 2.4 플러그인 — `packages/openclaw-plugin`
- 부팅 때 자기 번들 파일(`import.meta.url` 이 가리키는 파일)을 읽어 sha256 을 계산해 `BridgeHello.bundleSha256` 에 싣는다. 읽기 실패는 필드를 빼고 계속한다.
- ADR 0004 대로 번들이 세대마다 다른 경로에서 평가돼도 내용은 같으므로 해시는 같다.

### 2.5 서버 이미지 — `infra/Dockerfile.server`
- build 단계에서 `pnpm -F @dodok/openclaw-plugin run pack:plugin` → tgz 를 runtime 의 `/app/plugin/` 로 복사.
- `openclaw` 패키지(devDependency, 약 200 MB)가 플러그인 빌드에 필요하면 build 단계에서만 설치한다(runtime 이미지는 커지지 않는다). 설치 범위는 계획이 실측으로 정한다.

### 2.6 shared
- `BridgeHello.bundleSha256: z.string().regex(/^[0-9a-f]{64}$/).optional()`
- `SetupStatus`, `BridgeTokenRecord`(원문 없음), `IssueBridgeTokenInput { label }`, `IssueBridgeTokenResult { token, record, pluginConfig }`
- wire `ServerToClientEvents["setup.status"]: (p: { status: SetupStatus }) => void` — owner 사용자 룸에만

### 2.7 웹 — `apps/web/src/features/setup/`
- `ConnectionPage.tsx`(`/settings/connection`), 섹션 넷(4장)
- `IssueTokenDialog.tsx`: 라벨 입력 → 발급 → 원문·설정 조각 한 번 표시 → 닫으면 캐시에서도 지운다
- 사이드바 하단 「연결」 링크(owner 에게만), 기존 연결 배너(`Banners.tsx`)에 「연결 설정 보기」 링크
- setup 쿼리는 오프라인 사본(`pwa/persist.ts` 의 `shouldPersist`)에서 뺀다

---

## 3. API (전부 owner 세션)

| 메서드·경로 | 응답 |
| --- | --- |
| `GET /api/v1/setup/status` | `SetupStatus` |
| `GET /api/v1/setup/bridge-tokens` | `{ tokens: BridgeTokenRecord[] }` — 폐기된 것 포함, 원문 없음 |
| `POST /api/v1/setup/bridge-tokens` `{ label }` | `IssueBridgeTokenResult`, `Cache-Control: no-store` |
| `DELETE /api/v1/setup/bridge-tokens/:id` | 204 — 폐기 + 그 토큰의 브리지 세션 끊기 |
| `GET /api/v1/setup/plugin.tgz` | 파일(`Content-Disposition: attachment; filename="dodok-openclaw-plugin-<sha 앞 12자>.tgz"`), 없으면 404 `PLUGIN_FILE_MISSING` |

`SetupStatus`:
```ts
{
  server: { version: string };
  gateway: { state: "connected" | "reconnecting" | "down"; host: string; version: string | null;
             pairing: { requestId: string; since: string } | null };
  bridge: { state: "connected" | "down"; publicUrl: string;
            plugin: { version: string; sdkVersion: string; gatewayVersion: string | null;
                      bundleSha256: string | null; tokenId: string | null; connectedAt: string } | null };
  pluginFile: { available: true; sha256: string; bundleSha256: string; bytes: number } | { available: false };
  pluginMatches: boolean | null;   // 접속 플러그인과 서버가 품은 파일이 같은 빌드인가, 모르면 null
  envTokenIgnored: boolean;        // .env 에 BRIDGE_TOKEN 이 있는데 DB 활성 토큰과 다르다
}
```
- `gateway.host` 는 URL 의 호스트만(경로·쿼리·자격 증명 없음). Gateway 토큰은 어디에도 없다.
- `bridge.publicUrl` 은 `BRIDGE_PUBLIC_URL`, 없으면 `APP_ORIGIN` 의 `https:`→`wss:` + `/bridge`.
- `pluginConfig`(발급 결과)는 Gateway 호스트에 넣을 JSON 조각: `{ "channels": { "dodok": { "accounts": { "default": { "bridgeUrl": "<publicUrl>", "token": "<원문>" } } } } }`.

---

## 4. 연결 페이지

| 섹션 | 보이는 것 | 다음에 할 일 |
| --- | --- | --- |
| 서버 | 버전 | — |
| Gateway | 상태·호스트·버전 | `down`: `.env` 의 `OPENCLAW_GATEWAY_URL`·토큰과 서버 로그 확인 안내. 페어링 대기: `requestId` 와 복사할 `openclaw devices approve <requestId>`, 5분 넘으면 강조 |
| 플러그인 | 접속 여부·SDK·Gateway 버전·같은 빌드인가 | 「플러그인 받기」(sha256 표시)와 Gateway 호스트에서 돌릴 명령(live-smoke 3절 절차: Gateway 내리기 → 설치 → sha 확인 → 올리기) 복사. 빌드가 다르면 「받아서 다시 설치」 경고 |
| 브리지 토큰 | 목록(라벨·`dbt_` + 앞 6자·만든 때·마지막 사용·「지금 접속 중」·폐기됨) | 「새 토큰 발급」, 폐기. `.env` 무시 표시 |

**교체 흐름**(화면 안내)
1. 「새 토큰 발급」 → 라벨 → 원문과 `pluginConfig` 가 한 번 보이고 복사 버튼이 있다. 「복사했습니다」를 눌러야 닫힌다.
2. Gateway 호스트에서 설정 적용·Gateway 재기동 — 옛 토큰도 통하므로 에이전트는 멈추지 않는다.
3. 플러그인이 새 토큰으로 붙으면 「지금 접속 중」이 옮겨 가고(wire `setup.status`), 옛 토큰 줄에 「이제 폐기해도 됩니다」가 뜬다.
4. 옛 토큰 폐기. 접속 중인 토큰을 폐기하려 하면 「에이전트가 멈춘다」 확인, 활성 토큰이 0개가 되면 한 번 더 확인.

---

## 5. 보안

- 원문은 발급 응답에만 있다 — DB·로그·목록·wire·오프라인 사본 어디에도 없다. 응답에 `Cache-Control: no-store`, 서비스 워커는 `/api` 를 저장하지 않는다(Phase 2 ④).
- 비교는 해시끼리 `timingSafeEqual`. 폐기된 토큰의 접속은 지금과 같은 `token mismatch` 로그(IP 만).
- 발급·폐기는 기존 세션 쓰기 규칙(Origin 검사·쿠키)을 따른다. owner 가 아니면 403.
- `plugin.tgz` 는 owner 만 받는다.
- 브리지 핸드셰이크 실패가 잦으면 기존 레이트리밋 규칙을 따른다(새 규칙은 Phase 3 ③).

---

## 6. 오류 처리

| 상황 | 동작 |
| --- | --- |
| 활성 토큰 0개 | 브리지 접속은 모두 거절, 연결 페이지 브리지 섹션이 「토큰이 없습니다 — 발급하세요」 |
| `.env` 에 `BRIDGE_TOKEN` 도 없고 DB 도 비었다(새 배포) | 서버는 부팅한다(지금은 필수 — 선택으로 바꾼다), 위와 같다 |
| `.env` 의 `BRIDGE_TOKEN` 이 DB 활성 토큰과 다르다 | 부팅 warn 한 줄, 화면 한 줄(`envTokenIgnored`). 이어받지 않는다 |
| 플러그인 파일이 없다(개발에서 빌드 안 함) | 받기 대신 만드는 법(`pnpm -F @dodok/openclaw-plugin run pack:plugin`) |
| 플러그인이 `bundleSha256` 을 안 보낸다(옛 플러그인) | `pluginMatches: null` — 「빌드를 알 수 없습니다, 새로 받아 설치하세요」 |
| 폐기 중 브리지 세션 끊기 실패 | 폐기는 된다(다음 핸드셰이크부터 거절), warn 로그 |

---

## 7. 테스트

- **서버 단위**: 토큰 발급 형식·해시만 저장·검증(맞음·틀림·폐기됨)·`lastUsedAt` 갱신 빈도, env 이어받기(빈 테이블일 때만 1회), `SetupStatus` 조립(`publicUrl` 유도, `pluginMatches` 세 값, `envTokenIgnored`), 플러그인 파일 정보.
- **서버 통합**(가짜 Gateway·플러그인): 두 토큰 겹침 접속 → 폐기 → 그 세션 즉시 끊김·재접속 거절, 첨부 HTTP 가 같은 검증을 쓴다(폐기 토큰 401), owner 가 아니면 403, 원문이 로그·목록·wire 이벤트에 없다(캡처), `setup.status` 이벤트가 owner 에게만, 페어링 대기 상태가 `requestId` 로 보인다.
- **어댑터**: `verifyToken` 계약, 세션 `tokenId`, `revokeBridgeSessions`.
- **플러그인**: hello 의 `bundleSha256` 이 번들 파일 sha256 과 같다, 읽기 실패면 필드 없음.
- **웹**: 상태별 문구, 발급 원문 한 번 표시(닫으면 쿼리 캐시에도 없음), 교체 안내, 폐기 확인 두 단계, owner 아니면 진입점 없음.
- **브라우저 검증**(dev:fake, 5180): 발급 → 가짜 플러그인을 새 토큰으로 다시 붙임 → 「지금 접속 중」 이동 → 옛 것 폐기 → 옛 토큰 재접속 거절, 플러그인 받기 sha256 = 서버 표시. dev:fake 가 「가짜 플러그인 토큰 바꾸기」를 할 수 있어야 한다(계획이 dev:fake 에 훅을 더한다).
- **실연**(로컬 dev Gateway, 모델 런 0, dev 프로필만): 서버가 품은 tgz 를 dev Gateway 에 설치(live-smoke 3절) → `bundleSha256` 일치 → 새 토큰으로 dev 플러그인 설정 교체 → 접속 이동 → 옛 토큰 폐기.
- **Compose**: 운영 이미지에 `/app/plugin/*.tgz` 가 있고, 받은 파일 sha256 이 빌드본과 같다(Phase 3 ① 의 로컬 검증 명령 재사용, `docker … prune` 금지).

---

## 8. 완료 기준

- 웹 「연결」 페이지 하나로 Gateway·페어링·플러그인·브리지 상태와 다음 할 일을 알고, 명령·설정을 복사할 수 있다.
- 브리지 토큰을 웹에서 발급·교체·폐기하고, 교체 중 에이전트가 멈추지 않는다. 원문은 한 번만 보이고 어디에도 남지 않는다.
- 서버가 품은 플러그인을 받아 설치하면 「같은 빌드」로 표시된다.
- 서버 통합·웹 단위·브라우저 검증 결함 0, 검사 4종 통과, dev Gateway 실연 통과.

---

## 9. 열린 문제 (범위 밖 기록)

- Gateway URL·토큰의 웹 설정·설정 없는 첫 실행(결정 1) — 필요해지면.
- 토큰 만료·자동 교체 알림.
- Gateway 호스트 원격 조작(플러그인 설치·설정 패치 RPC) — ADR 0002: `plugins.install` 은 `clawhub`·`official` 원천만 받는다.
- 여러 플러그인 계정·여러 Gateway(Phase 4).
