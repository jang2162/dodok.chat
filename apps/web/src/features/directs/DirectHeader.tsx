import type { Channel, DirectSummary } from "@dodok/shared";
import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { ActivityIcon, CircleSlashIcon, FolderIcon, ListIcon, SquarePenIcon, UsersIcon } from "lucide-react";
import { type ReactNode, type RefObject, useRef, useState } from "react";
import { HeaderOverflow, type OverflowItem } from "@/app/layout/HeaderOverflow";
import { FilesTabLink } from "@/app/layout/PanelTabs";
import { OpenSidebarButton } from "@/app/layout/sidebarSheet";
import {
  CloseConversationButton,
  CloseConversationDialog,
  ConversationTitle,
  useCanCloseConversation,
} from "@/features/conversations/ConversationTitle";
import { useConversationPermissions } from "@/features/conversations/permissions";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { isDeactivated } from "@/features/members/deactivated";
import { useOpenProfile } from "@/features/profile/openProfile";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/ui/dialog";
import { DmAgentAvatar, GroupAvatars, PersonPresenceAvatar } from "./DirectRow";
import { directNames, directPeer, isLoneGroup, isOneStream, personName } from "./queries";

/**
 * 사람 DM·그룹 DM 머리(사람 간 DM 스펙 「화면」). 1:1 은 상대 아바타·접속 점·이름·상태 메시지 — 누르면 상대 프로필. 그룹은 인원수와 이름
 * 나열 — 누르면 참여자 목록(각 줄에서 프로필). 에이전트가 있는 그룹은 채널처럼 세션 목록 여닫기·지금 세션 제목(바꾸기·닫기)·「새 세션」·「활동」
 * 이 있고, 한 줄기(에이전트 없음)는 세션 것이 없다(계획 판정 PH4). 채널 설정·주제·지시·멤버 칸은 없다(채널 관리는 서버 VALIDATION).
 * `direct` 는 목록의 요약(아직 못 받았으면 undefined — 이름 없이 그린다). `activityRef` 는 「활동」 링크 — 패널을 닫으면 초점이 여기로 돌아온다.
 * 좁은 화면은 제목(위)·세션 제목(아래) 두 줄에 나머지 단추를 「더 보기」 메뉴로(스펙 2026-11-19 U6 — 그룹이면 「참여자」도 메뉴에)
 */
export function DirectHeader({
  channel,
  direct,
  conversationId,
  activityRef,
  listOpen,
  onToggleList,
  listRef,
}: {
  channel: Channel;
  direct: DirectSummary | undefined;
  conversationId: string;
  activityRef?: RefObject<HTMLAnchorElement | null>;
  listOpen: boolean;
  onToggleList: () => void;
  listRef?: RefObject<HTMLButtonElement | null>;
}) {
  const sessions = direct !== undefined && !isOneStream(direct);
  const { canCreate } = useConversationPermissions(channel.id);
  const matchRoute = useMatchRoute();
  const params = { channelId: channel.id, conversationId };
  const activityOpen = Boolean(matchRoute({ to: "/c/$channelId/s/$conversationId/activity", params }));
  const filesOpen = Boolean(matchRoute({ to: "/c/$channelId/s/$conversationId/files", params }));
  const peer = direct && directPeer(direct);
  const narrow = useIsNarrow();
  const navigate = useNavigate();
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  // 「더 보기」 단추 — 메뉴에서 연 확인 대화상자가 닫히면 초점이 여기로
  const moreRef = useRef<HTMLElement | null>(null);
  const participantsReturn = useRef<HTMLElement | null>(null);
  const canClose = useCanCloseConversation(channel.id, conversationId) && sessions;
  const canNew = sessions && canCreate && conversationId !== NEW_CONVERSATION;
  const overflow: OverflowItem[] = [
    ...(direct && !peer
      ? [
          {
            key: "participants",
            label: "참여자",
            icon: <UsersIcon />,
            onSelect: () => {
              participantsReturn.current = moreRef.current;
              setParticipantsOpen(true);
            },
          },
        ]
      : []),
    ...(canNew
      ? [
          {
            key: "new",
            label: "새 세션",
            icon: <SquarePenIcon />,
            onSelect: () =>
              void navigate({
                to: "/c/$channelId/s/$conversationId",
                params: { channelId: channel.id, conversationId: NEW_CONVERSATION },
              }),
          },
        ]
      : []),
    {
      key: "files",
      label: "파일",
      icon: <FolderIcon />,
      onSelect: () =>
        void navigate({
          to: filesOpen ? "/c/$channelId/s/$conversationId" : "/c/$channelId/s/$conversationId/files",
          params,
        }),
    },
    ...(sessions
      ? [
          {
            key: "activity",
            label: "활동",
            icon: <ActivityIcon />,
            onSelect: () =>
              void navigate({
                to: activityOpen
                  ? "/c/$channelId/s/$conversationId"
                  : "/c/$channelId/s/$conversationId/activity",
                params,
              }),
          },
        ]
      : []),
    ...(canClose
      ? [
          {
            key: "close",
            label: "세션 닫기",
            icon: <CircleSlashIcon />,
            destructive: true,
            separatorBefore: true,
            onSelect: () => setCloseOpen(true),
          },
        ]
      : []),
  ];
  const title =
    direct &&
    (peer ? (
      <PeerTitle peer={peer} />
    ) : (
      <GroupTitle
        direct={direct}
        open={participantsOpen}
        onOpenChange={(next) => {
          // 제목 단추로 열면 Radix 가 그 단추로 돌려준다 — 「더 보기」에서 연 때만 돌아갈 자리를 정한다
          if (next) participantsReturn.current = null;
          setParticipantsOpen(next);
        }}
        returnFocus={participantsReturn}
      />
    ));
  const sessionTitle = sessions && (
    // 남은 자리만 쓴다(flex-1 의 기준 0) — 같은 줄의 세션 제목이 자기 폭을 쥐면 390px 에서 참여자 이름이 한 글자로 잘린다
    <div
      data-testid="direct-session-title"
      className={cn("flex min-w-0 items-center gap-1 text-xs", !narrow && "flex-1")}
    >
      <ConversationTitle channelId={channel.id} conversationId={conversationId} />
    </div>
  );

  return (
    <header data-testid="direct-header" className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <OpenSidebarButton />
      {sessions && (
        <Button
          ref={listRef}
          variant="ghost"
          size="icon-sm"
          aria-label="세션 목록"
          aria-expanded={listOpen}
          onClick={onToggleList}
          className={cn(narrow && "size-11")}
        >
          <ListIcon />
        </Button>
      )}
      {narrow ? (
        // 제목 두 줄 — 위 대화 이름, 아래 지금 세션 제목
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          {title}
          {sessionTitle}
        </div>
      ) : (
        <>
          {title}
          {sessionTitle || <div className="flex-1" />}
        </>
      )}
      {narrow && (
        <>
          <HeaderOverflow items={overflow} triggerRefs={[activityRef, moreRef]} />
          {canClose && (
            <CloseConversationDialog
              conversationId={conversationId}
              open={closeOpen}
              onOpenChange={setCloseOpen}
              returnFocus={moreRef}
            />
          )}
        </>
      )}
      {!narrow && canNew && (
        <Button asChild variant="ghost" size="icon-sm">
          <Link
            to="/c/$channelId/s/$conversationId"
            params={{ channelId: channel.id, conversationId: NEW_CONVERSATION }}
            aria-label="새 세션"
            title="새 세션"
          >
            <SquarePenIcon />
          </Link>
        </Button>
      )}
      {!narrow && sessions && (
        <CloseConversationButton channelId={channel.id} conversationId={conversationId} />
      )}
      {/* 한 줄기에는 활동 단추가 없다 — 패널을 닫으면 초점이 이 단추로 돌아온다 */}
      {!narrow && (
        <FilesTabLink
          channelId={channel.id}
          conversationId={conversationId}
          ref={sessions ? undefined : activityRef}
        />
      )}
      {!narrow && sessions && (
        <Button asChild variant="ghost" size="icon-sm">
          <Link
            ref={activityRef}
            to={activityOpen ? "/c/$channelId/s/$conversationId" : "/c/$channelId/s/$conversationId/activity"}
            params={params}
            activeOptions={{ exact: true }}
            aria-label="활동"
            aria-expanded={activityOpen}
          >
            <ActivityIcon />
          </Link>
        </Button>
      )}
    </header>
  );
}

/** 1:1 머리 — 누르면 상대 프로필(세션 화면이 아니면 누를 수 없다 — `useOpenProfile`) */
function PeerTitle({ peer }: { peer: DirectSummary["users"][number] }) {
  const openProfile = useOpenProfile();
  const name = personName(peer);
  const body = (
    <>
      <PersonPresenceAvatar person={peer} size="default" />
      <span className="min-w-0 text-left">
        <span className="block truncate text-base font-semibold">
          {name}
          {isDeactivated(peer) && (
            <span className="ml-1 text-xs font-normal text-muted-foreground">(비활성)</span>
          )}
        </span>
        {peer.statusMessage && (
          <span className="block truncate text-xs text-muted-foreground">
            {peer.statusMessage.emoji && <span className="mr-1">{peer.statusMessage.emoji}</span>}
            {peer.statusMessage.text}
          </span>
        )}
      </span>
    </>
  );
  return (
    <h1 className="flex min-w-0 items-center">
      {openProfile ? (
        <button
          type="button"
          aria-label={`${name} 프로필`}
          onClick={() => openProfile({ kind: "user", id: peer.id })}
          className="flex min-w-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-2">{body}</span>
      )}
    </h1>
  );
}

/** 그룹 머리 — 누르면 참여자 목록(나를 뺀 사람·에이전트, 각 줄에서 프로필) */
function GroupTitle({
  direct,
  open,
  onOpenChange: setOpen,
  returnFocus,
}: {
  direct: DirectSummary;
  /** 열림은 머리가 쥔다 — 좁은 화면 「더 보기」의 「참여자」도 같은 목록을 연다 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 「더 보기」에서 열었을 때 닫으면 초점이 돌아갈 자리 — 제목 단추로 열면 Radix 가 그 단추로 돌려준다 */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const openProfile = useOpenProfile();
  const names = directNames(direct);
  const row = (
    key: string,
    avatar: ReactNode,
    label: string,
    target: { kind: "user" | "agent"; id: string },
  ) => (
    <li key={key}>
      <button
        type="button"
        disabled={!openProfile}
        onClick={() => {
          setOpen(false);
          openProfile?.(target);
        }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {avatar}
        <span className="truncate">{label}</span>
      </button>
    </li>
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <h1 className="flex min-w-0 items-center">
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={`참여자 — ${names}`}
            className="flex min-w-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <GroupAvatars direct={direct} />
            <span className="truncate text-base font-semibold">
              {names}
              {isLoneGroup(direct) && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">(그룹)</span>
              )}
            </span>
          </button>
        </DialogTrigger>
      </h1>
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          const el = returnFocus?.current;
          if (!el?.isConnected) return;
          e.preventDefault();
          el.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>참여자</DialogTitle>
        </DialogHeader>
        <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {direct.users.map((p) =>
            row(
              `u:${p.id}`,
              <PersonPresenceAvatar person={p} />,
              isDeactivated(p) ? `${personName(p)} (비활성)` : personName(p),
              { kind: "user", id: p.id },
            ),
          )}
          {direct.agents.map((a) =>
            row(`a:${a.id}`, <DmAgentAvatar agent={a} />, `${a.name} @${a.handle}`, {
              kind: "agent",
              id: a.id,
            }),
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
