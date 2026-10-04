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
  type ClaudeAdapterStatus,
  type ClaudeSetupDetail,
  type ConnectionId,
  type OpenClawAdapterStatus,
  type OpenClawSetupDetail,
  type ProviderApproval,
  type SendOptions,
} from "./adapter-types";
import type { GatewayConnectionConfig } from "./connection/gateway-connection";

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
 * 연결 하나짜리 어댑터의 기본 연결 id — OpenClaw 흉내는 서버의 OPENCLAW_ENV_CONNECTION_ID(서버 config.ts)와 같아야 gateway_id 가
 * 빈 에이전트 행과 짝이 맞는다
 */
const DEFAULT_CONNECTION: Record<AdapterProvider, ConnectionId> = { openclaw: "env", claude: "fake-runner" };

type StatusOf<P extends AdapterProvider> = P extends "claude" ? ClaudeAdapterStatus : OpenClawAdapterStatus;
type SetupDetailOf<P extends AdapterProvider> = P extends "claude" ? ClaudeSetupDetail : OpenClawSetupDetail;

/**
 * 테스트·wire-cli 용 메모리 어댑터. 호출을 기록하고, 이벤트는 emit 으로 밀어 넣는다.
 * 기본은 OpenClaw 흉내. `provider: "claude"` 는 레지스트리 테스트용 최소 러너 흉내 — 상태·상세가 claude 모양이고
 * capabilities 가 promptEveryRun·serverSessionIds, 스레드는 늘 안다
 */
export class FakeAdapter<P extends AdapterProvider = "openclaw"> implements AgentAdapter {
  readonly provider: P;

  readonly calls: {
    send: InboundDeliver[];
    /** send 의 providerSessionId(없으면 undefined) — calls.send 와 같은 순서. 연결 id 는 connections.send */
    sendOpts: Array<{ providerSessionId?: string } | undefined>;
    syncChannelConfig: Array<{ channelId: string; config: ConfigSet["config"] }>;
    reset: string[];
    abort: Array<{ runId: string; sessionKey: string }>;
    forget: string[];
    resolveApproval: Array<{ providerApprovalId: string; kind: ApprovalKind; decision: ApprovalDecision }>;
    revokeTokenSessions: string[];
    /** 실물 OpenClaw 어댑터의 Gateway 조작(멀티 Gateway 스펙 5.1) — 기록만 하고 상태는 바꾸지 않는다 */
    upsertGateway: GatewayConnectionConfig[];
    removeGateway: string[];
    /** 메서드마다 받은 연결 id — 같은 메서드의 기록과 같은 순서 */
    connections: {
      send: Array<ConnectionId | null>;
      abort: Array<ConnectionId | null>;
      reset: Array<ConnectionId | null>;
      syncChannelConfig: ConnectionId[];
      resolveApproval: ConnectionId[];
      listAgents: Array<ConnectionId | null>;
      supports: Array<ConnectionId | null>;
    };
  } = {
    send: [],
    sendOpts: [],
    syncChannelConfig: [],
    reset: [],
    abort: [],
    forget: [],
    resolveApproval: [],
    revokeTokenSessions: [],
    upsertGateway: [],
    removeGateway: [],
    connections: {
      send: [],
      abort: [],
      reset: [],
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
  private currentStatus: StatusOf<P>;
  private currentCapabilities: AdapterCapabilities;
  // setStatus 와 따로 둔다 — 설정 상세가 필요한 테스트가 setSetupDetail 로 넣는다
  private currentSetupDetail: SetupDetailOf<P>;

  // 붙은 플러그인의 hello capabilities. 기본은 스레드를 아는 플러그인 — 옛 플러그인은 setPluginCapabilities([])
  private pluginCapabilities = new Set<BridgeCapability>(["run_id_in_outbound", "config.set", "threads"]);

  /** 연결 id 없이 emit 한 이벤트·send 결과에 싣는 연결 */
  private eventConnection: ConnectionId;

  constructor(opts: { provider?: P; connectionId?: ConnectionId } = {}) {
    const provider = opts.provider ?? "openclaw";
    this.provider = provider as P;
    this.eventConnection = opts.connectionId ?? DEFAULT_CONNECTION[provider];
    const claude = provider === "claude";
    this.currentStatus = (
      claude
        ? { provider: "claude", runners: { connected: 1, tokens: 1 } }
        : { provider: "openclaw", gateway: "connected", bridge: "connected" }
    ) as StatusOf<P>;
    this.currentCapabilities = {
      sessionReset: true,
      agentsList: true,
      configSet: true,
      promptEveryRun: claude,
      serverSessionIds: claude,
    };
    this.currentSetupDetail = (
      claude
        ? { provider: "claude", runners: [] }
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

  setStatus(status: StatusOf<P>): void {
    this.currentStatus = status;
  }

  setCapabilities(capabilities: AdapterCapabilities): void {
    this.currentCapabilities = capabilities;
  }

  setPluginCapabilities(capabilities: BridgeCapability[]): void {
    this.pluginCapabilities = new Set(capabilities);
  }

  /** setup 이벤트는 내지 않는다 — 알려야 하면 emit({ kind: "setup" }) */
  setSetupDetail(detail: SetupDetailOf<P>): void {
    this.currentSetupDetail = detail;
  }

  upsertGateway(config: GatewayConnectionConfig): void {
    this.calls.upsertGateway.push({ ...config });
  }

  async removeGateway(id: string): Promise<void> {
    this.calls.removeGateway.push(id);
  }

  async connect(): Promise<void> {}

  async close(): Promise<void> {}

  status(): StatusOf<P> {
    return this.currentStatus;
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
    return [{ providerAgentId: "dev", name: "dev" }, { providerAgentId: "fin" }];
  }

  sessionKeyFor(providerAgentId: string, channelId: string, threadRootId?: string): string {
    return dodokSessionKey(providerAgentId, channelId, threadRootId);
  }

  /** 실물과 같이 에이전트를 가리지 않고, 붙은 플러그인(setupDetail 의 bridge.plugin)이 없으면 false. claude 흉내는 늘 안다 */
  supports(_providerAgentId: string, connectionId: ConnectionId | null, capability: "threads"): boolean {
    this.calls.connections.supports.push(connectionId);
    const detail: AdapterSetupDetail = this.currentSetupDetail;
    if (detail.provider !== "openclaw") return true;
    return detail.bridge.plugin !== null && this.pluginCapabilities.has(capability);
  }

  /** 대본이 연결을 정하지 않으면 받은 연결(null 이면 지금 고른 연결)을 결과에 싣는다 */
  async send(input: InboundDeliver, opts: SendOptions): Promise<AdapterSendResult> {
    this.calls.send.push(input);
    this.calls.sendOpts.push(
      opts.providerSessionId === undefined ? undefined : { providerSessionId: opts.providerSessionId },
    );
    this.calls.connections.send.push(opts.connectionId);
    const result = await this.sendScript(input, opts);
    return { connectionId: opts.connectionId ?? this.eventConnection, ...result };
  }

  async abort(runId: string, sessionKey: string, connectionId: ConnectionId | null): Promise<void> {
    this.calls.abort.push({ runId, sessionKey });
    this.calls.connections.abort.push(connectionId);
  }

  async resetSession(
    sessionKey: string,
    connectionId: ConnectionId | null,
  ): Promise<{ sessionStartedAt?: string; lifecycleRevision?: string }> {
    this.calls.reset.push(sessionKey);
    this.calls.connections.reset.push(connectionId);
    return { sessionStartedAt: new Date().toISOString(), lifecycleRevision: "fake-1" };
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
    const status: AdapterStatus = this.currentStatus;
    if (status.provider === "openclaw" && status.gateway !== "connected") {
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
