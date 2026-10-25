import { z } from "zod";
import { Id } from "../common";

// 읽지 않음(읽지 않음 스펙 「계약」 장) — 읽음 위치는 사용자 × 대화(세션)마다 하나, 커지기만 한다(채널 세션 계획 태스크 7).
// 규칙은 채널 단위였을 때 그대로 단위만 대화다 — seq 는 채널 하나의 번호를 모든 세션이 같이 쓰므로 세션 A 의 읽음이 B 의 글을 덮지 않게 따로 둔다

/**
 * 사용자 하나 × 대화 하나의 현황. GET /api/v1/me/unread 가 보관하지 않은 채널의 대화마다(닫힌 대화 포함) 싣는다(행이 없으면 lastReadSeq 0).
 * mentions 는 서버가 99 에서 자른다 — 웹은 「99+」, 채널 배지는 웹이 대화 배지를 합쳐 다시 자른다
 */
export const ConversationUnread = z.object({
  conversationId: Id,
  channelId: Id,
  lastReadSeq: z.int().min(0),
  // 그 대화의 last_seq — 스냅숏 요청이 나가 있는 동안 받은 channel.activity 가운데 이 seq 이하는 이미 스냅숏에 들었다(다시 세면 배지가 겹친다)
  latestSeq: z.int().min(0),
  unread: z.boolean(),
  mentions: z.int().min(0).max(99),
});
export type ConversationUnread = z.infer<typeof ConversationUnread>;

/**
 * `channels` 는 보관하지 않은 채널 id 전부 — 대화가 없는 채널(만들고 아직 아무도 안 쓴 채널)도 든다. 웹이 보관·보관 해제가 현황에
 * 반영됐는지 견줄 때 「대화 항목이 없음」으로는 보관한 채널과 빈 채널을 가르지 못해서다
 */
export const UnreadSnapshot = z.object({
  conversations: z.array(ConversationUnread),
  channels: z.array(Id),
});
export type UnreadSnapshot = z.infer<typeof UnreadSnapshot>;

/** wire conversation.read(클라이언트 → 서버) — 사용자 id 는 세션에서만 온다. seq 가 그 대화의 last_seq 보다 크면 서버가 깎는다 */
export const ConversationRead = z.object({ conversationId: Id, seq: z.int().min(0) });
export type ConversationRead = z.infer<typeof ConversationRead>;

/** wire conversation.read(서버 → 그 사용자의 user 룸) — 다른 기기·탭이 맞춘다. channelId 는 웹이 사이드바 목록에 있는 채널인지 보려고 */
export const ConversationReadUpdate = z.object({
  conversationId: Id,
  channelId: Id,
  lastReadSeq: z.int().min(0),
});
export type ConversationReadUpdate = z.infer<typeof ConversationReadUpdate>;

/** wire channel.activity(workspace 룸) — 보통 메시지가 생길 때마다 나가는 본문 없는 신호. 웹은 보는 채널만 구독하므로 다른 채널·세션은 이것으로 안다 */
export const ChannelActivity = z.object({
  channelId: Id,
  conversationId: Id,
  seq: z.int().min(1),
  threadRootId: Id.optional(),
  authorType: z.enum(["user", "agent", "automation"]),
  /** 자동화 글이면 자동화 id */
  authorId: Id,
  mentionedUserIds: z.array(Id),
});
export type ChannelActivity = z.infer<typeof ChannelActivity>;
