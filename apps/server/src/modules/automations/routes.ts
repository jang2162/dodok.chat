/**
 * 자동화 관리 API(자동화 스펙 「관리 API」 장) — 전부 admin 이상(팀 스펙 「역할과 권한」 표). 웹훅 토큰 원문은 만들기·재발급 응답의
 * webhookUrl 에만 싣고 그 응답은 `Cache-Control: no-store`. 목록·수정 응답은 toAutomationSummary(경고 포함)
 */
import {
  type AutomationCreated,
  type AutomationPosted,
  type AutomationSchedule,
  CreateAutomationBody,
  Id,
  UpdateAutomationBody,
} from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Auth } from "../../auth";
import { requireRole, sessionUser } from "../../auth/roles";
import type { Db, DbOrTx } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams } from "../../http/validate";
import { assertChannelWritable, loadReadableChannel } from "../channels/service";
import { type PostDeps, postAutomationMessage } from "./post";
import { rescheduleOne } from "./scheduler";
import {
  type AutomationRow,
  deleteAutomation,
  getAutomation,
  insertAutomation,
  listAutomations,
  updateAutomation,
} from "./store";
import { toAutomationSummary } from "./summary";
import { issueWebhookToken } from "./tokens";

export type AutomationRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  /** 「지금 실행」의 게시 — 예약 틱·웹훅과 같은 postAutomationMessage */
  post: PostDeps;
  /** 웹훅 URL 의 오리진 — 서버 공개 주소(bridgePublicUrl)의 http(s) 오리진(계획 판정 PA2, runners/routes.ts runnerServerUrl) */
  publicOrigin: () => string;
  /** 워크스페이스 시간대 — 만들기·켜기·예약 변경의 다음 시각 */
  timeZone: () => string;
  now?: () => Date;
};

const AutomationParams = z.object({ id: Id });

/** 같은 예약인가 — 저장된 JSON 의 키 차례와 무관하게 필드로 견준다 */
function scheduleKey(schedule: AutomationSchedule | null): string {
  if (schedule === null) return "";
  return [
    schedule.repeat,
    "time" in schedule ? schedule.time : "",
    "weekday" in schedule ? schedule.weekday : "",
    "minute" in schedule ? schedule.minute : "",
  ].join("|");
}

export function registerAutomationRoutes(fastify: FastifyInstance, ctx: AutomationRouteContext): void {
  const admin = { preHandler: requireRole(ctx, "admin") };
  const now = ctx.now ?? (() => new Date());
  const requireAutomation = (db: DbOrTx, id: string): AutomationRow => {
    const row = getAutomation(db, ctx.workspaceId, id);
    if (!row) throw apiError("NOT_FOUND", "automation not found");
    return row;
  };
  const webhookUrl = (raw: string) => `${ctx.publicOrigin()}/hooks/${raw}`;
  /**
   * 게시할 채널 — 못 읽는 채널은 없는 채널과 같은 404 가 먼저(auth/channel-access.ts), 읽는 채널이라도 일반 채널이 아니면(DM·direct)
   * VALIDATION(자동화는 DM 에 게시하지 않는다 — 에이전트 DM 스펙 5장·계획 판정 PD5), 보관했으면 CHANNEL_ARCHIVED, 없으면 NOT_FOUND
   */
  const assertTarget = (tx: DbOrTx, channelId: string, userId: string): void => {
    if (loadReadableChannel(tx, channelId, ctx.workspaceId, userId).kind !== "channel")
      throw apiError("VALIDATION", "자동화는 DM 에 게시할 수 없다", { field: "channelId" });
    assertChannelWritable(tx, channelId, ctx.workspaceId);
  };

  fastify.get("/api/v1/automations", admin, async () =>
    listAutomations(ctx.db, ctx.workspaceId).map((row) => toAutomationSummary(ctx.db, row)),
  );

  fastify.post("/api/v1/automations", admin, async (request, reply) => {
    const body = parseBody(CreateAutomationBody, request.body);
    const createdBy = sessionUser(request).id;
    const at = now();
    const token = body.kind === "webhook" ? issueWebhookToken() : undefined;
    const row = ctx.db.transaction((tx) => {
      // 보관한 채널·DM 은 게시할 수 없다 — 만들 때부터 거절한다
      assertTarget(tx, body.channelId, createdBy);
      const id = uuidv7();
      insertAutomation(tx, {
        id,
        workspaceId: ctx.workspaceId,
        name: body.name,
        channelId: body.channelId,
        kind: body.kind,
        bodyMd: body.bodyMd,
        enabled: body.enabled,
        scheduleJson: body.kind === "schedule" ? body.schedule : null,
        tokenHash: token?.hash ?? null,
        tokenPrefix: token?.prefix ?? null,
        createdBy,
        createdAt: at,
        updatedAt: at,
      });
      rescheduleOne(tx, ctx.workspaceId, id, ctx.timeZone(), at);
      return requireAutomation(tx, id);
    });
    const result: AutomationCreated = {
      automation: toAutomationSummary(ctx.db, row),
      ...(token === undefined ? {} : { webhookUrl: webhookUrl(token.raw) }),
    };
    // 원문을 되살릴 수 있는 캐시(브라우저·프록시)에 남기지 않는다
    return reply.status(201).header("cache-control", "no-store").send(result);
  });

  fastify.patch("/api/v1/automations/:id", admin, async (request) => {
    const { id } = parseParams(AutomationParams, request.params);
    const patch = parseBody(UpdateAutomationBody, request.body);
    const userId = sessionUser(request).id;
    const at = now();
    const row = ctx.db.transaction((tx) => {
      const before = requireAutomation(tx, id);
      if (patch.schedule !== undefined && before.kind !== "schedule")
        throw apiError("VALIDATION", "schedule 은 예약 자동화에만 줄 수 있다", { field: "schedule" });
      if (patch.channelId !== undefined && patch.channelId !== before.channelId)
        assertTarget(tx, patch.channelId, userId);
      const after = updateAutomation(tx, ctx.workspaceId, id, {
        name: patch.name,
        channelId: patch.channelId,
        bodyMd: patch.bodyMd,
        scheduleJson: patch.schedule,
        enabled: patch.enabled,
        updatedAt: at,
      });
      // 켜짐·예약이 실제로 바뀔 때만 다시 센다(끄면 비운다). 같은 값을 다시 보내는 저장(대화상자는 모든 칸을 보낸다)마다 세면 기한이
      // 지나 틱을 기다리는 회차가 지금 뒤의 다음 회차로 밀려 조용히 빠진다
      if (
        after.enabled !== before.enabled ||
        scheduleKey(after.scheduleJson) !== scheduleKey(before.scheduleJson)
      )
        rescheduleOne(tx, ctx.workspaceId, id, ctx.timeZone(), at);
      return requireAutomation(tx, id);
    });
    return toAutomationSummary(ctx.db, row);
  });

  // 게시한 메시지는 남는다 — 웹에서는 「지운 자동화」로 보인다
  fastify.delete("/api/v1/automations/:id", admin, async (request, reply) => {
    const { id } = parseParams(AutomationParams, request.params);
    deleteAutomation(ctx.db, ctx.workspaceId, id);
    return reply.status(204).send();
  });

  // 옛 해시를 갈아 끼운다 — 옛 URL 은 곧바로 404(모르는 토큰과 같다)
  fastify.post("/api/v1/automations/:id/token", admin, async (request, reply) => {
    const { id } = parseParams(AutomationParams, request.params);
    const token = issueWebhookToken();
    const row = ctx.db.transaction((tx) => {
      if (requireAutomation(tx, id).kind !== "webhook")
        throw apiError("VALIDATION", "예약 자동화에는 웹훅 토큰이 없다");
      return updateAutomation(tx, ctx.workspaceId, id, {
        tokenHash: token.hash,
        tokenPrefix: token.prefix,
        updatedAt: now(),
      });
    });
    const result: AutomationCreated = {
      automation: toAutomationSummary(ctx.db, row),
      webhookUrl: webhookUrl(token.raw),
    };
    return reply.header("cache-control", "no-store").send(result);
  });

  // 지금 실행 — 종류·켜짐과 무관하게 문구만 게시한다(웹훅 원문 블록 없음). 요청 하나에 게시 하나이고 next_run_at 은 건드리지 않는다
  // (틱의 회차와 따로 센다). 보관한 채널이면 CHANNEL_ARCHIVED 를 그대로 돌려주고 결과는 남기지 않는다 — 누른 사람이 그 자리에서 본다
  fastify.post("/api/v1/automations/:id/run", admin, async (request, reply) => {
    const { id } = parseParams(AutomationParams, request.params);
    const message = await postAutomationMessage(ctx.post, requireAutomation(ctx.db, id));
    // 게시는 라우터를 기다린다 — 그사이 지워졌으면 결과를 남길 행이 없다(웹훅과 같다). 글은 올랐으니 202 로 답한다
    if (getAutomation(ctx.db, ctx.workspaceId, id) !== undefined)
      updateAutomation(ctx.db, ctx.workspaceId, id, { lastRunAt: now(), lastStatus: "ok" });
    const result: AutomationPosted = { messageId: message.id };
    return reply.status(202).send(result);
  });
}
