import { createHash } from "node:crypto";
import {
  type Agent,
  type Channel,
  type ChannelMember,
  checkCommand,
  COMMANDS_UNSUPPORTED_MESSAGE,
  type DeliverCommand,
  MENTION_TOKEN_RE,
  type Message,
  type Run,
  parseAgentCommand,
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
  /**
   * 그 에이전트를 맡은 쪽이 명령(능력 commands)을 받나(에이전트 명령 C7). 없으면 받는다고 본다 — 맡은 쪽이 지금 붙어 있지 않으면
   * 막지 않는다(보낼 때 ADAPTER_UNAVAILABLE 로 닫힌다)
   */
  supportsCommands?: (agent: Agent) => boolean;
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
  /** 명령 런(triggerKind command)만 — 런 시작에 InboundDeliver.command 로 싣는다 */
  command?: DeliverCommand;
};
/** 런 없이 그 자리에 남길 시스템 줄 — 막은 명령(C4·C10)·옛 판(C7) */
export type RoutingNotice = { agentId: string; text: string };
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

/** 명령을 받는 프로그램 — 러너 에이전트는 Claude Code 목록, 그 밖(OpenClaw)은 허용 목록 */
export function commandProgramOf(agent: Pick<Agent, "provider">): "claude" | "openclaw" {
  return agent.provider === "runner" ? "claude" : "openclaw";
}

/** 1:1 에이전트 DM 이면 그 에이전트 — 맨 앞 `/이름` 이 그 에이전트의 명령이다 */
export function directAgentOf(channel: Pick<Channel, "kind" | "dmAgentId">): string | undefined {
  return channel.kind === "dm" ? (channel.dmAgentId ?? undefined) : undefined;
}

/**
 * 그 사람 글이 명령이면 명령(C2) — 첨부가 있으면 명령이 아니다. 라우팅·「다시 실행」이 같이 쓴다(다시 실행은 트리거 글을 다시 푼다)
 */
export function commandOfMessage(
  channel: Pick<Channel, "kind" | "dmAgentId">,
  message: Pick<Message, "bodyMd" | "attachments">,
): { agentId: string; command: DeliverCommand } | null {
  if (message.attachments.length > 0) return null;
  const directAgentId = directAgentOf(channel);
  const parsed = parseAgentCommand(message.bodyMd, directAgentId === undefined ? {} : { directAgentId });
  return parsed === null
    ? null
    : { agentId: parsed.agentId, command: { name: parsed.name, args: parsed.args } };
}

export function decideRuns(input: RoutingInput): {
  runs: RunPlan[];
  blocked: Blocked[];
  notice?: RoutingNotice;
} {
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
    // 에이전트 명령(C2) — 첨부가 있으면 명령이 아니다. 부를 수 없는 에이전트면 평범한 글처럼 흘려 보낸다
    const parsed = commandOfMessage(channel, message);
    const commandAgent = parsed === null ? undefined : agentById.get(parsed.agentId);
    if (parsed !== null && commandAgent !== undefined && isActive(parsed.agentId)) {
      const { command } = parsed;
      const verdict = checkCommand(commandProgramOf(commandAgent), command.name, command.args);
      if (!verdict.ok)
        return { runs: [], blocked: [], notice: { agentId: parsed.agentId, text: verdict.message } };
      if (input.supportsCommands?.(commandAgent) === false) {
        return {
          runs: [],
          blocked: [],
          notice: { agentId: parsed.agentId, text: COMMANDS_UNSUPPORTED_MESSAGE },
        };
      }
      return {
        runs: [
          {
            agentId: parsed.agentId,
            triggerKind: "command",
            rootMessageId: message.id,
            relayDepth: 0,
            command,
            ...thread,
          },
        ],
        blocked: [],
      };
    }
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
    // 명령 런의 답은 다른 에이전트를 부르지 않는다(에이전트 명령 스펙 5.1) — 답 글에 멘션이 있어도 릴레이하지 않는다
    if (sourceRun.triggerKind === "command") return { runs: [], blocked: [] };
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
