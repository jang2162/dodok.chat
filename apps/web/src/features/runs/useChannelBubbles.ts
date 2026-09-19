import { skipToken, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer } from "react";
import { useShallow } from "zustand/react/shallow";
import { qk } from "@/api/queries";
import type { Timeline } from "@/features/messages/timeline";
import { planBubbles } from "./bubblePhase";
import { selectChannelRuns, useRunStore } from "./runStore";

type RunStoreState = ReturnType<typeof useRunStore.getState>;
const NONE: string[] = [];

/** 타임라인의 에이전트 메시지가 만든 runId 들 — select 결과는 Query 가 구조 공유하므로 내용이 같으면 같은 배열 */
const messageRunIds = (t: Timeline): string[] =>
  t.items.flatMap((m) => (m.authorType === "agent" && m.runId ? [m.runId] : []));

/**
 * 채널에 보일 스트리밍 버블의 runId(런 순서, 스펙 4.6). 내용이 같으면 같은 배열을 돌려주고 델타로는 다시 그리지 않는다 —
 * 버블 텍스트는 `StreamingBubble` 이 런 스토어에서 직접 읽는다.
 * 숨겨진 종료 런은 런 스토어에서 지우고, 보이는 종료 런이 숨겨질 시각에 다시 계산한다. 그 타이머는 채널이 바뀌거나 내려가면 거둔다
 */
export function useChannelBubbles(channelId: string): readonly string[] {
  const ids = useQuery<Timeline, Error, string[]>({
    queryKey: qk.timeline(channelId),
    queryFn: skipToken,
    select: messageRunIds,
  }).data;
  const withMessage = useMemo(() => new Set(ids ?? NONE), [ids]);
  const [tick, recompute] = useReducer((n: number) => n + 1, 0);

  // 시각은 렌더마다 한 번 — 한 렌더 안의 선택자들은 같은 시각으로 계산한다
  const now = Date.now();
  const plan = (s: RunStoreState) => planBubbles(selectChannelRuns(channelId)(s), withMessage, now);
  const visible = useRunStore(useShallow((s) => plan(s).visible));
  const stale = useRunStore(useShallow((s) => plan(s).stale));
  const nextAt = useRunStore((s) => plan(s).nextAt);

  useEffect(() => {
    const { remove } = useRunStore.getState();
    for (const runId of stale) remove(runId);
  }, [stale]);

  // tick 도 의존성 — 타이머가 조금 일찍 울려 아직 보이면 다시 건다
  useEffect(() => {
    if (nextAt === undefined) return;
    const timer = setTimeout(recompute, Math.max(0, nextAt - Date.now()));
    return () => clearTimeout(timer);
  }, [channelId, nextAt, tick]);

  return visible;
}
