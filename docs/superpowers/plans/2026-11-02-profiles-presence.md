# 프로필·상태 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 이 저장소에서는 Orca 가 살아 있으면 `scripts/orca-worker.sh` 워커가 태스크를 돈다(`AGENTS.md` 「작업 방식」).

**Goal:** 사람·에이전트 프로필 패널, 아바타 올리기, 사람의 자동·수동 상태와 상태 메시지, 방해 금지 푸시 거르기, 에이전트 소유자와 자동 상태 점을 만든다.

**Architecture:** 공유 계약(`packages/shared`)에 상태·접속 타입과 wire 이벤트를 더하고, 서버에 `modules/profile`(상태·아바타 저장)과 `modules/presence`(유효 상태 계산·변화만 알림)를 새로 둔다. 기존 푸시 거르기 `Presence`(소켓별 보임)를 접속 계산의 입력으로 재사용하고, 방해 금지는 `forUser` 한 곳에서 거른다. 웹은 zustand 접속 저장소 + 오른쪽 패널의 새 「프로필」 탭 + 「내 계정」 프로필 섹션.

**Tech Stack:** TypeScript, Zod 4, Fastify 5, Socket.IO 4, drizzle(SQLite) + drizzle-kit 마이그레이션, `image-size`, React + TanStack Router/Query + zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-profiles-presence-design.md` (로드맵 `docs/superpowers/specs/2026-11-02-messenger-basics-roadmap.md`)

## Global Constraints

- 새 npm 의존성 없음(스펙 결정 11). 이미지 크기는 `image-size`, 바이트 형식은 `apps/server/src/modules/attachments/sniff.ts`.
- 아바타 파일은 `<DATA_DIR>/avatars/<sha256>.<ext>`, ext 는 `png`·`jpeg`·`webp` 만. 첨부 디렉터리·`sweepAttachments` 를 건드리지 않는다(결정 12).
- 아바타 조건: 256KB(262,144 바이트) 이하, 정사각형, 한 변 64~512px. 브라우저는 256×256 webp(안 되면 png)로 만든다.
- 상태 모드 `auto`·`away`·`busy`·`dnd`·`invisible`, 기본 `auto`. 상태 메시지 글은 trim 뒤 1~100자, 이모지는 문자열 16 code unit 이하. `dnd_allow_approvals` 기본 true.
- 사람 유효 상태 순서(스펙 3.2): 비활성 → 없음 · invisible → offline · 소켓 없음(유예 20,000ms 뒤) → offline · away/busy/dnd → 그 값 · 보이는 탭 있음 → online · 그 밖 → away.
- 에이전트 유효 상태 순서(스펙 3.4): 보관 → 없음 · enabled=false → off · 연결 없음 → disconnected · 끝나지 않은 런 있음 → working · 그 밖 → available.
- 수동 모드·그 만료는 `Person`·`people.changed` 에 싣지 않는다 — invisible 이 새면 안 된다. 본인 것은 `/auth/me` 와 user 룸으로만.
- 방해 금지가 멈추는 것은 푸시(웹 푸시·APNs·FCM)뿐. 예외는 `payload.kind === "approval"` 이고 `dndAllowApprovals` 가 true 일 때.
- 에이전트 정보 공개: 모두 — 사진·이름·핸들·연결·`model`·`createdBy`·`dmAccess`·꺼짐·보관 / admin 이상 — `runnerAgent`(권한 모드·도구)·`basePrompt`(지금 규칙 그대로).
- 설정 탭 목록 `apps/web/src/features/settings-shell/tabs.ts` 를 바꾸지 않는다.
- 커밋은 경로를 명시해 stage, Conventional Commits(패키지 스코프 `feat(shared)`·`feat(server)`·`feat(web)`·`docs`), 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 코드를 쓴 뒤 `pnpm lint:fix`·`pnpm fmt`.
- `pnpm test` 는 typecheck·build 와 동시에 돌리지 않는다. 결과의 실행 개수를 보고에 적는다.

## Review Focus

1. **invisible 누출** — 「오프라인으로 보이기」인 사람이 `people.changed`·`presence.snapshot`·`presence.changed` 어디서도 진짜 오프라인과 구별되면 안 된다(만료 시각·`dnd` 표지 없음). 시험: 태스크 3·4.
2. **재접속 깜빡임** — 새로고침(소켓 끊김 → 1초 안에 다시 붙음)에 `presence.changed` 가 offline 을 내지 않아야 한다. 시험: 태스크 4 유예.
3. **만료가 지난 값** — 타이머가 돌기 전에 읽어도 지난 수동 모드·상태 메시지·방해 금지는 없는 것으로 읽혀야 한다(푸시 거르기 포함). 시험: 태스크 3·5.
4. **아바타 교체 경합** — 두 사람이 같은 그림을 올리고 한 사람이 바꾸면, 다른 사람의 파일은 남아야 한다(참조가 남은 파일은 지우지 않음). 시험: 태스크 6.
5. **남의 DM 런과 「작업 중」** — 에이전트가 남의 DM 에서만 돌 때도 점은 working 이지만 `presence.changed` 페이로드에 채널·대화·런 id 가 없어야 한다. 시험: 태스크 4.

---

### Task 1: 공유 계약 — 상태·접속 타입, Person·User·Agent 필드, wire 이벤트

**Files:**
- Create: `packages/shared/src/profile/index.ts`
- Modify: `packages/shared/src/index.ts`(내보내기), `packages/shared/src/members/index.ts`(`Person`), `packages/shared/src/domain/index.ts`(`User`·`Agent`), `packages/shared/src/wire/index.ts`(`ServerToClientEvents`)
- Test: `packages/shared/test/profile.test.ts`

**Interfaces:**
- Produces (`packages/shared/src/profile/index.ts`):
  - `StatusMode = z.enum(["auto","away","busy","dnd","invisible"])`
  - `StatusMessage = z.object({ emoji: z.string().min(1).max(16).nullable(), text: z.string().trim().min(1).max(100), until: IsoDateTime.nullable() })`
  - `MyStatus = z.object({ mode: StatusMode, modeUntil: IsoDateTime.nullable(), message: StatusMessage.nullable(), dndAllowApprovals: z.boolean() })`
  - `UpdateMyStatusBody = z.object({ mode: StatusMode, modeUntil: IsoDateTime.nullable(), message: StatusMessage.nullable(), dndAllowApprovals: z.boolean() }).partial()` + refine: `mode === "auto"` 이면서 `modeUntil` 이 null 이 아닌 값이면 실패
  - `UserPresenceState = z.enum(["online","away","busy","dnd","offline"])`, `AgentPresenceState = z.enum(["available","working","disconnected","off"])`
  - `PresenceEntry = z.discriminatedUnion("kind", [ z.object({ kind: z.literal("user"), id: Id, state: UserPresenceState.nullable(), until: IsoDateTime.optional(), dnd: z.object({ until: IsoDateTime.nullable() }).optional() }), z.object({ kind: z.literal("agent"), id: Id, state: AgentPresenceState.nullable() }) ])` — state null = 점 없음(비활성·보관)
  - `AvatarUrl = z.string().regex(/^(https:\/\/\S+|\/api\/v1\/avatars\/[0-9a-f]{64}\.(png|jpeg|webp))$/)`
  - `AVATAR_MAX_BYTES = 262_144`, `AVATAR_MIN_PX = 64`, `AVATAR_MAX_PX = 512`, `AVATAR_TARGET_PX = 256`
- Produces (기존 타입 변경): `Person.statusMessage: StatusMessage.nullable().default(null)`, `Person.avatarUrl: AvatarUrl.optional()`; `User.avatarUrl: AvatarUrl.optional()`; `Agent.avatarUrl: AvatarUrl.optional()`, `Agent.createdBy: Id.nullable().default(null)`, `Agent.model: z.string().nullable().default(null)`
- Produces (wire `ServerToClientEvents`): `"presence.snapshot": (p: { entries: PresenceEntry[] }) => void`(그 소켓에만), `"presence.changed": (p: { entries: PresenceEntry[] }) => void`(workspace 룸), `"me.status": (p: { status: MyStatus }) => void`(user 룸)

- [ ] **Step 1: 실패하는 시험** — `profile.test.ts`:
  - `UpdateMyStatusBody.safeParse({ mode: "auto", modeUntil: "2026-11-02T10:00:00.000Z" }).success === false`, `({ mode: "busy", modeUntil: null })` 는 true
  - `StatusMessage` 가 `text: "   "` 를 거절, 101자를 거절, 100자를 받음
  - `AvatarUrl` 이 `/api/v1/avatars/<64 hex>.webp` 와 `https://x/y.png` 를 받고 `/api/v1/avatars/../x`·`http://x`·`.gif` 를 거절
  - `PresenceEntry` 가 `{ kind: "agent", id, state: "working" }` 를 받고 `{ kind: "agent", id, state: "online" }` 을 거절
  - `Agent.parse` 에 `createdBy`·`model` 이 빠져도 null 로 채움
- [ ] **Step 2:** `pnpm -F @dodok/shared test -- profile` → FAIL(모듈 없음)
- [ ] **Step 3:** 위 Interfaces 대로 구현, `packages/shared/src/index.ts` 에서 내보낸다
- [ ] **Step 4:** `pnpm -F @dodok/shared test` PASS, `pnpm typecheck` — 서버·웹이 `Agent.avatarUrl` 타입 변경으로 깨지는 자리가 있으면 이 태스크에서 타입만 맞춘다(동작은 그대로)
- [ ] **Step 5: Commit** `feat(shared): profile status, presence and avatar contracts`

### Task 2: DB 마이그레이션·에이전트 소유자·공개 모델

**Files:**
- Modify: `apps/server/src/db/schema.sqlite.ts`(`users`·`agents` 열), `apps/server/src/modules/agents/service.ts`(`CreateAgentInput`·`createAgent`·`toApiAgent`), `apps/server/src/modules/agents/actions.ts`(`registerAgentAndNotify`·`createRunnerAgentAndNotify` 에 `createdBy`), `apps/server/src/modules/agents/routes.ts`(요청한 사람 id 넘기기), `apps/server/src/modules/control/handlers.ts`(`register_agent` 의 주체 사람), `apps/server/scripts/dev-fake.ts`(씨앗 `createAgent` 두 자리 — owner)
- Create: `apps/server/drizzle/0033_profiles_presence.sql`(`pnpm -F @dodok/server db:generate` 로 만든다 — 손으로 쓰지 않는다)
- Test: `apps/server/test/agents.service.test.ts`, `apps/server/test/control.service.test.ts`

**Interfaces:**
- Consumes: Task 1 `Agent.createdBy`·`Agent.model`
- Produces: `users` 열 `statusMode`(text, 기본 `"auto"`)·`statusModeUntil`(ts)·`statusEmoji`(text)·`statusText`(text)·`statusTextUntil`(ts)·`dndAllowApprovals`(integer boolean, 기본 true); `agents.createdBy`(text, users.id 참조, null 가능); `CreateAgentInput.createdBy: string | null`; `toApiAgent` 가 `createdBy` 와 `model`(러너 에이전트의 `runner_agents` 모델, OpenClaw 는 null)을 역할과 상관없이 싣는다

- [ ] **Step 1: 실패하는 시험**
  - `agents.service.test.ts`: `createAgent(db, {..., createdBy: ownerId})` → `toApiAgent` 결과 `createdBy === ownerId`; member 역할로 받은 러너 에이전트 응답에 `model` 이 있고 `runnerAgent` 는 없다
  - `control.service.test.ts`: 바깥 MCP(PAT) `register_agent` 로 만든 에이전트의 `createdBy` 가 토큰 주인
- [ ] **Step 2:** `pnpm -F @dodok/server test -- agents.service control.service` → FAIL
- [ ] **Step 3:** 스키마 열 추가 → `db:generate` 로 `0033_*.sql` 생성 → 만드는 길 넷(REST 둘·제어 도구·dev-fake)이 `createdBy` 를 채운다. 기존 행은 null 로 둔다(마이그레이션이 채우지 않는다)
- [ ] **Step 4:** 위 시험 PASS, `pnpm -F @dodok/server test -- dev-fake` PASS
- [ ] **Step 5: Commit** `feat(server): agent owner and profile columns`

### Task 3: 상태 저장·REST·만료

**Files:**
- Create: `apps/server/src/modules/profile/status.ts`, `apps/server/src/modules/profile/routes.ts`
- Modify: `apps/server/src/modules/members/people.ts`(`listPeople` 에 `statusMessage`), `apps/server/src/auth/routes.ts`(`/api/v1/auth/me` 응답에 `status: MyStatus`), `apps/server/src/realtime/bus.ts`·`apps/server/src/realtime/events.ts`(`me.status` user 룸 팬아웃), `apps/server/src/app.ts`(라우트 등록·만료 타이머 시작과 `close` 에서 정지)
- Test: `apps/server/test/profile.status.test.ts`, `apps/server/test/people.test.ts`, `apps/server/test/roles.matrix.test.ts`

**Interfaces:**
- Consumes: Task 1 `MyStatus`·`UpdateMyStatusBody`·`StatusMessage`, Task 2 열
- Produces (`status.ts`):
  - `readMyStatus(db: DbOrTx, userId: string, now: Date): MyStatus` — 지난 `modeUntil`·`message.until` 은 `auto`·null 로 읽는다
  - `updateMyStatus(db: Db, userId: string, body: UpdateMyStatusBody, now: Date): { status: MyStatus; messageChanged: boolean; modeChanged: boolean }` — 과거 `modeUntil`·`message.until` 은 `VALIDATION`
  - `dndState(db: DbOrTx, userId: string, now: Date): { active: boolean; allowApprovals: boolean }`
  - `expireStatuses(db: Db, now: Date): { messageUserIds: string[]; modeUserIds: string[] }` — 지난 값을 DB 에서 지우고 바뀐 사람을 돌려준다
- Produces (REST): `PUT /api/v1/me/status`(세션, 본문 `UpdateMyStatusBody`) → `{ status: MyStatus }`; 성공 뒤 `me.status`(user 룸), `messageChanged` 면 `broadcastPeople`, `modeChanged` 면 Task 4 의 `presenceHub.recomputeUser(userId)`(Task 4 전에는 이 호출 자리를 콜백 인자로 둔다 — `onModeChanged?: (userId) => void`)
- 만료 타이머: 30,000ms 마다 `expireStatuses` → `messageUserIds` 있으면 `broadcastPeople` 한 번, 사람마다 `me.status`, `modeUserIds` 마다 `onModeChanged`

- [ ] **Step 1: 실패하는 시험** — `profile.status.test.ts`:
  - `PUT /me/status {mode:"busy", modeUntil: +1h}` → 200, `GET /auth/me` 의 `status.mode === "busy"`
  - `modeUntil` 이 과거 → 400 `VALIDATION`
  - 시계를 만료 뒤로 → `readMyStatus` 가 `auto`, `dndState(...).active === false`(타이머가 돌기 전에도)
  - 상태 메시지만 바꾸면 `people.changed` 한 번, 모드만 바꾸면 `people.changed` 없음
  - `people.test.ts`: `mode: "invisible"` 인 사람의 `listPeople` 줄에 모드·만료 키가 없다(`Object.keys` 로 단언)
  - `roles.matrix.test.ts`: `PUT /api/v1/me/status` 를 member·admin·owner 모두 200, 세션 없음 401
- [ ] **Step 2:** `pnpm -F @dodok/server test -- profile.status people roles.matrix` → FAIL
- [ ] **Step 3:** 구현(Interfaces 대로). 만료 타이머는 `unref()`
- [ ] **Step 4:** PASS
- [ ] **Step 5: Commit** `feat(server): user status and status message`

### Task 4: 접속 허브 — 유효 상태 계산·스냅숏·변화 알림

**Files:**
- Create: `apps/server/src/modules/presence/compute.ts`(순수 계산), `apps/server/src/modules/presence/hub.ts`(이전 값 기억·변화만 알림·유예 타이머)
- Modify: `apps/server/src/modules/push/presence.ts`(`socketsOf(userId): { count: number; anyVisible: boolean }` 와 변화 콜백 `onChange?: (userId: string) => void` 추가 — 기존 `isWatching` 은 그대로), `apps/server/src/realtime/socket.ts`(connection 때 그 소켓에 `presence.snapshot`), `apps/server/src/realtime/events.ts`·`apps/server/src/realtime/bus.ts`(`presence.changed` workspace 룸), `apps/server/src/app.ts`(허브를 만들고 bus `run.state`·`adapter.status`·`agents.changed`·`people.changed` 에 붙임)
- Test: `apps/server/test/presence.compute.test.ts`, `apps/server/test/presence.hub.test.ts`, `apps/server/test/push.presence.test.ts`

**Interfaces:**
- Consumes: Task 1 `PresenceEntry`, Task 3 `readMyStatus`
- Produces (`compute.ts`):
  - `userPresence(f: { deactivated: boolean; mode: StatusMode; modeUntil: string | null; dnd: { until: string | null } | null; sockets: number; anyVisible: boolean; inGrace: boolean }): PresenceEntry & { kind: "user" }` 의 `state`·`until`·`dnd` 부분 — Global Constraints 의 순서 그대로. `invisible` 이면 `until`·`dnd` 를 싣지 않는다. `dnd` 는 모드가 dnd 이면 오프라인이어도 싣는다
  - `agentPresence(f: { archived: boolean; enabled: boolean; connected: boolean; working: boolean }): AgentPresenceState | null`
- Produces (`hub.ts`): `createPresenceHub(deps: { db: Db; workspaceId: string; presence: Presence; connectedAgentIds: () => ReadonlySet<string>; workingAgentIds: () => ReadonlySet<string>; emit: (entries: PresenceEntry[]) => void; graceMs?: number; now?: () => Date }): { snapshot(): PresenceEntry[]; recomputeUser(userId: string): void; recomputeAgents(): void; recomputeAll(): void; close(): void }`
  - `connectedAgentIds`: OpenClaw 는 그 Gateway 의 `bridge === "connected"`(`gatewaySetupDetails`), 러너는 묶인 토큰이 지금 붙은 러너 토큰 id 에 있음(`registry.forProvider("runner")?.setupDetail()`) — app.ts 가 만든다
  - `workingAgentIds`: 끝나지 않은 런(`TERMINAL` 밖 상태)의 `agentId` 집합 — DB 조회
  - `emit` 은 이전 값과 다른 항목만, 하나 이상일 때만
- 유예: `socketsOf(userId).count` 가 0 이 되면 `graceMs`(기본 20,000) 뒤에 다시 계산한다. 그 안에 다시 붙으면 offline 을 내지 않는다

- [ ] **Step 1: 실패하는 시험**
  - `presence.compute.test.ts`: Global Constraints 의 사람 순서 여섯 줄 각각 한 사례 + `invisible` 이면 `until`·`dnd` 키 없음 + dnd·소켓 0 → `state: "offline", dnd: { until }`; 에이전트 다섯 줄 각각
  - `presence.hub.test.ts`(가짜 시계·가짜 `emit`): 소켓 끊김 → 1,000ms 뒤 재접속 → `emit` 에 offline 없음; 끊김 → 20,001ms → `emit([{kind:"user", id, state:"offline"}])`; 같은 값 재계산은 `emit` 안 부름; 남의 DM 런으로 working 이 될 때 항목 키가 `kind`·`id`·`state` 셋뿐
  - `push.presence.test.ts`: `socketsOf` 가 두 탭(하나 숨김)에서 `{ count: 2, anyVisible: true }`
- [ ] **Step 2:** FAIL 확인
- [ ] **Step 3:** 구현. socket.ts 의 connection 처리기에서 방 참가 뒤 `socket.emit("presence.snapshot", { entries: hub.snapshot() })`; `presence.update`·`disconnect` 가 `Presence.onChange` 로 허브를 부른다
- [ ] **Step 4:** PASS, `pnpm -F @dodok/server test -- push` 기존 시험도 PASS
- [ ] **Step 5: Commit** `feat(server): presence hub for people and agents`

### Task 5: 방해 금지 푸시 거르기

**Files:**
- Modify: `apps/server/src/modules/push/service.ts`(`createPushDispatcher` deps 에 `dnd: (userId: string) => { active: boolean; allowApprovals: boolean }`, `forUser` 에서 `isWatching` 다음에 거름), `apps/server/src/app.ts`(Task 3 `dndState` 를 넘김)
- Test: `apps/server/test/push.service.test.ts`

**Interfaces:**
- Consumes: Task 3 `dndState`

- [ ] **Step 1: 실패하는 시험** — `push.service.test.ts`:
  - dnd 활성·`allowApprovals: true` → `mention` 은 전송 0, `approval` 은 전송 1
  - dnd 활성·`allowApprovals: false` → `approval` 도 전송 0
  - dnd 비활성 → 지금과 같음
  - 걸렀을 때 debug 로그 메시지가 `"push skipped — dnd"`
- [ ] **Step 2:** FAIL → **Step 3:** 구현 → **Step 4:** PASS
- [ ] **Step 5: Commit** `feat(server): do-not-disturb skips push`

### Task 6: 아바타 저장·REST·백업

**Files:**
- Create: `apps/server/src/modules/profile/avatars.ts`(파일 쓰기·참조 세기·부팅 청소), `apps/server/src/modules/profile/avatar-routes.ts`
- Modify: `apps/server/src/modules/ops/limits.ts`(`avatarUploadPerMin: 10` — `LIMITS` 와 `Limits` 둘 다), `apps/server/src/backup.ts`(`SIDE_DIRS` 에 `"avatars"`), `apps/server/src/app.ts`(라우트·부팅 청소), `apps/server/src/modules/agents/actions.ts`(아바타 바꾼 뒤 `agents.changed`)
- Test: `apps/server/test/avatars.routes.test.ts`, `apps/server/test/backup.test.ts`, `apps/server/test/roles.matrix.test.ts`

**Interfaces:**
- Consumes: Task 1 `AVATAR_*`·`AvatarUrl`
- Produces:
  - `saveAvatar(dir: string, bytes: Buffer): Promise<{ url: string }>` — 형식 검사(`sniff.ts` 로 png·jpeg·webp 만), 크기·정사각형·64~512px(`image-size`), `<sha>.<ext>` 로 쓰고 url `/api/v1/avatars/<sha>.<ext>`. 어기면 `VALIDATION`(문구에 어긴 조건)
  - `releaseAvatar(db: DbOrTx, dir: string, url: string | null): Promise<void>` — `users.avatar_url`·`agents.avatar_url` 어디서도 안 가리키면 파일 삭제
  - `sweepAvatars(db: DbOrTx, dir: string): Promise<number>` — 부팅 때
  - REST: `PUT /api/v1/me/avatar`(세션, 본문 바이트 `image/png|jpeg|webp`) → `{ user: User }` + `people.changed`; `DELETE /api/v1/me/avatar` → `{ user }`; `PUT`·`DELETE /api/v1/agents/:id/avatar`(지금 `PATCH /agents/:id` 와 같은 정책 `authorizeAgentPatch`) → `{ agent: Agent }` + `agents.changed`; `GET /api/v1/avatars/:file`(세션) — `Cache-Control: private, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff`, 형식에 맞는 `Content-Type`, 없는 파일 404
  - 순서: 파일 쓰기 성공 → 행 갱신 → 옛 url `releaseAvatar`. 쓰기 실패면 행을 바꾸지 않는다

- [ ] **Step 1: 실패하는 시험** — `avatars.routes.test.ts`:
  - 256×256 png 올림 → 200, `user.avatarUrl` 이 `/api/v1/avatars/<64hex>.png`, 그 GET 이 같은 바이트·헤더 셋
  - 300×200 → 400 문구에 「정사각형」, 32×32 → 400, 262,145 바이트 → 400, gif 바이트 → 400
  - 두 사람이 같은 그림 → 한 사람이 다른 그림으로 바꿈 → 처음 파일 GET 이 여전히 200
  - 한 사람만 쓰던 그림을 DELETE → 파일 GET 404
  - 부팅 청소: 어느 행도 안 가리키는 파일을 두고 `sweepAvatars` → 지워짐, 가리키는 파일은 남음
  - 분당 11번째 업로드 → 429
  - `backup.test.ts`: 백업 결과에 `avatars/<파일>` 이 있다
  - `roles.matrix.test.ts`: 에이전트 아바타 PUT 은 member 403, admin 200; `/me/avatar` 는 모두 200; `GET /avatars/:file` 세션 없음 401
- [ ] **Step 2:** FAIL → **Step 3:** 구현 — 바이트 본문은 이 라우트에만 `image/png`·`image/jpeg`·`image/webp` content-type 파서(Buffer, `bodyLimit` = `AVATAR_MAX_BYTES`)를 등록한다. 상한을 넘는 본문은 Fastify 413 이 아니라 400 `VALIDATION` 으로 답한다 → **Step 4:** PASS
- [ ] **Step 5: Commit** `feat(server): avatar upload for people and agents`

### Task 7: 웹 — 접속 저장소와 아바타 점

**Files:**
- Create: `apps/web/src/features/presence/store.ts`, `apps/web/src/features/presence/PresenceDot.tsx`
- Modify: `apps/web/src/realtime/handlers.ts`(`presence.snapshot`·`presence.changed`·`me.status`), `apps/web/src/features/messages/MessageItem.tsx`, `apps/web/src/features/dms/DmSection.tsx`, `apps/web/src/features/settings/MembersSection.tsx`(아바타 옆 점)
- Test: `apps/web/src/features/presence/presence.test.tsx`, `apps/web/test/fakeSocket.ts`(새 이벤트를 흉내 낼 수 있게 필요하면)

**Interfaces:**
- Consumes: Task 1 `PresenceEntry`·`MyStatus`
- Produces: `usePresence(kind: "user" | "agent", id: string): PresenceEntry | undefined`; `applySnapshot(entries)`(통째로 바꿈)·`applyChanged(entries)`(합침); `<PresenceDot entry={...} size="sm" | "lg" />` — 색: online 초록 · away 노랑 · busy 보라 · dnd 빨강 · offline 회색 · available 초록 · working 파랑 · disconnected 회색 · off 회색 테두리, state null 이면 그리지 않음. `aria-label` 은 한국어 상태 이름(접속 중·자리 비움·다른 용무 중·방해 금지·오프라인·응답 가능·작업 중·연결 끊김·꺼짐)
- `me.status` 는 TanStack Query `qk.me` 캐시의 `status` 를 바꾼다

- [ ] **Step 1: 실패하는 시험** — 스냅숏 뒤 changed 하나가 그 항목만 바꾸고 나머지를 남긴다; 재연결 스냅숏이 사라진 항목을 지운다; `PresenceDot` 의 `aria-label` 이 「다른 용무 중」; state null 이면 렌더 없음
- [ ] **Step 2:** `pnpm -F @dodok/web test -- presence` FAIL → **Step 3:** 구현 → **Step 4:** PASS
- [ ] **Step 5: Commit** `feat(web): presence store and dots`

### Task 8: 웹 — 프로필 패널

**Files:**
- Create: `apps/web/src/features/profile/ProfilePanel.tsx`, `apps/web/src/features/profile/PersonProfile.tsx`, `apps/web/src/features/profile/AgentProfile.tsx`, `apps/web/src/features/profile/openProfile.ts`
- Modify: `apps/web/src/app/router.tsx`(경로 `/c/$channelId/s/$conversationId/p/$kind/$id`, `kind` 는 `u`·`a`), `apps/web/src/app/layout/PanelTabs.tsx`(`PanelTab` 에 `"profile"` — 스레드처럼 열린 동안만 머리에), `apps/web/src/features/messages/MessageItem.tsx`(작성자 이름·아바타 누르면 열기), `apps/web/src/features/messages/MentionChip.tsx`, `apps/web/src/features/settings/MembersSection.tsx`·`apps/web/src/features/settings/AgentMemberRow.tsx`, `apps/web/src/features/dms/DmHeader.tsx`
- Test: `apps/web/src/features/profile/profile.test.tsx`, `apps/web/src/app/router.test.tsx`

**Interfaces:**
- Consumes: Task 7 `usePresence`·`PresenceDot`, 기존 `useMe`·사람 목록·에이전트 목록 쿼리
- Produces: `openProfile(navigate, params: { channelId: string; conversationId: string }, target: { kind: "user" | "agent"; id: string }): void`

- [ ] **Step 1: 실패하는 시험** — `profile.test.tsx`:
  - member 로 러너 에이전트 패널 → 연결·모델·소유자(`@핸들`)·DM 허용이 보이고 「권한」·「허용 도구」·「기본 프롬프트」가 없다; admin 으로는 보인다
  - `createdBy: null` → 「기록 없음」
  - 사람 패널에 상태 메시지(이모지 + 글), 방해 금지면 「방해 금지 중」 줄, admin 에게만 이메일
  - 내 패널에만 「상태 바꾸기」 단추
  - 비활성 멤버 → 「비활성」, 점 없음
  - 「DM 열기」는 `dmAccess` 로 열 수 없는 사람에게 없다
  - `router.test.tsx`: `/c/<ch>/s/<cv>/p/u/<id>` 직접 열기·새로고침이 패널을 그린다, 모르는 `kind` 는 「찾을 수 없습니다」
- [ ] **Step 2:** FAIL → **Step 3:** 구현(좁은 화면은 기존 패널과 같은 시트) → **Step 4:** PASS
- [ ] **Step 5: Commit** `feat(web): profile panel for people and agents`

### Task 9: 웹 — 「내 계정」 프로필 섹션과 에이전트 아바타

**Files:**
- Create: `apps/web/src/features/account/ProfileSection.tsx`, `apps/web/src/features/account/StatusForm.tsx`(내 패널 「상태 바꾸기」도 이것을 쓴다), `apps/web/src/features/account/avatarImage.ts`(가운데 정사각형 자르기 → 256px webp, 안 되면 png), `apps/web/src/features/account/AvatarPicker.tsx`(사람·에이전트 공용)
- Modify: `apps/web/src/features/account/mutations.ts`(`useUpdateMyStatus`·`useUploadMyAvatar`·`useRemoveMyAvatar`), `apps/web/src/features/settings-shell/AccountPage.tsx`(표시 이름 칸을 프로필 섹션 안으로), `apps/web/src/features/agents/AgentRow.tsx`(admin 이상 — 에이전트 사진 바꾸기), `apps/web/src/features/agents/mutations.ts`, `apps/web/src/features/profile/PersonProfile.tsx`(「상태 바꾸기」가 `StatusForm` 을 연다), `apps/web/src/features/profile/AgentProfile.tsx`(admin 이상 — `AvatarPicker` 로 사진 바꾸기)
- Test: `apps/web/src/features/settings-shell/AccountPage.test.tsx`, `apps/web/src/features/account/avatarImage.test.ts`

**Interfaces:**
- Consumes: Task 1 `UpdateMyStatusBody`·`AVATAR_TARGET_PX`, Task 3·6 REST
- Produces: `cropToSquare(file: Blob, size = AVATAR_TARGET_PX): Promise<Blob>`; `expiryOf(choice: "never" | "30m" | "1h" | "4h" | "today" | { at: Date }, now: Date): string | null` — 「오늘」은 브라우저 시간대 자정

- [ ] **Step 1: 실패하는 시험**
  - `avatarImage.test.ts`: `expiryOf("today", 2026-11-02T15:00 로컬)` 이 같은 날 24:00 로컬의 ISO, `expiryOf("never")` null
  - `AccountPage.test.tsx`: 상태 「다른 용무 중」+「1시간」 저장 → `PUT /me/status` 본문 `{ mode: "busy", modeUntil: <+1h> }`; 상태 메시지 101자 입력은 저장 불가; 「도구 승인 요청은 계속 받기」가 member 에게도 보이고 기본 체크됨; 서버 400(형식) 문구가 섹션 안에 보인다
- [ ] **Step 2:** FAIL → **Step 3:** 구현(이모지는 짧은 목록에서 고르기 + 직접 입력) → **Step 4:** PASS
- [ ] **Step 5: Commit** `feat(web): profile section, status form and avatar upload`

### Task 10: 문서와 `dev:fake` 브라우저 확인

**Files:**
- Modify: `docs/manual/user-guide.md`(프로필·상태·방해 금지·아바타), `docs/guides/docker-deploy.md`(「백업」의 담는 것 목록과 「볼륨째 옮기기」의 데이터 목록에 `avatars/`), `docs/guides/plan.md`(8장 「다음 순서 — 실사용」 ② 아래에 이 하위 프로젝트 완료 줄 — 스펙·계획 경로·확인 방법), `docs/superpowers/specs/2026-11-02-profiles-presence-design.md`(구현과 달라진 것이 있으면 끝에 「구현과 맞춘 것」 장)

- [ ] **Step 1:** `pnpm test`(혼자) · `pnpm typecheck` · `pnpm lint` · `pnpm fmt:check` — 실행 개수를 적는다
- [ ] **Step 2:** `pnpm -F @dodok/server dev:fake` + `pnpm -F @dodok/web dev`, http://localhost:5173 에서 owner 와 `mia`(member) 두 창으로: 서로의 점이 보임 · 한 창의 탭을 숨기면 자리 비움 · `mia` 가 「오프라인으로 보이기」 → owner 창에 오프라인 · 방해 금지 + 멘션 → 서버 debug 로그 `push skipped — dnd` · `POST /__devfake/runner {connected:false}` → `coder` 점 「연결 끊김」 · `coder` 멘션 → 「작업 중」 → 끝나면 「응답 가능」 · 사진 올리기 → 다른 창 타임라인에 바로 · member 의 에이전트 패널에 권한·도구 없음. 연 탭은 닫는다
- [ ] **Step 3:** 문서 갱신 — `---` 앞 빈 줄과 표 줄을 눈으로 본다
- [ ] **Step 4: Commit** `docs: profiles and presence`
