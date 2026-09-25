import type { QueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queries";
import { emptyTimeline, type Timeline } from "@/features/messages/timeline";

/** `["timeline", channelId]` 캐시(스펙 4.3). 없으면 그 채널에 아직 들어간 적이 없다 */
export const getTimeline = (qc: QueryClient, channelId: string): Timeline | undefined =>
  qc.getQueryData<Timeline>(qk.timeline(channelId));

/** 캐시를 고친다. 없으면 `emptyTimeline()` 에서 시작한다 */
export function updateTimeline(qc: QueryClient, channelId: string, fn: (t: Timeline) => Timeline): void {
  qc.setQueryData<Timeline>(qk.timeline(channelId), (prev) => fn(prev ?? emptyTimeline()));
}

/** `["thread", channelId, rootId]` 캐시 — 스레드를 연 적이 있을 때만 있다(REST 로 채운다) */
export const getThread = (qc: QueryClient, channelId: string, rootId: string): Timeline | undefined =>
  qc.getQueryData<Timeline>(qk.thread(channelId, rootId));

/**
 * 스레드 캐시를 고친다 — **있을 때만**. 연 적 없는 스레드의 답글은 버린다(루트의 요약이 칩을 맞춘다):
 * 한 페이지도 받지 않은 스레드에 답글 몇 개만 두면 그 스레드를 열 때 빈 곳이 있는 목록을 온전한 것처럼 보인다
 */
export function updateThread(
  qc: QueryClient,
  channelId: string,
  rootId: string,
  fn: (t: Timeline) => Timeline,
): void {
  if (!getThread(qc, channelId, rootId)) return;
  qc.setQueryData<Timeline>(qk.thread(channelId, rootId), (prev) => (prev ? fn(prev) : prev));
}
