/**
 * 누구나 읽는 연결 목록 `GET /api/v1/connections`(연결 탭 통합 스펙 5.3) — 「연결」 탭 트리의 재료. Gateway·러너마다 id·이름·상태·주인·승인
 * 대기, 프로젝트는 id·이름·러너. 주소·토큰·호스트·루트는 싣지 않는다 — 그것은 연결의 주인과 admin 이상이 보는 걸러진 경로 몫이다
 */
import type { ConnectionOwner, ConnectionsResponse } from "@dodok/shared";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../../auth";
import { authorizeRead } from "../../auth/policies";
import { requirePolicy } from "../../auth/roles";
import type { Db } from "../../db/client";
import { runnerProjects, users } from "../../db/schema.sqlite";
import { listGatewayRows } from "../gateways/service";
import { listRunnerTokens } from "../runners/tokens";

export type ConnectionRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  /** 지금 붙은 러너의 토큰 id — 러너 어댑터가 없으면 빈 집합 */
  connectedRunnerIds(): ReadonlySet<string>;
};

export function registerConnectionRoutes(fastify: FastifyInstance, ctx: ConnectionRouteContext): void {
  fastify.get("/api/v1/connections", { preHandler: requirePolicy(ctx, authorizeRead) }, async () => {
    const names = new Map(
      ctx.db
        .select({ id: users.id, name: users.displayName })
        .from(users)
        .where(eq(users.workspaceId, ctx.workspaceId))
        .all()
        .map((row) => [row.id, row.name]),
    );
    const ownerOf = (id: string | null): ConnectionOwner | null => {
      if (id === null) return null;
      const name = names.get(id);
      return name === undefined ? null : { id, name };
    };
    const connected = ctx.connectedRunnerIds();
    const response: ConnectionsResponse = {
      gateways: listGatewayRows(ctx.db, ctx.workspaceId).map((row) => ({
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        approved: row.approvedAt !== null,
        owner: ownerOf(row.ownerUserId),
      })),
      runners: listRunnerTokens(ctx.db, ctx.workspaceId, connected).map((token) => ({
        id: token.id,
        label: token.label,
        connected: token.connected,
        revoked: token.revokedAt !== null,
        owner: ownerOf(token.ownerUserId),
      })),
      projects: ctx.db
        .select({
          id: runnerProjects.id,
          runnerId: runnerProjects.runnerTokenId,
          label: runnerProjects.label,
          archivedAt: runnerProjects.archivedAt,
        })
        .from(runnerProjects)
        .where(eq(runnerProjects.workspaceId, ctx.workspaceId))
        .orderBy(asc(runnerProjects.createdAt), asc(runnerProjects.id))
        .all()
        .map((row) => ({
          id: row.id,
          runnerId: row.runnerId,
          label: row.label,
          archived: row.archivedAt !== null,
        })),
    };
    return response;
  });
}
