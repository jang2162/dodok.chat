import {
  CONTROL_CALL_TIMEOUT_MS,
  ControlResult,
  Id,
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL,
  RUNNER_SHUTDOWN_STOP_REASON,
  RunnerApprovalResolve,
  RunnerHelloResult,
  RunnerOutboundAck,
  RunnerProjectRef,
  RunnerRunAbort,
  RunnerRunStart,
  type RunnerCapability,
  type RunnerClientToServerEvents,
  type RunnerHello,
  type RunnerProgram,
  type RunnerProgramStatus,
  type RunnerServerToClientEvents,
} from "@dodok/shared";
import { io, type Socket } from "socket.io-client";
import { type AttachmentsHttp, createAttachmentsHttp } from "./attachments-http";
import { checkCeiling } from "./ceiling";
import type { ProgramCeiling, ResolvedRunnerConfig } from "./config";
import { capabilityList, type ProgramDriver, type RunSpec } from "./driver";
import { checkProject, listDirectory } from "./fs-browse";
import { createScheduler } from "./scheduler";
import { abortedFinal, type ApprovalOutcome, createRunSink, type RunBridge, type RunEmitter } from "./sink";

export type RunnerLogger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

export type RunnerVersions = Pick<RunnerHello, "runnerVersion" | "sdkVersion" | "bundleSha256">;

/** 드라이버가 없는 프로그램을 설정에 적었다 — 꺼진 것과 같지만 hello 에 사유와 함께 알린다 */
export const NO_DRIVER_REASON = "이 러너 판본에는 이 프로그램의 드라이버가 없습니다";

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
  /** 프로그램마다 하나 — 설정에 켠 프로그램 중 드라이버가 있는 것만 돈다 */
  drivers: ProgramDriver[];
  versions: RunnerVersions;
  logger: RunnerLogger;
  /** 서버가 러너를 받지 않는다(hello 판본 거절·UNAUTHORIZED·서버가 끊음) — 러너는 도는 런을 멈추고(최대 stopWaitMs) 사유를 출력한 뒤 이 코드로 끝난다 */
  onFatal: (exitCode: number) => void;
  backoff?: { minMs: number; maxMs: number };
  stopWaitMs?: number;
  /** 없으면 serverUrl·토큰으로 러너 첨부 HTTP 를 만든다 */
  attachmentsHttp?: AttachmentsHttp;
  postAckTimeoutMs?: number;
};

type RunnerSocket = Socket<RunnerServerToClientEvents, RunnerClientToServerEvents>;

/**
 * 런 하나가 서버와 주고받는 길. live() 는 그 런을 시작한 연결 세대가 아직 붙어 있는가 — 끊겼거나 다시 붙은 연결로는
 * 보내지 않는다(서버는 그 런을 이미 닫았다). 끊기면 연결이 런을 먼저 멈추므로 대개는 런 signal 이 앞에서 막는다
 */
const FIELD_NAME = /^[A-Za-z_]\w{0,63}$/;
const INVALID_FIELDS_MAX = 5;

/** 틀린 필드의 이름 경로(`agent.allowedTools[0]`) — 스키마의 키만 싣고, 이름 꼴이 아닌 성분(맵 키 등 보낸 쪽의 값)은 `?` 로 */
export function invalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const names = [
    ...new Set(
      issues.map(
        (i) =>
          i.path
            .map((k, n) =>
              typeof k === "number"
                ? `[${k}]`
                : `${n === 0 ? "" : "."}${typeof k === "string" && FIELD_NAME.test(k) ? k : "?"}`,
            )
            .join("") || "(최상위)",
      ),
    ),
  ];
  const shown = names.slice(0, INVALID_FIELDS_MAX).join(", ");
  return names.length > INVALID_FIELDS_MAX ? `${shown} 외 ${names.length - INVALID_FIELDS_MAX}개` : shown;
}

export function createRunBridge(o: {
  socket: Pick<RunnerSocket, "emit" | "timeout">;
  live: () => boolean;
  http: AttachmentsHttp;
  /** 결정을 기다리는 승인(id 는 toolUseID) — 연결이 approval.resolve 를 여기로 넘긴다 */
  decisions: Map<string, (outcome: ApprovalOutcome) => void>;
  postAckTimeoutMs?: number;
}): RunBridge {
  return {
    http: o.http,
    async post(message) {
      if (!o.live()) return { ok: false, code: "ADAPTER_UNAVAILABLE", message: "서버와 연결이 끊겼습니다" };
      try {
        const raw: unknown = await o.socket
          .timeout(o.postAckTimeoutMs ?? POST_ACK_TIMEOUT_MS)
          .emitWithAck("outbound.post", message);
        const parsed = RunnerOutboundAck.safeParse(raw);
        return parsed.success
          ? parsed.data
          : { ok: false, code: "INTERNAL", message: "서버 응답이 계약과 다릅니다" };
      } catch {
        return { ok: false, code: "ADAPTER_UNAVAILABLE", message: "서버가 제때 답하지 않았습니다" };
      }
    },
    async control(call) {
      // 보내기 전에 끊겨 있었으면 서버에 닿지 않았다 — 실패로 알려도 된다
      if (!o.live()) {
        return {
          ok: false,
          error: { code: "ADAPTER_UNAVAILABLE", message: "서버와 연결이 끊겨 보내지 않았습니다" },
        };
      }
      let raw: unknown;
      try {
        // 서버는 확인 카드를 기다리는 동안 ack 를 미룬다 — shared CONTROL_CALL_TIMEOUT_MS 의 까닭. CLI 쪽 SDK MCP 도구 호출 상한이
        // 이보다 짧으면 그쪽이 먼저 끊는데, 번들 CLI 는 서버 timeout ?? env MCP_TOOL_TIMEOUT ?? 1e8ms 이고(ENV_ALLOWLIST 가 그 env 를
        // 넘기지 않는다) sdk 서버에는 idle 상한이 없다. SDK 를 올리면 번들 CLI 바이너리에서 `a.MCP_TOOL_TIMEOUT??` 둘레를 다시 본다
        raw = await o.socket.timeout(CONTROL_CALL_TIMEOUT_MS).emitWithAck("control.call", call);
      } catch {
        // 보낸 뒤 끊김(socket.io-client 가 기다리던 ack 를 곧바로 거절한다)·시간 초과 — 서버가 받았을 수 있다
        return { unknown: true };
      }
      const parsed = ControlResult.safeParse(raw);
      return parsed.success
        ? parsed.data
        : { ok: false, error: { code: "INTERNAL", message: "서버 응답이 계약과 다릅니다" } };
    },
    requestApproval(request) {
      if (o.live()) o.socket.emit("approval.requested", request);
    },
    withdrawApproval(providerApprovalId) {
      o.decisions.delete(providerApprovalId);
      if (o.live()) o.socket.emit("approval.withdrawn", { providerApprovalId });
    },
    waitDecision(providerApprovalId, signal) {
      return new Promise<ApprovalOutcome>((resolve, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        const onAbort = () => {
          o.decisions.delete(providerApprovalId);
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        o.decisions.set(providerApprovalId, (outcome) => {
          signal.removeEventListener("abort", onAbort);
          o.decisions.delete(providerApprovalId);
          resolve(outcome);
        });
      });
    },
  };
}

export function startRunnerConnection(opts: RunnerConnectionOptions) {
  const { config, logger } = opts;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const drivers = new Map<RunnerProgram, ProgramDriver>(opts.drivers.map((d) => [d.program, d]));
  const scheduler = createScheduler(config.maxConcurrentRuns);
  // 마지막 hello 때 detect 한 프로그램 상태 — 천장 검사의 「프로그램을 쓸 수 있나」
  const available = new Map<RunnerProgram, boolean>();
  let stopped = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // 연결마다 올린다 — 끊긴 연결에서 시작한 런의 이벤트가 다시 붙은 연결로 새지 않게(서버는 그 런을 이미 닫았다)
  let generation = 0;
  // hello ack 를 기다리는 중 — 서버 끊김과 거절 ack 의 순서를 가린다(disconnect 처리기)
  let helloInFlight = false;
  const http =
    opts.attachmentsHttp ?? createAttachmentsHttp({ serverUrl: config.serverUrl, token: opts.token });
  // 결정을 기다리는 승인(id 는 toolUseID). 런이 멈추면 그 런의 signal 이 기다림을 거둔다
  const decisions = new Map<string, (outcome: ApprovalOutcome) => void>();

  /** 설정에 켠 프로그램마다 — 드라이버가 없으면 사유와 함께 못 씀. detect 는 연결마다 다시 한다(그 사이 로그인했을 수 있다) */
  async function detectPrograms(): Promise<RunnerProgramStatus[]> {
    const entries = Object.entries(config.programs) as Array<[RunnerProgram, ProgramCeiling | undefined]>;
    const statuses = await Promise.all(
      entries.flatMap(([program, ceiling]) => (ceiling ? [statusOf(program, ceiling)] : [])),
    );
    available.clear();
    for (const s of statuses) available.set(s.program, s.available);
    return statuses;
  }

  async function statusOf(program: RunnerProgram, ceiling: ProgramCeiling): Promise<RunnerProgramStatus> {
    const base = {
      program,
      ceiling: {
        maxPermissionMode: ceiling.maxPermissionMode,
        allowedToolsCeiling: ceiling.allowedToolsCeiling,
      },
    };
    const driver = drivers.get(program);
    if (!driver)
      return { ...base, available: false, auth: "unknown", reason: NO_DRIVER_REASON, capabilities: [] };
    try {
      return { ...base, ...(await driver.detect(ceiling)), capabilities: capabilityList(driver) };
    } catch {
      return {
        ...base,
        available: false,
        auth: "unknown",
        reason: "상태를 확인하지 못했습니다",
        capabilities: [],
      };
    }
  }

  // 루트는 id·라벨만 — 경로 원문은 서버로 보내지 않는다(러너 일반화 스펙 결정 3)
  const helloOf = (programs: RunnerProgramStatus[]): RunnerHello => ({
    runnerProtocol: RUNNER_PROTOCOL,
    ...opts.versions,
    capabilities: CAPABILITIES,
    roots: config.roots.map((r) => ({ id: r.id, label: r.label })),
    browse: config.browse,
    programs,
  });

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

  /**
   * 도는 런에 interrupt 를 걸고 그 런들이 끝날 때까지(최대 stopWaitMs) 기다린다. 러너가 끝나는 길이라 런은 사람 중지가 아닌
   * runner_shutdown 으로 닫는다
   */
  async function settleRuns(): Promise<void> {
    scheduler.abortAll(RUNNER_SHUTDOWN_STOP_REASON);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      scheduler.idle(),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, opts.stopWaitMs ?? STOP_WAIT_MS))),
    ]);
    clearTimeout(timer);
  }

  function fatal(message: string): void {
    // 이미 끝나는 중이면(앞 사유의 fatal·stop) 사유만 남긴다 — onFatal 은 한 번
    if (stopped) {
      logger.warn(`dodok-runner: ${message}`);
      return;
    }
    logger.error(`dodok-runner: ${message}`);
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    socket.disconnect();
    // stop() 과 같은 유예 — 곧바로 끝나면 interrupt 가 CLI 에 닿기 전에 러너가 끝나 CLI 가 고아로 남아 턴을 이어 간다
    // (토큰 폐기 뒤에도 미리 허용된 도구가 돈다 — 최종 리뷰 P1). 서버는 그 런을 이미 닫았으므로 final 은 버려져도 된다
    void settleRuns().then(() => opts.onFatal(2));
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
      session: (providerSessionId) => {
        if (live()) socket.emit("run.session", { runId, providerSessionId });
      },
    };
  }

  const bridgeFor = (gen: number): RunBridge =>
    createRunBridge({
      socket,
      live: () => socket.connected && gen === generation,
      http,
      decisions,
      ...(opts.postAckTimeoutMs === undefined ? {} : { postAckTimeoutMs: opts.postAckTimeoutMs }),
    });

  socket.on("connect", () => {
    generation += 1;
    void (async () => {
      try {
        const hello = helloOf(await detectPrograms());
        helloInFlight = true;
        const raw: unknown = await socket
          .timeout(HELLO_TIMEOUT_MS)
          .emitWithAck("hello", hello)
          .finally(() => {
            helloInFlight = false;
          });
        const result = RunnerHelloResult.parse(raw);
        // hello 거절은 판본 불일치뿐이다(최종 리뷰 M3) — 다른 코드는 파싱에서 떨어져 아래 catch 가 백오프로 다시 붙는다
        if (!result.ok) {
          fatal(
            `서버가 러너를 거절했습니다(${result.code}: ${result.message}) — 서버와 러너 판본을 맞추세요`,
          );
          return;
        }
        attempt = 0;
        logger.info(`dodok-runner: 연결됨(서버 ${result.serverVersion})`);
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
      // hello 거절은 거절 ack 와 끊김이 같은 TCP 조각으로 와서 ws 가 둘을 한 틱에 내보낸다 — ack 를 받은 hello 의 이어짐은
      // 마이크로태스크라 끊김이 먼저 처리된다. hello 를 기다리는 중이면 다음 틱으로 미뤄 판본 불일치 문구가 먼저 나가게 한다
      if (helloInFlight) setImmediate(() => fatal(SERVER_DISCONNECT_MESSAGE));
      else fatal(SERVER_DISCONNECT_MESSAGE);
      return;
    }
    // 전송 끊김(transport close·ping timeout 등 — 서버 재시작·네트워크·덮개 닫힘)은 다시 붙는다
    logger.warn(`dodok-runner: 서버와 끊겼습니다(${reason}) — 도는 런을 멈췄습니다`);
    scheduleReconnect(`disconnect ${reason}`);
  });

  socket.on("run.start", (payload, ack) => {
    const parsed = RunnerRunStart.safeParse(payload);
    if (!parsed.success) {
      const rawRunId = (payload as { deliver?: { runId?: unknown } } | undefined)?.deliver?.runId;
      const runId = Id.safeParse(rawRunId);
      // 런 id 를 읽을 수 있으면 dispatch 뒤 VALIDATION — drop 이면 어댑터가 런을 놓아 멘션이 흔적 없이 사라진다(태스크 2 리뷰 M3,
      // 스펙 3장 「서버·러너 둘 다 VALIDATION」). 문구는 틀린 필드 이름만 — 값은 싣지 않는다
      if (runId.success) {
        const fields = invalidFields(parsed.error.issues);
        logger.warn(`dodok-runner: run.start 형식이 틀려 거절합니다(런 ${runId.data} — ${fields})`);
        ack({ runId: runId.data, admission: "dispatch" });
        emitterFor(runId.data, generation).error("VALIDATION", `run.start 형식이 틀렸습니다 — ${fields}`);
        return;
      }
      logger.warn("dodok-runner: run.start 형식이 틀리고 런 id 도 읽을 수 없어 버립니다");
      ack({ runId: String(rawRunId ?? ""), admission: "drop", reason: "invalid-run-start" });
      return;
    }
    const start = parsed.data;
    const { agent } = start;
    const runId = start.deliver.runId;
    const emit = emitterFor(runId, generation);
    // 거절도 dispatch 뒤 run.error 로 — drop 이면 어댑터가 런을 놓아 오류 카드가 사라진다(리뷰 M1)
    const ceiling = checkCeiling(config, agent, (program) => available.get(program) === true);
    if (!ceiling.ok) {
      logger.warn(`dodok-runner: 천장에 걸려 거절 ${runId}(${ceiling.item})`);
      ack({ runId, admission: "dispatch" });
      emit.error("RUNNER_CEILING", ceiling.item);
      return;
    }
    // 천장 검사가 그 프로그램이 켜져 있고 드라이버가 있음을 확인했다
    const driver = drivers.get(agent.program)!;
    const programCeiling = config.programs[agent.program]!;
    const spec: RunSpec = {
      start,
      workdir: ceiling.workdir,
      configDir: programCeiling.configDir,
      model: agent.model,
      permissionMode: agent.permissionMode,
      allowedTools: agent.allowedTools,
      disallowedTools: [...new Set([...programCeiling.disallowedTools, ...agent.disallowedTools])],
    };
    const sink = createRunSink({ workdir: ceiling.workdir, emit, bridge: bridgeFor(generation) });
    const submitted = scheduler.submit(
      runId,
      // 세션 id 를 프로그램이 짓는 드라이버면 첫 런에는 id 가 없다 — dodok 세션 키로 같은 세션의 겹침을 막는다
      start.providerSessionId ?? start.deliver.sessionKey,
      async (signal) => {
        logger.info(`dodok-runner: 런 시작 ${runId}(${start.deliver.agentId})`);
        await driver.startRun(spec, sink, signal);
        logger.info(`dodok-runner: 런 끝 ${runId}(${start.deliver.agentId})`);
      },
      // 대기열에서 중지된 런 — 어댑터가 dispatch 뒤 추적하던 런을 놓게 final 로 닫는다(판정 R1)
      (reason) => sink.final(abortedFinal(undefined, reason)),
    );
    if ("busy" in submitted) {
      ack({ runId, admission: "dispatch" });
      emit.error("CONFLICT", "같은 세션의 런이 이미 돌고 있습니다");
      return;
    }
    ack({ runId, admission: "dispatch", ...submitted });
  });

  // 둘러보기·프로젝트 확인 — 형식이 틀린 요청은 없는 자리로 답한다(서버가 같은 스키마로 거른 뒤 보낸다)
  socket.on("fs.list", (payload, ack) => {
    const parsed = RunnerProjectRef.safeParse(payload);
    ack(parsed.success ? listDirectory(config, parsed.data) : { ok: false, code: "NOT_FOUND" });
  });

  socket.on("project.check", (payload, ack) => {
    const parsed = RunnerProjectRef.safeParse(payload);
    ack(parsed.success ? checkProject(config, parsed.data) : { ok: false, reason: "not_found" });
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
      await settleRuns();
      if (socket.connected) await drained();
      socket.disconnect();
    },
  };
}

export type RunnerConnection = ReturnType<typeof startRunnerConnection>;
