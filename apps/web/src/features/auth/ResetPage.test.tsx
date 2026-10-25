import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ME, channelOf, json, renderRoute, shellGet } from "../../../test/shellApi";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const TOKEN = "drt_abcDEF123-_xyz";
const LOOKUP = { workspaceName: "도독 팀", kind: "reset" };

function stubServer({
  lookup = () => json(200, LOOKUP),
  reset = () => json(200, { sessionToken: "s", user: ME.user }),
}: {
  lookup?: () => Response;
  reset?: () => Response;
} = {}) {
  let loggedIn = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url === "/api/v1/invites/lookup") return lookup();
    if (url === "/api/v1/invites/reset") {
      const res = reset();
      if (res.ok) loggedIn = true;
      return res;
    }
    if (url === "/api/v1/auth/me")
      return loggedIn
        ? json(200, { ...ME, role: "member" })
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

async function fillPasswords(password: string, confirm = password) {
  await userEvent.type(await screen.findByLabelText("새 비밀번호"), password);
  await userEvent.type(screen.getByLabelText("비밀번호 확인"), confirm);
}

describe("ResetPage", () => {
  it("본문으로 조회한 워크스페이스 이름과 비밀번호 두 칸만 보인다", async () => {
    const fetch = stubServer();
    renderRoute(`/reset/${TOKEN}`);
    expect(await screen.findByRole("heading", { name: "도독 팀 비밀번호 재설정" })).toBeInTheDocument();
    expect(screen.getByLabelText("새 비밀번호")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.queryByLabelText("핸들")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("이메일")).not.toBeInTheDocument();
    expect(callsTo(fetch, "/invites/lookup")[0]?.[1]).toMatchObject({
      body: JSON.stringify({ token: TOKEN }),
    });
  });

  it("조회 404·가입 링크면 만료 안내", async () => {
    stubServer({ lookup: () => json(200, { workspaceName: "도독 팀", kind: "invite", role: "member" }) });
    renderRoute(`/reset/${TOKEN}`);
    expect(
      await screen.findByText("링크가 만료됐거나 이미 쓰였습니다 — 관리자에게 새 링크를 받으세요"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("새 비밀번호")).not.toBeInTheDocument();
  });

  it("두 칸이 다르면 보내지 않는다", async () => {
    const fetch = stubServer();
    renderRoute(`/reset/${TOKEN}`);
    await fillPasswords("correct-horse-battery", "correct-horse-batterx");
    await userEvent.click(screen.getByRole("button", { name: "비밀번호 바꾸기" }));
    expect(await screen.findByText("비밀번호가 서로 다릅니다")).toBeInTheDocument();
    expect(callsTo(fetch, "/invites/reset")).toHaveLength(0);
  });

  it("수락이 404 면 만료 안내로 바뀐다", async () => {
    stubServer({ reset: () => json(404, { code: "NOT_FOUND", message: "x" }) });
    renderRoute(`/reset/${TOKEN}`);
    await fillPasswords("correct-horse-battery");
    await userEvent.click(screen.getByRole("button", { name: "비밀번호 바꾸기" }));
    expect(await screen.findByText(/관리자에게 새 링크를 받으세요/)).toBeInTheDocument();
  });

  it("429 는 레이트리밋 문구 — 초대 버킷은 숫자를 말하지 않는다", async () => {
    stubServer({ reset: () => json(429, { code: "RATE_LIMITED", message: "Rate limit exceeded" }) });
    renderRoute(`/reset/${TOKEN}`);
    await fillPasswords("correct-horse-battery");
    await userEvent.click(screen.getByRole("button", { name: "비밀번호 바꾸기" }));
    expect(await screen.findByText("잠시 뒤 다시 시도하세요")).toBeInTheDocument();
  });

  it("성공하면 토큰을 주소에서 걷고 첫 채널로 간다", async () => {
    const fetch = stubServer();
    const { router, history } = renderRoute(`/reset/${TOKEN}`);
    await fillPasswords("correct-horse-battery");
    await userEvent.click(screen.getByRole("button", { name: "비밀번호 바꾸기" }));
    // 첫 채널 주소는 곧바로 그 채널의 최근 세션으로 넘어간다(app/router toLatestSession) — 기다리는 사이 지나칠 수 있어 둘 다 받는다
    await waitFor(() => expect(history.location.pathname).toMatch(/^\/c\/ch1(\/s\/ch1)?$/));
    expect(history.location.href).not.toContain(TOKEN);
    expect(router.history.canGoBack()).toBe(false);
    expect(JSON.parse(String(callsTo(fetch, "/invites/reset")[0]?.[1]?.body))).toEqual({
      token: TOKEN,
      password: "correct-horse-battery",
    });
  });
});
