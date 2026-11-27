/**
 * 자동화 한 줄(shared AutomationSummary)과 목록 경고(자동화 스펙 「관리 API」 장). 경고는 읽을 때마다 지금 상태로 센다 — 문구의
 * 에이전트가 나중에 채널에서 빠지거나 꺼지거나 핸들이 바뀌어도 다음 목록에 보인다(계획 Review Focus 3). 게시는 경고와 무관하게 된다
 */
import {
  AutomationSummary,
  type AutomationWarning,
  type Participant,
  plainMentionHandles,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { agents, channelMembers, channels, users } from "../../db/schema.sqlite";
import { parseStored } from "../../http/validate";
import { isAgentActive } from "../agents/service";
import { isChannelArchived, userMessageParticipants, workspaceHandles } from "../channels/service";
import type { AutomationRow } from "./store";

/** 토큰 원문은 행에 없다 — tokenPrefix 만 싣는다. 계약을 어긴 행이면 500 INTERNAL(parseStored) */
export function toAutomationSummary(db: DbOrTx, row: AutomationRow): AutomationSummary {
  return parseStored(
    AutomationSummary,
    {
      id: row.id,
      name: row.name,
      channelId: row.channelId,
      kind: row.kind,
      bodyMd: row.bodyMd,
      enabled: row.enabled,
      schedule: row.scheduleJson ?? undefined,
      nextRunAt: row.nextRunAt?.toISOString(),
      tokenPrefix: row.tokenPrefix ?? undefined,
      lastRunAt: row.lastRunAt?.toISOString(),
      lastStatus: row.lastStatus ?? undefined,
      warnings: automationWarnings(db, row),
    },
    "automation summary",
  );
}

/**
 * 채널 보관, 그리고 문구의 평문 `@핸들` 마다 한 번(처음 나온 차례) — 게시할 때와 같은 참가자(userMessageParticipants)로 풀어 본다.
 * 풀리는 사람·켜진 에이전트는 경고 없음, 풀리는 꺼진 에이전트는 agent_disabled. 풀리지 않으면 워크스페이스에서 그 핸들을 찾는다:
 * 에이전트(다른 채널에서 붙인 별칭 포함)면 꺼졌거나 보관됐으면 agent_disabled, 아니면 agent_not_in_channel. 사람(비활성 멤버 포함 — 핸들은 그 사람 몫)이면 경고 없음,
 * 아무도 아니면 unknown_handle. handle 은 문구에 쓴 그대로(소문자)라 별칭으로 부른 것도 문구와 맞는다
 */
export function automationWarnings(
  db: DbOrTx,
  row: Pick<AutomationRow, "workspaceId" | "channelId" | "bodyMd">,
): AutomationWarning[] {
  const warnings: AutomationWarning[] = [];
  if (isChannelArchived(db, row.channelId)) warnings.push({ kind: "channel_archived" });
  if (plainMentionHandles(row.bodyMd).length === 0) return warnings;

  // tokenize 와 같은 규칙 — 뒤에 온 참가자가 같은 핸들을 덮는다(채널 쪽 에이전트가 이긴다)
  const resolved = new Map<string, Participant>();
  for (const p of userMessageParticipants(db, row.channelId)) {
    resolved.set(p.handle.toLowerCase(), p);
    for (const alias of p.aliases ?? []) resolved.set(alias.toLowerCase(), p);
  }
  const workspaceAgents = db
    .select({ id: agents.id, handle: agents.handle, enabled: agents.enabled, archivedAt: agents.archivedAt })
    .from(agents)
    .where(eq(agents.workspaceId, row.workspaceId))
    .all();
  const active = (agent: (typeof workspaceAgents)[number]) =>
    isAgentActive({ enabled: agent.enabled, archivedAt: agent.archivedAt?.toISOString() ?? null });
  const agentById = new Map(workspaceAgents.map((a) => [a.id, a]));
  const agentByHandle = new Map(workspaceAgents.map((a) => [a.handle.toLowerCase(), a]));
  let peopleHandles: Set<string> | undefined;
  const isPerson = (handle: string) => {
    peopleHandles ??= new Set(
      db
        .select({ handle: users.handle })
        .from(users)
        .where(eq(users.workspaceId, row.workspaceId))
        .all()
        .map((u) => u.handle.toLowerCase()),
    );
    return peopleHandles.has(handle);
  };
  // 다른 채널에서 붙인 별칭 — 이 채널에서는 풀리지 않으니 그 에이전트로 경고한다
  const aliasAgent = new Map<string, (typeof workspaceAgents)[number]>();
  for (const m of db
    .select({ memberId: channelMembers.memberId, aliases: channelMembers.aliases })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channels.workspaceId, row.workspaceId), eq(channelMembers.memberType, "agent")))
    .all()) {
    const agent = agentById.get(m.memberId);
    if (agent) for (const alias of m.aliases) aliasAgent.set(alias.normalize("NFC").toLowerCase(), agent);
  }
  // 게시(tokenize)와 같은 판정 — 워크스페이스가 아는 가장 긴 핸들(workspaceHandles). 그것이 채널에서 풀리지 않으면 짧은 핸들로
  // 내려가지 않는다: 「@개발봇에게」는 채널 밖 개발봇으로 경고하고, 채널의 「개발」로 읽지 않는다
  const known = workspaceHandles(db, { workspaceId: row.workspaceId });
  const handles = plainMentionHandles(row.bodyMd, (h) => resolved.has(h) || known(h));

  for (const handle of handles) {
    const participant = resolved.get(handle);
    if (participant?.type === "user") continue;
    if (participant?.type === "agent") {
      const agent = agentById.get(participant.id);
      if (agent && !active(agent)) warnings.push({ kind: "agent_disabled", handle });
      continue;
    }
    const agent = agentByHandle.get(handle) ?? aliasAgent.get(handle);
    if (agent) {
      warnings.push({ kind: active(agent) ? "agent_not_in_channel" : "agent_disabled", handle });
      continue;
    }
    if (!isPerson(handle)) warnings.push({ kind: "unknown_handle", handle });
  }
  return warnings;
}
