import type { Message, Result } from "@dodok/shared";
import type { Editor } from "@tiptap/core";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { MessageItem } from "@/features/messages/MessageItem";
import { MessageList } from "@/features/messages/MessageList";
import { emptyTimeline, threadFromPage, type Timeline } from "@/features/messages/timeline";
import { StreamingBubble } from "@/features/runs/StreamingBubble";
import { useChannelBubbles } from "@/features/runs/useChannelBubbles";
import { useRunStore } from "@/features/runs/runStore";
import { getThread } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import {
  AGENT,
  approval,
  CH,
  msg,
  RUN,
  RUN2,
  runEvent,
  runState,
  textDelta,
  uid,
} from "../../../test/fixtures";
import { stubMedia } from "../../../test/media";
import { authorsClient, DEV, renderWithClient } from "../../../test/messages";
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
    if (url.startsWith(`/api/v1/channels/${CH}/threads/`)) return threadReply(url) ?? json(404, {});
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

/** 채널 타임라인(루트만)을 채운 클라이언트 */
function channelClient(items: Message[] = [{ ...ROOT, threadSummary: summary }]) {
  const qc = createQueryClient(() => {});
  qc.setQueryData(qk.timeline(CH), { ...emptyTimeline(), items, lastSeq: 3 });
  return qc;
}
const panel = () => screen.findByTestId("thread-panel");
const channelList = () => screen.getByRole("region", { name: "메시지" });

describe("채널 타임라인의 칩·메뉴", () => {
  it("루트 아래 칩 「답글 N · 마지막 답글 · 에이전트 아바타」 — 누르면 그 스레드", async () => {
    const qc = authorsClient();
    qc.setQueryData(qk.timeline(CH), {
      ...emptyTimeline(),
      items: [{ ...ROOT, threadSummary: summary }],
      lastSeq: 3,
    });
    const { container } = renderWithClient(<MessageList channelId={CH} initialRect={RECT} />, qc);

    const chip = await screen.findByRole("link", { name: /답글 2개/ });
    expect(chip).toHaveAttribute("href", `/c/${CH}/t/${ROOT.id}`);
    expect(chip).toHaveTextContent("마지막 답글");
    // 요약의 에이전트(dev)의 아바타 하나
    expect(chip.querySelectorAll('[data-slot="avatar"]')).toHaveLength(1);
    // 답글 없는 루트에는 칩이 없다
    expect(container.querySelectorAll('[data-slot="thread-chip"]')).toHaveLength(1);
  });

  it("「스레드에서 답하기」 — 루트면 그 스레드, 답글이면 그 답글의 루트 스레드(Review Focus 1)", () => {
    renderWithClient(<MessageItem message={ROOT} head />);
    expect(screen.getByRole("link", { name: "스레드에서 답하기" })).toHaveAttribute(
      "href",
      `/c/${CH}/t/${ROOT.id}`,
    );
  });

  it("답글에서 「스레드에서 답하기」 는 답글이 아니라 루트를 연다", () => {
    renderWithClient(<MessageItem message={reply(3)} head />);
    expect(screen.getByRole("link", { name: "스레드에서 답하기" })).toHaveAttribute(
      "href",
      `/c/${CH}/t/${ROOT.id}`,
    );
  });

  it("스레드 패널 안에서는 칩도 메뉴도 없다 — 이미 그 스레드이고 스레드 안의 스레드는 없다", () => {
    renderWithClient(<MessageItem message={{ ...ROOT, threadSummary: summary }} head inThread />);
    expect(screen.queryByRole("link", { name: "스레드에서 답하기" })).toBeNull();
    expect(screen.queryByRole("link", { name: /답글 2개/ })).toBeNull();
  });
});

describe("URL 로 열기", () => {
  it("/c/:id/t/:rootId 새로고침 — 스레드 REST 로 루트·답글을 받아 패널에 그리고, 탭 머리에 「스레드」", async () => {
    renderRoute(`/c/${CH}/t/${ROOT.id}`, channelClient());
    const view = await panel();
    expect(await within(view).findByText("루트 질문")).toBeInTheDocument();
    expect(within(view).getByText("답글 2")).toBeInTheDocument();
    expect(within(view).getByText("답글 3")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(
      `/api/v1/channels/${CH}/threads/${ROOT.id}/messages?limit=50`,
    );
    const tabs = screen.getByRole("navigation", { name: "패널 탭" });
    expect(within(tabs).getByRole("link", { name: "스레드" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("textbox", { name: "스레드 답글 입력" })).toBeInTheDocument();
    // 채널 목록에는 답글이 없다 — 루트와 칩만
    expect(within(channelList()).queryByText("답글 2")).toBeNull();
    expect(within(channelList()).getByText("루트 질문")).toBeInTheDocument();
  });

  it("없는 루트(404)면 「스레드를 찾을 수 없습니다」 — 전역 토스트 없이 패널 안에", async () => {
    threadReply = () => json(404, { code: "NOT_FOUND", message: "thread not found" });
    renderRoute(`/c/${CH}/t/${uid(999)}`, channelClient());
    expect(await screen.findByText("스레드를 찾을 수 없습니다")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "채널로 돌아가기" })).toHaveAttribute("href", `/c/${CH}`);
  });

  it("좁은 화면(390px)에서는 전체 화면 시트로 뜬다", async () => {
    stubMedia(true);
    renderRoute(`/c/${CH}/t/${ROOT.id}`, channelClient());
    const sheet = await screen.findByRole("dialog");
    expect(sheet).toHaveAttribute("data-panel-tab", "thread");
    expect(sheet.className).toContain("w-full");
    expect(await within(sheet).findByText("답글 3")).toBeInTheDocument();
    expect(within(sheet).getByRole("textbox", { name: "스레드 답글 입력" })).toBeInTheDocument();
  });

  it("연 스레드는 채널마다 마지막 하나로 기억한다(오프라인 사본 대상)", async () => {
    const qc = channelClient();
    renderRoute(`/c/${CH}/t/${ROOT.id}`, qc);
    await panel();
    await waitFor(() => expect(qc.getQueryData(qk.recentThreads)).toEqual({ [CH]: ROOT.id }));
  });
});

describe("스레드 작성기", () => {
  it("보내면 message.send 에 threadRootId(루트)를 싣고, 확정 답글은 스레드에만 보인다", async () => {
    const qc = channelClient();
    renderRoute(`/c/${CH}/t/${ROOT.id}`, qc);
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
    await waitFor(() => expect(getThread(qc, CH, ROOT.id)?.items.map((m) => m.seq)).toEqual([1, 2, 3, 4]));
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
    renderRoute(`/c/${CH}/t/${ROOT.id}`, channelClient());
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

  it("에이전트 줄의 「새 대화」 — 그 스레드의 세션만(?threadRootId=)", async () => {
    renderRoute(`/c/${CH}/t/${ROOT.id}`, channelClient());
    const view = await panel();
    await userEvent.click(await within(view).findByRole("button", { name: "@dev 새 대화" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("이 스레드에서 @dev 와의 대화 기록을 새로 시작합니다");
    fetchMock.mockImplementationOnce(async () => json(200, { ok: true }));
    await userEvent.click(within(dialog).getByRole("button", { name: "새 대화 시작" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === "POST");
    expect(String(post?.[0])).toBe(`/api/v1/channels/${CH}/agents/${AGENT}/reset?threadRootId=${ROOT.id}`);
  });
});

describe("버블·승인의 소속(판정 R3′)", () => {
  /** 채널 목록과 스레드 목록을 나란히 — 둘 다 버블을 그린다 */
  function Both() {
    const channelRuns = useChannelBubbles(CH);
    const threadRuns = useChannelBubbles(CH, ROOT.id);
    return (
      <>
        <section aria-label="채널">
          <MessageList
            channelId={CH}
            bubbleRunIds={channelRuns}
            bubbles={(id) => <StreamingBubble runId={id} />}
            initialRect={RECT}
          />
        </section>
        <section aria-label="스레드">
          <MessageList
            channelId={CH}
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
    qc.setQueryData(qk.timeline(CH), { ...emptyTimeline(), items: [ROOT], lastSeq: 1 });
    qc.setQueryData<Timeline>(qk.thread(CH, ROOT.id), threadFromPage(undefined, ROOT, [], false));
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
    qc.setQueryData<Timeline>(qk.thread(CH, ROOT.id), threadFromPage(undefined, ROOT, replies, true));
    threadReply = () => json(200, threadPage([reply(49), reply(50)], false));
    const { container } = renderWithClient(
      <MessageList channelId={CH} threadRootId={ROOT.id} initialRect={RECT} />,
      qc,
    );
    const scroller = container.querySelector<HTMLElement>("[data-scroller]") as HTMLElement;
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
    await act(async () => {
      scroller.dispatchEvent(new Event("wheel"));
      scroller.scrollTop = 100;
      await new Promise((r) => setTimeout(r, 10));
    });
    await waitFor(() => expect(getThread(qc, CH, ROOT.id)?.items).toHaveLength(33));
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(
      `/api/v1/channels/${CH}/threads/${ROOT.id}/messages?limit=50&beforeSeq=51`,
    );
    expect(
      getThread(qc, CH, ROOT.id)
        ?.items.slice(0, 3)
        .map((m) => m.seq),
    ).toEqual([1, 49, 50]);
    expect(getThread(qc, CH, ROOT.id)?.hasOlder).toBe(false);
  });
});
