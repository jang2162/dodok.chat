import type {
  Agent,
  Channel,
  Conversation,
  DirectSummary,
  DmSummary,
  Message,
  Person,
  SearchHit,
} from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { resetApprovalNotices } from "@/features/approvals/notify";
import { DmViewContext } from "@/features/dms/context";
import { DM_READ_ONLY_TEXT } from "@/features/dms/queries";
import { MessageItem } from "@/features/messages/MessageItem";
import { useUnread } from "@/features/reads/useUnread";
import { SearchResults } from "@/features/search/SearchResults";
import type { useSearch } from "@/features/search/useSearch";
import { attachHandlers } from "@/realtime/handlers";
import { createSubscriptions } from "@/realtime/subscriptions";
import { useWireStatus } from "@/realtime/wire";
import { flushEditorFrames } from "../../../test/composerHarness";
import { dmChannelOf, dmOf } from "../../../test/dms";
import { stubEditorDom, stubNotification } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, approval, CH, msg, uid } from "../../../test/fixtures";
import { renderWithClient } from "../../../test/messages";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { agentOf } from "../../../test/settingsServer";
import { channelOf, conversationOf, json, ME, renderRoute, shellGet } from "../../../test/shellApi";
import { mergeDmEntries } from "./queries";

// 사람 간 DM 계획 태스크 5 — 사이드바 합친 목록·「새 메시지」·프로필 「메시지 보내기」·대화 화면·읽기 전용·그룹 승인(웹)

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

const MIA = uid(6_001);
const JUN = uid(6_002);
const OLD = uid(6_003);
const person = (id: string, handle: string, displayName: string, over: Partial<Person> = {}): Person => ({
  id,
  handle,
  displayName,
  role: "member",
  deactivatedAt: null,
  statusMessage: null,
  ...over,
});
const MIA_P = person(MIA, "mia", "미아", { statusMessage: { text: "회의 중", emoji: "📅", until: null } });
const JUN_P = person(JUN, "jun", "준");
const OLD_P = person(OLD, "old", "올드", { deactivatedAt: "2026-11-01T00:00:00.000Z" });
const PEOPLE: Person[] = [
  person(ME.user.id, ME.user.handle, ME.user.displayName, { role: "owner" }),
  MIA_P,
  JUN_P,
  OLD_P,
];

const DEV = agentOf(AGENT, "dev", { name: "Dev 봇", dmAccess: "everyone" });
const FIN = agentOf(uid(12), "fin", { name: "Fin 봇", dmAccess: "everyone" });

const ONE = uid(30); // 나 ↔ mia 1:1(한 줄기)
const GROUP = uid(31); // 나·mia·jun(사람만 — 한 줄기)
const AGROUP = uid(32); // 나·mia·dev(세션)
const DM = uid(33); // 나 ↔ fin 에이전트 DM
const ONE_CONV = uid(40);
const S1 = uid(41);

const directChannel = (id: string, over: Partial<Channel> = {}) =>
  channelOf(id, { name: "direct", visibility: "private", kind: "direct", ...over });
const directOf = (
  id: string,
  users: Person[],
  agents: Agent[],
  over: Partial<DirectSummary> = {},
): DirectSummary => ({
  channel: directChannel(id),
  users,
  agents,
  sessions: agents.length > 0,
  lastMessageAt: "2026-11-09T01:00:00.000Z",
  readOnlyReason: null,
  ...over,
});
const conv = (channelId: string, id: string, over: Partial<Conversation> = {}) =>
  conversationOf(channelId, {
    id,
    title: `세션-${id.slice(-2)}`,
    createdBy: { type: "user", id: ME.user.id },
    ...over,
  });

type Call = { method: string; url: string; body?: unknown };

/**
 * 사람 DM 화면이 부르는 REST — me, 사람, 에이전트, 두 DM 목록, direct 열기(POST /directs), 채널·멤버·대화. `state` 는 서버가 들고 있는
 * 것이라 테스트가 고친다(다른 탭의 비활성화 등). `open` 은 POST /directs 의 응답을 정한다(없으면 같은 묶음을 찾거나 새로 만든다)
 */
function stubServer({
  role = "owner",
  directs = [] as DirectSummary[],
  dms = [] as DmSummary[],
  agents = [DEV, FIN],
  conversations = {} as Record<string, Conversation[]>,
  members = {} as Record<string, Array<{ type: "user" | "agent"; id: string }>>,
  open,
}: {
  role?: string;
  directs?: DirectSummary[];
  dms?: DmSummary[];
  agents?: Agent[];
  conversations?: Record<string, Conversation[]>;
  members?: Record<string, Array<{ type: "user" | "agent"; id: string }>>;
  open?: (body: { userIds: string[]; agentIds: string[] }) => Response;
} = {}) {
  const calls: Call[] = [];
  const state = { directs: [...directs], dms: [...dms] };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url, ...(body === undefined ? {} : { body }) });
      if (url === "/api/v1/auth/me") return json(200, { ...ME, role });
      if (url === "/api/v1/people") return json(200, { people: PEOPLE });
      if (url === "/api/v1/agents") return json(200, { agents });
      if (url === "/api/v1/dms" && method === "GET") return json(200, { dms: state.dms });
      if (url === "/api/v1/dms" && method === "POST") {
        const { agentId } = body as { agentId: string };
        return json(200, { channel: dmChannelOf(DM, ME.user.id, agentId) });
      }
      if (url === "/api/v1/directs" && method === "GET") return json(200, { directs: state.directs });
      if (url === "/api/v1/directs" && method === "POST") {
        const b = body as { userIds: string[]; agentIds: string[] };
        if (open) return open(b);
        const channel = directChannel(uid(39));
        state.directs.push(
          directOf(
            channel.id,
            PEOPLE.filter((p) => b.userIds.includes(p.id)),
            agents.filter((a) => b.agentIds.includes(a.id)),
            { lastMessageAt: null },
          ),
        );
        return json(200, { channel, created: true });
      }
      const detail = /^\/api\/v1\/channels\/([^/]+)$/.exec(url);
      const known = detail && state.directs.find((d) => d.channel.id === detail[1]);
      if (known) return json(200, { channel: known.channel });
      const mem = /^\/api\/v1\/channels\/([^/]+)\/members$/.exec(url);
      if (mem?.[1] && members[mem[1]])
        return json(200, {
          members: (members[mem[1]] ?? []).map((m) => ({
            id: `m-${m.id}`,
            channelId: mem[1],
            memberType: m.type,
            memberId: m.id,
            autoRespond: false,
            aliases: [],
            joinedAt: "2026-11-01T00:00:00.000Z",
            ...(m.type === "user" ? { role: "member" } : {}),
          })),
        });
      const list = /^\/api\/v1\/channels\/([^/]+)\/conversations\?(.*)$/.exec(url);
      if (list?.[1] && conversations[list[1]]) {
        const status = new URLSearchParams(list[2]).get("status");
        const rows = (conversations[list[1]] ?? []).filter((c) =>
          status === "closed" ? c.closedAt !== undefined : c.closedAt === undefined,
        );
        return json(200, { conversations: rows });
      }
      const one = /^\/api\/v1\/conversations\/([^/?]+)$/.exec(url);
      if (one) {
        const c = Object.values(conversations)
          .flat()
          .find((x) => x.id === one[1]);
        if (c) return json(200, { conversation: c });
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
  const detach = attachHandlers(socket.wire, {
    queryClient: qc,
    subscriptions,
    onUnauthorized: () => {},
    notify: {
      currentChannelId: () => undefined,
      currentConversationId: () => undefined,
      openActivity: () => {},
    },
  });
  return {
    emit: (event: string, ...payload: unknown[]) => act(() => socket.serverEmit(event, ...payload)),
    detach,
  };
}

async function typeAndSend(text: string) {
  const box = await screen.findByRole("textbox", { name: "메시지 입력" });
  const editor = (box as unknown as { editor: import("@tiptap/core").Editor }).editor;
  act(() => {
    editor.commands.setContent(text);
    editor.commands.focus("end");
  });
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
const rowTexts = (nav: HTMLElement) =>
  within(nav)
    .getAllByRole("link")
    .map((a) => a.textContent);

const ONE_D = directOf(ONE, [MIA_P], [], { lastMessageAt: "2026-11-09T03:00:00.000Z" });
const GROUP_D = directOf(GROUP, [MIA_P, JUN_P], [], { lastMessageAt: "2026-11-09T02:00:00.000Z" });
const AGROUP_D = directOf(AGROUP, [MIA_P], [DEV], { lastMessageAt: null });
const FIN_DM = dmOf(dmChannelOf(DM, ME.user.id, FIN.id), FIN, { lastMessageAt: "2026-11-09T02:30:00.000Z" });

describe("사이드바 「다이렉트 메시지」 — 두 목록을 합친 최근 활동순", () => {
  it("mergeDmEntries — 마지막 글 시각(없으면 연 시각) 내림차순, 같은 시각이면 받은 순서", () => {
    const merged = mergeDmEntries(
      [FIN_DM],
      [
        GROUP_D,
        ONE_D,
        { ...AGROUP_D, channel: directChannel(AGROUP, { createdAt: "2026-11-09T02:30:00.000Z" }) },
      ],
    );
    expect(merged.map((e) => (e.kind === "dm" ? e.dm.channel.id : e.direct.channel.id))).toEqual([
      ONE,
      DM,
      AGROUP,
      GROUP,
    ]);
  });

  it("에이전트 DM 과 사람 DM·그룹 DM 이 한 목록 — 글 있는 것만, 1:1 은 상대 이름, 그룹은 나를 뺀 이름 나열, 채널 절에는 없다", async () => {
    stubServer({ directs: [GROUP_D, AGROUP_D, ONE_D], dms: [FIN_DM] });
    renderRoute(`/c/${CH}/s/new`);
    const nav = await dmNav();
    // 줄 글자는 아바타 머리글자 + 이름 — ONE(03:00) · FIN(02:30) · GROUP(02:00), 글 없는 AGROUP 은 빠진다
    await waitFor(() => expect(rowTexts(nav)).toEqual(["미미아", "FFin 봇", "미준미아, 준"]));
    const channels = screen.getByRole("navigation", { name: "채널" });
    expect(within(channels).queryByText(/direct/)).toBeNull();
  });

  it("지금 연 그룹 DM 은 글이 없어도 보인다", async () => {
    stubServer({ directs: [AGROUP_D], conversations: { [AGROUP]: [] } });
    renderRoute(`/c/${AGROUP}/s/new`);
    const nav = await dmNav();
    expect(await within(nav).findByRole("link", { name: /미아, @dev/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("1:1 상대가 비활성이면 흐리게 + 「(비활성)」", async () => {
    stubServer({ directs: [directOf(uid(34), [OLD_P], [])] });
    renderRoute(`/c/${CH}/s/new`);
    const link = await within(await dmNav()).findByRole("link", { name: /올드/ });
    expect(link).toHaveTextContent("(비활성)");
    expect(link).toHaveAttribute("data-dim", "true");
  });

  it("direct 의 channel.created·channel.updated 는 채널 목록이 아니라 direct 목록을 다시 받고, 모르는 채널의 활동·people.changed 도 다시 받는다", async () => {
    const server = stubServer({ directs: [ONE_D] });
    const { queryClient } = renderRoute(`/c/${CH}/s/new`);
    const live = liveHandlers(queryClient);
    await waitFor(() => expect(server.count("GET", "/directs")).toBe(1));
    await waitFor(() => expect(queryClient.getQueryData(qk.channels)).toBeDefined());

    const fresh = directChannel(uid(35));
    live.emit("channel.created", { channel: fresh });
    await waitFor(() => expect(server.count("GET", "/directs")).toBe(2));
    live.emit("channel.updated", { channel: fresh });
    await waitFor(() => expect(server.count("GET", "/directs")).toBe(3));
    expect((queryClient.getQueryData<Channel[]>(qk.channels) ?? []).map((c) => c.id)).not.toContain(fresh.id);

    live.emit("channel.activity", {
      channelId: uid(36),
      conversationId: uid(37),
      seq: 1,
      authorType: "user",
      authorId: MIA,
      mentionedUserIds: [ME.user.id],
    });
    await waitFor(() => expect(server.count("GET", "/directs")).toBe(4));
    live.emit("people.changed", { people: PEOPLE });
    await waitFor(() => expect(server.count("GET", "/directs")).toBe(5));
    // 사이드바 채널 절에도 없다
    expect(within(screen.getByRole("navigation", { name: "채널" })).queryAllByRole("link")).toHaveLength(0);
    live.detach();
  });

  it("모르는 kind 의 channel.created 는 채널 목록에 넣지 않는다(기본이 닫힘)", async () => {
    stubServer();
    const { queryClient } = renderRoute(`/c/${CH}/s/new`);
    const live = liveHandlers(queryClient);
    await waitFor(() => expect(queryClient.getQueryData(qk.channels)).toBeDefined());
    live.emit("channel.created", { channel: channelOf(uid(38), { kind: "zzz" as never }) });
    expect((queryClient.getQueryData<Channel[]>(qk.channels) ?? []).map((c) => c.id)).not.toContain(uid(38));
    live.detach();
  });
});

describe("「새 메시지」", () => {
  const openDialog = async () => {
    await userEvent.click(await screen.findByRole("button", { name: "새 메시지" }));
    return screen.findByRole("dialog", { name: "새 메시지" });
  };

  it("후보는 활성 멤버(나·비활성 제외)와 DM 할 수 있는 에이전트를 한 목록에", async () => {
    const off = agentOf(uid(13), "quiet", { name: "Quiet 봇", dmAccess: "off" });
    stubServer({ role: "member", agents: [DEV, off] });
    renderRoute(`/c/${CH}/s/new`);
    const dialog = await openDialog();
    await within(dialog).findByText("Dev 봇");
    const names = within(within(dialog).getByRole("list", { name: "상대" }))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names).toEqual(["미미아@mia", "준준@jun", "DDev 봇@dev"]);
  });

  it("에이전트 하나만 고르면 /dm/<에이전트> — POST /directs 없이 에이전트 DM 으로", async () => {
    const server = stubServer({ agents: [DEV] });
    const { router } = renderRoute(`/c/${CH}/s/new`);
    const dialog = await openDialog();
    await userEvent.click(await within(dialog).findByRole("button", { name: /Dev 봇/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "열기" }));
    await waitFor(() => expect(server.bodies("POST", "/dms")).toEqual([{ agentId: DEV.id }]));
    expect(server.count("POST", "/directs")).toBe(0);
    await waitFor(() => expect(router.state.location.pathname).toMatch(new RegExp(`^/c/${DM}/`)));
  });

  it("사람 하나 + 에이전트 → POST /directs { userIds, agentIds } 뒤 그 채널로", async () => {
    const server = stubServer({ conversations: { [uid(39)]: [] } });
    const { router } = renderRoute(`/c/${CH}/s/new`);
    const dialog = await openDialog();
    await userEvent.click(await within(dialog).findByRole("button", { name: /미아/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: /Dev 봇/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "열기" }));
    await waitFor(() =>
      expect(server.bodies("POST", "/directs")).toEqual([{ userIds: [MIA], agentIds: [DEV.id] }]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${uid(39)}/s/new`));
    expect(server.count("POST", "/dms")).toBe(0);
  });

  const refuse = async (details: Record<string, unknown> | undefined) => {
    stubServer({
      open: () =>
        json(403, {
          code: "FORBIDDEN",
          message: "이 에이전트와 DM 을 열 수 없다",
          ...(details ? { details } : {}),
        }),
    });
    const { router } = renderRoute(`/c/${CH}/s/new`);
    const dialog = await openDialog();
    await userEvent.click(await within(dialog).findByRole("button", { name: /미아/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: /Dev 봇/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "열기" }));
    return { alert: await within(dialog).findByRole("alert"), router };
  };

  it("403 에 막은 에이전트가 실리면 그 핸들과 두 까닭을 대화상자 안에(누구인지는 말하지 않는다) — 넘기지 않는다", async () => {
    const { alert, router } = await refuse({ agentId: DEV.id });
    expect(alert).toHaveTextContent(
      "@dev 와 대화를 열 수 없습니다 — 에이전트가 꺼져 있거나, 참여자 가운데 이 에이전트의 DM 허용 범위 밖인 사람이 있습니다",
    );
    expect(alert).not.toHaveTextContent("미아");
    expect(router.state.location.pathname).toBe(`/c/${CH}/s/new`);
  });

  it("403 에 에이전트가 없으면 서버 문구 그대로", async () => {
    expect((await refuse(undefined)).alert).toHaveTextContent("이 에이전트와 DM 을 열 수 없다");
  });

  it("403 의 에이전트를 모르면 서버 문구 그대로", async () => {
    expect((await refuse({ agentId: uid(77) })).alert).toHaveTextContent("이 에이전트와 DM 을 열 수 없다");
  });
});

describe("사람 프로필 「메시지 보내기」", () => {
  it("남의 활성 멤버면 단추 — 누르면 그 사람과 1:1 을 열어 그 채널로. 나·비활성 멤버에게는 없다", async () => {
    const server = stubServer({ conversations: { [uid(39)]: [conv(uid(39), ONE_CONV)] } });
    const { router } = renderRoute(`/c/${CH}/s/${CH}/p/u/${MIA}`);
    await userEvent.click(await screen.findByRole("button", { name: "메시지 보내기" }));
    await waitFor(() =>
      expect(server.bodies("POST", "/directs")).toEqual([{ userIds: [MIA], agentIds: [] }]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${uid(39)}/s/${ONE_CONV}`));

    await act(() => router.navigate({ to: `/c/${CH}/s/${CH}/p/u/${ME.user.id}` }));
    await screen.findByRole("button", { name: "상태 바꾸기" });
    expect(screen.queryByRole("button", { name: "메시지 보내기" })).toBeNull();
    await act(() => router.navigate({ to: `/c/${CH}/s/${CH}/p/u/${OLD}` }));
    await screen.findByText("@old");
    expect(screen.queryByRole("button", { name: "메시지 보내기" })).toBeNull();
  });
});

describe("대화 화면", () => {
  it("1:1 — 머리는 상대 아바타·이름·상태 메시지(누르면 프로필), 세션 목록·「새 세션」·활동·채널 설정이 없다", async () => {
    stubServer({ directs: [ONE_D], conversations: { [ONE]: [conv(ONE, ONE_CONV)] } });
    const { router } = renderRoute(`/c/${ONE}`);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${ONE}/s/${ONE_CONV}`));
    const header = await screen.findByTestId("direct-header");
    expect(within(header).getByText("미아")).toBeInTheDocument();
    expect(within(header).getByText("회의 중")).toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: "세션 목록" })).toBeNull();
    expect(within(header).queryByRole("link", { name: "새 세션" })).toBeNull();
    expect(within(header).queryByRole("link", { name: "활동" })).toBeNull();
    expect(screen.queryByRole("link", { name: "채널 설정" })).toBeNull();
    expect(screen.queryByTestId("conversation-pane")).toBeNull();
    await userEvent.click(within(header).getByRole("button", { name: "미아 프로필" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${ONE}/s/${ONE_CONV}/p/u/${MIA}`));
  });

  it("한 줄기에서도 스레드는 연다 — 메시지 줄에 「스레드에서 답하기」", () => {
    const root: Message = { ...msg(1, { bodyMd: "루트", channelId: ONE, conversationId: ONE_CONV }) };
    renderWithClient(
      <DmViewContext.Provider value={{ kind: "direct", channel: directChannel(ONE), readOnly: null }}>
        <MessageItem message={root} head />
      </DmViewContext.Provider>,
    );
    expect(screen.getByRole("link", { name: "스레드에서 답하기" })).toBeInTheDocument();
  });

  it("사람만 있는 그룹 — 머리는 이름 나열, 누르면 참여자 목록", async () => {
    stubServer({ directs: [GROUP_D], conversations: { [GROUP]: [conv(GROUP, ONE_CONV)] } });
    renderRoute(`/c/${GROUP}/s/${ONE_CONV}`);
    const header = await screen.findByTestId("direct-header");
    await userEvent.click(await within(header).findByRole("button", { name: "참여자 — 미아, 준" }));
    const dialog = await screen.findByRole("dialog", { name: "참여자" });
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(expect.arrayContaining(["미미아", "준준"]));
    expect(within(header).queryByRole("button", { name: "세션 목록" })).toBeNull();
  });

  it("에이전트가 있는 그룹 — member 참여자에게도 세션 목록·「새 세션」·활동이 있고, 세션이 없으면 그룹 DM 첫 안내", async () => {
    stubServer({
      role: "member",
      directs: [AGROUP_D],
      conversations: { [AGROUP]: [] },
      members: {
        [AGROUP]: [
          { type: "user", id: ME.user.id },
          { type: "user", id: MIA },
          { type: "agent", id: DEV.id },
        ],
      },
    });
    renderRoute(`/c/${AGROUP}/s/new`);
    const header = await screen.findByTestId("direct-header");
    expect(await within(header).findByRole("button", { name: "세션 목록" })).toBeInTheDocument();
    expect(within(header).getByRole("link", { name: "활동" })).toBeInTheDocument();
    expect(await screen.findByText("아직 메시지가 없습니다.")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-pane")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "채널 설정" })).toBeNull();
    // 세션 제목 칸은 남은 자리만 쓴다 — jsdom 은 폭을 못 재 클래스로 본다(태스크 6 리뷰 L-b, 390px 에서 참여자 이름이 잘리던 것)
    expect(within(header).getByTestId("direct-session-title")).toHaveClass("min-w-0", "flex-1");
  });

  it("한 줄기 direct 도 …/files 로 오면 파일 탭 — 탭 머리는 파일뿐, 머리에 「파일」 단추", async () => {
    stubServer({ directs: [ONE_D], conversations: { [ONE]: [conv(ONE, ONE_CONV)] } });
    renderRoute(`/c/${ONE}/s/${ONE_CONV}/files`);
    const panel = await screen.findByTestId("page-channel-panel");
    expect(panel).toHaveAttribute("data-panel-tab", "files");
    const tabs = within(panel).getByRole("navigation", { name: "패널 탭" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["파일"]);
    expect(
      within(screen.getByTestId("direct-header")).getByRole("link", { name: "파일" }),
    ).toBeInTheDocument();
  });

  it("세션 direct 도 …/files 로 오면 파일 탭 — 탭 머리는 활동·파일", async () => {
    stubServer({
      directs: [{ ...AGROUP_D, lastMessageAt: "2026-11-09T01:00:00.000Z" }],
      conversations: { [AGROUP]: [conv(AGROUP, S1)] },
    });
    renderRoute(`/c/${AGROUP}/s/${S1}/files`);
    const panel = await screen.findByTestId("page-channel-panel");
    expect(panel).toHaveAttribute("data-panel-tab", "files");
    const tabs = within(panel).getByRole("navigation", { name: "패널 탭" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["활동", "파일"]);
  });

  it("에이전트가 있는 그룹의 세션 화면 — member 참여자에게 「새 세션」, 설정 주소로 와도 설정 패널은 없다", async () => {
    stubServer({
      role: "member",
      directs: [{ ...AGROUP_D, lastMessageAt: "2026-11-09T01:00:00.000Z" }],
      conversations: { [AGROUP]: [conv(AGROUP, S1, { createdBy: { type: "user", id: MIA } })] },
    });
    renderRoute(`/c/${AGROUP}/s/${S1}/settings`);
    const header = await screen.findByTestId("direct-header");
    expect(await within(header).findByRole("link", { name: "새 세션" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

/**
 * 태스크 5 리뷰 M1 — 에이전트를 보관하면 서버가 그 에이전트를 agents 에서 빼므로 [jun, @dev] 그룹이 1:1 [jun] 줄과 users·agents 가
 * 같아진다. 서버가 실은 sessions 로 가른다
 */
describe("보관한 에이전트가 든 그룹(sessions 참, agents 빔)", () => {
  const ARCH = uid(35);
  const JUN_ONE = uid(36);
  const ARCH_D = directOf(ARCH, [JUN_P], [], { sessions: true, lastMessageAt: "2026-11-09T02:00:00.000Z" });
  const JUN_D = directOf(JUN_ONE, [JUN_P], [], { lastMessageAt: "2026-11-09T03:00:00.000Z" });

  it("사이드바 — 1:1 줄은 이름, 그룹 줄은 그룹 꼴(「(그룹)」)이라 둘이 갈린다", async () => {
    stubServer({ directs: [ARCH_D, JUN_D] });
    renderRoute(`/c/${CH}/s/new`);
    const nav = await dmNav();
    await waitFor(() => expect(rowTexts(nav)).toEqual(["준준", "준준(그룹)"]));
  });

  it("검색 결과 — 사이드바처럼 1:1 은 「DM · 준」, 그룹은 「DM · 준 (그룹)」(재리뷰 L3)", async () => {
    stubServer({ directs: [ARCH_D, JUN_D] });
    const hit = (channelId: string, n: number): SearchHit => ({
      messageId: uid(9_000 + n),
      channelId,
      conversationId: channelId,
      conversationTitle: "이전 대화",
      seq: 1,
      channelArchived: false,
      authorType: "user",
      authorId: ME.user.id,
      createdAt: "2026-11-09T04:00:00.000Z",
      snippet: "배포",
    });
    // 결과 목록만 본다 — 대화상자·검색 요청은 search.test 가 잰다
    const search = {
      enabled: true,
      isError: false,
      isPending: false,
      isFetchNextPageError: false,
      hasNextPage: false,
      limited: false,
      hits: [hit(JUN_ONE, 1), hit(ARCH, 2)],
    } as unknown as ReturnType<typeof useSearch>;
    renderWithClient(<SearchResults search={search} onPick={() => {}} />);
    const list = await screen.findByRole("list", { name: "검색 결과" });
    const names = () =>
      within(list)
        .getAllByRole("button")
        .map((b) => b.querySelector("span > span")?.textContent);
    await waitFor(() => expect(names()).toEqual(["DM · 준", "DM · 준 (그룹)"]));
  });

  it("세션 화면 — 세션 목록·「새 세션」·활동이 있고 머리는 참여자 목록 단추", async () => {
    stubServer({ directs: [ARCH_D], conversations: { [ARCH]: [conv(ARCH, S1)] } });
    renderRoute(`/c/${ARCH}/s/${S1}`);
    const header = await screen.findByTestId("direct-header");
    expect(await within(header).findByRole("button", { name: "세션 목록" })).toBeInTheDocument();
    expect(within(header).getByRole("link", { name: "새 세션" })).toBeInTheDocument();
    expect(within(header).getByRole("link", { name: "활동" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "참여자 — 준" })).toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: "준 프로필" })).toBeNull();
    // 사이드바·검색처럼 「(그룹)」 — 1:1 머리와 갈린다
    expect(header).toHaveTextContent("준(그룹)");
  });
});

describe("읽기 전용·승인(Review Focus 4)", () => {
  it("peer_deactivated — 작성기 자리에 사유 줄, 작성기는 숨는다", async () => {
    stubServer({
      directs: [{ ...ONE_D, readOnlyReason: "peer_deactivated" }],
      conversations: { [ONE]: [conv(ONE, ONE_CONV)] },
    });
    renderRoute(`/c/${ONE}/s/${ONE_CONV}`);
    expect(await screen.findByTestId("dm-read-only")).toHaveTextContent(
      "상대가 비활성화되어 읽기만 할 수 있습니다",
    );
    expect(screen.queryByRole("textbox", { name: "메시지 입력" })).toBeNull();
    expect(DM_READ_ONLY_TEXT.peer_deactivated).toBe("상대가 비활성화되어 읽기만 할 수 있습니다");
  });

  it("peer_deactivated 면 반응을 달 수 없다", () => {
    const root: Message = { ...msg(1, { bodyMd: "루트", channelId: ONE, conversationId: ONE_CONV }) };
    renderWithClient(
      <DmViewContext.Provider
        value={{ kind: "direct", channel: directChannel(ONE), readOnly: "peer_deactivated" }}
      >
        <MessageItem message={root} head />
      </DmViewContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "반응 추가" })).toBeNull();
  });

  it("보내기 ack 가 DM_READ_ONLY(peer_deactivated)면 항목은 사유로 남고(「다시 보내기」 없음) /directs 를 다시 받아 사유 줄로", async () => {
    const server = stubServer({ directs: [ONE_D], conversations: { [ONE]: [conv(ONE, ONE_CONV)] } });
    fake.onAck("message.send", () => ({
      ok: false,
      error: { code: "DM_READ_ONLY", message: "비활성", details: { reason: "peer_deactivated" } },
    }));
    renderRoute(`/c/${ONE}/s/${ONE_CONV}`);
    await screen.findByRole("textbox", { name: "메시지 입력" });
    await waitFor(() => expect(server.count("GET", "/directs")).toBe(1));
    server.state.directs = [{ ...ONE_D, readOnlyReason: "peer_deactivated" }];
    await typeAndSend("늦은 글");

    expect(await screen.findByTestId("dm-read-only")).toHaveTextContent(DM_READ_ONLY_TEXT.peer_deactivated);
    expect(server.count("GET", "/directs")).toBe(2);
    const pending = document.querySelector('[data-pending="failed"]') as HTMLElement;
    expect(pending).toHaveTextContent(DM_READ_ONLY_TEXT.peer_deactivated);
    expect(within(pending).queryByRole("button", { name: "다시 보내기" })).toBeNull();
  });

  describe("탭 안 승인 알림은 시킨 사람에게만", () => {
    let notes: ReturnType<typeof stubNotification>;
    beforeEach(() => {
      useApprovalStore.getState().reset();
      resetApprovalNotices();
      notes = stubNotification("granted");
    });
    afterEach(() => notes.restore());

    it("owner 라도 남이 시킨 그룹 DM 승인은 알리지 않고, 내가 시킨 것은 본문 「DM」 으로 알린다", async () => {
      stubServer({ directs: [{ ...AGROUP_D, lastMessageAt: "2026-11-09T01:00:00.000Z" }] });
      const { queryClient } = renderRoute(`/c/${CH}/s/new`);
      const live = liveHandlers(queryClient);
      await waitFor(() => expect(queryClient.getQueryData(qk.directs)).toBeDefined());

      live.emit("approval.requested", {
        approval: approval({ id: uid(201), channelId: AGROUP, conversationId: S1, requestedBy: MIA }),
      });
      expect(notes.made).toHaveLength(0);
      // ME 의 id 는 UUID 가 아니라 픽스처(파싱)를 지나지 못한다 — 만든 뒤 덮는다
      live.emit("approval.requested", {
        approval: {
          ...approval({ id: uid(202), channelId: AGROUP, conversationId: S1 }),
          requestedBy: ME.user.id,
        },
      });
      expect(notes.made).toHaveLength(1);
      expect(notes.made[0]?.options?.body).toBe("DM");
      live.detach();
    });
  });
});

describe("검색 결과 줄", () => {
  it("사람 DM·그룹 DM 의 결과는 「DM · <참여자 이름>」", async () => {
    stubServer({ directs: [ONE_D, GROUP_D] });
    const { SearchResults } = await import("@/features/search/SearchResults");
    const hit = (channelId: string, messageId: string) => ({
      messageId,
      channelId,
      conversationId: ONE_CONV,
      conversationTitle: "이전 대화",
      seq: 1,
      channelArchived: false,
      authorType: "user",
      authorId: MIA,
      createdAt: "2026-11-09T01:00:00.000Z",
      snippet: "안녕",
    });
    renderWithClient(
      <SearchResults
        search={
          {
            enabled: true,
            hits: [hit(ONE, uid(990)), hit(GROUP, uid(991))],
            isError: false,
            isPending: false,
            limited: false,
            hasNextPage: false,
          } as never
        }
        onPick={() => {}}
      />,
    );
    expect(await screen.findByText("DM · 미아")).toBeInTheDocument();
    expect(screen.getByText("DM · 미아, 준")).toBeInTheDocument();
  });
});
