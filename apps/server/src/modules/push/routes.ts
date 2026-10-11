/** 푸시 경로(스펙 2.2·5.1). 모두 세션 사용자 — 구독은 그 사람과 등록한 세션에 묶인다 */
import {
  type PushCapabilities,
  PushDeviceInput,
  PushDeviceRemove,
  PushSubscriptionInput,
  PushUnsubscribeInput,
} from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import type { Auth } from "../../auth";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody } from "../../http/validate";
import { removeDevice, upsertDevice } from "./devices";
import { removeSubscription, upsertSubscription } from "./service";

export type PushRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  /** VAPID 공개키 — 웹이 pushManager.subscribe 의 applicationServerKey 로 쓴다 */
  publicKey: string;
  /** 지금 켜진 통로 — 꺼진 플랫폼의 기기 등록은 PUSH_UNAVAILABLE. 부팅 뒤 바뀌지 않는다 */
  capabilities: () => PushCapabilities;
};

/** user_agent 열에 남길 최대 길이 — 헤더는 클라이언트 마음대로라 자른다 */
const USER_AGENT_MAX = 512;

export function registerPushRoutes(fastify: FastifyInstance, ctx: PushRouteContext): void {
  const authed = { preHandler: requireSession(ctx) };

  fastify.get("/api/v1/push/vapid-public-key", authed, async () => ({ publicKey: ctx.publicKey }));

  fastify.post("/api/v1/push/subscriptions", authed, async (request, reply) => {
    const input = parseBody(PushSubscriptionInput, request.body);
    const userAgent = request.headers["user-agent"]?.slice(0, USER_AGENT_MAX);
    const { id: userId, sessionId } = sessionUser(request);
    upsertSubscription(ctx.db, { userId, sessionId }, input, userAgent);
    return reply.code(204).send();
  });

  fastify.delete("/api/v1/push/subscriptions", authed, async (request, reply) => {
    const { endpoint } = parseBody(PushUnsubscribeInput, request.body);
    removeSubscription(ctx.db, sessionUser(request).id, endpoint);
    return reply.code(204).send();
  });

  fastify.get("/api/v1/push/capabilities", authed, async () => ctx.capabilities());

  fastify.post("/api/v1/push/devices", authed, async (request) => {
    const input = parseBody(PushDeviceInput, request.body);
    if (!ctx.capabilities()[input.platform]) {
      throw apiError("PUSH_UNAVAILABLE", `${input.platform} push is not configured on this server`);
    }
    const { id: userId, sessionId } = sessionUser(request);
    return { id: upsertDevice(ctx.db, userId, sessionId, input, new Date()).id };
  });

  fastify.delete("/api/v1/push/devices", authed, async (request, reply) => {
    const { token } = parseBody(PushDeviceRemove, request.body);
    removeDevice(ctx.db, sessionUser(request).id, token);
    return reply.code(204).send();
  });
}
