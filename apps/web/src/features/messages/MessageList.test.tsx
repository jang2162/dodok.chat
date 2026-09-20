import type { Message } from "@dodok/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { registerUnauthorized } from "@/app/session";
import { updateTimeline } from "@/realtime/timelineCache";
import { AGENT, CH, CH2, msg, RUN } from "../../../test/fixtures";
import { authorsClient, renderWithClient } from "../../../test/messages";
import { remeasureRows, setViewportHeight, stubScrollLayout } from "../../../test/scrollLayout";
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

function setup(t: Timeline | undefined, channelId = CH) {
  const qc = authorsClient();
  if (t) qc.setQueryData(qk.timeline(channelId), t);
  const view = renderWithClient(<MessageList channelId={channelId} initialRect={RECT} />, qc);
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
    act(() => qc.setQueryData(qk.timeline(CH), emptyTimeline()));
    expect(await screen.findByText(/아직 메시지가 없습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "메시지를 불러오는 중" })).toBeNull();
  });

  it("타임라인이 나중에 오면(구독 응답) 그때 맨 아래로 간다", async () => {
    const { qc, atEnd } = setup(undefined);
    act(() => qc.setQueryData(qk.timeline(CH), timelineOf(range(1, 40))));
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
    act(() => updateTimeline(qc, CH, (t) => upsert(t, range(41, 41)[0] as Message)));
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
    act(() => updateTimeline(qc, CH, (t) => range(41, 42).reduce(upsert, t)));
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

  it("스크롤해서 맨 아래로 돌아오면 칩이 사라진다", async () => {
    const { qc, scrollTo, scroller } = setup(timelineOf(range(1, 40)));
    await scrollTo(300);
    act(() => updateTimeline(qc, CH, (t) => upsert(t, range(41, 41)[0] as Message)));
    await screen.findByRole("button", { name: "새 메시지 1개" });
    await scrollTo(scroller().scrollHeight);
    await waitFor(() => expect(screen.queryByRole("button", { name: /새 메시지/ })).toBeNull());
  });

  it("내가 보낸 항목(보내는 중)이 붙으면 위에 있어도 끝으로 간다", async () => {
    const { qc, scrollTo, atEnd } = setup(timelineOf(range(1, 40)));
    await scrollTo(300);
    act(() =>
      updateTimeline(qc, CH, (t) =>
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
    await waitFor(() => expect(qc.getQueryData<Timeline>(qk.timeline(CH))?.items).toHaveLength(80));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `/api/v1/channels/${CH}/messages?limit=50&beforeSeq=51`,
    );
    expect(qc.getQueryData<Timeline>(qk.timeline(CH))?.hasOlder).toBe(false);
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
      qk.timeline(CH),
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
      const t = useTimeline(CH);
      const answered = t?.items.some((m) => m.runId === RUN) ?? false;
      const ids = useMemo(() => (answered ? [] : [RUN]), [answered]);
      return (
        <MessageList
          channelId={CH}
          initialRect={RECT}
          bubbleRunIds={ids}
          bubbles={(runId) => <div data-testid="bubble">버블 {runId}</div>}
        />
      );
    }
    const qc = authorsClient();
    qc.setQueryData(qk.timeline(CH), timelineOf(range(1, 40)));
    const { container } = renderWithClient(<Harness />, qc);
    const scroller = container.querySelector("[data-scroller]") as HTMLElement;
    const gap = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    // 앞선 스크롤이 멎은 뒤에 바꾼다 — virtual-core 는 스크롤 직후(150ms)에는 새 행을 재지 않고, 앞선 끝 맞추기가
    // 아직 돌고 있으면 어긋남을 대신 메워 결함이 가려진다(실물에서는 답이 오기 한참 전에 멎어 있다)
    const settle = () => act(() => new Promise((r) => setTimeout(r, 300)));

    await screen.findByTestId("bubble");
    await waitFor(() => expect(gap()).toBe(0));

    await settle();
    act(() => updateTimeline(qc, CH, (t) => upsert(t, range(41, 41, { runId: RUN })[0] as Message)));
    await waitFor(() => expect(screen.queryByTestId("bubble")).toBeNull());
    expect(screen.getByText("본문 41")).toBeInTheDocument();
    // 교체 뒤 끝에 그대로 — 고치기 전에는 9px 이 남는다(부하에서 늦어도 거짓 실패가 나지 않게 waitFor)
    await waitFor(() => expect(gap()).toBe(0));

    // 보내는 중 항목이 확정되는 교체도 같은 경로
    const clientMsgId = "c-last";
    act(() =>
      updateTimeline(qc, CH, (t) =>
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
    act(() => updateTimeline(qc, CH, (t) => upsert(t, msg(42, { clientMsgId, bodyMd: "내 말" }))));
    await waitFor(() => expect(screen.queryByRole("status", { name: "보내는 중" })).toBeNull());
    // 이 경로는 jsdom 에서 고치기 전에도 0 이다 — 회귀 방지용(실물 확인은 태스크 13)
    await waitFor(() => expect(gap()).toBe(0));
  });

  it("채널을 옮기면 칩·스크롤 상태를 새로 시작한다", async () => {
    const qc = authorsClient();
    qc.setQueryData(qk.timeline(CH), timelineOf(range(1, 40)));
    qc.setQueryData(qk.timeline(CH2), timelineOf(range(1, 40, { channelId: CH2 })));
    const view = renderWithClient(<MessageList channelId={CH} initialRect={RECT} />, qc);
    const scroller = () => view.container.querySelector<HTMLElement>("[data-scroller]") as HTMLElement;
    // 휠 = 사용자가 스크롤을 잡았다는 신호 — 이것 없이 scrollTop 만 옮기면 첫 붙임(settle)이 아직 살아 있을 때
    // 다음 프레임에 끝으로 되돌려 칩이 뜨지 않는다(부하에서 20회 중 1회). 이 파일의 다른 scroll 과 같은 방식
    await act(async () => {
      scroller().dispatchEvent(new Event("wheel"));
      scroller().scrollTop = 300;
      await new Promise((r) => setTimeout(r, 10));
    });
    act(() => updateTimeline(qc, CH, (t) => upsert(t, range(41, 41)[0] as Message)));
    await screen.findByRole("button", { name: "새 메시지 1개" });

    view.rerender(<MessageList channelId={CH2} initialRect={RECT} />);
    expect(screen.queryByRole("button", { name: /새 메시지/ })).toBeNull();
    await waitFor(() => expect(scroller().scrollTop).toBe(scroller().scrollHeight - scroller().clientHeight));
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
