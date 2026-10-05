import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  MINA_ROW,
  OWNER_ROW,
  ADMIN_ROW,
  DEACTIVATED_AT,
  RESET_URL,
  inviteOf,
  stubMembersServer,
} from "../../../test/membersServer";

// 멤버 화면(팀 스펙 4·6장, 채널 보관·멤버 비활성화 스펙 「멤버 비활성화」 절): 표·줄 동작(역할·재설정 링크·비활성화)·
// 「비활성 멤버 N」·초대·대기 중인 초대
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
/** 화면은 로컬 날짜로 그린다 — 기대값도 픽스처 시각의 로컬 날짜로 만들어 시간대(UTC−12~+14)에 묶이지 않게 한다 */
const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
};

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
    expect(mina.getByText(localDay(MINA_ROW.createdAt))).toBeInTheDocument();
    expect((await rowOf("owner")).getByText("소유자")).toBeInTheDocument();
  });

  it("390px 가로 스크롤 상자에 relative 를 둬 sr-only 「동작」이 상자 밖으로 문서를 넓히지 않는다(D1)", async () => {
    stubMembersServer();
    renderRoute("/settings/members");
    const t = await table();
    const scrollBox = t.parentElement;
    expect(scrollBox).toHaveClass("relative", "overflow-x-auto");
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
    expect(mina.getByRole("button", { name: "@mina 비활성화" })).toBeInTheDocument();
    const sora = await rowOf("sora");
    expect(sora.queryByRole("button")).toBeNull();
    expect((await rowOf("owner")).queryByRole("button")).toBeNull();
  });

  it("「비활성화」는 확인 대화상자 뒤 POST 한 번 — 줄은 표에서 「비활성 멤버 1」로 옮겨 간다. 취소하면 보내지 않는다", async () => {
    const server = stubMembersServer();
    renderRoute("/settings/members");
    const mina = await rowOf("mina");
    await userEvent.click(mina.getByRole("button", { name: "@mina 비활성화" }));
    let dialog = await screen.findByRole("dialog", { name: "멤버 비활성화" });
    expect(dialog).toHaveTextContent(
      "@mina 을 비활성화합니다. 로그인할 수 없게 되고, 쓴 메시지는 남습니다. 다시 활성화하면 그대로 돌아옵니다.",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.writes()).toEqual([]);

    await userEvent.click(mina.getByRole("button", { name: "@mina 비활성화" }));
    dialog = await screen.findByRole("dialog", { name: "멤버 비활성화" });
    const confirm = within(dialog).getByRole("button", { name: "비활성화" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.writes()).toEqual([
      { method: "POST", url: `/api/v1/members/${MINA_ID}/deactivate`, body: undefined },
    ]);
    const t = await table();
    await waitFor(() => expect(within(t).queryByText("@mina")).toBeNull());
    const toggle = screen.getByRole("button", { name: "비활성 멤버 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // 줄(과 그 단추)이 사라져도 초점은 body 로 떨어지지 않고 묶음 단추로
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it("「비활성화」가 실패하면 대화상자가 남고, 다시 누르면 POST 를 한 번 더 보낸다 — 연속 클릭 가드가 풀린다", async () => {
    let failures = 1;
    const server = stubMembersServer({
      override: ({ url }) =>
        url.endsWith("/deactivate") && failures-- > 0
          ? json(500, { code: "INTERNAL", message: "boom" })
          : undefined,
    });
    renderRoute("/settings/members");
    const mina = await rowOf("mina");
    await userEvent.click(mina.getByRole("button", { name: "@mina 비활성화" }));
    const dialog = await screen.findByRole("dialog", { name: "멤버 비활성화" });
    const confirm = within(dialog).getByRole("button", { name: "비활성화" });
    await userEvent.click(confirm);
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.getByRole("dialog", { name: "멤버 비활성화" })).toBe(dialog);

    await userEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const deactivate = { method: "POST", url: `/api/v1/members/${MINA_ID}/deactivate`, body: undefined };
    expect(server.writes()).toEqual([deactivate, deactivate]);
  });

  it("「비활성 멤버 N」은 접혀 있고, 펼치면 줄마다 「다시 활성화」 — POST 뒤 표로 돌아온다", async () => {
    const server = stubMembersServer({
      members: [OWNER_ROW, ADMIN_ROW, { ...MINA_ROW, deactivatedAt: DEACTIVATED_AT }],
    });
    renderRoute("/settings/members");
    const t = await table();
    expect(within(t).queryByText("@mina")).toBeNull();
    const toggle = await screen.findByRole("button", { name: "비활성 멤버 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "@mina 다시 활성화" })).toBeNull();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const group = screen.getByRole("region", { name: "비활성 멤버" });
    const line = within(group).getByText("@mina").closest("li") as HTMLElement;
    expect(line).toHaveTextContent("미나");
    expect(line).toHaveTextContent("mina@example.com");
    // 비활성 줄에는 역할 바꾸기·재설정 링크가 없다(서버가 비활성 대상을 404 로 본다)
    expect(within(line).queryByRole("combobox")).toBeNull();
    expect(within(line).queryByRole("button", { name: /재설정 링크/ })).toBeNull();

    // 같은 틱 두 번 — isPending 이 그려지기 전이라 단추가 아직 켜져 있다
    const reactivate = within(line).getByRole("button", { name: "@mina 다시 활성화" });
    fireEvent.click(reactivate);
    fireEvent.click(reactivate);
    await waitFor(() => expect(within(t).getByText("@mina")).toBeInTheDocument());
    expect(server.writes()).toEqual([
      { method: "POST", url: `/api/v1/members/${MINA_ID}/reactivate`, body: undefined },
    ]);
    // 마지막 하나였으면 묶음이 사라지고, 초점은 표로 돌아온 그 줄의 「비활성화」로
    expect(screen.queryByRole("button", { name: /^비활성 멤버/ })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "@mina 비활성화" })).toHaveFocus());
  });

  it("비활성 멤버가 없으면 묶음이 없다", async () => {
    stubMembersServer();
    renderRoute("/settings/members");
    await rowOf("mina");
    expect(screen.queryByRole("button", { name: /^비활성 멤버/ })).toBeNull();
  });

  it("「다시 활성화」 권한은 비활성화와 같다 — admin 은 member 줄만, owner 는 admin 줄까지", async () => {
    const members = [
      OWNER_ROW,
      { ...ADMIN_ROW, deactivatedAt: DEACTIVATED_AT },
      { ...MINA_ROW, deactivatedAt: DEACTIVATED_AT },
    ];
    stubMembersServer({ me: ADMIN_ME, members });
    renderRoute("/settings/members");
    await userEvent.click(await screen.findByRole("button", { name: "비활성 멤버 2" }));
    let group = screen.getByRole("region", { name: "비활성 멤버" });
    expect(within(group).getByRole("button", { name: "@mina 다시 활성화" })).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: "@sora 다시 활성화" })).toBeNull();
    expect(within(group).getByText("@sora")).toBeInTheDocument();
    cleanup();

    stubMembersServer({ members });
    renderRoute("/settings/members");
    await userEvent.click(await screen.findByRole("button", { name: "비활성 멤버 2" }));
    group = screen.getByRole("region", { name: "비활성 멤버" });
    expect(within(group).getByRole("button", { name: "@mina 다시 활성화" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "@sora 다시 활성화" })).toBeInTheDocument();
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

    // 다시 열면 앞 링크가 아니라 「링크 만들기」부터
    await userEvent.click(mina.getByRole("button", { name: "@mina 재설정 링크" }));
    const again = await screen.findByRole("dialog", { name: "비밀번호 재설정 링크" });
    expect(within(again).getByRole("button", { name: "링크 만들기" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("drt_");
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

    // 다시 열면 앞 링크가 아니라 역할·「링크 만들기」 폼부터(역할도 기본값으로)
    const again = await openInvite();
    expect(within(again).getByRole("radio", { name: "멤버" })).toBeChecked();
    expect(within(again).getByRole("button", { name: "링크 만들기" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(INVITE_TOKEN);
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
    expect(items[0]).toHaveTextContent(localDay(invites[0]!.expiresAt));
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

describe("역할 바꾸기·비활성화 뒤 대기 중인 초대", () => {
  // 서버는 강등·비활성화 때 그 사람이 만든 쓰이지 않은 링크를 폐기한다 — 목록을 다시 받아 낡은 줄을 뺀다
  const invites = () => [inviteOf(1, "member"), inviteOf(2, "member", { createdBy: ADMIN_ID })];

  it("admin 을 멤버로 내리면 그 사람이 만든 초대 줄이 빠진다", async () => {
    stubMembersServer({ invites: invites() });
    renderRoute("/settings/members");
    const region = await pending();
    expect(await within(region).findAllByRole("listitem")).toHaveLength(2);
    await userEvent.selectOptions(
      (await rowOf("sora")).getByRole("combobox", { name: "@sora 역할" }),
      "member",
    );
    await waitFor(() => expect(within(region).getAllByRole("listitem")).toHaveLength(1));
  });

  it("비활성화하면 그 사람이 만든 초대 줄이 빠진다", async () => {
    stubMembersServer({ invites: invites() });
    renderRoute("/settings/members");
    const region = await pending();
    expect(await within(region).findAllByRole("listitem")).toHaveLength(2);
    await userEvent.click((await rowOf("sora")).getByRole("button", { name: "@sora 비활성화" }));
    const dialog = await screen.findByRole("dialog", { name: "멤버 비활성화" });
    await userEvent.click(within(dialog).getByRole("button", { name: "비활성화" }));
    await waitFor(() => expect(within(region).getAllByRole("listitem")).toHaveLength(1));
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
      override: ({ url }) => {
        if (url === "/api/v1/auth/me") return json(200, { ...ADMIN_ME, role });
        if (url.endsWith("/deactivate")) return json(403, { code: "FORBIDDEN", message: "admin 이상" });
        return undefined;
      },
    });
    renderRoute("/settings/members");
    const mina = await rowOf("mina");
    role = "member";
    await userEvent.click(mina.getByRole("button", { name: "@mina 비활성화" }));
    const dialog = await screen.findByRole("dialog", { name: "멤버 비활성화" });
    await userEvent.click(within(dialog).getByRole("button", { name: "비활성화" }));
    const page = await screen.findByTestId("page-members");
    expect(await within(page).findByText(/권한이 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("비활성화된 뒤의 다음 요청(401)은 로그인 화면으로", async () => {
    stubMembersServer({
      override: ({ url }) =>
        url.endsWith("/deactivate") || url === "/api/v1/auth/me"
          ? json(401, { code: "UNAUTHORIZED", message: "로그인이 필요하다" })
          : undefined,
    });
    const history = createMemoryHistory({ initialEntries: ["/settings/members"] });
    const app = createApp(history);
    app.queryClient.setQueryData(["me"], ME);
    render(<App app={app} />);
    const mina = await rowOf("mina");
    await userEvent.click(mina.getByRole("button", { name: "@mina 비활성화" }));
    const dialog = await screen.findByRole("dialog", { name: "멤버 비활성화" });
    await userEvent.click(within(dialog).getByRole("button", { name: "비활성화" }));
    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(history.location.pathname).toBe("/login");
  });
});
