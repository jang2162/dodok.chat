/**
 * Gateway 연결 하나 — 멀티 Gateway 스펙 「연결 관리자」 절. 그 Gateway 의 WS 루프(`gateway/connection-manager`)·디바이스 디렉터리·이벤트 매핑·승인 병합·
 * 프레임 덤프·브리지 자리(`GatewayBridge`)를 쥐고, 이 연결에서 나간 런을 추적한다.
 *
 * 연결 사이에 나누는 상태가 없다 — 런 id·승인 id 기억이 연결마다 따로라 두 Gateway 가 같은 승인 id 를 내도 섞이지 않는다.
 * 끄기·삭제·주소나 토큰 바꾸기는 이 연결의 열린 런만 러너가 끊길 때와 같은 신호(ADAPTER_UNAVAILABLE)로 닫는다(계획 판정 PG5).
 * 닫기 전에 옛 링크로 그 런들에 `chat.abort` 를 보낸다 — 플러그인은 주소·토큰을 바꿔도 붙은 채라, 멈추지 않으면 「다시 실행」 카드
 * 뒤에 진짜 답이 따라 올라온다(태스크 2 리뷰 I1).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type {
  ApprovalDecision,
  ApprovalKind,
  BridgeHello,
  ConfigSet,
  ConfigSetResult,
  InboundDeliver,
  InboundDeliverResult,
  OpenClawGatewayStatus,
  OutboundMessage,
} from "@dodok/shared";
import type { EventFrame } from "@openclaw/gateway-protocol";
import { z } from "zod";
import {
  AdapterError,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterLogger,
  type AdapterSendResult,
  type OpenClawSetupDetail,
  type RunEventBody,
} from "../adapter-types";
import type { BridgeHandle } from "../bridge/server";
import type { BridgeSessionState } from "../bridge/session";
import { syncChannelConfig } from "../config-sync";
import {
  GatewayApprovalKind,
  isApprovalEvent,
  mergeApproval,
  parseApprovalFrame,
  parseResolveResult,
  resolveParams,
  sameApproval,
  type ProviderApproval,
} from "../gateway/approvals";
import {
  type ConnectionManager,
  createConnectionManager,
  gatewayHost,
  type GatewayConnector,
  type GatewayState,
  type RecoverTarget,
} from "../gateway/connection-manager";
import { createGatewayEventMapper, frameRunId } from "../gateway/events";
import { type FrameDump, openFrameDump } from "../gateway/frame-dump";

export type GatewayConnectionConfig = {
  id: string;
  name: string;
  url: string;
  token: string;
  enabled: boolean;
};

/** Gateway WS 상태 + 꺼진 연결 */
export type GatewayConnectionState = GatewayState | "disabled";

/** shared 의 `OpenClawGatewayStatus` 그대로 — 어댑터 상태(`status().gateways`)의 한 줄 */
export type GatewayStatusEntry = OpenClawGatewayStatus;

/** 연결 페이지의 재료 — Gateway 공유 토큰은 싣지 않는다 */
export type GatewaySetupEntry = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  gateway: {
    state: GatewayConnectionState;
    host: string;
    version: string | null;
    pairing: { requestId: string; since: string } | null;
  };
  bridge: OpenClawSetupDetail["bridge"];
};

/** `DATA_DIR/gateways/<id>/` 아래 두 파일. 주소가 바뀌면 토큰 파일만 지워 다시 페어링한다(스펙 3.3) */
export const DEVICE_IDENTITY_FILE = "device.json";
export const DEVICE_TOKENS_FILE = "device-tokens.json";

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
// 연결을 닫을 때 보내는 chat.abort 의 런마다 상한(런끼리는 함께 보낸다) — 답 없는 Gateway 가 옛 링크 정리를 오래 붙잡지 않게.
// 가짜 connector 는 요청 제한시간을 보지 않으므로 여기서 직접 끊는다
const ABORT_ON_CLOSE_TIMEOUT_MS = 2_000;

// Gateway WS 가 다시 붙은 뒤, 끊기기 전부터 열려 있던 런이 아무 프레임도 내지 않고 버틸 수 있는 시간. 끊긴 사이 Gateway 가 보낸
// chat final 은 다시 오지 않고(재접속 복구는 구독만 다시 한다) Gateway 가 재시작했으면 런 자체가 없다 — 이 시계가 없으면 그 런은 서버의
// 런 상한(runMs 600s)까지 살며 같은 세션의 다음 런을 막는다. 살아 있는 런은 구독 뒤 곧바로 델타·툴·thinking 프레임을 내고(그 런 id 의
// 프레임이면 무엇이든 시계를 푼다), 그래도 프레임 없이 조용한 틈(첫 토큰 전 등)이 있을 수 있다 — 그래서 플러그인 대기 상한과 같은 120s 로 둔다. 툴이 열려 있거나 그
// 세션에 미해결 승인이 있는 런은 조용한 것이 정상이라 이 시계를 걸지 않는다(서버의 런 상한·승인 감시가 닫는다)
export const RECONNECT_RUN_GRACE_MS = 120_000;

const AgentsListResult = z.looseObject({
  agents: z.array(z.looseObject({ id: z.string().min(1), name: z.string().optional().catch(undefined) })),
});

export type GatewayConnectionDeps = {
  config: GatewayConnectionConfig;
  /** 디바이스 아이덴티티·토큰 디렉터리 `DATA_DIR/gateways/<id>/` */
  deviceDir: string;
  bridge: BridgeHandle;
  connector: GatewayConnector;
  /** 이 연결의 모든 줄(WS 루프의 재접속·페어링, 전달·플러그인 hello·브리지 상태)이 쓰는 로거 — Gateway id 가 붙는다 */
  gatewayLogger: AdapterLogger;
  backoff?: { initialMs?: number; maxMs?: number; pairingRetryMs?: number };
  sessionKeysToRecover?: () => RecoverTarget[];
  frameDumpPath?: string;
  onCanonical: (message: OutboundMessage) => Promise<{ messageId?: string }>;
  /** 런·승인·정본 이벤트 — 연결 id 는 이 연결이 싣는다 */
  emit: (event: AdapterEvent) => void;
  /** 상태(WS·플러그인)가 바뀌었다 */
  onStatusChange: () => void;
  /** 설정 상세가 바뀌었을 수 있다 */
  onDetailChange: () => void;
  /** Gateway 가 FORBIDDEN 으로 답한 능력 */
  onForbidden: (capability: keyof AdapterCapabilities) => void;
};

export type GatewayConnection = {
  readonly id: string;
  config(): GatewayConnectionConfig;
  /** 이름만 바뀌면 다시 붙지 않는다. 주소·토큰이 바뀌면 열린 런을 닫고 다시 붙고, 주소면 디바이스 토큰을 지운다. 끄면 끊는다 */
  update(next: GatewayConnectionConfig): void;
  /** 어댑터 connect() — 켜져 있으면 WS 루프를 시작한다. 그 뒤로는 켤 때·다시 붙을 때 곧바로 시작한다 */
  start(): void;
  status(): GatewayStatusEntry;
  setupEntry(): GatewaySetupEntry;
  send(input: InboundDeliver): Promise<AdapterSendResult>;
  abort(runId: string, sessionKey: string): Promise<void>;
  listAgents(): Promise<Array<{ providerAgentId: string; name?: string }>>;
  resolveApproval(
    providerApprovalId: string,
    kind: ApprovalKind,
    decision: ApprovalDecision,
  ): Promise<ProviderApproval>;
  syncChannelConfig(channelId: string, config: ConfigSet["config"]): Promise<ConfigSetResult>;
  supports(capability: "threads"): boolean;
  forgetRun(runId: string): void;
  onPluginHello(session: BridgeSessionState, hello: BridgeHello): void;
  onPluginClose(session: BridgeSessionState): void;
  onOutbound(message: OutboundMessage): Promise<{ messageId: string }>;
  /** 어댑터 close() — 기다리는 send 를 끝내고 WS 를 닫는다. 브리지는 어댑터가 먼저 닫는다 */
  close(): Promise<void>;
  /** 열린 런을 닫고, 플러그인을 끊고, WS 를 닫고, 디바이스 디렉터리를 지운다 */
  remove(): Promise<void>;
};

export function createGatewayConnection(deps: GatewayConnectionDeps): GatewayConnection {
  // 이 연결의 줄에는 모두 Gateway id 가 붙는다 — 운영자가 어느 Gateway 의 일인지 알게(토큰·주소는 싣지 않는다)
  const { id, logger } = { id: deps.config.id, logger: deps.gatewayLogger };
  let config = { ...deps.config };
  const view = deps.bridge.forGateway(id);
  let started = false;
  let closed = false;
  let gatewayState: GatewayState = "down";
  let bridgeState: "connected" | "down" = "down";
  // Gateway 이벤트를 우리 런으로 볼 id(send 시작부터 final 뒤 60s 까지)와, 그 가운데 아직 끝나지 않은 디스패치된 런(→ 세션 키,
  // 연결을 닫을 때 chat.abort 에 쓴다)
  const knownRunIds = new Set<string>();
  const openRuns = new Map<string, string>();
  const finalRuns = new Set<string>();
  // 열린 런 가운데 플러그인 경로로 정본이 온 것과, 툴 프레임으로 본 열린 툴 — 재접속 뒤 맞추기(reconcileOpenRuns)가 쓴다
  const canonicalRuns = new Set<string>();
  const openTools = new Map<string, Set<string>>();
  // 재접속 복구 뒤 프레임을 기다리는 열린 런의 유예 시계(RECONNECT_RUN_GRACE_MS)
  const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // 플러그인 ack 를 기다리는 send — 끄기·삭제·주소/토큰 변경이 곧바로 끝낸다
  const pendingSends = new Map<
    string,
    { sessionKey: string; deliveryId: string; reject: (error: AdapterError) => void }
  >();
  // 옛 링크로 abort 를 보내고 멈추는 중인 정리 — close() 가 기다린다
  const closings = new Set<Promise<void>>();
  const forgetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // send 재시도 대기 — close() 가 타이머를 지우고 기다리는 send 를 끝낸다
  const retryWaits = new Map<ReturnType<typeof setTimeout>, (error: AdapterError) => void>();
  // `providerApprovalId` → 마지막으로 낸 병합본. 같은 승인이 정본·세션·되감기 세 경로로, 경로마다 다른 필드를 채워 온다(스파이크 3.1).
  const emittedApprovals = new Map<string, ProviderApproval>();
  const mapper = createGatewayEventMapper({ isOurRun: (runId) => knownRunIds.has(runId) });
  const frameDump: FrameDump | undefined =
    deps.frameDumpPath === undefined ? undefined : openFrameDump(`${deps.frameDumpPath}.${id}`, logger);
  let ws = createWs();

  function createWs(): ConnectionManager {
    const created: ConnectionManager = createConnectionManager({
      gateway: {
        url: config.url,
        token: config.token,
        deviceIdentityPath: join(deps.deviceDir, DEVICE_IDENTITY_FILE),
        deviceTokenStorePath: join(deps.deviceDir, DEVICE_TOKENS_FILE),
      },
      connector: deps.connector,
      logger: deps.gatewayLogger,
      onEvent: (frame) => {
        if (ws === created) onGatewayEvent(frame);
      },
      onState: (next) => {
        // 주소·토큰을 바꾸며 버린 루프의 stop() 도 down 을 알린다 — 지금 루프의 것만 받는다
        if (ws !== created) return;
        gatewayState = next;
        // 유예 중 다시 끊겼다 — 그사이 프레임은 못 받으니 다음 복구 뒤에 처음부터 다시 잰다
        if (next !== "connected") clearReconcileTimers();
        deps.onStatusChange();
        deps.onDetailChange();
      },
      onDetail: () => {
        if (ws === created) deps.onDetailChange();
      },
      onApprovalReplay: (approvals) => {
        if (ws !== created) return;
        for (const approval of approvals) emitApproval(approval);
      },
      onRecovered: () => {
        if (ws === created) reconcileOpenRuns();
      },
      ...(deps.sessionKeysToRecover ? { sessionKeysToRecover: deps.sessionKeysToRecover } : {}),
      ...(deps.backoff ? { backoff: deps.backoff } : {}),
    });
    return created;
  }

  function stopWs(target: ConnectionManager) {
    void target.stop().catch((error: unknown) => {
      // stopAndWait 5s 초과 등 — 연결 객체는 이미 버렸다
      logger.warn({ err: error }, "gateway stop failed");
    });
  }

  function emitRunSignal(runId: string, signal: Extract<AdapterEvent, { kind: "run_signal" }>["signal"]) {
    deps.emit({ kind: "run_signal", runId, connectionId: id, signal });
  }

  function forgetRun(runId: string) {
    clearTimeout(forgetTimers.get(runId));
    forgetTimers.delete(runId);
    clearReconcileTimer(runId);
    knownRunIds.delete(runId);
    openRuns.delete(runId);
    finalRuns.delete(runId);
    canonicalRuns.delete(runId);
    openTools.delete(runId);
    mapper.forget(runId);
  }

  /** final 을 본 런 — 열린 런에서 빼고, 늦은 프레임(usage 등)을 받을 만큼 기억했다가 잊는다 */
  function markFinal(runId: string) {
    clearReconcileTimer(runId);
    openRuns.delete(runId);
    finalRuns.add(runId);
    forgetRunLater(runId);
  }

  function clearReconcileTimer(runId: string) {
    const timer = reconcileTimers.get(runId);
    if (timer === undefined) return;
    clearTimeout(timer);
    reconcileTimers.delete(runId);
  }

  function clearReconcileTimers() {
    for (const timer of reconcileTimers.values()) clearTimeout(timer);
    reconcileTimers.clear();
  }

  /** 디스패치된 런을 연결이 닫힌 것과 같은 신호(RUN_ERROR + gateway_error connectionClosed)로 닫는다 — 서버가 「다시 실행」 카드를 단다 */
  function emitConnectionClosed(runId: string, error: AdapterError) {
    deps.emit({
      kind: "run_event",
      runId,
      connectionId: id,
      event: { type: "RUN_ERROR", runId, code: error.code, message: error.message },
    });
    emitRunSignal(runId, {
      kind: "gateway_error",
      code: error.code,
      message: error.message,
      connectionClosed: true,
    });
  }

  function hasPendingApproval(sessionKey: string): boolean {
    for (const approval of emittedApprovals.values()) {
      if (approval.sessionKey === sessionKey && approval.status === "pending") return true;
    }
    return false;
  }

  /**
   * 재접속 복구가 끝났다 — 끊기기 전부터 열린 런마다 유예 시계를 건다. 그 런의 프레임이 하나라도 오면 살아 있는 것이라 시계를 푼다
   * (onGatewayEvent). 끝내 아무것도 없으면 끊긴 사이 끝났거나(final 을 놓쳤다) Gateway 재시작으로 사라진 것이다 — 정본이 왔으면
   * gateway_final(서버는 hasCanonical 이면 done)로, 아니면 연결 끊김과 같은 ADAPTER_UNAVAILABLE 로 닫는다. Gateway 가 재구독 뒤
   * final 을 다시 보내도 겹치지 않는다 — 먼저 온 쪽이 런을 닫고, 서버 transition 은 종료된 런의 신호를 무시한다
   */
  function reconcileOpenRuns() {
    for (const [runId, sessionKey] of openRuns) {
      clearReconcileTimer(runId);
      if ((openTools.get(runId)?.size ?? 0) > 0 || hasPendingApproval(sessionKey)) continue;
      const timer = setTimeout(() => {
        reconcileTimers.delete(runId);
        if (!openRuns.has(runId)) return;
        if (canonicalRuns.has(runId)) {
          logger.info({ runId }, "open run silent after reconnect with canonical — closing as final");
          emitRunSignal(runId, { kind: "gateway_final" });
          markFinal(runId);
          return;
        }
        logger.warn({ runId, graceMs: RECONNECT_RUN_GRACE_MS }, "open run silent after reconnect — closing");
        forgetRun(runId);
        emitConnectionClosed(runId, unavailable("gateway run lost across reconnect"));
      }, RECONNECT_RUN_GRACE_MS);
      timer.unref();
      reconcileTimers.set(runId, timer);
    }
  }

  /** 열린 툴을 센다 — 툴 하나가 오래 도는 동안에는 프레임이 없다 */
  function trackTools(runId: string, event: RunEventBody) {
    if (event.type === "TOOL_CALL_START") {
      const open = openTools.get(runId) ?? new Set<string>();
      open.add(event.toolCallId);
      openTools.set(runId, open);
    } else if (event.type === "TOOL_CALL_END") {
      openTools.get(runId)?.delete(event.toolCallId);
    }
  }

  function forgetRunLater(runId: string) {
    clearTimeout(forgetTimers.get(runId));
    const timer = setTimeout(() => forgetRun(runId), FORGET_AFTER_FINAL_MS);
    timer.unref();
    forgetTimers.set(runId, timer);
  }

  /**
   * 이 연결의 열린 런을 닫는다 — ack 를 기다리는 send 는 곧바로 그 send 가 던지고(오케스트레이터가 닫는다), 디스패치된 런은 러너
   * 어댑터가 러너를 잃을 때와 같은 RUN_ERROR + gateway_error 로 닫는다(서버가 「다시 실행」 카드를 단다). 닫은 런은 곧바로 잊는다 —
   * 그 런의 늦은 프레임은 버린다.
   *
   * 신호를 내기 전에 `link`(닫히는 옛 링크)로 두 쪽 런 모두에 chat.abort 를 보낸다 — ack 전 런도 플러그인이 이미 디스패치했을 수
   * 있다. 최선 노력이다: 링크가 붙어 있지 않으면 보내지 않고, 실패는 warn, 런마다 상한까지만 기다린다. 끝나면 돌려준 약속이 풀린다 —
   * 부르는 쪽은 그 뒤에 옛 링크를 멈춘다
   */
  function closeOpenRuns(reason: string, link: ConnectionManager, linkUp: boolean): Promise<void> {
    const error = new AdapterError("ADAPTER_UNAVAILABLE", reason);
    for (const [timer, reject] of retryWaits) {
      clearTimeout(timer);
      reject(error);
    }
    retryWaits.clear();
    const targets: Array<{ runId: string; sessionKey: string }> = [];
    for (const [runId, pending] of pendingSends) {
      pendingSends.delete(runId);
      forgetRun(runId);
      // 플러그인이 붙은 채라 브리지 ack 대기는 혼자 끝나지 않는다 — ack 타임아웃까지 남지 않게 끝낸다
      view.abandonDelivery(pending.deliveryId);
      pending.reject(error);
      targets.push({ runId, sessionKey: pending.sessionKey });
    }
    const dispatched = [...openRuns];
    for (const [runId, sessionKey] of dispatched) {
      forgetRun(runId);
      targets.push({ runId, sessionKey });
    }
    const signal = () => {
      for (const [runId] of dispatched) emitConnectionClosed(runId, error);
    };
    if (!linkUp || targets.length === 0) {
      signal();
      return Promise.resolve();
    }
    return Promise.all(targets.map((target) => abortOnClose(link, target))).then(signal);
  }

  async function abortOnClose(link: ConnectionManager, target: { runId: string; sessionKey: string }) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${ABORT_ON_CLOSE_TIMEOUT_MS}ms`)),
        ABORT_ON_CLOSE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([link.request("chat.abort", target, ABORT_ON_CLOSE_TIMEOUT_MS), timeout]);
    } catch (error) {
      logger.warn({ err: error, runId: target.runId }, "chat.abort on connection close failed");
    } finally {
      clearTimeout(timer);
    }
  }

  /** 닫는 링크의 정리(abort → 신호 → stop)를 기억해 둔다 — close() 가 기다린다 */
  function retire(link: ConnectionManager, closing: Promise<void>) {
    const done = closing.then(() => stopWs(link));
    closings.add(done);
    void done.finally(() => closings.delete(done));
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
    const approvalId = incoming.providerApprovalId;
    const previous = emittedApprovals.get(approvalId);
    const approval = previous ? mergeApproval(previous, incoming) : incoming;
    if (previous && sameApproval(previous, approval)) return;
    // 다시 넣어 맨 뒤로 보낸다 — 아직 오가는 승인이 먼저 밀려나지 않게
    emittedApprovals.delete(approvalId);
    emittedApprovals.set(approvalId, approval);
    for (const oldest of emittedApprovals.keys()) {
      if (emittedApprovals.size <= APPROVAL_DEDUPE_MAX) break;
      emittedApprovals.delete(oldest);
    }
    deps.emit({ kind: "approval", connectionId: id, approval });
  }

  function onGatewayEvent(frame: EventFrame) {
    frameDump?.write(frame);
    if (isApprovalEvent(frame.event)) {
      const approval = parseApprovalFrame(frame.event, frame.payload);
      // 우리 세션이 아닌 승인(다른 채널 플러그인·TUI)도 전역으로 온다 — 버린다. 세션 키·본문은 남기지 않는다.
      if (approval) {
        // 승인을 기다리는 런은 조용한 것이 정상이다 — 그 세션의 유예 시계를 푼다
        if (approval.status === "pending") {
          for (const [runId, sessionKey] of openRuns)
            if (sessionKey === approval.sessionKey) clearReconcileTimer(runId);
        }
        emitApproval(approval);
      } else logger.debug({ event: frame.event }, "gateway approval frame ignored");
      return;
    }
    // 그 런 id 로 온 프레임이면 무엇이든 살아 있다는 뜻이다 — 매퍼가 버리는 thinking·run_status 도. 첫 토큰 전에 오래 생각하는 런을 닫지 않는다
    const liveRunId = frameRunId(frame);
    if (liveRunId !== undefined) clearReconcileTimer(liveRunId);
    for (const item of mapper.map(frame)) {
      if (item.event) {
        trackTools(item.runId, item.event);
        deps.emit({ kind: "run_event", runId: item.runId, connectionId: id, event: item.event });
      }
      if (!item.signal) continue;
      deps.emit({
        kind: "run_signal",
        runId: item.runId,
        connectionId: id,
        signal: item.signal,
        ...(item.snapshotText === undefined ? {} : { snapshotText: item.snapshotText }),
      });
      if (item.signal.kind === "gateway_final") {
        markFinal(item.runId);
      } else if (item.signal.kind === "gateway_error" || item.signal.kind === "gateway_aborted") {
        forgetRun(item.runId);
      }
    }
  }

  function setBridgeState(next: "connected" | "down") {
    if (bridgeState === next) return;
    bridgeState = next;
    logger.info({ bridge: next }, "bridge status changed");
    deps.onStatusChange();
  }

  const unavailable = (reason: string) => new AdapterError("ADAPTER_UNAVAILABLE", reason);
  const adapterClosed = () => unavailable("adapter closed");

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
      if (!knownRunIds.has(input.runId)) throw unavailable("run forgotten before delivery");
      const res = await view.deliverInbound(input, ackTimeoutMs);
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
      // 기다리는 사이 연결을 닫으며 이 런을 닫았다 — 다시 보내지도, 플러그인을 기다리지도 않는다
      if (!knownRunIds.has(input.runId)) throw unavailable("run forgotten before delivery");
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
          await view.waitForReady(PLUGIN_READY_WAIT_MS);
        } catch {
          // 브리지 close()·Gateway 끄기도 대기자를 reject 한다
          if (closed) throw adapterClosed();
          throw unavailable(`plugin not connected within ${PLUGIN_READY_WAIT_MS}ms`);
        }
        continue;
      }
      throw new AdapterError(code, message);
    }
  }

  function setupEntry(): GatewaySetupEntry {
    const detail = ws.detail();
    const session = view.current();
    const hello = session?.hello;
    return {
      id,
      name: config.name,
      url: config.url,
      enabled: config.enabled,
      gateway: {
        state: config.enabled ? gatewayState : "disabled",
        host: gatewayHost(config.url),
        version: detail.version,
        pairing: detail.pairing,
      },
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

  function clearRunMemory() {
    emittedApprovals.clear();
    clearReconcileTimers();
    for (const timer of forgetTimers.values()) clearTimeout(timer);
    forgetTimers.clear();
  }

  return {
    id,
    config: () => ({ ...config }),

    update(next) {
      const previous = config;
      config = { ...next };
      const addressChanged = next.url !== previous.url;
      const credentialsChanged = addressChanged || next.token !== previous.token;
      const disabling = previous.enabled && !next.enabled;
      const closing = disabling || (previous.enabled && credentialsChanged);
      if (closing) {
        const old = ws;
        const reason = disabling
          ? "gateway disabled"
          : addressChanged
            ? "gateway address changed"
            : "gateway token changed";
        // 옛 링크는 abort 를 보낸 뒤에 멈춘다. 새 링크는 기다리지 않고 곧바로 만든다 — 끄기도 새 루프로 바꿔 두어, 곧바로 다시 켤 때
        // 멈추는 중인 옛 루프를 되살리지 않게 한다
        retire(old, closeOpenRuns(reason, old, gatewayState === "connected"));
        if (disabling) deps.bridge.disconnectGateway(id);
      }
      // 꺼진 동안 주소·토큰을 바꿔도 루프를 새로 만들어 둔다 — 켤 때 옛 주소로 붙지 않게
      if (closing || credentialsChanged) {
        // 다른 Gateway 일 수 있다 — 옛 Gateway 가 준 디바이스 토큰으로 붙지 않고 다시 페어링한다. 디바이스 키는 그대로 쓴다.
        // 못 지워도 새 주소로 붙는다 — 남은 토큰은 새 Gateway 가 거절하고 클라이언트가 지운다(던지면 연결이 down 에 멈춘다, 리뷰 M1)
        if (addressChanged) {
          try {
            rmSync(join(deps.deviceDir, DEVICE_TOKENS_FILE), { force: true });
          } catch (error) {
            logger.warn({ err: error }, "gateway device token removal failed");
          }
        }
        ws = createWs();
        gatewayState = "down";
      }
      if (next.enabled && started && (credentialsChanged || !previous.enabled)) ws.start();
      deps.onStatusChange();
      deps.onDetailChange();
    },

    start() {
      started = true;
      if (config.enabled) ws.start();
    },

    status: () => ({
      id,
      name: config.name,
      enabled: config.enabled,
      gateway: config.enabled ? gatewayState : "disabled",
      bridge: bridgeState,
    }),
    setupEntry,

    async send(input) {
      if (closed) throw adapterClosed();
      if (!config.enabled) throw unavailable("gateway is disabled");
      // 플러그인은 런이 시작될 때(onAgentRunStart) ack 하므로 Gateway 이벤트가 ack 보다 먼저 올 수 있다 — 전송 전에 등록한다
      knownRunIds.add(input.runId);
      // 접속 뒤 새로 생긴 세션은 재접속 복구 구독에 없다 — 전송 전에 구독해야 Gateway 델타·툴 이벤트가 온다(Phase 1 실연에서 발견).
      // Gateway 가 끊겨 있으면 건너뛴다(정본은 플러그인 경로) — 다시 붙을 때 recover 가 agent_sessions 로 구독한다.
      try {
        await ws.subscribeSession(input.sessionKey, input.agentId);
      } catch (error) {
        const notConnected = (error as { code?: unknown }).code === "ADAPTER_UNAVAILABLE";
        logger[notConnected ? "debug" : "warn"](
          { err: error, sessionKey: input.sessionKey },
          "gateway session subscribe before send failed",
        );
      }
      // 끄기·삭제가 이 send 를 곧바로 끝낼 수 있게 경주시킨다. 진 deliver 의 늦은 실패는 버린다(런은 이미 잊었다)
      const delivering = deliver(input);
      delivering.catch(() => undefined);
      const aborted = new Promise<never>((_resolve, reject) =>
        pendingSends.set(input.runId, {
          sessionKey: input.sessionKey,
          deliveryId: input.deliveryId,
          reject,
        }),
      );
      try {
        const result = await Promise.race([delivering, aborted]);
        if (result.admission === "drop") forgetRun(input.runId);
        else if (knownRunIds.has(input.runId) && !finalRuns.has(input.runId))
          openRuns.set(input.runId, input.sessionKey);
        return { ...result, connectionId: id };
      } catch (error) {
        forgetRun(input.runId);
        throw error;
      } finally {
        pendingSends.delete(input.runId);
      }
    },

    async abort(runId, sessionKey) {
      await ws.request("chat.abort", { sessionKey, runId });
    },

    async listAgents() {
      let res: unknown;
      try {
        res = await ws.request("agents.list", {});
      } catch (error) {
        if (error instanceof AdapterError && error.code === "FORBIDDEN") deps.onForbidden("agentsList");
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

    async resolveApproval(providerApprovalId, kind, decision) {
      // 재접속 중(reconnecting)에도 결정을 보내지 않는다 — 승인 서비스가 하던 선검사를 어댑터 안으로 옮겼다(러너 계획 판정 P6)
      if (!config.enabled || gatewayState !== "connected") throw unavailable("gateway is not connected");
      // tool 은 러너 어댑터의 승인이다 — 여기로 왔다면 잘못 짝지어진 것이라 Gateway 에 보내지 않는다
      const gatewayKind = GatewayApprovalKind.safeParse(kind).data;
      if (!gatewayKind)
        throw new AdapterError("INTERNAL", `approval kind ${kind} is not an OpenClaw approval`);
      // 연결이 없으면 ws 가 ADAPTER_UNAVAILABLE 을 던진다(다른 RPC 와 같은 규칙).
      const res = await ws.request(
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

    syncChannelConfig: (channelId, channelConfig) =>
      syncChannelConfig(view, logger, channelId, channelConfig),

    // 에이전트를 가리지 않는다 — 그 Gateway 의 모든 에이전트가 붙은 플러그인 하나를 지난다
    supports: (capability) => view.current()?.hello?.capabilities.includes(capability) ?? false,

    forgetRun,

    onPluginHello(session, hello) {
      // gatewayVersion 은 플러그인이 돌고 있는 Gateway 의 runtime.version. pluginBuiltWithSdk 는 빌드 때 박힌
      // openclaw devDependency 버전이라 Gateway 버전이 아니다(9.5 위에서도 2026.9.4 로 찍힌다).
      // tokenId(원문 아님)는 토큰 교체 중 어느 토큰으로 붙었는지, capabilities 는 그 플러그인이 threads 등을 아는지 로그만으로 가르게 싣는다
      logger.info(
        {
          pluginVersion: hello.version,
          pluginBuiltWithSdk: hello.sdkVersion,
          gatewayVersion: hello.gatewayVersion ?? null,
          tokenId: session.tokenId,
          capabilities: hello.capabilities,
        },
        "bridge plugin hello",
      );
      setBridgeState("connected");
      deps.onDetailChange();
    },

    onPluginClose(session) {
      deps.onDetailChange();
      // 새 연결이 이전 연결을 교체할 때는 down 을 거치지 않는다
      if (session.closeReason === "replaced") return;
      if (!view.current()) setBridgeState("down");
    },

    async onOutbound(message) {
      const stored = await deps.onCanonical(message);
      if (message.runId !== undefined && knownRunIds.has(message.runId)) canonicalRuns.add(message.runId);
      deps.emit({ kind: "canonical", connectionId: id, message });
      return { messageId: stored.messageId ?? message.outboundId };
    },

    async close() {
      closed = true;
      clearRunMemory();
      for (const [timer, reject] of retryWaits) {
        clearTimeout(timer);
        reject(adapterClosed());
      }
      retryWaits.clear();
      // 옛 링크 정리는 런마다 상한이 있다 — 끝까지 기다려 종료 뒤에 남는 타이머·링크가 없게 한다
      await Promise.all(closings);
      try {
        await ws.stop();
      } catch (error) {
        // stopAndWait 5s 초과 등 — 종료는 계속한다
        logger.warn({ err: error }, "gateway stop failed during close");
      }
      await frameDump?.close(); // Gateway 가 닫힌 뒤 — 마지막 프레임까지 남긴다
    },

    async remove() {
      const closing = closeOpenRuns("gateway removed", ws, config.enabled && gatewayState === "connected");
      deps.bridge.disconnectGateway(id, { forget: true });
      closed = true;
      await closing;
      clearRunMemory();
      await Promise.all(closings);
      try {
        await ws.stop();
      } catch (error) {
        logger.warn({ err: error }, "gateway stop failed during remove");
      }
      await frameDump?.close();
      // 못 지워도 삭제는 끝까지 간다 — 연결은 이미 목록에서 빠졌다. 남은 디렉터리는 같은 id 를 다시 쓰지 않으면 읽히지 않는다
      try {
        rmSync(deps.deviceDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn({ err: error }, "gateway device directory removal failed");
      }
    },
  };
}
