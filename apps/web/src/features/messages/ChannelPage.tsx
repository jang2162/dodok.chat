import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, NetworkError } from "@/api/http";
import { useChannel } from "@/api/queries";
import { ChannelHeader } from "@/app/layout/ChannelHeader";
import { PanelTabs, usePanelTab } from "@/app/layout/PanelTabs";
import { ArchivedNotice } from "@/features/channels/ArchivedNotice";
import { ChannelArchivedContext, isChannelArchived } from "@/features/channels/archived";
import { Composer } from "@/features/composer/Composer";
import { TypingIndicator } from "@/features/composer/TypingIndicator";
import { useSendMessage } from "@/features/composer/useSendMessage";
import { captureEntryRead } from "@/features/reads/entryRead";
import { StreamingBubble } from "@/features/runs/StreamingBubble";
import { useChannelBubbles } from "@/features/runs/useChannelBubbles";
import { type ThreadOpener, ThreadOpenerContext } from "@/features/threads/threadOpener";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { touchRecentChannel, touchRecentConversation } from "@/pwa/persist";
import { useChannelSubscription } from "@/realtime/WireProvider";
import { Button } from "@/ui/button";
import { ChannelLoading, ChannelUnavailable } from "./ChannelStatus";
import { MessageList } from "./MessageList";
import { type PendingActions, PendingActionsContext } from "./pendingActions";
import { NEW_CONVERSATION } from "./timeline";
import { useTimelineState } from "./useTimeline";

/**
 * 세션 화면(`/c/<채널>/s/<대화>` — 채널 세션 계획 판정 PS6): 헤더 · 그 세션의 메시지 목록(루트만) · 작성기 · 오른쪽 패널(`PanelTabs` 틀 +
 * 탭 내용 `<Outlet/>` — 설정·활동·스레드). 채널 머리·설정·활동 패널은 채널 단위 그대로다. 새 세션 창(`NEW_CONVERSATION`)은 빈 목록에
 * 작성기만 — 첫 보내기가 세션을 만든다.
 * 채널이 확인되기 전(목록의 자리값 포함)에는 그 안을 그리지 않는다 — 없는 채널에서 멤버·메시지 조회가 나가
 * 전역 토스트가 화면 안 문구와 겹치지 않게. 불러오지 못하면(없는 채널·없는 세션 등) 화면 안에 알린다(`useChannel` 은 silent)
 */
export function ChannelPage() {
  // 라우트 id 문자열에 기대지 않는다(레이아웃 id 가 바뀌어도 안전)
  const { channelId, conversationId, rootId } = useParams({ strict: false }) as {
    channelId: string;
    conversationId: string;
    rootId?: string;
  };
  // 오른쪽 패널의 탭 머리는 여기서 그린다 — 탭을 옮겨도 머리의 링크가 죽지 않아야 초점이 살아남는다(D3)
  const tab = usePanelTab();
  // 좁은 화면에서 패널 시트는 타임라인을 통째로 덮는다 — 덮인 채널 목록은 끝이 보이는 것이 아니다(읽음을 보내지 않는다)
  const covered = useIsNarrow() && tab !== undefined;
  // 좁은 화면에서 패널은 시트로 뜬다 — 닫히면 초점을 연 자리(헤더의 설정 링크)로 돌려준다(D14)
  const settingsRef = useRef<HTMLAnchorElement>(null);
  // 칩·「스레드에서 답하기」로 연 스레드는 닫으면 그 자리로 초점을 돌려준다(p4t-c1, m5)
  const threadOpenerRef = useRef<ThreadOpener>(null);
  // 구분선의 기준을 세션에 들어갈 때 한 번 잡는다(`captureEntryRead` — 읽음 위치는 세션마다 따로). 채널·세션을 옮겨도 이 페이지는
  // 다시 마운트되지 않는다 — 그래서 첫 값만 잡지 않고 세션이 바뀌면 렌더 중에 다시 잡는다(같은 채널 안에서 옮겨도)
  const [entry, setEntry] = useState(() => ({ conversationId, seq: captureEntryRead(conversationId) }));
  if (entry.conversationId !== conversationId)
    setEntry({ conversationId, seq: captureEntryRead(conversationId) });
  const entryReadSeq = entry.conversationId === conversationId ? entry.seq : undefined;
  useChannelSubscription(channelId);
  const channel = useChannel(channelId);
  const session = useTimelineState(channelId, conversationId);
  // 확인된 채널만 최근 본 채널로(오프라인 사본 대상, 스펙 4장) — 없는 채널 주소가 실제 채널을 밀어내지 않게.
  // 세션은 받은 것만 그 채널의 마지막으로 본 세션으로(사본이 채널마다 그 세션 하나만 담는다) — 새 세션 창은 남길 것이 없다
  const qc = useQueryClient();
  const known = channel.data !== undefined;
  const sessionKnown = conversationId !== NEW_CONVERSATION && session.timeline !== undefined;
  useEffect(() => {
    if (known) touchRecentChannel(qc, channelId);
  }, [known, qc, channelId]);
  useEffect(() => {
    if (known && sessionKnown) touchRecentConversation(qc, channelId, conversationId);
  }, [known, sessionKnown, qc, channelId, conversationId]);
  const bubbleRunIds = useChannelBubbles(channelId, conversationId);
  const { retry, discard } = useSendMessage(channelId, conversationId);
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
  // 보관한 채널은 읽기만(채널 보관 스펙 「웹」 절) — 작성기 자리에 안내, 카드·스레드 패널·설정 패널은 컨텍스트로 안다.
  // 다른 탭이 보관하면 wire `channel.updated` 가 이 채널 캐시를 바꿔 같은 화면이 그대로 읽기 전용이 된다
  const archived = isChannelArchived(channel.data);
  // 세션이 없다(주소가 틀렸다·다른 워크스페이스) — 목록·작성기 대신 안내. 그 밖의 실패는 「다시 시도」
  const sessionError = session.timeline === undefined ? session.error : null;
  return (
    <div data-testid="page-channel" className="flex min-h-0 flex-1">
      <ChannelArchivedContext.Provider value={archived}>
        <PendingActionsContext.Provider value={pendingActions}>
          <ThreadOpenerContext.Provider value={threadOpenerRef}>
            <section className="flex min-w-0 flex-1 flex-col">
              <ChannelHeader
                channelId={channelId}
                conversationId={conversationId}
                settingsRef={settingsRef}
              />
              {sessionError ? (
                <ConversationUnavailable
                  channelId={channelId}
                  error={sessionError}
                  onRetry={session.refetch}
                />
              ) : (
                <>
                  <MessageList
                    channelId={channelId}
                    conversationId={conversationId}
                    covered={covered}
                    entryReadSeq={entryReadSeq}
                    bubbleRunIds={bubbleRunIds}
                    bubbles={(runId) => <StreamingBubble runId={runId} />}
                  />
                  <div data-slot="composer">
                    {archived ? (
                      <ArchivedNotice channelId={channelId} unarchive />
                    ) : (
                      <>
                        <TypingIndicator conversationId={conversationId} />
                        <Composer channelId={channelId} conversationId={conversationId} />
                      </>
                    )}
                  </div>
                </>
              )}
            </section>
          </ThreadOpenerContext.Provider>
        </PendingActionsContext.Provider>
        {tab && (
          <PanelTabs
            channelId={channelId}
            conversationId={conversationId}
            rootId={tab === "thread" ? rootId : undefined}
            active={tab}
            openerRef={settingsRef}
            threadOpenerRef={threadOpenerRef}
          >
            <Outlet />
          </PanelTabs>
        )}
      </ChannelArchivedContext.Provider>
    </div>
  );
}

/** 세션을 받지 못했다 — 없는 세션(404·주소의 id 가 UUID 가 아님)이면 「찾을 수 없음」과 채널로 가는 길, 그 밖은 원인과 「다시 시도」 */
function ConversationUnavailable({
  channelId,
  error,
  onRetry,
}: {
  channelId: string;
  error: Error;
  onRetry: () => void;
}) {
  const notFound = error instanceof ApiRequestError && (error.status === 404 || error.code === "VALIDATION");
  const cause = error instanceof NetworkError || error instanceof ApiRequestError ? error.message : undefined;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {notFound ? (
        <>
          <h2 className="text-lg font-semibold">세션을 찾을 수 없습니다</h2>
          <p className="text-sm text-muted-foreground">삭제되었거나 주소가 잘못되었습니다.</p>
          <Button asChild variant="outline" size="sm">
            <Link to="/c/$channelId" params={{ channelId }}>
              채널로 돌아가기
            </Link>
          </Button>
        </>
      ) : (
        <>
          <h2 className="text-lg font-semibold">세션을 불러오지 못했습니다</h2>
          {cause && <p className="text-sm text-muted-foreground">{cause}</p>}
          <Button variant="outline" size="sm" onClick={onRetry}>
            다시 시도
          </Button>
        </>
      )}
    </div>
  );
}
