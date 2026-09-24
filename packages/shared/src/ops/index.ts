import { z } from "zod";
import { Id, IsoDateTime } from "../common";

// 운영 보강 계약(스펙 2026-09-25-ops-hardening-design.md 2.3·3.1·6장). 사건 detail 에는 id·코드·수치만 싣는다(8장)

/** 사건 종류 — 스펙 3.1 표 */
export const OpsEventKind = z.enum([
  "gateway_down",
  "plugin_down",
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
