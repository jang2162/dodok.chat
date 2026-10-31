import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { CH } from "../../test/fixtures";
import { json, ME, shellGet } from "../../test/shellApi";
import { App } from "./App";
import { createApp } from "./createApp";
import { registerSessionReset } from "./session";

type Listener = (e: MessageEvent) => void;

/** navigator.serviceWorker 의 message 리스너만 — 서비스 워커가 알림 누르기에서 보내는 것 */
function stubServiceWorkerMessages() {
  const listeners = new Set<Listener>();
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      addEventListener: (type: string, fn: Listener) => type === "message" && listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
    },
  });
  return {
    post: (data: unknown) => {
      for (const fn of listeners) fn(new MessageEvent("message", { data }));
    },
  };
}

// 등록한 정리·이동 막기는 단언이 실패해도 다음 테스트로 새지 않게 여기서 푼다
const unregisters: Array<() => void> = [];
afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
  delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("[Review Focus 4] 서비스 워커의 navigate 메시지는 라우터로 옮긴다 — 같은 출처 채널 경로만", async () => {
  const sw = stubServiceWorkerMessages();
  const history = createMemoryHistory({ initialEntries: ["/agents"] });
  const app = createApp(history);

  sw.post({ type: "navigate", url: `/c/${CH}/activity` });
  await vi.waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/activity`));

  sw.post({ type: "navigate", url: "https://evil.example/c/x" });
  await vi.waitFor(() => expect(history.location.pathname).toBe("/"));

  // 다른 종류의 메시지는 무시한다
  sw.post({ type: "other", url: `/c/${CH}` });
  sw.post(null);
  await new Promise((r) => setTimeout(r, 10));
  expect(history.location.pathname).toBe("/");
  expect(app.router).toBeDefined();
});

it("서비스 워커가 없는 브라우저에서도 만들어진다", () => {
  expect(() => createApp(createMemoryHistory({ initialEntries: ["/"] }))).not.toThrow();
});

it("notify.onLocationChange 는 경로가 바뀔 때마다 부르고, 해제하면 멈춘다", async () => {
  const history = createMemoryHistory({ initialEntries: ["/agents"] });
  const app = createApp(history);
  const seen: Array<string | undefined> = [];
  const off = app.notify.onLocationChange?.(() => seen.push(app.notify.currentChannelId()));
  await app.router.navigate({
    to: "/c/$channelId/s/$conversationId",
    params: { channelId: CH, conversationId: CH },
  });
  await vi.waitFor(() => expect(seen.at(-1)).toBe(CH));
  off?.();
  const n = seen.length;
  await app.router.navigate({ to: "/agents" });
  expect(seen).toHaveLength(n);
});

/**
 * 세션 만료 401 — 로그아웃(features/auth `leaveToLoginThenReset`)과 같은 순서: `/login?next=` 로 옮기고, 화면을 바꾸는 그 커밋에서
 * 비운다(web-ui 보고 「:626·:628 측정」 — 먼저 비우면 아직 마운트된 셸이 빈 캐시로 다시 받아 401 이 13건 났다)
 */
describe("onUnauthorized(세션 만료 401)", () => {
  /** 정리가 불릴 때마다 그때 라우터가 보던 경로를 남긴다 */
  function watchReset(app: ReturnType<typeof createApp>) {
    const at: string[] = [];
    unregisters.push(registerSessionReset(() => at.push(app.router.latestLocation.pathname)));
    return at;
  }

  it("/login?next=<지금 경로> 로 옮긴 뒤(새 경로를 넣은 커밋에서) 비운다 — 비우기 전에 옮긴다", async () => {
    const history = createMemoryHistory({ initialEntries: ["/settings/agents?tab=x"] });
    const app = createApp(history);
    app.queryClient.setQueryData(qk.me, ME);
    const at = watchReset(app);

    app.onUnauthorized();

    await vi.waitFor(() => expect(at).toEqual(["/login"]));
    expect(history.location.pathname).toBe("/login");
    expect(app.router.latestLocation.search).toEqual({ next: "/settings/agents?tab=x" });
    expect(app.queryClient.getQueryData(qk.me)).toBeUndefined();
  });

  it("이동 막기가 걸려 있어도 옮기고 비운다(ignoreBlocker)", async () => {
    const history = createMemoryHistory({ initialEntries: ["/agents"] });
    const app = createApp(history);
    const at = watchReset(app);
    unregisters.push(app.router.history.block({ blockerFn: () => true, enableBeforeUnload: false }));

    app.onUnauthorized();

    await vi.waitFor(() => expect(at).toEqual(["/login"]));
    expect(history.location.pathname).toBe("/login");
  });

  it("이동이 실패해도 비운다", async () => {
    const app = createApp(createMemoryHistory({ initialEntries: ["/agents"] }));
    app.queryClient.setQueryData(qk.me, ME);
    const at = watchReset(app);
    vi.spyOn(app.router, "navigate").mockRejectedValueOnce(new Error("이동 실패"));

    app.onUnauthorized();

    await vi.waitFor(() => expect(at).toHaveLength(1));
    expect(app.queryClient.getQueryData(qk.me)).toBeUndefined();
  });

  it("옮기는 사이에 온 401 은 이동·비우기를 다시 걸지 않는다", async () => {
    const history = createMemoryHistory({ initialEntries: ["/agents"] });
    const app = createApp(history);
    const at = watchReset(app);
    const navigate = vi.spyOn(app.router, "navigate");

    app.onUnauthorized();
    app.onUnauthorized();
    app.onUnauthorized();

    await vi.waitFor(() => expect(at).toEqual(["/login"]));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("로그인 없이 여는 화면이면 곧바로 비우고 머문다, 로그인 화면이면 아무것도 하지 않는다", () => {
    const join = createApp(createMemoryHistory({ initialEntries: ["/join/abc"] }));
    const joinAt = watchReset(join);
    join.onUnauthorized();
    expect(joinAt).toEqual(["/join/abc"]);

    const login = createApp(createMemoryHistory({ initialEntries: ["/login"] }));
    const navigate = vi.spyOn(login.router, "navigate");
    login.onUnauthorized();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("세션이 밖에서 끝나면 셸 쿼리를 다시 받지 않는다 — 401 뒤 나가는 요청은 로그인 화면의 me 확인뿐", async () => {
    let expired = false;
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (expired) return json(401, { code: "UNAUTHORIZED", message: "x" });
        if (url === "/api/v1/auth/me") return json(200, ME);
        const shell = shellGet(input, init);
        if (shell) return shell;
        throw new Error(`예상 밖 요청 ${url}`);
      }),
    );
    const app = createApp(createMemoryHistory({ initialEntries: ["/settings/agents"] }));
    render(createElement(App, { app }));
    expect(await screen.findByTestId("page-agents")).toBeInTheDocument();

    expired = true;
    const mark = requests.length;
    // 셸 조회 하나가 끊긴 세션으로 401 을 받는다(서버 세션이 밖에서 끝난 길)
    void app.queryClient.refetchQueries({ queryKey: qk.me });

    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const after = requests.slice(mark + 1);
    expect(after.filter((r) => r !== "GET /api/v1/auth/me")).toEqual([]);
  });
});
