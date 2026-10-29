import {
  dodokSessionKey,
  type ApprovalDecision,
  type ApprovalKind,
  type BridgeCapability,
  type ConfigSet,
  type ConfigSetResult,
  type InboundDeliver,
} from "@dodok/shared";
import {
  AdapterError,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterProvider,
  type AdapterSendResult,
  type AdapterSetupDetail,
  type AdapterStatus,
  type AgentAdapter,
  type RunnerAdapterStatus,
  type RunnerSetupDetail,
  type ConnectionId,
  type OpenClawAdapterStatus,
  type OpenClawSetupDetail,
  type ProviderApproval,
  type SendOptions,
} from "./adapter-types";
import type {
  GatewayConnectionConfig,
  GatewaySetupEntry,
  GatewayStatusEntry,
} from "./connection/gateway-connection";

type SendScript = (
  input: InboundDeliver,
  opts: SendOptions,
) => AdapterSendResult | Promise<AdapterSendResult>;
type ResolveApprovalScript = (
  providerApprovalId: string,
  kind: ApprovalKind,
  decision: ApprovalDecision,
) => ProviderApproval | Promise<ProviderApproval>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** emit 에 넘기는 이벤트 — 연결 id 를 빼면 지금 고른 연결(useConnection)이 실린다 */
export type FakeAdapterEvent =
  | AdapterEvent
  | (DistributiveOmit<Extract<AdapterEvent, { connectionId: ConnectionId }>, "connectionId"> & {
      connectionId?: undefined;
    });

/**
 * OpenClaw 흉내의 기본 연결 id — 서버 테스트가 이 id 의 Gateway 행을 넣고 에이전트를 묶는다(gateways.id 는 uuid 라 uuid 꼴)
 */
export const FAKE_GATEWAY_ID = "00000000-0000-4000-8000-0000000000f1";

/** 연결 하나짜리 어댑터의 기본 연결 id */
const DEFAULT_CONNECTION: Record<AdapterProvider, ConnectionId> = {
  openclaw: FAKE_GATEWAY_ID,
  runner: "fake-runner",
};

type StatusOf<P extends AdapterProvider> = P extends "runner" ? RunnerAdapterStatus : OpenClawAdapterStatus;

/** 켜진 Gateway 하나가 보이는 상태 — 꺼진 Gateway 는 늘 disabled/down 이다 */
export type FakeGatewayState = {
  gateway: Exclude<GatewayStatusEntry["gateway"], "disabled">;
  bridge: GatewayStatusEntry["bridge"];
};
type SetupDetailOf<P extends AdapterProvider> = P extends "runner" ? RunnerSetupDetail : OpenClawSetupDetail;

/**
 * 테스트·wire-cli 용 메모리 어댑터. 호출을 기록하고, 이벤트는 emit 으로 밀어 넣는다.
 * 기본은 OpenClaw 흉내 — 실물처럼 연결이 null(Gateway 가 빈 에이전트)이면 send·abort·listAgents 가
 * ADAPTER_UNAVAILABLE 을 던지고 supports 는 false 다. 모르는 연결 id 는 막지 않는다(연결 목록 없이도 쓰게).
 * `provider: "runner"` 는 레지스트리 테스트용 최소 러너 흉내 — 상태·상세가 러너 모양이고 capabilities 가
 * promptEveryRun·serverSessionIds, 스레드는 늘 안다. null 연결은 받는다(묶임 없는 러너 에이전트)
 */
export class FakeAdapter<P extends AdapterProvider = "openclaw"> implements AgentAdapter {
  readonly provider: P;

  readonly calls: {
    send: InboundDeliver[];
    /** send 의 providerSessionId(없으면 undefined) — calls.send 와 같은 순서. 연결 id 는 connections.send */
    sendOpts: Array<{ providerSessionId?: string } | undefined>;
    syncChannelConfig: Array<{ channelId: string; config: ConfigSet["config"] }>;
    abort: Array<{ runId: string; sessionKey: string }>;
    forget: string[];
    resolveApproval: Array<{ providerApprovalId: string; kind: ApprovalKind; decision: ApprovalDecision }>;
    revokeTokenSessions: string[];
    /**
     * 실물 OpenClaw 어댑터의 Gateway 조작(멀티 Gateway 스펙 「연결 관리자」 절) — 기록하고 Gateway 목록(gatewaySetupDetails·gatewayStatuses)만
     * 바꾼 뒤 status 이벤트를 낸다. 연결·런은 건드리지 않는다
     */
    upsertGateway: GatewayConnectionConfig[];
    removeGateway: string[];
    /** 메서드마다 받은 연결 id — 같은 메서드의 기록과 같은 순서 */
    connections: {
      send: Array<ConnectionId | null>;
      abort: Array<ConnectionId | null>;
      syncChannelConfig: ConnectionId[];
      resolveApproval: ConnectionId[];
      listAgents: Array<ConnectionId | null>;
      supports: Array<ConnectionId | null>;
    };
  } = {
    send: [],
    sendOpts: [],
    syncChannelConfig: [],
    abort: [],
    forget: [],
    resolveApproval: [],
    revokeTokenSessions: [],
    upsertGateway: [],
    removeGateway: [],
    connections: {
      send: [],
      abort: [],
      syncChannelConfig: [],
      resolveApproval: [],
      listAgents: [],
      supports: [],
    },
  };

  private sendScript: SendScript = (input) => ({ admission: "dispatch", providerRunId: input.runId });
  private resolveApprovalScript: ResolveApprovalScript | undefined;
  /** emitApproval 로 흘린 승인 — 기본 resolveApproval 이 이것의 terminal 스냅샷을 돌려준다. */
  private approvals = new Map<string, ProviderApproval>();
  private handlers = new Set<(e: AdapterEvent) => void>();
  /** 러너 흉내의 상태 — OpenClaw 흉내는 Gateway 목록(gateways)과 Gateway 상태(gatewayState·gatewayStates)에서 만든다 */
  private currentStatus: RunnerAdapterStatus;
  /** 켜진 Gateway 의 기본 상태와 Gateway 별 덮어쓰기(setGatewayState) */
  private gatewayState: FakeGatewayState = { gateway: "connected", bridge: "connected" };
  private gatewayStates = new Map<string, FakeGatewayState>();
  private currentCapabilities: AdapterCapabilities;
  // setStatus 와 따로 둔다 — 설정 상세가 필요한 테스트가 setSetupDetail 로 넣는다
  private currentSetupDetail: SetupDetailOf<P>;
  /** Gateway 별 설정 상세 덮어쓰기(setSetupDetail 에 Gateway id) */
  private gatewaySetupDetail = new Map<string, AdapterSetupDetail>();

  // 붙은 플러그인의 hello capabilities. 기본은 스레드를 아는 플러그인 — 옛 플러그인은 setPluginCapabilities([])
  private pluginCapabilities = new Set<BridgeCapability>(["run_id_in_outbound", "config.set", "threads"]);

  /** 연결 id 없이 emit 한 이벤트·send 결과에 싣는 연결 */
  private eventConnection: ConnectionId;

  /**
   * upsertGateway 로 넣은 Gateway(더한 차례) — 상태는 setGatewayState, 상세는 setSetupDetail 의 값을 켜진 Gateway 마다 비춘다
   * (Gateway id 를 주면 그 Gateway 만)
   */
  private gateways = new Map<string, GatewayConnectionConfig>();

  constructor(opts: { provider?: P; connectionId?: ConnectionId } = {}) {
    const provider = opts.provider ?? "openclaw";
    this.provider = provider as P;
    this.eventConnection = opts.connectionId ?? DEFAULT_CONNECTION[provider];
    const runner = provider === "runner";
    this.currentStatus = { provider: "runner", runners: { connected: 1, tokens: 1 } };
    this.currentCapabilities = {
      agentsList: true,
      configSet: true,
      promptEveryRun: runner,
      serverSessionIds: runner,
    };
    this.currentSetupDetail = (
      runner
        ? { provider: "runner", runners: [] }
        : {
            provider: "openclaw",
            gateway: { state: "connected", host: "fake-gateway:443", version: null, pairing: null },
            bridge: {
              state: "connected",
              plugin: {
                version: "0.0.0",
                sdkVersion: "0.0.0",
                gatewayVersion: null,
                bundleSha256: null,
                tokenId: null,
                connectedAt: "1970-01-01T00:00:00.000Z",
              },
            },
          }
    ) as SetupDetailOf<P>;
  }

  script(fn: SendScript): void {
    this.sendScript = fn;
  }

  scriptResolveApproval(fn: ResolveApprovalScript): void {
    this.resolveApprovalScript = fn;
  }

  /** 지금 고른 연결 — 연결 id 없이 emit 한 이벤트와 연결 id 없이 받은 send 의 결과에 실린다 */
  get connectionId(): ConnectionId {
    return this.eventConnection;
  }

  /** 이 뒤로 연결 id 없이 emit 하는 이벤트를 그 연결에서 온 것으로 낸다(한 어댑터가 연결 여럿을 흉내 낼 때) */
  useConnection(connectionId: ConnectionId): void {
    this.eventConnection = connectionId;
  }

  emit(e: FakeAdapterEvent): void {
    const event = (
      e.kind === "status" || e.kind === "setup" || e.connectionId !== undefined
        ? e
        : { ...e, connectionId: this.eventConnection }
    ) as AdapterEvent;
    for (const handler of this.handlers) handler(event);
  }

  /** 승인 이벤트 하나를 흘린다(서버 승인 대본). 같은 승인을 두 번 부르면 두 번 간다 — 중복 제거는 서버가 잰다. */
  emitApproval(approval: ProviderApproval, connectionId?: ConnectionId): void {
    this.approvals.set(approval.providerApprovalId, approval);
    this.emit({ kind: "approval", approval, ...(connectionId === undefined ? {} : { connectionId }) });
  }

  /** 러너 흉내의 상태. OpenClaw 흉내는 setGatewayState 로 */
  setStatus(status: RunnerAdapterStatus): void {
    this.currentStatus = status;
  }

  /**
   * 켜진 Gateway 의 상태를 바꾼다 — gatewayId 를 주면 그 Gateway 만, 아니면 기본값을 바꾸고 Gateway 별 덮어쓰기를 지운다.
   * status 이벤트는 내지 않는다 — 알려야 하면 emitStatus()
   */
  setGatewayState(state: Partial<FakeGatewayState>, gatewayId?: string): void {
    if (gatewayId === undefined) {
      this.gatewayState = { ...this.gatewayState, ...state };
      this.gatewayStates.clear();
      return;
    }
    // 꺼져 있는 동안 바꿔도 켰을 때 보일 상태를 바꾼다
    this.gatewayStates.set(gatewayId, {
      ...(this.gatewayStates.get(gatewayId) ?? this.gatewayState),
      ...state,
    });
  }

  /** 지금 상태로 status 이벤트를 하나 낸다 */
  emitStatus(): void {
    this.emit({ kind: "status", status: this.status(), capabilities: this.capabilities() });
  }

  /** 그 연결의 상태 — Gateway 목록에 없는 연결도 기본값으로 본다(목록 없이도 쓰게). 꺼진 Gateway 는 down */
  private stateOf(connectionId: ConnectionId): FakeGatewayState {
    if (this.gateways.get(connectionId)?.enabled === false) return { gateway: "down", bridge: "down" };
    return this.gatewayStates.get(connectionId) ?? this.gatewayState;
  }

  setCapabilities(capabilities: AdapterCapabilities): void {
    this.currentCapabilities = capabilities;
  }

  setPluginCapabilities(capabilities: BridgeCapability[]): void {
    this.pluginCapabilities = new Set(capabilities);
  }

  /** setup 이벤트는 내지 않는다 — 알려야 하면 emit({ kind: "setup" }). gatewayId 를 주면 gatewaySetupDetails 의 그 Gateway 만 */
  setSetupDetail(detail: SetupDetailOf<P>, gatewayId?: string): void {
    if (gatewayId === undefined) this.currentSetupDetail = detail;
    else this.gatewaySetupDetail.set(gatewayId, detail);
  }

  /** 실물처럼 Gateway 목록이 바뀌면 status 이벤트를 낸다(setup 이벤트는 내지 않는다) */
  upsertGateway(config: GatewayConnectionConfig): void {
    this.calls.upsertGateway.push({ ...config });
    this.gateways.set(config.id, { ...config });
    this.emitStatus();
  }

  async removeGateway(id: string): Promise<void> {
    this.calls.removeGateway.push(id);
    this.gateways.delete(id);
    this.gatewayStates.delete(id);
    this.gatewaySetupDetail.delete(id);
    this.emitStatus();
  }

  gatewaySetupDetails(): GatewaySetupEntry[] {
    if (this.provider !== "openclaw") return [];
    return [...this.gateways.values()].flatMap(({ id, name, url, enabled }) => {
      const detail: AdapterSetupDetail = this.gatewaySetupDetail.get(id) ?? this.currentSetupDetail;
      if (detail.provider !== "openclaw") return [];
      return [
        {
          id,
          name,
          url,
          enabled,
          gateway: enabled
            ? { ...detail.gateway }
            : { state: "disabled", host: detail.gateway.host, version: null, pairing: null },
          bridge: enabled ? { ...detail.bridge } : { state: "down", plugin: null },
        },
      ];
    });
  }

  gatewayStatuses(): GatewayStatusEntry[] {
    if (this.provider !== "openclaw") return [];
    return [...this.gateways.values()].map(({ id, name, enabled }) => ({
      id,
      name,
      enabled,
      ...(enabled ? this.stateOf(id) : { gateway: "disabled", bridge: "down" }),
    }));
  }

  /** OpenClaw 흉내는 실물처럼 연결이 없으면(Gateway 가 빈 에이전트) 보내지 않는다 */
  private requireConnection(connectionId: ConnectionId | null): void {
    if (connectionId === null && this.provider === "openclaw") {
      throw new AdapterError("ADAPTER_UNAVAILABLE", "agent has no gateway");
    }
  }

  async connect(): Promise<void> {}

  async close(): Promise<void> {}

  status(): StatusOf<P> {
    const status: AdapterStatus =
      this.provider === "openclaw"
        ? { provider: "openclaw", gateways: this.gatewayStatuses() }
        : this.currentStatus;
    return status as StatusOf<P>;
  }

  capabilities(): AdapterCapabilities {
    return this.currentCapabilities;
  }

  setupDetail(): SetupDetailOf<P> {
    return this.currentSetupDetail;
  }

  /** 붙은 플러그인이 그 토큰이면 끊은 것으로 두고(bridge down) setup 을 한 번 낸다 */
  revokeTokenSessions(tokenId: string): number {
    this.calls.revokeTokenSessions.push(tokenId);
    const detail: AdapterSetupDetail = this.currentSetupDetail;
    if (detail.provider !== "openclaw") return 0;
    if (!detail.bridge.plugin || detail.bridge.plugin.tokenId !== tokenId) return 0;
    this.currentSetupDetail = { ...detail, bridge: { state: "down", plugin: null } } as SetupDetailOf<P>;
    this.emit({ kind: "setup" });
    return 1;
  }

  async listAgents(
    connectionId: ConnectionId | null,
  ): Promise<Array<{ providerAgentId: string; name?: string }>> {
    this.calls.connections.listAgents.push(connectionId);
    this.requireConnection(connectionId);
    return [{ providerAgentId: "dev", name: "dev" }, { providerAgentId: "fin" }];
  }

  sessionKeyFor(providerAgentId: string, conversationId: string, threadRootId?: string): string {
    return dodokSessionKey(providerAgentId, conversationId, threadRootId);
  }

  /** 실물과 같이 에이전트를 가리지 않고, 붙은 플러그인(setupDetail 의 bridge.plugin)이 없으면 false. 러너 흉내는 늘 안다 */
  supports(_providerAgentId: string, connectionId: ConnectionId | null, capability: "threads"): boolean {
    this.calls.connections.supports.push(connectionId);
    const detail: AdapterSetupDetail = this.currentSetupDetail;
    if (detail.provider !== "openclaw") return true;
    if (connectionId === null) return false;
    return detail.bridge.plugin !== null && this.pluginCapabilities.has(capability);
  }

  /** 대본이 연결을 정하지 않으면 받은 연결(null 이면 — 러너 흉내만 — 지금 고른 연결)을 결과에 싣는다 */
  async send(input: InboundDeliver, opts: SendOptions): Promise<AdapterSendResult> {
    this.calls.send.push(input);
    this.calls.sendOpts.push(
      opts.providerSessionId === undefined ? undefined : { providerSessionId: opts.providerSessionId },
    );
    this.calls.connections.send.push(opts.connectionId);
    this.requireConnection(opts.connectionId);
    const result = await this.sendScript(input, opts);
    return { connectionId: opts.connectionId ?? this.eventConnection, ...result };
  }

  async abort(runId: string, sessionKey: string, connectionId: ConnectionId | null): Promise<void> {
    this.calls.abort.push({ runId, sessionKey });
    this.calls.connections.abort.push(connectionId);
    this.requireConnection(connectionId);
  }

  async syncChannelConfig(
    channelId: string,
    config: ConfigSet["config"],
    connectionId: ConnectionId,
  ): Promise<ConfigSetResult> {
    this.calls.syncChannelConfig.push({ channelId, config });
    this.calls.connections.syncChannelConfig.push(connectionId);
    return { applied: "live" };
  }

  async resolveApproval(
    providerApprovalId: string,
    kind: ApprovalKind,
    decision: ApprovalDecision,
    connectionId: ConnectionId,
  ): Promise<ProviderApproval> {
    // 실물과 같이 Gateway 가 붙어 있지 않으면 보내지 않는다 — 호출 기록에도 남기지 않는다(판정 P6)
    if (this.provider === "openclaw" && this.stateOf(connectionId).gateway !== "connected") {
      throw new AdapterError("ADAPTER_UNAVAILABLE", "gateway is not connected");
    }
    this.calls.resolveApproval.push({ providerApprovalId, kind, decision });
    this.calls.connections.resolveApproval.push(connectionId);
    if (this.resolveApprovalScript) return this.resolveApprovalScript(providerApprovalId, kind, decision);
    const known = this.approvals.get(providerApprovalId);
    // 실물 Gateway 는 없는 id 에 INVALID_REQUEST(APPROVAL_NOT_FOUND) 를 준다(스파이크 4.4)
    if (!known) throw new AdapterError("NOT_FOUND", `approval not found: ${providerApprovalId}`);
    const resolved: ProviderApproval = {
      ...known,
      kind,
      status: decision === "deny" ? "denied" : "allowed",
      decision,
      reason: "user",
      resolvedAt: new Date().toISOString(),
    };
    this.approvals.set(providerApprovalId, resolved);
    return resolved;
  }

  onEvent(handler: (e: AdapterEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  forgetRun(runId: string): void {
    this.calls.forget.push(runId);
  }
}
