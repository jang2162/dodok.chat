import { useUnread } from "./useUnread";

/**
 * 세션에 들어갈 때의 읽음 위치 — 「새 메시지」 구분선의 기준이다. 부르는 쪽이 들어갈 때 한 번만 잡고 떠날 때까지 둔다:
 * 읽음이 올라가도 스냅숏이 늦게 와도 다시 잡으면 구분선이 사라지거나 뒤늦게 튀어나온다. 같은 채널 안에서 세션을 옮기는 것도
 * 들어가는 것이다 — 읽음 위치가 세션마다 따로다.
 * 현황을 모르면 `undefined` 이지 0 이 아니다 — 0 이면 세션 맨 앞에 구분선이 그어진다. 스냅숏 전·실패, 항목이 없는 세션
 * (보관한 채널은 항목을 만들지 않는다 — 보관 해제 직후, 새 세션 창)이 그렇다
 */
export function captureEntryRead(conversationId: string): number | undefined {
  const { ready, byConversation } = useUnread.getState();
  return ready ? byConversation[conversationId]?.lastReadSeq : undefined;
}
