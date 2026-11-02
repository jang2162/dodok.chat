import type { Message, Person } from "@dodok/shared";
import { useCallback, useMemo } from "react";
import { useAgents, useCanManage, useMe, usePeople } from "@/api/queries";
import { isArchived } from "@/features/agents/archived";
import { useCachedAutomations } from "@/features/automations/queries";
import { isDeactivated } from "@/features/members/deactivated";
import { agentColorVar } from "@/theme/agentColor";

/**
 * 작성자 표시(스펙 4.1·5.3). 에이전트면 `colorVar`(아바타 테두리·멘션 점), 비활성 멤버면 `deactivated`(이름 옆 「비활성」),
 * 보관(삭제)한 에이전트면 `archived`(이름 옆 「삭제됨」)
 */
export type Author = {
  name: string;
  handle?: string;
  isAgent: boolean;
  colorVar?: string;
  avatarUrl?: string;
  deactivated?: boolean;
  archived?: boolean;
};

export const UNKNOWN_NAME = "알 수 없음";
const SYSTEM: Author = { name: "시스템", isAgent: false };
/** 이름을 모르는 자동화 — member(목록 API 가 403, 계획 판정 PA6)·목록을 받기 전·받은 목록이 그 글보다 앞일 때 */
const AUTOMATION: Author = { name: "⚙ 자동화", isAgent: false };
const DELETED_AUTOMATION: Author = { name: "⚙ 지운 자동화", isAgent: false };

/**
 * 작성자를 풀 글 — 자동화 글은 `createdAt` 으로 받아 둔 목록이 그 글보다 뒤인지 본다(없으면 목록이 뒤인 것으로 본다).
 * `automationName` 은 서버 하이드레이션이 자동화 글에 붙인 이름(지운 자동화면 없다 — 검색 결과 줄에도 없다)
 */
type Authored = Pick<Message, "authorType" | "authorId" | "automationName"> & { createdAt?: string };

/**
 * 작성자·멘션을 `["agents"]`·`["people"]` 로 푼다(팀 스펙 5·6장). 사람 목록을 아직 못 받았으면 나 하나는 `["me"]` 로 푼다.
 * 비활성 멤버도 목록에 남아 있어 이름·핸들 그대로 「비활성」을 단다(채널 보관·멤버 비활성화 스펙 「기록과 목록」 절) —
 * `deactivatedPerson` 이 멘션 칩의 판정.
 * 보관(삭제)한 에이전트는 목록에 남아 있어 이름·핸들 그대로 「삭제됨」을 단다(스펙 「에이전트 보관」 절) — `archivedAgent` 가 멘션 칩의 판정.
 * 모르는 작성자(목록에 없는 에이전트·사람)는 「알 수 없음」.
 * 자동화 글(자동화 스펙 「웹」 장)은 admin 이상이면 「⚙ 자동화 · <이름>」(목록 우선 — 목록을 받기 전이면 글에 실린 이름), 받은
 * 목록에 없으면 「⚙ 지운 자동화」. member 는 글에 실린 이름(`automationName`)이 있으면 「⚙ 자동화 · <이름>」, 없으면 「⚙ 자동화」.
 * 목록은 캐시만 읽는다 — 받는 것은 글을 그리는 자리의 `useLoadAutomationAuthors`
 */
export function useAuthors(): {
  author(m: Authored): Author;
  mention(kind: "a" | "u", id: string): string | undefined;
  archivedAgent(id: string): boolean;
  deactivatedPerson(id: string): boolean;
} {
  const me = useMe().data?.user;
  const agents = useAgents().data;
  const people = usePeople().data;
  const canManage = useCanManage();
  const automations = useCachedAutomations();
  const automationById = useMemo(
    () => new Map((automations.data ?? []).map((a) => [a.id, a])),
    [automations.data],
  );
  const automationsAt = automations.data === undefined ? undefined : automations.dataUpdatedAt;
  const agentById = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);
  const personById = useMemo(() => {
    const map = new Map<string, Person>((people ?? []).map((p) => [p.id, p]));
    if (me && !map.has(me.id))
      map.set(me.id, {
        id: me.id,
        handle: me.handle,
        displayName: me.displayName ?? me.handle,
        deactivatedAt: null,
        statusMessage: null,
        ...(me.avatarUrl ? { avatarUrl: me.avatarUrl } : {}),
      });
    return map;
  }, [people, me]);

  const author = useCallback(
    (m: Authored): Author => {
      if (m.authorType === "system") return SYSTEM;
      if (m.authorType === "automation") {
        const carried: Author | undefined =
          m.automationName === undefined
            ? undefined
            : { name: `⚙ 자동화 · ${m.automationName}`, isAgent: false };
        if (!canManage) return carried ?? AUTOMATION;
        const automation = m.authorId ? automationById.get(m.authorId) : undefined;
        if (automation) return { name: `⚙ 자동화 · ${automation.name}`, isAgent: false };
        const settled =
          automationsAt !== undefined &&
          (m.createdAt === undefined || automationsAt >= Date.parse(m.createdAt));
        return settled ? DELETED_AUTOMATION : (carried ?? AUTOMATION);
      }
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
      return {
        name: person.displayName || person.handle,
        handle: person.handle,
        isAgent: false,
        ...(person.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
        ...(isDeactivated(person) ? { deactivated: true } : {}),
      };
    },
    [agentById, personById, canManage, automationById, automationsAt],
  );

  const mention = useCallback(
    (kind: "a" | "u", id: string): string | undefined => {
      if (kind === "a") return agentById.get(id)?.handle;
      const person = personById.get(id);
      return person?.handle;
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

  const deactivatedPerson = useCallback(
    (id: string): boolean => {
      const person = personById.get(id);
      return person !== undefined && isDeactivated(person);
    },
    [personById],
  );

  return useMemo(
    () => ({ author, mention, archivedAgent, deactivatedPerson }),
    [author, mention, archivedAgent, deactivatedPerson],
  );
}
