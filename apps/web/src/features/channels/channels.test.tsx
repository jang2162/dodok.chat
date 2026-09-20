import type { Channel } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { ME, channelOf, json, renderRoute, shellGet } from "../../../test/shellApi";

type Body = Record<string, unknown>;
type Reply = Response | Promise<Response>;

/** 채널 목록을 서버 상태로 들고 있는 가짜 서버. POST 기본 처리기는 목록에 더하고 201 `{ channel }` */
function stubServer(opts: { channels?: Channel[]; create?: (body: Body) => Reply } = {}) {
  const state = [...(opts.channels ?? [])];
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: Body | undefined = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body });
    if (url === "/api/v1/auth/me") return json(200, ME);
    if (method === "GET" && url === "/api/v1/channels") return json(200, { channels: state });
    if (method === "POST" && url === "/api/v1/channels") {
      if (opts.create) return opts.create(body ?? {});
      const channel = channelOf(`new-${state.length + 1}`, body);
      state.push(channel);
      return json(201, { channel });
    }
    const m = /^\/api\/v1\/channels\/([^/]+)$/.exec(url);
    if (method === "GET" && m) {
      const channel = state.find((c) => c.id === m[1]);
      return channel
        ? json(200, { channel })
        : json(404, { code: "NOT_FOUND", message: "channel not found" });
    }
    return (
      shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: `예상 밖 요청 ${method} ${url}` })
    );
  });
  vi.stubGlobal("fetch", fetch);
  return {
    count: (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length,
    bodies: (method: string, url: string) =>
      calls.filter((c) => c.method === method && c.url === url).map((c) => c.body),
  };
}

const A = channelOf("a", { name: "general" });
const B = channelOf("b", { name: "random", topic: "잡담" });

const channelNav = () => screen.findByRole("navigation", { name: "채널" });

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChannelList", () => {
  it("채널 이름을 링크로 그리고 지금 채널(설정 패널이 열려 있어도)에 aria-current=page", async () => {
    stubServer({ channels: [A, B] });
    renderRoute("/c/b/settings");
    const nav = await channelNav();
    const general = await within(nav).findByRole("link", { name: /general/ });
    const random = within(nav).getByRole("link", { name: /random/ });
    expect(general).toHaveAttribute("href", "/c/a");
    expect(random).toHaveAttribute("href", "/c/b");
    expect(random).toHaveAttribute("aria-current", "page");
    expect(general).not.toHaveAttribute("aria-current");
  });
});

describe("CreateChannelDialog", () => {
  it("이름이 비면(공백뿐이어도) 만들기 버튼이 비활성", async () => {
    stubServer();
    renderRoute("/");
    await userEvent.click(await within(await channelNav()).findByRole("button", { name: "채널 만들기" }));
    const dialog = await screen.findByRole("dialog", { name: "채널 만들기" });
    const submit = within(dialog).getByRole("button", { name: "만들기" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("이름"), "   ");
    expect(submit).toBeDisabled();
  });

  it('제출하면 POST /channels → ["channels"] 에 넣고(다시 불러오지 않음) /c/<id>/settings 로 간다', async () => {
    const server = stubServer({ channels: [A] });
    const { router, queryClient } = renderRoute("/c/a");
    const nav = await channelNav();
    await within(nav).findByRole("link", { name: /general/ });
    await userEvent.click(within(nav).getByRole("button", { name: "채널 만들기" }));
    const dialog = await screen.findByRole("dialog", { name: "채널 만들기" });
    await userEvent.type(within(dialog).getByLabelText("이름"), "  dev-talk ");
    await userEvent.type(within(dialog).getByLabelText("주제"), "개발 이야기");
    await userEvent.click(within(dialog).getByRole("button", { name: "만들기" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/c/new-2/settings"));
    expect(server.bodies("POST", "/api/v1/channels")).toEqual([{ name: "dev-talk", topic: "개발 이야기" }]);
    expect(screen.queryByRole("dialog", { name: "채널 만들기" })).not.toBeInTheDocument();
    expect(queryClient.getQueryData<Channel[]>(qk.channels)?.map((c) => c.name)).toEqual([
      "general",
      "dev-talk",
    ]);
    expect(await within(nav).findByRole("link", { name: /dev-talk/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await screen.findByTestId("page-channel-settings")).toBeInTheDocument();
    expect(server.count("GET", "/api/v1/channels")).toBe(1);
  });

  it("주제를 비우면 보내지 않는다", async () => {
    const server = stubServer();
    renderRoute("/");
    await userEvent.click(await within(await channelNav()).findByRole("button", { name: "채널 만들기" }));
    const dialog = await screen.findByRole("dialog", { name: "채널 만들기" });
    await userEvent.type(within(dialog).getByLabelText("이름"), "general{Enter}");
    await waitFor(() => expect(server.bodies("POST", "/api/v1/channels")).toEqual([{ name: "general" }]));
  });

  it("VALIDATION·CONFLICT 는 폼 안에 보이고 토스트는 없다 — 대화상자는 입력을 지닌 채 열려 있다", async () => {
    stubServer({ create: () => json(400, { code: "VALIDATION", message: "body: name too long" }) });
    renderRoute("/");
    await userEvent.click(await within(await channelNav()).findByRole("button", { name: "채널 만들기" }));
    const dialog = await screen.findByRole("dialog", { name: "채널 만들기" });
    await userEvent.type(within(dialog).getByLabelText("이름"), "general{Enter}");

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("body: name too long");
    expect(within(dialog).getByLabelText("이름")).toHaveValue("general");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("서버 오류가 가리킨 칸(주제)에만 aria-invalid·설명이 붙고, 칸을 고치면 오류가 내려간다", async () => {
    stubServer({
      create: () => json(400, { code: "VALIDATION", message: "body — topic: Too big: expected string" }),
    });
    renderRoute("/");
    await userEvent.click(await within(await channelNav()).findByRole("button", { name: "채널 만들기" }));
    const dialog = await screen.findByRole("dialog", { name: "채널 만들기" });
    const name = within(dialog).getByLabelText("이름");
    const topic = within(dialog).getByLabelText("주제");
    await userEvent.type(name, "general");
    await userEvent.type(topic, "주제{Enter}");

    const alert = await within(dialog).findByRole("alert");
    expect(topic).toHaveAttribute("aria-invalid", "true");
    expect(topic).toHaveAccessibleDescription(alert.textContent ?? "");
    expect(name).not.toHaveAttribute("aria-invalid");

    // 다음 제출까지 남지 않는다 — 어느 칸이든 고치면 내린다
    await userEvent.type(name, "s");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(topic).not.toHaveAttribute("aria-invalid");
  });

  it("그 밖의 오류(500)는 전역 토스트에 맡기고 폼 안에 다시 보이지 않는다", async () => {
    stubServer({ create: () => json(500, { code: "INTERNAL", message: "서버 내부 오류" }) });
    renderRoute("/");
    await userEvent.click(await within(await channelNav()).findByRole("button", { name: "채널 만들기" }));
    const dialog = await screen.findByRole("dialog", { name: "채널 만들기" });
    await userEvent.type(within(dialog).getByLabelText("이름"), "general{Enter}");

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("서버 내부 오류"));
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "만들기" })).toBeEnabled();
  });
});

describe("HomeRedirect", () => {
  it("채널이 있으면 첫 채널로 replace 이동한다", async () => {
    stubServer({ channels: [A, B] });
    const { router, history } = renderRoute("/");
    const actions: string[] = [];
    history.subscribe(({ action }) => actions.push(action.type));
    expect(await screen.findByTestId("page-channel")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/c/a");
    expect(actions).toEqual(["REPLACE"]);
  });

  it("빈 상태에서 만들면 /c/<id>/settings 에 도착해 머문다(첫 채널로 가는 이동이 덮지 않는다)", async () => {
    stubServer();
    const { router, history } = renderRoute("/");
    const moves: string[] = [];
    history.subscribe(({ location, action }) => moves.push(`${action.type} ${location.pathname}`));
    const home = await screen.findByTestId("page-home");
    await userEvent.click(await within(home).findByRole("button", { name: "채널 만들기" }));
    const dialog = await screen.findByRole("dialog", { name: "채널 만들기" });
    await userEvent.type(within(dialog).getByLabelText("이름"), "general{Enter}");

    expect(await screen.findByTestId("page-channel-settings")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/c/new-1/settings");
    expect(moves).toEqual(["PUSH /c/new-1/settings"]);
  });

  it("머무는 동안 목록에 채널이 생겨도 이동하지 않는다 — 「만들기」가 보낸 /settings 를 덮지 않게", async () => {
    stubServer();
    const { router, queryClient, history } = renderRoute("/");
    const moves: string[] = [];
    history.subscribe(({ location, action }) => moves.push(`${action.type} ${location.pathname}`));
    await screen.findByText("채널이 없습니다");

    // 만들기 mutation·다른 탭의 wire 갱신이 하는 일과 같다 — 목록 캐시에 새 채널이 들어온다
    act(() => {
      queryClient.setQueryData<Channel[]>(qk.channels, [channelOf("new-1", { name: "general" })]);
    });
    await waitFor(() => expect(screen.getByRole("link", { name: /general/ })).toBeInTheDocument());
    expect(screen.getByTestId("page-home")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(moves).toEqual([]);
  });

  it("채널이 없으면 「채널이 없습니다」와 「채널 만들기」 — 누르면 대화상자", async () => {
    stubServer();
    renderRoute("/");
    const home = await screen.findByTestId("page-home");
    expect(await within(home).findByText("채널이 없습니다")).toBeInTheDocument();
    await userEvent.click(within(home).getByRole("button", { name: "채널 만들기" }));
    expect(await screen.findByRole("dialog", { name: "채널 만들기" })).toBeInTheDocument();
  });
});
