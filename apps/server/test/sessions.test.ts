import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentSessions, agents } from "../src/db/schema.sqlite";
import { updateChannel } from "../src/modules/channels/service";
import {
  clearProviderSessionId,
  ensureProviderSessionId,
  ensureSession,
  markSessionReset,
  renewSessionOnPromptChange,
} from "../src/modules/sessions/service";
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

  it("ensureProviderSessionId 는 비었을 때 UUID 를 써 두고 다음에는 같은 값 — 비우는 것은 clearProviderSessionId 만", () => {
    const { db, adapter, channelId, agentId } = setup();
    const { session } = ensureSession(db, adapter, { channelId, agentId });
    expect(session.providerSessionId).toBeNull();

    const first = ensureProviderSessionId(db, session.id);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ensureProviderSessionId(db, session.id)).toBe(first);

    // 리셋 표시는 그 열을 건드리지 않는다 — 비우는 것은 clearProviderSessionId 만
    expect(markSessionReset(db, channelId, agentId, {}).providerSessionId).toBe(first);
    clearProviderSessionId(db, session.id);
    expect(ensureSession(db, adapter, { channelId, agentId }).session.providerSessionId).toBeNull();
    const next = ensureProviderSessionId(db, session.id);
    expect(next).not.toBe(first);
    expect(() => ensureProviderSessionId(db, "01a09fc9-d204-7551-89d6-38544d07a1ff")).toThrow();
  });

  it("renewSessionOnPromptChange — 리비전이 그대로면 아무것도 안 바꾸고 false", () => {
    const { db, adapter, channelId, agentId } = setup();
    const { session } = ensureSession(db, adapter, { channelId, agentId });
    const id = ensureProviderSessionId(db, session.id);
    updateChannel(db, channelId, { prompt: null, topic: "주제만" });
    expect(renewSessionOnPromptChange(db, session.id)).toBe(false);
    expect(ensureProviderSessionId(db, session.id)).toBe(id);
  });

  it("renewSessionOnPromptChange — 리비전이 오르면 세션 id 를 비우고 「새 대화」처럼 리비전·시작 표지를 맞춘다, 한 번만 true", () => {
    const { db, adapter, channelId, agentId } = setup();
    const { session } = ensureSession(db, adapter, { channelId, agentId });
    const old = ensureProviderSessionId(db, session.id);
    markSessionReset(db, channelId, agentId, {
      sessionStartedAt: "2026-09-15T01:02:03.456Z",
      lifecycleRevision: "0f7c2b8e-1d2a-4c55-9a51-0b8f3f0d6e11",
    });
    updateChannel(db, channelId, { prompt: "짧게 답해" });

    expect(renewSessionOnPromptChange(db, session.id)).toBe(true);
    const row = db.select().from(agentSessions).where(eq(agentSessions.id, session.id)).get();
    expect(row).toMatchObject({
      providerSessionId: null,
      promptRevisionAtStart: 2,
      sessionStartedAt: null,
      lifecycleRevision: null,
    });
    expect(ensureSession(db, adapter, { channelId, agentId }).needsPromptContext).toBe(false);
    expect(renewSessionOnPromptChange(db, session.id)).toBe(false);
    expect(ensureProviderSessionId(db, session.id)).not.toBe(old);
  });

  it("renewSessionOnPromptChange — 아직 세션 id 가 없으면(대화 전) 리비전만 맞추고 false", () => {
    const { db, adapter, channelId, agentId } = setup();
    const { session } = ensureSession(db, adapter, { channelId, agentId });
    updateChannel(db, channelId, { prompt: "짧게 답해" });
    expect(renewSessionOnPromptChange(db, session.id)).toBe(false);
    expect(ensureSession(db, adapter, { channelId, agentId }).session.promptRevisionAtStart).toBe(2);
  });

  it("renewSessionOnPromptChange — 스레드 세션 행은 채널 행과 따로 센다", () => {
    const { db, adapter, channelId, agentId } = setup();
    const threadRootId = "01a09fc9-d204-7551-89d6-38544d07a1ff";
    const channelSession = ensureSession(db, adapter, { channelId, agentId }).session;
    const threadSession = ensureSession(db, adapter, { channelId, agentId, threadRootId }).session;
    ensureProviderSessionId(db, channelSession.id);
    const threadId = ensureProviderSessionId(db, threadSession.id);
    updateChannel(db, channelId, { prompt: "짧게 답해" });

    expect(renewSessionOnPromptChange(db, channelSession.id)).toBe(true);
    const threadRow = db.select().from(agentSessions).where(eq(agentSessions.id, threadSession.id)).get();
    expect(threadRow).toMatchObject({ providerSessionId: threadId, promptRevisionAtStart: 1 });
    expect(renewSessionOnPromptChange(db, threadSession.id)).toBe(true);
  });

  it("스레드 세션은 (에이전트, 채널, 스레드)마다 따로 — 키에 스레드 접미사, 채널 세션과 섞이지 않는다", () => {
    const { db, adapter, channelId, agentId } = setup();
    const ROOT_A = "01a09fc9-d204-7551-89d6-38544d07a1aa";
    const ROOT_B = "01a09fc9-d204-7551-89d6-38544d07a1bb";
    const channel = ensureSession(db, adapter, { channelId, agentId }).session;
    const a = ensureSession(db, adapter, { channelId, agentId, threadRootId: ROOT_A }).session;
    const b = ensureSession(db, adapter, { channelId, agentId, threadRootId: ROOT_B }).session;
    expect(a.sessionKey).toBe(`agent:dev-main:dodok:channel:${channelId}:thread:${ROOT_A}`);
    expect(a.threadRootId).toBe(ROOT_A);
    expect(new Set([channel.id, a.id, b.id]).size).toBe(3);
    expect(ensureSession(db, adapter, { channelId, agentId, threadRootId: ROOT_A }).session.id).toBe(a.id);
    expect(ensureSession(db, adapter, { channelId, agentId }).session.id).toBe(channel.id);
    expect(db.select().from(agentSessions).all()).toHaveLength(3);
  });

  it("스레드 markSessionReset 은 그 스레드 행만 바꾸고, 없으면 스레드 키로 만든다", () => {
    const { db, adapter, channelId, agentId } = setup();
    const ROOT = "01a09fc9-d204-7551-89d6-38544d07a1cc";
    const channel = ensureSession(db, adapter, { channelId, agentId }).session;
    updateChannel(db, channelId, { prompt: "p" });

    const created = markSessionReset(db, channelId, agentId, { lifecycleRevision: "t1" }, ROOT);
    expect(created).toMatchObject({
      threadRootId: ROOT,
      sessionKey: adapter.sessionKeyFor("dev-main", channelId, ROOT),
      promptRevisionAtStart: 2,
      lifecycleRevision: "t1",
    });
    const again = markSessionReset(db, channelId, agentId, { lifecycleRevision: "t2" }, ROOT);
    expect(again.id).toBe(created.id);
    expect(again.lifecycleRevision).toBe("t2");

    const untouched = db.select().from(agentSessions).where(eq(agentSessions.id, channel.id)).get();
    expect(untouched).toMatchObject({ promptRevisionAtStart: 1, lifecycleRevision: null });
  });

  it("규칙 밖 providerAgentId 는 세션 키를 만들지 않고 던진다(빌더 규칙)", () => {
    const { db, adapter, channelId, agentId } = setup();
    db.update(agents).set({ providerAgentId: "dev:main" }).where(eq(agents.id, agentId)).run();
    expect(() => ensureSession(db, adapter, { channelId, agentId })).toThrow();
    expect(() => markSessionReset(db, channelId, agentId, {})).toThrow();
    expect(db.select().from(agentSessions).all()).toHaveLength(0);
  });
});
