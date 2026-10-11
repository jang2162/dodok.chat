# 서버 네이티브 푸시 — APNs·FCM 직접 발송과 기기 등록 설계

**상태**: 설계 확정(2026-10-06), 구현 전.
**범위**:
- 서버가 iOS(APNs)·Android(FCM) 기기에 지금 웹 푸시와 같은 알림을 직접 보낸다
- 앱이 기기 토큰을 등록·해제하고, 서버가 어느 통로를 보낼 수 있는지 묻는다
- 발송을 통로(transport) 추상으로 나눠 나중에 중앙 중계를 꽂을 자리를 둔다
- 서버 곳곳의 `APP_ORIGIN` 비교를 한 함수로 모은다(동작 변화 없음)

**앞선 근거**:
- 로드맵 `docs/superpowers/specs/2026-10-06-native-apps-roadmap.md` — 결정 2(직접 빌드 앱 + 중계를 꽂을 수 있는 발송), 결정 4(앱 웹뷰는 서버 주소를 그대로 연다, 출처 검사를 한 함수로)
- 웹 푸시: PWA·푸시 스펙 `docs/superpowers/specs/2026-09-23-pwa-push-design.md`, 서버 `apps/server/src/modules/push/`(`createPushDispatcher` — 보고 있으면 건너뜀·구독마다 발송·404/410 이면 구독 삭제, `webPushSender`, `pushTopic`), 페이로드 shared `PushPayload`(`kind`·`channelId`·`title` 80자·`body` 200자·`url`·`tag`)
- 웹 구독은 세션에 묶인다(`push_subscriptions.session_id` cascade) — 기기도 같은 규칙
- 자격 증명 본보기: VAPID(환경 변수가 있으면 그것, 없으면 `data/vapid.json`)

---

## 0. 결정 (브레인스토밍 2026-10-06)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **기기는 새 표 `push_devices`** — 웹 구독 표와 합치지 않는다 | 웹은 endpoint·키, 네이티브는 토큰·앱 id 로 모양이 다르다. |
| 2 | **발송은 통로 추상** — `webpush`·`apns`·`fcm`, `relay` 는 자리만 | 로드맵 결정 2. 디스패처의 「보고 있으면 건너뜀」·tag 묶기·삭제 규칙은 한곳에 남는다. |
| 3 | **APNs·FCM 은 Node 내장(`http2`·`crypto`·`fetch`)만으로** | 의존성을 늘리지 않는다. APNs 는 토큰 인증(.p8, ES256 JWT), FCM 은 HTTP v1(서비스 계정, RS256 JWT → OAuth 토큰). |
| 4 | **페이로드는 웹 푸시와 같은 「누가·어디」** — 메시지 본문을 싣지 않는다 | 중계로 넘어가도 내용이 중계에 남지 않는다. |
| 5 | **자격 증명은 VAPID 규칙** — 환경 변수, 없으면 `data/` 파일. 없는 통로는 꺼지고 그 플랫폼 등록은 `PUSH_UNAVAILABLE` | 시크릿은 `data/`·`.env` 에만. |
| 6 | **자격 증명 오류(APNs 403 `InvalidProviderToken`·FCM 401)는 기기를 지우지 않고 운영 사건** | 기기 탓이 아니다. 웹 푸시의 403 처리와 같은 까닭. |
| 7 | **재시도 없음** — 429·5xx·네트워크 오류는 그 알림을 버리고 warn | 웹 푸시와 같다. 알림은 실시간이 아니면 값이 없다. |
| 8 | **출처 비교를 `allowedOrigins(config)` 하나로** — 값은 지금 그대로 `[APP_ORIGIN]` | 로드맵 결정 4. 앱 출처를 더할 때 고칠 자리가 하나가 된다. |

## 1. 범위

**한다**: `push_devices` 표 · 통로 넷(relay 는 자리) · 디스패처가 웹 구독과 기기를 함께 · 등록·해제·능력 API · 자격 증명 읽기와 부팅 로그 · 운영 사건 `push_credentials_invalid` · `ErrorCode` 에 `PUSH_UNAVAILABLE` · `http/origins.ts` · 문서(`deploy.md` 자격 증명, `live-smoke.md` 손 확인 절차).

**하지 않는다**: 앱(데스크톱·모바일 하위 프로젝트), 중계 구현, 알림 동작 버튼, 실기기 확인(모바일 하위 프로젝트).

## 2. 데이터 모델 — `push_devices`

| 열 | 꼴 | 비고 |
| --- | --- | --- |
| `id` | text PK | |
| `user_id` | text FK `users.id` | |
| `session_id` | text FK `session.id` `ON DELETE CASCADE` | 로그아웃·재설정·비활성화로 세션이 지워지면 함께 |
| `platform` | text not null | `ios` \| `android` |
| `token` | text not null, unique | APNs 기기 토큰(hex) 또는 FCM 등록 토큰 |
| `app_id` | text not null | iOS 번들 id(= APNs topic) 또는 Android 패키지명 |
| `environment` | text | iOS 만: `sandbox` \| `production` |
| `created_at`·`last_seen_at` | ts | |

인덱스 `push_devices_user`, `push_devices_session`.

## 3. 통로

```ts
export type PushNotification = { payload: PushPayload; urgency: "high" | "normal" };
export type TransportResult = "ok" | "gone" | "rejected" | "credentials" | "retry";
export interface PushTransport {
  readonly kind: "webpush" | "apns" | "fcm" | "relay";
  send(target: WebTarget | DeviceTarget, n: PushNotification): Promise<TransportResult>;
}
```

| 통로 | 보내는 법 | 결과 표 |
| --- | --- | --- |
| `webpush` | 지금 `webPushSender` 를 감싼다 | 2xx ok · 404/410 gone · 400/403/413 rejected · 그 밖 retry |
| `apns` | `http2` 로 `api.push.apple.com`(production)·`api.sandbox.push.apple.com`(sandbox) `POST /3/device/<token>`. 헤더 `authorization: bearer <JWT>`(ES256, `kid` = 키 id, `iss` = 팀 id, `iat` — **50분마다 새로**), `apns-topic` = `app_id`, `apns-push-type: alert`, `apns-priority` 10(approval)·5(그 밖), `apns-collapse-id` = `pushTopic(tag)`, `apns-expiration` = 지금 + 3600초. 본문 `{ aps: { alert: { title, body }, sound: "default", "thread-id": channelId }, dodok: { url, kind, channelId } }`. 연결은 호스트마다 하나를 재사용 | 200 ok · 410·400 `BadDeviceToken`/`DeviceTokenNotForTopic` gone · 403 `InvalidProviderToken`/`ExpiredProviderToken` credentials · 그 밖 400 rejected · 429·5xx retry |
| `fcm` | 서비스 계정의 `client_email`·`private_key` 로 RS256 JWT(`scope` = `https://www.googleapis.com/auth/firebase.messaging`) → `token_uri` 에서 OAuth 토큰(**55분 캐시**) → `POST https://fcm.googleapis.com/v1/projects/<project_id>/messages:send`. 본문 `{ message: { token, notification: { title, body }, data: { url, kind, channelId }, android: { priority: "HIGH"(approval)·"NORMAL", collapse_key: pushTopic(tag), ttl: "3600s" } } }` | 200 ok · 404 또는 `UNREGISTERED` gone · 401·403 credentials · 400 `INVALID_ARGUMENT` rejected · 429·5xx retry |
| `relay` | 설정 자리(`PUSH_RELAY_URL`)만. 값이 있으면 부팅 때 「relay 는 아직 구현되지 않았다」 warn 후 꺼진 것으로 둔다 | — |

호스트(`api.push.apple.com` 등)와 토큰 엔드포인트는 설정으로 덮을 수 있게 둔다 — 통합 테스트가 가짜 서버로 돌린다.

## 4. 디스패처

`createPushDispatcher` 는 그대로의 흐름에서 「구독마다」를 「웹 구독 + 기기마다 그 통로로」로 넓힌다.

- 보고 있으면 건너뜀(`presence.isWatching`) — 그대로, 받는 사람 단위.
- 결과 처리: `gone` → 그 구독·기기 행 삭제(info) · `rejected` → error(행 유지) · `credentials` → 행 유지, 운영 사건 `push_credentials_invalid`(key `push:<transport>`, 1시간 묶기는 운영 사건의 기존 규칙) · `retry` → warn · 던짐 → warn.
- 로그: `userId`·`deviceId` 또는 `subscriptionId`·`transport`·`kind`·결과·짧은 사유. **토큰·endpoint·키·페이로드 본문은 싣지 않는다**(토큰이 꼭 필요하면 앞 8자).
- 그 플랫폼 통로가 꺼져 있는데 기기 행이 남아 있으면 건너뛰고 debug.

## 5. API (`modules/push/routes.ts`, 로그인한 사람 누구나 — 자기 세션)

| 경로 | 동작 |
| --- | --- |
| `GET /api/v1/push/capabilities` | `{ webpush: boolean, ios: boolean, android: boolean }` — 통로가 켜졌는가 |
| `POST /api/v1/push/devices` | 본문 `{ platform, token, appId, environment? }`(Zod — `token` 은 iOS 64자 hex·Android 1~4096자, `environment` 는 iOS 일 때 필수). 그 플랫폼이 꺼져 있으면 `PUSH_UNAVAILABLE`. 같은 토큰 행이 있으면 지금 사용자·세션으로 옮기고 `last_seen_at` 갱신, 없으면 만든다 → `{ id }` |
| `DELETE /api/v1/push/devices` | 본문 `{ token }` — 자기 행만 지운다(없으면 204) |

`ErrorCode` 에 `PUSH_UNAVAILABLE` 을 더한다. 사용자 REST 상한(`restPerMin`) 안.

## 6. 자격 증명·설정

| 값 | 환경 변수 | 없을 때 파일 |
| --- | --- | --- |
| APNs 키 | `APNS_KEY_PATH` | `data/apns/key.p8` |
| APNs 키 id·팀 id | `APNS_KEY_ID`·`APNS_TEAM_ID` | `data/apns/config.json` `{ keyId, teamId }` |
| FCM 서비스 계정 | `FCM_SERVICE_ACCOUNT_PATH` | `data/fcm/service-account.json` |
| 중계(자리) | `PUSH_RELAY_URL` | — |

부팅 때 통로마다 한 줄: `push transport apns: on|off(<사유>)`. 키 원문·계정 이메일은 로그에 싣지 않는다. `docs/guides/deploy.md` 에 발급 절차(Apple 개발자 → Keys → APNs, Firebase 콘솔 → 서비스 계정)와 `data/` 배치를 적는다.

## 7. 출처 정리 — `apps/server/src/http/origins.ts`

```ts
/** 쿠키 인증·CORS·Better Auth 가 받아들이는 출처. 지금은 APP_ORIGIN 하나(로드맵 결정 4) */
export function allowedOrigins(config: { APP_ORIGIN: string }): string[];
export function isAllowedOrigin(config: { APP_ORIGIN: string }, origin: string | undefined): boolean;
```

바꾸는 자리: wire 쿠키 인증(`realtime/cookie-auth.ts`), Better Auth `trustedOrigins`(`auth/index.ts`), Socket.IO CORS(`app.ts`). 초대·재설정 링크를 만드는 「대표 출처」는 `APP_ORIGIN` 그대로(`modules/members/routes.ts` 등) — 이 함수를 쓰지 않는다. 기존 테스트가 그대로 초록이면 된다.

## 8. 웹과의 관계

이번 범위에서 웹은 바뀌지 않는다. 앱 웹뷰 안에서 웹 푸시 구독 UI 를 숨기고 「앱 알림」 상태를 보이는 것, 「이 기기에 푸시가 켜져 있으면 탭 안 승인 알림은 쉰다」를 앱에도 적용하는 것은 모바일 하위 프로젝트가 `GET /push/capabilities` 와 네이티브 다리로 한다.

## 9. 오류 처리

| 상황 | 동작 |
| --- | --- |
| 통로 꺼짐 + 등록 | `PUSH_UNAVAILABLE` |
| 토큰 형식 틀림 | `VALIDATION` |
| 기기가 사라짐(gone) | 행 삭제, info |
| 자격 증명 오류 | 행 유지, `push_credentials_invalid` 사건, error 로그 |
| 429·5xx·네트워크 | 그 알림 버림, warn |
| APNs 연결 끊김 | 다음 발송 때 다시 연결 |
| 세션 삭제 | cascade 로 기기 삭제 |
| 페이로드 크기 | `PushPayload` 의 길이 상한(제목 80·본문 200)으로 APNs·FCM 4 KB 안에 든다 — 따로 자르지 않는다 |

## 10. 테스트·검증·완료 기준

- **단위**: APNs JWT(헤더 `alg ES256`·`kid`, 클레임 `iss`·`iat`, 50분 안 재사용·뒤 새로) · FCM JWT·토큰 교환(가짜 토큰 엔드포인트, 55분 캐시) · 두 통로의 응답 → 결과 표 전부 · 자격 증명 읽기(환경 변수 우선·파일·없음 → off) · 기기 upsert(같은 토큰을 다른 사용자가 등록하면 옮겨 감) · 세션 삭제 cascade · `allowedOrigins` 로 바꾼 뒤 기존 인증·CORS 테스트 그대로.
- **통합**: 로컬 가짜 APNs(`http2.createSecureServer`, 자체 서명)·가짜 FCM(HTTP) — 멘션 → iOS·Android·웹 구독 셋 모두로 · 보고 있으면 셋 다 건너뜀 · 가짜 APNs 410 → 기기 삭제 · 가짜 FCM 401 → 사건 하나, 기기 유지 · 통로 꺼짐 → 등록 `PUSH_UNAVAILABLE`.
- **역할**: 세 API 는 모든 역할 허용, membership 없는 세션 401 — 매트릭스에 더한다.
- **손 확인 절차만**: 실제 APNs sandbox·FCM 으로 한 번 쏘는 법을 `docs/guides/live-smoke.md` 에 적는다(자격 증명이 생기면 모바일 하위 프로젝트가 돈다).
- **완료 기준**: 위 자동 테스트 통과(실행 개수 보고), `deploy.md` 자격 증명 절, `live-smoke.md` 절차, `project-structure.md` 갱신.

## 11. 열린 문제 (범위 밖 기록)

- **중계 구현** — 스토어 공개 앱으로 갈 때. 서버 → 중계는 「기기 토큰 + 최소 페이로드」만, 중계 인증·남용 방지가 필요하다.
- **알림 동작 버튼**(승인 허용·거절, 빠른 답장) — APNs 카테고리·FCM 액션과 앱 쪽 처리가 필요하다.
- **배지 수** — APNs `badge` 를 안 읽음 수로 채우려면 읽지 않음 기능의 합계가 필요하다(읽지 않음 스펙의 「앱 아이콘 배지」와 같은 줄기).

## 12. 구현과 맞춘 것

계획 `docs/superpowers/plans/2026-10-06-native-push.md`(태스크 1~6)와 구현이 위 본문과 달라진 곳이다. 본문은 설계 시점 그대로 두고 여기에만 적는다. 출처의 t1~t5 보고·리뷰는 `.superpowers/sdd/2026-10-12-native-push/`(git 제외)에 있다.

**계획 판정 PN1~PN4와 PN5**

- **PN1 — 디스패처 일반화와 통로 추가를 나눴다.** 태스크 3 은 웹 푸시만 있는 지금과 결과가 같은 단계(`webpush` 통로 하나), 태스크 4·5 가 APNs·FCM 을 더한다.
- **PN2 — `AppDeps.pushTransports`.** 테스트·`dev:fake` 가 통로를 통째로 덮는 입구다. 옛 `AppDeps.pushCapabilities` 덮기는 `pushTransports` 로 흡수했고(켜진 통로가 곧 능력), `AppDeps.pushSend` 는 웹 푸시 발송기만 덮는 호환 입구로 남겼다.
- **PN3 — 호스트 덮기는 테스트·개발 전용.** `APNS_HOST`·`APNS_CA_PATH`·`FCM_HOST`·`FCM_TOKEN_URI` 는 `config.ts` 에만 있고 `deploy.md` 에 싣지 않는다.
- **PN4 — 태스크 3 으로 앞당겼다.** 운영 사건 종류 `push_credentials_invalid`(shared)와 웹 운영 화면 문구 「푸시 자격 증명이 거부되었습니다(<통로>)」를, 사건을 처음 내는 디스패처 일반화와 같은 태스크에 넣었다(계획은 태스크 4).
- **PN5 — 세션당 기기 한 행**(조율자 결정). 본문 2장은 기기를 토큰으로만 유일하게 했지만, `upsertDevice` 가 한 트랜잭션 안에서 같은 세션의 **다른 토큰** 행을 지우고 등록한다. 토큰이 돌았거나 거절된 옛 토큰이 세션에 쌓이지 않게 하려는 것이다(지우기와 upsert 가 한 트랜잭션인 까닭: upsert 가 던졌을 때 옛 행까지 사라져 기기가 0개로 남지 않게). **전제**: 모바일 앱은 세션 토큰을 기기 전용 저장소에 두므로 한 세션은 한 기기다 — 한 세션 토큰을 여러 기기가 나눠 쓰면 마지막 등록만 남는다.

**API·검증 경계**

- iOS 토큰은 경계(shared `PushDeviceInput`)에서 소문자로 모은다 — APNs 토큰은 hex 라 대소문자가 같은 기기인데 `token` 유일이 대소문자를 가르면 한 기기가 두 행이 된다. 해제(`DELETE`)도 같은 규칙으로 찾는다.
- `appId` 는 `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`·200자다. `apns-topic` 헤더와 FCM 요청에 그대로 실리는 값이라 경계에서 모양을 좁힌다.
- 멤버 비활성화가 `push_devices` 행도 지운다(웹 구독을 지우던 자리와 같은 곳). 세션 삭제의 cascade 와 둘이 합쳐 「그 사람의 알림은 그 사람이 로그인한 기기에만」 이 된다.
- `PUSH_UNAVAILABLE` 은 HTTP **503** 이고, 성공한 `POST /api/v1/push/devices` 는 **200 `{ id }`**(본문 5장이 둘 다 적지 않은 것)다.

**출처 정리 (7장)**

- **REST CORS 자리는 없다.** 서버는 `@fastify/cors` 를 쓰지 않고 웹은 REST 를 같은 출처(개발 Vite 프록시·운영 Caddy)로 부른다. 출처 정리는 세 자리 — wire 쿠키 인증·Better Auth `trustedOrigins`·Socket.IO `cors` — 이고, 7장 「바꾸는 자리」의 문장을 그에 맞게 고쳤다.
- **불투명 출처("null")는 목록에 넣지 않는다.** `capacitor://…`·`file:` 의 `new URL(…).origin` 은 `"null"` 이라, 앱 출처를 더하는 날 그대로 넣으면 샌드박스 iframe·file 페이지가 보내는 `Origin: null` 이 쿠키를 읽는다. `allowedOrigins` 가 걸러내고 `isAllowedOrigin` 은 `undefined` 를 거절한다. 앱 출처를 더할 때의 함정이다.

**통로와 디스패처**

- **로그의 나눔.** 디스패처 로그는 통로(`transport`)와 결과(`result`)만 남기고, 거절 사유(`statusCode`·고정 문구 `reason`)는 각 통로가 warn 으로 남긴다. 옛 웹 푸시 로그의 `statusCode` 필드는 디스패처 줄에서 사라졌다.
- **APNs.** 403 은 모두 `credentials`(토픽 문제는 400 이라 `rejected`·`gone` 쪽이다) — 본문 3장의 `InvalidProviderToken`/`ExpiredProviderToken` 구분을 두지 않는다. **GOAWAY·REFUSED_STREAM 이 처리하지 않은 요청만** 한 번 다시 보낸다(HTTP/2 의미상 서버가 처리하지 않았음을 보장하므로 중복이 없다 — 본문 결정 7 「재시도 없음」의 예외). 응답 헤더 없이 스트림이 끝나면 `retry` 로 두고 다시 보내지 않는다. 가짜 APNs 서버의 자체 서명 인증서를 만드는 테스트 도우미는 `openssl` CLI(LibreSSL 도 된다)를 부르고, 없으면 테스트가 크게 실패한다.
- **FCM.** 자격 증명 로더는 `modules/push/fcm-credentials.ts`(본문·계획의 `credentials.ts` 안 `loadFcmCredentials` 가 아니다). 토큰 교환에는 제한 시간이 있고, 진행 중인 교환은 동시 발송이 공유하며, 실패한 교환은 캐시하지 않는다. 교환이 400·401·403 이면 `credentials`, 네트워크·5xx 는 `retry`.
- **통합 테스트 파일.** Android 는 `apps/server/test/integration/push-native-android.test.ts` 로 나눴다 — 같은 파일을 두 태스크가 만져 병렬 실행이 충돌하는 것을 피하려는 것.

**검증**

태스크마다 독립 리뷰(변이 테스트)·수정·범위 재리뷰를 거쳤다. 실제 APNs·FCM 으로의 발송은 한 번도 없다 — 통합 테스트는 로컬 가짜 서버만 쓴다. 실기기 확인은 사람이 `docs/guides/live-smoke.md` 「네이티브 푸시 손 확인」 절로 한다. 테스트 수는 `docs/guides/plan.md` 8장 Phase 4 「서버 네이티브 푸시」 줄.
