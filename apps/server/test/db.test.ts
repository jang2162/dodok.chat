import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import * as authSchema from "../src/db/auth-schema";
import { createDb, type Db } from "../src/db/client";
import * as schema from "../src/db/schema.sqlite";
import { channels, invites, memberships, messages, users, workspaces } from "../src/db/schema.sqlite";
import { migrationsFolder } from "../src/runtime";

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
  it("마이그레이션이 22개 테이블을 만든다(FTS5 그림자 테이블 제외)", () => {
    const db = createDb(":memory:");
    const rows = db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`);
    const names = rows
      .map((r) => r.name)
      .filter((n) => !n.startsWith("__") && !n.startsWith("sqlite_") && !n.startsWith("messages_fts_"))
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
      "invites",
      "memberships",
      "messages",
      "messages_fts",
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

  it("users (workspace_id, email): NULL 은 여러 개, 같은 이메일은 거부", () => {
    const db = createDb(":memory:");
    const { ws } = seed(db);
    const user = (handle: string, email: string | null) =>
      db
        .insert(users)
        .values({
          id: uuid(),
          workspaceId: ws,
          handle,
          displayName: handle,
          email,
          authProvider: "local",
          createdAt: new Date(),
        })
        .run();
    user("left-aaaaaaaa", null);
    user("left-bbbbbbbb", null);
    user("bee", "bee@example.com");
    expect(() => user("bee2", "bee@example.com")).toThrow(/UNIQUE/);
  });

  it("invites token_hash 는 UNIQUE, 초대를 만든 사람·대상은 users 를 가리킨다", () => {
    const db = createDb(":memory:");
    const { ws, user } = seed(db);
    const row = (tokenHash: string, createdBy = user) => ({
      id: uuid(),
      workspaceId: ws,
      kind: "invite" as const,
      role: "member" as const,
      tokenHash,
      prefix: "dit_abcd",
      createdBy,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    db.insert(invites).values(row("h1")).run();
    expect(() => db.insert(invites).values(row("h1")).run()).toThrow(/UNIQUE/);
    expect(() => db.insert(invites).values(row("h2", uuid())).run()).toThrow(/FOREIGN KEY/);
    expect(db.select().from(invites).get()).toMatchObject({ usedAt: null, usedBy: null, revokedAt: null });
  });

  it("0007 까지 적용된 DB(owner 한 명)에 뒤 마이그레이션을 얹어도 owner 행이 그대로다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const src = migrationsFolder();
      const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as {
        entries: Array<{ tag: string }>;
      };
      const idx = journal.entries.findIndex((e) => e.tag.endsWith("_search_fts")) + 1;
      expect(idx).toBeGreaterThan(1);
      const older = join(dir, "older");
      mkdirSync(join(older, "meta"), { recursive: true });
      writeFileSync(
        join(older, "meta/_journal.json"),
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, idx) }),
      );
      for (const e of journal.entries.slice(0, idx))
        copyFileSync(join(src, `${e.tag}.sql`), join(older, `${e.tag}.sql`));

      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const ws = uuid();
        const owner = uuid();
        const createdAt = new Date("2026-09-01T00:00:00.000Z");
        // 0007 의 users 에는 left_handle 이 없다 — 스키마 객체 대신 SQL 로 넣는다
        db.run(
          sql`INSERT INTO workspaces (id, name, created_at) VALUES (${ws}, 'w', ${createdAt.getTime()})`,
        );
        db.run(sql`INSERT INTO users (id, workspace_id, handle, display_name, email, auth_provider, created_at)
          VALUES (${owner}, ${ws}, 'owner', 'Owner', 'owner@dodok.local', 'local', ${createdAt.getTime()})`);
        db.run(
          sql`INSERT INTO memberships (id, workspace_id, user_id, role) VALUES (${uuid()}, ${ws}, ${owner}, 'owner')`,
        );

        migrate(db, { migrationsFolder: src });

        expect(db.select().from(users).where(eq(users.id, owner)).get()).toEqual({
          id: owner,
          workspaceId: ws,
          handle: "owner",
          displayName: "Owner",
          email: "owner@dodok.local",
          authProvider: "local",
          avatarUrl: null,
          createdAt,
          leftHandle: null,
        });
        expect(db.select().from(memberships).all()).toMatchObject([{ userId: owner, role: "owner" }]);
        expect(db.select().from(invites).all()).toEqual([]);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
