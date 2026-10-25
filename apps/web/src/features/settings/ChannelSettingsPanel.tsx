import { useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { useAgents, useChannel, useMembers } from "@/api/queries";
import { isChannelArchived } from "@/features/channels/archived";
import { ArchiveSection } from "./ArchiveSection";
import { BasicSection } from "./BasicSection";
import { MembersSection, agentMembers } from "./MembersSection";
import { PromptSection } from "./PromptSection";
import { RelayPolicySection } from "./RelayPolicySection";
import { SessionSection } from "./SessionSection";

/**
 * 채널 설정 패널(`/c/$channelId/s/$conversationId/settings`, 스펙 6.3·6.4) — 보관한 채널이면 편집 대신 안내만. 바깥 틀(패널 ↔ 시트·탭 머리·닫기)은 부모인
 * ChannelPage 의 `PanelTabs` 가 맡는다 — 활동 탭과 같은 자리를 나눠 쓴다(설계 5.1).
 * ChannelPage 가 채널을 확인한 뒤에만 마운트된다.
 */
export function ChannelSettingsPanel() {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  // 채널을 옮겨도(뒤로 가기 등) 이 라우트 컴포넌트는 남는다 — 안쪽을 채널마다 새로 그려 초안과 열린 대화상자
  // (제거 확인)가 옮겨 간 채널로 넘어가지 않게 한다
  return <SettingsBody key={channelId} channelId={channelId} />;
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
  if (isChannelArchived(channel.data)) return <ArchivedSettings />;
  return (
    <div className="flex flex-col divide-y">
      <BasicSection channel={channel.data} />
      <PromptSection channel={channel.data} />
      <RelayPolicySection
        channel={channel.data}
        agents={agentMembers(members.data, agents.data).map((r) => r.agent)}
      />
      <SessionSection channel={channel.data} members={members.data} />
      <MembersSection
        channelId={channelId}
        members={members.data}
        agents={agents.data}
        loadError={members.isError}
        onRetry={() => void members.refetch()}
        agentsError={agents.isError}
        onRetryAgents={() => void agents.refetch()}
      />
      <ArchiveSection channel={channel.data} />
    </div>
  );
}

/**
 * 보관한 채널의 설정 패널 — 편집 섹션을 그리지 않는다(채널 보관 스펙 「웹」 절). 「보관 해제」는 작성기 자리 하나에만 둔다.
 * 이 패널에서 보관했으면 누른 단추가 사라져 초점이 body 로 떨어진다 — 그때만 이 안내로 옮긴다(다른 탭의 보관이 초점을 뺏지 않게)
 */
function ArchivedSettings() {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) ref.current?.focus();
  }, []);
  return (
    <div data-testid="channel-settings-archived" className="px-4 py-5 text-sm text-muted-foreground">
      <p ref={ref} tabIndex={-1} className="outline-none">
        보관된 채널입니다.
      </p>
    </div>
  );
}
