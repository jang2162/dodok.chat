import type { Message, Result } from "@dodok/shared";
import type { Editor } from "@tiptap/core";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { LAYOUT_KEY, layoutStore } from "@/app/layout/useLayoutWidths";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { MessageItem } from "@/features/messages/MessageItem";
import { MessageList } from "@/features/messages/MessageList";
import { emptyTimeline, threadFromPage, type Timeline } from "@/features/messages/timeline";
import { StreamingBubble } from "@/features/runs/StreamingBubble";
import { ReadSenderContext } from "@/features/reads/readSender";
import { isViewingAtEnd, useUnread } from "@/features/reads/useUnread";
import { useChannelBubbles } from "@/features/runs/useChannelBubbles";
import { useRunStore } from "@/features/runs/runStore";
import { getThread, setChannelSeq } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import {
  AGENT,
  approval,
  CH,
  CH2,
  msg,
  RUN,
  RUN2,
  runEvent,
  runState,
  textDelta,
  uid,
  USER,
} from "../../../test/fixtures";
import { stubMedia } from "../../../test/media";
import { authorsClient, DEV, OWNER_PERSON, renderWithClient } from "../../../test/messages";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { json, ME, renderRoute, shellGet } from "../../../test/shellApi";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

const RECT = { width: 800, height: 600 };
const ROOT = msg(1, { bodyMd: "루트 질문" });
const reply = (seq: number, over: Partial<Message> = {}) =>
  msg(seq, { threadRootId: ROOT.id, bodyMd: `답글 ${seq}`, ...over });
const summary = { count: 2, lastAt: reply(3).createdAt, agentIds: [AGENT] };
const threadPage = (messages: Message[], hasMore = false) => ({ root: ROOT, messages, hasMore });

let fake: FakeSocket;
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let restore: Array<() => void>;
/** 기본 서버: 셸 GET + 스레드 REST(루트·답글 2·3) + 에이전트 dev 가 멤버 */
let threadReply: (url: string) => Response | undefined;
beforeEach(() => {
  restore = [stubEditorDom(), stubScrollLayout(RECT)];
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  useRunStore.getState().reset();
  useApprovalStore.getState().reset();
  threadReply = () => json(200, threadPage([ROOT, reply(2), reply(3)]));
  fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url === "/api/v1/auth/me") return json(200, ME);
    if (url === "/api/v1/agents") return json(200, { agents: [DEV] });
    if (url === `/api/v1/channels/${CH}/members`)
      return json(200, {
        members: [
          {
            id: "m-dev",
            channelId: CH,
            memberType: "agent",
            memberId: AGENT,
            autoRespond: false,
            aliases: [],
            joinedAt: ROOT.createdAt,
          },
        ],
      });
    if (url.startsWith(`/api/v1/conversations/${CH}/threads/`)) return threadReply(url) ?? json(404, {});
    return shellGet(input, init) ?? json(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const fn of restore) fn();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
  useRunStore.getState().reset();
  useApprovalStore.getState().reset();
});

/** 세션 타임라인(루트만)을 채우고 그 채널을 구독한(채널 커서가 선) 클라이언트 */
function channelClient(items: Message[] = [{ ...ROOT, threadSummary: summary }]) {
  const qc = createQueryClient(() => {});
  qc.setQueryData(qk.timeline(CH, CH), { ...emptyTimeline(), items, lastSeq: 3 });
  setChannelSeq(qc, CH, 3);
  return qc;
}
const panel = () => screen.findByTestId("thread-panel");
const channelList = () => screen.getByRole("region", { name: "메시지" });

describe("채널 타임라인의 칩·메뉴", () => {
  it("루트 아래 칩 「답글 N · 마지막 답글 · 에이전트 아바타」 — 누르면 그 스레드", async () => {
    const qc = authorsClient();
    qc.setQueryData(qk.timeline(CH, CH), {
      ...emptyTimeline(),
      items: [{ ...ROOT, threadSummary: summary }],
      lastSeq: 3,
    });
    const { container } = renderWithClient(
      <MessageList channelId={CH} conversationId={CH} initialRect={RECT} />,
      qc,
    );

    const chip = await screen.findByRole("link", { name: /답글 2개/ });
    expect(chip).toHaveAttribute("href", `/c/${CH}/s/${CH}/t/${ROOT.id}`);
    expect(chip).toHaveTextContent("마지막 답글");
    // 요약의 에이전트(dev)의 아바타 하나
    expect(chip.querySelectorAll('[data-slot="avatar"]')).toHaveLength(1);
    // 답글 없는 루트에는 칩이 없다
    expect(container.querySelectorAll('[data-slot="thread-chip"]')).toHaveLength(1);
  });

  const person = (n: number, handle: string) => ({
    ...OWNER_PERSON,
    id: uid(n),
    handle,
    displayName: handle,
    role: "member" as const,
  });
  const agentOf = (n: number, handle: string) => ({
    ...DEV,
    id: uid(n),
    handle,
    providerAgentId: handle,
    name: handle,
  });
  const MIA = person(20, "mia");
  const JUN = person(21, "jun");
  const FIN = agentOf(22, "fin");
  const OPS = agentOf(23, "ops");
  const crowdClient = () => authorsClient([DEV, FIN, OPS], [OWNER_PERSON, MIA, JUN]);
  const withParticipants = (participants: { kind: "user" | "agent"; id: string }[]) => ({
    ...ROOT,
    threadSummary: { ...summary, participants },
  });
  const activeText = () => document.querySelector('[data-slot="thread-chip-active"]')?.textContent ?? null;

  it("chip shows people and agents as an avatar group", () => {
    const six = [
      { kind: "agent" as const, id: AGENT },
      { kind: "user" as const, id: MIA.id },
      { kind: "agent" as const, id: FIN.id },
      { kind: "user" as const, id: JUN.id },
      { kind: "agent" as const, id: OPS.id },
      { kind: "user" as const, id: USER },
    ];
    const { unmount } = renderWithClient(<MessageItem message={withParticipants(six)} head />, crowdClient());
    const group = screen.getByRole("group", { name: "스레드 참여자" });
    expect(group.querySelectorAll('[data-slot="avatar"]')).toHaveLength(4);
    expect(within(group).getByRole("img", { name: "참여자 2명 더" })).toHaveTextContent("+2");
    // 사람은 이름으로, 에이전트는 핸들로 — 최근 순 그대로
    expect(
      within(group)
        .getAllByRole("img")
        .map((el) => el.getAttribute("aria-label")),
    ).toEqual(["@dev", "mia", "@fin", "jun", "참여자 2명 더"]);
    unmount();

    // 모르는 id 는 건너뛰고 +N 에도 세지 않는다(Review Focus 4)
    const withUnknown = [...six.slice(0, 5), { kind: "user" as const, id: uid(99) }];
    renderWithClient(<MessageItem message={withParticipants(withUnknown)} head />, crowdClient());
    const again = screen.getByRole("group", { name: "스레드 참여자" });
    expect(again.querySelectorAll('[data-slot="avatar"]')).toHaveLength(4);
    expect(within(again).getByRole("img", { name: "참여자 1명 더" })).toHaveTextContent("+1");
  });

  it("chip shows the running agent in the thread", () => {
    const item = withParticipants([{ kind: "user", id: USER }]);
    act(() => {
      useRunStore.getState().applyState(runState({ id: RUN, status: "streaming", threadRootId: ROOT.id }));
    });
    renderWithClient(<MessageItem message={item} head />, crowdClient());
    expect(activeText()).toBe("@dev 응답 중…");
    const chip = screen.getByRole("link", { name: /답글 2개/ });
    expect(chip).toHaveAccessibleName(/@dev 응답 중…/);
    // 목록에 없던 dev 가 앞에, 링
    const group = screen.getByRole("group", { name: "스레드 참여자" });
    const faces = group.querySelectorAll('[data-slot="avatar"]');
    expect(faces[0]).toHaveAttribute("aria-label", "@dev");
    expect(faces[0]).toHaveAttribute("data-active", "true");
    expect(faces[0]).toHaveClass("ring-primary!", "motion-safe:animate-pulse");
    expect(faces[1]).not.toHaveAttribute("data-active");

    // 끝나면(done) 링과 문구가 사라진다 — 칩은 남는다(Review Focus 2)
    act(() => {
      useRunStore.getState().applyState(runState({ id: RUN, status: "done", threadRootId: ROOT.id }));
    });
    expect(activeText()).toBeNull();
    expect(screen.getByRole("link", { name: /답글 2개/ })).toHaveTextContent("마지막 답글");
    expect(document.querySelector('[data-active="true"]')).toBeNull();
  });

  it("running agent beyond the 4th shows first, chip avatars are 28px", () => {
    const six = [
      { kind: "user" as const, id: MIA.id },
      { kind: "agent" as const, id: FIN.id },
      { kind: "user" as const, id: JUN.id },
      { kind: "agent" as const, id: OPS.id },
      { kind: "user" as const, id: USER },
      { kind: "agent" as const, id: AGENT },
    ];
    act(() => {
      useRunStore.getState().applyState(runState({ id: RUN, status: "tool", threadRootId: ROOT.id }));
    });
    renderWithClient(<MessageItem message={withParticipants(six)} head />, crowdClient());
    const group = screen.getByRole("group", { name: "스레드 참여자" });
    const faces = group.querySelectorAll('[data-slot="avatar"]');
    expect(faces).toHaveLength(4);
    // 6번째였던 dev 가 +N 에 숨지 않고 맨 앞에 링과 함께
    expect(faces[0]).toHaveAttribute("aria-label", "@dev");
    expect(faces[0]).toHaveAttribute("data-active", "true");
    expect(
      within(group)
        .getAllByRole("img")
        .map((el) => el.getAttribute("aria-label")),
    ).toEqual(["@dev", "mia", "@fin", "jun", "참여자 2명 더"]);
    for (const f of faces) expect(f).toHaveClass("size-7");
    expect(within(group).getByRole("img", { name: "참여자 2명 더" })).toHaveClass("size-7");
  });

  it("other thread or channel runs do not show", () => {
    act(() => {
      // 다른 스레드의 런, 채널(세션) 런, 다른 세션의 같은 rootId 런
      useRunStore
        .getState()
        .applyState(runState({ id: RUN, status: "streaming", threadRootId: uid(10_999) }));
      useRunStore.getState().applyState(runState({ id: RUN2, status: "streaming" }));
      useRunStore
        .getState()
        .applyState(
          runState({ id: uid(103), status: "tool", conversationId: uid(3), threadRootId: ROOT.id }),
        );
    });
    const { container } = renderWithClient(
      <MessageItem message={withParticipants([{ kind: "user", id: USER }])} head />,
      crowdClient(),
    );
    expect(activeText()).toBeNull();
    expect(container.querySelector('[data-active="true"]')).toBeNull();
    // 요약 없는 루트에는 그 런들로 칩이 생기지 않는다
    const bare = renderWithClient(<MessageItem message={msg(5)} head />, crowdClient());
    expect(bare.container.querySelector('[data-slot="thread-chip"]')).toBeNull();
  });

  it("chip renders for a running thread with no replies yet", () => {
    const { container } = renderWithClient(<MessageItem message={ROOT} head />, crowdClient());
    expect(container.querySelector('[data-slot="thread-chip"]')).toBeNull();
    act(() => {
      useRunStore.getState().applyState(runState({ id: RUN, status: "queued", threadRootId: ROOT.id }));
    });
    const chip = container.querySelector('[data-slot="thread-chip"]');
    expect(chip).toHaveAccessibleName("스레드 참여자 스레드 @dev 대기 중…");
    expect(chip).toHaveAttribute("href", `/c/${CH}/s/${CH}/t/${ROOT.id}`);
    expect(chip).not.toHaveTextContent("답글");
    expect(activeText()).toBe("@dev 대기 중…");
  });

  it("「스레드에서 답하기」 — 루트면 그 스레드, 답글이면 그 답글의 루트 스레드(Review Focus 1)", () => {
    renderWithClient(<MessageItem message={ROOT} head />);
    expect(screen.getByRole("link", { name: "스레드에서 답하기" })).toHaveAttribute(
      "href",
      `/c/${CH}/s/${CH}/t/${ROOT.id}`,
    );
  });

  it("답글에서 「스레드에서 답하기」 는 답글이 아니라 루트를 연다", () => {
    renderWithClient(<MessageItem message={reply(3)} head />);
    expect(screen.getByRole("link", { name: "스레드에서 답하기" })).toHaveAttribute(
      "href",
      `/c/${CH}/s/${CH}/t/${ROOT.id}`,
    );
  });

  it("스레드 패널 안에서는 칩도 메뉴도 없다 — 이미 그 스레드이고 스레드 안의 스레드는 없다", () => {
    renderWithClient(<MessageItem message={{ ...ROOT, threadSummary: summary }} head inThread />);
    expect(screen.queryByRole("link", { name: "스레드에서 답하기" })).toBeNull();
    expect(screen.queryByRole("link", { name: /답글 2개/ })).toBeNull();
  });
});

/**
 * 스레드를 닫으면 초점을 연 자리로(p4t-c1, T6/T7 리뷰 m5). 칩·「스레드에서 답하기」로 열었으면 그것, 그 자리가 화면에서
 * 사라졌거나 주소로 들어왔으면 헤더의 「채널 설정」(D14). 설정·활동 탭은 그대로 헤더다
 */
describe("스레드 닫기 초점(m5)", () => {
  const inList = async () => within(await screen.findByRole("region", { name: "메시지" }));
  const header = () => within(screen.getByTestId("channel-header")).getByRole("link", { name: "채널 설정" });
  const closeThread = async () =>
    userEvent.click(
      within(await screen.findByTestId("page-channel-panel")).getByRole("link", { name: "스레드 닫기" }),
    );

  it("넓은 화면: 칩으로 연 스레드를 닫으면 초점이 그 칩으로 돌아간다", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, channelClient());
    const chip = await (await inList()).findByRole("link", { name: /답글 2개/ });
    await userEvent.click(chip);
    await panel();
    // 패널 안(작성기 등)으로 초점을 옮긴 뒤 닫아도
    screen.getByRole("textbox", { name: "스레드 답글 입력" }).focus();

    await closeThread();

    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    await waitFor(() => expect(screen.queryByTestId("page-channel-panel")).not.toBeInTheDocument());
    expect(chip).toHaveFocus();
  });

  it("넓은 화면: 「스레드에서 답하기」로 연 스레드를 닫으면 그 행의 그 버튼으로 돌아간다", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, channelClient([ROOT]));
    const open = await (await inList()).findByRole("link", { name: "스레드에서 답하기" });
    await userEvent.click(open);
    await panel();

    await closeThread();

    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    expect(open).toHaveFocus();
  });

  it("좁은 화면: 칩으로 연 스레드 시트를 Esc 로 닫으면 칩으로 돌아간다", async () => {
    stubMedia(true);
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, channelClient());
    const chip = await (await inList()).findByRole("link", { name: /답글 2개/ });
    await userEvent.click(chip);
    await screen.findByRole("dialog");

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(chip).toHaveFocus());
  });

  it("주소로 연 스레드(연 자리 없음)를 닫으면 헤더의 「채널 설정」", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}`, channelClient());
    await panel();

    await closeThread();

    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    expect(header()).toHaveFocus();
  });

  it("연 칩이 화면에서 사라졌으면 헤더의 「채널 설정」", async () => {
    const qc = channelClient();
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, qc);
    await userEvent.click(await (await inList()).findByRole("link", { name: /답글 2개/ }));
    await panel();
    // 요약이 빠져 칩이 내려간다
    act(() => qc.setQueryData<Timeline>(qk.timeline(CH, CH), (t) => t && { ...t, items: [ROOT] }));
    await waitFor(() => expect(channelList().querySelector('[data-slot="thread-chip"]')).toBeNull());

    await closeThread();

    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    expect(header()).toHaveFocus();
  });

  it("칩으로 연 뒤 다른 스레드로 옮겼으면(검색·주소) 앞 칩이 아니라 헤더의 「채널 설정」", async () => {
    const other = msg(9, { bodyMd: "다른 루트" });
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, channelClient());
    await userEvent.click(await (await inList()).findByRole("link", { name: /답글 2개/ }));
    await panel();
    await act(() =>
      router.navigate({
        to: "/c/$channelId/s/$conversationId/t/$rootId",
        params: { channelId: CH, conversationId: CH, rootId: other.id },
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/t/${other.id}`));

    await closeThread();

    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    expect(header()).toHaveFocus();
  });

  it("칩으로 스레드를 연 뒤 설정 탭으로 옮겨 닫으면 설정 탭의 규칙대로 헤더의 「채널 설정」(D14)", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, channelClient());
    await userEvent.click(await (await inList()).findByRole("link", { name: /답글 2개/ }));
    const aside = await screen.findByTestId("page-channel-panel");
    await userEvent.click(within(aside).getByRole("link", { name: "설정" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/settings`));

    await userEvent.click(
      await within(await screen.findByTestId("page-channel-panel")).findByRole("link", { name: "설정 닫기" }),
    );

    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    expect(header()).toHaveFocus();
  });

  it("칩으로 열고 닫은 뒤 같은 스레드를 주소로 열어 닫으면 채널 설정", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, channelClient());
    const chip = await (await inList()).findByRole("link", { name: /답글 2개/ });
    await userEvent.click(chip);
    await panel();
    await closeThread();
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));

    // 주소로 다시 열었다 — 칩을 누르지 않아 연 자리를 남기지 않는다
    await act(() =>
      router.navigate({
        to: "/c/$channelId/s/$conversationId/t/$rootId",
        params: { channelId: CH, conversationId: CH, rootId: ROOT.id },
      }),
    );
    await panel();

    await closeThread();

    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    expect(header()).toHaveFocus();
  });
});

describe("URL 로 열기", () => {
  it("/c/:id/t/:rootId 새로고침 — 스레드 REST 로 루트·답글을 받아 패널에 그리고, 탭 머리에 「스레드」", async () => {
    renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}`, channelClient());
    const view = await panel();
    expect(await within(view).findByText("루트 질문")).toBeInTheDocument();
    expect(within(view).getByText("답글 2")).toBeInTheDocument();
    expect(within(view).getByText("답글 3")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(
      `/api/v1/conversations/${CH}/threads/${ROOT.id}/messages?limit=50`,
    );
    const tabs = screen.getByRole("navigation", { name: "패널 탭" });
    expect(within(tabs).getByRole("link", { name: "스레드" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("textbox", { name: "스레드 답글 입력" })).toBeInTheDocument();
    // 「새 대화」는 걷었다 — owner 가 연 패널 머리에도 없다
    expect(within(view).queryByRole("button", { name: /새 대화/ })).toBeNull();
    // 채널 목록에는 답글이 없다 — 루트와 칩만
    expect(within(channelList()).queryByText("답글 2")).toBeNull();
    expect(within(channelList()).getByText("루트 질문")).toBeInTheDocument();
  });

  it("없는 루트(404)면 「스레드를 찾을 수 없습니다」 — 전역 토스트 없이 패널 안에", async () => {
    threadReply = () => json(404, { code: "NOT_FOUND", message: "thread not found" });
    renderRoute(`/c/${CH}/s/${CH}/t/${uid(999)}`, channelClient());
    expect(await screen.findByText("스레드를 찾을 수 없습니다")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "세션으로 돌아가기" })).toHaveAttribute(
      "href",
      `/c/${CH}/s/${CH}`,
    );
  });

  it("주소의 루트가 UUID 가 아니면(VALIDATION) 「스레드를 찾을 수 없습니다」 — /c/:id/t/nope", async () => {
    threadReply = () => json(400, { code: "VALIDATION", message: "rootId must be a uuid" });
    renderRoute(`/c/${CH}/s/${CH}/t/nope`, channelClient());
    expect(await screen.findByText("스레드를 찾을 수 없습니다")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "세션으로 돌아가기" })).toHaveAttribute(
      "href",
      `/c/${CH}/s/${CH}`,
    );
  });

  it("좁은 화면(390px)에서는 전체 화면 시트로 뜬다", async () => {
    stubMedia(true);
    renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}`, channelClient());
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveAttribute("data-panel-tab", "thread");
    expect(sheet.className).toContain("w-full");
    expect(await within(sheet).findByText("답글 3")).toBeInTheDocument();
    expect(within(sheet).getByRole("textbox", { name: "스레드 답글 입력" })).toBeInTheDocument();
  });

  it("패널이 열린 채 버블만 다시 그려진 뒤 무효화해도 스레드 REST 를 다시 부른다(p4t-t6 리뷰 I2)", async () => {
    const qc = channelClient();
    renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}`, qc);
    const view = await panel();
    await within(view).findByText("답글 3");
    const threadCalls = () =>
      fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(`/api/v1/conversations/${CH}/threads/`))
        .length;
    expect(threadCalls()).toBe(1);
    // 스레드 버블 하나 — 패널의 버블 관찰자만 다시 그려진다
    act(() =>
      useRunStore.getState().applyState(runState({ id: RUN2, status: "queued", threadRootId: ROOT.id })),
    );
    await waitFor(() => expect(view.querySelector(`[data-run-id="${RUN2}"]`)).not.toBeNull());

    await act(() => qc.invalidateQueries({ queryKey: qk.threads(CH, CH) }));
    expect(threadCalls()).toBe(2);
    expect(qc.getQueryState(qk.thread(CH, CH, ROOT.id))?.status).toBe("success");
  });

  it("연 스레드는 채널마다 마지막 하나로 그 세션과 함께 기억한다(오프라인 사본 대상)", async () => {
    const qc = channelClient();
    renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}`, qc);
    await panel();
    await waitFor(() =>
      expect(qc.getQueryData(qk.recentThreads)).toEqual({ [CH]: { conversationId: CH, rootId: ROOT.id } }),
    );
  });
});

describe("스레드 메인 보기(UI 시안 06)", () => {
  afterEach(() => {
    window.localStorage.clear();
    layoutStore.reset();
  });
  const main = () => screen.findByTestId("thread-main");
  const stored = () =>
    JSON.parse(window.localStorage.getItem(LAYOUT_KEY) ?? "null") as Record<string, unknown> | null;
  const textOf = (box: HTMLElement) => (box as unknown as { editor: Editor }).editor.getText();

  it("주소의 view=main 이면 가운데 칸 전체가 그 스레드 — 경로 머리, 세션 칸은 숨긴다", async () => {
    renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}?view=main`, channelClient());
    const view = await main();
    expect(within(view).getByRole("heading", { name: /스레드$/ })).toHaveTextContent(/^#/);
    expect(within(view).getByRole("button", { name: "채널로 돌아가기" })).toBeInTheDocument();
    expect(within(view).getByRole("link", { name: "패널로 보기" })).toHaveAttribute(
      "href",
      `/c/${CH}/s/${CH}/t/${ROOT.id}`,
    );
    const thread = await panel();
    expect(view).toContainElement(thread);
    expect(await within(thread).findByText("답글 3")).toBeInTheDocument();
    expect(within(thread).getByRole("textbox", { name: "스레드 답글 입력" })).toBeInTheDocument();
    // 오른쪽 패널은 없고, 세션 칸(머리·목록·작성기)은 숨긴 채 남는다
    expect(screen.queryByTestId("page-channel-panel")).toBeNull();
    expect(screen.getByTestId("channel-header").closest("section")).toHaveAttribute("hidden");
  });

  it("「크게 보기」↔「패널로 보기」 — 주소·기억이 바뀌고, 고치던 초안과 작성기가 그대로다", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}`, channelClient());
    const box = await within(await panel()).findByRole("textbox", { name: "스레드 답글 입력" });
    act(() => {
      (box as unknown as { editor: Editor }).editor.commands.setContent("쓰던 답");
    });
    const panelHead = await screen.findByTestId("page-channel-panel");
    await userEvent.click(within(panelHead).getByRole("link", { name: "크게 보기" }));

    const view = await main();
    expect(router.state.location.search).toEqual({ view: "main" });
    expect(stored()).toMatchObject({ threadView: "main" });
    // 같은 작성기(다시 마운트되지 않았다)라 초안이 남는다
    expect(within(view).getByRole("textbox", { name: "스레드 답글 입력" })).toBe(box);
    expect(textOf(box)).toBe("쓰던 답");
    // 누른 단추가 사라졌으니 초점은 반대쪽 단추로
    await waitFor(() => expect(within(view).getByRole("link", { name: "패널로 보기" })).toHaveFocus());

    await userEvent.click(within(view).getByRole("link", { name: "패널로 보기" }));
    const back = await screen.findByTestId("page-channel-panel");
    expect(screen.queryByTestId("thread-main")).toBeNull();
    expect(router.state.location.search).toEqual({});
    expect(stored()).toMatchObject({ threadView: "panel" });
    expect(within(back).getByRole("textbox", { name: "스레드 답글 입력" })).toBe(box);
    expect(textOf(box)).toBe("쓰던 답");
    await waitFor(() => expect(within(back).getByRole("link", { name: "크게 보기" })).toHaveFocus());
  });

  it("뒤로 가기는 기록 그대로 — 패널 → 크게 보기 → 뒤로 = 패널, 앞으로 = 메인", async () => {
    const { router, history } = renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}`, channelClient());
    const panelHead = await screen.findByTestId("page-channel-panel");
    await userEvent.click(within(panelHead).getByRole("link", { name: "크게 보기" }));
    await main();
    expect(stored()).toMatchObject({ threadView: "main" });

    act(() => history.back());
    expect(await screen.findByTestId("page-channel-panel")).toBeInTheDocument();
    // 기억이 메인이어도 패널 주소를 다시 메인으로 넘기지 않는다
    await new Promise((r) => setTimeout(r, 50));
    expect(router.state.location.search).toEqual({});
    expect(screen.queryByTestId("thread-main")).toBeNull();

    act(() => history.forward());
    expect(await main()).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ view: "main" });
  });

  it("기억이 메인이어도 view 없는 주소는 패널로 연다 — 보기는 주소가 정한다", async () => {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ threadView: "main" }));
    layoutStore.reset();
    const { router } = renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}`, channelClient());
    expect(await screen.findByTestId("page-channel-panel")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({});
    expect(screen.queryByTestId("thread-main")).toBeNull();
  });

  it("마지막으로 고른 보기로 다음 스레드를 연다 — 칩을 눌러도 메인", async () => {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ threadView: "main" }));
    layoutStore.reset();
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, channelClient());
    const chip = await within(await screen.findByRole("region", { name: "메시지" })).findByRole("link", {
      name: /답글 2개/,
    });
    await userEvent.click(chip);
    expect(await main()).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/t/${ROOT.id}`);
    expect(router.state.location.search).toEqual({ view: "main" });
  });

  it("Esc 는 세션으로 — 원글 자리로 가서 그 행이 초점을 받는다", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}?view=main`, channelClient());
    const view = await main();
    const box = await within(view).findByRole("textbox", { name: "스레드 답글 입력" });
    await within(view).findByText("답글 3");
    box.focus();
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    expect(screen.queryByTestId("thread-main")).toBeNull();
    expect(screen.getByTestId("channel-header").closest("section")).not.toHaveAttribute("hidden");
    await waitFor(() => {
      const focused = document.activeElement as HTMLElement;
      expect(channelList()).toContainElement(focused);
      expect(focused).toHaveTextContent("루트 질문");
    });
  });

  it("편집기가 Esc 를 먹어도(ProseMirror 가 keyCode 27 을 preventDefault) 세션으로 — 캡처 단계에서 받는다", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}?view=main`, channelClient());
    const view = await main();
    const box = await within(view).findByRole("textbox", { name: "스레드 답글 입력" });
    box.focus();
    const ev = new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true });
    // 편집기 자신의 처리기가 먼저 막는 것을 그대로 — 버블 단계 처리기는 defaultPrevented 를 본다
    let editorPrevented = false;
    box.addEventListener("keydown", (e) => (editorPrevented = e.defaultPrevented));
    act(() => {
      box.dispatchEvent(ev);
    });
    expect(editorPrevented || ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
  });

  it("초점이 아무 데도 없어도(body) Esc 는 세션으로", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}?view=main`, channelClient());
    await within(await main()).findByText("답글 3");
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(document.activeElement).toBe(document.body);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
  });

  it("Esc 는 먼저 쓸 자리에 양보한다 — @ 제안 목록이 열린 편집기(aria-controls)면 그대로 남는다", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}?view=main`, channelClient());
    const view = await main();
    const box = await within(view).findByRole("textbox", { name: "스레드 답글 입력" });
    box.setAttribute("aria-controls", "mention-list");
    box.focus();
    await userEvent.keyboard("{Escape}");
    expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/t/${ROOT.id}`);
    expect(screen.getByTestId("thread-main")).toBeInTheDocument();
  });

  it("후보가 0개인 @ 제안이 열려 있으면 Esc 는 제안만 닫고, 그다음 Esc 에서 세션으로", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}?view=main`, channelClient());
    const view = await main();
    const box = await within(view).findByRole("textbox", { name: "스레드 답글 입력" });
    const editor = (box as unknown as { editor: Editor }).editor;
    act(() => {
      editor.commands.focus();
      editor.commands.insertContent("@없는이름zz");
    });
    // 제안은 열렸지만(쿼리 장식) 후보가 없어 목록·aria-controls 가 없다
    await waitFor(() => expect(box.querySelector("[data-decoration-id]")).not.toBeNull());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box).not.toHaveAttribute("aria-controls");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(box.querySelector("[data-decoration-id]")).toBeNull());
    expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/t/${ROOT.id}`);
    expect(screen.getByTestId("thread-main")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
  });

  it("← 「채널로 돌아가기」도 같다 · 보기 기억(메인)은 그대로", async () => {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ threadView: "main" }));
    layoutStore.reset();
    const { router } = renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}?view=main`, channelClient());
    const view = await main();
    await within(view).findByText("답글 3");
    await userEvent.click(within(view).getByRole("button", { name: "채널로 돌아가기" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    expect(stored()).toMatchObject({ threadView: "main" });
    expect(layoutStore.get().threadView).toBe("main");
  });

  it("좁은 화면은 view=main 이어도 전체 화면 시트 — 「크게 보기」가 없다", async () => {
    stubMedia(true);
    renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}?view=main`, channelClient());
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveAttribute("data-panel-tab", "thread");
    expect(screen.queryByTestId("thread-main")).toBeNull();
    expect(within(sheet).queryByRole("link", { name: "크게 보기" })).toBeNull();
  });
});

describe("스레드 작성기", () => {
  it("보내면 message.send 에 threadRootId(루트)를 싣고, 확정 답글은 스레드에만 보인다", async () => {
    const qc = channelClient();
    renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}`, qc);
    const view = await panel();
    await within(view).findByText("답글 3");
    fake.onAck("message.send", (p): Result<{ message: Message }> => {
      const { clientMsgId, bodyMd } = p as { clientMsgId: string; bodyMd: string };
      return { ok: true, data: { message: reply(4, { clientMsgId, bodyMd }) } };
    });
    const box = within(view).getByRole("textbox", { name: "스레드 답글 입력" });
    const editor = (box as unknown as { editor: Editor }).editor;
    act(() => {
      editor.commands.setContent("스레드에서 답");
      editor.commands.focus("end");
    });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => expect(within(view).getByText("스레드에서 답")).toBeInTheDocument());
    expect(fake.sentOf("message.send")[0]).toMatchObject({
      channelId: CH,
      threadRootId: ROOT.id,
      bodyMd: "스레드에서 답",
    });
    await waitFor(() =>
      expect(getThread(qc, CH, CH, ROOT.id)?.items.map((m) => m.seq)).toEqual([1, 2, 3, 4]),
    );
    expect(within(channelList()).queryByText("스레드에서 답")).toBeNull();
    // 스레드에서 쓰는 것은 채널의 「입력 중」으로 알리지 않는다
    expect(fake.sentOf("typing")).toEqual([]);
  });

  it("/stop 은 그 스레드의 런만 멈춘다 — 채널 런은 그대로", async () => {
    act(() => {
      useRunStore.getState().applyState(runState({ id: RUN, status: "streaming" }));
      useRunStore.getState().applyState(runState({ id: RUN2, status: "streaming", threadRootId: ROOT.id }));
    });
    fake.onAck("run.abort", () => ({ ok: true, data: null }));
    renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}`, channelClient());
    const view = await panel();
    const box = await within(view).findByRole("textbox", { name: "스레드 답글 입력" });
    const editor = (box as unknown as { editor: Editor }).editor;
    act(() => {
      editor.commands.setContent("/stop");
      editor.commands.focus("end");
    });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fake.sentOf("run.abort")).toEqual([{ runId: RUN2 }]));
  });
});

describe("버블·승인의 소속(판정 R3′)", () => {
  /** 채널 목록과 스레드 목록을 나란히 — 둘 다 버블을 그린다 */
  function Both() {
    const channelRuns = useChannelBubbles(CH, CH);
    const threadRuns = useChannelBubbles(CH, CH, ROOT.id);
    return (
      <>
        <section aria-label="채널">
          <MessageList
            channelId={CH}
            conversationId={CH}
            bubbleRunIds={channelRuns}
            bubbles={(id) => <StreamingBubble runId={id} />}
            initialRect={RECT}
          />
        </section>
        <section aria-label="스레드">
          <MessageList
            channelId={CH}
            conversationId={CH}
            threadRootId={ROOT.id}
            bubbleRunIds={threadRuns}
            bubbles={(id) => <StreamingBubble runId={id} />}
            initialRect={RECT}
          />
        </section>
      </>
    );
  }
  function renderBoth() {
    const qc = authorsClient();
    qc.setQueryData(qk.timeline(CH, CH), { ...emptyTimeline(), items: [ROOT], lastSeq: 1 });
    qc.setQueryData<Timeline>(qk.thread(CH, CH, ROOT.id), threadFromPage(undefined, ROOT, [], false));
    renderWithClient(<Both />, qc);
    const scope = (name: string) => screen.getByRole("region", { name });
    return { channel: () => scope("채널"), thread: () => scope("스레드") };
  }
  const bubbles = (el: HTMLElement) =>
    [...el.querySelectorAll("[data-run-id]")].map((b) => b.getAttribute("data-run-id"));

  it("스레드 런의 스트리밍 버블은 스레드에만, 채널 런의 버블은 채널에만", async () => {
    const { channel, thread } = renderBoth();
    act(() => {
      const s = useRunStore.getState();
      s.applyState(runState({ id: RUN, status: "streaming" }));
      s.applyEvent(textDelta(1, "채널에서 답하는 중", RUN));
      s.applyState(runState({ id: RUN2, status: "streaming", threadRootId: ROOT.id }));
      s.applyEvent(textDelta(1, "스레드에서 답하는 중", RUN2));
    });
    await waitFor(() => expect(bubbles(thread())).toEqual([RUN2]));
    expect(bubbles(channel())).toEqual([RUN]);
    expect(within(thread()).getByText("스레드에서 답하는 중")).toBeInTheDocument();
    expect(within(channel()).queryByText("스레드에서 답하는 중")).toBeNull();
  });

  it("queued 스레드 런(RUN_STARTED 전)도 스레드에만 — run.state 의 threadRootId 로 가른다", async () => {
    const { channel, thread } = renderBoth();
    act(() =>
      useRunStore.getState().applyState(runState({ id: RUN2, status: "queued", threadRootId: ROOT.id })),
    );
    await waitFor(() => expect(bubbles(thread())).toEqual([RUN2]));
    expect(bubbles(channel())).toEqual([]);
  });

  it("queued→error 로 끝난 스레드 런(RUN_STARTED 없음)의 실패 버블이 채널 타임라인에 새지 않는다", async () => {
    const { channel, thread } = renderBoth();
    act(() => {
      const s = useRunStore.getState();
      s.applyState(runState({ id: RUN2, status: "queued", threadRootId: ROOT.id }));
      s.applyState(
        runState({
          id: RUN2,
          status: "error",
          threadRootId: ROOT.id,
          error: { code: "PLUGIN_OUTDATED", message: "x" },
        }),
      );
    });
    await waitFor(() => expect(within(thread()).getByText(/실행 실패: PLUGIN_OUTDATED/)).toBeInTheDocument());
    expect(within(channel()).queryByText(/실행 실패/)).toBeNull();
  });

  it("run.state 에 threadRootId 가 없어도(옛 서버) RUN_STARTED 의 세션 키로 스레드에 옮긴다", async () => {
    const { channel, thread } = renderBoth();
    act(() => {
      const s = useRunStore.getState();
      s.applyState(runState({ id: RUN2, status: "streaming" }));
      s.applyEvent(
        runEvent({
          type: "RUN_STARTED",
          runId: RUN2,
          seq: 1,
          threadId: CH,
          agentId: AGENT,
          sessionKey: `agent:dev:dodok:channel:${CH}:thread:${ROOT.id}`,
        }),
      );
    });
    await waitFor(() => expect(bubbles(thread())).toEqual([RUN2]));
    expect(bubbles(channel())).toEqual([]);
  });

  it("스레드 런의 승인 카드는 스레드에만 — 런이 스토어에서 빠진 뒤의 확정 카드도", async () => {
    const { channel, thread } = renderBoth();
    act(() => {
      useRunStore
        .getState()
        .applyState(runState({ id: RUN2, status: "awaiting_approval", threadRootId: ROOT.id }));
      useApprovalStore.getState().apply(approval({ runId: RUN2 }));
    });
    await waitFor(() => expect(within(thread()).getAllByText(/Write/).length).toBeGreaterThan(0));
    expect(within(channel()).queryByText(/Write/)).toBeNull();

    act(() => {
      useRunStore.getState().remove(RUN2);
      useApprovalStore.getState().apply(approval({ runId: RUN2, status: "allowed", decision: "allow-once" }));
    });
    await waitFor(() => expect(within(thread()).getAllByText(/Write/).length).toBeGreaterThan(0));
    expect(within(channel()).queryByText(/Write/)).toBeNull();
  });
});

describe("스레드 과거 페이지", () => {
  it("맨 위에 닿으면 스레드 REST 로 가장 옛 답글 앞(beforeSeq)을 받아 루트 뒤에 붙인다", async () => {
    const replies = Array.from({ length: 30 }, (_, i) => reply(i + 51));
    const qc = authorsClient();
    qc.setQueryData<Timeline>(qk.thread(CH, CH, ROOT.id), threadFromPage(undefined, ROOT, replies, true));
    threadReply = () => json(200, threadPage([reply(49), reply(50)], false));
    const { container } = renderWithClient(
      <MessageList channelId={CH} conversationId={CH} threadRootId={ROOT.id} initialRect={RECT} />,
      qc,
    );
    const scroller = container.querySelector<HTMLElement>("[data-scroller]") as HTMLElement;
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
    await act(async () => {
      scroller.dispatchEvent(new Event("wheel"));
      scroller.scrollTop = 100;
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() => expect(getThread(qc, CH, CH, ROOT.id)?.items).toHaveLength(33));
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(
      `/api/v1/conversations/${CH}/threads/${ROOT.id}/messages?limit=50&beforeSeq=51`,
    );
    expect(
      getThread(qc, CH, CH, ROOT.id)
        ?.items.slice(0, 3)
        .map((m) => m.seq),
    ).toEqual([1, 49, 50]);
    expect(getThread(qc, CH, CH, ROOT.id)?.hasOlder).toBe(false);
  });
});

/**
 * 채널 읽음과 스레드 패널(읽지 않음 태스크 3 리뷰 I1·m1). 스레드 멘션 푸시는 /c/<id>/t/<rootId> 로 열려서, 좁은 화면에서
 * 시트가 타임라인을 덮고 있는 동안 채널 전체가 읽음이 되면 안 된다
 */
describe("채널 읽음과 스레드 패널", () => {
  const sender = () => ({ request: vi.fn(), dispose: vi.fn() });
  const open = (path: string, s: ReturnType<typeof sender>) =>
    renderRoute(path, channelClient(), (children) => (
      <ReadSenderContext.Provider value={s}>{children}</ReadSenderContext.Provider>
    ));
  afterEach(() => useUnread.getState().reset());

  it("좁은 화면: 스레드 시트가 타임라인을 덮고 있으면 읽음을 보내지 않고, 닫으면 보낸다", async () => {
    stubMedia(true);
    const s = sender();
    const { router } = open(`/c/${CH}/s/${CH}/t/${ROOT.id}`, s);
    await screen.findByRole("dialog");
    await panel();

    expect(s.request).not.toHaveBeenCalled();
    expect(isViewingAtEnd(CH)).toBe(false);

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
    await waitFor(() => expect(s.request).toHaveBeenCalledWith(CH, 3));
    expect(isViewingAtEnd(CH)).toBe(true);
  });

  it("넓은 화면: 옆 스레드 패널은 타임라인을 덮지 않는다 — 읽음을 보내고, 패널이 채널의 끝 보임을 지우지 않는다(m1)", async () => {
    const s = sender();
    open(`/c/${CH}/s/${CH}/t/${ROOT.id}`, s);
    await panel();

    await waitFor(() => expect(s.request).toHaveBeenCalledWith(CH, 3));
    expect(s.request.mock.calls.every(([channelId]) => channelId === CH)).toBe(true);
    expect(isViewingAtEnd(CH)).toBe(true);
  });
});

/** 채널에 들어갈 때 한 번 잡는 읽음 위치(구분선 — 읽지 않음 태스크 4, Review Focus 3) */
describe("채널 진입의 「새 메시지」 구분선", () => {
  const theirs = [1, 2, 3, 4].map((seq) => msg(seq, { authorId: uid(77), bodyMd: `남의 글 ${seq}` }));
  const snapshot = (lastReadSeq: number) => {
    useUnread.getState().beginSnapshot();
    useUnread.getState().applySnapshot({
      channels: [CH, CH2],
      conversations: [
        {
          conversationId: CH,
          channelId: CH,
          lastReadSeq,
          latestSeq: 4,
          unread: lastReadSeq < 4,
          mentions: 0,
        },
      ],
    });
  };
  const open = (path = `/c/${CH}/s/${CH}`) =>
    renderRoute(path, channelClient(theirs), (children) => (
      <ReadSenderContext.Provider value={{ request: vi.fn(), dispose: vi.fn() }}>
        {children}
      </ReadSenderContext.Provider>
    ));
  const line = () => screen.queryByRole("separator", { name: "새 메시지" });
  beforeEach(() => useUnread.getState().reset());
  afterEach(() => useUnread.getState().reset());

  it("스냅숏이 있으면 첫 안 읽은 글 앞에 서고, 읽음이 올라도 채널을 떠날 때까지 남는다", async () => {
    snapshot(2);
    const { router } = open();
    await screen.findByText("남의 글 4");
    expect(await screen.findByRole("separator", { name: "새 메시지" })).toBeInTheDocument();
    act(() =>
      useUnread.getState().applyRead({ conversationId: CH, channelId: CH, lastReadSeq: 4 }, { listed: true }),
    );
    // 같은 채널에서 패널을 여닫아 채널 페이지가 다시 그려져도 기준은 다시 잡히지 않는다
    await act(() =>
      router.navigate({
        to: "/c/$channelId/s/$conversationId/activity",
        params: { channelId: CH, conversationId: CH },
      }),
    );
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(line()).toBeInTheDocument();
  });

  it("떠났다 다시 들어오면 그때의 읽음 위치로 다시 잡는다", async () => {
    snapshot(2);
    const { router } = open();
    await screen.findByRole("separator", { name: "새 메시지" });
    act(() =>
      useUnread.getState().applyRead({ conversationId: CH, channelId: CH, lastReadSeq: 4 }, { listed: true }),
    );
    await act(() => router.navigate({ to: "/settings/account" }));
    await waitFor(() => expect(screen.queryByText("남의 글 4")).toBeNull());
    await act(() =>
      router.navigate({
        to: "/c/$channelId/s/$conversationId",
        params: { channelId: CH, conversationId: CH },
      }),
    );
    await screen.findByText("남의 글 4");
    expect(line()).toBeNull();
  });

  it("채널 사이를 바로 옮기면(채널 페이지는 다시 마운트되지 않는다) 그 채널의 읽음 위치로 다시 잡는다", async () => {
    const others = [1, 2, 3].map((seq) =>
      msg(seq, { id: uid(20_000 + seq), channelId: CH2, authorId: uid(77), bodyMd: `B 글 ${seq}` }),
    );
    act(() => {
      useUnread.getState().beginSnapshot();
      useUnread.getState().applySnapshot({
        channels: [CH, CH2],
        conversations: [
          { conversationId: CH, channelId: CH, lastReadSeq: 2, latestSeq: 4, unread: true, mentions: 0 },
          { conversationId: CH2, channelId: CH2, lastReadSeq: 1, latestSeq: 3, unread: true, mentions: 0 },
        ],
      });
    });
    const qc = channelClient(theirs);
    qc.setQueryData(qk.timeline(CH2, CH2), { ...emptyTimeline(), items: others, lastSeq: 3 });
    setChannelSeq(qc, CH2, 3);
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, qc, (children) => (
      <ReadSenderContext.Provider value={{ request: vi.fn(), dispose: vi.fn() }}>
        {children}
      </ReadSenderContext.Provider>
    ));
    const after = async () =>
      (await screen.findByRole("separator", { name: "새 메시지" })).closest("[data-index]")
        ?.nextElementSibling;
    await screen.findByText("남의 글 4");
    expect(await after()).toHaveTextContent("남의 글 3");
    act(() =>
      useUnread.getState().applyRead({ conversationId: CH, channelId: CH, lastReadSeq: 4 }, { listed: true }),
    );

    await act(() =>
      router.navigate({
        to: "/c/$channelId/s/$conversationId",
        params: { channelId: CH2, conversationId: CH2 },
      }),
    );
    await screen.findByText("B 글 3");
    expect(await after()).toHaveTextContent("B 글 2");

    await act(() =>
      router.navigate({
        to: "/c/$channelId/s/$conversationId",
        params: { channelId: CH, conversationId: CH },
      }),
    );
    await screen.findByText("남의 글 4");
    expect(line()).toBeNull();
  });

  it("같은 채널 안에서 세션을 옮겨도 그 세션의 읽음 위치로 다시 잡는다 — 앞 세션의 위치를 쓰지 않는다", async () => {
    const S2 = uid(30_000);
    const others = [5, 6, 7].map((seq) =>
      msg(seq, { id: uid(30_000 + seq), conversationId: S2, authorId: uid(77), bodyMd: `S2 글 ${seq}` }),
    );
    act(() => {
      useUnread.getState().beginSnapshot();
      useUnread.getState().applySnapshot({
        channels: [CH],
        conversations: [
          { conversationId: CH, channelId: CH, lastReadSeq: 2, latestSeq: 4, unread: true, mentions: 0 },
          // S2 의 글(5·6·7)은 CH 세션의 읽음 위치(2)보다 모두 뒤다 — 세션 단위로 잡지 않으면 「S2 글 5」 앞에 선이 선다
          { conversationId: S2, channelId: CH, lastReadSeq: 6, latestSeq: 7, unread: true, mentions: 0 },
        ],
      });
    });
    const qc = channelClient(theirs);
    qc.setQueryData(qk.timeline(CH, S2), { ...emptyTimeline(), items: others, lastSeq: 7 });
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, qc, (children) => (
      <ReadSenderContext.Provider value={{ request: vi.fn(), dispose: vi.fn() }}>
        {children}
      </ReadSenderContext.Provider>
    ));
    const after = async () =>
      (await screen.findByRole("separator", { name: "새 메시지" })).closest("[data-index]")
        ?.nextElementSibling;
    await screen.findByText("남의 글 4");
    expect(await after()).toHaveTextContent("남의 글 3");

    await act(() =>
      router.navigate({
        to: "/c/$channelId/s/$conversationId",
        params: { channelId: CH, conversationId: S2 },
      }),
    );
    await screen.findByText("S2 글 7");
    expect(await after()).toHaveTextContent("S2 글 7");
  });

  it("「이전 대화」가 아닌 세션 주소로 바로 열면(새로고침·푸시 링크) 첫 마운트부터 그 세션의 읽음 위치로 긋는다", async () => {
    const S2 = uid(31_000);
    const others = [5, 6, 7].map((seq) =>
      msg(seq, { id: uid(31_000 + seq), conversationId: S2, authorId: uid(77), bodyMd: `S2 글 ${seq}` }),
    );
    act(() => {
      useUnread.getState().beginSnapshot();
      useUnread.getState().applySnapshot({
        channels: [CH],
        conversations: [
          // 세션 id 가 채널 id 와 같은 「이전 대화」의 위치(2)로 잡으면 「S2 글 5」 앞에 선이 선다
          { conversationId: CH, channelId: CH, lastReadSeq: 2, latestSeq: 4, unread: true, mentions: 0 },
          { conversationId: S2, channelId: CH, lastReadSeq: 6, latestSeq: 7, unread: true, mentions: 0 },
        ],
      });
    });
    const qc = channelClient(theirs);
    qc.setQueryData(qk.timeline(CH, S2), { ...emptyTimeline(), items: others, lastSeq: 7 });
    renderRoute(`/c/${CH}/s/${S2}`, qc, (children) => (
      <ReadSenderContext.Provider value={{ request: vi.fn(), dispose: vi.fn() }}>
        {children}
      </ReadSenderContext.Provider>
    ));
    await screen.findByText("S2 글 7");
    const separator = await screen.findByRole("separator", { name: "새 메시지" });
    expect(separator.closest("[data-index]")?.nextElementSibling).toHaveTextContent("S2 글 7");
  });

  it("Review Focus 3 — 들어갈 때 스냅숏이 없으면 구분선을 짐작해 긋지 않고, 스냅숏이 뒤늦게 와도 튀어나오지 않는다", async () => {
    open();
    await screen.findByText("남의 글 4");
    expect(line()).toBeNull();
    act(() => snapshot(2));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(line()).toBeNull();
  });

  it("스냅숏에 항목이 없는 채널(보관 해제 직후 등)에서도 맨 앞에 긋지 않는다", async () => {
    act(() => {
      useUnread.getState().beginSnapshot();
      useUnread.getState().applySnapshot({ conversations: [], channels: [] });
    });
    open();
    await screen.findByText("남의 글 4");
    expect(line()).toBeNull();
  });

  it("안 읽은 채널은 구분선이 위쪽에 오게 열고, 패널을 여닫아도 다시 끌고 가지 않으며, 떠났다 돌아오면 다시 내려앉는다(처음 한 번만)", async () => {
    const long = Array.from({ length: 60 }, (_, i) =>
      msg(i + 1, { authorId: uid(77), bodyMd: `긴 글 ${i + 1}` }),
    );
    // 읽음 40, 최신 60 — 날짜 구분선 1 + 메시지 40 개 뒤가 「새 메시지」 행이고 그 행은 위에서 128px 아래에 선다
    act(() => {
      useUnread.getState().beginSnapshot();
      useUnread.getState().applySnapshot({
        channels: [CH, CH2],
        conversations: [
          { conversationId: CH, channelId: CH, lastReadSeq: 40, latestSeq: 60, unread: true, mentions: 0 },
        ],
      });
    });
    const qc = channelClient(long);
    qc.setQueryData(qk.timeline(CH, CH), { ...emptyTimeline(), items: long, lastSeq: 60 });
    const s = { request: vi.fn(), dispose: vi.fn() };
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, qc, (children) => (
      <ReadSenderContext.Provider value={s}>{children}</ReadSenderContext.Provider>
    ));
    const top = () => channelList().scrollTop;
    await screen.findByRole("separator", { name: "새 메시지" });
    await waitFor(() => expect(top()).toBe(41 * 64 - 128));
    expect(s.request).not.toHaveBeenCalled();

    // 사용자가 조금 올려 둔 채 패널을 열었다 닫아도 그 자리다
    await act(async () => {
      channelList().dispatchEvent(new Event("wheel"));
      channelList().scrollTop = 1000;
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(() =>
      router.navigate({
        to: "/c/$channelId/s/$conversationId/activity",
        params: { channelId: CH, conversationId: CH },
      }),
    );
    await act(() =>
      router.navigate({
        to: "/c/$channelId/s/$conversationId",
        params: { channelId: CH, conversationId: CH },
      }),
    );
    await act(() => new Promise((r) => setTimeout(r, 120)));
    expect(top()).toBe(1000);
    expect(s.request).not.toHaveBeenCalled();

    // 채널을 떠났다 돌아오면 그때 다시 — 읽음 위치는 그때 값(40)이다
    await act(() => router.navigate({ to: "/settings/account" }));
    await waitFor(() => expect(screen.queryByText("긴 글 60")).toBeNull());
    await act(() =>
      router.navigate({
        to: "/c/$channelId/s/$conversationId",
        params: { channelId: CH, conversationId: CH },
      }),
    );
    await screen.findByRole("separator", { name: "새 메시지" });
    await waitFor(() => expect(top()).toBe(41 * 64 - 128));
  });

  it.each(["activity", "settings"])(
    "좁은 화면: %s 시트가 타임라인을 덮고 있으면 읽음을 보내지 않는다(스레드 시트만이 아니다)",
    async (tab) => {
      stubMedia(true);
      snapshot(2);
      const s = { request: vi.fn(), dispose: vi.fn() };
      renderRoute(`/c/${CH}/s/${CH}/${tab}`, channelClient(theirs), (children) => (
        <ReadSenderContext.Provider value={s}>{children}</ReadSenderContext.Provider>
      ));
      await screen.findByRole("dialog");
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(s.request).not.toHaveBeenCalled();
      expect(isViewingAtEnd(CH)).toBe(false);
    },
  );
});
