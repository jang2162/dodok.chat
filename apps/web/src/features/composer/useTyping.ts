import { useCallback, useMemo, useRef } from "react";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { useWireStatus } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";

/** 작성기 입력이 바뀌면 이 간격에 한 번 `typing`(스펙 4.7) */
export const TYPING_THROTTLE_MS = 3_000;

/**
 * `notify()` 는 세션마다 3초 스로틀로 `typing { channelId, conversationId }`(ack 없음). wire 가 connected 일 때만 —
 * 끊긴 동안 보내면 socket.io 가 버퍼에 두었다가 붙을 때 늦게 보낸다. 새 세션 창은 보내지 않는다 — 아직 그 세션을 볼 사람이 없다
 */
export function useTyping(channelId: string, conversationId: string): { notify(): void } {
  const { socket } = useWire();
  const last = useRef<{ conversationId: string; at: number } | undefined>(undefined);
  const notify = useCallback(() => {
    if (!socket || useWireStatus.getState().status !== "connected") return;
    if (conversationId === NEW_CONVERSATION) return;
    const now = Date.now();
    const prev = last.current;
    if (prev?.conversationId === conversationId && now - prev.at < TYPING_THROTTLE_MS) return;
    last.current = { conversationId, at: now };
    socket.emit("typing", { channelId, conversationId });
  }, [socket, channelId, conversationId]);
  return useMemo(() => ({ notify }), [notify]);
}
