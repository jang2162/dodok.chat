import { Agent } from "@dodok/shared";
import { and, asc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { agents } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";

type AgentRow = typeof agents.$inferSelect;

export type CreateAgentInput = {
  workspaceId: string;
  provider?: "openclaw";
  providerAgentId: string;
  handle: string;
  name: string;
  avatarUrl?: string;
  basePrompt?: string;
  enabled?: boolean;
};

/** null 은 값을 지운다 */
export type AgentPatch = {
  handle?: string;
  name?: string;
  avatarUrl?: string | null;
  basePrompt?: string | null;
  enabled?: boolean;
};

export function rowToAgent(row: AgentRow): Agent {
  return parseStored(
    Agent,
    {
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider,
      providerAgentId: row.providerAgentId,
      handle: row.handle,
      name: row.name,
      avatarUrl: row.avatarUrl ?? undefined,
      basePrompt: row.basePrompt ?? undefined,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
    },
    "agent",
  );
}

export function createAgent(db: Db, input: CreateAgentInput): Agent {
  const provider = input.provider ?? "openclaw";
  return db.transaction((tx) => {
    assertHandleFree(tx, input.workspaceId, input.handle);
    const sameProvider = tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, input.workspaceId),
          eq(agents.provider, provider),
          eq(agents.providerAgentId, input.providerAgentId),
        ),
      )
      .get();
    if (sameProvider) {
      throw apiError("CONFLICT", `providerAgentId ${input.providerAgentId} 는 이미 등록돼 있다`, {
        field: "providerAgentId",
      });
    }
    const row = tx
      .insert(agents)
      .values({
        id: uuidv7(),
        workspaceId: input.workspaceId,
        provider,
        providerAgentId: input.providerAgentId,
        handle: input.handle,
        name: input.name,
        avatarUrl: input.avatarUrl ?? null,
        basePrompt: input.basePrompt ?? null,
        enabled: input.enabled ?? true,
        createdAt: new Date(),
      })
      .returning()
      .get();
    return rowToAgent(row);
  });
}

export function updateAgent(db: Db, id: string, patch: AgentPatch): Agent {
  return db.transaction((tx) => {
    const current = tx.select().from(agents).where(eq(agents.id, id)).get();
    if (!current) throw apiError("NOT_FOUND", "agent not found");
    if (patch.handle !== undefined && patch.handle !== current.handle) {
      assertHandleFree(tx, current.workspaceId, patch.handle);
    }
    const set: Partial<AgentRow> = {};
    if (patch.handle !== undefined) set.handle = patch.handle;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.avatarUrl !== undefined) set.avatarUrl = patch.avatarUrl;
    if (patch.basePrompt !== undefined) set.basePrompt = patch.basePrompt;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (Object.keys(set).length === 0) return rowToAgent(current);
    const row = tx.update(agents).set(set).where(eq(agents.id, id)).returning().get();
    if (!row) throw apiError("NOT_FOUND", "agent not found");
    return rowToAgent(row);
  });
}

export function listAgents(db: DbOrTx, workspaceId: string): Agent[] {
  return db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .all()
    .map(rowToAgent);
}

/** workspaceId 를 주면 그 워크스페이스 것만 찾는다(REST 는 항상 준다). */
export function getAgent(db: DbOrTx, id: string, workspaceId?: string): Agent | undefined {
  const row = db
    .select()
    .from(agents)
    .where(
      and(eq(agents.id, id), workspaceId === undefined ? undefined : eq(agents.workspaceId, workspaceId)),
    )
    .get();
  return row ? rowToAgent(row) : undefined;
}

function assertHandleFree(db: DbOrTx, workspaceId: string, handle: string): void {
  const taken = db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.handle, handle)))
    .get();
  if (taken) throw apiError("CONFLICT", `handle @${handle} 는 이미 쓰이고 있다`, { field: "handle" });
}
