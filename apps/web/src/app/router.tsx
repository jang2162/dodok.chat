import type { QueryClient } from "@tanstack/react-query";
import {
  type RouterHistory,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { ApiRequestError } from "@/api/http";
import { meQuery } from "@/api/queries";
import { AgentsPage } from "@/features/agents/AgentsPage";
import { LoginPage } from "@/features/auth/LoginPage";
import { HomeRedirect } from "@/features/channels/HomeRedirect";
import { ChannelPage } from "@/features/messages/ChannelPage";
import { ChannelSettingsPanel } from "@/features/settings/ChannelSettingsPanel";
import { RouteError } from "./RouteError";
import { AppShell } from "./layout/AppShell";

type Ctx = { queryClient: QueryClient };

/** `next` 는 앱 안 경로만 받는다 — `//x`·`/\x`·`https:` 같은 다른 출처와 로그인 화면 자신은 버린다 */
export function safeNext(value: unknown): string | undefined {
  return typeof value === "string" && /^\/(?![/\\])/.test(value) && !/^\/login(?:[/?#]|$)/.test(value)
    ? value
    : undefined;
}

const rootRoute = createRootRouteWithContext<Ctx>()({ component: Outlet });

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  // 키를 빼면 라우터가 원래 검색값을 합쳐 버린 next 가 되살아난다 — undefined 로 덮는다
  validateSearch: (s: Record<string, unknown>): { next?: string } => ({ next: safeNext(s.next) }),
  component: LoginPage,
});

/** 로그인 가드 레이아웃. me 의 401 은 `/login?next=`, 그 밖의 실패(네트워크·5xx)는 오류 화면 */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) {
        throw redirect({ to: "/login", search: { next: location.href } });
      }
      throw e;
    }
  },
  component: AppShell,
  errorComponent: RouteError,
});

export const indexRoute = createRoute({ getParentRoute: () => appRoute, path: "/", component: HomeRedirect });
export const channelRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/c/$channelId",
  component: ChannelPage,
});
export const channelSettingsRoute = createRoute({
  getParentRoute: () => channelRoute,
  path: "settings",
  component: ChannelSettingsPanel,
});
export const agentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/agents",
  component: AgentsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([indexRoute, channelRoute.addChildren([channelSettingsRoute]), agentsRoute]),
]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({ routeTree, context: { queryClient }, ...(history ? { history } : {}) });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
