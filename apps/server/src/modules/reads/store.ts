import type { ConversationUnread } from "@dodok/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { channels, conversationReads, conversations } from "../../db/schema.sqlite";
import { readableChannelSql } from "../../auth/channel-access";
import { apiError } from "../../http/errors";

/** 배지가 세는 최대 — shared ConversationUnread.mentions 의 상한과 같아야 응답이 파싱된다(웹은 「99+」) */
const MENTIONS_CAP = 99;

/**
 * seq 를 그 대화의 last_seq 로 깎아 올리고 저장된 읽음 위치를 돌려준다. 커지기만 한다 — 늦게 온 요청·여러 기기가 섞여도 뒤로 가지
 * 않는다(읽지 않음 스펙 결정 7). 대화 단위로 깎는 까닭: seq 는 채널 하나의 번호를 모든 세션이 같이 써서, 채널 끝으로 깎으면 세션 A 의
 * 읽음이 아직 오지 않은 A 의 글 자리(B 가 쓴 seq)까지 올라간다. 대화가 없거나 다른 워크스페이스·남의 DM 이면 NOT_FOUND — 남의 DM 에
 * 읽음 행을 쓰거나 깎은 값(그 대화의 끝)을 돌려주지 않는다.
 * 보관한 채널·닫힌 대화도 받는다 — 읽기는 막지 않는다
 */
export function markRead(
  db: DbOrTx,
  workspaceId: string,
  userId: string,
  conversationId: string,
  seq: number,
  now: Date,
): number {
  const conversation = db
    .select({ lastSeq: conversations.lastSeq })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(channels.workspaceId, workspaceId),
        readableChannelSql(userId),
      ),
    )
    .get();
  if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
  const row = db
    .insert(conversationReads)
    .values({ userId, conversationId, lastReadSeq: Math.min(seq, conversation.lastSeq), updatedAt: now })
    .onConflictDoUpdate({
      target: [conversationReads.userId, conversationReads.conversationId],
      set: {
        lastReadSeq: sql`max(${conversationReads.lastReadSeq}, excluded.last_read_seq)`,
        updatedAt: now,
      },
    })
    .returning({ lastReadSeq: conversationReads.lastReadSeq })
    .get();
  return row.lastReadSeq;
}

type UnreadRow = {
  conversationId: string;
  channelId: string;
  lastReadSeq: number;
  latestSeq: number;
  unread: number;
  mentions: number;
};

/**
 * 워크스페이스의 보관하지 않은, 그 사용자가 읽을 수 있는 채널(남의 DM 제외 — SQL 에서 거른다)의 대화마다(닫힌 대화 포함) 그 사용자의 현황(읽지 않음 스펙 「무엇이 「안 읽음」인가」 장을 대화
 * 단위로) — 행이 없으면 읽음 위치 0. 굵게는 남이 쓴 최상위 보통 메시지만, 배지는 나를 멘션한 보통 메시지를 스레드 답글까지 센다
 * (스레드가 활발한 세션이 늘 굵지 않게, 멘션은 어디서 왔든 놓치지 않게 — 스펙 결정 5).
 * 굵게 하위 질의는 messages_conversation_thread_seq (conversation_id, thread_root_id, seq)를, 배지 하위 질의는 channel_id 를 함께
 * 걸어 messages_channel_seq (channel_id, seq)를 범위로 탄다 — conversation_id 로만 걸면 (conversation_id, thread_root_id, seq) 의
 * 앞머리만 써 그 대화를 처음부터 훑는다. 다시 재려면 마이그레이션을 다 적용한 DB 에서 이 질의 앞에 EXPLAIN QUERY PLAN 을 붙여
 * SEARCH m USING INDEX 줄 둘의 `seq>?` 를 본다
 */
export function unreadFor(db: DbOrTx, workspaceId: string, userId: string): ConversationUnread[] {
  const rows = db.all<UnreadRow>(sql`
    SELECT v.id AS conversationId, v.channel_id AS channelId,
      COALESCE(r.last_read_seq, 0) AS lastReadSeq,
      v.last_seq AS latestSeq,
      EXISTS (SELECT 1 FROM messages m
        WHERE m.conversation_id = v.id AND m.thread_root_id IS NULL AND m.seq > COALESCE(r.last_read_seq, 0)
          AND m.kind = 'normal'
          AND NOT (m.author_type = 'user' AND m.author_id = ${userId})) AS unread,
      (SELECT COUNT(*) FROM (SELECT 1 FROM messages m
        WHERE m.channel_id = v.channel_id AND m.seq > COALESCE(r.last_read_seq, 0) AND m.conversation_id = v.id
          AND m.kind = 'normal'
          AND NOT (m.author_type = 'user' AND m.author_id = ${userId})
          AND EXISTS (SELECT 1 FROM json_each(m.mentions_json, '$.users') j WHERE j.value = ${userId})
        LIMIT ${MENTIONS_CAP})) AS mentions
    FROM conversations v
    JOIN channels ON channels.id = v.channel_id
    LEFT JOIN conversation_reads r ON r.conversation_id = v.id AND r.user_id = ${userId}
    WHERE channels.workspace_id = ${workspaceId} AND channels.archived_at IS NULL
      AND ${readableChannelSql(userId)}
  `);
  return rows.map((r) => ({ ...r, unread: r.unread === 1 }));
}

/** 보관하지 않은, 그 사용자가 읽을 수 있는 채널 id — 스냅숏의 `channels`(대화가 없는 채널도 든다, shared UnreadSnapshot 주석) */
export function listedChannelIds(db: DbOrTx, workspaceId: string, userId: string): string[] {
  return db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), isNull(channels.archivedAt), readableChannelSql(userId)),
    )
    .all()
    .map((r) => r.id);
}
