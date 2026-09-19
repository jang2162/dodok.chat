import type { Agent } from "@dodok/shared";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { HashIcon, SettingsIcon } from "lucide-react";
import { useAgents, useChannel, useMembers } from "@/api/queries";
import { agentColorVar } from "@/theme/agentColor";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { OpenSidebarButton } from "./sidebarSheet";

/** 헤더에 보이는 에이전트 아바타 수 — 넘치면 「+N」 */
const MAX_AVATARS = 4;

/**
 * 채널 헤더(스펙 2.4): 이름·주제, 참여 에이전트 아바타 묶음(테두리 에이전트 색, 스펙 7.2), 설정 패널 여닫기.
 * 좁은 화면이면 왼쪽에 「채널 목록 열기」
 */
export function ChannelHeader({ channelId }: { channelId: string }) {
  const channel = useChannel(channelId);
  const members = useMembers(channelId);
  const agents = useAgents();
  const matchRoute = useMatchRoute();
  const settingsOpen = Boolean(matchRoute({ to: "/c/$channelId/settings", params: { channelId } }));

  const byId = new Map((agents.data ?? []).map((a) => [a.id, a]));
  const channelAgents = (members.data ?? []).flatMap((m): Agent[] => {
    const agent = m.memberType === "agent" ? byId.get(m.memberId) : undefined;
    return agent ? [agent] : [];
  });
  const shown = channelAgents.slice(0, MAX_AVATARS);
  const hidden = channelAgents.length - shown.length;

  return (
    <header data-testid="channel-header" className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <OpenSidebarButton />
      <div className="min-w-0 flex-1">
        <h1 className="flex items-center gap-1 text-base font-semibold">
          <HashIcon className="size-4 shrink-0 opacity-60" aria-hidden />
          <span className="truncate">{channel.data?.name}</span>
        </h1>
        {channel.data?.topic && (
          <p className="truncate text-xs text-muted-foreground">{channel.data.topic}</p>
        )}
      </div>
      {shown.length > 0 && (
        <AvatarGroup role="group" aria-label="참여 에이전트">
          {shown.map((agent) => (
            <Avatar
              key={agent.id}
              size="sm"
              role="img"
              aria-label={`@${agent.handle}`}
              title={`${agent.name} (@${agent.handle})`}
              className="border-2"
              style={{ borderColor: agentColorVar(agent.handle) }}
            >
              {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt="" />}
              <AvatarFallback className="text-[10px]">{agent.name.slice(0, 1)}</AvatarFallback>
            </Avatar>
          ))}
          {hidden > 0 && (
            <AvatarGroupCount className="size-6 text-xs" aria-label={`에이전트 ${hidden}명 더`}>
              +{hidden}
            </AvatarGroupCount>
          )}
        </AvatarGroup>
      )}
      <Button asChild variant="ghost" size="icon-sm">
        <Link
          to={settingsOpen ? "/c/$channelId" : "/c/$channelId/settings"}
          params={{ channelId }}
          activeOptions={{ exact: true }}
          aria-label="채널 설정"
          aria-expanded={settingsOpen}
        >
          <SettingsIcon />
        </Link>
      </Button>
    </header>
  );
}
