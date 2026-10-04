import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawGatewayStatus } from "@dodok/shared";
import { type AdapterStatusResponse, qk } from "@/api/queries";
import { RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { type WireStatus, useWireStatus } from "@/realtime/wire";
import { TooltipProvider } from "@/ui/tooltip";
import { stubMedia } from "../../../test/media";
import {
  ADAPTER_OK,
  ME,
  adapterStatusBody,
  channelOf,
  json,
  renderRoute,
  shellGet,
  TEST_GATEWAY,
} from "../../../test/shellApi";
import { Banners } from "./Banners";
import { ConnectionDots } from "./ConnectionDots";

afterEach(() => {
  useWireStatus.getState().setStatus("idle");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Gateway 하나의 상태 — 이름·id 는 TEST_GATEWAY(사무실) 를 덮는다 */
const gw = (over: Partial<OpenClawGatewayStatus> = {}): OpenClawGatewayStatus => ({
  ...TEST_GATEWAY,
  ...over,
});
const HOME = (over: Partial<OpenClawGatewayStatus> = {}) =>
  gw({ id: "01a00000-0000-7000-8000-0000000000a2", name: "집", ...over });

/** 어댑터 상태만 답하는 가짜 서버 — 캐시를 바꾸는 테스트는 그 뒤로 다시 부르지 않는다(staleTime) */
function renderWithAdapter(ui: ReactNode, gateways: OpenClawGatewayStatus[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) =>
      String(input) === "/api/v1/adapter/status"
        ? json(200, {
            ...adapterStatusBody(ADAPTER_OK),
            statuses: [{ provider: "openclaw", gateways }],
          })
        : json(404, { code: "NOT_FOUND", message: "x" }),
    ),
  );
  const queryClient: QueryClient = createQueryClient(() => {});
  // 점은 wire 가 살아 있을 때만 값을 보인다 — 값 자체를 보는 테스트는 연결된 상태에서 본다
  useWireStatus.getState().setStatus("connected");
  // 라우터는 문맥만 준다 — 배너의 「연결 설정 보기」 링크가 쓴다
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ["/"] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterContextProvider router={router}>
        <TooltipProvider>{ui}</TooltipProvider>
      </RouterContextProvider>
    </QueryClientProvider>,
  );
  /** wire `adapter.status` 가 캐시를 고치는 것과 같이 — 관찰자 알림은 notifyManager 가 미뤄 보내므로 화면 단언은 findBy·waitFor 로 */
  const push = (next: OpenClawGatewayStatus[]) =>
    act(() => {
      queryClient.setQueryData<AdapterStatusResponse>(qk.adapter, (prev) =>
        prev?.provider === "openclaw" ? { ...prev, gateways: next } : prev,
      );
    });
  return { queryClient, push };
}

describe("ConnectionDots", () => {
  it("Gateway 하나 — 상태마다 Gateway·플러그인 점의 이름이 바뀐다", async () => {
    const { push } = renderWithAdapter(<ConnectionDots />, [gw()]);
    expect(await screen.findByRole("img", { name: "Gateway 연결됨" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "플러그인 연결됨" })).toBeInTheDocument();

    push([gw({ gateway: "reconnecting", bridge: "down" })]);
    expect(await screen.findByRole("img", { name: "Gateway 다시 연결 중" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "플러그인 끊김" })).toBeInTheDocument();

    push([gw({ gateway: "down", bridge: "down" })]);
    expect(await screen.findByRole("img", { name: "Gateway 끊김" })).toBeInTheDocument();
  });

  it("Gateway 를 하나로 모은다 — 모두 연결됨 초록·일부 끊김 노랑·모두 끊김 빨강·없음 회색", async () => {
    const { push } = renderWithAdapter(<ConnectionDots />, [gw(), HOME()]);
    expect(await screen.findByRole("img", { name: "Gateway 연결됨" })).toHaveClass("bg-success");
    expect(screen.getByRole("img", { name: "플러그인 연결됨" })).toHaveClass("bg-success");

    push([gw(), HOME({ gateway: "down", bridge: "down" })]);
    expect(await screen.findByRole("img", { name: "Gateway 일부 끊김" })).toHaveClass("bg-warning");
    expect(screen.getByRole("img", { name: "플러그인 일부 끊김" })).toHaveClass("bg-warning");

    push([gw({ gateway: "down", bridge: "down" }), HOME({ gateway: "down", bridge: "down" })]);
    expect(await screen.findByRole("img", { name: "Gateway 끊김" })).toHaveClass("bg-destructive");
    expect(screen.getByRole("img", { name: "플러그인 끊김" })).toHaveClass("bg-destructive");

    push([]);
    expect(await screen.findByRole("img", { name: "Gateway 없음" })).toHaveClass("bg-muted-foreground/40");
    expect(screen.getByRole("img", { name: "플러그인 없음" })).toHaveClass("bg-muted-foreground/40");
  });

  it("꺼진 Gateway 는 세지 않는다 — 모두 꺼졌으면 회색, 켜진 것만 연결됐으면 초록", async () => {
    const { push } = renderWithAdapter(<ConnectionDots />, [
      gw({ enabled: false, gateway: "disabled", bridge: "down" }),
    ]);
    expect(await screen.findByRole("img", { name: "Gateway 없음" })).toHaveClass("bg-muted-foreground/40");
    push([gw({ enabled: false, gateway: "disabled", bridge: "down" }), HOME()]);
    expect(await screen.findByRole("img", { name: "Gateway 연결됨" })).toHaveClass("bg-success");
  });

  it("툴팁에 Gateway 별 상태 — 꺼진 것은 「꺼짐」", async () => {
    renderWithAdapter(<ConnectionDots />, [
      gw({ bridge: "down" }),
      HOME({ gateway: "reconnecting", bridge: "down" }),
      gw({
        id: "01a00000-0000-7000-8000-0000000000a3",
        name: "창고",
        enabled: false,
        gateway: "disabled",
        bridge: "down",
      }),
    ]);
    const gateway = await screen.findByRole("img", { name: "Gateway 일부 끊김" });
    await userEvent.tab();
    expect(gateway).toHaveFocus();
    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("사무실 — 연결됨");
    expect(tip).toHaveTextContent("집 — 다시 연결 중");
    expect(tip).toHaveTextContent("창고 — 꺼짐");
    await userEvent.tab();
    expect(screen.getByRole("img", { name: "플러그인 끊김" })).toHaveFocus();
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("사무실 — 끊김"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("창고 — 꺼짐");
  });

  it("wire 가 끊기면 마지막 값을 초록으로 두지 않는다 — 둘 다 「상태 모름」(회색), 다시 붙으면 돌아온다", async () => {
    renderWithAdapter(<ConnectionDots />, [gw()]);
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
  const DOWN_OFFICE = "OpenClaw Gateway 「사무실」에 연결되지 않아 그 Gateway 의 에이전트가 답하지 못합니다";
  const DOWN_TWO = "OpenClaw Gateway 2개에 연결되지 않아 그 Gateway 의 에이전트가 답하지 못합니다";
  const REJECTED = `실시간 연결이 거부되었습니다 — 이 주소(${window.location.origin})가 서버의 APP_ORIGIN 과 다릅니다`;
  const openclawBanner = () => screen.queryByText(/OpenClaw Gateway/);

  const setWire = (s: WireStatus) => act(() => useWireStatus.getState().setStatus(s));

  it("wire 상태별 배너 — reconnecting 은 status, protocol_mismatch·rejected 는 alert, 우리가 끊은 offline 은 없다", async () => {
    const { queryClient } = renderWithAdapter(<Banners />, [gw()]);
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

  it("rejected 배너는 박힌 개발 주소가 아니라 지금 연 주소를 보인다", async () => {
    renderWithAdapter(<Banners />, [gw()]);
    vi.stubGlobal("location", { ...window.location, origin: "https://chat.example.com" });
    setWire("rejected");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "실시간 연결이 거부되었습니다 — 이 주소(https://chat.example.com)가 서버의 APP_ORIGIN 과 다릅니다",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("localhost:5173");
  });

  it("「새로고침」은 페이지를 다시 불러온다", async () => {
    const reload = vi.fn();
    renderWithAdapter(<Banners />, [gw()]);
    // jsdom 의 location.reload 는 다시 정의할 수 없어 location 을 통째로 바꾼다(afterEach 가 되돌린다)
    vi.stubGlobal("location", { ...window.location, reload });
    setWire("protocol_mismatch");
    await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("끊긴 Gateway 하나면 그 이름 — Gateway ≠ connected 또는 플러그인 down", async () => {
    const { push } = renderWithAdapter(<Banners />, [gw({ gateway: "reconnecting" }), HOME()]);
    expect(await screen.findByText(DOWN_OFFICE, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(DOWN_OFFICE);

    push([gw(), HOME()]);
    await waitFor(() => expect(openclawBanner()).not.toBeInTheDocument());

    push([gw({ bridge: "down" }), HOME()]);
    expect(await screen.findByText(DOWN_OFFICE, { exact: false })).toBeInTheDocument();
  });

  it("둘 이상 끊기면 「Gateway 2개」로 묶는다", async () => {
    renderWithAdapter(<Banners />, [gw({ gateway: "down", bridge: "down" }), HOME({ bridge: "down" })]);
    expect(await screen.findByText(DOWN_TWO, { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/「사무실」/)).toBeNull();
  });

  it("「연결 설정 보기」는 owner 에게만, 연결 페이지로", async () => {
    const { queryClient } = renderWithAdapter(<Banners />, [gw({ gateway: "down" })]);
    act(() => queryClient.setQueryData(qk.me, ME));
    expect(await screen.findByRole("link", { name: "연결 설정 보기" })).toHaveAttribute(
      "href",
      "/settings/connection",
    );
    act(() => queryClient.setQueryData(qk.me, { ...ME, role: "member" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "연결 설정 보기" })).toBeNull());
    expect(screen.getByText(DOWN_OFFICE, { exact: false })).toBeInTheDocument();
  });

  it("Gateway 가 없거나 모두 꺼졌으면 OpenClaw 배너를 띄우지 않는다 — 꺼진 Gateway 는 끊김이 아니다", async () => {
    const { push } = renderWithAdapter(<Banners />, [gw({ gateway: "down", bridge: "down" })]);
    expect(await screen.findByText(DOWN_OFFICE, { exact: false })).toBeInTheDocument();

    push([]);
    await waitFor(() => expect(openclawBanner()).not.toBeInTheDocument());
    push([gw({ enabled: false, gateway: "disabled", bridge: "down" })]);
    await waitFor(() => expect(openclawBanner()).not.toBeInTheDocument());
    push([gw({ enabled: false, gateway: "disabled", bridge: "down" }), HOME({ gateway: "down" })]);
    expect(await screen.findByText(/「집」에 연결되지 않아/)).toBeInTheDocument();
  });

  it("wire 가 끊기면 OpenClaw 배너를 띄우지 않는다 — 마지막 값은 「모름」이고 끊김 배너가 사정을 알린다(점과 같은 규칙)", async () => {
    const { push } = renderWithAdapter(<Banners />, [gw({ gateway: "down" })]);
    expect(await screen.findByText(DOWN_OFFICE, { exact: false })).toBeInTheDocument();

    setWire("reconnecting");
    expect(openclawBanner()).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(WIRE_RECONNECTING);
    // 끊긴 동안 들어온 값도 믿지 않는다
    push([gw({ bridge: "down" })]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(WIRE_RECONNECTING));
    expect(openclawBanner()).not.toBeInTheDocument();

    setWire("connected");
    expect(await screen.findByText(DOWN_OFFICE, { exact: false })).toBeInTheDocument();
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
