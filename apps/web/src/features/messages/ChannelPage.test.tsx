import type { Agent, ChannelMember } from "@dodok/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { useChannelSubscription } from "@/realtime/WireProvider";
import { agentColorVar } from "@/theme/agentColor";
import { ME, channelOf, conversationOf, json, renderRoute, shellGet } from "../../../test/shellApi";

// 채널 구독만 목으로 — 인자를 잰다
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useChannelSubscription: vi.fn(),
}));

const A = channelOf("a", { name: "general", topic: "아무 이야기" });
const B = channelOf("b", { name: "random" });

const agentOf = (id: string, handle: string): Agent => ({
  id,
  workspaceId: "w",
  provider: "openclaw",
  providerAgentId: handle,
  handle,
  name: handle.toUpperCase(),
  enabled: true,
  createdAt: "2026-09-19T00:00:00.000Z",
  archivedAt: null,
  dmAccess: "admins",
  program: null,
  createdBy: null,
  model: null,
});
const memberOf = (memberType: ChannelMember["memberType"], memberId: string): ChannelMember => ({
  id: `m-${memberId}`,
  channelId: "a",
  memberType,
  memberId,
  autoRespond: false,
  aliases: [],
  joinedAt: "2026-09-19T00:00:00.000Z",
});

/** 채널 a·b 가 있는 서버. `channel` 로 `/channels/:id` 응답을 바꿀 수 있다 */
function stubServer(
  opts: {
    channel?: (id: string) => Response | Promise<Response>;
    members?: ChannelMember[];
    agents?: Agent[];
  } = {},
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url === "/api/v1/auth/me") return json(200, ME);
    if (url === "/api/v1/channels") return json(200, { channels: [A, B] });
    if (url === "/api/v1/agents") return json(200, { agents: opts.agents ?? [] });
    if (url === "/api/v1/channels/a/members") return json(200, { members: opts.members ?? [] });
    const sessions = /^\/api\/v1\/channels\/([^/]+)\/conversations/.exec(url);
    if (sessions?.[1])
      return [A, B].some((c) => c.id === sessions[1])
        ? json(200, { conversations: [conversationOf(sessions[1])] })
        : json(404, { code: "NOT_FOUND", message: "channel not found" });
    const m = /^\/api\/v1\/channels\/([^/]+)(\/.+)?$/.exec(url);
    if (m?.[1]) {
      if (!m[2] && opts.channel) return opts.channel(m[1]);
      const channel = [A, B].find((c) => c.id === m[1]);
      // 서버처럼 없는 채널은 그 아래 경로(멤버·메시지)까지 404
      if (!channel) return json(404, { code: "NOT_FOUND", message: "channel not found" });
      if (!m[2]) return json(200, { channel });
    }
    return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(useChannelSubscription).mockClear();
});

it("마운트되면 useChannelSubscription(channelId) — 채널을 옮기면 그 채널로", async () => {
  stubServer();
  renderRoute("/c/a");
  expect(await screen.findByRole("heading", { name: /general/ })).toBeInTheDocument();
  expect(useChannelSubscription).toHaveBeenLastCalledWith("a");

  const nav = screen.getByRole("navigation", { name: "채널" });
  await userEvent.click(await within(nav).findByRole("link", { name: /random/ }));
  expect(await screen.findByRole("heading", { name: /random/ })).toBeInTheDocument();
  expect(useChannelSubscription).toHaveBeenLastCalledWith("b");
  expect(new Set(vi.mocked(useChannelSubscription).mock.calls.map(([id]) => id))).toEqual(
    new Set(["a", "b"]),
  );
});

it("채널을 열면 최근 본 채널(오프라인 사본 대상) 맨 앞에", async () => {
  stubServer();
  const { queryClient } = renderRoute("/c/a");
  expect(await screen.findByRole("heading", { name: /general/ })).toBeInTheDocument();
  await waitFor(() => expect(queryClient.getQueryData(qk.recentChannels)).toEqual(["a"]));

  const nav = screen.getByRole("navigation", { name: "채널" });
  await userEvent.click(await within(nav).findByRole("link", { name: /random/ }));
  expect(await screen.findByRole("heading", { name: /random/ })).toBeInTheDocument();
  await waitFor(() => expect(queryClient.getQueryData(qk.recentChannels)).toEqual(["b", "a"]));
});

it("[t5-review L2] 새 세션 창(/s/new)은 그 채널의 마지막으로 본 세션을 바꾸지 않는다 — 실제 세션의 오프라인 사본이 빠지지 않게", async () => {
  stubServer();
  const queryClient = createQueryClient(() => {});
  const SEEN = "01a00000-0000-7000-8000-000000003009";
  queryClient.setQueryData(qk.recentConversations, { a: SEEN });
  renderRoute("/c/a/s/new", queryClient);
  expect(await screen.findByRole("heading", { name: /general/ })).toBeInTheDocument();
  await waitFor(() => expect(queryClient.getQueryData(qk.recentChannels)).toEqual(["a"]));
  expect(queryClient.getQueryData(qk.recentConversations)).toEqual({ a: SEEN });
});

it("없는 채널(404)은 최근 본 채널에 넣지 않는다", async () => {
  stubServer();
  const { queryClient } = renderRoute("/c/nope");
  expect(await screen.findByRole("heading", { name: "채널을 찾을 수 없습니다" })).toBeInTheDocument();
  expect(queryClient.getQueryData(qk.recentChannels)).toBeUndefined();
});

it("헤더 아바타에 삭제(보관)한 에이전트는 없다 — 멤버 응답이 낡아 아직 싣고 있어도", async () => {
  stubServer({
    agents: [
      agentOf("ag-dev", "dev"),
      { ...agentOf("ag-fin", "fin"), archivedAt: "2026-10-05T00:00:00.000Z" },
    ],
    members: [memberOf("user", "u"), memberOf("agent", "ag-dev"), memberOf("agent", "ag-fin")],
  });
  renderRoute("/c/a");
  const group = await within(await screen.findByTestId("channel-header")).findByRole("group", {
    name: "참여 에이전트",
  });
  expect(await within(group).findByRole("img", { name: "@dev" })).toBeInTheDocument();
  expect(within(group).queryByRole("img", { name: "@fin" })).not.toBeInTheDocument();
});

it("헤더: 이름·주제, 채널 에이전트 아바타(테두리 에이전트 색), 설정 버튼은 설정 패널을 여닫는다", async () => {
  stubServer({
    agents: [agentOf("ag-dev", "dev"), agentOf("ag-fin", "fin")],
    members: [memberOf("user", "u"), memberOf("agent", "ag-dev")],
  });
  const { router } = renderRoute("/c/a");
  const header = await screen.findByTestId("channel-header");
  expect(await within(header).findByRole("heading", { name: /general/ })).toBeInTheDocument();
  expect(within(header).getByText("아무 이야기")).toBeInTheDocument();

  const group = await within(header).findByRole("group", { name: "참여 에이전트" });
  const dev = await within(group).findByRole("img", { name: "@dev" });
  // toHaveStyle 은 계산된 스타일을 본다 — jsdom 은 var() 를 풀지 않으므로 인라인 값을 잰다
  expect(dev.style.borderColor).toBe(agentColorVar("dev"));
  expect(within(group).queryByRole("img", { name: "@fin" })).not.toBeInTheDocument();

  const settings = within(header).getByRole("link", { name: "채널 설정" });
  // 채널 주소는 최근 세션(여기는 「이전 대화」 a)으로 넘겨졌다 — 설정 패널을 여닫아도 그 세션에 머문다
  expect(settings).toHaveAttribute("href", "/c/a/s/a/settings");
  expect(settings).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(settings);
  expect(await screen.findByTestId("page-channel-panel")).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/c/a/s/a/settings");
  expect(settings).toHaveAttribute("href", "/c/a/s/a");
  expect(settings).toHaveAttribute("aria-expanded", "true");

  await userEvent.click(settings);
  await waitFor(() => expect(screen.queryByTestId("page-channel-panel")).not.toBeInTheDocument());
  expect(router.state.location.pathname).toBe("/c/a/s/a");
});

it("메시지·작성기 자리를 비워 두고 오른쪽 Outlet 에 설정 패널을 둔다", async () => {
  stubServer();
  renderRoute("/c/a/settings");
  await screen.findByTestId("channel-header");
  const page = screen.getByTestId("page-channel");
  expect(page.querySelector('[data-slot="messages"]')).toBeInTheDocument();
  expect(page.querySelector('[data-slot="composer"]')).toBeInTheDocument();
  expect(page).toContainElement(await screen.findByTestId("page-channel-panel"));
});

it("없는 채널(404)은 화면 안에 「채널을 찾을 수 없습니다」와 첫 화면 링크 — 토스트는 없다", async () => {
  stubServer();
  renderRoute("/c/zzz/settings");
  const page = await screen.findByTestId("page-channel");
  expect(await within(page).findByText("채널을 찾을 수 없습니다")).toBeInTheDocument();
  expect(within(page).getByRole("link", { name: "첫 화면으로" })).toHaveAttribute("href", "/");
  expect(page.querySelector('[data-slot="messages"]')).not.toBeInTheDocument();
  expect(screen.queryByTestId("page-channel-panel")).not.toBeInTheDocument();
  expect(toastError).not.toHaveBeenCalled();
});

it("없는 채널이면 채널 안 조회(멤버)를 부르지 않는다 — 채널이 확인되기 전에는 안을 그리지 않는다", async () => {
  const fetch = stubServer();
  renderRoute("/c/zzz");
  expect(await screen.findByText("채널을 찾을 수 없습니다")).toBeInTheDocument();
  expect(fetch.mock.calls.map(([url]) => String(url))).not.toContain("/api/v1/channels/zzz/members");
});

it("사이드바에서 채널을 옮기면 채널 조회가 끝나기 전에도 목록의 값으로 헤더를 그린다", async () => {
  stubServer({
    // b 는 끝나지 않는 조회
    channel: (id) => (id === "b" ? new Promise<Response>(() => {}) : json(200, { channel: A })),
  });
  renderRoute("/c/a");
  expect(await screen.findByRole("heading", { name: /general/ })).toBeInTheDocument();

  const nav = screen.getByRole("navigation", { name: "채널" });
  await userEvent.click(await within(nav).findByRole("link", { name: /random/ }));
  expect(await screen.findByRole("heading", { name: /random/ })).toBeInTheDocument();
  expect(screen.queryByText("불러오는 중…")).not.toBeInTheDocument();
});

it("그 밖의 조회 실패는 원인과 「다시 시도」를 화면 안에 — 토스트와 겹치지 않는다", async () => {
  let down = true;
  stubServer({
    channel: (id) => {
      if (down) throw new TypeError("Failed to fetch");
      return json(200, { channel: channelOf(id, { name: "general" }) });
    },
  });
  const queryClient = createQueryClient(() => {});
  queryClient.setQueryDefaults(["channel"], { retryDelay: 0 });
  renderRoute("/c/a/s/a", queryClient);
  const page = await screen.findByTestId("page-channel");
  expect(await within(page).findByText("채널을 불러오지 못했습니다")).toBeInTheDocument();
  expect(within(page).getByText("서버에 연결할 수 없습니다")).toBeInTheDocument();
  expect(toastError).not.toHaveBeenCalled();

  down = false;
  await userEvent.click(within(page).getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByRole("heading", { name: /general/ })).toBeInTheDocument();
});
