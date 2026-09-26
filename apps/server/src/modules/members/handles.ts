import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { agents, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

/** 나간 멤버의 핸들 접두사(leftHandleOf) — 사람 가입·에이전트 등록·수정은 이것으로 시작하는 핸들을 쓰지 못한다 */
export const LEFT_HANDLE_PREFIX = "left-";

/**
 * 새로 쓸 핸들의 유일한 검사 — 사람 가입(accept.ts)·에이전트 등록·수정(agents/service.ts)이 함께 쓴다.
 * `left-` 로 시작하면 400 VALIDATION(나간 멤버 몫이라 예약), 멘션이 같은 이름공간이라 사람(users)·에이전트(agents)를 통틀어
 * 워크스페이스 안에서 겹치면 409 CONFLICT — 둘 다 field "handle". 나간 멤버의 옛 핸들(left_handle)은 비어 있다
 */
export function assertHandleFree(db: DbOrTx, workspaceId: string, handle: string): void {
  if (handle.startsWith(LEFT_HANDLE_PREFIX))
    throw apiError("VALIDATION", `handle 은 ${LEFT_HANDLE_PREFIX} 로 시작할 수 없다`, { field: "handle" });
  const person = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.workspaceId, workspaceId), eq(users.handle, handle)))
    .get();
  const agent = db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.handle, handle)))
    .get();
  if (person || agent)
    throw apiError("CONFLICT", `handle @${handle} 는 이미 쓰이고 있다`, { field: "handle" });
}
