import {
  type Agent,
  type Channel,
  type DmAccess,
  type DmReadOnlyReason,
  type DmSummary,
  roleAtLeast,
  type TeamRole,
} from "@dodok/shared";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { roleOf } from "../../auth/roles";
import type { Db, DbOrTx } from "../../db/client";
import { agents, channelMembers, channels, conversations } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { agentForRole, apiAgent, getAgent, isAgentActive } from "../agents/service";
import { type ChannelRecord, rowToChannel } from "../channels/service";
import { directReadOnlyReason } from "../directs/service";

// 에이전트 DM(에이전트 DM 스펙) — DM 은 kind = 'dm' 인 채널이라 메시지·세션·런은 채널의 것을 그대로 쓰고, 여기는 DM 만의 것만 둔다:
// 찾거나 만들기(계획 판정 PD1), 내 DM 목록(PD3), 누가 DM 을 여나(dmAccess), 읽기 전용 사유, DM 에 맞지 않는 채널 관리(PD9)

/** 읽기 전용 사유의 문구 — 409 DM_READ_ONLY 의 message(웹은 details.reason 으로 같은 문구를 그린다) */
const READ_ONLY_TEXT: Record<DmReadOnlyReason, string> = {
  agent_archived: "보관된 에이전트라 읽기만 할 수 있습니다",
  agent_disabled: "꺼진 에이전트라 읽기만 할 수 있습니다",
  dm_not_allowed: "이 에이전트와의 DM 이 허용되지 않아 읽기만 할 수 있습니다",
  peer_deactivated: "상대가 비활성화되어 읽기만 할 수 있습니다",
};

/** dmAccess 가 그 역할을 들이는가 — off 는 아무도, admins 는 admin 이상, everyone 은 모든 활성 멤버(역할이 없으면 아무도) */
export function dmAccessAllows(access: DmAccess, role: TeamRole | undefined): boolean {
  if (access === "off") return false;
  return roleAtLeast(role, access === "admins" ? "admin" : "member");
}

/**
 * DM 이 지금 읽기만 되는 사유 — 보관 → 꺼짐 → 허용 범위 순으로 하나, 쓸 수 있으면 null. 허용 범위는 주인의 **지금** 역할로 본다(강등되면
 * 읽기 전용, 되돌리면 이어 쓴다 — Review Focus 3). 에이전트 DM 이 아니면 늘 null — 모르는 kind 는 이보다 앞의 접근 판정이 404 로 막는다.
 * 주인 역할을 넘기지 않으면 읽는다
 */
export function dmReadOnlyReason(
  db: DbOrTx,
  channel: Pick<Channel, "kind" | "workspaceId" | "dmOwnerId" | "dmAgentId">,
  ownerRole: TeamRole | undefined = channel.dmOwnerId === null
    ? undefined
    : roleOf(db, channel.workspaceId, channel.dmOwnerId),
): DmReadOnlyReason | null {
  if (channel.kind !== "dm") return null;
  const agent = channel.dmAgentId === null ? undefined : getAgent(db, channel.dmAgentId);
  // 에이전트 행은 지우지 않는다(보관만) — 없으면 보관과 같게 둔다
  if (!agent || agent.archivedAt !== null) return "agent_archived";
  if (!agent.enabled) return "agent_disabled";
  if (!dmAccessAllows(agent.dmAccess, ownerRole)) return "dm_not_allowed";
  return null;
}

/**
 * 사람의 쓰기(보내기·카드·리액션·첨부 올리기·DM 지시)가 assertChannelWritable 다음에 부른다 — 읽기 전용 DM 이면 409 DM_READ_ONLY
 * (details.reason). 에이전트 DM 은 dmReadOnlyReason(ownerRole 은 주인의 역할), direct 는 directReadOnlyReason(1:1 상대 비활성 — 사람 간
 * DM 스펙 4.3). 일반 채널은 그대로 지난다
 */
export function assertDmWritable(
  db: DbOrTx,
  channel: Pick<Channel, "id" | "kind" | "workspaceId" | "dmOwnerId" | "dmAgentId">,
  ownerRole?: TeamRole,
): void {
  const reason =
    channel.kind === "direct"
      ? directReadOnlyReason(db, channel)
      : ownerRole === undefined
        ? dmReadOnlyReason(db, channel)
        : dmReadOnlyReason(db, channel, ownerRole);
  if (reason !== null) throw apiError("DM_READ_ONLY", READ_ONLY_TEXT[reason], { reason });
}

/**
 * 채널 관리(이름·주제·멤버·보관·세션 관리자·세션 정책·한도·제어 쓰기 도구 — 계획 판정 PD9)는 일반 채널에서만 — 에이전트 DM·direct
 * (사람 간 DM 스펙 4.3)·모르는 kind 는 VALIDATION. 못 읽는 사람은 이보다 먼저 접근 판정이 404 로 막는다 — 이것은 읽는 사람에게만 닿는다
 */
export function assertNotDm(channel: Pick<Channel, "kind">): void {
  if (channel.kind !== "channel") throw apiError("VALIDATION", "DM 에서는 채널 관리를 할 수 없다");
}

/** DM 의 PATCH /channels/:id 는 prompt(「이 DM 의 지시」)만 받는다 — 다른 키가 하나라도 있으면 통째로 VALIDATION(계획 판정 PD9) */
export function assertDmPatchBody(body: unknown): void {
  const keys = typeof body === "object" && body !== null ? Object.keys(body) : [];
  if (keys.some((key) => key !== "prompt"))
    throw apiError("VALIDATION", "DM 에서는 지시(prompt)만 바꿀 수 있다", { allowed: ["prompt"] });
}

/**
 * (주인, 에이전트) DM 채널을 찾거나 만든다 — 검사 없이(검사는 openDm). 유일 인덱스 channels_dm_pair 에 걸리면 넣지 않고 다시 읽는다:
 * 동시에 두 번 열어도 행은 하나다. 채널 행 값은 계획 Global Constraints 「DM 채널 행」, 멤버는 주인(member) + 에이전트(autoRespond)
 * 둘뿐. 세션은 만들지 않는다 — 첫 보내기(message.send newConversation)가 만든다
 */
export function findOrCreateDm(
  db: Db,
  input: { workspaceId: string; ownerId: string; agentId: string },
  now = new Date(),
): { channel: ChannelRecord; created: boolean } {
  return db.transaction((tx) => {
    const found = findDm(tx, input.workspaceId, input.ownerId, input.agentId);
    if (found) return { channel: found, created: false };
    const row = tx
      .insert(channels)
      .values({
        id: uuidv7(),
        workspaceId: input.workspaceId,
        name: "dm",
        relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
        visibility: "private",
        createdBy: input.ownerId,
        createdAt: now,
        sessionPolicy: { create: "members" },
        kind: "dm",
        dmOwnerId: input.ownerId,
        dmAgentId: input.agentId,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    if (!row) {
      const raced = findDm(tx, input.workspaceId, input.ownerId, input.agentId);
      if (!raced) throw apiError("INTERNAL", "dm channel conflict without a row");
      return { channel: raced, created: false };
    }
    tx.insert(channelMembers)
      .values([
        {
          id: uuidv7(),
          channelId: row.id,
          memberType: "user",
          memberId: input.ownerId,
          role: "member",
          joinedAt: now,
        },
        {
          id: uuidv7(),
          channelId: row.id,
          memberType: "agent",
          memberId: input.agentId,
          autoRespond: true,
          joinedAt: now,
        },
      ])
      .run();
    return { channel: rowToChannel(row), created: true };
  });
}

function findDm(
  db: DbOrTx,
  workspaceId: string,
  ownerId: string,
  agentId: string,
): ChannelRecord | undefined {
  const row = db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.kind, "dm"),
        eq(channels.dmOwnerId, ownerId),
        eq(channels.dmAgentId, agentId),
      ),
    )
    .get();
  return row ? rowToChannel(row) : undefined;
}

/**
 * POST /dms — 이미 있으면 그 DM(읽기 전용이어도 — 기록은 주인이 계속 읽는다), 없으면 에이전트가 살아 있고 dmAccess 가 지금 역할을
 * 들일 때만 만든다(아니면 403 FORBIDDEN). 없는 에이전트·다른 워크스페이스의 에이전트는 404
 */
export function openDm(
  db: Db,
  input: { workspaceId: string; userId: string; role: TeamRole | undefined; agentId: string },
): { channel: ChannelRecord; created: boolean } {
  const agent = getAgent(db, input.agentId, input.workspaceId);
  if (!agent) throw apiError("NOT_FOUND", "agent not found");
  const existing = findDm(db, input.workspaceId, input.userId, agent.id);
  if (existing) return { channel: existing, created: false };
  if (!canStartDm(agent, input.role)) throw apiError("FORBIDDEN", "이 에이전트와 DM 을 열 수 없다");
  return findOrCreateDm(db, { workspaceId: input.workspaceId, ownerId: input.userId, agentId: agent.id });
}

/** 새 DM 을 열 수 있는 에이전트인가 — 보관·꺼짐이면 dmAccess 와 무관하게 아니다(계획 Global Constraints 「dmAccess 판정」) */
export function canStartDm(
  agent: Pick<Agent, "enabled" | "archivedAt" | "dmAccess">,
  role: TeamRole | undefined,
) {
  return isAgentActive(agent) && dmAccessAllows(agent.dmAccess, role);
}

/**
 * GET /dms — 내 DM 전부(아직 글이 없는 것도 — 웹이 lastMessageAt 으로 가른다, 계획 판정 PD1), 최근 활동순. lastMessageAt 은 세션
 * 가운데 가장 최근 글 시각, 없으면 DM 을 연 시각으로 줄을 세운다
 */
export function listDms(
  db: DbOrTx,
  workspaceId: string,
  userId: string,
  role: TeamRole | undefined,
): DmSummary[] {
  const lastAt = max(conversations.lastMessageAt);
  const rows = db
    .select({ channel: channels, agent: agents, lastAt })
    .from(channels)
    .innerJoin(agents, eq(agents.id, channels.dmAgentId))
    .leftJoin(conversations, eq(conversations.channelId, channels.id))
    .where(
      and(eq(channels.workspaceId, workspaceId), eq(channels.kind, "dm"), eq(channels.dmOwnerId, userId)),
    )
    .groupBy(channels.id)
    .orderBy(desc(sql`coalesce(${lastAt}, ${channels.createdAt})`), desc(channels.id))
    .all();
  return rows.map(({ channel: row, agent, lastAt: at }) => {
    const channel = rowToChannel(row);
    return {
      channel,
      agent: agentForRole(apiAgent(db, agent), role),
      lastMessageAt: at === null ? null : new Date(at).toISOString(),
      readOnlyReason: dmReadOnlyReason(db, channel, role),
    };
  });
}
