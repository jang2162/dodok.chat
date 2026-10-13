import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { AdapterStatus, GatewayLinkState, OpenClawGatewayStatus } from "../wire";

// 운영 보강 계약(스펙 2026-09-25-ops-hardening-design.md 2.3·3.1·6장). 사건 detail 에는 id·코드·수치와 Gateway 이름(owner 가 붙인 이름)만 싣는다(8장)

/** 사건 종류 — 스펙 3.1 표 */
export const OpsEventKind = z.enum([
  "gateway_down",
  "plugin_down",
  "runner_down", // key 는 러너 토큰 id
  "gateway_version_changed",
  "gateway_version_untested",
  "run_limit",
  "run_failed",
  "ratelimit",
  "bridge_auth_blocked",
  "crash_rejection",
  "crash_exception",
  "unclean_shutdown",
  "disk_low",
  "invite_accept_failed",
  "member_deactivate_failed",
  "automation_skipped", // key automation:<id> — 10분 넘게 놓친 예약
  "automation_failed", // key automation:<id> — 게시 실패(보관한 채널이면 detail.code CHANNEL_ARCHIVED)
  "push_credentials_invalid", // key push:<통로>(apns·fcm) — 푸시 서비스가 키를 거부함(기기 행은 남는다)
  "control_change", // key control:<도구> — 제어 도구가 채널·에이전트 설정을 바꿈(detail 에 바꾼 값은 없다)
]);
export type OpsEventKind = z.infer<typeof OpsEventKind>;

export const OpsSeverity = z.enum(["info", "warn", "error"]);
export type OpsSeverity = z.infer<typeof OpsSeverity>;

/** 사건 한 줄. 같은 kind·key 는 묶여 count·lastAt 만 오른다(3.1) */
export const OpsEvent = z.object({
  id: Id,
  kind: OpsEventKind,
  severity: OpsSeverity,
  key: z.string().max(200),
  detail: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])),
  count: z.int().min(1),
  firstAt: IsoDateTime,
  lastAt: IsoDateTime,
  resolvedAt: IsoDateTime.optional(), // 끊김 사건이 닫힌 때
  ackedAt: IsoDateTime.optional(),
});
export type OpsEvent = z.infer<typeof OpsEvent>;

/** 확인 안 한 사건 수 — info 는 세지 않는다 */
export const OpsUnacked = z.object({ warn: z.int().min(0), error: z.int().min(0) });
export type OpsUnacked = z.infer<typeof OpsUnacked>;

/** GET /api/v1/ops/events 응답 */
export const OpsEventsPage = z.object({ events: z.array(OpsEvent), nextCursor: z.string().optional() });
export type OpsEventsPage = z.infer<typeof OpsEventsPage>;

/** 워크스페이스 일일 런 상한 — null 은 무제한 */
const DailyRunLimit = z.int().min(1).max(10_000).nullable();
/** 워크스페이스 시간대(IANA 이름) — 여기서는 모양만 본다. 있는 이름인지는 예약을 세는 서버의 Intl 이 가른다 */
const TimeZoneName = z.string().min(1).max(64);

/** 워크스페이스 운영 설정 — 저장된 키가 없으면 기본값(OPS_DEFAULT_DAILY_RUN_LIMIT·OPS_DEFAULT_TIME_ZONE)으로 채운 값 */
export const OpsSettings = z.object({ dailyRunLimit: DailyRunLimit, timeZone: TimeZoneName });
export type OpsSettings = z.infer<typeof OpsSettings>;

/** PATCH /api/v1/ops/settings 본문 — 준 키만 바꾼다(하나 이상). 응답은 바꾼 뒤의 OpsSettings 전체 */
export const OpsSettingsPatch = z
  .object({ dailyRunLimit: DailyRunLimit.optional(), timeZone: TimeZoneName.optional() })
  .refine((patch) => patch.dailyRunLimit !== undefined || patch.timeZone !== undefined, {
    message: "dailyRunLimit 이나 timeZone 가운데 하나는 있어야 한다",
  });
export type OpsSettingsPatch = z.infer<typeof OpsSettingsPatch>;

/** 워크스페이스 일일 런 상한 — 설정 키가 없을 때 */
export const OPS_DEFAULT_DAILY_RUN_LIMIT = 300;

/** 워크스페이스 시간대 — 설정 키가 없을 때. 예약 자동화의 시각을 이 시간대의 벽시계로 센다 */
export const OPS_DEFAULT_TIME_ZONE = "Asia/Seoul";

/** POST /api/v1/ops/events/ack 응답 — 이번에 확인 처리한 줄 수 */
export const OpsAckResult = z.object({ acked: z.int().min(0) });
export type OpsAckResult = z.infer<typeof OpsAckResult>;

/** 운영 상태의 Gateway 한 줄(멀티 Gateway 스펙 「운영」 절) — 꺼진 Gateway 는 enabled false·state disabled */
export const OpsGatewayStatus = z.object({
  id: Id,
  name: z.string(),
  enabled: z.boolean(),
  gateway: z.object({
    state: GatewayLinkState,
    version: z.string().nullable(),
    pinned: z.string(), // 저장소가 검증한 버전
    drift: z.boolean(), // 받은 버전이 있고 핀과 다르다
  }),
  plugin: z.object({ state: OpenClawGatewayStatus.shape.bridge }),
});
export type OpsGatewayStatus = z.infer<typeof OpsGatewayStatus>;

/** GET /api/v1/ops/status 응답(스펙 6장) */
export const OpsStatus = z.object({
  workspaceId: Id, // /healthz 에서 뺀 것(스펙 8장) — owner 에게만
  server: z.object({
    version: z.string(),
    startedAt: IsoDateTime,
    previousClean: z.boolean().nullable(), // 직전 종료 표지 — 표지가 없거나 읽지 못했으면 null
  }),
  db: z.object({ bytes: z.int().min(0) }),
  disk: z.discriminatedUnion("level", [
    z.object({
      level: z.enum(["ok", "warn", "error"]),
      freeBytes: z.int().min(0),
      totalBytes: z.int().min(0),
    }),
    z.object({ level: z.literal("unknown") }), // 첫 측정 전·statfs 실패
  ]),
  adapter: AdapterStatus, // /healthz 에서 뺀 어댑터 상세
  gateways: z.array(OpsGatewayStatus), // 더한 차례 — Gateway 가 없으면 빈 목록
  runsToday: z.int().min(0),
  dailyRunLimit: z.int().nullable(), // null 은 무제한
  timeZone: TimeZoneName, // 워크스페이스 시간대(정규형) — 웹이 시간대 선택기·예약의 다음 실행 표기에 읽는다
  blockedToday: z.int().min(0), // 오늘 워크스페이스 상한으로 막힌 수 — 채널 한도 차단은 런 표의 행에
  unacked: OpsUnacked,
});
export type OpsStatus = z.infer<typeof OpsStatus>;

/** 런 표 한 행 — 채널 또는 에이전트. measuredRuns·tokens·costUsd·costEstimated 는 usage 값을 믿을 수 있을 때만(스펙 3.3) */
export const OpsRunsRow = z.object({
  id: Id,
  name: z.string(),
  runs: z.int().min(0),
  failed: z.int().min(0), // status error
  aborted: z.int().min(0),
  blocked: z.int().min(0), // 채널 한도 run_limit 사건 count 합 — 에이전트 행은 늘 0
  measuredRuns: z.int().min(0).optional(), // tokens·costUsd 에 더한 런 수(믿는 제공자의 런) — runs 보다 적으면 부분합
  tokens: z.int().min(0).optional(),
  costUsd: z.number().min(0).optional(),
  costEstimated: z.boolean().optional(), // 더한 런 가운데 구독 환산값(usage.costKind subscription_estimate)이 있다 — costUsd 와 함께만
});
export type OpsRunsRow = z.infer<typeof OpsRunsRow>;

/** GET /api/v1/ops/runs?days=1|7 응답 */
export const OpsRunsSummary = z.object({
  days: z.union([z.literal(1), z.literal(7)]),
  byChannel: z.array(OpsRunsRow),
  byAgent: z.array(OpsRunsRow),
  /** usage 를 믿는 제공자(러너 계획 판정 P8) — 그 제공자의 런만 행의 tokens·costUsd 에 더한다. 비었으면 화면은 「측정 불가」 */
  usageTrustedProviders: z.array(z.string()),
});
export type OpsRunsSummary = z.infer<typeof OpsRunsSummary>;
