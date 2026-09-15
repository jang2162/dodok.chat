import { FakeAdapter } from "@dodok/openclaw-adapter";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentSessions, agents } from "../src/db/schema.sqlite";
import { updateChannel } from "../src/modules/channels/service";
import { ensureSession, markSessionReset } from "../src/modules/sessions/service";
import { newTestDb } from "./helpers/db";
import { seedChannelWithAgent } from "./helpers/seed";

function setup() {
  const db = newTestDb();
  const adapter = new FakeAdapter();
  const ids = seedChannelWithAgent(db);
  // handle 과 다른 값으로 두어 세션 키가 agents.providerAgentId 에서 오는지 가른다
  db.update(agents).set({ providerAgentId: "dev-main" }).where(eq(agents.id, ids.agentId)).run();
  return { db, adapter, ...ids };
}

describe("sessions service", () => {
  it("첫 ensureSession 은 현재 promptRevision 으로 행을 만들고 needsPromptContext=false, 다시 불러도 같은 행", () => {
    const { db, adapter, channelId, agentId } = setup();
    const first = ensureSession(db, adapter, { channelId, agentId });
    expect(first.needsPromptContext).toBe(false);
    expect(first.session).toMatchObject({
      channelId,
      agentId,
      sessionKey: `agent:dev-main:dodok:channel:${channelId}`,
      promptRevisionAtStart: 1,
      sessionStartedAt: null,
      lifecycleRevision: null,
    });

    const again = ensureSession(db, adapter, { channelId, agentId });
    expect(again.session.id).toBe(first.session.id);
    expect(again.needsPromptContext).toBe(false);
    expect(db.select().from(agentSessions).all()).toHaveLength(1);
  });

  it("세션이 생긴 뒤 채널 promptRevision 이 오르면 needsPromptContext=true, markSessionReset 뒤 false", () => {
    const { db, adapter, channelId, agentId } = setup();
    ensureSession(db, adapter, { channelId, agentId });
    updateChannel(db, channelId, { prompt: "짧게 답해" });
    updateChannel(db, channelId, { prompt: "더 짧게" });

    const stale = ensureSession(db, adapter, { channelId, agentId });
    expect(stale.session.promptRevisionAtStart).toBe(1);
    expect(stale.needsPromptContext).toBe(true);

    const reset = markSessionReset(db, channelId, agentId, {
      sessionStartedAt: "2026-09-15T01:02:03.456Z",
      lifecycleRevision: "0f7c2b8e-1d2a-4c55-9a51-0b8f3f0d6e11",
    });
    expect(reset).toMatchObject({
      id: stale.session.id,
      promptRevisionAtStart: 3,
      sessionStartedAt: new Date("2026-09-15T01:02:03.456Z"),
      lifecycleRevision: "0f7c2b8e-1d2a-4c55-9a51-0b8f3f0d6e11",
    });
    expect(reset.lastSyncedAt).toBeInstanceOf(Date);

    const fresh = ensureSession(db, adapter, { channelId, agentId });
    expect(fresh.session.id).toBe(stale.session.id);
    expect(fresh.needsPromptContext).toBe(false);
  });

  it("markSessionReset 은 행이 없으면 원형 세션 키로 만든다", () => {
    const { db, adapter, channelId, agentId } = setup();
    updateChannel(db, channelId, { prompt: "p" });

    const row = markSessionReset(db, channelId, agentId, {});
    expect(row).toMatchObject({
      channelId,
      agentId,
      sessionKey: adapter.sessionKeyFor("dev-main", channelId),
      promptRevisionAtStart: 2,
      sessionStartedAt: null,
      lifecycleRevision: null,
    });
    expect(row.lastSyncedAt).toBeInstanceOf(Date);
    expect(ensureSession(db, adapter, { channelId, agentId })).toEqual({
      session: row,
      needsPromptContext: false,
    });
  });
});
