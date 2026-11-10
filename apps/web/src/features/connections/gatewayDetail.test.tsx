import type { ConnectionsResponse } from "@dodok/shared";
import { screen, waitFor, within } from "@testing-library/react";
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
import { ME, TEST_GATEWAY, json } from "../../../test/shellApi";

// Gateway 상세(연결 탭 통합 스펙 3.3) — 섹션 셋과 역할별로 보이는 것. 섹션 안의 자세한 동작은 setup/connection·gateways 시험

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const detail = () => screen.findByTestId("gateway-detail");
const ADMIN = { ...ME, role: "admin" };
/** 주인 가름에 쓰는 나 — 연결 목록의 주인 id 는 uuid 다 */
const ME_ID = "0190a000-0000-7000-8000-0000000000d1";
const MEMBER = { ...ME, user: { ...ME.user, id: ME_ID }, role: "member" };
const MIA = "0190a000-0000-7000-8000-0000000000c1";
/** 첫 Gateway(`GATEWAY_ID`) 하나의 연결 목록 */
const listOf = (over: Partial<ConnectionsResponse["gateways"][number]> = {}): ConnectionsResponse => ({
  gateways: [{ id: GATEWAY_ID, name: "사무실", enabled: true, approved: true, owner: null, ...over }],
  runners: [],
  projects: [],
});

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

  it("bridge token section has no explanation or 「?」 — 발급 단추와 목록만(2026-11-10 문구 걷기)", async () => {
    stubSetupServer();
    renderConnection();
    const tokens = await within(await detail()).findByRole("region", { name: "브리지 토큰" });
    expect(within(tokens).getByRole("button", { name: "새 토큰 발급" })).toBeInTheDocument();
    expect(within(tokens).queryByRole("group")).toBeNull();
    expect(tokens).not.toHaveTextContent(PUBLIC_URL);
  });

  it("plugin box is open when no plugin is connected and collapsed otherwise", async () => {
    stubSetupServer({ status: statusOf({ plugin: null, pluginMatches: null }) });
    renderConnection();
    const plugin = await within(await detail()).findByRole("region", { name: "플러그인" });
    expect(within(plugin).getByText("플러그인 설치").closest("details")).toHaveAttribute("open");
  });
});

describe("연결의 주인·승인(2단계)", () => {
  it("admin sees approve button with the url — 누르면 승인을 보낸다, 메타에 주인", async () => {
    const server = stubSetupServer({
      me: ADMIN,
      status: statusOf({ first: { approved: false }, gateway: { state: "disabled" }, plugin: null }),
      connections: listOf({ approved: false, owner: { id: MIA, name: "mia" } }),
    });
    renderConnection(ADMIN, undefined, gatewayDetailPath(GATEWAY_ID));
    const gw = await detail();
    expect(within(gw).getByRole("heading", { level: 1, name: "사무실" })).toBeInTheDocument();
    expect(gw).toHaveTextContent("주인 mia");
    const approval = within(gw).getByRole("group", { name: "승인 대기" });
    // 무엇을 승인하는지 — 주소를 한 줄로
    expect(within(approval).getByText("wss://gateway.example.com")).toBeInTheDocument();
    await userEvent.click(within(approval).getByRole("button", { name: "사무실 승인" }));
    // 화면에 그린 주소를 함께 보낸다 — 서버는 그 주소일 때만 승인한다(리뷰 M1)
    await waitFor(() =>
      expect(
        server.calls.find((c) => c.method === "POST" && c.url === `/api/v1/gateways/${GATEWAY_ID}/approve`)
          ?.body,
      ).toEqual({ url: "wss://gateway.example.com" }),
    );
    // admin 은 남의 Gateway 도 관리한다 — 플러그인·브리지 토큰
    expect(
      within(gw)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(["플러그인", "브리지 토큰", "에이전트 0"]);
  });

  it("approve 409 (url changed meanwhile) — 승인 줄에 「주소가 바뀌었습니다」 한 줄, 설정 상태를 다시 받는다", async () => {
    const server = stubSetupServer({
      me: ADMIN,
      status: statusOf({ first: { approved: false }, gateway: { state: "disabled" }, plugin: null }),
      connections: listOf({ approved: false, owner: { id: MIA, name: "mia" } }),
    });
    // 승인만 409 로 — 나머지는 가짜 서버 그대로
    const base = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (input, init) =>
        init?.method === "POST" && String(input) === `/api/v1/gateways/${GATEWAY_ID}/approve`
          ? json(409, { code: "CONFLICT", message: "gateway url changed — review it again" })
          : base(input, init),
      ),
    );
    renderConnection(ADMIN, undefined, gatewayDetailPath(GATEWAY_ID));
    const approval = within(await detail()).getByRole("group", { name: "승인 대기" });
    await waitFor(() => expect(server.count("GET", "/api/v1/setup/status")).toBe(1));
    await userEvent.click(within(approval).getByRole("button", { name: "사무실 승인" }));
    expect(await within(approval).findByRole("alert")).toHaveTextContent(
      "주소가 바뀌었습니다 — 다시 확인하세요",
    );
    await waitFor(() => expect(server.count("GET", "/api/v1/setup/status")).toBe(2));
  });

  it("member's new gateway shows pending approval — 플러그인·브리지 토큰은 미리 준비할 수 있고, 승인 단추는 없다", async () => {
    stubSetupServer({
      me: MEMBER,
      status: statusOf({ first: { approved: false }, gateway: { state: "disabled" }, plugin: null }),
      connections: listOf({ approved: false, owner: { id: ME_ID, name: "주인" } }),
    });
    renderConnection(MEMBER, undefined, gatewayDetailPath(GATEWAY_ID));
    const gw = await detail();
    // 머리 배지 하나 — 아래 따로 설명 줄은 없다(2026-11-10 문구 걷기)
    expect(within(gw).getByText("승인 대기")).toBeInTheDocument();
    expect(within(gw).queryByText(/승인하면/)).toBeNull();
    expect(within(gw).queryByRole("button", { name: /승인$/ })).toBeNull();
    expect(
      within(gw)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(["플러그인", "브리지 토큰", "에이전트 0"]);
    expect(within(gw).getByRole("button", { name: "사무실 수정" })).toBeInTheDocument();
  });

  it("member opening another's gateway sees no plugin or bridge tokens — 주소·토큰 요청도 없다", async () => {
    const server = stubSetupServer({
      me: MEMBER,
      connections: {
        gateways: [
          {
            id: TEST_GATEWAY.id,
            name: "사무실",
            enabled: true,
            approved: true,
            owner: { id: MIA, name: "mia" },
          },
        ],
        runners: [],
        projects: [],
      },
    });
    renderConnection(MEMBER, undefined, gatewayDetailPath(TEST_GATEWAY.id));
    const gw = await detail();
    expect(gw).toHaveTextContent("주인 mia");
    expect(
      within(gw)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent),
    ).toEqual(["에이전트 0"]);
    expect(within(gw).queryByRole("button", { name: /수정|끄기|삭제/ })).toBeNull();
    expect(server.calls.filter((c) => /bridge-tokens|setup\/status/.test(c.url))).toEqual([]);
  });
});

describe("owner 가 아니면", () => {
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
