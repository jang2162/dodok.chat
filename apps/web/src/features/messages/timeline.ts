import type { Attachment, Message } from "@dodok/shared";

export type PendingState = "sending" | "failed";
export type PendingMessage = {
  clientMsgId: string;
  channelId: string;
  bodyMd: string;
  createdAt: string;
  state: PendingState;
  /** 올려 둔 첨부 — 다시 보내기도 같은 id 로 간다 */
  attachments?: Attachment[];
  /** `failed` 의 사유 — 레이트리밋(ack RATE_LIMITED)이면 다른 문구를 보인다. 없으면 일반 실패 */
  reason?: PendingFailReason;
};
/** `channel_archived` 는 보관한 채널에 보낸 것 — 다시 보내도 같은 409 라 「다시 보내기」를 두지 않는다 */
export type PendingFailReason = "rate_limited" | "channel_archived";
/**
 * 확정 메시지(seq 오름차순)와 보내는 중 항목. 보내는 중 항목은 항상 목록 끝에 그린다(스펙 4.3-6).
 * `hasNewer` 는 결과로 가기(`around`)로 받은 떨어진 창이다 — 창 뒤에 받지 않은 메시지가 있다. 그동안 `lastSeq` 는 창의 끝이
 * 아니라 wire 로 본 채널의 끝이고(빈틈 판단은 그대로), 창보다 새 메시지는 목록에 넣지 않는다(`upsertMany`)
 */
export type Timeline = {
  items: Message[];
  pending: PendingMessage[];
  hasOlder: boolean;
  lastSeq: number;
  hasNewer?: boolean;
};

export const emptyTimeline = (): Timeline => ({ items: [], pending: [], hasOlder: false, lastSeq: 0 });

const bySeq = (a: Message, b: Message) => a.seq - b.seq;
const maxSeq = (items: readonly Message[]) => items.reduce((m, x) => Math.max(m, x.seq), 0);

function merge(base: Message[], incoming: readonly Message[]): Message[] {
  if (incoming.length === 0) return base;
  const byId = new Map(base.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort(bySeq);
}

function dropConfirmed(pending: PendingMessage[], incoming: readonly Message[]): PendingMessage[] {
  const done = new Set(incoming.flatMap((m) => (m.clientMsgId ? [m.clientMsgId] : [])));
  return done.size === 0 ? pending : pending.filter((p) => !done.has(p.clientMsgId));
}

/** 입장(lastSeq 없는 channel.subscribe) — 최근 페이지로 새로 시작한다. 보내는 중 항목은 유지 */
export function fromLatest(
  prev: Timeline | undefined,
  messages: readonly Message[],
  hasOlder: boolean,
): Timeline {
  const items = [...messages].sort(bySeq);
  return { items, pending: dropConfirmed(prev?.pending ?? [], items), hasOlder, lastSeq: maxSeq(items) };
}

/** 과거 페이지(`beforeSeq`)를 앞에 붙인다. lastSeq 는 그대로 */
export function prependOlder(t: Timeline, older: readonly Message[], hasOlder: boolean): Timeline {
  return { ...t, items: merge(t.items, older), hasOlder };
}

/**
 * message.created·updated, 전송 ack, 빈틈 메우기 페이지. 떨어진 창(`hasNewer`)이면 창 안(가장 새 항목의 seq 이하)만
 * 넣는다 — 창 뒤에 하나만 붙이면 그 사이의 빈 곳이 보이지 않은 채 이어진 목록처럼 보인다. 나머지는 아래로
 * 이어 받을 때(`appendNewer`) 온다
 */
export function upsertMany(t: Timeline, incoming: readonly Message[]): Timeline {
  if (incoming.length === 0) return t;
  const newest = t.items.at(-1)?.seq ?? 0;
  const kept = t.hasNewer ? incoming.filter((m) => m.seq <= newest) : incoming;
  return {
    ...t,
    items: merge(t.items, kept),
    pending: dropConfirmed(t.pending, incoming),
    lastSeq: Math.max(t.lastSeq, maxSeq(incoming)),
  };
}
export const upsert = (t: Timeline, m: Message): Timeline => upsertMany(t, [m]);

/**
 * 이 메시지 앞에 빠진 seq 가 있는가 — 있으면 lastSeq 로 다시 구독한다. 처음(lastSeq 0)·이미 가진 것은 빈틈이 아니다.
 * 채널 타임라인은 루트만 들지만 답글도 채널 seq 를 같이 쓴다 — 답글이 오면 `noteSeq` 로 lastSeq 를 올려 두어야
 * 다음 루트가 거짓 빈틈이 되지 않는다
 */
export function hasGap(t: Timeline, m: Message): boolean {
  return t.lastSeq > 0 && m.seq > t.lastSeq + 1 && !t.items.some((x) => x.id === m.id);
}

/** 채널 타임라인에 넣지 않는 메시지의 seq(스레드 답글)를 본 것으로 기록한다 */
export function noteSeq(t: Timeline, seq: number): Timeline {
  return seq > t.lastSeq ? { ...t, lastSeq: seq } : t;
}

const isRoot = (m: Message) => m.threadRootId === undefined;

/** 재동기화 응답(루트·답글이 섞였다)을 채널 타임라인에 — 루트는 병합하고 답글은 seq 만 기록한다 */
export function applyToChannel(t: Timeline, incoming: readonly Message[]): Timeline {
  return noteSeq(upsertMany(t, incoming.filter(isRoot)), maxSeq(incoming));
}

/**
 * 이미 가진 루트만 갈아 끼운다 — 재동기화 ack 의 `threadRoots`(끊긴 사이 바뀐 옛 루트의 요약). 적재 범위 밖의 루트는
 * 넣지 않는다(과거 페이지가 가장 옛 seq 를 기준으로 삼는다)
 */
export function refreshRoots(t: Timeline, roots: readonly Message[]): Timeline {
  const byId = new Map(roots.map((m) => [m.id, m]));
  if (!t.items.some((m) => byId.has(m.id))) return t;
  return { ...t, items: t.items.map((m) => byId.get(m.id) ?? m) };
}

/** 이 스레드의 것(루트와 그 답글)만 */
export const inThread = (rootId: string, incoming: readonly Message[]): Message[] =>
  incoming.filter((m) => m.id === rootId || m.threadRootId === rootId);

/**
 * 스레드 타임라인 — 루트와 답글을 seq 순으로 한 목록에 둔다. 루트는 스레드에서 가장 옛 메시지라 늘 맨 앞이고,
 * 페이지가 거기까지 닿지 않아도 넣는다(REST 가 `root` 를 따로 싣는다). 보내는 중 항목은 유지한다
 */
export function threadFromPage(
  prev: Timeline | undefined,
  root: Message,
  messages: readonly Message[],
  hasOlder: boolean,
): Timeline {
  return fromLatest(prev, [root, ...messages.filter((m) => m.id !== root.id)], hasOlder);
}

/** REST around 페이지(`?around=<seq>`) — 그 seq 앞뒤 절반씩. `hasMoreAfter` 는 더 새것이 있다 */
export type AroundPage = { messages: readonly Message[]; hasMore: boolean; hasMoreAfter?: boolean };

/**
 * 결과로 가기(스레드·검색 스펙 5.3) — 타임라인을 around 페이지로 갈아 끼운다. 더 새것이 있으면 떨어진 창(`hasNewer`),
 * 끝까지 닿았으면 받는 사이 새로 온 것(페이지보다 새것)을 남겨 이어진 목록이다. `lastSeq` 는 내려가지 않는다 — 루트만 든
 * 페이지의 가장 새 seq 로 내리면 그 뒤 답글·루트가 거짓 빈틈이 된다. 보내는 중 항목은 유지
 */
export function jumpAround(prev: Timeline, page: AroundPage): Timeline {
  const items = [...page.messages].sort(bySeq);
  const newest = maxSeq(items);
  const lastSeq = Math.max(prev.lastSeq, newest);
  if (page.hasMoreAfter) return { ...prev, items, hasOlder: page.hasMore, hasNewer: true, lastSeq };
  const arrived = prev.hasNewer ? [] : prev.items.filter((m) => m.seq > newest);
  return { ...prev, items: merge(items, arrived), hasOlder: page.hasMore, hasNewer: false, lastSeq };
}

/** 스레드판 `jumpAround` — 루트는 페이지가 거기까지 닿지 않아도 늘 맨 앞(`threadFromPage` 와 같다) */
export function threadAround(prev: Timeline | undefined, root: Message, page: AroundPage): Timeline {
  const base = prev ?? emptyTimeline();
  const t = jumpAround(base, { ...page, messages: page.messages.filter((m) => m.id !== root.id) });
  return { ...t, items: [root, ...t.items.filter((m) => m.id !== root.id)] };
}

/** 떨어진 창의 아래로 이어 받기(`afterSeq`) — 창 밖이어도 붙인다. 더 없으면 창이 끝에 닿았다 */
export function appendNewer(t: Timeline, newer: readonly Message[], hasMore: boolean): Timeline {
  return {
    ...t,
    items: merge(t.items, newer),
    pending: dropConfirmed(t.pending, newer),
    hasNewer: hasMore,
    lastSeq: Math.max(t.lastSeq, maxSeq(newer)),
  };
}

/** 같은 clientMsgId 가 있으면 빼고 끝에 다시 넣는다(다시 보내기) */
export function addPending(t: Timeline, p: PendingMessage): Timeline {
  return { ...t, pending: [...t.pending.filter((x) => x.clientMsgId !== p.clientMsgId), p] };
}
/** 상태를 바꾸며 사유를 새로 둔다 — `reason` 을 주지 않으면 지난 사유를 지운다(다시 보내는 중에는 사유가 없다) */
export function setPendingState(
  t: Timeline,
  clientMsgId: string,
  state: PendingState,
  reason?: PendingFailReason,
): Timeline {
  return {
    ...t,
    pending: t.pending.map((p) => {
      if (p.clientMsgId !== clientMsgId) return p;
      const { reason: _, ...rest } = p;
      return reason === undefined ? { ...rest, state } : { ...rest, state, reason };
    }),
  };
}
export function removePending(t: Timeline, clientMsgId: string): Timeline {
  return { ...t, pending: t.pending.filter((p) => p.clientMsgId !== clientMsgId) };
}
