import { z } from "zod";
import { Id } from "../common";

// 읽지 않음(읽지 않음 스펙 「계약」 장) — 읽음 위치는 사용자 × 채널마다 하나, 커지기만 한다

/**
 * 사용자 하나 × 채널 하나의 현황. GET /api/v1/me/unread 가 보관하지 않은 채널마다 싣는다(행이 없으면 lastReadSeq 0).
 * mentions 는 서버가 99 에서 자른다 — 웹은 「99+」
 */
export const ChannelUnread = z.object({
  channelId: Id,
  lastReadSeq: z.int().min(0),
  // 그 채널의 last_seq — 스냅숏 요청이 나가 있는 동안 받은 channel.activity 가운데 이 seq 이하는 이미 스냅숏에 들었다(다시 세면 배지가 겹친다)
  latestSeq: z.int().min(0),
  unread: z.boolean(),
  mentions: z.int().min(0).max(99),
});
export type ChannelUnread = z.infer<typeof ChannelUnread>;

export const UnreadSnapshot = z.object({ channels: z.array(ChannelUnread) });
export type UnreadSnapshot = z.infer<typeof UnreadSnapshot>;

/** wire channel.read(클라이언트 → 서버) — 사용자 id 는 세션에서만 온다. seq 가 last_seq 보다 크면 서버가 깎는다 */
export const ChannelRead = z.object({ channelId: Id, seq: z.int().min(0) });
export type ChannelRead = z.infer<typeof ChannelRead>;

/** wire channel.read(서버 → 그 사용자의 user 룸) — 다른 기기·탭이 맞춘다 */
export const ChannelReadUpdate = z.object({ channelId: Id, lastReadSeq: z.int().min(0) });
export type ChannelReadUpdate = z.infer<typeof ChannelReadUpdate>;

/** wire channel.activity(workspace 룸) — 보통 메시지가 생길 때마다 나가는 본문 없는 신호. 웹은 보는 채널만 구독하므로 다른 채널은 이것으로 안다 */
export const ChannelActivity = z.object({
  channelId: Id,
  seq: z.int().min(1),
  threadRootId: Id.optional(),
  authorType: z.enum(["user", "agent", "automation"]),
  /** 자동화 글이면 자동화 id */
  authorId: Id,
  mentionedUserIds: z.array(Id),
});
export type ChannelActivity = z.infer<typeof ChannelActivity>;
