import type { Run } from "@dodok/shared";
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { conversations, messages } from "../../db/schema.sqlite";
import type { ServerBus } from "../../realtime/bus";
import { getAgent, isAgentActive } from "../agents/service";
import { getChannel, isChannelArchived } from "../channels/service";
import { createSystemMessage } from "../messages/service";
import type { RunPlan } from "../router/decide";
import type { EnqueueTrigger, Orchestrator } from "../runs/orchestrator";
import { countRunsToday, countRunsTodayInWorkspace } from "../runs/store";
import type { OpsService } from "./service";
import { getOpsSettings } from "./settings";

export type LimitHit = { scope: "channel" | "workspace"; limit: number };

/**
 * 런을 만드는 모든 경로(라우터·컴포넌트 상호작용·다시 실행)가 지나는 관문 — 일일 런 수(스펙 3.2)와 활성 에이전트(계획 판정 PS2:
 * 보관·끈 에이전트는 런을 만들지 않는다), 보관한 채널(채널 보관 계획 판정 PC2 — 보관한 채널에는 런을 만들지 않는다)
 */
export interface RunGate {
  /**
   * 한도 안이면 null. 넘으면 LimitHit — 그 대화의 채널에 오늘 같은 scope 의 run_limit 시스템 메시지가 없으면 그 대화에 남기고 사건
   * run_limit 을 기록한다. 한도는 채널·워크스페이스 단위다. 스레드에서 막혔으면 알림은 그 스레드에 남는다(하루 한 번은 채널 단위 그대로)
   */
  check(conversationId: string, threadRootId?: string): LimitHit | null;
  /**
   * 대상이 활성이고 채널이 보관되지 않았고 check 가 null 이면 orchestrator.enqueueRun, 아니면 null. 두 검사는 런 행을 넣는
   * enqueueRun 과 await 없이 이어진다 — 보관 쓰기와 엇갈려도 「보관 뒤 새 런」이 생기지 않는다(쓰기 전에 들어온 런은 보관이 훑어 닫는다)
   */
  enqueue(
    plan: RunPlan & { channelId: string; conversationId: string },
    trigger: EnqueueTrigger,
  ): Promise<Run | null>;
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

  function check(conversationId: string, threadRootId?: string): LimitHit | null {
    const at = now();
    const channelId = db
      .select({ channelId: conversations.channelId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()?.channelId;
    // 대화가 없으면 막을 근거도 알릴 자리도 없다 — 런 행을 넣는 쪽이 대화 FK 로 거절한다
    if (channelId === undefined) return null;
    const hit = hitOf(channelId, at);
    if (!hit) return null;
    if (!announcedToday(channelId, hit.scope, at)) {
      const prefix = hit.scope === "channel" ? "이 채널의 " : "";
      createSystemMessage(db, bus, {
        conversationId,
        ...(threadRootId === undefined ? {} : { threadRootId }),
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
      const agent = getAgent(db, plan.agentId);
      if (agent && !isAgentActive(agent)) return null;
      if (isChannelArchived(db, plan.channelId)) return null;
      if (check(plan.conversationId, plan.threadRootId)) return null;
      return deps.enqueue(plan, trigger);
    },
  };
}
