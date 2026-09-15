import { EventEmitter } from "node:events";

/** 모듈 간 통지 이벤트. DB 쓰기 → bus emit → realtime 팬아웃(태스크 4·5 가 넓힌다). */
export type BusEvents = {
  "system.notice": { level: "info" | "warn" | "error"; message: string };
};

/** 프로세스 안 타입드 이벤트 버스. 모듈은 Socket.IO 를 직접 만지지 않고 여기로 알린다. */
export class ServerBus {
  readonly #emitter = new EventEmitter();

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.#emitter.emit(event, payload);
  }

  /** 해제 함수를 돌려준다. */
  on<K extends keyof BusEvents>(event: K, handler: (payload: BusEvents[K]) => void): () => void {
    this.#emitter.on(event, handler);
    return () => {
      this.#emitter.off(event, handler);
    };
  }
}
