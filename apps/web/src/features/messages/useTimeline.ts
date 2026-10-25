import { type QueryClient, queryOptions, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queries";
import { threadQuery } from "@/features/threads/queries";
import { restFetchPage } from "@/realtime/subscriptions";
import { getTimeline, withTimelineEdits } from "@/realtime/timelineCache";
import { emptyTimeline, fromLatest, NEW_CONVERSATION, type Timeline } from "./timeline";

/** 세션 첫 페이지의 루트 수 — 세션 전의 첫 구독 한 쪽(루트 200개)과 같다(「새 메시지」 구분선이 그 안에서 자리를 찾는다) */
export const TIMELINE_FIRST_PAGE = 200;

/**
 * 세션 타임라인의 쿼리 옵션(채널 세션 계획 판정 PS6). 최신 페이지를 세션 REST 로 받고, 그 뒤는 wire 이벤트·재동기화가 고친다 — 그래서
 * 저절로 낡지 않는다(`staleTime: Infinity`). 낡은 것으로 둘 때(처음 구독·재동기화가 넘침)만 다시 받는다. 다시 받으면 최신 페이지로
 * 새로 시작하되 보내는 중 항목은 남기고, 받는 사이 wire 가 고친 것은 결과에 다시 얹는다(`withTimelineEdits`). `lastSeq` 는 내려가지
 * 않는다 — 다시 받은 쪽에는 스레드 답글의 seq 가 없다. 새 세션 창(`NEW_CONVERSATION`)은 받을 것이 없다 — 보내는 중 항목만 든다.
 * 오류는 세션 화면이 그린다(`silent`)
 */
export const conversationTimelineQuery = (qc: QueryClient, channelId: string, conversationId: string) =>
  conversationId === NEW_CONVERSATION
    ? queryOptions<Timeline>({
        queryKey: qk.timeline(channelId, conversationId),
        queryFn: skipToken,
        initialData: emptyTimeline,
        staleTime: Number.POSITIVE_INFINITY,
      })
    : queryOptions<Timeline>({
        queryKey: qk.timeline(channelId, conversationId),
        queryFn: () =>
          withTimelineEdits(qc, channelId, conversationId, async () => {
            const page = await restFetchPage(conversationId, { limit: TIMELINE_FIRST_PAGE });
            const prev = getTimeline(qc, channelId, conversationId);
            const t = fromLatest(prev, page.messages, page.hasMore);
            return { ...t, lastSeq: Math.max(t.lastSeq, prev?.lastSeq ?? 0) };
          }),
        staleTime: Number.POSITIVE_INFINITY,
        meta: { silent: true },
      });

/**
 * 세션 타임라인 또는 스레드의 쿼리 옵션. 같은 키의 관찰자는 모두 이것을 펼친다 — TanStack Query 는 마지막으로 다시 그려진
 * 관찰자의 옵션(queryFn·meta)을 쿼리 옵션으로 쓰고 무효화 뒤 다시 받기도 그 queryFn 으로 돈다. 읽기만 하는 관찰자가
 * 다른 queryFn(`skipToken`)을 주면 다시 받기가 `Missing queryFn` 으로 실패한다(p4t-t6 리뷰 I2) — 읽기만 하는 관찰자는 `enabled: false`
 */
export const timelineQuery = (
  qc: QueryClient,
  channelId: string,
  conversationId: string,
  threadRootId?: string,
) =>
  threadRootId === undefined
    ? conversationTimelineQuery(qc, channelId, conversationId)
    : threadQuery(qc, channelId, conversationId, threadRootId);

/**
 * 이 연결에서 그 채널을 구독했는가(채널 커서가 섰다). 세션·스레드의 첫 페이지는 그 뒤에만 받는다 — 서버는 룸에 들어간 뒤의 글만
 * 이벤트로 보내므로, 들어가기 전에 읽은 페이지와 들어간 뒤 사이의 글이 빠진다
 */
export function useChannelSubscribed(channelId: string): boolean {
  return (
    useQuery({
      queryKey: qk.channelSeq(channelId),
      queryFn: skipToken,
      staleTime: Number.POSITIVE_INFINITY,
      select: () => true,
    }).data === true
  );
}

/**
 * 세션 타임라인(`threadRootId` 가 없으면 — 루트만) 또는 그 세션의 스레드(루트·답글). 받기는 채널을 구독한 뒤에만 켠다
 * (`useChannelSubscribed`) — 그 전에는 캐시(사본에서 복원한 것 포함)만 보인다. `ready` 는 받은 것이 지금 것이다(구독했고, 받는 중도 낡은
 * 것도 아니다) — 결과로 가기·「처음 안 읽은 곳」 배너처럼 목록을 갈아 끼우는 일은 그때만 한다: 그 전에 갈아 끼우면 뒤이은 다시 받기가
 * 최신 쪽으로 덮는다
 */
export function useTimelineState(
  channelId: string,
  conversationId: string,
  threadRootId?: string,
): { timeline: Timeline | undefined; ready: boolean; error: Error | null; refetch: () => void } {
  const qc = useQueryClient();
  const subscribed = useChannelSubscribed(channelId);
  const q = useQuery({ ...timelineQuery(qc, channelId, conversationId, threadRootId), enabled: subscribed });
  return {
    timeline: q.data,
    ready: subscribed && q.data !== undefined && !q.isFetching && !q.isStale,
    error: q.error,
    refetch: () => void q.refetch(),
  };
}

/** `useTimelineState` 의 목록만 */
export const useTimeline = (
  channelId: string,
  conversationId: string,
  threadRootId?: string,
): Timeline | undefined => useTimelineState(channelId, conversationId, threadRootId).timeline;
