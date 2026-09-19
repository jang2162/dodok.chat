import { skipToken, useQuery } from "@tanstack/react-query";
import { qk } from "@/api/queries";
import type { Timeline } from "./timeline";

/**
 * 채널 타임라인 캐시(`["timeline", id]`)를 읽기만 한다 — 채우는 것은 구독 관리자와 wire 이벤트(스펙 4.3).
 * 아직 구독 응답이 오지 않았으면 undefined
 */
export function useTimeline(channelId: string): Timeline | undefined {
  return useQuery<Timeline>({ queryKey: qk.timeline(channelId), queryFn: skipToken }).data;
}
