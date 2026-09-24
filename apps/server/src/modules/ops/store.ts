import { OpsEvent, type OpsEventKind, type OpsSeverity, type OpsUnacked } from "@dodok/shared";
import { and, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "../../db/client";
import { opsEvents } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { OpsRecordInput } from "./service";

/** 같은 kind·key 를 한 줄로 묶는 창 — 마지막 기록(last_at)부터 잰다(스펙 3.1) */
export const OPS_GROUP_WINDOW_MS = 3_600_000;
/** last_at 이 이만큼 지난 줄은 지운다 */
export const OPS_RETENTION_MS = 30 * 24 * 3_600_000;
export const OPS_PAGE_SIZE = 50;
const OPS_PAGE_MAX = 200;

/** 끊김 사건 — 1시간 창 대신 resolved_at 이 채워질 때까지 한 줄이다 */
const DOWN_KINDS: ReadonlySet<OpsEventKind> = new Set(["gateway_down", "plugin_down"]);
const SEVERITY_RANK: Record<OpsSeverity, number> = { info: 0, warn: 1, error: 2 };

type Row = typeof opsEvents.$inferSelect;

export function toOpsEvent(row: Row): OpsEvent {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    key: row.key,
    detail: row.detail,
    count: row.count,
    firstAt: row.firstAt.toISOString(),
    lastAt: row.lastAt.toISOString(),
    ...(row.resolvedAt ? { resolvedAt: row.resolvedAt.toISOString() } : {}),
    ...(row.ackedAt ? { ackedAt: row.ackedAt.toISOString() } : {}),
  };
}

/** 저장하려는 key·detail 이 shared OpsEvent 모양을 어겼다. 값은 싣지 않는다(토큰·경로가 로그로 새지 않게) — 어긴 자리와 코드만 */
export class OpsShapeError extends Error {
  constructor(readonly issues: Array<{ path: string; code: string }>) {
    super("ops event shape rejected");
    this.name = "OpsShapeError";
  }
}

/** 쓰기 직전의 최종 key·detail(묶기·닫기 병합 뒤)을 shared 스키마로 검사한다. 어기면 OpsShapeError */
function assertStorable(key: string, detail: unknown): void {
  const issues = [
    ...(OpsEvent.shape.key.safeParse(key).error?.issues ?? []).map((i) => ({
      ...i,
      path: ["key", ...i.path],
    })),
    ...(OpsEvent.shape.detail.safeParse(detail).error?.issues ?? []).map((i) => ({
      ...i,
      path: ["detail", ...i.path],
    })),
  ];
  if (issues.length > 0)
    throw new OpsShapeError(issues.map((i) => ({ path: i.path.map(String).join("."), code: i.code })));
}

/** 기록이 줄을 어떻게 바꿨나 — created·raised 는 unacked 수가 바뀔 수 있고, grouped 는 count·last_at·detail 만 바뀐다 */
export type OpsRecordChange = "created" | "raised" | "grouped";

export function recordEvent(db: DbOrTx, workspaceId: string, input: OpsRecordInput, now: Date): OpsEvent {
  return recordEventChange(db, workspaceId, input, now).event;
}

/**
 * 묶기 규칙을 한 트랜잭션에서 적용한다 — 열린 줄이 있으면 count·last_at 을 올리고 detail 은 새 값으로 덮으며
 * severity 는 더 높은 쪽을 남긴다. 없으면 새 줄. 끊김 사건은 확인 여부와 상관없이 닫히기 전까지 같은 줄이다.
 * 병합한 key·detail 이 모양을 어기면 아무것도 쓰지 않고 OpsShapeError 를 던진다
 */
export function recordEventChange(
  db: DbOrTx,
  workspaceId: string,
  input: OpsRecordInput,
  now: Date,
): { event: OpsEvent; change: OpsRecordChange } {
  const detail = input.detail ?? {};
  assertStorable(input.key, detail);
  return db.transaction((tx) => {
    const same = and(
      eq(opsEvents.workspaceId, workspaceId),
      eq(opsEvents.kind, input.kind),
      eq(opsEvents.key, input.key),
    );
    const open = DOWN_KINDS.has(input.kind)
      ? and(same, isNull(opsEvents.resolvedAt))
      : and(
          same,
          isNull(opsEvents.ackedAt),
          gte(opsEvents.lastAt, new Date(now.getTime() - OPS_GROUP_WINDOW_MS)),
        );
    const found = tx.select().from(opsEvents).where(open).orderBy(desc(opsEvents.lastAt)).limit(1).get();
    if (found) {
      const raised = SEVERITY_RANK[input.severity] > SEVERITY_RANK[found.severity];
      const merged = { ...found.detail, ...detail };
      assertStorable(input.key, merged);
      const updated = tx
        .update(opsEvents)
        .set({
          count: sql`${opsEvents.count} + 1`,
          lastAt: now,
          severity: raised ? input.severity : found.severity,
          detail: merged,
        })
        .where(eq(opsEvents.id, found.id))
        .returning()
        .get();
      return { event: toOpsEvent(updated), change: raised ? "raised" : "grouped" };
    }
    const inserted = tx
      .insert(opsEvents)
      .values({
        id: uuidv7(),
        workspaceId,
        kind: input.kind,
        severity: input.severity,
        key: input.key,
        detail,
        count: 1,
        firstAt: now,
        lastAt: now,
      })
      .returning()
      .get();
    return { event: toOpsEvent(inserted), change: "created" };
  });
}

/**
 * 열린 끊김 줄을 닫는다 — resolved_at·last_at 을 at 으로, detail.downMs = at - first_at + detail.thresholdMs(없으면 0).
 * 줄은 끊긴 지 임계만큼 지나서 열리므로 임계를 더해야 실제로 끊긴 시간이다. 열린 줄이 없으면 null.
 * 병합한 detail 이 모양을 어기면 닫지 않고 OpsShapeError
 */
export function resolveEvent(
  db: DbOrTx,
  workspaceId: string,
  kind: "gateway_down" | "plugin_down",
  key: string,
  at: Date,
): OpsEvent | null {
  return db.transaction((tx) => {
    const found = tx
      .select()
      .from(opsEvents)
      .where(
        and(
          eq(opsEvents.workspaceId, workspaceId),
          eq(opsEvents.kind, kind),
          eq(opsEvents.key, key),
          isNull(opsEvents.resolvedAt),
        ),
      )
      .orderBy(desc(opsEvents.lastAt))
      .limit(1)
      .get();
    if (!found) return null;
    const threshold = typeof found.detail.thresholdMs === "number" ? found.detail.thresholdMs : 0;
    const detail = { ...found.detail, downMs: at.getTime() - found.firstAt.getTime() + threshold };
    assertStorable(found.key, detail);
    const updated = tx
      .update(opsEvents)
      .set({ resolvedAt: at, lastAt: at, detail })
      .where(eq(opsEvents.id, found.id))
      .returning()
      .get();
    return toOpsEvent(updated);
  });
}

/** last_at 이 upTo 이하인 확인 안 한 줄을 at 에 확인 처리하고 그 줄들을 돌려준다 */
export function ackEvents(db: DbOrTx, workspaceId: string, upTo: Date, at: Date): OpsEvent[] {
  return db
    .update(opsEvents)
    .set({ ackedAt: at })
    .where(
      and(eq(opsEvents.workspaceId, workspaceId), isNull(opsEvents.ackedAt), lte(opsEvents.lastAt, upTo)),
    )
    .returning()
    .all()
    .map(toOpsEvent);
}

/** 확인 안 한 warn·error 줄 수(count 합이 아니라 줄 수). info 는 세지 않는다 */
export function unackedCounts(db: DbOrTx, workspaceId: string): OpsUnacked {
  const counts = db
    .select({ severity: opsEvents.severity, n: sql<number>`count(*)` })
    .from(opsEvents)
    .where(and(eq(opsEvents.workspaceId, workspaceId), isNull(opsEvents.ackedAt)))
    .groupBy(opsEvents.severity)
    .all();
  const of = (severity: OpsSeverity) => counts.find((c) => c.severity === severity)?.n ?? 0;
  return { warn: of("warn"), error: of("error") };
}

/**
 * 그 kind 의 줄 가운데 last_at 이 since 이후(같음 포함)인 줄의 count 를 key 별로 더한다 — 확인한 줄도 센다.
 * 줄은 1시간 창으로 묶이므로 since 직전에 시작해 since 뒤까지 이어진 줄의 count 는 통째로 들어온다
 */
export function sumCountsSince(
  db: DbOrTx,
  workspaceId: string,
  kind: OpsEventKind,
  since: Date,
): Map<string, number> {
  const rows = db
    .select({ key: opsEvents.key, n: sql<number>`sum(${opsEvents.count})` })
    .from(opsEvents)
    .where(
      and(eq(opsEvents.workspaceId, workspaceId), eq(opsEvents.kind, kind), gte(opsEvents.lastAt, since)),
    )
    .groupBy(opsEvents.key)
    .all();
  return new Map(rows.map((r) => [r.key, r.n]));
}

/**
 * last_at 내림차순(같으면 id 내림차순) 페이지. 커서는 마지막 줄의 「last_at 밀리초:id」 —
 * 페이지 사이에 줄이 묶여 last_at 이 올라가면 그 줄은 앞 페이지로 옮겨 가 이번 순회에서 빠질 수 있다
 */
export function listEvents(
  db: DbOrTx,
  workspaceId: string,
  opts: { cursor?: string; severity?: OpsSeverity; limit?: number },
): { events: OpsEvent[]; nextCursor?: string } {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? OPS_PAGE_SIZE), 1), OPS_PAGE_MAX);
  const after = opts.cursor === undefined ? undefined : parseCursor(opts.cursor);
  const rows = db
    .select()
    .from(opsEvents)
    .where(
      and(
        eq(opsEvents.workspaceId, workspaceId),
        opts.severity ? eq(opsEvents.severity, opts.severity) : undefined,
        after
          ? or(
              lt(opsEvents.lastAt, after.lastAt),
              and(eq(opsEvents.lastAt, after.lastAt), lt(opsEvents.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(opsEvents.lastAt), desc(opsEvents.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page.map(toOpsEvent),
    ...(rows.length > limit && last ? { nextCursor: `${last.lastAt.getTime()}:${last.id}` } : {}),
  };
}

/** last_at 이 now - 30일 보다 앞인 줄을 지우고 그 수를 돌려준다 */
export function sweepEvents(db: DbOrTx, workspaceId: string, now: Date): number {
  return db
    .delete(opsEvents)
    .where(
      and(
        eq(opsEvents.workspaceId, workspaceId),
        lt(opsEvents.lastAt, new Date(now.getTime() - OPS_RETENTION_MS)),
      ),
    )
    .run().changes;
}

function parseCursor(cursor: string): { lastAt: Date; id: string } {
  const match = /^(\d{1,15}):([0-9a-f-]{36})$/.exec(cursor);
  if (!match) throw apiError("VALIDATION", "invalid cursor");
  return { lastAt: new Date(Number(match[1])), id: match[2] as string };
}
