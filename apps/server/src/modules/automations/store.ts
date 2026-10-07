/**
 * 자동화 저장소(자동화 스펙 「데이터 모델」 절). 워크스페이스를 받는 함수는 다른 워크스페이스의 행을 보지도 바꾸지도 않는다.
 * 스케줄러 쪽(dueSchedules·claimRun)은 워크스페이스를 가리지 않는다 — 틱 하나가 서버의 모든 예약을 돈다.
 */
import { and, asc, eq, lte, ne } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { automations } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

export type AutomationRow = typeof automations.$inferSelect;
export type NewAutomationRow = typeof automations.$inferInsert;
/** 바꿀 수 있는 칸 — id·워크스페이스는 옮기지 않는다 */
export type AutomationPatch = Partial<Omit<NewAutomationRow, "id" | "workspaceId">>;

/** 이름은 워크스페이스 안에서 유일 — 유일 인덱스가 막기 전에 칸 오류로 돌려준다(웹 대화상자가 이름 칸에 띄운다) */
function assertNameFree(db: DbOrTx, workspaceId: string, name: string, exceptId?: string): void {
  const taken = db
    .select({ id: automations.id })
    .from(automations)
    .where(
      and(
        eq(automations.workspaceId, workspaceId),
        eq(automations.name, name),
        exceptId === undefined ? undefined : ne(automations.id, exceptId),
      ),
    )
    .get();
  if (taken) throw apiError("CONFLICT", "automation name is already used", { field: "name" });
}

const inWorkspace = (workspaceId: string, id: string) =>
  and(eq(automations.id, id), eq(automations.workspaceId, workspaceId));

/** 만든 차례(같은 시각이면 id — uuid v7 이라 만든 차례) */
export function listAutomations(db: DbOrTx, workspaceId: string): AutomationRow[] {
  return db
    .select()
    .from(automations)
    .where(eq(automations.workspaceId, workspaceId))
    .orderBy(asc(automations.createdAt), asc(automations.id))
    .all();
}

export function getAutomation(db: DbOrTx, workspaceId: string, id: string): AutomationRow | undefined {
  return db.select().from(automations).where(inWorkspace(workspaceId, id)).get();
}

/** 이름이 겹치면 CONFLICT(details.field = "name") */
export function insertAutomation(db: DbOrTx, row: NewAutomationRow): AutomationRow {
  assertNameFree(db, row.workspaceId, row.name);
  return db.insert(automations).values(row).returning().get();
}

/** 준 칸만 바꾼다(undefined 칸은 두고, updatedAt 도 부르는 쪽이 준다). 없으면 NOT_FOUND, 다른 행의 이름이면 CONFLICT */
export function updateAutomation(
  db: DbOrTx,
  workspaceId: string,
  id: string,
  patch: AutomationPatch,
): AutomationRow {
  if (patch.name !== undefined) assertNameFree(db, workspaceId, patch.name, id);
  // 바꿀 칸이 없으면 drizzle 이 「No values to set」 으로 던진다 — 빈 PATCH 본문도 통과하는 계약이라 읽기로 대신한다
  const row = Object.values(patch).some((v) => v !== undefined)
    ? db.update(automations).set(patch).where(inWorkspace(workspaceId, id)).returning().get()
    : getAutomation(db, workspaceId, id);
  if (!row) throw apiError("NOT_FOUND", "automation not found");
  return row;
}

/** 게시한 메시지는 남는다(author_id 는 FK 가 아니다). 없으면 NOT_FOUND */
export function deleteAutomation(db: DbOrTx, workspaceId: string, id: string): void {
  const deleted = db
    .delete(automations)
    .where(inWorkspace(workspaceId, id))
    .returning({ id: automations.id })
    .all();
  if (deleted.length === 0) throw apiError("NOT_FOUND", "automation not found");
}

/** 켜진 예약 가운데 next_run_at 이 now 이하인 행, 이른 차례로 */
export function dueSchedules(db: DbOrTx, now: Date): AutomationRow[] {
  return db
    .select()
    .from(automations)
    .where(
      and(eq(automations.enabled, true), eq(automations.kind, "schedule"), lte(automations.nextRunAt, now)),
    )
    .orderBy(asc(automations.nextRunAt), asc(automations.id))
    .all();
}

/**
 * 이번 회차를 가져간다(계획 판정 PA3) — next_run_at 이 읽은 seen 그대로일 때만 next 로 올리고 true. 틱이 겹치거나 그사이 끄기·예약
 * 변경으로 next_run_at 이 바뀌었으면 false 이고 행을 건드리지 않는다. true 일 때만 게시한다. next 가 null 이면 그 예약을 멈춘다
 * (다음 시각을 셀 수 없을 때 — 다시 세는 것은 rescheduleOne·rescheduleAll)
 */
export function claimRun(db: DbOrTx, id: string, seen: Date, next: Date | null, now: Date): boolean {
  const result = db
    .update(automations)
    .set({ nextRunAt: next, lastRunAt: now })
    .where(and(eq(automations.id, id), eq(automations.nextRunAt, seen)))
    .run();
  return result.changes === 1;
}
