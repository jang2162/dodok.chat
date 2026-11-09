import {
  INBOUND_REACTIONS_MAX,
  type InboundReaction,
  type Message,
  REACTION_EMOJIS,
  REACTION_EXCERPT_MAX,
  type ReactionEmoji,
  type ReactionSet,
} from "@dodok/shared";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client";
import { agents, agentSessions, channels, messageReactions, messages, users } from "../../db/schema.sqlite";
import { canReadChannel } from "../../auth/channel-access";
import { apiError } from "../../http/errors";
import type { ServerBus } from "../../realtime/bus";
import { assertConversationWritable } from "../conversations/store";
import { assertDmWritable } from "../dms/service";
import { rowToMessage } from "../messages/service";
import { type HandleOf, readableGlyphs, readableWindow } from "../search/readable";

/** 한 런에 싣는 리액션 수 — 넘치면 최근 쪽을 남기고 나머지는 reactionsOmitted 로 센다(값은 shared 계약의 상한) */
export const REACTIONS_PER_RUN = INBOUND_REACTIONS_MAX;

/**
 * InboundReaction.excerpt 의 길이 상한 — UTF-16 단위로 센다. 계약 스키마의 string.max 는 zod 판본마다 세는 법이 달라(핀한 4.6.5 는
 * 코드 포인트, 의존성 트리의 4.4.3 은 UTF-16 단위) UTF-16 으로 60 이내면 어느 쪽으로도 넘지 않는다. 대가는 이모지처럼 서로게이트
 * 쌍이 많은 글의 발췌가 60 코드 포인트보다 짧은 것. 세는 법은 `z.string().max(60).safeParse("😀".repeat(31))` 로 잰다 — 코드
 * 포인트로 세면 통과, UTF-16 으로 세면 거절
 */
const EXCERPT_MAX = REACTION_EXCERPT_MAX;

/**
 * 리액션을 켜거나 끈다(리액션 스펙 docs/superpowers/specs/2026-10-05-reactions-design.md 「`modules/reactions/`」 절). 이미 그
 * 상태면 성공이고 이벤트는 없다 — 두 번 눌리거나 다시 보내도 결과가 같다.
 * message.updated 는 하이드레이션 전의 메시지로 낸다 — 리액션은 wire 팬아웃(realtime/events.ts)이 붙인다
 */
export function setReaction(
  db: Db,
  bus: ServerBus,
  workspaceId: string,
  userId: string,
  input: ReactionSet,
  now: Date,
): void {
  const { messageId, emoji, on } = input;
  const row = db
    .select({
      message: messages,
      id: channels.id,
      workspaceId: channels.workspaceId,
      kind: channels.kind,
      dmOwnerId: channels.dmOwnerId,
      dmAgentId: channels.dmAgentId,
    })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(eq(messages.id, messageId))
    .get();
  // 다른 워크스페이스·남의 DM 의 메시지는 존재 자체를 알리지 않는다(auth/channel-access.ts)
  if (!row || row.workspaceId !== workspaceId || !canReadChannel(db, { userId }, row))
    throw apiError("NOT_FOUND", "message not found");
  if (row.message.kind !== "normal") throw apiError("VALIDATION", "system messages cannot be reacted to");
  assertConversationWritable(db, row.message.conversationId, workspaceId);
  assertDmWritable(db, row);

  const changed = on
    ? db
        .insert(messageReactions)
        // 이미 달려 있으면 처음 단 시각을 지킨다 — 다시 눌러 커서 비교에서 새 리액션으로 되살아나지 않게
        .values({ messageId, userId, emoji, createdAt: now })
        .onConflictDoNothing()
        .returning({ id: messageReactions.messageId })
        .all().length
    : db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, messageId),
            eq(messageReactions.userId, userId),
            eq(messageReactions.emoji, emoji),
          ),
        )
        .returning({ id: messageReactions.messageId })
        .all().length;
  if (changed === 0) return;
  bus.emit("message.updated", { message: rowToMessage(row.message) });
}

/**
 * 메시지에 리액션 집계를 붙인다 — 질의 한 번. 이모지는 REACTION_EMOJIS 순서, userIds 는 단 순서.
 * 이미 실려 있던 값은 덮어쓴다(정본은 표다)
 */
export function withReactions(db: DbOrTx, msgs: Message[]): Message[] {
  if (msgs.length === 0) return msgs;
  const rows = db
    .select({
      messageId: messageReactions.messageId,
      userId: messageReactions.userId,
      emoji: messageReactions.emoji,
    })
    .from(messageReactions)
    .where(
      inArray(
        messageReactions.messageId,
        msgs.map((m) => m.id),
      ),
    )
    // rowid 는 같은 시각에 단 것의 순서를 넣은 순서로 고정한다
    .orderBy(asc(messageReactions.createdAt), sql`message_reactions.rowid`)
    .all();
  const byMessage = new Map<string, Map<ReactionEmoji, string[]>>();
  for (const r of rows) {
    if (!isReactionEmoji(r.emoji)) continue;
    const perEmoji = byMessage.get(r.messageId) ?? new Map<ReactionEmoji, string[]>();
    const users = perEmoji.get(r.emoji) ?? [];
    users.push(r.userId);
    perEmoji.set(r.emoji, users);
    byMessage.set(r.messageId, perEmoji);
  }
  return msgs.map((m) => {
    const perEmoji = byMessage.get(m.id);
    if (!perEmoji) return m.reactions.length === 0 ? m : { ...m, reactions: [] };
    return {
      ...m,
      reactions: REACTION_EMOJIS.flatMap((emoji) => {
        const userIds = perEmoji.get(emoji);
        return userIds ? [{ emoji, count: userIds.length, userIds }] : [];
      }),
    };
  });
}

function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(value);
}

export type PendingReactionsQuery = {
  /** 세션의 대화 — 같은 채널의 다른 세션에 달린 리액션은 그 세션 몫이다(세션 행마다 커서가 따로라 좁히지 않으면 두 세션에 다 실린다) */
  conversationId: string;
  agentId: string;
  /** 스레드 세션이면 그 루트 — 루트와 그 답글이 범위. 없으면 대화 최상위(루트 메시지 자신도 최상위라 대화 세션 범위에 든다) */
  threadRootId: string | null;
  /** 세션의 reactions_seen_at. null 이면 실을 것이 없다 */
  since: Date | null;
};

export type PendingReactions = { reactions: InboundReaction[]; omitted?: number; latestAt?: Date };

/**
 * 그 에이전트가 쓴 메시지 가운데 이 세션 범위의 것에 since 뒤로 달린 리액션 — 최근 20개를 at 오름차순으로,
 * 20개 밖은 omitted 로 센다. latestAt 은 고른 것 가운데 가장 늦은 시각(send 가 받아들여지면 커서를 이 시각으로 올린다)
 */
export function pendingReactionsFor(db: DbOrTx, q: PendingReactionsQuery): PendingReactions {
  if (q.since === null) return { reactions: [] };
  const scope = q.threadRootId
    ? or(eq(messages.id, q.threadRootId), eq(messages.threadRootId, q.threadRootId))
    : isNull(messages.threadRootId);
  const where = and(
    eq(messages.conversationId, q.conversationId),
    eq(messages.authorType, "agent"),
    eq(messages.authorId, q.agentId),
    eq(messages.kind, "normal"),
    gt(messageReactions.createdAt, q.since),
    scope,
  );
  const rows = db
    .select({
      messageId: messageReactions.messageId,
      emoji: messageReactions.emoji,
      createdAt: messageReactions.createdAt,
      bodyMd: messages.bodyMd,
      mentions: messages.mentions,
      byHandle: users.handle,
    })
    .from(messageReactions)
    .innerJoin(messages, eq(messages.id, messageReactions.messageId))
    .innerJoin(users, eq(users.id, messageReactions.userId))
    .where(where)
    .orderBy(desc(messageReactions.createdAt), sql`message_reactions.rowid desc`)
    .limit(REACTIONS_PER_RUN)
    .all();
  if (rows.length === 0) return { reactions: [] };
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(messageReactions)
      .innerJoin(messages, eq(messages.id, messageReactions.messageId))
      .where(where)
      .get()?.n ?? rows.length;

  const handleOf = mentionHandles(
    db,
    rows.flatMap((r) => [
      ...r.mentions.agents.map((id) => `a:${id}`),
      ...r.mentions.users.map((id) => `u:${id}`),
    ]),
  );
  const reactions = rows
    .map((r): InboundReaction => ({
      messageId: r.messageId,
      excerpt: excerptOf(r.bodyMd, handleOf),
      emoji: r.emoji as ReactionEmoji,
      by: r.byHandle,
      at: r.createdAt.toISOString(),
    }))
    .reverse();
  const omitted = total - REACTIONS_PER_RUN;
  return {
    reactions,
    ...(omitted > 0 ? { omitted } : {}),
    latestAt: rows[0]?.createdAt,
  };
}

/**
 * 메시지 본문의 읽는 글 앞쪽 EXCERPT_MAX 안 — 글자(코드 포인트) 단위로 채워 서로게이트 쌍을 가르지 않는다. 멘션은 @핸들로 풀고
 * 마크다운 표시는 걷는다(검색 스니펫과 같은 변환)
 */
function excerptOf(bodyMd: string, handleOf: HandleOf): string {
  const glyphs = readableGlyphs(bodyMd, handleOf, readableWindow(bodyMd, 0, 0));
  let out = "";
  for (const g of glyphs) {
    if (out.length + g.ch.length > EXCERPT_MAX) break;
    out += g.ch;
  }
  return out;
}

/** "a:<id>"·"u:<id>" 키 → 핸들. 질의 한 번씩(에이전트·사람) — 멘션이 없으면 질의하지 않는다 */
function mentionHandles(db: DbOrTx, keys: string[]): HandleOf {
  const agentIds = [...new Set(keys.filter((k) => k.startsWith("a:")).map((k) => k.slice(2)))];
  const userIds = [...new Set(keys.filter((k) => k.startsWith("u:")).map((k) => k.slice(2)))];
  const byKey = new Map<string, string>();
  if (agentIds.length > 0)
    for (const a of db
      .select({ id: agents.id, handle: agents.handle })
      .from(agents)
      .where(inArray(agents.id, agentIds))
      .all())
      byKey.set(`a:${a.id}`, a.handle);
  if (userIds.length > 0)
    for (const u of db
      .select({ id: users.id, handle: users.handle })
      .from(users)
      .where(inArray(users.id, userIds))
      .all())
      byKey.set(`u:${u.id}`, u.handle);
  return (kind, id) => byKey.get(`${kind}:${id}`);
}

/** 세션의 리액션 커서를 올린다 — 뒤로 가지 않는다. null 이던 행은 to 로 채운다 */
export function advanceReactionCursor(db: DbOrTx, sessionRowId: string, to: Date): void {
  db.update(agentSessions)
    .set({ reactionsSeenAt: to })
    .where(
      and(
        eq(agentSessions.id, sessionRowId),
        or(isNull(agentSessions.reactionsSeenAt), sql`${agentSessions.reactionsSeenAt} < ${to.getTime()}`),
      ),
    )
    .run();
}
