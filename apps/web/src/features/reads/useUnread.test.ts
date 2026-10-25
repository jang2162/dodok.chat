import type { ChannelActivity, ConversationUnread } from "@dodok/shared";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENT, CH, CH2, uid, USER } from "../../../test/fixtures";
import {
  type ActivityContext,
  isViewingAtEnd,
  needsResync,
  setViewingAtEnd,
  useChannelUnread,
  useConversationUnread,
  useUnread,
} from "./useUnread";

const OTHER = uid(12);
const CH3 = uid(3);
/** CH 의 세션 둘(A·B)과 CH2 의 세션 하나 — 현황은 세션마다, 사이드바는 채널마다 합친다 */
const A = uid(21);
const B = uid(22);
const C = uid(23);
const NEW = uid(24);

const row = (over: Partial<ConversationUnread> = {}): ConversationUnread => ({
  conversationId: A,
  channelId: CH,
  lastReadSeq: 0,
  latestSeq: 0,
  unread: false,
  mentions: 0,
  ...over,
});
const activity = (seq: number, over: Partial<ChannelActivity> = {}): ChannelActivity => ({
  channelId: CH,
  conversationId: A,
  seq,
  authorType: "user",
  authorId: OTHER,
  mentionedUserIds: [],
  ...over,
});
/** 다른 채널을 보고 있는, 사이드바 목록에 있는 채널 — 가장 흔한 경우 */
const away: ActivityContext = { me: USER, viewing: CH2, atEnd: true, listed: true };
const store = () => useUnread.getState();
const entry = (conversationId = A) => store().byConversation[conversationId];
const view = (conversationId = A) => ({
  unread: entry(conversationId)?.unread,
  mentions: entry(conversationId)?.mentions,
});
/** 스냅숏 — 채널 목록은 실린 대화의 채널 + 더 준 것 */
const ready = (rows: ConversationUnread[], channels: string[] = []) => {
  store().beginSnapshot();
  store().applySnapshot({
    conversations: rows,
    channels: [...new Set([...rows.map((r) => r.channelId), ...channels])],
  });
};

beforeEach(() => store().reset());

describe("스냅숏", () => {
  it("받기 전·실패 뒤에는 useChannelUnread·useConversationUnread 가 null — 틀린 배지보다 없는 배지", () => {
    const { result, rerender } = renderHook(() => [useChannelUnread(CH), useConversationUnread(A)]);
    expect(result.current).toEqual([null, null]);
    act(() => store().beginSnapshot());
    rerender();
    expect(result.current).toEqual([null, null]);
    act(() => store().failSnapshot());
    rerender();
    expect(result.current).toEqual([null, null]);
    expect(store().loading).toBe(false);
  });

  it("교체하면 그 값이 그대로 보이고, 실린 것 밖의 세션·채널은 굵게·배지 없음", () => {
    const { result } = renderHook(() => [
      useConversationUnread(A),
      useConversationUnread(NEW),
      useChannelUnread(CH),
      useChannelUnread(CH2),
    ]);
    act(() => ready([row({ unread: true, mentions: 3, lastReadSeq: 4, latestSeq: 9 })]));
    expect(result.current).toEqual([
      { unread: true, mentions: 3 },
      { unread: false, mentions: 0 },
      { unread: true, mentions: 3 },
      { unread: false, mentions: 0 },
    ]);
    expect(entry()).toMatchObject({ channelId: CH, lastReadSeq: 4 });
  });

  it("통째로 갈아 끼운다 — 다음 스냅숏에 없는 세션 항목·채널은 남지 않는다", () => {
    ready([row(), row({ conversationId: C, channelId: CH2, unread: true })]);
    ready([row()]);
    expect(entry(C)).toBeUndefined();
    expect(CH2 in store().channels).toBe(false);
  });

  it("요청이 나가 있는 동안 온 activity 는 스냅숏 뒤에 다시 얹되, 스냅숏에 이미 든 것(seq ≤ latestSeq)은 버린다", () => {
    store().beginSnapshot();
    store().applyActivity(activity(10, { mentionedUserIds: [USER] }), away);
    store().applyActivity(activity(12, { mentionedUserIds: [USER] }), away);
    // 버퍼에 있는 동안은 그리지 않는다
    expect(entry()).toBeUndefined();
    store().applySnapshot({
      conversations: [row({ latestSeq: 10, lastReadSeq: 9, unread: true, mentions: 1 })],
      channels: [CH],
    });
    expect(view()).toEqual({ unread: true, mentions: 2 });
    expect(store()).toMatchObject({ ready: true, loading: false, buffer: [] });
  });

  it("요청이 나가 있는 동안 온 conversation.read 도 스냅숏 뒤에 얹는다 — 스냅숏이 그 읽음보다 앞선 것이어도 굵게가 되살아나지 않는다", () => {
    store().beginSnapshot();
    store().applyRead({ conversationId: A, channelId: CH, lastReadSeq: 12 }, { listed: true });
    store().applySnapshot({
      conversations: [row({ latestSeq: 12, lastReadSeq: 8, unread: true, mentions: 2 })],
      channels: [CH],
    });
    expect(view()).toEqual({ unread: false, mentions: 0 });
    expect(entry()?.lastReadSeq).toBe(12);
  });

  it("다시 시작하면(beginSnapshot) 앞 요청의 버퍼는 버린다 — 새 요청의 스냅숏이 그것을 이미 담는다", () => {
    store().beginSnapshot();
    store().applyActivity(activity(5), away);
    store().beginSnapshot();
    store().applySnapshot({ conversations: [row({ latestSeq: 3 })], channels: [CH] });
    expect(view()).toEqual({ unread: false, mentions: 0 });
  });
});

describe("세션 합치기 — 사이드바 한 줄", () => {
  it("배지는 그 채널 세션 배지의 합, 굵게는 하나라도 — 다른 채널의 세션은 섞이지 않는다", () => {
    const { result } = renderHook(() => [useChannelUnread(CH), useChannelUnread(CH2)]);
    act(() =>
      ready([
        row({ conversationId: A, unread: false, mentions: 2 }),
        row({ conversationId: B, unread: true, mentions: 3 }),
        row({ conversationId: C, channelId: CH2, unread: false, mentions: 0 }),
      ]),
    );
    expect(result.current).toEqual([
      { unread: true, mentions: 5 },
      { unread: false, mentions: 0 },
    ]);
  });

  it("굵게는 어느 세션이든 하나라도 — 안 읽은 세션이 앞이고 다 읽은 세션이 뒤여도", () => {
    const { result } = renderHook(() => useChannelUnread(CH));
    act(() => ready([row({ conversationId: A, unread: true }), row({ conversationId: B, unread: false })]));
    expect(result.current).toEqual({ unread: true, mentions: 0 });
  });

  it("합은 99 에서 자른다 — 세션마다 99 안이어도", () => {
    const { result } = renderHook(() => useChannelUnread(CH));
    act(() => ready([row({ conversationId: A, mentions: 60 }), row({ conversationId: B, mentions: 60 })]));
    expect(result.current).toEqual({ unread: false, mentions: 99 });
  });

  it("다른 세션의 새 글이 사이드바를 굵게 한다 — 그 세션만 안 읽음", () => {
    ready([
      row({ conversationId: A, lastReadSeq: 3, latestSeq: 3 }),
      row({ conversationId: B, lastReadSeq: 2, latestSeq: 2 }),
    ]);
    const { result } = renderHook(() => [
      useChannelUnread(CH),
      useConversationUnread(A),
      useConversationUnread(B),
    ]);
    act(() => store().applyActivity(activity(4, { conversationId: B, mentionedUserIds: [USER] }), away));
    expect(result.current).toEqual([
      { unread: true, mentions: 1 },
      { unread: false, mentions: 0 },
      { unread: true, mentions: 1 },
    ]);
  });
});

describe("channel.activity", () => {
  beforeEach(() => ready([row({ lastReadSeq: 3, latestSeq: 3 })]));

  it("남의 최상위 글은 굵게, 나를 멘션했으면 배지 +1", () => {
    store().applyActivity(activity(4), away);
    expect(view()).toEqual({ unread: true, mentions: 0 });
    store().applyActivity(activity(5, { mentionedUserIds: [OTHER, USER] }), away);
    expect(view()).toEqual({ unread: true, mentions: 1 });
  });

  it("에이전트 글도 굵게", () => {
    store().applyActivity(activity(4, { authorType: "agent", authorId: AGENT }), away);
    expect(view()).toEqual({ unread: true, mentions: 0 });
  });

  it("같은 activity 가 두 번 와도 배지는 1", () => {
    const a = activity(4, { mentionedUserIds: [USER] });
    store().applyActivity(a, away);
    store().applyActivity(a, away);
    expect(view()).toEqual({ unread: true, mentions: 1 });
  });

  it("이미 읽은 seq 의 activity 는 세지 않는다", () => {
    store().applyActivity(activity(3, { mentionedUserIds: [USER] }), away);
    expect(view()).toEqual({ unread: false, mentions: 0 });
  });

  it("seq 거름은 세션마다 — A 가 읽은 범위(3)의 seq 도 B 의 새 글이면 센다", () => {
    ready([row({ lastReadSeq: 9, latestSeq: 9 }), row({ conversationId: B, lastReadSeq: 1, latestSeq: 1 })]);
    store().applyActivity(activity(5, { conversationId: B }), away);
    expect(view(B)).toEqual({ unread: true, mentions: 0 });
    expect(view(A)).toEqual({ unread: false, mentions: 0 });
  });

  it("내 글은 그대로", () => {
    store().applyActivity(activity(4, { authorId: USER, mentionedUserIds: [USER] }), away);
    expect(view()).toEqual({ unread: false, mentions: 0 });
  });

  it("자동화 글도 남의 글 — 굵게, 나를 멘션했으면 배지 +1(자동화 id 가 내 id 와 같아도)", () => {
    store().applyActivity(
      activity(4, { authorType: "automation", authorId: USER, mentionedUserIds: [USER] }),
      away,
    );
    expect(view()).toEqual({ unread: true, mentions: 1 });
  });

  it("같은 id 라도 에이전트 글은 내 글이 아니다", () => {
    store().applyActivity(activity(4, { authorType: "agent", authorId: USER }), away);
    expect(view()).toEqual({ unread: true, mentions: 0 });
  });

  it("스레드 답글은 굵게 하지 않고, 나를 멘션했으면 배지만 +1", () => {
    store().applyActivity(activity(4, { threadRootId: uid(10_001) }), away);
    expect(view()).toEqual({ unread: false, mentions: 0 });
    store().applyActivity(activity(5, { threadRootId: uid(10_001), mentionedUserIds: [USER] }), away);
    expect(view()).toEqual({ unread: false, mentions: 1 });
  });

  it("보고 있는 세션이고 끝이 보이면 그대로 — 읽음 전송이 맡는다", () => {
    store().applyActivity(activity(4, { mentionedUserIds: [USER] }), { ...away, viewing: CH, atEnd: true });
    expect(view()).toEqual({ unread: false, mentions: 0 });
  });

  it("보고 있는 채널이라도 끝이 안 보이면 굵게", () => {
    store().applyActivity(activity(4), { ...away, viewing: CH, atEnd: false });
    expect(view()).toEqual({ unread: true, mentions: 0 });
  });

  it("다른 채널의 끝이 보이는 것은 이 채널과 상관없다", () => {
    store().applyActivity(activity(4), { ...away, viewing: CH2, atEnd: true });
    expect(view()).toEqual({ unread: true, mentions: 0 });
  });

  it("스토어에 없는 세션(방금 만든 세션)의 activity 는 lastReadSeq 0 항목을 만들고 굵게 — 그 채널도 현황에 든다", () => {
    store().applyActivity(activity(1, { channelId: CH3, conversationId: NEW }), away);
    expect(entry(NEW)).toMatchObject({ channelId: CH3, lastReadSeq: 0, unread: true, mentions: 0 });
    expect(CH3 in store().channels).toBe(true);
  });

  it("사이드바 목록에 없는 채널(보관한 채널)의 activity 는 항목을 만들지 않는다 — 보관 해제 뒤 구분선이 맨 앞에 그어지지 않게", () => {
    store().applyActivity(activity(7, { channelId: CH3, conversationId: NEW, mentionedUserIds: [USER] }), {
      ...away,
      listed: false,
    });
    expect(entry(NEW)).toBeUndefined();
    expect(CH3 in store().channels).toBe(false);
  });

  it("이미 항목이 있는 세션은 목록 밖이어도 맞춘다(스냅숏 뒤에 보관된 채널 — 다시 받을 때까지)", () => {
    store().applyActivity(activity(4), { ...away, listed: false });
    expect(view()).toEqual({ unread: true, mentions: 0 });
  });

  it("배지는 99 에서 멈춘다", () => {
    ready([row({ mentions: 98 })]);
    store().applyActivity(activity(1, { mentionedUserIds: [USER] }), away);
    store().applyActivity(activity(2, { mentionedUserIds: [USER] }), away);
    expect(entry()?.mentions).toBe(99);
  });
});

describe("서버 conversation.read", () => {
  beforeEach(() =>
    ready([
      row({ lastReadSeq: 3, latestSeq: 9, unread: true, mentions: 2 }),
      row({ conversationId: B, lastReadSeq: 1, latestSeq: 5, unread: true, mentions: 1 }),
    ]),
  );

  it("그 세션의 읽음 위치를 올리고 굵게·배지를 지운다(스레드 멘션도 — 세션을 본 것으로 읽음)", () => {
    store().applyRead({ conversationId: A, channelId: CH, lastReadSeq: 9 }, { listed: true });
    expect(entry()).toMatchObject({ lastReadSeq: 9, unread: false, mentions: 0 });
  });

  it("세션 A 의 읽음은 같은 채널의 B 를 건드리지 않는다 — A 의 seq 가 B 의 글보다 커도", () => {
    store().applyRead({ conversationId: A, channelId: CH, lastReadSeq: 9 }, { listed: true });
    expect(entry(B)).toMatchObject({ lastReadSeq: 1, unread: true, mentions: 1 });
  });

  it("지금 위치 이하의 읽음은 무시한다 — 커지기만 한다", () => {
    store().applyRead({ conversationId: A, channelId: CH, lastReadSeq: 2 }, { listed: true });
    store().applyRead({ conversationId: A, channelId: CH, lastReadSeq: 3 }, { listed: true });
    expect(entry()).toMatchObject({ lastReadSeq: 3, unread: true, mentions: 2 });
  });

  it("읽은 뒤 늦게 온 그 범위의 activity 는 다시 굵게 하지 않는다", () => {
    store().applyRead({ conversationId: A, channelId: CH, lastReadSeq: 12 }, { listed: true });
    store().applyActivity(activity(11, { mentionedUserIds: [USER] }), away);
    expect(view()).toEqual({ unread: false, mentions: 0 });
  });

  it("목록에 있는데 항목이 없는 세션(스냅숏 뒤에 만든 세션)이면 항목을 만든다", () => {
    store().applyRead({ conversationId: NEW, channelId: CH3, lastReadSeq: 5 }, { listed: true });
    expect(entry(NEW)).toMatchObject({ channelId: CH3, lastReadSeq: 5, unread: false, mentions: 0 });
  });

  it("목록 밖(보관한 채널)이면 항목을 만들지 않는다", () => {
    store().applyRead({ conversationId: NEW, channelId: CH3, lastReadSeq: 5 }, { listed: false });
    expect(entry(NEW)).toBeUndefined();
  });
});

describe("보관 상태와 어긋남(needsResync)", () => {
  const archived = { archivedAt: "2027-01-15T08:00:00.000Z" };
  const live = { archivedAt: null };

  it("스냅숏이 없으면(받기 전·실패) 다시 받지 않는다 — 다음 연결이 받는다", () => {
    expect(needsResync({ id: CH, ...archived })).toBe(false);
  });

  it("보관했는데 현황에 있거나, 보관하지 않았는데 현황에 없으면 다시 받는다", () => {
    ready([row()]);
    expect(needsResync({ id: CH, ...archived })).toBe(true);
    expect(needsResync({ id: CH, ...live })).toBe(false);
    expect(needsResync({ id: CH2, ...live })).toBe(true);
    expect(needsResync({ id: CH2, ...archived })).toBe(false);
  });

  it("세션이 없는 빈 채널도 스냅숏의 채널 목록에 있으면 반영된 것이다 — 바뀔 때마다 다시 받지 않는다", () => {
    ready([row()], [CH3]);
    expect(needsResync({ id: CH3, ...live })).toBe(false);
    expect(needsResync({ id: CH3, ...archived })).toBe(true);
  });

  it("요청이 나가 있으면 늘 다시 받는다 — 나가 있는 응답이 바뀌기 전 것일 수 있다", () => {
    store().beginSnapshot();
    expect(needsResync({ id: CH, ...live })).toBe(true);
  });
});

describe("끝이 보이는 세션(setViewingAtEnd)", () => {
  it("켜고 끄며, 다른 세션을 끄는 것은 지금 세션을 지우지 않는다", () => {
    setViewingAtEnd(A, true);
    expect(isViewingAtEnd(A)).toBe(true);
    expect(isViewingAtEnd(B)).toBe(false);
    setViewingAtEnd(B, false);
    expect(isViewingAtEnd(A)).toBe(true);
    setViewingAtEnd(A, false);
    expect(isViewingAtEnd(A)).toBe(false);
  });

  it("reset 이 지운다", () => {
    setViewingAtEnd(A, true);
    store().reset();
    expect(isViewingAtEnd(A)).toBe(false);
  });
});
