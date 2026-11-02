import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { App } from "@/app/App";
import { type AppClient, createApp } from "@/app/createApp";
import { registerSessionReset } from "@/app/session";
import { fakeSubscription, pushStub, stubPush } from "../../../test/pushStubs";
import { shellGet } from "../../../test/shellApi";
import { useLogout } from "./mutations";

// 등록한 정리는 단언이 실패해도 다음 테스트로 새지 않게 여기서 푼다
const unregisters: Array<() => void> = [];
/** 이 순서로 불린 요청(메서드 경로) — 로그아웃이 서버 해지를 먼저 하는지 본다 */
let requests: string[] = [];
let push: ReturnType<typeof stubPush> | undefined;
afterEach(() => {
  vi.useRealTimers();
  for (const unregister of unregisters.splice(0)) unregister();
  push?.restore();
  push = undefined;
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ME = { user: { id: "u", handle: "owner" }, workspaceId: "w" };

/** /settings/connection 에 로그인한 채로 App 을 띄우고, 같은 QueryClient·Router 위에서 useLogout 을 건다 */
async function loggedInAt(
  path: string,
  logout: () => Response,
  pushDelete: () => Response | Promise<Response> = () => json(204, {}),
) {
  let loggedOut = false;
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/v1/push/subscriptions" && init?.method === "DELETE")
        return loggedOut ? json(401, { code: "UNAUTHORIZED", message: "x" }) : pushDelete();
      // 앱 시작 동기화(같은 사람의 구독이면 다시 등록)
      if (url === "/api/v1/push/vapid-public-key") return json(200, { publicKey: "AQIDBAUGBwg" });
      if (url === "/api/v1/push/subscriptions" && init?.method === "POST")
        return new Response(null, { status: 204 });
      if (url === "/api/v1/auth/logout") {
        loggedOut = true;
        return logout();
      }
      if (url === "/api/v1/auth/me")
        return loggedOut ? json(401, { code: "UNAUTHORIZED", message: "x" }) : json(200, ME);
      // 셸(사이드바·배너)이 부르는 조회는 기본 응답
      const shell = shellGet(input, init);
      if (shell) return shell;
      throw new Error(`예상 밖 요청 ${url}`);
    }),
  );
  const history = createMemoryHistory({ initialEntries: [path] });
  const app = createApp(history);
  const moves: string[] = [];
  history.subscribe(({ location }) => moves.push(location.href));
  render(<App app={app} />);
  expect(await screen.findByTestId("page-connection")).toBeInTheDocument();
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
  const { app, history, moves, logout } = await loggedInAt("/settings/connection", () =>
    json(200, { ok: true }),
  );
  const reset = vi.fn();
  unregisters.push(registerSessionReset(reset));

  act(() => logout.current.mutate());

  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  expect(history.location.pathname).toBe("/login");
  expect(history.location.search).toBe("");
  expect(moves).toHaveLength(1);
  expect(reset).toHaveBeenCalledTimes(1);
  expect(app.queryClient.getQueryData(qk.me)).toBeUndefined();
});

/**
 * plan.md 이월 D11 — 로그아웃 직후 마운트돼 있던 셸 쿼리(채널·에이전트·DM·어댑터 상태)가 비운 캐시를 다시 받아 401 이 몇 건 더 났다.
 * 화면을 먼저 /login 으로 내리고 그다음에 비운다 — 로그아웃 뒤 나가는 요청은 로그인 화면의 me 확인뿐이다
 */
it("로그아웃 뒤 셸 쿼리를 다시 받지 않는다 — 나가는 요청은 로그인 화면의 me 확인뿐(D11)", async () => {
  const { app, logout } = await loggedInAt("/settings/connection", () => json(200, { ok: true }));
  const reset = vi.fn();
  unregisters.push(registerSessionReset(reset));

  act(() => logout.current.mutate());

  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  const after = requests.slice(requests.indexOf("POST /api/v1/auth/logout") + 1);
  expect(after.filter((r) => r !== "GET /api/v1/auth/me")).toEqual([]);
  expect(reset).toHaveBeenCalledTimes(1);
  expect(
    app.queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.queryKey),
  ).toEqual([qk.me]);
});

it("이동 막기가 걸려 있어도 로그아웃은 상태를 비우고 /login 으로 간다(ignoreBlocker)", async () => {
  const { app, history, logout } = await loggedInAt("/settings/connection", () => json(200, { ok: true }));
  const reset = vi.fn();
  unregisters.push(registerSessionReset(reset));
  const unblock = app.router.history.block({ blockerFn: () => true, enableBeforeUnload: false });
  unregisters.push(unblock);

  act(() => logout.current.mutate());

  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  expect(history.location.pathname).toBe("/login");
  expect(reset).toHaveBeenCalledTimes(1);
  expect(app.queryClient.getQueryData(qk.me)).toBeUndefined();
});

it("세션이 이미 끊겨 로그아웃이 401 이어도 로그인 화면으로 한 번만 간다", async () => {
  const { history, moves, logout } = await loggedInAt("/settings/connection", () =>
    json(401, { code: "UNAUTHORIZED", message: "x" }),
  );

  act(() => logout.current.mutate());

  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  expect(history.location.pathname).toBe("/login");
  expect(moves).toHaveLength(1);
});

it("로그아웃이 실패해도(500) 토스트 없이 로그인 화면으로 간다", async () => {
  const toastError = vi.spyOn(toast, "error").mockImplementation(() => 0);
  const { history, logout } = await loggedInAt("/settings/connection", () =>
    json(500, { code: "INTERNAL", message: "서버 내부 오류" }),
  );

  act(() => logout.current.mutate());

  expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
  expect(history.location.pathname).toBe("/login");
  expect(toastError).not.toHaveBeenCalled();
});

describe("[Review Focus 1] 이 기기의 푸시 구독", () => {
  it("로그아웃은 서버 로그아웃 **전에** 구독을 서버에서 지우고(세션 필요) 기기에서 해지한다 — 플래그·사본도 없다", async () => {
    const sub = fakeSubscription();
    push = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem("dodok.push", "u");
    const { history, logout } = await loggedInAt("/settings/connection", () => json(200, { ok: true }));
    const reset = vi.fn();
    unregisters.push(registerSessionReset(reset));

    act(() => logout.current.mutate());

    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(history.location.pathname).toBe("/login");
    const del = requests.indexOf("DELETE /api/v1/push/subscriptions");
    const out = requests.indexOf("POST /api/v1/auth/logout");
    expect(del).toBeGreaterThanOrEqual(0);
    expect(del).toBeLessThan(out);
    expect(sub.unsubscribed).toBe(true);
    expect(pushStub.current).toBeNull();
    expect(localStorage.getItem("dodok.push")).toBeNull();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("서버 해지가 실패해도 로그아웃은 막히지 않고 기기 구독은 해지된다", async () => {
    const sub = fakeSubscription();
    push = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem("dodok.push", "u");
    const { history, logout } = await loggedInAt(
      "/settings/connection",
      () => json(200, { ok: true }),
      () => {
        throw new TypeError("Failed to fetch");
      },
    );

    act(() => logout.current.mutate());

    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(history.location.pathname).toBe("/login");
    expect(requests).toContain("POST /api/v1/auth/logout");
    expect(sub.unsubscribed).toBe(true);
    expect(localStorage.getItem("dodok.push")).toBeNull();
  });

  it("서버 해지가 끝나지 않아도 3초만 기다리고 로그아웃한다", async () => {
    const sub = fakeSubscription();
    push = stubPush({ permission: "granted", subscription: sub });
    localStorage.setItem("dodok.push", "u");
    const { logout } = await loggedInAt(
      "/settings/connection",
      () => json(200, { ok: true }),
      () => new Promise<Response>(() => {}),
    );

    // 경계를 잰다 — 3초에서 1ms 모자라면 아직, 3초가 차면 서버 로그아웃
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => logout.current.mutate());
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toContain("DELETE /api/v1/push/subscriptions");
    await vi.advanceTimersByTimeAsync(2999);
    expect(requests).not.toContain("POST /api/v1/auth/logout");
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toContain("POST /api/v1/auth/logout");
    vi.useRealTimers();

    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(requests).toContain("POST /api/v1/auth/logout");
    // 세션 정리(dropLocalPush)가 기기 구독을 해지한다
    await vi.waitFor(() => expect(sub.unsubscribed).toBe(true));
    expect(localStorage.getItem("dodok.push")).toBeNull();
  });

  it("푸시를 켜지 않았으면 서버 해지를 부르지 않는다", async () => {
    const { logout } = await loggedInAt("/settings/connection", () => json(200, { ok: true }));
    act(() => logout.current.mutate());
    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(requests.some((r) => r.includes("/push/"))).toBe(false);
  });
});
