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
export type PendingFailReason = "rate_limited";
/** 확정 메시지(seq 오름차순)와 보내는 중 항목. 보내는 중 항목은 항상 목록 끝에 그린다(스펙 4.3-6) */
export type Timeline = { items: Message[]; pending: PendingMessage[]; hasOlder: boolean; lastSeq: number };

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

/** message.created·updated, 전송 ack, 빈틈 메우기 페이지 */
export function upsertMany(t: Timeline, incoming: readonly Message[]): Timeline {
  if (incoming.length === 0) return t;
  return {
    ...t,
    items: merge(t.items, incoming),
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
