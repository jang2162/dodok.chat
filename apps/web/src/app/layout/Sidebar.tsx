import { Link } from "@tanstack/react-router";
import { BotIcon, LogOutIcon, PlusIcon } from "lucide-react";
import { useMe } from "@/api/queries";
import { ChannelList } from "@/features/channels/ChannelList";
import { CreateChannelDialog } from "@/features/channels/CreateChannelDialog";
import { useLogout } from "@/features/auth/mutations";
import { Button } from "@/ui/button";
import { ConnectionDots } from "./ConnectionDots";
import { NotifyToggle } from "./NotifyToggle";

/**
 * 왼쪽 사이드바(스펙 2.4): 워크스페이스 이름, 채널 목록·「채널 만들기」, 「에이전트」, 하단 연결 상태와 로그아웃.
 * 이름은 `GET /auth/me` 의 `workspace.name` — 아직 못 받았거나 주지 않는 서버면 「dodok」.
 * `onNavigate` 는 이동할 때마다 부른다(좁은 화면 시트 닫기)
 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const logout = useLogout();
  const me = useMe();
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center px-4 text-base font-semibold">
        {/* 이름은 최대 80자다(shared Workspace) — 좁은 사이드바에서 줄이 넘치지 않게 한 줄로 자른다 */}
        <span className="truncate">{me.data?.workspace?.name ?? "dodok"}</span>
      </div>
      <nav aria-label="채널" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
        <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">채널</p>
        <ChannelList onNavigate={onNavigate} />
        <CreateChannelDialog onCreated={onNavigate}>
          <Button variant="ghost" size="sm" className="justify-start px-2 font-normal text-muted-foreground">
            <PlusIcon />
            채널 만들기
          </Button>
        </CreateChannelDialog>
      </nav>
      <div className="border-t px-2 py-2">
        <Link
          to="/agents"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 outline-none hover:not-aria-[current=page]:bg-sidebar-accent hover:not-aria-[current=page]:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar aria-[current=page]:bg-sidebar-primary aria-[current=page]:font-medium aria-[current=page]:text-sidebar-primary-foreground"
        >
          <BotIcon className="size-4 shrink-0 opacity-70" aria-hidden />
          에이전트
        </Link>
        {/* 승인 요구 알림 권한 — 아직 묻지 않았을 때만 보인다(설계 5.4) */}
        <NotifyToggle />
      </div>
      <div className="flex h-11 shrink-0 items-center justify-between border-t pr-2 pl-4">
        <ConnectionDots />
        {/* /login 이동·상태 비우기는 훅이 한다 */}
        <Button variant="ghost" size="sm" disabled={logout.isPending} onClick={() => logout.mutate()}>
          <LogOutIcon />
          로그아웃
        </Button>
      </div>
    </div>
  );
}
