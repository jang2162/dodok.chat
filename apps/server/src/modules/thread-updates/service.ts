import {
  INBOUND_THREAD_UPDATES_MAX,
  type InboundThreadUpdate,
  renderForAgent,
  THREAD_UPDATE_REPLIES_MAX,
  THREAD_UPDATE_REPLY_TEXT_MAX,
} from "@dodok/shared";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { agentSessions, messages } from "../../db/schema.sqlite";
import { sessionParticipants } from "../conversations/invited-agents";
import { excerptOf, mentionHandles } from "../reactions/service";
import { clip, resolveAuthors, withPlaceholder } from "../runs/context";

export type PendingThreadUpdatesQuery = {
  /** 대화 세션의 대화 — 같은 채널의 다른 세션(대화)에 달린 스레드 답글은 그 세션 몫이다 */
  conversationId: string;
  /** 세션의 thread_replies_seen_at. null 이면 실을 것이 없다 */
  since: Date | null;
};

export type PendingThreadUpdates = { updates: InboundThreadUpdate[]; omitted?: number; latestAt?: Date };

/**
 * 그 대화의 스레드들에 since 뒤로 새로 달린 normal 답글(스레드 소식 스펙 4장) — 작성자는 가리지 않는다(이 에이전트 자신 포함, T6),
 * 수정은 보지 않는다(created_at 만, T7). 새 답글이 가장 늦게 달린 스레드부터 INBOUND_THREAD_UPDATES_MAX 개를 고르고, 배열은
 * 마지막 답글 오름차순(오래된 것부터 읽히게). 밖으로 밀린 스레드는 omitted 로 센다. latestAt 은 고려한 답글 전체(밀린 스레드의
 * 것까지)의 가장 늦은 시각 — 밀린 것도 「외 N개」로 알렸으니 send 가 받아들여지면 커서를 이 시각으로 올린다
 */
export function pendingThreadUpdatesFor(db: DbOrTx, q: PendingThreadUpdatesQuery): PendingThreadUpdates {
  if (q.since === null) return { updates: [] };
  const scope = and(
    eq(messages.conversationId, q.conversationId),
    eq(messages.kind, "normal"),
    isNotNull(messages.threadRootId),
    gt(messages.createdAt, q.since),
  );
  const lastAt = sql<number>`max(${messages.createdAt})`;
  const threads = db
    .select({
      rootId: messages.threadRootId,
      count: sql<number>`count(*)`,
      lastAt,
    })
    .from(messages)
    .where(scope)
    .groupBy(messages.threadRootId)
    .orderBy(desc(lastAt), desc(sql`max(${messages.seq})`))
    .all();
  if (threads.length === 0) return { updates: [] };

  const picked = threads
    .slice(0, INBOUND_THREAD_UPDATES_MAX)
    .flatMap((t) => (t.rootId ? [{ ...t, rootId: t.rootId }] : []));
  const latestAt = new Date(threads[0]?.lastAt ?? q.since.getTime());
  const recentOf = new Map(
    picked.map((t) => [
      t.rootId,
      db
        .select({
          authorType: messages.authorType,
          authorId: messages.authorId,
          bodyMd: messages.bodyMd,
          attachments: messages.attachments,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(and(scope, eq(messages.threadRootId, t.rootId)))
        .orderBy(desc(messages.seq))
        .limit(THREAD_UPDATE_REPLIES_MAX)
        .all()
        .reverse(),
    ]),
  );
  const roots = new Map(
    db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        bodyMd: messages.bodyMd,
        mentions: messages.mentions,
      })
      .from(messages)
      .where(
        inArray(
          messages.id,
          picked.map((t) => t.rootId),
        ),
      )
      .all()
      .map((r) => [r.id, r]),
  );
  const channelId = [...roots.values()][0]?.channelId;
  const renderable =
    channelId === undefined
      ? []
      : sessionParticipants(db, { channelId, conversationId: q.conversationId }, { includeInactive: true });
  const authorOf = resolveAuthors(db, [...recentOf.values()].flat());
  const handleOf = mentionHandles(
    db,
    [...roots.values()].flatMap((r) => [
      ...r.mentions.agents.map((id) => `a:${id}`),
      ...r.mentions.users.map((id) => `u:${id}`),
    ]),
  );

  const updates = picked
    .map((t): InboundThreadUpdate => {
      const root = roots.get(t.rootId);
      return {
        rootId: t.rootId,
        rootExcerpt: root ? excerptOf(root.bodyMd, handleOf) : "",
        newReplies: t.count,
        recent: (recentOf.get(t.rootId) ?? []).map((r) => ({
          author: authorOf(r),
          text: clip(
            withPlaceholder(renderForAgent(r.bodyMd, renderable), r.attachments),
            THREAD_UPDATE_REPLY_TEXT_MAX,
          ),
          ts: r.createdAt.toISOString(),
        })),
      };
    })
    .reverse();
  const omitted = threads.length - picked.length;
  return { updates, ...(omitted > 0 ? { omitted } : {}), latestAt };
}

/** 세션의 스레드 답글 커서를 올린다 — 뒤로 가지 않는다. null 이던 행은 to 로 채운다 */
export function advanceThreadRepliesCursor(db: DbOrTx, sessionRowId: string, to: Date): void {
  db.update(agentSessions)
    .set({ threadRepliesSeenAt: to })
    .where(
      and(
        eq(agentSessions.id, sessionRowId),
        or(
          isNull(agentSessions.threadRepliesSeenAt),
          sql`${agentSessions.threadRepliesSeenAt} < ${to.getTime()}`,
        ),
      ),
    )
    .run();
}
