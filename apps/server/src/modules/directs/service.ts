import {
  type Agent,
  type Channel,
  DIRECT_MAX_PARTICIPANTS,
  type DirectSummary,
  type DmReadOnlyReason,
  MENTION_TOKEN_RE,
  neutralizeMentionTokens,
  parseMentions,
  type Participant,
  type TeamRole,
  tokenize,
} from "@dodok/shared";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { readableChannelSql } from "../../auth/channel-access";
import { membershipOf, roleOf } from "../../auth/roles";
import type { Db, DbOrTx } from "../../db/client";
import { agents, channelMembers, channels, conversations } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { agentForRole, apiAgent, getAgent } from "../agents/service";
import { type ChannelRecord, rowToChannel } from "../channels/service";
import { createConversation } from "../conversations/store";
import { dmAccessAllows } from "../dms/service";
import { listPeople } from "../members/people";

// 사람 DM·그룹 DM(kind = 'direct' — 사람 간 DM 스펙) — 메시지·세션·런은 채널의 것을 그대로 쓰고, 여기는 direct 만의 것만 둔다:
// 참여자 묶음 열쇠, 찾거나 만들기·열기(5.1), 내 목록(5.2), 한 줄기인지(3.1), 멘션(6.2), 읽기 전용 사유(4.3)

type Participants = { userIds: string[]; agentIds: string[] };

/** 한 줄기 direct 의 그 대화 제목 — 화면은 세션 제목을 그리지 않는다(사람 간 DM 스펙 6.1) */
const LINE_TITLE = "DM";

/**
 * 참여자 묶음 열쇠 — 연 사람을 포함한 참여자를 `u:<userId>`·`a:<agentId>` 로 적어 사전순으로 정렬해 `,` 로 잇는다. 같은 묶음이면 고른
 * 순서와 무관하게 같은 열쇠라 channels_direct_key 유일 색인이 한 채널로 묶는다(결정 2). 열쇠를 만드는 자리는 이 함수 하나다
 */
export function directKey(participants: Participants): string {
  return [...participants.userIds.map((id) => `u:${id}`), ...participants.agentIds.map((id) => `a:${id}`)]
    .sort()
    .join(",");
}

function findDirect(db: DbOrTx, workspaceId: string, key: string): ChannelRecord | undefined {
  const row = db
    .select()
    .from(channels)
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.kind, "direct"), eq(channels.directKey, key)),
    )
    .get();
  return row ? rowToChannel(row) : undefined;
}

/**
 * 그 묶음의 direct 를 찾거나 만든다 — 검사 없이(검사는 openDirect). userIds 는 연 사람을 포함한다. 유일 색인에 걸리면 넣지 않고 다시
 * 읽는다: 동시에 두 번 열어도 행은 하나다(findOrCreateDm 과 같은 꼴). 이 갈래는 한 프로세스에서는 방어용이다 — better-sqlite3 의
 * 트랜잭션은 동기라 앞의 findDirect 와 insert 사이에 다른 요청이 끼지 못하고, 색인에 걸리는 행은 늘 findDirect 가 먼저 찾는다.
 * DB 를 여럿이 쓰게 되면 그때 쓰인다. 에이전트 참여자가 없으면(한 줄기) 그 대화 하나를 같은 트랜잭션에 만든다 — 세션이 있는 묶음은
 * 첫 보내기(newConversation)가 만든다
 */
export function findOrCreateDirect(
  db: Db,
  input: { workspaceId: string; createdBy: string } & Participants,
  now = new Date(),
): { channel: ChannelRecord; created: boolean } {
  const key = directKey(input);
  return db.transaction((tx) => {
    const found = findDirect(tx, input.workspaceId, key);
    if (found) return { channel: found, created: false };
    const row = tx
      .insert(channels)
      .values({
        id: uuidv7(),
        workspaceId: input.workspaceId,
        name: "direct",
        relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
        visibility: "private",
        createdBy: input.createdBy,
        createdAt: now,
        sessionPolicy: { create: "members" },
        kind: "direct",
        directKey: key,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!row) {
      const raced = findDirect(tx, input.workspaceId, key);
      if (!raced) throw apiError("INTERNAL", "direct channel conflict without a row");
      return { channel: raced, created: false };
    }
    tx.insert(channelMembers)
      .values([
        ...input.userIds.map((memberId) => ({
          id: uuidv7(),
          channelId: row.id,
          memberType: "user",
          memberId,
          role: "member",
          joinedAt: now,
        })),
        ...input.agentIds.map((memberId) => ({
          id: uuidv7(),
          channelId: row.id,
          memberType: "agent",
          memberId,
          autoRespond: false,
          joinedAt: now,
        })),
      ])
      .run();
    if (input.agentIds.length === 0) {
      createConversation(tx, {
        channelId: row.id,
        title: LINE_TITLE,
        titleSource: "user",
        createdBy: { type: "user", id: input.createdBy },
        createdAt: now,
      });
    }
    return { channel: rowToChannel(row), created: true };
  });
}

/** 403 의 막은 에이전트 — 누가 막혔는지는 싣지 않는다(남의 역할이 드러나지 않게, 사람 간 DM 스펙 5.1) */
const blocked = (agentId: string) => apiError("FORBIDDEN", "이 에이전트와 DM 을 열 수 없다", { agentId });

/**
 * POST /directs — 꼴(VALIDATION) → 이미 있는 묶음이면 허용 검사 없이 그 채널(읽기 전용이어도 — 기록은 계속 읽는다) → 새로 만들 때만
 * 사람 상대가 활성 멤버인지·에이전트가 있는지(404), 에이전트가 켜졌고 사람 참여자 전원(연 사람 포함)의 지금 역할을 dmAccess 가
 * 들이는지(403) 본다. 그룹 DM 이 dmAccess 를 우회하는 길이 되지 않게 한 사람이라도 막히면 연다 해도 열리지 않는다(결정 5)
 */
export function openDirect(
  db: Db,
  input: { workspaceId: string; userId: string } & Participants,
): { channel: ChannelRecord; created: boolean } {
  const { userIds, agentIds } = input;
  const others = userIds.length + agentIds.length;
  if (others === 0) throw apiError("VALIDATION", "상대를 한 명 이상 골라야 한다");
  if (others + 1 > DIRECT_MAX_PARTICIPANTS)
    throw apiError("VALIDATION", `참여자는 나를 포함해 ${DIRECT_MAX_PARTICIPANTS}명까지다`);
  if (new Set(userIds).size !== userIds.length || new Set(agentIds).size !== agentIds.length)
    throw apiError("VALIDATION", "같은 상대를 두 번 골랐다");
  if (userIds.includes(input.userId)) throw apiError("VALIDATION", "나 자신은 상대가 아니다");
  if (userIds.length === 0 && agentIds.length === 1)
    throw apiError("VALIDATION", "에이전트 하나와의 DM 은 POST /dms 로 연다");

  const participants = { userIds: [input.userId, ...userIds], agentIds };
  const existing = findDirect(db, input.workspaceId, directKey(participants));
  if (existing) return { channel: existing, created: false };

  for (const id of userIds) {
    if (roleOf(db, input.workspaceId, id) === undefined) throw apiError("NOT_FOUND", "user not found");
  }
  const found: Agent[] = agentIds.map((id) => {
    const agent = getAgent(db, id, input.workspaceId);
    if (!agent || agent.archivedAt !== null) throw apiError("NOT_FOUND", "agent not found");
    return agent;
  });
  const roles = participants.userIds.map((id) => roleOf(db, input.workspaceId, id));
  for (const agent of found) {
    if (!agent.enabled || !roles.every((role) => dmAccessAllows(agent.dmAccess, role)))
      throw blocked(agent.id);
  }
  return findOrCreateDirect(db, { workspaceId: input.workspaceId, createdBy: input.userId, ...participants });
}

/** 그룹 DM 런을 막은 사유 — 시킨 사람이 없음(null), 또는 시킨 사람의 지금 역할을 그 에이전트의 dmAccess 가 들이지 않음 */
export type DirectRunBlock = "no_requester" | "dm_not_allowed";

/**
 * 그룹 DM 의 런을 시킨 사람이 그 에이전트를 부를 수 있는가(사람 간 DM 스펙 6.3) — 열 때 본 dmAccess 를 런마다 다시 본다. 연 뒤 dmAccess 를
 * 좁히거나 시킨 사람이 강등·비활성화돼도 그룹 DM 이 dmAccess 를 우회하는 길이 되지 않게. 비활성이면 역할이 없어 dm_not_allowed 다.
 * direct 가 아니면 늘 null — 일반 채널·에이전트 DM 은 이 관문을 지나지 않는다. 라우터가 런을 만들기 전에, 디스패치가 보내기 직전에 부른다
 */
export function directRunBlock(
  db: DbOrTx,
  input: { channelId: string; agentId: string; requestedBy: string | null },
): DirectRunBlock | null {
  const channel = db
    .select({ kind: channels.kind, workspaceId: channels.workspaceId })
    .from(channels)
    .where(eq(channels.id, input.channelId))
    .get();
  if (channel?.kind !== "direct") return null;
  if (input.requestedBy === null) return "no_requester";
  const agent = getAgent(db, input.agentId, channel.workspaceId);
  const role = roleOf(db, channel.workspaceId, input.requestedBy);
  return agent !== undefined && dmAccessAllows(agent.dmAccess, role) ? null : "dm_not_allowed";
}

/** 참여자 행 — user·agent 를 갈라 낸다(비활성·보관도 그대로. 거르는 것은 부르는 쪽) */
function participantRows(db: DbOrTx, channelId: string): Participants {
  const rows = db
    .select({ type: channelMembers.memberType, id: channelMembers.memberId })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, channelId))
    .all();
  return {
    userIds: rows.filter((r) => r.type === "user").map((r) => r.id),
    agentIds: rows.filter((r) => r.type === "agent").map((r) => r.id),
  };
}

/**
 * 에이전트 참여자가 있는 direct 인가 — 있으면 세션으로 나누고, 없으면 세션 없는 한 줄기다(결정 4). 참여자 묶음은 고정이라 채널의 일생
 * 동안 바뀌지 않으므로 열로 두지 않고 읽는다. 보관한 에이전트도 센다 — 보관으로 한 줄기·세션이 갈리면 이미 있는 세션이 갈 곳을 잃는다
 */
export function directHasAgents(db: DbOrTx, channelId: string): boolean {
  const row = db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.memberType, "agent")))
    .get();
  return row !== undefined;
}

/**
 * direct 의 멘션 — 참여자(channelParticipants)만 토큰이 된다. 토큰화한 뒤 참여자가 아닌 id 의 토큰 꼴(손으로 적어 온 `<@u:…>` 포함)은
 * 중화한다(neutralizeMentionTokens). 비참여자를 멘션해도 끌려 들어오지 않고 푸시·배지에 닿지 않는다(사람 간 DM 스펙 6.2) — 그래서
 * direct 에서는 joinChannelIfAbsent 를 부르지 않는다
 */
export function directMentions(
  text: string,
  participants: Participant[],
): { bodyMd: string; mentions: { users: string[]; agents: string[] } } {
  const allowed = new Set(participants.map((p) => `${p.type === "agent" ? "a" : "u"}:${p.id}`));
  const tokenized = tokenize(text, participants).bodyMd;
  const bodyMd = tokenized.replace(MENTION_TOKEN_RE, (token: string, kind: string, id: string) =>
    allowed.has(`${kind}:${id}`) ? token : neutralizeMentionTokens(token),
  );
  return { bodyMd, mentions: parseMentions(bodyMd) };
}

/**
 * direct 가 지금 읽기만 되는 사유 — 1:1(사람 참여자 둘, 에이전트 없음)이고 상대가 비활성이면 peer_deactivated, 아니면 null. 그룹은 읽기
 * 전용이 되지 않는다(남은 사람끼리 계속 — 결정 5). viewerId 는 상대를 가를 때 쓴다 — 넘기지 않으면 두 사람 가운데 누구든 비활성이면
 * 그 값(쓰기 경로는 보내는 사람이 활성이라 같은 뜻이다)
 */
export function directReadOnlyReason(
  db: DbOrTx,
  channel: Pick<Channel, "id" | "kind" | "workspaceId">,
  viewerId?: string,
): DmReadOnlyReason | null {
  if (channel.kind !== "direct") return null;
  const { userIds, agentIds } = participantRows(db, channel.id);
  if (userIds.length !== 2 || agentIds.length > 0) return null;
  const peers = viewerId === undefined ? userIds : userIds.filter((id) => id !== viewerId);
  const inactive = peers.some((id) => membershipOf(db, channel.workspaceId, id)?.deactivatedAt != null);
  return inactive ? "peer_deactivated" : null;
}

/**
 * GET /directs — 내가 참여한 direct 전부(글이 없는 것도 — 웹이 lastMessageAt 으로 가른다), 최근 활동순(listDms 와 같은 식: 가장 최근
 * 글 시각, 없으면 연 시각). users 는 나를 뺀 사람 참여자(비활성 포함), agents 는 보관하지 않은 참여 에이전트(agentForRole 을 지난다),
 * sessions 는 directHasAgents 와 같은 값(보관한 에이전트도 센다)
 */
export function listDirects(
  db: DbOrTx,
  workspaceId: string,
  userId: string,
  role: TeamRole | undefined,
): DirectSummary[] {
  const lastAt = max(conversations.lastMessageAt);
  const rows = db
    .select({ channel: channels, lastAt })
    .from(channels)
    .leftJoin(conversations, eq(conversations.channelId, channels.id))
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.kind, "direct"), readableChannelSql(userId)),
    )
    .groupBy(channels.id)
    .orderBy(desc(sql`coalesce(${lastAt}, ${channels.createdAt})`), desc(channels.id))
    .all();
  if (rows.length === 0) return [];
  const people = new Map(listPeople(db, workspaceId).map((p) => [p.id, p]));
  return rows.map(({ channel: row, lastAt: at }) => {
    const channel = rowToChannel(row);
    const { userIds, agentIds } = participantRows(db, channel.id);
    return {
      channel,
      users: userIds.filter((id) => id !== userId).flatMap((id) => people.get(id) ?? []),
      agents: agentIds.flatMap((id) => {
        const agentRow = db.select().from(agents).where(eq(agents.id, id)).get();
        return agentRow && agentRow.archivedAt === null ? [agentForRole(apiAgent(db, agentRow), role)] : [];
      }),
      sessions: directHasAgents(db, channel.id),
      lastMessageAt: at === null ? null : new Date(at).toISOString(),
      readOnlyReason: directReadOnlyReason(db, channel, userId),
    };
  });
}
