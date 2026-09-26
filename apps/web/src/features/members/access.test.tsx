import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ME, renderRoute } from "../../../test/shellApi";
import { stubMembersServer } from "../../../test/membersServer";

// 설정 메뉴와 역할(팀 스펙 6장): 「멤버」·「운영」은 admin 이상, 「연결」은 owner 만
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const nav = async () => {
  await screen.findByRole("link", { name: "에이전트" });
  return (name: RegExp) => screen.queryByRole("link", { name });
};

describe("사이드바 설정 메뉴", () => {
  it.each([
    ["owner", true, true, true],
    ["admin", true, true, false],
    ["member", false, false, false],
  ])("%s — 멤버 %s · 운영 %s · 연결 %s", async (role, members, ops, connection) => {
    stubMembersServer({ me: { ...ME, role } });
    renderRoute("/agents");
    const link = await nav();
    expect(Boolean(link(/^멤버$/))).toBe(members);
    expect(Boolean(link(/^운영/))).toBe(ops);
    expect(Boolean(link(/^연결$/))).toBe(connection);
  });

  it("「멤버」는 /settings/members 로 간다", async () => {
    stubMembersServer();
    const { router } = renderRoute("/agents");
    const link = await screen.findByRole("link", { name: "멤버" });
    link.click();
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/members"));
    expect(await screen.findByRole("heading", { level: 1, name: "멤버" })).toBeInTheDocument();
  });

  it("member 가 직접 주소로 오면 「권한이 없습니다」 — 멤버 API 를 부르지 않는다", async () => {
    const server = stubMembersServer({ me: { ...ME, role: "member" } });
    renderRoute("/settings/members");
    const page = await screen.findByTestId("page-members");
    expect(await within(page).findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(server.teamCalls()).toEqual([]);
  });
});
