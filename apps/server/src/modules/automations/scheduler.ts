/**
 * 예약 자동화 스케줄러(자동화 스펙 「스케줄러」 절) — app.ts 가 부팅 때 한 번, 그 뒤 automationTickMs 마다 tick(now) 를 돈다.
 * 한 회차는 claimRun 의 조건부 UPDATE 로 가져간 틱만 게시한다(계획 판정 PA3) — 틱이 겹치거나 서버를 연달아 다시 켜도 한 번이다.
 * 자동화 하나의 실패는 그 자동화의 last_status = error 와 운영 사건으로 남기고 틱은 다음 자동화로 이어 간다.
 */
import type { AutomationSchedule } from "@dodok/shared";
import type { DbOrTx } from "../../db/client";
import { apiError, HttpError } from "../../http/errors";
import type { OpsService } from "../ops/service";
import { type PostDeps, postAutomationMessage } from "./post";
import { nextRunAt } from "./schedule";
import {
  type AutomationRow,
  claimRun,
  dueSchedules,
  getAutomation,
  listAutomations,
  updateAutomation,
} from "./store";

/**
 * 놓친 회차를 그래도 게시하는 늦음의 상한(자동화 스펙 결정 5) — 넘으면 게시하지 않고 skipped. 서버가 오래 꺼졌다 켜질 때 밀린 예약을
 * 몰아 돌리면 런 비용이 한꺼번에 난다
 */
export const MISSED_GRACE_MS = 10 * 60_000;

export type SchedulerDeps = PostDeps & {
  ops: Pick<OpsService, "record">;
  /** 워크스페이스 시간대 — 틱마다 한 번 읽는다(getOpsSettings 는 모르는 이름이면 기본값을 준다) */
  timeZone: () => string;
};

/** 켜진 예약 가운데 next_run_at 이 now 이하인 것을 이른 차례로 돈다 */
export async function tick(deps: SchedulerDeps, now: Date): Promise<void> {
  const timeZone = deps.timeZone();
  for (const automation of dueSchedules(deps.db, now)) {
    try {
      await runDue(deps, automation, timeZone, now);
    } catch (err) {
      // 회차를 가져가거나 결과를 적다 DB 가 던진 것 — 그 자동화만 넘기고 틱은 이어 간다
      deps.logger.error({ err, automationId: automation.id }, "automation tick failed");
    }
  }
}

async function runDue(deps: SchedulerDeps, a: AutomationRow, timeZone: string, now: Date): Promise<void> {
  // dueSchedules 가 next_run_at <= now 로 골랐으므로 비어 있지 않다
  const seen = a.nextRunAt as Date;
  let next: Date;
  try {
    next = nextRunAt(a.scheduleJson as AutomationSchedule, timeZone, now);
  } catch (err) {
    // 다음 시각을 셀 수 없다(DB 를 직접 고친 예약 등) — 그대로 두면 매분 같은 실패를 되풀이하므로 그 예약을 멈춘다.
    // 예약을 고치거나 켜면(rescheduleOne), 시간대를 바꾸면(rescheduleAll) 다시 센다
    if (claimRun(deps.db, a.id, seen, null, now)) markFailed(deps, a, err);
    return;
  }
  if (!claimRun(deps.db, a.id, seen, next, now)) return; // 다른 틱이 가져갔거나 그사이 끄기·예약 변경
  const lateMs = now.getTime() - seen.getTime();
  if (lateMs > MISSED_GRACE_MS) {
    updateAutomation(deps.db, a.workspaceId, a.id, { lastStatus: "skipped" });
    deps.ops.record({
      kind: "automation_skipped",
      key: `automation:${a.id}`,
      severity: "warn",
      detail: { automationId: a.id, lateMs },
    });
    return;
  }
  try {
    await postAutomationMessage(deps, a);
  } catch (err) {
    markFailed(deps, a, err);
    return;
  }
  updateAutomation(deps.db, a.workspaceId, a.id, { lastStatus: "ok" });
}

/**
 * 게시 실패를 그 자동화의 결과(error)와 운영 사건 automation_failed 로 남긴다 — 예약 틱과 웹훅이 쓴다. 보관한 채널(CHANNEL_ARCHIVED) 같은
 * HttpError 는 그 코드를 사건에 싣는다 — 운영 화면이 사유를 보인다
 */
export function markFailed(
  deps: Pick<SchedulerDeps, "db" | "ops" | "logger">,
  a: AutomationRow,
  err: unknown,
): void {
  const code = err instanceof HttpError ? err.body.code : undefined;
  updateAutomation(deps.db, a.workspaceId, a.id, { lastStatus: "error" });
  deps.ops.record({
    kind: "automation_failed",
    key: `automation:${a.id}`,
    severity: "error",
    detail: { automationId: a.id, ...(code === undefined ? {} : { code }) },
  });
  deps.logger.error({ err, automationId: a.id }, "automation post failed");
}

/** 켜진 예약이면 now 뒤 첫 회차, 꺼졌거나 웹훅이면 null */
function firstRunAfter(a: AutomationRow, timeZone: string, now: Date): Date | null {
  return a.enabled && a.kind === "schedule" && a.scheduleJson !== null
    ? nextRunAt(a.scheduleJson, timeZone, now)
    : null;
}

/**
 * 켜진 예약이면 now 뒤 첫 회차, 꺼졌거나 웹훅이면 null 로 next_run_at 을 둔다 — 켜기·예약 변경·만들기가 부른다. 켜는 순간의 now 로
 * 세므로 끈 사이 지나간 시각이 바로 터지지 않는다. 없으면 NOT_FOUND
 */
export function rescheduleOne(
  db: DbOrTx,
  workspaceId: string,
  id: string,
  timeZone: string,
  now: Date,
): void {
  const a = getAutomation(db, workspaceId, id);
  if (!a) throw apiError("NOT_FOUND", "automation not found");
  updateAutomation(db, workspaceId, id, { nextRunAt: firstRunAfter(a, timeZone, now) });
}

/** 시간대를 바꾼 뒤 그 워크스페이스의 켜진 예약을 모두 새 시간대로 다시 센다(계획 판정 PA4) — 멈춰 있던 것(null)도 */
export function rescheduleAll(db: DbOrTx, workspaceId: string, timeZone: string, now: Date): void {
  for (const a of listAutomations(db, workspaceId)) {
    if (a.enabled && a.kind === "schedule") {
      updateAutomation(db, workspaceId, a.id, { nextRunAt: firstRunAfter(a, timeZone, now) });
    }
  }
}
