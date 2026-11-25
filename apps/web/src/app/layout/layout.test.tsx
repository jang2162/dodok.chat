import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Agent, OpenClawGatewayStatus } from "@dodok/shared";
import { type AdapterStatusResponse, qk } from "@/api/queries";
import { RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { type WireStatus, useWireStatus } from "@/realtime/wire";
import { TooltipProvider } from "@/ui/tooltip";
import { attachHandlers } from "@/realtime/handlers";
import { createSubscriptions } from "@/realtime/subscriptions";
import { stubNotification } from "../../../test/domStubs";
import { createFakeSocket } from "../../../test/fakeSocket";
import { approval, CH, CH2, runState, uid, USER } from "../../../test/fixtures";
import { DEV, memberOf } from "../../../test/composerHarness";
import { onAgentSettingsRequest, registerComposer } from "@/features/composer/insertMention";
import { useRunStore } from "@/features/runs/runStore";
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
import { PanelTabs } from "./PanelTabs";
import { LAYOUT_KEY, layoutStore } from "./useLayoutWidths";
import { ParticipantsButton } from "./ParticipantsButton";

afterEach(() => {
  window.localStorage.clear();
  layoutStore.reset();
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
  // 라우터는 문맥만 준다 — 배너의 「연결 설정 보기」 링크(그 Gateway 상세)가 쓴다
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
  const NAME = / — Gateway: .+, 플러그인: /;
  /** 사이드바 아래 연결 상태 단추 하나 — 보이는 글·아이콘·접근 이름을 한 번에 본다 */
  const status = () => screen.findByRole("button", { name: NAME });
  const icon = (button: HTMLElement) => button.querySelector("svg");
  const dot = (button: HTMLElement) => button.querySelector("[data-slot=status-dot]");

  it("모두 연결이면 「연결됨」, 접근 이름은 보이는 글 뒤에 두 라벨을 잇는다", async () => {
    renderWithAdapter(<ConnectionDots />, [gw(), HOME()]);
    const button = await screen.findByRole("button", {
      name: "연결됨 — Gateway: Gateway 연결됨, 플러그인: 플러그인 연결됨",
    });
    expect(button).toHaveTextContent(/^연결됨$/);
    expect(dot(button)).toHaveClass("bg-success");
    expect(icon(button)).toBeNull();
    // 예전 점 두 개는 없다
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("켜진 Gateway 하나만 끊기면 「<이름> 끊김」과 경고 아이콘", async () => {
    const { push } = renderWithAdapter(<ConnectionDots />, [gw(), HOME({ gateway: "down", bridge: "down" })]);
    let button = await screen.findByRole("button", {
      name: "집 끊김 — Gateway: Gateway 일부 끊김, 플러그인: 플러그인 일부 끊김",
    });
    expect(button).toHaveTextContent(/^집 끊김$/);
    expect(icon(button)).toHaveClass("text-warning");
    expect(dot(button)).toBeNull();

    push([gw(), HOME({ gateway: "reconnecting", bridge: "down" })]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^집 다시 연결 중$/));

    // Gateway 가 하나뿐이고 그것이 끊기면 빨강 구간 — 같은 아이콘, 위험색
    push([gw({ gateway: "down", bridge: "down" })]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^사무실 끊김$/));
    button = await status();
    expect(button).toHaveAccessibleName("사무실 끊김 — Gateway: Gateway 끊김, 플러그인: 플러그인 끊김");
    expect(icon(button)).toHaveClass("text-destructive");
  });

  it("여럿이면 모은 이름 — 일부는 노랑, 모두면 빨강", async () => {
    const STORE = (over: Partial<OpenClawGatewayStatus> = {}) =>
      gw({ id: "01a00000-0000-7000-8000-0000000000a3", name: "창고", ...over });
    const down = { gateway: "down", bridge: "down" } as const;
    const { push } = renderWithAdapter(<ConnectionDots />, [gw(), HOME(down), STORE(down)]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^Gateway 일부 끊김$/));
    expect(icon(await status())).toHaveClass("text-warning");

    push([gw(down), HOME(down)]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^Gateway 끊김$/));
    expect(icon(await status())).toHaveClass("text-destructive");

    // 플러그인도 같은 꼴
    push([gw({ bridge: "down" }), HOME()]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^사무실 플러그인 끊김$/));
    expect(await status()).toHaveAccessibleName(
      "사무실 플러그인 끊김 — Gateway: Gateway 연결됨, 플러그인: 플러그인 일부 끊김",
    );
    expect(icon(await status())).toHaveClass("text-warning");

    push([gw({ bridge: "down" }), HOME({ bridge: "down" }), STORE()]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^플러그인 일부 끊김$/));

    push([gw({ bridge: "down" }), HOME({ bridge: "down" })]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^플러그인 끊김$/));
    expect(icon(await status())).toHaveClass("text-destructive");
  });

  it("Gateway 문제가 플러그인 문제보다 먼저", async () => {
    // 사무실은 플러그인만, 집은 Gateway 가 끊겼다 — 보이는 글은 Gateway 쪽(집)
    renderWithAdapter(<ConnectionDots />, [gw({ bridge: "down" }), HOME({ gateway: "down" })]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^집 끊김$/));
    expect(await status()).toHaveAccessibleName(
      "집 끊김 — Gateway: Gateway 일부 끊김, 플러그인: 플러그인 일부 끊김",
    );
  });

  it("꺼진 Gateway 는 세지 않는다 — 모두 꺼졌거나 없으면 회색 「Gateway 없음」", async () => {
    const off = gw({ enabled: false, gateway: "disabled", bridge: "down" });
    const { push } = renderWithAdapter(<ConnectionDots />, [off]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^Gateway 없음$/));
    expect(dot(await status())).toHaveClass("bg-muted-foreground/40");
    expect(await status()).toHaveAccessibleName(
      "Gateway 없음 — Gateway: Gateway 없음, 플러그인: 플러그인 없음",
    );

    // 꺼진 Gateway 의 플러그인은 늘 down 이다 — 세면 「플러그인 끊김」이 된다
    push([off, HOME()]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^연결됨$/));

    push([]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^Gateway 없음$/));
  });

  it("wire 가 끊기면 「상태 모름」 회색 — 마지막 값을 초록으로 두지 않고, 다시 붙으면 돌아온다", async () => {
    renderWithAdapter(<ConnectionDots />, [gw()]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^연결됨$/));

    act(() => useWireStatus.getState().setStatus("reconnecting"));
    const button = await screen.findByRole("button", {
      name: "상태 모름 — Gateway: Gateway 상태 모름, 플러그인: 플러그인 상태 모름",
    });
    expect(button).toHaveTextContent(/^상태 모름$/);
    expect(dot(button)).toHaveClass("bg-muted-foreground/40");
    expect(icon(button)).toBeNull();

    act(() => useWireStatus.getState().setStatus("connected"));
    await waitFor(async () => expect(await status()).toHaveTextContent(/^연결됨$/));
  });

  it("접근 이름은 보이는 글로 시작한다 — 말로 부르는 이름이 화면 글과 맞게(WCAG 2.5.3)", async () => {
    const { push } = renderWithAdapter(<ConnectionDots />, [
      gw(),
      HOME({ gateway: "reconnecting", bridge: "down" }),
    ]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^집 다시 연결 중$/));
    const starts = async () => {
      const button = await status();
      const text = button.textContent ?? "";
      expect(text).not.toBe("");
      expect(button.getAttribute("aria-label")?.startsWith(`${text} — `)).toBe(true);
    };
    await starts();
    push([gw({ bridge: "down" }), HOME()]);
    await waitFor(async () => expect(await status()).toHaveTextContent(/^사무실 플러그인 끊김$/));
    await starts();
    act(() => useWireStatus.getState().setStatus("reconnecting"));
    await waitFor(async () => expect(await status()).toHaveTextContent(/^상태 모름$/));
    await starts();
  });

  it("툴팁 하나에 Gateway·플러그인을 위아래로 — Gateway 별 줄, 꺼진 것은 「꺼짐」", async () => {
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
    const button = await status();
    await userEvent.tab();
    expect(button).toHaveFocus();
    const tip = await screen.findByRole("tooltip");
    const [gateway, bridge] = within(tip).getAllByRole("list");
    expect(tip).toHaveTextContent("Gateway 일부 끊김");
    expect(tip).toHaveTextContent("에이전트를 실행하는 OpenClaw Gateway");
    expect(gateway).toHaveTextContent("사무실 — 연결됨");
    expect(gateway).toHaveTextContent("집 — 다시 연결 중");
    expect(gateway).toHaveTextContent("창고 — 꺼짐");
    expect(tip).toHaveTextContent("플러그인 끊김");
    expect(bridge).toHaveTextContent("사무실 — 끊김");
    expect(bridge).toHaveTextContent("창고 — 꺼짐");
    // 단추는 하나 — 탭을 한 번 더 누르면 밖으로 나간다
    await userEvent.tab();
    expect(button).not.toHaveFocus();
  });

  it("긴 Gateway 이름은 말줄임 — 단추가 사이드바 밖으로 나가지 않는다", async () => {
    const long = "아주아주아주아주아주아주아주아주긴이름의OpenClawGateway서버".repeat(3);
    renderWithAdapter(<ConnectionDots />, [gw(), HOME({ name: long, gateway: "down", bridge: "down" })]);
    await waitFor(async () => expect(await status()).toHaveTextContent(`${long} 끊김`));
    const button = await status();
    // 사이드바(260px) 안에 머문다 — 단추는 폭 상한·min-w-0, 글은 말줄임
    expect(button).toHaveClass("min-w-0");
    expect(button.className).toMatch(/\bmax-w-/);
    expect(screen.getByText(`${long} 끊김`)).toHaveClass("truncate");
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

  it("「연결 설정 보기」는 owner 에게만 — 끊긴 Gateway 가 하나면 그 Gateway 상세로", async () => {
    const { queryClient } = renderWithAdapter(<Banners />, [gw({ gateway: "down" })]);
    act(() => queryClient.setQueryData(qk.me, ME));
    expect(await screen.findByRole("link", { name: "연결 설정 보기" })).toHaveAttribute(
      "href",
      `/settings/connection/gateway/${gw().id}`,
    );
    act(() => queryClient.setQueryData(qk.me, { ...ME, role: "member" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: "연결 설정 보기" })).toBeNull());
    expect(screen.getByText(DOWN_OFFICE, { exact: false })).toBeInTheDocument();
  });

  it("끊긴 Gateway 가 여럿이면 「연결 설정 보기」는 「연결」 탭으로", async () => {
    const { queryClient } = renderWithAdapter(<Banners />, [
      gw({ gateway: "down", bridge: "down" }),
      HOME({ bridge: "down" }),
    ]);
    act(() => queryClient.setQueryData(qk.me, ME));
    expect(await screen.findByRole("link", { name: "연결 설정 보기" })).toHaveAttribute(
      "href",
      "/settings/connection",
    );
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

describe("PanelTabs 머리", () => {
  /** 라우트 없이 틀만 — 링크는 라우터 맥락만 있으면 그린다 */
  function renderPanel(props: Partial<Parameters<typeof PanelTabs>[0]> = {}) {
    stubMedia(false);
    const queryClient: QueryClient = createQueryClient(() => {});
    const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ["/"] }));
    render(
      <QueryClientProvider client={queryClient}>
        <RouterContextProvider router={router}>
          <PanelTabs channelId="a" conversationId="a" active="settings" {...props}>
            <p>내용</p>
          </PanelTabs>
        </RouterContextProvider>
      </QueryClientProvider>,
    );
    return screen.getByTestId("page-channel-panel");
  }

  it("제목 줄 없이 탭 한 줄 + 닫기 — 제목은 스크린 리더용으로만 남아 패널의 이름이다", () => {
    const panel = renderPanel();
    expect(screen.getByRole("complementary", { name: "채널 설정" })).toBe(panel);
    expect(within(panel).getByRole("heading", { name: "채널 설정" })).toHaveClass("sr-only");
    const tabs = within(panel).getByRole("navigation", { name: "패널 탭" });
    // 닫기는 탭과 같은 줄이다
    expect(tabs.parentElement).toContainElement(within(panel).getByRole("link", { name: "설정 닫기" }));
    // 기본 너비 384px — 창이 넉넉할 때(가운데 최소 420 과 사이드바 260 을 빼고도 남는다)
    vi.stubGlobal("innerWidth", 1440);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(panel).toHaveStyle({ width: "384px" });
  });

  it("badges — 수가 있으면 탭 이름에 붙고, 0·없음이면 그리지 않는다", () => {
    const panel = renderPanel({ badges: { activity: 2, files: 0 } });
    const tabs = within(panel).getByRole("navigation", { name: "패널 탭" });
    expect(within(tabs).getByRole("link", { name: "활동, 승인 대기 2" })).toBeInTheDocument();
    expect(within(tabs).getByRole("link", { name: "파일" })).toBeInTheDocument();
    expect(within(tabs).getByRole("link", { name: "설정" })).toBeInTheDocument();
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
    const { queryClient } = renderRoute("/settings/connection");
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
    expect(screen.getByRole("link", { name: "설정" })).toHaveAttribute("href", "/settings");
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

    await waitFor(() => expect(router.state.location.pathname).toBe("/c/b/s/b"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "채널 목록" })).not.toBeInTheDocument());
    expect(screen.queryByRole("navigation", { name: "채널" })).not.toBeInTheDocument();
  });

  /**
   * 재리뷰 R1 — 승인 알림은 채널이 어느 캐시에도 없으면 종류를 몰라 띄우지 않는다. 좁은 화면은 사이드바(채널 목록)를 시트를 열 때만
   * 그리므로 셸이 목록을 따로 들지 않으면 지금 보지 않는 일반 채널의 새 승인이 알려지지 않는다
   */
  it("좁은 화면에서도 시트를 열지 않은 채 다른 일반 채널의 새 승인을 탭 알림으로 띄운다", async () => {
    stubMedia(true);
    const notification = stubNotification("granted");
    const channels = [channelOf(CH, { name: "general" }), channelOf(CH2, { name: "random" })];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url === "/api/v1/auth/me") return json(200, ME);
        if (url === "/api/v1/channels") return json(200, { channels });
        return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
      }),
    );
    try {
      const { queryClient } = renderRoute(`/c/${CH}`);
      await screen.findByTestId("channel-header");
      expect(screen.queryByRole("navigation", { name: "채널" })).not.toBeInTheDocument();

      const fake = createFakeSocket();
      fake.socket.connected = true;
      const subscriptions = createSubscriptions({ socket: fake.wire, queryClient });
      const detach = attachHandlers(fake.wire, {
        queryClient,
        subscriptions,
        onUnauthorized: () => {},
        notify: {
          currentChannelId: () => CH,
          currentConversationId: () => CH,
          openActivity: () => {},
        },
      });
      try {
        // 셸이 든 목록이 도착한 뒤의 새 승인 — 부팅 직후 목록 응답 전의 짧은 창은 이 시험이 재지 않는다. 채널 목록이 아니라 셸의 다른
        // 목록(DM·사람 DM)과 받는 중인 요청이 다 끝나기를 기다린다: 채널 목록을 기다리면 셸이 그 목록을 빼먹었을 때 알림 단언이 아니라
        // 여기서 시간이 다 된다. 고정 시간을 흘리지 않아 부하에서도 채널 목록 응답보다 먼저 승인을 보내지 않는다
        await waitFor(() => {
          expect(queryClient.getQueryData(qk.dms)).toBeDefined();
          expect(queryClient.getQueryData(qk.directs)).toBeDefined();
          expect(queryClient.isFetching()).toBe(0);
        });
        fake.serverEmit("approval.requested", { approval: approval({ channelId: CH2 }) });
        expect(notification.made).toHaveLength(1);
        expect(notification.made[0]?.options?.body).toBe("random 채널");
      } finally {
        detach();
      }
    } finally {
      notification.restore();
    }
  });

  it("사이드바 「파일」은 /files 로 — 좁은 화면이면 시트가 닫힌다", async () => {
    stubMedia(true);
    stubChannels();
    const { router } = renderRoute("/c/a");
    const header = await screen.findByTestId("channel-header");
    await userEvent.click(within(header).getByRole("button", { name: "채널 목록 열기" }));
    const sheet = await screen.findByRole("dialog", { name: "채널 목록" });
    await userEvent.click(within(sheet).getByRole("link", { name: "파일" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/files"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByTestId("page-files")).toBeInTheDocument();
  });

  it("패널 탭 머리 — 「파일」은 설정·활동 뒤, 머리의 「파일」 단추가 탭을 여닫는다", async () => {
    stubChannels();
    const { router } = renderRoute("/c/a/s/a/files");
    const panel = await screen.findByTestId("page-channel-panel");
    expect(panel).toHaveAttribute("data-panel-tab", "files");
    const tabs = within(panel).getByRole("navigation", { name: "패널 탭" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["설정", "활동", "파일"]);
    const toggle = within(screen.getByTestId("channel-header")).getByRole("link", { name: "파일" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle);
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/a/s/a"));
    expect(screen.queryByTestId("page-channel-panel")).toBeNull();
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
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/b/s/b"));
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
    await userEvent.click(within(sheet).getByRole("link", { name: "설정" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    const page = await screen.findByTestId("page-settings");
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

  // jsdom 은 레이아웃을 재지 않는다 — 실제 높이·스크롤은 브라우저 확인이 보고, 여기서는 그 구조를 고정한다
  it("긴 화면은 셸 안 스크롤 상자에서만 스크롤한다 — 사이드바·배너는 그 밖에 남는다", async () => {
    stubChannels();
    renderRoute("/settings/connection");
    const page = await screen.findByTestId("page-connection");
    const scroller = screen.getByTestId("page-scroll");

    expect(screen.getByTestId("app-shell")).toHaveClass("h-dvh");
    expect(scroller).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    expect(scroller).toContainElement(page);
    // 배너는 main 안 이 상자의 형제다 — 상자가 main 바로 아래가 아니면 배너도 함께 밀려 올라간다
    expect(scroller.parentElement?.tagName).toBe("MAIN");
    expect(scroller).not.toContainElement(screen.getByRole("complementary"));
  });

  it("채널 화면은 스크롤 상자 높이에 맞춘다 — 목록만 스크롤하고 두 겹이 되지 않는다", async () => {
    stubChannels();
    renderRoute("/c/a");
    const page = await screen.findByTestId("page-channel");
    expect(page.parentElement).toBe(screen.getByTestId("page-scroll"));
    expect(page).toHaveClass("min-h-0", "flex-1");
  });

  it("화면을 옮기면 스크롤 상자를 맨 위로 돌린다", async () => {
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
    stubChannels();
    const { router } = renderRoute("/settings/connection");
    await screen.findByTestId("page-connection");
    scrollTo.mockClear();

    await act(() =>
      router.navigate({
        to: "/c/$channelId/s/$conversationId",
        params: { channelId: "a", conversationId: "a" },
      }),
    );
    await screen.findByTestId("page-channel");
    await waitFor(() => expect(scrollTo.mock.contexts).toContain(screen.getByTestId("page-scroll")));
  });
});

describe("사이드바·패널 너비(UI 시안 04)", () => {
  function stubChannels() {
    const channels = [channelOf("a", { name: "general" })];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url === "/api/v1/auth/me") return json(200, ME);
        if (url === "/api/v1/channels") return json(200, { channels });
        if (url === "/api/v1/channels/a") return json(200, { channel: channels[0] });
        return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
      }),
    );
  }
  const wide = (width = 1440) => vi.stubGlobal("innerWidth", width);
  const sidebar = () => screen.getByTestId("app-sidebar");
  const sidebarHandle = () => screen.findByRole("separator", { name: "사이드바 너비" });
  const stored = () =>
    JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? "null") as Record<string, unknown> | null;

  it("손잡이는 separator — 값·범위를 알리고, ←/→ 16px·Home/End·Enter 로 바꿔 저장한다", async () => {
    wide();
    stubChannels();
    renderRoute("/c/a");
    const handle = await sidebarHandle();
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "260");
    expect(handle).toHaveAttribute("aria-valuemin", "200");
    expect(handle).toHaveAttribute("aria-valuemax", "420");
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(sidebar()).toHaveStyle({ width: "260px" });

    handle.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(handle).toHaveAttribute("aria-valuenow", "276");
    expect(sidebar()).toHaveStyle({ width: "276px" });
    expect(stored()).toMatchObject({ sidebar: 276 });
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(handle).toHaveAttribute("aria-valuenow", "244");
    await userEvent.keyboard("{End}");
    expect(handle).toHaveAttribute("aria-valuenow", "420");
    await userEvent.keyboard("{Home}");
    expect(handle).toHaveAttribute("aria-valuenow", "200");
    // 최솟값에서 ← 를 더 눌러도 접히지 않는다 — 키보드 접기는 ⌘\\
    await userEvent.keyboard("{ArrowLeft}");
    expect(handle).toHaveAttribute("aria-valuenow", "200");
    await userEvent.keyboard("{Enter}");
    expect(handle).toHaveAttribute("aria-valuenow", "260");
    expect(stored()).toMatchObject({ sidebar: 260, collapsed: false });
  });

  it("끌면 따라오고(범위 안으로), 놓을 때 저장한다 · 더블클릭은 기본값", async () => {
    wide();
    stubChannels();
    renderRoute("/c/a");
    const handle = await sidebarHandle();
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 260 });
    // 끄는 동안 문서 전체가 col-resize·선택 없음
    expect(document.documentElement.style.cursor).toBe("col-resize");
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 340 });
    expect(sidebar()).toHaveStyle({ width: "340px" });
    expect(stored()).toBeNull();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 });
    expect(sidebar()).toHaveStyle({ width: "420px" });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 900 });
    expect(stored()).toMatchObject({ sidebar: 420 });
    expect(document.documentElement.style.cursor).toBe("");

    fireEvent.doubleClick(handle);
    expect(sidebar()).toHaveStyle({ width: "260px" });
    expect(stored()).toMatchObject({ sidebar: 260 });
  });

  it("저장된 너비로 연다 — 망가진 값이면 기본값", async () => {
    wide();
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ sidebar: 333 }));
    layoutStore.reset();
    stubChannels();
    renderRoute("/c/a");
    expect(await sidebarHandle()).toHaveAttribute("aria-valuenow", "333");
    expect(sidebar()).toHaveStyle({ width: "333px" });
  });

  it("최소보다 더 끌면 접힌다 — 머리에 「채널 목록 열기」가 나오고 누르면 다시 편다", async () => {
    wide();
    stubChannels();
    renderRoute("/c/a");
    const handle = await sidebarHandle();
    // 세션 화면의 머리가 선 뒤에 — 넘기는 동안의 임시 머리에 있던 단추를 누르지 않게
    await screen.findByTestId("channel-header");
    expect(screen.queryByRole("button", { name: "채널 목록 열기" })).toBeNull();
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 260 });
    // 최솟값(200)을 지나 접힌다
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 180 });
    expect(sidebar()).toHaveStyle({ width: "200px" });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
    expect(sidebar()).toHaveAttribute("data-collapsed");
    expect(sidebar()).toHaveStyle({ width: "0px" });
    expect(sidebar()).toHaveAttribute("inert");
    // 손잡이가 사라져 놓기가 오지 않아도 저장하고 문서 잠금을 푼다
    expect(stored()).toMatchObject({ collapsed: true, sidebar: 260 });
    expect(document.documentElement.style.cursor).toBe("");

    await userEvent.click(await screen.findByRole("button", { name: "채널 목록 열기" }));
    expect(sidebar()).not.toHaveAttribute("data-collapsed");
    expect(sidebar()).toHaveStyle({ width: "260px" });
    expect(stored()).toMatchObject({ collapsed: false });
    expect(screen.queryByRole("button", { name: "채널 목록 열기" })).toBeNull();
    // 누른 단추는 사라진다 — 초점은 다시 나온 손잡이로
    await waitFor(async () => expect(await sidebarHandle()).toHaveFocus());
  });

  it("⌘\\(Ctrl+\\) 로 접고 편다", async () => {
    wide();
    stubChannels();
    renderRoute("/c/a");
    await sidebarHandle();
    await userEvent.keyboard("{Meta>}\\{/Meta}");
    expect(sidebar()).toHaveAttribute("data-collapsed");
    expect(await screen.findByRole("button", { name: "채널 목록 열기" })).toBeInTheDocument();
    await userEvent.keyboard("{Control>}\\{/Control}");
    expect(sidebar()).not.toHaveAttribute("data-collapsed");
  });

  it("⌘\\ 로 펴도 초점은 그대로 — 작성기에서 누르면 계속 작성기", async () => {
    wide();
    stubChannels();
    renderRoute("/c/a");
    await sidebarHandle();
    const box = await screen.findByRole("textbox", { name: "메시지 입력" });
    box.focus();
    await userEvent.keyboard("{Meta>}\\{/Meta}");
    expect(sidebar()).toHaveAttribute("data-collapsed");
    expect(box).toHaveFocus();
    await userEvent.keyboard("{Meta>}\\{/Meta}");
    expect(sidebar()).not.toHaveAttribute("data-collapsed");
    // 펴는 쪽의 초점 옮기기는 다음 프레임 — 그 뒤에도 작성기
    await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    expect(box).toHaveFocus();
  });

  it("창에 맞춰 줄여 그린 패널은 누르기·초점만으로 저장값이 줄지 않는다 — 실제로 끌었을 때만 저장", async () => {
    wide();
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ panel: 500 }));
    layoutStore.reset();
    stubChannels();
    renderRoute("/c/a/s/a/settings");
    const panel = await screen.findByTestId("page-channel-panel");
    const handle = within(panel).getByRole("separator", { name: "패널 너비" });
    wide(1024);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(panel).toHaveStyle({ width: "344px" });
    // 누르기(같은 자리의 이동 포함)·초점
    fireEvent.pointerDown(handle, { pointerId: 3, button: 0, clientX: 600 });
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 600 });
    fireEvent.pointerUp(handle, { pointerId: 3, clientX: 600 });
    handle.focus();
    expect(layoutStore.get().panel).toBe(500);
    expect(stored()).toMatchObject({ panel: 500 });
    // 넓히면 저장값이 돌아온다
    wide(1440);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(panel).toHaveStyle({ width: "500px" });
    // 실제로 끌면 그때 저장 — 그린 값에서 시작한다
    wide(1024);
    act(() => window.dispatchEvent(new Event("resize")));
    fireEvent.pointerDown(handle, { pointerId: 4, button: 0, clientX: 600 });
    fireEvent.pointerMove(handle, { pointerId: 4, clientX: 610 });
    fireEvent.pointerUp(handle, { pointerId: 4, clientX: 610 });
    expect(stored()).toMatchObject({ panel: 334 });
  });

  it("오른쪽 패널 — 왼쪽으로 끌면 넓어지고, 창이 모자라면 저장값은 두고 그리는 너비만 줄인다", async () => {
    wide();
    stubChannels();
    renderRoute("/c/a/s/a/settings");
    const panel = await screen.findByTestId("page-channel-panel");
    const handle = within(panel).getByRole("separator", { name: "패널 너비" });
    expect(handle).toHaveAttribute("aria-valuemin", "320");
    expect(handle).toHaveAttribute("aria-valuemax", "720");
    expect(panel).toHaveStyle({ width: "384px" });
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 1000 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 900 });
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 900 });
    expect(panel).toHaveStyle({ width: "484px" });
    expect(stored()).toMatchObject({ panel: 484 });
    // ← 는 손잡이를 왼쪽으로 — 패널이 넓어진다
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(panel).toHaveStyle({ width: "500px" });

    // 1024px 창: 가운데 420 을 지키려고 패널부터 줄인다(1024 − 260 − 420 = 344). 저장값은 그대로
    wide(1024);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(panel).toHaveStyle({ width: "344px" });
    expect(sidebar()).toHaveStyle({ width: "260px" });
    expect(stored()).toMatchObject({ panel: 500 });
    // 더 좁으면 패널이 최소(320)에 닿은 뒤 사이드바를 줄인다
    wide(900);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(panel).toHaveStyle({ width: "320px" });
    expect(sidebar()).toHaveStyle({ width: "200px" });
  });

  it("좁은 화면은 손잡이가 없다 — 시트 그대로", async () => {
    stubMedia(true);
    stubChannels();
    renderRoute("/c/a/s/a/settings");
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "사이드바 너비" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "패널 너비" })).toBeNull();
  });
});

describe("참여자 단추 [UI 시안 03]", () => {
  const MIA = uid(6_101);
  const RUNNER: Agent = { ...DEV, id: uid(6_102), handle: "coder", name: "코더", provider: "runner" };
  const GUEST: Agent = { ...DEV, id: uid(6_103), handle: "guest", name: "손님" };
  const CONV = uid(6_104);

  function renderParticipants(over: { canInvite?: boolean } = {}) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const qc = createQueryClient(() => {});
    qc.setQueryDefaults([], { staleTime: Infinity });
    qc.setQueryData(qk.me, { ...ME, user: { ...ME.user, id: USER, handle: "owner", displayName: "주인" } });
    qc.setQueryData(qk.people, [
      {
        id: USER,
        handle: "owner",
        displayName: "주인",
        role: "owner",
        deactivatedAt: null,
        statusMessage: null,
      },
      {
        id: MIA,
        handle: "mia",
        displayName: "미아",
        role: "member",
        deactivatedAt: null,
        statusMessage: null,
      },
    ]);
    qc.setQueryData(qk.members(CH), [
      { ...memberOf(DEV.id), memberType: "user", memberId: USER },
      { ...memberOf(DEV.id), id: "m-mia", memberType: "user", memberId: MIA },
      memberOf(DEV.id),
      memberOf(RUNNER.id),
    ]);
    const onInvite = vi.fn();
    render(
      <QueryClientProvider client={qc}>
        <ParticipantsButton
          channelId={CH}
          conversationId={CONV}
          channelAgents={[DEV, RUNNER]}
          invited={[GUEST]}
          canInvite={over.canInvite ?? true}
          inviteFull={false}
          onInvite={onInvite}
          narrow={false}
        />
      </QueryClientProvider>,
    );
    return { fetch, onInvite };
  }
  afterEach(() => useRunStore.getState().reset());

  it("얼굴 셋(사람 먼저, 응답 중인 에이전트 다음) + 총인원 — 누르면 사람·에이전트·이 세션에만 초대 세 갈래", async () => {
    act(() =>
      useRunStore
        .getState()
        .applyState(
          runState({ channelId: CH, conversationId: CONV, agentId: RUNNER.id, status: "streaming" }),
        ),
    );
    renderParticipants();
    const button = screen.getByRole("button", { name: "참여자 5명" });
    expect(button).toHaveTextContent("5");
    // 사람 둘(주인·미아) 다음 응답 중인 coder — 응답하지 않는 dev 보다 앞
    expect(Array.from(button.querySelectorAll("[data-kind]")).map((el) => el.textContent)).toEqual([
      "주",
      "미",
      "코",
    ]);
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "참여자 5" });
    const people = within(dialog).getByRole("region", { name: "사람" });
    expect(people).toHaveTextContent("사람 2");
    expect(people).toHaveTextContent("주인나");
    expect(people).toHaveTextContent("미아@mia");
    const agents = within(dialog).getByRole("region", { name: "에이전트" });
    expect(agents).toHaveTextContent("에이전트 2 · 응답 중 1");
    expect(agents).toHaveTextContent("코더응답 중…");
    const invited = within(dialog).getByRole("region", { name: "이 세션에만 초대" });
    expect(invited).toHaveTextContent("손님@guest · 초대됨");
    // 나에게는 「멘션」이 없다
    expect(within(people).queryByRole("button", { name: "@owner 멘션" })).toBeNull();
    expect(within(people).getByRole("button", { name: "@mia 멘션" })).toBeInTheDocument();
    // ⚙ 는 러너 에이전트만
    expect(within(agents).getByRole("button", { name: "@coder 설정" })).toBeInTheDocument();
    expect(within(agents).queryByRole("button", { name: "@dev 설정" })).toBeNull();
    // 검색은 이름·핸들
    await userEvent.type(within(dialog).getByRole("searchbox", { name: "참여자 찾기" }), "MI");
    expect(within(people).queryByText("주인")).toBeNull();
    expect(within(people).getByText("미아")).toBeInTheDocument();
    expect(within(agents).getByText("맞는 참여자가 없습니다")).toBeInTheDocument();
  });

  it("「멘션」은 팝오버를 닫고 그 세션 작성기에 넣는다 · ⚙ 는 그 에이전트 줄로 설정을 연다", async () => {
    const mention = vi.fn(() => true);
    const off = registerComposer({ channelId: CH, conversationId: CONV }, { mention });
    const settings = vi.fn();
    const offSettings = onAgentSettingsRequest({ channelId: CH, conversationId: CONV }, settings);
    onTestFinished(() => {
      off();
      offSettings();
    });
    renderParticipants();
    await userEvent.click(screen.getByRole("button", { name: "참여자 5명" }));
    await userEvent.click(await screen.findByRole("button", { name: "@mia 멘션" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mention).toHaveBeenCalledWith("mia");
    await userEvent.click(screen.getByRole("button", { name: "참여자 5명" }));
    await userEvent.click(await screen.findByRole("button", { name: "@coder 설정" }));
    await waitFor(() => expect(settings).toHaveBeenCalledWith(RUNNER.id));
  });

  it("초대 에이전트의 「세션에서 내보내기」는 DELETE, 「에이전트 초대」는 닫은 뒤 대화상자 — 권한이 없으면 둘 다 없다", async () => {
    const { fetch, onInvite } = renderParticipants();
    await userEvent.click(screen.getByRole("button", { name: "참여자 5명" }));
    await userEvent.click(await screen.findByRole("button", { name: "@guest 세션에서 내보내기" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url) === `/api/v1/conversations/${CONV}/agents/${GUEST.id}` && init?.method === "DELETE",
        ),
      ).toBe(true),
    );
    await userEvent.click(screen.getByRole("button", { name: "에이전트 초대" }));
    await waitFor(() => expect(onInvite).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("canInvite 가 거짓이면 내보내기·초대가 없다", async () => {
    renderParticipants({ canInvite: false });
    await userEvent.click(screen.getByRole("button", { name: "참여자 5명" }));
    const dialog = await screen.findByRole("dialog", { name: "참여자 5" });
    expect(within(dialog).queryByRole("button", { name: /세션에서 내보내기/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "에이전트 초대" })).toBeNull();
  });
});
