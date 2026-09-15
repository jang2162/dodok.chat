import type {
  AdapterStatus,
  ConfigSet,
  ConfigSetResult,
  ErrorCode,
  InboundDeliver,
  InboundDeliverResult,
  OutboundMessage,
  RunEvent,
  RunSignal,
} from "@dodok/shared";

// 서버 코어 스펙 6.1. 서버(apps/server/src/adapters)는 이 파일을 re-export 한다.

export type AdapterCapabilities = { sessionReset: boolean; agentsList: boolean; configSet: boolean };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** seq·ts 는 오케스트레이터가 부여한다. 판별 유니온이라 Omit 을 변형마다 분배한다. */
export type RunEventBody = DistributiveOmit<RunEvent, "seq" | "ts">;

export type AdapterEvent =
  | { kind: "run_event"; runId: string; event: RunEventBody }
  | { kind: "run_signal"; runId: string; signal: RunSignal }
  | { kind: "canonical"; message: OutboundMessage }
  | { kind: "status"; status: AdapterStatus; capabilities: AdapterCapabilities };

export interface AgentAdapter {
  readonly provider: "openclaw";
  connect(): Promise<void>;
  close(): Promise<void>;
  status(): AdapterStatus;
  capabilities(): AdapterCapabilities;
  listAgents(): Promise<Array<{ providerAgentId: string; name?: string }>>;
  sessionKeyFor(providerAgentId: string, channelId: string): string;
  /** ok:false 는 throw AdapterError(code) */
  send(input: InboundDeliver): Promise<InboundDeliverResult>;
  abort(runId: string, sessionKey: string): Promise<void>;
  resetSession(sessionKey: string): Promise<{ sessionStartedAt?: string; lifecycleRevision?: string }>;
  syncChannelConfig(channelId: string, config: ConfigSet["config"]): Promise<ConfigSetResult>;
  onEvent(handler: (e: AdapterEvent) => void): () => void;
}

export class AdapterError extends Error {
  override readonly name = "AdapterError";

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
