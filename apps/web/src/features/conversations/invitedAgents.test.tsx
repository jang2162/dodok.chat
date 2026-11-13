import type { Agent, ChannelMember, Conversation, InvitedAgent } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/app/queryClient";
import { ME, channelOf, conversationOf, json, renderRoute, shellGet } from "../../../test/shellApi";
import { invitedAgentKeys } from "./invitedAgents";

// 세션에 에이전트 초대(세션 에이전트 초대 스펙 5.4) — 머리의 「초대됨」·「에이전트 초대」 대화상자·「세션에서 내보내기」·wire 반영

const A = channelOf("a", { name: "general" });
const SESSION = "01a00000-0000-7000-8000-00000000a001";
const OTHER = "01a00000-0000-7000-8000-00000000a002";

const agentOf = (id: string, handle: string, over: Partial<Agent> = {}): Agent => ({
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
  ...over,
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
const invitedRow = (agentId: string): InvitedAgent => ({
  agentId,
  invitedBy: "u",
  invitedAt: "2026-11-13T00:00:00.000Z",
});

const DEV = agentOf("01a00000-0000-7000-8000-0000000000d1", "dev");
const GUEST = agentOf("01a00000-0000-7000-8000-0000000000d2", "guest", { gateway: { id: "g", name: "집" } });
const SPARE = agentOf("01a00000-0000-7000-8000-0000000000d3", "spare");
const GONE = agentOf("01a00000-0000-7000-8000-0000000000d4", "gone", {
  archivedAt: "2026-10-05T00:00:00.000Z",
});

/** 채널 a(dev 가 멤버)의 세션 SESSION·OTHER. `invited` 는 대화마다 초대 목록 — POST·DELETE 가 바꾼다 */
function stubServer(opts: { invited?: Record<string, InvitedAgent[]>; closed?: boolean } = {}) {
  const invited: Record<string, InvitedAgent[]> = { [SESSION]: [], [OTHER]: [], ...opts.invited };
  const sessions: Conversation[] = [
    conversationOf("a", {
      id: SESSION,
      title: "A",
      ...(opts.closed ? { closedAt: "2026-11-13T01:00:00.000Z" } : {}),
    }),
    conversationOf("a", { id: OTHER, title: "B" }),
  ];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/v1/auth/me") return json(200, ME);
    if (url === "/api/v1/channels") return json(200, { channels: [A] });
    if (url === "/api/v1/agents") return json(200, { agents: [DEV, GUEST, SPARE, GONE] });
    if (url === "/api/v1/channels/a/members")
      return json(200, { members: [memberOf("user", "u"), memberOf("agent", DEV.id)] });
    if (url.startsWith("/api/v1/channels/a/conversations")) return json(200, { conversations: sessions });
    const one = /^\/api\/v1\/conversations\/([^/]+)$/.exec(url);
    if (one?.[1]) {
      const found = sessions.find((s) => s.id === one[1]);
      return found ? json(200, { conversation: found }) : json(404, { code: "NOT_FOUND", message: "x" });
    }
    const list = /^\/api\/v1\/conversations\/([^/]+)\/agents(?:\/([^/]+))?$/.exec(url);
    if (list?.[1]) {
      const id = list[1];
      if (method === "POST") {
        const { agentId } = JSON.parse(String(init?.body)) as { agentId: string };
        invited[id] = [...(invited[id] ?? []), invitedRow(agentId)];
      } else if (method === "DELETE") {
        invited[id] = (invited[id] ?? []).filter((r) => r.agentId !== list[2]);
      }
      return json(200, { invited: invited[id] ?? [] });
    }
    if (url === "/api/v1/channels/a") return json(200, { channel: A });
    return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const header = () => screen.findByTestId("channel-header");

describe("세션 머리 — 초대한 에이전트", () => {
  it("초대한 에이전트는 「초대됨」 표시로 보이고 채널 에이전트 묶음에는 없다", async () => {
    stubServer({ invited: { [SESSION]: [invitedRow(GUEST.id)] } });
    renderRoute(`/c/a/s/${SESSION}`);
    const head = await header();
    const list = await within(head).findByRole("list", { name: "초대한 에이전트" });
    expect(within(list).getByRole("button", { name: "@guest 초대됨" })).toHaveTextContent("초대됨");
    const group = within(head).getByRole("group", { name: "참여 에이전트" });
    expect(within(group).queryByRole("img", { name: "@guest" })).toBeNull();
  });

  it("다른 세션의 머리에는 초대한 에이전트가 없다", async () => {
    stubServer({ invited: { [SESSION]: [invitedRow(GUEST.id)] } });
    renderRoute(`/c/a/s/${OTHER}`);
    const head = await header();
    await within(head).findByRole("button", { name: "에이전트 초대" });
    expect(within(head).queryByRole("list", { name: "초대한 에이전트" })).toBeNull();
  });

  it("「에이전트 초대」는 채널에 없고 보관되지 않은 에이전트만 보이고, 고르면 POST — 머리에 바로 「초대됨」", async () => {
    const fetch = stubServer();
    renderRoute(`/c/a/s/${SESSION}`);
    await userEvent.click(await within(await header()).findByRole("button", { name: "에이전트 초대" }));
    const dialog = await screen.findByRole("dialog", { name: "에이전트 초대" });
    const options = within(dialog).getByRole("list", { name: "초대할 에이전트" });
    expect(
      within(options)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["GUEST@guest집", "SPARE@spare"]);
    await userEvent.click(within(options).getByRole("button", { name: /GUEST/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      fetch.mock.calls.some(
        ([url, init]) =>
          String(url) === `/api/v1/conversations/${SESSION}/agents` &&
          init?.method === "POST" &&
          String(init.body) === JSON.stringify({ agentId: GUEST.id }),
      ),
    ).toBe(true);
    expect(await within(await header()).findByRole("button", { name: "@guest 초대됨" })).toBeInTheDocument();
  });

  it("얼굴 메뉴의 「세션에서 내보내기」는 DELETE — 머리에서 빠진다", async () => {
    const fetch = stubServer({ invited: { [SESSION]: [invitedRow(GUEST.id)] } });
    renderRoute(`/c/a/s/${SESSION}`);
    // 메뉴는 트리거에 초점을 준 뒤 Enter 로 연다(sidebar.test 의 까닭 — jsdom 의 window blur 가 Radix 메뉴를 닫는다)
    const user = userEvent.setup();
    (await within(await header()).findByRole("button", { name: "@guest 초대됨" })).focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: "세션에서 내보내기" }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("channel-header")).queryByRole("list", { name: "초대한 에이전트" }),
      ).toBeNull(),
    );
    expect(
      fetch.mock.calls.some(
        ([url, init]) =>
          String(url) === `/api/v1/conversations/${SESSION}/agents/${GUEST.id}` && init?.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("닫힌 세션·새 세션 창에서는 「에이전트 초대」가 없다 — 닫힌 세션의 얼굴에는 메뉴가 없다", async () => {
    stubServer({ closed: true, invited: { [SESSION]: [invitedRow(GUEST.id)] } });
    const { router } = renderRoute(`/c/a/s/${SESSION}`);
    const head = await header();
    expect(await within(head).findByRole("img", { name: "@guest 초대됨" })).toBeInTheDocument();
    expect(within(head).queryByRole("button", { name: "에이전트 초대" })).toBeNull();
    await act(async () => {
      await router.navigate({
        to: "/c/$channelId/s/$conversationId",
        params: { channelId: "a", conversationId: "new" },
      });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/a/s/new"));
    const fresh = await header();
    await within(fresh).findByRole("heading", { name: /general/ });
    expect(within(fresh).queryByRole("button", { name: "에이전트 초대" })).toBeNull();
    expect(within(fresh).queryByRole("list", { name: "초대한 에이전트" })).toBeNull();
  });

  it("wire conversation.agents 로 다른 사람이 초대한 것이 머리에 반영된다", async () => {
    stubServer();
    const queryClient = createQueryClient(() => {});
    renderRoute(`/c/a/s/${SESSION}`, queryClient);
    await within(await header()).findByRole("button", { name: "에이전트 초대" });
    // 핸들러(realtime/handlers.ts)가 하는 일과 같은 갈아 끼우기 — 핸들러 자체는 handlers.test.ts 가 잰다
    await act(async () => {
      queryClient.setQueryData(invitedAgentKeys.of(SESSION), [invitedRow(SPARE.id)]);
    });
    expect(await within(await header()).findByRole("button", { name: "@spare 초대됨" })).toBeInTheDocument();
  });
});
