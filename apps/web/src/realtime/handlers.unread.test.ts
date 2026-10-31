import type { Channel, ChannelActivity, ConversationUnread, UnreadSnapshot } from "@dodok/shared";
import { waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { applyChannel } from "@/features/channels/archived";
import { setViewingAtEnd, useUnread } from "@/features/reads/useUnread";
import { createFakeSocket } from "../../test/fakeSocket";
import { CH, CH2, uid, USER } from "../../test/fixtures";
import { channelOf, json } from "../../test/shellApi";
import { attachHandlers } from "./handlers";
import { createSubscriptions } from "./subscriptions";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const OTHER = uid(12);
const CH3 = uid(3);
const UNREAD_URL = "/api/v1/me/unread";
const ARCHIVED_AT = "2027-01-15T08:00:00.000Z";

/** 채널마다 세션 하나(따로 주지 않으면) — 현황은 세션 단위다. CH 의 둘째 세션 B 는 세션을 가르는 사례가 쓴다 */
const CONV: Record<string, string> = { [CH]: uid(21), [CH2]: uid(23), [CH3]: uid(24) };
const B = uid(22);
const convOf = (channelId: string) => CONV[channelId] as string;
const row = (over: Partial<ConversationUnread> = {}): ConversationUnread => ({
  conversationId: convOf(over.channelId ?? CH),
  channelId: CH,
  lastReadSeq: 0,
  latestSeq: 0,
  unread: false,
  mentions: 0,
  ...over,
});
const activity = (seq: number, over: Partial<ChannelActivity> = {}): ChannelActivity => ({
  channelId: CH,
  conversationId: convOf(over.channelId ?? CH),
  seq,
  authorType: "user",
  authorId: OTHER,
  mentionedUserIds: [],
  ...over,
});
/** 스냅숏 — 채널 목록은 실린 세션의 채널 */
const snap = (...rows: ConversationUnread[]): UnreadSnapshot => ({
  conversations: rows,
  channels: [...new Set(rows.map((r) => r.channelId))],
});

/** GET /me/unread 를 차례로 답하는 가짜 서버 — 답을 안 정했으면 테스트가 손으로 풀 때까지 기다린다 */
function stubUnread() {
  const replies: Array<() => Response> = [];
  const held: Array<(r: Response) => void> = [];
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input) !== UNREAD_URL) return json(404, { code: "NOT_FOUND", message: String(input) });
      calls += 1;
      const next = replies.shift();
      if (next) return next();
      return new Promise<Response>((resolve) => held.push(resolve));
    }),
  );
  return {
    calls: () => calls,
    reply(snapshot: UnreadSnapshot | Response) {
      replies.push(() => (snapshot instanceof Response ? snapshot : json(200, snapshot)));
    },
    /** 기다리고 있는 가장 이른 요청에 답한다 */
    release(snapshot: UnreadSnapshot) {
      held.shift()?.(json(200, snapshot));
    },
  };
}

const detachers: Array<() => void> = [];
const noNotify = {
  currentChannelId: () => undefined,
  currentConversationId: () => undefined,
  openActivity: () => {},
};

/** 사이드바 목록(qk.channels)에 CH·CH2 가 있는, 로그인한 USER 의 탭 */
function setup(channels: Channel[] = [channelOf(CH), channelOf(CH2)]) {
  const fake = createFakeSocket();
  fake.socket.connected = true;
  fake.socket.active = true;
  const onUnauthorized = vi.fn();
  const queryClient = createQueryClient(onUnauthorized);
  queryClient.setQueryData(qk.me, { user: { id: USER, handle: "owner" }, workspaceId: uid(3) });
  queryClient.setQueryData(qk.channels, channels);
  const subscriptions = createSubscriptions({ socket: fake.wire, queryClient });
  vi.spyOn(subscriptions, "resubscribeAll").mockResolvedValue();
  detachers.push(attachHandlers(fake.wire, { queryClient, subscriptions, onUnauthorized, notify: noNotify }));
  return { fake, queryClient, subscriptions, onUnauthorized };
}

const store = () => useUnread.getState();
const entry = (channelId = CH) => store().byConversation[convOf(channelId)];
const view = (channelId = CH) => {
  const e = entry(channelId);
  return e && { unread: e.unread, mentions: e.mentions };
};

/** 붙고 스냅숏을 받은 상태까지 */
async function connected(snapshot: UnreadSnapshot, channels?: Channel[]) {
  const server = stubUnread();
  server.reply(snapshot);
  const tab = setup(channels);
  tab.fake.serverEmit("connect");
  await waitFor(() => expect(store().ready).toBe(true));
  return { ...tab, server };
}

beforeEach(() => {
  store().reset();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const detach of detachers.splice(0)) detach();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("현황 스냅숏", () => {
  it("붙으면 GET /me/unread 를 받아 갈아 끼운다", async () => {
    await connected(snap(row({ unread: true, mentions: 2, latestSeq: 5 })));
    expect(view()).toEqual({ unread: true, mentions: 2 });
  });

  it("받지 못하면 굵게·배지를 끈다 — 토스트는 없다", async () => {
    const server = stubUnread();
    server.reply(json(500, { code: "INTERNAL", message: "boom" }));
    const { fake } = setup();
    fake.serverEmit("connect");
    await waitFor(() => expect(store().loading).toBe(false));
    expect(store().ready).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("401 이면 앱의 401 처리(로그인)로 — Query 밖 REST 라 전역 처리를 타지 않는다", async () => {
    const server = stubUnread();
    server.reply(json(401, { code: "UNAUTHORIZED", message: "no session" }));
    const { fake, onUnauthorized } = setup();
    fake.serverEmit("connect");
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(store().ready).toBe(false);
  });

  it("모양이 틀린 응답도 받지 못한 것으로 — 경계에서 파싱한다", async () => {
    const server = stubUnread();
    server.reply(json(200, { conversations: [{ conversationId: convOf(CH), unread: "yes" }], channels: [] }));
    const { fake } = setup();
    fake.serverEmit("connect");
    await waitFor(() => expect(store().loading).toBe(false));
    expect(store().ready).toBe(false);
  });

  it("끊기면 끄고, 다시 붙으면 다시 받는다 — 끊긴 사이 놓친 activity 가 쌓이지 않게", async () => {
    const { fake, server } = await connected(snap(row()));
    fake.serverEmit("disconnect", "transport close");
    expect(store().ready).toBe(false);
    server.reply(snap(row({ unread: true, latestSeq: 4 })));
    fake.serverEmit("connect");
    await waitFor(() => expect(view()).toEqual({ unread: true, mentions: 0 }));
    expect(server.calls()).toBe(2);
  });

  it("끊기기 전에 나간 요청의 응답은 늦게 와도 반영하지 않는다", async () => {
    const server = stubUnread();
    const { fake } = setup();
    fake.serverEmit("connect");
    await waitFor(() => expect(server.calls()).toBe(1));
    fake.serverEmit("disconnect", "transport close");
    server.release(snap(row({ unread: true })));
    await new Promise((r) => setTimeout(r, 20));
    expect(store().ready).toBe(false);
  });

  it("Review Focus 5 — 요청이 나가 있는 동안 온 activity 는 스냅숏에 든 것을 빼고 얹는다", async () => {
    const server = stubUnread();
    const { fake } = setup();
    fake.serverEmit("connect");
    await waitFor(() => expect(server.calls()).toBe(1));
    fake.serverEmit("channel.activity", activity(10, { mentionedUserIds: [USER] }));
    fake.serverEmit("channel.activity", activity(12, { mentionedUserIds: [USER] }));
    server.release(snap(row({ lastReadSeq: 9, latestSeq: 10, unread: true, mentions: 1 })));
    await waitFor(() => expect(store().ready).toBe(true));
    expect(view()).toEqual({ unread: true, mentions: 2 });
  });
});

describe("channel.activity", () => {
  it("다른 채널의 남의 글은 굵게, 나를 멘션하면 배지 — 내 글은 그대로", async () => {
    const { fake } = await connected(snap(row(), row({ channelId: CH2 })));
    fake.serverEmit("channel.activity", activity(1, { mentionedUserIds: [USER] }));
    fake.serverEmit("channel.activity", activity(1, { channelId: CH2, authorId: USER }));
    expect(view()).toEqual({ unread: true, mentions: 1 });
    expect(view(CH2)).toEqual({ unread: false, mentions: 0 });
  });

  it("보고 있는 세션(구독 중인 채널의 그 세션)의 끝이 보이면 더하지 않고, 끝이 안 보이면 굵게", async () => {
    const { fake, subscriptions } = await connected(snap(row()));
    vi.spyOn(subscriptions, "active").mockReturnValue(CH);
    setViewingAtEnd(convOf(CH), true);
    fake.serverEmit("channel.activity", activity(1));
    expect(view()).toEqual({ unread: false, mentions: 0 });
    setViewingAtEnd(convOf(CH), false);
    fake.serverEmit("channel.activity", activity(2));
    expect(view()).toEqual({ unread: true, mentions: 0 });
  });

  it("같은 채널의 다른 세션 글은 보고 있는 세션의 끝이 보여도 센다 — 그 세션은 보고 있지 않다", async () => {
    const { fake, subscriptions } = await connected(snap(row(), row({ conversationId: B })));
    vi.spyOn(subscriptions, "active").mockReturnValue(CH);
    setViewingAtEnd(convOf(CH), true);
    fake.serverEmit("channel.activity", activity(5, { conversationId: B, mentionedUserIds: [USER] }));
    fake.serverEmit("channel.activity", activity(6));
    expect(store().byConversation[B]).toMatchObject({ unread: true, mentions: 1 });
    expect(view()).toEqual({ unread: false, mentions: 0 });
  });

  it("Review Focus 4 — 방금 만든 채널(channel.created)의 첫 글은 항목을 만들고 굵게", async () => {
    const { fake } = await connected(snap(row()));
    fake.serverEmit("channel.created", { channel: channelOf(CH3) });
    fake.serverEmit("channel.activity", activity(1, { channelId: CH3 }));
    expect(entry(CH3)).toMatchObject({ lastReadSeq: 0, unread: true });
  });

  it("사이드바 목록에 없는 채널(보관한 채널 — 늦게 온 정본)의 activity 는 항목을 만들지 않는다", async () => {
    const { fake } = await connected(snap(row()));
    fake.serverEmit("channel.activity", activity(4, { channelId: CH3, mentionedUserIds: [USER] }));
    expect(entry(CH3)).toBeUndefined();
  });
});

describe("서버 conversation.read", () => {
  it("한 세션의 읽음은 같은 채널의 다른 세션을 지우지 않는다", async () => {
    const { fake } = await connected(
      snap(
        row({ unread: true, latestSeq: 8 }),
        row({ conversationId: B, unread: true, mentions: 1, latestSeq: 6 }),
      ),
    );
    fake.serverEmit("conversation.read", { conversationId: convOf(CH), channelId: CH, lastReadSeq: 8 });
    expect(view()).toEqual({ unread: false, mentions: 0 });
    expect(store().byConversation[B]).toMatchObject({ unread: true, mentions: 1, lastReadSeq: 0 });
  });

  it("Review Focus 1 — 가려진 탭도 다른 탭의 읽음을 받아 사이드바가 지워진다", async () => {
    const { fake } = await connected(snap(row({ unread: true, mentions: 3, latestSeq: 8 })));
    fake.serverEmit("conversation.read", { conversationId: convOf(CH), channelId: CH, lastReadSeq: 8 });
    expect(view()).toEqual({ unread: false, mentions: 0 });
    expect(entry(CH)?.lastReadSeq).toBe(8);
  });

  it("보관한 채널을 열어 읽은 것(목록 밖)은 항목을 만들지 않는다", async () => {
    const { fake } = await connected(snap(row()));
    fake.serverEmit("conversation.read", { conversationId: convOf(CH3), channelId: CH3, lastReadSeq: 4 });
    expect(entry(CH3)).toBeUndefined();
  });
});

describe("보관·보관 해제(channel.updated)", () => {
  it("보관하면 스냅숏을 다시 받는다 — 보관한 채널은 빠진다", async () => {
    const { fake, server } = await connected(snap(row(), row({ channelId: CH2 })));
    server.reply(snap(row({ channelId: CH2 })));
    fake.serverEmit("channel.updated", { channel: channelOf(CH, { archivedAt: ARCHIVED_AT }) });
    await waitFor(() => expect(entry(CH)).toBeUndefined());
    expect(server.calls()).toBe(2);
  });

  it("이 탭의 보관 응답이 먼저 캐시를 옮겼어도 다시 받는다", async () => {
    const { fake, server, queryClient } = await connected(snap(row(), row({ channelId: CH2 })));
    server.reply(snap(row({ channelId: CH2 })));
    const archived = channelOf(CH, { archivedAt: ARCHIVED_AT });
    applyChannel(queryClient, archived);
    fake.serverEmit("channel.updated", { channel: archived });
    await waitFor(() => expect(server.calls()).toBe(2));
  });

  it("보관 해제하면 다시 받아 읽음 위치가 그대로 돌아온다(0 으로 만든 항목이 아니다)", async () => {
    // CH 는 보관된 채널 — 스냅숏에도 사이드바 목록에도 없다
    const { fake, server, queryClient } = await connected(snap(row({ channelId: CH2 })), [channelOf(CH2)]);
    // 보관된 동안 온 늦은 정본 — 항목을 만들지 않는다
    fake.serverEmit("channel.activity", activity(8));
    server.reply(snap(row({ channelId: CH2 }), row({ lastReadSeq: 7, latestSeq: 8, unread: true })));
    applyChannel(queryClient, channelOf(CH));
    fake.serverEmit("channel.updated", { channel: channelOf(CH) });
    await waitFor(() => expect(entry(CH)?.lastReadSeq).toBe(7));
    expect(server.calls()).toBe(2);
  });

  it("새로 만든 빈 채널(channel.created)의 첫 channel.updated 는 다시 받지 않는다 — 현황이 그 채널을 안다", async () => {
    const { fake, server } = await connected(snap(row(), row({ channelId: CH2 })));
    fake.serverEmit("channel.created", { channel: channelOf(CH3) });
    fake.serverEmit("channel.updated", { channel: channelOf(CH3, { name: "renamed" }) });
    await new Promise((r) => setTimeout(r, 20));
    expect(server.calls()).toBe(1);
  });

  it("현황 요청이 나가 있는 동안 만든 채널도 받은 스냅숏 위에 얹는다", async () => {
    const server = stubUnread();
    const { fake } = setup();
    fake.serverEmit("connect");
    await waitFor(() => expect(server.calls()).toBe(1));
    fake.serverEmit("channel.created", { channel: channelOf(CH3) });
    server.release(snap(row()));
    await waitFor(() => expect(store().ready).toBe(true));
    expect(CH3 in store().channels).toBe(true);
  });

  it("보관과 상관없는 변경(이름 바꾸기)은 다시 받지 않는다", async () => {
    const { fake, server } = await connected(snap(row(), row({ channelId: CH2 })));
    fake.serverEmit("channel.updated", { channel: channelOf(CH, { name: "renamed" }) });
    await new Promise((r) => setTimeout(r, 20));
    expect(server.calls()).toBe(1);
  });
});
