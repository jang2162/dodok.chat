/**
 * 운영 API(운영 보강 스펙 6장) — 전부 admin 이상(팀 스펙 「역할과 권한」 표). 사건은 OpsService 로만 읽고 쓴다(직접 쿼리하면 unacked 캐시와 어긋난다).
 * 응답은 shared 스키마로 한 번 파싱해서 보낸다 — 어기면 서버 버그라 500 INTERNAL
 */
import {
  OpsAckResult,
  OpsEventsPage,
  OpsRunsSummary,
  OpsSettings,
  OpsSettingsPatch,
  OpsSeverity,
} from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { authorizeOpsRead } from "../../auth/policies";
import { requirePolicy, requireRole } from "../../auth/roles";
import { parseBody, parseQuery, parseStored } from "../../http/validate";
import { rescheduleAll } from "../automations/scheduler";
import type { OpsService } from "./service";
import { getOpsSettings, patchOpsSettings } from "./settings";
import { buildOpsStatus, type OpsStatusContext } from "./status";
import { runsSummary, usageTrustedAmong } from "./summary";

export type OpsRouteContext = OpsStatusContext & {
  auth: Auth;
  /** 쓰이는 제공자(붙은 어댑터 가운데 에이전트가 등록된 것) — 런 표의 usage 는 이 가운데 믿는 제공자만 합친다 */
  providersInUse(): Iterable<string>;
  ops: Pick<OpsService, "list" | "ack" | "unacked" | "countsSince">;
};

const RunsQuery = z.object({ days: z.enum(["1", "7"]).transform((d) => (d === "1" ? 1 : 7)) });
const EventsQuery = z.object({ cursor: z.string().optional(), severity: OpsSeverity.optional() });

export function registerOpsRoutes(fastify: FastifyInstance, ctx: OpsRouteContext): void {
  const admin = { preHandler: requireRole(ctx, "admin") };
  const now = ctx.now ?? (() => new Date());

  fastify.get("/api/v1/ops/status", { preHandler: requirePolicy(ctx, authorizeOpsRead) }, async () =>
    buildOpsStatus(ctx),
  );

  fastify.get("/api/v1/ops/runs", admin, async (request) => {
    const { days } = parseQuery(RunsQuery, request.query);
    const summary = runsSummary(ctx.db, {
      days,
      now: now(),
      ops: ctx.ops,
      workspaceId: ctx.workspaceId,
      usageTrustedProviders: usageTrustedAmong(ctx.providersInUse()),
    });
    return parseStored(OpsRunsSummary, summary, "ops runs summary");
  });

  fastify.get("/api/v1/ops/events", admin, async (request) => {
    const { cursor, severity } = parseQuery(EventsQuery, request.query);
    const page = ctx.ops.list({
      ...(cursor === undefined ? {} : { cursor }),
      ...(severity === undefined ? {} : { severity }),
    });
    return parseStored(OpsEventsPage, page, "ops events page");
  });

  // 본문 없음 — 지금까지의 사건을 모두 확인 처리한다
  fastify.post("/api/v1/ops/events/ack", admin, async () =>
    parseStored(OpsAckResult, { acked: ctx.ops.ack() }, "ops ack result"),
  );

  // 준 키만 바꾼다. 시간대가 바뀌면 켜진 예약의 다음 시각을 같은 트랜잭션에서 다시 센다(계획 판정 PA4) — 하나라도 실패하면 설정도 그대로.
  // 그대로면 다시 세지 않는다: 기한이 지나 틱을 기다리는 회차가 지금 뒤의 다음 회차로 밀려 조용히 빠진다
  fastify.patch("/api/v1/ops/settings", admin, async (request) => {
    const patch = parseBody(OpsSettingsPatch, request.body);
    const saved = ctx.db.transaction((tx) => {
      const before = getOpsSettings(tx, ctx.workspaceId).timeZone;
      const settings = patchOpsSettings(tx, ctx.workspaceId, patch);
      if (settings.timeZone !== before) rescheduleAll(tx, ctx.workspaceId, settings.timeZone, now());
      return settings;
    });
    return parseStored(OpsSettings, saved, "ops settings");
  });
}
