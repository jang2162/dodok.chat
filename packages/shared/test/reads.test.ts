import { describe, expect, it } from "vitest";
import * as root from "../src/index";
import {
  ChannelActivity,
  ConversationRead,
  ConversationReadUpdate,
  ConversationUnread,
  UnreadSnapshot,
} from "../src/reads";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;

describe("ConversationUnread·UnreadSnapshot", () => {
  const unread = {
    conversationId: ID(9),
    channelId: ID(1),
    lastReadSeq: 3,
    latestSeq: 7,
    unread: true,
    mentions: 2,
  };

  it("대화 하나의 현황을 받는다 — 대화·채널 id 와 latestSeq 가 있어야 한다", () => {
    expect(ConversationUnread.parse(unread)).toEqual(unread);
    for (const key of ["latestSeq", "conversationId", "channelId"] as const) {
      const { [key]: _, ...missing } = unread;
      expect(ConversationUnread.safeParse(missing).success).toBe(false);
    }
  });

  it("mentions 는 0~99 — 서버가 99 에서 자른다", () => {
    expect(ConversationUnread.safeParse({ ...unread, mentions: 99 }).success).toBe(true);
    expect(ConversationUnread.safeParse({ ...unread, mentions: 100 }).success).toBe(false);
    expect(ConversationUnread.safeParse({ ...unread, mentions: -1 }).success).toBe(false);
  });

  it("seq 는 0 이상의 정수", () => {
    expect(ConversationUnread.safeParse({ ...unread, lastReadSeq: -1 }).success).toBe(false);
    expect(ConversationUnread.safeParse({ ...unread, latestSeq: 1.5 }).success).toBe(false);
  });

  it("스냅숏은 대화 목록과 보관하지 않은 채널 id 를 싣는다", () => {
    const snap = { conversations: [unread], channels: [ID(1), ID(2)] };
    expect(UnreadSnapshot.parse(snap)).toEqual(snap);
    expect(UnreadSnapshot.safeParse({ conversations: [unread] }).success).toBe(false);
    expect(
      UnreadSnapshot.safeParse({ conversations: [{ ...unread, conversationId: "x" }], channels: [] }).success,
    ).toBe(false);
  });
});

describe("ConversationRead·ConversationReadUpdate", () => {
  it("클라이언트가 보내는 seq 는 0 이상", () => {
    expect(ConversationRead.parse({ conversationId: ID(1), seq: 0 })).toEqual({
      conversationId: ID(1),
      seq: 0,
    });
    expect(ConversationRead.safeParse({ conversationId: ID(1), seq: -1 }).success).toBe(false);
    expect(ConversationRead.safeParse({ conversationId: "x", seq: 1 }).success).toBe(false);
    // 채널 단위 꼴은 받지 않는다
    expect(ConversationRead.safeParse({ channelId: ID(1), seq: 1 }).success).toBe(false);
  });

  it("서버가 돌려주는 읽음 위치 — 대화와 그 채널", () => {
    const update = { conversationId: ID(2), channelId: ID(1), lastReadSeq: 4 };
    expect(ConversationReadUpdate.parse(update)).toEqual(update);
    expect(ConversationReadUpdate.safeParse({ ...update, lastReadSeq: -1 }).success).toBe(false);
    const { channelId: _, ...noChannel } = update;
    expect(ConversationReadUpdate.safeParse(noChannel).success).toBe(false);
  });
});

describe("ChannelActivity", () => {
  const activity = {
    channelId: ID(1),
    conversationId: ID(6),
    seq: 5,
    authorType: "user",
    authorId: ID(2),
    mentionedUserIds: [ID(3)],
  } as const;

  it("본문 없는 신호 — 사람·에이전트·자동화 글만(자동화면 authorId 가 자동화 id)", () => {
    expect(ChannelActivity.parse(activity)).toEqual(activity);
    expect(ChannelActivity.parse({ ...activity, authorType: "agent", threadRootId: ID(4) })).toEqual({
      ...activity,
      authorType: "agent",
      threadRootId: ID(4),
    });
    expect(ChannelActivity.parse({ ...activity, authorType: "automation", authorId: ID(5) })).toEqual({
      ...activity,
      authorType: "automation",
      authorId: ID(5),
    });
    expect(ChannelActivity.safeParse({ ...activity, authorType: "system" }).success).toBe(false);
  });

  it("대화 id 를 싣는다 — 세션마다 따로 센다", () => {
    const { conversationId: _, ...noConversation } = activity;
    expect(ChannelActivity.safeParse(noConversation).success).toBe(false);
  });

  it("seq 는 1 이상 — 메시지 seq 는 1부터", () => {
    expect(ChannelActivity.safeParse({ ...activity, seq: 0 }).success).toBe(false);
  });

  it("본문 필드는 싣지 않는다", () => {
    expect(ChannelActivity.parse({ ...activity, bodyMd: "secret" })).not.toHaveProperty("bodyMd");
  });
});

it("루트에서 다시 내보낸다", () => {
  expect(root.ConversationUnread).toBe(ConversationUnread);
  expect(root.UnreadSnapshot).toBe(UnreadSnapshot);
  expect(root.ConversationRead).toBe(ConversationRead);
  expect(root.ConversationReadUpdate).toBe(ConversationReadUpdate);
  expect(root.ChannelActivity).toBe(ChannelActivity);
});
