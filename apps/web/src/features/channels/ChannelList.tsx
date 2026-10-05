import { Link } from "@tanstack/react-router";
import { HashIcon } from "lucide-react";
import { useChannels } from "@/api/queries";
import { Button } from "@/ui/button";
import { isChannelArchived } from "./archived";

/**
 * 사이드바 채널 목록(스펙 2.4) — 보관한 채널은 없다(「설정 → 채널」 탭에 있다). 지금 채널은 Link 가 `aria-current="page"` 로 표시한다 — 앞머리 일치라 설정 패널이 열려 있어도.
 * 조회 실패의 원인은 전역 토스트가 알린다 — 여기는 상태와 「다시 시도」만
 */
export function ChannelList({ onNavigate }: { onNavigate?: () => void }) {
  const channels = useChannels();

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
  return (
    <ul className="flex flex-col gap-0.5">
      {live.map((channel) => (
        <li key={channel.id}>
          <Link
            to="/c/$channelId"
            params={{ channelId: channel.id }}
            onClick={onNavigate}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 outline-none hover:not-aria-[current=page]:bg-sidebar-accent hover:not-aria-[current=page]:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar aria-[current=page]:bg-sidebar-primary aria-[current=page]:font-medium aria-[current=page]:text-sidebar-primary-foreground"
          >
            <HashIcon className="size-3.5 shrink-0 opacity-60" aria-hidden />
            <span className="truncate">{channel.name}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
