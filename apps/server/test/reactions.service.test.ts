/**
 * 리액션 서비스(리액션 스펙 5.1) — 켜기/끄기·집계·「에이전트에게 아직 안 알린 것」 질의·커서.
 * 메시지·리액션은 시각을 정해 DB 에 직접 넣는다 — 커서 비교(created_at > since)를 시계 없이 재려고.
 */
import { type Message, REACTION_EMOJIS } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { agentSessions, agents, channels, messageReactions, messages, users } from "../src/db/schema.sqlite";
import { allocateSeq } from "../src/modules/messages/seq";
import { hydrateForClient, rowToMessage } from "../src/modules/messages/service";
import {
  advanceReactionCursor,
  pendingReactionsFor,
  setReaction,
  withReactions,
} from "../src/modules/reactions/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";

const T0 = new Date("2026-10-07T00:00:00.000Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

function setup() {
  const db = newTestDb();
  const seeded = seedChannelWithAgent(db);
  const bus = new ServerBus();
  const updated: Message[] = [];
  bus.on("message.updated", (p) => updated.push(p.message));
  const addUser = (handle: string): string => {
    const id = uuid();
    db.insert(users)
      .values({
        id,
        workspaceId: seeded.workspaceId,
        handle,
        displayName: handle,
        authProvider: "local",
        createdAt: T0,
      })
      .run();
    return id;
  };
  const mia = addUser("mia");
  return { db, bus, updated, addUser, mia, ...seeded };
}
type Ctx = ReturnType<typeof setup>;

type Post = {
  channelId: string;
  authorType?: "user" | "agent" | "system";
  authorId: string;
  threadRootId?: string;
  bodyMd?: string;
  mentionUsers?: string[];
};
function post(db: Db, p: Post): string {
  return db.transaction((tx) => {
    const id = uuid();
    tx.insert(messages)
      .values({
        id,
        channelId: p.channelId,
        seq: allocateSeq(tx, p.channelId),
        kind: p.authorType === "system" ? "system" : "normal",
        authorType: p.authorType ?? "agent",
        authorId: p.authorType === "system" ? null : p.authorId,
        bodyMd: p.bodyMd ?? "답",
        mentions: { agents: [], users: p.mentionUsers ?? [] },
        threadRootId: p.threadRootId ?? null,
        createdAt: T0,
      })
      .run();
    return id;
  });
}
const react = (db: Db, messageId: string, userId: string, emoji: string, when: Date) =>
  db.insert(messageReactions).values({ messageId, userId, emoji, createdAt: when }).run();

const set = (c: Ctx, userId: string, messageId: string, emoji: string, on: boolean, now = at(1)) =>
  setReaction(c.db, c.bus, c.workspaceId, userId, { messageId, emoji: emoji as never, on }, now);

describe("setReaction", () => {
  it("켜기 → 행 1·이벤트 1, 같은 켜기 다시 → 이벤트 없음, 끄기 → 행 0·이벤트 1, 같은 끄기 다시 → 이벤트 없음", () => {
    const c = setup();
    const m = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    const rows = () => c.db.select().from(messageReactions).all();

    set(c, c.mia, m, "👍", true);
    expect(rows()).toHaveLength(1);
    expect(c.updated.map((u) => u.id)).toEqual([m]);

    set(c, c.mia, m, "👍", true);
    expect(rows()).toHaveLength(1);
    expect(c.updated).toHaveLength(1);

    set(c, c.mia, m, "👍", false);
    expect(rows()).toHaveLength(0);
    expect(c.updated).toHaveLength(2);

    set(c, c.mia, m, "👍", false);
    expect(c.updated).toHaveLength(2);
  });

  it("같은 켜기를 다시 해도 처음 단 시각이 남는다(커서 비교가 되살아나지 않게)", () => {
    const c = setup();
    const m = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    set(c, c.mia, m, "👍", true, at(1));
    set(c, c.mia, m, "👍", true, at(50));
    expect(c.db.select().from(messageReactions).get()?.createdAt).toEqual(at(1));
  });

  it("시스템 메시지는 VALIDATION, 없는 메시지·다른 워크스페이스는 NOT_FOUND", () => {
    const c = setup();
    const sys = post(c.db, { channelId: c.channelId, authorType: "system", authorId: "" });
    expect(() => set(c, c.mia, sys, "👍", true)).toThrow(
      expect.objectContaining({ body: expect.objectContaining({ code: "VALIDATION" }) }),
    );
    expect(() => set(c, c.mia, uuid(), "👍", true)).toThrow(
      expect.objectContaining({ body: expect.objectContaining({ code: "NOT_FOUND" }) }),
    );

    const m = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    expect(() =>
      setReaction(c.db, c.bus, uuid(), c.mia, { messageId: m, emoji: "👍", on: true }, at(1)),
    ).toThrow(expect.objectContaining({ body: expect.objectContaining({ code: "NOT_FOUND" }) }));
    expect(c.db.select().from(messageReactions).all()).toHaveLength(0);
  });

  it("보관한 채널의 메시지는 켜기·끄기 모두 CHANNEL_ARCHIVED 이고 이미 달린 것은 그대로다", () => {
    const c = setup();
    const m = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    set(c, c.mia, m, "👍", true);
    c.updated.length = 0;
    c.db
      .update(channels)
      .set({ archivedAt: at(5) })
      .where(eq(channels.id, c.channelId))
      .run();

    expect(() => set(c, c.mia, m, "👎", true)).toThrow(
      expect.objectContaining({ body: expect.objectContaining({ code: "CHANNEL_ARCHIVED" }) }),
    );
    expect(() => set(c, c.mia, m, "👍", false)).toThrow(
      expect.objectContaining({ body: expect.objectContaining({ code: "CHANNEL_ARCHIVED" }) }),
    );
    expect(c.db.select().from(messageReactions).all()).toHaveLength(1);
    expect(c.updated).toHaveLength(0);
  });
});

describe("withReactions", () => {
  it("이모지는 REACTION_EMOJIS 순, userIds 는 단 순서, 리액션 없는 메시지는 []", () => {
    const c = setup();
    const m = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    const bare = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    // ❓ 를 먼저 달아도 👍 뒤에 온다. 👍 은 owner 가 먼저, mia 가 나중
    react(c.db, m, c.mia, "❓", at(1));
    react(c.db, m, c.userId, "👍", at(2));
    react(c.db, m, c.mia, "👍", at(3));

    const out = withReactions(
      c.db,
      [m, bare].map((id) => rowToMessage(c.db.select().from(messages).where(eq(messages.id, id)).get()!)),
    );
    expect(out[0]?.reactions).toEqual([
      { emoji: "👍", count: 2, userIds: [c.userId, c.mia] },
      { emoji: "❓", count: 1, userIds: [c.mia] },
    ]);
    expect(out[1]?.reactions).toEqual([]);
    expect(REACTION_EMOJIS.indexOf("👍")).toBeLessThan(REACTION_EMOJIS.indexOf("❓"));
  });

  it("hydrateForClient 가 리액션을 붙인다", () => {
    const c = setup();
    const m = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    react(c.db, m, c.mia, "🎉", at(1));
    const row = c.db.select().from(messages).where(eq(messages.id, m)).get()!;
    expect(hydrateForClient(c.db, [rowToMessage(row)])[0]?.reactions).toEqual([
      { emoji: "🎉", count: 1, userIds: [c.mia] },
    ]);
  });

  it("메시지가 없으면 질의 없이 그대로 돌려준다", () => {
    const c = setup();
    expect(withReactions(c.db, [])).toEqual([]);
  });
});

describe("pendingReactionsFor", () => {
  const channelScope = (c: Ctx, since: Date | null, agentId = c.agentId) => ({
    channelId: c.channelId,
    agentId,
    threadRootId: null,
    since,
  });

  it("since 가 null 이면 빈 결과(실을 것이 없다)", () => {
    const c = setup();
    const m = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    react(c.db, m, c.mia, "👍", at(5));
    expect(pendingReactionsFor(c.db, channelScope(c, null))).toEqual({ reactions: [] });
  });

  it("채널 범위는 그 에이전트의 최상위 메시지만 — 스레드 루트 포함, 스레드 답글·사람·다른 에이전트 메시지·시스템 제외", () => {
    const c = setup();
    const otherAgent = uuid();
    c.db
      .insert(agents)
      .values({
        id: otherAgent,
        workspaceId: c.workspaceId,
        provider: "openclaw",
        providerAgentId: "fin",
        handle: "fin",
        name: "fin",
        createdAt: T0,
      })
      .run();
    const top = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    const root = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    const reply = post(c.db, { channelId: c.channelId, authorId: c.agentId, threadRootId: root });
    const human = post(c.db, { channelId: c.channelId, authorType: "user", authorId: c.userId });
    const other = post(c.db, { channelId: c.channelId, authorId: otherAgent });
    const elsewhere = seedChannelOf(c);
    const foreignChannel = post(c.db, { channelId: elsewhere, authorId: c.agentId });
    for (const [i, id] of [top, root, reply, human, other, foreignChannel].entries())
      react(c.db, id, c.mia, "👍", at(10 + i));

    const out = pendingReactionsFor(c.db, channelScope(c, at(0)));
    expect(out.reactions.map((r) => r.messageId)).toEqual([top, root]);
    expect(out.omitted).toBeUndefined();
  });

  it("스레드 범위는 루트 + 그 스레드 답글 — 다른 스레드·최상위 글 제외", () => {
    const c = setup();
    const root = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    const reply = post(c.db, { channelId: c.channelId, authorId: c.agentId, threadRootId: root });
    const otherRoot = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    const otherReply = post(c.db, { channelId: c.channelId, authorId: c.agentId, threadRootId: otherRoot });
    for (const [i, id] of [root, reply, otherRoot, otherReply].entries())
      react(c.db, id, c.mia, "👀", at(10 + i));

    const out = pendingReactionsFor(c.db, {
      channelId: c.channelId,
      agentId: c.agentId,
      threadRootId: root,
      since: at(0),
    });
    expect(out.reactions.map((r) => r.messageId)).toEqual([root, reply]);
  });

  it("since 와 같거나 이른 리액션은 뺀다 — 이후만", () => {
    const c = setup();
    const m = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    react(c.db, m, c.mia, "👍", at(5));
    react(c.db, m, c.userId, "👍", at(6));
    const out = pendingReactionsFor(c.db, channelScope(c, at(5)));
    expect(out.reactions.map((r) => r.by)).toEqual(["owner"]);
    expect(out.latestAt).toEqual(at(6));
  });

  it("알리기 전에 지운 리액션은 없다", () => {
    const c = setup();
    const m = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    set(c, c.mia, m, "👍", true, at(5));
    set(c, c.mia, m, "👍", false, at(6));
    expect(pendingReactionsFor(c.db, channelScope(c, at(0))).reactions).toEqual([]);
  });

  it("25개면 최근 20개를 at 오름차순으로, omitted 5, latestAt 은 가장 늦은 것", () => {
    const c = setup();
    const m = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    const emojis = [...REACTION_EMOJIS];
    // 사용자 25명 × 이모지 하나 — 시각은 1..25초
    const users25 = Array.from({ length: 25 }, (_, i) => c.addUser(`u${String(i).padStart(2, "0")}`));
    users25.forEach((u, i) => react(c.db, m, u, emojis[i % emojis.length] as string, at(i + 1)));

    const out = pendingReactionsFor(c.db, channelScope(c, at(0)));
    expect(out.reactions).toHaveLength(20);
    expect(out.omitted).toBe(5);
    expect(out.reactions.map((r) => r.by)).toEqual(
      users25.slice(5).map((_, i) => `u${String(i + 5).padStart(2, "0")}`),
    );
    expect(out.reactions[0]?.at).toBe(at(6).toISOString());
    expect(out.latestAt).toEqual(at(25));
  });

  it("비활성 멤버의 리액션도 by 가 그 핸들이다", () => {
    const c = setup();
    const m = post(c.db, { channelId: c.channelId, authorId: c.agentId });
    const gone = c.addUser("gone");
    // 멤버 비활성화는 users 행을 건드리지 않는다(계정·핸들이 남는다) — 질의는 u.handle 을 읽는다
    react(c.db, m, gone, "✅", at(5));
    expect(pendingReactionsFor(c.db, channelScope(c, at(0))).reactions[0]?.by).toBe("gone");
  });

  it("excerpt 는 멘션 토큰이 @핸들로 풀리고 마크다운 표시가 걷힌 앞 60자다", () => {
    const c = setup();
    const m = post(c.db, {
      channelId: c.channelId,
      authorId: c.agentId,
      bodyMd: `**<@u:${c.mia}>** 님, ${"가".repeat(80)}`,
      mentionUsers: [c.mia],
    });
    react(c.db, m, c.userId, "👍", at(5));
    const excerpt = pendingReactionsFor(c.db, channelScope(c, at(0))).reactions[0]?.excerpt;
    expect(excerpt?.startsWith("@mia 님, 가가")).toBe(true);
    expect(excerpt?.length).toBe(60);
  });
});

describe("advanceReactionCursor", () => {
  it("올리기만 하고 뒤로 가지 않는다", () => {
    const c = setup();
    const sessionId = uuid();
    c.db
      .insert(agentSessions)
      .values({
        id: sessionId,
        channelId: c.channelId,
        agentId: c.agentId,
        sessionKey: "k",
        promptRevisionAtStart: 1,
        reactionsSeenAt: at(10),
      })
      .run();
    const read = () =>
      c.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()?.reactionsSeenAt;

    advanceReactionCursor(c.db, sessionId, at(20));
    expect(read()).toEqual(at(20));
    advanceReactionCursor(c.db, sessionId, at(15));
    expect(read()).toEqual(at(20));
  });

  it("커서가 null 인 행은 주어진 시각으로 채운다", () => {
    const c = setup();
    const sessionId = uuid();
    c.db
      .insert(agentSessions)
      .values({
        id: sessionId,
        channelId: c.channelId,
        agentId: c.agentId,
        sessionKey: "k",
        promptRevisionAtStart: 1,
      })
      .run();
    advanceReactionCursor(c.db, sessionId, at(7));
    expect(c.db.select().from(agentSessions).get()?.reactionsSeenAt).toEqual(at(7));
  });
});

/** 같은 워크스페이스의 다른 채널 — 범위 질의가 채널 밖을 안 보는지 */
function seedChannelOf(c: Ctx): string {
  const id = uuid();
  c.db
    .insert(channels)
    .values({
      id,
      workspaceId: c.workspaceId,
      name: "other",
      relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
      visibility: "public",
      createdBy: c.userId,
      createdAt: T0,
    })
    .run();
  return id;
}
