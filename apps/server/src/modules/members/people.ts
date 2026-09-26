import { Person, TeamRole } from "@dodok/shared";
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { memberships, users } from "../../db/schema.sqlite";
import { parseStored } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";

/**
 * 워크스페이스 사람 전원 — 나간 멤버도 싣는다(작성자 표시가 필요하다). role 없음 = membership 없음(나간 멤버),
 * 모르는 역할(guest 등)도 role 을 싣지 않는다. 이메일은 싣지 않는다 — 로그인한 누구나 읽는 목록이다
 */
export function listPeople(db: DbOrTx, workspaceId: string): Person[] {
  return db
    .select({
      id: users.id,
      handle: users.handle,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      leftHandle: users.leftHandle,
      role: memberships.role,
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
          leftHandle: row.leftHandle ?? undefined,
          avatarUrl: row.avatarUrl ?? undefined,
        },
        "person",
      );
    });
}

/** 사람 목록이 바뀐 뒤(가입·역할·표시 이름·내보내기) 부른다 — 워크스페이스 방에 people.changed(지금 목록 전체) */
export function broadcastPeople(bus: ServerBus, db: DbOrTx, workspaceId: string): void {
  bus.emit("people.changed", { people: listPeople(db, workspaceId) });
}
