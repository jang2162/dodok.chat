import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ApiRequestError, NetworkError } from "@/api/http";
import { restFetchPage } from "@/realtime/subscriptions";
import { getTimeline, updateTimeline } from "@/realtime/timelineCache";
import { prependOlder } from "./timeline";

/** 상단에서 이만큼 안에 닿으면 과거 페이지를 부른다 */
const OLDER_PX = 200;
const OLDER_PAGE = 50;

/**
 * 과거 페이지(스펙 4.3-2): 맨 위 근처에 닿으면 `beforeSeq = 가장 옛 seq` 로 50개를 앞에 붙인다.
 * REST 직접 호출이라 전역 onError 를 타지 않는다 — 실패는 여기서 토스트하고, 같은 자리에서 되풀이하지 않게
 * 맨 위 구역을 벗어났다 돌아올 때까지 멈춘다
 */
export function useOlderPages(channelId: string) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const armed = useRef(true);

  async function load() {
    const t = getTimeline(qc, channelId);
    const first = t?.items[0];
    if (!t?.hasOlder || !first || busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const page = await restFetchPage(channelId, { beforeSeq: first.seq, limit: OLDER_PAGE });
      // 그 사이 타임라인이 새로 시작됐으면(빈틈 복구) 붙이지 않는다
      updateTimeline(qc, channelId, (cur) =>
        cur.items[0]?.seq === first.seq ? prependOlder(cur, page.messages, page.hasMore) : cur,
      );
    } catch (e) {
      armed.current = false;
      if (e instanceof NetworkError) toast.error(e.message, { id: "network" });
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
