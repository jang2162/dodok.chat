import type { Agent, Message, Run, SystemKind } from "@dodok/shared";
import { inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { agents } from "../../db/schema.sqlite";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { getAgent, rowToAgent } from "../agents/service";
import { type ChannelRecord, getChannel, listMembers } from "../channels/service";
import { createSystemMessage } from "../messages/service";
import type { Orchestrator } from "../runs/orchestrator";
import * as store from "../runs/store";
import { type Blocked, type BlockedReason, decideRuns } from "./decide";

export type RouterLogger = Pick<Logger, "warn" | "error">;

export type RouterDeps = {
  db: Db;
  bus: ServerBus;
  logger: RouterLogger;
  enqueue: Orchestrator["enqueueRun"];
  now?: () => Date;
};

export type Router = {
  /** 저장된 normal 메시지(사람·에이전트)로 런을 만들거나 차단을 시스템 메시지로 알린다. 시스템 메시지는 무시한다. */
  routeMessage(message: Message): Promise<void>;
};

/** relay_limit 카드의 이어가기 버튼 — components/service 가 이 id 를 가로챈다 */
export const CONTINUE_RELAY_ITEM = "continue_relay";

const CONTINUE_RELAY_COMPONENTS = {
  blocks: [
    {
      type: "actions" as const,
      items: [
        { type: "button" as const, id: CONTINUE_RELAY_ITEM, label: "이어가기", style: "primary" as const },
      ],
    },
  ],
};

/** 계약 스펙 5.2 규칙 3 — 루프 보호(max_turns·repeat)는 사람이 이어가기로 뚫을 수 있다 */
const SYSTEM_KIND: Record<BlockedReason, SystemKind> = {
  max_turns: "relay_limit",
  repeat: "relay_limit",
  pair_not_allowed: "relay_denied",
  daily_limit: "relay_denied",
  disabled: "relay_denied",
};

const CONTINUE_HINT = "계속하려면 사람이 멘션하거나 이어가기를 누르세요.";

/** 스펙 3.7 — decideRuns 입력 조립 → enqueue / 사유별 시스템 메시지 */
export function createRouter(deps: RouterDeps): Router {
  const { db, bus, logger } = deps;
  const now = deps.now ?? (() => new Date());

  function channelAgents(agentIds: string[]): Agent[] {
    if (agentIds.length === 0) return [];
    return db.select().from(agents).where(inArray(agents.id, agentIds)).all().map(rowToAgent);
  }

  function handleOf(byId: Map<string, Agent>, agentId: string): string {
    return byId.get(agentId)?.handle ?? getAgent(db, agentId)?.handle ?? "unknown";
  }

  function bodyFor(reason: BlockedReason, channel: ChannelRecord, from: string, targets: string[]): string {
    switch (reason) {
      case "max_turns":
        return `릴레이 한도(${channel.relayPolicy.maxRelayTurns}턴)에 도달했습니다. ${CONTINUE_HINT}`;
      case "repeat":
        return `같은 내용의 릴레이가 반복되어 멈췄습니다. ${CONTINUE_HINT}`;
      case "pair_not_allowed":
        return `@${from} 은(는) ${targets.join(", ")} 을(를) 부를 수 없습니다(허용 목록 밖)`;
      case "daily_limit":
        return "채널의 일일 런 상한에 도달했습니다";
      case "disabled":
        return `${targets.join(", ")} 은(는) 비활성 상태입니다`;
    }
  }

  function announceBlocked(
    channel: ChannelRecord,
    sourceRun: Run,
    blocked: Blocked[],
    byId: Map<string, Agent>,
  ) {
    const groups = new Map<BlockedReason, Blocked[]>();
    for (const b of blocked) groups.set(b.reason, [...(groups.get(b.reason) ?? []), b]);
    const from = handleOf(byId, sourceRun.agentId);
    for (const [reason, items] of groups) {
      const kind = SYSTEM_KIND[reason];
      const first = items[0] as Blocked;
      const targets = items.map((b) => `@${handleOf(byId, b.agentId)}`);
      createSystemMessage(db, bus, {
        channelId: channel.id,
        kind,
        bodyMd: bodyFor(reason, channel, from, targets),
        systemMeta: {
          relay: {
            fromAgentId: sourceRun.agentId,
            toAgentId: first.agentId,
            sourceRunId: sourceRun.id,
            rootMessageId: sourceRun.rootMessageId,
          },
        },
        ...(kind === "relay_limit" ? { components: CONTINUE_RELAY_COMPONENTS } : {}),
      });
    }
  }

  return {
    async routeMessage(message) {
      if (message.kind !== "normal") return;
      const channel = getChannel(db, message.channelId);
      if (!channel) {
        logger.warn({ messageId: message.id, channelId: message.channelId }, "route: channel not found");
        return;
      }

      let sourceRun: Run | undefined;
      if (message.authorType === "agent") {
        sourceRun = message.runId === undefined ? undefined : store.getRun(db, message.runId);
        if (!sourceRun) {
          // 런 없이 저장된 에이전트 메시지는 릴레이하지 않는다(계약 5.2 규칙 2)
          logger.warn(
            { messageId: message.id, runId: message.runId },
            "route: agent message without run — no relay",
          );
          return;
        }
      }

      const members = listMembers(db, channel.id);
      const agentList = channelAgents(members.filter((m) => m.memberType === "agent").map((m) => m.memberId));
      const at = now();
      const decision = decideRuns({
        message,
        channel,
        members,
        agents: agentList,
        ...(sourceRun ? { sourceRun } : {}),
        chainHashes: sourceRun ? store.chainHashes(db, sourceRun.rootMessageId) : new Set(),
        todayRunCount: store.countRunsToday(db, channel.id, at),
        now: at,
      });

      for (const plan of decision.runs) {
        try {
          await deps.enqueue({ ...plan, channelId: channel.id }, { message });
        } catch (err) {
          logger.error({ err, messageId: message.id, agentId: plan.agentId }, "route: enqueue failed");
        }
      }
      if (sourceRun && decision.blocked.length > 0) {
        announceBlocked(channel, sourceRun, decision.blocked, new Map(agentList.map((a) => [a.id, a])));
      }
    },
  };
}
