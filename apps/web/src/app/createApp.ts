import type { QueryClient } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import type { NotifyTarget } from "@/realtime/handlers";
import { createQueryClient } from "./queryClient";
import { type AppRouter, channelIdOf, createAppRouter } from "./router";
import { resetClientState } from "./session";

export type AppClient = {
  queryClient: QueryClient;
  router: AppRouter;
  onUnauthorized: () => void;
  notify: NotifyTarget;
};

/** 앱 하나의 QueryClient·Router 와 401 처리. App 이 한 번 만들고, 테스트는 메모리 히스토리를 넘긴다 */
export function createApp(history?: RouterHistory): AppClient {
  const queryClient = createQueryClient(() => onUnauthorized());
  const router = createAppRouter(queryClient, history);

  /**
   * REST 401(wire `UNAUTHORIZED` 도 여기로 — 태스크 5): 클라이언트 상태를 비우고 `/login?next=<지금 경로>` 로.
   * 이미 로그인 화면이면(틀린 토큰의 401 등) 아무것도 하지 않는다 — next 를 덮거나 두 번 가지 않게.
   */
  function onUnauthorized() {
    const { pathname, href } = router.latestLocation;
    if (pathname === "/login") return;
    resetClientState(queryClient);
    void router.navigate({ to: "/login", search: { next: href }, replace: true });
  }

  /**
   * 승인 알림이 쓰는 화면 사정(설계 5.4) — 알림 코드가 라우터를 직접 들고 있지 않도록 여기서 묶는다.
   * 정체성이 고정돼야 한다(WireProvider 의 효과 의존성)
   */
  const notify: NotifyTarget = {
    currentChannelId: () => channelIdOf(router.latestLocation.pathname),
    openActivity: (channelId) => {
      void router.navigate({ to: "/c/$channelId/activity", params: { channelId } });
    },
  };

  return { queryClient, router, onUnauthorized, notify };
}
