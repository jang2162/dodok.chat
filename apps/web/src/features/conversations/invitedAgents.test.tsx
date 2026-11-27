import type { Agent, ChannelMember, Conversation, InvitedAgent } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/app/queryClient";
import { ME, channelOf, conversationOf, json, renderRoute, shellGet } from "../../../test/shellApi";
import { stubMedia } from "../../../test/media";
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
  runTimeoutMinutes: null,
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
/** 머리의 참여자 단추(UI 시안 03)를 눌러 팝오버를 연다 — `waitText` 가 보일 때까지(초대 목록은 늦게 온다) 다시 연다 */
async function openParticipants(waitText?: RegExp) {
  const user = userEvent.setup();
  return waitFor(async () => {
    if (!screen.queryByRole("dialog", { name: /^참여자 \d+$/ }))
      await user.click(await within(await header()).findByRole("button", { name: /^참여자 \d+명$/ }));
    const dialog = await screen.findByRole("dialog", { name: /^참여자 \d+$/ });
    if (waitText) expect(dialog).toHaveTextContent(waitText);
    return dialog;
  });
}

describe("세션 머리 — 초대한 에이전트", () => {
  it("초대한 에이전트는 참여자 팝오버의 「이 세션에만 초대」 갈래에 「초대됨」으로 보이고 채널 에이전트 갈래에는 없다 [UI 시안 03]", async () => {
    stubServer({ invited: { [SESSION]: [invitedRow(GUEST.id)] } });
    renderRoute(`/c/a/s/${SESSION}`);
    const dialog = await openParticipants(/@guest/);
    expect(within(dialog).getByRole("region", { name: "이 세션에만 초대" })).toHaveTextContent(
      "@guest · 초대됨",
    );
    expect(within(dialog).getByRole("region", { name: "에이전트" })).not.toHaveTextContent("@guest");
  });

  it("다른 세션의 참여자에는 초대한 에이전트가 없다", async () => {
    stubServer({ invited: { [SESSION]: [invitedRow(GUEST.id)] } });
    renderRoute(`/c/a/s/${OTHER}`);
    const dialog = await openParticipants();
    await within(dialog).findByRole("button", { name: "에이전트 초대" });
    expect(within(dialog).queryByRole("region", { name: "이 세션에만 초대" })).toBeNull();
  });

  it("「에이전트 초대」는 채널에 없고 보관되지 않은 에이전트만 보이고, 고르면 POST — 참여자에 바로 「초대됨」", async () => {
    const fetch = stubServer();
    renderRoute(`/c/a/s/${SESSION}`);
    const participants = await openParticipants();
    await userEvent.click(await within(participants).findByRole("button", { name: "에이전트 초대" }));
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
    const again = await openParticipants(/@guest/);
    expect(within(again).getByRole("region", { name: "이 세션에만 초대" })).toHaveTextContent(
      "@guest · 초대됨",
    );
  });

  it("참여자 팝오버의 「@guest 세션에서 내보내기」는 DELETE — 참여자에서 빠진다", async () => {
    const fetch = stubServer({ invited: { [SESSION]: [invitedRow(GUEST.id)] } });
    renderRoute(`/c/a/s/${SESSION}`);
    const dialog = await openParticipants(/@guest/);
    await userEvent.click(within(dialog).getByRole("button", { name: "@guest 세션에서 내보내기" }));
    await waitFor(() =>
      expect(within(dialog).queryByRole("region", { name: "이 세션에만 초대" })).toBeNull(),
    );
    expect(
      fetch.mock.calls.some(
        ([url, init]) =>
          String(url) === `/api/v1/conversations/${SESSION}/agents/${GUEST.id}` && init?.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("좁은 화면 — 얼굴은 숨고 「더 보기」 메뉴의 「@guest 세션에서 내보내기」가 데스크톱과 같은 DELETE", async () => {
    stubMedia(true);
    const fetch = stubServer({ invited: { [SESSION]: [invitedRow(GUEST.id)] } });
    renderRoute(`/c/a/s/${SESSION}`);
    const user = userEvent.setup();
    const head = await header();
    const more = await within(head).findByRole("button", { name: "더 보기" });
    // 초대 목록을 받은 뒤 메뉴를 연다
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => String(url) === `/api/v1/conversations/${SESSION}/agents`),
      ).toBe(true),
    );
    expect(within(head).queryByRole("list", { name: "초대한 에이전트" })).toBeNull();
    expect(within(head).queryByRole("group", { name: "참여 에이전트" })).toBeNull();
    more.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    await user.click(await within(menu).findByRole("menuitem", { name: "@guest 세션에서 내보내기" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url) === `/api/v1/conversations/${SESSION}/agents/${GUEST.id}` &&
            init?.method === "DELETE",
        ),
      ).toBe(true),
    );
    // 내보낸 뒤 메뉴에서도 빠진다
    more.focus();
    await user.keyboard("{Enter}");
    const again = await screen.findByRole("menu");
    expect(within(again).queryByRole("menuitem", { name: /세션에서 내보내기/ })).toBeNull();
    expect(within(again).getByRole("menuitem", { name: "에이전트 초대" })).toBeInTheDocument();
  });

  it("닫힌 세션·새 세션 창에서는 「에이전트 초대」가 없다 — 닫힌 세션의 초대 에이전트에는 내보내기가 없다", async () => {
    stubServer({ closed: true, invited: { [SESSION]: [invitedRow(GUEST.id)] } });
    const { router } = renderRoute(`/c/a/s/${SESSION}`);
    const closed = await openParticipants(/@guest/);
    expect(within(closed).getByRole("region", { name: "이 세션에만 초대" })).toHaveTextContent(
      "@guest · 초대됨",
    );
    expect(within(closed).queryByRole("button", { name: "@guest 세션에서 내보내기" })).toBeNull();
    expect(within(closed).queryByRole("button", { name: "에이전트 초대" })).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {
      await router.navigate({
        to: "/c/$channelId/s/$conversationId",
        params: { channelId: "a", conversationId: "new" },
      });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/c/a/s/new"));
    const fresh = await header();
    await within(fresh).findByRole("heading", { name: /general/ });
    const draft = await openParticipants();
    expect(within(draft).queryByRole("button", { name: "에이전트 초대" })).toBeNull();
    expect(within(draft).queryByRole("region", { name: "이 세션에만 초대" })).toBeNull();
  });

  it("wire conversation.agents 로 다른 사람이 초대한 것이 머리에 반영된다", async () => {
    stubServer();
    const queryClient = createQueryClient(() => {});
    renderRoute(`/c/a/s/${SESSION}`, queryClient);
    await within(await openParticipants()).findByRole("button", { name: "에이전트 초대" });
    // 핸들러(realtime/handlers.ts)가 하는 일과 같은 갈아 끼우기 — 핸들러 자체는 handlers.test.ts 가 잰다
    await act(async () => {
      queryClient.setQueryData(invitedAgentKeys.of(SESSION), [invitedRow(SPARE.id)]);
    });
    expect(await openParticipants(/@spare/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "이 세션에만 초대" })).toHaveTextContent("@spare · 초대됨");
  });
});
