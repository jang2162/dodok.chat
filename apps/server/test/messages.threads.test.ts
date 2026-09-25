import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { Message } from "@dodok/shared";
import { sql } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import type { Db } from "../src/db/client";
import { agentSessions } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import {
  createAgentMessage,
  createSystemMessage,
  createUserMessage,
  getMessage,
  listMessages,
  threadSummaryOf,
} from "../src/modules/messages/service";
import type { RunPlan } from "../src/modules/router/decide";
import { createRouter } from "../src/modules/router/service";
import { ensureSession, markSessionReset } from "../src/modules/sessions/service";
import { ServerBus } from "../src/realtime/bus";
import { bootTestApp, login } from "./helpers/app";
import { newTestDb } from "./helpers/db";
import { seedWorkspace } from "./helpers/seed";
import { connectWire, recordEvents, type WireClient, waitFor } from "./helpers/wire";

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const created: Message[] = [];
  const updated: Message[] = [];
  const order: string[] = [];
  bus.on("message.created", ({ message }) => {
    created.push(message);
    order.push(`created:${message.id}`);
  });
  bus.on("message.updated", ({ message }) => {
    updated.push(message);
    order.push(`updated:${message.id}`);
  });
  const { workspaceId, userId } = seedWorkspace(db, { userHandle: "jang" });
  const logger = { warn: vi.fn() };
  const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
  const other = createChannel(db, { workspaceId, createdBy: userId, name: "other" });
  const agent = (handle: string) => {
    const a = createAgent(db, { workspaceId, providerAgentId: handle, handle, name: handle });
    addMember(db, channel.id, { memberType: "agent", memberId: a.id }, logger);
    return a;
  };
  let n = 0;
  const human = (bodyMd: string, over: { threadRootId?: string; channelId?: string } = {}) =>
    createUserMessage(db, bus, {
      channelId: over.channelId ?? channel.id,
      authorId: userId,
      bodyMd,
      clientMsgId: `c${++n}`,
      ...(over.threadRootId ? { threadRootId: over.threadRootId } : {}),
    });
  const agentSays = (agentId: string, bodyMd: string, threadRootId?: string) =>
    createAgentMessage(db, bus, {
      channelId: channel.id,
      agentId,
      externalId: `out-${++n}`,
      bodyMd,
      ...(threadRootId ? { threadRootId } : {}),
    });
  return { db, bus, created, updated, order, workspaceId, userId, channel, other, agent, human, agentSays };
}

/** messages 를 읽는 질의 수 — 트랜잭션 안(tx)의 질의도 같은 연결의 prepare 를 거친다. 쓰기(insert into)는 세지 않는다 */
function countMessageReads(db: Db): { count(): number; restore(): void } {
  const spy = vi.spyOn(db.$client, "prepare");
  return {
    count: () =>
      spy.mock.calls.filter(([s]) => /^select/i.test(String(s)) && /from "messages"/.test(String(s))).length,
    restore: () => spy.mockRestore(),
  };
}

describe("스레드 답글 저장·요약", () => {
  it("답글은 threadRootId 를 싣고 seq 는 채널 하나로 이어진다", () => {
    const t = setup();
    const root = t.human("루트");
    const reply = t.human("답글", { threadRootId: root.id });
    const next = t.human("다음 루트");
    expect(root.threadRootId).toBeUndefined();
    expect(reply).toMatchObject({ threadRootId: root.id, seq: 2 });
    expect(next.seq).toBe(3);
    expect(Message.parse(reply).threadRootId).toBe(root.id);
  });

  it("답글이 저장되면 message.created(답글) 뒤 message.updated(루트, 새 threadSummary)", () => {
    const t = setup();
    const dev = t.agent("dev");
    const fin = t.agent("fin");
    const root = t.human("루트");
    t.order.length = 0;
    const r1 = t.human("질문", { threadRootId: root.id });
    expect(t.order).toEqual([`created:${r1.id}`, `updated:${root.id}`]);
    expect(t.updated.at(-1)?.threadSummary).toEqual({ count: 1, lastAt: r1.createdAt, agentIds: [] });

    t.agentSays(dev.id, "dev 답", root.id);
    t.agentSays(fin.id, "fin 답", root.id);
    const last = t.agentSays(dev.id, "dev 또", root.id);
    // 최근에 답한 에이전트부터
    expect(threadSummaryOf(t.db, root.id)).toEqual({
      count: 4,
      lastAt: last.createdAt,
      agentIds: [dev.id, fin.id],
    });
    expect(t.updated.at(-1)).toMatchObject({ id: root.id, threadSummary: { count: 4 } });
    expect(Message.parse(t.updated.at(-1)).threadSummary?.count).toBe(4);
  });

  it("시스템 메시지도 스레드에 남고 답글 수에 든다", () => {
    const t = setup();
    const root = t.human("루트");
    const notice = createSystemMessage(t.db, t.bus, {
      channelId: t.channel.id,
      kind: "run_error",
      bodyMd: "실패",
      threadRootId: root.id,
    });
    expect(notice.threadRootId).toBe(root.id);
    expect(threadSummaryOf(t.db, root.id)?.count).toBe(1);
    expect(t.updated.at(-1)?.id).toBe(root.id);
  });

  it("agentIds 는 최대 10 — 가장 오래전에 답한 에이전트가 빠진다", () => {
    const t = setup();
    const root = t.human("루트");
    const agents = Array.from({ length: 11 }, (_, i) => t.agent(`a${i}`));
    for (const a of agents) t.agentSays(a.id, "답", root.id);
    const summary = threadSummaryOf(t.db, root.id);
    expect(summary?.agentIds).toHaveLength(10);
    expect(summary?.agentIds).not.toContain(agents[0]?.id);
    expect(summary?.agentIds[0]).toBe(agents[10]?.id);
  });

  it("답글이 없으면 threadSummaryOf 는 undefined, 루트에 threadSummary 를 싣지 않는다", () => {
    const t = setup();
    const root = t.human("루트");
    expect(threadSummaryOf(t.db, root.id)).toBeUndefined();
    expect(listMessages(t.db, t.channel.id, { limit: 50 }).messages[0]).not.toHaveProperty("threadSummary");
  });

  it("threadRootId 가 답글·다른 채널 메시지·없는 id 면 VALIDATION, 아무것도 저장·발행하지 않는다(Review Focus 1)", () => {
    const t = setup();
    const dev = t.agent("dev");
    const root = t.human("루트");
    const reply = t.human("답글", { threadRootId: root.id });
    const foreign = t.human("다른 채널", { channelId: t.other.id });
    const before = { created: t.created.length, updated: t.updated.length };
    const invalid = expect.objectContaining({ body: expect.objectContaining({ code: "VALIDATION" }) });
    for (const threadRootId of [reply.id, foreign.id, uuid()]) {
      expect(() => t.human("x", { threadRootId })).toThrow(invalid);
      expect(() => t.agentSays(dev.id, "x", threadRootId)).toThrow(invalid);
      expect(() =>
        createSystemMessage(t.db, t.bus, {
          channelId: t.channel.id,
          kind: "run_error",
          bodyMd: "x",
          threadRootId,
        }),
      ).toThrow(invalid);
    }
    expect({ created: t.created.length, updated: t.updated.length }).toEqual(before);
    expect(listMessages(t.db, t.channel.id, { limit: 50, scope: "all" }).messages).toHaveLength(2);
  });

  it("같은 clientMsgId 재전송은 처음 답글 그대로 — 이벤트 없음", () => {
    const t = setup();
    const root = t.human("루트");
    const first = createUserMessage(t.db, t.bus, {
      channelId: t.channel.id,
      authorId: t.userId,
      bodyMd: "답",
      clientMsgId: "same",
      threadRootId: root.id,
    });
    const events = t.order.length;
    const again = createUserMessage(t.db, t.bus, {
      channelId: t.channel.id,
      authorId: t.userId,
      bodyMd: "답",
      clientMsgId: "same",
      threadRootId: root.id,
    });
    expect(again).toEqual(first);
    expect(t.order).toHaveLength(events);
  });
});

describe("listMessages 스코프·around", () => {
  /** 루트 1·3·5·7, 답글 2(→1)·4(→3)·6(→1) */
  function seeded() {
    const t = setup();
    const r1 = t.human("r1");
    t.human("a1", { threadRootId: r1.id });
    const r3 = t.human("r3");
    t.human("a2", { threadRootId: r3.id });
    t.human("r5");
    t.human("a3", { threadRootId: r1.id });
    t.human("r7");
    return { ...t, r1, r3 };
  }
  const seqs = (page: { messages: Message[] }) => page.messages.map((m) => m.seq);

  it("기본(roots)은 루트만, 루트에 threadSummary", () => {
    const t = seeded();
    const page = listMessages(t.db, t.channel.id, { limit: 50 });
    expect(seqs(page)).toEqual([1, 3, 5, 7]);
    expect(page.messages[0]?.threadSummary?.count).toBe(2);
    expect(page.messages[1]?.threadSummary?.count).toBe(1);
    expect(page.messages[2]).not.toHaveProperty("threadSummary");
    expect(seqs(listMessages(t.db, t.channel.id, { limit: 2, beforeSeq: 7 }))).toEqual([3, 5]);
    expect(seqs(listMessages(t.db, t.channel.id, { limit: 2, afterSeq: 1 }))).toEqual([3, 5]);
  });

  it("all 은 답글까지 seq 순, 답글에는 threadRootId", () => {
    const t = seeded();
    const page = listMessages(t.db, t.channel.id, { limit: 50, scope: "all" });
    expect(seqs(page)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(page.messages[1]?.threadRootId).toBe(t.r1.id);
    expect(seqs(listMessages(t.db, t.channel.id, { limit: 3, afterSeq: 1, scope: "all" }))).toEqual([
      2, 3, 4,
    ]);
  });

  it("thread 스코프는 루트 + 그 답글, 오래된 순·before/after", () => {
    const t = seeded();
    const thread = listMessages(t.db, t.channel.id, { limit: 50, scope: { threadRootId: t.r1.id } });
    expect(seqs(thread)).toEqual([1, 2, 6]);
    expect(thread.messages[0]?.threadSummary?.count).toBe(2);
    expect(thread.hasMore).toBe(false);
    const latest = listMessages(t.db, t.channel.id, { limit: 2, scope: { threadRootId: t.r1.id } });
    expect(seqs(latest)).toEqual([2, 6]);
    expect(latest.hasMore).toBe(true);
    expect(
      seqs(listMessages(t.db, t.channel.id, { limit: 50, beforeSeq: 6, scope: { threadRootId: t.r1.id } })),
    ).toEqual([1, 2]);
    expect(
      seqs(listMessages(t.db, t.channel.id, { limit: 50, afterSeq: 1, scope: { threadRootId: t.r1.id } })),
    ).toEqual([2, 6]);
  });

  it("around 는 그 seq 앞뒤 절반 — hasMore 는 더 옛것, hasMoreAfter 는 더 새것", () => {
    const t = setup();
    for (let i = 1; i <= 9; i++) t.human(`m${i}`);
    const mid = listMessages(t.db, t.channel.id, { limit: 4, aroundSeq: 5 });
    expect(seqs(mid)).toEqual([4, 5, 6, 7]);
    expect(mid).toMatchObject({ hasMore: true, hasMoreAfter: true });
    const head = listMessages(t.db, t.channel.id, { limit: 4, aroundSeq: 1 });
    expect(seqs(head)).toEqual([1, 2, 3]);
    expect(head).toMatchObject({ hasMore: false, hasMoreAfter: true });
    const tail = listMessages(t.db, t.channel.id, { limit: 4, aroundSeq: 9 });
    expect(seqs(tail)).toEqual([8, 9]);
    expect(tail).toMatchObject({ hasMore: true, hasMoreAfter: false });
    const one = listMessages(t.db, t.channel.id, { limit: 1, aroundSeq: 5 });
    expect(seqs(one)).toEqual([5]);
    expect(one).toMatchObject({ hasMore: true, hasMoreAfter: true });
  });

  it("roots 스코프 around 가 답글 seq 면 그 루트를 가운데로", () => {
    const t = seeded();
    // seq 6 은 r1(seq 1) 의 답글
    const page = listMessages(t.db, t.channel.id, { limit: 3, aroundSeq: 6 });
    expect(seqs(page)).toEqual([1, 3]);
    expect(page).toMatchObject({ hasMore: false, hasMoreAfter: true });
    // 4 는 r3 의 답글 → r3 가운데
    expect(seqs(listMessages(t.db, t.channel.id, { limit: 3, aroundSeq: 4 }))).toEqual([1, 3, 5]);
    // thread 스코프에서는 답글 자리 그대로 — 6 이하 2개, 초과 1개(없음)
    const thread = listMessages(t.db, t.channel.id, {
      limit: 3,
      aroundSeq: 6,
      scope: { threadRootId: t.r1.id },
    });
    expect(seqs(thread)).toEqual([2, 6]);
    expect(thread).toMatchObject({ hasMore: true, hasMoreAfter: false });
  });

  it("루트 요약은 페이지 루트 수와 상관없이 같은 질의 수(N+1 없음)", () => {
    const small = setup();
    const r = small.human("r");
    small.human("a", { threadRootId: r.id });
    const big = setup();
    for (let i = 0; i < 6; i++) {
      const root = big.human(`r${i}`);
      big.human("a", { threadRootId: root.id });
      big.human("b", { threadRootId: root.id });
    }
    const count = (db: Db, channelId: string) => {
      const spy = countMessageReads(db);
      try {
        const page = listMessages(db, channelId, { limit: 50 });
        return { reads: spy.count(), roots: page.messages.filter((m) => m.threadSummary).length };
      } finally {
        spy.restore();
      }
    };
    const a = count(small.db, small.channel.id);
    const b = count(big.db, big.channel.id);
    expect(a.roots).toBe(1);
    expect(b.roots).toBe(6);
    expect(b.reads).toBe(a.reads);
    expect(b.reads).toBeLessThanOrEqual(2);
  });
});

describe("DB — 스레드 열·세션 유일성", () => {
  it("agent_sessions 는 (채널, 에이전트) 채널 세션 한 행 — thread_root_id 가 NULL 이어도 두 번째 행이 막힌다", () => {
    const t = setup();
    const dev = t.agent("dev");
    const root = t.human("루트");
    const row = (id: string, threadRootId: string | null) => ({
      id,
      channelId: t.channel.id,
      agentId: dev.id,
      sessionKey: `k-${id}`,
      promptRevisionAtStart: 1,
      threadRootId,
    });
    t.db.insert(agentSessions).values(row("s1", null)).run();
    expect(() => t.db.insert(agentSessions).values(row("s2", null)).run()).toThrow(/UNIQUE/);
    t.db.insert(agentSessions).values(row("s3", root.id)).run();
    expect(() => t.db.insert(agentSessions).values(row("s4", root.id)).run()).toThrow(/UNIQUE/);
    expect(t.db.select().from(agentSessions).all()).toHaveLength(2);
  });

  it("ensureSession·markSessionReset 은 스레드 행이 있어도 채널 세션 행 하나만 쓴다", () => {
    const t = setup();
    const dev = t.agent("dev");
    const root = t.human("루트");
    t.db
      .insert(agentSessions)
      .values({
        id: "thread-row",
        channelId: t.channel.id,
        agentId: dev.id,
        sessionKey: "thread-key",
        promptRevisionAtStart: 1,
        threadRootId: root.id,
      })
      .run();
    const adapter = { sessionKeyFor: (a: string, c: string) => `agent:${a}:dodok:channel:${c}` };
    const { session } = ensureSession(t.db, adapter, { channelId: t.channel.id, agentId: dev.id });
    expect(session).toMatchObject({
      threadRootId: null,
      sessionKey: `agent:dev:dodok:channel:${t.channel.id}`,
    });
    markSessionReset(t.db, t.channel.id, dev.id, { lifecycleRevision: "r1" });
    markSessionReset(t.db, t.channel.id, dev.id, { lifecycleRevision: "r2" });
    const rows = t.db.select().from(agentSessions).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === session.id)?.lifecycleRevision).toBe("r2");
    expect(rows.find((r) => r.id === "thread-row")?.lifecycleRevision).toBeNull();
  });

  it("runs 에 thread_root_id 열이 있다(태스크 5 가 채운다)", () => {
    const t = setup();
    const cols = t.db
      .all<{ name: string }>(sql`select name from pragma_table_info('runs')`)
      .map((c) => c.name);
    expect(cols).toContain("thread_root_id");
  });
});

describe("라우터 — 스레드 답글 임시 건너뛰기", () => {
  it("threadRootId 가 있는 메시지로는 런을 만들지 않고 warn", async () => {
    const t = setup();
    const dev = t.agent("dev");
    const logger = { warn: vi.fn(), error: vi.fn() };
    const enqueue = vi.fn(
      async (plan: RunPlan & { channelId: string }) => ({ id: uuid(), ...plan }) as never,
    );
    const router = createRouter({ db: t.db, bus: t.bus, logger, enqueue });
    const root = t.human("루트");
    const reply = t.human("@dev 봐줘", { threadRootId: root.id });
    expect(reply.mentions.agents).toEqual([dev.id]);
    await router.routeMessage(reply);
    expect(enqueue).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: reply.id, threadRootId: root.id }),
      expect.any(String),
    );
    await router.routeMessage(t.human("@dev 채널"));
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("wire·REST — 스레드", () => {
  let app: App;
  let token: string;
  let headers: { authorization: string };
  const sockets: WireClient[] = [];

  beforeAll(async () => {
    app = await bootTestApp({}, { adapter: new FakeAdapter() });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    // 앱당 login 1회 — /auth/local 은 5회/분 레이트리밋
    ({ token, headers } = await login(app));
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  const connect = async () => {
    const socket = await connectWire(app, token);
    sockets.push(socket);
    return socket;
  };
  const newChannel = (name: string) =>
    createChannel(app.db, { workspaceId: app.workspaceId, createdBy: app.ownerUserId, name });
  let n = 0;
  const post = (channelId: string, bodyMd: string, threadRootId?: string) =>
    createUserMessage(app.db, app.bus, {
      channelId,
      authorId: app.ownerUserId,
      bodyMd,
      clientMsgId: `seed-${++n}`,
      ...(threadRootId ? { threadRootId } : {}),
    });
  const get = (url: string) => app.fastify.inject({ method: "GET", url: `/api/v1${url}`, headers });

  it("message.send threadRootId — 답글 저장, 구독자에게 message.created(답글)·message.updated(루트 요약)", async () => {
    const a = await connect();
    const b = await connect();
    const channel = newChannel("wire-thread");
    const root = post(channel.id, "루트");
    for (const s of [a, b]) {
      const res = await s.emitWithAck("channel.subscribe", { channelId: channel.id });
      expect(res.ok).toBe(true);
    }
    const updated = waitFor(b, "message.updated", (p) => p.message.id === root.id);
    const res = await a.emitWithAck("message.send", {
      channelId: channel.id,
      clientMsgId: "t-1",
      bodyMd: "답글",
      threadRootId: root.id,
    });
    if (!res.ok) throw new Error(res.error.code);
    expect(res.data.message).toMatchObject({ threadRootId: root.id, seq: 2 });
    expect((await updated).message.threadSummary).toMatchObject({ count: 1, agentIds: [] });
  });

  it("message.send threadRootId 가 답글·다른 채널·없는 id 면 VALIDATION(Review Focus 1)", async () => {
    const socket = await connect();
    const channel = newChannel("wire-thread-bad");
    const other = newChannel("wire-thread-other");
    const root = post(channel.id, "루트");
    const reply = post(channel.id, "답", root.id);
    const foreign = post(other.id, "남의 채널");
    for (const threadRootId of [reply.id, foreign.id, uuid()]) {
      const res = await socket.emitWithAck("message.send", {
        channelId: channel.id,
        clientMsgId: `bad-${threadRootId}`,
        bodyMd: "x",
        threadRootId,
      });
      expect(res).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
    const all = listMessages(app.db, channel.id, { limit: 50, scope: "all" });
    expect(all.messages).toHaveLength(2);
  });

  it("channel.subscribe — lastSeq 없으면 루트만(요약 포함), lastSeq 가 있으면 답글까지(Review Focus 3)", async () => {
    const socket = await connect();
    const channel = newChannel("wire-thread-sub");
    const root = post(channel.id, "루트");
    post(channel.id, "답", root.id);
    post(channel.id, "루트2");
    const fresh = await socket.emitWithAck("channel.subscribe", { channelId: channel.id });
    if (!fresh.ok) throw new Error(fresh.error.code);
    expect(fresh.data.messages.map((m) => m.seq)).toEqual([1, 3]);
    expect(fresh.data.messages[0]?.threadSummary?.count).toBe(1);
    // 끊긴 사이 답글이 왔다
    post(channel.id, "끊긴 사이 답", root.id);
    const resync = await socket.emitWithAck("channel.subscribe", { channelId: channel.id, lastSeq: 1 });
    if (!resync.ok) throw new Error(resync.error.code);
    expect(resync.data.messages.map((m) => m.seq)).toEqual([2, 3, 4]);
    expect(resync.data.messages.map((m) => m.threadRootId)).toEqual([root.id, undefined, root.id]);
  });

  it("GET /channels/:id/messages?around= — 루트만, 답글 seq 면 그 루트가 가운데", async () => {
    const channel = newChannel("rest-around");
    const r1 = post(channel.id, "r1");
    for (let i = 0; i < 3; i++) post(channel.id, `r${i + 2}`);
    const reply = post(channel.id, "답", r1.id);
    const res = await get(`/channels/${channel.id}/messages?around=${reply.seq}&limit=3`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: Message[]; hasMore: boolean; hasMoreAfter: boolean };
    expect(body.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(body).toMatchObject({ hasMore: false, hasMoreAfter: true });
    expect(body.messages[0]?.threadSummary?.count).toBe(1);
    const both = await get(`/channels/${channel.id}/messages?around=2&beforeSeq=3`);
    expect(both.statusCode).toBe(400);
    expect(both.json()).toMatchObject({ code: "VALIDATION" });
  });

  it("GET /channels/:id/threads/:rootId/messages — 루트 + 답글 오래된 순, before/after/around", async () => {
    const channel = newChannel("rest-thread");
    const root = post(channel.id, "루트");
    post(channel.id, "다른 루트");
    const a = post(channel.id, "a", root.id);
    const b = post(channel.id, "b", root.id);
    const res = await get(`/channels/${channel.id}/threads/${root.id}/messages`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { root: Message; messages: Message[]; hasMore: boolean };
    expect(body.messages.map((m) => m.id)).toEqual([root.id, a.id, b.id]);
    expect(body.root).toMatchObject({ id: root.id, threadSummary: { count: 2 } });
    expect(body.hasMore).toBe(false);
    const older = await get(`/channels/${channel.id}/threads/${root.id}/messages?beforeSeq=${b.seq}&limit=1`);
    expect(older.json()).toMatchObject({ messages: [{ id: a.id }], hasMore: true, root: { id: root.id } });
    const newer = await get(`/channels/${channel.id}/threads/${root.id}/messages?afterSeq=${root.seq}`);
    expect((newer.json() as { messages: Message[] }).messages.map((m) => m.id)).toEqual([a.id, b.id]);
    const around = await get(`/channels/${channel.id}/threads/${root.id}/messages?around=${a.seq}&limit=2`);
    // a 이하 1개, 초과 1개
    expect((around.json() as { messages: Message[] }).messages.map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it("스레드 REST 권한 — 다른 워크스페이스 채널·루트가 아닌 id·다른 채널 루트·없는 id 는 404", async () => {
    const channel = newChannel("rest-thread-auth");
    const other = newChannel("rest-thread-auth-2");
    const root = post(channel.id, "루트");
    const reply = post(channel.id, "답", root.id);
    const elsewhere = post(other.id, "다른 채널 루트");
    const stranger = seedWorkspace(app.db, { userHandle: "thread-stranger" });
    const foreignChannel = createChannel(app.db, {
      workspaceId: stranger.workspaceId,
      createdBy: stranger.userId,
      name: "foreign",
    });
    const foreignRoot = createUserMessage(app.db, app.bus, {
      channelId: foreignChannel.id,
      authorId: stranger.userId,
      bodyMd: "남의 워크스페이스",
      clientMsgId: "foreign-1",
    });
    for (const url of [
      `/channels/${foreignChannel.id}/threads/${foreignRoot.id}/messages`,
      `/channels/${foreignChannel.id}/messages?around=1`,
      `/channels/${channel.id}/threads/${reply.id}/messages`,
      `/channels/${channel.id}/threads/${elsewhere.id}/messages`,
      `/channels/${channel.id}/threads/${uuid()}/messages`,
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("요약 없이 발행된 루트 message.updated(카드 상호작용 등)도 팬아웃이 요약을 붙인다 — 칩이 사라지지 않게", async () => {
    const socket = await connect();
    const channel = newChannel("wire-thread-hydrate");
    const root = post(channel.id, "루트");
    post(channel.id, "답", root.id);
    await socket.emitWithAck("channel.subscribe", { channelId: channel.id });
    const updated = waitFor(socket, "message.updated", (p) => p.message.id === root.id);
    const bare = getMessage(app.db, root.id);
    expect(bare?.threadSummary).toBeUndefined();
    app.bus.emit("message.updated", { message: bare as Message });
    expect((await updated).message.threadSummary).toMatchObject({ count: 1 });
  });

  it("구독하지 않은 소켓은 스레드 이벤트를 받지 않는다", async () => {
    const a = await connect();
    const b = await connect();
    const channel = newChannel("wire-thread-silent");
    const root = post(channel.id, "루트");
    await a.emitWithAck("channel.subscribe", { channelId: channel.id });
    const seen = recordEvents(b, ["message.created", "message.updated"]);
    await a.emitWithAck("message.send", {
      channelId: channel.id,
      clientMsgId: "silent-1",
      bodyMd: "답",
      threadRootId: root.id,
    });
    await b.emitWithAck("channel.unsubscribe", { channelId: uuid() });
    expect(seen).toHaveLength(0);
  });
});
