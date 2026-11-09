import { useCallback, useMemo } from "react";
import { useArchivedChannels, useChannels } from "@/api/queries";
import { directTitle, isLoneGroup, useDirects } from "@/features/directs/queries";
import { useDms } from "@/features/dms/queries";

/**
 * 대화 이름 — ⌘K 결과 줄과 파일함이 같이 쓴다(파일함 계획 판정 PF6). 채널 `#이름`, 에이전트 DM `DM · <에이전트 이름>`, 사람 DM·그룹 DM
 * `DM · <참여자 이름>`(1:1 은 상대 이름, 그룹은 나를 뺀 이름 나열 — 상대가 하나뿐인 그룹은 사이드바처럼 「 (그룹)」, `isLoneGroup`).
 * 웹 캐시에서만 찾는다 — 모르는 채널이면 undefined(부르는 쪽이 대신할 글자를 정한다). 보관한 채널은 사이드바 목록에 없어
 * `includeArchived` 일 때만 보관 목록을 받아 함께 찾는다
 */
export function useConversationNames(
  opts: { includeArchived?: boolean } = {},
): (channelId: string) => string | undefined {
  const channels = useChannels().data;
  const archived = useArchivedChannels({ enabled: opts.includeArchived === true }).data;
  const dms = useDms().data;
  const directs = useDirects().data;
  const names = useMemo(
    () =>
      new Map([
        ...[...(channels ?? []), ...(archived ?? [])].map((c): [string, string] => [c.id, `#${c.name}`]),
        ...(dms ?? []).map((d): [string, string] => [d.channel.id, `DM · ${d.agent.name}`]),
        ...(directs ?? []).map((d): [string, string] => [
          d.channel.id,
          `DM · ${directTitle(d)}${isLoneGroup(d) ? " (그룹)" : ""}`,
        ]),
      ]),
    [channels, archived, dms, directs],
  );
  return useCallback((channelId: string) => names.get(channelId), [names]);
}
