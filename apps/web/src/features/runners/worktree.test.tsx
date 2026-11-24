import type { RunnerProject } from "@dodok/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiErr,
  json,
  projectId,
  projectOf,
  renderRunnersPage,
  runnerOf,
  stubRunners,
} from "../../../test/runnersServer";
import {
  BROWSE_OFF,
  KEEP_FOLDER,
  WORKTREE_CLEANUP_REASON,
  WORKTREE_CREATE_REASON,
  WORKTREE_LOCK,
  worktreeDefaults,
  worktreeLock,
} from "./copy";

// 러너 프로젝트 git 워크트리 — 만들기 대화상자·잠금 사유·보관 409(워크트리 스펙 5.5, W7·W12)

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const parent = (over: Partial<RunnerProject> = {}) =>
  projectOf(1, { label: "dodok", relPath: "dodok", isGit: true, ...over });
const worktree = (over: Partial<RunnerProject> = {}) =>
  projectOf(2, {
    label: "feat",
    relPath: "dodok/.worktrees/feat",
    parentProjectId: projectId(1),
    branch: "dodok/feat",
    ...over,
  });

type Hit = { method: string; url: string; body: unknown };

/**
 * 러너 REST 가짜 서버 + 워크트리 경로 — POST /runner-projects/:id/worktrees 와 워크트리 보관을 시험이 정한다. 만들면 서버 목록에 더한다
 */
function serve(
  opts: Parameters<typeof stubRunners>[0] & {
    create?: (body: Record<string, unknown>) => Response | undefined;
    archive?: (id: string, body: Record<string, unknown>) => Response | undefined;
  } = {},
) {
  const server = stubRunners(opts, async (input) =>
    String(input) === "/api/v1/agents"
      ? json(200, { agents: [] })
      : json(404, { code: "NOT_FOUND", message: "x" }),
  );
  const hits: Hit[] = [];
  let seq = 500;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const made = /^\/api\/v1\/runner-projects\/([^/]+)\/worktrees$/.exec(url);
    if (method === "POST" && made) {
      hits.push({ method, url, body });
      const b = body as Record<string, unknown>;
      const custom = opts.create?.(b);
      if (custom) return custom;
      const location = b.location as { rootId: string; relPath: string };
      const project = projectOf((seq += 1), {
        label: String(b.label),
        rootId: location.rootId,
        relPath: location.relPath,
        parentProjectId: made[1] ?? null,
        branch: String(b.branch),
      });
      server.projects.push(project);
      return json(201, { project });
    }
    const archived = /^\/api\/v1\/runner-projects\/([^/]+)\/archive$/.exec(url);
    if (method === "POST" && archived) {
      hits.push({ method, url, body });
      const custom = opts.archive?.(archived[1] ?? "", (body ?? {}) as Record<string, unknown>);
      if (custom) return custom;
    }
    return server.fetch(input, init);
  };
  vi.stubGlobal("fetch", vi.fn(fetch));
  return { ...server, hits };
}

const rowOf = (name: RegExp) => screen.findByRole("listitem", { name });

describe("worktreeDefaults·worktreeLock", () => {
  it("dialog prefills .worktrees/<slug> and dodok/<slug> — 서버 slugOf 와 같은 값 셋", () => {
    expect(worktreeDefaults(parent(), "Feat Login")).toEqual({
      branch: "dodok/feat-login",
      location: { rootId: "src", relPath: "dodok/.worktrees/feat-login" },
    });
    expect(worktreeDefaults(parent(), "로그인").branch).toMatch(/^dodok\/wt-[0-9a-f]{6}$/);
    expect(worktreeDefaults(parent(), "--x").branch).toBe("dodok/x");
    expect(worktreeDefaults(parent({ relPath: "" }), "a").location.relPath).toBe(".worktrees/a");
  });

  it("lock reasons: offline / no capability / not git / is worktree", () => {
    const live = runnerOf(1);
    expect(worktreeLock(parent(), live)).toBeUndefined();
    expect(worktreeLock(parent(), runnerOf(1, { connected: false }))).toBe(WORKTREE_LOCK.offline);
    expect(worktreeLock(parent(), runnerOf(1, { revoked: true }))).toBe(WORKTREE_LOCK.revoked);
    expect(worktreeLock(parent(), runnerOf(1, { capabilities: ["threads"] }))).toBe(WORKTREE_LOCK.outdated);
    expect(worktreeLock(parent({ isGit: false }), live)).toBe(WORKTREE_LOCK.notGit);
    expect(worktreeLock(worktree(), live)).toBe(WORKTREE_LOCK.isWorktree);
    expect(worktreeLock(parent({ archivedAt: "2026-11-18T00:00:00.000Z" }), live)).toBe(
      WORKTREE_LOCK.archived,
    );
    expect(WORKTREE_LOCK.outdated).toBe("러너를 업데이트하세요(워크트리는 0.7.0 부터)");
  });
});

describe("워크트리 만들기 대화상자", () => {
  async function openDialog() {
    const row = await rowOf(/^dodok \(/);
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 워크트리 만들기$/ }));
    return screen.findByRole("dialog", { name: /워크트리 만들기/ });
  }

  it("dialog prefills .worktrees/<slug> and dodok/<slug> — 이름을 따라 브랜치·위치가 바뀌고 만든 줄은 부모 아래", async () => {
    const server = serve({ projects: [parent()] });
    renderRunnersPage("admin");
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("워크트리 이름"), "Feat Login");
    expect(within(dialog).getByLabelText("브랜치")).toHaveValue("dodok/feat-login");
    expect(dialog).toHaveTextContent("내 저장소들/dodok/.worktrees/feat-login");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.hits).toEqual([
      {
        method: "POST",
        url: `/api/v1/runner-projects/${projectId(1)}/worktrees`,
        body: {
          label: "Feat Login",
          branch: "dodok/feat-login",
          location: { rootId: "src", relPath: "dodok/.worktrees/feat-login" },
        },
      },
    ]);
    const parentRow = await rowOf(/^dodok \(/);
    const nested = await within(parentRow).findByRole("list", { name: "dodok 워크트리" });
    expect(within(nested).getByRole("listitem", { name: /^Feat Login \(/ })).toHaveTextContent(
      "dodok/feat-login",
    );
  });

  it("브랜치를 손으로 고치면 이름을 바꿔도 따라가지 않는다", async () => {
    const server = serve({ projects: [parent()] });
    renderRunnersPage("admin");
    const dialog = await openDialog();
    const branch = within(dialog).getByLabelText("브랜치");
    await userEvent.clear(branch);
    await userEvent.type(branch, "topic/x");
    await userEvent.type(within(dialog).getByLabelText("워크트리 이름"), "abc");
    expect(branch).toHaveValue("topic/x");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(server.hits).toHaveLength(1));
    expect(server.hits[0]?.body).toMatchObject({ branch: "topic/x" });
  });

  it("change location via direct input", async () => {
    const server = serve({ projects: [parent()] });
    renderRunnersPage("admin");
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("워크트리 이름"), "x");
    await userEvent.click(within(dialog).getByRole("button", { name: "위치 바꾸기" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "직접 입력" }));
    await userEvent.type(within(dialog).getByLabelText("루트 안의 경로"), "trees/x");
    await userEvent.click(within(dialog).getByRole("button", { name: "다음" }));
    expect(dialog).toHaveTextContent("내 저장소들/trees/x");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(server.hits).toHaveLength(1));
    expect(server.hits[0]?.body).toMatchObject({ location: { rootId: "src", relPath: "trees/x" } });
  });

  it("change location via browse — 고른 디렉터리 아래에 이름 슬러그를 붙인다", async () => {
    const server = serve({
      projects: [parent()],
      fs: (_id, _root, rel) =>
        json(200, {
          entries: rel === "" ? [{ name: "trees", isGitRepo: false }] : [],
          truncated: false,
        }),
    });
    renderRunnersPage("admin");
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("워크트리 이름"), "Feat");
    await userEvent.click(within(dialog).getByRole("button", { name: "위치 바꾸기" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: /trees/ }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "이 디렉터리로" }));
    expect(dialog).toHaveTextContent("내 저장소들/trees/feat");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(server.hits).toHaveLength(1));
    expect(server.hits[0]?.body).toMatchObject({ location: { rootId: "src", relPath: "trees/feat" } });
  });

  it("browse disabled runner → direct input only", async () => {
    serve({ runners: [runnerOf(1, { browse: false })], projects: [parent()] });
    renderRunnersPage("admin");
    const dialog = await openDialog();
    await userEvent.click(within(dialog).getByRole("button", { name: "위치 바꾸기" }));
    expect(within(dialog).getByText(BROWSE_OFF)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "둘러보기" })).toBeNull();
    expect(within(dialog).getByLabelText("루트 안의 경로")).toBeInTheDocument();
  });

  it("server 400 reason shows copy", async () => {
    serve({
      projects: [parent()],
      create: () =>
        apiErr(400, "VALIDATION", "x", {
          field: "branch",
          reason: "branch_in_use",
          message: "fatal: in use",
        }),
    });
    renderRunnersPage("admin");
    const dialog = await openDialog();
    await userEvent.type(within(dialog).getByLabelText("워크트리 이름"), "a");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    expect(await within(dialog).findByText(WORKTREE_CREATE_REASON.branch_in_use!)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("fatal: in use");
  });

  it("lock reasons: offline / no capability / not git — 단추가 잠기고 사유 한 줄, 워크트리 줄에는 단추가 없다", async () => {
    serve({
      runners: [runnerOf(1, { capabilities: ["threads"] })],
      projects: [parent(), worktree()],
    });
    renderRunnersPage("admin");
    const row = await rowOf(/^dodok \(/);
    const button = within(row).getByRole("button", { name: /^dodok \(.+\) 워크트리 만들기$/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(WORKTREE_LOCK.outdated);
    const wtRow = await rowOf(/^feat \(/);
    expect(within(wtRow).queryByRole("button", { name: /워크트리 만들기/ })).toBeNull();
    expect(within(wtRow).queryByRole("button", { name: /옮기기/ })).toBeNull();
  });

  it("lock reason: not git", async () => {
    serve({ projects: [parent({ isGit: false })] });
    renderRunnersPage("admin");
    const row = await rowOf(/^dodok \(/);
    const button = within(row).getByRole("button", { name: /^dodok \(.+\) 워크트리 만들기$/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(WORKTREE_LOCK.notGit);
  });

  it("lock reason: offline", async () => {
    serve({ runners: [runnerOf(1, { connected: false })], projects: [parent()] });
    renderRunnersPage("admin");
    const row = await rowOf(/^dodok \(/);
    const button = within(row).getByRole("button", { name: /^dodok \(.+\) 워크트리 만들기$/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(WORKTREE_LOCK.offline);
  });
});

describe("워크트리 보관", () => {
  /** 워크트리 줄의 「⋯」 메뉴 — 초점을 준 뒤 Enter 로 연다(sidebar.test 의 까닭 — jsdom 의 window blur 가 Radix 메뉴를 닫는다) */
  async function worktreeMenu(row: HTMLElement) {
    within(row)
      .getByRole("button", { name: /^feat \(.+\) 더 보기$/ })
      .focus();
    await userEvent.keyboard("{Enter}");
    return screen.findByRole("menu");
  }
  async function archiveWorktree() {
    const row = await rowOf(/^feat \(/);
    const menu = await worktreeMenu(row);
    // 워크트리는 옮기지 않는다(W9) — 메뉴에도 없다
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["확인", "이름 바꾸기", "보관"]);
    await userEvent.click(within(menu).getByRole("menuitem", { name: "보관" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("무시된 파일(node_modules 등)은 함께 지워집니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "보관" }));
    return row;
  }

  it("archive 409 dirty shows reason and keep-folder button", async () => {
    serve({
      projects: [parent(), worktree()],
      archive: (id, body) =>
        id === projectId(2) && !body.keepFolder
          ? apiErr(409, "CONFLICT", "정리하지 못했습니다", { reason: "dirty" })
          : undefined,
    });
    renderRunnersPage("admin");
    await archiveWorktree();
    const row = await rowOf(/^feat \(/);
    expect(await within(row).findByText(WORKTREE_CLEANUP_REASON.dirty!)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /^feat \(.+\) 폴더를 남기고 보관$/ })).toHaveTextContent(
      KEEP_FOLDER,
    );
  });

  it("keep-folder archives with keepFolder:true", async () => {
    const server = serve({ projects: [parent(), worktree({ cleanupIssue: "dirty" })] });
    renderRunnersPage("admin");
    const row = await rowOf(/^feat \(/);
    // 지난 시도의 사유가 줄에 남아 있다
    expect(within(row).getByText(WORKTREE_CLEANUP_REASON.dirty!)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: /^feat \(.+\) 폴더를 남기고 보관$/ }));
    await waitFor(() =>
      expect(server.hits).toContainEqual({
        method: "POST",
        url: `/api/v1/runner-projects/${projectId(2)}/archive`,
        body: { keepFolder: true },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("listitem", { name: /^feat \(/ })).toBeNull());
  });

  it("revoked runner shows keep-folder only", async () => {
    serve({ runners: [runnerOf(1, { revoked: true, connected: false })], projects: [parent(), worktree()] });
    renderRunnersPage("admin");
    const row = await rowOf(/^feat \(/);
    expect(within(row).getByRole("button", { name: /^feat \(.+\) 폴더를 남기고 보관$/ })).toBeEnabled();
    expect(within(row).queryByRole("button", { name: /^feat \(.+\) 보관$/ })).toBeNull();
    // 폴더를 지울 수 없으니 「⋯」 메뉴에도 「보관」이 없다
    const menu = await worktreeMenu(row);
    expect(within(menu).queryByRole("menuitem", { name: "보관" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(within(row).getByText(WORKTREE_CLEANUP_REASON.runner_revoked!)).toBeInTheDocument();
  });
});
