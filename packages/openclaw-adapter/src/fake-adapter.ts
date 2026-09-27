import {
  dodokSessionKey,
  type ApprovalDecision,
  type ApprovalKind,
  type BridgeCapability,
  type ConfigSet,
  type ConfigSetResult,
  type InboundDeliver,
  type InboundDeliverResult,
} from "@dodok/shared";
import {
  AdapterError,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterProvider,
  type AdapterSetupDetail,
  type AdapterStatus,
  type AgentAdapter,
  type ClaudeAdapterStatus,
  type ClaudeSetupDetail,
  type OpenClawAdapterStatus,
  type OpenClawSetupDetail,
  type ProviderApproval,
} from "./adapter-types";

type SendScript = (input: InboundDeliver) => InboundDeliverResult | Promise<InboundDeliverResult>;
type ResolveApprovalScript = (
  providerApprovalId: string,
  kind: ApprovalKind,
  decision: ApprovalDecision,
) => ProviderApproval | Promise<ProviderApproval>;

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
    /** send 의 두 번째 인자 — calls.send 와 같은 순서 */
    sendOpts: Array<{ providerSessionId?: string } | undefined>;
    syncChannelConfig: Array<{ channelId: string; config: ConfigSet["config"] }>;
    reset: string[];
    abort: Array<{ runId: string; sessionKey: string }>;
    forget: string[];
    resolveApproval: Array<{ providerApprovalId: string; kind: ApprovalKind; decision: ApprovalDecision }>;
    revokeTokenSessions: string[];
  } = {
    send: [],
    sendOpts: [],
    syncChannelConfig: [],
    reset: [],
    abort: [],
    forget: [],
    resolveApproval: [],
    revokeTokenSessions: [],
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

  constructor(opts: { provider?: P } = {}) {
    const provider = opts.provider ?? "openclaw";
    this.provider = provider as P;
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

  emit(e: AdapterEvent): void {
    for (const handler of this.handlers) handler(e);
  }

  /** 승인 이벤트 하나를 흘린다(서버 승인 대본). 같은 승인을 두 번 부르면 두 번 간다 — 중복 제거는 서버가 잰다. */
  emitApproval(approval: ProviderApproval): void {
    this.approvals.set(approval.providerApprovalId, approval);
    this.emit({ kind: "approval", approval });
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

  async listAgents(): Promise<Array<{ providerAgentId: string; name?: string }>> {
    return [{ providerAgentId: "dev", name: "dev" }, { providerAgentId: "fin" }];
  }

  sessionKeyFor(providerAgentId: string, channelId: string, threadRootId?: string): string {
    return dodokSessionKey(providerAgentId, channelId, threadRootId);
  }

  /** 실물과 같이 에이전트를 가리지 않고, 붙은 플러그인(setupDetail 의 bridge.plugin)이 없으면 false. claude 흉내는 늘 안다 */
  supports(_providerAgentId: string, capability: "threads"): boolean {
    const detail: AdapterSetupDetail = this.currentSetupDetail;
    if (detail.provider !== "openclaw") return true;
    return detail.bridge.plugin !== null && this.pluginCapabilities.has(capability);
  }

  async send(input: InboundDeliver, opts?: { providerSessionId?: string }): Promise<InboundDeliverResult> {
    this.calls.send.push(input);
    this.calls.sendOpts.push(opts);
    return this.sendScript(input);
  }

  async abort(runId: string, sessionKey: string): Promise<void> {
    this.calls.abort.push({ runId, sessionKey });
  }

  async resetSession(sessionKey: string): Promise<{ sessionStartedAt?: string; lifecycleRevision?: string }> {
    this.calls.reset.push(sessionKey);
    return { sessionStartedAt: new Date().toISOString(), lifecycleRevision: "fake-1" };
  }

  async syncChannelConfig(channelId: string, config: ConfigSet["config"]): Promise<ConfigSetResult> {
    this.calls.syncChannelConfig.push({ channelId, config });
    return { applied: "live" };
  }

  async resolveApproval(
    providerApprovalId: string,
    kind: ApprovalKind,
    decision: ApprovalDecision,
  ): Promise<ProviderApproval> {
    // 실물과 같이 Gateway 가 붙어 있지 않으면 보내지 않는다 — 호출 기록에도 남기지 않는다(판정 P6)
    const status: AdapterStatus = this.currentStatus;
    if (status.provider === "openclaw" && status.gateway !== "connected") {
      throw new AdapterError("ADAPTER_UNAVAILABLE", "gateway is not connected");
    }
    this.calls.resolveApproval.push({ providerApprovalId, kind, decision });
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
