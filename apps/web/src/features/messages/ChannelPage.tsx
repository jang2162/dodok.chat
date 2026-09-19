import { Outlet } from "@tanstack/react-router";

/** 자리표시 — 태스크 6·7 이 채운다. `<Outlet />` 자리에 설정 패널(/c/$channelId/settings)이 온다 */
export function ChannelPage() {
  return (
    <section data-testid="page-channel">
      <Outlet />
    </section>
  );
}
