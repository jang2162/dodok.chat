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
import { isAgentActive } from "../agents/service";

export type RoutingInput = {
  message: Message; // 방금 저장된 메시지 (user | agent | automation | system)
  channel: Channel;
  members: ChannelMember[];
  agents: Agent[]; // 이 세션에서 부를 수 있는 에이전트 — 채널 소속 + 그 대화의 초대 (enabled·archivedAt 포함)
  /**
   * 그 대화(세션)에 초대한 에이전트(세션 에이전트 초대 스펙 5.2) — 멘션·스레드 루트 응답자·릴레이 대상은 되고(I10), 채널 자동 응답
   * 자리에는 오르지 않는다(I5). 이 에이전트가 낀 릴레이 쌍은 허용 목록을 건너뛴다(I11)
   */
  invitedAgentIds: readonly string[];
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

/**
 * invited 는 그 세션에 초대한 에이전트 — 초대한 에이전트가 from 이거나 to 인 쌍은 목록과 무관하게 허용한다(사람이 그 세션에 일부러
 * 부른 에이전트다, 세션 에이전트 초대 스펙 I11). 예외는 그 쌍뿐이다 — 초대와 무관한 쌍은 목록 그대로 본다
 */
export function isPairAllowed(
  policy: Channel["relayPolicy"],
  from: string,
  to: string,
  invited: ReadonlySet<string> = new Set(),
): boolean {
  if (invited.has(from) || invited.has(to)) return true;
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
  const invited = new Set(input.invitedAgentIds);
  const memberIds = new Set([...agentMembers.map((m) => m.memberId), ...invited]);
  const isActive = (id: string) => {
    const agent = agentById.get(id);
    return memberIds.has(id) && agent !== undefined && isAgentActive(agent);
  };

  const thread = message.threadRootId === undefined ? {} : { threadRootId: message.threadRootId };
  const mentionRuns = (): RunPlan[] =>
    uniq(message.mentions.agents)
      .filter(isActive)
      .map((agentId) => ({
        agentId,
        triggerKind: "mention",
        rootMessageId: message.id,
        relayDepth: 0,
        ...thread,
      }));

  // 자동화 글은 멘션으로만 런을 만든다 — 멘션 없는 글이 자동 응답·스레드 응답자로 몰래 런을 만들면 비용이 예상과 달라진다(자동화 스펙 결정 6)
  if (message.authorType === "automation") return { runs: mentionRuns(), blocked: [] };

  if (message.authorType === "user") {
    const runs = mentionRuns();
    if (runs.length > 0) return { runs, blocked: [] };
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
      if (!isPairAllowed(policy, sourceRun.agentId, to, invited)) {
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
