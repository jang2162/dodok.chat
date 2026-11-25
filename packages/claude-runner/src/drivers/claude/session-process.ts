import type { InboundDeliver, RunnerFollowupRequest, RunnerFollowupResult } from "@dodok/shared";
import type { BackgroundHooks } from "../../driver";
import type { createPoster } from "../../post-tool";
import type { RunSink } from "../../sink";
import type { AlwaysAllowed } from "./approvals";
import type { CanUseTool, SdkMessage, SdkQuery, SdkUserMessage } from "./sdk";
import { createTaskTracker, type TaskNotice, type TaskTracker } from "./tasks";

// 세션 프로세스(백그라운드 작업 스펙 5.2·5.3) — CLI 프로세스(query() 하나)와 그 입력·읽기를 쥔다. 런 하나의 시작·final·error 판정은
// run.ts 가 하고, 여기는 「지금 어느 런의 턴인가」와 「작업이 남아 프로세스를 붙드는가」만 맡는다.
// - 읽기는 프로세스마다 하나다(pump). 턴이 열려 있으면 그 턴으로, 없으면 쉬는 동안의 메시지(작업 알림 등)로 간다
// - 붙든 프로세스에는 런이 바뀔 때마다 바인딩(지금 런의 deliver·runId·signal·턴 사실·「항상 허용」)을 갈아 끼운다 — 도구·승인·훅은
//   bindingRef 를 통해서만 런을 본다. 안 그러면 다음 런의 글이 첫 런의 deliver 로 나간다
// - 한 번에 한 턴 — 도는 턴(사람·추가 응답)에 사람 글을 넣으면 CLI 가 그 턴에 합친다(ADR 0007 5.11 질문 2). 사람 런은 도는 턴의
//   result 뒤로 기다린다(whenIdle)
// - 쉬는 동안 온 system/init 은 CLI 가 작업 알림 뒤 스스로 연 턴이다(ADR 5.11 — init 은 사람 턴마다도 오지만 그때는 턴이 열려 있다).
//   그 사이 온 알림의 작업으로 서버에 추가 응답 런을 청하고, 답이 오기 전 메시지는 쥐었다가 그 런의 턴으로 넘긴다. 거절이면 interrupt
// - hooks 가 없거나 서버가 지원을 알리지 않았으면(canHold 거짓 — 옛 서버) 붙들지 않는다 — 첫 result 에서 닫는 지금 동작 그대로

/** 알림 뒤 CLI 가 턴을 열기를 기다리는 시간 — 실측은 약 10ms(ADR 5.11 시나리오 1). 넘으면 턴이 없는 것으로 보고 닫기를 다시 본다 */
export const SELF_TURN_WAIT_MS = 10_000;

// 훅 계약은 프로그램 공통(driver.ts) — 연결이 채운다
export type { BackgroundHooks, FollowupRun } from "../../driver";

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

/** 서버가 받아 준 추가 응답 — run.ts 가 그 런의 턴을 돌린다(sp.turn 이 쥔 메시지를 먼저 흘린다) */
export type SelfTurnHandler = (run: { runId: string; deliver: InboundDeliver }) => Promise<void>;

export type SessionProcess = {
  readonly sessionKey: string;
  readonly sessionId: string;
  readonly bindingRef: { current: RunBinding };
  readonly tracker: TaskTracker;
  /** query() 의 prompt — send 로 넣고 endInput 으로 닫는다 */
  input(): AsyncIterable<SdkUserMessage>;
  attach(q: SdkQuery): void;
  query(): SdkQuery;
  /** 바인딩을 갈아 끼우고 턴을 연다 — 그 뒤의 메시지는 이 턴으로 간다(스스로 연 턴이면 쥐어 둔 것부터) */
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
  /** 도는 턴이 없다 — 사람 프롬프트를 지금 넣어도 된다 */
  idleNow(): boolean;
  /**
   * 도는 턴이 끝나기를 기다린다(한 번에 한 턴). 풀리면 그 자리를 이 호출자가 쥔다 — 곧바로 turn() 을 열거나 unreserve() 한다.
   * signal 이 끊기면 false(대기열에서 빠진다)
   */
  whenIdle(signal: AbortSignal): Promise<boolean>;
  unreserve(): void;
  /** 스스로 연 턴을 서버가 받아 주면 부르는 것 — run.ts 가 프로세스를 연 뒤 건다 */
  onSelfTurn(handler: SelfTurnHandler): void;
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

const isType = (m: SdkMessage, type: string, subtype?: string) => {
  const x = m as { type?: string; subtype?: string };
  return x.type === type && (subtype === undefined || x.subtype === subtype);
};

/** 그 알림 뒤에 CLI 가 턴을 여는가 — 끈 셸만 열지 않는다(ADR 5.11 질문 3: 그 알림은 다음 사람 입력에 붙는다) */
const opensTurn = (n: TaskNotice) => n.status !== "stopped" || n.kind === "subagent";

export function createSessionProcess(o: {
  sessionKey: string;
  sessionId: string;
  /** 작업 디렉터리 — 추가 응답 런의 sink 가림 뿌리 */
  workdir: string;
  binding: RunBinding;
  hooks?: BackgroundHooks;
  now: () => number;
  closeGraceMs: number;
  /** 시험이 줄인다 — 기본 SELF_TURN_WAIT_MS */
  selfTurnWaitMs?: number;
  log?: (line: string) => void;
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
  let selfTurnHandler: SelfTurnHandler | undefined;

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

  // ── 스스로 연 턴
  // 쉬는 동안 받은 알림 중 턴을 여는 것 — 다음 init 이 그 턴이다
  let pendingNotices: TaskNotice[] = [];
  // 읽을 때 본 알림 — 턴에 쌓였다가 쉬는 길로 넘어온 알림 메시지를 이것으로 읽는다(그때는 tracker 가 이미 잊었다)
  const notices = new Map<string, TaskNotice>();
  // 추가 응답을 청한 뒤 답을 기다리는 동안 쥔 메시지. 있으면 그 턴이 도는 중이다
  let selfBuffer: SdkMessage[] | undefined;
  // 서버가 받아 준 추가 응답 턴을 run.ts 가 돌리는 중
  let selfRunning = false;
  // 거절된 스스로 연 턴 — interrupt 뒤 그 result 까지 버린다
  let dropping = false;
  let selfWaitTimer: ReturnType<typeof setTimeout> | undefined;

  // ── 한 번에 한 턴 — 기다리는 사람 런
  type Waiter = { resolve(ok: boolean): void };
  const waiters: Waiter[] = [];
  let reserved = false;

  // ── 턴
  type TurnState = {
    push(m: SdkMessage): void;
    end(failure?: { error: unknown }): void;
  };
  let current: TurnState | undefined;

  const idleNow = () =>
    !current && selfBuffer === undefined && !selfRunning && !dropping && !dead && !released;

  // 자리가 비면 기다리는 사람 런 하나를 깨운다. 프로세스가 끝나 가면 모두 깨운다 — 그들은 reusable 을 보고 새로 연다
  function settle() {
    if (dead || released) {
      reserved = false;
      for (const w of waiters.splice(0)) w.resolve(true);
      return;
    }
    if (reserved || !idleNow()) return;
    const w = waiters.shift();
    if (!w) return;
    reserved = true;
    w.resolve(true);
  }

  function openTurn(binding: RunBinding): Turn {
    bindingRef.current = binding;
    turnOpen = true;
    reserved = false;
    // 사람 턴이 알림보다 먼저 열리면 CLI 가 그 알림을 이 턴에 붙인다 — 따로 추가 응답을 만들지 않는다(스펙 5.3)
    pendingNotices = [];
    const buf: SdkMessage[] = selfBuffer ?? [];
    selfBuffer = undefined;
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
          settle();
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
  // 스케줄러 자리(hooks.held)는 프로세스가 실제로 끝날 때 돌려준다 — 놓은 뒤에도 CLI 는 유예(closeGraceMs)까지 살아 있으므로
  // 곧바로 돌려주면 그 사이 다른 런이 시작돼 잠깐 상한을 넘는다
  let slotHeld = false;
  function setHeld(next: boolean) {
    if (held === next) return;
    held = next;
    if (next) {
      slotHeld = true;
      o.hooks?.held(o.sessionKey, true);
      return;
    }
    o.hooks?.tasksChanged(o.sessionKey, []);
    if (dead) freeSlot();
  }
  function freeSlot() {
    if (!slotHeld) return;
    slotHeld = false;
    o.hooks?.held(o.sessionKey, false);
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
    if (selfWaitTimer) clearTimeout(selfWaitTimer);
    setHeld(false);
    released = true;
    endInput();
    closeLater();
    settle();
  }
  // 셸 알림 순서에 기댄다 — CLI 는 task_notification 을 먼저, 빈 background_tasks_changed 를 그 뒤에 보낸다(ADR 0007 5.11 실측).
  // 그래서 목록이 비는 때에는 그 알림이 이미 pendingNotices 에 있어 닫지 않고 스스로 열 턴을 기다린다. 빈 목록이 먼저 오면
  // 알림 전에 닫아 추가 응답을 잃는다 — CLI 판을 올릴 때 이 순서를 다시 본다
  function maybeCloseIdle() {
    if (held && idleNow() && !reserved && tracker.size() === 0 && pendingNotices.length === 0) closeIdle();
  }

  function startSelfTurn(first: SdkMessage) {
    const opening = pendingNotices;
    pendingNotices = [];
    if (selfWaitTimer) clearTimeout(selfWaitTimer);
    selfBuffer = [first];
    const origin = opening[0];
    if (!o.hooks || !selfTurnHandler || origin === undefined) {
      // 어느 런에도 이을 수 없는 턴 — 멈추고 버린다
      rejectSelfTurn();
      return;
    }
    const request: RunnerFollowupRequest = {
      sessionKey: o.sessionKey,
      originRunId: origin.originRunId,
      taskIds: [...new Set(opening.map((n) => n.taskId))].slice(0, 50),
    };
    const handler = selfTurnHandler;
    void o.hooks
      .requestFollowup(request)
      .catch((): RunnerFollowupResult => ({ ok: false, reason: "unknown" }))
      .then(async (r) => {
        if (!r.ok || dead || released) {
          if (r.ok) {
            // 그사이 프로세스를 놓았다 — 서버의 런은 메시지 없이 닫는다
            const run = o.hooks!.openFollowup({ runId: r.runId, deliver: r.deliver, workdir: o.workdir });
            run.sink.final({ text: "", stopReason: "aborted", costKind: "subscription_estimate" });
            run.close();
          }
          if (selfBuffer !== undefined) rejectSelfTurn();
          return;
        }
        selfRunning = true;
        try {
          await handler({ runId: r.runId, deliver: r.deliver });
        } catch (error) {
          o.log?.(`dodok-runner: 추가 응답 턴 실패 — ${String(error)}`);
        } finally {
          selfRunning = false;
          // 턴이 열리지도 못했으면 쥔 것을 버린다
          if (selfBuffer !== undefined) rejectSelfTurn();
          settle();
          maybeCloseIdle();
        }
      });
  }

  function rejectSelfTurn() {
    const buf = selfBuffer ?? [];
    selfBuffer = undefined;
    // 이미 끝난 턴이면(쥔 것에 result 가 있다) 멈출 것이 없다
    if (buf.some((m) => isType(m, "result"))) {
      settle();
      maybeCloseIdle();
      return;
    }
    dropping = true;
    q?.interrupt().catch(() => {});
  }

  // 쉬는 동안의 메시지 — 작업 상태는 읽을 때 이미 반영했다
  function idle(m: SdkMessage) {
    if (dropping) {
      if (isType(m, "result")) {
        dropping = false;
        settle();
        maybeCloseIdle();
      }
      return;
    }
    if (selfBuffer !== undefined) {
      selfBuffer.push(m);
      return;
    }
    if (isType(m, "system", "task_notification")) {
      const n = notices.get((m as { task_id?: string }).task_id ?? "");
      if (n && opensTurn(n) && held) {
        pendingNotices.push(n);
        if (selfWaitTimer) clearTimeout(selfWaitTimer);
        selfWaitTimer = setTimeout(() => {
          // 턴이 열리지 않았다 — 기다림을 거두고 닫기를 다시 본다
          pendingNotices = [];
          maybeCloseIdle();
        }, o.selfTurnWaitMs ?? SELF_TURN_WAIT_MS);
      }
    }
    if (isType(m, "system", "init") && held && !dead && !released) {
      startSelfTurn(m);
      return;
    }
    maybeCloseIdle();
  }

  function onMessage(m: SdkMessage) {
    if (o.hooks) {
      const r = tracker.apply(m);
      for (const n of r.notifications) notices.set(n.taskId, n);
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
    if (selfWaitTimer) clearTimeout(selfWaitTimer);
    current?.end(failure);
    current = undefined;
    turnOpen = false;
    setHeld(false);
    freeSlot();
    tracker.reset();
    settle();
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
      if (o.hooks?.canHold() && !dead && !released && tracker.size() > 0) {
        cancelClose();
        setHeld(true);
        // 턴은 run.ts 가 곧바로 done() 으로 뗀다 — 그때 쌓인 메시지가 쉬는 동안의 길로 간다
        return true;
      }
      // 턴은 떼지 않는다 — run.ts 가 프로세스가 끝날 때까지 읽는다(지금 동작)
      setHeld(false);
      released = true;
      endInput();
      closeLater();
      settle();
      return false;
    },
    holding: () => held,
    reusable: () => held && !dead && !released,
    idleNow,
    whenIdle(signal) {
      if (signal.aborted) return Promise.resolve(false);
      if (!reserved && idleNow() && waiters.length === 0) {
        reserved = true;
        return Promise.resolve(true);
      }
      if (dead || released) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const w: Waiter = {
          resolve: (ok) => {
            signal.removeEventListener("abort", onAbort);
            resolve(ok);
          },
        };
        const onAbort = () => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          resolve(false);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.push(w);
      });
    },
    unreserve() {
      reserved = false;
      settle();
      maybeCloseIdle();
    },
    onSelfTurn(handler) {
      selfTurnHandler = handler;
    },
    release() {
      if (current || selfBuffer !== undefined || selfRunning) q?.interrupt().catch(() => {});
      selfBuffer = undefined;
      pendingNotices = [];
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
