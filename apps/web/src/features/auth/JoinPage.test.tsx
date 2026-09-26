import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { ME, channelOf, json, renderRoute, shellGet } from "../../../test/shellApi";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TOKEN = "dit_abcDEF123-_xyz";
const LOOKUP = { workspaceName: "도독 팀", kind: "invite", role: "member" };
const NEW_USER = { id: "u2", handle: "mia", displayName: "미아" };

/**
 * lookup·accept 를 가르는 가짜 서버. accept 가 2xx 면 그 뒤 me 는 새 사용자(쿠키가 구워진 것처럼),
 * 셸이 부르는 채널 목록은 `ch1` 하나 — 첫 채널로 가는지 본다
 */
function stubServer({
  lookup = () => json(200, LOOKUP),
  accept = () => json(200, { sessionToken: "s", user: NEW_USER }),
}: {
  lookup?: (body: unknown) => Response | Promise<Response>;
  accept?: (body: unknown) => Response | Promise<Response>;
} = {}) {
  let loggedIn = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === "/api/v1/invites/lookup") return lookup(body);
    if (url === "/api/v1/invites/accept") {
      const res = await accept(body);
      if (res.ok) loggedIn = true;
      return res;
    }
    if (url === "/api/v1/auth/me")
      return loggedIn
        ? json(200, { ...ME, user: NEW_USER, role: "member" })
        : json(401, { code: "UNAUTHORIZED", message: "x" });
    if (url === "/api/v1/channels") return json(200, { channels: [channelOf("ch1")] });
    const shell = shellGet(input, init);
    if (shell) return shell;
    throw new Error(`예상 밖 요청 ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const callsTo = (fetch: ReturnType<typeof stubServer>, path: string) =>
  fetch.mock.calls.filter(([url]) => String(url) === `/api/v1${path}`);

async function fillForm(over: Partial<Record<string, string>> = {}) {
  const values = {
    핸들: "mia",
    "표시 이름": "미아",
    이메일: "mia@example.com",
    비밀번호: "correct-horse-battery",
    "비밀번호 확인": "correct-horse-battery",
    ...over,
  };
  for (const [label, value] of Object.entries(values)) {
    const input = await screen.findByLabelText(label);
    await userEvent.clear(input);
    if (value !== "") await userEvent.type(input, value);
  }
}

describe("JoinPage", () => {
  it("토큰은 URL 이 아니라 본문으로 조회하고, 워크스페이스 이름·역할을 보인다", async () => {
    const fetch = stubServer();
    renderRoute(`/join/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: "도독 팀에 가입" })).toBeInTheDocument();
    expect(screen.getByText("멤버로 초대받았습니다")).toBeInTheDocument();
    const [lookup] = callsTo(fetch, "/invites/lookup");
    expect(lookup?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ token: TOKEN }) });
    expect(fetch.mock.calls.some(([url]) => String(url).includes(TOKEN))).toBe(false);
  });

  it("admin 초대면 「관리자로 초대받았습니다」", async () => {
    stubServer({ lookup: () => json(200, { ...LOOKUP, role: "admin" }) });
    renderRoute(`/join/${TOKEN}`);
    expect(await screen.findByText("관리자로 초대받았습니다")).toBeInTheDocument();
  });

  it("조회가 404 면 폼 대신 만료 안내", async () => {
    stubServer({
      lookup: () => json(404, { code: "NOT_FOUND", message: "초대가 만료됐거나 이미 쓰였습니다" }),
    });
    renderRoute(`/join/${TOKEN}`);
    expect(
      await screen.findByText("초대가 만료됐거나 이미 쓰였습니다 — 초대한 사람에게 새 링크를 받으세요"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("핸들")).not.toBeInTheDocument();
  });

  it("재설정 링크를 가입 주소로 열면 만료 안내와 같다", async () => {
    stubServer({ lookup: () => json(200, { workspaceName: "도독 팀", kind: "reset" }) });
    renderRoute(`/join/${TOKEN}`);
    expect(await screen.findByText(/초대가 만료됐거나 이미 쓰였습니다/)).toBeInTheDocument();
    expect(screen.queryByLabelText("핸들")).not.toBeInTheDocument();
  });

  it("조회가 네트워크 실패면 「다시 시도」로 다시 조회한다", async () => {
    let calls = 0;
    stubServer({
      lookup: () => {
        calls += 1;
        if (calls === 1) throw new TypeError("Failed to fetch");
        return json(200, LOOKUP);
      },
    });
    renderRoute(
      `/join/${TOKEN}`,
      createQueryClient(() => {}),
    );
    await userEvent.click(await screen.findByRole("button", { name: "다시 시도" }, { timeout: 5000 }));
    expect(await screen.findByRole("heading", { name: "도독 팀에 가입" })).toBeInTheDocument();
  });

  it("비밀번호 두 칸이 다르면 보내지 않고 확인 칸 아래에 알린다", async () => {
    const fetch = stubServer();
    renderRoute(`/join/${TOKEN}`);
    await fillForm({ "비밀번호 확인": "correct-horse-batterx" });
    await userEvent.click(screen.getByRole("button", { name: "가입" }));
    expect(await screen.findByText("비밀번호가 서로 다릅니다")).toBeInTheDocument();
    expect(screen.getByLabelText("비밀번호 확인")).toHaveAttribute("aria-invalid", "true");
    expect(callsTo(fetch, "/invites/accept")).toHaveLength(0);
  });

  it("칸 규칙(핸들·이메일·12자 비밀번호)을 어기면 보내지 않는다", async () => {
    const fetch = stubServer();
    renderRoute(`/join/${TOKEN}`);
    await fillForm({ 핸들: "Mia!", 이메일: "mia", 비밀번호: "short", "비밀번호 확인": "short" });
    await userEvent.click(screen.getByRole("button", { name: "가입" }));
    expect(await screen.findByText("영문 소문자·숫자·_·- 로 2~32자")).toBeInTheDocument();
    expect(screen.getByText("이메일 모양이 아닙니다")).toBeInTheDocument();
    expect(screen.getByText("비밀번호는 12자 이상입니다")).toBeInTheDocument();
    expect(callsTo(fetch, "/invites/accept")).toHaveLength(0);
  });

  it("409 는 서버가 가리킨 칸(핸들·이메일) 아래에 — 고치면 지우고 다시 보낼 수 있다", async () => {
    let calls = 0;
    const fetch = stubServer({
      accept: () => {
        calls += 1;
        return calls === 1
          ? json(409, {
              code: "CONFLICT",
              message: "handle @dev 는 이미 쓰이고 있다",
              details: { field: "handle" },
            })
          : json(409, { code: "CONFLICT", message: "이미 가입된 이메일입니다", details: { field: "email" } });
      },
    });
    renderRoute(`/join/${TOKEN}`);
    await fillForm({ 핸들: "dev" });
    await userEvent.click(screen.getByRole("button", { name: "가입" }));

    const handle = screen.getByLabelText("핸들");
    expect(await screen.findByText("handle @dev 는 이미 쓰이고 있다")).toBeInTheDocument();
    expect(handle).toHaveAttribute("aria-invalid", "true");
    expect(handle).toHaveAccessibleDescription("handle @dev 는 이미 쓰이고 있다");
    // 비밀번호는 지우지 않는다 — 핸들만 고쳐 다시 보낸다
    expect(screen.getByLabelText("비밀번호")).toHaveValue("correct-horse-battery");

    await userEvent.type(handle, "2");
    expect(screen.queryByText("handle @dev 는 이미 쓰이고 있다")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "가입" }));
    const email = screen.getByLabelText("이메일");
    await waitFor(() => expect(email).toHaveAccessibleDescription("이미 가입된 이메일입니다"));
    expect(callsTo(fetch, "/invites/accept")).toHaveLength(2);
    expect(JSON.parse(String(callsTo(fetch, "/invites/accept")[1]?.[1]?.body))).toEqual({
      token: TOKEN,
      handle: "dev2",
      displayName: "미아",
      email: "mia@example.com",
      password: "correct-horse-battery",
    });
  });

  it("수락이 404(그 사이 다른 쪽이 씀)면 만료 안내로 바뀐다", async () => {
    stubServer({
      accept: () => json(404, { code: "NOT_FOUND", message: "초대가 만료됐거나 이미 쓰였습니다" }),
    });
    renderRoute(`/join/${TOKEN}`);
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "가입" }));
    expect(await screen.findByText(/초대한 사람에게 새 링크를 받으세요/)).toBeInTheDocument();
    expect(screen.queryByLabelText("핸들")).not.toBeInTheDocument();
  });

  it("429 는 폼 안에 레이트리밋 문구", async () => {
    stubServer({ accept: () => json(429, { code: "RATE_LIMITED", message: "Rate limit exceeded" }) });
    renderRoute(`/join/${TOKEN}`);
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "가입" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("잠시 뒤 다시 시도하세요(1분 5회)");
  });

  it("성공하면 주소에서 토큰이 사라지고(replace) 로그인된 채로 첫 채널로 간다", async () => {
    const fetch = stubServer();
    const { router, history, queryClient } = renderRoute(`/join/${TOKEN}`);
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "가입" }));

    await waitFor(() => expect(history.location.pathname).toBe("/c/ch1"));
    expect(history.location.href).not.toContain(TOKEN);
    // 가입 화면 항목을 갈아 끼웠다 — 뒤로 가기로 토큰 주소에 돌아가지 않는다
    expect(router.history.canGoBack()).toBe(false);
    expect(queryClient.getQueryData<{ user: { id: string } }>(qk.me)?.user.id).toBe("u2");
    expect(callsTo(fetch, "/invites/accept")).toHaveLength(1);
    // 토큰·비밀번호가 끝난 뮤테이션 상태에 남지 않는다
    await waitFor(() =>
      expect(
        JSON.stringify(
          queryClient
            .getMutationCache()
            .getAll()
            .map((m) => m.state),
        ),
      ).not.toContain("correct-horse-battery"),
    );
  });

  it("390px 폭에서도 폼이 화면 폭을 넘지 않게 w-full·max-w 로만 잡는다", async () => {
    stubServer();
    renderRoute(`/join/${TOKEN}`);
    const form = (await screen.findByRole("heading", { name: "도독 팀에 가입" })).closest("form");
    expect(form).toHaveClass("w-full", "max-w-sm");
    expect(within(form as HTMLElement).getByRole("button", { name: "가입" })).toBeInTheDocument();
  });
});
