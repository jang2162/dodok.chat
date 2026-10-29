/**
 * 러너 에이전트 ↔ 러너 토큰 묶임(`agents.runner_token_id`). 묶인 에이전트는 그 토큰의 러너만 맡는다 — 에이전트는 만들 때 프로젝트의
 * 러너 토큰에 묶인다(러너 일반화 계획 판정 PR4). 토큰을 폐기해도 묶임은 남는다(맡을 러너가 없을 뿐) — 연결 페이지에서 다른 토큰에
 * 다시 묶는다
 */
import type { Agent } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { agents, runnerTokens } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { apiAgent, providerAgentIdIs } from "../agents/service";

const runnerAgent = (workspaceId: string, providerAgentId: string) =>
  and(eq(agents.workspaceId, workspaceId), eq(agents.provider, "runner"), providerAgentIdIs(providerAgentId));

/**
 * 다시 묶기(연결 페이지, owner) — 등록 러너 에이전트를 그 활성 토큰에 묶는다. 토큰이 없으면 404, 폐기됐으면 409,
 * 등록 러너 에이전트가 없으면 404. 그 에이전트가 도는 런은 옛 러너에서 끝까지 간다
 */
export function bindRunnerToken(
  db: Db,
  workspaceId: string,
  tokenId: string,
  providerAgentId: string,
): Agent {
  return db.transaction((tx) => {
    const token = tx
      .select({ revokedAt: runnerTokens.revokedAt })
      .from(runnerTokens)
      .where(and(eq(runnerTokens.id, tokenId), eq(runnerTokens.workspaceId, workspaceId)))
      .get();
    if (!token) throw apiError("NOT_FOUND", "runner token not found");
    if (token.revokedAt !== null) throw apiError("CONFLICT", "runner token is revoked");
    const row = tx
      .update(agents)
      .set({ runnerTokenId: tokenId })
      .where(runnerAgent(workspaceId, providerAgentId))
      .returning()
      .get();
    if (!row) throw apiError("NOT_FOUND", "agent not found");
    return apiAgent(tx, row);
  });
}
