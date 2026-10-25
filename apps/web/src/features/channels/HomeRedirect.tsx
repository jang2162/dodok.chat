import type { Channel } from "@dodok/shared";
import { Navigate } from "@tanstack/react-router";
import { useRef } from "react";
import { useChannels } from "@/api/queries";
import { OpenSidebarButton, useOpenSidebar } from "@/app/layout/sidebarSheet";
import { Button } from "@/ui/button";
import { CreateChannelDialog } from "./CreateChannelDialog";

/**
 * `/`(스펙 2.3): 채널이 있으면 첫 채널로 바꿔 가고(replace — 뒤로 가기가 `/` 에 걸리지 않게), 없으면 빈 상태.
 * 판단은 들어올 때 받은 목록으로 한 번만 한다(`useLandingFirstChannel`).
 * 조회 실패의 원인은 전역 토스트가 알린다 — 여기는 상태와 「다시 시도」만
 */
export function HomeRedirect() {
  const channels = useChannels();
  const openSidebar = useOpenSidebar();
  const first = useLandingFirstChannel(channels.data);
  if (first) return <Navigate to="/c/$channelId" params={{ channelId: first }} replace />;

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

/**
 * 「이 화면에 들어왔을 때의 첫 채널」. 목록을 처음 받은 순간으로 판단을 잠근다 — 머무는 동안 목록에 채널이
 * 늘어도(여기 「채널 만들기」·다른 탭) 다시 이동을 쏘지 않는다. 쏘면 대화상자가 보낸 `/c/<id>/s/new/settings` 를
 * 덮어 첫 채널을 만든 사람이 설정 패널에 닿지 못한다(브라우저 검증 결함 1 — 라우트가 조각을 기다리는
 * 실물에서 이 이동이 늦게 이겼다). `/` 는 들어올 때 한 번 보내는 자리지 목록을 따라다니는 자리가 아니다
 */
function useLandingFirstChannel(channels: Channel[] | undefined): string | undefined {
  // 렌더 중에 한 번만 채우는 자물쇠 — 같은 입력에 같은 결과라 StrictMode 의 두 번 렌더에도 안전하다
  const landed = useRef<{ firstId?: string }>(undefined);
  if (!landed.current && channels) landed.current = { firstId: channels[0]?.id };
  return landed.current?.firstId;
}
