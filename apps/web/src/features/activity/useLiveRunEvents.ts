import type { RunEvent, ServerToClientEvents } from "@dodok/shared";
import { useEffect, useState } from "react";
import { useWire } from "@/realtime/WireProvider";
import { isTimelineEvent, mergeRunEvents } from "./timeline";

const NONE: readonly RunEvent[] = [];

/**
 * 고른 런의 실시간 `run.event` 를 모은다(설계 5.2). REST 로 받은 바탕(`useRunEvents`)과 `mergeRunEvents` 로
 * 합치면 겹친 seq 는 한 번만 남는다 — 그래서 REST 응답을 기다리는 동안 온 이벤트도 잃지 않는다.
 *
 * 런 스토어(`runStore`)는 텍스트와 마지막 seq 만 들고 있어 타임라인 행을 만들 수 없다. 소켓에서 곧바로 받는다 —
 * 이벤트마다 REST 를 다시 부르면 델타 한 줄에 한 번씩 부르게 된다
 */
export function useLiveRunEvents(runId: string | undefined): readonly RunEvent[] {
  const { socket } = useWire();
  // 런을 바꾼 프레임에 옛 런의 이벤트가 새어 나오지 않게 runId 를 같이 들고 있는다
  const [buffer, setBuffer] = useState<{ runId?: string; events: readonly RunEvent[] }>({ events: NONE });

  useEffect(() => {
    if (!socket || runId === undefined) return;
    const onEvent = ({ event }: Parameters<ServerToClientEvents["run.event"]>[0]) => {
      if (event.runId !== runId || !isTimelineEvent(event)) return;
      setBuffer((prev) =>
        prev.runId === runId
          ? { runId, events: mergeRunEvents(prev.events, [event]) }
          : { runId, events: [event] },
      );
    };
    socket.on("run.event", onEvent);
    return () => {
      socket.off("run.event", onEvent);
    };
  }, [socket, runId]);

  return buffer.runId === runId ? buffer.events : NONE;
}
