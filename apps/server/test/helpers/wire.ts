import { type ClientToServerEvents, type ServerToClientEvents, WIRE_PROTOCOL } from "@dodok/shared";
import { io, type Socket } from "socket.io-client";

export type WireClient = Socket<ServerToClientEvents, ClientToServerEvents>;
export type WirePayload<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>[0];

/** listen 중인 대상(App 또는 { url })에 소켓을 연다. 자동 재연결 없음 — connect_error 를 직접 볼 때 쓴다. */
export function openWire(target: { readonly url: string }, auth: Record<string, unknown>): WireClient {
  if (!target.url) throw new Error("listen 중이 아니다 — app.fastify.listen 을 먼저 부른다");
  return io(target.url, { auth, transports: ["websocket"], reconnection: false, forceNew: true });
}

/** 세션 토큰·현재 프로토콜로 접속하고 connect 를 기다린다. 닫는 건 호출자 몫. */
export function connectWire(target: { readonly url: string }, sessionToken: string): Promise<WireClient> {
  const socket = openWire(target, { token: sessionToken, protocol: WIRE_PROTOCOL });
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => {
      socket.close();
      reject(err);
    });
  });
}

/** pred 를 만족하는 서버 이벤트 하나를 기다린다. */
export function waitFor<E extends keyof ServerToClientEvents>(
  socket: WireClient,
  event: E,
  pred: (payload: WirePayload<E>) => boolean = () => true,
  timeoutMs = 2000,
): Promise<WirePayload<E>> {
  return new Promise((resolve, reject) => {
    const listener = (payload: WirePayload<E>) => {
      if (!pred(payload)) return;
      clearTimeout(timer);
      socket.off(event, listener as never);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(event, listener as never);
      reject(new Error(`wire ${event} 타임아웃`));
    }, timeoutMs);
    socket.on(event, listener as never);
  });
}

/** 받은 서버 이벤트를 도착 순서대로 모은다(없음을 단언할 때 — 같은 연결의 ack 왕복 뒤에 본다). */
export function recordEvents(
  socket: WireClient,
  events: (keyof ServerToClientEvents)[],
): { event: keyof ServerToClientEvents; payload: unknown }[] {
  const seen: { event: keyof ServerToClientEvents; payload: unknown }[] = [];
  for (const event of events)
    socket.on(event, ((payload: unknown) => seen.push({ event, payload })) as never);
  return seen;
}
