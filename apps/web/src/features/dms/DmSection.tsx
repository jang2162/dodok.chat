import type { Agent, DmSummary } from "@dodok/shared";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useAgents, useRole } from "@/api/queries";
import { MENTIONS_MAX, useChannelUnread } from "@/features/reads/useUnread";
import { cn } from "@/lib/utils";
import { agentColorVar } from "@/theme/agentColor";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { canOpenDm, useDms } from "./queries";

/** 지금 보고 있는 채널(`/c/<id>` 와 그 아래) — 사이드바는 채널 라우트 밖이라 주소 모양으로 본다(app/router `channelIdOf` 와 같은 꼴) */
const useCurrentChannelId = () =>
  useRouterState({ select: (s) => /^\/c\/([^/]+)/.exec(s.location.pathname)?.[1] });

/**
 * 사이드바 「다이렉트 메시지」 절(에이전트 DM 스펙 3.1). 글이 있는 내 DM 과 지금 연 DM 만 최근 활동순(서버 순서 — 새 글은
 * realtime 이 맨 위로 올린다)으로 보인다 — `GET /dms` 는 글 없는 DM 도 준다(계획 판정 PD1: 열 때 만든 빈 DM 이 사이드바를 채우지 않게).
 * 굵게·배지는 채널 줄과 같은 읽지 않음 값(`useChannelUnread`)을 그대로 쓴다 — DM 에이전트의 글을 「나를 멘션한 글」로 세는 것은 서버다(PD10).
 * 「+」 는 지금 내 역할로 DM 할 수 있는 에이전트를 고르는 대화상자다. `onNavigate` 는 이동할 때마다(좁은 화면 시트 닫기)
 */
export function DmSection({ onNavigate }: { onNavigate?: () => void }) {
  const dms = useDms();
  const current = useCurrentChannelId();
  const shown = (dms.data ?? []).filter((d) => d.lastMessageAt !== null || d.channel.id === current);
  return (
    <nav aria-label="다이렉트 메시지" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 pt-2 pr-1 pl-2">
        <p className="text-xs font-medium text-muted-foreground">다이렉트 메시지</p>
        <DmPicker onNavigate={onNavigate} />
      </div>
      {dms.isError && !dms.data ? (
        <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground">
          <span>DM 목록을 불러오지 못했습니다</span>
          <Button variant="ghost" size="xs" disabled={dms.isFetching} onClick={() => void dms.refetch()}>
            다시 시도
          </Button>
        </div>
      ) : (
        shown.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {shown.map((dm) => (
              <li key={dm.channel.id}>
                <DmLink dm={dm} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        )
      )}
    </nav>
  );
}

/** 에이전트 아바타 — 테두리는 에이전트 색(스펙 7.2), 사진이 없으면 이름 첫 글자 */
export function DmAgentAvatar({ agent, size = "sm" }: { agent: Agent; size?: "sm" | "default" }) {
  return (
    <Avatar size={size} className="border-2" style={{ borderColor: agentColorVar(agent.handle) }}>
      {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt="" />}
      <AvatarFallback className="text-[10px]">{agent.name.slice(0, 1)}</AvatarFallback>
    </Avatar>
  );
}

/** DM 한 줄 — 채널 줄(`ChannelLink`)과 같은 규칙: 보고 있는 DM 은 굵게 하지 않고 배지는 남긴다, 배지 수는 링크 이름에 글로 */
function DmLink({ dm, onNavigate }: { dm: DmSummary; onNavigate?: () => void }) {
  const state = useChannelUnread(dm.channel.id);
  const mentions = state?.mentions ?? 0;
  return (
    <Link
      to="/c/$channelId"
      params={{ channelId: dm.channel.id }}
      onClick={onNavigate}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-sidebar-foreground/80 outline-none hover:not-aria-[current=page]:bg-sidebar-accent hover:not-aria-[current=page]:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar aria-[current=page]:bg-sidebar-primary aria-[current=page]:font-medium aria-[current=page]:text-sidebar-primary-foreground"
    >
      {({ isActive }) => {
        const bold = !isActive && state?.unread === true;
        return (
          <>
            <DmAgentAvatar agent={dm.agent} />
            <span className={cn("truncate", bold && "font-semibold text-sidebar-foreground")}>
              {dm.agent.name}
            </span>
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
 * 「DM 할 에이전트」 고르기 — 후보는 지금 내 역할로 `dmAccess` 를 통과하고 보관·꺼짐이 아닌 에이전트(`canOpenDm`). 고르면 `/dm/<에이전트>`
 * 로 간다(그 화면이 DM 채널을 찾거나 만들어 넘긴다 — 계획 판정 PD2)
 */
function DmPicker({ onNavigate }: { onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  const agents = useAgents();
  const role = useRole();
  const navigate = useNavigate();
  const candidates = (agents.data ?? []).filter((a) => canOpenDm(a, role));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="DM 할 에이전트 고르기" title="새 DM">
          <PlusIcon />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>DM 할 에이전트</DialogTitle>
          <DialogDescription>에이전트와 1:1 로 대화합니다. 이 DM 은 나만 봅니다.</DialogDescription>
        </DialogHeader>
        {agents.data === undefined ? (
          <p role="status" className="text-sm text-muted-foreground">
            {agents.isError ? "에이전트 목록을 불러오지 못했습니다" : "불러오는 중…"}
          </p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">DM 할 수 있는 에이전트가 없습니다.</p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
            {candidates.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => {
                    setOpen(false);
                    onNavigate?.();
                    void navigate({ to: "/dm/$agentId", params: { agentId: agent.id } });
                  }}
                >
                  <DmAgentAvatar agent={agent} />
                  <span className="truncate font-medium">{agent.name}</span>
                  <span className="truncate text-muted-foreground">@{agent.handle}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
