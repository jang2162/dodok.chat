import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useAgents, useChannel, useMembers } from "@/api/queries";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { Button } from "@/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { BasicSection } from "./BasicSection";
import { MembersSection, agentMembers } from "./MembersSection";
import { PromptSection } from "./PromptSection";
import { RelayPolicySection } from "./RelayPolicySection";

/**
 * 채널 설정 패널(`/c/$channelId/settings`, 스펙 6.3·6.4). 넓은 화면은 오른쪽 360px, 좁은 화면(`useIsNarrow`)은
 * 전체 화면 시트(스펙 2.4). 닫으면 `/c/$channelId`. ChannelPage 가 채널을 확인한 뒤에만 마운트된다.
 *
 * 폭이 바뀌면 담는 그릇(aside ↔ 시트)이 바뀌지만 내용은 **같은 자리에서 한 번만** 그린다 —
 * 늘 같은 `host` div 로 포털을 보내고, 그릇이 그 div 를 제 안으로 옮겨 붙인다. 그릇을 갈아 끼울 때 안쪽이
 * 다시 마운트되면 고치던 초안이 사라진다(web-t11 리뷰 Minor 7)
 */
export function ChannelSettingsPanel() {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  const narrow = useIsNarrow();
  const navigate = useNavigate();
  const titleId = useId();
  const [host] = useState(() => document.createElement("div"));
  // 지금 그릇의 자리 — 붙을 때마다 host 를 그 안으로 옮긴다
  const slot = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && host.parentElement !== el) el.appendChild(host);
    },
    [host],
  );
  // 채널을 옮겨도(뒤로 가기 등) 이 라우트 컴포넌트는 남는다 — 안쪽을 채널마다 새로 그려 초안과 열린 대화상자
  // (되돌릴 수 없는 「새 대화」·제거 확인)가 옮겨 간 채널로 넘어가지 않게 한다
  const body = createPortal(<SettingsBody key={channelId} channelId={channelId} />, host);

  if (narrow) {
    return (
      <>
        {body}
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) void navigate({ to: "/c/$channelId", params: { channelId } });
          }}
        >
          <SheetContent
            side="right"
            data-testid="page-channel-settings"
            aria-describedby={undefined}
            className="w-full gap-0 p-0 sm:max-w-none"
          >
            <div className="flex h-14 shrink-0 items-center border-b px-4 pr-12">
              <SheetTitle>채널 설정</SheetTitle>
            </div>
            <div ref={slot} className="min-h-0 flex-1 overflow-y-auto" />
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <>
      {body}
      <aside
        data-testid="page-channel-settings"
        aria-labelledby={titleId}
        className="flex w-[360px] shrink-0 flex-col border-l"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
          <h2 id={titleId} className="font-semibold">
            채널 설정
          </h2>
          <Button asChild variant="ghost" size="icon-sm">
            <Link to="/c/$channelId" params={{ channelId }} aria-label="설정 닫기">
              <XIcon />
            </Link>
          </Button>
        </div>
        <div ref={slot} className="min-h-0 flex-1 overflow-y-auto" />
      </aside>
    </>
  );
}

/**
 * 섹션들. `["channel", id]` 는 `useChannel` 로만 읽는다(다른 관찰자는 silent 를 풀어 버린다).
 * 채널 목록의 자리값(isPlaceholderData)으로는 폼을 그리지 않는다 — 상세를 받은 뒤에
 */
function SettingsBody({ channelId }: { channelId: string }) {
  const channel = useChannel(channelId);
  const members = useMembers(channelId);
  const agents = useAgents();

  if (!channel.data || channel.isPlaceholderData) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  }
  return (
    <div className="flex flex-col divide-y">
      <BasicSection channel={channel.data} />
      <PromptSection channel={channel.data} />
      <RelayPolicySection
        channel={channel.data}
        agents={agentMembers(members.data, agents.data).map((r) => r.agent)}
      />
      <MembersSection
        channelId={channelId}
        members={members.data}
        agents={agents.data}
        loadError={members.isError}
        onRetry={() => void members.refetch()}
        agentsError={agents.isError}
        onRetryAgents={() => void agents.refetch()}
      />
    </div>
  );
}
