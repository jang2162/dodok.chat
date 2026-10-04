import { eq, isNull, or, type SQL } from "drizzle-orm";
import type { AdapterProvider } from "./types";
import type { DbOrTx } from "../db/client";
import { agents } from "../db/schema.sqlite";

/**
 * 에이전트를 맡은 연결(멀티 Gateway 스펙 「구성」 절) — OpenClaw 는 gateway_id, 러너는 runner_token_id. 없으면 null — gateway_id 가 빈
 * OpenClaw 에이전트(Gateway 가 지워져 옮기기를 기다림)는 어느 연결의 것도 아니고 send 는 ADAPTER_UNAVAILABLE 이다.
 * 같은 규칙의 SQL 판이 아래 agentOnConnection 이다 — 하나를 바꾸면 둘 다 바꾼다(connection-rule 테스트가 둘을 견준다)
 */
export function connectionIdOf(agent: {
  provider: string;
  gatewayId: string | null;
  runnerTokenId: string | null;
}): string | null {
  if (agent.provider === "openclaw") return agent.gatewayId;
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
 * 그 연결에서 온 이벤트의 에이전트를 찾는 조건 — `connectionIdOf(agent) === connectionId` 를 SQL 로. 묶임 없는 러너 에이전트만
 * 다르다 — 어느 러너의 것으로도 받는다. 러너 어댑터가 그 에이전트를 먼저 알린 러너에 보내고(첫 연결 묶기 전일 수 있다), 러너
 * 에이전트는 워크스페이스에서 id 가 하나라 연결로 가를 것이 없다
 */
export function agentOnConnection(provider: AdapterProvider, connectionId: string): SQL | undefined {
  if (provider === "openclaw") {
    return eq(agents.gatewayId, connectionId);
  }
  return or(eq(agents.runnerTokenId, connectionId), isNull(agents.runnerTokenId));
}
