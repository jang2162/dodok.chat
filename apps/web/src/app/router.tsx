import type { QueryClient } from "@tanstack/react-query";
import {
  type RouterHistory,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import { ApiRequestError } from "@/api/http";
import { meQuery } from "@/api/queries";
import { NotFound } from "./NotFound";
import { RouteError } from "./RouteError";
import { AppShell } from "./layout/AppShell";

type Ctx = { queryClient: QueryClient };

/**
 * `next` 는 앱 안 경로만 받는다 — `//x`·`/\x`·`https:` 같은 다른 출처와 로그인 화면 자신은 버린다.
 * 제어문자가 섞인 값도 버린다: 브라우저·라우터가 탭·개행을 지우면 `/\t/x` 가 `//x` 로 읽힌다
 */
export function safeNext(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^\/(?![/\\])/.test(value) &&
    // oxlint-disable-next-line no-control-regex -- 제어문자를 찾는 것이 목적이다
    !/[\x00-\x1f\x7f]/.test(value) &&
    !/^\/login(?:[/?#]|$)/.test(value)
    ? value
    : undefined;
}

/**
 * 지금 보고 있는 채널 — `/c/<id>` 와 그 아래(설정·활동 탭). 승인 알림이 「같은 채널을 보고 있는가」를
 * 가릴 때 쓴다(설계 5.4). 라우터 바깥(realtime)에서 부르므로 경로 모양만 본다
 */
export const channelIdOf = (pathname: string): string | undefined => /^\/c\/([^/]+)/.exec(pathname)?.[1];

/**
 * 화면은 라우트 단위로 나눠 받는다 — 첫 화면(로그인)이 작성기(Tiptap)·마크다운 렌더러(Streamdown)까지 내려받지 않게.
 * 라우터가 화면을 그리기 전에 조각을 기다리므로(`preload`) 동작·순서는 같다
 */
const lazyPage = <M extends Record<string, unknown>, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
) => lazyRouteComponent(load, name);

const rootRoute = createRootRouteWithContext<Ctx>()({ component: Outlet });

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  // 키를 빼면 라우터가 원래 검색값을 합쳐 버린 next 가 되살아난다 — undefined 로 덮는다
  validateSearch: (s: Record<string, unknown>): { next?: string } => ({ next: safeNext(s.next) }),
  component: lazyPage(() => import("@/features/auth/LoginPage"), "LoginPage"),
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

export const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: lazyPage(() => import("@/features/channels/HomeRedirect"), "HomeRedirect"),
});
export const channelRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/c/$channelId",
  component: lazyPage(() => import("@/features/messages/ChannelPage"), "ChannelPage"),
});
export const channelSettingsRoute = createRoute({
  getParentRoute: () => channelRoute,
  path: "settings",
  component: lazyPage(() => import("@/features/settings/ChannelSettingsPanel"), "ChannelSettingsPanel"),
});
export const channelActivityRoute = createRoute({
  getParentRoute: () => channelRoute,
  path: "activity",
  component: lazyPage(() => import("@/features/activity/ActivityPanel"), "ActivityPanel"),
});
export const agentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/agents",
  component: lazyPage(() => import("@/features/agents/AgentsPage"), "AgentsPage"),
});

/**
 * 연결 설정(owner 만 — 페이지가 가른다). 채널 아래의 `settings` 자식(`/c/$channelId/settings`)과 겹치지 않는 최상위 경로
 */
export const connectionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/connection",
  component: lazyPage(() => import("@/features/setup/ConnectionPage"), "ConnectionPage"),
});

/** 운영(owner 만 — 페이지가 가른다, 스펙 7장) */
export const operationsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings/operations",
  component: lazyPage(() => import("@/features/ops/OpsPage"), "OpsPage"),
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    channelRoute.addChildren([channelSettingsRoute, channelActivityRoute]),
    agentsRoute,
    connectionRoute,
    operationsRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultNotFoundComponent: NotFound,
    ...(history ? { history } : {}),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
