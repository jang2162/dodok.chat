import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentSessions } from "../src/db/schema.sqlite";
import { updateAgent } from "../src/modules/agents/service";
import {
  ensureProviderSessionId,
  ensureSession,
  getSessionRow,
  renewSessionOnPromptChange,
  storeProgramSessionId,
} from "../src/modules/sessions/service";
import { newTestDb } from "./helpers/db";
import { channelConversation, seedChannelWithAgent } from "./helpers/seed";

// 러너 일반화 계획 판정 PR2·PR3 — 에이전트 지시 리비전도 러너 세션을 새로 열고, 프로그램이 지은 세션 id 는 세션 행에 둔다

function setup() {
  const db = newTestDb();
  const ids = seedChannelWithAgent(db);
  const { session } = ensureSession(db, new FakeAdapter(), {
    conversationId: channelConversation(db, ids.channelId),
    agentId: ids.agentId,
  });
  return { db, ...ids, sessionId: session.id };
}

describe("renewSessionOnPromptChange — 지시 리비전", () => {
  it("새 세션 행은 에이전트의 지금 지시 리비전으로 시작한다", () => {
    const db = newTestDb();
    const ids = seedChannelWithAgent(db);
    updateAgent(db, ids.agentId, { basePrompt: "하나" });
    updateAgent(db, ids.agentId, { basePrompt: "둘" });
    const { session } = ensureSession(db, new FakeAdapter(), {
      conversationId: channelConversation(db, ids.channelId),
      agentId: ids.agentId,
    });
    expect(session.instructionsRevisionAtStart).toBe(2);
    expect(renewSessionOnPromptChange(db, session.id)).toBe(false);
  });

  it("지시가 바뀌면 세션 id 를 비우고 리비전을 맞춘다 — 한 번만 true, 다음 세션 id 는 새 값", () => {
    const { db, agentId, sessionId } = setup();
    const old = ensureProviderSessionId(db, sessionId);
    updateAgent(db, agentId, { basePrompt: "커밋 전에 테스트를 돌린다" });
    expect(renewSessionOnPromptChange(db, sessionId)).toBe(true);
    expect(getSessionRow(db, sessionId)).toMatchObject({
      providerSessionId: null,
      instructionsRevisionAtStart: 1,
    });
    expect(renewSessionOnPromptChange(db, sessionId)).toBe(false);
    expect(ensureProviderSessionId(db, sessionId)).not.toBe(old);
  });

  it("이름만 바꾸면 세션은 그대로", () => {
    const { db, agentId, sessionId } = setup();
    const id = ensureProviderSessionId(db, sessionId);
    updateAgent(db, agentId, { name: "새 이름" });
    expect(renewSessionOnPromptChange(db, sessionId)).toBe(false);
    expect(ensureProviderSessionId(db, sessionId)).toBe(id);
  });

  it("세션 id 가 아직 없으면 리비전만 맞추고 false(버린 대화가 없다)", () => {
    const { db, agentId, sessionId } = setup();
    updateAgent(db, agentId, { basePrompt: "x" });
    expect(renewSessionOnPromptChange(db, sessionId)).toBe(false);
    expect(getSessionRow(db, sessionId)?.instructionsRevisionAtStart).toBe(1);
  });
});

describe("storeProgramSessionId — 프로그램이 지은 세션 id(run.session)", () => {
  it("비어 있을 때만 저장한다 — 이미 있으면 덮지 않고 false", () => {
    const { db, sessionId } = setup();
    expect(storeProgramSessionId(db, sessionId, "thread_a")).toBe(true);
    expect(storeProgramSessionId(db, sessionId, "thread_b")).toBe(false);
    expect(
      db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).get()?.providerSessionId,
    ).toBe("thread_a");
  });
});

describe("ensureProviderSessionId — 서버가 짓는 세션 id 는 UUID 다 [태스크 3 리뷰 L3]", () => {
  it("저장된 값이 UUID 면 그대로, 프로그램이 지은 값(UUID 아님)이면 새 UUID 로 바꿔 둔다", () => {
    const { db, sessionId } = setup();
    const first = ensureProviderSessionId(db, sessionId);
    expect(ensureProviderSessionId(db, sessionId)).toBe(first);
    db.update(agentSessions)
      .set({ providerSessionId: "thread_codex_1" })
      .where(eq(agentSessions.id, sessionId))
      .run();
    const fresh = ensureProviderSessionId(db, sessionId);
    expect(fresh).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(getSessionRow(db, sessionId)?.providerSessionId).toBe(fresh);
    expect(ensureProviderSessionId(db, sessionId)).toBe(fresh);
  });
});
