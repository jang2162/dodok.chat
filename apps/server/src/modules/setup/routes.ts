/**
 * 설정 마법사 API(스펙 3장) — 연결 상태는 owner 세션만, 품은 플러그인 tgz 는 owner 세션 또는 브리지 토큰(설정 통합 스펙 「토큰으로
 * 설치 파일 받기」 절). Gateway·브리지 토큰은 `modules/gateways/` 가 맡는다(멀티 Gateway 계획 판정 PG6). 로그인 없는 `GET /llms.txt`·
 * 플러그인 설치 스크립트(설치 한 줄 명령 스펙 2026-11-02)도 여기다
 */
import { PLUGIN_INSTALL_SCRIPT_PATH, type SetupStatus } from "@dodok/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from "fastify";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Auth } from "../../auth";
import { requireOwner } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { requireOwnerOrToken } from "./installer-auth";
import type { PluginFile } from "./plugin-file";

export type SetupRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  /** 부팅 때 잰 품은 플러그인 파일(없으면 null) */
  pluginFile: PluginFile | null;
  status(): SetupStatus;
  /** 브리지 토큰 인증(requireAgentToken — 첨부 HTTP 와 같은 실패 카운터, 꺼진 Gateway 의 토큰은 세지 않고 401) */
  bridgeToken: (request: FastifyRequest) => Promise<void>;
  /** 부팅 때 채운 `llms.txt` 본문(renderLlmsTxt)과 그 IP 버킷 */
  llmsTxt: string;
  llmsLimit: onRequestHookHandler;
  /** 부팅 때 채운 플러그인 설치 스크립트(renderPluginInstallScript) — 품은 tgz 가 없으면 null(404 PLUGIN_FILE_MISSING) */
  pluginInstallScript: string | null;
};

/** 파일이 없을 때의 404 — 웹이 받기 대신 만드는 법을 보인다 */
const pluginFileMissing = () => apiError("NOT_FOUND", "PLUGIN_FILE_MISSING");

export function registerSetupRoutes(fastify: FastifyInstance, ctx: SetupRouteContext): void {
  const owner = { preHandler: requireOwner(ctx) };

  fastify.get("/api/v1/setup/status", owner, async () => ctx.status());

  fastify.get(
    "/api/v1/setup/plugin.tgz",
    { preHandler: requireOwnerOrToken(ctx, ctx.bridgeToken) },
    async (_request, reply) =>
      sendPackedFile(reply, ctx.pluginFile, {
        missing: pluginFileMissing,
        changedMessage: "PLUGIN_FILE_CHANGED: restart the server to serve the rebuilt plugin",
        fileName: (sha) => `dodok-openclaw-plugin-${sha.slice(0, 12)}.tgz`,
      }),
  );

  const text = { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" };
  // 로그인 없음 — 본문에는 공개 주소와 품은 파일의 해시만 있다(토큰·Gateway·사람 없음)
  fastify.get("/llms.txt", { onRequest: ctx.llmsLimit }, async (_request, reply) =>
    reply.headers(text).send(ctx.llmsTxt),
  );
  // 로그인 없음 — llms.txt 와 같은 공개 값만 품고 같은 IP 버킷을 쓴다. 토큰은 실행하는 쪽의 환경 변수로만 온다
  fastify.get(PLUGIN_INSTALL_SCRIPT_PATH, { onRequest: ctx.llmsLimit }, async (_request, reply) => {
    if (ctx.pluginInstallScript === null) throw pluginFileMissing();
    return reply.headers(text).send(ctx.pluginInstallScript);
  });
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
