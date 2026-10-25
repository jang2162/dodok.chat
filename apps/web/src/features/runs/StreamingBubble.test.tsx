import type { Result } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { MessageList } from "@/features/messages/MessageList";
import { emptyTimeline, upsert } from "@/features/messages/timeline";
import { updateTimeline } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { agentColorVar } from "@/theme/agentColor";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH, msg, RUN, runState, textDelta } from "../../../test/fixtures";
import { authorsClient, renderWithClient } from "../../../test/messages";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { useRunStore } from "./runStore";
import { StreamingBubble } from "./StreamingBubble";
import { useChannelBubbles } from "./useChannelBubbles";

// 소켓은 테스트가 쥔 가짜 — WireProvider 의 나머지는 원본
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));
// 본문 렌더러는 원본 그대로, 한 텍스트에서만 던진다(스트리밍 중 한 번 깨지는 경우)
const BOOM = "깨지는 중간";
vi.mock("@/features/messages/MessageBody", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/messages/MessageBody")>();
  return {
    MessageBody: (props: { bodyMd: string; streaming?: boolean }) => {
      if (props.bodyMd === BOOM) throw new Error("render boom");
      return <actual.MessageBody {...props} />;
    },
  };
});

let fake: FakeSocket;
beforeEach(() => {
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  useRunStore.getState().reset();
});
afterEach(() => {
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
  useRunStore.getState().reset();
  vi.restoreAllMocks();
});

const run = (over: Parameters<typeof runState>[0] = {}) =>
  act(() => useRunStore.getState().applyState(runState(over)));
const delta = (seq: number, text: string) =>
  act(() => useRunStore.getState().applyEvent(textDelta(seq, text)));
const stopButton = () => screen.queryByRole("button", { name: /실행 중지/ });

describe("StreamingBubble", () => {
  it("streaming: 에이전트 머리(이름·AI·색 막대) · 누적 텍스트 · 커서 · 중지 버튼", () => {
    run({ status: "streaming" });
    delta(1, "안녕");
    delta(2, "하세요");
    const { container } = renderWithClient(<StreamingBubble runId={RUN} />);
    expect(screen.getByText("Dev")).toBeInTheDocument();
    expect(screen.getByText("AI")).toBeInTheDocument();
    expect(screen.getByText("안녕하세요")).toBeInTheDocument();
    expect(container.querySelector("[data-cursor]")).not.toBeNull();
    expect((container.querySelector("[data-agent-bar]") as HTMLElement).style.backgroundColor).toBe(
      agentColorVar("dev"),
    );
    expect(stopButton()).toBeEnabled();

    delta(3, " 반가워요");
    expect(screen.getByText("안녕하세요 반가워요")).toBeInTheDocument();
  });

  it.each([
    ["queued", "대기 중", false, true],
    ["tool", "도구 사용 중", true, true],
    ["awaiting_approval", "승인 대기 중", true, true],
    ["finalizing", null, true, false],
    ["done", null, true, false],
    ["aborted", "중지됨", false, false],
  ] as const)(
    "%s: 상태 문구 · 누적 텍스트 · 중지 버튼이 표대로(스펙 4.6)",
    (status, label, textShown, stoppable) => {
      run({ status });
      delta(1, "쌓인 글");
      const { container } = renderWithClient(<StreamingBubble runId={RUN} />);
      if (label) expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByText("쌓인 글") !== null).toBe(textShown);
      expect(stopButton() !== null).toBe(stoppable);
      // 커서는 streaming 일 때만
      expect(container.querySelector("[data-cursor]")).toBeNull();
    },
  );

  it("error: 「실행 실패: <code>」 한 줄, 텍스트·중지 없음", () => {
    run({ status: "streaming" });
    delta(1, "쓰다 만 글");
    run({ status: "error", error: { code: "TIMEOUT", message: "run timeout" } });
    renderWithClient(<StreamingBubble runId={RUN} />);
    expect(screen.getByText("실행 실패: TIMEOUT")).toBeInTheDocument();
    expect(screen.queryByText("쓰다 만 글")).toBeNull();
    expect(stopButton()).toBeNull();
  });

  it("모르는 런이면 아무것도 그리지 않는다", () => {
    const { container } = renderWithClient(<StreamingBubble runId={RUN} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("상태 문구는 늘 있는 polite 라이브 영역 안에서 바뀐다 — 누적 텍스트(델타)는 그 밖이다", async () => {
    run({ status: "queued" });
    const { container } = renderWithClient(<StreamingBubble runId={RUN} />);
    // role="status" 는 aria-live="polite" 인 영역이다
    const live = within(container).getByRole("status");
    expect(live).toHaveTextContent("대기 중");

    run({ status: "streaming" });
    delta(1, "쌓이는 글");
    expect(within(container).getByRole("status")).toBe(live); // 영역은 그대로, 안만 바뀐다
    expect(live).not.toHaveTextContent("쌓이는 글");

    run({ status: "tool" });
    expect(live).toHaveTextContent("도구 사용 중");
    // 델타가 라이브 영역 안으로 들어오지 않는다(본문은 밖)
    expect(screen.getByText("쌓이는 글")).toBeInTheDocument();
  });

  it("중지를 키보드로 눌러도 초점을 잃지 않고, 버튼이 내려가면 메시지 목록으로 옮긴다", async () => {
    fake.onAck("run.abort", () => ({ ok: true, data: null }));
    run({ status: "streaming" });
    const { container } = renderWithClient(
      <div>
        <div data-scroller role="region" aria-label="메시지" tabIndex={0}>
          <StreamingBubble runId={RUN} />
        </div>
      </div>,
    );
    const stop = stopButton() as HTMLElement;
    stop.focus();
    await userEvent.keyboard("{Enter}");
    expect(fake.sentOf("run.abort")).toEqual([{ runId: RUN }]);
    // 잠긴 동안에도 초점은 그 버튼에 남는다(disabled 면 body 로 떨어진다)
    const locked = screen.getByRole("button", { name: /중지 중/ });
    expect(locked).toHaveFocus();
    expect(locked).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    expect(fake.sentOf("run.abort")).toHaveLength(1);

    run({ status: "aborted" });
    expect(stopButton()).toBeNull();
    expect(container.querySelector("[data-scroller]")).toHaveFocus();
  });

  it("중지 → run.abort { runId } 한 번, 상태가 바뀔 때까지 「중지 중」 잠금", async () => {
    let answer: (r: Result<null>) => void = () => {};
    fake.onAck("run.abort", () => new Promise<Result<null>>((r) => (answer = r)));
    run({ status: "streaming" });
    renderWithClient(<StreamingBubble runId={RUN} />);

    await userEvent.click(stopButton() as HTMLElement);
    expect(fake.sentOf("run.abort")).toEqual([{ runId: RUN }]);
    const locked = screen.getByRole("button", { name: /중지 중/ });
    expect(locked).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(locked);
    expect(fake.sentOf("run.abort")).toHaveLength(1);

    // ack 이 와도 상태가 바뀌기 전에는 잠근 채
    await act(async () => answer({ ok: true, data: null }));
    expect(screen.getByRole("button", { name: /중지 중/ })).toHaveAttribute("aria-disabled", "true");

    run({ status: "aborted" });
    expect(stopButton()).toBeNull();
    expect(screen.getByText("중지됨")).toBeInTheDocument();
  });

  it.each([
    ["NOT_FOUND", "이미 끝났거나 없는 실행입니다"],
    ["TIMEOUT", "서버 응답이 없어 실행을 중지하지 못했습니다"],
  ])("ack 실패(%s)는 작성기 /stop 과 같은 문구로 토스트하고 버튼을 다시 연다", async (code, text) => {
    const error = vi.spyOn(toast, "error");
    // TIMEOUT 은 대본 없는 ack(가짜 소켓이 throw → emitAck 가 TIMEOUT 으로 바꾼다)
    if (code !== "TIMEOUT")
      fake.onAck("run.abort", () => ({ ok: false, error: { code: "NOT_FOUND", message: "run not found" } }));
    run({ status: "streaming" });
    renderWithClient(<StreamingBubble runId={RUN} />);

    await userEvent.click(stopButton() as HTMLElement);
    await waitFor(() => expect(error).toHaveBeenCalledWith(text, expect.anything()));
    expect(error).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(stopButton()).toBeEnabled());
  });

  it("소켓이 없거나 wire 가 connected 가 아니면 중지 버튼 비활성", () => {
    run({ status: "streaming" });
    renderWithClient(<StreamingBubble runId={RUN} />);
    expect(stopButton()).toBeEnabled();
    act(() => useWireStatus.getState().setStatus("reconnecting"));
    expect(stopButton()).toBeDisabled();
    act(() => useWireStatus.getState().setStatus("connected"));
    expect(stopButton()).toBeEnabled();
  });

  it("소켓이 없으면 비활성", () => {
    wire.socket = undefined;
    run({ status: "streaming" });
    renderWithClient(<StreamingBubble runId={RUN} />);
    expect(stopButton()).toBeDisabled();
  });

  it("본문 렌더가 한 번 던지면 그 자리만 대체 문구 — 중지 버튼은 남고, 다음 델타에 다시 그린다", () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // React 가 잡힌 오류도 콘솔에 남긴다
    run({ status: "streaming" });
    delta(1, BOOM);
    const { container } = renderWithClient(<StreamingBubble runId={RUN} />);
    expect(screen.getByText("표시할 수 없는 메시지")).toBeInTheDocument();
    expect(container.querySelector("[data-agent-bar]")).not.toBeNull();
    expect(stopButton()).toBeEnabled();

    delta(2, " 이어서");
    expect(screen.queryByText("표시할 수 없는 메시지")).toBeNull();
    expect(screen.getByText(`${BOOM} 이어서`)).toBeInTheDocument();
    expect(screen.getByText("Dev")).toBeInTheDocument();
  });
});

describe("MessageList 와 함께", () => {
  const RECT = { width: 800, height: 600 };
  let restore: () => void;
  beforeEach(() => {
    restore = stubScrollLayout({ ...RECT, rowHeight: 64 });
  });
  afterEach(() => restore());

  function Channel() {
    const bubbleRunIds = useChannelBubbles(CH, CH);
    return (
      <MessageList
        channelId={CH}
        conversationId={CH}
        bubbleRunIds={bubbleRunIds}
        bubbles={(runId) => <StreamingBubble runId={runId} />}
        initialRect={RECT}
      />
    );
  }

  it("런 streaming → 버블 하나(끝을 따라감), 같은 runId 의 답이 오고 done 이면 버블이 빠지고 메시지 하나만", async () => {
    const qc = authorsClient();
    const items = Array.from({ length: 30 }, (_, i) => msg(i + 1, { bodyMd: `질문 ${i + 1}` }));
    qc.setQueryData(qk.timeline(CH, CH), { ...emptyTimeline(), items, lastSeq: 30 });
    const { container } = renderWithClient(<Channel />, qc);
    const scroller = container.querySelector("[data-scroller]") as HTMLElement;
    const atEnd = () => scroller.scrollTop === scroller.scrollHeight - scroller.clientHeight;
    await waitFor(() => expect(atEnd()).toBe(true));
    const bubbles = () => container.querySelectorAll("[data-run-id]");

    run({ status: "streaming" });
    delta(1, "답을 쓰는 중");
    await waitFor(() => expect(bubbles()).toHaveLength(1));
    expect(screen.getByText("답을 쓰는 중")).toBeInTheDocument();
    await waitFor(() => expect(atEnd()).toBe(true));

    act(() => {
      updateTimeline(qc, CH, CH, (t) =>
        upsert(t, msg(31, { authorType: "agent", authorId: AGENT, runId: RUN, bodyMd: "답을 다 썼다" })),
      );
      useRunStore.getState().applyState(runState({ status: "done" }));
    });
    await waitFor(() => expect(bubbles()).toHaveLength(0));
    expect(screen.getAllByText("답을 다 썼다")).toHaveLength(1);
    expect(screen.queryByText("답을 쓰는 중")).toBeNull();
    expect(useRunStore.getState().runs[RUN]).toBeUndefined();
    await waitFor(() => expect(atEnd()).toBe(true));
  });
});
