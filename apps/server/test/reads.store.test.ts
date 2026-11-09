/**
 * 읽음 위치 저장소(읽지 않음 스펙 「무엇이 「안 읽음」인가」·「서버」 절 — 채널 세션 계획 태스크 7 이 단위를 대화로) — 읽음 위치는 대화마다
 * 커지기만 하고 그 대화의 last_seq 로 깎이며, 현황은 남이 쓴 최상위 보통 메시지(굵게)와 나를 멘션한 보통 메시지(배지, 스레드 답글
 * 포함·99 에서 자름)를 대화마다 센다. seq 는 채널 하나의 번호를 세션이 같이 쓴다 — 세션 A 의 읽음이 B 로 새지 않아야 한다
 */
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { channels, conversationReads, conversations, messages, users } from "../src/db/schema.sqlite";
import { archiveChannel, unarchiveChannel } from "../src/modules/channels/service";
import { touchConversation } from "../src/modules/conversations/store";
import { allocateSeq } from "../src/modules/messages/seq";
import { listedChannelIds, markRead, unreadFor } from "../src/modules/reads/store";
import { newTestDb } from "./helpers/db";
import {
  channelConversation,
  createDirectChannelForTest,
  seedChannelWithAgent,
  seedConversation,
} from "./helpers/seed";

const NOW = new Date("2026-10-06T00:00:00.000Z");

function setup() {
  const db = newTestDb();
  const { workspaceId, userId: a, agentId, channelId } = seedChannelWithAgent(db);
  const b = uuid();
  db.insert(users)
    .values({ id: b, workspaceId, handle: "bee", displayName: "Bee", authProvider: "local", createdAt: NOW })
    .run();
  const conv = channelConversation(db, channelId);
  return { db, workspaceId, a, b, agentId, channelId, conv };
}

function addChannel(db: Db, workspaceId: string, createdBy: string, name: string, withSession = true) {
  const id = uuid();
  db.insert(channels)
    .values({
      id,
      workspaceId,
      name,
      relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
      visibility: "public",
      createdBy,
      createdAt: NOW,
    })
    .run();
  const conv = withSession ? seedConversation(db, id, { createdBy, createdAt: NOW }) : undefined;
  return { id, conv };
}

type Post = {
  authorType: "user" | "agent" | "system";
  authorId?: string;
  threadRootId?: string;
  mentionUsers?: string[];
};

/**
 * 메시지 하나를 그 대화에 seq 를 받아 넣는다(대화의 last_seq 도 storeMessage 처럼 올린다) — 시스템 메시지는 kind system·작성자 없음
 * (messages/service.ts createSystemMessage 와 같은 꼴)
 */
function post(db: Db, conversationId: string, p: Post): { id: string; seq: number } {
  return db.transaction((tx) => {
    const channelId = tx
      .select({ channelId: conversations.channelId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()!.channelId;
    const seq = allocateSeq(tx, channelId);
    const id = uuid();
    const kind = p.authorType === "system" ? "system" : "normal";
    tx.insert(messages)
      .values({
        id,
        channelId,
        conversationId,
        seq,
        kind,
        authorType: p.authorType,
        authorId: p.authorType === "system" ? null : (p.authorId ?? null),
        bodyMd: "hi",
        mentions: { agents: [], users: p.mentionUsers ?? [] },
        threadRootId: p.threadRootId ?? null,
        createdAt: NOW,
      })
      .run();
    touchConversation(tx, conversationId, { seq, createdAt: NOW, kind });
    return { id, seq };
  });
}

function convLastSeq(db: Db, conversationId: string): number {
  return db
    .select({ s: conversations.lastSeq })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get()!.s;
}

function readRow(db: Db, userId: string, conversationId: string) {
  return db
    .select()
    .from(conversationReads)
    .all()
    .find((r) => r.userId === userId && r.conversationId === conversationId);
}

function unreadOf(db: Db, workspaceId: string, userId: string, conversationId: string) {
  return unreadFor(db, workspaceId, userId).find((c) => c.conversationId === conversationId);
}

const archiveDeps = (db: Db) => ({
  db,
  orchestrator: { activeRuns: () => [], abort: async () => {} },
});

describe("markRead", () => {
  it("커지기만 한다 — 5 뒤 3 이면 돌려준 값과 행 모두 5", () => {
    const { db, workspaceId, a, b, conv } = setup();
    for (let i = 0; i < 7; i++) post(db, conv, { authorType: "user", authorId: b });

    expect(markRead(db, workspaceId, a, conv, 5, NOW)).toBe(5);
    expect(markRead(db, workspaceId, a, conv, 3, new Date(NOW.getTime() + 1000))).toBe(5);
    expect(readRow(db, a, conv)).toMatchObject({ lastReadSeq: 5 });
  });

  it("행을 처음 만들 때 updated_at 을 그 시각으로 둔다", () => {
    const { db, workspaceId, a, b, conv } = setup();
    post(db, conv, { authorType: "user", authorId: b });

    markRead(db, workspaceId, a, conv, 1, NOW);
    expect(readRow(db, a, conv)).toEqual({ userId: a, conversationId: conv, lastReadSeq: 1, updatedAt: NOW });
  });

  it("기존 행을 올리면 updated_at 도 그 시각으로 바꾼다", () => {
    const { db, workspaceId, a, b, conv } = setup();
    post(db, conv, { authorType: "user", authorId: b });
    post(db, conv, { authorType: "user", authorId: b });
    const later = new Date(NOW.getTime() + 60_000);

    markRead(db, workspaceId, a, conv, 1, NOW);
    markRead(db, workspaceId, a, conv, 2, later);
    expect(readRow(db, a, conv)).toEqual({
      userId: a,
      conversationId: conv,
      lastReadSeq: 2,
      updatedAt: later,
    });
  });

  it("요청 seq 를 그 대화의 last_seq 로 깎는다 — 채널 끝이 아니다(같은 채널의 다른 세션이 뒤에 썼어도)", () => {
    const { db, workspaceId, a, b, channelId, conv } = setup();
    const other = seedConversation(db, channelId, { title: "B" });
    post(db, conv, { authorType: "user", authorId: b });
    post(db, conv, { authorType: "user", authorId: b });
    for (let i = 0; i < 5; i++) post(db, other, { authorType: "user", authorId: b });

    expect(markRead(db, workspaceId, a, conv, 50, NOW)).toBe(2);
    expect(readRow(db, a, conv)).toMatchObject({ lastReadSeq: 2 });
    expect(markRead(db, workspaceId, a, other, 50, NOW)).toBe(7);
  });

  it("세션 A 의 읽음은 B 의 행을 건드리지 않는다 — A 끝(seq 5)을 읽어도 seq 가 더 낮은 B 의 글(2·3)은 안 읽음", () => {
    const { db, workspaceId, a, b, channelId, conv } = setup();
    const other = seedConversation(db, channelId, { title: "B" });
    post(db, conv, { authorType: "user", authorId: b });
    post(db, other, { authorType: "user", authorId: b });
    post(db, other, { authorType: "user", authorId: b, mentionUsers: [a] });
    post(db, conv, { authorType: "user", authorId: b });
    post(db, conv, { authorType: "user", authorId: b });

    expect(markRead(db, workspaceId, a, conv, 5, NOW)).toBe(5);
    expect(readRow(db, a, other)).toBeUndefined();
    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ lastReadSeq: 5, unread: false, mentions: 0 });
    expect(unreadOf(db, workspaceId, a, other)).toMatchObject({ lastReadSeq: 0, unread: true, mentions: 1 });
  });

  it("없는 대화·다른 워크스페이스 대화는 NOT_FOUND 이고 행을 만들지 않는다", () => {
    const { db, workspaceId, a } = setup();
    const other = seedChannelWithAgent(db, { channelName: "other" });
    const notFound = expect.objectContaining({
      status: 404,
      body: expect.objectContaining({ code: "NOT_FOUND" }),
    });

    expect(() => markRead(db, workspaceId, a, uuid(), 1, NOW)).toThrow(notFound);
    expect(() => markRead(db, workspaceId, a, channelConversation(db, other.channelId), 0, NOW)).toThrow(
      notFound,
    );
    expect(db.select().from(conversationReads).all()).toEqual([]);
  });

  it("닫힌 세션도 받는다 — 읽기는 막지 않는다", () => {
    const { db, workspaceId, a, b, conv } = setup();
    post(db, conv, { authorType: "user", authorId: b });
    db.update(conversations).set({ closedAt: NOW, closedBy: a }).where(eq(conversations.id, conv)).run();

    expect(markRead(db, workspaceId, a, conv, 1, NOW)).toBe(1);
  });
});

describe("unreadFor", () => {
  it("행이 없으면 lastReadSeq 0, latestSeq 는 그 대화의 last_seq", () => {
    const { db, workspaceId, a, b, channelId, conv } = setup();
    for (let i = 0; i < 3; i++) post(db, conv, { authorType: "system" });

    expect(unreadFor(db, workspaceId, a)).toEqual([
      { conversationId: conv, channelId, lastReadSeq: 0, latestSeq: 3, unread: false, mentions: 0 },
    ]);
    post(db, conv, { authorType: "user", authorId: b });
    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ latestSeq: convLastSeq(db, conv) });
  });

  it("대화마다 한 줄 — 같은 채널의 두 세션은 따로 세고, latestSeq 도 그 세션 것", () => {
    const { db, workspaceId, a, b, channelId, conv } = setup();
    const other = seedConversation(db, channelId, { title: "B" });
    post(db, conv, { authorType: "user", authorId: b, mentionUsers: [a] });
    post(db, other, { authorType: "user", authorId: b });
    post(db, other, { authorType: "user", authorId: b, mentionUsers: [a] });
    post(db, conv, { authorType: "system" });

    const rows = unreadFor(db, workspaceId, a).sort((x, y) => x.latestSeq - y.latestSeq);
    expect(rows).toEqual([
      { conversationId: other, channelId, lastReadSeq: 0, latestSeq: 3, unread: true, mentions: 1 },
      { conversationId: conv, channelId, lastReadSeq: 0, latestSeq: 4, unread: true, mentions: 1 },
    ]);
  });

  it("다른 세션에만 남의 글이 있으면 그 세션만 굵다 — 내 글만 있는 세션은 아니다", () => {
    const { db, workspaceId, a, b, channelId, conv } = setup();
    const other = seedConversation(db, channelId, { title: "B" });
    post(db, conv, { authorType: "user", authorId: a });
    post(db, other, { authorType: "user", authorId: b });

    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ unread: false });
    expect(unreadOf(db, workspaceId, a, other)).toMatchObject({ unread: true });
  });

  it("닫힌 세션도 싣는다", () => {
    const { db, workspaceId, a, b, conv } = setup();
    post(db, conv, { authorType: "user", authorId: b });
    db.update(conversations).set({ closedAt: NOW, closedBy: b }).where(eq(conversations.id, conv)).run();

    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ unread: true });
  });

  it("남이 쓴 최상위 메시지는 굵게, 자기 글은 아니다", () => {
    const { db, workspaceId, a, b, conv } = setup();
    post(db, conv, { authorType: "user", authorId: b });

    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ unread: true, mentions: 0 });
    expect(unreadOf(db, workspaceId, b, conv)).toMatchObject({ unread: false, mentions: 0 });
  });

  it("에이전트가 쓴 메시지도 굵게 한다", () => {
    const { db, workspaceId, a, agentId, conv } = setup();
    post(db, conv, { authorType: "agent", authorId: agentId });

    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ unread: true });
  });

  it("시스템 메시지만 있으면 굵게도 배지도 없다 — 멘션이 실려 있어도", () => {
    const { db, workspaceId, a, channelId, conv } = setup();
    post(db, conv, { authorType: "system" });
    // 시스템 메시지는 멘션을 싣지 않지만, 실려 있어도 kind 로 거른다
    db.transaction((tx) => {
      const seq = allocateSeq(tx, channelId);
      tx.insert(messages)
        .values({
          id: uuid(),
          channelId,
          conversationId: conv,
          seq,
          kind: "system",
          authorType: "system",
          authorId: null,
          bodyMd: "x",
          mentions: { agents: [], users: [a] },
          createdAt: NOW,
        })
        .run();
      touchConversation(tx, conv, { seq, createdAt: NOW, kind: "system" });
    });

    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ unread: false, mentions: 0 });
  });

  it("스레드 답글만 있으면 굵게 하지 않는다", () => {
    const { db, workspaceId, a, b, conv } = setup();
    const root = post(db, conv, { authorType: "user", authorId: a });
    post(db, conv, { authorType: "user", authorId: b, threadRootId: root.id });

    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ unread: false, mentions: 0 });
  });

  it("스레드 답글 속 멘션은 굵게 없이 배지로 센다", () => {
    const { db, workspaceId, a, b, conv } = setup();
    const root = post(db, conv, { authorType: "user", authorId: a });
    post(db, conv, { authorType: "user", authorId: b, threadRootId: root.id, mentionUsers: [a] });

    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ unread: false, mentions: 1 });
  });

  it("자기를 멘션한 자기 글은 배지에 넣지 않는다", () => {
    const { db, workspaceId, a, conv } = setup();
    post(db, conv, { authorType: "user", authorId: a, mentionUsers: [a] });

    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ unread: false, mentions: 0 });
  });

  it("다른 사람을 멘션한 글은 내 배지가 아니다", () => {
    const { db, workspaceId, a, b, agentId, conv } = setup();
    post(db, conv, { authorType: "agent", authorId: agentId, mentionUsers: [b] });

    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ unread: true, mentions: 0 });
    expect(unreadOf(db, workspaceId, b, conv)).toMatchObject({ unread: true, mentions: 1 });
  });

  it("direct 는 남이 쓴 보통 메시지(사람·에이전트, 스레드 답글 포함)를 모두 배지로 센다 — 자기 글·시스템 메시지는 아니다(사람 간 DM 스펙 7.2)", () => {
    const { db, workspaceId, a, b, agentId } = setup();
    const direct = createDirectChannelForTest(db, {
      workspaceId,
      createdBy: a,
      userIds: [b],
      agentIds: [agentId],
    });
    const conv = seedConversation(db, direct.id, { createdBy: a });
    const root = post(db, conv, { authorType: "user", authorId: b });
    post(db, conv, { authorType: "agent", authorId: agentId });
    post(db, conv, { authorType: "user", authorId: b, threadRootId: root.id });
    post(db, conv, { authorType: "user", authorId: a });
    post(db, conv, { authorType: "system", mentionUsers: [a] });

    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ unread: true, mentions: 3 });
    expect(unreadOf(db, workspaceId, b, conv)).toMatchObject({ mentions: 2 });
  });

  it("멘션 120개는 99 에서 자른다", () => {
    const { db, workspaceId, a, b, conv } = setup();
    for (let i = 0; i < 120; i++) post(db, conv, { authorType: "user", authorId: b, mentionUsers: [a] });

    expect(unreadOf(db, workspaceId, a, conv)).toMatchObject({ unread: true, mentions: 99 });
  });

  it("읽음 위치 뒤의 것만 센다 — 끝까지 읽으면 굵게·배지 0", () => {
    const { db, workspaceId, a, b, channelId, conv } = setup();
    post(db, conv, { authorType: "user", authorId: b, mentionUsers: [a] });
    const mid = post(db, conv, { authorType: "user", authorId: b });
    post(db, conv, { authorType: "user", authorId: b, mentionUsers: [a] });

    markRead(db, workspaceId, a, conv, mid.seq, NOW);
    expect(unreadOf(db, workspaceId, a, conv)).toEqual({
      conversationId: conv,
      channelId,
      lastReadSeq: mid.seq,
      latestSeq: 3,
      unread: true,
      mentions: 1,
    });
    markRead(db, workspaceId, a, conv, convLastSeq(db, conv), NOW);
    expect(unreadOf(db, workspaceId, a, conv)).toEqual({
      conversationId: conv,
      channelId,
      lastReadSeq: 3,
      latestSeq: 3,
      unread: false,
      mentions: 0,
    });
  });

  it("그 워크스페이스의 대화만, 다른 사람의 읽음 위치는 섞이지 않는다", () => {
    const { db, workspaceId, a, b, channelId, conv } = setup();
    const other = seedChannelWithAgent(db, { channelName: "other" });
    post(db, channelConversation(db, other.channelId), { authorType: "user", authorId: other.userId });
    post(db, conv, { authorType: "user", authorId: b });

    markRead(db, workspaceId, b, conv, 1, NOW);
    expect(unreadFor(db, workspaceId, a)).toEqual([
      { conversationId: conv, channelId, lastReadSeq: 0, latestSeq: 1, unread: true, mentions: 0 },
    ]);
  });

  it("같은 워크스페이스의 다른 채널로 새지 않는다 — X 의 글·멘션이 빈 Y·다 읽은 Z 를 굵게·배지로 만들지 않는다", () => {
    const { db, workspaceId, a, b, channelId: x, conv: xConv } = setup();
    const y = addChannel(db, workspaceId, a, "y");
    const z = addChannel(db, workspaceId, a, "z");
    post(db, z.conv!, { authorType: "user", authorId: b, mentionUsers: [a] });
    markRead(db, workspaceId, a, z.conv!, 1, NOW);
    // Z 의 읽음 위치(1)보다 큰 seq 가 X 에 있어야 X 의 글이 Z 로 새는지 보인다
    post(db, xConv, { authorType: "user", authorId: b });
    post(db, xConv, { authorType: "user", authorId: b });
    post(db, xConv, { authorType: "user", authorId: b, mentionUsers: [a] });

    expect(unreadOf(db, workspaceId, a, xConv)).toMatchObject({ channelId: x, unread: true, mentions: 1 });
    expect(unreadOf(db, workspaceId, a, y.conv!)).toEqual({
      conversationId: y.conv,
      channelId: y.id,
      lastReadSeq: 0,
      latestSeq: 0,
      unread: false,
      mentions: 0,
    });
    expect(unreadOf(db, workspaceId, a, z.conv!)).toEqual({
      conversationId: z.conv,
      channelId: z.id,
      lastReadSeq: 1,
      latestSeq: 1,
      unread: false,
      mentions: 0,
    });
  });

  it("보관한 채널의 대화는 빠지고, 보관 해제하면 읽음 위치 그대로 다시 나온다", async () => {
    const { db, workspaceId, a, b, channelId, conv } = setup();
    post(db, conv, { authorType: "user", authorId: b });
    post(db, conv, { authorType: "user", authorId: b });
    markRead(db, workspaceId, a, conv, 1, NOW);

    await archiveChannel(archiveDeps(db), channelId, workspaceId);
    expect(unreadFor(db, workspaceId, a)).toEqual([]);
    unarchiveChannel(db, channelId, workspaceId);
    expect(unreadFor(db, workspaceId, a)).toEqual([
      { conversationId: conv, channelId, lastReadSeq: 1, latestSeq: 2, unread: true, mentions: 0 },
    ]);
  });
});

describe("listedChannelIds", () => {
  it("보관하지 않은 채널을 대화가 없어도 싣고, 보관한 채널·다른 워크스페이스는 뺀다", async () => {
    const { db, workspaceId, a, channelId } = setup();
    const empty = addChannel(db, workspaceId, a, "empty", false);
    const archived = addChannel(db, workspaceId, a, "archived");
    seedChannelWithAgent(db, { channelName: "elsewhere" });
    await archiveChannel(archiveDeps(db), archived.id, workspaceId);

    expect(listedChannelIds(db, workspaceId, a).sort()).toEqual([channelId, empty.id].sort());
  });
});
