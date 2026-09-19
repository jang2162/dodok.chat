import {
  type ClientToServerEvents,
  type ErrorCode,
  type Result,
  type ServerToClientEvents,
  WIRE_PROTOCOL,
} from "@dodok/shared";
import { io, type Socket } from "socket.io-client";
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
  return io({
    path: "/socket.io",
    transports: ["websocket"],
    withCredentials: true,
    autoConnect: false,
    auth: { protocol: WIRE_PROTOCOL },
  });
}

export class WireAckError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
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

/** ack 을 기다린다. `ok:false` 는 그 code 의 WireAckError, 응답이 없으면(시간 초과·끊김) code `TIMEOUT` */
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
  if (!res.ok) throw new WireAckError(res.error.code, res.error.message);
  return res.data;
}
