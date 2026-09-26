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
  // 승인은 워크스페이스 룸으로 — 다른 채널을 보고 있어도 카드·알림이 닿아야 한다(판정 7, events.ts)
  "approval.requested": Payload<"approval.requested">;
  "approval.resolved": Payload<"approval.resolved">;
  "channel.created": Payload<"channel.created">;
  "channel.updated": Payload<"channel.updated">;
  "channel.member.changed": Payload<"channel.member.changed">;
  // 사람 목록 — 워크스페이스 방으로(가입·역할·표시 이름·내보내기 뒤, members/people.ts broadcastPeople)
  "people.changed": Payload<"people.changed">;
  typing: Payload<"typing">;
  "adapter.status": Payload<"adapter.status">;
  "system.notice": Payload<"system.notice">;
  // 연결 상태(설정 마법사) — owner 사용자 룸에만 간다(events.ts)
  "setup.status": Payload<"setup.status">;
  // 운영 사건 — setup.status 와 같은 owner 사용자 룸으로
  "ops.event": Payload<"ops.event">;
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
