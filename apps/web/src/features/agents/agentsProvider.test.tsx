import type { RunnerPermissionMode } from "@dodok/shared";
import { createQueryClient } from "@/app/queryClient";
import { qk } from "@/api/queries";
import { RUNNER_OFFLINE } from "@/features/runners/copy";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, openDiscover, renderPage, stubServer } from "../../../test/agentsPage";
import { apiErr, programOf, projectOf, runnerId, runnerOf, runnersRoutes } from "../../../test/runnersServer";
import {
  CEILING_REFUSED,
  PICKED_PROGRAM_UNAVAILABLE,
  PICKED_RUNNER_OFFLINE,
  PROJECT_GONE,
} from "./RunnerAgentForm";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function pickRunner(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole("radio", { name: "러너" }));
}

/** 러너 둘(끊긴 「러너-2」·붙은 「맥북」 — 상한 default, 도구 상한 Read·Grep, Codex 는 설치 안 됨)과 맥북의 프로젝트 둘(하나는 보관) */
function runnerServer(over: Parameters<typeof runnersRoutes>[0] = {}) {
  return runnersRoutes({
    runners: [
      runnerOf(2, { connected: false }),
      runnerOf(1, {
        label: "맥북",
        programs: [
          programOf({ ceiling: { maxPermissionMode: "default", allowedToolsCeiling: ["Read", "Grep"] } }),
          programOf({
            program: "codex",
            available: false,
            auth: "unknown",
            reason: "설치되지 않음",
            version: undefined,
          }),
        ],
      }),
    ],
    projects: [
      projectOf(1, { label: "dodok", relPath: "dodok" }),
      projectOf(2, { label: "옛것", archivedAt: "2026-10-01T00:00:00.000Z" }),
    ],
    ...over,
  });
}

// 러너 에이전트는 알린 목록이 없다(러너 일반화 계획 판정 PR9) — 러너 → 프로젝트 → 프로그램을 골라 새로 만든다(스펙 7장)
describe("에이전트 가져오기 — 러너 갈래", () => {
  it("열면 OpenClaw — 러너로 바꾸면 찾기를 부르지 않고 러너 폼, 되돌리면 OpenClaw 목록", async () => {
    const runners = runnerServer();
    const server = stubServer({
      discover: () => json(200, { agents: [{ providerAgentId: "ops", name: "Ops" }] }),
      runners: runners.handle,
    });
    renderPage();
    const dialog = await openDiscover();
    expect(within(dialog).getByRole("radio", { name: "OpenClaw" })).toBeChecked();
    expect(await within(dialog).findByRole("checkbox", { name: "Ops" })).toBeInTheDocument();

    await pickRunner(dialog);
    expect(await within(dialog).findByRole("radio", { name: "맥북" })).toBeChecked();
    expect(server.count("GET", "/api/v1/agents/discover?provider=runner")).toBe(0);

    await userEvent.click(within(dialog).getByRole("radio", { name: "OpenClaw" }));
    expect(await within(dialog).findByRole("checkbox", { name: "Ops" })).toBeInTheDocument();
  });

  it("끊긴 러너는 고를 수 없고, 프로젝트는 보관하지 않은 것만, 못 쓰는 프로그램은 흐리게 사유와 함께", async () => {
    stubServer({ runners: runnerServer().handle });
    renderPage();
    const dialog = await openDiscover();
    await pickRunner(dialog);
    expect(await within(dialog).findByRole("radio", { name: "러너-2 (끊김)" })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: "맥북" })).toBeChecked();

    const project = await within(dialog).findByRole("combobox", { name: "프로젝트" });
    await waitFor(() =>
      expect(
        within(project)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["dodok — 내 저장소들/dodok"]),
    );

    const claude = within(dialog).getByRole("radio", { name: /Claude Code/ });
    const codex = within(dialog).getByRole("radio", { name: "Codex" });
    expect(claude).toBeChecked();
    expect(codex).toBeDisabled();
    expect(codex).toHaveAccessibleDescription("쓸 수 없음 — 설치되지 않음");
  });

  it("권한 모드는 그 프로그램의 상한까지만 고른다 [Review Focus 3]", async () => {
    stubServer({ runners: runnerServer().handle });
    renderPage();
    const dialog = await openDiscover();
    await pickRunner(dialog);
    const mode = await within(dialog).findByRole("combobox", { name: "권한 모드" });
    expect(
      within(mode)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(["plan", "dontAsk", "default"]);
    expect(mode).toHaveAccessibleDescription(/러너 상한은 default/);
  });

  it("만들기 — POST 본문은 프로젝트·프로그램·정의(빈 모델은 싣지 않는다·빈 도구는 null)·DM 허용, 만들면 닫는다", async () => {
    const server = stubServer({ runners: runnerServer().handle });
    renderPage();
    const dialog = await openDiscover();
    await pickRunner(dialog);
    await within(dialog).findByRole("combobox", { name: "프로젝트" });
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "권한 모드" }), "dontAsk");
    await userEvent.type(within(dialog).getByLabelText("지시"), "테스트를 먼저 돌린다");
    await userEvent.click(within(dialog).getByRole("radio", { name: "모두" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(server.bodies("POST")).toEqual([
      {
        provider: "runner",
        runnerProjectId: projectOf(1).id,
        program: "claude",
        handle: "coder",
        name: "coder",
        permissionMode: "dontAsk",
        allowedTools: null,
        basePrompt: "테스트를 먼저 돌린다",
        dmAccess: "everyone",
      },
    ]);
  });

  it("허용 도구가 러너 상한 밖이면 칸 아래에 그 도구 이름, 만들기는 잠긴다 — 상한 안이면 목록으로 보낸다", async () => {
    const server = stubServer({ runners: runnerServer().handle });
    renderPage();
    const dialog = await openDiscover();
    await pickRunner(dialog);
    await within(dialog).findByRole("combobox", { name: "프로젝트" });
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    const tools = within(dialog).getByLabelText("허용 도구");
    await userEvent.type(tools, "Read, Bash");
    expect(tools).toHaveAccessibleDescription("러너 상한에 없는 도구입니다: Bash");
    expect(within(dialog).getByRole("button", { name: "만들기" })).toBeDisabled();
    await userEvent.clear(tools);
    await userEvent.type(tools, "Read Grep");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(server.bodies("POST")).toHaveLength(1));
    expect(server.bodies("POST")[0]).toMatchObject({ allowedTools: ["Read", "Grep"] });
  });

  it("서버가 천장으로 거절하면(400 details.field) 그 칸 아래 고정 문구 — 서버 문구는 보이지 않는다", async () => {
    stubServer({
      runners: runnerServer().handle,
      create: () =>
        apiErr(400, "VALIDATION", "러너 설정이 이 에이전트를 허용하지 않습니다(permissionMode)", {
          field: "permissionMode",
        }),
    });
    renderPage();
    const dialog = await openDiscover();
    await pickRunner(dialog);
    await within(dialog).findByRole("combobox", { name: "프로젝트" });
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    const mode = within(dialog).getByRole("combobox", { name: "권한 모드" });
    await waitFor(() => expect(mode).toHaveAccessibleDescription(CEILING_REFUSED));
    expect(dialog).not.toHaveTextContent("허용하지 않습니다(permissionMode)");
  });

  it("러너에 프로젝트가 없으면 「러너」 탭으로 가는 안내, 만들기는 잠긴다", async () => {
    stubServer({ runners: runnerServer({ projects: [] }).handle });
    renderPage();
    const dialog = await openDiscover();
    await pickRunner(dialog);
    const link = await within(dialog).findByRole("link", { name: "러너 탭" });
    expect(link).toHaveAttribute("href", "/settings/runners");
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    expect(within(dialog).getByRole("button", { name: "만들기" })).toBeDisabled();
  });

  it("러너가 없으면 「연결된 러너가 없습니다 — 연결 페이지에서 러너를 붙이세요」, owner 에게는 연결 페이지 링크", async () => {
    stubServer({ runners: runnersRoutes({ runners: [] }).handle });
    renderPage();
    const dialog = await openDiscover();
    await pickRunner(dialog);
    const link = await within(dialog).findByRole("link", { name: "연결 페이지" });
    expect(dialog).toHaveTextContent("연결된 러너가 없습니다 — 연결 페이지에서 러너를 붙이세요");
    expect(link).toHaveAttribute("href", "/settings/connection");
  });

  it("admin 에게는 같은 안내에 링크가 없다 — 연결 페이지는 owner 만 본다", async () => {
    stubServer({ runners: runnersRoutes({ runners: [] }).handle });
    renderPage(
      createQueryClient(() => {}),
      "admin",
    );
    const dialog = await openDiscover();
    await pickRunner(dialog);
    expect(await within(dialog).findByText(/연결된 러너가 없습니다/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("link")).not.toBeInTheDocument();
  });

  it("다시 열면 OpenClaw 로 돌아간다", async () => {
    stubServer({ runners: runnerServer().handle });
    const qc = renderPage();
    let dialog = await openDiscover();
    await pickRunner(dialog);
    await within(dialog).findByRole("radio", { name: "맥북" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    dialog = await openDiscover();
    expect(within(dialog).getByRole("radio", { name: "OpenClaw" })).toBeChecked();
    expect(qc.getQueryData(qk.agents)).toBeDefined();
    expect(qc.getQueryData(qk.runners())).toBeDefined();
  });
});

/** 상한을 정한 Claude Code */
const claudeUpTo = (max: RunnerPermissionMode) =>
  programOf({ ceiling: { maxPermissionMode: max, allowedToolsCeiling: null } });

const modeOf = (dialog: HTMLElement) =>
  within(dialog).getByRole("combobox", { name: "권한 모드" }) as HTMLSelectElement;

// 러너 일반화 태스크 5 리뷰 H1 — 처음 값 default 가 상한 밖이면 select 는 첫 option 을 보이는데 상태는 default 라 만들 수 없었다
describe("러너 갈래 — 권한 모드는 늘 상한 안", () => {
  it.each(["plan", "dontAsk"] as const)(
    "상한이 %s 인 프로그램이면 처음 값이 상한 자신이고 바로 만들 수 있다",
    async (max) => {
      const server = stubServer({
        runners: runnersRoutes({
          runners: [runnerOf(1, { programs: [claudeUpTo(max)] })],
          projects: [projectOf(1)],
        }).handle,
      });
      renderPage();
      const dialog = await openDiscover();
      await pickRunner(dialog);
      await within(dialog).findByRole("option", { name: /app1/ });
      await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
      const mode = modeOf(dialog);
      expect(mode.value).toBe(max);
      expect(mode).not.toHaveAttribute("aria-invalid", "true");
      await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
      await waitFor(() => expect(server.bodies("POST")).toHaveLength(1));
      expect(server.bodies("POST")[0]).toMatchObject({ permissionMode: max });
    },
  );

  it("상한이 높은 러너에서 acceptEdits 를 고른 뒤 상한 default 러너로 바꾸면 default 가 된다", async () => {
    const server = stubServer({
      runners: runnersRoutes({
        runners: [
          runnerOf(1, { label: "A", programs: [claudeUpTo("acceptEdits")] }),
          runnerOf(2, { label: "B", programs: [claudeUpTo("default")] }),
        ],
        projects: [
          projectOf(1, { label: "pa", runnerId: runnerId(1) }),
          projectOf(2, { label: "pb", runnerId: runnerId(2) }),
        ],
      }).handle,
    });
    renderPage();
    const dialog = await openDiscover();
    await pickRunner(dialog);
    await within(dialog).findByRole("option", { name: /pa/ });
    await userEvent.selectOptions(modeOf(dialog), "acceptEdits");
    await userEvent.click(within(dialog).getByRole("radio", { name: "B" }));
    await within(dialog).findByRole("option", { name: /pb/ });
    await waitFor(() => expect(modeOf(dialog).value).toBe("default"));
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(server.bodies("POST")).toHaveLength(1));
    expect(server.bodies("POST")[0]).toMatchObject({
      permissionMode: "default",
      runnerProjectId: projectOf(2).id,
    });
  });
});

// 러너 일반화 태스크 5 리뷰 M1 — 고른 러너가 끊기면 첫 붙은 러너로 조용히 바뀌어 거기에 만들었다
describe("러너 갈래 — 고른 것을 쥔다", () => {
  function twoRunners() {
    const runners = [runnerOf(1, { label: "A" }), runnerOf(2, { label: "B" })];
    const routes = runnersRoutes({
      runners,
      projects: [
        projectOf(1, { label: "pa", runnerId: runnerId(1) }),
        projectOf(2, { label: "pb", runnerId: runnerId(2) }),
      ],
    });
    return { runners, routes };
  }

  it("고른 러너가 끊기면 다른 러너로 바꾸지 않는다 — 사유를 보이고 「만들기」를 잠근다, 다시 붙으면 풀린다", async () => {
    const { runners, routes } = twoRunners();
    const server = stubServer({ runners: routes.handle });
    const qc = createQueryClient(() => {});
    renderPage(qc);
    const dialog = await openDiscover();
    await pickRunner(dialog);
    await userEvent.click(await within(dialog).findByRole("radio", { name: "B" }));
    await within(dialog).findByRole("option", { name: /pb/ });
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");

    runners[1] = runnerOf(2, { label: "B", connected: false });
    await act(() => qc.invalidateQueries({ queryKey: qk.runners() }));
    expect(await within(dialog).findByText(PICKED_RUNNER_OFFLINE)).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "B (끊김)" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "A" })).not.toBeChecked();
    const create = within(dialog).getByRole("button", { name: "만들기" });
    expect(create).toBeDisabled();
    await userEvent.click(create);
    expect(server.bodies("POST")).toEqual([]);

    runners[1] = runnerOf(2, { label: "B" });
    await act(() => qc.invalidateQueries({ queryKey: qk.runners() }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "만들기" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(server.bodies("POST")).toHaveLength(1));
    expect(server.bodies("POST")[0]).toMatchObject({ runnerProjectId: projectOf(2).id });
  });

  it("고른 프로젝트가 보관되면 첫 프로젝트로 바꾸지 않는다 — 「보관됐거나 없는 프로젝트」, 만들기 잠김", async () => {
    const routes = runnersRoutes({
      projects: [projectOf(1, { label: "pa" }), projectOf(2, { label: "pb" })],
    });
    const server = stubServer({ runners: routes.handle });
    const qc = createQueryClient(() => {});
    renderPage(qc);
    const dialog = await openDiscover();
    await pickRunner(dialog);
    const select = await within(dialog).findByRole("combobox", { name: "프로젝트" });
    await within(dialog).findByRole("option", { name: /pb/ });
    await userEvent.selectOptions(select, projectOf(2).id);
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");

    routes.projects[1] = projectOf(2, { label: "pb", archivedAt: "2026-10-29T00:00:00.000Z" });
    await act(() => qc.invalidateQueries({ queryKey: qk.runnerProjectsAll }));
    await waitFor(() => expect(select).toHaveAccessibleDescription(PROJECT_GONE));
    expect((select as HTMLSelectElement).value).toBe(projectOf(2).id);
    expect(within(dialog).getByRole("button", { name: "만들기" })).toBeDisabled();
    await userEvent.selectOptions(select, projectOf(1).id);
    expect(within(dialog).getByRole("button", { name: "만들기" })).toBeEnabled();
    expect(server.bodies("POST")).toEqual([]);
  });

  it("고른 프로그램을 러너가 못 쓴다고 알리면 그 칸에 사유, 만들기 잠김", async () => {
    const runners = [
      runnerOf(1, { programs: [programOf(), programOf({ program: "codex", version: "0.1.0" })] }),
    ];
    const routes = runnersRoutes({ runners, projects: [projectOf(1)] });
    stubServer({ runners: routes.handle });
    const qc = createQueryClient(() => {});
    renderPage(qc);
    const dialog = await openDiscover();
    await pickRunner(dialog);
    await within(dialog).findByRole("option", { name: /app1/ });
    await userEvent.click(within(dialog).getByRole("radio", { name: /Codex/ }));
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");

    runners[0] = runnerOf(1, {
      programs: [programOf(), programOf({ program: "codex", available: false, reason: "로그인 안 됨" })],
    });
    await act(() => qc.invalidateQueries({ queryKey: qk.runners() }));
    expect(await within(dialog).findByText(PICKED_PROGRAM_UNAVAILABLE)).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Claude Code/ })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "만들기" })).toBeDisabled();
  });
});

describe("러너 갈래 — 루트 없는 프로젝트·실패 문구", () => {
  it("붙은 러너가 루트를 알리지 않는 프로젝트는 「(루트 없음)」으로 보이되 고를 수 없다 — 처음 값은 고를 수 있는 것", async () => {
    stubServer({
      runners: runnersRoutes({
        projects: [
          projectOf(1, { label: "gone", rootId: "old", rootLabel: null }),
          projectOf(2, { label: "ok" }),
        ],
      }).handle,
    });
    renderPage();
    const dialog = await openDiscover();
    await pickRunner(dialog);
    const select = (await within(dialog).findByRole("combobox", { name: "프로젝트" })) as HTMLSelectElement;
    const gone = await within(dialog).findByRole("option", { name: /gone/ });
    expect(gone).toHaveTextContent("gone — old/app1 (루트 없음)");
    expect(gone).toBeDisabled();
    await waitFor(() => expect(select.value).toBe(projectOf(2).id));
  });

  it("러너가 끊겨 만들지 못하면(503) 폼 아래 한 번만 — 전역 토스트는 뜨지 않는다", async () => {
    const toastError = vi.spyOn(toast, "error");
    stubServer({
      runners: runnersRoutes({ projects: [projectOf(1)] }).handle,
      create: () => apiErr(503, "ADAPTER_UNAVAILABLE", "runner is not connected"),
    });
    renderPage();
    const dialog = await openDiscover();
    await pickRunner(dialog);
    await within(dialog).findByRole("option", { name: /app1/ });
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    expect(await within(dialog).findByText(RUNNER_OFFLINE)).toBeInTheDocument();
    expect(within(dialog).getAllByText(RUNNER_OFFLINE)).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();
  });
});
