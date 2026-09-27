import {
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL,
  RunnerApprovalResolve,
  RunnerHelloResult,
  RunnerOutboundAck,
  RunnerRunAbort,
  RunnerRunStart,
  type RunnerCapability,
  type RunnerClientToServerEvents,
  type RunnerHello,
  type RunnerServerToClientEvents,
} from "@dodok/shared";
import { io, type Socket } from "socket.io-client";
import type { ApprovalOutcome } from "./approvals";
import { type AttachmentsHttp, createAttachmentsHttp } from "./attachments-http";
import type { ResolvedAgent, ResolvedRunnerConfig } from "./config";
import { abortedFinal, runOnce, type RunBridge, type RunEmitter } from "./run";
import { createScheduler } from "./scheduler";
import type { SdkPort } from "./sdk";

export type RunnerLogger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

export type RunnerVersions = Pick<
  RunnerHello,
  "runnerVersion" | "sdkVersion" | "claudeCodeVersion" | "bundleSha256"
>;

const CAPABILITIES: RunnerCapability[] = ["threads", "interrupt", "approvals", "attachments"];
const HELLO_TIMEOUT_MS = 15_000;
/** outbound.post ack — 서버가 메시지를 저장하고 답한다. 넘으면 도구 결과로 실패를 돌려준다 */
const POST_ACK_TIMEOUT_MS = 30_000;
// 재접속 백오프 1초~30초(Global Constraints)
const DEFAULT_BACKOFF = { minMs: 1000, maxMs: 30_000 };
/** 러너를 끝낼 때 중지한 런이 final 을 낼 때까지 기다리는 상한 — 런 쪽 close 유예(ABORT_CLOSE_MS)와 같다 */
export const STOP_WAIT_MS = 5000;
const STOP_SETTLE_MS = 50;

// 서버가 이 연결을 스스로 끊었다(socket.io 클라이언트 사유) — 러너 어댑터는 같은 토큰의 새 hello 가 오면 앞 연결을,
// 토큰을 폐기하면 그 세션을 끊는다. 다시 붙으면 같은 토큰의 두 러너가 서로를 끝없이 밀어낸다(리뷰 I2)
const SERVER_DISCONNECT = "io server disconnect";
const SERVER_DISCONNECT_MESSAGE =
  "서버가 이 러너 연결을 끊었습니다 — 같은 토큰으로 다른 러너가 붙었거나 토큰이 폐기됐습니다";

export type RunnerConnectionOptions = {
  config: ResolvedRunnerConfig;
  token: string;
  sdk: SdkPort;
  versions: RunnerVersions;
  logger: RunnerLogger;
  /** 서버가 러너를 받지 않는다(hello 거절·UNAUTHORIZED·서버가 끊음) — 러너는 사유를 출력하고 이 코드로 끝난다 */
  onFatal: (exitCode: number) => void;
  baseEnv?: NodeJS.ProcessEnv;
  backoff?: { minMs: number; maxMs: number };
  closeGraceMs?: number;
  stopWaitMs?: number;
  /** 없으면 serverUrl·토큰으로 러너 첨부 HTTP 를 만든다 */
  attachmentsHttp?: AttachmentsHttp;
  postAckTimeoutMs?: number;
};

type RunnerSocket = Socket<RunnerServerToClientEvents, RunnerClientToServerEvents>;

export function startRunnerConnection(opts: RunnerConnectionOptions) {
  const { config, logger } = opts;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const agents = new Map<string, ResolvedAgent>(config.agents.map((a) => [a.id, a]));
  const scheduler = createScheduler(config.maxConcurrentRuns);
  const costs = new Map<string, number>();
  let stopped = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // 연결마다 올린다 — 끊긴 연결에서 시작한 런의 이벤트가 다시 붙은 연결로 새지 않게(서버는 그 런을 이미 닫았다)
  let generation = 0;
  const http =
    opts.attachmentsHttp ?? createAttachmentsHttp({ serverUrl: config.serverUrl, token: opts.token });
  // 결정을 기다리는 승인(id 는 toolUseID). 런이 멈추면 그 런의 signal 이 기다림을 거둔다
  const decisions = new Map<string, (outcome: ApprovalOutcome) => void>();

  const hello: RunnerHello = {
    runnerProtocol: RUNNER_PROTOCOL,
    ...opts.versions,
    capabilities: CAPABILITIES,
    // 작업 디렉터리는 라벨만 — 경로 원문은 서버로 보내지 않는다
    agents: config.agents.map((a) => ({
      id: a.id,
      name: a.name,
      model: a.model,
      workdirLabel: a.workdirLabel,
    })),
  };

  // 재연결은 socket.io-client 옵션이 아니라 여기서 한다 — 미들웨어 거절(RATE_LIMITED)에는 socket.io-client 가
  // 다시 붙지 않는다(openclaw-plugin bridge-client 와 같은 까닭). UNAUTHORIZED·서버가 끊은 연결은 끝낸다(fatal)
  const socket: RunnerSocket = io(config.serverUrl.replace(/\/+$/, "") + RUNNER_NAMESPACE, {
    autoConnect: false,
    reconnection: false,
    transports: ["websocket"],
    auth: { token: opts.token },
  });

  function scheduleReconnect(reason: string): void {
    if (stopped || retryTimer) return;
    const delay = Math.min(backoff.maxMs, backoff.minMs * 2 ** attempt);
    attempt += 1;
    logger.warn(`dodok-runner: ${delay}ms 뒤 다시 붙습니다(시도 ${attempt}, 까닭 ${reason})`);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!stopped) socket.connect();
    }, delay);
  }

  // 곧바로 끊으면 방금 낸 run.final 이 서버에서 버려진다 — socket.io 서버는 받은 이벤트를 다음 틱에 「아직 붙어
  // 있으면」 내보내는데, 같은 읽기에 끊김 패킷이 함께 오면 그 틱에 이미 끊겨 있다(stop 테스트가 잡는다). 전송 버퍼가
  // 비기를 기다린 뒤 조금 더 둔다
  async function drained(): Promise<void> {
    const engine = socket.io.engine;
    if (engine && (engine.writeBuffer.length > 0 || engine.transport?.writable === false)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        engine.once("drain", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_MS));
  }

  function fatal(message: string): void {
    logger.error(`dodok-runner: ${message}`);
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    socket.disconnect();
    opts.onFatal(2);
  }

  function emitterFor(runId: string, gen: number): RunEmitter {
    const live = () => socket.connected && gen === generation;
    return {
      event: (event) => {
        if (live()) socket.emit("run.event", { runId, event });
      },
      final: (final) => {
        if (live()) socket.emit("run.final", { runId, ...final });
      },
      error: (code, message) => {
        if (live()) socket.emit("run.error", { runId, code, message });
      },
    };
  }

  function bridgeFor(gen: number): RunBridge {
    const live = () => socket.connected && gen === generation;
    return {
      http,
      async post(message) {
        if (!live()) return { ok: false, code: "ADAPTER_UNAVAILABLE", message: "서버와 연결이 끊겼습니다" };
        try {
          const raw: unknown = await socket
            .timeout(opts.postAckTimeoutMs ?? POST_ACK_TIMEOUT_MS)
            .emitWithAck("outbound.post", message);
          const parsed = RunnerOutboundAck.safeParse(raw);
          return parsed.success
            ? parsed.data
            : { ok: false, code: "INTERNAL", message: "서버 응답이 계약과 다릅니다" };
        } catch {
          return { ok: false, code: "ADAPTER_UNAVAILABLE", message: "서버가 제때 답하지 않았습니다" };
        }
      },
      requestApproval(request) {
        if (live()) socket.emit("approval.requested", request);
      },
      withdrawApproval(providerApprovalId) {
        decisions.delete(providerApprovalId);
        if (live()) socket.emit("approval.withdrawn", { providerApprovalId });
      },
      waitDecision(providerApprovalId, signal) {
        return new Promise<ApprovalOutcome>((resolve, reject) => {
          if (signal.aborted) return reject(new Error("aborted"));
          const onAbort = () => {
            decisions.delete(providerApprovalId);
            reject(new Error("aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          decisions.set(providerApprovalId, (outcome) => {
            signal.removeEventListener("abort", onAbort);
            decisions.delete(providerApprovalId);
            resolve(outcome);
          });
        });
      },
    };
  }

  socket.on("connect", () => {
    generation += 1;
    void (async () => {
      try {
        const raw: unknown = await socket.timeout(HELLO_TIMEOUT_MS).emitWithAck("hello", hello);
        const result = RunnerHelloResult.parse(raw);
        if (!result.ok) {
          const hint = result.code === "PROTOCOL_MISMATCH" ? " — 서버와 러너 판본을 맞추세요" : "";
          fatal(`서버가 러너를 거절했습니다(${result.code}: ${result.message})${hint}`);
          return;
        }
        attempt = 0;
        logger.info(`dodok-runner: 연결됨(서버 ${result.serverVersion})`);
        if (result.conflicts.length > 0) {
          logger.warn(
            `dodok-runner: 다른 러너가 먼저 알린 에이전트는 이 러너에 배정되지 않습니다: ${result.conflicts.join(", ")}`,
          );
        }
      } catch (error) {
        if (stopped) return;
        logger.warn(`dodok-runner: hello 실패 — ${error instanceof Error ? error.message : String(error)}`);
        socket.disconnect();
        scheduleReconnect("hello");
      }
    })();
  });

  socket.on("connect_error", (error) => {
    if (stopped) return;
    // 러너 어댑터 미들웨어의 거절 사유가 message 로 온다. RATE_LIMITED(가드 차단 — 1분)는 끝내지 않고 백오프로 다시
    // 시도한다(스펙 4장 「사유를 출력하고 종료」와 다르다 — 1분 뒤 풀리는 차단에 사람이 러너를 다시 띄울 까닭이 없다)
    if (error.message === "UNAUTHORIZED") {
      fatal(
        "서버가 러너 토큰을 거절했습니다(UNAUTHORIZED) — 토큰이 틀렸거나 폐기됐습니다. " +
          "새 토큰을 발급해 tokenFile 에 두고 다시 띄우세요",
      );
      return;
    }
    logger.warn(`dodok-runner: 연결 실패 — ${error.message}`);
    scheduleReconnect("connect_error");
  });

  socket.on("disconnect", (reason) => {
    // 서버와 끊기면 도는 런을 곧바로 멈춘다(스펙 4.5, Review Focus 1) — 서버는 그 런을 ADAPTER_UNAVAILABLE 로 닫고,
    // 「다시 실행」은 다시 붙은 뒤 같은 세션을 이어 간다
    scheduler.abortAll();
    if (stopped) return;
    if (reason === SERVER_DISCONNECT) {
      fatal(SERVER_DISCONNECT_MESSAGE);
      return;
    }
    // 전송 끊김(transport close·ping timeout 등 — 서버 재시작·네트워크·덮개 닫힘)은 다시 붙는다
    logger.warn(`dodok-runner: 서버와 끊겼습니다(${reason}) — 도는 런을 멈췄습니다`);
    scheduleReconnect(`disconnect ${reason}`);
  });

  socket.on("run.start", (payload, ack) => {
    const parsed = RunnerRunStart.safeParse(payload);
    if (!parsed.success) {
      const runId = String((payload as { deliver?: { runId?: unknown } })?.deliver?.runId ?? "");
      logger.warn(`dodok-runner: run.start 형식이 틀려 버립니다(런 ${runId})`);
      ack({ runId, admission: "drop", reason: "invalid-run-start" });
      return;
    }
    const start = parsed.data;
    const runId = start.deliver.runId;
    const emit = emitterFor(runId, generation);
    const bridge = bridgeFor(generation);
    const agent = agents.get(start.deliver.agentId);
    if (!agent) {
      ack({ runId, admission: "dispatch" });
      emit.error("NOT_FOUND", `이 러너의 설정 파일에 없는 에이전트입니다(${start.deliver.agentId})`);
      return;
    }
    const submitted = scheduler.submit(
      runId,
      start.providerSessionId,
      async (signal) => {
        logger.info(`dodok-runner: 런 시작 ${runId}(${agent.id})`);
        await runOnce(start, {
          sdk: opts.sdk,
          bridge,
          agent,
          claudeConfigDir: config.claudeConfigDir,
          baseEnv: opts.baseEnv ?? process.env,
          costs,
          signal,
          emit,
          ...(opts.closeGraceMs === undefined ? {} : { closeGraceMs: opts.closeGraceMs }),
        });
        logger.info(`dodok-runner: 런 끝 ${runId}(${agent.id})`);
      },
      // 대기열에서 중지된 런 — 어댑터가 dispatch 뒤 추적하던 런을 놓게 final 로 닫는다(판정 R1)
      () => emit.final(abortedFinal()),
    );
    if ("busy" in submitted) {
      ack({ runId, admission: "dispatch" });
      emit.error("CONFLICT", "같은 세션의 런이 이미 돌고 있습니다");
      return;
    }
    ack({ runId, admission: "dispatch", ...submitted });
  });

  socket.on("run.abort", (payload) => {
    const parsed = RunnerRunAbort.safeParse(payload);
    if (parsed.success) scheduler.abort(parsed.data.runId);
  });

  // 기한이 지나면 서버가 deny + reason expired 를 보낸다(판정 P5). 모르는 id(이미 거둔 승인)는 버린다
  socket.on("approval.resolve", (payload) => {
    const parsed = RunnerApprovalResolve.safeParse(payload);
    if (!parsed.success) {
      logger.warn("dodok-runner: approval.resolve 형식이 틀려 버립니다");
      return;
    }
    const { providerApprovalId, decision, reason } = parsed.data;
    decisions.get(providerApprovalId)?.({ decision, ...(reason === undefined ? {} : { reason }) });
  });

  socket.connect();

  return {
    get connected(): boolean {
      return socket.connected;
    },
    /** 도는 런에 interrupt 를 걸고, 그 런들이 final 을 낼 때까지(최대 stopWaitMs) 기다린 뒤 끊는다 */
    async stop(): Promise<void> {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      scheduler.abortAll();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        scheduler.idle(),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, opts.stopWaitMs ?? STOP_WAIT_MS))),
      ]);
      clearTimeout(timer);
      if (socket.connected) await drained();
      socket.disconnect();
    },
  };
}

export type RunnerConnection = ReturnType<typeof startRunnerConnection>;
