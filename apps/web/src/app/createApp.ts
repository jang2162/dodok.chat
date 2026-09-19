import type { QueryClient } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import { createQueryClient } from "./queryClient";
import { type AppRouter, createAppRouter } from "./router";
import { resetClientState } from "./session";

export type AppClient = { queryClient: QueryClient; router: AppRouter; onUnauthorized: () => void };

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

  return { queryClient, router, onUnauthorized };
}
