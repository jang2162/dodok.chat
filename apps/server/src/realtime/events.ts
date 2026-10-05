import type { Message, RunEvent, RunState, TeamRole } from "@dodok/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { memberships } from "../db/schema.sqlite";
import type { Logger } from "../logger";
import { hydrateForClient, withInteractions } from "../modules/messages/service";
import { TERMINAL_STATUSES } from "../modules/runs/machine";
import type { BusEvents, ServerBus } from "./bus";
import { channelRoom, userRoom, workspaceRoom } from "./socket";
import type { WireServer, WireSocket } from "./types";

/** 소켓별 미전송 큐 상한(계약 스펙 7.3, 서버 코어 제약 「소켓 미전송 큐 상한 500 이벤트」) */
export const WIRE_MAX_PENDING = 500;

export type WireFanoutOptions = {
  logger: Logger;
  /** message.created·updated 를 내보내기 직전 상호작용 기록을 붙일 때 읽는다(설계 4.2) */
  db: Db;
  /** 승인 팬아웃의 룸(`workspace:<id>`) — 서버가 섬기는 그 워크스페이스, attachWire 의 `ctx.workspaceId` 와 같은 값 */
  workspaceId: string;
  maxPending?: number | undefined;
};

/**
 * bus → Socket.IO 팬아웃. 채널 이벤트는 channel:<id> 룸, 승인 둘·people.changed·agents.changed 는 workspace:<id> 룸,
 * adapter.status·system.notice 는 전체(단일 사용자 MVP), setup.status 는 owner·ops.event 는 owner·admin 사용자 룸에만(설정 마법사 결정 6·팀 스펙 「역할과 권한」 표).
 * message.created·updated 는 여기서 상호작용 기록을 붙인다 — 버스 페이로드는 가볍게 두고, 클라이언트가 보는 Message 는
 * wire 경계에서 한 번 하이드레이션한다(설계 4.2 「클라이언트가 볼 Message 는 항상 하이드레이션을 거친다」).
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

  // 받을 사람은 보낼 때마다 membership 에서 읽는다 — 역할이 바뀌면 재접속 없이 다음 이벤트부터 따른다. 없으면 아무에게도 안 간다
  const roleRooms = (roles: TeamRole[]): string[] =>
    opts.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, opts.workspaceId), inArray(memberships.role, roles)))
      .all()
      .map((row) => userRoom(row.userId));

  const hydrate = (message: Message): Message => withInteractions(opts.db, [message])[0] ?? message;
  // 갱신은 루트일 수 있다(카드 상호작용 등) — 요약을 빼고 보내면 웹 칩이 사라진다. 새 메시지는 답글이 있을 수 없어 요약을 보지 않는다
  const hydrateUpdated = (message: Message): Message => hydrateForClient(opts.db, [message])[0] ?? message;

  const offs = [
    on("message.created", ({ message }) =>
      io.to(channelRoom(message.channelId)).emit("message.created", { message: hydrate(message) }),
    ),
    on("message.updated", (p) =>
      io
        .to(channelRoom(p.message.channelId))
        .emit("message.updated", { ...p, message: hydrateUpdated(p.message) }),
    ),
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
    // 승인만 워크스페이스 룸이다 — 웹은 한 번에 한 채널만 구독하므로 채널 룸이면 다른 채널을 보고 있을 때
    // 승인 카드도 알림도 아예 닿지 않는다(브라우저 검증 D1·판정 7). 노출은 늘지 않는다: channel.subscribe 는
    // 워크스페이스 소속만 보므로 접속한 소켓은 어느 채널이든 구독해 같은 페이로드를 이미 받을 수 있다.
    on("approval.requested", (p) => io.to(workspaceRoom(opts.workspaceId)).emit("approval.requested", p)),
    on("approval.resolved", (p) => io.to(workspaceRoom(opts.workspaceId)).emit("approval.resolved", p)),
    on("channel.created", (p) => io.to(workspaceRoom(p.channel.workspaceId)).emit("channel.created", p)),
    on("channel.updated", (p) => io.to(channelRoom(p.channel.id)).emit("channel.updated", p)),
    on("channel.member.changed", (p) => io.to(channelRoom(p.channelId)).emit("channel.member.changed", p)),
    on("people.changed", (p) => io.to(workspaceRoom(opts.workspaceId)).emit("people.changed", p)),
    on("agents.changed", (p) => io.to(workspaceRoom(opts.workspaceId)).emit("agents.changed", p)),
    on("typing", (p) => io.to(channelRoom(p.channelId)).emit("typing", p)),
    on("adapter.status", (p) => io.emit("adapter.status", p)),
    on("system.notice", (p) => io.emit("system.notice", p)),
    // 연결 페이지는 owner 만, 운영 화면은 admin 이상(팀 스펙 「역할과 권한」 표)
    on("setup.status", (p) => {
      const rooms = roleRooms(["owner"]);
      if (rooms.length > 0) io.to(rooms).emit("setup.status", p);
    }),
    on("ops.event", (p) => {
      const rooms = roleRooms(["owner", "admin"]);
      if (rooms.length > 0) io.to(rooms).emit("ops.event", p);
    }),
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
