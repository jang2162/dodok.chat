import type { RunnerPermissionMode } from "@dodok/shared";
import { createQueryClient } from "@/app/queryClient";
import { qk } from "@/api/queries";
import { RUNNER_OFFLINE } from "@/features/runners/copy";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPage, stubServer } from "../../../test/agentsPage";
import {
  apiErr,
  programOf,
  projectOf,
  projectPath,
  runnerId,
  runnerOf,
  runnersRoutes,
} from "../../../test/runnersServer";
import {
  CEILING_REFUSED,
  PICKED_PROGRAM_UNAVAILABLE,
  PICKED_RUNNER_OFFLINE,
  PICKED_RUNNER_REVOKED,
  PROJECT_GONE,
} from "./RunnerAgentForm";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * 러너 에이전트는 프로젝트 상세의 「에이전트 만들기」에서 만든다 — 그 러너·프로젝트로 고정(연결 탭 통합 스펙 3.3). 기본은 맥북의
 * 「dodok」(프로젝트 1)
 */
async function openCreate(
  qc = createQueryClient(() => {}),
  project: string = projectOf(1).id,
  role = "owner",
) {
  renderPage(qc, role, projectPath(project));
  await userEvent.click(await screen.findByRole("button", { name: "에이전트 만들기" }));
  const dialog = await screen.findByRole("dialog", { name: "러너 에이전트 만들기" });
  await within(dialog)
    .findByRole("combobox", { name: "권한 모드" })
    .catch(() => undefined);
  return dialog;
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

// 러너 에이전트는 알린 목록이 없다(러너 일반화 계획 판정 PR9) — 프로젝트 상세에서 그 러너·프로젝트로 고정해 프로그램을 골라 새로 만든다
describe("에이전트 만들기 — 프로젝트 상세", () => {
  it("그 러너·프로젝트로 고정 — 러너·프로젝트 고르기가 없고 OpenClaw 찾기를 부르지 않는다", async () => {
    const server = stubServer({ runners: runnerServer().handle });
    const dialog = await openCreate();
    expect(dialog).toHaveTextContent("러너맥북");
    expect(dialog).toHaveTextContent("프로젝트dodok — 내 저장소들/dodok");
    expect(within(dialog).queryByRole("radio", { name: "맥북" })).toBeNull();
    expect(within(dialog).queryByRole("combobox", { name: "프로젝트" })).toBeNull();
    expect(server.count("GET", "/api/v1/agents/discover?provider=runner")).toBe(0);
  });

  it("못 쓰는 프로그램은 흐리게 사유와 함께", async () => {
    stubServer({ runners: runnerServer().handle });
    const dialog = await openCreate();
    const claude = await within(dialog).findByRole("radio", { name: /Claude Code/ });
    const codex = within(dialog).getByRole("radio", { name: "Codex" });
    expect(claude).toBeChecked();
    expect(codex).toBeDisabled();
    expect(codex).toHaveAccessibleDescription("쓸 수 없음 — 설치되지 않음");
  });

  it("권한 모드는 그 프로그램의 상한까지만 고른다 [Review Focus 3]", async () => {
    stubServer({ runners: runnerServer().handle });
    const dialog = await openCreate();
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
    const dialog = await openCreate();
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
    const dialog = await openCreate();
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
    const dialog = await openCreate();
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    const mode = within(dialog).getByRole("combobox", { name: "권한 모드" });
    await waitFor(() => expect(mode).toHaveAccessibleDescription(CEILING_REFUSED));
    expect(dialog).not.toHaveTextContent("허용하지 않습니다(permissionMode)");
  });

  it("끊긴 러너의 프로젝트면 사유를 보이고 「만들기」를 잠근다", async () => {
    const server = stubServer({
      runners: runnersRoutes({
        runners: [runnerOf(2, { connected: false })],
        projects: [projectOf(1, { runnerId: runnerId(2) })],
      }).handle,
    });
    const dialog = await openCreate();
    expect(await within(dialog).findByText(PICKED_RUNNER_OFFLINE)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    expect(server.bodies("POST")).toEqual([]);
  });

  it("admin 도 만든다 — member 에게는 프로젝트 상세가 없다", async () => {
    stubServer({ runners: runnerServer().handle });
    const dialog = await openCreate(undefined, undefined, "admin");
    expect(await within(dialog).findByRole("radio", { name: /Claude Code/ })).toBeChecked();
  });

  it("닫았다 다시 열면 칸이 비어 있다", async () => {
    stubServer({ runners: runnerServer().handle });
    const qc = createQueryClient(() => {});
    let dialog = await openCreate(qc);
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "에이전트 만들기" }));
    dialog = await screen.findByRole("dialog", { name: "러너 에이전트 만들기" });
    expect(within(dialog).getByLabelText("핸들")).toHaveValue("");
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
describe("권한 모드는 늘 상한 안", () => {
  it.each(["plan", "dontAsk"] as const)(
    "상한이 %s 인 프로그램이면 처음 값이 상한 자신이고 바로 만들 수 있다",
    async (max) => {
      const server = stubServer({
        runners: runnersRoutes({
          runners: [runnerOf(1, { programs: [claudeUpTo(max)] })],
          projects: [projectOf(1)],
        }).handle,
      });
      const dialog = await openCreate();
      await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
      const mode = modeOf(dialog);
      expect(mode.value).toBe(max);
      expect(mode).not.toHaveAttribute("aria-invalid", "true");
      await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
      await waitFor(() => expect(server.bodies("POST")).toHaveLength(1));
      expect(server.bodies("POST")[0]).toMatchObject({ permissionMode: max });
    },
  );

  it("상한이 높을 때 acceptEdits 를 고른 뒤 러너가 상한을 default 로 낮추면 default 가 된다", async () => {
    const runners = [runnerOf(1, { programs: [claudeUpTo("acceptEdits")] })];
    const server = stubServer({ runners: runnersRoutes({ runners, projects: [projectOf(1)] }).handle });
    const qc = createQueryClient(() => {});
    const dialog = await openCreate(qc);
    await userEvent.selectOptions(modeOf(dialog), "acceptEdits");
    runners[0] = runnerOf(1, { programs: [claudeUpTo("default")] });
    await act(() => qc.invalidateQueries({ queryKey: qk.runners() }));
    await waitFor(() => expect(modeOf(dialog).value).toBe("default"));
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(server.bodies("POST")).toHaveLength(1));
    expect(server.bodies("POST")[0]).toMatchObject({
      permissionMode: "default",
      runnerProjectId: projectOf(1).id,
    });
  });
});

// 러너 일반화 태스크 5 리뷰 M1 — 고정한 러너가 끊기거나 폐기되면 다른 러너로 바꾸지 않고 사유를 보이며 잠근다
describe("고정한 것을 쥔다", () => {
  it("러너가 끊기면 사유를 보이고 「만들기」를 잠근다, 다시 붙으면 풀린다", async () => {
    const runners = [runnerOf(1, { label: "A" }), runnerOf(2, { label: "B" })];
    const routes = runnersRoutes({
      runners,
      projects: [projectOf(1, { label: "pa" }), projectOf(2, { label: "pb", runnerId: runnerId(2) })],
    });
    const server = stubServer({ runners: routes.handle });
    const qc = createQueryClient(() => {});
    const dialog = await openCreate(qc, projectOf(2).id);
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");

    runners[1] = runnerOf(2, { label: "B", connected: false });
    await act(() => qc.invalidateQueries({ queryKey: qk.runners() }));
    expect(await within(dialog).findByText(PICKED_RUNNER_OFFLINE)).toBeInTheDocument();
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

  // 태스크 5 재리뷰 5-3 — 폐기된 러너는 목록에서 빠진다
  it("러너의 토큰이 폐기되면 사유를 보이고 「만들기」를 잠근다", async () => {
    const runners = [runnerOf(1, { label: "A" })];
    const routes = runnersRoutes({ runners, projects: [projectOf(1, { label: "pa" })] });
    const server = stubServer({ runners: routes.handle });
    const qc = createQueryClient(() => {});
    const dialog = await openCreate(qc);
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");

    runners[0] = runnerOf(1, { label: "A", revoked: true });
    await act(() => qc.invalidateQueries({ queryKey: qk.runners() }));
    expect(await within(dialog).findByText(PICKED_RUNNER_REVOKED)).toBeInTheDocument();
    const create = within(dialog).getByRole("button", { name: "만들기" });
    expect(create).toBeDisabled();
    await userEvent.click(create);
    expect(server.bodies("POST")).toEqual([]);
  });

  it("프로젝트가 보관되면 「보관됐거나 없는 프로젝트」, 만들기 잠김", async () => {
    const routes = runnersRoutes({
      projects: [projectOf(1, { label: "pa" }), projectOf(2, { label: "pb" })],
    });
    const server = stubServer({ runners: routes.handle });
    const qc = createQueryClient(() => {});
    const dialog = await openCreate(qc, projectOf(2).id);
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");

    routes.projects[1] = projectOf(2, { label: "pb", archivedAt: "2026-10-29T00:00:00.000Z" });
    await act(() => qc.invalidateQueries({ queryKey: qk.runnerProjectsAll }));
    expect(await within(dialog).findByText(PROJECT_GONE)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "만들기" })).toBeDisabled();
    // 상세는 남아 「보관됨」 — 다른 프로젝트로 조용히 바뀌지 않는다
    expect(screen.getByText("보관됨", { selector: "[data-slot=badge]" })).toBeInTheDocument();
    expect(server.bodies("POST")).toEqual([]);
  });

  it("고른 프로그램을 러너가 못 쓴다고 알리면 그 칸에 사유, 만들기 잠김", async () => {
    const runners = [
      runnerOf(1, { programs: [programOf(), programOf({ program: "codex", version: "0.1.0" })] }),
    ];
    const routes = runnersRoutes({ runners, projects: [projectOf(1)] });
    stubServer({ runners: routes.handle });
    const qc = createQueryClient(() => {});
    const dialog = await openCreate(qc);
    await userEvent.click(await within(dialog).findByRole("radio", { name: /Codex/ }));
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

describe("루트 없는 프로젝트·실패 문구", () => {
  it("붙은 러너가 루트를 알리지 않는 프로젝트는 「(루트 없음)」 — 만들기는 잠긴다", async () => {
    const server = stubServer({
      runners: runnersRoutes({
        projects: [projectOf(1, { label: "gone", rootId: "old", rootLabel: null })],
      }).handle,
    });
    const dialog = await openCreate();
    await waitFor(() => expect(dialog).toHaveTextContent("gone — old/app1 (루트 없음)"));
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    expect(within(dialog).getByRole("button", { name: "만들기" })).toBeDisabled();
    expect(server.bodies("POST")).toEqual([]);
  });

  it("러너가 끊겨 만들지 못하면(503) 폼 아래 한 번만 — 전역 토스트는 뜨지 않는다", async () => {
    const toastError = vi.spyOn(toast, "error");
    stubServer({
      runners: runnersRoutes({ projects: [projectOf(1)] }).handle,
      create: () => apiErr(503, "ADAPTER_UNAVAILABLE", "runner is not connected"),
    });
    const dialog = await openCreate();
    await userEvent.type(within(dialog).getByLabelText("핸들"), "coder");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));
    expect(await within(dialog).findByText(RUNNER_OFFLINE)).toBeInTheDocument();
    expect(within(dialog).getAllByText(RUNNER_OFFLINE)).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();
  });
});
