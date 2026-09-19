import { useCallback, useMemo, useRef } from "react";
import { useWireStatus } from "@/realtime/wire";
import { useWire } from "@/realtime/WireProvider";

/** 작성기 입력이 바뀌면 이 간격에 한 번 `typing`(스펙 4.7) */
export const TYPING_THROTTLE_MS = 3_000;

/**
 * `notify()` 는 채널마다 3초 스로틀로 `typing { channelId }`(ack 없음). wire 가 connected 일 때만 —
 * 끊긴 동안 보내면 socket.io 가 버퍼에 두었다가 붙을 때 늦게 보낸다
 */
export function useTyping(channelId: string): { notify(): void } {
  const { socket } = useWire();
  const last = useRef<{ channelId: string; at: number } | undefined>(undefined);
  const notify = useCallback(() => {
    if (!socket || useWireStatus.getState().status !== "connected") return;
    const now = Date.now();
    const prev = last.current;
    if (prev?.channelId === channelId && now - prev.at < TYPING_THROTTLE_MS) return;
    last.current = { channelId, at: now };
    socket.emit("typing", { channelId });
  }, [socket, channelId]);
  return useMemo(() => ({ notify }), [notify]);
}
