import { Person, TeamRole } from "@dodok/shared";
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { memberships, users } from "../../db/schema.sqlite";
import { parseStored } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import { messageOf } from "../profile/status";

/**
 * 워크스페이스 사람 전원 — 비활성 멤버도 deactivatedAt 과 함께 싣는다(작성자 표시가 필요하다). membership 이 없거나 모르는
 * 역할(guest 등)이면 role 을 싣지 않는다. 이메일은 싣지 않는다 — 로그인한 누구나 읽는 목록이다. 상태 메시지(만료가 지나지 않은 것)는
 * 싣고 수동 상태 모드·그 만료는 싣지 않는다 — 전원에게 같은 목록이라 「오프라인으로 보이기」가 드러난다(프로필 스펙 2장)
 */
export function listPeople(db: DbOrTx, workspaceId: string, now: Date = new Date()): Person[] {
  return db
    .select({
      id: users.id,
      handle: users.handle,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      statusEmoji: users.statusEmoji,
      statusText: users.statusText,
      statusTextUntil: users.statusTextUntil,
      role: memberships.role,
      deactivatedAt: memberships.deactivatedAt,
    })
    .from(users)
    .leftJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.workspaceId, workspaceId)))
    .where(eq(users.workspaceId, workspaceId))
    .orderBy(asc(users.createdAt), asc(users.id))
    .all()
    .map((row) => {
      const role = TeamRole.safeParse(row.role);
      return parseStored(
        Person,
        {
          id: row.id,
          handle: row.handle,
          displayName: row.displayName,
          role: role.success ? role.data : undefined,
          deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
          avatarUrl: row.avatarUrl ?? undefined,
          statusMessage: messageOf(row, now),
        },
        "person",
      );
    });
}

/** 사람 목록이 바뀐 뒤(가입·역할·표시 이름·비활성화·다시 활성화) 부른다 — 워크스페이스 방에 people.changed(지금 목록 전체) */
export function broadcastPeople(bus: ServerBus, db: DbOrTx, workspaceId: string): void {
  bus.emit("people.changed", { people: listPeople(db, workspaceId) });
}
