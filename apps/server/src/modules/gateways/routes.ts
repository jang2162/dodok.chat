/**
 * Gateway API(멀티 Gateway 스펙 「Gateway API」 절) — 전부 owner 세션만. 저장하면 곧바로 어댑터에 반영한다(재시작 없음). Gateway 공유 토큰은
 * 응답·로그 어디에도 싣지 않는다. 브리지 토큰은 Gateway 아래에서 발급·목록·폐기한다(계획 판정 PG6) — 원문은 발급 응답에만 싣고
 * 그 응답은 `Cache-Control: no-store`.
 */
import {
  CreateGatewayBody,
  type DeleteGatewayResult,
  Id,
  IssueBridgeTokenInput,
  type IssueBridgeTokenResult,
  UpdateGatewayBody,
} from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OpenClawGateways } from "../../adapters/types";
import type { Auth } from "../../auth";
import { requireOwner } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams } from "../../http/validate";
import type { Logger } from "../../logger";
import { issueBridgeToken, listBridgeTokens, revokeBridgeToken } from "../setup/tokens";
import {
  createGateway,
  deleteGateway,
  gatewayConfig,
  getGatewayRow,
  listGatewayRows,
  toGatewaySummary,
  updateGateway,
} from "./service";

export type GatewayRouteContext = {
  auth: Auth;
  db: Db;
  logger: Logger;
  workspaceId: string;
  /** 레지스트리의 OpenClaw 어댑터 */
  gateways: OpenClawGateways;
  /** 플러그인 계정 설정의 bridgeUrl(setup/status.ts bridgePublicUrl) */
  publicUrl: string;
  /** Gateway·토큰이 바뀐 뒤 — setup.status 를 다시 알린다 */
  changed(): void;
};

const GatewayParams = z.object({ id: Id });
const TokenParams = z.object({ id: Id, tokenId: Id });

export function registerGatewayRoutes(fastify: FastifyInstance, ctx: GatewayRouteContext): void {
  const owner = { preHandler: requireOwner(ctx) };
  const requireGateway = (id: string) => {
    const row = getGatewayRow(ctx.db, ctx.workspaceId, id);
    if (!row) throw apiError("NOT_FOUND", "gateway not found");
    return row;
  };
  /** 그 Gateway 에 지금 붙은 플러그인 세션의 토큰 */
  const connectedTokenIds = (gatewayId: string) =>
    new Set(
      ctx.gateways
        .gatewaySetupDetails()
        .filter((entry) => entry.id === gatewayId)
        .flatMap((entry) => (entry.bridge.plugin?.tokenId ? [entry.bridge.plugin.tokenId] : [])),
    );

  fastify.get("/api/v1/gateways", owner, async () =>
    listGatewayRows(ctx.db, ctx.workspaceId).map(toGatewaySummary),
  );

  fastify.post("/api/v1/gateways", owner, async (request, reply) => {
    const body = parseBody(CreateGatewayBody, request.body);
    const row = createGateway(ctx.db, ctx.workspaceId, body);
    ctx.gateways.upsertGateway(gatewayConfig(row));
    ctx.logger.info({ gatewayId: row.id, name: row.name }, "gateway added");
    ctx.changed();
    return reply.status(201).send(toGatewaySummary(row));
  });

  fastify.patch("/api/v1/gateways/:id", owner, async (request) => {
    const { id } = parseParams(GatewayParams, request.params);
    const patch = parseBody(UpdateGatewayBody, request.body);
    const { before, row, changed } = updateGateway(ctx.db, ctx.workspaceId, id, patch);
    if (changed) {
      // 어댑터가 무엇이 바뀌었는지 본다 — 이름만이면 다시 붙지 않고, 주소·토큰이면 그 연결만 다시 붙는다
      ctx.gateways.upsertGateway(gatewayConfig(row));
      ctx.logger.info(
        {
          gatewayId: id,
          name: row.name,
          enabled: row.enabled,
          urlChanged: row.url !== before.url,
          tokenChanged: row.token !== before.token,
        },
        "gateway updated",
      );
      ctx.changed();
    }
    return toGatewaySummary(row);
  });

  fastify.delete("/api/v1/gateways/:id", owner, async (request) => {
    const { id } = parseParams(GatewayParams, request.params);
    const result: DeleteGatewayResult = deleteGateway(ctx.db, ctx.workspaceId, id);
    // 행은 이미 지워졌다 — 끊기가 실패해도 다음 부팅에는 없는 Gateway 다. 그 토큰들은 행이 없어 핸드셰이크에서 거절된다
    try {
      await ctx.gateways.removeGateway(id);
    } catch (err) {
      ctx.logger.warn({ err, gatewayId: id }, "gateway connection removal failed");
    }
    ctx.logger.info({ gatewayId: id, ...result }, "gateway removed");
    ctx.changed();
    return result;
  });

  fastify.get("/api/v1/gateways/:id/bridge-tokens", owner, async (request) => {
    const { id } = parseParams(GatewayParams, request.params);
    requireGateway(id);
    return { tokens: listBridgeTokens(ctx.db, ctx.workspaceId, id, connectedTokenIds(id)) };
  });

  fastify.post("/api/v1/gateways/:id/bridge-tokens", owner, async (request, reply) => {
    const { id } = parseParams(GatewayParams, request.params);
    const { label } = parseBody(IssueBridgeTokenInput, request.body);
    requireGateway(id);
    const { token, record } = issueBridgeToken(ctx.db, ctx.workspaceId, id, label);
    ctx.logger.info({ gatewayId: id, tokenId: record.id, label: record.label }, "bridge token issued");
    ctx.changed();
    const result: IssueBridgeTokenResult = {
      token,
      record,
      pluginConfig: {
        channels: { dodok: { accounts: { default: { bridgeUrl: ctx.publicUrl, token } } } },
      },
    };
    // 원문을 되살릴 수 있는 캐시(브라우저·프록시)에 남기지 않는다(설정 마법사 Review Focus 3)
    return reply.status(201).header("cache-control", "no-store").send(result);
  });

  fastify.delete("/api/v1/gateways/:id/bridge-tokens/:tokenId", owner, async (request, reply) => {
    const { id, tokenId } = parseParams(TokenParams, request.params);
    if (!revokeBridgeToken(ctx.db, ctx.workspaceId, id, tokenId))
      throw apiError("NOT_FOUND", "bridge token not found");
    // 폐기는 이미 됐다 — 끊기가 실패해도 다음 핸드셰이크부터 거절된다(설정 마법사 스펙 6장)
    try {
      ctx.gateways.revokeTokenSessions(tokenId);
    } catch (err) {
      ctx.logger.warn({ err, tokenId }, "bridge session revoke failed");
    }
    ctx.logger.info({ gatewayId: id, tokenId }, "bridge token revoked");
    ctx.changed();
    return reply.status(204).send();
  });
}
