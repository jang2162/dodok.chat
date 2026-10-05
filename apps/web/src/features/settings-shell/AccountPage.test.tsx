import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { type MeResponse, qk } from "@/api/queries";
import { ME, json, renderRoute, shellGet } from "../../../test/shellApi";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MEMBER: MeResponse = {
  ...ME,
  user: {
    id: "01a00000-0000-7000-8000-000000000002",
    workspaceId: "w",
    handle: "mia",
    displayName: "미아",
    email: "mia@example.com",
    authProvider: "local",
    createdAt: "2026-09-26T00:00:00.000Z",
  },
  role: "member",
};

type Handler = (body: unknown) => Response | Promise<Response>;

function stubServer(me: MeResponse, { patchMe, password }: { patchMe?: Handler; password?: Handler } = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === "/api/v1/auth/me") return json(200, me);
    if (url === "/api/v1/me" && init?.method === "PATCH" && patchMe) return patchMe(body);
    if (url === "/api/v1/me/password" && password) return password(body);
    const shell = shellGet(input, init);
    if (shell) return shell;
    throw new Error(`예상 밖 요청 ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const mutationStates = (queryClient: QueryClient) =>
  JSON.stringify(
    queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state),
  );

/** 내 계정 탭 페이지 — 표시 이름 칸이 뜰 때까지(me 를 받은 뒤) 기다린다 */
async function openAccount() {
  const page = await screen.findByTestId("page-account");
  await within(page).findByLabelText("표시 이름");
  return page;
}

describe("AccountPage", () => {
  it("설정의 「내 계정」 탭으로 들어가 핸들·이메일을 보인다", async () => {
    stubServer(MEMBER);
    renderRoute("/settings/agents");
    await userEvent.click(
      within(await screen.findByRole("navigation", { name: "설정" })).getByRole("link", { name: "내 계정" }),
    );
    const page = await openAccount();
    expect(within(page).getByText("@mia · mia@example.com")).toBeInTheDocument();
    expect(within(page).getByLabelText("표시 이름")).toHaveValue("미아");
  });

  it("표시 이름을 저장하면 PATCH /me 뒤 me 캐시의 사용자를 바꾼다 — 그대로거나 비었으면 저장 버튼이 잠긴다", async () => {
    const fetch = stubServer(MEMBER, {
      patchMe: (body) => json(200, { user: { ...MEMBER.user, ...(body as object) } }),
    });
    const { queryClient } = renderRoute("/settings/account");
    const page = await openAccount();
    const save = within(page).getByRole("button", { name: "저장" });
    expect(save).toBeDisabled();
    const name = within(page).getByLabelText("표시 이름");
    await userEvent.clear(name);
    expect(save).toBeDisabled();
    await userEvent.type(name, "미아 킴");
    await userEvent.click(save);

    expect(await within(page).findByText("저장했습니다")).toBeInTheDocument();
    const patch = fetch.mock.calls.find(
      ([url, init]) => String(url) === "/api/v1/me" && init?.method === "PATCH",
    );
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ displayName: "미아 킴" });
    expect(queryClient.getQueryData<MeResponse>(qk.me)?.user.displayName).toBe("미아 킴");
    expect(queryClient.getQueryData<MeResponse>(qk.me)?.role).toBe("member");
  });

  it("표시 이름 저장이 실패하면 서버 문구를 칸 아래에 — 고쳐 치기 시작하면 지운다", async () => {
    stubServer(MEMBER, { patchMe: () => json(500, { code: "INTERNAL", message: "서버 내부 오류" }) });
    renderRoute("/settings/account");
    const page = await openAccount();
    const name = within(page).getByLabelText("표시 이름");
    await userEvent.type(name, "!");
    await userEvent.click(within(page).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(name).toHaveAccessibleDescription("서버 내부 오류"));

    await userEvent.type(name, "?");
    expect(name).not.toHaveAccessibleDescription("서버 내부 오류");
    expect(name).not.toHaveAttribute("aria-invalid", "true");
  });

  it("owner 에게는 비밀번호 칸 대신 로컬 토큰 안내", async () => {
    stubServer({ ...MEMBER, user: { ...MEMBER.user, handle: "owner" }, role: "owner" });
    renderRoute("/settings/account");
    const page = await openAccount();
    expect(within(page).queryByLabelText("현재 비밀번호")).not.toBeInTheDocument();
    expect(within(page).queryByLabelText("새 비밀번호")).not.toBeInTheDocument();
    expect(within(page).getByText(/owner 비밀번호는 로컬 토큰입니다/)).toHaveTextContent("LOCAL_AUTH_TOKEN");
  });

  it("틀린 현재 비밀번호(400 field current)는 서버 문구 대신 화면 문구를 현재 칸 아래에, 그 칸으로 초점 — 로그인 화면으로 가지 않는다(o1·o2)", async () => {
    stubServer(MEMBER, {
      password: () =>
        json(400, {
          code: "VALIDATION",
          message: "현재 비밀번호가 맞지 않는다",
          details: { field: "current" },
        }),
    });
    const { history } = renderRoute("/settings/account");
    const page = await openAccount();
    await userEvent.type(within(page).getByLabelText("현재 비밀번호"), "wrong-password-1");
    await userEvent.type(within(page).getByLabelText("새 비밀번호"), "correct-horse-battery");
    await userEvent.type(within(page).getByLabelText("새 비밀번호 확인"), "correct-horse-battery");
    await userEvent.click(within(page).getByRole("button", { name: "비밀번호 바꾸기" }));

    const current = within(page).getByLabelText("현재 비밀번호");
    await waitFor(() => expect(current).toHaveAccessibleDescription("현재 비밀번호가 맞지 않습니다"));
    expect(screen.queryByText("현재 비밀번호가 맞지 않는다")).not.toBeInTheDocument();
    expect(current).toHaveAttribute("aria-invalid", "true");
    expect(current).toHaveFocus();
    expect(history.location.pathname).toBe("/settings/account");
  });

  it("비밀번호 바꾸기가 실패하든 성공하든 뮤테이션 캐시 어디에도 현재·새 비밀번호가 없다", async () => {
    let calls = 0;
    stubServer(MEMBER, {
      password: () => {
        calls += 1;
        return calls === 1
          ? json(400, {
              code: "VALIDATION",
              message: "현재 비밀번호가 맞지 않는다",
              details: { field: "current" },
            })
          : new Response(null, { status: 204 });
      },
    });
    const { queryClient } = renderRoute("/settings/account");
    const page = await openAccount();
    await userEvent.type(within(page).getByLabelText("현재 비밀번호"), "wrong-password-1");
    await userEvent.type(within(page).getByLabelText("새 비밀번호"), "correct-horse-battery");
    await userEvent.type(within(page).getByLabelText("새 비밀번호 확인"), "correct-horse-battery");
    await userEvent.click(within(page).getByRole("button", { name: "비밀번호 바꾸기" }));
    await within(page).findByText("현재 비밀번호가 맞지 않습니다");
    await waitFor(() => expect(mutationStates(queryClient)).not.toContain("wrong-password-1"));
    expect(mutationStates(queryClient)).not.toContain("correct-horse-battery");

    const current = within(page).getByLabelText("현재 비밀번호");
    await userEvent.clear(current);
    await userEvent.type(current, "old-password-12");
    await userEvent.click(within(page).getByRole("button", { name: "비밀번호 바꾸기" }));
    await within(page).findByText("비밀번호를 바꿨습니다 — 다른 기기의 로그인은 끊겼습니다");
    await waitFor(() => expect(mutationStates(queryClient)).not.toContain("old-password-12"));
    expect(mutationStates(queryClient)).not.toContain("correct-horse-battery");
  });

  it("새 비밀번호 두 칸이 다르면 보내지 않는다", async () => {
    const password = vi.fn<Handler>(() => new Response(null, { status: 204 }));
    stubServer(MEMBER, { password });
    renderRoute("/settings/account");
    const page = await openAccount();
    await userEvent.type(within(page).getByLabelText("현재 비밀번호"), "old-password-12");
    await userEvent.type(within(page).getByLabelText("새 비밀번호"), "correct-horse-battery");
    await userEvent.type(within(page).getByLabelText("새 비밀번호 확인"), "correct-horse-batterx");
    await userEvent.click(within(page).getByRole("button", { name: "비밀번호 바꾸기" }));
    expect(await within(page).findByText("비밀번호가 서로 다릅니다")).toBeInTheDocument();
    expect(password).not.toHaveBeenCalled();
  });

  it("바꾸면 칸을 비우고 다른 기기의 로그인이 끊겼다고 알린다", async () => {
    const password = vi.fn<Handler>(() => new Response(null, { status: 204 }));
    stubServer(MEMBER, { password });
    renderRoute("/settings/account");
    const page = await openAccount();
    await userEvent.type(within(page).getByLabelText("현재 비밀번호"), "old-password-12");
    await userEvent.type(within(page).getByLabelText("새 비밀번호"), "correct-horse-battery");
    await userEvent.type(within(page).getByLabelText("새 비밀번호 확인"), "correct-horse-battery");
    await userEvent.click(within(page).getByRole("button", { name: "비밀번호 바꾸기" }));

    expect(
      await within(page).findByText("비밀번호를 바꿨습니다 — 다른 기기의 로그인은 끊겼습니다"),
    ).toBeInTheDocument();
    expect(password).toHaveBeenCalledWith({ current: "old-password-12", next: "correct-horse-battery" });
    expect(within(page).getByLabelText("현재 비밀번호")).toHaveValue("");
    expect(within(page).getByLabelText("새 비밀번호")).toHaveValue("");
  });
});
