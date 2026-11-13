import { type Agent, roleAtLeast } from "@dodok/shared";
import { Link, useMatchRoute } from "@tanstack/react-router";
import { HashIcon, ListIcon, SettingsIcon, SquarePenIcon } from "lucide-react";
import type { RefObject } from "react";
import { useAgents, useChannel, useMembers, useRole } from "@/api/queries";
import { isArchived } from "@/features/agents/archived";
import { isChannelArchived } from "@/features/channels/archived";
import { CloseConversationButton, ConversationTitle } from "@/features/conversations/ConversationTitle";
import { InviteAgentDialog } from "@/features/conversations/InviteAgentDialog";
import { useRemoveInvitedAgent, useSessionInvitedAgents } from "@/features/conversations/invitedAgents";
import { useConversationPermissions } from "@/features/conversations/permissions";
import { useConversationView } from "@/features/conversations/queries";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { agentColorVar } from "@/theme/agentColor";
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from "@/ui/avatar";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { FilesTabLink } from "./PanelTabs";
import { OpenSidebarButton } from "./sidebarSheet";

/** 헤더에 보이는 에이전트 아바타 수 — 넘치면 「+N」 */
const MAX_AVATARS = 4;

/**
 * 채널 헤더(스펙 2.4): 이름(보관한 채널이면 「보관됨」), 지금 세션 제목(채널 세션 스펙 「웹」 장 — 권한이 있으면 눌러 이름 바꾸기)·주제,
 * 참여 에이전트 아바타 묶음(테두리 에이전트 색, 스펙 7.2), 「새 세션」(만들 수 있는 사람에게만)·「세션 닫기」, 설정 패널 여닫기.
 * 좁은 화면이면 왼쪽에 「채널 목록 열기」. `settingsRef` 는 그 설정 링크 — 좁은 화면 시트가 닫히면
 * 초점이 여기로 돌아온다(브라우저 검증 D14). `onToggleList` 를 주면 「세션 목록」 여닫기 단추를 그린다 — `listRef` 는 그 단추(좁은 화면
 * 시트가 닫히면 초점이 여기로 돌아온다)
 */
export function ChannelHeader({
  channelId,
  conversationId,
  settingsRef,
  listOpen = false,
  onToggleList,
  listRef,
}: {
  channelId: string;
  /** 보고 있는 세션 — 설정 패널을 여닫아도 그 세션에 머문다 */
  conversationId: string;
  settingsRef?: RefObject<HTMLAnchorElement | null>;
  listOpen?: boolean;
  onToggleList?: () => void;
  listRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { canCreate } = useConversationPermissions(channelId);
  const channel = useChannel(channelId);
  const members = useMembers(channelId);
  const agents = useAgents();
  const matchRoute = useMatchRoute();
  const params = { channelId, conversationId };
  const settingsOpen = Boolean(matchRoute({ to: "/c/$channelId/s/$conversationId/settings", params }));

  const byId = new Map((agents.data ?? []).map((a) => [a.id, a]));
  const channelAgents = (members.data ?? []).flatMap((m): Agent[] => {
    const agent = m.memberType === "agent" ? byId.get(m.memberId) : undefined;
    // 보관(삭제)한 에이전트는 서버 멤버 응답이 빼지만, 다른 탭의 보관 뒤 멤버를 다시 받기 전 틈에도 머리에 남지 않게
    return agent && !isArchived(agent) ? [agent] : [];
  });
  const shown = channelAgents.slice(0, MAX_AVATARS);
  const hidden = channelAgents.length - shown.length;
  // 이 세션에만 초대한 에이전트(세션 에이전트 초대 스펙 5.4) — 「초대됨」을 달고, 얼굴 메뉴에 「세션에서 내보내기」
  const isSession = conversationId !== NEW_CONVERSATION;
  const invited = useSessionInvitedAgents(conversationId, { enabled: isSession }).filter(
    (agent) => !channelAgents.some((a) => a.id === agent.id),
  );
  const conversation = useConversationView(conversationId).data;
  const role = useRole();
  // 초대·내보내기는 채널에 에이전트를 넣고 빼는 판정과 같다(I3 — 지금은 누구나). 닫힌 세션·보관한 채널은 서버가 거절한다
  const canInvite =
    isSession &&
    roleAtLeast(role, "member") &&
    conversation !== undefined &&
    conversation.closedAt === undefined &&
    channel.data !== undefined &&
    !isChannelArchived(channel.data);

  return (
    <header data-testid="channel-header" className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <OpenSidebarButton />
      {onToggleList && (
        <Button
          ref={listRef}
          variant="ghost"
          size="icon-sm"
          aria-label="세션 목록"
          aria-expanded={listOpen}
          onClick={onToggleList}
        >
          <ListIcon />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="flex items-center gap-1 text-base font-semibold">
          <HashIcon className="size-4 shrink-0 opacity-60" aria-hidden />
          <span className="truncate">{channel.data?.name}</span>
          {channel.data && isChannelArchived(channel.data) && (
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
              보관됨
            </span>
          )}
        </h1>
        <div className="flex min-w-0 items-center gap-1 text-xs">
          <ConversationTitle channelId={channelId} conversationId={conversationId} />
          {channel.data?.topic && (
            <>
              <span aria-hidden className="shrink-0 text-muted-foreground">
                ·
              </span>
              <span className="truncate text-muted-foreground" title={channel.data.topic}>
                {channel.data.topic}
              </span>
            </>
          )}
        </div>
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
            <AvatarGroupCount role="img" className="size-6 text-xs" aria-label={`에이전트 ${hidden}명 더`}>
              +{hidden}
            </AvatarGroupCount>
          )}
        </AvatarGroup>
      )}
      {invited.length > 0 && (
        <ul aria-label="초대한 에이전트" className="flex shrink-0 items-center gap-1">
          {invited.map((agent) => (
            <li key={agent.id}>
              <InvitedAgentFace agent={agent} conversationId={conversationId} canRemove={canInvite} />
            </li>
          ))}
        </ul>
      )}
      {canInvite && <InviteAgentDialog channelId={channelId} conversationId={conversationId} />}
      {canCreate && conversationId !== NEW_CONVERSATION && (
        <Button asChild variant="ghost" size="icon-sm">
          <Link
            to="/c/$channelId/s/$conversationId"
            params={{ channelId, conversationId: NEW_CONVERSATION }}
            aria-label="새 세션"
            title="새 세션"
          >
            <SquarePenIcon />
          </Link>
        </Button>
      )}
      <CloseConversationButton channelId={channelId} conversationId={conversationId} />
      <FilesTabLink channelId={channelId} conversationId={conversationId} />
      <Button asChild variant="ghost" size="icon-sm">
        <Link
          ref={settingsRef}
          to={settingsOpen ? "/c/$channelId/s/$conversationId" : "/c/$channelId/s/$conversationId/settings"}
          params={params}
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

/** 초대한 에이전트 하나 — 얼굴과 「초대됨」. 내보낼 수 있으면 눌러 여는 메뉴에 「세션에서 내보내기」 */
function InvitedAgentFace({
  agent,
  conversationId,
  canRemove,
}: {
  agent: Agent;
  conversationId: string;
  canRemove: boolean;
}) {
  const remove = useRemoveInvitedAgent(conversationId);
  const face = (
    <span className="flex items-center gap-1">
      <Avatar size="sm" className="border-2" style={{ borderColor: agentColorVar(agent.handle) }}>
        {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt="" />}
        <AvatarFallback className="text-[10px]">{agent.name.slice(0, 1)}</AvatarFallback>
      </Avatar>
      <span className="rounded-sm bg-muted px-1 text-[10px] text-muted-foreground">초대됨</span>
    </span>
  );
  const label = `@${agent.handle} 초대됨`;
  if (!canRemove)
    return (
      <span role="img" aria-label={label} title={`${agent.name} (@${agent.handle}) · 초대됨`}>
        {face}
      </span>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={`${agent.name} (@${agent.handle}) · 초대됨`}
          className="rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {face}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={remove.isPending} onSelect={() => remove.mutate(agent.id)}>
          세션에서 내보내기
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
