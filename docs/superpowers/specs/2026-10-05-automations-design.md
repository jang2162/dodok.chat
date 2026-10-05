# 자동화 — 예약·웹훅으로 채널에 메시지를 게시하는 설계

**상태**: 설계 확정(2026-10-05), 구현 전.
**범위**:
- 자동화 = 트리거(예약 또는 들어오는 웹훅) + 동작(정한 채널에 정한 문구로 메시지 게시)
- 문구에 에이전트 @멘션이 있으면 기존 라우터가 멘션 런을 시작한다 — 새 런 경로가 없다
- admin 이상이 `/settings/automations` 에서 만들고 고친다

**앞선 근거**:
- Slack·Buzz 참고 후보 조사(이 대화의 결론): Buzz 의 YAML 워크플로(메시지·리액션·예약·웹훅 트리거)에서 「트리거 → 채널 메시지」만 가져온다
- 런 경로: 라우터 `apps/server/src/modules/router/service.ts`(`routeMessage`)·`decide.ts`(`decideRuns`), 런 관문 `apps/server/src/modules/ops/budget.ts`(RunGate — 모든 런이 지난다)
- 주기 작업 본보기: `apps/server/src/app.ts` 의 첨부 정리·ops 보존 정리(`setInterval` + `.unref()`, `AppDeps` 로 주기 주입, 종료 때 해제)
- 토큰 본보기: 브리지 토큰 `apps/server/src/modules/setup/tokens.ts`(접두사 + `randomBytes(32).base64url`, sha256 만 저장, `timingSafeEqual`), 실패 카운터 `packages/shared/src/adapter/guard.ts`(`BridgeAuthGuard`)
- 시스템 작성자 인바운드: 서버 `apps/server/src/modules/runs/context.ts`, 플러그인 `packages/openclaw-plugin/src/inbound.ts`(`senderId = <type>:<handle>`)
- 역할: 팀 스펙 `docs/superpowers/specs/2026-09-26-team-members-design.md` 「역할과 권한」
- 읽지 않음 스펙 `docs/superpowers/specs/2026-10-05-unread-design.md`(`channel.activity` — 그 스펙 「서버」 장)

---

## 0. 결정 (브레인스토밍 2026-10-05)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **예약·웹훅을 「자동화」 하나로 묶고, 동작은 채널 메시지 게시 하나** | 사용자 결정. 멘션이 런을 만드는 기존 경로를 그대로 쓴다. 여러 단계·리액션 트리거·승인 게이트·지연은 범위 밖. |
| 2 | **웹훅 본문은 고정 문구 + 원문 코드 블록** | 사용자 결정. 서비스마다 다른 JSON 의 해석은 에이전트에게 맡긴다. 템플릿 치환·전용 형식은 범위 밖. |
| 3 | **예약은 간단한 반복(매일·평일·매주 ○요일·매시간) + 시각, 시간대는 워크스페이스 하나** | 사용자 결정. cron 식은 범위 밖. |
| 4 | **스케줄러는 서버 안의 60초 틱**, `next_run_at` 저장 | 사용자 결정. 의존성 없음, 배포 절차가 늘지 않는다. |
| 5 | **놓친 예약은 10분 안이면 한 번만, 그보다 오래면 건너뛴다** | 서버가 오래 꺼졌다 켜질 때 밀린 예약을 몰아 실행하면 런 비용이 한꺼번에 난다. |
| 6 | **자동화 글은 멘션으로만 런을 만든다 — 자동 응답 에이전트로 넘어가지 않는다** | 멘션 없는 자동화 글이 몰래 런을 만들면 비용이 예상과 달라진다. |
| 7 | **관리는 admin 이상** | 기존 규칙 「에이전트 동작·비용 설정은 admin 이상」. 자동화는 런 비용을 만든다. |
| 8 | **웹훅 토큰은 URL 경로에** | GitHub 같은 서비스는 Authorization 헤더를 넣지 못한다. 저장은 해시만. |
| 9 | **에이전트에게 보낸 사람은 `system` 꼴로** | 플러그인·러너 CLI 를 바꾸지 않는다(플러그인은 이미 system 작성자를 다룬다). |

## 1. 범위

**한다**
- `automations` 표, `Message.authorType "automation"`, 워크스페이스 설정 `timeZone`
- 서버 `modules/automations/`(관리 API·다음 시각 계산·스케줄러·웹훅 수신)
- 라우터 automation 분기, 인바운드 작성자 꼴
- 웹 `/settings/automations`, 자동화 작성자 표시
- Caddy `/hooks/*`, 역할 매트릭스, 문서

**하지 않는다** — 11장.

## 2. 데이터 모델

### 2.1 `automations` (새 표)

| 열 | 꼴 | 비고 |
| --- | --- | --- |
| `id` | text PK | |
| `workspace_id` | text FK | |
| `name` | text not null | 1~40자, `(workspace_id, name)` 유일 |
| `channel_id` | text FK `channels.id` `ON DELETE CASCADE` | 게시할 채널 |
| `kind` | text not null | `schedule` \| `webhook` |
| `body_md` | text not null | 게시할 문구. 작성기와 같은 멘션 토큰. 1~4,000자 |
| `enabled` | boolean not null default true | |
| `schedule_json` | json | `kind = schedule` 일 때만. 2.2 |
| `next_run_at` | ts | `kind = schedule` 이고 켜져 있을 때만 |
| `token_hash` | text unique | `kind = webhook` 일 때만 |
| `token_prefix` | text | 화면 표시용(접두사 뒤 6자) |
| `last_run_at` | ts | |
| `last_status` | text | `ok` \| `skipped` \| `error` |
| `created_by` | text FK `users.id` | |
| `created_at`·`updated_at` | ts | |

### 2.2 `schedule_json`

```ts
export const AutomationSchedule = z.discriminatedUnion("repeat", [
  z.object({ repeat: z.literal("daily"), time: HHMM }),
  z.object({ repeat: z.literal("weekdays"), time: HHMM }),        // 월~금
  z.object({ repeat: z.literal("weekly"), weekday: z.int().min(0).max(6), time: HHMM }), // 0 = 일요일
  z.object({ repeat: z.literal("hourly"), minute: z.int().min(0).max(59) }),
]);
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
```

### 2.3 워크스페이스 시간대

`workspaces.ops_json` 에 `timeZone`(IANA 이름, 기본 `Asia/Seoul`). 저장 때 `Intl.DateTimeFormat(undefined, { timeZone })` 가 던지면 `VALIDATION`. 시간대를 바꾸면 켜진 예약 자동화의 `next_run_at` 을 모두 다시 계산한다. 운영 화면의 설정에서 바꾼다(`OpsSettingsPatch` 에 더함 — admin 이상).

### 2.4 메시지 작성자

`Message.authorType` 에 `"automation"` 을 더하고 `authorId` 는 자동화 id. `kind = "normal"`. 자동화 행이 지워져도 메시지는 남는다(`messages.author_id` 는 FK 가 아니다).

## 3. 다음 실행 시각

`nextRunAt(schedule, timeZone, after: Date): Date` — `after` 보다 엄격히 뒤인 가장 이른 시각.

- 계산은 `Intl.DateTimeFormat(…, { timeZone })` 로 「그 시간대의 벽시계」를 읽고 후보를 하루씩(매시간은 한 시간씩) 넘기며 맞춘다. 의존성 없음.
- **서머타임**: 없는 벽시계 시각(봄)은 그 뒤 처음 유효한 순간, 두 번 있는 시각(가을)은 첫 번째. `Asia/Seoul` 은 해당 없다.
- 평일은 그 시간대의 요일로 월~금.

## 4. 실행

### 4.1 게시 — `postAutomationMessage(automation, extraMd?)`

`createAutomationMessage`(메시지 서비스에 더함 — `createUserMessage` 처럼 본문을 토큰화해 멘션을 푼다)로 `body_md`(+ 웹훅이면 `extraMd`)를 그 채널 최상위에 게시하고, 라우터의 `routeMessage` 에 넘긴다. RunGate 가 막아도 메시지는 남고 한도 알림이 뜬다(사람 멘션과 같다) — `last_status` 는 `ok`.

### 4.2 라우터

`decide.ts` 에 `authorType === "automation"` 분기: 활성 에이전트 멘션마다 `triggerKind "mention"` 런(채널 멤버이고 켜진 에이전트만 — 사람 멘션 규칙과 같다). 멘션이 없거나 모두 비활성이면 런 없음 — **자동 응답·스레드 응답자로 넘어가지 않는다**(결정 6). 사람 멘션 푸시는 지금 규칙대로 간다(`push/triggers.ts` 가 automation 작성자를 받게 한다).

### 4.3 인바운드 작성자

`runs/context.ts` 가 automation 작성자를 `{ type: "system", handle: "automation", displayName: "자동화 <이름>" }` 로 보낸다(지운 자동화면 `"자동화"`). 최근 대화 문맥에 실릴 때도 같은 꼴. 플러그인은 `system:automation` 보낸 사람으로 다루고 봇 루프 보호를 붙이지 않는다 — 플러그인·러너 CLI 변경 없음.

### 4.4 스케줄러 — `modules/automations/scheduler.ts`

- `app.ts` 가 다른 주기 작업처럼 60초 `setInterval`(`.unref()`, `AppDeps.automationTickMs` 로 주입)로 `tick(now)` 를 돌리고 종료 때 해제한다. 부팅 때 한 번 바로 돈다.
- `tick`: `enabled AND kind = 'schedule' AND next_run_at <= now` 인 행마다, **한 트랜잭션에서** 「`next_run_at` 이 읽은 값과 같으면 `nextRunAt(…, now)` 로 올림」을 하고, 올린 행만 게시한다 — 틱이 겹쳐도 한 번만 게시된다.
- `now - next_run_at > 10분` 이면 게시하지 않고 `last_status = skipped`, 운영 사건 `automation_skipped`(key `automation:<id>`)(결정 5).
- 게시 중 예외면 `last_status = error`, 운영 사건 `automation_failed`. `next_run_at` 은 이미 올랐으므로 매분 반복되지 않는다.
- 자동화를 켜거나 예약을 바꾸면 `next_run_at = nextRunAt(…, now)`, 끄면 null.

### 4.5 「지금 실행」

`POST /api/v1/automations/:id/run` — 종류와 무관하게 `body_md` 만 게시한다(웹훅은 `extraMd` 없이). `next_run_at` 은 그대로.

## 5. 웹훅

### 5.1 엔드포인트

`POST /hooks/<token>` — 토큰은 `whk_` + `randomBytes(32).base64url`. 세션·CSRF 와 무관한 공개 경로.

| 단계 | 동작 |
| --- | --- |
| 실패 카운터 | 요청 주소가 `BridgeAuthGuard` 에 막혀 있으면 429 |
| 토큰 대조 | sha256 으로 행을 찾고 `timingSafeEqual`. 없거나 `kind ≠ webhook`·꺼짐이면 **404**(어느 경우인지 드러내지 않는다), 없는 토큰이면 `guard.fail` |
| 레이트 | 토큰마다 분당 `LIMITS.webhookPerMin = 30`. 넘으면 429, 운영 사건 `ratelimit`(기존 꼴) |
| 본문 | 64 KiB 상한(Fastify `bodyLimit` — 넘으면 413). `Content-Type` 이 JSON 이면 파싱 뒤 2칸 들여쓰기로 다시 써서 ```` ```json ```` 블록, 아니면(텍스트·폼·기타) 원문 문자열을 ```` ``` ```` 블록. 블록 안 글은 8,000자에서 자르고 `…(잘림)`. 본문이 비면 블록 없이 문구만. 블록 안의 ```` ``` ```` 는 펜스를 늘려 깨지지 않게 한다 |
| 게시 | 4.1 의 `postAutomationMessage(automation, block)` |
| 응답 | `202 { messageId }` — 런 결과를 기다리지 않는다 |

숫자 `webhookPerMin` 은 `apps/server/src/modules/ops/limits.ts` 에 둔다.

### 5.2 토큰 수명

만들 때 한 번 발급(응답에 URL 원문 — 다시 볼 수 없다), `POST /api/v1/automations/:id/token` 으로 재발급하면 옛 해시를 갈아 끼워 옛 URL 은 곧바로 404. 웹훅 URL 은 `APP_ORIGIN` 이 아니라 서버 공개 주소(브리지 설치 조각이 쓰는 값)로 만든다.

### 5.3 Caddy

`infra/Caddyfile` 의 `@backend` 경로에 `/hooks/*` 를 더한다. `infra/check-caddy.sh` 에 「`/hooks/whk_nope` 는 서버로(404 JSON)」 한 줄.

## 6. 관리 API (`modules/automations/routes.ts`, admin 이상)

| 경로 | 동작 |
| --- | --- |
| `GET /api/v1/automations` | 목록 — 토큰 원문 없음, `tokenPrefix`·`warnings`(문구 속 에이전트 멘션 중 그 채널 멤버가 아니거나 꺼진 것) |
| `POST /api/v1/automations` | 만들기 — 웹훅이면 응답에 `webhookUrl` 한 번 |
| `PATCH /api/v1/automations/:id` | 이름·채널·문구·켜기·예약 |
| `DELETE /api/v1/automations/:id` | 삭제 — 메시지는 남는다 |
| `POST /api/v1/automations/:id/token` | 웹훅 토큰 재발급 — 응답에 `webhookUrl` 한 번 |
| `POST /api/v1/automations/:id/run` | 지금 실행 |

본문은 shared Zod(`CreateAutomationBody`·`UpdateAutomationBody`·`AutomationSummary`). 사용자 REST 상한(`restPerMin`) 안.

## 7. 웹

- `/settings/automations`(admin 이상, 설정 사이드바에 「자동화」): 목록(이름·채널·종류·다음 실행 시각(워크스페이스 시간대로) 또는 웹훅 URL 앞부분 `…/hooks/whk_abc123…`·마지막 결과·경고 줄 「문구의 @fin 이 이 채널에 없습니다」), 「지금 실행」·켜기/끄기·삭제(확인 대화상자).
- 만들기·수정 대화상자: 이름·채널·종류·문구(멘션 자동완성은 작성기의 것을 재사용)·예약(반복·요일·시각, 매시간이면 분), 웹훅이면 저장 직후 URL 을 한 번 보인다(복사 버튼, 「이 주소는 다시 볼 수 없습니다」). 웹훅 재발급도 같은 대화상자.
- 메시지 작성자 표시: 「⚙ 자동화 · <이름>」, 지운 자동화면 「⚙ 지운 자동화」(`features/messages/useAuthors.ts`).
- 운영 화면 설정에 시간대 선택.

## 8. 권한

관리 API 여섯과 시간대 설정은 admin 이상(member 403). `/hooks/<token>` 은 토큰만. 팀 스펙 「역할과 권한」 표에 줄을 더하고 매트릭스 테스트에 넣는다.

## 9. 오류 처리

| 상황 | 동작 |
| --- | --- |
| 문구 속 에이전트가 채널에 없거나 꺼짐 | 게시하고 런 없음, 목록 경고 줄 |
| 일일 한도 | 게시, 한도 알림(기존) |
| 게시 중 예외 | `last_status = error`, `automation_failed`, 다음 시각은 이미 올라 있음 |
| 10분 넘게 놓친 예약 | 게시 안 함, `skipped`, `automation_skipped` |
| 시간대 이름 틀림 | `VALIDATION` |
| 이름 겹침 | `CONFLICT` |
| 웹훅 틀린 토큰·꺼짐·예약 종류 | 404(틀린 토큰은 실패 카운터) |
| 웹훅 실패 카운터 막힘 | 429, 운영 사건 `bridge_auth_blocked`(기존) |
| 웹훅 너무 큼 | 413 |
| 웹훅 레이트 초과 | 429 |
| 자동화 삭제 | 메시지는 남고 「지운 자동화」 |
| 채널 삭제 | `ON DELETE CASCADE` 로 자동화도 사라진다 |

## 10. 테스트·검증·완료 기준

- **shared**: 스키마(이름 길이·반복별 필드·`HHMM`·문구 길이) · `Message.authorType "automation"`.
- **서버 단위**: `nextRunAt`(daily·weekdays·weekly·hourly, `Asia/Seoul`·`America/New_York` 서머타임 두 경계, 월말·연말·윤년, `after` 가 정확히 그 시각이면 다음 회차) · `tick`(기한 된 것만, 10분 경계 양쪽, 같은 `now` 두 번 → 한 번 게시, 예외 → error·다음 시각 오름) · 웹훅 본문 변환(JSON 들여쓰기·텍스트·8,000자·빈 본문·펜스 늘리기) · 토큰 해시·재발급·`timingSafeEqual`.
- **서버 통합(가짜 Gateway·플러그인)**: 주입한 시계의 틱에서 「@dev 점검해 줘」 예약 → 메시지·멘션 런, 인바운드 작성자 `system:automation` · 멘션 없는 문구 + 자동 응답 에이전트 → 런 없음 · 웹훅 POST → 202 → 런 · 재발급 뒤 옛 토큰 404 · 레이트 429 · 꺼진 자동화 404 · 한도에 막혀도 게시 · 사람 멘션 푸시.
- **역할 매트릭스**: 관리 API admin 이상, member 403.
- **웹 단위**: 목록·경고 줄, 대화상자 검증, URL 한 번 보이기, 「지금 실행」, 작성자 표시.
- **브라우저(dev:fake, 모델 런 0회)**: 1분 뒤 예약이 실제로 게시되고 가짜 에이전트가 답함 · `curl` 웹훅 → 게시·답 · 390px 대화상자.
- **로컬 Compose**: `infra/check-caddy.sh` 새 줄 통과.
- **완료 기준**: 위 자동 테스트 통과(실행 개수 보고) · 브라우저·Compose 통과 · `user-guide.md`(자동화 절), `agent-guide.md`(자동화가 보낸 글 — 보낸 사람 `system:automation`, 웹훅 원문 블록), `deploy.md`(웹훅 공개 경로·Caddy), `project-structure.md` 갱신.

## 11. 열린 문제 (범위 밖 기록)

- **여러 단계 워크플로**(지연·승인 게이트·조건)와 **리액션 트리거**(예: 🔁 = 다시 해 줘).
- **템플릿 치환**(`{{repository.name}}`)·**전용 형식**(`{"text"}`)·**서명 검증**(GitHub `X-Hub-Signature-256`).
- **cron 식** 직접 입력.
- **스레드에 게시**(같은 자동화의 글을 한 스레드에 모으기).
- **읽지 않음과의 얽힘** — 읽지 않음 스펙의 `channel.activity` 는 작성자 `user`·`agent` 만 낸다. **두 기능 중 나중에 병합되는 쪽이** activity 조건과 `ChannelActivity.authorType` 에 `automation` 을 더한다(읽지 않음 계획 Global Constraints 에도 적혀 있다).
