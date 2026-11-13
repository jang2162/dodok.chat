/**
 * 세션에 초대한 에이전트(세션 에이전트 초대 스펙 5.1·5.2) — 저장·조회와 「이 세션에서 부를 수 있는 에이전트」. 권한·검증(I3·I8)은
 * 호출자(REST) 몫이다 — 여기는 행만 다룬다
 */
import type { InvitedAgent, Participant } from "@dodok/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { agents, conversationAgents, conversations } from "../../db/schema.sqlite";
import { agentNotArchived } from "../agents/service";
import { channelParticipants, listMembers, userMessageParticipants } from "../channels/service";

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

/**
 * 그 대화에 초대한 에이전트의 참가자(초대한 순, 별칭 없음) — 채널 멤버로도 든 에이전트는 뺀다. includeInactive 면 보관한 에이전트까지
 * (이미 토큰이 된 옛 메시지를 에이전트에게 풀 때 — channelParticipants 와 같은 뜻)
 */
function invitedParticipants(
  db: DbOrTx,
  key: { channelId: string; conversationId: string },
  exclude: ReadonlySet<string>,
  opts: { includeInactive?: boolean },
): Participant[] {
  return db
    .select({ id: agents.id, handle: agents.handle, displayName: agents.name })
    .from(conversationAgents)
    .innerJoin(agents, eq(agents.id, conversationAgents.agentId))
    .where(
      and(
        eq(conversationAgents.conversationId, key.conversationId),
        opts.includeInactive ? undefined : agentNotArchived,
      ),
    )
    .orderBy(asc(conversationAgents.invitedAt), asc(conversationAgents.agentId))
    .all()
    .filter((row) => !exclude.has(row.id))
    .map((row): Participant => ({ type: "agent", ...row }));
}

function withInvited(
  db: DbOrTx,
  base: Participant[],
  key: { channelId: string; conversationId: string },
  opts: { includeInactive?: boolean } = {},
): Participant[] {
  const agentIds = new Set(base.filter((p) => p.type === "agent").map((p) => p.id));
  return [...base, ...invitedParticipants(db, key, agentIds, opts)];
}

/**
 * 그 세션(대화)의 참가자 — channelParticipants 뒤에 그 대화에 초대한 에이전트. 에이전트 글의 멘션 풀기·에이전트 헤더 「참여자:」가 쓴다.
 * 뒤가 같은 핸들을 덮으므로(tokenize) 사람과 같은 핸들이면 초대한 에이전트로 풀린다 — 채널 에이전트와 같은 규칙이다
 */
export function sessionParticipants(
  db: DbOrTx,
  key: { channelId: string; conversationId: string },
  opts: { includeInactive?: boolean } = {},
): Participant[] {
  return withInvited(db, channelParticipants(db, key.channelId, opts), key, opts);
}

/** 그 세션의 사람 글 멘션을 풀 참가자 — userMessageParticipants 뒤에 그 대화에 초대한 에이전트 */
export function userSessionParticipants(
  db: DbOrTx,
  key: { channelId: string; conversationId: string },
): Participant[] {
  return withInvited(db, userMessageParticipants(db, key.channelId), key);
}
