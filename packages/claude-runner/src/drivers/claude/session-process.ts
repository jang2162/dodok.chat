import type {
  BackgroundTask,
  InboundDeliver,
  RunnerFollowupRequest,
  RunnerFollowupResult,
} from "@dodok/shared";
import type { createPoster } from "../../post-tool";
import type { RunSink } from "../../sink";
import type { AlwaysAllowed } from "./approvals";
import type { CanUseTool, SdkMessage, SdkQuery, SdkUserMessage } from "./sdk";
import { createTaskTracker, type TaskTracker } from "./tasks";

// 세션 프로세스(백그라운드 작업 스펙 5.2) — CLI 프로세스(query() 하나)와 그 입력·읽기를 쥔다. 런 하나의 시작·final·error 판정은
// run.ts 가 하고, 여기는 「지금 어느 런의 턴인가」와 「작업이 남아 프로세스를 붙드는가」만 맡는다.
// - 읽기는 프로세스마다 하나다(pump). 턴이 열려 있으면 그 턴으로, 없으면 쉬는 동안의 메시지(작업 알림 등)로 간다
// - 붙든 프로세스에는 런이 바뀔 때마다 바인딩(지금 런의 deliver·runId·signal·턴 사실·「항상 허용」)을 갈아 끼운다 — 도구·승인·훅은
//   bindingRef 를 통해서만 런을 본다. 안 그러면 다음 런의 글이 첫 런의 deliver 로 나간다
// - hooks 가 없으면(옛 연결·시험) 붙들지 않는다 — 첫 result 에서 닫는 지금 동작 그대로

export type BackgroundHooks = {
  /** CLI 가 작업 알림 뒤 스스로 연 턴 — 서버에 추가 응답 런을 청한다(Task 4) */
  requestFollowup(req: RunnerFollowupRequest): Promise<RunnerFollowupResult>;
  /** 그 세션의 작업 전체가 바뀌었다(바꿔 끼우는 값) — 연결이 세션마다 1초로 묶어 tasks.update 로 낸다 */
  tasksChanged(sessionKey: string, tasks: BackgroundTask[]): void;
  /** 그 세션의 프로세스를 붙들기 시작했다·놓았다 — 스케줄러 자리(Task 5) */
  held(sessionKey: string, holding: boolean): void;
};

/** 지금 턴의 런 — 도구·승인·훅이 이 값을 읽는다 */
export type RunBinding = {
  runId: string;
  deliver: InboundDeliver;
  sessionKey: string;
  signal: AbortSignal;
  turnFacts: string;
  permissionMode: string;
  /** 런 단위 「항상 허용」 — 프로세스 단위로 넓히지 않는다(스펙 5.2, 보안) */
  alwaysAllowed: AlwaysAllowed;
  sink: RunSink;
  post: ReturnType<typeof createPoster>;
  canUseTool: CanUseTool;
};

/** 한 턴의 메시지 — result 를 받아 run.ts 가 done() 하거나 프로세스가 끝날 때까지 */
export type Turn = AsyncIterable<SdkMessage> & { done(): void };

export type SessionProcess = {
  readonly sessionKey: string;
  readonly sessionId: string;
  readonly bindingRef: { current: RunBinding };
  readonly tracker: TaskTracker;
  /** query() 의 prompt — send 로 넣고 endInput 으로 닫는다 */
  input(): AsyncIterable<SdkUserMessage>;
  attach(q: SdkQuery): void;
  query(): SdkQuery;
  /** 바인딩을 갈아 끼우고 턴을 연다 — 그 뒤의 메시지는 이 턴으로 간다 */
  turn(binding: RunBinding): Turn;
  send(message: SdkUserMessage): void;
  endInput(): void;
  /**
   * 턴을 마친다(그 턴의 final·error 를 낸 뒤). 작업이 남았으면 붙들고 true — 턴을 떼어 낸다. 아니면 입력을 닫고 유예 뒤 닫는다
   * (false — 턴은 프로세스가 끝날 때까지 붙어 있어 run.ts 가 끝까지 읽는다)
   */
  finishTurn(): boolean;
  holding(): boolean;
  /** 이 프로세스에 런을 더 넣을 수 있나 — 붙들려 있고 끝나지 않았다 */
  reusable(): boolean;
  /** 작업을 모두 버리고 닫는다(세션 닫기·보관·리셋) — 도는 턴은 interrupt */
  release(): void;
  closeLater(): void;
  cancelClose(): void;
  close(): void;
  /** 프로세스(읽기)가 끝나면 풀린다 */
  readonly exited: Promise<void>;
  /** 프로세스가 끝날 때 한 번 — 런보다 오래 사는 것(명령 감싸개 임시 디렉터리)을 치운다 */
  onExit(fn: () => unknown): void;
};

export function createSessionProcess(o: {
  sessionKey: string;
  sessionId: string;
  binding: RunBinding;
  hooks?: BackgroundHooks;
  now: () => number;
  closeGraceMs: number;
  /** 다음 런이 이 프로세스로 오지 않게 될 때(놓기·끝남) 한 번 — 드라이버가 세션 맵에서 뺀다 */
  onRelease?: () => void;
}): SessionProcess {
  const bindingRef = { current: o.binding };
  let turnOpen = false;
  const tracker = createTaskTracker({
    now: o.now,
    mask: o.binding.sink.mask,
    currentRunId: () => (turnOpen ? bindingRef.current.runId : undefined),
  });
  let q: SdkQuery | undefined;
  let held = false;
  let released = false;
  let dead = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const exitFns: Array<() => unknown> = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => (markExited = resolve));

  // ── 입력 — send 로 쌓고 endInput 으로 닫는다
  const pendingInput: SdkUserMessage[] = [];
  let inputEnded = false;
  let wakeInput: (() => void) | undefined;
  async function* input(): AsyncGenerator<SdkUserMessage> {
    for (;;) {
      const next = pendingInput.shift();
      if (next) {
        yield next;
        continue;
      }
      if (inputEnded) return;
      await new Promise<void>((resolve) => (wakeInput = resolve));
      wakeInput = undefined;
    }
  }
  const send = (m: SdkUserMessage) => {
    pendingInput.push(m);
    wakeInput?.();
  };
  const endInput = () => {
    inputEnded = true;
    wakeInput?.();
  };

  // ── 턴
  type TurnState = {
    push(m: SdkMessage): void;
    end(failure?: { error: unknown }): void;
  };
  let current: TurnState | undefined;

  function openTurn(binding: RunBinding): Turn {
    bindingRef.current = binding;
    turnOpen = true;
    const buf: SdkMessage[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: { error: unknown } | undefined;
    let detached = false;
    const state: TurnState = {
      push(m) {
        buf.push(m);
        wake?.();
      },
      end(f) {
        finished = true;
        failure = f;
        wake?.();
      },
    };
    current = state;
    // 프로세스가 이미 끝났으면 턴도 곧바로 끝난다
    if (dead) state.end();
    return {
      done() {
        detached = true;
        if (current === state) {
          current = undefined;
          turnOpen = false;
          // run.ts 가 result 를 다루는 사이 읽기가 앞서 쌓은 것(작업 알림·스스로 연 턴의 init)은 쉬는 동안의 메시지로 넘긴다
          for (const m of buf.splice(0)) idle(m);
        }
        wake?.();
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const m = buf.shift();
          if (m) {
            yield m;
            continue;
          }
          if (detached) return;
          if (finished) {
            if (failure) throw failure.error;
            return;
          }
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
        }
      },
    };
  }

  // ── 붙들기·놓기
  function setHeld(next: boolean) {
    if (held === next) return;
    held = next;
    o.hooks?.held(o.sessionKey, next);
    if (!next) o.hooks?.tasksChanged(o.sessionKey, []);
  }
  function releaseOnce() {
    if (released) return;
    released = true;
    o.onRelease?.();
  }
  const closeLater = () => {
    closeTimer ??= setTimeout(() => q?.close(), o.closeGraceMs);
  };
  const cancelClose = () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = undefined;
  };
  // 붙든 프로세스는 작업이 비고 도는 턴이 없으면 닫는다(짧은 유예 — closeLater 와 같은 길)
  function closeIdle() {
    setHeld(false);
    releaseOnce();
    endInput();
    closeLater();
  }

  // 쉬는 동안의 메시지 — 작업 상태는 읽을 때 이미 반영했다
  function idle(_m: SdkMessage) {
    if (held && tracker.size() === 0) closeIdle();
  }

  function onMessage(m: SdkMessage) {
    if (o.hooks) {
      const r = tracker.apply(m);
      if (r.changed) o.hooks.tasksChanged(o.sessionKey, tracker.list());
    }
    if (current) current.push(m);
    else idle(m);
  }

  async function pump(query: SdkQuery) {
    let failure: { error: unknown } | undefined;
    try {
      for await (const m of query as AsyncIterable<SdkMessage>) onMessage(m);
    } catch (error) {
      failure = { error };
    }
    dead = true;
    cancelClose();
    current?.end(failure);
    current = undefined;
    turnOpen = false;
    setHeld(false);
    releaseOnce();
    tracker.reset();
    for (const fn of exitFns.splice(0)) {
      try {
        await fn();
      } catch {
        // 치우기 실패는 런에 닿지 않는다
      }
    }
    markExited();
  }

  return {
    sessionKey: o.sessionKey,
    sessionId: o.sessionId,
    bindingRef,
    tracker,
    input,
    attach(query) {
      q = query;
      void pump(query);
    },
    query() {
      if (!q) throw new Error("session process: query not attached");
      return q;
    },
    turn: openTurn,
    send,
    endInput,
    finishTurn() {
      if (o.hooks && !dead && !released && tracker.size() > 0) {
        cancelClose();
        setHeld(true);
        // 턴은 run.ts 가 곧바로 done() 으로 뗀다 — 그때 쌓인 메시지가 쉬는 동안의 길로 간다
        return true;
      }
      // 턴은 떼지 않는다 — run.ts 가 프로세스가 끝날 때까지 읽는다(지금 동작)
      setHeld(false);
      releaseOnce();
      endInput();
      closeLater();
      return false;
    },
    holding: () => held,
    reusable: () => held && !dead && !released,
    release() {
      if (current) q?.interrupt().catch(() => {});
      closeIdle();
    },
    closeLater,
    cancelClose,
    close: () => q?.close(),
    exited,
    onExit(fn) {
      if (dead) void Promise.resolve().then(fn);
      else exitFns.push(fn);
    },
  };
}
