import type { AdapterStatus } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AdapterStatusResponse, qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { type WireStatus, useWireStatus } from "@/realtime/wire";
import { TooltipProvider } from "@/ui/tooltip";
import { ADAPTER_OK, ME, channelOf, json, renderRoute, shellGet } from "../../../test/shellApi";
import { Banners } from "./Banners";
import { ConnectionDots } from "./ConnectionDots";

afterEach(() => {
  useWireStatus.getState().setStatus("idle");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 어댑터 상태만 답하는 가짜 서버 — 캐시를 바꾸는 테스트는 그 뒤로 다시 부르지 않는다(staleTime) */
function renderWithAdapter(ui: ReactNode, adapter: Pick<AdapterStatus, "gateway" | "bridge">) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) =>
      String(input) === "/api/v1/adapter/status"
        ? json(200, { ...ADAPTER_OK, ...adapter })
        : json(404, { code: "NOT_FOUND", message: "x" }),
    ),
  );
  const queryClient: QueryClient = createQueryClient(() => {});
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
  /** wire `adapter.status` 가 캐시를 고치는 것과 같이 — 관찰자 알림은 notifyManager 가 미뤄 보내므로 화면 단언은 findBy·waitFor 로 */
  const push = (next: Pick<AdapterStatus, "gateway" | "bridge">) =>
    queryClient.setQueryData<AdapterStatusResponse>(qk.adapter, (prev) => prev && { ...prev, ...next });
  return { queryClient, push };
}

describe("ConnectionDots", () => {
  it("adapter.status 값마다 Gateway·플러그인 점의 이름이 바뀐다", async () => {
    const { push } = renderWithAdapter(<ConnectionDots />, { gateway: "connected", bridge: "connected" });
    expect(await screen.findByRole("img", { name: "Gateway 연결됨" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "플러그인 연결됨" })).toBeInTheDocument();

    push({ gateway: "reconnecting", bridge: "down" });
    expect(await screen.findByRole("img", { name: "Gateway 다시 연결 중" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "플러그인 끊김" })).toBeInTheDocument();

    push({ gateway: "down", bridge: "down" });
    expect(await screen.findByRole("img", { name: "Gateway 끊김" })).toBeInTheDocument();
  });
});

describe("Banners", () => {
  const WIRE_RECONNECTING = "서버에 다시 연결하는 중…";
  const OPENCLAW_DOWN = "OpenClaw 에 연결되지 않아 에이전트가 답하지 못합니다. 메시지는 저장됩니다.";
  const REJECTED = "실시간 연결이 거부되었습니다 — 주소(localhost:5173)를 확인하세요";

  const setWire = (s: WireStatus) => act(() => useWireStatus.getState().setStatus(s));

  it("wire 상태별 배너 — reconnecting·protocol_mismatch·rejected 만, 우리가 끊은 offline 은 없다", async () => {
    const { queryClient } = renderWithAdapter(<Banners />, { gateway: "connected", bridge: "connected" });
    await waitFor(() => expect(queryClient.getQueryData(qk.adapter)).toBeDefined());
    setWire("connected");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    setWire("reconnecting");
    expect(screen.getByRole("status")).toHaveTextContent(WIRE_RECONNECTING);

    setWire("offline");
    expect(screen.queryByText(WIRE_RECONNECTING)).not.toBeInTheDocument();

    setWire("protocol_mismatch");
    expect(screen.getByText("앱을 새로고침하세요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새로고침" })).toBeInTheDocument();

    setWire("rejected");
    expect(screen.getByText(REJECTED)).toBeInTheDocument();
    expect(screen.queryByText("앱을 새로고침하세요")).not.toBeInTheDocument();
  });

  it("Gateway ≠ connected 또는 플러그인 down 이면 OpenClaw 배너 — wire 끊김과 함께면 둘 다", async () => {
    const { push } = renderWithAdapter(<Banners />, { gateway: "reconnecting", bridge: "connected" });
    expect(await screen.findByText(OPENCLAW_DOWN)).toBeInTheDocument();

    push({ gateway: "connected", bridge: "connected" });
    await waitFor(() => expect(screen.queryByText(OPENCLAW_DOWN)).not.toBeInTheDocument());

    push({ gateway: "connected", bridge: "down" });
    expect(await screen.findByText(OPENCLAW_DOWN)).toBeInTheDocument();

    push({ gateway: "connected", bridge: "connected" });
    await waitFor(() => expect(screen.queryByText(OPENCLAW_DOWN)).not.toBeInTheDocument());
    push({ gateway: "down", bridge: "connected" });
    setWire("reconnecting");
    expect(await screen.findByText(OPENCLAW_DOWN)).toBeInTheDocument();
    expect(screen.getByText(WIRE_RECONNECTING)).toBeInTheDocument();
  });
});

describe("AppShell", () => {
  /** 채널 둘이 있는 서버 — 그 밖은 셸 기본 응답 */
  function stubChannels() {
    const channels = [channelOf("a", { name: "general" }), channelOf("b", { name: "random" })];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url === "/api/v1/auth/me") return json(200, ME);
        if (url === "/api/v1/channels") return json(200, { channels });
        const m = /^\/api\/v1\/channels\/([^/]+)$/.exec(url);
        const channel = channels.find((c) => c.id === m?.[1]);
        if (channel) return json(200, { channel });
        return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
      }),
    );
  }

  it("넓은 화면은 사이드바를 늘 보이고 메뉴 버튼이 없다", async () => {
    stubChannels();
    renderRoute("/c/a");
    const nav = await screen.findByRole("navigation", { name: "채널" });
    expect(await within(nav).findByRole("link", { name: /random/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "에이전트" })).toHaveAttribute("href", "/agents");
    expect(screen.queryByRole("button", { name: "채널 목록 열기" })).not.toBeInTheDocument();
  });

  it("좁은 화면은 사이드바를 시트로 접는다 — 헤더 메뉴 버튼으로 열고, 링크를 누르면 닫힌다", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string): MediaQueryList => ({
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    stubChannels();
    const { router } = renderRoute("/c/a");
    // 채널을 불러오는 동안의 자리 화면에도 같은 버튼이 있다 — 헤더가 뜬 뒤 헤더의 버튼을 누른다
    const header = await screen.findByTestId("channel-header");
    await userEvent.click(within(header).getByRole("button", { name: "채널 목록 열기" }));

    const sheet = await screen.findByRole("dialog", { name: "채널 목록" });
    const nav = within(sheet).getByRole("navigation", { name: "채널" });
    await userEvent.click(await within(nav).findByRole("link", { name: /random/ }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/c/b"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "채널 목록" })).not.toBeInTheDocument());
    expect(screen.queryByRole("navigation", { name: "채널" })).not.toBeInTheDocument();
  });

  it("로그아웃 버튼은 POST /auth/logout 뒤 로그인 화면으로 한 번 간다", async () => {
    let loggedOut = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/auth/logout") {
        loggedOut = true;
        return json(200, { ok: true });
      }
      if (url === "/api/v1/auth/me")
        return loggedOut ? json(401, { code: "UNAUTHORIZED", message: "x" }) : json(200, ME);
      return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
    });
    vi.stubGlobal("fetch", fetch);
    const { history } = renderRoute("/agents");
    const moves: string[] = [];
    history.subscribe(({ location }) => moves.push(location.pathname));

    await userEvent.click(await screen.findByRole("button", { name: "로그아웃" }));

    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => String(url) === "/api/v1/auth/logout")).toHaveLength(1);
    expect(moves).toEqual(["/login"]);
  });
});
