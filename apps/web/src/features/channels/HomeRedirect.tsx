import { Navigate } from "@tanstack/react-router";
import { useChannels } from "@/api/queries";
import { OpenSidebarButton, useOpenSidebar } from "@/app/layout/sidebarSheet";
import { Button } from "@/ui/button";
import { CreateChannelDialog } from "./CreateChannelDialog";

/**
 * `/`(스펙 2.3): 채널이 있으면 첫 채널로 바꿔 가고(replace — 뒤로 가기가 `/` 에 걸리지 않게), 없으면 빈 상태.
 * 조회 실패의 원인은 전역 토스트가 알린다 — 여기는 상태와 「다시 시도」만
 */
export function HomeRedirect() {
  const channels = useChannels();
  const openSidebar = useOpenSidebar();
  const first = channels.data?.[0];
  if (first) return <Navigate to="/c/$channelId" params={{ channelId: first.id }} replace />;

  let body;
  if (channels.data) {
    body = (
      <>
        <h1 className="text-lg font-semibold">채널이 없습니다</h1>
        <p className="text-sm text-muted-foreground">채널을 만들고 에이전트를 넣어 대화를 시작하세요.</p>
        <CreateChannelDialog>
          <Button>채널 만들기</Button>
        </CreateChannelDialog>
      </>
    );
  } else if (channels.isError) {
    body = (
      <>
        <p className="text-sm text-muted-foreground">채널 목록을 불러오지 못했습니다</p>
        <Button
          variant="outline"
          size="sm"
          disabled={channels.isFetching}
          onClick={() => void channels.refetch()}
        >
          다시 시도
        </Button>
      </>
    );
  } else {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  }

  return (
    <section data-testid="page-home" className="flex min-h-0 flex-1 flex-col">
      {openSidebar && (
        <div className="flex h-14 shrink-0 items-center px-2">
          <OpenSidebarButton />
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">{body}</div>
    </section>
  );
}
