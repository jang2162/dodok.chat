# Phase 2 ④ PWA·푸시 설계

**상태**: 설계 확정(2026-09-23), 구현·브라우저 검증 완료(2026-09-24 — 계획 태스크 1~7, 브라우저 16/16·결함 0), 실연 완료(2026-09-24 — `docs/guides/live-smoke.md` 14.4: 런 0회 하네스 7/7 + 모델 런 1회) — 구현이 이 설계와 달라진 것은 11장
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

---

## 11. 구현과 맞춘 것 (2026-09-24)

구현(계획 태스크 1~6)·리뷰·브라우저 검증(태스크 7)과 그 수정 라운드에서 이 설계와 달라진 것만 모았다. main `330f5e8` 기준이다.
정본 근거는 실행 원장 `.superpowers/sdd/2026-09-23-pwa-push/ledger.md`(git 제외)의 판정 R1~R8 과, 원장이 가리키는 보고서·리뷰(`p4-t*`)다. 보고서의 커밋 해시는 워크트리 것이라 main 에서는 다르다 — 아래 해시는 main 의 것이다.
남은 문제는 `docs/plan.md` 8장 「이월」 한곳에 있다. 실연(8.4, 계획 태스크 9)은 2026-09-24 에 마쳤다 — 런 0회 하네스 7/7, 모델 런 1회(멘션·`finalSource=plugin` 통과, 그 런의 알림 표시는 미확인 — `docs/plan.md` 8장 이월). 실연 뒤 곁가지 p4-c1 이 웹 `pagehide` 에서도 `presence.update { visible: false }` 를 보내게 하고(`a81e850`, Chromium 은 언로드 때 `visibilitychange` hidden 이 먼저 와 측정상 효과 없음 — 그것이 오지 않는 엔진 대비), 서버가 `LOG_LEVEL=debug` 에서 거름(`push skipped — watching`: userId·channelId·kind)과 발송(`push sent`: 구독 id·statusCode)을 한 줄씩 남기게 했다(`9fa919b`).

**계획이 정한 둘**(계획 Self-Review 「스펙과 다르게 정한 것」)

- **VAPID 주체가 로컬 자리값이면 서버 시작 때 warn 한 줄**(5.1 보탬). 기본값 `mailto:dodok@localhost` 는 개발 편의로 그대로 두었다. 주체의 호스트(`mailto:` 는 마지막 `@` 뒤, `https:` 는 URL 호스트)가 `localhost`·`127.0.0.1`·`*.local` 이면 `createApp` 한 번에 한 번 `VAPID subject is a local placeholder — Apple Push rejects it (403 BadJwtToken)` 을 남긴다(`apps/server/src/config.ts:86-` `isLocalVapidSubject`, `apps/server/src/app.ts:194-203`).
  까닭: 실행 전 이슈 확인에서 Apple Push 가 이런 주체를 `403 BadJwtToken` 으로 거부한다는 것(web-push#947·#988)을 찾았다. `[::1]`·`*.localhost` 는 warn 하지 않는다(p4-t2 보고서 걱정).
- **발송 응답 403 은 구독을 지우지 않는 error 다**(5.4 정정 — 5.4 는 404·410 삭제, 413·400 error 만 말했다). 403 은 VAPID 주체·키 문제라 구독 탓이 아니다(`apps/server/src/modules/push/service.ts:141-146`).
  그래서 주체가 잘못된 배포에서는 발송마다 error 가 쌓인다 — 운영자가 봐야 할 신호로 둔다(p4-t3 보고서 걱정).

**웹 PWA 껍데기에서 달라진 것**(태스크 1 — `7710487`·`f6741f3`)

- **R4 — 개발 모드 서비스 워커는 기본으로 끈다**(2.1 정정). 2.1 은 `devOptions: { enabled: true, type: "module" }` 이었다. 지금은 `enabled: process.env.VITE_PWA_DEV === "1"` 이고 `navigateFallback` 도 두지 않는다(`apps/web/vite.config.ts:10-13`·`:50-51`, `f6741f3`).
  까닭: 계획 Step 3 이 더한 `navigateFallback: "index.html"` 때문에 개발 SW 가 **Vite 가 변환한 dev `index.html`** 을 미리 저장하고 탐색을 가로챘다. 같은 오리진에서 dev 뒤에 preview 를 띄우면 빈 화면에 갇혔다(p4-t1b 리뷰 D1, 실측). 또 이 머신의 5173 은 다른 프로젝트라, dodok dev 를 5173 에서 한 번 연 브라우저는 그 오리진의 다른 앱에도 SW 를 남긴다.
  끄면 `virtual:pwa-register` 가 아무것도 하지 않는 `registerSW` 로 풀려 `startPwa` 도 등록하지 않는다(p4-t1b 재리뷰 실측). 브라우저 검증은 빌드본 `vite preview` 로 하거나 `VITE_PWA_DEV=1` 을 셸에 준다(설정은 `loadEnv` 를 쓰지 않아 `.env` 의 값은 닿지 않는다). 절차는 `docs/guides/live-smoke.md`「푸시 확인 절차 (`dev:fake`, 모델 런 0회)」.
  **틀리면 남는 것**: 개발 중 SW 동작을 보려면 환경변수 하나가 더 든다. 빌드본은 끄기에 안 걸린다 — 빌드본 SW 는 미리 저장 목록에 `index.html` 이 있을 때만 탐색 폴백(`NavigationRoute`)을 건다(`apps/web/src/sw.ts:15-20`). 반대 방향(preview 를 띄웠던 오리진에서 dev 로 돌아오기)은 PWA 본성상 옛 빌드가 계속 뜬다 — SW 를 해제하거나 Shift+새로고침한다.
- **`sw.ts` 는 주입 자리 `self.__WB_MANIFEST` 를 한 번만 읽는다**(3장 보탬). `const manifest = self.__WB_MANIFEST` 뒤 `precacheAndRoute(manifest)`·`manifest.some(...)` 이다(`apps/web/src/sw.ts:9-16`). workbox `injectManifest` 는 그 자리가 파일에 정확히 한 번 나오기를 요구한다 — 계획 코드처럼 두 번 참조하면 빌드가 `AssertionError` 로 실패했다(p4-t1b 보고서 표 1). 태스크 5 브리프에 「다시 참조 금지」로 넘겼다.
  `self` 의 타입은 workbox-precaching 이 이미 선언한 전역을 쓴다(`declare const self: ServiceWorkerGlobalScope`). 계획의 교차 타입은 `TS2339` 로 깨졌다.
- **`includeManifestIcons: false`**(2.1 보탬, `apps/web/vite.config.ts:47-48`). 아이콘은 `globPatterns` 가 이미 담는다. 켜 두면 매니페스트 아이콘 셋이 미리 저장 목록에 두 번 들어갔다(33 → 30 항목, 지금 빌드는 `main.tsx` 의 등록 조각 둘까지 32).
- **등록은 `injectRegister: false` + 렌더 뒤 동적 import**(2.1 보탬). `main.tsx` 가 `bootApp(...)` 이 끝난 뒤 `import("virtual:pwa-register")` 로 `startPwa` 를 부른다 — 최상위 await 로 첫 렌더를 막지 않는다. 실패는 `console.warn`.
- **`theme-color` 는 meta 둘**(라이트 `#f6f7f8`·다크 `#18191c`, `media` 로 나눔 — `apps/web/index.html:8-9`). 매니페스트에는 값 하나만 되므로 라이트 배경 토큰 값이다.
- **서비스 워커 타입 검사는 따로 한다**. `apps/web/tsconfig.sw.json`(`lib: ["ES2023","WebWorker"]`, `include`: `src/sw.ts`·`src/pwa/sw-logic.ts`)이 새로 생겼고, 앱 tsconfig 는 `sw.ts` 를 뺀다. `sw-logic.ts` 는 두 설정이 모두 검사한다(DOM·WebWorker 어느 전역도 쓰지 않는다). `typecheck`·`build` 둘 다 두 설정을 돈다.
- **`vite-plugin-pwa` 는 `devDependencies`**, `workbox-*` 셋은 런타임이라 `dependencies`(p4-t1b 리뷰 D2, `f6741f3`).

**shared·서버에서 달라진 것**(태스크 2·3·6 — `b65a247`·`60b3ac3`·`e33509c`·`0ba1ad2`·`1d1454d`)

- **`PresenceUpdate` 는 wire 계약에 있다**(2.3 보탬 — 자리). `packages/shared/src/wire/index.ts:67` 의 `Typing` 옆이다(push 모듈이 아니다). `@dodok/shared` 루트 export 로 둘 다 보이니 쓰는 쪽은 차이가 없다.
- **`VAPID_SUBJECT` 검사가 조금 더 엄격하다**(5.1 보탬). `mailto:`/`https:` 로 「시작」만 보지 않고 `^mailto:\S+$`·`^https://\S+$` 를 요구한다(`apps/server/src/config.ts:34-40`). 그래서 `mailto:` 만 있는 값은 설정 오류다.
- **망가진 `vapid.json` 은 덮어쓰지 않고 던진다**(5.1 보탬). 지우면 새로 만들지만 모든 구독이 무효가 된다는 문구로 부팅이 멈춘다(`apps/server/src/modules/push/vapid.ts:19-25`). 새 파일은 `flag: "wx"`·`0600` 이다.
- **구독 행의 user-agent 는 512자에서 자른다**(5.1 보탬, `apps/server/src/modules/push/routes.ts:19`). 클라이언트가 보내는 헤더라 상한을 두었다.
- **트리거의 DB 조회는 `service.ts` 에 있다**(2.2 정정). `triggers.ts` 는 순수(받을 사람·알림 내용)이고, 조회 `createTriggerLookups`(채널 이름은 `getChannel(db, id, workspaceId)` — 다른 워크스페이스면 없음)와 버스 배선 `attachPushTriggers` 는 `service.ts` 다. 발송기 `createPushDispatcher` 는 `PushTarget` 만 받는다.
- **발송기 주입은 `AppDeps.pushSend` 다**(5.4 정정 — 5.4 는 `createPushService({ send })` 였다). `createApp` 이 `pushSend` 를 받고, 없으면 `webPushSender({ subject, publicKey, privateKey })` 를 쓴다. 발송·정리는 `createPushDispatcher({ db, logger, send, presence })` → `{ dispatch, drain }` 이고, `dispatch` 는 던지지 않는다(DB 오류도 error 로그).
- **같은 승인은 한 번만 보낸다**(5.2 보탬). 승인 서비스가 늦게 차는 값(대기 카드의 `urlPath` 등)을 병합하면 같은 id·같은 `pending` 으로 `approval.requested` 를 버스에 다시 싣는다(`publish(announce:false)`). 그대로 두면 승인마다 푸시가 두 번 간다. 최근 1000개 id 를 기억한다(`apps/server/src/modules/push/service.ts:212`·`:236-243`, 통합 12c).
  리뷰가 코드로 확인했다 — 같은 id 가 다시 `pending` 이 되는 길이 없어 정당한 두 번째 알림을 삼키지 않는다(p4-t3 리뷰 A 9번). 기억은 메모리뿐이라 재시작 뒤 다시 실리면 한 번 더 가지만, 재시작하면 `recoverOnBoot` 가 대기 승인을 닫는다.
- **종료 때 트리거를 떼고, 진행 중인 발송을 최대 2초 기다린다**(5.4 보탬). `shutdown` 둘째 단계에서 `push-triggers` 를 떼고(새 발송 없음), DB 를 닫기 직전 `push-drain` 이 `PUSH_DRAIN_TIMEOUT_MS = 2_000` 까지 기다린다(`apps/server/src/app.ts:51`·`:285`·`:294`). 404·410 정리가 닫힌 DB 에 막히지 않게 하되, 응답 없는 푸시 서비스가 종료(상한 10초)를 붙잡지 않게 했다. 2초를 넘긴 결과는 error 로그 한 줄이 되고 정리는 다음 410 때 한다(p4-t3 리뷰 실측).
- **발송 로그에 endpoint 도 싣지 않는다**(5.1 보탬 — 5.1 은 비밀 키·구독 `keys` 만 말했다). endpoint 는 그 자체로 발송 권한이 걸린 주소라서다. 로그 필드는 `userId`·`subscriptionId`·`kind`·`statusCode`·`reason`(오류 이름과 메시지, 200자)뿐이고, 성공 발송은 로그를 남기지 않는다(브라우저 검증 H — 서버 로그 386줄에서 `p256dh`·비밀 키·알림 문구·`fcm/send` 0회).
- **`webPushSender` 는 요청마다 `timeout: 10_000` 을 준다**(5.4 보탬, `apps/server/src/modules/push/service.ts:69`·`:91`). 응답 없는 푸시 서비스가 소켓을 붙잡지 않게. web-push 의 `timeout` 은 소켓 **유휴** 제한이라 조금씩 흘리는 서버는 더 오래 붙잡을 수 있다(p4-t3 리뷰 「못 잰 것」) — 종료는 drain 상한이 막는다.
- **멘션 문구의 조사는 `josa` 결과 그대로**(5.2 보탬). 계획 예시 「@alice이」는 실제로 「@alice가」다(끝 묵음 e 를 떼고 판단). 핸들을 못 풀면 「누군가가」, 채널 이름을 못 풀면 「채널」이다(`apps/server/src/modules/push/triggers.ts:15`·`:44`). 자기 멘션은 **작성자가 사람일 때만** 뺀다(에이전트 작성자와 id 가 겹쳐도 빼지 않는다).
- **서버는 `presence.update` 의 `channelId` 를 검증하지 않는다**(5.3 보탬, 계획대로). 남의 채널 id 를 보내면 자기 알림이 덜 올 뿐이다. 소켓 수 상한도 없다(끊김마다 지우므로 새지는 않는다).
- **테스트 앱은 늘 가짜 발송기**(8.1 보탬). `bootTestApp`·`bootLiveApp` 이 `deps.pushSend` 가 없으면 `noExternalPush` 를 넣고, 테스트 환경은 프로세스마다 만든 VAPID 키를 환경변수로 준다 — 저장소에 `data/vapid.json` 을 만들지 않는다(원장 R2). 반대로 **`dev:fake` 는 실제 `web-push` 발송기**다 — 구독하고 트리거를 일으키면 실제 FCM 으로 나간다(`startDevFake` 의 `pushSend` 옵션으로만 바꾼다). `dev:fake` 는 `data/vapid.json` 을 지우지 않는다(재시작해도 구독이 산다).
- **`dev:fake` 키워드 「나 불러」**(8.3 보탬, 태스크 6). 에이전트가 `@<부른 사람 핸들> 확인해 주세요` 로 답해 멘션 푸시를 일으킨다. 「느리게」와 함께 쓰면 델타가 1.5초 간격이라 채널을 옮길 시간이 난다.

**웹 오프라인에서 달라진 것**(태스크 4 — `c6d8744`·`5a4188f`)

- **R3 — `["channel", id]` 도 최근 채널이면 저장한다**(4장 보탬). 4장 목록은 `members`·`timeline` 만 말했다. 서버만 죽고 브라우저는 온라인인 경우 자리값은 오류 상태에서 사라져 「채널을 불러오지 못했습니다」가 뜬다 — 저장해 두면 값이 남는다. 「최근 본 채널」 목록 자체는 `["recentChannels"]` 쿼리다(`apps/web/src/pwa/persist.ts:38-45`). 채널 화면이 부르는 나머지 키(`adapter`·런·활동·에이전트 찾기)는 저장하지 않는다.
- **me 가 없는 스냅샷은 저장하지 않고 사본을 지운다**, 뮤테이션은 두 겹으로 저장하지 않는다(`shouldDehydrateMutation: () => false` + `trimForPersist` 의 `mutations: []` — 로그인 토큰이 뮤테이션 변수에 있다). 사본은 로그인한 사람의 것이다(`persist.ts:151-155`).
- **R5 — 저장하는 타임라인의 `lastSeq` 는 0 이다**(4장 정정 — 4장은 「연결되면 wire 재구독이 최신으로 채운다(지금 동작)」라고 했다). 복원한 채널의 첫 구독이 이어 받기가 아니라 최신 페이지로 새로(`fresh`) 시작한다(`persist.ts:47-55`, `5a4188f`).
  까닭: 카드 상호작용(`message.updated`)은 seq 가 그대로라 이어 받기로는 오지 않는다. 사본의 `lastSeq` 로 이으면 앱이 닫혀 있던 동안의 결과 줄이 영영 안 보였다(p4-t4 리뷰 결함 1, 실물 재현 — Phase 2 ② 의 「결과 줄은 새로고침·새 탭에서도 보인다」가 깨진다). 브라우저 검증 L 이 실물에서 고쳐진 것을 봤다. **틀리면 남는 것**: 복원 직후 최신 50개를 한 번 더 받는다.
- **R6 — `gcTime` 은 기본(5분) 그대로, 사본은 이전 사본에서 이어 붙인다**(4장 보탬). 첫 구현은 최근 채널 사본이 gc 로 빠지지 않게 `channel`·`members`·`timeline` 의 `gcTime` 을 7일로 올렸다. 그러면 세션 내내 들른 **모든** 채널이 메모리에 남고 `lastSeq` 이어 받기의 낡음 틈이 세션 전체로 넓어졌다(p4-t4 리뷰 C).
  지금은 저장할 때 **최근 목록에 있는데 캐시에 없는** 채널 쪽 항목을 마지막으로 저장·복원한 사본에서 붙인다(`carryOver`, `persist.ts:92-107`). 지운(`clear`) 뒤와 최근에서 밀려난 채널은 붙이지 않는다. `recentChannels` 만 `gcTime` 무한이다(`:169-170`).
- **저장마다 세대(epoch)를 달고, 쓰는 순간에도 본다**(4장 「지우기」 보탬). 잘라 두기(1초)로 기다리던 저장, 그리고 직렬화를 마치고 쓰기만 남은 저장이 로그아웃·401 로 지운 **뒤에** 옛 사본을 다시 쓸 수 있었다 — 뒤엣것은 수정 라운드가 테스트로 찾았다. `serialize` 와 `setItem` 두 자리에서 세대를 보고, 지우기가 세대를 올린다(`persist.ts:121-150`).
- **값을 가진 채 실패한 쿼리는 성공으로 저장한다**(`trimForPersist`, `persist.ts:57-79`). 오류 객체는 직렬화되지 않고, 복원 뒤 오류로 남으면 오프라인 판단이 틀린다.
- **복원은 최대 1초만 기다리고, 복원한 me 는 낡은 것으로 둔다**(4장 보탬). 1초 안에 못 읽으면 사본 없이 띄운다(늦게 온 값은 버린다). 복원 뒤 `invalidateQueries(me, refetchType: "none")` — 첫 관찰자·연결 회복 때 me 를 다시 불러 세션을 확인한다(`persist.ts:156-183`). 실측: 저장소가 멈추면 1,299ms 에 그려졌다(p4-t4 리뷰 B-6).
- **`buster` 는 `__BUILD_ID__`** = `VITE_BUILD_ID` 환경변수, 없으면 빌드 시각(`apps/web/vite.config.ts:15-19`).
- **R7 — 부팅에서 `onlineManager.setOnline(navigator.onLine)`**(4장 「오프라인일 때」 보탬). Query 의 `onlineManager` 는 온라인으로 시작해 `online`·`offline` 이벤트로만 바뀐다. 그래서 기기가 처음부터 오프라인이면 REST 6종을 3번씩 부르고 3.1초에 「서버에 연결할 수 없습니다」 토스트가 배너와 같은 사실을 한 번 더 말했다(p4-t4 리뷰 결함 2). 지금은 요청을 쉬었다가 `online` 이벤트에 다시 부른다(브라우저 검증 K — API 요청 0·토스트 0·배너 1).
  배선은 `apps/web/src/app/boot.tsx` 의 `bootApp` 하나로 뺐다(온라인 여부 → 복원 대기 → `registerSessionReset(clear)` → 렌더). `main.tsx` 와 테스트가 같은 것을 부른다(p4-t4 리뷰 결함 3 의 N28·N29).
- **오프라인 판단**(4장 보탬, `apps/web/src/pwa/offline.ts`): `!navigator.onLine || !onlineManager.isOnline()`, 또는 me 가 **값을 가진 채** `NetworkError` 다. 브라우저는 온라인인데 서버만 죽은 경우도 배너가 뜬다(me 재시도 뒤 약 3초). 오프라인이면 「서버에 다시 연결하는 중…」 배너는 내지 않는다(같은 `role="status"` 자리에 하나만). me 는 관찰자 없이 캐시 구독으로 읽는다 — 관찰자를 두면 세션 정리 뒤 me 를 다시 불러 로그인 화면이 되돌아갔다.
- **`MessageList` 의 「새 메시지」 칩 기준은 가진 마지막 메시지의 seq 다**(R5 의 부수 효과, `apps/web/src/features/messages/MessageList.tsx:343-351`). 기준이 `timeline.lastSeq` 면 사본(0)에서 위로 스크롤할 때 가진 50개를 모두 새 메시지로 셌다. 평소에는 두 값이 같다(p4-t4 재리뷰 RR1~RR6).
- **`queryClient` — 값을 가진 me 의 401 은 `onUnauthorized`**(4장 「401 이면 지우고 로그인으로」 보탬, 조율자 허락). 복원한 me 는 다시 요청돼 401 이어도 전에는 me 오류를 통째로 무시해 아무 일도 없었다. 값이 **없는** me 의 401(첫 가드)은 지금처럼 가드만 로그인으로 보낸다 — 두 번 가지 않게(`apps/web/src/app/queryClient.ts:31-45`).
- 「최근 본 채널」은 채널이 **확인된 뒤에** `apps/web/src/features/messages/ChannelPage.tsx` 가 갱신한다(없는 채널은 넣지 않는다).

**웹 푸시에서 달라진 것**(태스크 5 — `7a352b8`·`330f5e8`)

- **플래그 `dodok.push` 의 값은 켠 사용자의 id 다**(5.1 「동기화」·6장 보탬, `apps/web/src/pwa/push.ts:10-14`). 그래서 `enablePush(userId)`·`syncPushSubscription(userId)` 가 인자를 받는다. 앱을 열 때 동기화가 **다른 사람(또는 누가 켰는지 모르는) 구독**을 다시 등록하면 그 endpoint 가 지금 사용자에게 옮겨져, 스스로 켜지 않은 사람에게 푸시가 온다. 플래그가 지금 사용자와 다르면 기기에서 해지하고 등록하지 않는다(`push.ts:187-201`). 사용자 id 는 비밀이 아니다.
- **`dropLocalPush()` — 세션이 이미 없을 때 기기 구독만 해지한다**(6장 「로그아웃」 보탬, `push.ts:177-185`). 서버 해지(DELETE)에는 세션이 필요하다. 해지된 endpoint 는 다음 발송의 404·410 이 서버 행을 지운다. 세션 정리 훅(`resetClientState`)이 부른다.
- **R8 — 세션 없이 연 앱도 기기 구독을 해지한다, 401 에서만**(6장 보탬, `apps/web/src/realtime/WireProvider.tsx:72-76`, `330f5e8`). 값이 없는 me 의 401 은 세션 정리로 오지 않는다(위 `queryClient` 규칙 — 가드만 보낸다). 그래서 사본 없이 세션이 만료된 채 연 로그인 화면에서는 구독이 살아 있었다(p4-t5 리뷰가 실물 재현). 지금은 `!signedIn && me.error` 가 401 일 때 `dropLocalPush()` 를 한 번 부른다. NetworkError·5xx·오프라인은 해지하지 않는다(재리뷰 탐침 P1~P6 — 겹쳐 불려도 멱등이다).
  **틀리면 남는 것**: 30일 넘게 앱을 안 연 사람이 다시 로그인하면 푸시를 손으로 다시 켜야 한다. 서버 구독 행이 세션보다 오래 사는 문제는 그대로다(`docs/plan.md` 8장 이월).
- **로그아웃은 `disablePush()` 를 최대 3초만 기다린다**(6장 보탬, `apps/web/src/features/auth/mutations.ts:9`·`:42-44`). 순서는 `DELETE /push/subscriptions` → `POST /auth/logout` → 세션 정리(브라우저에서 서버 로그 순서로 확인). 서버가 답하지 않아도 로그아웃이 막히지 않고, 3초를 넘기면 세션 정리의 `dropLocalPush` 가 기기 구독을 해지한다(그때 서버 행은 다음 410 까지 남는다). 테스트가 2999ms·3000ms 경계를 잰다.
- **알림 누르기는 `postMessage` 만 쓴다**(3장 정정 — 3장은 `focus()` 후 `navigate(url)`, 안 되면 `postMessage` 였다). 창이 있으면 `focus()` 뒤 `postMessage({ type: "navigate", url })`, 받는 쪽(`apps/web/src/app/createApp.ts:46-52`)이 `safeNotificationUrl` 로 한 번 더 걸러 라우터로 옮긴다. 창이 없으면 `openWindow(url)`(`apps/web/src/sw.ts:46-66`). 계획 코드를 따랐고, 초안은 이 규칙으로 남는다.
  까닭: `WindowClient.navigate()` 는 전체 새로고침이라 작성 중인 초안·첨부 칩을 잃는다(결정 7). 브라우저 검증 6 이 새로고침 없이 옮겨 가는 것(`window.__marker` 생존)을 봤다.
- **창 고르기 순서**(3장 보탬, `apps/web/src/pwa/sw-logic.ts:54-66`): 같은 출처 창 가운데 **보이면서 포커스 → 보임 → 포커스 → 첫 창**(`matchAll` 은 최근에 포커스된 순). 3장의 「보이는 창 → 가장 최근 창」을 풀어 쓴 것이다.
- **빈 tag 면 tag·`renotify` 를 싣지 않는다**(3장 보탬, `sw-logic.ts:24-38`). shared `PushPayload.tag` 는 빈 값을 받는데, `renotify: true` + 빈 tag 는 `showNotification` 이 TypeError 로 던져 알림이 안 뜬다 — 받은 푸시마다 무엇이든 띄워야 한다는 규칙(결정 2)을 어긴다.
- **`enablePush` 는 서비스 워커 `ready` 를 10초까지만 기다린다**(6장 보탬, `push.ts:15`·`:86-97`). 개발 모드(SW 꺼짐, R4)에서 `ready` 는 끝나지 않는다. 넘으면 이유 「서비스 워커가 준비되지 않았습니다 — 새로고침한 뒤 다시 시도해 주세요」.
- **켜기 실패 이유**(6장 보탬). 권한 물음을 닫아 `default` 로 끝나면 「알림 권한을 허용해야 켤 수 있습니다」, 거절(`denied`)로 끝나면 이유를 따로 싣지 않는다 — 상태 줄이 같은 문장을 이미 보인다(p4-t5 리뷰 Minor 2, `apps/web/src/app/layout/NotifySettings.tsx:81`). 「꺼짐」 상태에는 안내 한 줄(「멘션·승인 요청·에이전트 대화 한도를 이 기기로 알립니다」)을 더했다. 켜고 끄는 동안은 버튼을 잠그고 패널이 닫히지 않는다(이유를 잃지 않게).
- **알림 패널은 Dialog 다**(6장 「Popover 또는 기존 Sheet」 정정). 사이드바 하단 「알림」(벨) 버튼이 `ui/dialog` 패널을 연다. `NotifyToggle.tsx` 는 지웠고 그 테스트는 `NotifySettings.test.tsx` 로 옮겼다. 푸시가 없는 브라우저(iOS 아님)에서 `Notification` 권한이 `default` 면 「탭이 열려 있을 때만 알림 켜기」가 남는다.
- **알림 권한 읽기를 `push.ts` 에 따로 둔다**(`pushPermission`). `features/approvals/notify.ts` 가 `pushOnThisDevice` 를 쓰므로 push.ts 가 notify.ts 를 가져오면 순환 import 가 생긴다. 판정은 같다.
- **presence 보내기**(5.3 보탬, `apps/web/src/realtime/WireProvider.tsx:123-157`). 연결될 때마다 강제로 보내고, `visibilitychange`·채널 이동 때는 값이 바뀌었을 때만 보낸다. **끊겨 있으면 보내지 않는다** — socket.io 는 끊긴 동안의 emit 을 모았다가 다시 붙을 때 보내 낡은 값이 먼저 간다. 채널 id 는 uuid 일 때만 싣는다. WireProvider 는 RouterProvider 바깥이라 채널 이동은 `router.subscribe("onResolved")` 로 받는다(`createApp.ts:42-43`).
- **「앱 설치」 이벤트는 앱 시작 때부터 받는다**(`captureInstallPrompt`, `createApp.ts:54-55`). `beforeinstallprompt` 는 패널이 열리기 전에 온다. 브라우저 검증 J 가 실제 빌드본에서 버튼을 봤다.

**검증이 확인한 것**

- 서버 통합 12a~12h + 종료 시나리오(`apps/server/test/integration/push.test.ts` — 멘션·보고 있으면 거름·승인(두 번 실려도 1건)·릴레이 한도·410 정리·자기 멘션·**페이로드에 본문 없음**·소켓 둘, 가짜 발송기). 테스트 2182(shared 113·plugin 108·adapter 206·server 656·web 1099), 검사 4종·웹 빌드 통과(조율자 측정, main `330f5e8`).
- 브라우저 검증(태스크 7, 빌드본 `vite preview` 5180 + `dev:fake` 3100, headed 오프스크린 Chromium): 계획 시나리오 10 + 넘겨받은 6 = **16/16 통과, 결함 0**. **실제 `web-push` → FCM 왕복**(멘션·승인·릴레이 한도 셋 다), CDP `ServiceWorker.deliverPushMessage` 로 넣은 옳은·잘못된·바깥 url 페이로드, 알림 누르기(SW 안 합성 클릭 — 창이 있을 때 라우터 이동, 없을 때 `openWindow`), 오프라인 새로고침·첫 부팅, 로그아웃·세션 만료 뒤 구독 없음, 새 버전 토스트(초안 보존)를 봤다. 절차는 `docs/guides/live-smoke.md` 14절.
- 검증이 확인한 환경 사실(결함 아님): **헤드리스 Chromium 은 권한을 줘도 `Notification.permission` 이 `denied` 로 고정**이다(`requestPermission()` 결과는 `granted`) — 알림 권한이 필요한 확인은 headed 로 한다. Playwright 번들 Chromium(Google Chrome for Testing)은 실제 FCM 수신까지 된다. 강제 종료된 자동화 브라우저의 소켓이 ping 제한까지 presence 에 남아 한 번 과잉 억제가 났다 — 정상 종료에서는 재현되지 않았다.
