/**
 * 웹훅 수신 POST /hooks/<token>(자동화 스펙 「웹훅」 장) — 세션·CSRF 와 무관한 공개 경로이고 `/api` 밖이라 사용자 REST 상한을 타지
 * 않는다(계획 판정 PA5). 토큰은 URL 경로에 있다 — GitHub 같은 서비스는 Authorization 머리를 넣지 못한다(스펙 결정 8).
 *
 * 순서(본문을 받기 전, onRequest): 켜진 웹훅의 토큰이 아니면 — 실패 카운터에 막힌 주소 → 429 / 모르는 토큰 → 실패로 세고 404 /
 * 꺼짐·예약 종류 → 404. 켜진 웹훅의 토큰은 주소가 막혀 있어도 지나가 토큰마다 분당 상한 → 429. 그 뒤에야 본문(64 KiB, 넘으면
 * 413)을 받는다 — 틀린 토큰은 본문 크기와 무관하게 404 다. 본문을 다 받으면 게시 직전에 자동화를 다시 읽는다(받는 동안 꺼졌거나
 * 재발급·삭제됐으면 404 — 본문을 받는 데는 시한이 없다).
 * 404 는 모두 같은 본문이다 — 토큰이 맞았는지·꺼졌는지를 응답으로 드러내지 않는다(막힌 주소에서는 둘 다 같은 429)
 */
import type { AutomationPosted, BridgeAuthGuard, Message } from "@dodok/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { recordRateLimit } from "../ops/http-limits";
import type { Limits } from "../ops/limits";
import { KeyedLimiter } from "../ops/ratelimit";
import type { OpsService } from "../ops/service";
import { webhookBlock } from "./body";
import { type PostDeps, storeAutomationMessage } from "./post";
import { markFailed } from "./scheduler";
import { type AutomationRow, getAutomation, updateAutomation } from "./store";
import { findWebhookByToken } from "./tokens";

/** 본문 상한(바이트) — 넘으면 Fastify 가 413. 블록은 이 안에서 다시 8,000자로 자른다(body.ts WEBHOOK_BLOCK_MAX) */
export const WEBHOOK_BODY_MAX = 64 * 1024;

export type WebhookRouteContext = {
  db: Db;
  post: PostDeps;
  /**
   * 웹훅만 쓰는 실패 카운터 인스턴스(app.ts) — 브리지·러너와 나누지 않는다. GitHub 같은 서비스는 여러 고객이 발신 주소를 나눠 쓰므로
   * 남의 틀린 토큰이 그 주소를 막을 수 있다 — 그 막힘이 브리지·러너·첨부 HTTP 까지 막지 않게
   */
  guard: BridgeAuthGuard;
  /** 이번 실패로 그 주소가 막히기 시작했을 때 — app 이 운영 사건 bridge_auth_blocked(detail.path webhook)를 남긴다 */
  onBlocked: (address: string) => void;
  limits: Pick<Limits, "webhookPerMin">;
  ops: Pick<OpsService, "record">;
  /** 실패 카운터·상한의 시계(ms) — app 의 limitClock */
  now: () => number;
};

const notFound = () => apiError("NOT_FOUND", "not found");

type LiveWebhook = AutomationRow & { tokenHash: string };

/** 게시를 받는 행 — 켜진 웹훅이고 토큰이 있다 */
const isLive = (row: AutomationRow): row is LiveWebhook =>
  row.enabled && row.kind === "webhook" && row.tokenHash !== null;

/** 잘못된 바이트는 U+FFFD 로 바꾼다(fatal 아님) — Latin-1 로 보내는 옛 서비스의 é 하나로 이벤트를 잃지 않게. 앞의 BOM 은 뗀다 */
const utf8 = new TextDecoder();

export function registerWebhookRoute(fastify: FastifyInstance, ctx: WebhookRouteContext): void {
  // 키는 토큰 해시 — 재발급한 새 토큰은 새 버킷이다
  const perToken = new KeyedLimiter({ perMin: ctx.limits.webhookPerMin, now: ctx.now });
  const accepted = new WeakMap<FastifyRequest, LiveWebhook>();

  const authorize = async (request: FastifyRequest): Promise<void> => {
    // request.ip 는 TRUST_PROXY 일 때 X-Forwarded-For 를 따른다 — 첨부 HTTP(http/agent-token.ts)와 같은 주소
    const address = request.ip;
    const at = ctx.now();
    const { token } = request.params as { token: string };
    const row = findWebhookByToken(ctx.db, token);
    if (!row || !isLive(row)) {
      // 막힘은 받지 못할 토큰에만 — 맞는 토큰은 막아도 지키는 것이 없고(256비트라 맞혀 보기는 막힘 없이도 안 된다), 막으면 발신
      // 주소를 나눠 쓰는 서비스(GitHub 등)에서 남의 틀린 토큰이 정상 웹훅을 막는다. 막힌 주소에서는 모르는 토큰과 꺼진 토큰이 같은 429 다
      if (ctx.guard.isBlocked(address, at)) throw apiError("RATE_LIMITED", "인증 실패가 너무 많습니다");
      // 꺼짐·예약 종류는 토큰이 맞았다 — 실패로 세지 않되 모르는 토큰과 같은 404 로 답한다
      if (!row && ctx.guard.fail(address, at)) ctx.onBlocked(address);
      throw notFound();
    }
    if (!perToken.take(row.tokenHash)) {
      recordRateLimit(ctx.ops, request);
      throw apiError("RATE_LIMITED", "요청이 너무 많습니다");
    }
    accepted.set(request, row);
  };

  void fastify.register(async (scope) => {
    // 원문은 Content-Type 과 무관하게 바이트로 받아 UTF-8 로 푼다 — JSON 해석은 webhookBlock 이 한다(깨진 JSON 도 받아 텍스트
    // 블록으로). parseAs "string" 은 푼 글을 다시 바이트로 세어 잘못된 UTF-8 을 400(길이 불일치)·413(부푼 길이)으로 만든다.
    // 파서 교체와 본문 상한은 이 캡슐 안에만 걸린다 — /api 의 JSON 파서·기본 상한은 그대로다
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, utf8.decode(body as Buffer)),
    );

    scope.post(
      "/hooks/:token",
      { onRequest: authorize, bodyLimit: WEBHOOK_BODY_MAX },
      async (request, reply) => {
        const verified = accepted.get(request) as LiveWebhook;
        const raw = typeof request.body === "string" ? request.body : "";
        const block = webhookBlock(raw, request.headers["content-type"]);
        // 본문을 받는 동안 꺼졌거나 재발급(해시가 다르다)·삭제됐으면 확인한 토큰은 이제 맞지 않다 — onRequest 와 같은 404.
        // 유출된 토큰으로 미리 열어 둔 연결이 재발급 뒤에 게시하지 못하게
        const automation = getAutomation(ctx.db, verified.workspaceId, verified.id);
        if (!automation || !isLive(automation) || automation.tokenHash !== verified.tokenHash)
          throw notFound();
        // 게시는 라우터를 기다린다 — 그사이 지워졌으면 결과를 남길 행이 없다(updateAutomation 이 NOT_FOUND 로 던진다)
        const stillThere = () => getAutomation(ctx.db, automation.workspaceId, automation.id) !== undefined;
        // 보낸 쪽 말고는 아무도 이 응답을 보지 않는다 — 실패는 목록의 마지막 결과와 운영 사건으로 남긴다
        const failed = (err: unknown) => {
          if (stillThere())
            markFailed({ db: ctx.db, ops: ctx.ops, logger: ctx.post.logger }, automation, err);
        };
        let message: Message;
        try {
          message = storeAutomationMessage(ctx.post, automation, block);
        } catch (err) {
          failed(err);
          throw err;
        }
        const result: AutomationPosted = { messageId: message.id };
        try {
          await ctx.post.route(message);
        } catch (err) {
          // 글은 이미 올랐다 — 오류로 답하면 보낸 쪽이 다시 보내 같은 글이 두 번 오른다. 받은 것으로 답하고 결과만 error 로
          failed(err);
          return reply.status(202).send(result);
        }
        if (stillThere())
          updateAutomation(ctx.db, automation.workspaceId, automation.id, {
            lastRunAt: new Date(),
            lastStatus: "ok",
          });
        return reply.status(202).send(result);
      },
    );
  });
}
