# Phase 4 ② 팀 — 초대·멤버·역할 설계

**상태**: 설계 확정(2026-09-26), 구현·브라우저 검증 완료(2026-09-27 — 계획 태스크 1~7 과 곁가지 p4m-c1·c2, 브라우저 11항목 중 9 통과·결함 둘(D1·D2) 수정, 테스트 3538) — 구현이 이 설계와 달라진 것은 「구현과 맞춘 것」 장(판정 R1~R4 등). 계획 `docs/superpowers/plans/2026-09-26-team-members.md`, 실연(계획 태스크 8)은 `docs/guides/live-smoke.md` 「팀(Phase 4 ②) 실연」 절
**범위**:
- 초대: owner·admin 이 1회용 초대 링크를 발급하고, 받은 사람이 핸들·이메일·비밀번호로 가입한다(메일 서버 없음)
- 로그인: 멤버는 이메일·비밀번호, owner 는 지금의 로컬 토큰
- 역할: owner·admin·member — 대화는 누구나, 관리(에이전트·채널 동작 설정·도구 승인·멤버)는 admin 이상
- 멤버 관리: 역할 바꾸기·비밀번호 재설정 링크·내보내기, 「내 계정」(표시 이름·비밀번호)

**앞선 근거**:
- 계획서 `docs/plan.md` 8장 Phase 4 「팀: 워크스페이스 멤버 초대, OIDC 로그인, 채널 권한, 멀티 Gateway 연결」
- 인증 구조: `apps/server/src/auth/`(Better Auth `emailAndPassword` — HTTP 는 허용 목록(`/ok`)만 통과하고 가입·비밀번호 변경·세션 폐기·로그아웃은 `disabledPaths` 로도 닫는다(세션은 소켓을 함께 끊는 우리 경로만 지운다), owner 는 `bootstrapOwner` 가 내부 어댑터로 만든다, 로그인은 레이트리밋이 걸린 `/api/v1/auth/local` 로만, `requireOwner` 는 요청마다 membership 을 읽는다)
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

**채널 접근(`apps/server/src/auth/channel-access.ts`)이 이 표의 역할 판정보다 먼저다 — 남의 DM 은 어느 행이든 404 다**(에이전트 DM 스펙 `docs/superpowers/specs/2026-10-25-agent-dm-design.md` 4장). DM 에서는 아래 DM 줄이 채널 줄보다 앞선다.

| 할 일 | member | admin | owner |
| --- | --- | --- | --- |
| 채널 읽기·쓰기·만들기(만들 때 `name`·`topic` 밖의 필드 — 프롬프트·릴레이 정책·공개 범위 — 를 주면 admin 이상), 채널 이름·설명(`name`·`topic`) 바꾸기, 멘션, 카드·모달, 첨부, 검색, 런 중지(`run.abort`) | ✅ | ✅ | ✅ |
| 읽지 않음 현황(`GET /api/v1/me/unread`) — 자기 것만 | ✅ | ✅ | ✅ |
| 읽음 위치 올리기(wire `channel.read`) — 자기 것만, 보관한 채널도 | ✅ | ✅ | ✅ |
| 반응 켜기·끄기(wire `reaction.set`) — 자기 것만, 보관한 채널은 409 `CHANNEL_ARCHIVED` | ✅ | ✅ | ✅ |
| 세션 목록·세션·세션 메시지 읽기(`GET /channels/:id/conversations`·`/conversations/:id`·`/conversations/:id/messages`·`/conversations/:id/threads/:rootId/messages`), 새 세션(wire `message.send` 의 `newConversation`) — 채널 세션 정책이 「세션 관리자만」(`managers`)이면 그 채널의 세션 관리자와 admin 이상만(채널 세션 스펙 「권한」 장) | ✅ | ✅ | ✅ |
| 자기가 만든 세션의 제목 바꾸기·닫기·다시 열기(`PATCH /conversations/:id`) — 남이 만든 세션은 그 채널의 세션 관리자와 admin 이상. 닫힌 세션에 보내기·카드·리액션·첨부 묶기는 409 `CONVERSATION_CLOSED` | ✅ | ✅ | ✅ |
| 채널에 에이전트 넣기·빼기(`POST/DELETE /channels/:id/members`) | ✅ | ✅ | ✅ |
| 채널에 사람 넣기·빼기(같은 경로, `memberType: "user"`) — 나간 사람(membership 없음)은 404 | ✅ | ✅ | ✅ |
| 채널의 에이전트 동작·비용 설정 — 채널 프롬프트, 에이전트별 프롬프트(`PATCH /channels/:id/members/:memberId`), 릴레이 정책, 자동 응답, 일일 한도 | — | ✅ | ✅ |
| 도구 실행 승인·거절(wire `approval.resolve`) — 옛 「새 대화」 리셋(`POST /channels/:id/agents/:agentId/reset`)은 채널 세션이 걷었다(새 세션이 그 자리) | — | ✅ | ✅ |
| 세션 관리자 지정·해제(`PUT/DELETE /channels/:id/session-managers/:userId` — 지정하면 채널에 참여시킨다), 세션 정책(`PATCH /channels/:id` 의 `sessionPolicy`) | — | ✅ | ✅ |
| 확인 카드(`ApprovalKind "dodok_control"` — 채널 안 에이전트가 제어 도구로 설정을 바꾸려 할 때) 허용·거절(wire `approval.resolve`) — **그 런을 시킨 사람 본인만**(`approvals.requested_by`), 역할과 무관. 남이 결정하면 `FORBIDDEN`. 허용 때 그 사람의 지금 역할로 그 일을 다시 판정한다 | 본인 | 본인 | 본인 |
| 개인 토큰(MCP 토큰) 발급·목록·폐기(`GET/POST /api/v1/me/tokens`, `DELETE /api/v1/me/tokens/:id`) — 자기 것만(남의 것 404), 사람마다 10개. 그 토큰으로 `/mcp` 에서 부르는 제어 도구는 이 표의 같은 REST 경로 판정을 토큰 주인의 지금 역할로 받는다 | ✅ | ✅ | ✅ |
| 에이전트 등록·수정(`POST/PATCH /agents`), Gateway 에이전트 찾기(`GET /agents/discover`) | — | ✅ | ✅ |
| member 초대, 재설정 링크 발급, member 내보내기 | — | ✅ | ✅ |
| admin 초대, 역할 바꾸기(admin ↔ member), admin 내보내기 | — | — | ✅ |
| 운영 화면(`/api/v1/ops/*` — 사건 확인·한도 설정) | — | ✅ | ✅ |
| 자동화 목록·만들기·수정·삭제·웹훅 토큰 재발급·지금 실행(`/api/v1/automations/*`) — 웹훅 수신(`POST /hooks/<token>`)은 세션 없이 토큰만 본다 | — | ✅ | ✅ |
| 연결 페이지(`/api/v1/setup/*` — 브리지 토큰) | — | — | ✅ |
| DM 열기(`POST /api/v1/dms { agentId }` — 찾거나 만든다)·내 DM 목록(`GET /api/v1/dms`) — 자기 것만. 새로 여는 것은 그 에이전트의 `dmAccess` 가 지금 역할을 들일 때(`off` 아무도·`admins` admin 이상·`everyone` 모두)와 에이전트가 보관·꺼짐이 아닐 때만, 아니면 403 | `everyone` 만 | `admins`·`everyone` | `admins`·`everyone` |
| 「이 DM 의 지시」(DM 의 `PATCH /channels/:id { prompt }` — 다른 키는 400 `VALIDATION`), DM 의 도구 승인·exec 승인·확인 카드 결정(wire `approval.resolve`) — **DM 주인 본인만**, 역할과 무관. 채널 관리(이름·주제·멤버·보관·세션 관리자·세션 정책·한도·제어 쓰기 도구)는 DM 에 400 `VALIDATION`. 읽기 전용 DM(에이전트 보관·꺼짐·`dmAccess` 가 주인의 지금 역할을 들이지 않음)의 쓰기는 409 `DM_READ_ONLY` | 주인 | 주인 | 주인 |
| 에이전트의 DM 허용 범위 바꾸기(`PATCH /agents/:id { dmAccess }`) — 제어 도구 `update_agent` 로는 바꾸지 않는다 | — | ✅ | ✅ |

- **제어 도구는 이 표를 따로 갖지 않는다.** 바깥 MCP 클라이언트(개인 토큰의 주인)와 채널 안 에이전트(그 런을 시킨 사람)의 도구 호출은 같은 REST 경로의 정책 함수(`apps/server/src/auth/policies.ts`)로 판정한다 — 시킨 사람이 없는 런(자동화 글이 시작한 런)은 읽기만.
- **서버가 막는다.** 웹이 숨기는 것은 편의다. REST 는 `requireRole(min)` preHandler(세션 확인 뒤 membership 의 역할을 **요청마다** 읽는다 — 바뀌면 다음 요청부터 따른다). 지금의 `requireOwner` 는 `requireRole("owner")` 가 된다. 모자라면 403 `FORBIDDEN`.
- **`PATCH /channels/:id` 는 본문 필드로 가른다.** `name`·`topic` 만 있으면 member 도 된다. 그 밖의 필드(`prompt`·`relayPolicy`·자동 응답·`dailyRunLimit` 등)가 하나라도 있으면 admin 이상이어야 한다. 가르는 목록은 서버 한곳에 둔다 — 새 필드는 기본이 admin 이다(목록에 없는 필드는 admin).
- **wire** 는 `approval.resolve` 만 역할을 본다(ack 오류 `FORBIDDEN`). 확인 카드(`dodok_control`)만은 admin 을 요구하지 않고 멤버인지만 보며, 시킨 사람 본인인지는 승인 서비스가 본다(제어 MCP 스펙 `docs/superpowers/specs/2026-10-06-control-mcp-design.md` 「확인 카드」 장·「구현과 맞춘 것」 장 PC4). `message.send`·`component.interact`·`run.abort` 는 member 에게 열려 있다.
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
- 재설정 링크는 수락·조회 때 발급자의 지금 역할이 대상의 지금 역할에 링크를 낼 수 있어야 쓰인다 — 대상이 admin 으로 오르면 admin 이 낸 링크는 무효다(404, 까닭을 가르지 않고 링크를 소비하지 않는다). 발급과 조회·수락이 같은 규칙 함수(`members/invites.ts` 의 `canIssueResetLink`)를 쓴다.

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
- **재설정 수락** `POST /api/v1/invites/reset { token, password }`: 3 과 같이 잡고, 대상 사용자의 credential 비밀번호를 바꾸고, **그 사용자의 세션을 모두 끊는다** — 세션 행을 지우고 열린 wire 소켓도 서버가 끊는다(`disconnectUser`). 새 세션을 발급해 로그인시킨다.

### 3.4 로그인

`POST /api/v1/auth/local` 이 두 모양을 받는다:
- `{ token }` — 지금처럼 owner(`OWNER_EMAIL` + 로컬 토큰).
- `{ email, password }` — 멤버. Better Auth `signInEmail` 로 확인한다. `OWNER_EMAIL` 로의 이메일 로그인은 막는다(owner 는 토큰으로만).
- 실패 문구는 둘 다 401 「이메일 또는 비밀번호가 맞지 않는다」 하나다(토큰 모양은 「토큰이 맞지 않는다」 그대로). 성공한 사용자에게 membership 이 없으면 401.
- 레이트리밋은 지금의 `localLoginPerMin`(IP 당) 버킷을 `me/password` 와 같이 쓴다(초대 경로는 따로 — 7장).
- `POST /api/v1/auth/logout` 은 이 세션 행을 지우고 그 세션의 열린 wire 소켓을 모두 끊는다(같은 쿠키를 쓰는 다른 탭 포함).

### 3.5 「내 계정」

- `PATCH /api/v1/me { displayName }` — 본인 표시 이름.
- `POST /api/v1/me/password { current, next }` — 현재 비밀번호를 확인하고 바꾼다. 바꾸면 **이 세션을 뺀** 본인 세션을 끊는다 — 지운 세션의 열린 wire 소켓만 끊고(`session:<id>` 룸), 이 세션의 소켓은 남긴다. owner 는 403(로컬 토큰이 비밀번호다 — `.env` 로 바꾼다).
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
- **member 가 보는 화면**: 채널 설정의 관리 항목은 값을 보이되 잠그고 「관리자만 바꿀 수 있습니다」. 에이전트 등록 버튼은 숨긴다(「새 대화」 버튼은 채널 세션이 걷었다). 승인 카드는 버튼 대신 「관리자가 결정합니다」. 운영·연결·멤버 메뉴는 없다.
- **나간 멤버**: 작성자 자리에 「나간 멤버 @<left_handle>」(흐린 글씨).
- `/auth/me` 의 `role` 로 가른다. 역할이 바뀌면 다음 `/auth/me`(재연결·새로고침) 때 따른다 — 그 사이 누른 관리 동작은 서버가 403 으로 막고 웹은 「권한이 없습니다」 한 줄.

---

## 7. 보안

- 토큰 32바이트 난수, 해시(sha256)로만 저장, 대조는 해시 유일 인덱스로 찾은 뒤 상수 시간 비교. 원문은 발급 응답 한 번뿐.
- 토큰은 웹 경로(`/join/<token>`)에 있지만 API 에는 본문으로 보낸다 — Caddy·서버 로그의 API 줄에 원문이 없다. 정적 경로 줄에는 남을 수 있다 → 1회용·만료로 막는다. 웹은 수락·재설정이 끝나면 `history.replaceState` 로 주소창에서 토큰을 걷는다.
- 레이트리밋(`modules/ops/limits.ts`): `lookup`·`accept`·`reset` 은 셋이 한 IP 버킷(`invitePublicPerMin`)을 쓰고 로그인 버킷과 나눈다 — 한 사무실(NAT)에서 여러 사람이 링크를 동시에 열어도 로그인 실패 몇 번에 가입이 막히지 않게. 토큰은 32바이트 난수라 이 버킷은 추측이 아니라 폭주를 막는다. 로그인(`/auth/local`)과 `me/password` 는 비밀번호 추측을 막는 `localLoginPerMin` 버킷을 같이 쓴다. 초대·재설정 링크 발급은 사용자당 분당 상한.
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

- **서버 단위·통합**: 초대 발급(역할 제한)·조회·수락·만료·폐기·재사용, 두 번 제출, 핸들 충돌(사람·에이전트 양쪽 — 에이전트 등록도), 이메일 충돌, 수락 중 실패 되돌림, 로그인 두 모양·실패 문구 하나·`OWNER_EMAIL` 이메일 로그인 거절, 재설정 뒤 대상 세션·wire 소켓 끊김, `me/password` 뒤 다른 세션·그 소켓 끊김(이 세션 소켓 유지), 로그아웃 뒤 그 세션 소켓 끊김, 핸드셰이크 틈, 내보내기 뒤 REST 401·wire 끊김·재접속 거절·푸시 구독 삭제·채널 참여 삭제·`left_handle`, **역할 매트릭스의 허용·거부 전부**(REST 경로별, `PATCH /channels/:id` 필드별, wire `approval.resolve`), 승인 푸시 수신자, 자동 참여(첫 메시지·스레드 답글·멘션), 에이전트 헤더 참여자.
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

---

## 12. 구현과 맞춘 것 (2026-09-27)

구현(계획 태스크 1~7)·리뷰·브라우저 검증과 곁가지(p4m-c1·c2)에서 이 설계와 달라지거나 설계가 정하지 않은 것을 정한 자리만 모았다. main `c997623` 기준이다.
정본 근거는 실행 원장 `.superpowers/sdd/2026-09-26-team-members/ledger.md`(git 제외)의 판정 R1~R4 와, 원장이 가리키는 보고서·리뷰(`p4m-t*`·`p4m-c*`)다. 보고서의 커밋 해시는 워크트리 것이라 main 에서는 다르다 — 아래 해시는 main 의 것이다.
실연은 `docs/guides/live-smoke.md` 「팀(Phase 4 ②) 실연」 절, 남은 문제는 `docs/plan.md` 8장 「이월」 한곳에 있다. 각 파일이 왜 그렇게 생겼는지는 그 파일의 머리 주석이 정본이다.
본문에 이미 옮겨 적은 판정(2장의 `POST /channels` 필드·`discover`, 3.3~3.5 의 소켓 끊기, 4장의 나간 핸들·링크 폐기, 7장의 초대 경로 버킷)은 여기서 까닭과 경계만 보탠다.

**계약·역할 매트릭스(태스크 1·2 — `59390ee`·`04b1561`·`5b63e7c`·`0784034`·`dc33518`)**

- **역할 검사의 자리는 `apps/server/src/auth/roles.ts` 하나다** — `requireSession`(세션 + membership, 없으면 401)·`requireRole(ctx, min)`·`assertRole`(핸들러 안에서 membership 을 다시 읽는다)·`roleOf`(모르는 역할 `guest` 는 undefined → 401)·`hasFieldOutside` 와 가르는 목록 둘. `requireSession` 이 여기 있는 까닭: 세션 확인이 membership 을 읽고 `requireRole` 이 그 위에 서므로 `auth/routes.ts` 와 나누면 서로를 import 한다. `requireOwner` 는 `requireRole(ctx, "owner")` 의 얇은 이름으로 남았다. `request.user` 는 `{ id, workspaceId, role, sessionId }` 다.
- **필드 검사는 원문 본문의 키로 한다** — 파싱된 값은 기본값이 채워져(`autoRespond` 기본 false) 「보냈는가」를 못 가른다. 파싱이 버린 모르는 키도 admin 몫으로 센다(2장 「목록에 없는 필드는 admin」). 검사는 쓰기 **전**이라 부분 적용이 없다(member 의 `{ name, prompt }` 는 이름도 안 바뀐다).
- **채널에 사람을 넣는 것은 membership 이 있는 사람만이다** — `channels/service.ts` 의 `addMember` 가 `roleOf` 를 본다. 나간 사람은 users 행이 남아도 404(넣으면 에이전트 헤더 「참여자:」에 다시 실리고 `@left-…` 멘션이 풀린다). 사람 넣기·빼기의 역할은 에이전트 넣기·빼기와 같이 누구나(2장 표).
- **채널 멤버 경로는 `aliases` 만 member 에게 열린다** — `MEMBER_EDITABLE_AGENT_MEMBER_FIELDS`(memberType·memberId·aliases). `POST /channels/:id/members` 의 에이전트 `{}`·`{aliases}` 와 `PATCH …/members/:memberId` 의 `{aliases}` 는 member 도, `promptOverride`·`autoRespond` 가 하나라도 있으면 admin 이상. 사람 멤버에 그 필드를 주면 전처럼 서비스가 400. 웹에는 별칭 편집 UI 가 없다(이월).
- **승인 푸시는 채널 참여와 무관하게 워크스페이스의 owner·admin 전원이다**(5장 구체화) — `TriggerLookups.admins()`. 채널에 들어온 member 는 받지 않는다.
- **승인의 결정자(`approvals.decided_by`)는 이긴 결정을 누른 사람이다** — Gateway 해결 이벤트가 RPC 응답보다 먼저 와도 `approval.resolve` 를 부른 사람을 남긴다(`claimDecidedBy` — `decided_by IS NULL` 일 때만, 먼저 채운 사람을 덮지 않는다). 그 사람의 결정이 저장된 결과와 다르면(두 사람이 거의 동시에 다른 결정) 채우지 않는다. 누가 허용·거절했는지가 감사 기록이다.
- **wire `ops.event` 는 owner·admin 사용자 룸, `setup.status` 는 owner 만** — `realtime/events.ts` 의 `roleRooms` 가 **보낼 때마다** membership 을 읽어 방을 고르므로 역할이 바뀌면 재접속 없이 다음 사건부터 따른다. 운영 REST(`/api/v1/ops/*`)도 admin 이상이다(2장 표).
- **DB(0008)** — `invites` 테이블, `users.left_handle`, 유일 인덱스 `users_ws_email (workspace_id, email)`(NULL 여럿 허용 — 나간 사람의 이메일은 NULL). `invites.used_by` 에는 FK 가 없다. 이미 배포된 DB 에 같은 워크스페이스·같은 이메일 행이 둘 있으면 0008 이 실패한다 — 지금까지는 owner 한 명뿐이라 생길 수 없다.

**초대·가입·로그인·「내 계정」(태스크 3 — `4bf1ebd`·`4cac06a`)**

- **이메일은 넣거나 찾기 전에 소문자로 정규화한다** — `members/accept.ts` 의 `normalizeEmail`. 가입·로그인·중복 검사가 모두 이것을 지난다(`Bee@X.com` 가입 → `bee@x.com` 저장, `BEE@x.com` 둘째 가입은 409 `email`, `OWNER@…` 이메일 로그인도 같은 401).
- **수락·재설정 응답은 200 `{ sessionToken, user }`**(로그인과 같은 모양, 3.3 5단계 구체화) — 세션 발급까지 서비스(`acceptInvite`·`resetPassword`)가 끝내고 쿠키는 라우트가 싣는다. 웹은 `sessionToken` 을 쓰지 않는다(쿠키만). 그 밖의 응답 모양: `GET /invites` → `{ invites }`(대기 중 `kind: "invite"` 만 — 재설정 링크는 싣지 않는다), `POST /members/:userId/reset-link` → 201 `{ invite, token, url }`(3.2 의 `{ token, url }` 위에 `invite`), `PATCH /me` → `{ user }`, `DELETE /invites/:id`·`POST /me/password` → 204. 발급 응답은 `Cache-Control: no-store`.
- **틀린 현재 비밀번호는 400 `VALIDATION` + `details.field: "current"`** — 401 이면 웹이 세션 끝남으로 읽어 로그인 화면으로 보낸다.
- **재설정 링크의 재검사** — 조회·수락 때 발급 규칙(`canIssueResetLink` — 3.2)을 발급자·대상의 지금 역할로 다시 지난다(`resetLinkUsable`). 대상이 나갔거나 owner 이거나, admin 이 낸 링크의 대상이 admin 으로 올랐거나, 발급자가 나갔으면 404(링크 미소비). 발급자 쪽 강등은 R2 의 폐기가 먼저 덮는다. 대상에게 credential 계정이 없으면 `linkAccount` 로 만든다.
- **가입 검사 순서** — 초대 확인(값싼 404) → Better Auth 쪽 이메일 존재·비밀번호 해시(await) → **await 없이** 핸들·이메일 검사와 `claimInvite`. 그 앞 await 사이의 경합은 유일 인덱스가 막고, 실패 뒤 다시 검사해 409 `field` 로 바꾼다.
- **운영 사건 `invite_accept_failed`**(key `invite:accept`) — 수락이 실패하고 되돌리기(Better Auth 사용자 삭제·`used_at` 되돌림)도 실패했을 때. 로그에는 오류의 이름·코드만 남긴다(Better Auth 어댑터 오류 문구가 무엇을 싣는지 보증하지 못한다).
- **Better Auth 설정의 `minPasswordLength` 는 16 그대로다** — 우리 경로가 `ctx.password.hash` 를 직접 부르고 `signInEmail` 은 길이를 보지 않아, 12~15자 비밀번호도 가입·로그인된다(규칙의 정본은 shared `Password` 12~256자). Better Auth 의 공개 경로가 닫혀 있는 한(허용 목록 — 「세션을 지우는 모든 자리」 절) 이 값은 쓰이지 않는다.

**멤버 관리·사람 목록·자동 참여(태스크 4 — `85c1c6d`·`eef0334`·`9d3931b`·`553f489`)**

- **R1 — 멤버 관리 REST 는 `members/manage.routes.ts`(`registerMemberManageRoutes`), 초대·재설정·「내 계정」은 `members/routes.ts`(`registerMemberRoutes`)다.** 태스크 3·4 를 나란히 돌리려고 나눴다. 틀리면 한 파일로 합친다.
- **`GET /api/v1/people`(세션)** — 사람 목록 `Person[]`(나간 멤버 포함, 나간 사람은 `role` 없음·`leftHandle`). 작성자 이름·@ 후보·나간 멤버 표시가 이것을 쓴다. 가입·역할 바꾸기·표시 이름·내보내기 뒤 워크스페이스 방에 wire `people.changed { people }`(지금 목록 전체) — 서버 모듈은 버스로만 알린다(`broadcastPeople(bus, db, workspaceId)`).
- **사람 메시지의 멘션은 채널 밖의 워크스페이스 사람도 푼다**(5장 「멘션을 받으면 참여」가 되게) — `channels/service.ts` 의 `userMessageParticipants`. membership 이 있는 사람(모르는 역할·나간 멤버 제외)을 앞에, 채널 참가자를 뒤에 둔다 — 핸들이 겹친 옛 데이터면 에이전트가 이긴다. **에이전트 메시지는 채널 참가자로만** 풀고 누구도 참여시키지 않는다. 쓴 사람·멘션된 사람의 참여는 메시지 저장과 같은 트랜잭션, `channel.member.changed` 는 커밋 뒤 한 번.
- **R3 — 핸들 검사는 `members/handles.ts` 의 `assertHandleFree` 한 함수다** — `left-` 접두사(`LEFT_HANDLE_PREFIX`)는 400 `VALIDATION`, 사람·에이전트 어느 쪽과 겹쳐도 409, 둘 다 `field: "handle"`. 가입·에이전트 등록·수정이 모두 이것을 부른다. 「`left-` = 나간 사람」 규칙이다. 틀리면 예약을 푼다. owner 부트스트랩 핸들(`OWNER_HANDLE`, `.env`)은 이 검사를 지나지 않는다.
- **나간 핸들은 `left-` + id(하이픈 뺀 32 hex)의 뒤 27자**(`leftHandleOf`, 4장) — `Handle` 상한 32자. 앞쪽 8자(uuid v7 의 시각)로 하면 약 65초 안에 가입한 두 사람을 차례로 내보낼 때 `users_ws_handle` 유일 인덱스에 걸렸다.
- **R2 — 내보내기와 admin → member 강등은 그 사람이 발급한 쓰이지 않은 초대·재설정 링크를 같은 트랜잭션에서 모두 폐기한다**(4장). 발급 권한을 잃은 뒤 링크가 권한 노릇을 하면 안 된다. 재승격해도 링크는 되살아나지 않는다. 틀리면 초대만 폐기로 좁힌다.
- **R4 — 폐기 조건은 `used_by IS NULL` 이다**(`used_at` 이 아니라). 수락이 진행 중인 초대(`claimInvite` 로 `used_at` 은 찍혔고 사용자 생성 전)도 폐기 대상에 든다 — `unclaimInvite` 는 `used_at` 만 되돌리므로 수락이 실패해도 폐기된 채 무효로 남는다. 수락이 끝난(`used_by` 있음) 행은 발급자를 나중에 내보내거나 강등해도 건드리지 않는다(「쓰임」과 「폐기」를 함께 말하지 않게). 틀리면 claim 중인 초대는 폐기에서 뺀다.
- **내보내기 순서** — Better Auth 삭제(세션·계정·사용자) → 우리 트랜잭션(역할을 안에서 다시 본다 — 동시에 두 번이면 둘째는 404) → `disconnectUser`. 트랜잭션이 실패하면 어느 갈래든 열린 소켓은 끊는다(세션은 이미 지웠다). 권한·없음 판정(await 사이 행위자 강등 등)은 사건 없이 그대로 403·404, 그 밖의 실패는 운영 사건 `member_remove_failed`(key `member:<userId>`, severity error) 뒤 500 — membership 이 남아 DELETE 를 다시 부르면 이어진다(Better Auth 삭제는 멱등).
- **wire `connection` 에서 membership 과 세션 행을 다시 본다** — 인증 미들웨어의 확인 뒤 await 가 있어, 그 틈에 내보내지거나 세션이 지워지면 `disconnectUser` 가 아직 방에 없는 소켓을 못 본다. 확인과 방 참가를 한 동기 구간에, 지우기와 끊기를 한 동기 구간에 두어 엇갈림을 닫았다.

**세션을 지우는 모든 자리가 그 소켓을 끊는다(곁가지 p4m-c1 — `1bc390d`·`d595334`·`87cbbf2`·`2afd070`)**

- 핸드셰이크가 Better Auth 세션 행 id 를 `socket.data.sessionId` 에 두고 `session:<id>` 룸에 넣는다(토큰 원문은 소켓에 없다). 세션을 지우는 자리와 끊기: 재설정 수락 → `disconnectUser`(대상 사용자 전부), `me/password` → `disconnectSessions`(지운 세션만 — 이 세션 소켓은 남는다), 로그아웃 → `disconnectSessions([이 세션])`(같은 쿠키의 다른 탭 포함), 내보내기 → `disconnectUser`. 순서는 늘 **지우기 → 끊기**다(뒤집으면 핸드셰이크 중인 소켓이 `connection` 재확인을 지나 방에 들어온 뒤 세션만 지워진다 — 테스트가 순서를 고정한다).
- `disconnectSessions` 와 `changePassword` 는 빈 목록이면 아무것도 하지 않는다 — socket.io-adapter 2.5.8 은 룸 목록이 비면 **모든 소켓**에 적용한다(`io.in([])`).
- **Better Auth HTTP 는 허용 목록만 통과시킨다** — `auth/routes.ts` 의 `BETTER_AUTH_HTTP_PATHS`(`/ok` 하나), 목록 밖은 404. 웹·스크립트는 Better Auth HTTP 를 부르지 않는다. 비밀번호 확인(`/verify-password`)·세션 목록(`/list-sessions` — 세션 토큰 원문을 낸다)도 닫는다 — 현재 비밀번호 대입은 `localLoginPerMin` 버킷의 `me/password` 로만. 원문 경로(쿼리 뺀)를 정확히 대조하므로 인코딩·끝 슬래시 변형도 목록 밖이고, 새 Better Auth 버전이 경로를 더해도 닫힌 채다. 그 밑의 겹 방어로 `disabledPaths` 가 세션을 지우는 경로(`/sign-out`·`/revoke-session`·`/revoke-sessions`·`/revoke-other-sessions`)와 `/sign-in/email`·`/change-password`·`/set-password`·`/update-user`·`/change-email`·`/delete-user` 를 닫는다. 세션은 소켓을 함께 끊는 우리 경로만 지운다. 서버 안의 `auth.api.*` 직접 호출(`signInEmail`·`signOut`·`getSession`)은 HTTP 를 지나지 않아 영향이 없다.
- **초대 경로 IP 버킷 `invitePublicPerMin` 20**(7장) — `lookup`·`accept`·`reset` 셋이 한 버킷, 로그인(`/auth/local`)과 `me/password` 는 `localLoginPerMin` 5 한 버킷. `@fastify/rate-limit` 은 라우트 `config.rateLimit` 마다 저장소를 따로 만들어 버킷이 갈리므로, 핸들러를 `createIpLimit` 으로 한 번 만들어 여러 라우트의 `onRequest` 에 같이 건다. 발급(`POST /invites`·`reset-link`)은 사용자당 `inviteIssuePerMin` 20.
- 만료된 세션(30일)의 소켓은 다음 재접속까지 산다 — 이월(`docs/plan.md` 8장).

**웹(태스크 5·6 과 곁가지 p4m-c2 — `f4c8bf4`·`d576258`·`4ba1ff1`·`6282d2d`·`e8feb2f`·`c997623`)**

- **서버 문구 대신 웹 문구(합쇼체)** — 서버의 해라체 문구(「handle @dev 는 이미 쓰이고 있다」·「…맞지 않는다」)를 화면에 그대로 내지 않는다. `features/auth/fields.tsx` 의 `fieldErrorText` 가 `코드:칸` 으로 고정 문구를 고른다(「이 핸들은 이미 쓰이고 있습니다」·「이 이메일은 이미 가입돼 있습니다」·예약 핸들 「이 핸들은 쓸 수 없습니다」·「현재 비밀번호가 맞지 않습니다」), 로그인 401 은 「이메일 또는 비밀번호가 맞지 않습니다」. 모르는 조합은 서버 문구 그대로다. 칸 오류가 나면 그 칸으로 초점을 옮긴다.
- **429 문구는 버킷을 따른다** — 로그인·`me/password` 는 「잠시 뒤 다시 시도하세요(1분 5회)」, 초대 조회·가입·재설정은 숫자 없이 「잠시 뒤 다시 시도하세요」(한도의 정본은 서버 `LIMITS` 뿐이라 웹이 버킷마다 숫자를 다시 맞추지 않는다).
- **로그인된 채 초대 링크를 열면 폼 위에 한 줄** — 「지금 @<핸들> 로 로그인돼 있습니다 — 가입하면 이 브라우저는 새 계정으로 바뀝니다」. 막지는 않는다. 수락이 끝나면 `useFinishInvite` 가 클라이언트 상태(캐시·소켓·사본)를 비운 뒤 `/` 로 replace 해 me 가 새 사용자가 된다.
- **공개 경로(`/join/`·`/reset/`)의 401 은 머문다** — `app/router.tsx` 의 `isPublicPath`. 오프라인 사본으로 옛 me 가 복원된 브라우저에서 링크를 열면 wire·me 의 401 이 로그인으로 보내고 토큰이 `?next=` 로 옮겨졌다. 이제 상태만 비우고 그 화면에 남는다.
- **토큰 걷기는 라우터의 replace 이동이다**(7장 `history.replaceState` 의 구체화) — 직접 부르면 라우터 상태와 주소가 갈린다. 조회 쿼리 키에는 토큰 원문 대신 `useId`, 토큰이 바뀌면 `key={token}` 으로 다시 마운트, `gcTime: 0`. 무효 화면의 주소에는 죽은 토큰이 남는다(이월).
- **역할이 바뀌면 곧바로 따른다**(6장 「다음 `/auth/me` 때」보다 빠르다) — `people.changed` 의 내 역할이 me 와 다르면 me 를 다시 받는다. 정본은 여전히 `/auth/me` 다. 그 사이 누른 관리 동작의 403 `FORBIDDEN` 은 공통 처리(`app/queryClient.ts` — 「권한이 없습니다」 토스트 하나 + `silent` 와 무관하게 me 재조회, wire `approval.resolve` 도 같다). 잠긴 칸은 저장 안 된 초안이 아니라 서버 값을 보인다.
- **관리 화면 진입** — 사이드바 「멤버」·「운영」과 run_limit 카드의 한도 링크·좁은 화면 운영 점은 admin 이상(`useCanManage`), 「연결」은 owner. 채널 설정의 「등록된 에이전트가 …」 두 안내의 「에이전트 등록」 링크도 admin 이상. 멤버 표의 owner 역할 이름은 「소유자」. 역할 셀렉트는 바꾸는 즉시 적용된다(확인 대화상자는 내보내기에만 — 6장 그대로).
- **오프라인 사본에 `people` 는 담고 멤버 표·대기 초대(`team` — 이메일이 든다)는 뺀다.** 원문을 한 번만 보이는 대화상자의 떠나기 막기는 `hooks/useLeaveGuard.ts` 하나를 브리지 토큰·초대·재설정 링크가 같이 쓴다.
- 390px 멤버 표는 제 상자 안에서 가로 스크롤한다 — 상자에 `relative` 가 없으면 머리 칸의 sr-only 「동작」(`position: absolute`)이 문서를 넓혔다.

**dev:fake(태스크 7a — `e74674a`)**

- 고정 member 계정 `mia`(`member@dodok.local`·`dev-fake-member-password`)를 owner 와 함께 보장한다 — 흉내 내지 않고 `issueInvite` → `acceptInvite` 를 그대로 부른다. `--keep` 이면 이미 있을 때 그대로. 운영 번들에는 없다.

**검증이 확인한 것**

- 서버 단위·통합: `apps/server/test/roles.matrix.test.ts`(2장 표 — 경로 × 역할 3 의 허용·거부 전부, `PATCH`·`POST /channels` 필드별, 채널 멤버 필드별, `approval.resolve`, 승인 푸시 수신자, membership 없는 세션 401, 역할이 바뀐 다음 요청), `members.invites`·`members.accept`·`members.manage`·`people`·`auth.login`·`auth.test`(9장 서버 항목 전부 — 두 번 제출·핸들 충돌 양쪽·재가입·링크 폐기·세션 소켓 끊기·핸드셰이크 틈·버킷 분리·Better Auth 폐기 경로 404), `integration/ops-events`·`setup`(방). 태스크마다 독립 리뷰(변이)·수정·범위 재리뷰.
- `dev:fake` 위 브라우저 검증(Playwright 브라우저 컨텍스트 7개, 390·1280px): 11항목 중 9 통과, Review Focus 1~5 실제 화면 통과(동시 가입은 한 쪽만·핸들 `dev` 409·내보낸 탭 2.4초 뒤 로그인 화면·member 의 `{ name, prompt }` 403·강등 직후 403 → 잠김). 결함 D2(재설정·비밀번호 변경 뒤 옛 세션 소켓이 말함 — 보안)·D1(390px 멤버 화면 가로 176px)과 관찰 o1~o5 는 곁가지 p4m-c1·c2 가 고쳤다. 실제 멘션 푸시 표시는 서비스 워커가 꺼진 dev 라 서버의 발송 시도·거름까지만 봤다(사람이 볼 것 — `docs/plan.md` 8장).
- 테스트 3538(shared 260·plugin 146·adapter 264·server 1382·web 1486 — 루트 `pnpm test` 의 패키지별 `Tests` 줄).
