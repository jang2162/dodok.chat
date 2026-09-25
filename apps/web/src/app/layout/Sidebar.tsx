import { Link } from "@tanstack/react-router";
import { ActivityIcon, BotIcon, CableIcon, LogOutIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useIsOwner, useMe } from "@/api/queries";
import { ChannelList } from "@/features/channels/ChannelList";
import { CreateChannelDialog } from "@/features/channels/CreateChannelDialog";
import { useLogout } from "@/features/auth/mutations";
import { useOpsStatus } from "@/features/ops/queries";
import { useOpenSearch } from "@/features/search/openSearch";
import { Button } from "@/ui/button";
import { ConnectionDots } from "./ConnectionDots";
import { NotifySettings } from "./NotifySettings";

/** 사이드바 하단 링크(에이전트·연결)의 꼴 */
const NAV_LINK =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 outline-none hover:not-aria-[current=page]:bg-sidebar-accent hover:not-aria-[current=page]:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar aria-[current=page]:bg-sidebar-primary aria-[current=page]:font-medium aria-[current=page]:text-sidebar-primary-foreground";

/** 배지에 그리는 수 — 그 위는 「99+」 */
const BADGE_MAX = 99;

/**
 * 「운영」 링크와 확인 안 한 warn·error 수 배지(운영 보강 스펙 7장). owner 일 때만 그린다 — 그래서 member 는 ops/status 를 부르지 않는다.
 * 수는 상태 캐시의 `unacked` 이고 실시간 `ops.event` 가 그 칸을 덮는다(realtime/handlers)
 */
function OpsLink({ onNavigate }: { onNavigate?: () => void }) {
  const unacked = useOpsStatus().data?.unacked;
  const n = unacked ? unacked.warn + unacked.error : 0;
  return (
    <Link to="/settings/operations" onClick={onNavigate} className={NAV_LINK}>
      <ActivityIcon className="size-4 shrink-0 opacity-70" aria-hidden />
      운영
      {n > 0 && (
        <>
          <span
            data-ops-badge
            aria-hidden
            className="ml-auto rounded-full bg-destructive px-1.5 text-xs leading-5 font-medium text-white tabular-nums"
          >
            {n > BADGE_MAX ? `${BADGE_MAX}+` : n}
          </span>
          <span className="sr-only"> (확인 안 한 사건 {n}건)</span>
        </>
      )}
    </Link>
  );
}

/**
 * 왼쪽 사이드바(스펙 2.4): 워크스페이스 이름, 검색 칸(검색 대화상자를 연다 — 스레드·검색 스펙 5.4), 채널 목록·「채널 만들기」, 「에이전트」, 「연결」·「운영」(owner 에게만), 하단 연결 상태와 로그아웃.
 * 이름은 `GET /auth/me` 의 `workspace.name` — 아직 못 받았거나 주지 않는 서버면 「dodok」.
 * `onNavigate` 는 이동할 때마다 부른다(좁은 화면 시트 닫기)
 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const logout = useLogout();
  const me = useMe();
  const owner = useIsOwner();
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
        <Link to="/agents" onClick={onNavigate} className={NAV_LINK}>
          <BotIcon className="size-4 shrink-0 opacity-70" aria-hidden />
          에이전트
        </Link>
        {/* 연결 설정은 owner 만 쓴다(설정 마법사 스펙 「결정」 — setup 은 owner 만) — 아닌 사람에게는 진입점이 없다 */}
        {owner && (
          <Link to="/settings/connection" onClick={onNavigate} className={NAV_LINK}>
            <CableIcon className="size-4 shrink-0 opacity-70" aria-hidden />
            연결
          </Link>
        )}
        {owner && <OpsLink onNavigate={onNavigate} />}
        {/* 이 기기의 알림 — 푸시 켜기·끄기·앱 설치(스펙 6장) */}
        <NotifySettings />
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
