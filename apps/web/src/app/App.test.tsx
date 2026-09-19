import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/api/http";
import { qk } from "@/api/queries";
import { App } from "./App";
import { createApp } from "./createApp";
import { registerSessionReset } from "./session";

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const UNAUTHORIZED = { code: "UNAUTHORIZED", message: "로그인이 필요하다" };
const ME = { user: { id: "u", handle: "owner" }, workspaceId: "w" };

/** 메모리 히스토리로 App 을 띄우고, 뜬 뒤의 히스토리 이동 횟수를 센다 */
function renderApp(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const app = createApp(history);
  const moves: string[] = [];
  history.subscribe(({ location }) => moves.push(location.href));
  render(<App app={app} />);
  return { app, history, moves };
}

it("로그인 안 됐으면 로그인 화면이 뜬다", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(401, UNAUTHORIZED)),
  );
  render(<App />);
  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
});

it("가드의 me 401 은 가드 한 곳이 로그인 화면으로 한 번만 보낸다 — next 를 지킨다", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(401, UNAUTHORIZED)),
  );
  const reset = vi.fn();
  const unregister = registerSessionReset(reset);
  const { history, moves } = renderApp("/agents");
  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  expect(history.location.pathname).toBe("/login");
  expect(new URLSearchParams(history.location.search).get("next")).toBe("/agents");
  expect(moves).toHaveLength(1);
  // onUnauthorized(상태 비우기·이동)는 타지 않는다 — 가드의 redirect 만
  expect(reset).not.toHaveBeenCalled();
  unregister();
});

it("앱 안 쿼리의 401 은 상태를 비우고 /login?next=<지금 경로> 로 한 번 보낸다", async () => {
  let expired = false;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      if (expired) return json(401, UNAUTHORIZED);
      if (String(input) === "/api/v1/auth/me") return json(200, ME);
      return json(200, { channels: [] });
    }),
  );
  const { app, history, moves } = renderApp("/c/abc");
  expect(await screen.findByTestId("page-channel")).toBeInTheDocument();
  const reset = vi.fn();
  const unregister = registerSessionReset(reset);

  expired = true;
  await app.queryClient
    .fetchQuery({ queryKey: qk.channels, queryFn: () => api("GET", "/channels") })
    .catch(() => {});

  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  expect(history.location.pathname).toBe("/login");
  expect(new URLSearchParams(history.location.search).get("next")).toBe("/c/abc");
  expect(moves).toHaveLength(1);
  expect(reset).toHaveBeenCalledTimes(1);
  expect(app.queryClient.getQueryData(qk.me)).toBeUndefined();
  unregister();
});

it("로그인 화면에서 틀린 토큰(401)은 이동하지 않는다 — next 를 덮지 않는다", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json(401, UNAUTHORIZED)),
  );
  const { history, moves } = renderApp("/login?next=%2Fagents");
  await userEvent.type(await screen.findByLabelText("로컬 토큰"), "wrong{Enter}");
  expect(await screen.findByText("토큰이 맞지 않습니다")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "로그인" })).toBeInTheDocument());
  expect(history.location.pathname).toBe("/login");
  expect(new URLSearchParams(history.location.search).get("next")).toBe("/agents");
  expect(moves).toHaveLength(0);
});
