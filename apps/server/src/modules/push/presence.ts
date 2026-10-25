import type { PresenceUpdate } from "@dodok/shared";

export type Presence = ReturnType<typeof createPresence>;

/**
 * 소켓별 「보이는가·보는 세션」(스펙 5.3 — 채널 세션 계획 판정 PS7 이 단위를 세션으로). 거르기에만 쓴다 — 틀린 id 는 「안 보고 있음」이
 * 될 뿐이다. 세션 id 는 워크스페이스를 넘어 유일해 채널을 함께 보지 않는다. 새 세션 창(`new`)·채널 밖 화면은 세션이 없어 아무것도
 * 거르지 않는다. 메모리에만 있어 서버 재시작 직후 몇 초는 비어 있다(스펙 10장)
 */
export function createPresence() {
  const bySocket = new Map<string, { userId: string; visible: boolean; conversationId?: string }>();
  return {
    set(socketId: string, userId: string, p: PresenceUpdate): void {
      bySocket.set(socketId, {
        userId,
        visible: p.visible,
        ...(p.conversationId === undefined ? {} : { conversationId: p.conversationId }),
      });
    },
    drop(socketId: string): void {
      bySocket.delete(socketId);
    },
    /** 그 사람의 소켓 중 보이는 탭이 그 세션에 있는 것이 하나라도 있는가 — 같은 채널의 다른 세션은 보고 있는 것이 아니다 */
    isWatching(userId: string, conversationId: string): boolean {
      for (const s of bySocket.values())
        if (s.userId === userId && s.visible && s.conversationId === conversationId) return true;
      return false;
    },
  };
}
