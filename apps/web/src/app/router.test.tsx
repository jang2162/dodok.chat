import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { TooltipProvider } from "@/ui/tooltip";
import { conversationOf, shellGet } from "../../test/shellApi";
import { RouteError } from "./RouteError";
import { createQueryClient } from "./queryClient";
import { channelIdOf, conversationIdOf, createAppRouter, isPublicPath, safeNext } from "./router";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ME = { user: { id: "u", handle: "owner" }, workspaceId: "w" };

function renderAt(path: string, queryClient: QueryClient = createQueryClient(() => {})) {
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      {/* App 과 같은 Provider — 셸의 연결 상태 점이 Tooltip 을 쓴다 */}
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

it("/auth/me 가 401 이면 /login?next= 로 보낸다", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(401, { code: "UNAUTHORIZED", message: "x" })),
  );
  const router = renderAt("/agents");
  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/login");
  expect(router.state.location.search).toEqual({ next: "/agents" });
});

it("로그인돼 있으면 앱 레이아웃 안의 페이지가 뜬다", async () => {
  vi.stubGlobal(
    "fetch",
    // 셸(사이드바·배너·채널 헤더)이 부르는 조회는 기본 응답, 그 밖은 me
    vi.fn<typeof fetch>(async (input, init) => shellGet(input, init) ?? json(200, ME)),
  );
  renderAt("/agents");
  expect(await screen.findByTestId("page-agents")).toBeInTheDocument();
  expect(screen.getByTestId("app-shell")).toContainElement(screen.getByTestId("page-agents"));
});

it("/c/$channelId/s/$conversationId/settings 는 세션 화면의 Outlet 자리에 설정 패널을 둔다", async () => {
  vi.stubGlobal(
    "fetch",
    // 셸(사이드바·배너·채널 헤더)이 부르는 조회는 기본 응답, 그 밖은 me
    vi.fn<typeof fetch>(async (input, init) => shellGet(input, init) ?? json(200, ME)),
  );
  renderAt("/c/abc/s/abc/settings");
  const settings = await screen.findByTestId("page-channel-panel");
  expect(screen.getByTestId("page-channel")).toContainElement(settings);
});

describe("채널 주소 — 세션으로 넘긴다(채널 세션 스펙 「웹」 장)", () => {
  const SESSION = "01a00000-0000-7000-8000-000000003001";
  /** 셸 기본 응답 + 그 채널의 열린 세션 목록(최근 활동순) — 목록 조회 주소를 모은다 */
  function serve(sessions: Array<{ id: string }>) {
    const lists: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (/\/channels\/abc\/conversations/.test(url)) {
          lists.push(url);
          return json(200, { conversations: sessions.map((c) => conversationOf("abc", c)) });
        }
        return shellGet(input, init) ?? json(200, ME);
      }),
    );
    return lists;
  }

  it("/c/<ch> 는 열린 세션 가운데 최근 활동한 것으로 바꿔 간다(replace — 뒤로 가기가 채널 주소에 걸리지 않게)", async () => {
    const lists = serve([{ id: SESSION }, { id: "abc" }]);
    const router = renderAt("/c/abc");
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/abc/s/${SESSION}`));
    expect(lists).toEqual(["/api/v1/channels/abc/conversations?status=open"]);
    expect(router.history.length).toBe(1);
  });

  it("열린 세션이 없으면 새 세션 창(/s/new)으로", async () => {
    serve([]);
    const router = renderAt("/c/abc");
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/abc/s/new"));
    expect(await screen.findByTestId("page-channel")).toBeInTheDocument();
  });

  it("세션 전의 채널 탭 주소(/c/<ch>/settings·activity)는 최근 세션의 같은 탭으로", async () => {
    serve([{ id: SESSION }]);
    const router = renderAt("/c/abc/settings");
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/abc/s/${SESSION}/settings`));
    expect(await screen.findByTestId("page-channel-panel")).toBeInTheDocument();
  });

  it("세션 전의 스레드 주소(/c/<ch>/t/<root>)는 그 채널의 「이전 대화」(id = 채널 id)의 스레드로 — 목록을 묻지 않는다", async () => {
    const lists = serve([{ id: SESSION }]);
    const router = renderAt("/c/abc/t/root1");
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/abc/s/abc/t/root1"));
    expect(lists).toEqual([]);
  });

  it("/c/<ch>/s/<conv>/t/<root> 새로고침은 그 세션과 그 스레드 패널을 연다", async () => {
    serve([{ id: SESSION }]);
    const router = renderAt(`/c/abc/s/${SESSION}/t/root1`);
    const panel = await screen.findByTestId("page-channel-panel");
    expect(panel).toHaveAttribute("data-panel-tab", "thread");
    expect(router.state.location.pathname).toBe(`/c/abc/s/${SESSION}/t/root1`);
  });

  it("conversationIdOf — 세션 주소의 대화 id(새 세션 창이면 new), 채널 주소·설정이면 없다", () => {
    expect(conversationIdOf(`/c/abc/s/${SESSION}/t/x`)).toBe(SESSION);
    expect(conversationIdOf("/c/abc/s/new")).toBe("new");
    expect(conversationIdOf("/c/abc")).toBeUndefined();
    expect(conversationIdOf("/settings/account")).toBeUndefined();
  });
});

it("/auth/me 가 네트워크 실패면 재시도 뒤 오류 화면 — 「다시 시도」로 복구한다", async () => {
  let up = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (!up) throw new TypeError("Failed to fetch");
    return shellGet(input, init) ?? json(200, ME);
  });
  vi.stubGlobal("fetch", fetch);
  // React 오류 경계·라우터가 잡은 오류를 console 에 찍는다 — 예상한 것이라 조용히
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const queryClient = createQueryClient(() => {});
  queryClient.setQueryDefaults(qk.me, { retryDelay: 0 });
  renderAt("/agents", queryClient);

  expect(await screen.findByText("서버에 연결할 수 없습니다")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(screen.queryByTestId("page-agents")).not.toBeInTheDocument();

  up = true;
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByTestId("page-agents")).toBeInTheDocument();
});

it("오류 화면은 코드 오류(TypeError)를 서버 연결 문제로 보지 않는다", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const root = createRootRoute({
    beforeLoad: () => {
      throw new TypeError("Cannot read properties of undefined");
    },
    errorComponent: RouteError,
  });
  render(<RouterProvider router={createRouter({ routeTree: root, history: createMemoryHistory() })} />);
  expect(await screen.findByText("화면을 표시할 수 없습니다")).toBeInTheDocument();
});

// 승인 알림이 「같은 채널을 보고 있는가」를 가리는 근거(설계 5.4)
it("channelIdOf 는 채널 경로와 그 아래 탭에서만 채널 id 를 준다", () => {
  expect(channelIdOf("/c/abc")).toBe("abc");
  expect(channelIdOf("/c/abc/activity")).toBe("abc");
  expect(channelIdOf("/c/abc/settings")).toBe("abc");
  for (const other of ["/", "/agents", "/login", "/c", "/c/"]) {
    expect(channelIdOf(other)).toBeUndefined();
  }
});

it("isPublicPath 는 가입·재설정 링크(/join/…·/reset/…)만 로그인 없이 여는 화면으로 본다", () => {
  expect(isPublicPath("/join/dit_x")).toBe(true);
  expect(isPublicPath("/reset/drt_x")).toBe(true);
  for (const other of ["/login", "/", "/c/abc", "/joiner/x", "/c/join/x", "/join", "/reset"])
    expect(isPublicPath(other)).toBe(false);
});

it("safeNext 는 앱 안 경로만 받는다", () => {
  expect(safeNext("/c/abc/settings")).toBe("/c/abc/settings");
  expect(safeNext("/agents?x=1#y")).toBe("/agents?x=1#y");
  expect(safeNext("/")).toBe("/");
  for (const bad of [
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "agents",
    "",
    "/login",
    "/login?next=/a",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\x00x",
    42,
  ]) {
    expect(safeNext(bad)).toBeUndefined();
  }
  expect(safeNext("/loginx")).toBe("/loginx");
});

it("next 의 제어문자 변형(/\\t/evil.example)은 safeNext 가 버린다 — 로그인 뒤 앱 안 `/` 에 머문다", async () => {
  // 걸러 두지 않으면 @tanstack/history 의 parseHref 가 탭을 지우고 `//` 머리를 접어 앱 안 `/evil.example`(Not Found)로 간다
  vi.stubGlobal(
    "fetch",
    // 셸(사이드바·배너·채널 헤더)이 부르는 조회는 기본 응답, 그 밖은 me
    vi.fn<typeof fetch>(async (input, init) => shellGet(input, init) ?? json(200, ME)),
  );
  const router = renderAt(`/login?next=${encodeURIComponent("/\t/evil.example")}`);
  expect(await screen.findByTestId("page-home")).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/");
  expect(router.history.location.href).toBe("/");
});

it("없는 경로는 한 줄 안내와 첫 화면 링크(defaultNotFoundComponent) — 로그인 여부와 상관없이 셸 밖", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => shellGet(input, init) ?? json(200, ME)),
  );
  renderAt("/nope/deeper");
  expect(await screen.findByRole("heading", { name: "페이지를 찾을 수 없습니다" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "첫 화면으로" })).toHaveAttribute("href", "/");
  expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
});
