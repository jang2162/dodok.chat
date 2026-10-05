# 서버 네이티브 푸시 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`CLAUDE.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나. 태스크마다 main 에 병합해도 초록이어야 한다.

**Goal:** 서버가 등록된 iOS·Android 기기에 웹 푸시와 같은 알림을 APNs·FCM 으로 직접 보내고, 발송을 통로 추상으로 나눠 중계를 꽂을 자리를 둔다. 출처 비교는 한 함수로 모은다.

**Architecture:** 새 표 `push_devices` 와 등록·능력 API. 디스패처(`createPushDispatcher`)는 「보고 있으면 건너뜀」 흐름을 그대로 두고 받는 사람의 웹 구독과 기기를 함께 모아 각자 통로(`PushTransport`)로 보낸다. APNs(`http2` + ES256 JWT)·FCM(HTTP v1 + RS256 JWT → OAuth)은 Node 내장만으로 짜고, 호스트를 설정으로 덮어 통합 테스트가 가짜 서버로 돈다.

**Tech Stack:** Fastify 5 · drizzle-orm 0.45 + better-sqlite3 · zod 4 · Node 24 `node:http2`·`node:crypto`·`fetch`. **새 의존성 없음.**

**Spec:** `docs/superpowers/specs/2026-10-06-native-push-design.md` — 결정 0장, 표 2장, 통로 3장, 디스패처 4장, API 5장, 자격 증명 6장, 출처 7장, 오류 9장, 검증 10장. 로드맵 `docs/superpowers/specs/2026-10-06-native-apps-roadmap.md`. **태스크를 시작하기 전에 스펙의 해당 장을 읽는다.**

## Global Constraints

- 페이로드는 shared `PushPayload` 그대로(메시지 본문 없음). 통로마다 스펙 3장의 본문·헤더 꼴을 글자 그대로.
- 결과 표(스펙 3장): `ok`·`gone`(행 삭제)·`rejected`(error, 행 유지)·`credentials`(행 유지, 운영 사건 `push_credentials_invalid` key `push:<transport>`)·`retry`(warn). 재시도 없음.
- APNs JWT 는 50분 안이면 재사용, FCM OAuth 토큰은 55분 캐시.
- 로그·사건에 토큰·endpoint·키·페이로드 본문·계정 이메일·키 원문을 싣지 않는다(토큰은 필요하면 앞 8자).
- 자격 증명: 환경 변수 우선, 없으면 `DATA_DIR` 아래 파일(스펙 6장 표). 없는 통로는 off, 부팅 로그 한 줄. `PUSH_RELAY_URL` 은 자리만(값이 있으면 warn 후 off).
- 기기 API 는 로그인한 사람 누구나·자기 세션. `ErrorCode` 에 `PUSH_UNAVAILABLE`.
- `allowedOrigins` 정리는 **동작 변화 없음** — 기존 테스트가 그대로 초록.
- 외부 입력은 경계에서 Zod 파싱. shared 는 Node 전용 API 금지(통로는 서버에만).
- 시크릿은 `data/`·`.env` 에만, 커밋 금지. 테스트용 키는 테스트가 실행 중에 만든다(`generateKeyPairSync`) — 키 파일을 저장소에 넣지 않는다.
- 포트 5173·3000 금지(사용자 인스턴스 3100·5180 도 건드리지 않는다). 가짜 APNs·FCM 은 포트 0(임의)으로 연다. 프로세스는 자기 PID 로만, `pkill` 금지. **실제 APNs·FCM 으로 보내지 않는다.**
- 마이그레이션 번호는 다른 계획(읽지 않음·리액션·자동화)과 겹칠 수 있다 — 먼저 병합된 쪽이 앞 번호, 나중 쪽은 rebase 뒤 `pnpm -F @dodok/server db:generate` 를 다시 돌린다.
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프(`refactor(server)`·`feat(shared)`·`feat(server)`). 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 문서·주석을 쓰기 전에 `docs/guideline/base/03-comments.md`·`04-citation.md` 를 읽는다.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 자기 실행 출력에서 패키지별로(0개는 통과가 아니다). 서버를 바꿨으면 `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`.

## 계획 판정 (스펙과 맞춘 것)

태스크 6 이 스펙에 「구현과 맞춘 것」 장을 만들어 옮긴다.

- **PN1 — 디스패처 일반화는 동작을 바꾸지 않는 단계(태스크 3)와 통로를 더하는 단계(4·5)로 나눈다.** 태스크 3 이 끝나면 웹 푸시만 있는 지금과 결과가 같다(`webpush` 통로 하나).
- **PN2 — `AppDeps.pushSend`(테스트용 가짜 웹 푸시 발송기)는 `AppDeps.pushTransports?: Partial<Record<"webpush" | "apns" | "fcm", PushTransport>>` 로 넓힌다.** 기존 테스트의 `pushSend` 는 `webpush` 통로로 감싸는 호환 도우미 하나로 옮긴다(테스트 파일마다 고치지 않게).
- **PN3 — APNs·FCM 호스트 덮기**: `APNS_HOST`(기본: 기기 `environment` 로 production·sandbox), `FCM_HOST`·`FCM_TOKEN_URI`(기본: `fcm.googleapis.com`·서비스 계정의 `token_uri`)는 `config.ts` 의 테스트·개발 전용 값으로 두고 `deploy.md` 에 싣지 않는다. 가짜 APNs 의 자체 서명 인증서를 받으려고 `APNS_CA_PATH`(선택)를 둔다.
- **PN4 — 운영 사건 kind `push_credentials_invalid`** 는 shared `ops` 의 사건 종류 목록에 더하고 운영 화면 문구 「푸시 자격 증명이 거부되었습니다(<통로>)」를 같은 태스크(4)에서 더한다.

## Review Focus

1. **같은 휴대폰을 다른 계정으로 다시 로그인** — 같은 토큰이 새 사용자·세션으로 옮겨 가고, 옛 사용자에게 갈 알림이 그 폰으로 가지 않는다. → 태스크 2.
2. **APNs 키가 폐기됨(403 `InvalidProviderToken`)인데 멘션이 연달아 옴** — 기기는 남고, 사건은 한 줄로 묶이며(운영 사건 1시간 묶기), JWT 캐시가 매 발송마다 새 JWT 를 만들며 폭주하지 않는다. → 태스크 4.
3. **APNs 연결이 서버 쪽에서 끊김(GOAWAY) 뒤 다음 발송** — 다시 연결해 보낸다. 끊긴 세션을 붙잡고 실패를 반복하지 않는다. → 태스크 4.
4. **FCM 토큰 엔드포인트가 느리거나 실패** — 그 발송은 `retry`(warn)로 끝나고, 실패한 OAuth 응답을 캐시하지 않는다. 동시에 알림 여럿이 와도 토큰 교환은 한 번만 나간다. → 태스크 5.
5. **iOS 기기의 `environment` 가 sandbox 인데 production 호스트로 감(또는 반대)** — 기기가 지정한 환경의 호스트로 간다. 400 `BadDeviceToken` 이면 gone 으로 지운다(환경을 잘못 등록한 기기는 앱이 다시 등록한다). → 태스크 4.

각 줄의 테스트는 해당 태스크의 단계에 들어 있다.

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `apps/server/src/http/origins.ts`(새)·`realtime/cookie-auth.ts`·`auth/index.ts`·`app.ts` | 1 | 출처 정리 |
| `packages/shared/src/push/index.ts`·`common.ts` | 2 | `PushDeviceInput`·`PushDeviceRemove`·`PushCapabilities`·`PUSH_UNAVAILABLE` |
| `apps/server/src/db/schema.sqlite.ts`·`drizzle/00xx_*`·`modules/push/devices.ts`(새)·`modules/push/routes.ts` | 2 | 표·기기 저장소·API |
| `apps/server/src/modules/push/transports/{types,webpush}.ts`(새)·`service.ts`·`app.ts` | 3 | 통로 추상·디스패처 일반화 |
| `apps/server/src/modules/push/transports/apns.ts`(새)·`modules/push/credentials.ts`(새)·`config.ts`·shared `ops`·웹 운영 화면 문구 | 4 | APNs |
| `apps/server/src/modules/push/transports/fcm.ts`(새)·`credentials.ts`·`config.ts` | 5 | FCM |
| 문서 | 6 | `deploy.md`·`live-smoke.md`·`project-structure.md`·스펙·`docs/plan.md` |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 출처 정리 ‖ 2 기기 표·API | — |
| B | 3 통로 추상·디스패처 | 2 |
| C | 4 APNs ‖ 5 FCM | 3 |
| D | 6 문서 | 1·4·5 |

---

### Task 1: 출처 비교를 한 함수로 (동작 변화 없음)

**Files:**
- Create: `apps/server/src/http/origins.ts`
- Modify: `apps/server/src/realtime/cookie-auth.ts`, `apps/server/src/auth/index.ts`(`trustedOrigins`), `apps/server/src/app.ts`(Socket.IO `cors`·REST CORS)
- Test: `apps/server/test/http.origins.test.ts`(새), 기존 `auth.test.ts`·`rest.test.ts`·wire 핸드셰이크 테스트

**Interfaces:**

```ts
/** 쿠키 인증·CORS·Better Auth 가 받아들이는 출처. 지금은 APP_ORIGIN 하나(앱 로드맵 결정 4) */
export function allowedOrigins(config: { APP_ORIGIN: string }): string[];
export function isAllowedOrigin(config: { APP_ORIGIN: string }, origin: string | undefined): boolean;
```

- [ ] **Step 1: 실패하는 테스트.** `http.origins.test.ts`: `APP_ORIGIN` 이 `http://localhost:5173/` 처럼 끝 `/` 가 있어도 `allowedOrigins` 는 `["http://localhost:5173"]`(URL `origin`) · `isAllowedOrigin` 이 같은 출처 true, 포트·스킴이 다르면 false, `undefined` false.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.** 네 자리를 이 함수로 바꾼다. 초대·재설정 링크를 만드는 자리(`modules/members/routes.ts` 등)는 건드리지 않는다.
- [ ] **Step 3: 기존 테스트 전체 초록 확인** — 특히 「127.0.0.1 출처면 wire 거절」 사례.
- [ ] **Step 4: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 5: 커밋** — `refactor(server): check allowed origins in one place`.

---

### Task 2: 기기 표·저장소·API

**Files:**
- Modify: `packages/shared/src/push/index.ts`, `packages/shared/src/common.ts`(`ErrorCode`)
- Modify: `apps/server/src/db/schema.sqlite.ts`; Create(생성기): `apps/server/drizzle/00xx_*`
- Create: `apps/server/src/modules/push/devices.ts`; Modify: `apps/server/src/modules/push/routes.ts`, `apps/server/src/app.ts`(능력 값 전달)
- Test: `packages/shared/test/push.test.ts`, `apps/server/test/push.devices.test.ts`(새), `apps/server/test/push.routes.test.ts`, `apps/server/test/roles.matrix.test.ts`

**Interfaces:**

```ts
// shared
export const PushDeviceInput = z.discriminatedUnion("platform", [
  z.object({ platform: z.literal("ios"), token: z.string().regex(/^[0-9a-f]{64}$/i), appId: z.string().min(1).max(200), environment: z.enum(["sandbox", "production"]) }),
  z.object({ platform: z.literal("android"), token: z.string().min(1).max(4096), appId: z.string().min(1).max(200) }),
]);
export const PushDeviceRemove = z.object({ token: z.string().min(1).max(4096) });
export const PushCapabilities = z.object({ webpush: z.boolean(), ios: z.boolean(), android: z.boolean() });
// server modules/push/devices.ts
export type PushDeviceRow = typeof pushDevices.$inferSelect;
export function upsertDevice(db: DbOrTx, userId: string, sessionId: string, input: PushDeviceInput, now: Date): PushDeviceRow;
export function removeDevice(db: DbOrTx, userId: string, token: string): void;
export function listDevices(db: DbOrTx, userId: string): PushDeviceRow[]; // 만료 세션은 거른다(listSubscriptions 와 같은 규칙)
export function deleteDeviceById(db: DbOrTx, id: string): void;
```

- [ ] **Step 1: 실패하는 테스트.**
  - shared: iOS 토큰 63자 거절·`environment` 없음 거절, Android `environment` 는 무시, `PUSH_UNAVAILABLE` 이 `ErrorCode` 에 있음.
  - `push.devices.test.ts`: 새 등록 → 행 · 같은 토큰을 같은 사용자가 다시 → `last_seen_at` 만 · **Review Focus 1**: 같은 토큰을 다른 사용자·세션이 등록 → 행이 옮겨 가고 `listDevices(옛 사용자)` 가 빈 배열 · 세션 삭제 → cascade · `removeDevice` 는 남의 행을 지우지 않음.
  - `push.routes.test.ts`: `GET /push/capabilities` 가 주입한 능력을 돌려줌 · iOS 통로 off 면 iOS 등록 `PUSH_UNAVAILABLE`(Android 는 그대로) · 형식 틀림 `VALIDATION` · `DELETE` 없으면 204.
  - `roles.matrix.test.ts`: 세 경로 × 세 역할 허용, membership 없음 401.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.** 표는 스펙 2장. 라우트 컨텍스트에 `capabilities: () => PushCapabilities` 를 받는다 — 이 태스크에서 `app.ts` 는 `{ webpush: true, ios: false, android: false }` 를 준다(통로는 태스크 3~5).
- [ ] **Step 3: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 4: 커밋** — `feat(shared): add push device and capability contracts`, `feat(server): register native push devices`.

---

### Task 3: 통로 추상·디스패처 일반화 (웹 푸시 동작 변화 없음)

**Files:**
- Create: `apps/server/src/modules/push/transports/types.ts`, `transports/webpush.ts`
- Modify: `apps/server/src/modules/push/service.ts`(`createPushDispatcher`), `apps/server/src/app.ts`(PN2), 테스트 도우미(`apps/server/test/helpers/app.ts` 의 `pushSend` 호환)
- Test: `apps/server/test/push.service.test.ts`, `apps/server/test/integration/push.test.ts`

**Interfaces:**

```ts
// transports/types.ts
export type TransportKind = "webpush" | "apns" | "fcm" | "relay";
export type TransportResult = "ok" | "gone" | "rejected" | "credentials" | "retry";
export type WebTarget = { kind: "web"; id: string; endpoint: string; keys: { p256dh: string; auth: string } };
export type DeviceTarget = { kind: "device"; id: string; platform: "ios" | "android"; token: string; appId: string; environment?: "sandbox" | "production" };
export type PushNotification = { payload: PushPayload; urgency: "high" | "normal" };
export interface PushTransport {
  readonly kind: TransportKind;
  send(target: WebTarget | DeviceTarget, n: PushNotification): Promise<TransportResult>;
}
// transports/webpush.ts — 지금 webPushSender 의 상태 코드 → 결과 표(스펙 3장)
export function webPushTransport(send: PushSend): PushTransport;
// service.ts
export function createPushDispatcher(deps: {
  db: Db; logger: Pick<Logger, "debug" | "info" | "warn" | "error">;
  transports: Partial<Record<"webpush" | "apns" | "fcm", PushTransport>>;
  presence: Pick<Presence, "isWatching">;
  ops: Pick<OpsService, "record">;
}): PushDispatcher;
```

- [ ] **Step 1: 실패하는 테스트.** `push.service.test.ts`: 기존 사례를 새 시그니처로 옮기고 단언은 그대로(2xx debug · 404/410 구독 삭제 · 400/403/413 error 유지 · 그 밖 warn · 보고 있으면 건너뜀) · 새 사례: 가짜 `apns`·`fcm` 통로를 주면 기기 행마다 그 통로로 감 · `gone` → 기기 삭제 · `credentials` → 기기 유지·`ops.record({ kind: "push_credentials_invalid", key: "push:apns", … })` · 그 플랫폼 통로가 없으면 그 기기는 건너뛰고 debug · 로그 객체에 `token`·`endpoint` 키가 없음.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.** `forUser` 가 `listSubscriptions` + `listDevices` 를 모아 `Promise.all`. `urgency` 는 지금처럼 `approval` 이면 high.
- [ ] **Step 3: 통합 `integration/push.test.ts` 가 그대로 초록**(PN1).
- [ ] **Step 4: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 5: 커밋** — `refactor(server): send push through pluggable transports`.

---

### Task 4: APNs 통로

**Files:**
- Create: `apps/server/src/modules/push/transports/apns.ts`, `apps/server/src/modules/push/credentials.ts`
- Modify: `apps/server/src/config.ts`(`APNS_KEY_PATH`·`APNS_KEY_ID`·`APNS_TEAM_ID`·`PUSH_RELAY_URL`·PN3 의 `APNS_HOST`·`APNS_CA_PATH`), `apps/server/src/app.ts`(통로 켜기·부팅 로그·능력), shared `ops` 사건 종류(PN4), 웹 운영 화면 사건 문구
- Test: `apps/server/test/push.apns.test.ts`(새), `apps/server/test/push.credentials.test.ts`(새), `apps/server/test/integration/push-native.test.ts`(새 — 이 태스크는 APNs 사례만)

**Interfaces:**

```ts
export type ApnsCredentials = { key: KeyObject; keyId: string; teamId: string };
export function loadApnsCredentials(opts: { dataDir: string; keyPath?: string; keyId?: string; teamId?: string }): ApnsCredentials | { off: string };
export function apnsTransport(opts: { credentials: ApnsCredentials; host?: string; ca?: Buffer; now?: () => number }): PushTransport & { close(): Promise<void> };
export const APNS_JWT_TTL_MS = 50 * 60_000;
```

- [ ] **Step 1: 실패하는 테스트 — 단위.** `push.apns.test.ts`(키는 `generateKeyPairSync("ec", { namedCurve: "prime256v1" })`, 가짜 서버는 `http2.createSecureServer` 자체 서명 — 인증서도 테스트가 만든다):
  - 요청: 경로 `/3/device/<token>`, 헤더 `apns-topic`·`apns-push-type: alert`·`apns-priority`(approval 10, 그 밖 5)·`apns-collapse-id` = `pushTopic(tag)`·`apns-expiration`, 본문 스펙 3장 꼴.
  - JWT: 헤더 `{ alg: "ES256", kid }`, 클레임 `{ iss: teamId, iat }`, 서명이 공개 키로 검증됨 · 50분 안 두 발송은 같은 JWT, 50분 뒤 새 JWT.
  - 결과 표: 200 ok · 410 gone · 400 `BadDeviceToken` gone · 400 `DeviceTokenNotForTopic` gone · 403 `InvalidProviderToken` credentials · 400 `PayloadEmpty` rejected · 429·503 retry.
  - **Review Focus 5**: `environment: "sandbox"` 기기는 sandbox 호스트로(호스트 덮기가 없을 때의 선택 함수 단위 사례).
  - **Review Focus 3**: 가짜 서버가 첫 응답 뒤 세션을 `goaway` → 다음 발송이 새 세션으로 성공.
  - **Review Focus 2**: 403 이 연달아 와도 JWT 는 50분 규칙대로만 새로 만든다(서명 횟수 단언).
- [ ] **Step 2: 실패하는 테스트 — 자격 증명.** `push.credentials.test.ts`: 환경 변수가 파일보다 우선 · `data/apns/key.p8` + `config.json` 으로 켜짐 · 키 없음 → `{ off: "no key" }` · 깨진 키 → `{ off: "invalid key" }`(부팅을 막지 않는다 — VAPID 와 다르다: 네이티브 푸시가 없어도 서버는 돈다) · 로그 문자열에 키 원문이 없음.
- [ ] **Step 3: 실패하는 테스트 — 통합.** `push-native.test.ts`: 가짜 APNs 로 앱을 띄우고(PN3) iOS 기기 등록 → 다른 사람이 멘션 → 가짜 서버가 요청 하나를 받음 · 받는 사람이 그 채널을 보고 있으면 0 · 가짜 410 → 기기 삭제 · 가짜 403 → 운영 사건 `push_credentials_invalid` 하나, 기기 유지 · `GET /push/capabilities` 의 `ios: true`.
- [ ] **Step 4: 실패 확인 → 구현 → 통과.** 세션은 호스트마다 하나를 `http2.connect` 로 열어 두고 `close`·`goaway`·`error` 에서 버린다. 요청 제한 시간은 `PUSH_SEND_TIMEOUT_MS`. 부팅 로그 `push transport apns: on` 또는 `off(<사유>)`. `PUSH_RELAY_URL` 이 있으면 warn 한 줄 후 무시.
- [ ] **Step 5: 루트 검사 4종 + 서버 번들 스모크 + 웹 빌드(문구).**
- [ ] **Step 6: 커밋** — `feat(server): send push to iOS devices through APNs`.

---

### Task 5: FCM 통로

**Files:**
- Create: `apps/server/src/modules/push/transports/fcm.ts`
- Modify: `apps/server/src/modules/push/credentials.ts`(`loadFcmCredentials`), `apps/server/src/config.ts`(`FCM_SERVICE_ACCOUNT_PATH`·PN3 의 `FCM_HOST`·`FCM_TOKEN_URI`), `apps/server/src/app.ts`
- Test: `apps/server/test/push.fcm.test.ts`(새), `push.credentials.test.ts`, `integration/push-native.test.ts`(Android 사례 추가)

**Interfaces:**

```ts
export type FcmCredentials = { projectId: string; clientEmail: string; privateKey: KeyObject; tokenUri: string };
export function loadFcmCredentials(opts: { dataDir: string; path?: string }): FcmCredentials | { off: string };
export function fcmTransport(opts: { credentials: FcmCredentials; host?: string; tokenUri?: string; now?: () => number; fetch?: typeof fetch }): PushTransport;
export const FCM_TOKEN_TTL_MS = 55 * 60_000;
```

- [ ] **Step 1: 실패하는 테스트 — 단위.** `push.fcm.test.ts`(키는 `generateKeyPairSync("rsa", { modulusLength: 2048 })`, `fetch` 주입):
  - 토큰 교환: `token_uri` 로 `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` + RS256 JWT(`iss` = client_email, `scope` = `https://www.googleapis.com/auth/firebase.messaging`, `aud` = token_uri, `exp` = `iat` + 3600) · 55분 캐시 · **Review Focus 4**: 동시 발송 다섯 → 교환 한 번 · 교환 실패(500·네트워크) → 그 발송 `retry`, 다음 발송이 다시 교환(실패를 캐시하지 않음).
  - 발송: `POST /v1/projects/<projectId>/messages:send`, `authorization: Bearer <access>`, 본문 스펙 3장 꼴(`android.priority` approval HIGH·그 밖 NORMAL, `collapse_key`, `ttl: "3600s"`, `data` 값은 모두 문자열).
  - 결과 표: 200 ok · 404 gone · 400 + `details[].errorCode: "UNREGISTERED"` gone · 401·403 credentials · 400 `INVALID_ARGUMENT` rejected · 429·503 retry.
- [ ] **Step 2: 실패하는 테스트 — 자격 증명.** 서비스 계정 JSON 의 `project_id`·`client_email`·`private_key`·`token_uri` 를 읽음 · 필드 빠짐 → `{ off: "invalid service account" }` · 로그에 이메일·키 원문 없음.
- [ ] **Step 3: 실패하는 테스트 — 통합.** `push-native.test.ts` 에 가짜 FCM(HTTP 서버 — 토큰 엔드포인트와 발송 엔드포인트 둘)로 Android 사례: 멘션 → 발송 하나 · `UNREGISTERED` → 기기 삭제 · 401 → 사건 · iOS·Android·웹 구독을 가진 한 사람에게 셋 다 감 · 능력 `android: true`.
- [ ] **Step 4: 실패 확인 → 구현 → 통과.**
- [ ] **Step 5: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 6: 커밋** — `feat(server): send push to Android devices through FCM`.

---

### Task 6: 문서

**Files:**
- Modify: `docs/guides/deploy.md`(「네이티브 푸시 자격 증명」 절 — Apple 개발자 → Certificates, Identifiers & Profiles → Keys → APNs 키(.p8)·키 id·팀 id, Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → 새 비공개 키, `data/apns/`·`data/fcm/` 배치와 환경 변수, 부팅 로그로 켜졌는지 보기), `docs/guides/live-smoke.md`(「네이티브 푸시 손 확인」 절 — 자격 증명이 생기면: 기기 토큰을 `POST /api/v1/push/devices` 로 넣고 멘션 → 실기기 알림. 실제 발송이므로 사람이 한다), `docs/project-structure.md`(`modules/push/transports/`·`devices.ts`·`credentials.ts`·`http/origins.ts`), 스펙 「구현과 맞춘 것」(PN1~PN4), `docs/plan.md`(Phase 4 앱 줄에 서버 하위 프로젝트 상태), 로드맵 하위 프로젝트 표의 상태 칸, `CLAUDE.md` 「현재 단계」

- [ ] **Step 1: 문서 작성**(위 목록 — 시크릿 원문 예시를 싣지 않는다).
- [ ] **Step 2: 루트 `pnpm fmt:check`.**
- [ ] **Step 3: 커밋** — `docs: document native push credentials and the hand check`.

---

## Self-Review 기록

- **스펙 대조**: 2장 → 태스크 2. 3장 → 3(webpush)·4(apns)·5(fcm)·4(relay 자리). 4장 → 3. 5장 → 2. 6장 → 4·5. 7장 → 1. 8장 → 범위 밖(모바일 하위 프로젝트). 9장 → 2·3·4·5. 10장 → 각 태스크·6.
- **이름 맞춤**: `allowedOrigins`·`isAllowedOrigin`·`PushDeviceInput`·`PushDeviceRemove`·`PushCapabilities`·`upsertDevice`·`removeDevice`·`listDevices`·`deleteDeviceById`·`PushTransport`·`TransportResult`·`WebTarget`·`DeviceTarget`·`PushNotification`·`webPushTransport`·`apnsTransport`·`loadApnsCredentials`·`APNS_JWT_TTL_MS`·`fcmTransport`·`loadFcmCredentials`·`FCM_TOKEN_TTL_MS` — 태스크 사이에서 같은 이름.
- **Review Focus**: 다섯 줄 모두 태스크 2·4·5 단계에 테스트가 있다.
