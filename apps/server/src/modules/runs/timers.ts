/** 런별 타이머 종류. coalesce 는 델타 코얼레싱 flush. */
export type RunTimerKind = "queued" | "run" | "finalizing" | "coalesce";

export type RunTimers = {
  /** 같은 (runId, kind) 의 이전 타이머는 지우고 새로 건다 */
  set(runId: string, kind: RunTimerKind, ms: number, fn: () => void): void;
  /** kind 가 없으면 그 런의 타이머 전부 */
  clear(runId: string, kind?: RunTimerKind): void;
  has(runId: string, kind: RunTimerKind): boolean;
  clearAll(): void;
};

/** 전역 setTimeout 래퍼 — vitest fake timers 로 잰다. 메모리에는 타이머 핸들만 둔다. */
export function createRunTimers(): RunTimers {
  const byRun = new Map<string, Map<RunTimerKind, ReturnType<typeof setTimeout>>>();

  function clear(runId: string, kind?: RunTimerKind): void {
    const timers = byRun.get(runId);
    if (!timers) return;
    if (kind === undefined) {
      for (const handle of timers.values()) clearTimeout(handle);
      byRun.delete(runId);
      return;
    }
    clearTimeout(timers.get(kind));
    timers.delete(kind);
    if (timers.size === 0) byRun.delete(runId);
  }

  return {
    set(runId, kind, ms, fn) {
      clear(runId, kind);
      const handle = setTimeout(() => {
        const timers = byRun.get(runId);
        if (timers?.get(kind) === handle) {
          timers.delete(kind);
          if (timers.size === 0) byRun.delete(runId);
        }
        fn();
      }, ms);
      const timers = byRun.get(runId) ?? new Map<RunTimerKind, ReturnType<typeof setTimeout>>();
      timers.set(kind, handle);
      byRun.set(runId, timers);
    },
    clear,
    has(runId, kind) {
      return byRun.get(runId)?.has(kind) ?? false;
    },
    clearAll() {
      for (const runId of byRun.keys()) clear(runId);
    },
  };
}
