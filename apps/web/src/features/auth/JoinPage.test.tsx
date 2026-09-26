import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { registerSessionReset } from "@/app/session";
import { ME, channelOf, json, renderRoute, shellGet } from "../../../test/shellApi";

// 등록한 세션 정리 스파이는 단언이 실패해도 다음 테스트로 새지 않게 여기서 푼다
const unregisters: Array<() => void> = [];
afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TOKEN = "dit_abcDEF123-_xyz";
const LOOKUP = { workspaceName: "도독 팀", kind: "invite", role: "member" };
const NEW_USER = { id: "u2", handle: "mia", displayName: "미아" };
const OLD_USER = { id: "u1", handle: "alice", displayName: "앨리스" };

/**
 * lookup·accept 를 가르는 가짜 서버. accept 가 2xx 면 그 뒤 me 는 새 사용자(쿠키가 구워진 것처럼),
 * 셸이 부르는 채널 목록은 `ch1` 하나 — 첫 채널로 가는지 본다
 */
function stubServer({
  lookup = () => json(200, LOOKUP),
  accept = () => json(200, { sessionToken: "s", user: NEW_USER }),
  before,
}: {
  lookup?: (body: unknown) => Response | Promise<Response>;
  accept?: (body: unknown) => Response | Promise<Response>;
  /** 수락 전에 이 브라우저가 로그인해 있던 사용자 — 없으면 me 는 401 */
  before?: typeof OLD_USER;
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
        : before
          ? json(200, { ...ME, user: before, role: "member" })
          : json(401, { code: "UNAUTHORIZED", message: "x" });
    if (url === "/api/v1/channels") return json(200, { channels: [channelOf("ch1")] });
    const shell = shellGet(input, init);
    if (shell) return shell;
    throw new Error(`예상 밖 요청 ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const mutationStates = (queryClient: ReturnType<typeof createQueryClient>) =>
  JSON.stringify(
    queryClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state),
  );

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

  it("쿼리 캐시의 키·해시 어디에도 토큰 원문이 없고, 화면을 떠나면 조회 결과가 캐시에서 빠진다", async () => {
    stubServer();
    const { router, queryClient } = renderRoute(`/join/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: "도독 팀에 가입" })).toBeInTheDocument();
    const keys = () =>
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => [q.queryKey, q.queryHash]);
    expect(keys().some(([key]) => (key as unknown[])[0] === "inviteLookup")).toBe(true);
    expect(JSON.stringify(keys())).not.toContain(TOKEN);

    await router.navigate({ to: "/login" });
    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    await waitFor(() => expect(keys().some(([key]) => (key as unknown[])[0] === "inviteLookup")).toBe(false));
  });

  it("같은 화면에서 토큰이 바뀌면 새 토큰으로 다시 조회한다", async () => {
    const fetch = stubServer({
      lookup: (body) =>
        json(200, {
          ...LOOKUP,
          workspaceName: (body as { token: string }).token === TOKEN ? "도독 팀" : "다른 팀",
        }),
    });
    const { router } = renderRoute(`/join/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: "도독 팀에 가입" })).toBeInTheDocument();
    await router.navigate({ to: "/join/$token", params: { token: "dit_other" } });
    expect(await screen.findByRole("heading", { name: "다른 팀에 가입" })).toBeInTheDocument();
    expect(callsTo(fetch, "/invites/lookup").map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { token: TOKEN },
      { token: "dit_other" },
    ]);
  });

  it("조회 404 는 무효 화면만 — 전역 토스트가 겹치지 않는다", async () => {
    const toastError = vi.spyOn(toast, "error").mockImplementation(() => 0);
    stubServer({
      lookup: () => json(404, { code: "NOT_FOUND", message: "초대가 만료됐거나 이미 쓰였습니다" }),
    });
    renderRoute(`/join/${TOKEN}`);
    expect(await screen.findByText(/초대한 사람에게 새 링크를 받으세요/)).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("조회가 429 면 레이트리밋 문구와 「다시 시도」 — 초대 버킷은 숫자를 말하지 않는다", async () => {
    stubServer({ lookup: () => json(429, { code: "RATE_LIMITED", message: "Rate limit exceeded" }) });
    renderRoute(`/join/${TOKEN}`);
    expect(await screen.findByText("잠시 뒤 다시 시도하세요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeInTheDocument();
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

  it("409 는 서버 문구 대신 화면 문구를 서버가 가리킨 칸(핸들·이메일) 아래에 — 그 칸으로 초점이 가고, 고치면 지우고 다시 보낼 수 있다(o1·o2)", async () => {
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
    expect(await screen.findByText("이 핸들은 이미 쓰이고 있습니다")).toBeInTheDocument();
    expect(screen.queryByText("handle @dev 는 이미 쓰이고 있다")).not.toBeInTheDocument();
    expect(handle).toHaveAttribute("aria-invalid", "true");
    expect(handle).toHaveAccessibleDescription("이 핸들은 이미 쓰이고 있습니다");
    expect(handle).toHaveFocus();
    // 비밀번호는 지우지 않는다 — 핸들만 고쳐 다시 보낸다
    expect(screen.getByLabelText("비밀번호")).toHaveValue("correct-horse-battery");

    await userEvent.type(handle, "2");
    expect(screen.queryByText("이 핸들은 이미 쓰이고 있습니다")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "가입" }));
    const email = screen.getByLabelText("이메일");
    await waitFor(() => expect(email).toHaveAccessibleDescription("이 이메일은 이미 가입돼 있습니다"));
    expect(email).toHaveFocus();
    expect(callsTo(fetch, "/invites/accept")).toHaveLength(2);
    expect(JSON.parse(String(callsTo(fetch, "/invites/accept")[1]?.[1]?.body))).toEqual({
      token: TOKEN,
      handle: "dev2",
      displayName: "미아",
      email: "mia@example.com",
      password: "correct-horse-battery",
    });
  });

  it("예약된 핸들(left- 로 시작, 400 VALIDATION)도 화면 문구로", async () => {
    const fetch = stubServer({
      accept: () =>
        json(400, {
          code: "VALIDATION",
          message: "handle 은 left- 로 시작할 수 없다",
          details: { field: "handle" },
        }),
    });
    renderRoute(`/join/${TOKEN}`);
    await fillForm({ 핸들: "left-x" });
    await userEvent.click(screen.getByRole("button", { name: "가입" }));
    const handle = screen.getByLabelText("핸들");
    expect(await screen.findByText("이 핸들은 쓸 수 없습니다")).toBeInTheDocument();
    expect(handle).toHaveAccessibleDescription("이 핸들은 쓸 수 없습니다");
    expect(handle).toHaveFocus();
    expect(callsTo(fetch, "/invites/accept")).toHaveLength(1);
  });

  it("409 로 폼에 머무는 동안에도 뮤테이션 캐시 어디에도 비밀번호·토큰이 없다", async () => {
    stubServer({
      accept: () =>
        json(409, { code: "CONFLICT", message: "이미 가입된 이메일입니다", details: { field: "email" } }),
    });
    const queryClient = createQueryClient(() => {});
    renderRoute(`/join/${TOKEN}`, queryClient);
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "가입" }));
    await waitFor(() =>
      expect(screen.getByLabelText("이메일")).toHaveAccessibleDescription("이 이메일은 이미 가입돼 있습니다"),
    );
    await waitFor(() => expect(mutationStates(queryClient)).not.toContain("correct-horse-battery"));
    expect(mutationStates(queryClient)).not.toContain(TOKEN);
    // 칸 값은 남는다 — 고쳐 다시 보낸다
    expect(screen.getByLabelText("비밀번호")).toHaveValue("correct-horse-battery");
  });

  // type="email" 칸은 브라우저(jsdom 도)가 값의 앞뒤 공백을 이미 떼므로(HTML 값 정리 규칙) 폼의 trim() 은 겹 방어다 —
  // 이 테스트는 그 trim 을 따로 잠그지 못하고, 사람이 보는 결과(공백이 서버로 가지 않는다)만 본다
  it("이메일 앞뒤 공백은 서버로 가지 않는다", async () => {
    const fetch = stubServer();
    const { history } = renderRoute(`/join/${TOKEN}`);
    await fillForm({ 이메일: "  mia@example.com  " });
    await userEvent.click(screen.getByRole("button", { name: "가입" }));
    await waitFor(() => expect(history.location.pathname).toBe("/c/ch1"));
    expect(JSON.parse(String(callsTo(fetch, "/invites/accept")[0]?.[1]?.body))).toMatchObject({
      email: "mia@example.com",
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

  it("429 는 폼 안에 레이트리밋 문구 — 초대 버킷은 숫자를 말하지 않는다", async () => {
    stubServer({ accept: () => json(429, { code: "RATE_LIMITED", message: "Rate limit exceeded" }) });
    renderRoute(`/join/${TOKEN}`);
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "가입" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("잠시 뒤 다시 시도하세요");
    expect(screen.getByRole("alert")).not.toHaveTextContent("5회");
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

  it("다른 계정으로 로그인해 있던 브라우저에서 가입하면 앞 사용자의 상태를 비우고 me 는 새 사용자다", async () => {
    stubServer({ before: OLD_USER });
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData(qk.me, { ...ME, user: OLD_USER, role: "member" });
    const reset = vi.fn();
    unregisters.push(registerSessionReset(reset));
    const { history } = renderRoute(`/join/${TOKEN}`, queryClient);
    await fillForm();
    await userEvent.click(screen.getByRole("button", { name: "가입" }));

    await waitFor(() => expect(history.location.pathname).toBe("/c/ch1"));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData<{ user: { id: string } }>(qk.me)?.user.id).toBe("u2");
  });

  it("이미 로그인한 채 초대 링크를 열면 폼 위에 지금 계정과 바뀐다는 것을 한 줄로 알린다", async () => {
    stubServer({ before: OLD_USER });
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData(qk.me, { ...ME, user: OLD_USER, role: "member" });
    renderRoute(`/join/${TOKEN}`, queryClient);
    expect(
      await screen.findByText(
        "지금 @alice 로 로그인돼 있습니다 — 가입하면 이 브라우저는 새 계정으로 바뀝니다",
      ),
    ).toBeInTheDocument();
  });

  it("로그인하지 않았으면 계정 안내 줄이 없다", async () => {
    stubServer();
    renderRoute(`/join/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: "도독 팀에 가입" })).toBeInTheDocument();
    expect(screen.queryByText(/로그인돼 있습니다/)).not.toBeInTheDocument();
  });

  it("390px 폭에서도 폼이 화면 폭을 넘지 않게 w-full·max-w 로만 잡는다", async () => {
    stubServer();
    renderRoute(`/join/${TOKEN}`);
    const form = (await screen.findByRole("heading", { name: "도독 팀에 가입" })).closest("form");
    expect(form).toHaveClass("w-full", "max-w-sm");
    expect(within(form as HTMLElement).getByRole("button", { name: "가입" })).toBeInTheDocument();
  });
});
