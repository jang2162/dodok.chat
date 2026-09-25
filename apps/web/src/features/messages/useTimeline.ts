import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queries";
import { threadQuery } from "@/features/threads/queries";
import type { Timeline } from "./timeline";

/**
 * 채널 타임라인 캐시(`["timeline", id]`)를 읽기만 한다 — 채우는 것은 구독 관리자와 wire 이벤트(스펙 4.3).
 * 아직 구독 응답이 오지 않았으면 undefined. 채널 타임라인은 루트만 든다(스레드·검색 스펙 4.1).
 * `threadRootId` 를 주면 그 스레드(루트·답글) — 처음은 REST 로 받고 그 뒤는 wire 이벤트가 고친다(`threadQuery`)
 */
export function useTimeline(channelId: string, threadRootId?: string): Timeline | undefined {
  const qc = useQueryClient();
  return useQuery<Timeline>(
    threadRootId === undefined
      ? { queryKey: qk.timeline(channelId), queryFn: skipToken }
      : threadQuery(qc, channelId, threadRootId),
  ).data;
}
