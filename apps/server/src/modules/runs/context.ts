import {
  InboundDeliver,
  type Message,
  type Participant,
  type RelayPolicy,
  type Run,
  renderForAgent,
} from "@dodok/shared";
import { and, desc, eq, inArray, lt, lte } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "../../db/client";
import { agents, channelMembers, componentInteractions, messages, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { channelParticipants, getChannel } from "../channels/service";
import type { AgentSessionRow } from "../sessions/service";

/** InboundContext.recentMessages 상한(계약 스펙 8.2) */
export const RECENT_MESSAGES_MAX = 20;

export type InboundTrigger = {
  message?: Message;
  /** interaction·continue 런: formatInteractionText 결과 */
  interactionText?: string;
  /** 사용자가 누른 컴포넌트가 달린 메시지 */
  interactionMessageId?: string;
};

export type BuildInboundInput = {
  run: Run;
  trigger: InboundTrigger;
  session: AgentSessionRow;
  needsPromptContext: boolean;
  now?: Date;
};

type InboundAuthor = InboundDeliver["message"]["author"];
type AuthorRef = { authorType: string; authorId?: string | null | undefined };

/**
 * 스펙 7장 — 서버가 채우는 인바운드. 메시지 트리거면 그 메시지 이전, 상호작용 트리거(interaction·continue)면 컴포넌트가
 * 달린 메시지까지의 normal 메시지를 recentMessages 로 싣는다. 계약을 어기면 InboundDeliver.parse 가 던진다.
 */
export function buildInboundDeliver(db: DbOrTx, input: BuildInboundInput): InboundDeliver {
  const { run, trigger, session } = input;
  const channel = getChannel(db, run.channelId);
  if (!channel) throw apiError("NOT_FOUND", "channel not found");
  const agent = db
    .select({ providerAgentId: agents.providerAgentId })
    .from(agents)
    .where(eq(agents.id, run.agentId))
    .get();
  if (!agent) throw apiError("NOT_FOUND", "agent not found");
  const participants = channelParticipants(db, run.channelId);

  let message: InboundDeliver["message"];
  let recentUpTo: { seq: number; inclusive: boolean };
  if (trigger.message) {
    const m = trigger.message;
    message = {
      id: m.id,
      author: resolveAuthors(db, [m])(m),
      text: renderForAgent(m.bodyMd, participants),
      attachments: [],
      ts: m.createdAt,
    };
    recentUpTo = { seq: m.seq, inclusive: false };
  } else if (trigger.interactionText !== undefined && trigger.interactionMessageId !== undefined) {
    const target = db
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.id, trigger.interactionMessageId), eq(messages.channelId, run.channelId)))
      .get();
    if (!target) throw apiError("NOT_FOUND", "interaction message not found");
    message = {
      id: trigger.interactionMessageId,
      author: interactionAuthor(db, run),
      text: trigger.interactionText,
      attachments: [],
      ts: (input.now ?? new Date()).toISOString(),
    };
    recentUpTo = { seq: target.seq, inclusive: true };
  } else {
    throw apiError("INTERNAL", "inbound trigger needs message or interactionText + interactionMessageId");
  }

  const rows = db
    .select({
      authorType: messages.authorType,
      authorId: messages.authorId,
      bodyMd: messages.bodyMd,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, run.channelId),
        eq(messages.kind, "normal"),
        recentUpTo.inclusive ? lte(messages.seq, recentUpTo.seq) : lt(messages.seq, recentUpTo.seq),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(RECENT_MESSAGES_MAX)
    .all()
    .reverse();
  const authorOf = resolveAuthors(db, rows);

  const override = db
    .select({ promptOverride: channelMembers.promptOverride })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, run.channelId),
        eq(channelMembers.memberType, "agent"),
        eq(channelMembers.memberId, run.agentId),
      ),
    )
    .get()?.promptOverride;

  return InboundDeliver.parse({
    deliveryId: uuidv7(),
    kind: run.triggerKind === "continue" ? "continue" : trigger.message ? "message" : "interaction",
    channelId: run.channelId,
    agentId: agent.providerAgentId,
    sessionKey: session.sessionKey,
    runId: run.id,
    message,
    context: {
      recentMessages: rows.map((r) => ({
        author: authorOf(r),
        text: renderForAgent(r.bodyMd, participants),
        ts: r.createdAt.toISOString(),
      })),
      participants: participants.map((p) => ({
        type: p.type,
        handle: p.handle,
        displayName: p.displayName,
        isSelf: p.type === "agent" && p.id === run.agentId,
      })),
      relayRules: relayRulesFor(channel.relayPolicy, run.agentId, participants),
      ...(input.needsPromptContext && channel.prompt ? { channelPrompt: channel.prompt } : {}),
      ...(override ? { promptOverride: override } : {}),
    },
    options: {},
  });
}

/** 사람이 읽는 한 문단. allowPairs 제한이면 이 에이전트가 부를 수 있는 채널 에이전트(자기 자신 제외)만 나열한다. */
function relayRulesFor(policy: RelayPolicy, agentId: string, participants: Participant[]): string {
  const base = `다른 에이전트를 @멘션하면 그 에이전트가 이어받습니다. 최대 ${policy.maxRelayTurns}턴.`;
  if (policy.allowPairs === "all") return base;
  const handleOf = new Map(participants.filter((p) => p.type === "agent").map((p) => [p.id, p.handle]));
  const handles = new Set<string>();
  for (const pair of policy.allowPairs) {
    const handle = pair.from === agentId && pair.to !== agentId ? handleOf.get(pair.to) : undefined;
    if (handle !== undefined) handles.add(`@${handle}`);
  }
  if (handles.size === 0) return `${base} 당신은 다른 에이전트를 부를 수 없습니다.`;
  return `${base} 당신이 부를 수 있는 에이전트: ${[...handles].join(", ")}.`;
}

/** 작성자 행을 한 번에 읽는다. 채널을 떠난 작성자도 풀리도록 멤버가 아니라 users·agents 에서 찾는다. */
function resolveAuthors(db: DbOrTx, refs: AuthorRef[]): (ref: AuthorRef) => InboundAuthor {
  const idsOf = (type: string) => [
    ...new Set(refs.flatMap((r) => (r.authorType === type && r.authorId ? [r.authorId] : []))),
  ];
  const userIds = idsOf("user");
  const agentIds = idsOf("agent");
  const byKey = new Map<string, InboundAuthor>();
  if (userIds.length > 0) {
    for (const u of db
      .select({ id: users.id, handle: users.handle, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, userIds))
      .all()) {
      byKey.set(`user:${u.id}`, { type: "user", handle: u.handle, displayName: u.displayName });
    }
  }
  if (agentIds.length > 0) {
    for (const a of db
      .select({ id: agents.id, handle: agents.handle, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, agentIds))
      .all()) {
      byKey.set(`agent:${a.id}`, { type: "agent", handle: a.handle, displayName: a.name });
    }
  }
  return (ref) => {
    if (ref.authorType !== "user" && ref.authorType !== "agent") {
      return { type: "system", handle: "system", displayName: "system" };
    }
    return (
      byKey.get(`${ref.authorType}:${ref.authorId}`) ?? {
        type: ref.authorType,
        handle: "unknown",
        displayName: "unknown",
      }
    );
  };
}

/** 누른 사람 = run.triggerInteractionId 의 component_interactions.userId */
function interactionAuthor(db: DbOrTx, run: Run): InboundAuthor {
  if (run.triggerInteractionId === undefined) {
    throw apiError("INTERNAL", "interaction run has no triggerInteractionId");
  }
  const user = db
    .select({ handle: users.handle, displayName: users.displayName })
    .from(componentInteractions)
    .innerJoin(users, eq(users.id, componentInteractions.userId))
    .where(eq(componentInteractions.id, run.triggerInteractionId))
    .get();
  if (!user) throw apiError("NOT_FOUND", "interaction not found");
  return { type: "user", ...user };
}
