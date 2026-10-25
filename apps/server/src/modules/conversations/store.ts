import { Conversation } from "@dodok/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DbOrTx } from "../../db/client";
import { channels, conversations } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";
import { assertChannelWritable } from "../channels/service";

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

/**
 * storeMessage 가 같은 트랜잭션에서 부른다 — last_seq·last_message_at 를 올린다. 시스템 메시지는 last_seq 만(읽음 깎기에 필요하다) —
 * 닫기·다시 열기·런 한도 같은 서버 알림이 활동 시각을 올리면 닫은 세션이 목록 맨 위로 오고 다시 연 옛 세션이 latestOpenConversation
 * 1순위가 된다. 목록 순서와 다리는 사람·에이전트의 대화를 따른다
 */
export function touchConversation(
  tx: DbOrTx,
  conversationId: string,
  message: { seq: number; createdAt: Date; kind: string },
): void {
  tx.update(conversations)
    .set(
      message.kind === "system"
        ? { lastSeq: message.seq }
        : { lastSeq: message.seq, lastMessageAt: message.createdAt },
    )
    .where(eq(conversations.id, conversationId))
    .run();
}

export type NewConversationRow = {
  channelId: string;
  title: string;
  titleSource: Conversation["titleSource"];
  createdBy: Conversation["createdBy"];
  createdAt: Date;
};

/** 대화 한 행을 만든다 — 권한은 부르는 쪽이 본다(conversations/service.ts resolveSendConversation) */
export function createConversation(tx: DbOrTx, input: NewConversationRow): Conversation {
  const row = tx
    .insert(conversations)
    .values({
      id: uuidv7(),
      channelId: input.channelId,
      title: input.title,
      titleSource: input.titleSource,
      createdByType: input.createdBy.type,
      createdById: input.createdBy.id,
      createdAt: input.createdAt,
    })
    .returning()
    .get();
  return rowToConversation(row);
}

/** 닫힌 대화인가 — 늦은 정본·디스패치처럼 던지지 않고 가르는 자리가 쓴다. 없는 대화는 false */
export function isConversationClosed(db: DbOrTx, conversationId: string): boolean {
  const row = db
    .select({ closedAt: conversations.closedAt })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  return row?.closedAt != null;
}

/**
 * 쓰기 전에 부르는 대화 검사(채널 세션 스펙 「세션 만들기·닫기」 절) — 없거나 다른 워크스페이스면 404, 채널을 보관했으면 409 CHANNEL_ARCHIVED, 닫혔으면 409
 * CONVERSATION_CLOSED(이 순서 — 채널 세션 계획 Global Constraints). 사람 보내기·카드 상호작용·리액션·첨부 묶기가 이 한 함수를 지난다.
 * 에이전트 정본·시스템 메시지는 닫힌 대화에도 저장되므로 부르지 않는다
 */
export function assertConversationWritable(
  db: DbOrTx,
  conversationId: string,
  workspaceId?: string,
): Conversation {
  const conversation = getConversation(db, conversationId, workspaceId);
  if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
  assertChannelWritable(db, conversation.channelId, workspaceId);
  if (conversation.closedAt !== undefined) throw apiError("CONVERSATION_CLOSED", "닫힌 세션입니다");
  return conversation;
}
