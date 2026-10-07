/**
 * 웹훅 수신 POST /hooks/<token>(자동화 스펙 「웹훅」 장) — 세션·CSRF 와 무관한 공개 경로이고 `/api` 밖이라 사용자 REST 상한을 타지
 * 않는다(계획 판정 PA5). 토큰은 URL 경로에 있다 — GitHub 같은 서비스는 Authorization 머리를 넣지 못한다(스펙 결정 8).
 *
 * 순서(본문을 받기 전, onRequest): 실패 카운터에 막힌 주소 → 429 / 모르는 토큰 → 실패로 세고 404 / 꺼짐·예약 종류 → 404 /
 * 토큰마다 분당 상한 → 429. 그 뒤에야 본문(64 KiB, 넘으면 413)을 받는다 — 틀린 토큰은 본문 크기와 무관하게 404 다.
 * 404 는 모두 같은 본문이다 — 토큰이 맞았는지·꺼졌는지를 응답으로 드러내지 않는다
 */
import type { AutomationPosted, BridgeAuthGuard } from "@dodok/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { recordRateLimit } from "../ops/http-limits";
import type { Limits } from "../ops/limits";
import { KeyedLimiter } from "../ops/ratelimit";
import type { OpsService } from "../ops/service";
import { webhookBlock } from "./body";
import { type PostDeps, postAutomationMessage } from "./post";
import { markFailed } from "./scheduler";
import { type AutomationRow, updateAutomation } from "./store";
import { findWebhookByToken } from "./tokens";

/** 본문 상한(바이트) — 넘으면 Fastify 가 413. 블록은 이 안에서 다시 8,000자로 자른다(body.ts WEBHOOK_BLOCK_MAX) */
export const WEBHOOK_BODY_MAX = 64 * 1024;

export type WebhookRouteContext = {
  db: Db;
  post: PostDeps;
  /** 브리지·러너 핸드셰이크·첨부 HTTP 와 같은 실패 카운터 인스턴스(app.ts) — 한쪽에서 막힌 주소는 다른 쪽에서도 막힌다 */
  guard: BridgeAuthGuard;
  /** 이번 실패로 그 주소가 막히기 시작했을 때 — app 이 운영 사건 bridge_auth_blocked(detail.path webhook)를 남긴다 */
  onBlocked: (address: string) => void;
  limits: Pick<Limits, "webhookPerMin">;
  ops: Pick<OpsService, "record">;
  /** 실패 카운터·상한의 시계(ms) — app 의 limitClock */
  now: () => number;
};

const notFound = () => apiError("NOT_FOUND", "not found");

export function registerWebhookRoute(fastify: FastifyInstance, ctx: WebhookRouteContext): void {
  // 키는 토큰 해시 — 재발급한 새 토큰은 새 버킷이다
  const perToken = new KeyedLimiter({ perMin: ctx.limits.webhookPerMin, now: ctx.now });
  const accepted = new WeakMap<FastifyRequest, AutomationRow>();

  const authorize = async (request: FastifyRequest): Promise<void> => {
    // request.ip 는 TRUST_PROXY 일 때 X-Forwarded-For 를 따른다 — 첨부 HTTP(http/agent-token.ts)와 같은 주소
    const address = request.ip;
    const at = ctx.now();
    if (ctx.guard.isBlocked(address, at)) throw apiError("RATE_LIMITED", "인증 실패가 너무 많습니다");
    const { token } = request.params as { token: string };
    const row = findWebhookByToken(ctx.db, token);
    if (!row) {
      if (ctx.guard.fail(address, at)) ctx.onBlocked(address);
      throw notFound();
    }
    // 꺼짐·예약 종류는 토큰이 맞았다 — 실패로 세지 않되 모르는 토큰과 같은 404 로 답한다
    if (!row.enabled || row.kind !== "webhook" || row.tokenHash === null) throw notFound();
    if (!perToken.take(row.tokenHash)) {
      recordRateLimit(ctx.ops, request);
      throw apiError("RATE_LIMITED", "요청이 너무 많습니다");
    }
    accepted.set(request, row);
  };

  void fastify.register(async (scope) => {
    // 원문은 Content-Type 과 무관하게 문자열로 받는다 — JSON 해석은 webhookBlock 이 한다(깨진 JSON 도 받아 텍스트 블록으로).
    // 파서 교체와 본문 상한은 이 캡슐 안에만 걸린다 — /api 의 JSON 파서·기본 상한은 그대로다
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

    scope.post(
      "/hooks/:token",
      { onRequest: authorize, bodyLimit: WEBHOOK_BODY_MAX },
      async (request, reply) => {
        const automation = accepted.get(request) as AutomationRow;
        const raw = typeof request.body === "string" ? request.body : "";
        const block = webhookBlock(raw, request.headers["content-type"]);
        let messageId: string;
        try {
          messageId = (await postAutomationMessage(ctx.post, automation, block)).id;
        } catch (err) {
          // 보낸 쪽 말고는 아무도 이 응답을 보지 않는다 — 목록의 마지막 결과와 운영 사건으로 남긴다
          markFailed({ db: ctx.db, ops: ctx.ops, logger: ctx.post.logger }, automation, err);
          throw err;
        }
        updateAutomation(ctx.db, automation.workspaceId, automation.id, {
          lastRunAt: new Date(),
          lastStatus: "ok",
        });
        const result: AutomationPosted = { messageId };
        return reply.status(202).send(result);
      },
    );
  });
}
