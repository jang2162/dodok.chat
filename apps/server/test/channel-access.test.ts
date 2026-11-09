import { and, eq, sql } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import {
  assertChannelReadable,
  canReadChannel,
  membersOnly,
  readableChannelSql,
  readableChannelSqlFor,
} from "../src/auth/channel-access";
import type { DbOrTx } from "../src/db/client";
import { channels, users } from "../src/db/schema.sqlite";
import { insertRun } from "../src/modules/runs/store";
import { newTestDb } from "./helpers/db";
import {
  createDirectChannelForTest,
  createDmChannelForTest,
  seedChannelWithAgent,
  seedConversation,
} from "./helpers/seed";

const A = uuid();
const B = uuid();

function addUser(db: DbOrTx, workspaceId: string, handle: string): string {
  const id = uuid();
  db.insert(users)
    .values({ id, workspaceId, handle, displayName: handle, authProvider: "email", createdAt: new Date() })
    .run();
  return id;
}

/** 모르는 kind 의 채널 행 — 서비스로는 만들 수 없어 SQL 로 직접 넣는다(Review Focus 2) */
function insertUnknownKind(db: DbOrTx, workspaceId: string, createdBy: string): string {
  const id = uuid();
  db.insert(channels)
    .values({
      id,
      workspaceId,
      name: "zzz",
      relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
      visibility: "public",
      createdBy,
      createdAt: new Date(),
    })
    .run();
  db.run(sql`UPDATE channels SET kind = 'zzz' WHERE id = ${id}`);
  return id;
}

describe("canReadChannel", () => {
  const db = newTestDb();
  it("일반 채널은 누구나 읽는다", () => {
    expect(canReadChannel(db, { userId: A }, { id: uuid(), kind: "channel", dmOwnerId: null })).toBe(true);
  });
  it("DM 은 주인만 — 주인이 아닌 사람은 역할과 상관없이(owner 여도) 못 읽는다", () => {
    const dm = { id: uuid(), kind: "dm", dmOwnerId: A };
    expect(canReadChannel(db, { userId: A }, dm)).toBe(true);
    // 역할은 인자에 없다 — B 가 owner 여도 판정은 같다(역할을 넘기는 자리를 만들지 않으려고 시그니처가 id 하나만 받는다)
    expect(canReadChannel(db, { userId: B }, dm)).toBe(false);
  });
  it("주체가 없는 자리(빈 id)는 DM 을 읽지 못한다", () => {
    expect(canReadChannel(db, { userId: "" }, { id: uuid(), kind: "dm", dmOwnerId: A })).toBe(false);
    expect(canReadChannel(db, { userId: "" }, { id: uuid(), kind: "channel", dmOwnerId: null })).toBe(true);
  });
  it("assertChannelReadable 은 못 읽으면 없는 채널과 같은 404 를 던진다", () => {
    const dm = { id: uuid(), kind: "dm", dmOwnerId: A };
    expect(() => assertChannelReadable(db, dm, B)).toThrow(
      expect.objectContaining({ status: 404, body: { code: "NOT_FOUND", message: "channel not found" } }),
    );
    expect(() => assertChannelReadable(db, dm, A)).not.toThrow();
  });

  it("direct 는 사람 참여자만 — 참여하지 않은 owner·참여 에이전트의 id·빈 id 는 못 읽고, 모르는 kind 는 누구도 못 읽는다", () => {
    const tdb = newTestDb();
    const s = seedChannelWithAgent(tdb);
    const mia = addUser(tdb, s.workspaceId, "mia");
    const jun = addUser(tdb, s.workspaceId, "jun");
    const group = createDirectChannelForTest(tdb, {
      workspaceId: s.workspaceId,
      createdBy: mia,
      userIds: [jun],
      agentIds: [s.agentId],
    });
    expect(membersOnly(group)).toBe(true);
    expect(membersOnly({ kind: "channel" })).toBe(false);
    expect(membersOnly({ kind: "dm" })).toBe(false);
    expect(canReadChannel(tdb, { userId: mia }, group)).toBe(true);
    expect(canReadChannel(tdb, { userId: jun }, group)).toBe(true);
    // s.userId 는 이 워크스페이스의 owner 지만 참여자가 아니다
    expect(canReadChannel(tdb, { userId: s.userId }, group)).toBe(false);
    expect(canReadChannel(tdb, { userId: s.agentId }, group)).toBe(false);
    expect(canReadChannel(tdb, { userId: "" }, group)).toBe(false);
    expect(() => assertChannelReadable(tdb, group, s.userId)).toThrow(
      expect.objectContaining({ status: 404 }),
    );

    const unknown = { id: insertUnknownKind(tdb, s.workspaceId, mia), kind: "zzz", dmOwnerId: null };
    for (const userId of [mia, jun, s.userId, ""])
      expect(canReadChannel(tdb, { userId }, unknown)).toBe(false);
    // 모르는 kind 는 dmOwnerId 가 맞아도 열리지 않는다
    expect(canReadChannel(tdb, { userId: mia }, { ...unknown, dmOwnerId: mia })).toBe(false);
  });
});

describe("readableChannelSql", () => {
  it("주인 A·B 의 DM 과 일반 채널 하나 중 A 에게는 채널과 A 의 DM 만", () => {
    const db = newTestDb();
    const s = seedChannelWithAgent(db);
    const other = addUser(db, s.workspaceId, "mia");
    const dmA = createDmChannelForTest(db, {
      workspaceId: s.workspaceId,
      ownerId: s.userId,
      agentId: s.agentId,
    });
    const dmB = createDmChannelForTest(db, {
      workspaceId: s.workspaceId,
      ownerId: other,
      agentId: s.agentId,
    });
    const visible = (userId: string) =>
      db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.workspaceId, s.workspaceId), readableChannelSql(userId)))
        .all()
        .map((r) => r.id)
        .sort();
    expect(visible(s.userId)).toEqual([s.channelId, dmA.id].sort());
    expect(visible(other)).toEqual([s.channelId, dmB.id].sort());
    expect(visible("")).toEqual([s.channelId]);
  });

  it("채널·mia 의 DM·(mia, jun) direct·(jun, kai) direct·모르는 kind 가운데 mia 에게는 채널 + DM + 첫 direct 만", () => {
    const db = newTestDb();
    const s = seedChannelWithAgent(db);
    const mia = addUser(db, s.workspaceId, "mia");
    const jun = addUser(db, s.workspaceId, "jun");
    const kai = addUser(db, s.workspaceId, "kai");
    const dm = createDmChannelForTest(db, { workspaceId: s.workspaceId, ownerId: mia, agentId: s.agentId });
    const miaJun = createDirectChannelForTest(db, {
      workspaceId: s.workspaceId,
      createdBy: mia,
      userIds: [jun],
    });
    const junKai = createDirectChannelForTest(db, {
      workspaceId: s.workspaceId,
      createdBy: jun,
      userIds: [kai],
      agentIds: [s.agentId],
    });
    insertUnknownKind(db, s.workspaceId, mia);
    const visible = (userId: string) =>
      db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.workspaceId, s.workspaceId), readableChannelSql(userId)))
        .all()
        .map((r) => r.id)
        .sort();
    expect(visible(mia)).toEqual([s.channelId, dm.id, miaJun.id].sort());
    expect(visible(jun)).toEqual([s.channelId, miaJun.id, junKai.id].sort());
    expect(visible(s.userId)).toEqual([s.channelId]);
    // 참여 에이전트의 id 로는 direct 가 열리지 않는다(사람 참여자 행만 센다)
    expect(visible(s.agentId)).toEqual([s.channelId]);
    expect(visible("")).toEqual([s.channelId]);
  });
});

describe("readableChannelSqlFor — 제어 도구 주체의 읽기 범위(사람 간 DM 스펙 4.4)", () => {
  it("direct 런의 에이전트는 일반 채널 + 그 direct 하나(시킨 사람이 참여자일 때), 바깥 MCP 는 참여한 direct 전부", () => {
    const db = newTestDb();
    const s = seedChannelWithAgent(db);
    const mia = addUser(db, s.workspaceId, "mia");
    const jun = addUser(db, s.workspaceId, "jun");
    const kai = addUser(db, s.workspaceId, "kai");
    const dm = createDmChannelForTest(db, { workspaceId: s.workspaceId, ownerId: mia, agentId: s.agentId });
    const group = createDirectChannelForTest(db, {
      workspaceId: s.workspaceId,
      createdBy: mia,
      userIds: [jun],
      agentIds: [s.agentId],
    });
    const otherDirect = createDirectChannelForTest(db, {
      workspaceId: s.workspaceId,
      createdBy: mia,
      userIds: [kai],
    });
    const runIn = (channelId: string, requestedBy: string | null) => {
      const conversationId = seedConversation(db, channelId);
      return insertRun(db, {
        channelId,
        conversationId,
        agentId: s.agentId,
        triggerKind: "mention",
        rootMessageId: uuid(),
        relayDepth: 0,
        sessionKey: `agent:dev:dodok:channel:${conversationId}`,
        connectionId: null,
        requestedBy,
        createdAt: new Date(),
      }).id;
    };
    const visible = (principal: Parameters<typeof readableChannelSqlFor>[0]) =>
      db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.workspaceId, s.workspaceId), readableChannelSqlFor(principal)))
        .all()
        .map((r) => r.id)
        .sort();
    const groupRun = runIn(group.id, mia);
    expect(visible({ userId: mia, via: "agent", runId: groupRun })).toEqual([s.channelId, group.id].sort());
    // 시킨 사람이 그 direct 의 참여자가 아니거나 없으면 일반 채널만
    expect(visible({ userId: kai, via: "agent", runId: groupRun })).toEqual([s.channelId]);
    expect(visible({ userId: null, via: "agent", runId: groupRun })).toEqual([s.channelId]);
    // 일반 채널 런의 에이전트 — direct 없음(시킨 사람이 참여한 direct·DM 도)
    expect(visible({ userId: mia, via: "agent", runId: runIn(s.channelId, mia) })).toEqual([s.channelId]);
    // 런 없는 에이전트 주체 — 일반 채널만
    expect(visible({ userId: mia, via: "agent" })).toEqual([s.channelId]);
    // 바깥 MCP(개인 토큰) — 사람과 같다: 일반 채널 + 내 DM + 내가 참여한 direct 전부
    expect(visible({ userId: mia, via: "pat" })).toEqual(
      [s.channelId, dm.id, group.id, otherDirect.id].sort(),
    );
    expect(visible({ userId: jun, via: "pat" })).toEqual([s.channelId, group.id].sort());
  });
});
