import { createQueryClient } from "@/app/queryClient";
import { qk } from "@/api/queries";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, openDiscover, renderPage, stubServer } from "../../../test/agentsPage";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function pickClaude(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole("radio", { name: "러너" }));
}

// 러너 에이전트는 알린 목록이 없다 — 서버 discover 의 러너 갈래를 걷었고(러너 일반화 계획 판정 PR9) 웹은 묻지 않고 빈 목록을 쓴다.
// 러너 에이전트를 만드는 화면은 러너 일반화 계획 태스크 5 가 이 대화상자의 러너 갈래를 바꿔 넣는다
describe("에이전트 가져오기 — 제공자", () => {
  it("열면 OpenClaw — 러너로 바꾸면 서버에 묻지 않고 빈 목록, 되돌리면 OpenClaw 목록", async () => {
    const server = stubServer({
      discover: () => json(200, { agents: [{ providerAgentId: "ops", name: "Ops" }] }),
      discoverClaude: () => json(200, { agents: [{ providerAgentId: "coder", name: "코더" }] }),
    });
    renderPage();
    const dialog = await openDiscover();
    expect(within(dialog).getByRole("radio", { name: "OpenClaw" })).toBeChecked();
    expect(await within(dialog).findByRole("checkbox", { name: "Ops" })).toBeInTheDocument();

    await pickClaude(dialog);
    expect(await within(dialog).findByText(/연결된 러너가 없습니다/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("checkbox", { name: "코더" })).not.toBeInTheDocument();
    expect(server.count("GET", "/api/v1/agents/discover?provider=runner")).toBe(0);

    await userEvent.click(within(dialog).getByRole("radio", { name: "OpenClaw" }));
    expect(await within(dialog).findByRole("checkbox", { name: "Ops" })).toBeInTheDocument();
  });

  it("러너가 없으면 「연결된 러너가 없습니다 — 연결 페이지에서 러너를 붙이세요」, owner 에게는 연결 페이지 링크", async () => {
    stubServer();
    renderPage();
    const dialog = await openDiscover();
    await pickClaude(dialog);
    const link = await within(dialog).findByRole("link", { name: "연결 페이지" });
    expect(dialog).toHaveTextContent("연결된 러너가 없습니다 — 연결 페이지에서 러너를 붙이세요");
    expect(link).toHaveAttribute("href", "/settings/connection");
  });

  it("admin 에게는 같은 안내에 링크가 없다 — 연결 페이지는 owner 만 본다", async () => {
    stubServer();
    renderPage(
      createQueryClient(() => {}),
      "admin",
    );
    const dialog = await openDiscover();
    await pickClaude(dialog);
    expect(await within(dialog).findByText(/연결된 러너가 없습니다/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("link")).not.toBeInTheDocument();
  });

  it("다시 열면 OpenClaw 로 돌아간다", async () => {
    stubServer();
    const qc = renderPage();
    let dialog = await openDiscover();
    await pickClaude(dialog);
    await within(dialog).findByText(/연결된 러너가 없습니다/);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    dialog = await openDiscover();
    expect(within(dialog).getByRole("radio", { name: "OpenClaw" })).toBeChecked();
    expect(qc.getQueryData(qk.agents)).toBeDefined();
  });
});
