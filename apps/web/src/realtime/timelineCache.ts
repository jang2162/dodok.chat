import type { QueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queries";
import { emptyTimeline, type Timeline } from "@/features/messages/timeline";

/** `["timeline", channelId]` 캐시(스펙 4.3). 없으면 그 채널에 아직 들어간 적이 없다 */
export const getTimeline = (qc: QueryClient, channelId: string): Timeline | undefined =>
  qc.getQueryData<Timeline>(qk.timeline(channelId));

/**
 * 캐시를 고친다. 없으면 `emptyTimeline()` 에서 시작한다. 타임라인을 REST 로 갈아 끼우는 중(`withTimelineEdits`)이면
 * 변경을 모아 두었다가 받은 결과에 다시 적용한다 — 그래서 `fn` 도 `updateThread` 의 것처럼 새 결과에 다시 적용돼도 맞아야 한다
 */
export function updateTimeline(qc: QueryClient, channelId: string, fn: (t: Timeline) => Timeline): void {
  logEdit(qc, channelSlot(channelId), fn);
  qc.setQueryData<Timeline>(qk.timeline(channelId), (prev) => fn(prev ?? emptyTimeline()));
}

/** `["thread", channelId, rootId]` 캐시 — 스레드를 연 적이 있을 때만 있다(REST 로 채운다) */
export const getThread = (qc: QueryClient, channelId: string, rootId: string): Timeline | undefined =>
  qc.getQueryData<Timeline>(qk.thread(channelId, rootId));

type TimelineEdit = (t: Timeline) => Timeline;
/** 타임라인·스레드를 REST 로 받는 중인 요청마다 그동안 온 변경 — 클라이언트·캐시별(`withThreadEdits`·`withTimelineEdits`) */
const inFlight = new WeakMap<QueryClient, Map<string, Set<TimelineEdit[]>>>();
const channelSlot = (channelId: string) => `timeline/${channelId}`;
const threadSlot = (channelId: string, rootId: string) => `thread/${channelId}/${rootId}`;

function logEdit(qc: QueryClient, slot: string, fn: TimelineEdit): void {
  for (const log of inFlight.get(qc)?.get(slot) ?? []) log.push(fn);
}

/**
 * 스레드 캐시를 고친다 — **있을 때만**. 연 적 없는 스레드의 답글은 버린다(루트의 요약이 칩을 맞춘다):
 * 한 페이지도 받지 않은 스레드에 답글 몇 개만 두면 그 스레드를 열 때 빈 곳이 있는 목록을 온전한 것처럼 보인다.
 * 다만 그 스레드를 REST 로 받는 중이면 캐시가 없어도 변경을 모아 두었다가 받은 페이지에 다시 적용한다(`withThreadEdits`) —
 * 받는 사이 wire 로 온 답글은 채널 lastSeq 만 올려 두므로 여기서 버리면 빈틈 복구로도 돌아오지 않는다.
 * 그래서 `fn` 은 새 페이지에 다시 적용돼도 맞아야 한다(과거 페이지 붙이기는 가장 옛 답글이 같을 때만 붙인다, `useOlderPages`)
 */
export function updateThread(qc: QueryClient, channelId: string, rootId: string, fn: TimelineEdit): void {
  logEdit(qc, threadSlot(channelId, rootId), fn);
  if (!getThread(qc, channelId, rootId)) return;
  qc.setQueryData<Timeline>(qk.thread(channelId, rootId), (prev) => (prev ? fn(prev) : prev));
}

/**
 * 스레드 페이지를 받는 동안 온 `updateThread` 변경을 받은 결과에 차례로 다시 적용한다(p4t-t6 리뷰 I1) — 첫 열기(캐시 없음)와
 * 다시 받기(옛 캐시를 새 페이지가 통째로 바꾼다) 둘 다. 스냅숏이 이미 가진 것은 upsert 가 같은 것으로 덮을 뿐이다
 */
export const withThreadEdits = (
  qc: QueryClient,
  channelId: string,
  rootId: string,
  load: () => Promise<Timeline>,
): Promise<Timeline> => withEdits(qc, threadSlot(channelId, rootId), load);

/** 채널 타임라인판 `withThreadEdits` — 결과로 가기·아래로 이어 받기가 받는 사이 wire 로 온 변경을 잃지 않게 */
export const withTimelineEdits = (
  qc: QueryClient,
  channelId: string,
  load: () => Promise<Timeline>,
): Promise<Timeline> => withEdits(qc, channelSlot(channelId), load);

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
