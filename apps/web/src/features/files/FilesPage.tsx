import type { FileListItem } from "@dodok/shared";
import { useCallback, useMemo } from "react";
import { useAgents, useChannels, usePeople } from "@/api/queries";
import { OpenSidebarButton } from "@/app/layout/sidebarSheet";
import { useDirects } from "@/features/directs/queries";
import { useDms } from "@/features/dms/queries";
import { useConversationNames } from "@/features/search/conversationNames";
import { type AuthorOption, type ConversationOption, FilesView } from "./FilesView";

/**
 * 사이드바 「파일」 전체 화면(`/files` — 파일함 스펙 「어디서 여나」) — 내가 읽을 수 있는 모든 대화의 사진·파일. 대화 고르기는 웹 캐시의
 * 채널·DM 목록, 올린 사람 후보는 워크스페이스의 사람·에이전트. 줄의 「어디」는 채널이면 「#채널 · 세션」, DM 이면 「DM · 이름」
 * (보관한 채널 줄도 있으니 보관 목록까지 찾는다)
 */
export function FilesPage() {
  const nameOf = useConversationNames({ includeArchived: true });
  const channels = useChannels().data;
  const dms = useDms().data;
  const directs = useDirects().data;
  const people = usePeople().data;
  const agents = useAgents().data;
  const dmIds = useMemo(
    () => new Set([...(dms ?? []).map((d) => d.channel.id), ...(directs ?? []).map((d) => d.channel.id)]),
    [dms, directs],
  );
  const conversations = useMemo<ConversationOption[]>(
    () =>
      [...(channels ?? []).map((c) => c.id), ...dmIds].flatMap((id) => {
        const name = nameOf(id);
        return name ? [{ id, name }] : [];
      }),
    [channels, dmIds, nameOf],
  );
  const authors = useMemo<AuthorOption[]>(
    () => [
      ...(people ?? []).map((p): AuthorOption => ({ type: "user", id: p.id })),
      ...(agents ?? []).map((a): AuthorOption => ({ type: "agent", id: a.id })),
    ],
    [people, agents],
  );
  const where = useCallback(
    (item: FileListItem) => {
      const name = nameOf(item.channelId) ?? "#알 수 없는 채널";
      return dmIds.has(item.channelId) ? name : `${name} · ${item.conversationTitle}`;
    },
    [nameOf, dmIds],
  );
  return (
    <div data-testid="page-files" className="flex flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <OpenSidebarButton />
        <h1 className="text-base font-semibold">파일</h1>
      </header>
      <FilesView authors={authors} conversations={conversations} where={where} wide />
    </div>
  );
}
