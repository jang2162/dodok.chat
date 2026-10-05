/**
 * 설치 파일(`plugin.tgz`·`runner.tgz`) 받기의 인증 — owner 세션, 또는 그 노드에 줄 발급 토큰(설정 통합 스펙 「토큰으로 설치 파일
 * 받기」 절). 노드의 AI 는 owner 세션이 없고 사람에게 받은 토큰 하나만 든다
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Auth } from "../../auth";
import { verifySessionToken } from "../../auth/index";
import { sessionTokenOf } from "../../auth/roles";
import { requireOwner } from "../../auth/routes";
import type { Db } from "../../db/client";
import { bearerOf } from "../../http/agent-token";
import { apiError } from "../../http/errors";

/**
 * 살아 있는 세션이면 세션 규칙 그대로(owner 가 아니면 403, membership 이 없으면 401) — 토큰 쪽으로 넘어가지 않는다.
 * 세션이 없을 때만 Bearer 값을 token(requireAgentToken)에 맡긴다. Bearer 가 아예 없으면 맞혀 보는 시도가 아니라 실패로 세지 않고 401
 */
export function requireOwnerOrToken(
  ctx: { auth: Auth; db: Db; workspaceId: string },
  token: (request: FastifyRequest) => Promise<void>,
) {
  const owner = requireOwner(ctx);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = sessionTokenOf(request);
    if (session && (await verifySessionToken(ctx.auth, session))) return owner(request, reply);
    if (!bearerOf(request)) throw apiError("UNAUTHORIZED", "로그인이 필요하다");
    await token(request);
  };
}
