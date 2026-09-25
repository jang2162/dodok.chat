import {
  type Attachment,
  InboundDeliver,
  type Message,
  type Participant,
  type RelayPolicy,
  type Run,
  renderForAgent,
} from "@dodok/shared";
import { and, desc, eq, inArray, isNull, lt, lte } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "../../db/client";
import { agents, channelMembers, componentInteractions, messages, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { channelParticipants, getChannel } from "../channels/service";
import type { AgentSessionRow } from "../sessions/service";

/** InboundContext.recentMessages 상한(계약 스펙 8.2) — 스레드 최근 메시지도 같은 상한 */
export const RECENT_MESSAGES_MAX = 20;

/** 스레드 문맥에 싣는 루트 본문 상한(스펙 2.3) */
export const THREAD_ROOT_TEXT_MAX = 4000;

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
 * 달린 메시지까지의 normal 메시지를 싣는다 — 채널 런은 채널 최상위만 recentMessages 로, 스레드 런은 그 스레드 답글만
 * context.thread 로(루트 따로, recentMessages 는 빈 배열 — 스펙 2.3). 계약을 어기면 InboundDeliver.parse 가 던진다.
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
      // 텍스트는 그대로 — 트리거 첨부의 알림 줄은 플러그인이 붙인다(스펙 5.1-4)
      text: renderForAgent(m.bodyMd, participants),
      attachments: m.attachments,
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
      attachments: messages.attachments,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, run.channelId),
        eq(messages.kind, "normal"),
        run.threadRootId === undefined
          ? isNull(messages.threadRootId)
          : eq(messages.threadRootId, run.threadRootId),
        recentUpTo.inclusive ? lte(messages.seq, recentUpTo.seq) : lt(messages.seq, recentUpTo.seq),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(RECENT_MESSAGES_MAX)
    .all()
    .reverse();
  const root = run.threadRootId === undefined ? undefined : threadRootRow(db, run);
  const authorOf = resolveAuthors(db, root ? [...rows, root] : rows);
  const toContext = (r: (typeof rows)[number]) => ({
    author: authorOf(r),
    text: withPlaceholder(renderForAgent(r.bodyMd, participants), r.attachments),
    ts: r.createdAt.toISOString(),
  });
  const rootLine = root ? toContext(root) : undefined;

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
    ...(run.threadRootId === undefined ? {} : { threadId: run.threadRootId }),
    runId: run.id,
    message,
    context: {
      recentMessages: rootLine ? [] : rows.map(toContext),
      ...(rootLine
        ? {
            thread: {
              root: { ...rootLine, text: clip(rootLine.text, THREAD_ROOT_TEXT_MAX) },
              recentMessages: rows.map(toContext),
            },
          }
        : {}),
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

function threadRootRow(db: DbOrTx, run: Run) {
  const root = db
    .select({
      authorType: messages.authorType,
      authorId: messages.authorId,
      bodyMd: messages.bodyMd,
      attachments: messages.attachments,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.id, run.threadRootId ?? ""),
        eq(messages.channelId, run.channelId),
        isNull(messages.threadRootId),
      ),
    )
    .get();
  if (!root) throw apiError("NOT_FOUND", "thread root not found");
  return root;
}

/** max UTF-16 단위에서 자른다 — 서러게이트 쌍 가운데서 끊기면 앞 반쪽도 버린다 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** 문맥 줄의 첨부 자리표시(스펙 4.5) — 경로·URL 은 쓰지 않는다(Gateway 가 프롬프트 속 이미지 경로를 자동 첨부한다) */
export function attachmentPlaceholder(atts: readonly Attachment[]): string {
  const images = atts.filter((a) => a.kind === "image").length;
  const parts = [
    ...(images > 0 ? [`[이미지 ${images}장]`] : []),
    ...atts.filter((a) => a.kind === "file").map((a) => `[파일: ${a.name}]`),
  ];
  return parts.join(" ");
}

function withPlaceholder(text: string, atts: readonly Attachment[]): string {
  const placeholder = attachmentPlaceholder(atts);
  if (!placeholder) return text;
  return text ? `${text}\n${placeholder}` : placeholder;
}

/** 사람이 읽는 한 문단. allowPairs 제한이면 이 에이전트가 부를 수 있는 채널 에이전트(자기 자신 제외)만 나열한다. */
function relayRulesFor(policy: RelayPolicy, agentId: string, participants: Participant[]): string {
  // 라우터는 멘션 = 호출로 본다(서술 속 @핸들도 릴레이가 된다 — live-smoke 5.4-5). 그래서 부를 때만 @ 를 쓰게 한다
  const base = `다른 에이전트에게 일을 넘길 때만 @핸들을 쓰세요 — @멘션하면 그 에이전트가 이어받습니다(최대 ${policy.maxRelayTurns}턴). 언급만 할 때는 @ 없이 이름만 쓰세요.`;
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
