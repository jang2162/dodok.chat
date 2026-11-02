import type { PresenceEntry } from "@dodok/shared";
import { and, eq, notInArray } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client";
import { agents, memberships, runs, users } from "../../db/schema.sqlite";
import { modeOf } from "../profile/status";
import type { Presence } from "../push/presence";
import { TERMINAL_STATUSES } from "../runs/machine";
import { agentPresence, userPresence } from "./compute";

// 접속 허브(프로필 스펙 3.3) — 서버 메모리에서 유효 상태를 계산하고 이전 값과 다른 줄만 알린다. 메모리에만 있어 서버 재시작 직후
// 몇 초는 소켓이 다시 붙을 때까지 모두 오프라인이다(push/presence.ts 와 같은 성질)

/** 마지막 소켓이 끊긴 뒤 다시 붙기를 기다리는 시간 — 새로고침·재접속에 점이 깜빡이지 않게(스펙 3.2 「유예」) */
export const PRESENCE_GRACE_MS = 20_000;

const TERMINAL = [...TERMINAL_STATUSES];

/** 끝나지 않은 런이 있는 에이전트 — 어느 채널·대화의 런인지는 돌려주지 않는다(남의 DM 런이 드러나지 않게) */
export function openRunAgentIds(db: DbOrTx): Set<string> {
  return new Set(
    db
      .selectDistinct({ agentId: runs.agentId })
      .from(runs)
      .where(notInArray(runs.status, TERMINAL))
      .all()
      .map((r) => r.agentId),
  );
}

export type PresenceHub = {
  /** 지금 점 전체(사람·에이전트) — 계산하며 바뀐 줄이 있으면 그것도 알린다 */
  snapshot(): PresenceEntry[];
  recomputeUser(userId: string): void;
  recomputeAgents(): void;
  recomputeAll(): void;
  close(): void;
};

export function createPresenceHub(deps: {
  db: Db;
  workspaceId: string;
  presence: Pick<Presence, "socketsOf">;
  connectedAgentIds: () => ReadonlySet<string>;
  workingAgentIds: () => ReadonlySet<string>;
  emit: (entries: PresenceEntry[]) => void;
  graceMs?: number;
  now?: () => Date;
}): PresenceHub {
  const { db, workspaceId } = deps;
  const graceMs = deps.graceMs ?? PRESENCE_GRACE_MS;
  const now = deps.now ?? (() => new Date());
  /** 줄마다 마지막으로 알린 값 — `kind:id` → JSON */
  const last = new Map<string, string>();
  /** 마지막 소켓이 끊긴 사람의 유예 타이머 */
  const grace = new Map<string, ReturnType<typeof setTimeout>>();
  /** 사람마다 마지막으로 안 「보이는 탭이 있음」 — 유예 동안은 이 값으로 그린다 */
  const lastVisible = new Map<string, boolean>();
  let closed = false;

  const keyOf = (e: PresenceEntry) => `${e.kind}:${e.id}`;
  /**
   * 이전 값과 다른 줄만 남기고 기억한다. quietNew 면 처음 보는 줄은 기억만 한다 — 스냅숏은 받는 소켓이 통째로 받으므로 처음 계산한
   * 줄을 전원에게 다시 알릴 까닭이 없다(알던 줄이 바뀐 것만 알린다)
   */
  const diff = (entries: PresenceEntry[], quietNew: boolean): PresenceEntry[] =>
    entries.filter((e) => {
      const json = JSON.stringify(e);
      const before = last.get(keyOf(e));
      if (before === json) return false;
      last.set(keyOf(e), json);
      return !(quietNew && before === undefined);
    });
  const publish = (entries: PresenceEntry[], quietNew = false) => {
    const changed = diff(entries, quietNew);
    if (changed.length > 0) deps.emit(changed);
  };

  const userRows = (userId?: string) =>
    db
      .select({
        id: users.id,
        statusMode: users.statusMode,
        statusModeUntil: users.statusModeUntil,
        role: memberships.role,
        deactivatedAt: memberships.deactivatedAt,
      })
      .from(users)
      .leftJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.workspaceId, workspaceId)))
      .where(userId === undefined ? eq(users.workspaceId, workspaceId) : eq(users.id, userId))
      .all();

  function userEntry(row: ReturnType<typeof userRows>[number], at: Date): PresenceEntry {
    const sockets = deps.presence.socketsOf(row.id);
    if (sockets.count > 0) {
      const timer = grace.get(row.id);
      if (timer) clearTimeout(timer);
      grace.delete(row.id);
      lastVisible.set(row.id, sockets.anyVisible);
    } else if (lastVisible.has(row.id) && !grace.has(row.id)) {
      // 막 끊겼다 — 유예가 지나면 다시 계산한다(그 안에 붙으면 위에서 타이머를 지운다)
      const timer = setTimeout(() => {
        grace.delete(row.id);
        lastVisible.delete(row.id);
        recomputeUser(row.id);
      }, graceMs);
      timer.unref?.();
      grace.set(row.id, timer);
    }
    const { mode, modeUntil } = modeOf(row, at);
    return {
      kind: "user",
      id: row.id,
      ...userPresence({
        // membership 이 없는 사람(guest 등)도 점이 없다
        deactivated: row.role === null || row.deactivatedAt !== null,
        mode,
        modeUntil,
        sockets: sockets.count,
        anyVisible: sockets.count > 0 ? sockets.anyVisible : (lastVisible.get(row.id) ?? false),
        inGrace: grace.has(row.id),
      }),
    };
  }

  function agentEntries(): PresenceEntry[] {
    const connected = deps.connectedAgentIds();
    const working = deps.workingAgentIds();
    return db
      .select({ id: agents.id, enabled: agents.enabled, archivedAt: agents.archivedAt })
      .from(agents)
      .where(eq(agents.workspaceId, workspaceId))
      .all()
      .map((a) => ({
        kind: "agent" as const,
        id: a.id,
        state: agentPresence({
          archived: a.archivedAt !== null,
          enabled: a.enabled,
          connected: connected.has(a.id),
          working: working.has(a.id),
        }),
      }));
  }

  function recomputeUser(userId: string): void {
    if (closed) return;
    const at = now();
    publish(userRows(userId).map((row) => userEntry(row, at)));
  }

  function allEntries(): PresenceEntry[] {
    const at = now();
    return [...userRows().map((row) => userEntry(row, at)), ...agentEntries()];
  }

  return {
    snapshot() {
      const entries = allEntries();
      publish(entries, true);
      return entries;
    },
    recomputeUser,
    recomputeAgents: () => {
      if (!closed) publish(agentEntries());
    },
    recomputeAll: () => {
      if (!closed) publish(allEntries());
    },
    close() {
      closed = true;
      for (const timer of grace.values()) clearTimeout(timer);
      grace.clear();
    },
  };
}
