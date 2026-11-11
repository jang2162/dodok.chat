import { Link } from "@tanstack/react-router";
import { FolderIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
import { useCanManage, useMe } from "@/api/queries";
import { ChannelList } from "@/features/channels/ChannelList";
import { CreateChannelDialog } from "@/features/channels/CreateChannelDialog";
import { DmSection } from "@/features/dms/DmSection";
import { useOpenSearch } from "@/features/search/openSearch";
import { OpsBadge } from "@/features/settings-shell/OpsBadge";
import { CreateSectionButton, SidebarSections } from "@/features/sidebar/SidebarSections";
import { Button } from "@/ui/button";
import { ConnectionDots } from "./ConnectionDots";

/**
 * 왼쪽 사이드바(스펙 2.4): 워크스페이스 이름, 검색 칸(검색 대화상자를 연다 — 스레드·검색 스펙 5.4)과 「파일」(전체 화면), 채널 목록·「채널 만들기」,
 * 「다이렉트 메시지」 절(에이전트 DM 스펙 3.1 — 채널 목록과 같은 스크롤 상자). 개인 섹션(사이드바 섹션 스펙)은 두 절 위에, 「섹션 만들기」는
 * 두 절 아래에,
 * 하단은 연결 상태와 「설정」 하나(설정 통합 스펙 「사이드바」 절 — 에이전트·멤버·연결·운영·알림·내 계정·로그아웃은 `/settings` 의 탭).
 * 「설정」의 배지는 admin 이상에게만 — 확인 안 한 운영 사건 수(운영 탭과 같은 값).
 * 이름은 `GET /auth/me` 의 `workspace.name` — 아직 못 받았거나 주지 않는 서버면 「dodok」.
 * `onNavigate` 는 이동할 때마다 부른다(좁은 화면 시트 닫기)
 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const me = useMe();
  const manager = useCanManage();
  const openSearch = useOpenSearch();
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center px-4 text-base font-semibold">
        {/* 이름은 최대 80자다(shared Workspace) — 좁은 사이드바에서 줄이 넘치지 않게 한 줄로 자른다 */}
        <span className="truncate">{me.data?.workspace?.name ?? "dodok"}</span>
      </div>
      <div className="shrink-0 px-2 pb-2">
        {/* 좁은 화면에서는 사이드바 시트를 먼저 닫는다 — 시트 위에 검색 시트가 겹치지 않게 */}
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            openSearch();
          }}
          className="flex h-8 w-full items-center gap-2 rounded-md border bg-background px-2 text-sm text-muted-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <SearchIcon className="size-4 shrink-0 opacity-70" aria-hidden />
          <span className="flex-1 text-left">검색</span>
          <kbd aria-hidden className="text-xs">
            ⌘K
          </kbd>
        </button>
        {/* 내가 읽을 수 있는 모든 대화의 파일(파일함 스펙 「어디서 여나」) */}
        <Link
          to="/files"
          onClick={onNavigate}
          className="mt-1 flex h-8 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/80 outline-none hover:not-aria-[current=page]:bg-sidebar-accent hover:not-aria-[current=page]:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-[current=page]:bg-sidebar-primary aria-[current=page]:font-medium aria-[current=page]:text-sidebar-primary-foreground"
        >
          <FolderIcon className="size-4 shrink-0 opacity-70" aria-hidden />
          파일
        </Link>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
        <SidebarSections onNavigate={onNavigate} />
        <nav aria-label="채널" className="flex flex-col gap-1">
          <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">채널</p>
          <ChannelList onNavigate={onNavigate} />
          <CreateChannelDialog onCreated={onNavigate}>
            <Button
              variant="ghost"
              size="sm"
              className="justify-start px-2 font-normal text-muted-foreground"
            >
              <PlusIcon />
              채널 만들기
            </Button>
          </CreateChannelDialog>
        </nav>
        <DmSection onNavigate={onNavigate} />
        <CreateSectionButton />
      </div>
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-t pr-2 pl-4">
        <ConnectionDots />
        <Link
          to="/settings"
          onClick={onNavigate}
          className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 outline-none hover:not-aria-[current=page]:bg-sidebar-accent hover:not-aria-[current=page]:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar aria-[current=page]:bg-sidebar-primary aria-[current=page]:font-medium aria-[current=page]:text-sidebar-primary-foreground"
        >
          <SettingsIcon className="size-4 shrink-0 opacity-70" aria-hidden />
          설정
          {manager && <OpsBadge />}
        </Link>
      </div>
    </div>
  );
}
