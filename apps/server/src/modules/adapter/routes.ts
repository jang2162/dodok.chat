import type { FastifyInstance } from "fastify";
import type { AgentAdapter } from "../../adapters/types";
import type { Auth } from "../../auth";
import { requireSession } from "../../auth/routes";
import type { Db } from "../../db/client";

export type AdapterRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  adapter: Pick<AgentAdapter, "status" | "capabilities">;
};

export function registerAdapterRoutes(fastify: FastifyInstance, ctx: AdapterRouteContext): void {
  const authed = { preHandler: requireSession(ctx) };

  /** 스펙 4장 — 연결 상태와 쓸 수 있는 기능(sessionReset 등). Gateway hello 요약(버전)은 어댑터가 아직 내놓지 않는다. */
  fastify.get("/api/v1/adapter/status", authed, async () => ({
    ...ctx.adapter.status(),
    capabilities: ctx.adapter.capabilities(),
  }));
}
