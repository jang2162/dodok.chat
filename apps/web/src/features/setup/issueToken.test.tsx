import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, renderRoute } from "../../../test/shellApi";
import {
  PUBLIC_URL,
  RAW_TOKEN,
  cacheDump,
  renderConnection,
  stubSetupServer,
  tokenOf,
} from "../../../test/setupServer";

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
  it("라벨 → 원문과 설정 조각을 한 번 보인다, 복사 버튼으로 복사한다", async () => {
    const server = stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderConnection();
    const dialog = await issue("  게이트웨이 새 토큰 ");
    expect(await within(dialog).findByText(RAW_TOKEN)).toBeInTheDocument();
    expect(server.calls.find((c) => c.method === "POST")?.body).toEqual({ label: "게이트웨이 새 토큰" });
    const config = within(dialog).getByTestId("plugin-config").textContent ?? "";
    expect(JSON.parse(config)).toEqual({
      channels: { dodok: { accounts: { default: { bridgeUrl: PUBLIC_URL, token: RAW_TOKEN } } } },
    });

    await userEvent.click(within(dialog).getByRole("button", { name: "토큰 복사" }));
    expect(writeText).toHaveBeenLastCalledWith(RAW_TOKEN);
    await userEvent.click(within(dialog).getByRole("button", { name: "설정 복사" }));
    expect(JSON.parse(writeText.mock.lastCall?.[0] ?? "")).toEqual(JSON.parse(config));
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

  it("서버가 막은 라벨(env)은 대화상자 안에 서버 문구로", async () => {
    stubSetupServer({
      issue: () =>
        json(400, { code: "VALIDATION", message: "env 는 .env 에서 이어받은 토큰에만 쓰는 라벨입니다" }),
    });
    renderConnection();
    const dialog = await issue("env");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "env 는 .env 에서 이어받은 토큰에만 쓰는 라벨입니다",
    );
    // 실패했으면 그냥 닫을 수 있다
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
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

    act(() => void router.navigate({ to: "/agents" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("토큰 원문을 다시 볼 수 없습니다");
    await waitFor(() => expect(within(alert).getByRole("button", { name: "머무르기" })).toHaveFocus());
    expect(router.state.location.pathname).toBe("/settings/connection");

    await userEvent.click(within(alert).getByRole("button", { name: "머무르기" }));
    await waitFor(() => expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/settings/connection");
    expect(within(dialog).getByText(RAW_TOKEN)).toBeInTheDocument();

    act(() => void router.navigate({ to: "/agents" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "원문을 버리고 떠나기" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents"));
    expect(document.body.innerHTML).not.toContain(RAW_TOKEN);
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("「복사했습니다」 뒤에는 이동을 막지 않는다", async () => {
    stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    const { router } = renderRoute("/settings/connection");
    const dialog = await issue("새것");
    await userEvent.click(await within(dialog).findByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    act(() => void router.navigate({ to: "/agents" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents"));
  });

  it("막힌 이동이 있을 때 「복사했습니다」를 누르면 닫고 이어서 이동한다", async () => {
    stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    const { router } = renderRoute("/settings/connection");
    const dialog = await issue("새것");
    await within(dialog).findByText(RAW_TOKEN);
    act(() => void router.navigate({ to: "/agents" }));
    await within(dialog).findByRole("alert");
    await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/agents"));
    expect(document.body.innerHTML).not.toContain(RAW_TOKEN);
  });
});
