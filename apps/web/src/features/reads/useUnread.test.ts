import type { ChannelActivity, ChannelUnread } from "@dodok/shared";
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
  useUnread,
} from "./useUnread";

const OTHER = uid(12);
const CH3 = uid(3);

const row = (over: Partial<ChannelUnread> = {}): ChannelUnread => ({
  channelId: CH,
  lastReadSeq: 0,
  latestSeq: 0,
  unread: false,
  mentions: 0,
  ...over,
});
const activity = (seq: number, over: Partial<ChannelActivity> = {}): ChannelActivity => ({
  channelId: CH,
  seq,
  authorType: "user",
  authorId: OTHER,
  mentionedUserIds: [],
  ...over,
});
/** 다른 채널을 보고 있는, 사이드바 목록에 있는 채널 — 가장 흔한 경우 */
const away: ActivityContext = { me: USER, viewing: CH2, atEnd: true, listed: true };
const store = () => useUnread.getState();
const entry = (channelId = CH) => store().byChannel[channelId];
const view = (channelId = CH) => ({ unread: entry(channelId)?.unread, mentions: entry(channelId)?.mentions });
const ready = (...rows: ChannelUnread[]) => {
  store().beginSnapshot();
  store().applySnapshot({ channels: rows });
};

beforeEach(() => store().reset());

describe("스냅숏", () => {
  it("받기 전·실패 뒤에는 useChannelUnread 가 null — 틀린 배지보다 없는 배지", () => {
    const { result, rerender } = renderHook(() => useChannelUnread(CH));
    expect(result.current).toBeNull();
    act(() => store().beginSnapshot());
    rerender();
    expect(result.current).toBeNull();
    act(() => store().failSnapshot());
    rerender();
    expect(result.current).toBeNull();
    expect(store().loading).toBe(false);
  });

  it("교체하면 그 값이 그대로 보이고, 실린 것 밖의 채널은 굵게·배지 없음", () => {
    const { result } = renderHook(() => [useChannelUnread(CH), useChannelUnread(CH2)]);
    act(() => ready(row({ unread: true, mentions: 3, lastReadSeq: 4, latestSeq: 9 })));
    expect(result.current).toEqual([
      { unread: true, mentions: 3 },
      { unread: false, mentions: 0 },
    ]);
    expect(entry()).toMatchObject({ lastReadSeq: 4 });
  });

  it("통째로 갈아 끼운다 — 다음 스냅숏에 없는 채널 항목은 남지 않는다", () => {
    ready(row(), row({ channelId: CH2, unread: true }));
    ready(row());
    expect(entry(CH2)).toBeUndefined();
  });

  it("요청이 나가 있는 동안 온 activity 는 스냅숏 뒤에 다시 얹되, 스냅숏에 이미 든 것(seq ≤ latestSeq)은 버린다", () => {
    store().beginSnapshot();
    store().applyActivity(activity(10, { mentionedUserIds: [USER] }), away);
    store().applyActivity(activity(12, { mentionedUserIds: [USER] }), away);
    // 버퍼에 있는 동안은 그리지 않는다
    expect(entry()).toBeUndefined();
    store().applySnapshot({ channels: [row({ latestSeq: 10, lastReadSeq: 9, unread: true, mentions: 1 })] });
    expect(view()).toEqual({ unread: true, mentions: 2 });
    expect(store()).toMatchObject({ ready: true, loading: false, buffer: [] });
  });

  it("요청이 나가 있는 동안 온 channel.read 도 스냅숏 뒤에 얹는다 — 스냅숏이 그 읽음보다 앞선 것이어도 굵게가 되살아나지 않는다", () => {
    store().beginSnapshot();
    store().applyRead({ channelId: CH, lastReadSeq: 12 }, { listed: true });
    store().applySnapshot({ channels: [row({ latestSeq: 12, lastReadSeq: 8, unread: true, mentions: 2 })] });
    expect(view()).toEqual({ unread: false, mentions: 0 });
    expect(entry()?.lastReadSeq).toBe(12);
  });

  it("다시 시작하면(beginSnapshot) 앞 요청의 버퍼는 버린다 — 새 요청의 스냅숏이 그것을 이미 담는다", () => {
    store().beginSnapshot();
    store().applyActivity(activity(5), away);
    store().beginSnapshot();
    store().applySnapshot({ channels: [row({ latestSeq: 3 })] });
    expect(view()).toEqual({ unread: false, mentions: 0 });
  });
});

describe("channel.activity", () => {
  beforeEach(() => ready(row({ lastReadSeq: 3, latestSeq: 3 })));

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

  it("보고 있는 채널이고 끝이 보이면 그대로 — 읽음 전송이 맡는다", () => {
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

  it("스토어에 없는 채널(방금 만든 채널)의 activity 는 lastReadSeq 0 항목을 만들고 굵게", () => {
    store().applyActivity(activity(1, { channelId: CH3 }), away);
    expect(entry(CH3)).toMatchObject({ lastReadSeq: 0, unread: true, mentions: 0 });
  });

  it("사이드바 목록에 없는 채널(보관한 채널)의 activity 는 항목을 만들지 않는다 — 보관 해제 뒤 구분선이 맨 앞에 그어지지 않게", () => {
    store().applyActivity(activity(7, { channelId: CH3, mentionedUserIds: [USER] }), {
      ...away,
      listed: false,
    });
    expect(entry(CH3)).toBeUndefined();
  });

  it("이미 항목이 있는 채널은 목록 밖이어도 맞춘다(스냅숏 뒤에 보관된 채널 — 다시 받을 때까지)", () => {
    store().applyActivity(activity(4), { ...away, listed: false });
    expect(view()).toEqual({ unread: true, mentions: 0 });
  });

  it("배지는 99 에서 멈춘다", () => {
    ready(row({ mentions: 98 }));
    store().applyActivity(activity(1, { mentionedUserIds: [USER] }), away);
    store().applyActivity(activity(2, { mentionedUserIds: [USER] }), away);
    expect(entry()?.mentions).toBe(99);
  });
});

describe("서버 channel.read", () => {
  beforeEach(() => ready(row({ lastReadSeq: 3, latestSeq: 9, unread: true, mentions: 2 })));

  it("읽음 위치를 올리고 굵게·배지를 지운다(스레드 멘션도 — 채널을 본 것으로 읽음)", () => {
    store().applyRead({ channelId: CH, lastReadSeq: 9 }, { listed: true });
    expect(entry()).toMatchObject({ lastReadSeq: 9, unread: false, mentions: 0 });
  });

  it("지금 위치 이하의 읽음은 무시한다 — 커지기만 한다", () => {
    store().applyRead({ channelId: CH, lastReadSeq: 2 }, { listed: true });
    store().applyRead({ channelId: CH, lastReadSeq: 3 }, { listed: true });
    expect(entry()).toMatchObject({ lastReadSeq: 3, unread: true, mentions: 2 });
  });

  it("읽은 뒤 늦게 온 그 범위의 activity 는 다시 굵게 하지 않는다", () => {
    store().applyRead({ channelId: CH, lastReadSeq: 12 }, { listed: true });
    store().applyActivity(activity(11, { mentionedUserIds: [USER] }), away);
    expect(view()).toEqual({ unread: false, mentions: 0 });
  });

  it("목록에 있는데 항목이 없는 채널(스냅숏 뒤에 만든 채널)이면 항목을 만든다", () => {
    store().applyRead({ channelId: CH3, lastReadSeq: 5 }, { listed: true });
    expect(entry(CH3)).toMatchObject({ lastReadSeq: 5, unread: false, mentions: 0 });
  });

  it("목록 밖(보관한 채널)이면 항목을 만들지 않는다", () => {
    store().applyRead({ channelId: CH3, lastReadSeq: 5 }, { listed: false });
    expect(entry(CH3)).toBeUndefined();
  });
});

describe("보관 상태와 어긋남(needsResync)", () => {
  const archived = { archivedAt: "2027-01-15T08:00:00.000Z" };
  const live = { archivedAt: null };

  it("스냅숏이 없으면(받기 전·실패) 다시 받지 않는다 — 다음 연결이 받는다", () => {
    expect(needsResync({ id: CH, ...archived })).toBe(false);
  });

  it("보관했는데 항목이 있거나, 보관하지 않았는데 항목이 없으면 다시 받는다", () => {
    ready(row());
    expect(needsResync({ id: CH, ...archived })).toBe(true);
    expect(needsResync({ id: CH, ...live })).toBe(false);
    expect(needsResync({ id: CH2, ...live })).toBe(true);
    expect(needsResync({ id: CH2, ...archived })).toBe(false);
  });

  it("요청이 나가 있으면 늘 다시 받는다 — 나가 있는 응답이 바뀌기 전 것일 수 있다", () => {
    store().beginSnapshot();
    expect(needsResync({ id: CH, ...live })).toBe(true);
  });
});

describe("끝이 보이는 채널(setViewingAtEnd)", () => {
  it("켜고 끄며, 다른 채널을 끄는 것은 지금 채널을 지우지 않는다", () => {
    setViewingAtEnd(CH, true);
    expect(isViewingAtEnd(CH)).toBe(true);
    setViewingAtEnd(CH2, false);
    expect(isViewingAtEnd(CH)).toBe(true);
    setViewingAtEnd(CH, false);
    expect(isViewingAtEnd(CH)).toBe(false);
  });

  it("reset 이 지운다", () => {
    setViewingAtEnd(CH, true);
    store().reset();
    expect(isViewingAtEnd(CH)).toBe(false);
  });
});
