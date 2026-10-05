import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { agents, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

/**
 * 새로 쓸 핸들의 유일한 검사 — 사람 가입(accept.ts)·에이전트 등록·수정(agents/service.ts)이 함께 쓴다.
 * 멘션이 같은 이름공간이라 사람(users)·에이전트(agents)를 통틀어 워크스페이스 안에서 겹치면 409 CONFLICT field "handle".
 * 비활성 멤버의 핸들도 그 사람 몫이라 겹침이다
 */
export function assertHandleFree(db: DbOrTx, workspaceId: string, handle: string): void {
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
