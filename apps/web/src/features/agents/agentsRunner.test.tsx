import type { Agent } from "@dodok/shared";
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
import { CEILING_REFUSED } from "./RunnerAgentForm";

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
function coder(over: Partial<NonNullable<Agent["runnerAgent"]>> = {}, withDefinition = true): Agent {
  const runner = runnerOf(1);
  return makeAgent({
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
            model: "sonnet",
            permissionMode: "default",
            allowedTools: ["Read"],
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
  await userEvent.click(within(row).getByRole("button", { name: "@coder 러너 설정 고치기" }));
  return row;
}

const modeOptions = (row: HTMLElement) =>
  within(within(row).getByRole("combobox", { name: "권한 모드" }))
    .getAllByRole("option")
    .map((o) => ({ value: (o as HTMLOptionElement).value, disabled: (o as HTMLOptionElement).disabled }));

describe("러너 에이전트 줄", () => {
  it("admin 은 정의 요약과 「러너 설정 고치기」 — member 의 Agent 에는 정의가 없어 줄에 없다 [PR11]", async () => {
    stubServer({ agents: [coder()], runners: routes() });
    renderPage(
      createQueryClient(() => {}),
      "admin",
    );
    const row = await agentDetail();
    expect(row).toHaveTextContent("권한 default · 모델 sonnet · 허용 도구 Read");
    expect(within(row).getByRole("button", { name: "@coder 러너 설정 고치기" })).toBeInTheDocument();
  });

  it("member — 프로그램·러너 줄만, 정의 요약·고치기 없음", async () => {
    stubServer({ agents: [coder({}, false)] });
    renderPage(
      createQueryClient(() => {}),
      "member",
    );
    const row = await agentDetail();
    expect(row).toHaveTextContent("Claude Code · 러너 맥북");
    expect(row).not.toHaveTextContent("권한");
    expect(within(row).queryByRole("button", { name: /러너 설정 고치기/ })).toBeNull();
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

describe("러너 에이전트 고치기 — 만들기와 같은 칸", () => {
  it("프로그램·프로젝트는 읽기만, 권한 모드는 붙은 러너의 상한까지", async () => {
    stubServer({ agents: [coder()], runners: routes("default") });
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(row).toHaveTextContent("프로젝트dodok · 내 저장소들/dodok"));
    expect(row).toHaveTextContent("프로그램Claude Code");
    expect(within(row).queryByRole("radio", { name: /Claude Code/ })).toBeNull();
    expect(within(row).queryByRole("combobox", { name: "프로젝트" })).toBeNull();
    await waitFor(() =>
      expect(modeOptions(row)).toEqual([
        { value: "plan", disabled: false },
        { value: "dontAsk", disabled: false },
        { value: "default", disabled: false },
      ]),
    );
  });

  it("상한이 저장된 값 아래로 내려갔으면 지금 값은 「(상한 초과)」로 고를 수 없게 보이고 경고 — 다른 칸만 바꾸는 저장은 된다 [Review Focus 3]", async () => {
    const server = stubServer({
      agents: [coder({ permissionMode: "acceptEdits" })],
      runners: routes("default"),
    });
    renderPage();
    const row = await openEdit();
    const mode = within(row).getByRole("combobox", { name: "권한 모드" });
    await waitFor(() =>
      expect(modeOptions(row)).toEqual([
        { value: "plan", disabled: false },
        { value: "dontAsk", disabled: false },
        { value: "default", disabled: false },
        { value: "acceptEdits", disabled: true },
      ]),
    );
    expect(mode).toHaveValue("acceptEdits");
    expect(mode).toHaveAccessibleDescription(/러너 상한\(default\)보다 높습니다/);
    const model = within(row).getByLabelText("모델");
    await userEvent.clear(model);
    await userEvent.type(model, "opus");
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(server.bodies("PATCH")).toEqual([{ model: "opus" }]));
  });

  it("PATCH 는 바뀐 정의 칸만 — 프로그램·프로젝트는 싣지 않는다 [Step 3b′]", async () => {
    const server = stubServer({ agents: [coder()], runners: routes() });
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(modeOptions(row)).toHaveLength(4));
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "권한 모드" }), "acceptEdits");
    const tools = within(row).getByLabelText("허용 도구");
    await userEvent.clear(tools);
    const model = within(row).getByLabelText("모델");
    await userEvent.clear(model);
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(server.bodies("PATCH")).toHaveLength(1));
    const body = server.bodies("PATCH")[0] as Record<string, unknown>;
    expect(body).toEqual({ model: null, permissionMode: "acceptEdits", allowedTools: null });
    expect(body).not.toHaveProperty("program");
    expect(body).not.toHaveProperty("runnerProjectId");
  });

  it("권한 모드만 바꾸면 PATCH 는 { permissionMode } 하나 — 모델·도구는 싣지 않는다", async () => {
    const server = stubServer({ agents: [coder()], runners: routes() });
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(modeOptions(row)).toHaveLength(4));
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "권한 모드" }), "dontAsk");
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(server.bodies("PATCH")).toEqual([{ permissionMode: "dontAsk" }]));
  });

  it("러너가 끊겨 있으면 상한을 모른다 — 넷 다 고를 수 있고 그렇다고 알린다", async () => {
    stubServer({ agents: [coder()], runners: routes("default", false) });
    renderPage();
    const row = await openEdit();
    await waitFor(() => expect(modeOptions(row)).toHaveLength(4));
    expect(within(row).getByRole("combobox", { name: "권한 모드" })).toHaveAccessibleDescription(
      /러너가 끊겨 있어 상한을 모릅니다/,
    );
  });

  it("서버가 천장으로 거절하면 그 칸 아래 고정 문구", async () => {
    stubServer({ agents: [coder()], runners: routes("default", false) });
    // 서버 400 의 details.field — 이 가짜 서버의 apiErr 는 details 를 싣지 않는다
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
    await waitFor(() => expect(modeOptions(row)).toHaveLength(4));
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "권한 모드" }), "acceptEdits");
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(within(row).getByRole("combobox", { name: "권한 모드" })).toHaveAccessibleDescription(
        CEILING_REFUSED,
      ),
    );
    expect(row).not.toHaveTextContent("허용하지 않습니다(permissionMode)");
  });
});

describe("러너 에이전트 고치기 — 기다림·빈 도구 [리뷰 L8]", () => {
  it("러너 목록을 받는 동안은 「끊겨 있어 상한을 모릅니다」가 아니라 기다림 — 권한 모드는 잠긴다", async () => {
    const handle = routes("default");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubServer({
      agents: [coder()],
      runners: (method, url, body) =>
        method === "GET" && url === "/api/v1/runners"
          ? gate.then(() => handle(method, url, body) as Response)
          : handle(method, url, body),
    });
    renderPage();
    const row = await openEdit();
    const mode = within(row).getByRole("combobox", { name: "권한 모드" });
    expect(mode).toHaveAccessibleDescription("러너 상한을 불러오는 중…");
    expect(mode).toBeDisabled();
    expect(row).not.toHaveTextContent("러너가 끊겨 있어 상한을 모릅니다");
    release();
    await waitFor(() => expect(mode).toHaveAccessibleDescription(/러너 상한은 default/));
    expect(mode).toBeEnabled();
  });

  it("allowedTools: [] 는 요약에 「없음」, 다른 칸만 바꾼 저장은 [] 를 null 로 바꾸지 않는다", async () => {
    const server = stubServer({ agents: [coder({ allowedTools: [] })], runners: routes() });
    renderPage();
    const summary = await agentDetail();
    expect(summary).toHaveTextContent("허용 도구 없음");
    const row = await openEdit();
    await waitFor(() => expect(modeOptions(row)).toHaveLength(4));
    const model = within(row).getByLabelText("모델");
    await userEvent.clear(model);
    await userEvent.type(model, "opus");
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(server.bodies("PATCH")).toEqual([{ model: "opus" }]));
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
