import { useEffect, useState } from "react";
import { useMe, usePeople } from "@/api/queries";
import { typingActors, useTypingStore } from "@/realtime/typing";

/** 보이는 동안 이 간격으로 다시 계산한다 — 받은 typing 은 5초 뒤 만료(`TYPING_TTL_MS`) */
const TICK_MS = 1_000;

/**
 * 작성기 위 「@mia 작성 중…」(스펙 4.7) — 사람만. 핸들은 사람 목록(people)으로 풀고, 목록에 없는 사람은 건너뛴다.
 * 자기 자신(서버는 같은 사용자의 다른 탭에도 보낸다)은 숨긴다. 에이전트 typing 은 보이지 않는다 — 플러그인이 typing 을
 * 내지 않고, 에이전트가 일하는 중이라는 표시는 런 버블(대기 중·스트리밍·도구 사용 중)이 맡는다
 */
export function TypingIndicator({ channelId }: { channelId: string }) {
  const byChannel = useTypingStore((s) => s.byChannel);
  const me = useMe().data?.user;
  const people = usePeople().data;
  const [now, setNow] = useState(() => Date.now());

  // 새로 받으면 시계를 맞춘다 — 타이머가 멈춰 있던 동안 `now` 는 옛값이다
  const entries = byChannel[channelId];
  useEffect(() => setNow(Date.now()), [entries]);

  const handles = typingActors({ byChannel }, channelId, now).flatMap((a) => {
    if (a.actorType !== "user" || a.actorId === me?.id) return [];
    const handle = people?.find((p) => p.id === a.actorId)?.handle;
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
