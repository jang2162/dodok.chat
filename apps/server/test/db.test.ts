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
import {
  agents,
  bridgeTokens,
  channels,
  invites,
  memberships,
  messages,
  runnerTokens,
  users,
  workspaces,
} from "../src/db/schema.sqlite";
import { migrationsFolder } from "../src/runtime";

/** 저장소 마이그레이션 가운데 태그가 suffix 로 끝나는 것까지만 담은 폴더를 dir 아래에 만든다 — 옛 DB 를 흉내 낼 때 */
function migrationsUpTo(dir: string, suffix: string): string {
  const src = migrationsFolder();
  const journal = JSON.parse(readFileSync(join(src, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  const idx = journal.entries.findIndex((e) => e.tag.endsWith(suffix)) + 1;
  expect(idx).toBeGreaterThan(1);
  const older = join(dir, `upto${suffix}`);
  mkdirSync(join(older, "meta"), { recursive: true });
  writeFileSync(
    join(older, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, idx) }),
  );
  for (const e of journal.entries.slice(0, idx))
    copyFileSync(join(src, `${e.tag}.sql`), join(older, `${e.tag}.sql`));
  return older;
}

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
  it("마이그레이션이 23개 테이블을 만든다(FTS5 그림자 테이블 제외)", () => {
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
      "runner_tokens",
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
      const older = migrationsUpTo(dir, "_search_fts");

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
  it("0008 까지 적용된 DB 에 0009(runner_tokens)를 얹어도 브리지 토큰 행이 그대로고 러너 토큰 표는 비어 있다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_team_invites");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const ws = uuid();
        const tokenId = uuid();
        const createdAt = new Date("2026-09-25T00:00:00.000Z");
        db.insert(workspaces).values({ id: ws, name: "w", createdAt }).run();
        const bridgeRow = {
          id: tokenId,
          workspaceId: ws,
          label: "gw",
          hash: "b".repeat(64),
          prefix: "AAAAAA",
          createdAt,
          lastUsedAt: null,
          revokedAt: null,
        };
        db.insert(bridgeTokens).values(bridgeRow).run();
        expect(() => db.select().from(runnerTokens).all()).toThrow(/no such table/);

        migrate(db, { migrationsFolder: migrationsFolder() });

        expect(db.select().from(bridgeTokens).all()).toEqual([bridgeRow]);
        expect(db.select().from(runnerTokens).all()).toEqual([]);
        // 같은 해시는 두 번 못 넣는다 — 검증이 해시로 행 하나를 찾는다
        const runnerRow = { ...bridgeRow, id: uuid(), label: "laptop" };
        db.insert(runnerTokens).values(runnerRow).run();
        expect(() =>
          db
            .insert(runnerTokens)
            .values({ ...runnerRow, id: uuid() })
            .run(),
        ).toThrow(/UNIQUE/);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("0009 까지 적용된 DB 에 0010(push_subscriptions.session_id)을 얹으면 세션을 모르는 옛 구독 행은 지워지고, 새 행은 세션과 함께 지워진다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_runner_tokens");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        sqlite.pragma("foreign_keys = ON");
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const ws = uuid();
        const userId = uuid();
        const at = Date.parse("2026-09-25T00:00:00.000Z");
        db.run(sql`INSERT INTO workspaces (id, name, created_at) VALUES (${ws}, 'w', ${at})`);
        db.run(sql`INSERT INTO users (id, workspace_id, handle, display_name, auth_provider, created_at)
          VALUES (${userId}, ${ws}, 'mia', 'Mia', 'local', ${at})`);
        // 0009 의 push_subscriptions 에는 session_id 가 없다 — 스키마 객체 대신 SQL 로 넣는다
        db.run(sql`INSERT INTO push_subscriptions (id, user_id, endpoint, keys_json, user_agent, created_at)
          VALUES (${uuid()}, ${userId}, 'https://push.example/old', '{"p256dh":"p","auth":"a"}', NULL, ${at})`);

        migrate(db, { migrationsFolder: migrationsFolder() });

        expect(db.select().from(schema.pushSubscriptions).all()).toEqual([]);
        const now = new Date();
        db.insert(authSchema.user)
          .values({ id: userId, name: "mia", email: "mia@dodok.local", createdAt: now, updatedAt: now })
          .run();
        const sessionId = uuid();
        db.insert(authSchema.session)
          .values({ id: sessionId, token: uuid(), userId, expiresAt: now, createdAt: now, updatedAt: now })
          .run();
        const row = {
          id: uuid(),
          userId,
          sessionId,
          endpoint: "https://push.example/new",
          keys: { p256dh: "p", auth: "a" },
          userAgent: null,
          createdAt: now,
        };
        db.insert(schema.pushSubscriptions).values(row).run();
        expect(db.select().from(schema.pushSubscriptions).all()).toEqual([row]);
        // 세션이 없는 구독은 넣을 수 없다
        expect(() =>
          db
            .insert(schema.pushSubscriptions)
            .values({ ...row, id: uuid(), endpoint: "https://push.example/x", sessionId: uuid() })
            .run(),
        ).toThrow(/FOREIGN KEY/);
        db.delete(authSchema.session).where(eq(authSchema.session.id, sessionId)).run();
        expect(db.select().from(schema.pushSubscriptions).all()).toEqual([]);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("0010 까지 적용된 DB 에 0011(agents.runner_token_id)을 얹어도 에이전트 행이 그대로고 묶임은 null — 첫 연결 러너가 묶는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_push_session");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const ws = uuid();
        const createdAt = new Date("2026-09-29T00:00:00.000Z");
        db.insert(workspaces).values({ id: ws, name: "w", createdAt }).run();
        // 옛 스키마에는 runner_token_id 가 없다 — 지금 스키마의 insert 를 쓰지 않고 SQL 로 넣는다
        const insertAgent = sqlite.prepare(
          "INSERT INTO agents (id, workspace_id, provider, provider_agent_id, handle, name, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
        );
        const coderId = uuid();
        const devId = uuid();
        insertAgent.run(coderId, ws, "claude", "coder", "coder", "Coder", createdAt.getTime());
        insertAgent.run(devId, ws, "openclaw", "dev", "dev", "Dev", createdAt.getTime());

        migrate(db, { migrationsFolder: migrationsFolder() });

        const rows = db
          .select({ id: agents.id, provider: agents.provider, runnerTokenId: agents.runnerTokenId })
          .from(agents)
          .all();
        expect([...rows].sort((a, b) => a.provider.localeCompare(b.provider))).toEqual([
          { id: coderId, provider: "claude", runnerTokenId: null },
          { id: devId, provider: "openclaw", runnerTokenId: null },
        ]);
        // 러너 토큰을 가리킬 수 있고, 없는 토큰은 외래 키가 막는다
        const tokenId = uuid();
        db.insert(runnerTokens)
          .values({
            id: tokenId,
            workspaceId: ws,
            label: "laptop",
            hash: "c".repeat(64),
            prefix: "AAAAAA",
            createdAt,
          })
          .run();
        db.update(agents).set({ runnerTokenId: tokenId }).where(eq(agents.id, coderId)).run();
        expect(
          db.select({ t: agents.runnerTokenId }).from(agents).where(eq(agents.id, coderId)).get(),
        ).toEqual({
          t: tokenId,
        });
        sqlite.pragma("foreign_keys = ON");
        expect(() =>
          db.update(agents).set({ runnerTokenId: uuid() }).where(eq(agents.id, devId)).run(),
        ).toThrow(/FOREIGN KEY/);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
