import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOME_GATEWAY,
  agentDetail,
  agentPath,
  apiErr,
  discoverUrl,
  json,
  makeAgent,
  openDiscover,
  renderPage,
  stubServer,
} from "../../../test/agentsPage";
import { TEST_GATEWAY } from "../../../test/shellApi";

/** 핸들 줄 — 「@핸들 · Gateway 이름」은 핸들과 이름이 따로 그려져 줄 전체 글자로 찾는다 */
const handleLine = (text: string) =>
  screen.findByText((_, el) => el?.tagName === "SPAN" && el.textContent === text);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const HOME = { id: HOME_GATEWAY.id, name: HOME_GATEWAY.name };
const mainOffice = () => makeAgent({ providerAgentId: "main", handle: "main-office", name: "Main 사무실" });
const mainHome = () =>
  makeAgent({ providerAgentId: "main", handle: "main-home", name: "Main 집", gateway: HOME });

describe("에이전트 줄 — Gateway(멀티 Gateway 스펙 「웹」 절)", () => {
  it("두 Gateway 의 같은 id(main)는 트리에서 각 Gateway 아래 한 줄씩, 상세의 핸들 옆에 Gateway 이름", async () => {
    const office = mainOffice();
    stubServer({ agents: [office, mainHome()], gateways: [TEST_GATEWAY, HOME_GATEWAY] });
    renderPage(undefined, "owner", agentPath(office));
    const nav = await screen.findByRole("navigation", { name: "연결 목록" });
    const under = async (gateway: RegExp) =>
      (await within(nav).findByRole("link", { name: gateway })).parentElement as HTMLElement;
    expect(within(await under(/^사무실/)).getByRole("link", { name: /Main 사무실/ })).toBeInTheDocument();
    expect(within(await under(/^사무실/)).queryByRole("link", { name: /Main 집/ })).toBeNull();
    expect(within(await under(/^집/)).getByRole("link", { name: /Main 집/ })).toBeInTheDocument();
    expect(await handleLine("@main-office · 사무실")).toBeInTheDocument();
    expect(within(await agentDetail()).getByText("main", { selector: "code" })).toBeInTheDocument();
  });

  // 「Gateway 옮기기」는 admin 이상(연결 탭 통합 스펙 5.2 — owner 만이던 것을 넓혔다). member 는 두 Gateway 가 다 자기 것일 때만인데,
  // 연결이 빈 에이전트는 원래 Gateway 가 없어 admin 이상만
  it.each(["owner", "admin"])(
    "연결이 빈 OpenClaw 에이전트 — %s 에게는 「다른 Gateway 로 옮기세요」와 「Gateway 옮기기」",
    async (role) => {
      const orphan = makeAgent({ providerAgentId: "main", handle: "main", name: "Main", gateway: null });
      stubServer({ agents: [orphan] });
      renderPage(undefined, role, agentPath(orphan));
      expect(await screen.findByText("Gateway 가 삭제됨 — 다른 Gateway 로 옮기세요")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "@main Gateway 옮기기" })).toBeInTheDocument();
    },
  );

  it.each(["member"])(
    "연결이 빈 OpenClaw 에이전트 — %s 에게는 할 수 없는 조치를 권하지 않고 「Gateway 옮기기」도 없다",
    async (role) => {
      const orphan = makeAgent({ providerAgentId: "main", handle: "main", name: "Main", gateway: null });
      stubServer({ agents: [orphan] });
      renderPage(undefined, role, agentPath(orphan));
      expect(
        await screen.findByText("Gateway 가 삭제됨 — admin 이 다른 Gateway 로 옮길 때까지 답하지 못합니다"),
      ).toBeInTheDocument();
      expect(within(await agentDetail()).getByText("@main")).toBeInTheDocument();
      expect(screen.queryByText(/다른 Gateway 로 옮기세요/)).toBeNull();
      expect(screen.queryByRole("button", { name: "@main Gateway 옮기기" })).toBeNull();
    },
  );

  it("owner 는 「Gateway 옮기기」로 다른 Gateway 를 골라 PUT — 줄이 새 Gateway 이름으로 바뀐다", async () => {
    const orphan = makeAgent({ providerAgentId: "main", handle: "main", name: "Main", gateway: null });
    const server = stubServer({ agents: [orphan], gateways: [TEST_GATEWAY, HOME_GATEWAY] });
    renderPage(undefined, "owner", agentPath(orphan));
    await userEvent.click(await screen.findByRole("button", { name: "@main Gateway 옮기기" }));
    const dialog = await screen.findByRole("dialog", { name: "Gateway 옮기기" });
    await userEvent.click(within(dialog).getByRole("radio", { name: "집" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "옮기기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.bodies("PUT")).toEqual([{ gatewayId: HOME_GATEWAY.id }]);
    expect(await handleLine("@main · 집")).toBeInTheDocument();
    expect(screen.queryByText(/Gateway 가 삭제됨/)).toBeNull();
  });

  it("옮길 Gateway 에 같은 id 가 있으면(409) 대화상자 안에 고정 문구 — 서버 문구는 보이지 않는다", async () => {
    const orphan = makeAgent({ providerAgentId: "main", handle: "main", name: "Main", gateway: null });
    stubServer({
      agents: [orphan],
      move: () => apiErr(409, "CONFLICT", "providerAgentId main 는 그 Gateway 에 이미 등록돼 있다"),
    });
    renderPage(undefined, "owner", agentPath(orphan));
    await userEvent.click(await screen.findByRole("button", { name: "@main Gateway 옮기기" }));
    const dialog = await screen.findByRole("dialog", { name: "Gateway 옮기기" });
    await userEvent.click(within(dialog).getByRole("button", { name: "옮기기" }));
    expect(
      await within(dialog).findByText("옮길 Gateway 에 같은 id 의 에이전트가 이미 있습니다"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/이미 등록돼 있다/)).toBeNull();
  });

  it("고른 Gateway 가 그새 지워졌으면(400) 대화상자 안에 고정 문구 — 서버 문구는 보이지 않는다", async () => {
    const orphan = makeAgent({ providerAgentId: "main", handle: "main", name: "Main", gateway: null });
    stubServer({
      agents: [orphan],
      move: () => apiErr(400, "VALIDATION", "body — gatewayId: gateway not found"),
    });
    renderPage(undefined, "owner", agentPath(orphan));
    await userEvent.click(await screen.findByRole("button", { name: "@main Gateway 옮기기" }));
    const dialog = await screen.findByRole("dialog", { name: "Gateway 옮기기" });
    await userEvent.click(within(dialog).getByRole("button", { name: "옮기기" }));
    expect(
      await within(dialog).findByText("그 Gateway 를 찾지 못했습니다 — 다시 고르세요"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/gateway not found/)).toBeNull();
  });

  it("옮기기 안내는 실제 규칙 — 그 Gateway 에 OpenClaw 에이전트는 있어야 하고, 이미 등록된 같은 id 는 없어야 한다", async () => {
    const office = mainOffice();
    stubServer({ agents: [office], gateways: [TEST_GATEWAY, HOME_GATEWAY] });
    renderPage(undefined, "owner", agentPath(office));
    await userEvent.click(await screen.findByRole("button", { name: "@main-office Gateway 옮기기" }));
    const dialog = await screen.findByRole("dialog", { name: "Gateway 옮기기" });
    expect(dialog).toHaveAccessibleDescription(
      "@main-office 가 답할 Gateway 를 고릅니다. 그 Gateway 에 OpenClaw 에이전트 main 이 있어야 하고, 그 Gateway 로 이미 등록된 main 이 없어야 합니다.",
    );
  });

  it("옮기기 대화상자는 지금 Gateway 를 후보에서 뺀다", async () => {
    const office = mainOffice();
    stubServer({ agents: [office], gateways: [TEST_GATEWAY, HOME_GATEWAY] });
    renderPage(undefined, "owner", agentPath(office));
    await userEvent.click(await screen.findByRole("button", { name: "@main-office Gateway 옮기기" }));
    const dialog = await screen.findByRole("dialog", { name: "Gateway 옮기기" });
    expect(within(dialog).getAllByRole("radio")).toHaveLength(1);
    expect(within(dialog).getByRole("radio", { name: "집" })).toBeChecked();
  });
});

describe("에이전트 가져오기 — 그 Gateway 상세에 고정", () => {
  it("Gateway 상세의 가져오기는 그 Gateway 의 목록 — 이미 등록한 것은 「같은 Gateway + 같은 id」로만 숨긴다", async () => {
    const server = stubServer({
      agents: [mainOffice()],
      gateways: [TEST_GATEWAY, HOME_GATEWAY],
      discover: (gatewayId) =>
        json(200, {
          agents:
            gatewayId === HOME_GATEWAY.id
              ? [{ providerAgentId: "main", name: "Main" }, { providerAgentId: "dev" }]
              : [{ providerAgentId: "main", name: "Main" }, { providerAgentId: "fin" }],
        }),
    });
    renderPage();
    const dialog = await openDiscover("사무실");
    // 고르기 없이 그 Gateway 하나 — 사무실의 main 은 이미 등록돼 숨는다
    expect(dialog).toHaveAccessibleDescription(
      "「사무실」 Gateway 의 에이전트 중 아직 등록하지 않은 것을 고릅니다.",
    );
    expect(within(dialog).queryByRole("radio")).toBeNull();
    await within(dialog).findByRole("checkbox", { name: "fin" });
    expect(within(dialog).queryByRole("checkbox", { name: "Main" })).toBeNull();
    expect(server.count("GET", discoverUrl(HOME_GATEWAY.id))).toBe(0);

    cleanup();
    renderPage();
    const home = await openDiscover("집");
    // 집의 main 은 같은 id 라도 다른 Gateway 라 보인다
    await within(home).findByRole("checkbox", { name: "Main" });
    const dialog2 = home;
    expect(within(dialog2).getByRole("checkbox", { name: "dev" })).toBeInTheDocument();
    expect(server.count("GET", discoverUrl(HOME_GATEWAY.id))).toBe(1);
  });

  it("핸들 칸은 id 로 채우고, 이미 쓰이는 핸들이면 고정 문구 — 바꾸면 등록 본문에 gatewayId", async () => {
    const server = stubServer({
      agents: [makeAgent({ providerAgentId: "main", handle: "main", name: "Main", gateway: HOME })],
      gateways: [TEST_GATEWAY, HOME_GATEWAY],
      discover: () => json(200, { agents: [{ providerAgentId: "main", name: "Main" }] }),
    });
    renderPage();
    const dialog = await openDiscover();
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "Main" }));
    const handle = within(dialog).getByRole("textbox", { name: "Main 핸들" });
    expect(handle).toHaveValue("main");
    expect(handle).toHaveAccessibleDescription("이미 쓰이는 핸들입니다 — 다른 핸들을 입력하세요");
    expect(within(dialog).getByRole("button", { name: "1개 등록" })).toBeDisabled();

    await userEvent.clear(handle);
    await userEvent.type(handle, "main-office");
    await userEvent.click(within(dialog).getByRole("button", { name: "1개 등록" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.bodies("POST")).toEqual([
      {
        provider: "openclaw",
        gatewayId: TEST_GATEWAY.id,
        providerAgentId: "main",
        handle: "main-office",
        name: "Main",
      },
    ]);
    // 등록한 에이전트는 그 Gateway 상세의 「에이전트 N」에
    expect(
      await within(screen.getByTestId("gateway-detail")).findByRole("link", { name: /Main.*@main-office/ }),
    ).toBeInTheDocument();
  });

  it("서버가 핸들 겹침(409 field handle)으로 막으면 같은 고정 문구 — 서버 문구는 보이지 않는다", async () => {
    stubServer({
      discover: () => json(200, { agents: [{ providerAgentId: "ops" }] }),
      create: () => apiErr(409, "CONFLICT", "handle @ops 는 이미 쓰이고 있다"),
    });
    renderPage();
    const dialog = await openDiscover();
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: "ops" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "1개 등록" }));
    const handle = within(dialog).getByRole("textbox", { name: "ops 핸들" });
    await waitFor(() =>
      expect(handle).toHaveAccessibleDescription("이미 쓰이는 핸들입니다 — 다른 핸들을 입력하세요"),
    );
    expect(within(dialog).queryByText(/이미 쓰이고 있다/)).toBeNull();
  });

  it.each(["owner", "admin"])(
    "Gateway 가 0개면(%s) 트리에 「아직 연결이 없습니다」 — 가져오기 버튼이 없고 찾기를 부르지 않는다",
    async (role) => {
      const server = stubServer({ gateways: [] });
      renderPage(undefined, role);
      const nav = await screen.findByRole("navigation", { name: "연결 목록" });
      expect(await within(nav).findByText("아직 연결이 없습니다.")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "에이전트 가져오기" })).toBeNull();
      // 연결 추가는 멤버 누구나(연결 탭 통합 스펙 5.2)
      expect(screen.getByRole("link", { name: "연결 추가" })).toBeInTheDocument();
      expect(server.count("GET", discoverUrl())).toBe(0);
    },
  );

  it("직접 입력도 그 상세의 Gateway 로 등록한다", async () => {
    const server = stubServer({
      gateways: [TEST_GATEWAY, HOME_GATEWAY],
      discover: () => apiErr(503, "ADAPTER_UNAVAILABLE", "gateway not connected"),
    });
    renderPage();
    const dialog = await openDiscover("집");
    const id = await within(dialog).findByRole("textbox", { name: "OpenClaw id" });
    await userEvent.type(id, "ops");
    await userEvent.click(within(dialog).getByRole("button", { name: "등록" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.bodies("POST")).toEqual([
      {
        provider: "openclaw",
        gatewayId: HOME_GATEWAY.id,
        providerAgentId: "ops",
        handle: "ops",
        name: "ops",
      },
    ]);
  });
});
