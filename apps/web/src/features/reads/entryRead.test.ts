import type { ConversationUnread } from "@dodok/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { CH, uid } from "../../../test/fixtures";
import { captureEntryRead } from "./entryRead";
import { useUnread } from "./useUnread";

/** CH 의 세션 둘 — 들어갈 때의 읽음 위치는 세션마다 */
const A = uid(21);
const B = uid(22);

const row = (over: Partial<ConversationUnread> = {}): ConversationUnread => ({
  conversationId: A,
  channelId: CH,
  lastReadSeq: 0,
  latestSeq: 0,
  unread: false,
  mentions: 0,
  ...over,
});
const snapshot = (...conversations: ConversationUnread[]) => {
  useUnread.getState().beginSnapshot();
  useUnread.getState().applySnapshot({ conversations, channels: [CH] });
};

beforeEach(() => useUnread.getState().reset());

describe("captureEntryRead", () => {
  it("스토어가 ready 면 그 세션의 lastReadSeq", () => {
    snapshot(row({ lastReadSeq: 7, latestSeq: 9, unread: true }));
    expect(captureEntryRead(A)).toBe(7);
  });

  it("같은 채널의 두 세션은 각자의 읽음 위치", () => {
    snapshot(row({ lastReadSeq: 7, latestSeq: 9 }), row({ conversationId: B, lastReadSeq: 2, latestSeq: 8 }));
    expect(captureEntryRead(A)).toBe(7);
    expect(captureEntryRead(B)).toBe(2);
  });

  it("읽은 적 없는 세션(lastReadSeq 0 인 항목)은 0", () => {
    snapshot(row());
    expect(captureEntryRead(A)).toBe(0);
  });

  it("ready 가 아니면 undefined — 스냅숏 전·요청 중·실패", () => {
    expect(captureEntryRead(A)).toBeUndefined();
    useUnread.getState().beginSnapshot();
    expect(captureEntryRead(A)).toBeUndefined();
    useUnread.getState().failSnapshot();
    expect(captureEntryRead(A)).toBeUndefined();
  });

  it("스냅숏을 받은 뒤 다시 받다 실패해 ready 가 꺼지면 남은 항목이 있어도 undefined", () => {
    snapshot(row({ lastReadSeq: 7, latestSeq: 9 }));
    useUnread.getState().failSnapshot();
    expect(captureEntryRead(A)).toBeUndefined();
  });

  it("스토어에 항목이 없으면 undefined(0 이 아니다) — 구분선이 세션 맨 앞에 그어지지 않게", () => {
    snapshot(row({ lastReadSeq: 7, latestSeq: 9 }));
    expect(captureEntryRead(B)).toBeUndefined();
  });

  it("보관한 채널(목록 밖)에 온 신호는 항목을 만들지 않으므로 undefined", () => {
    snapshot();
    useUnread.getState().applyRead({ conversationId: A, channelId: CH, lastReadSeq: 5 }, { listed: false });
    expect(captureEntryRead(A)).toBeUndefined();
  });
});
