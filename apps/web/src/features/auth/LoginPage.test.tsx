import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { TooltipProvider } from "@/ui/tooltip";
import { shellGet } from "../../../test/shellApi";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ME = { user: { id: "u", handle: "owner" }, workspaceId: "w" };

/**
 * URL 로 가르는 가짜 서버. `/auth/local` 이 2xx 를 돌려주면 그 뒤 `/auth/me` 는 200 —
 * `cookieSticks: false` 면 로그인은 200 인데 쿠키가 안 구워진 것처럼 me 가 계속 401
 */
function stubServer(
  login: (body: unknown) => Response | Promise<Response>,
  { loggedIn = false, cookieSticks = true } = {},
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url === "/api/v1/auth/me")
      return loggedIn ? json(200, ME) : json(401, { code: "UNAUTHORIZED", message: "x" });
    if (url === "/api/v1/auth/local") {
      const res = await login(JSON.parse(String(init?.body)));
      if (res.ok && cookieSticks) loggedIn = true;
      return res;
    }
    // 로그인 뒤 셸(사이드바·배너)이 부르는 조회는 기본 응답
    const shell = shellGet(input, init);
    if (shell) return shell;
    throw new Error(`예상 밖 요청 ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderAt(path: string, queryClient: QueryClient = createQueryClient(() => {})) {
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      {/* App 과 같은 Provider — 로그인 뒤 셸의 연결 상태 점이 Tooltip 을 쓴다 */}
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

/** 접힌 토큰 폼을 (닫혀 있으면) 펼치고 토큰을 넣어 Enter */
async function submitToken(token: string) {
  const toggle = await screen.findByRole("button", { name: "owner 로컬 토큰으로 로그인" });
  if (toggle.getAttribute("aria-expanded") !== "true") await userEvent.click(toggle);
  const input = await screen.findByLabelText("로컬 토큰");
  await userEvent.type(input, `${token}{Enter}`);
  return input;
}

async function submitEmail(email: string, password: string) {
  await userEvent.type(await screen.findByLabelText("이메일"), email);
  const input = screen.getByLabelText("비밀번호");
  await userEvent.type(input, `${password}{Enter}`);
  return input;
}

/** 뮤테이션 캐시에 남은 모든 상태(variables·data 포함)를 문자열로 */
const mutationStates = (qc: QueryClient) =>
  JSON.stringify(
    qc
      .getMutationCache()
      .getAll()
      .map((m) => m.state),
  );

describe("LoginPage — 이메일·비밀번호(기본)", () => {
  it("기본은 이메일·비밀번호 폼이고 토큰 칸은 접혀 있다", async () => {
    stubServer(() => json(401, {}));
    renderAt("/login");
    expect(await screen.findByLabelText("이메일")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("비밀번호")).toHaveAttribute("type", "password");
    expect(screen.queryByLabelText("로컬 토큰")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "owner 로컬 토큰으로 로그인" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("401 이면 서버 문구(해라체) 대신 화면 문구(합쇼체)로 — 비밀번호 칸만 비우고 이메일은 남긴다(o1)", async () => {
    const fetch = stubServer(() =>
      json(401, { code: "UNAUTHORIZED", message: "이메일 또는 비밀번호가 맞지 않는다" }),
    );
    const router = renderAt("/login");
    const password = await submitEmail("mia@example.com", "wrong-password");
    expect(await screen.findByRole("alert")).toHaveTextContent("이메일 또는 비밀번호가 맞지 않습니다");
    expect(password).toHaveValue("");
    expect(screen.getByLabelText("이메일")).toHaveValue("mia@example.com");
    expect(router.state.location.pathname).toBe("/login");
    const login = fetch.mock.calls.find(([url]) => String(url) === "/api/v1/auth/local");
    expect(JSON.parse(String(login?.[1]?.body))).toEqual({
      email: "mia@example.com",
      password: "wrong-password",
    });
  });

  it.each([
    ["401", json(401, { code: "UNAUTHORIZED", message: "x" })],
    ["429", json(429, { code: "RATE_LIMITED", message: "Rate limit exceeded" })],
  ])(
    "실패(%s) 뒤 초점은 비워진 비밀번호 칸으로 — 비활성이 된 「로그인」 버튼과 함께 body 로 떨어지지 않게(n1)",
    async (_code, reply) => {
      stubServer(() => reply);
      renderAt("/login");
      await userEvent.type(await screen.findByLabelText("이메일"), "mia@example.com");
      const password = screen.getByLabelText("비밀번호");
      await userEvent.type(password, "wrong-password");
      await userEvent.click(screen.getByRole("button", { name: "로그인" }));
      await screen.findByRole("alert");
      await waitFor(() => expect(password).toHaveFocus());
    },
  );

  it("429 면 레이트리밋 문구", async () => {
    stubServer(() => json(429, { code: "RATE_LIMITED", message: "Rate limit exceeded" }));
    renderAt("/login");
    await submitEmail("mia@example.com", "pw");
    expect(await screen.findByText("잠시 뒤 다시 시도하세요(1분 5회)")).toBeInTheDocument();
  });

  it("성공하면 next 로 가고 비밀번호가 뮤테이션 캐시에 남지 않는다", async () => {
    stubServer(() => json(200, { sessionToken: "session-secret", user: ME.user }));
    const queryClient = createQueryClient(() => {});
    const router = renderAt("/login?next=%2Fagents", queryClient);
    await submitEmail("mia@example.com", "correct-horse-battery");
    expect(await screen.findByTestId("page-agents")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/agents");
    await waitFor(() => expect(mutationStates(queryClient)).not.toContain("correct-horse-battery"));
  });

  it("토큰 폼을 펼치면 토큰 칸에 초점이 가고, 다시 접을 수 있다", async () => {
    stubServer(() => json(401, {}));
    renderAt("/login");
    const toggle = await screen.findByRole("button", { name: "owner 로컬 토큰으로 로그인" });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("로컬 토큰")).toHaveFocus();
    await userEvent.click(toggle);
    expect(screen.queryByLabelText("로컬 토큰")).not.toBeInTheDocument();
  });
});

describe("LoginPage — owner 로컬 토큰(접힘)", () => {
  it("토큰 입력은 password 이고, 틀린 토큰(401)이면 「토큰이 맞지 않습니다」", async () => {
    stubServer(() => json(401, { code: "UNAUTHORIZED", message: "토큰이 맞지 않는다" }));
    const router = renderAt("/login?next=%2Fagents");
    const input = await submitToken("wrong");
    expect(input).toHaveAttribute("type", "password");
    expect(await screen.findByText("토큰이 맞지 않습니다")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("실패 뒤 초점은 비워진 토큰 칸으로 — 비활성이 된 버튼과 함께 body 로 떨어지지 않게(n1)", async () => {
    stubServer(() => json(401, { code: "UNAUTHORIZED", message: "x" }));
    renderAt("/login");
    await userEvent.click(await screen.findByRole("button", { name: "owner 로컬 토큰으로 로그인" }));
    const input = screen.getByLabelText("로컬 토큰");
    await userEvent.type(input, "wrong");
    await userEvent.click(screen.getByRole("button", { name: "토큰으로 로그인" }));
    await screen.findByText("토큰이 맞지 않습니다");
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("429 면 레이트리밋 문구", async () => {
    stubServer(() => json(429, { code: "RATE_LIMITED", message: "Rate limit exceeded" }));
    renderAt("/login");
    await submitToken("t");
    expect(await screen.findByText("잠시 뒤 다시 시도하세요(1분 5회)")).toBeInTheDocument();
  });

  it("그 밖의 오류는 서버 message, 네트워크 실패는 「서버에 연결할 수 없습니다」 — 전역 토스트는 없다", async () => {
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => 0);
    let calls = 0;
    stubServer(() => {
      calls += 1;
      if (calls === 1) return json(500, { code: "INTERNAL", message: "서버 내부 오류" });
      throw new TypeError("Failed to fetch");
    });
    renderAt("/login");
    await submitToken("t");
    expect(await screen.findByText("서버 내부 오류")).toBeInTheDocument();
    await submitToken("t");
    expect(await screen.findByText("서버에 연결할 수 없습니다")).toBeInTheDocument();
    expect(screen.queryByText("서버 내부 오류")).not.toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled(); // 로그인은 폼 안에서만 알린다(meta.silent)
  });

  it("Enter 로 제출하면 토큰을 보내고 입력을 비운다 — 제출 중에는 버튼이 비활성", async () => {
    let answer: (res: Response) => void = () => {};
    const fetch = stubServer(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderAt("/login");
    const input = await submitToken("secret-token");

    expect(await screen.findByRole("button", { name: "로그인 중…" })).toBeDisabled();
    expect(input).toHaveValue("");
    const login = fetch.mock.calls.find(([url]) => String(url) === "/api/v1/auth/local");
    expect(login?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ token: "secret-token" }) });

    answer(json(401, { code: "UNAUTHORIZED", message: "x" }));
    expect(await screen.findByText("토큰이 맞지 않습니다")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "토큰으로 로그인" })).toBeDisabled(); // 입력이 비어 있다
  });

  it("성공하면 /auth/me 를 다시 불러 next 로 간다", async () => {
    const fetch = stubServer(() => json(200, { sessionToken: "s", user: ME.user }));
    const router = renderAt("/login?next=%2Fagents");
    await submitToken("right");
    expect(await screen.findByTestId("page-agents")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/agents");
    const meCalls = fetch.mock.calls.filter(([url]) => String(url) === "/api/v1/auth/me");
    expect(meCalls.length).toBeGreaterThanOrEqual(2); // 로그인 전 401 → 로그인 뒤 200
  });

  it("next 가 다른 출처면 버리고 / 로 간다", async () => {
    stubServer(() => json(200, { sessionToken: "s", user: ME.user }));
    const router = renderAt("/login?next=%2F%2Fevil.example");
    await submitToken("right");
    expect(await screen.findByTestId("page-home")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("로그인은 200 인데 세션을 확인하지 못하면(me 가 계속 401) 폼에 알린다", async () => {
    stubServer(() => json(200, { sessionToken: "s", user: ME.user }), { cookieSticks: false });
    const router = renderAt("/login?next=%2Fagents");
    await submitToken("right");
    expect(await screen.findByText("로그인했지만 세션을 확인하지 못했습니다")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(screen.getByRole("button", { name: "토큰으로 로그인" })).toBeInTheDocument();
  });

  it("이미 로그인돼 있으면 / 로 보낸다", async () => {
    stubServer(() => json(500, {}), { loggedIn: true });
    const router = renderAt("/login");
    expect(await screen.findByTestId("page-home")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  describe("토큰은 끝난 뮤테이션 상태에 남지 않는다", () => {
    it("성공 — next 로 간 뒤 뮤테이션 캐시 어디에도 토큰이 없다", async () => {
      stubServer(() => json(200, { sessionToken: "session-secret", user: ME.user }));
      const queryClient = createQueryClient(() => {});
      renderAt("/login?next=%2Fagents", queryClient);
      await submitToken("secret-token");
      expect(await screen.findByTestId("page-agents")).toBeInTheDocument();
      await waitFor(() => expect(mutationStates(queryClient)).not.toContain("secret-token"));
      expect(mutationStates(queryClient)).not.toContain("session-secret");
    });

    it("실패(401) — 로그인 화면에 머문 채로도 뮤테이션 캐시 어디에도 토큰이 없다", async () => {
      stubServer(() => json(401, { code: "UNAUTHORIZED", message: "x" }));
      const queryClient = createQueryClient(() => {});
      renderAt("/login", queryClient);
      await submitToken("secret-token");
      expect(await screen.findByText("토큰이 맞지 않습니다")).toBeInTheDocument();
      await waitFor(() => expect(mutationStates(queryClient)).not.toContain("secret-token"));
      expect(screen.getByText("토큰이 맞지 않습니다")).toBeInTheDocument(); // 비운 뒤에도 문구는 남는다
    });
  });
});
