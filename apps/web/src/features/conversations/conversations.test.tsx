import {
  type ChannelMember,
  ComponentsV1,
  type Conversation,
  type Result,
  type SessionPolicy,
} from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { emptyTimeline, NEW_CONVERSATION, threadFromPage, type Timeline } from "@/features/messages/timeline";
import { createSubscriptions } from "@/realtime/subscriptions";
import { getTimeline } from "@/realtime/timelineCache";
import { attachHandlers } from "@/realtime/handlers";
import { useWireStatus } from "@/realtime/wire";
import { useUnread } from "@/features/reads/useUnread";
import { flushEditorFrames } from "../../../test/composerHarness";
import { stubEditorDom } from "../../../test/domStubs";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { FakeXhr, pngFile, stubObjectUrls } from "../../../test/fakeXhr";
import { CH, CH2, msg, uid } from "../../../test/fixtures";
import { stubMedia } from "../../../test/media";
import { ME, channelOf, conversationOf, json, renderRoute, shellGet } from "../../../test/shellApi";
import { applyConversation, byActivity, noteConversationActivity, visibleConversations } from "./cache";
import type { ConversationPages } from "./cache";
import { settledFromNew } from "@/features/composer/useSendMessage";
import { canCreateConversation, canManageConversation, isSessionManagerOf } from "./permissions";

// 세션 목록·머리·닫기(채널 세션 계획 태스크 6). 세션 화면은 실시간 없이(WireProvider 없음) 띄우고, 실시간 이벤트는 실제 핸들러
// (attachHandlers)가 같은 QueryClient 에 반영하는 것으로 흉내 낸다. 목록 칸의 활동 순서(message.created)는 칸이 직접 듣는다 — 가짜 소켓
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));
// 세션 화면(`ChannelPage`)이 그려진 횟수 — 그 화면만 부르는 훅을 세어 본다(스레드 패널을 열지 않은 테스트에서). 동작은 그대로
const pageRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/features/runs/useChannelBubbles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/runs/useChannelBubbles")>();
  return {
    ...actual,
    useChannelBubbles: (...args: Parameters<typeof actual.useChannelBubbles>) => {
      pageRenders.count += 1;
      return actual.useChannelBubbles(...args);
    },
  };
});

const OTHER = "other";
const A = uid(5_001);
const B = uid(5_002);
const C = uid(5_003);
const at = (min: number) => new Date(Date.UTC(2027, 0, 15, 8, min)).toISOString();
const conv = (id: string, over: Partial<Conversation> = {}): Conversation =>
  conversationOf(CH, { id, title: `세션-${id.slice(-1)}`, createdAt: at(0), ...over });
/** 사람 멤버 줄 — 셸의 me 는 id 가 "u" 라(UUID 가 아니다) 스키마를 거치지 않는다 */
const userMember = (memberId: string, role: "member" | "manager"): ChannelMember => ({
  id: uid(7_000 + memberId.length),
  channelId: CH,
  memberType: "user",
  memberId,
  role,
  autoRespond: false,
  aliases: [],
  joinedAt: at(0),
});

type Call = { method: string; url: string; body?: unknown };

/**
 * 세션 화면이 부르는 REST — me(역할), 채널(세션 정책), 멤버(세션 관리자), 세션 목록(status·q 를 서버처럼 거르고 최근 활동순), 세션 하나,
 * 세션 PATCH(제목·닫기·다시 열기), 세션 관리자 PUT·DELETE, 채널 PATCH(정책). 그 밖은 셸 기본
 */
function stubServer({
  role = "owner",
  policy = { create: "members" },
  members = [],
  conversations = [],
  archived = false,
}: {
  role?: string;
  policy?: SessionPolicy;
  members?: ChannelMember[];
  conversations?: Conversation[];
  archived?: boolean;
} = {}) {
  const calls: Call[] = [];
  const state = { conversations: [...conversations], members: [...members], policy };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url, ...(body === undefined ? {} : { body }) });
      if (url === "/api/v1/auth/me") return json(200, { ...ME, role });
      if (url === `/api/v1/channels/${CH}` && method === "GET")
        return json(200, {
          channel: channelOf(CH, { sessionPolicy: state.policy, ...(archived ? { archivedAt: at(0) } : {}) }),
        });
      if (url === `/api/v1/channels/${CH}` && method === "PATCH") {
        state.policy = (body as { sessionPolicy: SessionPolicy }).sessionPolicy;
        return json(200, { channel: channelOf(CH, { sessionPolicy: state.policy }) });
      }
      if (url === `/api/v1/channels/${CH}/members`) return json(200, { members: state.members });
      const list = /^\/api\/v1\/channels\/[^/]+\/conversations\?(.*)$/.exec(url);
      if (list) {
        const params = new URLSearchParams(list[1]);
        const status = params.get("status");
        const q = params.get("q")?.toLowerCase() ?? "";
        const rows = state.conversations
          .filter((c) => (status === "closed" ? c.closedAt !== undefined : c.closedAt === undefined))
          .filter((c) => c.title.toLowerCase().includes(q))
          .sort(byActivity);
        return json(200, { conversations: rows });
      }
      const one = /^\/api\/v1\/conversations\/([^/?]+)$/.exec(url);
      if (one) {
        const i = state.conversations.findIndex((c) => c.id === one[1]);
        if (i < 0) return json(404, { code: "NOT_FOUND", message: "conversation not found" });
        if (method === "PATCH") {
          const patch = body as { title?: string; closed?: boolean };
          const prev = state.conversations[i] as Conversation;
          const { closedAt: _closed, ...open } = prev;
          const next: Conversation = {
            ...(patch.closed === false ? open : prev),
            ...(patch.title === undefined ? {} : { title: patch.title, titleSource: "user" as const }),
            ...(patch.closed === true ? { closedAt: at(30), closedBy: ME.user.id } : {}),
          };
          state.conversations[i] = next;
          return json(200, { conversation: next });
        }
        return json(200, { conversation: state.conversations[i] });
      }
      const manager = /^\/api\/v1\/channels\/[^/]+\/session-managers\/([^/]+)$/.exec(url);
      if (manager?.[1]) {
        const member = userMember(manager[1], method === "PUT" ? "manager" : "member");
        state.members = [...state.members.filter((m) => m.memberId !== member.memberId), member];
        return json(200, { member });
      }
      return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
    }),
  );
  return {
    calls,
    state,
    writes: () => calls.filter((c) => c.method !== "GET"),
    gets: (path: string) => calls.filter((c) => c.method === "GET" && c.url === `/api/v1${path}`).length,
  };
}

let fake: FakeSocket;
let restoreDom: Array<() => void>;
let urls: ReturnType<typeof stubObjectUrls>;
beforeEach(() => {
  // 메시지 목록은 가상 목록이다 — 배치를 흉내 내야 행(카드·보내는 중 항목)이 그려진다
  restoreDom = [stubEditorDom(), stubScrollLayout()];
  FakeXhr.reset();
  urls = stubObjectUrls();
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
});
afterEach(async () => {
  await flushEditorFrames();
  for (const restore of restoreDom) restore();
  urls.restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

const pane = () => screen.findByRole("navigation", { name: "세션 목록" });
const itemTitles = async () =>
  within(await pane())
    .getAllByRole("listitem")
    .map((li) => li.querySelector("a > span")?.textContent);
const header = () => screen.findByTestId("channel-header");
const composerSlot = () => document.querySelector<HTMLElement>('[data-slot="composer"]');
/** 작성기에 글을 넣고 Enter */
async function typeAndSend(text: string) {
  const box = await screen.findByRole("textbox", { name: "메시지 입력" });
  const editor = (box as unknown as { editor: import("@tiptap/core").Editor }).editor;
  act(() => {
    editor.commands.setContent(text);
    editor.commands.focus("end");
  });
  fireEvent.keyDown(box, { key: "Enter" });
  return editor;
}
const pages = (conversations: Conversation[]): ConversationPages => ({
  pages: [{ conversations }],
  pageParams: [undefined],
});

/** 실제 핸들러를 같은 QueryClient 에 붙인다 — 다른 탭·다른 사람의 변경이 wire 로 오는 길 */
function liveHandlers(qc: QueryClient) {
  const socket = createFakeSocket();
  const subscriptions = createSubscriptions({ socket: socket.wire, queryClient: qc });
  const notify = {
    currentChannelId: () => undefined,
    currentConversationId: () => undefined,
    openActivity: () => {},
  };
  const detach = attachHandlers(socket.wire, {
    queryClient: qc,
    subscriptions,
    onUnauthorized: () => {},
    notify,
  });
  return {
    emit: (event: string, ...payload: unknown[]) => act(() => socket.serverEmit(event, ...payload)),
    detach,
  };
}

describe("목록 순서·거름(순수)", () => {
  it("최근 활동(마지막 메시지, 없으면 만든 때)순, 같으면 id 내림차순 — 서버 목록과 같은 정렬", () => {
    const list = [
      conv(A, { lastMessageAt: at(5) }),
      conv(B, { createdAt: at(9) }),
      conv(C, { lastMessageAt: at(5) }),
    ];
    expect(visibleConversations(pages(list), "open", "").map((c) => c.id)).toEqual([B, C, A]);
  });

  it("상태·제목 검색어로 다시 거르고 같은 id 는 한 번 — 실시간 반영이 쪽 안 자리만 고쳐도 화면 목록이 맞다", () => {
    const list = [conv(A, { title: "배포 회의" }), conv(B, { closedAt: at(3) }), conv(A, { title: "중복" })];
    expect(visibleConversations(pages(list), "open", "").map((c) => c.title)).toEqual(["배포 회의"]);
    expect(visibleConversations(pages(list), "closed", "").map((c) => c.id)).toEqual([B]);
    expect(visibleConversations(pages(list), "open", "배포").map((c) => c.id)).toEqual([A]);
    expect(visibleConversations(pages(list), "open", "없음")).toEqual([]);
  });

  it("[PS11] 새 글은 그 세션의 활동을 올리고 시스템 메시지는 올리지 않는다", () => {
    const qc = createQueryClient(() => {});
    const key = qk.conversationList(CH, "open", "");
    qc.setQueryData(key, pages([conv(A, { lastMessageAt: at(5) }), conv(B, { lastMessageAt: at(1) })]));
    noteConversationActivity(qc, msg(9, { conversationId: B, kind: "system", createdAt: at(20) }));
    expect(visibleConversations(qc.getQueryData(key), "open", "").map((c) => c.id)).toEqual([A, B]);
    noteConversationActivity(qc, msg(10, { conversationId: B, createdAt: at(21) }));
    expect(visibleConversations(qc.getQueryData(key), "open", "").map((c) => c.id)).toEqual([B, A]);
    expect(qc.getQueryData<ConversationPages>(key)?.pages[0]?.conversations[1]?.lastSeq).toBe(10);
  });

  it("받아 둔 열림 목록에 없는 세션의 글이면 그 목록을 다시 받게 한다(옛 쪽에 있던 세션이 맨 위로)", () => {
    const qc = createQueryClient(() => {});
    const key = qk.conversationList(CH, "open", "");
    qc.setQueryData(key, pages([conv(A)]));
    noteConversationActivity(qc, msg(3, { conversationId: B }));
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("[태스크 6 리뷰 L3] 제목 검색 목록에 없는 세션의 글로는 다시 받지 않는다 — 다시 받아도 검색에 맞지 않는다", () => {
    const qc = createQueryClient(() => {});
    const key = qk.conversationList(CH, "open", "배포");
    qc.setQueryData(key, pages([conv(A, { title: "배포" })]));
    noteConversationActivity(qc, msg(3, { conversationId: B }));
    expect(qc.getQueryState(key)?.isInvalidated).toBe(false);
  });
});

describe("권한 판정 — 서버 auth/policies.ts 의 세션 쪽과 같은 표", () => {
  const managers: SessionPolicy = { create: "managers" };
  const members: SessionPolicy = { create: "members" };
  it.each([
    ["member", members, false, true],
    ["member", managers, false, false],
    ["member", managers, true, true],
    ["admin", managers, false, true],
    ["owner", managers, false, true],
    [undefined, members, true, false],
  ] as const)("새 세션 — %s · 정책 %o · 세션 관리자 %s → %s", (role, policy, isManager, expected) => {
    expect(canCreateConversation(role, policy, isManager)).toBe(expected);
  });
  it.each([
    ["member", { type: "user", id: "u" }, false, true],
    ["member", { type: "user", id: OTHER }, false, false],
    ["member", { type: "user", id: OTHER }, true, true],
    ["member", { type: "automation", id: "u" }, false, false],
    ["admin", { type: "user", id: OTHER }, false, true],
    [undefined, { type: "user", id: "u" }, false, false],
  ] as const)("제목·닫기 — %s · 만든 이 %o · 세션 관리자 %s → %s", (role, createdBy, isManager, expected) => {
    expect(canManageConversation(role, { createdBy }, "u", isManager)).toBe(expected);
  });
  it("세션 관리자는 채널 멤버 줄의 role manager 만 — 채널 멤버(role member)는 아니다", () => {
    expect(isSessionManagerOf([userMember("u", "member")], "u")).toBe(false);
    expect(isSessionManagerOf([userMember("u", "manager")], "u")).toBe(true);
    expect(isSessionManagerOf([userMember(OTHER, "manager")], "u")).toBe(false);
  });
});

describe("세션 목록 칸", () => {
  it("최근 활동순으로 보이고, 지금 세션은 aria-current, 항목은 그 세션 주소로 간다", async () => {
    stubServer({
      conversations: [conv(A, { lastMessageAt: at(1) }), conv(B, { lastMessageAt: at(9) }), conv(C)],
    });
    renderRoute(`/c/${CH}/s/${A}`);
    await waitFor(async () => expect(await itemTitles()).toEqual(["세션-2", "세션-1", "세션-3"]));
    expect(
      within(await pane()).getByRole("heading", { name: "세션", level: 2 }).parentElement,
    ).not.toHaveClass("pr-12");
    const current = within(await pane()).getByRole("link", { current: "page" });
    expect(current).toHaveTextContent("세션-1");
    expect(within(await pane()).getByRole("link", { name: /세션-2/ })).toHaveAttribute(
      "href",
      `/c/${CH}/s/${B}`,
    );
  });

  it("[태스크 6 리뷰 L1] 화면이 뜰 때 세션 하나·채널 멤버를 한 번씩만 받는다(머리·목록·작성기가 뒤에 붙어도)", async () => {
    const server = stubServer({ conversations: [conv(A)] });
    renderRoute(`/c/${CH}/s/${A}`);
    await within(await header()).findByRole("button", { name: "세션-1" });
    await waitFor(async () => expect(await itemTitles()).toEqual(["세션-1"]));
    await screen.findByRole("textbox", { name: "메시지 입력" });
    expect(server.gets(`/conversations/${A}`)).toBe(1);
    expect(server.gets(`/channels/${CH}/members`)).toBe(1);
  });

  it("「닫힘」 필터는 닫힌 세션만, 제목 검색은 서버 q 로(잠깐 기다렸다가) — 없으면 「찾는 세션이 없습니다」", async () => {
    const server = stubServer({
      conversations: [conv(A, { title: "배포" }), conv(B, { title: "회고", closedAt: at(2) })],
    });
    renderRoute(`/c/${CH}/s/${A}`);
    await waitFor(async () => expect(await itemTitles()).toEqual(["배포"]));
    await userEvent.click(within(await pane()).getByRole("button", { name: "닫힘" }));
    await waitFor(async () => expect(await itemTitles()).toEqual(["회고"]));
    expect(within(await pane()).getByRole("button", { name: "닫힘" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(within(await pane()).getByRole("button", { name: "열림" }));
    await userEvent.type(within(await pane()).getByRole("searchbox", { name: "세션 제목 검색" }), "없는");
    expect(await within(await pane()).findByText("찾는 세션이 없습니다.")).toBeInTheDocument();
    // 화면 목록은 받아 둔 쪽을 검색어로도 거르므로 안내가 요청보다 먼저 뜰 수 있다 — 요청은 따로 기다린다
    await waitFor(() =>
      expect(server.calls.some((c) => c.url.includes("status=open&q=%EC%97%86%EB%8A%94"))).toBe(true),
    );
  });

  it("칸이 떠 있는 동안 새 글이 그 세션을 맨 위로 — 시스템 메시지(닫기·한도 알림)는 올리지 않는다(PS11)", async () => {
    stubServer({ conversations: [conv(A, { lastMessageAt: at(5) }), conv(B, { lastMessageAt: at(1) })] });
    renderRoute(`/c/${CH}/s/${A}`);
    await waitFor(async () => expect(await itemTitles()).toEqual(["세션-1", "세션-2"]));
    act(() =>
      fake.serverEmit("message.created", {
        message: msg(7, { conversationId: B, kind: "system", createdAt: at(20) }),
      }),
    );
    expect(await itemTitles()).toEqual(["세션-1", "세션-2"]);
    act(() =>
      fake.serverEmit("message.created", { message: msg(8, { conversationId: B, createdAt: at(21) }) }),
    );
    await waitFor(async () => expect(await itemTitles()).toEqual(["세션-2", "세션-1"]));
    // 다른 채널의 글은 이 채널 목록을 건드리지 않는다
    act(() =>
      fake.serverEmit("message.created", {
        message: msg(9, { channelId: CH2, conversationId: A, createdAt: at(30) }),
      }),
    );
    expect(await itemTitles()).toEqual(["세션-2", "세션-1"]);
  });

  it("conversation.created(다른 탭·다른 사람이 만든 세션)가 목록 맨 위에 든다", async () => {
    stubServer({ conversations: [conv(A, { lastMessageAt: at(5) })] });
    const { queryClient } = renderRoute(`/c/${CH}/s/${A}`);
    const live = liveHandlers(queryClient);
    await waitFor(async () => expect(await itemTitles()).toEqual(["세션-1"]));
    live.emit("conversation.created", { conversation: conv(B, { title: "새 주제", createdAt: at(9) }) });
    await waitFor(async () => expect(await itemTitles()).toEqual(["새 주제", "세션-1"]));
    live.detach();
  });

  it("읽지 않음 자리 — 현황이 있으면 굵게·점, 멘션 수 배지(99+), 항목이 없는 세션은 그리지 않는다", async () => {
    const { ConversationList } = await import("./ConversationList");
    stubServer({ conversations: [conv(A, { lastMessageAt: at(5) }), conv(B), conv(C)] });
    const entry = (unread: boolean, mentions: number) => ({
      channelId: CH,
      lastReadSeq: 0,
      seenSeq: 3,
      unread,
      mentions,
    });
    useUnread.setState({ ready: true, byConversation: { [B]: entry(true, 0), [C]: entry(true, 120) } });
    try {
      const qc = createQueryClient(() => {});
      qc.setQueryData(qk.me, { ...ME });
      const { renderWithClient } = await import("../../../test/messages");
      renderWithClient(<ConversationList channelId={CH} conversationId={A} />, qc);
      const b = await screen.findByRole("link", { name: /세션-2/ });
      expect(b).toHaveAttribute("data-unread", "true");
      expect(within(b).getByText("읽지 않음")).toBeInTheDocument();
      const c = screen.getByRole("link", { name: /세션-3/ });
      expect(within(c).getByText("99+")).toBeInTheDocument();
      expect(within(c).getByText("나를 멘션한 글 120개")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /세션-1/ })).not.toHaveAttribute("data-unread");
    } finally {
      useUnread.getState().reset();
    }
  });

  it("[태스크 8 Step 0] 세션 화면의 목록 칸은 대화별 읽지 않음 현황으로 점·배지를 그린다 — 두 세션 중 안 읽은 쪽만", async () => {
    stubServer({
      conversations: [conv(A, { lastMessageAt: at(9) }), conv(B, { lastMessageAt: at(5) }), conv(C)],
    });
    const entry = (unread: boolean, mentions: number) => ({
      channelId: CH,
      lastReadSeq: 0,
      seenSeq: 3,
      unread,
      mentions,
    });
    useUnread.setState({
      ready: true,
      byConversation: { [B]: entry(true, 2), [C]: entry(false, 0) },
    });
    try {
      renderRoute(`/c/${CH}/s/${A}`);
      const b = await within(await pane()).findByRole("link", { name: /세션-2/ });
      expect(b).toHaveAttribute("data-unread", "true");
      expect(within(b).getByText("나를 멘션한 글 2개")).toBeInTheDocument();
      const c = within(await pane()).getByRole("link", { name: /세션-3/ });
      expect(c).not.toHaveAttribute("data-unread");
      expect(c.querySelector('[data-slot="unread-dot"], [data-slot="mention-badge"]')).toBeNull();
      // 다른 탭에서 B 를 읽으면 점·배지가 꺼진다 — 칸이 현황을 듣는다
      act(() => useUnread.setState({ byConversation: { [B]: entry(false, 0), [C]: entry(false, 0) } }));
      await waitFor(() => expect(b).not.toHaveAttribute("data-unread"));
      expect(b.querySelector('[data-slot="mention-badge"]')).toBeNull();
      // [태스크 8 리뷰 L2] 스냅숏 전·실패·끊김(ready false)이면 값이 남아 있어도 그리지 않는다 — 끊김·실패의 `failSnapshot` 은 ready 만
      // 내리고 byConversation 을 남긴다(낡은 점·배지)
      act(() => useUnread.setState({ byConversation: { [B]: entry(true, 2), [C]: entry(true, 0) } }));
      await waitFor(() => expect(within(b).getByText("나를 멘션한 글 2개")).toBeInTheDocument());
      act(() => useUnread.setState({ ready: false }));
      await waitFor(() => expect(b).not.toHaveAttribute("data-unread"));
      expect(b.querySelector('[data-slot="unread-dot"], [data-slot="mention-badge"]')).toBeNull();
      expect(c).not.toHaveAttribute("data-unread");
      expect(c.querySelector('[data-slot="unread-dot"], [data-slot="mention-badge"]')).toBeNull();
    } finally {
      useUnread.getState().reset();
    }
  });

  it("[태스크 8 리뷰 L1] 읽지 않음 현황이 바뀌어도 세션 화면은 다시 그리지 않는다 — 다시 그리기는 목록의 그 줄에 갇힌다", async () => {
    stubServer({ conversations: [conv(A, { lastMessageAt: at(9) }), conv(B, { lastMessageAt: at(5) })] });
    const entry = (channelId: string, unread: boolean, mentions: number) => ({
      channelId,
      lastReadSeq: 0,
      seenSeq: 3,
      unread,
      mentions,
    });
    useUnread.setState({ ready: true, byConversation: { [B]: entry(CH, false, 0) } });
    try {
      renderRoute(`/c/${CH}/s/${A}`);
      const b = await within(await pane()).findByRole("link", { name: /세션-2/ });
      await screen.findByRole("textbox", { name: "메시지 입력" });
      // 첫 그리기가 가라앉은 뒤부터 센다
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const settled = pageRenders.count;
      expect(settled).toBeGreaterThan(0);
      // 다른 채널 세션의 남의 글 — 이 화면의 어느 줄 값도 안 바뀐다
      act(() =>
        useUnread.setState((s) => ({
          byConversation: { ...s.byConversation, [uid(5_900)]: entry(CH2, true, 1) },
        })),
      );
      // 이 채널 B 세션의 남의 글 — B 줄만 바뀐다
      act(() =>
        useUnread.setState((s) => ({ byConversation: { ...s.byConversation, [B]: entry(CH, true, 0) } })),
      );
      await waitFor(() => expect(b).toHaveAttribute("data-unread", "true"));
      expect(pageRenders.count).toBe(settled);
    } finally {
      useUnread.getState().reset();
    }
  });
});

describe("새 세션 — 정책·역할", () => {
  it("[정책 managers] member 에게는 머리·목록의 「새 세션」이 없다, 세션 관리자·admin 에게는 있다", async () => {
    stubServer({ role: "member", policy: { create: "managers" }, conversations: [conv(A)] });
    renderRoute(`/c/${CH}/s/${A}`);
    await pane();
    await waitFor(async () =>
      expect(within(await header()).getByTestId("conversation-title")).toBeInTheDocument(),
    );
    expect(within(await header()).queryByRole("link", { name: "새 세션" })).toBeNull();
    expect(within(await pane()).queryByRole("link", { name: /새 세션/ })).toBeNull();
  });

  it.each([
    ["세션 관리자 member", "member", [userMember("u", "manager")]],
    ["admin", "admin", []],
  ] as const)("[정책 managers] %s 에게는 「새 세션」이 있다", async (_, role, members) => {
    stubServer({ role, policy: { create: "managers" }, members: [...members], conversations: [conv(A)] });
    renderRoute(`/c/${CH}/s/${A}`);
    expect(await within(await header()).findByRole("link", { name: "새 세션" })).toHaveAttribute(
      "href",
      `/c/${CH}/s/${NEW_CONVERSATION}`,
    );
    expect(await within(await pane()).findByRole("link", { name: /새 세션/ })).toBeInTheDocument();
  });

  it("[정책 managers] 채널 멤버이지만 세션 관리자가 아닌 member 에게도 「새 세션」이 없다", async () => {
    stubServer({
      role: "member",
      policy: { create: "managers" },
      members: [userMember("u", "member")],
      conversations: [conv(A)],
    });
    renderRoute(`/c/${CH}/s/${A}`);
    await waitFor(async () => expect(await itemTitles()).toEqual(["세션-1"]));
    expect(within(await header()).queryByRole("link", { name: "새 세션" })).toBeNull();
    expect(within(await pane()).queryByRole("link", { name: /새 세션/ })).toBeNull();
  });

  it("보관한 채널에는 owner 에게도 「새 세션」이 없고 제목은 버튼이 아니다(서버가 409)", async () => {
    stubServer({ archived: true, conversations: [conv(A, { title: "보관 전" })] });
    renderRoute(`/c/${CH}/s/${A}`);
    const title = await within(await header()).findByTestId("conversation-title");
    expect(title).toHaveTextContent("보관 전");
    expect(title.tagName).not.toBe("BUTTON");
    await waitFor(async () => expect(await itemTitles()).toEqual(["보관 전"]));
    expect(within(await header()).queryByRole("link", { name: "새 세션" })).toBeNull();
    expect(within(await pane()).queryByRole("link", { name: /새 세션/ })).toBeNull();
    expect(within(await header()).queryByRole("button", { name: "세션 닫기" })).toBeNull();
  });

  it("[태스크 5 리뷰 ②] 정책 managers 의 member 가 새 세션 창에 오면 작성기 대신 안내", async () => {
    stubServer({ role: "member", policy: { create: "managers" } });
    renderRoute(`/c/${CH}/s/${NEW_CONVERSATION}`);
    expect(await screen.findByTestId("conversation-cannot-create")).toHaveTextContent(
      "이 채널은 세션 관리자만 새 세션을 만들 수 있습니다.",
    );
    expect(screen.queryByRole("textbox", { name: "메시지 입력" })).toBeNull();
  });

  it("정책 members 면 member 도 새 세션 창에서 작성기를 본다(받는 동안 안내가 번쩍이지 않는다)", async () => {
    stubServer({ role: "member" });
    renderRoute(`/c/${CH}/s/${NEW_CONVERSATION}`);
    expect(await screen.findByRole("textbox", { name: "메시지 입력" })).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-cannot-create")).toBeNull();
  });
});

describe("새 세션 — 서버 거절", () => {
  it("[태스크 5 리뷰 ②] 새 세션 첫 글이 FORBIDDEN 이면 「다시 보내기」 없이 「권한이 없어 보내지 못했습니다」, 채널을 다시 받아 작성기가 안내로", async () => {
    const server = stubServer({ role: "member" });
    fake.onAck("message.send", () => ({
      ok: false,
      error: { code: "FORBIDDEN", message: "이 채널은 세션 관리자만 새 세션을 만들 수 있다" },
    }));
    renderRoute(`/c/${CH}/s/${NEW_CONVERSATION}`);
    const box = await screen.findByRole("textbox", { name: "메시지 입력" });
    // 이 탭이 모르는 사이 정책이 「세션 관리자만」으로 바뀌었다
    server.state.policy = { create: "managers" };
    const editor = (box as unknown as { editor: import("@tiptap/core").Editor }).editor;
    act(() => {
      editor.commands.setContent("만들어 줘");
      editor.commands.focus("end");
    });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("권한이 없어 보내지 못했습니다")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다시 보내기" })).toBeNull();
    expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
    expect(await screen.findByTestId("conversation-cannot-create")).toBeInTheDocument();
  });
});

describe("채널 설정 「세션」 칸", () => {
  const section = async () => screen.findByRole("region", { name: "세션" });

  it("admin 은 정책을 고르면 곧바로 PATCH {sessionPolicy}, 세션 관리자를 지정(PUT)·해제(DELETE)한다", async () => {
    const people = [
      { id: "u", handle: "owner", displayName: "주인", role: "owner", deactivatedAt: null },
      { id: "mia", handle: "mia", displayName: "미아", role: "member", deactivatedAt: null },
      { id: "gone", handle: "gone", displayName: "떠남", role: "member", deactivatedAt: at(1) },
    ];
    const server = stubServer({ role: "admin", conversations: [conv(A)] });
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (input, init) =>
        String(input) === "/api/v1/people" ? json(200, { people }) : inner(input, init),
      ),
    );
    renderRoute(`/c/${CH}/s/${A}/settings`);
    const region = await section();
    const managersOnly = within(region).getByRole("radio", { name: "세션 관리자만" });
    expect(within(region).getByRole("radio", { name: "누구나" })).toBeChecked();
    await userEvent.click(managersOnly);
    await waitFor(() => expect(managersOnly).toBeChecked());
    expect(server.writes()).toEqual([
      { method: "PATCH", url: `/api/v1/channels/${CH}`, body: { sessionPolicy: { create: "managers" } } },
    ]);

    expect(within(region).getByText("세션 관리자가 없습니다.")).toBeInTheDocument();
    const select = within(region).getByRole("combobox", { name: "세션 관리자 지정" });
    // 비활성 멤버는 고를 수 없다
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["사람 선택", "@owner — 주인", "@mia — 미아"]);
    await userEvent.selectOptions(select, "mia");
    await userEvent.click(within(region).getByRole("button", { name: "지정" }));
    const list = await within(region).findByRole("list", { name: "세션 관리자" });
    expect(within(list).getByText("@mia — 미아")).toBeInTheDocument();
    await userEvent.click(within(list).getByRole("button", { name: "@mia — 미아 세션 관리자 해제" }));
    await waitFor(() => expect(within(region).getByText("세션 관리자가 없습니다.")).toBeInTheDocument());
    expect(server.writes().slice(1)).toEqual([
      { method: "PUT", url: `/api/v1/channels/${CH}/session-managers/mia` },
      { method: "DELETE", url: `/api/v1/channels/${CH}/session-managers/mia` },
    ]);
  });

  it("member 는 값만 본다 — 정책은 잠기고 지정·해제가 없다(admin 이상만 바꾼다)", async () => {
    const server = stubServer({
      role: "member",
      policy: { create: "managers" },
      members: [userMember("u", "manager")],
      conversations: [conv(A)],
    });
    renderRoute(`/c/${CH}/s/${A}/settings`);
    const region = await section();
    expect(within(region).getByText("관리자만 바꿀 수 있습니다")).toBeInTheDocument();
    const managersOnly = within(region).getByRole("radio", { name: "세션 관리자만" });
    expect(managersOnly).toBeChecked();
    expect(managersOnly).toBeDisabled();
    expect(within(region).getByRole("radio", { name: "누구나" })).toBeDisabled();
    await userEvent.click(within(region).getByRole("radio", { name: "누구나" }));
    expect(
      within(await within(region).findByRole("list", { name: "세션 관리자" })).getByText("@owner — 주인"),
    ).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: /해제/ })).toBeNull();
    expect(within(region).queryByRole("combobox", { name: "세션 관리자 지정" })).toBeNull();
    expect(server.writes()).toEqual([]);
  });
});

describe("머리의 세션 제목", () => {
  it("member 는 남의 세션 제목을 못 바꾼다 — 제목이 버튼이 아니다, 닫기 단추도 없다", async () => {
    stubServer({
      role: "member",
      conversations: [conv(A, { title: "남의 것", createdBy: { type: "user", id: OTHER } })],
    });
    renderRoute(`/c/${CH}/s/${A}`);
    const title = await within(await header()).findByTestId("conversation-title");
    expect(title).toHaveTextContent("남의 것");
    expect(title.tagName).not.toBe("BUTTON");
    expect(within(await header()).queryByRole("button", { name: "세션 닫기" })).toBeNull();
  });

  it("만든 member 는 제목을 눌러 이름을 바꾼다 — PATCH {title}, 머리가 바뀌고 닫으면 초점이 제목으로", async () => {
    const server = stubServer({ role: "member", conversations: [conv(A, { title: "처음" })] });
    renderRoute(`/c/${CH}/s/${A}`);
    const button = await within(await header()).findByRole("button", { name: "처음" });
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "세션 이름 바꾸기" });
    const input = within(dialog).getByRole("textbox", { name: "세션 제목" });
    await userEvent.clear(input);
    await userEvent.type(input, "  배포 준비 ");
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.writes()).toEqual([
      { method: "PATCH", url: `/api/v1/conversations/${A}`, body: { title: "배포 준비" } },
    ]);
    const renamed = await within(await header()).findByRole("button", { name: "배포 준비" });
    await waitFor(() => expect(renamed).toHaveFocus());
    await waitFor(async () => expect(await itemTitles()).toEqual(["배포 준비"]));
  });

  it("빈 제목은 보내지 않고 칸 아래에 알린다", async () => {
    const server = stubServer({ conversations: [conv(A, { title: "처음" })] });
    renderRoute(`/c/${CH}/s/${A}`);
    await userEvent.click(await within(await header()).findByRole("button", { name: "처음" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.clear(within(dialog).getByRole("textbox", { name: "세션 제목" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(within(dialog).getByText("제목은 1~80자로 씁니다")).toBeInTheDocument();
    expect(server.writes()).toEqual([]);
  });
});

describe("닫기·다시 열기", () => {
  it("머리의 「세션 닫기」 → 확인 → PATCH {closed:true}, 작성기 자리가 「닫힌 세션입니다」·「다시 열기」, 초점은 안내로", async () => {
    const server = stubServer({ conversations: [conv(A)] });
    renderRoute(`/c/${CH}/s/${A}`);
    await userEvent.click(await within(await header()).findByRole("button", { name: "세션 닫기" }));
    const dialog = await screen.findByRole("dialog", { name: "세션 닫기" });
    await userEvent.click(within(dialog).getByRole("button", { name: "세션 닫기" }));
    const notice = await screen.findByTestId("conversation-closed");
    expect(server.writes()).toEqual([
      { method: "PATCH", url: `/api/v1/conversations/${A}`, body: { closed: true } },
    ]);
    expect(notice).toHaveTextContent("닫힌 세션입니다");
    await waitFor(() => expect(within(notice).getByText("닫힌 세션입니다")).toHaveFocus());
    expect(screen.queryByRole("textbox", { name: "메시지 입력" })).toBeNull();
    expect(within(await header()).getByText("닫힘")).toBeInTheDocument();

    await userEvent.click(within(notice).getByRole("button", { name: "다시 열기" }));
    expect(await screen.findByRole("textbox", { name: "메시지 입력" })).toBeInTheDocument();
    expect(server.writes().at(-1)).toEqual({
      method: "PATCH",
      url: `/api/v1/conversations/${A}`,
      body: { closed: false },
    });
    expect(screen.queryByTestId("conversation-closed")).toBeNull();
  });

  it("[Review Focus 2] 다른 탭·다른 사람이 닫으면(conversation.updated) 보던 화면의 작성기가 안내로 바뀌고 초점을 뺏지 않는다. 실패 항목은 「다시 보내기」 없이 남는다", async () => {
    stubServer({ conversations: [conv(A)] });
    // 앞서 다른 사유(시간 초과)로 실패한 내 글 하나
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData<Timeline>(qk.timeline(CH, A), {
      ...emptyTimeline(),
      items: [msg(1, { conversationId: A })],
      lastSeq: 1,
      pending: [{ clientMsgId: "p1", channelId: CH, bodyMd: "늦은 글", createdAt: at(1), state: "failed" }],
    });
    renderRoute(`/c/${CH}/s/${A}`, queryClient);
    const live = liveHandlers(queryClient);
    const box = await screen.findByRole("textbox", { name: "메시지 입력" });
    expect(await screen.findByRole("button", { name: "다시 보내기" })).toBeInTheDocument();
    const outside = screen.getByRole("link", { name: "채널 설정" });
    outside.focus();

    live.emit("conversation.updated", { conversation: conv(A, { closedAt: at(3), closedBy: OTHER }) });

    const notice = await screen.findByTestId("conversation-closed");
    expect(notice).toHaveTextContent("닫힌 세션입니다");
    expect(box).not.toBeVisible();
    expect(screen.queryByRole("textbox", { name: "메시지 입력" })).toBeNull();
    expect(outside).toHaveFocus();
    expect(screen.queryByRole("button", { name: "다시 보내기" })).toBeNull();
    expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
    live.detach();
  });

  it("[태스크 8 브라우저] 다른 사람이 닫을 때 작성기에서 쓰던 중이면 초점은 안내로 간다 — 숨은 작성기에 남지 않는다", async () => {
    stubServer({ conversations: [conv(A)] });
    const { queryClient } = renderRoute(`/c/${CH}/s/${A}`);
    const live = liveHandlers(queryClient);
    const box = await screen.findByRole("textbox", { name: "메시지 입력" });
    act(() => box.focus());
    expect(box).toHaveFocus();

    live.emit("conversation.updated", { conversation: conv(A, { closedAt: at(3), closedBy: OTHER }) });

    const notice = await screen.findByTestId("conversation-closed");
    await waitFor(() => expect(within(notice).getByText("닫힌 세션입니다")).toHaveFocus());
    live.detach();
  });

  it("[태스크 5 리뷰 ①] 닫힌 세션의 카드는 보관 채널처럼 잠긴다 — 사유 「닫힌 세션입니다」", async () => {
    stubServer({ conversations: [conv(A, { closedAt: at(3) })] });
    const card = msg(1, {
      conversationId: A,
      authorType: "agent",
      components: ComponentsV1.parse({
        id: "cmp_1",
        blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "확인" }] }],
      }),
      componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
    });
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData<Timeline>(qk.timeline(CH, A), { ...emptyTimeline(), items: [card], lastSeq: 1 });
    renderRoute(`/c/${CH}/s/${A}`, queryClient);
    const button = await screen.findByRole("button", { name: "확인" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("닫힌 세션입니다");
  });
});

describe("닫힌 세션 — 권한·스레드·리액션·카드", () => {
  it("[태스크 8 브라우저] 「다시 열기」 응답 전에 안내가 언마운트돼도(세션 캐시가 먼저 열림으로 바뀜) onReopened 가 불린다 — 초점을 작성기로 옮기는 신호", async () => {
    const { ClosedNotice } = await import("./ClosedNotice");
    const { renderWithClient } = await import("../../../test/messages");
    const closedA = conv(A, { closedAt: at(3), closedBy: ME.user.id });
    stubServer({ conversations: [closedA] });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const base = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (input, init) => {
        if ((init?.method ?? "GET") === "PATCH") await gate;
        return base(input, init);
      }),
    );
    const qc = createQueryClient(() => {});
    qc.setQueryData(qk.me, { ...ME });
    const onReopened = vi.fn();
    const view = renderWithClient(
      <ClosedNotice channelId={CH} conversation={closedA} reopen onReopened={onReopened} />,
      qc,
    );
    await userEvent.click(await screen.findByRole("button", { name: "다시 열기" }));
    // 브라우저에서는 훅의 onSuccess(캐시를 열림으로)가 부모를 곧바로 다시 그려 이 안내가 먼저 사라진다
    view.unmount();
    release();
    await waitFor(() => expect(onReopened).toHaveBeenCalledTimes(1));
  });

  it("[태스크 8 리뷰 L5] 「다시 열기」가 실패(403)하면 onReopened 를 부르지 않고(초점이 숨은 작성기로 가지 않는다) 토스트로 알린다", async () => {
    const { ClosedNotice } = await import("./ClosedNotice");
    const { renderWithClient } = await import("../../../test/messages");
    const { toast } = await import("sonner");
    const toasted = vi.spyOn(toast, "error");
    const closedA = conv(A, { closedAt: at(3), closedBy: ME.user.id });
    const server = stubServer({ conversations: [closedA] });
    const base = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (input, init) =>
        (init?.method ?? "GET") === "PATCH"
          ? json(403, { code: "FORBIDDEN", message: "세션을 바꿀 권한이 없다" })
          : base(input, init),
      ),
    );
    const qc = createQueryClient(() => {});
    qc.setQueryData(qk.me, { ...ME });
    const onReopened = vi.fn();
    renderWithClient(
      <ClosedNotice channelId={CH} conversation={closedA} reopen onReopened={onReopened} />,
      qc,
    );
    const button = await screen.findByRole("button", { name: "다시 열기" });
    await userEvent.click(button);
    await waitFor(() => expect(toasted).toHaveBeenCalledWith("권한이 없습니다", { id: "forbidden" }));
    await waitFor(() => expect(button).toBeEnabled());
    expect(onReopened).not.toHaveBeenCalled();
    expect(server.state.conversations[0]?.closedAt).toBeDefined();
  });

  it("member 는 남의 닫힌 세션에서 「다시 열기」를 보지 않는다", async () => {
    stubServer({
      role: "member",
      conversations: [conv(A, { closedAt: at(3), createdBy: { type: "user", id: OTHER } })],
    });
    renderRoute(`/c/${CH}/s/${A}`);
    const notice = await screen.findByTestId("conversation-closed");
    expect(notice).toHaveTextContent("닫힌 세션입니다");
    expect(within(notice).queryByRole("button", { name: "다시 열기" })).toBeNull();
  });

  it("닫힌 세션의 스레드 패널은 작성기 대신 안내(「다시 열기」 없음)", async () => {
    const root = msg(1, { conversationId: A, bodyMd: "루트 질문" });
    stubServer({ conversations: [conv(A, { closedAt: at(3) })] });
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData<Timeline>(qk.timeline(CH, A), { ...emptyTimeline(), items: [root], lastSeq: 1 });
    queryClient.setQueryData<Timeline>(
      qk.thread(CH, A, root.id),
      threadFromPage(undefined, root, [root], false),
    );
    renderRoute(`/c/${CH}/s/${A}/t/${root.id}`, queryClient);
    const panel = await screen.findByTestId("thread-panel");
    expect(await within(panel).findByTestId("conversation-closed")).toHaveTextContent("닫힌 세션입니다");
    expect(within(panel).queryByRole("textbox", { name: "스레드 답글 입력" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "다시 열기" })).toBeNull();
  });

  it("닫힌 세션에서는 반응을 달 수 없다 — 다시 열리면(conversation.updated) 「반응 추가」가 돌아온다", async () => {
    stubServer({ conversations: [conv(A, { closedAt: at(3) })] });
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData<Timeline>(qk.timeline(CH, A), {
      ...emptyTimeline(),
      items: [msg(1, { conversationId: A, bodyMd: "반응 대상" })],
      lastSeq: 1,
    });
    renderRoute(`/c/${CH}/s/${A}`, queryClient);
    const live = liveHandlers(queryClient);
    await screen.findByTestId("conversation-closed");
    expect(screen.getByText("반응 대상")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "반응 추가" })).toBeNull();
    live.emit("conversation.updated", { conversation: conv(A) });
    expect(await screen.findByRole("button", { name: "반응 추가" })).toBeInTheDocument();
    live.detach();
  });

  it("카드 응답이 CONVERSATION_CLOSED 면(이 탭이 닫힘을 모른다) 세션을 다시 받아 카드가 잠기고 작성기 자리가 안내로", async () => {
    const server = stubServer({ conversations: [conv(A)] });
    const card = msg(1, {
      conversationId: A,
      authorType: "agent",
      components: ComponentsV1.parse({
        id: "cmp_1",
        blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "확인" }] }],
      }),
      componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
    });
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData<Timeline>(qk.timeline(CH, A), { ...emptyTimeline(), items: [card], lastSeq: 1 });
    fake.onAck("component.interact", () => ({
      ok: false,
      error: { code: "CONVERSATION_CLOSED", message: "closed" },
    }));
    renderRoute(`/c/${CH}/s/${A}`, queryClient);
    await screen.findByRole("textbox", { name: "메시지 입력" });
    server.state.conversations[0] = conv(A, { closedAt: at(3), closedBy: OTHER });
    await userEvent.click(await screen.findByRole("button", { name: "확인" }));
    expect(await screen.findByTestId("conversation-closed")).toBeInTheDocument();
    expect(server.gets(`/conversations/${A}`)).toBe(2);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "확인" })).toHaveAccessibleDescription("닫힌 세션입니다"),
    );
  });
});

describe("[태스크 6 리뷰 M1] 닫힘·다시 열기를 이벤트로 놓쳤을 때", () => {
  it("보내기 ack 가 CONVERSATION_CLOSED 면 세션을 다시 받아 작성기 자리가 안내로 바뀐다", async () => {
    const server = stubServer({ conversations: [conv(A)] });
    fake.onAck("message.send", () => ({
      ok: false,
      error: { code: "CONVERSATION_CLOSED", message: "closed" },
    }));
    renderRoute(`/c/${CH}/s/${A}`);
    await screen.findByRole("textbox", { name: "메시지 입력" });
    await waitFor(() => expect(server.gets(`/conversations/${A}`)).toBe(1));
    // 끊긴 사이 다른 사람이 닫았다 — 이 탭은 conversation.updated 를 받지 못했다
    server.state.conversations[0] = conv(A, { closedAt: at(3), closedBy: OTHER });
    await typeAndSend("늦은 글");
    expect(await screen.findByTestId("conversation-closed")).toBeInTheDocument();
    expect(server.gets(`/conversations/${A}`)).toBe(2);
    expect(screen.queryByRole("textbox", { name: "메시지 입력" })).toBeNull();
    expect(within(await header()).getByText("닫힘")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다시 보내기" })).toBeNull();
  });

  it("다시 붙으면 세션 하나를 다시 받는다 — 끊긴 사이 닫힌 세션의 작성기가 안내로", async () => {
    const server = stubServer({ conversations: [conv(A)] });
    const { queryClient } = renderRoute(`/c/${CH}/s/${A}`);
    const live = liveHandlers(queryClient);
    live.emit("connect");
    await screen.findByRole("textbox", { name: "메시지 입력" });
    server.state.conversations[0] = conv(A, { closedAt: at(3), closedBy: OTHER });
    live.emit("connect");
    expect(await screen.findByTestId("conversation-closed")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "메시지 입력" })).toBeNull();
    live.detach();
  });

  it("다시 붙으면 목록도 다시 받는다 — 끊긴 사이 다시 열리고 이름이 바뀐 세션이 열림 목록·머리에 돌아온다", async () => {
    const server = stubServer({ conversations: [conv(A, { title: "닫힌 것", closedAt: at(3) }), conv(B)] });
    const { queryClient } = renderRoute(`/c/${CH}/s/${A}`);
    const live = liveHandlers(queryClient);
    live.emit("connect");
    await screen.findByTestId("conversation-closed");
    await waitFor(async () => expect(await itemTitles()).toEqual(["세션-2"]));
    server.state.conversations[0] = conv(A, { title: "다시 연 것", lastMessageAt: at(9) });
    live.emit("connect");
    expect(await screen.findByRole("textbox", { name: "메시지 입력" })).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-closed")).toBeNull();
    expect(await within(await header()).findByRole("button", { name: "다시 연 것" })).toBeInTheDocument();
    await waitFor(async () => expect(await itemTitles()).toEqual(["다시 연 것", "세션-2"]));
    live.detach();
  });
});

describe("주소·세션 전환", () => {
  it("[태스크 5 리뷰 ③] 주소의 채널과 세션의 채널이 다르면 그 세션의 채널 주소로 바꿔 간다(replace, 패널 탭 그대로)", async () => {
    const elsewhere = conversationOf(CH2, { id: B, title: "다른 채널 세션" });
    const server = stubServer({ conversations: [conv(A)] });
    server.state.conversations.push(elsewhere);
    const { history, queryClient } = renderRoute(`/c/${CH}/s/${B}/settings`);
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH2}/s/${B}/settings`));
    expect(history.length).toBe(1);
    // 틀린 짝은 최근 본 세션으로 남지 않는다(오프라인 사본)
    expect(queryClient.getQueryData<Record<string, string>>(qk.recentConversations)?.[CH]).toBeUndefined();
  });

  it("[태스크 5 리뷰 ④] 새 세션 창에서 첫 ack 를 기다리는 사이 쓴 초안·넣은 이미지 칩은 그 세션으로 들고 간다 — 다른 세션으로 옮기면 비운다", async () => {
    stubServer({ conversations: [conv(A)] });
    const created = conv(B, { title: "첫 글" });
    let release: (r: Result<unknown>) => void = () => {};
    fake.onAck(
      "message.send",
      () =>
        new Promise<Result<unknown>>((resolve) => {
          release = resolve;
        }),
    );
    const { history, queryClient } = renderRoute(`/c/${CH}/s/${NEW_CONVERSATION}`);
    const box = await screen.findByRole("textbox", { name: "메시지 입력" });
    const editor = (box as unknown as { editor: import("@tiptap/core").Editor }).editor;
    act(() => {
      editor.commands.setContent("첫 글");
      editor.commands.focus("end");
    });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fake.sentOf("message.send")).toHaveLength(1));
    // ack 를 기다리는 사이 다음 글을 쓰고 이미지를 넣는다(올리기는 끝나지 않아도 된다 — 칩이 남는지만 본다)
    act(() => editor.commands.setContent("다음 글 초안"));
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement,
      pngFile("a.png"),
    );
    const chips = () => screen.queryByRole("list", { name: "첨부할 이미지" });
    expect(chips()).not.toBeNull();

    await act(async () =>
      release({
        ok: true,
        data: { message: msg(2, { conversationId: B, bodyMd: "첫 글" }), conversation: created },
      }),
    );
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/s/${B}`), { timeout: 3000 });
    expect(editor.getText()).toBe("다음 글 초안");
    expect(chips()).not.toBeNull();
    expect(FakeXhr.all[0]?.aborted).toBe(false);
    expect(getTimeline(queryClient, CH, B)?.items.map((m) => m.bodyMd)).toEqual(["첫 글"]);

    // 다른 세션으로 옮기면 세션 전환이다 — 칩은 비우고 초안은 B 몫으로 남는다
    await userEvent.click(within(await pane()).getByRole("link", { name: /세션-1/ }));
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/s/${A}`));
    expect(chips()).toBeNull();
    expect(editor.getText()).toBe("");
    // 다음에 새 세션 창을 열면 빈 작성기다(창 몫 초안은 들고 간 뒤 지웠다)
    await userEvent.click(within(await pane()).getByRole("link", { name: /새 세션/ }));
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/s/${NEW_CONVERSATION}`));
    expect(editor.getText()).toBe("");
    // 표는 한 번만 쓴다 — 이번에는 창에서 쓴 초안을 B 로 들고 가지 않고 B 몫 초안을 꺼낸다
    act(() => editor.commands.setContent("창 초안"));
    await userEvent.click(within(await pane()).getByRole("link", { name: /첫 글/ }));
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/s/${B}`));
    expect(editor.getText()).toBe("다음 글 초안");
  });

  it("[태스크 6 리뷰 L2] 새 세션 창에서 첫 ack 전에 다른 세션으로 옮기면 칩·초안을 비우고, ack 뒤에도 그 세션 작성기에 창 초안이 들어오지 않는다", async () => {
    stubServer({ conversations: [conv(A)] });
    let release: (r: Result<unknown>) => void = () => {};
    fake.onAck(
      "message.send",
      () =>
        new Promise<Result<unknown>>((resolve) => {
          release = resolve;
        }),
    );
    const { history, queryClient } = renderRoute(`/c/${CH}/s/${NEW_CONVERSATION}`);
    const editor = await typeAndSend("첫 글");
    await waitFor(() => expect(fake.sentOf("message.send")).toHaveLength(1));
    act(() => editor.commands.setContent("창 초안"));
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    await userEvent.upload(
      document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement,
      pngFile("a.png"),
    );
    const chips = () => screen.queryByRole("list", { name: "첨부할 이미지" });
    expect(chips()).not.toBeNull();

    await userEvent.click(within(await pane()).getByRole("link", { name: /세션-1/ }));
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/s/${A}`));
    expect(chips()).toBeNull();
    expect(editor.getText()).toBe("");

    await act(async () =>
      release({
        ok: true,
        data: { message: msg(2, { conversationId: B, bodyMd: "첫 글" }), conversation: conv(B) },
      }),
    );
    await waitFor(() => expect(getTimeline(queryClient, CH, B)?.items).toHaveLength(1));
    expect(history.location.pathname).toBe(`/c/${CH}/s/${A}`);
    expect(editor.getText()).toBe("");
    expect(chips()).toBeNull();
  });

  it("[태스크 6 리뷰 L4] 표가 생긴 뒤 주소가 그 세션으로 바뀌기 전에 다른 채널로 가면 표를 지운다 — 뒤에 새 세션 창에서 그 세션으로 가도 창 초안을 들고 가지 않는다", async () => {
    const server = stubServer({ conversations: [conv(A)] });
    server.state.conversations.push(conversationOf(CH2, { id: C, title: "다른 채널" }));
    let release: (r: Result<unknown>) => void = () => {};
    fake.onAck(
      "message.send",
      () =>
        new Promise<Result<unknown>>((resolve) => {
          release = resolve;
        }),
    );
    const { history, router, queryClient } = renderRoute(`/c/${CH}/s/${NEW_CONVERSATION}`);
    await typeAndSend("첫 글");
    await waitFor(() => expect(fake.sentOf("message.send")).toHaveLength(1));

    // ack 가 표를 남기고 주소를 바꾸러 가는 사이(아직 그리기 전) 다른 채널로 간다
    server.state.conversations.push(conv(B));
    await act(async () => {
      release({
        ok: true,
        data: { message: msg(2, { conversationId: B, bodyMd: "첫 글" }), conversation: conv(B) },
      });
      for (let i = 0; i < 50 && settledFromNew(queryClient, CH) !== B; i++) await Promise.resolve();
      expect(settledFromNew(queryClient, CH)).toBe(B);
      void router.navigate({ href: `/c/${CH2}/s/${C}` });
    });
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH2}/s/${C}`));
    expect(settledFromNew(queryClient, CH)).toBeUndefined();

    await act(() => router.navigate({ href: `/c/${CH}/s/${NEW_CONVERSATION}` }));
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/s/${NEW_CONVERSATION}`));
    // 채널을 옮기며 작성기가 새로 떴을 수 있다 — 편집기를 다시 찾는다
    const box = await screen.findByRole("textbox", { name: "메시지 입력" });
    const editor = (box as unknown as { editor: import("@tiptap/core").Editor }).editor;
    act(() => editor.commands.setContent("창 초안"));
    await userEvent.click(within(await pane()).getByRole("link", { name: /세션-2/ }));
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/s/${B}`));
    expect(editor.getText()).toBe("");
  });
});

describe("좁은 화면(390px)", () => {
  it("세션 목록은 시트로 열리고, 고르거나 닫으면 초점이 머리의 「세션 목록」으로 돌아온다", async () => {
    stubMedia(true);
    stubServer({ conversations: [conv(A), conv(B, { lastMessageAt: at(9) })] });
    const { history } = renderRoute(`/c/${CH}/s/${A}`);
    expect(screen.queryByRole("navigation", { name: "세션 목록" })).toBeNull();
    const opener = await within(await header()).findByRole("button", { name: "세션 목록" });
    expect(opener).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "세션 목록" });
    expect(opener).toHaveAttribute("aria-expanded", "true");
    // 머리 오른쪽은 시트의 닫기 단추 자리 — 「새 세션」이 그 밑에 깔리지 않는다(태스크 8 브라우저 390px)
    expect(within(sheet).getByRole("heading", { name: "세션", level: 2 }).parentElement).toHaveClass("pr-12");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).toHaveFocus();
    expect(sheet).not.toBeInTheDocument();

    await userEvent.click(opener);
    await userEvent.click(
      await within(await screen.findByRole("dialog")).findByRole("link", { name: /세션-2/ }),
    );
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/s/${B}`));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        within(screen.getByTestId("channel-header")).getByRole("button", { name: "세션 목록" }),
      ).toHaveFocus(),
    );
  });

  it("넓은 화면은 칸으로 펼쳐 두고 「세션 목록」이 접고 편다", async () => {
    stubMedia(false);
    stubServer({ conversations: [conv(A)] });
    renderRoute(`/c/${CH}/s/${A}`);
    await pane();
    const toggle = within(await header()).getByRole("button", { name: "세션 목록" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle);
    expect(screen.queryByRole("navigation", { name: "세션 목록" })).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(await pane()).toBeInTheDocument();
  });
});

it("applyConversation — 세션 하나 캐시를 갈아 끼우고, 목록 칸에 없으면 첫 쪽 앞에", () => {
  const qc = createQueryClient(() => {});
  const key = qk.conversationList(CH, "closed", "");
  qc.setQueryData(key, pages([conv(A, { closedAt: at(1) })]));
  applyConversation(qc, conv(B, { closedAt: at(2) }));
  expect(qc.getQueryData<Conversation>(qk.conversation(B))?.closedAt).toBe(at(2));
  expect(visibleConversations(qc.getQueryData(key), "closed", "").map((c) => c.id)).toEqual([B, A]);
  // 다시 열면 그 자리를 고친다 — 닫힘 목록에서 빠진다
  applyConversation(qc, conv(B));
  expect(visibleConversations(qc.getQueryData(key), "closed", "").map((c) => c.id)).toEqual([A]);
  expect(composerSlot()).toBeNull();
});
