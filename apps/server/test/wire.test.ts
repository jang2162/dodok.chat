import {
  ApiError,
  Message,
  type RunEvent,
  type RunEventsReplayResult,
  type RunState,
  WIRE_PROTOCOL,
} from "@dodok/shared";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { apiError } from "../src/http/errors";
import type { Logger } from "../src/logger";
import { createChannel, getChannel, listMembers } from "../src/modules/channels/service";
import { createUserMessage } from "../src/modules/messages/service";
import { attachWire, type WireContext } from "../src/realtime/socket";
import type { RunsFacade, WireServer } from "../src/realtime/types";
import { bootTestApp, login } from "./helpers/app";
import { seedWorkspace } from "./helpers/seed";
import { connectWire, openWire, recordEvents, type WireClient, waitFor } from "./helpers/wire";

async function listen(app: App): Promise<void> {
  await app.fastify.listen({ host: "127.0.0.1", port: 0 });
}

/** 같은 연결의 ack 왕복 — 그 전에 서버가 이 소켓에 보낸 이벤트는 모두 도착해 있다 */
async function roundTrip(socket: WireClient): Promise<void> {
  const res = await socket.emitWithAck("channel.unsubscribe", { channelId: uuid() });
  expect(res).toEqual({ ok: true, data: null });
}

function connectError(socket: WireClient): Promise<Error & { data?: unknown }> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => reject(new Error("접속이 거부되지 않았다")));
    socket.once("connect_error", (err) => resolve(err as Error & { data?: unknown }));
  });
}

function runState(channelId: string, patch: Partial<RunState> = {}): RunState {
  return {
    id: uuid(),
    channelId,
    agentId: uuid(),
    status: "streaming",
    relayDepth: 0,
    hasCanonical: false,
    ...patch,
  };
}

function textDelta(runId: string, seq: number): RunEvent {
  return {
    type: "TEXT_MESSAGE_CONTENT",
    runId,
    seq,
    ts: new Date().toISOString(),
    messageId: "m1",
    delta: `d${seq}`,
  };
}

function fakeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

describe("wire (앱 부팅, FakeAdapter)", () => {
  let app: App;
  let token: string;
  const sockets: WireClient[] = [];

  const connect = async () => {
    const socket = await connectWire(app, token);
    sockets.push(socket);
    return socket;
  };
  const newChannel = (name: string) =>
    createChannel(app.db, { workspaceId: app.workspaceId, createdBy: app.ownerUserId, name });
  const subscribe = async (socket: WireClient, channelId: string, lastSeq?: number) => {
    const res = await socket.emitWithAck("channel.subscribe", {
      channelId,
      ...(lastSeq === undefined ? {} : { lastSeq }),
    });
    if (!res.ok) throw new Error(`subscribe 실패: ${res.error.code}`);
    return res.data;
  };

  beforeAll(async () => {
    app = await bootTestApp();
    await listen(app);
    // 앱당 login 1회 — /auth/local 은 5회/분 레이트리밋
    ({ token } = await login(app));
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  it("(a) 토큰 없음·무효 토큰은 UNAUTHORIZED, 프로토콜이 다르면 토큰보다 먼저 PROTOCOL_MISMATCH", async () => {
    const cases = [
      { auth: { protocol: WIRE_PROTOCOL }, code: "UNAUTHORIZED" },
      { auth: { token: "not-a-session", protocol: WIRE_PROTOCOL }, code: "UNAUTHORIZED" },
      { auth: { token: "한글\n토큰", protocol: WIRE_PROTOCOL }, code: "UNAUTHORIZED" },
      { auth: { token, protocol: 99 }, code: "PROTOCOL_MISMATCH" },
      { auth: { protocol: 99 }, code: "PROTOCOL_MISMATCH" },
      { auth: { token }, code: "PROTOCOL_MISMATCH" },
    ];
    for (const { auth, code } of cases) {
      const socket = openWire(app, auth);
      sockets.push(socket);
      const err = await connectError(socket);
      expect(err.message).toBe(code);
      expect(ApiError.parse(err.data)).toMatchObject({ code });
    }
  });

  it("(a) 접속하면 user:<userId> 룸에 들어간다", async () => {
    const socket = await connect();
    const serverSocket = app.io.sockets.sockets.get(socket.id as string);
    expect(serverSocket?.data.userId).toBe(app.ownerUserId);
    expect(serverSocket?.rooms.has(`user:${app.ownerUserId}`)).toBe(true);
  });

  it("(a) 접속하면 workspace:<workspaceId> 룸에 들어간다", async () => {
    const socket = await connect();
    const serverSocket = app.io.sockets.sockets.get(socket.id as string);
    expect(serverSocket?.rooms.has(`workspace:${app.workspaceId}`)).toBe(true);
  });

  it("채널을 만들면 그 채널을 아직 구독하지 않은 다른 소켓에도 channel.created 가 간다", async () => {
    const socket = await connect();
    const created = waitFor(socket, "channel.created");
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "wire-created" },
    });
    expect(res.statusCode).toBe(201);
    expect((await created).channel).toMatchObject({
      id: res.json().channel.id,
      name: "wire-created",
      workspaceId: app.workspaceId,
    });
  });

  it("(b) channel.subscribe — 빈 채널 ack, 없는 채널·다른 워크스페이스 채널 NOT_FOUND, 잘못된 입력 VALIDATION", async () => {
    const socket = await connect();
    const channel = newChannel("wire-b");
    expect(await socket.emitWithAck("channel.subscribe", { channelId: channel.id })).toEqual({
      ok: true,
      data: { messages: [], hasMore: false, activeRuns: [], pendingApprovals: [] },
    });
    expect(app.io.sockets.sockets.get(socket.id as string)?.rooms.has(`channel:${channel.id}`)).toBe(true);

    const missing = await socket.emitWithAck("channel.subscribe", { channelId: uuid() });
    expect(missing).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    const other = seedWorkspace(app.db, { userHandle: "stranger" });
    const foreign = createChannel(app.db, {
      workspaceId: other.workspaceId,
      createdBy: other.userId,
      name: "x",
    });
    const denied = await socket.emitWithAck("channel.subscribe", { channelId: foreign.id });
    expect(denied).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(app.io.sockets.sockets.get(socket.id as string)?.rooms.has(`channel:${foreign.id}`)).toBe(false);

    const invalid = await socket.emitWithAck("channel.subscribe", { channelId: "nope" } as never);
    expect(invalid).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("(c) message.send — ack seq 1, 다른 구독자 message.created, 같은 clientMsgId 재전송은 같은 id·이벤트 없음", async () => {
    const a = await connect();
    const b = await connect();
    const channel = newChannel("wire-c");
    await subscribe(a, channel.id);
    await subscribe(b, channel.id);
    const seenB = recordEvents(b, ["message.created"]);

    const created = waitFor(b, "message.created");
    const res = await a.emitWithAck("message.send", {
      channelId: channel.id,
      clientMsgId: "c-1",
      bodyMd: "hi",
    });
    if (!res.ok) throw new Error(res.error.code);
    const message = Message.parse(res.data.message);
    expect(message).toMatchObject({ seq: 1, channelId: channel.id, authorId: app.ownerUserId, bodyMd: "hi" });
    expect((await created).message.id).toBe(message.id);

    const again = await a.emitWithAck("message.send", {
      channelId: channel.id,
      clientMsgId: "c-1",
      bodyMd: "hi",
    });
    expect(again).toMatchObject({ ok: true, data: { message: { id: message.id, seq: 1 } } });
    await roundTrip(a);
    await roundTrip(b);
    expect(seenB).toHaveLength(1);
  });

  it("(c) message.send — 없는 채널·다른 워크스페이스 채널 NOT_FOUND, 잘못된 입력 VALIDATION", async () => {
    const socket = await connect();
    const other = seedWorkspace(app.db, { userHandle: "stranger2" });
    const foreign = createChannel(app.db, {
      workspaceId: other.workspaceId,
      createdBy: other.userId,
      name: "y",
    });
    for (const channelId of [uuid(), foreign.id]) {
      const res = await socket.emitWithAck("message.send", {
        channelId,
        clientMsgId: `x-${channelId}`,
        bodyMd: "x",
      });
      expect(res).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }
    const invalid = await socket.emitWithAck("message.send", {
      channelId: foreign.id,
      clientMsgId: "",
      bodyMd: "",
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("(d) channel.subscribe { lastSeq: 1 } 은 seq 2 만 돌려준다, lastSeq 없으면 최근 것", async () => {
    const socket = await connect();
    const channel = newChannel("wire-d");
    for (const n of [1, 2]) {
      createUserMessage(app.db, app.bus, {
        channelId: channel.id,
        authorId: app.ownerUserId,
        bodyMd: `m${n}`,
        clientMsgId: `d-${n}`,
      });
    }
    const page = await subscribe(socket, channel.id, 1);
    expect(page.messages.map((m) => m.seq)).toEqual([2]);
    expect(page.hasMore).toBe(false);
    expect((await subscribe(socket, channel.id)).messages.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("(d) lastSeq 없이 201개면 가장 최근 200개(seq 2~201)와 hasMore, lastSeq: 0 이면 가장 오래된 200개", async () => {
    const socket = await connect();
    const channel = newChannel("wire-d-many");
    for (let n = 1; n <= 201; n++) {
      createUserMessage(app.db, app.bus, {
        channelId: channel.id,
        authorId: app.ownerUserId,
        bodyMd: `m${n}`,
        clientMsgId: `dm-${n}`,
      });
    }
    const recent = await subscribe(socket, channel.id);
    expect(recent.messages.map((m) => m.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 2));
    expect(recent.hasMore).toBe(true);
    const oldest = await subscribe(socket, channel.id, 0);
    expect(oldest.messages.map((m) => m.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(oldest.hasMore).toBe(true);
  });

  it("(e) typing 은 보낸 사람을 뺀 구독자에게 사람 타이핑으로 중계, 구독하지 않은 채널로는 안 보낸다", async () => {
    const a = await connect();
    const b = await connect();
    const outsider = await connect();
    const channel = newChannel("wire-e");
    await subscribe(a, channel.id);
    await subscribe(b, channel.id);
    const seenA = recordEvents(a, ["typing"]);
    const seenB = recordEvents(b, ["typing"]);

    // 구독하지 않은 소켓의 typing — 서버가 처리한 뒤(왕복)에 a 가 보낸다
    outsider.emit("typing", { channelId: channel.id });
    await roundTrip(outsider);
    const relayed = waitFor(b, "typing");
    a.emit("typing", { channelId: channel.id });
    expect(await relayed).toEqual({ channelId: channel.id, actorType: "user", actorId: app.ownerUserId });
    await roundTrip(a);
    expect(seenA).toEqual([]);
    expect(seenB).toHaveLength(1);
  });

  it("channel.unsubscribe 뒤에는 그 채널 이벤트가 오지 않는다", async () => {
    const a = await connect();
    const b = await connect();
    const channel = newChannel("wire-unsub");
    await subscribe(a, channel.id);
    await subscribe(b, channel.id);
    const seenA = recordEvents(a, ["message.created"]);
    expect(await a.emitWithAck("channel.unsubscribe", { channelId: channel.id })).toEqual({
      ok: true,
      data: null,
    });

    const created = waitFor(b, "message.created");
    await b.emitWithAck("message.send", { channelId: channel.id, clientMsgId: "u-1", bodyMd: "after" });
    await created;
    await roundTrip(a);
    expect(seenA).toEqual([]);
  });

  it("bus 팬아웃 — 채널 이벤트는 channel 룸, adapter.status·system.notice 는 전체", async () => {
    const member = await connect();
    const outsider = await connect();
    const channel = newChannel("wire-fanout");
    await subscribe(member, channel.id);
    const seenOutsider = recordEvents(outsider, [
      "message.created",
      "message.updated",
      "run.state",
      "run.event",
      "channel.updated",
      "channel.member.changed",
      "typing",
    ]);

    const record = getChannel(app.db, channel.id);
    if (!record) throw new Error("channel");
    const members = listMembers(app.db, channel.id);
    const run = runState(channel.id);
    const event = textDelta(run.id, 1);
    const message = createUserMessage(app.db, app.bus, {
      channelId: channel.id,
      authorId: app.ownerUserId,
      bodyMd: "fan",
      clientMsgId: "f-1",
    });

    const expected = Promise.all([
      waitFor(member, "message.updated"),
      waitFor(member, "run.state"),
      waitFor(member, "run.event"),
      waitFor(member, "channel.updated"),
      waitFor(member, "channel.member.changed"),
      waitFor(member, "typing"),
      waitFor(member, "adapter.status"),
      waitFor(outsider, "adapter.status"),
      waitFor(outsider, "system.notice"),
    ]);
    app.bus.emit("message.updated", { message });
    app.bus.emit("run.state", { run });
    app.bus.emit("run.event", { event, channelId: channel.id });
    app.bus.emit("channel.updated", { channel: record });
    app.bus.emit("channel.member.changed", { channelId: channel.id, members });
    app.bus.emit("typing", { channelId: channel.id, actorType: "agent", actorId: run.agentId });
    app.bus.emit("adapter.status", { provider: "openclaw", gateway: "reconnecting", bridge: "down" });
    app.bus.emit("system.notice", { level: "warn", message: "notice" });

    const [updated, state, runEvent, channelUpdated, memberChanged, typing, status, outsiderStatus, notice] =
      await expected;
    expect(updated.message.id).toBe(message.id);
    expect(state).toEqual({ run });
    // bus 의 channelId 는 룸 선택용 — wire 페이로드에는 싣지 않는다
    expect(runEvent).toEqual({ event });
    expect(channelUpdated.channel.id).toBe(channel.id);
    expect(memberChanged).toEqual({ channelId: channel.id, members });
    expect(typing).toEqual({ channelId: channel.id, actorType: "agent", actorId: run.agentId });
    expect(status).toEqual({ provider: "openclaw", gateway: "reconnecting", bridge: "down" });
    expect(outsiderStatus).toEqual(status);
    expect(notice).toEqual({ level: "warn", message: "notice" });

    await roundTrip(outsider);
    expect(seenOutsider).toEqual([]);
  });

  it("ack 콜백 없이 보내도 서버가 죽지 않는다", async () => {
    const socket = await connect();
    const channel = newChannel("wire-noack");
    (socket.emit as (...args: unknown[]) => void)("channel.subscribe", { channelId: channel.id });
    (socket.emit as (...args: unknown[]) => void)("message.send", { channelId: "bad" });
    (socket.emit as (...args: unknown[]) => void)("run.abort", { runId: uuid() });
    await roundTrip(socket);
    expect((await subscribe(socket, channel.id)).messages).toEqual([]);
  });
});

describe("wire (attachWire 단독 — route·runs 주입)", () => {
  let app: App;
  let token: string;
  let io: WireServer | undefined;
  const sockets: WireClient[] = [];

  beforeAll(async () => {
    app = await bootTestApp();
    ({ token } = await login(app));
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await io?.close();
    io = undefined;
  });
  afterAll(async () => {
    await app.close();
  });

  async function start(over: Partial<WireContext>): Promise<WireClient> {
    const http = createServer();
    io = new Server(http);
    attachWire(io, {
      auth: app.auth,
      db: app.db,
      bus: app.bus,
      logger: app.logger,
      workspaceId: app.workspaceId,
      route: async () => {},
      runs: null,
      appOrigin: "http://localhost:5173",
      ...over,
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const socket = await connectWire({ url: `http://127.0.0.1:${port}` }, token);
    sockets.push(socket);
    return socket;
  }
  const newChannel = (name: string) =>
    createChannel(app.db, { workspaceId: app.workspaceId, createdBy: app.ownerUserId, name });

  it("런 핸들러 — runs 가 없으면 ADAPTER_UNAVAILABLE, 입력이 틀리면 VALIDATION", async () => {
    const socket = await start({});
    const unavailable = { ok: false, error: { code: "ADAPTER_UNAVAILABLE" } };
    expect(await socket.emitWithAck("run.abort", { runId: uuid() })).toMatchObject(unavailable);
    expect(await socket.emitWithAck("run.events.replay", { runId: uuid(), afterSeq: 0 })).toMatchObject(
      unavailable,
    );
    expect(
      await socket.emitWithAck("component.interact", {
        messageId: uuid(),
        componentId: "cmp",
        itemId: "ok",
        values: {},
      }),
    ).toMatchObject(unavailable);
    expect(
      await socket.emitWithAck("approval.resolve", { approvalId: uuid(), decision: "allow-once" }),
    ).toMatchObject(unavailable);
    expect(await socket.emitWithAck("run.abort", { runId: "x" } as never)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    // 옛 결정 값은 경계에서 막힌다 — Gateway 로 넘어가면 조용히 거절로 확정된다(승인 스파이크 4.4)
    expect(
      await socket.emitWithAck("approval.resolve", { approvalId: uuid(), decision: "approve" } as never),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("message.send — 저장 뒤 ack 가 route 를 기다리지 않고, route 는 새 메시지에만 한 번", async () => {
    const route = vi.fn((_message: Message) => new Promise<void>(() => {}));
    const socket = await start({ route });
    const channel = newChannel("solo-route");

    const res = await socket.emitWithAck("message.send", {
      channelId: channel.id,
      clientMsgId: "r-1",
      bodyMd: "go",
    });
    if (!res.ok) throw new Error(res.error.code);
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));
    expect(route.mock.calls[0]?.[0]).toEqual(res.data.message);

    const again = await socket.emitWithAck("message.send", {
      channelId: channel.id,
      clientMsgId: "r-1",
      bodyMd: "go",
    });
    expect(again).toMatchObject({ ok: true, data: { message: { id: res.data.message.id } } });
    await roundTrip(socket);
    expect(route).toHaveBeenCalledTimes(1);
  });

  it("message.send — route 예외는 로그만, attachments 는 무시하고 빈 배열로 저장(경고 로그)", async () => {
    const logger = fakeLogger();
    const route = vi.fn(async () => {
      throw new Error("route boom");
    });
    const socket = await start({ route, logger: logger as unknown as Logger });
    const channel = newChannel("solo-attach");

    const res = await socket.emitWithAck("message.send", {
      channelId: channel.id,
      clientMsgId: "a-1",
      bodyMd: "with file",
      attachments: [uuid()],
    });
    if (!res.ok) throw new Error(res.error.code);
    expect(res.data.message.attachments).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: 1 }),
      expect.stringContaining("attachments"),
    );
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: res.data.message.id }),
        "route failed",
      ),
    );
  });

  it("런 핸들러 — runs 로 위임(userId 포함), HttpError 는 그 코드, 그 밖 예외는 INTERNAL + 로그", async () => {
    const logger = fakeLogger();
    const channel = newChannel("solo-runs");
    const run = runState(channel.id);
    const replay: RunEventsReplayResult = { events: [textDelta(run.id, 1)], run };
    const interactionId = uuid();
    const runs = {
      activeRuns: vi.fn((_channelId: string) => [run]),
      abort: vi.fn(async (_runId: string, _userId: string) => {}),
      replay: vi.fn(async (_runId: string, _afterSeq: number) => replay),
      interact: vi.fn(async () => ({ interactionId })),
    } satisfies RunsFacade;
    const socket = await start({ runs, logger: logger as unknown as Logger });

    const sub = await socket.emitWithAck("channel.subscribe", { channelId: channel.id });
    expect(sub).toMatchObject({ ok: true, data: { activeRuns: [run] } });
    expect(runs.activeRuns).toHaveBeenCalledWith(channel.id);

    expect(await socket.emitWithAck("run.abort", { runId: run.id })).toEqual({ ok: true, data: null });
    expect(runs.abort).toHaveBeenCalledWith(run.id, app.ownerUserId);

    expect(await socket.emitWithAck("run.events.replay", { runId: run.id } as never)).toEqual({
      ok: true,
      data: replay,
    });
    expect(runs.replay).toHaveBeenCalledWith(run.id, 0);

    const interact = { messageId: uuid(), componentId: "cmp_1", itemId: "ok", values: { a: 1 } };
    expect(await socket.emitWithAck("component.interact", interact)).toEqual({
      ok: true,
      data: { interactionId },
    });
    expect(runs.interact).toHaveBeenCalledWith({ ...interact, userId: app.ownerUserId });

    expect(
      await socket.emitWithAck("approval.resolve", { approvalId: uuid(), decision: "deny" }),
    ).toMatchObject({ ok: false, error: { code: "ADAPTER_UNAVAILABLE" } });

    runs.abort.mockRejectedValueOnce(apiError("NOT_FOUND", "run not found"));
    expect(await socket.emitWithAck("run.abort", { runId: run.id })).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "run not found" },
    });
    expect(logger.error).not.toHaveBeenCalled();

    runs.abort.mockRejectedValueOnce(new Error("secret detail"));
    expect(await socket.emitWithAck("run.abort", { runId: run.id })).toEqual({
      ok: false,
      error: { code: "INTERNAL", message: "internal error" },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "run.abort" }),
      "wire handler failed",
    );
  });
});

describe("wire 백프레셔 (wireMaxPending: 3)", () => {
  let app: App;
  let token: string;
  const sockets: WireClient[] = [];

  beforeAll(async () => {
    app = await bootTestApp({}, { wireMaxPending: 3 });
    await listen(app);
    ({ token } = await login(app));
  });
  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await app.close();
  });

  it("(f) 미전송 큐가 차면 run.event 를 버리고 런별 1회 run.state { resync: true }, 비워지면 다시 보낸다", async () => {
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "wire-f",
    });
    const slow = await connectWire(app, token);
    const fast = await connectWire(app, token);
    sockets.push(slow, fast);
    for (const socket of [slow, fast]) {
      expect(await socket.emitWithAck("channel.subscribe", { channelId: channel.id })).toMatchObject({
        ok: true,
      });
    }
    const seenSlow = recordEvents(slow, ["run.state", "run.event"]);
    const seenFast = recordEvents(fast, ["run.event"]);
    const run = runState(channel.id);
    const emitEvent = (seq: number) =>
      app.bus.emit("run.event", { event: textDelta(run.id, seq), channelId: channel.id });
    const serverSlow = app.io.sockets.sockets.get(slow.id as string);
    if (!serverSlow) throw new Error("server socket");
    // engine.io Socket 의 writeBuffer — flush 때 새 배열로 바뀌므로 매번 프로퍼티로 읽는다
    const conn = serverSlow.conn as unknown as { writeBuffer: unknown[] };
    // 가짜 패킷은 noop 이어야 한다 — {} 는 flush 때 "undefined" 프레임으로 나가 클라이언트가 parser error 로 끊는다
    const clog = () =>
      conn.writeBuffer.push(
        { type: "noop", options: {} },
        { type: "noop", options: {} },
        { type: "noop", options: {} },
      );

    const started = waitFor(slow, "run.state");
    app.bus.emit("run.state", { run });
    await started;
    const latest: RunState = { ...run, status: "tool" };
    app.bus.emit("run.state", { run: latest });
    const first = waitFor(slow, "run.event", (p) => p.event.seq === 1);
    emitEvent(1);
    await first;

    clog();
    emitEvent(2); // 막힘 → 버림 + resync(보내면서 flush)
    clog(); // flush 직후 다시 막힘
    emitEvent(3); // 버림, 같은 런 resync 는 이미 보냄
    await waitFor(fast, "run.event", (p) => p.event.seq === 3);
    await vi.waitFor(() => expect(conn.writeBuffer.length).toBe(0));

    const resumed = waitFor(slow, "run.event", (p) => p.event.seq === 4);
    emitEvent(4); // 풀림 → 다시 보냄
    await resumed;

    clog();
    const again = waitFor(slow, "run.state", (p) => p.resync === true);
    emitEvent(5); // 두 번째 막힘 → 다시 resync 1회
    await again;
    await vi.waitFor(() =>
      expect(seenFast.map((e) => (e.payload as { event: RunEvent }).event.seq)).toEqual([1, 2, 3, 4, 5]),
    );

    expect(seenSlow).toEqual([
      { event: "run.state", payload: { run } },
      { event: "run.state", payload: { run: latest } },
      { event: "run.event", payload: { event: expect.objectContaining({ seq: 1 }) } },
      { event: "run.state", payload: { run: latest, resync: true } },
      { event: "run.event", payload: { event: expect.objectContaining({ seq: 4 }) } },
      { event: "run.state", payload: { run: latest, resync: true } },
    ]);
  });
});
