import {
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL,
  type RunnerAgent,
  type RunnerApprovalResolve,
  type RunnerHello,
  type RunnerHelloResult,
  type RunnerOutboundAck,
  type RunnerRunAbort,
  type RunnerRunAck,
  type RunnerRunStart,
} from "@dodok/shared";
import { io as connect, type Socket } from "socket.io-client";

/** 러너 쪽 흉내 — `/runner` 에 붙어 hello·프레임을 보내고, 서버가 보낸 것을 모아 둔다 */
export type FakeRunner = {
  readonly socket: Socket;
  readonly runStarts: RunnerRunStart[];
  readonly aborts: RunnerRunAbort[];
  readonly resolves: RunnerApprovalResolve[];
  /** run.start 에 무엇으로 ack 할지. 기본은 즉시 dispatch. undefined 를 돌려주면 ack 하지 않는다 */
  onRunStart: (p: RunnerRunStart) => RunnerRunAck | undefined;
  hello(overrides?: Partial<RunnerHello>): Promise<RunnerHelloResult>;
  /** 서버 검사를 거치지 않은 날 프레임도 보낸다 — 경계 파싱을 재려고 */
  send(event: string, payload: unknown): void;
  post(payload: unknown): Promise<RunnerOutboundAck>;
  close(): void;
};

export function runnerAgent(id: string, over: Partial<RunnerAgent> = {}): RunnerAgent {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    model: "sonnet",
    workdirLabel: `${id}-repo`,
    ...over,
  };
}

export function runnerHello(agents: RunnerAgent[], over: Partial<RunnerHello> = {}): RunnerHello {
  return {
    runnerProtocol: RUNNER_PROTOCOL,
    runnerVersion: "0.0.0",
    sdkVersion: "0.3.283",
    claudeCodeVersion: "2.1.283",
    bundleSha256: "a".repeat(64),
    capabilities: ["threads", "interrupt", "approvals", "future-capability"],
    agents,
    ...over,
  };
}

/** 연결이 서면 풀린다. 핸드셰이크가 거절되면 그 사유(connect_error 메시지)로 reject */
export function connectRunner(url: string, token: string, agents: RunnerAgent[] = []): Promise<FakeRunner> {
  const socket = connect(`${url}${RUNNER_NAMESPACE}`, {
    transports: ["websocket"],
    auth: { token },
    reconnection: false,
  });
  const runner: FakeRunner = {
    socket,
    runStarts: [],
    aborts: [],
    resolves: [],
    onRunStart: (p) => ({ runId: p.deliver.runId, admission: "dispatch" }),
    hello: (overrides = {}) => socket.emitWithAck("hello", runnerHello(agents, overrides)),
    send: (event, payload) => {
      socket.emit(event, payload);
    },
    post: (payload) => socket.emitWithAck("outbound.post", payload),
    close: () => {
      socket.disconnect();
    },
  };
  socket.on("run.start", (p: RunnerRunStart, ack: (r: RunnerRunAck) => void) => {
    runner.runStarts.push(p);
    const res = runner.onRunStart(p);
    if (res) ack(res);
  });
  socket.on("run.abort", (p: RunnerRunAbort) => runner.aborts.push(p));
  socket.on("approval.resolve", (p: RunnerApprovalResolve) => runner.resolves.push(p));
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(runner));
    socket.once("connect_error", (error) => reject(error));
  });
}
