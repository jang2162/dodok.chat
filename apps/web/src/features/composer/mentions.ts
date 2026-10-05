import type { Agent, ChannelMember, Person } from "@dodok/shared";
import type { MeResponse } from "@/api/queries";
import { isArchived } from "@/features/agents/archived";

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
  /** OpenClaw 에이전트가 속한 Gateway 이름 — 두 Gateway 의 같은 id 를 가른다(멀티 Gateway 스펙 「웹」 절). 연결이 비었으면 없다 */
  gateway?: string;
};

/** 후보 목록에 보이는 최대 수 */
export const MAX_MENTIONS = 8;

/**
 * 채널의 에이전트 멤버(멤버 순, `useMembers` × `useAgents`) 다음 사람. 보관(삭제)한 에이전트는 서버 멤버 응답이 이미 빼지만,
 * 다른 탭의 보관 뒤 멤버를 다시 받기 전 틈에도 부르지 않게 여기서도 거른다. 사람은 워크스페이스 멤버 전원(`usePeople`, 가입 순 —
 * 나간 멤버는 부를 수 없어 뺀다, 팀 스펙 5장). 사람 목록을 아직 못 받았으면 나 하나(`useMe`)
 */
export function mentionCandidates(
  members: readonly ChannelMember[] | undefined,
  agents: readonly Agent[] | undefined,
  me: MeResponse | undefined,
  people?: readonly Person[],
): MentionCandidate[] {
  const byId = new Map((agents ?? []).map((a) => [a.id, a]));
  const channelAgents = (members ?? []).flatMap((m): MentionCandidate[] => {
    const a = m.memberType === "agent" ? byId.get(m.memberId) : undefined;
    return a && !isArchived(a)
      ? [
          {
            id: `a:${a.id}`,
            label: a.handle,
            name: a.name,
            kind: "agent",
            aliases: m.aliases,
            enabled: a.enabled,
            ...(a.gateway ? { gateway: a.gateway.name } : {}),
          },
        ]
      : [];
  });
  const humans: MentionCandidate[] = people
    ? people.flatMap((p): MentionCandidate[] =>
        p.role === undefined
          ? []
          : [
              {
                id: `u:${p.id}`,
                label: p.handle,
                name: p.displayName,
                kind: "user",
                aliases: [],
                enabled: true,
              },
            ],
      )
    : me
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
  return [...channelAgents, ...humans];
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
