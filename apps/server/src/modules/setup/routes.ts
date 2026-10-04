/**
 * 설정 마법사 API(스펙 3장) — 전부 owner 세션만. 연결 상태와 품은 플러그인 tgz. Gateway·브리지 토큰은 `modules/gateways/` 가
 * 맡는다(멀티 Gateway 계획 판정 PG6).
 */
import type { SetupStatus } from "@dodok/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Auth } from "../../auth";
import { requireOwner } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import type { PluginFile } from "./plugin-file";

export type SetupRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  /** 부팅 때 잰 품은 플러그인 파일(없으면 null) */
  pluginFile: PluginFile | null;
  status(): SetupStatus;
};

/** 파일이 없을 때의 404 — 웹이 받기 대신 만드는 법을 보인다 */
const pluginFileMissing = () => apiError("NOT_FOUND", "PLUGIN_FILE_MISSING");

export function registerSetupRoutes(fastify: FastifyInstance, ctx: SetupRouteContext): void {
  const owner = { preHandler: requireOwner(ctx) };

  fastify.get("/api/v1/setup/status", owner, async () => ctx.status());

  fastify.get("/api/v1/setup/plugin.tgz", owner, async (_request, reply) =>
    sendPackedFile(reply, ctx.pluginFile, {
      missing: pluginFileMissing,
      changedMessage: "PLUGIN_FILE_CHANGED: restart the server to serve the rebuilt plugin",
      fileName: (sha) => `dodok-openclaw-plugin-${sha.slice(0, 12)}.tgz`,
    }),
  );
}

/** 부팅 때 잰 tgz 를 내려 준다 — 플러그인·러너가 같은 규칙(파일이 없으면 missing, 그 뒤 다시 빌드됐으면 CONFLICT) */
export async function sendPackedFile(
  reply: FastifyReply,
  file: PluginFile | null,
  opts: { missing: () => Error; changedMessage: string; fileName: (sha256: string) => string },
) {
  if (!file) throw opts.missing();
  const bytes = await readFile(file.path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw opts.missing();
    throw err;
  });
  // 받은 파일의 sha256 이 화면에 보인 값(부팅 때 잰 것)과 같아야 한다 — 그 뒤 다시 빌드됐으면 재시작해야 맞는다
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw apiError("CONFLICT", opts.changedMessage);
  return reply
    .headers({
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${opts.fileName(file.sha256)}"`,
      "x-content-type-options": "nosniff",
    })
    .send(bytes);
}
