import { createHash } from "node:crypto";
import {
  type Agent,
  type Channel,
  type ChannelMember,
  MENTION_TOKEN_RE,
  type Message,
  type Run,
  type RunTriggerKind,
} from "@dodok/shared";

export type RoutingInput = {
  message: Message; // 방금 저장된 메시지 (user | agent | system)
  channel: Channel;
  members: ChannelMember[];
  agents: Agent[]; // 채널 소속 에이전트 (enabled 여부 포함)
  sourceRun?: Run; // message가 에이전트 메시지일 때 그 런
  chainHashes: Set<string>; // 같은 rootMessageId 체인의 relayHash 집합
  todayRunCount: number; // 채널 일일 런 수
  now: Date;
};

export type RunPlan = {
  agentId: string;
  triggerKind: RunTriggerKind;
  rootMessageId: string;
  relayDepth: number;
  relayHash?: string;
};
export type BlockedReason = "pair_not_allowed" | "max_turns" | "repeat" | "daily_limit" | "disabled";
export type Blocked = { agentId: string; reason: BlockedReason };

export function normalizeForHash(bodyMd: string): string {
  return bodyMd.replace(MENTION_TOKEN_RE, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);
}

export function computeRelayHash(fromAgentId: string, toAgentId: string, bodyMd: string): string {
  return createHash("sha256")
    .update(`${fromAgentId}\n${toAgentId}\n${normalizeForHash(bodyMd)}`)
    .digest("hex");
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function decideRuns(input: RoutingInput): { runs: RunPlan[]; blocked: Blocked[] } {
  const { message, channel, members, agents, sourceRun } = input;
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const agentMembers = members.filter((m) => m.memberType === "agent");
  const memberIds = new Set(agentMembers.map((m) => m.memberId));
  const isActive = (id: string) => memberIds.has(id) && agentById.get(id)?.enabled === true;

  if (message.authorType === "user") {
    const targets = uniq(message.mentions.agents).filter(isActive);
    if (targets.length > 0) {
      return {
        runs: targets.map((agentId) => ({
          agentId,
          triggerKind: "mention",
          rootMessageId: message.id,
          relayDepth: 0,
        })),
        blocked: [],
      };
    }
    if (message.mentions.agents.length > 0) return { runs: [], blocked: [] }; // 멘션이 전부 비활성: 폴백 없음
    const auto = agentMembers
      .filter((m) => m.autoRespond && isActive(m.memberId))
      .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt));
    const first = auto[0];
    if (!first) return { runs: [], blocked: [] };
    return {
      runs: [
        { agentId: first.memberId, triggerKind: "auto_respond", rootMessageId: message.id, relayDepth: 0 },
      ],
      blocked: [],
    };
  }

  if (message.authorType === "agent") {
    if (!sourceRun) return { runs: [], blocked: [] };
    const policy = channel.relayPolicy;
    const runs: RunPlan[] = [];
    const blocked: Blocked[] = [];
    for (const to of uniq(message.mentions.agents).filter((id) => id !== sourceRun.agentId)) {
      if (!isActive(to)) {
        blocked.push({ agentId: to, reason: "disabled" });
        continue;
      }
      const allowed =
        policy.allowPairs === "all" ||
        policy.allowPairs.some((p) => p.from === sourceRun.agentId && p.to === to);
      if (!allowed) {
        blocked.push({ agentId: to, reason: "pair_not_allowed" });
        continue;
      }
      const depth = sourceRun.relayDepth + 1;
      if (depth > policy.maxRelayTurns) {
        blocked.push({ agentId: to, reason: "max_turns" });
        continue;
      }
      const relayHash = computeRelayHash(sourceRun.agentId, to, message.bodyMd);
      if (input.chainHashes.has(relayHash)) {
        blocked.push({ agentId: to, reason: "repeat" });
        continue;
      }
      if (policy.dailyRunLimit !== undefined && input.todayRunCount + runs.length >= policy.dailyRunLimit) {
        blocked.push({ agentId: to, reason: "daily_limit" });
        continue;
      }
      runs.push({
        agentId: to,
        triggerKind: "relay",
        rootMessageId: sourceRun.rootMessageId,
        relayDepth: depth,
        relayHash,
      });
    }
    return { runs, blocked };
  }

  return { runs: [], blocked: [] }; // system 메시지는 라우팅하지 않는다
}
