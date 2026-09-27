import type { OpenClawAdapterStatus } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AdapterStatusResponse, qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { type WireStatus, useWireStatus } from "@/realtime/wire";
import { TooltipProvider } from "@/ui/tooltip";
import { stubMedia } from "../../../test/media";
import { ADAPTER_OK, ME, channelOf, json, renderRoute, shellGet } from "../../../test/shellApi";
import { Banners } from "./Banners";
import { ConnectionDots } from "./ConnectionDots";

afterEach(() => {
  useWireStatus.getState().setStatus("idle");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 어댑터 상태만 답하는 가짜 서버 — 캐시를 바꾸는 테스트는 그 뒤로 다시 부르지 않는다(staleTime) */
function renderWithAdapter(ui: ReactNode, adapter: Pick<OpenClawAdapterStatus, "gateway" | "bridge">) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) =>
      String(input) === "/api/v1/adapter/status"
        ? json(200, { ...ADAPTER_OK, ...adapter })
        : json(404, { code: "NOT_FOUND", message: "x" }),
    ),
  );
  const queryClient: QueryClient = createQueryClient(() => {});
  // 점은 wire 가 살아 있을 때만 값을 보인다 — 값 자체를 보는 테스트는 연결된 상태에서 본다
  useWireStatus.getState().setStatus("connected");
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
  /** wire `adapter.status` 가 캐시를 고치는 것과 같이 — 관찰자 알림은 notifyManager 가 미뤄 보내므로 화면 단언은 findBy·waitFor 로 */
  const push = (next: Pick<OpenClawAdapterStatus, "gateway" | "bridge">) =>
    queryClient.setQueryData<AdapterStatusResponse>(qk.adapter, (prev) =>
      prev?.provider === "openclaw" ? { ...prev, ...next } : prev,
    );
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

  it("점은 색으로만 보이므로 키보드로도 닿는다 — Tab 으로 초점이 가면 상태 이름·설명 툴팁", async () => {
    renderWithAdapter(<ConnectionDots />, { gateway: "connected", bridge: "down" });
    const gateway = await screen.findByRole("img", { name: "Gateway 연결됨" });
    await userEvent.tab();
    expect(gateway).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Gateway 연결됨");
    await userEvent.tab();
    expect(screen.getByRole("img", { name: "플러그인 끊김" })).toHaveFocus();
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("플러그인 끊김"));
  });

  it("wire 가 끊기면 마지막 값을 초록으로 두지 않는다 — 둘 다 「상태 모름」(회색), 다시 붙으면 돌아온다", async () => {
    renderWithAdapter(<ConnectionDots />, { gateway: "connected", bridge: "connected" });
    const gateway = await screen.findByRole("img", { name: "Gateway 연결됨" });
    expect(gateway).toHaveClass("bg-success");

    act(() => useWireStatus.getState().setStatus("reconnecting"));
    const unknown = await screen.findByRole("img", { name: "Gateway 상태 모름" });
    expect(unknown).toHaveClass("bg-muted-foreground/40");
    expect(screen.getByRole("img", { name: "플러그인 상태 모름" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /연결됨/ })).toBeNull();

    act(() => useWireStatus.getState().setStatus("connected"));
    expect(await screen.findByRole("img", { name: "Gateway 연결됨" })).toBeInTheDocument();
  });
});

describe("Banners", () => {
  const WIRE_RECONNECTING = "서버에 다시 연결하는 중…";
  const OPENCLAW_DOWN = "OpenClaw 에 연결되지 않아 에이전트가 답하지 못합니다. 메시지는 저장됩니다.";
  const REJECTED = "실시간 연결이 거부되었습니다 — 주소(localhost:5173)를 확인하세요";

  const setWire = (s: WireStatus) => act(() => useWireStatus.getState().setStatus(s));

  it("wire 상태별 배너 — reconnecting 은 status, protocol_mismatch·rejected 는 alert, 우리가 끊은 offline 은 없다", async () => {
    const { queryClient } = renderWithAdapter(<Banners />, { gateway: "connected", bridge: "connected" });
    await waitFor(() => expect(queryClient.getQueryData(qk.adapter)).toBeDefined());
    setWire("connected");
    // 라이브 영역은 비어 있는 채로 먼저 있다 — 배너 없음
    const status = screen.getByRole("status");
    const alert = screen.getByRole("alert");
    expect(status).toBeEmptyDOMElement();
    expect(alert).toBeEmptyDOMElement();

    setWire("reconnecting");
    expect(screen.getByRole("status")).toHaveTextContent(WIRE_RECONNECTING);

    setWire("offline");
    expect(screen.queryByText(WIRE_RECONNECTING)).not.toBeInTheDocument();
    expect(status).toBeEmptyDOMElement();

    setWire("protocol_mismatch");
    expect(screen.getByRole("alert")).toHaveTextContent("서버가 새 버전입니다.");
    expect(screen.getByRole("alert")).toHaveTextContent("앱을 새로고침하세요");
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "새로고침" })).toBeInTheDocument();

    setWire("rejected");
    expect(screen.getByRole("alert")).toHaveTextContent(REJECTED);
    expect(screen.queryByText("앱을 새로고침하세요")).not.toBeInTheDocument();
    // 내용이 바뀌어도 영역은 처음 그 요소 그대로 — 스크린 리더는 새로 끼운 라이브 영역을 놓칠 수 있다
    expect(screen.getByRole("status")).toBe(status);
    expect(screen.getByRole("alert")).toBe(alert);
  });

  it("「새로고침」은 페이지를 다시 불러온다", async () => {
    const reload = vi.fn();
    renderWithAdapter(<Banners />, { gateway: "connected", bridge: "connected" });
    // jsdom 의 location.reload 는 다시 정의할 수 없어 location 을 통째로 바꾼다(afterEach 가 되돌린다)
    vi.stubGlobal("location", { ...window.location, reload });
    setWire("protocol_mismatch");
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("Gateway ≠ connected 또는 플러그인 down 이면 OpenClaw 배너", async () => {
    const { push } = renderWithAdapter(<Banners />, { gateway: "reconnecting", bridge: "connected" });
    expect(await screen.findByText(OPENCLAW_DOWN)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(OPENCLAW_DOWN);

    push({ gateway: "connected", bridge: "connected" });
    await waitFor(() => expect(screen.queryByText(OPENCLAW_DOWN)).not.toBeInTheDocument());

    push({ gateway: "connected", bridge: "down" });
    expect(await screen.findByText(OPENCLAW_DOWN)).toBeInTheDocument();
  });

  it("wire 가 끊기면 OpenClaw 배너를 띄우지 않는다 — 마지막 값은 「모름」이고 끊김 배너가 사정을 알린다(점과 같은 규칙)", async () => {
    const { push } = renderWithAdapter(<Banners />, { gateway: "down", bridge: "connected" });
    expect(await screen.findByText(OPENCLAW_DOWN)).toBeInTheDocument();

    setWire("reconnecting");
    expect(screen.queryByText(OPENCLAW_DOWN)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(WIRE_RECONNECTING);
    // 끊긴 동안 들어온 값도 믿지 않는다
    push({ gateway: "connected", bridge: "down" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(WIRE_RECONNECTING));
    expect(screen.queryByText(OPENCLAW_DOWN)).not.toBeInTheDocument();

    setWire("connected");
    expect(await screen.findByText(OPENCLAW_DOWN)).toBeInTheDocument();
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

  it("사이드바 제목은 me 의 워크스페이스 이름 — 이름을 주지 않는 응답이면 「dodok」", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url === "/api/v1/auth/me") return json(200, { ...ME, workspace: { id: "w", name: "두독 팀" } });
        return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
      }),
    );
    const { queryClient } = renderRoute("/agents");
    expect(await screen.findByText("두독 팀")).toBeInTheDocument();

    // workspace 없이 답하는 서버(ME 그대로)면 기본 이름으로 돌아간다
    act(() => {
      queryClient.setQueryData(qk.me, ME);
    });
    expect(await screen.findByText("dodok")).toBeInTheDocument();
    expect(screen.queryByText("두독 팀")).not.toBeInTheDocument();
  });

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

  it("시트가 링크로 닫히면 초점은 연 메뉴 버튼으로 돌아간다(Esc 로 닫아도)", async () => {
    stubMedia(true);
    stubChannels();
    const { router } = renderRoute("/c/a");
    const header = await screen.findByTestId("channel-header");
    const menu = within(header).getByRole("button", { name: "채널 목록 열기" });

    await userEvent.click(menu);
    const sheet = await screen.findByRole("dialog", { name: "채널 목록" });
    await userEvent.click(await within(sheet).findByRole("link", { name: /random/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/b"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(menu).toHaveFocus());

    await userEvent.click(menu);
    await screen.findByRole("dialog", { name: "채널 목록" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(menu).toHaveFocus());
  });

  it("다른 화면으로 옮겨 가며 닫히면 그 화면의 메뉴 버튼으로 초점이 간다", async () => {
    stubMedia(true);
    stubChannels();
    const { router } = renderRoute("/c/a");
    const header = await screen.findByTestId("channel-header");
    await userEvent.click(within(header).getByRole("button", { name: "채널 목록 열기" }));
    const sheet = await screen.findByRole("dialog", { name: "채널 목록" });
    await userEvent.click(within(sheet).getByRole("link", { name: "에이전트" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents"));
    const page = await screen.findByTestId("page-agents");
    await waitFor(() => expect(within(page).getByRole("button", { name: "채널 목록 열기" })).toHaveFocus());
  });

  it("폭이 바뀌면 시트를 닫아 둔다 — 넓어지면 사이드바가 늘 보이고, 다시 좁아져도 저절로 열려 있지 않다", async () => {
    const media = stubMedia(true);
    stubChannels();
    renderRoute("/c/a");
    const header = await screen.findByTestId("channel-header");
    await userEvent.click(within(header).getByRole("button", { name: "채널 목록 열기" }));
    await screen.findByRole("dialog", { name: "채널 목록" });

    media.setNarrow(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("navigation", { name: "채널" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "채널 목록 열기" })).not.toBeInTheDocument();

    media.setNarrow(true);
    expect(await within(header).findByRole("button", { name: "채널 목록 열기" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
