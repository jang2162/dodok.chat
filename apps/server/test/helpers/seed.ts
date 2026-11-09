import { type Agent, dodokSessionKey, type RunnerPermissionMode, type RunnerProgram } from "@dodok/shared";
import { randomBytes } from "node:crypto";
import { v7 as uuid } from "uuid";
import { session, user } from "../../src/db/auth-schema";
import type { Db, DbOrTx } from "../../src/db/client";
import { eq } from "drizzle-orm";
import {
  agents,
  channelMembers,
  channels,
  gateways,
  messages,
  runnerTokens,
  users,
  workspaces,
} from "../../src/db/schema.sqlite";
import { createAgent } from "../../src/modules/agents/service";
import { createProject, listProjects } from "../../src/modules/runners/projects";
import { FAKE_GATEWAY_ID, insertGateway } from "./gateways";
import { createConversation, latestOpenConversation } from "../../src/modules/conversations/store";
import { ensureSession } from "../../src/modules/sessions/service";
import { type ChannelRecord, rowToChannel } from "../../src/modules/channels/service";
import { findOrCreateDm } from "../../src/modules/dms/service";

/** workspace·user 만 삽입한다 — 채널·에이전트는 서비스로 만드는 테스트용 */
export function seedWorkspace(
  db: DbOrTx,
  opts: { userHandle?: string } = {},
): { workspaceId: string; userId: string } {
  const now = new Date();
  const workspaceId = uuid();
  const userId = uuid();
  const handle = opts.userHandle ?? "owner";
  db.insert(workspaces).values({ id: workspaceId, name: "w", createdAt: now }).run();
  db.insert(users)
    .values({ id: userId, workspaceId, handle, displayName: handle, authProvider: "local", createdAt: now })
    .run();
  return { workspaceId, userId };
}

/**
 * workspace·owner user·agent·channel·channel_members(user+agent) 최소 삽입. 에이전트(OpenClaw)는 FakeAdapter 기본 연결의 Gateway
 * (FAKE_GATEWAY_ID — 없으면 넣는다)에 묶인다. opts.gatewayId 가 null 이면 연결이 빈 에이전트
 */
export function seedChannelWithAgent(
  db: DbOrTx,
  opts: { agentHandle?: string; channelName?: string; gatewayId?: string | null } = {},
): { workspaceId: string; userId: string; agentId: string; channelId: string; conversationId: string } {
  const agentHandle = opts.agentHandle ?? "dev";
  const now = new Date();
  const workspaceId = uuid();
  const userId = uuid();
  const agentId = uuid();
  const channelId = uuid();

  db.insert(workspaces).values({ id: workspaceId, name: "w", createdAt: now }).run();
  db.insert(users)
    .values({
      id: userId,
      workspaceId,
      handle: "owner",
      displayName: "owner",
      authProvider: "local",
      createdAt: now,
    })
    .run();
  const gatewayId = opts.gatewayId === undefined ? ownGateway(db, workspaceId) : opts.gatewayId;
  if (gatewayId !== null) insertGateway(db, workspaceId, { id: gatewayId });
  db.insert(agents)
    .values({
      id: agentId,
      workspaceId,
      provider: "openclaw",
      providerAgentId: agentHandle,
      handle: agentHandle,
      name: agentHandle,
      createdAt: now,
      gatewayId,
    })
    .run();
  db.insert(channels)
    .values({
      id: channelId,
      workspaceId,
      name: opts.channelName ?? "general",
      relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
      visibility: "public",
      createdBy: userId,
      createdAt: now,
    })
    .run();
  const conversationId = seedConversation(db, channelId, { createdBy: userId, createdAt: now });
  db.insert(channelMembers)
    .values([
      { id: uuid(), channelId, memberType: "user", memberId: userId, joinedAt: now },
      { id: uuid(), channelId, memberType: "agent", memberId: agentId, joinedAt: now },
    ])
    .run();

  return { workspaceId, userId, agentId, channelId, conversationId };
}

/**
 * 채널에 열린 대화(세션) 하나를 넣고 그 id 를 돌려준다. id 는 채널 id 와 다르다 — 채널 id 를 대화 id 로 잘못 넘기는 코드가 테스트에서
 * 드러나게(0025 의 「이전 대화」만 id 가 채널 id 와 같다). createdBy 를 안 주면 채널을 만든 사람
 */
export function seedConversation(
  db: DbOrTx,
  channelId: string,
  opts: { createdBy?: string; createdAt?: Date; title?: string } = {},
): string {
  const createdBy =
    opts.createdBy ??
    db.select({ createdBy: channels.createdBy }).from(channels).where(eq(channels.id, channelId)).get()
      ?.createdBy;
  if (createdBy === undefined) throw new Error(`seedConversation: no channel ${channelId}`);
  return createConversation(db, {
    channelId,
    title: opts.title ?? "테스트 세션",
    titleSource: "user",
    createdBy: { type: "user", id: createdBy },
    createdAt: opts.createdAt ?? new Date(),
  }).id;
}

/**
 * (주인, 에이전트) DM 채널 — 실제 서비스(modules/dms/service.ts findOrCreateDm)로 만든다, 허용 검사 없이. 대화는 만들지 않는다(첫
 * 보내기가 만든다). 이미 있으면 그 DM
 */
export function createDmChannelForTest(
  db: Db,
  opts: { workspaceId: string; ownerId: string; agentId: string },
): ChannelRecord {
  return findOrCreateDm(db, opts).channel;
}

/**
 * 사람 DM·그룹 DM(kind = 'direct') 채널을 행으로 넣는다 — 계획 Global Constraints 의 행 값·direct_key 그대로, 참여자는 createdBy·userIds
 * (사람 role member)·agentIds(autoRespond false)의 channel_members 행. 에이전트가 없으면(한 줄기) 대화 하나를 같이 만든다. 아직 서비스
 * (modules/directs/service.ts)가 없어 직접 넣는다
 */
export function createDirectChannelForTest(
  db: DbOrTx,
  opts: { workspaceId: string; createdBy: string; userIds: string[]; agentIds?: string[] },
): ChannelRecord {
  const now = new Date();
  const userIds = [...new Set([opts.createdBy, ...opts.userIds])];
  const agentIds = opts.agentIds ?? [];
  const directKey = [...userIds.map((id) => `u:${id}`), ...agentIds.map((id) => `a:${id}`)].sort().join(",");
  const row = db
    .insert(channels)
    .values({
      id: uuid(),
      workspaceId: opts.workspaceId,
      name: "direct",
      relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
      visibility: "private",
      createdBy: opts.createdBy,
      createdAt: now,
      sessionPolicy: { create: "members" },
      kind: "direct",
      directKey,
    })
    .returning()
    .get();
  db.insert(channelMembers)
    .values([
      ...userIds.map((memberId) => ({
        id: uuid(),
        channelId: row.id,
        memberType: "user",
        memberId,
        role: "member",
        joinedAt: now,
      })),
      ...agentIds.map((memberId) => ({
        id: uuid(),
        channelId: row.id,
        memberType: "agent",
        memberId,
        autoRespond: false,
        joinedAt: now,
      })),
    ])
    .run();
  if (agentIds.length === 0) seedConversation(db, row.id, { createdBy: opts.createdBy, createdAt: now });
  return rowToChannel(row);
}

/**
 * 그 워크스페이스가 쓸 Gateway id — FakeAdapter 기본 연결(FAKE_GATEWAY_ID)이 비었거나 이 워크스페이스 것이면 그것, 다른 워크스페이스가
 * 이미 가졌으면 새 id(Gateway 는 한 워크스페이스의 것이고, 같은 Gateway 에 같은 id 에이전트는 하나뿐이다)
 */
function ownGateway(db: DbOrTx, workspaceId: string): string {
  const row = db
    .select({ workspaceId: gateways.workspaceId })
    .from(gateways)
    .where(eq(gateways.id, FAKE_GATEWAY_ID))
    .get();
  return row === undefined || row.workspaceId === workspaceId ? FAKE_GATEWAY_ID : uuid();
}

/**
 * 푸시 구독의 주인(사용자 + 등록한 세션). 구독은 세션 FK 가 있어야 들어간다 — Better Auth user 행이 없으면 넣고(이메일은 id 로
 * 만든 자리값) 세션 행을 새로 만든다. 부를 때마다 새 세션이다
 */
export function seedSession(
  db: DbOrTx,
  userId: string,
  expiresAt: Date = new Date(Date.now() + 30 * 24 * 3600_000),
): { userId: string; sessionId: string } {
  const now = new Date();
  db.insert(user)
    .values({ id: userId, name: userId, email: `${userId}@seed.local`, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
  const sessionId = uuid();
  db.insert(session)
    .values({ id: sessionId, token: uuid(), userId, expiresAt, createdAt: now, updatedAt: now })
    .run();
  return { userId, sessionId };
}

/**
 * 그 채널의 열린 세션 id — 없으면 seedConversation 으로 하나 만든다. 채널 하나에 세션 하나만 쓰는 테스트가 「이 채널의 세션」을 얻는
 * 길이다(채널을 만들어도 세션은 생기지 않는다 — 채널 세션 스펙 결정 7). 세션을 둘 이상 쓰는 테스트는 seedConversation 을 직접 쓴다
 */
export function channelConversation(db: DbOrTx, channelId: string): string {
  return latestOpenConversation(db, channelId) ?? seedConversation(db, channelId);
}

/**
 * `message.send` 에 실을 세션 — 답글이면 루트의 세션, 아니면 그 채널의 열린 세션(`channelConversation`). 서버는 둘 중 하나
 * (conversationId·newConversation)를 꼭 받는다(채널 세션 계획 판정 PS4 — 서버가 고르던 다리를 걷었다). 세션 하나만 쓰는 테스트의
 * 보내기가 걷기 전 다리와 같은 세션으로 가게 한다
 */
export function sendTarget(db: DbOrTx, channelId: string, threadRootId?: string): { conversationId: string } {
  if (threadRootId !== undefined) {
    const root = db
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.id, threadRootId))
      .get();
    // 없는 루트 — 서버가 답할 오류(VALIDATION)를 보게 그 채널의 세션을 싣는다
    if (root) return { conversationId: root.conversationId };
  }
  return { conversationId: channelConversation(db, channelId) };
}

/**
 * 그 에이전트의 세션 행(디스패치가 만드는 것과 같은 키) — 런 없는 정본은 서버가 만든 세션의 키로 와야 받는다(orchestrator
 * `isOwnSession`). 인바운드 없이 정본부터 보내는 테스트가 「이 세션에서 불린 적이 있다」를 먼저 둔다
 */
export function seedAgentSession(
  db: Db,
  input: { conversationId: string; agentId: string; threadRootId?: string },
): void {
  ensureSession(db, { sessionKeyFor: dodokSessionKey }, input);
}

/**
 * 러너 에이전트를 실제 흐름(러너 토큰 → 프로젝트 → 에이전트)으로 만든다. runnerTokenId 를 주지 않으면 그 워크스페이스에 토큰 행을
 * 하나 넣는다. providerAgentId 는 서버가 짓는다(r-…) — 세션 키가 필요하면 돌려준 agent.providerAgentId 를 쓴다
 */
export function createRunnerAgentForTest(
  db: Db,
  opts: {
    workspaceId: string;
    handle: string;
    name?: string;
    runnerTokenId?: string;
    rootId?: string;
    relPath?: string;
    program?: RunnerProgram;
    basePrompt?: string;
    model?: string | null;
    permissionMode?: RunnerPermissionMode;
    allowedTools?: string[] | null;
    disallowedTools?: string[];
    enabled?: boolean;
  },
): { agent: Agent; runnerTokenId: string; projectId: string } {
  const runnerTokenId = opts.runnerTokenId ?? insertRunnerToken(db, opts.workspaceId);
  const relPath = opts.relPath ?? opts.handle;
  const existing = listProjects(db, runnerTokenId).find(
    (p) => p.archivedAt === null && p.rootId === (opts.rootId ?? "src") && p.relPath === relPath,
  );
  const project =
    existing ??
    createProject(db, {
      workspaceId: opts.workspaceId,
      runnerTokenId,
      rootId: opts.rootId ?? "src",
      relPath,
    });
  const agent = createAgent(db, {
    workspaceId: opts.workspaceId,
    provider: "runner",
    runnerProjectId: project.id,
    program: opts.program ?? "claude",
    handle: opts.handle,
    name: opts.name ?? opts.handle,
    ...(opts.basePrompt === undefined ? {} : { basePrompt: opts.basePrompt }),
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.permissionMode === undefined ? {} : { permissionMode: opts.permissionMode }),
    ...(opts.allowedTools === undefined ? {} : { allowedTools: opts.allowedTools }),
    ...(opts.disallowedTools === undefined ? {} : { disallowedTools: opts.disallowedTools }),
    ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
  });
  return { agent, runnerTokenId, projectId: project.id };
}

/** 러너 토큰 행 하나 — 원문 없이(해시는 임의값). 실제 러너를 붙일 테스트는 issueRunnerToken 으로 만든다 */
export function insertRunnerToken(db: DbOrTx, workspaceId: string, label = "laptop"): string {
  const id = uuid();
  db.insert(runnerTokens)
    .values({
      id,
      workspaceId,
      label,
      hash: randomBytes(32).toString("hex"),
      prefix: "abcdef",
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    })
    .run();
  return id;
}
