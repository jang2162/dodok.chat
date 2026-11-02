import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { App } from "@/app/App";
import { createApp } from "@/app/createApp";
import { json, renderRoute } from "../../../test/shellApi";
import {
  OWNER,
  PUBLIC_URL,
  RAW_TOKEN,
  cacheDump,
  renderConnection,
  statusOf,
  stubSetupServer,
  tokenOf,
} from "../../../test/setupServer";
import { publicOriginOf } from "./llms";
import { PACK_COMMAND, pluginInstallCommand } from "./sections";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openIssue() {
  const br = await screen.findByRole("region", { name: "브리지 토큰" });
  await userEvent.click(await within(br).findByRole("button", { name: "새 토큰 발급" }));
  return screen.findByRole("dialog");
}

async function issue(label: string) {
  const dialog = await openIssue();
  await userEvent.type(within(dialog).getByLabelText("라벨"), label);
  await userEvent.click(within(dialog).getByRole("button", { name: "발급" }));
  return dialog;
}

describe("새 토큰 발급", () => {
  it("라벨 → 원문과 설치 명령 한 줄을 한 번 보인다, 복사 버튼으로 복사한다", async () => {
    const server = stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderConnection();
    const dialog = await issue("  게이트웨이 새 토큰 ");
    expect(await within(dialog).findByText(RAW_TOKEN)).toBeInTheDocument();
    expect(server.calls.find((c) => c.method === "POST")?.body).toEqual({ label: "게이트웨이 새 토큰" });
    // Gateway 호스트에 붙여 넣는 한 줄 — 맨 앞 공백(bash 히스토리 피하기)·공개 오리진·토큰을 품는다
    const command = within(dialog).getByTestId("plugin-install-command").textContent ?? "";
    expect(command).toBe(pluginInstallCommand(publicOriginOf(PUBLIC_URL), RAW_TOKEN));
    expect(command.startsWith(" curl -fsS https://chat.example.com/api/v1/setup/plugin-install.sh | ")).toBe(
      true,
    );
    expect(command.endsWith(`DODOK_BRIDGE_TOKEN='${RAW_TOKEN}' bash`)).toBe(true);
    expect(command).not.toContain("\n");
    // 설정 조각(JSON)은 설치 명령이 대신한다
    expect(within(dialog).queryByTestId("plugin-config")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "설정 복사" })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "토큰 복사" }));
    expect(writeText).toHaveBeenLastCalledWith(RAW_TOKEN);
    await userEvent.click(within(dialog).getByRole("button", { name: "설치 명령 복사" }));
    expect(writeText).toHaveBeenLastCalledWith(command);
  });

  it("좁은 대화상자에서도 원문을 숨기지 않는다 — 토큰은 줄을 바꾸고, 설치 명령은 제 상자 안에서 가로로 스크롤한다", async () => {
    // jsdom 은 레이아웃이 없어 구조만 본다 — 390px 실측은 s2-c1 보고
    stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    renderConnection();
    const dialog = await issue("좁은 화면");
    const token = await within(dialog).findByText(RAW_TOKEN);
    const config = within(dialog).getByTestId("plugin-install-command");
    // grid 트랙 안의 블록이 원문 폭만큼 트랙을 넓히지 않는다(min-width:auto 면 대화상자 밖으로 삐져나간다)
    for (const pre of [token, config]) expect(pre.parentElement).toHaveClass("min-w-0");
    expect(token).toHaveClass("whitespace-pre-wrap", "break-all");
    expect(token).not.toHaveClass("overflow-x-auto");
    // 설치 명령은 한 줄을 지키고(줄을 바꾸면 붙여 넣은 셸이 두 명령으로 읽는다) 넘치는 폭은 제 상자 안에서 스크롤한다
    expect(config).toHaveClass("whitespace-pre", "overflow-x-auto");
  });

  it("서버에 플러그인 파일이 없으면 설치 명령 대신 만드는 명령 — 원문·「AI 에게 맡기기」는 그대로", async () => {
    stubSetupServer({
      status: statusOf({ pluginFile: { available: false }, pluginMatches: null }),
      tokens: [tokenOf(1, { connected: true })],
    });
    renderConnection();
    const dialog = await issue("파일 없음");
    expect(await within(dialog).findByText(RAW_TOKEN)).toBeInTheDocument();
    expect(within(dialog).getByTestId("llms-handoff")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("plugin-install-command")).not.toBeInTheDocument();
    expect(within(dialog).getByText(PACK_COMMAND)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("서버에 플러그인 파일이 없습니다");
  });

  it("「복사했습니다」 전에는 Esc 로도 닫히지 않는다 — 누르면 닫히고, 원문은 DOM·쿼리·뮤테이션 캐시 어디에도 없다", async () => {
    stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    const qc = renderConnection();
    const dialog = await issue("새것");
    await within(dialog).findByText(RAW_TOKEN);
    // 발급 중에도·보이는 동안에도 캐시에는 원문이 없다
    expect(cacheDump(qc)).not.toContain("dbt_");

    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).queryByRole("button", { name: "닫기" })).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // 새 줄은 목록에 보이되 원문은 없다
    const br = screen.getByRole("region", { name: "브리지 토큰" });
    expect(await within(br).findByRole("listitem", { name: "새것" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(RAW_TOKEN);
    expect(cacheDump(qc)).not.toContain("dbt_");
    expect(cacheDump(qc)).not.toContain(RAW_TOKEN.slice(4));

    // 다시 열면 원문 없이 라벨 입력부터
    const again = await openIssue();
    expect(again).not.toHaveTextContent(RAW_TOKEN);
    expect(within(again).getByLabelText("라벨")).toHaveValue("");
  });

  it("발급 중에는 Esc 로 닫히지 않는다 — 응답이 오면 그 대화상자에 원문이 보인다", async () => {
    let answer: (r: Response) => void = () => {};
    stubSetupServer({ issue: () => new Promise<Response>((r) => (answer = r)) });
    renderConnection();
    const dialog = await issue("느린 발급");
    await within(dialog).findByRole("button", { name: "발급하는 중…" });
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBe(dialog);

    answer(
      json(201, {
        token: RAW_TOKEN,
        record: tokenOf(9, { label: "느린 발급" }),
        pluginConfig: {
          channels: { dodok: { accounts: { default: { bridgeUrl: PUBLIC_URL, token: RAW_TOKEN } } } },
        },
      }),
    );
    expect(await within(dialog).findByText(RAW_TOKEN)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("그 밖의 VALIDATION·CONFLICT 도 고정 문구로", async () => {
    let code = "VALIDATION";
    stubSetupServer({
      issue: () => json(code === "VALIDATION" ? 400 : 409, { code, message: "server said" }),
    });
    renderConnection();
    const dialog = await issue("게이트웨이");
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("라벨은 1~60자로 적어 주세요.");
    expect(alert).not.toHaveTextContent("server said");

    code = "CONFLICT";
    await userEvent.click(within(dialog).getByRole("button", { name: "발급" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "토큰을 발급하지 못했습니다. 다시 시도해 주세요.",
      ),
    );
    expect(dialog).not.toHaveTextContent("server said");
  });

  it("라벨이 비어 있으면 발급 버튼이 잠긴다", async () => {
    stubSetupServer();
    renderConnection();
    const dialog = await openIssue();
    expect(within(dialog).getByRole("button", { name: "발급" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("라벨"), "   ");
    expect(within(dialog).getByRole("button", { name: "발급" })).toBeDisabled();
  });
});

describe("원문이 보이는 동안 페이지를 떠나지 않게", () => {
  const beforeUnloadPrevented = () => {
    const ev = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  it("탭 닫기·새로고침(beforeunload)은 원문이 보이는 동안만 막는다", async () => {
    stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    renderConnection();
    expect(beforeUnloadPrevented()).toBe(false);
    const dialog = await issue("새것");
    await within(dialog).findByText(RAW_TOKEN);
    expect(beforeUnloadPrevented()).toBe(true);
    await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("라우트 이동은 대화상자 안에서 묻는다 — 머무르면 원문이 그대로, 떠나면 원문을 버리고 이동한다", async () => {
    stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    const { router } = renderRoute("/settings/connection");
    const dialog = await issue("새것");
    await within(dialog).findByText(RAW_TOKEN);

    act(() => void router.navigate({ to: "/settings/agents" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("토큰 원문을 다시 볼 수 없습니다");
    expect(alert).toHaveTextContent("「복사했습니다」를 누르세요. 닫고 이어서 이동합니다");
    await waitFor(() => expect(within(alert).getByRole("button", { name: "머무르기" })).toHaveFocus());
    expect(router.state.location.pathname).toBe("/settings/connection");

    await userEvent.click(within(alert).getByRole("button", { name: "머무르기" }));
    await waitFor(() => expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/settings/connection");
    expect(within(dialog).getByText(RAW_TOKEN)).toBeInTheDocument();

    act(() => void router.navigate({ to: "/settings/agents" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "원문을 버리고 떠나기" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/agents"));
    expect(document.body.innerHTML).not.toContain(RAW_TOKEN);
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("「복사했습니다」 뒤에는 이동을 막지 않는다", async () => {
    stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    const { router } = renderRoute("/settings/connection");
    const dialog = await issue("새것");
    await userEvent.click(await within(dialog).findByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    act(() => void router.navigate({ to: "/settings/agents" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/agents"));
  });

  it("막힌 이동이 있을 때 「복사했습니다」를 누르면 닫고 이어서 이동한다", async () => {
    stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    const { router } = renderRoute("/settings/connection");
    const dialog = await issue("새것");
    await within(dialog).findByText(RAW_TOKEN);
    act(() => void router.navigate({ to: "/settings/agents" }));
    await within(dialog).findByRole("alert");
    await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/agents"));
    expect(document.body.innerHTML).not.toContain(RAW_TOKEN);
  });

  it("원문이 보이는 동안 세션이 끝나면(401) 묻지 않고 바로 로그인 화면으로 간다", async () => {
    stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    const history = createMemoryHistory({ initialEntries: ["/settings/connection"] });
    const app = createApp(history);
    render(<App app={app} />);
    const dialog = await issue("새것");
    await within(dialog).findByText(RAW_TOKEN);

    // 401 은 me·setup 만 — 셸의 다른 요청이 401 을 다시 불러 두 번째 이동으로 빠져나가지 않게, 이동 한 번만 잰다
    const served = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) =>
        String(input) === "/api/v1/auth/me" || String(input).startsWith("/api/v1/setup/")
          ? json(401, { code: "UNAUTHORIZED", message: "로그인이 필요하다" })
          : served(input, init),
      ),
    );
    act(() => app.onUnauthorized());
    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(history.location.pathname).toBe("/login");
    expect(document.body.innerHTML).not.toContain(RAW_TOKEN);
    expect(screen.queryByText(/권한이 없습니다/)).not.toBeInTheDocument();
  });

  it("이동이 막힌 채 대화상자가 사라지면(owner 가 아니게 됨) 막아 둔 이동을 이어서 보낸다", async () => {
    stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    const { router, queryClient } = renderRoute("/settings/connection");
    const dialog = await issue("새것");
    await within(dialog).findByText(RAW_TOKEN);
    act(() => void router.navigate({ to: "/settings/agents" }));
    await within(dialog).findByRole("alert");

    act(() => queryClient.setQueryData(qk.me, { ...OWNER, role: "member" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/agents"));
    expect(document.body.innerHTML).not.toContain(RAW_TOKEN);
  });
});
