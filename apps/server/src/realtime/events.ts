import type { Message, RunEvent, RunState, TeamRole } from "@dodok/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { channels, memberships } from "../db/schema.sqlite";
import type { Logger } from "../logger";
import { hydrateForClient, withInteractions } from "../modules/messages/service";
import { withReactions } from "../modules/reactions/service";
import { TERMINAL_STATUSES } from "../modules/runs/machine";
import type { BusEvents, ServerBus } from "./bus";
import { channelRoom, userRoom, workspaceRoom } from "./socket";
import type { WireServer, WireSocket } from "./types";

/** 소켓별 미전송 큐 상한(계약 스펙 7.3, 서버 코어 제약 「소켓 미전송 큐 상한 500 이벤트」) */
export const WIRE_MAX_PENDING = 500;

export type WireFanoutOptions = {
  logger: Logger;
  /** message.created·updated 를 내보내기 직전 상호작용 기록(components 설계 「붙이는 자리」 절)·리액션 집계(리액션 설계 「`modules/reactions/`」 절)를 붙일 때 읽는다 */
  db: Db;
  /** people.changed·agents.changed 의 룸(`workspace:<id>`)·역할 룸을 고르는 워크스페이스 — attachWire 의 `ctx.workspaceId` 와 같은 값 */
  workspaceId: string;
  maxPending?: number | undefined;
};

/**
 * bus → Socket.IO 팬아웃. 채널 이벤트는 channel:<id> 룸, 승인 둘·channel.created·updated·channel.activity 는 channelAudience(일반 채널은
 * workspace:<id> 룸, DM 은 주인의 user 룸), people.changed·agents.changed 는 workspace 룸, conversation.read 는 그 사용자의 user 룸,
 * adapter.status 는 전체, system.notice 는 userId 가 있으면 그 사람의 user 룸·없으면 전체, setup.status 는 owner·ops.event 는 owner·admin
 * 사용자 룸에만(설정 마법사 결정 6·팀 스펙 「역할과 권한」 표).
 * message.created·updated 는 여기서 상호작용 기록·리액션 집계를 붙인다 — 버스 페이로드는 가볍게 두고, 클라이언트가 보는 Message 는
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
      .where(
        and(
          eq(memberships.workspaceId, opts.workspaceId),
          inArray(memberships.role, roles),
          isNull(memberships.deactivatedAt),
        ),
      )
      .all()
      .map((row) => userRoom(row.userId));

  // 채널 사실(존재·이름·활동·승인)을 실을 룸 — 페이로드에 채널 행이 없는 이벤트는 매번 읽는다. 없는 채널이면 아무에게도 안 보낸다
  const audienceRow = (channelId: string) =>
    opts.db
      .select({ workspaceId: channels.workspaceId, kind: channels.kind, dmOwnerId: channels.dmOwnerId })
      .from(channels)
      .where(eq(channels.id, channelId))
      .get();
  const audienceOf = (channelId: string): string | undefined => {
    const row = audienceRow(channelId);
    return row ? channelAudience(row) : undefined;
  };

  const hydrate = (message: Message): Message =>
    withReactions(opts.db, withInteractions(opts.db, [message]))[0] ?? message;
  // 갱신은 루트일 수 있다(카드 상호작용 등) — 요약을 빼고 보내면 웹 칩이 사라진다. 새 메시지는 답글이 있을 수 없어 요약을 보지 않는다
  const hydrateUpdated = (message: Message): Message => hydrateForClient(opts.db, [message])[0] ?? message;

  const offs = [
    on("message.created", ({ message }) =>
      io.to(channelRoom(message.channelId)).emit("message.created", { message: hydrate(message) }),
    ),
    // 구독하지 않은 채널의 새 글을 사이드바가 알도록 본문 없는 신호를 channelAudience 로 낸다. silent 메시지도 저장된 것이라 안 읽은 것이다.
    // 위와 따로 등록한다 — 하이드레이션(새 글마다 리액션 질의)이 던져도 이 신호는 나가게. 버스는 등록 순서대로 부르므로 순서는 위가 먼저다
    on("message.created", ({ message }) => {
      const { authorType } = message;
      if (
        message.kind !== "normal" ||
        (authorType !== "user" && authorType !== "agent" && authorType !== "automation")
      )
        return;
      if (!message.authorId) return;
      const row = audienceRow(message.channelId);
      if (row === undefined) return;
      // DM 의 mentions 는 늘 비지만 에이전트의 보통 메시지는 주인을 부른 것으로 센다 — 스냅숏(reads/store.ts unreadFor)과 같은
      // 규칙이라야 배지가 새로고침 전후로 같다(에이전트 DM 계획 판정 PD10). DM 에는 스레드가 없어 답글 갈래는 따로 두지 않는다
      const mentionedUserIds =
        row.kind === "dm" && authorType === "agent" && row.dmOwnerId !== null
          ? [row.dmOwnerId]
          : message.mentions.users;
      io.to(channelAudience(row)).emit("channel.activity", {
        channelId: message.channelId,
        conversationId: message.conversationId,
        seq: message.seq,
        ...(message.threadRootId ? { threadRootId: message.threadRootId } : {}),
        authorType,
        authorId: message.authorId,
        mentionedUserIds,
      });
    }),
    on("conversation.read", ({ userId, ...update }) =>
      io.to(userRoom(userId)).emit("conversation.read", update),
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
    // 승인은 채널 룸이 아니다 — 웹은 한 번에 한 채널만 구독하므로 채널 룸이면 다른 채널을 보고 있을 때 승인 카드도 알림도 아예
    // 닿지 않는다(브라우저 검증 D1·판정 7). 일반 채널은 워크스페이스 룸이어도 노출이 늘지 않는다: 누구나 그 채널을 구독해 같은
    // 페이로드를 받을 수 있다. DM 은 주인만 구독할 수 있으므로 주인에게만(channelAudience)
    on("approval.requested", (p) => {
      const room = audienceOf(p.approval.channelId);
      if (room !== undefined) io.to(room).emit("approval.requested", p);
    }),
    on("approval.resolved", (p) => {
      const room = audienceOf(p.approval.channelId);
      if (room !== undefined) io.to(room).emit("approval.resolved", p);
    }),
    on("channel.created", (p) => io.to(channelAudience(p.channel)).emit("channel.created", p)),
    // 구독하지 않은 탭의 사이드바에도 닿게(채널 보관 스펙 「채널 보관」 절의 API). 일반 채널은 channel.created 와 목록 REST 가 이미
    // 워크스페이스의 모든 채널을 주므로 노출이 늘지 않는다
    on("channel.updated", (p) => io.to(channelAudience(p.channel)).emit("channel.updated", p)),
    on("channel.member.changed", (p) => io.to(channelRoom(p.channelId)).emit("channel.member.changed", p)),
    on("conversation.created", (p) =>
      io.to(channelRoom(p.conversation.channelId)).emit("conversation.created", p),
    ),
    on("conversation.updated", (p) =>
      io.to(channelRoom(p.conversation.channelId)).emit("conversation.updated", p),
    ),
    on("people.changed", (p) => io.to(workspaceRoom(opts.workspaceId)).emit("people.changed", p)),
    on("agents.changed", (p) => io.to(workspaceRoom(opts.workspaceId)).emit("agents.changed", p)),
    on("typing", (p) => io.to(channelRoom(p.channelId)).emit("typing", p)),
    on("adapter.status", (p) => io.emit("adapter.status", p)),
    on("system.notice", ({ userId, ...notice }) =>
      (userId === undefined ? io : io.to(userRoom(userId))).emit("system.notice", notice),
    ),
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
 * 채널 사실을 workspace 룸으로 내던 이벤트가 갈 룸 — 일반 채널은 워크스페이스 전원, DM 은 주인 한 사람(에이전트 DM 스펙 4장, 계획 판정
 * PD4). DM 이 있는지·이름·활동·승인을 남에게 보내지 않는다. 채널 사실을 workspace 룸으로 내는 새 이벤트는 이 함수를 거친다
 */
export function channelAudience(channel: {
  workspaceId: string;
  kind: string;
  dmOwnerId: string | null;
}): string {
  if (channel.kind !== "dm") return workspaceRoom(channel.workspaceId);
  // 주인이 없는 DM 은 없다(스키마 판정). 그래도 비면 아무도 없는 룸으로 — workspace 룸으로 새지 않게
  return userRoom(channel.dmOwnerId ?? "");
}

/**
 * engine.io Socket 의 writeBuffer — transport 가 쓰기 가능해지길 기다리는 패킷 수.
 * 타입 선언상 private 이라 캐스팅한다(engine.io 6.6.10 실측). 없어지면 0 — 백프레셔 테스트(wire.test f)가 깨져 알린다.
 */
function pendingPackets(socket: WireSocket): number {
  const { writeBuffer } = socket.conn as unknown as { writeBuffer?: unknown };
  return Array.isArray(writeBuffer) ? writeBuffer.length : 0;
}
