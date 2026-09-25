import { Channel, ChannelMember, type Participant, RelayPolicy } from "@dodok/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { AdapterError, type AgentAdapter } from "../../adapters/types";
import type { Db, DbOrTx } from "../../db/client";
import { agents, channelMembers, channels, users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseStored } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { getAgent } from "../agents/service";
import { createSystemMessage, getThreadRoot } from "../messages/service";
import type { Orchestrator } from "../runs/orchestrator";
import { ensureSession, markSessionReset } from "../sessions/service";

type ChannelRow = typeof channels.$inferSelect;
type MemberRow = typeof channelMembers.$inferSelect;

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

export function listChannels(db: DbOrTx, workspaceId: string): ChannelRecord[] {
  return db
    .select()
    .from(channels)
    .where(eq(channels.workspaceId, workspaceId))
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

/** 멤버는 채널과 같은 워크스페이스의 사용자·에이전트여야 한다. autoRespond=true 가 둘 이상이 되면 저장하고 경고한다. */
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
      if (!user) throw apiError("NOT_FOUND", "user not found");
    } else {
      const agent = tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.memberId), eq(agents.workspaceId, channel.workspaceId)))
        .get();
      if (!agent) throw apiError("NOT_FOUND", "agent not found");
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

/** joinedAt 순 */
export function listMembers(db: DbOrTx, channelId: string): ChannelMember[] {
  return db
    .select()
    .from(channelMembers)
    .where(eq(channelMembers.channelId, channelId))
    .orderBy(asc(channelMembers.joinedAt), asc(channelMembers.id))
    .all()
    .map(rowToMember);
}

/**
 * tokenize·renderForAgent 용 참가자. 사람 먼저, 에이전트 나중 — tokenize 는 뒤에 온 참가자가 같은 핸들을 덮으므로
 * 사람과 에이전트(또는 별칭)가 같은 핸들이면 에이전트로 풀린다.
 */
export function channelParticipants(db: DbOrTx, channelId: string): Participant[] {
  const people = db
    .select({ id: users.id, handle: users.handle, displayName: users.displayName })
    .from(channelMembers)
    .innerJoin(users, eq(users.id, channelMembers.memberId))
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.memberType, "user")))
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
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.memberType, "agent")))
    .orderBy(asc(channelMembers.joinedAt), asc(channelMembers.id))
    .all();
  return [
    ...people.map((p): Participant => ({ type: "user", ...p })),
    ...bots.map((b): Participant => ({ type: "agent", ...b })),
  ];
}

export type ResetAgentSessionDeps = {
  db: Db;
  bus: ServerBus;
  adapter: AgentAdapter;
  orchestrator: Pick<Orchestrator, "activeRuns" | "abort">;
};

/**
 * 스펙 3.4 「새 대화」 — 채널의 에이전트 멤버만. capability 확인 → 그 세션의 진행 런 abort → Gateway sessions.reset →
 * agent_sessions 리비전·시작 시각 → info 시스템 메시지. threadRootId 가 있으면 그 스레드 세션만 — 채널 세션·다른 스레드는
 * 그대로이고 info 도 그 스레드에 남는다(스펙 2.4). 이 채널의 루트가 아니면 404. Gateway 리셋은 되돌릴 수 없어서 그 뒤 DB 쓰기가 실패하면 500 이고
 * 세션 행은 옛 리비전으로 남는다(다음 턴이 channelPrompt 를 한 번 더 싣는 정도).
 */
export async function resetAgentSession(
  deps: ResetAgentSessionDeps,
  input: { channelId: string; agentId: string; threadRootId?: string | undefined },
): Promise<void> {
  const { db, adapter, orchestrator } = deps;
  const { threadRootId } = input;
  if (threadRootId !== undefined && !getThreadRoot(db, input.channelId, threadRootId)) {
    throw apiError("NOT_FOUND", "thread not found");
  }
  const member = listMembers(db, input.channelId).some(
    (m) => m.memberType === "agent" && m.memberId === input.agentId,
  );
  if (!member) throw apiError("NOT_FOUND", "agent member not found");
  if (!adapter.capabilities().sessionReset) throw capabilityMissing();
  // markSessionReset 이 행을 만들며 키를 따로 조립하지 않게, 세션 행을 먼저 보장하고 그 키로 리셋한다(sc-t7 걱정 1)
  const { session } = ensureSession(db, adapter, input);
  // 세션은 (채널, 에이전트, 스레드)당 하나 — 그 에이전트의 같은 스레드(채널이면 스레드 없음) 미종료 런이 곧 이 세션의 런이다.
  // 옛 세션에서 먼저 멈춘다. 대기 런(뒤)부터 거꾸로 닫는다 — 진행 런을 먼저 닫으면 pump 가 다음 대기 런을 Gateway 로
  // 보내 버린다(sc-t12 리뷰 R1)
  const mine = orchestrator
    .activeRuns(input.channelId)
    .filter((run) => run.agentId === input.agentId && run.threadRootId === threadRootId);
  for (const run of mine.reverse()) await orchestrator.abort(run.id);
  let reset: Awaited<ReturnType<AgentAdapter["resetSession"]>>;
  try {
    reset = await adapter.resetSession(session.sessionKey);
  } catch (err) {
    if (!(err instanceof AdapterError)) throw err;
    // capability 가 아직 true 였던 첫 시도 — 어댑터가 MISSING_SCOPE 를 FORBIDDEN 으로 올리고 capability 를 내린다
    if (err.code === "FORBIDDEN") throw capabilityMissing();
    throw apiError(err.code, err.message);
  }
  markSessionReset(db, input.channelId, input.agentId, reset, threadRootId);
  const handle = getAgent(db, input.agentId)?.handle ?? "unknown";
  createSystemMessage(db, deps.bus, {
    channelId: input.channelId,
    ...(threadRootId === undefined ? {} : { threadRootId }),
    kind: "info",
    bodyMd: `@${handle} 의 대화를 새로 시작했습니다`,
    systemMeta: { kind: "info" },
  });
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
