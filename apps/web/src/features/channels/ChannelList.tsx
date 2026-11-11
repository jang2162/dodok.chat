import type { Channel } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { HashIcon } from "lucide-react";
import { useChannels } from "@/api/queries";
import { MENTIONS_MAX, useChannelUnread } from "@/features/reads/useUnread";
import { sectionedIds } from "@/features/sidebar/layout";
import { SidebarRow } from "@/features/sidebar/MoveToSectionMenu";
import { useSidebarLayout } from "@/features/sidebar/queries";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { isChannelArchived } from "./archived";

/**
 * 사이드바 채널 목록(스펙 2.4) — 보관한 채널은 없다(「설정 → 채널」 탭에 있다). 지금 채널은 Link 가 `aria-current="page"` 로 표시한다 — 앞머리 일치라 설정 패널이 열려 있어도.
 * 조회 실패의 원인은 전역 토스트가 알린다 — 여기는 상태와 「다시 시도」만. 개인 섹션에 든 채널은 여기서 빠진다(사이드바 섹션 스펙 B3) —
 * 섹션에서 빼면 지금 순서 자리로 돌아온다
 */
export function ChannelList({ onNavigate }: { onNavigate?: () => void }) {
  const channels = useChannels();
  const layout = useSidebarLayout().data;

  if (!channels.data) {
    return channels.isError ? (
      <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground">
        <span>목록을 불러오지 못했습니다</span>
        <Button
          variant="ghost"
          size="xs"
          disabled={channels.isFetching}
          onClick={() => void channels.refetch()}
        >
          다시 시도
        </Button>
      </div>
    ) : (
      <p className="px-2 py-1 text-xs text-muted-foreground">불러오는 중…</p>
    );
  }
  // 서버 목록은 살아 있는 채널만 준다 — 다른 탭의 보관이 캐시에 늦게 닿는 틈에도 남지 않게 한 번 더 거른다
  const live = channels.data.filter((c) => !isChannelArchived(c));
  if (live.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">아직 채널이 없습니다</p>;
  }
  const sectioned = layout ? sectionedIds(layout) : new Set<string>();
  return (
    <ul className="flex flex-col gap-0.5">
      {live
        .filter((channel) => !sectioned.has(channel.id))
        .map((channel) => (
          <li key={channel.id}>
            <SidebarRow itemId={channel.id} label={channel.name}>
              <ChannelLink channel={channel} onNavigate={onNavigate} />
            </SidebarRow>
          </li>
        ))}
    </ul>
  );
}

/**
 * 채널 한 줄 — 안 읽은 남의 글이 있으면 이름을 굵게, 나를 멘션한 수를 배지로(읽지 않음 스펙 「웹」 장). 현황을 받기 전·끊긴
 * 동안은 둘 다 그리지 않는다(`useChannelUnread` 가 null). 보고 있는 채널은 굵게 하지 않는다 — 배지는 남긴다.
 * 배지 수는 숨기고 링크 이름에 글로 싣는다(`OpsBadge` 와 같은 방식). 개인 섹션도 이 줄을 그대로 쓴다
 */
export function ChannelLink({ channel, onNavigate }: { channel: Channel; onNavigate?: () => void }) {
  const state = useChannelUnread(channel.id);
  const mentions = state?.mentions ?? 0;
  return (
    <Link
      to="/c/$channelId"
      params={{ channelId: channel.id }}
      onClick={onNavigate}
      className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 outline-none hover:not-aria-[current=page]:bg-sidebar-accent hover:not-aria-[current=page]:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar aria-[current=page]:bg-sidebar-primary aria-[current=page]:font-medium aria-[current=page]:text-sidebar-primary-foreground"
    >
      {({ isActive }) => {
        const bold = !isActive && state?.unread === true;
        return (
          <>
            <HashIcon className="size-3.5 shrink-0 opacity-60" aria-hidden />
            <span className={cn("truncate", bold && "font-semibold text-sidebar-foreground")}>
              {channel.name}
            </span>
            {bold && <span className="sr-only"> (안 읽음)</span>}
            {mentions > 0 && (
              <>
                <span
                  data-mention-badge
                  aria-hidden
                  className="ml-auto shrink-0 rounded-full bg-destructive px-1.5 text-xs leading-5 font-medium text-white tabular-nums"
                >
                  {mentions >= MENTIONS_MAX ? `${MENTIONS_MAX}+` : mentions}
                </span>
                <span className="sr-only">
                  {mentions >= MENTIONS_MAX ? ` (멘션 ${MENTIONS_MAX}개 이상)` : ` (멘션 ${mentions}개)`}
                </span>
              </>
            )}
          </>
        );
      }}
    </Link>
  );
}
