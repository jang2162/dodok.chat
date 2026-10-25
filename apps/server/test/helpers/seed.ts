import { v7 as uuid } from "uuid";
import { session, user } from "../../src/db/auth-schema";
import type { DbOrTx } from "../../src/db/client";
import { eq } from "drizzle-orm";
import { agents, channelMembers, channels, gateways, users, workspaces } from "../../src/db/schema.sqlite";
import { FAKE_GATEWAY_ID, insertGateway } from "./gateways";
import { createLegacyConversation } from "../../src/modules/conversations/store";

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
): { workspaceId: string; userId: string; agentId: string; channelId: string } {
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
  createLegacyConversation(db, { id: channelId, createdBy: userId, createdAt: now });
  db.insert(channelMembers)
    .values([
      { id: uuid(), channelId, memberType: "user", memberId: userId, joinedAt: now },
      { id: uuid(), channelId, memberType: "agent", memberId: agentId, joinedAt: now },
    ])
    .run();

  return { workspaceId, userId, agentId, channelId };
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
