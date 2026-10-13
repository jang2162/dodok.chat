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
  type ControlResult,
  buildTurnFacts,
  type ClaudeAdapterStatus,
  type ClaudeSetupDetail,
  dodokSessionKey,
  parseDodokSessionKey,
  ErrorCode,
  type InboundDeliver,
  type OutboundMessage,
  type RunEventBody,
  type RunEventType,
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL,
  RUNNER_SHUTDOWN_STOP_REASON,
  type RunnerAgent,
  RunnerApprovalRequested,
  RunnerApprovalWithdrawn,
  type RunnerClientToServerEvents,
  RunnerControlCall,
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
import {
  createRunner,
  type Runner,
  RunnerRegistry,
  type RunnerSocket,
  UNREADABLE_BINDING,
} from "./connections";

export { RUNNER_APPROVAL_TTL_MS };

/** 핸드셰이크 `auth.token`(외부 입력 그대로)을 보고 통과면 그 토큰의 id·라벨, 아니면 null */
export type RunnerTokenVerifier = (presented: unknown) => { tokenId: string; label: string } | null;

/**
 * 러너 프레임 버킷 이름 — `run.event`(스트리밍 델타)와 나머지(hello·post·수명·승인)를 나눈다. 열린 런·기다리는 승인을 가리키는
 * 종결·승인 프레임 가운데 처리기가 받아들일 것은 버킷을 거치지 않는다(승인 요청은 런마다 누계 RUN_FREE_APPROVALS 개까지 —
 * namesOpenWork)
 */
export type RunnerFrameBucket = "events" | "control";

/**
 * 러너가 보내는 프레임의 속도 제한 — 러너 소켓마다 buckets() 를 한 번 부른다(숫자는 서버 LIMITS.runner). 넘친 프레임은 버리고
 * onLimited 는 주소별 1분에 한 번, 그사이 버린 수(dropped)와 함께 부른다
 */
export type RunnerFrameLimit = {
  buckets: () => Record<RunnerFrameBucket, { take(): boolean }>;
  onLimited: (address: string, frame: string, dropped: number) => void;
};

/**
 * 등록된 Claude 에이전트와 러너 토큰의 묶임(정본은 서버 DB — agents.runner_token_id). 묶인 에이전트는 그 토큰의 러너만 맡는다
 */
export type RunnerAgentBindings = {
  /** 그 id 의 등록 에이전트가 묶인 토큰 id. 묶이지 않았거나 등록되지 않았으면 null */
  boundToken(agentId: string): string | null;
  /** 묶이지 않은 등록 에이전트를 그 토큰에 묶는다(첫 연결). 묶었으면 true — 등록되지 않았거나 이미 묶였으면 false */
  claim(agentId: string, tokenId: string): boolean;
};

export type RunnerAdapterOptions = {
  /** 서버의 Socket.IO — 이 어댑터가 `io.of(RUNNER_NAMESPACE)` 를 맡는다 */
  io: Server;
  verifyToken: RunnerTokenVerifier;
  /** 거절 로그·실패 카운터의 원격 주소. 던지면 `handshake.address` */
  clientAddress: (socket: Socket) => string;
  /** 거절 로그의 주소 꼴(서버가 IP 를 가린다). 없으면 그대로 — 실패 카운터·스로틀은 원래 주소 */
  logAddress?: (address: string) => string;
  /** 브리지·첨부 HTTP 와 같은 인스턴스(러너 스펙 5장) — 막힌 주소는 토큰을 보지 않고 거절한다 */
  authGuard: BridgeAuthGuard;
  onBlocked: (address: string) => void;
  now: () => number;
  serverVersion: string;
  logger: AdapterLogger;
  /** run.start 에 실을 채널 이름·새 세션 제목 */
  channelName: (channelId: string) => string | undefined;
  /** outbound.post·최종 답을 서버가 받아 메시지를 만든다 — 오케스트레이터의 onCanonical 과 같은 자리. connectionId 는 보낸 러너의 토큰 id */
  onOutbound: (m: OutboundMessage, connectionId: string) => Promise<{ messageId: string }>;
  /** AdapterStatus.runners.tokens */
  tokenCount: () => number;
  /**
   * 제어 도구 호출(control.call)을 서버가 처리한다 — connectionId 는 보낸 러너의 토큰 id. 확인 카드를 기다리는 동안 늦게 끝나고
   * (최대 CONTROL_CONFIRM_TTL_MS), 던지지 않고 결과를 돌려준다. 없으면 호출마다 ADAPTER_UNAVAILABLE
   */
  onControlCall?: (connectionId: string, call: RunnerControlCall) => Promise<ControlResult>;
  approvalTtlMs?: number;
  bindings: RunnerAgentBindings;
  frameLimit: RunnerFrameLimit;
};

export interface RunnerAdapter extends AgentAdapter {
  readonly provider: "claude";
  status(): ClaudeAdapterStatus;
  setupDetail(): ClaudeSetupDetail;
  /**
   * 러너 첨부 GET 의 읽기 범위(조율자 판정 R5) — 그 토큰의 러너에 지금 열린 런의 deliver 로 보낸 첨부면 true. 런이 끝나거나
   * 러너가 끊기면 곧바로 false 다(열린 런 추적에서 빠진다)
   */
  mayReadAttachment(tokenId: string, attachmentId: string): boolean;
  /** 그 id 를 지금 맡을 러너의 토큰 id — 에이전트 등록이 이 토큰에 묶는다. 맡을 러너가 없으면 undefined */
  servingTokenId(agentId: string): string | undefined;
}

const HELLO_TIMEOUT_MS = 10_000;
const RUN_START_ACK_TIMEOUT_MS = 15_000;
const REJECT_LOG_INTERVAL_MS = 60_000;
const REJECT_LOG_MAX_ADDRESSES = 1_024;
const LIMIT_LOG_INTERVAL_MS = 60_000;
/** 한 런이 control 버킷을 거치지 않고 받을 수 있는 승인 요청의 누계 — 넘으면 그다음 요청부터 버킷을 센다 */
export const RUN_FREE_APPROVALS = 32;
const USAGE_EVENT = "dodok.usage";
/** interrupt 로 끝난 턴의 run.final stopReason */
const ABORTED_STOP_REASON = "aborted";
const UNKNOWN_FRAME_LOG_INTERVAL_MS = 60_000;
const SESSION_TITLE_MAX = 120;
/** 최종 답 글 상한 — 정본 OutboundMessage.text·Message.bodyMd 의 상한과 같다 */
const FINAL_TEXT_MAX = 100_000;
const FINAL_TRUNCATED_TAIL = "\n\n(길어서 잘렸습니다)";
// 러너가 보낼 수 있는 프레임 이름 — 나머지는 Socket.IO 가 조용히 버리므로 따로 warn 한다
const RUNNER_FRAMES: ReadonlySet<string> = new Set<keyof RunnerClientToServerEvents>([
  "hello",
  "run.event",
  "run.final",
  "run.error",
  "outbound.post",
  "approval.requested",
  "approval.withdrawn",
  "control.call",
]);
// 프레임이 쓰는 버킷 — run.event 는 모델 델타마다 오므로 따로 넉넉하게, 나머지는 런마다 몇 번뿐이다. 열린 런·기다리는 승인을
// 가리키는 종결·승인 프레임 가운데 처리기가 받아들일 것은 버킷을 거치지 않는다(승인 요청은 런마다 누계 RUN_FREE_APPROVALS 개까지
// — namesOpenWork)
export const FRAME_BUCKET: Record<keyof RunnerClientToServerEvents, RunnerFrameBucket> = {
  hello: "control",
  "run.event": "events",
  "run.final": "control",
  "run.error": "control",
  "outbound.post": "control",
  "approval.requested": "control",
  "approval.withdrawn": "control",
  "control.call": "control",
};

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
  /** control 버킷 밖으로 받은 승인 요청의 누계 — 철회·결정에도 줄지 않는다(까닭은 namesOpenWork) */
  freeApprovals: number;
  /** run.start 의 dispatch ack 전이면 — 러너가 끊기면 곧바로 send 를 끝낸다 */
  rejectAck?: (error: AdapterError) => void;
};

type SocketAuth = { tokenId?: string; label?: string };

/**
 * DISCONNECT 패킷 없이 전송만 닫는다 — 러너는 `transport close` 로 받아 백오프 재접속한다(Ruling R4). 서버 종료·hello 타임아웃처럼
 * 러너 잘못이 아닌 끊김에 쓴다. `disconnect(true)` 는 러너에 `io server disconnect` 로 가고 러너는 종료한다(토큰 폐기·같은 토큰 교체·
 * hello 거절 — 다시 붙어도 소용없는 끊김)
 */
function dropTransport(socket: { conn: { close(): void } }): void {
  socket.conn.close();
}

/** 코드 포인트 경계에서 UTF-16 길이 max 안으로 자른다 — 서로게이트 쌍을 반으로 가르지 않는다(스키마 길이는 UTF-16) */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * 최종 답을 정본 상한 안으로 — 넘치면 꼬리를 붙여 자른다. 러너 계약(RunnerRunFinal.text)에는 상한이 없고 저장이 스키마에 걸리면
 * 스냅숏도 같은 글로 실패해 답이 조용히 사라진다(최종 리뷰 M1). 어느 판본의 러너가 붙어도 막히게 러너가 아니라 여기서 자른다
 */
function fitFinalText(text: string): string {
  if (text.length <= FINAL_TEXT_MAX) return text;
  return clip(text, FINAL_TEXT_MAX - FINAL_TRUNCATED_TAIL.length) + FINAL_TRUNCATED_TAIL;
}

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
  const registry = new RunnerRegistry((agentId) => {
    try {
      return opts.bindings.boundToken(agentId);
    } catch (error) {
      logger.error({ err: error, agentId }, "runner agent binding lookup failed");
      return UNREADABLE_BINDING;
    }
  });
  const runs = new Map<string, RunTrack>();
  // hello 전 연결까지 — 폐기는 hello 여부와 무관하게 그 토큰의 연결을 전부 끊는다
  const sockets = new Map<string, { socket: RunnerSocket; tokenId: string }>();
  const helloTimers = new Set<ReturnType<typeof setTimeout>>();
  const rejectLog = new Map<string, { at: number; suppressed: number }>();
  const limitLog = new Map<string, { at: number; suppressed: number }>();
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
  // 연결 id 는 그 런을 맡은 러너의 토큰 id(멀티 Gateway 스펙 「어댑터 계약」 절) — 서버가 런의 연결과 대조한다
  const emitEvent = (connectionId: string, runId: string, event: RunEventBody) =>
    emit({ kind: "run_event", runId, connectionId, event });
  const emitSignal = (connectionId: string, runId: string, signal: RunSignal) =>
    emit({ kind: "run_signal", runId, connectionId, signal });

  const status = (): ClaudeAdapterStatus => ({
    provider: "claude",
    runners: { connected: registry.size, tokens: opts.tokenCount() },
  });
  const setupDetail = (): ClaudeSetupDetail => ({ provider: "claude", runners: registry.connections() });
  function announceRunners() {
    emit({ kind: "status", status: status(), capabilities: { ...capabilities } });
    emit({ kind: "setup" });
  }

  /**
   * 첫 연결 묶기 — 지금 맡는 러너가 있는데 묶임이 없는 등록 에이전트를 그 러너 토큰에 묶는다. 묶임 없는 기존 행(묶임이 생기기
   * 전에 등록된 것)도, 맡을 러너 없이 등록된 것도 이 길로 묶인다. 미등록 id 는 claim 이 false 라 그대로다
   */
  function claimUnbound() {
    for (const { agentId, runner } of registry.unboundOwned()) {
      try {
        if (opts.bindings.claim(agentId, runner.tokenId))
          logger.info({ agentId, tokenId: runner.tokenId, label: runner.label }, "runner agent bound");
      } catch (error) {
        logger.error({ err: error, agentId, tokenId: runner.tokenId }, "runner agent bind failed");
      }
    }
  }

  const isLive = (runner: Runner) => registry.get(runner.socket.id) === runner;
  const approvals = new RunnerApprovals({
    ttlMs: opts.approvalTtlMs ?? RUNNER_APPROVAL_TTL_MS,
    now,
    isLive,
    emit: (approval, runner) => emit({ kind: "approval", connectionId: runner.tokenId, approval }),
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
    const shown = opts.logAddress ? opts.logAddress(address) : address;
    logger.warn({ address: shown, reason, suppressed: entry?.suppressed ?? 0 }, "runner connection rejected");
  }

  /**
   * 넘친 프레임 — 주소별 1분에 한 줄 warn 과 onLimited(운영 사건). 버릴 때마다 쓰면 러너 한 소켓이 초당 수천 번 버릴 때
   * 막으려던 로그·DB 쓰기를 이것이 대신 만든다. dropped 는 이 줄까지 버린 수(앞 줄 뒤로 말없이 버린 것 포함)
   */
  function onFrameLimited(address: string, frame: string, tokenId: string) {
    const at = now();
    const entry = limitLog.get(address);
    if (entry && at - entry.at < LIMIT_LOG_INTERVAL_MS) {
      entry.suppressed += 1;
      return;
    }
    limitLog.delete(address);
    limitLog.set(address, { at, suppressed: 0 });
    while (limitLog.size > REJECT_LOG_MAX_ADDRESSES) limitLog.delete(limitLog.keys().next().value as string);
    const dropped = (entry?.suppressed ?? 0) + 1;
    logger.warn({ address, tokenId, frame, dropped }, "runner frames rate limited — dropped");
    try {
      opts.frameLimit.onLimited(address, frame, dropped);
    } catch (error) {
      logger.error({ err: error }, "runner frame limit handler threw");
    }
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
    releaseRunner(runner);
    // 묶인 에이전트는 이어받지 않는다 — 이어받는 것은 묶임 없는 id 뿐이고, 그중 등록된 것은 여기서 새 러너에 묶인다
    for (const agentId of owned) {
      const next = registry.owner(agentId);
      if (next) logger.info({ agentId, tokenId: next.tokenId, label: next.label }, "runner agent taken over");
    }
    claimUnbound();
    announceRunners();
  }

  /** 레지스트리에서 빠진 러너의 런은 오류로, 떠 있던 승인은 철회로 닫는다 */
  function releaseRunner(runner: Runner) {
    for (const run of runs.values()) {
      if (run.runner !== runner) continue;
      runs.delete(run.runId);
      const error = new AdapterError("ADAPTER_UNAVAILABLE", "runner disconnected");
      // dispatch ack 전이면 send 가 던지고 오케스트레이터가 닫는다 — 여기서 RUN_ERROR 를 겹쳐 내지 않는다
      if (run.rejectAck) {
        run.rejectAck(error);
        continue;
      }
      emitEvent(run.runner.tokenId, run.runId, {
        type: "RUN_ERROR",
        runId: run.runId,
        code: error.code,
        message: error.message,
      });
      emitSignal(run.runner.tokenId, run.runId, {
        kind: "gateway_error",
        code: error.code,
        message: error.message,
      });
    }
    approvals.cancelForRunner(runner);
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
    const runner = createRunner({
      socket,
      tokenId: auth.tokenId,
      label: auth.label,
      hello: parsed.data,
      connectedAt: new Date(now()).toISOString(),
    });
    // 토큰 하나 = 러너 하나. 뒤 연결이 이기고 앞 연결의 자리를 그대로 잇는다 — 뒤 연결의 에이전트가 자기와 충돌하지 않고,
    // 앞 연결이 빠진 틈에 다른 러너가 에이전트를 가져가지도 않는다. 앞 연결의 런은 그 소켓과 함께 끝난다
    const previous = registry.byToken(auth.tokenId);
    if (previous) {
      registry.replace(previous, runner);
      logger.info(
        { tokenId: previous.tokenId, label: previous.label, reason: "replaced" },
        "runner disconnected",
      );
      releaseRunner(previous);
      previous.socket.disconnect(true);
    } else {
      registry.add(runner);
    }
    claimUnbound();
    const conflicts = registry.conflicts(runner);
    if (conflicts.length > 0) {
      logger.warn(
        { tokenId: runner.tokenId, label: runner.label, conflicts },
        "runner agent ids not assigned to this runner (bound to another token or announced first by another runner)",
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
      emitSignal(runner.tokenId, runId, { kind: "gateway_started" });
    }
    emitEvent(runner.tokenId, runId, event);
    switch (event.type) {
      case "TEXT_MESSAGE_CONTENT":
      case "TEXT_MESSAGE_REPLACE":
        emitSignal(runner.tokenId, runId, { kind: "text_delta" });
        return;
      case "TOOL_CALL_START":
        run.openTools.add(event.toolCallId);
        emitSignal(runner.tokenId, runId, { kind: "tool_start" });
        return;
      // 도구가 끝나는 것은 결과가 왔을 때다 — TOOL_CALL_END 는 입력 블록이 닫힌 것뿐이고 도구는 그 뒤에 돈다(ADR 0007 6의 4 대응표)
      case "TOOL_CALL_RESULT":
        run.openTools.delete(event.toolCallId);
        emitSignal(runner.tokenId, runId, { kind: "tool_end", openTools: run.openTools.size });
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
    // 잴 것이 하나도 없으면(대기열에서 중지된 런 — init 을 못 봐 costKind 는 기본값) 내지 않는다 — 비용 없는 런이
    // API 키 러너 행에 「환산 포함」을 켜지 않게(최종 리뷰 M2)
    const measured =
      usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.costUsd !== undefined;
    if (measured)
      emitEvent(run.runner.tokenId, run.runId, {
        type: "CUSTOM",
        runId: run.runId,
        name: USAGE_EVENT,
        value: usage,
      });
    // 중지된 턴(서버가 abort 했거나 러너 쪽에서 interrupt — 러너는 수명 이벤트를 run.event 로 보내지 않는다)은 메시지 없이
    // 중지로 닫는다. 중간 답을 올리면 안 된다 — 정본 저장은 끝난 런에도 메시지를 만든다. 서버가 이미 aborted 로 닫은 런이면
    // 오케스트레이터가 이 둘을 버린다
    if (run.aborted || final.stopReason === ABORTED_STOP_REASON) {
      emitEvent(run.runner.tokenId, run.runId, { type: "RUN_ABORTED", runId: run.runId, by: "user" });
      emitSignal(run.runner.tokenId, run.runId, { kind: "gateway_aborted" });
      return;
    }
    // 러너를 끄느라 멈춘 턴 — 사람 중지가 아니다. 러너가 끊긴 런과 같이 닫아 채널에 「다시 실행」 카드가 뜨게 한다
    if (final.stopReason === RUNNER_SHUTDOWN_STOP_REASON) {
      const error = new AdapterError("ADAPTER_UNAVAILABLE", "runner stopped");
      emitEvent(run.runner.tokenId, run.runId, {
        type: "RUN_ERROR",
        runId: run.runId,
        code: error.code,
        message: error.message,
      });
      emitSignal(run.runner.tokenId, run.runId, {
        kind: "gateway_error",
        code: error.code,
        message: error.message,
      });
      return;
    }
    if (final.text.trim() === "") {
      emitSignal(run.runner.tokenId, run.runId, { kind: "gateway_final" });
      return;
    }
    const d = run.deliver;
    const text = fitFinalText(final.text);
    const message: OutboundMessage = {
      // 같은 런의 최종 답은 하나 — 메시지 external_id 유일 인덱스가 재전송을 흡수한다
      outboundId: `runner-final:${run.runId}`,
      channelId: d.channelId,
      agentId: d.agentId,
      sessionKey: d.sessionKey,
      ...(d.threadId === undefined ? {} : { threadId: d.threadId }),
      runId: run.runId,
      replyToInboundId: d.message.id,
      text,
      attachmentIds: [],
      ts: new Date(now()).toISOString(),
    };
    try {
      // 정본이 먼저 저장되면 종료 신호에서 곧바로 done 이다 — finalizing 상한을 기다리지 않는다
      await opts.onOutbound(message, run.runner.tokenId);
      emitSignal(run.runner.tokenId, run.runId, { kind: "gateway_final" });
    } catch (error) {
      // 저장이 실패하면 스냅숏을 싣는다 — 오케스트레이터가 finalizing 상한에서 그 글로 메시지를 만든다
      logger.warn(
        { err: error, runId: run.runId },
        "runner final message store failed — falling back to snapshot",
      );
      emit({
        kind: "run_signal",
        runId: run.runId,
        connectionId: run.runner.tokenId,
        signal: { kind: "gateway_final" },
        snapshotText: text,
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
    emitEvent(runner.tokenId, runId, { type: "RUN_ERROR", runId, code, message });
    emitSignal(runner.tokenId, runId, { kind: "gateway_error", code, message });
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
    // 러너는 자기에게 배정된 열린 런에만, 그 런의 채널·에이전트·세션·스레드 그대로 쓴다. 끝난 런 id 를 실으면 서버가 그 런의
    // 에이전트 글로 저장하고, 런 없는 글은 다른 채널에도 저장된다 — 어느 쪽도 이 러너가 흉내 낼 자리가 아니다
    const run = post.runId === undefined ? undefined : runs.get(post.runId);
    if (!run || run.runner !== runner || run.aborted)
      return deny("post must belong to an open run of this runner");
    const d = run.deliver;
    if (
      post.channelId !== d.channelId ||
      post.agentId !== d.agentId ||
      post.sessionKey !== d.sessionKey ||
      post.threadId !== d.threadId
    ) {
      return deny("post does not match its run");
    }
    let pending = inflightPosts.get(post.outboundId);
    if (!pending) {
      pending = opts.onOutbound(post, runner.tokenId).finally(() => inflightPosts.delete(post.outboundId));
      inflightPosts.set(post.outboundId, pending);
    }
    try {
      const { messageId } = await pending;
      emit({ kind: "canonical", connectionId: runner.tokenId, message: post });
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

  /**
   * 제어 도구 호출(제어 MCP 스펙 「Claude 러너」 절) — 이 러너가 맡은 열린 런의 이름으로만 받는다. 끝난 런·남의 런이면 서버에 묻지
   * 않고 NOT_FOUND(서버도 principalForRunner 로 한 번 더 본다). ack 는 서버의 결과가 올 때까지 미룬다 — 확인 카드를 기다리면 길다
   */
  async function onControlCall(runner: Runner, payload: unknown, ack: unknown) {
    const reply = (r: ControlResult) => {
      if (typeof ack === "function") ack(r);
    };
    const fail = (code: ErrorCode, message: string) => reply({ ok: false, error: { code, message } });
    const parsed = RunnerControlCall.safeParse(payload);
    if (!parsed.success) return fail("VALIDATION", issues(parsed.error));
    const call = parsed.data;
    const run = runs.get(call.runId);
    if (!run || run.runner !== runner || run.aborted) return fail("NOT_FOUND", "no open run of this runner");
    if (!opts.onControlCall) return fail("ADAPTER_UNAVAILABLE", "control tools are not served");
    try {
      reply(await opts.onControlCall(runner.tokenId, call));
    } catch (error) {
      logger.warn({ err: error, tokenId: runner.tokenId, runId: call.runId }, "runner control.call failed");
      fail("INTERNAL", "control call failed");
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
    // 서버는 이미 그 런을 닫았다 — 카드가 런 없이 남거나 같은 세션의 다음 런에 붙는다. 러너에는 run.abort 가 가 있다
    if (run.aborted) {
      logger.warn(
        { tokenId: runner.tokenId, runId: run.runId, providerApprovalId: parsed.data.providerApprovalId },
        "runner approval for an aborted run — dropped",
      );
      return;
    }
    // 세션 키로 채널·에이전트를 푼다 — 런의 키와 다르면 다른 채널의 카드를 띄우려는 것이다
    if (parsed.data.sessionKey !== run.deliver.sessionKey) {
      logger.warn(
        { tokenId: runner.tokenId, runId: run.runId },
        "runner approval sessionKey mismatch — dropped",
      );
      return;
    }
    const result = approvals.request(runner, parsed.data);
    if (result === "duplicate") {
      // 러너는 결정을 영영 못 받는다 — 런이 runMs 까지 매달리는 원인을 찾을 수 있게 남긴다
      logger.warn(
        { tokenId: runner.tokenId, runId: run.runId, providerApprovalId: parsed.data.providerApprovalId },
        "runner approval id already used — dropped",
      );
    } else if (result === "invalid-session") {
      logger.warn(
        { tokenId: runner.tokenId, runId: run.runId },
        "runner approval sessionKey invalid — dropped",
      );
    }
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

  /**
   * 버킷을 거치지 않는 프레임 — 이 러너의 열린 런을 닫는 run.final·run.error, 그 런의 새 승인 요청, 기다리는 승인의 철회.
   * 이것을 버리면 런은 runMs(기본 10분)에서야 닫히고 러너의 canUseTool 도 그때까지 기다린다. post 를 쏟는 다른 런이 control 을
   * 비웠다고 이 런까지 매달리면 안 된다.
   *
   * 처리기가 받아들일 프레임만 예외다 — 처리기와 같은 조건(계약 스키마, 이 러너가 연 런, 승인은 중지 안 된 런·그 런의 세션 키·
   * 안 쓴 id, 철회는 기다리는 승인)을 먼저 본다. 그래서 한 런의 예외 프레임은 종결 1(처리가 런을 곧바로 지운다) + 요청 누계
   * RUN_FREE_APPROVALS + 그 철회(기다리는 승인마다 한 번 — 받아들인 요청 수 이하)로 묶인다. 요청은 지금 기다리는 수가 아니라
   * 누계(RunTrack.freeApprovals)로 센다 — 철회하면 기다리는 수가 도로 주므로, 요청·철회를 되풀이해 승인 카드·푸시를 버킷을 한
   * 번도 안 세고 끝없이 만든다. 처리기가 버리고 warn 을 쓸 프레임(계약 위반·남의 런·끝난 런·세션 키 불일치·이미 쓴 id)과 누계를
   * 넘은 요청은 control 버킷을 센다 — 열린 runId 하나로 warn 줄을 버킷 밖에서 되풀이하지 못하게. 파싱은 처리기가 한 번 더 한다
   * (예외로 통과하는 수가 묶여 있어 두 번이 싸다). 싼 소유 대조를 먼저 해서, 남의 것·모르는 것을 가리키는 프레임은 파싱하지 않고
   * 버킷으로 간다
   */
  function namesOpenWork(
    runner: Runner | undefined,
    event: keyof RunnerClientToServerEvents,
    payload: unknown,
  ): boolean {
    if (!runner || typeof payload !== "object" || payload === null) return false;
    const { runId, providerApprovalId } = payload as { runId?: unknown; providerApprovalId?: unknown };
    const run = typeof runId === "string" ? runs.get(runId) : undefined;
    const own = run !== undefined && run.runner === runner;
    switch (event) {
      case "run.final":
        return own && RunnerRunFinal.safeParse(payload).success;
      case "run.error":
        return own && RunnerRunError.safeParse(payload).success;
      case "approval.requested": {
        if (
          !own ||
          run.aborted ||
          typeof providerApprovalId !== "string" ||
          approvals.used(runner, providerApprovalId) ||
          run.freeApprovals >= RUN_FREE_APPROVALS
        )
          return false;
        const parsed = RunnerApprovalRequested.safeParse(payload);
        if (
          !parsed.success ||
          parsed.data.sessionKey !== run.deliver.sessionKey ||
          parseDodokSessionKey(parsed.data.sessionKey) === undefined
        )
          return false;
        run.freeApprovals += 1;
        return true;
      }
      case "approval.withdrawn":
        return (
          typeof providerApprovalId === "string" &&
          approvals.isPending(runner, providerApprovalId) &&
          RunnerApprovalWithdrawn.safeParse(payload).success
        );
      default:
        return false;
    }
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
      dropTransport(socket);
    }, HELLO_TIMEOUT_MS);
    helloTimers.add(helloTimer);
    const buckets = opts.frameLimit.buckets();
    const address = remoteAddress(socket as unknown as Socket);
    // hello 전 프레임은 버린다 — 등록되지 않은 러너는 런도 에이전트도 없다
    const ready = (): Runner | undefined => registry.get(socket.id);
    /** 버킷에서 하나 꺼낸다 — 비었으면 false. ack 를 기다리는 프레임이면 RATE_LIMITED 로 답한다 */
    const admit = (event: keyof RunnerClientToServerEvents, args: unknown[]): boolean => {
      if (namesOpenWork(ready(), event, args[0])) return true;
      if (buckets[FRAME_BUCKET[event]].take()) return true;
      onFrameLimited(address, event, tokenId);
      const ack = args.at(-1);
      if (event === "outbound.post" && typeof ack === "function")
        (ack as (r: RunnerOutboundAck) => void)({
          ok: false,
          code: "RATE_LIMITED",
          message: "too many frames",
        });
      if (event === "control.call" && typeof ack === "function")
        (ack as (r: ControlResult) => void)({
          ok: false,
          error: { code: "RATE_LIMITED", message: "too many frames" },
        });
      return false;
    };
    const on = <A extends unknown[]>(
      event: keyof RunnerClientToServerEvents,
      handler: (runner: Runner, ...args: A) => unknown,
    ) => {
      (socket as unknown as Socket).on(event, (...args: unknown[]) => {
        if (!admit(event, args)) return;
        const runner = ready();
        if (runner) void handler(runner, ...(args as A));
      });
    };

    // 스펙 3장 「모르는 프레임 종류는 버리고 warn」 — 되풀이하는 러너가 로그를 채우지 않게 소켓마다 1분에 한 줄
    let unknownFrames: { at: number; suppressed: number } | undefined;
    socket.onAny((event: string) => {
      if (RUNNER_FRAMES.has(event)) return;
      const at = now();
      if (unknownFrames && at - unknownFrames.at < UNKNOWN_FRAME_LOG_INTERVAL_MS) {
        unknownFrames.suppressed += 1;
        return;
      }
      logger.warn(
        { tokenId, event: event.slice(0, 64), suppressed: unknownFrames?.suppressed ?? 0 },
        "runner sent an unknown frame — dropped",
      );
      unknownFrames = { at, suppressed: 0 };
    });
    (socket as unknown as Socket).on("hello", (payload: unknown, ack: unknown) => {
      if (!admit("hello", [payload, ack])) return;
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
    on("control.call", onControlCall);
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
      for (const socket of namespace.sockets.values()) dropTransport(socket);
    },

    status,
    capabilities: () => ({ ...capabilities }),
    setupDetail,

    mayReadAttachment(tokenId, attachmentId) {
      for (const run of runs.values()) {
        if (run.runner.tokenId !== tokenId) continue;
        if (run.deliver.message.attachments.some((a) => a.id === attachmentId)) return true;
      }
      return false;
    },

    servingTokenId: (agentId) => registry.owner(agentId)?.tokenId,

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

    // 연결을 주면 그 토큰의 러너가 알린 것만, null 이면 붙은 러너 전부
    async listAgents(connectionId) {
      return registry.all().flatMap((runner) =>
        connectionId !== null && runner.tokenId !== connectionId
          ? []
          : runner.agents
              .filter((a) => registry.owner(a.id) === runner)
              .map((a) => ({
                providerAgentId: a.id,
                name: a.name,
                hint: `${runner.label} · ${a.workdirLabel} · ${a.model}`,
              })),
      );
    },

    sessionKeyFor: dodokSessionKey,

    // 모른다고 할 수 있는 것은 그 에이전트를 가진 러너가 알리지 않았을 때뿐이다 — 러너가 없으면 오케스트레이터가 옛 러너로
    // 닫지 않고 send 가 ADAPTER_UNAVAILABLE 로 닫게 true
    supports: (providerAgentId, _connectionId, capability) =>
      registry.owner(providerAgentId)?.capabilities.includes(capability) ?? true,

    async send(input, sendOpts) {
      if (closed) throw new AdapterError("ADAPTER_UNAVAILABLE", "adapter closed");
      if (sendOpts?.providerSessionId === undefined) {
        throw new AdapterError("INTERNAL", "runner adapter needs a server-chosen providerSessionId");
      }
      // 연결이 null 이면 묶임 없는 에이전트 — 먼저 알린 러너가 맡는다(registry.owner). 연결을 주면 그 토큰의 러너만 맡는다
      const runner = registry.owner(input.agentId);
      const agent = runner?.agents.find((a) => a.id === input.agentId);
      if (!runner || !agent) throw new AdapterError("ADAPTER_UNAVAILABLE", "no runner serves this agent");
      if (sendOpts.connectionId !== null && runner.tokenId !== sendOpts.connectionId)
        throw new AdapterError("ADAPTER_UNAVAILABLE", "the bound runner does not serve this agent");
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
          reactions: input.context.reactions,
          reactionsOmitted: input.context.reactionsOmitted,
        }),
        sessionTitle: clip(`${channelName} · ${agent.name}`, SESSION_TITLE_MAX),
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
        freeApprovals: 0,
      };
      runs.set(run.runId, run);
      let ack: RunnerRunAck;
      try {
        ack = await new Promise<RunnerRunAck>((resolve, reject) => {
          run.rejectAck = reject;
          runner.socket.timeout(RUN_START_ACK_TIMEOUT_MS).emit("run.start", start.data, (err, raw) => {
            if (err) {
              reject(new AdapterError("ADAPTER_UNAVAILABLE", "runner did not ack run.start in time"));
              return;
            }
            const parsed = RunnerRunAck.safeParse(raw);
            if (!parsed.success || parsed.data.runId !== run.runId) {
              const why = parsed.success ? "runId mismatch" : issues(parsed.error);
              reject(new AdapterError("INTERNAL", `ADAPTER_PROTOCOL: run.ack ${why}`));
              return;
            }
            // 받아들인 런은 이 콜백에서 곧바로 「러너의 런」이 된다 — ack 와 끊김이 같은 틱에 와서 send 가 이어지기 전에
            // dropRunner 가 돌아도 RUN_ERROR 를 낸다(send 는 dispatch 를 돌려주고 오케스트레이터는 이미 닫힌 런으로 본다)
            if (parsed.data.admission === "dispatch") run.rejectAck = undefined;
            resolve(parsed.data);
          });
        });
      } catch (error) {
        if (runs.get(run.runId) === run) runs.delete(run.runId);
        throw error;
      } finally {
        run.rejectAck = undefined;
      }
      if (ack.admission === "drop") {
        runs.delete(run.runId);
        return ack.reason === undefined
          ? { admission: "drop", connectionId: runner.tokenId }
          : { admission: "drop", reason: ack.reason, connectionId: runner.tokenId };
      }
      if (ack.queuedPosition !== undefined && runs.get(run.runId) === run) {
        emitEvent(run.runner.tokenId, run.runId, {
          type: "RUN_QUEUED",
          runId: run.runId,
          position: ack.queuedPosition,
        });
      }
      logger.info(
        {
          runId: run.runId,
          deliveryId: input.deliveryId,
          tokenId: runner.tokenId,
          queuedPosition: ack.queuedPosition,
        },
        "runner run started",
      );
      // 러너 대기열에 선 런 — 오케스트레이터가 queuedMs 로 닫지 않게 알린다(최종 리뷰 I1). 끊김·폐기는 dropRunner 가 닫는다
      return {
        admission: "dispatch",
        providerRunId: run.runId,
        connectionId: runner.tokenId,
        ...(ack.queuedPosition === undefined ? {} : { queued: true }),
      };
    },

    async abort(runId, _sessionKey, _connectionId) {
      const run = runs.get(runId);
      if (!run) return;
      run.aborted = true;
      if (isLive(run.runner)) run.runner.socket.emit("run.abort", { runId });
    },

    // 러너에 할 일이 없다 — 「새 대화」는 서버가 세션 행의 UUID 를 비우는 것으로 끝난다(판정 P4)
    async resetSession(_sessionKey, _connectionId) {
      return {};
    },

    // 러너는 채널 규칙을 매 런 run.start 에 싣는다 — 따로 밀어 넣을 설정이 없다
    async syncChannelConfig(_channelId, _config, _connectionId) {
      return { applied: "live" };
    },

    // 러너 승인 id 는 이미 토큰 id 를 품는다(approvals.ts #id) — 연결 id 를 따로 보지 않는다
    async resolveApproval(providerApprovalId, kind, decision, _connectionId) {
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
