import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { channels } from "../../db/schema.sqlite";

/**
 * 채널의 다음 메시지 seq를 발급한다. UPDATE ... RETURNING 이므로 호출한 트랜잭션이
 * 롤백되면 카운터도 되돌아간다. 메시지 INSERT와 같은 트랜잭션에서 호출할 것.
 */
export function allocateSeq(db: DbOrTx, channelId: string): number {
  const row = db
    .update(channels)
    .set({ lastSeq: sql`${channels.lastSeq} + 1` })
    .where(eq(channels.id, channelId))
    .returning({ seq: channels.lastSeq })
    .get();
  if (!row) throw new Error(`channel not found: ${channelId}`);
  return row.seq;
}

/** 채널에 마지막으로 발급한 seq — 메시지가 없으면 0. 없는 채널도 0(부르는 쪽이 채널을 먼저 확인한다) */
export function channelLastSeq(db: DbOrTx, channelId: string): number {
  return (
    db.select({ lastSeq: channels.lastSeq }).from(channels).where(eq(channels.id, channelId)).get()
      ?.lastSeq ?? 0
  );
}
