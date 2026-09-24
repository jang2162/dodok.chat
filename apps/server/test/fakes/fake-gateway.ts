/**
 * 가짜 OpenClaw Gateway — 실제 `@openclaw/gateway-client`(어댑터의 `connectGateway`)가 붙는 ws 서버. 네트워크 없이 서버 전체를 돌리는 하네스.
 *
 * 핸드셰이크는 실물 순서(ADR 0001): 접속 즉시 `connect.challenge` → `req connect` → `res hello-ok`. 서명·토큰은 검증하지 않는다.
 * 요청은 응답 표(서버 코어 태스크 13)대로 답하고, 모르는 메서드는 실물처럼 FORBIDDEN/MISSING_SCOPE 로 거절한다(ADR 0001 4.4).
 * 이벤트 페이로드는 태스크 10 픽스처 팩토리로 만든다 — 어댑터 매퍼 테스트와 같은 모양이다.
 */
import type { ApprovalDecision, ApprovalReason, ApprovalStatus } from "@dodok/shared";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";
import type { GatewayConnection } from "../../../../packages/openclaw-adapter/src/gateway/client";
import * as fixtures from "../../../../packages/openclaw-adapter/test/fixtures/gateway-events";

type HelloOk = GatewayConnection["hello"];
type EventFrame = ReturnType<typeof fixtures.agentEvent>;

/** `@openclaw/gateway-protocol` RequestFrameSchema 와 같은 모양(서버 패키지는 그 패키지에 직접 의존하지 않는다). */
export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
  traceparent?: string;
};

export type ChatSendParams = { sessionKey: string; agentId: string; message: string; idempotencyKey: string };

/** 툴이 요구하는 승인 하나(승인 스파이크 3.2). 시각은 가짜 Gateway 가 실제 시계로 채운다 */
export type FakeApprovalRequest = {
  /** 그 승인을 요구한 툴 호출 — `plugin.approval.requested` 의 `request.toolCallId` */
  toolCallId: string;
  /** 기본 `plugin:<uuid>` — 실물과 같은 모양 */
  approvalId?: string;
  title?: string;
  toolName?: string;
  /** 기본 `["allow-once", "deny"]`(claude-cli 실물) */
  allowedDecisions?: ApprovalDecision[];
  /** 이만큼 아무도 해결하지 않으면 만료된다(실물 plugin 기본 120초) */
  ttlMs: number;
  /**
   * 만료됐을 때 — `"gateway"`(기본)는 실물처럼 확정 짝(`session.approval(terminal)` + `resolved`)을 보내고(5.2),
   * `"silent"` 는 아무 프레임도 보내지 않는다(서버의 만료 감시 타이머를 재는 대본).
   */
  onTimeout?: "gateway" | "silent";
  /**
   * 확정 짝을 어느 순서로 내는가. 기본은 실물 관측 순서인 `"session-first"`(스파이크 3.5 의 caps 표·5.2 타임라인).
   * 만료의 `decision` 은 뒤에 오는 `plugin.approval.resolved` 에만 있어서 순서가 저장된 행을 바꾸면 안 된다(리뷰 F2).
   * ⚠ **요구 짝**은 아직 `plugin.approval.requested` 가 먼저다 — 실물은 그것도 세션이 먼저지만 뒤집으면
   * 타임라인 카드가 `toolCallId` 를 잃는다(p2-t6 fix2 보고서 4절, 태스크 7·8 로 이월).
   */
  settleFrameOrder?: "session-first" | "plugin-first";
};

/** 승인 하나의 결말 — 대본은 이걸 보고 툴 결과를 고른다 */
export type FakeApprovalOutcome = {
  approvalId: string;
  /** 만료·중지는 `"deny"` */
  decision: ApprovalDecision;
  /** TTL 이 지나 만료됐는가 */
  expired: boolean;
};

/** 확정된 승인의 스냅샷 값 — RPC 응답과 `resolved` 프레임이 같은 값을 싣는다 */
type ApprovalVerdict = {
  status: Extract<ApprovalStatus, "allowed" | "denied" | "expired" | "cancelled">;
  decision: ApprovalDecision;
  reason: Extract<ApprovalReason, "user" | "timeout" | "malformed-verdict" | "run-aborted">;
  resolvedAtMs: number;
};

type ApprovalState = FakeApprovalRequest & {
  id: string;
  runId: string;
  sessionKey: string;
  agentId: string;
  title: string;
  toolName: string;
  allowedDecisions: ApprovalDecision[];
  onTimeout: "gateway" | "silent";
  settleFrameOrder: "session-first" | "plugin-first";
  createdAtMs: number;
  expiresAtMs: number;
  verdict?: ApprovalVerdict;
  /** 결말을 기다리는 대본 — 확정되면 한 번 부르고 버린다 */
  wake?: (outcome: FakeApprovalOutcome) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type FakeGatewayOptions = {
  /** false 면 `sessions.reset` 이 FORBIDDEN/MISSING_SCOPE(operator.admin 없음). 기본 true */
  grantAdmin?: boolean;
  /**
   * 주면 이 간격으로 hello 를 받은 모든 연결에 `tick` 이벤트를 보낸다(payload 에 sessionKey 가 없어 구독과 무관).
   * 실제 클라이언트는 프레임 없이 hello 의 `policy.tickIntervalMs`(30s)×2 가 지나면 끊으므로 오래 띄우는 개발 모드에 필요하다
   */
  tickIntervalMs?: number;
  /** hello-ok 의 server.version(기본은 저장소 핀 2026.9.4) — 서버의 Gateway 버전 사건을 잴 때 바꾼다 */
  serverVersion?: string;
};

export type FakeGateway = {
  readonly url: string;
  readonly token: string;
  /** 받은 요청 전부(connect 포함), 도착 순서 */
  readonly requests: RequestFrame[];
  /** `chat.send` 응답을 보낸 뒤 부른다. 다시 부르면 교체. handler 의 reject 는 잡지 않는다 — 처리되지 않은 reject 로 테스트를 깨뜨린다 */
  onChatSend(handler: (params: ChatSendParams) => void | Promise<void>): void;
  /** 이벤트 프레임을 보낸다 — payload.sessionKey 가 있으면 그 키를 구독한 연결에만, 없으면 hello 를 받은 모두에게. 쓰기가 끝나면 resolve */
  emitEvent(event: string, payload: unknown): Promise<void>;
  lifecycleStart(runId: string, sessionKey: string, agentId: string): Promise<void>;
  /** 누적 스냅샷(`message`)은 이 런에서 보낸 델타를 이어 붙인 것 */
  chatDelta(runId: string, sessionKey: string, agentId: string, deltaText: string): Promise<void>;
  chatFinal(runId: string, sessionKey: string, agentId: string, text: string): Promise<void>;
  chatError(
    runId: string,
    sessionKey: string,
    agentId: string,
    error?: { errorMessage?: string; errorKind?: string; errorDetail?: Record<string, unknown> },
  ): Promise<void>;
  chatAborted(runId: string, sessionKey: string, agentId: string): Promise<void>;
  toolStart(
    runId: string,
    sessionKey: string,
    agentId: string,
    tool: { toolCallId: string; name: string; args: Record<string, unknown> },
  ): Promise<void>;
  /** name·args 를 생략하면 같은 toolCallId 의 toolStart 값을 싣는다(실물 result 프레임도 둘을 함께 싣는다) */
  toolResult(
    runId: string,
    sessionKey: string,
    agentId: string,
    tool: {
      toolCallId: string;
      name?: string;
      args?: Record<string, unknown>;
      result: unknown;
      isError?: boolean;
    },
  ): Promise<void>;
  /** usage 는 final 이 아니라 `session.message` 에 실린다(ADR 0001 6.3) */
  sessionMessageUsage(runId: string, sessionKey: string): Promise<void>;
  /**
   * 툴이 승인을 요구한다 — `plugin.approval.requested` 를 실물 모양(3.2)으로 보내고 결말을 기다린다.
   * 결말은 `approval.resolve` RPC·TTL 만료·그 런의 `chat.abort` 중 먼저 오는 것으로 난다.
   * 돌려주는 프로미스는 프레임을 쓴 뒤가 아니라 **결말이 났을 때** resolve 한다 — 기다리지 않고 두 번 부르면 승인이 겹친다.
   */
  requestApproval(
    runId: string,
    sessionKey: string,
    agentId: string,
    approval: FakeApprovalRequest,
  ): Promise<FakeApprovalOutcome>;
  /**
   * 지금까지 보낸 프레임을 연결된 클라이언트가 모두 처리할 때까지 기다린다 — 연결마다 ping 을 보내 pong 을 받는다
   * (ws 는 프레임을 순서대로 읽어 앞 프레임의 onEvent 를 부른 뒤 pong 을 낸다). 쓰기가 끝나도 서버 이벤트 루프가 다른 소켓(브리지)을
   * 먼저 읽을 수 있어서, 실물처럼 Gateway 이벤트를 정본보다 먼저 처리시키려면 정본 앞에서 부른다.
   */
  flush(): Promise<void>;
  /** 열린 연결을 모두 끊고 포트를 닫는다. 두 번 불러도 된다 */
  close(): Promise<void>;
};

export const FAKE_GATEWAY_TOKEN = "fake-gateway-token";
/** 해결한 클라이언트의 `clientDisplayName` — 우리는 "dodok" 으로 붙는다(승인 스파이크 3.4) */
export const APPROVAL_RESOLVED_BY = "dodok";
const DEFAULT_APPROVAL_TITLE = "claude-cli native tool: Write";
const DEFAULT_APPROVAL_TOOL = "Write";

/** 어댑터가 부르는 메서드 전부(`features.methods` 광고). `connect` 는 실물처럼 광고하지 않는다(ADR 0001 4.4). */
export const FAKE_GATEWAY_METHODS = [
  "chat.send",
  "chat.abort",
  "chat.history",
  "sessions.subscribe",
  "sessions.messages.subscribe",
  "sessions.list",
  "sessions.reset",
  "agents.list",
  "approval.resolve",
] as const;
export const FAKE_GATEWAY_EVENTS = [
  "chat",
  "agent",
  "session.message",
  "sessions.changed",
  "plugin.approval.requested",
  "plugin.approval.resolved",
] as const;

type GatewayError = { code: string; message: string; details?: Record<string, unknown> };

const MISSING_ADMIN_SCOPE: GatewayError = {
  code: "FORBIDDEN",
  message: "missing scope",
  details: { code: "MISSING_SCOPE", missingScope: "operator.admin", requiredScopes: ["operator.admin"] },
};

/** 없는 승인에 resolve — 실물 모양(승인 스파이크 4.4) */
const APPROVAL_NOT_FOUND: GatewayError = {
  code: "INVALID_REQUEST",
  message: "approval not found",
  details: { reason: "APPROVAL_NOT_FOUND" },
};

type Reply = (result: { ok: true; payload: unknown } | { ok: false; error: GatewayError }) => void;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `agent:<agentId>:…` → agentId */
function agentIdFromKey(sessionKey: string): string {
  return sessionKey.split(":")[1] ?? "";
}

function isRequestFrame(value: unknown): value is RequestFrame {
  const frame = record(value);
  return frame.type === "req" && typeof frame.id === "string" && typeof frame.method === "string";
}

/**
 * `HelloOkSchema`(gateway-protocol `frames-*.d.mts` 69-)의 필수 필드 전부. 반환 타입이 그 스키마의 Static 이라 빠지면 typecheck 가 깨진다.
 * `sessionDefaults` 는 선택이지만 넣으면 `defaultAgentId`·`mainKey`·`mainSessionKey` 가 필수다(같은 파일 247-253).
 */
function helloOk(connectParams: unknown, serverVersion = "2026.9.4"): HelloOk {
  const params = record(connectParams);
  const scopes = Array.isArray(params.scopes) ? params.scopes.filter((s) => typeof s === "string") : [];
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: serverVersion, connId: randomUUID() },
    features: { methods: [...FAKE_GATEWAY_METHODS], events: [...FAKE_GATEWAY_EVENTS], capabilities: [] },
    snapshot: {
      presence: [],
      health: { ok: true },
      stateVersion: { presence: 0, health: 0 },
      uptimeMs: 0,
      sessionDefaults: { defaultAgentId: "dev", mainKey: "main", mainSessionKey: "agent:dev:main" },
    },
    auth: { method: "token", role: str(params.role) ?? "operator", scopes },
    policy: { maxPayload: 26_214_400, maxBufferedBytes: 52_428_800, tickIntervalMs: 30_000 },
  };
}

export async function startFakeGateway(opts: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const grantAdmin = opts.grantAdmin ?? true;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const { port } = wss.address() as AddressInfo;

  const requests: RequestFrame[] = [];
  /** connect 에 hello-ok 로 답한 연결 — 이벤트는 여기로만 간다 */
  const connected = new Set<WebSocket>();
  /** 연결별 `sessions.messages.subscribe` 한 세션 키 — 실물처럼 세션 이벤트는 구독한 연결에만 간다 */
  const subscriptions = new Map<WebSocket, Set<string>>();
  const sessionIds = new Map<string, string>();
  const deltaSnapshots = new Map<string, string>();
  const toolStarts = new Map<string, { name: string; args: Record<string, unknown> }>();
  /** 이 Gateway 가 낸 승인 — 확정된 것도 남긴다(실물처럼 다시 resolve 하면 applied:false 로 답한다) */
  const approvals = new Map<string, ApprovalState>();
  let seq = 0;
  let chatSendHandler: ((params: ChatSendParams) => void | Promise<void>) | undefined;
  let closing: Promise<void> | undefined;

  const sessionIdFor = (key: string): string => {
    let id = sessionIds.get(key);
    if (!id) {
      id = randomUUID();
      sessionIds.set(key, id);
    }
    return id;
  };

  function write(socket: WebSocket, frame: unknown): Promise<void> {
    return new Promise((resolve) => {
      // 닫히는 중인 소켓의 쓰기 오류는 무시한다 — 그 연결은 close 로 정리된다
      socket.send(JSON.stringify(frame), () => resolve());
    });
  }

  function pingPong(socket: WebSocket): Promise<void> {
    if (socket.readyState !== socket.OPEN) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        socket.off("pong", done);
        socket.off("close", done);
        resolve();
      };
      socket.on("pong", done);
      socket.on("close", done);
      socket.ping();
    });
  }

  async function broadcast(frame: EventFrame): Promise<void> {
    // payload 에 sessionKey 가 있는 세션 이벤트는 그 키를 구독한 연결에만, 그 밖은 연결된 모두에게
    const key = str(record(frame.payload).sessionKey);
    const targets = [...connected].filter(
      (socket) => key === undefined || subscriptions.get(socket)?.has(key),
    );
    await Promise.all(targets.map((socket) => write(socket, frame)));
  }

  const nextSeq = () => ++seq;
  const tickTimer =
    opts.tickIntervalMs === undefined
      ? undefined
      : setInterval(() => {
          void broadcast({ type: "event", event: "tick", payload: { ts: Date.now() }, seq: nextSeq() });
        }, opts.tickIntervalMs);
  // 타이머가 프로세스를 붙잡지 않게 — 닫는 건 close()
  tickTimer?.unref();
  const common = (runId: string, sessionKey: string, agentId: string) => ({
    runId,
    sessionKey,
    agentId,
    seq: nextSeq(),
  });

  /** 승인 픽스처가 읽는 값 — `seq` 는 프레임을 만들 때만 붙인다(RPC 응답은 프레임이 아니다) */
  const approvalOpts = (a: ApprovalState) => ({
    runId: a.runId,
    sessionKey: a.sessionKey,
    agentId: a.agentId,
    id: a.id,
    title: a.title,
    toolName: a.toolName,
    toolCallId: a.toolCallId,
    allowedDecisions: a.allowedDecisions,
    createdAtMs: a.createdAtMs,
    expiresAtMs: a.expiresAtMs,
  });

  /** `approval.resolve` 응답의 terminal 스냅샷(4.1). 이미 확정된 승인에는 `applied:false` 로 같은 값을 돌려준다(4.4) */
  const resolveResult = (a: ApprovalState, v: ApprovalVerdict, applied: boolean) =>
    fixtures.approvalResolveResult({
      ...approvalOpts(a),
      applied,
      status: v.status,
      decision: v.decision,
      reason: v.reason,
      resolvedAtMs: v.resolvedAtMs,
    });

  /**
   * 승인 하나를 확정한다. `emit` 이면 실물처럼 **짝으로** 낸다 — `session.approval(terminal)` + `plugin.approval.resolved`(3.4·5.2).
   * 만료 스냅샷에는 `decision` 이 없고(`status:"expired"`·`reason:"timeout"` 뿐) 정본에만 `deny`+`resolvedBy:null` 이 실린다.
   * 기다리던 대본은 프레임을 쓴 **뒤에** 깨운다(두 프레임 모두 이미 소켓에 예약돼 순서가 지켜진다).
   */
  function settleApproval(a: ApprovalState, verdict: ApprovalVerdict, emit: boolean): Promise<void> {
    if (a.verdict) return Promise.resolve();
    clearTimeout(a.timer);
    a.verdict = verdict;
    const wake = a.wake;
    a.wake = undefined;
    const sent = emit ? Promise.all(settleFrames(a, verdict).map((f) => broadcast(f))) : Promise.resolve();
    wake?.({ approvalId: a.id, decision: verdict.decision, expired: verdict.reason === "timeout" });
    return sent.then(() => undefined);
  }

  /** 확정 짝을 그 승인이 정한 순서로. 프레임은 만드는 순서대로 `seq` 를 받는다 */
  function settleFrames(a: ApprovalState, verdict: ApprovalVerdict): EventFrame[] {
    const expired = verdict.reason === "timeout";
    const session = () =>
      fixtures.sessionApproval({
        ...approvalOpts(a),
        seq: nextSeq(),
        phase: "terminal",
        status: verdict.status,
        // ⚠ 실측(5.2) — 만료 스냅샷에는 `decision` 이 없다. 그 값은 정본 프레임에만 실려 온다
        ...(expired ? { decision: null } : { decision: verdict.decision }),
        reason: verdict.reason,
        resolvedAtMs: verdict.resolvedAtMs,
      });
    const plugin = () =>
      fixtures.pluginApprovalResolved({
        ...approvalOpts(a),
        seq: nextSeq(),
        decision: verdict.decision,
        // resolvedBy 는 해결한 클라이언트의 clientDisplayName — 만료·취소는 해결자가 없다(3.4·5.2)
        resolvedBy: verdict.reason === "user" ? APPROVAL_RESOLVED_BY : null,
        resolvedAtMs: verdict.resolvedAtMs,
      });
    return a.settleFrameOrder === "plugin-first" ? [plugin(), session()] : [session(), plugin()];
  }

  /** 그 런의 미해결 승인을 프레임 없이 버린다(런 중지·포트 닫기) — 기다리던 대본이 영원히 멈추지 않게 */
  function dropApprovals(
    match: (a: ApprovalState) => boolean,
    verdict: Omit<ApprovalVerdict, "resolvedAtMs">,
  ) {
    for (const a of approvals.values()) {
      if (!a.verdict && match(a)) void settleApproval(a, { ...verdict, resolvedAtMs: Date.now() }, false);
    }
  }

  // 응답 표 — 서버 코어 태스크 13 + sc-t13 브리프 2
  const methods: Record<
    (typeof FAKE_GATEWAY_METHODS)[number],
    (params: Record<string, unknown>, reply: Reply) => void
  > = {
    "chat.send": (params, reply) => {
      const sessionKey = str(params.sessionKey) ?? "";
      const send: ChatSendParams = {
        sessionKey,
        agentId: str(params.agentId) ?? agentIdFromKey(sessionKey),
        message: str(params.message) ?? "",
        idempotencyKey: str(params.idempotencyKey) ?? "",
      };
      // 실물: runId 는 클라이언트가 보낸 idempotencyKey 그대로(ADR 0001 6.1)
      reply({ ok: true, payload: { runId: send.idempotencyKey, status: "started" } });
      const handler = chatSendHandler;
      if (handler) void Promise.resolve().then(() => handler(send));
    },
    "chat.abort": (params, reply) => {
      reply({ ok: true, payload: { ok: true } });
      const runId = str(params.runId);
      const sessionKey = str(params.sessionKey) ?? "";
      if (!runId) return;
      // 중지된 런의 미해결 승인이 어떤 프레임으로 오는지는 미관측이다(스파이크 10.3) — 아무것도 보내지 않고
      // 서버 쪽 `cancelForRun` 에 맡긴다. 대본만 깨워 거기서 멈추게 한다
      dropApprovals((a) => a.runId === runId, {
        status: "cancelled",
        decision: "deny",
        reason: "run-aborted",
      });
      void gateway.chatAborted(runId, sessionKey, agentIdFromKey(sessionKey));
    },
    "chat.history": (params, reply) => {
      if (params.cursor !== undefined) {
        reply({ ok: true, payload: { kind: "reset" } });
        return;
      }
      const sessionKey = str(params.sessionKey) ?? "";
      reply({
        ok: true,
        payload: { sessionKey, sessionId: sessionIdFor(sessionKey), messages: [], completeSnapshot: true },
      });
    },
    "sessions.subscribe": (_params, reply) => reply({ ok: true, payload: { subscribed: true } }),
    "sessions.messages.subscribe": (_params, reply) => reply({ ok: true, payload: { subscribed: true } }),
    "sessions.list": (_params, reply) => reply({ ok: true, payload: { sessions: [] } }),
    "sessions.reset": (params, reply) => {
      if (!grantAdmin) {
        reply({ ok: false, error: MISSING_ADMIN_SCOPE });
        return;
      }
      const key = str(params.key) ?? "";
      reply({
        ok: true,
        payload: {
          ok: true,
          key,
          // 실물: sessionId 는 리셋 전후 같고 lifecycleRevision·sessionStartedAt 이 바뀐다(ADR 0003 3.4)
          entry: {
            sessionId: sessionIdFor(key),
            lifecycleRevision: randomUUID(),
            sessionStartedAt: Date.now(),
          },
        },
      });
    },
    "approval.resolve": (params, reply) => {
      const a = approvals.get(str(params.id) ?? "");
      if (!a) {
        reply({ ok: false, error: APPROVAL_NOT_FOUND });
        return;
      }
      // 이미 확정된 승인에 다시 보내도 오류가 아니다 — applied:false 로 그 스냅샷을 돌려준다(4.4)
      if (a.verdict) {
        reply({ ok: true, payload: resolveResult(a, a.verdict, false) });
        return;
      }
      const decision = str(params.decision) as ApprovalDecision | undefined;
      const resolvedAtMs = Date.now();
      // ⚠ 목록 밖 결정은 거절로 확정된다(4.4 fail-closed 함정). 서버가 먼저 막지만 실물 모양을 그대로 흉내 낸다
      const verdict: ApprovalVerdict =
        decision && a.allowedDecisions.includes(decision)
          ? {
              status: decision === "deny" ? "denied" : "allowed",
              decision,
              reason: "user",
              resolvedAtMs,
            }
          : { status: "denied", decision: "deny", reason: "malformed-verdict", resolvedAtMs };
      reply({ ok: true, payload: resolveResult(a, verdict, true) });
      // 응답을 클라이언트가 처리한 **뒤에** 이벤트를 낸다. 실물 순서(3.4)이기도 하고, 두 프레임이 한 청크로 뭉치면
      // 서버가 이벤트를 먼저 적용해 「누가 해결했는가」(decidedBy)가 비는 경주가 난다
      void gateway.flush().then(() => settleApproval(a, verdict, true));
    },

    "agents.list": (_params, reply) =>
      reply({
        ok: true,
        payload: {
          agents: [
            { id: "dev", name: "dev" },
            { id: "fin", name: "fin" },
          ],
        },
      }),
  };

  function onMessage(socket: WebSocket, raw: string) {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRequestFrame(frame)) return;
    requests.push(frame);
    const reply: Reply = (result) => {
      void write(socket, { type: "res", id: frame.id, ...result });
    };
    if (frame.method === "connect") {
      connected.add(socket);
      reply({ ok: true, payload: helloOk(frame.params, opts.serverVersion) });
      return;
    }
    if (frame.method === "sessions.messages.subscribe") {
      const key = str(record(frame.params).key);
      if (key !== undefined) {
        const keys = subscriptions.get(socket) ?? new Set<string>();
        keys.add(key);
        subscriptions.set(socket, keys);
      }
    }
    const handler = (methods as Record<string, (params: Record<string, unknown>, reply: Reply) => void>)[
      frame.method
    ];
    // 실물은 없는 메서드와 권한 부족을 구분하지 않는다(ADR 0001 4.4)
    if (!handler) reply({ ok: false, error: MISSING_ADMIN_SCOPE });
    else handler(record(frame.params), reply);
  }

  wss.on("connection", (socket) => {
    socket.on("message", (data) => onMessage(socket, data.toString()));
    socket.on("close", () => {
      connected.delete(socket);
      subscriptions.delete(socket);
    });
    // 실제 클라이언트는 이 챌린지의 nonce 를 서명해 connect 를 보낸다 — 없으면 connect 를 보내지 않고 타임아웃한다
    void write(socket, {
      type: "event",
      event: "connect.challenge",
      payload: { nonce: randomUUID(), ts: Date.now() },
    });
  });

  const gateway: FakeGateway = {
    url: `ws://127.0.0.1:${port}`,
    token: FAKE_GATEWAY_TOKEN,
    requests,
    onChatSend(handler) {
      chatSendHandler = handler;
    },
    emitEvent: (event, payload) => broadcast({ type: "event", event, payload, seq: nextSeq() }),
    lifecycleStart: (runId, sessionKey, agentId) =>
      broadcast(fixtures.lifecycleStart(common(runId, sessionKey, agentId))),
    chatDelta(runId, sessionKey, agentId, deltaText) {
      const snapshot = (deltaSnapshots.get(runId) ?? "") + deltaText;
      deltaSnapshots.set(runId, snapshot);
      return broadcast(fixtures.chatDelta(deltaText, { ...common(runId, sessionKey, agentId), snapshot }));
    },
    chatFinal(runId, sessionKey, agentId, text) {
      deltaSnapshots.delete(runId);
      return broadcast(fixtures.chatFinal(text, common(runId, sessionKey, agentId)));
    },
    chatError(runId, sessionKey, agentId, error = {}) {
      deltaSnapshots.delete(runId);
      return broadcast(fixtures.chatError({ ...common(runId, sessionKey, agentId), ...error }));
    },
    chatAborted(runId, sessionKey, agentId) {
      deltaSnapshots.delete(runId);
      return broadcast(fixtures.chatAborted(common(runId, sessionKey, agentId)));
    },
    toolStart(runId, sessionKey, agentId, tool) {
      toolStarts.set(tool.toolCallId, { name: tool.name, args: tool.args });
      return broadcast(
        fixtures.toolStart(tool.toolCallId, {
          ...common(runId, sessionKey, agentId),
          name: tool.name,
          args: tool.args,
        }),
      );
    },
    toolResult(runId, sessionKey, agentId, tool) {
      const started = toolStarts.get(tool.toolCallId);
      toolStarts.delete(tool.toolCallId);
      const frame = fixtures.toolResult(tool.toolCallId, {
        ...common(runId, sessionKey, agentId),
        result: tool.result,
        ...(tool.isError === undefined ? {} : { isError: tool.isError }),
      });
      // 픽스처의 result 프레임은 name·args 가 Bash 예시로 고정이다 — 이 툴의 값으로 바꾼다
      const payload = record(frame.payload);
      const data = {
        ...record(payload.data),
        name: tool.name ?? started?.name ?? "",
        args: tool.args ?? started?.args ?? {},
      };
      return broadcast({ ...frame, payload: { ...payload, data } });
    },
    sessionMessageUsage(runId, sessionKey) {
      const frame = fixtures.sessionMessage({ runId, seq: nextSeq() });
      // 픽스처는 세션 키가 고정이다 — 이 세션 것으로 바꾼다
      return broadcast({
        ...frame,
        payload: { ...record(frame.payload), sessionKey, sessionId: sessionIdFor(sessionKey) },
      });
    },
    requestApproval(runId, sessionKey, agentId, req) {
      const createdAtMs = Date.now();
      const state: ApprovalState = {
        ...req,
        id: req.approvalId ?? `plugin:${randomUUID()}`,
        runId,
        sessionKey,
        agentId,
        title: req.title ?? DEFAULT_APPROVAL_TITLE,
        toolName: req.toolName ?? DEFAULT_APPROVAL_TOOL,
        allowedDecisions: req.allowedDecisions ?? ["allow-once", "deny"],
        onTimeout: req.onTimeout ?? "gateway",
        settleFrameOrder: req.settleFrameOrder ?? "session-first",
        createdAtMs,
        expiresAtMs: createdAtMs + Math.max(0, req.ttlMs),
      };
      approvals.set(state.id, state);
      const outcome = new Promise<FakeApprovalOutcome>((resolve) => {
        state.wake = resolve;
      });
      state.timer = setTimeout(
        () => {
          void settleApproval(
            state,
            { status: "expired", decision: "deny", reason: "timeout", resolvedAtMs: Date.now() },
            state.onTimeout === "gateway",
          );
        },
        Math.max(0, req.ttlMs),
      );
      // 타이머가 프로세스를 붙잡지 않게 — 닫는 건 close()
      state.timer.unref();
      // 프레임 쓰기를 기다리지 않고 결말 프로미스를 돌려준다 — socket.send 는 여기서 이미 예약돼 순서가 지켜진다.
      // 실물은 같은 승인을 두 프레임으로 준다(⚠ 실측 p2-t6): 정본에는 `toolCallId` 가, 세션 스냅샷에는 `urlPath` 가 있다.
      // ⚠ 실물 관측은 **요구 짝도 세션이 먼저**다(3.5) — 여기는 아직 정본이 먼저다. 뒤집으면 타임라인 카드가
      // `toolCallId` 를 잃는다(첫 프레임에 없어서). 그 결정은 태스크 7·8 몫이다(p2-t6 fix2 보고서 4절)
      void broadcast(fixtures.pluginApprovalRequested({ ...approvalOpts(state), seq: nextSeq() }));
      void broadcast(fixtures.sessionApproval({ ...approvalOpts(state), seq: nextSeq() }));
      return outcome;
    },

    async flush() {
      await Promise.all([...connected].map(pingPong));
    },
    close() {
      clearInterval(tickTimer);
      // 기다리던 대본이 영원히 멈추지 않게 미해결 승인을 버린다(소켓이 곧 닫히므로 프레임은 보내지 않는다)
      dropApprovals(() => true, { status: "cancelled", decision: "deny", reason: "run-aborted" });
      closing ??= new Promise<void>((resolve) => {
        for (const socket of wss.clients) socket.terminate();
        connected.clear();
        wss.close(() => resolve());
      });
      return closing;
    },
  };
  return gateway;
}
