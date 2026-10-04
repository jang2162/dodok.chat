import { Agent } from "@dodok/shared";
import { and, asc, eq, ne, type SQL, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { agents, gateways, runnerTokens } from "../../db/schema.sqlite";
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
  /**
   * provider openclaw 일 때 그 에이전트의 Gateway(같은 워크스페이스). REST 등록은 늘 준다(routes.ts) — 없으면 연결이 빈 에이전트(런은
   * ADAPTER_UNAVAILABLE)로, 시드·테스트가 Gateway 를 지운 뒤의 모양을 만들 때만 쓴다
   */
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
type GatewayNameRow = Pick<typeof gateways.$inferSelect, "id" | "name">;

/**
 * 에이전트 행 + 묶인 연결 요약(REST 응답의 Agent.runner·Agent.gateway). 러너 토큰 행이 없으면 runner 없이. OpenClaw 에이전트는
 * gateway 키가 늘 있다 — Gateway 가 지워졌으면 null
 */
function toApiAgent(
  row: AgentRow,
  token: RunnerTokenRow | null | undefined,
  gateway: GatewayNameRow | null | undefined,
): Agent {
  const agent = rowToAgent(row);
  return {
    ...agent,
    ...(token
      ? { runner: { tokenId: token.id, label: token.label, revoked: token.revokedAt !== null } }
      : {}),
    ...(row.provider === "openclaw"
      ? { gateway: gateway ? { id: gateway.id, name: gateway.name } : null }
      : {}),
  };
}

const runnerTokenColumns = {
  id: runnerTokens.id,
  label: runnerTokens.label,
  revokedAt: runnerTokens.revokedAt,
};

const gatewayNameColumns = { id: gateways.id, name: gateways.name };

/** REST 응답용 — 행 하나에 묶인 러너 토큰·Gateway 를 붙인다 */
export function apiAgent(db: DbOrTx, row: AgentRow): Agent {
  const token =
    row.runnerTokenId === null
      ? undefined
      : db.select(runnerTokenColumns).from(runnerTokens).where(eq(runnerTokens.id, row.runnerTokenId)).get();
  const gateway =
    row.gatewayId === null
      ? undefined
      : db.select(gatewayNameColumns).from(gateways).where(eq(gateways.id, row.gatewayId)).get();
  return toApiAgent(row, token, gateway);
}

/**
 * 같은 Gateway 에 그 id(대소문자 무시 — 유일 인덱스는 대소문자를 가린다)의 다른 OpenClaw 에이전트가 있으면 409. Gateway 가 빈
 * 에이전트끼리는 겹쳐도 된다 — 어느 연결의 것도 아니라 가를 대조가 없고, Gateway 를 지우면 같은 id 둘이 함께 비는 것이 자연스럽다
 * (서버는 런·정본·승인을 「연결 id + 세션 키」로 가른다 — adapters/connection.ts)
 */
function assertFreeOnGateway(
  tx: DbOrTx,
  input: { workspaceId: string; gatewayId: string; providerAgentId: string; exceptAgentId?: string },
): void {
  const taken = tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, input.workspaceId),
        eq(agents.provider, "openclaw"),
        eq(agents.gatewayId, input.gatewayId),
        providerAgentIdIs(input.providerAgentId),
        input.exceptAgentId === undefined ? undefined : ne(agents.id, input.exceptAgentId),
      ),
    )
    .get();
  if (taken) {
    throw apiError("CONFLICT", `providerAgentId ${input.providerAgentId} 는 그 Gateway 에 이미 등록돼 있다`, {
      field: "providerAgentId",
    });
  }
}

/** 같은 워크스페이스의 Gateway 여야 한다 — 아니면 400(없는 id 와 남의 것을 가르지 않는다) */
function assertWorkspaceGateway(tx: DbOrTx, workspaceId: string, gatewayId: string): GatewayNameRow {
  const row = getGatewayRow(tx, workspaceId, gatewayId);
  if (!row) throw apiError("VALIDATION", "gateway not found", { field: "gatewayId" });
  return row;
}

export function createAgent(db: Db, input: CreateAgentInput): Agent {
  const provider = input.provider ?? "openclaw";
  return db.transaction((tx) => {
    assertHandleFree(tx, input.workspaceId, input.handle);
    const gatewayId = provider === "openclaw" ? (input.gatewayId ?? null) : null;
    if (gatewayId !== null) {
      assertWorkspaceGateway(tx, input.workspaceId, gatewayId);
      assertFreeOnGateway(tx, {
        workspaceId: input.workspaceId,
        gatewayId,
        providerAgentId: input.providerAgentId,
      });
    } else if (provider !== "openclaw") {
      // 러너 에이전트는 워크스페이스에서 id 가 하나다 — 러너가 그 id 로 에이전트를 가져간다(러너 스펙 R2 중 제공자 안 규칙)
      const taken = tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, input.workspaceId),
            eq(agents.provider, provider),
            providerAgentIdIs(input.providerAgentId),
          ),
        )
        .get();
      if (taken) {
        throw apiError("CONFLICT", `providerAgentId ${input.providerAgentId} 는 이미 등록돼 있다`, {
          field: "providerAgentId",
        });
      }
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
    return apiAgent(tx, row);
  });
}

/**
 * OpenClaw 에이전트를 다른 Gateway 로 옮긴다(멀티 Gateway 스펙 「에이전트 API」 절, owner). 대상에 같은 id 가 있으면 409, 러너 에이전트는 400.
 * 도는 런은 맡은 연결(runs.connection_id)에서 끝까지 가고, 아직 보내지 않은 런은 디스패치 때 닫힌다(runs/orchestrator.ts dispatch).
 * previousGatewayId 는 채널 프롬프트 동기화가 새로 들어온 Gateway 를 가를 때 쓴다
 */
export function moveAgentGateway(
  db: Db,
  input: { workspaceId: string; agentId: string; gatewayId: string },
): { agent: Agent; previousGatewayId: string | null } {
  return db.transaction((tx) => {
    const current = tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, input.workspaceId)))
      .get();
    if (!current) throw apiError("NOT_FOUND", "agent not found");
    if (current.provider !== "openclaw")
      throw apiError("VALIDATION", "only OpenClaw agents belong to a gateway", { field: "gatewayId" });
    assertWorkspaceGateway(tx, input.workspaceId, input.gatewayId);
    if (current.gatewayId === input.gatewayId)
      return { agent: apiAgent(tx, current), previousGatewayId: current.gatewayId };
    assertFreeOnGateway(tx, {
      workspaceId: input.workspaceId,
      gatewayId: input.gatewayId,
      providerAgentId: current.providerAgentId,
      exceptAgentId: current.id,
    });
    const row = tx
      .update(agents)
      .set({ gatewayId: input.gatewayId })
      .where(eq(agents.id, current.id))
      .returning()
      .get();
    if (!row) throw apiError("NOT_FOUND", "agent not found");
    return { agent: apiAgent(tx, row), previousGatewayId: current.gatewayId };
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
    if (Object.keys(set).length === 0) return apiAgent(tx, current);
    const row = tx.update(agents).set(set).where(eq(agents.id, id)).returning().get();
    if (!row) throw apiError("NOT_FOUND", "agent not found");
    return apiAgent(tx, row);
  });
}

/** REST 목록 — 묶인 러너 토큰(라벨·폐기 여부)과 Gateway(이름)를 붙인다 */
export function listAgents(db: DbOrTx, workspaceId: string): Agent[] {
  return db
    .select({ agent: agents, token: runnerTokenColumns, gateway: gatewayNameColumns })
    .from(agents)
    .leftJoin(runnerTokens, eq(runnerTokens.id, agents.runnerTokenId))
    .leftJoin(gateways, eq(gateways.id, agents.gatewayId))
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .all()
    .map(({ agent, token, gateway }) => toApiAgent(agent, token, gateway));
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
