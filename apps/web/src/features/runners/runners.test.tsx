import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeAgent } from "../../../test/agentsPage";
import {
  apiErr,
  json,
  programOf,
  projectOf,
  projectPath,
  renderRunnersPage,
  runnerOf,
  runnerPath,
  runnerId,
  stubRunners,
} from "../../../test/runnersServer";
import { CHECK_REASON, ROOT_MISSING } from "./copy";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 러너 REST 와 에이전트 목록(옮기기 400 의 이름 풀기) */
function stub(opts: Parameters<typeof stubRunners>[0] = {}, agents = [] as ReturnType<typeof makeAgent>[]) {
  const server = stubRunners(opts, async (input) => {
    if (String(input) === "/api/v1/agents") return json(200, { agents });
    throw new Error(`예상 밖 요청 ${String(input)}`);
  });
  vi.stubGlobal("fetch", vi.fn(server.fetch));
  return server;
}

/** 러너 상세(「연결」 탭의 `/settings/connection/runner/<id>`) — 상세 본문은 러너 라벨을 이름으로 한 article */
const card = (name: string) => screen.findByRole("article", { name });

describe("러너 상세 — 권한", () => {
  it("member 는 러너·프로젝트 API 를 부르지 않는다 — 에이전트의 러너 요약으로 머리와 경고만", async () => {
    const coder = makeAgent({
      provider: "runner",
      providerAgentId: "r-coder",
      handle: "coder",
      name: "Coder",
      runner: { tokenId: runnerId(1), label: "맥북", revoked: false },
    });
    const server = stub({}, [coder]);
    renderRunnersPage("member");
    const detail = await screen.findByTestId("runner-detail");
    expect(within(detail).getByRole("heading", { level: 1, name: "맥북" })).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: /Coder/ })).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "프로젝트 추가" })).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it("member 가 프로젝트 상세를 열면 「권한이 없습니다」 — 러너 API 를 부르지 않는다", async () => {
    const server = stub();
    renderRunnersPage("member", undefined, projectPath(projectOf(1).id));
    expect(await screen.findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(server.calls).toEqual([]);
  });

  it("admin 은 러너 카드를 본다", async () => {
    stub();
    renderRunnersPage("admin");
    expect(await card("러너-1")).toBeInTheDocument();
  });
});

describe("러너 카드", () => {
  it("붙은 러너 — 판본·루트 라벨·프로그램(판본·로그인·권한 상한·도구 상한), 못 쓰는 프로그램은 사유", async () => {
    stub({
      runners: [
        runnerOf(1, {
          label: "맥북",
          programs: [
            programOf({ ceiling: { maxPermissionMode: "default", allowedToolsCeiling: ["Read", "Grep"] } }),
            programOf({ program: "codex", available: false, auth: "unknown", reason: "설치되지 않음" }),
          ],
        }),
      ],
    });
    renderRunnersPage();
    const mac = await card("맥북");
    expect(within(mac).getByText("연결됨")).toBeInTheDocument();
    expect(mac).toHaveTextContent("0.2.0");
    expect(mac).toHaveTextContent("내 저장소들 · 회사");
    expect(within(mac).getByRole("listitem", { name: "Claude Code" })).toHaveTextContent(
      "Claude Code 2.1.283 · 로그인됨 · 권한 상한 default · 허용 도구 상한 Read, Grep",
    );
    expect(within(mac).getByRole("listitem", { name: "Codex" })).toHaveTextContent(
      "Codex — 쓸 수 없음 · 설치되지 않음",
    );
  });

  it("프로그램 줄 — login default 면 로그인 상태 뒤에 (평소 로그인)", async () => {
    stub({ runners: [runnerOf(1, { label: "맥북", programs: [programOf({ login: "default" })] })] });
    renderRunnersPage();
    const mac = await card("맥북");
    expect(within(mac).getByRole("listitem", { name: "Claude Code" })).toHaveTextContent(
      "Claude Code 2.1.283 · 로그인됨 (평소 로그인) · 권한 상한 acceptEdits",
    );
  });

  it("프로그램 줄 — login dedicated 면 (전용 로그인)", async () => {
    stub({ runners: [runnerOf(1, { label: "맥북", programs: [programOf({ login: "dedicated" })] })] });
    renderRunnersPage();
    const mac = await card("맥북");
    const line = within(mac).getByRole("listitem", { name: "Claude Code" });
    expect(line).toHaveTextContent("Claude Code 2.1.283 · 로그인됨 (전용 로그인) · 권한 상한 acceptEdits");
    expect(line).not.toHaveTextContent("평소 로그인");
  });

  it("프로그램 줄 — cli 가 있으면 판본 뒤에 (설치본)·(내장), 없으면(옛 러너) 붙지 않는다", async () => {
    const cases = [
      [programOf({ version: "2.1.322", cli: "installed" }), "Claude Code 2.1.322 (설치본) · 로그인됨"],
      [programOf({ cli: "bundled" }), "Claude Code 2.1.283 (내장) · 로그인됨"],
      [programOf({}), "Claude Code 2.1.283 · 로그인됨"],
    ] as const;
    for (const [program, text] of cases) {
      stub({ runners: [runnerOf(1, { label: "맥북", programs: [program] })] });
      renderRunnersPage();
      const line = within(await card("맥북")).getByRole("listitem", { name: "Claude Code" });
      expect(line).toHaveTextContent(`${text} · 권한 상한 acceptEdits`);
      if (!program.cli) expect(line).not.toHaveTextContent(/설치본|내장/);
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("끊긴 러너는 「끊김」 하나 — 판본·프로그램이 없고 프로젝트 추가가 잠긴다. 폐기한 러너는 옮기라는 안내", async () => {
    stub({
      runners: [
        runnerOf(1, { label: "집", connected: false }),
        runnerOf(2, { label: "옛것", revoked: true }),
      ],
    });
    renderRunnersPage();
    const home = await card("집");
    expect(within(home).getByText("끊김")).toBeInTheDocument();
    expect(home).not.toHaveTextContent("프로그램");
    expect(within(home).getByRole("button", { name: "프로젝트 추가" })).toBeDisabled();
    cleanup();
    renderRunnersPage("admin", undefined, runnerPath(runnerId(2)));
    const old = await card("옛것");
    expect(within(old).getByText("폐기됨")).toBeInTheDocument();
    expect(old).toHaveTextContent("토큰이 폐기된 러너입니다.");
    expect(within(old).getByRole("button", { name: "프로젝트 추가" })).toBeDisabled();
  });

  it("없는 러너 id 면 「이 연결을 찾을 수 없습니다」", async () => {
    stub({ runners: [] });
    renderRunnersPage("owner");
    expect(await screen.findByText("이 연결을 찾을 수 없습니다")).toBeInTheDocument();
  });
});

describe("프로젝트 줄", () => {
  it("라벨·`루트 라벨/relPath`·에이전트 수 — 붙은 러너가 그 루트를 안 알리면 「루트 없음」 [Review Focus 2]", async () => {
    stub({
      projects: [
        projectOf(1, { label: "dodok", relPath: "dodok", agentCount: 2 }),
        projectOf(2, { label: "사라진", rootId: "gone", rootLabel: null, relPath: "x" }),
      ],
    });
    renderRunnersPage();
    const row = await within(await card("러너-1")).findByRole("listitem", { name: /^dodok \(/ });
    expect(row).toHaveTextContent("내 저장소들/dodok · 에이전트 2");
    expect(row).not.toHaveTextContent(ROOT_MISSING);
    const gone = within(await card("러너-1")).getByRole("listitem", { name: /^사라진 \(/ });
    expect(gone).toHaveTextContent(ROOT_MISSING);
    expect(gone).toHaveTextContent("gone/x");
  });

  it("라벨이 같은 프로젝트 둘은 줄·버튼의 접근성 이름이 자리로 갈린다(O2) — 화면 글은 라벨 그대로", async () => {
    stub({
      projects: [
        projectOf(1, { label: "dodok", relPath: "dodok" }),
        projectOf(2, { label: "dodok", relPath: ".config/dodok" }),
      ],
    });
    renderRunnersPage();
    const runner = await card("러너-1");
    const a = await within(runner).findByRole("listitem", { name: "dodok (내 저장소들/dodok)" });
    const b = within(runner).getByRole("listitem", { name: "dodok (내 저장소들/.config/dodok)" });
    for (const [row, place] of [
      [a, "내 저장소들/dodok"],
      [b, "내 저장소들/.config/dodok"],
    ] as const) {
      expect(within(row).getByRole("link", { name: "dodok" })).toHaveAttribute(
        "href",
        projectPath(row === a ? projectOf(1).id : projectOf(2).id),
      );
      expect(within(row).getByRole("button", { name: `dodok (${place}) 확인` })).toHaveTextContent(/^확인$/);
      expect(within(row).getByRole("button", { name: `dodok (${place}) 보관` })).toHaveTextContent(/^보관$/);
      expect(within(row).getByRole("button", { name: `dodok (${place}) 옮기기` })).toHaveTextContent(
        /^옮기기$/,
      );
      await userEvent.click(within(row).getByRole("button", { name: `dodok (${place}) 이름 바꾸기` }));
      expect(within(row).getByRole("textbox", { name: `dodok (${place}) 새 이름` })).toBeInTheDocument();
    }
  });

  it("끊긴 러너의 프로젝트는 루트 라벨을 몰라도 「루트 없음」을 달지 않는다(카드에 「끊김」), 「확인」은 잠긴다", async () => {
    stub({
      runners: [runnerOf(1, { connected: false })],
      projects: [projectOf(1, { label: "dodok", rootLabel: null })],
    });
    renderRunnersPage();
    const row = await within(await card("러너-1")).findByRole("listitem", { name: /^dodok \(/ });
    expect(row).not.toHaveTextContent(ROOT_MISSING);
    expect(within(row).getByRole("button", { name: /^dodok \(.+\) 확인$/ })).toBeDisabled();
  });

  it("「확인」 — 결과 한 줄(git 여부), 실패 사유는 고정 문구, 끊김은 그 줄에", async () => {
    let reply = () => json(200, { ok: true, isGitRepo: true });
    stub({ projects: [projectOf(1, { label: "dodok" })], check: () => reply() });
    renderRunnersPage();
    const row = await within(await card("러너-1")).findByRole("listitem", { name: /^dodok \(/ });
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 확인$/ }));
    expect(await within(row).findByText("확인됨 · git 저장소")).toBeInTheDocument();

    reply = () => json(200, { ok: false, reason: "outside_root" });
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 확인$/ }));
    expect(await within(row).findByText(CHECK_REASON.outside_root)).toBeInTheDocument();

    reply = () => apiErr(503, "ADAPTER_UNAVAILABLE", "runner is not connected");
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 확인$/ }));
    expect(await within(row).findByText(/러너가 연결되어 있지 않습니다/)).toBeInTheDocument();
    expect(row).not.toHaveTextContent("runner is not connected");
  });

  it("이름 바꾸기 — 빈 이름은 보내지 않고, 저장하면 PATCH { label }", async () => {
    const server = stub({ projects: [projectOf(1, { label: "dodok" })] });
    renderRunnersPage();
    const row = await within(await card("러너-1")).findByRole("listitem", { name: /^dodok \(/ });
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 이름 바꾸기$/ }));
    const input = within(row).getByRole("textbox", { name: /^dodok \(.+\) 새 이름$/ });
    await userEvent.clear(input);
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    expect(input).toHaveAccessibleDescription("이름은 1~64자로 적어 주세요");
    expect(server.calls.filter((c) => c.method === "PATCH")).toEqual([]);
    await userEvent.type(input, " 도독 ");
    await userEvent.click(within(row).getByRole("button", { name: "저장" }));
    expect(
      await within(await card("러너-1")).findByRole("listitem", { name: /^도독 \(/ }),
    ).toBeInTheDocument();
    expect(server.calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ label: "도독" }]);
  });

  it("보관 — 확인을 거치고, 이미 있는 에이전트는 남는다고 알린다. 줄은 「보관한 프로젝트」로, 초점은 「프로젝트 추가」로", async () => {
    stub({ projects: [projectOf(1, { label: "dodok", agentCount: 2 })] });
    renderRunnersPage();
    const runner = await card("러너-1");
    const row = await within(runner).findByRole("listitem", { name: /^dodok \(/ });
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 보관$/ }));
    const confirm = await screen.findByRole("dialog");
    expect(confirm).toHaveTextContent("있는 에이전트 2개는 계속 답합니다");
    await userEvent.click(within(confirm).getByRole("button", { name: "보관" }));
    await waitFor(() => expect(within(runner).queryByRole("listitem", { name: /^dodok \(/ })).toBeNull());
    expect(within(runner).getByRole("button", { name: "보관한 프로젝트 1" })).toBeInTheDocument();
    await waitFor(() => expect(within(runner).getByRole("button", { name: "프로젝트 추가" })).toHaveFocus());
  });
});

describe("다른 러너로 옮기기", () => {
  const runners = [
    runnerOf(1, { label: "맥북" }),
    runnerOf(2, { label: "데스크톱" }),
    runnerOf(3, { label: "집", connected: false }),
    runnerOf(4, { label: "옛것", revoked: true }),
  ];

  it("고를 수 있는 것은 폐기하지 않은 다른 러너 중 붙은 것 — 끊긴 것은 잠기고 폐기한 것은 없다", async () => {
    stub({ runners, projects: [projectOf(1, { label: "dodok" })] });
    renderRunnersPage();
    const row = await within(await card("맥북")).findByRole("listitem", { name: /^dodok \(/ });
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 옮기기$/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: "데스크톱" })).toBeEnabled();
    expect(within(dialog).getByRole("radio", { name: "집 (끊김)" })).toBeDisabled();
    expect(within(dialog).queryByRole("radio", { name: /옛것|맥북/ })).toBeNull();
  });

  it("옮길 러너의 천장 밖 에이전트가 있으면(400 runnerId) 그 이름들을 늘어놓는다 — 서버 문구는 보이지 않는다", async () => {
    const a = makeAgent({ providerAgentId: "r-1", handle: "coder", name: "코더", provider: "runner" });
    const b = makeAgent({ providerAgentId: "r-2", handle: "fixer", name: "픽서", provider: "runner" });
    stub(
      {
        runners,
        projects: [projectOf(1, { label: "dodok" })],
        move: () =>
          apiErr(400, "VALIDATION", "러너 설정이 이 에이전트를 허용하지 않습니다(permissionMode)", {
            field: "runnerId",
            agentIds: [a.id, b.id],
            item: "permissionMode",
          }),
      },
      [a, b],
    );
    renderRunnersPage();
    const row = await within(await card("맥북")).findByRole("listitem", { name: /^dodok \(/ });
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 옮기기$/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: "데스크톱" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "옮기기" }));
    expect(
      await within(dialog).findByText(
        "이 러너의 설정이 허용하지 않는 에이전트가 있습니다: @coder, @fixer — 먼저 권한·도구를 낮추거나 보관하세요",
      ),
    ).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("permissionMode");
  });

  it("옮기기가 실패하면 초점은 잠기지 않는 오류 줄로 — 「옮기기」는 잠긴 채일 수 있다(옮길 러너 끊김)", async () => {
    stub({
      runners,
      projects: [projectOf(1, { label: "dodok" })],
      move: () => apiErr(503, "RUNNER_UNAVAILABLE", "runner not connected"),
    });
    renderRunnersPage();
    const row = await within(await card("맥북")).findByRole("listitem", { name: /^dodok \(/ });
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 옮기기$/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: "데스크톱" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "옮기기" }));
    const alert = await within(dialog).findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("옮기면 줄이 그 러너의 상세로 간다", async () => {
    const server = stub({ runners, projects: [projectOf(1, { label: "dodok" })] });
    const { router } = renderRunnersPage();
    const row = await within(await card("맥북")).findByRole("listitem", { name: /^dodok \(/ });
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 옮기기$/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: "데스크톱" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "옮기기" }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("runner-detail")).queryByRole("listitem", { name: /^dodok \(/ }),
      ).toBeNull(),
    );
    await act(() => router.navigate({ to: runnerPath(runnerId(2)) }));
    expect(
      await within(await card("데스크톱")).findByRole("listitem", { name: /^dodok \(/ }),
    ).toBeInTheDocument();
    expect(server.calls.find((c) => c.url.endsWith("/move"))?.body).toEqual({ runnerId: runnerId(2) });
  });
});

// 러너 일반화 태스크 5 리뷰 M2 — 끊긴·폐기한 러너 카드의 「프로젝트 추가」는 잠겨 있어 focus() 가 아무것도 하지 않았다(초점이 body)
describe("줄이 빠진 뒤 초점 — 「프로젝트 추가」가 잠긴 카드", () => {
  it("폐기한 러너에서 옮기면 초점은 그 카드 머리", async () => {
    stub({
      runners: [
        runnerOf(1, { label: "옛것", connected: false, revoked: true }),
        runnerOf(2, { label: "새것" }),
      ],
      projects: [projectOf(1, { label: "dodok" })],
    });
    renderRunnersPage();
    const old = await card("옛것");
    const row = await within(old).findByRole("listitem", { name: /^dodok \(/ });
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 옮기기$/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("radio", { name: "새것" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "옮기기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(old).getByRole("button", { name: "프로젝트 추가" })).toBeDisabled();
    await waitFor(() => expect(within(old).getByRole("heading", { name: "옛것" })).toHaveFocus());
  });

  it("끊긴 러너에서 보관하면 초점은 그 카드 머리", async () => {
    stub({
      runners: [runnerOf(1, { label: "집", connected: false })],
      projects: [projectOf(1, { label: "dodok" })],
    });
    renderRunnersPage();
    const home = await card("집");
    const row = await within(home).findByRole("listitem", { name: /^dodok \(/ });
    await userEvent.click(within(row).getByRole("button", { name: /^dodok \(.+\) 보관$/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "보관" }));
    await waitFor(() => expect(within(home).queryByRole("listitem", { name: /^dodok \(/ })).toBeNull());
    await waitFor(() => expect(within(home).getByRole("heading", { name: "집" })).toHaveFocus());
  });
});
