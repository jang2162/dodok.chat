/**
 * 설정 마법사 API(스펙 3장) — 전부 owner 세션만. 토큰 원문은 발급 응답에만 싣고 그 응답은 `Cache-Control: no-store`.
 * 목록·상태·로그·wire 어디에도 원문은 없다.
 */
import { Id, IssueBridgeTokenInput, type IssueBridgeTokenResult, type SetupStatus } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AgentAdapter } from "../../adapters/types";
import type { Auth } from "../../auth";
import { requireOwner } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams } from "../../http/validate";
import type { Logger } from "../../logger";
import type { PluginFile } from "./plugin-file";
import { issueBridgeToken, listBridgeTokens, revokeBridgeToken } from "./tokens";

export type SetupRouteContext = {
  auth: Auth;
  db: Db;
  logger: Logger;
  workspaceId: string;
  adapter: Pick<AgentAdapter, "setupDetail" | "revokeBridgeSessions">;
  /** 부팅 때 잰 품은 플러그인 파일(없으면 null) */
  pluginFile: PluginFile | null;
  /** 플러그인 계정 설정의 bridgeUrl(status.ts bridgePublicUrl) */
  publicUrl: string;
  status(): SetupStatus;
  /** 토큰 발급·폐기 뒤 — setup.status 를 다시 알린다 */
  changed(): void;
};

const TokenParams = z.object({ id: Id });

/** 파일이 없을 때의 404 — 웹이 받기 대신 만드는 법을 보인다 */
const pluginFileMissing = () => apiError("NOT_FOUND", "PLUGIN_FILE_MISSING");

export function registerSetupRoutes(fastify: FastifyInstance, ctx: SetupRouteContext): void {
  const owner = { preHandler: requireOwner(ctx) };
  const connectedTokenId = () => ctx.adapter.setupDetail().bridge.plugin?.tokenId ?? null;

  fastify.get("/api/v1/setup/status", owner, async () => ctx.status());

  fastify.get("/api/v1/setup/bridge-tokens", owner, async () => ({
    tokens: listBridgeTokens(ctx.db, ctx.workspaceId, connectedTokenId()),
  }));

  fastify.post("/api/v1/setup/bridge-tokens", owner, async (request, reply) => {
    const { label } = parseBody(IssueBridgeTokenInput, request.body);
    const { token, record } = issueBridgeToken(ctx.db, ctx.workspaceId, label);
    ctx.logger.info({ tokenId: record.id, label: record.label }, "bridge token issued");
    ctx.changed();
    const result: IssueBridgeTokenResult = {
      token,
      record,
      pluginConfig: {
        channels: { dodok: { accounts: { default: { bridgeUrl: ctx.publicUrl, token } } } },
      },
    };
    // 원문을 되살릴 수 있는 캐시(브라우저·프록시)에 남기지 않는다(Review Focus 3)
    return reply.status(201).header("cache-control", "no-store").send(result);
  });

  fastify.delete("/api/v1/setup/bridge-tokens/:id", owner, async (request, reply) => {
    const { id } = parseParams(TokenParams, request.params);
    if (!revokeBridgeToken(ctx.db, ctx.workspaceId, id))
      throw apiError("NOT_FOUND", "bridge token not found");
    // 폐기는 이미 됐다 — 끊기가 실패해도 다음 핸드셰이크부터 거절된다(스펙 6장)
    try {
      ctx.adapter.revokeBridgeSessions(id);
    } catch (err) {
      ctx.logger.warn({ err, tokenId: id }, "bridge session revoke failed");
    }
    ctx.logger.info({ tokenId: id }, "bridge token revoked");
    ctx.changed();
    return reply.status(204).send();
  });

  fastify.get("/api/v1/setup/plugin.tgz", owner, async (_request, reply) => {
    const file = ctx.pluginFile;
    if (!file) throw pluginFileMissing();
    const bytes = await readFile(file.path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") throw pluginFileMissing();
      throw err;
    });
    // 받은 파일의 sha256 이 화면에 보인 값(부팅 때 잰 것)과 같아야 한다 — 그 뒤 다시 빌드됐으면 재시작해야 맞는다
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
      throw apiError("CONFLICT", "PLUGIN_FILE_CHANGED: restart the server to serve the rebuilt plugin");
    return reply
      .headers({
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="dodok-openclaw-plugin-${file.sha256.slice(0, 12)}.tgz"`,
        "x-content-type-options": "nosniff",
      })
      .send(bytes);
  });
}
