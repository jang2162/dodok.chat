/**
 * `AgentAdapter` 의 OpenClaw 구현 — 서버 코어 스펙 6장·8장.
 *
 * Gateway WS(`connection-manager`)는 델타·툴 이벤트·세션 요청, 브리지(`attachBridge`)는 인바운드 전송·정본·채널 설정.
 * 응답 정본은 브리지 `outbound.message` 이고, 서버가 저장한 id 를 `onCanonical` 훅으로 받아 플러그인에 ack 한다.
 */
import type {
  ApprovalDecision,
  ApprovalKind,
  ConfigSet,
  ConfigSetResult,
  InboundDeliver,
  InboundDeliverResult,
  OutboundMessage,
} from "@dodok/shared";
import type { EventFrame } from "@openclaw/gateway-protocol";
import type { Server } from "socket.io";
import { z } from "zod";
import {
  AdapterError,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterLogger,
  type AgentAdapter,
  type OpenClawAdapterStatus,
  type OpenClawSetupDetail,
} from "./adapter-types";
import {
  attachBridge,
  type BridgeHandle,
  type BridgeServerOptions,
  type BridgeTokenVerifier,
} from "./bridge/server";
import { syncChannelConfig } from "./config-sync";
import {
  GatewayApprovalKind,
  isApprovalEvent,
  mergeApproval,
  parseApprovalFrame,
  parseResolveResult,
  resolveParams,
  sameApproval,
  type ProviderApproval,
} from "./gateway/approvals";
import { connectGateway } from "./gateway/client";
import {
  createConnectionManager,
  gatewayHost,
  type GatewayConnector,
  type GatewayState,
  type RecoverTarget,
} from "./gateway/connection-manager";
import { createGatewayEventMapper } from "./gateway/events";
import { type FrameDump, openFrameDump } from "./gateway/frame-dump";
import { parseSessionsReset, sessionKeyFor } from "./gateway/sessions";

export type OpenClawAdapterOptions = {
  /**
   * 이 Gateway 연결의 id — 이벤트·send 결과·정본 훅에 싣는다(멀티 Gateway 스펙 4장). 아직 연결은 하나라 메서드가 받는 연결 id 는
   * 보지 않는다(멀티 Gateway 계획 판정 PG1)
   */
  connectionId: string;
  gateway: { url: string; token: string; deviceIdentityPath: string; deviceTokenStorePath?: string };
  /**
   * 플러그인 핸드셰이크 인증은 `verifyToken`(통과면 토큰 id — 세션이 기억하고 폐기 때 그 id 로 끊는다).
   * `clientAddress` 는 거절 로그의 원격 주소(없으면 `handshake.address`) — `BridgeServerOptions.clientAddress`
   */
  bridge: {
    io: Server;
    serverVersion: string;
    ackTimeoutMs?: number;
    verifyToken: BridgeTokenVerifier;
    clientAddress?: BridgeServerOptions["clientAddress"];
    /** 거절 로그의 주소 꼴(`BridgeServerOptions.logAddress`) — 서버가 IP 를 가린다 */
    logAddress?: BridgeServerOptions["logAddress"];
    /** 인증 실패 카운터 — 서버가 첨부 HTTP 와 같은 인스턴스를 준다(`BridgeServerOptions.authGuard`) */
    authGuard?: BridgeServerOptions["authGuard"];
    onBlocked?: BridgeServerOptions["onBlocked"];
    /** 거절 스로틀·실패 카운터의 시계(ms) — 테스트 주입. 기본 `Date.now` */
    now?: BridgeServerOptions["now"];
  };
  logger: AdapterLogger;
  /** 서버가 정본을 저장하고 id 를 돌려준다. 그 id 가 플러그인 ack 의 messageId 가 된다. connectionId 는 정본이 온 연결 */
  onCanonical: (message: OutboundMessage, connectionId: string) => Promise<{ messageId?: string }>;
  /** 그 연결의 재접속 복구 대상(서버 agent_sessions). */
  sessionKeysToRecover?: (connectionId: string) => RecoverTarget[];
  /** 기본 `connectGateway` (테스트 주입) */
  connector?: GatewayConnector;
  backoff?: { initialMs?: number; maxMs?: number; pairingRetryMs?: number };
  /** 있으면 받은 `chat`·`agent`·`session.message` 프레임을 이 파일에 JSONL 로 append 한다(진단용, 본문 포함 — data/ 아래에) */
  frameDumpPath?: string;
};

/** 상태·설정 상세는 openclaw 변형으로 좁혀 둔다 — 이 어댑터를 직접 쥔 쪽(테스트·dev:fake)은 좁히지 않고 읽는다 */
export interface OpenClawAdapter extends AgentAdapter {
  readonly provider: "openclaw";
  status(): OpenClawAdapterStatus;
  setupDetail(): OpenClawSetupDetail;
  readonly bridge: BridgeHandle;
  /** 세션 키 → `chat.history` deltaCursor. 서버가 저장했다가 `sessionKeysToRecover` 의 cursor 로 돌려줄 수 있다. */
  readonly historyCursors: Map<string, string>;
}

// 계약 스펙 8.3 — ack 타임아웃 10s, 없으면 1·4·16s 뒤 재전송(3회). 플러그인 미접속은 120s 기다린다(queued 상한).
const DELIVER_ACK_TIMEOUT_MS = 10_000;
// 플러그인은 트리거 이미지를 받은 뒤에야 런을 시작해 ack 한다(장당 받기 상한 30s) — 그 전에 재전송하면 이중 디스패치다(Ruling 1)
const DELIVER_ACK_PER_IMAGE_MS = 30_000;
const DELIVER_RETRY_DELAYS_MS = [1_000, 4_000, 16_000];
const PLUGIN_READY_WAIT_MS = 120_000;
// final 뒤에도 같은 런의 늦은 프레임(usage 등)이 온다 — 그동안은 우리 런으로 본다.
const FORGET_AFTER_FINAL_MS = 60_000;
// 승인 병합 기억 상한. Gateway 의 세션 되감기 상한과 같은 1000 — 넘으면 오래 손대지 않은 것부터 버린다.
const APPROVAL_DEDUPE_MAX = 1_000;

const AgentsListResult = z.looseObject({
  agents: z.array(z.looseObject({ id: z.string().min(1), name: z.string().optional().catch(undefined) })),
});

export function createOpenClawAdapter(opts: OpenClawAdapterOptions): OpenClawAdapter {
  const { logger, connectionId } = opts;
  const handlers = new Set<(e: AdapterEvent) => void>();
  const knownRunIds = new Set<string>();
  // `providerApprovalId` → 마지막으로 낸 병합본. 같은 승인이 정본·세션·되감기 세 경로로, 경로마다 다른 필드를 채워 온다(스파이크 3.1).
  const emittedApprovals = new Map<string, ProviderApproval>();
  const forgetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // send 재시도 대기 — close() 가 타이머를 지우고 기다리는 send 를 끝낸다
  const retryWaits = new Map<ReturnType<typeof setTimeout>, (error: AdapterError) => void>();
  let closed = false;
  // 채널 프롬프트는 새 세션에서만(ADR 0003), 세션 id 는 Gateway 가 정한다
  const capabilities: AdapterCapabilities = {
    sessionReset: true,
    agentsList: true,
    configSet: true,
    promptEveryRun: false,
    serverSessionIds: false,
  };
  let gatewayState: GatewayState = "down";
  let bridgeState: OpenClawAdapterStatus["bridge"] = "down";
  const gatewayHostLabel = gatewayHost(opts.gateway.url);
  // 마지막으로 알린(또는 처음) setupDetail — 같은 상세면 setup 이벤트를 내지 않는다
  let lastSetupKey: string | undefined;
  let setupCheckQueued = false;

  function emit(event: AdapterEvent) {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error({ err: error, kind: event.kind }, "adapter event handler threw");
      }
    }
  }

  const status = (): OpenClawAdapterStatus => ({
    provider: "openclaw",
    gateway: gatewayState,
    bridge: bridgeState,
  });
  const emitStatus = () => emit({ kind: "status", status: status(), capabilities: { ...capabilities } });

  function setBridgeState(next: OpenClawAdapterStatus["bridge"]) {
    if (bridgeState === next) return;
    bridgeState = next;
    logger.info({ bridge: next }, "bridge status changed");
    emitStatus();
  }

  /**
   * setupDetail 이 바뀌었으면 setup 이벤트를 한 번 낸다. 한 동기 구간의 여러 변화(예: reconnecting + 페어링)는
   * 마이크로태스크로 모아 한 번만 비교한다.
   */
  function queueSetupCheck() {
    if (setupCheckQueued) return;
    setupCheckQueued = true;
    queueMicrotask(() => {
      setupCheckQueued = false;
      const key = JSON.stringify(setupDetail());
      if (key === lastSetupKey) return;
      lastSetupKey = key;
      emit({ kind: "setup" });
    });
  }

  function disableCapability(name: keyof AdapterCapabilities) {
    if (!capabilities[name]) return;
    capabilities[name] = false;
    logger.warn({ capability: name }, "gateway capability disabled (FORBIDDEN)");
    emitStatus();
  }

  const mapper = createGatewayEventMapper({ isOurRun: (runId) => knownRunIds.has(runId) });
  const frameDump: FrameDump | undefined =
    opts.frameDumpPath === undefined ? undefined : openFrameDump(opts.frameDumpPath, logger);

  function forgetRun(runId: string) {
    clearTimeout(forgetTimers.get(runId));
    forgetTimers.delete(runId);
    knownRunIds.delete(runId);
    mapper.forget(runId);
  }

  function forgetRunLater(runId: string) {
    clearTimeout(forgetTimers.get(runId));
    const timer = setTimeout(() => forgetRun(runId), FORGET_AFTER_FINAL_MS);
    timer.unref();
    forgetTimers.set(runId, timer);
  }

  /**
   * 같은 승인의 여러 프레임을 **병합해서** 낸다 — 뒤엣것을 버리지 않는다(p2-t6 실측 C).
   *
   * 실물은 같은 승인을 `plugin.approval.requested`(`toolCallId` 있음·`urlPath` 없음)와
   * `session.approval`(`urlPath` 있음·`toolCallId` 없음)로 나눠 준다. 먼저 온 쪽만 남기면 어느 순서든 한쪽 값을 잃는다.
   * 상태도 그대로고 새로 채운 필드도 없으면 — 같은 사실을 또 읽은 것이라 — 내지 않는다.
   * 기억은 오래 손대지 않은 것부터 버려 무한히 자라지 않게 한다.
   */
  function emitApproval(incoming: ProviderApproval) {
    const id = incoming.providerApprovalId;
    const previous = emittedApprovals.get(id);
    const approval = previous ? mergeApproval(previous, incoming) : incoming;
    if (previous && sameApproval(previous, approval)) return;
    // 다시 넣어 맨 뒤로 보낸다 — 아직 오가는 승인이 먼저 밀려나지 않게
    emittedApprovals.delete(id);
    emittedApprovals.set(id, approval);
    for (const oldest of emittedApprovals.keys()) {
      if (emittedApprovals.size <= APPROVAL_DEDUPE_MAX) break;
      emittedApprovals.delete(oldest);
    }
    emit({ kind: "approval", connectionId, approval });
  }

  function onGatewayEvent(frame: EventFrame) {
    frameDump?.write(frame);
    if (isApprovalEvent(frame.event)) {
      const approval = parseApprovalFrame(frame.event, frame.payload);
      // 우리 세션이 아닌 승인(다른 채널 플러그인·TUI)도 전역으로 온다 — 버린다. 세션 키·본문은 남기지 않는다.
      if (approval) emitApproval(approval);
      else logger.debug({ event: frame.event }, "gateway approval frame ignored");
      return;
    }
    for (const item of mapper.map(frame)) {
      if (item.event) emit({ kind: "run_event", runId: item.runId, connectionId, event: item.event });
      if (!item.signal) continue;
      emit({
        kind: "run_signal",
        runId: item.runId,
        connectionId,
        signal: item.signal,
        ...(item.snapshotText === undefined ? {} : { snapshotText: item.snapshotText }),
      });
      if (item.signal.kind === "gateway_final") forgetRunLater(item.runId);
      else if (item.signal.kind === "gateway_error" || item.signal.kind === "gateway_aborted")
        forgetRun(item.runId);
    }
  }

  const manager = createConnectionManager({
    gateway: opts.gateway,
    connector: opts.connector ?? connectGateway,
    logger,
    onEvent: onGatewayEvent,
    onState: (next) => {
      gatewayState = next;
      emitStatus();
      queueSetupCheck();
    },
    onDetail: () => queueSetupCheck(),
    onApprovalReplay: (approvals) => {
      for (const approval of approvals) emitApproval(approval);
    },
    ...(opts.sessionKeysToRecover
      ? { sessionKeysToRecover: () => opts.sessionKeysToRecover?.(connectionId) ?? [] }
      : {}),
    ...(opts.backoff ? { backoff: opts.backoff } : {}),
  });

  const bridge = attachBridge(opts.bridge.io, {
    verifyToken: opts.bridge.verifyToken,
    ...(opts.bridge.clientAddress === undefined ? {} : { clientAddress: opts.bridge.clientAddress }),
    ...(opts.bridge.logAddress === undefined ? {} : { logAddress: opts.bridge.logAddress }),
    ...(opts.bridge.authGuard === undefined ? {} : { authGuard: opts.bridge.authGuard }),
    ...(opts.bridge.onBlocked === undefined ? {} : { onBlocked: opts.bridge.onBlocked }),
    ...(opts.bridge.now === undefined ? {} : { now: opts.bridge.now }),
    serverVersion: opts.bridge.serverVersion,
    ...(opts.bridge.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: opts.bridge.ackTimeoutMs }),
    onHello: (_session, hello) => {
      // gatewayVersion 은 플러그인이 돌고 있는 Gateway 의 runtime.version. pluginBuiltWithSdk 는 빌드 때 박힌
      // openclaw devDependency 버전이라 Gateway 버전이 아니다(9.5 위에서도 2026.9.4 로 찍힌다)
      logger.info(
        {
          pluginVersion: hello.version,
          pluginBuiltWithSdk: hello.sdkVersion,
          gatewayVersion: hello.gatewayVersion ?? null,
        },
        "bridge plugin hello",
      );
      setBridgeState("connected");
      queueSetupCheck();
    },
    onClose: (session) => {
      queueSetupCheck();
      // 새 연결이 이전 연결을 교체할 때는 down 을 거치지 않는다
      if (session.closeReason === "replaced") return;
      if (!bridge.current()) setBridgeState("down");
    },
    onOutboundMessage: async (_session, message) => {
      const stored = await opts.onCanonical(message, connectionId);
      emit({ kind: "canonical", connectionId, message });
      return { messageId: stored.messageId ?? message.outboundId };
    },
    // 받으면 버린다 — 플러그인은 typing 을 내지 않고(capability "typing" 없음), 에이전트가 일하는 중이라는 표시는 웹 런 버블이 맡는다
    onTyping: () => undefined,
    onStatus: (_session, pluginStatus) => logger.debug({ pluginStatus }, "bridge plugin status"),
    onRejected: (reason) => logger.warn({ reason }, "bridge connection rejected"),
  });

  function setupDetail(): OpenClawSetupDetail {
    const gateway = manager.detail();
    const session = bridge.current();
    const hello = session?.hello;
    return {
      provider: "openclaw",
      gateway: { state: gatewayState, host: gatewayHostLabel, ...gateway },
      bridge: {
        state: bridgeState,
        plugin:
          session && hello
            ? {
                version: hello.version,
                sdkVersion: hello.sdkVersion,
                gatewayVersion: hello.gatewayVersion ?? null,
                bundleSha256: hello.bundleSha256 ?? null,
                tokenId: session.tokenId,
                connectedAt: session.connectedAt.toISOString(),
              }
            : null,
      },
    };
  }
  lastSetupKey = JSON.stringify(setupDetail());

  const adapterClosed = () => new AdapterError("ADAPTER_UNAVAILABLE", "adapter closed");

  function retryDelay(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        retryWaits.delete(timer);
        resolve();
      }, ms);
      retryWaits.set(timer, reject);
    });
  }

  async function deliver(input: InboundDeliver): Promise<InboundDeliverResult> {
    const images = input.message.attachments.filter((a) => a.kind === "image").length;
    const ackTimeoutMs = DELIVER_ACK_TIMEOUT_MS + DELIVER_ACK_PER_IMAGE_MS * images;
    let timeoutRetries = 0;
    let waitedForPlugin = false;
    const firstAttemptAt = performance.now();
    for (;;) {
      if (closed) throw adapterClosed();
      // 플러그인·재시도를 기다리는 사이 서버가 런을 닫고 forgetRun 했다(queued 상한) — 닫힌 런을 늦게 보내지 않는다
      if (!knownRunIds.has(input.runId)) {
        throw new AdapterError("ADAPTER_UNAVAILABLE", "run forgotten before delivery");
      }
      const res = await bridge.deliverInbound(input, ackTimeoutMs);
      if (res.ok) {
        // 진단용 — 본문·토큰은 싣지 않는다. ackMs 는 첫 전송 시도부터(플러그인 대기·재시도 포함)
        logger.info(
          {
            runId: input.runId,
            deliveryId: input.deliveryId,
            admission: res.data.admission,
            ackMs: Math.round(performance.now() - firstAttemptAt),
            retries: timeoutRetries,
            waitedForPlugin,
          },
          "inbound delivered",
        );
        return res.data;
      }
      if (closed) throw adapterClosed();
      const { code, message } = res.error;
      const delayMs = DELIVER_RETRY_DELAYS_MS[timeoutRetries];
      if (code === "TIMEOUT" && delayMs !== undefined) {
        timeoutRetries += 1;
        logger.warn(
          { runId: input.runId, deliveryId: input.deliveryId, retry: timeoutRetries, delayMs },
          "inbound.deliver ack timeout; retrying",
        );
        await retryDelay(delayMs);
        continue;
      }
      if (code === "ADAPTER_UNAVAILABLE" && !waitedForPlugin) {
        waitedForPlugin = true;
        logger.info({ runId: input.runId, waitMs: PLUGIN_READY_WAIT_MS }, "plugin not connected; waiting");
        try {
          await bridge.waitForReady(PLUGIN_READY_WAIT_MS);
        } catch {
          // 브리지 close() 도 대기자를 reject 한다
          if (closed) throw adapterClosed();
          throw new AdapterError(
            "ADAPTER_UNAVAILABLE",
            `plugin not connected within ${PLUGIN_READY_WAIT_MS}ms`,
          );
        }
        continue;
      }
      throw new AdapterError(code, message);
    }
  }

  return {
    provider: "openclaw",
    bridge,
    historyCursors: manager.historyCursors,

    async connect() {
      manager.start();
    },

    async close() {
      closed = true;
      emittedApprovals.clear();
      for (const timer of forgetTimers.values()) clearTimeout(timer);
      forgetTimers.clear();
      for (const [timer, reject] of retryWaits) {
        clearTimeout(timer);
        reject(adapterClosed());
      }
      retryWaits.clear();
      // 스펙 2장 종료 순서 — 플러그인에 system.notice shutdown(대기 중인 waitForReady 도 끝낸다) → Gateway 연결 종료
      bridge.close();
      try {
        await manager.stop();
      } catch (error) {
        // stopAndWait 5s 초과 등 — 종료는 계속한다
        logger.warn({ err: error }, "gateway stop failed during close");
      }
      await frameDump?.close(); // Gateway 가 닫힌 뒤 — 마지막 프레임까지 남긴다
    },

    status,
    capabilities: () => ({ ...capabilities }),
    setupDetail,

    revokeTokenSessions(tokenId) {
      const sessions = bridge.revokeSessions(tokenId);
      logger.info({ tokenId, sessions }, "bridge sessions revoked");
      return sessions;
    },

    async listAgents(_connectionId) {
      let res: unknown;
      try {
        res = await manager.request("agents.list", {});
      } catch (error) {
        if (error instanceof AdapterError && error.code === "FORBIDDEN") disableCapability("agentsList");
        throw error;
      }
      const parsed = AgentsListResult.safeParse(res);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        throw new AdapterError("INTERNAL", `ADAPTER_PROTOCOL: agents.list ${issues}`);
      }
      return parsed.data.agents.map((agent) =>
        agent.name === undefined
          ? { providerAgentId: agent.id }
          : { providerAgentId: agent.id, name: agent.name },
      );
    },

    sessionKeyFor,

    // 에이전트를 가리지 않는다 — Gateway 의 모든 에이전트가 붙은 플러그인 하나를 지난다
    supports: (_providerAgentId, _connectionId, capability) =>
      bridge.current()?.hello?.capabilities.includes(capability) ?? false,

    async send(input, _opts) {
      // 플러그인은 런이 시작될 때(onAgentRunStart) ack 하므로 Gateway 이벤트가 ack 보다 먼저 올 수 있다 — 전송 전에 등록한다
      knownRunIds.add(input.runId);
      // 접속 뒤 새로 생긴 세션은 재접속 복구 구독에 없다 — 전송 전에 구독해야 Gateway 델타·툴 이벤트가 온다(Phase 1 실연에서 발견).
      // Gateway 가 끊겨 있으면 건너뛴다(정본은 플러그인 경로) — 다시 붙을 때 recover 가 agent_sessions 로 구독한다.
      try {
        await manager.subscribeSession(input.sessionKey, input.agentId);
      } catch (error) {
        const unavailable = (error as { code?: unknown }).code === "ADAPTER_UNAVAILABLE";
        logger[unavailable ? "debug" : "warn"](
          { err: error, sessionKey: input.sessionKey },
          "gateway session subscribe before send failed",
        );
      }
      try {
        const result = await deliver(input);
        if (result.admission === "drop") forgetRun(input.runId);
        return { ...result, connectionId };
      } catch (error) {
        forgetRun(input.runId);
        throw error;
      }
    },

    async abort(runId, sessionKey, _connectionId) {
      await manager.request("chat.abort", { sessionKey, runId });
    },

    async resetSession(sessionKey, _connectionId) {
      try {
        return parseSessionsReset(await manager.request("sessions.reset", { key: sessionKey }));
      } catch (error) {
        if (error instanceof AdapterError && error.code === "FORBIDDEN") disableCapability("sessionReset");
        throw error;
      }
    },

    syncChannelConfig: (
      channelId: string,
      config: ConfigSet["config"],
      _connectionId: string,
    ): Promise<ConfigSetResult> => syncChannelConfig(bridge, logger, channelId, config),

    async resolveApproval(
      providerApprovalId: string,
      kind: ApprovalKind,
      decision: ApprovalDecision,
      _connectionId: string,
    ) {
      // 재접속 중(reconnecting)에도 결정을 보내지 않는다 — 승인 서비스가 하던 선검사를 어댑터 안으로 옮겼다(러너 계획 판정 P6)
      if (gatewayState !== "connected")
        throw new AdapterError("ADAPTER_UNAVAILABLE", "gateway is not connected");
      // tool 은 러너 어댑터의 승인이다 — 여기로 왔다면 잘못 짝지어진 것이라 Gateway 에 보내지 않는다
      const gatewayKind = GatewayApprovalKind.safeParse(kind).data;
      if (!gatewayKind)
        throw new AdapterError("INTERNAL", `approval kind ${kind} is not an OpenClaw approval`);
      // 연결이 없으면 manager 가 ADAPTER_UNAVAILABLE 을 던진다(다른 RPC 와 같은 규칙).
      const res = await manager.request(
        "approval.resolve",
        resolveParams({ providerApprovalId, kind: gatewayKind }, decision),
      );
      // 이미 확정된 승인은 `applied:false` 로 오지만 스냅샷은 그대로다 — 오류가 아니다(스파이크 4.4).
      const approval = parseResolveResult(res, gatewayKind);
      if (!approval) {
        throw new AdapterError("INTERNAL", "ADAPTER_PROTOCOL: approval.resolve terminal snapshot unreadable");
      }
      return approval;
    },

    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    forgetRun,
  };
}
