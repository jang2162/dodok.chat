import { createContext, type MouseEvent, type RefObject, useContext } from "react";

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
