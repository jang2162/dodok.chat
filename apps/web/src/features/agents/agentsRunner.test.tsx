import {
  type Agent,
  BOT_TEMPLATES,
  type RunnerCapability,
  type RunnerPermissionMode,
  type SessionDefaults,
} from "@dodok/shared";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/app/queryClient";
import { NO_APPROVAL_HINT, NO_PROJECT_RESTORE, PERMISSION_MODE_LABEL } from "@/features/runners/copy";
import {
  ARCHIVED_AT,
  agentDetail,
  agentPath,
  makeAgent,
  renderPage as renderAt,
  stubServer as serve,
} from "../../../test/agentsPage";
import {
  json,
  programOf,
  projectOf,
  projectPath,
  renderRunnersPage,
  runnerOf,
  runnerPath,
  runnersRoutes,
} from "../../../test/runnersServer";
import { ABOVE_CEILING, CEILING_REFUSED } from "./RunnerAgentForm";

/** 시험마다 첫 에이전트의 상세를 띄운다 — 러너 에이전트 줄은 「연결」 탭의 에이전트 상세가 그린다 */
let shown: Agent | undefined;
const stubServer = (opts: NonNullable<Parameters<typeof serve>[0]>) => {
  shown = opts.agents?.[0];
  return serve(opts);
};
const renderPage = (qc = createQueryClient(() => {}), role = "owner") =>
  renderAt(qc, role, shown ? agentPath(shown) : undefined);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 러너-1(맥북)의 dodok 프로젝트에서 도는 러너 에이전트 — admin 이상이면 정의(`runnerAgent`)가 실린다 */
function coder(
  over: Partial<NonNullable<Agent["runnerAgent"]>> = {},
  withDefinition = true,
  defaults: Partial<SessionDefaults> = {},
): Agent {
  const runner = runnerOf(1);
  return makeAgent({
    sessionDefaults: { model: null, effort: null, permissionMode: null, ...defaults },
    provider: "runner",
    providerAgentId: "r-0123456789",
    handle: "coder",
    name: "코더",
    program: "claude",
    runner: { tokenId: runner.id, label: "맥북", revoked: false },
    ...(withDefinition
      ? {
          runnerAgent: {
            projectId: projectOf(1).id,
            disallowedTools: [],
            ...over,
          },
        }
      : {}),
  });
}

/** 맥북 — 상한(maxPermissionMode)을 바꿔 가며 */
const routes = (max: RunnerPermissionMode = "acceptEdits", connected = true) =>
  runnersRoutes({
    runners: [
      runnerOf(1, {
        label: "맥북",
        connected,
        ...(connected
          ? { programs: [programOf({ ceiling: { maxPermissionMode: max, allowedToolsCeiling: null } })] }
          : {}),
      }),
    ],
    projects: [projectOf(1, { label: "dodok", relPath: "dodok" })],
  }).handle;

async function openEdit() {
  const row = await agentDetail();
  await userEvent.click(within(row).getByRole("button", { name: "@coder 시작값 고치기" }));
  return row;
}

const modeOptions = (row: HTMLElement) =>
  within(within(row).getByRole("combobox", { name: "권한 모드" }))
    .getAllByRole("option")
    .map((o) => ({ value: (o as HTMLOptionElement).value, disabled: (o as HTMLOptionElement).disabled }));

describe("러너 에이전트 줄 — 새 세션 시작값 [세션 설정 스펙 S10]", () => {
  it("고칠 수 있는 사람은 시작값 요약과 「시작값 고치기」 — 「기본」은 「기본」, 모델·권한·허용 도구 정의 요약은 없다", async () => {
    stubServer({ agents: [coder({}, true, { model: "sonnet", effort: "high" })], runners: routes() });
    renderPage(
      createQueryClient(() => {}),
      "admin",
    );
    const row = await agentDetail();
    expect(row).toHaveTextContent("새 세션 시작값 · 모델 sonnet · 노력 높음 · 권한 기본");
    expect(row).not.toHaveTextContent("허용 도구");
    expect(within(row).getByRole("button", { name: "@coder 시작값 고치기" })).toBeInTheDocument();
  });

  it("고칠 수 없는 사람(member) — 프로그램·러너 줄만, 시작값 고치기 없음", async () => {
    stubServer({ agents: [coder({}, false)] });
    renderPage(
      createQueryClient(() => {}),
      "member",
    );
    const row = await agentDetail();
    expect(row).toHaveTextContent("Claude Code · 러너 맥북");
    expect(row).not.toHaveTextContent("새 세션 시작값");
    expect(within(row).queryByRole("button", { name: /시작값 고치기/ })).toBeNull();
  });
});

describe("러너 에이전트의 지시(basePrompt) — 만들 때와 같은 「지시」", () => {
  it("줄의 칸 이름은 「지시」 — 편집 버튼·빈 값·편집 칸, 「전달되지 않음」 안내는 없다", async () => {
    const server = stubServer({
      agents: [makeAgent({ ...coder(), basePrompt: undefined })],
      runners: routes(),
    });
    renderPage(
      createQueryClient(() => {}),
      "admin",
    );
    const row = await agentDetail();
    expect(within(row).getByText("지시 없음")).toBeInTheDocument();
    expect(row).not.toHaveTextContent("전달되지 않음");
    expect(row).not.toHaveTextContent("메모");
    await userEvent.click(within(row).getByRole("button", { name: "@coder 지시 편집" }));
    const box = within(row).getByRole("textbox", { name: "@coder 지시" });
    expect(within(row).getByText("지시", { selector: "label" })).toBeInTheDocument();
    expect(box).not.toHaveAccessibleDescription(expect.stringContaining("전달되지 않음"));
    await userEvent.type(box, "테스트부터");
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(server.bodies("PATCH")).toEqual([{ basePrompt: "테스트부터" }]));
    expect(row).not.toHaveTextContent("기본 프롬프트");
  });
});

describe("새 세션 시작값 고치기", () => {
  it("프로그램·프로젝트는 읽기만, 권한 모드는 「기본」+여섯 — 상한(default) 위는 막고 사유 한 줄", async () => {
    stubServer({ agents: [coder()], runners: routes("default") });
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(row).toHaveTextContent("프로젝트dodok · 내 저장소들/dodok"));
    expect(row).toHaveTextContent("프로그램Claude Code");
    expect(within(row).queryByRole("radio", { name: /Claude Code/ })).toBeNull();
    await waitFor(() =>
      expect(modeOptions(row)).toEqual([
        { value: "", disabled: false },
        { value: "plan", disabled: false },
        { value: "dontAsk", disabled: false },
        { value: "default", disabled: false },
        { value: "acceptEdits", disabled: true },
        { value: "auto", disabled: true },
        { value: "bypassPermissions", disabled: true },
      ]),
    );
    expect(within(row).getByRole("combobox", { name: "권한 모드" })).toHaveAccessibleDescription(
      ABOVE_CEILING("default"),
    );
  });

  it("상한(bypassPermissions)이 열린 러너 — auto·bypassPermissions 를 고르고 「승인 카드 없이 실행됩니다」 안내가 칸에 붙는다", async () => {
    const server = stubServer({ agents: [coder()], runners: routes("bypassPermissions") });
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(modeOptions(row).every((o) => !o.disabled)).toBe(true));
    const select = within(row).getByRole("combobox", { name: "권한 모드" });
    expect(within(row).getByRole("option", { name: PERMISSION_MODE_LABEL.auto })).toHaveValue("auto");
    expect(select).not.toHaveAccessibleDescription(expect.stringContaining(NO_APPROVAL_HINT));
    for (const mode of ["auto", "bypassPermissions"] as const) {
      await userEvent.selectOptions(select, mode);
      expect(select).toHaveAccessibleDescription(expect.stringContaining(NO_APPROVAL_HINT));
    }
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(server.bodies("PATCH")).toEqual([{ sessionDefaults: { permissionMode: "bypassPermissions" } }]),
    );
  });

  it("셋을 고쳐 저장하면 PATCH 본문은 { sessionDefaults } — 바뀐 칸만, 프로그램·프로젝트는 싣지 않는다", async () => {
    const server = stubServer({ agents: [coder({}, true, { effort: "low" })], runners: routes() });
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(modeOptions(row)).toHaveLength(7));
    await userEvent.type(within(row).getByLabelText("모델"), "opus");
    // 선택지는 한글 이름, 값은 영문 그대로
    expect(within(row).getByRole("option", { name: "최대" })).toHaveValue("max");
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "노력치" }), "max");
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "권한 모드" }), "acceptEdits");
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(server.bodies("PATCH")).toEqual([
        { sessionDefaults: { model: "opus", effort: "max", permissionMode: "acceptEdits" } },
      ]),
    );
  });

  it("「기본」으로 되돌리면 null 로 싣는다 — 바꾸지 않은 칸은 빠진다", async () => {
    const server = stubServer({
      agents: [coder({}, true, { model: "sonnet", permissionMode: "plan" })],
      runners: routes(),
    });
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(modeOptions(row)).toHaveLength(7));
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "권한 모드" }), "");
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(server.bodies("PATCH")).toEqual([{ sessionDefaults: { permissionMode: null } }]),
    );
  });

  it("러너가 끊겨 있으면 상한을 모른다 — 여섯 다 고를 수 있다", async () => {
    stubServer({ agents: [coder()], runners: routes("default", false) });
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(modeOptions(row).every((o) => !o.disabled)).toBe(true));
    expect(modeOptions(row)).toHaveLength(7);
  });

  it("서버가 천장으로 거절하면 권한 칸 아래 고정 문구", async () => {
    stubServer({ agents: [coder()], runners: routes("default", false) });
    const fetchFn = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (input, init) =>
        init?.method === "PATCH"
          ? new Response(
              JSON.stringify({
                code: "VALIDATION",
                message: "러너 설정이 이 에이전트를 허용하지 않습니다(permissionMode)",
                details: { field: "permissionMode" },
              }),
              { status: 400 },
            )
          : fetchFn(input, init),
      ),
    );
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(modeOptions(row)).toHaveLength(7));
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "권한 모드" }), "acceptEdits");
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(within(row).getByRole("combobox", { name: "권한 모드" })).toHaveAccessibleDescription(
        CEILING_REFUSED,
      ),
    );
  });
});

describe("보관한 러너 에이전트", () => {
  it("프로젝트가 없는 것(0031 이 보관)은 「되살리기」 대신 「프로젝트가 없어 되살릴 수 없습니다 — 새로 만드세요」", async () => {
    const orphan: Agent = { ...coder({ projectId: null }), archivedAt: ARCHIVED_AT };
    const kept: Agent = {
      ...coder(),
      id: "0190a000-0000-7000-8000-0000000009ff",
      handle: "kept",
      archivedAt: ARCHIVED_AT,
    };
    stubServer({ agents: [orphan, kept] });
    renderPage();
    const orphanRow = await agentDetail();
    expect(orphanRow).toHaveTextContent(NO_PROJECT_RESTORE);
    expect(within(orphanRow).queryByRole("button", { name: /되살리기/ })).toBeNull();
    cleanup();
    stubServer({ agents: [kept] });
    renderPage();
    const keptRow = await agentDetail();
    expect(within(keptRow).getByRole("button", { name: "@kept 되살리기" })).toBeInTheDocument();
  });
});

describe("에이전트 만들기 — 「새 워크트리」 지름길 [워크트리 스펙 5.5]", () => {
  type Hit = { method: string; url: string; body: unknown };
  /** 프로젝트 상세(dodok, git)를 띄운다 — POST /agents 는 agentStatus 로, 워크트리 만들기는 201 과 새 프로젝트 */
  function serveProject(opts: { isGit?: boolean; agentStatus?: number } = {}) {
    const hits: Hit[] = [];
    const routes = runnersRoutes({
      runners: [runnerOf(1, { label: "맥북" })],
      projects: [projectOf(1, { label: "dodok", relPath: "dodok", isGit: opts.isGit ?? true })],
    });
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (method === "POST" && url.endsWith("/worktrees")) {
        hits.push({ method, url, body });
        const b = body as { label: string; branch: string; location: { rootId: string; relPath: string } };
        const project = projectOf(77, {
          label: b.label,
          relPath: b.location.relPath,
          parentProjectId: projectOf(1).id,
          branch: b.branch,
        });
        routes.projects.push(project);
        return json(201, { project });
      }
      if (method === "POST" && url === "/api/v1/agents") {
        hits.push({ method, url, body });
        const status = opts.agentStatus ?? 201;
        return status === 201
          ? json(201, {
              agent: makeAgent({
                provider: "runner",
                providerAgentId: "r-wt",
                handle: "wt-coder",
                name: "wt-coder",
              }),
            })
          : json(status, { code: "INTERNAL", message: "boom" });
      }
      const hit = routes.handle(method, url, body);
      if (hit) return hit;
      if (url === "/api/v1/agents") return json(200, { agents: [] });
      return json(404, { code: "NOT_FOUND", message: "x" });
    };
    vi.stubGlobal("fetch", vi.fn(fetch));
    return { hits, routes };
  }
  async function openForm() {
    renderRunnersPage("admin", undefined, projectPath(projectOf(1).id));
    const project = await screen.findByTestId("project-detail");
    await userEvent.click(within(project).getByRole("button", { name: "에이전트 만들기" }));
    return screen.findByRole("dialog", { name: "러너 에이전트 만들기" });
  }

  it("new worktree option creates worktree then agent", async () => {
    const { hits } = serveProject();
    const dialog = await openForm();
    const where = within(dialog).getByRole("radiogroup", { name: "작업 위치" });
    expect(within(where).getByRole("radio", { name: "이 프로젝트" })).toBeChecked();
    await userEvent.click(within(where).getByRole("radio", { name: "새 워크트리" }));
    await userEvent.type(within(dialog).getByLabelText("워크트리 이름"), "feat");
    expect(within(dialog).getByLabelText("브랜치")).toHaveValue("dodok/feat");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "핸들" }), "wt-coder");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(hits.map((h) => h.url)).toEqual([
      `/api/v1/runner-projects/${projectOf(1).id}/worktrees`,
      "/api/v1/agents",
    ]);
    expect(hits[0]?.body).toEqual({
      label: "feat",
      branch: "dodok/feat",
      location: { rootId: "src", relPath: "dodok/.worktrees/feat" },
    });
    expect(hits[1]?.body).toMatchObject({ runnerProjectId: projectOf(77).id, handle: "wt-coder" });
  });

  it("agent failure keeps worktree and shows reason — 다시 누르면 워크트리를 또 만들지 않는다", async () => {
    const { hits, routes } = serveProject({ agentStatus: 500 });
    const dialog = await openForm();
    await userEvent.click(within(dialog).getByRole("radio", { name: "새 워크트리" }));
    await userEvent.type(within(dialog).getByLabelText("워크트리 이름"), "feat");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "핸들" }), "wt-coder");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    expect(await within(dialog).findByText(/워크트리는 만들었습니다/)).toBeInTheDocument();
    expect(routes.projects.some((p) => p.id === projectOf(77).id)).toBe(true);
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(hits.filter((h) => h.url === "/api/v1/agents")).toHaveLength(2));
    expect(hits.filter((h) => h.url.endsWith("/worktrees"))).toHaveLength(1);
    expect(hits.at(-1)?.body).toMatchObject({ runnerProjectId: projectOf(77).id });
  });

  it("option hidden for non-git project", async () => {
    serveProject({ isGit: false });
    const dialog = await openForm();
    await within(dialog).findByRole("textbox", { name: "핸들" });
    expect(within(dialog).queryByRole("radiogroup", { name: "작업 위치" })).toBeNull();
  });
});

describe("워크트리의 러너 에이전트 — 경로 줄은 「<부모> · <브랜치>」 [워크트리 스펙 5.5]", () => {
  it("에이전트 상세의 프로젝트 이름이 부모 이름과 브랜치", async () => {
    const wt = projectOf(2, {
      label: "feat",
      relPath: "dodok/.worktrees/feat",
      parentProjectId: projectOf(1).id,
      branch: "dodok/feat",
    });
    stubServer({
      agents: [coder({ projectId: wt.id })],
      runners: runnersRoutes({
        runners: [runnerOf(1, { label: "맥북" })],
        projects: [projectOf(1, { label: "dodok", relPath: "dodok", isGit: true }), wt],
      }).handle,
    });
    renderPage(
      createQueryClient(() => {}),
      "admin",
    );
    // 경로 줄은 상세 머리(DetailHeader meta)에 있다
    await screen.findByTestId("agent-detail");
    expect(await screen.findByRole("link", { name: "dodok · dodok/feat" })).toHaveAttribute(
      "href",
      `/settings/connection/project/${wt.id}`,
    );
  });
});

describe("러너 봇(러너 봇 스펙 B2·B3·B5·B7)", () => {
  type Hit = { method: string; url: string; body: unknown };
  const BOTS_CAPS: RunnerCapability[] = [
    "threads",
    "interrupt",
    "approvals",
    "attachments",
    "worktrees",
    "bots",
  ];
  const DEF = { purpose: "리뷰 봇", watches: "PR", does: "위험을 짚는다", reports: "요약" };

  /** 러너 상세(맥북)·프로젝트(dodok)를 띄운다 — POST /agents 는 받은 본문을 남기고 201 */
  function serveRunner(opts: { bots?: boolean } = {}) {
    const hits: Hit[] = [];
    const routes = runnersRoutes({
      runners: [runnerOf(1, { label: "맥북", ...(opts.bots === false ? {} : { capabilities: BOTS_CAPS }) })],
      projects: [projectOf(1, { label: "dodok", relPath: "dodok" })],
    });
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      if (method === "POST" && url === "/api/v1/agents") {
        hits.push({ method, url, body });
        return json(201, {
          agent: makeAgent({
            provider: "runner",
            providerAgentId: "r-0123456789",
            handle: "rev",
            name: "rev",
          }),
        });
      }
      const hit = routes.handle(method, url, body);
      if (hit) return hit;
      if (url === "/api/v1/agents") return json(200, { agents: [] });
      return json(404, { code: "NOT_FOUND", message: "x" });
    };
    vi.stubGlobal("fetch", vi.fn(fetch));
    return { hits };
  }

  async function openBotDialog() {
    renderRunnersPage("admin", undefined, runnerPath());
    const runner = await screen.findByTestId("runner-detail");
    await userEvent.click(await within(runner).findByRole("button", { name: "봇 만들기" }));
    return screen.findByRole("dialog", { name: "봇 만들기" });
  }

  it("러너 상세의 「봇 만들기」 — 템플릿이 네 칸을 채우고, 본문은 runnerTokenId + bot(프로젝트·지시 없음)", async () => {
    const { hits } = serveRunner();
    const dialog = await openBotDialog();
    expect(within(dialog).queryByRole("textbox", { name: "지시" })).toBeNull();
    const review = BOT_TEMPLATES.find((t) => t.id === "review")!;
    await userEvent.click(within(dialog).getByRole("button", { name: review.label }));
    expect(within(dialog).getByLabelText("목적(한 줄)")).toHaveValue(review.definition.purpose);
    expect(within(dialog).getByLabelText("할 일")).toHaveValue(review.definition.does);
    // 빈 봇 템플릿은 비운다
    await userEvent.click(within(dialog).getByRole("button", { name: "빈 봇" }));
    expect(within(dialog).getByLabelText("지켜볼 것")).toHaveValue("");
    await userEvent.click(within(dialog).getByRole("button", { name: review.label }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: "핸들" }), "rev");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(hits).toHaveLength(1);
    expect(hits[0]?.body).toEqual({
      provider: "runner",
      runnerTokenId: runnerOf(1).id,
      // 도구 칸(러너 봇 2부 스펙 T1·T7) — 비운 채로 만들면 빈 값
      bot: { ...review.definition, mcpServers: {}, mcpAutoAllow: {}, builtinTools: [] },
      program: "claude",
      handle: "rev",
      name: "rev",
      dmAccess: "admins",
    });
  });

  it("칸 상한 — 목적 200, 나머지 2000(maxLength)", async () => {
    serveRunner();
    const dialog = await openBotDialog();
    expect(within(dialog).getByLabelText("목적(한 줄)")).toHaveAttribute("maxLength", "200");
    for (const name of ["지켜볼 것", "할 일", "보고할 것"])
      expect(within(dialog).getByLabelText(name)).toHaveAttribute("maxLength", "2000");
  });

  it("능력 bots 가 없는 러너 — 사유 「러너를 업데이트하세요(봇은 0.9.0 부터)」와 함께 만들기·「봇(폴더만)」을 잠근다", async () => {
    serveRunner({ bots: false });
    const dialog = await openBotDialog();
    expect(dialog).toHaveTextContent("러너를 업데이트하세요(봇은 0.9.0 부터)");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "핸들" }), "rev");
    expect(within(dialog).getByRole("button", { name: "만들기" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    cleanup();
    // 프로젝트 상세에서 연 폼 — 「봇(폴더만)」 선택지가 사유와 함께 잠긴다
    serveRunner({ bots: false });
    renderRunnersPage("admin", undefined, projectPath(projectOf(1).id));
    const project = await screen.findByTestId("project-detail");
    await userEvent.click(within(project).getByRole("button", { name: "에이전트 만들기" }));
    const form = await screen.findByRole("dialog", { name: "러너 에이전트 만들기" });
    const place = within(form).getByRole("radiogroup", { name: "자리" });
    const bot = within(place).getByRole("radio", { name: "봇(폴더만)" });
    expect(bot).toBeDisabled();
    expect(bot).toHaveAccessibleDescription("러너를 업데이트하세요(봇은 0.9.0 부터)");
  });

  it("프로젝트 상세의 폼에서 「봇(폴더만)」을 고르면 지시·프로젝트 대신 네 칸, 본문은 봇 갈래", async () => {
    const { hits } = serveRunner();
    renderRunnersPage("admin", undefined, projectPath(projectOf(1).id));
    const project = await screen.findByTestId("project-detail");
    await userEvent.click(within(project).getByRole("button", { name: "에이전트 만들기" }));
    const form = await screen.findByRole("dialog", { name: "러너 에이전트 만들기" });
    expect(within(form).getByRole("textbox", { name: "지시" })).toBeInTheDocument();
    await userEvent.click(within(form).getByRole("radio", { name: "봇(폴더만)" }));
    expect(within(form).queryByRole("textbox", { name: "지시" })).toBeNull();
    await userEvent.type(within(form).getByLabelText("목적(한 줄)"), "정리 봇");
    await userEvent.type(within(form).getByRole("textbox", { name: "핸들" }), "tidy");
    await userEvent.click(within(form).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(hits).toHaveLength(1));
    expect(hits[0]?.body).toMatchObject({
      runnerTokenId: runnerOf(1).id,
      bot: { purpose: "정리 봇", watches: "", does: "", reports: "" },
    });
    expect(hits[0]?.body).not.toHaveProperty("runnerProjectId");
  });

  /** 맥북의 봇 — admin 이상·주인이면 정의(`runnerAgent.bot`)가 실린다 */
  function bot(withDefinition = true): Agent {
    const base = coder({ projectId: null, bot: DEF }, withDefinition);
    return { ...base, runner: { ...base.runner!, bot: true } };
  }

  it("상세의 「정의 편집」 — 지시 대신 네 칸, 저장하면 PATCH { bot }", async () => {
    const server = stubServer({ agents: [bot()], runners: routes() });
    renderPage(
      createQueryClient(() => {}),
      "admin",
    );
    const row = await agentDetail();
    expect(within(row).queryByRole("button", { name: "@coder 지시 편집" })).toBeNull();
    expect(row).toHaveTextContent("리뷰 봇");
    await userEvent.click(within(row).getByRole("button", { name: "@coder 봇 정의 편집" }));
    const doField = within(row).getByLabelText("할 일");
    await userEvent.clear(doField);
    await userEvent.type(doField, "테스트를 돌린다");
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(server.bodies("PATCH")).toEqual([
        { bot: { ...DEF, does: "테스트를 돌린다", mcpServers: {}, mcpAutoAllow: {}, builtinTools: [] } },
      ]),
    );
  });

  it("member — 봇임은 경로에 보이고(「› 봇」), 정의 편집·정의 내용은 없다 [Review Focus 5]", async () => {
    stubServer({ agents: [bot(false)] });
    renderPage(
      createQueryClient(() => {}),
      "member",
    );
    const row = await agentDetail();
    expect(within(row).queryByRole("button", { name: /봇 정의 편집/ })).toBeNull();
    expect(row).not.toHaveTextContent("리뷰 봇");
    expect(screen.getByText(/› 봇/)).toBeInTheDocument();
  });

  describe("봇 도구(러너 봇 2부 스펙 T1·T3·T4·T7·T15)", () => {
    const TOOL_CAPS: RunnerCapability[] = [...BOTS_CAPS, "botMcp", "runnerControl"];
    const httpCeiling = {
      maxPermissionMode: "acceptEdits" as const,
      allowedToolsCeiling: null as string[] | null,
      appMcp: "http" as const,
      appMcpCommands: null,
    };
    const MCP_JSON = JSON.stringify({
      mcpServers: {
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { Authorization: "Bearer x" },
        },
        linear: { command: "npx", args: ["-y", "linear-mcp"] },
      },
    });
    /** 도구 칸을 보는 러너 상세 — 능력·천장을 바꿔 가며 */
    function serveTools(caps: RunnerCapability[] = TOOL_CAPS, ceiling = httpCeiling) {
      const hits: Hit[] = [];
      const routes = runnersRoutes({
        runners: [runnerOf(1, { label: "맥북", capabilities: caps, programs: [programOf({ ceiling })] })],
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
          if (method === "POST" && url === "/api/v1/agents") {
            hits.push({ method, url, body });
            return json(201, {
              agent: makeAgent({
                provider: "runner",
                providerAgentId: "r-0123456789",
                handle: "rev",
                name: "rev",
              }),
            });
          }
          const hit = routes.handle(method, url, body);
          if (hit) return hit;
          if (url === "/api/v1/agents") return json(200, { agents: [] });
          return json(404, { code: "NOT_FOUND", message: "x" });
        }),
      );
      return { hits };
    }
    const mcpBox = (scope: HTMLElement) =>
      within(scope).getByRole("textbox", { name: "MCP 서버(.mcp.json)" });

    it("붙여 넣은 .mcp.json 의 서버 둘 — http 러너에서 stdio 는 「이 러너가 막음 — 이 러너는 stdio 서버를 받지 않음」, 자동 허용·내장 도구가 본문에", async () => {
      const { hits } = serveTools();
      const dialog = await openBotDialog();
      await userEvent.click(mcpBox(dialog));
      await userEvent.paste(MCP_JSON);
      expect(within(dialog).getByTestId("mcp-verdict-github")).toHaveTextContent("쓸 수 있음");
      expect(within(dialog).getByTestId("mcp-verdict-linear")).toHaveTextContent(
        "이 러너가 막음 — 이 러너는 stdio 서버를 받지 않음",
      );
      const github = within(dialog).getAllByRole("combobox", { name: "묻지 않음" })[0]!;
      await userEvent.selectOptions(github, "tools");
      await userEvent.type(
        within(dialog).getByRole("textbox", { name: "github 묻지 않을 도구(쉼표로)" }),
        "search, get",
      );
      await userEvent.click(within(dialog).getByRole("checkbox", { name: "이 러너 설정 제어" }));
      await userEvent.type(within(dialog).getByRole("textbox", { name: "핸들" }), "rev");
      await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
      await waitFor(() => expect(hits).toHaveLength(1));
      expect((hits[0]!.body as { bot: unknown }).bot).toMatchObject({
        mcpServers: JSON.parse(MCP_JSON).mcpServers,
        mcpAutoAllow: { github: { mode: "tools", tools: ["search", "get"] } },
        builtinTools: ["runnerControl"],
      });
    });

    it("틀린 JSON 이면 사유 한 줄과 함께 만들기를 잠근다", async () => {
      serveTools();
      const dialog = await openBotDialog();
      await userEvent.type(within(dialog).getByRole("textbox", { name: "핸들" }), "rev");
      await userEvent.click(mcpBox(dialog));
      await userEvent.paste('{"mcpServers": {"dodok": {"type":"http","url":"https://x.example/"}}}');
      expect(within(dialog).getByRole("alert")).toHaveTextContent("dodok");
      expect(within(dialog).getByRole("button", { name: "만들기" })).toBeDisabled();
    });

    it("「이 도구만」을 빈 채로 두면 잠근다 — 그 뒤 JSON 을 고쳐도 잠금이 풀리지 않는다", async () => {
      serveTools();
      const dialog = await openBotDialog();
      await userEvent.type(within(dialog).getByRole("textbox", { name: "핸들" }), "rev");
      await userEvent.click(mcpBox(dialog));
      await userEvent.paste(MCP_JSON);
      const create = within(dialog).getByRole("button", { name: "만들기" });
      expect(create).toBeEnabled();
      await userEvent.selectOptions(
        within(dialog).getAllByRole("combobox", { name: "묻지 않음" })[0]!,
        "tools",
      );
      expect(create).toBeDisabled();
      await userEvent.type(mcpBox(dialog), " ");
      expect(within(dialog).queryByRole("alert")).toBeNull();
      expect(create).toBeDisabled();
    });

    it("러너 도구 상한 밖의 자동 허용 — 서버는 쓸 수 있고 자동 허용만 막힌다고 보인다(T15)", async () => {
      serveTools(TOOL_CAPS, { ...httpCeiling, allowedToolsCeiling: ["mcp__github__a"] });
      const dialog = await openBotDialog();
      await userEvent.click(mcpBox(dialog));
      await userEvent.paste(MCP_JSON);
      await userEvent.selectOptions(
        within(dialog).getAllByRole("combobox", { name: "묻지 않음" })[0]!,
        "all",
      );
      expect(within(dialog).getByTestId("mcp-verdict-github")).toHaveTextContent(
        "쓸 수 있음 · 이 러너가 막음 — 도구 상한 밖: mcp__github(자동 허용만 막힘)",
      );
    });

    it("runnerControl 이 없는 러너 — 「이 러너 설정 제어」를 사유와 함께 잠근다", async () => {
      serveTools(BOTS_CAPS);
      const dialog = await openBotDialog();
      const box = within(dialog).getByRole("checkbox", { name: "이 러너 설정 제어" });
      expect(box).toBeDisabled();
      expect(box).toHaveAccessibleDescription("러너를 업데이트하세요(봇 도구는 0.10.0 부터)");
    });

    it("상세 편집 — 가림 글자(••••)는 그대로 보이고, 바꾸지 않고 저장하면 본문에도 •••• 그대로", async () => {
      const masked = {
        github: { type: "http" as const, url: "https://x.example/mcp", headers: { Authorization: "••••" } },
      };
      const base = coder({
        projectId: null,
        bot: { ...DEF, mcpServers: masked, mcpAutoAllow: { github: { mode: "all" } } },
      });
      const server = stubServer({
        agents: [{ ...base, runner: { ...base.runner!, bot: true } }],
        runners: runnersRoutes({
          runners: [
            runnerOf(1, {
              label: "맥북",
              capabilities: TOOL_CAPS,
              programs: [programOf({ ceiling: httpCeiling })],
            }),
          ],
        }).handle,
      });
      renderPage(
        createQueryClient(() => {}),
        "admin",
      );
      const row = await agentDetail();
      await userEvent.click(within(row).getByRole("button", { name: "@coder 봇 정의 편집" }));
      expect((mcpBox(row) as HTMLTextAreaElement).value).toContain('"Authorization": "••••"');
      await userEvent.click(within(row).getByRole("button", { name: "저장" }));
      await waitFor(() => expect(server.bodies("PATCH")).toHaveLength(1));
      const body = server.bodies("PATCH")[0] as { bot: { mcpServers: unknown; mcpAutoAllow: unknown } };
      expect(body.bot.mcpServers).toEqual(masked);
      expect(body.bot.mcpAutoAllow).toEqual({ github: { mode: "all" } });
    });

    it("member 에게는 도구 칸이 없다", async () => {
      stubServer({ agents: [bot(false)] });
      renderPage(
        createQueryClient(() => {}),
        "member",
      );
      const row = await agentDetail();
      expect(within(row).queryByRole("group", { name: "도구" })).toBeNull();
      expect(within(row).queryByText("MCP 서버(.mcp.json)")).toBeNull();
    });
  });

  it("보관한 봇은 되살린다 — 「프로젝트가 없어 되살릴 수 없습니다」가 아니다", async () => {
    stubServer({ agents: [{ ...bot(), archivedAt: ARCHIVED_AT }] });
    renderPage();
    const row = await agentDetail();
    expect(row).not.toHaveTextContent(NO_PROJECT_RESTORE);
    expect(within(row).getByRole("button", { name: "@coder 되살리기" })).toBeInTheDocument();
  });
});
