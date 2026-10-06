import { useUnread } from "./useUnread";

/**
 * 채널에 들어갈 때의 읽음 위치 — 「새 메시지」 구분선의 기준이다. 부르는 쪽이 들어갈 때 한 번만 잡고 떠날 때까지 둔다:
 * 읽음이 올라가도 스냅숏이 늦게 와도 다시 잡으면 구분선이 사라지거나 뒤늦게 튀어나온다.
 * 현황을 모르면 `undefined` 이지 0 이 아니다 — 0 이면 채널 맨 앞에 구분선이 그어진다. 스냅숏 전·실패, 항목이 없는 채널
 * (보관한 채널은 항목을 만들지 않는다 — 보관 해제 직후)이 그렇다
 */
export function captureEntryRead(channelId: string): number | undefined {
  const { ready, byChannel } = useUnread.getState();
  return ready ? byChannel[channelId]?.lastReadSeq : undefined;
}
