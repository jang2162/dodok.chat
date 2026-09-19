import { MenuIcon } from "lucide-react";
import { createContext, useContext } from "react";
import { Button } from "@/ui/button";

/**
 * 좁은 화면(768px 미만)에서 사이드바 시트를 여는 함수 — 넓은 화면이면 undefined. AppShell 이 넣는다.
 * 페이지 헤더는 이 값이 있을 때만 메뉴 버튼을 그린다(배너는 시트를 열 일이 없다)
 */
export const OpenSidebarContext = createContext<(() => void) | undefined>(undefined);

export const useOpenSidebar = (): (() => void) | undefined => useContext(OpenSidebarContext);

/** 페이지 헤더 왼쪽의 「채널 목록 열기」 — 넓은 화면에서는 아무것도 그리지 않는다 */
export function OpenSidebarButton() {
  const openSidebar = useOpenSidebar();
  if (!openSidebar) return null;
  return (
    <Button variant="ghost" size="icon-sm" aria-label="채널 목록 열기" onClick={openSidebar}>
      <MenuIcon />
    </Button>
  );
}
