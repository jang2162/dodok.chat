/**
 * 가짜 OpenClaw Gateway — 실제 `@openclaw/gateway-client`(어댑터의 `connectGateway`)가 붙는 ws 서버. 네트워크 없이 서버 전체를 돌리는 하네스.
 *
 * 핸드셰이크는 실물 순서(ADR 0001): 접속 즉시 `connect.challenge` → `req connect` → `res hello-ok`. 서명·토큰은 검증하지 않는다.
 * 요청은 응답 표(서버 코어 태스크 13)대로 답하고, 모르는 메서드는 실물처럼 FORBIDDEN/MISSING_SCOPE 로 거절한다(ADR 0001 4.4).
 * 이벤트 페이로드는 태스크 10 픽스처 팩토리로 만든다 — 어댑터 매퍼 테스트와 같은 모양이다.
 */
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

export type FakeGatewayOptions = {
  /** false 면 `sessions.reset` 이 FORBIDDEN/MISSING_SCOPE(operator.admin 없음). 기본 true */
  grantAdmin?: boolean;
};

export type FakeGateway = {
  readonly url: string;
  readonly token: string;
  /** 받은 요청 전부(connect 포함), 도착 순서 */
  readonly requests: RequestFrame[];
  /** `chat.send` 응답을 보낸 뒤 부른다. 다시 부르면 교체. handler 의 reject 는 잡지 않는다 — 처리되지 않은 reject 로 테스트를 깨뜨린다 */
  onChatSend(handler: (params: ChatSendParams) => void | Promise<void>): void;
  /** 연결된(hello 를 받은) 모든 클라이언트에 이벤트 프레임을 보낸다. 쓰기가 끝나면 resolve */
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
  /** 열린 연결을 모두 끊고 포트를 닫는다. 두 번 불러도 된다 */
  close(): Promise<void>;
};

export const FAKE_GATEWAY_TOKEN = "fake-gateway-token";

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
] as const;
export const FAKE_GATEWAY_EVENTS = ["chat", "agent", "session.message", "sessions.changed"] as const;

const MISSING_ADMIN_SCOPE = {
  code: "FORBIDDEN",
  message: "missing scope",
  details: { code: "MISSING_SCOPE", missingScope: "operator.admin", requiredScopes: ["operator.admin"] },
};

type Reply = (
  result: { ok: true; payload: unknown } | { ok: false; error: typeof MISSING_ADMIN_SCOPE },
) => void;

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
function helloOk(connectParams: unknown): HelloOk {
  const params = record(connectParams);
  const scopes = Array.isArray(params.scopes) ? params.scopes.filter((s) => typeof s === "string") : [];
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.9.4", connId: randomUUID() },
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
  const sessionIds = new Map<string, string>();
  const deltaSnapshots = new Map<string, string>();
  const toolStarts = new Map<string, { name: string; args: Record<string, unknown> }>();
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

  async function broadcast(frame: EventFrame): Promise<void> {
    await Promise.all([...connected].map((socket) => write(socket, frame)));
  }

  const nextSeq = () => ++seq;
  const common = (runId: string, sessionKey: string, agentId: string) => ({
    runId,
    sessionKey,
    agentId,
    seq: nextSeq(),
  });

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
      if (runId) void gateway.chatAborted(runId, sessionKey, agentIdFromKey(sessionKey));
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
      reply({ ok: true, payload: helloOk(frame.params) });
      return;
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
    socket.on("close", () => connected.delete(socket));
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
    close() {
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
