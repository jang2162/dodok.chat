/**
 * 스레드 소식(docs/superpowers/specs/2026-11-24-channel-thread-updates-design.md) — 대화 세션 런에 실을 「지난 턴 뒤 그 대화의
 * 스레드에 새로 달린 답글」 고르기와 커서. 메시지는 시각을 정해 DB 에 직접 넣는다 — 커서 비교(created_at > since)를 시계 없이 재려고.
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Attachment, InboundThreadUpdate } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { agentSessions, messages, users } from "../src/db/schema.sqlite";
import { allocateSeq } from "../src/modules/messages/seq";
import { updateAgent } from "../src/modules/agents/service";
import { ensureSession, getSessionRow, renewSessionOnPromptChange } from "../src/modules/sessions/service";
import { advanceThreadRepliesCursor, pendingThreadUpdatesFor } from "../src/modules/thread-updates/service";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent, seedConversation } from "./helpers/seed";

const T0 = new Date("2026-11-24T08:00:00.000Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

function setup() {
  const db = newTestDb();
  const seeded = seedChannelWithAgent(db);
  const mia = uuid();
  db.insert(users)
    .values({
      id: mia,
      workspaceId: seeded.workspaceId,
      handle: "mia",
      displayName: "Mia",
      authProvider: "local",
      createdAt: T0,
    })
    .run();
  return { db, mia, ...seeded };
}
type Ctx = ReturnType<typeof setup>;

type Post = {
  conversationId?: string;
  authorType?: "user" | "agent" | "system";
  authorId?: string;
  threadRootId?: string;
  bodyMd?: string;
  attachments?: Attachment[];
  when?: Date;
};
function post(c: Ctx, p: Post = {}): string {
  return c.db.transaction((tx) => {
    const id = uuid();
    tx.insert(messages)
      .values({
        id,
        channelId: c.channelId,
        conversationId: p.conversationId ?? c.conversationId,
        seq: allocateSeq(tx, c.channelId),
        kind: p.authorType === "system" ? "system" : "normal",
        authorType: p.authorType ?? "user",
        authorId: p.authorType === "system" ? null : (p.authorId ?? c.mia),
        bodyMd: p.bodyMd ?? "답",
        mentions: { agents: [], users: [] },
        attachments: p.attachments ?? [],
        threadRootId: p.threadRootId ?? null,
        createdAt: p.when ?? T0,
      })
      .run();
    return id;
  });
}
const reply = (c: Ctx, root: string, sec: number, over: Post = {}) =>
  post(c, { threadRootId: root, when: at(sec), bodyMd: `답 ${sec}`, ...over });
const pending = (c: Ctx, since: Date | null, conversationId = c.conversationId) =>
  pendingThreadUpdatesFor(c.db, { conversationId, since });

describe("pendingThreadUpdatesFor", () => {
  it("since 가 null 이면 빈 결과", () => {
    const c = setup();
    const root = post(c);
    reply(c, root, 5);
    expect(pending(c, null)).toEqual({ updates: [] });
  });

  it("커서 뒤 답글만, 배열은 마지막 활동 오름차순(오래된 것부터 읽히게)", () => {
    const c = setup();
    const a = post(c, { bodyMd: "스레드 A" });
    const b = post(c, { bodyMd: "스레드 B" });
    reply(c, a, 1);
    reply(c, a, 5);
    reply(c, b, 3);
    const out = pending(c, at(2));
    expect(out.updates.map((u) => u.rootId)).toEqual([b, a]);
    const ua = out.updates[1];
    expect(ua?.newReplies).toBe(1);
    expect(ua?.recent.map((m) => m.text)).toEqual(["답 5"]);
    expect(ua?.rootExcerpt).toBe("스레드 A");
    expect(out.latestAt).toEqual(at(5));
    expect(out.omitted).toBeUndefined();
    for (const u of out.updates) expect(InboundThreadUpdate.safeParse(u).success).toBe(true);
  });

  it("since 와 같은 시각의 답글은 뺀다 — 이후만", () => {
    const c = setup();
    const root = post(c);
    reply(c, root, 5);
    expect(pending(c, at(5)).updates).toEqual([]);
  });

  it("스레드 6개면 가장 오래된 1개가 밀려 omitted=1, latestAt 은 밀린 것까지 포함한 최댓값", () => {
    const c = setup();
    const roots = Array.from({ length: 6 }, () => post(c));
    // 첫 루트가 가장 늦게 활동한다 — 가장 오래된 활동은 둘째 루트
    roots.forEach((r, i) => reply(c, r, i === 0 ? 100 : 10 + i));
    const out = pending(c, at(0));
    expect(out.updates).toHaveLength(5);
    expect(out.omitted).toBe(1);
    expect(out.updates.map((u) => u.rootId)).not.toContain(roots[1]);
    expect(out.updates.at(-1)?.rootId).toBe(roots[0]);
    expect(out.latestAt).toEqual(at(100));
  });

  it("스레드가 밀려도 latestAt 은 고려한 답글 전체의 최댓값 — 밀린 스레드(활동이 가장 오래됨)는 최댓값을 바꾸지 않는다", () => {
    const c = setup();
    const roots = Array.from({ length: 6 }, () => post(c));
    roots.forEach((r, i) => reply(c, r, 10 + i));
    const out = pending(c, at(0));
    expect(out.omitted).toBe(1);
    expect(out.updates.map((u) => u.rootId)).not.toContain(roots[0]);
    expect(out.latestAt).toEqual(at(15));
  });

  it("스레드당 새 답글 5개면 recent 는 마지막 3개, newReplies=5", () => {
    const c = setup();
    const root = post(c);
    for (let s = 1; s <= 5; s++) reply(c, root, s);
    const [u] = pending(c, at(0)).updates;
    expect(u?.newReplies).toBe(5);
    expect(u?.recent.map((m) => m.text)).toEqual(["답 3", "답 4", "답 5"]);
  });

  it("다른 대화의 답글은 싣지 않는다 — 같은 채널의 다른 세션", () => {
    const c = setup();
    const other = seedConversation(c.db, c.channelId, { createdBy: c.userId, createdAt: T0 });
    const otherRoot = post(c, { conversationId: other });
    reply(c, otherRoot, 5, { conversationId: other });
    expect(pending(c, at(0))).toEqual({ updates: [] });
    expect(pending(c, at(0), other).updates.map((u) => u.rootId)).toEqual([otherRoot]);
  });

  it("normal 만 — 스레드 안 system 답글은 세지도 싣지도 않는다", () => {
    const c = setup();
    const root = post(c);
    reply(c, root, 3);
    reply(c, root, 5, { authorType: "system" });
    const out = pending(c, at(0));
    expect(out.updates[0]?.newReplies).toBe(1);
    expect(out.updates[0]?.recent.map((m) => m.text)).toEqual(["답 3"]);
    expect(out.latestAt).toEqual(at(3));
  });

  it("최상위 글은 스레드 소식이 아니다", () => {
    const c = setup();
    post(c, { when: at(5) });
    expect(pending(c, at(0))).toEqual({ updates: [] });
  });

  it("첨부만 있는 답글은 자리표시", () => {
    const c = setup();
    const root = post(c);
    const img: Attachment = {
      id: uuid(),
      kind: "image",
      url: "https://x.test/a.png",
      name: "a.png",
      mime: "image/png",
      size: 1,
    };
    reply(c, root, 5, { bodyMd: "", attachments: [img] });
    expect(pending(c, at(0)).updates[0]?.recent[0]?.text).toBe("[이미지 1장]");
  });

  it("답글 본문은 300자에서 자른다 — 서러게이트 쌍을 가르지 않는다", () => {
    const c = setup();
    const root = post(c);
    reply(c, root, 5, { bodyMd: "가".repeat(400) });
    reply(c, root, 6, { bodyMd: `${"가".repeat(299)}😀끝` });
    const recent = pending(c, at(0)).updates[0]?.recent ?? [];
    expect(recent[0]?.text).toBe("가".repeat(300));
    expect(recent[1]?.text).toBe("가".repeat(299));
  });

  it("루트 발췌는 60자 이내", () => {
    const c = setup();
    const root = post(c, { bodyMd: "루".repeat(200) });
    reply(c, root, 5);
    const ex = pending(c, at(0)).updates[0]?.rootExcerpt ?? "";
    expect(ex.length).toBeLessThanOrEqual(60);
    expect(ex.startsWith("루루루")).toBe(true);
  });

  it("이 에이전트 자신의 답글도 싣는다 — 작성자는 가리지 않는다", () => {
    const c = setup();
    const root = post(c);
    reply(c, root, 5, { authorType: "agent", authorId: c.agentId, bodyMd: "제가 잘못 말했습니다" });
    const m = pending(c, at(0)).updates[0]?.recent[0];
    expect(m?.author).toMatchObject({ type: "agent", handle: "dev" });
    expect(m?.text).toBe("제가 잘못 말했습니다");
  });
});

describe("스레드 답글 커서", () => {
  it("ensureSession 새 대화 행의 threadRepliesSeenAt 은 만든 시각", () => {
    const c = setup();
    const before = Date.now();
    const { session } = ensureSession(c.db, new FakeAdapter(), {
      conversationId: c.conversationId,
      agentId: c.agentId,
    });
    expect(session.threadRepliesSeenAt).not.toBeNull();
    expect(session.threadRepliesSeenAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(session.threadRepliesSeenAt?.getTime()).toEqual(session.reactionsSeenAt?.getTime());
  });

  it("renewSessionOnPromptChange 가 threadRepliesSeenAt 을 지금으로 올린다", () => {
    const c = setup();
    const { session } = ensureSession(c.db, new FakeAdapter(), {
      conversationId: c.conversationId,
      agentId: c.agentId,
    });
    c.db
      .update(agentSessions)
      .set({ threadRepliesSeenAt: at(0) })
      .where(eq(agentSessions.id, session.id))
      .run();
    updateAgent(c.db, c.agentId, { basePrompt: "새 지시" });
    const before = Date.now();
    renewSessionOnPromptChange(c.db, session.id);
    expect(getSessionRow(c.db, session.id)?.threadRepliesSeenAt?.getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
  });

  it("advanceThreadRepliesCursor 는 뒤로 가지 않고, null 이면 채운다", () => {
    const c = setup();
    const { session } = ensureSession(c.db, new FakeAdapter(), {
      conversationId: c.conversationId,
      agentId: c.agentId,
    });
    const seen = (db: Db) => getSessionRow(db, session.id)?.threadRepliesSeenAt;
    c.db
      .update(agentSessions)
      .set({ threadRepliesSeenAt: null })
      .where(eq(agentSessions.id, session.id))
      .run();
    advanceThreadRepliesCursor(c.db, session.id, at(10));
    expect(seen(c.db)).toEqual(at(10));
    advanceThreadRepliesCursor(c.db, session.id, at(5));
    expect(seen(c.db)).toEqual(at(10));
    advanceThreadRepliesCursor(c.db, session.id, at(20));
    expect(seen(c.db)).toEqual(at(20));
  });
});
