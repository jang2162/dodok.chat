import { describe, expect, it } from "vitest";
import * as root from "../src/index";
import { ChannelActivity, ChannelRead, ChannelReadUpdate, ChannelUnread, UnreadSnapshot } from "../src/reads";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;

describe("ChannelUnread·UnreadSnapshot", () => {
  const unread = { channelId: ID(1), lastReadSeq: 3, latestSeq: 7, unread: true, mentions: 2 };

  it("현황 한 줄을 받는다 — latestSeq 가 있어야 한다", () => {
    expect(ChannelUnread.parse(unread)).toEqual(unread);
    const { latestSeq: _, ...noLatest } = unread;
    expect(ChannelUnread.safeParse(noLatest).success).toBe(false);
  });

  it("mentions 는 0~99 — 서버가 99 에서 자른다", () => {
    expect(ChannelUnread.safeParse({ ...unread, mentions: 99 }).success).toBe(true);
    expect(ChannelUnread.safeParse({ ...unread, mentions: 100 }).success).toBe(false);
    expect(ChannelUnread.safeParse({ ...unread, mentions: -1 }).success).toBe(false);
  });

  it("seq 는 0 이상의 정수", () => {
    expect(ChannelUnread.safeParse({ ...unread, lastReadSeq: -1 }).success).toBe(false);
    expect(ChannelUnread.safeParse({ ...unread, latestSeq: 1.5 }).success).toBe(false);
  });

  it("스냅숏은 채널 목록을 싣는다", () => {
    expect(UnreadSnapshot.parse({ channels: [unread] })).toEqual({ channels: [unread] });
    expect(UnreadSnapshot.safeParse({ channels: [{ ...unread, channelId: "x" }] }).success).toBe(false);
  });
});

describe("ChannelRead·ChannelReadUpdate", () => {
  it("클라이언트가 보내는 seq 는 0 이상", () => {
    expect(ChannelRead.parse({ channelId: ID(1), seq: 0 })).toEqual({ channelId: ID(1), seq: 0 });
    expect(ChannelRead.safeParse({ channelId: ID(1), seq: -1 }).success).toBe(false);
    expect(ChannelRead.safeParse({ channelId: "x", seq: 1 }).success).toBe(false);
  });

  it("서버가 돌려주는 읽음 위치", () => {
    expect(ChannelReadUpdate.parse({ channelId: ID(1), lastReadSeq: 4 })).toEqual({
      channelId: ID(1),
      lastReadSeq: 4,
    });
    expect(ChannelReadUpdate.safeParse({ channelId: ID(1), lastReadSeq: -1 }).success).toBe(false);
  });
});

describe("ChannelActivity", () => {
  const activity = {
    channelId: ID(1),
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

  it("seq 는 1 이상 — 메시지 seq 는 1부터", () => {
    expect(ChannelActivity.safeParse({ ...activity, seq: 0 }).success).toBe(false);
  });

  it("본문 필드는 싣지 않는다", () => {
    expect(ChannelActivity.parse({ ...activity, bodyMd: "secret" })).not.toHaveProperty("bodyMd");
  });
});

it("루트에서 다시 내보낸다", () => {
  expect(root.ChannelUnread).toBe(ChannelUnread);
  expect(root.UnreadSnapshot).toBe(UnreadSnapshot);
  expect(root.ChannelRead).toBe(ChannelRead);
  expect(root.ChannelReadUpdate).toBe(ChannelReadUpdate);
  expect(root.ChannelActivity).toBe(ChannelActivity);
});
