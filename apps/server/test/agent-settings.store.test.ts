import type { RunnerContextBreakdown, RunUsage } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { agents, conversationAgentSettings, conversations, runs } from "../src/db/schema.sqlite";
import { addMember, createChannel, removeMember } from "../src/modules/channels/service";
import { archiveAgent } from "../src/modules/agents/service";
import {
  contextOf,
  contextPercentOf,
  getEffectiveSettings,
  getSettingsRow,
  upsertSettings,
} from "../src/modules/conversations/agent-settings";
import { insertRun } from "../src/modules/runs/store";
import { newTestDb } from "./helpers/db";
import { createRunnerAgentForTest, seedConversation, seedWorkspace } from "./helpers/seed";

const silent = { warn: () => {} };

function setup() {
  const db = newTestDb();
  const { workspaceId, userId } = seedWorkspace(db, { userHandle: "mia" });
  const { agent } = createRunnerAgentForTest(db, { workspaceId, handle: "coder" });
  const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
  const conversationId = seedConversation(db, channel.id);
  const key = { conversationId, agentId: agent.id };
  return { db, workspaceId, userId, agent, channel, conversationId, key };
}

describe("세션 설정 저장소 — getEffectiveSettings·upsertSettings [세션 설정 스펙 S5·S10]", () => {
  it("행이 없고 시작값도 없으면 셋 다 null(「기본」)", () => {
    const { db, key } = setup();
    expect(getEffectiveSettings(db, key)).toEqual({ model: null, effort: null, permissionMode: null });
  });

  it("행이 없으면 에이전트 시작값, 행이 있으면 그 값", () => {
    const { db, key, userId } = setup();
    db.update(agents)
      .set({
        sessionDefaultModel: "sonnet",
        sessionDefaultEffort: "low",
        sessionDefaultPermissionMode: "plan",
      })
      .where(eq(agents.id, key.agentId))
      .run();
    expect(getEffectiveSettings(db, key)).toEqual({ model: "sonnet", effort: "low", permissionMode: "plan" });
    upsertSettings(db, { ...key, patch: { model: "opus" }, userId });
    expect(getEffectiveSettings(db, key)).toEqual({ model: "opus", effort: "low", permissionMode: "plan" });
  });

  it("부분 갱신은 보낸 필드만 바꾸고, null 은 「기본」으로 되돌린다 — 누가 언제 바꿨는지 남는다", () => {
    const { db, key, userId } = setup();
    upsertSettings(db, {
      ...key,
      patch: { model: "opus", effort: "high", permissionMode: "dontAsk" },
      userId,
    });
    upsertSettings(db, { ...key, patch: { effort: null }, userId });
    const row = getSettingsRow(db, key);
    expect(row).toMatchObject({ model: "opus", effort: null, permissionMode: "dontAsk", updatedBy: userId });
    expect(row?.updatedAt).toBeInstanceOf(Date);
  });

  it("채널에서 에이전트를 빼거나 보관해도 행이 남아, 다시 넣으면 그 값이 돌아온다 [Review Focus 4]", async () => {
    const { db, key, userId, channel, workspaceId } = setup();
    addMember(db, channel.id, { memberType: "agent", memberId: key.agentId }, silent);
    upsertSettings(db, { ...key, patch: { model: "opus" }, userId });
    removeMember(db, channel.id, key.agentId);
    expect(getSettingsRow(db, key)?.model).toBe("opus");
    addMember(db, channel.id, { memberType: "agent", memberId: key.agentId }, silent);
    expect(getEffectiveSettings(db, key).model).toBe("opus");
    await archiveAgent(db, { orchestrator: { abort: async () => {} } }, key.agentId, workspaceId);
    expect(getSettingsRow(db, key)?.model).toBe("opus");
  });

  it("대화를 지우면 그 대화의 행도 함께 지워진다 — 다른 대화의 행은 남는다 [Review Focus 4]", () => {
    const { db, key, userId, channel } = setup();
    const other = seedConversation(db, channel.id);
    upsertSettings(db, { ...key, patch: { model: "opus" }, userId });
    upsertSettings(db, { conversationId: other, agentId: key.agentId, patch: { model: "haiku" }, userId });
    db.delete(conversations).where(eq(conversations.id, key.conversationId)).run();
    expect(getSettingsRow(db, key)).toBeUndefined();
    expect(
      db
        .select()
        .from(conversationAgentSettings)
        .all()
        .map((r) => [r.conversationId, r.model]),
    ).toEqual([[other, "haiku"]]);
  });
});

describe("컨텍스트 % 와 세부 — 같은 런에서 [작성기 칩 스펙 C8·5.3]", () => {
  const breakdown = (percentage: number, maxTokens = 1_000_000): RunnerContextBreakdown => ({
    model: "claude-opus-5-5",
    totalTokens: Math.round((maxTokens * percentage) / 100),
    maxTokens,
    percentage,
    categories: [
      { name: "Messages", tokens: Math.round((maxTokens * percentage) / 100), kind: "used" },
      { name: "Free space", tokens: maxTokens - Math.round((maxTokens * percentage) / 100), kind: "free" },
    ],
  });
  let t = Date.parse("2026-11-17T00:00:00Z");
  const run = (fx: ReturnType<typeof setup>, usage: RunUsage | null, threadRootId?: string) => {
    const row = insertRun(fx.db, {
      channelId: fx.channel.id,
      conversationId: fx.conversationId,
      agentId: fx.agent.id,
      triggerKind: "mention",
      rootMessageId: uuid(),
      relayDepth: 0,
      sessionKey: `k-${uuid()}`,
      createdAt: new Date((t += 1000)),
      ...(threadRootId === undefined ? {} : { threadRootId }),
    });
    if (usage !== null) fx.db.update(runs).set({ usage }).where(eq(runs.id, row.id)).run();
  };

  it("contextPercent comes from breakdown percentage (1M window: tokens 50k, window 1M, breakdown percentage 25 → 25)", () => {
    const fx = setup();
    // 옛 계산이면 5 — 세부가 있으면 세부의 percentage 를 쓴다(게이지와 팝오버 합계가 같은 수)
    run(fx, { contextTokens: 50_000, contextWindow: 1_000_000, contextBreakdown: breakdown(25) });
    expect(contextPercentOf(fx.db, fx.key)).toBe(25);
    expect(contextOf(fx.db, fx.key)).toEqual(breakdown(25));
  });

  it("percentage 130 → 100", () => {
    const fx = setup();
    run(fx, { contextBreakdown: breakdown(130) });
    expect(contextPercentOf(fx.db, fx.key)).toBe(100);
    // 세부는 그대로 — 팝오버가 「창 초과」를 보인다
    expect(contextOf(fx.db, fx.key)?.percentage).toBe(130);
  });

  it("소수 percentage 는 반올림", () => {
    const fx = setup();
    run(fx, { contextBreakdown: breakdown(31.6) });
    expect(contextPercentOf(fx.db, fx.key)).toBe(32);
  });

  it("run without breakdown keeps old percent", () => {
    const fx = setup();
    expect(contextPercentOf(fx.db, fx.key)).toBeNull();
    expect(contextOf(fx.db, fx.key)).toBeNull();
    run(fx, { contextBreakdown: breakdown(25) });
    // 더 최근의 옛 러너 런 — 그 런의 계산, 세부는 없다(앞 런의 세부를 빌리지 않는다)
    run(fx, { contextTokens: 42_000, contextWindow: 100_000 });
    expect(contextPercentOf(fx.db, fx.key)).toBe(42);
    expect(contextOf(fx.db, fx.key)).toBeNull();
    // 사용량이 없는 런은 건너뛴다
    run(fx, null);
    run(fx, { inputTokens: 3 });
    expect(contextPercentOf(fx.db, fx.key)).toBe(42);
  });

  it("thread run uses its own breakdown", () => {
    const fx = setup();
    const root = uuid();
    run(fx, { contextBreakdown: breakdown(10) });
    expect(contextPercentOf(fx.db, { ...fx.key, threadRootId: root })).toBeNull();
    expect(contextOf(fx.db, { ...fx.key, threadRootId: root })).toBeNull();
    run(fx, { contextBreakdown: breakdown(60) }, root);
    expect(contextPercentOf(fx.db, { ...fx.key, threadRootId: root })).toBe(60);
    expect(contextOf(fx.db, { ...fx.key, threadRootId: root })?.percentage).toBe(60);
    // 스레드 런은 대화 세션 값에 섞이지 않는다
    expect(contextPercentOf(fx.db, fx.key)).toBe(10);
  });
});
