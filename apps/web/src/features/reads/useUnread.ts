import type { Channel, ChannelActivity, ChannelReadUpdate, UnreadSnapshot } from "@dodok/shared";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { isChannelArchived } from "@/features/channels/archived";

/** 배지가 세는 상한 — 서버도 여기서 자른다(읽지 않음 스펙 「계약」 장) */
const MENTIONS_MAX = 99;

/**
 * 채널 하나의 현황. `seenSeq` 는 반영한 가장 큰 seq — 같은 신호가 두 번 오거나(재연결) 이미 읽은 범위의 신호가 늦게 와도
 * 다시 세지 않는다. 늘 `lastReadSeq` 이상이다
 */
export type UnreadEntry = { lastReadSeq: number; seenSeq: number; unread: boolean; mentions: number };

/**
 * activity 가 온 때의 화면 사정. `viewing` 은 구독 중인 채널, `atEnd` 는 그 채널 타임라인의 끝이 보이고 탭이 보이는가
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
  | { kind: "read"; update: ChannelReadUpdate; ctx: ReadContext };

type UnreadState = {
  /** 스냅숏을 받았는가 — 아니면 굵게·배지를 그리지 않는다(틀린 배지보다 없는 배지) */
  ready: boolean;
  /** 스냅숏 요청이 나가 있다 — 그동안 신호는 `buffer` 에 */
  loading: boolean;
  byChannel: Record<string, UnreadEntry>;
  buffer: Buffered[];
  beginSnapshot(): void;
  applySnapshot(s: UnreadSnapshot): void;
  failSnapshot(): void;
  applyActivity(a: ChannelActivity, ctx: ActivityContext): void;
  applyRead(u: ChannelReadUpdate, ctx: ReadContext): void;
  /** 로그아웃·401 */
  reset(): void;
};

type Entries = Record<string, UnreadEntry>;

/**
 * 항목은 사이드바 목록에 있는 채널에만 새로 만든다. 보관한 채널에도 신호가 온다(늦게 온 정본·보관한 채널을 열어 읽기) —
 * 거기서 0 으로 만든 항목이 보관 해제 뒤 그대로 읽음 위치로 쓰이면 「새 메시지」 구분선이 채널 맨 앞에 그어진다.
 * 보관 해제 때는 스냅숏을 다시 받는다(`needsResync`)
 */
function entryFor(byChannel: Entries, channelId: string, listed: boolean): UnreadEntry | undefined {
  return (
    byChannel[channelId] ?? (listed ? { lastReadSeq: 0, seenSeq: 0, unread: false, mentions: 0 } : undefined)
  );
}

function withActivity(byChannel: Entries, a: ChannelActivity, ctx: ActivityContext): Entries {
  if (a.authorType === "user" && a.authorId === ctx.me) return byChannel;
  const entry = entryFor(byChannel, a.channelId, ctx.listed);
  if (!entry || a.seq <= entry.seenSeq) return byChannel;
  let next: UnreadEntry = { ...entry, seenSeq: a.seq };
  // 보고 있는 채널의 끝이 보이면 읽음 전송이 맡는다 — 여기서 더하면 서버 읽음이 돌아오기 전까지 잠깐 굵어진다
  if (!(ctx.viewing === a.channelId && ctx.atEnd)) {
    const mentioned = ctx.me !== undefined && a.mentionedUserIds.includes(ctx.me);
    next = {
      ...next,
      // 스레드 답글은 굵게 하지 않는다 — 스레드가 활발한 채널이 늘 굵어지지 않게(스펙 결정 5). 멘션은 어디서 왔든 센다
      unread: next.unread || a.threadRootId === undefined,
      mentions: mentioned ? Math.min(MENTIONS_MAX, next.mentions + 1) : next.mentions,
    };
  }
  return { ...byChannel, [a.channelId]: next };
}

/** 서버가 저장한 읽음 위치(커지기만 함). 채널을 보면 그 seq 까지의 스레드 멘션도 읽음이다(스펙 결정 6) — 배지까지 지운다 */
function withRead(byChannel: Entries, u: ChannelReadUpdate, ctx: ReadContext): Entries {
  const entry = entryFor(byChannel, u.channelId, ctx.listed);
  if (!entry || (u.channelId in byChannel && u.lastReadSeq <= entry.lastReadSeq)) return byChannel;
  return {
    ...byChannel,
    [u.channelId]: {
      lastReadSeq: u.lastReadSeq,
      seenSeq: Math.max(entry.seenSeq, u.lastReadSeq),
      unread: false,
      mentions: 0,
    },
  };
}

const replay = (byChannel: Entries, b: Buffered): Entries =>
  b.kind === "activity" ? withActivity(byChannel, b.activity, b.ctx) : withRead(byChannel, b.update, b.ctx);

const INITIAL = { ready: false, loading: false, byChannel: {}, buffer: [] };

/**
 * 사용자 × 채널의 읽지 않음 현황(읽지 않음 스펙 「웹」 장). 연결될 때마다 `GET /me/unread` 스냅숏으로 통째로 갈아 끼우고,
 * 그 뒤는 wire `channel.activity`·`channel.read` 로 더해 간다(realtime/handlers). 스냅숏 요청이 나가 있는 동안 온 신호는
 * 모아 두었다가 스냅숏 위에 다시 얹는다 — 스냅숏에 이미 든 activity(`seq ≤ latestSeq`)는 `seenSeq` 가 거른다
 */
export const useUnread = create<UnreadState>()((set) => ({
  ...INITIAL,
  // 다시 시작하면 앞 요청의 버퍼는 버린다 — 새 요청을 보내기 전에 받은 신호의 메시지는 새 스냅숏이 이미 담는다
  beginSnapshot: () => set({ loading: true, buffer: [] }),
  applySnapshot: (s) =>
    set((state) => {
      const fresh: Entries = Object.fromEntries(
        s.channels.map((c) => [
          c.channelId,
          { lastReadSeq: c.lastReadSeq, seenSeq: c.latestSeq, unread: c.unread, mentions: c.mentions },
        ]),
      );
      return { ready: true, loading: false, buffer: [], byChannel: state.buffer.reduce(replay, fresh) };
    }),
  failSnapshot: () => set({ ready: false, loading: false, buffer: [] }),
  applyActivity: (activity, ctx) =>
    set((s) =>
      s.loading
        ? { buffer: [...s.buffer, { kind: "activity", activity, ctx }] }
        : { byChannel: withActivity(s.byChannel, activity, ctx) },
    ),
  applyRead: (update, ctx) =>
    set((s) =>
      s.loading
        ? { buffer: [...s.buffer, { kind: "read", update, ctx }] }
        : { byChannel: withRead(s.byChannel, update, ctx) },
    ),
  reset: () => {
    viewingAtEnd = undefined;
    set(INITIAL);
  },
}));

/** 사이드바 한 줄이 그리는 값. 스냅숏을 받기 전·실패·끊김이면 null — 굵게·배지를 그리지 않는다 */
export function useChannelUnread(channelId: string): { unread: boolean; mentions: number } | null {
  return useUnread(
    useShallow((s) =>
      s.ready
        ? { unread: s.byChannel[channelId]?.unread ?? false, mentions: s.byChannel[channelId]?.mentions ?? 0 }
        : null,
    ),
  );
}

/** 타임라인의 끝이 보이고 탭이 보이는 채널(없으면 undefined) — 채널 목록이 알리고 activity 처리가 읽는다 */
let viewingAtEnd: string | undefined;

export function setViewingAtEnd(channelId: string, atEnd: boolean): void {
  if (atEnd) viewingAtEnd = channelId;
  else if (viewingAtEnd === channelId) viewingAtEnd = undefined;
}

export const isViewingAtEnd = (channelId: string): boolean => viewingAtEnd === channelId;

/**
 * 바뀐 채널의 보관 상태가 현황과 어긋나는가 — 그러면 스냅숏을 다시 받는다. 스냅숏은 보관하지 않은 채널만 싣고 activity 는
 * 목록 밖 채널에 항목을 만들지 않으므로, 보관한 채널에 항목이 있거나 보관하지 않은 채널에 항목이 없으면 보관·보관 해제가 아직
 * 반영되지 않은 것이다. 캐시 대신 현황과 견준다 — 이 탭의 보관 응답이 캐시를 먼저 옮겨도 놓치지 않게.
 * 요청이 나가 있으면 늘 다시 받는다(나가 있는 응답이 바뀌기 전 것일 수 있다). 받은 적이 없으면 다음 연결이 받는다
 */
export function needsResync(channel: Pick<Channel, "id" | "archivedAt">): boolean {
  const { ready, loading, byChannel } = useUnread.getState();
  if (loading) return true;
  if (!ready) return false;
  return isChannelArchived(channel) === channel.id in byChannel;
}
