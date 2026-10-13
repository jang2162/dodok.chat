/**
 * 에이전트 쪽(브리지·러너) 토큰과 /mcp 개인 토큰의 인증 onRequest — 첨부 HTTP·설치 파일 받기·/mcp 가 같은 실패 카운터를 지난다
 * (app.ts 가 하나의 BridgeAuthGuard 를 핸드셰이크·첨부·설치 파일·/mcp 에 준다). 그래서 어느 경로로 토큰을 맞혀 봐도 같은 버킷이 막는다
 */
import type { BridgeAuthGuard } from "@dodok/shared";
import type { FastifyRequest } from "fastify";
import { ipPrefix } from "../modules/ops/ip";
import { apiError } from "./errors";

/** 외부 입력(Bearer 값) 그대로 받아 통과면 무엇이든, 아니면 null */
export type TokenVerifier = (presented: unknown) => unknown;
/** 막히게 한 쪽 — mcp 는 /mcp 의 개인 토큰(제어 MCP 스펙 「개인 토큰(PAT)」 절) */
export type TokenPath = "bridge" | "runner" | "mcp";

/**
 * 브리지·러너 핸드셰이크와 같은 실패 카운터 인스턴스. 주소는 request.ip — TRUST_PROXY 일 때 X-Forwarded-For 를 따르는 것이
 * 핸드셰이크의 bridgeClientAddress 와 같다. onBlocked 의 path 는 막히게 한 쪽
 */
export type AgentTokenGuard = {
  guard: BridgeAuthGuard;
  now: () => number;
  onBlocked: (address: string, path: TokenPath) => void;
};

/** `Authorization: Bearer <값>` 의 값. 머리가 없거나 Bearer 가 아니면 undefined */
export function bearerOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : undefined;
}

/**
 * 통과한 검증 결과는 verified 에 요청별로 남긴다(러너 첨부 GET·POST 가 토큰 id 를 읽는다). accept 가 false 면 맞는 토큰이어도
 * 401 이되 실패로 세지 않는다 — 꺼진 Gateway 의 토큰(멀티 Gateway 스펙 「오류 처리」 절, 끈 것은 고장이 아니다)
 */
export function requireAgentToken(opts: {
  verify: TokenVerifier;
  guard: AgentTokenGuard;
  path: TokenPath;
  /** 거절 로그의 route — 어느 HTTP 표면에서 거절됐는가 */
  route: string;
  verified?: WeakMap<FastifyRequest, unknown>;
  accept?: (result: unknown) => boolean;
}) {
  const { verify, path, route, verified, accept } = opts;
  return async (request: FastifyRequest): Promise<void> => {
    const { guard, now, onBlocked } = opts.guard;
    const address = request.ip;
    const at = now();
    // 막힌 주소는 토큰을 보지 않는다 — 성공도 카운터를 비우지 않으므로 정상 토큰도 막힌 동안은 429
    if (guard.isBlocked(address, at)) throw apiError("RATE_LIMITED", "인증 실패가 너무 많습니다");
    const provided = bearerOf(request);
    let result: unknown;
    try {
      result = verify(provided);
    } catch (err) {
      // 검증 오류(저장소 등)는 통과가 아니라 거절이다(fail-closed) — 원인만 남기고 토큰은 싣지 않는다.
      // 플러그인·러너 잘못이 아니라 실패로 세지 않는다(핸드셰이크와 같다)
      request.log.error({ err }, `${path} token verification failed`);
      throw apiError("UNAUTHORIZED", `${path} 토큰이 틀렸다`);
    }
    if (result) {
      if (accept && !accept(result)) {
        // 핸드셰이크 거절(브리지 서버 미들웨어)과 같은 사유·문구 — 토큰이 맞았다는 것을 응답으로 알리지 않는다
        request.log.warn(
          { reason: `token mismatch from ${ipPrefix(address)}`, route },
          `${path} connection rejected`,
        );
        throw apiError("UNAUTHORIZED", `${path} 토큰이 틀렸다`);
      }
      verified?.set(request, result);
      return;
    }
    if (guard.fail(address, at)) onBlocked(address, path);
    throw apiError("UNAUTHORIZED", `${path} 토큰이 틀렸다`);
  };
}
