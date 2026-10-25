import type { Query, QueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queries";
import { emptyTimeline, NEW_CONVERSATION, type Timeline } from "@/features/messages/timeline";

/** `["timeline", channelId, conversationId]` 캐시(채널 세션 계획 판정 PS6). 없으면 그 세션을 아직 받은 적이 없다 */
export const getTimeline = (
  qc: QueryClient,
  channelId: string,
  conversationId: string,
): Timeline | undefined => qc.getQueryData<Timeline>(qk.timeline(channelId, conversationId));

/**
 * 캐시를 고친다 — 없으면 `emptyTimeline()` 에서 시작한다. 이 탭이 만든 변경(보내는 중 항목·보낸 메시지의 확정)이 쓴다.
 * 서버에서 온 것은 `patchTimeline` — 받은 적 없는 세션에 글 몇 개만 두면 그 세션을 열 때 빈 곳이 있는 목록을 온전한 것처럼 보인다.
 * 타임라인을 REST 로 받는 중(`withTimelineEdits`)이면 변경을 모아 두었다가 받은 결과에 다시 적용한다 — 그래서 `fn` 도
 * `updateThread` 의 것처럼 새 결과에 다시 적용돼도 맞아야 한다
 */
export function updateTimeline(
  qc: QueryClient,
  channelId: string,
  conversationId: string,
  fn: (t: Timeline) => Timeline,
): void {
  logEdit(qc, timelineSlot(channelId, conversationId), fn);
  qc.setQueryData<Timeline>(qk.timeline(channelId, conversationId), (prev) => fn(prev ?? emptyTimeline()));
}

/**
 * 세션 타임라인을 고친다 — **있을 때만**(wire 이벤트·재동기화). 다른 세션을 보고 있는 동안 온 글은 그 세션의 캐시가 있으면 넣고,
 * 없으면 버린다 — 그 세션을 열 때 REST 로 받는다. 다만 REST 로 받는 중이면 캐시가 없어도 변경을 모아 받은 결과에 다시 적용한다
 * (`updateThread` 와 같은 까닭 — 받는 사이 wire 로 온 글은 채널 커서만 올려 두므로 여기서 버리면 빈틈 복구로도 돌아오지 않는다)
 */
export function patchTimeline(
  qc: QueryClient,
  channelId: string,
  conversationId: string,
  fn: (t: Timeline) => Timeline,
): void {
  logEdit(qc, timelineSlot(channelId, conversationId), fn);
  if (!getTimeline(qc, channelId, conversationId)) return;
  qc.setQueryData<Timeline>(qk.timeline(channelId, conversationId), (prev) => (prev ? fn(prev) : prev));
}

/** `["thread", channelId, conversationId, rootId]` 캐시 — 스레드를 연 적이 있을 때만 있다(REST 로 채운다) */
export const getThread = (
  qc: QueryClient,
  channelId: string,
  conversationId: string,
  rootId: string,
): Timeline | undefined => qc.getQueryData<Timeline>(qk.thread(channelId, conversationId, rootId));

type TimelineEdit = (t: Timeline) => Timeline;
/** 타임라인·스레드를 REST 로 받는 중인 요청마다 그동안 온 변경 — 클라이언트·캐시별(`withThreadEdits`·`withTimelineEdits`) */
const inFlight = new WeakMap<QueryClient, Map<string, Set<TimelineEdit[]>>>();
const timelineSlot = (channelId: string, conversationId: string) => `timeline/${channelId}/${conversationId}`;
const threadSlot = (channelId: string, conversationId: string, rootId: string) =>
  `thread/${channelId}/${conversationId}/${rootId}`;

function logEdit(qc: QueryClient, slot: string, fn: TimelineEdit): void {
  for (const log of inFlight.get(qc)?.get(slot) ?? []) log.push(fn);
}

/**
 * 스레드 캐시를 고친다 — **있을 때만**. 연 적 없는 스레드의 답글은 버린다(루트의 요약이 칩을 맞춘다):
 * 한 페이지도 받지 않은 스레드에 답글 몇 개만 두면 그 스레드를 열 때 빈 곳이 있는 목록을 온전한 것처럼 보인다.
 * 다만 그 스레드를 REST 로 받는 중이면 캐시가 없어도 변경을 모아 두었다가 받은 페이지에 다시 적용한다(`withThreadEdits`) —
 * 받는 사이 wire 로 온 답글은 채널 커서만 올려 두므로 여기서 버리면 빈틈 복구로도 돌아오지 않는다.
 * 그래서 `fn` 은 새 페이지에 다시 적용돼도 맞아야 한다(과거 페이지 붙이기는 가장 옛 답글이 같을 때만 붙인다, `useOlderPages`)
 */
export function updateThread(
  qc: QueryClient,
  channelId: string,
  conversationId: string,
  rootId: string,
  fn: TimelineEdit,
): void {
  logEdit(qc, threadSlot(channelId, conversationId, rootId), fn);
  if (!getThread(qc, channelId, conversationId, rootId)) return;
  qc.setQueryData<Timeline>(qk.thread(channelId, conversationId, rootId), (prev) => (prev ? fn(prev) : prev));
}

/**
 * 스레드 페이지를 받는 동안 온 `updateThread` 변경을 받은 결과에 차례로 다시 적용한다(p4t-t6 리뷰 I1) — 첫 열기(캐시 없음)와
 * 다시 받기(옛 캐시를 새 페이지가 통째로 바꾼다) 둘 다. 스냅숏이 이미 가진 것은 upsert 가 같은 것으로 덮을 뿐이다
 */
export const withThreadEdits = (
  qc: QueryClient,
  channelId: string,
  conversationId: string,
  rootId: string,
  load: () => Promise<Timeline>,
): Promise<Timeline> => withEdits(qc, threadSlot(channelId, conversationId, rootId), load);

/** 세션 타임라인판 `withThreadEdits` — 첫 페이지·결과로 가기·아래로 이어 받기가 받는 사이 wire 로 온 변경을 잃지 않게 */
export const withTimelineEdits = (
  qc: QueryClient,
  channelId: string,
  conversationId: string,
  load: () => Promise<Timeline>,
): Promise<Timeline> => withEdits(qc, timelineSlot(channelId, conversationId), load);

async function withEdits(qc: QueryClient, slot: string, load: () => Promise<Timeline>): Promise<Timeline> {
  let bySlot = inFlight.get(qc);
  if (!bySlot) inFlight.set(qc, (bySlot = new Map()));
  let logs = bySlot.get(slot);
  if (!logs) bySlot.set(slot, (logs = new Set()));
  const log: TimelineEdit[] = [];
  logs.add(log);
  try {
    const t = await load();
    return log.reduce((acc, fn) => fn(acc), t);
  } finally {
    logs.delete(log);
    if (logs.size === 0) bySlot.delete(slot);
  }
}

/** 그 채널에서 본 가장 큰 seq(`qk.channelSeq`) — 없으면 이 연결에서 아직 구독하지 않았다 */
export const getChannelSeq = (qc: QueryClient, channelId: string): number | undefined =>
  qc.getQueryData<number>(qk.channelSeq(channelId));

/** 커서를 그 값으로 둔다 — 구독 ack(`latestSeq`)가 쓴다 */
export const setChannelSeq = (qc: QueryClient, channelId: string, seq: number): void =>
  void qc.setQueryData<number>(qk.channelSeq(channelId), seq);

/** 커서를 올린다(내리지 않는다) — 구독한 적 없는 채널이면 그대로 둔다 */
export function noteChannelSeq(qc: QueryClient, channelId: string, seq: number): void {
  const seen = getChannelSeq(qc, channelId);
  if (seen !== undefined && seq > seen) setChannelSeq(qc, channelId, seq);
}

/** 새 세션 창의 캐시 — 받을 것이 없어 낡게 두거나 버리지 않는다(보내는 중 항목만 든다) */
const isNewWindow = (q: Query) => q.queryKey[0] === "timeline" && q.queryKey[2] === NEW_CONVERSATION;

/**
 * 그 채널의 세션 타임라인·스레드를 낡은 것으로 둔다 — 지금 보는 것은 곧바로 다시 받고(`refetchType: "active"`), 나머지는 다시 열 때
 * 받는다. 처음 구독(커서 없음)에서 부른다: 사본에서 복원했거나 이 연결 전에 받아 둔 캐시는 그 사이의 글을 모른다
 */
export function staleChannelCaches(qc: QueryClient, channelId: string): void {
  const predicate = (q: Query) => !isNewWindow(q);
  void qc.invalidateQueries({ queryKey: qk.channelTimelines(channelId), predicate }).catch(() => undefined);
  void qc.invalidateQueries({ queryKey: qk.channelThreads(channelId) }).catch(() => undefined);
}

/**
 * 재동기화가 넘쳤다(`hasMore` — 채널 세션 계획 Review Focus 5): 끊긴 사이의 글이 여러 세션에 흩어져 200 을 넘었다. 그 채널의 세션
 * 타임라인·스레드 캐시를 모두 버린다 — 보고 있는 것(관찰자가 있다)만 곧바로 다시 받고, 다른 세션은 열 때 받는다.
 * 보내는 중 항목이 있는 캐시는 지우지 않고 낡은 것으로만 둔다 — 지우면 아직 ack 를 기다리는 항목이 화면에서 사라진다
 */
export function dropChannelCaches(qc: QueryClient, channelId: string): void {
  const cache = qc.getQueryCache();
  const queries = [
    ...cache.findAll({ queryKey: qk.channelTimelines(channelId) }),
    ...cache.findAll({ queryKey: qk.channelThreads(channelId) }),
  ];
  for (const q of queries) {
    if (isNewWindow(q)) continue;
    const pending = (q.state.data as Timeline | undefined)?.pending.length ?? 0;
    if (q.getObserversCount() > 0 || pending > 0)
      void qc.invalidateQueries({ queryKey: q.queryKey, exact: true }).catch(() => undefined);
    else qc.removeQueries({ queryKey: q.queryKey, exact: true });
  }
}
