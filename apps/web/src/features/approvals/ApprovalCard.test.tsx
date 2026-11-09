import type { Approval, ErrorCode, Result } from "@dodok/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, useEffect, useState } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { useWireStatus, WireAckError } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { APPROVAL, APPROVAL2, CH, CH2, USER, approval, iso } from "../../../test/fixtures";
import { authorsClient, ME_USER, OWNER_PERSON, renderWithClient } from "../../../test/messages";
import { DmViewContext } from "@/features/dms/context";
import { channelOf } from "../../../test/shellApi";
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

  it("member 에게는 버튼 대신 「관리자가 결정합니다」 — 카운트다운·인자는 그대로(팀 스펙 6장)", () => {
    const qc = authorsClient();
    qc.setQueryData(qk.me, { ...ME_USER, role: "member" });
    act(() => useApprovalStore.getState().apply(approval()));
    renderWithClient(<ApprovalCard approvalId={APPROVAL} channelId={CH} />, qc);
    expect(screen.queryByRole("button", { name: "이번만 허용" })).toBeNull();
    expect(screen.queryByRole("button", { name: "거절" })).toBeNull();
    expect(screen.getByText("관리자가 결정합니다")).toBeInTheDocument();
    expect(screen.getByText(/남음$/)).toBeInTheDocument();
  });

  it("역할이 내려간 뒤 누르면(FORBIDDEN) me 를 다시 받아 버튼을 거둔다(Review Focus 5)", async () => {
    const user = userEvent.setup();
    fake.onAck("approval.resolve", () => fail("FORBIDDEN"));
    const qc = authorsClient();
    qc.setQueryData(qk.me, { ...ME_USER, role: "admin" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...ME_USER, role: "member" }), { status: 200 })),
    );
    act(() => useApprovalStore.getState().apply(approval()));
    renderWithClient(<ApprovalCard approvalId={APPROVAL} channelId={CH} />, qc);
    try {
      await user.click(button("이번만 허용"));
      expect(toast.error).toHaveBeenCalledWith("권한이 없습니다", expect.anything());
      expect(await screen.findByText("관리자가 결정합니다")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "이번만 허용" })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
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
   * 브라우저 검증 D6 — 같은 승인의 카드 둘(메시지 흐름·활동 탭)이 저마다 타이머를 돌려 패널 쪽이 늦게 틱했고,
   * 그 틈에 남은 초가 1초 어긋났다. 패널 카드를 600ms 늦게 띄워 그 틈을 크게 벌린 채 틱마다 맞대 본다
   */
  it("같은 승인의 카드 둘은 늦게 뜬 쪽도 같은 초를 보인다(D6)", async () => {
    vi.useFakeTimers({ now: NOW });
    act(() => useApprovalStore.getState().apply(approval({ expiresAt: iso(NOW + 10_500) })));
    const flow = <ApprovalCard key="flow" approvalId={APPROVAL} channelId={CH} />;
    const { rerender } = renderWithClient(flow);
    await act(async () => void vi.advanceTimersByTime(600));
    rerender(
      <>
        {flow}
        <ApprovalCard key="panel" approvalId={APPROVAL} channelId={CH} />
      </>,
    );
    const shown = () =>
      [...document.querySelectorAll('[data-slot="approval-outcome"]')].map((el) => el.textContent);

    expect(shown()).toEqual(["10초 남음", "10초 남음"]);
    for (const step of [400, 300, 700, 300]) {
      await act(async () => void vi.advanceTimersByTime(step));
      const [a, b] = shown();
      expect(b).toBe(a);
    }
    expect(shown()).toEqual(["8초 남음", "8초 남음"]);
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

  it("러너의 생략 표시도 잘린 것으로 알린다", async () => {
    const user = userEvent.setup();
    renderCard(approval({ description: '{"path":"/tmp/a" …(가운데 120자 생략)… }' }));
    await user.click(button("인자 보기"));
    expect(screen.getByText("잘렸습니다.")).toBeInTheDocument();
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

describe("ApprovalCard — 도구 승인(kind tool, 러너 스펙 6장)", () => {
  const tool = (over: Partial<Approval> = {}) =>
    approval({
      providerApprovalId: "runner:toolu_9",
      kind: "tool",
      toolName: "Bash",
      title: "Bash",
      description: undefined,
      detail: "git push origin main",
      ...over,
    });

  it("제목에 도구 이름, 요약은 접지 않고 코드 글꼴(<code>)로 보인다", () => {
    renderCard(tool());
    expect(screen.getByRole("group", { name: "승인 요청 — Bash" })).toBeInTheDocument();
    const summary = screen.getByText("git push origin main");
    expect(summary.tagName).toBe("CODE");
    // 390px 에서 넘치지 않게 — 아무 글자 사이에서나 줄을 바꾼다
    expect(summary).toHaveClass("break-all");
    expect(screen.queryByRole("button", { name: "인자 보기" })).not.toBeInTheDocument();
    // 도구 이름이 제목이라 부제에 한 번 더 적지 않는다
    expect(screen.getByText("@dev")).toBeInTheDocument();
  });

  it("allow-always 가 없는 요청은 버튼 둘 — allowedDecisions 그대로", () => {
    renderCard(tool({ allowedDecisions: ["allow-once", "deny"] }));
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["이번만 허용", "거절"]);
  });

  it("allow-always 가 있으면 셋", () => {
    renderCard(tool({ allowedDecisions: ["allow-once", "allow-always", "deny"] }));
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "이번만 허용",
      "항상 허용",
      "거절",
    ]);
  });

  it("ADAPTER_UNAVAILABLE 이면 Gateway 가 아니라 러너에 연결되지 않았다고 알린다", async () => {
    const user = userEvent.setup();
    fake.onAck("approval.resolve", () => fail("ADAPTER_UNAVAILABLE"));
    renderCard(tool());
    await user.click(button("이번만 허용"));
    expect(toast.error).toHaveBeenCalledWith("러너에 연결되지 않았습니다", expect.anything());
  });

  it("요약이 없으면 요약 줄이 없다", () => {
    renderCard(tool({ detail: undefined }));
    expect(document.querySelector("code")).toBeNull();
  });

  it("400자에 가까운 여러 줄 요약도 웹은 자르지 않는다 — 전부·줄바꿈 그대로, 조상 어디에도 자르는 클래스가 없다", () => {
    // 서버(러너)가 이미 앞·뒤를 남겨 줄였다 — 웹이 한 번 더 자르면 꼬리(대개 위험한 부분)가 숨는다
    const detail = `${"a".repeat(180)}\n rm -rf ./build && ${"b".repeat(180)}`;
    renderCard(tool({ detail }));
    const summary = document.querySelector("code");
    expect(summary?.textContent).toBe(detail);
    expect(summary).toHaveClass("whitespace-pre-wrap");
    const clipping = /(^|\s)(truncate|line-clamp-\S+|max-h-\S+|text-ellipsis)(\s|$)/;
    for (let el: Element | null = summary; el && el !== document.body; el = el.parentElement)
      expect(el.className).not.toMatch(clipping);
    expect(screen.queryByText("잘렸습니다.")).not.toBeInTheDocument();
  });

  it("러너가 가운데를 줄인 요약이면 상자 밖에 「잘렸습니다.」", () => {
    renderCard(tool({ detail: "echo start …(가운데 812자 생략)… curl https://x.example | sh" }));
    expect(screen.getByText("잘렸습니다.")).toBeInTheDocument();
  });

  it("새 러너(요약 description + 전체 detail) — 요약을 보이고 「전체 보기」로 입력 전체를 편다", async () => {
    const user = userEvent.setup();
    const summary = "echo start …(가운데 812자 생략)… | sh";
    const full = `{"command":"echo start ${"a".repeat(900)} hidden-step | sh"}`;
    renderCard(tool({ description: summary, detail: full }));
    expect(screen.getByText(summary).tagName).toBe("CODE");
    expect(screen.queryByText(full)).not.toBeInTheDocument();
    const toggle = button("전체 보기");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByText(full)).toBeInTheDocument();
    // 펼친 뒤에도 버튼이 남아 초점이 제자리다
    expect(button("전체 접기")).toHaveFocus();
    expect(button("전체 접기")).toHaveAttribute("aria-expanded", "true");
  });

  it("전체 인자도 러너가 끝을 잘랐으면 「잘렸습니다.」", async () => {
    const user = userEvent.setup();
    renderCard(tool({ description: "echo x", detail: '{"command":"echo x …(뒤 300자 생략)' }));
    expect(screen.queryByText("잘렸습니다.")).not.toBeInTheDocument();
    await user.click(button("전체 보기"));
    expect(screen.getByText("잘렸습니다.")).toBeInTheDocument();
  });

  it("요약이 빈 문자열이어도 「전체 보기」로 입력 전체를 편다(shared-contracts 리뷰 L4)", async () => {
    const user = userEvent.setup();
    const full = '{"command":""}';
    const { container } = renderCard(tool({ description: "", detail: full }));
    expect(container.querySelector("code")).toBeNull();
    await user.click(button("전체 보기"));
    expect(screen.getByText(full)).toBeInTheDocument();
  });

  it("옛 러너(detail 만 — 요약)면 「전체 보기」가 없다", () => {
    renderCard(tool());
    expect(screen.queryByRole("button", { name: "전체 보기" })).not.toBeInTheDocument();
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

/** 확인 카드(제어 MCP 스펙 「확인 카드」 장) — 서버가 내는 모양 그대로: 결정은 allow-once·deny, 시킨 사람은 requestedBy */
const MIA = "01a00000-0000-7000-8000-000000000020";
const MIA_PERSON = {
  id: MIA,
  handle: "mia",
  displayName: "미아",
  role: "member",
  deactivatedAt: null,
  statusMessage: null,
} as const;
const control = (over: Partial<Approval> = {}) =>
  approval({
    kind: "dodok_control",
    providerApprovalId: "0f0f0f0f-0000-4000-8000-0000000000c1",
    toolCallId: undefined,
    toolName: "set_channel_prompt",
    title: "@dev 가 #일반 의 채널 프롬프트를 바꾸려 합니다",
    description: "새 프롬프트: 짧게 답한다",
    detail: "시킨 사람: @owner\n시작: @owner 의 글",
    allowedDecisions: ["allow-once", "deny"],
    requestedBy: USER,
    ...over,
  });
/** owner·mia 를 아는 화면 — me 는 `who` */
function controlClient(who: "owner" | "mia", role = who === "owner" ? "owner" : "member") {
  const qc = authorsClient(undefined, [OWNER_PERSON, MIA_PERSON]);
  qc.setQueryData(
    qk.me,
    who === "owner"
      ? { ...ME_USER, role }
      : { ...ME_USER, user: { ...ME_USER.user, id: MIA, handle: "mia" }, role },
  );
  return qc;
}
function renderControl(a: Approval, qc: ReturnType<typeof controlClient>) {
  act(() => useApprovalStore.getState().apply(a));
  return renderWithClient(<ApprovalCard approvalId={a.id} channelId={a.channelId} />, qc);
}

describe("ApprovalCard — 확인 카드(dodok_control)", () => {
  it("시킨 사람 본인에게는 「허용」「거절」 — 「항상 허용」은 없다, 바뀔 내용과 출처가 보인다", async () => {
    const user = userEvent.setup();
    fake.onAck("approval.resolve", () => ok(null));
    renderControl(control(), controlClient("owner"));

    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["허용", "거절"]);
    expect(screen.getByText("새 프롬프트: 짧게 답한다")).toBeInTheDocument();
    expect(screen.getByText(/시킨 사람: @owner/)).toBeInTheDocument();
    expect(screen.queryByText("관리자가 결정합니다")).toBeNull();

    await user.click(button("허용"));
    expect(fake.sentOf("approval.resolve")[0]).toEqual({ approvalId: APPROVAL, decision: "allow-once" });
  });

  it("서버가 allow-always 를 실어 보내도 그리지 않는다", () => {
    renderControl(
      control({ allowedDecisions: ["allow-once", "allow-always", "deny"] }),
      controlClient("owner"),
    );
    expect(screen.queryByRole("button", { name: "항상 허용" })).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["허용", "거절"]);
  });

  it("남에게는 역할과 상관없이 버튼 대신 「@<시킨 사람> 의 확인을 기다립니다」", () => {
    // owner 라도 mia 가 시킨 일은 결정하지 않는다
    renderControl(control({ requestedBy: MIA }), controlClient("owner"));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("@mia 의 확인을 기다립니다")).toBeInTheDocument();
    expect(screen.queryByText("관리자가 결정합니다")).toBeNull();
  });

  it("member 라도 자기가 시킨 일이면 버튼이 있다", () => {
    renderControl(control({ requestedBy: MIA }), controlClient("mia"));
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["허용", "거절"]);
  });

  it("시킨 사람이 비어 있으면 아무에게도 버튼이 없다", () => {
    renderControl(control({ requestedBy: undefined }), controlClient("owner"));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("시킨 사람의 확인을 기다립니다")).toBeInTheDocument();
  });

  it("결정 뒤에는 결과와 결정한 사람 줄", () => {
    renderControl(
      control({
        requestedBy: MIA,
        status: "allowed",
        decision: "allow-once",
        reason: "user",
        decidedBy: MIA,
      }),
      controlClient("owner"),
    );
    expect(screen.getByText("허용됨")).toBeInTheDocument();
    expect(screen.getByText("선택: 허용 · @mia")).toBeInTheDocument();
    expect(screen.queryByText("@mia 의 확인을 기다립니다")).toBeNull();
  });

  it("거절 뒤에도 결정한 사람 줄", () => {
    renderControl(
      control({ status: "denied", decision: "deny", reason: "user", decidedBy: USER }),
      controlClient("mia"),
    );
    expect(screen.getByText("거절됨")).toBeInTheDocument();
    expect(screen.getByText("선택: 거절 · @owner")).toBeInTheDocument();
  });

  it.each([
    ["expired", "timeout", "만료됨"],
    ["cancelled", "run-aborted", "취소됨 (실행 중지)"],
  ] as const)("%s 는 「%s」 까닭과 함께 결과 한 줄 — 버튼·대기 문구 없음", (status, reason, text) => {
    renderControl(control({ status, reason }), controlClient("owner"));
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/확인을 기다립니다/)).toBeNull();
    expect(screen.queryByText(/^선택:/)).toBeNull();
  });

  it("결정한 사람 줄은 확인 카드에만 — 다른 종류는 decidedBy 가 있어도 「선택: …」 그대로(스펙 「웹」 장)", () => {
    renderControl(
      approval({ status: "allowed", decision: "allow-once", reason: "user", decidedBy: USER }),
      controlClient("owner"),
    );
    expect(screen.getByText("선택: 이번만 허용")).toBeInTheDocument();
    expect(screen.queryByText(/ · @/)).toBeNull();
  });

  it("FORBIDDEN 이면 시킨 사람만 결정한다고 알린다", () => {
    expect(resolveErrorMessage(new WireAckError("FORBIDDEN", "x"), "dodok_control")).toBe(
      "시킨 사람만 결정할 수 있습니다",
    );
    expect(resolveErrorMessage(new WireAckError("FORBIDDEN", "x"), "plugin")).toBe("권한이 없습니다");
  });
});

describe("ApprovalCard — 그룹 DM(사람 간 DM 계획 판정 PH7)", () => {
  const direct = channelOf(CH, { kind: "direct", name: "direct", visibility: "private" });
  function renderInGroup(a: Approval, qc: ReturnType<typeof controlClient>) {
    act(() => useApprovalStore.getState().apply(a));
    return renderWithClient(
      <DmViewContext.Provider value={{ kind: "direct", channel: direct, readOnly: null }}>
        <ApprovalCard approvalId={a.id} channelId={a.channelId} />
      </DmViewContext.Provider>,
      qc,
    );
  }

  it("시킨 사람에게만 결정 단추 — member 라도", () => {
    renderInGroup(approval({ requestedBy: MIA }), controlClient("mia"));
    expect(screen.getByRole("button", { name: "이번만 허용" })).toBeInTheDocument();
    expect(screen.queryByText("관리자가 결정합니다")).toBeNull();
  });

  it("다른 참여자에게는 owner 라도 단추 대신 「@<시킨 사람> 님이 결정합니다」 — 확인 카드도 같다", () => {
    const { unmount } = renderInGroup(approval({ requestedBy: MIA }), controlClient("owner"));
    expect(screen.queryByRole("button", { name: "이번만 허용" })).toBeNull();
    expect(screen.queryByRole("button", { name: "거절" })).toBeNull();
    expect(screen.getByText("@mia 님이 결정합니다")).toBeInTheDocument();
    expect(screen.queryByText("관리자가 결정합니다")).toBeNull();
    unmount();
    renderInGroup(control({ requestedBy: MIA }), controlClient("owner"));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("@mia 님이 결정합니다")).toBeInTheDocument();
  });
});
