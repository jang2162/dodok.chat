/**
 * `AgentAdapter` 의 OpenClaw 구현 — 서버 코어 스펙 6장·8장, 멀티 Gateway 스펙 「OpenClaw 어댑터·브리지」 절.
 *
 * 어댑터 하나가 Gateway 연결 여럿을 품는다(`connection/manager`). 연결마다 Gateway WS(델타·툴 이벤트·세션 요청)와 브리지 자리
 * (인바운드 전송·정본·채널 설정)를 따로 두고, 이벤트·send 결과에 그 연결 id 를 싣는다. 브리지 네임스페이스 `/bridge` 는 하나이고
 * 토큰이 묶인 Gateway 로 플러그인 연결을 나눠 받는다. 응답 정본은 브리지 `outbound.message` 이고, 서버가 저장한 id 를 `onCanonical`
 * 훅으로 받아 플러그인에 ack 한다.
 */
import type { ConfigSet, ConfigSetResult, OutboundMessage } from "@dodok/shared";
import type { Server } from "socket.io";
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
import type {
  GatewayConnectionConfig,
  GatewaySetupEntry,
  GatewayStatusEntry,
} from "./connection/gateway-connection";
import { createGatewayManager } from "./connection/manager";
import { connectGateway } from "./gateway/client";
import type { GatewayConnector, RecoverTarget } from "./gateway/connection-manager";
import { sessionKeyFor } from "./gateway/sessions";

export type {
  GatewayConnectionConfig,
  GatewayConnectionState,
  GatewaySetupEntry,
  GatewayStatusEntry,
} from "./connection/gateway-connection";

export type OpenClawAdapterOptions = {
  /** 디바이스 아이덴티티·토큰은 Gateway 마다 `${dataDir}/gateways/<id>/` (스펙 3.3) */
  dataDir: string;
  /**
   * 플러그인 핸드셰이크 인증은 `verifyToken`(통과면 토큰 id 와 그 토큰의 Gateway — 세션이 기억하고 폐기 때 그 id 로 끊는다).
   * 꺼졌거나 없는 Gateway 의 토큰은 거절한다. `clientAddress` 는 거절 로그의 원격 주소(없으면 `handshake.address`) —
   * `BridgeServerOptions.clientAddress`
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
  /**
   * 있으면 받은 `chat`·`agent`·`session.message` 프레임을 연결마다 `<path>.<연결 id>` 파일에 JSONL 로 append 한다
   * (진단용, 본문 포함 — data/ 아래에)
   */
  frameDumpPath?: string;
};

/** 상태·설정 상세는 openclaw 변형으로 좁혀 둔다 — 이 어댑터를 직접 쥔 쪽(테스트·dev:fake)은 좁히지 않고 읽는다 */
export interface OpenClawAdapter extends AgentAdapter {
  readonly provider: "openclaw";
  /** Gateway 마다 한 줄(더한 차례) — `gatewayStatuses()` 와 같은 목록. Gateway 가 없으면 빈 목록 */
  status(): OpenClawAdapterStatus;
  /** 첫 켜진 Gateway(더한 차례)의 상세. 없으면 host 가 빈 down/null 블록. Gateway 별 상세는 `gatewaySetupDetails()` */
  setupDetail(): OpenClawSetupDetail;
  readonly bridge: BridgeHandle;
  /**
   * 없으면 만들고, url·token 이 바뀌었으면 그 연결만 다시 붙고(주소가 바뀌면 디바이스 토큰을 지움), enabled=false 면 끊는다.
   * 이름만 바뀌면 다시 붙지 않는다. 끄기·주소/토큰 바꾸기는 그 연결의 열린 런을 ADAPTER_UNAVAILABLE 로 닫는다.
   * id 는 디렉터리 이름이 되므로 영숫자로 시작하고 영숫자·`.`·`_`·`-` 만 — 아니면 던진다
   */
  upsertGateway(config: GatewayConnectionConfig): void;
  /** 연결·플러그인 세션을 끊고 디바이스 디렉터리를 지운다. 열린 런은 ADAPTER_UNAVAILABLE 로 닫는다. 없는 id 는 그냥 끝난다 */
  removeGateway(id: string): Promise<void>;
  /** Gateway 별 상태(더한 차례) */
  gatewayStatuses(): GatewayStatusEntry[];
  /** Gateway 별 설정 상세(더한 차례) — 공유 토큰은 없다 */
  gatewaySetupDetails(): GatewaySetupEntry[];
}

export function createOpenClawAdapter(opts: OpenClawAdapterOptions): OpenClawAdapter {
  const { logger } = opts;
  const handlers = new Set<(e: AdapterEvent) => void>();
  let closed = false;
  // 채널 프롬프트는 새 세션에서만(ADR 0003), 세션 id 는 Gateway 가 정한다. 능력은 어댑터 하나에 하나 — 어느 Gateway 든
  // FORBIDDEN 으로 답하면 끈다
  const capabilities: AdapterCapabilities = {
    sessionReset: true,
    agentsList: true,
    configSet: true,
    promptEveryRun: false,
    serverSessionIds: false,
  };
  // 마지막으로 알린(또는 처음) Gateway 별 상세 — 같은 상세면 setup 이벤트를 내지 않는다
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

  const bridge = attachBridge(opts.bridge.io, {
    verifyToken: opts.bridge.verifyToken,
    acceptGateway: (gatewayId) => !closed && manager.get(gatewayId)?.config().enabled === true,
    ...(opts.bridge.clientAddress === undefined ? {} : { clientAddress: opts.bridge.clientAddress }),
    ...(opts.bridge.logAddress === undefined ? {} : { logAddress: opts.bridge.logAddress }),
    ...(opts.bridge.authGuard === undefined ? {} : { authGuard: opts.bridge.authGuard }),
    ...(opts.bridge.onBlocked === undefined ? {} : { onBlocked: opts.bridge.onBlocked }),
    ...(opts.bridge.now === undefined ? {} : { now: opts.bridge.now }),
    serverVersion: opts.bridge.serverVersion,
    ...(opts.bridge.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: opts.bridge.ackTimeoutMs }),
    onHello: (session, hello) => connectionOf(session.gatewayId)?.onPluginHello(session, hello),
    onClose: (session) => connectionOf(session.gatewayId)?.onPluginClose(session),
    onOutboundMessage: async (session, message) => {
      const connection = connectionOf(session.gatewayId);
      if (!connection) throw new AdapterError("ADAPTER_UNAVAILABLE", "gateway connection is gone");
      return connection.onOutbound(message);
    },
    // 받으면 버린다 — 플러그인은 typing 을 내지 않고(capability "typing" 없음), 에이전트가 일하는 중이라는 표시는 웹 런 버블이 맡는다
    onTyping: () => undefined,
    onStatus: (_session, pluginStatus) => logger.debug({ pluginStatus }, "bridge plugin status"),
    onRejected: (reason) => logger.warn({ reason }, "bridge connection rejected"),
  });

  const manager = createGatewayManager({
    dataDir: opts.dataDir,
    bridge,
    connector: opts.connector ?? connectGateway,
    logger,
    ...(opts.backoff ? { backoff: opts.backoff } : {}),
    ...(opts.sessionKeysToRecover ? { sessionKeysToRecover: opts.sessionKeysToRecover } : {}),
    ...(opts.frameDumpPath === undefined ? {} : { frameDumpPath: opts.frameDumpPath }),
    onCanonical: opts.onCanonical,
    emit,
    onStatusChange: () => emitStatus(),
    onDetailChange: () => queueSetupCheck(),
    onForbidden: disableCapability,
  });

  function connectionOf(gatewayId: string | null) {
    return gatewayId === null ? undefined : manager.get(gatewayId);
  }

  function gatewayStatuses(): GatewayStatusEntry[] {
    return manager.all().map((connection) => connection.status());
  }

  function status(): OpenClawAdapterStatus {
    return { provider: "openclaw", gateways: gatewayStatuses() };
  }

  const emitStatus = () => emit({ kind: "status", status: status(), capabilities: { ...capabilities } });

  function gatewaySetupDetails(): GatewaySetupEntry[] {
    return manager.all().map((connection) => connection.setupEntry());
  }

  function setupDetail(): OpenClawSetupDetail {
    const first = manager
      .all()
      .find((c) => c.config().enabled)
      ?.setupEntry();
    if (!first || first.gateway.state === "disabled") {
      return {
        provider: "openclaw",
        gateway: { state: "down", host: "", version: null, pairing: null },
        bridge: { state: "down", plugin: null },
      };
    }
    const { state, host, version, pairing } = first.gateway;
    return { provider: "openclaw", gateway: { state, host, version, pairing }, bridge: first.bridge };
  }

  /**
   * Gateway 별 상세가 바뀌었으면 setup 이벤트를 한 번 낸다. 한 동기 구간의 여러 변화(예: reconnecting + 페어링)는
   * 마이크로태스크로 모아 한 번만 비교한다.
   */
  function queueSetupCheck() {
    if (setupCheckQueued) return;
    setupCheckQueued = true;
    queueMicrotask(() => {
      setupCheckQueued = false;
      const key = JSON.stringify(gatewaySetupDetails());
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

  lastSetupKey = JSON.stringify(gatewaySetupDetails());

  const adapterClosed = () => new AdapterError("ADAPTER_UNAVAILABLE", "adapter closed");
  const live = (connectionId: string | null) => {
    if (closed) throw adapterClosed();
    return manager.require(connectionId);
  };

  return {
    provider: "openclaw",
    bridge,

    upsertGateway(config) {
      if (closed) return;
      manager.upsert(config);
    },

    removeGateway: (id) => manager.remove(id),

    gatewayStatuses,
    gatewaySetupDetails,

    async connect() {
      manager.start();
    },

    async close() {
      closed = true;
      // 스펙 2장 종료 순서 — 플러그인에 system.notice shutdown(대기 중인 waitForReady 도 끝낸다) → Gateway 연결 종료
      bridge.close();
      await manager.close();
    },

    status,
    capabilities: () => ({ ...capabilities }),
    setupDetail,

    revokeTokenSessions(tokenId) {
      const sessions = bridge.revokeSessions(tokenId);
      logger.info({ tokenId, sessions }, "bridge sessions revoked");
      return sessions;
    },

    listAgents: async (connectionId) => live(connectionId).listAgents(),

    sessionKeyFor,

    supports(_providerAgentId, connectionId, capability) {
      const connection = connectionOf(connectionId);
      return connection?.config().enabled === true && connection.supports(capability);
    },

    send: async (input, sendOpts) => live(sendOpts.connectionId).send(input),

    abort: async (runId, sessionKey, connectionId) => live(connectionId).abort(runId, sessionKey),

    resetSession: async (sessionKey, connectionId) => live(connectionId).resetSession(sessionKey),

    syncChannelConfig: async (
      channelId: string,
      config: ConfigSet["config"],
      connectionId: string,
    ): Promise<ConfigSetResult> => live(connectionId).syncChannelConfig(channelId, config),

    resolveApproval: async (providerApprovalId, kind, decision, connectionId) =>
      live(connectionId).resolveApproval(providerApprovalId, kind, decision),

    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    // 런 id 는 서버 uuid 라 연결 사이에 겹치지 않는다 — 모든 연결에서 잊는다
    forgetRun(runId) {
      for (const connection of manager.all()) connection.forgetRun(runId);
    },
  };
}
