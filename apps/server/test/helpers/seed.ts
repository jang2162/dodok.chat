import { v7 as uuid } from "uuid";
import type { DbOrTx } from "../../src/db/client";
import { agents, channelMembers, channels, users, workspaces } from "../../src/db/schema.sqlite";

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

/** workspace·owner user·agent·channel·channel_members(user+agent) 최소 삽입 */
export function seedChannelWithAgent(
  db: DbOrTx,
  opts: { agentHandle?: string; channelName?: string } = {},
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
  db.insert(agents)
    .values({
      id: agentId,
      workspaceId,
      provider: "openclaw",
      providerAgentId: agentHandle,
      handle: agentHandle,
      name: agentHandle,
      createdAt: now,
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
  db.insert(channelMembers)
    .values([
      { id: uuid(), channelId, memberType: "user", memberId: userId, joinedAt: now },
      { id: uuid(), channelId, memberType: "agent", memberId: agentId, joinedAt: now },
    ])
    .run();

  return { workspaceId, userId, agentId, channelId };
}
