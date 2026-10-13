/**
 * 가짜 dodok 채널 플러그인 — 실제 `attachBridge`(`/bridge` 네임스페이스)에 socket.io-client 로 붙는다.
 *
 * 실제 플러그인(`packages/openclaw-plugin/src/bridge-client.ts`)과 같은 순서·모양: 토큰 handshake → `hello`(BridgeHello) ack →
 * `inbound.deliver`·`config.set` 은 계약 스키마로 파싱해 틀리면 VALIDATION 으로 ack. Gateway 쪽 런은 흉내 내지 않는다(시나리오가 한다).
 */
import {
  Attachment,
  BRIDGE_ATTACHMENT_HEADERS,
  BRIDGE_ATTACHMENTS_PATH,
  type BridgeClientToServerEvents,
  BridgeHello,
  BridgeHelloResult,
  type BridgeControlCall,
  type BridgeServerToClientEvents,
  type ControlResult,
  ConfigSet,
  InboundDeliver,
  type InboundDeliverResult,
  type OutboundMessage,
  type Result,
} from "@dodok/shared";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";

export type InboundHandler = (
  delivery: InboundDeliver,
) => InboundDeliverResult | Promise<InboundDeliverResult>;

export type FakePluginOptions = {
  /** 서버 주소(`http://127.0.0.1:<port>`). `/bridge` 는 붙여서 접속한다 */
  bridgeUrl: string;
  token: string;
  /** 기본은 dispatch(`providerRunId` = 우리 runId, ADR 0002 4.3) */
  onInbound?: InboundHandler;
  /** 기본 FAKE_PLUGIN_HELLO — 옛 플러그인(스레드 모름)을 흉내 낼 때 capabilities 를 바꿔 준다 */
  hello?: BridgeHello;
  /** 브리지 `agents.list` 의 답(기본 FAKE_PLUGIN_AGENTS) — 짝인 가짜 Gateway 의 에이전트와 맞출 때 */
  agents?: Array<{ agentId: string; name?: string }>;
};

export type OutboundInput = Omit<OutboundMessage, "outboundId" | "ts"> &
  Partial<Pick<OutboundMessage, "outboundId" | "ts">>;

export type BridgeNotice = Parameters<BridgeServerToClientEvents["system.notice"]>[0];

export type FakePlugin = {
  /** 바꿔 끼울 수 있다 — 호출 시점의 값을 쓴다 */
  onInbound: InboundHandler;
  /** 스키마를 통과한 `inbound.deliver`, 도착 순서 */
  readonly received: InboundDeliver[];
  readonly configSets: ConfigSet[];
  readonly notices: BridgeNotice[];
  /** 마지막 hello ack */
  readonly helloResult: BridgeHelloResult | undefined;
  /** `outbound.message` 를 보내고 서버가 준 messageId 를 돌려준다. outboundId(uuid)·ts(now)는 없으면 채운다 */
  sendOutbound(message: OutboundInput): Promise<{ messageId: string }>;
  /** `control.call` 을 보내고 ack 를 기다린다 — 확인 카드를 기다리는 동안 늦게 온다. callId 는 없으면 채운다 */
  control(call: Omit<BridgeControlCall, "callId"> & { callId?: string }): Promise<ControlResult>;
  /** 브리지 HTTP 로 첨부를 올린다(실제 플러그인 `uploadMedia` 와 같은 헤더). 2xx 가 아니면 상태·본문을 싣고 던진다 */
  uploadAttachment(input: {
    channelId: string;
    bytes: Uint8Array;
    name?: string;
    mime?: string;
  }): Promise<Attachment>;
  /** 브리지 HTTP 로 첨부 바이트를 받는다 — 상태를 그대로 돌려준다(404·401 을 잴 때) */
  downloadAttachment(
    id: string,
    opts?: { token?: string },
  ): Promise<{ status: number; bytes: Buffer; headers: Headers }>;
  /** 소켓만 끊는다. 서버가 끊김을 알아채는 것은 비동기다 */
  disconnect(): void;
  /**
   * 다시 접속해 hello ack 까지 기다린다. `token` 을 주면 붙어 있던 소켓을 먼저 끊고, 그 뒤로는 핸드셰이크·첨부 HTTP 가
   * 그 토큰을 쓴다(거절돼도 바뀐 채로). `hello` 를 주면 붙어 있던 소켓을 먼저 끊고 그 hello 로 붙는다(플러그인 재설치)
   */
  reconnect(opts?: { token?: string; hello?: BridgeHello }): Promise<void>;
  /** 끊고 리스너를 떼어낸다 — 그 뒤에는 reconnect 할 수 없다 */
  close(): void;
};

/** 실제 플러그인 hello 와 같은 필드(`channel.ts` startAccount). 가짜는 agents.list·typing 도 답하므로 capabilities 를 모두 선언한다. */
export const FAKE_PLUGIN_HELLO: BridgeHello = BridgeHello.parse({
  pluginId: "dodok",
  version: "0.0.0-fake",
  sdkVersion: "2026.9.4",
  gatewayVersion: "2026.9.4",
  capabilities: ["agents.list", "config.set", "typing", "run_id_in_outbound", "threads"],
});

export const FAKE_PLUGIN_AGENTS = [{ agentId: "dev", name: "dev" }, { agentId: "fin" }];

const ACK_TIMEOUT_MS = 10_000;

type BridgeClientSocket = Socket<BridgeServerToClientEvents, BridgeClientToServerEvents>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function issuesText(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.map(String).join(".")} ${i.message}`).join("; ");
}

export async function startFakePlugin(opts: FakePluginOptions): Promise<FakePlugin> {
  /** 핸드셰이크·첨부 HTTP 가 쓰는 토큰 — reconnect({ token }) 이 바꾼다 */
  let token = opts.token;
  /** hello 페이로드 — reconnect({ hello }) 가 바꾼다 */
  let hello = opts.hello ?? FAKE_PLUGIN_HELLO;
  const socket: BridgeClientSocket = io(`${opts.bridgeUrl}/bridge`, {
    auth: { token },
    transports: ["websocket"],
    autoConnect: false,
    reconnection: false, // 실제 플러그인도 재연결을 직접 한다 — 가짜는 reconnect() 로만
    forceNew: true, // 한 프로세스의 여러 가짜 플러그인이 Manager 를 공유하지 않게
  });
  const received: InboundDeliver[] = [];
  const configSets: ConfigSet[] = [];
  const notices: BridgeNotice[] = [];
  let helloResult: BridgeHelloResult | undefined;
  let closed = false;

  function connectAndHello(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        socket.off("connect_error", onError);
        (socket.timeout(ACK_TIMEOUT_MS).emitWithAck("hello", hello) as Promise<Result<unknown>>)
          .then((res) => {
            if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
            helloResult = BridgeHelloResult.parse(res.data);
            resolve();
          })
          .catch((error: unknown) => {
            socket.disconnect();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      };
      const onError = (error: Error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("connect_error", onError);
      socket.connect();
    });
  }

  socket.on("inbound.deliver", (payload, ack) => {
    const parsed = InboundDeliver.safeParse(payload);
    if (!parsed.success) {
      ack({ ok: false, error: { code: "VALIDATION", message: issuesText(parsed.error) } });
      return;
    }
    received.push(parsed.data);
    Promise.resolve()
      .then(() => plugin.onInbound(parsed.data))
      .then(
        (data) => ack({ ok: true, data }),
        (error: unknown) => ack({ ok: false, error: { code: "INTERNAL", message: errorMessage(error) } }),
      );
  });

  socket.on("config.set", (payload, ack) => {
    const parsed = ConfigSet.safeParse(payload);
    if (!parsed.success) {
      ack({ ok: false, error: { code: "VALIDATION", message: issuesText(parsed.error) } });
      return;
    }
    configSets.push(parsed.data);
    ack({ ok: true, data: { applied: "live" } });
  });

  socket.on("agents.list", (_payload, ack) => {
    ack({ ok: true, data: { agents: opts.agents ?? FAKE_PLUGIN_AGENTS } });
  });

  socket.on("system.notice", (notice) => {
    notices.push(notice);
  });

  const plugin: FakePlugin = {
    onInbound: opts.onInbound ?? ((delivery) => ({ admission: "dispatch", providerRunId: delivery.runId })),
    received,
    configSets,
    notices,
    get helloResult() {
      return helloResult;
    },
    async sendOutbound(message) {
      const payload: OutboundMessage = {
        ...message,
        outboundId: message.outboundId ?? randomUUID(),
        ts: message.ts ?? new Date().toISOString(),
      };
      const res = (await socket.timeout(ACK_TIMEOUT_MS).emitWithAck("outbound.message", payload)) as Result<{
        messageId: string;
      }>;
      if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
      return res.data;
    },
    async control(call) {
      return (await socket.emitWithAck("control.call", {
        ...call,
        callId: call.callId ?? randomUUID(),
      })) as ControlResult;
    },
    async uploadAttachment({ channelId, bytes, name, mime }) {
      const res = await fetch(`${opts.bridgeUrl}${BRIDGE_ATTACHMENTS_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          [BRIDGE_ATTACHMENT_HEADERS.channelId]: channelId,
          ...(name === undefined ? {} : { [BRIDGE_ATTACHMENT_HEADERS.fileName]: encodeURIComponent(name) }),
          "content-type": mime ?? "application/octet-stream",
        },
        body: bytes,
      });
      if (!res.ok) throw new Error(`fake upload ${res.status}: ${await res.text()}`);
      return Attachment.parse(await res.json());
    },
    async downloadAttachment(id, over = {}) {
      const res = await fetch(`${opts.bridgeUrl}${BRIDGE_ATTACHMENTS_PATH}/${id}`, {
        headers: { authorization: `Bearer ${over.token ?? token}` },
      });
      return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    },
    disconnect() {
      socket.disconnect();
    },
    reconnect(over = {}) {
      if (closed) return Promise.reject(new Error("fake plugin closed"));
      if (over.token !== undefined || over.hello !== undefined) socket.disconnect();
      if (over.token !== undefined) {
        token = over.token;
        socket.auth = { token };
      }
      if (over.hello !== undefined) hello = over.hello;
      return connectAndHello();
    },
    close() {
      closed = true;
      socket.disconnect();
      socket.removeAllListeners();
    },
  };

  try {
    await connectAndHello();
  } catch (error) {
    socket.close();
    throw error;
  }
  return plugin;
}
