import type { ErrorCode } from "../common";
import type {
  ConfigSet,
  ConfigSetResult,
  InboundDeliver,
  InboundDeliverResult,
  OutboundMessage,
} from "../bridge";
import type {
  AgentProvider,
  ApprovalDecision,
  ApprovalKind,
  ApprovalReason,
  ApprovalSeverity,
  ApprovalStatus,
} from "../domain";
import type { RunEvent, RunSignal } from "../events";
import type { RunnerConnection } from "../setup";
import type { AdapterStatus } from "../wire";

// 어댑터 계약(서버 코어 스펙 6.1, 러너 스펙 2장). 두 어댑터 패키지와 서버가 여기서 가져간다 — 순수 타입과 AdapterError 만

export { BridgeAuthGuard } from "./guard";

/** 서버가 어댑터를 고르는 제공자 — `AgentProvider` 중 어댑터가 있는 것 */
export type AdapterProvider = Extract<AgentProvider, "openclaw" | "claude">;

export type AdapterCapabilities = {
  sessionReset: boolean;
  agentsList: boolean;
  configSet: boolean;
  /** 채널 프롬프트를 매 런 싣는다(러너 계획 판정 P3) — false 면 지금처럼 새 세션에서만 */
  promptEveryRun: boolean;
  /** 서버가 providerSessionId 를 정해 send 에 넘긴다(판정 P4) */
  serverSessionIds: boolean;
};

/** pino 호환 최소 로거. 어댑터 패키지가 pino 에 의존하지 않게 모양만 둔다. 토큰은 절대 넘기지 않는다. */
export type AdapterLogger = {
  level?: string;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
};

/** 런 상관(서버 태스크 4) 전의 승인. `channelId`·`providerAgentId`·`threadRootId` 는 `sessionKey` 에서 푼 값이다. */
export type ProviderApproval = {
  providerApprovalId: string;
  kind: ApprovalKind;
  sessionKey: string;
  providerAgentId: string;
  channelId: string;
  /** 스레드 세션의 승인만 */
  threadRootId?: string;
  toolCallId?: string;
  toolName?: string;
  pluginId?: string;
  title: string;
  description?: string;
  detail?: string;
  severity: ApprovalSeverity;
  allowedDecisions: ApprovalDecision[];
  urlPath?: string;
  status: ApprovalStatus;
  decision?: ApprovalDecision;
  reason?: ApprovalReason;
  /** `*.approval.resolved` 에는 오지 않는다(스파이크 3.4) — 그때는 이미 저장한 행의 값을 지킨다. */
  createdAt?: string;
  expiresAt?: string;
  resolvedAt?: string;
};

export type OpenClawAdapterStatus = Extract<AdapterStatus, { provider: "openclaw" }>;
export type ClaudeAdapterStatus = Extract<AdapterStatus, { provider: "claude" }>;

/**
 * 설정 마법사(`SetupStatus`)의 재료 — 어댑터 내부 상세. 소비자는 provider 로 좁혀 읽는다.
 * openclaw: Gateway 토큰·URL 원문은 없다(`host` 는 `호스트:포트` 만). `tokenId` 는 플러그인이 핸드셰이크에서 통과한 브리지 토큰의 id.
 * claude: 지금 붙은 러너들
 */
export type AdapterSetupDetail =
  | {
      provider: "openclaw";
      gateway: {
        state: OpenClawAdapterStatus["gateway"];
        host: string;
        version: string | null;
        pairing: { requestId: string; since: string } | null;
      };
      bridge: {
        state: OpenClawAdapterStatus["bridge"];
        plugin: {
          version: string;
          sdkVersion: string;
          gatewayVersion: string | null;
          bundleSha256: string | null;
          tokenId: string | null;
          connectedAt: string;
        } | null;
      };
    }
  | { provider: "claude"; runners: RunnerConnection[] };
export type OpenClawSetupDetail = Extract<AdapterSetupDetail, { provider: "openclaw" }>;
export type ClaudeSetupDetail = Extract<AdapterSetupDetail, { provider: "claude" }>;

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
  readonly provider: AdapterProvider;
  connect(): Promise<void>;
  close(): Promise<void>;
  status(): AdapterStatus;
  capabilities(): AdapterCapabilities;
  setupDetail(): AdapterSetupDetail;
  /** 그 토큰(브리지 토큰·러너 토큰 — 어댑터마다 자기 종류)으로 붙은 연결을 끊고 끊은 수를 돌려준다 — 토큰 폐기 때 */
  revokeTokenSessions(tokenId: string): number;
  listAgents(): Promise<Array<{ providerAgentId: string; name?: string; hint?: string }>>;
  /** 스레드 루트를 주면 그 스레드의 하위 세션 키 */
  sessionKeyFor(providerAgentId: string, channelId: string, threadRootId?: string): string;
  /** 그 에이전트를 맡은 쪽(OpenClaw 는 붙은 플러그인, 러너는 그 에이전트를 알린 러너)이 능력을 hello 로 알렸는가 — 없으면 false */
  supports(providerAgentId: string, capability: "threads"): boolean;
  /** ok:false 는 throw AdapterError(code). providerSessionId 는 serverSessionIds 어댑터에만 넘긴다 */
  send(input: InboundDeliver, opts?: { providerSessionId?: string }): Promise<InboundDeliverResult>;
  abort(runId: string, sessionKey: string): Promise<void>;
  resetSession(sessionKey: string): Promise<{ sessionStartedAt?: string; lifecycleRevision?: string }>;
  syncChannelConfig(channelId: string, config: ConfigSet["config"]): Promise<ConfigSetResult>;
  /**
   * 승인 결정을 제공자에 보낸다. `kind` 는 저장된 행에서 받는다(OpenClaw wire 에 없다 — 스파이크 4.1).
   * 돌아온 terminal 스냅샷을 같은 정규화로 돌려준다. 보낼 수 없으면(연결 없음) ADAPTER_UNAVAILABLE, 그 밖의 ok:false 도 throw AdapterError.
   */
  resolveApproval(
    providerApprovalId: string,
    kind: ApprovalKind,
    decision: ApprovalDecision,
  ): Promise<ProviderApproval>;
  onEvent(handler: (e: AdapterEvent) => void): () => void;
  /** 서버가 종료 신호 없이 닫은 런(타임아웃)의 추적 상태를 버린다 — 그 뒤 그 런의 제공자 프레임은 무시한다 */
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
