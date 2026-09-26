import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { App } from "@/app/App";
import { createApp } from "@/app/createApp";
import { ME, json, renderRoute } from "../../../test/shellApi";
import {
  ADMIN_ID,
  INVITE_TOKEN,
  INVITE_URL,
  MINA_ID,
  RESET_URL,
  inviteOf,
  stubMembersServer,
} from "../../../test/membersServer";

// 멤버 화면(팀 스펙 4·6장): 표·줄 동작(역할·재설정 링크·내보내기)·초대·대기 중인 초대
const ADMIN_ME = { user: { id: ADMIN_ID, handle: "sora" }, workspaceId: "w", role: "admin" };

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const table = () => screen.findByRole("table", { name: "멤버" });
const rowOf = async (handle: string) => {
  const t = await table();
  const row = (await within(t).findByText(`@${handle}`)).closest("tr");
  if (!row) throw new Error(`no row @${handle}`);
  return within(row);
};
const pending = () => screen.findByRole("region", { name: "대기 중인 초대" });

describe("멤버 표", () => {
  it("핸들·이름·이메일·역할·가입일", async () => {
    stubMembersServer();
    renderRoute("/settings/members");
    const t = await table();
    expect(
      within(t)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["핸들", "이름", "이메일", "역할", "가입일", "동작"]);
    const mina = await rowOf("mina");
    expect(mina.getByText("미나")).toBeInTheDocument();
    expect(mina.getByText("mina@example.com")).toBeInTheDocument();
    expect(mina.getByText("2026. 9. 25.")).toBeInTheDocument();
    expect((await rowOf("owner")).getByText("owner")).toBeInTheDocument();
  });

  it("owner 는 owner 가 아닌 줄의 역할을 바꾼다 — PATCH { role }", async () => {
    const server = stubMembersServer();
    renderRoute("/settings/members");
    const mina = await rowOf("mina");
    const select = mina.getByRole("combobox", { name: "@mina 역할" });
    expect(select).toHaveValue("member");
    await userEvent.selectOptions(select, "admin");
    await waitFor(() =>
      expect(server.writes()).toEqual([
        { method: "PATCH", url: `/api/v1/members/${MINA_ID}`, body: { role: "admin" } },
      ]),
    );
    await waitFor(() => expect(select).toHaveValue("admin"));
    // owner 줄에는 바꾸기도 줄 동작도 없다
    const owner = await rowOf("owner");
    expect(owner.queryByRole("combobox")).toBeNull();
    expect(owner.queryByRole("button")).toBeNull();
  });

  it("admin 은 역할을 바꾸지 못하고, 줄 동작은 member 줄에만", async () => {
    stubMembersServer({ me: ADMIN_ME });
    renderRoute("/settings/members");
    const mina = await rowOf("mina");
    expect(mina.queryByRole("combobox")).toBeNull();
    expect(mina.getByText("멤버")).toBeInTheDocument();
    expect(mina.getByRole("button", { name: "@mina 재설정 링크" })).toBeInTheDocument();
    expect(mina.getByRole("button", { name: "@mina 내보내기" })).toBeInTheDocument();
    const sora = await rowOf("sora");
    expect(sora.queryByRole("button")).toBeNull();
    expect((await rowOf("owner")).queryByRole("button")).toBeNull();
  });

  it("「내보내기」는 확인 대화상자 뒤 DELETE — 줄이 빠진다. 취소하면 보내지 않는다", async () => {
    const server = stubMembersServer();
    renderRoute("/settings/members");
    const mina = await rowOf("mina");
    await userEvent.click(mina.getByRole("button", { name: "@mina 내보내기" }));
    let dialog = await screen.findByRole("dialog", { name: "멤버 내보내기" });
    expect(dialog).toHaveTextContent("@mina");
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.writes()).toEqual([]);

    await userEvent.click(mina.getByRole("button", { name: "@mina 내보내기" }));
    dialog = await screen.findByRole("dialog", { name: "멤버 내보내기" });
    await userEvent.click(within(dialog).getByRole("button", { name: "내보내기" }));
    await waitFor(() =>
      expect(server.writes()).toEqual([
        { method: "DELETE", url: `/api/v1/members/${MINA_ID}`, body: undefined },
      ]),
    );
    await waitFor(() => expect(screen.queryByText("@mina")).toBeNull());
  });

  it("「재설정 링크」는 만든 링크를 한 번만 보인다 — 「복사했습니다」 뒤에는 어디에도 없다", async () => {
    const server = stubMembersServer();
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { queryClient } = renderRoute("/settings/members");
    const mina = await rowOf("mina");
    await userEvent.click(mina.getByRole("button", { name: "@mina 재설정 링크" }));
    const dialog = await screen.findByRole("dialog", { name: "비밀번호 재설정 링크" });
    await userEvent.click(within(dialog).getByRole("button", { name: "링크 만들기" }));
    expect(await within(dialog).findByText(RESET_URL)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("이 링크는 다시 볼 수 없습니다");
    expect(server.writes()).toEqual([
      { method: "POST", url: `/api/v1/members/${MINA_ID}/reset-link`, body: undefined },
    ]);
    await userEvent.click(within(dialog).getByRole("button", { name: "링크 복사" }));
    expect(writeText).toHaveBeenLastCalledWith(RESET_URL);

    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBe(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain("drt_");
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("drt_");
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state.data),
      ),
    ).not.toContain("drt_");
  });
});

describe("초대", () => {
  async function openInvite() {
    await userEvent.click(await screen.findByRole("button", { name: "초대" }));
    return screen.findByRole("dialog", { name: "멤버 초대" });
  }

  it("owner 는 역할을 고른다(admin) → 링크를 한 번만, 복사 버튼, 대기 목록에 새 줄", async () => {
    const server = stubMembersServer({ invites: [] });
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { queryClient } = renderRoute("/settings/members");
    const dialog = await openInvite();
    await userEvent.click(within(dialog).getByRole("radio", { name: "관리자" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "링크 만들기" }));
    const url = await within(dialog).findByText(INVITE_URL);
    expect(server.writes()).toEqual([{ method: "POST", url: "/api/v1/invites", body: { role: "admin" } }]);
    expect(dialog).toHaveTextContent("이 링크는 다시 볼 수 없습니다");
    // 390px 에서도 잘리지 않게 — 아무 글자 사이에서나 줄을 바꾼다(설정 마법사의 토큰 대화상자와 같은 처리)
    expect(url).toHaveClass("whitespace-pre-wrap", "break-all");
    expect(url.parentElement).toHaveClass("min-w-0");
    await userEvent.click(within(dialog).getByRole("button", { name: "링크 복사" }));
    expect(writeText).toHaveBeenLastCalledWith(INVITE_URL);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(INVITE_TOKEN);

    await userEvent.click(within(dialog).getByRole("button", { name: "복사했습니다" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.innerHTML).not.toContain(INVITE_TOKEN);
    expect(await within(await pending()).findByText(/관리자/)).toBeInTheDocument();
  });

  it("owner 의 기본 역할은 멤버", async () => {
    const server = stubMembersServer({ invites: [] });
    renderRoute("/settings/members");
    const dialog = await openInvite();
    expect(within(dialog).getByRole("radio", { name: "멤버" })).toBeChecked();
    await userEvent.click(within(dialog).getByRole("button", { name: "링크 만들기" }));
    await within(dialog).findByText(INVITE_URL);
    expect(server.writes()[0]?.body).toEqual({ role: "member" });
  });

  it("admin 은 역할을 고르지 못한다 — member 고정", async () => {
    const server = stubMembersServer({ me: ADMIN_ME, invites: [] });
    renderRoute("/settings/members");
    const dialog = await openInvite();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(dialog).toHaveTextContent("멤버로 초대합니다");
    await userEvent.click(within(dialog).getByRole("button", { name: "링크 만들기" }));
    await within(dialog).findByText(INVITE_URL);
    expect(server.writes()).toEqual([{ method: "POST", url: "/api/v1/invites", body: { role: "member" } }]);
  });
});

describe("대기 중인 초대", () => {
  it("역할·만료, 「폐기」 → DELETE → 줄이 빠진다", async () => {
    const invites = [inviteOf(1, "member"), inviteOf(2, "admin")];
    const server = stubMembersServer({ invites });
    renderRoute("/settings/members");
    const region = await pending();
    const items = await within(region).findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("멤버");
    expect(items[0]).toHaveTextContent("2026. 10. 3.");
    await userEvent.click(within(items[0]!).getByRole("button", { name: /폐기/ }));
    await waitFor(() =>
      expect(server.writes()).toEqual([
        { method: "DELETE", url: `/api/v1/invites/${invites[0]!.id}`, body: undefined },
      ]),
    );
    await waitFor(() => expect(within(region).getAllByRole("listitem")).toHaveLength(1));
  });

  it("admin 은 admin 초대를 폐기하지 못한다(버튼 없음)", async () => {
    stubMembersServer({ me: ADMIN_ME, invites: [inviteOf(1, "member"), inviteOf(2, "admin")] });
    renderRoute("/settings/members");
    const items = await within(await pending()).findAllByRole("listitem");
    expect(within(items[0]!).getByRole("button", { name: /폐기/ })).toBeInTheDocument();
    expect(within(items[1]!).queryByRole("button")).toBeNull();
  });

  it("없으면 「대기 중인 초대가 없습니다」", async () => {
    stubMembersServer({ invites: [] });
    renderRoute("/settings/members");
    expect(await within(await pending()).findByText("대기 중인 초대가 없습니다")).toBeInTheDocument();
  });
});

describe("권한이 바뀐 직후", () => {
  it("admin 으로 내려간 owner 가 역할을 바꾸면 403 → 「권한이 없습니다」 한 줄, me 를 다시 받아 역할 칸이 잠긴다(Review Focus 5)", async () => {
    let role = "owner";
    stubMembersServer({
      override: ({ method, url }) => {
        if (url === "/api/v1/auth/me") return json(200, { ...ME, role });
        if (method === "PATCH") return json(403, { code: "FORBIDDEN", message: "owner 만 역할을 바꾼다" });
        return undefined;
      },
    });
    renderRoute("/settings/members");
    const mina = await rowOf("mina");
    const select = mina.getByRole("combobox", { name: "@mina 역할" });
    role = "admin";
    await userEvent.selectOptions(select, "admin");
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("권한이 없습니다", { id: "forbidden" }));
    expect(toastError).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mina.queryByRole("combobox")).toBeNull());
  });

  it("member 로 내려가면 화면이 「권한이 없습니다」로 바뀐다", async () => {
    let role = "admin";
    stubMembersServer({
      me: ADMIN_ME,
      override: ({ method, url }) => {
        if (url === "/api/v1/auth/me") return json(200, { ...ADMIN_ME, role });
        if (method === "DELETE") return json(403, { code: "FORBIDDEN", message: "admin 이상" });
        return undefined;
      },
    });
    renderRoute("/settings/members");
    const mina = await rowOf("mina");
    role = "member";
    await userEvent.click(mina.getByRole("button", { name: "@mina 내보내기" }));
    const dialog = await screen.findByRole("dialog", { name: "멤버 내보내기" });
    await userEvent.click(within(dialog).getByRole("button", { name: "내보내기" }));
    const page = await screen.findByTestId("page-members");
    expect(await within(page).findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("내보내진 뒤의 다음 요청(401)은 로그인 화면으로(Review Focus 3)", async () => {
    stubMembersServer({
      override: ({ method, url }) =>
        method === "DELETE" || url === "/api/v1/auth/me"
          ? json(401, { code: "UNAUTHORIZED", message: "로그인이 필요하다" })
          : undefined,
    });
    const history = createMemoryHistory({ initialEntries: ["/settings/members"] });
    const app = createApp(history);
    app.queryClient.setQueryData(["me"], ME);
    render(<App app={app} />);
    const mina = await rowOf("mina");
    await userEvent.click(mina.getByRole("button", { name: "@mina 내보내기" }));
    const dialog = await screen.findByRole("dialog", { name: "멤버 내보내기" });
    await userEvent.click(within(dialog).getByRole("button", { name: "내보내기" }));
    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(history.location.pathname).toBe("/login");
  });
});
