import type { Agent } from "@dodok/shared";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentDetail, agentPath, apiErr, dev, fin, renderPage, stubServer } from "../../../test/agentsPage";
import { DM_ACCESS_EVERYONE_NOTE } from "./AgentRow";

// 에이전트 DM 계획 태스크 5 Step 7 — 에이전트 설정의 DM 허용 범위(`dmAccess`, admin 이상)와 「DM 보내기」

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 그 에이전트의 상세를 띄우고 본문을 돌려준다 */
const open = async (agents: Agent[], i: number, role = "owner") => {
  stubServer({ agents });
  renderPage(undefined, role, agentPath(agents[i] as Agent));
  return agentDetail();
};

describe("DM 허용", () => {
  it("admin 이상은 선택지 셋(끔·admin 이상·모두)과 「모두」 아래 설명 — 고르면 PATCH { dmAccess } 하나", async () => {
    const agent = dev();
    const server = stubServer({ agents: [agent] });
    renderPage(undefined, "admin", agentPath(agent));
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

  it("저장에 실패하면 오류 줄을 묶음이 가리킨다 — 스크린 리더가 묶음과 함께 읽는다(리뷰 참고)", async () => {
    const agent = dev();
    stubServer({ agents: [agent], patch: () => apiErr(409, "AGENT_ARCHIVED", "agent archived") });
    renderPage(undefined, "admin", agentPath(agent));
    const group = await screen.findByRole("radiogroup", { name: "@dev DM 허용" });
    expect(group).not.toHaveAttribute("aria-describedby");
    await userEvent.click(within(group).getByRole("radio", { name: "끔" }));
    await waitFor(() => expect(group).toHaveAccessibleDescription("삭제된 에이전트입니다"));
    expect(document.getElementById(group.getAttribute("aria-describedby") ?? "")).toHaveAttribute(
      "data-slot",
      "field-error",
    );
  });

  it("member 는 값만 본다 — 선택지가 없다", async () => {
    expect(await open([dev()], 0, "member")).toHaveTextContent("DM 허용: admin 이상");
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});

describe("「DM 보내기」", () => {
  it("지금 내 역할로 열 수 있는 에이전트에만 — /dm/<에이전트> 로", async () => {
    const everyone = { ...dev(), dmAccess: "everyone" as const };
    const admins = { ...fin(), enabled: true, dmAccess: "admins" as const };
    const first = await open([everyone, admins], 0, "member");
    expect(await within(first).findByRole("link", { name: "@dev DM 보내기" })).toHaveAttribute(
      "href",
      `/dm/${everyone.id}`,
    );
    cleanup();
    const second = await open([everyone, admins], 1, "member");
    await within(second).findByText("@fin");
    expect(within(second).queryByRole("link", { name: /DM 보내기/ })).toBeNull();
  });

  it("꺼진 에이전트에는 없다(owner 여도)", async () => {
    const detail = await open([fin()], 0);
    await within(detail).findByText("@fin");
    expect(screen.queryByRole("link", { name: /DM 보내기/ })).toBeNull();
  });
});
