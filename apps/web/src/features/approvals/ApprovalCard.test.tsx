import type { Approval, ErrorCode, Result } from "@dodok/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, useEffect, useState } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWireStatus, WireAckError } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { APPROVAL, APPROVAL2, CH, CH2, approval, iso } from "../../../test/fixtures";
import { renderWithClient } from "../../../test/messages";
import { ApprovalCard, resolveErrorMessage } from "./ApprovalCard";
import { selectPendingApproval, useApprovalStore } from "./approvalStore";

// 소켓은 테스트가 쥔 가짜 — WireProvider 의 나머지는 원본(StreamingBubble 테스트와 같은 방식)
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const NOW = Date.parse("2027-01-15T08:00:00.000Z");
const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
const fail = (code: string, message = "안 됩니다"): Result<never> =>
  ({ ok: false, error: { code, message } }) as unknown as Result<never>;

let fake: FakeSocket;
beforeEach(() => {
  fake = createFakeSocket();
  fake.socket.connected = true;
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  useApprovalStore.getState().reset();
  vi.clearAllMocks();
});
afterEach(() => {
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
  useApprovalStore.getState().reset();
  vi.useRealTimers();
});

/** 스토어에 승인을 넣고 카드를 그린다 */
function renderCard(a: Approval) {
  act(() => useApprovalStore.getState().apply(a));
  return renderWithClient(<ApprovalCard approvalId={a.id} channelId={a.channelId} />);
}
const button = (name: string) => screen.getByRole("button", { name });

/**
 * 활동 탭 맨 위의 카드 자리(`ActivityPanel` 의 `cardId` 그대로). 「가장 이른 미해결」을 따라가므로
 * 승인이 확정되는 **그 렌더에 다음 승인으로 갈아탄다** — `key` 가 없어 같은 인스턴스가 이어진다.
 * 확정된 뒤에도 마지막 카드를 결과 한 줄로 남긴다
 */
function PanelSlot(): ReactElement | null {
  const pending = useApprovalStore(selectPendingApproval(CH));
  const [shown, setShown] = useState<string>();
  const pendingId = pending?.approval.id;
  useEffect(() => {
    if (pendingId) setShown(pendingId);
  }, [pendingId]);
  const cardId = pendingId ?? shown;
  return cardId ? <ApprovalCard approvalId={cardId} channelId={CH} /> : null;
}

describe("ApprovalCard", () => {
  it("모르는 승인이면 아무것도 그리지 않는다", () => {
    const { container } = renderWithClient(<ApprovalCard approvalId={APPROVAL} channelId={CH} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("채널이 다르면 그리지 않는다 — 카드는 그 채널의 승인만 본다", () => {
    act(() => useApprovalStore.getState().apply(approval()));
    const { container } = renderWithClient(<ApprovalCard approvalId={APPROVAL} channelId={CH2} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("allowedDecisions 에 있는 버튼만 그리고 카운트다운을 보인다", () => {
    vi.useFakeTimers({ now: NOW });
    renderCard(approval({ allowedDecisions: ["allow-once", "deny"], expiresAt: iso(NOW + 120_000) }));

    expect(button("이번만 허용")).toBeEnabled();
    expect(button("거절")).toBeEnabled();
    expect(screen.queryByRole("button", { name: "항상 허용" })).not.toBeInTheDocument();
    expect(screen.getByText("2분 0초 남음")).toBeInTheDocument();
    // 에이전트·툴·severity 도 함께
    expect(screen.getByText("@dev · Write")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "주의" })).toBeInTheDocument();
  });

  it("allow-always 가 허용되면 버튼 셋을 차례대로 그린다", () => {
    renderCard(approval({ allowedDecisions: ["deny", "allow-always", "allow-once"] }));
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "인자 보기",
      "이번만 허용",
      "항상 허용",
      "거절",
    ]);
  });

  it("누르면 approval.resolve 를 보내고 잠근다", async () => {
    const user = userEvent.setup();
    let settle: (r: Result<null>) => void = () => {};
    fake.onAck("approval.resolve", () => new Promise<Result<null>>((r) => (settle = r)));
    renderCard(approval());

    await user.click(button("이번만 허용"));

    expect(fake.sentOf("approval.resolve")[0]).toMatchObject({
      approvalId: APPROVAL,
      decision: "allow-once",
    });
    expect(button("이번만 허용")).toBeDisabled();
    expect(button("거절")).toBeDisabled();
    await act(async () => settle(ok(null)));
    // ack 만으로는 풀리지 않는다 — 서버가 보내는 확정 사실이 카드를 결과 한 줄로 바꾼다
    expect(button("이번만 허용")).toBeDisabled();
  });

  it.each([
    ["이번만 허용", "allow-once"],
    ["항상 허용", "allow-always"],
    ["거절", "deny"],
  ])("「%s」 을 누르면 %s 를 보낸다 — 누른 버튼의 결정 그대로", async (label, decision) => {
    const user = userEvent.setup();
    fake.onAck("approval.resolve", () => ok(null));
    renderCard(approval({ allowedDecisions: ["allow-once", "allow-always", "deny"] }));

    await user.click(button(label));

    expect(fake.sentOf("approval.resolve")).toEqual([{ approvalId: APPROVAL, decision }]);
    expect(useApprovalStore.getState().byChannel[CH]?.[APPROVAL]?.sending).toBe(decision);
  });

  it.each([
    ["CONFLICT", "이미 처리되었거나 만료되었습니다"],
    ["VALIDATION", "이 승인이 받지 않는 선택입니다"],
    ["FORBIDDEN", "권한이 없습니다"],
    ["ADAPTER_UNAVAILABLE", "Gateway 에 연결되지 않았습니다"],
  ])("%s 면 문구를 토스트하고 잠금을 푼다", async (code, message) => {
    const user = userEvent.setup();
    fake.onAck("approval.resolve", () => fail(code));
    renderCard(approval());

    await user.click(button("이번만 허용"));

    expect(toast.error).toHaveBeenCalledWith(message, expect.anything());
    expect(button("이번만 허용")).toBeEnabled();
    // 다시 누를 수 있다
    await user.click(button("이번만 허용"));
    expect(fake.sentOf("approval.resolve")).toHaveLength(2);
  });

  it("wire 가 끊겨 있으면 누를 수 없다", () => {
    act(() => useWireStatus.getState().setStatus("reconnecting"));
    renderCard(approval());
    expect(button("이번만 허용")).toBeDisabled();
  });

  it("확정되면 결과 한 줄로 바뀐다 — 사라지지 않는다", () => {
    const { container } = renderCard(approval());
    act(() =>
      useApprovalStore
        .getState()
        .apply(approval({ status: "allowed", decision: "allow-always", reason: "user" })),
    );

    expect(screen.getByText("허용됨")).toBeInTheDocument();
    expect(screen.getByText("선택: 항상 허용")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이번만 허용" })).not.toBeInTheDocument();
    expect(container.querySelector("[data-slot='approval-card']")).toHaveAttribute("data-status", "allowed");
  });

  it.each([
    ["denied", "거절됨"],
    ["expired", "만료됨"],
    ["cancelled", "취소됨"],
  ])("status %s 는 %s — decision 이 아니라 status 로 판정한다", (status, label) => {
    // Gateway 가 준 만료는 decision: deny 를 싣는다(p2-t6 보고서 2) — 「거절됨」으로 보이면 안 된다
    renderCard(approval({ status: status as Approval["status"], decision: "deny", reason: "timeout" }));
    expect(screen.getByText(label)).toBeInTheDocument();
    // 「누가 골랐는가」는 사람이 고른 경로(허용·거절)에서만 — 만료·취소의 decision 은 Gateway 가 채운 것이다
    if (status === "denied") expect(screen.getByText("선택: 거절")).toBeInTheDocument();
    else expect(screen.queryByText(/^선택:/)).not.toBeInTheDocument();
  });

  it("확정·만료 안내 줄만 라이브 영역이다 — 매초 바뀌는 카운트다운은 아니다", () => {
    // 만료 → 확정 순서로 본다(스토어는 확정된 행에 늦게 온 pending 을 덮지 않는다)
    const timedOut = renderCard(approval({ expiresAt: iso(Date.now() - 1_000) }));
    expect(screen.getByText("시간이 지나 답할 수 없습니다.")).toHaveAttribute("aria-live", "polite");
    // 결과·남은 시간 문구는 같은 span 이다 — 거기에 라이브를 걸면 미해결 카드가 1초마다 읽힌다
    expect(screen.getByText("만료됨").closest("[aria-live]")).toBeNull();
    timedOut.unmount();

    renderCard(approval({ status: "allowed", decision: "allow-always", reason: "user" }));
    expect(screen.getByText("선택: 항상 허용")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("허용됨").closest("[aria-live]")).toBeNull();
  });

  it("내 답이 아닌 것으로 닫히면 까닭을 덧붙인다 — 끊긴 동안 만료(no-route)", () => {
    renderCard(approval({ status: "expired", reason: "no-route" }));
    expect(screen.getByText("만료됨 (연결 끊김)")).toBeInTheDocument();
  });

  it("카운트다운이 0 이 되면 만료로 보이고 버튼이 내려간다 — 서버 사실이 오면 그쪽이 이긴다", async () => {
    vi.useFakeTimers({ now: NOW });
    renderCard(approval({ expiresAt: iso(NOW + 3_000) }));
    expect(screen.getByText("3초 남음")).toBeInTheDocument();

    await act(async () => void vi.advanceTimersByTime(2_000));
    expect(screen.getByText("1초 남음")).toBeInTheDocument();

    await act(async () => void vi.advanceTimersByTime(1_500));
    expect(screen.getByText("만료됨")).toBeInTheDocument();
    expect(screen.getByText("시간이 지나 답할 수 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이번만 허용" })).not.toBeInTheDocument();

    // 서버가 「취소됨」으로 닫으면 클라이언트 시계가 그린 「만료됨」을 덮는다.
    // expiresAt 을 같은 값으로 고정해 **클라이언트 시계로는 여전히 만료인 채**로 확정을 넣는다 —
    // 픽스처 기본값(TS+120초)을 그대로 실으면 만료가 아니게 되어 「서버가 이긴다」를 재지 못한다
    act(() =>
      useApprovalStore
        .getState()
        .apply(approval({ status: "cancelled", reason: "run-aborted", expiresAt: iso(NOW + 3_000) })),
    );
    expect(screen.getByText("취소됨 (실행 중지)")).toBeInTheDocument();
    expect(screen.queryByText("만료됨")).not.toBeInTheDocument();
  });

  /**
   * 브라우저 검증 D13 — 결정을 누르면 버튼 줄이 통째로 사라지며 **누른 버튼이 언마운트**돼 초점이 `<body>`
   * (좁은 화면은 시트 루트)로 떨어졌다. D3(탭 전환 초점 유실)와 같은 부류다.
   * jsdom 은 떨어져 나간 노드도 `activeElement` 로 남겨 두므로 **노드가 살아 있는가**도 함께 본다
   */
  it("결정 뒤 초점은 같은 카드의 결과 줄로 간다 — <body> 로 떨어지지 않는다(D13)", async () => {
    const user = userEvent.setup();
    fake.onAck("approval.resolve", () => ok(null));
    renderCard(approval());
    const pressed = button("이번만 허용");
    pressed.focus();

    await user.keyboard("{Enter}");
    // ack 만으로는 안 바뀐다 — 서버 확정이 버튼 줄을 내린다
    act(() =>
      useApprovalStore
        .getState()
        .apply(approval({ status: "allowed", decision: "allow-once", reason: "user" })),
    );

    const outcome = screen.getByText("허용됨");
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(outcome);
    expect(document.body).toContainElement(outcome);
    // 탭 차례에는 들지 않고, 테두리는 키보드에서만 — 마우스로 누른 사람에게 링이 튀지 않는다
    expect(outcome).toHaveAttribute("tabindex", "-1");
    expect(outcome.className).toContain("focus-visible:ring-2");
    expect(outcome.className.split(/\s+/)).not.toContain("focus:ring-2");
  });

  it("누르지 않은 쪽 카드는 초점을 가져가지 않는다 — 카드는 두 자리에 선다(D13)", async () => {
    const user = userEvent.setup();
    fake.onAck("approval.resolve", () => ok(null));
    act(() => useApprovalStore.getState().apply(approval()));
    renderWithClient(
      <>
        <div data-testid="flow">
          <ApprovalCard approvalId={APPROVAL} channelId={CH} />
        </div>
        <div data-testid="panel">
          <ApprovalCard approvalId={APPROVAL} channelId={CH} />
        </div>
      </>,
    );
    const flow = screen.getByTestId("flow");
    const pressed = within(flow).getByRole("button", { name: "이번만 허용" });
    pressed.focus();

    await user.keyboard("{Enter}");
    act(() =>
      useApprovalStore
        .getState()
        .apply(approval({ status: "allowed", decision: "allow-once", reason: "user" })),
    );

    // 누른 카드의 결과 줄이다 — 다른 자리의 카드가 초점을 낚아채지 않는다
    expect(document.activeElement).toBe(within(flow).getByText("허용됨"));
    expect(document.activeElement).not.toBe(within(screen.getByTestId("panel")).getByText("허용됨"));
  });

  it("카운트다운이 다 돼 버튼이 내려갈 때는 초점을 옮기지 않는다 — 사용자가 한 일이 아니다(D13)", async () => {
    vi.useFakeTimers({ now: NOW });
    renderCard(approval({ expiresAt: iso(NOW + 1_000) }));
    const args = button("인자 보기");
    args.focus();

    await act(async () => void vi.advanceTimersByTime(1_500));

    expect(screen.queryByRole("button", { name: "이번만 허용" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(args);
  });

  it("다른 탭이 확정한 승인은 초점을 가져가지 않는다 — 내가 누른 것이 아니다(D13)", () => {
    renderCard(approval());
    const args = button("인자 보기");
    args.focus();

    // 이 탭에서는 아무것도 누르지 않았다 — 확정 사실만 들어온다
    act(() =>
      useApprovalStore.getState().apply(approval({ status: "denied", decision: "deny", reason: "user" })),
    );

    expect(screen.getByText("거절됨")).toBeInTheDocument();
    expect(screen.getByText("거절됨")).not.toHaveFocus();
    expect(document.activeElement).toBe(args);
  });

  /**
   * 리뷰 B.6 — 활동 탭 카드는 「가장 이른 미해결」을 따라가므로 A 가 확정되는 그 렌더에 **B 로 갈아탄다**.
   * 표식(`acted`)이 승인 id 에 안 묶여 있으면 그 표식이 B 에게 따라가, 내가 손대지 않은 B 가 **다른 탭에서**
   * 확정될 때 초점을 뺏는다. 「사용자가 한 일이 아닌데 초점을 뺏지 않는다」의 정면 위반이다
   */
  it("카드가 다음 승인으로 갈아탄 뒤 그 승인이 확정돼도 초점을 안 뺏는다(D13)", async () => {
    const user = userEvent.setup();
    fake.onAck("approval.resolve", () => ok(null));
    const second = (over: Partial<Approval> = {}) =>
      approval({ id: APPROVAL2, toolCallId: "toolu_02", ...over });
    act(() => {
      useApprovalStore.getState().apply(approval());
      useApprovalStore.getState().apply(second());
    });
    const { container } = renderWithClient(<PanelSlot />);
    const cardId = () =>
      container.querySelector("[data-slot='approval-card']")?.getAttribute("data-approval-id");
    expect(cardId()).toBe(APPROVAL);

    // A 를 허용한다
    const pressed = button("이번만 허용");
    pressed.focus();
    await user.keyboard("{Enter}");
    act(() =>
      useApprovalStore
        .getState()
        .apply(approval({ status: "allowed", decision: "allow-once", reason: "user" })),
    );
    // 카드가 B 로 갈아탔다 — 내가 누른 승인이 아니다
    expect(cardId()).toBe(APPROVAL2);

    // 다른 탭이 B 를 거절한다
    act(() =>
      useApprovalStore.getState().apply(second({ status: "denied", decision: "deny", reason: "user" })),
    );

    expect(screen.getByText("거절됨")).toBeInTheDocument();
    expect(screen.getByText("거절됨")).not.toHaveFocus();
  });

  it("인자는 접혀 있고 펼칠 수 있다 — 잘린 표시가 있으면 알린다", async () => {
    const user = userEvent.setup();
    renderCard(approval({ description: '{"path":"/tmp/a"} … …[+120 chars hidden]… …' }));

    expect(screen.queryByText(/"path"/)).not.toBeInTheDocument();
    await user.click(button("인자 보기"));
    expect(screen.getByText(/"path":"\/tmp\/a"/)).toBeInTheDocument();
    expect(screen.getByText("잘렸습니다.")).toBeInTheDocument();

    await user.click(button("인자 접기"));
    expect(screen.queryByText(/"path"/)).not.toBeInTheDocument();
  });

  it("인자는 글자 그대로 — 태그가 들어 있어도 HTML 로 해석하지 않는다", async () => {
    const user = userEvent.setup();
    const injected = '{"path":"<img src=x onerror=1>"}';
    const { container } = renderCard(approval({ description: injected, detail: undefined }));

    await user.click(button("인자 보기"));

    // 태그 그대로 텍스트로 보이고, DOM 에 element 는 생기지 않는다
    expect(screen.getByText(injected)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("긴 판(detail)이 있으면 그것을 펼치고, 인자가 아예 없으면 펼칠 것도 없다", async () => {
    const user = userEvent.setup();
    const { unmount } = renderCard(approval({ description: "짧은 판", detail: "긴 판" }));
    await user.click(button("인자 보기"));
    expect(screen.getByText("긴 판")).toBeInTheDocument();
    expect(screen.queryByText("잘렸습니다.")).not.toBeInTheDocument();
    unmount();

    useApprovalStore.getState().reset();
    renderCard(approval({ description: undefined, detail: undefined }));
    expect(screen.queryByRole("button", { name: "인자 보기" })).not.toBeInTheDocument();
  });
});

describe("resolveErrorMessage", () => {
  it("wire 오류가 아니면 일반 문구", () => {
    expect(resolveErrorMessage(new Error("boom"))).toBe("승인을 처리하지 못했습니다");
    expect(resolveErrorMessage(undefined)).toBe("승인을 처리하지 못했습니다");
  });

  it.each([
    ["NOT_FOUND", "없는 승인입니다"],
    ["TIMEOUT", "서버 응답이 없어 승인을 처리하지 못했습니다"],
    ["INTERNAL", "승인을 처리하지 못했습니다 (INTERNAL)"],
  ])("%s → %s", (code, message) => {
    expect(resolveErrorMessage(new WireAckError(code as ErrorCode, "서버 문구"))).toBe(message);
  });
});
