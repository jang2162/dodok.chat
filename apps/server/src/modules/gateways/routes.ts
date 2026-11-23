/**
 * Gateway API(멀티 Gateway 스펙 「Gateway API」 절) — 만들기는 멤버 누구나(member 가 만든 것은 승인 대기), 그 밖은 그 Gateway 의 주인·admin
 * 이상, 승인은 admin 이상(연결 탭 통합 스펙 5.2·5.4 — 판정은 auth/policies.ts). 저장하면 곧바로 어댑터에 반영한다(재시작 없음). Gateway 공유 토큰은
 * 응답·로그 어디에도 싣지 않는다. 브리지 토큰은 Gateway 아래에서 발급·목록·폐기한다(계획 판정 PG6) — 원문은 발급 응답에만 싣고
 * 그 응답은 `Cache-Control: no-store`.
 */
import {
  ApproveGatewayBody,
  CreateGatewayBody,
  type DeleteGatewayResult,
  Id,
  type GatewayUpdatePreview,
  IssueBridgeTokenInput,
  type IssueBridgeTokenResult,
  PLUGIN_UPDATE_DEADLINE_MS,
  type RemoteUpdateStarted,
  UpdateGatewayBody,
} from "@dodok/shared";
import { and, eq, notInArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { OpenClawGateways } from "../../adapters/types";
import type { Auth } from "../../auth";
import {
  authorizeConnectionCreate,
  authorizeConnectionManage,
  authorizeConnectionRead,
  authorizeGatewayApprove,
} from "../../auth/policies";
import { requireSession } from "../../auth/roles";
import { sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams } from "../../http/validate";
import type { Logger } from "../../logger";
import { runs } from "../../db/schema.sqlite";
import { gatewayUpdateKey, type RemoteUpdates, sendUpdate } from "../connections/remote-updates";
import type { PluginFile } from "../setup/plugin-file";
import { issueBridgeToken, listBridgeTokens, revokeBridgeToken } from "../setup/tokens";
import { canReadConnection, isOwner } from "../connections/owner";
import {
  approveGateway,
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
  /** 삭제가 에이전트의 Gateway 를 비웠을 때 — wire agents.changed */
  agentsChanged(): void;
  /** 서버가 품은 플러그인 tgz(원격 업데이트가 설치시킬 것) — 없으면 업데이트할 것이 없다 */
  pluginFile: PluginFile | null;
  /** 원격 업데이트 진행(원격 업데이트 스펙 U9) — 러너 라우트와 같은 것 */
  remoteUpdates: RemoteUpdates;
};

/** 그 Gateway(연결)의 끝나지 않은 런 수 — 플러그인 업데이트가 Gateway 를 내리면 끊긴다(U6) */
function openRunCount(db: Db, gatewayId: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(runs)
      .where(and(eq(runs.connectionId, gatewayId), notInArray(runs.status, ["done", "error", "aborted"])))
      .get()?.n ?? 0
  );
}

const GatewayParams = z.object({ id: Id });
const TokenParams = z.object({ id: Id, tokenId: Id });

export function registerGatewayRoutes(fastify: FastifyInstance, ctx: GatewayRouteContext): void {
  const session = { preHandler: requireSession(ctx) };
  const requireGateway = (id: string) => {
    const row = getGatewayRow(ctx.db, ctx.workspaceId, id);
    if (!row) throw apiError("NOT_FOUND", "gateway not found");
    return row;
  };
  /** 이 요청의 사람이 그 Gateway 를 다룰 수 있는가 — 없는 id 는 404(정책보다 먼저 — 있는 것만 판정한다) */
  const actorOf = (request: FastifyRequest) => {
    const user = sessionUser(request);
    return { user, actor: { userId: user.id, role: user.role } };
  };
  const manageable = (request: FastifyRequest, id: string, policy = authorizeConnectionManage) => {
    const row = requireGateway(id);
    const { user, actor } = actorOf(request);
    policy({ role: user.role, ownsConnection: isOwner(row.ownerUserId, user.id) });
    return { row, actor };
  };
  /** 그 Gateway 에 지금 붙은 플러그인 세션의 토큰 */
  const connectedTokenIds = (gatewayId: string) =>
    new Set(
      ctx.gateways
        .gatewaySetupDetails()
        .filter((entry) => entry.id === gatewayId)
        .flatMap((entry) => (entry.bridge.plugin?.tokenId ? [entry.bridge.plugin.tokenId] : [])),
    );

  /** 그 사람이 주소를 볼 수 있는 Gateway 만 — member 는 자기 것, admin 이상은 모두 */
  fastify.get("/api/v1/gateways", session, async (request) => {
    const user = sessionUser(request);
    return listGatewayRows(ctx.db, ctx.workspaceId)
      .filter((row) => canReadConnection(user, row.ownerUserId))
      .map(toGatewaySummary);
  });

  fastify.post("/api/v1/gateways", session, async (request, reply) => {
    const { user, actor } = actorOf(request);
    authorizeConnectionCreate(user.role);
    const body = parseBody(CreateGatewayBody, request.body);
    const row = createGateway(ctx.db, ctx.workspaceId, body, actor);
    ctx.gateways.upsertGateway(gatewayConfig(row));
    ctx.logger.info(
      { gatewayId: row.id, name: row.name, approved: row.approvedAt !== null },
      "gateway added",
    );
    ctx.changed();
    return reply.status(201).send(toGatewaySummary(row));
  });

  fastify.patch("/api/v1/gateways/:id", session, async (request) => {
    const { id } = parseParams(GatewayParams, request.params);
    const { actor } = manageable(request, id);
    const patch = parseBody(UpdateGatewayBody, request.body);
    const { before, row, changed } = updateGateway(ctx.db, ctx.workspaceId, id, patch, actor);
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
          approved: row.approvedAt !== null,
        },
        "gateway updated",
      );
      ctx.changed();
      // 에이전트 줄이 Gateway 이름을 싣는다 — adapter.status 의 이름 변화를 기다리지 않고 다른 탭이 곧바로 다시 받게
      if (row.name !== before.name) ctx.agentsChanged();
    }
    return toGatewaySummary(row);
  });

  /**
   * 승인(admin 이상) — 본문의 url 은 승인하는 사람이 본 주소다. 지금 주소와 다르면 409 이고 승인도 접속도 없다(스펙 5.4). 승인되면 그
   * 자리에서 어댑터에 켜진 설정을 넣어 접속을 시작한다(꺼 둔 Gateway 면 꺼진 채)
   */
  fastify.post("/api/v1/gateways/:id/approve", session, async (request) => {
    const { id } = parseParams(GatewayParams, request.params);
    requireGateway(id);
    const { user, actor } = actorOf(request);
    authorizeGatewayApprove(user.role);
    const { url } = parseBody(ApproveGatewayBody, request.body);
    const { row, approved } = approveGateway(ctx.db, ctx.workspaceId, id, url, actor);
    if (approved) {
      ctx.gateways.upsertGateway(gatewayConfig(row));
      ctx.logger.info({ gatewayId: id, approvedBy: user.id }, "gateway approved");
      ctx.changed();
    }
    return toGatewaySummary(row);
  });

  fastify.delete("/api/v1/gateways/:id", session, async (request) => {
    const { id } = parseParams(GatewayParams, request.params);
    manageable(request, id);
    const result: DeleteGatewayResult = deleteGateway(ctx.db, ctx.workspaceId, id);
    // 행은 이미 지워졌다 — 끊기가 실패해도 다음 부팅에는 없는 Gateway 다. 그 토큰들은 행이 없어 핸드셰이크에서 거절된다
    try {
      await ctx.gateways.removeGateway(id);
    } catch (err) {
      ctx.logger.warn({ err, gatewayId: id }, "gateway connection removal failed");
    }
    ctx.logger.info({ gatewayId: id, ...result }, "gateway removed");
    ctx.changed();
    if (result.unboundAgents > 0) ctx.agentsChanged();
    return result;
  });

  /** 업데이트 확인 대화상자의 「진행 중인 런 N개가 끊깁니다」(원격 업데이트 스펙 U6) — 그 Gateway 의 주인·admin 이상 */
  fastify.get("/api/v1/gateways/:id/update", session, async (request): Promise<GatewayUpdatePreview> => {
    const { id } = parseParams(GatewayParams, request.params);
    manageable(request, id);
    return { activeRuns: openRunCount(ctx.db, id) };
  });

  /**
   * 플러그인 원격 업데이트(U5·U7·U9) — 그 Gateway 의 주인·admin 이상. 플러그인이 붙어 있고(503) 능력이 있고 켜져 있고(409), 서버가 품은
   * 파일이 있고 그것과 다른 빌드일 때만(409). 진행 중이면 409. 플러그인의 거절은 409 와 그 사유, 받아들여지면 202 — 상한 5분
   */
  fastify.post(
    "/api/v1/gateways/:id/update",
    session,
    async (request, reply): Promise<RemoteUpdateStarted> => {
      const { id } = parseParams(GatewayParams, request.params);
      const { row } = manageable(request, id);
      if (!row.enabled || row.approvedAt === null)
        throw apiError("CONFLICT", "꺼 두었거나 승인 전인 Gateway 입니다");
      const plugin = ctx.gateways.gatewaySetupDetails().find((d) => d.id === id)?.bridge.plugin ?? null;
      if (!plugin) throw apiError("ADAPTER_UNAVAILABLE", "플러그인이 붙어 있지 않습니다");
      if (plugin.remoteUpdate !== "on")
        throw apiError(
          "CONFLICT",
          plugin.remoteUpdate === "off"
            ? "이 Gateway 에서 원격 업데이트를 껐습니다"
            : "이 플러그인 판은 원격 업데이트를 지원하지 않습니다 — 설치 한 줄을 그 호스트에서 돌리세요",
          { reason: plugin.remoteUpdate === "off" ? "disabled" : "unsupported" },
        );
      const file = ctx.pluginFile;
      if (!file) throw apiError("NOT_FOUND", "PLUGIN_FILE_MISSING");
      if (plugin.bundleSha256 === file.bundleSha256)
        throw apiError("CONFLICT", "이미 서버와 같은 빌드입니다", { reason: "invalid_version" });
      const key = gatewayUpdateKey(id);
      const { view, startedAt } = ctx.remoteUpdates.begin(key, {
        targetVersion: null,
        deadlineMs: PLUGIN_UPDATE_DEADLINE_MS,
        prevLastUpdateAt: plugin.lastUpdate?.at ?? null,
      });
      ctx.logger.info(
        { userId: sessionUser(request).id, gatewayId: id, activeRuns: openRunCount(ctx.db, id) },
        "plugin remote update requested",
      );
      await sendUpdate({
        updates: ctx.remoteUpdates,
        key,
        startedAt,
        send: async () => {
          const result = await ctx.gateways.updatePlugin(id, file.sha256);
          if (!result.ok) throw apiError(result.error.code, result.error.message);
          return result.data;
        },
        onLate: ctx.changed,
      });
      ctx.changed();
      return reply.status(202).send({ update: view });
    },
  );

  fastify.get("/api/v1/gateways/:id/bridge-tokens", session, async (request) => {
    const { id } = parseParams(GatewayParams, request.params);
    manageable(request, id, authorizeConnectionRead);
    return { tokens: listBridgeTokens(ctx.db, ctx.workspaceId, id, connectedTokenIds(id)) };
  });

  // 승인 전에도 발급된다 — 플러그인은 브리지로 이 서버에 붙는 쪽이라 위험이 없고, 주인이 미리 준비할 수 있게(스펙 5.4)
  fastify.post("/api/v1/gateways/:id/bridge-tokens", session, async (request, reply) => {
    const { id } = parseParams(GatewayParams, request.params);
    manageable(request, id);
    const { label } = parseBody(IssueBridgeTokenInput, request.body);
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

  fastify.delete("/api/v1/gateways/:id/bridge-tokens/:tokenId", session, async (request, reply) => {
    const { id, tokenId } = parseParams(TokenParams, request.params);
    manageable(request, id);
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
