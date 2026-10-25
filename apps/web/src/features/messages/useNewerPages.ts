import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { loadNewer } from "./jump";
import { reportPageError } from "./useOlderPages";

/** 하단에서 이만큼 안에 닿으면 떨어진 창의 다음 쪽을 부른다(과거 페이지의 OLDER_PX 와 같다) */
const NEWER_PX = 200;

/**
 * 떨어진 창(`hasNewer`, 결과로 가기)의 아래로 이어 받기 — 맨 아래 근처에 닿으면 가장 새 항목 뒤를 한 쪽 붙인다.
 * 과거 페이지(`useOlderPages`)의 거울이다: 실패하면 알리고 맨 아래 구역을 벗어났다 돌아올 때까지 멈춘다
 */
export function useNewerPages(
  channelId: string,
  conversationId: string,
  threadRootId: string | undefined,
  hasNewer: boolean,
) {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const armed = useRef(true);

  async function load() {
    busy.current = true;
    setLoading(true);
    try {
      await loadNewer(qc, channelId, conversationId, threadRootId);
    } catch (e) {
      armed.current = false;
      reportPageError(e);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }

  return {
    loading,
    /** `fromBottom` 은 스크롤 영역의 아래 끝까지 남은 거리 */
    onScrollBottom(fromBottom: number) {
      if (fromBottom >= NEWER_PX) {
        armed.current = true;
        return;
      }
      if (hasNewer && armed.current && !busy.current) void load();
    },
  };
}
