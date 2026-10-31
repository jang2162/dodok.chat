import type { Message } from "@dodok/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { getTimeline, setChannelSeq } from "@/realtime/timelineCache";
import { AGENT, CH, msg } from "../../../test/fixtures";
import { authorsClient, renderWithClient } from "../../../test/messages";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { json } from "../../../test/shellApi";
import { HIGHLIGHT_MS, requestJump, useJumpStore } from "./jumpTarget";
import { MessageList } from "./MessageList";
import { addPending, emptyTimeline, type Timeline, upsert } from "./timeline";

const RECT = { width: 800, height: 600 };
const range = (from: number, to: number): Message[] =>
  Array.from({ length: to - from + 1 }, (_, i) =>
    msg(from + i, { authorType: "agent", authorId: AGENT, bodyMd: `본문 ${from + i}` }),
  );
const timelineOf = (items: Message[], over: Partial<Timeline> = {}): Timeline => ({
  ...emptyTimeline(),
  items,
  hasOlder: true,
  lastSeq: items.at(-1)?.seq ?? 0,
  ...over,
});
const url = (q: string) => `/api/v1/conversations/${CH}/messages?${q}`;

let restore: () => void;
let routes: Map<string, () => Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
beforeEach(() => {
  restore = stubScrollLayout(RECT);
  routes = new Map();
  fetchMock = vi.fn<typeof globalThis.fetch>(
    async (input) => routes.get(String(input))?.() ?? json(404, { code: "NOT_FOUND", message: "없음" }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useJumpStore.setState({ targets: {} });
});

/** 세션 타임라인을 채우고 그 채널을 구독한 것으로(채널 커서) — `subscribed: false` 면 구독 전(사본에서 복원한 목록) */
function setup(t: Timeline, { subscribed = true } = {}) {
  const qc = authorsClient();
  qc.setQueryData(qk.timeline(CH, CH), t);
  if (subscribed) setChannelSeq(qc, CH, t.lastSeq);
  const view = renderWithClient(<MessageList channelId={CH} conversationId={CH} initialRect={RECT} />, qc);
  const row = (text: string) => screen.getByText(text).closest<HTMLElement>("[data-index]");
  return { ...view, qc, row };
}
const fetched = () => fetchMock.mock.calls.map((c) => String(c[0]));
const jumpTo = (seq: number) => act(() => requestJump({ conversationId: CH, messageId: msg(seq).id, seq }));

describe("결과로 가기 — 채널 목록", () => {
  it("가진 메시지면 받지 않고 그 행으로 스크롤해 강조한다 — 강조는 2초 뒤 풀린다", async () => {
    const { row } = setup(timelineOf(range(1, 100)));
    // 처음은 끝에 붙는다 — 10번 행은 그려지지 않는다
    await waitFor(() => expect(screen.queryByText("본문 10")).toBeNull());
    jumpTo(10);
    await waitFor(() => expect(row("본문 10")).toHaveAttribute("data-highlighted", "true"));
    expect(fetched().filter((u) => u.includes("/messages"))).toEqual([]);
    expect(HIGHLIGHT_MS).toBe(2_000);
    await waitFor(() => expect(row("본문 10")).not.toHaveAttribute("data-highlighted"), {
      timeout: HIGHLIGHT_MS + 1_000,
    });
  });

  it("초점을 바라는 목표(검색에서 골랐다)면 도착한 행이 초점을 받는다 — 강조가 풀려도 그대로", async () => {
    const { row } = setup(timelineOf(range(1, 100)));
    await waitFor(() => expect(screen.queryByText("본문 10")).toBeNull());
    act(() => requestJump({ conversationId: CH, messageId: msg(10).id, seq: 10 }, { focus: true }));
    await waitFor(() => expect(row("본문 10")).toHaveFocus());
    expect(row("본문 10")).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(row("본문 10")).not.toHaveAttribute("data-highlighted"), {
      timeout: HIGHLIGHT_MS + 1_000,
    });
    expect(row("본문 10")).toHaveFocus();
  });

  it("초점을 바라지 않는 목표는 초점을 옮기지 않는다", async () => {
    const { row } = setup(timelineOf(range(1, 100)));
    await waitFor(() => expect(screen.queryByText("본문 10")).toBeNull());
    jumpTo(10);
    await waitFor(() => expect(row("본문 10")).toHaveAttribute("data-highlighted", "true"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(row("본문 10")).not.toHaveFocus();
    expect(row("본문 10")).not.toHaveAttribute("tabindex");
  });

  it("가지지 않은 메시지도 around 로 받은 뒤 도착하면 초점을 받는다", async () => {
    routes.set(url("limit=50&around=10"), () =>
      json(200, { messages: range(1, 20), hasMore: false, hasMoreAfter: true }),
    );
    const { row } = setup(timelineOf(range(60, 100)));
    act(() => requestJump({ conversationId: CH, messageId: msg(10).id, seq: 10 }, { focus: true }));
    await waitFor(() => expect(row("본문 10")).toHaveFocus());
  });

  it("강조는 색만 바꾸고 움직임은 prefers-reduced-motion 이면 끈다", async () => {
    const { row } = setup(timelineOf(range(1, 30)));
    jumpTo(5);
    await waitFor(() => expect(row("본문 5")).toHaveAttribute("data-highlighted", "true"));
    expect(row("본문 5")).toHaveClass("motion-reduce:transition-none");
  });

  it("가지지 않은 메시지면 around 페이지로 갈아 끼우고 강조 — 더 새것이 있으면 「최신 메시지로」", async () => {
    routes.set(url("limit=50&around=10"), () =>
      json(200, { messages: range(1, 20), hasMore: false, hasMoreAfter: true }),
    );
    const { qc, row } = setup(timelineOf(range(60, 100)));
    jumpTo(10);
    await waitFor(() => expect(row("본문 10")).toHaveAttribute("data-highlighted", "true"));
    expect(getTimeline(qc, CH, CH)).toMatchObject({ hasNewer: true, lastSeq: 100 });
    expect(screen.getByRole("button", { name: /최신 메시지로/ })).toBeInTheDocument();
  });

  it("목표를 안고 열린 목록은 끝으로 붙지 않는다 — around 를 받는 동안에도", async () => {
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    requestJump({ conversationId: CH, messageId: msg(10).id, seq: 10 });
    const { container, row } = setup(timelineOf(range(60, 100)));
    const scroller = container.querySelector<HTMLElement>("[data-scroller]")!;
    await new Promise((r) => setTimeout(r, 50));
    expect(scroller.scrollTop).toBe(0);
    answer(json(200, { messages: range(1, 20), hasMore: false, hasMoreAfter: true }));
    await waitFor(() => expect(row("본문 10")).toHaveAttribute("data-highlighted", "true"));
  });

  it("around 를 받는 사이 목록이 바뀌어도(wire 새 메시지) around 는 한 번만 부른다", async () => {
    let answer: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    const { qc, row } = setup(timelineOf(range(60, 100)));
    jumpTo(10);
    await waitFor(() => expect(fetched()).toContain(url("limit=50&around=10")));
    act(() => qc.setQueryData<Timeline>(qk.timeline(CH, CH), (t) => upsert(t!, range(101, 101)[0]!)));
    act(() => qc.setQueryData<Timeline>(qk.timeline(CH, CH), (t) => upsert(t!, range(102, 102)[0]!)));
    await screen.findByText("본문 102");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched().filter((u) => u === url("limit=50&around=10"))).toHaveLength(1);
    answer(json(200, { messages: range(1, 20), hasMore: false, hasMoreAfter: true }));
    await waitFor(() => expect(row("본문 10")).toHaveAttribute("data-highlighted", "true"));
  });

  it("구독 전(채널 커서 없음 — 오프라인 사본에서 복원)이면 기다렸다가 받는다 — 구독 뒤의 다시 받기가 덮지 않게", async () => {
    routes.set(url("limit=50&around=10"), () =>
      json(200, { messages: range(1, 20), hasMore: false, hasMoreAfter: true }),
    );
    const { qc, row } = setup(timelineOf(range(60, 100)), { subscribed: false });
    jumpTo(10);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched()).not.toContain(url("limit=50&around=10"));
    act(() => setChannelSeq(qc, CH, 100));
    await waitFor(() => expect(row("본문 10")).toHaveAttribute("data-highlighted", "true"));
  });

  it("받아도 그 메시지가 없으면(지워졌다) 안내 한 줄 뒤 목표를 버린다", async () => {
    const info = vi.spyOn(toast, "info");
    routes.set(url("limit=50&around=10"), () =>
      json(200, { messages: range(1, 9), hasMore: false, hasMoreAfter: true }),
    );
    setup(timelineOf(range(60, 100)));
    jumpTo(10);
    await waitFor(() => expect(info).toHaveBeenCalledWith("메시지를 찾을 수 없습니다"));
    expect(useJumpStore.getState().targets).toEqual({});
  });

  it("받지 못하면(오류) 토스트 한 줄 뒤 목표를 버린다", async () => {
    const error = vi.spyOn(toast, "error");
    routes.set(url("limit=50&around=10"), () => json(500, { code: "INTERNAL", message: "서버 오류" }));
    setup(timelineOf(range(60, 100)));
    jumpTo(10);
    await waitFor(() => expect(error).toHaveBeenCalledWith("서버 오류"));
    expect(useJumpStore.getState().targets).toEqual({});
  });
});

describe("떨어진 창(hasNewer)", () => {
  const detached = () => timelineOf(range(1, 20), { hasNewer: true, lastSeq: 100 });

  it("「최신 메시지로」 — 최신 페이지로 새로 시작하고 단추가 사라진다", async () => {
    routes.set(url("limit=50"), () => json(200, { messages: range(51, 100), hasMore: true }));
    const { qc } = setup(detached());
    await userEvent.click(screen.getByRole("button", { name: /최신 메시지로/ }));
    await waitFor(() => expect(getTimeline(qc, CH, CH)?.items.at(-1)?.seq).toBe(100));
    expect(getTimeline(qc, CH, CH)?.hasNewer).toBeFalsy();
    expect(screen.queryByRole("button", { name: /최신 메시지로/ })).toBeNull();
    expect(await screen.findByText("본문 100")).toBeInTheDocument();
  });

  it("보내면(보내는 중 항목이 붙으면) 최신으로 — 떨어진 창 뒤에 내 메시지만 붙지 않게", async () => {
    routes.set(url("limit=50"), () => json(200, { messages: range(51, 100), hasMore: true }));
    const { qc } = setup(detached());
    act(() =>
      qc.setQueryData<Timeline>(qk.timeline(CH, CH), (t) =>
        addPending(t!, {
          clientMsgId: "c1",
          channelId: CH,
          bodyMd: "새 말",
          createdAt: new Date().toISOString(),
          state: "sending",
        }),
      ),
    );
    await waitFor(() => expect(fetched()).toContain(url("limit=50")));
    await waitFor(() => expect(getTimeline(qc, CH, CH)?.hasNewer).toBeFalsy());
    expect(getTimeline(qc, CH, CH)?.pending).toHaveLength(1);
  });

  it("아래 끝 근처에 닿으면 가장 새 항목 뒤를 이어 받는다", async () => {
    routes.set(url("limit=50&afterSeq=20"), () => json(200, { messages: range(21, 30), hasMore: true }));
    const { qc, container } = setup(detached());
    const scroller = container.querySelector<HTMLElement>("[data-scroller]")!;
    await act(async () => {
      scroller.dispatchEvent(new Event("wheel"));
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(getTimeline(qc, CH, CH)?.items.at(-1)?.seq).toBe(30));
    expect(getTimeline(qc, CH, CH)?.hasNewer).toBe(true);
    // 붙은 행을 따라 끝으로 가지 않는다 — 따라가면 또 아래 끝이라 다음 쪽이 연달아 불린다
    await new Promise((r) => setTimeout(r, 100));
    expect(fetched()).not.toContain(url("limit=50&afterSeq=30"));
  });
});
