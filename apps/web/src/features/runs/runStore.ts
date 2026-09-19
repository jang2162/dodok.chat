import type { RunEvent, RunState } from "@dodok/shared";
import { create } from "zustand";

export const TERMINAL: ReadonlySet<RunState["status"]> = new Set(["done", "error", "aborted"]);

/** 런 하나의 화면 상태. terminalAt 은 이 탭이 종료 상태를 처음 본 시각(버블 정리 타이밍용, 스펙 4.6) */
export type RunView = { state: RunState; text: string; lastEventSeq: number; terminalAt?: number };

export function reduceState(prev: RunView | undefined, state: RunState, now: number): RunView {
  const base: RunView = prev ? { ...prev, state } : { state, text: "", lastEventSeq: 0 };
  if (TERMINAL.has(state.status) && base.terminalAt === undefined) base.terminalAt = now;
  return base;
}

/** seq 가 lastEventSeq 보다 클 때만 반영한다(재생과 실시간이 겹쳐도 한 번). 모르는 런(prev 없음)은 undefined — 입장 때 activeRuns 재생이 채운다 */
export function reduceEvent(prev: RunView | undefined, event: RunEvent): RunView | undefined {
  if (!prev || event.seq <= prev.lastEventSeq) return prev;
  if (event.type === "TEXT_MESSAGE_CONTENT")
    return { ...prev, text: prev.text + event.delta, lastEventSeq: event.seq };
  if (event.type === "TEXT_MESSAGE_REPLACE") return { ...prev, text: event.text, lastEventSeq: event.seq };
  return { ...prev, lastEventSeq: event.seq };
}

/** 처음부터(afterSeq 0) 재생한 이벤트로 새로 쌓는다. 이어 받기(afterSeq = lastEventSeq)는 reduceEvent 를 하나씩 */
export function reduceReplay(state: RunState, events: readonly RunEvent[], now: number): RunView {
  return events.reduce<RunView>((v, e) => reduceEvent(v, e) ?? v, reduceState(undefined, state, now));
}

type RunStore = {
  runs: Record<string, RunView>;
  applyState(state: RunState): void;
  applyEvent(event: RunEvent): void;
  applyReplay(state: RunState, events: readonly RunEvent[]): void;
  remove(runId: string): void;
  reset(): void;
};

export const useRunStore = create<RunStore>()((set) => ({
  runs: {},
  applyState: (state) =>
    set((s) => ({ runs: { ...s.runs, [state.id]: reduceState(s.runs[state.id], state, Date.now()) } })),
  applyEvent: (event) =>
    set((s) => {
      const next = reduceEvent(s.runs[event.runId], event);
      return next === s.runs[event.runId] || !next ? s : { runs: { ...s.runs, [event.runId]: next } };
    }),
  applyReplay: (state, events) =>
    set((s) => ({ runs: { ...s.runs, [state.id]: reduceReplay(state, events, Date.now()) } })),
  remove: (runId) =>
    set((s) => {
      if (!(runId in s.runs)) return s;
      const { [runId]: _, ...rest } = s.runs;
      return { runs: rest };
    }),
  reset: () => set({ runs: {} }),
}));

/**
 * 채널의 런을 id(uuid v7 = 생성 순) 오름차순으로. 부를 때마다 새 배열을 돌려주므로 컴포넌트에서는
 * 반드시 `useRunStore(useShallow(selectChannelRuns(id)))` 로 쓴다(그냥 쓰면 매 렌더 새 참조 → 무한 렌더).
 */
export const selectChannelRuns =
  (channelId: string) =>
  (s: RunStore): RunView[] =>
    Object.values(s.runs)
      .filter((v) => v.state.channelId === channelId)
      .sort((a, b) => (a.state.id < b.state.id ? -1 : 1));
