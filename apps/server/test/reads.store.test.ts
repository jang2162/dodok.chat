/**
 * 읽음 위치 저장소(읽지 않음 스펙 「무엇이 「안 읽음」인가」·「서버」 절) — 읽음 위치는 커지기만 하고 last_seq 로 깎이며, 현황은
 * 남이 쓴 최상위 보통 메시지(굵게)와 나를 멘션한 보통 메시지(배지, 스레드 답글 포함·99 에서 자름)를 센다.
 */
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { channelReads, channels, messages, users } from "../src/db/schema.sqlite";
import { archiveChannel, unarchiveChannel } from "../src/modules/channels/service";
import { allocateSeq } from "../src/modules/messages/seq";
import { markRead, unreadFor } from "../src/modules/reads/store";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";

const NOW = new Date("2026-10-06T00:00:00.000Z");

function setup() {
  const db = newTestDb();
  const { workspaceId, userId: a, agentId, channelId } = seedChannelWithAgent(db);
  const b = uuid();
  db.insert(users)
    .values({ id: b, workspaceId, handle: "bee", displayName: "Bee", authProvider: "local", createdAt: NOW })
    .run();
  return { db, workspaceId, a, b, agentId, channelId };
}

function addChannel(db: Db, workspaceId: string, createdBy: string, name: string): string {
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
  return id;
}

type Post = {
  authorType: "user" | "agent" | "system";
  authorId?: string;
  threadRootId?: string;
  mentionUsers?: string[];
};

/** 메시지 하나를 seq 를 받아 넣는다 — 시스템 메시지는 kind system·작성자 없음(messages/service.ts createSystemMessage 와 같은 꼴) */
function post(db: Db, channelId: string, p: Post): { id: string; seq: number } {
  return db.transaction((tx) => {
    const seq = allocateSeq(tx, channelId);
    const id = uuid();
    tx.insert(messages)
      .values({
        id,
        channelId,
        seq,
        kind: p.authorType === "system" ? "system" : "normal",
        authorType: p.authorType,
        authorId: p.authorType === "system" ? null : (p.authorId ?? null),
        bodyMd: "hi",
        mentions: { agents: [], users: p.mentionUsers ?? [] },
        threadRootId: p.threadRootId ?? null,
        createdAt: NOW,
      })
      .run();
    return { id, seq };
  });
}

function lastSeq(db: Db, channelId: string): number {
  return db.select({ s: channels.lastSeq }).from(channels).where(eq(channels.id, channelId)).get()!.s;
}

function readRow(db: Db, userId: string, channelId: string) {
  return db
    .select()
    .from(channelReads)
    .all()
    .find((r) => r.userId === userId && r.channelId === channelId);
}

function unreadOf(db: Db, workspaceId: string, userId: string, channelId: string) {
  return unreadFor(db, workspaceId, userId).find((c) => c.channelId === channelId);
}

const archiveDeps = (db: Db) => ({
  db,
  orchestrator: { activeRuns: () => [], abort: async () => {} },
});

describe("markRead", () => {
  it("커지기만 한다 — 5 뒤 3 이면 돌려준 값과 행 모두 5", () => {
    const { db, workspaceId, a, b, channelId } = setup();
    for (let i = 0; i < 7; i++) post(db, channelId, { authorType: "user", authorId: b });

    expect(markRead(db, workspaceId, a, channelId, 5, NOW)).toBe(5);
    expect(markRead(db, workspaceId, a, channelId, 3, new Date(NOW.getTime() + 1000))).toBe(5);
    expect(readRow(db, a, channelId)).toMatchObject({ lastReadSeq: 5 });
  });

  it("행을 처음 만들 때 updated_at 을 그 시각으로 둔다", () => {
    const { db, workspaceId, a, b, channelId } = setup();
    post(db, channelId, { authorType: "user", authorId: b });

    markRead(db, workspaceId, a, channelId, 1, NOW);
    expect(readRow(db, a, channelId)).toEqual({ userId: a, channelId, lastReadSeq: 1, updatedAt: NOW });
  });

  it("기존 행을 올리면 updated_at 도 그 시각으로 바꾼다", () => {
    const { db, workspaceId, a, b, channelId } = setup();
    post(db, channelId, { authorType: "user", authorId: b });
    post(db, channelId, { authorType: "user", authorId: b });
    const later = new Date(NOW.getTime() + 60_000);

    markRead(db, workspaceId, a, channelId, 1, NOW);
    markRead(db, workspaceId, a, channelId, 2, later);
    expect(readRow(db, a, channelId)).toEqual({ userId: a, channelId, lastReadSeq: 2, updatedAt: later });
  });

  it("요청 seq 를 채널의 last_seq 로 깎는다 — last_seq 7 에 50 이면 7", () => {
    const { db, workspaceId, a, b, channelId } = setup();
    for (let i = 0; i < 7; i++) post(db, channelId, { authorType: "user", authorId: b });

    expect(markRead(db, workspaceId, a, channelId, 50, NOW)).toBe(7);
    expect(readRow(db, a, channelId)).toMatchObject({ lastReadSeq: 7 });
  });

  it("없는 채널·다른 워크스페이스 채널은 NOT_FOUND 이고 행을 만들지 않는다", () => {
    const { db, workspaceId, a } = setup();
    const other = seedChannelWithAgent(db, { channelName: "other" });
    const notFound = expect.objectContaining({
      status: 404,
      body: expect.objectContaining({ code: "NOT_FOUND" }),
    });

    expect(() => markRead(db, workspaceId, a, uuid(), 1, NOW)).toThrow(notFound);
    expect(() => markRead(db, workspaceId, a, other.channelId, 0, NOW)).toThrow(notFound);
    expect(db.select().from(channelReads).all()).toEqual([]);
  });
});

describe("unreadFor", () => {
  it("행이 없으면 lastReadSeq 0, latestSeq 는 채널의 last_seq", () => {
    const { db, workspaceId, a, b, channelId } = setup();
    for (let i = 0; i < 3; i++) post(db, channelId, { authorType: "system" });

    expect(unreadFor(db, workspaceId, a)).toEqual([
      { channelId, lastReadSeq: 0, latestSeq: 3, unread: false, mentions: 0 },
    ]);
    post(db, channelId, { authorType: "user", authorId: b });
    expect(unreadOf(db, workspaceId, a, channelId)).toMatchObject({ latestSeq: lastSeq(db, channelId) });
  });

  it("남이 쓴 최상위 메시지는 굵게, 자기 글은 아니다", () => {
    const { db, workspaceId, a, b, channelId } = setup();
    post(db, channelId, { authorType: "user", authorId: b });

    expect(unreadOf(db, workspaceId, a, channelId)).toMatchObject({ unread: true, mentions: 0 });
    expect(unreadOf(db, workspaceId, b, channelId)).toMatchObject({ unread: false, mentions: 0 });
  });

  it("에이전트가 쓴 메시지도 굵게 한다", () => {
    const { db, workspaceId, a, agentId, channelId } = setup();
    post(db, channelId, { authorType: "agent", authorId: agentId });

    expect(unreadOf(db, workspaceId, a, channelId)).toMatchObject({ unread: true });
  });

  it("시스템 메시지만 있으면 굵게도 배지도 없다 — 멘션이 실려 있어도", () => {
    const { db, workspaceId, a, channelId } = setup();
    post(db, channelId, { authorType: "system" });
    // 시스템 메시지는 멘션을 싣지 않지만, 실려 있어도 kind 로 거른다
    db.transaction((tx) => {
      const seq = allocateSeq(tx, channelId);
      tx.insert(messages)
        .values({
          id: uuid(),
          channelId,
          seq,
          kind: "system",
          authorType: "system",
          authorId: null,
          bodyMd: "x",
          mentions: { agents: [], users: [a] },
          createdAt: NOW,
        })
        .run();
    });

    expect(unreadOf(db, workspaceId, a, channelId)).toMatchObject({ unread: false, mentions: 0 });
  });

  it("스레드 답글만 있으면 굵게 하지 않는다", () => {
    const { db, workspaceId, a, b, channelId } = setup();
    const root = post(db, channelId, { authorType: "user", authorId: a });
    post(db, channelId, { authorType: "user", authorId: b, threadRootId: root.id });

    expect(unreadOf(db, workspaceId, a, channelId)).toMatchObject({ unread: false, mentions: 0 });
  });

  it("스레드 답글 속 멘션은 굵게 없이 배지로 센다", () => {
    const { db, workspaceId, a, b, channelId } = setup();
    const root = post(db, channelId, { authorType: "user", authorId: a });
    post(db, channelId, { authorType: "user", authorId: b, threadRootId: root.id, mentionUsers: [a] });

    expect(unreadOf(db, workspaceId, a, channelId)).toMatchObject({ unread: false, mentions: 1 });
  });

  it("자기를 멘션한 자기 글은 배지에 넣지 않는다", () => {
    const { db, workspaceId, a, channelId } = setup();
    post(db, channelId, { authorType: "user", authorId: a, mentionUsers: [a] });

    expect(unreadOf(db, workspaceId, a, channelId)).toMatchObject({ unread: false, mentions: 0 });
  });

  it("다른 사람을 멘션한 글은 내 배지가 아니다", () => {
    const { db, workspaceId, a, b, agentId, channelId } = setup();
    post(db, channelId, { authorType: "agent", authorId: agentId, mentionUsers: [b] });

    expect(unreadOf(db, workspaceId, a, channelId)).toMatchObject({ unread: true, mentions: 0 });
    expect(unreadOf(db, workspaceId, b, channelId)).toMatchObject({ unread: true, mentions: 1 });
  });

  it("멘션 120개는 99 에서 자른다", () => {
    const { db, workspaceId, a, b, channelId } = setup();
    for (let i = 0; i < 120; i++) post(db, channelId, { authorType: "user", authorId: b, mentionUsers: [a] });

    expect(unreadOf(db, workspaceId, a, channelId)).toMatchObject({ unread: true, mentions: 99 });
  });

  it("읽음 위치 뒤의 것만 센다 — 끝까지 읽으면 굵게·배지 0", () => {
    const { db, workspaceId, a, b, channelId } = setup();
    post(db, channelId, { authorType: "user", authorId: b, mentionUsers: [a] });
    const mid = post(db, channelId, { authorType: "user", authorId: b });
    post(db, channelId, { authorType: "user", authorId: b, mentionUsers: [a] });

    markRead(db, workspaceId, a, channelId, mid.seq, NOW);
    expect(unreadOf(db, workspaceId, a, channelId)).toEqual({
      channelId,
      lastReadSeq: mid.seq,
      latestSeq: 3,
      unread: true,
      mentions: 1,
    });
    markRead(db, workspaceId, a, channelId, lastSeq(db, channelId), NOW);
    expect(unreadOf(db, workspaceId, a, channelId)).toEqual({
      channelId,
      lastReadSeq: 3,
      latestSeq: 3,
      unread: false,
      mentions: 0,
    });
  });

  it("그 워크스페이스의 채널만, 다른 사람의 읽음 위치는 섞이지 않는다", () => {
    const { db, workspaceId, a, b, channelId } = setup();
    const other = seedChannelWithAgent(db, { channelName: "other" });
    post(db, other.channelId, { authorType: "user", authorId: other.userId });
    post(db, channelId, { authorType: "user", authorId: b });

    markRead(db, workspaceId, b, channelId, 1, NOW);
    expect(unreadFor(db, workspaceId, a)).toEqual([
      { channelId, lastReadSeq: 0, latestSeq: 1, unread: true, mentions: 0 },
    ]);
  });

  it("같은 워크스페이스의 다른 채널로 새지 않는다 — X 의 글·멘션이 빈 Y·다 읽은 Z 를 굵게·배지로 만들지 않는다", () => {
    const { db, workspaceId, a, b, channelId: x } = setup();
    const y = addChannel(db, workspaceId, a, "y");
    const z = addChannel(db, workspaceId, a, "z");
    post(db, z, { authorType: "user", authorId: b, mentionUsers: [a] });
    markRead(db, workspaceId, a, z, 1, NOW);
    // Z 의 읽음 위치(1)보다 큰 seq 가 X 에 있어야 X 의 글이 Z 로 새는지 보인다
    post(db, x, { authorType: "user", authorId: b });
    post(db, x, { authorType: "user", authorId: b });
    post(db, x, { authorType: "user", authorId: b, mentionUsers: [a] });

    expect(unreadOf(db, workspaceId, a, x)).toMatchObject({ unread: true, mentions: 1 });
    expect(unreadOf(db, workspaceId, a, y)).toEqual({
      channelId: y,
      lastReadSeq: 0,
      latestSeq: 0,
      unread: false,
      mentions: 0,
    });
    expect(unreadOf(db, workspaceId, a, z)).toEqual({
      channelId: z,
      lastReadSeq: 1,
      latestSeq: 1,
      unread: false,
      mentions: 0,
    });
  });

  it("보관한 채널은 빠지고, 보관 해제하면 읽음 위치 그대로 다시 나온다", async () => {
    const { db, workspaceId, a, b, channelId } = setup();
    post(db, channelId, { authorType: "user", authorId: b });
    post(db, channelId, { authorType: "user", authorId: b });
    markRead(db, workspaceId, a, channelId, 1, NOW);

    await archiveChannel(archiveDeps(db), channelId, workspaceId);
    expect(unreadFor(db, workspaceId, a)).toEqual([]);
    unarchiveChannel(db, channelId, workspaceId);
    expect(unreadFor(db, workspaceId, a)).toEqual([
      { channelId, lastReadSeq: 1, latestSeq: 2, unread: true, mentions: 0 },
    ]);
  });
});
