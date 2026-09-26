# Phase 4 ② 팀 — 초대·멤버·역할 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`CLAUDE.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나.

**Goal:** owner 가 초대 링크로 지인·동료를 들이고, 멤버는 이메일·비밀번호로 로그인해 같은 채널에서 대화하며, 관리(에이전트·채널 동작 설정·세션 리셋·도구 승인·멤버)는 admin 이상만 한다.

**Architecture:** 초대·재설정 링크는 새 테이블 `invites`(해시만 저장, 1회용)가 갖고, 수락은 `modules/members` 가 Better Auth 내부 어댑터로 사용자를 만든다 — 공개 가입 경로는 계속 닫는다. 역할은 기존 `memberships.role`(owner·admin·member) 한 곳이고, 서버가 `requireRole` preHandler 와 필드별 검사로 역할 매트릭스를 강제한다. 웹은 누구나 읽는 사람 목록(`GET /api/v1/people` + wire `people.changed`)으로 작성자·멘션을 풀고, `/auth/me` 의 `role` 로 관리 화면을 가른다.

**Tech Stack:** Fastify 5 · Socket.IO 4.8 · drizzle-orm 0.45 + better-sqlite3 · Better Auth(`emailAndPassword`·`bearer`, 내부 어댑터) · zod 4 · React 19 + TanStack Router/Query — **새 의존성 없음**

**Spec:** `docs/superpowers/specs/2026-09-26-team-members-design.md` — 결정 0장, 권한 2장, 초대·가입·로그인 3장, 멤버 관리 4장, 채널 참여·알림 5장, 웹 6장, 보안 7장, 오류 8장, 검증 9장. **태스크를 시작하기 전에 스펙의 해당 장을 읽는다.**

## Global Constraints

- **새 npm 의존성은 없다.**
- 역할: `owner` > `admin` > `member`(guest 는 쓰지 않는다). owner 는 한 명 — `OWNER_EMAIL` 계정, 로컬 토큰이 비밀번호.
- 역할 매트릭스는 스펙 2장 표가 정본이다. **서버가 막는다**(웹 숨김은 편의). 모자라면 REST 403 `FORBIDDEN`, wire ack `FORBIDDEN`. 역할은 요청마다 membership 에서 읽는다.
- membership 이 없는 세션은 모든 경로에서 401.
- 토큰: 초대 `dit_`·재설정 `drt_` + 32바이트 난수 base64url, DB 에는 sha256 hex 만. 원문은 발급 응답 한 번뿐 — 로그·사건·목록·wire 에 원문 없음. 초대 7일, 재설정 24시간, 1회용. 무효 까닭(쓰임·만료·폐기·없음)은 모두 404.
- 입력: 핸들 `Handle`(`[a-z0-9_-]{2,32}`) — **사람(`users`)과 에이전트(`agents`)를 통틀어 워크스페이스 안에서 유일**. 이메일 워크스페이스 안에서 유일. 비밀번호 12~256자. 표시 이름 1~64자.
- 로그인 실패 문구 하나: 이메일 모양은 401 「이메일 또는 비밀번호가 맞지 않는다」. `OWNER_EMAIL` 로의 이메일 로그인은 같은 401.
- Better Auth 의 공개 가입·`/sign-in/email`·`/change-password`·`/set-password`·`/update-user`·`/change-email`·`/delete-user` 는 계속 닫는다(`disabledPaths` 그대로).
- 레이트리밋 숫자는 `apps/server/src/modules/ops/limits.ts` 한곳.
- 시크릿 규칙 `docs/guides/live-smoke.md` 「시크릿 규칙」. 5173·3000 금지(웹 5180, dev:fake 3100 대). 프로세스는 자기 PID 로만. Docker `prune` 금지.
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프. 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 생성물(drizzle SQL·meta)은 생성기(`pnpm -F @dodok/server exec drizzle-kit generate`)로.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 자기 실행 출력에서 패키지별로(0개는 통과가 아니다). 웹을 바꿨으면 `pnpm -F @dodok/web build`.

## Review Focus

1. **같은 초대 링크를 두 브라우저에서 거의 동시에 제출** — 한 명만 가입되고 다른 쪽은 404 「초대가 만료됐거나 이미 쓰였습니다」. Better Auth 사용자·`users`·`memberships` 는 한 벌만 생긴다. → 태스크 3.
2. **가입 핸들이 기존 에이전트 핸들과 같음(`@dev`)** — 409 `field: "handle"`, 초대는 소비되지 않아 고쳐서 다시 제출하면 된다. 반대로 에이전트 등록 핸들이 사람 핸들과 같아도 409. → 태스크 3(가입)·4(에이전트 등록).
3. **내보내진 멤버의 열린 탭** — 다음 REST 는 401 → 웹은 로그인 화면, 열린 wire 는 서버가 끊고 재접속은 거절, 푸시는 오지 않는다. → 태스크 4(서버)·6(웹).
4. **member 가 한 `PATCH /channels/:id` 에 `name` 과 `prompt` 를 함께 보냄** — 요청 전체 403, 이름도 바뀌지 않는다(부분 적용 없음). → 태스크 2.
5. **역할이 내려간 직후 화면에 남은 관리 버튼을 누름** — 서버 403, 웹은 「권한이 없습니다」 한 줄, 다음 `/auth/me` 뒤 잠긴다. → 태스크 2(서버)·6(웹).

---

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `packages/shared/src/members/index.ts`(새)·`domain/index.ts`·`wire/index.ts`·`ops/index.ts`·`index.ts` | 1 | 초대·멤버·사람 계약, 역할 비교, wire `people.changed`, 운영 사건 종류 |
| `apps/server/src/db/schema.sqlite.ts`·`drizzle/0008_*` | 2 | `invites`, `users.left_handle`, `users` 이메일 유일 |
| `apps/server/src/auth/{routes,roles}.ts`·각 모듈 `routes.ts`·`realtime/socket.ts`·`modules/push/*` | 2 | `requireRole`·역할 매트릭스·승인 알림 수신자 |
| `apps/server/src/modules/members/{tokens,invites,accept,routes}.ts`(새)·`auth/routes.ts`(로그인)·`modules/ops/limits.ts` | 3 | 초대·재설정·가입·이메일 로그인·「내 계정」 |
| `apps/server/src/modules/members/{service,people}.ts`(새)·`modules/agents/service.ts`·`modules/messages/service.ts`·`modules/channels/service.ts` | 4 | 멤버 관리·내보내기·사람 목록·핸들 유일·자동 참여 |
| `apps/web/src/features/auth/*`·`features/account/*`(새)·`app/router.tsx` | 5 | 가입·재설정·로그인·「내 계정」 화면 |
| `apps/web/src/features/members/*`(새)·`features/messages/useAuthors.ts`·`features/composer/mentions.ts`·`features/settings/*`·`features/approvals/*`·`features/agents/*`·`app/layout/*`·`realtime/handlers.ts` | 6 | 멤버 화면·사람 목록·역할에 따른 화면 |
| `apps/server/scripts/dev-fake.ts` | 7 | 고정 member 계정 |
| 문서 | 8 | plan·project-structure·deploy·README·CLAUDE.md(조율자) |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 shared 계약 | — |
| B | 2 DB·역할 매트릭스(서버) | 1 |
| C | 3 초대·가입·로그인(서버) ‖ 4 멤버 관리·사람·자동 참여(서버) | 2 (둘 다 `app.ts` 에 라우트 한 줄씩 — 뒤에 병합하는 쪽이 rebase) |
| D | 5 웹 인증 화면 ‖ 6 웹 멤버·역할 화면 | 3(5), 3·4(6) |
| E | 7 dev:fake + 브라우저 검증(owner·member 두 컨텍스트) | 5·6 |
| F | 8 실연(런 0회) + 문서 | 7 |

---

### Task 1: shared 계약

**Files:**
- Create: `packages/shared/src/members/index.ts`, `packages/shared/test/members.test.ts`
- Modify: `packages/shared/src/domain/index.ts`(`User` 에 `leftHandle`), `packages/shared/src/wire/index.ts`(`people.changed`), `packages/shared/src/ops/index.ts`(`OpsEventKind` 에 `"invite_accept_failed"`), `packages/shared/src/index.ts`

**Interfaces — Produces:**

```ts
// members/index.ts
export const TeamRole = z.enum(["owner", "admin", "member"]);
export type TeamRole = z.infer<typeof TeamRole>;
/** role 이 min 이상인가. 모르는 값(guest·undefined)은 false */
export function roleAtLeast(role: string | undefined, min: TeamRole): boolean;

export const Password = z.string().min(12).max(256);
export const DisplayName = z.string().trim().min(1).max(64);

export const InviteKind = z.enum(["invite", "reset"]);
export const Invite = z.object({
  id: Id, kind: InviteKind, role: z.enum(["admin", "member"]).optional(), targetUserId: Id.optional(),
  prefix: z.string(), createdBy: Id, createdAt: IsoDateTime, expiresAt: IsoDateTime,
});
export const IssueInviteBody = z.object({ role: z.enum(["admin", "member"]) });
export const IssuedInvite = z.object({ invite: Invite, token: z.string(), url: z.string() });
export const TokenBody = z.object({ token: z.string().min(1).max(200) });
export const InviteLookup = z.object({ workspaceName: z.string(), kind: InviteKind, role: z.enum(["admin", "member"]).optional() });
export const AcceptInviteBody = z.object({
  token: z.string().min(1).max(200), handle: Handle, displayName: DisplayName, email: z.email().max(254), password: Password,
});
export const ResetPasswordBody = z.object({ token: z.string().min(1).max(200), password: Password });

export const LocalLoginBody = z.union([
  z.object({ token: z.string().min(1).max(256) }),
  z.object({ email: z.email().max(254), password: z.string().min(1).max(256) }),
]);

export const Person = z.object({
  id: Id, handle: z.string(), displayName: z.string(), role: TeamRole.optional(), // role 없음 = 나간 멤버
  leftHandle: Handle.optional(), avatarUrl: z.string().optional(),
});
export const MemberRow = Person.extend({ role: TeamRole, email: z.string().optional(), createdAt: IsoDateTime });
export const UpdateMemberRoleBody = z.object({ role: z.enum(["admin", "member"]) });
export const UpdateMeBody = z.object({ displayName: DisplayName });
export const ChangePasswordBody = z.object({ current: z.string().min(1).max(256), next: Password });

// wire ServerToClientEvents
"people.changed": (p: { people: Person[] }) => void;
```

- [ ] **Step 1: 실패하는 테스트** — `members.test.ts`: `roleAtLeast` 표(owner≥admin·admin≥member·member<admin·`"guest"`·`undefined` → false), `LocalLoginBody` 가 `{token}`·`{email,password}` 를 받고 섞인 모양·빈 값을 거절, `AcceptInviteBody` 가 핸들 대문자·1자·33자·비밀번호 11자·257자·이메일 아닌 값을 거절, `Person` 이 `role` 없음(나간 멤버)을 받음.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.** 기존 `MembershipRole` 은 그대로 둔다(DB 값 호환).
- [ ] **Step 3: 루트 검사 4종** — 서버·웹이 깨지지 않게 새 필드는 선택.
- [ ] **Step 4: 커밋** — `feat(shared): 초대·멤버·사람 계약과 역할 비교`.

---

### Task 2: DB·역할 매트릭스(서버)

**Files:**
- Modify: `apps/server/src/db/schema.sqlite.ts`(`invites` 테이블, `users.leftHandle`, `users` 에 `uniqueIndex("users_ws_email").on(workspaceId, email)`), 생성기로 `apps/server/drizzle/0008_*`
- Create: `apps/server/src/auth/roles.ts`, `apps/server/test/roles.matrix.test.ts`
- Modify: `apps/server/src/auth/routes.ts`(`requireOwner` → `requireRole("owner")`, `/auth/me` 는 membership 없으면 401), `modules/agents/routes.ts`, `modules/channels/routes.ts`, `modules/ops/routes.ts`, `modules/setup/routes.ts`, `realtime/socket.ts`(`approval.resolve`, 핸드셰이크에서 membership 없으면 거절), `modules/push/service.ts`·`triggers.ts`(승인 수신자)

**Interfaces:**
- Consumes: 태스크 1 `roleAtLeast`, `TeamRole`.
- Produces:

```ts
// auth/roles.ts
/** 세션 확인 뒤 membership 역할을 요청마다 읽는다. 세션 없음 401, membership 없음 401, 모자람 403 */
export function requireRole(ctx: { auth: Auth; db: Db; workspaceId: string }, min: TeamRole): preHandlerAsyncHookHandler;
/** 핸들러 안에서(필드별 검사 등) — 모자라면 403 을 던진다 */
export function assertRole(db: DbOrTx, workspaceId: string, userId: string, min: TeamRole): void;
export function roleOf(db: DbOrTx, workspaceId: string, userId: string): TeamRole | undefined;
/** PATCH /channels/:id 에서 member 가 바꿀 수 있는 필드. 목록 밖 필드가 하나라도 있으면 admin */
export const MEMBER_EDITABLE_CHANNEL_FIELDS: ReadonlySet<string>; // new Set(["name", "topic"])
// requireOwner(ctx) 는 requireRole(ctx, "owner") 를 돌려주는 얇은 이름으로 남긴다(기존 호출처)
```

- DB: `invites`(스펙 3.1 표 그대로 — `kind` text, `role` text null, `target_user_id` text null → users.id, `token_hash` 유일, `prefix`, `created_by` → users.id, `created_at`·`expires_at`·`used_at`·`revoked_at` ts, `used_by` text null), `users.left_handle` text null.
- 적용 자리(스펙 2장 표):
  - `POST/PATCH /agents` → admin.
  - `PATCH /channels/:id` → 핸들러 첫 줄에서 본문 키 중 `MEMBER_EDITABLE_CHANNEL_FIELDS` 밖이 있으면 `assertRole(admin)` — **검사가 쓰기보다 먼저**(부분 적용 없음).
  - `POST /channels/:id/members` → `memberType: "agent"` 이고 `promptOverride`·`autoRespond` 가 있으면 admin, 아니면 누구나(`aliases` 는 누구나).
  - `PATCH /channels/:id/members/:memberId` → `aliases` 만이면 누구나, `promptOverride`·`autoRespond` 가 있으면 admin.
  - `DELETE /channels/:id/members/:memberId`(에이전트 빼기) → 누구나.
  - `POST /channels/:id/agents/:agentId/reset` → admin.
  - `/api/v1/ops/*` → admin. `/api/v1/setup/*` → owner(그대로).
  - wire `approval.resolve` → `roleAtLeast(roleOf(...), "admin")` 아니면 ack `FORBIDDEN`(승인 상태 불변).
  - wire 핸드셰이크 → membership 없으면 거절(`UNAUTHORIZED`).
  - 승인 푸시(`targetsForApproval`) 수신자 = **워크스페이스의 owner·admin 전원**(채널 참여와 무관 — 승인은 관리 일이다). `TriggerLookups` 에 `admins(): string[]` 를 더한다.

- [ ] **Step 1: 실패하는 테스트** — `roles.matrix.test.ts`: owner·admin·member 세션 셋(테스트 헬퍼로 users·memberships·Better Auth 세션을 직접 만든다)으로 위 경로마다 허용·거부를 표로 돈다(`it.each`). `PATCH /channels/:id` 는 `{name}`·`{topic}` member 200, `{prompt}`·`{relayPolicy}`·`{visibility}` member 403, **`{name, prompt}` member 403 이고 이름이 안 바뀜**(Review Focus 4). `approval.resolve` member → ack `FORBIDDEN`·승인 pending 그대로. membership 을 지운 세션 → `/auth/me` 401·아무 REST 401·wire 핸드셰이크 거절. 승인 푸시가 admin·owner 에게만(member 가 채널 참여자여도 안 감). 역할을 member 로 내린 직후 같은 세션의 admin 경로 → 403(Review Focus 5).
- [ ] **Step 2: 마이그레이션** — 스키마를 고치고 생성기를 돌린다. 기존 DB(0007 상태, owner 한 명)에 적용해 owner 행이 그대로인지 `test/db.test.ts` 에 한 사례.
- [ ] **Step 3: 구현 → 통과.** 기존 `requireOwner` 호출처는 동작이 같아야 한다(기존 테스트 그대로 초록).
- [ ] **Step 4: 루트 검사 4종.**
- [ ] **Step 5: 커밋** — `feat(server): 역할 매트릭스 — requireRole·필드별 검사·승인은 admin 이상`(마이그레이션은 같은 커밋 또는 `feat(server): invites 테이블·users.left_handle` 로 앞에).

---

### Task 3: 초대·가입·로그인·「내 계정」(서버)

**Files:**
- Create: `apps/server/src/modules/members/tokens.ts`, `invites.ts`, `accept.ts`, `routes.ts`(초대·재설정·내 계정 경로), `apps/server/test/members.invites.test.ts`, `apps/server/test/members.accept.test.ts`, `apps/server/test/auth.login.test.ts`
- Modify: `apps/server/src/auth/routes.ts`(`/api/v1/auth/local` 두 모양), `apps/server/src/modules/ops/limits.ts`(`inviteIssuePerMin`), `apps/server/src/app.ts`(`registerMemberRoutes`)

**Interfaces:**
- Consumes: 태스크 1 계약, 태스크 2 `requireRole`·`assertRole`·`invites` 스키마.
- Produces:

```ts
// tokens.ts
export function newToken(kind: "invite" | "reset"): { token: string; hash: string; prefix: string }; // "dit_…" | "drt_…"
export function hashToken(token: string): string; // sha256 hex
// 대조는 token_hash 유일 인덱스로 행을 찾은 뒤 crypto.timingSafeEqual 로 한 번 더 — 스펙 7장
// invites.ts
export function issueInvite(db: Db, input: { workspaceId: string; role: "admin" | "member"; createdBy: string; now: Date }): { invite: Invite; token: string };
export function issueResetLink(db: Db, input: { workspaceId: string; targetUserId: string; createdBy: string; now: Date }): { invite: Invite; token: string }; // 대상의 앞선 재설정 링크는 폐기
export function listPendingInvites(db: DbOrTx, workspaceId: string, now: Date): Invite[];
export function revokeInvite(db: Db, workspaceId: string, id: string, now: Date): Invite | undefined;
/** 유효하면 행, 아니면 undefined(까닭 구분 없음) */
export function findValidInvite(db: DbOrTx, token: string, now: Date): InviteRow | undefined;
/** used_at IS NULL·revoked_at IS NULL·expires_at > now 인 행만 used_at 을 채운다 — 바뀐 행 수 1 이면 true */
export function claimInvite(db: DbOrTx, id: string, now: Date): boolean;
export function unclaimInvite(db: DbOrTx, id: string): void;
// accept.ts
export async function acceptInvite(deps: { db: Db; auth: Auth; workspaceId: string; ops: OpsService; now: () => Date }, body: AcceptInviteBody): Promise<{ userId: string }>;
export async function resetPassword(deps: …, body: ResetPasswordBody): Promise<{ userId: string }>;
// 핸들 검사 — 태스크 4 의 agents 쪽도 이것을 쓴다
export function assertHandleFreeForPeople(db: DbOrTx, workspaceId: string, handle: string): void; // users·agents 둘 다, 409 field "handle"
```

- REST(스펙 3.2~3.5): `POST /api/v1/invites`(admin — admin 은 `role: "member"` 만, 아니면 403), `GET /api/v1/invites`(admin), `DELETE /api/v1/invites/:id`(admin — admin 은 member 초대만), `POST /api/v1/members/:userId/reset-link`(admin — admin 은 member 에게만, owner 계정 대상은 403), `POST /api/v1/invites/lookup`·`/accept`·`/reset`(로그인 불필요, `localLoginPerMin` IP 버킷), `PATCH /api/v1/me`, `POST /api/v1/me/password`(owner 403).
- `acceptInvite` 순서(스펙 3.3): 검증 → 핸들·이메일 중복(409 `field`) → `claimInvite`(false → 404) → Better Auth `internalAdapter.createUser` + `linkAccount`(비밀번호 해시 `ctx.password.hash`) → 한 트랜잭션으로 `users`(`auth_provider: "local"`)·`memberships`·`invites.used_by` → 세션 발급(`internalAdapter.createSession`) + `SESSION_COOKIE`. 4·5 가 실패하면 만든 Better Auth 사용자 삭제 + `unclaimInvite`; 그것도 실패하면 `ops.record({ kind: "invite_accept_failed", … })` 후 500. 유일 인덱스 위반(경합)은 409 로 바꾼다.
- 로그인: `LocalLoginBody` 로 가른다. 이메일 모양 — `OWNER_EMAIL` 이면 401, 아니면 `auth.api.signInEmail`, 실패 401 한 문구, 성공했는데 membership 없으면 401. 응답 모양은 지금과 같다.
- `resetPassword`: 대상 credential 비밀번호 갱신 + 대상의 세션 모두 삭제 → 새 세션 발급. `me/password`: 현재 비밀번호 확인(`ctx.password.verify`) → 갱신 → **이 세션을 뺀** 본인 세션 삭제.

- [ ] **Step 1: 실패하는 테스트** — `members.invites.test.ts`: 발급(원문 `dit_` 모양·DB 엔 해시만·목록에 원문 없음), admin 의 admin 초대 403, 폐기, 만료(가짜 시계), 재설정 링크 새로 발급하면 앞 것 무효, owner 대상 재설정 403. `members.accept.test.ts`: 정상 가입 → 세션으로 `/auth/me`(role 이 초대의 역할), 재사용 404, 만료·폐기 404(같은 본문), **두 번 동시 제출 → 한 명만**(Review Focus 1 — `Promise.all` 두 개, users·memberships·Better Auth user 수 1), **에이전트 핸들 `dev` 로 가입 → 409 `field:"handle"`·초대 미소비·고쳐서 성공**(Review Focus 2), 이메일 중복 409, 우리 행 쓰기 실패를 주입(테스트용 훅)하면 Better Auth 사용자가 남지 않고 초대가 되돌려짐, 재설정 뒤 대상의 옛 세션 401·새 비밀번호로 로그인. `auth.login.test.ts`: `{token}` owner 그대로, `{email,password}` 성공, 틀린 비밀번호·없는 이메일·`OWNER_EMAIL` 이 같은 401 문구, membership 없는 사용자 401, 레이트리밋 버킷 공유. `me/password` 뒤 다른 세션 401·이 세션 유지, owner 403.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.**
- [ ] **Step 3: 로그 위생** — 테스트 로거로 발급·수락·재설정·로그인 실패 전 과정의 로그 줄에 원문 토큰·비밀번호·이메일이 없음을 단언.
- [ ] **Step 4: 루트 검사 4종 + `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`.**
- [ ] **Step 5: 커밋** — `feat(server): 초대·재설정 링크·이메일 로그인·내 계정`.

---

### Task 4: 멤버 관리·사람 목록·핸들 유일·자동 참여(서버)

**Files:**
- Create: `apps/server/src/modules/members/service.ts`, `people.ts`, `apps/server/test/members.manage.test.ts`, `apps/server/test/people.test.ts`
- Modify: `apps/server/src/modules/members/routes.ts`(태스크 3 파일에 경로 추가 — 태스크 3 뒤 rebase), `modules/agents/service.ts`(`assertHandleFree` 가 사람도 본다 — 태스크 3 의 `assertHandleFreeForPeople`), `modules/messages/service.ts`(사람 메시지 저장 뒤 자동 참여), `modules/channels/service.ts`(`joinChannelIfAbsent`), `realtime/socket.ts`(사용자 소켓 끊기)

**Interfaces:**
- Consumes: 태스크 2 `requireRole`·`roleOf`, 태스크 3 `assertHandleFreeForPeople`·routes 파일.
- Produces:

```ts
// service.ts
export function listMembers(db: DbOrTx, workspaceId: string): MemberRow[];
export function changeRole(db: Db, workspaceId: string, actorId: string, userId: string, role: "admin" | "member"): MemberRow; // owner 만, owner 대상 403
/** membership·channel_members(user) 삭제, Better Auth user·account·session 삭제, push 구독 삭제, users.left_handle ← handle,
 *  handle ← "left-<id 앞 8자>", email ← NULL. 권한: admin 은 member 만, owner 는 owner 제외 모두 */
export async function removeMember(deps: { db: Db; auth: Auth; workspaceId: string; disconnectUser(userId: string): void }, actorId: string, userId: string): Promise<void>;
// people.ts
export function listPeople(db: DbOrTx, workspaceId: string): Person[]; // 나간 멤버 포함(role 없음·leftHandle)
/** 사람 목록이 바뀐 뒤(가입·역할·표시 이름·내보내기) 워크스페이스 방에 people.changed */
export function broadcastPeople(io: DodokServer, db: DbOrTx, workspaceId: string): void;
// channels/service.ts
/** 사람이 채널에 없으면 넣고 true(→ channel.member.changed). 이미 있으면 false */
export function joinChannelIfAbsent(tx: DbOrTx, channelId: string, userId: string, now: Date): boolean;
```

- REST: `GET /api/v1/members`(admin), `PATCH /api/v1/members/:userId`(owner), `DELETE /api/v1/members/:userId`(admin — 규칙은 `removeMember`), `GET /api/v1/people`(로그인한 누구나).
- 자동 참여(스펙 5장): 사람이 메시지를 저장하면(스레드 답글 포함) 그 채널에, 메시지가 사람을 멘션하면 멘션된 사람도 그 채널에 `joinChannelIfAbsent` — 메시지와 같은 트랜잭션. 바뀌면 기존 `channel.member.changed`.
- `people.changed` 는 가입(태스크 3 `acceptInvite` 끝에서도 부른다 — 태스크 3 이 먼저 병합되면 이 태스크가 그 자리에 호출을 더한다)·역할 바꾸기·표시 이름·내보내기 뒤.

- [ ] **Step 1: 실패하는 테스트** — `members.manage.test.ts`: 목록(admin 200·member 403), 역할 바꾸기(owner 만, owner 대상 403, 바뀐 뒤 그 세션의 권한이 다음 요청부터), **내보내기**: member 를 admin 이 내보냄 → 그 세션 REST 401, 열린 wire 소켓 disconnect, 재접속 핸드셰이크 거절, push 구독 0, channel_members(user) 0, `users.handle = left-…`·`left_handle`·`email NULL`, 그 사람 메시지는 남음(Review Focus 3). 같은 이메일·옛 핸들로 새 초대 가입 성공. admin 이 admin 내보내기 403, 누구도 owner 내보내기 403. 에이전트 등록 핸들이 사람 핸들과 같으면 409(Review Focus 2 반대쪽), 나간 사람의 옛 핸들로는 에이전트 등록 가능. `people.test.ts`: `GET /people` 이 member 에게도 200, 나간 멤버는 `role` 없고 `leftHandle` 있음, 가입·역할·표시 이름·내보내기 뒤 `people.changed` 한 번. 자동 참여: 첫 메시지 → 참여·`channel.member.changed`, 두 번째 메시지 → 변화 없음, 스레드 답글도 참여, 멘션된 사람 참여, 에이전트 헤더 「참여자:」(`runs/context`)에 온 사람만.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.**
- [ ] **Step 3: 루트 검사 4종.**
- [ ] **Step 4: 커밋** — `feat(server): 멤버 관리·내보내기·사람 목록·채널 자동 참여`.

---

### Task 5: 웹 — 가입·재설정·로그인·「내 계정」

**Files:**
- Create: `apps/web/src/features/auth/JoinPage.tsx`, `ResetPage.tsx`, `apps/web/src/features/account/AccountDialog.tsx`, 각 테스트
- Modify: `apps/web/src/features/auth/LoginPage.tsx`(이메일·비밀번호 기본 + 접힌 「owner 로컬 토큰으로 로그인」), `features/auth/mutations.ts`, `app/router.tsx`(`/join/$token`·`/reset/$token` — 로그인 불필요, 로그인 가드 밖), 사용자 메뉴(`app/layout/*` 에서 「내 계정」)

**Interfaces:**
- Consumes: 태스크 1 계약, 태스크 3 REST(`/invites/lookup`·`/accept`·`/reset`·`/auth/local`·`/me`·`/me/password`).

- `/join/$token`: 먼저 lookup(토큰은 본문) → 워크스페이스 이름·역할 → 폼(핸들·표시 이름·이메일·비밀번호·확인). 409 는 `field` 칸 아래. 성공하면 `history.replaceState` 로 토큰을 걷고 me 캐시를 채워 첫 채널로. 404 는 「초대가 만료됐거나 이미 쓰였습니다 — 초대한 사람에게 새 링크를 받으세요」. 비밀번호 두 칸이 다르면 제출 막음. 390px 에서 가로 스크롤 없음.
- `/reset/$token`: 같은 꼴에 비밀번호 두 칸.
- 로그인: 이메일·비밀번호 폼이 기본, 401 문구 그대로 표시, 접힌 토큰 폼은 지금 동작.
- 「내 계정」: 표시 이름 저장, 비밀번호 바꾸기(현재·새·확인) — owner 에게는 비밀번호 칸 대신 「owner 비밀번호는 로컬 토큰이다 — `.env` 의 LOCAL_AUTH_TOKEN 으로 바꾼다」.

- [ ] **Step 1: 실패하는 테스트** — 가입 폼(lookup 404 문구·409 칸 표시·성공 시 토큰이 주소에서 사라지고 채널로 이동·확인 불일치), 재설정 폼, 로그인 두 폼(이메일 401 문구·토큰 폼 펼치기), 「내 계정」(owner 에게 비밀번호 칸 없음·틀린 현재 비밀번호 오류).
- [ ] **Step 2: 구현 → 통과, `pnpm -F @dodok/web build`.**
- [ ] **Step 3: 커밋** — `feat(web): 초대 가입·비밀번호 재설정·이메일 로그인·내 계정`.

---

### Task 6: 웹 — 멤버 화면·사람 목록·역할에 따른 화면

**Files:**
- Create: `apps/web/src/features/members/{MembersPage,InviteDialog,MemberRowActions,queries,mutations}.tsx|ts` + 테스트
- Modify: `apps/web/src/api/queries.ts`(`usePeople`, `qk.people`), `realtime/handlers.ts`(`people.changed`), `features/messages/useAuthors.ts`(사람 작성자를 people 로, 나간 멤버 「나간 멤버 @<leftHandle>」 흐린 글씨), `features/composer/mentions.ts`(사람 후보 = people 중 role 있는 사람 전원 + 그 채널 에이전트), `features/settings/*`(member 는 관리 항목 잠금 + 「관리자만 바꿀 수 있습니다」, 에이전트 넣기·빼기·별칭은 열림), `features/approvals/ApprovalCard.tsx`·`notify.ts`(member 는 버튼 대신 「관리자가 결정합니다」·탭 안 승인 알림 안 띄움), `features/agents/*`(등록 버튼 admin 이상), 「새 대화」 버튼 admin 이상, `app/router.tsx`(`/settings/members` — admin 이상), `app/layout/*`(설정 메뉴 「멤버」·운영은 admin 이상·연결은 owner), 403 공통 처리(「권한이 없습니다」 한 줄)

**Interfaces:**
- Consumes: 태스크 1 `Person`·`MemberRow`·`roleAtLeast`, 태스크 3·4 REST·wire `people.changed`.
- Produces: `useRole(): TeamRole | undefined`(me 캐시에서), `usePeople()`.

- 멤버 화면(스펙 6장): 표(핸들·이름·이메일·역할·가입일), 줄 동작(역할 바꾸기 — owner 만, 「재설정 링크」 — 링크를 한 번만 보이는 대화상자, 「내보내기」 — 확인 대화상자), 「초대」(역할 선택은 owner 만 — admin 은 member 고정, 링크 한 번만·복사·「이 링크는 다시 볼 수 없습니다」 — 설정 마법사 `features/setup/IssueTokenDialog.tsx` 와 같은 꼴·390px 에서 잘리지 않게), 대기 중인 초대(역할·만료·「폐기」).
- 401(내보내짐)은 지금의 공통 처리대로 로그인 화면(Review Focus 3).

- [ ] **Step 1: 실패하는 테스트** — 멤버 화면(admin 은 역할 바꾸기 없음·초대 역할 고정, owner 는 둘 다, 발급 링크 한 번만, 폐기, 내보내기 확인), `people.changed` 로 작성자 이름 갱신, 나간 멤버 표시, 멘션 후보에 다른 사람(나간 멤버 제외), member 로 로그인한 화면: 채널 설정 관리 항목 잠금·에이전트 넣기 가능·등록 버튼 없음·「새 대화」 없음·승인 카드 「관리자가 결정합니다」·설정 메뉴에 멤버·운영·연결 없음, **역할이 내려간 직후 관리 동작 → 403 「권한이 없습니다」**(Review Focus 5), 401 → 로그인.
- [ ] **Step 2: 구현 → 통과, `pnpm -F @dodok/web build`.**
- [ ] **Step 3: 커밋** — `feat(web): 멤버 화면·사람 목록·역할에 따른 화면`.

---

### Task 7: dev:fake + 브라우저 검증

- [ ] **7a 코드** `apps/server/scripts/dev-fake.ts`: 고정 member 계정(이메일 `member@dodok.local`, 비밀번호 `dev-fake-member-password`, 핸들 `mia`, 표시 이름 「미아」 — 시크릿이 아닌 개발 전용 고정값이라 시작 로그에 찍는다), `--keep` 이면 이미 있을 때 그대로. 운영 번들에 없음(bundle:smoke). CLAUDE.md 「명령」 dev:fake 줄·`docs/project-structure.md` dev:fake 절에 한 마디. 테스트.
- [ ] **7b 브라우저 검증**(dev:fake 3100 + 웹 5180, owner·member **두 브라우저 컨텍스트**, 390·1280px, **네가 연 탭·브라우저는 네가 닫아라**): owner 가 초대 발급 → 새 컨텍스트에서 `/join/…` 가입(핸들 충돌 409 표시 포함) → 같은 채널 대화(자동 참여 — 에이전트 멘션 뒤 헤더 참여자는 실연에서) · 멘션 푸시(사람 → 사람, 탭 안 알림) · member 의 채널 설정 잠금·등록 버튼 없음·승인 카드 문구 · owner 가 member → admin 올림 → member 화면이 다음 `/auth/me` 뒤 열림 · 재설정 링크 → 새 비밀번호 로그인 · 내보내기 → member 탭 로그인 화면 · 같은 링크 재사용 404 · 콘솔 새 오류 없음.
- [ ] 결함은 조율자가 수정 워커로.

---

### Task 8: 실연(런 0회) + 문서

- [ ] 실연(dev Gateway, 스크래치 `openclaw@2026.9.5`, live-smoke 「런 0회 하네스」, **모델 런 0회**): 사람 둘(owner·member)이 한 채널에 쓰고 에이전트를 멘션 → 가짜 CLI 가 받은 헤더 「참여자:」에 둘 다, 채널에 오지 않은 셋째 사람은 없음 · member 가 승인 요청을 결정하지 못함(REST·wire)·admin 은 결정. 결과 `docs/guides/live-smoke.md` 새 절(제목은 조율자가 브리프에 준다).
- [ ] 문서: `docs/plan.md` 8장 Phase 4 「팀」에 이번 사이클 완료·남은 것(OIDC·채널 권한·멀티 Gateway·owner 넘기기)·이월, 10장에 결정(역할 매트릭스·초대 링크), `docs/project-structure.md`(`modules/members`·`auth/roles.ts`·`invites`·`people`·웹 `features/members`·`features/account`), `docs/guides/deploy.md`(멤버 초대 절차 — 초대 링크의 `APP_ORIGIN`, 비밀번호 재설정, 내보내기), `README.md`(소개 한 줄), 스펙 「구현과 맞춘 것」. `CLAUDE.md`(현재 단계)는 조율자.
