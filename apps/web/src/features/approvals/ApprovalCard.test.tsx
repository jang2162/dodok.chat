import type { Approval, ErrorCode, Result } from "@dodok/shared";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWireStatus, WireAckError } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { APPROVAL, CH, CH2, approval, iso } from "../../../test/fixtures";
import { renderWithClient } from "../../../test/messages";
import { ApprovalCard, resolveErrorMessage } from "./ApprovalCard";
import { useApprovalStore } from "./approvalStore";

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

    // 서버가 「취소됨」으로 닫으면 클라이언트 시계가 그린 「만료됨」을 덮는다
    act(() => useApprovalStore.getState().apply(approval({ status: "cancelled", reason: "run-aborted" })));
    expect(screen.getByText("취소됨 (실행 중지)")).toBeInTheDocument();
    expect(screen.queryByText("만료됨")).not.toBeInTheDocument();
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
