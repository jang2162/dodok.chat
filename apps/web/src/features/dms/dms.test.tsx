import type { Agent, Channel, Conversation, DmSummary, Message } from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { canDecideApproval } from "@/features/approvals/decider";
import { resetApprovalNotices } from "@/features/approvals/notify";
import { DATE_GROUP_LABEL, dateGroupOf } from "@/features/conversations/dateGroups";
import { MessageItem } from "@/features/messages/MessageItem";
import { useUnread } from "@/features/reads/useUnread";
import { attachHandlers } from "@/realtime/handlers";
import { createSubscriptions } from "@/realtime/subscriptions";
import { useWireStatus } from "@/realtime/wire";
import { flushEditorFrames } from "../../../test/composerHarness";
import { dmChannelOf, dmOf } from "../../../test/dms";
import { stubEditorDom, stubNotification } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, approval, CH, msg, uid } from "../../../test/fixtures";
import { stubMedia } from "../../../test/media";
import { renderWithClient } from "../../../test/messages";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { agentOf } from "../../../test/settingsServer";
import { ME, conversationOf, json, renderRoute, shellGet } from "../../../test/shellApi";
import { type DmView, DmViewContext } from "./context";
import { DM_FIRST_NOTICE } from "./DmNotices";
import { canOpenDm, DM_READ_ONLY_TEXT } from "./queries";

// 에이전트 DM 계획 태스크 5 — 사이드바 「다이렉트 메시지」·DM 열기·DM 화면·읽기 전용·`dmAccess` 설정(웹)

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

const DM = uid(9);
const DM2 = uid(8);
const A = uid(5_001);
const B = uid(5_002);
const DEV = agentOf(AGENT, "dev", { name: "Dev 봇" });
const FIN = agentOf(uid(12), "fin", { name: "Fin 봇" });
const dmChannel = (over: Partial<Channel> = {}) => dmChannelOf(DM, ME.user.id, AGENT, over);
const conv = (id: string, over: Partial<Conversation> = {}): Conversation =>
  conversationOf(DM, {
    id,
    title: `세션-${id.slice(-1)}`,
    createdBy: { type: "user", id: ME.user.id },
    ...over,
  });

type Call = { method: string; url: string; body?: unknown };

/**
 * DM 화면이 부르는 REST — me(역할), DM 목록·열기, DM 채널·멤버·세션 목록·세션 하나, 채널 PATCH(지시), 에이전트 목록·PATCH. 그 밖은 셸 기본.
 * `dms` 는 서버가 들고 있는 목록이라 테스트가 고친다(다른 탭의 보관 등)
 */
function stubServer({
  role = "owner",
  dms = [dmOf(dmChannel(), DEV)],
  agents = [DEV, FIN],
  conversations = [conv(A)],
}: { role?: string; dms?: DmSummary[]; agents?: Agent[]; conversations?: Conversation[] } = {}) {
  const calls: Call[] = [];
  const state = {
    dms: [...dms],
    agents: [...agents],
    conversations: [...conversations],
    channel: dmChannel(),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url, ...(body === undefined ? {} : { body }) });
      if (url === "/api/v1/auth/me") return json(200, { ...ME, role });
      if (url === "/api/v1/dms" && method === "GET") return json(200, { dms: state.dms });
      if (url === "/api/v1/dms" && method === "POST") {
        const { agentId } = body as { agentId: string };
        const hit = state.dms.find((d) => d.channel.dmAgentId === agentId);
        if (hit) return json(200, { channel: hit.channel });
        const channel = dmChannelOf(DM2, ME.user.id, agentId);
        const agent = state.agents.find((a) => a.id === agentId) as Agent;
        state.dms.push(dmOf(channel, agent, { lastMessageAt: null }));
        return json(200, { channel });
      }
      if (url === "/api/v1/agents" && method === "GET") return json(200, { agents: state.agents });
      const agentPatch = /^\/api\/v1\/agents\/([^/]+)$/.exec(url);
      if (agentPatch && method === "PATCH") {
        const i = state.agents.findIndex((a) => a.id === agentPatch[1]);
        state.agents[i] = { ...(state.agents[i] as Agent), ...(body as Partial<Agent>) };
        return json(200, { agent: state.agents[i] });
      }
      if (url === `/api/v1/channels/${DM}` && method === "GET") return json(200, { channel: state.channel });
      if (url === `/api/v1/channels/${DM}` && method === "PATCH") {
        state.channel = { ...state.channel, ...(body as Partial<Channel>) };
        return json(200, { channel: state.channel });
      }
      const other = state.dms.find((d) => url === `/api/v1/channels/${d.channel.id}`);
      if (other) return json(200, { channel: other.channel });
      if (url === `/api/v1/channels/${DM}/members`) return json(200, { members: [] });
      const list = /^\/api\/v1\/channels\/[^/]+\/conversations\?(.*)$/.exec(url);
      if (list) {
        const status = new URLSearchParams(list[1]).get("status");
        const rows = state.conversations.filter((c) =>
          status === "closed" ? c.closedAt !== undefined : c.closedAt === undefined,
        );
        return json(200, { conversations: list[0].includes(DM) ? rows : [] });
      }
      const one = /^\/api\/v1\/conversations\/([^/?]+)$/.exec(url);
      if (one) {
        const c = state.conversations.find((x) => x.id === one[1]);
        return c ? json(200, { conversation: c }) : json(404, { code: "NOT_FOUND", message: "x" });
      }
      return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
    }),
  );
  return {
    calls,
    state,
    count: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.url === `/api/v1${path}`).length,
    bodies: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.url === `/api/v1${path}`).map((c) => c.body),
  };
}

/** 실제 핸들러를 같은 QueryClient 에 붙인다 — 다른 탭의 변경이 wire 로 오는 길 */
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

const composerSlot = () => document.querySelector<HTMLElement>('[data-slot="composer"]');
async function typeAndSend(text: string) {
  const box = await screen.findByRole("textbox", { name: "메시지 입력" });
  const editor = (box as unknown as { editor: import("@tiptap/core").Editor }).editor;
  act(() => {
    editor.commands.setContent(text);
    editor.commands.focus("end");
  });
  // `focus` 는 다음 프레임에 초점을 한 번 더 건다 — 보내기 뒤의 초점 이동(사유 줄)을 그 프레임이 덮지 않게 먼저 비운다
  await flushEditorFrames();
  fireEvent.keyDown(box, { key: "Enter" });
}

let fake: FakeSocket;
let restoreDom: Array<() => void>;
beforeEach(() => {
  restoreDom = [stubEditorDom(), stubScrollLayout()];
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  useUnread.getState().reset();
});
afterEach(async () => {
  await flushEditorFrames();
  for (const restore of restoreDom) restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

const dmNav = () => screen.findByRole("navigation", { name: "다이렉트 메시지" });

describe("사이드바 「다이렉트 메시지」", () => {
  it("글이 있는 내 DM 만 서버 순서(최근 활동순)로 — 글 없는 DM 은 빼고, 채널 절에는 DM 이 없다", async () => {
    stubServer({
      dms: [
        dmOf(dmChannelOf(DM2, ME.user.id, FIN.id), FIN),
        dmOf(dmChannel(), DEV),
        dmOf(dmChannelOf(uid(7), ME.user.id, uid(13)), agentOf(uid(13), "ops", { name: "Ops 봇" }), {
          lastMessageAt: null,
        }),
      ],
    });
    renderRoute(`/c/${CH}/s/new`);
    const nav = await dmNav();
    // 줄 글자는 아바타 머리글자 + 이름
    await waitFor(() =>
      expect(
        within(nav)
          .getAllByRole("link")
          .map((a) => a.textContent),
      ).toEqual(["FFin 봇", "DDev 봇"]),
    );
    expect(within(nav).queryByText("Ops 봇")).toBeNull();
    const channels = screen.getByRole("navigation", { name: "채널" });
    expect(within(channels).queryByText("dm")).toBeNull();
  });

  it("지금 연 DM 은 글이 없어도 보인다", async () => {
    stubServer({ dms: [dmOf(dmChannel(), DEV, { lastMessageAt: null })], conversations: [] });
    renderRoute(`/c/${DM}/s/new`);
    const nav = await dmNav();
    expect(await within(nav).findByRole("link", { name: /Dev 봇/ })).toHaveAttribute("aria-current", "page");
  });

  it("굵게·배지는 지금 읽지 않음 값 그대로 — DM 의 세션 배지를 합친다", async () => {
    stubServer();
    useUnread.getState().applySnapshot({
      conversations: [
        { conversationId: A, channelId: DM, lastReadSeq: 0, latestSeq: 4, unread: true, mentions: 3 },
      ],
      channels: [DM],
    });
    renderRoute(`/c/${CH}/s/new`);
    const link = await within(await dmNav()).findByRole("link", { name: /Dev 봇/ });
    expect(link).toHaveTextContent("(안 읽음)");
    expect(link).toHaveTextContent("(멘션 3개)");
    expect(link.querySelector("[data-mention-badge]")).toHaveTextContent("3");
  });

  it("「+」 는 「DM 할 에이전트」 — 후보는 내 역할로 열 수 있고 보관·꺼짐이 아닌 에이전트, 고르면 DM 을 열어 그 채널로 간다", async () => {
    const open = agentOf(uid(14), "open", { name: "Open 봇", dmAccess: "everyone" });
    const admins = agentOf(uid(15), "boss", { name: "Boss 봇", dmAccess: "admins" });
    const off = agentOf(uid(16), "quiet", { name: "Quiet 봇", dmAccess: "off" });
    const disabled = agentOf(uid(17), "sleep", { name: "Sleep 봇", dmAccess: "everyone", enabled: false });
    const archived = agentOf(uid(18), "gone", {
      name: "Gone 봇",
      dmAccess: "everyone",
      archivedAt: "2026-10-01T00:00:00.000Z",
    });
    const server = stubServer({ role: "member", dms: [], agents: [open, admins, off, disabled, archived] });
    const { router } = renderRoute(`/c/${CH}/s/new`);
    await userEvent.click(await screen.findByRole("button", { name: "DM 할 에이전트 고르기" }));
    const dialog = await screen.findByRole("dialog", { name: "DM 할 에이전트" });
    await within(dialog).findByText("Open 봇");
    expect(
      within(dialog)
        .getAllByRole("button")
        .filter((b) => b.textContent?.includes("봇"))
        .map((b) => b.textContent),
    ).toEqual(["OOpen 봇@open"]);

    await userEvent.click(within(dialog).getByRole("button", { name: /Open 봇/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${DM2}/s/new`));
    expect(server.bodies("POST", "/dms")).toEqual([{ agentId: open.id }]);
  });
});

describe("DM 목록은 셸이 늘 들고 있다(리뷰 M1)", () => {
  let notes: ReturnType<typeof stubNotification>;
  beforeEach(() => {
    useApprovalStore.getState().reset();
    resetApprovalNotices();
    notes = stubNotification("granted");
  });
  afterEach(() => notes.restore());

  it.each([
    ["넓은 화면", false],
    ["좁은 화면(사이드바 시트를 열지 않음)", true],
  ])(
    "%s — 캐시가 빈 채 시작해도 member 주인의 DM 승인은 탭 안 알림(본문 「DM」), DM 새 세션의 첫 글은 읽지 않음 항목, GET /dms 는 한 번",
    async (_label, narrow) => {
      stubMedia(narrow);
      const server = stubServer({ role: "member" });
      useUnread.getState().applySnapshot({ conversations: [], channels: [CH, DM] });
      const { queryClient } = renderRoute(`/c/${CH}/s/new`);
      const live = liveHandlers(queryClient);
      await screen.findByRole("textbox", { name: "메시지 입력" });
      await waitFor(() => expect(queryClient.getQueryData(qk.dms)).toBeDefined());
      // DM 화면을 연 적이 없다 — 상세 캐시가 없어 DM 목록만이 이 채널이 DM 인 것을 안다
      expect(queryClient.getQueryData(qk.channel(DM))).toBeUndefined();
      expect(screen.queryByRole("navigation", { name: "다이렉트 메시지" }) === null).toBe(narrow);

      live.emit("approval.requested", { approval: approval({ channelId: DM, conversationId: A }) });
      expect(notes.made).toHaveLength(1);
      expect(notes.made[0]?.options?.body).toBe("DM");

      const fresh = uid(5_009);
      live.emit("channel.activity", {
        channelId: DM,
        conversationId: fresh,
        seq: 7,
        authorType: "agent",
        authorId: AGENT,
        mentionedUserIds: [ME.user.id],
      });
      expect(useUnread.getState().byConversation[fresh]).toMatchObject({ unread: true, mentions: 1 });

      // 좁은 화면에서 사이드바 시트를 열어 관찰자가 하나 더 붙어도 다시 부르지 않는다
      if (narrow) {
        await userEvent.click(screen.getByRole("button", { name: "채널 목록 열기" }));
        await within(await screen.findByRole("dialog", { name: "채널 목록" })).findByRole("link", {
          name: /Dev 봇/,
        });
      }
      expect(server.count("GET", "/dms")).toBe(1);
      live.detach();
    },
  );
});

describe("DM 열기 — /dm/<에이전트>", () => {
  it("이미 있는 DM 이면 그 채널의 최근 세션으로 넘긴다(기록을 바꿔 쓴다)", async () => {
    stubServer();
    const { router } = renderRoute(`/dm/${AGENT}`);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${DM}/s/${A}`));
  });

  it("403 이면 열 수 없다는 안내 — 넘기지 않는다", async () => {
    stubServer();
    const fetchFn = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (input, init) =>
        String(input) === "/api/v1/dms" && init?.method === "POST"
          ? json(403, { code: "FORBIDDEN", message: "no" })
          : fetchFn(input, init),
      ),
    );
    renderRoute(`/dm/${AGENT}`);
    expect(
      await screen.findByRole("heading", { name: "이 에이전트와 DM 을 열 수 없습니다" }),
    ).toBeInTheDocument();
  });
});

describe("DM 화면", () => {
  it("머리는 에이전트 이름·제공자, 「이 DM 의 지시」·「활동」 — 채널 설정·참여 에이전트 묶음은 없다", async () => {
    stubServer();
    renderRoute(`/c/${DM}/s/${A}`);
    const header = await screen.findByTestId("dm-header");
    expect(await within(header).findByRole("heading", { name: /Dev 봇/ })).toHaveTextContent("OpenClaw");
    expect(within(header).getByRole("button", { name: "이 DM 의 지시" })).toBeInTheDocument();
    expect(within(header).getByRole("link", { name: "활동" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "채널 설정" })).toBeNull();
    expect(screen.queryByRole("group", { name: "참여 에이전트" })).toBeNull();
    expect(screen.queryByTestId("channel-header")).toBeNull();
  });

  it("좁은 머리에서는 제공자 라벨이 이름보다 먼저 줄어든다 — 390px 에서 「dev」가 「d…」로 잘리지 않게", async () => {
    stubServer();
    renderRoute(`/c/${DM}/s/${A}`);
    const heading = await within(await screen.findByTestId("dm-header")).findByRole("heading", {
      name: /Dev 봇/,
    });
    const provider = within(heading).getByText("OpenClaw");
    expect(provider).not.toHaveClass("shrink-0");
    expect(provider).toHaveClass("min-w-0", "shrink-1000", "truncate");
  });

  it("「이 DM 의 지시」 를 저장하면 PATCH { prompt } 하나", async () => {
    const server = stubServer();
    renderRoute(`/c/${DM}/s/${A}`);
    await userEvent.click(await screen.findByRole("button", { name: "이 DM 의 지시" }));
    const dialog = await screen.findByRole("dialog", { name: "이 DM 의 지시" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "이 DM 의 지시" }), "짧게 답해");
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(server.bodies("PATCH", `/channels/${DM}`)).toEqual([{ prompt: "짧게 답해" }]));
  });

  it("설정·스레드 주소로 와도 패널을 그리지 않고, 활동 패널에는 활동 탭만 있다", async () => {
    stubServer();
    const { router } = renderRoute(`/c/${DM}/s/${A}/settings`);
    await screen.findByTestId("dm-header");
    expect(screen.queryByTestId("page-channel-panel")).toBeNull();
    await act(() => router.navigate({ to: `/c/${DM}/s/${A}/activity` }));
    const panel = await screen.findByTestId("page-channel-panel");
    const tabs = within(panel).getByRole("navigation", { name: "패널 탭" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["활동"]);
  });

  it("세션 목록은 날짜 묶음 — 오늘·어제·이번 주·이전 순(브라우저 시간대)", async () => {
    const now = new Date();
    const dayAt = (daysAgo: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 0, 30).toISOString();
    stubServer({
      conversations: [
        conv(A, { lastMessageAt: dayAt(0) }),
        conv(B, { lastMessageAt: dayAt(1) }),
        conv(uid(5_003), { lastMessageAt: dayAt(3) }),
        conv(uid(5_004), { lastMessageAt: dayAt(10) }),
      ],
    });
    renderRoute(`/c/${DM}/s/${A}`);
    const pane = await screen.findByRole("navigation", { name: "세션 목록" });
    await waitFor(() =>
      expect(
        within(pane)
          .getAllByRole("group")
          .map((g) => g.getAttribute("aria-label"))
          .filter((name) => name !== "세션 상태"),
      ).toEqual(["오늘", "어제", "이번 주", "이전"]),
    );
    expect(within(within(pane).getByRole("group", { name: "어제" })).getByText("세션-2")).toBeInTheDocument();
  });

  it("세션이 하나도 없는 DM 은 첫 안내, 세션이 있는 DM 의 새 세션 창은 멘션을 권하지 않는 빈 문구", async () => {
    stubServer({ dms: [dmOf(dmChannel(), DEV, { lastMessageAt: null })], conversations: [] });
    const { router } = renderRoute(`/c/${DM}`);
    expect(await screen.findByText(DM_FIRST_NOTICE)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/c/${DM}/s/new`);
  });

  it("세션이 있는 DM 의 새 세션 창 — 「아직 메시지가 없습니다.」(멘션 안내 없음), @ 후보 없음 자리표시", async () => {
    stubServer();
    renderRoute(`/c/${DM}/s/new`);
    expect(await screen.findByText("아직 메시지가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText(DM_FIRST_NOTICE)).toBeNull();
    const box = await screen.findByRole("textbox", { name: "메시지 입력" });
    await waitFor(() =>
      expect(box.querySelector("[data-placeholder]")).toHaveAttribute("data-placeholder", "메시지 보내기"),
    );
  });
});

describe("DM 의 메시지 줄 — 스레드 없음", () => {
  const ROOT: Message = {
    ...msg(1, { bodyMd: "루트", channelId: DM, conversationId: A }),
    threadSummary: { count: 2, lastAt: "2027-01-15T08:01:00.000Z", agentIds: [AGENT] },
  };
  const view: DmView = { channel: dmChannelOf(DM, ME.user.id, AGENT), readOnly: null };

  it("채널이면 칩·「스레드에서 답하기」가 있고, DM 이면 둘 다 없다", () => {
    const { unmount } = renderWithClient(<MessageItem message={ROOT} head />);
    expect(screen.getByRole("link", { name: "스레드에서 답하기" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /답글 2개/ })).toBeInTheDocument();
    unmount();
    renderWithClient(
      <DmViewContext.Provider value={view}>
        <MessageItem message={ROOT} head />
      </DmViewContext.Provider>,
    );
    expect(screen.queryByRole("link", { name: "스레드에서 답하기" })).toBeNull();
    expect(screen.queryByRole("link", { name: /답글 2개/ })).toBeNull();
    // 반응 추가는 남는다(쓸 수 있는 DM)
    expect(screen.getByRole("button", { name: "반응 추가" })).toBeInTheDocument();
  });

  it("읽기 전용 DM 은 반응을 달 수 없다", () => {
    renderWithClient(
      <DmViewContext.Provider value={{ ...view, readOnly: "agent_disabled" }}>
        <MessageItem message={ROOT} head />
      </DmViewContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "반응 추가" })).toBeNull();
  });
});

describe("읽기 전용 DM (Review Focus 4)", () => {
  it.each(["agent_archived", "agent_disabled", "dm_not_allowed"] as const)(
    "%s — 작성기 자리에 사유 줄, 작성기와 「새 세션」 은 숨는다",
    async (reason) => {
      stubServer({ dms: [dmOf(dmChannel(), DEV, { readOnlyReason: reason })] });
      renderRoute(`/c/${DM}/s/${A}`);
      expect(await screen.findByTestId("dm-read-only")).toHaveTextContent(DM_READ_ONLY_TEXT[reason]);
      expect(screen.queryByRole("textbox", { name: "메시지 입력" })).toBeNull();
      expect(screen.queryByRole("link", { name: "새 세션" })).toBeNull();
    },
  );

  it("세 문구는 계획의 글자 그대로", () => {
    expect(DM_READ_ONLY_TEXT).toEqual({
      agent_archived: "보관된 에이전트라 읽기만 할 수 있습니다",
      agent_disabled: "꺼진 에이전트라 읽기만 할 수 있습니다",
      dm_not_allowed: "이 에이전트와의 DM 이 허용되지 않아 읽기만 할 수 있습니다",
    });
  });

  it("보내기 ack 가 DM_READ_ONLY 면 항목은 사유로 남고(「다시 보내기」 없음) DM 목록을 다시 받아 작성기 자리가 사유 줄로 — 초점은 그 줄로", async () => {
    const server = stubServer();
    fake.onAck("message.send", () => ({
      ok: false,
      error: { code: "DM_READ_ONLY", message: "보관", details: { reason: "agent_archived" } },
    }));
    renderRoute(`/c/${DM}/s/${A}`);
    await screen.findByRole("textbox", { name: "메시지 입력" });
    await waitFor(() => expect(server.count("GET", "/dms")).toBe(1));
    // 다른 탭에서 admin 이 에이전트를 보관했다 — 이 탭은 agents.changed 를 아직 받지 못했다
    server.state.dms = [dmOf(dmChannel(), DEV, { readOnlyReason: "agent_archived" })];
    await typeAndSend("늦은 글");

    const notice = await screen.findByTestId("dm-read-only");
    expect(server.count("GET", "/dms")).toBe(2);
    const pending = document.querySelector('[data-pending="failed"]') as HTMLElement;
    expect(pending).toHaveTextContent(DM_READ_ONLY_TEXT.agent_archived);
    expect(within(pending).queryByRole("button", { name: "다시 보내기" })).toBeNull();
    expect(within(pending).getByRole("button", { name: "삭제" })).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(within(notice).getByText(DM_READ_ONLY_TEXT.agent_archived)),
    );
    expect(composerSlot()?.querySelector("[hidden]")).not.toBeNull();
  });

  it("사유 줄에 초점이 있는 채 다시 쓸 수 있게 되면(되살리기) 초점은 돌아온 작성기로 — body 로 떨어지지 않는다", async () => {
    const server = stubServer({ dms: [dmOf(dmChannel(), DEV, { readOnlyReason: "agent_disabled" })] });
    const { queryClient } = renderRoute(`/c/${DM}/s/${A}`);
    const live = liveHandlers(queryClient);
    const line = within(await screen.findByTestId("dm-read-only")).getByText(
      DM_READ_ONLY_TEXT.agent_disabled,
    );
    act(() => line.focus());
    expect(document.activeElement).toBe(line);

    server.state.dms = [dmOf(dmChannel(), DEV)];
    live.emit("agents.changed", {});
    await waitFor(() => expect(screen.queryByTestId("dm-read-only")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "메시지 입력" })),
    );
    live.detach();
  });

  it("읽기 전용 DM 에서 다른 채널로 옮기는 것은 되살리기가 아니다 — 초점을 새 채널의 작성기로 옮기지 않는다(리뷰 L4)", async () => {
    stubServer({ dms: [dmOf(dmChannel(), DEV, { readOnlyReason: "agent_archived" })] });
    const { router } = renderRoute(`/c/${DM}/s/${A}`);
    await screen.findByTestId("dm-read-only");
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);

    await act(() => router.navigate({ to: `/c/${CH}/s/new` }));
    await screen.findByRole("textbox", { name: "메시지 입력" });
    await flushEditorFrames();
    expect(screen.queryByTestId("dm-read-only")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("agents.changed 를 받으면 DM 목록을 다시 받는다 — 되살리면 작성기가 돌아온다", async () => {
    const server = stubServer({ dms: [dmOf(dmChannel(), DEV, { readOnlyReason: "agent_archived" })] });
    const { queryClient } = renderRoute(`/c/${DM}/s/${A}`);
    const live = liveHandlers(queryClient);
    await screen.findByTestId("dm-read-only");
    server.state.dms = [dmOf(dmChannel(), DEV)];
    live.emit("agents.changed", {});
    expect(await screen.findByRole("textbox", { name: "메시지 입력" })).toBeVisible();
    expect(screen.queryByTestId("dm-read-only")).toBeNull();
    live.detach();
  });
});

describe("판정 함수", () => {
  it("canOpenDm — off 아무도, admins 는 admin 이상, everyone 은 모든 멤버, 보관·꺼짐은 누구도", () => {
    const of = (over: Partial<Agent>) => agentOf(uid(30), "x", over);
    const table = (["off", "admins", "everyone"] as const).map((dmAccess) =>
      (["owner", "admin", "member", undefined] as const).map((role) => canOpenDm(of({ dmAccess }), role)),
    );
    expect(table).toEqual([
      [false, false, false, false],
      [true, true, false, false],
      [true, true, true, false],
    ]);
    expect(canOpenDm(of({ dmAccess: "everyone", enabled: false }), "owner")).toBe(false);
    expect(canOpenDm(of({ dmAccess: "everyone", archivedAt: "2026-10-01T00:00:00.000Z" }), "owner")).toBe(
      false,
    );
  });

  it("canDecideApproval — DM 이면 역할·종류와 상관없이 주인만", () => {
    const member = { role: "member", user: { id: "mia" } };
    const owner = { role: "owner", user: { id: "boss" } };
    const tool = { kind: "tool" as const, requestedBy: undefined };
    expect(canDecideApproval(tool, member, "mia")).toBe(true);
    expect(canDecideApproval(tool, owner, "mia")).toBe(false);
    expect(canDecideApproval(tool, member)).toBe(false);
    expect(canDecideApproval(tool, owner)).toBe(true);
  });

  it("dateGroupOf — 달력 날짜 경계(브라우저 시간대): 0시 직전은 어제, 6일 전은 이번 주, 7일 전은 이전, 미래는 오늘", () => {
    const now = new Date(2026, 9, 26, 0, 5);
    const at = (d: number, h = 12, m = 0) => new Date(2026, 9, d, h, m).toISOString();
    expect(dateGroupOf(at(26, 0, 0), now)).toBe("today");
    expect(dateGroupOf(at(25, 23, 59), now)).toBe("yesterday");
    expect(dateGroupOf(at(24, 23, 59), now)).toBe("week");
    expect(dateGroupOf(at(20, 0, 0), now)).toBe("week");
    expect(dateGroupOf(at(19, 23, 59), now)).toBe("older");
    expect(dateGroupOf(at(27), now)).toBe("today");
    expect(Object.values(DATE_GROUP_LABEL)).toEqual(["오늘", "어제", "이번 주", "이전"]);
  });
});
