import type { ChannelUnread } from "@dodok/shared";
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { channelReads, channels } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

/** 배지가 세는 최대 — shared ChannelUnread.mentions 의 상한과 같아야 응답이 파싱된다(웹은 「99+」) */
const MENTIONS_CAP = 99;

/**
 * seq 를 그 채널의 last_seq 로 깎아 올리고 저장된 읽음 위치를 돌려준다. 커지기만 한다 — 늦게 온 요청·여러 기기가 섞여도 뒤로 가지
 * 않는다(읽지 않음 스펙 결정 7). 채널이 없거나 다른 워크스페이스면 NOT_FOUND. 보관한 채널도 받는다 — 읽기는 막지 않는다
 */
export function markRead(
  db: DbOrTx,
  workspaceId: string,
  userId: string,
  channelId: string,
  seq: number,
  now: Date,
): number {
  // getChannel 의 ChannelRecord 에는 last_seq 가 없다 — 직접 읽는다
  const channel = db
    .select({ lastSeq: channels.lastSeq })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
    .get();
  if (!channel) throw apiError("NOT_FOUND", "channel not found");
  const row = db
    .insert(channelReads)
    .values({ userId, channelId, lastReadSeq: Math.min(seq, channel.lastSeq), updatedAt: now })
    .onConflictDoUpdate({
      target: [channelReads.userId, channelReads.channelId],
      set: {
        lastReadSeq: sql`max(${channelReads.lastReadSeq}, excluded.last_read_seq)`,
        updatedAt: now,
      },
    })
    .returning({ lastReadSeq: channelReads.lastReadSeq })
    .get();
  return row.lastReadSeq;
}

type UnreadRow = {
  channelId: string;
  lastReadSeq: number;
  latestSeq: number;
  unread: number;
  mentions: number;
};

/**
 * 워크스페이스의 보관하지 않은 채널마다 그 사용자의 현황(읽지 않음 스펙 「무엇이 「안 읽음」인가」 장) — 행이 없으면 읽음 위치 0.
 * 굵게는 남이 쓴 최상위 보통 메시지만, 배지는 나를 멘션한 보통 메시지를 스레드 답글까지 센다(스레드가 활발한 채널이 늘 굵지 않게,
 * 멘션은 어디서 왔든 놓치지 않게 — 스펙 결정 5). 굵게 하위 질의는 thread_root_id IS NULL 덕에 messages_channel_thread_seq
 * (channel_id, thread_root_id, seq)를, 배지 하위 질의는 messages_channel_seq (channel_id, seq)를 범위로 탄다 — 다시 재려면
 * 마이그레이션을 다 적용한 DB 에서 이 질의 앞에 EXPLAIN QUERY PLAN 을 붙여 SEARCH m USING INDEX 줄 둘을 본다
 */
export function unreadFor(db: DbOrTx, workspaceId: string, userId: string): ChannelUnread[] {
  const rows = db.all<UnreadRow>(sql`
    SELECT c.id AS channelId,
      COALESCE(r.last_read_seq, 0) AS lastReadSeq,
      c.last_seq AS latestSeq,
      EXISTS (SELECT 1 FROM messages m
        WHERE m.channel_id = c.id AND m.seq > COALESCE(r.last_read_seq, 0)
          AND m.kind = 'normal' AND m.thread_root_id IS NULL
          AND NOT (m.author_type = 'user' AND m.author_id = ${userId})) AS unread,
      (SELECT COUNT(*) FROM (SELECT 1 FROM messages m
        WHERE m.channel_id = c.id AND m.seq > COALESCE(r.last_read_seq, 0)
          AND m.kind = 'normal'
          AND NOT (m.author_type = 'user' AND m.author_id = ${userId})
          AND EXISTS (SELECT 1 FROM json_each(m.mentions_json, '$.users') j WHERE j.value = ${userId})
        LIMIT ${MENTIONS_CAP})) AS mentions
    FROM channels c
    LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = ${userId}
    WHERE c.workspace_id = ${workspaceId} AND c.archived_at IS NULL
  `);
  return rows.map((r) => ({ ...r, unread: r.unread === 1 }));
}
