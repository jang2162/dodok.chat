import { useQuery } from "@tanstack/react-query";
import { Navigate, useParams } from "@tanstack/react-router";
import { conversationsQuery } from "@/api/queries";
import { ChannelLoading, ChannelUnavailable } from "./ChannelStatus";
import { NEW_CONVERSATION } from "./timeline";

type Tail = "settings" | "activity";

/**
 * 채널 주소(`/c/<채널>`·세션 전의 `/c/<채널>/settings`·`activity`)의 화면 — 넘기기는 라우트가 그리기 전에 한다(app/router `toLatestSession`).
 * 여기가 그려지는 것은 그때 세션 목록을 받지 못했을 때다: 없는 채널이면 채널 화면과 같은 안내, 그 밖은 원인과 「다시 시도」. 다시 받아
 * 오면 그때 넘긴다(목록 REST 는 최근 활동순 — 열린 세션이 없으면 새 세션 창)
 */
function Redirect({ tail }: { tail?: Tail }) {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  const list = useQuery({ ...conversationsQuery(channelId, "open"), refetchOnMount: "always" });
  if (list.isFetchedAfterMount && list.data) {
    const conversationId = list.data.conversations[0]?.id ?? NEW_CONVERSATION;
    const params = { channelId, conversationId };
    if (tail === "settings")
      return <Navigate to="/c/$channelId/s/$conversationId/settings" params={params} replace />;
    if (tail === "activity")
      return <Navigate to="/c/$channelId/s/$conversationId/activity" params={params} replace />;
    return <Navigate to="/c/$channelId/s/$conversationId" params={params} replace />;
  }
  return (
    <div data-testid="page-channel" className="flex min-h-0 flex-1 flex-col">
      {list.isError ? (
        <ChannelUnavailable
          error={list.error}
          retrying={list.isFetching}
          onRetry={() => void list.refetch()}
        />
      ) : (
        <ChannelLoading />
      )}
    </div>
  );
}

export const ChannelRedirect = () => <Redirect />;
export const ChannelSettingsRedirect = () => <Redirect tail="settings" />;
export const ChannelActivityRedirect = () => <Redirect tail="activity" />;
