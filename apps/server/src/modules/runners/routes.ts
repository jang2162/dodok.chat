/**
 * 연결 페이지 러너 API(러너 스펙 5장) — 토큰 발급·다시 발급·폐기, owner 세션만(러너 tgz 만 owner 세션 또는 러너 토큰 — 설정 통합 스펙 「토큰으로 설치 파일
 * 받기」 절). 토큰 원문은 발급·다시 발급 응답에만 싣고 그 응답은 `Cache-Control: no-store`.
 * 목록·상태·로그·wire 어디에도 원문은 없다(브리지 토큰 API — setup/routes.ts — 와 같은 규칙)
 */
import {
  Id,
  IssueRunnerTokenInput,
  type IssueRunnerTokenResult,
  type ReissueRunnerTokenResult,
} from "@dodok/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AdapterRegistry } from "../../adapters/registry";
import type { Auth } from "../../auth";
import { requireOwner } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams } from "../../http/validate";
import type { Logger } from "../../logger";
import type { OpsService } from "../ops/service";
import { requireOwnerOrToken } from "../setup/installer-auth";
import { sendPackedFile } from "../setup/routes";
import type { RunnerFile } from "./runner-file";
import { issueRunnerToken, listRunnerTokens, reissueRunnerToken, revokeRunnerToken } from "./tokens";

/** 러너 설정 파일의 tokenFile 권장 자리 — 원문은 설정 파일이 아니라 이 파일에 둔다 */
export const RUNNER_TOKEN_FILE = "~/.dodok-runner/token";

/** 러너 설정의 serverUrl — 브리지 공개 주소(setup/status.ts bridgePublicUrl)의 오리진을 http(s) 로. 러너는 여기에 /runner 를 붙인다 */
export function runnerServerUrl(bridgePublicUrl: string): string {
  const url = new URL(bridgePublicUrl);
  const protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//${url.host}`;
}

export type RunnerRouteContext = {
  auth: Auth;
  db: Db;
  logger: Logger;
  workspaceId: string;
  /** 러너 어댑터(runner) — 목록의 connected·폐기 때 그 토큰의 연결 끊기. 붙지 않았으면 둘 다 할 일이 없다 */
  registry: Pick<AdapterRegistry, "forProvider">;
  /** 폐기 때 그 토큰의 열린 runner_down 을 닫는다 — 폐기된 토큰은 다시 붙지 못해 붙음으로 닫힐 일이 없다(리뷰 M2) */
  ops: Pick<OpsService, "resolve">;
  /** 부팅 때 잰 품은 러너 파일(없으면 null) */
  runnerFile: RunnerFile | null;
  serverUrl: string;
  /** 러너 토큰 인증(requireAgentToken — 첨부 HTTP·핸드셰이크와 같은 실패 카운터) */
  runnerToken: (request: FastifyRequest) => Promise<void>;
  /** 토큰 발급·다시 발급·폐기 뒤 — setup.status 를 다시 알린다 */
  changed(): void;
};

const TokenParams = z.object({ id: Id });

/** 파일이 없을 때의 404 — 웹이 받기 대신 만드는 법을 보인다 */
const runnerFileMissing = () => apiError("NOT_FOUND", "RUNNER_FILE_MISSING");

export function registerRunnerRoutes(fastify: FastifyInstance, ctx: RunnerRouteContext): void {
  const owner = { preHandler: requireOwner(ctx) };
  const connectedTokenIds = (): ReadonlySet<string> => {
    const detail = ctx.registry.forProvider("runner")?.setupDetail();
    return new Set(detail?.provider === "runner" ? detail.runners.map((r) => r.tokenId) : []);
  };

  fastify.get("/api/v1/setup/runner-tokens", owner, async () => ({
    tokens: listRunnerTokens(ctx.db, ctx.workspaceId, connectedTokenIds()),
  }));

  fastify.post("/api/v1/setup/runner-tokens", owner, async (request, reply) => {
    const { label } = parseBody(IssueRunnerTokenInput, request.body);
    const { token, record } = issueRunnerToken(ctx.db, ctx.workspaceId, label);
    ctx.logger.info({ tokenId: record.id, label: record.label }, "runner token issued");
    ctx.changed();
    const result: IssueRunnerTokenResult = {
      token,
      record,
      runnerConfig: { serverUrl: ctx.serverUrl, tokenFile: RUNNER_TOKEN_FILE },
    };
    // 원문을 되살릴 수 있는 캐시(브라우저·프록시)에 남기지 않는다
    return reply.status(201).header("cache-control", "no-store").send(result);
  });

  fastify.delete("/api/v1/setup/runner-tokens/:id", owner, async (request, reply) => {
    const { id } = parseParams(TokenParams, request.params);
    if (!revokeRunnerToken(ctx.db, ctx.workspaceId, id))
      throw apiError("NOT_FOUND", "runner token not found");
    // 폐기는 이미 됐다 — 끊기가 실패해도 다음 핸드셰이크부터 거절된다. 끊긴 러너의 런은 어댑터가 ADAPTER_UNAVAILABLE 로 닫는다
    try {
      ctx.registry.forProvider("runner")?.revokeTokenSessions(id);
    } catch (err) {
      ctx.logger.warn({ err, tokenId: id }, "runner session revoke failed");
    }
    try {
      ctx.ops.resolve("runner_down", id);
    } catch (err) {
      ctx.logger.warn({ err, tokenId: id }, "runner_down resolve on revoke failed");
    }
    ctx.logger.info({ tokenId: id }, "runner token revoked");
    ctx.changed();
    return reply.status(204).send();
  });

  /**
   * 다시 발급(러너 일반화 계획 판정 PR7) — 같은 러너(행)에 새 원문. 옛 원문의 연결은 폐기와 같은 길로 끊는다(러너는 종료 2, 열린 런은
   * 어댑터가 ADAPTER_UNAVAILABLE 로 닫는다). 프로젝트·에이전트는 그 러너에 남는다 — 머신에 새 토큰을 넣고 다시 띄우면 이어진다
   */
  fastify.post("/api/v1/setup/runner-tokens/:id/reissue", owner, async (request, reply) => {
    const { id } = parseParams(TokenParams, request.params);
    const { token, record } = reissueRunnerToken(ctx.db, ctx.workspaceId, id);
    try {
      ctx.registry.forProvider("runner")?.revokeTokenSessions(id);
    } catch (err) {
      ctx.logger.warn({ err, tokenId: id }, "runner session revoke on reissue failed");
    }
    ctx.logger.info({ tokenId: id }, "runner token reissued");
    ctx.changed();
    const result: ReissueRunnerTokenResult = {
      token,
      record,
      runnerConfig: { serverUrl: ctx.serverUrl, tokenFile: RUNNER_TOKEN_FILE },
    };
    return reply.header("cache-control", "no-store").send(result);
  });

  fastify.get(
    "/api/v1/setup/runner.tgz",
    { preHandler: requireOwnerOrToken(ctx, ctx.runnerToken) },
    async (_request, reply) =>
      sendPackedFile(reply, ctx.runnerFile, {
        missing: runnerFileMissing,
        changedMessage: "RUNNER_FILE_CHANGED: restart the server to serve the rebuilt runner",
        fileName: (sha) => `dodok-claude-runner-${sha.slice(0, 12)}.tgz`,
      }),
  );
}
