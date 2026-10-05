import type { Message, Person } from "@dodok/shared";
import { useCallback, useMemo } from "react";
import { useAgents, useMe, usePeople } from "@/api/queries";
import { isArchived } from "@/features/agents/archived";
import { agentColorVar } from "@/theme/agentColor";

/**
 * 작성자 표시(스펙 4.1·5.3). 에이전트면 `colorVar`(아바타 테두리·멘션 점), 나간 멤버면 `left`(흐린 글씨),
 * 보관(삭제)한 에이전트면 `archived`(이름 옆 「삭제됨」)
 */
export type Author = {
  name: string;
  handle?: string;
  isAgent: boolean;
  colorVar?: string;
  avatarUrl?: string;
  left?: boolean;
  archived?: boolean;
};

export const UNKNOWN_NAME = "알 수 없음";
const SYSTEM: Author = { name: "시스템", isAgent: false };

/**
 * 작성자·멘션을 `["agents"]`·`["people"]` 로 푼다(팀 스펙 5·6장). 사람 목록을 아직 못 받았으면 나 하나는 `["me"]` 로 푼다.
 * 나간 멤버(`role` 없음)는 「나간 멤버 @<leftHandle>」, 멘션은 옛 핸들 — 지금 핸들(`left-…`)은 자리를 놓아준 값이라 보이지 않는다.
 * 보관(삭제)한 에이전트는 목록에 남아 있어 이름·핸들 그대로 「삭제됨」을 단다(스펙 「에이전트 보관」 절) — `archivedAgent` 가 멘션 칩의 판정.
 * 모르는 작성자(목록에 없는 에이전트·사람)는 「알 수 없음」
 */
export function useAuthors(): {
  author(m: Pick<Message, "authorType" | "authorId">): Author;
  mention(kind: "a" | "u", id: string): string | undefined;
  archivedAgent(id: string): boolean;
} {
  const me = useMe().data?.user;
  const agents = useAgents().data;
  const people = usePeople().data;
  const agentById = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);
  const personById = useMemo(() => {
    const map = new Map<string, Person>((people ?? []).map((p) => [p.id, p]));
    if (me && !map.has(me.id))
      map.set(me.id, {
        id: me.id,
        handle: me.handle,
        displayName: me.displayName ?? me.handle,
        ...(me.avatarUrl ? { avatarUrl: me.avatarUrl } : {}),
      });
    return map;
  }, [people, me]);

  const author = useCallback(
    (m: Pick<Message, "authorType" | "authorId">): Author => {
      if (m.authorType === "system") return SYSTEM;
      if (m.authorType === "agent") {
        const agent = m.authorId ? agentById.get(m.authorId) : undefined;
        if (!agent) return { name: UNKNOWN_NAME, isAgent: true };
        return {
          name: agent.name,
          handle: agent.handle,
          isAgent: true,
          colorVar: agentColorVar(agent.handle),
          ...(agent.avatarUrl ? { avatarUrl: agent.avatarUrl } : {}),
          ...(isArchived(agent) ? { archived: true } : {}),
        };
      }
      const person = m.authorId ? personById.get(m.authorId) : undefined;
      if (!person) return { name: UNKNOWN_NAME, isAgent: false };
      if (person.leftHandle)
        return {
          name: `나간 멤버 @${person.leftHandle}`,
          handle: person.leftHandle,
          isAgent: false,
          left: true,
        };
      return {
        name: person.displayName || person.handle,
        handle: person.handle,
        isAgent: false,
        ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
      };
    },
    [agentById, personById],
  );

  const mention = useCallback(
    (kind: "a" | "u", id: string): string | undefined => {
      if (kind === "a") return agentById.get(id)?.handle;
      const person = personById.get(id);
      return person?.leftHandle ?? person?.handle;
    },
    [agentById, personById],
  );

  const archivedAgent = useCallback(
    (id: string): boolean => {
      const agent = agentById.get(id);
      return agent !== undefined && isArchived(agent);
    },
    [agentById],
  );

  return useMemo(() => ({ author, mention, archivedAgent }), [author, mention, archivedAgent]);
}
