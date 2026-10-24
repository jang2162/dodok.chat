import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentSessions, agents, channelMembers, channels, users, workspaces } from "../src/db/schema.sqlite";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";

describe("agent_sessions", () => {
  it("채널·에이전트당 한 행이고 promptRevision 기본값은 1", () => {
    const db = newTestDb();
    const { channelId, agentId } = seedChannelWithAgent(db);
    expect(db.select().from(channels).where(eq(channels.id, channelId)).get()?.promptRevision).toBe(1);
    db.insert(agentSessions)
      .values({
        id: "01",
        channelId,
        conversationId: channelId,
        agentId,
        sessionKey: "k",
        promptRevisionAtStart: 1,
      })
      .run();
    expect(() =>
      db
        .insert(agentSessions)
        .values({
          id: "02",
          channelId,
          conversationId: channelId,
          agentId,
          sessionKey: "k",
          promptRevisionAtStart: 1,
        })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it("Better Auth 테이블이 마이그레이션에 포함된다", () => {
    const db = newTestDb();
    const names = db
      .all<{ name: string }>(sql`select name from sqlite_master where type='table'`)
      .map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["user", "session", "account", "verification", "agent_sessions"]),
    );
  });
});

describe("seedChannelWithAgent", () => {
  it("workspaces·users·agents·channels·channel_members 에 행을 만든다", () => {
    const db = newTestDb();
    const ids = seedChannelWithAgent(db, { agentHandle: "fin", channelName: "ops" });
    expect(
      db
        .select()
        .from(workspaces)
        .all()
        .map((r) => r.id),
    ).toEqual([ids.workspaceId]);
    expect(db.select().from(users).get()).toMatchObject({
      id: ids.userId,
      workspaceId: ids.workspaceId,
      authProvider: "local",
    });
    expect(db.select().from(agents).get()).toMatchObject({
      id: ids.agentId,
      provider: "openclaw",
      providerAgentId: "fin",
      handle: "fin",
    });
    expect(db.select().from(channels).get()).toMatchObject({
      id: ids.channelId,
      name: "ops",
      relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
      visibility: "public",
    });
    const members = db
      .select({ memberType: channelMembers.memberType, memberId: channelMembers.memberId })
      .from(channelMembers)
      .where(eq(channelMembers.channelId, ids.channelId))
      .all();
    expect(members).toEqual(
      expect.arrayContaining([
        { memberType: "user", memberId: ids.userId },
        { memberType: "agent", memberId: ids.agentId },
      ]),
    );
    expect(members).toHaveLength(2);
  });
});
