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
};
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

/** 이 메시지 앞에 빠진 seq 가 있는가 — 있으면 lastSeq 로 다시 구독한다. 처음(lastSeq 0)·이미 가진 것은 빈틈이 아니다 */
export function hasGap(t: Timeline, m: Message): boolean {
  return t.lastSeq > 0 && m.seq > t.lastSeq + 1 && !t.items.some((x) => x.id === m.id);
}

/** 같은 clientMsgId 가 있으면 빼고 끝에 다시 넣는다(다시 보내기) */
export function addPending(t: Timeline, p: PendingMessage): Timeline {
  return { ...t, pending: [...t.pending.filter((x) => x.clientMsgId !== p.clientMsgId), p] };
}
export function setPendingState(t: Timeline, clientMsgId: string, state: PendingState): Timeline {
  return { ...t, pending: t.pending.map((p) => (p.clientMsgId === clientMsgId ? { ...p, state } : p)) };
}
export function removePending(t: Timeline, clientMsgId: string): Timeline {
  return { ...t, pending: t.pending.filter((p) => p.clientMsgId !== clientMsgId) };
}
