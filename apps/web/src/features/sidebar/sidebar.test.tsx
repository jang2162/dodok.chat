import type { Channel, ConversationUnread, DmSummary, SidebarLayout } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createQueryClient } from "@/app/queryClient";
import { useUnread } from "@/features/reads/useUnread";
import { attachHandlers } from "@/realtime/handlers";
import { createSubscriptions } from "@/realtime/subscriptions";
import { dmChannelOf, dmOf } from "../../../test/dms";
import { createFakeSocket } from "../../../test/fakeSocket";
import { uid } from "../../../test/fixtures";
import { agentOf } from "../../../test/settingsServer";
import { ME, channelOf, json, renderRoute, shellGet } from "../../../test/shellApi";
import { SIDEBAR_SAVE_FAILED_TEXT } from "./queries";

// 사이드바 개인 섹션 — 그리기·메뉴·접기·안 읽은 표시·실패 되돌림·wire(사이드바 섹션 계획 태스크 3)

type Reply = Response | Promise<Response>;

const S1 = uid(9_001);
const S2 = uid(9_002);
const GENERAL = channelOf(uid(101), { name: "general" });
const RANDOM = channelOf(uid(102), { name: "random" });
const DEVCH = channelOf(uid(103), { name: "dev" });
const LOBBY = channelOf(uid(104), { name: "lobby" });
const ARCHIVED_ID = uid(105);
const DM_ID = uid(201);
const DEV_AGENT = agentOf(uid(301), "dev", { name: "Dev 봇" });
const DM: DmSummary = dmOf(dmChannelOf(DM_ID, ME.user.id, DEV_AGENT.id), DEV_AGENT);

const section = (id: string, name: string, items: string[], collapsed = false) => ({
  id,
  name,
  collapsed,
  items,
});

/** 배치를 서버 상태로 들고 있는 가짜 서버 — PUT 은 `put` 이 있으면 그 응답, 없으면 받은 배치를 저장해 돌려준다 */
function stubServer(
  opts: {
    channels?: Channel[];
    dms?: DmSummary[];
    layout?: SidebarLayout;
    put?: (body: SidebarLayout) => Reply;
  } = {},
) {
  let layout: SidebarLayout = opts.layout ?? { sections: [] };
  const puts: SidebarLayout[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/v1/auth/me") return json(200, ME);
    if (method === "GET" && url === "/api/v1/channels")
      return json(200, { channels: opts.channels ?? [GENERAL, RANDOM, DEVCH, LOBBY] });
    if (method === "GET" && url === "/api/v1/dms") return json(200, { dms: opts.dms ?? [] });
    if (method === "GET" && url === "/api/v1/me/sidebar") return json(200, layout);
    if (method === "PUT" && url === "/api/v1/me/sidebar") {
      const body = JSON.parse(String(init?.body)) as SidebarLayout;
      puts.push(body);
      if (opts.put) return opts.put(body);
      layout = body;
      return json(200, body);
    }
    return (
      shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: `예상 밖 요청 ${method} ${url}` })
    );
  });
  vi.stubGlobal("fetch", fetch);
  return { puts, current: () => layout };
}

const nav = (name: string) => screen.findByRole("navigation", { name });
const linkNames = (el: HTMLElement) =>
  within(el)
    .queryAllByRole("link")
    .map((a) => a.textContent);

/** 메뉴는 트리거에 초점을 준 뒤 Enter 로 연다(reactions.test 의 까닭 — jsdom 의 window blur 가 Radix 메뉴를 닫는다) */
async function openMenu(user: ReturnType<typeof userEvent.setup>, label: string) {
  const trigger = await screen.findByRole("button", { name: label });
  trigger.focus();
  await user.keyboard("{Enter}");
  return screen.findByRole("menu");
}
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, item: string) {
  const menu = await openMenu(user, label);
  await user.click(within(menu).getByRole("menuitem", { name: item }));
}

let toastError: MockInstance<typeof toast.error>;
beforeEach(() => {
  toastError = vi.spyOn(toast, "error");
  useUnread.getState().reset();
});
afterEach(() => {
  useUnread.getState().reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("사이드바 개인 섹션 — 그리기", () => {
  it("섹션은 두 절 위에, 섹션에 든 채널·DM 은 기본 절에서 빠진다", async () => {
    stubServer({ dms: [DM], layout: { sections: [section(S1, "업무", [RANDOM.id, DM_ID])] } });
    renderRoute(`/c/${LOBBY.id}`);
    const work = await nav("업무");
    await waitFor(() => expect(linkNames(work)).toEqual(["random", expect.stringContaining("Dev 봇")]));
    const channels = await nav("채널");
    expect(linkNames(channels)).toEqual(["general", "dev", "lobby"]);
    const dms = await nav("다이렉트 메시지");
    expect(linkNames(dms)).toEqual([]);
    // 문서 순서 — 섹션이 「채널」 절보다 앞
    expect(work.compareDocumentPosition(channels) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("보관한 채널 id 는 그리지 않고 배치에 남긴다 — 다른 항목을 옮기는 PUT 이 그 id 를 지우지 않는다", async () => {
    const user = userEvent.setup();
    const server = stubServer({ layout: { sections: [section(S1, "업무", [ARCHIVED_ID, RANDOM.id])] } });
    renderRoute(`/c/${LOBBY.id}`);
    const work = await nav("업무");
    await waitFor(() => expect(linkNames(work)).toEqual(["random"]));
    await choose(user, "general 메뉴", "업무");
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.sections[0]?.items).toEqual([ARCHIVED_ID, RANDOM.id, GENERAL.id]);
  });

  it("배치를 못 받으면 섹션 없이 기본 두 절에 전부 — 「섹션 만들기」는 누를 수 없다", async () => {
    stubServer();
    const fetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (input, init) =>
        String(input) === "/api/v1/me/sidebar"
          ? json(500, { code: "INTERNAL", message: "x" })
          : fetch(input, init),
      ),
    );
    renderRoute(`/c/${LOBBY.id}`);
    const channels = await nav("채널");
    await waitFor(() => expect(linkNames(channels)).toEqual(["general", "random", "dev", "lobby"]));
    expect(screen.getByRole("button", { name: "섹션 만들기" })).toBeDisabled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("사이드바 개인 섹션 — 메뉴", () => {
  it("「섹션 만들기」 → 이름 → 맨 아래에 빈 섹션", async () => {
    const user = userEvent.setup();
    const server = stubServer({ layout: { sections: [section(S1, "업무", [])] } });
    renderRoute(`/c/${LOBBY.id}`);
    await nav("업무");
    await user.click(screen.getByRole("button", { name: "섹션 만들기" }));
    await user.type(await screen.findByLabelText("이름"), "  개인  ");
    await user.click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.sections.map((s) => s.name)).toEqual(["업무", "개인"]);
    expect(await nav("개인")).toBeInTheDocument();
  });

  it("항목 메뉴 — 섹션으로 넣기(맨 아래)·다른 섹션으로·섹션에서 빼면 기본 절의 원래 자리로", async () => {
    const user = userEvent.setup();
    const server = stubServer({
      layout: { sections: [section(S1, "업무", [DEVCH.id]), section(S2, "개인", [])] },
    });
    renderRoute(`/c/${LOBBY.id}`);
    const work = await nav("업무");
    await waitFor(() => expect(linkNames(work)).toEqual(["dev"]));

    await choose(user, "general 메뉴", "업무");
    await waitFor(() => expect(linkNames(work)).toEqual(["dev", "general"]));
    expect(linkNames(await nav("채널"))).toEqual(["random", "lobby"]);

    await choose(user, "general 메뉴", "개인");
    await waitFor(() =>
      expect(linkNames(screen.getByRole("navigation", { name: "개인" }))).toEqual(["general"]),
    );
    expect(linkNames(work)).toEqual(["dev"]);

    await choose(user, "general 메뉴", "섹션에서 빼기");
    await waitFor(() =>
      expect(linkNames(screen.getByRole("navigation", { name: "채널" }))).toEqual([
        "general",
        "random",
        "lobby",
      ]),
    );
    expect(server.puts.map((p) => p.sections.map((s) => s.items))).toEqual([
      [[DEVCH.id, GENERAL.id], []],
      [[DEVCH.id], [GENERAL.id]],
      [[DEVCH.id], []],
    ]);
  });

  it("항목 메뉴 「새 섹션…」 → 이름 → 그 항목이 든 새 섹션 하나(PUT 한 번)", async () => {
    const user = userEvent.setup();
    const server = stubServer({ dms: [DM] });
    renderRoute(`/c/${LOBBY.id}`);
    await choose(user, "Dev 봇 메뉴", "새 섹션…");
    await user.type(await screen.findByLabelText("이름"), "봇");
    await user.click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.sections).toEqual([
      { id: expect.any(String), name: "봇", collapsed: false, items: [DM_ID] },
    ]);
    await waitFor(async () =>
      expect(linkNames(await nav("봇"))).toEqual([expect.stringContaining("Dev 봇")]),
    );
    expect(linkNames(await nav("다이렉트 메시지"))).toEqual([]);
  });

  it("섹션 「⋯」 — 이름 바꾸기·아래로·위로·지우기(안의 것은 기본 절의 지금 순서 자리로)", async () => {
    const user = userEvent.setup();
    const server = stubServer({
      layout: { sections: [section(S1, "업무", [LOBBY.id, GENERAL.id]), section(S2, "개인", [])] },
    });
    renderRoute(`/c/${RANDOM.id}`);
    await nav("업무");

    const first = await openMenu(user, "업무 섹션 메뉴");
    expect(within(first).getByRole("menuitem", { name: "위로" })).toHaveAttribute("aria-disabled", "true");
    await user.click(within(first).getByRole("menuitem", { name: "이름 바꾸기" }));
    const input = await screen.findByLabelText("이름");
    expect(input).toHaveValue("업무");
    await user.clear(input);
    await user.type(input, "회사");
    await user.click(screen.getByRole("button", { name: "저장" }));
    await nav("회사");

    await choose(user, "회사 섹션 메뉴", "아래로");
    await waitFor(() => expect(server.puts.at(-1)?.sections.map((s) => s.name)).toEqual(["개인", "회사"]));
    await choose(user, "회사 섹션 메뉴", "위로");
    await waitFor(() => expect(server.puts.at(-1)?.sections.map((s) => s.name)).toEqual(["회사", "개인"]));

    await choose(user, "회사 섹션 메뉴", "지우기");
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "회사" })).toBeNull());
    expect(linkNames(await nav("채널"))).toEqual(["general", "random", "dev", "lobby"]);
    expect(server.current().sections.map((s) => s.name)).toEqual(["개인"]);
  });
});

describe("사이드바 개인 섹션 — 접기·안 읽은 표시", () => {
  const unreadRow = (channelId: string, over: Partial<ConversationUnread> = {}): ConversationUnread => ({
    conversationId: uid(7_000 + Number(channelId.slice(-3))),
    channelId,
    lastReadSeq: 0,
    latestSeq: 3,
    unread: false,
    mentions: 0,
    ...over,
  });
  const snapshot = (...conversations: ConversationUnread[]) => {
    useUnread.getState().beginSnapshot();
    useUnread.getState().applySnapshot({
      conversations,
      channels: [...new Set(conversations.map((c) => c.channelId))],
    });
  };
  const header = (name: string) =>
    screen.findByRole("button", { name: new RegExp(`^${name}(\\s*\\(안 읽음\\))?$`) });

  it("머리를 누르면 접힌다(저장) — 접힌 섹션에 안 읽은 것이 있으면 머리에 표시, 읽으면 사라진다", async () => {
    const user = userEvent.setup();
    const server = stubServer({ layout: { sections: [section(S1, "업무", [GENERAL.id])] } });
    snapshot(unreadRow(GENERAL.id, { unread: true }));
    renderRoute(`/c/${LOBBY.id}`);
    const work = await nav("업무");
    await waitFor(() => expect(linkNames(work)).toEqual([expect.stringContaining("general")]));
    const head = await header("업무");
    expect(head).toHaveAttribute("aria-expanded", "true");
    // 펼친 섹션은 줄이 굵다 — 머리에는 표시가 없다
    expect(work.querySelector("[data-section-unread]")).toBeNull();

    await user.click(head);
    await waitFor(() => expect(head).toHaveAttribute("aria-expanded", "false"));
    expect(server.puts[0]?.sections[0]?.collapsed).toBe(true);
    expect(linkNames(work)).toEqual([]);
    expect(work.querySelector("[data-section-unread]")).not.toBeNull();
    expect(head).toHaveAccessibleName(/^업무\s*\(안 읽음\)$/);

    act(() =>
      useUnread
        .getState()
        .applyRead(
          { conversationId: unreadRow(GENERAL.id).conversationId, channelId: GENERAL.id, lastReadSeq: 3 },
          { listed: true },
        ),
    );
    await waitFor(() => expect(work.querySelector("[data-section-unread]")).toBeNull());
    expect(head).toHaveAccessibleName("업무");
  });

  it("안 읽은 것이 없으면 접혀도 표시가 없다", async () => {
    stubServer({ layout: { sections: [section(S1, "업무", [GENERAL.id], true)] } });
    snapshot(unreadRow(RANDOM.id, { unread: true }));
    renderRoute(`/c/${LOBBY.id}`);
    const work = await nav("업무");
    expect(await header("업무")).toHaveAttribute("aria-expanded", "false");
    expect(work.querySelector("[data-section-unread]")).toBeNull();
  });
});

describe("사이드바 개인 섹션 — 저장 실패·wire", () => {
  it.each([
    ["400", () => json(400, { code: "VALIDATION", message: "x" })],
    ["500", () => json(500, { code: "INTERNAL", message: "x" })],
    ["네트워크", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("PUT 실패(%s) — 저장 전 배치로 돌아오고 토스트", async (_label, fail) => {
    const user = userEvent.setup();
    stubServer({ layout: { sections: [section(S1, "업무", [DEVCH.id])] }, put: fail });
    renderRoute(`/c/${LOBBY.id}`);
    const work = await nav("업무");
    await waitFor(() => expect(linkNames(work)).toEqual(["dev"]));
    await choose(user, "general 메뉴", "업무");
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(SIDEBAR_SAVE_FAILED_TEXT, expect.anything()));
    await waitFor(() => expect(linkNames(work)).toEqual(["dev"]));
    expect(linkNames(screen.getByRole("navigation", { name: "채널" }))).toEqual([
      "general",
      "random",
      "lobby",
    ]);
  });

  it("wire me.sidebar — 다른 탭의 저장이 사이드바를 바꾼다", async () => {
    stubServer({ layout: { sections: [section(S1, "업무", [DEVCH.id])] } });
    const fake = createFakeSocket();
    fake.socket.connected = true;
    fake.socket.active = true;
    const queryClient = createQueryClient(() => undefined);
    const detach = attachHandlers(fake.wire, {
      queryClient,
      subscriptions: createSubscriptions({ socket: fake.wire, queryClient }),
      onUnauthorized: () => undefined,
      notify: {
        currentChannelId: () => undefined,
        currentConversationId: () => undefined,
        openActivity: () => {},
      },
    });
    try {
      renderRoute(`/c/${LOBBY.id}`, queryClient);
      const work = await nav("업무");
      await waitFor(() => expect(linkNames(work)).toEqual(["dev"]));
      act(() =>
        fake.serverEmit("me.sidebar", {
          layout: { sections: [section(S2, "개인", [GENERAL.id]), section(S1, "업무", [])] },
        }),
      );
      await waitFor(async () => expect(linkNames(await nav("개인"))).toEqual(["general"]));
      expect(linkNames(work)).toEqual([]);
      expect(linkNames(await nav("채널"))).toEqual(["random", "dev", "lobby"]);
    } finally {
      detach();
    }
  });
});
