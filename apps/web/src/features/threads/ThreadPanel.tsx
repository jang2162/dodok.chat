import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { ApiRequestError, NetworkError } from "@/api/http";
import { ArchivedNotice } from "@/features/channels/ArchivedNotice";
import { useChannelArchived } from "@/features/channels/archived";
import { Composer } from "@/features/composer/Composer";
import { useSendMessage } from "@/features/composer/useSendMessage";
import { MessageList } from "@/features/messages/MessageList";
import { type PendingActions, PendingActionsContext } from "@/features/messages/pendingActions";
import { StreamingBubble } from "@/features/runs/StreamingBubble";
import { useChannelBubbles } from "@/features/runs/useChannelBubbles";
import { Button } from "@/ui/button";
import { isThreadMissing, threadQuery, touchRecentThread } from "./queries";

/**
 * 스레드 패널(`/c/$channelId/t/$rootId`, 스레드·검색 스펙 4.2). 바깥 틀(넓은 화면 오른쪽 패널 ↔ 좁은 화면 전체 시트·탭 머리·
 * 닫기)은 부모인 ChannelPage 의 `PanelTabs` 가 맡는다 — 설정·활동과 같은 자리의 탭 하나다.
 * 안쪽은 스레드마다 새로 그린다 — 다른 스레드로 옮겨도 이 라우트 컴포넌트는 남는데, 스레드에 묶인 안쪽 상태가 옮겨 간
 * 스레드로 넘어가지 않게
 */
export function ThreadPanel() {
  const { channelId, rootId } = useParams({ strict: false }) as { channelId: string; rootId: string };
  return <ThreadBody key={`${channelId}:${rootId}`} channelId={channelId} rootId={rootId} />;
}

function ThreadBody({ channelId, rootId }: { channelId: string; rootId: string }) {
  const qc = useQueryClient();
  const thread = useQuery(threadQuery(qc, channelId, rootId));
  // 받은 스레드만 최근으로(오프라인 사본 대상) — 없는 루트 주소가 실제 스레드를 밀어내지 않게
  const known = thread.data !== undefined;
  useEffect(() => {
    if (known) touchRecentThread(qc, channelId, rootId);
  }, [known, qc, channelId, rootId]);

  if (!thread.data) {
    return thread.isError ? (
      <ThreadUnavailable
        channelId={channelId}
        error={thread.error}
        retrying={thread.isFetching}
        onRetry={() => void thread.refetch()}
      />
    ) : (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  }
  return <ThreadView channelId={channelId} rootId={rootId} />;
}

/**
 * 루트·답글 목록(스트리밍 버블·카드·첨부·승인 — 채널 목록과 같은 행), 스레드 작성기.
 * 보관한 채널이면 작성기 대신 안내만(채널 보관 스펙 「웹」 절)
 */
function ThreadView({ channelId, rootId }: { channelId: string; rootId: string }) {
  const archived = useChannelArchived();
  const bubbleRunIds = useChannelBubbles(channelId, rootId);
  const { retry, discard } = useSendMessage(channelId, rootId);
  // 스레드의 보내는 중 항목 — 채널 목록의 것(ChannelPage)과 따로 둔다
  const pendingActions = useMemo<PendingActions>(
    () => ({ retry: (id) => void retry(id).catch(() => undefined), discard }),
    [retry, discard],
  );
  return (
    <PendingActionsContext.Provider value={pendingActions}>
      <div data-testid="thread-panel" className="flex min-h-0 flex-1 flex-col">
        <MessageList
          channelId={channelId}
          threadRootId={rootId}
          bubbleRunIds={bubbleRunIds}
          bubbles={(runId) => <StreamingBubble runId={runId} />}
        />
        <div data-slot="composer">
          {archived ? (
            <ArchivedNotice channelId={channelId} />
          ) : (
            <Composer channelId={channelId} threadRootId={rootId} />
          )}
        </div>
      </div>
    </PendingActionsContext.Provider>
  );
}

/** 없는 루트(지운 메시지·답글 id·다른 채널)면 「찾을 수 없음」, 그 밖은 원인과 「다시 시도」 */
function ThreadUnavailable({
  channelId,
  error,
  retrying,
  onRetry,
}: {
  channelId: string;
  error: Error;
  retrying: boolean;
  onRetry: () => void;
}) {
  const cause = error instanceof NetworkError || error instanceof ApiRequestError ? error.message : undefined;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {isThreadMissing(error) ? (
        <>
          <h3 className="font-semibold">스레드를 찾을 수 없습니다</h3>
          <p className="text-sm text-muted-foreground">삭제되었거나 주소가 잘못되었습니다.</p>
          <Button asChild variant="outline" size="sm">
            <Link to="/c/$channelId" params={{ channelId }}>
              채널로 돌아가기
            </Link>
          </Button>
        </>
      ) : (
        <>
          <h3 className="font-semibold">스레드를 불러오지 못했습니다</h3>
          {cause && <p className="text-sm text-muted-foreground">{cause}</p>}
          <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
            다시 시도
          </Button>
        </>
      )}
    </div>
  );
}
