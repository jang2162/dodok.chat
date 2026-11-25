import type { BackgroundTask, ConversationBackgroundTasks } from "@dodok/shared";
import { useMemo } from "react";
import { create } from "zustand";

/**
 * 러너 에이전트의 백그라운드 작업(백그라운드 작업 스펙 5.7). 채널마다 대화(세션)별 「그 대화의 전체 값」을 쥔다 — 서버의
 * `tasks.updated` 는 바꿔 끼우는 값이고, 구독 결과 `tasks` 는 작업이 있는 대화만 실린 그 채널의 정본이다
 */
type BackgroundTaskStore = {
  byChannel: Record<string, Record<string, ConversationBackgroundTasks>>;
  /** `tasks.updated` — 그 대화의 값을 통째로 바꿔 끼운다. 비었고 러너가 붙어 있으면 대화 자리를 지운다 */
  apply(channelId: string, value: ConversationBackgroundTasks): void;
  /** 구독 결과 — 그 채널의 값을 통째로 바꾼다(끊긴 사이 끝난 작업이 남지 않게) */
  sync(channelId: string, list: readonly ConversationBackgroundTasks[]): void;
  reset(): void;
};

const isEmpty = (v: ConversationBackgroundTasks) => v.tasks.length === 0 && v.runnerConnected;

export const useBackgroundTaskStore = create<BackgroundTaskStore>()((set) => ({
  byChannel: {},
  apply: (channelId, value) =>
    set((s) => {
      const prev = s.byChannel[channelId] ?? {};
      if (isEmpty(value) && !(value.conversationId in prev)) return s;
      const { [value.conversationId]: _, ...rest } = prev;
      const next = isEmpty(value) ? rest : { ...rest, [value.conversationId]: value };
      return { byChannel: { ...s.byChannel, [channelId]: next } };
    }),
  sync: (channelId, list) =>
    set((s) => ({
      byChannel: {
        ...s.byChannel,
        [channelId]: Object.fromEntries(list.filter((v) => !isEmpty(v)).map((v) => [v.conversationId, v])),
      },
    })),
  reset: () => set({ byChannel: {} }),
}));

export type RunBackgroundTasks = { tasks: BackgroundTask[]; runnerConnected: boolean };
const NONE: RunBackgroundTasks = { tasks: [], runnerConnected: true };

/** 대화별 값 → 원래 런(`originRunId`)별 작업. 작업은 그 대화의 `runnerConnected` 를 함께 쥔다 */
export function groupByOriginRun(
  conversations: readonly ConversationBackgroundTasks[],
): Map<string, RunBackgroundTasks> {
  const out = new Map<string, RunBackgroundTasks>();
  for (const c of conversations) {
    for (const task of c.tasks) {
      const entry = out.get(task.originRunId) ?? { tasks: [], runnerConnected: true };
      entry.tasks.push(task);
      // 한 런의 작업은 한 대화에 있다 — 그래도 둘에 걸치면 하나라도 끊긴 쪽으로 본다
      entry.runnerConnected &&= c.runnerConnected;
      out.set(task.originRunId, entry);
    }
  }
  return out;
}

const EMPTY_CHANNEL: Record<string, ConversationBackgroundTasks> = {};

/**
 * 그 채널의 백그라운드 작업을 런 카드에 붙이는 길. `byRun(runId)` 는 그 런이 띄운 작업과 러너 연결,
 * `activeRunIds` 는 작업이 남은 런(거르기 「진행 중」에 끝난 런도 넣는다 — 스펙 5.7)
 */
export function useBackgroundTasks(channelId: string): {
  byRun(runId: string): RunBackgroundTasks;
  activeRunIds: ReadonlySet<string>;
} {
  const channel = useBackgroundTaskStore((s) => s.byChannel[channelId] ?? EMPTY_CHANNEL);
  return useMemo(() => {
    const grouped = groupByOriginRun(Object.values(channel));
    return { byRun: (runId) => grouped.get(runId) ?? NONE, activeRunIds: new Set(grouped.keys()) };
  }, [channel]);
}
