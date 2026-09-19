import { Link, Outlet, useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { ApiRequestError, NetworkError } from "@/api/http";
import { useChannel } from "@/api/queries";
import { ChannelHeader } from "@/app/layout/ChannelHeader";
import { OpenSidebarButton, useOpenSidebar } from "@/app/layout/sidebarSheet";
import { Composer } from "@/features/composer/Composer";
import { TypingIndicator } from "@/features/composer/TypingIndicator";
import { useSendMessage } from "@/features/composer/useSendMessage";
import { useChannelSubscription } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";
import { type PendingActions, PendingActionsContext } from "./pendingActions";

/**
 * 채널 화면: 헤더 · 메시지 목록 자리(태스크 7) · 작성기 자리(태스크 9) · 오른쪽 `<Outlet/>`(설정 패널, 태스크 11).
 * 채널이 확인되기 전(목록의 자리값 포함)에는 그 안을 그리지 않는다 — 없는 채널에서 멤버·메시지 조회가 나가
 * 전역 토스트가 화면 안 문구와 겹치지 않게. 불러오지 못하면(없는 채널 등) 화면 안에 알린다(`useChannel` 은 silent)
 */
export function ChannelPage() {
  // 라우트 id 문자열에 기대지 않는다(레이아웃 id 가 바뀌어도 안전)
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  useChannelSubscription(channelId);
  const channel = useChannel(channelId);
  const { retry, discard } = useSendMessage(channelId);
  // 보내는 중 항목의 「다시 보내기」·「삭제」(태스크 7 PendingItem 이 읽는다). 실패는 항목 상태(failed)로 보인다
  const pendingActions = useMemo<PendingActions>(
    () => ({ retry: (id) => void retry(id).catch(() => undefined), discard }),
    [retry, discard],
  );

  if (!channel.data) {
    return (
      <div data-testid="page-channel" className="flex min-h-0 flex-1 flex-col">
        {channel.isError ? (
          <ChannelUnavailable
            error={channel.error}
            retrying={channel.isFetching}
            onRetry={() => void channel.refetch()}
          />
        ) : (
          <ChannelLoading />
        )}
      </div>
    );
  }
  return (
    <div data-testid="page-channel" className="flex min-h-0 flex-1">
      <PendingActionsContext.Provider value={pendingActions}>
        <section className="flex min-w-0 flex-1 flex-col">
          <ChannelHeader channelId={channelId} />
          <div data-slot="messages" className="min-h-0 flex-1" />
          <div data-slot="composer">
            <TypingIndicator channelId={channelId} />
            <Composer channelId={channelId} />
          </div>
        </section>
      </PendingActionsContext.Provider>
      <Outlet />
    </div>
  );
}

function ChannelLoading() {
  return (
    <>
      <div className="flex h-14 shrink-0 items-center border-b px-2">
        <OpenSidebarButton />
      </div>
      <p role="status" className="p-6 text-sm text-muted-foreground">
        불러오는 중…
      </p>
    </>
  );
}

/** 주소의 id 가 틀렸거나(VALIDATION) 없는 채널(404)이면 「찾을 수 없음」, 그 밖은 원인과 「다시 시도」 */
function ChannelUnavailable({
  error,
  retrying,
  onRetry,
}: {
  error: Error;
  retrying: boolean;
  onRetry: () => void;
}) {
  const openSidebar = useOpenSidebar();
  const notFound = error instanceof ApiRequestError && (error.status === 404 || error.code === "VALIDATION");
  const cause = error instanceof NetworkError || error instanceof ApiRequestError ? error.message : undefined;
  return (
    <>
      {openSidebar && (
        <div className="flex h-14 shrink-0 items-center px-2">
          <OpenSidebarButton />
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        {notFound ? (
          <>
            <h1 className="text-lg font-semibold">채널을 찾을 수 없습니다</h1>
            <p className="text-sm text-muted-foreground">삭제되었거나 주소가 잘못되었습니다.</p>
            <Button asChild variant="outline" size="sm">
              <Link to="/">첫 화면으로</Link>
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">채널을 불러오지 못했습니다</h1>
            {cause && <p className="text-sm text-muted-foreground">{cause}</p>}
            <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
              다시 시도
            </Button>
          </>
        )}
      </div>
    </>
  );
}
