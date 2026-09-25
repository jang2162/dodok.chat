import type { Message } from "@dodok/shared";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiRequestError, api } from "@/api/http";
import { qk } from "@/api/queries";
import { threadFromPage, type Timeline } from "@/features/messages/timeline";
import { type PageQuery, pageParams } from "@/realtime/subscriptions";
import { withThreadEdits } from "@/realtime/timelineCache";

/** 스레드 패널이 한 번에 받는 메시지 수(채널 과거 페이지와 같다) */
export const THREAD_PAGE = 50;

/** REST `GET /channels/:id/threads/:rootId/messages` — 루트는 페이지가 거기까지 닿지 않아도 `root` 로 늘 온다 */
export type ThreadPage = { root: Message; messages: Message[]; hasMore: boolean; hasMoreAfter?: boolean };

export function fetchThreadPage(channelId: string, rootId: string, q: PageQuery): Promise<ThreadPage> {
  return api("GET", `/channels/${channelId}/threads/${rootId}/messages?${pageParams(q)}`);
}

/** 없는 루트 — 404(지운 메시지·답글·다른 채널) 또는 주소의 id 가 UUID 가 아님(VALIDATION) */
export const isThreadMissing = (e: unknown): boolean =>
  e instanceof ApiRequestError && (e.status === 404 || e.code === "VALIDATION");

/**
 * 스레드 하나의 캐시(`["thread", channelId, rootId]`). 최신 페이지를 REST 로 받고, 그 뒤는 wire 이벤트·재동기화가 고친다
 * (`realtime/handlers`·`subscriptions`) — 그래서 저절로 낡지 않는다(`staleTime: Infinity`). 낡은 것으로 둘 때(재동기화가
 * 답글을 다 받았다고 말할 수 없을 때·사본에서 복원했을 때)만 다시 받는다. 다시 받으면 최신 페이지로 새로 시작하되
 * 보내는 중 항목은 남기고, 받는 사이 wire 가 고친 것은 결과에 다시 얹는다(`withThreadEdits`). 없는 루트는 되풀이해도
 * 같으므로 다시 시도하지 않고, 오류는 패널이 그린다(`silent`)
 */
export const threadQuery = (qc: QueryClient, channelId: string, rootId: string) =>
  queryOptions<Timeline>({
    queryKey: qk.thread(channelId, rootId),
    queryFn: () =>
      withThreadEdits(qc, channelId, rootId, async () => {
        const page = await fetchThreadPage(channelId, rootId, { limit: THREAD_PAGE });
        const prev = qc.getQueryData<Timeline>(qk.thread(channelId, rootId));
        return threadFromPage(prev, page.root, page.messages, page.hasMore);
      }),
    staleTime: Number.POSITIVE_INFINITY,
    meta: { silent: true },
  });

/** 스레드를 열 때 — 채널마다 마지막으로 연 스레드 하나를 기억한다(오프라인 사본이 그 스레드를 담는다, pwa/persist) */
export function touchRecentThread(qc: QueryClient, channelId: string, rootId: string): void {
  qc.setQueryData<Record<string, string>>(qk.recentThreads, (prev = {}) =>
    prev[channelId] === rootId ? prev : { ...prev, [channelId]: rootId },
  );
}

/** 이 메시지에서 연 스레드의 루트 — 답글이면 그 루트(스레드 안의 스레드는 없다, Review Focus 1) */
export const threadRootOf = (m: Pick<Message, "id" | "threadRootId">): string => m.threadRootId ?? m.id;
