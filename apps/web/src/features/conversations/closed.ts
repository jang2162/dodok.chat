import { createContext, type RefObject, useContext } from "react";

/**
 * 지금 그리는 세션이 닫혔는가 — 세션 화면(ChannelPage)이 그 아래(메시지 목록·카드·스레드 패널)에 내려 준다. 닫힌 세션은 읽기만 된다
 * (채널 세션 스펙 「세션 만들기·닫기」 절 — 보내기·카드·리액션·첨부 묶기는 서버가 409 `CONVERSATION_CLOSED`). 보관한 채널의
 * `ChannelArchivedContext` 와 같은 수법이고, 화면 밖(테스트·다른 화면)의 기본값은 「열림」이다
 */
export const ConversationClosedContext = createContext(false);
export const useConversationClosed = (): boolean => useContext(ConversationClosedContext);

/** 세션 화면에서 닫힌 안내가 서는 자리 — 세션 작성기 자리(`main`)·스레드 패널 작성기 자리(`thread`) */
export type ClosedZone = "main" | "thread";

/**
 * 세션이 닫힐 때 초점을 가져갈 안내를 가르는 것 — 세션 화면(ChannelPage)이 내려 준다. `zone` 은 마지막으로 초점을 가졌던 자리다:
 * 쓰던 작성기가 빠져 초점이 body 로 떨어질 때는 새 초점이 없으므로 그 앞의 자리를 그대로 든다. 두 안내가 같은 커밋에 서고 효과는
 * 본문 쪽이 먼저 돌아 떨어진 초점을 가져가므로, 효과 시점이 아니라 미리 들고 있어야 한다. `seenOpen` 은 이 화면에서 열린 채 보던
 * 세션이 닫혔다는 뜻이다(`ClosedNotice` 의 `focusOnMount`). 화면 밖(테스트·다른 화면)은 없다 — 안내는 자리를 가리지 않는다
 */
export const ClosedFocusContext = createContext<
  { zone: RefObject<ClosedZone>; seenOpen: boolean } | undefined
>(undefined);
export const useClosedFocus = () => useContext(ClosedFocusContext);
