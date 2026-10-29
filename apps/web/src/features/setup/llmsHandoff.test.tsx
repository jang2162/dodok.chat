import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RAW_RUNNER_TOKEN,
  RAW_TOKEN,
  RUNNER_SERVER_URL,
  renderConnection,
  stubSetupServer,
  tokenOf,
} from "../../../test/setupServer";
import { llmsHandoffLine, publicOriginOf } from "./llms";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORIGIN = "https://chat.example.com";

describe("llmsHandoffLine", () => {
  it("스펙 「발급 대화상자」 절의 두 줄 그대로", () => {
    expect(llmsHandoffLine("bridge", ORIGIN, RAW_TOKEN)).toBe(
      `${ORIGIN}/llms.txt 를 읽고 「OpenClaw Gateway 호스트」 절대로 이 호스트에 dodok 플러그인을 설치해 줘. 브리지 토큰: ${RAW_TOKEN}`,
    );
    expect(llmsHandoffLine("runner", ORIGIN, RAW_RUNNER_TOKEN)).toBe(
      `${ORIGIN}/llms.txt 를 읽고 「Claude 러너 머신」 절대로 이 머신에 dodok 러너를 설치해 줘. 러너 토큰: ${RAW_RUNNER_TOKEN}`,
    );
  });

  it("공개 오리진은 브리지 공개 주소에서 — 서버 runnerServerUrl 과 같은 규칙", () => {
    expect(publicOriginOf("wss://chat.example.com/bridge")).toBe("https://chat.example.com");
    expect(publicOriginOf("ws://localhost:3400/bridge")).toBe("http://localhost:3400");
  });
});

/** 원문이 보이는 대화상자에서 「AI 에게 맡기기」 줄을 보고, 복사가 그 줄 전체인지, 닫으면 사라지는지 */
async function expectHandoff(dialog: HTMLElement, line: string) {
  const writeText = vi.mocked(navigator.clipboard.writeText);
  expect(within(dialog).getByText("AI 에게 맡기기")).toBeInTheDocument();
  expect(within(dialog).getByTestId("llms-handoff")).toHaveTextContent(line);
  await userEvent.click(within(dialog).getByRole("button", { name: "AI 에게 맡기기 복사" }));
  expect(writeText).toHaveBeenLastCalledWith(line);

  await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.queryByText("AI 에게 맡기기")).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("llms.txt 를 읽고");
}

/** 원문 화면은 길다(원문·맡기기 줄·설정 조각) — 낮은 화면에서도 「복사했습니다」까지 스크롤해 닿게 대화상자가 화면 높이 안에서 스크롤된다 */
function expectScrollsWithinViewport(dialog: HTMLElement) {
  expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-y-auto");
}

function stubClipboard() {
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async (_text: string) => {}) } });
}

describe("발급 대화상자의 「AI 에게 맡기기」", () => {
  it("브리지 — 원문이 보이는 동안만 한 줄이 있고, 「복사」가 그 줄 전체를 복사한다", async () => {
    stubSetupServer({ tokens: [tokenOf(1, { connected: true })] });
    stubClipboard();
    renderConnection();
    const region = await screen.findByRole("region", { name: "브리지 토큰" });
    await userEvent.click(await within(region).findByRole("button", { name: "새 토큰 발급" }));
    const dialog = await screen.findByRole("dialog");
    // 라벨을 받는 동안에는 원문이 없으니 줄도 없다
    expect(within(dialog).queryByText("AI 에게 맡기기")).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("라벨"), "gw");
    await userEvent.click(within(dialog).getByRole("button", { name: "발급" }));
    await within(dialog).findByText(RAW_TOKEN);
    expectScrollsWithinViewport(dialog);
    await expectHandoff(dialog, llmsHandoffLine("bridge", ORIGIN, RAW_TOKEN));
  });

  it("러너 — 서버가 준 serverUrl 의 /llms.txt, 「Claude 러너 머신」 절", async () => {
    stubSetupServer();
    stubClipboard();
    renderConnection();
    const block = await screen.findByRole("region", { name: "러너" });
    await userEvent.click(await within(block).findByRole("button", { name: "새 러너 토큰 발급" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("AI 에게 맡기기")).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("라벨"), "맥북");
    await userEvent.click(within(dialog).getByRole("button", { name: "발급" }));
    await within(dialog).findByText(RAW_RUNNER_TOKEN);
    expectScrollsWithinViewport(dialog);
    await expectHandoff(dialog, llmsHandoffLine("runner", RUNNER_SERVER_URL, RAW_RUNNER_TOKEN));
  });
});
