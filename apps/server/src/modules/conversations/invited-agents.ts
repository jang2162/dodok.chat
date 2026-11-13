/**
 * 세션에 초대한 에이전트(세션 에이전트 초대 스펙 5.1·5.2) — 저장·조회와 「이 세션에서 부를 수 있는 에이전트」. 권한·검증(I3·I8)은
 * 호출자(REST) 몫이다 — 여기는 행만 다룬다
 */
import type { InvitedAgent } from "@dodok/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { agents, conversationAgents, conversations } from "../../db/schema.sqlite";
import { agentNotArchived } from "../agents/service";
import { listMembers } from "../channels/service";

/** 그 대화의 초대 전체(초대한 순) — 보관한 에이전트의 행도 싣는다(되살리면 돌아온다). 받은 쪽(화면)이 에이전트 목록으로 거른다 */
export function listInvited(db: DbOrTx, conversationId: string): InvitedAgent[] {
  return db
    .select()
    .from(conversationAgents)
    .where(eq(conversationAgents.conversationId, conversationId))
    .orderBy(asc(conversationAgents.invitedAt), asc(conversationAgents.agentId))
    .all()
    .map((row) => ({
      agentId: row.agentId,
      invitedBy: row.invitedBy,
      invitedAt: row.invitedAt.toISOString(),
    }));
}

/** 그 대화에 초대한 에이전트 id(초대한 순) — 보관한 에이전트는 빠진다. 실행·멘션·참여자를 정하는 자리가 쓴다 */
export function invitedAgentIds(db: DbOrTx, conversationId: string): string[] {
  return db
    .select({ agentId: conversationAgents.agentId })
    .from(conversationAgents)
    .innerJoin(agents, eq(agents.id, conversationAgents.agentId))
    .where(and(eq(conversationAgents.conversationId, conversationId), agentNotArchived))
    .orderBy(asc(conversationAgents.invitedAt), asc(conversationAgents.agentId))
    .all()
    .map((row) => row.agentId);
}

/** 같은 (대화, 에이전트)가 이미 있으면 PK 가 거절한다 — 호출자가 먼저 가른다 */
export function insertInvite(
  db: DbOrTx,
  input: { conversationId: string; agentId: string; invitedBy: string | null; invitedAt?: Date },
): void {
  db.insert(conversationAgents)
    .values({
      conversationId: input.conversationId,
      agentId: input.agentId,
      invitedBy: input.invitedBy,
      invitedAt: input.invitedAt ?? new Date(),
    })
    .run();
}

/** 지웠으면 true */
export function deleteInvite(db: DbOrTx, key: { conversationId: string; agentId: string }): boolean {
  const removed = db
    .delete(conversationAgents)
    .where(
      and(
        eq(conversationAgents.conversationId, key.conversationId),
        eq(conversationAgents.agentId, key.agentId),
      ),
    )
    .returning({ conversationId: conversationAgents.conversationId })
    .all();
  return removed.length > 0;
}

/**
 * 그 채널의 모든 대화에서 그 에이전트의 초대 행을 지우고 지운 대화 id 를 돌려준다 — 그 에이전트를 채널 멤버로 넣을 때(I12). 호출자가
 * 대화마다 conversation.agents 를 보낸다
 */
export function deleteInvitesForChannelAgent(
  db: DbOrTx,
  input: { channelId: string; agentId: string },
): string[] {
  const inChannel = db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.channelId, input.channelId));
  return db
    .delete(conversationAgents)
    .where(
      and(
        eq(conversationAgents.agentId, input.agentId),
        inArray(conversationAgents.conversationId, inChannel),
      ),
    )
    .returning({ conversationId: conversationAgents.conversationId })
    .all()
    .map((row) => row.conversationId);
}

/**
 * 이 세션에서 부를 수 있는 에이전트(스펙 5.2) = 그 채널의 에이전트 멤버(들어온 순) ∪ 그 대화의 초대(초대한 순), 중복 없이. 보관한
 * 에이전트는 빠진다 — 채널 멤버 쪽은 listMembers 가, 초대 쪽은 invitedAgentIds 가 거른다
 */
export function sessionAgentIds(db: DbOrTx, key: { channelId: string; conversationId: string }): string[] {
  const members = listMembers(db, key.channelId)
    .filter((m) => m.memberType === "agent")
    .map((m) => m.memberId);
  const seen = new Set(members);
  return [...members, ...invitedAgentIds(db, key.conversationId).filter((id) => !seen.has(id))];
}
