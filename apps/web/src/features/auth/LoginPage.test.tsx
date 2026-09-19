import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";

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
    throw new Error(`예상 밖 요청 ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderAt(path: string, queryClient: QueryClient = createQueryClient(() => {})) {
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

async function submitToken(token: string) {
  const input = await screen.findByLabelText("로컬 토큰");
  await userEvent.type(input, `${token}{Enter}`);
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

describe("LoginPage", () => {
  it("토큰 입력은 password 이고, 틀린 토큰(401)이면 「토큰이 맞지 않습니다」", async () => {
    stubServer(() => json(401, { code: "UNAUTHORIZED", message: "토큰이 맞지 않는다" }));
    const router = renderAt("/login?next=%2Fagents");
    const input = await submitToken("wrong");
    expect(input).toHaveAttribute("type", "password");
    expect(await screen.findByText("토큰이 맞지 않습니다")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
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
    expect(screen.getByRole("button", { name: "로그인" })).toBeDisabled(); // 입력이 비어 있다
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
    expect(screen.getByRole("button", { name: "로그인" })).toBeInTheDocument();
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
