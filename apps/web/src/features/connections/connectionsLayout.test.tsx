import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAgent } from "../../../test/agentsPage";
import { renderConnectionRoute, stubConnection } from "../../../test/connectionServer";
import { stubMedia } from "../../../test/media";
import { projectOf, runnerId, runnerOf } from "../../../test/runnersServer";
import { statusOf } from "../../../test/setupServer";
import { TEST_GATEWAY } from "../../../test/shellApi";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const R1 = runnerId(1);
const R2 = runnerId(2);
const OWN_GW = "0190a000-0000-7000-8000-00000000a0f1";
const ME_ID = "0190a000-0000-7000-8000-0000000000d1";
const OTHER_ID = "0190a000-0000-7000-8000-0000000000d2";
const dev = () =>
  makeAgent({
    providerAgentId: "dev",
    handle: "dev",
    name: "Dev",
    gateway: { id: TEST_GATEWAY.id, name: TEST_GATEWAY.name },
  });
const coder = (projectId?: string) =>
  makeAgent({
    provider: "runner",
    providerAgentId: "r-coder",
    handle: "coder",
    name: "Coder",
    runner: { tokenId: R1, label: "mia 의 맥북", revoked: false },
    ...(projectId
      ? {
          runnerAgent: {
            projectId,
            disallowedTools: [],
          },
        }
      : {}),
  });
const treeNav = () => screen.findByRole("navigation", { name: "연결 목록" });

describe("역할마다 다른 트리", () => {
  it("member sees gateways and runner agents without calling admin APIs", async () => {
    const server = stubConnection({ role: "member", agents: [dev(), coder()] });
    renderConnectionRoute();
    const nav = await treeNav();
    expect(await within(nav).findByRole("link", { name: /사무실/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /Dev/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /mia 의 맥북/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /Coder/ })).toBeInTheDocument();
    expect(server.count("GET", "/api/v1/runners")).toBe(0);
    expect(server.count("GET", "/api/v1/setup/status")).toBe(0);
    expect(server.count("GET", /\/api\/v1\/runners\/.+\/projects/)).toBe(0);
    // 연결 추가는 멤버 누구나(member 의 Gateway 는 승인 대기 — 연결 탭 통합 스펙 5.2)
    expect(screen.getByRole("link", { name: "연결 추가" })).toHaveAttribute(
      "href",
      "/settings/connection/new",
    );
  });

  it("member sees own connections under 내 연결 and can add one — 남의 것은 「다른 사람의 연결」, 승인 대기 배지", async () => {
    const server = stubConnection({
      role: "member",
      meId: ME_ID,
      agents: [dev(), coder()],
      connections: {
        gateways: [
          {
            id: TEST_GATEWAY.id,
            name: "사무실",
            enabled: true,
            approved: true,
            owner: { id: OTHER_ID, name: "주인" },
          },
          { id: OWN_GW, name: "mia 집", enabled: true, approved: false, owner: { id: ME_ID, name: "나" } },
        ],
        runners: [
          { id: R1, label: "mia 의 맥북", connected: true, revoked: false, owner: { id: ME_ID, name: "나" } },
          {
            id: R2,
            label: "빈 러너",
            connected: false,
            revoked: false,
            owner: { id: OTHER_ID, name: "주인" },
          },
        ],
        projects: [],
      },
    });
    renderConnectionRoute();
    const nav = await treeNav();
    const mine = await within(nav).findByRole("region", { name: "내 연결" });
    expect(within(mine).getByRole("link", { name: /mia 집.*승인 대기/ })).toBeInTheDocument();
    expect(within(mine).getByRole("link", { name: /mia 의 맥북.*연결됨/ })).toBeInTheDocument();
    const others = within(nav).getByRole("region", { name: "다른 사람의 연결" });
    expect(within(others).getByRole("link", { name: /사무실/ })).toBeInTheDocument();
    // 에이전트 없는 러너도 연결 목록으로 보인다(1단계 member 의 빈 칸)
    expect(within(others).getByRole("link", { name: /빈 러너.*끊김/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "연결 추가" })).toBeInTheDocument();
    // 연결을 가진 member 는 자기 연결의 설정 상태를 받는다(서버가 거른다) — 러너 REST 는 부르지 않는다
    await waitFor(() => expect(server.count("GET", "/api/v1/setup/status")).toBeGreaterThan(0));
    expect(server.count("GET", "/api/v1/runners")).toBe(0);
  });

  it("admin sees projects under runners", async () => {
    const project = projectOf(1, { runnerId: R1, label: "dodok" });
    const server = stubConnection({
      role: "admin",
      agents: [dev(), coder(project.id)],
      runners: [runnerOf(1, { label: "mia 의 맥북" })],
      projects: [project],
    });
    renderConnectionRoute();
    const nav = await treeNav();
    const projectLink = await within(nav).findByRole("link", { name: /dodok/ });
    // 프로젝트 줄 바로 아래 목록에 Coder
    const nested = projectLink.parentElement?.querySelector("ul");
    expect(nested).not.toBeNull();
    expect(within(nested as HTMLElement).getByRole("link", { name: /Coder/ })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: /mia 의 맥북.*연결됨/ })).toBeInTheDocument();
    // admin 은 모든 연결을 관리한다 — 설정 상태를 받는다(연결 탭 통합 스펙 5.2)
    await waitFor(() => expect(server.count("GET", "/api/v1/setup/status")).toBeGreaterThan(0));
    expect(screen.getByRole("link", { name: "연결 추가" })).toBeInTheDocument();
  });

  it("owner sees gateway state from setup status", async () => {
    const server = stubConnection({
      role: "owner",
      agents: [dev()],
      runners: [],
      setup: statusOf({ gateway: { pairing: { requestId: "req-1", since: "2026-09-25T00:00:00.000Z" } } }),
    });
    renderConnectionRoute();
    const nav = await treeNav();
    // 페어링 대기는 setup 상태만 안다(wire 줄에는 없다)
    expect(await within(nav).findByRole("link", { name: /사무실.*페어링 대기/ })).toBeInTheDocument();
    expect(server.count("GET", "/api/v1/setup/status")).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "연결 추가" })).toHaveAttribute(
      "href",
      "/settings/connection/new",
    );
  });
});

describe("묶음", () => {
  it("archived group is collapsed and shows count", async () => {
    stubConnection({
      role: "member",
      agents: [dev(), { ...coder(), archivedAt: "2026-10-05T00:00:00.000Z" }],
    });
    renderConnectionRoute();
    const nav = await treeNav();
    const toggle = await within(nav).findByRole("button", { name: "삭제된 에이전트 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).queryByRole("link", { name: /Coder/ })).toBeNull();
    await userEvent.click(toggle);
    expect(within(nav).getByRole("link", { name: /Coder/ })).toBeInTheDocument();
  });

  it("orphaned group only when present", async () => {
    stubConnection({ role: "member", agents: [dev()] });
    renderConnectionRoute();
    await within(await treeNav()).findByRole("link", { name: /Dev/ });
    expect(screen.queryByRole("region", { name: "연결 없음" })).toBeNull();
  });

  it("orphaned group shows agents whose gateway is gone", async () => {
    stubConnection({
      role: "member",
      agents: [makeAgent({ providerAgentId: "old", handle: "old", name: "Old", gateway: null })],
    });
    renderConnectionRoute();
    const group = await screen.findByRole("region", { name: "연결 없음" });
    expect(within(group).getByRole("link", { name: /Old.*Gateway 가 삭제됨/ })).toBeInTheDocument();
  });
});

describe("좁은 화면", () => {
  it("narrow screen shows tree first then detail with back link", async () => {
    stubMedia(true);
    stubConnection({ role: "member", agents: [dev()] });
    const { router } = renderConnectionRoute();
    const nav = await treeNav();
    await userEvent.click(await within(nav).findByRole("link", { name: /Dev/ }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/settings\/connection\/agent\//));
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "연결 목록" })).toBeNull());
    const header = screen.getByTestId("settings-header");
    const back = within(header).getByRole("link", { name: "연결" });
    expect(back).toHaveTextContent("← 연결");
    expect(back).toHaveAttribute("href", "/settings/connection");
    // 뒤로 가기 단추는 하나 — 「← 설정」이 따로 남지 않는다
    expect(screen.queryByRole("link", { name: "설정" })).toBeNull();
    expect(screen.getAllByText("←")).toHaveLength(1);
    await userEvent.click(back);
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/connection"));
    expect(await treeNav()).toBeInTheDocument();
  });

  it("the tab address itself keeps 「← 설정」", async () => {
    stubMedia(true);
    stubConnection({ role: "member", agents: [dev()] });
    renderConnectionRoute();
    await treeNav();
    const header = screen.getByTestId("settings-header");
    expect(within(header).getByRole("link", { name: "설정" })).toHaveAttribute("href", "/settings");
  });
});

describe("트리 꼴(연결 재설계 스펙 목표 1)", () => {
  const memberConnections = () =>
    stubConnection({
      role: "member",
      meId: ME_ID,
      agents: [dev(), coder()],
      connections: {
        gateways: [
          {
            id: TEST_GATEWAY.id,
            name: "사무실",
            enabled: true,
            approved: true,
            owner: { id: OTHER_ID, name: "주인" },
          },
          {
            id: OWN_GW,
            name: "mia 집",
            enabled: true,
            approved: false,
            owner: { id: OTHER_ID, name: "주인" },
          },
        ],
        runners: [
          {
            id: R1,
            label: "mia 의 맥북",
            connected: true,
            revoked: false,
            owner: { id: OTHER_ID, name: "주인" },
          },
          {
            id: R2,
            label: "옛 러너",
            connected: false,
            revoked: true,
            owner: { id: OTHER_ID, name: "주인" },
          },
        ],
        projects: [],
      },
    });

  it("Gateway·러너를 개수 있는 묶음 머리로 가르고, 상태는 점 + 글(강조색 배지 없음)", async () => {
    memberConnections();
    renderConnectionRoute();
    const nav = await treeNav();
    const gateways = await within(nav).findByRole("region", { name: "GATEWAY 2" });
    const runners = within(nav).getByRole("region", { name: "러너 2" });
    const office = within(gateways).getByRole("link", { name: /사무실.*연결됨/ });
    expect(office.querySelector('[data-state="success"]')).not.toBeNull();
    expect(within(runners).getByRole("link", { name: /mia 의 맥북.*연결됨/ })).toBeInTheDocument();
    expect(nav.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("승인 대기 Gateway 는 주황 점, 폐기된 러너는 회색 점 — 글이 함께", async () => {
    memberConnections();
    renderConnectionRoute();
    const nav = await treeNav();
    const pending = await within(nav).findByRole("link", { name: /mia 집.*승인 대기/ });
    expect(pending.querySelector('[data-state="warning"]')).not.toBeNull();
    const revoked = within(nav).getByRole("link", { name: /옛 러너.*폐기됨/ });
    expect(revoked.querySelector('[data-state="muted"]')).not.toBeNull();
  });

  it("러너 에이전트 줄에 프로그램 배지, 에이전트는 이니셜 아바타", async () => {
    memberConnections();
    renderConnectionRoute();
    const nav = await treeNav();
    const coderLink = await within(nav).findByRole("link", { name: /Coder/ });
    expect(within(coderLink).getByRole("img", { name: "Claude Code" })).toHaveTextContent("CC");
    const devLink = within(nav).getByRole("link", { name: /Dev/ });
    expect(within(devLink).queryByRole("img", { name: "Claude Code" })).toBeNull();
    expect(devLink.querySelector('[data-kind="agent"]')).not.toBeNull();
  });

  it("접으면 줄 끝에 「에이전트 N」 요약, 펼치면 다시 줄", async () => {
    memberConnections();
    renderConnectionRoute();
    const nav = await treeNav();
    await within(nav).findByRole("link", { name: /Dev/ });
    const toggle = within(nav).getByRole("button", { name: "사무실 접기" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle);
    expect(within(nav).queryByRole("link", { name: /Dev/ })).toBeNull();
    expect(within(nav).getByRole("link", { name: /사무실.*에이전트 1/ })).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole("button", { name: "사무실 펼치기" }));
    expect(within(nav).getByRole("link", { name: /Dev/ })).toBeInTheDocument();
  });

  it("검색칸 — 못 찾으면 안내, 비우면 원래 트리와 접힘 상태", async () => {
    memberConnections();
    renderConnectionRoute();
    const nav = await treeNav();
    await within(nav).findByRole("link", { name: /Coder/ });
    await userEvent.click(within(nav).getByRole("button", { name: "사무실 접기" }));
    const before = within(nav).getAllByRole("link").length;
    const search = screen.getByRole("searchbox", { name: "연결·에이전트 찾기" });
    await userEvent.type(search, "zzz");
    expect(within(nav).getByText("찾는 연결·에이전트가 없습니다")).toBeInTheDocument();
    expect(within(nav).queryAllByRole("link")).toHaveLength(0);
    await userEvent.clear(search);
    await userEvent.type(search, "dev");
    // 찾는 동안은 접힌 연결도 펼쳐 맞는 에이전트를 보인다
    expect(within(nav).getByRole("link", { name: /Dev/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /Coder/ })).toBeNull();
    await userEvent.clear(search);
    expect(within(nav).getAllByRole("link")).toHaveLength(before);
    expect(within(nav).getByRole("button", { name: "사무실 펼치기" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
