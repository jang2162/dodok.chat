import type { OpsStatus } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { useWireStatus } from "@/realtime/wire";
import { ME, renderRoute } from "../../../test/shellApi";
import { eventOf, opsStatusOf, stubOpsServer } from "../../../test/opsServer";
import { OPS_STATUS_POLL_MS } from "./queries";

afterEach(() => {
  vi.useRealTimers();
  useWireStatus.getState().setStatus("idle");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MEMBER = { ...ME, role: "member" };
const opsLink = () => screen.queryByRole("link", { name: /^운영/ });
const badgeOf = (link: HTMLElement) => link.querySelector("[data-ops-badge]");

/** 운영 화면 밖에서는 주기가 돌지 않는다 — 배지는 `ops.event` 가 고친다(재검증 M3b). 두 주기가 지나도 처음 한 번뿐 */
async function expectNoPolling(server: ReturnType<typeof stubOpsServer>) {
  await waitFor(() => expect(server.count("GET", "/api/v1/ops/status")).toBe(1));
  await act(() => vi.advanceTimersByTimeAsync(OPS_STATUS_POLL_MS * 2 + 1_000));
  expect(server.count("GET", "/api/v1/ops/status")).toBe(1);
}

describe("진입점과 권한 — admin 이상(팀 스펙 2장)", () => {
  it("admin 도 설정 탭 「운영」으로 들어가 상태를 본다", async () => {
    stubOpsServer({ me: { ...ME, role: "admin" } });
    renderRoute("/settings/agents");
    await userEvent.click(await screen.findByRole("link", { name: /^운영/ }));
    expect(await screen.findByRole("region", { name: "상태" })).toBeInTheDocument();
  });

  it("owner 는 설정 탭 「운영」으로 /settings/operations 에 간다", async () => {
    stubOpsServer();
    const { router } = renderRoute("/settings/agents");
    await userEvent.click(await screen.findByRole("link", { name: /^운영/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/operations"));
    expect(await screen.findByRole("heading", { level: 1, name: "운영" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "상태" })).toBeInTheDocument();
  });

  it("member 는 설정 탭에 「운영」이 없고 ops API 를 부르지 않는다", async () => {
    const server = stubOpsServer({ me: MEMBER });
    renderRoute("/settings/agents");
    await screen.findByRole("link", { name: "에이전트" });
    expect(opsLink()).not.toBeInTheDocument();
    expect(server.opsCalls()).toEqual([]);
  });

  it("member 가 직접 주소로 오면 「권한이 없습니다」", async () => {
    const server = stubOpsServer({ me: MEMBER });
    renderRoute("/settings/operations");
    expect(await screen.findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(server.opsCalls()).toEqual([]);
  });
});

describe("배지 — 확인 안 한 warn·error 수", () => {
  it("warn + error 를 보이고 info 는 세지 않는다(서버가 이미 뺐다)", async () => {
    stubOpsServer({ status: opsStatusOf({ unacked: { warn: 2, error: 1 } }) });
    renderRoute("/settings/agents");
    const link = await screen.findByRole("link", { name: /^운영/ });
    await waitFor(() => expect(badgeOf(link)).toHaveTextContent("3"));
    expect(link).toHaveAccessibleName(/확인 안 한 사건 3건/);
  });

  it("0 이면 배지가 없다", async () => {
    const server = stubOpsServer();
    renderRoute("/settings/agents");
    const link = await screen.findByRole("link", { name: /^운영/ });
    await waitFor(() => expect(server.count("GET", "/api/v1/ops/status")).toBe(1));
    expect(badgeOf(link)).toBeNull();
  });

  it.each([
    [{ warn: 99, error: 0 }, "99"],
    [{ warn: 60, error: 40 }, "99+"],
  ])("경계 — %o 이면 「%s」", async (unacked, text) => {
    stubOpsServer({ status: opsStatusOf({ unacked }) });
    renderRoute("/settings/agents");
    const link = await screen.findByRole("link", { name: /^운영/ });
    await waitFor(() => expect(badgeOf(link)?.textContent).toBe(text));
  });

  it("100 이상이면 99+", async () => {
    stubOpsServer({ status: opsStatusOf({ unacked: { warn: 120, error: 5 } }) });
    renderRoute("/settings/agents");
    const link = await screen.findByRole("link", { name: /^운영/ });
    await waitFor(() => expect(badgeOf(link)).toHaveTextContent("99+"));
  });

  it("운영 화면 밖의 배지(사이드바 「설정」·운영 탭)만 있으면 상태를 주기로 다시 받지 않는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = stubOpsServer();
    renderRoute("/settings/agents");
    await screen.findByRole("link", { name: /^운영/ });
    await expectNoPolling(server);
  });

  it("상태 캐시의 unacked 가 바뀌면(ops.event) 곧바로 늘어난다", async () => {
    stubOpsServer({ status: opsStatusOf({ unacked: { warn: 1, error: 0 } }) });
    const { queryClient } = renderRoute("/settings/agents");
    const link = await screen.findByRole("link", { name: /^운영/ });
    await waitFor(() => expect(badgeOf(link)).toHaveTextContent("1"));
    act(() => {
      queryClient.setQueryData<OpsStatus>(qk.opsStatus, (s) => s && { ...s, unacked: { warn: 1, error: 1 } });
    });
    await waitFor(() => expect(badgeOf(link)).toHaveTextContent("2"));
  });

  it("운영 화면에서 「모두 확인」을 누르면 배지가 사라진다", async () => {
    stubOpsServer({ status: opsStatusOf({ unacked: { warn: 4, error: 0 } }), pages: [[eventOf(1)]] });
    renderRoute("/settings/operations");
    const link = await screen.findByRole("link", { name: /^운영/ });
    await waitFor(() => expect(badgeOf(link)).toHaveTextContent("4"));
    const events = await screen.findByRole("region", { name: "최근 사건" });
    await userEvent.click(within(events).getByRole("button", { name: "모두 확인" }));
    await waitFor(() => expect(badgeOf(link)).toBeNull());
  });
});

describe("좁은 화면 — 서랍이 닫혀 있으면 메뉴 버튼이 알린다(브라우저 검증 O3)", () => {
  function narrow() {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string): MediaQueryList =>
        ({
          matches: query === "(max-width: 767px)",
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
  }
  const menu = () => screen.findByRole("button", { name: /^채널 목록 열기/ });

  it("owner 에게 확인 안 한 warn·error 가 있으면 점을 찍고 접근성 이름에 그 수", async () => {
    narrow();
    stubOpsServer({ status: opsStatusOf({ unacked: { warn: 2, error: 1 } }) });
    renderRoute("/settings/agents");
    const button = await menu();
    await waitFor(() => expect(button).toHaveAccessibleName("채널 목록 열기 (확인 안 한 운영 사건 3)"));
    expect(button.querySelector("[data-ops-dot]")).not.toBeNull();
  });

  it("없으면 점도 수도 없다", async () => {
    narrow();
    const server = stubOpsServer();
    renderRoute("/settings/agents");
    const button = await menu();
    await waitFor(() => expect(server.count("GET", "/api/v1/ops/status")).toBeGreaterThan(0));
    expect(button).toHaveAccessibleName("채널 목록 열기");
    expect(button.querySelector("[data-ops-dot]")).toBeNull();
  });

  it("메뉴 버튼의 점도 상태를 주기로 다시 받지 않는다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    narrow();
    const server = stubOpsServer();
    renderRoute("/settings/agents");
    await menu();
    await expectNoPolling(server);
  });

  it("member 는 표시가 없고 ops API 를 부르지 않는다", async () => {
    narrow();
    const server = stubOpsServer({ me: MEMBER });
    renderRoute("/settings/agents");
    const button = await menu();
    expect(button).toHaveAccessibleName("채널 목록 열기");
    expect(button.querySelector("[data-ops-dot]")).toBeNull();
    expect(server.opsCalls()).toEqual([]);
  });
});
