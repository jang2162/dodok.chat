import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentSessions, agents } from "../src/db/schema.sqlite";
import { updateChannel } from "../src/modules/channels/service";
import {
  ensureProviderSessionId,
  ensureSession,
  renewSessionOnPromptChange,
} from "../src/modules/sessions/service";
import { newTestDb } from "./helpers/db";
import { channelConversation, seedChannelWithAgent } from "./helpers/seed";

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
    const first = ensureSession(db, adapter, { conversationId: channelConversation(db, channelId), agentId });
    expect(first.needsPromptContext).toBe(false);
    expect(first.session).toMatchObject({
      channelId,
      agentId,
      sessionKey: `agent:dev-main:dodok:channel:${channelConversation(db, channelId)}`,
      promptRevisionAtStart: 1,
      sessionStartedAt: null,
      lifecycleRevision: null,
    });

    const again = ensureSession(db, adapter, { conversationId: channelConversation(db, channelId), agentId });
    expect(again.session.id).toBe(first.session.id);
    expect(again.needsPromptContext).toBe(false);
    expect(db.select().from(agentSessions).all()).toHaveLength(1);
  });

  it("세션이 생긴 뒤 채널 promptRevision 이 오르면 needsPromptContext=true", () => {
    const { db, adapter, channelId, agentId } = setup();
    ensureSession(db, adapter, { conversationId: channelConversation(db, channelId), agentId });
    updateChannel(db, channelId, { prompt: "짧게 답해" });
    updateChannel(db, channelId, { prompt: "더 짧게" });

    const stale = ensureSession(db, adapter, { conversationId: channelConversation(db, channelId), agentId });
    expect(stale.session.promptRevisionAtStart).toBe(1);
    expect(stale.needsPromptContext).toBe(true);
  });

  it("ensureProviderSessionId 는 비었을 때 UUID 를 써 두고 다음에는 같은 값", () => {
    const { db, adapter, channelId, agentId } = setup();
    const { session } = ensureSession(db, adapter, {
      conversationId: channelConversation(db, channelId),
      agentId,
    });
    expect(session.providerSessionId).toBeNull();

    const first = ensureProviderSessionId(db, session.id);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ensureProviderSessionId(db, session.id)).toBe(first);

    expect(() => ensureProviderSessionId(db, "01a09fc9-d204-7551-89d6-38544d07a1ff")).toThrow();
  });

  it("renewSessionOnPromptChange — 리비전이 그대로면 아무것도 안 바꾸고 false", () => {
    const { db, adapter, channelId, agentId } = setup();
    const { session } = ensureSession(db, adapter, {
      conversationId: channelConversation(db, channelId),
      agentId,
    });
    const id = ensureProviderSessionId(db, session.id);
    updateChannel(db, channelId, { prompt: null, topic: "주제만" });
    expect(renewSessionOnPromptChange(db, session.id)).toBe(false);
    expect(ensureProviderSessionId(db, session.id)).toBe(id);
  });

  it("renewSessionOnPromptChange — 리비전이 오르면 세션 id 를 비우고 리비전·시작 표지를 맞춘다, 한 번만 true", () => {
    const { db, adapter, channelId, agentId } = setup();
    const { session } = ensureSession(db, adapter, {
      conversationId: channelConversation(db, channelId),
      agentId,
    });
    const old = ensureProviderSessionId(db, session.id);
    db.update(agentSessions)
      .set({
        sessionStartedAt: new Date("2026-09-15T01:02:03.456Z"),
        lifecycleRevision: "0f7c2b8e-1d2a-4c55-9a51-0b8f3f0d6e11",
      })
      .where(eq(agentSessions.id, session.id))
      .run();
    updateChannel(db, channelId, { prompt: "짧게 답해" });

    expect(renewSessionOnPromptChange(db, session.id)).toBe(true);
    const row = db.select().from(agentSessions).where(eq(agentSessions.id, session.id)).get();
    expect(row).toMatchObject({
      providerSessionId: null,
      promptRevisionAtStart: 2,
      sessionStartedAt: null,
      lifecycleRevision: null,
    });
    expect(
      ensureSession(db, adapter, { conversationId: channelConversation(db, channelId), agentId })
        .needsPromptContext,
    ).toBe(false);
    expect(renewSessionOnPromptChange(db, session.id)).toBe(false);
    expect(ensureProviderSessionId(db, session.id)).not.toBe(old);
  });

  it("renewSessionOnPromptChange — 아직 세션 id 가 없으면(대화 전) 리비전만 맞추고 false", () => {
    const { db, adapter, channelId, agentId } = setup();
    const { session } = ensureSession(db, adapter, {
      conversationId: channelConversation(db, channelId),
      agentId,
    });
    updateChannel(db, channelId, { prompt: "짧게 답해" });
    expect(renewSessionOnPromptChange(db, session.id)).toBe(false);
    expect(
      ensureSession(db, adapter, { conversationId: channelConversation(db, channelId), agentId }).session
        .promptRevisionAtStart,
    ).toBe(2);
  });

  it("renewSessionOnPromptChange — 스레드 세션 행은 채널 행과 따로 센다", () => {
    const { db, adapter, channelId, agentId } = setup();
    const threadRootId = "01a09fc9-d204-7551-89d6-38544d07a1ff";
    const channelSession = ensureSession(db, adapter, {
      conversationId: channelConversation(db, channelId),
      agentId,
    }).session;
    const threadSession = ensureSession(db, adapter, {
      conversationId: channelConversation(db, channelId),
      agentId,
      threadRootId,
    }).session;
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
    const channel = ensureSession(db, adapter, {
      conversationId: channelConversation(db, channelId),
      agentId,
    }).session;
    const a = ensureSession(db, adapter, {
      conversationId: channelConversation(db, channelId),
      agentId,
      threadRootId: ROOT_A,
    }).session;
    const b = ensureSession(db, adapter, {
      conversationId: channelConversation(db, channelId),
      agentId,
      threadRootId: ROOT_B,
    }).session;
    expect(a.sessionKey).toBe(
      `agent:dev-main:dodok:channel:${channelConversation(db, channelId)}:thread:${ROOT_A}`,
    );
    expect(a.threadRootId).toBe(ROOT_A);
    expect(new Set([channel.id, a.id, b.id]).size).toBe(3);
    expect(
      ensureSession(db, adapter, {
        conversationId: channelConversation(db, channelId),
        agentId,
        threadRootId: ROOT_A,
      }).session.id,
    ).toBe(a.id);
    expect(
      ensureSession(db, adapter, { conversationId: channelConversation(db, channelId), agentId }).session.id,
    ).toBe(channel.id);
    expect(db.select().from(agentSessions).all()).toHaveLength(3);
  });

  describe("리액션 커서(reactions_seen_at) — 새 세션은 그 전에 달린 리액션을 받지 않는다", () => {
    const LONG_AGO = new Date("2000-01-01T00:00:00.000Z");
    const cursorOf = (db: ReturnType<typeof setup>["db"], id: string) =>
      db.select().from(agentSessions).where(eq(agentSessions.id, id)).get()?.reactionsSeenAt;
    const rewind = (db: ReturnType<typeof setup>["db"], id: string) =>
      db.update(agentSessions).set({ reactionsSeenAt: LONG_AGO }).where(eq(agentSessions.id, id)).run();

    it("ensureSession 이 만든 행(채널·스레드)은 만든 시각", () => {
      const { db, adapter, channelId, agentId } = setup();
      const before = Date.now();
      const channel = ensureSession(db, adapter, {
        conversationId: channelConversation(db, channelId),
        agentId,
      }).session;
      const thread = ensureSession(db, adapter, {
        conversationId: channelConversation(db, channelId),
        agentId,
        threadRootId: "01a09fc9-d204-7551-89d6-38544d07a1dd",
      }).session;
      for (const row of [channel, thread]) {
        expect(row.reactionsSeenAt?.getTime()).toBeGreaterThanOrEqual(before);
        expect(cursorOf(db, row.id)?.getTime()).toBeGreaterThanOrEqual(before);
      }
    });

    it("이미 있는 행을 ensureSession 이 다시 읽을 때는 커서를 건드리지 않는다", () => {
      const { db, adapter, channelId, agentId } = setup();
      const { session } = ensureSession(db, adapter, {
        conversationId: channelConversation(db, channelId),
        agentId,
      });
      rewind(db, session.id);
      expect(
        ensureSession(db, adapter, { conversationId: channelConversation(db, channelId), agentId }).session
          .reactionsSeenAt,
      ).toEqual(LONG_AGO);
    });

    it("renewSessionOnPromptChange 는 리비전이 바뀌었을 때만 지금으로 올린다", () => {
      const { db, adapter, channelId, agentId } = setup();
      const { session } = ensureSession(db, adapter, {
        conversationId: channelConversation(db, channelId),
        agentId,
      });
      ensureProviderSessionId(db, session.id);
      rewind(db, session.id);

      expect(renewSessionOnPromptChange(db, session.id)).toBe(false);
      expect(cursorOf(db, session.id)).toEqual(LONG_AGO);

      updateChannel(db, channelId, { prompt: "짧게 답해" });
      const before = Date.now();
      expect(renewSessionOnPromptChange(db, session.id)).toBe(true);
      expect(cursorOf(db, session.id)?.getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  it("규칙 밖 providerAgentId 는 세션 키를 만들지 않고 던진다(빌더 규칙)", () => {
    const { db, adapter, channelId, agentId } = setup();
    db.update(agents).set({ providerAgentId: "dev:main" }).where(eq(agents.id, agentId)).run();
    expect(() =>
      ensureSession(db, adapter, { conversationId: channelConversation(db, channelId), agentId }),
    ).toThrow();
    expect(db.select().from(agentSessions).all()).toHaveLength(0);
  });
});
