import {
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL,
  RunnerHelloResult,
  RunnerRunAbort,
  RunnerRunStart,
  type RunnerCapability,
  type RunnerClientToServerEvents,
  type RunnerHello,
  type RunnerServerToClientEvents,
} from "@dodok/shared";
import { io, type Socket } from "socket.io-client";
import type { ResolvedAgent, ResolvedRunnerConfig } from "./config";
import { runOnce, type RunEmitter } from "./run";
import { createScheduler } from "./scheduler";
import type { SdkPort } from "./sdk";

export type RunnerLogger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

export type RunnerVersions = Pick<
  RunnerHello,
  "runnerVersion" | "sdkVersion" | "claudeCodeVersion" | "bundleSha256"
>;

// approvals·attachments 는 도구 승인·첨부(태스크 6)가 붙을 때 더한다
const CAPABILITIES: RunnerCapability[] = ["threads", "interrupt"];
const HELLO_TIMEOUT_MS = 15_000;
// 재접속 백오프 1초~30초(Global Constraints)
const DEFAULT_BACKOFF = { minMs: 1000, maxMs: 30_000 };

export type RunnerConnectionOptions = {
  config: ResolvedRunnerConfig;
  token: string;
  sdk: SdkPort;
  versions: RunnerVersions;
  logger: RunnerLogger;
  /** hello 거절 — 러너는 사유를 출력하고 이 코드로 끝난다 */
  onFatal: (exitCode: number) => void;
  baseEnv?: NodeJS.ProcessEnv;
  backoff?: { minMs: number; maxMs: number };
  closeGraceMs?: number;
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

  // 재연결은 socket.io-client 옵션이 아니라 여기서 한다 — 미들웨어 거절(UNAUTHORIZED 등)과 서버가 끊은 경우에는
  // socket.io-client 가 다시 붙지 않는다(openclaw-plugin bridge-client 와 같은 까닭)
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

  socket.on("connect", () => {
    generation += 1;
    void (async () => {
      try {
        const raw: unknown = await socket.timeout(HELLO_TIMEOUT_MS).emitWithAck("hello", hello);
        const result = RunnerHelloResult.parse(raw);
        if (!result.ok) {
          const hint = result.code === "PROTOCOL_MISMATCH" ? " — 서버와 러너 판본을 맞추세요" : "";
          logger.error(`dodok-runner: 서버가 러너를 거절했습니다(${result.code}: ${result.message})${hint}`);
          stopped = true;
          socket.disconnect();
          opts.onFatal(2);
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
    logger.warn(`dodok-runner: 연결 실패 — ${error.message}`);
    scheduleReconnect("connect_error");
  });

  socket.on("disconnect", (reason) => {
    // 서버와 끊기면 도는 런을 곧바로 멈춘다(스펙 4.5, Review Focus 1) — 서버는 그 런을 ADAPTER_UNAVAILABLE 로 닫고,
    // 「다시 실행」은 다시 붙은 뒤 같은 세션을 이어 간다
    scheduler.abortAll();
    if (stopped) return;
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
    const agent = agents.get(start.deliver.agentId);
    if (!agent) {
      ack({ runId, admission: "dispatch" });
      emit.error("NOT_FOUND", `이 러너의 설정 파일에 없는 에이전트입니다(${start.deliver.agentId})`);
      return;
    }
    const submitted = scheduler.submit(runId, start.providerSessionId, async (signal) => {
      logger.info(`dodok-runner: 런 시작 ${runId}(${agent.id})`);
      await runOnce(start, {
        sdk: opts.sdk,
        agent,
        claudeConfigDir: config.claudeConfigDir,
        baseEnv: opts.baseEnv ?? process.env,
        costs,
        signal,
        emit,
        ...(opts.closeGraceMs === undefined ? {} : { closeGraceMs: opts.closeGraceMs }),
      });
      logger.info(`dodok-runner: 런 끝 ${runId}(${agent.id})`);
    });
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

  socket.connect();

  return {
    get connected(): boolean {
      return socket.connected;
    },
    stop(): void {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      scheduler.abortAll();
      socket.disconnect();
    },
  };
}

export type RunnerConnection = ReturnType<typeof startRunnerConnection>;
