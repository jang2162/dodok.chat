import type {
  AdapterStatus,
  ApprovalDecision,
  ApprovalKind,
  ConfigSet,
  ConfigSetResult,
  ErrorCode,
  InboundDeliver,
  InboundDeliverResult,
  OutboundMessage,
  RunEvent,
  RunSignal,
} from "@dodok/shared";
import type { ProviderApproval } from "./gateway/approvals";

// 서버 코어 스펙 6.1. 서버(apps/server/src/adapters)는 이 파일을 re-export 한다.

export type AdapterCapabilities = { sessionReset: boolean; agentsList: boolean; configSet: boolean };

/** pino 호환 최소 로거. 어댑터 패키지가 pino 에 의존하지 않게 모양만 둔다. 토큰은 절대 넘기지 않는다. */
export type AdapterLogger = {
  level?: string;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
};

/**
 * 설정 마법사(`SetupStatus` 의 gateway·bridge)의 재료 — 어댑터 내부 상세. `AdapterStatus` 는 그대로 두고 따로 둔다.
 * Gateway 토큰·URL 원문은 없다(`host` 는 `호스트:포트` 만). `tokenId` 는 플러그인이 핸드셰이크에서 통과한 브리지 토큰의 id.
 */
export type AdapterSetupDetail = {
  gateway: {
    state: AdapterStatus["gateway"];
    host: string;
    version: string | null;
    pairing: { requestId: string; since: string } | null;
  };
  bridge: {
    state: AdapterStatus["bridge"];
    plugin: {
      version: string;
      sdkVersion: string;
      gatewayVersion: string | null;
      bundleSha256: string | null;
      tokenId: string | null;
      connectedAt: string;
    } | null;
  };
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** seq·ts 는 오케스트레이터가 부여한다. 판별 유니온이라 Omit 을 변형마다 분배한다. */
export type RunEventBody = DistributiveOmit<RunEvent, "seq" | "ts">;

export type AdapterEvent =
  | { kind: "run_event"; runId: string; event: RunEventBody }
  | { kind: "run_signal"; runId: string; signal: RunSignal; snapshotText?: string } // snapshotText 는 gateway_final 에만
  | { kind: "canonical"; message: OutboundMessage }
  | { kind: "status"; status: AdapterStatus; capabilities: AdapterCapabilities }
  // 승인은 런 이벤트가 아니다 — 런 상관(sessionKey + toolCallId)은 서버가 한다(설계 4.1·4.2)
  | { kind: "approval"; approval: ProviderApproval }
  // setupDetail() 이 바뀌었다(페어링 시작·해소, 플러그인 hello·끊김 등) — 값은 setupDetail() 로 읽는다. 같은 상세면 내지 않는다
  | { kind: "setup" };

export interface AgentAdapter {
  readonly provider: "openclaw";
  connect(): Promise<void>;
  close(): Promise<void>;
  status(): AdapterStatus;
  capabilities(): AdapterCapabilities;
  setupDetail(): AdapterSetupDetail;
  /** 그 브리지 토큰으로 붙은 플러그인 연결을 끊고 끊은 수를 돌려준다 — 토큰 폐기 때 */
  revokeBridgeSessions(tokenId: string): number;
  listAgents(): Promise<Array<{ providerAgentId: string; name?: string }>>;
  sessionKeyFor(providerAgentId: string, channelId: string): string;
  /** ok:false 는 throw AdapterError(code) */
  send(input: InboundDeliver): Promise<InboundDeliverResult>;
  abort(runId: string, sessionKey: string): Promise<void>;
  resetSession(sessionKey: string): Promise<{ sessionStartedAt?: string; lifecycleRevision?: string }>;
  syncChannelConfig(channelId: string, config: ConfigSet["config"]): Promise<ConfigSetResult>;
  /**
   * `approval.resolve` 래퍼. `kind` 는 wire 에 없으므로 저장된 행에서 받는다(스파이크 4.1).
   * 돌아온 terminal 스냅샷을 같은 정규화로 돌려준다. ok:false 는 throw AdapterError.
   */
  resolveApproval(
    providerApprovalId: string,
    kind: ApprovalKind,
    decision: ApprovalDecision,
  ): Promise<ProviderApproval>;
  onEvent(handler: (e: AdapterEvent) => void): () => void;
  /** 서버가 종료 신호 없이 닫은 런(타임아웃)의 추적 상태를 버린다 — 그 뒤 그 런의 Gateway 프레임은 무시한다 */
  forgetRun?(runId: string): void;
}

export class AdapterError extends Error {
  override readonly name = "AdapterError";

  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
