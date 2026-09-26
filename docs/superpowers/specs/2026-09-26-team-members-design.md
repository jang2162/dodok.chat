# Phase 4 ② 팀 — 초대·멤버·역할 설계

**상태**: 설계 확정(2026-09-26). 구현 계획은 이 스펙에서 쓴다.
**범위**:
- 초대: owner·admin 이 1회용 초대 링크를 발급하고, 받은 사람이 핸들·이메일·비밀번호로 가입한다(메일 서버 없음)
- 로그인: 멤버는 이메일·비밀번호, owner 는 지금의 로컬 토큰
- 역할: owner·admin·member — 대화는 누구나, 관리(에이전트·채널 동작 설정·세션 리셋·도구 승인·멤버)는 admin 이상
- 멤버 관리: 역할 바꾸기·비밀번호 재설정 링크·내보내기, 「내 계정」(표시 이름·비밀번호)

**앞선 근거**:
- 계획서 `docs/plan.md` 8장 Phase 4 「팀: 워크스페이스 멤버 초대, OIDC 로그인, 채널 권한, 멀티 Gateway 연결」
- 인증 구조: `apps/server/src/auth/`(Better Auth `emailAndPassword` — 가입 차단·비밀번호 변경 경로 차단, owner 는 `bootstrapOwner` 가 내부 어댑터로 만든다, 로그인은 레이트리밋이 걸린 `/api/v1/auth/local` 로만, `requireOwner` 는 요청마다 membership 을 읽는다)
- 발급 원문을 한 번만 보이는 토큰의 선례: 설정 마법사 스펙 `docs/superpowers/specs/2026-09-24-setup-wizard-design.md` 의 브리지 토큰(`bridge_tokens` — 해시만 저장)
- 레이트리밋 숫자의 한곳: `apps/server/src/modules/ops/limits.ts`

---

## 0. 결정 (브레인스토밍 2026-09-26)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **Phase 4 나머지는 팀부터**(어댑터 → 앱 순). 이번 사이클은 초대·멤버·역할만 | 「사람과 에이전트가 같은 채널」의 사람 쪽이 비어 있다 — 사람을 들일 길이 없다. PWA 가 있어 앱은 급하지 않다. |
| 2 | **대상은 서로 아는 2~10명** | 초대 링크를 메신저로 건네는 규모다. SSO 는 필요 없다. |
| 3 | **초대 링크 + 비밀번호** 가입, 메일 발송 없음 | 서버에 메일 수단이 없다. Better Auth 기본 경로 그대로다. |
| 4 | **대화는 자유, 관리는 admin** — 역할은 owner·admin·member | 도구 실행 승인은 owner 의 Gateway 머신에서 명령이 도는 일이다. 사람이 늘면 선이 필요하다. |
| 5 | **초대·가입은 우리 경로(`modules/members`) + Better Auth 내부 어댑터**, 공개 가입 경로는 계속 닫는다 | 지금 인증 구조(가입 차단·owner 부트스트랩·레이트리밋 로그인)를 잇는다. 역할은 우리 `memberships` 한 테이블이 가진다. organization 플러그인은 자기 테이블·역할·메일 전제를 들여오고, 가입을 열고 훅으로 거르는 방식은 검사가 한 번 빠지면 공개 가입이 된다. |
| 6 | **채널은 지금처럼 워크스페이스 전원이 본다**, 사람의 채널 참여는 저절로(첫 메시지·멘션) | 비공개 채널·채널 권한은 다음 사이클이다. 참여 목록은 에이전트에게 보이는 「참여자」를 실제로 온 사람으로 좁힌다. |
| 7 | **OIDC·멀티 Gateway·owner 넘기기는 범위 밖** | 결정 2의 규모에서는 필요 없다. |

---

## 1. 범위

**한다**
- `invites` 테이블(초대·비밀번호 재설정 링크), 발급·폐기·조회·수락 REST
- 멤버 로그인(이메일·비밀번호) — `/api/v1/auth/local` 확장
- 역할 검사 `requireRole`, 역할 매트릭스(2장)를 REST·wire 에 적용
- 멤버 관리(목록·역할 바꾸기·재설정 링크·내보내기), 「내 계정」(표시 이름·비밀번호)
- 사람의 채널 자동 참여, 사람과 에이전트를 통틀어 유일한 핸들
- 승인 알림을 owner·admin 에게만
- 웹: `/join/<token>`·`/reset/<token>`·로그인 화면·`/settings/members`·「내 계정」·member 가 보는 잠긴 관리 항목
- dev:fake 둘째 계정

**하지 않는다**
- OIDC·패스키, 이메일 발송, 비공개 채널·채널별 권한, 채널 참여·나가기 UI, 멀티 Gateway, owner 넘기기, guest 역할, 멤버 아바타 올리기

---

## 2. 역할과 권한

역할은 `MembershipRole` 의 **owner·admin·member** 셋을 쓴다(guest 는 쓰지 않는다). owner 는 한 명 — 로컬 토큰 계정(`OWNER_EMAIL`)이다. 순서는 owner > admin > member 이고, 「admin 이상」은 owner 를 포함한다.

| 할 일 | member | admin | owner |
| --- | --- | --- | --- |
| 채널 읽기·쓰기·만들기(만들 때 `name`·`topic` 밖의 필드 — 프롬프트·릴레이 정책·공개 범위 — 를 주면 admin 이상), 채널 이름·설명(`name`·`topic`) 바꾸기, 멘션, 카드·모달, 첨부, 검색, 런 중지(`run.abort`) | ✅ | ✅ | ✅ |
| 채널에 에이전트 넣기·빼기(`POST/DELETE /channels/:id/members`) | ✅ | ✅ | ✅ |
| 채널의 에이전트 동작·비용 설정 — 채널 프롬프트, 에이전트별 프롬프트(`PATCH /channels/:id/members/:memberId`), 릴레이 정책, 자동 응답, 일일 한도 | — | ✅ | ✅ |
| 「새 대화」(`POST /channels/:id/agents/:agentId/reset`), 도구 실행 승인·거절(wire `approval.resolve`) | — | ✅ | ✅ |
| 에이전트 등록·수정(`POST/PATCH /agents`), Gateway 에이전트 찾기(`GET /agents/discover`) | — | ✅ | ✅ |
| member 초대, 재설정 링크 발급, member 내보내기 | — | ✅ | ✅ |
| admin 초대, 역할 바꾸기(admin ↔ member), admin 내보내기 | — | — | ✅ |
| 운영 화면(`/api/v1/ops/*` — 사건 확인·한도 설정) | — | ✅ | ✅ |
| 연결 페이지(`/api/v1/setup/*` — 브리지 토큰) | — | — | ✅ |

- **서버가 막는다.** 웹이 숨기는 것은 편의다. REST 는 `requireRole(min)` preHandler(세션 확인 뒤 membership 의 역할을 **요청마다** 읽는다 — 바뀌면 다음 요청부터 따른다). 지금의 `requireOwner` 는 `requireRole("owner")` 가 된다. 모자라면 403 `FORBIDDEN`.
- **`PATCH /channels/:id` 는 본문 필드로 가른다.** `name`·`topic` 만 있으면 member 도 된다. 그 밖의 필드(`prompt`·`relayPolicy`·자동 응답·`dailyRunLimit` 등)가 하나라도 있으면 admin 이상이어야 한다. 가르는 목록은 서버 한곳에 둔다 — 새 필드는 기본이 admin 이다(목록에 없는 필드는 admin).
- **wire** 는 `approval.resolve` 만 역할을 본다(ack 오류 `FORBIDDEN`). `message.send`·`component.interact`·`run.abort` 는 member 에게 열려 있다.
- **membership 이 없는 세션**(내보내진 뒤의 낡은 세션 등)은 모든 경로에서 401 이다 — 지금 `/auth/me` 가 「행이 없으면 member」로 보는 것을 바꾼다.

---

## 3. 초대·가입·로그인

### 3.1 데이터

새 테이블 `invites`:

| 열 | 뜻 |
| --- | --- |
| `id` | uuid v7 |
| `workspace_id` | 워크스페이스 |
| `kind` | `invite` \| `reset` |
| `role` | `member` \| `admin` — `kind='invite'` 일 때만 |
| `target_user_id` | `kind='reset'` 일 때 그 사용자 |
| `token_hash` | 원문 sha256 hex, 유일 |
| `prefix` | 원문 앞 8자(목록 표시용) |
| `created_by` | 발급한 사용자 |
| `created_at`·`expires_at` | 초대 7일, 재설정 24시간 |
| `used_at`·`used_by` | 쓰인 때·쓴 사용자 |
| `revoked_at` | 폐기 |

- 원문은 `dit_<32바이트 base64url>`(초대)·`drt_<…>`(재설정). **발급 응답 한 번만** 원문을 싣는다. 목록·로그·사건 어디에도 다시 나오지 않는다.
- 유효 = `used_at IS NULL AND revoked_at IS NULL AND expires_at > now`. 무효의 까닭(쓰임·만료·폐기·없음)은 밖으로 가르지 않는다 — 모두 404 `NOT_FOUND`.
- 한 사용자의 재설정 링크는 새로 발급하면 앞의 것을 폐기한다.

### 3.2 발급·폐기·목록

- `POST /api/v1/invites { role }` → `{ invite, token, url }`(`url` 은 `APP_ORIGIN` + `/join/<token>`). admin 은 `role: "member"` 만, `admin` 은 owner 만.
- `GET /api/v1/invites` → 대기 중(유효한) 초대만, 원문 없이.
- `DELETE /api/v1/invites/:id` → 폐기. admin 은 member 초대만 폐기한다.
- `POST /api/v1/members/:userId/reset-link` → `{ token, url }`(`/reset/<token>`). admin 은 member 에게만, owner 는 owner 자신을 제외한 모두에게. owner 계정은 로컬 토큰이 비밀번호라 재설정 링크가 없다.

### 3.3 조회·수락

- `POST /api/v1/invites/lookup { token }` → 유효하면 `{ workspaceName, role, kind }`, 아니면 404. 토큰은 본문으로 보낸다(서버 접근 로그의 URL 에 남지 않게). 로그인 불필요.
- `POST /api/v1/invites/accept { token, handle, displayName, email, password }`:
  1. 입력 검증 — `handle` 은 `Handle`(`[a-z0-9_-]{2,32}`), `email` 은 이메일 모양, `password` 12~256자, `displayName` 1~64자.
  2. 핸들·이메일 중복 검사 — **핸들은 사람(`users`)과 에이전트(`agents`)를 통틀어 유일**(멘션이 같은 이름공간이다). 이메일은 워크스페이스 안에서 유일. 겹치면 409 `CONFLICT` + `field`.
  3. 초대를 **원자적으로 잡는다** — `UPDATE invites SET used_at = now WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now`. 바뀐 행이 0이면 404.
  4. Better Auth 내부 어댑터로 user·credential 을 만든다(`bootstrapOwner` 와 같은 길). 이어 `users`(`auth_provider = "local"`)·`memberships`(초대의 역할)를 한 트랜잭션으로 쓰고 `used_by` 를 채운다.
  5. 세션을 발급하고 쿠키를 싣는다(로그인과 같은 모양 `{ sessionToken, user }`).
  - 4 가 실패하면 만든 Better Auth 사용자를 지우고 초대의 `used_at` 을 되돌린다. 되돌리기도 실패하면 운영 사건(`kind: "invite_accept_failed"`)을 남기고 500.
  - 동시에 두 번 제출하면 3 이 하나만 통과시킨다. 2 와 3 사이에 다른 가입이 같은 핸들을 잡으면 4 의 유일 인덱스가 막는다 → 409 로 바꾸고 되돌린다.
- **재설정 수락** `POST /api/v1/invites/reset { token, password }`: 3 과 같이 잡고, 대상 사용자의 credential 비밀번호를 바꾸고, **그 사용자의 세션을 모두 끊는다**. 새 세션을 발급해 로그인시킨다.

### 3.4 로그인

`POST /api/v1/auth/local` 이 두 모양을 받는다:
- `{ token }` — 지금처럼 owner(`OWNER_EMAIL` + 로컬 토큰).
- `{ email, password }` — 멤버. Better Auth `signInEmail` 로 확인한다. `OWNER_EMAIL` 로의 이메일 로그인은 막는다(owner 는 토큰으로만).
- 실패 문구는 둘 다 401 「이메일 또는 비밀번호가 맞지 않는다」 하나다(토큰 모양은 「토큰이 맞지 않는다」 그대로). 성공한 사용자에게 membership 이 없으면 401.
- 레이트리밋은 지금의 `localLoginPerMin`(IP 당) 버킷을 같이 쓴다.

### 3.5 「내 계정」

- `PATCH /api/v1/me { displayName }` — 본인 표시 이름.
- `POST /api/v1/me/password { current, next }` — 현재 비밀번호를 확인하고 바꾼다. 바꾸면 **이 세션을 뺀** 본인 세션을 끊는다. owner 는 403(로컬 토큰이 비밀번호다 — `.env` 로 바꾼다).
- Better Auth 의 `/change-password`·`/update-user` 등은 계속 닫아 둔다.

---

## 4. 멤버 관리

- `GET /api/v1/members`(admin 이상) → `{ userId, handle, displayName, email, role, createdAt }[]`.
- `PATCH /api/v1/members/:userId { role }`(owner) — admin ↔ member. owner 자신은 못 바꾼다.
- `DELETE /api/v1/members/:userId` — admin 은 member 만, owner 는 owner 를 뺀 모두:
  - `memberships` 행을 지우고, 그 사용자의 Better Auth 세션·푸시 구독을 모두 지우고, 열린 wire 소켓을 서버가 끊는다(`disconnect(true)`).
  - 그 사람의 **Better Auth 사용자(user·account·session)는 지운다** — 같은 이메일로 다시 초대받을 수 있어야 한다(Better Auth 의 이메일은 유일하다).
  - 우리 `users` 행과 그 사람이 쓴 메시지는 남긴다(작성자 참조). 그 행은 핸들과 이메일을 놓아준다: 내보낸 때의 핸들을 새 열 `users.left_handle` 에 옮기고, `handle` 은 `left-<id 뒤 27자>`(규칙 `Handle` 안 — uuid v7 의 앞쪽은 시각이라 가까운 때 가입한 사람끼리 겹친다), `email` 은 NULL 로 바꾼다. 그래서 옛 핸들·이메일을 새 가입이 다시 쓸 수 있다. `left-` 로 시작하는 핸들은 이 용도로 **예약**한다 — 사람 가입·에이전트 등록은 400 `VALIDATION`.
  - 웹은 `left_handle` 이 있는 작성자를 「나간 멤버 @<left_handle>」로 그린다. 같은 사람을 다시 들이면 **새 사용자**다 — 옛 메시지는 옛 행에 남는다.
  - 채널 참여 행(`channel_members` 의 user)도 지운다 — 에이전트 헤더 「참여자」에서 빠진다.
  - 그 사람을 겨눈 재설정 링크와 **그 사람이 발급한** 쓰이지 않은 초대·재설정 링크를 모두 폐기한다 — 원문을 쥔 채 나간 사람이 다시 들어오거나 남의 비밀번호를 바꾸지 못하게. admin 에서 member 로 내릴 때도 그 사람이 발급한 링크를 폐기한다.
  - 내보내기가 중간에 실패하면 열린 소켓은 끊고 운영 사건 `member_remove_failed` 를 남긴 뒤 500.
- 내보내진 사람의 다음 REST 는 401, wire 재접속은 핸드셰이크에서 거절된다.

---

## 5. 채널 참여·멘션·알림

- **자동 참여**: 사람이 그 채널에 처음 메시지를 쓰거나(스레드 답글 포함), 그 채널에서 사람 @멘션을 받으면 `channel_members`(user)에 들어간다. 이미 있으면 아무것도 안 한다. 참여 변경은 기존 `channel.member.changed` 로 알린다.
- 참여 목록은 **에이전트 헤더 「참여자:」와 에이전트의 사람 멘션 해석**에 쓰인다. 채널을 읽는 권한과는 무관하다(모두 읽는다).
- **작성기 @ 자동완성**: 워크스페이스의 사람 전원(나간 멤버 제외)과 그 채널의 에이전트.
- **사람 멘션**은 런을 만들지 않고 알림만(지금 규칙). 멘션 푸시는 받는 사람의 구독으로 간다.
- **승인 알림**(푸시 `approval_requested`·탭 안 알림)은 owner·admin 에게만 간다. 승인 결과(허용·거절·만료)는 모두에게 보인다.

---

## 6. 웹

- **`/join/<token>`**(로그인 불필요): lookup 결과로 워크스페이스 이름·역할을 보이고, 핸들·표시 이름·이메일·비밀번호(두 번)를 받는다. 409 는 그 칸 아래에. 성공하면 곧바로 로그인되어 첫 채널로. 무효면 「초대가 만료됐거나 이미 쓰였습니다 — 초대한 사람에게 새 링크를 받으세요」.
- **`/reset/<token>`**: 같은 꼴에 비밀번호 칸만.
- **로그인 화면**: 이메일·비밀번호가 기본, 아래 접힌 「owner 로컬 토큰으로 로그인」이 지금 경로.
- **`/settings/members`**(admin 이상, 사이드바 설정 메뉴 「멤버」): 멤버 표(핸들·이름·이메일·역할·가입일), 줄마다 역할 바꾸기(owner 만)·「재설정 링크」·「내보내기」(확인 대화상자), 「초대」 버튼(역할 선택 — admin 은 member 고정 → 링크를 한 번만, 복사 버튼, 「이 링크는 다시 볼 수 없습니다」), 대기 중인 초대(역할·만료·「폐기」). 발급 대화상자의 원문은 390px 에서 잘리지 않게(설정 마법사의 브리지 토큰 대화상자와 같은 처리).
- **「내 계정」**(사용자 메뉴): 표시 이름, 비밀번호 바꾸기(owner 에게는 「로컬 토큰은 .env 로 바꿉니다」 안내만).
- **member 가 보는 화면**: 채널 설정의 관리 항목은 값을 보이되 잠그고 「관리자만 바꿀 수 있습니다」. 에이전트 등록·「새 대화」 버튼은 숨긴다. 승인 카드는 버튼 대신 「관리자가 결정합니다」. 운영·연결·멤버 메뉴는 없다.
- **나간 멤버**: 작성자 자리에 「나간 멤버 @<left_handle>」(흐린 글씨).
- `/auth/me` 의 `role` 로 가른다. 역할이 바뀌면 다음 `/auth/me`(재연결·새로고침) 때 따른다 — 그 사이 누른 관리 동작은 서버가 403 으로 막고 웹은 「권한이 없습니다」 한 줄.

---

## 7. 보안

- 토큰 32바이트 난수, 해시(sha256)로만 저장, 대조는 해시 유일 인덱스로 찾은 뒤 상수 시간 비교. 원문은 발급 응답 한 번뿐.
- 토큰은 웹 경로(`/join/<token>`)에 있지만 API 에는 본문으로 보낸다 — Caddy·서버 로그의 API 줄에 원문이 없다. 정적 경로 줄에는 남을 수 있다 → 1회용·만료로 막는다. 웹은 수락·재설정이 끝나면 `history.replaceState` 로 주소창에서 토큰을 걷는다.
- 레이트리밋(`modules/ops/limits.ts`): `lookup`·`accept`·`reset` 은 로그인과 같은 IP 버킷, 초대·재설정 링크 발급은 사용자당 분당 상한.
- 비밀번호 해시는 Better Auth 기본(scrypt).
- 로그에 비밀번호·토큰·이메일 원문을 남기지 않는다(사용자 id 만).

---

## 8. 오류 처리

| 상황 | 동작 |
| --- | --- |
| 무효 초대(쓰임·만료·폐기·없음) | 404, 까닭을 가르지 않음 |
| 핸들·이메일 중복 | 409 `CONFLICT` + `field`, 초대 미소비 |
| 두 번 제출 | 하나만 성공, 다른 쪽 404 |
| Better Auth 사용자는 만들고 우리 행 실패 | 사용자 삭제·초대 되돌림, 실패하면 운영 사건 + 500 |
| 역할 모자람 | 403 `FORBIDDEN`(wire 는 ack 오류) |
| membership 없는 세션 | 401 |
| owner 내보내기·owner 역할 바꾸기·owner 재설정 링크 | 403 |
| 로그인 실패 | 401 한 문구 |

---

## 9. 테스트·검증

- **서버 단위·통합**: 초대 발급(역할 제한)·조회·수락·만료·폐기·재사용, 두 번 제출, 핸들 충돌(사람·에이전트 양쪽 — 에이전트 등록도), 이메일 충돌, 수락 중 실패 되돌림, 로그인 두 모양·실패 문구 하나·`OWNER_EMAIL` 이메일 로그인 거절, 재설정 뒤 대상 세션 끊김, `me/password` 뒤 다른 세션 끊김, 내보내기 뒤 REST 401·wire 끊김·재접속 거절·푸시 구독 삭제·채널 참여 삭제·`left_handle`, **역할 매트릭스의 허용·거부 전부**(REST 경로별, `PATCH /channels/:id` 필드별, wire `approval.resolve`), 승인 푸시 수신자, 자동 참여(첫 메시지·스레드 답글·멘션), 에이전트 헤더 참여자.
- **웹 단위**: 가입·재설정·로그인 화면, 멤버 화면(초대 대화상자·폐기·역할·내보내기), 「내 계정」, member 가 보는 잠긴 설정·숨긴 버튼·승인 카드, 나간 멤버 표시.
- **dev:fake**: 둘째 계정(member)을 만드는 길 — 고정 초대 또는 개발 훅. 브라우저 검증은 owner·member 두 브라우저 컨텍스트를 나란히: 초대 → 가입 → 같은 채널 대화(자동 참여·멘션 푸시) → member 의 관리 거부 → 역할 올리기 → 재설정 → 내보내기 → 끊김. 390·1280px.
- **실연**(모델 런 0회): 사람이 둘인 채널에서 에이전트 헤더 「참여자:」가 실제로 온 사람만 싣는지 런 0회 하네스로.

---

## 10. 완료 기준

1. owner 가 초대 링크를 만들고, 다른 브라우저에서 그 링크로 가입해 같은 채널에서 대화한다.
2. 역할 매트릭스(2장)가 서버에서 전부 강제된다(테스트).
3. 내보낸 사람은 곧바로 아무것도 못 한다(REST·wire·푸시).
4. 비밀번호 재설정이 메일 없이 된다.
5. owner 로컬 토큰 로그인과 기존 웹이 그대로 된다.

---

## 11. 열린 문제 (범위 밖 기록)

- 비공개 채널·채널별 권한, 채널 참여·나가기 UI
- OIDC(Google·Okta 등), 패스키
- owner 넘기기·owner 둘
- 멀티 Gateway(워크스페이스 하나에 Gateway 여럿)
- 이메일 발송(초대·재설정을 메일로)
- 멤버 아바타 올리기, 멤버 표시 상태(접속 중)
