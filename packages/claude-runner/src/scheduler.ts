// 러너 전역 동시 CLI 상한(스펙 4.5 — 런 중 CLI 하나가 약 300 MiB). 같은 세션 id 의 두 query() 는 같은 전사 파일을
// 함께 쓰므로(ADR 0007 4.3) 돌거나 기다리는 세션이면 busy 로 거절한다 — 서버 세션 큐가 직렬화하므로 정상 경로에서는 나지 않는다.
// 백그라운드 작업을 쥔 붙든 프로세스(백그라운드 작업 스펙 5.2)도 자리 하나를 쓴다 — 상한이 메모리 때문에 있다. 붙든 세션에 오는
// 런은 그 프로세스의 다음 턴이라 자리를 더 쓰지 않는다

export type Job = (signal: AbortSignal) => Promise<void>;

type Entry = {
  runId: string;
  sessionId: string;
  job: Job;
  controller: AbortController;
  onDropped?: (reason?: unknown) => void;
  /** 붙든 세션 키 — 이 런이 붙들게 되면 그 자리를 이어 쓴다 */
  heldKey?: string;
};

export function createScheduler(max: number) {
  const running = new Map<string, Entry>();
  const queue: Entry[] = [];
  let idleWaiters: Array<() => void> = [];
  // 붙든 프로세스의 세션 키 — 하나가 자리 하나
  const held = new Set<string>();
  // 쓰는 자리 — 붙든 세션의 런은 그 세션의 자리를 쓴다(두 번 세지 않는다)
  const used = () =>
    held.size + [...running.values()].filter((e) => e.heldKey === undefined || !held.has(e.heldKey)).length;
  function drain(): void {
    while (queue.length > 0 && used() < max) start(queue.shift()!);
  }

  function start(entry: Entry): void {
    running.set(entry.runId, entry);
    let done: Promise<void>;
    try {
      done = entry.job(entry.controller.signal);
    } catch (error) {
      done = Promise.reject(error);
    }
    // 일의 실패는 일이 스스로 run.error 로 알린다 — 여기서는 자리만 돌려준다
    void done
      .catch(() => {})
      .finally(() => {
        running.delete(entry.runId);
        drain();
        if (running.size === 0) {
          const waiters = idleWaiters;
          idleWaiters = [];
          for (const w of waiters) w();
        }
      });
  }

  const sessionTaken = (sessionId: string) =>
    [...running.values(), ...queue].some((e) => e.sessionId === sessionId);

  return {
    /** onDropped — 시작하기 전에 대기열에서 빠졌을 때(abort·abortAll). 도는 런의 끝은 일이 스스로 알린다 */
    submit(
      runId: string,
      sessionId: string,
      job: Job,
      onDropped?: (reason?: unknown) => void,
      /** 그 런의 세션 키 — 붙든 세션이면 자리를 더 쓰지 않고 곧바로 돌린다 */
      heldKey?: string,
    ): { queuedPosition?: number; heldSlots?: number } | { busy: true } {
      if (sessionTaken(sessionId)) return { busy: true };
      const entry: Entry = {
        runId,
        sessionId,
        job,
        controller: new AbortController(),
        onDropped,
        ...(heldKey === undefined ? {} : { heldKey }),
      };
      if ((heldKey !== undefined && held.has(heldKey)) || used() < max) {
        start(entry);
        return {};
      }
      queue.push(entry);
      // 붙든 프로세스가 자리를 쥐고 있으면 그 수도 싣는다 — 기다리는 까닭(D7)
      return { queuedPosition: queue.length, ...(held.size > 0 ? { heldSlots: held.size } : {}) };
    },
    /** 그 세션의 프로세스를 붙들기 시작했다 — 자리 하나 */
    hold(key: string): void {
      held.add(key);
    },
    /** 붙든 프로세스를 놓았다 — 자리가 나면 기다리는 런을 시작한다 */
    unhold(key: string): void {
      if (held.delete(key)) drain();
    },
    heldCount(): number {
      return held.size;
    },
    /** 도는 런은 signal 로 멈추게 하고(interrupt → 5초 뒤 close 는 런이 한다), 기다리는 런은 시작하지 않고 뺀다 */
    abort(runId: string): void {
      const index = queue.findIndex((e) => e.runId === runId);
      if (index >= 0) queue.splice(index, 1)[0]?.onDropped?.();
      running.get(runId)?.controller.abort();
    },
    /** reason 은 도는 런의 signal.reason·기다리던 런의 onDropped 로 간다 — 러너 종료 중지를 사람 중지와 가른다 */
    abortAll(reason?: unknown): void {
      for (const e of queue.splice(0)) e.onDropped?.(reason);
      for (const e of running.values()) e.controller.abort(reason);
    },
    /** 도는 런과 기다리는 런의 수(붙든 프로세스는 세지 않는다 — 끝나지 않는 작업이 업데이트를 막지 않게, 스펙 5.6) */
    size(): number {
      return running.size + queue.length;
    },
    /** 도는 런이 하나도 없으면 풀린다 — 러너를 끝낼 때 중지한 런이 final 을 낼 때까지 기다린다 */
    idle(): Promise<void> {
      if (running.size === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}

export type Scheduler = ReturnType<typeof createScheduler>;
