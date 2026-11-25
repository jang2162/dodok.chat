import { parseDodokSessionKey, type RunEvent, type RunState } from "@dodok/shared";
import { create } from "zustand";
import { isTimelineEvent } from "@/features/activity/timeline";

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
  /** 런이 시작된 루트 글·부른 글(run.state) — 답 묶음이 줄을 루트 아래 세운다. 뒤따른 상태에 빠져도 잊지 않는다 */
  rootMessageId?: string;
  triggerMessageId?: string;
  /** 러너 자리를 쥔 붙든 프로세스 수 — 그 까닭으로 기다리는 런의 RUN_QUEUED 가 싣는다(백그라운드 작업 스펙 D7) */
  heldSlots?: number;
};

/**
 * 답 묶음이 보는 런의 루트와 마지막 상태 — `remove` 로 런을 지워도 남긴다. 메시지에 `runRoot` 가 실리더라도 이 저장소가 있어야 하는 까닭은
 * 둘이다: run.state 로 메시지보다 먼저 루트를 알고, 메시지가 아직 없는 런도 줄이 선다
 */
export type RunRoot = {
  runId: string;
  agentId: string;
  channelId: string;
  conversationId: string;
  threadRootId?: string;
  rootMessageId: string;
  triggerMessageId?: string;
  status: RunState["status"];
};

/** 스레드 소속은 run.state 의 threadRootId 가 1순위다 — queued 로 끝나는 런은 RUN_STARTED 가 없다. 뒤따른 상태에 빠져도 잊지 않는다 */
export function reduceState(prev: RunView | undefined, state: RunState, now: number): RunView {
  const base: RunView = prev ? { ...prev, state } : { state, text: "", lastEventSeq: 0 };
  // 빠지면 prev 의 것(펼침)이 남는다
  if (state.threadRootId !== undefined) base.threadRootId = state.threadRootId;
  if (state.rootMessageId !== undefined) base.rootMessageId = state.rootMessageId;
  if (state.triggerMessageId !== undefined) base.triggerMessageId = state.triggerMessageId;
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
  if (event.type === "RUN_QUEUED") {
    const { heldSlots: _, ...rest } = prev;
    const held = event.heldSlots ?? 0;
    return { ...rest, ...(held > 0 && { heldSlots: held }), lastEventSeq: event.seq };
  }
  return { ...startedThread(prev, event), lastEventSeq: event.seq };
}

/** 처음부터(afterSeq 0) 재생한 이벤트로 새로 쌓는다. 이어 받기(afterSeq = lastEventSeq)는 reduceEvent 를 하나씩 */
export function reduceReplay(state: RunState, events: readonly RunEvent[], now: number): RunView {
  return events.reduce<RunView>((v, e) => reduceEvent(v, e) ?? v, reduceState(undefined, state, now));
}

/**
 * 런 하나의 활동 이벤트(추론·도구 등 행이 되는 것만 — 텍스트 델타는 빼서 델타마다 참조가 바뀌지 않게).
 * `fromStart` 는 처음(seq 1)부터 보고 있는가, `complete` 는 거기에 더해 끝 이벤트(RUN_FINISHED·RUN_ERROR·RUN_ABORTED)까지
 * 직접 봤는가 — 확정 메시지는 `complete` 일 때만 REST 없이 그린다(스펙 「모양」 막 끝난 런). 상태(run.state)로만 끝을 알았거나
 * 끝을 못 본 채 지운 런(끊긴 사이 끝남)은 사이 이벤트를 놓쳤을 수 있어 미완으로 남고, 메시지는 펼칠 때 받는다
 */
export type RunActivity = { events: readonly RunEvent[]; fromStart: boolean; complete: boolean };

/** `remove` 뒤에도 남기는 활동 기록 수 — 지운 런 가운데 최근 것만(긴 탭이 기록을 끝없이 쌓지 않게) */
export const ACTIVITY_KEEP = 50;

const EMPTY_ACTIVITY: RunActivity = { events: [], fromStart: true, complete: false };

const END_TYPES: ReadonlySet<RunEvent["type"]> = new Set(["RUN_FINISHED", "RUN_ERROR", "RUN_ABORTED"]);
const isEndEvent = (event: RunEvent): boolean => END_TYPES.has(event.type);

/** 활동 이벤트 하나를 잇는다(seq 가 이미 있으면 그대로). 행도 끝도 아닌 이벤트는 참조를 바꾸지 않는다 */
function addActivity(prev: RunActivity | undefined, event: RunEvent): RunActivity | undefined {
  const base = prev ?? { events: [], fromStart: false, complete: false };
  const ended = base.fromStart && !base.complete && isEndEvent(event);
  const row = isTimelineEvent(event) && !base.events.some((e) => e.seq === event.seq);
  if (!ended && !row) return prev;
  return {
    ...base,
    ...(row && { events: [...base.events, event] }),
    ...(ended && { complete: true }),
  };
}

type RunStore = {
  runs: Record<string, RunView>;
  /** 런 id → 활동 기록. `remove` 해도 최근 `ACTIVITY_KEEP` 개는 남긴다 — 버블이 내려간 뒤 확정 메시지가 이어 쓴다. `reset` 에서만 비운다 */
  activity: Record<string, RunActivity>;
  /**
   * 스레드 런 id → 루트. `remove` 로 런을 지워도 남긴다 — 그 런의 확정된 승인 카드가 기록으로 남는 동안
   * 어느 목록(채널·스레드)에 그릴지 알아야 한다. `reset` 에서만 비운다
   */
  threads: Record<string, string>;
  /** 런 id → 루트(`RunRoot`). `remove` 해도 남기고 `reset` 에서만 비운다 */
  roots: Record<string, RunRoot>;
  applyState(state: RunState): void;
  applyEvent(event: RunEvent): void;
  applyReplay(state: RunState, events: readonly RunEvent[]): void;
  remove(runId: string): void;
  reset(): void;
};

/** 런 하나를 바꾸고, 스레드 런이면 소속을 기록한다(이미 같으면 threads 는 그대로) */
function put(s: RunStore, view: RunView): Pick<RunStore, "runs" | "threads" | "roots"> {
  const id = view.state.id;
  const runs = { ...s.runs, [id]: view };
  const rootId = view.threadRootId;
  const threads =
    rootId === undefined || s.threads[id] === rootId ? s.threads : { ...s.threads, [id]: rootId };
  return { runs, threads, roots: putRoot(s.roots, view) };
}

/** 루트를 아는 런이면 roots 를 맞춘다 — 같으면 참조를 그대로 둔다(델타마다 구독자가 다시 그리지 않게) */
function putRoot(roots: Record<string, RunRoot>, view: RunView): Record<string, RunRoot> {
  if (view.rootMessageId === undefined) return roots;
  const { state } = view;
  const prev = roots[state.id];
  if (
    prev &&
    prev.status === state.status &&
    prev.threadRootId === view.threadRootId &&
    prev.rootMessageId === view.rootMessageId
  )
    return roots;
  const next: RunRoot = {
    runId: state.id,
    agentId: state.agentId,
    channelId: state.channelId,
    conversationId: state.conversationId,
    rootMessageId: view.rootMessageId,
    status: state.status,
  };
  if (view.threadRootId !== undefined) next.threadRootId = view.threadRootId;
  if (view.triggerMessageId !== undefined) next.triggerMessageId = view.triggerMessageId;
  return { ...roots, [state.id]: next };
}

/** 지운 런의 활동 기록 가운데 오래된 것(id = uuid v7 생성 순)을 `ACTIVITY_KEEP` 개만 남기고 버린다 */
function pruneActivity(
  activity: Record<string, RunActivity>,
  runs: Record<string, RunView>,
): Record<string, RunActivity> {
  const gone = Object.keys(activity).filter((id) => !(id in runs));
  if (gone.length <= ACTIVITY_KEEP) return activity;
  const drop = new Set(gone.sort().slice(0, gone.length - ACTIVITY_KEEP));
  return Object.fromEntries(Object.entries(activity).filter(([id]) => !drop.has(id)));
}

export const useRunStore = create<RunStore>()((set) => ({
  runs: {},
  threads: {},
  roots: {},
  activity: {},
  applyState: (state) =>
    set((s) => {
      const next = put(s, reduceState(s.runs[state.id], state, Date.now()));
      // 대기로 처음 본 런은 처음부터 보는 것이다(런은 queued 로 생긴다) — 끝 이벤트까지 보면 빈 기록도 사실이다
      if (s.runs[state.id] || s.activity[state.id] || state.status !== "queued") return next;
      return { ...next, activity: { ...s.activity, [state.id]: EMPTY_ACTIVITY } };
    }),
  applyEvent: (event) =>
    set((s) => {
      const prev = s.runs[event.runId];
      const next = reduceEvent(prev, event);
      if (next === prev || !next) return s;
      const had = s.activity[event.runId];
      const activity = addActivity(had, event);
      return activity === undefined || activity === had
        ? put(s, next)
        : { ...put(s, next), activity: { ...s.activity, [event.runId]: activity } };
    }),
  applyReplay: (state, events) =>
    set((s) => ({
      ...put(s, reduceReplay(state, events, Date.now())),
      // 처음부터(afterSeq 0) 재생했다 — 앞서 모은 것보다 이쪽이 온전하다
      activity: {
        ...s.activity,
        [state.id]: {
          events: events.filter(isTimelineEvent),
          fromStart: true,
          complete: events.some(isEndEvent),
        },
      },
    })),
  remove: (runId) =>
    set((s) => {
      if (!(runId in s.runs)) return s;
      const { [runId]: _, ...rest } = s.runs;
      return { runs: rest, activity: pruneActivity(s.activity, rest) };
    }),
  reset: () => set({ runs: {}, threads: {}, roots: {}, activity: {} }),
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
 * 한 목록(세션 타임라인 또는 그 세션의 스레드 하나)의 런 — 그 세션의 것만(채널 세션 계획 판정 PS7), 그 가운데 `threadRootId` 가 없으면
 * 세션 런만, 있으면 그 스레드 런만(판정 R3′). 쓰는 법은 `selectChannelRuns` 와 같다(`useShallow` 로)
 */
export const selectScopeRuns =
  (channelId: string, conversationId: string, threadRootId?: string) =>
  (s: RunStore): RunView[] =>
    selectChannelRuns(channelId)(s).filter(
      (v) => v.state.conversationId === conversationId && v.threadRootId === threadRootId,
    );
