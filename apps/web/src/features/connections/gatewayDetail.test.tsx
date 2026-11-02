import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentOf } from "../../../test/settingsServer";
import {
  GATEWAY_ID,
  PUBLIC_URL,
  gatewayDetailPath,
  renderConnection,
  statusOf,
  stubSetupServer,
} from "../../../test/setupServer";
import { ME, TEST_GATEWAY } from "../../../test/shellApi";

// Gateway 상세(연결 탭 통합 스펙 3.3) — 섹션 셋과 역할별로 보이는 것. 섹션 안의 자세한 동작은 setup/connection·gateways 시험

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const detail = () => screen.findByTestId("gateway-detail");

describe("owner", () => {
  it("owner sees plugin, bridge tokens and agents — 섹션 차례대로, 에이전트 줄은 그 상세로 가는 링크", async () => {
    const agent = agentOf("0190a000-0000-7000-8000-0000000000b1", "dev", {
      gateway: { id: GATEWAY_ID, name: "사무실" },
    });
    stubSetupServer({ agents: [agent] });
    renderConnection();
    const gw = await detail();
    const headings = within(gw)
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["플러그인", "브리지 토큰", "에이전트 1"]);
    const agents = within(gw).getByRole("region", { name: "에이전트 1" });
    expect(await within(agents).findByRole("link", { name: /@dev/ })).toHaveAttribute(
      "href",
      `/settings/connection/agent/${agent.id}`,
    );
    expect(within(agents).getByRole("button", { name: "에이전트 가져오기" })).toBeInTheDocument();
  });

  it("bridge token copy is one line with help — 브리지 주소·교체 절차는 「?」 안", async () => {
    stubSetupServer();
    renderConnection();
    const tokens = await within(await detail()).findByRole("region", { name: "브리지 토큰" });
    expect(within(tokens).getByText("플러그인이 이 서버에 붙을 때 쓰는 토큰.")).toBeInTheDocument();
    const box = within(tokens).getByRole("group", { name: "브리지 토큰 도움말" });
    const help = within(box).getByLabelText("브리지 토큰 도움말 펼치기");
    expect(box).not.toHaveAttribute("open");
    expect(box).toHaveTextContent(PUBLIC_URL);
    expect(box).toHaveTextContent("옛 토큰을 폐기하면 에이전트가 멈추지 않습니다");
    await userEvent.click(help);
    expect(box).toHaveAttribute("open");
  });

  it("plugin box is open when no plugin is connected and collapsed otherwise", async () => {
    stubSetupServer({ status: statusOf({ plugin: null, pluginMatches: null }) });
    renderConnection();
    const plugin = await within(await detail()).findByRole("region", { name: "플러그인" });
    expect(within(plugin).getByText("플러그인 설치").closest("details")).toHaveAttribute("open");
  });
});

describe("owner 가 아니면", () => {
  it("admin sees only header and agents with discover", async () => {
    const server = stubSetupServer();
    renderConnection({ ...ME, role: "admin" }, undefined, gatewayDetailPath(TEST_GATEWAY.id));
    const gw = await detail();
    expect(within(gw).getByRole("heading", { level: 1, name: "사무실" })).toBeInTheDocument();
    expect(within(gw).getByText("OpenClaw Gateway")).toBeInTheDocument();
    expect(
      within(gw)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(["에이전트 0"]);
    expect(within(gw).getByRole("button", { name: "에이전트 가져오기" })).toBeInTheDocument();
    expect(within(gw).queryByRole("button", { name: /수정|끄기|삭제/ })).toBeNull();
    expect(server.setupCalls()).toEqual([]);
  });

  it("member 는 머리와 에이전트만 — 가져오기도 없다", async () => {
    stubSetupServer();
    renderConnection({ ...ME, role: "member" }, undefined, gatewayDetailPath(TEST_GATEWAY.id));
    const gw = await detail();
    expect(within(gw).getByRole("heading", { level: 1, name: "사무실" })).toBeInTheDocument();
    expect(within(gw).queryByRole("button", { name: "에이전트 가져오기" })).toBeNull();
    expect(within(gw).getByText("아직 에이전트가 없습니다.")).toBeInTheDocument();
  });

  it("unknown gateway id shows not found", async () => {
    stubSetupServer();
    renderConnection({ ...ME, role: "member" }, undefined, gatewayDetailPath(GATEWAY_ID));
    expect(await screen.findByText("이 연결을 찾을 수 없습니다")).toBeInTheDocument();
  });
});
