import { sql } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client";
import { channels, messages, users, workspaces } from "../src/db/schema.sqlite";

function seed(db: Db) {
  const ws = uuid();
  const user = uuid();
  const ch = uuid();
  db.insert(workspaces).values({ id: ws, name: "w", createdAt: new Date() }).run();
  db.insert(users)
    .values({
      id: user,
      workspaceId: ws,
      handle: "jang",
      displayName: "장",
      authProvider: "local",
      createdAt: new Date(),
    })
    .run();
  db.insert(channels)
    .values({
      id: ch,
      workspaceId: ws,
      name: "general",
      relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
      visibility: "public",
      createdBy: user,
      createdAt: new Date(),
    })
    .run();
  return { ws, user, ch };
}

const msg = (ch: string, seq: number, extra: Partial<typeof messages.$inferInsert> = {}) => ({
  id: uuid(),
  channelId: ch,
  seq,
  kind: "normal",
  authorType: "user",
  bodyMd: "hi",
  mentions: { agents: [], users: [] },
  createdAt: new Date(),
  ...extra,
});

describe("db", () => {
  it("마이그레이션이 20개 테이블을 만든다", () => {
    const db = createDb(":memory:");
    const rows = db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`);
    const names = rows
      .map((r) => r.name)
      .filter((n) => !n.startsWith("__") && !n.startsWith("sqlite_"))
      .sort();
    expect(names).toEqual([
      "account",
      "agent_sessions",
      "agents",
      "approvals",
      "attachments",
      "bridge_tokens",
      "channel_members",
      "channels",
      "component_interactions",
      "memberships",
      "messages",
      "ops_events",
      "push_subscriptions",
      "run_events",
      "runs",
      "session",
      "user",
      "users",
      "verification",
      "workspaces",
    ]);
  });

  it("messages (channel_id, seq)는 UNIQUE", () => {
    const db = createDb(":memory:");
    const { ch } = seed(db);
    db.insert(messages).values(msg(ch, 1)).run();
    expect(() => db.insert(messages).values(msg(ch, 1)).run()).toThrow(/UNIQUE/);
  });

  it("client_msg_id: NULL은 여러 개, 같은 (author_id, client_msg_id)는 거부", () => {
    const db = createDb(":memory:");
    const { ch, user } = seed(db);
    db.insert(messages).values(msg(ch, 1)).run();
    db.insert(messages).values(msg(ch, 2)).run();
    db.insert(messages)
      .values(msg(ch, 3, { authorId: user, clientMsgId: "c1" }))
      .run();
    expect(() =>
      db
        .insert(messages)
        .values(msg(ch, 4, { authorId: user, clientMsgId: "c1" }))
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("JSON·timestamp 컬럼이 왕복한다", () => {
    const db = createDb(":memory:");
    const { ch } = seed(db);
    const row = db.select().from(channels).get();
    expect(row?.id).toBe(ch);
    expect(row?.relayPolicy).toEqual({ maxRelayTurns: 4, allowPairs: "all" });
    expect(row?.createdAt).toBeInstanceOf(Date);
    expect(row?.lastSeq).toBe(0);
  });

  it("foreign_keys ON: 없는 채널에 메시지 삽입 거부", () => {
    const db = createDb(":memory:");
    seed(db);
    expect(() => db.insert(messages).values(msg(uuid(), 1)).run()).toThrow(/FOREIGN KEY/);
  });
});
