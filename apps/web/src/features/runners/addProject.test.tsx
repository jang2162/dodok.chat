import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiErr,
  json,
  renderRunnersPage,
  runnerId,
  runnerOf,
  stubRunners,
} from "../../../test/runnersServer";
import { REL_PATH_RULE, TRUNCATED_NOTE } from "./AddProjectDialog";
import { BROWSE_OFF, CHECK_REASON } from "./copy";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stub(opts: Parameters<typeof stubRunners>[0] = {}) {
  const server = stubRunners(opts);
  vi.stubGlobal("fetch", vi.fn(server.fetch));
  return server;
}

/** 디렉터리 나무 — src 루트 아래 dodok(git)·notes, dodok 아래 apps */
const TREE: Record<string, { name: string; isGitRepo: boolean }[]> = {
  "": [
    { name: "dodok", isGitRepo: true },
    { name: "notes", isGitRepo: false },
  ],
  dodok: [{ name: "apps", isGitRepo: false }],
};

async function openAdd() {
  const card = await screen.findByRole("article", { name: "러너-1" });
  await userEvent.click(within(card).getByRole("button", { name: "프로젝트 추가" }));
  return screen.findByRole("dialog");
}

const fsCalls = (server: ReturnType<typeof stub>) => server.calls.filter((c) => c.url.includes("/fs?"));

describe("프로젝트 추가 — 둘러보기", () => {
  it("루트를 고르고 디렉터리로 들어가 빵 부스러기로 돌아온다 — git 표시, 고른 자리로 더한다", async () => {
    const server = stub({
      fs: (_id, _root, rel) => json(200, { entries: TREE[rel] ?? [], truncated: false }),
    });
    renderRunnersPage();
    const dialog = await openAdd();
    const list = await within(dialog).findByRole("list", { name: "하위 디렉터리" });
    expect(within(list).getByRole("button", { name: /dodok/ })).toHaveTextContent("git");
    expect(within(list).getByRole("button", { name: /notes/ })).not.toHaveTextContent("git");

    await userEvent.click(within(list).getByRole("button", { name: /dodok/ }));
    const crumbs = within(dialog).getByRole("navigation", { name: "경로" });
    expect(await within(dialog).findByRole("button", { name: /apps/ })).toBeInTheDocument();
    expect(within(crumbs).getByRole("button", { name: "dodok" })).toHaveAttribute("aria-current", "location");

    await userEvent.click(within(crumbs).getByRole("button", { name: "내 저장소들" }));
    expect(await within(dialog).findByRole("button", { name: /notes/ })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /dodok/ }));
    await within(dialog).findByRole("button", { name: /apps/ });
    await userEvent.click(within(dialog).getByRole("button", { name: "이 디렉터리로" }));

    expect(dialog).toHaveTextContent("내 저장소들/dodok · git 저장소");
    expect(within(dialog).getByLabelText("이름")).toHaveAttribute("placeholder", "dodok");
    await userEvent.click(within(dialog).getByRole("button", { name: "확인하고 추가" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.calls.find((c) => c.method === "POST")).toMatchObject({
      url: `/api/v1/runners/${runnerId(1)}/projects`,
      body: { rootId: "src", relPath: "dodok" },
    });
    expect(fsCalls(server).map((c) => c.url)).toEqual([
      `/api/v1/runners/${runnerId(1)}/fs?rootId=src&relPath=`,
      `/api/v1/runners/${runnerId(1)}/fs?rootId=src&relPath=dodok`,
    ]);
    expect(await screen.findByRole("listitem", { name: "dodok" })).toBeInTheDocument();
  });

  it("다른 루트를 고르면 그 루트를 둘러본다", async () => {
    const server = stub();
    renderRunnersPage();
    const dialog = await openAdd();
    await userEvent.click(within(dialog).getByRole("radio", { name: "회사" }));
    await waitFor(() => expect(fsCalls(server).at(-1)?.url).toContain("rootId=work&relPath="));
  });

  it("목록이 잘렸으면(truncated) 직접 입력하라는 안내", async () => {
    stub({ fs: () => json(200, { entries: [{ name: "a", isGitRepo: false }], truncated: true }) });
    renderRunnersPage();
    const dialog = await openAdd();
    expect(await within(dialog).findByText(TRUNCATED_NOTE)).toBeInTheDocument();
  });

  it("둘러보기 403 이면 「이 러너는 둘러보기를 끄고 있습니다 — 경로를 직접 입력하세요」와 직접 입력", async () => {
    stub({ fs: () => apiErr(403, "FORBIDDEN", "browse is off") });
    renderRunnersPage();
    const dialog = await openAdd();
    expect(await within(dialog).findByText(BROWSE_OFF)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("루트 안의 경로")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "둘러보기" })).toBeNull();
    expect(dialog).not.toHaveTextContent("browse is off");
  });

  it("hello 가 browse: false 면 둘러보기를 부르지 않고 처음부터 직접 입력", async () => {
    const server = stub({ runners: [runnerOf(1, { browse: false })] });
    renderRunnersPage();
    const dialog = await openAdd();
    expect(within(dialog).getByText(BROWSE_OFF)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("루트 안의 경로")).toBeInTheDocument();
    expect(fsCalls(server)).toEqual([]);
  });

  it("없는 디렉터리(404)·끊김(503)은 둘러보기 칸 안에 문구와 「다시 시도」", async () => {
    let reply = () => apiErr(404, "NOT_FOUND", "x");
    stub({ fs: () => reply() });
    renderRunnersPage();
    const dialog = await openAdd();
    expect(await within(dialog).findByText(/디렉터리를 찾지 못했습니다/)).toBeInTheDocument();
    reply = () => apiErr(503, "ADAPTER_UNAVAILABLE", "x");
    await userEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    expect(await within(dialog).findByText(/러너가 연결되어 있지 않습니다/)).toBeInTheDocument();
  });
});

describe("프로젝트 추가 — 직접 입력·확인", () => {
  async function typePath(dialog: HTMLElement, path: string) {
    await userEvent.click(within(dialog).getByRole("button", { name: "직접 입력" }));
    if (path) await userEvent.type(within(dialog).getByLabelText("루트 안의 경로"), path);
    await userEvent.click(within(dialog).getByRole("button", { name: "다음" }));
  }

  it("상대 경로를 적어 더한다 — 뒤의 / 는 걷고, 이름을 적으면 함께 보낸다. 비우면 루트 자신", async () => {
    const server = stub();
    renderRunnersPage();
    let dialog = await openAdd();
    await typePath(dialog, "work/app/");
    expect(dialog).toHaveTextContent("내 저장소들/work/app");
    await userEvent.type(within(dialog).getByLabelText("이름"), "앱");
    await userEvent.click(within(dialog).getByRole("button", { name: "확인하고 추가" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    dialog = await openAdd();
    await typePath(dialog, "");
    await userEvent.click(within(dialog).getByRole("button", { name: "확인하고 추가" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([
      { rootId: "src", relPath: "work/app", label: "앱" },
      { rootId: "src", relPath: "" },
    ]);
  });

  it.each(["/Users/me/src", "../etc", "a//b", "a\\b", "./a"])(
    "루트 밖을 가리키는 꼴(%s)은 보내지 않는다",
    async (path) => {
      const server = stub();
      renderRunnersPage();
      const dialog = await openAdd();
      await typePath(dialog, path);
      expect(within(dialog).getByLabelText("루트 안의 경로")).toHaveAccessibleDescription(REL_PATH_RULE);
      expect(server.calls.filter((c) => c.method === "POST")).toEqual([]);
    },
  );

  it.each(Object.entries(CHECK_REASON))(
    "확인 실패(400 details.reason %s)는 고정 문구 — 대화상자는 열린 채, 「뒤로」로 다시 고른다",
    async (reason, text) => {
      stub({
        create: () => apiErr(400, "VALIDATION", `runner refused: ${reason}`, { field: "relPath", reason }),
      });
      renderRunnersPage();
      const dialog = await openAdd();
      await typePath(dialog, "x");
      await userEvent.click(within(dialog).getByRole("button", { name: "확인하고 추가" }));
      expect(await within(dialog).findByText(text)).toBeInTheDocument();
      expect(dialog).not.toHaveTextContent("runner refused");
      await userEvent.click(within(dialog).getByRole("button", { name: "뒤로" }));
      expect(within(dialog).getByLabelText("루트 안의 경로")).toBeInTheDocument();
    },
  );

  it("같은 자리(409)는 고정 문구", async () => {
    stub({ create: () => apiErr(409, "CONFLICT", "dup", { projectId: "p" }) });
    renderRunnersPage();
    const dialog = await openAdd();
    await typePath(dialog, "x");
    await userEvent.click(within(dialog).getByRole("button", { name: "확인하고 추가" }));
    expect(await within(dialog).findByText(/같은 자리의 프로젝트가 이미 있거나/)).toBeInTheDocument();
  });
});
