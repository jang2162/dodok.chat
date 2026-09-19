import type { Agent, ChannelMember } from "@dodok/shared";
import type { MeResponse } from "@/api/queries";

/** 작성기 @ 후보(스펙 5.1). `id` 는 멘션 노드 attrs.id 그대로 — `"a:<agentId>"`·`"u:<userId>"` */
export type MentionCandidate = {
  id: string;
  /** 멘션에 보이는 핸들 */
  label: string;
  name: string;
  kind: "agent" | "user";
  aliases: string[];
  /** 꺼진 에이전트는 흐리게 + 「꺼짐」(부를 수는 있다 — 서버가 알린다) */
  enabled: boolean;
};

/** 후보 목록에 보이는 최대 수 */
export const MAX_MENTIONS = 8;

/** 채널의 에이전트 멤버(멤버 순, `useMembers` × `useAgents`) 다음 사람(MVP 는 owner — `useMe`) */
export function mentionCandidates(
  members: readonly ChannelMember[] | undefined,
  agents: readonly Agent[] | undefined,
  me: MeResponse | undefined,
): MentionCandidate[] {
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const channelAgents = (members ?? []).flatMap((m): MentionCandidate[] => {
    const a = m.memberType === "agent" ? byId.get(m.memberId) : undefined;
    return a
      ? [
          {
            id: `a:${a.id}`,
            label: a.handle,
            name: a.name,
            kind: "agent",
            aliases: m.aliases,
            enabled: a.enabled,
          },
        ]
      : [];
  });
  const people: MentionCandidate[] = me
    ? [
        {
          id: `u:${me.user.id}`,
          label: me.user.handle,
          name: me.user.displayName,
          kind: "user",
          aliases: [],
          enabled: true,
        },
      ]
    : [];
  return [...channelAgents, ...people];
}

/** 핸들·이름·별칭 앞부분 일치(대소문자 무시). 빈 검색어는 전부 */
export function matchMentions(
  candidates: readonly MentionCandidate[],
  query: string,
  limit = MAX_MENTIONS,
): MentionCandidate[] {
  const q = query.toLowerCase();
  return candidates
    .filter((c) => [c.label, c.name, ...c.aliases].some((s) => s.toLowerCase().startsWith(q)))
    .slice(0, limit);
}
