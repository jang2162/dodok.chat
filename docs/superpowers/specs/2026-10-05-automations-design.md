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
- 보관: 채널 보관·멤버 비활성화 스펙 `docs/superpowers/specs/2026-10-06-channel-archive-member-deactivate-design.md` — 보관한 채널에는 쓸 수 없다(`assertChannelWritable`, 409 `CHANNEL_ARCHIVED`), 런 관문도 거절한다. 설정 화면은 `/settings` 아래 탭(`apps/web/src/app/router.tsx`)
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
| `channel_id` | text FK `channels.id` | 게시할 채널(채널은 지워지지 않고 보관만 된다) |
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
| `GET /api/v1/automations` | 목록 — 토큰 원문 없음, `tokenPrefix`·`warnings`(문구 속 에이전트 멘션 중 그 채널 멤버가 아니거나 꺼진 것, 채널이 보관됨) |
| `POST /api/v1/automations` | 만들기 — 웹훅이면 응답에 `webhookUrl` 한 번 |
| `PATCH /api/v1/automations/:id` | 이름·채널·문구·켜기·예약 |
| `DELETE /api/v1/automations/:id` | 삭제 — 메시지는 남는다 |
| `POST /api/v1/automations/:id/token` | 웹훅 토큰 재발급 — 응답에 `webhookUrl` 한 번 |
| `POST /api/v1/automations/:id/run` | 지금 실행 |

본문은 shared Zod(`CreateAutomationBody`·`UpdateAutomationBody`·`AutomationSummary`). 사용자 REST 상한(`restPerMin`) 안.

## 7. 웹

- 설정 탭 「자동화」(`/settings/automations`, admin 이상 — 에이전트·채널·멤버 탭과 같은 줄): 목록(이름·채널·종류·다음 실행 시각(워크스페이스 시간대로) 또는 웹훅 URL 앞부분 `…/hooks/whk_abc123…`·마지막 결과·경고 줄 「문구의 @fin 이 이 채널에 없습니다」), 「지금 실행」·켜기/끄기·삭제(확인 대화상자).
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
| 채널이 보관됨 | 예약은 게시하지 않고 `last_status = error`·운영 사건 `automation_failed`(detail `code: CHANNEL_ARCHIVED`)·다음 시각으로. 웹훅은 409 `CHANNEL_ARCHIVED`. 목록 경고 「채널이 보관되었습니다」. 보관한 채널을 겨눈 만들기·채널 바꾸기는 `CHANNEL_ARCHIVED` |

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

## 12. 구현과 맞춘 것

구현(계획 `docs/superpowers/plans/2026-10-05-automations.md` 태스크 1~4)·리뷰·수정·브라우저 검증·로컬 Compose(태스크 5)에서 이 설계와 달라지거나 설계가 정하지 않은 것을 정한 자리만 모았다.
근거는 실행 폴더 `.superpowers/sdd/2026-10-07-automations/`(git 제외)의 보고서·리뷰(`t1`~`t5` — 줄 끝 괄호가 출처)다. 본문(0~11장)은 설계를 확정한 때의 기록이라 고치지 않았다 — **본문과 이 장이 다르면 이 장이 구현이다.**
화면 쓰는 법은 `docs/guides/user-guide.md` 「자동화 (admin 이상)」 절, 에이전트가 받는 글은 `docs/guides/agent-guide.md` 「자동화가 게시한 글」 절, 웹훅 운영·로그 가림·Caddy 는 `docs/guides/deploy.md` 「자동화 웹훅」 절, 파일 자리는 `docs/project-structure.md`(서버 `modules/automations/`·웹 `features/automations/`)다.

**계획 판정 PA1~PA6**

- **PA1 — 문구는 평문 `@핸들` 로 저장하고 게시할 때 토큰화한다.** 「데이터 모델」 장 `body_md` 의 「작성기와 같은 멘션 토큰」은 「작성기가 보내는 것과 같은 평문 `@핸들`」이다 — 사람 메시지처럼 `tokenize(bodyMd, userMessageParticipants(…))`. 그래서 핸들이 바뀌면 게시 때 풀리지 않고 목록 경고(`unknown_handle`)가 알린다. 웹의 문구 칸은 Tiptap 작성기가 아니라 textarea 에 작성기의 후보(`mentionCandidates`)·목록(`MentionList`)을 붙인 것이다 — 토큰을 넣으면 수정할 때 토큰 글자가 그대로 보이고, Tiptap 으로 열면 `toBodyMd` 가 줄머리 표시를 이스케이프해 저장된 문구가 바뀐다(계획, t4 판단 3).
- **PA2 — 웹훅 URL 은 `<오리진>/hooks/<token>`, 오리진은 `bridgePublicUrl(config)` 의 오리진을 http(s) 로 바꾼 것**이다(러너 설정의 `serverUrl` 과 같은 규칙 — `app.ts` 가 `publicOrigin: () => serverUrl` 로 넘긴다). `BRIDGE_PUBLIC_URL` 이 없으면 `APP_ORIGIN` 이라, 개발 모드(Vite 웹 포트가 `APP_ORIGIN`)에서는 복사한 주소가 Vite 로 가고 Vite 프록시에 `/hooks` 가 없어 닿지 않는다 — t5 결함 D1(계획, t3 보고, t5 보고).
- **PA3 — 스케줄러의 「한 번만」은 조건부 UPDATE**(`claimRun` — `WHERE id = ? AND next_run_at = <읽은 값>` 의 바뀐 행이 1 일 때만 게시). `claimRun` 의 다음 시각은 `Date | null` 이다 — null 이면 그 예약을 멈춘다(아래 「스케줄러」). 겹침은 「앞 틱이 게시(라우터)를 기다리는 사이 뒤 틱이 같은 행을 가져가는」 꼴로 테스트한다 — 같은 `now` 로 차례로 두 번 부르면 `dueSchedules` 가 먼저 걸러 이 조건을 재지 못한다(계획, t2 보고 4장).
- **PA4 — 시간대 변경은 `PATCH /api/v1/ops/settings` 의 같은 트랜잭션에서 켜진 예약의 `next_run_at` 을 다시 센다**(`rescheduleAll`). 다시 세는 것은 **정규형 시간대가 실제로 바뀔 때만**이다 — 같은 값을 함께 실어 보내는 저장마다 다시 세면 기한이 지나 다음 틱을 기다리던 회차가 「지금 뒤의 다음 회차」로 밀려 조용히 빠진다(실제로 바뀔 때의 같은 손실은 PA4 가 받아들인 대가). PATCH 는 `dailyRunLimit`·`timeZone` 가운데 하나 이상을 받고(`OpsSettingsPatch` — 둘 다 선택 + refine) 바뀐 뒤의 설정 전체(`OpsSettings`)를 돌려준다(계획, t1 보고 7장 2, t2 판단 6·7).
- **PA5 — 웹훅 경로는 `/api` 밖**이라 사용자 REST 상한을 타지 않고, 파서 교체와 `bodyLimit: 64 * 1024` 는 그 라우트를 담은 캡슐 플러그인 안에만 둔다. 파서는 `parseAs: "string"` 이 아니라 `parseAs: "buffer"` + `TextDecoder`(fatal 아님)다 — 아래 「웹훅」(계획, t3 보고, t3 수정 보고 L1).
- **PA6 — member 의 화면에서 자동화 글의 작성자는 이름 없이 「⚙ 자동화」다.** 「웹」 장 「메시지 작성자 표시」의 「⚙ 자동화 · <이름>」은 admin 이상만 — 이름을 풀 자동화 목록 API 가 admin 전용이라 member 는 목록을 부르지 않는다(질의 0건). 이름이 비밀은 아니다 — 서버 멘션 푸시는 member 에게도 「자동화 <이름>이 … 불렀습니다」를 보낸다. member 에게 이름을 보이는 공개 목록은 `docs/plan.md` 「이월」의 「자동화」 묶음(t4 판정, t4 리뷰 m4).

**계약·저장소 (태스크 1)**

- shared 에 `OpsSettings`{ dailyRunLimit, timeZone } 를 새로 두었다(전에는 서버의 지역 타입뿐) · `OPS_DEFAULT_TIME_ZONE = "Asia/Seoul"` · `AutomationBodyMd` 는 공백만인 문구도 거절한다(작성기 `MessageSend` 와 같은 규칙) · `AutomationPosted`{ messageId }(「지금 실행」·웹훅 202)(t1 판단 1·4, t3 보고).
- 이름 유일은 대소문자를 가린다(`Deploy`·`deploy` 공존 — Gateway 이름과 같은 규칙). `updateAutomation` 은 `updatedAt` 을 스스로 올리지 않는다(틱의 결과 쓰기가 사용자 수정 시각을 바꾸지 않게), 없으면 NOT_FOUND. `deleteAutomation` 도 없으면 NOT_FOUND(t1 판단 5, t1 리뷰 2장).
- `findWebhookByToken` 은 꺼짐·종류를 보지 않는다 — 웹훅 경로가 가른다(t1 판단 6).
- 마이그레이션은 `0020_automations` — 새 표만 만들어 `messages` 를 다시 만들지 않으므로 FTS 트리거·백필을 다시 넣지 않는다(t1 보고).

**시간대 (태스크 1·2)**

- **IANA 이름만 받는다** — 「워크스페이스 시간대」 절의 「`Intl.DateTimeFormat` 이 던지면 `VALIDATION`」에 더해, Intl 이 받는 고정 오프셋(`+09:00`·`+0900`·`+09`·`-05:30`·유니코드 빼기 `−05:30`)도 VALIDATION 이다. **정규형으로 거른다**(`resolvedOptions().timeZone` 이 `+`·`-` 로 시작하면) — 입력으로 거르면 유니코드 빼기가 지나간다. `UTC`·`Etc/UTC`(→ `UTC`)·`Etc/GMT-9` 는 받는다. `Intl.supportedValuesOf("timeZone")` 로 거르지 않는다 — 그 목록에는 `UTC`·`Etc/GMT-9` 가 없다(t2 리뷰 고칠 것 1, t2 수정 보고, t2 재리뷰).
- **저장값은 Intl 정규형**이다 — `asia/seoul` → `Asia/Seoul`, `US/Eastern` → `America/New_York`, `EST` → `America/Panama`(ICU 가 tzdata 의 링크를 따른다)(t1 리뷰 E, t2 재리뷰).
- **저장된 이름을 서버의 Intl 이 모르면**(ICU 가 바뀐 경우) 읽기와 PATCH 응답 모두 기본값으로 보이고 warn `ops settings time zone unknown` 을 남기며, 저장값은 그대로 둔다(`withKnownTimeZone` 하나) — 그 위에서 한도만 바꾸는 PATCH 도 200 이다(t1 리뷰 C, t2 리뷰 권고 3, t2 수정 보고).
- **웹이 지금 시간대를 읽는 길은 `GET /api/v1/ops/status` 의 `timeZone`**(`OpsStatus` 한 칸 — admin 이상)이다. 「웹」 장의 시간대 선택과 「다음 실행(워크스페이스 시간대로)」 표기 둘 다 이것을 읽는다(t4 판단 1).
- **웹의 시간대 선택지는 `UTC` + 브라우저의 `Intl.supportedValuesOf("timeZone")` + 지금 값(목록에 없어도 맨 앞)**이다 — 오프셋 꼴은 만들지 않는다. 저장은 시간대만 보내고 응답의 정규형을 보인다. 브라우저 ICU 가 서버와 다른 이름을 내도(예: `Asia/Kolkata`·`Asia/Calcutta`) 「지금 값」 선택지가 덮는다(t4 보고 7장, t4 리뷰 볼 것 5).
- 일일 런 한도의 「하루」는 이 시간대가 아니라 서버 설정 `TZ` 의 자정이다 — 두 값은 따로다.

**다음 실행 시각 (태스크 1·2)**

- **매시간은 서머타임 봄에 없는 벽시계 시각을 건너뛴다** — 「다음 실행 시각」 절 「서머타임」 줄의 「첫 유효 순간」을 매시간에 그대로 쓰면 `America/New_York` 매시간 :15 가 03:00(없는 02:15 를 민 것)과 03:15 에 15분 간격으로 두 번 돈다. 그래서 매시간은 다음 시의 회차를 기다리고, 일·주 단위만 첫 유효 순간으로 민다. 가을에 두 번 있는 시각은 매시간도 첫 번째만이라 그 시의 두 번째 :15 는 한 번 빠진다(실시간 간격 120분). 기본 `Asia/Seoul` 은 해당이 없다(t1 보고 7장 3, t1 리뷰 1장, t2 보고).
- `nextRunAt` 에 Intl 이 모르는 시간대를 주면 `RangeError` 다(VALIDATION 이 아니다) — 저장 때 막고, 틱이 자동화마다 감싼다(아래)(t1 판단 7).
- 요일은 그 시간대의 벽시계 날짜로 센다 — 테스트가 프로세스 시간대(`TZ`)를 음수 오프셋으로 고정해, `getUTCDay` 를 `getDay` 로 바꾸는 실수가 어느 머신에서나 드러난다(t1 리뷰 F, t2 보고).

**게시·라우터 (태스크 2)**

- **멘션은 문구에서만 나온다** — 「게시」 절 `postAutomationMessage(automation, extraMd?)` 의 웹훅 원문(`extraMd`)은 토큰화하지 않고, 그 안의 dodok 멘션 토큰 꼴(`<@a:…>`·`<@u:…>`)마다 `<` 뒤에 단어 잇기(U+2060)를 넣어 무력화한 뒤(shared `neutralizeMentionTokens`) 빈 줄 하나 뒤에 붙인다. 저장하는 `mentions` 는 저장 본문 전체의 `parseMentions` 라 원문이 멘션·런·푸시·자동 참여를 만들 길이 없다 — 원문 속 리터럴 토큰도, 펜스를 늘린 블록 안의 평문 `@dev` 도(`splitCode` 가 늘린 펜스를 짝짓지 못해 토큰화되던 것). 보이는 글자는 그대로다. 대가: 화면에서 복사한 원문에는 U+2060 이 남고, 보이는 글자로 친 `<@a:…>` 검색어는 무력화한 자리를 찾지 못한다(uuid 로는 찾는다)(t2 리뷰 고칠 것 2, t2 수정 보고, t2 재리뷰).
- **문구가 멘션한 사람은 사람 멘션처럼 그 채널에 들어온다**(팀 스펙 「채널 참여·멘션·알림」). 자동화 자신은 채널 멤버가 되지 않는다(t2 판단 1).
- **보관 검사는 게시 트랜잭션 안**(`createAutomationMessage` 의 `assertChannelWritable`)이다 — 예약·웹훅·「지금 실행」이 모두 지나는 한 자리에서, 보관과 엇갈려도 쓰지 않게(t2 판단 2).
- 멘션 푸시의 보낸 이는 「자동화 <이름>이/가 #채널에서 불렀습니다」(조사는 이름 끝 받침), 지운 자동화면 「자동화가 …」. 이름은 그 워크스페이스의 자동화에서만 찾는다(t2 판단 10).
- 「열린 문제」 장 마지막 줄(읽지 않음과의 얽힘)은 닫혔다 — `channel.activity` 조건과 shared `ChannelActivity.authorType` 에 `automation`(authorId = 자동화 id)이 있다. 스냅숏(`unreadFor` — 자동화 글을 「남의 글」로 센다)과 실시간이 맞는다(t2 보고, t2 리뷰 5).
- **검색** — shared `SearchHit.authorType` 에 `automation` 을 더했다(없으면 자동화 글 하나가 검색어에 걸리는 순간 요청 전체가 500). 거르개 `SearchQuery.authorType` 은 `user|agent` 그대로라 자동화 글은 작성자 「모두」에서만 찾는다 — `docs/plan.md` 「이월」(t1 보고 5장, t2 보고).
- Claude 러너의 사용자 메시지 머리는 `보낸 사람: @automation(시스템)` 이다 — 핸들만 싣고 자동화 이름(displayName)은 러너 에이전트에게 가지 않는다(「인바운드 작성자」 절 「러너 CLI 변경 없음」 그대로)(t2 리뷰 2장).

**스케줄러 (태스크 2)**

- **첫 틱은 부팅 정리(`recoverOnBoot`)와 어댑터 `connect()` 뒤에 돈다** — 「스케줄러」 절의 「부팅 때 한 번 바로 돈다」보다 앞이면 첫 틱이 만든 멘션 런을 같은 부팅의 `recoverOnBoot` 가 지난 부팅의 것으로 보고 `SERVER_RESTART` 로 닫는다. 틱은 첨부 정리와 같은 `startAttachmentSweeper`(지금 한 번 + 주기 + 겹침 건너뜀 + 닫을 때 진행 중 회 기다림)이고, 종료 단계 `automations` 가 닫는다(t2 판단 8·9, t2 리뷰 N4, t3 보고).
- **다음 시각을 셀 수 없는 예약은 멈춘다** — `error`·`automation_failed` 를 남기고 `next_run_at` 을 비운다(`claimRun(…, null)`). 감싸기만 하면 `next_run_at` 이 과거에 남아 매분 같은 실패를 되풀이한다. 예약을 고치거나 켜면(`rescheduleOne`), 시간대를 바꾸면(`rescheduleAll` — null 로 멈춘 켜진 예약도 센다) 되살아난다. 실제로 닿는 길은 DB 를 손으로 고친 예약뿐이다(시간대는 위 「모르는 이름이면 기본값」이 먼저 막는다)(t2 판단 3).
- **자동화 하나의 실패는 틱을 멈추지 않는다** — 감싸기가 두 겹이다: 안쪽이 다음 시각·게시 실패를 그 자동화의 `error` 로, 바깥이 결과를 적다 던진 것(DB·사건)을 로그만 남기고 다음 자동화로. 시간대는 틱마다 한 번 읽는다(t2 판단 4).
- **늦음은 저장된 `next_run_at`(놓친 회차 가운데 가장 이른 것) 기준이다** — 「스케줄러」 절의 `now - next_run_at > 10분` 문자 그대로다. 그래서 한 주기보다 오래 꺼져 있었으면 마지막 회차가 10분 안이어도 건너뛰고 사건 하나를 남긴다(매일 09:00, 월 08:00 에 꺼지고 수 09:05 에 켜지면 수 09:00 도 건너뛴다)(t2 리뷰 권고 4).
- 사건 detail — `automation_skipped` 는 `{ automationId, lateMs }`, `automation_failed` 는 `{ automationId }` + HttpError 면 `code`(보관이면 `CHANNEL_ARCHIVED`). 로그는 `err` 를 싣는다(t2 판단 5).

**관리 API (태스크 3)**

- **응답** — 목록 200(배열, 만든 차례), 만들기 201(`Cache-Control: no-store`), 수정 200, 삭제 204, 토큰 재발급 200(`no-store`, `webhookUrl` 늘 있음), 지금 실행 202 `AutomationPosted`. 예약에 재발급·웹훅에 `schedule` 은 400 VALIDATION(`details.field`). 이름 겹침 409 `CONFLICT`(`details.field = "name"`), 보관 채널로 만들기·옮기기 409 `CHANNEL_ARCHIVED`(t3 보고 2장·판단 9).
- **수정은 켜짐·예약이 실제로 바뀔 때만 다음 시각을 다시 센다**(예약은 필드로 비교) — 대화상자가 모든 칸을 다시 보내도 기한이 지난 회차가 밀려 빠지지 않는다(t3 판단 5).
- **「지금 실행」은 요청 하나에 게시 하나다** — 「「지금 실행」」 절 그대로 `next_run_at` 은 건드리지 않는다. 연타는 서버가 아니라 웹이 막는다(요청이 나가 있는 동안 그 자동화의 버튼만 잠그고, 같은 틱의 두 번째 클릭은 ref 로 거른다). 성공하면 `last_run_at`·`last_status = ok`, 실패(보관 채널 409)는 결과를 남기지 않는다(누른 사람이 그 자리에서 본다). 꺼진 자동화도 실행한다(t3 판단 1 — 코디네이터 판정, t4 보고 7장).
- **경고 규칙** — 문구의 코드 밖 평문 `@핸들`(shared `plainMentionHandles` — 게시의 `tokenize` 와 같은 규칙)을 게시와 같은 참가자(`userMessageParticipants`)로 풀어 본다. 풀리는 사람·켜진 에이전트는 경고 없음, 풀리는 꺼진 에이전트는 `agent_disabled`. 풀리지 않으면 워크스페이스에서 그 핸들을 찾아 꺼짐·보관이면 `agent_disabled`, 아니면 `agent_not_in_channel`, 사람(비활성 멤버 포함)이면 경고 없음, 아무도 아니면 `unknown_handle`. 채널이 보관됐으면 `channel_archived` 가 맨 앞, 그 뒤 핸들마다 처음 나온 차례로 한 번 — `handle` 은 문구에 쓴 그대로다(t3 판단 4, t3 보고 2장).

**웹훅 (태스크 3)**

- **검사 차례는 모두 본문을 받기 전(onRequest)**이다 — 토큰 대조 → 켜진 웹훅의 토큰이 아니면(모르는 토큰·꺼짐·예약 종류) 막힌 주소 429 / 모르는 토큰은 실패로 세고 404 / 꺼짐·예약 404 → 켜진 웹훅의 토큰은 막힌 주소에서도 지나가 토큰마다 상한(키는 토큰 해시 — 재발급하면 새 버킷) 429. 그 뒤에야 본문을 받는다. 그래서 틀린 토큰은 본문 크기와 무관하게 404 이고(크기로 토큰 유무를 가늠할 수 없다), 꺼짐은 상한보다 먼저 404 다(t3 판단 7·8, t3 수정 보고).
- **실패 카운터는 웹훅 전용 `BridgeAuthGuard` 인스턴스**(숫자는 `LIMITS.bridgeFail`)이고, **켜진 웹훅의 토큰은 막힌 주소에서도 통과한다** — 「엔드포인트」 표의 「실패 카운터」 줄(토큰 대조 앞에서 막힌 주소는 429)을 대신한다. 막힌 주소에서는 모르는 토큰과 꺼진 토큰이 같은 429 다. 까닭: GitHub 같은 서비스는 여러 고객이 발신 주소 풀을 나눠 쓴다 — 그 풀의 한 주소에서 남의 틀린 토큰(지우고 설정을 안 고친 옛 웹훅, 일부러 건 공격)이 10번 나면 같은 주소로 오는 내 정상 웹훅까지 막혔다(GitHub 는 실패한 전달을 스스로 다시 보내지 않는다). 토큰은 256비트라 막힘 없이도 맞혀 볼 수 없다. 카운터를 브리지·러너·첨부 HTTP 와 나누지 않으면 웹훅 소음이 같은 주소의 플러그인·러너를 막는다. 막힘 사건은 기존 `bridge_auth_blocked`(key `bridge`)에 `detail.path: "webhook"` 이다. 「오류 처리」 장 「웹훅 실패 카운터 막힘」 줄은 「429(받지 못할 토큰에만 — 켜진 웹훅의 토큰은 통과)」(t3 리뷰 M1, 코디네이터 판정, t3 수정 보고).
- **게시 직전에 다시 확인한다** — 본문을 받는 데 시한이 없으므로(Fastify `requestTimeout` 기본 0) 본문을 다 받은 뒤 자동화를 다시 읽어 꺼짐·재발급(해시가 다름)·삭제면 404(모르는 토큰과 같은 본문)다. 다시 읽기와 게시 사이에는 `await` 가 없다. 게시가 라우터를 기다리는 사이 지워지면 게시는 남고(202) 마지막 결과는 쓰지 않는다(t3 리뷰 M2, t3 수정 보고, t3 재리뷰).
- **본문** — 「엔드포인트」 표 본문 줄에 더해: JSON 타입은 `application/json` 과 `+json` 접미(`application/vnd.github+json`, 대소문자·charset 무시)다. 공백뿐인 본문은 빈 본문이다. 8,000자는 코드 포인트로 세고(이모지를 반쪽으로 남기지 않는다) `…(잘림)` 은 블록 안 끝에 붙는다. 펜스는 블록에 들어가는 글(자른 뒤)의 가장 긴 백틱 줄보다 하나 길다(최소 3). `<@` 는 여기서 바꾸지 않는다(무력화는 게시 몫 — 두 번 바뀌지 않게)(t3 보고 7장).
- **JSON 다시 쓰기 상한** — 깊이 64·값 10,000·다시 쓴 길이 256 Ki 자(만들기 전에 위로 어림한다) 안에서만 2칸으로 다시 쓰고, 하나라도 넘으면 원문 그대로의 블록이다(8,000자 자르기만). 상한이 없을 때 12 KB 의 깊이 6000 배열이 다시 쓴 글 72M 자·메인 스레드 약 2초·힙 1.2 GB 를 만들었다 — 토큰 하나의 분당 30번이면 이벤트 루프가 분당 수십 초 멈춘다(`REINDENT_LIMITS`, t3 리뷰 I2, t3 수정 보고, t3 재리뷰 I2).
- **본문은 바이트로 받아 UTF-8 로 푼다** — 잘못된 바이트는 U+FFFD, 앞의 BOM 은 뗀다. `Content-Type` 과 무관하게 받아들이고 64 KiB 는 받은 바이트로 잰다(문자열 파서는 UTF-8 이 아닌 본문을 400 「길이 불일치」, 부푼 길이로 413 을 냈다). 틀린 꼴의 media type(`;;;`·`garbage`·빈 `Content-Type:` 머리)은 Fastify 가 파서 전에 **415** 로 거절한다 — Fastify 몫이라 그대로 두었고, 토큰 확인 뒤라 모르는 토큰은 그대로 404 다(t3 리뷰 L1 — 코디네이터 판정: 리뷰대로, t3 수정 보고, t3 재리뷰).
- **웹훅 게시가 실패하면 예약과 같이 `last_status = error`·`automation_failed`(code)를 남긴다** — 보낸 바깥 서비스 말고는 그 응답을 보는 사람이 없다(스케줄러의 `markFailed` 를 같이 쓴다). 라우터가 던지면(메시지는 저장된 뒤) 500 이라 보낸 쪽이 다시 보내면 중복 게시가 될 수 있다 — 드문 길이라 그대로 두었다(t3 판단 2).
- 100자 넘는 토큰 경로는 Fastify `maxParamLength`(기본 100)에 걸려 라우트 404(Fastify 기본 본문, 실패 카운터 밖)다. 진짜 토큰은 47자라 해가 없다(t3 판단 10).
- **로그의 토큰 가리기** — 「토큰 수명」 절의 「원문은 발급 응답 한 번」이 로그로 무너지지 않게: 서버 요청 로그(`incoming request` 의 url)와 Fastify 기본 404 줄(`Route <method>:<url> not found` — 직렬화기를 거치지 않는다)은 `/hooks/` 다음 경로 조각(대소문자·퍼센트 인코딩 무관)과 그 밖의 `whk_` 토큰 꼴을 앞 10자(`whk_` + 목록의 `tokenPrefix` 6자)와 `…` 로 가린다(`apps/server/src/logger.ts` `redactUrl`·`RedactingLogController`). Caddy 기본 오류 로그(`http.log.error` — 업스트림이 내려간 동안·보낸 쪽이 본문 도중 끊을 때의 502)와 `reverse_proxy` 의 「aborting with incomplete response」 경고도 `request>uri` 를 같은 꼴로 가린다(`infra/Caddyfile` 전역 `log default` 필터). 확인은 `infra/check-caddy.sh` 의 `CADDY_LOG_CMD` — https 오리진에서 HTTP/2 탐침 셋이 필터의 두 규칙을 따로 잰다(t3 리뷰 I1, t3 재리뷰 F1, t3 재리뷰2 N1~N3, t5).
- **pino `err` 직렬화기가 Buffer 속성을 지운다** — `LOG_LEVEL=trace` 에서 잘못된 HTTP 요청 하나(`client error` 줄의 `err.rawPacket`)로 redact 가 Buffer 를 걷다 던져 서버가 죽던 기존 결함을 같이 고쳤다. `err` 밖의 키에는 Buffer 를 싣지 않는다(그 함수 머리 주석)(t3 재리뷰 F2, t3 수정 2 보고).

**웹 (태스크 4)**

- 설정 탭 「자동화」는 「채널」 뒤(내 계정·알림·에이전트·채널·자동화·멤버·연결·운영), 아이콘 `ZapIcon`(t4 판단 7).
- **작성자 이름 목록은 자동화 글이 보일 때만, admin 이상이 받는다**(`useLoadAutomationAuthors` — 메시지 행마다 받지 않게 `useAuthors` 는 캐시만 읽는다). 받아 둔 목록이 그 글보다 먼저 받은 것이고 그 자동화가 없으면 한 번 다시 받는다 — 그 뒤에도 없으면 「⚙ 지운 자동화」, 목록 전이면 「⚙ 자동화」. 그래서 다른 탭·다른 관리자가 만든 자동화의 글이 「⚙ 지운 자동화」를 거치지 않는다. 판정은 목록의 받은 시각(브라우저 시계)과 글의 `createdAt`(서버 시계) 비교라, 브라우저 시계가 서버보다 크게 늦으면 지운 자동화가 「⚙ 자동화」로 남는다(t4 판단 5).
- 경고 문구의 조사는 받침대로 고른다(`josa` — 「문구의 @fin 이 …」·「문구의 @dev 가 …」). 정해지지 않았던 둘은 「문구의 @<핸들> 이/가 꺼져 있거나 삭제되었습니다」(`agent_disabled` — 서버가 꺼짐·보관을 한 종류로 낸다)·「문구의 @<핸들> 을/를 찾을 수 없습니다」(`unknown_handle`)(t4 판단 6).
- 「주소 다시 만들기」는 수정 대화상자 안이다(확인 「옛 주소는 곧바로 쓸 수 없게 됩니다. …」 → 「다시 만들기」). 누르면 그 대화상자에서 저장하지 않은 수정은 버린다(t4 판단 8, t4 리뷰 m1).
- 웹훅 주소 원문은 그 대화상자의 컴포넌트 상태에만 있다 — 뮤테이션 결과·쿼리 캐시·저장소·콘솔·토스트에 없고, 「복사했습니다」로 버린다. 보내는 중·주소가 보이는 동안은 Esc·바깥 클릭으로 닫히지 않고, 떠나려 하면 `useLeaveGuard` 가 「주소」 문구로 묻는다(t4 보고, t4 수정 보고).
- 수정 PATCH 는 이름·채널·문구·예약을 늘 보낸다(서버가 실제로 바뀐 것만 다시 센다). 지금 채널이 보관됐으면 선택지에 「#<이름> (보관됨)」을 넣어 그대로 보낸다 — 없으면 선택이 첫 채널로 튀어 몰래 옮긴다. 보관된 채널로 만들기(경합) 409 는 폼 안이 아니라 전역 토스트 「보관된 채널입니다」, 이름 409 만 폼 안(t4 판단 9·11).
- 삭제 확인은 공용 `ConfirmDialog`(`returnFocus`)다 — 취소·Esc 는 누른 「삭제」로, 삭제 뒤는 다음 줄의 「삭제」 → 앞 줄 → 「만들기」로 초점이 간다(t4 리뷰 F1, t4 수정 보고).
- 사건 문구 「자동화 예약을 놓쳐 건너뜀」·「자동화 실행 실패 (CODE)」(기존 사건 문구의 명사형)(t2 판단 11).

**검증 (태스크 5 — 모델 런 0회)**

- **브라우저** — `dev:fake` 위 독립 headless Chromium(Playwright) 하나에 owner·mia 컨텍스트와 owner 의 390px(`isMobile`·`hasTouch`) 컨텍스트. 둘째 클라이언트가 다른 계정이라 BrowserOS neo 가 아니라 독립 브라우저로 했다. 「테스트·검증」 장 브라우저 항목(지금 + 1분 예약이 게시되고 가짜 에이전트가 답함·`curl` 웹훅 → 202·게시·답·390px 대화상자)과 재발급 뒤 옛 URL·꺼진 자동화·틀린 토큰의 같은 404, 원문 속 멘션의 런 0, 서버 로그의 토큰 원문 0, 경고 줄·보관, 「지금 실행」 연타(같은 틱·100ms 간격·키보드 모두 요청 1), 삭제 뒤 「⚙ 지운 자동화」, member 화면, 읽지 않음·반응과의 얽힘, 시간대(PA4), 다른 탭의 자동화 이름을 봤다 — 결함 셋(아래), 나머지 통과. 에이전트 쪽 보낸 사람은 `dev:fake` 가 인바운드마다 남기는 `dev:fake inbound reactions` 줄의 `sender`(`system:automation`)·`senderName`(「자동화 <이름>」)으로 봤다(t5 보고).
- **브라우저 결함 셋(고치지 않았다 — `docs/plan.md` 「이월」의 「자동화」 묶음)** — D1: 개발 모드에서 복사한 웹훅 주소(웹 오리진)가 Vite 의 404 를 받는다(Vite 프록시에 `/hooks` 없음, 운영은 Caddy 가 넘긴다 — PA2). (D1 은 이후 고쳤다 — `vite.config.ts` 프록시에 `/hooks` 를 더했다.) D2: 「지금 실행」을 키보드로 누르면 버튼이 `disabled` 가 되며 초점이 body 로 떨어지고 끝나도 돌아오지 않는다. D3: 높이 460px(폰에서 화상 키보드가 올라온 꼴)이면 문구 칸 아래 @ 후보 목록이 대화상자 아래 끝에 잘리고 ↑↓ 로 고른 후보가 스크롤되어 보이지 않는다(640·844px 은 정상)(t5 보고).
- **로컬 Compose** — `infra/check-caddy.sh` 가 새 줄(`/hooks/whk_nope` 는 서버의 404 JSON)과 웹훅 토큰 가림 셋까지 전부 PASS. 가림 확인은 Caddyfile 필터를 통째로 빼거나(셋 다 FAIL), `whk_` 규칙의 `[\w-]` 를 `\w` 로 줄이거나(쿼리 탐침만 FAIL), `/hooks/` 규칙을 빼면(`%77` 탐침만 FAIL) 잡힌다 — 컨테이너에 사본을 `caddy reload` 로 올려 쟀다(t5 보고).
