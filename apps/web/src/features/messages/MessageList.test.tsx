import type { Message } from "@dodok/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { registerUnauthorized } from "@/app/session";
import { getChannelSeq, setChannelSeq, updateTimeline } from "@/realtime/timelineCache";
import { AGENT, APPROVAL, APPROVAL2, approval, CH, CH2, msg, RUN, uid } from "../../../test/fixtures";
import { authorsClient, renderWithClient } from "../../../test/messages";
import { remeasureRows, setViewportHeight, stubScrollLayout } from "../../../test/scrollLayout";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { ReadSenderContext } from "@/features/reads/readSender";
import { isViewingAtEnd, useUnread } from "@/features/reads/useUnread";
import { useWireStatus } from "@/realtime/wire";
import { requestJump, useJumpStore } from "./jumpTarget";
import { MessageList } from "./MessageList";
import { useTimeline } from "./useTimeline";
import { addPending, emptyTimeline, type Timeline, upsert } from "./timeline";

const RECT = { width: 800, height: 600 };
const ROW = 64;
/** 에이전트 메시지 seq from..to (같은 날, 1초 간격) */
const range = (from: number, to: number, over: Partial<Message> = {}): Message[] =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    msg(from + i, { authorType: "agent", authorId: AGENT, bodyMd: `본문 ${from + i}`, ...over }),
  );
const timelineOf = (items: Message[], hasOlder = false): Timeline => ({
  ...emptyTimeline(),
  items,
  hasOlder,
  lastSeq: items.at(-1)?.seq ?? 0,
});

let restore: () => void;
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
beforeEach(() => {
  restore = stubScrollLayout({ ...RECT, rowHeight: ROW });
  fetchMock = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 캐시를 채우고 그 채널을 구독한 것으로(채널 커서) — 받은 것이 지금 것이어야 결과로 가기·배너가 돈다(useTimelineState `ready`) */
function subscribedWith(
  qc: ReturnType<typeof authorsClient>,
  key: readonly unknown[],
  t: Timeline,
  channelId = CH,
) {
  qc.setQueryData(key, t);
  setChannelSeq(qc, channelId, Math.max(t.lastSeq, getChannelSeq(qc, channelId) ?? 0));
}

function setup(t: Timeline | undefined, channelId = CH) {
  const qc = authorsClient();
  if (t) subscribedWith(qc, qk.timeline(channelId, channelId), t, channelId);
  const view = renderWithClient(
    <MessageList channelId={channelId} conversationId={channelId} initialRect={RECT} />,
    qc,
  );
  const scroller = () => view.container.querySelector<HTMLElement>("[data-scroller]") as HTMLElement;
  /** 사용자가 그 자리로 스크롤한 것처럼 — 손을 댔다는 신호(휠)와 scrollTop 을 함께, scroll 이벤트가 처리될 때까지 */
  const scrollTo = async (top: number) => {
    await act(async () => {
      scroller().dispatchEvent(new Event("wheel"));
      scroller().scrollTop = top;
      await new Promise((r) => setTimeout(r, 10));
    });
  };
  const atEnd = () => scroller().scrollTop === scroller().scrollHeight - scroller().clientHeight;
  return { ...view, qc, scroller, scrollTo, atEnd };
}

/**
 * virtual-core 는 `scrollToEnd` 뒤 5초 동안 프레임마다 목표를 다시 겨눈다(reconcile). 첫 붙임이 남긴 그 창 안에서는
 * 뷰포트가 줄 때 목표가 바뀌어 가상 목록이 스스로 끝으로 옮겨 가고, 위로 올려 둔 사람도 함께 끌려간다.
 * 시계를 앞당겨 그 창을 지나 보낸다 — 그래야 뒤이은 크기 변화가 우리 ResizeObserver 만 재게 된다.
 * (돌려주는 값은 afterEach 의 restoreAllMocks 가 거둔다)
 */
async function pastVirtualizerReconcile() {
  const real = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => real() + 6_000);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

describe("MessageList", () => {
  it("타임라인이 아직 없으면 불러오는 중 자리표시, 비었으면 안내", async () => {
    const { qc } = setup(undefined);
    expect(screen.getByRole("status", { name: "메시지를 불러오는 중" })).toBeInTheDocument();
    act(() => qc.setQueryData(qk.timeline(CH, CH), emptyTimeline()));
    expect(await screen.findByText(/아직 메시지가 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "메시지를 불러오는 중" })).toBeNull();
  });

  it("타임라인이 나중에 오면(구독 응답) 그때 맨 아래로 간다", async () => {
    const { qc, atEnd } = setup(undefined);
    act(() => qc.setQueryData(qk.timeline(CH, CH), timelineOf(range(1, 40))));
    await waitFor(() => expect(screen.getByText("본문 40")).toBeInTheDocument());
    await waitFor(() => expect(atEnd()).toBe(true));
  });

  it("행이 그려지고(가상 목록 — 보이는 것만) 처음에는 맨 아래에 붙는다", async () => {
    const { atEnd } = setup(timelineOf(range(1, 40)));
    await waitFor(() => expect(screen.getByText("본문 40")).toBeInTheDocument());
    await waitFor(() => expect(atEnd()).toBe(true));
    expect(screen.queryByText("본문 1")).toBeNull();
    expect(screen.getAllByRole("article").length).toBeLessThan(40);
  });

  it("첫 진입에서 겨눈 뒤에 행이 다시 재어져 총 높이가 줄어도 맨 아래에 남는다", async () => {
    // 행은 추정 높이(64)로 먼저 잡혔다 실제로 재어진다 — 실물에서는 그 순간 겨눈 자리가 맨 위로 떨어졌다
    restore();
    let measured = ROW;
    restore = stubScrollLayout({ ...RECT, rowHeight: () => measured });
    const { atEnd, scroller } = setup(timelineOf(range(1, 60)));
    await waitFor(() => expect(atEnd()).toBe(true));
    const tall = scroller().scrollHeight;

    measured = 28;
    await act(async () => {
      remeasureRows();
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(scroller().scrollHeight).toBeLessThan(tall);
    expect(atEnd()).toBe(true);
    expect(screen.getByText("본문 60")).toBeInTheDocument();
  });

  it("끝에 붙어 있을 때 뷰포트가 줄면(배너가 생기면) 다시 끝으로 맞춘다", async () => {
    const { scroller, atEnd } = setup(timelineOf(range(1, 40)));
    await waitFor(() => expect(atEnd()).toBe(true));
    await pastVirtualizerReconcile();
    const before = scroller().scrollTop;

    // 배너가 생긴 만큼 뷰포트가 줄어든다 — 브라우저는 scrollTop 을 그대로 둬 끝에서 그만큼 떨어진다
    await act(async () => {
      setViewportHeight(RECT.height - 44);
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(scroller().clientHeight).toBe(RECT.height - 44);
    expect(scroller().scrollTop).toBe(before + 44);
    expect(atEnd()).toBe(true);
  });

  it("사용자가 위로 올려 둔 자리는 뷰포트가 줄어도 그대로 — 끌어내리지 않는다", async () => {
    const { scroller, scrollTo, atEnd } = setup(timelineOf(range(1, 40)));
    await waitFor(() => expect(atEnd()).toBe(true));
    await scrollTo(300);
    expect(atEnd()).toBe(false);
    await pastVirtualizerReconcile();

    await act(async () => {
      setViewportHeight(RECT.height - 44);
      await new Promise((r) => setTimeout(r, 100));
    });

    expect(scroller().scrollTop).toBe(300);
    expect(atEnd()).toBe(false);
  });

  it("첫 붙임 중에 사용자가 위로 올리면 다시 끌어내리지 않는다", async () => {
    const { scroller, atEnd } = setup(timelineOf(range(1, 60)));
    await waitFor(() => expect(atEnd()).toBe(true));
    // 휠 = 사용자가 스크롤을 잡았다는 신호. 그 뒤로는 첫 붙임이 그 자리를 건드리지 않는다
    await act(async () => {
      scroller().dispatchEvent(new Event("wheel"));
      scroller().scrollTop = 200;
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(scroller().scrollTop).toBe(200);
    expect(atEnd()).toBe(false);
  });

  it("맨 아래에 붙어 있으면 새 메시지가 오면 끝으로 따라가고, 칩은 잠깐도 뜨지 않는다", async () => {
    const { qc, atEnd, container } = setup(timelineOf(range(1, 40)));
    await waitFor(() => expect(atEnd()).toBe(true));
    // 라이브 영역에 한 번이라도 들어가면 스크린 리더가 읽는다 — 변화를 모두 센다
    const live = container.querySelector("[aria-live=polite]") as HTMLElement;
    let flashes = 0;
    const observer = new MutationObserver((records) => {
      flashes += records.reduce((n, r) => n + r.addedNodes.length, 0);
    });
    observer.observe(live, { childList: true, subtree: true });
    act(() => updateTimeline(qc, CH, CH, (t) => upsert(t, range(41, 41)[0] as Message)));
    await waitFor(() => expect(screen.getByText("본문 41")).toBeInTheDocument());
    await waitFor(() => expect(atEnd()).toBe(true));
    observer.disconnect();
    expect(flashes).toBe(0);
    expect(screen.queryByRole("button", { name: /새 메시지/ })).toBeNull();
  });

  it("맨 아래가 아니면 따라가지 않고 「새 메시지 N개」 칩 — 누르면 끝으로 가고 칩이 사라진다", async () => {
    const { qc, scrollTo, atEnd, scroller } = setup(timelineOf(range(1, 40)));
    await waitFor(() => expect(atEnd()).toBe(true));
    await scrollTo(300);
    act(() => updateTimeline(qc, CH, CH, (t) => range(41, 42).reduce(upsert, t)));
    const chip = await screen.findByRole("button", { name: "새 메시지 2개" });
    expect(chip.closest("[aria-live=polite]")).not.toBeNull();
    expect(scroller().scrollTop).toBe(300);
    expect(screen.queryByText("본문 42")).toBeNull();

    await userEvent.click(chip);
    await waitFor(() => expect(atEnd()).toBe(true));
    expect(screen.getByText("본문 42")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /새 메시지/ })).toBeNull();
    expect(screen.getByRole("region", { name: "메시지" })).toHaveFocus();
  });

  it("사본에서 복원한 타임라인(lastSeq 0)은 위로 올려도 가진 메시지를 새 메시지로 세지 않는다 — 그 뒤 온 것만", async () => {
    const { qc, scrollTo, atEnd } = setup({ ...timelineOf(range(1, 40)), lastSeq: 0 });
    await waitFor(() => expect(atEnd()).toBe(true));
    await scrollTo(300);
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(screen.queryByRole("button", { name: /새 메시지/ })).toBeNull();
    act(() => updateTimeline(qc, CH, CH, (t) => upsert(t, range(41, 41)[0] as Message)));
    await screen.findByRole("button", { name: "새 메시지 1개" });
  });

  it("스크롤해서 맨 아래로 돌아오면 칩이 사라진다", async () => {
    const { qc, scrollTo, scroller } = setup(timelineOf(range(1, 40)));
    await scrollTo(300);
    act(() => updateTimeline(qc, CH, CH, (t) => upsert(t, range(41, 41)[0] as Message)));
    await screen.findByRole("button", { name: "새 메시지 1개" });
    await scrollTo(scroller().scrollHeight);
    await waitFor(() => expect(screen.queryByRole("button", { name: /새 메시지/ })).toBeNull());
  });

  it("내가 보낸 항목(보내는 중)이 붙으면 위에 있어도 끝으로 간다", async () => {
    const { qc, scrollTo, atEnd } = setup(timelineOf(range(1, 40)));
    await scrollTo(300);
    act(() =>
      updateTimeline(qc, CH, CH, (t) =>
        addPending(t, {
          clientMsgId: "c-1",
          channelId: CH,
          bodyMd: "내 말",
          createdAt: new Date().toISOString(),
          state: "sending",
        }),
      ),
    );
    await waitFor(() => expect(atEnd()).toBe(true));
    expect(screen.getByText("내 말")).toBeInTheDocument();
  });

  it("맨 위 근처에 닿으면 과거 페이지(beforeSeq=가장 옛 seq, limit 50)를 앞에 붙이고 보던 자리를 유지한다", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ messages: range(1, 50), hasMore: false }), { status: 200 }),
    );
    const { qc, scrollTo, scroller } = setup(timelineOf(range(51, 80), true));
    await waitFor(() => expect(scroller().scrollTop).toBeGreaterThan(0));
    await scrollTo(100);
    await waitFor(() => expect(qc.getQueryData<Timeline>(qk.timeline(CH, CH))?.items).toHaveLength(80));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `/api/v1/conversations/${CH}/messages?limit=50&beforeSeq=51`,
    );
    expect(qc.getQueryData<Timeline>(qk.timeline(CH, CH))?.hasOlder).toBe(false);
    // 붙은 행: 메시지 50 + 맨 위 날짜 구분선 1 — 그만큼 아래로 옮겨 같은 행이 같은 자리에 보인다
    await waitFor(() => expect(scroller().scrollTop).toBe(100 + 51 * ROW));
    expect(screen.getByText("본문 52")).toBeInTheDocument();
  });

  it("과거 페이지 실패는 토스트 한 번, 맨 위 구역을 벗어났다 돌아오기 전에는 다시 부르지 않는다", async () => {
    const error = vi.spyOn(toast, "error");
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ code: "INTERNAL", message: "터졌다" }), { status: 500 }),
    );
    const { scrollTo, scroller } = setup(timelineOf(range(51, 80), true));
    await waitFor(() => expect(scroller().scrollTop).toBeGreaterThan(0));
    await scrollTo(100);
    await waitFor(() => expect(error).toHaveBeenCalledWith("터졌다"));
    await scrollTo(50);
    await scrollTo(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);

    await scrollTo(800);
    await scrollTo(100);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("과거 페이지 401 은 토스트 없이 앱의 401 처리(로그인)를 한 번 부른다", async () => {
    const error = vi.spyOn(toast, "error");
    const onUnauthorized = vi.fn();
    const unregister = registerUnauthorized(onUnauthorized);
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "로그인이 필요하다" }), { status: 401 }),
    );
    const { scrollTo, scroller } = setup(timelineOf(range(51, 80), true));
    await waitFor(() => expect(scroller().scrollTop).toBeGreaterThan(0));
    await scrollTo(100);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    await scrollTo(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    unregister();
  });

  it("과거 페이지 네트워크 실패는 공용 id 「network」 토스트", async () => {
    const error = vi.spyOn(toast, "error");
    fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { scrollTo, scroller } = setup(timelineOf(range(51, 80), true));
    await waitFor(() => expect(scroller().scrollTop).toBeGreaterThan(0));
    await scrollTo(100);
    await waitFor(() => expect(error).toHaveBeenCalledWith("서버에 연결할 수 없습니다", { id: "network" }));
  });

  it("더 옛 메시지가 없으면(hasOlder false) 맨 위에서도 부르지 않는다", async () => {
    const { scrollTo, scroller } = setup(timelineOf(range(1, 40)));
    await waitFor(() => expect(scroller().scrollTop).toBeGreaterThan(0));
    await scrollTo(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("버블은 확정 메시지 뒤, 보내는 중 앞에 그린다", async () => {
    const qc = authorsClient();
    qc.setQueryData(
      qk.timeline(CH, CH),
      addPending(timelineOf(range(1, 2)), {
        clientMsgId: "c-1",
        channelId: CH,
        bodyMd: "내 말",
        createdAt: new Date().toISOString(),
        state: "sending",
      }),
    );
    const { container } = renderWithClient(
      <MessageList
        channelId={CH}
        conversationId={CH}
        initialRect={RECT}
        bubbleRunIds={[RUN]}
        bubbles={(runId) => <div data-testid="bubble">버블 {runId}</div>}
      />,
      qc,
    );
    await screen.findByTestId("bubble");
    const text = container.textContent ?? "";
    expect(text.indexOf("본문 2")).toBeLessThan(text.indexOf(`버블 ${RUN}`));
    expect(text.indexOf(`버블 ${RUN}`)).toBeLessThan(text.indexOf("내 말"));
  });

  it("끝에 붙은 채 마지막 행이 다른 key 로 바뀌면(버블 → 확정 메시지, 보내는 중 → 확정) 끝에 그대로 붙는다", async () => {
    // 행 높이를 추정(64)과 다르게 — 새 key 행이 추정으로 먼저 잡혔다 재어지는 경로
    restore();
    restore = stubScrollLayout({ ...RECT, rowHeight: 55 });
    // 앱처럼 버블 목록을 타임라인에서 끌어낸다 — 확정 답이 들어오는 커밋에서 버블이 함께 빠진다
    function Harness() {
      const t = useTimeline(CH, CH);
      const answered = t?.items.some((m) => m.runId === RUN) ?? false;
      const ids = useMemo(() => (answered ? [] : [RUN]), [answered]);
      return (
        <MessageList
          channelId={CH}
          conversationId={CH}
          initialRect={RECT}
          bubbleRunIds={ids}
          bubbles={(runId) => <div data-testid="bubble">버블 {runId}</div>}
        />
      );
    }
    const qc = authorsClient();
    qc.setQueryData(qk.timeline(CH, CH), timelineOf(range(1, 40)));
    const { container } = renderWithClient(<Harness />, qc);
    const scroller = container.querySelector("[data-scroller]") as HTMLElement;
    const gap = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    // 앞선 스크롤이 멎은 뒤에 바꾼다 — virtual-core 는 스크롤 직후(150ms)에는 새 행을 재지 않고, 앞선 끝 맞추기가
    // 아직 돌고 있으면 어긋남을 대신 메워 결함이 가려진다(실물에서는 답이 오기 한참 전에 멎어 있다)
    const settle = () => act(() => new Promise((r) => setTimeout(r, 300)));

    await screen.findByTestId("bubble");
    await waitFor(() => expect(gap()).toBe(0));

    await settle();
    act(() => updateTimeline(qc, CH, CH, (t) => upsert(t, range(41, 41, { runId: RUN })[0] as Message)));
    await waitFor(() => expect(screen.queryByTestId("bubble")).toBeNull());
    expect(screen.getByText("본문 41")).toBeInTheDocument();
    // 교체 뒤 끝에 그대로 — 고치기 전에는 9px 이 남는다(부하에서 늦어도 거짓 실패가 나지 않게 waitFor)
    await waitFor(() => expect(gap()).toBe(0));

    // 보내는 중 항목이 확정되는 교체도 같은 경로
    const clientMsgId = "c-last";
    act(() =>
      updateTimeline(qc, CH, CH, (t) =>
        addPending(t, {
          clientMsgId,
          channelId: CH,
          bodyMd: "내 말",
          createdAt: new Date().toISOString(),
          state: "sending",
        }),
      ),
    );
    await waitFor(() => expect(gap()).toBe(0));
    await settle();
    act(() => updateTimeline(qc, CH, CH, (t) => upsert(t, msg(42, { clientMsgId, bodyMd: "내 말" }))));
    await waitFor(() => expect(screen.queryByRole("status", { name: "보내는 중" })).toBeNull());
    // 이 경로는 jsdom 에서 고치기 전에도 0 이다 — 회귀 방지용(실물 확인은 태스크 13)
    await waitFor(() => expect(gap()).toBe(0));
  });

  it("채널을 옮기면 칩·스크롤 상태를 새로 시작한다", async () => {
    const qc = authorsClient();
    qc.setQueryData(qk.timeline(CH, CH), timelineOf(range(1, 40)));
    qc.setQueryData(qk.timeline(CH2, CH2), timelineOf(range(1, 40, { channelId: CH2 })));
    const view = renderWithClient(<MessageList channelId={CH} conversationId={CH} initialRect={RECT} />, qc);
    const scroller = () => view.container.querySelector<HTMLElement>("[data-scroller]") as HTMLElement;
    // 휠 = 사용자가 스크롤을 잡았다는 신호 — 이것 없이 scrollTop 만 옮기면 첫 붙임(settle)이 아직 살아 있을 때
    // 다음 프레임에 끝으로 되돌려 칩이 뜨지 않는다(부하에서 20회 중 1회). 이 파일의 다른 scroll 과 같은 방식
    await act(async () => {
      scroller().dispatchEvent(new Event("wheel"));
      scroller().scrollTop = 300;
      await new Promise((r) => setTimeout(r, 10));
    });
    act(() => updateTimeline(qc, CH, CH, (t) => upsert(t, range(41, 41)[0] as Message)));
    await screen.findByRole("button", { name: "새 메시지 1개" });

    view.rerender(<MessageList channelId={CH2} conversationId={CH2} initialRect={RECT} />);
    expect(screen.queryByRole("button", { name: /새 메시지/ })).toBeNull();
    await waitFor(() => expect(scroller().scrollTop).toBe(scroller().scrollHeight - scroller().clientHeight));
  });
});

describe("MessageList 승인 카드", () => {
  beforeEach(() => useApprovalStore.getState().reset());
  afterEach(() => useApprovalStore.getState().reset());

  /** 메시지 seq 1·2 는 08:00:01·08:00:02(msg 픽스처) — 승인 시각은 그 사이·그 뒤로 준다 */
  const between = "2027-01-15T08:00:01.500Z";
  const after = "2027-01-15T08:00:30.000Z";

  it("미해결 승인은 메시지 흐름 맨 아래에 카드로 뜬다 — 같은 승인이 두 번 와도 하나", async () => {
    act(() => {
      useApprovalStore.getState().apply(approval({ createdAt: after, toolCallId: undefined }));
      // 같은 승인의 둘째 프레임(p2-t6 Ruling C)
      useApprovalStore.getState().apply(approval({ createdAt: after, toolCallId: "toolu_77" }));
    });
    const { container } = setup(timelineOf(range(1, 2)));

    const cards = await screen.findAllByRole("group", { name: /승인 요청/ });
    expect(cards).toHaveLength(1);
    expect(screen.getByRole("button", { name: "이번만 허용" })).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(text.indexOf("본문 2")).toBeLessThan(text.indexOf("claude-cli native tool: Write"));
  });

  it("확정된 승인 카드는 사라지지 않고 결정 자리(decidedAt)에 결과로 남는다", async () => {
    act(() =>
      useApprovalStore.getState().apply(
        approval({
          createdAt: after,
          status: "allowed",
          decision: "allow-once",
          reason: "user",
          decidedAt: between,
        }),
      ),
    );
    const { container } = setup(timelineOf(range(1, 2)));

    await screen.findByRole("group", { name: /승인 요청/ });
    expect(screen.getByText("허용됨")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이번만 허용" })).not.toBeInTheDocument();
    // 두 메시지 사이 — 시간 순서 자리에 남는다
    const text = container.textContent ?? "";
    expect(text.indexOf("본문 1")).toBeLessThan(text.indexOf("claude-cli native tool: Write"));
    expect(text.indexOf("claude-cli native tool: Write")).toBeLessThan(text.indexOf("본문 2"));
  });

  it("승인이 확정돼도 카드는 제자리 — 대기 중 뒤에 낀 메시지 위로 튀지 않는다(D4)", async () => {
    act(() => useApprovalStore.getState().apply(approval({ createdAt: between })));
    const { container } = setup(timelineOf(range(1, 2)));
    await screen.findByRole("group", { name: /승인 요청/ });
    const before = container.textContent ?? "";
    expect(before.indexOf("본문 2")).toBeLessThan(before.indexOf("claude-cli native tool: Write"));

    act(() =>
      useApprovalStore.getState().apply(
        approval({
          createdAt: between,
          status: "denied",
          decision: "deny",
          reason: "user",
          decidedAt: after,
        }),
      ),
    );
    await waitFor(() => expect(screen.getByText("거절됨")).toBeInTheDocument());
    const text = container.textContent ?? "";
    expect(text.indexOf("본문 2")).toBeLessThan(text.indexOf("claude-cli native tool: Write"));
  });

  it("다른 채널·같은 채널의 다른 세션의 승인은 행도 만들지 않는다 — 빈 행이 끼지 않게", async () => {
    const { container } = setup(timelineOf(range(1, 2)));
    await screen.findByText("본문 2");
    // 구분선 + 메시지 둘
    const rows = () => container.querySelectorAll("[data-index]").length;
    expect(rows()).toBe(3);

    act(() => useApprovalStore.getState().apply(approval({ id: APPROVAL2, channelId: CH2 })));
    await waitFor(() => expect(rows()).toBe(3));
    expect(screen.queryByRole("group", { name: /승인 요청/ })).not.toBeInTheDocument();

    // 같은 채널의 다른 세션의 승인도 — 카드는 그 승인의 세션에만(채널 세션 계획 판정 PS7)
    act(() =>
      useApprovalStore
        .getState()
        .apply(approval({ id: uid(203), conversationId: uid(3_001), runId: undefined })),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(rows()).toBe(3);
    expect(screen.queryByRole("group", { name: /승인 요청/ })).not.toBeInTheDocument();

    // 이 채널의 승인이면 행이 는다
    act(() => useApprovalStore.getState().apply(approval({ id: APPROVAL })));
    await waitFor(() => expect(rows()).toBe(4));
  });
});

describe("MessageList 시스템 카드", () => {
  it("시스템 메시지는 카드로 그린다", async () => {
    const system = msg(3, {
      kind: "system",
      authorType: "system",
      authorId: undefined,
      bodyMd: "릴레이 한도에 닿았습니다",
      systemMeta: { kind: "relay_limit" },
    });
    setup(timelineOf([...range(1, 2), system]));
    const card = await screen.findByRole("note");
    expect(card).toHaveTextContent("릴레이 한도에 닿았습니다");
  });
});

describe("MessageList 읽음 전송", () => {
  const ROOT = msg(5, { authorType: "agent", authorId: AGENT, bodyMd: "루트" });
  const latestUrl = `/api/v1/conversations/${CH}/messages?limit=50`;

  beforeEach(() => {
    useWireStatus.setState({ status: "connected" });
    useUnread.getState().reset();
  });
  afterEach(() => {
    useWireStatus.setState({ status: "idle" });
    useUnread.getState().reset();
    useJumpStore.setState({ targets: {} });
  });

  /** 읽음 전송기(가짜)를 컨텍스트로 준 목록 — `threadRootId` 면 스레드 패널 */
  function setupRead(t: Timeline, threadRootId?: string) {
    const sender = { request: vi.fn(), dispose: vi.fn() };
    const qc = authorsClient();
    subscribedWith(qc, threadRootId ? qk.thread(CH, CH, threadRootId) : qk.timeline(CH, CH), t);
    const view = renderWithClient(
      <ReadSenderContext.Provider value={sender}>
        <MessageList channelId={CH} conversationId={CH} threadRootId={threadRootId} initialRect={RECT} />
      </ReadSenderContext.Provider>,
      qc,
    );
    const scroller = () => view.container.querySelector<HTMLElement>("[data-scroller]") as HTMLElement;
    const scrollTo = async (top: number) => {
      await act(async () => {
        scroller().dispatchEvent(new Event("wheel"));
        scroller().scrollTop = top;
        await new Promise((r) => setTimeout(r, 10));
      });
    };
    return { ...view, qc, sender, scroller, scrollTo };
  }
  const requested = (sender: { request: ReturnType<typeof vi.fn> }) =>
    sender.request.mock.calls.map(([channelId, seq]) => [channelId, seq]);

  it("끝에 붙어 있고 탭이 보이면 타임라인의 lastSeq(답글 seq 포함)를 요청하고, 끝이 보이는 채널로 알린다", async () => {
    // 답글이 채널 seq 를 올렸다 — 가진 마지막 루트(40)가 아니라 lastSeq(42)
    const { sender } = setupRead({ ...timelineOf(range(1, 40)), lastSeq: 42 });
    await waitFor(() => expect(requested(sender)).toEqual([[CH, 42]]));
    expect(isViewingAtEnd(CH)).toBe(true);
  });

  it("끝에 붙은 채 새 메시지로 lastSeq 가 커지면 다시 요청한다", async () => {
    const { qc, sender } = setupRead(timelineOf(range(1, 40)));
    await waitFor(() => expect(requested(sender)).toEqual([[CH, 40]]));
    act(() => updateTimeline(qc, CH, CH, (t) => upsert(t, range(41, 41)[0] as Message)));
    await waitFor(() =>
      expect(requested(sender)).toEqual([
        [CH, 40],
        [CH, 41],
      ]),
    );
  });

  it("스크롤이 위면 보내지 않고 끝이 안 보이는 것으로 알린다 — 끝으로 돌아오면 보낸다", async () => {
    const { qc, sender, scrollTo, scroller } = setupRead(timelineOf(range(1, 40)));
    await waitFor(() => expect(requested(sender)).toEqual([[CH, 40]]));
    await scrollTo(300);
    expect(isViewingAtEnd(CH)).toBe(false);
    act(() => updateTimeline(qc, CH, CH, (t) => upsert(t, range(41, 41)[0] as Message)));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(requested(sender)).toEqual([[CH, 40]]);

    await scrollTo(scroller().scrollHeight);
    await waitFor(() =>
      expect(requested(sender)).toEqual([
        [CH, 40],
        [CH, 41],
      ]),
    );
    expect(isViewingAtEnd(CH)).toBe(true);
  });

  it("Review Focus 2 — 떨어진 창(결과로 가기)의 아래 끝은 진짜 끝이 아니다: 보내지 않다가 「최신 메시지로」 뒤에 보낸다", async () => {
    fetchMock.mockImplementation(async (input) =>
      String(input) === latestUrl
        ? new Response(JSON.stringify({ messages: range(51, 100), hasMore: true }), { status: 200 })
        : new Response("{}", { status: 500 }),
    );
    const { sender, scrollTo, scroller } = setupRead({
      ...timelineOf(range(1, 20)),
      hasNewer: true,
      lastSeq: 100,
    });
    await screen.findByText("본문 20");
    await scrollTo(scroller().scrollHeight);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(sender.request).not.toHaveBeenCalled();
    expect(isViewingAtEnd(CH)).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /최신 메시지로/ }));
    await waitFor(() => expect(requested(sender)).toEqual([[CH, 100]]));
    expect(isViewingAtEnd(CH)).toBe(true);
  });

  it("결과로 가기 목표를 안고 열리면(가진 메시지여도) 끝을 본 것이 아니다 — 보내지 않는다", async () => {
    const target = range(10, 10)[0] as Message;
    act(() => requestJump({ conversationId: CH, messageId: target.id, seq: 10 }));
    const { sender } = setupRead(timelineOf(range(1, 40)));
    await waitFor(() =>
      expect(screen.getByText("본문 10").closest("[data-index]")).toHaveAttribute("data-highlighted", "true"),
    );
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(sender.request).not.toHaveBeenCalled();
    expect(isViewingAtEnd(CH)).toBe(false);
  });

  it("탭이 가려져 있으면 보내지 않고, 보이게 되면(visibilitychange) 보낸다", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { sender } = setupRead(timelineOf(range(1, 40)));
    await screen.findByText("본문 40");
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(sender.request).not.toHaveBeenCalled();
    expect(isViewingAtEnd(CH)).toBe(false);

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(requested(sender)).toEqual([[CH, 40]]));
    expect(isViewingAtEnd(CH)).toBe(true);
  });

  it("끊겨 있으면 보내지 않고, 다시 붙으면 보낸다 — 끊긴 사이 버려진 요청을 다시", async () => {
    useWireStatus.setState({ status: "reconnecting" });
    const { sender } = setupRead(timelineOf(range(1, 40)));
    await screen.findByText("본문 40");
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(sender.request).not.toHaveBeenCalled();
    act(() => useWireStatus.setState({ status: "connected" }));
    await waitFor(() => expect(requested(sender)).toEqual([[CH, 40]]));
  });

  it("사본에서 복원한 타임라인(lastSeq 0)은 보내지 않는다 — 구독 응답을 받은 뒤에", async () => {
    const { sender } = setupRead({ ...timelineOf(range(1, 40)), lastSeq: 0 });
    await screen.findByText("본문 40");
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(sender.request).not.toHaveBeenCalled();
  });

  it("스레드 패널은 채널 읽음을 올리지 않는다", async () => {
    const replies = [6, 7, 8].map((seq) => msg(seq, { threadRootId: ROOT.id, bodyMd: `답글 ${seq}` }));
    const { sender } = setupRead(timelineOf([ROOT, ...replies]), ROOT.id);
    await screen.findByText("답글 8");
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(sender.request).not.toHaveBeenCalled();
    expect(isViewingAtEnd(CH)).toBe(false);
  });

  it("목록이 내려가면(채널을 떠나면) 끝이 보이지 않는 것으로 돌린다", async () => {
    const { sender, unmount } = setupRead(timelineOf(range(1, 40)));
    await waitFor(() => expect(sender.request).toHaveBeenCalled());
    expect(isViewingAtEnd(CH)).toBe(true);
    unmount();
    expect(isViewingAtEnd(CH)).toBe(false);
  });
});

describe("MessageList 「새 메시지」 구분선·페이지 밖 배너", () => {
  const aroundUrl = (seq: number) => `/api/v1/conversations/${CH}/messages?limit=50&around=${seq}`;
  const firstRootUrl = (seq: number) => `/api/v1/conversations/${CH}/messages?limit=1&afterSeq=${seq}`;
  const latestUrl = `/api/v1/conversations/${CH}/messages?limit=50`;
  /** 내가 쓴 최상위 글 seq from..to */
  const mine = (from: number, to: number): Message[] =>
    Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, { bodyMd: `내 글 ${from + i}` }));
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  /** url → 응답. 없는 url 은 500 */
  const serve = (routes: Record<string, unknown>) =>
    fetchMock.mockImplementation(async (input) => {
      const body = routes[String(input)];
      return body === undefined ? new Response("{}", { status: 500 }) : ok(body);
    });
  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    useWireStatus.setState({ status: "connected" });
    useUnread.getState().reset();
  });
  afterEach(() => {
    useWireStatus.setState({ status: "idle" });
    useUnread.getState().reset();
  });

  function setupEntry(t: Timeline, entryReadSeq: number | undefined, { subscribed = true } = {}) {
    const sender = { request: vi.fn(), dispose: vi.fn() };
    const qc = authorsClient();
    if (subscribed) subscribedWith(qc, qk.timeline(CH, CH), t);
    else qc.setQueryData(qk.timeline(CH, CH), t);
    const view = renderWithClient(
      <ReadSenderContext.Provider value={sender}>
        <MessageList channelId={CH} conversationId={CH} entryReadSeq={entryReadSeq} initialRect={RECT} />
      </ReadSenderContext.Provider>,
      qc,
    );
    const scroller = () => view.container.querySelector<HTMLElement>("[data-scroller]") as HTMLElement;
    const scrollTo = async (top: number) => {
      await act(async () => {
        scroller().dispatchEvent(new Event("wheel"));
        scroller().scrollTop = top;
        await new Promise((r) => setTimeout(r, 10));
      });
    };
    const fromEnd = () => scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight;
    return { ...view, qc, sender, scroller, scrollTo, fromEnd };
  }
  const separator = () => screen.queryByRole("separator", { name: "새 메시지" });
  const banner = () => screen.queryByRole("button", { name: /안 읽은 메시지가 더 있어요/ });
  const items = (qc: ReturnType<typeof authorsClient>) =>
    qc.getQueryData<Timeline>(qk.timeline(CH, CH))?.items;

  it("entryReadSeq 뒤 첫 남의 글 앞에 「새 메시지」 구분선이 선다", async () => {
    setupEntry(timelineOf(range(1, 40)), 38);
    await screen.findByText("본문 40");
    const line = await screen.findByRole("separator", { name: "새 메시지" });
    const next = line.closest("[data-index]")?.nextElementSibling;
    expect(next).toHaveTextContent("본문 39");
  });

  it("읽음이 올라가도(applyRead) 구분선은 그 자리에 남는다", async () => {
    useUnread.getState().beginSnapshot();
    useUnread.getState().applySnapshot({
      channels: [{ channelId: CH, lastReadSeq: 38, latestSeq: 40, unread: true, mentions: 0 }],
    });
    setupEntry(timelineOf(range(1, 40)), 38);
    await screen.findByRole("separator", { name: "새 메시지" });
    act(() => useUnread.getState().applyRead({ channelId: CH, lastReadSeq: 40 }, { listed: true }));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(separator()).toBeInTheDocument();
  });

  it("들어간 뒤 내가 쓴 최상위 글 앞에는 구분선이 서지 않는다", async () => {
    const { qc } = setupEntry(timelineOf(range(1, 40)), 40);
    await screen.findByText("본문 40");
    act(() => updateTimeline(qc, CH, CH, (t) => upsert(t, mine(41, 41)[0] as Message)));
    await screen.findByText("내 글 41");
    expect(separator()).toBeNull();
  });

  it("entryReadSeq 가 없으면 구분선도 배너도 없다", async () => {
    setupEntry(timelineOf(range(51, 100), true), undefined);
    await screen.findByText("본문 100");
    expect(separator()).toBeNull();
    expect(banner()).toBeNull();
  });

  it("entryReadSeq + 1 이 불러온 가장 옛 seq 이후이면 배너가 없다(경계)", async () => {
    setupEntry(timelineOf(range(51, 100), true), 50);
    await screen.findByText("본문 51");
    expect(banner()).toBeNull();
  });

  it("불러온 목록이 일부이고 그 맨 앞이 entryReadSeq + 1 보다 뒤면 구분선 없이 배너만 — 둘이 함께 뜨지 않는다", async () => {
    setupEntry(timelineOf(range(51, 100), true), 11);
    await screen.findByText("본문 100");
    expect(banner()).toBeInTheDocument();
    expect(separator()).toBeNull();
  });

  it("구독 전(채널 커서 없음 — 사본에서 복원한 타임라인)에는 배너가 없다 — 구독하면 뜬다", async () => {
    const { qc } = setupEntry(timelineOf(range(51, 100), true), 11, { subscribed: false });
    await screen.findByText("본문 100");
    expect(banner()).toBeNull();
    act(() => setChannelSeq(qc, CH, 100));
    expect(await screen.findByRole("button", { name: /안 읽은 메시지가 더 있어요/ })).toBeInTheDocument();
  });

  it("다시 받는 중(낡은 것으로 둔 세션)에는 배너가 없다 — 받고 나면 뜬다", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response(JSON.stringify({ messages: range(51, 100), hasMore: true }), { status: 200 });
      }),
    );
    const { qc } = setupEntry(timelineOf(range(51, 100), true), 11);
    await screen.findByText("본문 100");
    act(() => void qc.invalidateQueries({ queryKey: qk.timeline(CH, CH) }));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(banner()).toBeNull();
    release();
    expect(await screen.findByRole("button", { name: /안 읽은 메시지가 더 있어요/ })).toBeInTheDocument();
  });

  it("배너를 누르면 entryReadSeq 뒤 첫 루트를 물어 그 seq 를 가운데로 받고(답글 seq 가 아니라), 구분선으로 간다", async () => {
    // 12·13 은 옛 스레드의 답글 — 첫 루트는 14
    serve({
      [firstRootUrl(11)]: { messages: range(14, 14), hasMore: true },
      [aroundUrl(14)]: { messages: range(1, 38), hasMore: false, hasMoreAfter: true },
    });
    const { qc } = setupEntry(timelineOf(range(51, 100), true), 11);
    await screen.findByText("본문 100");
    await userEvent.click(banner() as HTMLElement);
    await waitFor(() => expect(items(qc)?.[0]?.seq).toBe(1));
    expect(urls()).toEqual([firstRootUrl(11), aroundUrl(14)]);
    const line = await screen.findByRole("separator", { name: "새 메시지" });
    expect(line.closest("[data-index]")?.nextElementSibling).toHaveTextContent("본문 12");
    expect(banner()).toBeNull();
  });

  it("배너는 한 번 누르면 사라진다 — 「최신 메시지로」로 돌아와 조건이 다시 참이어도 다시 뜨지 않는다", async () => {
    serve({
      [firstRootUrl(11)]: { messages: range(12, 12), hasMore: true },
      [aroundUrl(12)]: { messages: range(1, 36), hasMore: false, hasMoreAfter: true },
      [latestUrl]: { messages: range(51, 100), hasMore: true },
    });
    const { qc } = setupEntry(timelineOf(range(51, 100), true), 11);
    await screen.findByText("본문 100");
    await userEvent.click(banner() as HTMLElement);
    await waitFor(() => expect(items(qc)?.[0]?.seq).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: /최신 메시지로/ }));
    await waitFor(() => expect(items(qc)?.[0]?.seq).toBe(51));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(banner()).toBeNull();
  });

  it("받은 창에 안 읽은 글이 없으면 이동을 거둔다 — 「최신 메시지로」 뒤에는 끝에 붙고 읽음을 보낸다", async () => {
    // 첫 루트를 가운데 둔 창이 와도 그 안이 다 읽은 글이면(경합 등) 구분선 행이 없다
    serve({
      [firstRootUrl(30)]: { messages: range(31, 31), hasMore: true },
      [aroundUrl(31)]: { messages: range(1, 30), hasMore: false, hasMoreAfter: true },
      [latestUrl]: { messages: range(51, 100), hasMore: true },
    });
    const { qc, sender, fromEnd } = setupEntry(timelineOf(range(51, 100), true), 30);
    await screen.findByText("본문 100");
    await userEvent.click(banner() as HTMLElement);
    await waitFor(() => expect(items(qc)?.[0]?.seq).toBe(1));
    expect(separator()).toBeNull();
    expect(banner()).toBeNull();
    sender.request.mockClear();

    await userEvent.click(screen.getByRole("button", { name: /최신 메시지로/ }));
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
    expect(fromEnd()).toBe(0);
  });

  it("받은 창에 구분선이 없었으면 뒤에 이어 받은 쪽에 구분선이 생겨도 보던 자리를 끌고 가지 않는다", async () => {
    // 첫 루트 뒤가 내 글뿐인 창 — 받은 창의 아래 끝에 머물러 다음 쪽을 이어 받고, 거기서 처음 남의 글(61)이 나온다
    serve({
      [firstRootUrl(30)]: { messages: mine(31, 31), hasMore: true },
      [aroundUrl(31)]: { messages: [...range(6, 30), ...mine(31, 55)], hasMore: true, hasMoreAfter: true },
      [`/api/v1/conversations/${CH}/messages?limit=50&afterSeq=55`]: {
        messages: [...mine(56, 60), ...range(61, 100)],
        hasMore: true,
      },
    });
    const { qc, scroller } = setupEntry(timelineOf(range(61, 100), true), 30);
    await screen.findByText("본문 100");
    await pastVirtualizerReconcile();
    await userEvent.click(banner() as HTMLElement);
    await waitFor(() => expect(items(qc)?.at(-1)?.seq).toBe(100));
    expect(items(qc)?.[0]?.seq).toBe(6);
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(separator()).toBeInTheDocument();
    // 받은 창(메시지 50행)의 아래 끝 그대로 — 끌려가면 61 앞 구분선이 가운데로 온다
    expect(scroller().scrollTop).toBe(50 * ROW - RECT.height);
  });

  it("첫 루트 뒤에 루트가 없으면(안 읽은 것이 답글뿐) 「최신 메시지로」처럼 끝으로 간다", async () => {
    serve({
      [firstRootUrl(11)]: { messages: [], hasMore: false },
      [latestUrl]: { messages: range(51, 100), hasMore: true },
    });
    const { fromEnd, scrollTo } = setupEntry(timelineOf(range(51, 100), true), 11);
    await screen.findByText("본문 100");
    await pastVirtualizerReconcile();
    // 위로 올려 본 채 누른다 — 끝으로 가는 것은 받은 페이지가 아니라 「최신 메시지로」와 같은 이동이다
    await scrollTo(1000);
    expect(fromEnd()).toBeGreaterThan(0);
    await userEvent.click(banner() as HTMLElement);
    await waitFor(() => expect(urls()).toContain(latestUrl));
    await waitFor(() => expect(banner()).toBeNull());
    expect(urls().some((u) => u.includes("around="))).toBe(false);
    await waitFor(() => expect(fromEnd()).toBe(0));
  });

  it("배너로 가기가 실패하면 기존 페이지 오류 보고(토스트)로 가고 배너는 남는다(다시 누를 수 있다)", async () => {
    const error = vi.spyOn(toast, "error");
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ code: "INTERNAL", message: "터졌다" }), { status: 500 }),
    );
    setupEntry(timelineOf(range(51, 100), true), 11);
    await screen.findByText("본문 100");
    await userEvent.click(banner() as HTMLElement);
    await waitFor(() => expect(error).toHaveBeenCalledWith("터졌다"));
    expect(banner()).toBeInTheDocument();
  });

  it.each([
    // 과거 페이지가 읽음 위치까지 닿았다 — 날짜 구분선 1 + 메시지 50 + 「새 메시지」 1 이 위에 붙는다
    { entryReadSeq: 11, hasMore: false, added: 52 },
    // 더 옛 것이 남은 채 맨 앞(1)이 읽음 위치 + 1 — 맨 위 날짜 구분선 없이 「새 메시지」 1 + 메시지 50
    { entryReadSeq: 0, hasMore: true, added: 51 },
  ])(
    "entryReadSeq $entryReadSeq: 맨 위 근처에서 과거 페이지를 붙여도 보던 행의 자리를 지킨다(맨 위 구분선이 기준 행이 되지 않는다)",
    async ({ entryReadSeq, hasMore, added }) => {
      serve({
        [`/api/v1/conversations/${CH}/messages?limit=50&beforeSeq=51`]: { messages: range(1, 50), hasMore },
      });
      const { qc, scroller, scrollTo } = setupEntry(timelineOf(range(51, 100), true), entryReadSeq);
      await waitFor(() => expect(scroller().scrollTop).toBeGreaterThan(0));
      await scrollTo(30);
      await waitFor(() => expect(items(qc)).toHaveLength(100));
      await waitFor(() => expect(scroller().scrollTop).toBe(30 + added * ROW));
      expect(screen.getByText("본문 51")).toBeInTheDocument();
    },
  );
});

/** 안 읽은 채널은 첫 안 읽은 곳(「새 메시지」 구분선)이 화면 위쪽에 오게 열린다 */
describe("MessageList 첫 안 읽은 곳에서 열기", () => {
  /** 구분선이 뷰포트 위에서 이만큼 아래에 선다(앞 메시지 두 줄쯤) — MessageList 의 UNREAD_CONTEXT_PX */
  const CONTEXT = 128;
  const MAX_TOP = (rows: number) => rows * ROW - RECT.height;

  beforeEach(() => {
    useWireStatus.setState({ status: "connected" });
    useUnread.getState().reset();
  });
  afterEach(() => {
    useWireStatus.setState({ status: "idle" });
    useUnread.getState().reset();
  });

  /** `t` 가 없으면 캐시 없이 연다(구독 응답은 테스트가 나중에 넣는다) */
  function open(
    t: Timeline | undefined,
    entryReadSeq: number | undefined,
    over: { threadRootId?: string } = {},
  ) {
    const sender = { request: vi.fn(), dispose: vi.fn() };
    const qc = authorsClient();
    if (t)
      subscribedWith(qc, over.threadRootId ? qk.thread(CH, CH, over.threadRootId) : qk.timeline(CH, CH), t);
    const view = renderWithClient(
      <ReadSenderContext.Provider value={sender}>
        <MessageList
          channelId={CH}
          conversationId={CH}
          entryReadSeq={entryReadSeq}
          initialRect={RECT}
          {...over}
        />
      </ReadSenderContext.Provider>,
      qc,
    );
    const scroller = () => view.container.querySelector<HTMLElement>("[data-scroller]") as HTMLElement;
    const scrollTo = async (top: number) => {
      await act(async () => {
        scroller().dispatchEvent(new Event("wheel"));
        scroller().scrollTop = top;
        await new Promise((r) => setTimeout(r, 10));
      });
    };
    const fromEnd = () => scroller().scrollHeight - scroller().scrollTop - scroller().clientHeight;
    return { ...view, qc, sender, scroller, scrollTo, fromEnd };
  }
  const separator = () => screen.queryByRole("separator", { name: "새 메시지" });
  const settle = () => act(() => new Promise((r) => setTimeout(r, 120)));
  /** 스냅숏 — 서버가 아는 이 채널의 읽음 위치와 최신 seq */
  const known = (lastReadSeq: number, latestSeq: number) => {
    useUnread.getState().beginSnapshot();
    useUnread.getState().applySnapshot({
      channels: [{ channelId: CH, lastReadSeq, latestSeq, unread: true, mentions: 0 }],
    });
  };
  /** 이어 받기 — 가진 목록 뒤에 from..to 를 붙이고 lastSeq 를 to 로 */
  const catchUp = (qc: ReturnType<typeof authorsClient>, from: number, to: number) =>
    act(() =>
      updateTimeline(qc, CH, CH, (t) => ({ ...t, items: [...t.items, ...range(from, to)], lastSeq: to })),
    );

  it("1. 구분선이 받은 행 안이면 끝이 아니라 구분선이 위쪽에 오게 열고, 읽음을 보내지 않는다", async () => {
    // 날짜 구분선 1 + 메시지 80 개가 위에 있고 「새 메시지」 행은 81번째(0 부터) 자리
    const { scroller, sender, fromEnd } = open(timelineOf(range(1, 100)), 80);
    await screen.findByRole("separator", { name: "새 메시지" });
    await waitFor(() => expect(scroller().scrollTop).toBe(81 * ROW - CONTEXT));
    await settle();
    expect(scroller().scrollTop).toBe(81 * ROW - CONTEXT);
    expect(fromEnd()).toBeGreaterThan(0);
    expect(screen.getByText("본문 80")).toBeInTheDocument();
    expect(sender.request).not.toHaveBeenCalled();
    expect(isViewingAtEnd(CH)).toBe(false);
    // 끝으로 가는 길 — 안 읽은 20개를 센 칩
    expect(screen.getByRole("button", { name: /새 메시지 20개/ })).toBeInTheDocument();
  });

  it("1. 끝까지 내리면 그때 읽음이 간다", async () => {
    const { scroller, scrollTo, sender } = open(timelineOf(range(1, 100)), 80);
    await waitFor(() => expect(scroller().scrollTop).toBe(81 * ROW - CONTEXT));
    await scrollTo(MAX_TOP(102));
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
    expect(isViewingAtEnd(CH)).toBe(true);
  });

  it("1. 칩을 누르면 끝으로 가고 읽음이 간다", async () => {
    const { scroller, sender, fromEnd } = open(timelineOf(range(1, 100)), 80);
    await waitFor(() => expect(scroller().scrollTop).toBe(81 * ROW - CONTEXT));
    await userEvent.click(screen.getByRole("button", { name: /새 메시지 20개/ }));
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
    expect(fromEnd()).toBe(0);
  });

  it("2. 구분선이 받은 행 밖이면(배너) 끝에서 열고 읽음이 간다", async () => {
    const { atEnd } = (() => {
      const o = open(timelineOf(range(51, 100), true), 11);
      return { ...o, atEnd: () => o.fromEnd() === 0 };
    })();
    await screen.findByRole("button", { name: /안 읽은 메시지가 더 있어요/ });
    await waitFor(() => expect(atEnd()).toBe(true));
  });

  it("2. 배너를 누른 뒤의 구분선 이동은 그대로다(처음 위치 규칙이 끼어들지 않는다)", async () => {
    // 위 「배너를 누르면…」 사례와 같은 경로 — 받은 창에서 구분선으로 한 번 간다
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      const body =
        url === `/api/v1/conversations/${CH}/messages?limit=1&afterSeq=11`
          ? { messages: range(14, 14), hasMore: true }
          : url === `/api/v1/conversations/${CH}/messages?limit=50&around=14`
            ? { messages: range(1, 38), hasMore: false, hasMoreAfter: true }
            : undefined;
      return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("{}", { status: 500 });
    });
    const { sender } = open(timelineOf(range(51, 100), true), 11);
    const button = await screen.findByRole("button", { name: /안 읽은 메시지가 더 있어요/ });
    sender.request.mockClear();
    await userEvent.click(button);
    await screen.findByRole("separator", { name: "새 메시지" });
    await settle();
    expect(sender.request).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /최신 메시지로/ })).toBeInTheDocument();
  });

  it("3. 안 읽은 것이 한 화면에 다 들어가 구분선과 끝이 함께 보이면 끝 보임이다 — 읽음이 간다", async () => {
    const { sender, scroller } = open(timelineOf(range(1, 6)), 3);
    await screen.findByRole("separator", { name: "새 메시지" });
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 6));
    expect(scroller().scrollTop).toBe(0);
    expect(isViewingAtEnd(CH)).toBe(true);
  });

  it("3′. 구분선을 위쪽에 두면 끝도 보이는 경우(구분선 뒤가 한 화면 안쪽)는 끝에 붙는다 — 읽음이 간다", async () => {
    // 위 81 행 + 구분선, 뒤 안 읽은 4개: 구분선을 CONTEXT 에 두면 아래가 남지만 맨 끝이 STICK_PX 안이라 끝 보임
    const { sender, fromEnd } = open(timelineOf(range(1, 100)), 96);
    await screen.findByRole("separator", { name: "새 메시지" });
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
    expect(fromEnd()).toBeLessThanOrEqual(80);
  });

  it("4. 구분선이 없으면(entryReadSeq 가 없음) 끝에서 열고 읽음이 간다", async () => {
    const { sender, fromEnd } = open(timelineOf(range(1, 100)), undefined);
    await screen.findByText("본문 100");
    await waitFor(() => expect(fromEnd()).toBe(0));
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
    expect(separator()).toBeNull();
  });

  it("4. 안 읽음이 없으면(entryReadSeq 가 끝) 구분선 없이 끝에서 열고 읽음이 간다", async () => {
    const { sender, fromEnd } = open(timelineOf(range(1, 100)), 100);
    await screen.findByText("본문 100");
    await waitFor(() => expect(fromEnd()).toBe(0));
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
    expect(separator()).toBeNull();
  });

  it("5. 처음 한 번만 — 머무는 동안 새 글이 와도 구분선으로 다시 끌고 가지 않는다", async () => {
    const { qc, scroller, scrollTo, sender } = open(timelineOf(range(1, 100)), 80);
    await waitFor(() => expect(scroller().scrollTop).toBe(81 * ROW - CONTEXT));
    await scrollTo(1000);
    act(() => updateTimeline(qc, CH, CH, (t) => upsert(t, range(101, 101)[0] as Message)));
    await screen.findByText("본문 101", undefined, { timeout: 1000 }).catch(() => undefined);
    await settle();
    expect(scroller().scrollTop).toBe(1000);
    expect(sender.request).not.toHaveBeenCalled();
  });

  it("5. 손을 대지 않아도 — 위치를 잡은 뒤 새 글이 와서 행 수가 바뀌어도 다시 겨누지 않는다", async () => {
    const { qc, scroller } = open(timelineOf(range(1, 100)), 80);
    await waitFor(() => expect(scroller().scrollTop).toBe(81 * ROW - CONTEXT));
    await settle();
    await pastVirtualizerReconcile();
    const before = scroller().scrollTop;
    act(() => updateTimeline(qc, CH, CH, (t) => upsert(t, range(101, 101)[0] as Message)));
    await settle();
    expect(scroller().scrollTop).toBe(before);
  });

  it("5. 사용자가 스크롤을 잡으면(휠) 위치 잡기가 그 자리에서 멈춘다", async () => {
    const { scroller } = open(timelineOf(range(1, 100)), 80);
    await act(async () => {
      scroller().dispatchEvent(new Event("wheel"));
      scroller().scrollTop = 500;
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(scroller().scrollTop).toBe(500);
  });

  it("5. 구독 응답 전에 캐시가 낡았으면(들어갈 때 읽음 위치 뒤가 아직 안 옴) 응답으로 구분선이 생길 때 한 번 내려앉는다 — 그동안 읽음은 가지 않는다", async () => {
    // 캐시는 40 까지, 서버가 아는 최신은 100(스냅숏 seenSeq) — 이어 받기가 41..100 을 채운다
    useUnread.getState().beginSnapshot();
    useUnread.getState().applySnapshot({
      channels: [{ channelId: CH, lastReadSeq: 40, latestSeq: 100, unread: true, mentions: 0 }],
    });
    const { qc, scroller, sender } = open(timelineOf(range(1, 40)), 40);
    await screen.findByText("본문 40");
    await settle();
    expect(sender.request).not.toHaveBeenCalled();
    act(() =>
      updateTimeline(qc, CH, CH, (t) => ({ ...t, items: [...t.items, ...range(41, 100)], lastSeq: 100 })),
    );
    await screen.findByRole("separator", { name: "새 메시지" });
    await waitFor(() => expect(scroller().scrollTop).toBe(41 * ROW - CONTEXT));
    await settle();
    expect(sender.request).not.toHaveBeenCalled();
  });

  it("5. 이어 받은 것에 안 읽은 최상위 글이 없으면(구분선이 안 생김) 붙잡아 둔 읽음을 푼다", async () => {
    useUnread.getState().beginSnapshot();
    useUnread.getState().applySnapshot({
      channels: [{ channelId: CH, lastReadSeq: 40, latestSeq: 50, unread: false, mentions: 0 }],
    });
    const { qc, sender } = open(timelineOf(range(1, 40)), 40);
    await screen.findByText("본문 40");
    // 41..50 은 내 글이라 구분선이 서지 않는다
    act(() =>
      updateTimeline(qc, CH, CH, (t) => ({
        ...t,
        items: [
          ...t.items,
          ...Array.from({ length: 10 }, (_, i) => msg(41 + i, { bodyMd: `내 글 ${41 + i}` })),
        ],
        lastSeq: 50,
      })),
    );
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 50));
    expect(separator()).toBeNull();
  });

  it("5. 첫 붙임이 끝난 뒤에 온 이어 받기에 구분선이 없어도 — 따라가지 않던 끝으로 돌아가 읽음이 간다", async () => {
    known(40, 50);
    const { qc, sender, fromEnd } = open(timelineOf(range(1, 40)), 40);
    await screen.findByText("본문 40");
    await settle();
    act(() =>
      updateTimeline(qc, CH, CH, (t) => ({
        ...t,
        items: [
          ...t.items,
          ...Array.from({ length: 10 }, (_, i) => msg(41 + i, { bodyMd: `내 글 ${41 + i}` })),
        ],
        lastSeq: 50,
      })),
    );
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 50));
    expect(fromEnd()).toBe(0);
  });

  it("5. 낡은 캐시의 읽음 위치 뒤가 구분선을 세우지 않는 글(시스템 카드)뿐이어도, 내려앉은 뒤의 칩은 읽음 위치부터 센다", async () => {
    known(40, 100);
    const card = msg(41, {
      kind: "system",
      authorType: "system",
      authorId: undefined,
      bodyMd: "릴레이 한도에 닿았습니다",
      systemMeta: { kind: "relay_limit" },
    });
    const { qc, scroller } = open(timelineOf([...range(1, 40), card]), 40);
    await screen.findByRole("note");
    expect(separator()).toBeNull();
    await settle();
    await catchUp(qc, 42, 100);
    // 날짜 구분선 1 + 메시지 40 + 시스템 카드 1 뒤가 「새 메시지」 행
    await waitFor(() => expect(scroller().scrollTop).toBe(42 * ROW - CONTEXT));
    expect(screen.getByRole("button", { name: /새 메시지 60개/ })).toBeInTheDocument();
  });

  describe("낡은 캐시 이어 받기를 기다리는 동안 끝으로 가면 다 받은 뒤 끝으로 간다", () => {
    const send = (qc: ReturnType<typeof authorsClient>) =>
      act(() =>
        updateTimeline(qc, CH, CH, (t) =>
          addPending(t, {
            clientMsgId: "c-1",
            channelId: CH,
            bodyMd: "내 말",
            createdAt: new Date().toISOString(),
            state: "sending",
          }),
        ),
      );

    it("칩을 누르면 — 다 받기 전엔 읽음이 없고, 다 받은 뒤 끝에서 읽음이 간다", async () => {
      known(40, 100);
      const { qc, scroller, sender, fromEnd } = open(timelineOf(range(1, 60)), 40);
      const chip = await screen.findByRole("button", { name: /새 메시지 \d+개/ });
      await settle();
      expect(scroller().scrollTop).toBe(41 * ROW - CONTEXT);
      await userEvent.click(chip);
      await settle();
      expect(sender.request).not.toHaveBeenCalled();
      await catchUp(qc, 61, 100);
      await waitFor(() => expect(fromEnd()).toBe(0));
      await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
    });

    it("보내면 — 다 받은 뒤 끝에서 내 글이 보이고 읽음은 그때 간다", async () => {
      known(40, 100);
      const { qc, sender, fromEnd } = open(timelineOf(range(1, 42)), 40);
      await screen.findByRole("separator", { name: "새 메시지" });
      await settle();
      await send(qc);
      await settle();
      expect(sender.request).not.toHaveBeenCalled();
      await catchUp(qc, 43, 100);
      await waitFor(() => expect(fromEnd()).toBe(0));
      await screen.findByText("내 말");
      await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
    });

    it("구분선이 아직 없을 때(끝에서 열림) 보내도 다 받은 뒤 끝에서 내 글이 보인다", async () => {
      known(40, 100);
      const { qc, sender, fromEnd } = open(timelineOf(range(1, 40)), 40);
      await screen.findByText("본문 40");
      await settle();
      await send(qc);
      await settle();
      await catchUp(qc, 41, 100);
      await waitFor(() => expect(fromEnd()).toBe(0));
      await screen.findByText("내 말");
      await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
    });
  });

  it("6. 결과로 가기 목표를 안고 열리면 구분선이 아니라 그 메시지로 간다", async () => {
    const target = range(10, 10)[0] as Message;
    act(() => requestJump({ conversationId: CH, messageId: target.id, seq: 10 }));
    const { sender } = open(timelineOf(range(1, 100)), 80);
    await waitFor(() =>
      expect(screen.getByText("본문 10").closest("[data-index]")).toHaveAttribute("data-highlighted", "true"),
    );
    await settle();
    expect(screen.getByText("본문 10")).toBeInTheDocument();
    expect(sender.request).not.toHaveBeenCalled();
  });

  it("6. 결과로 간 뒤 끝까지 내리면 읽음이 간다 — 목표를 안고 열린 목록은 읽음을 붙잡아 두지 않는다", async () => {
    const target = range(10, 10)[0] as Message;
    act(() => requestJump({ conversationId: CH, messageId: target.id, seq: 10 }));
    const { sender, scrollTo } = open(timelineOf(range(1, 100)), 80);
    await waitFor(() =>
      expect(screen.getByText("본문 10").closest("[data-index]")).toHaveAttribute("data-highlighted", "true"),
    );
    await settle();
    await pastVirtualizerReconcile();
    await scrollTo(MAX_TOP(102));
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
  });

  it("스레드 패널은 이 규칙을 타지 않는다 — entryReadSeq 를 받아도 끝에서 열고 채널 읽음을 보내지 않는다", async () => {
    const { fromEnd, sender } = open(timelineOf(range(1, 100)), 80, { threadRootId: "root-1" });
    await screen.findByText("본문 100");
    await waitFor(() => expect(fromEnd()).toBe(0));
    await settle();
    expect(fromEnd()).toBe(0);
    expect(sender.request).not.toHaveBeenCalled();
  });

  it("캐시 없이 들어가 구독 응답이 나중에 오면 그때 구분선이 위쪽에 오게 열고, 읽음을 보내지 않는다", async () => {
    const { qc, scroller, sender } = open(undefined, 80);
    expect(screen.getByRole("status", { name: "메시지를 불러오는 중" })).toBeInTheDocument();
    act(() => qc.setQueryData(qk.timeline(CH, CH), timelineOf(range(1, 100))));
    await waitFor(() => expect(scroller().scrollTop).toBe(81 * ROW - CONTEXT));
    // 읽음 전송기는 취소가 없다 — 한 번이라도 끝 보임으로 잡히면 그대로 나간다
    await act(() => new Promise((r) => setTimeout(r, 1_100)));
    expect(scroller().scrollTop).toBe(81 * ROW - CONTEXT);
    expect(sender.request).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /새 메시지 20개/ })).toBeInTheDocument();
  });

  it("캐시 없이 들어가면 이어 받기를 기다리지 않는다 — 채널의 끝이 답글이라 첫 응답의 lastSeq 가 최신에 못 미쳐도 곧 읽음이 간다", async () => {
    // 스냅숏의 최신은 105(답글) — 첫 구독은 루트만 싣는다(lastSeq 100)
    known(100, 105);
    const { qc, sender, fromEnd } = open(undefined, 100);
    act(() => qc.setQueryData(qk.timeline(CH, CH), timelineOf(range(1, 100))));
    await waitFor(() => expect(fromEnd()).toBe(0));
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
  });

  it("읽은 자리가 0 이면(새 멤버가 처음 여는 채널) 구분선이 아니라 끝에서 열고 읽음이 간다", async () => {
    const { sender, fromEnd } = open(timelineOf(range(1, 100)), 0);
    await screen.findByText("본문 100");
    await waitFor(() => expect(fromEnd()).toBe(0));
    await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 100));
    expect(screen.queryByRole("button", { name: /새 메시지 \d+개/ })).toBeNull();
  });

  describe("낡은 캐시에 이미 구분선이 있을 때", () => {
    // 캐시는 42 까지(41·42 는 안 읽음), 서버가 아는 최신은 100. 구분선 뒤가 두 줄이라 구분선을 위에 두면 끝도 보인다
    it("이어 받기 전에는 끝이 보여도 읽음을 보내지 않고, 이어 받은 뒤에는 끝으로 끌려가지 않고 구분선에 선다", async () => {
      known(40, 100);
      const { qc, scroller, sender, fromEnd } = open(timelineOf(range(1, 42)), 40);
      await screen.findByRole("separator", { name: "새 메시지" });
      await settle();
      expect(sender.request).not.toHaveBeenCalled();

      await catchUp(qc, 43, 100);
      await waitFor(() => expect(scroller().scrollTop).toBe(41 * ROW - CONTEXT));
      await settle();
      expect(scroller().scrollTop).toBe(41 * ROW - CONTEXT);
      expect(fromEnd()).toBeGreaterThan(0);
      expect(sender.request).not.toHaveBeenCalled();
      expect(isViewingAtEnd(CH)).toBe(false);
      // 끝으로 가는 길 — 이어 받은 것까지 안 읽은 60개
      expect(screen.getByRole("button", { name: /새 메시지 60개/ })).toBeInTheDocument();
    });

    it("이어 받은 뒤에도 구분선과 끝이 한 화면이면 그때 끝 보임이다 — 다 받은 끝까지 읽음이 간다", async () => {
      known(40, 45);
      const { qc, sender } = open(timelineOf(range(1, 42)), 40);
      await screen.findByRole("separator", { name: "새 메시지" });
      await settle();
      expect(sender.request).not.toHaveBeenCalled();

      await catchUp(qc, 43, 45);
      await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 45));
      expect(sender.request).not.toHaveBeenCalledWith(CH, 42);
    });

    it("기다리는 동안 손을 대 옮긴 자리는 다 받은 뒤에도 그대로다 — 구분선으로 다시 끌고 가지 않고, 끝이 아니면 읽음이 가지 않는다", async () => {
      known(40, 100);
      const { qc, scroller, scrollTo, sender } = open(timelineOf(range(1, 42)), 40);
      await screen.findByRole("separator", { name: "새 메시지" });
      await settle();
      await scrollTo(1000);
      await catchUp(qc, 43, 100);
      await settle();
      expect(scroller().scrollTop).toBe(1000);
      expect(sender.request).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: /새 메시지 60개/ })).toBeInTheDocument();
    });

    it("기다리는 동안 손만 대고 끝에 남아 있어도 받는 글을 따라 내려가지 않는다 — 다 받은 뒤 그 자리는 끝이 아니라 읽음이 가지 않는다", async () => {
      // 캐시에 구분선이 아직 없는 쪽(끝에서 연다) — 손을 댔으므로 이어 받기가 구분선을 만들어도 내려앉지 않는다
      known(40, 100);
      const { qc, scroller, sender } = open(timelineOf(range(1, 40)), 40);
      await screen.findByText("본문 40");
      await settle();
      const oldEnd = MAX_TOP(41);
      expect(scroller().scrollTop).toBe(oldEnd);
      await act(async () => {
        scroller().dispatchEvent(new Event("pointerdown"));
        await new Promise((r) => setTimeout(r, 20));
      });
      await catchUp(qc, 41, 100);
      await settle();
      expect(scroller().scrollTop).toBe(oldEnd);
      expect(sender.request).not.toHaveBeenCalled();
    });

    it("기다리는 동안 손만 댄 자리가 다 받은 뒤에도 끝이 보이면 그 자리에서 끝 보임이다 — 읽음이 간다", async () => {
      // 이어 받은 것이 한 줄뿐이라 따라 내려가지 않아도 끝이 STICK_PX 안에 남는다
      known(40, 43);
      const { qc, scroller, sender } = open(timelineOf(range(1, 42)), 40);
      await screen.findByRole("separator", { name: "새 메시지" });
      await settle();
      await act(async () => {
        scroller().dispatchEvent(new Event("pointerdown"));
        await new Promise((r) => setTimeout(r, 20));
      });
      await catchUp(qc, 43, 43);
      await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 43));
    });

    it("이어 받기가 끝내 안 오면 5초 뒤 가진 것으로 판정한다 — 그때 구분선과 끝이 한 화면이면 읽음이 간다", async () => {
      known(40, 100);
      const { sender } = open(timelineOf(range(1, 42)), 40);
      await screen.findByRole("separator", { name: "새 메시지" });
      await act(() => new Promise((r) => setTimeout(r, 4_500)));
      expect(sender.request).not.toHaveBeenCalled();
      await waitFor(() => expect(sender.request).toHaveBeenCalledWith(CH, 42), { timeout: 2_000 });
    }, 10_000);
  });
});
