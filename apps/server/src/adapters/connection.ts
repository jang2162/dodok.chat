import { eq, isNull, or, type SQL, sql } from "drizzle-orm";
import { OPENCLAW_ENV_CONNECTION_ID } from "../config";
import type { AdapterProvider } from "./types";
import type { DbOrTx } from "../db/client";
import { agents } from "../db/schema.sqlite";

/**
 * 에이전트를 맡은 연결(멀티 Gateway 스펙 2장) — OpenClaw 는 gateway_id, 러너는 runner_token_id. 없으면 null.
 * gateway_id 가 빈 OpenClaw 에이전트는 아직 .env 의 Gateway 하나를 쓴다(OPENCLAW_ENV_CONNECTION_ID)
 */
export function connectionIdOf(agent: {
  provider: string;
  gatewayId: string | null;
  runnerTokenId: string | null;
}): string | null {
  if (agent.provider === "openclaw") return agent.gatewayId ?? OPENCLAW_ENV_CONNECTION_ID;
  if (agent.provider === "claude") return agent.runnerTokenId;
  return null;
}

/** 에이전트 행의 연결 — 행이 없으면 null */
export function agentConnectionId(db: DbOrTx, agentId: string): string | null {
  const row = db
    .select({ provider: agents.provider, gatewayId: agents.gatewayId, runnerTokenId: agents.runnerTokenId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  return row ? connectionIdOf(row) : null;
}

/**
 * 그 연결에서 온 이벤트의 에이전트를 찾는 조건 — connectionIdOf(agent) 와 같은 규칙을 SQL 로. 묶임 없는 러너 에이전트는 어느 러너의
 * 것으로도 받는다: 러너 어댑터가 그 에이전트를 먼저 알린 러너에 보내고(첫 연결 묶기 전일 수 있다), 러너 에이전트는 워크스페이스에서
 * id 가 하나라 연결로 가를 것이 없다
 */
export function agentOnConnection(provider: AdapterProvider, connectionId: string): SQL | undefined {
  if (provider === "openclaw") {
    return sql`coalesce(${agents.gatewayId}, ${OPENCLAW_ENV_CONNECTION_ID}) = ${connectionId}`;
  }
  return or(eq(agents.runnerTokenId, connectionId), isNull(agents.runnerTokenId));
}
