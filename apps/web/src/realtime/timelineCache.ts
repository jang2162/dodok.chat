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
