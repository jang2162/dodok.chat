import { SIDEBAR_LIMITS, type SidebarSection } from "@dodok/shared";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChannels } from "@/api/queries";
import { isChannelArchived } from "@/features/channels/archived";
import { ChannelLink } from "@/features/channels/ChannelList";
import { DirectRow } from "@/features/directs/DirectRow";
import { directTitle, dmEntryChannelId, mergeDmEntries, useDirects } from "@/features/directs/queries";
import { DmLink } from "@/features/dms/DmSection";
import { useDms } from "@/features/dms/queries";
import { useUnread } from "@/features/reads/useUnread";
import { Button } from "@/ui/button";
import { addSection } from "./layout";
import { newSectionId, SidebarRow } from "./MoveToSectionMenu";
import { useSidebarLayout, useUpdateSidebar } from "./queries";
import { SectionHeader, SectionNameDialog } from "./SectionHeader";

/** 섹션에 그릴 수 있는 한 줄 — 지금 목록(살아 있는 채널·내 DM)에 있는 것만 */
export type SidebarItem = { id: string; label: string; node: ReactNode };

/**
 * 채널 id → 사이드바 한 줄. 보관한 채널·지금 읽을 수 없는 채널·아직 목록을 못 받은 것은 없다 — 배치에는 남아 있다가 되살아나면
 * 그 자리로 돌아온다(B7). DM 은 글이 없어도 그린다: 섹션에 넣은 것은 사람이 고른 것이다
 */
export function useSidebarItems(onNavigate?: () => void): Map<string, SidebarItem> {
  const channels = useChannels().data;
  const dms = useDms().data;
  const directs = useDirects().data;
  const items = new Map<string, SidebarItem>();
  for (const channel of channels ?? []) {
    if (isChannelArchived(channel)) continue;
    items.set(channel.id, {
      id: channel.id,
      label: channel.name,
      node: <ChannelLink channel={channel} onNavigate={onNavigate} />,
    });
  }
  for (const e of mergeDmEntries(dms, directs)) {
    const id = dmEntryChannelId(e);
    items.set(
      id,
      e.kind === "dm"
        ? { id, label: e.dm.agent.name, node: <DmLink dm={e.dm} onNavigate={onNavigate} /> }
        : {
            id,
            label: directTitle(e.direct),
            node: <DirectRow direct={e.direct} onNavigate={onNavigate} />,
          },
    );
  }
  return items;
}

/** 그 채널들 가운데 안 읽은 것이 있는가 — 현황을 받기 전·끊긴 동안은 false(채널 줄과 같은 규칙) */
function useAnyUnread(channelIds: readonly string[]): boolean {
  return useUnread(
    useShallow((s) => {
      if (!s.ready || channelIds.length === 0) return false;
      const ids = new Set(channelIds);
      return Object.values(s.byConversation).some((e) => e.unread && ids.has(e.channelId));
    }),
  );
}

/**
 * 개인 섹션들(사이드바 섹션 스펙 5장 「웹」) — 기본 두 절(「채널」·「다이렉트 메시지」) 위에 배치 순서대로. 한 줄은 기본 절과 같은
 * 링크 컴포넌트라 읽지 않음·접속 점이 같게 보인다. 배치를 못 받았으면 아무것도 그리지 않는다(기본 절이 전부를 보인다)
 */
export function SidebarSections({ onNavigate }: { onNavigate?: () => void }) {
  const layout = useSidebarLayout().data;
  const items = useSidebarItems(onNavigate);
  if (!layout || layout.sections.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {layout.sections.map((section, index) => (
        <SectionBlock
          key={section.id}
          section={section}
          index={index}
          count={layout.sections.length}
          items={section.items.flatMap((id) => {
            const item = items.get(id);
            return item ? [item] : [];
          })}
        />
      ))}
    </div>
  );
}

function SectionBlock({
  section,
  index,
  count,
  items,
}: {
  section: SidebarSection;
  index: number;
  count: number;
  items: SidebarItem[];
}) {
  const listId = useId();
  const unread = useAnyUnread(items.map((i) => i.id));
  return (
    <nav aria-label={section.name} className="flex flex-col gap-1">
      <SectionHeader section={section} index={index} count={count} unread={unread} listId={listId} />
      {!section.collapsed && (
        <ul id={listId} className="flex flex-col gap-0.5">
          {items.map((item) => (
            <li key={item.id}>
              <SidebarRow itemId={item.id} label={item.label}>
                {item.node}
              </SidebarRow>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

/** 「＋ 섹션 만들기」 — 맨 아래에 빈 섹션. 배치를 못 받았거나 50개면 누를 수 없다(B8) */
export function CreateSectionButton() {
  const layout = useSidebarLayout().data;
  const update = useUpdateSidebar();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={!layout || layout.sections.length >= SIDEBAR_LIMITS.sections}
        onClick={() => setOpen(true)}
        className="justify-start px-2 font-normal text-muted-foreground"
      >
        <PlusIcon />
        섹션 만들기
      </Button>
      <SectionNameDialog
        open={open}
        onOpenChange={setOpen}
        title="새 섹션"
        submitLabel="만들기"
        onSubmit={(name) => update((l) => addSection(l, name, newSectionId()))}
      />
    </>
  );
}
