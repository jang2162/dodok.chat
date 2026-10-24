import { Channel, ChannelMember, type Participant, RelayPolicy, TeamRole } from "@dodok/shared";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { agentConnectionId } from "../../adapters/connection";
import type { AdapterRegistry } from "../../adapters/registry";
import { AdapterError, type AgentAdapter } from "../../adapters/types";
import { roleOf } from "../../auth/roles";
import type { Db, DbOrTx } from "../../db/client";
import { agents, channelMembers, channels, gateways, memberships, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { agentNotArchived, getAgent } from "../agents/service";
import { createLegacyConversation, latestOpenConversation } from "../conversations/store";
import { createSystemMessage, getThreadRoot } from "../messages/service";
import type { Orchestrator } from "../runs/orchestrator";
import { clearProviderSessionId, ensureSession, markSessionReset } from "../sessions/service";

type ChannelRow = typeof channels.$inferSelect;
type MemberRow = typeof channelMembers.$inferSelect;

/** 비활성이 아닌 membership — memberships 를 (left) join 한 조회에서. join 할 행이 없으면(NULL) 통과한다 */
const memberNotDeactivated = isNull(memberships.deactivatedAt);

/** 도메인 Channel + 프롬프트 리비전(스펙 3.2 [신규]). REST 응답·세션 비교가 쓴다. */
const StoredChannel = Channel.extend({ promptRevision: z.int().min(1) });
export type ChannelRecord = z.infer<typeof StoredChannel>;

export type WarnLogger = Pick<Logger, "warn">;

export type CreateChannelInput = {
  workspaceId: string;
  createdBy: string;
  name: string;
  topic?: string;
  prompt?: string;
  relayPolicy?: z.input<typeof RelayPolicy>;
  visibility?: Channel["visibility"];
};

/** null 은 값을 지운다 */
export type ChannelPatch = {
  name?: string;
  topic?: string | null;
  prompt?: string | null;
  relayPolicy?: z.input<typeof RelayPolicy>;
  visibility?: Channel["visibility"];
};

export type AddMemberInput = {
  memberType: ChannelMember["memberType"];
  memberId: string;
  promptOverride?: string;
  autoRespond?: boolean;
  aliases?: string[];
};

/** null 은 promptOverride 를 지운다 */
export type AgentMemberPatch = { promptOverride?: string | null; autoRespond?: boolean; aliases?: string[] };

export function rowToChannel(row: ChannelRow): ChannelRecord {
  return parseStored(
    StoredChannel,
    {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      topic: row.topic ?? undefined,
      prompt: row.prompt ?? undefined,
      relayPolicy: row.relayPolicy,
      visibility: row.visibility,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      archivedAt: row.archivedAt?.toISOString() ?? null,
      promptRevision: row.promptRevision,
    },
    "channel",
  );
}

export function rowToMember(row: MemberRow): ChannelMember {
  return parseStored(
    ChannelMember,
    {
      id: row.id,
      channelId: row.channelId,
      memberType: row.memberType,
      memberId: row.memberId,
      promptOverride: row.promptOverride ?? undefined,
      autoRespond: row.autoRespond,
      aliases: row.aliases,
      joinedAt: row.joinedAt.toISOString(),
    },
    "channel member",
  );
}

/** 채널을 만들고 만든 사람을 첫 멤버로 넣는다. relayPolicy 는 계약 기본값 { maxRelayTurns: 4, allowPairs: "all" }. */
export function createChannel(db: Db, input: CreateChannelInput): ChannelRecord {
  const now = new Date();
  return db.transaction((tx) => {
    const row = tx
      .insert(channels)
      .values({
        id: uuidv7(),
        workspaceId: input.workspaceId,
        name: input.name,
        topic: input.topic ?? null,
        prompt: input.prompt ?? null,
        relayPolicy: RelayPolicy.parse(input.relayPolicy ?? {}),
        visibility: input.visibility ?? "public",
        createdBy: input.createdBy,
        createdAt: now,
      })
      .returning()
      .get();
    tx.insert(channelMembers)
      .values({
        id: uuidv7(),
        channelId: row.id,
        memberType: "user",
        memberId: input.createdBy,
        joinedAt: now,
      })
      .run();
    createLegacyConversation(tx, { id: row.id, createdBy: input.createdBy, createdAt: now });
    return rowToChannel(row);
  });
}

/** prompt·relayPolicy 가 값으로 달라지면 같은 트랜잭션에서 promptRevision += 1 */
export function updateChannel(
  db: Db,
  id: string,
  patch: ChannelPatch,
): { channel: ChannelRecord; promptChanged: boolean } {
  return db.transaction((tx) => {
    const current = tx.select().from(channels).where(eq(channels.id, id)).get();
    if (!current) throw apiError("NOT_FOUND", "channel not found");
    const set: SQLiteUpdateSetSource<typeof channels> = {};
    let promptChanged = false;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.topic !== undefined) set.topic = patch.topic;
    if (patch.visibility !== undefined) set.visibility = patch.visibility;
    if (patch.prompt !== undefined) {
      set.prompt = patch.prompt;
      if (patch.prompt !== current.prompt) promptChanged = true;
    }
    if (patch.relayPolicy !== undefined) {
      const next = RelayPolicy.parse(patch.relayPolicy);
      set.relayPolicy = next;
      const before = RelayPolicy.parse(current.relayPolicy);
      if (JSON.stringify(next) !== JSON.stringify(before)) promptChanged = true;
    }
    if (promptChanged) set.promptRevision = sql`${channels.promptRevision} + 1`;
    if (Object.keys(set).length === 0) return { channel: rowToChannel(current), promptChanged };
    const row = tx.update(channels).set(set).where(eq(channels.id, id)).returning().get();
    if (!row) throw apiError("NOT_FOUND", "channel not found");
    return { channel: rowToChannel(row), promptChanged };
  });
}

/** 기본은 살아 있는 채널만, archived 면 보관한 채널만(채널 보관 스펙 「채널 보관」 절의 API) */
export function listChannels(
  db: DbOrTx,
  workspaceId: string,
  opts: { archived?: boolean } = {},
): ChannelRecord[] {
  return db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        opts.archived ? isNotNull(channels.archivedAt) : isNull(channels.archivedAt),
      ),
    )
    .orderBy(asc(channels.createdAt), asc(channels.id))
    .all()
    .map(rowToChannel);
}

/** workspaceId 를 주면 그 워크스페이스 것만 찾는다(REST·wire 는 항상 준다). */
export function getChannel(db: DbOrTx, id: string, workspaceId?: string): ChannelRecord | undefined {
  const row = db
    .select()
    .from(channels)
    .where(
      and(eq(channels.id, id), workspaceId === undefined ? undefined : eq(channels.workspaceId, workspaceId)),
    )
    .get();
  return row ? rowToChannel(row) : undefined;
}

/**
 * 쓰기 전에 부르는 채널 검사(계획 판정 PC1) — 없으면 404, 보관했으면 409 CHANNEL_ARCHIVED. 보관한 채널에서 막는 쓰기(보내기·카드
 * 상호작용·채널 수정·멤버·「새 대화」·첨부 올리기)가 모두 이 한 함수를 지난다. workspaceId 를 주면 그 워크스페이스 것만 찾는다
 */
export function assertChannelWritable(db: DbOrTx, channelId: string, workspaceId?: string): ChannelRecord {
  const channel = getChannel(db, channelId, workspaceId);
  if (!channel) throw apiError("NOT_FOUND", "channel not found");
  if (channel.archivedAt !== null) throw apiError("CHANNEL_ARCHIVED", "보관된 채널입니다");
  return channel;
}

/** 보관한 채널인가 — 런 관문·늦은 정본·푸시처럼 던지지 않고 가르는 자리가 쓴다. 없는 채널은 false */
export function isChannelArchived(db: DbOrTx, channelId: string): boolean {
  const row = db
    .select({ archivedAt: channels.archivedAt })
    .from(channels)
    .where(eq(channels.id, channelId))
    .get();
  return row?.archivedAt != null;
}

export type ArchiveChannelDeps = {
  db: Db;
  /** 사람 「중지」와 같은 길(run.abort) — 진행 런은 어댑터에 중단을 보내고, 대기 런은 보내지 않고 닫는다. 걸린 승인은 cancelled 로 닫힌다 */
  orchestrator: Pick<Orchestrator, "activeRuns" | "abort">;
};

/**
 * 보관(채널 보관 스펙 「보관할 때 서버가 하는 일」 절) — archived_at 을 쓰고 그 채널의 열린 런을 멈춘다. 이미 보관했으면 그대로(멱등),
 * 메시지·스레드·멤버·세션·첨부는 남는다. 새 런은 런 관문이 막는다(ops/budget.ts) — 쓰기가 끝난 뒤 들어온 멘션은 런을 만들지 않고, 쓰기
 * 전에 만든 런은 아래 훑기가 닫는다. 대기 런을 보내지 않는 것은 에이전트 보관(agents/service.ts archiveAgent)과 같이 두 겹이다 — 훑기는
 * 대기 런(뒤)부터 거꾸로 닫아 pump 가 꺼낼 런을 남기지 않고, 그래도 꺼낸 런은 디스패치 가드(runs/orchestrator.ts dispatch)가 보관을 보고
 * 보내지 않은 채 닫는다
 */
export async function archiveChannel(
  deps: ArchiveChannelDeps,
  id: string,
  workspaceId: string,
): Promise<ChannelRecord> {
  const { db } = deps;
  const row = db
    .update(channels)
    .set({ archivedAt: new Date() })
    .where(and(eq(channels.id, id), eq(channels.workspaceId, workspaceId), isNull(channels.archivedAt)))
    .returning()
    .get();
  const current = row ? rowToChannel(row) : getChannel(db, id, workspaceId);
  if (!current) throw apiError("NOT_FOUND", "channel not found");
  for (const run of deps.orchestrator.activeRuns(id).reverse()) await deps.orchestrator.abort(run.id);
  return current;
}

/** 보관 해제 — archived_at 을 비운다. 살아 있으면 그대로. 멤버·세션이 그대로라 다음 멘션은 같은 세션으로 이어 답한다 */
export function unarchiveChannel(db: DbOrTx, id: string, workspaceId: string): ChannelRecord {
  const row = db
    .update(channels)
    .set({ archivedAt: null })
    .where(and(eq(channels.id, id), eq(channels.workspaceId, workspaceId)))
    .returning()
    .get();
  if (!row) throw apiError("NOT_FOUND", "channel not found");
  return rowToChannel(row);
}

/** 멤버는 채널과 같은 워크스페이스의 사용자(membership 이 있는)·에이전트여야 한다. autoRespond=true 가 둘 이상이 되면 저장하고 경고한다. */
export function addMember(
  db: Db,
  channelId: string,
  input: AddMemberInput,
  logger: WarnLogger,
): ChannelMember {
  const member = db.transaction((tx) => {
    const channel = tx
      .select({ workspaceId: channels.workspaceId })
      .from(channels)
      .where(eq(channels.id, channelId))
      .get();
    if (!channel) throw apiError("NOT_FOUND", "channel not found");
    if (input.memberType === "user") {
      if (input.promptOverride !== undefined || input.autoRespond || (input.aliases?.length ?? 0) > 0) {
        throw apiError("VALIDATION", "promptOverride·autoRespond·aliases 는 에이전트 멤버만 가진다");
      }
      const user = tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, input.memberId), eq(users.workspaceId, channel.workspaceId)))
        .get();
      // membership 이 없거나 비활성인 사람은 넣지 않는다(roleOf)
      if (!user || !roleOf(tx, channel.workspaceId, input.memberId))
        throw apiError("NOT_FOUND", "user not found");
    } else {
      const agent = tx
        .select({ id: agents.id, archivedAt: agents.archivedAt })
        .from(agents)
        .where(and(eq(agents.id, input.memberId), eq(agents.workspaceId, channel.workspaceId)))
        .get();
      if (!agent) throw apiError("NOT_FOUND", "agent not found");
      if (agent.archivedAt !== null)
        throw apiError("AGENT_ARCHIVED", "삭제된 에이전트입니다", { agentId: agent.id });
    }
    const existing = tx
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.memberType, input.memberType),
          eq(channelMembers.memberId, input.memberId),
        ),
      )
      .get();
    if (existing) throw apiError("CONFLICT", "이미 채널 멤버다");
    const row = tx
      .insert(channelMembers)
      .values({
        id: uuidv7(),
        channelId,
        memberType: input.memberType,
        memberId: input.memberId,
        promptOverride: input.promptOverride ?? null,
        autoRespond: input.autoRespond ?? false,
        aliases: input.aliases ?? [],
        joinedAt: new Date(),
      })
      .returning()
      .get();
    return rowToMember(row);
  });
  if (member.autoRespond) warnIfManyAutoRespond(db, channelId, logger);
  return member;
}

/** promptOverride 가 값으로 달라지면 같은 트랜잭션에서 채널 promptRevision += 1 */
export function updateAgentMember(
  db: Db,
  channelId: string,
  memberId: string,
  patch: AgentMemberPatch,
  logger: WarnLogger,
): { member: ChannelMember; promptChanged: boolean } {
  const result = db.transaction((tx) => {
    const where = and(
      eq(channelMembers.channelId, channelId),
      eq(channelMembers.memberType, "agent"),
      eq(channelMembers.memberId, memberId),
    );
    const current = tx.select().from(channelMembers).where(where).get();
    if (!current) throw apiError("NOT_FOUND", "agent member not found");
    const set: SQLiteUpdateSetSource<typeof channelMembers> = {};
    let promptChanged = false;
    if (patch.promptOverride !== undefined) {
      set.promptOverride = patch.promptOverride;
      if (patch.promptOverride !== current.promptOverride) promptChanged = true;
    }
    if (patch.autoRespond !== undefined) set.autoRespond = patch.autoRespond;
    if (patch.aliases !== undefined) set.aliases = patch.aliases;
    if (promptChanged) {
      tx.update(channels)
        .set({ promptRevision: sql`${channels.promptRevision} + 1` })
        .where(eq(channels.id, channelId))
        .run();
    }
    if (Object.keys(set).length === 0) return { member: rowToMember(current), promptChanged };
    const row = tx.update(channelMembers).set(set).where(where).returning().get();
    if (!row) throw apiError("NOT_FOUND", "agent member not found");
    return { member: rowToMember(row), promptChanged };
  });
  if (patch.autoRespond === true) warnIfManyAutoRespond(db, channelId, logger);
  return result;
}

/** memberId 는 사용자 또는 에이전트 id */
export function removeMember(db: DbOrTx, channelId: string, memberId: string): void {
  const removed = db
    .delete(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.memberId, memberId)))
    .returning({ id: channelMembers.id })
    .all();
  if (removed.length === 0) throw apiError("NOT_FOUND", "member not found");
}

/** 사람이 채널에 없으면 넣고 true(호출자가 channel.member.changed 를 낸다). 이미 있으면 false(팀 스펙 「채널 참여」 절) */
export function joinChannelIfAbsent(tx: DbOrTx, channelId: string, userId: string, now: Date): boolean {
  const inserted = tx
    .insert(channelMembers)
    .values({ id: uuidv7(), channelId, memberType: "user", memberId: userId, joinedAt: now })
    .onConflictDoNothing({
      target: [channelMembers.channelId, channelMembers.memberType, channelMembers.memberId],
    })
    .returning({ id: channelMembers.id })
    .all();
  return inserted.length > 0;
}

/**
 * joinedAt 순. 보관한 에이전트와 비활성 멤버는 빠진다(설정·에이전트 보관 계획 판정 PS3, 채널 보관·멤버 비활성화 계획 판정 PC4) —
 * 행은 남아 되살리거나 다시 활성화하면 그대로 돌아온다. 멤버 응답·channel.member.changed·런 판정이 모두 이 조회라 한곳에서 거른다.
 * 멘션 해석·푸시 수신자·에이전트 헤더 「참여자:」는 같은 거름을 channelParticipants 가 한다
 */
export function listMembers(db: DbOrTx, channelId: string): ChannelMember[] {
  return db
    .select({ member: channelMembers })
    .from(channelMembers)
    .leftJoin(agents, and(eq(channelMembers.memberType, "agent"), eq(agents.id, channelMembers.memberId)))
    .leftJoin(
      memberships,
      and(eq(channelMembers.memberType, "user"), eq(memberships.userId, channelMembers.memberId)),
    )
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        or(
          and(eq(channelMembers.memberType, "user"), memberNotDeactivated),
          and(eq(channelMembers.memberType, "agent"), or(isNull(agents.id), agentNotArchived)),
        ),
      ),
    )
    .orderBy(asc(channelMembers.joinedAt), asc(channelMembers.id))
    .all()
    .map(({ member }) => rowToMember(member));
}

/**
 * 그 채널의 OpenClaw 에이전트 멤버가 속한 켜진 Gateway 들(멀티 Gateway 계획 판정 PG10) — Gateway 가 빈 에이전트와 꺼진 Gateway 는
 * 빠진다. 꺼진 Gateway 에는 보내도 실패해 경고 알림만 남는다 — 다시 켜면 그 Gateway 의 플러그인 hello 때 다시 보낸다
 * (channels/prompt-sync.ts watchPluginHellos)
 */
export function channelGatewayIds(db: DbOrTx, channelId: string): string[] {
  return db
    .selectDistinct({ gatewayId: agents.gatewayId })
    .from(channelMembers)
    .innerJoin(agents, eq(agents.id, channelMembers.memberId))
    .innerJoin(gateways, eq(gateways.id, agents.gatewayId))
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberType, "agent"),
        eq(agents.provider, "openclaw"),
        isNotNull(agents.gatewayId),
        eq(gateways.enabled, true),
      ),
    )
    .all()
    .flatMap((row) => (row.gatewayId === null ? [] : [row.gatewayId]));
}

/** 그 Gateway 에 OpenClaw 에이전트 멤버를 둔 채널들 — 그 Gateway 의 플러그인이 hello 하면 이 채널들의 프롬프트를 다시 보낸다 */
export function channelsOnGateway(db: DbOrTx, gatewayId: string): string[] {
  return db
    .selectDistinct({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(agents, eq(agents.id, channelMembers.memberId))
    .where(
      and(
        eq(channelMembers.memberType, "agent"),
        eq(agents.provider, "openclaw"),
        eq(agents.gatewayId, gatewayId),
      ),
    )
    .all()
    .map((row) => row.channelId);
}

/** 그 에이전트가 멤버인 채널마다 지금 동기화 대상 Gateway 들(channelGatewayIds) — 옮기기 전에 읽어 새로 들어오는 Gateway 를 가른다 */
export function agentChannelGateways(
  db: DbOrTx,
  agentId: string,
): Array<{ channelId: string; gatewayIds: string[] }> {
  return db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .where(and(eq(channelMembers.memberType, "agent"), eq(channelMembers.memberId, agentId)))
    .all()
    .map(({ channelId }) => ({ channelId, gatewayIds: channelGatewayIds(db, channelId) }));
}

/**
 * tokenize·renderForAgent 용 참가자. 사람 먼저, 에이전트 나중 — tokenize 는 뒤에 온 참가자가 같은 핸들을 덮으므로
 * 사람과 에이전트(또는 별칭)가 같은 핸들이면 에이전트로 풀린다. 보관한 에이전트와 비활성 멤버는 빠진다 — 손으로 친 @핸들 은 글자로
 * 남고(멘션 푸시도 없다) 에이전트 헤더 「참여자:」에도 실리지 않는다. includeInactive 는 이미 토큰이 된 옛 메시지를 에이전트에게 풀
 * 때만 쓴다 — 그들을 가리키던 <@agent:…>·<@user:…> 가 @unknown 이 아니라 그 핸들로 읽히게
 */
export function channelParticipants(
  db: DbOrTx,
  channelId: string,
  opts: { includeInactive?: boolean } = {},
): Participant[] {
  const people = db
    .select({ id: users.id, handle: users.handle, displayName: users.displayName })
    .from(channelMembers)
    .innerJoin(users, eq(users.id, channelMembers.memberId))
    .leftJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.workspaceId, users.workspaceId)),
    )
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberType, "user"),
        opts.includeInactive ? undefined : memberNotDeactivated,
      ),
    )
    .orderBy(asc(channelMembers.joinedAt), asc(channelMembers.id))
    .all();
  const bots = db
    .select({
      id: agents.id,
      handle: agents.handle,
      displayName: agents.name,
      aliases: channelMembers.aliases,
    })
    .from(channelMembers)
    .innerJoin(agents, eq(agents.id, channelMembers.memberId))
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberType, "agent"),
        opts.includeInactive ? undefined : agentNotArchived,
      ),
    )
    .orderBy(asc(channelMembers.joinedAt), asc(channelMembers.id))
    .all();
  return [
    ...people.map((p): Participant => ({ type: "user", ...p })),
    ...bots.map((b): Participant => ({ type: "agent", ...b })),
  ];
}

/**
 * 사람 메시지의 멘션을 풀 참가자 — 채널에 아직 없는 워크스페이스 사람(비활성 멤버 제외)을 앞에, channelParticipants 를 뒤에.
 * 사람은 멘션으로 채널에 들어오므로(자동 참여) 채널 밖 사람도 풀려야 한다. 뒤가 같은 핸들을 덮으므로 겹치면 채널 쪽(에이전트)이 이긴다
 */
export function userMessageParticipants(db: DbOrTx, channelId: string): Participant[] {
  const inChannel = channelParticipants(db, channelId);
  const channel = db
    .select({ workspaceId: channels.workspaceId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .get();
  if (!channel) return inChannel;
  const joined = new Set(inChannel.filter((p) => p.type === "user").map((p) => p.id));
  const others = db
    .select({ id: users.id, handle: users.handle, displayName: users.displayName })
    .from(users)
    .innerJoin(
      memberships,
      // 모르는 역할(guest 등)은 roleOf·listMembers 처럼 멤버로 치지 않는다
      and(
        eq(memberships.userId, users.id),
        eq(memberships.workspaceId, channel.workspaceId),
        inArray(memberships.role, TeamRole.options),
        memberNotDeactivated,
      ),
    )
    .where(eq(users.workspaceId, channel.workspaceId))
    .orderBy(asc(users.createdAt), asc(users.id))
    .all()
    .filter((p) => !joined.has(p.id))
    .map((p): Participant => ({ type: "user", ...p }));
  return [...others, ...inChannel];
}

export type ResetAgentSessionDeps = {
  db: Db;
  bus: ServerBus;
  /** 그 에이전트의 provider 어댑터로 리셋한다 */
  registry: Pick<AdapterRegistry, "forAgent">;
  orchestrator: Pick<Orchestrator, "activeRuns" | "abort">;
};

/**
 * 스펙 3.4 「새 대화」 — 채널의 에이전트 멤버만. 그 에이전트의 어댑터 capability 확인 → 그 세션의 진행 런 abort → 어댑터 resetSession
 * (OpenClaw 는 Gateway sessions.reset) → agent_sessions 리비전·시작 시각(서버가 정한 세션 id 는 비움) → info 시스템 메시지. threadRootId 가 있으면 그 스레드 세션만 — 채널 세션·다른 스레드는
 * 그대로이고 info 도 그 스레드에 남는다(스펙 2.4). 이 채널의 루트가 아니면 404. Gateway 리셋은 되돌릴 수 없어서 그 뒤 DB 쓰기가 실패하면 500 이고
 * 세션 행은 옛 리비전으로 남는다(다음 턴이 channelPrompt 를 한 번 더 싣는 정도).
 */
export async function resetAgentSession(
  deps: ResetAgentSessionDeps,
  input: { channelId: string; agentId: string; threadRootId?: string | undefined },
): Promise<void> {
  const { db, orchestrator } = deps;
  const { threadRootId } = input;
  const root = threadRootId === undefined ? undefined : getThreadRoot(db, input.channelId, threadRootId);
  if (threadRootId !== undefined && !root) throw apiError("NOT_FOUND", "thread not found");
  // 스레드면 그 루트의 대화, 아니면 채널의 열린 대화(계획 판정 PS3)
  const conversationId = root?.conversationId ?? latestOpenConversation(db, input.channelId);
  if (conversationId === undefined) throw apiError("NOT_FOUND", "conversation not found");
  const member = listMembers(db, input.channelId).some(
    (m) => m.memberType === "agent" && m.memberId === input.agentId,
  );
  if (!member) throw apiError("NOT_FOUND", "agent member not found");
  const agent = getAgent(db, input.agentId);
  if (!agent) throw apiError("NOT_FOUND", "agent not found");
  const adapter = adapterForAgent(deps.registry, agent);
  if (!adapter.capabilities().sessionReset) throw capabilityMissing();
  // markSessionReset 이 행을 만들며 키를 따로 조립하지 않게, 세션 행을 먼저 보장하고 그 키로 리셋한다(sc-t7 걱정 1)
  const { session } = ensureSession(db, adapter, { conversationId, agentId: input.agentId, threadRootId });
  // 아래 abort·리셋을 기다리는 동안 디스패치되는 런부터 새 세션 id 를 받는다(clearProviderSessionId). 리셋이 실패해도
  // 되살리지 않는다 — 다음 런은 새 대화로 간다
  if (adapter.capabilities().serverSessionIds) clearProviderSessionId(db, session.id);
  // 세션은 (채널, 에이전트, 스레드)당 하나 — 그 에이전트의 같은 스레드(채널이면 스레드 없음) 미종료 런이 곧 이 세션의 런이다.
  // 옛 세션에서 먼저 멈춘다. 대기 런(뒤)부터 거꾸로 닫는다 — 진행 런을 먼저 닫으면 pump 가 다음 대기 런을 Gateway 로
  // 보내 버린다(sc-t12 리뷰 R1)
  const mine = orchestrator
    .activeRuns(input.channelId)
    .filter((run) => run.agentId === input.agentId && run.threadRootId === threadRootId);
  for (const run of mine.reverse()) await orchestrator.abort(run.id);
  let reset: Awaited<ReturnType<AgentAdapter["resetSession"]>>;
  try {
    reset = await adapter.resetSession(session.sessionKey, agentConnectionId(db, agent.id));
  } catch (err) {
    if (!(err instanceof AdapterError)) throw err;
    // capability 가 아직 true 였던 첫 시도 — 어댑터가 MISSING_SCOPE 를 FORBIDDEN 으로 올리고 capability 를 내린다
    if (err.code === "FORBIDDEN") throw capabilityMissing();
    throw apiError(err.code, err.message);
  }
  markSessionReset(db, conversationId, input.agentId, reset, threadRootId);
  const handle = agent.handle;
  createSystemMessage(db, deps.bus, {
    conversationId,
    ...(threadRootId === undefined ? {} : { threadRootId }),
    kind: "info",
    bodyMd: `@${handle} 의 대화를 새로 시작했습니다`,
    systemMeta: { kind: "info" },
  });
}

/** 그 provider 의 어댑터가 없으면 ADAPTER_UNAVAILABLE(503) */
function adapterForAgent(
  registry: Pick<AdapterRegistry, "forAgent">,
  agent: { provider: string },
): AgentAdapter {
  try {
    return registry.forAgent(agent);
  } catch (err) {
    if (err instanceof AdapterError) throw apiError(err.code, err.message);
    throw err;
  }
}

/** 스펙 8장 — sessions.reset 스코프(operator.admin) 부족. 코드는 CONFLICT, 사유는 message 접두사로 구분한다 */
function capabilityMissing() {
  return apiError("CONFLICT", "ADAPTER_CAPABILITY_MISSING: sessions.reset 권한 없음");
}

function warnIfManyAutoRespond(db: DbOrTx, channelId: string, logger: WarnLogger): void {
  const agentIds = db
    .select({ id: channelMembers.memberId })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberType, "agent"),
        eq(channelMembers.autoRespond, true),
      ),
    )
    .all()
    .map((r) => r.id);
  if (agentIds.length > 1) {
    logger.warn(
      { channelId, agentIds },
      "autoRespond=true 에이전트가 채널에 둘 이상이다 — 라우터는 joinedAt 이 가장 이른 하나만 쓴다",
    );
  }
}
