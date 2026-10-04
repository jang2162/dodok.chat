import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWireStatus } from "@/realtime/wire";
import { ADAPTER_OK, ME, adapterStatusBody, json, renderRoute, shellGet } from "../../../test/shellApi";
import { OWNER, statusOf, TOKENS_PATH } from "../../../test/setupServer";

afterEach(() => {
  useWireStatus.getState().setStatus("idle");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 셸 기본 응답 + me·어댑터 상태·setup API(owner 가 아니면 403 — 서버와 같이) */
function stubShell(me: unknown, adapter = ADAPTER_OK) {
  const setupCalls: string[] = [];
  const owner = (me as { role?: string }).role === "owner";
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/auth/me") return json(200, me);
      if (url === "/api/v1/adapter/status") return json(200, adapterStatusBody(adapter));
      if (url.startsWith("/api/v1/setup/") || url.startsWith("/api/v1/gateways")) {
        setupCalls.push(url);
        if (!owner) return json(403, { code: "FORBIDDEN", message: "owner only" });
        if (url === "/api/v1/setup/status") return json(200, statusOf());
        if (url === TOKENS_PATH) return json(200, { tokens: [] });
      }
      return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
    }),
  );
  return { setupCalls };
}

const sidebarLink = () => screen.queryByRole("link", { name: "연결" });

describe("진입점과 권한 — owner 에게만", () => {
  it("owner 는 사이드바 「연결」로 /settings/connection 에 간다", async () => {
    stubShell(OWNER);
    const { router } = renderRoute("/agents");
    const link = await screen.findByRole("link", { name: "연결" });
    await userEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/connection"));
    expect(await screen.findByRole("heading", { level: 1, name: "연결" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Gateway" })).toBeInTheDocument();
  });

  it("owner 가 아니면 사이드바에 「연결」이 없다", async () => {
    stubShell({ ...ME, role: "member" });
    renderRoute("/agents");
    await screen.findByRole("link", { name: "에이전트" });
    expect(sidebarLink()).not.toBeInTheDocument();
  });

  it("owner 가 아닌 사람이 직접 주소로 오면 「권한이 없습니다」 — setup API 를 부르지 않는다", async () => {
    const { setupCalls } = stubShell({ ...ME, role: "member" });
    renderRoute("/settings/connection");
    expect(await screen.findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(setupCalls).toEqual([]);
  });

  it("OpenClaw 연결 배너의 「연결 설정 보기」는 owner 에게만", async () => {
    stubShell(OWNER, { ...ADAPTER_OK, gateway: "down" });
    useWireStatus.getState().setStatus("connected");
    const { router } = renderRoute("/agents");
    const banner = await screen.findByText(/OpenClaw 에 연결되지 않아/);
    const status = banner.closest("[role=status]") as HTMLElement;
    const link = await within(status).findByRole("link", { name: "연결 설정 보기" });
    await userEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/connection"));
  });

  it("owner 가 아니면 배너에 링크가 없다", async () => {
    stubShell({ ...ME, role: "member" }, { ...ADAPTER_OK, gateway: "down" });
    useWireStatus.getState().setStatus("connected");
    renderRoute("/agents");
    const banner = await screen.findByText(/OpenClaw 에 연결되지 않아/);
    const status = banner.closest("[role=status]") as HTMLElement;
    expect(within(status).queryByRole("link")).not.toBeInTheDocument();
  });
});
