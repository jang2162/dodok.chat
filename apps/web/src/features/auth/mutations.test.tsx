import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { App } from "@/app/App";
import { type AppClient, createApp } from "@/app/createApp";
import { registerSessionReset } from "@/app/session";
import { useLogout } from "./mutations";

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ME = { user: { id: "u", handle: "owner" }, workspaceId: "w" };

/** /agents 에 로그인한 채로 App 을 띄우고, 같은 QueryClient·Router 위에서 useLogout 을 건다 */
async function loggedInAt(path: string, logout: () => Response) {
  let loggedOut = false;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "/api/v1/auth/logout") {
        loggedOut = true;
        return logout();
      }
      if (url === "/api/v1/auth/me")
        return loggedOut ? json(401, { code: "UNAUTHORIZED", message: "x" }) : json(200, ME);
      throw new Error(`예상 밖 요청 ${url}`);
    }),
  );
  const history = createMemoryHistory({ initialEntries: [path] });
  const app = createApp(history);
  const moves: string[] = [];
  history.subscribe(({ location }) => moves.push(location.href));
  render(<App app={app} />);
  expect(await screen.findByTestId("page-agents")).toBeInTheDocument();
  const { result } = renderHook(() => useLogout(), { wrapper: wrapperFor(app) });
  return { app, history, moves, logout: result };
}

const wrapperFor = (app: AppClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={app.queryClient}>
        <RouterContextProvider router={app.router}>{children}</RouterContextProvider>
      </QueryClientProvider>
    );
  };

it("로그아웃은 등록된 정리·Query 캐시를 비우고 /login 으로 간다(next 없음)", async () => {
  const { app, history, moves, logout } = await loggedInAt("/agents", () => json(200, { ok: true }));
  const reset = vi.fn();
  const unregister = registerSessionReset(reset);

  act(() => logout.current.mutate());

  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  expect(history.location.pathname).toBe("/login");
  expect(history.location.search).toBe("");
  expect(moves).toHaveLength(1);
  expect(reset).toHaveBeenCalledTimes(1);
  expect(app.queryClient.getQueryData(qk.me)).toBeUndefined();
  unregister();
});

it("세션이 이미 끊겨 로그아웃이 401 이어도 로그인 화면으로 한 번만 간다", async () => {
  const { history, moves, logout } = await loggedInAt("/agents", () =>
    json(401, { code: "UNAUTHORIZED", message: "x" }),
  );

  act(() => logout.current.mutate());

  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  expect(history.location.pathname).toBe("/login");
  expect(moves).toHaveLength(1);
});
