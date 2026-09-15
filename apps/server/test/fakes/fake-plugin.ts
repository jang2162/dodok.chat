/**
 * 가짜 dodok 채널 플러그인 — 실제 `attachBridge`(`/bridge` 네임스페이스)에 socket.io-client 로 붙는다.
 *
 * 실제 플러그인(`packages/openclaw-plugin/src/bridge-client.ts`)과 같은 순서·모양: 토큰 handshake → `hello`(BridgeHello) ack →
 * `inbound.deliver`·`config.set` 은 계약 스키마로 파싱해 틀리면 VALIDATION 으로 ack. Gateway 쪽 런은 흉내 내지 않는다(시나리오가 한다).
 */
import {
  type BridgeClientToServerEvents,
  BridgeHello,
  BridgeHelloResult,
  type BridgeServerToClientEvents,
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
  /** 소켓만 끊는다. 서버가 끊김을 알아채는 것은 비동기다 */
  disconnect(): void;
  /** 다시 접속해 hello ack 까지 기다린다 */
  reconnect(): Promise<void>;
  /** 끊고 리스너를 떼어낸다 — 그 뒤에는 reconnect 할 수 없다 */
  close(): void;
};

/** 실제 플러그인 hello 와 같은 필드(`channel.ts` startAccount). 가짜는 agents.list·typing 도 답하므로 capabilities 를 모두 선언한다. */
export const FAKE_PLUGIN_HELLO: BridgeHello = BridgeHello.parse({
  pluginId: "dodok",
  version: "0.0.0-fake",
  sdkVersion: "2026.9.4",
  gatewayVersion: "2026.9.4",
  capabilities: ["agents.list", "config.set", "typing", "run_id_in_outbound"],
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
  const socket: BridgeClientSocket = io(`${opts.bridgeUrl}/bridge`, {
    auth: { token: opts.token },
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
        (socket.timeout(ACK_TIMEOUT_MS).emitWithAck("hello", FAKE_PLUGIN_HELLO) as Promise<Result<unknown>>)
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
    ack({ ok: true, data: { agents: FAKE_PLUGIN_AGENTS } });
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
    disconnect() {
      socket.disconnect();
    },
    reconnect() {
      if (closed) return Promise.reject(new Error("fake plugin closed"));
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
