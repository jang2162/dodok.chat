import type { Agent, DirectSummary, Person } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { isDeactivated } from "@/features/members/deactivated";
import { WithPresence } from "@/features/presence/PresenceDot";
import { MENTIONS_MAX, useChannelUnread } from "@/features/reads/useUnread";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from "@/ui/avatar";
import { directNames, directPeer, isLoneGroup, personName } from "./queries";

/** 사람 아바타 — 사진이 없으면 이름 첫 글자 */
export function PersonAvatar({ person, size = "sm" }: { person: Person; size?: "sm" | "default" }) {
  return (
    <Avatar size={size}>
      {person.avatarUrl && <AvatarImage src={person.avatarUrl} alt="" />}
      <AvatarFallback className="text-[10px]">{personName(person).slice(0, 1)}</AvatarFallback>
    </Avatar>
  );
}

/** 사람 아바타 + 접속 점 — 비활성 멤버는 점이 없다(프로필 패널과 같은 규칙) */
export function PersonPresenceAvatar({ person, size = "sm" }: { person: Person; size?: "sm" | "default" }) {
  if (isDeactivated(person)) return <PersonAvatar person={person} size={size} />;
  return (
    <WithPresence kind="user" id={person.id}>
      <PersonAvatar person={person} size={size} />
    </WithPresence>
  );
}

/** 에이전트 아바타 + 접속 점 — 테두리는 에이전트 색(스펙 7.2), 사진이 없으면 이름 첫 글자. 에이전트 DM 줄·머리·「새 메시지」가 쓴다 */
export function DmAgentAvatar({ agent, size = "sm" }: { agent: Agent; size?: "sm" | "default" }) {
  return (
    <WithPresence kind="agent" id={agent.id}>
      <Avatar size={size} className="border-2" style={{ borderColor: agentColorVar(agent.handle) }}>
        {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt="" />}
        <AvatarFallback className="text-[10px]">{agent.name.slice(0, 1)}</AvatarFallback>
      </Avatar>
    </WithPresence>
  );
}

function AgentAvatar({ agent }: { agent: Agent }) {
  return (
    <Avatar size="sm" className="border-2" style={{ borderColor: agentColorVar(agent.handle) }}>
      {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt="" />}
      <AvatarFallback className="text-[10px]">{agent.name.slice(0, 1)}</AvatarFallback>
    </Avatar>
  );
}

/** 그룹 DM 의 겹친 아바타 둘 — 사람 먼저, 그다음 에이전트(나를 뺀 참여자) */
export function GroupAvatars({ direct }: { direct: Pick<DirectSummary, "users" | "agents"> }) {
  const faces = [
    ...direct.users.map((p) => <PersonAvatar key={`u:${p.id}`} person={p} />),
    ...direct.agents.map((a) => <AgentAvatar key={`a:${a.id}`} agent={a} />),
  ].slice(0, 2);
  return (
    <AvatarGroup aria-hidden className="shrink-0">
      {faces}
    </AvatarGroup>
  );
}

/**
 * 「다이렉트 메시지」 절의 한 줄 틀 — 채널 줄(`ChannelLink`)과 같은 규칙: 보고 있는 줄은 굵게 하지 않고 배지는 남긴다, 배지 수는 링크 이름에
 * 글로. 에이전트 DM 줄(`DmSection`)과 사람 DM·그룹 DM 줄이 함께 쓴다
 */
export function DmRowLink({
  channelId,
  avatar,
  label,
  dim = false,
  suffix,
  onNavigate,
}: {
  channelId: string;
  avatar: ReactNode;
  label: string;
  /** 흐리게(비활성 상대) */
  dim?: boolean;
  /** 이름 뒤에 붙는 작은 글(「(비활성)」) */
  suffix?: string;
  onNavigate?: () => void;
}) {
  const state = useChannelUnread(channelId);
  const mentions = state?.mentions ?? 0;
  return (
    <Link
      to="/c/$channelId"
      params={{ channelId }}
      onClick={onNavigate}
      data-dim={dim || undefined}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-sidebar-foreground/80 outline-none hover:not-aria-[current=page]:bg-sidebar-accent hover:not-aria-[current=page]:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar aria-[current=page]:bg-sidebar-primary aria-[current=page]:font-medium aria-[current=page]:text-sidebar-primary-foreground data-dim:opacity-60"
    >
      {({ isActive }) => {
        const bold = !isActive && state?.unread === true;
        return (
          <>
            {avatar}
            <span className={cn("truncate", bold && "font-semibold text-sidebar-foreground")}>{label}</span>
            {suffix && <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>}
            {bold && <span className="sr-only"> (안 읽음)</span>}
            {mentions > 0 && (
              <>
                <span
                  data-mention-badge
                  aria-hidden
                  className="ml-auto shrink-0 rounded-full bg-destructive px-1.5 text-xs leading-5 font-medium text-white tabular-nums"
                >
                  {mentions >= MENTIONS_MAX ? `${MENTIONS_MAX}+` : mentions}
                </span>
                <span className="sr-only">
                  {mentions >= MENTIONS_MAX ? ` (멘션 ${MENTIONS_MAX}개 이상)` : ` (멘션 ${mentions}개)`}
                </span>
              </>
            )}
          </>
        );
      }}
    </Link>
  );
}

/**
 * 사람 DM·그룹 DM 한 줄(사람 간 DM 스펙 「목록 — 사이드바 「다이렉트 메시지」」) — 1:1 은 상대 아바타·접속 점·이름(비활성이면 흐리게 +
 * 「(비활성)」), 그룹은 겹친 아바타 둘과 나를 뺀 이름 나열
 */
export function DirectRow({ direct, onNavigate }: { direct: DirectSummary; onNavigate?: () => void }) {
  const peer = directPeer(direct);
  if (peer) {
    const off = isDeactivated(peer);
    return (
      <DmRowLink
        channelId={direct.channel.id}
        avatar={<PersonPresenceAvatar person={peer} />}
        label={personName(peer)}
        dim={off}
        suffix={off ? "(비활성)" : undefined}
        onNavigate={onNavigate}
      />
    );
  }
  return (
    <DmRowLink
      channelId={direct.channel.id}
      avatar={<GroupAvatars direct={direct} />}
      label={directNames(direct)}
      suffix={isLoneGroup(direct) ? "(그룹)" : undefined}
      onNavigate={onNavigate}
    />
  );
}
