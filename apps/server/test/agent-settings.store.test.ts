import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agents, conversationAgentSettings, conversations } from "../src/db/schema.sqlite";
import { addMember, createChannel, removeMember } from "../src/modules/channels/service";
import { archiveAgent } from "../src/modules/agents/service";
import {
  getEffectiveSettings,
  getSettingsRow,
  upsertSettings,
} from "../src/modules/conversations/agent-settings";
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
