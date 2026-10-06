# 자동화(예약·웹훅) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`CLAUDE.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나. 태스크마다 main 에 병합해도 초록이어야 한다.

**Goal:** admin 이 만든 자동화가 예약 시각이나 들어오는 웹훅에 맞춰 정한 채널에 정한 문구를 게시하고, 문구의 에이전트 @멘션이 기존 라우터로 멘션 런을 시작한다.

**Architecture:** 새 표 `automations` 와 서버 모듈 `modules/automations/`(저장소·다음 시각 계산·스케줄러·웹훅 수신·관리 API). 게시는 새 작성자 타입 `automation` 의 보통 메시지이고, 라우터에 「멘션만」 분기를 더한다. 스케줄러는 다른 주기 작업처럼 `app.ts` 의 60초 틱, 웹훅은 공개 경로 `POST /hooks/<token>`(해시 저장·실패 카운터·토큰별 레이트). 에이전트에게 보낸 사람은 `system:automation` 꼴이라 플러그인·러너 CLI 는 바뀌지 않는다.

**Tech Stack:** Fastify 5 · drizzle-orm 0.45 + better-sqlite3 · zod 4 · `Intl.DateTimeFormat`(시간대) · React 19 + TanStack Router/Query. **새 의존성 없음.**

**Spec:** `docs/superpowers/specs/2026-10-05-automations-design.md` — 결정 0장, 데이터 모델 2장, 다음 시각 3장, 실행 4장, 웹훅 5장, 관리 API 6장, 웹 7장, 권한 8장, 오류 9장, 검증·완료 10장. **태스크를 시작하기 전에 스펙의 해당 장을 읽는다.**

## Global Constraints

- 자동화 = 트리거(`schedule`·`webhook`) + 채널 최상위 메시지 게시 하나. 작성자 `authorType "automation"`, `authorId` = 자동화 id, `kind "normal"`.
- 게시는 `assertChannelWritable` 을 지난다 — 보관한 채널이면 `CHANNEL_ARCHIVED`(예약: `error`·사건, 웹훅: 409, 만들기·채널 바꾸기: 거절).
- 자동화 글은 **멘션으로만** 런을 만든다 — 자동 응답·스레드 응답자로 넘어가지 않는다. 런은 RunGate 를 지난다. 한도에 막혀도 메시지는 게시한다.
- 에이전트 인바운드의 보낸 사람은 `{ type: "system", handle: "automation", displayName: "자동화 <이름>" }`(지운 자동화면 `"자동화"`). 플러그인·러너 CLI 변경 없음.
- 예약: `daily`·`weekdays`(월~금)·`weekly`(`weekday` 0 = 일요일)·`hourly`(`minute`), 시각 `HH:MM`, 시간대는 워크스페이스 설정 `timeZone`(기본 `Asia/Seoul`). 놓친 예약은 **10분 이내면 한 번**, 넘으면 `skipped` + 운영 사건 `automation_skipped`.
- 웹훅: `POST /hooks/<token>`, 토큰 `whk_` + `randomBytes(32).base64url`, sha256 만 저장, 원문은 발급·재발급 응답 한 번. 틀린 토큰·꺼짐·예약 종류는 **모두 404**. 본문 64 KiB(넘으면 413), 블록 8,000자(`…(잘림)`), 토큰마다 분당 `LIMITS.webhookPerMin = 30`(429), 실패 카운터는 기존 `BridgeAuthGuard`. 응답 `202 { messageId }`.
- 관리 API·시간대 설정은 admin 이상(member 403). 이름 1~40자 워크스페이스 유일(`CONFLICT`), 문구 1~4,000자.
- 레이트리밋 숫자는 `apps/server/src/modules/ops/limits.ts` 한곳.
- 외부 입력(HTTP 본문·쿼리·웹훅 본문)은 경계에서 Zod 파싱(웹훅 원문은 문자열로만 다루고 실행하지 않는다). shared 는 Node 전용 API 금지.
- 웹 문구는 합쇼체: 「자동화」, 「⚙ 자동화 · <이름>」, 「⚙ 지운 자동화」, 「이 주소는 다시 볼 수 없습니다」, 「문구의 @<핸들> 이 이 채널에 없습니다」, 「지금 실행」.
- **읽지 않음과의 얽힘**: 읽지 않음 계획(`docs/superpowers/plans/2026-10-05-unread.md`)이 먼저 병합돼 있으면 태스크 2 가 `channel.activity` 조건과 `ChannelActivity.authorType` 에 `automation` 을 넣는다(`authorId` 는 자동화 id). 이 계획이 먼저면 읽지 않음 계획이 넣는다.
- 마이그레이션 번호는 다른 계획(읽지 않음·리액션)과 겹칠 수 있다 — 먼저 병합된 쪽이 앞 번호, 나중 쪽은 rebase 뒤 generate 를 다시 돌린다.
- 포트 5173·3000 금지(사용자 인스턴스 3100·5180 도 건드리지 않는다 — 워커는 브리프가 주는 포트). 프로세스는 자기 PID 로만, `pkill` 금지. Docker `prune` 금지. **모델 런 없음.**
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프. 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 생성물(drizzle SQL·meta)은 `pnpm -F @dodok/server db:generate`.
- 문서·주석을 쓰기 전에 `docs/guideline/base/03-comments.md`·`04-citation.md` 를 읽는다.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 자기 실행 출력에서 패키지별로(0개는 통과가 아니다). 웹을 바꿨으면 `pnpm -F @dodok/web build`, 서버를 바꿨으면 `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`.

## 계획 판정 (스펙과 맞춘 것)

태스크 5 가 스펙에 「구현과 맞춘 것」 장을 만들어 옮긴다.

- **PA1 — 문구는 평문 `@핸들` 로 저장하고 게시할 때 토큰화한다.** 사람 메시지가 그렇다(`createUserMessage` 가 저장 전에 `tokenize(bodyMd, userMessageParticipants(…))`). 스펙의 「작성기와 같은 멘션 토큰」은 「작성기가 보내는 것과 같은 평문 `@핸들`」로 읽는다 — 핸들이 바뀌면 게시 때 새 핸들로 풀리지 않으므로 목록 경고 줄이 그것도 알린다.
- **PA2 — 웹훅 URL 의 오리진은 `bridgePublicUrl(config)`(`apps/server/src/modules/setup/status.ts`)의 오리진을 http(s) 로 바꾼 것**이다(러너 `serverUrl` 과 같은 규칙 — `apps/server/src/modules/runners/routes.ts`). 형태 `<origin>/hooks/<token>`.
- **PA3 — 스케줄러의 「한 번만」은 조건부 UPDATE** — `UPDATE automations SET next_run_at = :next, last_run_at = :now WHERE id = :id AND next_run_at = :seen` 의 변경 행 수가 1 일 때만 게시한다.
- **PA4 — 시간대 변경은 `patchOpsSettings` 뒤 같은 요청에서** 켜진 예약 자동화의 `next_run_at` 을 모두 다시 계산한다(`modules/ops/routes.ts` 의 설정 PATCH 처리기 — 자동화 서비스의 `rescheduleAll(db, workspaceId, now)` 를 부른다).
- **PA5 — 웹훅 경로는 `/api` 밖**이라 사용자 REST 상한(`requireSession`)을 타지 않는다. Fastify 라우트 옵션 `bodyLimit: 64 * 1024` 와 `addContentTypeParser('*', { parseAs: 'string' })` 를 그 라우트 범위(플러그인 캡슐화)에만 둔다 — 다른 경로의 파서에 영향이 없게.

## Review Focus

1. **서버가 09:05 에 켜짐 — 09:00 예약(5분 놓침)과 08:30 예약(35분 놓침)이 함께 있음** — 09:00 은 한 번 게시, 08:30 은 `skipped`·사건 하나, 둘 다 `next_run_at` 이 다음 날로. 재부팅을 연달아 두 번 해도 09:00 은 두 번 게시되지 않는다. → 태스크 2.
2. **웹훅 본문 안에 ```` ``` ```` 가 든 로그·마크다운** — 블록이 깨지지 않는다(펜스를 늘림). JSON 인데 `Content-Type: text/plain` 으로 옴 → 텍스트 블록. `Content-Type` 없음 → 텍스트 블록. → 태스크 3.
3. **자동화 문구의 에이전트가 나중에 채널에서 빠지거나 핸들이 바뀜** — 게시는 되고 런은 없으며, 목록에 경고 줄이 뜬다. → 태스크 3(경고 계산)·4(표시).
4. **자동화를 끈 상태에서 시각을 바꾸고 다시 켬** — 켜는 순간의 `now` 로 다음 시각을 계산한다(과거 시각이 바로 터지지 않는다). → 태스크 2.
5. **채널을 보관함 / 자동화를 지움** — 보관한 채널의 예약은 게시하지 않고 `error`·`automation_failed`(code `CHANNEL_ARCHIVED`)·다음 시각으로 넘어가며 스케줄러가 죽지 않는다, 웹훅은 409, 목록 경고 「채널이 보관되었습니다」. 자동화 삭제 뒤 그 메시지는 「⚙ 지운 자동화」로 보이고, 그 메시지가 최근 대화 문맥에 실릴 때 서버가 죽지 않는다(보낸 사람 `"자동화"`). → 태스크 2(문맥)·4(표시).

각 줄의 테스트는 해당 태스크의 단계에 들어 있다.

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `packages/shared/src/automations/index.ts`(새)·`domain/index.ts`·`ops/index.ts`·`index.ts` | 1 | `AutomationSchedule`·`CreateAutomationBody`·`UpdateAutomationBody`·`AutomationSummary`·`authorType "automation"`·`OpsSettings.timeZone` |
| `apps/server/src/db/schema.sqlite.ts`·`drizzle/00xx_*` | 1 | `automations` 표 |
| `apps/server/src/modules/automations/{schedule,store,tokens}.ts`(새) | 1 | `nextRunAt`, 저장소, 웹훅 토큰 |
| `apps/server/src/modules/messages/service.ts`·`modules/runs/context.ts`·`modules/router/decide.ts`·`modules/push/triggers.ts` | 2 | `createAutomationMessage`, 인바운드 작성자, 라우터 분기, 푸시 |
| `apps/server/src/modules/automations/{post,scheduler}.ts`(새)·`app.ts`·`modules/ops/*` | 2 | 게시·틱·사건·시간대 설정 |
| `apps/server/src/modules/automations/{routes,webhook,body}.ts`(새)·`modules/ops/limits.ts`·`infra/Caddyfile`·`infra/check-caddy.sh` | 3 | 관리 API·웹훅 엔드포인트·본문 변환 |
| `apps/web/src/features/automations/*`(새)·`features/messages/useAuthors.ts`·설정 사이드바·`features/ops/*` | 4 | 설정 화면·작성자 표시·시간대 |
| 문서 | 5 | 검증·문서 |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 계약·표·다음 시각·저장소 | — |
| B | 2 게시·라우터·스케줄러 | 1 |
| C | 3 관리 API·웹훅 | 2 |
| D | 4 웹 | 3 |
| E | 5 검증·문서 | 4 |

---

### Task 1: 계약·표·다음 시각·저장소

**Files:**
- Create: `packages/shared/src/automations/index.ts`; Modify: `packages/shared/src/domain/index.ts`(`Message.authorType` 에 `"automation"`), `packages/shared/src/ops/index.ts`(`OpsSettings.timeZone`·`OpsSettingsPatch.timeZone`), `packages/shared/src/index.ts`
- Modify: `apps/server/src/db/schema.sqlite.ts`; Create(생성기): `apps/server/drizzle/00xx_*`
- Create: `apps/server/src/modules/automations/schedule.ts`, `store.ts`, `tokens.ts`
- Test: `packages/shared/test/automations.test.ts`(새), `apps/server/test/automations.schedule.test.ts`(새), `automations.store.test.ts`(새)

**Interfaces:**
- Produces(shared):

```ts
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const AutomationSchedule = z.discriminatedUnion("repeat", [
  z.object({ repeat: z.literal("daily"), time: HHMM }),
  z.object({ repeat: z.literal("weekdays"), time: HHMM }),
  z.object({ repeat: z.literal("weekly"), weekday: z.int().min(0).max(6), time: HHMM }),
  z.object({ repeat: z.literal("hourly"), minute: z.int().min(0).max(59) }),
]);
export const AutomationName = z.string().trim().min(1).max(40);
export const CreateAutomationBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), name: AutomationName, channelId: Id, bodyMd: z.string().min(1).max(4000), schedule: AutomationSchedule, enabled: z.boolean().default(true) }),
  z.object({ kind: z.literal("webhook"), name: AutomationName, channelId: Id, bodyMd: z.string().min(1).max(4000), enabled: z.boolean().default(true) }),
]);
export const UpdateAutomationBody = z.object({
  name: AutomationName.optional(), channelId: Id.optional(), bodyMd: z.string().min(1).max(4000).optional(),
  schedule: AutomationSchedule.optional(), enabled: z.boolean().optional(),
});
export const AutomationSummary = z.object({
  id: Id, name: z.string(), channelId: Id, kind: z.enum(["schedule", "webhook"]), bodyMd: z.string(), enabled: z.boolean(),
  schedule: AutomationSchedule.optional(), nextRunAt: IsoDateTime.optional(), tokenPrefix: z.string().optional(),
  lastRunAt: IsoDateTime.optional(), lastStatus: z.enum(["ok", "skipped", "error"]).optional(),
  warnings: z.array(z.object({ kind: z.enum(["agent_not_in_channel", "agent_disabled", "unknown_handle", "channel_archived"]), handle: z.string().optional() })),
});
export const AutomationCreated = z.object({ automation: AutomationSummary, webhookUrl: z.url().optional() });
```

  `OpsSettings.timeZone: z.string()`(기본 `"Asia/Seoul"`), `OpsSettingsPatch.timeZone: z.string().optional()`.
- Produces(서버):

```ts
// schedule.ts — after 보다 엄격히 뒤인 가장 이른 순간. 없는 벽시계 시각은 그 뒤 첫 유효 순간, 두 번 있는 시각은 첫 번째
export function nextRunAt(schedule: AutomationSchedule, timeZone: string, after: Date): Date;
export function assertTimeZone(timeZone: string): void; // 틀리면 VALIDATION
// tokens.ts — 브리지 토큰(modules/setup/tokens.ts)과 같은 규칙, 접두사 whk_
export function issueWebhookToken(): { raw: string; hash: string; prefix: string };
export function findWebhookByToken(db: DbOrTx, raw: string): AutomationRow | undefined; // timingSafeEqual
// store.ts
export type AutomationRow = typeof automations.$inferSelect;
export function listAutomations(db: DbOrTx, workspaceId: string): AutomationRow[];
export function getAutomation(db: DbOrTx, workspaceId: string, id: string): AutomationRow | undefined;
export function insertAutomation(db: DbOrTx, row: typeof automations.$inferInsert): AutomationRow; // 이름 겹침 CONFLICT
export function updateAutomation(db: DbOrTx, workspaceId: string, id: string, patch: Partial<typeof automations.$inferInsert>): AutomationRow;
export function deleteAutomation(db: DbOrTx, workspaceId: string, id: string): void;
export function dueSchedules(db: DbOrTx, now: Date): AutomationRow[];
export function claimRun(db: DbOrTx, id: string, seen: Date, next: Date, now: Date): boolean; // PA3
```

- [ ] **Step 1: 실패하는 테스트 — shared.** 이름 0자·41자 거절, `HHMM` `24:00`·`9:00` 거절, `weekly` 에 `weekday` 없음 거절, `hourly` 에 `time` 만 있음 거절, 문구 4,001자 거절, `Message` 가 `authorType "automation"` 을 받음.
- [ ] **Step 2: 실패하는 테스트 — 다음 시각.** `automations.schedule.test.ts`:
  - `Asia/Seoul`: daily 09:00 — `after` 08:59 → 같은 날 09:00, `after` 09:00 정각 → 다음 날 09:00.
  - weekdays — 금 10:00 뒤 → 월 09:00. weekly 일요일(0) — 수요일 뒤 → 그 주 일요일.
  - hourly minute 15 — 10:20 뒤 → 11:15.
  - 월말·연말: 12-31 23:30 daily 23:00 뒤 → 다음 해 01-01 23:00. 윤년 02-28 → 02-29.
  - `America/New_York` 서머타임: 봄 02:30 daily(없는 시각) → 그날 03:00(첫 유효 순간), 가을 01:30(두 번) → 첫 번째(EDT) 순간.
  - `assertTimeZone("Mars/Base")` → `VALIDATION`.
- [ ] **Step 3: 실패하는 테스트 — 저장소·토큰.** `automations.store.test.ts`: 이름 겹침 `CONFLICT` · 다른 워크스페이스 행 안 보임 · `dueSchedules` 는 켜진 예약만·`next_run_at <= now` 만 · `claimRun` 을 같은 `seen` 으로 두 번 → 처음 true, 다음 false · `issueWebhookToken` 원문이 `whk_` 로 시작하고 `hash` 는 64자 hex · `findWebhookByToken` 이 틀린 원문엔 `undefined`.
- [ ] **Step 4: 실패 확인.**
- [ ] **Step 5: 구현.** 스키마는 스펙 2.1 그대로(+ 인덱스 `automations_due` `(enabled, kind, next_run_at)`), `db:generate`. `nextRunAt`: `Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year, month, day, hour, minute, weekday })` 로 벽시계를 읽는 도우미와, 벽시계 → UTC 를 「추정 UTC 를 만들고 그 시간대 오프셋으로 한두 번 보정」해 구하는 도우미 둘로 짠다. 후보 날짜를 하루씩(매시간은 한 시간씩) 넘기며 반복 규칙에 맞고 `> after` 인 첫 순간을 돌려준다(상한 8일 — 넘으면 `INTERNAL`). `ops/index.ts` 의 설정 기본값과 `modules/ops/settings.ts` 의 읽기가 `timeZone` 을 채운다(없으면 `"Asia/Seoul"`).
- [ ] **Step 6: 통과 확인** — 실행 개수.
- [ ] **Step 7: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 8: 커밋** — `feat(shared): add automation contracts and workspace time zone`, `feat(server): store automations and compute next schedule times`.

---

### Task 2: 게시·라우터·스케줄러

**Files:**
- Modify: `apps/server/src/modules/messages/service.ts`(`createAutomationMessage`), `apps/server/src/modules/runs/context.ts`(작성자 꼴), `apps/server/src/modules/router/decide.ts`(분기), `apps/server/src/modules/push/triggers.ts`
- Create: `apps/server/src/modules/automations/post.ts`, `scheduler.ts`; Modify: `apps/server/src/app.ts`(틱·`AppDeps.automationTickMs`), `apps/server/src/modules/ops/routes.ts`(PA4), 운영 사건 종류(`automation_skipped`·`automation_failed` — 사건 kind 목록이 있는 shared `ops/index.ts`)
- (조건) 읽지 않음이 먼저 병합돼 있으면 `apps/server/src/realtime/events.ts`·shared `reads/index.ts`(Global Constraints)
- Test: `apps/server/test/automations.scheduler.test.ts`(새), `router.decide.test.ts`, `runs.context.test.ts`, `push.triggers.test.ts`, `messages.service.test.ts`, `ops.routes.test.ts`

**Interfaces:**
- Consumes: 태스크 1 의 저장소·`nextRunAt`·`claimRun`.
- Produces:

```ts
// messages/service.ts — 평문 @핸들을 사람 메시지와 같은 참가자 집합으로 토큰화(PA1). 최상위만
export function createAutomationMessage(db: Db, bus: ServerBus, input: { channelId: string; automationId: string; bodyMd: string }): Message;
// automations/post.ts
export type PostDeps = { db: Db; bus: ServerBus; route: (m: Message) => Promise<void>; logger: Logger };
export async function postAutomationMessage(deps: PostDeps, automation: AutomationRow, extraMd?: string): Promise<Message>;
// automations/scheduler.ts
export type SchedulerDeps = PostDeps & { ops: Pick<OpsService, "record">; timeZone: () => string };
export async function tick(deps: SchedulerDeps, now: Date): Promise<void>;
export function rescheduleAll(db: DbOrTx, workspaceId: string, timeZone: string, now: Date): void;
/** 켜진 예약이면 now 뒤 첫 회차, 꺼졌거나 웹훅이면 null 로 next_run_at 을 둔다 — 켜기·예약 변경·만들기가 부른다 */
export function rescheduleOne(db: DbOrTx, workspaceId: string, id: string, timeZone: string, now: Date): void;
export const MISSED_GRACE_MS = 10 * 60_000;
```

- [ ] **Step 1: 실패하는 테스트.**
  - `messages.service.test.ts`: `createAutomationMessage` 가 `authorType "automation"`·`authorId`·멘션 토큰화·`kind "normal"`·스레드 없음.
  - `router.decide.test.ts`: automation 메시지 — 활성 에이전트 멘션 둘 → `mention` 런 둘 · 멘션 없음 + `autoRespond` 에이전트 → 런 없음 · 멘션된 에이전트가 꺼짐 → 런 없음(폴백 없음).
  - `runs.context.test.ts`: automation 작성자가 트리거·최근 대화에 있을 때 `{ type: "system", handle: "automation", displayName: "자동화 <이름>" }` · **Review Focus 5**: 자동화 행을 지운 뒤에는 `displayName "자동화"`, 예외 없음.
  - `push.triggers.test.ts`: automation 메시지의 사람 멘션 → 그 사람에게 푸시.
  - `automations.scheduler.test.ts`(주입 시계, 가짜 `route`):
    - **Review Focus 1**: `now` 09:05, 09:00 예약과 08:30 예약 → 09:00 은 게시 1·`last_status ok`, 08:30 은 게시 0·`skipped`·사건 `automation_skipped` 1, 둘 다 `next_run_at` 다음 날. 같은 `now` 로 `tick` 을 두 번 → 게시 여전히 1.
    - 게시 중 예외(가짜 `route` 가 던지게 — 메시지는 저장된 뒤) → `last_status error`·사건 `automation_failed`, `next_run_at` 은 다음 회차.
    - 꺼진 자동화·웹훅 종류는 건드리지 않음.
    - **Review Focus 5**: 채널을 보관한 예약 → 게시 0·`last_status error`·사건 `automation_failed`(detail `code: "CHANNEL_ARCHIVED"`)·다음 시각으로.
    - **Review Focus 4**: 끈 상태에서 예약을 과거 시각으로 바꾸고 켬 → `next_run_at` 이 켜는 순간 뒤의 첫 회차(바로 게시되지 않음) — 켜기·예약 변경 경로의 `next_run_at` 계산은 태스크 3 의 API 가 부르는 `rescheduleOne`(이 태스크에서 store 옆에 만든다)으로.
    - `rescheduleAll`: 시간대를 바꾸면 켜진 예약 전부 다시 계산.
  - `ops.routes.test.ts`: 시간대 PATCH — 틀린 이름 `VALIDATION`, 맞으면 `rescheduleAll` 효과(다음 시각이 바뀜), member 403.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.**
  - `tick`:

```ts
export async function tick(deps: SchedulerDeps, now: Date): Promise<void> {
  for (const a of dueSchedules(deps.db, now)) {
    const seen = a.nextRunAt!;
    const next = nextRunAt(a.scheduleJson!, deps.timeZone(), now);
    if (!claimRun(deps.db, a.id, seen, next, now)) continue; // 다른 틱이 가져갔다
    if (now.getTime() - seen.getTime() > MISSED_GRACE_MS) {
      updateAutomation(deps.db, a.workspaceId, a.id, { lastStatus: "skipped" });
      deps.ops.record({ kind: "automation_skipped", key: `automation:${a.id}`, severity: "warn", detail: { automationId: a.id } });
      continue;
    }
    try {
      await postAutomationMessage(deps, a);
      updateAutomation(deps.db, a.workspaceId, a.id, { lastStatus: "ok" });
    } catch (err) {
      updateAutomation(deps.db, a.workspaceId, a.id, { lastStatus: "error" });
      deps.ops.record({ kind: "automation_failed", key: `automation:${a.id}`, severity: "error", detail: { automationId: a.id } });
      deps.logger.error({ automationId: a.id, errName: err instanceof Error ? err.name : typeof err }, "automation post failed");
    }
  }
}
```

  - `app.ts`: 첨부 정리와 같은 꼴 — 부팅 때 한 번, 이후 `deps.automationTickMs ?? 60_000` 마다, 겹쳐 돌지 않게(진행 중이면 건너뜀), 종료 단계에서 해제하고 진행 중 틱을 기다린다.
  - `decide.ts`: `authorType === "automation"` 이면 사람 분기의 「활성 멘션 → mention」 부분만 쓰고 폴백 단계는 건너뛴다.
- [ ] **Step 4: 통과 확인** — 실행 개수.
- [ ] **Step 5: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 6: 커밋** — `feat(server): post automation messages on schedule and route their mentions`.

---

### Task 3: 관리 API·웹훅 엔드포인트

**Files:**
- Create: `apps/server/src/modules/automations/routes.ts`, `webhook.ts`, `body.ts`; Modify: `apps/server/src/app.ts`(등록), `apps/server/src/modules/ops/limits.ts`(`webhookPerMin: 30`)
- Modify: `infra/Caddyfile`(`@backend` 에 `/hooks/*`), `infra/check-caddy.sh`(한 줄)
- Modify: 팀 스펙 「역할과 권한」 표
- Test: `apps/server/test/automations.routes.test.ts`(새), `automations.webhook.test.ts`(새), `automations.body.test.ts`(새), `apps/server/test/integration/automations.test.ts`(새), `roles.matrix.test.ts`

**Interfaces:**
- Consumes: 태스크 1·2.
- Produces:

```ts
// body.ts — 웹훅 원문 → 문구 아래 붙일 블록(스펙 5.1). 빈 본문이면 undefined
export function webhookBlock(raw: string, contentType: string | undefined): string | undefined;
export const WEBHOOK_BLOCK_MAX = 8000;
// routes.ts
export function registerAutomationRoutes(fastify: FastifyInstance, ctx: { auth: Auth; db: Db; workspaceId: string; post: PostDeps; publicOrigin: () => string; timeZone: () => string }): void;
// webhook.ts
export function registerWebhookRoute(fastify: FastifyInstance, ctx: { db: Db; post: PostDeps; guard: BridgeAuthGuard; limits: Pick<Limits, "webhookPerMin">; ops: Pick<OpsService, "record">; now: () => number; clientAddress: (req: FastifyRequest) => string }): void;
```

- [ ] **Step 1: 실패하는 테스트 — 본문.** `automations.body.test.ts`: JSON(`application/json; charset=utf-8`) → 2칸 들여쓰기 ```` ```json ```` · 깨진 JSON 인데 JSON 타입 → 텍스트 블록 · 텍스트 → ```` ``` ```` · **Review Focus 2**: 본문에 ```` ``` ```` 가 있으면 펜스가 ```` ```` ```` 로 늘어남 · JSON 이 `text/plain` 으로 옴·타입 없음 → 텍스트 블록 · 8,001자 → 8,000자 + `…(잘림)` · 빈 문자열 → `undefined`.
- [ ] **Step 2: 실패하는 테스트 — 관리 API.** `automations.routes.test.ts`: 만들기(예약) → `nextRunAt` 있음 · 만들기(웹훅) → `webhookUrl` 이 `<origin>/hooks/whk_…`(PA2), 목록에는 `tokenPrefix` 만 · 이름 겹침 409 · PATCH 로 끄기 → `nextRunAt` 없음, 켜기 → 지금 뒤 첫 회차 · 토큰 재발급 → 새 URL, 옛 해시 사라짐 · 「지금 실행」 → 메시지 게시, `nextRunAt` 그대로 · 삭제 → 목록에서 빠지고 메시지는 남음 · **Review Focus 3**: `warnings` — 문구의 `@dev` 가 채널에 없음 → `agent_not_in_channel`, 꺼짐 → `agent_disabled`, 없는 핸들 → `unknown_handle`.
- [ ] **Step 3: 실패하는 테스트 — 웹훅.** `automations.webhook.test.ts`: 맞는 토큰 → 202 `{messageId}`·블록이 붙은 메시지 · 틀린 토큰 404·실패 카운터 증가 · 꺼진 자동화 404 · 보관한 채널의 웹훅 409 `CHANNEL_ARCHIVED` · 예약 종류 토큰 404(예약은 토큰이 없으므로 이 경우는 재발급 뒤 옛 토큰으로 대신 확인) · 64 KiB + 1 → 413 · 분당 31번째 429·사건 `ratelimit` · 실패 카운터에 막힌 주소 → 429 · 세션 쿠키 없이도 통과(공개 경로).
- [ ] **Step 4: 실패하는 테스트 — 통합·역할.** `integration/automations.test.ts`(가짜 Gateway·플러그인): 예약 틱 → 메시지 → 멘션 런 → 인바운드 보낸 사람 `system:automation` · 웹훅 → 202 → 런 · 한도에 막혀도 게시·한도 알림 · 멘션 없는 문구 + 자동 응답 에이전트 → 런 없음. `roles.matrix.test.ts`: 관리 API 여섯 × admin 이상 허용·member 403·membership 없음 401.
- [ ] **Step 5: 실패 확인.**
- [ ] **Step 6: 구현.** 웹훅 라우트는 PA5 대로 캡슐화한 플러그인 안에서 `fastify.post("/hooks/:token", { bodyLimit: 64 * 1024 }, …)`. 순서: 실패 카운터 막힘 → 429 / `findWebhookByToken` 없음 → `guard.fail(addr)` 후 404 / 꺼짐·종류 다름 → 404 / 토큰 키 버킷(`KeyedLimiter` — `modules/ops/ratelimit.ts`) 초과 → 429 / `webhookBlock` → `postAutomationMessage` → `lastStatus ok`·`lastRunAt` → 202. Caddy 줄과 `check-caddy.sh` 의 「`/hooks/whk_nope` 는 서버로(404 JSON)」.
- [ ] **Step 7: 통과 확인** — 실행 개수.
- [ ] **Step 8: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 9: 커밋** — `feat(server): manage automations and accept webhooks that post to channels`, `chore(infra): route /hooks through Caddy`.

---

### Task 4: 웹 — 설정 화면·작성자 표시·시간대

**Files:**
- Create: `apps/web/src/features/automations/{AutomationsPage.tsx,AutomationDialog.tsx,WebhookUrlOnce.tsx,queries.ts}`; Modify: `apps/web/src/app/router.tsx`(설정 탭 `automations` — 에이전트·채널·멤버 탭과 같은 줄, admin 이상)·설정 탭 목록, `apps/web/src/features/messages/useAuthors.ts`, `apps/web/src/features/ops/*`(시간대 선택)
- Test: `apps/web/src/features/automations/automations.test.tsx`(새), `features/messages/people.test.tsx` 또는 작성자 표시 테스트, `features/ops/*` 테스트

**Interfaces:**
- Consumes: shared `AutomationSummary`·`CreateAutomationBody`·`UpdateAutomationBody`·`AutomationCreated`, REST 여섯, 작성기의 멘션 자동완성 컴포넌트(`features/composer/` 의 것을 재사용).

- [ ] **Step 1: 실패하는 테스트.**
  - 목록: 이름·채널·종류·다음 실행(워크스페이스 시간대로 표기)·웹훅 URL 앞부분·마지막 결과 · 경고 줄 「문구의 @dev 이 이 채널에 없습니다」(Review Focus 3) · 「지금 실행」 → 성공 토스트 · 켜기/끄기 · 삭제는 확인 대화상자 뒤.
  - 대화상자: 이름 비면 제출 불가 · 예약 `weekly` 면 요일 선택이 보임, `hourly` 면 분만 · 웹훅 저장 직후 URL 과 「이 주소는 다시 볼 수 없습니다」·복사 버튼, 닫으면 다시 볼 수 없음 · 재발급도 같은 꼴 · 서버 409 → 이름 칸 오류.
  - member 는 설정 탭에 「자동화」가 없고 경로로 와도 권한 안내 · 경고 줄 「채널이 보관되었습니다」(Review Focus 5).
  - 작성자 표시: automation 메시지 「⚙ 자동화 · <이름>」, 목록에 없는 id 면 「⚙ 지운 자동화」(Review Focus 5).
  - 운영 화면 설정의 시간대 선택이 PATCH 를 보냄.
- [ ] **Step 2: 실패 확인.**
- [ ] **Step 3: 구현.** 작성자 이름 풀기는 `useAuthors` 에 automation 갈래를 더하고, 자동화 목록 질의(`qk.automations`)를 admin 이상일 때만 부른다 — member 에게는 이름 없이 「⚙ 자동화」(목록 API 가 403 이라 이름을 모른다).
- [ ] **Step 4: 통과 확인** — 실행 개수.
- [ ] **Step 5: 루트 검사 4종 + 웹 빌드.**
- [ ] **Step 6: 커밋** — `feat(web): manage automations and show automation authors`.

> PA6(태스크 4 판정) — member 에게 자동화 이름을 보이려면 공개 목록이 필요하다. 이번에는 「⚙ 자동화」로 두고, 태스크 5 가 스펙 「구현과 맞춘 것」과 `docs/plan.md` 「이월」에 적는다.

---

### Task 5: 브라우저 검증·Compose·문서

**Files:**
- Modify: `docs/guides/user-guide.md`(「자동화」 절), `docs/guides/agent-guide.md`(자동화가 보낸 글 — 보낸 사람 `system:automation`, 웹훅 원문 블록), `docs/guides/deploy.md`(웹훅 공개 경로·Caddy·`check-caddy.sh`), `docs/project-structure.md`, 스펙 「구현과 맞춘 것」(PA1~PA6), `docs/plan.md`, `CLAUDE.md` 「현재 단계」

- [ ] **Step 1: 브라우저(dev:fake, 브리프 포트, BrowserOS neo — 네가 연 탭은 네가 닫는다).** owner 로: 「@dev 점검해 줘」 예약을 지금 + 1분으로 만들기 → 실제로 게시되고 가짜 에이전트가 답함 · 웹훅 자동화 만들기 → URL 복사 → `curl -X POST -H 'content-type: application/json' -d '{"ok":false}' <url>` → 202·게시·답 · 재발급 뒤 옛 URL 404 · 경고 줄 · mia 창에서 「⚙ 자동화」 표시와 사이드바에 「자동화」 없음 · 390px 대화상자.
- [ ] **Step 2: 로컬 Compose**(`docker compose --env-file infra/local.env -f infra/compose.yml -f infra/compose.local.yml up -d --build`, `bash infra/check-caddy.sh https://localhost:8443` — 새 줄 통과). 끝나면 자기가 만든 것만 내린다(`prune` 금지).
- [ ] **Step 3: 결함은 재현 절차와 함께 보고서에**(이 태스크에서 고치지 않는다).
- [ ] **Step 4: 문서**(위 목록).
- [ ] **Step 5: 루트 `pnpm fmt:check`.**
- [ ] **Step 6: 커밋** — `docs: document automations and record the implementation`.

---

## Self-Review 기록

- **스펙 대조**: 2장 → 태스크 1. 3장 → 1. 4.1~4.3 → 2. 4.4 → 2. 4.5 → 3. 5장 → 3. 6장 → 3. 7장 → 4. 8장 → 3. 9장 → 2·3·4. 10장 → 각 태스크·5.
- **이름 맞춤**: `AutomationSchedule`·`CreateAutomationBody`·`UpdateAutomationBody`·`AutomationSummary`·`AutomationCreated`·`nextRunAt`·`assertTimeZone`·`issueWebhookToken`·`findWebhookByToken`·`dueSchedules`·`claimRun`·`rescheduleOne`·`rescheduleAll`·`createAutomationMessage`·`postAutomationMessage`·`tick`·`MISSED_GRACE_MS`·`webhookBlock`·`WEBHOOK_BLOCK_MAX`·`registerAutomationRoutes`·`registerWebhookRoute`·`LIMITS.webhookPerMin` — 태스크 사이에서 같은 이름.
- **Review Focus**: 다섯 줄 모두 태스크 2·3·4 단계에 테스트가 있다.
- **스펙과 다르게 드러난 것**: PA1(평문 저장), PA6(member 에게 자동화 이름 없음) — 태스크 5 가 스펙에 옮긴다.
