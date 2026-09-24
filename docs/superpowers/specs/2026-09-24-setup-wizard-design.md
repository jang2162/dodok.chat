# Phase 3 ② 설정 마법사(연결 점검·브리지 토큰) 설계

**상태**: 설계 확정(2026-09-24), 구현·브라우저 검증 완료(2026-09-25 — 계획 태스크 1~6, 브라우저 시나리오 1~10 결함 1 고침, 테스트 2400) — 구현이 이 설계와 달라진 것은 「구현과 맞춘 것」 장. 실연은 `docs/guides/live-smoke.md` 15절, 운영 절차는 `docs/guides/deploy.md`
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

---

## 10. 구현과 맞춘 것 (2026-09-25)

구현(계획 태스크 1~6)·리뷰·브라우저 검증과 그 수정 라운드에서 이 설계와 달라지거나 설계가 정하지 않은 것을 정한 자리만 모았다. main `eef129b` 기준이다.
정본 근거는 실행 원장 `.superpowers/sdd/2026-09-24-setup-wizard/ledger.md`(git 제외)의 판정 R1·Ruling 과, 원장이 가리키는 보고서·리뷰(`s2-t*`·`s2-c1`)다. 보고서의 커밋 해시는 워크트리 것이라 main 에서는 다르다 — 아래 해시는 main 의 것이다.
운영 절차는 `docs/guides/deploy.md`(「[웹 → B] 플러그인 설치·브리지 토큰」·「[웹] 브리지 접속 확인」·「브리지 토큰 교체」 절), 실연은 `docs/guides/live-smoke.md` 15절, 남은 문제는 `docs/plan.md` 8장 「이월」 한곳에 있다. 각 파일이 왜 그렇게 생겼는지는 그 파일의 머리 주석이 정본이다.

**브리지 토큰(태스크 2·3 — `2555c77`·`af48455`·`7d633c6`·`e446f9d`)**

- **라벨 `env` 로는 발급할 수 없다**(2.1·3장 보탬, `e446f9d`). `issueBridgeToken` 이 trim 뒤 대소문자를 무시하고 `env` 면 400 `VALIDATION`(「env 는 .env 에서 이어받은 토큰에만 쓰는 라벨입니다」)이다. 목록에서 이어받은 토큰을 가르는 표지가 라벨뿐이라(따로 `source` 필드를 두지 않았다), 사람이 `env` 로 발급하면 출처가 틀리게 보였다(s2-t3 리뷰 M1). **남는 틈**: 전각·제로폭·키릴 문자로 눈에 `env` 처럼 보이는 라벨은 통과한다 — 웹은 `label === "env"` 정확 비교라 오인하지 않는다(s2-t3 재리뷰 N1, 이월).
- **이어받은 토큰의 `prefix` 는 원문이 아니라 해시 앞 6자다**(2.1 정정). `.env` 토큰은 16자까지 짧을 수 있어 원문 조각을 DB 에 두지 않는다. 그래서 웹은 그 줄에 `dbt_` + prefix 대신 「.env 에서 이어받음」을 쓴다 — 해시 앞자리를 `dbt_…` 로 보이면 원문 앞자리로 읽힌다.
- **`importEnvToken` 은 셋 중 하나를 돌려준다**(결정 3·6장 구체화). 그 워크스페이스에 행이 0개면 `imported`(라벨 `env`), 행이 있고 `.env` 값이 활성 토큰이면 `skipped`, 그 밖(다른 값·**폐기된** 값)은 `ignored` — 부팅 warn 한 줄 `BRIDGE_TOKEN in .env is ignored — manage bridge tokens in the connection page`. `envTokenIgnored` 는 읽을 때마다 「`.env` 에 값이 있고 활성 토큰이 아니다」로 계산한다.
- **`BridgeTokenRecord` 에 `connected`**(2.6 보탬) — 지금 그 토큰으로 붙은 브리지 세션이 있다. 웹은 실시간 `setup.status` 의 `bridge.plugin.tokenId` 를 먼저 믿고, 상태가 없을 때만 이것을 본다.
- **거절 로그는 원격 주소마다 1분에 한 줄**(5장 「지금과 같은 `token mismatch` 로그」 보탬 — Review Focus 2). 폐기된 토큰으로 재접속을 되풀이하는 플러그인이 로그를 채우지 않게 어댑터 `RejectLogThrottle`(주소 256개까지)이 줄이고, 넘친 수는 다음 줄에 `(N more suppressed)`. 주소는 `TRUST_PROXY=true` 면 `X-Forwarded-For` 첫 값(trim), 아니면 소켓 주소다(서버의 `bridgeClientAddress` → 어댑터 `clientAddress` 옵션 — `false` 면 꾸민 헤더로 주소를 바꿀 수 없다).
- **검증 함수가 던지면 거절이다**(2.3 보탬, `af48455`) — 핸드셰이크와 첨부 HTTP 모두. DB 오류가 통과로 새지 않는다.
- **`setup.status` 는 어댑터 이벤트와 발급·폐기 두 자리에서 낸다**(2.6 구체화). 어댑터는 `setupDetail()` 이 바뀔 때만 `{ kind: "setup" }` 을 내고(같은 상세면 안 냄), 서버는 토큰 발급·폐기 뒤에도 다시 읽은 상태를 보낸다 — 접속하지 않은 토큰을 폐기하면 어댑터 쪽에는 바뀐 것이 없기 때문이다.
- **폐기는 사유 `revoked` 로 세션을 끊을 뿐 플러그인에 알리지 않는다** — `system.notice { reason: "revoked" }` 는 계약 변경이 필요해 이월했다(s2-t2 리뷰 (3)).

**플러그인 파일·이미지(태스크 1·3·4 — `c3e97e5`·`d5db77e`·`7d633c6`·`8959646`·`4c80e11`)**

- **플러그인 빌드 가드**(2.4 보탬, `d5db77e`). 번들 해시는 테스트·typecheck 로 안 잡히는 두 자리(모듈 스코프 `import.meta.url`, hello 필드)에 달려 있어, `packages/openclaw-plugin/scripts/build.mjs` 가 esbuild 의 `empty-import-meta` 를 오류로 올리고 산출물 글자에서 `computeBundleSha256(import.meta.url)`·`bundleSha256: BUNDLE_SHA256` 를 확인한다. 한계(가드 실패 뒤 망가진 `dist` 가 남음·오류 문구에 고칠 자리 없음·글자 확인의 거짓 음성·양성)는 이월.
- **받기 실패는 둘이다**(3장 보탬). 파일이 없으면 404 `NOT_FOUND` + message `PLUGIN_FILE_MISSING`, 부팅 때 잰 sha256 과 지금 파일이 다르면 409 `CONFLICT` + message `PLUGIN_FILE_CHANGED: …`(부팅 뒤 다시 빌드됨 — 재시작하면 맞는다). 웹은 404 를 message 로, 409 를 `startsWith` 로 가른다.
- **이미지의 `plugin` 단계**(2.5 구체화, `8959646`). `FROM build AS plugin` 이 플러그인 워크스페이스만 더 설치해(openclaw devDependency 는 `pnpm fetch` 층이 이미 받아 이 단계에서 링크만 — 약 220 MB, 이 단계 층에만) `pack:plugin` 을 돌리고, `runtime` 이 `/app/plugin/` 에 tgz 만 복사한다 — 실행 이미지는 tgz 만큼(약 196 KB) 커진다(`docker image inspect <tag> --format '{{.Size}}'`). tgz 가 없으면 `COPY` 가 실패해 파일 없는 이미지가 조용히 나가지 않는다.
- **같은 빌드를 번들 sha 로 가르는 것이 실제로 필요하다**(결정 5 확인). 같은 소스에서 컨테이너(linux)와 호스트(macOS)가 만든 tgz 는 **tgz sha256 은 다르고 번들 sha256 은 같다**(s2-t4 곁 관찰) — tgz 전체로 비교하면 같은 빌드가 다르게 보인다.
- **compose 가 `DODOK_PLUGIN_DIR=/app/plugin` 을 고정한다**(2.5 보탬, `4c80e11`). 이미지 ENV 로만 두면 `.env` 의 빈 줄 `DODOK_PLUGIN_DIR=` 가 덮어 「플러그인 파일 없음」이 된다 — Phase 3 ① 이 `HOST` 등 넷을 고정한 까닭과 같다. 그래서 `.env` 의 그 값은 배포에서 무시된다.

**웹(태스크 5 — `1d23854`·`6180844`·`f5ba6bf`, s2-c1 — `eef129b`)**

- **`GET /api/v1/auth/me` 에 `role`**(계획 수정 — 6장이 전제한 owner 판별의 입력). membership 이 없으면 `member`.
- **owner 판별은 `useIsOwner`**(2.7 구체화). me 쿼리 캐시를 관찰자 없이 구독해 `role === "owner"` 를 읽는다(`useSyncExternalStore`). 배너·사이드바에 `useMe()` 관찰자를 두면 401 정리(`queryClient.clear()`) 뒤 다시 그려지며 me 를 새로 불러 로그인 이동을 되돌렸다(`App.test` 회귀). `enabled: false` 관찰자는 재접속 뒤 me 다시 받기(`refetchQueries`)를 건너뛰게 해 쓰지 않았다. role 이 없는 옛 me 는 owner 가 아니다.
- **받기 버튼은 `status.pluginFile.available` 로만 그린다** — 받아 보고 404 로 가르지 않는다. 없으면 「서버에 플러그인 파일이 없습니다」와 만드는 명령.
- **페어링 `requestId` 가 빈 문자열이면 `openclaw devices list`**(4장 보탬). Gateway 의 페어링 오류가 요청 id 를 싣지 않으면 어댑터가 `""` 로 둔다 — 그때는 승인 명령 대신 목록 명령과 「목록에서 이 서버의 요청을 승인하세요」.
- **설치 명령은 `docs/guides/deploy.md` 「[웹 → B] 플러그인 설치·브리지 토큰」 절의 [B] 블록을 글자 그대로 옮긴다**(4장 「live-smoke 3절 절차」 정정). 계정 설정 패치 줄만 빼고(토큰은 발급 대화상자가 준다), 받은 파일 이름과 대조할 번들 sha256 만 채운다. `connection.test.tsx` 가 그 블록과 대조한다 — 문서를 고치면 테스트가 알린다.
- **마지막 활성 토큰 폐기의 두 번째 확인은 새 버튼을 반대편에, 600ms 무장**(4장 교체 흐름 4 구체화, `6180844`). 같은 버튼의 라벨만 바꾸면 첫 확인의 더블클릭·Enter 두 번이 곧장 두 번째 확인이 됐다(s2-t5 리뷰 D1 — DELETE 1회 재현). 지금은 `ConfirmDialog` `escalated` 가 첫 확인 버튼 자리에 「취소」(초점)를 두고 「그래도 폐기」를 반대편에 `ESCALATED_ARM_MS`(600ms) 동안 비활성으로 그린다. 브라우저 검증에서 강제 클릭 2·Enter 5·더블클릭을 합쳐도 DELETE 는 1건이었다. 폐기 뒤 초점은 아래 줄의 「폐기」, 없으면 「새 토큰 발급」.
- **원문이 보이는 동안 떠나기를 막는다**(4장 교체 흐름 1 보탬, `6180844`). 대화상자는 Esc·바깥 클릭·X 로 닫히지 않고, 라우트 이동(뒤로 가기·주소 변경)은 `useBlocker` 로 대화상자 안에서 한 번 더 묻고(「머무르기」·「원문을 버리고 떠나기」), 탭 닫기·새로고침은 `beforeunload`. **「복사했습니다」를 누르면 막아 둔 이동이 이어진다** — 떠나려던 사람이 복사를 마친 것이다(s2-t5 수정 판단 (a), 문구로 알린다).
- **R1 — 401 은 막기를 건너 즉시 로그인으로**(`f5ba6bf`). `onUnauthorized` 의 `/login` 이동에 `ignoreBlocker`, 막힌 채 대화상자가 언마운트되면 `proceed`. 막기가 401 이동까지 잡으면 대화상자가 언마운트되며 대기가 풀리지 않아 owner 가 「권한이 없습니다」 화면에 갇혔다(s2-t5 재리뷰 D5). 세션이 끝난 뒤 원문을 지키려 사람을 가두는 것이 더 나쁘다. **대가**: 이동이 막혀 있는 동안 401 이 나면 로그인 뒤 `next` 가 그 사람이 가려던 곳이 된다(이월, 낮음).
- **발급 결과는 뮤테이션 캐시에 두지 않는다**(2.7 「닫으면 캐시에서도 지운다」 구체화). `useIssueBridgeToken` 이 응답을 `onIssued` 콜백으로 컴포넌트 상태에만 넘기고 뮤테이션 `data` 는 늘 비어 있다(`gcTime: 0`). 브라우저 검증에서 닫은 뒤 DOM·localStorage·sessionStorage·IndexedDB·새로고침·뒤로 가기 어디에도 원문이 없었다.
- **원문 상자 — 토큰은 줄바꿈, JSON·명령은 제 상자 안 스크롤**(s2-c1, `eef129b`). 브라우저 검증이 390px 발급 대화상자에서 토큰·설정 값이 화면 밖으로 잘리는 것을 찾았다(1280px 에서도 JSON 이 대화상자를 넘었다). `CopyBlock` 래퍼에 `min-w-0`(grid 트랙 안에서 원문 폭이 트랙을 넓히지 않게), 토큰은 `wrap`(`whitespace-pre-wrap` + `break-all`), JSON·명령은 줄 구조를 지키고 `overflow-x-auto` — 명령은 줄을 바꾸면 한 명령이 두 줄로 읽힌다. 390·1280px 실측으로 닫았다. JSON 도 줄바꿈으로 바꾸자는 권고는 이월(Ruling — macOS 오버레이 스크롤바에서 스크롤된다는 게 보이는지 사람이 본다, 복사 버튼이 정본 경로라 차단 아님).

**dev:fake 훅(태스크 6 — `11df417`)**

- **`POST /__devfake/plugin-token { token }`**(7장 「dev:fake 가 가짜 플러그인 토큰 바꾸기를 할 수 있어야 한다」의 답). 가짜 플러그인을 끊고 그 토큰으로 다시 붙여 `{ ok: true }` 또는 `{ ok: false, reason }` 을 돌려준다. `createApp` 이 이미 ready 라 Fastify 경로를 더할 수 없어(`FST_ERR_INSTANCE_ALREADY_LISTENING`) HTTP 서버의 request 리스너를 감싼다 — 이 경로만 받고 나머지는 원래 리스너(engine.io → Fastify)로. owner 판정은 같은 쿠키·Authorization 으로 앱의 `GET /api/v1/setup/status` 를 inject 해 그 401·403 을 그대로 돌려준다. dev:fake 에만 있고 운영 `createApp`·번들에는 없다. 테스트 보강(inject 로는 훅 층을 못 지나는 운영 404·member·경로)과 `text/plain` 단순 요청의 415 는 이월.

**검증이 확인한 것**

- 서버 통합 `apps/server/test/integration/setup.test.ts`(7장 서버 통합 항목 — owner 403 은 `apps/server/test/setup.routes.test.ts` — + BRIDGE_TOKEN 없는 부팅·검증 함수 예외·거절 로그 주소), 로컬 Compose 이미지(받은 tgz sha256 = 이미지 안 파일 = 화면 값, tgz 안 번들 sha256 = `bundleSha256`, 익명 받기 401), `dev:fake` 위 브라우저 시나리오 1~10(결함 1 — 위 s2-c1, 확인 불가 2 — 탭 닫기 `beforeunload`(CDP 가 프롬프트를 억제)·member 화면(dev:fake 에 두 번째 사용자 없음)).
- 테스트 2400(shared 131·plugin 112·adapter 240·server 759·web 1158 — 루트 `pnpm test` 의 패키지별 `Tests` 줄).
