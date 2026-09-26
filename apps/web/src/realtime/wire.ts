import {
  type ClientToServerEvents,
  type ErrorCode,
  type Result,
  type ServerToClientEvents,
  WIRE_PROTOCOL,
} from "@dodok/shared";
import { Manager, type Socket } from "socket.io-client";
import { create } from "zustand";

export type WireSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * wire 연결 상태(스펙 4.2·6.5). `protocol_mismatch` 와 `rejected` 는 재연결을 멈춘 상태다 —
 * `rejected` 는 REST 세션은 살아 있는데 wire 가 `UNAUTHORIZED`(핸드셰이크 Origin ≠ APP_ORIGIN 등)인 경우.
 */
export type WireStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "protocol_mismatch"
  | "rejected";

export const useWireStatus = create<{ status: WireStatus; setStatus(s: WireStatus): void }>()((set) => ({
  status: "idle",
  setStatus: (status) => set({ status }),
}));

/**
 * 토큰을 싣지 않는다 — 서버가 같은 출처 쿠키로 인증한다(스펙 9.1). 쿠키 경로는 핸드셰이크 Origin 을 보는데
 * polling 의 첫 GET 에는 Origin 이 없으므로 websocket 전송만 쓴다.
 */
export function createWireSocket(): WireSocket {
  const manager = new WireManager({
    path: "/socket.io",
    transports: ["websocket"],
    withCredentials: true,
    autoConnect: false,
  });
  return manager.socket("/", { auth: { protocol: WIRE_PROTOCOL } });
}

/**
 * 다시 붙기가 핸드셰이크 전에 **깨끗이** 닫히면(close 프레임만, error 없음) socket.io Manager 는 그 시도를 실패로 보지
 * 않는다 — 열리는 동안 engine 의 error 만 듣기 때문이다. 그러면 연결 제한시간(`timeout`, 20초)이 지나서야 다음 시도로
 * 가고 그동안 아무것도 받지 못한다(p4t-c1 결함 1). 그 close 를 error 로 알려 Manager 의 백오프가 곧바로 다음 시도를
 * 잡게 한다. 연결 거부·비정상 종료는 원래 error 가 먼저 온다
 */
export class WireManager extends Manager {
  override open(fn?: (err?: Error) => void): this {
    super.open(fn);
    failOnEarlyClose(this.engine);
    return this;
  }
}

const watched = new WeakSet<Manager["engine"]>();

function failOnEarlyClose(engine: Manager["engine"]): void {
  // 이미 열렸거나(super.open 이 아무것도 안 했다) 보고 있는 엔진
  if (engine.readyState !== "opening" || watched.has(engine)) return;
  watched.add(engine);
  const stop = () => {
    engine.off("open", stop);
    engine.off("error", stop);
    engine.off("close", onClose);
  };
  const onClose = (reason: string) => {
    stop();
    // 제한시간·disconnect() 가 닫은 것(forced close)은 Manager 가 먼저 듣기를 거둬 이 알림이 닿지 않는다.
    // Manager 가 듣는 자리(열리는 동안의 engine error)로 알린다 — emitReserved 는 protected 라 한 번 캐스트한다
    (engine as unknown as { emitReserved(e: "error", err: Error): void }).emitReserved(
      "error",
      new Error(`${reason} before handshake`),
    );
  };
  engine.on("open", stop);
  engine.on("error", stop);
  engine.on("close", onClose);
}

export class WireAckError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** 서버 ApiError.details(`VALIDATION` 의 `issues` 등) — wire 에서 온 외부 입력이라 쓰는 쪽이 Zod 로 파싱한다 */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WireAckError";
  }
}

/** ack 이 있는 클라이언트 → 서버 이벤트의 payload·응답 data 타입 */
export type AckEvents = {
  [E in keyof ClientToServerEvents]: Parameters<ClientToServerEvents[E]> extends [
    infer P,
    (res: Result<infer D>) => void,
  ]
    ? { payload: P; data: D }
    : never;
};
export type AckEvent = { [E in keyof AckEvents]: AckEvents[E] extends never ? never : E }[keyof AckEvents];

/** ack 을 기다린다. `ok:false` 는 그 code·details 의 WireAckError, 응답이 없으면(시간 초과·끊김) code `TIMEOUT` */
export async function emitAck<E extends AckEvent>(
  socket: Pick<WireSocket, "timeout">,
  event: E,
  payload: AckEvents[E]["payload"],
  timeoutMs = 10_000,
): Promise<AckEvents[E]["data"]> {
  let res: Result<AckEvents[E]["data"]>;
  try {
    // socket.io 의 제네릭 이벤트 타입이 여기서 좁혀지지 않아 한 번 캐스트한다(런타임 모양은 같다)
    const timed = socket.timeout(timeoutMs) as unknown as {
      emitWithAck(e: string, p: unknown): Promise<unknown>;
    };
    res = (await timed.emitWithAck(event, payload)) as Result<AckEvents[E]["data"]>;
  } catch {
    throw new WireAckError("TIMEOUT", `${event} 응답이 없습니다`);
  }
  if (!res.ok) throw new WireAckError(res.error.code, res.error.message, res.error.details);
  return res.data;
}
