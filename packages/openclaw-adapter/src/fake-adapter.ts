import type {
  AdapterStatus,
  ConfigSet,
  ConfigSetResult,
  InboundDeliver,
  InboundDeliverResult,
} from "@dodok/shared";
import type { AdapterCapabilities, AdapterEvent, AgentAdapter } from "./adapter-types";

type SendScript = (input: InboundDeliver) => InboundDeliverResult | Promise<InboundDeliverResult>;

/** 테스트·wire-cli 용 메모리 어댑터. 호출을 기록하고, 이벤트는 emit 으로 밀어 넣는다. */
export class FakeAdapter implements AgentAdapter {
  readonly provider = "openclaw";

  readonly calls: {
    send: InboundDeliver[];
    syncChannelConfig: Array<{ channelId: string; config: ConfigSet["config"] }>;
    reset: string[];
    abort: Array<{ runId: string; sessionKey: string }>;
    forget: string[];
  } = { send: [], syncChannelConfig: [], reset: [], abort: [], forget: [] };

  private sendScript: SendScript = (input) => ({ admission: "dispatch", providerRunId: input.runId });
  private handlers = new Set<(e: AdapterEvent) => void>();
  private currentStatus: AdapterStatus = { provider: "openclaw", gateway: "connected", bridge: "connected" };
  private currentCapabilities: AdapterCapabilities = {
    sessionReset: true,
    agentsList: true,
    configSet: true,
  };

  script(fn: SendScript): void {
    this.sendScript = fn;
  }

  emit(e: AdapterEvent): void {
    for (const handler of this.handlers) handler(e);
  }

  setStatus(status: AdapterStatus): void {
    this.currentStatus = status;
  }

  setCapabilities(capabilities: AdapterCapabilities): void {
    this.currentCapabilities = capabilities;
  }

  async connect(): Promise<void> {}

  async close(): Promise<void> {}

  status(): AdapterStatus {
    return this.currentStatus;
  }

  capabilities(): AdapterCapabilities {
    return this.currentCapabilities;
  }

  async listAgents(): Promise<Array<{ providerAgentId: string; name?: string }>> {
    return [{ providerAgentId: "dev", name: "dev" }, { providerAgentId: "fin" }];
  }

  sessionKeyFor(providerAgentId: string, channelId: string): string {
    return `agent:${providerAgentId}:dodok:channel:${channelId}`;
  }

  async send(input: InboundDeliver): Promise<InboundDeliverResult> {
    this.calls.send.push(input);
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
