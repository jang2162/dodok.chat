import type { FileListItem } from "@dodok/shared";
import { useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useChannel, useMe, useMembers } from "@/api/queries";
import { isDirectChannel, isOneStream, useDirect } from "@/features/directs/queries";
import { isDmChannel } from "@/features/dms/queries";
import { type AuthorOption, FilesView } from "./FilesView";

/**
 * 오른쪽 패널의 「파일」 탭(파일함 스펙 「어디서 여나」) — 그 대화의 사진·파일. 올린 사람 후보는 그 대화의 참여자: 일반 채널은 채널 멤버,
 * 에이전트 DM 은 나와 그 에이전트, 사람 DM·그룹 DM 은 나 + 요약의 `users`·`agents`. 줄의 「어디」는 세션 제목(한 줄기 direct 는 세션이
 * 없어 뺀다). 채널을 옮기면 `key` 가 바뀌어 거름이 초기화된다(Review Focus 5)
 */
export function FilesPanel() {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  const channel = useChannel(channelId).data;
  const me = useMe().data?.user.id;
  const dm = isDmChannel(channel);
  const directKind = isDirectChannel(channel);
  const direct = useDirect(channelId, directKind);
  const members = useMembers(channelId, { enabled: channel !== undefined && !dm && !directKind }).data;
  const authors = useMemo<AuthorOption[]>(() => {
    const mine: AuthorOption[] = me ? [{ type: "user", id: me }] : [];
    if (dm) return channel?.dmAgentId ? [...mine, { type: "agent", id: channel.dmAgentId }] : mine;
    if (directKind)
      return [
        ...mine,
        ...(direct?.users ?? []).map((u): AuthorOption => ({ type: "user", id: u.id })),
        ...(direct?.agents ?? []).map((a): AuthorOption => ({ type: "agent", id: a.id })),
      ];
    return (members ?? []).flatMap((m): AuthorOption[] =>
      m.memberType === "user" || m.memberType === "agent" ? [{ type: m.memberType, id: m.memberId }] : [],
    );
  }, [me, dm, directKind, channel?.dmAgentId, direct, members]);
  const oneStream = direct !== undefined && isOneStream(direct);
  const where = useCallback(
    (item: FileListItem) => (oneStream ? undefined : item.conversationTitle),
    [oneStream],
  );
  return <FilesView key={channelId} channelId={channelId} authors={authors} where={where} />;
}
