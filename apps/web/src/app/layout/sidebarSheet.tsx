import { MenuIcon } from "lucide-react";
import { type RefObject, createContext, useCallback, useContext } from "react";
import { useIsOwner } from "@/api/queries";
import { useOpsStatus } from "@/features/ops/queries";
import { Button } from "@/ui/button";

/**
 * 좁은 화면(768px 미만)에서 사이드바 시트를 여는 함수 — 넓은 화면이면 undefined. AppShell 이 넣는다.
 * 페이지 헤더는 이 값이 있을 때만 메뉴 버튼을 그린다(배너는 시트를 열 일이 없다)
 */
export const OpenSidebarContext = createContext<(() => void) | undefined>(undefined);

/**
 * 지금 화면의 메뉴 버튼 — 시트가 닫히면 AppShell 이 초점을 여기로 돌려준다. 시트에 SheetTrigger 가 없어 Radix 가
 * 되돌릴 곳을 모르고, 링크로 다른 화면에 가면 연 버튼은 이미 없다. `pendingFocus` 는 「그 화면의 버튼이 뜨면
 * 초점을 달라」는 표시다 — 화면 조각(lazy)을 받는 동안에는 받을 버튼이 아직 없다
 */
export type SidebarTrigger = {
  ref: RefObject<HTMLButtonElement | null>;
  pendingFocus: RefObject<boolean>;
};
export const SidebarTriggerContext = createContext<SidebarTrigger | undefined>(undefined);

export const useOpenSidebar = (): (() => void) | undefined => useContext(OpenSidebarContext);

/**
 * 페이지 헤더 왼쪽의 「채널 목록 열기」 — 넓은 화면에서는 아무것도 그리지 않는다. 좁은 화면에서는 사이드바의 「운영」 배지가
 * 서랍 안에 숨으므로, owner 에게 확인 안 한 warn·error 가 있으면 버튼에 점을 찍고 이름에 그 수를 싣는다(브라우저 검증 O3)
 */
export function OpenSidebarButton() {
  const openSidebar = useOpenSidebar();
  const owner = useIsOwner();
  const unacked = useOpsStatus({ enabled: owner && openSidebar !== undefined }).data?.unacked;
  const n = owner && unacked ? unacked.warn + unacked.error : 0;
  const trigger = useContext(SidebarTriggerContext);
  const ref = useCallback(
    (el: HTMLButtonElement | null) => {
      if (!trigger) return;
      trigger.ref.current = el;
      if (!el || !trigger.pendingFocus.current) return;
      trigger.pendingFocus.current = false;
      // 초점을 잃은 채로 화면이 바뀐 때만 이어받는다 — 사용자가 다른 곳을 보고 있으면 뺏지 않는다
      if (document.activeElement === document.body) el.focus();
    },
    [trigger],
  );
  if (!openSidebar) return null;
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon-sm"
      aria-label={n > 0 ? `채널 목록 열기 (확인 안 한 운영 사건 ${n})` : "채널 목록 열기"}
      className="relative"
      onClick={openSidebar}
    >
      <MenuIcon />
      {n > 0 && (
        <span
          data-ops-dot
          aria-hidden
          className="absolute top-0.5 right-0.5 size-2 rounded-full bg-destructive ring-2 ring-background"
        />
      )}
    </Button>
  );
}
