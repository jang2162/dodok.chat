import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuid } from "uuid";
import { dodokSessionKey } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import * as authSchema from "../src/db/auth-schema";
import { createDb, type Db } from "../src/db/client";
import * as schema from "../src/db/schema.sqlite";
import {
  agents,
  bridgeTokens,
  channels,
  gateways,
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
  // 메시지는 대화 FK 를 갖는다 — 대화 하나를 넣고 id 를 채널 id 와 같게 둬 msg 가 채널 id 하나로 두 열을 채운다
  db.insert(schema.conversations)
    .values({
      id: ch,
      channelId: ch,
      title: "이전 대화",
      titleSource: "user",
      createdByType: "user",
      createdById: user,
      createdAt: new Date(),
    })
    .run();
  return { ws, user, ch };
}

const msg = (ch: string, seq: number, extra: Partial<typeof messages.$inferInsert> = {}) => ({
  id: uuid(),
  channelId: ch,
  conversationId: ch,
  seq,
  kind: "normal",
  authorType: "user",
  bodyMd: "hi",
  mentions: { agents: [], users: [] },
  createdAt: new Date(),
  ...extra,
});

describe("db", () => {
  it("마이그레이션이 31개 테이블을 만든다(FTS5 그림자 테이블 제외)", () => {
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
      "automations",
      "bridge_tokens",
      "channel_members",
      "channels",
      "component_interactions",
      "conversation_reads",
      "conversations",
      "gateways",
      "invites",
      "memberships",
      "message_reactions",
      "messages",
      "messages_fts",
      "ops_events",
      "personal_tokens",
      "push_devices",
      "push_subscriptions",
      "run_events",
      "runner_projects",
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
        // 옛 DB 에 스키마 객체로 넣으면 뒤 마이그레이션의 열까지 싣는다 — SQL 로 넣는다
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
        // 지금 스키마의 insert 는 뒤 마이그레이션의 열(gateway_id)까지 싣는다 — SQL 로 넣는다
        sqlite
          .prepare(
            "INSERT INTO bridge_tokens (id, workspace_id, label, hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(tokenId, ws, bridgeRow.label, bridgeRow.hash, bridgeRow.prefix, createdAt.getTime());
        expect(() => db.select().from(runnerTokens).all()).toThrow(/no such table/);

        // 0009 경계에서 본다 — 뒤 마이그레이션(0013)은 Gateway 에 묶이지 않은 브리지 토큰을 버린다(아래 0013 테스트)
        migrate(db, { migrationsFolder: migrationsUpTo(dir, "_runner_tokens") });

        expect(
          sqlite.prepare("SELECT id, workspace_id, label, hash, prefix, created_at FROM bridge_tokens").all(),
        ).toEqual([
          {
            id: tokenId,
            workspace_id: ws,
            label: bridgeRow.label,
            hash: bridgeRow.hash,
            prefix: bridgeRow.prefix,
            created_at: createdAt.getTime(),
          },
        ]);
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
          { id: devId, provider: "openclaw", runnerTokenId: null },
          { id: coderId, provider: "runner", runnerTokenId: null },
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
  it("0011 까지 적용된 DB 에 0012(gateways·연결 id)를 얹으면 옛 행의 연결은 비고, Gateway 를 지우면 토큰은 함께·에이전트는 연결만 비워진다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_agent_runner_token");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const ws = uuid();
        const createdAt = new Date("2026-10-04T00:00:00.000Z");
        db.insert(workspaces).values({ id: ws, name: "w", createdAt }).run();
        // 옛 스키마에는 gateway_id 가 없다 — 지금 스키마의 insert 를 쓰지 않고 SQL 로 넣는다
        const devId = uuid();
        sqlite
          .prepare(
            "INSERT INTO agents (id, workspace_id, provider, provider_agent_id, handle, name, enabled, created_at) VALUES (?, ?, 'openclaw', 'dev', 'dev', 'Dev', 1, ?)",
          )
          .run(devId, ws, createdAt.getTime());
        const tokenId = uuid();
        sqlite
          .prepare(
            "INSERT INTO bridge_tokens (id, workspace_id, label, hash, prefix, created_at) VALUES (?, ?, 'old', ?, 'AAAAAA', ?)",
          )
          .run(tokenId, ws, "a".repeat(64), createdAt.getTime());

        migrate(db, { migrationsFolder: migrationsUpTo(dir, "_multi_gateway") });

        expect(db.select({ g: agents.gatewayId }).from(agents).all()).toEqual([{ g: null }]);
        expect(db.select({ g: bridgeTokens.gatewayId }).from(bridgeTokens).all()).toEqual([{ g: null }]);

        sqlite.pragma("foreign_keys = ON");
        const gw = uuid();
        db.insert(gateways)
          .values({
            id: gw,
            workspaceId: ws,
            name: "사무실",
            url: "wss://gw",
            token: "t",
            createdAt,
            updatedAt: createdAt,
          })
          .run();
        expect(() =>
          db
            .insert(gateways)
            .values({
              id: uuid(),
              workspaceId: ws,
              name: "사무실",
              url: "wss://gw2",
              token: "t",
              createdAt,
              updatedAt: createdAt,
            })
            .run(),
        ).toThrow(/UNIQUE/);
        db.update(agents).set({ gatewayId: gw }).where(eq(agents.id, devId)).run();
        db.update(bridgeTokens).set({ gatewayId: gw }).where(eq(bridgeTokens.id, tokenId)).run();
        // 같은 Gateway 에 같은 id 는 둘이 될 수 없고, 다른 Gateway(또는 러너)의 같은 id 는 된다. SQL 로 넣는다 — 스키마 객체는
        // 뒤 마이그레이션의 열(archived_at 등)까지 싣는다
        const insertAgent = (handle: string, provider: string, gatewayId: string | null) =>
          sqlite
            .prepare(
              "INSERT INTO agents (id, workspace_id, provider, provider_agent_id, handle, name, created_at, gateway_id) VALUES (?, ?, ?, 'dev', ?, ?, ?, ?)",
            )
            .run(uuid(), ws, provider, handle, handle, createdAt.getTime(), gatewayId);
        expect(() => insertAgent("dev-2", "openclaw", gw)).toThrow(/UNIQUE/);
        insertAgent("dev-claude", "claude", null);
        expect(() => insertAgent("dev-claude-2", "claude", null)).toThrow(/UNIQUE/);

        db.delete(gateways).where(eq(gateways.id, gw)).run();
        expect(db.select().from(bridgeTokens).all()).toEqual([]);
        expect(
          db.select({ id: agents.id, g: agents.gatewayId }).from(agents).where(eq(agents.id, devId)).get(),
        ).toEqual({
          id: devId,
          g: null,
        });
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("0012 까지 적용된 DB 에 0013 을 얹으면 Gateway 에 묶인 브리지 토큰만 남고, gateway_id 는 필수·지우면 함께 지워진다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: migrationsUpTo(dir, "_multi_gateway") });
        const ws = uuid();
        const createdAt = new Date("2026-10-04T00:00:00.000Z");
        db.insert(workspaces).values({ id: ws, name: "w", createdAt }).run();
        const gw = uuid();
        db.insert(gateways)
          .values({
            id: gw,
            workspaceId: ws,
            name: "사무실",
            url: "wss://gw",
            token: "t",
            createdAt,
            updatedAt: createdAt,
          })
          .run();
        const insertToken = (id: string, hash: string, gatewayId: string | null) =>
          sqlite
            .prepare(
              "INSERT INTO bridge_tokens (id, workspace_id, label, hash, prefix, created_at, gateway_id) VALUES (?, ?, 'x', ?, 'AAAAAA', ?, ?)",
            )
            .run(id, ws, hash, createdAt.getTime(), gatewayId);
        const bound = uuid();
        insertToken(bound, "a".repeat(64), gw);
        insertToken(uuid(), "b".repeat(64), null); // .env 에서 이어받은 꼴

        migrate(db, { migrationsFolder: migrationsFolder() });

        expect(
          db.select({ id: bridgeTokens.id, g: bridgeTokens.gatewayId }).from(bridgeTokens).all(),
        ).toEqual([{ id: bound, g: gw }]);
        expect(() => insertToken(uuid(), "c".repeat(64), null)).toThrow(/NOT NULL/);
        sqlite.pragma("foreign_keys = ON");
        db.delete(gateways).where(eq(gateways.id, gw)).run();
        expect(db.select().from(bridgeTokens).all()).toEqual([]);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("_agent_archive 까지 적용된 DB 에 _member_deactivate 를 얹으면 membership 은 활성으로 남고 users 의 left_handle 열은 없어진다 — 스키마 객체로 넣고 읽는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_agent_archive");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const ws = uuid();
        const left = uuid();
        const createdAt = new Date("2026-10-06T00:00:00.000Z");
        // 옛 스키마의 users 에는 left_handle 이 있고 memberships 에는 deactivated_at 이 없다 — SQL 로 넣는다
        sqlite
          .prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'w', ?)")
          .run(ws, createdAt.getTime());
        sqlite
          .prepare(
            "INSERT INTO users (id, workspace_id, handle, display_name, auth_provider, created_at, left_handle) VALUES (?, ?, 'left-x', 'Old', 'local', ?, 'old')",
          )
          .run(left, ws, createdAt.getTime());
        sqlite
          .prepare("INSERT INTO memberships (id, workspace_id, user_id, role) VALUES (?, ?, ?, 'member')")
          .run(uuid(), ws, left);

        migrate(db, { migrationsFolder: migrationsFolder() });

        const columns = sqlite.prepare("SELECT name FROM pragma_table_info('users')").all() as {
          name: string;
        }[];
        expect(columns.map((c) => c.name)).not.toContain("left_handle");
        expect(db.select().from(memberships).where(eq(memberships.userId, left)).get()).toMatchObject({
          role: "member",
          deactivatedAt: null,
        });
        const joined = uuid();
        db.insert(users)
          .values({
            id: joined,
            workspaceId: ws,
            handle: "new",
            displayName: "New",
            authProvider: "local",
            createdAt,
          })
          .run();
        db.insert(memberships)
          .values({ id: uuid(), workspaceId: ws, userId: joined, role: "admin", deactivatedAt: createdAt })
          .run();
        expect(db.select().from(memberships).where(eq(memberships.userId, joined)).get()).toMatchObject({
          role: "admin",
          deactivatedAt: createdAt,
        });
        expect(db.select().from(users).where(eq(users.id, left)).get()).toMatchObject({ handle: "left-x" });
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("0016 까지 적용된 DB 에 0017(channels.archived_at)을 얹으면 옛 채널은 살아 있고(null), 스키마 객체 INSERT·보관 쓰기가 된다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_member_deactivate");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const ws = uuid();
        const user = uuid();
        const old = uuid();
        const createdAt = new Date("2026-10-05T00:00:00.000Z");
        db.insert(workspaces).values({ id: ws, name: "w", createdAt }).run();
        sqlite
          .prepare(
            "INSERT INTO users (id, workspace_id, handle, display_name, auth_provider, created_at) VALUES (?, ?, 'jang', '장', 'local', ?)",
          )
          .run(user, ws, createdAt.getTime());
        // 옛 스키마에는 archived_at 이 없다 — 지금 스키마의 insert 를 쓰지 않고 SQL 로 넣는다
        sqlite
          .prepare(
            "INSERT INTO channels (id, workspace_id, name, relay_policy_json, visibility, created_by, created_at) VALUES (?, ?, 'general', '{\"maxRelayTurns\":4,\"allowPairs\":\"all\"}', 'public', ?, ?)",
          )
          .run(old, ws, user, createdAt.getTime());

        migrate(db, { migrationsFolder: migrationsFolder() });

        expect(db.select({ id: channels.id, a: channels.archivedAt }).from(channels).all()).toEqual([
          { id: old, a: null },
        ]);
        const fresh = uuid();
        db.insert(channels)
          .values({
            id: fresh,
            workspaceId: ws,
            name: "fresh",
            relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
            visibility: "public",
            createdBy: user,
            createdAt,
            archivedAt: createdAt,
          })
          .run();
        expect(
          db.select({ a: channels.archivedAt }).from(channels).where(eq(channels.id, fresh)).get(),
        ).toEqual({ a: createdAt });
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("_channel_archive 까지 적용된 DB 에 channel_reads 를 얹으면 membership 이 있는 사용자(비활성 포함)만 그 워크스페이스 채널마다 last_seq 까지 읽음이다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_channel_archive");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const createdAt = Date.parse("2026-10-06T00:00:00.000Z");
        // 옛 스키마에는 channel_reads 가 없다 — 스키마 객체 대신 SQL 로 넣는다
        const insertWorkspace = sqlite.prepare(
          "INSERT INTO workspaces (id, name, created_at) VALUES (?, 'w', ?)",
        );
        const insertUser = sqlite.prepare(
          "INSERT INTO users (id, workspace_id, handle, display_name, auth_provider, created_at) VALUES (?, ?, ?, ?, 'local', ?)",
        );
        const insertMembership = sqlite.prepare(
          "INSERT INTO memberships (id, workspace_id, user_id, role, deactivated_at) VALUES (?, ?, ?, 'member', ?)",
        );
        const insertChannel = sqlite.prepare(
          'INSERT INTO channels (id, workspace_id, name, relay_policy_json, visibility, created_by, created_at, last_seq) VALUES (?, ?, ?, \'{"maxRelayTurns":4,"allowPairs":"all"}\', \'public\', ?, ?, ?)',
        );
        const ws = uuid();
        const active = uuid();
        const deactivated = uuid();
        const outsider = uuid();
        insertWorkspace.run(ws, createdAt);
        insertUser.run(active, ws, "active", "Active", createdAt);
        insertUser.run(deactivated, ws, "gone", "Gone", createdAt);
        insertUser.run(outsider, ws, "outsider", "Outsider", createdAt);
        insertMembership.run(uuid(), ws, active, null);
        insertMembership.run(uuid(), ws, deactivated, createdAt);
        const busy = uuid();
        const quiet = uuid();
        insertChannel.run(busy, ws, "busy", active, createdAt, 3);
        insertChannel.run(quiet, ws, "quiet", active, createdAt, 0);
        // 다른 워크스페이스의 멤버·채널 — 워크스페이스를 넘어 짝짓지 않는다
        const ws2 = uuid();
        const stranger = uuid();
        const elsewhere = uuid();
        insertWorkspace.run(ws2, createdAt);
        insertUser.run(stranger, ws2, "stranger", "Stranger", createdAt);
        insertMembership.run(uuid(), ws2, stranger, null);
        insertChannel.run(elsewhere, ws2, "elsewhere", stranger, createdAt, 5);

        const before = Date.now();
        // channel_reads 는 conversation_reads 로 옮겨지고 지워진다(_conversation_reads) — 그 앞까지만 얹어 0018 의 시드를 본다
        migrate(db, { migrationsFolder: migrationsUpTo(dir, "_automation_conversation") });

        const rows = sqlite
          .prepare("SELECT user_id, channel_id, last_read_seq, updated_at FROM channel_reads")
          .all()
          .map((r) => {
            const row = r as {
              user_id: string;
              channel_id: string;
              last_read_seq: number;
              updated_at: number;
            };
            return {
              userId: row.user_id,
              channelId: row.channel_id,
              lastReadSeq: row.last_read_seq,
              updatedAt: new Date(row.updated_at),
            };
          });
        const key = (r: { userId: string; channelId: string }) => `${r.userId}/${r.channelId}`;
        expect(
          rows.map((r) => ({ userId: r.userId, channelId: r.channelId, lastReadSeq: r.lastReadSeq })),
        ).toEqual(
          expect.arrayContaining([
            { userId: active, channelId: busy, lastReadSeq: 3 },
            { userId: active, channelId: quiet, lastReadSeq: 0 },
            { userId: deactivated, channelId: busy, lastReadSeq: 3 },
            { userId: deactivated, channelId: quiet, lastReadSeq: 0 },
            { userId: stranger, channelId: elsewhere, lastReadSeq: 5 },
          ]),
        );
        expect(rows).toHaveLength(5);
        expect(new Set(rows.map(key)).size).toBe(5);
        // 시각은 마이그레이션이 돈 때(초 단위, 밀리초 정수)
        for (const r of rows) {
          expect(r.updatedAt).toBeInstanceOf(Date);
          expect(r.updatedAt.getTime()).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
          expect(r.updatedAt.getTime()).toBeLessThanOrEqual(Date.now());
        }
        // (user_id, channel_id) 는 한 행 — 같은 짝을 다시 넣으면 거절
        expect(() =>
          sqlite
            .prepare(
              "INSERT INTO channel_reads (user_id, channel_id, last_read_seq, updated_at) VALUES (?, ?, 1, 0)",
            )
            .run(active, busy),
        ).toThrow(/UNIQUE|PRIMARY KEY/);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("conversation_reads 는 대화·사용자와 함께 지워지고(cascade), 없는 사용자·대화는 FK 가 거절한다", () => {
    const db = createDb(":memory:");
    const { ws, user, ch } = seed(db);
    const other = uuid();
    db.insert(users)
      .values({
        id: other,
        workspaceId: ws,
        handle: "other",
        displayName: "O",
        authProvider: "local",
        createdAt: new Date(),
      })
      .run();
    const row = (userId: string, conversationId: string) => ({
      userId,
      conversationId,
      lastReadSeq: 0,
      updatedAt: new Date(),
    });
    db.insert(schema.conversationReads).values(row(user, ch)).run();
    db.insert(schema.conversationReads).values(row(other, ch)).run();
    expect(() => db.insert(schema.conversationReads).values(row(uuid(), ch)).run()).toThrow(/FOREIGN KEY/);
    expect(() => db.insert(schema.conversationReads).values(row(user, uuid())).run()).toThrow(/FOREIGN KEY/);
    expect(() => db.insert(schema.conversationReads).values(row(user, ch)).run()).toThrow(
      /UNIQUE|PRIMARY KEY/,
    );
    db.delete(users).where(eq(users.id, other)).run();
    expect(
      db
        .select()
        .from(schema.conversationReads)
        .all()
        .map((r) => r.userId),
    ).toEqual([user]);
    db.delete(schema.conversations).where(eq(schema.conversations.id, ch)).run();
    expect(db.select().from(schema.conversationReads).all()).toEqual([]);
  });

  it("runs·approvals 의 제공자 id 는 연결 안에서만 유일하다", () => {
    const db = createDb(":memory:");
    const { ws, ch } = seed(db);
    const agentId = uuid();
    db.insert(agents)
      .values({
        id: agentId,
        workspaceId: ws,
        provider: "openclaw",
        providerAgentId: "main",
        handle: "main",
        name: "main",
        createdAt: new Date(),
      })
      .run();
    const run = (connectionId: string) =>
      db
        .insert(schema.runs)
        .values({
          id: uuid(),
          channelId: ch,
          conversationId: ch,
          agentId,
          triggerKind: "mention",
          rootMessageId: uuid(),
          sessionKey: "agent:main:dodok:channel:x",
          providerRunId: "same",
          status: "queued",
          connectionId,
          createdAt: new Date(),
        })
        .run();
    run("g1");
    run("g2");
    expect(() => run("g1")).toThrow(/UNIQUE/);
    const approval = (connectionId: string) =>
      db
        .insert(schema.approvals)
        .values({
          id: uuid(),
          providerApprovalId: "plugin:same",
          kind: "plugin",
          channelId: ch,
          conversationId: ch,
          agentId,
          title: "t",
          severity: "warning",
          allowedDecisions: ["deny"],
          status: "pending",
          expiresAt: new Date(),
          createdAt: new Date(),
          connectionId,
        })
        .run();
    approval("g1");
    approval("g2");
    expect(() => approval("g2")).toThrow(/UNIQUE/);
  });
});

describe("message_reactions 마이그레이션", () => {
  it("0018 까지 적용된 DB 의 세션 행은 마이그레이션 뒤 reactions_seen_at 이 채워지고, 메시지·사용자를 지우면 리액션이 함께 지워진다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_channel_reads");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        // 옛 스키마에는 reactions_seen_at 이 없다 — 지금 스키마의 insert 를 쓰지 않고 SQL 로 넣는다
        const insertSession = sqlite.prepare(
          "INSERT INTO agent_sessions (id, channel_id, agent_id, session_key, prompt_revision_at_start, thread_root_id) VALUES (?, ?, ?, ?, 1, ?)",
        );
        const [ch, ag] = [uuid(), uuid()];
        // 이 줄은 세션 행만 있으면 된다 — 채널·에이전트 행 없이 넣으려고 외래 키를 잠시 끈다
        sqlite.pragma("foreign_keys = OFF");
        insertSession.run("s1", ch, ag, "k1", null);
        insertSession.run("s2", ch, ag, "k2", uuid());
        const before = Date.now();

        migrate(db, { migrationsFolder: migrationsFolder() });

        const rows = db
          .select({ id: schema.agentSessions.id, at: schema.agentSessions.reactionsSeenAt })
          .from(schema.agentSessions)
          .all();
        expect(rows).toHaveLength(2);
        for (const r of rows) {
          expect(r.at).not.toBeNull();
          // 초 단위로 채워 마이그레이션 시각보다 1초 안쪽까지 앞설 수 있다
          expect(r.at?.getTime()).toBeGreaterThan(before - 1000);
        }

        sqlite.pragma("foreign_keys = ON");
        const ws = uuid();
        const userId = uuid();
        const msgId = uuid();
        const createdAt = new Date("2026-10-07T00:00:00.000Z");
        db.insert(workspaces).values({ id: ws, name: "w", createdAt }).run();
        db.insert(users)
          .values({
            id: userId,
            workspaceId: ws,
            handle: "mia",
            displayName: "m",
            authProvider: "local",
            createdAt,
          })
          .run();
        db.insert(channels)
          .values({
            id: ch,
            workspaceId: ws,
            name: "c",
            relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
            visibility: "public",
            createdBy: userId,
            createdAt,
          })
          .run();
        db.insert(schema.conversations)
          .values({
            id: ch,
            channelId: ch,
            title: "이전 대화",
            titleSource: "user",
            createdByType: "user",
            createdById: userId,
            createdAt,
          })
          .run();
        db.insert(messages)
          .values({
            id: msgId,
            channelId: ch,
            conversationId: ch,
            seq: 1,
            kind: "normal",
            authorType: "user",
            authorId: userId,
            bodyMd: "x",
            mentions: { agents: [], users: [] },
            createdAt,
          })
          .run();
        const add = (emoji: string) =>
          db.insert(schema.messageReactions).values({ messageId: msgId, userId, emoji, createdAt }).run();
        add("👍");
        expect(() => add("👍")).toThrow(/UNIQUE|PRIMARY/);
        add("👎");
        db.delete(messages).where(eq(messages.id, msgId)).run();
        expect(db.select().from(schema.messageReactions).all()).toEqual([]);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("세션 정책 마이그레이션", () => {
  it("_channel_conversations 까지 적용된 DB 에 얹으면 옛 채널은 정책 members, 사람 멤버는 member·에이전트 멤버는 null — 표를 다시 만들지 않아 행 id 가 그대로다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_channel_conversations");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const ws = uuid();
        const user = uuid();
        const ch = uuid();
        const [userRow, agentRow] = [uuid(), uuid()];
        const t = new Date("2026-10-24T00:00:00.000Z").getTime();
        sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'w', ?)").run(ws, t);
        sqlite
          .prepare(
            "INSERT INTO users (id, workspace_id, handle, display_name, auth_provider, created_at) VALUES (?, ?, 'jang', '장', 'local', ?)",
          )
          .run(user, ws, t);
        sqlite
          .prepare(
            "INSERT INTO channels (id, workspace_id, name, relay_policy_json, visibility, created_by, created_at) VALUES (?, ?, 'general', '{\"maxRelayTurns\":4,\"allowPairs\":\"all\"}', 'public', ?, ?)",
          )
          .run(ch, ws, user, t);
        const member = sqlite.prepare(
          "INSERT INTO channel_members (id, channel_id, member_type, member_id, joined_at) VALUES (?, ?, ?, ?, ?)",
        );
        member.run(userRow, ch, "user", user, t);
        member.run(agentRow, ch, "agent", uuid(), t);

        migrate(db, { migrationsFolder: migrationsFolder() });

        expect(db.select({ p: channels.sessionPolicy }).from(channels).all()).toEqual([
          { p: { create: "members" } },
        ]);
        expect(
          db
            .select({ id: schema.channelMembers.id, role: schema.channelMembers.role })
            .from(schema.channelMembers)
            .orderBy(schema.channelMembers.memberType)
            .all(),
        ).toEqual([
          { id: agentRow, role: null },
          { id: userRow, role: "member" },
        ]);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("자동화 세션 마이그레이션", () => {
  it("_session_policy 까지 적용된 DB 에 얹으면 옛 자동화의 conversation_id 는 비어 있고(첫 게시가 단다) 행은 그대로, 없는 대화 id 는 FK 가 거절한다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_session_policy");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const [ws, user, ch, auto] = [uuid(), uuid(), uuid(), uuid()];
        const t = new Date("2026-10-25T00:00:00.000Z").getTime();
        sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'w', ?)").run(ws, t);
        sqlite
          .prepare(
            "INSERT INTO users (id, workspace_id, handle, display_name, auth_provider, created_at) VALUES (?, ?, 'jang', '장', 'local', ?)",
          )
          .run(user, ws, t);
        sqlite
          .prepare(
            "INSERT INTO channels (id, workspace_id, name, relay_policy_json, visibility, created_by, created_at) VALUES (?, ?, 'general', '{\"maxRelayTurns\":4,\"allowPairs\":\"all\"}', 'public', ?, ?)",
          )
          .run(ch, ws, user, t);
        sqlite
          .prepare(
            "INSERT INTO automations (id, workspace_id, name, channel_id, kind, body_md, enabled, created_by, created_at, updated_at) VALUES (?, ?, '아침', ?, 'webhook', '@dev 점검', 1, ?, ?, ?)",
          )
          .run(auto, ws, ch, user, t, t);

        migrate(db, { migrationsFolder: migrationsFolder() });

        expect(
          db
            .select({ id: schema.automations.id, c: schema.automations.conversationId })
            .from(schema.automations)
            .all(),
        ).toEqual([{ id: auto, c: null }]);
        expect(() =>
          db
            .update(schema.automations)
            .set({ conversationId: uuid() })
            .where(eq(schema.automations.id, auto))
            .run(),
        ).toThrow(/FOREIGN KEY/);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conversations 마이그레이션", () => {
  it("_approval_requested_by 까지 적용된 DB 에 얹으면 채널마다 id 가 채널 id 인 「이전 대화」가 생기고 모든 행이 그리로 옮겨진다 — 자식 행·FTS 는 그대로", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_approval_requested_by");
      const sqlite = new Database(join(dir, "app.db"));
      // 서버(createDb)처럼 FK 를 켠 채로 — 마이그레이터 트랜잭션 안의 PRAGMA foreign_keys=OFF 는 아무 일도 하지 않는다
      sqlite.pragma("foreign_keys = ON");
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const t0 = Date.parse("2026-10-20T00:00:00.000Z");
        const ws = uuid();
        const user = uuid();
        const agent = uuid();
        const busy = uuid();
        const quiet = uuid();
        const [m1, m2, m3] = [uuid(), uuid(), uuid()];
        const run = uuid();
        // 옛 스키마에는 conversation_id 가 없다 — 스키마 객체 대신 SQL 로 넣는다
        sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'w', ?)").run(ws, t0);
        sqlite
          .prepare(
            "INSERT INTO users (id, workspace_id, handle, display_name, auth_provider, created_at) VALUES (?, ?, 'mia', 'Mia', 'local', ?)",
          )
          .run(user, ws, t0);
        sqlite
          .prepare(
            "INSERT INTO agents (id, workspace_id, provider, provider_agent_id, handle, name, created_at) VALUES (?, ?, 'openclaw', 'dev', 'dev', 'Dev', ?)",
          )
          .run(agent, ws, t0);
        const insertChannel = sqlite.prepare(
          'INSERT INTO channels (id, workspace_id, name, relay_policy_json, visibility, created_by, created_at, last_seq) VALUES (?, ?, ?, \'{"maxRelayTurns":4,"allowPairs":"all"}\', \'public\', ?, ?, ?)',
        );
        insertChannel.run(busy, ws, "busy", user, t0, 3);
        insertChannel.run(quiet, ws, "quiet", user, t0 + 1000, 0);
        const insertMessage = sqlite.prepare(
          "INSERT INTO messages (id, channel_id, seq, kind, author_type, author_id, body_md, mentions_json, attachments_json, thread_root_id, created_at) VALUES (?, ?, ?, 'normal', 'user', ?, ?, '{\"agents\":[],\"users\":[]}', ?, ?, ?)",
        );
        insertMessage.run(
          m1,
          busy,
          1,
          user,
          "배포 절차를 정리합니다",
          '[{"id":"' +
            uuid() +
            '","kind":"file","url":"artifact://x","name":"plan.txt","mime":"text/plain","size":1}]',
          null,
          t0 + 1,
        );
        insertMessage.run(m2, busy, 2, user, "두 번째", "[]", null, t0 + 2);
        insertMessage.run(m3, busy, 3, user, "답글", "[]", m1, t0 + 3);
        sqlite
          .prepare(
            "INSERT INTO attachments (id, channel_id, uploader_type, uploader_id, kind, name, mime, size, sha256, message_id, created_at) VALUES (?, ?, 'user', ?, 'file', 'plan.txt', 'text/plain', 1, 'ab', ?, ?)",
          )
          .run(uuid(), busy, user, m1, t0);
        sqlite
          .prepare(
            "INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, '👍', ?)",
          )
          .run(m1, user, t0);
        sqlite
          .prepare(
            "INSERT INTO component_interactions (id, message_id, component_id, user_id, item_id, values_json, created_at) VALUES (?, ?, 'cmp_1', ?, 'ok', '{}', ?)",
          )
          .run(uuid(), m2, user, t0);
        sqlite
          .prepare(
            "INSERT INTO runs (id, channel_id, agent_id, trigger_kind, trigger_message_id, root_message_id, session_key, status, created_at) VALUES (?, ?, ?, 'mention', ?, ?, ?, 'done', ?)",
          )
          .run(run, busy, agent, m1, m1, `agent:dev:dodok:channel:${busy}`, t0);
        sqlite
          .prepare(
            "INSERT INTO run_events (id, run_id, seq, type, payload_json, created_at) VALUES (?, ?, 1, 'RUN_STARTED', '{}', ?)",
          )
          .run(uuid(), run, t0);
        sqlite
          .prepare(
            "INSERT INTO approvals (id, provider_approval_id, kind, channel_id, agent_id, run_id, title, severity, allowed_decisions_json, status, expires_at, created_at) VALUES (?, 'plugin:1', 'plugin', ?, ?, ?, 't', 'warning', '[\"deny\"]', 'pending', ?, ?)",
          )
          .run(uuid(), busy, agent, run, t0, t0);
        const insertSession = sqlite.prepare(
          "INSERT INTO agent_sessions (id, channel_id, agent_id, session_key, prompt_revision_at_start, thread_root_id) VALUES (?, ?, ?, ?, 1, ?)",
        );
        insertSession.run(uuid(), busy, agent, `agent:dev:dodok:channel:${busy}`, null);
        insertSession.run(uuid(), busy, agent, `agent:dev:dodok:channel:${busy}:thread:${m1}`, m1);

        migrate(db, { migrationsFolder: migrationsFolder() });

        const convs = db.select().from(schema.conversations).all();
        expect(convs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())).toEqual([
          {
            id: busy,
            channelId: busy,
            title: "이전 대화",
            titleSource: "user",
            createdByType: "user",
            createdById: user,
            createdAt: new Date(t0),
            lastMessageAt: new Date(t0 + 3),
            lastSeq: 3,
            closedAt: null,
            closedBy: null,
          },
          {
            id: quiet,
            channelId: quiet,
            title: "이전 대화",
            titleSource: "user",
            createdByType: "user",
            createdById: user,
            createdAt: new Date(t0 + 1000),
            lastMessageAt: null,
            lastSeq: 0,
            closedAt: null,
            closedBy: null,
          },
        ]);
        const msgs = db.select().from(messages).all();
        expect(msgs).toHaveLength(3);
        for (const m of msgs) expect(m.conversationId).toBe(busy);
        expect(
          db
            .select()
            .from(schema.runs)
            .all()
            .map((r) => r.conversationId),
        ).toEqual([busy]);
        expect(
          db
            .select()
            .from(schema.approvals)
            .all()
            .map((a) => a.conversationId),
        ).toEqual([busy]);
        const sessions = db.select().from(schema.agentSessions).all();
        expect(sessions).toHaveLength(2);
        for (const s of sessions) {
          expect(s.conversationId).toBe(busy);
          expect(s.sessionKey).toBe(dodokSessionKey("dev", s.conversationId, s.threadRootId ?? undefined));
        }
        // 잠시 옮겨 둔 자식 행이 그대로 돌아왔다(리액션은 cascade 라 옮기지 않으면 조용히 지워진다)
        expect(
          db
            .select()
            .from(schema.attachments)
            .all()
            .map((a) => a.messageId),
        ).toEqual([m1]);
        expect(
          db
            .select()
            .from(schema.messageReactions)
            .all()
            .map((r) => r.messageId),
        ).toEqual([m1]);
        expect(
          db
            .select()
            .from(schema.componentInteractions)
            .all()
            .map((r) => r.messageId),
        ).toEqual([m2]);
        expect(
          db
            .select()
            .from(schema.runEvents)
            .all()
            .map((r) => r.runId),
        ).toEqual([run]);
        expect(sqlite.pragma("foreign_key_check")).toEqual([]);
        expect(
          sqlite.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE '__park_%'").all(),
        ).toEqual([]);
        // FTS — 다시 만든 표의 rowid 로 색인했고 트리거가 다시 있다
        const hit = (q: string) =>
          sqlite
            .prepare(
              "SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ?",
            )
            .all(`"${q}"`)
            .map((r) => (r as { id: string }).id);
        expect(hit("배포 절차")).toEqual([m1]);
        expect(hit("plan.txt")).toEqual([m1]);
        expect(hit("두 번째")).toEqual([m2]);
        const triggers = sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'messages' ORDER BY name",
          )
          .all();
        expect(triggers).toEqual([
          { name: "messages_fts_ad" },
          { name: "messages_fts_ai" },
          { name: "messages_fts_au" },
        ]);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("conversation_reads 마이그레이션", () => {
  it("_automation_conversation 까지 적용된 DB 에 얹으면 옛 채널 읽음은 「이전 대화」로(그 대화 끝으로 깎아), 그 밖의 대화는 membership(비활성 포함)마다 끝까지 읽음이고 channel_reads 는 없어진다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_automation_conversation");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const t = Date.parse("2026-10-25T00:00:00.000Z");
        const readAt = Date.parse("2026-10-20T00:00:00.000Z");
        const insertWorkspace = sqlite.prepare(
          "INSERT INTO workspaces (id, name, created_at) VALUES (?, 'w', ?)",
        );
        const insertUser = sqlite.prepare(
          "INSERT INTO users (id, workspace_id, handle, display_name, auth_provider, created_at) VALUES (?, ?, ?, ?, 'local', ?)",
        );
        const insertMembership = sqlite.prepare(
          "INSERT INTO memberships (id, workspace_id, user_id, role, deactivated_at) VALUES (?, ?, ?, 'member', ?)",
        );
        const insertChannel = sqlite.prepare(
          'INSERT INTO channels (id, workspace_id, name, relay_policy_json, visibility, created_by, created_at, last_seq) VALUES (?, ?, ?, \'{"maxRelayTurns":4,"allowPairs":"all"}\', \'public\', ?, ?, ?)',
        );
        const insertConversation = sqlite.prepare(
          "INSERT INTO conversations (id, channel_id, title, title_source, created_by_type, created_by_id, created_at, last_seq) VALUES (?, ?, ?, 'user', 'user', ?, ?, ?)",
        );
        const insertRead = sqlite.prepare(
          "INSERT INTO channel_reads (user_id, channel_id, last_read_seq, updated_at) VALUES (?, ?, ?, ?)",
        );
        const ws = uuid();
        const [active, deactivated, outsider] = [uuid(), uuid(), uuid()];
        insertWorkspace.run(ws, t);
        insertUser.run(active, ws, "active", "Active", t);
        insertUser.run(deactivated, ws, "gone", "Gone", t);
        insertUser.run(outsider, ws, "outsider", "Outsider", t);
        insertMembership.run(uuid(), ws, active, null);
        insertMembership.run(uuid(), ws, deactivated, t);
        // X: 0025 가 옮긴 채널 — 「이전 대화」(id = X, 끝 seq 3)와 그 뒤에 만든 세션 B(끝 seq 5). 채널 끝은 5
        const x = uuid();
        const b = uuid();
        insertChannel.run(x, ws, "x", active, t, 5);
        insertConversation.run(x, x, "이전 대화", active, t, 3);
        insertConversation.run(b, x, "B", active, t, 5);
        // Y: 0025 뒤에 만든 채널 — 「이전 대화」가 없다(세션 C 만)
        const y = uuid();
        const c = uuid();
        insertChannel.run(y, ws, "y", active, t, 7);
        insertConversation.run(c, y, "C", active, t, 7);
        // 옛 채널 읽음 — active 는 X 끝(5)까지, deactivated 는 2 까지, Y 에도 한 행(옮길 「이전 대화」가 없다)
        insertRead.run(active, x, 5, readAt);
        insertRead.run(deactivated, x, 2, readAt);
        insertRead.run(active, y, 1, readAt);
        // 다른 워크스페이스 — 워크스페이스를 넘어 짝짓지 않는다
        const ws2 = uuid();
        const stranger = uuid();
        const z = uuid();
        const d = uuid();
        insertWorkspace.run(ws2, t);
        insertUser.run(stranger, ws2, "stranger", "Stranger", t);
        insertMembership.run(uuid(), ws2, stranger, null);
        insertChannel.run(z, ws2, "z", stranger, t, 2);
        insertConversation.run(d, z, "D", stranger, t, 2);

        const before = Date.now();
        migrate(db, { migrationsFolder: migrationsFolder() });

        const rows = db.select().from(schema.conversationReads).all();
        const simple = rows.map((r) => ({ u: r.userId, c: r.conversationId, seq: r.lastReadSeq }));
        expect(simple).toEqual(
          expect.arrayContaining([
            // ① 옛 채널 읽음 → 「이전 대화」, 그 대화 끝(3)으로 깎는다
            { u: active, c: x, seq: 3 },
            { u: deactivated, c: x, seq: 2 },
            // ② 그 밖의 대화는 membership 마다 끝까지
            { u: active, c: b, seq: 5 },
            { u: deactivated, c: b, seq: 5 },
            { u: active, c: c, seq: 7 },
            { u: deactivated, c: c, seq: 7 },
            { u: stranger, c: d, seq: 2 },
          ]),
        );
        expect(rows).toHaveLength(7);
        // ① 은 옛 행의 시각을 그대로, ② 는 마이그레이션이 돈 때
        const at = (u: string, conv: string) =>
          rows.find((r) => r.userId === u && r.conversationId === conv)!.updatedAt.getTime();
        expect(at(active, x)).toBe(readAt);
        expect(at(active, b)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
        expect(
          sqlite
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_reads'")
            .all(),
        ).toEqual([]);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("agent dms 마이그레이션", () => {
  it("_conversation_reads 까지 적용된 DB 에 얹으면 옛 채널은 channel(주인·에이전트 없음), 옛 에이전트의 dm_access 는 admins — (주인, 에이전트) DM 은 하나뿐이다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_conversation_reads");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const [ws, user, ch, agent] = [uuid(), uuid(), uuid(), uuid()];
        const t = new Date("2026-10-26T00:00:00.000Z").getTime();
        sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'w', ?)").run(ws, t);
        sqlite
          .prepare(
            "INSERT INTO users (id, workspace_id, handle, display_name, auth_provider, created_at) VALUES (?, ?, 'jang', '장', 'local', ?)",
          )
          .run(user, ws, t);
        sqlite
          .prepare(
            "INSERT INTO channels (id, workspace_id, name, relay_policy_json, visibility, created_by, created_at) VALUES (?, ?, 'general', '{\"maxRelayTurns\":4,\"allowPairs\":\"all\"}', 'public', ?, ?)",
          )
          .run(ch, ws, user, t);
        sqlite
          .prepare(
            "INSERT INTO agents (id, workspace_id, provider, provider_agent_id, handle, name, enabled, created_at) VALUES (?, ?, 'claude', 'dev', 'dev', 'Dev', 1, ?)",
          )
          .run(agent, ws, t);

        migrate(db, { migrationsFolder: migrationsFolder() });

        expect(
          db
            .select({
              kind: schema.channels.kind,
              owner: schema.channels.dmOwnerId,
              agent: schema.channels.dmAgentId,
            })
            .from(schema.channels)
            .all(),
        ).toEqual([{ kind: "channel", owner: null, agent: null }]);
        expect(db.select({ dmAccess: schema.agents.dmAccess }).from(schema.agents).all()).toEqual([
          { dmAccess: "admins" },
        ]);
        const dm = (id: string) =>
          db
            .insert(schema.channels)
            .values({
              id,
              workspaceId: ws,
              name: "dm",
              relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
              visibility: "private",
              createdBy: user,
              createdAt: new Date(t),
              kind: "dm",
              dmOwnerId: user,
              dmAgentId: agent,
            })
            .run();
        dm(uuid());
        expect(() => dm(uuid())).toThrow(/UNIQUE/);
        // 일반 채널은 둘 다 null 이라 몇 개든 된다
        expect(() =>
          sqlite
            .prepare(
              "INSERT INTO channels (id, workspace_id, name, relay_policy_json, visibility, created_by, created_at) VALUES (?, ?, 'random', '{\"maxRelayTurns\":4,\"allowPairs\":\"all\"}', 'public', ?, ?)",
            )
            .run(uuid(), ws, user, t),
        ).not.toThrow();
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("러너 제공자 마이그레이션(0030)", () => {
  it("_agent_dms 까지 적용된 DB 에 얹으면 claude 에이전트는 provider runner·program claude, OpenClaw 는 program null — 부분 유일 색인은 runner 행에 걸린다", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_agent_dms");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const ws = uuid();
        const t = new Date("2026-10-29T00:00:00.000Z").getTime();
        sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'w', ?)").run(ws, t);
        // 옛 스키마에는 program 이 없다 — SQL 로 넣는다
        const insertAgent = (handle: string, provider: string, providerAgentId: string) => {
          const id = uuid();
          sqlite
            .prepare(
              "INSERT INTO agents (id, workspace_id, provider, provider_agent_id, handle, name, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
            )
            .run(id, ws, provider, providerAgentId, handle, handle, t);
          return id;
        };
        const coder = insertAgent("coder", "claude", "coder");
        const dev = insertAgent("dev", "openclaw", "dev");

        migrate(db, { migrationsFolder: migrationsFolder() });

        const rows = db
          .select({ id: agents.id, provider: agents.provider, program: agents.program })
          .from(agents)
          .all();
        expect([...rows].sort((a, b) => a.provider.localeCompare(b.provider))).toEqual([
          { id: dev, provider: "openclaw", program: null },
          { id: coder, provider: "runner", program: "claude" },
        ]);
        const indexes = sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agents'")
          .all()
          .map((r) => (r as { name: string }).name);
        expect(indexes).toContain("agents_runner_ws_agent");
        expect(indexes).not.toContain("agents_claude_ws_agent");
        // 옮긴 행과 같은 id 의 러너 에이전트는 둘이 될 수 없다. 색인은 runner 행에만 걸린다 — 같은 id 의 OpenClaw 행은 막지 않는다
        expect(() => insertAgent("coder-2", "runner", "coder")).toThrow(/UNIQUE/);
        expect(() => insertAgent("coder-oc", "openclaw", "coder")).not.toThrow();
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("러너 프로젝트 마이그레이션(0031)", () => {
  it("_runner_provider 까지 적용된 DB 에 얹으면 프로젝트 없는 러너 에이전트는 보관된다 — 이미 보관한 것·OpenClaw 는 그대로, 새 열은 기본값", () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-db-mig-"));
    try {
      const older = migrationsUpTo(dir, "_runner_provider");
      const sqlite = new Database(join(dir, "app.db"));
      try {
        const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
        migrate(db, { migrationsFolder: older });
        const ws = uuid();
        const t = new Date("2026-10-29T00:00:00.000Z").getTime();
        const archivedBefore = new Date("2026-10-01T00:00:00.000Z").getTime();
        sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, 'w', ?)").run(ws, t);
        const insertAgent = (handle: string, provider: string, archivedAt: number | null) => {
          const id = uuid();
          sqlite
            .prepare(
              "INSERT INTO agents (id, workspace_id, provider, provider_agent_id, handle, name, enabled, created_at, archived_at, program) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
            )
            .run(
              id,
              ws,
              provider,
              handle,
              handle,
              handle,
              t,
              archivedAt,
              provider === "runner" ? "claude" : null,
            );
          return id;
        };
        const coder = insertAgent("coder", "runner", null);
        const old = insertAgent("old", "runner", archivedBefore);
        const dev = insertAgent("dev", "openclaw", null);

        const before = Date.now();
        migrate(db, { migrationsFolder: migrationsFolder() });

        const rows = new Map(
          db
            .select()
            .from(agents)
            .all()
            .map((r) => [r.id, r]),
        );
        const archivedAt = rows.get(coder)?.archivedAt?.getTime() ?? 0;
        expect(archivedAt).toBeGreaterThanOrEqual(before - 1_000);
        expect(archivedAt).toBeLessThanOrEqual(Date.now() + 1_000);
        expect(rows.get(old)?.archivedAt?.getTime()).toBe(archivedBefore);
        expect(rows.get(dev)?.archivedAt).toBeNull();
        expect(rows.get(coder)).toMatchObject({
          runnerProjectId: null,
          model: null,
          permissionMode: "default",
          allowedToolsJson: null,
          disallowedToolsJson: [],
          instructionsRevision: 0,
        });
        // 같은 러너·루트·경로의 보관 안 된 프로젝트는 하나 — 보관한 것은 겹쳐도 된다
        const token = uuid();
        sqlite
          .prepare(
            "INSERT INTO runner_tokens (id, workspace_id, label, hash, prefix, created_at) VALUES (?, ?, 'laptop', ?, 'abcdef', ?)",
          )
          .run(token, ws, "h".repeat(64), t);
        const insertProject = (archived: number | null) =>
          sqlite
            .prepare(
              "INSERT INTO runner_projects (id, workspace_id, runner_token_id, root_id, rel_path, label, created_at, archived_at) VALUES (?, ?, ?, 'src', 'dodok', 'dodok', ?, ?)",
            )
            .run(uuid(), ws, token, t, archived);
        insertProject(t);
        insertProject(null);
        expect(() => insertProject(null)).toThrow(/UNIQUE/);
      } finally {
        sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
