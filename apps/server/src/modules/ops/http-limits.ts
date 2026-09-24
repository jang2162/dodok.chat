import type { FastifyRequest } from "fastify";
import { apiError } from "../../http/errors";
import { ipPrefix } from "./ip";
import type { Limits } from "./limits";
import { KeyedLimiter } from "./ratelimit";
import type { OpsService } from "./service";

/**
 * 로그인 뒤 REST 상한(스펙 4.2) — 앱 인스턴스에 달아 두고 requireSession·업로드 onRequest 가 부른다. 모듈마다 컨텍스트로
 * 넘기지 않는 까닭: requireSession 을 쓰는 라우트 모듈이 여럿이고, 하나라도 빠뜨리면 그 라우트만 조용히 상한이 없다
 */
declare module "fastify" {
  interface FastifyInstance {
    /** createApp 이 단다. 없으면(라우트를 단독으로 띄운 테스트) 상한을 걸지 않는다 */
    restLimits?: RestLimits;
  }
}

export type RestLimits = {
  /** /api/v1/* 사용자당 분당 — 넘으면 429 RATE_LIMITED 를 던진다 */
  rest(request: FastifyRequest, userId: string): void;
  /** 첨부 업로드 사용자당 분당(rest 위에 한 번 더) */
  upload(request: FastifyRequest, userId: string): void;
};

export function createRestLimits(deps: {
  limits: Pick<Limits, "restPerMin" | "uploadPerMin">;
  ops: Pick<OpsService, "record">;
  now?: () => number;
}): RestLimits {
  const clock = deps.now === undefined ? {} : { now: deps.now };
  const rest = new KeyedLimiter({ perMin: deps.limits.restPerMin, ...clock });
  const upload = new KeyedLimiter({ perMin: deps.limits.uploadPerMin, ...clock });
  const check = (limiter: KeyedLimiter, request: FastifyRequest, userId: string) => {
    if (limiter.take(userId)) return;
    recordRateLimit(deps.ops, request);
    throw apiError("RATE_LIMITED", "요청이 너무 많습니다");
  };
  return {
    rest: (request, userId) => check(rest, request, userId),
    upload: (request, userId) => check(upload, request, userId),
  };
}

/**
 * REST 레이트리밋 사건. key 는 라우트 패턴(`/api/v1/channels/:id`) — 실제 URL 을 넣으면 id 마다 줄이 생기고 줄마다 unacked
 * 재계산이 돈다. 같은 줄의 폭주는 OpsService 가 묶는다(호출자 스로틀 없음)
 */
export function recordRateLimit(ops: Pick<OpsService, "record">, request: FastifyRequest): void {
  ops.record({
    kind: "ratelimit",
    key: `rest:${request.routeOptions.url ?? "unknown"}`,
    severity: "info",
    detail: { ipPrefix: ipPrefix(request.ip) },
  });
}
