import { type QueryClient, queryOptions, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queries";
import { threadQuery } from "@/features/threads/queries";
import type { Timeline } from "./timeline";

/**
 * 채널 타임라인 또는 스레드의 쿼리 옵션. 같은 키의 관찰자는 모두 이것을 펼친다 — TanStack Query 는 마지막으로 다시 그려진
 * 관찰자의 옵션(queryFn·meta)을 쿼리 옵션으로 쓰고 무효화 뒤 다시 받기도 그 queryFn 으로 돈다. 읽기만 하는 관찰자가
 * 다른 queryFn(`skipToken`)을 주면 다시 받기가 `Missing queryFn` 으로 실패한다(p4t-t6 리뷰 I2)
 */
export const timelineQuery = (qc: QueryClient, channelId: string, threadRootId?: string) =>
  threadRootId === undefined
    ? queryOptions<Timeline>({ queryKey: qk.timeline(channelId), queryFn: skipToken })
    : threadQuery(qc, channelId, threadRootId);

/**
 * 채널 타임라인 캐시(`["timeline", id]`)를 읽기만 한다 — 채우는 것은 구독 관리자와 wire 이벤트(스펙 4.3).
 * 아직 구독 응답이 오지 않았으면 undefined. 채널 타임라인은 루트만 든다(스레드·검색 스펙 4.1).
 * `threadRootId` 를 주면 그 스레드(루트·답글) — 처음은 REST 로 받고 그 뒤는 wire 이벤트가 고친다(`threadQuery`)
 */
export function useTimeline(channelId: string, threadRootId?: string): Timeline | undefined {
  const qc = useQueryClient();
  return useQuery(timelineQuery(qc, channelId, threadRootId)).data;
}
