import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Timeline } from "@/features/messages/timeline";
import { timelineQuery } from "@/features/messages/useTimeline";
import { planBubbles } from "./bubblePhase";
import { selectScopeRuns, useRunStore } from "./runStore";

type RunStoreState = ReturnType<typeof useRunStore.getState>;
const NONE: string[] = [];

/** 타임라인의 에이전트 메시지가 만든 runId 들 — select 결과는 Query 가 구조 공유하므로 내용이 같으면 같은 배열 */
const messageRunIds = (t: Timeline): string[] =>
  t.items.flatMap((m) => (m.authorType === "agent" && m.runId ? [m.runId] : []));

/**
 * 채널에 보일 스트리밍 버블의 runId(런 순서, 스펙 4.6). 내용이 같으면 같은 배열을 돌려주고 델타로는 다시 그리지 않는다 —
 * 버블 텍스트는 `StreamingBubble` 이 런 스토어에서 직접 읽는다.
 * 숨겨진 종료 런은 런 스토어에서 지우고, 보이는 종료 런이 숨겨질 시각에 다시 계산한다. 그 타이머는 채널이 바뀌거나 내려가면 거둔다.
 * 그 세션의 런만(채널 세션 계획 판정 PS7 — 다른 세션의 버블이 섞이지 않는다), `threadRootId` 를 주면 그 스레드의 런만, 없으면 세션
 * 런만(판정 R3′) — 스레드 런의 버블은 세션 타임라인에 새지 않는다.
 * 캐시는 읽기만 한다(받아 오는 것은 목록의 `useTimelineState` — 같은 옵션을 펼치되 이 관찰자는 받기를 켜지 않는다)
 */
export function useChannelBubbles(
  channelId: string,
  conversationId: string,
  threadRootId?: string,
): readonly string[] {
  const qc = useQueryClient();
  // 같은 키의 관찰자라 옵션(queryFn·meta)을 맞춘다 — 마지막으로 다시 그려진 관찰자의 옵션이 이긴다(`timelineQuery`)
  const ids = useQuery({
    ...timelineQuery(qc, channelId, conversationId, threadRootId),
    enabled: false,
    select: messageRunIds,
  }).data;
  const withMessage = useMemo(() => new Set(ids ?? NONE), [ids]);
  const [tick, recompute] = useReducer((n: number) => n + 1, 0);

  // 시각은 렌더마다 한 번 — 한 렌더 안의 선택자들은 같은 시각으로 계산한다
  const now = Date.now();
  const plan = (s: RunStoreState) =>
    planBubbles(selectScopeRuns(channelId, conversationId, threadRootId)(s), withMessage, now);
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
  }, [channelId, conversationId, threadRootId, nextAt, tick]);

  return visible;
}
