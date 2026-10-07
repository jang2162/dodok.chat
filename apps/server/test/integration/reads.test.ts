/**
 * 읽지 않음 팬아웃(읽지 않음 스펙 「서버」·「wire」 절, 계획 판정 PU2~PU4) — 사용자 A 의 소켓 둘과 B 의 소켓 하나, 셋 다 채널 룸에
 * 들어가지 않은 채로 workspace 룸·user 룸 신호만 본다. 실제 서버를 띄우고(FakeAdapter) wire 로 보낸다.
 */
import { ChannelActivity } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/app";
import { eq } from "drizzle-orm";
import { channels } from "../../src/db/schema.sqlite";
import { createChannel } from "../../src/modules/channels/service";
import { createSystemMessage, createUserMessage } from "../../src/modules/messages/service";
import { bootTestApp, userWithRole } from "../helpers/app";
import { connectWire, recordEvents, type WireClient, waitFor } from "../helpers/wire";

describe("통합 — 읽지 않음 팬아웃", () => {
  let app: App;
  let a: { id: string; token: string };
  let b: { id: string; token: string };
  let a1: WireClient;
  let a2: WireClient;
  let bs: WireClient;
  let n = 0;
  const sockets: WireClient[] = [];

  beforeAll(async () => {
    app = await bootTestApp();
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    a = await userWithRole(app, "reads-a", "member");
    b = await userWithRole(app, "reads-b", "member");
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  const wire = async (token: string) => {
    const socket = await connectWire(app, token);
    sockets.push(socket);
    return socket;
  };
  /** 같은 연결의 ack 왕복 — 그 앞에 서버가 이 소켓에 보낸 이벤트는 모두 도착해 있다 */
  const roundTrip = (socket: WireClient) => socket.emitWithAck("channel.unsubscribe", { channelId: uuid() });
  const channel = () =>
    createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: `reads-${++n}`,
    });
  const send = (socket: WireClient, channelId: string, extra: Record<string, unknown> = {}) =>
    socket.emitWithAck("message.send", {
      channelId,
      clientMsgId: `c-${++n}`,
      bodyMd: "hi",
      ...extra,
    });
  const ready = async () => {
    [a1, a2, bs] = [await wire(a.token), await wire(a.token), await wire(b.token)];
  };
  const unwrap = <T>(res: { ok: true; data: T } | { ok: false; error: { code: string } }): T => {
    if (!res.ok) throw new Error(res.error.code);
    return res.data;
  };

  describe("channel.activity", () => {
    it("B 가 최상위를 보내면 A 의 두 소켓이 본문 없는 신호를 받는다", async () => {
      await ready();
      const ch = channel();
      const got = [waitFor(a1, "channel.activity"), waitFor(a2, "channel.activity")];
      const sent = unwrap(await send(bs, ch.id)).message;
      for (const p of await Promise.all(got)) {
        expect(ChannelActivity.parse(p)).toEqual({
          channelId: ch.id,
          seq: sent.seq,
          authorType: "user",
          authorId: b.id,
          mentionedUserIds: [],
        });
        expect(p).not.toHaveProperty("threadRootId");
        expect(p).not.toHaveProperty("bodyMd");
      }
    });

    it("B 가 A 를 멘션한 스레드 답글 — threadRootId·mentionedUserIds 에 A", async () => {
      await ready();
      const ch = channel();
      const root = unwrap(await send(bs, ch.id)).message;
      const seen = waitFor(a1, "channel.activity", (p) => p.threadRootId === root.id);
      await send(bs, ch.id, { bodyMd: "@reads-a ping", threadRootId: root.id });
      expect(await seen).toMatchObject({
        channelId: ch.id,
        threadRootId: root.id,
        authorId: b.id,
        mentionedUserIds: [a.id],
      });
    });

    it("시스템 메시지는 activity 를 내지 않는다", async () => {
      await ready();
      const ch = channel();
      const seen = recordEvents(a1, ["channel.activity"]);
      createSystemMessage(app.db, app.bus, { channelId: ch.id, bodyMd: "공지", kind: "info" });
      await roundTrip(a1);
      expect(seen).toEqual([]);
    });

    // 시스템 메시지는 작성자가 없어 authorId 거름이 대신 막는다 — kind·authorType 거름은 작성자가 있는 꼴로 따로 잠근다
    it("kind 가 normal 이 아니면 작성자가 있어도 activity 를 내지 않는다", async () => {
      await ready();
      const ch = channel();
      const seen = recordEvents(a1, ["channel.activity"]);
      app.bus.emit("message.created", {
        message: {
          id: uuid(),
          channelId: ch.id,
          seq: 1,
          kind: "system",
          authorType: "agent",
          authorId: uuid(),
          bodyMd: "x",
          mentions: { users: [], agents: [] },
          reactions: [],
        } as never,
      });
      await roundTrip(a1);
      expect(seen).toEqual([]);
    });

    it("authorType 이 user·agent 가 아니면 작성자가 있어도 activity 를 내지 않는다 — 자동화는 아직 없다", async () => {
      await ready();
      const ch = channel();
      const seen = recordEvents(a1, ["channel.activity"]);
      for (const authorType of ["system", "automation"])
        app.bus.emit("message.created", {
          message: {
            id: uuid(),
            channelId: ch.id,
            seq: 1,
            kind: "normal",
            authorType,
            authorId: uuid(),
            bodyMd: "x",
            mentions: { users: [], agents: [] },
            reactions: [],
          } as never,
        });
      await roundTrip(a1);
      expect(seen).toEqual([]);
    });

    // 푸시 트리거는 silent 를 건너뛰지만 activity 는 아니다 — 연결을 닫은 런·보관한 에이전트의 늦은 정본도 저장된 새 글이다
    it("silent 메시지(늦게 온 정본)도 activity 를 낸다", async () => {
      await ready();
      const ch = channel();
      const agentId = uuid();
      const seen = waitFor(a1, "channel.activity");
      app.bus.emit("message.created", {
        message: {
          id: uuid(),
          channelId: ch.id,
          seq: 1,
          kind: "normal",
          authorType: "agent",
          authorId: agentId,
          bodyMd: "x",
          mentions: { users: [], agents: [] },
          reactions: [],
        } as never,
        silent: true,
      });
      expect(await seen).toMatchObject({ channelId: ch.id, authorType: "agent", authorId: agentId });
    });

    it("에이전트 글은 authorType agent 로 나간다", async () => {
      await ready();
      const ch = channel();
      const agentId = uuid();
      const seen = waitFor(a1, "channel.activity");
      app.bus.emit("message.created", {
        message: {
          id: uuid(),
          channelId: ch.id,
          seq: 1,
          kind: "normal",
          authorType: "agent",
          authorId: agentId,
          bodyMd: "x",
          mentions: { users: [], agents: [] },
          reactions: [],
        } as never,
      });
      expect(await seen).toMatchObject({ authorType: "agent", authorId: agentId });
    });
  });

  describe("channel.read", () => {
    it("A 의 소켓 1 이 보내면 ack 에 저장된 위치, 소켓 2 가 channel.read 를 받는다 — B 는 받지 않는다", async () => {
      await ready();
      const ch = channel();
      const sent = unwrap(await send(bs, ch.id)).message;
      const seenB = recordEvents(bs, ["channel.read"]);
      const got = waitFor(a2, "channel.read");
      const res = await a1.emitWithAck("channel.read", { channelId: ch.id, seq: sent.seq });
      expect(res).toEqual({ ok: true, data: { lastReadSeq: sent.seq } });
      expect(await got).toEqual({ channelId: ch.id, lastReadSeq: sent.seq });
      await roundTrip(bs);
      expect(seenB).toEqual([]);
    });

    it("last_seq 보다 큰 seq 는 깎이고, 낮은 seq 는 위치를 내리지 않는다", async () => {
      await ready();
      const ch = channel();
      const sent = unwrap(await send(bs, ch.id)).message;
      expect(await a1.emitWithAck("channel.read", { channelId: ch.id, seq: 999 })).toEqual({
        ok: true,
        data: { lastReadSeq: sent.seq },
      });
      expect(await a1.emitWithAck("channel.read", { channelId: ch.id, seq: 0 })).toEqual({
        ok: true,
        data: { lastReadSeq: sent.seq },
      });
    });

    it("형식이 틀리면 VALIDATION, 없는 채널은 NOT_FOUND", async () => {
      await ready();
      expect(await a1.emitWithAck("channel.read", { channelId: "nope", seq: 1 } as never)).toMatchObject({
        ok: false,
        error: { code: "VALIDATION" },
      });
      expect(await a1.emitWithAck("channel.read", { channelId: uuid(), seq: 1 })).toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
    });

    it("보관한 채널의 channel.read 도 받는다 — 읽기는 막지 않는다", async () => {
      await ready();
      const ch = channel();
      createUserMessage(app.db, app.bus, {
        channelId: ch.id,
        authorId: b.id,
        bodyMd: "old",
        clientMsgId: `arch-${++n}`,
      });
      app.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, ch.id)).run();
      expect(await a1.emitWithAck("channel.read", { channelId: ch.id, seq: 1 })).toEqual({
        ok: true,
        data: { lastReadSeq: 1 },
      });
    });
  });

  describe("작성자 읽음", () => {
    it("A 가 최상위를 보내면 읽음이 그 seq 로 오른다 — 소켓 2 가 channel.read 를 받는다", async () => {
      await ready();
      const ch = channel();
      const got = waitFor(a2, "channel.read");
      const sent = unwrap(await send(a1, ch.id)).message;
      expect(await got).toEqual({ channelId: ch.id, lastReadSeq: sent.seq });
    });

    it("스레드 답글은 읽음을 올리지 않는다", async () => {
      await ready();
      const ch = channel();
      const root = unwrap(await send(bs, ch.id)).message;
      const seen = recordEvents(a2, ["channel.read"]);
      unwrap(await send(a1, ch.id, { threadRootId: root.id }));
      await roundTrip(a2);
      expect(seen).toEqual([]);
    });

    it("같은 clientMsgId 재전송은 다시 내지 않는다", async () => {
      await ready();
      const ch = channel();
      const first = waitFor(a2, "channel.read");
      unwrap(await send(a1, ch.id, { clientMsgId: "dup-1" }));
      await first;
      const seen = recordEvents(a2, ["channel.read"]);
      unwrap(await send(a1, ch.id, { clientMsgId: "dup-1" }));
      await roundTrip(a2);
      expect(seen).toEqual([]);
    });
  });
});
