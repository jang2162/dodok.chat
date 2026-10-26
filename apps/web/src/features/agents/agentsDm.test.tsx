import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dev, fin, renderPage, stubServer } from "../../../test/agentsPage";
import { DM_ACCESS_EVERYONE_NOTE } from "./AgentRow";

// 에이전트 DM 계획 태스크 5 Step 7 — 에이전트 설정의 DM 허용 범위(`dmAccess`, admin 이상)와 「DM 보내기」

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const row = async (handle: string) => (await screen.findByText(handle)).closest("li") as HTMLElement;

describe("DM 허용", () => {
  it("admin 이상은 선택지 셋(끔·admin 이상·모두)과 「모두」 아래 설명 — 고르면 PATCH { dmAccess } 하나", async () => {
    const server = stubServer({ agents: [dev()] });
    renderPage(undefined, "admin");
    const group = await screen.findByRole("radiogroup", { name: "@dev DM 허용" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.closest("div")?.textContent),
    ).toEqual(["끔", "admin 이상", "모두"]);
    expect(within(group).getByRole("radio", { name: "admin 이상" })).toBeChecked();
    expect(DM_ACCESS_EVERYONE_NOTE).toBe(
      "member 도 이 에이전트와 DM 을 열고, 그 DM 의 도구 승인을 스스로 결정합니다.",
    );
    // 「모두」 가 설명 줄을 가리킨다
    const everyone = within(group).getByRole("radio", { name: "모두" });
    expect(everyone).toHaveAccessibleDescription(DM_ACCESS_EVERYONE_NOTE);

    await userEvent.click(within(group).getByRole("radio", { name: "모두" }));
    await waitFor(() => expect(server.bodies("PATCH")).toEqual([{ dmAccess: "everyone" }]));
    await waitFor(() => expect(within(group).getByRole("radio", { name: "모두" })).toBeChecked());
  });

  it("member 는 값만 본다 — 선택지가 없다", async () => {
    stubServer({ agents: [dev()] });
    renderPage(undefined, "member");
    expect(await row("@dev")).toHaveTextContent("DM 허용: admin 이상");
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

describe("「DM 보내기」", () => {
  it("지금 내 역할로 열 수 있는 에이전트에만 — /dm/<에이전트> 로", async () => {
    const open = { ...dev(), dmAccess: "everyone" as const };
    const admins = { ...fin(), enabled: true, dmAccess: "admins" as const };
    stubServer({ agents: [open, admins] });
    renderPage(undefined, "member");
    expect(within(await row("@dev")).getByRole("link", { name: "@dev DM 보내기" })).toHaveAttribute(
      "href",
      `/dm/${open.id}`,
    );
    expect(within(await row("@fin")).queryByRole("link", { name: /DM 보내기/ })).toBeNull();
  });

  it("꺼진 에이전트에는 없다(owner 여도)", async () => {
    stubServer({ agents: [fin()] });
    renderPage();
    await row("@fin");
    expect(screen.queryByRole("link", { name: /DM 보내기/ })).toBeNull();
  });
});
