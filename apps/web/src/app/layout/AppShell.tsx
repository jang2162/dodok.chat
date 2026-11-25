import { Outlet } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChannels } from "@/api/queries";
import { useDirects } from "@/features/directs/queries";
import { useDms } from "@/features/dms/queries";
import { isSearchShortcut, OpenSearchContext, otherModalOpen } from "@/features/search/openSearch";
import { SearchDialog } from "@/features/search/SearchDialog";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { Banners } from "./Banners";
import { ResizeHandle } from "./ResizeHandle";
import { Sidebar } from "./Sidebar";
import { OpenSidebarContext, SidebarSheetOpenContext, SidebarTriggerContext } from "./sidebarSheet";
import { SIDEBAR, layoutStore, useLayoutWidths } from "./useLayoutWidths";

/**
 * 페이지 영역 스크롤 상자의 id — 화면이 바뀌면 라우터가 이 상자를 맨 위로 돌린다(`scrollToTopSelectors`).
 * 라우터는 창만 돌리므로 이 목록에서 빠지면 앞 화면에서 내린 만큼 내려간 채로 다음 화면이 열린다
 */
export const PAGE_SCROLL_ID = "page-scroll";

/**
 * 로그인 뒤 레이아웃(스펙 2.4): 사이드바 + 연결 배너 + 페이지. 768px 미만이면 사이드바를 왼쪽 시트로 접고,
 * 페이지 헤더가 `useOpenSidebar()` 로 여는 버튼을 그린다. 시트는 그 안에서 이동하면 닫히고, 닫히면(이동·Esc·닫기)
 * 초점은 지금 화면의 메뉴 버튼으로 돌아간다. 넓은 화면의 사이드바는 오른쪽 경계의 손잡이로 너비를 바꾸고(UI 시안 04 — 200–420px,
 * 기기별 저장), 최솟값보다 더 끌거나 `⌘\`/`Ctrl+\` 로 접는다 — 접혀 있으면 같은 메뉴 버튼이 머리에 나와 다시 편다. 검색 대화상자(스레드·검색 스펙 5.4)는 어느 화면에서나 `⌘K`/`Ctrl+K` 와
 * 사이드바의 검색 칸으로 연다
 */
export function AppShell() {
  const narrow = useIsNarrow();
  // 채널·DM 목록은 사이드바와 상관없이 늘 들고 있는다 — 좁은 화면은 사이드바를 시트를 열 때만 그리는데, 실시간 처리기가 이 캐시로
  // 승인 알림을 가른다: 채널이 어느 목록에도 없으면 종류를 몰라 알리지 않으므로(`handlers.ts` 의 승인 요구) 채널 목록이 빠지면 지금
  // 보지 않는 일반 채널의 알림이 사라진다. DM 은 주인 판정·본문 「DM」, 사람 DM·그룹 DM 은 시킨 사람 판정(사람 간 DM 스펙 「목록」),
  // 그리고 읽지 않음 항목. DM·사람 DM 목록은 낡지 않아(`staleTime: Infinity`) 관찰자가 늘어도 다시 부르지 않고, 채널 목록은 기본(낡음
  // 0)이라 사이드바 같은 관찰자가 새로 붙을 때 다시 부른다
  useChannels();
  useDms();
  useDirects();
  const [sheetOpen, setSheetOpen] = useState(false);
  // 폭이 바뀌면 시트를 닫아 둔다 — 다시 좁아졌을 때 저절로 열려 있지 않게
  const [wasNarrow, setWasNarrow] = useState(narrow);
  if (wasNarrow !== narrow) {
    setWasNarrow(narrow);
    setSheetOpen(false);
  }
  const openSidebar = useCallback(() => {
    pendingFocus.current = false;
    setSheetOpen(true);
  }, []);
  const closeSidebar = useCallback(() => setSheetOpen(false), []);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const [trigger] = useState(() => ({ ref: triggerRef, pendingFocus }));
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useEffect(() => {
    // 작성기 안에서 눌러도 연다 — 브라우저의 주소창 초점(Ctrl+K)보다 앞선다. 다른 모달 위에서는 무시한다
    const onKey = (e: KeyboardEvent) => {
      if (!isSearchShortcut(e) || otherModalOpen()) return;
      e.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const layout = useLayoutWidths();
  const collapsed = !narrow && layout.collapsed;
  const asideRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  // 접힌 사이드바를 다시 편다 — 머리의 메뉴 버튼은 사라지므로 초점은 다시 나온 손잡이로
  const expandSidebar = useCallback(() => {
    layoutStore.setCollapsed(false);
    requestAnimationFrame(() => handleRef.current?.focus());
  }, []);
  useEffect(() => {
    if (narrow) return;
    // ⌘\(Ctrl+\) 로 접고 편다. 한국어 배열처럼 글자가 달라도 같은 키 자리(`Backslash`)면 받는다
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key !== "\\" && e.code !== "Backslash") return;
      if (otherModalOpen()) return;
      e.preventDefault();
      const next = !layoutStore.get().collapsed;
      layoutStore.setCollapsed(next);
      if (!next) requestAnimationFrame(() => handleRef.current?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [narrow]);
  // 접는 순간 초점이 사이드바 안에 있었으면 머리의 「채널 목록 열기」로 — 숨긴(inert) 칸에 초점이 남지 않게
  const wasCollapsed = useRef(collapsed);
  useEffect(() => {
    const was = wasCollapsed.current;
    wasCollapsed.current = collapsed;
    if (!collapsed || was) return;
    const active = document.activeElement;
    if (active === document.body || (active && asideRef.current?.contains(active)))
      triggerRef.current?.focus();
  }, [collapsed]);

  return (
    <OpenSearchContext.Provider value={openSearch}>
      <OpenSidebarContext.Provider value={narrow ? openSidebar : collapsed ? expandSidebar : undefined}>
        <SidebarTriggerContext.Provider value={trigger}>
          <SidebarSheetOpenContext.Provider value={narrow && sheetOpen}>
            <div data-testid="app-shell" className="flex h-dvh bg-background text-foreground">
              {narrow ? (
                <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                  <SheetContent
                    side="left"
                    className="w-[260px] gap-0 p-0"
                    aria-describedby={undefined}
                    onCloseAutoFocus={(e) => {
                      e.preventDefault();
                      // 링크로 닫혔으면 이동은 아직 끝나지 않았다 — 지금 버튼에 초점을 주고, 화면이 바뀌어 그 버튼이
                      // 사라지면(초점을 잃으면) 새 화면의 버튼이 이어받게 표시해 둔다
                      pendingFocus.current = true;
                      triggerRef.current?.focus();
                    }}
                  >
                    <SheetTitle className="sr-only">채널 목록</SheetTitle>
                    <Sidebar onNavigate={closeSidebar} />
                  </SheetContent>
                </Sheet>
              ) : (
                <aside
                  ref={asideRef}
                  data-testid="app-sidebar"
                  data-collapsed={collapsed || undefined}
                  inert={collapsed}
                  style={{ width: layout.drawn.sidebar }}
                  className={cn(
                    "relative shrink-0",
                    !collapsed && "border-r",
                    // 접고 펼 때만 미끄러진다 — 끄는 동안(손잡이의 data-dragging)·동작 줄이기면 바로
                    "motion-safe:transition-[width] motion-safe:duration-200 has-data-dragging:transition-none",
                  )}
                >
                  <div className="h-full overflow-hidden">
                    {/* 안쪽은 저장된 너비 그대로 — 접히는 동안 글이 다시 줄바꿈되지 않고 잘린다 */}
                    <div
                      className="h-full"
                      style={{ width: collapsed ? layout.sidebar : layout.drawn.sidebar }}
                    >
                      <Sidebar />
                    </div>
                  </div>
                  {!collapsed && (
                    <ResizeHandle
                      ref={handleRef}
                      label="사이드바 너비"
                      value={layout.drawn.sidebar}
                      range={SIDEBAR}
                      grow={1}
                      className="-right-[5px]"
                      onDrag={layoutStore.dragSidebar}
                      onCommit={layoutStore.commit}
                      onSet={layoutStore.setSidebar}
                    />
                  )}
                </aside>
              )}
              <main className="flex min-w-0 flex-1 flex-col">
                <Banners />
                {/* 긴 화면(연결·운영 등)은 여기서만 스크롤한다 — 문서가 스크롤되면 사이드바·배너가 함께 밀려 올라간다.
                  채널 화면은 `flex-1 min-h-0` 으로 이 높이에 맞춰 목록이 스스로 스크롤하므로 두 겹이 되지 않는다 */}
                <div
                  id={PAGE_SCROLL_ID}
                  data-testid="page-scroll"
                  className="flex min-h-0 flex-1 flex-col overflow-y-auto"
                >
                  <Outlet />
                </div>
              </main>
            </div>
            <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
          </SidebarSheetOpenContext.Provider>
        </SidebarTriggerContext.Provider>
      </OpenSidebarContext.Provider>
    </OpenSearchContext.Provider>
  );
}
