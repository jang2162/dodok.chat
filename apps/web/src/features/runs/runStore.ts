import { parseDodokSessionKey, type RunEvent, type RunState } from "@dodok/shared";
import { create } from "zustand";

export const TERMINAL: ReadonlySet<RunState["status"]> = new Set(["done", "error", "aborted"]);

/**
 * 런 하나의 화면 상태. terminalAt 은 이 탭이 종료 상태를 처음 본 시각(버블 정리 타이밍용, 스펙 4.6).
 * threadRootId 는 스레드 런이면 그 루트 — 버블·승인 카드를 스레드 패널에 그릴지 채널에 그릴지 가른다(판정 R3′)
 */
export type RunView = {
  state: RunState;
  text: string;
  lastEventSeq: number;
  terminalAt?: number;
  threadRootId?: string;
};

/** 스레드 소속은 run.state 의 threadRootId 가 1순위다 — queued 로 끝나는 런은 RUN_STARTED 가 없다. 뒤따른 상태에 빠져도 잊지 않는다 */
export function reduceState(prev: RunView | undefined, state: RunState, now: number): RunView {
  const base: RunView = prev ? { ...prev, state } : { state, text: "", lastEventSeq: 0 };
  const threadRootId = state.threadRootId ?? prev?.threadRootId;
  if (threadRootId !== undefined) base.threadRootId = threadRootId;
  if (TERMINAL.has(state.status) && base.terminalAt === undefined) base.terminalAt = now;
  return base;
}

/** run.state 에 threadRootId 가 없으면(옛 서버) RUN_STARTED 의 세션 키를 shared 파서로 푼다 — 채널 키는 채널 런 */
function startedThread(prev: RunView, event: RunEvent): RunView {
  if (event.type !== "RUN_STARTED" || prev.threadRootId !== undefined) return prev;
  const threadRootId = parseDodokSessionKey(event.sessionKey)?.threadRootId;
  return threadRootId === undefined ? prev : { ...prev, threadRootId };
}

/** seq 가 lastEventSeq 보다 클 때만 반영한다(재생과 실시간이 겹쳐도 한 번). 모르는 런(prev 없음)은 undefined — 입장 때 activeRuns 재생이 채운다 */
export function reduceEvent(prev: RunView | undefined, event: RunEvent): RunView | undefined {
  if (!prev || event.seq <= prev.lastEventSeq) return prev;
  if (event.type === "TEXT_MESSAGE_CONTENT")
    return { ...prev, text: prev.text + event.delta, lastEventSeq: event.seq };
  if (event.type === "TEXT_MESSAGE_REPLACE") return { ...prev, text: event.text, lastEventSeq: event.seq };
  return { ...startedThread(prev, event), lastEventSeq: event.seq };
}

/** 처음부터(afterSeq 0) 재생한 이벤트로 새로 쌓는다. 이어 받기(afterSeq = lastEventSeq)는 reduceEvent 를 하나씩 */
export function reduceReplay(state: RunState, events: readonly RunEvent[], now: number): RunView {
  return events.reduce<RunView>((v, e) => reduceEvent(v, e) ?? v, reduceState(undefined, state, now));
}

type RunStore = {
  runs: Record<string, RunView>;
  /**
   * 스레드 런 id → 루트. `remove` 로 런을 지워도 남긴다 — 그 런의 확정된 승인 카드가 기록으로 남는 동안
   * 어느 목록(채널·스레드)에 그릴지 알아야 한다. `reset` 에서만 비운다
   */
  threads: Record<string, string>;
  applyState(state: RunState): void;
  applyEvent(event: RunEvent): void;
  applyReplay(state: RunState, events: readonly RunEvent[]): void;
  remove(runId: string): void;
  reset(): void;
};

/** 런 하나를 바꾸고, 스레드 런이면 소속을 기록한다(이미 같으면 threads 는 그대로) */
function put(s: RunStore, view: RunView): Pick<RunStore, "runs" | "threads"> {
  const id = view.state.id;
  const runs = { ...s.runs, [id]: view };
  const rootId = view.threadRootId;
  return rootId === undefined || s.threads[id] === rootId
    ? { runs, threads: s.threads }
    : { runs, threads: { ...s.threads, [id]: rootId } };
}

export const useRunStore = create<RunStore>()((set) => ({
  runs: {},
  threads: {},
  applyState: (state) => set((s) => put(s, reduceState(s.runs[state.id], state, Date.now()))),
  applyEvent: (event) =>
    set((s) => {
      const next = reduceEvent(s.runs[event.runId], event);
      return next === s.runs[event.runId] || !next ? s : put(s, next);
    }),
  applyReplay: (state, events) => set((s) => put(s, reduceReplay(state, events, Date.now()))),
  remove: (runId) =>
    set((s) => {
      if (!(runId in s.runs)) return s;
      const { [runId]: _, ...rest } = s.runs;
      return { runs: rest };
    }),
  reset: () => set({ runs: {}, threads: {} }),
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

/**
 * 한 목록(채널 타임라인 또는 스레드 하나)의 런 — `threadRootId` 가 없으면 채널 런만, 있으면 그 스레드 런만(판정 R3′).
 * 쓰는 법은 `selectChannelRuns` 와 같다(`useShallow` 로)
 */
export const selectScopeRuns =
  (channelId: string, threadRootId?: string) =>
  (s: RunStore): RunView[] =>
    selectChannelRuns(channelId)(s).filter((v) => v.threadRootId === threadRootId);
