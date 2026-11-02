import type { MyStatus, StatusMessage, StatusMode, UpdateMyStatusBody } from "@dodok/shared";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client";
import { users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { ServerBus } from "../../realtime/bus";
import { broadcastPeople } from "../members/people";

// 사람의 상태(프로필 스펙 3.2·3.3) — 수동 모드·만료·방해 금지 옵션은 본인에게만(`/auth/me`·user 룸 `me.status`), 상태 메시지는
// 사람 목록(people.changed)에 실린다. until 이 지난 값은 읽을 때도 없는 것으로 본다 — 만료 타이머가 늦어도 틀린 값이 보이지 않게

type StatusRow = Pick<
  typeof users.$inferSelect,
  "statusMode" | "statusModeUntil" | "statusEmoji" | "statusText" | "statusTextUntil" | "dndAllowApprovals"
>;

const statusColumns = {
  statusMode: users.statusMode,
  statusModeUntil: users.statusModeUntil,
  statusEmoji: users.statusEmoji,
  statusText: users.statusText,
  statusTextUntil: users.statusTextUntil,
  dndAllowApprovals: users.dndAllowApprovals,
};

const live = (until: Date | null, now: Date) => until === null || until.getTime() > now.getTime();

/** 행의 상태 메시지 — 글이 없거나 만료가 지났으면 null. 사람 목록(listPeople)도 이것으로 싣는다 */
export function messageOf(
  row: Pick<StatusRow, "statusEmoji" | "statusText" | "statusTextUntil">,
  now: Date,
): StatusMessage | null {
  if (row.statusText === null || !live(row.statusTextUntil, now)) return null;
  return {
    emoji: row.statusEmoji,
    text: row.statusText,
    until: row.statusTextUntil?.toISOString() ?? null,
  };
}

/** 행의 유효한 수동 모드 — 만료가 지났으면 auto */
export function modeOf(
  row: Pick<StatusRow, "statusMode" | "statusModeUntil">,
  now: Date,
): { mode: StatusMode; modeUntil: string | null } {
  if (row.statusMode === "auto" || !live(row.statusModeUntil, now)) return { mode: "auto", modeUntil: null };
  return { mode: row.statusMode, modeUntil: row.statusModeUntil?.toISOString() ?? null };
}

function statusOf(row: StatusRow, now: Date): MyStatus {
  return { ...modeOf(row, now), message: messageOf(row, now), dndAllowApprovals: row.dndAllowApprovals };
}

function rowOf(db: DbOrTx, userId: string): StatusRow {
  const row = db.select(statusColumns).from(users).where(eq(users.id, userId)).get();
  if (!row) throw apiError("NOT_FOUND", "user not found");
  return row;
}

export function readMyStatus(db: DbOrTx, userId: string, now: Date): MyStatus {
  return statusOf(rowOf(db, userId), now);
}

/** 방해 금지인가(만료가 지났으면 아니다) — 접속과 상관없다. 푸시 거르기(push/service.ts forUser)가 쓴다 */
export function dndState(
  db: DbOrTx,
  userId: string,
  now: Date,
): { active: boolean; allowApprovals: boolean } {
  const row = db.select(statusColumns).from(users).where(eq(users.id, userId)).get();
  if (!row) return { active: false, allowApprovals: true };
  return { active: modeOf(row, now).mode === "dnd", allowApprovals: row.dndAllowApprovals };
}

function assertFuture(iso: string | null | undefined, field: string, now: Date): void {
  if (iso != null && new Date(iso).getTime() <= now.getTime())
    throw apiError("VALIDATION", "만료 시각은 지금보다 뒤여야 한다", { field });
}

/**
 * 보낸 칸만 바꾼다. mode 를 보내면 modeUntil 도 그 값(없으면 null)으로 — 이전 만료가 새 모드에 남지 않는다. 과거 만료는 VALIDATION.
 * messageChanged·modeChanged 는 읽히는 값(만료 반영)이 바뀌었는가 — people.changed·presence 재계산을 부를지 가른다
 */
export function updateMyStatus(
  db: Db,
  userId: string,
  body: UpdateMyStatusBody,
  now: Date,
): { status: MyStatus; messageChanged: boolean; modeChanged: boolean } {
  return db.transaction((tx) => {
    const before = statusOf(rowOf(tx, userId), now);
    const set: Partial<typeof users.$inferInsert> = {};
    if (body.mode !== undefined || body.modeUntil !== undefined) {
      const mode = body.mode ?? before.mode;
      const modeUntil = body.modeUntil ?? null;
      if (mode === "auto" && modeUntil !== null)
        throw apiError("VALIDATION", "자동 상태에는 만료를 걸 수 없다", { field: "modeUntil" });
      assertFuture(modeUntil, "modeUntil", now);
      set.statusMode = mode;
      set.statusModeUntil = modeUntil === null ? null : new Date(modeUntil);
    }
    if (body.message !== undefined) {
      assertFuture(body.message?.until, "message.until", now);
      set.statusEmoji = body.message?.emoji ?? null;
      set.statusText = body.message?.text ?? null;
      set.statusTextUntil = body.message?.until ? new Date(body.message.until) : null;
    }
    if (body.dndAllowApprovals !== undefined) set.dndAllowApprovals = body.dndAllowApprovals;
    if (Object.keys(set).length > 0) tx.update(users).set(set).where(eq(users.id, userId)).run();
    const status = statusOf(rowOf(tx, userId), now);
    return {
      status,
      messageChanged: JSON.stringify(before.message) !== JSON.stringify(status.message),
      modeChanged: before.mode !== status.mode || before.modeUntil !== status.modeUntil,
    };
  });
}

/** 지난 수동 모드·상태 메시지를 DB 에서 지우고 바뀐 사람을 돌려준다 */
export function expireStatuses(db: Db, now: Date): { messageUserIds: string[]; modeUserIds: string[] } {
  return db.transaction((tx) => {
    const messageUserIds = tx
      .update(users)
      .set({ statusEmoji: null, statusText: null, statusTextUntil: null })
      .where(and(isNotNull(users.statusTextUntil), lte(users.statusTextUntil, now)))
      .returning({ id: users.id })
      .all()
      .map((r) => r.id);
    const modeUserIds = tx
      .update(users)
      .set({ statusMode: "auto", statusModeUntil: null })
      .where(and(isNotNull(users.statusModeUntil), lte(users.statusModeUntil, now)))
      .returning({ id: users.id })
      .all()
      .map((r) => r.id);
    return { messageUserIds, modeUserIds };
  });
}

/** 만료 확인 주기 — 스펙 3.2 「1분 이하」. 읽을 때도 지난 값은 지난 것으로 보므로 이 주기는 알림이 늦는 시간일 뿐이다 */
export const STATUS_EXPIRY_INTERVAL_MS = 30_000;

/**
 * 만료 타이머 — 주기마다 expireStatuses. 메시지가 진 사람이 있으면 people.changed 한 번, 바뀐 사람마다 me.status(user 룸),
 * 모드가 진 사람마다 onModeChanged(접속 점 재계산). tick 은 시험이 직접 부른다
 */
export function startStatusExpiry(deps: {
  db: Db;
  bus: ServerBus;
  workspaceId: string;
  onModeChanged?: (userId: string) => void;
  /** 틱이 던지면 — 타이머 콜백의 예외는 프로세스를 죽인다 */
  onError?: (err: unknown) => void;
  now?: () => Date;
  intervalMs?: number;
}): { tick(): void; close(): void } {
  const now = deps.now ?? (() => new Date());
  const tick = () => {
    const at = now();
    const { messageUserIds, modeUserIds } = expireStatuses(deps.db, at);
    if (messageUserIds.length > 0) broadcastPeople(deps.bus, deps.db, deps.workspaceId);
    for (const userId of new Set([...messageUserIds, ...modeUserIds]))
      deps.bus.emit("me.status", { userId, status: readMyStatus(deps.db, userId, at) });
    for (const userId of modeUserIds) deps.onModeChanged?.(userId);
  };
  const timer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      deps.onError?.(err);
    }
  }, deps.intervalMs ?? STATUS_EXPIRY_INTERVAL_MS);
  timer.unref();
  return { tick, close: () => clearInterval(timer) };
}
