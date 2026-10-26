import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { assertChannelReadable, canReadChannel, readableChannelSql } from "../src/auth/channel-access";
import { channels, users } from "../src/db/schema.sqlite";
import { newTestDb } from "./helpers/db";
import { createDmChannelForTest, seedChannelWithAgent } from "./helpers/seed";

const A = uuid();
const B = uuid();

describe("canReadChannel", () => {
  it("일반 채널은 누구나 읽는다", () => {
    expect(canReadChannel({ userId: A }, { kind: "channel", dmOwnerId: null })).toBe(true);
  });
  it("DM 은 주인만 — 주인이 아닌 사람은 역할과 상관없이(owner 여도) 못 읽는다", () => {
    const dm = { kind: "dm", dmOwnerId: A };
    expect(canReadChannel({ userId: A }, dm)).toBe(true);
    // 역할은 인자에 없다 — B 가 owner 여도 판정은 같다(역할을 넘기는 자리를 만들지 않으려고 시그니처가 id 하나만 받는다)
    expect(canReadChannel({ userId: B }, dm)).toBe(false);
  });
  it("주체가 없는 자리(빈 id)는 DM 을 읽지 못한다", () => {
    expect(canReadChannel({ userId: "" }, { kind: "dm", dmOwnerId: A })).toBe(false);
    expect(canReadChannel({ userId: "" }, { kind: "channel", dmOwnerId: null })).toBe(true);
  });
  it("assertChannelReadable 은 못 읽으면 없는 채널과 같은 404 를 던진다", () => {
    expect(() => assertChannelReadable({ kind: "dm", dmOwnerId: A }, B)).toThrow(
      expect.objectContaining({ status: 404, body: { code: "NOT_FOUND", message: "channel not found" } }),
    );
    expect(() => assertChannelReadable({ kind: "dm", dmOwnerId: A }, A)).not.toThrow();
  });
});

describe("readableChannelSql", () => {
  it("주인 A·B 의 DM 과 일반 채널 하나 중 A 에게는 채널과 A 의 DM 만", () => {
    const db = newTestDb();
    const s = seedChannelWithAgent(db);
    const other = uuid();
    db.insert(users)
      .values({
        id: other,
        workspaceId: s.workspaceId,
        handle: "mia",
        displayName: "mia",
        authProvider: "email",
        createdAt: new Date(),
      })
      .run();
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
});
