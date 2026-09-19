import type { Result } from "@dodok/shared";
import type { WireSocket } from "@/realtime/wire";

type Handler = (...args: unknown[]) => void;
type AckScript = (payload: unknown) => Result<unknown> | Promise<Result<unknown>>;

/**
 * socket.io-client 의 쓰는 부분만: on/off/emit/timeout().emitWithAck/connect/disconnect, 서버 이벤트 흘리기.
 * ack 을 대본에 적지 않은 이벤트의 emitWithAck 는 throw 한다(= 시간 초과).
 */
export function createFakeSocket() {
  const handlers = new Map<string, Set<Handler>>();
  const acks = new Map<string, AckScript>();
  const sent: Array<{ event: string; payload: unknown }> = [];
  const timeouts: number[] = [];
  const calls = { connect: 0, disconnect: 0 };
  const socket = {
    connected: false,
    /** 자동 재연결 대상인가(socket.io 의 active) — connect() 뒤 참, disconnect() 뒤 거짓 */
    active: false,
    on(event: string, fn: Handler) {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(fn);
      handlers.set(event, set);
      return socket;
    },
    off(event: string, fn: Handler) {
      handlers.get(event)?.delete(fn);
      return socket;
    },
    emit(event: string, payload: unknown) {
      sent.push({ event, payload });
      return socket;
    },
    timeout(ms: number) {
      timeouts.push(ms);
      return {
        emitWithAck: async (event: string, payload: unknown) => {
          sent.push({ event, payload });
          const fn = acks.get(event);
          if (!fn) throw new Error(`no ack scripted for ${event}`);
          return fn(payload);
        },
      };
    },
    connect() {
      calls.connect += 1;
      socket.active = true;
      return socket;
    },
    disconnect() {
      calls.disconnect += 1;
      socket.connected = false;
      socket.active = false;
      return socket;
    },
  };
  return {
    socket,
    /** 실시간 계층 함수에 넘길 때 — 런타임 모양은 위의 부분 집합이다 */
    wire: socket as unknown as WireSocket,
    sent,
    timeouts,
    calls,
    /** 보낸 것 중 이 이벤트의 payload 들 */
    sentOf: (event: string) => sent.filter((s) => s.event === event).map((s) => s.payload),
    onAck(event: string, fn: AckScript) {
      acks.set(event, fn);
    },
    serverEmit(event: string, ...args: unknown[]) {
      for (const fn of handlers.get(event) ?? []) fn(...args);
    },
    /** 붙어 있는 리스너 수(해제 확인용) */
    listenerCount: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

export type FakeSocket = ReturnType<typeof createFakeSocket>;

/**
 * `test/setup.ts` 가 `createWireSocket` 을 목으로 바꿔 만든 가짜 소켓들(만든 순, 테스트마다 비운다).
 * 테스트는 실제 소켓을 열지 않는다 — 앱을 띄운 테스트는 여기서 꺼내 서버 이벤트를 흘린다
 */
export const createdSockets: FakeSocket[] = [];
