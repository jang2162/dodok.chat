/**
 * 운영 API(운영 보강 스펙 6장) — 전부 admin 이상(팀 스펙 「역할과 권한」 표). 사건은 OpsService 로만 읽고 쓴다(직접 쿼리하면 unacked 캐시와 어긋난다).
 * 응답은 shared 스키마로 한 번 파싱해서 보낸다 — 어기면 서버 버그라 500 INTERNAL
 */
import {
  OpsAckResult,
  OpsEventsPage,
  OpsRunsSummary,
  OpsSettingsPatch,
  OpsSeverity,
  OpsStatus,
} from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentAdapter } from "../../adapters/types";
import type { Auth } from "../../auth";
import { requireRole } from "../../auth/roles";
import type { Db } from "../../db/client";
import { parseBody, parseQuery, parseStored } from "../../http/validate";
import { countRunsTodayInWorkspace } from "../runs/store";
import { type DiskState, gatewayPin } from "./health";
import type { OpsService } from "./service";
import { getOpsSettings, patchOpsSettings } from "./settings";
import { runsSummary } from "./summary";

export type OpsRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  adapter: Pick<AgentAdapter, "status" | "setupDetail">;
  ops: Pick<OpsService, "list" | "ack" | "unacked" | "countsSince">;
  disk(): DiskState;
  serverVersion: string;
  startedAt: Date;
  /** 직전 종료 표지(main 이 startRunState 뒤에 넘긴다) — 넘기기 전이나 표지가 없으면 null */
  previousClean(): boolean | null;
  now?: () => Date;
};

const RunsQuery = z.object({ days: z.enum(["1", "7"]).transform((d) => (d === "1" ? 1 : 7)) });
const EventsQuery = z.object({ cursor: z.string().optional(), severity: OpsSeverity.optional() });

export function registerOpsRoutes(fastify: FastifyInstance, ctx: OpsRouteContext): void {
  const admin = { preHandler: requireRole(ctx, "admin") };
  const now = ctx.now ?? (() => new Date());

  fastify.get("/api/v1/ops/status", admin, async () => {
    const at = now();
    const adapter = ctx.adapter.status();
    const detail = ctx.adapter.setupDetail();
    // gateway·plugin 줄은 OpenClaw 어댑터의 것 — 다른 어댑터면 붙은 것이 없는 모양
    const openclaw = adapter.provider === "openclaw" ? adapter : undefined;
    const version = detail.provider === "openclaw" ? detail.gateway.version : null;
    const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate());
    const status: OpsStatus = {
      workspaceId: ctx.workspaceId,
      server: {
        version: ctx.serverVersion,
        startedAt: ctx.startedAt.toISOString(),
        previousClean: ctx.previousClean(),
      },
      db: { bytes: dbBytes(ctx.db) },
      disk: ctx.disk(),
      adapter,
      gateway: { state: openclaw?.gateway ?? "down", version, ...gatewayPin(version) },
      plugin: { state: openclaw?.bridge ?? "down" },
      runsToday: countRunsTodayInWorkspace(ctx.db, at),
      dailyRunLimit: getOpsSettings(ctx.db, ctx.workspaceId).dailyRunLimit,
      blockedToday: ctx.ops.countsSince("run_limit", midnight).get("workspace") ?? 0,
      unacked: ctx.ops.unacked(),
    };
    return parseStored(OpsStatus, status, "ops status");
  });

  fastify.get("/api/v1/ops/runs", admin, async (request) => {
    const { days } = parseQuery(RunsQuery, request.query);
    const summary = runsSummary(ctx.db, { days, now: now(), ops: ctx.ops, workspaceId: ctx.workspaceId });
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

  fastify.patch("/api/v1/ops/settings", admin, async (request) => {
    const { dailyRunLimit } = parseBody(OpsSettingsPatch, request.body);
    const saved = patchOpsSettings(ctx.db, ctx.workspaceId, { dailyRunLimit });
    return parseStored(OpsSettingsPatch, { dailyRunLimit: saved.dailyRunLimit }, "ops settings");
  });
}

/** SQLite 가 보는 DB 크기(page_count × page_size) — 체크포인트 전 WAL 파일은 따로 세지 않는다 */
function dbBytes(db: Db): number {
  const pages = db.$client.pragma("page_count", { simple: true }) as number;
  const pageSize = db.$client.pragma("page_size", { simple: true }) as number;
  return pages * pageSize;
}
