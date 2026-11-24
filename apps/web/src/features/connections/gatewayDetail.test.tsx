import type { ConnectionsResponse } from "@dodok/shared";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
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
    expect(headings).toEqual(["상태", "에이전트", "브리지 토큰"]);
    const agents = within(gw).getByRole("region", { name: "에이전트" });
    expect(agents).toHaveTextContent("에이전트1");
    expect(await within(agents).findByRole("link", { name: /@dev/ })).toHaveAttribute(
      "href",
      `/settings/connection/agent/${agent.id}`,
    );
    // 카드 머리 동작 — 고스트 「가져오기」(접근 이름은 「에이전트 가져오기」)
    const discover = within(agents).getByRole("button", { name: "에이전트 가져오기" });
    expect(discover).toHaveTextContent("가져오기");
    expect(discover).toHaveAttribute("data-variant", "ghost");
  });

  it("bridge token section shows the bridge url as one copyable line — 설명 문장·「?」 없이(2026-11-10 문구 걷기)", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    stubSetupServer();
    renderConnection();
    const tokens = await within(await detail()).findByRole("region", { name: "브리지 토큰" });
    expect(within(tokens).getByRole("button", { name: "새 토큰 발급" })).toBeInTheDocument();
    expect(within(tokens).queryByRole("group")).toBeNull();
    const line = within(tokens).getByTestId("bridge-url");
    expect(line).toHaveTextContent(`브리지 주소${PUBLIC_URL}`);
    await userEvent.click(within(line).getByRole("button", { name: "브리지 주소 복사" }));
    expect(writeText).toHaveBeenLastCalledWith(PUBLIC_URL);
  });

  it("plugin box is open when no plugin is connected and collapsed otherwise", async () => {
    stubSetupServer({ status: statusOf({ plugin: null, pluginMatches: null }) });
    renderConnection();
    const plugin = await within(await detail()).findByRole("region", { name: "플러그인" });
    expect(within(plugin).getByText("플러그인 설치").closest("details")).toHaveAttribute("open");
  });
});

describe("머리·메뉴·카드(연결 재설계 스펙 목표 2·3)", () => {
  async function openMenu(gw: HTMLElement) {
    within(gw).getByRole("button", { name: "사무실 더 보기" }).focus();
    await userEvent.keyboard("{Enter}");
    return screen.findByRole("menu");
  }

  it("머리 — 제목·상태 칩·값 줄(판·주인·주소), 자주 쓰는 동작 하나와 「⋯」 메뉴", async () => {
    stubSetupServer({ connections: listOf({ owner: { id: MIA, name: "mia" } }) });
    renderConnection();
    const gw = await detail();
    const header = within(gw).getByRole("banner");
    expect(within(header).getByRole("heading", { level: 1, name: "사무실" })).toBeInTheDocument();
    expect(within(header).getByText("연결됨")).toHaveAttribute("data-tone", "success");
    expect(header).toHaveTextContent("OpenClaw Gateway · 주인 mia · wss://gateway.example.com · 2026.9.5");
    expect(within(header).getByRole("button", { name: "이름·주소 수정" })).toBeInTheDocument();
    // 주요(파랑) 버튼은 한 화면에 없다 — 카드 동작은 고스트, 머리 동작은 외곽선
    expect(gw.querySelector('button[data-variant="default"]')).toBeNull();
    const menu = await openMenu(gw);
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["끄기", "삭제"]);
  });

  it("메뉴의 「삭제」는 지금의 확인 줄을 연다", async () => {
    stubSetupServer();
    renderConnection();
    const gw = await detail();
    const menu = await openMenu(gw);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "삭제" }));
    expect(await within(gw).findByRole("group", { name: "「사무실」 Gateway 삭제" })).toBeInTheDocument();
  });

  it("확인 줄이 열려 있으면 「⋯」는 메뉴가 닫힌 동안만 그 줄을 aria-controls 로 가리킨다 — 열린 동안은 메뉴", async () => {
    stubSetupServer();
    renderConnection();
    const gw = await detail();
    const trigger = within(gw).getByRole("button", { name: "사무실 더 보기" });
    await userEvent.click(within(await openMenu(gw)).getByRole("menuitem", { name: "삭제" }));
    const confirm = await within(gw).findByRole("group", { name: "「사무실」 Gateway 삭제" });
    expect(confirm.id).not.toBe("");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger).toHaveAttribute("aria-controls", confirm.id);
    const menu = await openMenu(gw);
    expect(menu.id).not.toBe("");
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
  });

  it("카드 셋 — 상태(Gateway·플러그인 칸)·에이전트·브리지 토큰, 브리지 토큰 머리 동작 「새 토큰 발급」", async () => {
    stubSetupServer();
    renderConnection();
    const gw = await detail();
    const status = within(gw).getByRole("region", { name: "상태" });
    expect(within(status).getByRole("region", { name: "Gateway" })).toBeInTheDocument();
    expect(within(status).getByRole("region", { name: "플러그인" })).toBeInTheDocument();
    expect(within(gw).getByRole("region", { name: "에이전트" })).toBeInTheDocument();
    const tokens = within(gw).getByRole("region", { name: "브리지 토큰" });
    const issue = within(tokens).getByRole("button", { name: "새 토큰 발급" });
    expect(issue).toHaveAttribute("data-variant", "ghost");
    // 머리 줄(제목 옆)에 — 몸통의 브리지 주소 줄보다 앞
    expect(issue.compareDocumentPosition(within(tokens).getByTestId("bridge-url"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("플러그인 빌드를 모르면 상태 카드 안 노란 안내 띠와 「다시 설치 방법」 접힘", async () => {
    stubSetupServer({ status: statusOf({ plugin: { bundleSha256: null }, pluginMatches: null }) });
    renderConnection();
    const status = within(await detail()).getByRole("region", { name: "상태" });
    const band = within(status).getByText(/빌드를 알 수 없습니다/);
    expect(band.className).toMatch(/bg-warning/);
    const box = within(status).getByText("다시 설치 방법").closest("details");
    expect(box).not.toHaveAttribute("open");
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
    ).toEqual(["상태", "에이전트", "브리지 토큰"]);
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
    ).toEqual(["상태", "에이전트", "브리지 토큰"]);
    // 자기 Gateway 는 관리한다 — 머리의 수정과 「⋯」 메뉴
    expect(within(gw).getByRole("button", { name: "이름·주소 수정" })).toBeInTheDocument();
    expect(within(gw).getByRole("button", { name: "사무실 더 보기" })).toBeInTheDocument();
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
    ).toEqual(["에이전트"]);
    expect(within(gw).queryByRole("button", { name: /수정|끄기|삭제/ })).toBeNull();
    // 관리할 수 없으면 「⋯」 메뉴도 없다(지금 숨기던 끄기·삭제와 같은 조건)
    expect(within(gw).queryByRole("button", { name: /더 보기/ })).toBeNull();
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

describe("플러그인 원격 업데이트(원격 업데이트 스펙 U4·U6·U9)", () => {
  const PAST = "2026-11-23T00:00:00.000Z";
  const group = async () => within(await detail()).findByRole("group", { name: "플러그인 업데이트" });

  it("다른 빌드·켜짐이면 업데이트 — 확인 대화상자가 진행 중인 런 수를 보이고, 확인하면 POST", async () => {
    const server = stubSetupServer({
      status: statusOf({ plugin: { remoteUpdate: "on", lastUpdate: null }, pluginMatches: false }),
      gatewayUpdatePreview: () => json(200, { activeRuns: 2 }),
    });
    renderConnection();
    const box = await group();
    await userEvent.click(within(box).getByRole("button", { name: "업데이트" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/진행 중인 런 2개가 끊깁니다/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "업데이트" }));
    await waitFor(() => expect(server.count("POST", `/api/v1/gateways/${GATEWAY_ID}/update`)).toBe(1));
    expect(server.count("GET", `/api/v1/gateways/${GATEWAY_ID}/update`)).toBe(1);
  });

  it("같은 빌드면 단추가 없다, 끈 Gateway·옛 플러그인은 안내만", async () => {
    stubSetupServer({ status: statusOf({ plugin: { remoteUpdate: "on" }, pluginMatches: true }) });
    renderConnection();
    expect(within(await group()).queryByRole("button", { name: "업데이트" })).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    stubSetupServer({ status: statusOf({ plugin: { remoteUpdate: "off" }, pluginMatches: false }) });
    renderConnection();
    expect(await group()).toHaveTextContent("이 Gateway 에서 원격 업데이트를 껐습니다");
    expect(within(await group()).queryByRole("button", { name: "업데이트" })).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    stubSetupServer({ status: statusOf({ plugin: { remoteUpdate: "unsupported" }, pluginMatches: false }) });
    renderConnection();
    expect(await group()).toHaveTextContent("이 플러그인 판은 원격 업데이트를 지원하지 않습니다");
  });

  it("다시 붙은 플러그인이 실패를 알리면 그 사유, 상한이 지나면 「응답이 없습니다」", async () => {
    stubSetupServer({
      status: statusOf({
        plugin: { remoteUpdate: "on" },
        pluginMatches: false,
        first: {
          update: {
            state: "failed",
            message: "플러그인 설치에 실패했습니다(openclaw plugins install)",
            at: PAST,
          },
        },
      }),
    });
    renderConnection();
    expect(await within(await group()).findByRole("alert")).toHaveTextContent("플러그인 설치에 실패했습니다");
    cleanup();
    vi.unstubAllGlobals();
    stubSetupServer({
      status: statusOf({
        plugin: { remoteUpdate: "on" },
        pluginMatches: false,
        first: { update: { state: "updating", targetVersion: null, startedAt: PAST, deadline: PAST } },
      }),
    });
    renderConnection();
    expect(await within(await group()).findByRole("alert")).toHaveTextContent(
      "응답이 없습니다 — 그 머신에서 확인하세요",
    );
  });
});
