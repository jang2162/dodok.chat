import type { AdapterCapabilities, AdapterProvider, AdapterStatus } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import type { AdapterRegistry } from "../../adapters/registry";
import type { Auth } from "../../auth";
import { requireSession } from "../../auth/routes";
import type { Db } from "../../db/client";

export type AdapterRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  registry: Pick<AdapterRegistry, "all">;
};

/** GET /api/v1/adapter/status 응답 — 붙은 어댑터마다 상태 하나, capabilities 는 provider 로 찾는다 */
export type AdapterStatusList = {
  statuses: AdapterStatus[];
  capabilities: Partial<Record<AdapterProvider, AdapterCapabilities>>;
};

export function registerAdapterRoutes(fastify: FastifyInstance, ctx: AdapterRouteContext): void {
  const authed = { preHandler: requireSession(ctx) };

  /** 스펙 4장 — 연결 상태와 쓸 수 있는 기능(sessionReset 등). Gateway hello 요약(버전)은 어댑터가 아직 내놓지 않는다. */
  fastify.get("/api/v1/adapter/status", authed, async (): Promise<AdapterStatusList> => {
    const adapters = ctx.registry.all();
    return {
      statuses: adapters.map((adapter) => adapter.status()),
      capabilities: Object.fromEntries(adapters.map((adapter) => [adapter.provider, adapter.capabilities()])),
    };
  });
}
