import { createContext, useContext } from "react";

/**
 * 지금 그리는 세션이 닫혔는가 — 세션 화면(ChannelPage)이 그 아래(메시지 목록·카드·스레드 패널)에 내려 준다. 닫힌 세션은 읽기만 된다
 * (채널 세션 스펙 「세션 만들기·닫기」 절 — 보내기·카드·리액션·첨부 묶기는 서버가 409 `CONVERSATION_CLOSED`). 보관한 채널의
 * `ChannelArchivedContext` 와 같은 수법이고, 화면 밖(테스트·다른 화면)의 기본값은 「열림」이다
 */
export const ConversationClosedContext = createContext(false);
export const useConversationClosed = (): boolean => useContext(ConversationClosedContext);
