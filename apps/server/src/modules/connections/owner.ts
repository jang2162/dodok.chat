/**
 * 연결의 주인 읽기(연결 탭 통합 스펙 5.1) — 정책 함수(auth/policies.ts)에 넘길 「이 연결의 주인인가」의 재료. 주인은 Gateway·러너 토큰
 * 행에만 있고, 러너 프로젝트·러너 에이전트·OpenClaw 에이전트는 자기가 속한 연결의 주인을 따른다. 없는 행·연결이 빈 에이전트는 null —
 * 주인 없음이라 admin 이상만 지난다
 */
import type { Agent, TeamRole } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { authorizeConnectionRead, type ConnectionActor } from "../../auth/policies";
import type { DbOrTx } from "../../db/client";
import { agents, gateways, runnerProjects, runnerTokens } from "../../db/schema.sqlite";

export function gatewayOwner(db: DbOrTx, workspaceId: string, gatewayId: string): string | null {
  return (
    db
      .select({ owner: gateways.ownerUserId })
      .from(gateways)
      .where(and(eq(gateways.id, gatewayId), eq(gateways.workspaceId, workspaceId)))
      .get()?.owner ?? null
  );
}

/** 러너 행이 있으면 그 주인(없을 수 있다) — 없는 러너와 주인 없는 러너를 가려야 하는 자리(404 먼저)가 쓴다 */
export function findRunner(
  db: DbOrTx,
  workspaceId: string,
  runnerTokenId: string,
): { owner: string | null } | undefined {
  return db
    .select({ owner: runnerTokens.ownerUserId })
    .from(runnerTokens)
    .where(and(eq(runnerTokens.id, runnerTokenId), eq(runnerTokens.workspaceId, workspaceId)))
    .get();
}

/** 러너의 주인 — 러너 id 는 러너 토큰 id 다. 폐기한 러너도 주인은 그대로(보기·보관은 된다) */
export function runnerOwner(db: DbOrTx, workspaceId: string, runnerTokenId: string): string | null {
  return findRunner(db, workspaceId, runnerTokenId)?.owner ?? null;
}

/** 프로젝트의 주인 = 그 프로젝트가 있는 러너의 주인 */
export function projectOwner(db: DbOrTx, workspaceId: string, projectId: string): string | null {
  const project = db
    .select({ runner: runnerProjects.runnerTokenId })
    .from(runnerProjects)
    .where(and(eq(runnerProjects.id, projectId), eq(runnerProjects.workspaceId, workspaceId)))
    .get();
  return project ? runnerOwner(db, workspaceId, project.runner) : null;
}

/** 에이전트 연결의 주인 — OpenClaw 는 그 Gateway, 러너 에이전트는 그 러너 토큰. 연결이 비었으면 null */
export function agentConnectionOwner(db: DbOrTx, workspaceId: string, agentId: string): string | null {
  const agent = db
    .select({ gatewayId: agents.gatewayId, runnerTokenId: agents.runnerTokenId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .get();
  if (!agent) return null;
  if (agent.gatewayId !== null) return gatewayOwner(db, workspaceId, agent.gatewayId);
  if (agent.runnerTokenId !== null) return runnerOwner(db, workspaceId, agent.runnerTokenId);
  return null;
}

/** userId 가 owner 와 같은가 — 둘 중 하나라도 없으면 거짓(주인 없는 연결은 아무의 것도 아니다) */
export function isOwner(owner: string | null, userId: string | null): boolean {
  return owner !== null && userId !== null && owner === userId;
}

/** 그 연결의 주소·토큰을 볼 수 있는가 — 목록을 거르는 자리(GET /gateways·/setup/status·/setup/runner-tokens·/runners)가 정책을 같이 쓴다 */
export function canReadConnection(
  user: { id: string; role: TeamRole | undefined },
  owner: string | null,
): boolean {
  try {
    authorizeConnectionRead({ role: user.role, ownsConnection: isOwner(owner, user.id) });
    return true;
  } catch {
    return false;
  }
}

/** 그 에이전트를 다루는 사람 — 정책 함수(authorizeAgent*)에 그대로 넘긴다 */
export function agentActor(
  db: DbOrTx,
  workspaceId: string,
  agentId: string,
  user: { id: string; role: TeamRole | undefined },
): ConnectionActor {
  return {
    role: user.role,
    ownsConnection: isOwner(agentConnectionOwner(db, workspaceId, agentId), user.id),
  };
}

/** 워크스페이스의 연결 주인 표 — 에이전트 목록을 한 번에 가를 때(에이전트마다 읽지 않게) */
export function connectionOwners(
  db: DbOrTx,
  workspaceId: string,
): { gateways: ReadonlyMap<string, string | null>; runners: ReadonlyMap<string, string | null> } {
  const gatewayRows = db
    .select({ id: gateways.id, owner: gateways.ownerUserId })
    .from(gateways)
    .where(eq(gateways.workspaceId, workspaceId))
    .all();
  const runnerRows = db
    .select({ id: runnerTokens.id, owner: runnerTokens.ownerUserId })
    .from(runnerTokens)
    .where(eq(runnerTokens.workspaceId, workspaceId))
    .all();
  return {
    gateways: new Map(gatewayRows.map((row) => [row.id, row.owner])),
    runners: new Map(runnerRows.map((row) => [row.id, row.owner])),
  };
}

/** API 에이전트(묶인 Gateway·러너가 실린 것)의 연결 주인 — connectionOwners 표로 */
export function ownerOfAgent(agent: Agent, owners: ReturnType<typeof connectionOwners>): string | null {
  if (agent.gateway) return owners.gateways.get(agent.gateway.id) ?? null;
  if (agent.runner) return owners.runners.get(agent.runner.tokenId) ?? null;
  return null;
}
