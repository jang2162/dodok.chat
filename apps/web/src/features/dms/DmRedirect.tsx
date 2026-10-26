import type { Channel } from "@dodok/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { ApiRequestError, NetworkError } from "@/api/http";
import { qk } from "@/api/queries";
import { OpenSidebarButton } from "@/app/layout/sidebarSheet";
import { ChannelLoading } from "@/features/messages/ChannelStatus";
import { Button } from "@/ui/button";
import { invalidateDms, openDmQuery } from "./queries";

/**
 * `/dm/<에이전트 id>` — 그 에이전트와의 DM 채널을 찾거나 만들어(`POST /dms`) 그 채널 주소로 넘긴다(에이전트 DM 계획 판정 PD2). 그 뒤는 채널
 * 주소의 넘김(최근 세션, 세션이 없으면 새 세션 창) 그대로다. 기록을 바꿔 쓴다 — 뒤로 가기가 이 주소로 돌아와 다시 넘겨지지 않게.
 * 고르기 대화상자와 에이전트 설정의 「DM 보내기」가 이리로 온다. 열 수 없으면(허용 범위 밖·보관·꺼짐 403, 없는 에이전트 404) 그 사정을 그린다
 */
export function DmRedirect() {
  const { agentId } = useParams({ strict: false }) as { agentId: string };
  const qc = useQueryClient();
  const open = useQuery(openDmQuery(agentId));
  const channel = open.data;
  useEffect(() => {
    if (!channel) return;
    // 채널 화면이 상세를 다시 묻지 않게 응답을 넣어 두고, 사이드바가 「지금 연 DM」을 그리게 DM 목록을 다시 받는다
    qc.setQueryData<Channel>(qk.channel(channel.id), channel);
    void invalidateDms(qc);
  }, [qc, channel]);
  if (channel) return <Navigate to="/c/$channelId" params={{ channelId: channel.id }} replace />;
  return (
    <div data-testid="page-dm-open" className="flex min-h-0 flex-1 flex-col">
      {open.isError ? (
        <DmUnavailable error={open.error} retrying={open.isFetching} onRetry={() => void open.refetch()} />
      ) : (
        <ChannelLoading />
      )}
    </div>
  );
}

function DmUnavailable({
  error,
  retrying,
  onRetry,
}: {
  error: Error;
  retrying: boolean;
  onRetry: () => void;
}) {
  const status = error instanceof ApiRequestError ? error.status : undefined;
  const cause = error instanceof NetworkError || error instanceof ApiRequestError ? error.message : undefined;
  return (
    <>
      <div className="flex h-14 shrink-0 items-center px-2">
        <OpenSidebarButton />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        {status === 403 ? (
          <>
            <h1 className="text-lg font-semibold">이 에이전트와 DM 을 열 수 없습니다</h1>
            <p className="text-sm text-muted-foreground">DM 이 허용되지 않았거나 보관·꺼진 에이전트입니다.</p>
          </>
        ) : status === 404 || (error instanceof ApiRequestError && error.code === "VALIDATION") ? (
          <h1 className="text-lg font-semibold">에이전트를 찾을 수 없습니다</h1>
        ) : (
          <>
            <h1 className="text-lg font-semibold">DM 을 열지 못했습니다</h1>
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
