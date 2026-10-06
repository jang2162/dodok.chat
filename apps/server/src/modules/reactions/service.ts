import {
  type InboundReaction,
  type Message,
  REACTION_EMOJIS,
  type ReactionEmoji,
  type ReactionSet,
} from "@dodok/shared";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client";
import { agents, agentSessions, channels, messageReactions, messages, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { ServerBus } from "../../realtime/bus";
import { assertChannelWritable } from "../channels/service";
import { rowToMessage } from "../messages/service";
import { type HandleOf, readableGlyphs, readableWindow } from "../search/readable";

/** 한 런에 싣는 리액션 수 — 넘치면 최근 쪽을 남기고 나머지는 reactionsOmitted 로 센다(InboundContext.reactions 의 상한과 같다) */
export const REACTIONS_PER_RUN = 20;

/** InboundReaction.excerpt 의 길이 상한(UTF-16 길이 — 계약 스키마가 string.max 로 센다) */
const EXCERPT_MAX = 60;

/**
 * 리액션을 켜거나 끈다(리액션 스펙 5.1). 이미 그 상태면 성공이고 이벤트는 없다 — 두 번 눌리거나 다시 보내도 결과가 같다.
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
    .select({ message: messages, workspaceId: channels.workspaceId })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(eq(messages.id, messageId))
    .get();
  // 다른 워크스페이스의 메시지는 존재 자체를 알리지 않는다
  if (!row || row.workspaceId !== workspaceId) throw apiError("NOT_FOUND", "message not found");
  if (row.message.kind !== "normal") throw apiError("VALIDATION", "system messages cannot be reacted to");
  assertChannelWritable(db, row.message.channelId, workspaceId);

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
  channelId: string;
  agentId: string;
  /** 스레드 세션이면 그 루트 — 루트와 그 답글이 범위. 없으면 채널 최상위(루트 메시지 자신도 최상위라 채널 세션 범위에 든다) */
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
    eq(messages.channelId, q.channelId),
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

/** 메시지 본문의 읽는 글 앞 60자 — 멘션은 @핸들로 풀고 마크다운 표시는 걷는다(검색 스니펫과 같은 변환) */
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
