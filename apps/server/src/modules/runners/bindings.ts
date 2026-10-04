/**
 * Claude 에이전트 ↔ 러너 토큰 묶임(`agents.runner_token_id`). 묶인 에이전트는 그 토큰의 러너만 맡는다 — 러너 어댑터가 옵션
 * `bindings` 로 이 함수들을 부른다. 묶임이 없는 행(묶임이 생기기 전에 등록된 것, 맡을 러너 없이 등록된 것)은 처음 그 id 를 알린
 * 러너에 묶인다. 토큰을 폐기해도 묶임은 남는다(맡을 러너가 없을 뿐) — 연결 페이지에서 다른 토큰에 다시 묶는다
 */
import type { Agent } from "@dodok/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client";
import { agents, runnerTokens } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { apiAgent, providerAgentIdIs } from "../agents/service";

const claudeAgent = (workspaceId: string, providerAgentId: string) =>
  and(eq(agents.workspaceId, workspaceId), eq(agents.provider, "claude"), providerAgentIdIs(providerAgentId));

/** 그 id(대소문자 무시)의 등록 claude 에이전트가 묶인 토큰 id. 등록되지 않았거나 묶이지 않았으면 null */
export function boundRunnerToken(db: Db, workspaceId: string, providerAgentId: string): string | null {
  return (
    db
      .select({ tokenId: agents.runnerTokenId })
      .from(agents)
      .where(claudeAgent(workspaceId, providerAgentId))
      .get()?.tokenId ?? null
  );
}

/** 묶이지 않은 등록 claude 에이전트를 그 토큰에 묶는다(첫 연결). 조건부 UPDATE 라 둘이 겹쳐도 한쪽만 묶는다 */
export function claimRunnerToken(
  db: Db,
  workspaceId: string,
  providerAgentId: string,
  tokenId: string,
): boolean {
  return (
    db
      .update(agents)
      .set({ runnerTokenId: tokenId })
      .where(and(claudeAgent(workspaceId, providerAgentId), isNull(agents.runnerTokenId)))
      .run().changes > 0
  );
}

/**
 * 다시 묶기(연결 페이지, owner) — 등록 claude 에이전트를 그 활성 토큰에 묶는다. 토큰이 없으면 404, 폐기됐으면 409,
 * 등록 claude 에이전트가 없으면 404. 그 에이전트가 도는 런은 옛 러너에서 끝까지 간다
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
      .where(claudeAgent(workspaceId, providerAgentId))
      .returning()
      .get();
    if (!row) throw apiError("NOT_FOUND", "agent not found");
    return apiAgent(tx, row);
  });
}
