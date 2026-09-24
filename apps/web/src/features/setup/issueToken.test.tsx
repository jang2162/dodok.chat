import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json } from "../../../test/shellApi";
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
