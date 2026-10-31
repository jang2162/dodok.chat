import type { Channel, ChannelActivity, ConversationReadUpdate, UnreadSnapshot } from "@dodok/shared";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { isChannelArchived } from "@/features/channels/archived";

/** 배지가 세는 상한 — 서버도 여기서 자른다(읽지 않음 스펙 「계약」 장) */
export const MENTIONS_MAX = 99;

/**
 * 대화(세션) 하나의 현황 — 채널 세션 계획 태스크 7 이 단위를 채널에서 세션으로 옮겼다(seq 는 채널 하나의 번호라 채널 단위면 세션 A 의
 * 읽음이 B 를 덮는다). 사이드바의 채널 값은 그 채널 세션들을 합친다(`useChannelUnread`).
 * `seenSeq` 는 반영한 가장 큰 seq — 같은 신호가 두 번 오거나(재연결) 이미 읽은 범위의 신호가 늦게 와도 다시 세지 않는다. 늘
 * `lastReadSeq` 이상이다
 */
export type UnreadEntry = {
  channelId: string;
  lastReadSeq: number;
  seenSeq: number;
  unread: boolean;
  mentions: number;
};

/**
 * activity 가 온 때의 화면 사정. `viewing` 은 구독 중인 채널, `atEnd` 는 그 신호의 세션 타임라인 끝이 보이고 탭이 보이는가
 * (`setViewingAtEnd`), `listed` 는 사이드바 목록(보관 아님)에 있는 채널인가
 */
export type ActivityContext = {
  me: string | undefined;
  viewing: string | undefined;
  atEnd: boolean;
  listed: boolean;
};
export type ReadContext = { listed: boolean };

/** 스냅숏 요청이 나가 있는 동안 받은 신호 — 받은 때의 사정과 함께 두었다가 스냅숏 위에 다시 얹는다 */
type Buffered =
  | { kind: "activity"; activity: ChannelActivity; ctx: ActivityContext }
  | { kind: "read"; update: ConversationReadUpdate; ctx: ReadContext }
  | { kind: "channel"; channelId: string };

type UnreadState = {
  /** 스냅숏을 받았는가 — 아니면 굵게·배지를 그리지 않는다(틀린 배지보다 없는 배지) */
  ready: boolean;
  /** 스냅숏 요청이 나가 있다 — 그동안 신호는 `buffer` 에 */
  loading: boolean;
  /** 대화 id → 현황 */
  byConversation: Record<string, UnreadEntry>;
  /**
   * 스냅숏이 실은 보관하지 않은 채널(대화가 없는 채널 포함) — 보관·보관 해제가 현황에 반영됐는지 견준다(`needsResync`). 신호로 새
   * 세션 항목을 만든 채널과 스냅숏 뒤에 새로 만든 채널(`addChannel`)도 더한다
   */
  channels: Record<string, true>;
  buffer: Buffered[];
  beginSnapshot(): void;
  applySnapshot(s: UnreadSnapshot): void;
  failSnapshot(): void;
  applyActivity(a: ChannelActivity, ctx: ActivityContext): void;
  applyRead(u: ConversationReadUpdate, ctx: ReadContext): void;
  /**
   * 새로 만든 보관하지 않은 채널(`channel.created`) — 스냅숏이 아직 모르는 빈 채널이다. 더하지 않으면 그 채널의 첫 `channel.updated` 가
   * 보관 해제 전으로 읽혀(`needsResync`) 현황을 한 번 다시 받는다
   */
  addChannel(channelId: string): void;
  /** 로그아웃·401 */
  reset(): void;
};

type Entries = Record<string, UnreadEntry>;
type Known = Record<string, true>;

/**
 * 항목은 사이드바 목록에 있는 채널의 세션에만 새로 만든다. 보관한 채널에도 신호가 온다(늦게 온 정본·보관한 채널을 열어 읽기) —
 * 거기서 0 으로 만든 항목이 보관 해제 뒤 그대로 읽음 위치로 쓰이면 「새 메시지」 구분선이 세션 맨 앞에 그어진다.
 * 보관 해제 때는 스냅숏을 다시 받는다(`needsResync`). 목록에 있는 채널의 처음 보는 세션(스냅숏 뒤에 생긴 세션)은 0 부터다
 */
function entryFor(
  entries: Entries,
  conversationId: string,
  channelId: string,
  listed: boolean,
): UnreadEntry | undefined {
  return (
    entries[conversationId] ??
    (listed ? { channelId, lastReadSeq: 0, seenSeq: 0, unread: false, mentions: 0 } : undefined)
  );
}

type Tables = { byConversation: Entries; channels: Known };

const put = (t: Tables, conversationId: string, entry: UnreadEntry): Tables => ({
  byConversation: { ...t.byConversation, [conversationId]: entry },
  channels: entry.channelId in t.channels ? t.channels : { ...t.channels, [entry.channelId]: true },
});

function withActivity(t: Tables, a: ChannelActivity, ctx: ActivityContext): Tables {
  if (a.authorType === "user" && a.authorId === ctx.me) return t;
  const entry = entryFor(t.byConversation, a.conversationId, a.channelId, ctx.listed);
  if (!entry || a.seq <= entry.seenSeq) return t;
  let next: UnreadEntry = { ...entry, seenSeq: a.seq };
  // 보고 있는 세션의 끝이 보이면 읽음 전송이 맡는다 — 여기서 더하면 서버 읽음이 돌아오기 전까지 잠깐 굵어진다.
  // 같은 채널의 다른 세션 글은 더한다 — 그 세션은 보고 있지 않다
  if (!(ctx.viewing === a.channelId && ctx.atEnd)) {
    const mentioned = ctx.me !== undefined && a.mentionedUserIds.includes(ctx.me);
    next = {
      ...next,
      // 스레드 답글은 굵게 하지 않는다 — 스레드가 활발한 세션이 늘 굵어지지 않게(스펙 결정 5). 멘션은 어디서 왔든 센다
      unread: next.unread || a.threadRootId === undefined,
      mentions: mentioned ? Math.min(MENTIONS_MAX, next.mentions + 1) : next.mentions,
    };
  }
  return put(t, a.conversationId, next);
}

/** 서버가 저장한 읽음 위치(커지기만 함). 세션을 보면 그 seq 까지의 스레드 멘션도 읽음이다(스펙 결정 6) — 배지까지 지운다 */
function withRead(t: Tables, u: ConversationReadUpdate, ctx: ReadContext): Tables {
  const entry = entryFor(t.byConversation, u.conversationId, u.channelId, ctx.listed);
  if (!entry || (u.conversationId in t.byConversation && u.lastReadSeq <= entry.lastReadSeq)) return t;
  return put(t, u.conversationId, {
    channelId: entry.channelId,
    lastReadSeq: u.lastReadSeq,
    seenSeq: Math.max(entry.seenSeq, u.lastReadSeq),
    unread: false,
    mentions: 0,
  });
}

const withChannel = (t: Tables, channelId: string): Tables =>
  channelId in t.channels ? t : { ...t, channels: { ...t.channels, [channelId]: true } };

const replay = (t: Tables, b: Buffered): Tables =>
  b.kind === "activity"
    ? withActivity(t, b.activity, b.ctx)
    : b.kind === "read"
      ? withRead(t, b.update, b.ctx)
      : withChannel(t, b.channelId);

const INITIAL = { ready: false, loading: false, byConversation: {}, channels: {}, buffer: [] };

/**
 * 사용자 × 대화의 읽지 않음 현황(읽지 않음 스펙 「웹」 장, 단위는 세션). 연결될 때마다 `GET /me/unread` 스냅숏으로 통째로 갈아 끼우고,
 * 그 뒤는 wire `channel.activity`·`conversation.read` 로 더해 간다(realtime/handlers). 스냅숏 요청이 나가 있는 동안 온 신호는
 * 모아 두었다가 스냅숏 위에 다시 얹는다 — 스냅숏에 이미 든 activity(`seq ≤ latestSeq`)는 `seenSeq` 가 거른다
 */
export const useUnread = create<UnreadState>()((set) => ({
  ...INITIAL,
  // 다시 시작하면 앞 요청의 버퍼는 버린다 — 새 요청을 보내기 전에 받은 신호의 메시지는 새 스냅숏이 이미 담는다
  beginSnapshot: () => set({ loading: true, buffer: [] }),
  applySnapshot: (s) =>
    set((state) => {
      const fresh: Tables = {
        byConversation: Object.fromEntries(
          s.conversations.map((c) => [
            c.conversationId,
            {
              channelId: c.channelId,
              lastReadSeq: c.lastReadSeq,
              seenSeq: c.latestSeq,
              unread: c.unread,
              mentions: c.mentions,
            },
          ]),
        ),
        channels: Object.fromEntries(s.channels.map((id) => [id, true as const])),
      };
      return { ready: true, loading: false, buffer: [], ...state.buffer.reduce(replay, fresh) };
    }),
  failSnapshot: () => set({ ready: false, loading: false, buffer: [] }),
  applyActivity: (activity, ctx) =>
    set((s) =>
      s.loading
        ? { buffer: [...s.buffer, { kind: "activity", activity, ctx }] }
        : withActivity(s, activity, ctx),
    ),
  applyRead: (update, ctx) =>
    set((s) =>
      s.loading ? { buffer: [...s.buffer, { kind: "read", update, ctx }] } : withRead(s, update, ctx),
    ),
  addChannel: (channelId) =>
    set((s) =>
      s.loading ? { buffer: [...s.buffer, { kind: "channel", channelId }] } : withChannel(s, channelId),
    ),
  reset: () => {
    viewingAtEnd = undefined;
    set(INITIAL);
  },
}));

export type UnreadView = { unread: boolean; mentions: number };

/**
 * 사이드바 한 줄이 그리는 값 — 그 채널 세션들의 합(굵게 = 하나라도 안 읽음, 배지 = 세션 배지의 합을 `MENTIONS_MAX` 에서 자른 것).
 * 스냅숏을 받기 전·실패·끊김이면 null — 굵게·배지를 그리지 않는다
 */
export function useChannelUnread(channelId: string): UnreadView | null {
  return useUnread(
    useShallow((s) => {
      if (!s.ready) return null;
      let unread = false;
      let mentions = 0;
      for (const e of Object.values(s.byConversation)) {
        if (e.channelId !== channelId) continue;
        unread ||= e.unread;
        mentions += e.mentions;
      }
      return { unread, mentions: Math.min(MENTIONS_MAX, mentions) };
    }),
  );
}

/**
 * 세션 목록 한 줄이 그리는 값(그 세션의 점·배지). 규칙은 `useChannelUnread` 와 같다 — 스냅숏 전·실패·끊김이면 null, 항목이 없는 세션
 * (받은 적 없는 세션·새 세션 창)은 안 읽은 것이 없다. 줄(`ConversationItem`)이 직접 부른다 — 다른 채널·다른 세션의 활동·읽음은 이 줄도,
 * 세션 화면도 다시 그리지 않는다(값이 같으면 `useShallow` 가 막는다)
 */
export function useConversationUnread(conversationId: string): UnreadView | null {
  return useUnread(useShallow((s) => (s.ready ? viewOf(s.byConversation, conversationId) : null)));
}

const viewOf = (entries: Record<string, UnreadEntry>, conversationId: string): UnreadView => ({
  unread: entries[conversationId]?.unread ?? false,
  mentions: entries[conversationId]?.mentions ?? 0,
});

/** 타임라인의 끝이 보이고 탭이 보이는 세션(없으면 undefined) — 세션 목록이 알리고 activity 처리가 읽는다 */
let viewingAtEnd: string | undefined;

export function setViewingAtEnd(conversationId: string, atEnd: boolean): void {
  if (atEnd) viewingAtEnd = conversationId;
  else if (viewingAtEnd === conversationId) viewingAtEnd = undefined;
}

export const isViewingAtEnd = (conversationId: string): boolean => viewingAtEnd === conversationId;

/**
 * 바뀐 채널의 보관 상태가 현황과 어긋나는가 — 그러면 스냅숏을 다시 받는다. 스냅숏은 보관하지 않은 채널(`channels`)만 싣고 activity 는
 * 목록 밖 채널에 항목을 만들지 않으므로, 보관한 채널이 현황에 있거나 보관하지 않은 채널이 없으면 보관·보관 해제가 아직 반영되지 않은
 * 것이다. 세션 항목이 아니라 채널 목록과 견준다 — 세션이 하나도 없는 빈 채널을 보관 해제 전으로 읽지 않게.
 * 캐시 대신 현황과 견준다 — 이 탭의 보관 응답이 캐시를 먼저 옮겨도 놓치지 않게.
 * 요청이 나가 있으면 늘 다시 받는다(나가 있는 응답이 바뀌기 전 것일 수 있다). 받은 적이 없으면 다음 연결이 받는다
 */
export function needsResync(channel: Pick<Channel, "id" | "archivedAt">): boolean {
  const { ready, loading, channels } = useUnread.getState();
  if (loading) return true;
  if (!ready) return false;
  return isChannelArchived(channel) === channel.id in channels;
}
