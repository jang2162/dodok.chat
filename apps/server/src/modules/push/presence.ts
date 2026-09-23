import type { PresenceUpdate } from "@dodok/shared";

export type Presence = ReturnType<typeof createPresence>;

/**
 * 소켓별 「보이는가·보는 채널」(스펙 5.3). 거르기에만 쓴다 — 틀린 채널 id 는 「안 보고 있음」이 될 뿐이다.
 * 메모리에만 있어 서버 재시작 직후 몇 초는 비어 있다(스펙 10장)
 */
export function createPresence() {
  const bySocket = new Map<string, { userId: string; visible: boolean; channelId?: string }>();
  return {
    set(socketId: string, userId: string, p: PresenceUpdate): void {
      bySocket.set(socketId, {
        userId,
        visible: p.visible,
        ...(p.channelId === undefined ? {} : { channelId: p.channelId }),
      });
    },
    drop(socketId: string): void {
      bySocket.delete(socketId);
    },
    /** 그 사람의 소켓 중 보이는 탭이 그 채널에 있는 것이 하나라도 있는가 */
    isWatching(userId: string, channelId: string): boolean {
      for (const s of bySocket.values())
        if (s.userId === userId && s.visible && s.channelId === channelId) return true;
      return false;
    },
  };
}
