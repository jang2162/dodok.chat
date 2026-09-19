import { createContext, useContext } from "react";

/**
 * 보내는 중 항목(스펙 4.4)의 「다시 보내기」·「삭제」. 태스크 7 의 PendingItem 이 읽고,
 * 태스크 9 가 ChannelPage 에서 `useSendMessage` 로 값을 넣는다 — MessageList 를 거치지 않는다
 */
export type PendingActions = {
  retry(clientMsgId: string): void;
  discard(clientMsgId: string): void;
};

export const PendingActionsContext = createContext<PendingActions | null>(null);

/** Provider 가 없으면 null(버튼을 그리지 않는다) */
export const usePendingActions = (): PendingActions | null => useContext(PendingActionsContext);
