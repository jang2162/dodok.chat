import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ApiRequestError, NetworkError } from "@/api/http";
import { notifyUnauthorized } from "@/app/session";
import { fetchThreadPage } from "@/features/threads/queries";
import { restFetchPage } from "@/realtime/subscriptions";
import { getThread, getTimeline, updateThread, updateTimeline } from "@/realtime/timelineCache";
import { type Timeline, prependOlder } from "./timeline";

/** 상단에서 이만큼 안에 닿으면 과거 페이지를 부른다 */
const OLDER_PX = 200;
const OLDER_PAGE = 50;

/**
 * 과거 페이지(스펙 4.3-2): 맨 위 근처에 닿으면 `beforeSeq = 가장 옛 seq` 로 50개를 앞에 붙인다.
 * REST 직접 호출이라 전역 onError 를 타지 않는다 — 401 은 토스트 없이 로그인으로(스펙 8장), 그 밖의 실패는 여기서
 * 토스트하고, 같은 자리에서 되풀이하지 않게 맨 위 구역을 벗어났다 돌아올 때까지 멈춘다.
 * 스레드(`threadRootId`)면 스레드 REST 로 받고 기준은 가장 옛 **답글**이다 — 루트는 늘 맨 앞에 있지만 페이지의 경계가 아니다
 */
export function useOlderPages(channelId: string, threadRootId?: string) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const armed = useRef(true);

  const oldest = (t: Timeline) =>
    threadRootId === undefined ? t.items[0] : t.items.find((m) => m.id !== threadRootId);

  async function load() {
    const t =
      threadRootId === undefined ? getTimeline(qc, channelId) : getThread(qc, channelId, threadRootId);
    const first = t && oldest(t);
    if (!t?.hasOlder || !first || busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const q = { beforeSeq: first.seq, limit: OLDER_PAGE };
      const page =
        threadRootId === undefined
          ? await restFetchPage(channelId, q)
          : await fetchThreadPage(channelId, threadRootId, q);
      // 그 사이 타임라인이 새로 시작됐으면(빈틈 복구·스레드 다시 받기) 붙이지 않는다
      const prepend = (cur: Timeline) =>
        oldest(cur)?.seq === first.seq ? prependOlder(cur, page.messages, page.hasMore) : cur;
      if (threadRootId === undefined) updateTimeline(qc, channelId, prepend);
      else updateThread(qc, channelId, threadRootId, prepend);
    } catch (e) {
      armed.current = false;
      if (e instanceof ApiRequestError && e.status === 401) notifyUnauthorized();
      else if (e instanceof NetworkError) toast.error(e.message, { id: "network" });
      else if (e instanceof ApiRequestError) toast.error(e.message);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }

  return {
    loading,
    onScrollTop(top: number) {
      if (top >= OLDER_PX) {
        armed.current = true;
        return;
      }
      if (armed.current) void load();
    },
  };
}
