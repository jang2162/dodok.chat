import { useEffect, useState } from "react";
import { useAgents, useMe } from "@/api/queries";
import { typingActors, useTypingStore } from "@/realtime/typing";

/** 보이는 동안 이 간격으로 다시 계산한다 — 받은 typing 은 5초 뒤 만료(`TYPING_TTL_MS`) */
const TICK_MS = 1_000;

/**
 * 작성기 위 「@dev 작성 중…」(스펙 4.7). 자기 자신(서버는 같은 사용자의 다른 탭에도 보낸다)은 숨긴다.
 * 이름은 에이전트 목록과 me 로 푼다 — 모르는 행위자(목록에 아직 없는 에이전트, 사용자 목록이 없는 다른 사람)는 건너뛴다
 */
export function TypingIndicator({ channelId }: { channelId: string }) {
  const byChannel = useTypingStore((s) => s.byChannel);
  const me = useMe().data?.user;
  const agents = useAgents().data;
  const [now, setNow] = useState(() => Date.now());

  // 새로 받으면 시계를 맞춘다 — 타이머가 멈춰 있던 동안 `now` 는 옛값이다
  const entries = byChannel[channelId];
  useEffect(() => setNow(Date.now()), [entries]);

  const handles = typingActors({ byChannel }, channelId, now)
    .filter((a) => !(a.actorType === "user" && a.actorId === me?.id))
    .flatMap((a) => {
      const handle =
        a.actorType === "agent"
          ? agents?.find((x) => x.id === a.actorId)?.handle
          : a.actorId === me?.id
            ? me.handle
            : undefined;
      return handle ? [`@${handle}`] : [];
    });
  const active = handles.length > 0;

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  return (
    <div className="h-5 truncate px-4 text-xs text-muted-foreground">
      {active && `${handles.join(", ")} 작성 중…`}
    </div>
  );
}
