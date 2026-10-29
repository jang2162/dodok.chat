/**
 * 가짜 러너 — 실제 러너 어댑터(`/runner` 네임스페이스)에 socket.io-client 로 붙는다. 모델·SDK·CLI 는 흉내 내지 않는다.
 *
 * 실제 러너(`packages/claude-runner`)와 같은 순서·모양: 토큰 handshake → `hello`(RunnerHello — 루트·프로그램·천장) ack →
 * `fs.list`·`project.check` 에 onFsList·onProjectCheck 로 답하고, `run.start` 를 받으면 대본(script)
 * 대로 `run.event`(텍스트·도구) → `run.final`. 대본은 승인 요청(`approval.requested` → `approval.resolve` 대기)·`outbound.post`·
 * 끊기를 부를 수 있다. `run.abort` 를 받으면 실제 러너처럼 `run.final { text: "", stopReason: "aborted" }` 로 끝낸다.
 * 통합 시나리오와 dev:fake 가 함께 쓴다
 */
import {
  type ComponentsV1,
  type ControlResult,
  RUNNER_NAMESPACE,
  RUNNER_POST_ID_PREFIX,
  RUNNER_PROTOCOL,
  type RunEventBody,
  type RunnerApprovalRequested,
  type RunnerApprovalResolve,
  type RunnerHello,
  RunnerHelloResult,
  type RunnerOutboundAck,
  type RunnerOutboundPost,
  type RunnerProgramStatus,
  type RunnerProjectCheckResult,
  type RunnerProjectRef,
  type RunnerFsListResult,
  type RunnerRunAbort,
  type RunnerRunAck,
  type RunnerRunFinal,
  RunnerRunStart,
} from "@dodok/shared";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import type { z } from "zod";

/** 대본 하나가 받는 런 손잡이 — 부르는 순서대로 프레임이 나간다 */
export type FakeRunnerRun = {
  readonly start: RunnerRunStart;
  readonly runId: string;
  /** 텍스트 델타(첫 델타 앞에 TEXT_MESSAGE_START) */
  text(delta: string): void;
  /** 도구 하나 — START·ARGS·END 뒤 RESULT(ok) */
  tool(name: string, args: unknown, result: string): void;
  /** approval.requested 를 보내고 서버의 approval.resolve 를 기다린다. 중지되면 withdrawn 을 보내고 null */
  approval(input: {
    toolName: string;
    summary: string;
    canAllowAlways?: boolean;
  }): Promise<RunnerApprovalResolve | null>;
  /** outbound.post — deliver 의 채널·에이전트·세션·스레드·runId 를 그대로 싣는다(어댑터가 대조한다) */
  post(input: {
    text?: string;
    /** 입력 모양(기본값 전) — 서버가 경계에서 ComponentsV1 로 파싱한다 */
    components?: z.input<typeof ComponentsV1>;
    attachmentIds?: string[];
  }): Promise<RunnerOutboundAck>;
  /**
   * control.call 을 보내고 ack(서버의 결과)를 기다린다 — 확인 카드를 기다리는 동안 늦게 온다. runId 는 기본 이 런, 런이 끝난 뒤에도
   * 보낼 수 있다(늦은 호출을 잴 때)
   */
  control(tool: string, args: Record<string, unknown>, opts?: { runId?: string }): Promise<ControlResult>;
  /** run.session — 세션 id 를 스스로 짓는 프로그램(serverSessionIds 없음)처럼 알린다 */
  session(providerSessionId: string): void;
  final(text: string, opts?: Partial<Omit<RunnerRunFinal, "runId" | "text">>): void;
  error(code: string, message: string): void;
  /** run.abort 를 받으면 풀린다 */
  readonly aborted: Promise<void>;
  readonly isAborted: boolean;
};

export type FakeRunnerScript = (run: FakeRunnerRun) => void | Promise<void>;

export type FakeRunnerOptions = {
  /** 서버 주소(`http://127.0.0.1:<port>`). `/runner` 는 붙여서 접속한다 */
  url: string;
  token: string;
  /** 기본 hello(fakeRunnerHello) 위에 덮는다 — 루트·프로그램·둘러보기 */
  hello?: Partial<RunnerHello>;
  script?: FakeRunnerScript;
  /**
   * 실제 러너의 재접속 규칙(claude-runner connection.ts)을 흉내 낸다 — 서버가 끊은 것(`io server disconnect`)이 아닌 끊김이면
   * minMs·2^n(상한 maxMs) 뒤 다시 붙어 hello 까지 한다. 붙지 못하면(서버가 아직 없음) 같은 규칙으로 또. 없으면 스스로 다시 붙지 않는다
   */
  autoReconnect?: { minMs: number; maxMs: number };
};

export type FakeRunner = {
  /** 바꿔 끼울 수 있다 — run.start 를 받은 시점의 값을 쓴다 */
  script: FakeRunnerScript;
  /** run.start 에 무엇으로 ack 할지 — 기본은 즉시 dispatch. undefined 면 ack 하지 않는다 */
  onRunStart: (start: RunnerRunStart) => RunnerRunAck | undefined;
  /** fs.list·project.check 에 무엇으로 답할지 — 기본은 빈 목록·git 아닌 디렉터리. undefined 면 ack 하지 않는다 */
  onFsList: (ref: RunnerProjectRef) => RunnerFsListResult | undefined;
  onProjectCheck: (ref: RunnerProjectRef) => RunnerProjectCheckResult | undefined;
  /** 받은 fs.list·project.check, 도착 순서 */
  readonly fsRequests: Array<["fs.list" | "project.check", RunnerProjectRef]>;
  /** 스키마를 통과한 run.start, 도착 순서 */
  readonly runStarts: RunnerRunStart[];
  readonly aborts: RunnerRunAbort[];
  readonly resolves: RunnerApprovalResolve[];
  readonly helloResult: RunnerHelloResult | undefined;
  /** 성공한 hello 수 — 처음 붙은 것 포함. autoReconnect 가 다시 붙으면 는다 */
  readonly helloCount: number;
  readonly connected: boolean;
  /**
   * 서버가 끊은 사유(socket.io-client disconnect reason), 도착 순서. 실제 러너는 `transport close` 면 다시 붙고
   * `io server disconnect` 면 종료한다(Ruling R4) — 가짜는 autoReconnect 를 줄 때만 그 규칙대로 다시 붙는다
   */
  readonly disconnectReasons: string[];
  /** 소켓만 끊는다 — 진행 중인 런은 실제 러너처럼 멈춘다(프레임을 더 보내지 않는다) */
  disconnect(): void;
  /** 다시 붙어 hello ack 까지 기다린다. token·hello 를 주면 그것으로(hello 는 기본 위에 덮는다) */
  reconnect(opts?: { token?: string; hello?: Partial<RunnerHello> }): Promise<RunnerHelloResult>;
  close(): void;
};

/** 가짜 러너가 알리는 루트 — 프로젝트는 이 루트 안에 만든다 */
export const FAKE_RUNNER_ROOT = { id: "src", label: "내 저장소들" } as const;

/** 서버가 세션 id 를 정하는 프로그램(Claude 드라이버와 같은 능력) */
export const FAKE_CLAUDE_PROGRAM: RunnerProgramStatus = {
  program: "claude",
  available: true,
  version: "2.1.283",
  auth: "ok",
  capabilities: ["serverSessionIds", "approvals", "images", "interrupt", "mcpTools", "costs"],
  ceiling: { maxPermissionMode: "acceptEdits", allowedToolsCeiling: null },
};

/** 세션 id 를 스스로 짓는 프로그램 — run.session 갈래(러너 일반화 계획 판정 PR3)를 잰다. 실제 드라이버는 아직 없다 */
export const FAKE_CODEX_PROGRAM: RunnerProgramStatus = {
  program: "codex",
  available: true,
  version: "0.0.0-fake",
  auth: "ok",
  capabilities: ["approvals", "interrupt", "mcpTools"],
  ceiling: { maxPermissionMode: "default", allowedToolsCeiling: null },
};

/** 기본 대본 — 받은 글의 첫 줄을 되돌려 준다 */
export const echoScript: FakeRunnerScript = (run) => {
  const line = run.start.deliver.message.text.split("\n")[0] ?? "";
  run.text("받았습니다: ");
  run.text(line);
  run.final(`받았습니다: ${line}`, { usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.01 });
};

export function fakeRunnerHello(over: Partial<RunnerHello> = {}): RunnerHello {
  return {
    runnerProtocol: RUNNER_PROTOCOL,
    runnerVersion: "0.0.0-fake",
    sdkVersion: "0.3.283",
    bundleSha256: null,
    capabilities: ["threads", "interrupt", "approvals", "attachments"],
    roots: [{ ...FAKE_RUNNER_ROOT }],
    browse: true,
    programs: [FAKE_CLAUDE_PROGRAM, FAKE_CODEX_PROGRAM],
    ...over,
  };
}

const CONNECT_TIMEOUT_MS = 5_000;

export async function startFakeRunner(opts: FakeRunnerOptions): Promise<FakeRunner> {
  let token = opts.token;
  let hello = opts.hello ?? {};
  let socket: Socket | undefined;
  let helloResult: RunnerHelloResult | undefined;
  let helloCount = 0;
  let closed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const runStarts: RunnerRunStart[] = [];
  const aborts: RunnerRunAbort[] = [];
  const resolves: RunnerApprovalResolve[] = [];
  const disconnectReasons: string[] = [];
  const fsRequests: Array<["fs.list" | "project.check", RunnerProjectRef]> = [];
  const abortHandlers = new Map<string, () => void>();
  const resolveWaiters = new Map<string, (r: RunnerApprovalResolve) => void>();

  const runner: FakeRunner = {
    script: opts.script ?? echoScript,
    onRunStart: (start) => ({ runId: start.deliver.runId, admission: "dispatch" }),
    onFsList: () => ({ ok: true, entries: [], truncated: false }),
    onProjectCheck: () => ({ ok: true, isGitRepo: false }),
    fsRequests,
    runStarts,
    aborts,
    resolves,
    disconnectReasons,
    get helloResult() {
      return helloResult;
    },
    get helloCount() {
      return helloCount;
    },
    get connected() {
      return socket?.connected ?? false;
    },
    disconnect() {
      socket?.disconnect();
    },
    async reconnect(next = {}) {
      socket?.disconnect();
      if (next.token !== undefined) token = next.token;
      if (next.hello !== undefined) hello = next.hello;
      return connect();
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      socket?.removeAllListeners();
      socket?.disconnect();
    },
  };

  function scheduleReconnect(): void {
    const backoff = opts.autoReconnect;
    if (!backoff || closed || retryTimer) return;
    const delay = Math.min(backoff.maxMs, backoff.minMs * 2 ** attempt);
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (closed) return;
      connect().then(
        () => {
          attempt = 0;
        },
        () => scheduleReconnect(),
      );
    }, delay);
  }

  function handleRun(s: Socket, start: RunnerRunStart) {
    const runId = start.deliver.runId;
    let released = () => {};
    let isAborted = false;
    const aborted = new Promise<void>((resolve) => {
      released = resolve;
    });
    abortHandlers.set(runId, () => {
      isAborted = true;
      released();
    });
    let textId: string | undefined;
    // 런의 끝(run.final·run.error)은 한 번 — 중지 뒤 대본이 부르는 final 은 버린다
    let finished = false;
    const finish = (): boolean => {
      if (finished) return false;
      finished = true;
      abortHandlers.delete(runId);
      return live();
    };
    // 끊긴 소켓·중지한 런에는 더 보내지 않는다 — 실제 러너는 끊기면 CLI 를 멈춘다(Review Focus 1)
    const live = () => s.connected && socket === s;
    const event = (body: RunEventBody) => {
      if (live()) s.emit("run.event", { runId, event: body });
    };
    const run: FakeRunnerRun = {
      start,
      runId,
      aborted,
      get isAborted() {
        return isAborted;
      },
      text(delta) {
        if (textId === undefined) {
          textId = randomUUID();
          event({ type: "TEXT_MESSAGE_START", runId, messageId: textId, role: "assistant" });
        }
        event({ type: "TEXT_MESSAGE_CONTENT", runId, messageId: textId, delta });
      },
      tool(name, args, result) {
        const toolCallId = `toolu_${randomUUID()}`;
        event({ type: "TOOL_CALL_START", runId, toolCallId, toolCallName: name });
        event({ type: "TOOL_CALL_ARGS", runId, toolCallId, delta: JSON.stringify(args) });
        event({ type: "TOOL_CALL_END", runId, toolCallId });
        event({ type: "TOOL_CALL_RESULT", runId, toolCallId, content: result, ok: true });
      },
      async approval(input) {
        const request: RunnerApprovalRequested = {
          providerApprovalId: `toolu_${randomUUID()}`,
          runId,
          sessionKey: start.deliver.sessionKey,
          toolCallId: `toolu_${randomUUID()}`,
          toolName: input.toolName,
          summary: input.summary,
          canAllowAlways: input.canAllowAlways ?? true,
        };
        const decided = new Promise<RunnerApprovalResolve>((resolve) =>
          resolveWaiters.set(request.providerApprovalId, resolve),
        );
        if (live()) s.emit("approval.requested", request);
        const winner = await Promise.race([decided, aborted.then(() => null)]);
        resolveWaiters.delete(request.providerApprovalId);
        if (winner === null && live())
          s.emit("approval.withdrawn", { providerApprovalId: request.providerApprovalId });
        return winner;
      },
      async post(input) {
        const d = start.deliver;
        const post: RunnerOutboundPost = {
          outboundId: `${RUNNER_POST_ID_PREFIX}${randomUUID()}`,
          conversationId: d.conversationId,
          agentId: d.agentId,
          sessionKey: d.sessionKey,
          ...(d.threadId === undefined ? {} : { threadId: d.threadId }),
          runId,
          text: input.text ?? "",
          ...(input.components === undefined
            ? {}
            : { components: input.components as RunnerOutboundPost["components"] }),
          attachmentIds: input.attachmentIds ?? [],
          ts: new Date().toISOString(),
        };
        return (await s.emitWithAck("outbound.post", post)) as RunnerOutboundAck;
      },
      async control(tool, args, over = {}) {
        return (await s.emitWithAck("control.call", {
          callId: randomUUID(),
          runId: over.runId ?? runId,
          tool,
          args,
        })) as ControlResult;
      },
      session(providerSessionId) {
        if (live()) s.emit("run.session", { runId, providerSessionId });
      },
      final(text, extra = {}) {
        if (finish()) s.emit("run.final", { runId, text, stopReason: "end_turn", costKind: "api", ...extra });
      },
      error(code, message) {
        if (finish()) s.emit("run.error", { runId, code, message });
      },
    };
    // 실제 러너: interrupt 로 끝난 턴은 빈 답 + stopReason "aborted"(조율자 판정 R1). 비용·토큰 없이 costKind 는
    // abortedFinal() 기본값 그대로 — 대기열에서 중지된 런과 같은 모양(최종 리뷰 M2)
    void aborted.then(() => run.final("", { stopReason: "aborted", costKind: "subscription_estimate" }));
    void (async () => {
      try {
        await runner.script(run);
      } catch (error) {
        run.error("INTERNAL", error instanceof Error ? error.message : String(error));
      }
    })();
  }

  function connect(): Promise<RunnerHelloResult> {
    const s = io(`${opts.url}${RUNNER_NAMESPACE}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    socket = s;
    s.on("disconnect", (reason) => {
      if (reason === "io client disconnect") return;
      disconnectReasons.push(reason);
      if (reason !== "io server disconnect" && socket === s) scheduleReconnect();
    });
    s.on("run.start", (raw: unknown, ack: (r: RunnerRunAck) => void) => {
      const parsed = RunnerRunStart.safeParse(raw);
      if (!parsed.success) return;
      runStarts.push(parsed.data);
      const res = runner.onRunStart(parsed.data);
      if (!res) return;
      ack(res);
      if (res.admission === "dispatch") handleRun(s, parsed.data);
    });
    for (const event of ["fs.list", "project.check"] as const) {
      s.on(event, (ref: RunnerProjectRef, ack: (r: unknown) => void) => {
        fsRequests.push([event, ref]);
        const res = event === "fs.list" ? runner.onFsList(ref) : runner.onProjectCheck(ref);
        if (res !== undefined) ack(res);
      });
    }
    s.on("run.abort", (p: RunnerRunAbort) => {
      aborts.push(p);
      abortHandlers.get(p.runId)?.();
    });
    s.on("approval.resolve", (p: RunnerApprovalResolve) => {
      resolves.push(p);
      resolveWaiters.get(p.providerApprovalId)?.(p);
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fake runner connect timed out")), CONNECT_TIMEOUT_MS);
      s.once("connect_error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      s.once("connect", () => {
        s.emitWithAck("hello", fakeRunnerHello(hello)).then(
          (raw: unknown) => {
            clearTimeout(timer);
            helloResult = RunnerHelloResult.parse(raw);
            helloCount += 1;
            resolve(helloResult);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    });
  }

  await connect();
  return runner;
}
