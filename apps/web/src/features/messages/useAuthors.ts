import type { Message } from "@dodok/shared";
import { useCallback, useMemo } from "react";
import { useAgents, useMe } from "@/api/queries";
import { agentColorVar } from "@/theme/agentColor";

/** 작성자 표시(스펙 4.1·5.3). 에이전트면 `colorVar`(아바타 테두리·멘션 점) */
export type Author = {
  name: string;
  handle?: string;
  isAgent: boolean;
  colorVar?: string;
  avatarUrl?: string;
};

export const UNKNOWN_NAME = "알 수 없음";
const SYSTEM: Author = { name: "시스템", isAgent: false };

/**
 * 작성자·멘션을 `["agents"]` 와 `["me"]` 로 푼다 — MVP 사람은 owner 한 명뿐이다.
 * 모르는 작성자(지워진 에이전트·다른 사람)는 「알 수 없음」
 */
export function useAuthors(): {
  author(m: Pick<Message, "authorType" | "authorId">): Author;
  mention(kind: "a" | "u", id: string): string | undefined;
} {
  const me = useMe().data?.user;
  const agents = useAgents().data;
  const agentById = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);

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
        };
      }
      if (!me || m.authorId !== me.id) return { name: UNKNOWN_NAME, isAgent: false };
      return {
        name: me.displayName ?? me.handle,
        handle: me.handle,
        isAgent: false,
        ...(me.avatarUrl ? { avatarUrl: me.avatarUrl } : {}),
      };
    },
    [agentById, me],
  );

  const mention = useCallback(
    (kind: "a" | "u", id: string): string | undefined =>
      kind === "a" ? agentById.get(id)?.handle : me?.id === id ? me.handle : undefined,
    [agentById, me],
  );

  return useMemo(() => ({ author, mention }), [author, mention]);
}
