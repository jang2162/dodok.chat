import type { Agent, SessionDefaults } from "@dodok/shared";
import { cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/app/queryClient";
import { NO_PROJECT_RESTORE } from "@/features/runners/copy";
import {
  ARCHIVED_AT,
  agentDetail,
  agentPath,
  makeAgent,
  renderPage as renderAt,
  stubServer as serve,
} from "../../../test/agentsPage";
import { programOf, projectOf, runnerOf, runnersRoutes } from "../../../test/runnersServer";
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
const routes = (max: "plan" | "dontAsk" | "default" | "acceptEdits" = "acceptEdits", connected = true) =>
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
    expect(row).toHaveTextContent("새 세션 시작값 · 모델 sonnet · effort high · 권한 기본");
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
  it("프로그램·프로젝트는 읽기만, 권한 모드는 「기본」+넷 — 상한(default) 위는 막고 사유 한 줄", async () => {
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
      ]),
    );
    expect(within(row).getByRole("combobox", { name: "권한 모드" })).toHaveAccessibleDescription(
      ABOVE_CEILING("default"),
    );
  });

  it("셋을 고쳐 저장하면 PATCH 본문은 { sessionDefaults } — 바뀐 칸만, 프로그램·프로젝트는 싣지 않는다", async () => {
    const server = stubServer({ agents: [coder({}, true, { effort: "low" })], runners: routes() });
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(modeOptions(row)).toHaveLength(5));
    await userEvent.type(within(row).getByLabelText("모델"), "opus");
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "effort" }), "max");
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
    await waitFor(() => expect(modeOptions(row)).toHaveLength(5));
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "권한 모드" }), "");
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(server.bodies("PATCH")).toEqual([{ sessionDefaults: { permissionMode: null } }]),
    );
  });

  it("러너가 끊겨 있으면 상한을 모른다 — 넷 다 고를 수 있다", async () => {
    stubServer({ agents: [coder()], runners: routes("default", false) });
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(modeOptions(row).every((o) => !o.disabled)).toBe(true));
    expect(modeOptions(row)).toHaveLength(5);
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
    await waitFor(() => expect(modeOptions(row)).toHaveLength(5));
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
