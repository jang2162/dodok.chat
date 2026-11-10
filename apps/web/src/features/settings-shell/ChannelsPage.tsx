import type { Channel } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { useArchivedChannels, useCanManage } from "@/api/queries";
import { useUnarchiveChannel } from "@/features/channels/mutations";
import { Button } from "@/ui/button";

const DAY = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" });

/** 최근 보관한 것부터 — 서버는 만든 순서로 준다 */
const byArchivedDesc = (a: Channel, b: Channel) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? "");

/**
 * 「설정 → 채널」 탭(`/settings/channels`, 채널 보관 스펙 「웹」 절) — 누구나 보는 보관한 채널 목록(이름·보관한 날·채널 열기).
 * admin 이상은 줄마다 「보관 해제」. 해제하면 응답이 캐시를 옮겨(`applyChannel`) 그 줄은 빠지고 사이드바에 돌아온다
 */
export function ChannelsPage() {
  const archived = useArchivedChannels();
  const canManage = useCanManage();
  const rows = archived.data ? [...archived.data].sort(byArchivedDesc) : undefined;
  return (
    <section data-testid="page-channels" className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">채널</h1>
      </header>
      {!rows ? (
        archived.isError ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>목록을 불러오지 못했습니다</span>
            <Button
              variant="outline"
              size="sm"
              disabled={archived.isFetching}
              onClick={() => void archived.refetch()}
            >
              다시 시도
            </Button>
          </div>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            불러오는 중…
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">보관된 채널이 없습니다</p>
      ) : (
        <ul aria-label="보관한 채널" className="flex flex-col divide-y rounded-md border">
          {rows.map((channel) => (
            <ArchivedRow key={channel.id} channel={channel} canManage={canManage} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ArchivedRow({ channel, canManage }: { channel: Channel; canManage: boolean }) {
  const unarchive = useUnarchiveChannel(channel.id);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <Link
          to="/c/$channelId"
          params={{ channelId: channel.id }}
          className="truncate text-sm font-medium hover:underline"
        >
          #{channel.name}
        </Link>
        {channel.archivedAt && (
          <span className="text-xs text-muted-foreground">
            <time dateTime={channel.archivedAt}>{DAY.format(new Date(channel.archivedAt))}</time> 보관
          </span>
        )}
      </div>
      {canManage && (
        <Button
          variant="outline"
          size="sm"
          aria-label={`#${channel.name} 보관 해제`}
          disabled={unarchive.isPending}
          onClick={() => void unarchive.run()}
        >
          보관 해제
        </Button>
      )}
    </li>
  );
}
