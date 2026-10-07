/**
 * wire 레이트리밋(운영 보강 스펙 4.2) — attachWire 단독. 버킷마다 burst 를 다르게 줘서 이벤트가 어느 버킷을 쓰는지까지 가른다.
 * 시계는 멈춰 둔다(보충 없음). 핸들러는 파싱 전에 토큰을 쓰므로 틀린 페이로드로 충분하다
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { createChannel } from "../src/modules/channels/service";
import type { OpsRecordInput } from "../src/modules/ops/service";
import { attachWire, WIRE_BUCKET, type WireContext } from "../src/realtime/socket";
import type { WireServer } from "../src/realtime/types";
import { bootTestApp, login } from "./helpers/app";
import { connectWire, type WireClient } from "./helpers/wire";

const RATE_LIMITED = { ok: false, error: { code: "RATE_LIMITED", message: "too many requests" } };

/** 버킷마다 다른 burst — 이벤트가 몇 번째에 막히는지로 어느 버킷을 쓰는지 안다 */
const DISTINCT = {
  wire: {
    heavy: { perMin: 60, burst: 2 },
    replay: { perMin: 60, burst: 3 },
    approval: { perMin: 60, burst: 4 },
    chatter: { perMin: 60, burst: 5 },
  },
  socketsPerUser: 20,
};

type AckEvent =
  | "message.send"
  | "component.interact"
  | "run.abort"
  | "run.events.replay"
  | "approval.resolve"
  | "channel.read"
  | "reaction.set";
const ACK_EVENTS: AckEvent[] = [
  "message.send",
  "component.interact",
  "run.abort",
  "run.events.replay",
  "approval.resolve",
  "channel.read",
  "reaction.set",
];

describe("wire 레이트리밋 (attachWire 단독)", () => {
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
      now: () => 0,
      ...over,
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const { port } = http.address() as AddressInfo;
    const socket = await connectWire({ url: `http://127.0.0.1:${port}` }, token);
    sockets.push(socket);
    return socket;
  }

  /** 같은 연결의 ack 왕복(상한 없는 이벤트) — 그 앞에 보낸 이벤트는 모두 처리됐다 */
  const roundTrip = (socket: WireClient) => socket.emitWithAck("channel.unsubscribe", { channelId: uuid() });

  it("ack 있는 이벤트 일곱 — 자기 버킷의 burst 만큼 지나고 그다음은 RATE_LIMITED, 사건 key 는 wire:<이벤트>", async () => {
    for (const event of ACK_EVENTS) {
      const record = vi.fn((_input: OpsRecordInput) => null);
      const socket = await start({ limits: DISTINCT, ops: { record } });
      const burst = DISTINCT.wire[WIRE_BUCKET[event]].burst;
      const emit = () => (socket.emitWithAck as (e: string, p: unknown) => Promise<unknown>)(event, {});
      const acks = [];
      for (let i = 0; i < burst + 1; i++) acks.push(await emit());
      expect(
        acks.slice(0, burst).every((a) => JSON.stringify(a) !== JSON.stringify(RATE_LIMITED)),
        event,
      ).toBe(true);
      expect(acks[burst], event).toEqual(RATE_LIMITED);
      expect(record.mock.calls.map(([input]) => input.key)).toEqual([`wire:${event}`]);
      expect(record.mock.calls[0]?.[0]).toMatchObject({
        kind: "ratelimit",
        severity: "info",
        detail: { ipPrefix: "127.0.0.0/24" },
      });
      socket.close();
      await io?.close();
      io = undefined;
    }
  });

  it("버킷 매핑이 스펙 4.2 표와 같다", () => {
    expect(WIRE_BUCKET).toEqual({
      "message.send": "heavy",
      "component.interact": "heavy",
      "run.abort": "heavy",
      "run.events.replay": "replay",
      "approval.resolve": "approval",
      typing: "chatter",
      "presence.update": "chatter",
      "channel.read": "chatter",
      "reaction.set": "chatter",
    });
  });

  it("presence.update — chatter burst 만큼 presence 에 닿고 그다음은 ack 없이 버린다", async () => {
    const set = vi.fn();
    const record = vi.fn((_input: OpsRecordInput) => null);
    const socket = await start({ limits: DISTINCT, ops: { record }, presence: { set, drop: vi.fn() } });
    for (let i = 0; i < DISTINCT.wire.chatter.burst + 3; i++)
      socket.emit("presence.update", { visible: true });
    await roundTrip(socket);
    expect(set).toHaveBeenCalledTimes(DISTINCT.wire.chatter.burst);
    expect(record.mock.calls.map(([input]) => input.key)).toEqual(Array(3).fill("wire:presence.update"));
  });

  it("버킷끼리 나누지 않는다 — chatter 를 다 써도 replay·heavy·approval 은 그대로다", async () => {
    const record = vi.fn((_input: OpsRecordInput) => null);
    const socket = await start({ limits: DISTINCT, ops: { record } });
    for (let i = 0; i < DISTINCT.wire.chatter.burst + 1; i++) socket.emit("typing", { channelId: uuid() });
    await roundTrip(socket);
    expect(record.mock.calls.map(([input]) => input.key)).toEqual(["wire:typing"]);
    expect(await socket.emitWithAck("run.events.replay", { runId: uuid(), afterSeq: 0 })).not.toEqual(
      RATE_LIMITED,
    );
    expect(await socket.emitWithAck("run.abort", { runId: uuid() })).not.toEqual(RATE_LIMITED);
    expect(
      await socket.emitWithAck("approval.resolve", { approvalId: uuid(), decision: "allow-once" }),
    ).not.toEqual(RATE_LIMITED);
  });

  it("replay 는 message.send 와 버킷을 나누지 않는다 — 활성 런 셋인 채널을 여덟 번 오간 뒤에도 보낼 수 있고, 연속 31번째 replay 만 막힌다(LIMITS)", async () => {
    const socket = await start({});
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "replay-heavy",
    });
    const replay = () => socket.emitWithAck("run.events.replay", { runId: uuid(), afterSeq: 0 });

    // 채널 입장마다 웹은 활성 런 수만큼 replay 를 부른다(realtime/subscriptions.ts applySubscribed)
    for (let move = 0; move < 8; move++)
      for (let run = 0; run < 3; run++) expect(await replay()).not.toEqual(RATE_LIMITED);
    const sent = await socket.emitWithAck("message.send", {
      channelId: channel.id,
      clientMsgId: "after-replay",
      bodyMd: "지나간다",
    });
    expect(sent.ok).toBe(true);

    for (let i = 24; i < 30; i++) expect(await replay()).not.toEqual(RATE_LIMITED);
    expect(await replay()).toEqual(RATE_LIMITED);
  });
});
