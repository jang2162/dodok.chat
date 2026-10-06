import type { ChannelUnread } from "@dodok/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { CH, CH2 } from "../../../test/fixtures";
import { captureEntryRead } from "./entryRead";
import { useUnread } from "./useUnread";

const row = (over: Partial<ChannelUnread> = {}): ChannelUnread => ({
  channelId: CH,
  lastReadSeq: 0,
  latestSeq: 0,
  unread: false,
  mentions: 0,
  ...over,
});
const snapshot = (...channels: ChannelUnread[]) => {
  useUnread.getState().beginSnapshot();
  useUnread.getState().applySnapshot({ channels });
};

beforeEach(() => useUnread.getState().reset());

describe("captureEntryRead", () => {
  it("스토어가 ready 면 그 채널의 lastReadSeq", () => {
    snapshot(row({ lastReadSeq: 7, latestSeq: 9, unread: true }));
    expect(captureEntryRead(CH)).toBe(7);
  });

  it("읽은 적 없는 채널(lastReadSeq 0 인 항목)은 0", () => {
    snapshot(row());
    expect(captureEntryRead(CH)).toBe(0);
  });

  it("ready 가 아니면 undefined — 스냅숏 전·요청 중·실패", () => {
    expect(captureEntryRead(CH)).toBeUndefined();
    useUnread.getState().beginSnapshot();
    expect(captureEntryRead(CH)).toBeUndefined();
    useUnread.getState().failSnapshot();
    expect(captureEntryRead(CH)).toBeUndefined();
  });

  it("스냅숏을 받은 뒤 다시 받다 실패해 ready 가 꺼지면 남은 항목이 있어도 undefined", () => {
    snapshot(row({ lastReadSeq: 7, latestSeq: 9 }));
    useUnread.getState().failSnapshot();
    expect(captureEntryRead(CH)).toBeUndefined();
  });

  it("스토어에 항목이 없으면 undefined(0 이 아니다) — 구분선이 채널 맨 앞에 그어지지 않게", () => {
    snapshot(row({ lastReadSeq: 7, latestSeq: 9 }));
    expect(captureEntryRead(CH2)).toBeUndefined();
  });

  it("보관한 채널(목록 밖)에 온 신호는 항목을 만들지 않으므로 undefined", () => {
    snapshot();
    useUnread.getState().applyRead({ channelId: CH, lastReadSeq: 5 }, { listed: false });
    expect(captureEntryRead(CH)).toBeUndefined();
  });
});
