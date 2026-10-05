import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubMedia } from "../../../test/media";
import { OPS_STATUS_OK, ME, channelOf, json, renderRoute, shellGet } from "../../../test/shellApi";

// 설정 통합 스펙 「설정 통합」 장 — 사이드바 하단은 연결 점 + 「설정」 하나, 설정은 /settings/<탭> 에서 역할대로

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 셸 기본 응답 + me(역할)·운영 상태. 부른 GET 을 모은다 */
function stubShell({ role = "owner", unacked = { warn: 0, error: 0 } } = {}) {
  const calls: string[] = [];
  let loggedOut = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/v1/auth/logout") {
      loggedOut = true;
      return json(200, { ok: true });
    }
    if (url === "/api/v1/auth/me")
      return loggedOut
        ? json(401, { code: "UNAUTHORIZED", message: "x" })
        : // 내 계정 탭이 표시 이름 칸을 그린다 — ME 에는 표시 이름이 없다
          json(200, { ...ME, user: { ...ME.user, displayName: "주인" }, role });
    if (url === "/api/v1/ops/status") return json(200, { ...OPS_STATUS_OK, unacked });
    if (url === "/api/v1/channels") return json(200, { channels: [channelOf("a", { name: "general" })] });
    return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}

const sidebar = () => screen.findByRole("complementary");
const tabsNav = () => screen.findByRole("navigation", { name: "설정" });
const tabNames = async () =>
  within(await tabsNav())
    .getAllByRole("link")
    .map((l) => l.textContent?.replace(/\d+$/, "").trim());

describe("사이드바 하단", () => {
  it("연결 점과 「설정」 하나뿐 — 에이전트·멤버·연결·운영·내 계정·로그아웃·알림이 없다", async () => {
    stubShell();
    renderRoute("/c/a");
    const settings = await within(await sidebar()).findByRole("link", { name: /^설정/ });
    expect(settings).toHaveAttribute("href", "/settings");
    for (const name of ["에이전트", "멤버", "연결", /^운영/]) {
      expect(within(await sidebar()).queryByRole("link", { name })).toBeNull();
    }
    for (const name of ["내 계정", "로그아웃", "알림"]) {
      expect(within(await sidebar()).queryByRole("button", { name })).toBeNull();
    }
    // 연결 점은 그대로 — wire 없이 띄우므로 이름은 「상태 모름」
    expect(within(await sidebar()).getByRole("img", { name: /^Gateway / })).toBeInTheDocument();
  });

  it("admin 이상이면 「설정」에 확인 안 한 사건 수 배지", async () => {
    stubShell({ role: "admin", unacked: { warn: 2, error: 1 } });
    renderRoute("/c/a");
    const settings = await within(await sidebar()).findByRole("link", { name: /^설정/ });
    await waitFor(() => expect(settings.querySelector("[data-ops-badge]")).toHaveTextContent("3"));
    expect(settings).toHaveAccessibleName(/확인 안 한 사건 3건/);
  });

  it("member 는 배지가 없고 ops API 를 부르지 않는다", async () => {
    const { calls } = stubShell({ role: "member", unacked: { warn: 2, error: 1 } });
    renderRoute("/c/a");
    const settings = await within(await sidebar()).findByRole("link", { name: /^설정/ });
    expect(settings).toHaveAccessibleName("설정");
    expect(settings.querySelector("[data-ops-badge]")).toBeNull();
    expect(calls.filter((c) => c.includes("/ops/"))).toEqual([]);
  });
});

describe("탭 — 역할대로", () => {
  it.each([
    ["member", ["내 계정", "알림", "에이전트"]],
    ["admin", ["내 계정", "알림", "에이전트", "멤버", "운영"]],
    ["owner", ["내 계정", "알림", "에이전트", "멤버", "연결", "운영"]],
  ])("%s — %j", async (role, tabs) => {
    stubShell({ role });
    renderRoute("/settings/account");
    await waitFor(async () => expect(await tabNames()).toEqual(tabs));
  });

  // 보이지 않는 탭은 직접 주소로 와도 탭 목록에 끼지 않는다 — 내용 자리만 「권한이 없습니다」
  it.each([
    ["member", "/settings/members", ["내 계정", "알림", "에이전트"]],
    ["member", "/settings/connection", ["내 계정", "알림", "에이전트"]],
    ["member", "/settings/operations", ["내 계정", "알림", "에이전트"]],
    ["admin", "/settings/connection", ["내 계정", "알림", "에이전트", "멤버", "운영"]],
  ])("%s 가 숨은 탭 %s 로 직접 오면 — 탭 목록은 %j 그대로", async (role, path, tabs) => {
    stubShell({ role });
    renderRoute(path);
    expect(await screen.findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(await tabNames()).toEqual(tabs);
    expect(within(await tabsNav()).queryByRole("link", { current: "page" })).not.toBeInTheDocument();
  });

  it("지금 탭은 aria-current=page, 운영 탭에도 배지", async () => {
    stubShell({ unacked: { warn: 1, error: 0 } });
    renderRoute("/settings/members");
    const nav = await tabsNav();
    expect(within(nav).getByRole("link", { name: "멤버" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "내 계정" })).not.toHaveAttribute("aria-current");
    const ops = within(nav).getByRole("link", { name: /^운영/ });
    await waitFor(() => expect(ops.querySelector("[data-ops-badge]")).toHaveTextContent("1"));
  });
});

describe("주소", () => {
  it("옛 /agents 는 /settings/agents 로 넘긴다", async () => {
    stubShell();
    const { router } = renderRoute("/agents");
    expect(await screen.findByTestId("page-agents")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/agents");
  });

  it("넓은 화면의 /settings 는 /settings/account 로 넘긴다", async () => {
    stubShell();
    const { router } = renderRoute("/settings");
    expect(await screen.findByRole("heading", { level: 1, name: "내 계정" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/account");
  });

  it("사이드바 「설정」을 누르면 넓은 화면은 내 계정으로", async () => {
    stubShell();
    const { router } = renderRoute("/c/a");
    await userEvent.click(await within(await sidebar()).findByRole("link", { name: /^설정/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
  });
});

describe("넓은 화면 레이아웃", () => {
  // jsdom 은 레이아웃을 재지 않는다 — 실제 스크롤은 브라우저 확인이 보고, 여기서는 구조를 고정한다
  it("탭 목록은 고정, 내용 칸만 따로 스크롤한다 — 둘 다 셸의 스크롤 상자 안", async () => {
    stubShell();
    renderRoute("/settings/agents");
    const page = await screen.findByTestId("page-agents");
    const content = screen.getByTestId("settings-content");
    expect(content).toContainElement(page);
    expect(content).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    expect(content).not.toContainElement(await tabsNav());
    expect(screen.getByTestId("page-scroll")).toContainElement(content);
  });

  it("탭을 옮기면 초점이 그 탭 내용의 제목으로", async () => {
    stubShell();
    renderRoute("/settings/account");
    await userEvent.click(within(await tabsNav()).getByRole("link", { name: "멤버" }));
    const heading = await screen.findByRole("heading", { level: 1, name: "멤버" });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it("탭을 옮기면 내용 칸을 맨 위로 돌린다", async () => {
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
    stubShell();
    const { router } = renderRoute("/settings/account");
    await screen.findByRole("heading", { level: 1, name: "내 계정" });
    scrollTo.mockClear();
    await act(() => router.navigate({ to: "/settings/agents" }));
    await screen.findByTestId("page-agents");
    await waitFor(() => expect(scrollTo.mock.contexts).toContain(screen.getByTestId("settings-content")));
  });
});

describe("좁은 화면 — 단계 이동", () => {
  it("/settings 는 넘기지 않고 탭 목록 페이지다", async () => {
    stubMedia(true);
    stubShell();
    const { router } = renderRoute("/settings");
    expect(await screen.findByRole("heading", { level: 1, name: "설정" })).toBeInTheDocument();
    expect(await tabNames()).toContain("내 계정");
    expect(router.state.location.pathname).toBe("/settings");
    // 목록 페이지도 사이드바 메뉴 단추가 있다
    expect(screen.getByRole("button", { name: "채널 목록 열기" })).toBeInTheDocument();
  });

  it("탭 → 머리 「← 설정」 → 다른 탭, 뒤로 가기로 거슬러 간다 — 머리는 스크롤에 붙어 있다", async () => {
    stubMedia(true);
    stubShell();
    const { router, history } = renderRoute("/settings");
    await userEvent.click(within(await tabsNav()).getByRole("link", { name: "알림" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/notifications"));
    const heading = await screen.findByRole("heading", { level: 1, name: "알림" });
    await waitFor(() => expect(heading).toHaveFocus());

    const header = screen.getByTestId("settings-header");
    expect(header).toHaveClass("sticky", "top-0");
    // 탭 페이지에는 탭 목록이 없다 — 머리의 메뉴 단추와 「← 설정」
    expect(screen.queryByRole("navigation", { name: "설정" })).toBeNull();
    expect(within(header).getByRole("button", { name: "채널 목록 열기" })).toBeInTheDocument();
    const back = within(header).getByRole("link", { name: "설정" });
    expect(back).toHaveTextContent("← 설정");
    expect(back).toHaveAttribute("href", "/settings");

    await userEvent.click(back);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "설정" })).toHaveFocus());
    await userEvent.click(within(await tabsNav()).getByRole("link", { name: "에이전트" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/agents"));
    expect(await screen.findByTestId("page-agents")).toBeInTheDocument();

    act(() => history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings"));
    expect(await tabsNav()).toBeInTheDocument();
    act(() => history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/notifications"));
    expect(await screen.findByRole("heading", { level: 1, name: "알림" })).toBeInTheDocument();
  });

  it("폭이 넓어지면 /settings 목록 페이지는 내 계정으로 넘어간다", async () => {
    const media = stubMedia(true);
    stubShell();
    const { router } = renderRoute("/settings");
    await screen.findByRole("heading", { level: 1, name: "설정" });
    media.setNarrow(false);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));
  });
});

describe("내 계정 — 로그아웃", () => {
  it("로그아웃 단추는 POST /auth/logout 뒤 로그인 화면으로 한 번 간다", async () => {
    const { fetch } = stubShell();
    const { history } = renderRoute("/settings/account");
    const moves: string[] = [];
    history.subscribe(({ location }) => moves.push(location.pathname));
    const page = await screen.findByTestId("page-account");
    await userEvent.click(within(page).getByRole("button", { name: "로그아웃" }));

    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => String(url) === "/api/v1/auth/logout")).toHaveLength(1);
    expect(moves).toEqual(["/login"]);
  });
});
