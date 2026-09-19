import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { RouteError } from "./RouteError";
import { createQueryClient } from "./queryClient";
import { createAppRouter, safeNext } from "./router";

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
      <RouterProvider router={router} />
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
    vi.fn(async () => json(200, ME)),
  );
  renderAt("/agents");
  expect(await screen.findByTestId("page-agents")).toBeInTheDocument();
  expect(screen.getByTestId("app-shell")).toContainElement(screen.getByTestId("page-agents"));
});

it("/c/$channelId/settings 는 채널 화면의 Outlet 자리에 설정 패널을 둔다", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(200, ME)),
  );
  renderAt("/c/abc/settings");
  const settings = await screen.findByTestId("page-channel-settings");
  expect(screen.getByTestId("page-channel")).toContainElement(settings);
});

it("/auth/me 가 네트워크 실패면 재시도 뒤 오류 화면 — 「다시 시도」로 복구한다", async () => {
  let up = false;
  const fetch = vi.fn(async () => {
    if (!up) throw new TypeError("Failed to fetch");
    return json(200, ME);
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
    vi.fn(async () => json(200, ME)),
  );
  const before = window.location.href;
  const router = renderAt(`/login?next=${encodeURIComponent("/\t/evil.example")}`);
  expect(await screen.findByTestId("page-home")).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/");
  expect(router.history.location.href).toBe("/");
  expect(window.location.href).toBe(before); // 문서 이동 없음
});
