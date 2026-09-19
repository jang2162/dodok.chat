import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/api/http";
import { qk } from "@/api/queries";
import { useWireStatus } from "@/realtime/wire";
import { createdSockets } from "../../test/fakeSocket";
import { shellGet } from "../../test/shellApi";
import { App } from "./App";
import { createApp } from "./createApp";
import { registerSessionReset } from "./session";

// 등록한 정리는 단언이 실패해도 다음 테스트로 새지 않게 여기서 푼다
const unregisters: Array<() => void> = [];
afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
  vi.unstubAllGlobals();
});

/** 세션 정리 스파이를 등록한다(해제는 afterEach) */
function spyReset() {
  const reset = vi.fn();
  unregisters.push(registerSessionReset(reset));
  return reset;
}

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
  const reset = spyReset();
  const { history, moves } = renderApp("/agents");
  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  expect(history.location.pathname).toBe("/login");
  expect(new URLSearchParams(history.location.search).get("next")).toBe("/agents");
  expect(moves).toHaveLength(1);
  // onUnauthorized(상태 비우기·이동)는 타지 않는다 — 가드의 redirect 만
  expect(reset).not.toHaveBeenCalled();
});

it("앱 안 쿼리의 401 은 상태를 비우고 /login?next=<지금 경로> 로 한 번 보낸다", async () => {
  let expired = false;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      if (expired) return json(401, UNAUTHORIZED);
      if (String(input) === "/api/v1/auth/me") return json(200, ME);
      return shellGet(input, init) ?? json(200, { channels: [] });
    }),
  );
  const { app, history, moves } = renderApp("/c/abc");
  expect(await screen.findByTestId("page-channel")).toBeInTheDocument();
  const reset = spyReset();

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

it("여러 쿼리가 함께 네트워크 실패해도 화면의 토스트는 「서버에 연결할 수 없습니다」 하나", async () => {
  let down = false;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      if (down) throw new TypeError("Failed to fetch");
      if (String(input) === "/api/v1/auth/me") return json(200, ME);
      const shell = shellGet(input, init);
      if (shell) return shell;
      throw new Error(`예상 밖 요청 ${String(input)}`);
    }),
  );
  const { app } = renderApp("/agents");
  expect(await screen.findByTestId("page-agents")).toBeInTheDocument();

  down = true;
  const fail = (key: string) =>
    app.queryClient
      .fetchQuery({ queryKey: [key], queryFn: () => api("GET", `/${key}`), retryDelay: 0 })
      .catch(() => {});
  await Promise.all([fail("channels"), fail("agents"), fail("adapter")]);
  // sonner 는 토스트 호출마다 setTimeout 뒤에 그린다 — 큐에 쌓인 것이 다 그려진 뒤에 센다
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

  expect(screen.getAllByText("서버에 연결할 수 없습니다")).toHaveLength(1);
});

const wireUnauthorized = () =>
  Object.assign(new Error("UNAUTHORIZED"), { data: { code: "UNAUTHORIZED", message: "invalid session" } });

it("wire UNAUTHORIZED 이고 세션도 끝났으면(me 401) 상태를 비우고 /login?next=<지금 경로> 로 한 번 보낸다", async () => {
  let expired = false;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      if (expired) return json(401, UNAUTHORIZED);
      if (String(input) === "/api/v1/auth/me") return json(200, ME);
      return shellGet(input, init) ?? json(200, { channels: [] });
    }),
  );
  const { history, moves } = renderApp("/c/abc");
  expect(await screen.findByTestId("page-channel")).toBeInTheDocument();
  await waitFor(() => expect(createdSockets).toHaveLength(1));
  const reset = spyReset();

  expired = true;
  act(() => createdSockets[0]?.serverEmit("connect_error", wireUnauthorized()));

  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  expect(history.location.pathname).toBe("/login");
  expect(new URLSearchParams(history.location.search).get("next")).toBe("/c/abc");
  expect(moves).toHaveLength(1);
  expect(reset).toHaveBeenCalled();
  expect(createdSockets[0]?.calls.disconnect).toBeGreaterThanOrEqual(1);
});

it("wire UNAUTHORIZED 인데 REST 세션이 살아 있으면(me 200) 로그인으로 보내지 않고 wire 상태만 rejected", async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input) === "/api/v1/auth/me") return json(200, ME);
    return shellGet(input, init) ?? json(200, { channels: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { moves } = renderApp("/c/abc");
  expect(await screen.findByTestId("page-channel")).toBeInTheDocument();
  await waitFor(() => expect(createdSockets).toHaveLength(1));
  const meCalls = () => fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/v1/auth/me").length;
  const before = meCalls();

  act(() => createdSockets[0]?.serverEmit("connect_error", wireUnauthorized()));

  await waitFor(() => expect(useWireStatus.getState().status).toBe("rejected"));
  expect(meCalls()).toBe(before + 1);
  expect(moves).toHaveLength(0);
  expect(screen.getByTestId("page-channel")).toBeInTheDocument();
  expect(createdSockets).toHaveLength(1);
});
