import type { ConnectionsResponse } from "@dodok/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAgent } from "../../../test/agentsPage";
import {
  json,
  projectOf,
  projectPath,
  renderRunnersPage,
  runnerId,
  runnerOf,
  runnerPath,
  stubRunners,
} from "../../../test/runnersServer";
import {
  OWNER,
  renderConnection,
  runnerDetailPath,
  runnerOf as connectionOf,
  statusOf,
  stubSetupServer,
  tokenId,
  tokenOf,
} from "../../../test/setupServer";

// 러너 상세·프로젝트 상세(연결 탭 통합 스펙 3.3). 토큰·설치 안내의 자세한 동작은 setup/runner.test, 프로젝트 줄은 runners/runners.test

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const detail = () => screen.findByTestId("runner-detail");

describe("owner", () => {
  it("owner sees projects, install steps and its token — 섹션 차례대로", async () => {
    stubSetupServer({ runnerTokens: [tokenOf(1, { label: "맥북" })] });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    const runner = await detail();
    // 경고 줄은 걷었다(2026-11-10 문구 걷기)
    expect(within(runner).queryByRole("note")).toBeNull();
    await within(runner).findByRole("region", { name: "러너 토큰" });
    const order = [...runner.querySelectorAll("h2, details[aria-label='설치 안내']")].map(
      (el) => el.getAttribute("aria-label") ?? el.textContent,
    );
    expect(order).toEqual(["프로젝트 0", "설치 안내", "러너 토큰"]);
    // 붙은 적이 없는 러너 — 설치 안내가 펼친 채
    expect(within(runner).getByRole("group", { name: "설치 안내" })).toHaveAttribute("open");
  });

  it("토큰을 폐기하면 초점이 상세 머리로 간다 — body 로 떨어지지 않는다", async () => {
    stubSetupServer({
      status: statusOf({ runners: { list: [connectionOf(1, { label: "맥북" })] } }),
      runnerTokens: [tokenOf(1, { label: "맥북", prefix: "mac123", connected: true })],
    });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    const runner = await detail();
    const row = await within(runner).findByRole("listitem", { name: "맥북" });
    await userEvent.click(within(row).getByRole("button", { name: "맥북 폐기" }));
    const confirm = await screen.findByRole("dialog");
    await userEvent.click(within(confirm).getByRole("button", { name: "폐기" }));
    expect(await within(row).findByText("폐기됨")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(runner).getByRole("heading", { level: 1, name: "맥북" })).toHaveFocus(),
    );
  });

  it.each([
    ["지금 붙어 있으면", { connected: true, lastUsedAt: null }],
    ["한 번이라도 붙었으면", { connected: false, lastUsedAt: "2026-09-26T00:00:00.000Z" }],
  ])("install steps are collapsed once the runner has connected — %s", async (_name, over) => {
    stubSetupServer({
      status: statusOf({ runners: { list: over.connected ? [connectionOf(1, { label: "맥북" })] : [] } }),
      runnerTokens: [tokenOf(1, { label: "맥북", lastUsedAt: over.lastUsedAt })],
    });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    const runner = await detail();
    await within(runner).findByRole("region", { name: "러너 토큰" });
    expect(within(runner).getByRole("group", { name: "설치 안내" })).not.toHaveAttribute("open");
  });

  it("unknown runner id shows not found", async () => {
    stubSetupServer({ runnerTokens: [tokenOf(1, { label: "맥북" })] });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(9)));
    expect(await screen.findByText("이 연결을 찾을 수 없습니다")).toBeInTheDocument();
  });
});

describe("member", () => {
  it("member sees only header, warning and agents and no runner API call", async () => {
    const coder = makeAgent({
      provider: "runner",
      providerAgentId: "r-coder",
      handle: "coder",
      name: "Coder",
      runner: { tokenId: runnerId(1), label: "맥북", revoked: false },
    });
    const server = stubRunners({}, async (input) =>
      String(input) === "/api/v1/agents" ? json(200, { agents: [coder] }) : json(404, {}),
    );
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    renderRunnersPage("member", undefined, runnerPath());
    const runner = await detail();
    expect(within(runner).getByRole("heading", { level: 1, name: "맥북" })).toBeInTheDocument();
    expect(within(runner).getByRole("region", { name: "에이전트 1" })).toBeInTheDocument();
    expect(within(runner).queryByRole("region", { name: /^프로젝트/ })).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it("member 가 모르는 러너면 「이 연결을 찾을 수 없습니다」", async () => {
    const server = stubRunners({}, async () => json(200, { agents: [] }));
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    renderRunnersPage("member", undefined, runnerPath());
    expect(await screen.findByText("이 연결을 찾을 수 없습니다")).toBeInTheDocument();
  });
});

describe("연결의 주인(2단계)", () => {
  const ME_ID = "0190a000-0000-7000-8000-0000000000d1";
  const OTHER = "0190a000-0000-7000-8000-0000000000d2";
  const MEMBER = { ...OWNER, user: { ...OWNER.user, id: ME_ID }, role: "member" };
  const runnerList = (owner: { id: string; name: string }): ConnectionsResponse => ({
    gateways: [],
    runners: [{ id: tokenId(1), label: "맥북", connected: false, revoked: false, owner }],
    projects: [],
  });

  it("member owning the runner manages it — 프로젝트·설치 안내·러너 토큰, 메타에 주인", async () => {
    stubSetupServer({
      me: MEMBER,
      runnerTokens: [tokenOf(1, { label: "맥북", ownerUserId: ME_ID })],
      connections: runnerList({ id: ME_ID, name: "나" }),
    });
    renderConnection(MEMBER, undefined, runnerDetailPath(tokenId(1)));
    const runner = await detail();
    await within(runner).findByRole("region", { name: "러너 토큰" });
    const order = [...runner.querySelectorAll("h2, details[aria-label='설치 안내']")].map(
      (el) => el.getAttribute("aria-label") ?? el.textContent,
    );
    expect(order).toEqual(["프로젝트 0", "설치 안내", "러너 토큰"]);
    expect(runner).toHaveTextContent("주인 나");
  });

  it("member opening another's runner sees no install steps or token — 그 요청도 없다", async () => {
    const server = stubSetupServer({
      me: MEMBER,
      runnerTokens: [tokenOf(1, { label: "맥북", ownerUserId: OTHER })],
      connections: runnerList({ id: OTHER, name: "mia" }),
    });
    renderConnection(MEMBER, undefined, runnerDetailPath(tokenId(1)));
    const runner = await detail();
    expect(within(runner).getByRole("heading", { level: 1, name: "맥북" })).toBeInTheDocument();
    expect(runner).toHaveTextContent("주인 mia");
    expect(within(runner).queryByRole("group", { name: "설치 안내" })).toBeNull();
    expect(within(runner).queryByRole("region", { name: "러너 토큰" })).toBeNull();
    expect(within(runner).queryByRole("region", { name: /^프로젝트/ })).toBeNull();
    expect(server.calls.filter((c) => /runner-tokens|\/runners|setup\/status/.test(c.url))).toEqual([]);
  });

  it("project detail opens for the runner's owner — member 라도", async () => {
    const server = stubRunners(
      {
        runners: [runnerOf(1, { label: "맥북" })],
        projects: [projectOf(1, { label: "dodok", relPath: "dodok" })],
      },
      async (input) =>
        String(input) === "/api/v1/connections"
          ? json(200, {
              gateways: [],
              runners: [
                {
                  id: runnerId(1),
                  label: "맥북",
                  connected: true,
                  revoked: false,
                  owner: { id: ME_ID, name: "나" },
                },
              ],
              projects: [{ id: projectOf(1).id, runnerId: runnerId(1), label: "dodok", archived: false }],
            })
          : json(200, { agents: [] }),
    );
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    renderRunnersPage("member", undefined, projectPath(projectOf(1).id), ME_ID);
    const project = await screen.findByTestId("project-detail");
    expect(within(project).getByRole("heading", { level: 1, name: "dodok" })).toBeInTheDocument();
    expect(within(project).getByRole("button", { name: "에이전트 만들기" })).toBeEnabled();
  });
});

describe("프로젝트 상세", () => {
  it("project detail is admin only", async () => {
    const server = stubRunners({ projects: [projectOf(1, { label: "dodok" })] }, async () =>
      json(200, { agents: [] }),
    );
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    renderRunnersPage("member", undefined, projectPath(projectOf(1).id));
    expect(await screen.findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(server.calls).toEqual([]);
  });

  it("admin 은 머리·자리·줄의 동작·「에이전트 만들기」 — 러너 이름은 그 러너 상세 링크", async () => {
    const server = stubRunners(
      {
        runners: [runnerOf(1, { label: "맥북" })],
        projects: [projectOf(1, { label: "dodok", relPath: "dodok" })],
      },
      async () => json(200, { agents: [] }),
    );
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    renderRunnersPage("admin", undefined, projectPath(projectOf(1).id));
    const project = await screen.findByTestId("project-detail");
    expect(within(project).getByRole("heading", { level: 1, name: "dodok" })).toBeInTheDocument();
    expect(within(project).getByRole("link", { name: "맥북" })).toHaveAttribute("href", runnerPath());
    expect(project).toHaveTextContent("내 저장소들/dodok");
    expect(within(project).getByRole("button", { name: /^dodok \(.+\) 보관$/ })).toBeInTheDocument();
    expect(within(project).getByRole("button", { name: "에이전트 만들기" })).toBeEnabled();
  });

  it("archiving a project returns to the runner detail", async () => {
    const server = stubRunners(
      { runners: [runnerOf(1, { label: "맥북" })], projects: [projectOf(1, { label: "dodok" })] },
      // admin 은 러너 상세에서 설치 안내·토큰도 부른다 — 이 시험이 주지 않는 경로는 404
      async (input) =>
        String(input) === "/api/v1/agents"
          ? json(200, { agents: [] })
          : json(404, { code: "NOT_FOUND", message: "x" }),
    );
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    const { router } = renderRunnersPage("admin", undefined, projectPath(projectOf(1).id));
    const project = await screen.findByTestId("project-detail");
    await userEvent.click(within(project).getByRole("button", { name: /^dodok \(.+\) 보관$/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "보관" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(runnerPath()));
    expect(
      await within(await detail()).findByRole("heading", { level: 1, name: "맥북" }),
    ).toBeInTheDocument();
  });

  it("러너 목록을 못 받으면 「불러오는 중…」에 멈추지 않고 다시 시도를 보인다", async () => {
    const server = stubRunners({ projects: [projectOf(1, { label: "dodok" })] }, async () =>
      json(200, { agents: [] }),
    );
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        fail && String(input) === "/api/v1/runners" && (init?.method ?? "GET") === "GET"
          ? json(500, { code: "INTERNAL", message: "boom" })
          : server.fetch(input, init),
      ),
    );
    renderRunnersPage("admin", undefined, projectPath(projectOf(1).id));
    // 사이드바 채널 목록에도 같은 단추가 있다 — 상세 칸의 것은 「불러오지 못했습니다」 곁에 있다
    const notice = await screen.findByText("불러오지 못했습니다");
    const retry = within(notice.parentElement!).getByRole("button", { name: "다시 시도" });
    fail = false;
    await userEvent.click(retry);
    expect(await screen.findByTestId("project-detail")).toBeInTheDocument();
  });

  it("없는 프로젝트 id 면 「이 프로젝트를 찾을 수 없습니다」", async () => {
    const server = stubRunners({ projects: [] }, async () => json(200, { agents: [] }));
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    renderRunnersPage("admin", undefined, projectPath(projectOf(9).id));
    expect(await screen.findByText("이 프로젝트를 찾을 수 없습니다")).toBeInTheDocument();
  });
});
