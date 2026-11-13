import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { agents, conversationAgents, conversations } from "../src/db/schema.sqlite";
import { archiveAgent, createAgent } from "../src/modules/agents/service";
import { createChannel } from "../src/modules/channels/service";
import {
  deleteInvite,
  deleteInvitesForChannelAgent,
  insertInvite,
  invitedAgentIds,
  listInvited,
  sessionAgentIds,
} from "../src/modules/conversations/invited-agents";
import { insertGateway } from "./helpers/gateways";
import { createRunnerAgentForTest, seedChannelWithAgent, seedConversation } from "./helpers/seed";
import { newTestDb } from "./helpers/db";

function setup() {
  const db = newTestDb();
  const base = seedChannelWithAgent(db, { agentHandle: "dev" });
  const gatewayId = insertGateway(db, base.workspaceId, { id: uuid(), name: "home" }).id;
  const guest = createAgent(db, {
    workspaceId: base.workspaceId,
    provider: "openclaw",
    providerAgentId: "main",
    handle: "main",
    name: "main",
    gatewayId,
  });
  const other = seedConversation(db, base.channelId);
  return { db, ...base, guestId: guest.id, other };
}

describe("세션 초대 저장소 [세션 에이전트 초대 스펙 5.1·5.2]", () => {
  it("넣고 읽는다 — 초대한 사람·시각이 남는다", () => {
    const { db, conversationId, guestId, userId } = setup();
    insertInvite(db, { conversationId, agentId: guestId, invitedBy: userId });
    const rows = listInvited(db, conversationId);
    expect(rows).toEqual([{ agentId: guestId, invitedBy: userId, invitedAt: expect.any(String) }]);
    expect(new Date(rows[0]!.invitedAt).getTime()).not.toBeNaN();
    expect(invitedAgentIds(db, conversationId)).toEqual([guestId]);
  });

  it("같은 쌍을 두 번 넣으면 거절한다(PK)", () => {
    const { db, conversationId, guestId, userId } = setup();
    insertInvite(db, { conversationId, agentId: guestId, invitedBy: userId });
    expect(() => insertInvite(db, { conversationId, agentId: guestId, invitedBy: userId })).toThrow();
  });

  it("deleteInvite — 있으면 true, 없으면 false", () => {
    const { db, conversationId, guestId, userId } = setup();
    insertInvite(db, { conversationId, agentId: guestId, invitedBy: userId });
    expect(deleteInvite(db, { conversationId, agentId: guestId })).toBe(true);
    expect(deleteInvite(db, { conversationId, agentId: guestId })).toBe(false);
    expect(listInvited(db, conversationId)).toEqual([]);
  });

  it("대화를 지우면 그 대화의 초대 행도 지워진다 — 다른 대화의 행은 남는다 [Review Focus 3]", () => {
    const { db, conversationId, other, guestId, userId } = setup();
    insertInvite(db, { conversationId, agentId: guestId, invitedBy: userId });
    insertInvite(db, { conversationId: other, agentId: guestId, invitedBy: userId });
    db.delete(conversations).where(eq(conversations.id, conversationId)).run();
    expect(
      db
        .select()
        .from(conversationAgents)
        .all()
        .map((r) => r.conversationId),
    ).toEqual([other]);
  });

  it("에이전트 행을 지우면 초대 행도 지워진다 [Review Focus 3]", () => {
    const { db, conversationId, guestId, userId } = setup();
    insertInvite(db, { conversationId, agentId: guestId, invitedBy: userId });
    db.delete(agents).where(eq(agents.id, guestId)).run();
    expect(db.select().from(conversationAgents).all()).toEqual([]);
  });

  it("보관한 에이전트는 invitedAgentIds·sessionAgentIds 에서 빠지고 listInvited 에는 남는다 — 되살리면 돌아온다 [Review Focus 3]", async () => {
    const { db, conversationId, channelId, guestId, userId, workspaceId, agentId } = setup();
    insertInvite(db, { conversationId, agentId: guestId, invitedBy: userId });
    await archiveAgent(db, { orchestrator: { abort: async () => {} } }, guestId, workspaceId);
    expect(invitedAgentIds(db, conversationId)).toEqual([]);
    expect(sessionAgentIds(db, { channelId, conversationId })).toEqual([agentId]);
    expect(listInvited(db, conversationId).map((r) => r.agentId)).toEqual([guestId]);
    db.update(agents).set({ archivedAt: null }).where(eq(agents.id, guestId)).run();
    expect(invitedAgentIds(db, conversationId)).toEqual([guestId]);
  });

  it("sessionAgentIds = 채널 에이전트 멤버 ∪ 그 대화의 초대 — 다른 대화의 초대는 싣지 않는다 [Review Focus 1]", () => {
    const { db, conversationId, other, channelId, agentId, guestId, userId } = setup();
    insertInvite(db, { conversationId, agentId: guestId, invitedBy: userId });
    expect(sessionAgentIds(db, { channelId, conversationId })).toEqual([agentId, guestId]);
    expect(sessionAgentIds(db, { channelId, conversationId: other })).toEqual([agentId]);
  });

  it("deleteInvitesForChannelAgent — 그 채널 대화들의 그 에이전트 행만 지우고 지운 대화 id 를 돌려준다(I12)", () => {
    const { db, conversationId, other, channelId, guestId, userId, workspaceId } = setup();
    const elsewhere = createChannel(db, { workspaceId, createdBy: userId, name: "elsewhere" });
    const farConversation = seedConversation(db, elsewhere.id);
    const { agent: coder } = createRunnerAgentForTest(db, { workspaceId, handle: "coder" });
    insertInvite(db, { conversationId, agentId: guestId, invitedBy: userId });
    insertInvite(db, { conversationId: other, agentId: guestId, invitedBy: userId });
    insertInvite(db, { conversationId, agentId: coder.id, invitedBy: userId });
    insertInvite(db, { conversationId: farConversation, agentId: guestId, invitedBy: userId });
    const removed = deleteInvitesForChannelAgent(db, { channelId, agentId: guestId });
    expect(removed.sort()).toEqual([conversationId, other].sort());
    expect(invitedAgentIds(db, conversationId)).toEqual([coder.id]);
    expect(invitedAgentIds(db, other)).toEqual([]);
    expect(invitedAgentIds(db, farConversation)).toEqual([guestId]);
  });
});
