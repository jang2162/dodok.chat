import type { QueryClient } from "@tanstack/react-query";
import type { RouterHistory } from "@tanstack/react-router";
import { captureInstallPrompt } from "@/pwa/install";
import { safeNotificationUrl } from "@/pwa/sw-logic";
import type { AppNotifyTarget } from "@/realtime/WireProvider";
import { createQueryClient } from "./queryClient";
import { type AppRouter, channelIdOf, createAppRouter, isPublicPath } from "./router";
import { resetClientState } from "./session";

export type AppClient = {
  queryClient: QueryClient;
  router: AppRouter;
  onUnauthorized: () => void;
  notify: AppNotifyTarget;
};

/** 앱 하나의 QueryClient·Router 와 401 처리. App 이 한 번 만들고, 테스트는 메모리 히스토리를 넘긴다 */
export function createApp(history?: RouterHistory): AppClient {
  const queryClient = createQueryClient(() => onUnauthorized());
  const router = createAppRouter(queryClient, history);

  /**
   * REST 401(wire `UNAUTHORIZED` 도 여기로 — 태스크 5): 클라이언트 상태를 비우고 `/login?next=<지금 경로>` 로.
   * 이미 로그인 화면이면(틀린 토큰의 401 등) 아무것도 하지 않는다 — next 를 덮거나 두 번 가지 않게.
   * 이동 막기(`useBlocker` — 토큰 원문 대화상자 등)는 건너뛴다: 세션이 끝났으니 머무를 까닭이 없고, 캐시를 비우면 막던 화면도
   * 어차피 사라진다.
   * 로그인 없이 여는 화면(`/join`·`/reset` — 오프라인 사본의 옛 me 로 소켓이 붙은 채 연 링크)이면 상태만 비우고 머문다
   */
  function onUnauthorized() {
    const { pathname, href } = router.latestLocation;
    if (pathname === "/login") return;
    resetClientState(queryClient);
    if (isPublicPath(pathname)) return;
    void router.navigate({ to: "/login", search: { next: href }, replace: true, ignoreBlocker: true });
  }

  /**
   * 승인 알림이 쓰는 화면 사정(설계 5.4) — 알림 코드가 라우터를 직접 들고 있지 않도록 여기서 묶는다.
   * 정체성이 고정돼야 한다(WireProvider 의 효과 의존성)
   */
  const notify: AppNotifyTarget = {
    currentChannelId: () => channelIdOf(router.latestLocation.pathname),
    openActivity: (channelId) => {
      void router.navigate({ to: "/c/$channelId/activity", params: { channelId } });
    },
    // 보는 채널이 바뀌면 presence 를 다시 알린다(스펙 5.3) — 화면이 다 옮겨진 뒤(latestLocation 이 새 경로)
    onLocationChange: (fn) => router.subscribe("onResolved", fn),
  };

  // 알림 누르기(서비스 워커 notificationclick)가 이미 열린 창을 옮긴다 — 전체 새로고침 없이 라우터로(스펙 3장).
  // 서비스 워커가 한 번 거른 url 이지만 여기서도 같은 출처 채널 경로만 받는다(Review Focus 4)
  navigator.serviceWorker?.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as { type?: unknown; url?: unknown } | null;
    if (data?.type !== "navigate") return;
    void router.navigate({ href: safeNotificationUrl(data.url) });
  });

  // 「앱 설치」 — beforeinstallprompt 는 패널이 열리기 전에 올 수 있어 앱 시작 때부터 받아 둔다
  captureInstallPrompt();

  return { queryClient, router, onUnauthorized, notify };
}
