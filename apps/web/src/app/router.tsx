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
import { conversationsQuery, meQuery } from "@/api/queries";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { SETTINGS_SCROLL_ID, SettingsIndex, SettingsLayout } from "@/features/settings-shell/SettingsLayout";
import { NotFound } from "./NotFound";
import { RouteError } from "./RouteError";
import { AppShell, PAGE_SCROLL_ID } from "./layout/AppShell";

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
 * 지금 보고 있는 채널 — `/c/<id>` 와 그 아래(세션·설정·활동·스레드 탭). presence 가 「어느 채널을 보고 있는가」를
 * 알릴 때 쓴다(스펙 5.3). 라우터 바깥(realtime)에서 부르므로 경로 모양만 본다
 */
export const channelIdOf = (pathname: string): string | undefined => /^\/c\/([^/]+)/.exec(pathname)?.[1];

/**
 * 지금 보고 있는 세션 — `/c/<채널>/s/<대화>` 와 그 아래. 새 세션 창이면 `NEW_CONVERSATION`("new"). 승인 알림이 「같은 세션을 보고
 * 있는가」를 가릴 때 쓴다(채널 세션 계획 판정 PS7)
 */
export const conversationIdOf = (pathname: string): string | undefined =>
  /^\/c\/[^/]+\/s\/([^/]+)/.exec(pathname)?.[1];

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

/**
 * 초대 가입·비밀번호 재설정(팀 스펙 6장) — 로그인 없이 여는 링크라 가드 밖. 토큰은 경로에 있지만 API 에는 본문으로 보내고,
 * 끝나면 주소를 바꿔 걷는다(features/auth `useFinishInvite`)
 */
export const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/join/$token",
  component: lazyPage(() => import("@/features/auth/JoinPage"), "JoinPage"),
});
export const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset/$token",
  component: lazyPage(() => import("@/features/auth/ResetPage"), "ResetPage"),
});

/**
 * 로그인 없이 여는 화면인가 — 위 두 라우트(`/join/…`·`/reset/…`). 끊긴 세션의 401(createApp `onUnauthorized`)은 이 화면에서
 * 로그인으로 보내지 않는다: 계정이 없는 사람을 쫓아내고, 경로의 토큰을 `next` 로 옮기게 된다
 */
export const isPublicPath = (pathname: string): boolean => /^\/(?:join|reset)\//.test(pathname);

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
/**
 * 채널 주소를 세션으로 넘긴다(채널 세션 스펙 「웹」 장) — 열린 세션 가운데 최근 활동한 것(목록 REST 는 최근 활동순), 열린 세션이 없으면
 * 새 세션 창. 기록을 바꿔 쓴다(뒤로 가기가 채널 주소에 걸려 다시 넘겨지지 않게). 화면을 그리기 전에 넘긴다 — 사이드바에서 채널을 옮길 때
 * 세션 화면이 그대로 남아 머리·작성기·초점이 갈아 끼워지지 않게. 목록을 받지 못하면(없는 채널·네트워크) 넘기지 않고 화면이 그 사정을
 * 그린다(`ChannelRedirect`). `tail` 은 세션 전의 채널 탭 주소의 탭
 */
async function toLatestSession(qc: QueryClient, channelId: string, tail?: "settings" | "activity") {
  let first: string | undefined;
  try {
    first = (await qc.fetchQuery({ ...conversationsQuery(channelId, "open"), staleTime: 0 })).conversations[0]
      ?.id;
  } catch {
    return;
  }
  const params = { channelId, conversationId: first ?? NEW_CONVERSATION };
  if (tail === "settings")
    throw redirect({ to: "/c/$channelId/s/$conversationId/settings", params, replace: true });
  if (tail === "activity")
    throw redirect({ to: "/c/$channelId/s/$conversationId/activity", params, replace: true });
  throw redirect({ to: "/c/$channelId/s/$conversationId", params, replace: true });
}

/** 채널 — 화면은 세션(`s/$conversationId`) 아래에 있다. 채널 주소 자체는 최근 세션으로 넘긴다(`channelIndexRoute`) */
export const channelRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/c/$channelId",
  component: Outlet,
});
/** `/c/<채널>` — 최근 세션으로 넘긴다(`toLatestSession`). 화면은 넘기지 못했을 때의 사정만 그린다 */
export const channelIndexRoute = createRoute({
  getParentRoute: () => channelRoute,
  path: "/",
  beforeLoad: ({ context, params }) => toLatestSession(context.queryClient, params.channelId),
  component: lazyPage(() => import("@/features/messages/ChannelRedirect"), "ChannelRedirect"),
});
/**
 * 세션 화면(채널 세션 계획 판정 PS6): 헤더 · 그 세션의 메시지 목록 · 작성기 · 오른쪽 패널. `new` 는 아직 대화가 없는 새 세션 창 —
 * 첫 보내기가 세션을 만들고 그 세션 주소로 바꿔 간다(`useSendMessage`)
 */
export const conversationRoute = createRoute({
  getParentRoute: () => channelRoute,
  path: "s/$conversationId",
  component: lazyPage(() => import("@/features/messages/ChannelPage"), "ChannelPage"),
});
export const channelSettingsRoute = createRoute({
  getParentRoute: () => conversationRoute,
  path: "settings",
  component: lazyPage(() => import("@/features/settings/ChannelSettingsPanel"), "ChannelSettingsPanel"),
});
export const channelActivityRoute = createRoute({
  getParentRoute: () => conversationRoute,
  path: "activity",
  component: lazyPage(() => import("@/features/activity/ActivityPanel"), "ActivityPanel"),
});
/**
 * 스레드 패널(스레드·검색 스펙 4.2) — 설정·활동과 같은 오른쪽 패널 자리의 탭 하나. 새로고침·푸시 링크로 바로 열린다.
 * `rootId` 는 그 세션의 루트 메시지 id — 답글 id·다른 세션의 루트면 서버가 없는 스레드로 답한다(패널이 「찾을 수 없습니다」)
 */
export const channelThreadRoute = createRoute({
  getParentRoute: () => conversationRoute,
  path: "t/$rootId",
  component: lazyPage(() => import("@/features/threads/ThreadPanel"), "ThreadPanel"),
});
/**
 * 세션 전의 채널 주소(즐겨찾기·옛 알림 링크·채널 만들기 뒤의 설정) — 최근 세션의 같은 탭으로 넘긴다. 기록을 바꿔 쓴다(뒤로 가기가
 * 이 주소로 돌아와 다시 넘겨지지 않게)
 */
export const legacyChannelSettingsRoute = createRoute({
  getParentRoute: () => channelRoute,
  path: "settings",
  beforeLoad: ({ context, params }) => toLatestSession(context.queryClient, params.channelId, "settings"),
  component: lazyPage(() => import("@/features/messages/ChannelRedirect"), "ChannelSettingsRedirect"),
});
export const legacyChannelActivityRoute = createRoute({
  getParentRoute: () => channelRoute,
  path: "activity",
  beforeLoad: ({ context, params }) => toLatestSession(context.queryClient, params.channelId, "activity"),
  component: lazyPage(() => import("@/features/messages/ChannelRedirect"), "ChannelActivityRedirect"),
});
/**
 * 세션 전의 스레드 주소(`/c/<채널>/t/<루트>`) — 그때의 글은 마이그레이션이 채널마다 만든 「이전 대화」에 있고 그 대화의 id 는 채널 id 다
 * (채널 세션 계획 Global Constraints). 그래서 세션을 찾지 않고 바로 그 대화로 넘긴다
 */
export const legacyChannelThreadRoute = createRoute({
  getParentRoute: () => channelRoute,
  path: "t/$rootId",
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/c/$channelId/s/$conversationId/t/$rootId",
      params: { channelId: params.channelId, conversationId: params.channelId, rootId: params.rootId },
      replace: true,
    });
  },
});
/**
 * 설정(설정 통합 스펙 「설정 통합」 장, 계획 판정 PS5) — 레이아웃 라우트 하나 아래 탭 라우트. 넓은 화면의 탭 목록은 레이아웃이
 * 그리고, `/settings` 자체는 좁은 화면이면 탭 목록 페이지·넓은 화면이면 「내 계정」으로 넘긴다(`SettingsIndex`).
 * 채널 아래의 `settings` 자식(`/c/$channelId/settings`)과 겹치지 않는 최상위 경로다. 레이아웃은 조각으로 나누지 않는다 — 탭 목록은
 * 사이드바가 이미 받은 것(역할·운영 상태)만 쓴다
 */
export const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: SettingsLayout,
});
export const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  component: SettingsIndex,
});
export const accountRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "account",
  component: lazyPage(() => import("@/features/settings-shell/AccountPage"), "AccountPage"),
});
export const notificationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "notifications",
  component: lazyPage(() => import("@/features/settings-shell/NotificationsPage"), "NotificationsPage"),
});
export const agentsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "agents",
  component: lazyPage(() => import("@/features/agents/AgentsPage"), "AgentsPage"),
});
/** 보관한 채널(누구나 — 「보관 해제」만 admin 이상, 채널 보관 스펙 「웹」 절) */
export const channelsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "channels",
  component: lazyPage(() => import("@/features/settings-shell/ChannelsPage"), "ChannelsPage"),
});
/** 자동화(admin 이상 — 페이지가 가른다, 자동화 스펙 「웹」 장) */
export const automationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "automations",
  component: lazyPage(() => import("@/features/automations/AutomationsPage"), "AutomationsPage"),
});
/** 멤버 관리(admin 이상 — 페이지가 가른다, 팀 스펙 6장) */
export const membersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "members",
  component: lazyPage(() => import("@/features/members/MembersPage"), "MembersPage"),
});
/** 연결 설정(owner 만 — 페이지가 가른다) */
export const connectionRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "connection",
  component: lazyPage(() => import("@/features/setup/ConnectionPage"), "ConnectionPage"),
});
/** 운영(admin 이상 — 페이지가 가른다, 스펙 7장·팀 스펙 2장) */
export const operationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "operations",
  component: lazyPage(() => import("@/features/ops/OpsPage"), "OpsPage"),
});

/**
 * 옛 에이전트 주소 — 즐겨찾기·푸시 알림 링크가 깨지지 않게 넘긴다. 로그인 가드(appRoute) 아래라 로그인 전이면 `next` 가 이 옛 주소로
 * 남고, 로그인 뒤 다시 여기를 지나 넘어간다. 기록을 바꿔 쓴다 — 뒤로 가기가 이 주소로 돌아와 다시 넘겨지지 않게
 */
export const legacyAgentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/agents",
  beforeLoad: () => {
    throw redirect({ to: "/settings/agents", replace: true });
  },
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  joinRoute,
  resetRoute,
  appRoute.addChildren([
    indexRoute,
    channelRoute.addChildren([
      channelIndexRoute,
      conversationRoute.addChildren([channelSettingsRoute, channelActivityRoute, channelThreadRoute]),
      legacyChannelSettingsRoute,
      legacyChannelActivityRoute,
      legacyChannelThreadRoute,
    ]),
    settingsRoute.addChildren([
      settingsIndexRoute,
      accountRoute,
      notificationsRoute,
      agentsRoute,
      channelsRoute,
      automationsRoute,
      membersRoute,
      connectionRoute,
      operationsRoute,
    ]),
    legacyAgentsRoute,
  ]),
]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultNotFoundComponent: NotFound,
    scrollToTopSelectors: [`#${PAGE_SCROLL_ID}`, `#${SETTINGS_SCROLL_ID}`],
    ...(history ? { history } : {}),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
