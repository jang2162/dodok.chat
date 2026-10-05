import { type Channel, ComponentsV1, type Message, type Result } from "@dodok/shared";
import type { Editor } from "@tiptap/core";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { emptyTimeline, threadFromPage, type Timeline } from "@/features/messages/timeline";
import { attachHandlers } from "@/realtime/handlers";
import { createSubscriptions } from "@/realtime/subscriptions";
import { getTimeline } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { CH, CH2, msg } from "../../../test/fixtures";
import { DEV } from "../../../test/messages";
import { ME, channelOf, json, renderRoute, shellGet } from "../../../test/shellApi";

// 채널 보관(채널 보관 스펙 「웹」 절) — 사이드바·보관한 채널 화면·카드·설정 패널·스레드·열린 채널이 보관되는 순간
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
  useChannelSubscription: vi.fn(),
}));

const ARCHIVED_AT = "2027-01-20T00:00:00.000Z";
const LIVE = channelOf(CH, { name: "general" });
const OLD = channelOf(CH2, { name: "old-news", archivedAt: ARCHIVED_AT });

type Server = {
  live: Channel[];
  archived: Channel[];
  role: string;
  posts: string[];
};
let server: Server;
let fake: FakeSocket;
let restoreDom: Array<() => void>;
let toastError: MockInstance<typeof toast.error>;

/** 채널 목록·상세·보관·보관 해제를 서버처럼 답한다 — 보관하면 목록 사이를 옮긴다 */
function stubServer() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/v1/auth/me") return json(200, { ...ME, role: server.role });
    if (url === "/api/v1/channels") return json(200, { channels: server.live });
    if (url === "/api/v1/channels?archived=1") return json(200, { channels: server.archived });
    const act = /^\/api\/v1\/channels\/([^/]+)\/(archive|unarchive)$/.exec(url);
    if (act?.[1] && method === "POST") {
      server.posts.push(`${act[2]}:${act[1]}`);
      const all = [...server.live, ...server.archived];
      const found = all.find((c) => c.id === act[1]);
      if (!found) return json(404, { code: "NOT_FOUND", message: "x" });
      const next = { ...found, archivedAt: act[2] === "archive" ? ARCHIVED_AT : null };
      server.live = all.filter((c) => c.id !== next.id && !c.archivedAt);
      server.archived = all.filter((c) => c.id !== next.id && c.archivedAt);
      (next.archivedAt ? server.archived : server.live).push(next);
      return json(200, { channel: next });
    }
    const one = /^\/api\/v1\/channels\/([^/]+)$/.exec(url);
    if (one?.[1] && method === "GET") {
      const found = [...server.live, ...server.archived].find((c) => c.id === one[1]);
      return found ? json(200, { channel: found }) : json(404, { code: "NOT_FOUND", message: "x" });
    }
    return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  server = { live: [LIVE], archived: [OLD], role: "owner", posts: [] };
  // 메시지 목록은 가상 목록이다 — 배치를 흉내 내야 행(카드·보내는 중 항목)이 그려진다
  restoreDom = [stubEditorDom(), stubScrollLayout()];
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  toastError = vi.spyOn(toast, "error");
  stubServer();
});
afterEach(() => {
  for (const restore of restoreDom) restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

const composerBox = () => screen.queryByRole("textbox", { name: "메시지 입력" });

describe("사이드바", () => {
  it("보관한 채널은 채널 목록에 없다 — 캐시에 섞여 들어와 있어도", async () => {
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData(qk.channels, [LIVE, OLD]);
    // 다시 받지 않게 — 캐시의 섞인 목록 그대로 그려야 거름을 잰다
    queryClient.setDefaultOptions({
      queries: { ...queryClient.getDefaultOptions().queries, staleTime: Infinity },
    });
    renderRoute(`/c/${CH}`, queryClient);
    const nav = await screen.findByRole("navigation", { name: "채널" });
    expect(await within(nav).findByRole("link", { name: /general/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /old-news/ })).toBeNull();
  });
});

describe("보관한 채널 화면", () => {
  it("머리에 「보관됨」, 작성기 자리에 「보관된 채널입니다.」, owner 는 「보관 해제」", async () => {
    renderRoute(`/c/${CH2}`);
    const header = await screen.findByTestId("channel-header");
    expect(await within(header).findByText("보관됨")).toBeInTheDocument();
    expect(screen.getByText("보관된 채널입니다.")).toBeInTheDocument();
    expect(composerBox()).toBeNull();
    expect(screen.getByRole("button", { name: "보관 해제" })).toBeInTheDocument();
  });

  it("빈 보관 채널의 안내는 「메시지가 없습니다.」 — 멘션을 권하지 않는다", async () => {
    const queryClient = createQueryClient(() => {});
    // 타임라인이 있어야 빈 상태 문구가 그려진다 — 구독은 가짜라 받아 오지 않는다
    queryClient.setQueryData<Timeline>(qk.timeline(CH2), emptyTimeline());
    renderRoute(`/c/${CH2}`, queryClient);
    expect(await screen.findByText("메시지가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText(/@멘션으로/)).toBeNull();
  });

  it("member 에게는 「보관 해제」가 없다 — 읽기만", async () => {
    server.role = "member";
    renderRoute(`/c/${CH2}`);
    expect(await screen.findByText("보관된 채널입니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "보관 해제" })).toBeNull();
  });

  it("「보관 해제」를 누르면 한 번 보내고 작성기가 돌아오며 사이드바에 다시 든다", async () => {
    renderRoute(`/c/${CH2}`);
    const button = await screen.findByRole("button", { name: "보관 해제" });
    await userEvent.dblClick(button);
    expect(await screen.findByRole("textbox", { name: "메시지 입력" })).toBeInTheDocument();
    expect(server.posts).toEqual([`unarchive:${CH2}`]);
    const nav = screen.getByRole("navigation", { name: "채널" });
    expect(await within(nav).findByRole("link", { name: /old-news/ })).toBeInTheDocument();
    expect(within(screen.getByTestId("channel-header")).queryByText("보관됨")).toBeNull();
  });

  it("카드의 단추는 비활성이고 사유는 「보관된 채널입니다」", async () => {
    const queryClient = createQueryClient(() => {});
    const card = msg(1, {
      channelId: CH2,
      components: ComponentsV1.parse({
        id: "cmp_1",
        blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "확인" }] }],
      }),
      componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
    });
    queryClient.setQueryData<Timeline>(qk.timeline(CH2), { ...emptyTimeline(), items: [card], lastSeq: 1 });
    renderRoute(`/c/${CH2}`, queryClient);
    const button = await screen.findByRole("button", { name: "확인" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("보관된 채널입니다");
  });

  it("채널 설정 패널: 편집 섹션·「채널 보관」 대신 「보관된 채널입니다.」", async () => {
    renderRoute(`/c/${CH2}/settings`);
    const panel = await screen.findByTestId("channel-settings-archived");
    expect(within(panel).getByText("보관된 채널입니다.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "이름" })).toBeNull();
    expect(screen.queryByRole("button", { name: "채널 보관" })).toBeNull();
  });

  it("스레드 패널도 읽기 전용 — 작성기·「새 대화」 줄·「보관 해제」가 없다", async () => {
    const queryClient = createQueryClient(() => {});
    const root = msg(1, { channelId: CH2 });
    queryClient.setQueryData(qk.thread(CH2, root.id), threadFromPage(undefined, root, [], false));
    // 채널에 에이전트가 있다 — 살아 있는 채널이면 owner 에게 「새 대화」 줄이 보인다
    queryClient.setQueryData(qk.agents, [DEV]);
    queryClient.setQueryData(qk.members(CH2), [
      {
        id: "m1",
        channelId: CH2,
        memberType: "agent",
        memberId: DEV.id,
        autoRespond: false,
        aliases: [],
        joinedAt: ARCHIVED_AT,
      },
    ]);
    queryClient.setDefaultOptions({
      queries: { ...queryClient.getDefaultOptions().queries, staleTime: Infinity },
    });
    renderRoute(`/c/${CH2}/t/${root.id}`, queryClient);
    const panel = await screen.findByTestId("thread-panel");
    expect(within(panel).getByText("보관된 채널입니다.")).toBeInTheDocument();
    expect(within(panel).queryByRole("textbox", { name: /입력/ })).toBeNull();
    expect(within(panel).queryByText("새 대화")).toBeNull();
    // owner 라도 「보관 해제」는 채널 작성기 자리 하나뿐 — 스레드 패널에는 두지 않는다
    expect(within(panel).queryByRole("button", { name: "보관 해제" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "보관 해제" })).toHaveLength(1);
  });
});

describe("채널 설정 패널 「채널 보관」", () => {
  it("member 에게는 없다", async () => {
    server.role = "member";
    renderRoute(`/c/${CH}/settings`);
    expect(await screen.findByRole("textbox", { name: "이름" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "채널 보관" })).toBeNull();
  });

  it("admin: 확인 문구 → 연속 클릭에도 한 번 보내고 화면이 읽기 전용으로", async () => {
    server.role = "admin";
    renderRoute(`/c/${CH}/settings`);
    await userEvent.click(await screen.findByRole("button", { name: "채널 보관" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "#general 을 보관합니다. 기록은 남고 누구나 읽을 수 있으며, 보관 해제하면 그대로 돌아옵니다.",
      ),
    ).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "보관" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    // 작성기 자리와 설정 패널 둘 다 안내로 바뀐다 — 대화상자가 열린 동안은 바깥이 가려져 역할 질의로는 못 잰다
    await waitFor(() => expect(screen.getAllByText("보관된 채널입니다.")).toHaveLength(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(composerBox()).toBeNull();
    expect(server.posts).toEqual([`archive:${CH}`]);
    // 누른 단추가 사라졌다 — 초점은 body 가 아니라 패널의 안내로
    await waitFor(() =>
      expect(screen.getByTestId("channel-settings-archived").querySelector("p")).toHaveFocus(),
    );
    const nav = screen.getByRole("navigation", { name: "채널" });
    expect(within(nav).queryByRole("link", { name: /general/ })).toBeNull();
  });
});

describe("보관을 모르는 탭의 설정 저장", () => {
  it("PATCH 가 409 CHANNEL_ARCHIVED 면 토스트 하나 「보관된 채널입니다」, 채널을 다시 받아 패널·작성기가 안내로", async () => {
    server.role = "admin";
    const fetch = vi.mocked(globalThis.fetch);
    const base = fetch.getMockImplementation();
    fetch.mockImplementation(async (input, init) => {
      if (String(input) === `/api/v1/channels/${CH}` && init?.method === "PATCH")
        return json(409, { code: "CHANNEL_ARCHIVED", message: "보관된 채널입니다" });
      return (base as typeof globalThis.fetch)(input, init);
    });
    renderRoute(`/c/${CH}/settings`);
    const name = await screen.findByRole("textbox", { name: "이름" });
    // 서버에서는 이미 보관됐다
    server.live = [];
    server.archived = [{ ...LIVE, archivedAt: ARCHIVED_AT }, OLD];
    await userEvent.type(name, "-x");
    const basic = screen.getByRole("region", { name: "기본" });
    await userEvent.click(within(basic).getByRole("button", { name: "저장" }));

    expect(await screen.findByTestId("channel-settings-archived")).toBeInTheDocument();
    await waitFor(() => expect(composerBox()).toBeNull());
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("보관된 채널입니다", { id: "channel-archived" });
  });
});

describe("열린 채널이 다른 탭에서 보관될 때(Review Focus 1)", () => {
  /** 화면과 같은 QueryClient 에 실시간 핸들러를 붙인다 — 서버의 channel.updated 가 앱과 같은 길로 캐시에 닿는다 */
  function withHandlers() {
    const queryClient = createQueryClient(() => {});
    fake.socket.connected = true;
    fake.socket.active = true;
    const subscriptions = createSubscriptions({ socket: fake.wire, queryClient, fetchPage: vi.fn() });
    const detach = attachHandlers(fake.wire, {
      queryClient,
      subscriptions,
      onUnauthorized: vi.fn(),
      notify: { currentChannelId: () => CH, openActivity: vi.fn() },
    });
    return { queryClient, detach };
  }

  it("channel.updated 가 오면 작성기가 「보관된 채널입니다.」로 바뀌고 오류 토스트는 없다", async () => {
    const { queryClient, detach } = withHandlers();
    renderRoute(`/c/${CH}`, queryClient);
    expect(await screen.findByRole("textbox", { name: "메시지 입력" })).toBeInTheDocument();

    act(() => fake.serverEmit("channel.updated", { channel: { ...LIVE, archivedAt: ARCHIVED_AT } }));

    expect(await screen.findByText("보관된 채널입니다.")).toBeInTheDocument();
    expect(composerBox()).toBeNull();
    const nav = screen.getByRole("navigation", { name: "채널" });
    expect(within(nav).queryByRole("link", { name: /general/ })).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    detach();
  });

  it("설정 패널이 열려 있어도 초점이 패널 밖(사이드바)에 있으면 보관 이벤트가 초점을 뺏지 않는다", async () => {
    const { queryClient, detach } = withHandlers();
    renderRoute(`/c/${CH}/settings`, queryClient);
    expect(await screen.findByRole("textbox", { name: "이름" })).toBeInTheDocument();
    // 모달 대화상자는 초점 가두기가 초점을 되돌려 이 가드를 가린다 — 가두지 않는 사이드바 단추로 잰다
    const outside = within(screen.getByRole("navigation", { name: "채널" })).getByRole("button", {
      name: "채널 만들기",
    });
    act(() => outside.focus());

    act(() => fake.serverEmit("channel.updated", { channel: { ...LIVE, archivedAt: ARCHIVED_AT } }));

    expect(await screen.findByTestId("channel-settings-archived")).toBeInTheDocument();
    expect(outside).toHaveFocus();
    detach();
  });

  it("이벤트보다 먼저 누른 카드가 409 CHANNEL_ARCHIVED 면 채널을 다시 받아 카드가 「보관된 채널입니다」로 잠긴다", async () => {
    const queryClient = createQueryClient(() => {});
    const card = msg(1, {
      components: ComponentsV1.parse({
        id: "cmp_1",
        blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "확인" }] }],
      }),
      componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
    });
    queryClient.setQueryData<Timeline>(qk.timeline(CH), { ...emptyTimeline(), items: [card], lastSeq: 1 });
    renderRoute(`/c/${CH}`, queryClient);
    const button = await screen.findByRole("button", { name: "확인" });
    expect(button).toBeEnabled();
    server.live = [];
    server.archived = [{ ...LIVE, archivedAt: ARCHIVED_AT }, OLD];
    fake.onAck("component.interact", () => ({
      ok: false,
      error: { code: "CHANNEL_ARCHIVED", message: "보관된 채널입니다" },
    }));
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByRole("button", { name: "확인" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "확인" })).toHaveAccessibleDescription("보관된 채널입니다");
  });

  it("이벤트보다 먼저 보낸 글이 409 CHANNEL_ARCHIVED 면 토스트 없이 그 항목에 사유, 화면은 채널을 다시 받아 읽기 전용", async () => {
    const queryClient = createQueryClient(() => {});
    renderRoute(`/c/${CH}`, queryClient);
    const box = await screen.findByRole("textbox", { name: "메시지 입력" });
    // 서버에서는 이미 보관됐다 — 이 탭만 아직 모른다
    server.live = [];
    server.archived = [{ ...LIVE, archivedAt: ARCHIVED_AT }, OLD];
    fake.onAck("message.send", (): Result<{ message: Message }> => ({
      ok: false,
      error: { code: "CHANNEL_ARCHIVED", message: "보관된 채널입니다" },
    }));
    const editor = (box as unknown as { editor: Editor }).editor;
    act(() => {
      editor.commands.setContent("늦은 글");
      editor.commands.focus("end");
    });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(await screen.findByText("보관된 채널입니다.")).toBeInTheDocument();
    await waitFor(() =>
      expect(getTimeline(queryClient, CH)?.pending.map((p) => [p.state, p.reason])).toEqual([
        ["failed", "channel_archived"],
      ]),
    );
    expect(screen.getByText("보관된 채널입니다")).toBeInTheDocument();
    // 다시 보내도 같은 409 다 — 「다시 보내기」는 두지 않고 「삭제」만
    expect(screen.queryByRole("button", { name: "다시 보내기" })).toBeNull();
    expect(screen.getByRole("button", { name: "삭제" })).toBeInTheDocument();
    expect(toastError).not.toHaveBeenCalled();
  });
});
