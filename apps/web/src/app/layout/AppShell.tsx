import { Outlet } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { Banners } from "./Banners";
import { Sidebar } from "./Sidebar";
import { OpenSidebarContext } from "./sidebarSheet";

/**
 * 로그인 뒤 레이아웃(스펙 2.4): 사이드바 + 연결 배너 + 페이지. 768px 미만이면 사이드바를 왼쪽 시트로 접고,
 * 페이지 헤더가 `useOpenSidebar()` 로 여는 버튼을 그린다. 시트는 그 안에서 이동하면 닫힌다
 */
export function AppShell() {
  const narrow = useIsNarrow();
  const [sheetOpen, setSheetOpen] = useState(false);
  // 폭이 바뀌면 시트를 닫아 둔다 — 다시 좁아졌을 때 저절로 열려 있지 않게
  const [wasNarrow, setWasNarrow] = useState(narrow);
  if (wasNarrow !== narrow) {
    setWasNarrow(narrow);
    setSheetOpen(false);
  }
  const openSidebar = useCallback(() => setSheetOpen(true), []);
  const closeSidebar = useCallback(() => setSheetOpen(false), []);

  return (
    <OpenSidebarContext.Provider value={narrow ? openSidebar : undefined}>
      <div data-testid="app-shell" className="flex h-dvh bg-background text-foreground">
        {narrow ? (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="left" className="w-[260px] gap-0 p-0" aria-describedby={undefined}>
              <SheetTitle className="sr-only">채널 목록</SheetTitle>
              <Sidebar onNavigate={closeSidebar} />
            </SheetContent>
          </Sheet>
        ) : (
          <aside className="w-[260px] shrink-0 border-r">
            <Sidebar />
          </aside>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <Banners />
          <Outlet />
        </main>
      </div>
    </OpenSidebarContext.Provider>
  );
}
