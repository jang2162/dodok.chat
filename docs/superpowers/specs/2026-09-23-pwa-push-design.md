# Phase 2 ④ PWA·푸시 설계

**상태**: 설계 확정(2026-09-23), 구현 전
**범위**: PWA 설치(매니페스트·아이콘·설치 버튼), 서비스 워커(앱 껍데기 저장·푸시·알림 누르기), 최근 채널 오프라인 읽기, 웹 푸시(멘션·승인 요청·릴레이 한도), iOS 설치 안내
**앞선 근거**: 계획서 `docs/plan.md` 8장 Phase 2 「PWA」·10장 결정 #5(푸시 MVP 포함) · 기술 표(`vite-plugin-pwa` + Workbox, `web-push`) · Phase 2 ① 스펙 `2026-09-20-activity-approvals-design.md` 5.4(탭 안 승인 알림·문구 규칙)

---

## 0. 결정 (브레인스토밍 2026-09-23)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **알림에는 누가·어디·무엇만 싣는다** — 본문·툴 인자·승인 설명은 싣지 않는다 | 알림은 잠금 화면에 뜬다. 탭 안 승인 알림과 같은 규칙이다. 푸시 서비스(FCM·APNs 중계)로 가는 페이로드도 작아진다(암호화는 되지만). |
| 2 | **그 채널을 보고 있으면 보내지 않는다** — 웹이 wire 로 「보이는가·보는 채널」을 알리고 서버가 거른다 | 브라우저는 받은 푸시마다 알림을 띄워야 한다(Chrome `userVisibleOnly`, Safari 동일). 서비스 워커에서 조용히 버리면 브라우저가 기본 알림을 대신 띄우거나 구독을 끊는다. 거르는 일은 보내는 쪽이 해야 한다. |
| 3 | **오프라인은 최근 채널 읽기 전용** — 채널 목록, 최근 본 채널 5개의 최근 메시지 50개, 작성자 정보를 IndexedDB 에 둔다. 로그아웃·401 이면 지운다 | 계획서 문구(「오프라인 최근 채널 캐시」) 그대로. 기기에 대화가 남는 대가를 개수·기한·지우기로 줄인다. |
| 4 | **한 스펙으로 한다** | 서비스 워커 하나를 설치·오프라인·푸시가 같이 쓴다. 나누면 같은 파일을 두 번 연다. |
| 5 | **실기기(iOS·안드로이드) 푸시 확인은 Phase 3** | 푸시·서비스 워커는 보안 출처에서만 돈다. `localhost` 는 되지만 실기기에는 HTTPS 배포가 필요하고, 배포 구성(`infra/`)은 Phase 3 이다. 이번 확인은 데스크톱 Chromium 이다. |
| 6 | **`vite-plugin-pwa`(`injectManifest`) + `workbox-*`** | 계획서 기술 표. 푸시 핸들러가 필요해 서비스 워커를 직접 쓴다(`generateSW` 로는 못 넣는다). 1.3.0 peerDeps 가 Vite 8 을 받는다 — rolldown 빌드와 맞는지는 계획 태스크 1 이 잰다. |
| 7 | **새 버전은 토스트로 묻는다** — 자동 갱신하지 않는다 | 작성 중에 새로고침되면 초안·첨부 칩을 잃는다. |
| 8 | **이 기기에 푸시가 켜져 있으면 탭 안 승인 알림은 쉰다** | 둘 다 켜 두면 다른 채널을 보고 있을 때 같은 승인이 두 번 울린다(서버 억제는 같은 채널을 볼 때만). |

---

## 1. 범위

**한다**
- 웹 매니페스트·아이콘(192·512·maskable)·`theme-color`, Chromium 「앱 설치」 버튼
- 서비스 워커: 빌드 산출물 미리 저장, SPA 탐색 폴백, 푸시 → 알림, 알림 누르기 → 그 채널, 구독 바뀜 처리
- 최근 채널 오프라인 읽기(TanStack Query 저장), 오프라인 배너, 새 버전 토스트
- 서버 `push` 모듈: VAPID 키, 구독 저장·해지, 트리거 셋, 보고 있으면 거르기, 발송 실패 정리
- 웹 알림 설정: 기기별 푸시 상태 다섯, 켜기·끄기, iOS 안내, 탭 안 승인 알림과의 조정
- 로그아웃 때 이 기기 구독 해지·사본 지우기

**하지 않는다**
- 실기기 푸시 확인(결정 5)
- 알림 종류별 켜고 끄기, 방해 금지 시간, 채널별 음소거 — 후속
- 본문 미리보기(결정 1)
- 오프라인 보내기 대기열(보내기는 연결될 때만)
- 첨부 이미지 오프라인 저장(이미지는 기존 물러남 — 파일 카드 꼴)
- 앱 배지(`setAppBadge`) — 후속

---

## 2. 구조

### 2.1 웹

| 자리 | 책임 |
| --- | --- |
| `apps/web/vite.config.ts` | `VitePWA({ strategies: "injectManifest", srcDir: "src", filename: "sw.ts", registerType: "prompt", manifest, devOptions: { enabled: true, type: "module" } })` |
| `apps/web/src/sw.ts` (새) | 서비스 워커. 순수 부분은 `src/pwa/sw-logic.ts` 로 뺀다(테스트) |
| `apps/web/src/pwa/` (새) | `register.ts`(등록·새 버전 토스트), `install.ts`(`beforeinstallprompt`·standalone·iOS 판정), `persist.ts`(Query 저장·복원·지우기), `push.ts`(구독·해지·상태), `sw-logic.ts`(알림 만들기·누르기 URL·열린 창 고르기) |
| `apps/web/src/app/layout/NotifyToggle.tsx` → `NotifySettings.tsx` | 사이드바 하단 알림 자리 — 푸시 상태 다섯·켜기·끄기·iOS 안내·앱 설치 |
| `apps/web/src/app/layout/Banners.tsx` | 오프라인 배너 |
| `apps/web/src/features/approvals/notify.ts` | 이 기기에 푸시가 켜져 있으면 탭 안 알림을 쉰다 |
| `apps/web/src/realtime/` | 보이는 상태·보는 채널을 wire 로 알린다(`presence.update`) |
| `apps/web/public/` | 아이콘 PNG(한 번 만들어 커밋) |

### 2.2 서버 — 새 모듈 `apps/server/src/modules/push/`

| 파일 | 책임 |
| --- | --- |
| `vapid.ts` | 키 불러오기·만들기(`data/vapid.json`, 0600) |
| `presence.ts` | 소켓별 `{ userId, visible, channelId? }` — 보이는 탭이 그 채널에 있는가 |
| `triggers.ts` | 순수 — 버스 이벤트 → 받을 사람·알림 내용(누가·어디·무엇) |
| `service.ts` | 구독 upsert·해지, 발송(발송기 주입), 404·410 정리 |
| `routes.ts` | `GET /api/v1/push/vapid-public-key` · `POST /api/v1/push/subscriptions` · `DELETE /api/v1/push/subscriptions` |

### 2.3 shared

- `PushSubscriptionInput` = `{ endpoint: https URL(최대 2048자), keys: { p256dh, auth }(base64url) }`
- `PushPayload` = `{ kind: "mention" | "approval" | "relay_limit", channelId, title, body, url, tag }` — 서비스 워커가 파싱한다(경계)
- wire `presence.update` = `{ visible: boolean, channelId?: Id }`(ack 없음)

---

## 3. 서비스 워커

- **미리 저장**: `precacheAndRoute(self.__WB_MANIFEST)`. 탐색 요청은 `index.html` 로(`NavigationRoute`), 단 `/api/`·`/socket.io/` 는 제외 — 그 둘은 네트워크만.
- **런타임 저장 없음**: API 응답·첨부는 서비스 워커가 저장하지 않는다(오프라인 사본은 4장의 Query 저장이 맡는다 — 로그아웃 때 한 곳에서 지운다).
- **`push`**: `event.data.json()` 을 `PushPayload` 로 파싱한다. 실패하면 「dodok — 새 알림」 한 줄을 띄운다(브라우저 규칙상 무엇이든 띄워야 한다). `showNotification(title, { body, tag, data: { url }, icon, badge, renotify: kind === "approval" })`.
- **`notificationclick`**: 알림을 닫고, 같은 출처 창이 있으면 **보이는 창 → 가장 최근 창** 순으로 골라 `focus()` 후 `navigate(url)`(탐색이 안 되면 `postMessage({ type: "navigate", url })` — 웹이 라우터로 옮긴다), 없으면 `openWindow(url)`. URL 은 같은 출처 상대 경로만(`/c/<id>`, `/c/<id>/activity`) — 페이로드의 다른 값은 무시한다.
- **`pushsubscriptionchange`**: 새 구독을 만들어 서버에 등록한다(쿠키 인증 — 로그인 상태면 된다). 실패는 조용히(다음에 앱을 열면 5장 동기화가 고친다).
- **새 버전**: `registerType: "prompt"` — 대기 중인 워커가 있으면 웹이 토스트 「새 버전이 있습니다」 + 「새로고침」 버튼. 누르면 `skipWaiting` 후 새로고침.

---

## 4. 오프라인 최근 채널

- `@tanstack/query-persist-client-core` + `idb-keyval` 로 **골라서** 저장한다(`shouldDehydrateQuery`):
  - `["me"]`, `["channels"]`, `["agents"]`, 최근 본 채널 5개의 `["members", id]`·`["timeline", id]`
  - 타임라인은 **최근 메시지 50개**만(잘라서 — `hasOlder: true` 로 저장). 보내는 중 항목(`pending`)은 저장하지 않는다.
- 「최근 본 채널」: 채널을 열 때 순서 목록(최대 5)을 갱신한다. 목록도 같은 저장소.
- 최대 나이 **7일**(`maxAge`), 앱 버전(빌드 해시)이 바뀌면 버린다(`buster`).
- **지우기**: 로그아웃, 401(`notifyUnauthorized`), 저장소 오류. `resetClientState` 가 한 곳에서 부른다.
- **오프라인일 때**: `me` 요청이 **네트워크 오류**로 실패하고 저장된 `me` 가 있으면 앱을 띄운다(401 이면 지우고 로그인으로). 배너 「오프라인 — 저장된 내용을 보여 줍니다」. 연결되면 배너가 사라지고 wire 재구독이 최신으로 채운다(지금 동작).
- 보내기·상호작용·채널 설정은 지금처럼 연결 없으면 막힌다.

---

## 5. 푸시

### 5.1 키·구독

- VAPID: 환경변수 `VAPID_PUBLIC_KEY`·`VAPID_PRIVATE_KEY` 가 둘 다 있으면 그것, 없으면 `data/vapid.json`(없으면 만들고 0600). `VAPID_SUBJECT` 기본 `mailto:dodok@localhost`(web-push 가 `mailto:` 또는 `https:` 를 요구). 비밀 키는 로그에 싣지 않는다(로거 가림 목록에 추가).
- 구독 등록: 세션 사용자. `endpoint` 로 upsert — 이미 다른 사용자에게 묶여 있으면 **지금 사용자로 옮긴다**(같은 브라우저에서 사람이 바뀐 경우). `user_agent` 저장.
- 해지: 세션 사용자 + `endpoint`. 없으면 204(멱등).
- **동기화**: 웹은 앱을 열 때 이 기기 구독이 있으면 서버에 다시 등록한다(키가 바뀌었거나 서버 DB 가 새로 만들어진 경우). 서버 공개키와 구독의 `applicationServerKey` 가 다르면 해지 후 새로 구독한다.

### 5.2 트리거 (`triggers.ts`, 순수)

| 버스 이벤트 | 받는 사람 | 제목 / 본문 | url / tag |
| --- | --- | --- | --- |
| `message.created`, `mentions.users` 에 사용자 U, 작성자 ≠ U | U | `dodok` / 「@<작성자 핸들>이 #<채널>에서 불렀습니다」(조사 `josa`) | `/c/<id>` / `mention:<channelId>` |
| `approval.requested` | 그 채널의 사람 멤버 | `dodok` / 「#<채널>에 승인 요청이 있습니다」 | `/c/<id>/activity` / `approval:<approvalId>` |
| `message.created`, `kind: system`, `systemMeta.kind: relay_limit` | 그 채널의 사람 멤버 | `dodok` / 「#<채널>의 에이전트 대화가 한도에 닿았습니다」 | `/c/<id>` / `relay:<channelId>` |

- 작성자 핸들을 못 풀면 「누군가」. 채널 이름은 채널 행의 이름.
- 사람이 사람을 멘션해도 보낸다(작성자 ≠ U).

### 5.3 보고 있으면 거르기 (`presence.ts`)

- 웹은 `document.visibilityState` 와 지금 채널이 바뀔 때마다 `presence.update { visible, channelId }` 를 보낸다(연결 직후 한 번 포함).
- 서버는 소켓별 상태를 쥐고, 소켓이 끊기면 지운다.
- 발송 직전: 받는 사람 U 의 소켓 중 **`visible && channelId === 이벤트 채널`** 이 하나라도 있으면 U 에게는 보내지 않는다. 승인 요청도 같다(그 채널을 보고 있으면 카드가 눈앞에 있다).

### 5.4 발송 (`service.ts`)

- `web-push.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: kind === "approval" ? "high" : "normal", topic: <tag 에서 32자 이하 url-safe> })`.
- 응답 404·410 → 그 구독을 지운다. 413·400 → 오류 로그(페이로드 버그). 그 밖(429·5xx·네트워크) → 경고 로그, 재시도하지 않는다.
- 발송은 버스 처리기를 막지 않는다(비동기, 사용자당 병렬). 한 사용자의 구독이 여럿이면(기기 여럿) 모두에게.
- 발송기는 `createPushService({ send })` 로 주입 — 테스트는 가짜.

---

## 6. 웹 알림 설정 (`NotifySettings.tsx`)

사이드바 하단 `NotifyToggle` 자리를 바꾼다. 누르면 작은 패널(Popover 또는 기존 Sheet)이 열린다.

| 상태 | 판정 | 보이는 것 |
| --- | --- | --- |
| 미지원 | `serviceWorker`·`PushManager`·`Notification` 중 하나라도 없음(iOS 가 아닌 경우) | 「이 브라우저는 푸시 알림을 지원하지 않습니다」 |
| 설치 필요 | iOS 이고 standalone 이 아님 | 「홈 화면에 추가하면 알림을 받을 수 있습니다 — 공유 → 홈 화면에 추가」 |
| 거절됨 | `Notification.permission === "denied"` | 「브라우저 설정에서 알림을 허용해 주세요」 |
| 꺼짐 | 권한 기본·허용이고 이 기기 구독 없음 | 「푸시 알림 켜기」 버튼 |
| 켜짐 | 이 기기 구독 있음 | 「이 기기에서 알림을 받습니다」 + 「끄기」 |

- 켜기는 버튼을 누를 때만 권한을 묻는다. 권한 → 구독(`userVisibleOnly: true`, 서버 공개키) → 서버 등록. 실패하면 이유를 패널에 쓴다.
- 「앱 설치」: `beforeinstallprompt` 를 받았고 아직 설치 안 됐으면 같은 패널에 버튼.
- 탭 안 승인 알림(결정 8): 이 기기 구독이 있으면 `notify.ts` 가 알리지 않는다. 푸시를 켜지 않은 사람은 지금처럼 탭 안 알림이 돈다. 옛 「알림 켜기」(탭 안 권한만) 버튼은 이 패널에 흡수된다 — 푸시 미지원 브라우저에서는 「탭이 열려 있을 때만 알림 켜기」로 남긴다.
- 로그아웃: 이 기기 구독이 있으면 서버 해지 → `unsubscribe()` → 사본 지우기(4장). 서버 해지가 실패해도 기기 쪽은 해지한다.

---

## 7. 오류 처리

| 상황 | 결과 |
| --- | --- |
| 서비스 워커 등록 실패 | 앱은 그대로(PWA 기능만 없음), 콘솔 경고 |
| 푸시 페이로드 파싱 실패 | 「dodok — 새 알림」, url `/` |
| 구독 등록 실패(네트워크·401) | 패널에 이유, 기기 구독은 해지(반쪽 상태를 남기지 않는다) |
| 서버 발송 410 | 구독 삭제 |
| 오프라인 시작 + 저장된 `me` 없음 | 지금처럼 오류 화면(「서버에 연결할 수 없습니다」) |
| 저장소(IndexedDB) 없음·오류 | 저장 없이 돈다 |

---

## 8. 검증

### 8.1 서버
- 단위: `triggers`(표 5.2 세 줄, 작성자 = 받는 사람 제외, 핸들 못 풂), `presence`(같은 채널·다른 채널·보이지 않음·끊김), `vapid`(환경변수 우선·파일 만들기·권한 0600), 발송 결과 분기(404·410 삭제).
- 통합 12a~: 구독 경로(권한·upsert·다른 사용자 옮기기·해지 멱등), 멘션 푸시(가짜 발송기가 받은 페이로드), 보고 있으면 거름, 승인 요청 푸시, 릴레이 한도 푸시, 410 정리, **페이로드에 본문이 없다**.

### 8.2 웹
- `sw-logic`(알림 만들기·파싱 실패·누르기 URL 은 같은 출처 상대만·창 고르기), `persist`(골라 저장·50개 자르기·pending 제외·지우기·7일), `push`(상태 다섯 판정·켜기 흐름·실패 시 해지), `install`(iOS·standalone 판정), 오프라인 배너, 탭 안 승인 알림 조정, `presence.update` 보내는 때.

### 8.3 브라우저 검증 (dev:fake, 5180 — 5173 은 다른 프로젝트)
- 설치 가능 판정(매니페스트·서비스 워커 — DevTools Application 에 해당하는 CDP 확인), 앱 설치.
- 오프라인: 네트워크를 끊고 새로고침 → 앱이 뜨고 최근 채널이 보이고 배너, 보내기 막힘, 다시 연결되면 최신.
- 푸시: 켜기 흐름(권한 허용 자동화), **CDP `ServiceWorker.deliverPushMessage` 로 푸시를 넣어** 알림이 뜨고 누르면 그 채널로. 서버 트리거는 가짜 발송기 대신 실제 `web-push` 로 한 번 FCM 을 거쳐 보내 본다(되면 기록, 안 되면 그 사실).
- 로그아웃 뒤 IndexedDB 사본·구독이 없다.
- 새 버전 토스트(빌드 두 번).

### 8.4 실연
- 에이전트 멘션 푸시는 dev Gateway 실연에서 한 번(모델 런 1회 — 사용자 승인). 실기기는 Phase 3.

---

## 9. 완료 기준

- Chromium 데스크톱에서 설치되고, 오프라인에서 최근 채널을 읽을 수 있다.
- 탭을 닫아도 멘션·승인 요청·릴레이 한도가 푸시로 오고, 누르면 그 자리로 간다. 그 채널을 보고 있으면 오지 않는다.
- 알림에 메시지 본문·승인 내용이 없다.
- 로그아웃하면 이 기기에 구독·대화 사본이 남지 않는다.
- 서버 통합·웹 단위·브라우저 검증 결함 0, 검사 4종 통과.

---

## 10. 열린 문제 (범위 밖 기록)

- 실기기(iOS 16.4+ 홈 화면 PWA, 안드로이드 Chrome) 푸시 — Phase 3 HTTPS 배포 뒤.
- iOS 는 설치 PWA 의 저장소를 오래 안 쓰면 지울 수 있다 — 오프라인 사본이 사라질 수 있다.
- 푸시 서비스로 가는 메타데이터(언제·몇 번)는 암호화와 별개로 드러난다.
- 서버 재시작 직후 presence 가 비어 있는 몇 초 동안은 보고 있어도 푸시가 갈 수 있다.
