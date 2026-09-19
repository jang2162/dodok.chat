import { Outlet } from "@tanstack/react-router";

/** 자리표시 — 태스크 6 이 사이드바·헤더를 채운다 */
export function AppShell() {
  return (
    <div data-testid="app-shell">
      <Outlet />
    </div>
  );
}
