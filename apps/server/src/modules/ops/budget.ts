import type { Run } from "@dodok/shared";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { messages } from "../../db/schema.sqlite";
import type { ServerBus } from "../../realtime/bus";
import { getChannel } from "../channels/service";
import { createSystemMessage } from "../messages/service";
import type { RunPlan } from "../router/decide";
import type { EnqueueTrigger, Orchestrator } from "../runs/orchestrator";
import { countRunsToday, countRunsTodayInWorkspace } from "../runs/store";
import type { OpsService } from "./service";
import { getOpsSettings } from "./settings";

export type LimitHit = { scope: "channel" | "workspace"; limit: number };

/** 런을 만드는 모든 경로(라우터·컴포넌트 상호작용·다시 실행)가 지나는 일일 런 수 관문(스펙 3.2) */
export interface RunGate {
  /** 한도 안이면 null. 넘으면 LimitHit — 그 채널에 오늘 같은 scope 의 run_limit 시스템 메시지가 없으면 남기고 사건 run_limit 을 기록한다 */
  check(channelId: string): LimitHit | null;
  /** check 가 null 이면 orchestrator.enqueueRun, 아니면 null */
  enqueue(plan: RunPlan & { channelId: string }, trigger: EnqueueTrigger): Promise<Run | null>;
}

export function createRunGate(deps: {
  db: Db;
  bus: ServerBus;
  ops: Pick<OpsService, "record">;
  workspaceId: string;
  enqueue: Orchestrator["enqueueRun"];
  now?: () => Date;
}): RunGate {
  const { db, bus, ops, workspaceId } = deps;
  const now = deps.now ?? (() => new Date());

  // 워크스페이스 상한을 먼저 본다 — 둘 다 넘었으면 사람에게는 더 넓은 쪽이 원인이다
  function hitOf(channelId: string, at: Date): LimitHit | null {
    const workspaceLimit = getOpsSettings(db, workspaceId).dailyRunLimit;
    if (workspaceLimit !== null && countRunsTodayInWorkspace(db, at) >= workspaceLimit) {
      return { scope: "workspace", limit: workspaceLimit };
    }
    const channelLimit = getChannel(db, channelId)?.relayPolicy.dailyRunLimit;
    if (channelLimit !== undefined && countRunsToday(db, channelId, at) >= channelLimit) {
      return { scope: "channel", limit: channelLimit };
    }
    return null;
  }

  function announcedToday(channelId: string, scope: LimitHit["scope"], at: Date): boolean {
    const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate());
    const row = db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, channelId),
          gte(messages.createdAt, midnight),
          sql`json_extract(${messages.systemMeta}, '$.kind') = 'run_limit'`,
          sql`json_extract(${messages.systemMeta}, '$.limit.scope') = ${scope}`,
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  function check(channelId: string): LimitHit | null {
    const at = now();
    const hit = hitOf(channelId, at);
    if (!hit) return null;
    if (!announcedToday(channelId, hit.scope, at)) {
      const prefix = hit.scope === "channel" ? "이 채널의 " : "";
      createSystemMessage(db, bus, {
        channelId,
        kind: "run_limit",
        bodyMd: `${prefix}오늘 런 한도(${hit.limit})에 도달했습니다 — 내일 0시에 풀립니다`,
        systemMeta: { kind: "run_limit", limit: hit },
        createdAt: at,
      });
    }
    ops.record({
      kind: "run_limit",
      key: hit.scope === "workspace" ? "workspace" : `channel:${channelId}`,
      severity: "warn",
      detail: { limit: hit.limit },
    });
    return hit;
  }

  return {
    check,
    async enqueue(plan, trigger) {
      if (check(plan.channelId)) return null;
      return deps.enqueue(plan, trigger);
    },
  };
}
