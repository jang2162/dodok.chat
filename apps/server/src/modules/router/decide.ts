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
  threadRoot?: Message; // message가 스레드 답글일 때 그 루트
  chainHashes: Set<string>; // 같은 rootMessageId 체인의 relayHash 집합
  now: Date;
};

export type RunPlan = {
  agentId: string;
  triggerKind: RunTriggerKind;
  rootMessageId: string;
  relayDepth: number;
  relayHash?: string;
  /** 다시 실행한 런이면 원래 런 */
  parentRunId?: string;
  /** 스레드 하위 세션의 런이면 그 루트 */
  threadRootId?: string;
};
export type BlockedReason = "pair_not_allowed" | "max_turns" | "repeat" | "disabled";
export type Blocked = { agentId: string; reason: BlockedReason };

export function normalizeForHash(bodyMd: string): string {
  return bodyMd.replace(MENTION_TOKEN_RE, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);
}

export function computeRelayHash(fromAgentId: string, toAgentId: string, bodyMd: string): string {
  return createHash("sha256")
    .update(`${fromAgentId}\n${toAgentId}\n${normalizeForHash(bodyMd)}`)
    .digest("hex");
}

export function isPairAllowed(policy: Channel["relayPolicy"], from: string, to: string): boolean {
  return policy.allowPairs === "all" || policy.allowPairs.some((p) => p.from === from && p.to === to);
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** 스레드 답글에 멘션이 없을 때 — 루트가 에이전트 메시지면 그 에이전트(결정 4). 비활성·비소속이면 없다 */
function threadResponder(root: Message | undefined, isActive: (id: string) => boolean): string | undefined {
  if (root?.authorType !== "agent" || root.authorId === undefined) return undefined;
  return isActive(root.authorId) ? root.authorId : undefined;
}

function autoResponder(agentMembers: ChannelMember[], isActive: (id: string) => boolean): string | undefined {
  return agentMembers
    .filter((m) => m.autoRespond && isActive(m.memberId))
    .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt))[0]?.memberId;
}

export function decideRuns(input: RoutingInput): { runs: RunPlan[]; blocked: Blocked[] } {
  const { message, channel, members, agents, sourceRun } = input;
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const agentMembers = members.filter((m) => m.memberType === "agent");
  const memberIds = new Set(agentMembers.map((m) => m.memberId));
  const isActive = (id: string) => memberIds.has(id) && agentById.get(id)?.enabled === true;

  const thread = message.threadRootId === undefined ? {} : { threadRootId: message.threadRootId };

  if (message.authorType === "user") {
    const targets = uniq(message.mentions.agents).filter(isActive);
    if (targets.length > 0) {
      return {
        runs: targets.map((agentId) => ({
          agentId,
          triggerKind: "mention",
          rootMessageId: message.id,
          relayDepth: 0,
          ...thread,
        })),
        blocked: [],
      };
    }
    if (message.mentions.agents.length > 0) return { runs: [], blocked: [] }; // 멘션이 전부 비활성: 폴백 없음
    const responder = threadResponder(input.threadRoot, isActive) ?? autoResponder(agentMembers, isActive);
    if (responder === undefined) return { runs: [], blocked: [] };
    return {
      runs: [
        {
          agentId: responder,
          triggerKind: "auto_respond",
          rootMessageId: message.id,
          relayDepth: 0,
          ...thread,
        },
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
      if (!isPairAllowed(policy, sourceRun.agentId, to)) {
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
      runs.push({
        agentId: to,
        triggerKind: "relay",
        rootMessageId: sourceRun.rootMessageId,
        relayDepth: depth,
        relayHash,
        ...thread,
      });
    }
    return { runs, blocked };
  }

  return { runs: [], blocked: [] }; // system 메시지는 라우팅하지 않는다
}
