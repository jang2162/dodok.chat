import type { Id, RunEvent, ServerToClientEvents } from "@dodok/shared";
import { EventEmitter } from "node:events";

type Payload<K extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[K]>[0];

/**
 * 모듈 간 통지 이벤트. DB 쓰기 → bus emit → realtime 팬아웃.
 * 페이로드는 wire ServerToClientEvents(계약 스펙 7.2) 와 같고, run.event 만 룸을 고르도록 channelId 를 더 싣는다.
 */
export type BusEvents = {
  "message.created": Payload<"message.created">;
  "message.updated": Payload<"message.updated">;
  "run.state": Payload<"run.state">;
  "run.event": { event: RunEvent; channelId: Id };
  "channel.updated": Payload<"channel.updated">;
  "channel.member.changed": Payload<"channel.member.changed">;
  typing: Payload<"typing">;
  "adapter.status": Payload<"adapter.status">;
  "system.notice": Payload<"system.notice">;
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
