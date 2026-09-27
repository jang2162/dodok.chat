import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { AdapterStatus } from "../wire";

// 운영 보강 계약(스펙 2026-09-25-ops-hardening-design.md 2.3·3.1·6장). 사건 detail 에는 id·코드·수치만 싣는다(8장)

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
  "member_remove_failed",
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

/** PATCH /api/v1/ops/settings 본문 — null 은 무제한 */
export const OpsSettingsPatch = z.object({ dailyRunLimit: z.int().min(1).max(10_000).nullable() });
export type OpsSettingsPatch = z.infer<typeof OpsSettingsPatch>;

/** 워크스페이스 일일 런 상한 — 설정 키가 없을 때 */
export const OPS_DEFAULT_DAILY_RUN_LIMIT = 300;

/** POST /api/v1/ops/events/ack 응답 — 이번에 확인 처리한 줄 수 */
export const OpsAckResult = z.object({ acked: z.int().min(0) });
export type OpsAckResult = z.infer<typeof OpsAckResult>;

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
  gateway: z.object({
    state: z.enum(["connected", "reconnecting", "down"]),
    version: z.string().nullable(),
    pinned: z.string(), // 저장소가 검증한 버전
    drift: z.boolean(), // 받은 버전이 있고 핀과 다르다
  }),
  plugin: z.object({ state: z.enum(["connected", "down"]) }),
  runsToday: z.int().min(0),
  dailyRunLimit: z.int().nullable(), // null 은 무제한
  blockedToday: z.int().min(0), // 오늘 워크스페이스 상한으로 막힌 수 — 채널 한도 차단은 런 표의 행에
  unacked: OpsUnacked,
});
export type OpsStatus = z.infer<typeof OpsStatus>;

/** 런 표 한 행 — 채널 또는 에이전트. tokens·costUsd·costEstimated 는 usage 값을 믿을 수 있을 때만(스펙 3.3) */
export const OpsRunsRow = z.object({
  id: Id,
  name: z.string(),
  runs: z.int().min(0),
  failed: z.int().min(0), // status error
  aborted: z.int().min(0),
  blocked: z.int().min(0), // 채널 한도 run_limit 사건 count 합 — 에이전트 행은 늘 0
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
