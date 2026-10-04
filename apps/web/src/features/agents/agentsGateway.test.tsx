import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOME_GATEWAY,
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

describe("에이전트 줄 — Gateway(멀티 Gateway 스펙 7장)", () => {
  it("두 Gateway 의 같은 id(main)는 두 줄로, 핸들 옆에 Gateway 이름", async () => {
    stubServer({ agents: [mainOffice(), mainHome()], gateways: [TEST_GATEWAY, HOME_GATEWAY] });
    renderPage();
    expect(await handleLine("@main-office · 사무실")).toBeInTheDocument();
    expect(await handleLine("@main-home · 집")).toBeInTheDocument();
    expect(screen.getAllByText("main", { selector: "code" })).toHaveLength(2);
  });

  it("연결이 빈 OpenClaw 에이전트는 「Gateway 가 삭제됨」 — owner 에게만 「Gateway 옮기기」", async () => {
    const orphan = makeAgent({ providerAgentId: "main", handle: "main", name: "Main", gateway: null });
    stubServer({ agents: [orphan] });
    renderPage(undefined, "admin");
    expect(
      await screen.findByText("Gateway 가 삭제됨 — 다른 Gateway 로 옮기거나 지우세요"),
    ).toBeInTheDocument();
    expect(screen.getByText("@main")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "@main Gateway 옮기기" })).toBeNull();
  });

  it("owner 는 「Gateway 옮기기」로 다른 Gateway 를 골라 PUT — 줄이 새 Gateway 이름으로 바뀐다", async () => {
    const orphan = makeAgent({ providerAgentId: "main", handle: "main", name: "Main", gateway: null });
    const server = stubServer({ agents: [orphan], gateways: [TEST_GATEWAY, HOME_GATEWAY] });
    renderPage();
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
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "@main Gateway 옮기기" }));
    const dialog = await screen.findByRole("dialog", { name: "Gateway 옮기기" });
    await userEvent.click(within(dialog).getByRole("button", { name: "옮기기" }));
    expect(
      await within(dialog).findByText("옮길 Gateway 에 같은 id 의 에이전트가 이미 있습니다"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/이미 등록돼 있다/)).toBeNull();
  });

  it("옮기기 대화상자는 지금 Gateway 를 후보에서 뺀다", async () => {
    stubServer({ agents: [mainOffice()], gateways: [TEST_GATEWAY, HOME_GATEWAY] });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "@main-office Gateway 옮기기" }));
    const dialog = await screen.findByRole("dialog", { name: "Gateway 옮기기" });
    expect(within(dialog).getAllByRole("radio")).toHaveLength(1);
    expect(within(dialog).getByRole("radio", { name: "집" })).toBeChecked();
  });
});

describe("에이전트 가져오기 — Gateway 고르기", () => {
  it("Gateway 를 고르면 그 Gateway 의 목록 — 이미 등록한 것은 「같은 Gateway + 같은 id」로만 숨긴다", async () => {
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
    const dialog = await openDiscover();
    // 첫 Gateway(사무실)가 골라져 있다 — 사무실의 main 은 이미 등록돼 숨는다
    expect(within(dialog).getByRole("radio", { name: "사무실" })).toBeChecked();
    await within(dialog).findByRole("checkbox", { name: "fin" });
    expect(within(dialog).queryByRole("checkbox", { name: "Main" })).toBeNull();

    await userEvent.click(within(dialog).getByRole("radio", { name: "집" }));
    // 집의 main 은 같은 id 라도 다른 Gateway 라 보인다
    await within(dialog).findByRole("checkbox", { name: "Main" });
    expect(within(dialog).getByRole("checkbox", { name: "dev" })).toBeInTheDocument();
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
    expect(await handleLine("@main-office · 사무실")).toBeInTheDocument();
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

  it("Gateway 가 0개면 「Gateway 를 먼저 추가하세요」 — 찾기를 부르지 않고, owner 에게는 연결 페이지 링크", async () => {
    const server = stubServer({ gateways: [] });
    renderPage();
    const dialog = await openDiscover();
    expect(await within(dialog).findByText(/Gateway 를 먼저 추가하세요/)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "연결 페이지" })).toHaveAttribute(
      "href",
      "/settings/connection",
    );
    expect(within(dialog).queryByRole("button", { name: "직접 입력" })).toBeNull();
    expect(server.count("GET", discoverUrl())).toBe(0);
  });

  it("Gateway 가 0개일 때 admin 에게는 링크 없이 안내만", async () => {
    stubServer({ gateways: [] });
    renderPage(undefined, "admin");
    const dialog = await openDiscover();
    expect(await within(dialog).findByText(/Gateway 를 먼저 추가하세요/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("link")).toBeNull();
  });

  it("직접 입력도 고른 Gateway 로 등록한다", async () => {
    const server = stubServer({
      gateways: [TEST_GATEWAY, HOME_GATEWAY],
      discover: () => apiErr(503, "ADAPTER_UNAVAILABLE", "gateway not connected"),
    });
    renderPage();
    const dialog = await openDiscover();
    await userEvent.click(within(dialog).getByRole("radio", { name: "집" }));
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
