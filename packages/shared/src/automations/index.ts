import { z } from "zod";
import { Id, IsoDateTime } from "../common";

// 자동화 계약(자동화 스펙 「데이터 모델」·「관리 API」 절) — 예약·웹훅 트리거가 정한 채널에 정한 문구를 게시한다. admin 이상.
// 웹훅 토큰 원문은 만들기·재발급 응답의 webhookUrl 에만 있고 목록에는 tokenPrefix 만 싣는다

/** 두 자리 시:분(00:00~23:59) — 워크스페이스 시간대의 벽시계 */
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** 반복 — weekdays 는 월~금, weekly 의 weekday 0 은 일요일. 시간대는 워크스페이스 설정 timeZone 하나 */
export const AutomationSchedule = z.discriminatedUnion("repeat", [
  z.object({ repeat: z.literal("daily"), time: HHMM }),
  z.object({ repeat: z.literal("weekdays"), time: HHMM }),
  z.object({ repeat: z.literal("weekly"), weekday: z.int().min(0).max(6), time: HHMM }),
  z.object({ repeat: z.literal("hourly"), minute: z.int().min(0).max(59) }),
]);
export type AutomationSchedule = z.infer<typeof AutomationSchedule>;

export const AutomationKind = z.enum(["schedule", "webhook"]);
export type AutomationKind = z.infer<typeof AutomationKind>;

/** 마지막 실행 결과 — skipped 는 10분 넘게 놓친 예약 */
export const AutomationStatus = z.enum(["ok", "skipped", "error"]);
export type AutomationStatus = z.infer<typeof AutomationStatus>;

/** 이름 — 앞뒤 공백을 걷고 1~40자, 워크스페이스 안에서 유일(서버가 CONFLICT) */
export const AutomationName = z.string().trim().min(1).max(40);

/**
 * 게시할 문구 — 작성기가 보내는 것과 같은 평문 `@핸들`(게시할 때 서버가 토큰화한다). 공백만인 문구는 빈 메시지가 되므로 거절한다
 * (작성기의 MessageSend 와 같은 규칙)
 */
export const AutomationBodyMd = z
  .string()
  .min(1)
  .max(4000)
  .refine((s) => s.trim() !== "", { error: "문구가 비어 있다" });

/** POST /api/v1/automations 본문 */
export const CreateAutomationBody = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("schedule"),
    name: AutomationName,
    channelId: Id,
    bodyMd: AutomationBodyMd,
    schedule: AutomationSchedule,
    enabled: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("webhook"),
    name: AutomationName,
    channelId: Id,
    bodyMd: AutomationBodyMd,
    enabled: z.boolean().default(true),
  }),
]);
export type CreateAutomationBody = z.infer<typeof CreateAutomationBody>;

/** PATCH /api/v1/automations/:id 본문 — 종류는 바꿀 수 없다. schedule 은 예약 종류에만 뜻이 있다(서버가 가른다) */
export const UpdateAutomationBody = z.object({
  name: AutomationName.optional(),
  channelId: Id.optional(),
  bodyMd: AutomationBodyMd.optional(),
  schedule: AutomationSchedule.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateAutomationBody = z.infer<typeof UpdateAutomationBody>;

/**
 * 목록의 경고 한 줄 — 게시는 되지만 런이 생기지 않거나(문구 속 에이전트가 채널에 없음·꺼짐·모르는 핸들) 게시할 수 없다(채널 보관).
 * handle 은 에이전트 경고에만
 */
export const AutomationWarning = z.object({
  kind: z.enum(["agent_not_in_channel", "agent_disabled", "unknown_handle", "channel_archived"]),
  handle: z.string().optional(),
});
export type AutomationWarning = z.infer<typeof AutomationWarning>;

/** 목록·수정 응답의 자동화 한 줄 — 토큰 원문은 싣지 않는다. nextRunAt 은 켜진 예약에만, tokenPrefix 는 웹훅에만 */
export const AutomationSummary = z.object({
  id: Id,
  name: z.string(),
  channelId: Id,
  kind: AutomationKind,
  bodyMd: z.string(),
  enabled: z.boolean(),
  schedule: AutomationSchedule.optional(),
  nextRunAt: IsoDateTime.optional(),
  tokenPrefix: z.string().optional(),
  lastRunAt: IsoDateTime.optional(),
  lastStatus: AutomationStatus.optional(),
  warnings: z.array(AutomationWarning),
});
export type AutomationSummary = z.infer<typeof AutomationSummary>;

/** 만들기·토큰 재발급 응답 — webhookUrl 은 웹훅일 때 이 응답 한 번뿐이다(다시 볼 수 없다) */
export const AutomationCreated = z.object({ automation: AutomationSummary, webhookUrl: z.url().optional() });
export type AutomationCreated = z.infer<typeof AutomationCreated>;
