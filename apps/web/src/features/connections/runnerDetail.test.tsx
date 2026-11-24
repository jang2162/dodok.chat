import type { ConnectionsResponse, RunnerSummary } from "@dodok/shared";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
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
/** 카드 제목(h2)의 차례 — 개수는 제목 옆 따로 */
const cardOrder = (root: HTMLElement) => [...root.querySelectorAll("h2")].map((el) => el.textContent);
/** 「⋯」 메뉴 — 초점을 준 뒤 Enter 로 연다(sidebar.test 의 까닭 — jsdom 의 window blur 가 Radix 메뉴를 닫는다) */
async function openMenu(root: HTMLElement, label: string | RegExp) {
  within(root).getByRole("button", { name: label }).focus();
  await userEvent.keyboard("{Enter}");
  return screen.findByRole("menu");
}

describe("owner", () => {
  it("owner sees projects, install steps and its token — 섹션 차례대로", async () => {
    stubSetupServer({ runnerTokens: [tokenOf(1, { label: "맥북" })] });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    const runner = await detail();
    // 경고 줄은 걷었다(2026-11-10 문구 걷기)
    expect(within(runner).queryByRole("note")).toBeNull();
    await within(runner).findByRole("region", { name: "러너 토큰" });
    await within(runner).findByRole("region", { name: "설치 안내" });
    expect(cardOrder(runner)).toEqual(["에이전트 프로그램", "프로젝트", "봇", "설치 안내", "러너 토큰"]);
    // 붙은 적이 없는 러너 — 설치 안내가 카드로 펼쳐 있고 「⋯」 메뉴에는 없다
    expect(within(runner).getByRole("region", { name: "설치 안내" })).toBeVisible();
    expect(within(runner).queryByRole("button", { name: "맥북 더 보기" })).toBeNull();
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
    // 설치를 마친 러너 — 설치 안내는 「⋯」 메뉴로 옮겨 가고, 고르면 대화상자로 연다
    expect(within(runner).queryByRole("region", { name: "설치 안내" })).toBeNull();
    const menu = await openMenu(runner, "맥북 더 보기");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["설치 안내"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "설치 안내" }));
    expect(await screen.findByRole("dialog", { name: "설치 안내" })).toBeInTheDocument();
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
    expect(within(runner).getByRole("region", { name: "에이전트" })).toHaveTextContent("에이전트1");
    expect(within(runner).queryByRole("region", { name: /^프로젝트/ })).toBeNull();
    // 관리할 수 없으면 「⋯」 메뉴도, 프로그램 카드도 없다
    expect(within(runner).queryByRole("button", { name: /더 보기/ })).toBeNull();
    expect(within(runner).queryByRole("region", { name: "에이전트 프로그램" })).toBeNull();
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
    await within(runner).findByRole("region", { name: "설치 안내" });
    expect(cardOrder(runner)).toEqual(["에이전트 프로그램", "프로젝트", "봇", "설치 안내", "러너 토큰"]);
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
    expect(within(runner).queryByRole("region", { name: "설치 안내" })).toBeNull();
    expect(within(runner).queryByRole("button", { name: /더 보기/ })).toBeNull();
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
              projects: [
                {
                  id: projectOf(1).id,
                  runnerId: runnerId(1),
                  label: "dodok",
                  archived: false,
                  parentProjectId: null,
                },
              ],
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
    // 줄의 동작은 「워크트리 만들기」와 「⋯」 메뉴(확인·이름 바꾸기·옮기기·보관)
    const menu = await openMenu(project, /^dodok \(.+\) 더 보기$/);
    expect(within(menu).getByRole("menuitem", { name: "보관" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
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
    const menu = await openMenu(project, /^dodok \(.+\) 더 보기$/);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "보관" }));
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

describe("러너 상세의 「봇」 묶음(러너 봇 스펙 B11)", () => {
  it("봇은 「봇 N」에, 「프로젝트 밖 에이전트」는 옛 것만 — 봇을 옛 것으로 읽지 않는다 [Review Focus 2]", async () => {
    const runner = { tokenId: runnerId(1), label: "맥북", revoked: false };
    const rev = makeAgent({
      provider: "runner",
      providerAgentId: "r-0123456789",
      handle: "rev",
      name: "리뷰 봇",
      runner: { ...runner, bot: true },
      runnerAgent: { projectId: null, disallowedTools: [] },
    });
    const legacy = makeAgent({
      provider: "runner",
      providerAgentId: "r-aaaaaaaaaa",
      handle: "old",
      name: "옛 에이전트",
      runner,
      runnerAgent: { projectId: null, disallowedTools: [] },
    });
    const server = stubRunners({ runners: [runnerOf(1, { label: "맥북" })] }, async (input) =>
      String(input) === "/api/v1/agents" ? json(200, { agents: [rev, legacy] }) : json(404, {}),
    );
    vi.stubGlobal("fetch", vi.fn(server.fetch));
    renderRunnersPage("admin");
    const detail = await screen.findByTestId("runner-detail");
    const bots = await within(detail).findByRole("region", { name: "봇" });
    expect(bots).toHaveTextContent("봇1");
    expect(within(bots).getByRole("link", { name: /리뷰 봇/ })).toBeInTheDocument();
    expect(bots).not.toHaveTextContent("옛 에이전트");
    const unbound = within(detail).getByRole("region", { name: "프로젝트 밖 에이전트" });
    expect(unbound).toHaveTextContent("옛 에이전트");
    expect(unbound).not.toHaveTextContent("리뷰 봇");
    expect(within(detail).getByRole("button", { name: "봇 만들기" })).toBeEnabled();
  });
});

describe("원격 업데이트(원격 업데이트 스펙 U8·U9)", () => {
  const PAST = "2026-11-23T00:00:00.000Z";
  const FUTURE = "2999-01-01T00:00:00.000Z";
  function stubRunner(over: Partial<RunnerSummary>, extra: Parameters<typeof stubSetupServer>[0] = {}) {
    return stubSetupServer({
      status: statusOf({ runners: { list: [connectionOf(1, { label: "맥북" })] } }),
      runnerTokens: [tokenOf(1, { label: "맥북", connected: true })],
      runnerSummary: (s) => ({
        ...s,
        runnerVersion: "0.8.0",
        latestVersion: "0.9.0",
        remoteUpdate: "on",
        update: null,
        ...over,
      }),
      ...extra,
    });
  }
  const group = async () => within(await detail()).findByRole("group", { name: "러너 업데이트" });
  /** 머리 오른쪽의 「러너 업데이트」(연결 재설계 스펙 목표 2) — 상태 줄(group)은 머리 아래 */
  const headButton = async () => within(await detail()).queryByRole("button", { name: "러너 업데이트" });

  it("판 · 최신과 업데이트 — 확인하면 POST 하고 「업데이트 중…」", async () => {
    let update: RunnerSummary["update"] = null;
    const server = stubSetupServer({
      status: statusOf({ runners: { list: [connectionOf(1, { label: "맥북" })] } }),
      runnerTokens: [tokenOf(1, { label: "맥북", connected: true })],
      runnerSummary: (s) => ({
        ...s,
        runnerVersion: "0.8.0",
        latestVersion: "0.9.0",
        remoteUpdate: "on",
        update,
      }),
      runnerUpdate: () => {
        update = { state: "updating", targetVersion: "0.9.0", startedAt: PAST, deadline: FUTURE };
        return json(202, { update });
      },
    });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    const box = await group();
    expect(box).toHaveTextContent("판 0.8.0 · 최신 0.9.0");
    await userEvent.click((await headButton())!);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("러너를 0.9.0 로 업데이트할까요?");
    await userEvent.click(within(dialog).getByRole("button", { name: "업데이트" }));
    expect(await within(box).findByText("업데이트 중…")).toBeInTheDocument();
    expect(server.count("POST", `/api/v1/runners/${tokenId(1)}/update`)).toBe(1);
    expect(await headButton()).toBeDisabled();
  });

  // Review Focus 5
  it("최신을 알 수 없으면(레지스트리에 닿지 않음) 단추가 없다", async () => {
    stubRunner({ latestVersion: null });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    const box = await group();
    expect(box).toHaveTextContent("판 0.8.0 · 최신 알 수 없음");
    expect(box).toHaveTextContent("최신 판을 알 수 없습니다");
    expect(await headButton()).toBeNull();
  });

  it("끈 머신은 안내만, 옛 판은 명령 한 줄, 이미 최신이면 단추가 없다", async () => {
    stubRunner({ remoteUpdate: "off" });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    expect(await group()).toHaveTextContent("이 머신에서 원격 업데이트를 껐습니다");
    expect(await headButton()).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    stubRunner({ remoteUpdate: "unsupported" });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    const box = await group();
    expect(box).toHaveTextContent("이 러너 판은 원격 업데이트를 지원하지 않습니다");
    expect(box).toHaveTextContent("npm i -g @dodok/runner@latest");
    cleanup();
    vi.unstubAllGlobals();
    stubRunner({ runnerVersion: "0.9.0" });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    expect(await group()).toHaveTextContent("판 0.9.0 · 최신 0.9.0");
    expect(await headButton()).toBeNull();
  });

  it("서버가 409 로 거절하면 대화상자에 그 문구(런 중)", async () => {
    stubRunner(
      {},
      {
        runnerUpdate: () =>
          json(409, {
            code: "CONFLICT",
            message: "런이 끝난 뒤 다시 시도하세요",
            details: { reason: "busy" },
          }),
      },
    );
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    await group();
    await userEvent.click((await headButton())!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "업데이트" }));
    expect(await within(dialog).findByText("런이 끝난 뒤 다시 시도하세요")).toBeInTheDocument();
  });

  it("실패면 사유 한 줄, 상한이 지났으면 「응답이 없습니다 — 그 머신에서 확인하세요」", async () => {
    stubRunner({ update: { state: "failed", message: "npm 설치에 실패했습니다(E404)", at: PAST } });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    expect(await within(await group()).findByRole("alert")).toHaveTextContent(
      "npm 설치에 실패했습니다(E404)",
    );
    cleanup();
    vi.unstubAllGlobals();
    stubRunner({ update: { state: "updating", targetVersion: "0.9.0", startedAt: PAST, deadline: PAST } });
    renderConnection(OWNER, undefined, runnerDetailPath(tokenId(1)));
    expect(await within(await group()).findByRole("alert")).toHaveTextContent(
      "응답이 없습니다 — 그 머신에서 확인하세요",
    );
  });
});

describe("업데이트 대기(러너 봇 2부 스펙 T16)", () => {
  it("대기가 있으면 「업데이트 대기 — 런이 끝나면 올립니다」와 「취소」 — 누르면 DELETE /runners/:id/update-queue", async () => {
    let queued = true;
    const calls: string[] = [];
    const routes = stubRunners({ runners: [runnerOf(1, { label: "맥북" })] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "DELETE" && url === `/api/v1/runners/${runnerId(1)}/update-queue`) {
          calls.push(`${method} ${url}`);
          queued = false;
          return new Response(null, { status: 204 });
        }
        if (method === "GET" && url === "/api/v1/runners")
          return json(200, {
            runners: [
              runnerOf(1, {
                label: "맥북",
                updateQueued: queued ? { requestedAt: "2026-11-23T00:00:00.000Z" } : null,
              }),
            ],
          });
        return routes.fetch(input, init);
      }),
    );
    renderRunnersPage("admin", undefined, runnerPath());
    const runner = await detail();
    const box = await within(runner).findByTestId("update-queued");
    expect(box).toHaveTextContent("업데이트 대기 — 런이 끝나면 올립니다");
    await userEvent.click(within(box).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(calls).toEqual([`DELETE /api/v1/runners/${runnerId(1)}/update-queue`]));
    await waitFor(() => expect(within(runner).queryByTestId("update-queued")).toBeNull());
  });

  it("대기가 없으면 아무것도 없다", async () => {
    vi.stubGlobal("fetch", vi.fn(stubRunners({ runners: [runnerOf(1, { label: "맥북" })] }).fetch));
    renderRunnersPage("admin", undefined, runnerPath());
    const runner = await detail();
    await within(runner).findByRole("heading", { name: /^프로젝트/ });
    expect(within(runner).queryByTestId("update-queued")).toBeNull();
  });
});
