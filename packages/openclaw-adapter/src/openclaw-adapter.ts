/**
 * `AgentAdapter` 의 OpenClaw 구현 — 서버 코어 스펙 6장·8장.
 *
 * Gateway WS(`connection-manager`)는 델타·툴 이벤트·세션 요청, 브리지(`attachBridge`)는 인바운드 전송·정본·채널 설정.
 * 응답 정본은 브리지 `outbound.message` 이고, 서버가 저장한 id 를 `onCanonical` 훅으로 받아 플러그인에 ack 한다.
 */
import type {
  AdapterStatus,
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
} from "./adapter-types";
import { attachBridge, type BridgeHandle } from "./bridge/server";
import { syncChannelConfig } from "./config-sync";
import { connectGateway } from "./gateway/client";
import {
  createConnectionManager,
  type GatewayConnector,
  type GatewayState,
  type RecoverTarget,
} from "./gateway/connection-manager";
import { createGatewayEventMapper } from "./gateway/events";
import { parseSessionsReset, sessionKeyFor } from "./gateway/sessions";

export type OpenClawAdapterOptions = {
  gateway: { url: string; token: string; deviceIdentityPath: string; deviceTokenStorePath?: string };
  bridge: { io: Server; token: string; serverVersion: string; ackTimeoutMs?: number };
  logger: AdapterLogger;
  /** 서버가 정본을 저장하고 id 를 돌려준다. 그 id 가 플러그인 ack 의 messageId 가 된다. */
  onCanonical: (message: OutboundMessage) => Promise<{ messageId?: string }>;
  /** 재접속 복구 대상(서버 agent_sessions). */
  sessionKeysToRecover?: () => RecoverTarget[];
  /** 기본 `connectGateway` (테스트 주입) */
  connector?: GatewayConnector;
  backoff?: { initialMs?: number; maxMs?: number; pairingRetryMs?: number };
};

export type OpenClawAdapter = AgentAdapter & {
  readonly bridge: BridgeHandle;
  /** 세션 키 → `chat.history` deltaCursor. 서버가 저장했다가 `sessionKeysToRecover` 의 cursor 로 돌려줄 수 있다. */
  readonly historyCursors: Map<string, string>;
};

// 계약 스펙 8.3 — ack 타임아웃 10s, 없으면 1·4·16s 뒤 재전송(3회). 플러그인 미접속은 120s 기다린다(queued 상한).
const DELIVER_ACK_TIMEOUT_MS = 10_000;
const DELIVER_RETRY_DELAYS_MS = [1_000, 4_000, 16_000];
const PLUGIN_READY_WAIT_MS = 120_000;
// final 뒤에도 같은 런의 늦은 프레임(usage 등)이 온다 — 그동안은 우리 런으로 본다.
const FORGET_AFTER_FINAL_MS = 60_000;

const AgentsListResult = z.looseObject({
  agents: z.array(z.looseObject({ id: z.string().min(1), name: z.string().optional().catch(undefined) })),
});

export function createOpenClawAdapter(opts: OpenClawAdapterOptions): OpenClawAdapter {
  const { logger } = opts;
  const handlers = new Set<(e: AdapterEvent) => void>();
  const knownRunIds = new Set<string>();
  const forgetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // send 재시도 대기 — close() 가 타이머를 지우고 기다리는 send 를 끝낸다
  const retryWaits = new Map<ReturnType<typeof setTimeout>, (error: AdapterError) => void>();
  let closed = false;
  const capabilities: AdapterCapabilities = { sessionReset: true, agentsList: true, configSet: true };
  let gatewayState: GatewayState = "down";
  let bridgeState: AdapterStatus["bridge"] = "down";

  function emit(event: AdapterEvent) {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error({ err: error, kind: event.kind }, "adapter event handler threw");
      }
    }
  }

  const status = (): AdapterStatus => ({ provider: "openclaw", gateway: gatewayState, bridge: bridgeState });
  const emitStatus = () => emit({ kind: "status", status: status(), capabilities: { ...capabilities } });

  function setBridgeState(next: AdapterStatus["bridge"]) {
    if (bridgeState === next) return;
    bridgeState = next;
    logger.info({ bridge: next }, "bridge status changed");
    emitStatus();
  }

  function disableCapability(name: keyof AdapterCapabilities) {
    if (!capabilities[name]) return;
    capabilities[name] = false;
    logger.warn({ capability: name }, "gateway capability disabled (FORBIDDEN)");
    emitStatus();
  }

  const mapper = createGatewayEventMapper({ isOurRun: (runId) => knownRunIds.has(runId) });

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

  function onGatewayEvent(frame: EventFrame) {
    for (const item of mapper.map(frame)) {
      if (item.event) emit({ kind: "run_event", runId: item.runId, event: item.event });
      if (!item.signal) continue;
      emit({
        kind: "run_signal",
        runId: item.runId,
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
    },
    ...(opts.sessionKeysToRecover ? { sessionKeysToRecover: opts.sessionKeysToRecover } : {}),
    ...(opts.backoff ? { backoff: opts.backoff } : {}),
  });

  const bridge = attachBridge(opts.bridge.io, {
    token: opts.bridge.token,
    serverVersion: opts.bridge.serverVersion,
    ...(opts.bridge.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: opts.bridge.ackTimeoutMs }),
    onHello: (_session, hello) => {
      logger.info({ pluginVersion: hello.version, sdkVersion: hello.sdkVersion }, "bridge plugin hello");
      setBridgeState("connected");
    },
    onClose: (session) => {
      // 새 연결이 이전 연결을 교체할 때는 down 을 거치지 않는다
      if (session.closeReason === "replaced") return;
      if (!bridge.current()) setBridgeState("down");
    },
    onOutboundMessage: async (_session, message) => {
      const stored = await opts.onCanonical(message);
      emit({ kind: "canonical", message });
      return { messageId: stored.messageId ?? message.outboundId };
    },
    onTyping: () => undefined, // Phase 2
    onStatus: (_session, pluginStatus) => logger.debug({ pluginStatus }, "bridge plugin status"),
    onRejected: (reason) => logger.warn({ reason }, "bridge connection rejected"),
  });

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
    let timeoutRetries = 0;
    let waitedForPlugin = false;
    for (;;) {
      if (closed) throw adapterClosed();
      const res = await bridge.deliverInbound(input, DELIVER_ACK_TIMEOUT_MS);
      if (res.ok) return res.data;
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
    },

    status,
    capabilities: () => ({ ...capabilities }),

    async listAgents() {
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

    async send(input) {
      // 플러그인은 런이 시작될 때(onAgentRunStart) ack 하므로 Gateway 이벤트가 ack 보다 먼저 올 수 있다 — 전송 전에 등록한다
      knownRunIds.add(input.runId);
      try {
        const result = await deliver(input);
        if (result.admission === "drop") forgetRun(input.runId);
        return result;
      } catch (error) {
        forgetRun(input.runId);
        throw error;
      }
    },

    async abort(runId, sessionKey) {
      await manager.request("chat.abort", { sessionKey, runId });
    },

    async resetSession(sessionKey) {
      try {
        return parseSessionsReset(await manager.request("sessions.reset", { key: sessionKey }));
      } catch (error) {
        if (error instanceof AdapterError && error.code === "FORBIDDEN") disableCapability("sessionReset");
        throw error;
      }
    },

    syncChannelConfig: (channelId: string, config: ConfigSet["config"]): Promise<ConfigSetResult> =>
      syncChannelConfig(bridge, logger, channelId, config),

    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    forgetRun,
  };
}
