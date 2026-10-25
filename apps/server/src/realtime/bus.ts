import type { Id, RunEvent, ServerToClientEvents } from "@dodok/shared";
import { EventEmitter } from "node:events";

type Payload<K extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[K]>[0];

/**
 * 모듈 간 통지 이벤트. DB 쓰기 → bus emit → realtime 팬아웃.
 * 페이로드는 wire ServerToClientEvents(계약 스펙 7.2) 와 같고, 룸을 고르려고 run.event 는 channelId 를, channel.read 는 userId 를 더 싣는다.
 */
export type BusEvents = {
  // silent — 서버 안에서만(팬아웃이 걷는다): 푸시 트리거가 건너뛴다. 연결을 닫으며 끝낸 런에 늦게 온 정본(runs/orchestrator.ts onCanonical)
  "message.created": Payload<"message.created"> & { silent?: true };
  "message.updated": Payload<"message.updated">;
  "run.state": Payload<"run.state">;
  "run.event": { event: RunEvent; channelId: Id };
  // 승인은 워크스페이스 룸으로 — 다른 채널을 보고 있어도 카드·알림이 닿아야 한다(판정 7, events.ts)
  "approval.requested": Payload<"approval.requested">;
  "approval.resolved": Payload<"approval.resolved">;
  "channel.created": Payload<"channel.created">;
  "channel.updated": Payload<"channel.updated">;
  "channel.member.changed": Payload<"channel.member.changed">;
  // 세션 만들기·제목·닫기·다시 열기 — 그 채널 룸으로(events.ts)
  "conversation.created": Payload<"conversation.created">;
  "conversation.updated": Payload<"conversation.updated">;
  // 사람 목록 — 워크스페이스 방으로(가입·역할·표시 이름·비활성화·다시 활성화 뒤, members/people.ts broadcastPeople)
  "people.changed": Payload<"people.changed">;
  // 에이전트가 바뀌었다(등록·수정·옮기기·보관·되살리기) — 워크스페이스 방으로, 본문 없음(agents/routes.ts)
  "agents.changed": Payload<"agents.changed">;
  // 사용자 한 명의 읽음 위치가 올랐다 — 그 사용자의 user 룸으로(다른 기기·탭이 맞춘다, events.ts). userId 는 팬아웃이 룸을 고르는 데만 쓴다
  "channel.read": Payload<"channel.read"> & { userId: Id };
  typing: Payload<"typing">;
  "adapter.status": Payload<"adapter.status">;
  "system.notice": Payload<"system.notice">;
  // 연결 상태(설정 마법사) — owner 사용자 룸에만 간다(events.ts)
  "setup.status": Payload<"setup.status">;
  // 운영 사건 — owner·admin 사용자 룸으로(events.ts)
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
