import { createContext, type MouseEvent, type RefObject, useContext } from "react";
import { useLayout } from "@/app/layout/useLayoutWidths";
import type { ThreadSearch } from "@/app/router";
import { useIsNarrow } from "@/hooks/useIsNarrow";

/** 스레드를 연 자리 — 칩 또는 행의 「스레드에서 답하기」 */
export type ThreadOpener = { rootId: string; el: HTMLElement };

/**
 * 채널 화면(ChannelPage)이 하나 두는 「스레드를 연 자리」. 스레드를 닫으면 초점을 여기로 돌려준다(p4t-c1, m5) —
 * 주소·검색·푸시로 연 스레드는 적지 않는다(그때는 헤더의 「채널 설정」, D14)
 */
export const ThreadOpenerContext = createContext<RefObject<ThreadOpener | null> | null>(null);

/** 링크의 onClick — 누른 요소를 그 스레드를 연 자리로 적는다(Enter 도 click 이다) */
export function useNoteThreadOpener(rootId: string): (e: MouseEvent<HTMLElement>) => void {
  const ref = useContext(ThreadOpenerContext);
  return (e) => {
    if (ref) ref.current = { rootId, el: e.currentTarget };
  };
}

/**
 * 스레드를 여는 링크의 검색 값 — 이 기기에서 마지막으로 고른 보기가 메인이면 `view=main` 을 싣는다(UI 시안 06). 보기는 주소가 정하고
 * 라우터는 바꿔 쓰지 않으므로(뒤로 가기가 기록 그대로 열리게) 기억은 여는 자리에서만 적용된다. 좁은 화면은 늘 시트라 싣지 않는다
 */
export function useThreadOpenSearch(): ThreadSearch {
  const main = useLayout().threadView === "main" && !useIsNarrow();
  return main ? { view: "main" } : {};
}
