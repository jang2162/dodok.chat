import { Conversation } from "@dodok/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { channels, conversations } from "../../db/schema.sqlite";
import { parseStored } from "../../http/validate";

export type ConversationRow = typeof conversations.$inferSelect;

export function rowToConversation(row: ConversationRow): Conversation {
  return parseStored(
    Conversation,
    {
      id: row.id,
      channelId: row.channelId,
      title: row.title,
      titleSource: row.titleSource,
      createdBy: { type: row.createdByType, id: row.createdById },
      createdAt: row.createdAt.toISOString(),
      lastMessageAt: row.lastMessageAt?.toISOString(),
      lastSeq: row.lastSeq,
      closedAt: row.closedAt?.toISOString(),
      closedBy: row.closedBy ?? undefined,
    },
    "conversation",
  );
}

/** 다른 워크스페이스·없는 대화면 undefined */
export function getConversation(db: DbOrTx, id: string, workspaceId?: string): Conversation | undefined {
  const row = db
    .select({ conversation: conversations })
    .from(conversations)
    .innerJoin(channels, eq(channels.id, conversations.channelId))
    .where(
      and(
        eq(conversations.id, id),
        workspaceId === undefined ? undefined : eq(channels.workspaceId, workspaceId),
      ),
    )
    .get();
  return row ? rowToConversation(row.conversation) : undefined;
}

/**
 * 열린 대화 가운데 last_message_at(없으면 created_at) 이 가장 늦은 것 — 대화가 정해지지 않은 시스템 메시지의 자리(채널 세션 계획
 * 판정 PS3, 스펙 4.2). 열린 대화가 없으면 undefined — 부르는 쪽은 남기지 않는다
 */
export function latestOpenConversation(db: DbOrTx, channelId: string): string | undefined {
  return db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.channelId, channelId), isNull(conversations.closedAt)))
    .orderBy(
      desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`),
      desc(conversations.id),
    )
    .limit(1)
    .get()?.id;
}

/** storeMessage 가 같은 트랜잭션에서 부른다 — last_seq·last_message_at 를 올린다 */
export function touchConversation(tx: DbOrTx, conversationId: string, seq: number, at: Date): void {
  tx.update(conversations)
    .set({ lastSeq: seq, lastMessageAt: at })
    .where(eq(conversations.id, conversationId))
    .run();
}

/**
 * 채널 만들기가 같은 트랜잭션에서 부른다 — id 가 채널 id 인 「이전 대화」. 채널마다 대화가 하나이고 그 id 가 채널 id 인 동안
 * 세션 키·OpenClaw 피어 id 값이 대화 이전과 같다(채널 세션 계획 판정 PS1). 세션 만들기가 들어오면 걷는다(스펙 결정 7)
 */
export function createLegacyConversation(
  tx: DbOrTx,
  channel: { id: string; createdBy: string; createdAt: Date },
): void {
  tx.insert(conversations)
    .values({
      id: channel.id,
      channelId: channel.id,
      title: "이전 대화",
      titleSource: "user",
      createdByType: "user",
      createdById: channel.createdBy,
      createdAt: channel.createdAt,
    })
    .run();
}
