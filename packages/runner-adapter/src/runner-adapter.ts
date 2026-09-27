/**
 * `AgentAdapter` 의 Claude 러너 구현 — 러너 스펙 3·4.5·5·6·8장.
 *
 * 러너가 사람 머신에서 `/runner` 네임스페이스로 붙는다(판정 P1). 런 하나 = `run.start` 하나, 러너가 정규화한 `run.event` 를 받아
 * 오케스트레이터 신호로 옮기고, `run.final` 의 최종 답은 `onOutbound` 로 채널 메시지를 만든다 — OpenClaw 의 정본(`onCanonical`)과 같은 자리
 */
import {
  AdapterError,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterLogger,
  type AgentAdapter,
  type BridgeAuthGuard,
  buildChannelRulesAppend,
  buildTurnFacts,
  type ClaudeAdapterStatus,
  type ClaudeSetupDetail,
  dodokSessionKey,
  ErrorCode,
  type InboundDeliver,
  type OutboundMessage,
  parseDodokSessionKey,
  type RunEventBody,
  type RunEventType,
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL,
  type RunnerAgent,
  RunnerApprovalRequested,
  RunnerApprovalWithdrawn,
  type RunnerClientToServerEvents,
  RunnerHello,
  type RunnerHelloResult,
  RunnerOutboundPost,
  type RunnerOutboundAck,
  RunnerRunAck,
  RunnerRunError,
  RunnerRunEvent,
  RunnerRunFinal,
  RunnerRunStart,
  type RunnerServerToClientEvents,
  type RunSignal,
  type RunUsage,
} from "@dodok/shared";
import type { Namespace, Server, Socket } from "socket.io";
import { RUNNER_APPROVAL_TTL_MS, RunnerApprovals } from "./approvals";
import { createRunner, type Runner, RunnerRegistry, type RunnerSocket } from "./connections";

export { RUNNER_APPROVAL_TTL_MS };

/** 핸드셰이크 `auth.token`(외부 입력 그대로)을 보고 통과면 그 토큰의 id·라벨, 아니면 null */
export type RunnerTokenVerifier = (presented: unknown) => { tokenId: string; label: string } | null;

export type RunnerAdapterOptions = {
  /** 서버의 Socket.IO — 이 어댑터가 `io.of(RUNNER_NAMESPACE)` 를 맡는다 */
  io: Server;
  verifyToken: RunnerTokenVerifier;
  /** 거절 로그·실패 카운터의 원격 주소. 던지면 `handshake.address` */
  clientAddress: (socket: Socket) => string;
  /** 브리지·첨부 HTTP 와 같은 인스턴스(러너 스펙 5장) — 막힌 주소는 토큰을 보지 않고 거절한다 */
  authGuard: BridgeAuthGuard;
  onBlocked: (address: string) => void;
  now: () => number;
  serverVersion: string;
  logger: AdapterLogger;
  /** run.start 에 실을 채널 이름·새 세션 제목 */
  channelName: (channelId: string) => string | undefined;
  /** outbound.post·최종 답을 서버가 받아 메시지를 만든다 — 오케스트레이터의 onCanonical 과 같은 자리 */
  onOutbound: (m: OutboundMessage) => Promise<{ messageId: string }>;
  /** AdapterStatus.runners.tokens */
  tokenCount: () => number;
  approvalTtlMs?: number;
};

export interface RunnerAdapter extends AgentAdapter {
  readonly provider: "claude";
  status(): ClaudeAdapterStatus;
  setupDetail(): ClaudeSetupDetail;
}

const HELLO_TIMEOUT_MS = 10_000;
const RUN_START_ACK_TIMEOUT_MS = 15_000;
const REJECT_LOG_INTERVAL_MS = 60_000;
const REJECT_LOG_MAX_ADDRESSES = 1_024;
const USAGE_EVENT = "dodok.usage";

/**
 * 러너가 `run.event` 로 보낼 수 있는 변형. 수명(RUN_*)·승인(APPROVAL_*)·대기(RUN_QUEUED)·상태(STATE_SNAPSHOT)는 서버와 이 어댑터가
 * 만드는 사실이라 러너가 지어내면 런 상태·승인 카드를 흉내 낼 수 있다. 서브에이전트 변형은 서버 런 id 를 싣는다 — 러너는 모른다
 */
const RUNNER_EVENT_TYPES: ReadonlySet<RunEventType> = new Set<RunEventType>([
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_REPLACE",
  "TEXT_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "TOOL_CALL_RESULT",
  "STEP_STARTED",
  "STEP_FINISHED",
  "CUSTOM",
]);
// 비용은 run.final 에서만 만든다 — 러너가 CUSTOM 으로 다른 값을 겹쳐 쓰지 못하게
const RESERVED_CUSTOM_NAMES: ReadonlySet<string> = new Set([USAGE_EVENT, "openclaw.usage"]);

type RunTrack = {
  runId: string;
  runner: Runner;
  deliver: InboundDeliver;
  agent: RunnerAgent;
  started: boolean;
  openTools: Set<string>;
  aborted: boolean;
  /** run.start ack 를 기다리는 중이면 — 러너가 끊기면 곧바로 send 를 끝낸다 */
  rejectAck?: (error: AdapterError) => void;
};

type SocketAuth = { tokenId?: string; label?: string };

function issues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

export function createRunnerAdapter(opts: RunnerAdapterOptions): RunnerAdapter {
  const { logger, now } = opts;
  const namespace = opts.io.of(RUNNER_NAMESPACE) as unknown as Namespace<
    RunnerClientToServerEvents,
    RunnerServerToClientEvents
  >;
  const handlers = new Set<(e: AdapterEvent) => void>();
  const registry = new RunnerRegistry();
  const runs = new Map<string, RunTrack>();
  // hello 전 연결까지 — 폐기는 hello 여부와 무관하게 그 토큰의 연결을 전부 끊는다
  const sockets = new Map<string, { socket: RunnerSocket; tokenId: string }>();
  const helloTimers = new Set<ReturnType<typeof setTimeout>>();
  const rejectLog = new Map<string, { at: number; suppressed: number }>();
  const inflightPosts = new Map<string, Promise<{ messageId: string }>>();
  let closed = false;
  // 러너는 매 런 채널 규칙을 싣고(판정 P3) 세션 UUID 는 서버가 정한다(판정 P4)
  const capabilities: AdapterCapabilities = {
    sessionReset: true,
    agentsList: true,
    configSet: true,
    promptEveryRun: true,
    serverSessionIds: true,
  };

  function emit(event: AdapterEvent) {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error({ err: error, kind: event.kind }, "adapter event handler threw");
      }
    }
  }
  const emitEvent = (runId: string, event: RunEventBody) => emit({ kind: "run_event", runId, event });
  const emitSignal = (runId: string, signal: RunSignal) => emit({ kind: "run_signal", runId, signal });

  const status = (): ClaudeAdapterStatus => ({
    provider: "claude",
    runners: { connected: registry.size, tokens: opts.tokenCount() },
  });
  const setupDetail = (): ClaudeSetupDetail => ({ provider: "claude", runners: registry.connections() });
  function announceRunners() {
    emit({ kind: "status", status: status(), capabilities: { ...capabilities } });
    emit({ kind: "setup" });
  }

  const isLive = (runner: Runner) => registry.get(runner.socket.id) === runner;
  const approvals = new RunnerApprovals({
    ttlMs: opts.approvalTtlMs ?? RUNNER_APPROVAL_TTL_MS,
    now,
    isLive,
    emit: (approval) => emit({ kind: "approval", approval }),
  });

  function remoteAddress(socket: Socket): string {
    try {
      return opts.clientAddress(socket);
    } catch {
      return socket.handshake.address;
    }
  }

  /** 폐기된 토큰으로 재접속을 되풀이하는 러너가 로그를 채우지 않게 주소별 1분에 한 줄 */
  function logRejected(address: string, reason: string, at: number) {
    const entry = rejectLog.get(address);
    if (entry && at - entry.at < REJECT_LOG_INTERVAL_MS) {
      entry.suppressed += 1;
      return;
    }
    rejectLog.delete(address);
    rejectLog.set(address, { at, suppressed: 0 });
    while (rejectLog.size > REJECT_LOG_MAX_ADDRESSES)
      rejectLog.delete(rejectLog.keys().next().value as string);
    logger.warn({ address, reason, suppressed: entry?.suppressed ?? 0 }, "runner connection rejected");
  }

  // 브리지 핸드셰이크(openclaw-adapter bridge/server.ts)와 같은 순서 — 막혔으면 토큰을 보지 않는다, 검증 실패만 센다
  namespace.use((socket, next) => {
    const address = remoteAddress(socket as unknown as Socket);
    const at = now();
    if (opts.authGuard.isBlocked(address, at)) {
      logRejected(address, "blocked after repeated failures", at);
      return next(new Error("RATE_LIMITED"));
    }
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    let verified: { tokenId: string; label: string } | null;
    try {
      verified = opts.verifyToken(token);
    } catch {
      // 검증 함수 오류(저장소 등)는 러너 잘못이 아니라 실패로 세지 않는다
      logRejected(address, "token verification failed", at);
      return next(new Error("UNAUTHORIZED"));
    }
    if (verified) {
      Object.assign(socket.data as SocketAuth, verified);
      return next();
    }
    if (opts.authGuard.fail(address, at)) opts.onBlocked(address);
    logRejected(address, "token mismatch", at);
    next(new Error("UNAUTHORIZED"));
  });

  /** 러너를 빼고 그 러너에 걸린 런·승인을 닫는다. 교체와 disconnect 가 겹쳐 두 번 불려도 한 번만 한다 */
  function dropRunner(runner: Runner, reason: string) {
    const owned = runner.agents.filter((a) => registry.owner(a.id) === runner).map((a) => a.id);
    if (!registry.remove(runner.socket.id)) return;
    logger.info({ tokenId: runner.tokenId, label: runner.label, reason }, "runner disconnected");
    if (closed) return;
    for (const run of runs.values()) {
      if (run.runner !== runner) continue;
      runs.delete(run.runId);
      const error = new AdapterError("ADAPTER_UNAVAILABLE", "runner disconnected");
      // ack 전이면 send 가 던지고 오케스트레이터가 닫는다 — 여기서 RUN_ERROR 를 겹쳐 내지 않는다
      if (run.rejectAck) {
        run.rejectAck(error);
        continue;
      }
      emitEvent(run.runId, { type: "RUN_ERROR", runId: run.runId, code: error.code, message: error.message });
      emitSignal(run.runId, { kind: "gateway_error", code: error.code, message: error.message });
    }
    approvals.cancelForRunner(runner);
    for (const agentId of owned) {
      const next = registry.owner(agentId);
      if (next) logger.info({ agentId, tokenId: next.tokenId, label: next.label }, "runner agent taken over");
    }
    announceRunners();
  }

  function onHello(socket: RunnerSocket, auth: Required<SocketAuth>, payload: unknown, ack: unknown) {
    const reply = (r: RunnerHelloResult) => {
      if (typeof ack === "function") ack(r);
    };
    const existing = registry.get(socket.id);
    if (existing) {
      logger.warn({ tokenId: auth.tokenId }, "runner hello repeated — ignored");
      return reply({ ok: true, serverVersion: opts.serverVersion, conflicts: registry.conflicts(existing) });
    }
    const reject = (message: string, detail: object) => {
      logger.warn({ tokenId: auth.tokenId, ...detail }, "runner hello rejected");
      reply({ ok: false, code: "PROTOCOL_MISMATCH", message });
      socket.disconnect(true);
    };
    const parsed = RunnerHello.safeParse(payload);
    if (!parsed.success)
      return reject("hello does not match the runner protocol", { issues: issues(parsed.error) });
    if (parsed.data.runnerProtocol !== RUNNER_PROTOCOL) {
      return reject(`server speaks runner protocol ${RUNNER_PROTOCOL}`, {
        runnerProtocol: parsed.data.runnerProtocol,
      });
    }
    // 토큰 하나 = 러너 하나. 뒤 연결이 이긴다 — 앞 연결을 먼저 빼야 뒤 연결의 에이전트가 자기와 충돌하지 않는다
    const previous = registry.byToken(auth.tokenId);
    if (previous) {
      dropRunner(previous, "replaced");
      previous.socket.disconnect(true);
    }
    const runner = createRunner({
      socket,
      tokenId: auth.tokenId,
      label: auth.label,
      hello: parsed.data,
      connectedAt: new Date(now()).toISOString(),
    });
    registry.add(runner);
    const conflicts = registry.conflicts(runner);
    if (conflicts.length > 0) {
      logger.warn(
        { tokenId: runner.tokenId, label: runner.label, conflicts },
        "runner agent ids already taken",
      );
    }
    logger.info(
      {
        tokenId: runner.tokenId,
        label: runner.label,
        runnerVersion: runner.hello.runnerVersion,
        sdkVersion: runner.hello.sdkVersion,
        claudeCodeVersion: runner.hello.claudeCodeVersion,
        agents: runner.agents.map((a) => a.id),
      },
      "runner hello",
    );
    reply({ ok: true, serverVersion: opts.serverVersion, conflicts });
    announceRunners();
  }

  /** 이 러너가 띄운 런이면 그 추적 — 남의 런·모르는 런은 버린다 */
  function ownRun(runner: Runner, runId: string, frame: string): RunTrack | undefined {
    const run = runs.get(runId);
    if (run?.runner === runner) return run;
    logger.warn(
      { tokenId: runner.tokenId, runId, frame },
      "runner frame for a run it does not own — dropped",
    );
    return undefined;
  }

  function onRunEvent(runner: Runner, payload: unknown) {
    const parsed = RunnerRunEvent.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { tokenId: runner.tokenId, issues: issues(parsed.error) },
        "runner run.event violates contract",
      );
      return;
    }
    const { runId, event } = parsed.data as { runId: string; event: RunEventBody };
    const run = ownRun(runner, runId, "run.event");
    if (!run) return;
    if (
      !RUNNER_EVENT_TYPES.has(event.type) ||
      (event.type === "CUSTOM" && RESERVED_CUSTOM_NAMES.has(event.name)) ||
      event.runId !== runId
    ) {
      logger.warn(
        { tokenId: runner.tokenId, runId, type: event.type },
        "runner run.event not allowed — dropped",
      );
      return;
    }
    if (!run.started) {
      run.started = true;
      emitSignal(runId, { kind: "gateway_started" });
    }
    emitEvent(runId, event);
    switch (event.type) {
      case "TEXT_MESSAGE_CONTENT":
      case "TEXT_MESSAGE_REPLACE":
        emitSignal(runId, { kind: "text_delta" });
        return;
      case "TOOL_CALL_START":
        run.openTools.add(event.toolCallId);
        emitSignal(runId, { kind: "tool_start" });
        return;
      // 도구가 끝나는 것은 결과가 왔을 때다 — TOOL_CALL_END 는 입력 블록이 닫힌 것뿐이고 도구는 그 뒤에 돈다(ADR 0007 6의 4 대응표)
      case "TOOL_CALL_RESULT":
        run.openTools.delete(event.toolCallId);
        emitSignal(runId, { kind: "tool_end", openTools: run.openTools.size });
        return;
    }
  }

  async function onRunFinal(runner: Runner, payload: unknown) {
    const parsed = RunnerRunFinal.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { tokenId: runner.tokenId, issues: issues(parsed.error) },
        "runner run.final violates contract",
      );
      return;
    }
    const final = parsed.data;
    const run = ownRun(runner, final.runId, "run.final");
    if (!run) return;
    runs.delete(run.runId);
    approvals.cancelForRun(run.runId);
    const usage: RunUsage = { costKind: final.costKind, model: run.agent.model };
    if (final.usage?.inputTokens !== undefined) usage.inputTokens = final.usage.inputTokens;
    if (final.usage?.outputTokens !== undefined) usage.outputTokens = final.usage.outputTokens;
    if (final.costUsd !== undefined) usage.costUsd = final.costUsd;
    emitEvent(run.runId, { type: "CUSTOM", runId: run.runId, name: USAGE_EVENT, value: usage });
    // 중지한 런의 중간 답은 올리지 않는다 — 오케스트레이터가 이미 aborted 로 닫았고, 정본 저장은 끝난 런에도 메시지를 만든다
    if (run.aborted || final.text.trim() === "") {
      emitSignal(run.runId, { kind: "gateway_final" });
      return;
    }
    const d = run.deliver;
    const message: OutboundMessage = {
      // 같은 런의 최종 답은 하나 — 메시지 external_id 유일 인덱스가 재전송을 흡수한다
      outboundId: `runner-final:${run.runId}`,
      channelId: d.channelId,
      agentId: d.agentId,
      sessionKey: d.sessionKey,
      ...(d.threadId === undefined ? {} : { threadId: d.threadId }),
      runId: run.runId,
      replyToInboundId: d.message.id,
      text: final.text,
      attachmentIds: [],
      ts: new Date(now()).toISOString(),
    };
    try {
      // 정본이 먼저 저장되면 종료 신호에서 곧바로 done 이다 — finalizing 상한을 기다리지 않는다
      await opts.onOutbound(message);
      emitSignal(run.runId, { kind: "gateway_final" });
    } catch (error) {
      // 저장이 실패하면 스냅숏을 싣는다 — 오케스트레이터가 finalizing 상한에서 그 글로 메시지를 만든다
      logger.warn(
        { err: error, runId: run.runId },
        "runner final message store failed — falling back to snapshot",
      );
      emit({
        kind: "run_signal",
        runId: run.runId,
        signal: { kind: "gateway_final" },
        snapshotText: final.text,
      });
    }
  }

  function onRunError(runner: Runner, payload: unknown) {
    const parsed = RunnerRunError.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { tokenId: runner.tokenId, issues: issues(parsed.error) },
        "runner run.error violates contract",
      );
      return;
    }
    const { runId, code, message } = parsed.data;
    if (!ownRun(runner, runId, "run.error")) return;
    runs.delete(runId);
    approvals.cancelForRun(runId);
    emitEvent(runId, { type: "RUN_ERROR", runId, code, message });
    emitSignal(runId, { kind: "gateway_error", code, message });
  }

  async function onOutboundPost(runner: Runner, payload: unknown, ack: unknown) {
    const reply = (r: RunnerOutboundAck) => {
      if (typeof ack === "function") ack(r);
    };
    const parsed = RunnerOutboundPost.safeParse(payload);
    if (!parsed.success) return reply({ ok: false, code: "VALIDATION", message: issues(parsed.error) });
    const post = parsed.data;
    const deny = (message: string) => {
      logger.warn({ tokenId: runner.tokenId, agentId: post.agentId, runId: post.runId }, message);
      reply({ ok: false, code: "FORBIDDEN", message });
    };
    // 러너는 자기가 맡은 에이전트로만, 그 에이전트의 세션으로만, 자기 런에만 쓴다
    if (registry.owner(post.agentId) !== runner) return deny("agent is not assigned to this runner");
    if (parseDodokSessionKey(post.sessionKey)?.providerAgentId !== post.agentId) {
      return deny("sessionKey does not belong to the agent");
    }
    const run = post.runId === undefined ? undefined : runs.get(post.runId);
    if (run && run.runner !== runner) return deny("run belongs to another runner");
    let pending = inflightPosts.get(post.outboundId);
    if (!pending) {
      pending = opts.onOutbound(post).finally(() => inflightPosts.delete(post.outboundId));
      inflightPosts.set(post.outboundId, pending);
    }
    try {
      const { messageId } = await pending;
      emit({ kind: "canonical", message: post });
      reply({ ok: true, messageId });
    } catch (error) {
      const code = ErrorCode.safeParse((error as { code?: unknown } | null)?.code).data ?? "INTERNAL";
      logger.warn(
        { err: error, tokenId: runner.tokenId, outboundId: post.outboundId },
        "runner outbound.post failed",
      );
      reply({ ok: false, code, message: "outbound message failed" });
    }
  }

  function onApprovalRequested(runner: Runner, payload: unknown) {
    const parsed = RunnerApprovalRequested.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { tokenId: runner.tokenId, issues: issues(parsed.error) },
        "runner approval.requested violates contract",
      );
      return;
    }
    const run = ownRun(runner, parsed.data.runId, "approval.requested");
    if (!run) return;
    // 세션 키로 채널·에이전트를 푼다 — 런의 키와 다르면 다른 채널의 카드를 띄우려는 것이다
    if (parsed.data.sessionKey !== run.deliver.sessionKey) {
      logger.warn(
        { tokenId: runner.tokenId, runId: run.runId },
        "runner approval sessionKey mismatch — dropped",
      );
      return;
    }
    approvals.request(runner, parsed.data);
  }

  function onApprovalWithdrawn(runner: Runner, payload: unknown) {
    const parsed = RunnerApprovalWithdrawn.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { tokenId: runner.tokenId, issues: issues(parsed.error) },
        "runner approval.withdrawn violates contract",
      );
      return;
    }
    approvals.withdraw(runner, parsed.data.providerApprovalId);
  }

  namespace.on("connection", (socket) => {
    const { tokenId, label } = socket.data as SocketAuth;
    if (tokenId === undefined || label === undefined) {
      socket.disconnect(true);
      return;
    }
    const auth = { tokenId, label };
    sockets.set(socket.id, { socket, tokenId });
    const helloTimer = setTimeout(() => {
      helloTimers.delete(helloTimer);
      if (registry.get(socket.id)) return;
      logger.warn({ tokenId }, "runner sent no hello in time — disconnecting");
      socket.disconnect(true);
    }, HELLO_TIMEOUT_MS);
    helloTimers.add(helloTimer);
    // hello 전 프레임은 버린다 — 등록되지 않은 러너는 런도 에이전트도 없다
    const ready = (): Runner | undefined => registry.get(socket.id);
    const on = <A extends unknown[]>(event: string, handler: (runner: Runner, ...args: A) => unknown) => {
      (socket as unknown as Socket).on(event, (...args: unknown[]) => {
        const runner = ready();
        if (runner) void handler(runner, ...(args as A));
      });
    };

    (socket as unknown as Socket).on("hello", (payload: unknown, ack: unknown) => {
      if (registry.get(socket.id) === undefined) {
        clearTimeout(helloTimer);
        helloTimers.delete(helloTimer);
      }
      onHello(socket, auth, payload, ack);
    });
    on("run.event", onRunEvent);
    on("run.final", onRunFinal);
    on("run.error", onRunError);
    on("outbound.post", onOutboundPost);
    on("approval.requested", onApprovalRequested);
    on("approval.withdrawn", onApprovalWithdrawn);
    socket.on("disconnect", () => {
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      sockets.delete(socket.id);
      const runner = registry.get(socket.id);
      if (runner) dropRunner(runner, "disconnect");
    });
  });

  return {
    provider: "claude",

    async connect() {
      // 네임스페이스는 만들 때 붙였다 — 러너가 먼저 붙어 오므로 기다릴 연결이 없다
    },

    async close() {
      closed = true;
      for (const timer of helloTimers) clearTimeout(timer);
      helloTimers.clear();
      approvals.close();
      for (const run of runs.values())
        run.rejectAck?.(new AdapterError("ADAPTER_UNAVAILABLE", "adapter closed"));
      runs.clear();
      namespace.disconnectSockets(true);
    },

    status,
    capabilities: () => ({ ...capabilities }),
    setupDetail,

    revokeTokenSessions(tokenId) {
      let count = 0;
      // disconnect 가 동기로 지금 항목을 sockets 에서 지운다 — Map 순회는 남은 항목을 이어 돈다
      for (const { socket, tokenId: id } of sockets.values()) {
        if (id !== tokenId) continue;
        count += 1;
        socket.disconnect(true);
      }
      logger.info({ tokenId, sessions: count }, "runner sessions revoked");
      return count;
    },

    async listAgents() {
      return registry.all().flatMap((runner) =>
        runner.agents
          .filter((a) => registry.owner(a.id) === runner)
          .map((a) => ({
            providerAgentId: a.id,
            name: a.name,
            hint: `${runner.label} · ${a.workdirLabel} · ${a.model}`,
          })),
      );
    },

    sessionKeyFor: dodokSessionKey,

    supports: (providerAgentId, capability) =>
      registry.owner(providerAgentId)?.capabilities.includes(capability) ?? false,

    async send(input, sendOpts) {
      if (closed) throw new AdapterError("ADAPTER_UNAVAILABLE", "adapter closed");
      if (sendOpts?.providerSessionId === undefined) {
        throw new AdapterError("INTERNAL", "runner adapter needs a server-chosen providerSessionId");
      }
      const runner = registry.owner(input.agentId);
      const agent = runner?.agents.find((a) => a.id === input.agentId);
      if (!runner || !agent) throw new AdapterError("ADAPTER_UNAVAILABLE", "no runner serves this agent");
      const channelName = opts.channelName(input.channelId) ?? input.channelId;
      const start = RunnerRunStart.safeParse({
        deliver: input,
        providerSessionId: sendOpts.providerSessionId,
        channelRulesAppend: buildChannelRulesAppend({
          channelName,
          channelPrompt: input.context.channelPrompt,
          promptOverride: input.context.promptOverride,
          relayRules: input.context.relayRules,
        }),
        turnFacts: buildTurnFacts({
          participants: input.context.participants,
          thread: input.threadId !== undefined,
        }),
        sessionTitle: `${channelName} · ${agent.name}`.slice(0, 120),
      });
      if (!start.success) throw new AdapterError("INTERNAL", `run.start invalid: ${issues(start.error)}`);

      // 러너는 ack 전에도 이벤트를 보낼 수 있다 — 보내기 전에 등록한다
      const run: RunTrack = {
        runId: input.runId,
        runner,
        deliver: input,
        agent,
        started: false,
        openTools: new Set(),
        aborted: false,
      };
      runs.set(run.runId, run);
      let raw: unknown;
      try {
        raw = await new Promise((resolve, reject) => {
          run.rejectAck = reject;
          runner.socket.timeout(RUN_START_ACK_TIMEOUT_MS).emit("run.start", start.data, (err, res) => {
            if (err) reject(new AdapterError("ADAPTER_UNAVAILABLE", "runner did not ack run.start in time"));
            else resolve(res);
          });
        });
      } catch (error) {
        if (runs.get(run.runId) === run) runs.delete(run.runId);
        throw error;
      } finally {
        run.rejectAck = undefined;
      }
      const ack = RunnerRunAck.safeParse(raw);
      if (!ack.success || ack.data.runId !== run.runId) {
        runs.delete(run.runId);
        const why = ack.success ? "runId mismatch" : issues(ack.error);
        throw new AdapterError("INTERNAL", `ADAPTER_PROTOCOL: run.ack ${why}`);
      }
      if (ack.data.admission === "drop") {
        runs.delete(run.runId);
        return ack.data.reason === undefined
          ? { admission: "drop" }
          : { admission: "drop", reason: ack.data.reason };
      }
      if (ack.data.queuedPosition !== undefined) {
        emitEvent(run.runId, { type: "RUN_QUEUED", runId: run.runId, position: ack.data.queuedPosition });
      }
      logger.info(
        {
          runId: run.runId,
          deliveryId: input.deliveryId,
          tokenId: runner.tokenId,
          queuedPosition: ack.data.queuedPosition,
        },
        "runner run started",
      );
      return { admission: "dispatch", providerRunId: run.runId };
    },

    async abort(runId) {
      const run = runs.get(runId);
      if (!run) return;
      run.aborted = true;
      if (isLive(run.runner)) run.runner.socket.emit("run.abort", { runId });
    },

    // 러너에 할 일이 없다 — 「새 대화」는 서버가 세션 행의 UUID 를 비우는 것으로 끝난다(판정 P4)
    async resetSession() {
      return {};
    },

    // 러너는 채널 규칙을 매 런 run.start 에 싣는다 — 따로 밀어 넣을 설정이 없다
    async syncChannelConfig() {
      return { applied: "live" };
    },

    async resolveApproval(providerApprovalId, kind, decision) {
      if (kind !== "tool")
        throw new AdapterError("INTERNAL", `approval kind ${kind} is not a runner approval`);
      return approvals.resolve(providerApprovalId, decision);
    },

    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    forgetRun(runId) {
      runs.delete(runId);
      approvals.cancelForRun(runId);
    },
  };
}
