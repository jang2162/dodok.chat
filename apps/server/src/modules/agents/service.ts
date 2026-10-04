import { Agent } from "@dodok/shared";
import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { agents, runnerTokens } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { getGatewayRow } from "../gateways/service";
import { parseStored } from "../../http/validate";
import { assertHandleFree } from "../members/handles";

type AgentRow = typeof agents.$inferSelect;

/**
 * 세션 키에서 푼 id 로 에이전트를 찾는 조건 — 대소문자 무시. 코어가 키를 소문자로 접으므로 등록이 소문자로 좁혀지기 전에
 * 대문자로 저장된 행(`Dev`)도 `dev` 로 찾아야 한다.
 */
export function providerAgentIdIs(providerAgentId: string): SQL {
  return sql`lower(${agents.providerAgentId}) = ${providerAgentId.toLowerCase()}`;
}

/** 등록할 수 있는 제공자 — 어댑터가 있는 것(OpenClaw·Claude 러너) */
export type RegistrableProvider = "openclaw" | "claude";

export type CreateAgentInput = {
  workspaceId: string;
  provider?: RegistrableProvider;
  providerAgentId: string;
  handle: string;
  name: string;
  avatarUrl?: string;
  basePrompt?: string;
  enabled?: boolean;
  /** provider claude 일 때 묶을 러너 토큰 — 지금 그 id 를 맡는 러너의 토큰. 없으면 처음 알리는 러너에 묶인다 */
  runnerTokenId?: string;
  /** provider openclaw 일 때 그 에이전트의 Gateway(같은 워크스페이스). 없으면 연결이 빈 에이전트 — 런은 ADAPTER_UNAVAILABLE */
  gatewayId?: string;
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

type RunnerTokenRow = Pick<typeof runnerTokens.$inferSelect, "id" | "label" | "revokedAt">;

/** 에이전트 행 + 묶인 러너 토큰(REST 응답의 Agent.runner). 토큰 행이 없으면 runner 없이 */
function toAgentWithRunner(row: AgentRow, token: RunnerTokenRow | null | undefined): Agent {
  const agent = rowToAgent(row);
  if (!token) return agent;
  return { ...agent, runner: { tokenId: token.id, label: token.label, revoked: token.revokedAt !== null } };
}

const runnerTokenColumns = {
  id: runnerTokens.id,
  label: runnerTokens.label,
  revokedAt: runnerTokens.revokedAt,
};

/** REST 응답용 — 행 하나에 묶인 러너 토큰을 붙인다 */
export function agentWithRunner(db: DbOrTx, row: AgentRow): Agent {
  const token =
    row.runnerTokenId === null
      ? undefined
      : db.select(runnerTokenColumns).from(runnerTokens).where(eq(runnerTokens.id, row.runnerTokenId)).get();
  return toAgentWithRunner(row, token);
}

export function createAgent(db: Db, input: CreateAgentInput): Agent {
  const provider = input.provider ?? "openclaw";
  return db.transaction((tx) => {
    assertHandleFree(tx, input.workspaceId, input.handle);
    const gatewayId = provider === "openclaw" ? (input.gatewayId ?? null) : null;
    if (gatewayId !== null && !getGatewayRow(tx, input.workspaceId, gatewayId))
      throw apiError("VALIDATION", "gateway not found", { field: "gatewayId" });
    // 같은 제공자·같은 연결 안에서만, 대소문자 무시로 본다(유일 인덱스는 대소문자를 가린다). 제공자·Gateway 가 다르면 같은 id 도
    // 된다 — 서버가 런·정본·승인을 「연결 id + 세션 키」로 가른다(adapters/connection.ts)
    const taken = tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, input.workspaceId),
          eq(agents.provider, provider),
          provider !== "openclaw"
            ? undefined
            : gatewayId === null
              ? isNull(agents.gatewayId)
              : eq(agents.gatewayId, gatewayId),
          providerAgentIdIs(input.providerAgentId),
        ),
      )
      .get();
    if (taken) {
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
        runnerTokenId: provider === "claude" ? (input.runnerTokenId ?? null) : null,
        gatewayId,
      })
      .returning()
      .get();
    return agentWithRunner(tx, row);
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
    if (Object.keys(set).length === 0) return agentWithRunner(tx, current);
    const row = tx.update(agents).set(set).where(eq(agents.id, id)).returning().get();
    if (!row) throw apiError("NOT_FOUND", "agent not found");
    return agentWithRunner(tx, row);
  });
}

/** REST 목록 — 묶인 러너 토큰(라벨·폐기 여부)을 붙인다 */
export function listAgents(db: DbOrTx, workspaceId: string): Agent[] {
  return db
    .select({ agent: agents, token: runnerTokenColumns })
    .from(agents)
    .leftJoin(runnerTokens, eq(runnerTokens.id, agents.runnerTokenId))
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .all()
    .map(({ agent, token }) => toAgentWithRunner(agent, token));
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
