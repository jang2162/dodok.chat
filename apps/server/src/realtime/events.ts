import type { RunEvent, RunState } from "@dodok/shared";
import type { Logger } from "../logger";
import { TERMINAL_STATUSES } from "../modules/runs/machine";
import type { BusEvents, ServerBus } from "./bus";
import { channelRoom, workspaceRoom } from "./socket";
import type { WireServer, WireSocket } from "./types";

/** 소켓별 미전송 큐 상한(계약 스펙 7.3, 서버 코어 제약 「소켓 미전송 큐 상한 500 이벤트」) */
export const WIRE_MAX_PENDING = 500;

export type WireFanoutOptions = { logger: Logger; maxPending?: number | undefined };

/**
 * bus → Socket.IO 팬아웃. 채널 이벤트는 channel:<id> 룸, adapter.status·system.notice 는 전체(단일 사용자 MVP).
 * run.event 만 백프레셔를 본다: 소켓의 미전송 큐가 maxPending 이상이면 그 소켓엔 델타를 버리고
 * 런별로 한 번 run.state { resync: true } 를 보낸다. 큐가 풀리면 다시 델타를 보내고, 다음 막힘에 또 resync 한다.
 */
export function attachWireFanout(io: WireServer, bus: ServerBus, opts: WireFanoutOptions): { close(): void } {
  const maxPending = opts.maxPending ?? WIRE_MAX_PENDING;
  /** runId → bus 가 마지막으로 본 RunState (종료되면 지운다) */
  const lastState = new Map<string, RunState>();
  /** runId → 이번 막힘에서 이미 resync 를 받은 socket id */
  const resynced = new Map<string, Set<string>>();

  const fanoutRunEvent = (event: RunEvent, channelId: string): void => {
    const room = channelRoom(channelId);
    const members = io.sockets.adapter.rooms.get(room);
    if (!members) return;
    const congested: WireSocket[] = [];
    for (const id of members) {
      const socket = io.sockets.sockets.get(id);
      if (!socket) continue;
      if (pendingPackets(socket) >= maxPending) congested.push(socket);
      else resynced.get(event.runId)?.delete(id);
    }
    if (congested.length === 0) {
      io.to(room).emit("run.event", { event });
      return;
    }
    io.to(room)
      .except(congested.map((socket) => socket.id))
      .emit("run.event", { event });
    let sent = resynced.get(event.runId);
    if (!sent) {
      sent = new Set();
      resynced.set(event.runId, sent);
    }
    for (const socket of congested) {
      if (sent.has(socket.id)) continue;
      sent.add(socket.id);
      const run = lastState.get(event.runId);
      if (!run) {
        opts.logger.warn(
          { runId: event.runId, socketId: socket.id },
          "run.event dropped without known run.state",
        );
        continue;
      }
      socket.emit("run.state", { run, resync: true });
    }
  };

  // 팬아웃 예외가 bus.emit 을 부른 쓰기 경로(서비스·오케스트레이터)로 번지지 않게 가둔다
  const on = <K extends keyof BusEvents>(event: K, handler: (payload: BusEvents[K]) => void) =>
    bus.on(event, (payload) => {
      try {
        handler(payload);
      } catch (err) {
        opts.logger.error({ err, event }, "wire fanout failed");
      }
    });

  const offs = [
    on("message.created", (p) => io.to(channelRoom(p.message.channelId)).emit("message.created", p)),
    on("message.updated", (p) => io.to(channelRoom(p.message.channelId)).emit("message.updated", p)),
    on("run.state", (p) => {
      if (TERMINAL_STATUSES.has(p.run.status)) {
        lastState.delete(p.run.id);
        resynced.delete(p.run.id);
      } else {
        lastState.set(p.run.id, p.run);
      }
      io.to(channelRoom(p.run.channelId)).emit("run.state", p);
    }),
    on("run.event", ({ event, channelId }) => fanoutRunEvent(event, channelId)),
    on("channel.created", (p) => io.to(workspaceRoom(p.channel.workspaceId)).emit("channel.created", p)),
    on("channel.updated", (p) => io.to(channelRoom(p.channel.id)).emit("channel.updated", p)),
    on("channel.member.changed", (p) => io.to(channelRoom(p.channelId)).emit("channel.member.changed", p)),
    on("typing", (p) => io.to(channelRoom(p.channelId)).emit("typing", p)),
    on("adapter.status", (p) => io.emit("adapter.status", p)),
    on("system.notice", (p) => io.emit("system.notice", p)),
  ];

  return {
    close() {
      for (const off of offs) off();
      lastState.clear();
      resynced.clear();
    },
  };
}

/**
 * engine.io Socket 의 writeBuffer — transport 가 쓰기 가능해지길 기다리는 패킷 수.
 * 타입 선언상 private 이라 캐스팅한다(engine.io 6.6.10 실측). 없어지면 0 — 백프레셔 테스트(wire.test f)가 깨져 알린다.
 */
function pendingPackets(socket: WireSocket): number {
  const { writeBuffer } = socket.conn as unknown as { writeBuffer?: unknown };
  return Array.isArray(writeBuffer) ? writeBuffer.length : 0;
}
